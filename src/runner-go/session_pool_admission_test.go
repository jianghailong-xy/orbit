package main

import (
	"context"
	"fmt"
	"reflect"
	"sync"
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

func TestRunNowOverflowPermitsAndOrdinaryWait(t *testing.T) {
	p := newSessionPoolWithClock(1, newFakePoolClock())
	burst := 2
	p.applyConcurrency(1, &burst)
	base := registerPoolSession(t, p, "base", true)
	if !p.canClaim() {
		t.Fatal("the claim loop stopped at max despite available burst capacity")
	}
	first, _ := p.register(&ClaimedSession{SessionID: "overflow-1", OverCapacity: true}, func() {}, true)
	second := registerPoolSession(t, p, "overflow-2", false)
	if _, ok := p.activate(&ClaimedSession{SessionID: second.id, OverCapacity: true}); !ok {
		t.Fatal("could not activate the second overflow claim")
	}
	if !p.isActive(first) || !p.isActive(second) || p.activeCount() != 3 || p.canClaim() {
		t.Fatal("expected two admitted overflow turns and no claim room at max + burst")
	}
	if sent := sendOneHeartbeat(t, p, HeartbeatRequest{Status: "ONLINE"}); sent.IdleCapacity != 0 {
		t.Fatalf("heartbeat advertised %d ordinary slots during overflow", sent.IdleCapacity)
	}

	// One server claim can already be in flight when local capacity changes.
	// Install it, but leave it waiting until all three permits are released.
	ordinary := registerPoolSession(t, p, "ordinary", true)
	for _, turn := range []*liveSession{base, first, second} {
		if startsNow(p, ordinary) {
			t.Fatal("ordinary claim started while the active count was still at or above max")
		}
		parkPoolSession(p, turn)
	}
	if p.activeCount() != 0 || !startsNow(p, ordinary) {
		t.Fatal("ordinary claim did not start after the last permit was returned")
	}
	// The overflow claim applies to one turn. A fresh ordinary claim of the
	// same session cannot use the extra slots, even while those slots are free.
	if _, ok := p.activate(poolJob(first.id)); !ok || startsNow(p, first) {
		t.Fatal("the next ordinary turn reused the prior turn's overflow permission")
	}
}

func TestRunNowOverflowEvictsWarmBeforeUsingBurst(t *testing.T) {
	p := newSessionPoolWithClock(2, newFakePoolClock())
	burst := 1
	p.applyConcurrency(2, &burst)
	base := registerPoolSession(t, p, "ordinary", true)
	warm := registerPoolSession(t, p, "warm", true)
	var baseCancelled, warmCancelled, overflowCancelled int
	startPoolEngine(t, p, base, &baseCancelled)
	warmGen := startPoolEngine(t, p, warm, &warmCancelled)
	parkPoolSession(p, warm)
	first, _ := p.register(&ClaimedSession{SessionID: "overflow-1", OverCapacity: true}, func() {}, true)

	noWait, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, ok := p.reserveEngine(first, noWait, context.Background()); ok {
		t.Fatal("overflow used a burst engine slot before the warm engine was reaped")
	}
	if warmCancelled != 1 || baseCancelled != 0 || !p.engineStopped(warm, warmGen) {
		t.Fatal("expected the warm engine alone to be evicted")
	}
	startPoolEngine(t, p, first, &overflowCancelled)
	second, _ := p.register(&ClaimedSession{SessionID: "overflow-2", OverCapacity: true}, func() {}, true)
	startPoolEngine(t, p, second, &overflowCancelled)
	if p.residentCount() != 3 || baseCancelled != 0 || overflowCancelled != 0 {
		t.Fatal("expected all three running engines to stay resident at max + burst")
	}
	zero := 0
	p.applyConcurrency(2, &zero)
	if _, ok := p.activate(&ClaimedSession{SessionID: second.id, OverCapacity: true}); !ok || !p.isActive(second) || overflowCancelled != 0 {
		t.Fatal("replacing an existing claim after a limit reduction lost its running engine protection")
	}
	parkPoolSession(p, second)
	if p.activeCount() != 2 || overflowCancelled != 1 || baseCancelled != 0 {
		t.Fatal("finishing the overflow turn should return its permit and recycle the idle excess engine")
	}
}

func TestRunNowOverflowProtectsSelfDrivenTurnAtResidentCap(t *testing.T) {
	p := newSessionPoolWithClock(1, newFakePoolClock())
	burst := 1
	p.applyConcurrency(1, &burst)
	self := registerPoolSession(t, p, "self-driven", true)
	var selfCancelled, overflowCancelled int
	selfGen := startPoolEngine(t, p, self, &selfCancelled)
	parkPoolSession(p, self)
	p.engineTurnEvent(self, evToolUse, map[string]interface{}{"id": "toolu_1"})
	first, _ := p.register(&ClaimedSession{SessionID: "overflow-1", OverCapacity: true}, func() {}, true)
	startPoolEngine(t, p, first, &overflowCancelled)
	second, _ := p.register(&ClaimedSession{SessionID: "overflow-2", OverCapacity: true}, func() {}, true)
	if !p.isActive(second) {
		t.Fatal("second overflow claim should hold a permit while waiting for an engine slot")
	}
	noWait, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, ok := p.reserveEngine(second, noWait, context.Background()); ok || p.residentCount() != 2 {
		t.Fatal("the second overflow engine exceeded the resident cap")
	}
	if selfCancelled != 0 || overflowCancelled != 0 {
		t.Fatal("an engine was evicted while running a turn")
	}
	p.engineTurnEvent(self, evTurnEnd, nil)
	if _, _, ok := p.reserveEngine(second, noWait, context.Background()); ok || selfCancelled != 1 {
		t.Fatal("the self-driven turn's engine should be evictable once idle, and remain counted until reaped")
	}
	if !p.engineStopped(self, selfGen) {
		t.Fatal("the idle engine did not finish its eviction")
	}
	startPoolEngine(t, p, second, &overflowCancelled)
}

func TestRunNowConcurrentOverflowClaimsAtCap(t *testing.T) {
	const claimCount = 24
	p := newSessionPoolWithClock(2, newFakePoolClock())
	burst := 2
	p.applyConcurrency(2, &burst)
	var cancelled int
	for _, id := range []string{"ordinary-1", "ordinary-2"} {
		startPoolEngine(t, p, registerPoolSession(t, p, id, true), &cancelled)
	}
	for i := 0; i < claimCount/2; i++ {
		registerPoolSession(t, p, fmt.Sprintf("overflow-%d", i), false)
	}

	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < claimCount; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			job := &ClaimedSession{SessionID: fmt.Sprintf("overflow-%d", i), OverCapacity: true}
			var s *liveSession
			var ok bool
			if i < claimCount/2 {
				s, ok = p.activate(job)
			} else {
				s, ok = p.register(job, func() {}, true)
			}
			if !ok {
				t.Errorf("claim %s was not installed", job.SessionID)
				return
			}
			if p.isActive(s) {
				noWait, cancel := context.WithCancel(context.Background())
				cancel()
				if _, _, ok := p.reserveEngine(s, noWait, context.Background()); !ok {
					t.Errorf("admitted claim %s could not reserve its engine", job.SessionID)
				}
			}
		}(i)
	}
	close(start)
	wg.Wait()
	if active, resident := p.activeCount(), p.residentCount(); active != 4 || resident != 4 || cancelled != 0 {
		t.Fatalf("concurrent claims left active=%d resident=%d evictions=%d, want 4/4/0", active, resident, cancelled)
	}
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
