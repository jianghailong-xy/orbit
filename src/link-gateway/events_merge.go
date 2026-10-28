package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"orbit/link-gateway/linkpb"
)

// Merged ingest (docs/runner-link-design.md §6.6, §6.7). The event batches of every connection this gateway holds go
// to the apiserver in merged calls: a batch waits up to LINK_EVENT_MERGE_WINDOW for others to join it, from any
// connection, and they go as one call, POST /api/runner/link/events, which the apiserver stores in one transaction
// (src/apiserver/src/runner-api/link-events.ts) where each batch alone would be a call and a transaction of its own.
// The call answers each batch as the events route would answer it alone, and that answer becomes the batch's EventAck
// on its own connection, as before (events.go).
//
// A batch is forwarded alone, as before, when the call answers it sendAlone (the apiserver did not take it, and wrote
// nothing of it: its session is held by another writer, or the route refuses it, or its ingest failed), when it is
// too big to merge, and when the apiserver does not take the call whole: an older apiserver without the route, a call
// it could not read, a fault of its own. A call the database turned away (a 503) fails each of its batches as it
// would have failed alone, retryable.
//
// A call goes when its window closes, at once when it is full (the batches its transaction may hold, the bytes its
// body may carry), and at once when a batch in it carries a turn_end: the turn's completion is handled only once its
// events are stored (Rpc.after_seq), so a window would hold the turn up. At most CallsPerBackend calls are out at once
// to each backend, so the calls out grow with the apiservers LINK_INTERNAL_API_URLS names; a call goes to the backend
// with the fewest out, passing over one that could not be dialed a moment ago. Batches collect behind them meanwhile,
// and go when one returns.

// mergeTuning is what merged calls are bound by (LINK_EVENT_MERGE_*, README.md "Configuration").
type mergeTuning struct {
	// Window is how long the first batch of a call waits for others; 0 forwards every batch alone.
	Window time.Duration
	// MaxBatches bounds the sessions one call's transaction holds at once, MaxBytes the events JSON its body carries.
	MaxBatches int
	MaxBytes   int
	// AloneBytes: a batch whose events take this much JSON or more is forwarded alone.
	AloneBytes int
	// CallsPerBackend bounds the merged calls out at once to each backend.
	CallsPerBackend int
}

func defaultMergeTuning() mergeTuning {
	return mergeTuning{Window: 100 * time.Millisecond, MaxBatches: 64, MaxBytes: 2 << 20, AloneBytes: 256 << 10, CallsPerBackend: 4}
}

// mergeMaxWindow bounds LINK_EVENT_MERGE_WINDOW: a batch's acknowledgement is held under a second at p99 (§9), and the
// window is spent before its call even starts.
const mergeMaxWindow = 500 * time.Millisecond

// mergeMaxCallsPerBackend bounds LINK_EVENT_MERGE_CALLS_PER_BACKEND: a merged call holds one of its apiserver's
// database connections for its whole transaction, an apiserver has ten (pg's pool default,
// src/apiserver/src/prisma/prisma-client.ts), and its heartbeats and every other call need the rest.
const mergeMaxCallsPerBackend = 8

// eventMerger collects batches into merged calls.
type eventMerger struct {
	g    *gateway
	tune mergeTuning

	mu      sync.Mutex
	pending []*mergeEntry
	bytes   int
	timer   *time.Timer
	// due: what is pending goes as soon as a call slot is free.
	due bool
	// out is the calls out to each backend, by its place in LINK_INTERNAL_API_URLS; next is where the search for the
	// next call's backend starts, so that backends with as many out take turns.
	out  []int
	next int
}

// mergeEntry is one batch waiting in a merged call.
type mergeEntry struct {
	l       *linkState
	session string
	events  json.RawMessage
	result  chan mergeResult
}

// mergeResult is what became of a batch in a merged call: its own answer, or no answer at all (err), or that it is to
// be forwarded alone.
type mergeResult struct {
	answer *backendAnswer
	err    error
	alone  bool
}

func newEventMerger(g *gateway, tune mergeTuning) *eventMerger {
	return &eventMerger{g: g, tune: tune, out: make([]int, len(g.backends.urls))}
}

// store forwards eb in a merged call and waits for what became of it. merged is false for a batch to be forwarded
// alone; answered is false when its connection ended first.
func (m *eventMerger) store(l *linkState, sessionID string, eb *linkpb.EventBatch) (res mergeResult, merged, answered bool) {
	events, err := json.Marshal(requestEvents(eb))
	if err != nil || len(events) >= m.tune.AloneBytes {
		m.g.metrics.mergeAlone.inc("too_large")
		return mergeResult{}, false, true
	}
	e := &mergeEntry{l: l, session: sessionID, events: events, result: make(chan mergeResult, 1)}
	m.add(e, carriesTurnEnd(eb))
	select {
	case res = <-e.result:
		return res, !res.alone, true
	case <-l.c.ctx.Done():
		return mergeResult{}, false, false
	}
}

// carriesTurnEnd says whether a turn's completion waits for this batch (Rpc.after_seq): it ends a turn.
func carriesTurnEnd(eb *linkpb.EventBatch) bool {
	for _, e := range eb.GetEvents() {
		if e.GetType() == "turn_end" {
			return true
		}
	}
	return false
}

func (m *eventMerger) add(e *mergeEntry, now bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pending = append(m.pending, e)
	m.bytes += len(e.events)
	switch {
	case now:
		m.flushLocked("turn_end")
	case len(m.pending) >= m.tune.MaxBatches:
		m.flushLocked("batches")
	case m.bytes >= m.tune.MaxBytes:
		m.flushLocked("bytes")
	case len(m.pending) == 1 && !m.due:
		m.timer = time.AfterFunc(m.tune.Window, func() {
			m.mu.Lock()
			defer m.mu.Unlock()
			m.flushLocked("window")
		})
	}
}

// flushLocked sends everything pending, in calls of at most MaxBatches and MaxBytes, while call slots are free; what
// is left goes as soon as one is.
func (m *eventMerger) flushLocked(reason string) {
	if m.timer != nil {
		m.timer.Stop()
		m.timer = nil
	}
	for len(m.pending) > 0 {
		backend := m.backendLocked()
		if backend < 0 {
			m.due = true
			return
		}
		n, bytes := 0, 0
		for n < len(m.pending) && n < m.tune.MaxBatches && (n == 0 || bytes+len(m.pending[n].events) <= m.tune.MaxBytes) {
			bytes += len(m.pending[n].events)
			n++
		}
		entries := m.pending[:n:n]
		m.pending = append([]*mergeEntry(nil), m.pending[n:]...)
		m.bytes -= bytes
		m.out[backend]++
		m.g.metrics.mergeFlushes.inc(reason)
		go m.call(entries, backend)
	}
	m.due = false
}

// backendLocked is the backend the next call goes to: of those with a call slot free, the one with the fewest calls
// out; -1 when no slot is free. A backend that could not be dialed a moment ago is passed over, as the pool passes it
// over (pick), unless every one could not: its slots would be taken by calls the pool sends to the others.
func (m *eventMerger) backendLocked() int {
	reachable := false
	for i := range m.out {
		if !m.g.backends.passedOver(i) {
			reachable = true
			break
		}
	}
	best := -1
	for k := range m.out {
		i := (m.next + k) % len(m.out)
		if m.out[i] >= m.tune.CallsPerBackend || (reachable && m.g.backends.passedOver(i)) {
			continue
		}
		if best < 0 || m.out[i] < m.out[best] {
			best = i
		}
	}
	if best >= 0 {
		m.next = (best + 1) % len(m.out)
	}
	return best
}

func (m *eventMerger) callDone(backend int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.out[backend]--
	if m.due {
		m.flushLocked("due")
	}
}

// mergedCall is the body of POST /api/runner/link/events (link-events.ts, LinkEventCall).
type mergedCall struct {
	Connections []mergedConnection `json:"connections"`
	Batches     []mergedBatch      `json:"batches"`
}

// mergedConnection is what every call forwarded for one connection carries (linkState.headers): its link token, and
// the other headers by their lowercase names.
type mergedConnection struct {
	LinkToken string            `json:"linkToken"`
	Headers   map[string]string `json:"headers,omitempty"`
}

// mergedBatch is one batch: the events route's body of it, beside its connection, by index.
type mergedBatch struct {
	Connection int             `json:"connection"`
	SessionID  string          `json:"sessionId"`
	Events     json.RawMessage `json:"events"`
}

// call sends one merged call, to backend first, and hands each batch what became of it.
func (m *eventMerger) call(entries []*mergeEntry, first int) {
	defer m.callDone(first)
	g := m.g
	// A batch whose connection ended has nobody left to acknowledge it: the runner sends it again on its next one.
	live := make([]*mergeEntry, 0, len(entries))
	for _, e := range entries {
		if e.l.c.ctx.Err() == nil {
			live = append(live, e)
		}
	}
	if len(live) == 0 {
		return
	}
	body := mergedCall{}
	connection := map[*linkState]int{}
	for _, e := range live {
		i, ok := connection[e.l]
		if !ok {
			i = len(body.Connections)
			connection[e.l] = i
			body.Connections = append(body.Connections, mergedConnectionOf(e.l))
		}
		body.Batches = append(body.Batches, mergedBatch{Connection: i, SessionID: e.session, Events: e.events})
	}
	data, err := json.Marshal(body)
	if err != nil {
		m.answerAll(live, mergeResult{alone: true}, "alone")
		return
	}
	g.metrics.mergeBatches.observeCount(len(live))
	started := time.Now()
	answer, err := g.backends.doFrom(context.Background(), backendCall{
		kind: "events_merged", method: http.MethodPost, path: "/api/runner/link/events", body: data,
		// Each batch is stored once per seq, so the call is too: one that reached a backend twice stores nothing twice.
		idempotent: true,
	}, first)
	g.metrics.mergeCallDuration.observe(time.Since(started))
	switch {
	case err != nil && errors.Is(err, errAnswerTooLarge):
		m.answerAll(live, mergeResult{alone: true}, "alone")
	case err != nil:
		// No answer: each batch fails as it would have failed alone.
		m.answerAll(live, mergeResult{err: err}, "failed")
	case answer.status/100 != 2:
		// The database turning the call away is each batch's answer, as it would have been alone. Any other refusal,
		// from an apiserver older than the route or one that could not take the call, leaves each batch to go alone.
		if answer.status == http.StatusServiceUnavailable || answer.status == http.StatusTooManyRequests ||
			answer.status == http.StatusRequestTimeout || answer.status == http.StatusBadGateway ||
			answer.status == http.StatusGatewayTimeout {
			m.answerAll(live, mergeResult{answer: answer}, "failed")
			return
		}
		m.answerAll(live, mergeResult{alone: true}, "alone")
	default:
		m.answerEach(live, answer)
	}
}

// answerEach hands each batch its result in the call's answer.
func (m *eventMerger) answerEach(live []*mergeEntry, answer *backendAnswer) {
	met := m.g.metrics
	var read struct {
		Results []json.RawMessage `json:"results"`
		HeldMs  *float64          `json:"heldMs"`
	}
	if json.Unmarshal(answer.body, &read) != nil || len(read.Results) != len(live) {
		m.answerAll(live, mergeResult{alone: true}, "alone")
		return
	}
	met.mergeCalls.inc("answered")
	if read.HeldMs != nil && *read.HeldMs >= 0 {
		met.mergeHeld.observe(time.Duration(*read.HeldMs * float64(time.Millisecond)))
	}
	for i, e := range live {
		var result struct {
			SendAlone bool `json:"sendAlone"`
		}
		if json.Unmarshal(read.Results[i], &result) != nil || result.SendAlone {
			met.mergeAlone.inc("answered_alone")
			e.result <- mergeResult{alone: true}
			continue
		}
		// What the events route answers a batch it stored: 202 and {ok, durableSeq, rejected}.
		e.result <- mergeResult{answer: &backendAnswer{status: http.StatusAccepted, header: http.Header{}, body: read.Results[i]}}
	}
}

func (m *eventMerger) answerAll(live []*mergeEntry, res mergeResult, outcome string) {
	m.g.metrics.mergeCalls.inc(outcome)
	if res.alone {
		m.g.metrics.mergeAlone.add(float64(len(live)), "call")
	}
	for _, e := range live {
		e.result <- res
	}
}

// mergedConnectionOf is what every call forwarded for l carries, as one merged call names it.
func mergedConnectionOf(l *linkState) mergedConnection {
	header := l.headers()
	c := mergedConnection{LinkToken: header.Get(runnerLinkTokenHeader), Headers: map[string]string{}}
	for name, values := range header {
		if strings.EqualFold(name, runnerLinkTokenHeader) || len(values) == 0 {
			continue
		}
		c.Headers[strings.ToLower(name)] = strings.Join(values, ", ")
	}
	return c
}
