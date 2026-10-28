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

// The durable event stream over the link (link_events.go), against a gateway and ingest that keep the real ones' rules
// (link_events_harness_test.go).

func linkWaitStored(t *testing.T, s *linkEventStream, within time.Duration) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), within)
	defer cancel()
	if err := s.waitStored(ctx); err != nil {
		t.Fatalf("the session's events were not stored: %v", err)
	}
}

// Events handed to a session's stream go as EventBatches and are dropped once an EventAck covers them; whoever waits
// for them is told.
func TestLinkEventsGoUntilAcknowledged(t *testing.T) {
	r, in := newLinkEventsRig(t)
	r.useLink(t)
	s := r.m.events.open("session-a")
	defer s.release()
	if err := s.submit(linkTestRunEvents(1, 10, 100)); err != nil {
		t.Fatal(err)
	}
	linkWaitStored(t, s, 10*time.Second)
	in.assertContiguous(t, "session-a", 1, 10)
	s.mu.Lock()
	held, stored, backlog := len(s.mem)+s.disk.count(), s.stored, s.backlog.n.Load()
	s.mu.Unlock()
	if held != 0 || stored != 10 || backlog != 0 {
		t.Errorf("after the ack the stream holds %d events, stored through %d, backlog %d", held, stored, backlog)
	}
	// Handing the same events over again sends nothing: the stream takes each seq once.
	before := len(in.batchesOf("session-a"))
	if err := s.submit(linkTestRunEvents(1, 10, 100)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1500 * time.Millisecond)
	if after := len(in.batchesOf("session-a")); after != before {
		t.Errorf("events handed over twice went again: %d batches, then %d", before, after)
	}
}

// A session's events go about once a linkEventCadence, and at once when a boundary event comes or somebody waits for
// them.
func TestLinkEventsGoAtTheirCadenceOrAtOnceForABoundary(t *testing.T) {
	r, in := newLinkEventsRig(t)
	r.useLink(t)
	s := r.m.events.open("session-c")
	defer s.release()
	handed := time.Now()
	toolUse := RunEvent{Seq: 1, Type: evToolUse, TS: nowISO(), Payload: map[string]interface{}{"id": "toolu_1", "name": "Bash"}}
	if err := s.submit([]RunEvent{toolUse}); err != nil {
		t.Fatal(err)
	}
	linkWaitFor(t, 5*time.Second, "the tool call's batch", func() bool { return len(in.batchesOf("session-c")) == 1 })
	if took := in.batchesOf("session-c")[0].at.Sub(handed); took < linkEventCadence-100*time.Millisecond {
		t.Errorf("a tool call went %s after it was handed over, sooner than the %s cadence", took, linkEventCadence)
	}
	handed = time.Now()
	result := RunEvent{Seq: 2, Type: evToolResult, TS: nowISO(), Payload: map[string]interface{}{"toolUseId": "toolu_1", "content": "ok"}}
	if err := s.submit([]RunEvent{result}); err != nil {
		t.Fatal(err)
	}
	linkWaitFor(t, 5*time.Second, "the tool result's batch", func() bool { return len(in.batchesOf("session-c")) == 2 })
	if took := in.batchesOf("session-c")[1].at.Sub(handed); took > 500*time.Millisecond {
		t.Errorf("a tool result, a boundary, went %s after it was handed over", took)
	}
	// A wait for the events sends them at once too.
	handed = time.Now()
	thinking := RunEvent{Seq: 3, Type: evThinking, TS: nowISO(), Payload: map[string]interface{}{"text": "hmm"}}
	if err := s.submit([]RunEvent{thinking}); err != nil {
		t.Fatal(err)
	}
	linkWaitStored(t, s, 5*time.Second)
	if took := time.Since(handed); took > 500*time.Millisecond {
		t.Errorf("events somebody waited for were stored %s after they were handed over", took)
	}
	in.assertContiguous(t, "session-c", 1, 3)
}

// A session has one batch in flight at a time: the next goes once the EventAck of the last has come.
func TestLinkEventsKeepOneBatchInFlightPerSession(t *testing.T) {
	r, in := newLinkEventsRig(t)
	in.ackDelay = 300 * time.Millisecond
	r.useLink(t)
	s := r.m.events.open("session-o")
	defer s.release()
	for i := 0; i < 4; i++ {
		// Each a boundary, so each could go at once.
		if err := s.submit([]RunEvent{{Seq: i + 1, Type: evTurnEnd, TS: nowISO(), Payload: map[string]interface{}{}}}); err != nil {
			t.Fatal(err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	linkWaitStored(t, s, 10*time.Second)
	batches := in.batchesOf("session-o")
	for i := 1; i < len(batches); i++ {
		if gap := batches[i].at.Sub(batches[i-1].at); gap < in.ackDelay-20*time.Millisecond {
			t.Errorf("batch %d went %s after batch %d, before its ack", i, gap, i-1)
		}
	}
	in.assertContiguous(t, "session-o", 1, 4)
}

// What is in flight on a connection stays within its credit, across sessions; past it, events wait for an ack or a
// larger Credit, and the gateway never has to refuse one.
func TestLinkEventsStayWithinTheConnectionsCredit(t *testing.T) {
	r, in := newLinkEventsRig(t)
	in.credit = linkCredit{events: 5, bytes: 1 << 20}
	in.ackDelay = 50 * time.Millisecond
	r.useLink(t)
	a, b := r.m.events.open("session-a"), r.m.events.open("session-b")
	defer a.release()
	defer b.release()
	ea, eb := linkTestRunEvents(1, 23, 10), linkTestRunEvents(1, 17, 10)
	for _, ev := range append(ea, eb...) {
		ev.Type = evTurnEnd // at once
	}
	if err := a.submit(ea); err != nil {
		t.Fatal(err)
	}
	if err := b.submit(eb); err != nil {
		t.Fatal(err)
	}
	linkWaitStored(t, a, 20*time.Second)
	linkWaitStored(t, b, 20*time.Second)
	for _, batch := range append(in.batchesOf("session-a"), in.batchesOf("session-b")...) {
		if batch.n > 5 {
			t.Errorf("a batch of %d events, past the credit of 5", batch.n)
		}
	}
	for _, code := range in.refusalCodes() {
		t.Errorf("the gateway refused a batch: %s", code)
	}
	in.assertContiguous(t, "session-a", 1, 23)
	in.assertContiguous(t, "session-b", 1, 17)
	// A Credit frame raises it.
	c := r.g.open()[0]
	c.send(&linkpb.Frame{Body: &linkpb.Frame_Credit{Credit: &linkpb.Credit{MaxUnackedEvents: 1000, MaxUnackedBytes: 1 << 20}}})
	in.mu.Lock()
	in.conns[c].maxUnacked = linkCredit{events: 1000, bytes: 1 << 20}
	in.mu.Unlock()
	linkWaitFor(t, 5*time.Second, "the new credit", func() bool {
		r.m.events.mu.Lock()
		defer r.m.events.mu.Unlock()
		return r.m.events.credit.events == 1000
	})
	if err := a.submit(linkTestRunEvents(24, 40, 10)); err != nil {
		t.Fatal(err)
	}
	linkWaitStored(t, a, 10*time.Second)
	last := in.batchesOf("session-a")
	if n := last[len(last)-1].n; n <= 5 {
		t.Errorf("with a credit of 1000 the batch carried %d events", n)
	}
}

// The gateway's ingest queue full (src/link-gateway/events.go: CREDIT_EXCEEDED, retryable after 1s, while the
// session waits in line for room): the session keeps every event it holds, and those handed over meanwhile, sends again
// from durable_seq + 1 no sooner than the gateway asked, and once there is room every event is stored once, in order.
func TestLinkEventsWaitOutAFullIngestQueue(t *testing.T) {
	r, in := newLinkEventsRig(t)
	var full atomic.Bool
	full.Store(true)
	in.refuseBatch = func(eb *linkpb.EventBatch) *linkpb.Failure {
		if full.Load() {
			return fakeIngestFailure("CREDIT_EXCEEDED", true, 1000)
		}
		return nil
	}
	r.useLink(t)
	s := r.m.events.open("session-q")
	defer s.release()
	if err := s.submit(linkTestRunEvents(1, 10, 10)); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	s.urgent = true
	s.mu.Unlock()
	r.m.events.poke()
	linkWaitFor(t, 10*time.Second, "two batches refused for the full queue", func() bool { return len(in.refusalCodes()) >= 2 })
	// Handing events over never waits for room: they are held behind the refused ones.
	if err := s.submit(linkTestRunEvents(11, 20, 10)); err != nil {
		t.Fatal(err)
	}
	if held, tail := s.holding(); held != 30 || tail != 30 {
		t.Fatalf("the session holds %d events through seq %d, not all 30", held, tail)
	}
	full.Store(false)
	linkWaitStored(t, s, 20*time.Second)
	in.assertContiguous(t, "session-q", 1, 30)
	batches := in.batchesOf("session-q")
	for i := 1; i < len(batches); i++ {
		if batches[i-1].result != "CREDIT_EXCEEDED" {
			continue
		}
		if gap := batches[i].at.Sub(batches[i-1].at); gap < 950*time.Millisecond {
			t.Errorf("batch %d went %s after a refusal that asked for 1s", i, gap)
		}
		if batches[i].first != 1 {
			t.Errorf("batch %d after a refusal started at seq %d, not durable_seq + 1", i, batches[i].first)
		}
	}
	if held, _ := s.holding(); held != 0 {
		t.Fatalf("%d events still held once stored", held)
	}
}

// A Credit frame can lower the credit too: the gateway shares its ingest queue's high-water mark between the connections
// that send while the queue is deep (src/link-gateway/events.go). The batches after it stay within it, and nothing is
// refused or lost.
func TestLinkEventsKeepToALoweredCredit(t *testing.T) {
	r, in := newLinkEventsRig(t)
	in.ackDelay = 20 * time.Millisecond
	r.useLink(t)
	s := r.m.events.open("session-l")
	defer s.release()
	first := linkTestRunEvents(1, 20, 10)
	for i := range first {
		first[i].Type = evTurnEnd // at once
	}
	if err := s.submit(first); err != nil {
		t.Fatal(err)
	}
	linkWaitStored(t, s, 10*time.Second)
	c := r.g.open()[0]
	in.mu.Lock()
	in.conns[c].maxUnacked = linkCredit{events: 3, bytes: 1 << 20}
	in.mu.Unlock()
	c.send(&linkpb.Frame{Body: &linkpb.Frame_Credit{Credit: &linkpb.Credit{MaxUnackedEvents: 3, MaxUnackedBytes: 1 << 20}}})
	linkWaitFor(t, 5*time.Second, "the lowered credit", func() bool {
		r.m.events.mu.Lock()
		defer r.m.events.mu.Unlock()
		return r.m.events.credit.events == 3
	})
	before := len(in.batchesOf("session-l"))
	more := linkTestRunEvents(21, 40, 10)
	for i := range more {
		more[i].Type = evTurnEnd
	}
	if err := s.submit(more); err != nil {
		t.Fatal(err)
	}
	linkWaitStored(t, s, 20*time.Second)
	for _, b := range in.batchesOf("session-l")[before:] {
		if b.n > 3 {
			t.Errorf("a batch of %d events after the credit fell to 3", b.n)
		}
	}
	for _, code := range in.refusalCodes() {
		t.Errorf("the gateway refused a batch: %s", code)
	}
	in.assertContiguous(t, "session-l", 1, 60)
}

// A batch the ingest could not store, retryably, goes again after the wait it names, from the first event the
// connection has not stored; the events after it follow in order, and none is lost.
func TestLinkEventsGoAgainAfterARetryableFailure(t *testing.T) {
	r, in := newLinkEventsRig(t)
	r.useLink(t)
	s := r.m.events.open("session-r")
	defer s.release()
	if err := s.submit(linkTestRunEvents(1, 5, 10)); err != nil {
		t.Fatal(err)
	}
	linkWaitStored(t, s, 10*time.Second)
	in.setDown(true)
	if err := s.submit(linkTestRunEvents(6, 20, 10)); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	s.urgent = true
	s.mu.Unlock()
	r.m.events.poke()
	linkWaitFor(t, 10*time.Second, "a refused batch", func() bool { return len(in.refusalCodes()) >= 2 })
	in.setDown(false)
	linkWaitStored(t, s, 20*time.Second)
	in.assertContiguous(t, "session-r", 1, 25)
	for _, code := range in.refusalCodes() {
		if code != "DATABASE_UNAVAILABLE" {
			t.Errorf("the gateway refused a batch %s", code)
		}
	}
}

// A refusal that is not retryable ends the stream: nothing of it is sent again, and the session's flush reads it as
// the lease ownership error HTTPS would have answered with.
func TestLinkEventsStopAtARefusalThatIsNotRetryable(t *testing.T) {
	r, in := newLinkEventsRig(t)
	r.useLink(t)
	s := r.m.events.open("session-x")
	in.mu.Lock()
	in.refuse = "CONFLICT"
	in.mu.Unlock()
	if err := s.submit(linkTestRunEvents(1, 5, 10)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err := s.waitStored(ctx)
	if !isLeaseOwnershipError(err) {
		t.Fatalf("the wait ended with %v, want a lease ownership error", err)
	}
	before := len(in.batchesOf("session-x"))
	time.Sleep(1500 * time.Millisecond)
	if after := len(in.batchesOf("session-x")); after != before {
		t.Errorf("events went again after the refusal: %d batches, then %d", before, after)
	}
	if err := s.submit(linkTestRunEvents(6, 1, 10)); !isLeaseOwnershipError(err) {
		t.Errorf("events handed over after the refusal: %v", err)
	}
	s.release()
	if r.m.events.stream("session-x") != nil {
		t.Error("the ended stream is still held")
	}
}

// Events the ingest refused are held by tombstones there, and never sent again; a refused CURRENT_WORK delivery
// acknowledgement fails the session's next flush.
func TestLinkEventsRefusedByTheIngestAreNotSentAgain(t *testing.T) {
	r, in := newLinkEventsRig(t)
	in.refuseBatch = func(eb *linkpb.EventBatch) *linkpb.Failure { return nil }
	r.useLink(t)
	s := r.m.events.open("session-t")
	defer s.release()
	fence := &criticalEventFlushFence{}
	s.setFence(fence)
	events := linkTestRunEvents(1, 3, 10)
	// A type the ingest takes for a live event is refused and tombstoned: the stream sends what it is handed.
	in.mu.Lock()
	sess := in.sessionLocked("session-t")
	in.mu.Unlock()
	events[1] = RunEvent{Seq: 2, Type: evUserDelivery, TS: nowISO(), TurnID: "turn-1",
		Payload: map[string]interface{}{"turnId": "turn-1", "delivery": string(deliveryAcknowledged)}}
	in.mu.Lock()
	sess.tombstones[2] = "EVENT_UNSTORABLE"
	in.mu.Unlock()
	if err := s.submit(events); err != nil {
		t.Fatal(err)
	}
	linkWaitStored(t, s, 10*time.Second)
	time.Sleep(1500 * time.Millisecond)
	in.mu.Lock()
	writes := sess.writes[2]
	in.mu.Unlock()
	if writes != 1 {
		t.Errorf("the refused event reached the ingest %d times", writes)
	}
	if err := fence.check(); err == nil {
		t.Error("a refused CURRENT_WORK acknowledgement did not fail the session's flushes")
	}
	if line := strings.Join(r.logs.all(), "\n"); !strings.Contains(line, "seq 2 EVENT_UNSTORABLE") {
		t.Errorf("the refusal was not logged: %s", line)
	}
}

// After a lost connection, everything the stream holds after the durable_seq the next Welcome states is sent again,
// from its smallest seq, every seq of it. A Welcome that names no session says nothing about it: everything held is
// sent again. No batch is refused as a gap, and every seq is stored once.
func TestLinkEventsResumeFromTheWelcomesDurableSeq(t *testing.T) {
	for _, named := range []bool{true, false} {
		t.Run(fmt.Sprintf("welcome names the session: %v", named), func(t *testing.T) {
			r, in := newLinkEventsRig(t)
			in.welcomeSessions = named
			first := r.useLink(t)
			s := r.m.events.open("session-w")
			defer s.release()
			if err := s.submit(linkTestRunEvents(1, 10, 10)); err != nil {
				t.Fatal(err)
			}
			linkWaitStored(t, s, 10*time.Second)
			in.setDown(true)
			if err := s.submit(linkTestRunEvents(11, 30, 10)); err != nil {
				t.Fatal(err)
			}
			s.mu.Lock()
			s.urgent = true
			s.mu.Unlock()
			r.m.events.poke()
			linkWaitFor(t, 10*time.Second, "a refused batch", func() bool { return len(in.refusalCodes()) >= 1 })
			first.drop()
			in.setDown(false)
			second := r.g.waitWelcomed(t, 2)
			linkWaitStored(t, s, 20*time.Second)
			in.assertContiguous(t, "session-w", 1, 40)
			var resent []fakeIngestBatch
			for _, b := range in.batchesOf("session-w") {
				if b.conn == second.id {
					resent = append(resent, b)
				}
			}
			if len(resent) == 0 || resent[0].first != 11 {
				t.Errorf("the new connection's first batch is %+v, want one from seq 11", resent)
			}
			for _, code := range in.refusalCodes() {
				if code != "DATABASE_UNAVAILABLE" {
					t.Errorf("a batch was refused %s", code)
				}
			}
			resumed := second.hello.GetSessions()
			if len(resumed) != 1 || resumed[0].GetLastSeq() != 40 {
				t.Errorf("the second Hello resumes %v, want session-w from seq 40", resumed)
			}
		})
	}
}

// A session older than link mode: its HTTPS-era deltas took seqs that were never stored, so the Welcome's durable_seq
// stops at the first of them while the claim's MaxSeq is far past it. New events are numbered after the later of the
// two, never after durable_seq alone, which would number them into seqs already stored; and everything held after
// durable_seq is sent again after a reconnect, which skips none of them.
func TestLinkEventsOfAnOldSessionAreNumberedAfterEveryMark(t *testing.T) {
	r, in := newLinkEventsRig(t)
	var seqs []uint64
	for seq := uint64(1); seq <= 40; seq++ {
		if seq != 6 && seq != 7 && seq != 23 { // text_delta seqs HTTPS never stored
			seqs = append(seqs, seq)
		}
	}
	in.preload("session-old", seqs...)
	first := r.useLink(t)
	s := r.m.events.open("session-old")
	defer s.release()
	next := s.firstSeq(41) // the claim's MaxSeq, 40, plus one
	if next != 41 {
		t.Fatalf("an old session numbers from %d, want 41", next)
	}
	buf := &sessionEventBuffer{next: next, clock: &thinkingClock{}, link: s, provider: func() string { return providerClaude }}
	for i := 0; i < 5; i++ {
		buf.add("turn-1", evAssistant, map[string]interface{}{"text": fmt.Sprint("reply ", i)}, nil)
	}
	in.setDown(true)
	if err := s.submit(buf.take()); err != nil {
		t.Fatal(err)
	}
	linkWaitFor(t, 10*time.Second, "a refused batch", func() bool { return len(in.refusalCodes()) >= 1 })
	first.drop()
	in.setDown(false)
	second := r.g.waitWelcomed(t, 2)
	if got := second.hello.GetSessions(); len(got) != 1 || got[0].GetLastSeq() != 45 {
		t.Fatalf("the Hello resumes %v", got)
	}
	linkWaitStored(t, s, 20*time.Second)
	for seq := uint64(41); seq <= 45; seq++ {
		if ev := in.event("session-old", seq); ev == nil || !strings.HasPrefix(string(ev.GetPayloadJson()), `{"text":"reply`) {
			t.Errorf("seq %d holds %v, want the new reply", seq, ev)
		}
	}
	if s.floor.Load() != 5 {
		t.Errorf("the Welcome's durable_seq 5 did not become the floor: %d", s.floor.Load())
	}
	// More events follow on.
	buf.add("turn-1", evTurnEnd, map[string]interface{}{}, nil)
	if err := s.submit(buf.take()); err != nil {
		t.Fatal(err)
	}
	linkWaitStored(t, s, 10*time.Second)
	if ev := in.event("session-old", 46); ev == nil || ev.GetType() != evTurnEnd {
		t.Errorf("seq 46 holds %v", ev)
	}
}

// A Welcome stating a session stored past where its supervisor numbers from (a batch of the process it took the session
// over from committed after the claim read MaxSeq) raises the floor: new events are numbered after it.
func TestLinkEventsNumberAfterAWelcomeThatIsAhead(t *testing.T) {
	r, in := newLinkEventsRig(t)
	var seqs []uint64
	for seq := uint64(1); seq <= 12; seq++ {
		seqs = append(seqs, seq)
	}
	in.preload("session-ahead", seqs...)
	first := r.useLink(t)
	s := r.m.events.open("session-ahead")
	defer s.release()
	buf := &sessionEventBuffer{next: s.firstSeq(11), clock: &thinkingClock{}, link: s, provider: func() string { return providerClaude }}
	r.m.supervising([]string{"session-ahead"}) // as a heartbeat names it
	first.drop()                               // the next Hello names the session, and its Welcome says 12
	r.g.waitWelcomed(t, 2)
	linkWaitFor(t, 5*time.Second, "the Welcome's floor", func() bool { return s.floor.Load() == 12 })
	buf.add("", evAssistant, map[string]interface{}{"text": "after the takeover"}, nil)
	taken := buf.take()
	if len(taken) != 1 || taken[0].Seq != 13 {
		t.Fatalf("the event after the Welcome is %+v, want seq 13", taken)
	}
}

// When the runner stops, what a stream holds is kept on disk; the next process's supervisor for the session sends it
// first, and numbers its own events after it. Nothing collides and nothing is lost.
func TestLinkEventsKeptAcrossARestartAreSentFirst(t *testing.T) {
	r, in := newLinkEventsRig(t)
	home := os.Getenv("ORBIT_HOME")
	r.useLink(t)
	s := r.m.events.open("session-rs")
	if err := s.submit(linkTestRunEvents(1, 10, 10)); err != nil {
		t.Fatal(err)
	}
	linkWaitStored(t, s, 10*time.Second)
	in.setDown(true)
	if err := s.submit(linkTestRunEvents(11, 20, 10)); err != nil {
		t.Fatal(err)
	}
	s.release()
	if n := unflushedEventCount(); n != 20 {
		t.Fatalf("a managed runner sees %d unflushed events, want the 20 held", n)
	}
	r.m.close() // the runner stops: 11..30 are kept
	files, _ := filepath.Glob(filepath.Join(home, "link-spool", "*", "*.jsonl"))
	if len(files) == 0 {
		t.Fatal("nothing was kept on disk")
	}
	if n := unflushedEventCount(); n != 0 {
		t.Errorf("once they are kept for the next process, a managed runner still sees %d unflushed events", n)
	}
	in.setDown(false)

	// The next process: a transport of its own, on the same machine.
	next := NewTransport(r.cp.URL, "runner-token")
	m := newLinkMode(next, r.logs.log)
	next.link = m
	t.Cleanup(m.close)
	m.work.client.api, m.work.client.dial = r.m.work.client.api, r.m.work.client.dial
	m.work.pingEvery, m.work.pingTimeout = 200*time.Millisecond, 2*time.Second
	s2 := m.events.open("session-rs")
	defer s2.release()
	if got := s2.firstSeq(11); got != 31 {
		t.Fatalf("the next process numbers from %d, want 31: after what the last one left", got)
	}
	m.observe(linkpb.Mode_MODE_LINK, "the test")
	c := r.g.waitWelcomed(t, len(r.g.welcomed())+1)
	if got := c.hello.GetSessions(); len(got) != 1 || got[0].GetLastSeq() != 30 {
		t.Errorf("the next process's Hello resumes %v, want session-rs from 30", got)
	}
	buf := &sessionEventBuffer{next: 31, clock: &thinkingClock{}, link: s2, provider: func() string { return providerClaude }}
	buf.add("", evTurnEnd, map[string]interface{}{}, nil)
	if err := s2.submit(buf.take()); err != nil {
		t.Fatal(err)
	}
	linkWaitStored(t, s2, 20*time.Second)
	in.assertContiguous(t, "session-rs", 1, 31)
	if files, _ := filepath.Glob(filepath.Join(home, "link-spool", "*", "*.jsonl")); len(files) != 0 {
		t.Errorf("the spool still holds %v once everything is stored", files)
	}
}

// Past what memory may hold for a session, its events wait on disk, in order, and go once the stream has room. The
// emitter never waits for the disk or the network.
func TestLinkEventsPastMemoryWaitOnDisk(t *testing.T) {
	r, in := newLinkEventsRig(t)
	r.useLink(t)
	in.setDown(true)
	s := r.m.events.open("session-big")
	defer s.release()
	const payload = 32 << 10
	n := (linkSessionMemoryBytes / payload) * 2 // twice the session's memory, 50 at a time
	n -= n % 50
	var slowest time.Duration
	for i := 0; i < n; i += 50 {
		began := time.Now()
		if err := s.submit(linkTestRunEvents(i+1, 50, payload)); err != nil {
			t.Fatal(err)
		}
		slowest = max(slowest, time.Since(began))
	}
	s.mu.Lock()
	onDisk, inMemory := s.disk.count(), s.memBytes
	s.mu.Unlock()
	if onDisk == 0 || inMemory > linkSessionMemoryBytes {
		t.Fatalf("%d events on disk and %d bytes in memory, past the %d the session may hold", onDisk, inMemory, linkSessionMemoryBytes)
	}
	if slowest > time.Second {
		t.Errorf("handing 50 events over took %s", slowest)
	}
	in.setDown(false)
	linkWaitStored(t, s, 60*time.Second)
	in.assertContiguous(t, "session-big", 1, uint64(n))
	if r.m.events.spool.used() != 0 {
		t.Errorf("the spool still counts %d bytes", r.m.events.spool.used())
	}
}

// A segment of the spool that does not read whole loses its events; what follows them goes on a new connection, whose
// first batch of the session may start anywhere, and is not refused for the gap forever.
func TestLinkEventsCrossAGapOnANewConnection(t *testing.T) {
	r, in := newLinkEventsRig(t)
	r.useLink(t)
	s := r.m.events.open("session-gap")
	defer s.release()
	if err := s.submit(linkTestRunEvents(1, 5, 10)); err != nil {
		t.Fatal(err)
	}
	linkWaitStored(t, s, 10*time.Second)
	// 6..8 are lost: what the stream holds starts at 9.
	s.mu.Lock()
	for _, ev := range linkTestRunEvents(9, 3, 10) {
		s.mem = append(s.mem, s.linkEventOf(ev))
		s.tail = uint64(ev.Seq)
	}
	s.urgent = true
	s.mu.Unlock()
	r.m.events.poke()
	linkWaitStored(t, s, 20*time.Second)
	codes := strings.Join(in.refusalCodes(), ",")
	if !strings.Contains(codes, "EVENT_SEQ_GAP") || len(r.g.welcomed()) < 2 {
		t.Errorf("refusals %s over %d connections", codes, len(r.g.welcomed()))
	}
	for seq := uint64(9); seq <= 11; seq++ {
		if in.event("session-gap", seq) == nil {
			t.Errorf("seq %d was never stored", seq)
		}
	}
}

// A session's stream ends for a refusal over HTTPS too: what it holds is dropped, and nothing is sent again.
func TestLinkEventStreamFailsForAnHTTPSRefusal(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	m := newLinkMode(NewTransport("http://127.0.0.1:1", "runner-token"), (&linkTestLog{}).log)
	t.Cleanup(m.close)
	s := m.events.open("session-h")
	if err := s.submit(linkTestRunEvents(1, 3, 10)); err != nil {
		t.Fatal(err)
	}
	refusal := &transportHTTPError{method: "POST", path: "/runner/sessions/session-h/events", statusCode: 409}
	s.fail(refusal)
	if err := s.submit(linkTestRunEvents(4, 1, 10)); !errors.Is(err, refusal) {
		t.Errorf("handing events over after the refusal: %v", err)
	}
	s.release()
	if m.events.stream("session-h") != nil {
		t.Error("the ended stream is still held")
	}
}

// A batch of the process a supervisor took its session over from can commit after the claim read MaxSeq and before the
// takeover fenced that process out. A supervisor that starts in link mode reads what is stored after its claim's
// MaxSeq, page by page, and numbers after it: a seq numbered again would be skipped by the stored-once ingest, and its
// event lost.
func TestASupervisorNumbersAfterWhatWasStoredSinceItsClaim(t *testing.T) {
	r, _ := newLinkEventsRig(t)
	var asked []string
	r.g.backend = func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
		path := rpc.GetTunnel().GetPath()
		asked = append(asked, path)
		switch {
		case strings.Contains(path, "/events?after=10&"):
			return fakeWorkAnswer(rpc, 200, `{"events":[{"seq":11,"type":"assistant","payload":{}},{"seq":12,"type":"tool_use","payload":{}}],"hasMore":true}`)
		case strings.Contains(path, "/events?after=12&"):
			return fakeWorkAnswer(rpc, 200, `{"events":[{"seq":14,"type":"turn_end","payload":{}}],"hasMore":false}`)
		}
		return fakeWorkAnswer(rpc, 200, `{"events":[],"hasMore":false}`)
	}
	r.useLink(t)
	if got := linkStoredSeqAfterTakeover(context.Background(), r.t, "session-taken", 11); got != 15 {
		t.Errorf("the supervisor numbers from %d, want 15; asked %v", got, asked)
	}
	// Nothing stored after it: the claim's MaxSeq stands.
	if got := linkStoredSeqAfterTakeover(context.Background(), r.t, "session-quiet", 3); got != 3 {
		t.Errorf("with nothing stored since the claim the supervisor numbers from %d, want 3", got)
	}
	// A read that fails leaves it as it was.
	r.g.backend = func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult { return fakeWorkAnswer(rpc, 500, `{}`) }
	if got := linkStoredSeqAfterTakeover(context.Background(), r.t, "session-taken", 11); got != 11 {
		t.Errorf("after a failed read the supervisor numbers from %d, want 11", got)
	}
}
