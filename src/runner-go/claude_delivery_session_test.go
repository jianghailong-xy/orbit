package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// End-to-end delivery states, driven through the real session loop: the inbox hands out
// turns, the fake CLI reads them off its stdin and echoes them back the way
// --replay-user-messages does, and what the transcript ends up saying about each message
// is the assertion.
//
// Running the whole loop rather than the ledger alone is the point. The fake send this
// task removes lived in the wiring — the user bubble was emitted before the frame had been
// offered to anybody — and no unit test of either half would have caught it.

// deliverySession records one scripted run of runClaudeSessionProcess.
type deliverySession struct {
	mu      sync.Mutex
	events  []RunEvent
	settled []TurnCompleteRequest
}

func (r *deliverySession) record(turnID, eventType string, payload map[string]interface{}) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, RunEvent{Type: eventType, TurnID: turnID, Payload: payload})
}

// userBubbles maps each turn to the delivery state its user event claimed. A turn absent
// from it never entered the transcript at all.
func (r *deliverySession) userBubbles() map[string]string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := map[string]string{}
	for _, e := range r.events {
		if e.Type == evUser {
			state, _ := e.Payload["delivery"].(string)
			out[e.TurnID] = state
		}
	}
	return out
}

// deliveryStates lists the transitions reported for one turn, in order.
func (r *deliverySession) deliveryStates(turnID string) []string {
	var out []string
	for _, p := range r.deliveryReports() {
		if p["turnId"] == turnID {
			out = append(out, p["delivery"].(string))
		}
	}
	return out
}

func (r *deliverySession) deliveryReports() []map[string]interface{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []map[string]interface{}
	for _, e := range r.events {
		if e.Type == evUserDelivery {
			out = append(out, e.Payload)
		}
	}
	return out
}

func (r *deliverySession) turnResult(turnID string) *TurnCompleteRequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, s := range r.settled {
		if s.TurnID == turnID {
			return &r.settled[i]
		}
	}
	return nil
}

// runDeliverySession feeds `turns` to the session loop, one inbox response each. The run
// ends when the CLI's stdout does — or, for a CLI scripted to stay up, as soon as `until`
// reports that what the test was waiting for has happened.
func runDeliverySession(t *testing.T, script []fakeStep, turns []RunInboxResponse, until func(*deliverySession) bool) *deliverySession {
	t.Helper()
	fake := newFakeClaude(t, script...)
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("ORBIT_HOME", t.TempDir())

	queued := make(chan RunInboxResponse, len(turns))
	for _, turn := range turns {
		queued <- turn
	}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/inbox") {
			_, _ = w.Write([]byte(`{}`))
			return
		}
		select {
		case turn := <-queued:
			_ = json.NewEncoder(w).Encode(turn)
		case <-r.Context().Done():
		case <-time.After(20 * time.Millisecond):
			_, _ = w.Write([]byte(`{}`)) // long-poll timeout: the runner re-polls
		}
	}))
	t.Cleanup(api.Close)

	run := &deliverySession{}
	// The loop stamps a turn onto every event through setTurn, which the supervisor owns
	// in production; here the harness owns it, so each recorded event knows its turn.
	var turnMu sync.Mutex
	current := ""
	setTurn := func(id string) {
		turnMu.Lock()
		current = id
		turnMu.Unlock()
	}
	emit := func(eventType string, payload map[string]interface{}) {
		turnMu.Lock()
		id := current
		turnMu.Unlock()
		run.record(id, eventType, payload)
	}
	complete := func(r TurnCompleteRequest, _ ...context.Context) error {
		run.mu.Lock()
		defer run.mu.Unlock()
		run.settled = append(run.settled, r)
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), fakeClaudeTimeout)
	defer cancel()
	dir, job := t.TempDir(), claudeSpawnJob(t)
	done := make(chan struct{})
	go func() {
		defer close(done)
		runClaudeSessionProcess(ctx, context.Background(), NewTransport(api.URL, "runner-token"),
			job, "11111111-1111-4111-8111-111111111111", dir, dir, emit, setTurn, true, nil,
			complete, func(context.Context) bool { return true }, func(error) {})
	}()
	if until != nil {
		waitUntil(t, func() bool { return until(run) }, "the session never reached the state under test")
		cancel() // a CLI that stays up on purpose is taken down here, as a runner shutdown would
	}
	select {
	case <-done:
	case <-time.After(fakeClaudeTimeout):
		t.Fatal("the session never finished")
	}
	return run
}

func waitUntil(t *testing.T, ok func() bool, whenNot string) {
	t.Helper()
	deadline := time.Now().Add(fakeClaudeTimeout)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal(whenNot)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func messageTurn(id, text string) RunInboxResponse {
	return RunInboxResponse{TurnID: id, Kind: "message", Content: text}
}

// The normal path, end to end: the message is shown as enqueued the moment the writer
// takes it, reported written when its bytes reach the CLI, and acknowledged when the CLI
// echoes it back — the first moment it is really part of the conversation.
func TestSessionReportsAMessageEnqueuedThenWrittenThenAcknowledged(t *testing.T) {
	run := runDeliverySession(t,
		[]fakeStep{
			{Await: "user"},
			{Emit: "replay_user"},
			{Emit: "system_init"},
			{Emit: "assistant", Text: "on it"},
			{Emit: "result", Text: "done"},
			{Emit: "eof"},
		},
		[]RunInboxResponse{messageTurn("turn-1", "rename the widget")}, nil)

	if got := run.userBubbles()["turn-1"]; got != string(deliveryEnqueued) {
		t.Fatalf("the user bubble opened at %q, want %q — a bubble may not claim more than the writer promised", got, deliveryEnqueued)
	}
	want := []string{string(deliveryWritten), string(deliveryAcknowledged)}
	if got := run.deliveryStates("turn-1"); !equalStrings(got, want) {
		t.Fatalf("delivery reported %v, want %v", got, want)
	}
	for _, p := range run.deliveryReports() {
		if p["reason"] != nil {
			t.Errorf("a message that arrived reported a failure reason: %v", p)
		}
	}
}

// Two messages carrying the very same text: only their order can tell the replays apart,
// which is exactly what the ledger correlates on.
func TestSessionCorrelatesIdenticalMessagesInOrder(t *testing.T) {
	run := runDeliverySession(t,
		[]fakeStep{
			{Await: "user"},
			{Emit: "replay_user"},
			{Await: "user"},
			{Emit: "replay_user"},
			{Emit: "result", Text: "done"},
			{Emit: "eof"},
		},
		[]RunInboxResponse{
			messageTurn("turn-1", "carry on"),
			messageTurn("turn-2", "carry on"),
		}, nil)

	var acked []string
	for _, p := range run.deliveryReports() {
		if p["delivery"] == string(deliveryAcknowledged) {
			acked = append(acked, p["turnId"].(string))
		}
	}
	if !equalStrings(acked, []string{"turn-1", "turn-2"}) {
		t.Fatalf("replays were correlated to %v, want turn-1 then turn-2", acked)
	}
}

// A message the CLI was handed and never echoed back, on a CLI that demonstrably echoes:
// nobody can say whether it ran. The turn is settled as failed rather than left for the
// next process to feed again, so the work behind it is never repeated by accident.
func TestSessionSettlesAnUnconfirmedMessageInsteadOfRepeatingIt(t *testing.T) {
	run := runDeliverySession(t,
		[]fakeStep{
			{Await: "user"},
			{Emit: "replay_user"},
			{Emit: "result", Text: "done"},
			{Await: "user"}, // read off stdin, and then the CLI dies without echoing it
			{Emit: "eof"},
		},
		[]RunInboxResponse{
			messageTurn("turn-1", "first"),
			messageTurn("turn-2", "second"),
		}, nil)

	var failure map[string]interface{}
	for _, p := range run.deliveryReports() {
		if p["turnId"] == "turn-2" && p["delivery"] == string(deliveryFailed) {
			failure = p
		}
	}
	if failure == nil {
		t.Fatalf("the unconfirmed message was never reported as failed: %v", run.deliveryReports())
	}
	if failure["retryable"] != false {
		t.Errorf("an unconfirmed message was reported retryable: %v", failure)
	}
	if !strings.Contains(failure["reason"].(string), "unconfirmed") {
		t.Errorf("the reason %q does not name the ambiguity", failure["reason"])
	}
	settled := run.turnResult("turn-2")
	if settled == nil || settled.Status != stFailed {
		t.Fatalf("turn-2 settled as %v, want a failure so it is never re-delivered", settled)
	}
	if !strings.Contains(settled.Result, "unconfirmed") {
		t.Errorf("the turn result %q does not name the ambiguity", settled.Result)
	}
}

// The engine is on its way out, so the message cannot reach it. However far it got, it is
// never reported written or acknowledged, its bubble never claims to be delivered, and the
// turn settles as a failure instead of sitting unanswered behind a message the user
// believes was sent.
func TestSessionNeverShowsAMessageIntoADeadEngineAsSent(t *testing.T) {
	run := runDeliverySession(t,
		[]fakeStep{{Emit: "system_init"}, {Emit: "eof"}},
		[]RunInboxResponse{messageTurn("turn-1", "too late")}, nil)

	// Whether the frame was refused outright or accepted into a pipe that broke under it
	// depends on how far the exit had got, and either is honest — what may never happen is
	// the message being shown as having arrived.
	states := run.deliveryStates("turn-1")
	for _, state := range states {
		if state == string(deliveryAcknowledged) {
			t.Errorf("a message into an exited CLI was reported %q", state)
		}
	}
	if len(states) == 0 || states[len(states)-1] != string(deliveryFailed) {
		t.Fatalf("delivery reported %v, want it to end in %q", states, deliveryFailed)
	}
	if state, ok := run.userBubbles()["turn-1"]; ok && state != string(deliveryEnqueued) {
		t.Errorf("the bubble for an undelivered message claims %q", state)
	}
	settled := run.turnResult("turn-1")
	if settled == nil || settled.Status != stFailed {
		t.Fatalf("the undelivered turn settled as %v, want a failure", settled)
	}
	if !strings.Contains(settled.Result, "not delivered") {
		t.Errorf("the turn result %q does not say the message was not delivered", settled.Result)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
