package main

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"orbit/link-gateway/linkpb"
)

// The live stream (-live-rate; docs/runner-link-design.md §5.9, §9; task O3). While the gateway says somebody watches
// one of a runner's running sessions, the session streams reply deltas, and they reach the gateway as runner-go sends
// them (src/runner-go/link_events_live.go): gathered for liveFlushEvery after the first one, in one LiveBatch, with no
// acknowledgement, and only while the session is watched. -live-rate is the deltas a second across the fleet, shared
// evenly by the sessions watched at the time: scripts/runner-link/loadgen-watch.mjs decides which sessions are watched,
// and -live-rate how many deltas there are.
//
// Who watches is read as runner-go reads it: a Hint{watchers} for one session; the HintState of a Welcome or a
// HeartbeatAck, whole, where a session not listed has no watchers; and a TurnPrefixRequest, which comes from a stream
// that has just opened. A session that stops being watched drops what it gathered.
//
// Each delta's text starts with when it was produced, `@@<unix ms>@@`, so that a watcher can tell how late each one
// reached it, and how many did, from the text alone: the SSE stream merges the deltas of each 50 ms
// (src/apiserver/src/sessions/coalesce-deltas.ts) and gives a delta no timestamp.
//
// The deltas draw on a random source of their own (runner.liveRng), so a run's durable events and heartbeats are drawn
// as they are without them. At the default -live-rate of 0 none of this runs: no LiveBatch is sent, nothing is counted,
// and the summary's live fields, all omitted when zero, are left out. A TurnPrefixRequest is answered either way.

const (
	// liveFlushEvery is runner-go's linkLiveFlushEvery: how long a watched session's deltas gather before they go.
	liveFlushEvery = 50 * time.Millisecond
	// liveTextMin and liveTextMax bound a delta's text, its timestamp included: about 100 bytes a delta with its JSON,
	// as design §9 counts them.
	liveTextMin, liveTextMax = 70, 95
	// liveCatchUp is how far behind a watched session's next delta may fall (a connection down, a slow loop) before the
	// session starts again from now rather than sending the deltas it missed at once.
	liveCatchUp = time.Second
	// liveSeedSalt sets the live stream's random source apart from the runner's own.
	liveSeedSalt = 0x6c697665 // "live"
)

// live is whether this run streams deltas.
func (g *loadgen) live() bool { return g.o.liveRate > 0 }

// activeSession is the runner's running session with this id, however its case is written.
func (r *runner) activeSession(id string) *session {
	if s := r.byID[id]; s != nil {
		return s
	}
	for _, s := range r.active {
		if strings.EqualFold(s.id, id) {
			return s
		}
	}
	return nil
}

// setWatched records whether somebody watches the session live.
func (r *runner) setWatched(s *session, watched bool, now time.Time) {
	if s == nil || !r.g.live() || s.watched == watched {
		return
	}
	s.watched = watched
	if watched {
		r.g.watched.Add(1)
		s.liveNextAt = now.Add(r.liveInterArrival())
		return
	}
	r.g.watched.Add(-1)
	r.dropLive(s)
}

// dropLive lets go of what the session gathered and has not sent.
func (r *runner) dropLive(s *session) {
	if n := len(s.liveQueue); n > 0 {
		r.g.stats.with(func(w *window) { w.LiveEventsDropped += int64(n) })
	}
	s.liveQueue, s.liveFlushAt = nil, time.Time{}
}

// hintState takes a Welcome's or a HeartbeatAck's HintState: who watches which session, whole. Absent, it says nothing.
func (r *runner) hintState(h *linkpb.HintState, now time.Time) {
	if h == nil || !r.g.live() {
		return
	}
	watched := map[string]bool{}
	for _, w := range h.GetWatchers() {
		if w.GetWatchers() > 0 {
			watched[strings.ToLower(w.GetSessionId())] = true
		}
	}
	for _, s := range r.active {
		r.setWatched(s, watched[strings.ToLower(s.id)], now)
	}
}

// answerPrefix answers a TurnPrefixRequest: what the session's turn has streamed so far, which these deltas, not a
// reply's text, leave empty, and the live_seq after which the server forwards the stream. As in runner-go, the session
// counts as watched from now on: the request comes from a stream that has just opened.
func (r *runner) answerPrefix(c *rconn, req *linkpb.TurnPrefixRequest, now time.Time) {
	resp := &linkpb.TurnPrefixResponse{RequestId: req.GetRequestId(), SessionId: req.GetSessionId()}
	if s := r.activeSession(req.GetSessionId()); s != nil {
		resp.ThroughLiveSeq = s.liveSeq
		if c == r.cur {
			r.setWatched(s, true, now)
		}
	}
	if err := c.send(&linkpb.Frame{Body: &linkpb.Frame_TurnPrefixResponse{TurnPrefixResponse: resp}}); err != nil {
		r.g.note("turn_prefix_send_failed")
		return
	}
	r.g.stats.with(func(w *window) { w.TurnPrefixAnswers++ })
}

// liveInterArrival is the gap before a watched session's next delta: -live-rate shared by the sessions watched now.
func (r *runner) liveInterArrival() time.Duration {
	rate := r.g.o.liveRate
	if rate <= 0 {
		return time.Hour
	}
	perSession := rate / float64(max(r.g.watched.Load(), 1))
	return time.Duration(r.liveRng.ExpFloat64() / perSession * float64(time.Second))
}

// tickLive sends what has gathered long enough on the runner's watched sessions, then produces the deltas that are
// due: a delta produced late, after its gathering closed, starts the next one. Deltas are produced only while a
// connection is up: runner-go drops what it cannot send.
func (r *runner) tickLive(now time.Time, generating bool) {
	if !r.g.live() || r.cur == nil {
		return
	}
	for _, s := range r.active {
		if !s.watched {
			continue
		}
		if len(s.liveQueue) > 0 && !now.Before(s.liveFlushAt) {
			r.flushLive(s)
		}
		if generating && s.started {
			if now.Sub(s.liveNextAt) > liveCatchUp {
				s.liveNextAt = now
			}
			for !now.Before(s.liveNextAt) {
				r.produceLive(s, s.liveNextAt)
			}
		}
	}
}

// liveDeadline is the earliest moment tickLive has something to do, or zero.
func (r *runner) liveDeadline(generating bool) time.Time {
	var next time.Time
	if !r.g.live() || r.cur == nil {
		return next
	}
	take := func(t time.Time) {
		if !t.IsZero() && (next.IsZero() || t.Before(next)) {
			next = t
		}
	}
	for _, s := range r.active {
		if !s.watched {
			continue
		}
		if generating && s.started {
			take(s.liveNextAt)
		}
		if len(s.liveQueue) > 0 {
			take(s.liveFlushAt)
		}
	}
	return next
}

// produceLive adds a delta to what the session gathered; the first of a gathering sets when they go.
func (r *runner) produceLive(s *session, at time.Time) {
	s.liveSeq++
	ms := strconv.FormatInt(at.UnixMilli(), 10)
	stamp := "@@" + ms + "@@ "
	payload, err := json.Marshal(map[string]string{"text": stamp + text(r.liveRng, between(r.liveRng, liveTextMin, liveTextMax)-len(stamp))})
	if err != nil {
		panic(err)
	}
	s.liveQueue = append(s.liveQueue, &linkpb.LiveEvent{LiveSeq: s.liveSeq, Type: "text_delta", TsUnixMs: at.UnixMilli(), TurnId: s.turn, PayloadJson: payload})
	if len(s.liveQueue) == 1 {
		s.liveFlushAt = at.Add(liveFlushEvery)
	}
	s.liveNextAt = at.Add(r.liveInterArrival())
	r.g.stats.with(func(w *window) { w.LiveEventsProduced++ })
}

// flushLive sends what the session gathered as one LiveBatch. Nothing acknowledges it, and a batch the connection
// cannot take is dropped, as runner-go drops it.
func (r *runner) flushLive(s *session) {
	events := s.liveQueue
	s.liveQueue, s.liveFlushAt = nil, time.Time{}
	err := r.cur.send(&linkpb.Frame{Body: &linkpb.Frame_LiveBatch{LiveBatch: &linkpb.LiveBatch{SessionId: s.id, Events: events}}})
	r.g.stats.with(func(w *window) {
		if err != nil {
			w.LiveEventsDropped += int64(len(events))
			return
		}
		w.LiveBatchesSent++
		w.LiveEventsSent += int64(len(events))
	})
}
