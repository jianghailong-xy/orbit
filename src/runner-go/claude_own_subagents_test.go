package main

import (
	"strings"
	"testing"
)

// D1: Claude Code's own sub-agent tool is off where Orbit's delegate is served, and only there.
func TestClaudeOwnSubAgentToolIsDisallowedWhereDelegateIsServed(t *testing.T) {
	denied := func(job *ClaimedSession) []string {
		args := claudeCommandArgs(job, t.TempDir(), true)
		value, _ := argAfter(args, "--disallowedTools")
		return strings.Split(value, ",")
	}
	has := func(rules []string, want string) bool {
		for _, r := range rules {
			if r == want {
				return true
			}
		}
		return false
	}
	exec := AgentExecConfig{Model: "claude-sonnet-5-5", PermissionMode: "default"}
	top := denied(&ClaimedSession{SessionID: "s1", Provider: providerClaude, Agent: exec})
	for _, want := range append([]string{"TodoWrite"}, builtinSubAgentTools...) {
		if !has(top, want) {
			t.Errorf("a top-level session does not disallow %s: %v", want, top)
		}
	}
	task := denied(&ClaimedSession{SessionID: "s2", TaskID: "t1", Provider: providerClaude, Agent: exec})
	if !has(task, "Agent") {
		t.Errorf("a task run does not disallow Agent: %v", task)
	}
	subExec := exec
	subExec.Env = map[string]string{envSubagentRunID: "run1"}
	sub := denied(&ClaimedSession{SessionID: "s3", Provider: providerClaude, Agent: subExec})
	for _, kept := range builtinSubAgentTools {
		if has(sub, kept) {
			t.Errorf("a SubAgent, which is not served delegate, has %s disallowed: %v", kept, sub)
		}
	}
	if !has(sub, "TodoWrite") {
		t.Errorf("a SubAgent lost the todo family's denial: %v", sub)
	}
}

func TestHandoffUnitSaysNeverUseOwnSubAgentsOnlyWhereTheyAreNotTurnedOff(t *testing.T) {
	const clause = "never your engine's own sub-agents"
	for _, profile := range engineProfiles {
		got := renderInstructionUnit(orbitHandoffInstructions, SessionShape{}, profile)
		if has := strings.Contains(got, clause); has == profile.OwnSubAgentsOff {
			t.Errorf("%s: says %q = %v with the tool turned off = %v", profile.Engine, clause, has, profile.OwnSubAgentsOff)
		}
		if !strings.HasPrefix(got, "Hand work to another agent through Orbit") || !strings.Contains(got, ". Look with task_list first:") {
			t.Errorf("%s: the paragraph's shape broke: %s", profile.Engine, got)
		}
	}
	if !strings.Contains(renderInstructionUnit(orbitHandoffInstructions, SessionShape{}, unknownEngineProfile), clause) {
		t.Error("a bare `orbit mcp`, which cannot tell its engine, keeps the rule")
	}
}
