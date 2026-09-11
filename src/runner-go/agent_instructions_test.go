package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestWithOrbitCLIInstructions(t *testing.T) {
	exe := "/opt/orbit runner/bin/orbit"
	orbit := orbitCLIInstructions(exe, false)
	if got := withOrbitCLIInstructions("", exe, false); got != orbit {
		t.Fatalf("empty configured instructions = %q", got)
	}

	got := withOrbitCLIInstructions("Owner instructions.\n", exe, false)
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
		"Do not stop and wait for the answer",
		"do not propose the same body of work twice",
		// The one clause that did NOT soften: a project is created by a yes, never by the
		// model deciding the shape qualifies. Raising the bar changes when it asks, not
		// whether it may act alone.
		"never call project_create without one",
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
	}, exe, false, false)
	wantAllowed := append([]string{"Read", "mcp__orbit__*"}, orbitCLIAllowedTools(exe, false)...)
	want := []string{
		"-p",
		"--system-prompt", "Base agent instructions.",
		"--append-system-prompt", "Owner append instructions.\n\n" + orbitCLIInstructions(exe, false),
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
	if got := appendClaudeAgentInstructionArgs([]string{"-p"}, agent, "", false, false); !reflect.DeepEqual(got, want) {
		t.Fatalf("missing executable args = %#v, want %#v", got, want)
	}
	if got := withOrbitCLIInstructions("Owner instructions.", "", false); got != "Owner instructions." {
		t.Fatalf("missing executable instructions = %q", got)
	}
	if got := appendClaudeAgentInstructionArgs([]string{"-p"}, AgentExecConfig{}, "", false, false); !reflect.DeepEqual(got, []string{"-p"}) {
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
	if got := orbitCLIInstructions("/tmp/or`bit", false); got != "" {
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
	if strings.Contains(base, " session ") {
		t.Fatalf("non-orchestrator gained session CLI rules: %q", base)
	}
	enabled := strings.Join(orbitCLIAllowedTools(exe, true), "\n")
	for _, action := range []string{"create", "list", "search", "get", "send", "interrupt", "merge", "end", "complete", "delete"} {
		if !strings.Contains(enabled, "Bash("+exe+" session "+action+" *)") {
			t.Errorf("orchestrator missing session %s rule in %q", action, enabled)
		}
	}
}

// The two forms of the project paragraph, and the fact that ONLY that paragraph differs: a task
// session must still be told what an Orbit task is for and which tool writes one. Asserted in both
// directions, because the whole point of the split is what each form withholds — a task form that
// still offered the proposal, or an open form that had lost it, would each pass a one-sided check.
func TestOrbitProjectInstructionsDifferInsideRecordedWork(t *testing.T) {
	exe := "/usr/local/bin/orbit"
	open := orbitCLIInstructions(exe, false)
	inside := orbitCLIInstructions(exe, true)
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
		"Do not propose recording it as an Orbit Project from here",
	} {
		if !strings.Contains(inside, want) {
			t.Errorf("task form does not contain %q", want)
		}
		if strings.Contains(open, want) {
			t.Errorf("free conversation is told %q", want)
		}
	}
	// The one clause neither form may drop: a project is created by a yes, in either shape.
	for _, form := range []string{open, inside} {
		if !strings.Contains(form, "never call project_create without one") {
			t.Errorf("form does not keep the explicit-yes rule: %q", form)
		}
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
		args := appendClaudeAgentInstructionArgs(nil, AgentExecConfig{}, exe, false, job.insideRecordedWork())
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
	if got := appendPromptFor(&ClaimedSession{TaskID: "task-1"}); !strings.Contains(got, "Do not propose recording it") {
		t.Errorf("task session did not get the task form: %q", got)
	}
}
