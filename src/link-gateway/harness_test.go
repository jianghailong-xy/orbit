package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/pem"
	"log/slog"
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

// A gateway on an httptest TLS server, its signing key, and runners to connect to it.

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type harness struct {
	t    *testing.T
	keys testKeys
	g    *gateway
	srv  *httptest.Server
	url  string
	logs *syncBuffer
}

func testConfig() config {
	return config{
		TLSMode: "off", CellID: "cell-1", APIURL: "http://127.0.0.1:1", GatewayToken: strings.Repeat("g", 32),
		RevocationInterval: time.Minute,
		HeartbeatInterval:  defaultHeartbeatInterval, PingInterval: defaultPingInterval, PingTimeout: defaultPingTimeout,
		HelloTimeout: 2 * time.Second, HandshakeTimeout: 2 * time.Second,
		IPRate: 1000, IPBurst: 1000, HandshakeRate: 1000, HandshakeBurst: 1000,
		MaxConnsPerRunner: defaultMaxConnsPerRunner,
		DrainBatch:        100, DrainBatchInterval: 100 * time.Millisecond,
		DrainReconnectMin: 100 * time.Millisecond, DrainReconnectMax: 300 * time.Millisecond,
		DrainGrace: 300 * time.Millisecond, DrainTimeout: 10 * time.Second,
		FrameLog: "all", Mode: linkpb.Mode_MODE_HTTP,
	}
}

func newHarness(t *testing.T, mutate func(*config)) *harness {
	t.Helper()
	k := newTestKeys(t)
	cfg := testConfig()
	cfg.PublicKeys = []ed25519.PublicKey{k.pub}
	if mutate != nil {
		mutate(&cfg)
	}
	logs := &syncBuffer{}
	g := newGateway(cfg, slog.New(slog.NewTextHandler(logs, nil)))
	srv := httptest.NewUnstartedServer(g)
	srv.Config.ReadHeaderTimeout = cfg.HandshakeTimeout
	srv.EnableHTTP2 = false
	srv.StartTLS()
	h := &harness{t: t, keys: k, g: g, srv: srv, url: "wss://" + srv.Listener.Addr().String(), logs: logs}
	t.Cleanup(func() {
		for _, c := range g.reg.snapshot() {
			c.closeWith(linkpb.CloseCode_CLOSE_CODE_UNSPECIFIED, "test over", 0, websocket.StatusGoingAway, "shutdown")
		}
		deadline := time.Now().Add(15 * time.Second)
		for g.reg.count() > 0 && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
		srv.Close()
		if t.Failed() {
			t.Logf("gateway log:\n%s", logs.String())
		}
	})
	return h
}

// token is a valid link token for process on runner, an hour long.
func (h *harness) token(runner, process string) string {
	return h.keys.sign(tokenClaims(runner, process, time.Now().Add(time.Hour)))
}

// testConn is a runner's side of a connection.
type testConn struct {
	t      testing.TB
	ws     *websocket.Conn
	frames chan *linkpb.Frame
	done   chan struct{}
	err    error
	outID  uint64
}

// dial upgrades with token; a refusal comes back as the HTTP response.
func (h *harness) dial(token string) (*testConn, *http.Response, error) {
	h.t.Helper()
	header := http.Header{}
	if token != "" {
		header.Set("Authorization", "Bearer "+token)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, resp, err := websocket.Dial(ctx, h.url, &websocket.DialOptions{HTTPClient: h.srv.Client(), HTTPHeader: header})
	if err != nil {
		return nil, resp, err
	}
	ws.SetReadLimit(maxChunkedFrameBytes)
	tc := &testConn{t: h.t, ws: ws, frames: make(chan *linkpb.Frame, 256), done: make(chan struct{})}
	go tc.read()
	h.t.Cleanup(func() { _ = ws.CloseNow() })
	return tc, resp, nil
}

// connect dials and completes the handshake as process of runner, returning the Welcome.
func (h *harness) connect(runner, process string) (*testConn, *linkpb.Welcome) {
	h.t.Helper()
	tc, resp, err := h.dial(h.token(runner, process))
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		h.t.Fatalf("dial: %v (status %d)", err, status)
	}
	tc.send(helloFrame(process))
	w := tc.expect("welcome", 5*time.Second).GetWelcome()
	return tc, w
}

func helloFrame(process string) *linkpb.Frame {
	return &linkpb.Frame{Body: &linkpb.Frame_Hello{Hello: &linkpb.Hello{
		ProcessId: process, RunnerVersion: "test-runner/1", Os: "linux", MinProtocolVersion: 1, MaxProtocolVersion: 1,
	}}}
}

func (tc *testConn) read() {
	defer close(tc.done)
	for {
		_, data, err := tc.ws.Read(context.Background())
		if err != nil {
			tc.err = err
			return
		}
		f := &linkpb.Frame{}
		if err := proto.Unmarshal(data, f); err != nil {
			tc.err = err
			return
		}
		tc.frames <- f
	}
}

func (tc *testConn) send(f *linkpb.Frame) {
	tc.t.Helper()
	tc.outID++
	f.Id = tc.outID
	b, err := proto.Marshal(f)
	if err != nil {
		tc.t.Fatal(err)
	}
	tc.sendRaw(b)
}

func (tc *testConn) sendRaw(b []byte) {
	tc.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := tc.ws.Write(ctx, websocket.MessageBinary, b); err != nil {
		tc.t.Fatalf("write: %v", err)
	}
}

// expect waits for the next frame and checks its body.
func (tc *testConn) expect(body string, timeout time.Duration) *linkpb.Frame {
	tc.t.Helper()
	select {
	case f := <-tc.frames:
		if bodyName(f) != body {
			tc.t.Fatalf("got %s, want %s", summarize(f), body)
		}
		return f
	case <-tc.done:
		tc.t.Fatalf("connection ended waiting for %s: %v", body, tc.err)
	case <-time.After(timeout):
		tc.t.Fatalf("no %s within %s", body, timeout)
	}
	return nil
}

// closed waits for the connection to end and returns the Close frame that came before, if any.
func (tc *testConn) closed(timeout time.Duration) *linkpb.Close {
	tc.t.Helper()
	var last *linkpb.Close
	deadline := time.After(timeout)
	for {
		select {
		case f := <-tc.frames:
			if c := f.GetClose(); c != nil {
				last = c
			}
		case <-tc.done:
			for {
				select {
				case f := <-tc.frames:
					if c := f.GetClose(); c != nil {
						last = c
					}
				default:
					return last
				}
			}
		case <-deadline:
			tc.t.Fatalf("connection still open after %s", timeout)
			return nil
		}
	}
}

// eventually polls cond until it holds or the timeout passes.
func eventually(t testing.TB, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("%s: not within %s", what, timeout)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func publicPEM(t testing.TB, pub ed25519.PublicKey) string {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}
