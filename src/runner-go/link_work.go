package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	mrand "math/rand/v2"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"orbit/linkpb"
)

// The work connection (docs/runner-link-design.md §5.4, §7, decision D10): the one connection the daemon's work goes
// over, opened by linkClient (link_client.go) over TLS through whatever proxy HTTPS_PROXY names.
//
// Identity. The process's identity is the daemon transport's leaseOwner, which its link tokens and every Hello name,
// and which no reconnect changes: leases belong to the process, so a dropped connection costs none of them. Each
// connection has an identity of its own, the connection_id its Welcome gives, which only says where frames go; the
// log names both. A process holds one connection at a time: its newest, as the gateway counts it.
//
// Its life. It connects with exponential backoff and full jitter, 1s to 60s, never sooner than a refusal's Retry-After
// or a Close's retry_after_ms (linkRetryWait). The backoff starts over only once a connection has carried a heartbeat
// the control plane reconciled: until then each connection that ends, or cannot be had, is followed by a longer wait,
// so a runner whose connections keep ending without the link working end to end does not reconnect in a tight loop,
// and a fleet does not stampede POST /api/runner/link-token. A connection is taken for dead when its pings say its
// transport is (pinger), never because the control plane is slow to answer what it carries (link_heartbeat.go). Its
// Hello says where each session stands (Hello.sessions: the last event seq sent, the turn being executed), so the
// gateway resumes them. A token is renewed before it expires, a Drain is followed after its delay, both make before
// break: the next connection is opened and welcomed first, and the gateway closes the old one. A TokenRefresh renews
// the token in place, a Redirect sends the next connection to another cell, and every Close code is read as the
// protocol says.
//
// Calls. Each Rpc is sent on the newest connection and waits for its RpcResult. When the connection ends first, or
// the gateway answers that no backend did and the call may be sent again (BACKEND_CUT_OFF, BACKEND_TIMEOUT,
// BACKEND_UNAVAILABLE, RPC_TOO_MANY_IN_FLIGHT), it is sent again, under the same request_id, on whichever connection
// is newest then, for as long as the call's own deadline lasts.

const (
	// The work connection pings this often and gives up on a ping after this long, which ends the connection when
	// nothing else came from the gateway meanwhile either: a dead transport (half open, a frozen gateway, a cut
	// network) is noticed within linkWorkPingEvery + linkWorkPingTimeout, 40s.
	linkWorkPingEvery   = 20 * time.Second
	linkWorkPingTimeout = 20 * time.Second
	// linkBeatStuckAfter is how long a heartbeat may go unanswered on a connection that answers its pings before the
	// connection is ended. A slow control plane is not that: the gateway answers every beat it forwards within its
	// own bound on the call (LINK_RPC_TIMEOUT, 60s by default), saying it got no answer when it got none. A beat
	// unanswered three times as long is one this connection's gateway is not forwarding.
	linkBeatStuckAfter = 3 * time.Minute
	// A heartbeat answered after linkBeatSlow is logged, one line every linkBeatSlowLogEvery at most.
	linkBeatSlow         = 10 * time.Second
	linkBeatSlowLogEvery = time.Minute
	// linkRPCBackoffMax caps the wait before a call is sent again after a failure that said it may be: the gateway's
	// own retries across backends have already taken their 5s.
	linkRPCBackoffMax = 2 * time.Second
	// linkLogQuiet is how long a connection failure that repeats goes unlogged.
	linkLogQuiet = 10 * time.Minute
)

var (
	// errLinkNotConnected is a call that found no connection within its deadline.
	errLinkNotConnected = errors.New("the runner link is not connected")
	// errLinkConnEnded is a connection that ended before it answered: the call goes again on the next one.
	errLinkConnEnded = errors.New("the runner link connection ended before it answered")
	// errLinkClosed is a call made once the link has closed: the runner is stopping.
	errLinkClosed = errors.New("the runner link is closed: the runner is stopping")
)

// linkWork keeps the work connection of one link mode.
type linkWork struct {
	m      *linkMode
	client *linkClient
	log    func(...any)
	now    func() time.Time
	// How often it pings, how long a ping may wait, and how long a beat may go unanswered on a connection that
	// answers pings (linkBeatStuckAfter). Tests shorten them.
	pingEvery, pingTimeout, beatStuckAfter time.Duration
	// beatSeq numbers the beats of this process (Heartbeat.beat_id).
	beatSeq atomic.Uint64

	mu      sync.Mutex
	cur     *linkWorkConn
	changed chan struct{}      // closed, and replaced, when cur changes or the work stops
	cancel  context.CancelFunc // nil while the work is stopped
	done    chan struct{}      // closed when the last loop started has ended
	lastErr error              // why the last connection could not be had, for the calls waiting on one
	// attempt counts the connections that could not be had or ended since the work started or a connection carried a
	// heartbeat the control plane reconciled: what the wait before the next connection grows with.
	attempt int
	calls   map[string]*linkCall
	events  chan linkWorkEvent

	loggedErr   string
	loggedErrAt time.Time
	// lostAt is when the work last had a connection and lost it, zero while it has one.
	lostAt time.Time
	// slowBeats counts the beats answered after linkBeatSlow since slowLoggedAt, when the last of them was logged.
	slowBeats    int
	slowLoggedAt time.Time
}

// linkWorkConn is the work's state of one of its connections.
type linkWorkConn struct {
	*linkConn
	work  *linkWork
	ready chan struct{} // closed once linkConn is set: frames read before that wait for it

	beatMu sync.Mutex
	acks   chan *linkpb.HeartbeatAck // the next HeartbeatAck, for the beat waiting on it
	// pending is the beat sent on the connection whose HeartbeatAck has not come, nil for none: a connection carries
	// one beat at a time (link_heartbeat.go). Guarded by beatMu.
	pending *linkBeat
	// facts holds, by kind, the digest of each heartbeat part the gateway was last sent whole on this connection: it
	// keeps them per connection, so they go by digest alone until it asks for one (want_facts).
	facts map[string]string

	// heard is when a frame was last read from the gateway, in Unix nanoseconds: with the pongs, what says the
	// connection's transport still carries (pinger).
	heard      atomic.Int64
	pingFailed atomic.Pointer[string]
	retired    atomic.Pointer[string] // why the runner itself ended the connection
}

// linkCall is a call waiting for its RpcResult.
type linkCall struct {
	result chan *linkpb.RpcResult
}

// linkWorkEvent is what a connection's reading goroutine hands the loop.
type linkWorkEvent struct {
	conn     *linkWorkConn
	drain    *linkpb.Drain
	refresh  *linkpb.TokenRefresh
	redirect *linkpb.Redirect
}

func newLinkWork(m *linkMode, client *linkClient, log func(...any)) *linkWork {
	return &linkWork{
		m: m, client: client, log: log, now: time.Now, pingEvery: linkWorkPingEvery, pingTimeout: linkWorkPingTimeout,
		beatStuckAfter: linkBeatStuckAfter,
		changed:        make(chan struct{}), calls: map[string]*linkCall{}, events: make(chan linkWorkEvent, 16),
	}
}

func (w *linkWork) running() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.cancel != nil
}

// start opens the work connection, on a goroutine of its own, unless it is open already.
func (w *linkWork) start() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.cancel != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	w.cancel = cancel
	prev, done := w.done, make(chan struct{})
	w.done = done
	go func() {
		defer close(done)
		if prev != nil {
			<-prev // the loop stopped last is closing its connections: this process holds one at a time
		}
		w.loop(ctx)
	}()
}

// stop ends the work connection without waiting for it to close.
func (w *linkWork) stop() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.cancel == nil {
		return
	}
	w.cancel()
	w.cancel = nil
	w.notifyLocked()
}

// wait waits for the last loop to end, at most d.
func (w *linkWork) wait(d time.Duration) {
	w.mu.Lock()
	done := w.done
	w.mu.Unlock()
	if done == nil {
		return
	}
	select {
	case <-done:
	case <-time.After(d):
	}
}

func (w *linkWork) notifyLocked() {
	close(w.changed)
	w.changed = make(chan struct{})
}

// waitConn is the connection a call goes out on now: the newest, once one is welcomed. It waits for one until ctx ends,
// and says errLinkClosed once the link has closed.
func (w *linkWork) waitConn(ctx context.Context) (*linkWorkConn, error) {
	for {
		w.mu.Lock()
		cur, changed, running, lastErr := w.cur, w.changed, w.cancel != nil, w.lastErr
		w.mu.Unlock()
		if cur != nil && !cur.ended() {
			return cur, nil
		}
		if !running {
			return nil, errLinkClosed
		}
		select {
		case <-changed:
		case <-ctx.Done():
			if lastErr != nil {
				return nil, fmt.Errorf("%w (%v)", errLinkNotConnected, lastErr)
			}
			return nil, errLinkNotConnected
		}
	}
}

// ended reports whether the connection has stopped reading, which is how it ends.
func (c *linkWorkConn) ended() bool {
	select {
	case <-c.done:
		return true
	default:
		return false
	}
}

// loop keeps one welcomed connection while ctx lasts.
func (w *linkWork) loop(ctx context.Context) {
	defer w.finish()
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()
	var retryAt, renewAt, drainAt time.Time
	w.mu.Lock()
	w.attempt = 0
	w.mu.Unlock()
	for ctx.Err() == nil {
		cur := w.current()
		if cur == nil {
			if !linkSleepUntil(ctx, retryAt) {
				return
			}
			conn, err := w.dial(ctx)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				retryAt = w.now().Add(w.failed(err))
				continue
			}
			if !w.adopt(conn, nil, "") {
				retryAt = w.now().Add(w.failed(errLinkGatewayModeHTTP))
				continue
			}
			renewAt, drainAt = conn.token.renewAt(), time.Time{}
			continue
		}
		timer.Reset(max(time.Until(renewAt), 0))
		select {
		case <-ctx.Done():
			return
		case <-cur.done:
			wait := w.lost(cur)
			if until := time.Until(drainAt); until > wait {
				wait = until // a Drain said when to come back
			}
			w.setCurrent(cur, nil)
			retryAt, drainAt = w.now().Add(wait), time.Time{}
		case <-runnerCapabilitiesChanged:
			// What this process declares changed (runnerCapabilities): the next connection's Hello says it now, made
			// before this one breaks, as a renewal is.
			renewAt = w.now()
			continue
		case ev := <-w.events:
			if ev.conn != cur {
				continue // from a connection replaced since
			}
			switch {
			case ev.drain != nil:
				after := time.Duration(ev.drain.GetReconnectAfterMs()) * time.Millisecond
				drainAt = w.now().Add(after)
				renewAt = minTime(renewAt, drainAt)
				w.log(fmt.Sprintf("runner link: connection %s is draining; the next one opens in %s", cur.id, after.Round(time.Millisecond)))
			case ev.refresh != nil:
				if tok := w.client.refreshed(cur.token, ev.refresh); tok != nil {
					cur.token = tok
					renewAt = tok.renewAt()
					if !drainAt.IsZero() {
						renewAt = minTime(renewAt, drainAt)
					}
				}
			case ev.redirect != nil:
				if err := w.client.redirectTo(ev.redirect.GetUrl(), ev.redirect.GetToken()); err != nil {
					w.log("runner link: a Redirect on " + cur.id + " is not followed: " + err.Error())
					continue
				}
				w.log("runner link: connection " + cur.id + " is redirected to " + ev.redirect.GetUrl())
				why := "redirected"
				cur.retired.Store(&why)
				cur.close(websocket.StatusNormalClosure, why)
				w.setCurrent(cur, nil)
				retryAt, drainAt = time.Time{}, time.Time{}
			}
		case <-timer.C:
			why := "token renewal"
			if !drainAt.IsZero() {
				why = "drain"
			}
			// Make before break: the next connection is welcomed before this one goes, and every call this one does not
			// answer is sent again on the next.
			conn, err := w.dial(ctx)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				renewAt = w.now().Add(w.failed(err))
				continue
			}
			if !w.adopt(conn, cur, why) {
				renewAt = w.now().Add(w.failed(errLinkGatewayModeHTTP)) // cur carries the work meanwhile
				continue
			}
			renewAt, drainAt = conn.token.renewAt(), time.Time{}
		}
	}
}

func minTime(a, b time.Time) time.Time {
	if b.Before(a) {
		return b
	}
	return a
}

// linkSleepUntil waits until at, and reports false once ctx has ended.
func linkSleepUntil(ctx context.Context, at time.Time) bool {
	d := time.Until(at)
	if d <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (w *linkWork) current() *linkWorkConn {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.cur
}

// setCurrent makes next the connection calls go out on, in place of prev, if prev still is.
func (w *linkWork) setCurrent(prev, next *linkWorkConn) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.cur != prev {
		return
	}
	w.cur = next
	w.notifyLocked()
}

// dial opens one connection, with a goroutine pinging it.
func (w *linkWork) dial(ctx context.Context) (*linkWorkConn, error) {
	conn := &linkWorkConn{work: w, ready: make(chan struct{}), acks: make(chan *linkpb.HeartbeatAck, 1), facts: map[string]string{}}
	lc, err := w.client.connect(ctx, func(_ *linkConn, f *linkpb.Frame) {
		<-conn.ready
		conn.heard.Store(time.Now().UnixNano())
		w.onFrame(conn, f)
	})
	if err != nil {
		close(conn.ready)
		return nil, err
	}
	conn.linkConn = lc
	close(conn.ready)
	go w.pinger(conn)
	return conn, nil
}

// adopt makes conn, just welcomed, the connection calls go out on, in place of old (nil after a time without one). It
// reports false for a Welcome saying MODE_HTTP: the gateway forwards nothing for such a connection, so it is closed, and
// the next one opens after a wait, as after any connection that could not be had.
func (w *linkWork) adopt(conn, old *linkWorkConn, why string) bool {
	welcome := conn.welcome
	if welcome.GetMode() == linkpb.Mode_MODE_HTTP {
		reason := "the Welcome said MODE_HTTP"
		conn.retired.Store(&reason)
		conn.close(websocket.StatusNormalClosure, reason)
		return false
	}
	// Taken before the connection carries anything: a beat can go out on it the moment it is current, and has to find
	// the release check the Welcome owes it (linkMode.afterHeartbeat).
	w.m.assignRelease(welcome.GetRelease())
	w.mu.Lock()
	w.cur = conn
	// The backoff is not reset here but once the connection has carried a reconciled heartbeat (reconciled): a
	// connection that ends before that is followed by a longer wait than the last.
	w.lastErr, w.loggedErr = nil, ""
	lostAt := w.lostAt
	w.lostAt = time.Time{}
	w.notifyLocked()
	w.mu.Unlock()
	if old != nil {
		reason := "replaced by " + conn.id
		old.retired.Store(&reason)
		old.close(websocket.StatusNormalClosure, "replaced")
	}
	// What the Welcome says, then everything asked once more: hints sent while there was no connection are lost. The
	// sessions' event streams send everything they hold again on this connection, from how far the Welcome says each
	// is stored (link_events.go).
	w.m.gates.state(welcome.GetHints())
	w.m.events.welcomed(conn, welcome)
	w.m.gates.markAll()
	for _, s := range welcome.GetSessions() {
		if !s.GetLeaseHeld() {
			// The next heartbeat's reconcile (leaseLostSessionIds) is what detaches a supervisor, as it always has.
			w.log(fmt.Sprintf("runner link: the gateway says process %s no longer holds session %s", w.client.processID, s.GetSessionId()))
		}
	}
	if ms := welcome.GetHeartbeatIntervalMs(); ms != 0 && time.Duration(ms)*time.Millisecond != heartbeatInterval {
		w.log(fmt.Sprintf("runner link: the gateway asks for a heartbeat every %dms; this runner beats every %s", ms, heartbeatInterval))
	}
	msg := fmt.Sprintf("runner link: connection %s to %s carries the work of process %s", conn.id, conn.token.linkURL, w.client.processID)
	switch {
	case old != nil:
		msg = fmt.Sprintf("runner link: connection %s replaced by %s (%s)", old.id, conn.id, why)
	case !lostAt.IsZero():
		msg += fmt.Sprintf(", after %s without one", w.now().Sub(lostAt).Round(time.Millisecond))
	}
	w.log(msg)
	return true
}

// failed records a connection attempt that failed and returns the wait before the next. A failure that repeats is
// logged again only after a while.
func (w *linkWork) failed(err error) time.Duration {
	w.mu.Lock()
	wait := linkRetryWait(err, w.attempt)
	w.attempt++
	w.lastErr = err
	now := w.now()
	// A next connection that cannot be had while the current one still carries the work (a renewal, a drain) leaves
	// the runner with a link: only a time with none counts as one without it.
	if w.cur == nil && w.lostAt.IsZero() {
		w.lostAt = now
	}
	msg := err.Error()
	quiet := msg == w.loggedErr && now.Sub(w.loggedErrAt) < linkLogQuiet
	if !quiet {
		w.loggedErr, w.loggedErrAt = msg, now
	}
	w.mu.Unlock()
	var closed *linkCloseError
	if errors.As(err, &closed) && closed.code == linkpb.CloseCode_CLOSE_CODE_UPGRADE_REQUIRED {
		w.upgradeRequired()
	}
	if !quiet {
		w.log(fmt.Sprintf("runner link: cannot connect (%s); next try in %s", msg, wait.Round(time.Millisecond)))
	}
	return wait
}

// lost records the end of conn, the current connection, and returns the wait before the next attempt.
func (w *linkWork) lost(conn *linkWorkConn) time.Duration {
	w.mu.Lock()
	wait := linkBackoff(w.attempt)
	w.attempt++
	if w.lostAt.IsZero() {
		w.lostAt = w.now()
	}
	w.mu.Unlock()
	why := "connection lost"
	switch {
	case conn.retired.Load() != nil:
		why = "ended by the runner: " + *conn.retired.Load()
	case conn.pingFailed.Load() != nil:
		why += ": " + *conn.pingFailed.Load()
	case conn.err != nil:
		why += ": " + conn.err.Error()
	}
	if cl := conn.closed.Load(); cl != nil {
		why = fmt.Sprintf("closed by the gateway: %s %q", cl.GetCode(), cl.GetMessage())
		switch cl.GetCode() {
		case linkpb.CloseCode_CLOSE_CODE_SUPERSEDED:
			// Another connection of this process took its place, and it is not one this loop opened.
			wait = max(wait, time.Second)
		case linkpb.CloseCode_CLOSE_CODE_UNAUTHENTICATED:
			w.client.forget(conn.token)
		case linkpb.CloseCode_CLOSE_CODE_UPGRADE_REQUIRED:
			w.upgradeRequired()
			wait = linkLongWaitJittered()
		}
		wait = max(wait, time.Duration(cl.GetRetryAfterMs())*time.Millisecond)
	}
	w.mu.Lock()
	w.lastErr = errors.New(why)
	w.mu.Unlock()
	w.log(fmt.Sprintf("runner link: connection %s ended (%s); reconnecting in %s", conn.id, why, wait.Round(time.Millisecond)))
	return wait
}

// upgradeRequired takes a gateway that speaks no protocol version this binary does: the runner checks its release now.
func (w *linkWork) upgradeRequired() {
	w.m.selfUpdateOwed.Store(true)
	w.m.gates.markWake()
}

// finish closes every connection the loop opened, once it stops.
func (w *linkWork) finish() {
	w.mu.Lock()
	cur := w.cur
	w.cur = nil
	w.lostAt, w.loggedErr = time.Time{}, ""
	w.notifyLocked()
	w.mu.Unlock()
	if cur != nil {
		reason := "the runner is stopping"
		cur.retired.Store(&reason)
		cur.close(websocket.StatusGoingAway, reason)
		w.log("runner link: connection " + cur.id + " closed")
	}
}

// pinger pings conn until it ends, and ends it once its transport is dead: a ping has had no pong within pingTimeout,
// and nothing else was read from the gateway since it was sent either. The gateway answers pings itself, whatever its
// backends do, so how long the control plane takes to answer a heartbeat or a call has no part in it. The WebSocket
// library gives up on a pong without ending the connection, so this ends it.
func (w *linkWork) pinger(conn *linkWorkConn) {
	defer func() {
		if r := recover(); r != nil {
			w.log("runner link: pinging", conn.id, "panicked:", r)
		}
	}()
	tick := time.NewTicker(w.pingEvery)
	defer tick.Stop()
	for {
		select {
		case <-conn.done:
			return
		case <-tick.C:
		}
		sent := time.Now()
		_, err := conn.ping(w.pingTimeout)
		// A ping that could not even be written in time (another write holds the connection) proves nothing yet, and a
		// connection that ended is the read loop's to report.
		if err == nil || !errors.Is(err, context.DeadlineExceeded) || time.Since(sent) < w.pingTimeout || conn.heardSince(sent) {
			continue
		}
		why := "no answer to a ping within " + w.pingTimeout.String() + ", and nothing else read from the gateway since"
		conn.pingFailed.Store(&why)
		_ = conn.ws.CloseNow()
		return
	}
}

// heardSince reports whether a frame was read from the gateway at or after t.
func (c *linkWorkConn) heardSince(t time.Time) bool {
	return c.heard.Load() >= t.UnixNano()
}

// reconciled takes a heartbeat the control plane reconciled on conn: the link works end to end, so the reconnect
// backoff starts over.
func (w *linkWork) reconciled(conn *linkWorkConn) {
	w.mu.Lock()
	if w.cur == conn {
		w.attempt = 0
	}
	w.mu.Unlock()
}

// slowBeat takes a beat answered took after it was sent on conn: one answered after linkBeatSlow is logged, one line
// every linkBeatSlowLogEvery at most, which counts the slow answers since the last.
func (w *linkWork) slowBeat(conn *linkWorkConn, id uint64, took time.Duration) {
	if took < linkBeatSlow {
		return
	}
	w.mu.Lock()
	w.slowBeats++
	now := w.now()
	if now.Sub(w.slowLoggedAt) < linkBeatSlowLogEvery {
		w.mu.Unlock()
		return
	}
	n := w.slowBeats
	w.slowBeats, w.slowLoggedAt = 0, now
	w.mu.Unlock()
	w.log(fmt.Sprintf("runner link: heartbeat %d was answered %s after it was sent, on connection %s, which carries on (%d answer(s) over %s since the last such line)",
		id, took.Round(time.Millisecond), conn.id, n, linkBeatSlow))
}

// onFrame takes a frame the gateway sent on conn, on its reading goroutine.
func (w *linkWork) onFrame(conn *linkWorkConn, f *linkpb.Frame) {
	switch body := f.GetBody().(type) {
	case *linkpb.Frame_RpcResult:
		w.mu.Lock()
		call := w.calls[body.RpcResult.GetRequestId()]
		w.mu.Unlock()
		if call != nil {
			select {
			case call.result <- body.RpcResult:
			default: // answered already, on another connection
			}
		}
	case *linkpb.Frame_HeartbeatAck:
		ack := body.HeartbeatAck
		w.m.gates.state(ack.GetHints())
		w.m.events.hintState(ack.GetHints())
		if len(ack.GetReconcileJson()) > 0 || ack.GetRelease() != nil {
			// A full answer states the assigned release, its absence included; one that reconciled nothing does not.
			w.m.assignRelease(ack.GetRelease())
		}
		select {
		case <-conn.acks: // a stale one nobody waited for
		default:
		}
		select {
		case conn.acks <- ack:
		default:
		}
	case *linkpb.Frame_Hint:
		w.m.gates.hint(body.Hint)
		if watchers := body.Hint.GetWatchers(); watchers != nil {
			w.m.events.watchersHint(watchers)
		}
	case *linkpb.Frame_Drain:
		w.event(linkWorkEvent{conn: conn, drain: body.Drain})
	case *linkpb.Frame_TokenRefresh:
		w.event(linkWorkEvent{conn: conn, refresh: body.TokenRefresh})
	case *linkpb.Frame_Redirect:
		w.event(linkWorkEvent{conn: conn, redirect: body.Redirect})
	case *linkpb.Frame_TurnPrefixRequest:
		// What the session's current turn has streamed so far, which its live stream keeps (link_events_live.go).
		resp := w.m.events.turnPrefix(body.TurnPrefixRequest)
		go func() {
			_, _ = conn.send(&linkpb.Frame{Body: &linkpb.Frame_TurnPrefixResponse{TurnPrefixResponse: resp}})
		}()
	case *linkpb.Frame_EventAck:
		w.m.events.onAck(conn, body.EventAck)
	case *linkpb.Frame_Credit:
		w.m.events.onCredit(conn, body.Credit)
	}
	// A body this binary does not know is ignored, as the protocol asks.
}

func (w *linkWork) event(ev linkWorkEvent) {
	select {
	case w.events <- ev:
	default:
		w.log("runner link: a", linkFrameKind(ev), "on", ev.conn.id, "was dropped: too many are waiting")
	}
}

// linkJitter is a random duration in [0, n): the full jitter of the link's backoffs.
func linkJitter(n int64) int64 { return mrand.Int64N(n) }

// linkURLScheme reports whether s is a link address: a ws:// or wss:// URL.
func linkURLScheme(s string) bool {
	u, err := url.Parse(s)
	return err == nil && u.Host != "" && (u.Scheme == "wss" || u.Scheme == "ws")
}

func linkFrameKind(ev linkWorkEvent) string {
	switch {
	case ev.drain != nil:
		return "Drain"
	case ev.refresh != nil:
		return "TokenRefresh"
	default:
		return "Redirect"
	}
}

// rpc sends rpc and returns the route's answer. It sends it again, under the same request_id, whenever no answer came:
// the connection ended first, or the gateway said no backend answered and the call may be sent again, or that it
// forwards nothing because its server's RUNNER_LINK_REQUIRED is off (LINK_MODE_HTTP, an older server's: nothing else
// would carry the call).
func (w *linkWork) rpc(ctx context.Context, rpc *linkpb.Rpc) (*linkpb.TunnelResponse, error) {
	call := &linkCall{result: make(chan *linkpb.RpcResult, 1)}
	id := rpc.GetRequestId()
	w.mu.Lock()
	w.calls[id] = call
	w.mu.Unlock()
	defer func() {
		w.mu.Lock()
		delete(w.calls, id)
		w.mu.Unlock()
	}()
	frame := &linkpb.Frame{Body: &linkpb.Frame_Rpc{Rpc: rpc}}
	for attempt := 0; ; attempt++ {
		// A call its caller has given up on is not sent, nor sent again: an answer nobody reads can hand out what
		// nobody receives, such as a control turn of an engine generation that has ended (inbox_poller.go).
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		conn, err := w.waitConn(ctx)
		if err != nil {
			return nil, err
		}
		if _, err := conn.send(frame); err != nil {
			// The write failed, which ends the connection: the call goes again on the next one.
			_ = conn.ws.CloseNow()
			if !linkWaitEnded(ctx, conn) {
				return nil, ctx.Err()
			}
			continue
		}
		var res *linkpb.RpcResult
		select {
		case res = <-call.result:
		case <-conn.done:
			select {
			case res = <-call.result:
			default:
				continue // no answer on that connection
			}
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		if t := res.GetTunnel(); t != nil {
			return t, nil
		}
		f := res.GetFailure()
		if !f.GetRetryable() && f.GetCode() != "LINK_MODE_HTTP" {
			return nil, linkFailureAnswer(rpc, f)
		}
		wait := max(time.Duration(f.GetRetryAfterMs())*time.Millisecond, linkRPCBackoff(attempt))
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(wait):
		}
	}
}

// linkWaitEnded waits for conn to end, and reports false when ctx ends first.
func linkWaitEnded(ctx context.Context, conn *linkWorkConn) bool {
	select {
	case <-conn.done:
		return true
	case <-ctx.Done():
		return false
	}
}

// linkRPCBackoff is the wait before a call is sent again after its attempt-th failure: full jitter, from 100ms up to
// linkRPCBackoffMax.
func linkRPCBackoff(attempt int) time.Duration {
	ceiling := min(100*time.Millisecond<<min(attempt, 5), linkRPCBackoffMax)
	return time.Duration(linkJitter(int64(ceiling))) + time.Millisecond
}

// linkFailureAnswer is a Failure the gateway will not have sent again, as the HTTP answer the call's caller reads: a
// request it refused to forward is the caller's mistake (400), anything else the far side's (502). The body carries the
// failure's code and message.
func linkFailureAnswer(rpc *linkpb.Rpc, f *linkpb.Failure) error {
	status := http.StatusBadGateway
	if f.GetCode() == "RPC_BAD_REQUEST" {
		status = http.StatusBadRequest
	}
	body, _ := json.Marshal(map[string]any{"code": f.GetCode(), "message": f.GetMessage(), "retryable": false})
	t := rpc.GetTunnel()
	return &transportHTTPError{method: t.GetMethod(), path: t.GetPath(), statusCode: status, body: string(body)}
}

// ── Token renewal and redirects ─────────────────────────────────────────────────────────────────

// refreshed takes a TokenRefresh for the connection opened with tok: the new token is the one the next connection
// opens with, and how long it lives decides when that is. It returns the token, or nil when the frame carries none.
func (c *linkClient) refreshed(tok *linkToken, r *linkpb.TokenRefresh) *linkToken {
	if r.GetToken() == "" {
		return nil
	}
	now := c.now()
	lifetime, ok := linkTokenLifetime(r.GetToken())
	if !ok {
		lifetime = time.UnixMilli(r.GetExpiresAtUnixMs()).Sub(now)
		if lifetime <= 0 {
			return nil
		}
	}
	linkURL := c.serverURL
	if tok != nil {
		linkURL = tok.linkURL
	}
	fresh := &linkToken{token: r.GetToken(), linkURL: linkURL, mintedAt: now, lifetime: lifetime}
	c.mu.Lock()
	c.tok = fresh
	c.mu.Unlock()
	return fresh
}

// redirectTo takes a Redirect: the next connection goes to url, with token when one came, or with a token fetched over
// HTTPS first.
func (c *linkClient) redirectTo(to, token string) error {
	if !linkURLScheme(to) {
		return fmt.Errorf("%q is not a ws:// or wss:// URL", to)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if token == "" {
		c.tok, c.nextURL = nil, to
		return nil
	}
	lifetime, ok := linkTokenLifetime(token)
	if !ok {
		return errors.New("its token's lifetime cannot be read")
	}
	c.tok, c.nextURL = &linkToken{token: token, linkURL: to, mintedAt: c.now(), lifetime: lifetime}, ""
	return nil
}
