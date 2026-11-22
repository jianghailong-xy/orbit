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

// A reclaimed turn waits while the hold is on and starts once it lifts; a session that ends stops the wait.
func TestWaitForAdmissionHoldsAReclaimedTurn(t *testing.T) {
	pool := newSessionPool(2)
	pool.setAdmissionHold("free space on the data volume is low")
	done := make(chan struct{})
	go func() {
		waitForAdmission(context.Background(), context.Background(), pool, "reclaimed", 5*time.Millisecond)
		close(done)
	}()
	select {
	case <-done:
		t.Fatal("the reclaimed turn started under the hold")
	case <-time.After(50 * time.Millisecond):
	}
	pool.setAdmissionHold("")
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the reclaimed turn did not start once the hold lifted")
	}

	pool.setAdmissionHold("free space on the data volume is low")
	ended, end := context.WithCancel(context.Background())
	end()
	waitForAdmission(ended, context.Background(), pool, "ended", time.Hour)
}

// The wiring in runLoop: a managed runner's reserve is watched before the reclaim, and a reclaimed turn waits
// for it before its session runs.
func TestRunLoopHoldsWorkBelowTheReserve(t *testing.T) {
	body := runLoopSource(t)
	watch := strings.Index(body, "watchDataVolumeReserve(loopCtx, pool,")
	reclaim := strings.Index(body, "reclaimWaitedOnSessions(")
	if watch < 0 || reclaim < watch {
		t.Fatal("the reserve is not watched before the reclaim and the first claim")
	}
	wait := strings.Index(body, "waitForAdmission(jobCtx, loopCtx, pool, j.SessionID, dataVolumeCheckInterval)")
	run := strings.Index(body, "runInteractiveSession(t, j, jobCtx")
	if wait < 0 || run < wait || !strings.Contains(body[wait-120:wait], "activeAtRegister && j.Reclaimed") {
		t.Fatal("a reclaimed turn does not wait for the reserve before its session runs")
	}
	if !strings.Contains(body, "if pool.admissionIdleCapacity() <= 0 {") {
		t.Fatal("the claim loop no longer reads the pool's capacity before claiming")
	}
}
