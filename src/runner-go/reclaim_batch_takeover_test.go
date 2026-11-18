package main

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The startup reclaim against a control plane that has the batch takeover: 5 sessions somebody may be
// waiting on and 600 idle ones. The priority phase takes its five over in one request, the idle phase
// takes its 600 over in two (takeoverBatchMax, then the rest), each in ascending id order, and no session
// is taken over one request at a time. Every session ends with exactly one supervisor.
func TestTheStartupReclaimTakesItsSessionsOverInBatches(t *testing.T) {
	var snapshot []ReclaimSession
	var priorityIDs, idleIDs []string
	for i := 0; i < 605; i++ {
		id := idleTestID(i)
		status := stAwaitingInput
		if i%121 == 7 {
			status = stRunning
			priorityIDs = append(priorityIDs, id)
		} else {
			idleIDs = append(idleIDs, id)
		}
		snapshot = append(snapshot, ReclaimSession{SessionID: id, Status: status, LeaseOwner: "old-process", Provider: providerClaude})
	}
	if len(priorityIDs) != 5 {
		t.Fatalf("fixture: %d waited-on sessions, want 5", len(priorityIDs))
	}
	fake := newIdleFakeServer(snapshot, 10*time.Millisecond)
	fake.batch = true
	srv := httptest.NewServer(fake)
	defer srv.Close()

	rig := startStartupReclaim(t, srv, 8)
	rig.finish()

	fake.mu.Lock()
	batches := append([][]string(nil), fake.batches...)
	singles, refusals := fake.singles, fake.batchRefusals
	fake.mu.Unlock()
	if singles != 0 || refusals != 0 {
		t.Fatalf("%d single takeovers and %d refused batches against a control plane with the batch takeover", singles, refusals)
	}
	want := [][]string{priorityIDs, idleIDs[:takeoverBatchMax], idleIDs[takeoverBatchMax:]}
	if len(batches) != len(want) {
		t.Fatalf("%d batch requests, want %d (one for the waited-on sessions, two for the idle ones)", len(batches), len(want))
	}
	for i := range want {
		if strings.Join(batches[i], ",") != strings.Join(want[i], ",") {
			t.Fatalf("batch %d named %d sessions starting %v, want %d starting %v, in ascending id order",
				i, len(batches[i]), batches[i][:1], len(want[i]), want[i][:1])
		}
	}
	rig.ledger.mu.Lock()
	defer rig.ledger.mu.Unlock()
	for _, r := range snapshot {
		if rig.ledger.registered[r.SessionID] != 1 {
			t.Fatalf("session %s got %d supervisors, want 1", r.SessionID, rig.ledger.registered[r.SessionID])
		}
	}
	if handed, _ := rig.starter.idlePhase(); handed != 600 {
		t.Fatalf("idle phase handed %d sessions over, want 600", handed)
	}
}

// One row of a batch refused 409 beside rows that are taken over: the others are reclaimed, the
// conflicted one is counted toward takeoverConflictLimit once per pass and set aside at the limit, as
// one request per session counted it.
func TestABatchTakeoverConflictIsCountedPerRowAndTheOtherRowsAreTakenOver(t *testing.T) {
	snapshot := []ReclaimSession{
		{SessionID: idleTestID(1), Status: stRunning, LeaseOwner: "old-process", Provider: providerClaude},
		{SessionID: idleTestID(2), Status: stRunning, LeaseOwner: "old-process", Provider: providerClaude},
		{SessionID: idleTestID(3), Status: stPending, LeaseOwner: "old-process", Provider: providerClaude},
	}
	conflicted := idleTestID(2)
	fake := newIdleFakeServer(snapshot, time.Millisecond)
	fake.batch = true
	fake.conflict[conflicted] = true
	srv := httptest.NewServer(fake)
	defer srv.Close()

	starts, skipped, err := reclaimMissingSessions(context.Background(), NewTransport(srv.URL, "token"),
		func() map[string]bool { return map[string]bool{} }, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !skipped {
		t.Fatal("the conflicted session was not reported as set aside")
	}
	fake.mu.Lock()
	batches := append([][]string(nil), fake.batches...)
	singles := fake.singles
	fake.mu.Unlock()
	if singles != 0 {
		t.Fatalf("%d single takeovers against a control plane with the batch takeover", singles)
	}
	if len(batches) != takeoverConflictLimit {
		t.Fatalf("%d batch requests, want %d: one per pass until the conflicted row is set aside", len(batches), takeoverConflictLimit)
	}
	conflicts := 0
	for _, b := range batches {
		for _, id := range b {
			if id == conflicted {
				conflicts++
			}
		}
	}
	if conflicts != takeoverConflictLimit {
		t.Fatalf("the conflicted row was named %d times, want %d", conflicts, takeoverConflictLimit)
	}
	if len(starts) != 2 || starts[0].job.SessionID == conflicted || starts[1].job.SessionID == conflicted {
		t.Fatalf("starts = %+v, want the two rows beside the conflicted one", starts)
	}
}

// The idle phase's conflict, with the batch takeover: the session is set aside after the same bounded
// refreshes, and the others are handed over from the first batch.
func TestAnIdleBatchTakeoverConflictIsSetAsideAfterBoundedRefreshes(t *testing.T) {
	var snapshot []ReclaimSession
	for i := 0; i < 4; i++ {
		snapshot = append(snapshot, ReclaimSession{SessionID: idleTestID(i), Status: stInterrupted, LeaseOwner: "old-process", Provider: providerClaude})
	}
	conflicted := idleTestID(2)
	fake := newIdleFakeServer(snapshot, time.Millisecond)
	fake.batch = true
	fake.conflict[conflicted] = true
	srv := httptest.NewServer(fake)
	defer srv.Close()
	rig := startStartupReclaim(t, srv, 4)
	rig.finish()
	if !rig.starter.setAside() {
		t.Fatal("a session set aside over takeover conflicts does not schedule the deferred retry")
	}
	fake.mu.Lock()
	refreshes, batches, singles := fake.reclaims-1, len(fake.batches), fake.singles
	fake.mu.Unlock()
	if refreshes != takeoverConflictLimit-1 || batches != takeoverConflictLimit || singles != 0 {
		t.Fatalf("%d refreshes, %d batches, %d single takeovers; want %d, %d, 0",
			refreshes, batches, singles, takeoverConflictLimit-1, takeoverConflictLimit)
	}
	if handed, _ := rig.starter.idlePhase(); handed != 3 {
		t.Fatalf("idle phase handed %d sessions over, want 3", handed)
	}
}

// A control plane from before the batch takeover answers it 404. The runner asks once, then takes every
// session over with one request each, each phase in ascending id order, as it did before.
func TestTheStartupReclaimFallsBackToSingleTakeoversWhenTheBatchIsAnswered404(t *testing.T) {
	var snapshot []ReclaimSession
	var priorityIDs, idleIDs []string
	for i := 0; i < 13; i++ {
		id := idleTestID(i)
		status := stAwaitingInput
		if i%4 == 1 {
			status = stRunning
			priorityIDs = append(priorityIDs, id)
		} else {
			idleIDs = append(idleIDs, id)
		}
		snapshot = append(snapshot, ReclaimSession{SessionID: id, Status: status, LeaseOwner: "old-process", Provider: providerClaude})
	}
	fake := newIdleFakeServer(snapshot, time.Millisecond)
	srv := httptest.NewServer(fake)
	defer srv.Close()

	rig := startStartupReclaim(t, srv, 4)
	rig.finish()

	fake.mu.Lock()
	refusals, singles, batches := fake.batchRefusals, fake.singles, len(fake.batches)
	fake.mu.Unlock()
	if refusals != 1 || batches != 0 {
		t.Fatalf("the batch takeover was asked %d times and answered %d times, want once and never", refusals, batches)
	}
	if singles != len(snapshot) {
		t.Fatalf("%d single takeovers, want %d", singles, len(snapshot))
	}
	answered := fake.takeoversAnswered()
	if got, want := strings.Join(answered, ","), strings.Join(append(append([]string(nil), priorityIDs...), idleIDs...), ","); got != want {
		t.Fatalf("takeovers answered in the order %v, want %v", answered, want)
	}
	rig.ledger.mu.Lock()
	defer rig.ledger.mu.Unlock()
	for _, r := range snapshot {
		if rig.ledger.registered[r.SessionID] != 1 {
			t.Fatalf("session %s got %d supervisors, want 1", r.SessionID, rig.ledger.registered[r.SessionID])
		}
	}
}
