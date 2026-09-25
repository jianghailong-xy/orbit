package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestWithOrbitCLIInstructions(t *testing.T) {
	exe := "/opt/orbit runner/bin/orbit"
	orbit := orbitCLIInstructions(exe, false, true)
	if got := withOrbitCLIInstructions("", exe, false, true); got != orbit {
		t.Fatalf("empty configured instructions = %q", got)
	}

	got := withOrbitCLIInstructions("Owner instructions.\n", exe, false, true)
	want := "Owner instructions.\n\n" + orbit
	if got != want {
		t.Fatalf("merged instructions = %q, want %q", got, want)
	}
	for _, phrase := range []string{
		"'/opt/orbit runner/bin/orbit' capabilities --json",
		"mcp__orbit__*",
		"Use `--json` output",
		" mcp` directly",
		"durable record",
		"returned its id",
		"Most newly discovered work is one task",
		"4 or more steps that depend on one another",
		"you may propose recording it as an Orbit Project",
		"do not propose the same body of work twice",
		// The owner's rule: nothing is created on their behalf without a yes, and the yes is the
		// card the create raises, never the model deciding the shape qualifies. Saying first what is
		// about to be created is what keeps that card from arriving unannounced.
		"writes nothing until they confirm it",
		"first say in a sentence or two what you are about to create",
		"do not create it another way",
		"Its confirmation card is the user's answer",
		"from this same session",
		// A reply names Orbit things by a link the clients draw as the title, not by a bare id.
		"`[Fix login redirect](orbit-task:<id>)`",
		"orbit-session:<id>",
	} {
		if !strings.Contains(got, phrase) {
			t.Errorf("merged instructions do not contain %q", phrase)
		}
	}
}

func TestShellQuote(t *testing.T) {
	if got := shellQuote("/tmp/o'rbit"); got != `'/tmp/o'"'"'rbit'` {
		t.Fatalf("shellQuote = %q", got)
	}
}

func TestAppendClaudeAgentInstructionArgsAddsOnlyAbsolutePhase1Rules(t *testing.T) {
	exe := "/usr/local/bin/orbit"
	got := appendClaudeAgentInstructionArgs([]string{"-p"}, AgentExecConfig{
		SystemPrompt:       "Base agent instructions.",
		AppendSystemPrompt: "Owner append instructions.",
		AllowedTools:       []string{"Read", "mcp__orbit__*"},
	}, exe, false, false, true)
	wantAllowed := append([]string{"Read", "mcp__orbit__*"}, orbitCLIAllowedTools(exe, false)...)
	want := []string{
		"-p",
		"--system-prompt", "Base agent instructions.",
		"--append-system-prompt", "Owner append instructions.\n\n" + orbitCLIInstructions(exe, false, true),
		"--allowedTools", strings.Join(wantAllowed, ","),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Claude instruction args = %#v, want %#v", got, want)
	}
	joined := strings.Join(got, "\n")
	for _, required := range []string{
		"Bash('/usr/local/bin/orbit' task list *)",
		"Bash(/usr/local/bin/orbit task list *)",
		"Bash('/usr/local/bin/orbit' task delete *)",
		"Bash(/usr/local/bin/orbit task delete *)",
	} {
		if !strings.Contains(joined, required) {
			t.Fatalf("missing compatible Orbit CLI rule %q in %q", required, joined)
		}
	}
	for _, forbidden := range []string{"Bash(orbit", " task *)", " task-list *)", " mcp *)", " session *)", " agent *)"} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("unsafe Orbit CLI rule %q in %q", forbidden, joined)
		}
	}
}

func TestAppendClaudeAgentInstructionArgsFailsClosedWithoutSafeExecutable(t *testing.T) {
	agent := AgentExecConfig{
		AppendSystemPrompt: "Owner instructions.",
		AllowedTools:       []string{"Read"},
	}
	want := []string{"-p", "--append-system-prompt", "Owner instructions.", "--allowedTools", "Read"}
	if got := appendClaudeAgentInstructionArgs([]string{"-p"}, agent, "", false, false, true); !reflect.DeepEqual(got, want) {
		t.Fatalf("missing executable args = %#v, want %#v", got, want)
	}
	if got := withOrbitCLIInstructions("Owner instructions.", "", false, true); got != "Owner instructions." {
		t.Fatalf("missing executable instructions = %q", got)
	}
	if got := appendClaudeAgentInstructionArgs([]string{"-p"}, AgentExecConfig{}, "", false, false, true); !reflect.DeepEqual(got, []string{"-p"}) {
		t.Fatalf("empty fail-closed args = %#v", got)
	}
}

func TestOrbitCLIAllowedToolsRejectsPolicyMetacharacters(t *testing.T) {
	for _, executable := range []string{"orbit", "/tmp/orbit,Read", "/tmp/orbit)", "/tmp/orbit*", `/tmp/orbit\x`, "/tmp/o'rbit", "/tmp/or`bit", "/tmp/<orbit>"} {
		if got := orbitCLIPermissionExecutable(executable); got != "" {
			t.Fatalf("unsafe executable %q accepted as %q", executable, got)
		}
	}
	if got := orbitCLIAllowedTools("", false); len(got) != 0 {
		t.Fatalf("empty executable rules = %#v", got)
	}
	if got := orbitCLIInstructions("/tmp/or`bit", false, true); got != "" {
		t.Fatalf("Markdown-unsafe executable instructions = %q", got)
	}
	spaced := orbitCLIAllowedTools("/opt/orbit runner/bin/orbit", false)
	for _, rule := range spaced {
		if strings.Contains(rule, "Bash(/opt/orbit runner") {
			t.Fatalf("space-containing executable gained unquoted rule %q", rule)
		}
	}
}

func TestOrbitCLIAllowedToolsAddsSessionRulesOnlyForOrchestrators(t *testing.T) {
	exe := "/usr/local/bin/orbit"
	base := strings.Join(orbitCLIAllowedTools(exe, false), "\n")
	// Asserted verb by verb rather than as the substring " session ", because the merge receipts
	// ARE pre-approved without the grant — they are advertised ungated (§13.7) — and a substring
	// check would have to be widened to the point of not saying anything. What must not be here is
	// the orchestration family itself, and the same goes for the agent verbs beside it.
	for _, action := range []string{"create", "list", "search", "get", "await", "send", "interrupt", "merge", "end", "complete", "delete"} {
		if strings.Contains(base, " session "+action+" *)") {
			t.Errorf("non-orchestrator gained session %s rule: %q", action, base)
		}
	}
	for _, action := range []string{"list", "create", "update"} {
		if strings.Contains(base, " agent "+action+" *)") {
			t.Errorf("non-orchestrator gained agent %s rule: %q", action, base)
		}
	}
	enabled := strings.Join(orbitCLIAllowedTools(exe, true), "\n")
	for _, action := range []string{"create", "list", "search", "get", "await", "send", "interrupt", "merge", "end", "complete", "delete"} {
		if !strings.Contains(enabled, "Bash("+exe+" session "+action+" *)") {
			t.Errorf("orchestrator missing session %s rule in %q", action, enabled)
		}
	}
	for _, action := range []string{"list", "create", "update"} {
		if !strings.Contains(enabled, "Bash("+exe+" agent "+action+" *)") {
			t.Errorf("orchestrator missing agent %s rule in %q", action, enabled)
		}
	}
}

// The two forms of the project paragraph, and the fact that ONLY that paragraph differs: a task
// session must still be told what an Orbit task is for and which tool writes one. Asserted in both
// directions, because the split is a difference of emphasis rather than of permission — a task
// form that had lost the task default, or an open form that had gained it, would each pass a
// one-sided check. What a task session is NOT told is the open form's bar; it starts from the home
// the work already has and says what agreeing costs.
func TestOrbitProjectInstructionsDifferInsideRecordedWork(t *testing.T) {
	exe := "/usr/local/bin/orbit"
	open := orbitCLIInstructions(exe, false, true)
	inside := orbitCLIInstructions(exe, true, true)
	if open == inside {
		t.Fatal("a session inside recorded work receives the same project paragraph as a free conversation")
	}
	for _, shared := range []string{"durable record", "returned its id", "orbit-session:<id>", "capabilities --json", "mcp__orbit__*"} {
		if !strings.Contains(open, shared) || !strings.Contains(inside, shared) {
			t.Errorf("both forms must keep %q", shared)
		}
	}
	for _, want := range []string{
		"you may propose recording it as an Orbit Project",
		"4 or more steps that depend on one another",
	} {
		if !strings.Contains(open, want) {
			t.Errorf("open form does not contain %q", want)
		}
		if strings.Contains(inside, want) {
			t.Errorf("a session inside recorded work is still offered %q", want)
		}
	}
	for _, want := range []string{
		"file it as a task",
		"lands under the same project this one belongs to",
		// The proposal is not withheld from a task session any more; what the form carries is the
		// default it trades away and the thing agreeing costs — this conversation becomes the new
		// project's coordinator.
		"you may put it in front of them",
		"this conversation becomes that project's coordinator",
	} {
		if !strings.Contains(inside, want) {
			t.Errorf("task form does not contain %q", want)
		}
		if strings.Contains(open, want) {
			t.Errorf("free conversation is told %q", want)
		}
	}
	// The one clause neither form may drop: nothing is created without the user's yes, in either shape.
	for _, form := range []string{open, inside} {
		if !strings.Contains(form, "writes nothing until they confirm it") {
			t.Errorf("form does not keep the confirm-first rule: %q", form)
		}
	}
}

// advertisedCapabilityFamilies is every family `orbit capabilities` composes, paired with whether
// the document offers that family only where the orchestration grant exists. buildCLICapabilities
// appends sessionCLICapabilities and agentCLICapabilities inside its includeOrchestration branch and
// every other family outside it, so a rule for an orchestration verb is needed exactly where that
// verb is advertised — a non-orchestrator never reads those two families at all. watchCLICapabilities
// is SessionOnly rather than gated: its rules are harmless in a session that cannot make a watch, and
// the session told to wait on Orbit's own work is the reader they exist for.
//
// The list is deliberately the same one cli_mcp_parity_test.go and cli_help_flag_coverage_test.go
// walk. Those two ask different questions of it (does every MCP tool have a command; does every
// argument have help text) and cannot carry the gate, but a family added to `capabilities` and
// forgotten in all three is what every one of them is here to catch.
var advertisedCapabilityFamilies = []struct {
	name              string
	specs             []cliCapabilitySpec
	orchestrationOnly bool
}{
	{"baseCLICapabilities", baseCLICapabilities, false},
	{"providerCLICapabilities", providerCLICapabilities, false},
	{"projectCLICapabilities", projectCLICapabilities, false},
	{"notifyCLICapabilities", notifyCLICapabilities, false},
	{"mergeReceiptCLICapabilities", mergeReceiptCLICapabilities, false},
	{"watchCLICapabilities", watchCLICapabilities, false},
	// Ungated like the watch commands and SessionOnly for the same kind of reason: a wiki command
	// acts for the session it runs in, and needs no power over anybody else's session to do it.
	{"wikiCLICapabilities", wikiCLICapabilities, false},
	{"sessionCLICapabilities", sessionCLICapabilities, true},
	{"agentCLICapabilities", agentCLICapabilities, true},
}

// This is the contract orbitCLIAllowedTools states about itself, asserted rather than trusted: "An
// action missing here is pre-approved for nobody: the agent hits a permission prompt for a command
// `capabilities --json` just told it to run." The allowlist is a hand-written enumeration, so it
// drifts the moment a verb is added to a family and not to it — project_get's four siblings went
// unnoticed, and `agent` was advertised to every orchestrator with no rule at all.
//
// It walks the spec tables themselves rather than a copy of them: a new capability is covered the
// moment it is declared, and the failure names the family and the exact rule that is missing.
//
// Every advertised capability is pre-approved, with no table of exceptions: the one entry that ever
// needed one — session_import, offered in the single context it refuses to run in — was drift in the
// ADVERTISEMENT rather than in the allowlist, so it was fixed there (HeadlessOnly) instead of being
// written down here. A capability withheld from a running agent needs no rule, and inventing one
// would only hide the next advertisement that reaches the wrong reader.
//
// One direction only, deliberately: the watch and await rules are emitted whether or not watches are
// on, so this list is a superset of the document in that one dimension. Over-approving costs a rule
// nobody can use; under-approving costs the prompt this test exists to remove.
func TestEveryAdvertisedCapabilityIsPreApproved(t *testing.T) {
	exe := "/usr/local/bin/orbit"
	// The path the document rewrites argv[0] to, and a shellWordSafe one, so the unquoted rule is
	// the form that matches the argv an agent copies out of `capabilities --json`.
	ungated := stringSet(orbitCLIAllowedTools(exe, false))
	orchestrated := stringSet(orbitCLIAllowedTools(exe, true))

	missing := []string{}
	for _, family := range advertisedCapabilityFamilies {
		if len(family.specs) == 0 {
			t.Errorf("%s advertises nothing; an empty family passes this test vacuously", family.name)
		}
		for _, spec := range family.specs {
			if spec.HeadlessOnly {
				// A human terminal door: the document withholds it from a running agent
				// (buildCLICapabilities drops it when a session is acting), so there is no reader
				// to pre-approve it for.
				continue
			}
			if len(spec.Argv) < 2 || spec.Argv[0] != "orbit" {
				t.Fatalf("%s %s argv = %#v: a capability argv is `orbit <verb...>`, and the rule is its tail",
					family.name, spec.Tool, spec.Argv)
			}
			rule := "Bash(" + exe + " " + strings.Join(spec.Argv[1:], " ") + " *)"
			// Where the document offers the capability decides which list has to carry it: demanding
			// an orchestration verb of a non-orchestrator would ask for a rule for a command that
			// agent cannot see, and the session rules' whole point is that they are not there.
			gated := family.orchestrationOnly || spec.RequiresOrchestration
			rules := ungated
			if gated {
				rules = orchestrated
				if ungated[rule] {
					t.Errorf("%s rides the orchestration gate but is pre-approved without the grant: %s", spec.Tool, rule)
				}
			}
			if !rules[rule] {
				missing = append(missing, family.name+" "+spec.Tool+": "+rule)
			}
		}
	}
	if len(missing) > 0 {
		t.Fatalf("%d advertised capabilities are pre-approved for nobody, so an agent that runs one hits a "+
			"permission prompt for a command `capabilities --json` just told it to run:\n  %s",
			len(missing), strings.Join(missing, "\n  "))
	}
}

// The wiring, not the copy: the form a session gets is decided by whether it was dispatched for a
// task, and it has to survive the trip through the spawn arguments the engine is actually given.
func TestClaudeInstructionArgsFollowTheSessionShape(t *testing.T) {
	exe := "/usr/local/bin/orbit"
	if (&ClaimedSession{}).insideRecordedWork() {
		t.Error("a free conversation reads as inside recorded work")
	}
	if !(&ClaimedSession{TaskID: "task-1"}).insideRecordedWork() {
		t.Error("a session dispatched for a task does not read as inside recorded work")
	}
	appendPromptFor := func(job *ClaimedSession) string {
		args := appendClaudeAgentInstructionArgs(nil, AgentExecConfig{}, exe, false, job.insideRecordedWork(), true)
		for i, arg := range args {
			if arg == "--append-system-prompt" && i+1 < len(args) {
				return args[i+1]
			}
		}
		t.Fatalf("no --append-system-prompt in %v", args)
		return ""
	}
	if got := appendPromptFor(&ClaimedSession{}); !strings.Contains(got, "you may propose recording it") {
		t.Errorf("free conversation did not get the open form: %q", got)
	}
	if got := appendPromptFor(&ClaimedSession{TaskID: "task-1"}); !strings.Contains(got, "file it as a task") {
		t.Errorf("task session did not get the task form: %q", got)
	}
}
