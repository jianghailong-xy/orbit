package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// Stop on a Codex app-server session, as the composer's Stop reaches it: an `interrupt` turn in the
// inbox. These drive the real runCodexAppServerSessionProcess against this test binary posing as
// `codex app-server` (runFakeCodexAppServer), whose every turn/interrupt is answered — or refused,
// held, or left unanswered — as the test scripts it (answerInterruptsWith). A Stop is a request with
// an answer, as it is on the Claude path: "Interrupted" goes into the transcript once Codex says the
// turn ended, and a stop that does not take says so.

const codexStopThread = "thread-fake-session"

func codexInterruptedTurn(turnID string) map[string]interface{} {
	return map[string]interface{}{"method": "turn/completed", "params": map[string]interface{}{
		"threadId": codexStopThread,
		"turn":     map[string]interface{}{"id": turnID, "status": "interrupted"},
	}}
}

// codexRunningTurn is a turn Codex is still working on: it has said something and not finished.
func codexRunningTurn() []map[string]interface{} {
	return []map[string]interface{}{
		{"method": "item/agentMessage/delta", "params": map[string]interface{}{"threadId": codexStopThread, "delta": "working"}},
	}
}

type codexStopSession struct {
	t         *testing.T
	fake      *fakeCodexBinary
	inbox     chan string
	completed chan TurnCompleteRequest

	mu     sync.Mutex
	cursor string
	events []RunEvent
	stops  int
	// hold, when set, is called with every event the session emits before it is recorded, on the
	// goroutine emitting it: a test holds the notification reader on one with it.
	hold func(kind string, payload map[string]interface{})
}

// newCodexStopSession starts a session whose thread/start is followed by sessionFrames, whose Orbit
// turns run as turns says (answerTurnsWith), and whose turn/interrupts are answered by interrupts.
func newCodexStopSession(t *testing.T, sessionFrames []map[string]interface{}, turns [][]map[string]interface{}, interrupts ...fakeCodexInterruptAnswer) *codexStopSession {
	t.Helper()
	s := &codexStopSession{t: t, inbox: make(chan string, 8), completed: make(chan TurnCompleteRequest, 4)}
	s.fake = newFakeCodexBinary(t, map[string]interface{}{}, map[string]interface{}{})
	s.fake.useAsRunnerDefault(t)
	s.fake.answerSessionsWith(t, sessionFrames...)
	s.fake.answerTurnsWith(t, turns...)
	s.fake.answerInterruptsWith(t, interrupts...)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/inbox") {
			_, _ = w.Write([]byte(`{}`))
			return
		}
		select {
		case body := <-s.inbox:
			_, _ = w.Write([]byte(body))
		case <-r.Context().Done():
		case <-time.After(200 * time.Millisecond):
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(server.Close)

	record := func(turnID, kind string, payload map[string]interface{}) {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.events = append(s.events, RunEvent{Type: kind, TurnID: turnID, Payload: payload})
	}
	emit := func(kind string, payload map[string]interface{}) {
		s.mu.Lock()
		turnID, hold := s.cursor, s.hold
		s.mu.Unlock()
		if hold != nil {
			hold(kind, payload)
		}
		record(turnID, kind, payload)
	}
	setTurn := func(turnID string) { s.mu.Lock(); s.cursor = turnID; s.mu.Unlock() }

	job := &ClaimedSession{SessionID: "5e2a7c1d-3b4f-4a6e-8d9c-0f1e2d3c4b5a", Provider: providerCodex, Agent: AgentExecConfig{Provider: providerCodex}}
	ctx, cancel := context.WithCancel(context.Background())
	ended := make(chan struct{})
	go func() {
		defer close(ended)
		runCodexAppServerSessionProcess(ctx, context.Background(), NewTransport(server.URL, "runner-token"), job, "", t.TempDir(), t.TempDir(),
			emit, record, setTurn, false, nil, nil,
			func(req TurnCompleteRequest, _ ...context.Context) error { s.completed <- req; return nil },
			func(context.Context) bool { return true }, func(error) {})
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-ended:
		case <-time.After(30 * time.Second):
			t.Error("the session did not end once cancelled")
		}
	})
	return s
}

func (s *codexStopSession) hand(body string) { s.inbox <- body }

// stop presses Stop: each press is a turn of its own, as the control plane hands each one out once.
func (s *codexStopSession) stop() {
	s.mu.Lock()
	s.stops++
	n := s.stops
	s.mu.Unlock()
	s.hand(fmt.Sprintf(`{"turnId":"orbit-stop-%d","kind":"interrupt"}`, n))
}

// startTurn hands the session one message and waits until Codex has named the turn it runs it as.
func (s *codexStopSession) startTurn() {
	s.t.Helper()
	s.hand(`{"turnId":"orbit-turn-1","kind":"message","content":"a long turn"}`)
	s.waitFor("Codex to start the Orbit turn", 30*time.Second, func(e RunEvent) bool {
		return e.Type == evUserDelivery && e.Payload["delivery"] == string(deliveryAcknowledged)
	})
}

func (s *codexStopSession) snapshot() []RunEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]RunEvent(nil), s.events...)
}

func (s *codexStopSession) waitFor(what string, within time.Duration, match func(RunEvent) bool) RunEvent {
	s.t.Helper()
	deadline := time.Now().Add(within)
	for {
		for _, e := range s.snapshot() {
			if match(e) {
				return e
			}
		}
		if time.Now().After(deadline) {
			s.t.Fatalf("waited %s for %s; events: %s", within, what, describeRunEvents(s.snapshot()))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (s *codexStopSession) count(kind string) int {
	n := 0
	for _, e := range s.snapshot() {
		if e.Type == kind {
			n++
		}
	}
	return n
}

// interrupts is the params of every turn/interrupt the fake has heard.
func (s *codexStopSession) interrupts() []map[string]interface{} {
	var out []map[string]interface{}
	for _, line := range s.fake.lines(s.t, "requests.jsonl") {
		var frame map[string]interface{}
		if json.Unmarshal([]byte(line), &frame) != nil || frame["method"] != "turn/interrupt" {
			continue
		}
		params, _ := frame["params"].(map[string]interface{})
		out = append(out, params)
	}
	return out
}

func (s *codexStopSession) waitForInterrupts(n int, within time.Duration) []map[string]interface{} {
	s.t.Helper()
	deadline := time.Now().Add(within)
	for {
		got := s.interrupts()
		if len(got) >= n {
			return got
		}
		if time.Now().After(deadline) {
			s.t.Fatalf("Codex was sent %d turn/interrupt in %s, want %d: %v; events: %s", len(got), within, n, got, describeRunEvents(s.snapshot()))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (s *codexStopSession) completedTurn(within time.Duration) TurnCompleteRequest {
	s.t.Helper()
	select {
	case req := <-s.completed:
		return req
	case <-time.After(within):
		s.t.Fatalf("no turn was completed in %s; events: %s", within, describeRunEvents(s.snapshot()))
	}
	return TurnCompleteRequest{}
}

func describeRunEvents(events []RunEvent) string {
	var b strings.Builder
	for _, e := range events {
		if e.Type == evTextDelta || e.Type == evSystem {
			continue
		}
		payload, _ := json.Marshal(e.Payload)
		b.WriteString("\n  " + e.Type + " [" + e.TurnID + "] " + string(payload))
	}
	return b.String()
}

func isStopFailure(e RunEvent) bool {
	message, _ := e.Payload["message"].(string)
	return e.Type == evError && strings.HasPrefix(message, "could not stop the current turn: ")
}

func shortenCodexInterruptTimeout(t *testing.T, to ...time.Duration) {
	t.Helper()
	saved := codexInterruptTimeout
	codexInterruptTimeout = 300 * time.Millisecond
	if len(to) > 0 {
		codexInterruptTimeout = to[0]
	}
	t.Cleanup(func() { codexInterruptTimeout = saved })
}

// "Interrupted" is Codex's word that the turn ended, not the runner's that it asked: while Codex has
// not answered turn/interrupt the transcript says nothing, and once it has, it says so once — on the
// turn that was stopped, ahead of that turn's end.
func TestCodexStopMarksInterruptedOnlyOnceCodexConfirms(t *testing.T) {
	s := newCodexStopSession(t, nil, [][]map[string]interface{}{codexRunningTurn()},
		fakeCodexInterruptAnswer{WaitFor: "release-1", Frames: []map[string]interface{}{codexInterruptedTurn("turn-fake-session")}})
	s.startTurn()

	s.stop()
	s.waitForInterrupts(1, 10*time.Second)
	time.Sleep(300 * time.Millisecond)
	if n := s.count(evInterrupt); n != 0 {
		t.Fatalf("the transcript was marked Interrupted %d time(s) before Codex answered turn/interrupt: %s", n, describeRunEvents(s.snapshot()))
	}

	s.fake.releaseInterrupt(t, "release-1")
	marker := s.waitFor("the Interrupted marker", 10*time.Second, func(e RunEvent) bool { return e.Type == evInterrupt })
	if marker.TurnID != "orbit-turn-1" {
		t.Fatalf("the marker went on turn %q, want the stopped orbit-turn-1", marker.TurnID)
	}
	if got := s.completedTurn(10 * time.Second); got.Status != stInterrupted {
		t.Fatalf("the stopped turn completed %q, want %q", got.Status, stInterrupted)
	}
	time.Sleep(100 * time.Millisecond)
	events := s.snapshot()
	markerAt, endAt := -1, -1
	for i, e := range events {
		switch e.Type {
		case evInterrupt:
			if markerAt >= 0 {
				t.Fatalf("the turn was marked Interrupted twice: %s", describeRunEvents(events))
			}
			markerAt = i
		case evTurnEnd:
			endAt = i
		}
	}
	if endAt < markerAt {
		t.Fatalf("the Interrupted marker came after the turn's end: %s", describeRunEvents(events))
	}
	for _, e := range events {
		if isStopFailure(e) {
			t.Fatalf("a confirmed stop reported a failure: %s", describeRunEvents(events))
		}
	}
}

// A Stop whose turn/interrupt Codex refused, or never answered, is not the last word: pressing Stop
// again asks Codex again, and that answer is the one the transcript gets.
func TestCodexRepeatedStopResendsAfterAFailedOrUnansweredInterrupt(t *testing.T) {
	for name, first := range map[string]fakeCodexInterruptAnswer{
		"unanswered": {Silent: true},
		"refused":    {Error: "turn is not interruptible right now"},
	} {
		t.Run(name, func(t *testing.T) {
			shortenCodexInterruptTimeout(t)
			s := newCodexStopSession(t, nil, [][]map[string]interface{}{codexRunningTurn()},
				first, fakeCodexInterruptAnswer{Frames: []map[string]interface{}{codexInterruptedTurn("turn-fake-session")}})
			s.startTurn()

			s.stop()
			s.waitForInterrupts(1, 10*time.Second)
			// Past the wait for an answer to the first, however it went.
			time.Sleep(4 * codexInterruptTimeout)

			s.stop()
			got := s.waitForInterrupts(2, 5*time.Second)
			for i, params := range got[:2] {
				if params["turnId"] != "turn-fake-session" || params["threadId"] != codexStopThread {
					t.Fatalf("turn/interrupt %d addressed %v, want the running turn", i+1, params)
				}
			}
			s.waitFor("the Interrupted marker", 10*time.Second, func(e RunEvent) bool { return e.Type == evInterrupt })
			if req := s.completedTurn(10 * time.Second); req.Status != stInterrupted {
				t.Fatalf("the stopped turn completed %q, want %q", req.Status, stInterrupted)
			}
		})
	}
}

// Codex also runs turns nobody handed it — a background task reporting in — and those are the ones
// somebody reaches for Stop over. With no Orbit turn active, Stop still asks Codex to end the turn
// its notifications say is running, and marks it once Codex has.
func TestCodexStopReachesATurnCodexStartedItself(t *testing.T) {
	s := newCodexStopSession(t, []map[string]interface{}{
		{"method": "turn/started", "params": map[string]interface{}{
			"threadId": codexStopThread, "turn": map[string]interface{}{"id": "turn-self", "status": "inProgress"},
		}},
		{"method": "item/agentMessage/delta", "params": map[string]interface{}{"threadId": codexStopThread, "delta": "a background task reported in"}},
	}, nil, fakeCodexInterruptAnswer{Frames: []map[string]interface{}{codexInterruptedTurn("turn-self")}})
	s.waitFor("Codex's own turn to be under way", 30*time.Second, func(e RunEvent) bool { return e.Type == evTextDelta })

	s.stop()
	got := s.waitForInterrupts(1, 5*time.Second)
	if got[0]["turnId"] != "turn-self" || got[0]["threadId"] != codexStopThread {
		t.Fatalf("turn/interrupt addressed %v, want Codex's own turn-self", got[0])
	}
	s.waitFor("the Interrupted marker", 10*time.Second, func(e RunEvent) bool { return e.Type == evInterrupt })
	for _, e := range s.snapshot() {
		if isStopFailure(e) {
			t.Fatalf("a confirmed stop reported a failure: %s", describeRunEvents(s.snapshot()))
		}
	}
	select {
	case req := <-s.completed:
		t.Fatalf("an Orbit turn was completed for Codex's own turn: %+v", req)
	case <-time.After(100 * time.Millisecond):
	}
}

// A stop that does not take is said in the transcript — Codex's refusal in its own words, or that it
// never confirmed — and is not marked Interrupted: the turn is still running.
func TestCodexStopThatFailsOrIsNotConfirmedWritesAVisibleError(t *testing.T) {
	for name, tc := range map[string]struct {
		answer fakeCodexInterruptAnswer
		says   string
	}{
		"refused":    {fakeCodexInterruptAnswer{Error: "turn is not interruptible right now"}, "turn is not interruptible right now"},
		"unanswered": {fakeCodexInterruptAnswer{Silent: true}, "did not confirm"},
	} {
		t.Run(name, func(t *testing.T) {
			shortenCodexInterruptTimeout(t)
			s := newCodexStopSession(t, nil, [][]map[string]interface{}{codexRunningTurn()}, tc.answer)
			s.startTurn()

			s.stop()
			failure := s.waitFor("the stop's failure in the transcript", 5*time.Second, isStopFailure)
			if message, _ := failure.Payload["message"].(string); !strings.Contains(message, tc.says) {
				t.Fatalf("the failure reads %q, want it to say %q", message, tc.says)
			}
			if failure.TurnID != "orbit-turn-1" {
				t.Fatalf("the failure went on turn %q, want the turn it did not stop", failure.TurnID)
			}
			if n := s.count(evInterrupt); n != 0 {
				t.Fatalf("a stop that did not take was marked Interrupted: %s", describeRunEvents(s.snapshot()))
			}
			select {
			case req := <-s.completed:
				t.Fatalf("the turn the stop did not take on was completed: %+v", req)
			default:
			}
		})
	}
}

// A turn/interrupt Codex refuses because the turn already ended on its own is no failed stop: the
// turn ended, and the transcript says nothing of a stop that did not take — in whichever order the
// refusal and the turn's turn/completed are read. The notification reader is held on the turn's
// last words for a moment, inside the window a refusal waits, so that the refusal is in hand
// before the turn's end is, as it is whenever the reader is behind.
func TestCodexStopRefusedForATurnThatEndedOnItsOwnWritesNoFailure(t *testing.T) {
	const window = time.Second
	for name, framesFirst := range map[string]bool{"ended then refused": true, "refused then ended": false} {
		t.Run(name, func(t *testing.T) {
			shortenCodexInterruptTimeout(t, window)
			s := newCodexStopSession(t, nil, [][]map[string]interface{}{codexRunningTurn()}, fakeCodexInterruptAnswer{
				Error: "no active turn to interrupt", FramesFirst: framesFirst,
				Frames: []map[string]interface{}{
					{"method": "item/agentMessage/delta", "params": map[string]interface{}{"threadId": codexStopThread, "delta": " finishing up"}},
					{"method": "turn/completed", "params": map[string]interface{}{
						"threadId": codexStopThread, "turn": map[string]interface{}{"id": "turn-fake-session", "status": "completed"},
					}},
				},
			})
			s.startTurn()
			s.mu.Lock()
			s.hold = func(kind string, payload map[string]interface{}) {
				if kind == evTextDelta && payload["text"] == " finishing up" {
					time.Sleep(150 * time.Millisecond)
				}
			}
			s.mu.Unlock()

			s.stop()
			if req := s.completedTurn(10 * time.Second); req.Status != stSucceeded {
				t.Fatalf("the turn that ended on its own completed %q, want %q", req.Status, stSucceeded)
			}
			// Past the window a refusal waits in, however it went.
			time.Sleep(window + 300*time.Millisecond)
			for _, e := range s.snapshot() {
				if isStopFailure(e) {
					t.Fatalf("a stop refused for a turn that had ended on its own was reported as failed: %s", describeRunEvents(s.snapshot()))
				}
			}
			if n := s.count(evInterrupt); n != 0 {
				t.Fatalf("a turn that ended on its own was marked Interrupted: %s", describeRunEvents(s.snapshot()))
			}
		})
	}
}

// A Stop with neither an Orbit turn nor a Codex turn running still answers in the transcript: a
// line that there was no running turn to stop — not the Interrupted marker, and not a turn/interrupt
// addressed to nothing.
func TestCodexStopWithNothingRunningSaysSo(t *testing.T) {
	s := newCodexStopSession(t, nil, nil)
	s.waitFor("the session to start", 30*time.Second, func(e RunEvent) bool {
		return e.Type == evSystem && e.Payload["subtype"] == "init"
	})

	s.stop()
	s.waitFor("the transcript to say there was nothing to stop", 5*time.Second, func(e RunEvent) bool {
		notice, _ := e.Payload["notice"].(string)
		return e.Type == evSystem && strings.Contains(notice, "no running turn to stop")
	})
	if n := s.count(evInterrupt); n != 0 {
		t.Fatalf("a Stop that stopped nothing was marked Interrupted: %s", describeRunEvents(s.snapshot()))
	}
	if got := s.interrupts(); len(got) != 0 {
		t.Fatalf("a Stop with nothing running sent turn/interrupt: %v", got)
	}
	for _, e := range s.snapshot() {
		if isStopFailure(e) {
			t.Fatalf("a Stop with nothing running reported a failure: %s", describeRunEvents(s.snapshot()))
		}
	}
}
