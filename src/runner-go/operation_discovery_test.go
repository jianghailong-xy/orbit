package main

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Graded discovery (operation_discovery.go) is three more projections of the catalogue and of the offer
// buildCLICapabilities makes. These tests hold them to it:
//
//   - every view answers for exactly the commands the full document offers, and explains every catalogued
//     command it does not offer;
//   - every view carries the absolute argv, the context (actor, session, agent, task), availability with its
//     reason, mutates, approval and success evidence, in a stable shape;
//   - every generated example is one its own surface accepts: the MCP example passes the tool's schema, the
//     CLI example reaches the command's own flag parser with every flag it names accepted;
//   - the ordinary task-create discovery flow stays inside a budget no engine's output cut reaches.

// discoveryLongExe is an executable path longer than any runner's, so a budget holds for every runner.
const discoveryLongExe = "/home/a-long-account-name/.orbit/bin/versions/0.1.999/orbit"

type discoveryContext struct {
	name string
	env  map[string]string
}

// discoveryContexts are the shapes a process asks from: the fullest session, a session with orchestration
// off, one with Watch and the wiki off, and a headless process on the runner credential.
var discoveryContexts = []discoveryContext{
	{"session-fullest", map[string]string{"ORBIT_SESSION_ID": "s-test", "ORBIT_AGENT_ID": "a-test", "ORBIT_TASK_ID": "t-test",
		envMCPOrchestration: "true", envOrchestrationToken: "token", envWatches: "on", envWiki: "on"}},
	{"session-orchestration-off", map[string]string{"ORBIT_SESSION_ID": "s-test", "ORBIT_AGENT_ID": "a-test", "ORBIT_TASK_ID": "",
		envMCPOrchestration: "", envOrchestrationToken: "", envWatches: "on", envWiki: "on"}},
	{"session-switches-off", map[string]string{"ORBIT_SESSION_ID": "s-test", "ORBIT_AGENT_ID": "a-test", "ORBIT_TASK_ID": "t-test",
		envMCPOrchestration: "true", envOrchestrationToken: "token", envWatches: "off", envWiki: "off"}},
	{"headless", map[string]string{"ORBIT_SESSION_ID": "", "ORBIT_AGENT_ID": "", "ORBIT_TASK_ID": "",
		envMCPOrchestration: "", envOrchestrationToken: "", envWatches: "on", envWiki: "on"}},
}

func enterDiscoveryContext(t *testing.T, c discoveryContext) {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv("ORBIT_USER_TOKEN", "")
	t.Setenv("ORBIT_SERVICE_TOKEN", "")
	for key, value := range c.env {
		t.Setenv(key, value)
	}
}

func TestGradedViewsAnswerForExactlyWhatTheFullDocumentOffers(t *testing.T) {
	for _, c := range discoveryContexts {
		t.Run(c.name, func(t *testing.T) {
			enterDiscoveryContext(t, c)
			d := newCLIDiscovery("/opt/orbit")
			full := buildCLICapabilities("/opt/orbit")
			offered := map[string]cliCapability{}
			for _, capability := range full.Capabilities {
				offered[capability.ID] = capability
			}

			summary := d.summary()
			if summary.Count != full.CapabilityCount {
				t.Errorf("summary count %d, the full document offers %d", summary.Count, full.CapabilityCount)
			}
			listed := map[string]bool{}
			for _, family := range summary.Families {
				for _, row := range family.Capabilities {
					listed[row.ID] = true
					op := catalogHasOperation(t, row.ID)
					if _, ok := offered[row.ID]; !ok {
						t.Errorf("summary lists %s, which the full document does not offer here", row.ID)
					}
					if family.Family != op.family() {
						t.Errorf("summary lists %s under %s, its family is %s", row.ID, family.Family, op.family())
					}
					if row.Intent != op.Intent || row.Mutates != op.Mutates {
						t.Errorf("summary row %s is not the catalogue's intent and mutation", row.ID)
					}
					if (op.Approval == approvalKindNone) != (row.Approval == "") || (row.Approval != "" && row.Approval != op.Approval) {
						t.Errorf("summary row %s approval %q, catalogue %q", row.ID, row.Approval, op.Approval)
					}
				}
			}
			for id := range offered {
				if !listed[id] {
					t.Errorf("the full document offers %s and the summary does not list it", id)
				}
			}
			unavailable := map[string]string{}
			for _, group := range summary.Unavailable {
				for _, id := range group.IDs {
					unavailable[id] = group.Reason
				}
			}
			for id, capability := range offered {
				if !capability.Available && unavailable[id] != capability.UnavailableReason {
					t.Errorf("%s is unavailable here (%q) but the summary says %q", id, capability.UnavailableReason, unavailable[id])
				}
				if capability.Available && unavailable[id] != "" {
					t.Errorf("%s is available here but the summary names it unavailable", id)
				}
			}
			withheld := map[string]string{}
			for _, group := range summary.Withheld {
				if strings.TrimSpace(group.Reason) == "" {
					t.Errorf("withheld %v with no reason", group.IDs)
				}
				for _, id := range group.IDs {
					withheld[id] = group.Reason
				}
			}
			for _, op := range operationCatalog().Ops {
				if op.CLI == nil {
					continue
				}
				_, isOffered := offered[op.Tool]
				if isOffered == (withheld[op.Tool] != "") {
					t.Errorf("%s: offered=%v but withheld reason %q — a command is either offered or explained", op.Tool, isOffered, withheld[op.Tool])
				}
			}

			// The family and id views say the same as the full document about every command it offers,
			// and say why about every other.
			for _, family := range d.families() {
				doc, err := d.family(family)
				if err != nil {
					t.Fatalf("family %s: %v", family, err)
				}
				reasons := map[string]string{}
				for _, group := range doc.Unavailable {
					for _, id := range group.IDs {
						reasons[id] = group.Reason
					}
				}
				for _, view := range doc.Capabilities {
					if view.UnavailableReason != "" {
						t.Errorf("family %s: %s carries its reason inline; the family gives it once under unavailable", family, view.ID)
					}
					if !view.Available {
						view.UnavailableReason = reasons[view.ID]
					} else if reasons[view.ID] != "" {
						t.Errorf("family %s: %s is available but named under unavailable", family, view.ID)
					}
					checkCapabilityViewAgainstOffer(t, "family "+family, view, offered)
				}
			}
			for _, op := range operationCatalog().Ops {
				doc, err := d.id(op.Tool)
				if err != nil {
					t.Fatalf("id %s: %v", op.Tool, err)
				}
				view := doc.Capability
				checkCapabilityViewAgainstOffer(t, "id", view, offered)
				if capability, ok := offered[op.Tool]; ok {
					if !reflect.DeepEqual(view.HelpArgv, capability.HelpArgv) || view.Description != capability.Description {
						t.Errorf("id %s: helpArgv or description is not the full document's", op.Tool)
					}
					var flags []string
					for _, parameter := range view.Parameters {
						flags = append(flags, parameter.Flag)
					}
					for i, argument := range capability.Arguments {
						if i >= len(flags) || !strings.HasPrefix(argument, flags[i]) {
							t.Errorf("id %s: parameter %d is not the full document's argument %q", op.Tool, i, argument)
							break
						}
					}
				}
				if view.Idempotency != op.Idempotency || view.Retry != op.Retry || view.Returns != op.Returns || view.PlanMode != op.Plan ||
					!reflect.DeepEqual(view.MutuallyExclusive, op.Exclusive) || view.Object != op.Object {
					t.Errorf("id %s: retry, idempotency, Plan mode, returns, exclusive groups or object are not the catalogue's", op.Tool)
				}
			}
		})
	}
}

func checkCapabilityViewAgainstOffer(t *testing.T, where string, view capabilityView, offered map[string]cliCapability) {
	t.Helper()
	op := catalogHasOperation(t, view.ID)
	if view.Mutates != op.Mutates || view.Approval != op.Approval || view.ApprovalKey != op.ApprovalKey ||
		view.SuccessEvidence != op.SuccessEvidence || view.Intent != op.Intent || view.Destructive != op.Destructive {
		t.Errorf("%s %s: mutates, approval, success evidence, intent or destructive is not the catalogue's", where, view.ID)
	}
	if strings.TrimSpace(view.SuccessEvidence) == "" {
		t.Errorf("%s %s states no success evidence", where, view.ID)
	}
	capability, isOffered := offered[view.ID]
	switch {
	case isOffered:
		if !reflect.DeepEqual(view.Argv, capability.Argv) || view.Usage != capability.Usage {
			t.Errorf("%s %s: argv %v / usage are not the full document's %v", where, view.ID, view.Argv, capability.Argv)
		}
		if view.Available != capability.Available || view.UnavailableReason != capability.UnavailableReason {
			t.Errorf("%s %s: available=%v (%q), the full document says %v (%q)", where, view.ID, view.Available,
				view.UnavailableReason, capability.Available, capability.UnavailableReason)
		}
	default:
		if view.Available || strings.TrimSpace(view.UnavailableReason) == "" {
			t.Errorf("%s %s is not offered here, so it must be unavailable with a reason; got available=%v reason=%q",
				where, view.ID, view.Available, view.UnavailableReason)
		}
	}
	if op.CLI != nil {
		if len(view.Argv) < 2 || !filepath.IsAbs(view.Argv[0]) {
			t.Errorf("%s %s argv %v does not start with an absolute executable", where, view.ID, view.Argv)
		}
		if len(view.Example.Argv) < len(view.Argv) || !reflect.DeepEqual(view.Example.Argv[:len(view.Argv)], view.Argv) {
			t.Errorf("%s %s example %v is not a call of its argv %v", where, view.ID, view.Example.Argv, view.Argv)
		}
	} else if len(view.Argv) != 0 || len(view.Example.Argv) != 0 {
		t.Errorf("%s %s has no CLI command but the view gives it an argv", where, view.ID)
	}
}

// Every view carries the context the full document carries — who the CLI acts as, in which session, for
// which agent and task — and every argv in it is absolute.
func TestGradedViewsCarryTheContextAndAbsoluteArgv(t *testing.T) {
	catalogFullestCLIContext(t)
	t.Setenv("ORBIT_TASK_ID", "catalog-test-task")
	d := newCLIDiscovery("/opt/orbit")
	want := buildCLICapabilities("/opt/orbit").Context
	if want.Actor != "agent" || want.SessionID == "" || want.TaskID == "" || want.AgentID == "" {
		t.Fatalf("the fullest context is not an agent's session with a task: %+v", want)
	}
	family, err := d.family("task")
	if err != nil {
		t.Fatal(err)
	}
	id, err := d.id("task_create")
	if err != nil {
		t.Fatal(err)
	}
	for _, header := range []discoveryHeader{d.summary().discoveryHeader, family.discoveryHeader, id.discoveryHeader} {
		if !reflect.DeepEqual(header.Context, want) {
			t.Errorf("%s view context = %+v, want %+v", header.View, header.Context, want)
		}
		if header.CatalogVersion != operationCatalogVersion || header.CatalogHash != operationCatalog().Hash ||
			header.ViewVersion != discoveryViewVersion || header.ReceiptFlag != "--receipt" {
			t.Errorf("%s view does not name the catalogue, its own version and the receipt flag: %+v", header.View, header)
		}
	}
	for _, argv := range [][]string{d.next().Family, d.next().ID, d.next().Guide, d.next().Full} {
		if !filepath.IsAbs(argv[0]) {
			t.Errorf("next argv %v is not absolute", argv)
		}
	}
}

// The documents are stable: the same context answers the same bytes, and each decodes into its declared
// shape with no field left over.
func TestGradedViewsAreStableJSON(t *testing.T) {
	catalogFullestCLIContext(t)
	encode := func(v interface{}) []byte {
		var b bytes.Buffer
		enc := json.NewEncoder(&b)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(v); err != nil {
			t.Fatal(err)
		}
		return b.Bytes()
	}
	build := func() [][]byte {
		d := newCLIDiscovery("/opt/orbit")
		family, _ := d.family("task")
		id, _ := d.id("task_create")
		g := cliGuideFacts("/opt/orbit")
		index, _ := guideAnswer(g, "")
		topic, _ := guideAnswer(g, "task-create")
		return [][]byte{encode(d.summary()), encode(family), encode(id), encode(index), encode(topic)}
	}
	first, second := build(), build()
	targets := []interface{}{&capabilitySummaryDocument{}, &capabilityFamilyDocument{}, &capabilityIDDocument{},
		&guideIndexDocument{}, &guideTopicDocument{}}
	for i := range first {
		if !bytes.Equal(first[i], second[i]) {
			t.Errorf("document %d is not the same twice:\n%s\n%s", i, first[i], second[i])
		}
		dec := json.NewDecoder(bytes.NewReader(first[i]))
		dec.DisallowUnknownFields()
		if err := dec.Decode(targets[i]); err != nil {
			t.Errorf("document %d does not decode into its declared shape: %v", i, err)
		}
	}
	// The order a reader meets the fields in is the declared one: what it is, who asked, then the answer.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(first[0], &raw); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"view", "viewVersion", "catalogVersion", "catalogHash", "cliVersion", "context", "receiptFlag", "count", "families", "next"} {
		if _, ok := raw[key]; !ok {
			t.Errorf("the summary has no %q", key)
		}
	}
	if !bytes.HasPrefix(first[0], []byte(`{"view":"summary","viewVersion":1,"catalogVersion":`)) {
		t.Errorf("the summary does not open with its view and versions: %.80s", first[0])
	}
}

// Every example the catalogue generates is one its own surface accepts. The MCP arguments pass the
// tool's schema, exclusive groups included; the CLI command line reaches the command's own flag parser
// with every flag it names accepted (the probe flag after them is the first thing refused, before any
// request); and the CLI example names every argument the command requires. A recipe's step examples are
// held to the same.
func TestEveryGeneratedExampleIsAcceptedByItsOwnSurface(t *testing.T) {
	catalogFullestCLIContext(t)
	ops := map[string]*operation{}
	for _, op := range operationCatalog().Ops {
		ops[op.Tool] = op
	}
	type example struct {
		label string
		op    *operation
	}
	var examples []example
	for _, op := range operationCatalog().Ops {
		examples = append(examples, example{op.Tool, op})
	}
	for _, topic := range guideTopics {
		for i, step := range topic.Steps {
			op := ops[step.Op]
			if op == nil {
				t.Fatalf("guide topic %s step %d names %s, which the catalogue does not declare", topic.ID, i+1, step.Op)
			}
			examples = append(examples, example{"guide " + topic.ID + " step " + step.Op, guideStepOperation(op, step.Example)})
		}
	}
	for _, ex := range examples {
		op := ex.op
		if op.MCP != nil && !openInputTools[op.Tool] {
			args := catalogMCPExample(op)
			if violations := validateToolArguments(op, args); len(violations) > 0 {
				t.Errorf("%s: the MCP example %v is refused by its own schema: %+v", ex.label, args, violations)
			}
		}
		if op.CLI == nil {
			continue
		}
		argv := catalogCLIExample(op, "/opt/orbit")
		if argv[0] != "/opt/orbit" || !reflect.DeepEqual(argv[1:len(op.CLI.Argv)], op.CLI.Argv[1:]) {
			t.Errorf("%s: the CLI example %v is not a call of %v", ex.label, argv, op.CLI.Argv)
			continue
		}
		words := strings.Join(argv, "\x00")
		for _, argument := range runtimeCLIArguments(op) {
			a := parseCLIArgument(argument)
			if !a.required {
				continue
			}
			if a.flag != "" && !strings.Contains(words, "\x00"+a.flag) {
				t.Errorf("%s: the CLI example %v leaves out the required %s", ex.label, argv, a.flag)
			}
		}
		// The two examples say the same thing: every field of the MCP example is carried by an argument
		// of the CLI example, unless the row spells its command line itself.
		if op.MCP != nil && op.CLIExample == nil {
			for field := range catalogMCPExample(op) {
				if !cliExampleNamesField(op, field) {
					t.Errorf("%s: the MCP example's %q has no CLI argument, so the two examples disagree", ex.label, field)
				}
			}
		}
		probe := []string{}
		for _, word := range argv[1:] {
			if word != "--receipt" {
				probe = append(probe, word)
			}
		}
		probe = append(probe, "--orbit-catalog-probe")
		var out, errOut strings.Builder
		err := runOrbitCLI(probe, strings.NewReader(""), &out, &errOut)
		if err == nil || !strings.Contains(err.Error(), "flag provided but not defined: -orbit-catalog-probe") {
			t.Errorf("%s: the CLI example %v did not reach its parser with every flag accepted: %v", ex.label, argv, err)
		}
	}
}

// The ordinary create's examples are pinned word for word: they are what the guide's task-create recipe and
// `capabilities --id task_create` hand an agent, so a generator rule that adds a conditional flag to them (or
// drops a field the rules ask for) is a change an agent would copy.
func TestTheOrdinaryCreateExamplesArePinned(t *testing.T) {
	op := catalogOperation("task_create")
	wantArgv := []string{"/opt/orbit", "task", "create",
		"--title", "<title>",
		"--description", "<a self-contained prompt: background, files, steps>",
		"--acceptance-criteria", "<what the person said would settle it>",
		"--idempotency-key", "<a slug of the work>",
		"--completion-criterion", "EVIDENCE_JUDGMENT",
		"--receipt"}
	if got := catalogCLIExample(op, "/opt/orbit"); !reflect.DeepEqual(got, wantArgv) {
		t.Errorf("task_create's CLI example =\n%q\nwant\n%q", got, wantArgv)
	}
	wantMCP := map[string]interface{}{
		"title":               "<title>",
		"description":         "<a self-contained prompt: background, files, steps>",
		"completionCriterion": "EVIDENCE_JUDGMENT",
		"acceptanceCriteria":  "<what the person said would settle it>",
		"idempotencyKey":      "<a slug of the work>",
	}
	if got := catalogMCPExample(op); !reflect.DeepEqual(got, wantMCP) {
		t.Errorf("task_create's MCP example = %v, want %v", got, wantMCP)
	}
	batch := catalogCLIExample(catalogOperation("task_create_batch"), "/opt/orbit")
	if len(batch) != 8 || batch[3] != "--tasks" || !strings.Contains(batch[4], `"dependsOnRefs":["s1"]`) ||
		strings.Contains(batch[4], `\u003c`) || batch[5] != "--idempotency-key" || batch[7] != "--receipt" {
		t.Errorf("task_create_batch's CLI example is not one --tasks document of two items, keyed: %q", batch)
	}
	await := catalogCLIExample(catalogOperation("task_await"), "/opt/orbit")
	if strings.Join(await, " ") != "/opt/orbit task await --task-id <taskId> --receipt" {
		t.Errorf("task_await's CLI example = %q", await)
	}
}

// cliExampleNamesField reports whether some leaf argument of op carries field, as the CLI example maps
// it: by the field it names, or as part of the --input document that takes the tool's arguments whole.
func cliExampleNamesField(op *operation, field string) bool {
	for _, argument := range runtimeCLIArguments(op) {
		a := parseCLIArgument(argument)
		if a.flag == "--input" || cliArgumentField(op, a) == field {
			return true
		}
	}
	return false
}

// A command a process is not offered is answered with why, in the words the door itself would refuse
// with, so an agent learns the reason from discovery rather than from a refused call.
func TestWithheldCommandsSayWhy(t *testing.T) {
	cases := []struct {
		context discoveryContext
		tool    string
		want    string
	}{
		{discoveryContexts[1], "session_create", orchestrationOffMsg},
		{discoveryContexts[1], "agent_list", orchestrationOffMsg},
		{discoveryContexts[2], "watch_create", "Watch is switched off for this session"},
		{discoveryContexts[2], "wiki_search", "the Orbit wiki is switched off for this session"},
		{discoveryContexts[3], "watch_create", "ORBIT_SESSION_ID is unset"},
		{discoveryContexts[0], "login", "inside an Orbit session the CLI acts as the session"},
		{discoveryContexts[0], "bg_run", "no CLI command (runner-hosted background jobs"},
	}
	for _, tc := range cases {
		t.Run(tc.context.name+"/"+tc.tool, func(t *testing.T) {
			enterDiscoveryContext(t, tc.context)
			doc, err := newCLIDiscovery("/opt/orbit").id(tc.tool)
			if err != nil {
				t.Fatal(err)
			}
			if doc.Capability.Available || !strings.Contains(doc.Capability.UnavailableReason, tc.want) {
				t.Fatalf("%s available=%v reason %q, want it unavailable saying %q", tc.tool,
					doc.Capability.Available, doc.Capability.UnavailableReason, tc.want)
			}
		})
	}
}

// The graded views are reached through the router like every other command, one view at a time, and a
// name that is not there is refused with the names that are.
func TestCapabilitiesViewFlagsAreRoutedAndExclusive(t *testing.T) {
	catalogFullestCLIContext(t)
	run := func(args ...string) (string, error) {
		var out, errOut strings.Builder
		err := runOrbitCLI(args, strings.NewReader(""), &out, &errOut)
		return out.String(), err
	}
	for _, args := range [][]string{
		{"capabilities", "--summary", "--json"},
		{"capabilities", "--family", "task", "--json"},
		{"capabilities", "--id", "task_create", "--json"},
		{"capabilities", "--id", "bg_run", "--json"},
		{"guide", "--json"},
		{"guide", "task-create", "--json"},
		{"guide", "--json", "task-create"},
	} {
		out, err := run(args...)
		if err != nil {
			t.Fatalf("orbit %s: %v", strings.Join(args, " "), err)
		}
		var decoded map[string]interface{}
		if err := json.Unmarshal([]byte(out), &decoded); err != nil {
			t.Fatalf("orbit %s did not print one JSON document: %v\n%s", strings.Join(args, " "), err, out)
		}
	}
	for _, args := range [][]string{{"capabilities", "--summary"}, {"capabilities", "--id", "task_create"}, {"guide"}, {"guide", "task-create"}} {
		if out, err := run(args...); err != nil || strings.TrimSpace(out) == "" {
			t.Errorf("orbit %s printed nothing for a person: %v", strings.Join(args, " "), err)
		}
	}
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"capabilities", "--summary", "--id", "task_create"}, "pass one of them"},
		{[]string{"capabilities", "--family", "task", "--id", "task_create"}, "pass one of them"},
		{[]string{"capabilities", "--id", "no_such_operation", "--json"}, "capabilities --summary --json"},
		{[]string{"capabilities", "--family", "no-such-family", "--json"}, "task-list"},
		{[]string{"capabilities", "--family", "", "--json"}, "--family needs a family name"},
		{[]string{"guide", "no-such-topic", "--json"}, "task-create"},
		{[]string{"guide", "task-create", "task-batch"}, "unexpected arguments"},
	} {
		if _, err := run(tc.args...); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("orbit %s: err = %v, want it to say %q", strings.Join(tc.args, " "), err, tc.want)
		}
	}
	// The whole document is still the whole document: what a reader of it always had is untouched.
	out, err := run("capabilities", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var full cliCapabilitiesDocument
	if err := json.Unmarshal([]byte(out), &full); err != nil || full.SchemaVersion != runnerWriteSchemaRevision || len(full.Capabilities) != full.CapabilityCount {
		t.Fatalf("orbit capabilities --json is no longer the full document: %v", err)
	}
}

// ── the budget ──────────────────────────────────────────────────────────────────────────────────

// What the engines Orbit runs cut a tool's output at, measured on this runner on 2026-11-14: Claude Code
// 2.1.325 keeps the first 30,000 characters of a shell command's output (BASH_MAX_OUTPUT_LENGTH's default),
// and every model in Codex 0.167.2's catalogue truncates a tool's output at 10,000 tokens
// (~/.codex/models_cache.json: truncation_policy {"mode": "tokens", "limit": 10000}).
const (
	claudeCodeShellOutputMaxChars = 30000
	codexToolOutputMaxTokens      = 10000
)

// discoveryAnswerMaxBytes is the most one graded answer may take in any context: under Claude Code's cut,
// and under Codex's even at a pessimistic two bytes a token (JSON of ids and hashes tokenizes densely).
const discoveryAnswerMaxBytes = 16 * 1024

// taskCreateDiscoveryFlowMaxBytes is the most the ordinary task-create discovery takes in all: the
// guide's index, its task-create topic and the one command in full.
const taskCreateDiscoveryFlowMaxBytes = 24 * 1024

func pessimisticTokens(answer []byte) int { return (len(answer) + 1) / 2 }

func checkDiscoveryAnswer(t *testing.T, label string, answer []byte) {
	t.Helper()
	if len(answer) > discoveryAnswerMaxBytes {
		t.Errorf("%s is %d bytes, over the %d-byte budget of one graded answer", label, len(answer), discoveryAnswerMaxBytes)
	}
	if len([]rune(string(answer))) > claudeCodeShellOutputMaxChars || pessimisticTokens(answer) > codexToolOutputMaxTokens {
		t.Errorf("%s (%d bytes) would be cut by an engine's tool-output limit", label, len(answer))
	}
	if !json.Valid(answer) {
		t.Errorf("%s is not one whole JSON document", label)
	}
}

// The ordinary task-create discovery — the flow the instructions send an agent down — stays bounded: the
// guide's index, its task-create topic and `capabilities --id task_create`, in the fullest context, with an
// executable path longer than any runner's, on both surfaces. Each answer is whole JSON well under every
// engine's output cut, the three together are a small fraction of the full document, and between them
// they hand the agent what it needs to call: the absolute argv, the approval, a minimal example, what
// proves success, and who it acts as.
func TestTaskCreateDiscoveryFlowStaysBounded(t *testing.T) {
	catalogFullestCLIContext(t)
	t.Setenv("ORBIT_TASK_ID", "catalog-test-task")
	encode := func(v interface{}) []byte {
		blob, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return blob
	}
	facts := cliGuideFacts(discoveryLongExe)
	index, err := guideAnswer(facts, "")
	if err != nil {
		t.Fatal(err)
	}
	topic, err := guideAnswer(facts, "task-create")
	if err != nil {
		t.Fatal(err)
	}
	id, err := newCLIDiscovery(discoveryLongExe).id("task_create")
	if err != nil {
		t.Fatal(err)
	}
	flow := [][]byte{encode(index), encode(topic), encode(id)}
	total := 0
	for i, answer := range flow {
		checkDiscoveryAnswer(t, []string{"guide index", "guide task-create", "capabilities --id task_create"}[i], answer)
		total += len(answer)
	}
	if total > taskCreateDiscoveryFlowMaxBytes {
		t.Errorf("the task-create discovery takes %d bytes, over its %d-byte budget", total, taskCreateDiscoveryFlowMaxBytes)
	}
	whole := encode(buildCLICapabilities(discoveryLongExe))
	if total*10 > len(whole) {
		t.Errorf("the task-create discovery (%d bytes) is not a small part of the whole document (%d bytes)", total, len(whole))
	}
	t.Logf("task-create discovery: index %d + topic %d + id %d = %d bytes (~%d tokens); whole document %d bytes",
		len(flow[0]), len(flow[1]), len(flow[2]), total, estimateTokens(string(flow[0])+string(flow[1])+string(flow[2])), len(whole))

	// What the agent needs to call is in the answers, not behind them.
	var route bool
	for _, r := range index.(guideIndexDocument).Routes {
		if r.Topic == "task-create" && containsOp(r.Operations, "task_create") {
			route = true
		}
	}
	if !route {
		t.Error("the guide's index routes no request to task-create")
	}
	recipe := topic.(guideTopicDocument)
	var create *guideStepView
	for i := range recipe.Steps {
		if recipe.Steps[i].ID == "task_create" {
			create = &recipe.Steps[i]
		}
	}
	if create == nil || create.CLI == nil || create.MCP == nil {
		t.Fatal("the task-create recipe has no task_create step on both surfaces")
	}
	wantArgv := []string{discoveryLongExe, "task", "create"}
	if !reflect.DeepEqual(create.CLI.Argv, wantArgv) || !create.CLI.Available || !create.MCP.Available ||
		create.Approval != approvalKindCard || create.ApprovalKey != "orbit_task_create" || create.SuccessEvidence == "" ||
		len(create.CLI.Example) <= len(wantArgv) || create.MCP.Arguments["completionCriterion"] != "EVIDENCE_JUDGMENT" {
		t.Errorf("the task_create step does not hand over the argv, availability, approval, example and evidence: %+v", create)
	}
	if recipe.Context.Actor != "agent" || recipe.Context.SessionID == "" || recipe.Context.TaskID == "" {
		t.Errorf("the recipe does not say who it acts as: %+v", recipe.Context)
	}
	capability := id.Capability
	if !reflect.DeepEqual(capability.Argv, wantArgv) || !capability.Available || capability.Approval != approvalKindCard ||
		capability.SuccessEvidence == "" || len(capability.Example.Argv) == 0 || len(capability.Example.MCP) == 0 ||
		len(capability.Parameters) == 0 || id.Context.Actor != "agent" {
		t.Errorf("capabilities --id task_create does not hand over what a call needs: %+v", capability)
	}

	// The same flow over MCP, as the guide tool answers it.
	srv := &mcpServer{sessionID: "catalog-test-session", agentID: "catalog-test-agent", taskID: "catalog-test-task", allowOrchestration: true}
	for _, args := range []map[string]interface{}{{}, {"topic": "task-create"}} {
		result := srv.invokeTool("guide", args)
		text := mcpResultText(result)
		checkDiscoveryAnswer(t, "MCP guide "+string(encode(args)), []byte(text))
		if result["isError"] == true || result["structuredContent"] == nil {
			t.Errorf("MCP guide %v did not answer with its document: %v", args, result)
		}
	}
}

// Every graded answer in every context stays inside one answer's budget — the summary, every family,
// every operation's id view, the guide's index and every topic — so no part of discovery is the one an
// engine cuts.
func TestEveryGradedAnswerIsBounded(t *testing.T) {
	for _, c := range discoveryContexts {
		t.Run(c.name, func(t *testing.T) {
			enterDiscoveryContext(t, c)
			d := newCLIDiscovery(discoveryLongExe)
			encode := func(v interface{}) []byte {
				blob, err := json.Marshal(v)
				if err != nil {
					t.Fatal(err)
				}
				return blob
			}
			checkDiscoveryAnswer(t, "summary", encode(d.summary()))
			for _, family := range d.families() {
				doc, err := d.family(family)
				if err != nil {
					t.Fatal(err)
				}
				checkDiscoveryAnswer(t, "family "+family, encode(doc))
			}
			for _, op := range operationCatalog().Ops {
				doc, err := d.id(op.Tool)
				if err != nil {
					t.Fatal(err)
				}
				checkDiscoveryAnswer(t, "id "+op.Tool, encode(doc))
			}
			facts := cliGuideFacts(discoveryLongExe)
			for _, topic := range append([]string{""}, guideTopicIDs()...) {
				doc, err := guideAnswer(facts, topic)
				if err != nil {
					t.Fatal(err)
				}
				checkDiscoveryAnswer(t, "guide "+topic, encode(doc))
			}
		})
	}
}

func containsOp(ops []string, op string) bool {
	for _, o := range ops {
		if o == op {
			return true
		}
	}
	return false
}
