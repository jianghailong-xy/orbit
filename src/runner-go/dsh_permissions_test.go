package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestDshPermissionPolicy(t *testing.T) {
	t.Run("supported-modes", func(t *testing.T) {
		for mode, want := range map[string]dshPermissionPolicy{
			"default": {FileMode: "read-only", Ask: true},
			"dontAsk": {FileMode: "read-only"},
			"auto":    {FileMode: "workspace-write", Ask: true, ThirdPartyMCP: true, RoutineEscalations: true},
			"":        {FileMode: "workspace-write", Ask: true, ThirdPartyMCP: true, RoutineEscalations: true},
		} {
			if got, err := dshPermissionPolicyFor(mode); err != nil || got != want {
				t.Fatalf("%q -> %+v, %v; want %+v", mode, got, err, want)
			}
		}
	})
	t.Run("unsupported-modes-refused-before-launch", func(t *testing.T) {
		for _, mode := range []string{"plan", "acceptEdits", "bypassPermissions", "unknown"} {
			if _, err := dshPermissionPolicyFor(mode); err == nil || !strings.Contains(err.Error(), "DSH_PERMISSION_UNSUPPORTED") {
				t.Fatalf("%s must be refused: %v", mode, err)
			}
			if dshFileModeForPermission(mode) != "" {
				t.Fatalf("%s must have no file policy", mode)
			}
			h := newDshRealHarness(t, mode, false)
			status, ended := h.runToEnd()
			if status != stFailed || !ended || h.launched() || h.model.count() != 0 || !h.hasError("DSH_PERMISSION_UNSUPPORTED") {
				t.Fatalf("%s session = %s ended=%v launched=%v", mode, status, ended, h.launched())
			}
		}
	})
}

type dshBridgeProbe struct {
	mu      sync.Mutex
	replies []map[string]interface{}
	events  dshProcessEvents
	asked   chan dshPermissionAsk
	answer  chan string
	policy  dshPermissionPolicy
	calls   map[string]dshPermissionAsk
}

func newDshBridgeProbe(policy dshPermissionPolicy) (*dshBridgeProbe, *dshPermissionBridge) {
	p := &dshBridgeProbe{asked: make(chan dshPermissionAsk, 4), answer: make(chan string, 4), policy: policy,
		calls: map[string]dshPermissionAsk{"call-write": {TurnID: "t1", ToolCallID: "call-write", Name: "write",
			Input: map[string]interface{}{"file_path": "/w/a.txt", "sandbox_permissions": "workspace-write"}}}}
	b := newDshPermissionBridge(func() dshPermissionPolicy { return p.policy }, func(id string) (dshPermissionAsk, bool) {
		call, ok := p.calls[id]
		return call, ok
	}, func(ctx context.Context, ask dshPermissionAsk) string {
		p.asked <- ask
		select {
		case option := <-p.answer:
			return option
		case <-ctx.Done():
			// The person may still answer after the stop; the bridge must not pass it on.
			return <-p.answer
		}
	}, p.events.emit)
	b.reply = func(id interface{}, outcome map[string]interface{}) error {
		p.mu.Lock()
		defer p.mu.Unlock()
		p.replies = append(p.replies, map[string]interface{}{"id": id, "outcome": outcome})
		return nil
	}
	return p, b
}

func (p *dshBridgeProbe) waitReplies(t *testing.T, n int) []map[string]interface{} {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		p.mu.Lock()
		got := append([]map[string]interface{}(nil), p.replies...)
		p.mu.Unlock()
		if len(got) >= n {
			return got
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("expected %d replies", n)
	return nil
}

func dshPermissionParams(callID string) map[string]interface{} {
	return map[string]interface{}{"sessionId": "rt", "toolCall": map[string]interface{}{"toolCallId": callID},
		"options": []interface{}{map[string]interface{}{"optionId": "allow-once", "kind": "allow_once"}, map[string]interface{}{"optionId": "reject-once", "kind": "reject_once"}}}
}

func outcomeOf(reply map[string]interface{}) string {
	outcome := mapValue(reply["outcome"])
	if id := firstString(outcome, "optionId"); id != "" {
		return id
	}
	return firstString(outcome, "outcome")
}

func TestDshPermissionBridge(t *testing.T) {
	ask, _ := dshPermissionPolicyFor("default")
	t.Run("allow-once-joins-the-bare-tool-call-id", func(t *testing.T) {
		p, b := newDshBridgeProbe(ask)
		b.begin()
		b.request("perm-1", dshPermissionParams("call-write"))
		asked := <-p.asked
		if asked.Name != "write" || mapValue(asked.Input)["file_path"] != "/w/a.txt" {
			t.Fatalf("the card must show the tool the id names: %+v", asked)
		}
		p.answer <- dshAllowOnce
		if replies := p.waitReplies(t, 1); replies[0]["id"] != "perm-1" || outcomeOf(replies[0]) != dshAllowOnce {
			t.Fatalf("replies = %+v", replies)
		}
		b.wait()
	})
	t.Run("reject", func(t *testing.T) {
		p, b := newDshBridgeProbe(ask)
		b.begin()
		b.request("perm-1", dshPermissionParams("call-write"))
		<-p.asked
		p.answer <- dshRejectOnce
		if replies := p.waitReplies(t, 1); outcomeOf(replies[0]) != dshRejectOnce {
			t.Fatalf("replies = %+v", replies)
		}
		b.wait()
	})
	t.Run("late-allow-after-stop-is-never-sent", func(t *testing.T) {
		p, b := newDshBridgeProbe(ask)
		b.begin()
		b.request("perm-1", dshPermissionParams("call-write"))
		<-p.asked
		b.close() // Stop, settlement or transport loss while the card is open
		p.answer <- dshAllowOnce
		b.wait()
		replies := p.waitReplies(t, 1)
		if len(replies) != 1 || outcomeOf(replies[0]) != "cancelled" {
			t.Fatalf("a late allow must answer cancelled exactly once: %+v", replies)
		}
	})
	t.Run("closed-bridge-cancels-without-asking", func(t *testing.T) {
		p, b := newDshBridgeProbe(ask)
		b.request("perm-1", dshPermissionParams("call-write"))
		if replies := p.waitReplies(t, 1); outcomeOf(replies[0]) != "cancelled" || len(p.asked) != 0 {
			t.Fatalf("replies = %+v", replies)
		}
	})
	t.Run("unknown-tool-call-is-rejected", func(t *testing.T) {
		p, b := newDshBridgeProbe(ask)
		b.begin()
		b.request("perm-1", dshPermissionParams("never-announced"))
		replies := p.waitReplies(t, 1)
		events := p.events.snapshot()
		if outcomeOf(replies[0]) != dshRejectOnce || len(p.asked) != 0 || len(events) != 1 || events[0].payload["subtype"] != "permission_denied" {
			t.Fatalf("an approval for an unseen call must be rejected visibly: %+v %+v", replies, events)
		}
	})
	t.Run("dont-ask-rejects-unasked", func(t *testing.T) {
		policy, _ := dshPermissionPolicyFor("dontAsk")
		p, b := newDshBridgeProbe(policy)
		b.begin()
		b.request("perm-1", dshPermissionParams("call-write"))
		replies := p.waitReplies(t, 1)
		if outcomeOf(replies[0]) != dshRejectOnce || len(p.asked) != 0 || len(p.events.snapshot()) != 1 {
			t.Fatalf("Don't Ask must reject without a card: %+v", replies)
		}
	})
	t.Run("unknown-options-never-default-to-allow", func(t *testing.T) {
		p, b := newDshBridgeProbe(ask)
		b.begin()
		params := dshPermissionParams("call-write")
		params["options"] = []interface{}{map[string]interface{}{"optionId": "allow-always"}}
		b.request("perm-1", params)
		if replies := p.waitReplies(t, 1); outcomeOf(replies[0]) != "cancelled" || len(p.asked) != 0 {
			t.Fatalf("replies = %+v", replies)
		}
	})
	commit := dshPermissionAsk{TurnID: "t1", ToolCallID: "call-commit", Name: "bash", Input: map[string]interface{}{
		"command": "git add -A && git commit -q -m 'session work'", "sandbox_permissions": "danger-full-access",
		"justification": "the worktree's index lives in the main repository's .git"}}
	push := dshPermissionAsk{TurnID: "t1", ToolCallID: "call-push", Name: "bash", Input: map[string]interface{}{
		"command": "git push origin HEAD", "sandbox_permissions": "danger-full-access", "justification": "publish"}}
	auto, _ := dshPermissionPolicyFor("auto")
	t.Run("auto-allows-a-routine-escalation-without-a-card", func(t *testing.T) {
		p, b := newDshBridgeProbe(auto)
		p.calls["call-commit"] = commit
		b.workspace = "/w"
		b.begin()
		b.request("perm-1", dshPermissionParams("call-commit"))
		replies := p.waitReplies(t, 1)
		events := p.events.snapshot()
		if outcomeOf(replies[0]) != dshAllowOnce || len(p.asked) != 0 || len(events) != 1 || events[0].payload["subtype"] != "permission_auto_allowed" {
			t.Fatalf("a routine escalation must be allowed once, visibly, without a card: %+v %+v", replies, events)
		}
	})
	t.Run("auto-leaves-a-high-impact-escalation-to-a-person", func(t *testing.T) {
		p, b := newDshBridgeProbe(auto)
		p.calls["call-push"] = push
		b.workspace = "/w"
		b.begin()
		b.request("perm-1", dshPermissionParams("call-push"))
		if asked := <-p.asked; asked.ToolCallID != "call-push" {
			t.Fatalf("asked = %+v", asked)
		}
		p.answer <- dshRejectOnce
		if replies := p.waitReplies(t, 1); outcomeOf(replies[0]) != dshRejectOnce {
			t.Fatalf("replies = %+v", replies)
		}
		b.wait()
	})
	t.Run("default-never-allows-an-escalation-itself", func(t *testing.T) {
		p, b := newDshBridgeProbe(ask)
		p.calls["call-commit"] = commit
		b.workspace = "/w"
		b.begin()
		b.request("perm-1", dshPermissionParams("call-commit"))
		<-p.asked
		p.answer <- dshAllowOnce
		if replies := p.waitReplies(t, 1); outcomeOf(replies[0]) != dshAllowOnce {
			t.Fatalf("replies = %+v", replies)
		}
		b.wait()
	})
}

// TestDshAutoRoutineEscalation: which escalations Auto may allow without a person. The commands are
// shaped like the ones dsh task sessions escalated in an isolated worktree (2026-10-07/08).
func TestDshAutoRoutineEscalation(t *testing.T) {
	escalation := func(command, workdir string) dshPermissionAsk {
		input := map[string]interface{}{"command": command, "description": "probe", "sandbox_permissions": "danger-full-access", "justification": "probe"}
		if workdir != "" {
			input["workdir"] = workdir
		}
		return dshPermissionAsk{Name: "bash", Input: input}
	}
	for _, tc := range []struct {
		name, command, workdir string
		want                   bool
	}{
		{name: "commit", command: "git add -A && git commit -q -m 'session work'", want: true},
		{name: "commit in the workspace by absolute cd", command: "cd /w && git add -A && git commit -q -F - <<'EOF'\nfix(api): GET /admin/sign-in answers ~/.secret no more\n\nSee /root/orbit/.git/worktrees/x.\nEOF", want: true},
		{name: "message from command substitution", command: "git commit -q -m \"$(cat <<'MSG'\nfeat: one\nMSG\n)\" && git log --oneline -1", want: true},
		{name: "merge with workdir", command: "git merge origin/main --no-edit 2>&1 | tail -30; echo \"EXIT=${PIPESTATUS[0]}\"", workdir: "/w", want: true},
		{name: "amend", command: "git add -A && git commit -q --amend --no-edit && git status --short | head -3", want: true},
		{name: "build cache", command: "cd src/runner-go && go test -count=1 ./...", want: true},
		{name: "message file in tmp", command: "git commit -F /tmp/msg.txt > /dev/null", want: true},
		{name: "index file named by PWD", command: "GIT_INDEX_FILE=$PWD/.probe-index git read-tree HEAD", want: true},
		{name: "prose in a quoted message", command: "git add a.ts && git commit -q -m \"docs: the Gmail / Google Workspace limit, see ~/notes and ../x\n\nSpotted in \\\"5.2\\\".\" && git status --short", want: true},
		{name: "message that runs a command", command: "git commit -q -m \"$(cp out ~/.bashrc)\"", want: false},
		{name: "message flag of another program", command: "git commit -am x && install -m '/etc/x' out", want: false},
		{name: "not an escalation", command: "", want: false},
		{name: "push", command: "git push origin HEAD:refs/heads/probe", want: false},
		{name: "fetch", command: "git fetch origin main && git merge origin/main", want: false},
		{name: "install", command: "npm install && npm test", want: false},
		{name: "inline interpreter", command: "python3 -c 'import os' && git commit -am x", want: false},
		{name: "interpreter reads a here-document", command: "python3 - <<'PY'\nprint(1)\nPY", want: false},
		{name: "unterminated here-document", command: "git commit -F - <<'EOF'\nmessage", want: false},
		{name: "write into HOME", command: "git commit -am x && echo y >> ~/.bashrc", want: false},
		{name: "HOME variable", command: "git commit -am x && cp out \"$HOME/out\"", want: false},
		{name: "unknown variable path", command: "cat \"$D/secret\" > leak && git add leak", want: false},
		{name: "absolute path elsewhere", command: "git commit -am x && cp build/out /etc/motd", want: false},
		{name: "cd elsewhere", command: "cd /root/orbit && git commit -am x", want: false},
		{name: "dot-dot leaves", command: "cd .. && git commit -am x", want: false},
		{name: "bare cd", command: "cd && git status", want: false},
		{name: "git -C elsewhere", command: "git -C /root/orbit commit -am x", want: false},
		{name: "recursive delete", command: "rm -rf build && go test ./...", want: false},
		{name: "workdir elsewhere", command: "git status", workdir: "/etc", want: false},
		{name: "cluster change", command: "kubectl apply -f deploy.yaml", want: false},
		{name: "container", command: "docker compose up -d", want: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ask := escalation(tc.command, tc.workdir)
			if tc.command == "" {
				ask.Input = map[string]interface{}{"command": "git status"} // no sandbox_permissions
			}
			if got := dshAutoRoutineEscalation(ask, "/w"); got != tc.want {
				t.Fatalf("dshAutoRoutineEscalation(%q) = %v, want %v", tc.command, got, tc.want)
			}
		})
	}
	write := dshPermissionAsk{Name: "write", Input: map[string]interface{}{"file_path": "/w/a", "sandbox_permissions": "danger-full-access"}}
	if dshAutoRoutineEscalation(write, "/w") {
		t.Fatal("only shell commands are judged; a file tool's escalation names its target and asks")
	}
	if dshAutoRoutineEscalation(escalation("git commit -am x", ""), "") {
		t.Fatal("without a workspace nothing is routine")
	}
}

// TestDshPermissionCard: the card Orbit files names the tool, its arguments and its call id, and
// only ALLOWED allows; an unreadable card is no decision.
func TestDshPermissionCard(t *testing.T) {
	var mu sync.Mutex
	var bodies []map[string]interface{}
	status := "ALLOWED"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "POST" {
			var body map[string]interface{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			bodies = append(bodies, body)
			mu.Unlock()
			_, _ = w.Write([]byte(`{"id":"card-1","status":"PENDING"}`))
			return
		}
		if status == "GONE" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"id":"card-1","status":"` + status + `"}`))
	}))
	defer srv.Close()
	transport := NewTransport(srv.URL, "synthetic")
	ask := dshPermissionAsk{TurnID: "t1", ToolCallID: "call-1", Name: "bash", Input: map[string]interface{}{"command": "printf x > f"}}
	for want, decided := range map[string]string{"ALLOWED": dshAllowOnce, "DENIED": dshRejectOnce, "GONE": ""} {
		status = want
		if got := bridgeDshPermission(context.Background(), transport, "p4-session", ask); got != decided {
			t.Fatalf("%s -> %q, want %q", want, got, decided)
		}
	}
	if len(bodies) != 3 || bodies[0]["toolName"] != "bash" || bodies[0]["toolUseId"] != "call-1" || mapValue(bodies[0]["input"])["command"] != "printf x > f" {
		t.Fatalf("card bodies = %+v", bodies)
	}
}

func dshEscalatedWrite(path, content, mode string) dshPlan {
	return dshPlan{tool: "write", args: map[string]interface{}{"file_path": path, "content": content,
		"sandbox_permissions": mode, "justification": "P4 synthetic escalation"}}
}

func dshFileState(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return "absent"
	}
	return string(data)
}

// TestDshRealApprovalAllowOnce: in Default each escalation reaches a card showing the call dsh
// named only by id; an Allow lets that one operation through, and the next one asks again.
func TestDshRealApprovalAllowOnce(t *testing.T) {
	h := newDshRealHarness(t, "default", true)
	file, command := filepath.Join(h.work, "allowed.txt"), filepath.Join(h.work, "command.txt")
	h.model.plans = []dshPlan{
		dshEscalatedWrite(file, "P4 allowed write", "workspace-write"),
		{tool: "bash", args: map[string]interface{}{"command": "printf 'P4 allowed command' > command.txt", "description": "write via a command",
			"sandbox_permissions": "workspace-write", "justification": "P4 synthetic escalation"}},
		{text: "P4 allowed answer"},
	}
	h.start()
	h.send("t1", "message", "Write the file, then run the command.")
	card := h.waitCard(1)
	if card.Body["toolName"] != "write" || mapValue(card.Body["input"])["file_path"] != file || card.Body["toolUseId"] == "" {
		t.Fatalf("first card = %+v", card.Body)
	}
	if dshFileState(file) != "absent" {
		t.Fatal("nothing may be written before the decision")
	}
	h.cp.decide(card.ID, "ALLOWED")
	second := h.waitCard(2)
	if second.Body["toolName"] != "bash" || !strings.Contains(firstString(mapValue(second.Body["input"]), "command"), "command.txt") {
		t.Fatalf("an allow is once: the command must ask again: %+v", second.Body)
	}
	if dshFileState(file) != "P4 allowed write" || dshFileState(command) != "absent" {
		t.Fatalf("after one allow: file=%q command=%q", dshFileState(file), dshFileState(command))
	}
	h.cp.decide(second.ID, "ALLOWED")
	done := h.settled("t1")
	if done.Status != stSucceeded || dshFileState(command) != "P4 allowed command" {
		t.Fatalf("turn = %+v command=%q", done, dshFileState(command))
	}
	_, write := h.toolResult("t1", "write")
	_, bash := h.toolResult("t1", "bash")
	if write["status"] != "completed" || bash["status"] != "completed" {
		t.Fatalf("results = %+v / %+v", write, bash)
	}
	h.end()
	h.evidence(t.Name(), map[string]interface{}{"file": dshFileState(file), "command": dshFileState(command), "cards": 2})
}

// TestDshRealApprovalReject: a plain write is stopped by the read-only sandbox without a card; the
// escalation asks, Deny leaves nothing behind and the turn continues to its answer.
func TestDshRealApprovalReject(t *testing.T) {
	h := newDshRealHarness(t, "default", true)
	plain, denied := filepath.Join(h.work, "plain.txt"), filepath.Join(h.work, "denied.txt")
	h.model.plans = []dshPlan{
		{tool: "write", args: map[string]interface{}{"file_path": plain, "content": "P4 plain"}},
		dshEscalatedWrite(denied, "P4 denied write", "workspace-write"),
		{text: "P4 denied answer"},
	}
	h.start()
	h.send("t1", "message", "Try both writes.")
	card := h.waitCard(1)
	if mapValue(card.Body["input"])["file_path"] != denied {
		t.Fatalf("only the escalation asks: %+v", card.Body)
	}
	h.cp.decide(card.ID, "DENIED")
	done := h.settled("t1")
	if done.Status != stSucceeded || dshFileState(plain) != "absent" || dshFileState(denied) != "absent" {
		t.Fatalf("turn = %+v plain=%q denied=%q", done, dshFileState(plain), dshFileState(denied))
	}
	uses, results := h.tools("t1")
	failed := 0
	for id := range uses {
		if results[id]["status"] == "failed" {
			failed++
		}
	}
	if len(uses) != 2 || failed != 2 || len(h.cp.cards()) != 1 {
		t.Fatalf("both writes must fail, one card: uses=%d failed=%d cards=%d", len(uses), failed, len(h.cp.cards()))
	}
	h.end()
	h.evidence(t.Name(), map[string]interface{}{"plain": dshFileState(plain), "denied": dshFileState(denied)})
}

// TestDshRealApprovalStop: Stop while the card is open interrupts the turn; the card's later Allow
// reaches nothing, the write never happens, and the next turn runs clean.
func TestDshRealApprovalStop(t *testing.T) {
	h := newDshRealHarness(t, "default", true)
	file := filepath.Join(h.work, "stopped.txt")
	h.model.plans = []dshPlan{dshEscalatedWrite(file, "P4 stopped write", "workspace-write"), {text: "P4 after stop"}}
	h.start()
	h.send("t1", "message", "Write the file.")
	card := h.waitCard(1)
	h.send("stop", "interrupt", "")
	done := h.settled("t1")
	if done.Status != stInterrupted {
		t.Fatalf("turn = %+v", done)
	}
	h.cp.decide(card.ID, "ALLOWED") // the person answers after the stop
	time.Sleep(time.Second)
	h.send("t2", "message", "Continue.")
	next := h.settled("t2")
	if next.Status != stSucceeded || dshFileState(file) != "absent" {
		t.Fatalf("next = %+v file=%q", next, dshFileState(file))
	}
	if late := h.cp.cards()[0]; late.LatePoll {
		t.Fatal("the stopped card was still being read after its turn settled")
	}
	_, result := h.toolResult("t1", "write")
	if result["status"] != "failed" {
		t.Fatalf("the stopped tool needs a failed terminal: %+v", result)
	}
	if uses, _ := h.tools("t2"); len(uses) != 0 {
		t.Fatalf("the stopped write reached the next turn: %+v", uses)
	}
	h.end()
	h.evidence(t.Name(), map[string]interface{}{"file": dshFileState(file), "lateDecision": "ALLOWED"})
}

// TestDshRealApprovalDisconnect: the dsh process dies while the card is open. The turn fails with
// its tool settled, the card stops being read, and a later Allow has no process to reach.
func TestDshRealApprovalDisconnect(t *testing.T) {
	h := newDshRealHarness(t, "default", true)
	file := filepath.Join(h.work, "disconnected.txt")
	h.model.plans = []dshPlan{dshEscalatedWrite(file, "P4 disconnected write", "workspace-write")}
	h.start()
	h.send("t1", "message", "Write the file.")
	card := h.waitCard(1)
	h.kill()
	done := h.settled("t1")
	if done.Status != stFailed {
		t.Fatalf("a lost connection is not success: %+v", done)
	}
	select {
	case <-h.done:
	case <-time.After(20 * time.Second):
		t.Fatal("the session loop must end with its process")
	}
	h.cp.decide(card.ID, "ALLOWED")
	time.Sleep(time.Second)
	if dshFileState(file) != "absent" || h.cp.cards()[0].LatePoll {
		t.Fatalf("file=%q latePoll=%v", dshFileState(file), h.cp.cards()[0].LatePoll)
	}
	_, result := h.toolResult("t1", "write")
	if result["status"] != "failed" || !strings.Contains(firstString(result, "content"), "side effects may have occurred") {
		t.Fatalf("the open tool needs a failed terminal: %+v", result)
	}
	h.evidence(t.Name(), map[string]interface{}{"file": dshFileState(file), "status": done.Status})
}

// TestDshRealDontAskRejectsUnasked: Don't Ask files no card; the escalation is rejected, nothing is
// written and the rejection is visible in the transcript.
func TestDshRealDontAskRejectsUnasked(t *testing.T) {
	h := newDshRealHarness(t, "dontAsk", true)
	file := filepath.Join(h.work, "dont-ask.txt")
	h.model.plans = []dshPlan{dshEscalatedWrite(file, "P4 dont ask", "workspace-write"), {text: "P4 dont ask answer"}}
	h.start()
	h.send("t1", "message", "Write the file.")
	done := h.settled("t1")
	if done.Status != stSucceeded || dshFileState(file) != "absent" || len(h.cp.cards()) != 0 {
		t.Fatalf("turn = %+v file=%q cards=%d", done, dshFileState(file), len(h.cp.cards()))
	}
	if notes := h.notes("permission_denied"); len(notes) != 1 || notes[0]["name"] != "write" {
		t.Fatalf("notes = %+v", notes)
	}
	h.end()
	h.evidence(t.Name(), map[string]interface{}{"file": dshFileState(file), "cards": 0})
}

// TestDshRealAutoWorkspaceBoundary: Auto writes and runs commands inside the workspace without a
// card; a write outside the workspace and the temp directories is denied unless a card allows it.
func TestDshRealAutoWorkspaceBoundary(t *testing.T) {
	h := newDshRealHarness(t, "auto", true)
	inside := filepath.Join(h.work, "inside.txt")
	outsideDir := filepath.Join(userHome(), ".orbit-dsh-p4-outside-never-created")
	outside := filepath.Join(outsideDir, "outside.txt")
	if _, err := os.Stat(outsideDir); err == nil {
		t.Fatalf("%s must not exist", outsideDir)
	}
	t.Cleanup(func() { _ = os.RemoveAll(outsideDir) })
	h.model.plans = []dshPlan{
		{tool: "write", args: map[string]interface{}{"file_path": inside, "content": "P4 auto inside"}},
		{tool: "bash", args: map[string]interface{}{"command": "printf 'P4 auto command' > auto-command.txt", "description": "write in the workspace"}},
		{tool: "write", args: map[string]interface{}{"file_path": outside, "content": "P4 outside"}},
		dshEscalatedWrite(outside, "P4 outside escalated", "danger-full-access"),
		{text: "P4 auto answer"},
	}
	h.start()
	h.send("t1", "message", "Write inside, then outside.")
	card := h.waitCard(1)
	if mapValue(card.Body["input"])["file_path"] != outside || dshFileState(inside) != "P4 auto inside" ||
		dshFileState(filepath.Join(h.work, "auto-command.txt")) != "P4 auto command" {
		t.Fatalf("card = %+v inside=%q", card.Body, dshFileState(inside))
	}
	h.cp.decide(card.ID, "DENIED")
	done := h.settled("t1")
	if done.Status != stSucceeded || dshFileState(outside) != "absent" || len(h.cp.cards()) != 1 {
		t.Fatalf("turn = %+v outside=%q cards=%d", done, dshFileState(outside), len(h.cp.cards()))
	}
	h.end()
	h.evidence(t.Name(), map[string]interface{}{"inside": dshFileState(inside), "outside": dshFileState(outside), "cards": 1})
}

// TestDshRealAutoRoutineEscalation: an isolated session works in a linked worktree whose index,
// objects and refs live in the main repository's .git, outside workspace-write. In Auto the
// model's escalated commit is allowed without a card; its escalated push still waits for a person.
// The repository sits under HOME because /tmp is writable in workspace-write and would hide that.
func TestDshRealAutoRoutineEscalation(t *testing.T) {
	base, err := os.MkdirTemp(userHome(), ".orbit-dsh-p4-routine-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	repo, worktree, remote := filepath.Join(base, "repo"), filepath.Join(base, "worktree"), filepath.Join(base, "remote.git")
	for _, dir := range []string{repo, remote} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	mustGit(t, repo, "init", "-q", "-b", "main")
	mustGit(t, repo, "config", "user.email", "test@orbit")
	mustGit(t, repo, "config", "user.name", "Test")
	commitFile(t, repo, "base.txt", "base\n", "base")
	mustGit(t, remote, "init", "-q", "--bare")
	mustGit(t, repo, "remote", "add", "origin", remote)
	mustGit(t, repo, "worktree", "add", "-q", "-b", "orbit/session", worktree)

	h := newDshRealHarness(t, "auto", true)
	h.work = worktree
	commit := "printf 'session change\\n' > change.txt && git add change.txt && git commit -q -m 'session change' && git log --oneline -1"
	push := "git push origin HEAD:refs/heads/published"
	h.model.plans = []dshPlan{
		{tool: "bash", args: map[string]interface{}{"command": commit, "description": "commit the change"}},
		{tool: "bash", args: map[string]interface{}{"command": commit, "description": "commit the change",
			"sandbox_permissions": "danger-full-access", "justification": "the worktree's index lives in the main repository's .git"}},
		{tool: "bash", args: map[string]interface{}{"command": push, "description": "publish the branch",
			"sandbox_permissions": "danger-full-access", "justification": "publish the branch"}},
		{text: "P4 routine answer"},
	}
	h.start()
	h.send("t1", "message", "Commit the change, then publish it.")
	card := h.waitCard(1)
	if mapValue(card.Body["input"])["command"] != push {
		t.Fatalf("the only card must be the push: %+v", card.Body)
	}
	h.cp.decide(card.ID, "DENIED")
	done := h.settled("t1")
	branch := mustGit(t, repo, "log", "--format=%s", "orbit/session")
	published, _ := git(remote, "rev-parse", "--verify", "-q", "refs/heads/published")
	if done.Status != stSucceeded || !strings.Contains(branch, "session change") || strings.TrimSpace(published) != "" ||
		len(h.cp.cards()) != 1 || len(h.notes("permission_auto_allowed")) != 1 {
		t.Fatalf("turn = %+v branch=%q published=%q cards=%d notes=%+v", done, branch, published, len(h.cp.cards()), h.notes("permission_auto_allowed"))
	}
	h.end()
	h.evidence(t.Name(), map[string]interface{}{"commitAllowedWithoutCard": true, "pushCards": 1, "pushed": false})
}

// TestDshToolGate: the commands every DeepSeek Harness session asks about before they run, read the
// way the gate plugin reads them (the same patterns, passed in as its config).
func TestDshToolGate(t *testing.T) {
	for command, want := range map[string]string{
		"git push origin HEAD":                                    "a push",
		"cd /w && timeout 60 git push --force origin x":           "a push",
		"GIT_SSH_COMMAND='ssh -i key' git push":                   "a push",
		"git -C /w -c push.default=current push":                  "a push",
		"for r in a b; do git push origin $r; done":               "a push",
		"bash <<'EOF'\ngit push\nEOF":                             "a push",
		"git commit -q -m 'feat(android): push notifications'":    "",
		"git commit -F - <<'EOF'\nfix: push notifications\nEOF":   "",
		"git log --grep push":                                     "",
		"ssh build-host 'make deploy'":                            "a remote shell or copy",
		"timeout 30 ssh host true":                                "a remote shell or copy",
		"scp out.tar host:/srv/":                                  "a remote shell or copy",
		"rsync -a dist/ web:/var/www/":                            "a remote shell or copy",
		"rsync -a dist/ backup/":                                  "",
		"echo '=== ssh mux ==='; ls /root/.orbit/ssh-mux":         "",
		"curl -sS -X POST --data-binary @out https://example.com": "an HTTP write",
		"x=$(curl -X DELETE https://example.com/item/1)":          "an HTTP write",
		"wget --post-data=a=1 https://example.com":                "an HTTP write",
		"curl -sS -o out.json https://api.github.com/repos/a/b":   "",
		"curl -sS -f http://127.0.0.1:2086/api/health":            "",
		"gh pr create --fill":                                     "a GitHub change",
		"gh api repos/a/b/issues -f title=x":                      "a GitHub change",
		"gh pr view 12 --json state":                              "",
		"gh api -X POST repos/a/b/dispatches":                     "a GitHub change",
		"curl -d @payload.json https://example.com/hook":          "an HTTP write",
		"kubectl apply -f deploy.yaml":                            "a cluster or cloud change",
		"aws s3 cp out s3://bucket/out":                           "a cluster or cloud change",
		"aws ec2 terminate-instances --instance-ids i-1":          "a cluster or cloud change",
		"kubectl get pods -o wide":                                "",
		"aws s3 ls s3://bucket":                                   "",
		"systemctl restart orbit-runner-root.service":             "a service change",
		"systemctl list-units --type=service | grep orbit":        "",
		"sudo ls /root":                                           "a privilege change",
		"grep -n sudo setup.sh":                                   "",
		"if true; then reboot; fi":                                "a power change",
		"grep -n shutdown runner.log":                             "",
		"npm publish --access public":                             "a publish",
		"docker push registry/image:tag":                          "a publish",
		"docker run --rm -v $PWD:/w swift:6.1 swift test":         "",
		"go test ./... && git status --short":                     "",
	} {
		if got := dshToolGateMatch(command); got != want {
			t.Errorf("dshToolGateMatch(%q) = %q, want %q", command, got, want)
		}
	}
	for _, rule := range dshToolGateRules {
		if strings.Contains(rule.Pattern, "(?=") || strings.Contains(rule.Pattern, "(?!") || strings.Contains(rule.Pattern, "(?<") || strings.Contains(rule.Pattern, "(?i") {
			t.Errorf("%s: the plugin compiles these in JavaScript too; no lookarounds or inline flags", rule.Name)
		}
	}
}

// TestDshRealToolGateAsksInAuto: the file sandbox confines writes, not the network, so a command
// that acts on another system ran unasked in every mode. Orbit's tool gate asks first: in Auto an
// HTTP write waits for a card and a refusal sends nothing, while an ordinary command still runs
// unasked.
func TestDshRealToolGateAsksInAuto(t *testing.T) { dshRealToolGateScenario(t, "auto") }

// TestDshRealToolGateRefusesInDontAsk: the same HTTP write is refused in Don't Ask, without a card.
func TestDshRealToolGateRefusesInDontAsk(t *testing.T) { dshRealToolGateScenario(t, "dontAsk") }

func dshRealToolGateScenario(t *testing.T, mode string) {
	var mu sync.Mutex
	var posted []string
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		posted = append(posted, string(body))
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer sink.Close()
	h := newDshRealHarness(t, mode, true)
	post := "curl -sS -X POST --data-binary P4-gate " + sink.URL + "/upload && echo posted"
	h.model.plans = []dshPlan{
		{tool: "bash", args: map[string]interface{}{"command": post, "description": "post"}},
		{tool: "bash", args: map[string]interface{}{"command": "printf ordinary", "description": "print"}},
		{text: "P4 gate answer"},
	}
	h.start()
	h.send("t1", "message", "Post, then print.")
	if mode == "auto" {
		card := h.waitCard(1)
		if mapValue(card.Body["input"])["command"] != post {
			t.Fatalf("card = %+v", card.Body)
		}
		h.cp.decide(card.ID, "DENIED")
	}
	done := h.settled("t1")
	uses, results := h.tools("t1")
	ordinary := ""
	for id, use := range uses {
		if mapValue(use["input"])["command"] == "printf ordinary" {
			ordinary = firstString(results[id], "content")
		}
	}
	mu.Lock()
	sent := len(posted)
	mu.Unlock()
	wantCards := map[string]int{"auto": 1, "dontAsk": 0}[mode]
	if done.Status != stSucceeded || sent != 0 || ordinary != "ordinary" || len(h.cp.cards()) != wantCards ||
		(mode == "dontAsk" && len(h.notes("permission_denied")) != 1) {
		t.Fatalf("turn = %+v posted=%d ordinary=%q cards=%d notes=%+v", done, sent, ordinary, len(h.cp.cards()), h.notes("permission_denied"))
	}
	h.end()
	h.evidence(t.Name(), map[string]interface{}{"mode": mode, "posted": sent, "cards": wantCards, "ordinaryRanUnasked": true})
}
