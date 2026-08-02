package main

import (
	"context"
	"sort"
	"sync"
	"testing"
	"time"
)

type fakePoolClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakePoolTimer
}

type fakePoolTimer struct {
	clock   *fakePoolClock
	at      time.Time
	f       func()
	stopped bool
	fired   bool
}

func newFakePoolClock() *fakePoolClock {
	return &fakePoolClock{now: time.Unix(1_700_000_000, 0)}
}

func (c *fakePoolClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakePoolClock) AfterFunc(d time.Duration, f func()) poolTimer {
	c.mu.Lock()
	defer c.mu.Unlock()
	tm := &fakePoolTimer{clock: c, at: c.now.Add(d), f: f}
	c.timers = append(c.timers, tm)
	return tm
}

func (t *fakePoolTimer) Stop() bool {
	t.clock.mu.Lock()
	defer t.clock.mu.Unlock()
	if t.stopped || t.fired {
		return false
	}
	t.stopped = true
	return true
}

// Advance executes due timers in chronological order, outside the clock lock so
// callbacks may safely schedule/stop other timers and enter sessionPool.mu.
func (c *fakePoolClock) Advance(d time.Duration) {
	target := func() time.Time {
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.now.Add(d)
	}()
	for {
		c.mu.Lock()
		sort.SliceStable(c.timers, func(i, j int) bool { return c.timers[i].at.Before(c.timers[j].at) })
		var due *fakePoolTimer
		for _, tm := range c.timers {
			if !tm.stopped && !tm.fired && !tm.at.After(target) {
				due = tm
				break
			}
		}
		if due == nil {
			c.now = target
			c.mu.Unlock()
			return
		}
		c.now = due.at
		due.fired = true
		f := due.f
		c.mu.Unlock()
		f()
	}
}

func poolJob(id string) *ClaimedSession {
	return &ClaimedSession{SessionID: id, SessionUUID: id, Provider: providerClaude}
}

func registerPoolSession(t *testing.T, p *sessionPool, id string, active bool) *liveSession {
	t.Helper()
	s, added := p.register(poolJob(id), func() {}, active)
	if !added {
		t.Fatalf("session %s was not registered", id)
	}
	return s
}

func startPoolEngine(t *testing.T, p *sessionPool, s *liveSession, cancelled *int) uint64 {
	t.Helper()
	gen, _, ok := p.reserveEngine(s, context.Background(), context.Background())
	if !ok {
		t.Fatalf("engine for %s was not reserved", s.id)
	}
	if immediate := p.engineStarted(s, gen, func() { *cancelled++ }); immediate {
		*cancelled++
	}
	return gen
}

func parkPoolSession(p *sessionPool, s *liveSession) uint64 {
	gen := p.permitGeneration(s)
	p.park(s, gen)
	return gen
}

func TestSessionPoolWarmTTLAndTransparentColdResume(t *testing.T) {
	clock := newFakePoolClock()
	p := newSessionPoolWithClock(1, clock)
	s := registerPoolSession(t, p, "a", true)
	cancelled := 0
	gen1 := startPoolEngine(t, p, s, &cancelled)

	parkPoolSession(p, s)
	if got := p.activeCount(); got != 0 {
		t.Fatalf("active after park = %d, want 0", got)
	}
	if got := p.residentCount(); got != 1 {
		t.Fatalf("resident after park = %d, want warm engine retained", got)
	}
	clock.Advance(warmEngineTTL - time.Nanosecond)
	if cancelled != 0 {
		t.Fatalf("engine cancelled before TTL: %d", cancelled)
	}
	clock.Advance(time.Nanosecond)
	if cancelled != 1 {
		t.Fatalf("engine cancellations at TTL = %d, want 1", cancelled)
	}
	if !p.engineStopped(s, gen1) {
		t.Fatal("TTL-stopped engine must be classified as a silent eviction")
	}
	if got := p.residentCount(); got != 0 {
		t.Fatalf("resident after Wait = %d, want cold", got)
	}
	if got := p.count(); got != 1 {
		t.Fatalf("supervisors after TTL = %d, want session retained", got)
	}

	resume := poolJob("a")
	resume.Resume = true
	if _, ok := p.activate(resume); !ok {
		t.Fatal("cold session was not activated")
	}
	gen2, claimed, ok := p.reserveEngine(s, context.Background(), context.Background())
	if !ok || claimed != resume {
		t.Fatalf("cold resume = (%v, %p), want latest claim %p", ok, claimed, resume)
	}
	if gen2 == gen1 {
		t.Fatal("cold resume reused an old engine generation")
	}
	if got := p.residentCount(); got != 1 {
		t.Fatalf("resident after cold resume = %d, want 1", got)
	}
}

func TestSessionPoolClaimWinsWarmTimerRace(t *testing.T) {
	clock := newFakePoolClock()
	p := newSessionPoolWithClock(1, clock)
	s := registerPoolSession(t, p, "a", true)
	cancelled := 0
	gen := startPoolEngine(t, p, s, &cancelled)
	parkPoolSession(p, s)

	if _, ok := p.activate(poolJob("a")); !ok {
		t.Fatal("warm claim was not activated")
	}
	clock.Advance(warmEngineTTL + time.Hour)
	if cancelled != 0 {
		t.Fatalf("stale TTL cancelled reused warm engine %d time(s)", cancelled)
	}
	if !p.isActive(s) || p.residentCount() != 1 {
		t.Fatal("warm claim must reuse the resident engine and retain its permit")
	}
	// Clean up the exact generation to ensure the stale timer did not change it.
	if p.engineStopped(s, gen) {
		t.Fatal("normally stopped reused engine was misclassified as evicted")
	}
}

func TestSessionPoolTimerWinsClaimRaceWithoutTwoResidents(t *testing.T) {
	clock := newFakePoolClock()
	p := newSessionPoolWithClock(1, clock)
	s := registerPoolSession(t, p, "a", true)
	cancelled := 0
	gen1 := startPoolEngine(t, p, s, &cancelled)
	parkPoolSession(p, s)
	clock.Advance(warmEngineTTL)
	if cancelled != 1 {
		t.Fatalf("TTL cancellation count = %d, want 1", cancelled)
	}

	// Claim after eviction was committed but before old cmd.Wait completes. The
	// active permit is acquired, yet the old engine remains the sole resident.
	p.activate(poolJob("a"))
	if p.activeCount() != 1 || p.residentCount() != 1 {
		t.Fatalf("race state active/resident = %d/%d, want 1/1", p.activeCount(), p.residentCount())
	}
	if !p.engineStopped(s, gen1) {
		t.Fatal("old engine must finish as an eviction")
	}
	gen2, _, ok := p.reserveEngine(s, context.Background(), context.Background())
	if !ok || gen2 == gen1 {
		t.Fatal("claimed session did not reserve one fresh engine after old Wait")
	}
	if p.residentCount() != 1 {
		t.Fatalf("resident after race recovery = %d, want exactly 1", p.residentCount())
	}
}

func TestSessionPoolNewClaimWinsBeforeLatePriorPark(t *testing.T) {
	clock := newFakePoolClock()
	p := newSessionPoolWithClock(2, clock)
	s := registerPoolSession(t, p, "a", true)
	cancelled := 0
	startPoolEngine(t, p, s, &cancelled)
	priorPermit := p.permitGeneration(s)

	// Models the network window after the server committed the old turn's
	// AWAITING_INPUT response but before its runner callback called park: a new
	// send is claimed first and advances the permit generation.
	if _, ok := p.activate(poolJob("a")); !ok {
		t.Fatal("racing claim did not find its resident supervisor")
	}
	newPermit := p.permitGeneration(s)
	if newPermit == priorPermit {
		t.Fatal("claim did not advance the permit generation")
	}
	p.park(s, priorPermit)
	if !p.isActive(s) || p.activeCount() != 1 {
		t.Fatal("late prior-turn park released the newer claim's active permit")
	}
	if p.residentCount() != 1 || cancelled != 0 {
		t.Fatal("late prior-turn park disturbed the reused warm engine")
	}
}

func TestSessionPoolExecutableWaitsForClaimActivation(t *testing.T) {
	clock := newFakePoolClock()
	p := newSessionPoolWithClock(1, clock)
	s := registerPoolSession(t, p, "a", true)
	cancelled := 0
	startPoolEngine(t, p, s, &cancelled)
	parkPoolSession(p, s)

	ready := make(chan bool, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { ready <- p.waitActive(s, ctx, context.Background()) }()
	select {
	case <-ready:
		t.Fatal("executable turn passed its local gate before claim activation")
	case <-time.After(20 * time.Millisecond):
	}

	p.activate(poolJob("a"))
	select {
	case ok := <-ready:
		if !ok {
			t.Fatal("permit waiter woke as cancelled after claim activation")
		}
	case <-time.After(time.Second):
		t.Fatal("permit waiter did not wake after claim activation")
	}
}

func TestSessionPoolLeaseLossDetachesAdvertisedColdSupervisor(t *testing.T) {
	p := newSessionPool(1)
	cancelled := 0
	sessionCtx, cancelSession := context.WithCancel(context.Background())
	s, added := p.register(poolJob("cold"), func() {
		cancelled++
		cancelSession()
	}, false)
	if !added {
		t.Fatal("cold session was not registered")
	}
	advertised, _ := p.heartbeatSnapshot()
	snapshot, ok := advertised["cold"]
	if !ok || snapshot.supervisor != s {
		t.Fatal("heartbeat did not capture the exact cold supervisor epoch")
	}

	stopped := make(chan bool, 1)
	go func() { stopped <- p.waitActive(s, sessionCtx, context.Background()) }()
	if _, detached := p.detachExpectedForTakeover(snapshot.supervisor); !detached {
		t.Fatal("unchanged cold supervisor did not detach on lease loss")
	}
	if cancelled != 1 {
		t.Fatalf("cold lease detach cancellation count = %d, want 1", cancelled)
	}
	if p.count() != 1 {
		t.Fatalf("pool count before detached supervisor cleanup = %d, want 1", p.count())
	}
	select {
	case active := <-stopped:
		if active {
			t.Fatal("detached cold waiter reported activation")
		}
	case <-time.After(time.Second):
		t.Fatal("detached cold waiter did not wake")
	}
	if !p.isDetaching(s) {
		t.Fatal("cold lease loss was not recorded as a no-finalize detach")
	}
	p.finish(s)
	if p.count() != 0 {
		t.Fatalf("pool count after detached supervisor cleanup = %d, want 0", p.count())
	}

	// Models a stale heartbeat mismatch that returns after a fresh claim. The
	// pointer captured with the old request must not match the replacement epoch.
	fresh := registerPoolSession(t, p, "cold", false)
	if _, ok := p.activate(poolJob("cold")); !ok {
		t.Fatal("fresh claim did not activate the replacement supervisor")
	}
	if _, detached := p.detachExpectedForTakeover(snapshot.supervisor); detached {
		t.Fatal("stale lease-loss response detached a freshly activated permit")
	}
	if !p.isActive(fresh) || p.activeCount() != 1 {
		t.Fatal("freshly activated permit was not retained")
	}
}

func TestSessionPoolLeaseLossDetachesAdvertisedActiveSupervisor(t *testing.T) {
	p := newSessionPool(1)
	live := registerPoolSession(t, p, "active", true)
	rawCancels := 0
	live.cancel = func() { rawCancels++ }
	detaches := 0
	p.installDetach(live, func() { detaches++ })

	if _, detached := p.detachExpectedForTakeover(live); !detached {
		t.Fatal("active advertised supervisor did not detach on lease loss")
	}
	if detaches != 1 || rawCancels != 0 {
		t.Fatalf("detach calls = %d, raw cancels = %d; want 1, 0", detaches, rawCancels)
	}
	if !p.isDetaching(live) {
		t.Fatal("active lease loss was not recorded as detaching")
	}
	p.finish(live)
}

func TestSessionPoolDetachingActiveSupervisorKeepsSlotAndRejectsActivation(t *testing.T) {
	p := newSessionPool(1)
	live := registerPoolSession(t, p, "active", true)
	detaches := 0
	p.installDetach(live, func() { detaches++ })

	done, detached := p.detachExpectedForTakeover(live)
	if !detached || detaches != 1 {
		t.Fatalf("detach = %v, calls = %d; want true, 1", detached, detaches)
	}
	if got := p.activeCount(); got != p.maxConcurrent() {
		t.Fatalf("active slots while predecessor drains = %d, want max %d", got, p.maxConcurrent())
	}
	if _, ok := p.activate(poolJob("active")); ok {
		t.Fatal("claim reused a supervisor whose predecessor epoch is detaching")
	}
	if p.isActive(live) || p.permitGeneration(live) != 0 {
		t.Fatal("detaching supervisor remained executable despite retaining its capacity slot")
	}
	select {
	case <-done:
		t.Fatal("detach barrier closed before predecessor cleanup")
	default:
	}

	p.finish(live)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("detach barrier did not close after predecessor cleanup")
	}
	if got := p.activeCount(); got != 0 {
		t.Fatalf("active slots after predecessor cleanup = %d, want 0", got)
	}
}

func TestSessionPoolFinalizationGateLinearizesWithTakeoverDetach(t *testing.T) {
	p := newSessionPool(1)
	live := registerPoolSession(t, p, "finalizing", true)
	p.installDetach(live, func() {})

	if !p.beginFinalization(context.Background(), live) {
		t.Fatal("current supervisor could not enter finalization before a detach")
	}
	done, detached := p.detachExpectedForTakeover(live)
	if !detached {
		t.Fatal("takeover did not detach the finalizing predecessor")
	}
	if p.beginFinalization(context.Background(), live) {
		t.Fatal("predecessor entered local finalization after takeover detach won")
	}
	select {
	case <-done:
		t.Fatal("takeover crossed an in-progress predecessor cleanup")
	default:
	}
	p.finish(live)
	<-done

	replacement := registerPoolSession(t, p, "finalizing", true)
	if p.beginFinalization(context.Background(), live) {
		t.Fatal("removed predecessor passed the finalization gate after replacement")
	}
	if !p.beginFinalization(context.Background(), replacement) {
		t.Fatal("current replacement did not pass the finalization gate")
	}
}

func TestSessionPoolEvictsLeastRecentlyActiveWarm(t *testing.T) {
	clock := newFakePoolClock()
	p := newSessionPoolWithClock(2, clock)
	cancelled := map[string]int{}

	a := registerPoolSession(t, p, "a", true)
	genA, _, _ := p.reserveEngine(a, context.Background(), context.Background())
	p.engineStarted(a, genA, func() { cancelled["a"]++ })
	parkPoolSession(p, a)
	clock.Advance(time.Minute)

	b := registerPoolSession(t, p, "b", true)
	genB, _, _ := p.reserveEngine(b, context.Background(), context.Background())
	p.engineStarted(b, genB, func() { cancelled["b"]++ })
	parkPoolSession(p, b)
	clock.Advance(time.Minute)

	// A cold active claim reduces idle warm capacity from two to one. A is the
	// older warm engine and must be selected even though map iteration is random.
	c := registerPoolSession(t, p, "c", true)
	if cancelled["a"] != 1 || cancelled["b"] != 0 {
		t.Fatalf("LRU cancellations = %#v, want only a", cancelled)
	}
	if !p.engineStopped(a, genA) {
		t.Fatal("LRU victim a was not marked evicted")
	}
	genC, _, ok := p.reserveEngine(c, context.Background(), context.Background())
	if !ok {
		t.Fatal("cold active c did not reserve capacity after LRU Wait")
	}
	if p.residentCount() != 2 {
		t.Fatalf("resident after LRU replacement = %d, want cap 2", p.residentCount())
	}
	_ = genC
	_ = genB
}

func TestSessionPoolFullActivePermitsRecycleAllWarm(t *testing.T) {
	const limit = 32
	clock := newFakePoolClock()
	p := newSessionPoolWithClock(limit, clock)
	type running struct {
		s   *liveSession
		gen uint64
	}
	old := make([]running, 0, limit)
	cancelled := 0

	for i := 0; i < limit; i++ {
		id := "warm-" + time.Unix(int64(i), 0).Format("150405")
		s := registerPoolSession(t, p, id, true)
		gen, _, ok := p.reserveEngine(s, context.Background(), context.Background())
		if !ok {
			t.Fatalf("failed to reserve warm engine %d", i)
		}
		p.engineStarted(s, gen, func() { cancelled++ })
		parkPoolSession(p, s)
		clock.Advance(time.Second)
		old = append(old, running{s, gen})
	}
	if p.activeCount() != 0 || p.residentCount() != limit || p.warmCountLockedForTest() != limit {
		t.Fatalf("initial active/resident/warm = %d/%d/%d", p.activeCount(), p.residentCount(), p.warmCountLockedForTest())
	}

	// Thirty-two cold claims own every active permit. Warm capacity is therefore
	// zero, so every old engine is selected for recycling before any new one starts.
	for i := 0; i < limit; i++ {
		registerPoolSession(t, p, "cold-"+time.Unix(int64(i), 0).Format("150405"), true)
	}
	if got := p.activeCount(); got != limit {
		t.Fatalf("active permits = %d, want %d", got, limit)
	}
	if got := p.warmCountLockedForTest(); got != 0 {
		t.Fatalf("usable warm engines at full active capacity = %d, want 0", got)
	}
	if cancelled != limit {
		t.Fatalf("warm eviction cancellations = %d, want %d", cancelled, limit)
	}
	// Until Wait returns, old evicting processes remain counted resident; no cold
	// process has been allowed to exceed the hard resident cap.
	if got := p.residentCount(); got != limit {
		t.Fatalf("resident during eviction = %d, want hard cap %d", got, limit)
	}
	for _, r := range old {
		if !p.engineStopped(r.s, r.gen) {
			t.Fatalf("old engine %s did not stop as eviction", r.s.id)
		}
	}
	if got := p.residentCount(); got != 0 {
		t.Fatalf("resident after all old Waits = %d, want 0 before cold starts", got)
	}
}

func (p *sessionPool) warmCountLockedForTest() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.warmCountLocked()
}

func manualWorktreePoolJob(id, branch string) *ClaimedSession {
	job := poolJob(id)
	job.Branch = branch
	job.WT = &Worktree{Path: "worktree-" + id, Branch: branch}
	return job
}

func waitForWorktreeFence(t *testing.T, p *sessionPool, id string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		p.mu.Lock()
		state := p.worktreeOps[id]
		fenced := state != nil && state.fenced
		p.mu.Unlock()
		if fenced {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("worktree operation for %s was not fenced", id)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestSessionPoolManualWorktreeOperationsSerializePerSession(t *testing.T) {
	p := newSessionPool(2)
	live, added := p.register(manualWorktreePoolJob("same", "orbit/same"), func() {}, false)
	if !added {
		t.Fatal("failed to register idle session")
	}

	releaseFirst, admitted := p.beginHeartbeatWorktreeOperation(
		"same", live, 0, true,
	)
	if !admitted {
		t.Fatal("first worktree operation was not admitted")
	}
	if release, ok := p.beginHeartbeatWorktreeOperation(
		"same", live, 0, false,
	); ok {
		release()
		t.Fatal("second operation for the same session crossed the mutex")
	}

	// Serialization is per session, not runner-wide. A terminal merge for a
	// different completed session may proceed concurrently without a supervisor.
	releaseOther, admitted := p.beginHeartbeatWorktreeOperation(
		"other", nil, 0, false,
	)
	if !admitted {
		t.Fatal("different session was unnecessarily blocked")
	}
	releaseOther()
	releaseFirst()
	releaseFirst() // completion is deliberately idempotent

	releaseAgain, admitted := p.beginHeartbeatWorktreeOperation(
		"same", live, 0, true,
	)
	if !admitted {
		t.Fatal("same session did not reopen after the first operation completed")
	}
	releaseAgain()
	p.finish(live)
}

func TestSessionPoolManualWorktreeOperationRejectsStaleSupervisor(t *testing.T) {
	p := newSessionPool(1)
	old, added := p.register(manualWorktreePoolJob("epoch", "orbit/epoch"), func() {}, false)
	if !added {
		t.Fatal("failed to register predecessor")
	}
	advertised, _ := p.heartbeatSnapshot()
	stale := advertised["epoch"]
	p.finish(old)

	replacement, added := p.register(manualWorktreePoolJob("epoch", "orbit/epoch"), func() {}, false)
	if !added {
		t.Fatal("failed to register replacement")
	}
	if release, ok := p.beginHeartbeatWorktreeOperation(
		"epoch", stale.supervisor, stale.permitGeneration, false,
	); ok {
		release()
		t.Fatal("stale supervisor pointer admitted work against the replacement epoch")
	}
	if release, ok := p.beginHeartbeatWorktreeOperation(
		"epoch", nil, 0, false,
	); ok {
		release()
		t.Fatal("an absent-supervisor snapshot admitted work after a replacement appeared")
	}
	release, ok := p.beginHeartbeatWorktreeOperation(
		"epoch", replacement, 0, true,
	)
	if !ok {
		t.Fatal("current supervisor was rejected")
	}
	release()
	p.finish(replacement)
}

func TestSessionPoolAdoptedCommitBranchDoesNotRejectExactIdleSupervisor(t *testing.T) {
	p := newSessionPool(1)
	job := manualWorktreePoolJob("adopted", "orbit/original")
	live, added := p.register(job, func() {}, false)
	if !added {
		t.Fatal("failed to register idle session")
	}
	advertised, _ := p.heartbeatSnapshot()
	snapshot := advertised[job.SessionID]
	command := CommitCommand{
		SessionID: job.SessionID,
		Branch:    "orbit/adopted-after-server-side-update",
	}
	if command.Branch == job.Branch {
		t.Fatal("test setup did not model a server-side Adopt branch change")
	}

	release, admitted := p.beginHeartbeatWorktreeOperation(
		command.SessionID,
		snapshot.supervisor,
		snapshot.permitGeneration,
		true,
	)
	if !admitted {
		t.Fatal("newly adopted command branch rejected the exact idle supervisor")
	}
	release()
	p.finish(live)
}

func TestSessionPoolManualWorktreeOperationRejectsStalePermit(t *testing.T) {
	p := newSessionPool(1)
	live, added := p.register(manualWorktreePoolJob("permit", "orbit/permit"), func() {}, true)
	if !added {
		t.Fatal("failed to register active session")
	}
	oldPermit := p.permitGeneration(live)
	p.park(live, oldPermit)

	if _, ok := p.activate(manualWorktreePoolJob("permit", "orbit/permit")); !ok {
		t.Fatal("failed to activate next permit")
	}
	currentPermit := p.permitGeneration(live)
	if currentPermit == oldPermit {
		t.Fatal("activation did not advance the permit generation")
	}
	p.park(live, currentPermit)

	if release, ok := p.beginHeartbeatWorktreeOperation(
		"permit", live, oldPermit, true,
	); ok {
		release()
		t.Fatal("stale heartbeat permit admitted a worktree operation")
	}
	release, ok := p.beginHeartbeatWorktreeOperation(
		"permit", live, currentPermit, true,
	)
	if !ok {
		t.Fatal("current parked permit was rejected")
	}
	release()
	p.finish(live)
}

func TestSessionPoolActivationDoesNotCrossManualWorktreeOperation(t *testing.T) {
	p := newSessionPool(1)
	live, added := p.register(manualWorktreePoolJob("activate", "orbit/activate"), func() {}, false)
	if !added {
		t.Fatal("failed to register idle session")
	}
	release, admitted := p.beginHeartbeatWorktreeOperation(
		"activate", live, 0, true,
	)
	if !admitted {
		t.Fatal("manual operation was not admitted")
	}

	prepared := 0
	if _, ok := p.activatePrepared(manualWorktreePoolJob("activate", "orbit/activate"), func() {
		prepared++
	}); ok {
		t.Fatal("activation crossed a running manual worktree operation")
	}
	if prepared != 0 {
		t.Fatalf("activation prepare ran %d times while the gate was occupied", prepared)
	}

	release()
	activated, ok := p.activatePrepared(manualWorktreePoolJob("activate", "orbit/activate"), func() {
		prepared++
	})
	if !ok || activated != live {
		t.Fatal("activation was not admitted after the manual operation completed")
	}
	if prepared != 1 {
		t.Fatalf("activation prepare calls = %d, want 1", prepared)
	}
	p.finish(live)
}

func TestSessionPoolFinalizationWaitsForManualWorktreeOperation(t *testing.T) {
	p := newSessionPool(1)
	live, added := p.register(manualWorktreePoolJob("finalize", "orbit/finalize"), func() {}, false)
	if !added {
		t.Fatal("failed to register idle session")
	}
	release, admitted := p.beginHeartbeatWorktreeOperation(
		"finalize", live, 0, true,
	)
	if !admitted {
		t.Fatal("manual operation was not admitted")
	}

	finalized := make(chan bool, 1)
	go func() {
		finalized <- p.beginFinalization(context.Background(), live)
	}()
	waitForWorktreeFence(t, p, "finalize")
	select {
	case got := <-finalized:
		t.Fatalf("finalization crossed the running manual operation: %v", got)
	default:
	}
	if nextRelease, ok := p.beginHeartbeatWorktreeOperation(
		"finalize", live, 0, true,
	); ok {
		nextRelease()
		t.Fatal("finalization fence admitted a new manual operation")
	}

	release()
	select {
	case ok := <-finalized:
		if !ok {
			t.Fatal("current supervisor did not enter finalization after the operation drained")
		}
	case <-time.After(time.Second):
		t.Fatal("finalization did not resume after the manual operation drained")
	}
	p.finish(live)
}

func TestSessionPoolTerminalMergeAllowsNilSupervisorOnly(t *testing.T) {
	p := newSessionPool(1)
	release, admitted := p.beginHeartbeatWorktreeOperation(
		"completed", nil, 0, false,
	)
	if !admitted {
		t.Fatal("terminal merge without a resident supervisor was rejected")
	}
	if commitRelease, ok := p.beginHeartbeatWorktreeOperation(
		"another-completed", nil, 0, true,
	); ok {
		commitRelease()
		t.Fatal("commit without a resident supervisor was admitted")
	}
	release()
}
