package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"orbit/link-gateway/linkpb"
)

// Durable events stored through the ingest route, their acknowledgements and the credit (events.go).

const eventSession = "0190a0b0-0000-7000-8000-0000000000e1"

func eventsPath(session string) string { return "/api/runner/sessions/" + session + "/events" }

// batch is an EventBatch of seqs from..to, each payload holding what encoders treat differently.
func batch(session string, from, to uint64) *linkpb.EventBatch {
	eb := &linkpb.EventBatch{SessionId: session}
	for seq := from; seq <= to; seq++ {
		eb.Events = append(eb.Events, &linkpb.Event{
			Seq: seq, Type: "assistant", TsUnixMs: 1_761_380_000_123 + int64(seq), TurnId: "0190a0b0-0000-7000-8000-0000000000f1",
			PayloadJson: []byte(fmt.Sprintf(`{"text": "<b>step %d</b> & é 中文", "n": 1.50}`, seq)),
		})
	}
	return eb
}

func eventsFrame(eb *linkpb.EventBatch) *linkpb.Frame {
	return &linkpb.Frame{Body: &linkpb.Frame_EventBatch{EventBatch: eb}}
}

func stored(w http.ResponseWriter, r *http.Request, body []byte) {
	writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
}

func (tc *testConn) eventAck(timeout time.Duration) *linkpb.EventAck {
	tc.t.Helper()
	return tc.await("event_ack", timeout, nil).GetEventAck()
}

func TestAnEventBatchIsStoredAsItsMirrorWouldBeAndAcknowledged(t *testing.T) {
	backend := newFakeBackend(t, stored)
	h := newLinkHarness(t, []*fakeBackend{backend}, nil)
	tc, w := h.connectLink(runnerA, processA)
	if c := w.GetCredit(); c.GetMaxUnackedEvents() != 10_000 || c.GetMaxUnackedBytes() != 64<<20 {
		t.Fatalf("Welcome's credit %v", c)
	}
	eb := batch(eventSession, 1, 3)
	tc.send(eventsFrame(eb))
	ack := tc.eventAck(5 * time.Second)
	if ack.GetSessionId() != eventSession || ack.GetDurableSeq() != 3 || ack.GetFailure() != nil || len(ack.GetRejected()) != 0 {
		t.Fatalf("ack %v", ack)
	}
	calls := backend.requestsTo(eventsPath(eventSession))
	if len(calls) != 1 {
		t.Fatalf("%d calls", len(calls))
	}
	hello := linkHello(processA).GetHello()
	req := &linkpb.TunnelRequest{Method: "POST", Path: "/runner/sessions/" + eventSession + "/events", JsonBody: calls[0].Body}
	if diffs := compareEvents(eb, req, hello); len(diffs) != 0 {
		t.Fatalf("the forwarded batch differs from the mirror's mapping: %s\nbody %s", fields(diffs), calls[0].Body)
	}
	var body struct {
		LeaseOwner string `json:"leaseOwner"`
	}
	_ = json.Unmarshal(calls[0].Body, &body)
	if body.LeaseOwner != strings.ToLower(processA) {
		t.Fatalf("leaseOwner %q", body.LeaseOwner)
	}
	if got := h.g.metrics.eventsStored.get(); got != 3 {
		t.Fatalf("link_events_stored_total %v", got)
	}
	// Named by its public id, as a runner holds the ids it is handed: stored under the session's UUID, the same queue,
	// and acknowledged under the name it came with.
	public := batch("2x5PpI0zRtLFFWeu0anPl", 4, 5)
	tc.send(eventsFrame(public))
	if ack := tc.eventAck(5 * time.Second); ack.GetSessionId() != "2x5PpI0zRtLFFWeu0anPl" || ack.GetDurableSeq() != 5 {
		t.Fatalf("ack %v", ack)
	}
	if n := len(backend.requestsTo(eventsPath(eventSession))); n != 2 {
		t.Fatalf("%d calls to the session's UUID route", n)
	}
	eventually(t, 5*time.Second, "the ingest queue empty again", func() bool { return h.g.credit.depth() == creditLevel{} })
}

func TestASessionsBatchesAreStoredInOrderAndAFailureFailsThoseBehindIt(t *testing.T) {
	release := make(chan struct{})
	var mu sync.Mutex
	var order []string
	backend := newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		var b struct {
			Events []struct {
				Seq uint64 `json:"seq"`
			} `json:"events"`
		}
		_ = json.Unmarshal(body, &b)
		mu.Lock()
		order = append(order, fmt.Sprint(b.Events[0].Seq))
		mu.Unlock()
		if b.Events[0].Seq == 1 {
			<-release
			w.Header().Set("Retry-After-Ms", "2000")
			writeJSON(w, 503, map[string]any{"code": "DATABASE_UNAVAILABLE", "retryable": true, "retryAfterMs": 2000})
			return
		}
		stored(w, r, body)
	})
	h := newLinkHarness(t, []*fakeBackend{backend}, nil)
	tc, _ := h.connectLink(runnerA, processA)
	tc.send(eventsFrame(batch(eventSession, 1, 2)))
	eventually(t, 5*time.Second, "the first batch at the route", func() bool { return len(backend.requests()) == 1 })
	tc.send(eventsFrame(batch(eventSession, 3, 4)))
	tc.send(eventsFrame(batch(eventSession, 5, 6)))
	time.Sleep(100 * time.Millisecond)
	close(release)
	for i := 0; i < 3; i++ {
		ack := tc.eventAck(5 * time.Second)
		if f := ack.GetFailure(); f.GetCode() != "DATABASE_UNAVAILABLE" || !f.GetRetryable() || ack.GetDurableSeq() != 0 {
			t.Fatalf("ack %d: %v", i, ack)
		}
		if i == 0 && ack.GetFailure().GetRetryAfterMs() != 2000 {
			t.Fatalf("the retry hint: %v", ack.GetFailure())
		}
	}
	mu.Lock()
	if strings.Join(order, ",") != "1" {
		t.Fatalf("the route saw batches starting at %v: those behind the failure were stored after a gap", order)
	}
	mu.Unlock()
	// The runner sends again from durable_seq + 1, and the batches behind are stored in order.
	tc.send(eventsFrame(batch(eventSession, 1, 4)))
	if ack := tc.eventAck(5 * time.Second); ack.GetFailure().GetCode() != "DATABASE_UNAVAILABLE" {
		t.Fatalf("ack %v", ack)
	}
	backend.setHandler(stored)
	tc.send(eventsFrame(batch(eventSession, 1, 4)))
	tc.send(eventsFrame(batch(eventSession, 5, 6)))
	if ack := tc.eventAck(5 * time.Second); ack.GetDurableSeq() != 4 || ack.GetFailure() != nil {
		t.Fatalf("ack %v", ack)
	}
	if ack := tc.eventAck(5 * time.Second); ack.GetDurableSeq() != 6 || ack.GetFailure() != nil {
		t.Fatalf("ack %v", ack)
	}
	if h.g.metrics.eventBatches.get("failed_behind") != 2 {
		t.Fatalf("failed_behind %v", h.g.metrics.eventBatches.get("failed_behind"))
	}
}

func TestABatchThatWouldLeaveAGapIsRefused(t *testing.T) {
	backend := newFakeBackend(t, stored)
	h := newLinkHarness(t, []*fakeBackend{backend}, nil)
	tc, _ := h.connectLink(runnerA, processA)
	tc.send(eventsFrame(batch(eventSession, 1, 3)))
	if ack := tc.eventAck(5 * time.Second); ack.GetDurableSeq() != 3 {
		t.Fatalf("ack %v", ack)
	}
	tc.send(eventsFrame(batch(eventSession, 5, 6)))
	ack := tc.eventAck(5 * time.Second)
	if f := ack.GetFailure(); f.GetCode() != "EVENT_SEQ_GAP" || !f.GetRetryable() || ack.GetDurableSeq() != 3 {
		t.Fatalf("ack %v", ack)
	}
	// A batch sent again over what is stored, and one starting right after it, are taken.
	tc.send(eventsFrame(batch(eventSession, 2, 4)))
	if ack := tc.eventAck(5 * time.Second); ack.GetDurableSeq() != 4 || ack.GetFailure() != nil {
		t.Fatalf("ack %v", ack)
	}
	tc.send(eventsFrame(batch(eventSession, 1, 2)))
	if ack := tc.eventAck(5 * time.Second); ack.GetDurableSeq() != 4 {
		t.Fatalf("a batch of what is already stored took durable_seq back: %v", ack)
	}
	tc.send(eventsFrame(&linkpb.EventBatch{SessionId: eventSession, Events: []*linkpb.Event{{Seq: 5}, {Seq: 7}}}))
	if ack := tc.eventAck(5 * time.Second); ack.GetFailure().GetCode() != "EVENT_BATCH_MALFORMED" {
		t.Fatalf("a batch with a gap inside: %v", ack)
	}
	if n := len(backend.requests()); n != 3 {
		t.Fatalf("%d calls reached the route", n)
	}
}

func TestTheRoutesRefusalIsFinalOrRetryableAsItSays(t *testing.T) {
	backend := newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		writeJSON(w, http.StatusConflict, map[string]any{"code": "CONFLICT", "retryable": false, "message": "session is no longer open"})
	})
	h := newLinkHarness(t, []*fakeBackend{backend}, nil)
	tc, _ := h.connectLink(runnerA, processA)
	tc.send(eventsFrame(batch(eventSession, 1, 1)))
	if f := tc.eventAck(5 * time.Second).GetFailure(); f.GetCode() != "CONFLICT" || f.GetRetryable() {
		t.Fatalf("failure %v", f)
	}
	backend.setHandler(func(w http.ResponseWriter, r *http.Request, body []byte) { w.WriteHeader(http.StatusForbidden) })
	tc.send(eventsFrame(batch(eventSession, 1, 1)))
	if f := tc.eventAck(5 * time.Second).GetFailure(); f.GetCode() != "HTTP_403" || f.GetRetryable() {
		t.Fatalf("a refusal that names no code: %v", f)
	}
}

func TestABatchPastItsConnectionsCreditIsRefusedWithoutACall(t *testing.T) {
	release := make(chan struct{})
	backend := newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		<-release
		stored(w, r, body)
	})
	h := newLinkHarness(t, []*fakeBackend{backend}, func(c *config) {
		c.link.Credit = creditLevel{Events: 5, Bytes: 1 << 20}
	})
	tc, w := h.connectLink(runnerA, processA)
	if w.GetCredit().GetMaxUnackedEvents() != 5 {
		t.Fatalf("credit %v", w.GetCredit())
	}
	tc.send(eventsFrame(batch(eventSession, 1, 3)))
	eventually(t, 5*time.Second, "the first batch at the route", func() bool { return len(backend.requests()) == 1 })
	tc.send(eventsFrame(batch(eventSession, 4, 6)))
	ack := tc.eventAck(5 * time.Second)
	if f := ack.GetFailure(); f.GetCode() != "CREDIT_EXCEEDED" || !f.GetRetryable() || f.GetRetryAfterMs() != 1000 {
		t.Fatalf("ack %v", ack)
	}
	close(release)
	if ack := tc.eventAck(5 * time.Second); ack.GetDurableSeq() != 3 {
		t.Fatalf("ack %v", ack)
	}
	tc.send(eventsFrame(batch(eventSession, 4, 6)))
	if ack := tc.eventAck(5 * time.Second); ack.GetDurableSeq() != 6 {
		t.Fatalf("ack %v", ack)
	}
	if n := len(backend.requests()); n != 2 {
		t.Fatalf("%d calls", n)
	}
	if h.g.metrics.eventBatches.get("credit_exceeded") != 1 {
		t.Fatal("not counted")
	}
}

// Credit is granted by the depth of the gateway's ingest queue (§5.8): past the high-water mark every connection's
// credit drops, and below the low-water mark it comes back.
func TestCreditFallsWhenTheIngestQueueIsDeepAndComesBack(t *testing.T) {
	release := make(chan struct{})
	backend := newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		<-release
		stored(w, r, body)
	})
	h := newLinkHarness(t, []*fakeBackend{backend}, func(c *config) {
		c.link.Credit = creditLevel{Events: 100, Bytes: 64 << 20}
		c.link.Reduced = creditLevel{Events: 10, Bytes: 8 << 20}
		c.link.HighWater = creditLevel{Events: 4, Bytes: 512 << 20}
		c.link.LowWater = creditLevel{Events: 2, Bytes: 256 << 20}
	})
	a, _ := h.connectLink(runnerA, processA)
	b, _ := h.connectLink(runnerB, processB)
	a.send(eventsFrame(batch(eventSession, 1, 5)))
	for _, tc := range []*testConn{a, b} {
		if c := tc.await("credit", 5*time.Second, nil).GetCredit(); c.GetMaxUnackedEvents() != 10 || c.GetMaxUnackedBytes() != 8<<20 {
			t.Fatalf("reduced credit %v", c)
		}
	}
	if h.g.metrics.creditReduced.get() != 1 {
		t.Fatal("link_credit_reduced is not 1")
	}
	// A connection opened meanwhile starts with the reduced credit.
	_, w := h.connectLink("0190a0b0-0000-7000-8000-00000000000c", processC)
	if w.GetCredit().GetMaxUnackedEvents() != 10 {
		t.Fatalf("Welcome's credit while reduced: %v", w.GetCredit())
	}
	close(release)
	// The credit is given back before the batch is acknowledged: both are control frames, written in that order.
	for _, tc := range []*testConn{a, b} {
		if c := tc.await("credit", 5*time.Second, nil).GetCredit(); c.GetMaxUnackedEvents() != 100 {
			t.Fatalf("restored credit %v", c)
		}
	}
	if ack := a.eventAck(5 * time.Second); ack.GetDurableSeq() != 5 {
		t.Fatalf("ack %v", ack)
	}
	if h.g.metrics.creditChanges.get("reduced") != 1 || h.g.metrics.creditChanges.get("restored") != 1 {
		t.Fatal("changes not counted")
	}
}

// A connection that closes with batches queued or in flight gives their place in the ingest queue back.
func TestAClosedConnectionsEventsLeaveTheIngestQueue(t *testing.T) {
	backend := newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		<-r.Context().Done()
	})
	h := newLinkHarness(t, []*fakeBackend{backend}, nil)
	tc, _ := h.connectLink(runnerA, processA)
	tc.send(eventsFrame(batch(eventSession, 1, 3)))
	tc.send(eventsFrame(batch(eventSession, 4, 6)))
	tc.send(eventsFrame(batch("0190a0b0-0000-7000-8000-0000000000e2", 1, 2)))
	eventually(t, 5*time.Second, "eight events queued", func() bool { return h.g.credit.depth().Events == 8 })
	_ = tc.ws.CloseNow()
	eventually(t, 5*time.Second, "the ingest queue empty", func() bool { return h.g.credit.depth() == creditLevel{} })
}

// A batch sent again over what is stored, refused or failed, never moves where the next batch may start below what is
// acknowledged: the runner sends from durable_seq + 1, and that must be taken.
func TestARefusedResendDoesNotStrandTheSession(t *testing.T) {
	fail := make(chan bool, 1)
	backend := newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		select {
		case <-fail:
			writeJSON(w, 503, map[string]any{"code": "DATABASE_UNAVAILABLE", "retryable": true})
		default:
			stored(w, r, body)
		}
	})
	h := newLinkHarness(t, []*fakeBackend{backend}, func(c *config) { c.link.Credit = creditLevel{Events: 20, Bytes: 1 << 20} })
	tc, _ := h.connectLink(runnerA, processA)
	tc.send(eventsFrame(batch(eventSession, 1, 10)))
	if ack := tc.eventAck(5 * time.Second); ack.GetDurableSeq() != 10 {
		t.Fatalf("ack %v", ack)
	}
	// A stale resend that fails at the route…
	fail <- true
	tc.send(eventsFrame(batch(eventSession, 3, 5)))
	if ack := tc.eventAck(5 * time.Second); ack.GetFailure() == nil || ack.GetDurableSeq() != 10 {
		t.Fatalf("ack %v", ack)
	}
	// …and one past the credit: neither keeps the runner from going on from durable_seq + 1.
	tc.send(eventsFrame(batch(eventSession, 1, 25)))
	if ack := tc.eventAck(5 * time.Second); ack.GetFailure().GetCode() != "CREDIT_EXCEEDED" {
		t.Fatalf("ack %v", ack)
	}
	tc.send(eventsFrame(batch(eventSession, 11, 12)))
	if ack := tc.eventAck(5 * time.Second); ack.GetFailure() != nil || ack.GetDurableSeq() != 12 {
		t.Fatalf("the batch from durable_seq + 1: %v", ack)
	}
}
