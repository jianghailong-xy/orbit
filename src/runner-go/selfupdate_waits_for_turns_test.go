package main

import (
	"context"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// An automatic update used to stop the runner the moment a check found a newer release, and let
// the drain deal with whatever was running. The drain did not wait for an EXECUTABLE acceptance
// command at all: it was torn down within seconds of "update available", reported as exit -1, and
// the control plane judged the task FAILED (2026-09-25, eight times in one day). The owner's rule
// since: an update never evicts a running turn — a check that finds one skips this round, and a
// later check finds the runner idle.

// The incident, end to end: the real supervisor runs the acceptance command, the real monitor loop
// checks a published release every 20ms, and whatever it answers is acted on the way runLoop acts
// on it — the supervisor's shutdown is cancelled with the self-update cause.
func TestSelfUpdateWaitsForAnAcceptanceCommandInFlight(t *testing.T) {
	pool := newSessionPool(2)
	loopCtx, stopLoop := context.WithCancelCause(context.Background())
	defer stopLoop(nil)
	s := superviseClaudeSessionUntil(t, pool, t.TempDir(), loopCtx,
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "system_init"},
		fakeStep{Emit: "assistant", Text: "implemented"},
		fakeStep{Emit: "result", Text: "implemented"},
	)
	s.awaitParked("turn-1")

	// The task's acceptance command, claimed as runLoop claims a turn for a warm session.
	claim := *s.job
	if _, ok := pool.activate(&claim); !ok {
		t.Fatal("the acceptance turn's claim was not activated")
	}
	s.queue(RunInboxResponse{TurnID: "accept-1", Kind: "shell", Content: "sleep 1; exit 0", TaskAcceptance: true})

	const interval = 20 * time.Millisecond
	var checks atomic.Int32
	published := func(context.Context, string) (string, bool) {
		checks.Add(1)
		return "0.1.186", true
	}
	reason, remote := waitForRunLoopStop(context.Background(), nil, "https://control.example", interval,
		updateWhenNoTurnInFlight(published, pool, interval))
	settledBeforeTheUpdate := s.settledTurn("accept-1") != nil
	stopLoop(errRunnerSelfUpdate)

	if reason != runLoopStopUpdate || remote != "0.1.186" {
		t.Fatalf("stop = %v, %q; want the update once nothing was running", reason, remote)
	}
	waitUntil(t, func() bool { return s.settledTurn("accept-1") != nil }, "the acceptance turn was never settled")
	settled := s.settledTurn("accept-1")
	if settled.ShellExitCode == nil || *settled.ShellExitCode != 0 {
		exit := "none"
		if settled.ShellExitCode != nil {
			exit = strings.TrimSpace(settled.Result)
		}
		t.Fatalf("the acceptance command settled with %s, want exit 0: the update tore it down mid-run", exit)
	}
	if !settledBeforeTheUpdate {
		t.Fatal("the update was decided while the acceptance command was still running")
	}
	if n := checks.Load(); n < 2 {
		t.Fatalf("the release was checked %d time(s): the update never had to wait, so this proves nothing", n)
	}
	// And what the update does stop is an idle session, which detaches resumable for the updated
	// runner to reclaim — it is not ended.
	waitUntil(t, func() bool { return pool.count() == 0 }, "the supervisor never detached for the update")
	if s.requested("/finalize") || s.requested("/complete") {
		t.Fatal("the update ended the session instead of detaching it")
	}
}

// A check that finds a turn running changes nothing — the pool stays open, and the same release is
// asked about again at the next tick — and the first check that finds none gets the update.
func TestAnUpdateWaitsForTheTurnInFlightAndNoLonger(t *testing.T) {
	p := newSessionPool(2)
	s := registerPoolSession(t, p, "a", true)
	check := updateWhenNoTurnInFlight(func(context.Context, string) (string, bool) {
		return "0.1.186", true
	}, p, time.Minute)

	if remote, ok := check(context.Background(), "https://control.example"); ok || remote != "" {
		t.Fatalf("check with a turn in flight = %q, %v; want it deferred", remote, ok)
	}
	if !waitsForNothing(p, s) {
		t.Fatal("a deferred update closed the pool: the turn in flight could not have gone on")
	}
	parkPoolSession(p, s)
	if remote, ok := check(context.Background(), "https://control.example"); !ok || remote != "0.1.186" {
		t.Fatalf("check with nothing in flight = %q, %v; want the update", remote, ok)
	}
}

// No release, no closing: an idle runner that checks and finds nothing new goes on taking turns.
func TestACheckThatFindsNoReleaseLeavesThePoolOpen(t *testing.T) {
	p := newSessionPool(1)
	check := updateWhenNoTurnInFlight(func(context.Context, string) (string, bool) { return "", false }, p, time.Minute)
	if remote, ok := check(context.Background(), "https://control.example"); ok || remote != "" {
		t.Fatalf("check = %q, %v; want nothing to update to", remote, ok)
	}
	s := registerPoolSession(t, p, "a", true)
	if !waitsForNothing(p, s) {
		t.Fatal("a check that found no release closed the pool, so a claimed turn never starts")
	}
}

// A turn the engine runs on its own — a Monitor event, a <task-notification> — is a turn in flight
// too, though it holds no permit. Idle engines, warm or cold, are not.
func TestAnEngineTurnOfItsOwnKeepsThePoolOpenForAnUpdate(t *testing.T) {
	p := newSessionPoolWithClock(2, newFakePoolClock())
	registerPoolSession(t, p, "cold", false)
	s := registerPoolSession(t, p, "warm", true)
	cancelled := 0
	startPoolEngine(t, p, s, &cancelled)
	parkPoolSession(p, s)

	p.engineTurnEvent(s, evToolUse, map[string]interface{}{"id": "toolu_1"})
	if n := p.closeForUpdate(); n != 1 {
		t.Fatalf("closeForUpdate during the engine's own turn = %d, want 1 and the pool left open", n)
	}
	p.engineTurnEvent(s, evTurnEnd, map[string]interface{}{})
	if n := p.closeForUpdate(); n != 0 {
		t.Fatalf("closeForUpdate with only idle sessions = %d, want 0", n)
	}
}

// The race the lock closes: a claim the control plane made just as the pool closed still gets its
// permit — the session is RUNNING there — but its turn does not start, and the stop that follows
// ends the wait. Left RUNNING, the turn is the updated runner's to reclaim, the way a claim that
// races any runner stop already is.
func TestAPoolClosedForAnUpdateStartsNoTurn(t *testing.T) {
	p := newSessionPool(2)
	s := registerPoolSession(t, p, "a", true)
	parkPoolSession(p, s)
	if n := p.closeForUpdate(); n != 0 {
		t.Fatalf("closeForUpdate with nothing in flight = %d, want 0", n)
	}
	if _, ok := p.activate(poolJob("a")); !ok {
		t.Fatal("the claim was not activated")
	}

	shutdown, stop := context.WithCancel(context.Background())
	defer stop()
	started := make(chan bool, 1)
	go func() { started <- p.waitActive(s, context.Background(), shutdown) }()
	select {
	case <-started:
		t.Fatal("a turn was let start after the pool closed for an update")
	case <-time.After(100 * time.Millisecond):
	}
	stop()
	select {
	case ok := <-started:
		if ok {
			t.Fatal("the stop let the turn start instead of ending the wait")
		}
	case <-time.After(fakeClaudeTimeout):
		t.Fatal("the wait outlived the stop")
	}
}

// Asked of the source, as TestTheRunLoopAdoptsRecordedJobsBeforeAnythingElse asks: nothing else
// fails when runLoop asks the manifest directly again — acceptance commands are torn down by the
// next release once in a while.
func TestTheRunLoopOnlyUpdatesThroughTheTurnGate(t *testing.T) {
	src, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatalf("read runloop.go: %v", err)
	}
	body := string(src)
	body = body[strings.Index(body, "func runLoop("):]
	gated := strings.Count(body, "updateWhenNoTurnInFlight(availableSelfUpdate, pool, selfUpdateCheckInterval)")
	if gated != 1 || strings.Count(body, "availableSelfUpdate") != gated {
		t.Fatal("runLoop checks for a release without updateWhenNoTurnInFlight: an update can stop the runner mid-turn")
	}
}

// waitsForNothing reports whether s, holding a permit, would start its turn now.
func waitsForNothing(p *sessionPool, s *liveSession) bool {
	shutdown, stop := context.WithCancel(context.Background())
	defer stop()
	started := make(chan bool, 1)
	go func() { started <- p.waitActive(s, context.Background(), shutdown) }()
	select {
	case ok := <-started:
		return ok
	case <-time.After(time.Second):
		return false
	}
}
