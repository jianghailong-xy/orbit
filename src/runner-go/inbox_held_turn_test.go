package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// heldTurnStub is a control plane for one session loop: an inbox it hands out in order, and the turn completions it
// takes, each answered AWAITING_INPUT.
type heldTurnStub struct {
	t      *testing.T
	server *httptest.Server

	mu        sync.Mutex
	inbox     []RunInboxResponse
	handedOut []string
	// drainingSaid is what each inbox fetch said of the draining flag ("" for nothing), in order.
	drainingSaid []string
	settled      []TurnCompleteRequest
}

func newHeldTurnStub(t *testing.T) *heldTurnStub {
	t.Helper()
	s := &heldTurnStub{t: t}
	s.server = httptest.NewServer(http.HandlerFunc(s.serve))
	t.Cleanup(s.server.Close)
	return s
}

func (s *heldTurnStub) serve(w http.ResponseWriter, r *http.Request) {
	switch {
	case strings.HasSuffix(r.URL.Path, "/inbox"):
		s.mu.Lock()
		s.drainingSaid = append(s.drainingSaid, r.URL.Query().Get("draining"))
		s.mu.Unlock()
		// Answers at once when something is queued, and after a moment when nothing is, as a fetch with
		// nothing to hand out is answered.
		deadline := time.Now().Add(20 * time.Millisecond)
		for time.Now().Before(deadline) && r.Context().Err() == nil {
			s.mu.Lock()
			if len(s.inbox) > 0 {
				turn := s.inbox[0]
				s.inbox = s.inbox[1:]
				s.handedOut = append(s.handedOut, turn.TurnID)
				s.mu.Unlock()
				_ = json.NewEncoder(w).Encode(turn)
				return
			}
			s.mu.Unlock()
			time.Sleep(2 * time.Millisecond)
		}
	case strings.HasSuffix(r.URL.Path, "/turn-complete"):
		var req TurnCompleteRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		s.mu.Lock()
		s.settled = append(s.settled, req)
		s.mu.Unlock()
		_ = json.NewEncoder(w).Encode(TurnCompleteResponse{OK: true, Status: stAwaitingInput})
		return
	}
	_, _ = w.Write([]byte(`{}`))
}

func (s *heldTurnStub) queue(turn RunInboxResponse) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.inbox = append(s.inbox, turn)
}

func (s *heldTurnStub) wasHandedOut(turnID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Contains(s.handedOut, turnID)
}

func (s *heldTurnStub) settledTurn(turnID string) *TurnCompleteRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.settled {
		if s.settled[i].TurnID == turnID {
			req := s.settled[i]
			return &req
		}
	}
	return nil
}

// recordedEmits is what a session loop emitted, by kind, with the noticeKind of each notice.
type recordedEmits struct {
	mu          sync.Mutex
	kinds       []string
	noticeKinds []string
}

func (e *recordedEmits) emit(kind string, payload map[string]interface{}) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.kinds = append(e.kinds, kind)
	if notice, ok := payload["noticeKind"].(string); ok {
		e.noticeKinds = append(e.noticeKinds, notice)
	}
}

func (e *recordedEmits) saw(kind string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return slices.Contains(e.kinds, kind)
}

func (e *recordedEmits) sawNotice(noticeKind string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return slices.Contains(e.noticeKinds, noticeKind)
}

// heldFollowUpSession is a session whose turn ended while the pool drained for an update, with the control plane
// keeping its permit for the follow-up queued behind it (holdFollowUpForUpdate): the follow-up may not start until the
// update, and the permit wait every session loop asks (waitTurnPermit) is the pool's own.
func heldFollowUpSession(t *testing.T, id string) (*sessionPool, *liveSession, turnPermitWaiter) {
	t.Helper()
	pool := newSessionPool(2)
	live := registerPoolSession(t, pool, id, true)
	pool.drainForUpdate()
	pool.holdFollowUpForUpdate(live, pool.permitGeneration(live))
	if startsNow(pool, live) {
		t.Fatal("the follow-up was not held for the update")
	}
	permit := func(ctx context.Context) bool { return pool.waitActive(live, ctx, context.Background()) }
	return pool, live, permit
}

// heldInterruptWithin is how long an interrupt filed behind a held follow-up may take to be handled. Without the fix it
// is never read at all, so this is what bounds the failure.
const heldInterruptWithin = 5 * time.Second

// waitWithin waits up to within for ok, and fails the test with whenNot if it never holds.
func waitWithin(t *testing.T, within time.Duration, ok func() bool, whenNot string) {
	t.Helper()
	deadline := time.Now().Add(within)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal(whenNot)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// A Stop pressed while the runner drains for an update, on a session whose follow-up is held for it
// (docs/runner-update-drain-design.md §7.2): the session loop had fetched the follow-up and was waiting for its permit,
// which the update holds back. The interrupt filed behind it is still read and handled within a bounded time, the held
// follow-up is handed back unrun (INTERRUPTED, never written to the engine) and the engine is asked to stop as the
// interrupt arm always asks it. The claude and codex app-server loops are driven here; every loop that takes its turns
// through the shared inbox poller shares the mechanism (inboxPoller.holdTurns).
func TestAnInterruptFiledBehindAFollowUpHeldForTheUpdateIsHandled(t *testing.T) {
	const followUp = "delete the widget"
	cases := []struct {
		engine string
		run    func(t *testing.T, tr *Transport, id string, permit turnPermitWaiter, complete turnCompleter, emits *recordedEmits) (ran func() bool, interrupted func() bool)
	}{
		{engine: providerClaude, run: func(t *testing.T, tr *Transport, id string, permit turnPermitWaiter, complete turnCompleter, emits *recordedEmits) (func() bool, func() bool) {
			isolateClaudeRegionEnv(t)
			engineOutwaitsTheTest(t)
			fake := newFakeClaude(t,
				fakeStep{Emit: "system_init"},
				fakeStep{Await: "control_request", Subtype: "interrupt"},
				fakeStep{Emit: "control_response"},
				fakeStep{Await: "user"},
			)
			t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
			job := claudeSpawnJob(t)
			job.SessionID = id
			job.Agent.Env = anthropicKey()
			dir := t.TempDir()
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			go func() {
				defer close(done)
				runClaudeSessionProcess(ctx, context.Background(), tr, job, "gen-1", dir, dir, emits.emit,
					func(string, string, map[string]interface{}) {}, func(string) {}, true, nil, complete, permit, func(error) {})
			}()
			t.Cleanup(func() { cancel(); <-done })
			ran := func() bool {
				for _, line := range fake.readLines("stdin.jsonl") {
					if strings.Contains(line, `"type":"user"`) && strings.Contains(line, followUp) {
						return true
					}
				}
				return false
			}
			interrupted := func() bool {
				for _, line := range fake.readLines("stdin.jsonl") {
					if strings.Contains(line, `"control_request"`) && strings.Contains(line, `"interrupt"`) {
						return emits.saw(evInterrupt)
					}
				}
				return false
			}
			return ran, interrupted
		}},
		{engine: providerCodex, run: func(t *testing.T, tr *Transport, id string, permit turnPermitWaiter, complete turnCompleter, emits *recordedEmits) (func() bool, func() bool) {
			fake := newFakeCodexBinary(t, map[string]interface{}{}, map[string]interface{}{})
			fake.useAsRunnerDefault(t)
			fake.answerSessionsWith(t)
			fake.answerTurnsWith(t, codexCompletedAttempt("deleted it"))
			job := &ClaimedSession{SessionID: id, Provider: providerCodex, Agent: AgentExecConfig{Provider: providerCodex}}
			dir := t.TempDir()
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			go func() {
				defer close(done)
				runCodexAppServerSessionProcess(ctx, context.Background(), tr, job, "gen-1", dir, t.TempDir(), emits.emit,
					func(string, string, map[string]interface{}) {}, func(string) {}, false, nil, nil, complete, permit, func(error) {})
			}()
			t.Cleanup(func() { cancel(); <-done })
			ran := func() bool {
				for _, line := range fake.lines(t, "requests.jsonl") {
					if strings.Contains(line, `"turn/start"`) && strings.Contains(line, followUp) {
						return true
					}
				}
				return false
			}
			// Nothing is running (the follow-up was never started), so Codex's answer to the Stop is that notice, not
			// the Interrupted marker.
			return ran, func() bool { return emits.sawNotice("codex-stop-nothing-running") }
		}},
	}
	for _, c := range cases {
		t.Run(c.engine, func(t *testing.T) {
			id := "sess-held-" + c.engine
			stub := newHeldTurnStub(t)
			tr := NewTransport(stub.server.URL, "runner-token")
			pool, _, permit := heldFollowUpSession(t, id)
			tr.draining = pool.isDrainingForUpdate
			complete := func(req TurnCompleteRequest, _ ...context.Context) error {
				_, err := tr.turnComplete(context.Background(), id, req)
				return err
			}
			emits := &recordedEmits{}
			stub.queue(RunInboxResponse{TurnID: "turn-2", Kind: "message", Content: followUp})
			ran, interrupted := c.run(t, tr, id, permit, complete, emits)

			waitWithin(t, heldInterruptWithin, func() bool { return stub.wasHandedOut("turn-2") }, "the follow-up was never fetched")
			// The loop has the follow-up and waits for its permit, which the update holds back. Stop is pressed.
			time.Sleep(100 * time.Millisecond)
			stub.queue(RunInboxResponse{TurnID: "stop-1", Kind: "interrupt", Content: `{"stopBackgroundWork":true}`})

			waitWithin(t, heldInterruptWithin, func() bool { return stub.wasHandedOut("stop-1") },
				"the interrupt filed behind the follow-up held for the update was never read")
			waitWithin(t, heldInterruptWithin, interrupted, "the interrupt was read but the engine was never asked to stop")
			waitWithin(t, heldInterruptWithin, func() bool { return stub.settledTurn("turn-2") != nil },
				"the held follow-up was never handed back")
			if got := stub.settledTurn("turn-2"); got.Status != stInterrupted {
				t.Fatalf("the held follow-up was handed back %s, want %s", got.Status, stInterrupted)
			}
			// Nothing may start it afterwards either.
			time.Sleep(200 * time.Millisecond)
			if ran() {
				t.Fatal("the held follow-up reached the engine")
			}
			// Every fetch, the one that handed the follow-up out included, said the pool drains for an update.
			stub.mu.Lock()
			said := slices.Clone(stub.drainingSaid)
			stub.mu.Unlock()
			for i, d := range said {
				if d != "1" {
					t.Fatalf("inbox fetch %d of %d said draining=%q while the pool drained for an update, want \"1\"", i+1, len(said), d)
				}
			}
		})
	}
}

// Every inbox fetch says draining=1 while the pool drains for an update (docs/runner-update-drain-design.md §7.2), and
// says nothing before the drain or once it has been put off.
func TestEveryInboxFetchSaysDrainingWhileThePoolDrainsForAnUpdate(t *testing.T) {
	stub := newHeldTurnStub(t)
	tr := NewTransport(stub.server.URL, "runner-token")
	pool := newSessionPool(2)
	tr.draining = pool.isDrainingForUpdate
	inbox := newInboxPoller(tr, "sess-draining", "gen-1")
	defer inbox.close()
	ctx, cancel := context.WithTimeout(context.Background(), heldInterruptWithin)
	defer cancel()
	fetch := func(turnID, want string) {
		t.Helper()
		stub.mu.Lock()
		from := len(stub.drainingSaid)
		stub.mu.Unlock()
		stub.queue(RunInboxResponse{TurnID: turnID, Kind: "diff"})
		if resp, err := inbox.next(ctx); err != nil || resp.TurnID != turnID {
			t.Fatalf("fetching %s: %v, %v", turnID, resp, err)
		}
		stub.mu.Lock()
		said := slices.Clone(stub.drainingSaid[from:])
		stub.mu.Unlock()
		for _, d := range said {
			if d != want {
				t.Fatalf("a fetch for %s said draining=%q, want %q", turnID, d, want)
			}
		}
	}
	fetch("before", "")
	pool.drainForUpdate()
	fetch("during", "1")
	fetch("still-during", "1")
	pool.endDrainForUpdate()
	fetch("after", "")
}

// fakePermit is a session loop's waitTurnPermit the test opens: until then it waits, as waitActive does while the
// update holds the session's follow-up.
type fakePermit struct {
	mu   sync.Mutex
	open bool
	ch   chan struct{}
}

func newFakePermit() *fakePermit { return &fakePermit{ch: make(chan struct{})} }

func (f *fakePermit) wait(ctx context.Context) bool {
	f.mu.Lock()
	if f.open {
		f.mu.Unlock()
		return true
	}
	ch := f.ch
	f.mu.Unlock()
	select {
	case <-ch:
		return true
	case <-ctx.Done():
		return false
	}
}

func (f *fakePermit) grant() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.open {
		f.open = true
		close(f.ch)
	}
}

// The mechanism itself, which every session loop takes its turns through (holdTurns): a message or shell turn whose
// permit has not come is held, and the control turns filed behind it are handed on meanwhile; once its permit comes it
// is handed on; an interrupt hands a held turn back unrun, as INTERRUPTED, before the interrupt itself is handed on.
func TestThePollerHoldsATurnWaitingForItsPermitAndReadsOn(t *testing.T) {
	for _, kind := range []string{"message", "shell"} {
		t.Run(kind, func(t *testing.T) {
			stub := newHeldTurnStub(t)
			tr := NewTransport(stub.server.URL, "runner-token")
			inbox := newInboxPoller(tr, "sess-hold", "gen-1")
			defer inbox.close()
			permit := newFakePermit()
			var mu sync.Mutex
			var handedBack []TurnCompleteRequest
			complete := func(req TurnCompleteRequest, _ ...context.Context) error {
				mu.Lock()
				defer mu.Unlock()
				handedBack = append(handedBack, req)
				return nil
			}
			inbox.holdTurns(permit.wait, &ClaimedSession{SessionID: "sess-hold"}, complete)
			ctx, cancel := context.WithTimeout(context.Background(), heldInterruptWithin)
			defer cancel()
			next := func(want string) {
				t.Helper()
				resp, err := inbox.next(ctx)
				if err != nil || resp.TurnID != want {
					t.Fatalf("handed %v (%v), want %s", resp, err, want)
				}
			}

			// Held, with every control turn behind it handed on.
			stub.queue(RunInboxResponse{TurnID: "held-1", Kind: kind, Content: "work"})
			for _, control := range []string{"diff", "setconfig", "withdraw", "steer"} {
				stub.queue(RunInboxResponse{TurnID: control + "-1", Kind: control})
			}
			for _, control := range []string{"diff", "setconfig", "withdraw", "steer"} {
				next(control + "-1")
			}
			// The held turn handed over again while it waits is the same turn, not a second one.
			stub.queue(RunInboxResponse{TurnID: "held-1", Kind: kind, Content: "work"})
			stub.queue(RunInboxResponse{TurnID: "diff-2", Kind: "diff"})
			next("diff-2")
			// Its permit comes: it is handed on.
			permit.grant()
			next("held-1")
			mu.Lock()
			if len(handedBack) != 0 {
				t.Fatalf("a turn whose permit came was handed back: %+v", handedBack)
			}
			mu.Unlock()

			// Held again, then an interrupt: the held turn is handed back unrun and the interrupt handed on.
			permit2 := newFakePermit()
			inbox.permit = permit2.wait
			stub.queue(RunInboxResponse{TurnID: "held-2", Kind: kind, Content: "more work"})
			stub.queue(RunInboxResponse{TurnID: "stop-1", Kind: "interrupt"})
			next("stop-1")
			mu.Lock()
			got := slices.Clone(handedBack)
			mu.Unlock()
			if len(got) != 1 || got[0].TurnID != "held-2" || got[0].Status != stInterrupted {
				t.Fatalf("handed back %+v, want held-2 INTERRUPTED", got)
			}
			// Nothing hands it on afterwards, even once its permit comes.
			permit2.grant()
			stub.queue(RunInboxResponse{TurnID: "end-1", Kind: "end"})
			next("end-1")
		})
	}
}

// Every session loop that takes its turns through the inbox poller has it hold the turns that wait for their permit:
// the mechanism the tests above drive for claude, codex and the poller itself is the one each of the eight loops uses.
func TestEverySessionLoopHasItsPollerHoldTurnsWaitingForAPermit(t *testing.T) {
	for _, f := range []string{"session.go", "codex.go", "codex_appserver.go", "kimi_acp.go", "opencode.go", "antigravity.go",
		"cursor_acp.go", "dsh_acp.go"} {
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if n := strings.Count(string(src), ".holdTurns("); n != 1 {
			t.Errorf("%s calls holdTurns %d times, want 1 (after its newInboxPoller)", f, n)
		}
	}
}
