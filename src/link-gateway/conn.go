package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

// conn is one runner's connection after the upgrade (docs/runner-link-design.md §6.1): the handler's goroutine reads,
// one goroutine writes from two queues (control frames ahead of everything else) and one pings. Its state lives in
// memory only; a runner that loses it reconnects.
type conn struct {
	g      *gateway
	ws     *websocket.Conn
	id     string
	claims *linkClaims
	remote string
	mode   linkpb.Mode
	log    *slog.Logger
	// started is when the upgrade request arrived; the handshake's duration ends when Welcome is written.
	started time.Time

	ctx    context.Context
	cancel context.CancelFunc

	ctrl   chan outItem
	normal chan outItem
	outID  atomic.Uint64

	closeOnce  sync.Once
	drainOnce  sync.Once
	closing    chan struct{}
	writerDone chan struct{}
	reason     atomic.Pointer[string] // why the connection ended; the first to say so wins

	mu       sync.Mutex
	hello    *linkpb.Hello
	timers   []*time.Timer
	welcomed bool

	chunks reassembler
	shadow *shadowState
	// readError is why reading stopped; only the reading goroutine touches it.
	readError error
}

type outItem struct {
	frame *linkpb.Frame
	close *closeRequest
}

// closeRequest is the last thing the writer does: the Close frame, when there is one, then the WebSocket close.
type closeRequest struct {
	frame  *linkpb.Frame
	status websocket.StatusCode
	text   string
}

const (
	controlQueue = 64
	normalQueue  = 256
	writeTimeout = 10 * time.Second
)

func newConn(g *gateway, ws *websocket.Conn, claims *linkClaims, remote string) *conn {
	ctx, cancel := context.WithCancel(context.Background())
	c := &conn{
		g: g, ws: ws, id: newConnectionID(), claims: claims, remote: remote, mode: g.cfg.Mode,
		ctx: ctx, cancel: cancel,
		ctrl: make(chan outItem, controlQueue), normal: make(chan outItem, normalQueue),
		closing: make(chan struct{}), writerDone: make(chan struct{}),
	}
	c.log = g.log.With("conn", c.id, "runner", claims.RunnerID, "process", claims.LeaseOwner, "remote", remote)
	c.shadow = newShadowState(c)
	return c
}

func newConnectionID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "c-" + hex.EncodeToString(b)
}

// run serves the connection from the upgrade to its end. started is when the upgrade request arrived.
func (c *conn) run(started time.Time) {
	c.started = started
	go c.writeLoop()
	defer c.finish()

	if !c.handshake() {
		return
	}
	go c.pingLoop()
	c.readLoop()
}

// handshake waits for Hello, checks it and answers Welcome (§5.4). It reports whether the connection is open.
func (c *conn) handshake() bool {
	m := c.g.metrics
	helloTimer := time.AfterFunc(c.g.cfg.HelloTimeout, func() {
		c.closeWith(linkpb.CloseCode_CLOSE_CODE_PROTOCOL_ERROR, "no Hello within "+c.g.cfg.HelloTimeout.String(), 0,
			websocket.StatusPolicyViolation, "hello_timeout")
	})
	f, err := c.readFrame()
	timedOut := !helloTimer.Stop()
	fail := func(result string) bool {
		c.g.reg.release(c.claims.RunnerID)
		m.handshakes.inc(result)
		return false
	}
	if timedOut {
		return fail("hello_timeout")
	}
	if err != nil {
		if errors.Is(err, errUndecodable) {
			c.closeWith(linkpb.CloseCode_CLOSE_CODE_PROTOCOL_ERROR, "the first frame does not decode", 0,
				websocket.StatusProtocolError, "protocol_error")
		}
		return fail("protocol_error")
	}
	c.logFrame("in", f)
	m.framesReceived.inc(bodyName(f))
	hello := f.GetHello()
	switch {
	case hello == nil:
		c.closeWith(linkpb.CloseCode_CLOSE_CODE_PROTOCOL_ERROR, "the first frame must be Hello, not "+bodyName(f), 0,
			websocket.StatusProtocolError, "protocol_error")
		return fail("protocol_error")
	case !strings.EqualFold(hello.GetProcessId(), c.claims.LeaseOwner):
		c.closeWith(linkpb.CloseCode_CLOSE_CODE_UNAUTHENTICATED, "Hello.process_id is not the process the link token was issued to", 0,
			websocket.StatusPolicyViolation, "protocol_error")
		return fail("unauthenticated")
	case hello.GetMinProtocolVersion() > 1 || hello.GetMaxProtocolVersion() < 1:
		c.closeWith(linkpb.CloseCode_CLOSE_CODE_UPGRADE_REQUIRED,
			fmt.Sprintf("this gateway speaks link protocol 1, the runner %d-%d", hello.GetMinProtocolVersion(), hello.GetMaxProtocolVersion()), 0,
			websocket.StatusPolicyViolation, "protocol_error")
		return fail("upgrade_required")
	}

	c.mu.Lock()
	c.hello = hello
	c.mu.Unlock()
	if old := c.g.reg.activate(c); old != nil {
		old.closeWith(linkpb.CloseCode_CLOSE_CODE_SUPERSEDED, "a newer connection of this process took over", 0,
			websocket.StatusNormalClosure, "superseded")
	}
	c.send(&linkpb.Frame{Body: &linkpb.Frame_Welcome{Welcome: &linkpb.Welcome{
		ProtocolVersion:     1,
		Mode:                c.mode,
		HeartbeatIntervalMs: uint32(c.g.cfg.HeartbeatInterval / time.Millisecond),
		Limits:              &linkpb.Limits{MaxFrameBytes: maxFrameBytes},
		Credit:              &linkpb.Credit{MaxUnackedEvents: 10000, MaxUnackedBytes: 64 << 20},
		Hints:               &linkpb.HintState{},
		ConnectionId:        c.id,
	}}}, true)
	c.mu.Lock()
	c.welcomed = true
	c.mu.Unlock()
	m.connections.add(1)
	m.handshakes.inc("ok")
	// Subscribed once Welcome is queued, so no hint can be written ahead of it.
	if c.g.hints != nil {
		c.g.hints.hold(c.claims.RunnerID)
	}

	// The token's lifetime is the connection's: version 0 cannot renew it in the connection (TokenRefresh), so the
	// runner opens its next connection with a fresh token before this one expires.
	c.after(time.Until(c.claims.ExpiresAt), func() {
		c.closeWith(linkpb.CloseCode_CLOSE_CODE_UNAUTHENTICATED, "the link token expired", 0,
			websocket.StatusPolicyViolation, "token_expired")
	})
	if c.g.draining.Load() {
		c.drain(c.g.drainDelay())
	}
	return true
}

var errUndecodable = errors.New("frame does not decode")

// readFrame reads one WebSocket message as a Frame. It never passes a deadline to Read: the library closes a
// connection whose read context ends, and the gateway closes with a Close frame first.
func (c *conn) readFrame() (*linkpb.Frame, error) {
	typ, data, err := c.ws.Read(c.ctx)
	if err != nil {
		c.readError = err
		return nil, err
	}
	var f linkpb.Frame
	if typ != websocket.MessageBinary || proto.Unmarshal(data, &f) != nil {
		c.g.metrics.frameDecodeErrors.inc()
		raw := data
		if len(raw) > 4096 {
			raw = raw[:4096]
		}
		c.log.Warn("frame does not decode", "type", typ.String(), "bytes", len(data), "raw", base64.StdEncoding.EncodeToString(raw))
		return nil, errUndecodable
	}
	return &f, nil
}

func (c *conn) readLoop() {
	for {
		f, err := c.readFrame()
		if err != nil {
			if errors.Is(err, errUndecodable) {
				c.closeWith(linkpb.CloseCode_CLOSE_CODE_PROTOCOL_ERROR, "a frame does not decode", 0,
					websocket.StatusProtocolError, "protocol_error")
			} else if strings.Contains(err.Error(), "read limited at") {
				// The library has already closed it, with 1009: a message over Limits.max_frame_bytes.
				c.setReason("protocol_error")
			}
			return
		}
		if !c.dispatch(f) {
			return
		}
	}
}

// dispatch handles one frame from the runner and reports whether to go on reading.
func (c *conn) dispatch(f *linkpb.Frame) bool {
	c.g.metrics.framesReceived.inc(bodyName(f))
	c.logFrame("in", f)
	switch body := f.GetBody().(type) {
	case *linkpb.Frame_Heartbeat:
		c.onHeartbeat(f.GetId(), body.Heartbeat, proto.Size(f))
	case *linkpb.Frame_EventBatch:
		// No EventAck: in MODE_HTTP nothing is stored, and an ack says the events are (§5.8).
		if c.mode == linkpb.Mode_MODE_HTTP {
			c.shadow.typed(f.GetId(), &shadowEntry{kind: "events", events: body.EventBatch}, proto.Size(f))
		}
	case *linkpb.Frame_Rpc:
		c.onRpc(body.Rpc, proto.Size(f))
	case *linkpb.Frame_Chunk:
		joined, err := c.chunks.add(body.Chunk)
		if err != nil {
			c.closeWith(linkpb.CloseCode_CLOSE_CODE_PROTOCOL_ERROR, err.Error(), 0, websocket.StatusProtocolError, "protocol_error")
			return false
		}
		if joined != nil {
			return c.dispatch(joined)
		}
	case *linkpb.Frame_Hello:
		c.closeWith(linkpb.CloseCode_CLOSE_CODE_PROTOCOL_ERROR, "a second Hello", 0, websocket.StatusProtocolError, "protocol_error")
		return false
	}
	// LiveBatch and TurnPrefixResponse are counted and dropped: version 0 publishes no live stream. Bodies the
	// gateway sends rather than receives, and those of a newer protocol, are ignored (contracts/runner-link/v1).
	return true
}

// onHeartbeat records the beat and answers it (§5.7). Version 0 reconciles nothing: the answer says MODE_HTTP, and
// the runner keeps working over HTTPS.
func (c *conn) onHeartbeat(frameID uint64, hb *linkpb.Heartbeat, size int) {
	c.g.metrics.heartbeats.inc()
	c.send(&linkpb.Frame{Body: &linkpb.Frame_HeartbeatAck{HeartbeatAck: &linkpb.HeartbeatAck{
		Mode: c.mode, Hints: &linkpb.HintState{},
	}}}, true)
	if c.mode == linkpb.Mode_MODE_HTTP {
		c.shadow.typed(frameID, &shadowEntry{kind: "heartbeat", heartbeat: hb}, size)
	}
}

// mayForward is the one check an Rpc passes before it may reach a backend; version 0 has no forwarder behind it
// (B4 adds one). Two things hold whatever is added: a connection in MODE_HTTP forwards nothing, and a shadow
// mirror (request_id "shadow:...") is never forwarded, in any mode. TestRpcForwardingInvariants pins both.
func mayForward(mode linkpb.Mode, rpc *linkpb.Rpc) bool {
	return mode == linkpb.Mode_MODE_LINK && !strings.HasPrefix(rpc.GetRequestId(), shadowPrefix)
}

// onRpc compares a mirror with its typed frame and answers every Rpc with exactly one RpcResult.
func (c *conn) onRpc(rpc *linkpb.Rpc, size int) {
	shadow := strings.HasPrefix(rpc.GetRequestId(), shadowPrefix)
	if shadow {
		c.shadow.mirror(rpc, size)
	}
	if mayForward(c.mode, rpc) && c.g.forward != nil {
		c.g.metrics.rpcs.inc("forwarded")
		c.g.forward(c, rpc)
		return
	}
	code, message := "NOT_FORWARDED", "this gateway forwards no requests yet"
	switch {
	case c.mode != linkpb.Mode_MODE_LINK:
		code, message = "LINK_MODE_HTTP", "this connection is in MODE_HTTP: daemon requests go over HTTPS, and a mirror is compared, never forwarded"
	case shadow:
		code, message = "SHADOW_MIRROR", "a mirror is compared, never forwarded"
	}
	result := "not_forwarded"
	if shadow {
		result = "shadow"
	}
	c.g.metrics.rpcs.inc(result)
	c.send(&linkpb.Frame{Body: &linkpb.Frame_RpcResult{RpcResult: &linkpb.RpcResult{
		RequestId: rpc.GetRequestId(),
		Outcome:   &linkpb.RpcResult_Failure{Failure: &linkpb.Failure{Code: code, Message: message, Retryable: false}},
	}}}, false)
}

// send queues a frame, control frames ahead of the rest. A queue that is full means the runner is not reading:
// the connection is closed as a slow consumer rather than allowed to hold memory (§6.1).
func (c *conn) send(f *linkpb.Frame, control bool) {
	f.Id = c.outID.Add(1)
	q := c.normal
	if control {
		q = c.ctrl
	}
	select {
	case <-c.closing:
		return
	default:
	}
	select {
	case q <- outItem{frame: f}:
	default:
		c.closeWith(linkpb.CloseCode_CLOSE_CODE_SLOW_CONSUMER, "the runner reads too slowly", 0,
			websocket.StatusPolicyViolation, "slow_consumer")
	}
}

// offer queues a hint, which is sent at most once (§5.2). Unlike send, a full queue drops it instead of closing the
// connection: a burst of hints must not cost a runner that is slow to read its connection. Nothing is offered before
// Welcome.
func (c *conn) offer(f *linkpb.Frame) bool {
	c.mu.Lock()
	welcomed := c.welcomed
	c.mu.Unlock()
	if !welcomed {
		return false
	}
	select {
	case <-c.closing:
		return false
	default:
	}
	f.Id = c.outID.Add(1)
	select {
	case c.normal <- outItem{frame: f}:
		return true
	default:
		return false
	}
}

func (c *conn) writeLoop() {
	defer close(c.writerDone)
	for {
		var it outItem
		select {
		case it = <-c.ctrl:
		default:
			select {
			case it = <-c.ctrl:
			case it = <-c.normal:
			case <-c.ctx.Done():
				return
			}
		}
		if it.close != nil {
			if it.close.frame != nil {
				_ = c.write(it.close.frame)
			}
			_ = c.ws.Close(it.close.status, it.close.text)
			return
		}
		if err := c.write(it.frame); err != nil {
			c.setReason("connection_lost")
			_ = c.ws.CloseNow()
			return
		}
	}
}

func (c *conn) write(f *linkpb.Frame) error {
	msgs, err := encodeFrame(f, maxFrameBytes, func() uint64 { return c.outID.Add(1) })
	if err != nil {
		return err
	}
	for _, b := range msgs {
		ctx, cancel := context.WithTimeout(c.ctx, writeTimeout)
		err := c.ws.Write(ctx, websocket.MessageBinary, b)
		cancel()
		if err != nil {
			return err
		}
	}
	c.g.metrics.framesSent.inc(bodyName(f))
	if f.GetWelcome() != nil {
		c.g.metrics.handshakeDuration.observe(time.Since(c.started))
	}
	c.logFrame("out", f)
	return nil
}

// closeWith closes the connection once: the Close frame saying why, then the WebSocket close. reason is what the
// disconnect is counted under.
func (c *conn) closeWith(code linkpb.CloseCode, message string, retryAfter time.Duration, status websocket.StatusCode, reason string) {
	c.closeOnce.Do(func() {
		c.setReason(reason)
		f := &linkpb.Frame{Id: c.outID.Add(1), Body: &linkpb.Frame_Close{Close: &linkpb.Close{
			Code: code, Message: message, RetryAfterMs: uint32(retryAfter / time.Millisecond),
		}}}
		text := message
		if len(text) > 120 {
			text = text[:120]
		}
		close(c.closing)
		select {
		case c.ctrl <- outItem{close: &closeRequest{frame: f, status: status, text: text}}:
		default:
			go func() { _ = c.ws.Close(status, text) }()
		}
	})
}

func (c *conn) setReason(reason string) {
	c.reason.CompareAndSwap(nil, &reason)
}

// drain tells the runner to open its next connection after delay, and closes this one if it is still open after
// that and the grace on top (§6.1).
// Only the first call counts: a connection welcomed while the drain began can be reached twice.
func (c *conn) drain(delay time.Duration) {
	c.drainOnce.Do(func() {
		c.send(&linkpb.Frame{Body: &linkpb.Frame_Drain{Drain: &linkpb.Drain{
			ReconnectAfterMs: uint32(delay / time.Millisecond),
		}}}, true)
		c.g.metrics.drainsSent.inc()
		c.after(delay+c.g.cfg.DrainGrace, func() {
			c.closeWith(linkpb.CloseCode_CLOSE_CODE_UNSPECIFIED, "the gateway is shutting down", 0,
				websocket.StatusGoingAway, "drained")
		})
	})
}

// after runs fn after d unless the connection has ended by then.
func (c *conn) after(d time.Duration, fn func()) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ctx.Err() != nil {
		return
	}
	c.timers = append(c.timers, time.AfterFunc(d, fn))
}

func (c *conn) pingLoop() {
	t := time.NewTicker(c.g.cfg.PingInterval)
	defer t.Stop()
	for {
		select {
		case <-c.ctx.Done():
			return
		case <-t.C:
		}
		ctx, cancel := context.WithTimeout(c.ctx, c.g.cfg.PingTimeout)
		start := time.Now()
		err := c.ws.Ping(ctx)
		cancel()
		if err != nil {
			if c.ctx.Err() == nil && errors.Is(err, context.DeadlineExceeded) {
				c.closeWith(linkpb.CloseCode_CLOSE_CODE_UNSPECIFIED, "no answer to a ping within "+c.g.cfg.PingTimeout.String(), 0,
					websocket.StatusPolicyViolation, "ping_timeout")
			}
			return
		}
		c.g.metrics.rtt.observe(time.Since(start))
		c.shadow.expire()
	}
}

// finish runs when reading has stopped: it lets the writer finish a close in progress, then lets go of everything
// the connection held.
func (c *conn) finish() {
	select {
	case <-c.closing:
		select {
		case <-c.writerDone:
		case <-time.After(15 * time.Second):
			_ = c.ws.CloseNow()
		}
	default:
	}
	c.cancel()
	<-c.writerDone
	_ = c.ws.CloseNow()

	c.mu.Lock()
	for _, t := range c.timers {
		t.Stop()
	}
	welcomed := c.welcomed
	c.mu.Unlock()
	c.chunks.close()
	c.shadow.close()
	if !welcomed {
		return
	}
	c.g.reg.remove(c)
	if c.g.hints != nil {
		c.g.hints.release(c.claims.RunnerID)
	}
	reason := "connection_lost"
	if r := c.reason.Load(); r != nil {
		reason = *r
	} else if websocket.CloseStatus(c.readError) != -1 {
		reason = "client_closed"
	}
	c.g.metrics.connections.add(-1)
	c.g.metrics.disconnects.inc(reason)
	c.log.Info("connection closed", "reason", reason)
}

// logFrame writes a frame's summary when LINK_FRAME_LOG asks for it: "all" for every frame, "lifecycle" for those
// that open, end or move a connection.
func (c *conn) logFrame(dir string, f *linkpb.Frame) {
	switch c.g.cfg.FrameLog {
	case "off":
		return
	case "lifecycle":
		switch f.GetBody().(type) {
		case *linkpb.Frame_Hello, *linkpb.Frame_Welcome, *linkpb.Frame_Drain, *linkpb.Frame_Close,
			*linkpb.Frame_TokenRefresh, *linkpb.Frame_Redirect:
		default:
			return
		}
	}
	c.log.Info("frame", "dir", dir, "frame", summarize(f))
}
