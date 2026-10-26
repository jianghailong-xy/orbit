package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"orbit/linkpb"
)

// The paths of the link's event streams that lost events or hung a session before revision 2 of task B8's evidence:
// a stream let go while something still used it, the spool's own failures, a turn completion waiting on a seq nothing
// stores, a refusal that ended the stream, and the in-flight count a reconnect or an HTTPS flush could leave wrong.

// linkEventsOffline is a link mode whose transport reaches nothing and whose link is not in use, with an ORBIT_HOME of
// the test's own: what a stream holds stays where it is until the test moves it.
func linkEventsOffline(t *testing.T) (*linkMode, *linkTestLog) {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	logs := &linkTestLog{}
	m := newLinkMode(NewTransport("http://127.0.0.1:1", "runner-token"), logs.log)
	t.Cleanup(m.close)
	return m, logs
}

// linkEventsWithoutSender is a stream manager whose sender is stopped: the test sends, by calling nextBatch.
func linkEventsWithoutSender(t *testing.T) *linkEvents {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	e := newLinkEvents(nil, (&linkTestLog{}).log)
	e.mu.Lock()
	e.closed = true
	close(e.stop)
	e.mu.Unlock()
	<-e.done
	return e
}

// linkSpoolTestEvents is n events as a stream holds them, from seq from.
func linkSpoolTestEvents(from, n int) []*linkEvent {
	out := make([]*linkEvent, n)
	for i := range out {
		seq := uint64(from + i)
		out[i] = &linkEvent{seq: seq, typ: evAssistant, tsMs: time.Now().UnixMilli(), payload: []byte(fmt.Sprintf(`{"text":"event %d"}`, seq))}
	}
	return out
}

// linkSpoolReadAll takes everything off a session's spool, in order, as a stream does.
func linkSpoolReadAll(q *linkSpoolQueue) []uint64 {
	var seqs []uint64
	for q.count() > 0 {
		for _, ev := range q.takeFirst(0) {
			seqs = append(seqs, ev.seq)
		}
	}
	return seqs
}

// linkAfterSeqBackend answers a turn completion as the control plane does (assertAfterSeqStored): pending until the
// session holds a row at or past its after_seq. With always, pending for any after_seq.
func linkAfterSeqBackend(in *fakeIngest, calls *atomic.Int32, always bool) func(*fakeWorkConn, *linkpb.Rpc) *linkpb.RpcResult {
	return func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
		if !strings.HasSuffix(rpc.GetTunnel().GetPath(), "/turn-complete") {
			return fakeWorkAnswer(rpc, 200, `{}`)
		}
		calls.Add(1)
		if after := rpc.GetAfterSeq(); after > 0 {
			seqs, _, _ := in.storedSeqs(rpc.GetSessionId())
			if always || len(seqs) == 0 || seqs[len(seqs)-1] < after {
				return &linkpb.RpcResult{RequestId: rpc.GetRequestId(), Outcome: &linkpb.RpcResult_Tunnel{Tunnel: &linkpb.TunnelResponse{
					Status: 503, RetryAfterMs: 50, JsonBody: []byte(`{"code":"RUNNER_LINK_AFTER_SEQ_PENDING","retryable":true}`),
				}}}
			}
		}
		return fakeWorkAnswer(rpc, 200, `{"status":"AWAITING_INPUT"}`)
	}
}

// An ack that empties a stream nobody holds lets the stream go. A supervisor that opens the session's stream at that
// moment gets one that is still the session's, whose events are sent: not one the sender no longer sees.
func TestAStreamOpenedWhileAnAckEmptiesItIsStillTheSessions(t *testing.T) {
	m, _ := linkEventsOffline(t)
	s := m.events.open("session-o")
	if err := s.submit(linkTestRunEvents(1, 3, 10)); err != nil {
		t.Fatal(err)
	}
	s.release() // its supervisor ended, its events still unacknowledged
	// The ack is being taken, holding the stream, as a new supervisor opens the session's stream.
	s.mu.Lock()
	opened := make(chan *linkEventStream, 1)
	go func() { opened <- m.events.open("session-o") }()
	time.Sleep(100 * time.Millisecond)
	s.raiseStoredLocked(3)
	s.dropThroughLocked(3)
	s.mu.Unlock()
	var got *linkEventStream
	select {
	case got = <-opened:
	case <-time.After(5 * time.Second):
		t.Fatal("the open did not return")
	}
	defer got.release()
	if m.events.stream("session-o") != got {
		t.Fatal("the stream the new supervisor holds is not the session's: nothing it hands over would be sent")
	}
}

// A supervisor's stream is let go once it holds nothing and nobody holds it. What the session hands over after that
// (bg.recordJobs reports the jobs it ended after the supervisor returned, session.go) is sent all the same, by the stream
// taken up again, and a wait for it ends. Once a newer supervisor holds a stream of the session, it is not sent
// (TestLateEventsAreNotHandedToANewerSupervisorsStream).
func TestEventsHandedOverAfterTheirSupervisorReturnedAreSent(t *testing.T) {
	r, in := newLinkEventsRig(t)
	r.useLink(t)
	s := r.m.events.open("session-late")
	if err := s.submit(linkTestRunEvents(1, 3, 10)); err != nil {
		t.Fatal(err)
	}
	linkWaitStored(t, s, 10*time.Second)
	s.release() // the supervisor returned
	if err := s.submit(linkTestRunEvents(4, 1, 10)); err != nil {
		t.Fatal(err)
	}
	linkWaitStored(t, s, 5*time.Second)
	in.assertContiguous(t, "session-late", 1, 4)
}

// A stream the session's own refusal ended (its lease lost) is never taken up again: what is handed to it later is
// refused as the lease error, and a newer supervisor gets a stream of its own, which sends.
func TestAStreamTheSessionsRefusalEndedIsNeverTakenUpAgain(t *testing.T) {
	r, in := newLinkEventsRig(t)
	r.useLink(t)
	in.mu.Lock()
	in.refuse = "CONFLICT"
	in.mu.Unlock()
	s := r.m.events.open("session-lost")
	if err := s.submit(linkTestRunEvents(1, 2, 10)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := s.waitStored(ctx); !isLeaseOwnershipError(err) {
		t.Fatalf("the wait ended with %v, want the lease error", err)
	}
	s.release()
	if err := s.submit(linkTestRunEvents(3, 1, 10)); !isLeaseOwnershipError(err) {
		t.Errorf("an event handed to the ended stream: %v", err)
	}
	in.mu.Lock()
	in.refuse = ""
	in.mu.Unlock()
	n := r.m.events.open("session-lost")
	defer n.release()
	if n == s {
		t.Fatal("the newer supervisor got the ended stream")
	}
	if err := n.submit(linkTestRunEvents(1, 2, 10)); err != nil {
		t.Fatal(err)
	}
	linkWaitStored(t, n, 10*time.Second)
}

// The spool counts an event once its line is in the segment's file. A write the disk refuses (ENOSPC, EIO) counts
// nothing, and every event the spool counts is there to be read back.
func TestTheSpoolCountsOnlyWhatReachedItsFile(t *testing.T) {
	q := newLinkSpool(t.TempDir(), (&linkTestLog{}).log).queue("session-w")
	events := linkSpoolTestEvents(1, 5)
	for _, ev := range events[:3] {
		if err := q.append(ev); err != nil {
			t.Fatal(err)
		}
	}
	_ = q.w.f.Close() // the disk fails under the open segment from here on
	refused := 0
	for _, ev := range events[3:] {
		if q.append(ev) != nil {
			refused++
		}
	}
	counted := q.count()
	read := linkSpoolReadAll(q)
	if len(read) != counted || counted+refused != len(events) {
		t.Errorf("the spool counted %d events and refused %d of %d, and its segments held %v", counted, refused, len(events), read)
	}
}

// A runner that stops writes what each stream holds in memory to the spool even when the spool's open segment can no
// longer be written: the next process finds every event.
func TestAStoppingRunnerKeepsWhatMemoryHoldsWhenTheSpoolFails(t *testing.T) {
	m, logs := linkEventsOffline(t)
	home := os.Getenv("ORBIT_HOME")
	s := m.events.open("session-p")
	defer s.release()
	if err := s.submit(linkTestRunEvents(1, 2, 10)); err != nil {
		t.Fatal(err) // in memory
	}
	var reserved int64
	for m.events.reserveMemory(1 << 20) {
		reserved += 1 << 20
	}
	for m.events.reserveMemory(1) {
		reserved++
	}
	if err := s.submit(linkTestRunEvents(3, 2, 10)); err != nil {
		t.Fatal(err) // on disk: memory is spent
	}
	s.mu.Lock()
	onDisk := s.disk.count()
	if s.disk.w != nil {
		_ = s.disk.w.f.Close() // the disk fails under the open segment
	}
	s.mu.Unlock()
	if onDisk != 2 {
		t.Fatalf("%d events went to disk, want 2", onDisk)
	}
	if err := s.submit(linkTestRunEvents(5, 2, 10)); err != nil {
		t.Fatal(err)
	}
	m.events.releaseMemory(reserved)
	m.close() // the runner stops
	next := newLinkSpool(filepath.Join(home, "link-spool"), logs.log).queue(decodeSessionID("session-p"))
	if kept := linkSpoolReadAll(next); fmt.Sprint(kept) != "[1 2 3 4 5 6]" {
		t.Errorf("the next process finds %v, want 1..6\n%s", kept, strings.Join(logs.all(), "\n"))
	}
}

// A turn completion waits for the session's last event the control plane stores as a row, never for a bare ping, which
// it acknowledges and stores as nothing. At the cut-over a reply delta numbered over HTTPS goes as such a ping
// (linkLiveEventSeqPlaceholder); a completion that waited for it would wait for ever.
func TestATurnCompletionDoesNotWaitForAPingThatIsNeverStored(t *testing.T) {
	shortenLinkWaits(t, linkLongPoll, linkApprovalRecheck, 300*time.Millisecond)
	r, in := newLinkEventsRig(t)
	var calls atomic.Int32
	r.g.backend = linkAfterSeqBackend(in, &calls, false)
	r.useLink(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	events := linkTestRunEvents(1, 3, 10)
	events = append(events, RunEvent{Seq: 4, Type: evTextDelta, TS: nowISO(), TurnID: "turn-1", Payload: map[string]interface{}{"text": "hel"}})
	if err := r.t.postEvents(ctx, "session-p", RunEventBatch{Events: events}); err != nil {
		t.Fatal(err)
	}
	began := time.Now()
	if _, err := r.t.turnComplete(ctx, "session-p", TurnCompleteRequest{TurnID: "turn-1"}); err != nil {
		t.Fatalf("the turn completion: %v (%d calls)", err, calls.Load())
	}
	if took, n := time.Since(began), calls.Load(); took > 250*time.Millisecond || n != 1 {
		t.Errorf("the turn completion took %s and %d calls", took, n)
	}
}

// A turn completion the control plane keeps answering pending goes again only after the wait the answer names, never in
// a loop that does not sleep: past linkAfterSeqWait it depends only on what is known stored, and past another wait on
// nothing at all.
func TestATurnCompletionKeptPendingBacksOffAndStopsWaiting(t *testing.T) {
	shortenLinkWaits(t, linkLongPoll, linkApprovalRecheck, 300*time.Millisecond)
	r, in := newLinkEventsRig(t)
	var calls atomic.Int32
	r.g.backend = linkAfterSeqBackend(in, &calls, true)
	r.useLink(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := r.t.postEvents(ctx, "session-q", linkTestEvents(1, 3, 10)); err != nil {
		t.Fatal(err)
	}
	began := time.Now()
	if _, err := r.t.turnComplete(ctx, "session-q", TurnCompleteRequest{TurnID: "turn-1"}); err != nil {
		t.Fatalf("the turn completion: %v (%d calls)", err, calls.Load())
	}
	// A pending answer asks for 50ms: some 12 calls over two waits of 300ms.
	if took, n := time.Since(began), calls.Load(); n > 40 {
		t.Errorf("%d calls in %s: the completion went again without waiting", n, took)
	}
}

// A spool segment holds consecutive seqs only: events numbered after a jump (a Welcome lifted the session's floor)
// start a segment of their own, and every one of them is read back.
func TestASpoolSegmentNeverSpansAJumpInSeqs(t *testing.T) {
	q := newLinkSpool(t.TempDir(), (&linkTestLog{}).log).queue("session-j")
	for _, ev := range append(linkSpoolTestEvents(1, 3), linkSpoolTestEvents(272, 3)...) {
		if err := q.append(ev); err != nil {
			t.Fatal(err)
		}
	}
	if read := linkSpoolReadAll(q); fmt.Sprint(read) != "[1 2 3 272 273 274]" {
		t.Errorf("the spool read back %v", read)
	}
}

// What a stopping runner leaves is read back whole by the next process past any jump in its seqs: segments that follow
// a jump are not taken for damaged ones, and none is written across one.
func TestTheSpoolKeepsWhatFollowsAJumpAcrossARestart(t *testing.T) {
	dir := t.TempDir()
	logs := &linkTestLog{}
	q := newLinkSpool(dir, logs.log).queue("session-k")
	head := append(linkSpoolTestEvents(1, 3), linkSpoolTestEvents(100, 2)...)
	if err := q.persist(head, linkSpoolTestEvents(272, 3)); err != nil {
		t.Fatal(err)
	}
	next := newLinkSpool(dir, logs.log).queue("session-k")
	if read := linkSpoolReadAll(next); fmt.Sprint(read) != "[1 2 3 100 101 272 273 274]" {
		t.Errorf("the next process read back %v\n%s", read, strings.Join(logs.all(), "\n"))
	}
}

// Events on disk; a Welcome that says the session is stored past them, which lifts its floor; and events numbered after
// the floor, which go to disk behind the old ones before the sender has taken those off it. Every one of the new ones
// is stored.
func TestEventsNumberedAfterAWelcomeLiftedTheFloorAreStored(t *testing.T) {
	r, in := newLinkEventsRig(t)
	var stored []uint64
	for seq := uint64(1); seq <= 271; seq++ {
		stored = append(stored, seq)
	}
	in.preload("session-f", stored...)
	s := r.m.events.open("session-f")
	defer s.release()
	var reserved int64
	for r.m.events.reserveMemory(1 << 20) {
		reserved += 1 << 20
	}
	for r.m.events.reserveMemory(1) {
		reserved++
	}
	if err := s.submit(linkTestRunEvents(1, 3, 10)); err != nil {
		t.Fatal(err) // on disk, the link not up
	}
	s.resend(271, true) // what a Welcome saying the session is stored through 271 does to its stream
	if err := s.submit(linkTestRunEvents(272, 3, 10)); err != nil {
		t.Fatal(err)
	}
	r.m.events.releaseMemory(reserved)
	r.useLink(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err := s.waitStored(ctx)
	for seq := uint64(272); seq <= 274; seq++ {
		if in.event("session-f", seq) == nil {
			t.Errorf("seq %d was not stored (the wait ended with %v)", seq, err)
		}
	}
}

// A refusal that is not retryable and not the session's own (the lease's CONFLICT, FORBIDDEN, NOT_FOUND) is one HTTPS
// sends again: a 413, a 500 the data decided. The stream keeps the events and sends them again after a wait, as after
// a retryable failure; a wait for them is told of the refusal, as an HTTPS flush is; and nothing after them is dropped.
func TestLinkEventsGoAgainAfterARefusalThatIsNotTheSessions(t *testing.T) {
	r, in := newLinkEventsRig(t)
	var refusing atomic.Bool
	refusing.Store(true)
	in.refuseBatch = func(eb *linkpb.EventBatch) *linkpb.Failure {
		if refusing.Load() {
			return fakeIngestFailure("PAYLOAD_TOO_LARGE", false, 0)
		}
		return nil
	}
	r.useLink(t)
	s := r.m.events.open("session-n")
	defer s.release()
	if err := s.submit(linkTestRunEvents(1, 5, 10)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := s.waitStored(ctx); err == nil || isLeaseOwnershipError(err) || errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("a wait for the refused events ended with %v, want the refusal", err)
	}
	refusing.Store(false)
	if err := s.submit(linkTestRunEvents(6, 3, 10)); err != nil {
		t.Fatalf("events handed over after the refusal: %v", err)
	}
	linkWaitStored(t, s, 20*time.Second)
	in.assertContiguous(t, "session-n", 1, 8)
}

// A Welcome starts every stream over on its connection before anything goes out on it. A batch sent on it before its
// stream started over would be forgotten by the stream while it still counts against the credit, and sent a second
// time: two batches in flight, an ack taken for the wrong one, and credit that never comes back, which under the
// gateway's reduced credit stalls every session.
func TestAWelcomeLeavesOneBatchInFlightAndTheCreditWhole(t *testing.T) {
	e := linkEventsWithoutSender(t)
	e.onLink.Store(true)
	credit := &linkpb.Credit{MaxUnackedEvents: 10, MaxUnackedBytes: 1 << 20}
	c1, c2 := &linkWorkConn{}, &linkWorkConn{}
	e.welcomed(c1, &linkpb.Welcome{Credit: credit})
	a, b := e.open("session-a"), e.open("session-b")
	defer a.release()
	defer b.release()
	turnEnd := func(seq int) []RunEvent {
		return []RunEvent{{Seq: seq, Type: evTurnEnd, TS: nowISO(), Payload: map[string]interface{}{}}}
	}
	for _, s := range []*linkEventStream{a, b} {
		if err := s.submit(turnEnd(1)); err != nil {
			t.Fatal(err)
		}
		if f, _, _ := s.nextBatch(c1, time.Now()); f == nil {
			t.Fatalf("%s's batch did not go", s.id)
		}
	}
	b.acked(c1, &linkpb.EventAck{SessionId: "session-b", DurableSeq: 1})
	if err := b.submit(turnEnd(2)); err != nil {
		t.Fatal(err) // b has an event to send and nothing in flight; a's batch is in flight on c1
	}
	// c1 is lost and c2 welcomed. Session a's stream is busy as the Welcome reaches it (it starts the streams over in
	// key order), and the sender meanwhile reaches session b's.
	e.mu.Lock()
	e.order = 0
	e.mu.Unlock()
	a.mu.Lock()
	welcomed := make(chan struct{})
	go func() { e.welcomed(c2, &linkpb.Welcome{Credit: credit}); close(welcomed) }()
	time.Sleep(100 * time.Millisecond)
	early, _, _ := b.nextBatch(c2, time.Now())
	a.mu.Unlock()
	<-welcomed
	inFlight := 0
	if early != nil {
		inFlight++
	}
	for i := 0; i < 2; i++ {
		if f, _, _ := b.nextBatch(c2, time.Now()); f != nil {
			inFlight++
		}
	}
	if inFlight != 1 {
		t.Fatalf("%d of session b's batches went on c2 before an ack, want 1", inFlight)
	}
	b.acked(c2, &linkpb.EventAck{SessionId: "session-b", DurableSeq: 2})
	if f, _, _ := a.nextBatch(c2, time.Now()); f != nil {
		a.acked(c2, &linkpb.EventAck{SessionId: "session-a", DurableSeq: 1})
	}
	e.mu.Lock()
	inflight := e.inflight
	e.mu.Unlock()
	if inflight != (linkCredit{}) {
		t.Errorf("with every batch acknowledged %+v is still counted in flight", inflight)
	}
}

// An HTTPS flush that was waiting its turn when the link came back in use leaves the batch the link has in flight
// alone: still one batch in flight, whose ack gives its credit back.
func TestAnHTTPSFlushLeavesTheLinksBatchInFlightAlone(t *testing.T) {
	e := linkEventsWithoutSender(t)
	e.onLink.Store(true)
	c := &linkWorkConn{}
	e.welcomed(c, &linkpb.Welcome{Credit: &linkpb.Credit{MaxUnackedEvents: 10, MaxUnackedBytes: 1 << 20}})
	s := e.open("session-h")
	defer s.release()
	if err := s.submit([]RunEvent{{Seq: 1, Type: evTurnEnd, TS: nowISO(), Payload: map[string]interface{}{}}}); err != nil {
		t.Fatal(err)
	}
	if f, _, _ := s.nextBatch(c, time.Now()); f == nil {
		t.Fatal("the batch did not go")
	}
	_ = s.heldHead(maxEventBatchBytes) // the HTTPS flush, behind the flush gate since before the link came back
	if f, _, _ := s.nextBatch(c, time.Now()); f != nil {
		t.Fatal("a second batch went while the first was in flight")
	}
	s.acked(c, &linkpb.EventAck{SessionId: "session-h", DurableSeq: 1})
	e.mu.Lock()
	inflight := e.inflight
	e.mu.Unlock()
	if inflight != (linkCredit{}) {
		t.Errorf("with the batch acknowledged %+v is still counted in flight", inflight)
	}
}

// Every delta is folded into the turn prefix, in HTTP mode as over the link, so that a TurnPrefixRequest just after the
// cut-over finds the turn whole. Folding one costs the same however long the prefix has grown: the emitter holds the
// session's buffer lock no longer for the last words of a long reply than for its first. Counted, not timed (a loaded
// host made the timing flaky): a reply of 60,000 characters folded in two at a time is copied to a new array, all told,
// no more than a few times its own length (the array grows geometrically, by a quarter once it is large, so its moves add
// up to about five times its length, where a fold that copied the prefix would copy 900 MB), and no fold counts the
// prefix's length again (each adds the delta's to the part's own count).
func TestFoldingADeltaIntoTheTurnPrefixCostsTheSameAtAnyLength(t *testing.T) {
	m, _ := linkEventsOffline(t)
	s := m.events.open("session-fold")
	defer s.release()
	buf := &sessionEventBuffer{next: 1, clock: &thinkingClock{}, link: s, provider: func() string { return providerClaude }}
	buf.add("turn-1", evAssistant, map[string]interface{}{"text": "done"}, nil) // a new draft
	delta := map[string]interface{}{"text": "ab"}
	const folds = 30_000
	copied, recounted := 0, 0
	for i := 0; i < folds; i++ {
		s.live.mu.Lock()
		before := s.live.text
		// A unit of length the fold is not told of: carried on by a fold that adds the delta's length to the part's count,
		// lost by one that counts the prefix again. Taken back out after the fold.
		s.live.text.n++
		s.live.mu.Unlock()
		buf.add("turn-1", evTextDelta, delta, nil)
		s.live.mu.Lock()
		after := s.live.text
		s.live.text.n--
		s.live.mu.Unlock()
		if len(before.b) > 0 && len(after.b) > 0 && &after.b[0] != &before.b[0] {
			copied += len(before.b) // the prefix moved to a new array
		}
		if after.n != before.n+1+2 {
			recounted++
		}
		if i%1000 == 999 {
			buf.take()
		}
	}
	s.live.mu.Lock()
	length, gone := len(s.live.text.b), s.live.text.gone
	s.live.mu.Unlock()
	if gone || length != 2*folds {
		t.Fatalf("the prefix holds %d characters (given up: %v), want %d", length, gone, 2*folds)
	}
	if recounted > 0 {
		t.Errorf("%d of %d folds counted the prefix's length again", recounted, folds)
	}
	if copied > 8*length {
		t.Errorf("folding a reply of %d characters copied %d bytes of it to new arrays, more than 8 times its length", length, copied)
	}
	t.Logf("a reply of %d characters folded in %d deltas: %d bytes copied in all, %d folds counted its length again", length, folds, copied, recounted)
}
