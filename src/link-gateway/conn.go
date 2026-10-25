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
// one goroutine writes from three queues (control frames first, then hints and RPC results, then the live stream's)
// and one pings. Its state lives in memory only; a runner that loses it reconnects.
type conn struct {
	g      *gateway
	ws     *websocket.Conn
	id     string
	claims *linkClaims
	// token is the link token the connection was opened with, which every call forwarded for it presents
	// (X-Orbit-Runner-Link-Token): the apiserver checks it on each one.
	token  string
	remote string
	// mode is what the gateway told runners when the connection opened, which its Welcome says, and what it has to
	// forward with. Its HeartbeatAcks say what the gateway tells runners now (mode.go).
	mode linkpb.Mode
	log  *slog.Logger
	// started is when the upgrade request arrived; the handshake's duration ends when Welcome is written.
	started time.Time

	ctx    context.Context
	cancel context.CancelFunc

	queues [tierCount]chan outItem
	outID  atomic.Uint64
	// queued is the encoded size of the frames queued and not yet written, bounded by maxQueuedBytes.
	queued atomic.Int64
	// writeWS writes one WebSocket message: the connection's, or a test's stand-in.
	writeWS func(ctx context.Context, b []byte) error

	closeOnce  sync.Once
	drainOnce  sync.Once
	closing    chan struct{}
	writerDone chan struct{}
	reason     atomic.Pointer[string] // why the connection ended; the first to say so wins

	mu         sync.Mutex
	hello      *linkpb.Hello
	timers     []*time.Timer
	welcomed   bool
	welcomedAt time.Time

	chunks reassembler
	shadow *shadowState
	// link is what a MODE_LINK connection forwards with (forward.go, heartbeat.go, events.go, live.go); nil in
	// MODE_HTTP.
	link *linkState
	// readError is why reading stopped; only the reading goroutine touches it.
	readError error
}

type outItem struct {
	frame *linkpb.Frame
	close *closeRequest
	// size is the frame's encoded size, which counts against maxQueuedBytes until it is written.
	size int64
}

// closeRequest is the last thing the writer does: the Close frame, when there is one, then the WebSocket close.
type closeRequest struct {
	frame  *linkpb.Frame
	status websocket.StatusCode
	text   string
}

// The three priorities frames are written in (§5.1). A tier is written only while every tier above it is empty, and
// a frame sent in pieces (Chunk) yields to a higher tier between two pieces.
type tier int

const (
	// tierControl: Welcome, Close, Drain, HeartbeatAck, EventAck, Credit. A full queue means the runner is not
	// reading, and closes the connection (CLOSE_CODE_SLOW_CONSUMER).
	tierControl tier = iota
	// tierNormal: hints and RPC results. A hint finding the queue full is dropped; an RPC result closes the
	// connection, as a control frame does, since the runner waits for it.
	tierNormal
	// tierLive: what serves the live stream (TurnPrefixRequest). Best effort: a full queue drops the frame.
	tierLive
	tierCount
)

const (
	controlQueue = 64
	normalQueue  = 256
	liveQueue    = 64
	// maxQueuedBytes bounds what one connection's queues hold, whatever their count: answers can be megabytes each, and
	// a runner that stops reading must not make the gateway hold them all.
	maxQueuedBytes = 32 << 20
	writeTimeout   = 10 * time.Second
)

var tierNames = [tierCount]string{"control", "normal", "live"}

func newConn(g *gateway, ws *websocket.Conn, claims *linkClaims, remote string) *conn {
	ctx, cancel := context.WithCancel(context.Background())
	c := &conn{
		g: g, ws: ws, id: newConnectionID(), claims: claims, remote: remote, mode: g.mode(),
		ctx: ctx, cancel: cancel,
		queues: [tierCount]chan outItem{
			tierControl: make(chan outItem, controlQueue),
			tierNormal:  make(chan outItem, normalQueue),
			tierLive:    make(chan outItem, liveQueue),
		},
		closing: make(chan struct{}), writerDone: make(chan struct{}),
	}
	c.log = g.log.With("conn", c.id, "runner", claims.RunnerID, "process", claims.LeaseOwner, "remote", remote)
	c.writeWS = func(ctx context.Context, b []byte) error { return ws.Write(ctx, websocket.MessageBinary, b) }
	c.shadow = newShadowState(c)
	// Forwarding needs somewhere to forward to: configuration requires backends in MODE_LINK, and a gateway built
	// without them (as some tests build it) forwards nothing.
	if c.mode == linkpb.Mode_MODE_LINK && g.backends != nil {
		c.link = newLinkState(c)
	}
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
	// What Welcome says of the Hello's sessions and of the runner's release, as the welcome route answers it (welcome.go).
	// Asked before this connection takes over from an older one of the process, which carries the work meanwhile.
	var sessions []*linkpb.SessionState
	var release *linkpb.AssignedRelease
	if c.link != nil {
		c.link.greeted(hello)
		sessions, release = c.link.welcome(hello)
	}
	if old := c.g.reg.activate(c); old != nil {
		old.closeWith(linkpb.CloseCode_CLOSE_CODE_SUPERSEDED, "a newer connection of this process took over", 0,
			websocket.StatusNormalClosure, "superseded")
	}
	// Counted, queued and marked as sent under one lock. offer takes the same lock, so a hint relayed while this Welcome
	// is on its way to the runner waits and follows it, rather than being dropped for a connection the runner already
	// has. And a runner that holds its Welcome is already counted.
	c.mu.Lock()
	m.connections.add(1)
	m.handshakes.inc("ok")
	credit := c.g.credit.current()
	c.send(&linkpb.Frame{Body: &linkpb.Frame_Welcome{Welcome: &linkpb.Welcome{
		ProtocolVersion:     1,
		Mode:                c.mode,
		HeartbeatIntervalMs: uint32(c.g.cfg.HeartbeatInterval / time.Millisecond),
		Limits:              &linkpb.Limits{MaxFrameBytes: maxFrameBytes},
		Credit:              &linkpb.Credit{MaxUnackedEvents: credit.Events, MaxUnackedBytes: credit.Bytes},
		Sessions:            sessions,
		Hints:               &linkpb.HintState{},
		Release:             release,
		ConnectionId:        c.id,
	}}}, true)
	c.welcomed = true
	c.welcomedAt = time.Now()
	c.mu.Unlock()
	if c.link != nil {
		c.link.start(credit)
	}
	// Subscribed once Welcome is queued, so no hint can be written ahead of it.
	if c.g.hints != nil {
		c.g.hints.hold(c.claims.RunnerID)
	}

	// The token's lifetime is the connection's: this version cannot renew it in the connection (TokenRefresh), so the
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

// dispatch handles one frame from the runner and reports whether to go on reading. Nothing in it waits for a backend:
// what is forwarded is handed to the connection's workers (forward.go, heartbeat.go, events.go), which bound it.
func (c *conn) dispatch(f *linkpb.Frame) bool {
	c.g.metrics.framesReceived.inc(bodyName(f))
	c.logFrame("in", f)
	switch body := f.GetBody().(type) {
	case *linkpb.Frame_Heartbeat:
		c.onHeartbeat(f.GetId(), body.Heartbeat, proto.Size(f))
	case *linkpb.Frame_EventBatch:
		switch {
		case c.link != nil:
			// Forwarded even once RUNNER_LINK_REQUIRED is switched off, until the runner leaves the connection: the
			// ingest stores each seq once, so a batch stored here is not stored again when the runner resends it.
			c.link.onEvents(body.EventBatch)
		case c.mode == linkpb.Mode_MODE_HTTP:
			// No EventAck: in MODE_HTTP nothing is stored, and an ack says the events are (§5.8).
			c.shadow.typed(f.GetId(), &shadowEntry{kind: "events", events: body.EventBatch}, proto.Size(f))
		}
	case *linkpb.Frame_Rpc:
		c.onRpc(body.Rpc, proto.Size(f))
	case *linkpb.Frame_LiveBatch:
		// In MODE_HTTP a live batch is counted and dropped: the shadow period publishes no live stream.
		if c.link != nil {
			c.link.onLive(body.LiveBatch)
		}
	case *linkpb.Frame_TurnPrefixResponse:
		if c.link != nil {
			c.link.onPrefixAnswer(body.TurnPrefixResponse)
		}
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
	// Bodies the gateway sends rather than receives, and those of a newer protocol, are ignored
	// (contracts/runner-link/v1).
	return true
}

// onHeartbeat records the beat and answers it (§5.7). In MODE_LINK the beat is forwarded to the apiserver's heartbeat
// route and answered with what it says (heartbeat.go). In MODE_HTTP it is the typed half of a mirror: answered at once
// with MODE_HTTP and nothing to apply, and compared, never forwarded.
//
// The answer states the mode the gateway tells runners now, which may not be the connection's (mode.go): a MODE_HTTP
// connection is told MODE_LINK once RUNNER_LINK_REQUIRED is on, and a MODE_LINK connection MODE_HTTP once it is off.
// Then the beat is not forwarded either, and the runner, which applies nothing of an answer saying MODE_HTTP, sends it
// again over HTTPS.
func (c *conn) onHeartbeat(frameID uint64, hb *linkpb.Heartbeat, size int) {
	c.g.metrics.heartbeats.inc()
	mode := c.g.mode()
	if c.link != nil && mode == linkpb.Mode_MODE_LINK {
		c.link.onHeartbeat(hb)
		return
	}
	c.send(&linkpb.Frame{Body: &linkpb.Frame_HeartbeatAck{HeartbeatAck: &linkpb.HeartbeatAck{
		Mode: mode, Hints: &linkpb.HintState{},
	}}}, true)
	if c.mode == linkpb.Mode_MODE_HTTP {
		c.shadow.typed(frameID, &shadowEntry{kind: "heartbeat", heartbeat: hb}, size)
	}
}

// mayForward is the one check an Rpc passes before it may reach a backend. Two things hold whatever is behind it: a
// connection in MODE_HTTP forwards nothing, and a shadow mirror (request_id "shadow:...") is never forwarded, in any
// mode. TestRpcForwardingInvariants pins both.
func mayForward(mode linkpb.Mode, rpc *linkpb.Rpc) bool {
	return mode == linkpb.Mode_MODE_LINK && !strings.HasPrefix(rpc.GetRequestId(), shadowPrefix)
}

// onRpc compares a mirror with its typed frame and answers every Rpc with exactly one RpcResult: forwarded in
// MODE_LINK (forward.go), refused otherwise. A connection opened in MODE_LINK is in MODE_HTTP once RUNNER_LINK_REQUIRED
// is switched off (mode.go): its calls are refused LINK_MODE_HTTP, and the runner sends them again over HTTPS.
func (c *conn) onRpc(rpc *linkpb.Rpc, size int) {
	shadow := strings.HasPrefix(rpc.GetRequestId(), shadowPrefix)
	if shadow {
		c.shadow.mirror(rpc, size)
	}
	mode := c.mode
	if c.g.mode() != linkpb.Mode_MODE_LINK {
		mode = linkpb.Mode_MODE_HTTP
	}
	if mayForward(mode, rpc) && c.g.forward != nil {
		c.g.metrics.rpcs.inc("forwarded")
		c.g.forward(c, rpc)
		return
	}
	code, message := "NOT_FORWARDED", "this gateway has no backend to forward requests to"
	switch {
	case mode != linkpb.Mode_MODE_LINK:
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

// send queues a frame the runner must get: a control frame (control) or an RPC result. A queue that is full means the
// runner is not reading: the connection is closed as a slow consumer rather than allowed to hold memory (§6.1).
func (c *conn) send(f *linkpb.Frame, control bool) {
	t := tierNormal
	if control {
		t = tierControl
	}
	c.sendTier(f, t)
}

func (c *conn) sendTier(f *linkpb.Frame, t tier) {
	f.Id = c.outID.Add(1)
	select {
	case <-c.closing:
		return
	default:
	}
	size := int64(proto.Size(f))
	if c.queued.Add(size) > maxQueuedBytes {
		c.queued.Add(-size)
		c.slowConsumer(t, "the runner reads too slowly: its queued frames passed their bound in bytes")
		return
	}
	select {
	case c.queues[t] <- outItem{frame: f, size: size}:
	default:
		c.queued.Add(-size)
		c.slowConsumer(t, "the runner reads too slowly")
	}
}

func (c *conn) slowConsumer(t tier, message string) {
	c.g.metrics.queueFull.inc(tierNames[t], "closed")
	c.closeWith(linkpb.CloseCode_CLOSE_CODE_SLOW_CONSUMER, message, 0, websocket.StatusPolicyViolation, "slow_consumer")
}

// offer queues a hint, which is sent at most once (§5.2). Unlike send, a full queue drops it instead of closing the
// connection: a burst of hints must not cost a runner that is slow to read its connection. Nothing is offered before
// Welcome.
func (c *conn) offer(f *linkpb.Frame) bool {
	return c.offerTier(f, tierNormal)
}

// offerLive queues a frame of the live stream's tier, dropping it when the queue is full (§6.1: a full live queue
// drops, it never closes the connection).
func (c *conn) offerLive(f *linkpb.Frame) bool {
	return c.offerTier(f, tierLive)
}

func (c *conn) offerTier(f *linkpb.Frame, t tier) bool {
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
	size := int64(proto.Size(f))
	if c.queued.Add(size) > maxQueuedBytes {
		c.queued.Add(-size)
		c.g.metrics.queueFull.inc(tierNames[t], "dropped")
		return false
	}
	select {
	case c.queues[t] <- outItem{frame: f, size: size}:
		return true
	default:
		c.queued.Add(-size)
		c.g.metrics.queueFull.inc(tierNames[t], "dropped")
		return false
	}
}

// writeLoop writes what the queues hold, one WebSocket message at a time: the highest tier first, and within a tier
// in order. A frame over Limits.max_frame_bytes goes out as several messages (Chunk), and between two of them the loop
// looks again, so a control frame queued meanwhile is written before the frame's next piece (§5.1).
func (c *conn) writeLoop() {
	defer close(c.writerDone)
	// The pieces still to write of the frame each tier is in the middle of, and that frame.
	var rest [tierCount][][]byte
	var current [tierCount]outItem
	for {
		t, it, ok := c.nextToWrite(&rest)
		if !ok {
			return
		}
		if len(rest[t]) == 0 {
			if it.close != nil {
				if it.close.frame != nil {
					_ = c.writeFrameWhole(it.close.frame)
				}
				_ = c.ws.Close(it.close.status, it.close.text)
				return
			}
			msgs, err := encodeFrame(it.frame, maxFrameBytes, func() uint64 { return c.outID.Add(1) })
			if err != nil {
				c.queued.Add(-it.size)
				c.log.Error("a frame does not encode; not sent", "frame", summarize(it.frame), "err", err)
				continue
			}
			rest[t], current[t] = msgs, it
		}
		if err := c.writeMessage(rest[t][0]); err != nil {
			// A write cut short because the connection is ending is finish's to close; any other failure is the
			// connection lost.
			if c.ctx.Err() == nil {
				c.setReason("connection_lost")
				_ = c.ws.CloseNow()
			}
			return
		}
		rest[t] = rest[t][1:]
		if len(rest[t]) == 0 {
			c.queued.Add(-current[t].size)
			c.wrote(current[t].frame)
			current[t] = outItem{}
		}
	}
}

// nextToWrite is the tier to write next and, when that tier has no frame in progress, the item it starts. It waits
// when nothing is ready, and reports false once the connection is over.
func (c *conn) nextToWrite(rest *[tierCount][][]byte) (tier, outItem, bool) {
	for t := tierControl; t < tierCount; t++ {
		if len(rest[t]) > 0 {
			return t, outItem{}, true
		}
		select {
		case it := <-c.queues[t]:
			return t, it, true
		default:
		}
	}
	select {
	case it := <-c.queues[tierControl]:
		return tierControl, it, true
	case it := <-c.queues[tierNormal]:
		return tierNormal, it, true
	case it := <-c.queues[tierLive]:
		return tierLive, it, true
	case <-c.ctx.Done():
		return 0, outItem{}, false
	}
}

func (c *conn) writeMessage(b []byte) error {
	ctx, cancel := context.WithTimeout(c.ctx, writeTimeout)
	defer cancel()
	return c.writeWS(ctx, b)
}

// writeFrameWhole writes a frame's every piece back to back: the Close frame, after which nothing else is written.
func (c *conn) writeFrameWhole(f *linkpb.Frame) error {
	msgs, err := encodeFrame(f, maxFrameBytes, func() uint64 { return c.outID.Add(1) })
	if err != nil {
		return err
	}
	for _, b := range msgs {
		if err := c.writeMessage(b); err != nil {
			return err
		}
	}
	c.wrote(f)
	return nil
}

// wrote counts and logs a frame once its last piece is written.
func (c *conn) wrote(f *linkpb.Frame) {
	c.g.metrics.framesSent.inc(bodyName(f))
	if f.GetWelcome() != nil {
		c.g.metrics.handshakeDuration.observe(time.Since(c.started))
	}
	c.logFrame("out", f)
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
		case c.queues[tierControl] <- outItem{close: &closeRequest{frame: f, status: status, text: text}}:
		default:
			go func() { _ = c.ws.Close(status, text) }()
		}
	})
}

func (c *conn) setReason(reason string) {
	c.reason.CompareAndSwap(nil, &reason)
}

// welcomeTime is when the connection's Welcome was queued; zero before.
func (c *conn) welcomeTime() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.welcomedAt
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
// the connection held. Cancelling the connection's context aborts every call still forwarded for it, so a route
// that watches its request close (the claim) sees the runner hang up, as over HTTPS (§6.4).
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
	if c.link != nil {
		c.link.close()
	}
	if c.g.hints != nil {
		c.g.hints.release(c.claims.RunnerID)
	} else if len(c.g.reg.connsOf(c.claims.RunnerID)) == 0 {
		// Without NATS the watchers came from heartbeat answers alone; nobody is left to tell.
		c.g.watchers.drop(c.claims.RunnerID)
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
