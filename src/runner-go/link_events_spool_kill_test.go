package main

import (
	"fmt"
	"os"
	"testing"
	"time"

	"orbit/linkpb"
)

// A runner killed while it sends what its spool holds (SIGKILL, the OOM killer) loses none of it (task
// 34mwBTpOPo3S9LM2SXs10). B8's takeFirst read a segment into memory and deleted its file at once, so a process killed
// before the control plane stored those events took them with it. A segment read into memory now stays on disk until
// every event in it is stored; the next process sends it again, and the control plane stores each seq once.

// killed ends the sender as a process killed with SIGKILL does: nothing more is sent, and nothing is written to the
// spool. The process's linkMode closing later writes nothing either. What its streams held goes from the managed
// workload's count (managed_sleep.go), which a killed process takes with it, so that the next test starts from none.
func (e *linkEvents) killed() {
	e.mu.Lock()
	if !e.closed {
		e.closed = true
		close(e.stop)
	}
	e.mu.Unlock()
	<-e.done
	for _, s := range e.snapshot() {
		s.dropBacklog()
	}
}

// A segment taken into memory is on disk until its last event is stored, whole for whoever reads the spool next; after
// a partial ack, a stop writes again only what no taken segment holds, and the next process reads every event once.
func TestASpoolSegmentStaysOnDiskUntilItsEventsAreStored(t *testing.T) {
	logs := &linkTestLog{}
	dir := t.TempDir()
	spoolLeftBehind(t, dir, "session-k", 1, 20, "turn-0")
	q := newLinkSpool(dir, logs.log).queue(decodeSessionID("session-k"))
	taken := q.takeFirst(0)
	if len(taken) != 20 || q.count() != 0 {
		t.Fatalf("taking the segment brought %d events into memory and left %d counted on disk, want 20 and 0", len(taken), q.count())
	}
	if files := spoolFiles(dir); len(files) != 1 {
		t.Fatalf("once its events are in memory the spool holds %v, want the segment still", files)
	}
	// The process is killed here. The next one finds the segment whole.
	next := newLinkSpool(dir, logs.log).queue(decodeSessionID("session-k"))
	if next.count() != 20 || next.first() != 1 || next.last() != 20 {
		t.Fatalf("the next process finds %d events, seqs %d-%d, want 1-20", next.count(), next.first(), next.last())
	}
	if again := next.takeFirst(0); len(again) != 20 || again[0].seq != 1 || again[19].seq != 20 || again[19].typ != evTurnEnd {
		t.Fatalf("the next process reads back %d events, want the 20 the killed one had taken", len(again))
	}

	// Stored through 10: the segment holds 11..20 still, and stays.
	if dropped, _ := q.dropThrough(10); dropped != 0 {
		t.Errorf("an ack through seq 10 counted %d events of the taken segment as dropped from disk; memory counts them", dropped)
	}
	if files := spoolFiles(dir); len(files) != 1 {
		t.Fatalf("after an ack through seq 10 the spool holds %v, want the segment of 1-20 still", files)
	}
	// The runner stops: memory holds 11..20 of the taken segment and 21..25 nobody wrote to disk yet.
	var mem []*linkEvent
	for _, ev := range taken[10:] {
		mem = append(mem, ev)
	}
	for seq := uint64(21); seq <= 25; seq++ {
		mem = append(mem, &linkEvent{seq: seq, typ: evAssistant, tsMs: time.Now().UnixMilli(), payload: []byte(fmt.Sprintf(`{"text":"tick %d"}`, seq)), row: true})
	}
	if err := q.persist(mem, nil); err != nil {
		t.Fatal(err)
	}
	if files := spoolFiles(dir); len(files) != 2 {
		t.Fatalf("after the stop the spool holds %v, want the taken segment of 1-20 and one of 21-25", files)
	}
	after := newLinkSpool(dir, logs.log).queue(decodeSessionID("session-k"))
	if after.count() != 25 || after.first() != 1 || after.last() != 25 {
		t.Fatalf("the process after the stop finds %d events, seqs %d-%d, want 1-25 once each", after.count(), after.first(), after.last())
	}
	if logged(logs, "twice") || logged(logs, "lost") {
		t.Errorf("the spool lost or doubled events: %v", logs.all())
	}

	// Stored through 25: nothing is left.
	after.takeFirst(10)
	after.takeFirst(10)
	after.dropThrough(25)
	if files := spoolFiles(dir); len(files) != 0 {
		t.Errorf("once every event is stored the spool still holds %v", files)
	}
	if _, err := os.Stat(after.dir); !os.IsNotExist(err) {
		t.Errorf("the session's spool directory is still there once it holds nothing: %v", err)
	}
}

// A segment that does not read back whole is replaced, when it is taken, by one of what did read back: that is what a
// process killed before it is stored leaves, and its loss is said once.
func TestADamagedSegmentTakenIsKeptForWhatReadBack(t *testing.T) {
	logs := &linkTestLog{}
	dir := t.TempDir()
	spoolLeftBehind(t, dir, "session-d", 1, 20, "turn-0")
	files := spoolFiles(dir)
	data, err := os.ReadFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	// Seq 16's line is damaged: 1..15 read back.
	lines := 0
	cut := 0
	for i, b := range data {
		if b == '\n' {
			lines++
			if lines == 15 {
				cut = i + 1
			}
		}
	}
	if err := os.WriteFile(files[0], append(append([]byte{}, data[:cut]...), []byte("{damaged\n")...), 0o600); err != nil {
		t.Fatal(err)
	}
	q := newLinkSpool(dir, logs.log).queue(decodeSessionID("session-d"))
	if got := q.takeFirst(3); len(got) != 12 || got[0].seq != 4 || got[11].seq != 15 {
		t.Fatalf("taking the damaged segment after seq 3 brought %d events into memory, want 4-15", len(got))
	}
	if !logged(logs, "lost 5 events") {
		t.Errorf("the loss of seqs 16-20 was not said: %v", logs.all())
	}
	next := newLinkSpool(dir, logs.log).queue(decodeSessionID("session-d"))
	if next.count() != 12 || next.first() != 4 || next.last() != 15 {
		t.Fatalf("a process killed then leaves %d events, seqs %d-%d, want 4-15", next.count(), next.first(), next.last())
	}
}

// Over the link: the runner is killed with a batch of its spool out, refused before it was stored for one session and
// stored without its ack for another. The next process sends both again from the spool; each seq is stored once.
func TestARunnerKilledWhileSendingItsSpoolOverTheLinkLosesNothing(t *testing.T) {
	r, in := newLinkEventsRig(t)
	home := os.Getenv("ORBIT_HOME")
	spoolLeftBehind(t, r.m.events.spool.dir, "session-refused", 1, 30, "turn-0")
	spoolLeftBehind(t, r.m.events.spool.dir, "session-unacked", 1, 30, "turn-0")
	in.mu.Lock()
	in.refuseBatch = func(eb *linkpb.EventBatch) *linkpb.Failure {
		if decodeSessionID(eb.GetSessionId()) == decodeSessionID("session-refused") {
			return fakeIngestFailure("DATABASE_UNAVAILABLE", true, 200)
		}
		return nil
	}
	in.ackDelay = time.Hour // the stored batch's ack never comes back to this process
	in.mu.Unlock()
	r.useLink(t)
	for _, id := range []string{"session-refused", "session-unacked"} {
		s := r.m.events.open(id)
		defer s.release()
	}
	r.m.events.poke() // as the supervisor's wait for the spool to be stored does
	linkWaitFor(t, 10*time.Second, "a batch of each session's spool to be sent", func() bool {
		return len(in.batchesOf("session-refused")) > 0 && len(in.batchesOf("session-unacked")) > 0
	})
	if files := spoolFiles(r.m.events.spool.dir); len(files) != 2 {
		t.Fatalf("with the batches out and unacknowledged the spool holds %v, want both segments", files)
	}
	r.m.events.killed()
	if files := spoolFiles(r.m.events.spool.dir); len(files) != 2 {
		t.Fatalf("the killed process left %v, want both segments", files)
	}
	in.mu.Lock()
	in.refuseBatch, in.ackDelay = nil, 0
	in.mu.Unlock()

	// The next process, on the same machine, its link up before its supervisors open the sessions' streams.
	next := NewTransport(r.cp.URL, "runner-token")
	m := newLinkMode(next, r.logs.log)
	next.link = m
	t.Cleanup(m.close)
	m.work.client.api, m.work.client.dial = r.m.work.client.api, r.m.work.client.dial
	m.work.pingEvery, m.work.pingTimeout = 200*time.Millisecond, 2*time.Second
	m.observe(linkpb.Mode_MODE_LINK, "the test")
	r.g.waitWelcomed(t, len(r.g.welcomed())+1)
	for _, id := range []string{"session-refused", "session-unacked"} {
		s := m.events.open(id)
		defer s.release()
		linkWaitStored(t, s, 20*time.Second)
		in.assertContiguous(t, id, 1, 30)
	}
	in.mu.Lock()
	refusedWrites, unackedWrites := in.sessionLocked("session-refused").writes, in.sessionLocked("session-unacked").writes
	for seq := uint64(1); seq <= 30; seq++ {
		if refusedWrites[seq] != 1 || unackedWrites[seq] != 2 {
			t.Errorf("seq %d reached the store %d time(s) for the refused session and %d for the unacknowledged one, want 1 and 2 (sent again, stored once)",
				seq, refusedWrites[seq], unackedWrites[seq])
		}
	}
	in.mu.Unlock()
	if files := spoolFiles(home + "/link-spool"); len(files) != 0 {
		t.Errorf("once everything is stored the spool still holds %v", files)
	}
}

// With the link mode off the spool goes over HTTPS: a process killed with the spool's first batch out leaves the
// segment, and the next one sends it again.
func TestARunnerKilledWhileSendingItsSpoolOverHTTPSLosesNothing(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	logs := &linkTestLog{}
	spoolLeftBehind(t, linkSpoolDir(), "session-h", 10, 56, "turn-0")
	e := newLinkEvents(nil, logs.log)
	s := e.open("session-h")
	if batch := s.heldHead(maxEventBatchBytes); len(batch) != 56 {
		t.Fatalf("the flush's first batch carries %d events, want the spool's 56", len(batch))
	}
	// Killed while that batch is out.
	e.killed()
	if files := spoolFiles(linkSpoolDir()); len(files) != 1 {
		t.Fatalf("the killed process left %v, want the segment it was sending", files)
	}

	next := newLinkEvents(nil, logs.log)
	t.Cleanup(next.close)
	s2 := next.open("session-h")
	defer s2.release()
	batch := s2.heldHead(maxEventBatchBytes)
	if len(batch) != 56 || batch[0].Seq != 10 || batch[55].Seq != 65 || batch[55].Type != evTurnEnd {
		t.Fatalf("the next process sends %d events first, want the spool's seqs 10-65", len(batch))
	}
	s2.storedOverHTTPS(batch[0].Seq, batch[55].Seq)
	if held, _ := s2.holding(); held != 0 {
		t.Errorf("once HTTPS stored them the stream still holds %d events", held)
	}
	if files := spoolFiles(linkSpoolDir()); len(files) != 0 {
		t.Errorf("once HTTPS stored them the spool still holds %v", files)
	}
}
