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
	fake    *fakeClaude
	// Whether the run asked its supervisor to re-spawn. This is the whole difference between
	// a config change that landed in the running process and one that cost the session that
	// process: it is what makes the outer loop bring another claude up and emit `resumed`.
	// Written once, before the run's goroutine closes `done`, and read only after it has.
	reload bool
	// The claim the run was driven with. Its Agent is what the NEXT process would be built
	// from, so a test that changed a setting mid-session reads the result here.
	job *ClaimedSession
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

// steeredTurns is the set of turns whose user event says it was written into a turn that was
// already running. The clients show a steer's delivery and nothing for an ordinary message, so
// this flag is what a reloaded transcript reads to tell them apart.
func (r *deliverySession) steeredTurns() map[string]bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := map[string]bool{}
	for _, e := range r.events {
		if e.Type == evUser {
			if flag, _ := e.Payload["steer"].(bool); flag {
				out[e.TurnID] = true
			}
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

func (r *deliverySession) eventsOfType(eventType string) []RunEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []RunEvent
	for _, e := range r.events {
		if e.Type == eventType {
			out = append(out, e)
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
func runDeliverySession(t *testing.T, script []fakeStep, turns []scriptedTurn, until func(*deliverySession) bool) *deliverySession {
	t.Helper()
	fake := newFakeClaude(t, script...)
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("ORBIT_HOME", t.TempDir())

	run := &deliverySession{fake: fake}
	// The inbox hands turns out under the same rule dequeueTurn applies, because that rule
	// is half of what is being tested: an executable turn waits for the slot, and a steer
	// is deliverable only BECAUSE something holds it. A harness that simply handed over
	// whatever was queued would prove the runner works against a control plane Orbit does
	// not have.
	var queueMu sync.Mutex
	queued := append([]scriptedTurn(nil), turns...)
	inFlight := ""
	nextTurn := func() (RunInboxResponse, bool) {
		queueMu.Lock()
		defer queueMu.Unlock()
		if inFlight != "" && run.turnResult(inFlight) != nil {
			inFlight = "" // its result came back: the slot is free again
		}
		if len(queued) == 0 {
			return RunInboxResponse{}, false
		}
		next := queued[0]
		if next.after != "" && run.turnResult(next.after) == nil {
			return RunInboxResponse{}, false // it is not this turn's moment yet
		}
		switch {
		case next.ungated:
		case next.turn.Kind == "steer":
			if inFlight == "" {
				return RunInboxResponse{}, false // nothing running to steer: it waits
			}
		default:
			if inFlight != "" {
				return RunInboxResponse{}, false // the single in-flight slot is taken
			}
			inFlight = next.turn.TurnID
		}
		queued = queued[1:]
		return next.turn, true
	}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/inbox") {
			_, _ = w.Write([]byte(`{}`))
			return
		}
		deadline := time.Now().Add(20 * time.Millisecond)
		for time.Now().Before(deadline) && r.Context().Err() == nil {
			if turn, ok := nextTurn(); ok {
				_ = json.NewEncoder(w).Encode(turn)
				return
			}
			time.Sleep(2 * time.Millisecond)
		}
		_, _ = w.Write([]byte(`{}`)) // long-poll timeout: the runner re-polls
	}))
	t.Cleanup(api.Close)

	// The loop stamps a turn onto every event through setTurn, which the supervisor owns
	// in production; here the harness owns it, so each recorded event knows its turn.
	var turnMu sync.Mutex
	current := ""
	setTurn := func(id string) {
		turnMu.Lock()
		current = id
		turnMu.Unlock()
	}
	emitFor := func(turnID, eventType string, payload map[string]interface{}) {
		run.record(turnID, eventType, payload)
	}
	emit := func(eventType string, payload map[string]interface{}) {
		turnMu.Lock()
		id := current
		turnMu.Unlock()
		emitFor(id, eventType, payload)
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
	run.job = job
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _, run.reload = runClaudeSessionProcess(ctx, context.Background(),
			NewTransport(api.URL, "runner-token"),
			job, "11111111-1111-4111-8111-111111111111", dir, dir, emit, emitFor, setTurn, true, nil,
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

// scriptedTurn is one inbox response and whether the harness's gate applies to it.
type scriptedTurn struct {
	turn RunInboxResponse
	// ungated hands the turn over whatever the in-flight rule says. Its only use is the
	// one thing the rule cannot produce: the gap between the server judging a steer
	// deliverable and the runner reading it, in which the turn it was aimed at ended.
	ungated bool
	// after holds the turn back until the named turn has settled. The rule above says
	// what the server WILL hand over; this says when the runner gets round to reading it,
	// which for a control turn aimed at a turn that has just ended is the whole question.
	after string
}

func messageTurn(id, text string) scriptedTurn {
	return scriptedTurn{turn: RunInboxResponse{TurnID: id, Kind: "message", Content: text}}
}

func steerTurn(id, text string) scriptedTurn {
	return scriptedTurn{turn: RunInboxResponse{TurnID: id, Kind: "steer", Content: text}}
}

// raceySteerTurn is a steer that reaches the runner after its turn is already over.
func raceySteerTurn(id, text string) scriptedTurn {
	s := steerTurn(id, text)
	s.ungated = true
	return s
}

// seqOf reports the position of the first event matching `match`, or -1.
func (r *deliverySession) seqOf(match func(RunEvent) bool) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, e := range r.events {
		if match(e) {
			return i
		}
	}
	return -1
}

func isDelivery(turnID string, state deliveryState) func(RunEvent) bool {
	return func(e RunEvent) bool {
		return e.Type == evUserDelivery && e.Payload["turnId"] == turnID &&
			e.Payload["delivery"] == string(state)
	}
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
		[]scriptedTurn{messageTurn("turn-1", "rename the widget")}, nil)

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
			{Emit: "result", Text: "done"},
			{Await: "user"},
			{Emit: "replay_user"},
			{Emit: "result", Text: "done again"},
			{Emit: "eof"},
		},
		[]scriptedTurn{
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
		[]scriptedTurn{
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
		[]fakeStep{{Emit: "system_init"}, {Await: "user"}, {Emit: "eof"}},
		[]scriptedTurn{messageTurn("turn-1", "too late")}, nil)

	// Synchronize the exit to the frame reaching stdin. If the CLI exits before the inbox
	// poller has claimed the turn, this process owes no delivery report: the still-pending
	// turn belongs to the next generation. Here the runner has taken responsibility, so
	// the missing replay must end in a visible failure and never look acknowledged.
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

// ---------------------------------------------------------------------------
// steering a turn that is already running
// ---------------------------------------------------------------------------

// The point of the whole thing: a message sent while the engine is inside a tool call
// reaches that engine, on the stdin it is already reading, before the turn it is steering
// produces its result — and it does so without a second process, without taking the ack
// queue's answer, and without moving the running turn's output onto its own turn.
func TestSessionWritesASteerIntoTheRunningTurn(t *testing.T) {
	run := runDeliverySession(t,
		[]fakeStep{
			{Await: "user"},       // the message that opens the turn
			{Emit: "replay_user"}, // …echoed back: it is in the conversation
			{Emit: "system_init"},
			{Emit: "tool_use", ToolUseID: "toolu_1", ToolName: "Bash", Input: map[string]interface{}{"command": "ls"}},
			{Await: "user"},       // the steer, read while the tool call is open
			{Emit: "replay_user"}, // …echoed back: folded into this same turn
			{Emit: "tool_result", ToolUseID: "toolu_1", Text: "widget.go"},
			{Emit: "result", Text: "renamed"}, // the ONE result of that turn — the steer adds none
			{Await: "user"},                   // an ordinary follow-up, queued the ordinary way
			{Emit: "replay_user"},
			{Emit: "result", Text: "reverted"},
			{Emit: "eof"},
		},
		[]scriptedTurn{
			messageTurn("turn-1", "rename the widget"),
			steerTurn("steer-1", "actually, call it gadget"),
			messageTurn("turn-2", "and now revert it"),
		}, nil)

	// One process for both. A steer that spawned its own engine would be a new
	// conversation, not a redirection of this one.
	if spawns := run.fake.Spawns(); len(spawns) != 1 {
		t.Fatalf("claude was spawned %d time(s), want 1 — the steer must reach the running process", len(spawns))
	}
	frames := run.fake.WaitStdin(3)
	for i, want := range []string{"rename the widget", "actually, call it gadget", "and now revert it"} {
		if got := userFrameText(t, frames[i]); got != want {
			t.Errorf("stdin frame %d carried %q, want %q", i, got, want)
		}
	}

	// Written before the result it was aimed at, which is the entire difference between
	// steering a turn and queueing behind it.
	acked := run.seqOf(isDelivery("steer-1", deliveryAcknowledged))
	ended := run.seqOf(func(e RunEvent) bool { return e.Type == evTurnEnd })
	if acked < 0 {
		t.Fatalf("the steer was never acknowledged: %v", run.deliveryReports())
	}
	if ended < 0 || acked > ended {
		t.Fatalf("the steer landed at %d and the turn ended at %d — it must reach the engine first", acked, ended)
	}
	// And the ordinary follow-up is NOT: it waited for the slot the running turn held, which
	// is what makes the steer a different thing rather than the gate quietly removed.
	followUp := run.seqOf(func(e RunEvent) bool { return e.Type == evUser && e.TurnID == "turn-2" })
	if followUp < 0 || followUp < ended {
		t.Fatalf("the queued message entered the transcript at %d, before the running turn ended at %d", followUp, ended)
	}

	// Its own turn, not the one it joined: the bubble is the steer's, and everything the
	// engine streamed stays with the message that started the turn.
	if got := run.userBubbles()["steer-1"]; got != string(deliveryEnqueued) {
		t.Errorf("the steer's bubble was filed as %q under turn steer-1", got)
	}
	// …and the event says which kind it was, since after a reload that event is all a client
	// has: a steer is reported by how far it got, an ordinary message by the reply to it.
	steered := run.steeredTurns()
	if !steered["steer-1"] {
		t.Error("the steer's user event does not say it was steered into the running turn")
	}
	if steered["turn-1"] || steered["turn-2"] {
		t.Errorf("an ordinary message was filed as a steer: %v", steered)
	}
	for _, e := range run.eventsOfType(evToolResult) {
		if e.TurnID != "turn-1" {
			t.Errorf("a tool_result of the steered turn was filed under %q, want turn-1", e.TurnID)
		}
	}

	// A steer never enters the queue a `result` pops, so each result still answers the
	// message that asked for it. Were the steer in that queue, the follow-up's result would
	// be handed to the steer and the follow-up would never be answered at all.
	if n := len(run.eventsOfType(evTurnEnd)); n != 2 {
		t.Errorf("the session reported %d turn boundaries, want one per message", n)
	}
	settled := run.turnResult("turn-1")
	if settled == nil || settled.Status != stSucceeded || settled.Result != "renamed" {
		t.Fatalf("turn-1 settled as %v, want the engine's own result", settled)
	}
	if followUp := run.turnResult("turn-2"); followUp == nil || followUp.Result != "reverted" {
		t.Fatalf("the follow-up settled as %v, want its own result", followUp)
	}
	steer := run.turnResult("steer-1")
	if steer == nil || steer.Status != stSucceeded || steer.Subtype != "steer" {
		t.Fatalf("the steer's turn settled as %v, want a steer completion of its own", steer)
	}
	if steer.NumTurns != 0 || steer.CostUsd != 0 {
		t.Errorf("the steer's completion claims work of its own: %+v", steer)
	}
}

// A steer that arrives with nothing running has nothing to fold into. Writing it anyway
// would open a turn no queued turn is waiting to answer, so it is refused: no user bubble,
// and its own turn is settled rather than left in flight.
func TestSessionRefusesASteerWhenNoTurnIsRunning(t *testing.T) {
	run := runDeliverySession(t,
		[]fakeStep{
			{Emit: "system_init"},
			{Await: "user"}, // never satisfied: the only turn offered is a steer
			{Emit: "eof"},
		},
		[]scriptedTurn{raceySteerTurn("steer-1", "too early")},
		func(r *deliverySession) bool { return r.turnResult("steer-1") != nil })

	// It enters the transcript as the failure it is: the sender has an optimistic bubble
	// waiting on this turn, and nothing else reports a steer that could not land.
	if got := run.userBubbles()["steer-1"]; got != string(deliveryFailed) {
		t.Errorf("the refused steer's bubble says %q, want %q", got, deliveryFailed)
	}
	if !run.steeredTurns()["steer-1"] {
		t.Error("the refused steer's event does not say it was a steer, so no client can explain it")
	}
	if len(run.fake.Stdin()) != 0 {
		t.Errorf("a steer with no turn to steer was written to the engine: %v", run.fake.Stdin())
	}
	settled := run.turnResult("steer-1")
	if settled == nil || settled.Status != stFailed || settled.Subtype != "steer" {
		t.Fatalf("the refused steer settled as %v, want a failed steer completion", settled)
	}
	if !strings.Contains(settled.Result, "no turn was running") {
		t.Errorf("the result %q does not say why the steer could not land", settled.Result)
	}
}
