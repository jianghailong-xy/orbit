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
