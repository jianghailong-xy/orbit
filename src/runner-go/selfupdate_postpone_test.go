package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The owner's Later (docs/runner-update-drain-design.md §4), on the pool's fake clock: the drain ends
// at once, the runner claims again and the follow-up it held starts, the release is reported
// postponed, and at postponedUntil it waits for idle again under a fresh one-hour limit.
func TestLaterEndsTheDrainAndReArmsTheUpdateAtUntilUnderAFreshLimit(t *testing.T) {
	resetSelfUpdateStatus(t)
	t.Setenv("ORBIT_HOME", t.TempDir())
	cases := selfUpdateFixtureCases(t)

	clock := newFakePoolClock() // 2023-11-14T22:13:20Z
	p := newSessionPoolWithClock(4, clock)
	a := registerPoolSession(t, p, "a", true)
	registerPoolSession(t, p, "b", true)
	var checks atomic.Int32
	gate := newSelfUpdateGate(func(context.Context, string) (string, bool) {
		checks.Add(1)
		return "0.1.254", true
	}, p, noOperations, selfUpdateCheckInterval, selfUpdateDeferralLimit, selfUpdateQuietWindow)

	gate.take(context.Background(), "")
	clock.Advance(selfUpdateDeferralLimit)
	gate.take(context.Background(), "")
	if !p.isDrainingForUpdate() || p.admissionIdleCapacity() != 0 {
		t.Fatalf("at the limit: draining %v, capacity %d; want draining, 0", p.isDrainingForUpdate(), p.admissionIdleCapacity())
	}
	// a's turn ends and the control plane hands its permit to a queued follow-up: held by the drain.
	p.holdFollowUpForUpdate(a, p.permitGeneration(a))
	shutdown, stop := context.WithCancel(context.Background())
	defer stop()
	started := make(chan bool, 1)
	go func() { started <- p.waitActive(a, context.Background(), shutdown) }()
	select {
	case <-started:
		t.Fatal("the follow-up started while the pool drained")
	case <-time.After(50 * time.Millisecond):
	}
	t.Logf("%s draining: claim capacity %d, follow-up of a held", clock.Now().UTC().Format(time.RFC3339), p.admissionIdleCapacity())

	// Later → Tonight 02:00.
	until := time.Date(2023, 11, 15, 2, 0, 0, 0, time.UTC)
	if !gate.postpone(until) {
		t.Fatal("postpone refused with a release draining")
	}
	if p.isDrainingForUpdate() {
		t.Fatal("still draining after Later")
	}
	if got := p.admissionIdleCapacity(); got != 2 {
		t.Fatalf("claim capacity after Later = %d, want 2 (4 slots, a and b busy): the runner claims again at once", got)
	}
	select {
	case ok := <-started:
		if !ok {
			t.Fatal("the held follow-up was let go but did not start")
		}
	case <-time.After(time.Second):
		t.Fatal("the held follow-up did not start after Later")
	}
	assertReportIs(t, "after Later", cases["postponed"])

	// Before until no check reads the release again, however busy or idle the runner is.
	before := checks.Load()
	clock.Advance(until.Sub(clock.Now()) - time.Second)
	if _, ok := gate.take(context.Background(), ""); ok {
		t.Fatal("updated before the postponement ran out")
	}
	if checks.Load() != before || p.isDrainingForUpdate() {
		t.Fatalf("a second before until: %d new release check(s), draining %v; want none, not draining", checks.Load()-before, p.isDrainingForUpdate())
	}
	assertReportIs(t, "a second before until", cases["postponed"])

	// At until, busy: available again, its clock starting now.
	clock.Advance(time.Second)
	if _, ok := gate.take(context.Background(), ""); ok {
		t.Fatal("updated at until with turns in flight")
	}
	if got := reported(t); got.Phase != selfUpdatePhaseAvailable || got.AvailableSince != "2023-11-15T02:00:00Z" || got.PostponedUntil != "" {
		t.Fatalf("at until = %+v; want available since 02:00, no postponedUntil", got)
	}
	clock.Advance(selfUpdateDeferralLimit - time.Second)
	gate.take(context.Background(), "")
	if p.isDrainingForUpdate() {
		t.Fatal("drained before a fresh hour had passed since until")
	}
	clock.Advance(time.Second)
	gate.take(context.Background(), "")
	got := reported(t)
	if !p.isDrainingForUpdate() || got.Phase != selfUpdatePhaseDraining || got.DrainingSince != "2023-11-15T03:00:00Z" {
		t.Fatalf("an hour after until: draining %v, report %+v; want draining since 03:00", p.isDrainingForUpdate(), got)
	}
	t.Logf("re-armed at %s, draining again at %s", got.AvailableSince, got.DrainingSince)
}

// At until with nothing in flight, the release installs on that check: Tonight means tonight.
func TestAtUntilAnIdleRunnerUpdates(t *testing.T) {
	resetSelfUpdateStatus(t)
	t.Setenv("ORBIT_HOME", t.TempDir())
	clock := newFakePoolClock()
	p := newSessionPoolWithClock(2, clock)
	a := registerPoolSession(t, p, "a", true)
	gate := newSelfUpdateGate(func(context.Context, string) (string, bool) { return "0.1.254", true },
		p, noOperations, selfUpdateCheckInterval, selfUpdateDeferralLimit, selfUpdateQuietWindow)
	gate.take(context.Background(), "")
	gate.postpone(clock.Now().Add(time.Hour))
	parkPoolSession(p, a)
	if _, ok := gate.take(context.Background(), ""); ok {
		t.Fatal("updated during the postponement although idle")
	}
	clock.Advance(time.Hour)
	if remote, ok := gate.take(context.Background(), ""); !ok || remote != "0.1.254" {
		t.Fatalf("at until, idle = %q, %v; want the update", remote, ok)
	}
}

// A postponed release coming due waits for the turns in flight only (closeForUpdate(0)), not for the
// quiet window an automatic update waits for: the owner chose the time. The control is the same
// moment for a release nobody postponed, which the window still holds back.
func TestAReleaseComingDueSkipsTheQuietWindow(t *testing.T) {
	resetSelfUpdateStatus(t)
	t.Setenv("ORBIT_HOME", t.TempDir())
	release := func(context.Context, string) (string, bool) { return "0.1.254", true }

	// Control: a turn ended a minute ago, nothing postponed: the quiet window defers the update.
	clock := newFakePoolClock()
	p := newSessionPoolWithClock(2, clock)
	a := registerPoolSession(t, p, "a", true)
	gate := newSelfUpdateGate(release, p, noOperations, selfUpdateCheckInterval, selfUpdateDeferralLimit, selfUpdateQuietWindow)
	parkPoolSession(p, a)
	clock.Advance(time.Minute)
	if _, ok := gate.take(context.Background(), ""); ok {
		t.Fatal("control: an automatic update took a runner whose turn ended a minute ago, inside the quiet window")
	}

	// Postponed: the same minute-old turn end at until does not hold the release back.
	resetSelfUpdateStatus(t)
	clock = newFakePoolClock()
	p = newSessionPoolWithClock(2, clock)
	a = registerPoolSession(t, p, "a", true)
	gate = newSelfUpdateGate(release, p, noOperations, selfUpdateCheckInterval, selfUpdateDeferralLimit, selfUpdateQuietWindow)
	gate.take(context.Background(), "")
	until := clock.Now().Add(time.Hour)
	gate.postpone(until)
	clock.Advance(time.Hour - time.Minute)
	parkPoolSession(p, a)
	clock.Advance(time.Minute)
	if remote, ok := gate.take(context.Background(), ""); !ok || remote != "0.1.254" {
		t.Fatalf("at until, a turn ended a minute ago = %q, %v; want the update: a release coming due skips the quiet window", remote, ok)
	}
}

// Nothing to put off: no release found waiting, or one already handed to the stop.
func TestLaterWithNothingWaitingChangesNothing(t *testing.T) {
	resetSelfUpdateStatus(t)
	t.Setenv("ORBIT_HOME", t.TempDir())
	clock := newFakePoolClock()
	p := newSessionPoolWithClock(2, clock)
	gate := newSelfUpdateGate(func(context.Context, string) (string, bool) { return "0.1.254", true },
		p, noOperations, selfUpdateCheckInterval, selfUpdateDeferralLimit, selfUpdateQuietWindow)
	if gate.postpone(clock.Now().Add(time.Hour)) {
		t.Fatal("postponed with no release found")
	}
	if _, ok := gate.take(context.Background(), ""); !ok {
		t.Fatal("idle runner did not take the update")
	}
	if gate.postpone(clock.Now().Add(time.Hour)) {
		t.Fatal("postponed a release already handed to the stop")
	}
	if got := reported(t).Phase; got != selfUpdatePhaseRestarting {
		t.Fatalf("phase after a late Later = %q, want restarting", got)
	}
}

// The runner declares it honours Later under the name the control plane checks.
func TestTheRunnerDeclaresSelfUpdatePostpone(t *testing.T) {
	if !strings.Contains(","+runnerCapabilitiesV1+",", ","+selfUpdatePostponeCapabilityV1+",") {
		t.Fatalf("this runner does not declare %s: %q", selfUpdatePostponeCapabilityV1, runnerCapabilitiesV1)
	}
	shared, err := os.ReadFile(filepath.Join("..", "shared", "src", "dto.ts"))
	if err != nil {
		t.Fatal(err)
	}
	if want := "SELF_UPDATE_POSTPONE_V1 = '" + selfUpdatePostponeCapabilityV1 + "'"; !strings.Contains(string(shared), want) {
		t.Errorf("@orbit/shared does not say %s", want)
	}
}

// Update Runner Now while postponed (the postponed card's Update Now…): the postponement ends, and the
// check it asks for installs if idle or re-arms under a fresh limit if not.
func TestUpdateRunnerNowEndsAPostponement(t *testing.T) {
	resetSelfUpdateStatus(t)
	t.Setenv("ORBIT_HOME", t.TempDir())
	clock := newFakePoolClock()
	p := newSessionPoolWithClock(2, clock)
	a := registerPoolSession(t, p, "a", true)
	gate := newSelfUpdateGate(func(context.Context, string) (string, bool) { return "0.1.254", true },
		p, noOperations, selfUpdateCheckInterval, selfUpdateDeferralLimit, selfUpdateQuietWindow)
	gate.take(context.Background(), "")
	gate.postpone(clock.Now().Add(6 * time.Hour))
	clock.Advance(time.Minute)
	gate.endPostponement()
	gate.take(context.Background(), "")
	if got := reported(t); got.Phase != selfUpdatePhaseAvailable || got.AvailableSince != clock.Now().UTC().Format(time.RFC3339) {
		t.Fatalf("after Update Runner Now, busy = %+v; want available from now", got)
	}
	parkPoolSession(p, a)
	if remote, ok := gate.take(context.Background(), ""); !ok || remote != "0.1.254" {
		t.Fatalf("idle after Update Runner Now = %q, %v; want the update", remote, ok)
	}
}
