package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

// Pings on a slow path (§15.15): the gateway does not ping a runner it is hearing from, a ping that waited out the
// library's 5 s for the write lock is tried again, and a ping or a message whose write stalled past its deadline ends
// the connection as write_timeout.

// rawConnect dials as process A of runner A and says Hello, and never reads: a runner that sends no pong.
func rawConnect(t *testing.T, h *harness) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, h.url, &websocket.DialOptions{
		HTTPClient: h.srv.Client(), HTTPHeader: http.Header{"Authorization": {"Bearer " + h.token(runnerA, processA)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ws.CloseNow() })
	b, _ := proto.Marshal(helloFrame(processA))
	if err := ws.Write(ctx, websocket.MessageBinary, b); err != nil {
		t.Fatal(err)
	}
	eventually(t, 5*time.Second, "the connection welcomed", func() bool { return h.g.reg.count() == 1 })
	return ws
}

// sendFor writes a frame the gateway ignores (a HeartbeatAck, which only the gateway sends) every 20 ms for d.
func sendFor(t *testing.T, ws *websocket.Conn, d time.Duration) {
	t.Helper()
	b, _ := proto.Marshal(&linkpb.Frame{Id: 1, Body: &linkpb.Frame_HeartbeatAck{HeartbeatAck: &linkpb.HeartbeatAck{}}})
	for end := time.Now().Add(d); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := ws.Write(ctx, websocket.MessageBinary, b)
		cancel()
		if err != nil {
			t.Fatalf("write: %v", err)
		}
	}
}

// A runner that answers pongs is not pinged while it sends, and is pinged again once it goes quiet.
func TestPingsSkipARunnerThatIsHeardFrom(t *testing.T) {
	h := newHarness(t, func(c *config) { c.PingInterval, c.PingTimeout = 300*time.Millisecond, 5*time.Second })
	tc, _ := h.connect(runnerA, processA)
	sendFor(t, tc.ws, 2*time.Second)
	if n, _ := h.g.metrics.rtt.snapshot(); n != 0 {
		t.Fatalf("%d pings answered while the runner was sending, want none sent", n)
	}
	eventually(t, 5*time.Second, "a quiet runner pinged", func() bool { n, _ := h.g.metrics.rtt.snapshot(); return n >= 2 })
}

// A runner that answers no pong stays connected as long as it is heard from, well past the ping timeout, and is
// disconnected with ping_timeout once it has been quiet for an interval and the timeout.
func TestARunnerThatSendsNeedsNoPong(t *testing.T) {
	h := newHarness(t, func(c *config) { c.PingInterval, c.PingTimeout = 300*time.Millisecond, 300*time.Millisecond })
	ws := rawConnect(t, h)
	c := h.g.reg.snapshot()[0]
	sendFor(t, ws, 2*time.Second)
	if r := reasonOf(c); r != "" {
		t.Fatalf("a runner the gateway was hearing from was disconnected: %s", r)
	}
	quiet := time.Now()
	// Counted once the close is over: a runner that does not read takes the library's 5 s to give up on its close.
	eventually(t, 15*time.Second, "ping_timeout counted", func() bool { return h.g.metrics.disconnects.get("ping_timeout") == 1 })
	if d := time.Since(quiet); d < 300*time.Millisecond {
		t.Fatalf("disconnected %s after it went quiet, before a ping could time out", d)
	}
}

// stallConn is the gateway's side of a TCP connection whose writes block while stalled, as a full send buffer on a
// lossy path does. Closing it ends a blocked write, as closing a socket does.
type stallConn struct {
	net.Conn
	mu        sync.Mutex
	stall     chan struct{}
	closed    chan struct{}
	closeOnce sync.Once
}

func (s *stallConn) Write(p []byte) (int, error) {
	s.mu.Lock()
	stall := s.stall
	s.mu.Unlock()
	if stall != nil {
		select {
		case <-stall:
		case <-s.closed:
			return 0, net.ErrClosed
		}
	}
	return s.Conn.Write(p)
}

func (s *stallConn) Close() error {
	s.closeOnce.Do(func() { close(s.closed) })
	return s.Conn.Close()
}

// stallFor stalls every write until d has passed (forever, with d zero) or the connection is closed.
func (s *stallConn) stallFor(d time.Duration) {
	ch := make(chan struct{})
	s.mu.Lock()
	s.stall = ch
	s.mu.Unlock()
	if d > 0 {
		time.AfterFunc(d, func() { close(ch) })
	}
}

type stallListener struct {
	net.Listener
	conns chan *stallConn
}

func (l stallListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	sc := &stallConn{Conn: c, closed: make(chan struct{})}
	l.conns <- sc
	return sc, nil
}

// stalledConn is a gateway connection, past its handshake and pinging, on a socket the test stalls, and the runner on
// its other end, which reads and so answers pings.
func stalledConn(t *testing.T, mutate func(*config)) (*harness, *conn, *stallConn) {
	t.Helper()
	h := newHarness(t, mutate)
	accepted := make(chan *websocket.Conn, 1)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		accepted <- ws
	}))
	sl := stallListener{Listener: srv.Listener, conns: make(chan *stallConn, 1)}
	srv.Listener = sl
	srv.Start()
	t.Cleanup(srv.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	runner, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	runner.SetReadLimit(maxChunkedFrameBytes)
	go func() {
		for {
			if _, _, err := runner.Read(context.Background()); err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() { _ = runner.CloseNow() })

	ws := <-accepted
	sc := <-sl.conns
	c := newConn(h.g, ws, &linkClaims{RunnerID: runnerA, LeaseOwner: processA}, "127.0.0.1")
	c.welcomed = true
	// The gateway reads, so that the runner's pongs are taken.
	go func() {
		for {
			if _, err := c.readFrame(); err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() {
		c.cancel()
		_ = ws.CloseNow()
	})
	return h, c, sc
}

func reasonOf(c *conn) string {
	if r := c.reason.Load(); r != nil {
		return *r
	}
	return ""
}

// A ping that finds the write lock held by a message stalled for 8 s gives up after the library's 5 s without having
// been written: the connection stays open, and the ping is tried again at the next interval, and answered.
func TestPingWrittenBehindABlockedWrite(t *testing.T) {
	t.Parallel()
	h, c, sc := stalledConn(t, func(c *config) { c.PingInterval, c.PingTimeout = 2*time.Second, 30*time.Second })
	start := time.Now()
	c.pings()
	sc.stallFor(8 * time.Second)
	// The writer's message takes the lock and holds it until the stall ends, within its 10 s write timeout.
	c.send(ackFrame(), true)

	eventually(t, 10*time.Second, "a ping blocked on the write lock", func() bool { return h.g.metrics.pingWriteBlocked.get() == 1 })
	if d := time.Since(start); d > 8*time.Second {
		t.Fatalf("the blocked ping gave up %s in, after the stall ended", d)
	}
	if n, _ := h.g.metrics.rtt.snapshot(); n != 0 || c.ctx.Err() != nil || reasonOf(c) != "" {
		t.Fatalf("after a blocked ping: %d round trips, ctx %v, reason %q", n, c.ctx.Err(), reasonOf(c))
	}
	eventually(t, 10*time.Second, "the ping tried again and answered", func() bool { n, _ := h.g.metrics.rtt.snapshot(); return n >= 1 })
	if time.Since(start) < 8*time.Second {
		t.Fatal("a ping was answered while the socket was stalled")
	}
	if c.ctx.Err() != nil || reasonOf(c) != "" || h.g.metrics.pingWriteBlocked.get() != 1 {
		t.Fatalf("ctx %v, reason %q, %v pings blocked", c.ctx.Err(), reasonOf(c), h.g.metrics.pingWriteBlocked.get())
	}
	if c.largestWrite.Load() == 0 || time.Duration(c.longestWrite.Load()) < 7*time.Second {
		t.Fatalf("largest write %d bytes, longest %s; want the stalled write's", c.largestWrite.Load(), time.Duration(c.longestWrite.Load()))
	}
}

// A ping written into a stalled socket passes its deadline, the library closes the connection, and the gateway says
// so: write_timeout, not ping_timeout.
func TestAPingWhoseWriteStallsIsAWriteTimeout(t *testing.T) {
	t.Parallel()
	h, c, sc := stalledConn(t, func(c *config) { c.PingInterval, c.PingTimeout = 100*time.Millisecond, 30*time.Second })
	sc.stallFor(0)
	c.pings()
	eventually(t, 15*time.Second, "write_timeout", func() bool { return reasonOf(c) == "write_timeout" })
	if h.g.metrics.pingWriteBlocked.get() != 1 {
		t.Fatalf("%v pings counted as not written", h.g.metrics.pingWriteBlocked.get())
	}
}

// A message written into a stalled socket passes the writer's 10 s, and the library closes the connection:
// write_timeout too.
func TestAMessageWhoseWriteStallsIsAWriteTimeout(t *testing.T) {
	t.Parallel()
	_, c, sc := stalledConn(t, nil)
	sc.stallFor(0)
	c.send(ackFrame(), true)
	eventually(t, 20*time.Second, "write_timeout", func() bool { return reasonOf(c) == "write_timeout" })
}
