//go:build linux || darwin

package main

import (
	"context"
	"encoding/json"
	"os"
	"slices"
	"testing"
	"time"
)

// The region check's gates, driven through the real supervisor (runInteractiveSession) against the fake CLI
// and a stub control plane that also answers the check: a spawn the region refuses, a message refused at a
// running engine, a claim refused at a warm one, and the turns a blocked runner still runs.

// regionRig is one Claude session under its real supervisor, on a runner named atlas whose region check asks
// the stub that serves the session. It starts the way a claim leaves it, active with turn-1 queued, and the
// check's clock moves only when the test moves it.
type regionRig struct {
	*regionStub
	fake  *fakeClaude
	pool  *sessionPool
	live  *liveSession
	job   *ClaimedSession
	clock *fakePoolClock
	check *claudeRegionCheck
	done  chan struct{}
}

// newRegionRig runs a session whose env is env, against a region-check route answering answer. status answers
// its turn-completes (nil: as today's control plane does). The test isolates the environment first
// (isolateClaudeRegionEnv).
func newRegionRig(t *testing.T, answer string, env map[string]string, status func(TurnCompleteRequest) string, script ...fakeStep) *regionRig {
	t.Helper()
	rig := prepareRegionRig(t, answer, status)
	job := claudeSpawnJob(t)
	job.Agent.Env = env
	rig.start(job, script...)
	return rig
}

// prepareRegionRig is a rig's runner before its session starts: the stub, and the region check that asks it,
// which checks again a minute after a flip, as runLoop's does. A test can put the check where it wants it
// before start.
func prepareRegionRig(t *testing.T, answer string, status func(TurnCompleteRequest) string) *regionRig {
	t.Helper()
	stub := newRegionStub(t, answer)
	stub.status = status
	clock := newFakePoolClock()
	check := installRegionCheck(t, stub, clock)
	check.lifetime = context.Background()
	return &regionRig{regionStub: stub, clock: clock, check: check, done: make(chan struct{})}
}

// start runs job, on a fake CLI that plays script.
func (r *regionRig) start(job *ClaimedSession, script ...fakeStep) {
	r.t.Helper()
	r.fake = newFakeClaude(r.t, script...)
	r.t.Setenv("PATH", r.fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	r.run(job)
}

// beside runs job as a second session on the rig's runner — the same region check and the same fake CLI —
// with a stub of its own for its control-plane traffic, answering its turn-completes with status.
func (r *regionRig) beside(job *ClaimedSession, status func(TurnCompleteRequest) string) *regionRig {
	r.t.Helper()
	stub := newRegionStub(r.t, regionAnswerNotFound) // its route is never asked: the rig's check asks the rig's
	stub.status = status
	other := &regionRig{regionStub: stub, fake: r.fake, clock: r.clock, check: r.check, done: make(chan struct{})}
	other.run(job)
	return other
}

func (r *regionRig) run(job *ClaimedSession) {
	t := r.t
	t.Helper()
	r.job = job
	r.queue(RunInboxResponse{TurnID: "turn-1", Kind: "message", Content: "rename the widget"})
	r.pool = newSessionPool(2)
	ctx, cancel := context.WithCancel(context.Background())
	live, added := r.pool.register(job, cancel, true)
	if !added {
		t.Fatal("the session was not registered")
	}
	r.live = live
	execDir := t.TempDir()
	go func() {
		defer close(r.done)
		runInteractiveSession(NewTransport(r.server.URL, "runner-token"), job, ctx, context.Background(), execDir, nil, r.pool, live)
		r.pool.finish(live)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-r.done:
		case <-time.After(30 * time.Second):
			t.Error("the supervisor did not return after its session was cancelled")
		}
	})
}

func (r *regionRig) queue(turn RunInboxResponse) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.inbox = append(r.inbox, turn)
}

// awaitEnd waits for the supervisor to return on its own: a finalized run, or a failed turn's acknowledgement.
func (r *regionRig) awaitEnd() {
	r.t.Helper()
	select {
	case <-r.done:
	case <-time.After(2 * fakeClaudeTimeout):
		r.t.Fatal("the supervisor never ended the run")
	}
}

func (r *regionRig) settledTurn(turnID string) *TurnCompleteRequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.settled {
		if r.settled[i].TurnID == turnID {
			settled := r.settled[i]
			return &settled
		}
	}
	return nil
}

func (r *regionRig) awaitSettled(turnID string) *TurnCompleteRequest {
	r.t.Helper()
	waitUntil(r.t, func() bool { return r.settledTurn(turnID) != nil }, "turn "+turnID+" was never settled")
	return r.settledTurn(turnID)
}

func (r *regionRig) finalizes() []RunFinalizeRequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]RunFinalizeRequest(nil), r.finalized...)
}

func (r *regionRig) wasHandedOut(turnID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Contains(r.handedOut, turnID)
}

// errors lists the messages of the error events the control plane holds, in order.
func (r *regionRig) errors() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, e := range r.events {
		if e.Type == evError {
			msg, _ := e.Payload["message"].(string)
			out = append(out, msg)
		}
	}
	return out
}

func (r *regionRig) hasEvent(eventType, text string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, e := range r.events {
		if e.Type == eventType && e.Payload["text"] == text {
			return true
		}
	}
	return false
}

// engineRead reports whether the CLI has read a user frame carrying text off its stdin.
func (r *regionRig) engineRead(text string) bool {
	for _, line := range r.fake.readLines("stdin.jsonl") {
		var frame struct {
			Message struct {
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal([]byte(line), &frame) != nil {
			continue
		}
		for _, block := range frame.Message.Content {
			if block.Type == "text" && block.Text == text {
				return true
			}
		}
	}
	return false
}

// anthropicKey is a session on an Anthropic API key: no base URL, so it talks to Anthropic. Its own credential
// keeps the spawn's sign-in preflight from asking this machine's login about a CLI that is not the real one.
func anthropicKey() map[string]string { return map[string]string{"ANTHROPIC_API_KEY": "test"} }

// answersTwoTurns is a CLI that answers a message, then waits for the next and answers that too: what it does
// with the second is what a test that refuses it asserts never happens.
var answersTwoTurns = []fakeStep{
	{Await: "user"}, {Emit: "replay_user"}, {Emit: "system_init"},
	{Emit: "assistant", Text: "renamed it"}, {Emit: "result", Text: "renamed it"},
	{Await: "user"}, {Emit: "replay_user"},
	{Emit: "assistant", Text: "deleted it"}, {Emit: "result", Text: "deleted it"},
}

const secondMessage = "now delete the old one"

// Blocked: no claude process is spawned for an Anthropic-bound turn, and the run reports region_refused with the
// sentence, on finalize. Nothing is taken off the session's inbox, so its message is still waiting.
func TestBlockedRegionSpawnsNoClaude(t *testing.T) {
	isolateClaudeRegionEnv(t)
	rig := newRegionRig(t, regionAnswerBlocked, anthropicKey(), nil, answersTwoTurns...)
	rig.awaitEnd()

	if spawns := rig.fake.Spawns(); len(spawns) != 0 {
		t.Fatalf("claude was spawned %d time(s) for a turn the region refuses", len(spawns))
	}
	finals := rig.finalizes()
	if len(finals) != 1 {
		t.Fatalf("finalized %d times, want once", len(finals))
	}
	if f := finals[0]; f.Status != stFailed || f.Subtype != claudeRegionRefusedSubtype || f.Error != atlasRussiaRefusal {
		t.Fatalf("finalize = %s / %q / %q, want FAILED / region_refused / %q", f.Status, f.Subtype, f.Error, atlasRussiaRefusal)
	}
	if errs := rig.errors(); len(errs) != 1 || errs[0] != atlasRussiaRefusal {
		t.Fatalf("the transcript's errors are %q, want the refusal once", errs)
	}
	if rig.wasHandedOut("turn-1") || rig.settledTurn("turn-1") != nil {
		t.Fatal("the refused run took its message off the inbox or settled it")
	}
	if checks := rig.checksSoFar(); !slices.Equal(checks, []string{"0"}) {
		t.Fatalf("checks = %q, want one, directly", checks)
	}
}

// Blocked, a turn that does not talk to Anthropic runs as it always did: DeepSeek's endpoint named by the
// session's env or by settings.json, and Bedrock. None of them asks the check.
func TestBlockedRegionRunsTurnsThatDoNotTalkToAnthropic(t *testing.T) {
	const deepseek = "https://api.deepseek.com/anthropic"
	for _, c := range []struct {
		name     string
		env      map[string]string
		settings map[string]interface{}
	}{
		{"DeepSeek in the session env", map[string]string{"ANTHROPIC_BASE_URL": deepseek, "ANTHROPIC_AUTH_TOKEN": "test"}, nil},
		{"DeepSeek in settings.json", map[string]string{"ANTHROPIC_AUTH_TOKEN": "test"}, map[string]interface{}{"ANTHROPIC_BASE_URL": deepseek}},
		// The key is there for the sign-in preflight only: with Bedrock on, Claude Code does not use it.
		{"Bedrock", map[string]string{"CLAUDE_CODE_USE_BEDROCK": "1", "AWS_REGION": "us-east-1", "ANTHROPIC_API_KEY": "test"}, nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir := isolateClaudeRegionEnv(t)
			if c.settings != nil {
				writeClaudeSettingsEnv(t, dir, c.settings)
			}
			rig := newRegionRig(t, regionAnswerBlocked, c.env, nil, answersTwoTurns...)
			if done := rig.awaitSettled("turn-1"); done.Status != stSucceeded || done.Subtype == claudeRegionRefusedSubtype {
				t.Fatalf("turn-1 settled %s / %q, want it run", done.Status, done.Subtype)
			}
			waitUntil(t, func() bool { return rig.hasEvent(evAssistant, "renamed it") }, "the engine's reply never reached the transcript")
			if n := len(rig.fake.Spawns()); n != 1 {
				t.Fatalf("claude was spawned %d times, want once", n)
			}
			if checks := rig.checksSoFar(); len(checks) != 0 {
				t.Fatalf("a turn that does not talk to Anthropic asked the region check: %q", checks)
			}
		})
	}
}

// Allowed runs, and so does every answer that cannot decide: a control plane without the route (404) and an
// unknown verdict.
func TestRegionThatIsNotBlockedRuns(t *testing.T) {
	for _, c := range []struct{ name, answer string }{
		{"allowed", regionAnswerAllowed},
		{"route not found", regionAnswerNotFound},
		{"unknown", regionAnswerUnknown},
	} {
		t.Run(c.name, func(t *testing.T) {
			isolateClaudeRegionEnv(t)
			rig := newRegionRig(t, c.answer, anthropicKey(), nil, answersTwoTurns...)
			if done := rig.awaitSettled("turn-1"); done.Status != stSucceeded {
				t.Fatalf("turn-1 settled %s / %q, want it run", done.Status, done.Subtype)
			}
			if n := len(rig.fake.Spawns()); n != 1 {
				t.Fatalf("claude was spawned %d times, want once", n)
			}
			// One check for the spawn; the turn it then delivers goes on that answer.
			if checks := rig.checksSoFar(); !slices.Equal(checks, []string{"0"}) {
				t.Fatalf("checks = %q, want one", checks)
			}
		})
	}
}

// blockAfterTurnOne lets the session's first turn run on an allowed answer, then turns the route to blocked and
// ages that answer past a minute, so the next turn asks again.
func (r *regionRig) blockAfterTurnOne() {
	r.t.Helper()
	r.awaitSettled("turn-1")
	r.setAnswer(regionAnswerBlocked)
	r.clock.Advance(claudeRegionFreshFor + time.Second)
}

// keepRunningAfterTurnOne answers turn-1's completion RUNNING, as the control plane does when the session's next
// message is already waiting: the engine keeps its permit, and the message goes to it as a running process.
func keepRunningAfterTurnOne(req TurnCompleteRequest) string {
	switch {
	case req.TurnID == "turn-1":
		return stRunning
	case turnCompletionEndsSession(req):
		return stFailed
	}
	return stAwaitingInput
}

// Blocked, a message for a running engine is not delivered: its turn is reported region_refused with the
// sentence, on turn-complete, and the engine stops.
func TestBlockedRegionMessageForARunningEngineIsNotDelivered(t *testing.T) {
	isolateClaudeRegionEnv(t)
	rig := newRegionRig(t, regionAnswerAllowed, anthropicKey(), keepRunningAfterTurnOne, answersTwoTurns...)
	rig.blockAfterTurnOne()
	pid := rig.fake.Spawns()[0].PID
	rig.queue(RunInboxResponse{TurnID: "turn-2", Kind: "message", Content: secondMessage})
	rig.awaitEnd()

	refused := rig.settledTurn("turn-2")
	if refused == nil || refused.Status != stFailed || refused.Subtype != claudeRegionRefusedSubtype ||
		refused.Error != atlasRussiaRefusal || refused.Result != atlasRussiaRefusal {
		t.Fatalf("turn-2 settled as %+v, want FAILED / region_refused with the refusal", refused)
	}
	if rig.engineRead(secondMessage) {
		t.Fatal("the engine was handed the message the region refuses")
	}
	if !processGoneWithin(pid, fakeClaudeTimeout) {
		t.Fatalf("the engine (pid %d) is still running after its message was refused", pid)
	}
	if n := len(rig.fake.Spawns()); n != 1 {
		t.Fatalf("claude was spawned %d times, want once", n)
	}
	if finals := rig.finalizes(); len(finals) != 0 {
		t.Fatalf("the refused turn's completion ended the run, yet it was finalized too: %+v", finals)
	}
	if errs := rig.errors(); len(errs) != 1 || errs[0] != atlasRussiaRefusal {
		t.Fatalf("the transcript's errors are %q, want the refusal once", errs)
	}
	// One check for the spawn, which turn-1 went on, and one for turn-2, whose answer was a minute old.
	if checks := rig.checksSoFar(); !slices.Equal(checks, []string{"0", "0"}) {
		t.Fatalf("checks = %q, want two", checks)
	}
}

// A control plane that knows region_refused puts the session back in the queue and answers with its waiting
// status (contract §10). The run is over all the same: no error is made of the answer, and nothing finalizes
// the session that waits.
func TestRegionRefusalHeldInTheQueueEndsTheRunWithoutFinalizing(t *testing.T) {
	isolateClaudeRegionEnv(t)
	holds := func(req TurnCompleteRequest) string {
		if req.Subtype == claudeRegionRefusedSubtype {
			return stPending
		}
		return keepRunningAfterTurnOne(req)
	}
	rig := newRegionRig(t, regionAnswerAllowed, anthropicKey(), holds, answersTwoTurns...)
	rig.blockAfterTurnOne()
	pid := rig.fake.Spawns()[0].PID
	rig.queue(RunInboxResponse{TurnID: "turn-2", Kind: "message", Content: secondMessage})
	rig.awaitEnd()

	if refused := rig.settledTurn("turn-2"); refused == nil || refused.Subtype != claudeRegionRefusedSubtype {
		t.Fatalf("turn-2 settled as %+v, want region_refused", refused)
	}
	if finals := rig.finalizes(); len(finals) != 0 {
		t.Fatalf("a session the control plane holds in the queue was finalized: %+v", finals)
	}
	if rig.engineRead(secondMessage) || !processGoneWithin(pid, fakeClaudeTimeout) {
		t.Fatal("the refused message reached the engine, or the engine kept running")
	}
}

// Blocked, a claim for a session whose engine is warm does not reuse the engine (activatePrepared): it is
// recycled, and the cold start in its place refuses the turn before spawning anything, reported on finalize.
func TestBlockedRegionClaimRecyclesTheWarmEngine(t *testing.T) {
	isolateClaudeRegionEnv(t)
	rig := newRegionRig(t, regionAnswerAllowed, anthropicKey(), nil, answersTwoTurns...)
	rig.blockAfterTurnOne()
	waitUntil(t, func() bool { return !rig.pool.isActive(rig.live) }, "turn-1 never parked")
	pid := rig.fake.Spawns()[0].PID

	// The next message's claim, as runLoop hands it over.
	claim := *rig.job
	if _, ok := rig.pool.activatePrepared(&claim, nil); !ok {
		t.Fatal("the claim did not activate the session")
	}
	rig.queue(RunInboxResponse{TurnID: "turn-2", Kind: "message", Content: secondMessage})
	rig.awaitEnd()

	finals := rig.finalizes()
	if len(finals) != 1 || finals[0].Status != stFailed || finals[0].Subtype != claudeRegionRefusedSubtype ||
		finals[0].Error != atlasRussiaRefusal {
		t.Fatalf("finalizes = %+v, want one: FAILED / region_refused with the refusal", finals)
	}
	if rig.engineRead(secondMessage) || rig.settledTurn("turn-2") != nil {
		t.Fatal("the warm engine was handed the message the region refuses")
	}
	if !processGoneWithin(pid, fakeClaudeTimeout) {
		t.Fatalf("the warm engine (pid %d) is still running", pid)
	}
	if n := len(rig.fake.Spawns()); n != 1 {
		t.Fatalf("claude was spawned %d times, want once: the cold start must refuse before spawning", n)
	}
	// The claim's own check found the answer a minute old and asked again; the cold start went on that.
	if checks := rig.checksSoFar(); !slices.Equal(checks, []string{"0", "0"}) {
		t.Fatalf("checks = %q, want two", checks)
	}
}

// A steer joins the turn that is already running, which only a confirmed flip stops: it is delivered while the
// verdict is blocked, without asking the check.
func TestBlockedRegionStillDeliversASteerToTheRunningTurn(t *testing.T) {
	isolateClaudeRegionEnv(t)
	rig := newRegionRig(t, regionAnswerAllowed, anthropicKey(), nil,
		fakeStep{Await: "user"}, fakeStep{Emit: "replay_user"}, fakeStep{Emit: "system_init"},
		fakeStep{Emit: "assistant", Text: "renaming it"},
		fakeStep{Await: "user"}, fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "result", Text: "renamed it and its test"},
	)
	waitUntil(t, func() bool { return rig.hasEvent(evAssistant, "renaming it") }, "turn-1 never started")
	rig.setAnswer(regionAnswerBlocked)
	rig.clock.Advance(claudeRegionFreshFor + time.Second)
	rig.queue(RunInboxResponse{TurnID: "steer-1", Kind: "steer", Content: "rename its test too"})

	if done := rig.awaitSettled("turn-1"); done.Status != stSucceeded {
		t.Fatalf("turn-1 settled %s / %q, want it run", done.Status, done.Subtype)
	}
	if !rig.engineRead("rename its test too") {
		t.Fatal("the steer never reached the running turn")
	}
	if steer := rig.awaitSettled("steer-1"); steer.Status != stSucceeded || steer.Subtype != subtypeSteer {
		t.Fatalf("the steer settled %s / %q, want delivered", steer.Status, steer.Subtype)
	}
	if checks := rig.checksSoFar(); !slices.Equal(checks, []string{"0"}) {
		t.Fatalf("checks = %q, want only the spawn's", checks)
	}
}
