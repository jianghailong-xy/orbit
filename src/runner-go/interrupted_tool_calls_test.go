package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The tracker on its own: calls answered or ended are forgotten; a runner stop's interrupt answers
// each one still open, in order, before the interrupt; an owner's Stop answers none.
func TestARunnerStopAnswersTheToolCallsItLeavesOpen(t *testing.T) {
	c := &interruptedToolCalls{}
	c.observe("t1", evToolUse, map[string]interface{}{"id": "a", "name": "Bash"})
	c.observe("t1", evToolUse, map[string]interface{}{"id": "b", "name": "Read", "parentToolUseId": "agent-1"})
	c.observe("t1", evToolUse, map[string]interface{}{"id": "c", "name": "Bash"})
	c.observe("t1", evToolResult, map[string]interface{}{"toolUseId": "a"})
	c.observe("t2", evToolUse, map[string]interface{}{"id": "x"})
	c.observe("t2", evTurnEnd, map[string]interface{}{})
	if got := c.observe("t1", evInterrupt, map[string]interface{}{"requestId": "stop-1"}); len(got) != 0 {
		t.Fatalf("the owner's Stop was answered with %d synthetic result(s); the engine reports that one", len(got))
	}
	got := c.observe("t1", evInterrupt, map[string]interface{}{"reason": interruptReasonRunnerUpdate, "targetVersion": "0.1.255"})
	if len(got) != 2 || got[0]["toolUseId"] != "b" || got[1]["toolUseId"] != "c" {
		t.Fatalf("synthetic results = %v; want b then c (a was answered)", got)
	}
	if got[0]["parentToolUseId"] != "agent-1" || got[0]["isError"] != true || got[0]["interrupted"] != interruptReasonRunnerUpdate {
		t.Fatalf("result for b = %v; want filed under its subagent, an error, interrupted by runner_update", got[0])
	}
	if !strings.Contains(got[0]["content"].(string), "the runner update stopped this turn") {
		t.Fatalf("content = %q", got[0]["content"])
	}
	if again := c.observe("t1", evInterrupt, map[string]interface{}{"reason": interruptReasonRunnerRestart}); len(again) != 0 {
		t.Fatalf("calls already answered were answered again: %v", again)
	}
	if ended := c.observe("t2", evInterrupt, map[string]interface{}{"reason": interruptReasonRunnerRestart}); len(ended) != 0 {
		t.Fatalf("a turn that ended had its calls answered: %v", ended)
	}
}

// recordedEvents is what a session's events would be stored as, in order, with their turns.
type recordedEvents struct {
	mu     sync.Mutex
	events []RunEvent
}

func (r *recordedEvents) record(turnID, eventType string, payload map[string]interface{}) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, RunEvent{TurnID: turnID, Type: eventType, Payload: payload})
}

func (r *recordedEvents) snapshot() []RunEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]RunEvent(nil), r.events...)
}

// assertNoCallLeftPending reads the stored transcript as a client does: every tool_use has a
// tool_result after it, and the synthetic one comes before the interrupt.
func assertNoCallLeftPending(t *testing.T, events []RunEvent, cut string) {
	t.Helper()
	used, answeredAt, interruptAt := -1, -1, -1
	for i, ev := range events {
		switch ev.Type {
		case evToolUse:
			if asString(ev.Payload["id"]) == cut {
				used = i
			}
		case evToolResult:
			if asString(ev.Payload["toolUseId"]) == cut {
				answeredAt = i
			}
		case evInterrupt:
			interruptAt = i
		}
	}
	var lines []string
	for _, ev := range events {
		lines = append(lines, ev.Type+" "+asString(ev.Payload["id"])+asString(ev.Payload["toolUseId"])+" "+asString(ev.Payload["reason"])+asString(ev.Payload["interrupted"]))
	}
	t.Logf("transcript events:\n  %s", strings.Join(lines, "\n  "))
	if used < 0 || answeredAt < used || interruptAt < answeredAt {
		t.Fatalf("tool_use %s at %d, its result at %d, the interrupt at %d: want use < result < interrupt", cut, used, answeredAt, interruptAt)
	}
	result := events[answeredAt].Payload
	if result["isError"] != true || result["interrupted"] != interruptReasonRunnerUpdate || events[interruptAt].Payload["reason"] != interruptReasonRunnerUpdate {
		t.Fatalf("result %v, interrupt %v: want an interrupted error result and a runner_update interrupt", result, events[interruptAt].Payload)
	}
}

// Claude Code cut by Update Now in the middle of a Bash call: the stored transcript answers the call
// before the interrupt, so no client is left drawing it as running.
func TestUpdateNowLeavesNoClaudeToolCallPending(t *testing.T) {
	updateNowTarget.Store(ptr("0.1.255"))
	t.Cleanup(func() { updateNowTarget.Store(nil) })
	fake := newFakeClaude(t,
		fakeStep{Emit: "system_init"},
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "tool_use", ToolUseID: "toolu_cut", ToolName: "Bash", Input: map[string]interface{}{"command": "sleep 25; echo step 6"}},
		fakeStep{Await: "release", Text: "never"},
	)
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	inbox := oneMessageInbox(t, "orbit-turn-1", "a long turn")

	var mu sync.Mutex
	current := ""
	setTurn := func(id string) { mu.Lock(); current = id; mu.Unlock() }
	stored := &recordedEvents{}
	emit, emitFor := closingInterruptedToolCalls(stored.record, func() string { mu.Lock(); defer mu.Unlock(); return current })

	shutdownCtx, shutdown := context.WithCancelCause(context.Background())
	job := claudeSpawnJob(t)
	dir := t.TempDir()
	ended := make(chan struct{})
	go func() {
		defer close(ended)
		runClaudeSessionProcess(context.Background(), shutdownCtx, NewTransport(inbox.URL, "runner-token"), job,
			"11111111-1111-4111-8111-111111111111", dir, dir, emit, emitFor, setTurn, true, nil,
			func(TurnCompleteRequest, ...context.Context) error { return nil }, func(context.Context) bool { return true }, func(error) {})
	}()
	waitUntil(t, func() bool {
		for _, ev := range stored.snapshot() {
			if ev.Type == evToolUse {
				return true
			}
		}
		return false
	}, "Claude never opened its tool call")
	shutdown(errRunnerUpdateNow)
	select {
	case <-ended:
	case <-time.After(fakeClaudeTimeout):
		t.Fatal("the Claude session did not detach after Update Now's stop")
	}
	assertNoCallLeftPending(t, stored.snapshot(), "toolu_cut")
}

// Codex cut by Update Now in the middle of a command (the probe's case: its cut command stayed a grey
// pending row forever): the same, through the app-server's own item/started.
func TestUpdateNowLeavesNoCodexToolCallPending(t *testing.T) {
	updateNowTarget.Store(ptr("0.1.255"))
	t.Cleanup(func() { updateNowTarget.Store(nil) })
	fake := newFakeCodexBinary(t, map[string]interface{}{}, map[string]interface{}{})
	fake.useAsRunnerDefault(t)
	fake.answerSessionsWith(t)
	fake.answerTurnsWith(t, []map[string]interface{}{
		{"method": "item/started", "params": map[string]interface{}{
			"threadId": "thread-fake-session", "turnId": "turn-fake-session",
			"item": map[string]interface{}{"type": "commandExecution", "id": "exec-cut", "command": "sleep 25; echo step 6"},
		}},
	})
	inbox := oneMessageInbox(t, "orbit-turn-1", "a long turn")

	var mu sync.Mutex
	current := ""
	setTurn := func(id string) { mu.Lock(); current = id; mu.Unlock() }
	stored := &recordedEvents{}
	emit, emitFor := closingInterruptedToolCalls(stored.record, func() string { mu.Lock(); defer mu.Unlock(); return current })

	var completed atomic.Int32
	job := &ClaimedSession{SessionID: "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e41", Provider: providerCodex, Agent: AgentExecConfig{Provider: providerCodex}}
	shutdownCtx, shutdown := context.WithCancelCause(context.Background())
	ended := make(chan struct{})
	go func() {
		defer close(ended)
		runCodexAppServerSessionProcess(context.Background(), shutdownCtx, NewTransport(inbox.URL, "runner-token"), job, "", t.TempDir(), t.TempDir(),
			emit, emitFor, setTurn, false, nil, nil,
			func(TurnCompleteRequest, ...context.Context) error { completed.Add(1); return nil },
			func(context.Context) bool { return true }, func(error) {})
	}()
	waitUntil(t, func() bool {
		for _, ev := range stored.snapshot() {
			if ev.Type == evToolUse && asString(ev.Payload["id"]) == "exec-cut" {
				return true
			}
		}
		return false
	}, "Codex never started its command")
	shutdown(errRunnerUpdateNow)
	select {
	case <-ended:
	case <-time.After(10 * time.Second):
		t.Fatal("the Codex session did not detach after Update Now's stop")
	}
	if completed.Load() != 0 {
		t.Fatal("the cut turn was completed; the control plane would not hand it back")
	}
	assertNoCallLeftPending(t, stored.snapshot(), "exec-cut")
}

// oneMessageInbox hands one message turn, then answers every poll with nothing.
func oneMessageInbox(t *testing.T, turnID, content string) *httptest.Server {
	t.Helper()
	var served atomic.Bool
	inbox := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/inbox") && served.CompareAndSwap(false, true) {
			_, _ = w.Write([]byte(`{"turnId":"` + turnID + `","kind":"message","content":"` + content + `"}`))
			return
		}
		select {
		case <-r.Context().Done():
		case <-time.After(200 * time.Millisecond):
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(inbox.Close)
	return inbox
}
