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

// A turn the engine starts on its own — a Monitor event, a <task-notification>, a
// ScheduleWakeup — runs on a session whose permit went back at park, so to the pool it
// looked exactly like an idle warm engine: the warm TTL and LRU pressure recycled it in
// the middle of a tool call. Every case here drives the real supervisor
// (runInteractiveSession) against the fake CLI and a stub control plane, with the pool on
// a fake clock: each park is the one completeTurn performs, and each recycle is the timer
// or LRU path the runner really takes.

// supervisedSession is one Claude session under runInteractiveSession. The stub control
// plane records what the runner reports and hands out the turns the test queues.
type supervisedSession struct {
	t    *testing.T
	fake *fakeClaude
	pool *sessionPool
	live *liveSession
	job  *ClaimedSession
	// The session's checkout, which is both where its engine reads/writes files and the directory
	// a reply's own images have to sit in to be uploaded (reply_attachments.go).
	execDir string

	mu      sync.Mutex
	inbox   []RunInboxResponse
	events  []RunEvent
	settled []TurnCompleteRequest
	// The file names of attachments the runner uploaded, in arrival order.
	uploads []string
}

// superviseClaudeSession registers the session active, as a claim does, with one message
// queued for it, and runs its supervisor until the test ends.
func superviseClaudeSession(t *testing.T, pool *sessionPool, script ...fakeStep) *supervisedSession {
	t.Helper()
	return superviseClaudeSessionIn(t, pool, t.TempDir(), script...)
}

// superviseClaudeSessionIn is the same run in an execDir the test names, for a script that has to
// speak about a file the test wrote into the session's checkout (see reply_attachments_test.go).
func superviseClaudeSessionIn(t *testing.T, pool *sessionPool, execDir string, script ...fakeStep) *supervisedSession {
	t.Helper()
	fake := newFakeClaude(t, script...)
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	job := claudeSpawnJob(t)
	// Credentials of the session's own, so the spawn's auth preflight never asks this
	// machine's login about a CLI that is not the real one.
	job.Agent.Env = map[string]string{"ANTHROPIC_API_KEY": "test"}
	s := &supervisedSession{t: t, fake: fake, pool: pool, job: job}
	s.queue(RunInboxResponse{TurnID: "turn-1", Kind: "message", Content: "start the build"})
	api := httptest.NewServer(http.HandlerFunc(s.serve))
	t.Cleanup(api.Close)

	ctx, cancel := context.WithCancel(context.Background())
	live, added := pool.register(job, cancel, true)
	if !added {
		t.Fatal("the session was not registered")
	}
	s.live = live
	s.execDir = execDir
	done := make(chan struct{})
	go func() {
		defer close(done)
		runInteractiveSession(NewTransport(api.URL, "runner-token"), job, ctx, context.Background(),
			s.execDir, nil, pool, live)
		pool.finish(live)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(30 * time.Second):
			t.Error("the supervisor did not return after its session was cancelled")
		}
	})
	return s
}

func (s *supervisedSession) serve(w http.ResponseWriter, r *http.Request) {
	switch {
	case strings.HasSuffix(r.URL.Path, "/inbox"):
		deadline := time.Now().Add(20 * time.Millisecond)
		for time.Now().Before(deadline) && r.Context().Err() == nil {
			s.mu.Lock()
			if len(s.inbox) > 0 {
				turn := s.inbox[0]
				s.inbox = s.inbox[1:]
				s.mu.Unlock()
				_ = json.NewEncoder(w).Encode(turn)
				return
			}
			s.mu.Unlock()
			time.Sleep(2 * time.Millisecond)
		}
	case strings.HasSuffix(r.URL.Path, "/events"):
		var batch RunEventBatch
		if json.NewDecoder(r.Body).Decode(&batch) == nil {
			s.mu.Lock()
			s.events = append(s.events, batch.Events...)
			s.mu.Unlock()
		}
	case strings.HasSuffix(r.URL.Path, "/attachments"):
		// What the runner posts when a reply links a file it wrote (reply_attachments.go): the
		// bytes go up and the answer's id is what the transcript carries instead of the path.
		if err := r.ParseMultipartForm(1 << 20); err == nil && r.MultipartForm != nil {
			s.mu.Lock()
			for _, header := range r.MultipartForm.File["file"] {
				s.uploads = append(s.uploads, header.Filename)
			}
			s.mu.Unlock()
		}
		_, _ = w.Write([]byte(`{"id":"attachment-1"}`))
		return
	case strings.HasSuffix(r.URL.Path, "/turn-complete"):
		// An empty answer parks the session: AWAITING_INPUT.
		var req TurnCompleteRequest
		if json.NewDecoder(r.Body).Decode(&req) == nil {
			s.mu.Lock()
			s.settled = append(s.settled, req)
			s.mu.Unlock()
		}
	}
	_, _ = w.Write([]byte(`{}`))
}

func (s *supervisedSession) queue(turn RunInboxResponse) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.inbox = append(s.inbox, turn)
}

func (s *supervisedSession) countEvents(match func(RunEvent) bool) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, e := range s.events {
		if match(e) {
			n++
		}
	}
	return n
}

// awaitEvents waits until the control plane holds n events matching match. The runner is
// done handling an event before it can be sent, so this is also the moment the pool has
// seen it.
func (s *supervisedSession) awaitEvents(what string, n int, match func(RunEvent) bool) {
	s.t.Helper()
	waitUntil(s.t, func() bool { return s.countEvents(match) >= n }, "the runner never reported "+what)
}

func (s *supervisedSession) settledTurn(turnID string) *TurnCompleteRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.settled {
		if s.settled[i].TurnID == turnID {
			settled := s.settled[i]
			return &settled
		}
	}
	return nil
}

// awaitParked waits for turnID to be acknowledged and for completeTurn to have handed its
// permit back: park, which is where the warm TTL starts.
func (s *supervisedSession) awaitParked(turnID string) {
	s.t.Helper()
	waitUntil(s.t, func() bool { return s.settledTurn(turnID) != nil && !s.pool.isActive(s.live) },
		"turn "+turnID+" was never acknowledged and parked")
}

func isToolUse(id string) func(RunEvent) bool {
	return func(e RunEvent) bool { return e.Type == evToolUse && e.Payload["id"] == id }
}

func isTurnEnd(e RunEvent) bool { return e.Type == evTurnEnd }

// recycleRequested reports whether the pool has asked this engine to go, or has already
// seen it gone. requestEvictLocked marks the engine before the call that asked returns, so
// straight after a clock advance or a claim this is exact; engineStopped later trades the
// mark for resident=false.
func recycleRequested(p *sessionPool, s *liveSession) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return s.evictRequested || !s.resident
}

// selfDrivenScript is an ordinary first turn, then — once the test releases "wake" — a turn
// nobody sent: the engine woken by a Monitor event for the build it left running, opening a
// tool call of its own. What happens next in that turn is up to the steps passed in.
func selfDrivenScript(then ...fakeStep) []fakeStep {
	return append([]fakeStep{
		{Await: "user"},
		{Emit: "replay_user"},
		{Emit: "system_init"},
		{Emit: "assistant", Text: "started the build; watching it"},
		{Emit: "result", Text: "started the build; watching it"},
		{Await: "release", Text: "wake"},
		{Emit: "system_init"},
		{Emit: "tool_use", ToolUseID: "toolu_own", ToolName: "Bash",
			Input: map[string]interface{}{"command": "go test ./..."}},
	}, then...)
}

// ownToolCallEnds holds the engine's tool call open until the test releases "tool-done",
// then ends the turn.
var ownToolCallEnds = []fakeStep{
	{Await: "release", Text: "tool-done"},
	{Emit: "tool_result", ToolUseID: "toolu_own", Text: "ok"},
	{Emit: "result", Text: "tests pass"},
}

func TestSelfDrivenTurnIsNotRecycledByWarmTTL(t *testing.T) {
	clock := newFakePoolClock()
	pool := newSessionPoolWithClock(1, clock)
	s := superviseClaudeSession(t, pool, selfDrivenScript(ownToolCallEnds...)...)
	s.awaitParked("turn-1")

	s.fake.Release("wake")
	s.awaitEvents("the engine's own tool_use", 1, isToolUse("toolu_own"))
	clock.Advance(warmEngineTTL + time.Second)
	if recycleRequested(pool, s.live) {
		t.Fatal("the warm TTL recycled an engine in the middle of a tool call it started on its own")
	}

	// The paired positive: what is protected is the running turn, and nothing else. Once it
	// ends the engine is idle warm capacity, and the same timer takes it.
	s.fake.Release("tool-done")
	s.awaitEvents("the end of the engine's own turn", 2, isTurnEnd)
	clock.Advance(warmEngineTTL)
	if !recycleRequested(pool, s.live) {
		t.Fatal("the engine was never recycled after its own turn ended: the protection outlived the turn")
	}
	waitUntil(t, func() bool { return !pool.engineResident(s.live) }, "the recycled engine was never reaped")
	if n := len(s.fake.Spawns()); n != 1 {
		t.Fatalf("claude was spawned %d times, want 1", n)
	}
}

func TestSelfDrivenTurnRearmsWarmTTLAtItsEnd(t *testing.T) {
	clock := newFakePoolClock()
	pool := newSessionPoolWithClock(1, clock)
	s := superviseClaudeSession(t, pool, selfDrivenScript(ownToolCallEnds...)...)
	s.awaitParked("turn-1")

	s.fake.Release("wake")
	s.awaitEvents("the engine's own tool_use", 1, isToolUse("toolu_own"))
	// Well inside the TTL park wound, so that timer is still pending when the turn ends.
	const toolCall = 10 * time.Minute
	clock.Advance(toolCall)
	s.fake.Release("tool-done")
	s.awaitEvents("the end of the engine's own turn", 2, isTurnEnd)
	ended := clock.Now()

	// Park's timer would fire warmEngineTTL-toolCall from here; the engine is owed a whole
	// warmEngineTTL from the moment its turn ended.
	clock.Advance(warmEngineTTL - time.Nanosecond)
	if recycleRequested(pool, s.live) {
		t.Fatalf("recycled %s after its own turn ended, want a full %s", warmEngineTTL-time.Nanosecond, warmEngineTTL)
	}
	clock.Advance(time.Nanosecond)
	if !recycleRequested(pool, s.live) {
		t.Fatalf("still not recycled %s after its own turn ended", warmEngineTTL)
	}
	pool.mu.Lock()
	lastActive := s.live.lastActive
	pool.mu.Unlock()
	if !lastActive.Equal(ended) {
		t.Fatalf("LRU position = %v, want the end of the engine's own turn (%v)", lastActive, ended)
	}
}

func TestSelfDrivenTurnIsSkippedByLRU(t *testing.T) {
	clock := newFakePoolClock()
	pool := newSessionPoolWithClock(2, clock)
	s := superviseClaudeSession(t, pool, selfDrivenScript(ownToolCallEnds...)...)
	s.awaitParked("turn-1")

	// A second warm engine, parked a minute later: in LRU order the engine that is about to
	// run a turn of its own is the one that goes first.
	clock.Advance(time.Minute)
	other := registerPoolSession(t, pool, "other", true)
	otherCancelled := 0
	otherGeneration := startPoolEngine(t, pool, other, &otherCancelled)
	parkPoolSession(pool, other)

	s.fake.Release("wake")
	s.awaitEvents("the engine's own tool_use", 1, isToolUse("toolu_own"))

	// A cold claim leaves room for one warm engine.
	claimant := registerPoolSession(t, pool, "claimant", true)
	if recycleRequested(pool, s.live) {
		t.Fatal("LRU pressure recycled the engine in the middle of a turn it started on its own")
	}
	if otherCancelled != 1 {
		t.Fatalf("the idle warm engine was recycled %d times, want 1: the pressure is still met by warm capacity that is idle", otherCancelled)
	}
	pool.engineStopped(other, otherGeneration)
	claimantCancelled := 0
	startPoolEngine(t, pool, claimant, &claimantCancelled)

	// Another cold claim, now at the resident cap with no idle warm engine left. The turn is
	// already running and cannot be refused, so the start waits for it instead of recycling it.
	late := registerPoolSession(t, pool, "late", true)
	reserveCtx, cancelReserve := context.WithCancel(context.Background())
	t.Cleanup(cancelReserve)
	reserved := make(chan bool, 1)
	go func() {
		_, _, ok := pool.reserveEngine(late, reserveCtx, context.Background())
		reserved <- ok
	}()
	select {
	case <-reserved:
		t.Fatal("a cold start went past the resident cap while the only warm engine was mid-turn")
	case <-time.After(100 * time.Millisecond):
	}
	if recycleRequested(pool, s.live) {
		t.Fatal("a cold start at the resident cap recycled the engine in the middle of its own turn")
	}

	// The turn ends; the engine is idle warm capacity again, and the waiting start gets it.
	s.fake.Release("tool-done")
	select {
	case ok := <-reserved:
		if !ok {
			t.Fatal("the waiting cold start gave up")
		}
	case <-time.After(fakeClaudeTimeout):
		t.Fatal("the cold start never got the engine whose turn had ended")
	}
	if !recycleRequested(pool, s.live) || claimantCancelled != 0 {
		t.Fatalf("the start was not made room for by the engine whose turn ended (own recycled: %v, claimant cancels: %d)",
			recycleRequested(pool, s.live), claimantCancelled)
	}
}

// What happens today when a claim arrives while the engine runs a turn of its own, pinned
// so that protecting that turn does not change it: the claim takes over the resident engine
// without recycling it, the message is written into that same process, the result that ends
// the running turn answers it, and the session parks with an ordinary warm TTL.
func TestClaimDuringSelfDrivenTurnKeepsExistingHandoff(t *testing.T) {
	clock := newFakePoolClock()
	pool := newSessionPoolWithClock(1, clock)
	s := superviseClaudeSession(t, pool, selfDrivenScript(
		fakeStep{Await: "user"},       // the claimed message, written while the engine's own turn runs
		fakeStep{Emit: "replay_user"}, // …and folded into that turn at its tool boundary
		fakeStep{Emit: "tool_result", ToolUseID: "toolu_own", Text: "ok"},
		fakeStep{Emit: "result", Text: "tests pass; widget renamed"},
	)...)
	s.awaitParked("turn-1")
	s.fake.Release("wake")
	s.awaitEvents("the engine's own tool_use", 1, isToolUse("toolu_own"))

	// The claim as runLoop hands it over; the control plane has the session RUNNING.
	claim := *s.job
	if _, ok := pool.activate(&claim); !ok {
		t.Fatal("a claim could not activate a session whose engine was running a turn of its own")
	}
	if recycleRequested(pool, s.live) || pool.residentCount() != 1 {
		t.Fatal("the claim did not take over the resident engine as it is")
	}
	s.queue(RunInboxResponse{TurnID: "turn-2", Kind: "message", Content: "rename the widget"})

	s.awaitParked("turn-2")
	settled := s.settledTurn("turn-2")
	if settled.Status != stSucceeded || settled.Result != "tests pass; widget renamed" {
		t.Fatalf("turn-2 settled as %+v, want the result that ended the turn it was written into", settled)
	}
	if n := len(s.fake.Spawns()); n != 1 {
		t.Fatalf("claude was spawned %d times, want 1: the message goes to the engine already running", n)
	}
	frames := s.fake.Stdin()
	if len(frames) != 2 || userFrameText(t, frames[1]) != "rename the widget" {
		t.Fatalf("stdin frames = %v, want turn-1's message then turn-2's", frames)
	}

	// Parked like any other turn: one warmEngineTTL from here, with nothing left over from the
	// turn the engine had started on its own.
	clock.Advance(warmEngineTTL - time.Nanosecond)
	if recycleRequested(pool, s.live) {
		t.Fatal("recycled before a full TTL after the handed-off turn parked")
	}
	clock.Advance(time.Nanosecond)
	if !recycleRequested(pool, s.live) {
		t.Fatal("not recycled a full TTL after the handed-off turn parked")
	}
}

// The pool reads an engine's turn off the stream exactly as the control plane's
// engineTurnActiveAfter does (apiserver runner-api/engine-turn.ts), so a session the
// clients show as working is one the pool does not recycle, and the other way round.
func TestEngineTurnSignalReadsTheStreamLikeTheControlPlane(t *testing.T) {
	type signal struct{ generating, ended bool }
	for _, c := range []struct {
		name      string
		eventType string
		payload   map[string]interface{}
		want      signal
	}{
		{"assistant text", evAssistant, map[string]interface{}{"text": "x"}, signal{generating: true}},
		{"thinking", evThinking, map[string]interface{}{"text": "x"}, signal{generating: true}},
		{"engine tool_use", evToolUse, map[string]interface{}{"id": "toolu_1"}, signal{generating: true}},
		{"engine tool_result", evToolResult, map[string]interface{}{"toolUseId": "toolu_1"}, signal{generating: true}},
		{"runner shell tool_use", evToolUse, map[string]interface{}{"id": "shell-turn-1"}, signal{}},
		{"runner shell tool_result", evToolResult, map[string]interface{}{"toolUseId": "shell-turn-1"}, signal{}},
		{"turn_end", evTurnEnd, map[string]interface{}{}, signal{ended: true}},
		{"init handshake", evSystem, map[string]interface{}{"subtype": "init"}, signal{ended: true}},
		{"resumed handshake", evSystem, map[string]interface{}{"subtype": "resumed"}, signal{ended: true}},
		{"engine phase ping", evSystem, map[string]interface{}{"subtype": "status", "enginePhase": "compacting"}, signal{}},
		{"text delta", evTextDelta, map[string]interface{}{"text": "x"}, signal{}},
		{"background task report", evBackgroundTask, map[string]interface{}{"status": "completed"}, signal{}},
		{"user message", evUser, map[string]interface{}{"text": "x"}, signal{}},
	} {
		generating, ended := engineTurnSignal(c.eventType, c.payload)
		if got := (signal{generating, ended}); got != c.want {
			t.Errorf("%s: %+v, want %+v", c.name, got, c.want)
		}
	}
}

// An engine that dies in the middle of a turn of its own never reports that turn's end.
// The engine that replaces it starts idle: parked, it is recycled on the ordinary TTL.
func TestEngineStoppingMidSelfDrivenTurnLeavesNothingBehind(t *testing.T) {
	clock := newFakePoolClock()
	p := newSessionPoolWithClock(1, clock)
	s := registerPoolSession(t, p, "crash", true)
	cancelled := 0
	crashed := startPoolEngine(t, p, s, &cancelled)
	parkPoolSession(p, s)
	p.engineTurnEvent(s, evToolUse, map[string]interface{}{"id": "toolu_1"})
	clock.Advance(warmEngineTTL)
	if cancelled != 0 {
		t.Fatal("the engine was recycled in the middle of its own turn, so this is not the state a crash leaves")
	}
	p.engineStopped(s, crashed)

	if _, ok := p.activate(poolJob("crash")); !ok {
		t.Fatal("the next claim was not activated")
	}
	startPoolEngine(t, p, s, &cancelled)
	parkPoolSession(p, s)
	clock.Advance(warmEngineTTL)
	if cancelled != 1 {
		t.Fatalf("the replacement engine was recycled %d times at its TTL, want 1: the dead engine's turn outlived it", cancelled)
	}
}
