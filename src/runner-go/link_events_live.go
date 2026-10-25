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
	queue      []*linkpb.LiveEvent
	queueBytes int
	since      time.Time
	retryAt    time.Time

	// The turn prefix: the reply text and the thinking streamed since the last boundary, each given up (gone) once it
	// passes linkTurnPrefixMaxChars, until the next boundary; the turn they belong to; the live_seq of the last delta
	// folded in.
	turn                string
	text, thinking      string
	textGone, thinkGone bool
	through             uint64
}

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
			l.queue = append(l.queue, &linkpb.LiveEvent{LiveSeq: l.seq, Type: eventType, TsUnixMs: now.UnixMilli(), TurnId: turnID, PayloadJson: raw})
			l.queueBytes += len(raw)
			for l.queueBytes > linkLiveQueueBytes && len(l.queue) > 1 {
				l.queueBytes -= len(l.queue[0].GetPayloadJson())
				l.queue = l.queue[1:]
			}
		}
	}
	return fate, payload
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
		l.text, l.textGone, l.thinking, l.thinkGone = "", false, "", false
		return
	case "thinking":
		l.thinking, l.thinkGone = "", false
		return
	}
	var held *string
	var gone *bool
	switch eventType {
	case evTextDelta:
		held, gone = &l.text, &l.textGone
	case evThinkingDelta:
		held, gone = &l.thinking, &l.thinkGone
	default:
		return
	}
	chunk, _ := payload["text"].(string)
	if chunk == "" || *gone {
		return
	}
	if linkUTF16Len(*held)+linkUTF16Len(chunk) > linkTurnPrefixMaxChars {
		*held, *gone = "", true
	} else {
		*held += chunk
	}
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

// batch is the session's next LiveBatch, when one is due, and else when one will be.
func (l *linkLiveStream) batch(sessionID string, now time.Time) (*linkpb.Frame, time.Time) {
	never := now.Add(linkEventsIdle)
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.queue) == 0 {
		return nil, never
	}
	if !l.watched {
		l.queue, l.queueBytes = nil, 0
		return nil, never
	}
	due := l.since.Add(linkLiveFlushEvery)
	if l.retryAt.After(due) {
		due = l.retryAt
	}
	if now.Before(due) {
		return nil, due
	}
	n, size := 0, 0
	for n < len(l.queue) && (n == 0 || size+len(l.queue[n].GetPayloadJson()) <= linkLiveBatchBytes) {
		size += len(l.queue[n].GetPayloadJson())
		n++
	}
	events := l.queue[:n:n]
	l.queue, l.queueBytes = l.queue[n:], l.queueBytes-size
	if len(l.queue) > 0 {
		l.since = now.Add(-linkLiveFlushEvery) // the rest goes at once
	}
	return &linkpb.Frame{Body: &linkpb.Frame_LiveBatch{LiveBatch: &linkpb.LiveBatch{SessionId: sessionID, Events: events}}}, never
}

// putBack returns a batch the connection was too busy to take, ahead of what was queued since.
func (l *linkLiveStream) putBack(f *linkpb.Frame, now time.Time) {
	events := f.GetLiveBatch().GetEvents()
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.watched {
		return
	}
	size := 0
	for _, ev := range events {
		size += len(ev.GetPayloadJson())
	}
	l.queue = append(append([]*linkpb.LiveEvent(nil), events...), l.queue...)
	l.queueBytes += size
	for l.queueBytes > linkLiveQueueBytes && len(l.queue) > 1 {
		l.queueBytes -= len(l.queue[0].GetPayloadJson())
		l.queue = l.queue[1:]
	}
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
		frame, due := s.live.batch(s.id, now)
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
			s.live.putBack(frame, now)
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
	if l.text != "" || l.thinking != "" {
		resp.TurnId, resp.Text, resp.Thinking = l.turn, l.text, l.thinking
	}
	resp.ThroughLiveSeq = l.through
	e.poke()
	return resp
}
