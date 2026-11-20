package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// A runner that is busy at every check never updated: updateWhenNoTurnInFlight deferred a release
// for as long as any turn was in flight, with no deadline, and workstation-gpu stayed on 0.1.246 for
// days without the link heartbeat fix in 0.1.248. These tests hold the wait to its limit
// (selfUpdateDeferralLimit) and the drain that follows to its own (selfUpdateDrainLimit), past which
// the turns still in flight are interrupted. All the time here is
// the pool's fake clock: what is asserted is the order of events and the simulated minutes between
// them, never how fast this host runs.

// busyRunner simulates the claim loop and the update monitor of runLoop on the pool's fake clock.
// Each session takes turns of its own length back to back. A claimed session's turn starts only
// through a claim, and the claim loop claims only while admissionIdleCapacity is above 0, as
// runLoop's does. A chained session always has a follow-up queued when its turn ends, so the control
// plane hands its permit straight on (retainsTurnPermit) and the next turn starts with no claim —
// if waitActive lets it, as every engine loop asks before a turn. A turn ends only when its length
// has run, by itself.
type busyRunner struct {
	t        *testing.T
	clock    *fakePoolClock
	pool     *sessionPool
	gate     *selfUpdateGate
	check    selfUpdateChecker
	sessions []*busySession

	started, finished int
	startedAfterDrain int
	heldFollowUps     int
}

type busySession struct {
	s      *liveSession
	length time.Duration
	endsAt time.Time // zero while idle
	began  time.Time
	// chained: a follow-up is queued at the end of every turn.
	chained bool
	held    bool
}

const busyStep = selfUpdateDrainCheckInterval

func newBusyRunner(t *testing.T, limit time.Duration, chained time.Duration, lengths ...time.Duration) *busyRunner {
	clock := newFakePoolClock()
	r := &busyRunner{t: t, clock: clock, pool: newSessionPoolWithClock(len(lengths)+1, clock)}
	r.gate = newSelfUpdateGate(func(context.Context, string) (string, bool) {
		return "0.1.252", true
	}, r.pool, noOperations, selfUpdateCheckInterval, limit, 0)
	r.check = r.gate.take
	for i, length := range lengths {
		s := registerPoolSession(t, r.pool, fmt.Sprintf("s%d", i), true)
		parkPoolSession(r.pool, s)
		r.sessions = append(r.sessions, &busySession{s: s, length: length})
	}
	if chained > 0 {
		s := registerPoolSession(t, r.pool, "chained", true)
		parkPoolSession(r.pool, s)
		r.sessions = append(r.sessions, &busySession{s: s, length: chained, chained: true})
	}
	return r
}

// startsNow reports whether waitActive lets s's turn start at once.
func startsNow(p *sessionPool, s *liveSession) bool {
	stopped, stop := context.WithCancel(context.Background())
	stop()
	return p.waitActive(s, context.Background(), stopped)
}

func (r *busyRunner) begin(b *busySession, now time.Time) {
	b.began, b.endsAt = now, now.Add(b.length)
	r.started++
	if r.pool.isDrainingForUpdate() {
		r.startedAfterDrain++
	}
}

// step advances the fake clock by one drain-check interval: turns whose length has run end, idle
// sessions claim their next turn if the claim loop would claim, and the update check runs when
// runLoop would run it — at every check interval, and at every step while draining
// (nudgeWhileDrainingForUpdate). It returns what the check returned, if it ran.
func (r *busyRunner) step(elapsed time.Duration) (remote string, ok, checked bool) {
	r.clock.Advance(busyStep)
	now := r.clock.Now()
	for _, b := range r.sessions {
		if !b.endsAt.IsZero() && !now.Before(b.endsAt) {
			if got := now.Sub(b.began); got < b.length {
				r.t.Fatalf("a turn of %s ended after %s", b.length, got)
			}
			b.endsAt = time.Time{}
			r.finished++
			if !b.chained {
				parkPoolSession(r.pool, b.s)
				continue
			}
			// What a turn's completion does when the control plane kept the permit (session.go).
			r.pool.holdFollowUpForUpdate(b.s, r.pool.permitGeneration(b.s))
			if startsNow(r.pool, b.s) {
				r.begin(b, now)
			} else {
				b.held = true
				r.heldFollowUps++
			}
		}
	}
	for _, b := range r.sessions {
		if b.endsAt.IsZero() && !b.held && r.pool.admissionIdleCapacity() > 0 {
			if _, ok := r.pool.activate(b.s.job); !ok {
				r.t.Fatalf("session %s's claim was not activated", b.s.id)
			}
			r.begin(b, now)
		}
	}
	if elapsed%selfUpdateCheckInterval == 0 || r.pool.isDrainingForUpdate() {
		remote, ok = r.check(context.Background(), "https://control.example")
		return remote, ok, true
	}
	return "", false, false
}

func (r *busyRunner) inFlight() int {
	n := 0
	for _, b := range r.sessions {
		if !b.endsAt.IsZero() {
			n++
		}
	}
	return n
}

// The criterion end to end: a release is published, the runner has a turn in flight at every check,
// and it still updates — within the deferral limit plus the drain limit — with no turn beginning once
// the drain did, and the turns still in flight then interrupted (the stop Update Now makes).
// Every turn here outlasts the drain limit.
func TestABusyRunnerUpdatesWithinTheDeferralLimit(t *testing.T) {
	lengths := []time.Duration{7 * time.Minute, 11 * time.Minute, 23 * time.Minute}
	r := newBusyRunner(t, selfUpdateDeferralLimit, 9*time.Minute, lengths...)

	var firstDeferred, drainBegan time.Time
	start := r.clock.Now()
	for elapsed := busyStep; elapsed <= 24*time.Hour; elapsed += busyStep {
		remote, ok, checked := r.step(elapsed)
		now := r.clock.Now()
		if drainBegan.IsZero() && r.pool.isDrainingForUpdate() {
			drainBegan = now
		}
		if !checked {
			continue
		}
		if !ok {
			if r.inFlight() == 0 {
				t.Fatalf("at +%s the check found nothing in flight and still deferred", now.Sub(start))
			}
			if firstDeferred.IsZero() {
				firstDeferred = now
			}
			continue
		}
		// The update: what runLoop does next is stop and re-execute.
		if remote != "0.1.252" {
			t.Fatalf("update to %q, want 0.1.252", remote)
		}
		cut := r.inFlight()
		if cut == 0 || !r.gate.stopsForUpdateNow() {
			t.Fatalf("the update was taken with %d turn(s) in flight, interrupting=%v; want the turns past the drain limit interrupted",
				cut, r.gate.stopsForUpdateNow())
		}
		if r.started-r.finished != cut {
			t.Fatalf("%d turns began, %d ended and %d are in flight", r.started, r.finished, cut)
		}
		if r.startedAfterDrain != 0 {
			t.Fatalf("%d turn(s) began after the drain did", r.startedAfterDrain)
		}
		if drainBegan.IsZero() {
			t.Fatal("the update came without a drain: this runner was never busy at every check, so this proves nothing")
		}
		if got := drainBegan.Sub(firstDeferred); got < selfUpdateDeferralLimit || got > selfUpdateDeferralLimit+selfUpdateCheckInterval {
			t.Fatalf("the drain began %s after the first deferral, want the limit (%s) to the next check", got, selfUpdateDeferralLimit)
		}
		bound := selfUpdateDeferralLimit + selfUpdateCheckInterval + selfUpdateDrainLimit + selfUpdateDrainCheckInterval
		if got := now.Sub(firstDeferred); got > bound {
			t.Fatalf("updated %s after the first deferral, past the bound %s", got, bound)
		}
		if r.started < 10 {
			t.Fatalf("only %d turns ran: this runner was not busy", r.started)
		}
		t.Logf("first deferral +%s, drain +%s, update +%s; %d turns, %d interrupted; %d follow-up held for the updated runner",
			firstDeferred.Sub(start), drainBegan.Sub(start), now.Sub(start), r.started, cut, r.heldFollowUps)
		return
	}
	t.Fatal("a busy runner did not update in 24 simulated hours")
}

// Without the limit this is the runner workstation-gpu was: the same day of work never lets it update.
// Shown with a limit no day reaches, so it is the bound the other test proves, and nothing else.
func TestWithoutTheLimitABusyRunnerNeverUpdates(t *testing.T) {
	r := newBusyRunner(t, 1000*time.Hour, 9*time.Minute, 7*time.Minute, 11*time.Minute, 23*time.Minute)
	for elapsed := busyStep; elapsed <= 24*time.Hour; elapsed += busyStep {
		if _, ok, _ := r.step(elapsed); ok {
			t.Fatalf("updated at +%s: the runner was idle at a check, so this proves nothing", elapsed)
		}
	}
	if r.pool.isDrainingForUpdate() {
		t.Fatal("drained before the limit")
	}
}

// Before the limit a deferral changes nothing — the pool goes on claiming — and at the limit the
// drain stops claims without touching the turn in flight, which ends by itself; the first check after
// it gets the update.
func TestTheDrainWaitsForTheTurnInFlight(t *testing.T) {
	clock := newFakePoolClock()
	p := newSessionPoolWithClock(2, clock)
	s := registerPoolSession(t, p, "a", true)
	check := updateWhenNoTurnInFlight(func(context.Context, string) (string, bool) {
		return "0.1.252", true
	}, p, noOperations, selfUpdateCheckInterval, selfUpdateDeferralLimit, 0)

	if _, ok := check(context.Background(), ""); ok {
		t.Fatal("updated with a turn in flight")
	}
	clock.Advance(selfUpdateDeferralLimit - time.Second)
	if _, ok := check(context.Background(), ""); ok || p.isDrainingForUpdate() || p.admissionIdleCapacity() == 0 {
		t.Fatalf("before the limit: ok=%v draining=%v capacity=%d; want deferred with claims open",
			ok, p.isDrainingForUpdate(), p.admissionIdleCapacity())
	}
	clock.Advance(time.Second)
	if _, ok := check(context.Background(), ""); ok {
		t.Fatal("at the limit the update was taken with the turn still in flight")
	}
	if !p.isDrainingForUpdate() || p.admissionIdleCapacity() != 0 {
		t.Fatalf("at the limit: draining=%v capacity=%d; want claims stopped", p.isDrainingForUpdate(), p.admissionIdleCapacity())
	}
	if !waitsForNothing(p, s) {
		t.Fatal("the drain held the turn in flight back: it has to run to its end")
	}
	parkPoolSession(p, s)
	if remote, ok := check(context.Background(), ""); !ok || remote != "0.1.252" {
		t.Fatalf("after the turn ended = %q, %v; want the update", remote, ok)
	}
}

// The drain waits for its turns for selfUpdateDrainLimit at most: the first check past it takes the
// update as the owner's Update Now does, interrupting the turn still in flight.
func TestTheDrainInterruptsTheTurnsPastItsLimit(t *testing.T) {
	resetSelfUpdateStatus(t)
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Cleanup(func() { updateNowTarget.Store(nil) })

	clock := newFakePoolClock()
	p := newSessionPoolWithClock(2, clock)
	registerPoolSession(t, p, "a", true)
	gate := newSelfUpdateGate(func(context.Context, string) (string, bool) { return "0.1.260", true },
		p, noOperations, selfUpdateCheckInterval, selfUpdateDeferralLimit, 0)

	gate.take(context.Background(), "")
	clock.Advance(selfUpdateDeferralLimit)
	if _, ok := gate.take(context.Background(), ""); ok || !p.isDrainingForUpdate() {
		t.Fatalf("at the deferral limit: ok=%v draining=%v; want the drain", ok, p.isDrainingForUpdate())
	}
	clock.Advance(selfUpdateDrainLimit - time.Second)
	if _, ok := gate.take(context.Background(), ""); ok || gate.stopsForUpdateNow() {
		t.Fatalf("inside the drain limit: ok=%v interrupting=%v; want still waiting", ok, gate.stopsForUpdateNow())
	}
	clock.Advance(time.Second)
	remote, ok := gate.take(context.Background(), "")
	if !ok || remote != "0.1.260" || !gate.stopsForUpdateNow() {
		t.Fatalf("past the drain limit = %q, %v, interrupting=%v; want 0.1.260 with the interrupting stop",
			remote, ok, gate.stopsForUpdateNow())
	}
	if report := selfUpdateReport(); report == nil || report.Phase != selfUpdatePhaseRestarting || report.InterruptedTurns != 1 {
		t.Fatalf("report = %+v; want restarting with 1 interrupted turn", report)
	}
}

// runLoop's gate (lowHours) gives a busy runner selfUpdateIdleWait to go idle, then drains at the first
// check in the low hours, on the runner's local clock: a release out at 08:00 is not drained for at
// 14:00 when the wait runs out, nor at 01:59, but at 02:00; one out at 21:00 drains at 03:00, inside
// the window, not the next night.
func TestAnAutomaticUpdateDrainsInTheLowHours(t *testing.T) {
	for _, tc := range []struct {
		name               string
		release, notBefore time.Time
		drainsAt           time.Time
	}{
		{"out in the morning", time.Date(2026, 11, 14, 8, 0, 0, 0, time.Local), time.Date(2026, 11, 15, 1, 59, 0, 0, time.Local), time.Date(2026, 11, 15, 2, 0, 0, 0, time.Local)},
		{"out in the evening", time.Date(2026, 11, 14, 21, 0, 0, 0, time.Local), time.Date(2026, 11, 15, 2, 59, 0, 0, time.Local), time.Date(2026, 11, 15, 3, 0, 0, 0, time.Local)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetSelfUpdateStatus(t)
			clock := newFakePoolClock()
			clock.now = tc.release
			p := newSessionPoolWithClock(2, clock)
			registerPoolSession(t, p, "a", true)
			gate := newSelfUpdateGate(func(context.Context, string) (string, bool) { return "0.1.260", true },
				p, noOperations, selfUpdateCheckInterval, selfUpdateDeferralLimit, 0)
			gate.lowHours = true

			gate.take(context.Background(), "")
			for clock.Now().Before(tc.notBefore) {
				clock.Advance(selfUpdateCheckInterval)
				if clock.Now().After(tc.notBefore) {
					clock.Advance(tc.notBefore.Sub(clock.Now()))
				}
				if _, ok := gate.take(context.Background(), ""); ok || p.isDrainingForUpdate() {
					t.Fatalf("at %s: ok=%v draining=%v; want still waiting for idle", clock.Now().Format("01-02 15:04"), ok, p.isDrainingForUpdate())
				}
			}
			clock.Advance(tc.drainsAt.Sub(clock.Now()))
			if _, ok := gate.take(context.Background(), ""); ok || !p.isDrainingForUpdate() {
				t.Fatalf("at %s: ok=%v draining=%v; want the drain", clock.Now().Format("01-02 15:04"), ok, p.isDrainingForUpdate())
			}
		})
	}
}

// A release the owner put off (Later) keeps the plain limit once its time comes, low hours or not:
// the owner chose that time.
func TestAPostponedUpdateIgnoresTheLowHours(t *testing.T) {
	resetSelfUpdateStatus(t)
	clock := newFakePoolClock()
	clock.now = time.Date(2026, 11, 14, 10, 0, 0, 0, time.Local)
	p := newSessionPoolWithClock(2, clock)
	registerPoolSession(t, p, "a", true)
	gate := newSelfUpdateGate(func(context.Context, string) (string, bool) { return "0.1.260", true },
		p, noOperations, selfUpdateCheckInterval, selfUpdateDeferralLimit, 0)
	gate.lowHours = true

	gate.take(context.Background(), "")
	if !gate.postpone(clock.Now().Add(time.Hour)) {
		t.Fatal("Later refused with a release waiting")
	}
	clock.Advance(time.Hour)
	gate.take(context.Background(), "")
	clock.Advance(selfUpdateDeferralLimit)
	if _, ok := gate.take(context.Background(), ""); ok || !p.isDrainingForUpdate() {
		t.Fatalf("at 12:00, the limit after Later ran out: ok=%v draining=%v; want the drain", ok, p.isDrainingForUpdate())
	}
}

// The heartbeat's operations are drained for in the same way: past the limit claims stop, the
// landing goes on, and the update follows it.
func TestTheDrainWaitsForTheHeartbeatOperationsInFlight(t *testing.T) {
	clock := newFakePoolClock()
	p := newSessionPoolWithClock(2, clock)
	var ops countedOps
	ops.Add(1)
	check := updateWhenNoTurnInFlight(func(context.Context, string) (string, bool) {
		return "0.1.252", true
	}, p, ops.inFlight, selfUpdateCheckInterval, selfUpdateDeferralLimit, 0)

	check(context.Background(), "")
	clock.Advance(selfUpdateDeferralLimit)
	if _, ok := check(context.Background(), ""); ok || !p.isDrainingForUpdate() {
		t.Fatalf("a landing past the limit: ok=%v draining=%v; want the drain, not the update", ok, p.isDrainingForUpdate())
	}
	ops.Done()
	if remote, ok := check(context.Background(), ""); !ok || remote != "0.1.252" {
		t.Fatalf("after the landing ended = %q, %v; want the update", remote, ok)
	}
}

// Draining, a check does not read the release again: a check that fails then would reopen the
// pool, and the install that follows the stop reads the assigned release itself.
func TestADrainingCheckDoesNotReadTheReleaseAgain(t *testing.T) {
	clock := newFakePoolClock()
	p := newSessionPoolWithClock(2, clock)
	s := registerPoolSession(t, p, "a", true)
	var reads atomic.Int32
	answer := true
	check := updateWhenNoTurnInFlight(func(context.Context, string) (string, bool) {
		reads.Add(1)
		if !answer {
			return "", false
		}
		return "0.1.252", true
	}, p, noOperations, selfUpdateCheckInterval, selfUpdateDeferralLimit, 0)

	check(context.Background(), "")
	clock.Advance(selfUpdateDeferralLimit)
	check(context.Background(), "")
	if !p.isDrainingForUpdate() {
		t.Fatal("no drain at the limit")
	}
	before := reads.Load()
	answer = false // the control plane cannot be read any more
	for i := 0; i < 5; i++ {
		clock.Advance(selfUpdateDrainCheckInterval)
		if _, ok := check(context.Background(), ""); ok {
			t.Fatal("updated with the turn in flight")
		}
	}
	if got := reads.Load(); got != before {
		t.Fatalf("a draining check read the release %d more time(s)", got-before)
	}
	if !p.isDrainingForUpdate() || p.admissionIdleCapacity() != 0 {
		t.Fatal("the drain was taken back")
	}
	parkPoolSession(p, s)
	if remote, ok := check(context.Background(), ""); !ok || remote != "0.1.252" {
		t.Fatalf("after the turn = %q, %v; want the release the drain was for", remote, ok)
	}
}

// A release the runner is idle for at a check before the limit is taken at once, without a drain:
// the limit only matters to a runner that is never idle at a check.
func TestAnIdleCheckBeforeTheLimitUpdatesWithoutADrain(t *testing.T) {
	clock := newFakePoolClock()
	p := newSessionPoolWithClock(2, clock)
	s := registerPoolSession(t, p, "a", true)
	check := updateWhenNoTurnInFlight(func(context.Context, string) (string, bool) {
		return "0.1.252", true
	}, p, noOperations, selfUpdateCheckInterval, selfUpdateDeferralLimit, 0)
	check(context.Background(), "")
	clock.Advance(selfUpdateCheckInterval)
	parkPoolSession(p, s)
	if _, ok := check(context.Background(), ""); !ok {
		t.Fatal("an idle check before the limit did not take the update")
	}
	if p.isDrainingForUpdate() {
		t.Fatal("drained although the runner was idle before the limit")
	}
}

// While the pool drains, the monitor is asked for a check every drain interval, so the update
// follows the last turn promptly; not otherwise.
func TestADrainingRunnerIsCheckedAgainSoon(t *testing.T) {
	p := newSessionPool(1)
	checkNow := make(chan struct{}, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go nudgeWhileDrainingForUpdate(ctx, p, 5*time.Millisecond, checkNow)
	select {
	case <-checkNow:
		t.Fatal("a check was asked for although nothing drains")
	case <-time.After(50 * time.Millisecond):
	}
	p.drainForUpdate()
	select {
	case <-checkNow:
	case <-time.After(fakeClaudeTimeout):
		t.Fatal("a draining runner was never checked again")
	}
}

// A follow-up the control plane handed a session's permit to is held back only while draining: before
// the drain it starts at once, and a held one is no turn in flight, so the update does not wait for it.
func TestAFollowUpIsHeldOnlyWhileDraining(t *testing.T) {
	p := newSessionPool(2)
	s := registerPoolSession(t, p, "a", true)
	p.holdFollowUpForUpdate(s, p.permitGeneration(s))
	if !startsNow(p, s) {
		t.Fatal("a follow-up was held back with no drain under way")
	}
	p.drainForUpdate()
	p.holdFollowUpForUpdate(s, p.permitGeneration(s)+1)
	if !startsNow(p, s) {
		t.Fatal("a stale permit's completion held the session's current turn back")
	}
	p.holdFollowUpForUpdate(s, p.permitGeneration(s))
	if startsNow(p, s) {
		t.Fatal("a follow-up started while the pool drained for an update")
	}
	if n, _ := p.closeForUpdate(0); n != 0 {
		t.Fatalf("closeForUpdate with only a held follow-up = %d, want 0: it never started, so nothing is cut", n)
	}
}

// Asked of the source: a turn's completion that keeps its permit holds the follow-up while draining.
func TestATurnThatKeepsItsPermitIsHeldWhileDraining(t *testing.T) {
	src, err := os.ReadFile("session.go")
	if err != nil {
		t.Fatalf("read session.go: %v", err)
	}
	if !strings.Contains(string(src), `} else if err == nil && !retainsTurnPermit(next) {
			pool.park(live, permitGeneration)
		} else if err == nil {
			// The permit went straight to a queued follow-up; a drain for an update holds it back.
			pool.holdFollowUpForUpdate(live, permitGeneration)`) {
		t.Fatal("a turn's completion that keeps its permit does not hold the follow-up for an update")
	}
}

// Asked of the source: the heartbeat says a drain for an update is draining, which is what keeps
// the control plane's merges, commits, landings and repository operations off this runner, and the
// monitor is nudged while it drains.
func TestTheRunLoopReportsTheUpdateDrain(t *testing.T) {
	src, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatalf("read runloop.go: %v", err)
	}
	body := string(src)
	body = body[strings.Index(body, "func runLoop("):]
	if !strings.Contains(body, "draining := loopCtx.Err() != nil || pool.isDrainingForUpdate()") {
		t.Fatal("the heartbeat does not report a drain for an update as draining")
	}
	if !strings.Contains(body, "go nudgeWhileDrainingForUpdate(monitorCtx, pool, selfUpdateDrainCheckInterval, checkSelfUpdateNow)") {
		t.Fatal("runLoop does not check again while draining for an update")
	}
}
