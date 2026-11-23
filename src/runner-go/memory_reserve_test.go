package main

import (
	"context"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// memoryReading is a gate's reading a test sets: bytes available, or none.
type memoryReading struct {
	bytes atomic.Uint64
	none  atomic.Bool
}

func (m *memoryReading) gate() *turnMemoryGate {
	return &turnMemoryGate{reserve: turnMemoryReserveBytes, recheck: 10 * time.Millisecond, available: func() (uint64, bool) {
		if m.none.Load() {
			return 0, false
		}
		return m.bytes.Load(), true
	}}
}

// The reserve: below one more turn's memory the gate refuses, at or above it admits, and with no reading, or on a
// runner that is not a managed instance (no gate), it admits as before.
func TestTurnMemoryGateRefusesBelowTheReserve(t *testing.T) {
	var m memoryReading
	g := m.gate()
	for _, c := range []struct {
		available uint64
		want      bool
	}{
		{turnMemoryReserveBytes - 1, false},
		{100 << 20, false},
		{0, false},
		{turnMemoryReserveBytes, true},
		{3 << 30, true},
	} {
		m.bytes.Store(c.available)
		if got := g.admits(); got != c.want {
			t.Errorf("%d MiB available: admits = %v, want %v", c.available>>20, got, c.want)
		}
	}
	m.none.Store(true)
	if !g.admits() {
		t.Error("a gate with no memory reading refused a turn")
	}
	var none *turnMemoryGate
	if !none.admits() {
		t.Error("no gate refused a turn")
	}
	if newTurnMemoryGate(false) != nil {
		t.Error("a runner that is not a managed instance got a memory gate")
	}
	if g := newTurnMemoryGate(true); g == nil || g.reserve != 1<<30 {
		t.Errorf("a managed instance's gate = %+v, want a 1 GiB reserve", g)
	}
	if line := turnMemoryLine(true, 512<<20, turnMemoryReserveBytes); line != "memory: 512 MiB available, below the 1024 MiB one more turn needs; no new or reclaimed turn starts until it frees up" {
		t.Errorf("short line = %q", line)
	}
}

// The claim loop asks the gate before every claim, ahead of the saturation check, and a refusal claims nothing: it
// waits and goes round again. The startup reclaim's active starts wait on the pool's permit with the same gate.
func TestRunLoopClaimsNothingBelowTheMemoryReserve(t *testing.T) {
	src, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	body = body[strings.Index(body, "func runLoop("):]
	body = body[:strings.Index(body, "\n}\n")]
	if !strings.Contains(body, "turnMemory := newTurnMemoryGate(currentManagedInstance() != nil)") {
		t.Error("runLoop does not arm the memory gate on a managed instance")
	}
	if !strings.Contains(body, "startupStarts.admit = func() { pool.waitReclaimPermit(loopCtx, turnMemory) }") {
		t.Error("the startup reclaim's active starts do not wait for a permit and the memory reserve")
	}
	loop := body[strings.Index(body, "\tfor loopCtx.Err() == nil {"):]
	// Every reclaim the claim loop makes later starts its RUNNING sessions through the same permit, one after another.
	if starts, admitted := strings.Count(loop, "startSession(pending.job, pending.initiallyActive)"),
		strings.Count(loop, "admitReclaimed(pending)\n"); starts == 0 || admitted != starts {
		t.Errorf("%d reclaimed starts in the claim loop, %d of them waiting for their permit first", starts, admitted)
	}
	if !strings.Contains(body, "admitReclaimed := func(pending reclaimedStart) {\n\t\tif pending.initiallyActive {\n\t\t\tpool.waitReclaimPermit(loopCtx, turnMemory)") {
		t.Error("a later reclaim's RUNNING session does not wait for a permit and the memory reserve")
	}
	gate := strings.Index(loop, "\t\tif !turnMemory.admits() {\n\t\t\tselect {\n\t\t\tcase <-loopCtx.Done():\n\t\t\tcase <-time.After(500 * time.Millisecond):\n\t\t\t}\n\t\t\tcontinue\n\t\t}\n")
	saturation := strings.Index(loop, "if !pool.canClaim() {")
	claim := strings.Index(loop, "job, err := t.claimSession(loopCtx, &claims, scope...)")
	if gate < 0 || saturation < gate || claim < saturation {
		t.Error("the claim loop does not refuse to claim below the memory reserve before every claim")
	}
}

// reclaimPermitRig is a pool and a starter of reclaimed sessions, whose starts register their supervisors as the
// run loop's startSession does, counting how many starts overlap.
type reclaimPermitRig struct {
	pool    *sessionPool
	memory  memoryReading
	starter *reclaimStarter

	mu       sync.Mutex
	inStart  int // active starts under way
	overlaps int
	maxSeen  int
	started  []string
	live     map[string]*liveSession
}

func newReclaimPermitRig(t *testing.T, max int, running, idle []string) *reclaimPermitRig {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	rig := &reclaimPermitRig{pool: newSessionPool(max), live: map[string]*liveSession{}}
	rig.memory.bytes.Store(3 << 30)
	gate := rig.memory.gate()
	var pending []reclaimedStart
	for _, id := range running {
		_, end := rig.pool.beginWorktreeTakeover(id)
		pending = append(pending, reclaimedStart{job: poolJob(id), initiallyActive: true, endTakeover: end, status: stRunning})
	}
	for _, id := range idle {
		_, end := rig.pool.beginWorktreeTakeover(id)
		pending = append(pending, reclaimedStart{job: poolJob(id), endTakeover: end, status: stAwaitingInput})
	}
	orderReclaimedStarts(pending)
	rig.starter = newReclaimStarter(rig.pool, pending, nil, func(p reclaimedStart) {
		rig.mu.Lock()
		if p.initiallyActive {
			rig.inStart++
			if rig.inStart > 1 {
				rig.overlaps++
			}
		}
		rig.mu.Unlock()
		// A start is a few git commands: long enough for another to overlap it if anything let one.
		time.Sleep(20 * time.Millisecond)
		s, _ := rig.pool.register(p.job, func() {}, p.initiallyActive)
		rig.mu.Lock()
		if p.initiallyActive {
			rig.inStart--
		}
		rig.started = append(rig.started, p.job.SessionID)
		rig.live[p.job.SessionID] = s
		if n := rig.pool.activeCount(); n > rig.maxSeen {
			rig.maxSeen = n
		}
		rig.mu.Unlock()
	})
	rig.starter.admit = func() { rig.pool.waitReclaimPermit(ctx, gate) }
	return rig
}

func (r *reclaimPermitRig) startedCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.started)
}

func (r *reclaimPermitRig) isStarted(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.live[id] != nil
}

// park ends a started session's turn: its permit comes free.
func (r *reclaimPermitRig) park(id string) {
	r.mu.Lock()
	s := r.live[id]
	r.mu.Unlock()
	r.pool.park(s, s.permitGeneration)
}

// A restart with four RUNNING sessions on a pool of two: they start one at a time, two take the two permits, and
// each of the others starts only once a turn has ended and given its permit back. Turn permits never exceed the
// maximum, and the cold session is started by the workers meanwhile, holding no permit.
func TestReclaimedStartsTakePoolPermitsOneAtATime(t *testing.T) {
	running := []string{reclaimOldestRunning, reclaimNewerRunning, "0194a000-0000-7000-8000-000000000011", "0194a000-0000-7000-8000-000000000012"}
	rig := newReclaimPermitRig(t, 2, running, []string{reclaimOldestIdle})
	rig.starter.run(reclaimStartWorkers, nil)

	waitUntil(t, func() bool { return rig.startedCount() == 3 }, "the cold session and the first two RUNNING sessions never started")
	if !rig.isStarted(reclaimOldestIdle) {
		t.Fatal("the cold session waited behind the RUNNING ones for a permit it does not take")
	}
	time.Sleep(100 * time.Millisecond)
	if got := rig.startedCount(); got != 3 {
		t.Fatalf("%d sessions started with both permits held, want 3 (two RUNNING and the cold one)", got)
	}
	if got := rig.pool.admissionIdleCapacity(); got != 0 {
		t.Fatalf("a claim sees %d free slots while RUNNING sessions still wait to be reclaimed, want 0", got)
	}

	// Newest first: the two that started are the two newest RUNNING sessions.
	rig.park("0194a000-0000-7000-8000-000000000012")
	waitUntil(t, func() bool { return rig.startedCount() == 4 }, "a permit came free and the next RUNNING session never started")
	time.Sleep(100 * time.Millisecond)
	if got := rig.startedCount(); got != 4 {
		t.Fatalf("%d sessions started after one permit came free, want 4", got)
	}
	rig.park("0194a000-0000-7000-8000-000000000011")
	rig.starter.wait()

	rig.mu.Lock()
	defer rig.mu.Unlock()
	if rig.overlaps != 0 {
		t.Fatalf("%d reclaimed RUNNING starts overlapped another start; they start one at a time", rig.overlaps)
	}
	if rig.maxSeen > 2 {
		t.Fatalf("%d turn permits held at once on a pool of 2", rig.maxSeen)
	}
	if len(rig.pool.reclaiming) != 0 {
		t.Fatalf("sessions still marked as being reclaimed: %v", rig.pool.reclaiming)
	}
}

// Below the memory reserve a reclaimed RUNNING session does not start, whatever permits are free; once memory comes
// back it does.
func TestAReclaimedStartWaitsForTheMemoryReserve(t *testing.T) {
	rig := newReclaimPermitRig(t, 4, []string{reclaimOldestRunning}, nil)
	rig.memory.bytes.Store(turnMemoryReserveBytes - 1)
	rig.starter.run(reclaimStartWorkers, nil)
	time.Sleep(150 * time.Millisecond)
	if rig.isStarted(reclaimOldestRunning) {
		t.Fatal("a reclaimed RUNNING session started below the memory reserve")
	}
	rig.memory.bytes.Store(2 << 30)
	waitUntil(t, func() bool { return rig.isStarted(reclaimOldestRunning) }, "memory came back and the reclaimed session never started")
	rig.starter.wait()
}

// A claim for a RUNNING session still waiting for its permit starts it on the claim loop at once, as for any queued
// start: the claim was admitted already, and the claim loop is never held behind the permit line.
func TestAClaimForAReclaimedSessionWaitingForItsPermitIsNotHeld(t *testing.T) {
	rig := newReclaimPermitRig(t, 1, []string{reclaimOldestRunning, reclaimNewerRunning}, nil)
	rig.starter.run(reclaimStartWorkers, nil)
	waitUntil(t, func() bool { return rig.isStarted(reclaimNewerRunning) }, "the newest RUNNING session never started")
	settled := make(chan struct{})
	go func() {
		rig.starter.settle(reclaimOldestRunning)
		close(settled)
	}()
	select {
	case <-settled:
	case <-time.After(5 * time.Second):
		t.Fatal("a claim waited behind the permit line")
	}
	if !rig.isStarted(reclaimOldestRunning) {
		t.Fatal("the claim's settle did not start the queued session")
	}
	rig.starter.wait()
}
