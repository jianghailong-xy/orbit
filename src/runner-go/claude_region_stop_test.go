//go:build linux || darwin

package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// A confirmed flip stopping running turns (owner decision ④, docs/claude-region-check-contract.md §10), and the
// carry-over reaching the gates (③), through the real supervisor (runInteractiveSession) against the fake CLI and
// a stub control plane that answers as the server does.

// worksUntilReleased is a CLI that takes the session's message and works on it until the test releases it, then
// answers: a turn that is running for as long as a test needs it to be.
var worksUntilReleased = []fakeStep{
	{Await: "user"}, {Emit: "replay_user"}, {Emit: "system_init"},
	{Emit: "assistant", Text: "working on it"},
	{Await: "release", Text: "finish"},
	{Emit: "assistant", Text: "renamed it"}, {Emit: "result", Text: "renamed it"},
	{Await: "user"},
}

// engineOutwaitsTheTest makes the fake CLI wait ten minutes for what it awaits, where it would give up after
// fakeClaudeTimeout: an engine that is gone within a test was stopped, not timed out.
func engineOutwaitsTheTest(t *testing.T) { t.Setenv(fakeClaudeWaitEnv, "10m") }

// answerRegionWith answers a region report as a control plane that knows the subtype does (§10): status for
// region_refused and region_stopped, and every other completion as today's control plane does.
func answerRegionWith(status string) func(TurnCompleteRequest) string {
	return func(req TurnCompleteRequest) string {
		switch {
		case req.Subtype == claudeRegionRefusedSubtype || req.Subtype == claudeRegionStoppedSubtype:
			return status
		case turnCompletionEndsSession(req):
			return stFailed
		}
		return stAwaitingInput
	}
}

// flipToBlocked turns the route to blocked five minutes after the last answer and lets the periodic check find
// it: a flip, which one blocked answer does not confirm.
func (r *regionRig) flipToBlocked() {
	r.setAnswer(regionAnswerBlocked)
	r.clock.Advance(5 * time.Minute)
	r.check.check(context.Background())
}

// settlements counts the completions the stub was sent for turnID.
func (r *regionRig) settlements(turnID string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, s := range r.settled {
		if s.TurnID == turnID {
			n++
		}
	}
	return n
}

// spawnOf is the fake CLI's spawn for the session whose conversation is sessionUUID.
func spawnOf(t *testing.T, fake *fakeClaude, sessionUUID string) fakeSpawn {
	t.Helper()
	var found fakeSpawn
	waitUntil(t, func() bool {
		for _, s := range fake.Spawns() {
			if slices.Contains(s.Argv, sessionUUID) {
				found = s
				return true
			}
		}
		return false
	}, "no claude was spawned for "+sessionUUID)
	return found
}

// A flip confirmed a minute on stops the running Anthropic-bound turn: the engine is killed mid-turn, the turn is
// reported FAILED under region_stopped with the stopped sentence, which the transcript also gets as an error
// event, and either answer of a control plane that knows the subtype ends the run without a finalize —
// AWAITING_INPUT, or PENDING when a message is queued behind the stop.
func TestConfirmedFlipStopsTheRunningAnthropicTurn(t *testing.T) {
	for _, waiting := range []string{stAwaitingInput, stPending} {
		t.Run(waiting, func(t *testing.T) {
			isolateClaudeRegionEnv(t)
			engineOutwaitsTheTest(t)
			rig := newRegionRig(t, regionAnswerAllowed, anthropicKey(), answerRegionWith(waiting), worksUntilReleased...)
			waitUntil(t, func() bool { return rig.hasEvent(evAssistant, "working on it") }, "turn-1 never started")
			pid := rig.fake.Spawns()[0].PID

			rig.flipToBlocked()
			if rig.settledTurn("turn-1") != nil || !processAlive(pid) {
				t.Fatal("one blocked answer stopped the running turn")
			}
			rig.clock.Advance(claudeRegionRecheckAfter) // the recheck: blocked again
			rig.awaitEnd()

			stopped := rig.settledTurn("turn-1")
			if stopped == nil || stopped.Status != stFailed || stopped.Subtype != claudeRegionStoppedSubtype ||
				stopped.Error != atlasRussiaStopped || stopped.Result != atlasRussiaStopped {
				t.Fatalf("turn-1 settled as %+v, want FAILED / region_stopped with %q", stopped, atlasRussiaStopped)
			}
			if n := rig.settlements("turn-1"); n != 1 {
				t.Fatalf("turn-1 was settled %d times, want once", n)
			}
			if errs := rig.errors(); !slices.Equal(errs, []string{atlasRussiaStopped}) {
				t.Fatalf("the transcript's errors are %q, want the stopped sentence once", errs)
			}
			if !processGoneWithin(pid, fakeClaudeTimeout) {
				t.Fatalf("the engine (pid %d) is still running after its turn was stopped", pid)
			}
			if rig.hasEvent(evAssistant, "renamed it") {
				t.Fatal("the stopped turn went on to answer")
			}
			if finals := rig.finalizes(); len(finals) != 0 {
				t.Fatalf("the %s answer ended the run, yet it was finalized too: %+v", waiting, finals)
			}
			if n := len(rig.fake.Spawns()); n != 1 {
				t.Fatalf("claude was spawned %d times, want once", n)
			}
			// The spawn's check, which turn-1 went on, the periodic one that found the flip, and the recheck.
			if checks := rig.checksSoFar(); !slices.Equal(checks, []string{"0", "0", "0"}) {
				t.Fatalf("checks = %q, want three", checks)
			}
		})
	}
}

// A report the control plane answers RUNNING was one it could not hold: a cancel won the session's lock first.
// The run is finalized as after any non-terminal answer, as an ordinary end, so that the cancel's reason stands.
func TestRegionReportAnsweredRunningIsFinalized(t *testing.T) {
	t.Run("stopped", func(t *testing.T) {
		isolateClaudeRegionEnv(t)
		engineOutwaitsTheTest(t)
		rig := newRegionRig(t, regionAnswerAllowed, anthropicKey(), answerRegionWith(stRunning), worksUntilReleased...)
		waitUntil(t, func() bool { return rig.hasEvent(evAssistant, "working on it") }, "turn-1 never started")
		rig.flipToBlocked()
		rig.clock.Advance(claudeRegionRecheckAfter)
		rig.awaitEnd()

		if stopped := rig.settledTurn("turn-1"); stopped == nil || stopped.Subtype != claudeRegionStoppedSubtype {
			t.Fatalf("turn-1 settled as %+v, want region_stopped", stopped)
		}
		finals := rig.finalizes()
		if len(finals) != 1 || finals[0].Status != stFailed || finals[0].Subtype != "" || finals[0].Error != atlasRussiaStopped {
			t.Fatalf("finalizes = %+v, want one: FAILED, no subtype, with the stopped sentence", finals)
		}
	})
	t.Run("refused", func(t *testing.T) {
		isolateClaudeRegionEnv(t)
		running := func(req TurnCompleteRequest) string {
			if req.Subtype == claudeRegionRefusedSubtype {
				return stRunning
			}
			return keepRunningAfterTurnOne(req)
		}
		rig := newRegionRig(t, regionAnswerAllowed, anthropicKey(), running, answersTwoTurns...)
		rig.blockAfterTurnOne()
		rig.queue(RunInboxResponse{TurnID: "turn-2", Kind: "message", Content: secondMessage})
		rig.awaitEnd()

		if refused := rig.settledTurn("turn-2"); refused == nil || refused.Subtype != claudeRegionRefusedSubtype {
			t.Fatalf("turn-2 settled as %+v, want region_refused", refused)
		}
		finals := rig.finalizes()
		if len(finals) != 1 || finals[0].Status != stFailed || finals[0].Subtype != "" || finals[0].Error != atlasRussiaRefusal {
			t.Fatalf("finalizes = %+v, want one: FAILED, no subtype, with the refusal", finals)
		}
	})
}

// The stop is Anthropic's alone: a turn on a DeepSeek key, running on the same runner when the flip is confirmed,
// keeps running through the stop and answers.
func TestConfirmedFlipLeavesADeepSeekTurnRunning(t *testing.T) {
	isolateClaudeRegionEnv(t)
	engineOutwaitsTheTest(t)
	rig := prepareRegionRig(t, regionAnswerAllowed, answerRegionWith(stAwaitingInput))
	anthropic := claudeSpawnJob(t)
	anthropic.Agent.Env = anthropicKey()
	deepseek := *anthropic
	deepseek.SessionID, deepseek.SessionUUID = "sess-2", "22222222-3333-4444-5555-666666666666"
	deepseek.Agent.Env = map[string]string{"ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic", "ANTHROPIC_AUTH_TOKEN": "test"}
	rig.start(anthropic, worksUntilReleased...)
	other := rig.beside(&deepseek, nil)
	waitUntil(t, func() bool { return rig.hasEvent(evAssistant, "working on it") }, "the Anthropic turn never started")
	waitUntil(t, func() bool { return other.hasEvent(evAssistant, "working on it") }, "the DeepSeek turn never started")
	anthropicPID := spawnOf(t, rig.fake, anthropic.SessionUUID).PID
	deepseekPID := spawnOf(t, rig.fake, deepseek.SessionUUID).PID

	rig.flipToBlocked()
	rig.clock.Advance(claudeRegionRecheckAfter)
	rig.awaitEnd()
	if stopped := rig.settledTurn("turn-1"); stopped == nil || stopped.Subtype != claudeRegionStoppedSubtype {
		t.Fatalf("the Anthropic turn settled as %+v, want region_stopped", stopped)
	}
	if !processGoneWithin(anthropicPID, fakeClaudeTimeout) {
		t.Fatal("the Anthropic engine is still running")
	}

	if other.settledTurn("turn-1") != nil || !processAlive(deepseekPID) {
		t.Fatal("the DeepSeek turn was stopped too")
	}
	rig.fake.Release("finish")
	if done := other.awaitSettled("turn-1"); done.Status != stSucceeded || done.Subtype == claudeRegionStoppedSubtype {
		t.Fatalf("the DeepSeek turn settled %s / %q, want it answered", done.Status, done.Subtype)
	}
	if !other.hasEvent(evAssistant, "renamed it") {
		t.Fatal("the DeepSeek turn's answer never reached its transcript")
	}
	if errs, finals := other.errors(), other.finalizes(); len(errs) != 0 || len(finals) != 0 {
		t.Fatalf("the DeepSeek session got errors %q and finalizes %+v, want neither", errs, finals)
	}
	// The DeepSeek session asked nothing: the checks are the Anthropic spawn's, the periodic one and the recheck.
	if checks := rig.checksSoFar(); len(checks) != 3 {
		t.Fatalf("checks = %q, want three", checks)
	}
}

// A turn the engine runs on its own — a background task reporting in after the session parked — is stopped too.
// No turn of Orbit's waits for it, so the engine is killed and the run ends, finalized FAILED under region_stopped
// with the stopped sentence, which a control plane that knows the subtype rests (§10); the transcript gets the
// sentence as an error event.
func TestConfirmedFlipStopsATurnTheEngineRunsOnItsOwn(t *testing.T) {
	isolateClaudeRegionEnv(t)
	engineOutwaitsTheTest(t)
	rig := newRegionRig(t, regionAnswerAllowed, anthropicKey(), nil,
		fakeStep{Await: "user"}, fakeStep{Emit: "replay_user"}, fakeStep{Emit: "system_init"},
		fakeStep{Emit: "assistant", Text: "renamed it"}, fakeStep{Emit: "result", Text: "renamed it"},
		fakeStep{Await: "release", Text: "wake"},
		fakeStep{Emit: "assistant", Text: "the build finished; checking it"},
		fakeStep{Await: "release", Text: "finish"},
		fakeStep{Emit: "result", Text: "checked it"},
	)
	rig.awaitSettled("turn-1")
	waitUntil(t, func() bool { return !rig.pool.isActive(rig.live) }, "turn-1 never parked")
	pid := rig.fake.Spawns()[0].PID
	rig.fake.Release("wake")
	waitUntil(t, func() bool { return rig.hasEvent(evAssistant, "the build finished; checking it") },
		"the engine never started a turn of its own")

	rig.flipToBlocked()
	rig.clock.Advance(claudeRegionRecheckAfter)
	rig.awaitEnd()

	if !processGoneWithin(pid, fakeClaudeTimeout) {
		t.Fatalf("the engine (pid %d) is still running its own turn", pid)
	}
	finals := rig.finalizes()
	if len(finals) != 1 || finals[0].Status != stFailed || finals[0].Subtype != claudeRegionStoppedSubtype ||
		finals[0].Error != atlasRussiaStopped {
		t.Fatalf("finalizes = %+v, want one: FAILED / region_stopped with %q", finals, atlasRussiaStopped)
	}
	if errs := rig.errors(); !slices.Equal(errs, []string{atlasRussiaStopped}) {
		t.Fatalf("the transcript's errors are %q, want the stopped sentence once", errs)
	}
	if rig.hasEvent(evAssistant, "checked it") {
		t.Fatal("the engine's own turn went on to answer")
	}
	rig.mu.Lock()
	settled := len(rig.settled)
	rig.mu.Unlock()
	if settled != 1 {
		t.Fatalf("%d turns were settled, want turn-1's alone: the engine's own turn is no turn of Orbit's", settled)
	}
}

// The stop is the engine's turn's alone: an acceptance command the runner is running for an Anthropic-bound
// session when the flip is confirmed talks to nobody, and runs to its own exit; the engine beside it stays up.
func TestConfirmedFlipLeavesAnAcceptanceCommandRunning(t *testing.T) {
	isolateClaudeRegionEnv(t)
	engineOutwaitsTheTest(t)
	rig := newRegionRig(t, regionAnswerAllowed, anthropicKey(), keepRunningAfterTurnOne, answersTwoTurns...)
	rig.awaitSettled("turn-1") // answered RUNNING: the permit stays for what is queued next
	pid := rig.fake.Spawns()[0].PID
	dir := t.TempDir()
	started, release := filepath.Join(dir, "started"), filepath.Join(dir, "release")
	rig.queue(RunInboxResponse{TurnID: "accept-1", Kind: "shell", TaskAcceptance: true,
		Content: "touch " + started + "; while [ ! -e " + release + " ]; do sleep 0.05; done; exit 0"})
	waitUntil(t, func() bool { _, err := os.Stat(started); return err == nil }, "the acceptance command never started")

	logs := captureRunnerStdout(t, func() {
		rig.flipToBlocked()
		rig.clock.Advance(claudeRegionRecheckAfter)
	})
	if want := "stopping the running Anthropic-bound Claude turns of 1 engine(s)"; !strings.Contains(logs, want) {
		t.Fatalf("the runner logged:\n%s\nwant the confirmed flip to ask the session's engine to stop (%q)", logs, want)
	}
	if err := os.WriteFile(release, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	settled := rig.awaitSettled("accept-1")
	if settled.Status != stSucceeded || settled.ShellExitCode == nil || *settled.ShellExitCode != 0 {
		t.Fatalf("the acceptance command settled as %+v, want exit 0: the stop killed it", settled)
	}
	if !processAlive(pid) {
		t.Fatal("the engine was stopped with no turn of its own running")
	}
	if errs, finals := rig.errors(), rig.finalizes(); len(errs) != 0 || len(finals) != 0 {
		t.Fatalf("errors %q and finalizes %+v, want neither", errs, finals)
	}
}

// A flip the recheck finds recovered stops nothing: the running turn goes on and answers.
func TestRecoveredFlipLeavesTheRunningTurnAlone(t *testing.T) {
	isolateClaudeRegionEnv(t)
	engineOutwaitsTheTest(t)
	rig := newRegionRig(t, regionAnswerAllowed, anthropicKey(), answerRegionWith(stAwaitingInput), worksUntilReleased...)
	waitUntil(t, func() bool { return rig.hasEvent(evAssistant, "working on it") }, "turn-1 never started")
	pid := rig.fake.Spawns()[0].PID

	rig.flipToBlocked()
	rig.setAnswer(regionAnswerAllowed)
	rig.clock.Advance(claudeRegionRecheckAfter) // the recheck: allowed again
	if rig.settledTurn("turn-1") != nil || !processAlive(pid) {
		t.Fatal("a flip that recovered stopped the running turn")
	}
	rig.fake.Release("finish")
	if done := rig.awaitSettled("turn-1"); done.Status != stSucceeded {
		t.Fatalf("turn-1 settled %s / %q, want it answered", done.Status, done.Subtype)
	}
	if !rig.hasEvent(evAssistant, "renamed it") {
		t.Fatal("turn-1's answer never reached the transcript")
	}
	if errs, finals := rig.errors(), rig.finalizes(); len(errs) != 0 || len(finals) != 0 {
		t.Fatalf("errors %q and finalizes %+v after a recovered flip, want neither", errs, finals)
	}
}

// The spawn gate reads the carry-over: an unknown answer an hour after a blocked one still refuses the turn, with
// the decided place; 24 hours after it, the turn runs.
func TestSpawnGateCarriesTheBlockedVerdictOver(t *testing.T) {
	for _, c := range []struct {
		name    string
		since   time.Duration
		refused bool
	}{
		{"an hour after the blocked answer", time.Hour, true},
		{"24 hours after it", claudeRegionCarryOver, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			isolateClaudeRegionEnv(t)
			rig := prepareRegionRig(t, regionAnswerBlocked, nil)
			decidedAt := rig.clock.Now()
			rig.check.check(context.Background())
			rig.setAnswer(regionAnswerUnknown) // the recheck, and every check after it, cannot decide
			advanceTo(rig.clock, decidedAt.Add(c.since))
			job := claudeSpawnJob(t)
			job.Agent.Env = anthropicKey()
			rig.start(job, answersTwoTurns...)

			if !c.refused {
				if done := rig.awaitSettled("turn-1"); done.Status != stSucceeded {
					t.Fatalf("turn-1 settled %s / %q, want it run", done.Status, done.Subtype)
				}
				return
			}
			rig.awaitEnd()
			if spawns := rig.fake.Spawns(); len(spawns) != 0 {
				t.Fatalf("claude was spawned %d time(s) on a blocked verdict carried over", len(spawns))
			}
			finals := rig.finalizes()
			if len(finals) != 1 || finals[0].Status != stFailed || finals[0].Subtype != claudeRegionRefusedSubtype ||
				finals[0].Error != atlasRussiaRefusal {
				t.Fatalf("finalizes = %+v, want one: FAILED / region_refused with %q", finals, atlasRussiaRefusal)
			}
		})
	}
}

// The warm-claim gate (activatePrepared) reads the carry-over too: a claim on an unknown answer after a blocked one
// recycles the warm engine, and the cold start in its place refuses the turn with the decided place.
func TestWarmClaimGateCarriesTheBlockedVerdictOver(t *testing.T) {
	isolateClaudeRegionEnv(t)
	rig := newRegionRig(t, regionAnswerAllowed, anthropicKey(), nil, answersTwoTurns...)
	rig.awaitSettled("turn-1")
	waitUntil(t, func() bool { return !rig.pool.isActive(rig.live) }, "turn-1 never parked")
	pid := rig.fake.Spawns()[0].PID
	rig.flipToBlocked()
	rig.setAnswer(regionAnswerUnknown)
	rig.clock.Advance(time.Hour)

	claim := *rig.job
	if _, ok := rig.pool.activatePrepared(&claim, nil); !ok {
		t.Fatal("the claim did not activate the session")
	}
	rig.queue(RunInboxResponse{TurnID: "turn-2", Kind: "message", Content: secondMessage})
	rig.awaitEnd()

	finals := rig.finalizes()
	if len(finals) != 1 || finals[0].Status != stFailed || finals[0].Subtype != claudeRegionRefusedSubtype ||
		finals[0].Error != atlasRussiaRefusal {
		t.Fatalf("finalizes = %+v, want one: FAILED / region_refused with %q", finals, atlasRussiaRefusal)
	}
	if rig.engineRead(secondMessage) || rig.settledTurn("turn-2") != nil {
		t.Fatal("the warm engine was handed the message the carried-over verdict refuses")
	}
	if !processGoneWithin(pid, fakeClaudeTimeout) {
		t.Fatalf("the warm engine (pid %d) is still running", pid)
	}
	if n := len(rig.fake.Spawns()); n != 1 {
		t.Fatalf("claude was spawned %d times, want once", n)
	}
}
