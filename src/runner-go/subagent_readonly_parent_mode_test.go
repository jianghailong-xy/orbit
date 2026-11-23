package main

import (
	"testing"
)

// readonlyChildOf is a read-only SubAgent's child claim on engine, of a parent whose live mode is mode.
func readonlyChildOf(engine, mode string) *ClaimedSession {
	parent := &ClaimedSession{SessionID: "parent", Agent: AgentExecConfig{PermissionMode: "default"}, liveMode: &sessionLiveMode{mode: mode}}
	return subagentChildJob(parent, AgentExecConfig{Provider: engine, PermissionMode: mode}, subagentDefinition{Name: "explore", Readonly: true}, "run1", engine, "")
}

// A read-only SubAgent on any engine but Claude has what it asks answered by the parent's mode: Auto and Bypass allow,
// Don't Ask refuses, every other mode leaves the card to the engine. Its edits are refused under every mode, under
// any engine's spelling of the tool. A Claude child, a child that is not read-only and a session are never answered.
func TestReadonlySubagentAnswersByTheParentsMode(t *testing.T) {
	for _, engine := range []string{providerKimi, providerCursor, providerDsh, providerOpenCode, providerAntigravity, providerCodex} {
		for mode, want := range map[string][2]bool{
			"auto": {true, true}, "bypassPermissions": {true, true}, "dontAsk": {false, true},
			"default": {false, false}, "acceptEdits": {false, false}, "plan": {false, false},
		} {
			child := readonlyChildOf(engine, mode)
			for _, tool := range []string{"Bash", "Terminal", "bash", "WebFetch", "mcp__docs__search"} {
				if allowed, decided := readonlySubagentAnswer(child, tool); allowed != want[0] || decided != want[1] {
					t.Errorf("%s under a %s parent, %s = %t, %t; want %t, %t", engine, mode, tool, allowed, decided, want[0], want[1])
				}
			}
			for _, edit := range []string{"Edit", "Write", "MultiEdit", "NotebookEdit", "write", "edit"} {
				if !readonlySubagentRefusesEdit(child, edit) {
					t.Errorf("%s under a %s parent: %s is not refused", engine, mode, edit)
				}
				if _, decided := readonlySubagentAnswer(child, edit); decided {
					t.Errorf("%s under a %s parent: %s was answered by the parent's mode", engine, mode, edit)
				}
			}
		}
	}
	claude := readonlyChildOf(providerClaude, "auto")
	general := subagentChildJob(&ClaimedSession{Agent: AgentExecConfig{PermissionMode: "auto"}}, AgentExecConfig{Provider: providerKimi, PermissionMode: "auto"},
		subagentDefinition{Name: "general"}, "run2", providerKimi, "")
	session := &ClaimedSession{Agent: AgentExecConfig{PermissionMode: "plan"}}
	for name, job := range map[string]*ClaimedSession{"claude": claude, "general": general, "session": session, "nil": nil} {
		if _, decided := readonlySubagentAnswer(job, "Bash"); decided || readonlySubagentRefusesEdit(job, "Edit") {
			t.Errorf("%s: answered by a parent's mode", name)
		}
	}
}

// A remote SubAgent's target runner reads the parent's mode from the claim, not the child's own: what the 2026-11-23
// screenshot showed was a read-only child claimed in plan whose parent ran Auto, every shell call a card. The child's
// Plan gate reads the same mode. A server that names none leaves the child's own mode in its place.
func TestRemoteSubagentAnswersByTheParentsModeFromTheClaim(t *testing.T) {
	claim := remoteSubagentClaim{SessionID: "parent", Exec: AgentExecConfig{Provider: providerKimi, PermissionMode: "auto"},
		ParentPermissionMode: "auto"}
	childExec, parent := remoteSubagentParent(claim, "/w")
	child := subagentChildJob(parent, childExec, subagentDefinition{Name: "explore", Readonly: true}, "run1", providerKimi, "")
	if allowed, decided := readonlySubagentAnswer(child, "Bash"); !allowed || !decided {
		t.Fatalf("Bash under an Auto parent = %t, %t; want allowed without a card", allowed, decided)
	}
	if childExec.Env[envSubagentRemoteMode] != "auto" || childExec.PermissionMode != "auto" {
		t.Fatalf("child exec = %+v", childExec)
	}

	claim.ParentPermissionMode = "default"
	childExec, parent = remoteSubagentParent(claim, "/w")
	child = subagentChildJob(parent, childExec, subagentDefinition{Name: "explore", Readonly: true}, "run1", providerKimi, "")
	if _, decided := readonlySubagentAnswer(child, "Bash"); decided {
		t.Fatal("Bash under a Default parent was answered; want a card")
	}
	if childExec.Env[envSubagentRemoteMode] != "default" || childExec.PermissionMode != "auto" || parent.Agent.PermissionMode != "default" {
		t.Fatalf("the Plan gate or the child's mode is wrong: exec %+v, parent %q", childExec, parent.Agent.PermissionMode)
	}

	claim.ParentPermissionMode = ""
	claim.Exec.PermissionMode = "dontAsk"
	childExec, parent = remoteSubagentParent(claim, "/w")
	if parent.Agent.PermissionMode != "dontAsk" || childExec.Env[envSubagentRemoteMode] != "dontAsk" {
		t.Fatalf("with no parent mode named, the child's own must stand in: parent %q", parent.Agent.PermissionMode)
	}
}

// OpenCode answers nothing while it runs, so a read-only child is set up from the parent's mode once: under Auto it runs
// unguarded with edits and its own subagents denied; under Default it keeps plan, whose shell calls are refused.
func TestOpenCodeReadonlySubagentFollowsTheParentsMode(t *testing.T) {
	auto := readonlyChildOf(providerOpenCode, "auto")
	openCodeReadonlyFollowsParent(auto)
	permission := map[string]interface{}{}
	applyOpenCodePermissions(permission, auto.Agent, nil)
	if auto.Agent.PermissionMode != "auto" || permission["*"] != "allow" || permission["edit"] != "deny" || permission["task"] != "deny" {
		t.Fatalf("under an Auto parent: mode %q, permission %v", auto.Agent.PermissionMode, permission)
	}

	def := readonlyChildOf(providerOpenCode, "default")
	openCodeReadonlyFollowsParent(def)
	permission = map[string]interface{}{}
	applyOpenCodePermissions(permission, def.Agent, nil)
	if def.Agent.PermissionMode != "plan" || permission["bash"] != "ask" || permission["edit"] != "deny" {
		t.Fatalf("under a Default parent: mode %q, permission %v", def.Agent.PermissionMode, permission)
	}
}

// agy's plan mode refuses every command, so a read-only child runs under the approval hook: its writes refused
// (agy's own artifacts excepted), and the rest answered by the parent's mode.
func TestAntigravityReadonlySubagentFollowsTheParentsMode(t *testing.T) {
	w := newAgyPolicyWorld(t)
	command := map[string]interface{}{"CommandLine": "git log -1", "Cwd": w.work}
	write := map[string]interface{}{"TargetFile": w.work + "/new.go", "CodeContent": "x"}
	artifact := map[string]interface{}{"TargetFile": w.artifacts + "/plan.md", "CodeContent": "x"}
	for parent, want := range map[string]string{"auto": "allow", "bypassPermissions": "allow", "dontAsk": "deny", "default": "ask", "plan": "ask"} {
		policy := w.policy("default")
		policy.ReadonlyParentMode = parent
		if got := decideAntigravityToolCall(policy, w.call("run_command", command)); got.decision != want {
			t.Errorf("a command under a %s parent: %s %q, want %s", parent, got.decision, got.reason, want)
		}
		if got := decideAntigravityToolCall(policy, w.call("write_to_file", write)); got.decision != "deny" {
			t.Errorf("a workspace write under a %s parent: %s, want deny", parent, got.decision)
		}
		if got := decideAntigravityToolCall(policy, w.call("write_to_file", artifact)); got.decision != "allow" {
			t.Errorf("agy's own artifact under a %s parent: %s, want allow", parent, got.decision)
		}
	}
	child := readonlyChildOf(providerAntigravity, "auto")
	if !child.readonlySubagent || child.readonlyParentMode() != "auto" {
		t.Fatal("the child does not carry its parent's mode")
	}
}

// Cursor's plan mode refuses every request: a read-only child's shell call is allowed under an Auto parent, refused
// under Don't Ask, and put on the card under Default, as the parent's own would be.
func TestCursorReadonlySubagentFollowsTheParentsMode(t *testing.T) {
	shell := map[string]interface{}{"toolCallId": "c1", "title": "`git log -1`", "kind": "execute", "status": "pending"}
	for parent, want := range map[string]struct {
		answer string
		cards  int
	}{"auto": {cursorAllowOnce, 0}, "dontAsk": {cursorRejectOnce, 0}, "default": {cursorAllowOnce, 1}} {
		rig := newCursorBridgeRig("plan", nil)
		rig.bridge.subagent = readonlyChildOf(providerCursor, parent)
		if err := rig.mapper.begin("turn"); err != nil {
			t.Fatal(err)
		}
		rig.bridge.begin("turn")
		rig.bridge.permission(1, cursorPermissionParams(shell))
		got := rig.answered("1")
		if len(got) != 1 || got[0] != want.answer || len(rig.cards) != want.cards {
			t.Errorf("under a %s parent: answered %q with cards %q; want %s and %d card(s)", parent, got, rig.cards, want.answer, want.cards)
		}
	}
	// A plan-mode session is no SubAgent: still refused unasked.
	rig := newCursorBridgeRig("plan", nil)
	_ = rig.mapper.begin("turn")
	rig.bridge.begin("turn")
	rig.bridge.permission(1, cursorPermissionParams(shell))
	if got := rig.answered("1"); len(got) != 1 || got[0] != cursorRejectOnce || len(rig.cards) != 0 {
		t.Fatalf("a plan-mode session: answered %q with cards %q", got, rig.cards)
	}
}

// DSH runs a read-only child under its read-only file policy (Default); each escalation is answered by the parent's
// mode, and an escalated write is refused whatever the parent runs.
func TestDshReadonlySubagentFollowsTheParentsMode(t *testing.T) {
	policy, _ := dshPermissionPolicyFor("default")
	bash := dshPermissionAsk{TurnID: "t1", ToolCallID: "call-bash", Name: "bash",
		Input: map[string]interface{}{"command": "docker logs api", "sandbox_permissions": "require_escalated"}}
	for parent, want := range map[string]string{"auto": dshAllowOnce, "dontAsk": dshRejectOnce, "default": "asked"} {
		p, b := newDshBridgeProbe(policy)
		p.calls["call-bash"] = bash
		b.subagent = readonlyChildOf(providerDsh, parent)
		b.begin()
		b.request("perm-1", dshPermissionParams("call-bash"))
		if want == "asked" {
			if asked := <-p.asked; asked.Name != "bash" {
				t.Fatalf("under a %s parent the card was for %+v", parent, asked)
			}
			p.answer <- dshAllowOnce
			p.waitReplies(t, 1)
		} else if replies := p.waitReplies(t, 1); outcomeOf(replies[0]) != want || len(p.asked) != 0 {
			t.Errorf("under a %s parent: %+v, want %s with no card", parent, replies, want)
		}
		b.request("perm-2", dshPermissionParams("call-write"))
		if replies := p.waitReplies(t, 2); outcomeOf(replies[1]) != dshRejectOnce {
			t.Errorf("an escalated write under a %s parent: %+v, want refused", parent, replies[1])
		}
		b.close()
		b.wait()
	}
}
