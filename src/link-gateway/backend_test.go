package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// stalledBackend answers nothing until release is closed.
type stalledBackend struct {
	srv     *httptest.Server
	release chan struct{}
}

func newStalledBackend(t *testing.T) *stalledBackend {
	b := &stalledBackend{release: make(chan struct{})}
	b.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case <-b.release:
		case <-r.Context().Done():
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{})
	}))
	t.Cleanup(func() {
		select {
		case <-b.release:
		default:
			close(b.release)
		}
		b.srv.Close()
	})
	return b
}

// countedConn counts itself out of live when it closes.
type countedConn struct {
	net.Conn
	live *atomic.Int64
	once sync.Once
}

func (c *countedConn) Close() error {
	c.once.Do(func() { c.live.Add(-1) })
	return c.Conn.Close()
}

func newTestPool(t *testing.T, mutate func(*config)) *backendPool {
	cfg := testConfig()
	cfg.InternalAPIURLs = []string{"http://127.0.0.1:1"}
	if mutate != nil {
		mutate(&cfg)
	}
	return newBackendPool(cfg, newGatewayMetrics("test", &denyList{set: map[string]struct{}{}}), slog.New(slog.NewTextHandler(io.Discard, nil)))
}

// With its backend stalled, the gateway opens no more connections to it than LINK_BACKEND_MAX_CONNS, however many
// calls come: the rest wait for one. A call that waits past LINK_RPC_TIMEOUT ends BACKEND_TIMEOUT, and one whose runner
// leaves while it waits ends CANCELLED, neither having been written to the backend. Once the backend answers again, the
// calls after go over the same connections.
func TestStalledBackendsGetNoMoreConnectionsThanTheCap(t *testing.T) {
	const capPerHost, calls = 4, 200
	b := newStalledBackend(t)
	p := newTestPool(t, func(c *config) {
		c.InternalAPIURLs = []string{b.srv.URL}
		c.BackendMaxConns = capPerHost
		c.RPCTimeout = 700 * time.Millisecond
		c.link.RetryBudget = 5 * time.Second
	})

	// What the gateway holds open to the backend, counted at its own end: a connection it closes may still hold a
	// stalled handler at the backend's.
	var live, peak, dialed atomic.Int64
	tr := p.client.Transport.(*http.Transport)
	dial := tr.DialContext
	tr.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		nc, err := dial(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		dialed.Add(1)
		n := live.Add(1)
		for p := peak.Load(); n > p && !peak.CompareAndSwap(p, n); p = peak.Load() {
		}
		return &countedConn{Conn: nc, live: &live}, nil
	}

	errs := make([]error, calls)
	var wg sync.WaitGroup
	// A tenth of the calls' runners leave while they wait.
	leave, leaveNow := context.WithCancel(context.Background())
	for i := range calls {
		ctx := context.Background()
		if i%10 == 0 {
			ctx = leave
		}
		call := backendCall{kind: "heartbeat", method: "POST", path: "/api/runner/heartbeat", body: []byte(`{}`), idempotent: true}
		if i%2 == 1 {
			call = backendCall{kind: "rpc", method: "POST", path: "/api/runner/sessions/x/turn-complete", body: []byte(`{}`)}
		}
		wg.Go(func() { _, errs[i] = p.do(ctx, call) })
	}
	time.Sleep(200 * time.Millisecond)
	leaveNow()
	wg.Wait()

	if peak.Load() > capPerHost {
		t.Fatalf("the gateway held %d connections to a stalled backend at once; the cap is %d", peak.Load(), capPerHost)
	}
	// A connection is dialed again only to replace one a call written on it closed (cancelled or timed out), never
	// beside the cap's.
	if dialed.Load() < capPerHost || dialed.Load() >= calls/2 {
		t.Fatalf("%d connections dialed for %d calls; the cap is %d", dialed.Load(), calls, capPerHost)
	}
	t.Logf("%d calls on a stalled backend: at most %d connections at once, %d dialed in all", calls, peak.Load(), dialed.Load())
	var timedOut, cancelled, cutOff int
	for i, err := range errs {
		switch {
		case errors.Is(err, errBackendTimeout):
			timedOut++
		case errors.Is(err, errCallCancelled):
			cancelled++
			if i%10 != 0 {
				t.Errorf("call %d was cancelled; its runner stayed", i)
			}
		case errors.Is(err, errBackendCutOff):
			// One of the calls written to the stalled backend, not idempotent, whose connection the timeout cut.
			cutOff++
		default:
			t.Errorf("call %d ended %v", i, err)
		}
	}
	if cancelled != calls/10 || cutOff > capPerHost || timedOut < calls-calls/10-capPerHost {
		t.Fatalf("timed out %d, cancelled %d, cut off %d of %d", timedOut, cancelled, cutOff, calls)
	}
	// The waiting calls never reached the backend: nothing it could have stored was cut off by the gateway.
	if got := p.m.backendCalls.get("rpc", "timeout") + p.m.backendCalls.get("heartbeat", "timeout"); int(got) != timedOut {
		t.Fatalf("timeout metric %v, want %d", got, timedOut)
	}

	// The backend comes back: calls go through on the connections the cap allows, none of them dialed again.
	close(b.release)
	before := dialed.Load()
	for range 3 {
		var wg sync.WaitGroup
		for range 50 {
			wg.Go(func() {
				if _, err := p.do(context.Background(), backendCall{kind: "heartbeat", method: "POST", path: "/api/runner/heartbeat", idempotent: true}); err != nil {
					t.Errorf("after the stall: %v", err)
				}
			})
		}
		wg.Wait()
	}
	if peak.Load() > capPerHost {
		t.Fatalf("%d connections at once after the stall; the cap is %d", peak.Load(), capPerHost)
	}
	if dialed.Load()-before > capPerHost {
		t.Fatalf("%d connections dialed after the stall", dialed.Load()-before)
	}
}

func TestBackendMaxConnsIsConfigured(t *testing.T) {
	env := minimalEnv(t)
	c, err := configFromEnv(func(k string) string { return env[k] })
	if err != nil || c.BackendMaxConns != defaultBackendMaxConns {
		t.Fatalf("default: %d, %v", c.BackendMaxConns, err)
	}
	env["LINK_BACKEND_MAX_CONNS"] = "32"
	if c, err = configFromEnv(func(k string) string { return env[k] }); err != nil || c.BackendMaxConns != 32 {
		t.Fatalf("LINK_BACKEND_MAX_CONNS=32: %d, %v", c.BackendMaxConns, err)
	}
	env["LINK_BACKEND_MAX_CONNS"] = "0"
	if _, err = configFromEnv(func(k string) string { return env[k] }); err == nil {
		t.Fatal("LINK_BACKEND_MAX_CONNS=0 was taken")
	}
	p := newTestPool(t, func(c *config) { c.BackendMaxConns = 7 })
	tr := p.client.Transport.(*http.Transport)
	if tr.MaxConnsPerHost != 7 || tr.MaxIdleConnsPerHost != 7 {
		t.Fatalf("transport: %d per host, %d idle", tr.MaxConnsPerHost, tr.MaxIdleConnsPerHost)
	}
}

// minimalEnv is the least configuration the gateway starts with.
func minimalEnv(t *testing.T) map[string]string {
	keys := newTestKeys(t)
	return map[string]string{
		"LINK_PUBLIC_KEYS": publicPEM(t, keys.pub), "LINK_GATEWAY_TOKEN": strings.Repeat("g", 32),
		"LINK_API_URL": "http://apiserver:3000", "LINK_TLS_MODE": "off",
		"LINK_INTERNAL_API_URLS": "http://apiserver:3001",
	}
}
