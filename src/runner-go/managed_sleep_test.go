package main

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// The managed instance's side of idle sleep (managed_sleep.go): it reports what it is doing, accepts
// a sleep request only while it has nothing to do, and stops only once the control plane confirms
// that acceptance.

type fakeSleepClock struct{ at time.Time }

func (c *fakeSleepClock) now() time.Time { return c.at }

func TestManagedWorkloadReportsTheIdleDurationAndRestartsItOnWork(t *testing.T) {
	clock := &fakeSleepClock{at: time.Date(2026, 10, 9, 8, 0, 0, 0, time.UTC)}
	sleeper := &managedSleep{now: clock.now}

	if got := sleeper.report(ManagedWorkload{}); got.IdleSeconds != 0 || !got.idle() {
		t.Fatalf("first idle report: %+v", got)
	}
	clock.at = clock.at.Add(90 * time.Second)
	if got := sleeper.report(ManagedWorkload{}); got.IdleSeconds != 90 {
		t.Fatalf("idle for 90s, reported %+v", got)
	}
	for _, busy := range []ManagedWorkload{{ActiveTurns: 1}, {BackgroundJobs: 1}, {Operations: 1}, {UnflushedEvents: 3}} {
		if got := sleeper.report(busy); got.IdleSeconds != 0 || got.idle() {
			t.Fatalf("busy %+v reported %+v", busy, got)
		}
		clock.at = clock.at.Add(10 * time.Second)
		if got := sleeper.report(ManagedWorkload{}); got.IdleSeconds != 0 {
			t.Fatalf("idle again after %+v: the clock restarts, got %+v", busy, got)
		}
	}
}

func TestManagedSleepIsAcceptedOnlyWhileIdleAndStopsOnlyOnConfirmation(t *testing.T) {
	sleeper := newManagedSleep()
	request := &ManagedSleepRequest{RequestedAt: "2026-10-09T08:00:00.000Z"}

	// Busy: the request is declined, and nothing is sent back as accepted.
	if stop, beat := sleeper.answer(request, false); stop || beat {
		t.Fatalf("busy: stop %v beat %v", stop, beat)
	}
	if got := sleeper.report(ManagedWorkload{Operations: 1}); got.SleepReady != "" {
		t.Fatalf("busy: accepted %q", got.SleepReady)
	}

	// Idle: accepted, sent at once, and still running — the request alone stops nothing.
	if stop, beat := sleeper.answer(request, true); stop || !beat {
		t.Fatalf("idle: stop %v beat %v, want an immediate beat and no stop", stop, beat)
	}
	if got := sleeper.report(ManagedWorkload{}); got.SleepReady != request.RequestedAt {
		t.Fatalf("idle: the next heartbeat carries %q, want the acceptance %q", got.SleepReady, request.RequestedAt)
	}
	if stop, beat := sleeper.answer(request, true); stop || beat {
		t.Fatalf("the same request again: stop %v beat %v", stop, beat)
	}

	// A confirmation of another request stops nothing.
	if stop, _ := sleeper.answer(&ManagedSleepRequest{RequestedAt: "2026-10-09T09:00:00.000Z", Confirmed: true}, true); stop {
		t.Fatal("stopped on the confirmation of a request it never accepted")
	}

	// A withdrawn request (no managedSleep in the answer) clears the acceptance; work does too.
	sleeper.answer(nil, true)
	if got := sleeper.report(ManagedWorkload{}); got.SleepReady != "" {
		t.Fatalf("withdrawn: still accepted %q", got.SleepReady)
	}
	other := &ManagedSleepRequest{RequestedAt: "2026-10-09T10:00:00.000Z"}
	sleeper.answer(other, true)
	if got := sleeper.report(ManagedWorkload{ActiveTurns: 1}); got.SleepReady != "" {
		t.Fatalf("busy: still accepted %q", got.SleepReady)
	}
	// An acceptance never sent is never confirmed into a stop.
	fresh := newManagedSleep()
	fresh.answer(&ManagedSleepRequest{RequestedAt: "2026-10-09T11:00:00.000Z"}, true)
	if stop, _ := fresh.answer(&ManagedSleepRequest{RequestedAt: "2026-10-09T11:00:00.000Z", Confirmed: true}, true); stop {
		t.Fatal("stopped on a confirmation of an acceptance that was never sent")
	}

	// Accepted, sent and confirmed: stop, once — even if work began after the acceptance went out,
	// since the control plane can no longer call the drain off; the drain lets that work finish.
	final := &ManagedSleepRequest{RequestedAt: "2026-10-09T12:00:00.000Z"}
	sleeper.answer(final, true)
	if got := sleeper.report(ManagedWorkload{}); got.SleepReady != final.RequestedAt {
		t.Fatalf("the acceptance is sent: %+v", got)
	}
	sleeper.report(ManagedWorkload{ActiveTurns: 1})
	if stop, _ := sleeper.answer(&ManagedSleepRequest{RequestedAt: final.RequestedAt, Confirmed: true}, false); !stop {
		t.Fatal("did not stop on the confirmation of the acceptance it sent")
	}
	if stop, beat := sleeper.answer(&ManagedSleepRequest{RequestedAt: final.RequestedAt, Confirmed: true}, true); stop || beat {
		t.Fatal("a confirmed stop is acted on once")
	}
}

func TestManagedSleepWireShapeMatchesTheSharedContract(t *testing.T) {
	body, err := json.Marshal(HeartbeatRequest{Status: "ONLINE", ManagedWorkload: &ManagedWorkload{Operations: 2, IdleSeconds: 0}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"managedWorkload":{"activeTurns":0,"backgroundJobs":0,"operations":2,"unflushedEvents":0,"idleSeconds":0}`) {
		t.Fatalf("heartbeat body %s", body)
	}
	plain, _ := json.Marshal(HeartbeatRequest{Status: "ONLINE"})
	if strings.Contains(string(plain), "managedWorkload") {
		t.Fatalf("a runner with no report sends none: %s", plain)
	}
	var resp HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"cancelSessionIds":[],"maxConcurrent":1,"managedSleep":{"requestedAt":"2026-10-09T08:00:00.000Z","confirmed":true}}`), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.ManagedSleep == nil || !resp.ManagedSleep.Confirmed || resp.ManagedSleep.RequestedAt != "2026-10-09T08:00:00.000Z" {
		t.Fatalf("managedSleep decoded as %+v", resp.ManagedSleep)
	}
}

func TestCountedOpsCountsWhatIsRunning(t *testing.T) {
	var ops countedOps
	ops.Add(1)
	ops.Add(1)
	if ops.inFlight() != 2 {
		t.Fatalf("in flight %d", ops.inFlight())
	}
	ops.Done()
	ops.Done()
	ops.Wait()
	if ops.inFlight() != 0 {
		t.Fatalf("in flight %d after both ended", ops.inFlight())
	}
	var group opGroup = &ops // the reset relay joins its steps through it
	group.Add(1)
	group.Done()
}

func TestEventBacklogCountsWhatTheControlPlaneHasNotAcknowledged(t *testing.T) {
	before := unflushedEventCount()
	backlog, drop := newEventBacklog()
	backlog.buffered()
	backlog.buffered()
	backlog.buffered()
	if got := unflushedEventCount() - before; got != 3 {
		t.Fatalf("three buffered, counted %d", got)
	}
	backlog.settled(2)
	if got := unflushedEventCount() - before; got != 1 {
		t.Fatalf("two acknowledged, counted %d", got)
	}
	drop()
	if got := unflushedEventCount() - before; got != 0 {
		t.Fatalf("an ended supervisor's backlog is not counted any more, counted %d", got)
	}
}

func TestManagedWorkloadCountsTurnsJobsOperationsAndEvents(t *testing.T) {
	pool := newSessionPool(2)
	var ops countedOps
	login := &loginRelay{}
	install := &installRelay{}
	if got := managedWorkloadCounts(pool, &ops, login, install); !got.idle() {
		t.Fatalf("an empty runner: %+v", got)
	}
	pool.holdWorktreeForRunnerWatch("session-a", "bgj_watch", "watch CI")
	if got := managedWorkloadCounts(pool, &ops, login, install); got.BackgroundJobs != 1 {
		t.Fatalf("a hosted watch is a background job: %+v", got)
	}
	pool.releaseWorktreeBackgroundJob("session-a", "bgj_watch")
	ops.Add(1) // an integration job the heartbeat handed over
	install.mu.Lock()
	install.running = true
	install.mu.Unlock()
	if got := managedWorkloadCounts(pool, &ops, login, install); got.Operations != 2 || got.idle() {
		t.Fatalf("a landing and an install: %+v", got)
	}
	ops.Done()
	install.mu.Lock()
	install.running = false
	install.mu.Unlock()
	if got := managedWorkloadCounts(pool, &ops, login, install); !got.idle() {
		t.Fatalf("all ended: %+v", got)
	}
}

func TestManagedRunnerDeclaresSleepWithItsInstance(t *testing.T) {
	withManagedInstance(t, "3", testManagedPodUID)
	h := http.Header{}
	h.Set(runnerCapabilitiesHeader, "provider:claude")
	setManagedInstanceHeaders(h)
	setManagedInstanceHeaders(h) // idempotent
	declared := strings.Split(h.Get(runnerCapabilitiesHeader), ",")
	counts := map[string]int{}
	for _, token := range declared {
		counts[strings.TrimSpace(token)]++
	}
	if counts[managedRunnerSleepCapabilityV1] != 1 || counts[managedRunnerInstanceCapabilityV1] != 1 || counts["provider:claude"] != 1 {
		t.Fatalf("declared %q", h.Get(runnerCapabilitiesHeader))
	}

	withoutManagedInstance(t)
	plain := http.Header{}
	setManagedInstanceHeaders(plain)
	if strings.Contains(plain.Get(runnerCapabilitiesHeader), managedRunnerSleepCapabilityV1) {
		t.Fatal("a self-managed runner declares no sleep")
	}
}

// The run loop reports a workload only as a managed instance, acts on the answer only as one, and
// stops — cancelling the loop, which is the ordinary drain and an ordinary exit — only when the
// handshake says so. A revocation is the only managed stop that exits non-zero.
func TestRunLoopWiresManagedSleep(t *testing.T) {
	src, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	for _, want := range []string{
		"var heartbeatOps countedOps",
		"newCodexResetRelay(resetCtx, t, resetConsumer.execute, &heartbeatOps)",
		"ManagedWorkload:      workload,",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("runloop.go does not contain %q", want)
		}
	}
	report := body[strings.Index(body, "var workload *ManagedWorkload"):]
	report = report[:strings.Index(report, "resp, supervisors, err := sendHeartbeatCycle")]
	if !strings.Contains(report, "if currentManagedInstance() != nil {") || !strings.Contains(report, "sleeper.report(managedWorkload())") {
		t.Errorf("the workload is reported, and only by a managed instance:\n%s", report)
	}
	answer := body[strings.Index(body, "stop, beat := sleeper.answer("):]
	answer = answer[:strings.Index(answer, "// The Codex rate-limit reset step")]
	for _, want := range []string{"resp.ManagedSleep", "managedWorkload().idle() && loopCtx.Err() == nil", "if beat {", "beatNow()", "if stop {", "loopCancel()"} {
		if !strings.Contains(answer, want) {
			t.Errorf("the sleep answer does not %s:\n%s", want, answer)
		}
	}
	if strings.Contains(answer, "managedInstanceRevokedSeen") {
		t.Error("a sleep is not a revocation: it must not exit non-zero")
	}
}
