package main

import (
	"context"
	"reflect"
	"testing"
	"time"
)

// sendOneHeartbeat runs the real heartbeat cycle against a stub transport and hands
// back the request the runner would have POSTed, which is where the advertised
// capacity is decided.
func sendOneHeartbeat(t *testing.T, pool *sessionPool, request HeartbeatRequest) HeartbeatRequest {
	t.Helper()
	telemetry := newHeartbeatTelemetryProbe(time.Hour,
		func(context.Context, []heartbeatTelemetryTarget) []heartbeatTelemetrySample { return nil })
	var sent HeartbeatRequest
	_, _, err := sendHeartbeatCycle(pool, telemetry, request,
		func(posted HeartbeatRequest) (*HeartbeatResponse, error) {
			sent = posted
			return &HeartbeatResponse{}, nil
		})
	if err != nil {
		t.Fatalf("heartbeat cycle failed: %v", err)
	}
	return sent
}

// The capacity account, and what it is spent on. A runner-hosted background job runs
// with no turn permit and no engine, so a runner that admits work against permits
// alone admits it onto a machine that is already busy — on a host with a global-OOM
// history. What the count must NOT do is buy the parked engine more residency: that
// was stage 0's stopgap, and eviction is lossless now.
func TestBackgroundJobCountVisibleToAdmission(t *testing.T) {
	clock := newFakePoolClock()
	pool := newSessionPoolWithClock(2, clock)

	// "builder" takes its turn, leaves two runner-hosted jobs running, and parks.
	builder := registerPoolSession(t, pool, "builder", true)
	cancelled := 0
	engineGeneration := startPoolEngine(t, pool, builder, &cancelled)
	holds := pool.worktreeHoldsFor("builder")
	holds.holdRunnerJob("job1", "npm run build")
	holds.holdRunnerJob("job2", "go test ./...")
	// An engine-owned shell of the same session is deliberately not capacity: it
	// dies with the engine, so it is never the reason a parked session still costs
	// this machine anything.
	holds.holdWorktree("shell1", "bash")
	parkPoolSession(pool, builder)

	// The pool reports a number per session, not a bit — two jobs, and the engine's
	// own shell excluded.
	if got := pool.backgroundJobCounts(); !reflect.DeepEqual(got, map[string]int{"builder": 2}) {
		t.Fatalf("backgroundJobCounts() = %#v, want map[builder:2]", got)
	}

	// A second session is mid-turn, so one of the two permits is taken. Counting
	// permits alone would leave a slot free; the parked builder's jobs are what take
	// it, and that difference is the whole point of the account.
	registerPoolSession(t, pool, "turn", true)
	if got := pool.activeCount(); got != 1 {
		t.Fatalf("active turn permits = %d, want 1 of 2", got)
	}
	if idle := pool.admissionIdleCapacity(); idle != 0 {
		t.Fatalf("idle capacity = %d, want 0: one permit taken and one parked session still building", idle)
	}

	// The call site: the heartbeat this runner would actually POST carries that
	// answer, so the control plane routes against real occupancy rather than permits.
	if sent := sendOneHeartbeat(t, pool, HeartbeatRequest{Status: "ONLINE"}); sent.IdleCapacity != 0 {
		t.Fatalf("heartbeat advertised idleCapacity = %d, want 0", sent.IdleCapacity)
	}

	// The paired positive, without which every "0" above could come from a function
	// that only ever returns 0: the jobs finish and the slot comes straight back, in
	// the pool's account and in the heartbeat alike. The engine-owned shell is still
	// held, so this also shows which holds were being counted.
	holds.releaseWorktree("job1")
	holds.releaseWorktree("job2")
	if got := pool.backgroundJobCounts(); len(got) != 0 {
		t.Fatalf("backgroundJobCounts() after both jobs ended = %#v, want empty", got)
	}
	if idle := pool.admissionIdleCapacity(); idle != 1 {
		t.Fatalf("idle capacity after the jobs ended = %d, want the slot back", idle)
	}
	if sent := sendOneHeartbeat(t, pool, HeartbeatRequest{Status: "ONLINE"}); sent.IdleCapacity != 1 {
		t.Fatalf("heartbeat advertised idleCapacity = %d after the jobs ended, want 1", sent.IdleCapacity)
	}
	// Draining still overrides the account, in the one direction that is safe.
	sent := sendOneHeartbeat(t, pool, HeartbeatRequest{Status: "ONLINE", Draining: true})
	if sent.IdleCapacity != 0 {
		t.Fatalf("a draining runner advertised idleCapacity = %d, want 0", sent.IdleCapacity)
	}

	// And the count is spent on admission only. Start another job and let the warm
	// TTL elapse: the engine is recycled anyway. A count that spared it here would
	// be stage 0's deferral again under a new name.
	holds.holdRunnerJob("job3", "npm run build")
	clock.Advance(warmEngineTTL + time.Second)
	if cancelled != 1 {
		t.Fatalf("warm engine cancellations at the TTL = %d, want 1: a live background"+
			" job must not buy an engine residency", cancelled)
	}
	if !pool.engineStopped(builder, engineGeneration) {
		t.Fatal("recycling the engine of a session with live jobs was not a silent eviction")
	}
	if got := pool.backgroundJobCounts(); !reflect.DeepEqual(got, map[string]int{"builder": 1}) {
		t.Fatalf("backgroundJobCounts() after the eviction = %#v, want the job still counted", got)
	}
}
