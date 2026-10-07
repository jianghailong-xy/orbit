package main

import (
	"context"
	"encoding/json"
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
			"auto":    {FileMode: "workspace-write", Ask: true, ThirdPartyMCP: true},
			"":        {FileMode: "workspace-write", Ask: true, ThirdPartyMCP: true},
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
