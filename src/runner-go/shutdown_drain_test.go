package main

import (
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The stop a runner makes once its claim loop is over (shutdown_drain.go): the heartbeat keeps beating
// while the work the heartbeat started finishes, that work has a budget, and what is left of it when
// the budget runs out is stopped — never waited for past the deadline. The budgets here are scaled
// down from the real ones (100 s and 170 s) to fractions of a second; the order and the arithmetic
// are the real sequence's.

// stopRecord is what a test's sequence was asked to do, and when.
type stopRecord struct {
	mu            sync.Mutex
	start         time.Time
	interrupts    []time.Duration
	resetsStopped time.Duration
	heartbeatStop time.Duration
}

func (r *stopRecord) since() time.Duration { return time.Since(r.start) }

func (r *stopRecord) sequence(sessions, operations func() int, interrupt func()) shutdownSequence {
	return shutdownSequence{
		sessions:   sessions,
		operations: operations,
		stopResets: func() {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.resetsStopped = r.since()
		},
		interrupt: func() {
			r.mu.Lock()
			r.interrupts = append(r.interrupts, r.since())
			r.mu.Unlock()
			if interrupt != nil {
				interrupt()
			}
		},
		stopHeartbeat: func() {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.heartbeatStop = r.since()
		},
		poll: 5 * time.Millisecond,
	}
}

// A landing still checking when the sessions have drained keeps the heartbeat beating until it is done:
// the stop that went silent at once and waited for the check is the one the lab's Pod was killed in.
func TestTheStopKeepsTheHeartbeatUntilTheOperationsFinish(t *testing.T) {
	var ops countedOps
	ops.Add(1)
	finished := make(chan time.Duration, 1)
	rec := &stopRecord{start: time.Now()}
	go func() {
		time.Sleep(300 * time.Millisecond)
		finished <- rec.since()
		ops.Done()
	}()

	left := rec.sequence(func() int { return 0 }, ops.inFlight, nil).run(rec.start.Add(5*time.Second), rec.start.Add(10*time.Second))

	if left != (shutdownLeft{}) {
		t.Fatalf("left = %+v, want nothing left", left)
	}
	if len(rec.interrupts) != 0 {
		t.Fatalf("an operation that finished inside its budget was interrupted at %v", rec.interrupts)
	}
	opEnded := <-finished
	if rec.heartbeatStop < opEnded {
		t.Fatalf("the heartbeat stopped at %v, before the operation ended at %v", rec.heartbeatStop, opEnded)
	}
	if rec.heartbeatStop > opEnded+time.Second {
		t.Fatalf("the heartbeat stopped at %v, long after the operation ended at %v: the stop waited for nothing", rec.heartbeatStop, opEnded)
	}
}

// At its budget an operation is stopped — once — and the stop then waits for it to wind up (a landing
// removing its worktree and handing its claim back) before the heartbeat stops.
func TestTheStopInterruptsOperationsAtTheirBudgetAndWaitsForTheHandBack(t *testing.T) {
	var ops countedOps
	ops.Add(1)
	handedBack := make(chan time.Duration, 1)
	rec := &stopRecord{start: time.Now()}
	interrupt := func() {
		go func() {
			time.Sleep(100 * time.Millisecond) // the worktree removal and the hand-back request
			handedBack <- rec.since()
			ops.Done()
		}()
	}

	left := rec.sequence(func() int { return 0 }, ops.inFlight, interrupt).run(rec.start.Add(300*time.Millisecond), rec.start.Add(5*time.Second))

	if left != (shutdownLeft{}) {
		t.Fatalf("left = %+v, want nothing left", left)
	}
	if len(rec.interrupts) != 1 {
		t.Fatalf("interrupted %d times, want once", len(rec.interrupts))
	}
	if at := rec.interrupts[0]; at < 300*time.Millisecond || at > 800*time.Millisecond {
		t.Fatalf("interrupted at %v, want at the 300ms budget", at)
	}
	if back := <-handedBack; rec.heartbeatStop < back {
		t.Fatalf("the heartbeat stopped at %v, before the hand-back at %v", rec.heartbeatStop, back)
	}
}

// The operations' budget counts from the stop, not from the end of the sessions' drain: a turn that
// takes the whole turn drain must not leave the landing beside it with no time to hand itself back.
// The reset steps are stopped where they always were, once the sessions have drained.
func TestTheOperationsBudgetRunsWhileTheSessionsStillDrain(t *testing.T) {
	var sessions atomic.Int32
	sessions.Store(1)
	var ops countedOps
	ops.Add(1)
	rec := &stopRecord{start: time.Now()}
	go func() {
		time.Sleep(600 * time.Millisecond)
		sessions.Store(0)
	}()
	interrupt := func() { go ops.Done() }

	left := rec.sequence(func() int { return int(sessions.Load()) }, ops.inFlight, interrupt).
		run(rec.start.Add(200*time.Millisecond), rec.start.Add(5*time.Second))

	if left != (shutdownLeft{}) {
		t.Fatalf("left = %+v, want nothing left", left)
	}
	if len(rec.interrupts) != 1 || rec.interrupts[0] > 500*time.Millisecond {
		t.Fatalf("interrupts = %v, want one at the 200ms budget while the session still drained", rec.interrupts)
	}
	if rec.resetsStopped < 600*time.Millisecond {
		t.Fatalf("the reset steps were stopped at %v, before the sessions had drained", rec.resetsStopped)
	}
	if rec.heartbeatStop < rec.resetsStopped {
		t.Fatalf("the heartbeat stopped at %v, before the sessions had drained (%v)", rec.heartbeatStop, rec.resetsStopped)
	}
}

// What never ends is not waited for past the deadline: the stop says how much it left behind (so the
// run loop neither re-executes over it nor joins it) and the heartbeat still stops.
func TestTheStopLeavesWhatNeverEndsAtTheDeadline(t *testing.T) {
	var ops countedOps
	ops.Add(1)
	defer ops.Done()
	rec := &stopRecord{start: time.Now()}

	left := rec.sequence(func() int { return 0 }, ops.inFlight, nil).run(rec.start.Add(100*time.Millisecond), rec.start.Add(400*time.Millisecond))

	if left.operations != 1 || left.sessions != 0 {
		t.Fatalf("left = %+v, want the one operation that never ended", left)
	}
	if len(rec.interrupts) != 1 {
		t.Fatalf("interrupted %d times, want once", len(rec.interrupts))
	}
	if rec.heartbeatStop < 400*time.Millisecond || rec.heartbeatStop > 2*time.Second {
		t.Fatalf("the heartbeat stopped at %v, want at the 400ms deadline", rec.heartbeatStop)
	}
}

// The same for sessions: a supervisor still attached at the deadline is left, the operations are not
// waited for past it either, and the heartbeat still stops.
func TestTheStopLeavesSessionsAtTheDeadlineToo(t *testing.T) {
	rec := &stopRecord{start: time.Now()}
	left := rec.sequence(func() int { return 2 }, func() int { return 0 }, nil).run(rec.start.Add(100*time.Millisecond), rec.start.Add(300*time.Millisecond))
	if left.sessions != 2 || left.operations != 0 {
		t.Fatalf("left = %+v, want the two attached sessions", left)
	}
	if len(rec.interrupts) != 0 {
		t.Fatalf("interrupted with no operation running: %v", rec.interrupts)
	}
	if rec.heartbeatStop < 300*time.Millisecond {
		t.Fatalf("the heartbeat stopped at %v, before the deadline", rec.heartbeatStop)
	}
}

// The heartbeat itself, as runLoop runs it: beats keep coming while a landing finishes after the
// sessions have drained, and one more comes as the stop ends — the beat the control plane's 90 s
// silence clock then counts from — and none after.
func TestTheHeartbeatBeatsThroughTheStopAndOnceMoreAtItsEnd(t *testing.T) {
	var mu sync.Mutex
	var beats []time.Duration
	start := time.Now()
	stop := make(chan struct{})
	done := make(chan struct{})
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	go func() {
		defer close(done)
		beatUntilStopped(stop, ticker.C, nil, func() {
			mu.Lock()
			beats = append(beats, time.Since(start))
			mu.Unlock()
		})
	}()

	var ops countedOps
	ops.Add(1)
	var opEnded atomic.Int64
	go func() {
		time.Sleep(300 * time.Millisecond)
		opEnded.Store(int64(time.Since(start)))
		ops.Done()
	}()
	var stoppedAt time.Duration
	shutdownSequence{
		sessions:   func() int { return 0 },
		operations: ops.inFlight,
		stopResets: func() {},
		interrupt:  func() {},
		stopHeartbeat: func() {
			close(stop)
			<-done
			stoppedAt = time.Since(start)
		},
		poll: 5 * time.Millisecond,
	}.run(start.Add(5*time.Second), start.Add(10*time.Second))

	mu.Lock()
	defer mu.Unlock()
	ended := time.Duration(opEnded.Load())
	during := 0
	for _, at := range beats {
		if at <= ended {
			during++
		}
	}
	if during < 5 {
		t.Fatalf("%d beats while the landing ran for %v (beats at %v): the heartbeat went quiet", during, ended, beats)
	}
	last := beats[len(beats)-1]
	if last < ended {
		t.Fatalf("the last beat came at %v, before the landing ended at %v: no beat closed the stop", last, ended)
	}
	if last > stoppedAt {
		t.Fatalf("a beat at %v came after the heartbeat was stopped at %v", last, stoppedAt)
	}
}

// A heartbeat answer to a request sent before the stop can still hand this process a landing. It is
// handed back rather than left RUNNING — unless it is one this process is already running, or one
// claimed for another process — and each hand-back is counted until it is done, so the stop waits.
func TestLandingsHandedOverAfterTheStopBeganAreHandedBack(t *testing.T) {
	var ops countedOps
	gate := make(chan struct{})
	handed := make(chan string, 4)
	handBackUnstartedIntegrationJobs([]IntegrationJobCommand{
		{JobID: "claimed-for-this-process", LeaseOwner: "this-process"},
		{JobID: "claimed-for-another", LeaseOwner: "another-process"},
		{JobID: "already-running-here", LeaseOwner: "this-process"},
		{JobID: "from-an-older-control-plane"},
	}, "this-process", func(jobID string) bool { return jobID == "already-running-here" }, &ops, func(job IntegrationJobCommand) {
		<-gate
		handed <- job.JobID
	})
	if n := ops.inFlight(); n != 2 {
		t.Fatalf("operations in flight = %d, want the two hand-backs counted while they are sent", n)
	}
	close(gate)
	var got []string
	for range 2 {
		select {
		case id := <-handed:
			got = append(got, id)
		case <-time.After(5 * time.Second):
			t.Fatalf("hand-backs sent: %v, want two", got)
		}
	}
	slices.Sort(got)
	if want := []string{"claimed-for-this-process", "from-an-older-control-plane"}; !slices.Equal(got, want) {
		t.Fatalf("handed back %v, want %v", got, want)
	}
	ops.Wait()
}

// Asked of the source, as the self-update's turn gate is (TestTheRunLoopOnlyUpdatesThroughTheTurnGate):
// runLoop runs nothing else than this sequence between its claim loop and its exit. The heartbeat is
// stopped in one place, the sequence's last step; it runs through beatUntilStopped, which beats once
// more as it stops; and a landing works under the stop's operations budget rather than under the claim
// loop's context, which ends the moment the stop begins.
func TestTheRunLoopStopsTheHeartbeatOnlyAtTheEndOfTheStop(t *testing.T) {
	src, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatalf("read runloop.go: %v", err)
	}
	body := string(src)
	body = body[strings.Index(body, "func runLoop("):]
	body = body[:strings.Index(body, "\n}\n")]
	sequence := strings.Index(body, "left := shutdownSequence{")
	run := strings.Index(body, "}.run(drainStart.Add(shutdownOperationsTimeout), drainDeadline)")
	if sequence < 0 || run < sequence {
		t.Fatal("runLoop does not stop through shutdownSequence")
	}
	if strings.Count(body, "close(hbStop)") != 1 {
		t.Fatal("runLoop closes hbStop more than once, or not at all")
	}
	if at := strings.Index(body, "close(hbStop)"); at < sequence || at > run {
		t.Fatal("runLoop stops the heartbeat outside the stop sequence: it would go quiet while the heartbeat's work finishes")
	}
	for _, want := range []string{
		"beatUntilStopped(hbStop, ticker.C, hbNow, beat)",
		"runIntegrationJobAndReport(opsCtx, handBackCtx, t, job)",
		"interrupt:  interruptOps,",
		"operations: operationsInFlight,",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("runLoop no longer has %q", want)
		}
	}
	if strings.Contains(body, "runIntegrationJobAndReport(loopCtx") {
		t.Error("a landing runs under the claim loop's context again: the stop would end its sends at once")
	}
}
