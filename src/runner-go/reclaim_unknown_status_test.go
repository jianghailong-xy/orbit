package main

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"
)

// unknownStatusSnapshot is a restart's snapshot with every word this binary knows, a legacy empty
// status, and two rows with a word it does not know: one whose takeover the server answers (the lease
// is now this process's) and one whose takeover it refuses (the lease is not held). The refused row
// sorts first, so its conflict refreshes the snapshot while the held one is still waiting for its
// takeover.
func unknownStatusSnapshot() (rows []ReclaimSession, open, closed []string, held, notHeld string) {
	words := []string{"", stPending, stRunning, stAwaitingInput, stInterrupted, stSucceeded, stFailed, stCancelled}
	for i, word := range words {
		id := idleTestID(i)
		rows = append(rows, ReclaimSession{SessionID: id, Status: word, LeaseOwner: "old-process", Provider: providerClaude})
		if reclaimStatusEnded(word) {
			closed = append(closed, id)
		} else {
			open = append(open, id)
		}
	}
	notHeld, held = idleTestID(len(words)), idleTestID(len(words)+1)
	rows = append(rows,
		ReclaimSession{SessionID: notHeld, Status: "IDLE", LeaseOwner: "old-process", Provider: providerClaude},
		ReclaimSession{SessionID: held, Status: "IDLE", LeaseOwner: "old-process", Provider: providerClaude})
	return rows, open, closed, held, notHeld
}

// The startup reclaim as runLoop wires it (priority phase, then the idle phase's handOver and
// refreshIdle): an unknown word whose takeover holds the lease gets its supervisor, one whose takeover
// is refused gets none, and the seven known words behave as before. The fake server answers a terminal
// row's takeover with its status, as an older server did, and those rows still get no supervisor.
func TestStartupReclaimKeepsAnUnknownStatusOnlyWhenTheLeaseIsHeld(t *testing.T) {
	snapshot, open, closed, held, notHeld := unknownStatusSnapshot()
	fake := newIdleFakeServer(snapshot, 0)
	fake.conflict[notHeld] = true
	srv := httptest.NewServer(fake)
	defer srv.Close()

	rig := startStartupReclaim(t, srv, 16)
	rig.finish()

	rig.ledger.mu.Lock()
	defer rig.ledger.mu.Unlock()
	for _, id := range append(append([]string{}, open...), held) {
		if got := rig.ledger.registered[id]; got != 1 {
			t.Errorf("session %s (%s) got %d supervisors, want 1", id, fake.status[id], got)
		}
	}
	for _, id := range append(append([]string{}, closed...), notHeld) {
		if got := rig.ledger.registered[id]; got != 0 {
			t.Errorf("session %s (%s) got %d supervisors, want none", id, fake.status[id], got)
		}
	}
	if !rig.starter.setAside() {
		t.Error("the unknown row whose takeover was refused was not set aside for a later reclaim")
	}
}

// The blocking reclaim (reclaimMissingSessions, the claim loop's lease reconciliation) judges each
// taken-over row the same way.
func TestReclaimMissingSessionsKeepsAnUnknownStatusOnlyWhenTheLeaseIsHeld(t *testing.T) {
	snapshot, open, _, held, notHeld := unknownStatusSnapshot()
	fake := newIdleFakeServer(snapshot, 0)
	fake.conflict[notHeld] = true
	srv := httptest.NewServer(fake)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	starts, skipped, err := reclaimMissingSessions(ctx, NewTransport(srv.URL, "token"),
		func() map[string]bool { return map[string]bool{} }, nil)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, s := range starts {
		got[s.job.SessionID] = true
	}
	want := map[string]bool{held: true}
	for _, id := range open {
		want[id] = true
	}
	for _, r := range snapshot {
		if got[r.SessionID] != want[r.SessionID] {
			t.Errorf("session %s (%q): started %v, want %v", r.SessionID, r.Status, got[r.SessionID], want[r.SessionID])
		}
	}
	if !skipped {
		t.Error("the unknown row whose takeover was refused was not set aside for a later reclaim")
	}
}
