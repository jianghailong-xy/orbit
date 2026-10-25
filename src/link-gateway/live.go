package main

import (
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	"orbit/link-gateway/linkpb"
)

// The live stream (docs/runner-link-design.md §5.9). A runner's LiveBatch (reply and thinking deltas, tool output
// snapshots, background output) is published on NATS, on ses.<sessionId>.live, only while someone watches the session;
// an apiserver instance with a client on the session's stream subscribes there while it has one. A batch for a session
// nobody watches is dropped, and the runner is told so (Hint{watchers: 0}), so that it stops sending.
//
// Who watches comes from the apiserver instances, each counting its own clients: on every change of a count it
// publishes a WatchersHint for the session's runner on rnr.<runnerId>, naming itself in the Orbit-Instance header, and
// it repeats the non-zero ones every 20 s; the heartbeat route's answer carries the answering instance's counts too.
// The gateway sums them per session across instances. A count not repeated within LINK_WATCHERS_TTL (60 s) has lapsed:
// its instance is gone. The runner is told each new sum, as a Hint, and every HeartbeatAck states them all.
//
// A client that opens a session mid-turn is handed what the turn has streamed so far (TurnPrefixRequest): the apiserver
// asks over NATS, on the runner's subject with a reply subject, and the gateway relays the question to the runner's
// connection and its answer back. With no connection in MODE_LINK to ask, it answers at once with nothing, and the
// apiserver keeps today's behaviour.

const (
	liveSubjectPrefix = "ses."
	liveSubjectSuffix = ".live"
	// instanceHeader names the apiserver instance a WatchersHint counts for.
	instanceHeader = "Orbit-Instance"
	// maxWatchedPerRunner bounds the sessions the gateway keeps counts for, per runner.
	maxWatchedPerRunner = 10_000
)

// liveSessionID is how a session is named in a live subject: a UUID, in lower case. Anything else could break the
// subject's shape (a dot, a wildcard), so it is refused.
var liveSessionID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func liveSubject(sessionID string) string { return liveSubjectPrefix + sessionID + liveSubjectSuffix }

// watcherBook is every runner's watched sessions, by apiserver instance.
type watcherBook struct {
	mu      sync.Mutex
	ttl     time.Duration
	now     func() time.Time
	runners map[string]map[string]*sessionWatchers
}

type sessionWatchers struct {
	counts map[string]watcherCount // apiserver instance → its count
	// told is the sum the runner was last told; -1 while it was told nothing.
	told int64
	// quietSince is when the runner was told nobody watches: the entry is kept for a TTL after, so that a live batch
	// sent meanwhile does not tell it again, and then let go.
	quietSince time.Time
}

type watcherCount struct {
	n  uint32
	at time.Time
}

// watcherChange is a session whose sum the runner has not been told yet.
type watcherChange struct {
	session string
	sum     uint32
}

func newWatcherBook(ttl time.Duration) *watcherBook {
	return &watcherBook{ttl: ttl, now: time.Now, runners: map[string]map[string]*sessionWatchers{}}
}

func (b *watcherBook) session(runner, session string, create bool) *sessionWatchers {
	sessions := b.runners[runner]
	if sessions == nil {
		if !create {
			return nil
		}
		sessions = map[string]*sessionWatchers{}
		b.runners[runner] = sessions
	}
	s := sessions[session]
	if s == nil && create && len(sessions) < maxWatchedPerRunner {
		s = &sessionWatchers{counts: map[string]watcherCount{}, told: -1}
		sessions[session] = s
	}
	return s
}

func (s *sessionWatchers) sum(cutoff time.Time) uint32 {
	var n uint32
	for _, c := range s.counts {
		if !c.at.Before(cutoff) {
			n += c.n
		}
	}
	return n
}

// change records what the runner is to be told about s, if its sum moved since it was last told.
func (b *watcherBook) change(runner, session string, s *sessionWatchers, changes []watcherChange) []watcherChange {
	sum := s.sum(b.now().Add(-b.ttl))
	if int64(sum) != s.told {
		s.told = int64(sum)
		changes = append(changes, watcherChange{session: session, sum: sum})
		if sum == 0 {
			s.quietSince = b.now()
		}
	}
	return changes
}

// set takes one instance's count of one session's watchers.
func (b *watcherBook) set(runner, session, instance string, n uint32) []watcherChange {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := b.session(runner, session, n > 0)
	if s == nil {
		return nil
	}
	if n == 0 {
		delete(s.counts, instance)
	} else {
		s.counts[instance] = watcherCount{n: n, at: b.now()}
	}
	return b.change(runner, session, s, nil)
}

// snapshot takes one instance's counts of every session of the runner: a session it does not list has no watcher there.
func (b *watcherBook) snapshot(runner, instance string, counts map[string]uint32) []watcherChange {
	b.mu.Lock()
	defer b.mu.Unlock()
	var changes []watcherChange
	for session, s := range b.runners[runner] {
		if _, listed := counts[session]; !listed {
			if _, had := s.counts[instance]; had {
				delete(s.counts, instance)
				changes = b.change(runner, session, s, changes)
			}
		}
	}
	now := b.now()
	for session, n := range counts {
		s := b.session(runner, session, n > 0)
		if s == nil {
			continue
		}
		if n == 0 {
			delete(s.counts, instance)
		} else {
			s.counts[instance] = watcherCount{n: n, at: now}
		}
		changes = b.change(runner, session, s, changes)
	}
	return changes
}

// sum is how many watch the session now.
func (b *watcherBook) sum(runner, session string) uint32 {
	b.mu.Lock()
	defer b.mu.Unlock()
	if s := b.session(runner, session, false); s != nil {
		return s.sum(b.now().Add(-b.ttl))
	}
	return 0
}

// tellZero reports whether the runner still has to be told that nobody watches the session, and marks it told.
func (b *watcherBook) tellZero(runner, session string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := b.session(runner, session, true)
	if s == nil || s.told == 0 {
		return false
	}
	s.told = 0
	s.quietSince = b.now()
	return true
}

// list is the runner's watched sessions with how many watch each, as HintState states them.
func (b *watcherBook) list(runner string) []*linkpb.WatchersHint {
	b.mu.Lock()
	defer b.mu.Unlock()
	cutoff := b.now().Add(-b.ttl)
	var out []*linkpb.WatchersHint
	for session, s := range b.runners[runner] {
		if n := s.sum(cutoff); n > 0 {
			out = append(out, &linkpb.WatchersHint{SessionId: session, Watchers: n})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].GetSessionId() < out[j].GetSessionId() })
	return out
}

// expire lets lapsed counts go, and returns, by runner, the sessions whose sum that moved.
func (b *watcherBook) expire() map[string][]watcherChange {
	b.mu.Lock()
	defer b.mu.Unlock()
	cutoff := b.now().Add(-b.ttl)
	out := map[string][]watcherChange{}
	for runner, sessions := range b.runners {
		for session, s := range sessions {
			lapsed := false
			for instance, c := range s.counts {
				if c.at.Before(cutoff) {
					delete(s.counts, instance)
					lapsed = true
				}
			}
			if lapsed {
				if changes := b.change(runner, session, s, nil); len(changes) > 0 {
					out[runner] = append(out[runner], changes...)
				}
			}
			// A session nobody has watched for a TTL is let go: it costs nothing to be told about again.
			if len(s.counts) == 0 && s.told <= 0 && s.quietSince.Before(cutoff) {
				delete(sessions, session)
			}
		}
		if len(sessions) == 0 {
			delete(b.runners, runner)
		}
	}
	return out
}

// drop forgets a runner the gateway holds no connection of any more.
func (b *watcherBook) drop(runner string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.runners, runner)
}

// watched is how many sessions have a watcher now, across runners.
func (b *watcherBook) watched() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	cutoff := b.now().Add(-b.ttl)
	n := 0
	for _, sessions := range b.runners {
		for _, s := range sessions {
			if s.sum(cutoff) > 0 {
				n++
			}
		}
	}
	return n
}

// watchersFromHint takes an instance's WatchersHint from NATS and tells the runner the new sum.
func (g *gateway) watchersFromHint(runner, instance string, w *linkpb.WatchersHint) string {
	session := strings.ToLower(w.GetSessionId())
	if !liveSessionID.MatchString(session) {
		return "malformed"
	}
	return g.tellWatchers(runner, g.watchers.set(runner, session, instance, w.GetWatchers()))
}

// watchersFromSnapshot takes the counts a heartbeat answer carried for one instance.
func (g *gateway) watchersFromSnapshot(runner, instance string, counts map[string]uint32) {
	for session := range counts {
		if !liveSessionID.MatchString(session) {
			delete(counts, session)
		}
	}
	g.tellWatchers(runner, g.watchers.snapshot(runner, instance, counts))
}

// tellWatchers sends the runner's MODE_LINK connections each new sum, and says what became of the last one.
func (g *gateway) tellWatchers(runner string, changes []watcherChange) string {
	if len(changes) == 0 {
		return "unchanged"
	}
	result := "no_connection"
	for _, ch := range changes {
		for _, c := range g.reg.connsOf(runner) {
			if c.link == nil {
				if result == "no_connection" {
					result = "mode_http"
				}
				continue
			}
			if c.offer(watchersFrame(ch.session, ch.sum)) {
				result = "sent"
			} else if result != "sent" {
				result = "dropped"
			}
		}
	}
	return result
}

func watchersFrame(session string, n uint32) *linkpb.Frame {
	return &linkpb.Frame{Body: &linkpb.Frame_Hint{Hint: &linkpb.Hint{Kind: &linkpb.Hint_Watchers{
		Watchers: &linkpb.WatchersHint{SessionId: session, Watchers: n},
	}}}}
}

// sweepWatchers lets lapsed counts go every so often, and tells the runners concerned.
func (g *gateway) sweepWatchers(stop <-chan struct{}) {
	t := time.NewTicker(max(g.cfg.link.WatchersTTL/6, 100*time.Millisecond))
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
		}
		for runner, changes := range g.watchers.expire() {
			g.tellWatchers(runner, changes)
		}
	}
}

// onLive publishes a live batch if someone watches its session (§5.9), and drops it otherwise.
func (l *linkState) onLive(lb *linkpb.LiveBatch) {
	c, m := l.c, l.c.g.metrics
	n := float64(len(lb.GetEvents()))
	if n == 0 {
		return
	}
	session := strings.ToLower(lb.GetSessionId())
	if !liveSessionID.MatchString(session) {
		m.liveEvents.add(n, "bad_session")
		return
	}
	runner := c.claims.RunnerID
	if c.g.watchers.sum(runner, session) == 0 {
		m.liveEvents.add(n, "no_watchers")
		if c.g.watchers.tellZero(runner, session) {
			c.offer(watchersFrame(session, 0))
		}
		return
	}
	relay := c.g.hints
	if relay == nil || !relay.nc.IsConnected() {
		m.liveEvents.add(n, "nats_down")
		return
	}
	lb.SessionId = session
	data, err := protojson.Marshal(&linkpb.Frame{Body: &linkpb.Frame_LiveBatch{LiveBatch: lb}})
	if err == nil {
		err = relay.nc.Publish(liveSubject(session), data)
	}
	if err != nil {
		m.liveEvents.add(n, "publish_failed")
		l.logFailure("a live batch was not published", "session", session, "err", err)
		return
	}
	m.liveEvents.add(n, "published")
}

// pendingPrefix is a turn prefix request relayed to the runner and not answered yet.
type pendingPrefix struct {
	requestID, sessionID, reply string
	timer                       *time.Timer
	done                        atomic.Bool
}

// answer publishes the runner's answer, or an empty one, on the request's reply subject, once.
func (p *pendingPrefix) answer(g *gateway, resp *linkpb.TurnPrefixResponse, result string) {
	if !p.done.CompareAndSwap(false, true) {
		return
	}
	if p.timer != nil {
		p.timer.Stop()
	}
	g.metrics.prefixRequests.inc(result)
	if resp == nil {
		resp = &linkpb.TurnPrefixResponse{RequestId: p.requestID, SessionId: p.sessionID}
	}
	if g.hints == nil {
		return
	}
	data, err := protojson.Marshal(&linkpb.Frame{Body: &linkpb.Frame_TurnPrefixResponse{TurnPrefixResponse: resp}})
	if err == nil {
		err = g.hints.nc.Publish(p.reply, data)
	}
	if err != nil {
		g.log.Warn("a turn prefix answer was not published", "session", p.sessionID, "err", err)
	}
}

func (p *pendingPrefix) answerEmpty(g *gateway, result string) { p.answer(g, nil, result) }

// relayPrefixRequest hands a turn prefix request from NATS to the runner: to the connection whose process supervises
// the session, else the newest in MODE_LINK. With none, it is answered at once with nothing.
func (g *gateway) relayPrefixRequest(runner string, req *linkpb.TurnPrefixRequest, reply string) {
	p := &pendingPrefix{requestID: req.GetRequestId(), sessionID: strings.ToLower(req.GetSessionId()), reply: reply}
	if reply == "" || !requestIDPattern.MatchString(p.requestID) || !liveSessionID.MatchString(p.sessionID) {
		g.metrics.prefixRequests.inc("malformed")
		return
	}
	var best *conn
	var bestAt time.Time
	supervising := false
	inHTTP := false
	for _, c := range g.reg.connsOf(runner) {
		if c.link == nil {
			inHTTP = true
			continue
		}
		owns := c.link.supervises(p.sessionID)
		at := c.welcomeTime()
		switch {
		case best == nil, owns && !supervising, owns == supervising && at.After(bestAt):
			best, bestAt, supervising = c, at, owns
		}
	}
	if best == nil {
		result := "no_connection"
		if inHTTP {
			result = "mode_http"
		}
		p.answerEmpty(g, result)
		return
	}
	best.link.askPrefix(p)
}

func (l *linkState) supervises(session string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.sessions[session]
}

// askPrefix sends the runner the request, in the live stream's tier, and waits for its answer up to PrefixTimeout.
func (l *linkState) askPrefix(p *pendingPrefix) {
	g := l.c.g
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		p.answerEmpty(g, "closed")
		return
	}
	old := l.prefixes[p.requestID]
	// Set before p can be found, so whoever answers it reads its timer.
	p.timer = time.AfterFunc(g.cfg.link.PrefixTimeout, func() {
		if l.takePrefix(p.requestID, p) {
			p.answerEmpty(g, "timeout")
		}
	})
	l.prefixes[p.requestID] = p
	l.mu.Unlock()
	if old != nil {
		old.answerEmpty(g, "superseded")
	}
	if !l.c.offerLive(&linkpb.Frame{Body: &linkpb.Frame_TurnPrefixRequest{TurnPrefixRequest: &linkpb.TurnPrefixRequest{
		RequestId: p.requestID, SessionId: p.sessionID,
	}}}) {
		if l.takePrefix(p.requestID, p) {
			p.answerEmpty(g, "dropped")
		}
	}
}

// takePrefix removes p from the waiting requests, if it is still there.
func (l *linkState) takePrefix(id string, p *pendingPrefix) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.prefixes[id] != p {
		return false
	}
	delete(l.prefixes, id)
	return true
}

// onPrefixAnswer relays the runner's TurnPrefixResponse to whoever asked.
func (l *linkState) onPrefixAnswer(resp *linkpb.TurnPrefixResponse) {
	l.mu.Lock()
	p := l.prefixes[resp.GetRequestId()]
	delete(l.prefixes, resp.GetRequestId())
	l.mu.Unlock()
	if p == nil {
		l.c.g.metrics.prefixRequests.inc("unknown_answer")
		return
	}
	p.answer(l.c.g, resp, "answered")
}
