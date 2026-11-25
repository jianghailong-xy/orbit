package main

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The reserve is 1 GiB, or a tenth of a volume smaller than 10 GiB.
func TestDataVolumeReserve(t *testing.T) {
	for _, c := range []struct{ total, want uint64 }{
		{20 << 30, 1 << 30},
		{10 << 30, 1 << 30},
		{4 << 30, 4 << 30 / 10},
		{0, 1 << 30},
	} {
		if got := dataVolumeReserve(c.total); got != c.want {
			t.Errorf("dataVolumeReserve(%d) = %d, want %d", c.total, got, c.want)
		}
	}
}

// Below the reserve the hold says why in English; at or above it, or with no reading at all, there is none.
func TestDataVolumeHold(t *testing.T) {
	reason := dataVolumeHold(512<<20, 20<<30, true)
	for _, want := range []string{"free space on the data volume is 512.0 MiB", "below the 1.0 GiB", "starts no new session and no reclaimed turn"} {
		if !strings.Contains(reason, want) {
			t.Errorf("hold reason %q does not say %q", reason, want)
		}
	}
	if got := dataVolumeHold(1<<30, 20<<30, true); got != "" {
		t.Errorf("at the reserve the hold reads %q, want none", got)
	}
	if got := dataVolumeHold(0, 0, false); got != "" {
		t.Errorf("with no reading the hold reads %q, want none", got)
	}
}

// On Docker statfs sees the host's disk: the volume's limit and the channel's measure of it decide.
func TestMeasureDataVolumeHoldReadsTheStorageBudget(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	var storage checkoutStorage
	storage.budget.Store(&StorageBudget{LimitBytes: 10 << 30, UsageBytes: 10<<30 - 300<<20, MeasuredAt: time.Now().UTC().Format(time.RFC3339)})
	reason := measureDataVolumeHold(&storage)
	if !strings.Contains(reason, "is 300.0 MiB, below the 1.0 GiB") {
		t.Fatalf("a volume 300 MiB short of its limit holds with %q", reason)
	}
	storage.budget.Store(&StorageBudget{LimitBytes: 10 << 30, UsageBytes: 1 << 30, MeasuredAt: time.Now().UTC().Format(time.RFC3339)})
	if reason := measureDataVolumeHold(&storage); reason != "" {
		t.Fatalf("a volume with 9 GiB left holds: %q", reason)
	}
}

// While the hold is on, the pool offers no capacity — the one count the claim loop reads before every claim
// and the heartbeat reports as idleCapacity — and a drain claims nothing either. Lifted, both come back.
func TestAdmissionHoldRefusesClaims(t *testing.T) {
	pool := newSessionPool(3)
	if got := pool.admissionIdleCapacity(); got != 3 {
		t.Fatalf("idle capacity %d before any hold, want 3", got)
	}
	if before := pool.setAdmissionHold("free space on the data volume is low"); before != "" {
		t.Fatalf("a hold was on before any was set: %q", before)
	}
	if got := pool.admissionIdleCapacity(); got != 0 {
		t.Fatalf("idle capacity %d under the hold, want 0: the claim loop would claim", got)
	}
	if idle, _ := pool.admissionOccupancy(); idle != 0 {
		t.Fatalf("the heartbeat would report idle capacity %d under the hold, want 0", idle)
	}
	if _, added := pool.register(&ClaimedSession{SessionID: "running"}, func() {}, true); !added {
		t.Fatal("not registered")
	}
	pool.drainForUpdate()
	pool.mu.Lock()
	pool.sessions["running"].resident = true
	pool.mu.Unlock()
	if scope := drainClaimScope(pool, true); scope != nil {
		t.Fatalf("a drain under the hold claims for %v, want nothing", scope)
	}
	pool.endDrainForUpdate()
	if before := pool.setAdmissionHold(""); before != "free space on the data volume is low" {
		t.Fatalf("lifting the hold returned %q", before)
	}
	if got := pool.admissionIdleCapacity(); got != 2 {
		t.Fatalf("idle capacity %d once the hold lifted with one session running, want 2", got)
	}
}

// The watch sets the hold from its measure at once, before anything is claimed, and keeps it current.
func TestWatchDataVolumeReserveSetsTheHold(t *testing.T) {
	pool := newSessionPool(2)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var current atomic.Value
	current.Store("free space on the data volume is 10.0 MiB, below the 1.0 GiB this runner keeps in reserve")
	watchDataVolumeReserve(ctx, pool, func() string { return current.Load().(string) }, 10*time.Millisecond)
	if pool.admissionHoldReason() == "" {
		t.Fatal("the first measure did not set the hold before the watch returned")
	}
	current.Store("")
	deadline := time.Now().Add(5 * time.Second)
	for pool.admissionHoldReason() != "" {
		if time.Now().After(deadline) {
			t.Fatal("the hold did not lift once space was back")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// The two reserves compose on the reclaim line: a reclaimed RUNNING session starts only once a slot is free, memory
// has room for one more turn, and the data volume is above its free-space reserve. Either reserve refusing holds it;
// lifting one leaves it held by the other; lifting both lets it start.
func TestReclaimPermitWaitsForBothReserves(t *testing.T) {
	var m memoryReading
	m.bytes.Store(turnMemoryReserveBytes)
	gate := m.gate()
	pool := newSessionPool(2)
	waiting := func() chan struct{} {
		done := make(chan struct{})
		go func() { pool.waitReclaimPermit(context.Background(), gate); close(done) }()
		return done
	}
	held := func(done chan struct{}, what string) {
		t.Helper()
		select {
		case <-done:
			t.Fatalf("a reclaimed start went ahead %s", what)
		case <-time.After(60 * time.Millisecond):
		}
	}
	started := func(done chan struct{}, what string) {
		t.Helper()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatalf("a reclaimed start was still held %s", what)
		}
	}

	started(waiting(), "with a free slot, memory and disk")

	pool.setAdmissionHold("free space on the data volume is low")
	done := waiting()
	held(done, "below the free-space reserve, with memory to spare")
	m.bytes.Store(turnMemoryReserveBytes - 1)
	pool.setAdmissionHold("")
	held(done, "once the disk came back, with memory still below the turn reserve")
	pool.setAdmissionHold("free space on the data volume is low")
	m.bytes.Store(turnMemoryReserveBytes)
	held(done, "once memory came back, with the disk below its reserve again")
	pool.setAdmissionHold("")
	started(done, "once both reserves admit")
}

// A claim is refused while either reserve refuses: the claim loop reads the memory gate, then asks the pool
// whether it can claim, including during a free-space hold.
func TestClaimsWaitForBothReserves(t *testing.T) {
	body := runLoopSource(t)
	memory := strings.Index(body, "if !turnMemory.admits() {")
	capacity := strings.Index(body, "if !pool.canClaim() {")
	claim := strings.Index(body, "t.claimSession(loopCtx, &claims, scope...)")
	if memory < 0 || capacity < memory || claim < capacity {
		t.Fatal("the claim loop does not read the memory reserve and then the pool's capacity before it claims")
	}
	pool := newSessionPool(2)
	pool.setAdmissionHold("free space on the data volume is low")
	if pool.canClaim() || pool.admissionIdleCapacity() != 0 {
		t.Fatal("under the free-space hold the pool still offers capacity, so a claim would go ahead")
	}
}

// The wiring in runLoop: a managed runner's reserve is watched before the reclaim, and every reclaimed RUNNING
// start goes through the permit line that the hold stops.
func TestRunLoopHoldsWorkBelowTheReserve(t *testing.T) {
	body := runLoopSource(t)
	watch := strings.Index(body, "watchDataVolumeReserve(loopCtx, pool,")
	reclaim := strings.Index(body, "reclaimWaitedOnSessions(")
	if watch < 0 || reclaim < watch {
		t.Fatal("the reserve is not watched before the reclaim and the first claim")
	}
	// Every reclaim's RUNNING starts take the one permit line, which the free-space hold stops (waitReclaimPermit).
	if !strings.Contains(body, "startupStarts.admit = func() { pool.waitReclaimPermit(loopCtx, turnMemory) }") ||
		!strings.Contains(body, "pool.waitReclaimPermit(loopCtx, turnMemory)\n\t\t}\n\t}") {
		t.Fatal("a reclaim starts RUNNING sessions without the permit line the free-space hold stops")
	}
	if !strings.Contains(body, "if !pool.canClaim() {") {
		t.Fatal("the claim loop no longer checks whether the pool can claim")
	}
}
