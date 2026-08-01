package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestWithOrbitCLIInstructions(t *testing.T) {
	exe := "/opt/orbit runner/bin/orbit"
	orbit := orbitCLIInstructions(exe)
	if got := withOrbitCLIInstructions("", exe); got != orbit {
		t.Fatalf("empty configured instructions = %q", got)
	}

	got := withOrbitCLIInstructions("Owner instructions.\n", exe)
	want := "Owner instructions.\n\n" + orbit
	if got != want {
		t.Fatalf("merged instructions = %q, want %q", got, want)
	}
	for _, phrase := range []string{
		"'/opt/orbit runner/bin/orbit' capabilities --json",
		"mcp__orbit__*",
		"Use `--json` output",
		" mcp` directly",
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
	}, exe, false)
	wantAllowed := append([]string{"Read", "mcp__orbit__*"}, orbitCLIAllowedTools(exe, false)...)
	want := []string{
		"-p",
		"--system-prompt", "Base agent instructions.",
		"--append-system-prompt", "Owner append instructions.\n\n" + orbitCLIInstructions(exe),
		"--allowedTools", strings.Join(wantAllowed, ","),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Claude instruction args = %#v, want %#v", got, want)
	}
	joined := strings.Join(got, "\n")
	for _, required := range []string{
		"Bash('/usr/local/bin/orbit' task list *)",
		"Bash(/usr/local/bin/orbit task list *)",
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
	if got := appendClaudeAgentInstructionArgs([]string{"-p"}, agent, "", false); !reflect.DeepEqual(got, want) {
		t.Fatalf("missing executable args = %#v, want %#v", got, want)
	}
	if got := withOrbitCLIInstructions("Owner instructions.", ""); got != "Owner instructions." {
		t.Fatalf("missing executable instructions = %q", got)
	}
	if got := appendClaudeAgentInstructionArgs([]string{"-p"}, AgentExecConfig{}, "", false); !reflect.DeepEqual(got, []string{"-p"}) {
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
	if got := orbitCLIInstructions("/tmp/or`bit"); got != "" {
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
	for _, action := range []string{"create", "list", "search", "get", "send", "interrupt", "merge", "end"} {
		if !strings.Contains(enabled, "Bash("+exe+" session "+action+" *)") {
			t.Errorf("orchestrator missing session %s rule in %q", action, enabled)
		}
	}
}
