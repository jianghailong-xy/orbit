package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// The validator on its own, over a schema written the way the catalogue writes them: every keyword
// it checks, and the semantics it gives null, integers, nested paths and exclusive groups.
func TestToolArgumentValidatorJudgesTheCataloguesSubset(t *testing.T) {
	schema := closedObjectSchemas(map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"title":    map[string]interface{}{"type": "string", "minLength": 1, "maxLength": 5},
			"count":    map[string]interface{}{"type": "integer", "minimum": 1, "maximum": 3},
			"kind":     map[string]interface{}{"type": "string", "enum": []string{"A", "B"}},
			"hint":     map[string]interface{}{"type": []string{"string", "null"}, "enum": []interface{}{"S", "M"}},
			"labels":   map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "maxItems": 2},
			"env":      map[string]interface{}{"type": "object", "additionalProperties": map[string]interface{}{"type": "string"}},
			"free":     map[string]interface{}{"type": "object"},
			"startNow": map[string]interface{}{"type": "boolean"},
			"runAt":    map[string]interface{}{"type": []string{"string", "null"}},
			"items": map[string]interface{}{"type": "array", "items": map[string]interface{}{
				"type": "object", "required": []string{"name"},
				"properties": map[string]interface{}{"name": map[string]interface{}{"type": "string"}, "ref": map[string]interface{}{"type": "string"}, "parent": map[string]interface{}{"type": "string"}},
			}},
		},
		"required": []string{"title"},
	})
	op := &operation{Tool: "probe", MCP: &operationMCP{InputSchema: schema},
		Exclusive: [][]string{{"startNow", "runAt"}, {"items[].ref", "items[].parent"}}}
	judge := func(raw string) map[string]string {
		var args map[string]interface{}
		if err := json.Unmarshal([]byte(raw), &args); err != nil {
			t.Fatal(err)
		}
		out := map[string]string{}
		for _, v := range validateToolArguments(op, args) {
			out[v.Path] = v.Problem
		}
		return out
	}
	for _, tc := range []struct {
		args string
		want map[string]string
	}{
		{`{"title":"ok"}`, map[string]string{}},
		{`{}`, map[string]string{"title": violationMissingRequired}},
		{`{"title":"ok","titel":"x"}`, map[string]string{"titel": violationUnknownField}},
		{`{"title":7}`, map[string]string{"title": violationWrongType}},
		{`{"title":""}`, map[string]string{"title": violationTooShort}},
		{`{"title":"toolong"}`, map[string]string{"title": violationTooLong}},
		{`{"title":"ok","count":2.0}`, map[string]string{}},
		{`{"title":"ok","count":1.5}`, map[string]string{"count": violationWrongType}},
		{`{"title":"ok","count":"2"}`, map[string]string{"count": violationWrongType}},
		{`{"title":"ok","count":0}`, map[string]string{"count": violationBelowMinimum}},
		{`{"title":"ok","count":4}`, map[string]string{"count": violationAboveMaximum}},
		{`{"title":"ok","kind":"C"}`, map[string]string{"kind": violationNotInEnum}},
		{`{"title":"ok","kind":null}`, map[string]string{"kind": violationWrongType}},
		{`{"title":"ok","hint":null}`, map[string]string{}},
		{`{"title":"ok","hint":"XL"}`, map[string]string{"hint": violationNotInEnum}},
		{`{"title":"ok","labels":"bug"}`, map[string]string{"labels": violationWrongType}},
		{`{"title":"ok","labels":["a",1]}`, map[string]string{"labels[1]": violationWrongType}},
		{`{"title":"ok","labels":["a","b","c"]}`, map[string]string{"labels": violationTooManyItems}},
		{`{"title":"ok","env":{"A":"1","B":2}}`, map[string]string{"env.B": violationWrongType}},
		{`{"title":"ok","free":{"anything":[1,{"goes":true}]}}`, map[string]string{}},
		{`{"title":"ok","items":[{"name":"a"},{"nam":"b"}]}`, map[string]string{"items[1].nam": violationUnknownField, "items[1].name": violationMissingRequired}},
		{`{"title":"ok","startNow":true,"runAt":"2026-12-01T09:00:00Z"}`, map[string]string{"startNow": violationMutuallyExclusive}},
		{`{"title":"ok","startNow":true,"runAt":null}`, map[string]string{}},
		{`{"title":"ok","startNow":false,"runAt":"2026-12-01T09:00:00Z"}`, map[string]string{}},
		{`{"title":"ok","startNow":true,"runAt":"  "}`, map[string]string{}},
		{`{"title":"ok","items":[{"name":"a","ref":"r","parent":"p"}]}`, map[string]string{"items[0].ref": violationMutuallyExclusive}},
	} {
		got := judge(tc.args)
		if len(got) != len(tc.want) {
			t.Errorf("%s: violations %v, want %v", tc.args, got, tc.want)
			continue
		}
		for path, problem := range tc.want {
			if got[path] != problem {
				t.Errorf("%s: violations %v, want %v", tc.args, got, tc.want)
			}
		}
	}
}

// A misspelling is answered with the declared name it most plausibly meant, and only then.
func TestNearestFieldSuggestsOnlyAPlausibleName(t *testing.T) {
	props := map[string]interface{}{"status": nil, "labels": nil, "entryId": nil, "taskId": nil, "projectId": nil, "note": nil}
	for key, want := range map[string]string{
		"statuss": "status", "Status": "status", "lables": "labels", "task_id": "taskId",
		"entry": "entryId", "reason": "", "id": "", "timeout": "", "notes": "note",
	} {
		if got := nearestField(key, props); got != want {
			t.Errorf("nearestField(%q) = %q, want %q", key, got, want)
		}
	}
	if got := nearestField("id", map[string]interface{}{"entryId": nil, "include": nil}); got != "entryId" {
		t.Errorf(`"id" beside one *Id field = %q, want entryId`, got)
	}
	if !strings.Contains(unknownFieldMessage("statuss", "statuss", props), `did you mean "status"`) {
		t.Error("the unknown-field message does not carry the suggestion")
	}
}
