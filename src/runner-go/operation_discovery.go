package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
)

// Graded discovery (docs/orbit-agent-contract.md §2.5): the operation catalogue answered one piece at a
// time, so an agent that wants to call one operation never has to read the whole document.
//
// `orbit capabilities --json` is every command this process is offered, each with its full input schema:
// about 300 KB in the fullest context, which no engine shows a model whole — Claude Code cuts a shell's
// output at 30,000 characters and Codex at 10,000 bytes on its byte policy. The three views here are
// projections of the same catalogue and the same offer, sized to fit under those cuts:
//
//   - `--summary`: one row per command — its id, intent, whether it writes, who must approve, whether it
//     runs here — and the commands this process is not offered, grouped under why.
//   - `--family NAME`: the commands of one family with how to call each: the absolute argv, its usage, the
//     approval, what proves a success and a minimal example.
//   - `--id ID`: one operation in full — its description, every leaf parameter, the retry rule, and the
//     example for both surfaces — apart from the JSON schema, which the MCP tool carries and the full
//     document keeps.
//
// The examples and the leaf parameters are generated from the catalogue (catalogMCPExample,
// catalogCLIExample, cliParameters): an MCP example is the tool's required fields, a CLI example the
// command's required arguments, each filled from the row's declared Example and otherwise with a
// placeholder of the right type. Tests hold every MCP example to its tool's schema and run every CLI example
// through the command's own flag parser, so neither can drift from what the surface accepts.

// discoveryViewVersion is the version of the graded documents' shape. A field may be added under it; a
// field is never removed or changed in meaning without a new version.
const discoveryViewVersion = 1

// discoveryHeader opens every graded document: which view it is, which catalogue answered, and who is
// asking.
type discoveryHeader struct {
	View           string               `json:"view"`
	ViewVersion    int                  `json:"viewVersion"`
	CatalogVersion string               `json:"catalogVersion"`
	CatalogHash    string               `json:"catalogHash"`
	CLIVersion     string               `json:"cliVersion"`
	Context        cliCapabilityContext `json:"context"`
	ReceiptFlag    string               `json:"receiptFlag"`
}

// discoveryNext is where each view leads: the argv of the next, more detailed answer. A <placeholder>
// is the one word to replace.
type discoveryNext struct {
	Guide  []string `json:"guide"`
	Family []string `json:"family"`
	ID     []string `json:"id"`
	Full   []string `json:"full"`
}

// operationExample is a minimal call of one operation on each surface it has: the MCP tool's arguments
// and the CLI command line, generated from the catalogue. A value in angle brackets is a placeholder.
type operationExample struct {
	MCP  map[string]interface{} `json:"mcp,omitempty"`
	Argv []string               `json:"argv,omitempty"`
}

// cliParameter is one leaf argument of a command, as the catalogue declares it: its spelling and whether
// a call must carry it. What each one means is the command's --help (helpArgv) and the MCP tool's schema.
type cliParameter struct {
	Flag     string `json:"flag"`
	Required bool   `json:"required,omitempty"`
}

// capabilitySummaryRow is one command in the summary. It is kept to what tells commands apart, so the
// whole summary stays readable in one tool result: mutates is left out when the command only reads, and
// approval when nobody is asked (none). Every row is a command this process is offered; one it cannot run
// as its credential is also named under unavailable, with why.
type capabilitySummaryRow struct {
	ID       string            `json:"id"`
	Intent   string            `json:"intent"`
	Mutates  bool              `json:"mutates,omitempty"`
	Approval operationApproval `json:"approval,omitempty"`
}

type capabilitySummaryFamily struct {
	Family       string                 `json:"family"`
	Capabilities []capabilitySummaryRow `json:"capabilities"`
}

// capabilityWithheld is the commands this process is not offered for one reason: the reason once, then
// every id it covers.
type capabilityWithheld struct {
	Reason string   `json:"reason"`
	IDs    []string `json:"ids"`
}

type capabilitySummaryDocument struct {
	discoveryHeader
	// How many commands are offered here: the rows under families, the same count the full document's
	// capabilityCount carries.
	Count    int                       `json:"count"`
	Families []capabilitySummaryFamily `json:"families"`
	// Offered commands this process cannot run as the credential it acts as (the full document's
	// available: false), grouped under why.
	Unavailable []capabilityWithheld `json:"unavailable,omitempty"`
	// Catalogued commands this process is not offered at all, grouped under why.
	Withheld []capabilityWithheld `json:"withheld,omitempty"`
	Next     discoveryNext        `json:"next"`
}

// capabilityView is one operation as the family and id views answer it. The family view fills the part
// up to Example; the id view fills the rest as well. destructive is left out when false.
type capabilityView struct {
	ID                string            `json:"id"`
	Intent            string            `json:"intent"`
	Argv              []string          `json:"argv,omitempty"`
	Usage             string            `json:"usage,omitempty"`
	Available         bool              `json:"available"`
	UnavailableReason string            `json:"unavailableReason,omitempty"`
	Mutates           bool              `json:"mutates"`
	Risk              operationRisk     `json:"risk"`
	Approval          operationApproval `json:"approval"`
	ApprovalKey       string            `json:"approvalKey,omitempty"`
	ApprovalDetail    string            `json:"approvalDetail,omitempty"`
	Destructive       bool              `json:"destructive,omitempty"`
	SuccessEvidence   string            `json:"successEvidence"`
	NextStep          string            `json:"nextStep,omitempty"`
	Example           operationExample  `json:"example"`

	Family            string                     `json:"family,omitempty"`
	Object            operationObject            `json:"object,omitempty"`
	MCPTool           string                     `json:"mcpTool,omitempty"`
	HelpArgv          []string                   `json:"helpArgv,omitempty"`
	Description       string                     `json:"description,omitempty"`
	Parameters        []cliParameter             `json:"parameters,omitempty"`
	MutuallyExclusive [][]string                 `json:"mutuallyExclusive,omitempty"`
	Idempotency       operationIdempotency       `json:"idempotency,omitempty"`
	Retry             string                     `json:"retry,omitempty"`
	Returns           string                     `json:"returns,omitempty"`
	Availability      *cliCapabilityAvailability `json:"availability,omitempty"`
}

// capabilityFamilyDocument is one family. A command that cannot run here says available: false, and its
// reason is given once under unavailable with every id it covers: the reason is usually this process's
// (a credential it lacks, a switch that is off), the same for every command it stops.
type capabilityFamilyDocument struct {
	discoveryHeader
	Family       string               `json:"family"`
	Capabilities []capabilityView     `json:"capabilities"`
	Unavailable  []capabilityWithheld `json:"unavailable,omitempty"`
	Next         discoveryNext        `json:"next"`
}

type capabilityIDDocument struct {
	discoveryHeader
	Capability capabilityView `json:"capability"`
}

// cliOfferFacts are the switches buildCLICapabilities decides an offer by, read the same way, so a
// command it leaves out can be explained rather than just missing.
type cliOfferFacts struct {
	inSession     bool
	orchestration bool
	watches       bool
	wiki          bool
}

func currentCLIOfferFacts(identity cliIdentity) cliOfferFacts {
	inSession := strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID")) != ""
	service := identity.Kind == identityService && decodeServiceTokenClaims(identity.token) != nil
	return cliOfferFacts{
		inSession:     inSession,
		orchestration: !service && mcpOrchestrationEnabled() && inSession,
		watches:       watchesEnabledFromEnv(),
		wiki:          wikiEnabledFromEnv(),
	}
}

// cliDiscovery is what this process is offered — the capabilities document it would print — joined to
// the catalogue, so every catalogued operation can be answered for, offered or not.
type cliDiscovery struct {
	exe     string
	built   *builtOperationCatalog
	doc     cliCapabilitiesDocument
	offered map[string]cliCapability
	facts   cliOfferFacts
}

func newCLIDiscovery(executable string) *cliDiscovery {
	doc := buildCLICapabilities(executable)
	offered := make(map[string]cliCapability, len(doc.Capabilities))
	for _, capability := range doc.Capabilities {
		offered[capability.ID] = capability
	}
	return &cliDiscovery{
		exe:     executable,
		built:   operationCatalog(),
		doc:     doc,
		offered: offered,
		facts:   currentCLIOfferFacts(doc.Identity),
	}
}

func (d *cliDiscovery) header(view string) discoveryHeader {
	return discoveryHeader{
		View:           view,
		ViewVersion:    discoveryViewVersion,
		CatalogVersion: d.doc.CatalogVersion,
		CatalogHash:    d.doc.CatalogHash,
		CLIVersion:     d.doc.CLIVersion,
		Context:        d.doc.Context,
		ReceiptFlag:    d.doc.ReceiptFlag,
	}
}

func (d *cliDiscovery) next() discoveryNext {
	return discoveryNext{
		Guide:  []string{d.exe, "guide", "<topic>", "--json"},
		Family: []string{d.exe, "capabilities", "--family", "<family>", "--json"},
		ID:     []string{d.exe, "capabilities", "--id", "<id>", "--json"},
		Full:   []string{d.exe, "capabilities", "--json"},
	}
}

// cliAvailability is whether op's command runs as this process, and why not: the offer's own answer for a
// command the document lists, and the withheld reason for one it does not.
func (d *cliDiscovery) cliAvailability(op *operation) (bool, string) {
	if capability, ok := d.offered[op.Tool]; ok {
		return capability.Available, capability.UnavailableReason
	}
	return false, cliWithheldReason(op, d.facts)
}

// cliWithheldReason says why the capabilities document leaves op's command out for this process, checked
// in the order buildCLICapabilities applies its gates. It only explains: buildCLICapabilities decides.
func cliWithheldReason(op *operation, facts cliOfferFacts) string {
	if op.CLI == nil {
		return "no CLI command (" + op.CLIExempt + "); call the MCP tool " + op.Tool
	}
	command := "orbit " + strings.Join(op.CLI.Argv[1:], " ")
	switch {
	case op.CLI.HeadlessOnly && facts.inSession:
		return "a person's own terminal command: inside an Orbit session the CLI acts as the session, never as the person"
	case op.CLI.SessionOnly && !facts.inSession:
		return "acts for the Orbit session it runs in, and this process runs in none (ORBIT_SESSION_ID is unset)"
	case (op.CLIFamily == "watch" || op.Tool == "session_await") && !facts.watches:
		return watchesOffMessage(command)
	case op.CLIFamily == "wiki" && !facts.wiki:
		return wikiOffMessage(command)
	case cliOrchestrationGated(op) && facts.inSession && !facts.orchestration:
		return orchestrationOffMsg
	case cliOrchestrationGated(op):
		return "needs an Orbit session whose account has Session orchestration on; the credential this process acts as does not grant it"
	}
	return "not offered to the credential this process acts as"
}

// cliOrchestrationGated reports a command buildCLICapabilities offers only where the orchestration grant
// exists (or, for the session family, a headless credential's narrower scope).
func cliOrchestrationGated(op *operation) bool {
	if op.CLI == nil {
		return false
	}
	if op.CLI.RequiresOrchestration {
		return true
	}
	switch op.CLIFamily {
	case "session", "agent", "runner":
		return true
	}
	return false
}

// family is the CLI family an operation's command belongs to: its command group (`orbit task-list …` is
// task-list), and account for the person's own commands. An operation with no command has none.
func (op *operation) family() string {
	if op.CLI == nil || len(op.CLI.Argv) < 2 {
		return ""
	}
	if op.CLIFamily == "account" {
		return "account"
	}
	return op.CLI.Argv[1]
}

// families is every family the catalogue declares, in its own order: the order the summary lists them in.
func (d *cliDiscovery) families() []string {
	var names []string
	seen := map[string]bool{}
	for _, op := range d.cliOperations() {
		family := op.family()
		if !seen[family] {
			seen[family] = true
			names = append(names, family)
		}
	}
	return names
}

// cliOperations is every catalogued operation with a CLI command, in the order the full document lists
// what it offers, and the rest after it in catalogue order.
func (d *cliDiscovery) cliOperations() []*operation {
	var ops []*operation
	listed := map[string]bool{}
	for _, capability := range d.doc.Capabilities {
		if op := d.built.ByTool[capability.ID]; op != nil && op.CLI != nil {
			ops = append(ops, op)
			listed[op.Tool] = true
		}
	}
	for _, op := range d.built.Ops {
		if op.CLI != nil && !listed[op.Tool] {
			ops = append(ops, op)
		}
	}
	return ops
}

// summary is the `--summary` view.
func (d *cliDiscovery) summary() capabilitySummaryDocument {
	doc := capabilitySummaryDocument{discoveryHeader: d.header("summary"), Next: d.next()}
	rows := map[string][]capabilitySummaryRow{}
	var unavailable, withheld reasonGroups
	for _, op := range d.cliOperations() {
		capability, offered := d.offered[op.Tool]
		if !offered {
			withheld.add(cliWithheldReason(op, d.facts), op.Tool)
			continue
		}
		if !capability.Available {
			unavailable.add(capability.UnavailableReason, op.Tool)
		}
		row := capabilitySummaryRow{ID: op.Tool, Intent: op.Intent, Mutates: op.Mutates}
		if op.Approval != approvalKindNone {
			row.Approval = op.Approval
		}
		rows[op.family()] = append(rows[op.family()], row)
		doc.Count++
	}
	for _, family := range d.families() {
		if len(rows[family]) > 0 {
			doc.Families = append(doc.Families, capabilitySummaryFamily{Family: family, Capabilities: rows[family]})
		}
	}
	doc.Unavailable = unavailable.groups()
	doc.Withheld = withheld.groups()
	return doc
}

// reasonGroups gathers ids under the reason each is given, in the order the reasons first appear.
type reasonGroups struct {
	order []string
	ids   map[string][]string
}

func (g *reasonGroups) add(reason, id string) {
	if g.ids == nil {
		g.ids = map[string][]string{}
	}
	if _, seen := g.ids[reason]; !seen {
		g.order = append(g.order, reason)
	}
	g.ids[reason] = append(g.ids[reason], id)
}

func (g *reasonGroups) groups() []capabilityWithheld {
	var out []capabilityWithheld
	for _, reason := range g.order {
		out = append(out, capabilityWithheld{Reason: reason, IDs: g.ids[reason]})
	}
	return out
}

// family is the `--family NAME` view, or an error naming the families there are.
func (d *cliDiscovery) family(name string) (capabilityFamilyDocument, error) {
	doc := capabilityFamilyDocument{discoveryHeader: d.header("family"), Family: name, Next: d.next()}
	var unavailable reasonGroups
	for _, op := range d.cliOperations() {
		if op.family() != name {
			continue
		}
		view := d.view(op, false)
		if !view.Available {
			unavailable.add(view.UnavailableReason, view.ID)
			view.UnavailableReason = ""
		}
		doc.Capabilities = append(doc.Capabilities, view)
	}
	if len(doc.Capabilities) == 0 {
		return doc, fmt.Errorf("no family %q; the families are %s", name, strings.Join(d.families(), ", "))
	}
	doc.Unavailable = unavailable.groups()
	return doc, nil
}

// id is the `--id ID` view of any catalogued operation, an MCP-only one included (answered as a command it
// does not have), or an error pointing at the summary.
func (d *cliDiscovery) id(tool string) (capabilityIDDocument, error) {
	op := d.built.ByTool[tool]
	if op == nil {
		return capabilityIDDocument{}, fmt.Errorf("no operation %q in the catalogue; `%s capabilities --summary --json` lists them", tool, d.exe)
	}
	return capabilityIDDocument{discoveryHeader: d.header("capability"), Capability: d.view(op, true)}, nil
}

// view is one operation as the family view (full=false) or the id view (full=true) answers it.
func (d *cliDiscovery) view(op *operation, full bool) capabilityView {
	v := capabilityView{
		ID:              op.Tool,
		Intent:          op.Intent,
		Mutates:         op.Mutates,
		Risk:            op.Risk,
		Approval:        op.Approval,
		ApprovalKey:     op.ApprovalKey,
		ApprovalDetail:  op.ApprovalDetail,
		Destructive:     op.Destructive,
		SuccessEvidence: op.SuccessEvidence,
		NextStep:        op.NextStep,
		// The family view is a CLI answer, so its example is the command line; the id view adds the MCP
		// tool's arguments.
		Example: operationExample{Argv: catalogCLIExample(op, d.exe)},
	}
	v.Available, v.UnavailableReason = d.cliAvailability(op)
	capability, offered := d.offered[op.Tool]
	if op.CLI != nil {
		v.Argv = append([]string{d.exe}, op.CLI.Argv[1:]...)
		v.Usage = op.CLI.Usage
	}
	if !full {
		return v
	}
	// What the family view leaves to its document (the family) or to the id view.
	v.Example.MCP = catalogMCPExample(op)
	v.Family = op.family()
	v.Object = op.Object
	if op.MCP != nil {
		v.MCPTool = op.Tool
	}
	if op.CLI != nil {
		v.HelpArgv = append(append([]string{}, v.Argv...), "--help")
		v.Parameters = cliParameters(op)
		// The description the full document gives this command (a headless credential's narrower one
		// included), or the catalogue's when the command is not offered here.
		v.Description = op.CLI.Description
		if offered {
			v.Description = capability.Description
		} else if v.Description == "" && op.MCP != nil {
			v.Description = op.MCP.Description
		}
	} else if op.MCP != nil {
		v.Description = op.MCP.Description
	}
	v.MutuallyExclusive = op.Exclusive
	v.Idempotency = op.Idempotency
	v.Retry = op.Retry
	v.Returns = op.Returns
	availability := op.availability()
	v.Availability = &availability
	return v
}

// ── leaf parameters ─────────────────────────────────────────────────────────────────────────────

// cliArgument is one entry of a command's Arguments, parsed: "--title <text> (required)" is the flag
// --title, taking a value, required. Only the first spelling of an "A | B" choice is the one an example
// uses.
type cliArgument struct {
	spec        string // what precedes the note: "--description <text> | --description-file -"
	required    bool   // the note says so: "(required)", "(taskIds; repeatable, required)"
	field       string // the MCP field the note names first: "(taskIds; ...)", "(startNow: ...)"
	flag        string // "--title"; "" for a positional
	positional  string // "task-id" for "[task-id]"
	placeholder string // "<text>"; "" for a flag that takes no value
	boolean     bool   // the flag is a switch: "--json", "--start-now", "--codeless[=true|false]"
	list        bool   // the value is a comma list: "<id[,id...]>"
}

func parseCLIArgument(argument string) cliArgument {
	spec, note := argument, ""
	if i := strings.Index(argument, " ("); i >= 0 {
		spec, note = argument[:i], strings.TrimSuffix(argument[i+2:], ")")
	}
	a := cliArgument{spec: spec, required: noteSaysRequired(note), field: noteField(note)}
	first := strings.TrimSpace(strings.Split(spec, " | ")[0])
	switch {
	case strings.HasPrefix(first, "["):
		a.positional = strings.TrimSuffix(strings.TrimPrefix(first, "["), "]")
	case strings.HasPrefix(first, "--"):
		name := first
		if i := strings.IndexAny(first, " [="); i >= 0 {
			name = first[:i]
		}
		a.flag = name
		rest := strings.TrimSpace(strings.TrimPrefix(first, name))
		switch {
		case rest == "" || strings.HasPrefix(rest, "[="):
			a.boolean = true
		default:
			a.placeholder = rest
			a.list = strings.Contains(rest, "[,")
		}
	}
	return a
}

// noteSaysRequired reads whether a note makes its argument required: when the note opens with it —
// "(required)", "(required for every runner task creation; ...)" — or one of its clauses is the bare word,
// as in "(taskIds; repeatable, required)". A requirement stated later in a note is conditional ("required
// of a session declaring it outside an Automatic project") and a minimal call does not carry it.
func noteSaysRequired(note string) bool {
	if strings.HasPrefix(note, "required") {
		return true
	}
	for _, clause := range strings.FieldsFunc(note, func(r rune) bool { return r == ';' || r == ',' }) {
		if strings.TrimSpace(clause) == "required" {
			return true
		}
	}
	return false
}

// noteField is the identifier a note opens with, when it opens with one: "taskIds; repeatable" names the
// MCP field taskIds. Whether it is a field is the schema's to say (cliArgumentField).
func noteField(note string) string {
	end := strings.IndexAny(note, ";: ,")
	if end < 0 {
		end = len(note)
	}
	word := note[:end]
	if word == "" || word[0] < 'a' || word[0] > 'z' {
		return ""
	}
	for _, r := range word {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			return ""
		}
	}
	return word
}

// name is the word the argument is known by: the flag without its dashes, or the positional's name.
func (a cliArgument) name() string {
	if a.positional != "" {
		return a.positional
	}
	return strings.TrimPrefix(a.flag, "--")
}

// cliParameters is a command's leaf arguments as the catalogue declares them, for this machine.
func cliParameters(op *operation) []cliParameter {
	arguments := runtimeCLIArguments(op)
	params := make([]cliParameter, 0, len(arguments))
	for _, argument := range arguments {
		a := parseCLIArgument(argument)
		params = append(params, cliParameter{Flag: a.spec, Required: a.required})
	}
	return params
}

// ── examples ────────────────────────────────────────────────────────────────────────────────────

// catalogMCPExample is a minimal call of op's MCP tool: every required field, filled from the row's
// declared Example or with a placeholder of the field's type, plus whatever else the row declares.
func catalogMCPExample(op *operation) map[string]interface{} {
	if op == nil || op.MCP == nil {
		return nil
	}
	return exampleObject(op.MCP.InputSchema, op.Example)
}

func exampleObject(schema map[string]interface{}, declared map[string]interface{}) map[string]interface{} {
	props, _ := schema["properties"].(map[string]interface{})
	out := map[string]interface{}{}
	for _, name := range schemaRequired(schema["required"]) {
		if value, ok := declared[name]; ok {
			out[name] = value
			continue
		}
		prop, _ := props[name].(map[string]interface{})
		out[name] = examplePlaceholder(name, prop)
	}
	for name, value := range declared {
		out[name] = value
	}
	return out
}

// examplePlaceholder is a value of the schema's type: its first enum member, its minimum, true, one
// placeholder item, the object's own required fields, or "<name>".
func examplePlaceholder(name string, schema map[string]interface{}) interface{} {
	if first, ok := firstEnumValue(schema["enum"]); ok {
		return first
	}
	types := schemaTypes(schema["type"])
	kind := "string"
	for _, t := range types {
		if t != "null" {
			kind = t
			break
		}
	}
	switch kind {
	case "integer", "number":
		if min, ok := schemaNumber(schema["minimum"]); ok {
			return min
		}
		return 1
	case "boolean":
		return true
	case "array":
		items, _ := schema["items"].(map[string]interface{})
		return []interface{}{examplePlaceholder(strings.TrimSuffix(name, "s"), items)}
	case "object":
		if _, has := schema["properties"]; has {
			return exampleObject(schema, nil)
		}
		return map[string]interface{}{}
	}
	return "<" + name + ">"
}

func firstEnumValue(raw interface{}) (interface{}, bool) {
	switch enum := raw.(type) {
	case []interface{}:
		if len(enum) > 0 {
			return enum[0], true
		}
	case []string:
		if len(enum) > 0 {
			return enum[0], true
		}
	}
	return nil, false
}

// catalogCLIExample is a minimal command line for op: the absolute argv, then every argument the command
// requires and every one that carries a field of the MCP example (so the two examples say the same
// thing), then --receipt for a write (the receipt is the proof) or --json for a read. An argument's
// value is its field's in the MCP example — the field its note names, or the one its name spells
// (--completion-criterion is completionCriterion, --task-id carries taskIds) — and --input carries the
// whole MCP example, since it takes the tool's arguments as one document. Otherwise it is the argument's
// own placeholder. A row whose command line is not its tool's arguments spelled as flags declares it
// (CLIExample).
func catalogCLIExample(op *operation, exe string) []string {
	if op == nil || op.CLI == nil || len(op.CLI.Argv) < 2 {
		return nil
	}
	argv := append([]string{exe}, op.CLI.Argv[1:]...)
	if op.CLIExample != nil {
		argv = append(argv, op.CLIExample...)
		return append(argv, cliOutputFlag(op)...)
	}
	values := catalogMCPExample(op)
	if values == nil {
		// A command no tool stands beside: its row's own example, keyed by the fields its schema names.
		values = op.Example
	}
	var positionals, flags []string
	for _, argument := range runtimeCLIArguments(op) {
		a := parseCLIArgument(argument)
		if a.flag == "" && a.positional == "" {
			continue
		}
		field := cliArgumentField(op, a)
		value, known := values[field]
		if field == "" {
			known = false
		}
		if a.flag == "--input" && op.MCP != nil && len(values) > 0 {
			value, known = values, true
		}
		if !a.required && !known {
			continue
		}
		if a.positional != "" {
			positionals = append(positionals, exampleArgValue(value, known, a.list, "<"+a.positional+">"))
			continue
		}
		if a.boolean {
			if on, isBool := value.(bool); isBool && !on {
				flags = append(flags, a.flag+"=false")
			} else {
				flags = append(flags, a.flag)
			}
			continue
		}
		flags = append(flags, a.flag, exampleArgValue(value, known, a.list, examplePlaceholderFor(a)))
	}
	argv = append(argv, positionals...)
	argv = append(argv, flags...)
	return append(argv, cliOutputFlag(op)...)
}

// cliOutputFlag is how an example asks for its answer: the receipt for a write, the document for a read.
func cliOutputFlag(op *operation) []string {
	switch {
	case op.Mutates:
		return []string{"--receipt"}
	case cliTakesJSONFlag(op):
		return []string{"--json"}
	}
	return nil
}

// cliArgumentField is the field of op's input an argument carries: the one its note names, the one its
// name spells, or that name's plural (--task-id carries taskIds). "" when it carries none the schema has.
func cliArgumentField(op *operation, a cliArgument) string {
	var schema map[string]interface{}
	if op.MCP != nil {
		schema = op.MCP.InputSchema
	} else if op.CLI != nil {
		schema = op.CLI.InputSchema
	}
	props, _ := schema["properties"].(map[string]interface{})
	name := kebabToCamel(a.name())
	for _, candidate := range []string{a.field, name, name + "s"} {
		if candidate == "" {
			continue
		}
		if _, ok := props[candidate]; ok {
			return candidate
		}
		if _, ok := op.Example[candidate]; ok && props == nil {
			return candidate
		}
	}
	return ""
}

// examplePlaceholderFor is a flag's value when no example names it: an enum's first member, 1 for a
// count, and the declared placeholder otherwise.
func examplePlaceholderFor(a cliArgument) string {
	p := a.placeholder
	if strings.HasPrefix(p, "<") && strings.HasSuffix(p, ">") {
		inner := p[1 : len(p)-1]
		if strings.Contains(inner, "|") && !strings.Contains(inner, " ") {
			return strings.Split(inner, "|")[0]
		}
		switch inner {
		case "n", "N", "seconds", "count":
			return "1"
		}
	}
	return "<" + a.name() + ">"
}

// exampleArgValue renders an MCP example value as one argv word: a string as it is, a number in decimal, a
// comma list for a flag that takes one, and any other list or object as compact JSON.
func exampleArgValue(value interface{}, known, list bool, fallback string) string {
	if !known || value == nil {
		return fallback
	}
	switch v := value.(type) {
	case string:
		return v
	case bool:
		return strconv.FormatBool(v)
	case float64:
		return formatSchemaNumber(v)
	case int:
		return strconv.Itoa(v)
	case []interface{}:
		if list {
			words := make([]string, 0, len(v))
			for _, item := range v {
				word, isString := item.(string)
				if !isString {
					words = nil
					break
				}
				words = append(words, word)
			}
			if words != nil {
				return strings.Join(words, ",")
			}
		}
	}
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return fallback
	}
	return strings.TrimSuffix(b.String(), "\n")
}

// ── text form ───────────────────────────────────────────────────────────────────────────────────

func writeCapabilitySummaryText(doc capabilitySummaryDocument) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Orbit CLI %s — %d commands offered here (operation catalog v%s)\n", doc.CLIVersion, doc.Count, doc.CatalogVersion)
	for _, family := range doc.Families {
		fmt.Fprintf(&b, "\n%s\n", family.Family)
		for _, row := range family.Capabilities {
			marks := []string{}
			if row.Mutates {
				marks = append(marks, "writes")
			}
			if row.Approval != "" {
				marks = append(marks, "approval: "+string(row.Approval))
			}
			suffix := ""
			if len(marks) > 0 {
				suffix = " [" + strings.Join(marks, "; ") + "]"
			}
			fmt.Fprintf(&b, "  %-30s %s%s\n", row.ID, row.Intent, suffix)
		}
	}
	for _, unavailable := range doc.Unavailable {
		ids := append([]string{}, unavailable.IDs...)
		sort.Strings(ids)
		fmt.Fprintf(&b, "\nNot available here (%s): %s\n", unavailable.Reason, strings.Join(ids, ", "))
	}
	for _, withheld := range doc.Withheld {
		ids := append([]string{}, withheld.IDs...)
		sort.Strings(ids)
		fmt.Fprintf(&b, "\nNot offered here (%s): %s\n", withheld.Reason, strings.Join(ids, ", "))
	}
	fmt.Fprintf(&b, "\nOne command: %s\n", strings.Join(doc.Next.ID, " "))
	return b.String()
}

func writeCapabilityViewText(v capabilityView) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s — %s\n", v.ID, v.Intent)
	if v.Usage != "" {
		fmt.Fprintf(&b, "  usage: %s\n", v.Usage)
	}
	if !v.Available && v.UnavailableReason != "" {
		fmt.Fprintf(&b, "  not available here: %s\n", v.UnavailableReason)
	}
	fmt.Fprintf(&b, "  writes: %v; approval: %s\n", v.Mutates, v.Approval)
	fmt.Fprintf(&b, "  success: %s\n", v.SuccessEvidence)
	if len(v.Example.Argv) > 0 {
		fmt.Fprintf(&b, "  example: %s\n", shellJoin(v.Example.Argv))
	}
	return b.String()
}

// shellJoin is argv as a person would type it, each word quoted when the shell would split it.
func shellJoin(argv []string) string {
	words := make([]string, len(argv))
	for i, word := range argv {
		if word != "" && shellWordSafe(word) {
			words[i] = word
		} else {
			words[i] = shellQuote(word)
		}
	}
	return strings.Join(words, " ")
}
