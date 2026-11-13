package main

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"unicode/utf8"
)

// Strict input (docs/orbit-agent-contract.md §5.3, gap G1).
//
// Every catalogued tool's arguments are judged against the schema its descriptor advertises before
// the handler runs, so before any request is made — no card is filed, no write is sent. Four
// mistakes are refused, each naming the field:
//
//   - an unknown field: an object that declares its properties is closed to every other key, and
//     the catalogue advertises that as `additionalProperties: false`. A typo used to be dropped by
//     the handler's copy of the known keys, which read to the caller as a write that took;
//   - a wrong type: a string where an array is required, a number where a string is, a fraction
//     where an integer is, a null where the field is not nullable;
//   - a missing required field;
//   - two fields of one mutually exclusive group (operationMeta.Exclusive) sent together.
//
// The bounds the schema states (enum, length, item count, range) are held too: they are the caps
// the server would refuse the write against, said before the round trip.
//
// The schema language is the subset the catalogue writes, and nothing else is interpreted: type
// (one name or a list), enum, properties, required, additionalProperties (false or a schema),
// items, minLength/maxLength, minItems/maxItems, minimum/maximum. TestCatalogSchemasUseOnlyTheValidatedSubset
// fails on a keyword outside it, so a schema can never promise a check this file does not make.

// schemaKeywordsValidated is that subset, plus the annotations that check nothing.
var schemaKeywordsValidated = map[string]bool{
	"type": true, "enum": true, "properties": true, "required": true, "additionalProperties": true,
	"items": true, "minLength": true, "maxLength": true, "minItems": true, "maxItems": true,
	"minimum": true, "maximum": true,
	// Annotations.
	"description": true, "default": true, "examples": true, "title": true,
}

// openInputTools take arguments whose shape is somebody else's protocol, so their schema is left
// open: permission_prompt is called by the engine itself with the tool call it is asking about, and a
// newer engine may add a field this runner has never heard of. Refusing that would refuse the
// permission prompt, which the engine reads as a denial.
var openInputTools = map[string]bool{"permission_prompt": true}

// closedObjectSchemas returns a copy of schema in which every object that declares its properties
// and says nothing about the rest is closed to the rest (`additionalProperties: false`). An object
// with no declared properties is a free-form value the server validates (task_evidence_submit's
// evidence, project_update's integration) and stays open, as does one that states its own rule.
func closedObjectSchemas(schema map[string]interface{}) map[string]interface{} {
	if schema == nil {
		return nil
	}
	out := make(map[string]interface{}, len(schema)+1)
	for key, value := range schema {
		out[key] = value
	}
	if props, ok := schema["properties"].(map[string]interface{}); ok {
		closed := make(map[string]interface{}, len(props))
		for name, prop := range props {
			if child, ok := prop.(map[string]interface{}); ok {
				closed[name] = closedObjectSchemas(child)
			} else {
				closed[name] = prop
			}
		}
		out["properties"] = closed
		if _, stated := schema["additionalProperties"]; !stated {
			out["additionalProperties"] = false
		}
	}
	if items, ok := schema["items"].(map[string]interface{}); ok {
		out["items"] = closedObjectSchemas(items)
	}
	if extra, ok := schema["additionalProperties"].(map[string]interface{}); ok {
		out["additionalProperties"] = closedObjectSchemas(extra)
	}
	return out
}

// argumentViolation is one reason a call's arguments are refused. Path names the field as the caller
// wrote it ("title", "tasks[2].runAt"; "" is the arguments object itself), Problem is a stable code
// a caller can branch on, and Message is the sentence a model reads.
type argumentViolation struct {
	Path    string `json:"path"`
	Problem string `json:"problem"`
	Message string `json:"message"`
}

// The Problem codes.
const (
	violationUnknownField      = "unknown_field"
	violationWrongType         = "wrong_type"
	violationMissingRequired   = "missing_required"
	violationNotInEnum         = "not_in_enum"
	violationTooShort          = "too_short"
	violationTooLong           = "too_long"
	violationTooFewItems       = "too_few_items"
	violationTooManyItems      = "too_many_items"
	violationBelowMinimum      = "below_minimum"
	violationAboveMaximum      = "above_maximum"
	violationMutuallyExclusive = "mutually_exclusive"
)

// validateToolArguments judges one call's arguments against op's advertised schema and its exclusive
// groups. Nil means the call may go ahead. An absent arguments object is an empty one.
func validateToolArguments(op *operation, args map[string]interface{}) []argumentViolation {
	if op == nil || op.MCP == nil || op.MCP.InputSchema == nil {
		return nil
	}
	var value interface{} = args
	if args == nil {
		value = map[string]interface{}{}
	}
	var out []argumentViolation
	validateSchemaValue(op.MCP.InputSchema, value, "", &out)
	out = append(out, exclusiveViolations(op.Exclusive, value)...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

func joinPath(parent, field string) string {
	if parent == "" {
		return field
	}
	return parent + "." + field
}

func fieldLabel(path string) string {
	if path == "" {
		return "the arguments"
	}
	return fmt.Sprintf("%q", path)
}

// validateSchemaValue appends every violation of schema by value, at path.
func validateSchemaValue(schema map[string]interface{}, value interface{}, path string, out *[]argumentViolation) {
	if schema == nil {
		return
	}
	if types := schemaTypes(schema["type"]); len(types) > 0 && !valueHasOneOfTypes(value, types) {
		*out = append(*out, argumentViolation{
			Path:    path,
			Problem: violationWrongType,
			Message: fmt.Sprintf("%s must be %s, not %s", fieldLabel(path), describeTypes(types, schema), describeValueType(value)),
		})
		return
	}
	if enum, ok := schema["enum"].([]interface{}); ok && len(enum) > 0 && !inEnum(value, enum) {
		*out = append(*out, argumentViolation{
			Path:    path,
			Problem: violationNotInEnum,
			Message: fmt.Sprintf("%s must be one of %s; got %s", fieldLabel(path), describeEnum(enum), describeValue(value)),
		})
		return
	} else if enum, ok := schema["enum"].([]string); ok && len(enum) > 0 && !inStringEnum(value, enum) {
		values := make([]interface{}, len(enum))
		for i, v := range enum {
			values[i] = v
		}
		*out = append(*out, argumentViolation{
			Path:    path,
			Problem: violationNotInEnum,
			Message: fmt.Sprintf("%s must be one of %s; got %s", fieldLabel(path), describeEnum(values), describeValue(value)),
		})
		return
	}
	switch v := value.(type) {
	case string:
		n := utf8.RuneCountInString(v)
		if min, ok := schemaNumber(schema["minLength"]); ok && float64(n) < min {
			*out = append(*out, argumentViolation{Path: path, Problem: violationTooShort,
				Message: fmt.Sprintf("%s must be at least %s characters; got %d", fieldLabel(path), formatSchemaNumber(min), n)})
		}
		if max, ok := schemaNumber(schema["maxLength"]); ok && float64(n) > max {
			*out = append(*out, argumentViolation{Path: path, Problem: violationTooLong,
				Message: fmt.Sprintf("%s must be at most %s characters; got %d", fieldLabel(path), formatSchemaNumber(max), n)})
		}
	case float64, int, int64:
		n := numericValue(v)
		if min, ok := schemaNumber(schema["minimum"]); ok && n < min {
			*out = append(*out, argumentViolation{Path: path, Problem: violationBelowMinimum,
				Message: fmt.Sprintf("%s must be at least %s; got %s", fieldLabel(path), formatSchemaNumber(min), formatSchemaNumber(n))})
		}
		if max, ok := schemaNumber(schema["maximum"]); ok && n > max {
			*out = append(*out, argumentViolation{Path: path, Problem: violationAboveMaximum,
				Message: fmt.Sprintf("%s must be at most %s; got %s", fieldLabel(path), formatSchemaNumber(max), formatSchemaNumber(n))})
		}
	case []interface{}:
		validateArray(schema, v, path, out)
	case []string:
		items := make([]interface{}, len(v))
		for i, s := range v {
			items[i] = s
		}
		validateArray(schema, items, path, out)
	case map[string]interface{}:
		validateObject(schema, v, path, out)
	}
}

func validateArray(schema map[string]interface{}, items []interface{}, path string, out *[]argumentViolation) {
	if min, ok := schemaNumber(schema["minItems"]); ok && float64(len(items)) < min {
		*out = append(*out, argumentViolation{Path: path, Problem: violationTooFewItems,
			Message: fmt.Sprintf("%s must have at least %s items; got %d", fieldLabel(path), formatSchemaNumber(min), len(items))})
	}
	if max, ok := schemaNumber(schema["maxItems"]); ok && float64(len(items)) > max {
		*out = append(*out, argumentViolation{Path: path, Problem: violationTooManyItems,
			Message: fmt.Sprintf("%s must have at most %s items; got %d", fieldLabel(path), formatSchemaNumber(max), len(items))})
	}
	itemSchema, _ := schema["items"].(map[string]interface{})
	if itemSchema == nil {
		return
	}
	for i, item := range items {
		validateSchemaValue(itemSchema, item, fmt.Sprintf("%s[%d]", path, i), out)
	}
}

func validateObject(schema map[string]interface{}, obj map[string]interface{}, path string, out *[]argumentViolation) {
	props, _ := schema["properties"].(map[string]interface{})
	for _, name := range schemaRequired(schema["required"]) {
		if _, present := obj[name]; !present {
			*out = append(*out, argumentViolation{Path: joinPath(path, name), Problem: violationMissingRequired,
				Message: fmt.Sprintf("%q is required", joinPath(path, name))})
		}
	}
	keys := make([]string, 0, len(obj))
	for key := range obj {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		value := obj[key]
		if prop, declared := props[key].(map[string]interface{}); declared {
			validateSchemaValue(prop, value, joinPath(path, key), out)
			continue
		}
		if _, declared := props[key]; declared {
			continue
		}
		switch extra := schema["additionalProperties"].(type) {
		case bool:
			if !extra {
				*out = append(*out, argumentViolation{Path: joinPath(path, key), Problem: violationUnknownField,
					Message: unknownFieldMessage(joinPath(path, key), key, props)})
			}
		case map[string]interface{}:
			validateSchemaValue(extra, value, joinPath(path, key), out)
		}
	}
}

// unknownFieldMessage names the field, the nearest declared one when the key looks like a misspelling
// of it, and nothing else: the list of what the object takes is said once, beside the violations.
func unknownFieldMessage(path, key string, props map[string]interface{}) string {
	message := fmt.Sprintf("unknown field %q", path)
	if near := nearestField(key, props); near != "" {
		message += fmt.Sprintf(" (did you mean %q?)", near)
	}
	return message
}

// nearestField is the declared property a key most plausibly meant: the same name in another case or
// spelling (task_id, TaskId -> taskId), or one within a small edit distance. "" when none is close.
func nearestField(key string, props map[string]interface{}) string {
	normalize := func(s string) string {
		return strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(s, "_", ""), "-", ""))
	}
	best, bestDistance := "", 0
	names := make([]string, 0, len(props))
	for name := range props {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if normalize(name) == normalize(key) {
			return name
		}
	}
	// A bare word for a qualified name: "id" for entryId, "reason" for skipReason. Only when one
	// declared name ends with it, so "id" beside taskId and projectId suggests neither.
	var suffixed []string
	for _, name := range names {
		if len(key) >= 2 && len(name) > len(key) && strings.HasSuffix(strings.ToLower(name), strings.ToLower(key)) {
			suffixed = append(suffixed, name)
		}
	}
	if len(suffixed) == 1 {
		return suffixed[0]
	}
	for _, name := range names {
		limit := 2
		if len(name) <= 4 {
			limit = 1
		}
		if d := editDistance(strings.ToLower(key), strings.ToLower(name)); d <= limit && (best == "" || d < bestDistance) {
			best, bestDistance = name, d
		}
	}
	return best
}

func editDistance(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	prev := make([]int, len(rb)+1)
	cur := make([]int, len(rb)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ra); i++ {
		cur[0] = i
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			cur[j] = minInt(minInt(cur[j-1]+1, prev[j]+1), prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[len(rb)]
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// exclusiveViolations reports every group with more than one member set. A member is written
// "field" for a top-level argument or "list[].field" for a field of each element of an array argument;
// it is set when it is present and not null, false or blank — the three spellings of "not given" the
// handlers already read as absent (a null runAt beside startNow schedules nothing).
func exclusiveViolations(groups [][]string, args interface{}) []argumentViolation {
	var out []argumentViolation
	for _, group := range groups {
		if len(group) < 2 {
			continue
		}
		container, _ := splitExclusiveMember(group[0])
		fields := make([]string, 0, len(group))
		for _, member := range group {
			_, field := splitExclusiveMember(member)
			fields = append(fields, field)
		}
		for path, obj := range exclusiveContainers(container, args) {
			var set []string
			for _, field := range fields {
				if argumentIsSet(obj[field]) {
					set = append(set, field)
				}
			}
			if len(set) < 2 {
				continue
			}
			quoted := make([]string, len(set))
			for i, field := range set {
				quoted[i] = fmt.Sprintf("%q", joinPath(path, field))
			}
			out = append(out, argumentViolation{
				Path:    joinPath(path, set[0]),
				Problem: violationMutuallyExclusive,
				Message: fmt.Sprintf("%s cannot be sent together: they answer the same question, so pass one of them", strings.Join(quoted, " and ")),
			})
		}
	}
	return out
}

// splitExclusiveMember splits "tasks[].startNow" into ("tasks[]", "startNow"), "runAt" into ("", "runAt").
func splitExclusiveMember(member string) (container, field string) {
	if i := strings.LastIndex(member, "."); i >= 0 {
		return member[:i], member[i+1:]
	}
	return "", member
}

// exclusiveContainers resolves a group's container to the objects it names, keyed by the path a
// violation is reported at: the arguments themselves for "", every object element of the array for
// "list[]".
func exclusiveContainers(container string, args interface{}) map[string]map[string]interface{} {
	root, ok := args.(map[string]interface{})
	if !ok {
		return nil
	}
	if container == "" {
		return map[string]map[string]interface{}{"": root}
	}
	list := strings.TrimSuffix(container, "[]")
	items, _ := root[list].([]interface{})
	out := make(map[string]map[string]interface{}, len(items))
	for i, item := range items {
		if obj, ok := item.(map[string]interface{}); ok {
			out[fmt.Sprintf("%s[%d]", list, i)] = obj
		}
	}
	return out
}

func argumentIsSet(value interface{}) bool {
	switch v := value.(type) {
	case nil:
		return false
	case bool:
		return v
	case string:
		return strings.TrimSpace(v) != ""
	}
	return true
}

func schemaTypes(raw interface{}) []string {
	switch t := raw.(type) {
	case string:
		return []string{t}
	case []string:
		return t
	case []interface{}:
		out := make([]string, 0, len(t))
		for _, item := range t {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

func schemaRequired(raw interface{}) []string {
	return schemaTypes(raw)
}

func schemaNumber(raw interface{}) (float64, bool) {
	switch n := raw.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}

func numericValue(v interface{}) float64 {
	n, _ := schemaNumber(v)
	return n
}

func formatSchemaNumber(n float64) string {
	if n == math.Trunc(n) && math.Abs(n) < 1e15 {
		return fmt.Sprintf("%d", int64(n))
	}
	return fmt.Sprintf("%g", n)
}

func valueHasOneOfTypes(value interface{}, types []string) bool {
	for _, t := range types {
		if valueHasType(value, t) {
			return true
		}
	}
	return false
}

func valueHasType(value interface{}, t string) bool {
	switch t {
	case "null":
		return value == nil
	case "string":
		_, ok := value.(string)
		return ok
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "object":
		_, ok := value.(map[string]interface{})
		return ok
	case "array":
		switch value.(type) {
		case []interface{}, []string:
			return true
		}
		return false
	case "number":
		switch v := value.(type) {
		case float64:
			return !math.IsNaN(v) && !math.IsInf(v, 0)
		case int, int64:
			return true
		}
		return false
	case "integer":
		switch v := value.(type) {
		case float64:
			return v == math.Trunc(v) && !math.IsInf(v, 0)
		case int, int64:
			return true
		}
		return false
	}
	// A type name this validator does not know checks nothing (and the subset test keeps the
	// catalogue from writing one).
	return true
}

func describeTypes(types []string, schema map[string]interface{}) string {
	parts := make([]string, 0, len(types))
	for _, t := range types {
		switch t {
		case "array":
			item := "array"
			if items, ok := schema["items"].(map[string]interface{}); ok {
				if inner := schemaTypes(items["type"]); len(inner) == 1 {
					item = "an array of " + inner[0] + "s"
				}
			}
			if item == "array" {
				item = "an array"
			}
			parts = append(parts, item)
		case "object":
			parts = append(parts, "an object")
		case "integer":
			parts = append(parts, "an integer")
		case "null":
			parts = append(parts, "null")
		default:
			parts = append(parts, "a "+t)
		}
	}
	return strings.Join(parts, " or ")
}

func describeValueType(value interface{}) string {
	switch v := value.(type) {
	case nil:
		return "null"
	case string:
		return "a string"
	case bool:
		return "a boolean"
	case float64:
		if v == math.Trunc(v) {
			return "a number"
		}
		return "a fractional number"
	case int, int64:
		return "a number"
	case []interface{}, []string:
		return "an array"
	case map[string]interface{}:
		return "an object"
	}
	return fmt.Sprintf("%T", value)
}

func describeValue(value interface{}) string {
	switch v := value.(type) {
	case nil:
		return "null"
	case string:
		return fmt.Sprintf("%q", v)
	case float64, int, int64:
		return formatSchemaNumber(numericValue(v))
	case bool:
		return fmt.Sprintf("%v", v)
	}
	return describeValueType(value)
}

func describeEnum(enum []interface{}) string {
	parts := make([]string, 0, len(enum))
	for _, v := range enum {
		if v == nil {
			parts = append(parts, "null")
			continue
		}
		parts = append(parts, fmt.Sprintf("%v", v))
	}
	return strings.Join(parts, ", ")
}

func inEnum(value interface{}, enum []interface{}) bool {
	for _, candidate := range enum {
		if candidate == nil && value == nil {
			return true
		}
		if candidate == nil || value == nil {
			continue
		}
		switch c := candidate.(type) {
		case string:
			if s, ok := value.(string); ok && s == c {
				return true
			}
		case bool:
			if b, ok := value.(bool); ok && b == c {
				return true
			}
		case float64, int, int64:
			if _, ok := value.(string); !ok {
				if _, numeric := schemaNumber(value); numeric && numericValue(value) == numericValue(c) {
					return true
				}
			}
		}
	}
	return false
}

func inStringEnum(value interface{}, enum []string) bool {
	s, ok := value.(string)
	if !ok {
		return false
	}
	for _, candidate := range enum {
		if s == candidate {
			return true
		}
	}
	return false
}

// declaredFieldNames is the sorted list of what an object schema takes, said once beside a refusal so
// the next call can be written without guessing.
func declaredFieldNames(schema map[string]interface{}) []string {
	props, _ := schema["properties"].(map[string]interface{})
	names := make([]string, 0, len(props))
	for name := range props {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
