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

// The work connection (docs/runner-link-design.md §5.4, §7, decisions D10 and D15): the one connection the daemon's
// work goes over in link mode, opened by linkClient (link_client.go) over TLS through whatever proxy HTTPS_PROXY names.
//
// Identity. The process's identity is the daemon transport's leaseOwner, which its link tokens and every Hello name,
// and which no reconnect changes: leases belong to the process, so a dropped connection costs none of them. Each
// connection has an identity of its own, the connection_id its Welcome gives, which only says where frames go; the
// log names both. A process holds one connection at a time: its newest, as the gateway counts it.
//
// Its life. It connects with exponential backoff and full jitter, 1s to 60s, never sooner than a refusal's Retry-After
// or a Close's retry_after_ms (linkRetryWait). Its Hello says where each session stands (Hello.sessions: the last event
// seq sent, the turn being executed), so the gateway resumes them. A token is renewed before it expires, a Drain is
// followed after its delay, both make before break: the next connection is opened and welcomed first, and the
// gateway closes the old one. A TokenRefresh renews the token in place, a Redirect sends the next connection to
// another cell, and every Close code is read as the protocol says.
//
// Calls. Each Rpc is sent on the newest connection and waits for its RpcResult. When the connection ends first, or
// the gateway answers that no backend did and the call may be sent again (BACKEND_CUT_OFF, BACKEND_TIMEOUT,
// BACKEND_UNAVAILABLE, RPC_TOO_MANY_IN_FLIGHT), it is sent again, under the same request_id, on whichever connection
// is newest then, for as long as the call's own deadline lasts.

const (
	// The work connection pings this often and gives up on a ping after this long, which ends the connection: what a
	// silently dead connection costs before the runner notices it.
	linkWorkPingEvery   = 20 * time.Second
	linkWorkPingTimeout = 20 * time.Second
	// linkRPCBackoffMax caps the wait before a call is sent again after a failure that said it may be: the gateway's
	// own retries across backends have already taken their 5s.
	linkRPCBackoffMax = 2 * time.Second
	// linkUnreachableFallback is how long the link may stay unreachable before the work goes back to HTTPS, when only a
	// gateway's MODE_LINK put it there and the control plane never refused HTTPS: a gateway that said MODE_LINK and
	// then went away must not leave the runner working over nothing. Once HTTPS is refused, nothing sends it back.
	linkUnreachableFallback = 5 * time.Minute
)

var (
	// errLinkNotConnected is a call that found no connection within its deadline.
	errLinkNotConnected = errors.New("the runner link is not connected")
	// errLinkConnEnded is a connection that ended before it answered: the call goes again on the next one.
	errLinkConnEnded = errors.New("the runner link connection ended before it answered")
)

// linkWork keeps the work connection of one link mode.
type linkWork struct {
	m      *linkMode
	client *linkClient
	log    func(...any)
	now    func() time.Time
	// How often it pings and how long a ping may wait. Tests shorten them.
	pingEvery, pingTimeout time.Duration

	mu      sync.Mutex
	cur     *linkWorkConn
	changed chan struct{}      // closed, and replaced, when cur changes or the work stops
	cancel  context.CancelFunc // nil while the work is stopped
	done    chan struct{}      // closed when the last loop started has ended
	lastErr error              // why the last connection could not be had, for the calls waiting on one
	attempt int                // failed connection attempts since the work started or a connection was welcomed
	// flaps counts the starts in a row that met a Welcome saying MODE_HTTP: the link was asked for and the gateway
	// would not carry it, which, repeated, opens and closes connections as fast as the two answers arrive.
	flaps  int
	calls  map[string]*linkCall
	events chan linkWorkEvent

	loggedErr   string
	loggedErrAt time.Time
	// lostAt is when the work last had a connection and lost it, zero while it has one; stoppedAt, when the work last
	// stopped, which a time on HTTPS follows.
	lostAt    time.Time
	stoppedAt time.Time
}

// linkWorkConn is the work's state of one of its connections.
type linkWorkConn struct {
	*linkConn
	ready chan struct{} // closed once linkConn is set: frames read before that wait for it

	beatMu  sync.Mutex
	acks    chan *linkpb.HeartbeatAck // the next HeartbeatAck, for the beat waiting on it
	beating bool                      // a beat was sent and its HeartbeatAck has not come
	// facts holds, by kind, the digest of each heartbeat part the gateway was last sent whole on this connection: it
	// keeps them per connection, so they go by digest alone until it asks for one (want_facts).
	facts map[string]string

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
		changed: make(chan struct{}), calls: map[string]*linkCall{}, events: make(chan linkWorkEvent, 16),
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

// waitConn is the connection a call goes out on now: the newest, once one is welcomed. It waits for one while the
// link is in use, and says errLinkModeHTTP once it is not.
func (w *linkWork) waitConn(ctx context.Context) (*linkWorkConn, error) {
	for {
		w.mu.Lock()
		cur, changed, running, lastErr := w.cur, w.changed, w.cancel != nil, w.lastErr
		w.mu.Unlock()
		if cur != nil && !cur.ended() {
			return cur, nil
		}
		if !running {
			return nil, errLinkModeHTTP
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
	if w.flaps > 0 && w.now().Sub(w.stoppedAt) < linkBackoffMax {
		// Started again soon after a Welcome sent the work back to HTTPS: not at once, or two disagreeing answers would
		// have the connection opened and closed as fast as they arrive.
		retryAt = w.now().Add(linkBackoff(w.flaps - 1))
	}
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
				continue // the work stops: a Welcome said MODE_HTTP
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
	conn := &linkWorkConn{ready: make(chan struct{}), acks: make(chan *linkpb.HeartbeatAck, 1), facts: map[string]string{}}
	lc, err := w.client.connect(ctx, func(_ *linkConn, f *linkpb.Frame) {
		<-conn.ready
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

// adopt makes conn, just welcomed, the connection calls go out on, in place of old (nil after a time without one). A
// Welcome saying MODE_HTTP is not adopted: the control plane has sent the work back to HTTPS, and the work stops.
func (w *linkWork) adopt(conn, old *linkWorkConn, why string) bool {
	welcome := conn.welcome
	w.m.observe(welcome.GetMode(), "the Welcome of "+conn.id)
	if welcome.GetMode() == linkpb.Mode_MODE_HTTP {
		reason := "the Welcome said MODE_HTTP"
		conn.retired.Store(&reason)
		conn.close(websocket.StatusNormalClosure, reason)
		w.mu.Lock()
		w.flaps++
		w.lastErr = errors.New("the gateway's Welcome said MODE_HTTP")
		w.mu.Unlock()
		return false
	}
	w.mu.Lock()
	w.cur = conn
	w.attempt, w.flaps, w.lastErr, w.loggedErr = 0, 0, nil, ""
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
	w.m.assignRelease(welcome.GetRelease())
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
	var lostFor time.Duration
	if w.cur == nil {
		if w.lostAt.IsZero() {
			w.lostAt = now
		}
		lostFor = now.Sub(w.lostAt)
	}
	msg := err.Error()
	quiet := msg == w.loggedErr && now.Sub(w.loggedErrAt) < linkShadowLogQuiet
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
	if lostFor >= linkUnreachableFallback {
		w.m.linkUnusable(fmt.Sprintf("the runner link has been unreachable for %s", lostFor.Round(time.Second)))
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

// upgradeRequired takes a gateway that speaks no protocol version this binary does: the runner checks its release now,
// and works over HTTPS meanwhile, unless the control plane has refused that too.
func (w *linkWork) upgradeRequired() {
	w.m.selfUpdateOwed.Store(true)
	w.m.gates.markWake()
	w.m.linkUnusable("the gateway speaks no link protocol version this binary does")
}

// finish closes every connection the loop opened, once it stops.
func (w *linkWork) finish() {
	w.mu.Lock()
	cur := w.cur
	w.cur = nil
	// What follows is a time on HTTPS, not one without a link: the next start counts afresh.
	w.lostAt, w.loggedErr, w.stoppedAt = time.Time{}, "", w.now()
	w.notifyLocked()
	w.mu.Unlock()
	if cur != nil {
		reason := "the runner link is no longer in use"
		cur.retired.Store(&reason)
		cur.close(websocket.StatusGoingAway, "link mode off")
		w.log("runner link: connection " + cur.id + " closed")
	}
}

// pinger pings conn until it ends. A ping unanswered within pingTimeout ends the connection.
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
		if _, err := conn.ping(w.pingTimeout); err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				why := "no answer to a ping within " + w.pingTimeout.String()
				conn.pingFailed.Store(&why)
			}
			return
		}
	}
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
		w.m.observe(ack.GetMode(), "a HeartbeatAck on "+conn.id)
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
// the connection ended first, or the gateway said no backend answered and the call may be sent again. It returns
// errLinkModeHTTP when the control plane sent the work back to HTTPS before the call was answered.
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
		if f.GetCode() == "LINK_MODE_HTTP" {
			w.m.observe(linkpb.Mode_MODE_HTTP, "connection "+conn.id+" refusing a call for MODE_HTTP")
			return nil, errLinkModeHTTP
		}
		if !f.GetRetryable() {
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
