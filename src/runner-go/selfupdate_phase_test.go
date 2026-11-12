package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"
)

// The Update card's phases (docs/runner-update-drain-design.md §4) as the heartbeat reports them:
// a release found while turns run is available, at the deferral limit it is draining, and once the
// turns have ended it is restarting. Each report is compared field for field with
// src/shared/src/runner-self-update.fixture.json, which the shared and apiserver specs read too.

const runnerSelfUpdateFixture = "../shared/src/runner-self-update.fixture.json"

func selfUpdateFixtureCases(t *testing.T) map[string]SelfUpdateReport {
	t.Helper()
	raw, err := os.ReadFile(runnerSelfUpdateFixture)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var file struct {
		Cases []struct {
			Name   string          `json:"name"`
			Report json.RawMessage `json:"report"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	cases := map[string]SelfUpdateReport{}
	for _, c := range file.Cases {
		var r SelfUpdateReport
		dec := json.NewDecoder(bytesReader(c.Report))
		dec.DisallowUnknownFields() // a field the runner does not know is a name the two disagree on
		if err := dec.Decode(&r); err != nil {
			t.Fatalf("fixture case %s: %v", c.Name, err)
		}
		// What the runner writes back is what it read: no field is lost on the way.
		again, _ := json.Marshal(r)
		var a, b any
		_ = json.Unmarshal(again, &a)
		_ = json.Unmarshal(c.Report, &b)
		if !reflect.DeepEqual(a, b) {
			t.Fatalf("fixture case %s round-trips as %s", c.Name, again)
		}
		cases[c.Name] = r
	}
	return cases
}

func assertReportIs(t *testing.T, when string, want SelfUpdateReport) {
	t.Helper()
	got := reported(t)
	if !reflect.DeepEqual(got, want) {
		gotJSON, _ := json.Marshal(got)
		wantJSON, _ := json.Marshal(want)
		t.Fatalf("%s: reported %s\nwant %s", when, gotJSON, wantJSON)
	}
	t.Logf("%s: phase %q, %d of %d turn(s), draining since %q", when, got.Phase, got.TurnsInFlight, got.TurnsAtDrain, got.DrainingSince)
}

func TestTheUpdatePhaseMovesFromAvailableToDrainingAtTheLimitToRestarting(t *testing.T) {
	resetSelfUpdateStatus(t)
	t.Setenv("ORBIT_HOME", t.TempDir()) // no update installed before: no lastUpdated* fields
	cases := selfUpdateFixtureCases(t)

	clock := newFakePoolClock()
	p := newSessionPoolWithClock(3, clock)
	a := registerPoolSession(t, p, "a", true)
	b := registerPoolSession(t, p, "b", true)
	check := updateWhenNoTurnInFlight(func(context.Context, string) (string, bool) {
		return "0.1.254", true
	}, p, noOperations, selfUpdateCheckInterval, selfUpdateDeferralLimit)

	if _, ok := check(context.Background(), ""); ok {
		t.Fatal("updated with two turns in flight")
	}
	assertReportIs(t, "first check, two turns in flight", cases["available"])

	clock.Advance(selfUpdateDeferralLimit - time.Second)
	check(context.Background(), "")
	if got := reported(t).Phase; got != selfUpdatePhaseAvailable {
		t.Fatalf("a second before the limit the phase is %q, want available", got)
	}

	clock.Advance(time.Second)
	check(context.Background(), "")
	if got := reported(t); got.Phase != selfUpdatePhaseDraining || got.TurnsInFlight != 2 || got.TurnsAtDrain != 2 {
		t.Fatalf("at the limit = %+v; want draining, 2 of 2 turns", got)
	}

	parkPoolSession(p, a)
	clock.Advance(selfUpdateDrainCheckInterval)
	check(context.Background(), "")
	assertReportIs(t, "one turn ended", cases["draining"])

	parkPoolSession(p, b)
	clock.Advance(selfUpdateDrainCheckInterval)
	if remote, ok := check(context.Background(), ""); !ok || remote != "0.1.254" {
		t.Fatalf("after the last turn = %q, %v; want the update", remote, ok)
	}
	assertReportIs(t, "no turn in flight", cases["restarting"])
}

// A check that finds no release waiting (or fails) ends the phase: the card goes away.
func TestACheckWithoutAReleaseClearsThePhase(t *testing.T) {
	resetSelfUpdateStatus(t)
	t.Setenv("ORBIT_HOME", t.TempDir())
	noteSelfUpdatePhase(selfUpdateStateWaitingForIdle, "", selfUpdatePhase{phase: selfUpdatePhaseAvailable, targetVersion: "0.1.254"})
	noteSelfUpdate(selfUpdateStateEnabled, "", "")
	if got := reported(t); got.Phase != "" || got.TargetVersion != "" {
		t.Fatalf("after a check with nothing waiting = %+v; want no phase", got)
	}
}

// The postponed phase is set by the Later task; its fields already travel.
func TestThePostponedReportTravels(t *testing.T) {
	resetSelfUpdateStatus(t)
	t.Setenv("ORBIT_HOME", t.TempDir())
	until := time.Date(2023, 11, 15, 2, 0, 0, 0, time.UTC)
	since := time.Unix(1_700_000_000, 0)
	noteSelfUpdatePhase(selfUpdateStateWaitingForIdle, "", selfUpdatePhase{
		phase: selfUpdatePhasePostponed, targetVersion: "0.1.254", availableSince: since, postponedUntil: until,
	})
	assertReportIs(t, "postponed", selfUpdateFixtureCases(t)["postponed"])
}

func bytesReader(b []byte) *bytes.Reader { return bytes.NewReader(b) }
