package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

// One simulated runner, as a runner in link mode behaves (src/runner-go/link_client.go, link_heartbeat.go; B8 for the
// event stream): one connection at a time, opened with a link token it trades its runner token for, and replaced
// make-before-break before the token expires; a heartbeat every Welcome interval, its parts whole only on a
// connection's first beat; and, for each of its active sessions, durable events sent in batches and kept until an
// EventAck covers them.
//
// Everything a runner does happens on its own goroutine (run). A connection's reader and a dial run beside it and hand
// it what they got over channels.

const (
	dialTimeout    = 15 * time.Second
	welcomeTimeout = 10 * time.Second
	writeTimeout   = 10 * time.Second
	// ackLate is how long a heartbeat or an event batch may wait for its acknowledgement before it counts as an error.
	ackLate = 30 * time.Second
	// quiesceFor bounds how long a renewal waits for the connection's batches and beat to be acknowledged before it
	// opens the next connection anyway.
	quiesceFor = 5 * time.Second
	// retiredGrace is how long a replaced connection may stay open before the runner closes it itself.
	retiredGrace = 10 * time.Second
	// readLimit is the largest message read: a frame is at most 256 KiB, its pieces joined are not taken here.
	readLimit = 1 << 20
)

// session is one active session's durable stream.
type session struct {
	id       string
	seq      uint64 // the last seq produced
	durable  uint64 // the last seq an EventAck covered
	pending  []*pev // produced and not sent, or sent and to be sent again; in seq order
	inflight []*sentBatch
	// nextEventAt is when the session produces its next event; flushAt when its pending events are sent unless a
	// boundary event sends them first; resendAfter holds sending back after a failure.
	nextEventAt, flushAt, resendAfter time.Time
	started                           bool
	step                              int
	turn, toolUse                     string
}

// pev is a produced event and when it was first sent: its acknowledgement latency is counted from there, however many
// times it is sent.
type pev struct {
	ev   *linkpb.Event
	sent time.Time
}

type sentBatch struct {
	events []*pev
	conn   *rconn
	sentAt time.Time
	late   bool
}

func (b *sentBatch) last() uint64 { return b.events[len(b.events)-1].ev.GetSeq() }

// rconn is one connection.
type rconn struct {
	ws      *websocket.Conn
	id      string
	welcome *linkpb.Welcome
	frames  chan *linkpb.Frame
	done    chan struct{}
	quit    chan struct{}
	once    sync.Once
	err     error         // why reading ended; read after done
	closed  *linkpb.Close // the Close the gateway sent, if any; read after done
	wmu     sync.Mutex
	outID   uint64
	retired bool      // replaced by the next connection: what ends it is expected
	retire  time.Time // when the runner closes it itself, if the gateway has not
	opened  time.Time
}

func (c *rconn) send(f *linkpb.Frame) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	c.outID++
	f.Id = c.outID
	b, err := proto.Marshal(f)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	return c.ws.Write(ctx, websocket.MessageBinary, b)
}

func (c *rconn) read() {
	defer close(c.done)
	for {
		_, data, err := c.ws.Read(context.Background())
		if err != nil {
			c.err = err
			return
		}
		f := &linkpb.Frame{}
		if err := proto.Unmarshal(data, f); err != nil {
			c.err = fmt.Errorf("a frame does not decode: %w", err)
			_ = c.ws.CloseNow()
			return
		}
		if cl := f.GetClose(); cl != nil {
			c.closed = cl
		}
		select {
		case c.frames <- f:
		case <-c.quit:
			return
		}
	}
}

func (c *rconn) close() {
	c.once.Do(func() {
		close(c.quit)
		go func() { _ = c.ws.Close(websocket.StatusNormalClosure, "") }()
	})
}

// closeWait closes the connection and waits, for up to timeout, until it has closed: the close handshake done, its
// reader gone. A process that exits with handshakes still out leaves the gateway connections it reads as lost.
func (c *rconn) closeWait(timeout time.Duration) {
	c.close()
	select {
	case <-c.done:
	case <-time.After(timeout):
		_ = c.ws.CloseNow()
	}
}

type dialResult struct {
	c        *rconn
	err      error
	kind     string        // the error kind, when err is set
	retry    time.Duration // the refusal's Retry-After, when it gave one
	renewal  bool
	token    string
	tokenExp time.Time
	linkURL  string
}

type runner struct {
	g          *loadgen
	n          int
	id         string
	runnerTok  string
	process    string
	sessionIDs []string
	active     []*session
	byID       map[string]*session
	facts      []*linkpb.Fact
	digests    []*linkpb.Fact
	rng        *rand.Rand
	// vol moves the parts that move in production (-volatile, volatile.go); sent is each part's digest as this
	// connection last carried it whole, for a runner whose parts move.
	vol  *volatile
	sent map[string]string

	token    string
	tokenExp time.Time
	linkURL  string

	cur, old      *rconn
	conns         chan dialResult
	dialing       bool
	dialAt        time.Time
	attempt       int
	connectedOnce bool
	renewAt       time.Time
	firstRenewal  bool
	quiescing     bool
	quiesceUntil  time.Time
	// supersededEarly: the renewal's new connection was welcomed and the gateway closed the old one before the loop
	// took the dial's result. The connection that result brings is the renewal.
	supersededEarly bool
	phased          bool
	beatLate        bool // the beat out has been counted as late
	nextBeat        time.Time
	beatOut         time.Time
	beatWhole       bool
	beatInterval    time.Duration
	nextLateCheck   time.Time
}

func newRunner(g *loadgen, n int, fr fleetRunner) *runner {
	r := &runner{
		g: g, n: n, id: fr.Runner, runnerTok: fr.Token, process: fr.Process, sessionIDs: fr.Sessions,
		byID: map[string]*session{}, facts: runnerFacts(n),
		rng:   rand.New(rand.NewPCG(g.seed, uint64(n))),
		conns: make(chan dialResult, 1), firstRenewal: true,
	}
	r.digests = digestsOf(r.facts)
	for _, a := range fr.Active {
		s := &session{id: a.ID, seq: a.Seq, durable: a.Seq}
		r.active = append(r.active, s)
		r.byID[a.ID] = s
	}
	if g.o.volatile {
		r.vol = newVolatile(r.rng, time.Now(), len(r.active) > 0)
	}
	return r
}

// run is the runner's life: connected until stop closes, then on until its events are acknowledged or the drain
// timeout passes.
func (r *runner) run(ctx context.Context, stop <-chan struct{}) {
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()
	defer r.closeAll()
	r.dialAt = time.Now()
	generating := true
	stopC := stop
	var stopBy time.Time
	for {
		now := time.Now()
		r.tick(ctx, now, generating)
		if !generating && (r.drained() || !now.Before(stopBy)) {
			return
		}
		next := r.nextDeadline(now, generating)
		if !generating && stopBy.Before(next) {
			next = stopBy
		}
		timer.Reset(max(next.Sub(now), time.Millisecond))
		select {
		case <-ctx.Done():
			return
		case <-stopC:
			stopC = nil
			generating = false
			stopBy = now.Add(r.g.o.drainTimeout)
			for _, s := range r.active {
				s.flushAt = now
			}
		case <-timer.C:
		case d := <-r.conns:
			r.onDial(ctx, d, time.Now())
		case f := <-r.framesOf(r.cur):
			r.onFrame(r.cur, f, time.Now())
		case <-r.doneOf(r.cur):
			r.onEnd(r.cur, time.Now())
		case f := <-r.framesOf(r.old):
			r.onFrame(r.old, f, time.Now())
		case <-r.doneOf(r.old):
			r.onEnd(r.old, time.Now())
		}
	}
}

func (r *runner) framesOf(c *rconn) <-chan *linkpb.Frame {
	if c == nil {
		return nil
	}
	return c.frames
}

func (r *runner) doneOf(c *rconn) <-chan struct{} {
	if c == nil {
		return nil
	}
	return c.done
}

// drained: nothing produced is left unacknowledged, and no heartbeat is out.
func (r *runner) drained() bool {
	if !r.beatOut.IsZero() {
		return false
	}
	for _, s := range r.active {
		if len(s.pending) > 0 || len(s.inflight) > 0 {
			return false
		}
	}
	return true
}

func (r *runner) closeAll() {
	for _, c := range []*rconn{r.cur, r.old} {
		if c != nil {
			c.closeWait(6 * time.Second)
		}
	}
	if r.cur != nil {
		r.g.stats.setConnected(-1)
		r.cur = nil
	}
}

// tick does whatever is due.
func (r *runner) tick(ctx context.Context, now time.Time, generating bool) {
	g := r.g
	// Dialing: the first connection, a lost one's replacement, or a renewal once the connection's batches are in.
	if !r.dialing {
		switch {
		case r.cur == nil && !now.Before(r.dialAt):
			r.dial(ctx, false)
		case generating && r.cur != nil && !r.quiescing && !r.renewAt.IsZero() && !now.Before(r.renewAt):
			r.quiescing = true
			r.quiesceUntil = now.Add(quiesceFor)
		}
		// The next connection is opened once nothing of this one is out (its batches and its beat are answered), so
		// the gateway's closing it cuts no call short.
		if r.quiescing && r.cur != nil && ((!r.inflightOn(r.cur) && r.beatOut.IsZero()) || !now.Before(r.quiesceUntil)) {
			r.dial(ctx, true)
		}
	}
	if r.old != nil && !r.old.retire.IsZero() && !now.Before(r.old.retire) {
		r.old.close()
		r.old.retire = time.Time{}
	}
	// Heartbeats. A runner sends its next beat once the last one is answered (src/runner-go/link_heartbeat.go waits for
	// the HeartbeatAck), so a late answer delays the next beat rather than doubling up.
	if r.cur != nil && !r.beatOut.IsZero() && !r.beatLate && now.Sub(r.beatOut) > ackLate {
		r.beatLate = true
		g.stats.fail("heartbeat_ack_late", fmt.Sprintf("runner %s conn %s: no HeartbeatAck %s after a beat", r.id, r.cur.id, now.Sub(r.beatOut).Round(time.Millisecond)))
	}
	if generating && r.cur != nil && r.beatOut.IsZero() && !now.Before(r.nextBeat) {
		r.beat(now)
	}
	// Events.
	if generating {
		for _, s := range r.active {
			if !s.started {
				continue
			}
			for !now.Before(s.nextEventAt) {
				r.produce(s, s.nextEventAt)
			}
		}
	}
	if r.cur != nil && !r.quiescing {
		for _, s := range r.active {
			if len(s.pending) > 0 && !now.Before(s.flushAt) && !now.Before(s.resendAfter) && !r.heldByRetired(s) {
				r.flush(s, now)
			}
		}
	}
	// Acknowledgements that are late.
	if !now.Before(r.nextLateCheck) {
		r.nextLateCheck = now.Add(time.Second)
		for _, s := range r.active {
			for _, b := range s.inflight {
				if !b.late && now.Sub(b.sentAt) > ackLate {
					b.late = true
					g.stats.fail("event_ack_late", fmt.Sprintf("runner %s session %s: seqs %d-%d unacknowledged %s after they were sent",
						r.id, s.id, b.events[0].ev.GetSeq(), b.last(), now.Sub(b.sentAt).Round(time.Millisecond)))
				}
			}
		}
	}
}

func (r *runner) nextDeadline(now time.Time, generating bool) time.Time {
	next := now.Add(time.Minute)
	take := func(t time.Time) {
		if !t.IsZero() && t.Before(next) {
			next = t
		}
	}
	if !r.dialing {
		if r.cur == nil {
			take(r.dialAt)
		} else if !r.quiescing {
			take(r.renewAt)
		} else {
			take(r.quiesceUntil)
		}
	}
	if r.old != nil {
		take(r.old.retire)
	}
	if r.cur != nil {
		if r.beatOut.IsZero() {
			take(r.nextBeat)
		} else if !r.beatLate {
			take(r.beatOut.Add(ackLate + time.Millisecond))
		}
	}
	inflight := false
	for _, s := range r.active {
		if generating && s.started {
			take(s.nextEventAt)
		}
		if len(s.pending) > 0 && r.cur != nil && !r.quiescing {
			take(maxTime(s.flushAt, s.resendAfter))
		}
		inflight = inflight || len(s.inflight) > 0
	}
	if inflight {
		take(r.nextLateCheck)
	}
	return next
}

func maxTime(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

func (r *runner) inflightOn(c *rconn) bool {
	for _, s := range r.active {
		for _, b := range s.inflight {
			if b.conn == c {
				return true
			}
		}
	}
	return false
}

// heldByRetired: the session has batches out on a connection being replaced. Nothing more is sent for it until they
// are acknowledged or that connection ends and they are sent again, so its events are stored in seq order.
func (r *runner) heldByRetired(s *session) bool {
	for _, b := range s.inflight {
		if b.conn != r.cur {
			return true
		}
	}
	return false
}

// dial opens a connection beside the runner's loop, which onDial hands it to.
func (r *runner) dial(ctx context.Context, renewal bool) {
	r.dialing = true
	first := !r.connectedOnce
	token, exp, linkURL := r.token, r.tokenExp, r.linkURL
	h := r.hello()
	go func() {
		d := r.open(ctx, first, renewal, token, exp, linkURL, h)
		select {
		case r.conns <- d:
		case <-ctx.Done():
			if d.c != nil {
				d.c.close()
			}
		}
	}()
}

// hello is the runner's Hello: the process's terms, and where each session it supervises stands (Hello.sessions,
// src/runner-go/link_mode.go resumeStates): the last seq it assigned in each and the turn it runs there.
func (r *runner) hello() *linkpb.Hello {
	h := hello(r.process)
	for _, id := range r.sessionIDs {
		resume := &linkpb.SessionResume{SessionId: id}
		if s := r.byID[id]; s != nil {
			resume.LastSeq, resume.TurnId = s.seq, s.turn
		}
		h.Sessions = append(h.Sessions, resume)
	}
	sort.Slice(h.Sessions, func(i, j int) bool { return h.Sessions[i].GetSessionId() < h.Sessions[j].GetSessionId() })
	return h
}

// open trades the runner token for a link token when the one in hand will not do, dials, says Hello and waits for
// Welcome. It runs on its own goroutine: it reads only what dial passed it.
func (r *runner) open(ctx context.Context, first, renewal bool, token string, exp time.Time, linkURL string, h *linkpb.Hello) dialResult {
	g := r.g
	d := dialResult{renewal: renewal, token: token, tokenExp: exp, linkURL: linkURL}
	if first {
		select {
		case <-g.ramp:
		case <-ctx.Done():
			d.err, d.kind = ctx.Err(), "cancelled"
			return d
		}
	}
	if renewal || token == "" || time.Until(exp) < 10*time.Minute {
		started := time.Now()
		tok, err := g.mintToken(ctx, r.runnerTok, r.process)
		if err != nil {
			d.err, d.kind = err, "token_mint_failed"
			return d
		}
		g.stats.with(func(w *window) { w.TokensMinted++; w.tokenMs.add(time.Since(started), 1) })
		d.token, d.tokenExp, d.linkURL = tok.Token, tok.expires, tok.LinkURL
		if g.o.linkURL != "" {
			d.linkURL = g.o.linkURL
		}
	}
	started := time.Now()
	dctx, cancel := context.WithTimeout(ctx, dialTimeout)
	ws, resp, err := websocket.Dial(dctx, d.linkURL, &websocket.DialOptions{
		HTTPClient: g.dialClient,
		HTTPHeader: http.Header{"Authorization": {"Bearer " + d.token}},
	})
	cancel()
	if err != nil {
		if resp != nil {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
			var refusal struct {
				Code string `json:"code"`
			}
			_ = json.Unmarshal(body, &refusal)
			d.err, d.kind = fmt.Errorf("upgrade refused: %d %s", resp.StatusCode, refusal.Code), "upgrade_refused_"+strconv.Itoa(resp.StatusCode)
			if s, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil {
				d.retry = time.Duration(s) * time.Second
			}
			if resp.StatusCode == http.StatusUnauthorized {
				d.token = ""
			}
			return d
		}
		d.err, d.kind = err, "dial_failed"
		return d
	}
	ws.SetReadLimit(readLimit)
	c := &rconn{ws: ws, frames: make(chan *linkpb.Frame, 256), done: make(chan struct{}), quit: make(chan struct{}), opened: started}
	if err := c.send(&linkpb.Frame{Body: &linkpb.Frame_Hello{Hello: h}}); err != nil {
		_ = ws.CloseNow()
		d.err, d.kind = err, "hello_failed"
		return d
	}
	go c.read()
	timer := time.NewTimer(welcomeTimeout)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			c.close()
			d.err, d.kind = ctx.Err(), "cancelled"
			return d
		case <-timer.C:
			c.close()
			d.err, d.kind = errors.New("no Welcome within 10s"), "welcome_timeout"
			return d
		case <-c.done:
			d.err, d.kind = fmt.Errorf("closed before Welcome: %v", c.err), "closed_before_welcome"
			if c.closed != nil {
				d.kind = "closed_before_welcome_" + c.closed.GetCode().String()
				d.retry = time.Duration(c.closed.GetRetryAfterMs()) * time.Millisecond
			}
			return d
		case f := <-c.frames:
			w := f.GetWelcome()
			if w == nil {
				g.stats.fail("frame_before_welcome", fmt.Sprintf("runner %s: %T before Welcome", r.id, f.GetBody()))
				continue
			}
			c.welcome, c.id = w, w.GetConnectionId()
			g.stats.with(func(win *window) { win.dialMs.add(time.Since(started), 1) })
			if w.GetMode() != linkpb.Mode_MODE_LINK {
				c.close()
				d.err, d.kind = fmt.Errorf("the gateway is in %s", w.GetMode()), "welcome_not_mode_link"
				return d
			}
			d.c = c
			return d
		}
	}
}

func (r *runner) onDial(ctx context.Context, d dialResult, now time.Time) {
	g := r.g
	r.dialing = false
	r.token, r.tokenExp, r.linkURL = d.token, d.tokenExp, d.linkURL
	if d.err != nil {
		if ctx.Err() != nil {
			return
		}
		g.stats.fail(d.kind, fmt.Sprintf("runner %s (renewal=%v): %v", r.id, d.renewal, d.err))
		wait := max(backoff(r.rng, r.attempt), d.retry)
		r.attempt++
		if d.renewal && r.cur != nil {
			// The connection in hand keeps working; the next try comes later.
			r.quiescing = false
			r.renewAt = now.Add(wait)
		} else {
			r.dialAt = now.Add(wait)
		}
		return
	}
	c := d.c
	switch {
	case d.renewal && r.cur == nil && r.supersededEarly:
		r.supersededEarly = false
		r.cur = c
		g.stats.with(func(w *window) { w.Renewals++ })
	case d.renewal && r.cur != nil:
		// Make before break: the gateway closes the old connection now that this one is welcomed.
		old := r.cur
		old.retired = true
		old.retire = now.Add(retiredGrace)
		if r.old != nil {
			r.old.close()
		}
		r.old = old
		r.cur = c
		g.stats.with(func(w *window) { w.Renewals++ })
	case r.cur != nil:
		// A dial that raced a renewal; keep the connection in hand.
		c.close()
		return
	default:
		r.cur = c
		g.stats.setConnected(1)
		if r.connectedOnce {
			g.stats.with(func(w *window) { w.Reconnects++ })
		} else {
			g.stats.with(func(w *window) { w.Connects++ })
			g.connectedOnce()
		}
	}
	r.connectedOnce = true
	r.attempt = 0
	r.quiescing = false
	r.renewAt = r.renewalTime(now)
	r.beatInterval = time.Duration(c.welcome.GetHeartbeatIntervalMs()) * time.Millisecond
	if r.beatInterval <= 0 {
		r.beatInterval = 30 * time.Second
	}
	// Where Welcome says each session stands (B4a): events stored that no EventAck covered, on a connection that ended
	// before its answer came, are not sent again; a lease this process no longer holds is an error of the seed or of the
	// server.
	for _, st := range c.welcome.GetSessions() {
		if !st.GetLeaseHeld() {
			g.stats.fail("welcome_lease_not_held", fmt.Sprintf("runner %s conn %s: Welcome says session %s is not this process's", r.id, c.id, st.GetSessionId()))
		}
		s := r.byID[st.GetSessionId()]
		if s == nil {
			continue
		}
		if st.GetDurableSeq() > s.seq {
			g.stats.fail("welcome_durable_ahead", fmt.Sprintf("runner %s conn %s: Welcome says session %s is stored through %d, past the %d produced",
				r.id, c.id, s.id, st.GetDurableSeq(), s.seq))
			continue
		}
		if st.GetDurableSeq() > s.durable {
			g.noteN("events_acknowledged_by_welcome", int64(st.GetDurableSeq()-s.durable))
			r.ackThrough(s, st.GetDurableSeq(), now)
		}
	}
	// A runner beats as soon as it has read Welcome, every part whole: this connection holds none of them yet.
	r.beatOut = time.Time{}
	r.beatWhole = true
	r.nextBeat = now
	for _, s := range r.active {
		if !s.started {
			s.started = true
			s.nextEventAt = now.Add(r.interArrival())
		}
		if len(s.pending) > 0 {
			s.flushAt = now
		}
	}
}

// renewalTime is when the connection just opened is replaced: linkRenewBefore ahead of its token's expiry, as the runner
// does it (src/runner-go/link_client.go renewAt). A fleet that has run for a while holds tokens of every age, so with
// -spread-renewals each runner's first renewal comes at a random point of its token's life instead: renewals arrive
// at the steady rate from the start rather than all at once an hour in.
func (r *runner) renewalTime(now time.Time) time.Time {
	if r.tokenExp.IsZero() {
		return time.Time{}
	}
	life := time.Until(r.tokenExp)
	at := r.tokenExp.Add(-min(r.g.o.renewBefore, life/2))
	if r.firstRenewal && r.g.o.spreadRenewals {
		r.firstRenewal = false
		span := at.Sub(now)
		if span > 0 {
			at = now.Add(time.Duration(r.rng.Float64() * float64(span)))
		}
	}
	return at
}

func (r *runner) interArrival() time.Duration {
	rate := r.g.perSessionRate
	if rate <= 0 {
		return time.Hour
	}
	return time.Duration(r.rng.ExpFloat64() / rate * float64(time.Second))
}

func backoff(rng *rand.Rand, n int) time.Duration {
	ceiling := time.Second << min(n, 6)
	ceiling = min(ceiling, time.Minute)
	return time.Duration(rng.Int64N(int64(ceiling))) + time.Millisecond
}

// beat sends the runner's heartbeat on its connection.
func (r *runner) beat(now time.Time) {
	g := r.g
	facts := r.digests
	if r.beatWhole {
		facts = r.facts
	}
	if r.vol != nil {
		facts = r.volatileFacts(now)
	}
	hb := &linkpb.Heartbeat{
		ProcessId: r.process, IdleCapacity: uint32(max(0, 2-len(r.active))), SessionIds: r.sessionIDs,
		SupportedProviders: supportedProviders, Facts: facts,
	}
	r.nextBeat = now.Add(r.beatInterval)
	if !r.phased {
		// A fleet's runners started at every moment, so their beats are spread over the interval; the ramp opens
		// connections in a burst, so each runner's second beat comes at a random point of it, and every interval after.
		r.phased = true
		r.nextBeat = now.Add(time.Duration(r.rng.Float64() * float64(r.beatInterval)))
	}
	if err := r.cur.send(&linkpb.Frame{Body: &linkpb.Frame_Heartbeat{Heartbeat: hb}}); err != nil {
		// A write fails only on a connection that is ending, whose end is what counts (onEnd): the next connection
		// beats at once.
		g.note("heartbeat_send_failed")
		return
	}
	r.beatWhole = false
	r.beatOut = now
	r.beatLate = false
	g.stats.with(func(w *window) { w.HeartbeatsSent++ })
}

// produce adds the session's next event to what it has to send.
func (r *runner) produce(s *session, at time.Time) {
	ev, boundary := s.nextEvent(r.rng, at.UnixMilli())
	s.pending = append(s.pending, &pev{ev: ev})
	if len(s.pending) == 1 {
		s.flushAt = at.Add(r.g.o.flushMin + time.Duration(r.rng.Float64()*float64(r.g.o.flushMax-r.g.o.flushMin)))
	}
	if boundary || len(s.pending) >= r.g.o.maxBatch {
		s.flushAt = at
	}
	s.nextEventAt = at.Add(r.interArrival())
	r.g.stats.with(func(w *window) { w.EventsProduced++ })
}

// flush sends what the session has pending as one batch.
func (r *runner) flush(s *session, now time.Time) {
	n := min(len(s.pending), r.g.o.maxBatch)
	events := s.pending[:n:n]
	eb := &linkpb.EventBatch{SessionId: s.id, Events: make([]*linkpb.Event, n)}
	resent := 0
	bytes := 0
	for i, p := range events {
		eb.Events[i] = p.ev
		bytes += len(p.ev.GetPayloadJson())
		if p.sent.IsZero() {
			p.sent = now
		} else {
			resent++
		}
	}
	if err := r.cur.send(&linkpb.Frame{Body: &linkpb.Frame_EventBatch{EventBatch: eb}}); err != nil {
		for _, p := range events[:n] {
			if p.sent.Equal(now) {
				p.sent = time.Time{}
			}
		}
		// As for a beat: the connection is ending, and its end is what counts. The batch goes on the next one.
		r.g.note("event_send_failed")
		s.flushAt = now.Add(time.Second)
		return
	}
	s.pending = s.pending[n:]
	s.inflight = append(s.inflight, &sentBatch{events: events, conn: r.cur, sentAt: now})
	if len(s.pending) > 0 {
		s.flushAt = now
	} else {
		s.flushAt = time.Time{}
	}
	r.g.stats.with(func(w *window) {
		w.BatchesSent++
		w.EventsSent += int64(n)
		w.EventsResent += int64(resent)
		w.PayloadBytes += int64(bytes)
	})
}

func (r *runner) onFrame(c *rconn, f *linkpb.Frame, now time.Time) {
	g := r.g
	switch body := f.GetBody().(type) {
	case *linkpb.Frame_HeartbeatAck:
		if c != r.cur || r.beatOut.IsZero() {
			return // the answer to a beat on a connection since replaced
		}
		ack := body.HeartbeatAck
		g.stats.with(func(w *window) { w.HeartbeatAcks++; w.beatAck.add(now.Sub(r.beatOut), 1) })
		r.beatOut = time.Time{}
		switch {
		case len(ack.GetWantFacts()) > 0:
			g.stats.fail("heartbeat_want_facts", fmt.Sprintf("runner %s conn %s: the gateway asked for %v", r.id, c.id, ack.GetWantFacts()))
			r.beatWhole = true
			r.nextBeat = now
		case ack.GetMode() != linkpb.Mode_MODE_LINK:
			g.stats.fail("heartbeat_not_mode_link", fmt.Sprintf("runner %s conn %s: %s", r.id, c.id, ack.GetMode()))
		case len(ack.GetReconcileJson()) == 0:
			g.stats.fail("heartbeat_unreconciled", fmt.Sprintf("runner %s conn %s: a HeartbeatAck without reconcile_json: the route did not answer 2xx", r.id, c.id))
		default:
			var answer struct {
				Cancel    []string `json:"cancelSessionIds"`
				LeaseLost []string `json:"leaseLostSessionIds"`
			}
			if err := json.Unmarshal(ack.GetReconcileJson(), &answer); err != nil {
				g.stats.fail("heartbeat_reconcile_unreadable", fmt.Sprintf("runner %s: %v", r.id, err))
			} else if len(answer.Cancel)+len(answer.LeaseLost) > 0 {
				g.stats.fail("heartbeat_sessions_lost", fmt.Sprintf("runner %s: cancel %v, lease lost %v", r.id, answer.Cancel, answer.LeaseLost))
			}
			if bytes.Contains(ack.GetReconcileJson(), []byte(`"agentDirs"`)) {
				g.stats.with(func(w *window) { w.HeartbeatsReconciled++ })
			}
			if r.vol != nil {
				r.vol.onAnswer(ack.GetReconcileJson())
			}
		}
	case *linkpb.Frame_EventAck:
		r.onEventAck(c, body.EventAck, now)
	case *linkpb.Frame_Credit:
		if c.welcome != nil && body.Credit.GetMaxUnackedEvents() < c.welcome.GetCredit().GetMaxUnackedEvents() {
			g.note("credit_reduced")
		} else {
			g.note("credit_restored")
		}
	case *linkpb.Frame_Drain:
		// The gateway is going away: the next connection is opened after the delay it gave, make before break.
		g.note("drain")
		if c == r.cur {
			r.renewAt = now.Add(time.Duration(body.Drain.GetReconnectAfterMs()) * time.Millisecond)
		}
	case *linkpb.Frame_Hint:
		g.stats.with(func(w *window) { w.Hints++ })
	case *linkpb.Frame_Close:
		// Recorded by the reader; the end of the connection says what it means.
	default:
		g.stats.fail("unexpected_frame", fmt.Sprintf("runner %s conn %s: %T", r.id, c.id, f.GetBody()))
	}
}

func (r *runner) onEventAck(c *rconn, a *linkpb.EventAck, now time.Time) {
	g := r.g
	s := r.byID[a.GetSessionId()]
	if s == nil {
		g.stats.fail("event_ack_unknown_session", fmt.Sprintf("runner %s: an EventAck for %s", r.id, a.GetSessionId()))
		return
	}
	if rej := a.GetRejected(); len(rej) > 0 {
		g.stats.fail("event_rejected", fmt.Sprintf("runner %s session %s: %d refused, first seq %d %s %s", r.id, s.id, len(rej),
			rej[0].GetSeq(), rej[0].GetCode(), rej[0].GetMessage()))
	}
	r.ackThrough(s, a.GetDurableSeq(), now)
	if fl := a.GetFailure(); fl != nil {
		// What this connection had out after the failed batch fails alike, and is sent again from durable_seq + 1.
		requeued := r.requeue(s, c)
		if requeued > 0 {
			g.stats.fail("event_failure_"+fl.GetCode(), fmt.Sprintf("runner %s conn %s session %s: durable_seq %d, retryable %v, retry_after %dms: %s",
				r.id, c.id, s.id, a.GetDurableSeq(), fl.GetRetryable(), fl.GetRetryAfterMs(), fl.GetMessage()))
			s.resendAfter = now.Add(max(time.Duration(fl.GetRetryAfterMs())*time.Millisecond, 250*time.Millisecond))
			s.flushAt = s.resendAfter
		}
	}
}

// ackThrough takes what an EventAck covers off the session: every event up to durable is stored.
func (r *runner) ackThrough(s *session, durable uint64, now time.Time) {
	if durable <= s.durable {
		return
	}
	s.durable = durable
	batches, events := 0, 0
	var batchLat []time.Duration
	var eventLat []time.Duration
	for len(s.inflight) > 0 {
		b := s.inflight[0]
		if b.events[0].ev.GetSeq() > durable {
			break
		}
		oldest := now
		kept := b.events[:0:0]
		for _, p := range b.events {
			if p.ev.GetSeq() <= durable {
				eventLat = append(eventLat, now.Sub(p.sent))
				events++
				if p.sent.Before(oldest) {
					oldest = p.sent
				}
			} else {
				kept = append(kept, p)
			}
		}
		if len(kept) > 0 {
			// Covered in part: the rest stays out.
			b.events = kept
			break
		}
		batchLat = append(batchLat, now.Sub(oldest))
		batches++
		s.inflight = s.inflight[1:]
	}
	// Events sent again after a failure that an earlier answer turned out to cover.
	for len(s.pending) > 0 && s.pending[0].ev.GetSeq() <= durable {
		if !s.pending[0].sent.IsZero() {
			eventLat = append(eventLat, now.Sub(s.pending[0].sent))
			events++
		}
		s.pending = s.pending[1:]
	}
	r.g.stats.with(func(w *window) {
		w.BatchesAcked += int64(batches)
		w.EventsAcked += int64(events)
		for _, d := range batchLat {
			w.ackBatch.add(d, 1)
		}
		for _, d := range eventLat {
			w.ackEvent.add(d, 1)
		}
	})
}

// requeue puts the session's batches still out on c back in front of what it has pending, to be sent again. Returns
// how many events it put back.
func (r *runner) requeue(s *session, c *rconn) int {
	var back []*pev
	kept := s.inflight[:0]
	for _, b := range s.inflight {
		if b.conn == c {
			back = append(back, b.events...)
		} else {
			kept = append(kept, b)
		}
	}
	s.inflight = kept
	if len(back) == 0 {
		return 0
	}
	s.pending = append(back, s.pending...)
	return len(back)
}

// onEnd is a connection ending: expected for one that was replaced, a failure for the one in use.
func (r *runner) onEnd(c *rconn, now time.Time) {
	g := r.g
	for _, s := range r.active {
		if n := r.requeue(s, c); n > 0 {
			s.flushAt = now
			if c.retired {
				g.note("events_resent_after_renewal")
			}
		}
	}
	if c == r.old {
		r.old = nil
		if c.closed == nil || c.closed.GetCode() != linkpb.CloseCode_CLOSE_CODE_SUPERSEDED {
			g.note("replaced_connection_not_superseded")
		}
		return
	}
	r.cur = nil
	r.beatOut = time.Time{}
	if r.dialing && r.quiescing && c.closed.GetCode() == linkpb.CloseCode_CLOSE_CODE_SUPERSEDED {
		// The renewal's connection is up; its dial result comes next.
		r.supersededEarly = true
		g.note("superseded_before_adoption")
		return
	}
	r.quiescing = false
	g.stats.setConnected(-1)
	wait := backoff(r.rng, r.attempt)
	r.attempt++
	kind, detail := "connection_lost", fmt.Sprint(c.err)
	if c.closed != nil {
		kind = "closed_" + c.closed.GetCode().String()
		detail = c.closed.GetMessage()
		wait = max(wait, time.Duration(c.closed.GetRetryAfterMs())*time.Millisecond)
		if c.closed.GetCode() == linkpb.CloseCode_CLOSE_CODE_UNAUTHENTICATED {
			r.token = ""
		}
	}
	if !r.renewAt.IsZero() && r.renewAt.After(now) && r.renewAt.Sub(now) < wait {
		// A Drain said when to come back.
		wait = r.renewAt.Sub(now)
	}
	g.stats.fail(kind, fmt.Sprintf("runner %s conn %s after %s: %s", r.id, c.id, now.Sub(c.opened).Round(time.Second), detail))
	r.dialAt = now.Add(wait)
}

// linkToken is what POST /api/runner/link-token answers.
type linkToken struct {
	Token     string `json:"token"`
	ExpiresAt string `json:"expiresAt"`
	LinkURL   string `json:"linkUrl"`
	expires   time.Time
}

func (g *loadgen) mintToken(ctx context.Context, runnerToken, process string) (*linkToken, error) {
	body, _ := json.Marshal(map[string]string{"leaseOwner": process})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.o.api+"/api/runner/link-token", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+runnerToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := g.apiClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("POST /api/runner/link-token answered %d: %s", resp.StatusCode, bytes.TrimSpace(b))
	}
	var tok linkToken
	if err := json.Unmarshal(b, &tok); err != nil {
		return nil, err
	}
	tok.expires, err = time.Parse(time.RFC3339Nano, tok.ExpiresAt)
	if err != nil {
		return nil, fmt.Errorf("expiresAt %q: %w", tok.ExpiresAt, err)
	}
	return &tok, nil
}
