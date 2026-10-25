package main

import (
	"encoding/json"
	"sync"
	"time"
	"unicode/utf16"

	"orbit/linkpb"
)

// The runner link's live stream (docs/runner-link-design.md §5.9; task B8): reply and thinking deltas, tool output
// snapshots, background output and task progress, which over HTTPS took a durable seq and were broadcast but never
// stored. Over the link they go in LiveBatch frames, with a live_seq of their own and no acknowledgement:
//
//   - only while somebody watches the session. The gateway says who does: a Hint{watchers} when the count changes,
//     and every HeartbeatAck's HintState whole, where a session not listed has no watchers. A Welcome's HintState is
//     empty, so after a reconnect the stream resumes at the connection's first HeartbeatAck, which B6 asks for as soon
//     as Welcome comes (link_hints.go markAll). A TurnPrefixRequest counts as a watcher until the gateway says
//     otherwise: it comes from a client stream that has just opened.
//   - never ahead of anything else. A live frame is written only when nothing else is being written on the connection
//     (linkConn.trySend), and is dropped, never queued without bound, when it cannot be.
//   - not while the connection's credit holds the session's durable events back (§5.8): the live stream is dropped
//     then.
//   - in order with the durable events that end what it drafts. A client draws deltas into a draft that the durable
//     event closing it (an assistant block, a turn's end, a thinking block, a tool's result) replaces, as over HTTPS,
//     where both came in one batch in seq order. Over the link the live stream is the faster of the two, so a delta
//     emitted before such an event goes at once when it is emitted, and is dropped if it is still unsent once that event
//     is stored; and a delta emitted after it waits until it is stored. Otherwise a client would draw a reply's last
//     words again after its end, or lose a block's first words to the end of the block before it.
//
// The stream also keeps what the session's current turn has streamed so far, by the rules the API's single-replica
// buffer applies (RealtimeService.retainTurnPrefix and supersededPrefixes in src/apiserver/src/realtime/
// realtime.service.ts), and answers a TurnPrefixRequest with it: a client that opens the session mid-turn gets the
// half-sentence before the deltas after it.

const (
	// linkLiveFlushEvery is how long a watched session's live events gather before they go out together.
	linkLiveFlushEvery = 50 * time.Millisecond
	// linkLiveRetryEvery is how soon a live batch that found the connection busy is tried again.
	linkLiveRetryEvery = 20 * time.Millisecond
	// linkLiveMaxEventBytes is the largest live event sent: a larger snapshot is left to the durable event that
	// follows it (§5.10).
	linkLiveMaxEventBytes = 64 << 10
	// linkLiveBatchBytes is the most one LiveBatch carries, and linkLiveQueueBytes the most a session's unsent live
	// events may take; past it the oldest are dropped.
	linkLiveBatchBytes = 128 << 10
	linkLiveQueueBytes = 512 << 10
	// linkTurnPrefixMaxChars is the server's TURN_PREFIX_MAX_CHARS, counted as JavaScript counts a string's length:
	// in UTF-16 code units.
	linkTurnPrefixMaxChars = 64_000
)

// linkLiveStream is one session's live stream and its turn prefix.
type linkLiveStream struct {
	mu sync.Mutex
	// seq is the live_seq of the session's newest live event.
	seq uint64
	// watched is whether somebody watches the session live, as the gateway last said.
	watched bool
	// queue holds the live events not sent yet, oldest first; since is when the oldest of them was queued, and
	// retryAt when a batch that found the connection busy goes again.
	queue      []*linkQueuedLive
	queueBytes int
	since      time.Time
	retryAt    time.Time
	// The newest durable event that ends a reply draft, and a thinking draft: a delta of that kind emitted after it
	// waits until it is stored.
	holdText, holdThinking uint64

	// The turn prefix: the reply text and the thinking streamed since the last boundary, each with its length in UTF-16
	// units and given up (gone) once that passes linkTurnPrefixMaxChars, until the next boundary; the turn they belong
	// to; the live_seq of the last delta folded in. Folding a delta in costs what the delta is long, however long the
	// prefix: it happens under the session's buffer lock, for every delta, in HTTP mode too.
	turn           string
	text, thinking linkTurnPrefixPart
	through        uint64
}

// linkTurnPrefixPart is the reply text or the thinking of a turn prefix.
type linkTurnPrefixPart struct {
	b    []byte
	n    int // UTF-16 units
	gone bool
}

// add folds a delta in, or gives the part up once it would pass linkTurnPrefixMaxChars.
func (p *linkTurnPrefixPart) add(chunk string) {
	if p.gone {
		return
	}
	if n := linkUTF16Len(chunk); p.n+n <= linkTurnPrefixMaxChars {
		p.b, p.n = append(p.b, chunk...), p.n+n
		return
	}
	*p = linkTurnPrefixPart{gone: true}
}

func (p *linkTurnPrefixPart) String() string { return string(p.b) }

// emitted takes an event as its session emits it, in emission order, under the session's buffer lock, and says what
// becomes of it, with the payload it goes with: in link mode, by linkEventFateOf, and otherwise durable as over HTTPS.
// Every event is read for the turn prefix, whatever the mode, so a TurnPrefixRequest that comes just after the link
// came into use still finds the turn whole. A live event is queued for the live stream when it may go.
func (s *linkEventStream) emitted(turnID, eventType string, payload map[string]interface{}, now time.Time, provider string) (linkEventFate, map[string]interface{}) {
	fate := linkDurable
	if s.onLink() {
		fate, payload = linkEventFateOf(eventType, payload, provider)
	}
	l := &s.live
	l.mu.Lock()
	defer l.mu.Unlock()
	if fate == linkLive {
		l.seq++
	}
	l.foldLocked(turnID, eventType, payload)
	if fate == linkLive && l.watched && !s.e.creditBlocked.Load() {
		raw, err := json.Marshal(payload)
		if err == nil && len(raw) <= linkLiveMaxEventBytes {
			if len(l.queue) == 0 {
				l.since = now
				defer s.e.poke()
			}
			q := &linkQueuedLive{ev: &linkpb.LiveEvent{LiveSeq: l.seq, Type: eventType, TsUnixMs: now.UnixMilli(), TurnId: turnID,
				PayloadJson: raw}}
			switch eventType {
			case evTextDelta:
				q.waitFor = l.holdText
			case evThinkingDelta:
				q.waitFor = l.holdThinking
			}
			l.queue = append(l.queue, q)
			l.queueBytes += len(raw)
			l.trimLocked()
		}
	}
	return fate, payload
}

// linkQueuedLive is a live event not sent yet, with where it stands among the session's durable events.
type linkQueuedLive struct {
	ev *linkpb.LiveEvent
	// waitFor is a durable event emitted before it that ends the draft it extends: it goes only once that is stored.
	waitFor uint64
	// endedBy is the first durable event emitted after it that ends the draft it extends, or replaces the snapshot it
	// is: once that is stored, it is stale, and never goes.
	endedBy uint64
}

// trimLocked drops the oldest queued events past linkLiveQueueBytes.
func (l *linkLiveStream) trimLocked() {
	for l.queueBytes > linkLiveQueueBytes && len(l.queue) > 1 {
		l.queueBytes -= len(l.queue[0].ev.GetPayloadJson())
		l.queue = l.queue[1:]
	}
}

// durableNumbered takes a durable event its session just numbered, under the session's buffer lock: one that ends a
// draft has what is queued of that draft sent at once, ahead of it, and holds back what of that kind comes after it.
// A tool's result does the same to the tool's output snapshots.
func (s *linkEventStream) durableNumbered(seq int, eventType string, payload map[string]interface{}) {
	ends := linkSupersededPrefix(eventType, payload)
	if ends == "" && eventType != evToolResult {
		return
	}
	l := &s.live
	l.mu.Lock()
	defer l.mu.Unlock()
	queued := false
	for _, q := range l.queue {
		if q.endedBy != 0 {
			continue
		}
		switch q.ev.GetType() {
		case evTextDelta:
			if ends != "both" {
				continue
			}
		case evThinkingDelta:
			if ends == "" {
				continue
			}
		case evToolOutput:
			if eventType != evToolResult {
				continue
			}
		default:
			continue
		}
		q.endedBy, queued = uint64(seq), true
	}
	switch ends {
	case "both":
		l.holdText, l.holdThinking = uint64(seq), uint64(seq)
	case "thinking":
		l.holdThinking = uint64(seq)
	}
	if queued {
		l.since = time.Time{} // ahead of the event that ends them: at once
		s.e.poke()
	}
}

// linkSupersededPrefix is which of the turn prefix an event ends: "both", "thinking", or "" for neither. The server's
// supersededPrefixes.
func linkSupersededPrefix(eventType string, payload map[string]interface{}) string {
	switch eventType {
	case evAssistant, evTurnEnd, evInterrupt, evError:
		return "both"
	case evUser:
		// A steer is delivered into the running turn, which goes on streaming into the same draft.
		if steer, _ := payload["steer"].(bool); steer {
			return ""
		}
		return "both"
	case evThinking:
		return "thinking"
	case evSystem:
		if subtype, _ := payload["subtype"].(string); subtype == "resumed" {
			return "both"
		}
	}
	return ""
}

// foldLocked takes one event into the turn prefix: a delta extends it, a boundary clears what it ends.
func (l *linkLiveStream) foldLocked(turnID, eventType string, payload map[string]interface{}) {
	switch linkSupersededPrefix(eventType, payload) {
	case "both":
		l.text, l.thinking = linkTurnPrefixPart{}, linkTurnPrefixPart{}
		return
	case "thinking":
		l.thinking = linkTurnPrefixPart{}
		return
	}
	var part *linkTurnPrefixPart
	switch eventType {
	case evTextDelta:
		part = &l.text
	case evThinkingDelta:
		part = &l.thinking
	default:
		return
	}
	chunk, _ := payload["text"].(string)
	if chunk == "" || part.gone {
		return
	}
	part.add(chunk)
	l.turn, l.through = turnID, l.seq
}

// linkUTF16Len is a string's length as JavaScript counts it.
func linkUTF16Len(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

// setWatched takes whether somebody watches the session live. Nobody does: what is queued is dropped.
func (l *linkLiveStream) setWatched(watched bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.watched = watched
	if !watched {
		l.queue, l.queueBytes = nil, 0
	}
}

// reconnected drops what was queued for a connection that is gone: it is stale.
func (l *linkLiveStream) reconnected() {
	l.mu.Lock()
	l.queue, l.queueBytes, l.retryAt = nil, 0, time.Time{}
	l.mu.Unlock()
}

// batch is the session's next LiveBatch, when one is due, and else when one will be. stored is how far the session's
// durable events are stored: a queued event that a stored one has ended is dropped, and one that waits for an
// unstored one stops the batch there, so the stream keeps its order.
func (l *linkLiveStream) batch(sessionID string, now time.Time, stored uint64) (*linkpb.Frame, []*linkQueuedLive, time.Time) {
	never := now.Add(linkEventsIdle)
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.watched {
		l.queue, l.queueBytes = nil, 0
	}
	kept := l.queue[:0]
	for _, q := range l.queue {
		if q.endedBy != 0 && q.endedBy <= stored {
			l.queueBytes -= len(q.ev.GetPayloadJson())
			continue
		}
		kept = append(kept, q)
	}
	l.queue = kept
	if len(l.queue) == 0 {
		return nil, nil, never
	}
	urgent := false
	for _, q := range l.queue {
		urgent = urgent || q.endedBy != 0
	}
	due := l.since.Add(linkLiveFlushEvery)
	if urgent {
		due = now
	}
	if l.retryAt.After(due) {
		due = l.retryAt
	}
	if now.Before(due) {
		return nil, nil, due
	}
	var events []*linkpb.LiveEvent
	n, size := 0, 0
	for n < len(l.queue) {
		q := l.queue[n]
		if q.waitFor > stored || (n > 0 && size+len(q.ev.GetPayloadJson()) > linkLiveBatchBytes) {
			break
		}
		events = append(events, q.ev)
		size += len(q.ev.GetPayloadJson())
		n++
	}
	if n == 0 {
		return nil, nil, never // what waits for a durable event goes once its ack wakes the sender
	}
	taken := append([]*linkQueuedLive(nil), l.queue[:n]...)
	l.queue, l.queueBytes = l.queue[n:], l.queueBytes-size
	if len(l.queue) > 0 {
		l.since = now.Add(-linkLiveFlushEvery) // the rest goes at once, as far as it may
	}
	return &linkpb.Frame{Body: &linkpb.Frame_LiveBatch{LiveBatch: &linkpb.LiveBatch{SessionId: sessionID, Events: events}}}, taken, never
}

// putBack returns a batch the connection was too busy to take, ahead of what was queued since. What a durable event
// has ended since is dropped by the next batch.
func (l *linkLiveStream) putBack(events []*linkQueuedLive, now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.watched {
		return
	}
	size := 0
	for _, q := range events {
		size += len(q.ev.GetPayloadJson())
	}
	l.queue = append(append([]*linkQueuedLive(nil), events...), l.queue...)
	l.queueBytes += size
	l.trimLocked()
	l.since, l.retryAt = now.Add(-linkLiveFlushEvery), now.Add(linkLiveRetryEvery)
}

// passLive sends every live batch that is due on conn, and returns when the next one is. While the credit holds
// durable events back, the live stream is dropped.
func (e *linkEvents) passLive(conn *linkWorkConn, now time.Time) time.Time {
	next := now.Add(linkEventsIdle)
	blocked := e.creditBlocked.Load()
	for _, s := range e.snapshot() {
		if blocked {
			s.live.mu.Lock()
			s.live.queue, s.live.queueBytes = nil, 0
			s.live.mu.Unlock()
			continue
		}
		s.mu.Lock()
		stored := s.stored
		s.mu.Unlock()
		frame, taken, due := s.live.batch(s.id, now, stored)
		if frame == nil {
			if due.Before(next) {
				next = due
			}
			continue
		}
		sent, err := conn.trySend(frame)
		if err != nil {
			_ = conn.ws.CloseNow()
			return next
		}
		if !sent {
			s.live.putBack(taken, now)
			if retry := now.Add(linkLiveRetryEvery); retry.Before(next) {
				next = retry
			}
			continue
		}
		if again := now.Add(time.Millisecond); again.Before(next) {
			next = again // more may be queued behind it
		}
	}
	return next
}

// hintState takes the HintState of a Welcome or a HeartbeatAck: who watches which session, whole. A session not listed
// has no watchers. Absent, it says nothing.
func (e *linkEvents) hintState(h *linkpb.HintState) {
	if h == nil {
		return
	}
	watched := map[string]bool{}
	for _, w := range h.GetWatchers() {
		if w.GetWatchers() > 0 {
			watched[decodeSessionID(w.GetSessionId())] = true
		}
	}
	for _, s := range e.snapshot() {
		s.live.setWatched(watched[s.key])
	}
	e.poke()
}

// watchersHint takes a Hint{watchers}: how many watch one session now.
func (e *linkEvents) watchersHint(w *linkpb.WatchersHint) {
	if s := e.stream(w.GetSessionId()); s != nil {
		s.live.setWatched(w.GetWatchers() > 0)
		e.poke()
	}
}

// turnPrefix answers a TurnPrefixRequest: what the session's current turn has streamed so far, and the live_seq of
// the last delta in it, after which the server forwards the live stream. The request comes from a client stream that
// has just opened, so the session counts as watched from now on, until the gateway says otherwise.
func (e *linkEvents) turnPrefix(req *linkpb.TurnPrefixRequest) *linkpb.TurnPrefixResponse {
	resp := &linkpb.TurnPrefixResponse{RequestId: req.GetRequestId(), SessionId: req.GetSessionId()}
	s := e.stream(req.GetSessionId())
	if s == nil {
		return resp
	}
	l := &s.live
	l.mu.Lock()
	defer l.mu.Unlock()
	l.watched = true
	if len(l.text.b) > 0 || len(l.thinking.b) > 0 {
		resp.TurnId, resp.Text, resp.Thinking = l.turn, l.text.String(), l.thinking.String()
	}
	resp.ThroughLiveSeq = l.through
	e.poke()
	return resp
}
