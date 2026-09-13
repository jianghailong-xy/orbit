//go:build linux || darwin

package main

import (
	"testing"
	"time"
)

// A Claude Monitor runs its watch command inside the engine process, so recycling the engine
// ends it: the agent stops being woken and nothing says why. Stage 1 made that death visible
// (killEngineShells reports the Monitor killed); this makes it not happen on the paths that
// have a choice — the warm TTL and LRU pressure pass over an engine that still has a Monitor.
//
// Every case drives the real supervisor (runInteractiveSession) against the fake CLI and a stub
// control plane, with the pool on a fake clock: the Monitor is registered by the start receipt
// the engine writes to stdout, each park is the one completeTurn performs, and each recycle is
// the timer or LRU path the runner really takes.
//
// The pin is a deferral, never an exemption. It is re-decided on every timer and every victim
// search, and it cannot outlive warmResidencyHardCap: a Monitor that watches forever must not
// hold ~200 MB of this host's memory forever (global-OOM history, 2026-08-31).

// monitorTurn is an ordinary first turn in which the engine starts a Monitor and leaves it
// watching. The Monitor exists once the runner has read the start receipt off the stream, which
// happens before the result that ends the turn — so a test's awaitParked is already after it.
func monitorTurn(receipt string, then ...fakeStep) []fakeStep {
	return append([]fakeStep{
		{Await: "user"},
		{Emit: "replay_user"},
		{Emit: "system_init"},
		{Emit: "tool_use", ToolUseID: "toolu_monitor", ToolName: "Monitor",
			Input: map[string]interface{}{"command": "gh run watch", "description": "CI"}},
		{Emit: "tool_result", ToolUseID: "toolu_monitor", Text: receipt},
		{Emit: "result", Text: "watching CI"},
	}, then...)
}

// isMonitorKilled is the report stage 1 emits when a Monitor dies with its engine.
func isMonitorKilled(e RunEvent) bool {
	return e.Type == evBackgroundTask && asString(e.Payload["status"]) == "killed" &&
		asString(e.Payload["tool"]) == "Monitor"
}

func (s *supervisedSession) eventsOf(match func(RunEvent) bool) []RunEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []RunEvent
	for _, e := range s.events {
		if match(e) {
			out = append(out, e)
		}
	}
	return out
}

// The warm TTL is the recycle the agent never sees coming: it fires between turns, when the
// session is parked and the agent is not there to notice its Monitor go quiet.
func TestWarmEngineWithLiveMonitorIsNotRecycledByTTL(t *testing.T) {
	clock := newFakePoolClock()
	pool := newSessionPoolWithClock(1, clock)
	s := superviseClaudeSession(t, pool, monitorTurn(monitorTimeoutReceipt)...)
	s.awaitParked("turn-1")

	clock.Advance(warmEngineTTL + time.Second)
	if recycleRequested(pool, s.live) {
		t.Fatal("the warm TTL recycled an engine that still had a Monitor: the Monitor died with it")
	}
	if !pool.engineResident(s.live) {
		t.Fatal("the engine went cold although its Monitor was still running in it")
	}
	// A renewal, not an exemption: the timer comes back, and so does the decision (the cap
	// case below, TestMonitorPinEndsAtWarmResidencyHardCap).
	clock.Advance(warmEngineTTL)
	if recycleRequested(pool, s.live) {
		t.Fatalf("the engine was recycled after a second %s with its Monitor still live", warmEngineTTL)
	}
}

// The other half of the pin: it is the Monitor that holds the engine, so a Monitor whose own
// terminal notification has arrived stops holding anything and the ordinary warm TTL applies.
func TestWarmEngineIsRecycledAfterItsMonitorEnds(t *testing.T) {
	clock := newFakePoolClock()
	pool := newSessionPoolWithClock(1, clock)
	s := superviseClaudeSession(t, pool, monitorTurn(monitorTimeoutReceipt,
		// A second Orbit turn, in which the engine consumes the notification that ends the
		// Monitor — the way the real CLI carries it into a turn.
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "system_init"},
		fakeStep{Emit: "task_notification", Text: taskNotif("b97q4j1iy", "toolu_monitor", "killed")},
		fakeStep{Emit: "result", Text: "the watch is over"},
	)...)
	s.awaitParked("turn-1")

	clock.Advance(warmEngineTTL + time.Second)
	if recycleRequested(pool, s.live) {
		t.Fatal("the warm TTL recycled an engine that still had a Monitor")
	}

	// The Monitor ends on its own. The engine is idle warm capacity again.
	claim := *s.job
	if _, ok := pool.activate(&claim); !ok {
		t.Fatal("a claim could not activate the session whose engine held the Monitor")
	}
	s.queue(RunInboxResponse{TurnID: "turn-2", Kind: "message", Content: "is the build green?"})
	s.awaitParked("turn-2")
	if n := len(s.fake.Spawns()); n != 1 {
		t.Fatalf("claude was spawned %d times, want 1: the Monitor lives in the engine that already ran", n)
	}

	clock.Advance(warmEngineTTL)
	if !recycleRequested(pool, s.live) {
		t.Fatalf("the engine was not recycled within %s of its Monitor ending", warmEngineTTL)
	}
	waitUntil(t, func() bool { return !pool.engineResident(s.live) },
		"the recycled engine was never reaped")
}

// Capacity pressure is not starvation. A Monitor-bearing engine is the last candidate, not an
// impossible one: the new session gets its slot, and if that means recycling a Monitor, the
// Monitor is reported killed (stage 1) rather than silently dropped.
func TestLRUPrefersWarmEnginesWithoutLiveMonitor(t *testing.T) {
	clock := newFakePoolClock()
	pool := newSessionPoolWithClock(2, clock)
	s := superviseClaudeSession(t, pool, monitorTurn(monitorTimeoutReceipt)...)
	s.awaitParked("turn-1")

	// A second warm engine, parked a minute later: in pure lastActive order the engine that
	// is still watching is the older one, so it is the one LRU would take.
	clock.Advance(time.Minute)
	other := registerPoolSession(t, pool, "other", true)
	otherCancelled := 0
	otherGeneration := startPoolEngine(t, pool, other, &otherCancelled)
	parkPoolSession(pool, other)

	// One cold active claim cuts idle warm capacity from two to one: exactly one victim.
	claimant := registerPoolSession(t, pool, "claimant", true)
	if recycleRequested(pool, s.live) {
		t.Fatal("LRU pressure recycled the warm engine still running a Monitor, while an idle one was there to take")
	}
	if otherCancelled != 1 {
		t.Fatalf("the idle warm engine was recycled %d times, want 1: %#v", otherCancelled, otherCancelled)
	}
	if !pool.engineStopped(other, otherGeneration) {
		t.Fatal("the victim was not classified as a silent eviction")
	}
	claimantCancelled := 0
	startPoolEngine(t, pool, claimant, &claimantCancelled)

	// Now the Monitor-bearing engine is the only warm engine left, and a session waiting on
	// capacity is not kept waiting for it: the newest session's start still gets a slot.
	registerPoolSession(t, pool, "late", true)
	if !recycleRequested(pool, s.live) {
		t.Fatal("a cold start at the resident cap was starved by the last warm engine, which carried a Monitor")
	}
	if claimantCancelled != 0 {
		t.Fatalf("the waiting session's engine was recycled (%d) instead of the warm one holding capacity", claimantCancelled)
	}
}
