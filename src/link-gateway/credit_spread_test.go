package main

import (
	"fmt"
	"testing"
	"time"

	"orbit/link-gateway/linkpb"
)

// A credit change is not written to every connection in one pass: a walk tells CreditSpreadBatch connections at a
// time, CreditSpreadEvery apart, so however many there are, no more than a batch is written at once.
func TestACreditChangeIsToldToTheConnectionsAFewAtATime(t *testing.T) {
	const conns, perStep, every = 60, 10, 150 * time.Millisecond
	h := newLinkHarness(t, []*fakeBackend{newFakeBackend(t, stored)}, func(c *config) {
		c.link.Credit = creditLevel{Events: 100, Bytes: 64 << 20}
		c.link.Reduced = creditLevel{Events: 3, Bytes: 8 << 20}
		c.link.CreditSpreadBatch, c.link.CreditSpreadEvery = perStep, every
	})
	tcs := make([]*testConn, conns)
	for i := range tcs {
		tcs[i], _ = h.connectLink(fmt.Sprintf("0190a0b0-0000-7000-8000-%012x", 0x500+i), fmt.Sprintf("0190a0b0-0000-4000-8000-%012x", 0x500+i))
	}
	book := h.g.credit
	credits := func() int { return int(h.g.metrics.framesSent.get("credit")) }
	if credits() != 0 {
		t.Fatalf("%d credit frames before any change", credits())
	}

	book.mu.Lock()
	book.reduced = true
	book.mu.Unlock()
	start := time.Now()
	book.announce(true)
	// However the walk is scheduled, it has written at most one batch per step begun since it started.
	steps := 0
	for credits() < conns {
		elapsed := time.Since(start)
		if got, most := credits(), perStep*(int(elapsed/every)+1); got > most {
			t.Fatalf("%d credit frames written %s after the change: more than %d steps of %d", got, elapsed, int(elapsed/every)+1, perStep)
		}
		if elapsed > 20*time.Second {
			t.Fatalf("only %d of %d connections told within 20s", credits(), conns)
		}
		time.Sleep(10 * time.Millisecond)
		steps++
	}
	if took := time.Since(start); took < (conns/perStep-1)*every {
		t.Fatalf("all %d connections were told in %s, sooner than %d steps %s apart", conns, took, conns/perStep, every)
	}
	for _, tc := range tcs {
		if c := tc.await("credit", 5*time.Second, nil).GetCredit(); c.GetMaxUnackedEvents() != 3 {
			t.Fatalf("credit %v", c)
		}
	}
	if credits() != conns {
		t.Fatalf("%d credit frames for %d connections", credits(), conns)
	}
	t.Logf("%d connections told the change in %s, %d at a time", conns, time.Since(start).Round(time.Millisecond), perStep)
}

// A connection that sends before the walk reaches it is told the change with its batch, ahead of the batch's EventAck;
// the batch, sent within the credit the runner had, is taken.
func TestAConnectionThatSendsIsToldTheCreditWithItsBatch(t *testing.T) {
	h := newLinkHarness(t, []*fakeBackend{newFakeBackend(t, stored)}, func(c *config) {
		c.link.Credit = creditLevel{Events: 100, Bytes: 64 << 20}
		c.link.Reduced = creditLevel{Events: 3, Bytes: 8 << 20}
		// The walk tells one connection, then waits an hour.
		c.link.CreditSpreadBatch, c.link.CreditSpreadEvery = 1, time.Hour
	})
	a, _ := h.connectLink(runnerA, processA)
	b, _ := h.connectLink(runnerB, processB)
	book := h.g.credit
	book.mu.Lock()
	book.reduced = true
	book.mu.Unlock()
	book.announce(true)
	eventually(t, 5*time.Second, "the walk's first step", func() bool { return h.g.metrics.framesSent.get("credit") == 1 })
	// The connection the walk has not reached sends a batch of 5, past the reduced credit of 3 but within the 100 it
	// was told.
	var waiting *testConn
	for _, c := range h.g.reg.snapshot() {
		c.link.mu.Lock()
		told := c.link.credit.Events
		c.link.mu.Unlock()
		if told == 100 {
			waiting = map[string]*testConn{processA: a, processB: b}[c.claims.LeaseOwner]
		}
	}
	if waiting == nil {
		t.Fatal("the walk reached both connections in its first step")
	}
	waiting.send(eventsFrame(batch(eventSession, 1, 5)))
	f := waiting.await("", 5*time.Second, func(f *linkpb.Frame) bool { return f.GetCredit() != nil || f.GetEventAck() != nil })
	if f.GetCredit().GetMaxUnackedEvents() != 3 {
		t.Fatalf("the first frame after the batch: %v", f)
	}
	if ack := waiting.eventAck(5 * time.Second); ack.GetDurableSeq() != 5 || ack.GetFailure() != nil {
		t.Fatalf("ack %v", ack)
	}
}

// Once reduced, the credit comes back no sooner than CreditHold after the queue was last past its high-water mark,
// even when it drains below the low-water mark first; a queue that passes the mark again within the hold moves it on.
func TestTheCreditStaysReducedForItsHoldAfterTheQueueWasDeep(t *testing.T) {
	const hold = 400 * time.Millisecond
	b := queueBook(t, func(tune *linkTuning) {
		tune.MaxQueued = creditLevel{Events: 100, Bytes: 1 << 20}
		tune.HighWater, tune.LowWater = creditLevel{Events: 50, Bytes: 1 << 20}, creditLevel{Events: 25, Bytes: 1 << 20}
		tune.CreditHold = hold
	})
	deep := creditLevel{Events: 60, Bytes: 1}
	l := &linkState{}
	if ok, reduced := b.admit(l, "s", deep, true); !ok || !reduced {
		t.Fatal("the queue did not pass its high-water mark")
	}
	passed := time.Now()
	b.give(deep, true)
	if b.current() == b.tune.Credit {
		t.Fatal("the credit came back as soon as the queue drained")
	}
	// Past the mark again half-way through the hold: the hold starts over.
	time.Sleep(hold / 2)
	if ok, reduced := b.admit(l, "s", deep, true); !ok || reduced {
		t.Fatalf("admitted %v, announced a reduction %v while reduced", ok, reduced)
	}
	passed = time.Now()
	b.give(deep, true)
	time.Sleep(hold * 3 / 4)
	if b.current() == b.tune.Credit {
		t.Fatalf("the credit came back %s after the queue was last past its high-water mark; the hold is %s", time.Since(passed), hold)
	}
	eventually(t, 5*time.Second, "the credit back after the hold", func() bool { return b.current() == b.tune.Credit })
	if got := b.g.metrics.creditChanges.get("restored"); got != 1 {
		t.Fatalf("%v restorations", got)
	}
	if got := b.g.metrics.creditChanges.get("reduced"); got != 0 {
		// admit says a reduction happened; its caller announces it, which this test does not.
		t.Fatalf("%v reductions announced", got)
	}
}
