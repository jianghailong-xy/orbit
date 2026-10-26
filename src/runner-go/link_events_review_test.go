package main

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"orbit/linkpb"
)

// What the review of task B8 left (task B9, items 5–7): a stream let go between submit taking it up again and holding
// its events, late events handed to a newer supervisor's stream, and a refusal that is neither retryable nor the
// session's own, sent again for ever while everything behind it piles up in memory, then the spool, then memory again.

// A stream nobody holds is taken up again by the events handed to it (registered), and let go again by a Welcome that
// finds it holding nothing (resend: dropThroughLocked, forgetIfIdleLocked). The two meet as often as a reconnect finds
// a late background-job report on its way: events handed over then are held by the session's stream, never by one the
// sender no longer sees, because submit looks again, under the lock it holds them under, whether the stream is still the
// session's. The window is a few instructions wide, so the meeting is tried many times, against a Welcome repeated as
// fast as it can be.
func TestEventsHandedToAStreamAWelcomeLetsGoAreStillTheSessions(t *testing.T) {
	e := linkEventsWithoutSender(t)
	deadline := time.Now().Add(10 * time.Second)
	tries := 0
	for ; tries < 5000 && time.Now().Before(deadline); tries++ {
		id := fmt.Sprintf("session-%d", tries)
		s := e.open(id)
		s.release() // the supervisor returned: the stream holds nothing, and nobody holds it
		stop := make(chan struct{})
		welcomes := make(chan struct{})
		var resent atomic.Int64
		go func() {
			defer close(welcomes)
			for {
				select {
				case <-stop:
					return
				default:
					s.resend(0, true) // a Welcome that names the session, stored through nothing new
					resent.Add(1)
				}
			}
		}()
		for resent.Load() < 50 {
			runtime.Gosched() // the Welcomes are coming as fast as they can before the report is handed over
		}
		err := s.submit(linkTestRunEvents(1, 1, 10)) // the late report
		close(stop)
		<-welcomes
		if err != nil {
			t.Fatalf("try %d: %v", tries, err)
		}
		cur := e.stream(id)
		s.mu.Lock()
		held, forgotten := len(s.mem)+s.disk.count()+len(s.over), s.forgotten
		// Stored, as the stopped sender would have had it: what the stream holds would otherwise count as a managed
		// runner's unflushed work in every test after this one (unflushedEventCount).
		s.raiseStoredLocked(1)
		s.dropThroughLocked(1)
		s.mu.Unlock()
		if cur != s {
			t.Fatalf("try %d: the event is held by a stream the sender no longer sees (let go: %v, holding %d); the session's stream is %p",
				tries, forgotten, held, cur)
		}
	}
	t.Logf("%d tries", tries)
}

// Events handed to a supervisor's stream after the supervisor returned, while a newer supervisor of the session holds a
// stream of its own, are not sent, and the runner says so. The newer supervisor numbers its events from what the control
// plane held when it was claimed, so the late ones may be at seqs it numbers too: handed to its stream ahead of its own,
// they had that stream skip its own as handed over already, without a word. In the B8 review's probe that was a
// user_delivery, which the turn's completion relies on.
func TestLateEventsAreNotHandedToANewerSupervisorsStream(t *testing.T) {
	r, in := newLinkEventsRig(t)
	r.useLink(t)
	old := r.m.events.open("session-late")
	if err := old.submit(linkTestRunEvents(1, 3, 10)); err != nil {
		t.Fatal(err)
	}
	linkWaitStored(t, old, 10*time.Second)
	old.release() // the supervisor returned
	newer := r.m.events.open("session-late")
	defer newer.release()
	if newer == old {
		t.Fatal("the newer supervisor was handed the stream its predecessor let go")
	}
	if next := newer.firstSeq(4); next != 4 {
		t.Fatalf("the newer supervisor numbers from %d, want 4: the claim's MaxSeq is 3", next)
	}
	// The returned supervisor's background-job report, numbered 4 by its own buffer, comes first.
	lateErr := old.submit([]RunEvent{{Seq: 4, Type: evBackgroundTask, TS: nowISO(),
		Payload: map[string]interface{}{"toolUseId": "job-1", "status": "killed"}}})
	if err := newer.submit([]RunEvent{{Seq: 4, Type: evUserDelivery, TS: nowISO(), TurnID: "turn-2",
		Payload: map[string]interface{}{"turnId": "turn-2", "delivery": "acknowledged"}}}); err != nil {
		t.Fatal(err)
	}
	linkWaitStored(t, newer, 10*time.Second)
	if ev := in.event("session-late", 4); ev == nil || ev.GetType() != evUserDelivery {
		t.Fatalf("seq 4 is stored as %v, want the newer supervisor's own user_delivery", ev)
	}
	if lateErr == nil {
		t.Error("the late events were taken as handed over")
	}
	said := false
	for _, line := range r.logs.all() {
		said = said || strings.Contains(line, "a newer supervisor holds the session's stream; they are not sent")
	}
	if !said {
		t.Errorf("nothing said the late events were not sent:\n%s", strings.Join(r.logs.all(), "\n"))
	}
}

// A refusal that is neither retryable nor the session's own (a 413, a 500 the data decided) is sent again after a wait,
// as HTTPS sends such a batch again, but no more than maxEventFlushServerRejections times in a row
// (eventFlushRetryPolicy). Then the stream is given up: nothing more is sent, a wait for its events ends, and what it
// held is in the spool, not dropped. An ack that stores, or a retryable failure, starts the count over.
func TestAStreamRefusedThirtyTimesInARowIsGivenUpWithItsEventsInTheSpool(t *testing.T) {
	e := linkEventsWithoutSender(t)
	e.onLink.Store(true)
	c := &linkWorkConn{}
	e.welcomed(c, &linkpb.Welcome{Credit: &linkpb.Credit{MaxUnackedEvents: 1000, MaxUnackedBytes: 1 << 20}})
	s := e.open("session-r")
	defer s.release()
	if err := s.submit(linkTestRunEvents(1, 5, 10)); err != nil {
		t.Fatal(err)
	}
	refused := &linkpb.EventAck{SessionId: "session-r", Failure: &linkpb.Failure{Code: "PAYLOAD_TOO_LARGE", Message: "from the test"}}
	retryable := &linkpb.EventAck{SessionId: "session-r", Failure: &linkpb.Failure{Code: "DATABASE_UNAVAILABLE", Retryable: true}}
	at := time.Now()
	send := func(what string) {
		t.Helper()
		at = at.Add(time.Hour) // past any wait the last failure asked for
		if f, _, _ := s.nextBatch(c, at); f == nil {
			t.Fatalf("%s: the events were not sent again", what)
		}
	}
	// A retryable failure in the middle says nothing against the events: the count starts over.
	for i := 1; i < maxEventFlushServerRejections; i++ {
		send(fmt.Sprintf("refusal %d", i))
		s.acked(c, refused)
	}
	send("the retryable failure")
	s.acked(c, retryable)
	for i := 1; i <= maxEventFlushServerRejections; i++ {
		send(fmt.Sprintf("refusal %d after the retryable failure", i))
		s.acked(c, refused)
	}
	if f, _, _ := s.nextBatch(c, at.Add(time.Hour)); f != nil {
		t.Fatalf("the events were sent again after %d refusals in a row", maxEventFlushServerRejections)
	}
	s.mu.Lock()
	failure := s.failure
	s.mu.Unlock()
	if failure == nil {
		t.Fatal("the stream was not given up")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := s.waitStored(ctx); err == nil || errors.Is(err, context.DeadlineExceeded) || isLeaseOwnershipError(err) {
		t.Fatalf("a wait for the given-up events ended with %v", err)
	}
	if !strings.Contains(failure.Error(), "PAYLOAD_TOO_LARGE") {
		t.Errorf("the stream was given up for %q, which does not name the refusal", failure)
	}
	kept := newLinkSpool(linkSpoolDir(), (&linkTestLog{}).log).queue(decodeSessionID("session-r"))
	if seqs := linkSpoolReadAll(kept); fmt.Sprint(seqs) != "[1 2 3 4 5]" {
		t.Errorf("the spool keeps %v of the given-up events, want 1..5", seqs)
	}
}

// A session whose events the control plane refuses thirty times in a row is ended by its supervisor, with the refusal
// as its error: FAILED, finalized by this process, which still owns it, rather than detached or left running with a
// transcript nothing stores. Its events are in the spool.
func TestASessionWhoseEventsAreRefusedThirtyTimesInARowEndsWithTheRefusal(t *testing.T) {
	old := linkEventRetryMax
	linkEventRetryMax = 5 * time.Millisecond
	t.Cleanup(func() { linkEventRetryMax = old })
	var refusals atomic.Int32
	rig := superviseThroughReleaseOutageWith(t, true, func(in *fakeIngest) {
		in.refuseBatch = func(*linkpb.EventBatch) *linkpb.Failure {
			refusals.Add(1)
			return fakeIngestFailure("PAYLOAD_TOO_LARGE", false, 0)
		}
	})
	select {
	case <-rig.done:
	case <-time.After(30 * time.Second):
		t.Fatalf("the supervisor went on after %d refusals in a row", refusals.Load())
	}
	_, _, _, _, _, finalizes, _ := rig.cp.snapshot()
	if len(finalizes) != 1 || finalizes[0].Status != stFailed || !strings.Contains(finalizes[0].Error, "PAYLOAD_TOO_LARGE") {
		t.Fatalf("the session was finalized %+v, want once, FAILED, with the refusal as its error", finalizes)
	}
	if n := refusals.Load(); n < int32(maxEventFlushServerRejections) {
		t.Errorf("the session ended after %d refusals, want %d in a row first", n, maxEventFlushServerRejections)
	}
	kept := newLinkSpool(linkSpoolDir(), (&linkTestLog{}).log).queue(decodeSessionID(rig.job.SessionID))
	if seqs := linkSpoolReadAll(kept); len(seqs) == 0 || seqs[0] != 1 {
		t.Errorf("the spool keeps %v of the session's events, want them from seq 1", seqs)
	}
}

// What every stream holds in memory once the spool will not take it (over) has a bound, linkTotalOverBytes. The session
// that would pass it is given up, its supervisor told, as when its events are refused thirty times in a row: one session
// cannot run the runner out of memory. Another session's events stay where they are.
func TestASessionThatWouldPassTheBoundOnMemoryPastTheSpoolIsGivenUp(t *testing.T) {
	m, _ := linkEventsOffline(t)
	a, b := m.events.open("session-a"), m.events.open("session-b")
	defer a.release()
	defer b.release()
	// Memory spent and the spool full: what is handed over goes to over.
	var reserved int64
	for m.events.reserveMemory(1 << 20) {
		reserved += 1 << 20
	}
	for m.events.reserveMemory(1) {
		reserved++
	}
	defer m.events.releaseMemory(reserved)
	m.events.spool.charge(linkSpoolMaxBytes - m.events.spool.used())
	if err := b.submit(linkTestRunEvents(1, 2, 100)); err != nil {
		t.Fatal(err)
	}
	b.mu.Lock()
	bOver := len(b.over)
	var bBytes int64
	for _, ev := range b.over {
		bBytes += ev.size()
	}
	b.mu.Unlock()
	if bOver != 2 {
		t.Fatalf("session b holds %d events past the spool, want 2", bOver)
	}
	// All but 4 KiB of the bound taken: session a's 3 events of about 2 KB do not fit.
	room := int64(4 << 10)
	taken := linkTotalOverBytes - bBytes - room
	if !m.events.reserveOver(taken) {
		t.Fatal("the bound on memory past the spool could not be taken up")
	}
	defer m.events.releaseOver(taken)
	err := a.submit(linkTestRunEvents(1, 3, 2000))
	if !errors.Is(err, errLinkEventsAbandoned) {
		t.Fatalf("handing over past the bound answered %v, want the session given up", err)
	}
	a.mu.Lock()
	aOver, aFailure := len(a.over), a.failure
	a.mu.Unlock()
	if aOver != 0 || aFailure == nil {
		t.Errorf("session a holds %d events past the spool and failure %v, want none held and given up", aOver, aFailure)
	}
	// Not dropped: the one held, the one there was no room for and the one after it are written to the spool, past its
	// bound as when the runner stops.
	kept := newLinkSpool(linkSpoolDir(), (&linkTestLog{}).log).queue(decodeSessionID("session-a"))
	if seqs := linkSpoolReadAll(kept); fmt.Sprint(seqs) != "[1 2 3]" {
		t.Errorf("the spool keeps %v of the given-up session's events, want 1..3", seqs)
	}
	// What session a had taken of the bound is back.
	if !m.events.reserveOver(room) {
		t.Error("the given-up session's share of the bound was not given back")
	} else {
		m.events.releaseOver(room)
	}
	if err := a.submit(linkTestRunEvents(4, 1, 10)); !errors.Is(err, errLinkEventsAbandoned) {
		t.Errorf("a later hand-over to the given-up session answered %v", err)
	}
	b.mu.Lock()
	bOver, bFailure := len(b.over), b.failure
	b.mu.Unlock()
	if bOver != 2 || bFailure != nil {
		t.Errorf("session b holds %d events past the spool and failure %v, want its 2 and none", bOver, bFailure)
	}
}
