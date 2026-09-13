//go:build linux || darwin

package main

import (
	"testing"
	"time"
)

// The two ends of the same pin: where it stops (the ceiling) and what it is measured from
// (the last turn Orbit delivered, not the last turn the engine ran). Both live beside the
// tests that pin the ordinary TTL and LRU behaviour, in session_pool_monitor_pin_test.go.

// A Monitor may watch forever; the host may not hold ~200 MB of it forever (global OOM,
// 2026-08-31). Past the ceiling the pin is spent and the engine goes — and because that is
// still an eviction, stage 1 reports the Monitor killed rather than dropping it in silence.
func TestMonitorPinEndsAtWarmResidencyHardCap(t *testing.T) {
	clock := newFakePoolClock()
	pool := newSessionPoolWithClock(1, clock)
	s := superviseClaudeSession(t, pool, monitorTurn(monitorPersistentReceipt)...)
	s.awaitParked("turn-1")

	// The renewal chain walks up to the ceiling one warmEngineTTL at a time, and none of
	// them is a chance to go quiet: the Monitor is live at every one of them.
	clock.Advance(warmResidencyHardCap - time.Nanosecond)
	if recycleRequested(pool, s.live) {
		t.Fatalf("the engine was recycled before its %s ceiling", warmResidencyHardCap)
	}
	clock.Advance(time.Nanosecond)
	if !recycleRequested(pool, s.live) {
		t.Fatalf("the engine outlived its %s ceiling with a Monitor still open", warmResidencyHardCap)
	}

	// Going anyway is not the same as going quietly: the agent is told on resume.
	s.awaitEvents("the Monitor's death", 1, isMonitorKilled)
	waitUntil(t, func() bool { return !pool.engineResident(s.live) },
		"the recycled engine was never reaped")
	deaths := s.eventsOf(isMonitorKilled)
	if got := asString(deaths[0].Payload["shellId"]); got != "blltn4ypz" {
		t.Fatalf("the killed Monitor was reported as %q, want the persistent watch blltn4ypz", got)
	}
	if got := asString(deaths[0].Payload["toolUseId"]); got != "toolu_monitor" {
		t.Fatalf("the killed Monitor was reported under %q, want toolu_monitor", got)
	}
	if n := len(s.fake.Spawns()); n != 1 {
		t.Fatalf("claude was spawned %d times, want 1", n)
	}
}

// The ceiling is measured from the last turn ORBIT delivered — the park — and never from the
// end of a turn the engine started on its own (owner decision, 2026-09-13). Otherwise a Monitor
// that keeps waking the engine would push its own ceiling forward on every wake, and an engine
// that never stops being woken would never reach it.
func TestMonitorPinHardCapRunsFromTheLastOrbitTurnNotTheEnginesOwn(t *testing.T) {
	clock := newFakePoolClock()
	pool := newSessionPoolWithClock(1, clock)
	s := superviseClaudeSession(t, pool, monitorTurn(monitorPersistentReceipt,
		fakeStep{Await: "release", Text: "wake"},
		fakeStep{Emit: "system_init"},
		fakeStep{Emit: "tool_use", ToolUseID: "toolu_own", ToolName: "Bash",
			Input: map[string]interface{}{"command": "gh run watch"}},
		fakeStep{Await: "release", Text: "tool-done"},
		fakeStep{Emit: "tool_result", ToolUseID: "toolu_own", Text: "green"},
		fakeStep{Emit: "result", Text: "the build is green"},
	)...)
	s.awaitParked("turn-1")

	// A Monitor event wakes the engine 11h into the watch. Its own turn starts and ends, and
	// lastActive moves with it — that is the warm TTL's business, and its own test.
	clock.Advance(11 * time.Hour)
	if recycleRequested(pool, s.live) {
		t.Fatalf("the engine was recycled %s into a watch that was still live and short of the ceiling", 11*time.Hour)
	}
	s.fake.Release("wake")
	s.awaitEvents("the engine's own tool call", 1, isToolUse("toolu_own"))
	s.fake.Release("tool-done")
	s.awaitEvents("the end of the engine's own turn", 2, isTurnEnd)

	// That turn must not have bought the Monitor more residency: the ceiling is still 12h
	// from the park 11h ago, so this engine has an hour left and not thirteen.
	clock.Advance(time.Hour - time.Nanosecond)
	if recycleRequested(pool, s.live) {
		t.Fatal("the engine was recycled short of the ceiling measured from the park")
	}
	clock.Advance(time.Nanosecond)
	if !recycleRequested(pool, s.live) {
		t.Fatal("the engine outlived the ceiling: an engine-initiated turn pushed the Monitor's ceiling forward")
	}
}
