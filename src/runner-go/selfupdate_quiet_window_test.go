package main

import (
	"context"
	"testing"
	"time"
)

// An automatic update waits for the runner to have been quiet for selfUpdateQuietWindow, not for one
// idle instant: between two turns of a conversation nothing is in flight, but the owner's next
// message is seconds away, and an update taken then makes it wait behind the restart and the reclaim
// (owner, 2026-11-12). All the time here is the pool's fake clock.

func quietWindowCheck(p *sessionPool) selfUpdateChecker {
	return updateWhenNoTurnInFlight(func(context.Context, string) (string, bool) {
		return "0.1.255", true
	}, p, noOperations, selfUpdateCheckInterval, selfUpdateDeferralLimit, selfUpdateQuietWindow)
}

func TestAnAutomaticUpdateWaitsUntilNoTurnEndedOrWasClaimedForTheQuietWindow(t *testing.T) {
	resetSelfUpdateStatus(t)
	clock := newFakePoolClock()
	p := newSessionPoolWithClock(2, clock)
	check := quietWindowCheck(p)

	// A turn runs and ends: the agent has answered, the owner is typing.
	s := registerPoolSession(t, p, "a", true)
	clock.Advance(3 * time.Minute)
	parkPoolSession(p, s)
	clock.Advance(time.Minute)
	if n := p.turnsInFlight(); n != 0 {
		t.Fatalf("%d turn(s) in flight, want none: the case is the gap between two turns", n)
	}
	if _, ok := check(context.Background(), ""); ok {
		t.Fatal("installed a minute after a turn ended, with nothing in flight: the gap between two turns is not idle")
	}
	if p.closedForUpdate {
		t.Fatal("a refused update closed the pool: the owner's next message could not start")
	}
	if got := reported(t).Phase; got != selfUpdatePhaseAvailable {
		t.Fatalf("phase while the quiet window runs = %q, want available", got)
	}

	// Just short of the window: still refused.
	clock.Advance(selfUpdateQuietWindow - time.Minute - time.Second)
	if _, ok := check(context.Background(), ""); ok {
		t.Fatalf("installed %s after the turn ended, within the %s quiet window", selfUpdateQuietWindow-time.Second, selfUpdateQuietWindow)
	}

	// The owner's next message is claimed and answered: the window starts again from its end.
	activated, ok := p.activate(poolJob("a"))
	if !ok || activated != s {
		t.Fatal("the follow-up turn was not claimed")
	}
	clock.Advance(2 * time.Second)
	if _, ok := check(context.Background(), ""); ok {
		t.Fatal("installed with a turn in flight")
	}
	clock.Advance(time.Minute)
	parkPoolSession(p, s)
	clock.Advance(selfUpdateQuietWindow - time.Second)
	if _, ok := check(context.Background(), ""); ok {
		t.Fatal("installed less than the quiet window after the second turn ended")
	}

	// N minutes with no turn ended and nothing claimed: it installs.
	clock.Advance(time.Second)
	remote, ok := check(context.Background(), "")
	if !ok || remote != "0.1.255" {
		t.Fatalf("check after %s quiet = %q, %v; want the update", selfUpdateQuietWindow, remote, ok)
	}
	if !p.closedForUpdate {
		t.Fatal("the update was taken without closing the pool")
	}
}

// A claim is activity on its own, before any turn ends: a new session's claim and a follow-up's
// claim each start the quiet window again.
func TestAClaimStartsTheQuietWindow(t *testing.T) {
	clock := newFakePoolClock()
	p := newSessionPoolWithClock(2, clock)
	clock.Advance(time.Hour)
	s := registerPoolSession(t, p, "a", true)
	if !p.lastActivityAt.Equal(clock.Now()) {
		t.Fatalf("a new session's claim left lastActivityAt at %s, want %s", p.lastActivityAt, clock.Now())
	}
	parkPoolSession(p, s)
	clock.Advance(time.Hour)
	if _, ok := p.activate(poolJob("a")); !ok {
		t.Fatal("the follow-up was not claimed")
	}
	if !p.lastActivityAt.Equal(clock.Now()) {
		t.Fatalf("a follow-up's claim left lastActivityAt at %s, want %s", p.lastActivityAt, clock.Now())
	}
}

// The quiet window can never put an update off for ever: a runner that is never quiet for N minutes,
// though nothing is in flight at any check, drains at selfUpdateDeferralLimit and installs at the next
// check that finds no turn in flight. The drain asks only for the turns in flight.
func TestTheDeferralLimitStillDrainsARunnerThatIsNeverQuiet(t *testing.T) {
	resetSelfUpdateStatus(t)
	clock := newFakePoolClock()
	p := newSessionPoolWithClock(2, clock)
	check := quietWindowCheck(p)
	s := registerPoolSession(t, p, "a", true)
	parkPoolSession(p, s)

	// Every 5 minutes a turn is claimed and runs for a minute; the update is checked every 10 minutes,
	// two minutes after a turn ended, so no check ever finds a turn in flight and none finds the
	// runner quiet for 10 minutes.
	const step = time.Minute
	var firstCheck, drainBegan time.Time
	for elapsed := step; elapsed <= 3*selfUpdateDeferralLimit; elapsed += step {
		clock.Advance(step)
		minute := int(elapsed / time.Minute)
		switch minute % 5 {
		case 2:
			if p.admissionIdleCapacity() > 0 { // the claim loop claims only while admission is open
				if _, ok := p.activate(poolJob("a")); !ok {
					t.Fatalf("+%s: the turn was not claimed", elapsed)
				}
			}
		case 3:
			if p.isActive(s) {
				parkPoolSession(p, s)
			}
		}
		if elapsed%selfUpdateCheckInterval != 0 && !p.isDrainingForUpdate() {
			continue
		}
		if p.isDrainingForUpdate() && elapsed%selfUpdateDrainCheckInterval != 0 {
			continue
		}
		inFlight := p.turnsInFlight()
		if firstCheck.IsZero() {
			firstCheck = clock.Now()
		}
		if !p.isDrainingForUpdate() && inFlight != 0 {
			t.Fatalf("+%s: a check before the drain found %d turn(s) in flight; this case is about the quiet window alone", elapsed, inFlight)
		}
		remote, ok := check(context.Background(), "")
		if ok {
			if inFlight != 0 {
				t.Fatalf("+%s: installed with %d turn(s) in flight", elapsed, inFlight)
			}
			if drainBegan.IsZero() {
				t.Fatalf("+%s: installed before the limit, though the runner was never quiet for %s", elapsed, selfUpdateQuietWindow)
			}
			if got := clock.Now().Sub(firstCheck); got < selfUpdateDeferralLimit || got > selfUpdateDeferralLimit+selfUpdateCheckInterval {
				t.Fatalf("installed %s after the first deferral, want the limit (%s) plus at most one check interval", got, selfUpdateDeferralLimit)
			}
			if remote != "0.1.255" {
				t.Fatalf("installed %q, want 0.1.255", remote)
			}
			t.Logf("drain began %s after the first check; installed %s after it", drainBegan.Sub(firstCheck), clock.Now().Sub(firstCheck))
			return
		}
		if inFlight == 0 && drainBegan.IsZero() && clock.Now().Sub(firstCheck) < selfUpdateDeferralLimit {
			if got := reported(t).Phase; got != selfUpdatePhaseAvailable {
				t.Fatalf("+%s: phase %q while the quiet window defers, want available", elapsed, got)
			}
		}
		if p.isDrainingForUpdate() && drainBegan.IsZero() {
			drainBegan = clock.Now()
			if got := drainBegan.Sub(firstCheck); got != selfUpdateDeferralLimit {
				t.Fatalf("the drain began %s after the first deferral, want the limit %s", got, selfUpdateDeferralLimit)
			}
		}
	}
	t.Fatalf("never installed in %s: the quiet window put the update off for ever", 3*selfUpdateDeferralLimit)
}

// The owner's Update Runner Now waits for the turns in flight, not for the quiet window.
func TestTheOwnersUpdateNowSkipsTheQuietWindow(t *testing.T) {
	resetSelfUpdateStatus(t)
	clock := newFakePoolClock()
	p := newSessionPoolWithClock(2, clock)
	check := quietWindowCheck(p)
	s := registerPoolSession(t, p, "a", true)

	p.askForUpdateNow()
	if _, ok := check(context.Background(), ""); ok {
		t.Fatal("the owner's update was taken with a turn in flight")
	}
	clock.Advance(time.Minute)
	parkPoolSession(p, s)
	clock.Advance(time.Second)
	if _, ok := check(context.Background(), ""); !ok {
		t.Fatal("the owner's update waited for the quiet window after the turn ended")
	}
}

// A check that finds no release answers the owner's request: a release published later is an
// automatic update again, and waits for the quiet window.
func TestTheOwnersRequestEndsWithACheckThatFindsNoRelease(t *testing.T) {
	resetSelfUpdateStatus(t)
	clock := newFakePoolClock()
	p := newSessionPoolWithClock(2, clock)
	published := false
	check := updateWhenNoTurnInFlight(func(context.Context, string) (string, bool) {
		if published {
			return "0.1.255", true
		}
		return "", false
	}, p, noOperations, selfUpdateCheckInterval, selfUpdateDeferralLimit, selfUpdateQuietWindow)
	s := registerPoolSession(t, p, "a", true)
	parkPoolSession(p, s)

	p.askForUpdateNow()
	if _, ok := check(context.Background(), ""); ok {
		t.Fatal("updated with no release")
	}
	published = true
	clock.Advance(time.Minute)
	if _, ok := check(context.Background(), ""); ok {
		t.Fatal("a later automatic update skipped the quiet window on an answered request")
	}
}
