package main

import (
	"container/list"
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
// mapping). The route stores each event once per seq, so a batch sent again stores nothing twice. Called by the link,
// the route refuses a bad event on its own (runner-api/link-events.ts): a tombstone holds its seq, the events after it
// are stored, and the answer's durableSeq and rejected are what EventAck says. A payload_json that is not JSON is
// passed as a JSON string, which the route refuses as that one event's payload, so one bad event never holds back the
// session's others.
//
// One session's batches are forwarded one after another, in the order they came, so they are stored in seq order.
// EventAck.durable_seq says every event up to it is stored, so it may only cover a batch whose predecessors are
// stored too: once a batch of a session fails, the batches queued behind it fail the same way rather than be stored
// after a gap, and a batch that would leave a gap behind what this connection forwarded is refused. The runner sends
// again from durable_seq + 1.
//
// Credit (§5.8: granted by the depth of the ingest queue). Each connection may have Credit unacknowledged events in
// flight, and the gateway counts what all of them have queued or in flight to the apiserver. Past a high-water mark
// every connection's credit drops (a Credit frame) to Reduced, or to the connection's share of MaxQueued when that is
// less, and below the low-water mark it comes back. A batch past its connection's credit is refused, retryable, without
// being forwarded.
//
// The queue never holds more than MaxQueued, however many connections there are: a batch it has no room for is refused
// the same way, and its session waits in line (creditBook.admit). Room the queue frees goes to the sessions in line,
// oldest first, and is held for each until its runner sends again; nothing else may take it. So no session is passed
// over for good, however small the batches of the others.

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
		l.ack(named, 0, nil, failure("EVENT_BATCH_MALFORMED", "the session id is neither a UUID nor a public id", false, 0))
		return
	}
	if gap := batchGap(events); gap != "" {
		m.eventBatches.inc("malformed")
		l.logFailure("an event batch is not in increasing seq order without gaps; refused", "session", sessionID, "detail", gap)
		l.ack(named, 0, nil, failure("EVENT_BATCH_MALFORMED", "the batch's events are not in increasing seq order without gaps: "+gap, true, time.Second))
		return
	}
	amount := creditLevel{Events: uint32(len(events))}
	for _, e := range events {
		amount.Bytes += uint64(len(e.GetPayloadJson()))
	}
	first, last := events[0].GetSeq(), events[len(events)-1].GetSeq()

	book := c.g.credit
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return
	}
	// The connection's share of the queue moves with the number of connections. It is told so with its next batch,
	// ahead of that batch's EventAck.
	if level := book.current(); level != l.credit {
		l.setCreditLocked(level)
	}
	q := l.sessionQ[sessionID]
	if q == nil {
		q = &sessionIngest{}
		l.sessionQ[sessionID] = q
	}
	var refusal *linkpb.Failure
	reduced := false
	switch {
	case q.next > 0 && first > q.next:
		refusal = failure("EVENT_SEQ_GAP", "the batch starts after a seq this connection has not stored; send again from durable_seq + 1", true, 0)
		m.eventBatches.inc("gap")
	case !l.unacked.plus(amount).within(l.credit):
		refusal = failure("CREDIT_EXCEEDED", "more events would be in flight than this connection's credit; send again once some are acknowledged", true, time.Second)
		m.eventBatches.inc("credit_exceeded")
	default:
		var admitted bool
		if admitted, reduced = book.admit(l, sessionID, amount); !admitted {
			refusal = failure("CREDIT_EXCEEDED", "the gateway's ingest queue is full; the session waits in line for room: send again from durable_seq + 1", true, time.Second)
			m.eventBatches.inc("queue_full")
		}
	}
	if refusal != nil {
		acked := q.acked
		if q.next == 0 {
			// The session's first batch on this connection: what the runner sends after it may not pass it.
			q.next = first
		}
		l.mu.Unlock()
		l.ack(named, acked, nil, refusal)
		return
	}
	l.unacked = l.unacked.plus(amount)
	q.queue = append(q.queue, &queuedBatch{eb: eb, amount: amount, accepted: time.Now()})
	if last+1 > q.next {
		q.next = last + 1
	}
	start := !q.running
	q.running = true
	l.mu.Unlock()
	if reduced {
		book.announce(true)
	}
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
		durable, rejected, fail, answered := l.store(sessionID, b.eb)
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
		l.ack(b.eb.GetSessionId(), acked, rejected, fail)
		for _, r := range rest {
			c.g.metrics.eventBatches.inc("failed_behind")
			l.ack(r.eb.GetSessionId(), acked, nil, fail)
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
	l.unacked = l.unacked.minus(total)
	l.mu.Unlock()
	l.c.g.credit.give(total)
}

// store forwards one batch: in a merged call when the gateway merges (events_merge.go) and the call takes it, and
// otherwise alone. It returns the durable seq the batch brings the session to and the events of it the route refused,
// or why it was not stored, and false when the connection ended before an answer.
func (l *linkState) store(sessionID string, eb *linkpb.EventBatch) (uint64, []*linkpb.RejectedEvent, *linkpb.Failure, bool) {
	c, m := l.c, l.c.g.metrics
	if p := c.g.pace; p != nil && !p.wait(c.ctx, len(eb.GetEvents())) {
		return 0, nil, nil, false
	}
	if merger := c.g.merger; merger != nil {
		res, merged, answered := merger.store(l, sessionID, eb)
		if !answered {
			return 0, nil, nil, false
		}
		if merged {
			return l.settle(sessionID, eb, res.answer, res.err)
		}
	}
	body, err := json.Marshal(eventsRequestBody(eb, c.claims.LeaseOwner))
	if err != nil {
		m.eventBatches.inc("unencodable")
		return 0, nil, failure("EVENT_BATCH_MALFORMED", "the batch could not be encoded: "+err.Error(), true, time.Second), true
	}
	answer, err := c.g.backends.do(c.ctx, backendCall{
		kind: "events", method: http.MethodPost, path: "/api/runner/sessions/" + sessionID + "/events", body: body,
		header: l.headers(),
		// Stored once per seq: a batch that reached the route twice stores nothing twice.
		idempotent: true,
	})
	return l.settle(sessionID, eb, answer, err)
}

// settle reads what the events route answered of one batch, alone or within a merged call: the durable seq and the
// refused events of a batch it stored, or why it was not stored. False when the connection ended before an answer.
func (l *linkState) settle(sessionID string, eb *linkpb.EventBatch, answer *backendAnswer, err error) (uint64, []*linkpb.RejectedEvent, *linkpb.Failure, bool) {
	m := l.c.g.metrics
	events := eb.GetEvents()
	if err != nil {
		if errors.Is(err, errCallCancelled) {
			return 0, nil, nil, false
		}
		m.eventBatches.inc("no_answer")
		l.logFailure("an event batch got no answer", "session", sessionID, "failure", err.Error())
		return 0, nil, failure(err.Error(), failureMessage(err), !errors.Is(err, errAnswerTooLarge), retryAfterFor(err)), true
	}
	if answer.status/100 == 2 {
		durable, rejected := storedAnswer(answer.body, events[len(events)-1].GetSeq())
		m.eventBatches.inc("stored")
		m.eventsStored.add(float64(len(events) - len(rejected)))
		if len(rejected) > 0 {
			l.logFailure("the ingest route refused events of a batch; tombstones hold their seqs", "session", sessionID,
				"rejected", len(rejected), "first_seq", rejected[0].GetSeq(), "first_code", rejected[0].GetCode())
		}
		return durable, rejected, nil, true
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
	return 0, nil, failure(code, "the ingest route answered "+uitoa(uint64(answer.status)), retryable,
		time.Duration(answerRetryAfterMs(answer))*time.Millisecond), true
}

// ack sends the session's EventAck: how far its events are stored, which of the last batch's the route refused, and
// why the last batch was not stored, when it was not.
func (l *linkState) ack(sessionID string, durable uint64, rejected []*linkpb.RejectedEvent, fail *linkpb.Failure) {
	l.c.send(&linkpb.Frame{Body: &linkpb.Frame_EventAck{EventAck: &linkpb.EventAck{
		SessionId: sessionID, DurableSeq: durable, Rejected: rejected, Failure: fail,
	}}}, true)
}

// storedAnswer reads what the route said of a batch it stored: the durable seq and the events it refused. An answer that
// says neither (an apiserver from before the link had its ingest entry) stored the whole batch: through its last seq,
// refusing nothing.
func storedAnswer(body []byte, last uint64) (uint64, []*linkpb.RejectedEvent) {
	var answer struct {
		DurableSeq *uint64 `json:"durableSeq"`
		Rejected   []struct {
			Seq     uint64 `json:"seq"`
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"rejected"`
	}
	if json.Unmarshal(body, &answer) != nil || answer.DurableSeq == nil {
		return last, nil
	}
	var rejected []*linkpb.RejectedEvent
	for _, r := range answer.Rejected {
		rejected = append(rejected, &linkpb.RejectedEvent{Seq: r.Seq, Code: r.Code, Message: r.Message})
	}
	return *answer.DurableSeq, rejected
}

// eventsRequestBody is the POST /runner/sessions/<id>/events body an EventBatch stands for (RunEventBatch): the process the
// connection belongs to, and each event with its ts in RFC 3339 to the millisecond and its payload as it was sent. A
// payload_json that is not JSON goes as a JSON string of its bytes, which the route refuses as that event's payload
// while it stores the others.
func eventsRequestBody(eb *linkpb.EventBatch, process string) map[string]any {
	return map[string]any{"leaseOwner": strings.ToLower(process), "events": requestEvents(eb)}
}

// httpEvent is one event of a RunEventBatch.
type httpEvent struct {
	Seq     uint64          `json:"seq"`
	Type    string          `json:"type"`
	TS      string          `json:"ts"`
	TurnID  string          `json:"turnId,omitempty"`
	Payload json.RawMessage `json:"payload"`
}

// requestEvents is an EventBatch's events as the events route takes them (eventsRequestBody).
func requestEvents(eb *linkpb.EventBatch) []httpEvent {
	events := make([]httpEvent, 0, len(eb.GetEvents()))
	for _, e := range eb.GetEvents() {
		payload := json.RawMessage(e.GetPayloadJson())
		switch {
		case len(payload) == 0:
			payload = json.RawMessage("null")
		case !json.Valid(payload):
			payload, _ = json.Marshal(string(payload))
		}
		events = append(events, httpEvent{
			Seq: e.GetSeq(), Type: e.GetType(), TurnID: e.GetTurnId(), Payload: payload,
			TS: time.UnixMilli(e.GetTsUnixMs()).UTC().Format("2006-01-02T15:04:05.000Z07:00"),
		})
	}
	return events
}

// creditBook is the gateway's ingest queue: the events and bytes every connection has queued or in flight to the
// apiserver, the credit that depth grants each connection, and the sessions waiting in line for room in it.
type creditBook struct {
	g       *gateway
	tune    linkTuning
	mu      sync.Mutex
	queued  creditLevel
	reduced bool
	// conns counts the connections that forward events (MODE_LINK): what MaxQueued is shared between.
	conns int
	// The sessions whose batch found no room: in line, oldest first, until room is held for them, and then called,
	// oldest call first. held is the room held for those called, which no other batch may take.
	line, called list.List
	waiting      map[*linkState]map[string]*waiter
	held         creditLevel
}

// waiter is a session in line for room in the ingest queue.
type waiter struct {
	l       *linkState
	session string
	// need is what its last batch asked; calledAt is when room was held for it, zero while it waits for that.
	need     creditLevel
	calledAt time.Time
	elem     *list.Element
}

func newCreditBook(g *gateway, tune linkTuning) *creditBook {
	return &creditBook{g: g, tune: tune, waiting: map[*linkState]map[string]*waiter{}}
}

// current is the credit a connection gets now.
func (b *creditBook) current() creditLevel {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.levelLocked()
}

// levelLocked is the credit a connection gets: Credit while the queue is short; while it is deep, Reduced, and no more
// events than the connection's share of MaxQueued, so that what every connection may have in flight fits in it. The
// bytes are not shared: Reduced's are what the largest event a runner sends needs (src/runner-go/link_events.go), and a
// share below them would hold that event back for good. MaxQueued bounds the bytes alone.
func (b *creditBook) levelLocked() creditLevel {
	if !b.reduced {
		return b.tune.Credit
	}
	level := b.tune.Reduced
	if share := b.tune.MaxQueued.Events / uint32(max(b.conns, 1)); share < level.Events {
		level.Events = max(share, 1)
	}
	return level
}

func (b *creditBook) depth() creditLevel {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.queued
}

// waitingSessions is how many sessions wait for room, in line or called.
func (b *creditBook) waitingSessions() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.line.Len() + b.called.Len()
}

// join counts a connection that forwards events; leave lets it go, and its sessions' places in line.
func (b *creditBook) join() {
	b.mu.Lock()
	b.conns++
	b.mu.Unlock()
}

func (b *creditBook) leave(l *linkState) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.conns--
	for _, w := range b.waiting[l] {
		b.dropLocked(w)
	}
	b.callLocked(time.Now())
}

// admit takes a session's batch into the queue when it has room for it: the queue stays within MaxQueued, and the room
// held for the sessions in line is theirs. A batch it has no room for is not taken, and its session takes its place at
// the back of the line, unless it has one already; once it has, only room held for it lets its batch in. reduced says
// the queue has just passed its high-water mark, which the caller announces.
func (b *creditBook) admit(l *linkState, session string, a creditLevel) (admitted, reduced bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	if b.expireLocked(now) {
		b.callLocked(now)
	}
	w := b.waiting[l][session]
	if w != nil && w.calledAt.IsZero() {
		// Still in line: what it asks now may be what lets its turn come.
		w.need = a
		b.callLocked(now)
	}
	switch {
	case w != nil && !w.calledAt.IsZero():
		if b.queued.plus(b.held.minus(w.need)).plus(a).within(b.tune.MaxQueued) {
			// The room held for it, and room nobody holds beside it.
			b.dropLocked(w)
			admitted = true
			break
		}
		// It asks more than was held for it: that goes back, and it is first in line for what it asks.
		b.called.Remove(w.elem)
		b.held = b.held.minus(w.need)
		w.need, w.calledAt = a, time.Time{}
		w.elem = b.line.PushFront(w)
		b.callLocked(now)
	case w != nil:
		// It waits its turn.
	case b.line.Len() == 0 && b.queued.plus(b.held).plus(a).within(b.tune.MaxQueued):
		admitted = true
	default:
		w = &waiter{l: l, session: session, need: a}
		w.elem = b.line.PushBack(w)
		if b.waiting[l] == nil {
			b.waiting[l] = map[string]*waiter{}
		}
		b.waiting[l][session] = w
	}
	if admitted {
		b.queued = b.queued.plus(a)
		if !b.reduced && !b.queued.within(b.tune.HighWater) {
			b.reduced, reduced = true, true
		}
	}
	return admitted, reduced
}

// give takes batches out of the queue: their room goes to the sessions in line first.
func (b *creditBook) give(a creditLevel) {
	b.mu.Lock()
	b.queued = b.queued.minus(a)
	now := time.Now()
	b.expireLocked(now)
	b.callLocked(now)
	changed := b.reduced && b.queued.Events < b.tune.LowWater.Events && b.queued.Bytes < b.tune.LowWater.Bytes
	if changed {
		b.reduced = false
	}
	b.mu.Unlock()
	if changed {
		b.announce(false)
	}
}

// callLocked holds room for the sessions in line, oldest first, while what the queue has left fits what each asked.
func (b *creditBook) callLocked(now time.Time) {
	for e := b.line.Front(); e != nil; e = b.line.Front() {
		w := e.Value.(*waiter)
		if !b.queued.plus(b.held).plus(w.need).within(b.tune.MaxQueued) {
			return
		}
		b.line.Remove(e)
		w.calledAt = now
		w.elem = b.called.PushBack(w)
		b.held = b.held.plus(w.need)
	}
}

// expireLocked lets go of the room held for sessions whose runner has not sent again within HoldFor: a runner sends a
// refused batch again within seconds (src/runner-go/link_events.go, linkEventRetryMax), so such a session has ended or
// gone elsewhere. If it sends again, it goes to the back of the line. It says whether any room was let go.
func (b *creditBook) expireLocked(now time.Time) bool {
	expired := false
	for e := b.called.Front(); e != nil; e = b.called.Front() {
		w := e.Value.(*waiter)
		if now.Sub(w.calledAt) < b.tune.HoldFor {
			break
		}
		b.dropLocked(w)
		expired = true
	}
	return expired
}

// dropLocked takes a session out of line, and lets go of any room held for it.
func (b *creditBook) dropLocked(w *waiter) {
	if w.calledAt.IsZero() {
		b.line.Remove(w.elem)
	} else {
		b.called.Remove(w.elem)
		b.held = b.held.minus(w.need)
	}
	sessions := b.waiting[w.l]
	delete(sessions, w.session)
	if len(sessions) == 0 {
		delete(b.waiting, w.l)
	}
}

// announce gives every connection in MODE_LINK the credit the queue's depth grants now, in a Credit frame: reduced
// says which way it has just changed.
func (b *creditBook) announce(reduced bool) {
	m := b.g.metrics
	b.mu.Lock()
	level := b.levelLocked()
	m.creditReduced.set(boolGauge(b.reduced))
	b.mu.Unlock()
	if reduced {
		m.creditChanges.inc("reduced")
		b.g.log.Warn("the ingest queue is past its high-water mark: credit reduced", "events", level.Events, "bytes", level.Bytes)
	} else {
		m.creditChanges.inc("restored")
		b.g.log.Info("the ingest queue has drained: credit restored", "events", level.Events, "bytes", level.Bytes)
	}
	for _, c := range b.g.reg.snapshot() {
		if c.link == nil {
			continue
		}
		c.link.mu.Lock()
		if c.link.credit != level {
			c.link.setCreditLocked(level)
		}
		c.link.mu.Unlock()
	}
}

func boolGauge(v bool) float64 {
	if v {
		return 1
	}
	return 0
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
