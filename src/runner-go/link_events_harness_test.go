package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"orbit/linkpb"
)

// The durable and live event streams' doubles: the event ingest behind the fake work gateway (link_work_harness_test.go),
// by the rules the real ones keep.
//
//   - The gateway (src/link-gateway/events.go): a batch whose seqs do not count up by one is refused
//     EVENT_BATCH_MALFORMED; on one connection, a session's batch may not start after the seq that connection has got
//     to (EVENT_SEQ_GAP); what is in flight may not pass the connection's credit (CREDIT_EXCEEDED). A failure answers
//     with how far that connection has stored the session (durable_seq), and sets where the next batch may start.
//   - The ingest (src/apiserver/src/runner-api/link-events.ts): a live-only event is refused EVENT_LIVE_ONLY and a
//     tombstone holds its seq; a noise ping is acknowledged and not stored; each seq is stored once, a batch sent again
//     answered as the first time; durable_seq is the batch's last seq.
//   - The welcome route (B4a): a session's durable_seq is the highest S with every seq 1..S stored, tombstones counting.

// fakeIngest is the control plane's store of every session's events, as the gateway reaches it.
type fakeIngest struct {
	mu       sync.Mutex
	sessions map[string]*fakeIngestSession // by decodeSessionID
	conns    map[*fakeWorkConn]*fakeIngestConn
	// down fails every batch, retryable, the way a database failing over does; refuse fails every batch with that
	// code, not retryable; ackDelay holds each answer back.
	down     bool
	refuse   string
	ackDelay time.Duration
	// refuseBatch, when it returns a failure, answers a batch with it.
	refuseBatch func(eb *linkpb.EventBatch) *linkpb.Failure
	// credit is what each connection's Welcome grants.
	credit linkCredit
	// welcomeSessions has each Welcome say how far each session the Hello names is stored.
	welcomeSessions bool
	batches         []fakeIngestBatch
	live            []fakeLiveEvent
	prefixAnswers   []*linkpb.TurnPrefixResponse
	refusals        []string
}

type fakeIngestSession struct {
	stored     map[uint64]*linkpb.Event
	tombstones map[uint64]string        // seq → code
	pings      map[uint64]*linkpb.Event // acknowledged and not stored
	writes     map[uint64]int           // how many times each seq reached the store
}

// fakeIngestConn is one connection's state of each session, as the gateway keeps it.
type fakeIngestConn struct {
	next, acked map[string]uint64
	unacked     linkCredit
	maxUnacked  linkCredit
}

// fakeIngestBatch is one EventBatch the gateway received, and what became of it.
type fakeIngestBatch struct {
	conn        string
	session     string
	first, last uint64
	n           int
	bytes       uint64
	result      string // stored, or the refusal's code
	at          time.Time
}

// fakeLiveEvent is one live event the gateway received.
type fakeLiveEvent struct {
	conn    string
	session string
	event   *linkpb.LiveEvent
	at      time.Time
}

func newFakeIngest() *fakeIngest {
	return &fakeIngest{sessions: map[string]*fakeIngestSession{}, conns: map[*fakeWorkConn]*fakeIngestConn{},
		credit: linkDefaultCredit, welcomeSessions: true}
}

func (in *fakeIngest) sessionLocked(id string) *fakeIngestSession {
	key := decodeSessionID(id)
	s := in.sessions[key]
	if s == nil {
		s = &fakeIngestSession{stored: map[uint64]*linkpb.Event{}, tombstones: map[uint64]string{}, pings: map[uint64]*linkpb.Event{},
			writes: map[uint64]int{}}
		in.sessions[key] = s
	}
	return s
}

func (in *fakeIngest) connLocked(c *fakeWorkConn) *fakeIngestConn {
	ic := in.conns[c]
	if ic == nil {
		ic = &fakeIngestConn{next: map[string]uint64{}, acked: map[string]uint64{}, maxUnacked: in.credit}
		in.conns[c] = ic
	}
	return ic
}

// preload stores seqs of a session as an earlier era left them: stored, with nothing at the seqs in holes.
func (in *fakeIngest) preload(sessionID string, seqs ...uint64) {
	in.mu.Lock()
	defer in.mu.Unlock()
	s := in.sessionLocked(sessionID)
	for _, seq := range seqs {
		s.stored[seq] = &linkpb.Event{Seq: seq, Type: evAssistant, PayloadJson: []byte(`{"text":"from the HTTPS era"}`)}
	}
}

// durableLocked is the welcome route's durable_seq: every seq through it stored, tombstones counting.
func (s *fakeIngestSession) durableLocked() uint64 {
	var d uint64
	for {
		next := d + 1
		if s.stored[next] == nil && s.tombstones[next] == "" {
			return d
		}
		d = next
	}
}

// welcome adds to a Welcome what the ingest says: the credit, and how far each session the Hello names is stored.
func (in *fakeIngest) welcome(c *fakeWorkConn, w *linkpb.Welcome) {
	in.mu.Lock()
	defer in.mu.Unlock()
	w.Credit = &linkpb.Credit{MaxUnackedEvents: in.credit.events, MaxUnackedBytes: in.credit.bytes}
	in.connLocked(c)
	if !in.welcomeSessions {
		return
	}
	for _, r := range c.hello.GetSessions() {
		w.Sessions = append(w.Sessions, &linkpb.SessionState{SessionId: r.GetSessionId(),
			DurableSeq: in.sessionLocked(r.GetSessionId()).durableLocked(), LeaseHeld: true})
	}
}

func fakeIngestFailure(code string, retryable bool, retryAfterMs uint32) *linkpb.Failure {
	return &linkpb.Failure{Code: code, Message: "from the test", Retryable: retryable, RetryAfterMs: retryAfterMs}
}

// onEventBatch takes a batch as the gateway does, and answers it with its EventAck.
func (g *fakeWorkGateway) onEventBatch(c *fakeWorkConn, eb *linkpb.EventBatch) {
	in := g.ingest
	if in == nil {
		return // a gateway before B8's tests: nothing answers
	}
	in.mu.Lock()
	events := eb.GetEvents()
	key := decodeSessionID(eb.GetSessionId())
	ic := in.connLocked(c)
	rec := fakeIngestBatch{conn: c.id, session: eb.GetSessionId(), n: len(events), at: time.Now()}
	if len(events) > 0 {
		rec.first, rec.last = events[0].GetSeq(), events[len(events)-1].GetSeq()
	}
	for _, e := range events {
		rec.bytes += uint64(len(e.GetPayloadJson()))
	}
	amount := linkCredit{events: uint32(len(events)), bytes: rec.bytes}
	ack := &linkpb.EventAck{SessionId: eb.GetSessionId(), DurableSeq: ic.acked[key]}
	fail := func(f *linkpb.Failure) {
		ack.Failure = f
		rec.result = f.GetCode()
		in.refusals = append(in.refusals, f.GetCode())
		if ic.next[key] == 0 && len(events) > 0 {
			ic.next[key] = events[0].GetSeq()
		}
	}
	gap := ""
	for i, e := range events {
		if e.GetSeq() == 0 || (i > 0 && e.GetSeq() != events[i-1].GetSeq()+1) {
			gap = fmt.Sprintf("seq %d at %d", e.GetSeq(), i)
		}
	}
	switch {
	case len(events) == 0 || gap != "":
		fail(fakeIngestFailure("EVENT_BATCH_MALFORMED", true, 1000))
	case ic.next[key] > 0 && rec.first > ic.next[key]:
		fail(fakeIngestFailure("EVENT_SEQ_GAP", true, 0))
	case !ic.unacked.fits(amount, ic.maxUnacked):
		fail(fakeIngestFailure("CREDIT_EXCEEDED", true, 1000))
	case in.down:
		fail(fakeIngestFailure("DATABASE_UNAVAILABLE", true, 200))
		if ic.acked[key] > 0 {
			ic.next[key] = ic.acked[key] + 1
		}
	case in.refuse != "":
		fail(fakeIngestFailure(in.refuse, false, 0))
	case in.refuseBatch != nil && in.refuseBatch(eb) != nil:
		fail(in.refuseBatch(eb))
	default:
		s := in.sessionLocked(eb.GetSessionId())
		for _, e := range events {
			seq := e.GetSeq()
			s.writes[seq]++
			if s.stored[seq] != nil || s.tombstones[seq] != "" || s.pings[seq] != nil {
				continue // stored once per seq
			}
			var payload map[string]interface{}
			_ = json.Unmarshal(e.GetPayloadJson(), &payload)
			switch {
			case linkLiveOnlyTypes[e.GetType()]:
				s.tombstones[seq] = "EVENT_LIVE_ONLY"
			case linkNoiseSystemEvent(e.GetType(), payload):
				s.pings[seq] = e
			default:
				s.stored[seq] = e
			}
		}
		// A batch sent again is answered as the first time: what its tombstones say.
		for seq := rec.first; seq <= rec.last; seq++ {
			if code := s.tombstones[seq]; code != "" {
				ack.Rejected = append(ack.Rejected, &linkpb.RejectedEvent{Seq: seq, Code: code, Message: "from the test"})
			}
		}
		ack.DurableSeq = max(ic.acked[key], rec.last)
		ic.acked[key] = ack.DurableSeq
		ic.next[key] = rec.last + 1
		rec.result = "stored"
	}
	in.batches = append(in.batches, rec)
	delay := in.ackDelay
	if ack.Failure == nil {
		ic.unacked.events += amount.events
		ic.unacked.bytes += amount.bytes
	}
	in.mu.Unlock()
	answer := func() {
		if ack.Failure == nil {
			in.mu.Lock()
			ic.unacked.events -= amount.events
			ic.unacked.bytes -= amount.bytes
			in.mu.Unlock()
		}
		c.send(&linkpb.Frame{Body: &linkpb.Frame_EventAck{EventAck: ack}})
	}
	if delay > 0 {
		time.AfterFunc(delay, answer)
		return
	}
	answer()
}

// onLiveBatch records a live batch.
func (g *fakeWorkGateway) onLiveBatch(c *fakeWorkConn, lb *linkpb.LiveBatch) {
	if g.ingest == nil {
		return
	}
	g.ingest.mu.Lock()
	defer g.ingest.mu.Unlock()
	for _, e := range lb.GetEvents() {
		g.ingest.live = append(g.ingest.live, fakeLiveEvent{conn: c.id, session: lb.GetSessionId(), event: e, at: time.Now()})
	}
}

// onTurnPrefixAnswer records the runner's answer to a TurnPrefixRequest.
func (g *fakeWorkGateway) onTurnPrefixAnswer(c *fakeWorkConn, resp *linkpb.TurnPrefixResponse) {
	if g.ingest == nil {
		return
	}
	g.ingest.mu.Lock()
	g.ingest.prefixAnswers = append(g.ingest.prefixAnswers, resp)
	g.ingest.mu.Unlock()
}

// setDown and setRefuse change what the ingest answers.
func (in *fakeIngest) setDown(down bool) {
	in.mu.Lock()
	in.down = down
	in.mu.Unlock()
}

// storedSeqs is every seq of the session that holds a row, stored or tombstone, in order; and the writes of each.
func (in *fakeIngest) storedSeqs(sessionID string) (seqs []uint64, tombstones int, pings int) {
	in.mu.Lock()
	defer in.mu.Unlock()
	s := in.sessionLocked(sessionID)
	for seq := range s.stored {
		seqs = append(seqs, seq)
	}
	for seq := range s.tombstones {
		seqs = append(seqs, seq)
	}
	sort.Slice(seqs, func(i, j int) bool { return seqs[i] < seqs[j] })
	return seqs, len(s.tombstones), len(s.pings)
}

// ping is the noise ping the ingest acknowledged at a seq of the session, and stored nowhere.
func (in *fakeIngest) ping(sessionID string, seq uint64) *linkpb.Event {
	in.mu.Lock()
	defer in.mu.Unlock()
	return in.sessionLocked(sessionID).pings[seq]
}

// event is what the ingest stored at a seq of the session.
func (in *fakeIngest) event(sessionID string, seq uint64) *linkpb.Event {
	in.mu.Lock()
	defer in.mu.Unlock()
	return in.sessionLocked(sessionID).stored[seq]
}

func (in *fakeIngest) batchesOf(sessionID string) []fakeIngestBatch {
	in.mu.Lock()
	defer in.mu.Unlock()
	var out []fakeIngestBatch
	for _, b := range in.batches {
		if decodeSessionID(b.session) == decodeSessionID(sessionID) {
			out = append(out, b)
		}
	}
	return out
}

func (in *fakeIngest) liveOf(sessionID string) []fakeLiveEvent {
	in.mu.Lock()
	defer in.mu.Unlock()
	var out []fakeLiveEvent
	for _, e := range in.live {
		if decodeSessionID(e.session) == decodeSessionID(sessionID) {
			out = append(out, e)
		}
	}
	return out
}

func (in *fakeIngest) refusalCodes() []string {
	in.mu.Lock()
	defer in.mu.Unlock()
	return append([]string(nil), in.refusals...)
}

// assertContiguous fails unless the session's rows are exactly seqs from..to, each written to the store at most once
// per delivery that reached it, with no tombstone.
func (in *fakeIngest) assertContiguous(t *testing.T, sessionID string, from, to uint64) {
	t.Helper()
	seqs, tombstones, pings := in.storedSeqs(sessionID)
	var want []uint64
	for seq := from; seq <= to; seq++ {
		want = append(want, seq)
	}
	got := []uint64{}
	for _, seq := range seqs {
		if seq >= from {
			got = append(got, seq)
		}
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		if len(got) > 40 || len(want) > 40 {
			t.Fatalf("session %s holds %d rows from seq %d, want %d through %d (first %v, last %v)", sessionID, len(got), from,
				len(want), to, got[:min(5, len(got))], got[max(len(got)-5, 0):])
		}
		t.Fatalf("session %s holds rows %v, want %v", sessionID, got, want)
	}
	if tombstones != 0 || pings != 0 {
		t.Fatalf("session %s holds %d tombstones and %d unstored pings", sessionID, tombstones, pings)
	}
}

// linkTestRunEvents is n durable events from seq from, with payloads of about payloadBytes.
func linkTestRunEvents(from, n, payloadBytes int) []RunEvent {
	out := make([]RunEvent, n)
	for i := range out {
		out[i] = RunEvent{Seq: from + i, Type: evAssistant, TS: nowISO(), TurnID: "",
			Payload: map[string]interface{}{"text": fmt.Sprintf("event %d %s", from+i, strings.Repeat("x", payloadBytes))}}
	}
	return out
}

// newLinkEventsRig is a work rig whose gateway stores events, with the link in use and its connection up, and an
// ORBIT_HOME of the test's own, where the spool goes.
func newLinkEventsRig(t *testing.T) (*linkWorkRig, *fakeIngest) {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	r := newLinkWorkRig(t)
	in := newFakeIngest()
	r.g.mu.Lock()
	r.g.ingest = in
	r.g.mu.Unlock()
	return r, in
}

// waitLive waits until the gateway has received n live events of the session.
func (in *fakeIngest) waitLive(t *testing.T, sessionID string, n int) []fakeLiveEvent {
	t.Helper()
	var got []fakeLiveEvent
	linkWaitFor(t, 10*time.Second, fmt.Sprintf("%d live events of %s", n, sessionID), func() bool {
		got = in.liveOf(sessionID)
		return len(got) >= n
	})
	return got
}

// superviseClaudeSessionOverLink is superviseClaudeSession (session_pool_self_driven_turn_test.go) on the rig's daemon
// transport, with the link in use: the stub control plane answers the calls the gateway forwards, and those that go
// over HTTPS, while the gateway's ingest stores the session's events.
func superviseClaudeSessionOverLink(t *testing.T, r *linkWorkRig, pool *sessionPool, script ...fakeStep) *supervisedSession {
	t.Helper()
	fake := newFakeClaude(t, script...)
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	job := claudeSpawnJob(t)
	job.Agent.Env = map[string]string{"ANTHROPIC_API_KEY": "test"}
	s := &supervisedSession{t: t, fake: fake, pool: pool, job: job, execDir: t.TempDir()}
	s.queue(RunInboxResponse{TurnID: "turn-1", Kind: "message", Content: "start the build"})
	r.g.mu.Lock()
	r.g.backend = func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
		tun := rpc.GetTunnel()
		req := httptest.NewRequest(tun.GetMethod(), "/api"+tun.GetPath(), bytes.NewReader(tun.GetJsonBody()))
		rec := httptest.NewRecorder()
		s.serve(rec, req)
		return fakeWorkAnswer(rpc, rec.Code, rec.Body.String())
	}
	r.g.mu.Unlock()
	r.cp.mu.Lock()
	r.cp.delegate = s.serve
	r.cp.mu.Unlock()
	r.useLink(t)
	ctx, cancel := context.WithCancel(context.Background())
	live, added := pool.register(job, cancel, true)
	if !added {
		t.Fatal("the session was not registered")
	}
	s.live = live
	done := make(chan struct{})
	go func() {
		defer close(done)
		runInteractiveSession(r.t, job, ctx, context.Background(), s.execDir, nil, pool, live)
		pool.finish(live)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(30 * time.Second):
			t.Error("the supervisor did not return after its session was cancelled")
		}
	})
	return s
}
