package main

import (
	"context"
	"testing"
	"time"
)

// Stage-0 stopgap coverage: warm recycling must see background work that holds no
// active turn permit, and must not let that work hold an engine forever. Deleting
// this file is part of the stage-3 removal that makes background jobs runner-owned.

// A parked session's Bash(run_in_background) children are children of the engine
// process, so LRU-recycling that engine reports them killed. The victim search must
// therefore put a supervisor with a live job last — last, not out of reach: once the
// job ends it is an ordinary LRU candidate again.
func TestWarmEvictionSparesSessionWithLiveBackgroundJob(t *testing.T) {
	clock := newFakePoolClock()
	p := newSessionPoolWithClock(2, clock)
	cancelled := map[string]int{}

	// "a" is the least-recently-active warm engine — the one pure lastActive
	// ordering picks — and it is the one still running a background job.
	a := registerPoolSession(t, p, "a", true)
	genA, _, _ := p.reserveEngine(a, context.Background(), context.Background())
	p.engineStarted(a, genA, func() { cancelled["a"]++ })
	parkPoolSession(p, a)
	jobLive := true
	p.setBackgroundJobProbe(a, func() bool { return jobLive })
	clock.Advance(time.Minute)

	b := registerPoolSession(t, p, "b", true)
	genB, _, _ := p.reserveEngine(b, context.Background(), context.Background())
	p.engineStarted(b, genB, func() { cancelled["b"]++ })
	parkPoolSession(p, b)
	clock.Advance(time.Minute)

	// One cold active claim cuts idle warm capacity from two to one: exactly one victim.
	registerPoolSession(t, p, "c", true)
	if cancelled["a"] != 0 {
		t.Fatalf("warm engine with a live background job was evicted: %#v", cancelled)
	}
	if cancelled["b"] != 1 {
		t.Fatalf("eviction cancellations = %#v, want the job-free engine b", cancelled)
	}
	if !p.engineStopped(b, genB) {
		t.Fatal("victim b was not marked evicted")
	}

	// The paired positive: with its job finished, "a" carries no deferral at all and
	// is recycled by the very next round of pressure.
	jobLive = false
	registerPoolSession(t, p, "d", true)
	if cancelled["a"] != 1 {
		t.Fatalf("cancellations for a after its job ended = %d, want an ordinary LRU victim", cancelled["a"])
	}
}

// The deferral has an absolute top. A background job that never ends must delay
// recycling, never cancel it — otherwise one forgotten dev server pins an engine in
// memory for the life of the runner, on a host with a global-OOM history.
func TestWarmResidencyHardCapEvictsAnyway(t *testing.T) {
	clock := newFakePoolClock()
	p := newSessionPoolWithClock(1, clock)
	s := registerPoolSession(t, p, "a", true)
	cancelled := 0
	gen := startPoolEngine(t, p, s, &cancelled)
	p.setBackgroundJobProbe(s, func() bool { return true }) // never finishes
	parkPoolSession(p, s)

	// Renewal is real: the base TTL alone no longer recycles the engine.
	clock.Advance(warmEngineTTL)
	if cancelled != 0 {
		t.Fatalf("cancellations at the base TTL = %d, want the live job to renew it", cancelled)
	}
	// ...and bounded. Walk to a nanosecond short of the cap, then over it.
	clock.Advance(warmResidencyHardCap - warmEngineTTL - time.Nanosecond)
	if cancelled != 0 {
		t.Fatalf("cancellations before the residency hard cap = %d, want 0", cancelled)
	}
	clock.Advance(time.Nanosecond)
	if cancelled != 1 {
		t.Fatalf("cancellations at the residency hard cap = %d, want the engine recycled anyway", cancelled)
	}
	if !p.engineStopped(s, gen) {
		t.Fatal("hard-cap eviction must be classified as a silent eviction")
	}
	if got := p.residentCount(); got != 0 {
		t.Fatalf("resident after the hard cap = %d, want 0", got)
	}
}
