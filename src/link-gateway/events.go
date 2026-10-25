package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"orbit/link-gateway/linkpb"
)

// Durable events (docs/runner-link-design.md §5.8, §6.6). An EventBatch is stored by the apiserver's existing ingest
// route, POST /runner/sessions/<id>/events, as the batch a runner posts over HTTPS today (the inverse of the shadow
// mapping); B5 gives the link an ingest entry of its own. The route stores each event once per seq, so a batch sent
// again stores nothing twice.
//
// One session's batches are forwarded one after another, in the order they came, so they are stored in seq order.
// EventAck.durable_seq says every event up to it is stored, so it may only cover a batch whose predecessors are
// stored too: once a batch of a session fails, the batches queued behind it fail the same way rather than be stored
// after a gap, and a batch that would leave a gap behind what this connection forwarded is refused. The runner sends
// again from durable_seq + 1.
//
// Credit (§5.8: granted by the depth of the ingest queue). Each connection may have Credit unacknowledged events in
// flight, and the gateway counts what all of them have queued or in flight to the apiserver. Past a high-water mark
// every connection's credit drops (a Credit frame), and below the low-water mark it comes back. A batch past its
// connection's credit is refused, retryable, without being forwarded.

// sessionIngest is one session's batches on one connection.
type sessionIngest struct {
	queue   []*queuedBatch
	running bool
	// acked is the durable_seq last acknowledged on this connection; next is the seq the next batch may start at, at
	// most: a batch starting later would leave a gap. 0 while this connection has forwarded nothing of the session.
	acked, next uint64
}

type queuedBatch struct {
	eb       *linkpb.EventBatch
	amount   creditLevel
	accepted time.Time
}

// onEvents takes a batch from the runner.
func (l *linkState) onEvents(eb *linkpb.EventBatch) {
	c, m := l.c, l.c.g.metrics
	// Acknowledged under the id the runner sent, and queued and stored under its UUID, so both spellings of one
	// session are one queue.
	named := eb.GetSessionId()
	events := eb.GetEvents()
	if named == "" || len(events) == 0 {
		m.eventBatches.inc("empty")
		return
	}
	sessionID, ok := sessionUUID(named)
	if !ok {
		m.eventBatches.inc("malformed")
		l.ack(named, 0, failure("EVENT_BATCH_MALFORMED", "the session id is neither a UUID nor a public id", false, 0))
		return
	}
	if gap := batchGap(events); gap != "" {
		m.eventBatches.inc("malformed")
		l.logFailure("an event batch is not in increasing seq order without gaps; refused", "session", sessionID, "detail", gap)
		l.ack(named, 0, failure("EVENT_BATCH_MALFORMED", "the batch's events are not in increasing seq order without gaps: "+gap, true, time.Second))
		return
	}
	amount := creditLevel{Events: uint32(len(events))}
	for _, e := range events {
		amount.Bytes += uint64(len(e.GetPayloadJson()))
	}
	first, last := events[0].GetSeq(), events[len(events)-1].GetSeq()

	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return
	}
	q := l.sessionQ[sessionID]
	if q == nil {
		q = &sessionIngest{}
		l.sessionQ[sessionID] = q
	}
	var refusal *linkpb.Failure
	switch {
	case q.next > 0 && first > q.next:
		refusal = failure("EVENT_SEQ_GAP", "the batch starts after a seq this connection has not stored; send again from durable_seq + 1", true, 0)
		m.eventBatches.inc("gap")
	case l.unacked.Events+amount.Events > l.credit.Events || l.unacked.Bytes+amount.Bytes > l.credit.Bytes:
		refusal = failure("CREDIT_EXCEEDED", "more events would be in flight than this connection's credit; send again once some are acknowledged", true, time.Second)
		m.eventBatches.inc("credit_exceeded")
	}
	if refusal != nil {
		acked := q.acked
		if q.next == 0 {
			// The session's first batch on this connection: what the runner sends after it may not pass it.
			q.next = first
		}
		l.mu.Unlock()
		l.ack(named, acked, refusal)
		return
	}
	l.unacked.Events += amount.Events
	l.unacked.Bytes += amount.Bytes
	q.queue = append(q.queue, &queuedBatch{eb: eb, amount: amount, accepted: time.Now()})
	if last+1 > q.next {
		q.next = last + 1
	}
	start := !q.running
	q.running = true
	l.mu.Unlock()
	c.g.credit.take(amount)
	if start {
		go l.ingestLoop(sessionID, q)
	}
}

// batchGap says how a batch's events break increasing seq order without gaps; "" when they do not.
func batchGap(events []*linkpb.Event) string {
	for i, e := range events {
		if e.GetSeq() == 0 {
			return "an event has seq 0"
		}
		if i > 0 && e.GetSeq() != events[i-1].GetSeq()+1 {
			return "seq " + uitoa(events[i-1].GetSeq()) + " is followed by " + uitoa(e.GetSeq())
		}
	}
	return ""
}

// ingestLoop forwards one session's batches in order until its queue is empty.
func (l *linkState) ingestLoop(sessionID string, q *sessionIngest) {
	c := l.c
	for {
		l.mu.Lock()
		if len(q.queue) == 0 || l.closed {
			rest := q.queue
			q.queue, q.running = nil, false
			l.mu.Unlock()
			l.release(rest...)
			return
		}
		b := q.queue[0]
		q.queue = q.queue[1:]
		l.mu.Unlock()

		select {
		case l.ingestSlots <- struct{}{}:
		case <-c.ctx.Done():
			l.release(b)
			continue
		}
		durable, fail, answered := l.store(sessionID, b.eb)
		<-l.ingestSlots
		if !answered {
			// The connection ended: nobody to acknowledge.
			l.release(b)
			continue
		}

		l.mu.Lock()
		var rest []*queuedBatch
		if fail == nil {
			// A batch sent again after a later one was stored brings nothing new: durable_seq never goes back.
			q.acked = max(q.acked, durable)
		} else {
			// What is queued behind it would be stored after a gap: it fails the same way, and the runner sends
			// everything again from durable_seq + 1, which is where the next batch may start. With nothing
			// acknowledged here yet, that is where the failed batch started.
			rest = q.queue
			q.queue = nil
			if q.acked > 0 {
				q.next = q.acked + 1
			} else {
				q.next = b.eb.GetEvents()[0].GetSeq()
			}
		}
		acked := q.acked
		l.mu.Unlock()
		l.release(append([]*queuedBatch{b}, rest...)...)
		c.g.metrics.eventAckDuration.observe(time.Since(b.accepted))
		l.ack(b.eb.GetSessionId(), acked, fail)
		for _, r := range rest {
			c.g.metrics.eventBatches.inc("failed_behind")
			l.ack(r.eb.GetSessionId(), acked, fail)
		}
	}
}

// release takes batches out of the connection's and the gateway's counts of events in flight.
func (l *linkState) release(batches ...*queuedBatch) {
	var total creditLevel
	for _, b := range batches {
		total.Events += b.amount.Events
		total.Bytes += b.amount.Bytes
	}
	if total.Events == 0 && total.Bytes == 0 {
		return
	}
	l.mu.Lock()
	l.unacked.Events -= total.Events
	l.unacked.Bytes -= total.Bytes
	l.mu.Unlock()
	l.c.g.credit.give(total)
}

// store forwards one batch. It returns the durable seq the batch brings the session to, or why it was not stored,
// and false when the connection ended before an answer.
func (l *linkState) store(sessionID string, eb *linkpb.EventBatch) (uint64, *linkpb.Failure, bool) {
	c, m := l.c, l.c.g.metrics
	body, err := json.Marshal(eventsRequestBody(eb, c.claims.LeaseOwner))
	if err != nil {
		m.eventBatches.inc("unencodable")
		return 0, failure("EVENT_BATCH_MALFORMED", "an event's payload_json is not JSON", true, time.Second), true
	}
	events := eb.GetEvents()
	answer, err := c.g.backends.do(c.ctx, backendCall{
		kind: "events", method: http.MethodPost, path: "/api/runner/sessions/" + sessionID + "/events", body: body,
		header: l.headers(),
		// Stored once per seq: a batch that reached the route twice stores nothing twice.
		idempotent: true,
	})
	if err != nil {
		if errors.Is(err, errCallCancelled) {
			return 0, nil, false
		}
		m.eventBatches.inc("no_answer")
		l.logFailure("an event batch got no answer", "session", sessionID, "failure", err.Error())
		return 0, failure(err.Error(), failureMessage(err), !errors.Is(err, errAnswerTooLarge), retryAfterFor(err)), true
	}
	if answer.status/100 == 2 {
		m.eventBatches.inc("stored")
		m.eventsStored.add(float64(len(events)))
		return events[len(events)-1].GetSeq(), nil, true
	}
	// The route's own refusal: its code and whether sending again may help, as it states them. A refusal that does
	// not say is final for a 4xx (the session is no longer open, or this process lost its lease) and retryable for
	// anything else, as over HTTPS (common/runner-link-error.filter.ts).
	code, retryable, stated := answerCode(answer)
	if !stated {
		retryable = answer.status == http.StatusRequestTimeout || answer.status == http.StatusTooManyRequests || answer.status >= 500
	}
	if code == "" {
		code = "HTTP_" + uitoa(uint64(answer.status))
	}
	if retryable {
		m.eventBatches.inc("refused_retryable")
	} else {
		m.eventBatches.inc("refused")
	}
	l.logFailure("the ingest route refused an event batch", "session", sessionID, "status", answer.status, "code", code)
	return 0, failure(code, "the ingest route answered "+uitoa(uint64(answer.status)), retryable,
		time.Duration(answerRetryAfterMs(answer))*time.Millisecond), true
}

// ack sends the session's EventAck: how far its events are stored, and why the last batch was not, when it was not.
func (l *linkState) ack(sessionID string, durable uint64, fail *linkpb.Failure) {
	l.c.send(&linkpb.Frame{Body: &linkpb.Frame_EventAck{EventAck: &linkpb.EventAck{
		SessionId: sessionID, DurableSeq: durable, Failure: fail,
	}}}, true)
}

// eventsRequestBody is the POST /runner/sessions/<id>/events body an EventBatch stands for (RunEventBatch): the process the
// connection belongs to, and each event with its ts in RFC 3339 to the millisecond and its payload as it was sent.
func eventsRequestBody(eb *linkpb.EventBatch, process string) map[string]any {
	type httpEvent struct {
		Seq     uint64          `json:"seq"`
		Type    string          `json:"type"`
		TS      string          `json:"ts"`
		TurnID  string          `json:"turnId,omitempty"`
		Payload json.RawMessage `json:"payload"`
	}
	events := make([]httpEvent, 0, len(eb.GetEvents()))
	for _, e := range eb.GetEvents() {
		payload := json.RawMessage(e.GetPayloadJson())
		if len(payload) == 0 {
			payload = json.RawMessage("null")
		}
		events = append(events, httpEvent{
			Seq: e.GetSeq(), Type: e.GetType(), TurnID: e.GetTurnId(), Payload: payload,
			TS: time.UnixMilli(e.GetTsUnixMs()).UTC().Format("2006-01-02T15:04:05.000Z07:00"),
		})
	}
	return map[string]any{"leaseOwner": strings.ToLower(process), "events": events}
}

// creditBook is the gateway's ingest queue: the events and bytes every connection has queued or in flight to the
// apiserver, and the credit that depth grants each connection.
type creditBook struct {
	g       *gateway
	tune    linkTuning
	mu      sync.Mutex
	queued  creditLevel
	reduced bool
}

func newCreditBook(g *gateway, tune linkTuning) *creditBook {
	return &creditBook{g: g, tune: tune}
}

// current is the credit a connection gets now.
func (b *creditBook) current() creditLevel {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.reduced {
		return b.tune.Reduced
	}
	return b.tune.Credit
}

func (b *creditBook) depth() creditLevel {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.queued
}

func (b *creditBook) take(a creditLevel) {
	b.mu.Lock()
	b.queued.Events += a.Events
	b.queued.Bytes += a.Bytes
	changed := !b.reduced && (b.queued.Events > b.tune.HighWater.Events || b.queued.Bytes > b.tune.HighWater.Bytes)
	if changed {
		b.reduced = true
	}
	b.mu.Unlock()
	if changed {
		b.announce(b.tune.Reduced)
	}
}

func (b *creditBook) give(a creditLevel) {
	b.mu.Lock()
	b.queued.Events -= a.Events
	b.queued.Bytes -= a.Bytes
	changed := b.reduced && b.queued.Events < b.tune.LowWater.Events && b.queued.Bytes < b.tune.LowWater.Bytes
	if changed {
		b.reduced = false
	}
	b.mu.Unlock()
	if changed {
		b.announce(b.tune.Credit)
	}
}

// announce gives every connection in MODE_LINK its new credit, in a Credit frame.
func (b *creditBook) announce(level creditLevel) {
	m := b.g.metrics
	if level == b.tune.Reduced {
		m.creditReduced.set(1)
		m.creditChanges.inc("reduced")
		b.g.log.Warn("the ingest queue is past its high-water mark: credit reduced", "events", level.Events, "bytes", level.Bytes)
	} else {
		m.creditReduced.set(0)
		m.creditChanges.inc("restored")
		b.g.log.Info("the ingest queue has drained: credit restored", "events", level.Events, "bytes", level.Bytes)
	}
	for _, c := range b.g.reg.snapshot() {
		if c.link == nil {
			continue
		}
		c.link.mu.Lock()
		c.link.credit = level
		c.link.mu.Unlock()
		c.send(&linkpb.Frame{Body: &linkpb.Frame_Credit{Credit: &linkpb.Credit{
			MaxUnackedEvents: level.Events, MaxUnackedBytes: level.Bytes,
		}}}, true)
	}
}

func uitoa(v uint64) string {
	var b [20]byte
	i := len(b)
	for {
		i--
		b[i] = byte('0' + v%10)
		v /= 10
		if v == 0 {
			return string(b[i:])
		}
	}
}
