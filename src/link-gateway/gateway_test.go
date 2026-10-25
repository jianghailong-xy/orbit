package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

const (
	runnerA  = "0190a0b0-0000-7000-8000-00000000000a"
	processA = "0190a0b0-0000-4000-8000-0000000000a1"
	processB = "0190a0b0-0000-4000-8000-0000000000a2"
	processC = "0190a0b0-0000-4000-8000-0000000000a3"
)

func TestHelloIsAnsweredWithWelcome(t *testing.T) {
	h := newHarness(t, nil)
	_, w := h.connect(runnerA, processA)
	if w.GetProtocolVersion() != 1 || w.GetMode() != linkpb.Mode_MODE_HTTP || w.GetHeartbeatIntervalMs() != 30000 ||
		w.GetLimits().GetMaxFrameBytes() != 256<<10 || !strings.HasPrefix(w.GetConnectionId(), "c-") {
		t.Fatalf("welcome %v", w)
	}
	if len(w.GetSessions()) != 0 {
		t.Fatalf("version 0 states no session: %v", w.GetSessions())
	}
	m := h.g.metrics
	if m.handshakes.get("ok") != 1 || m.connections.get() != 1 {
		t.Fatalf("handshakes ok %v, connections %v", m.handshakes.get("ok"), m.connections.get())
	}
	eventually(t, 5*time.Second, "the handshake's duration observed", func() bool { n, _ := m.handshakeDuration.snapshot(); return n == 1 })
}

// refusal reads an HTTP refusal of an upgrade.
func refusalBody(t *testing.T, resp *http.Response) map[string]any {
	t.Helper()
	if resp == nil {
		t.Fatal("no HTTP response")
	}
	var body map[string]any
	b, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(b, &body); err != nil {
		t.Fatalf("refusal body %q: %v", b, err)
	}
	return body
}

func TestTokensAreCheckedBeforeTheUpgrade(t *testing.T) {
	h := newHarness(t, nil)
	stranger := newTestKeys(t)
	cases := []struct {
		name, token, reason string
	}{
		{"no token", "", "MISSING"},
		{"garbage", "not.a.token", "MALFORMED"},
		{"another key", stranger.sign(tokenClaims(runnerA, processA, time.Now().Add(time.Hour))), "SIGNATURE"},
		{"expired", h.keys.sign(tokenClaims(runnerA, processA, time.Now().Add(-time.Second))), "EXPIRED"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, resp, err := h.dial(c.token)
			if err == nil {
				t.Fatal("upgraded")
			}
			body := refusalBody(t, resp)
			if resp.StatusCode != http.StatusUnauthorized || body["code"] != "UNAUTHENTICATED" || body["reason"] != c.reason {
				t.Fatalf("status %d body %v", resp.StatusCode, body)
			}
		})
	}
	h.g.deny.replace(map[string]struct{}{"cred-" + runnerA: {}})
	_, resp, _ := h.dial(h.token(runnerA, processA))
	if body := refusalBody(t, resp); body["reason"] != "REVOKED" {
		t.Fatalf("revoked credential: %v", body)
	}
	if got := h.g.metrics.tokenRefusals.get("REVOKED"); got != 1 {
		t.Fatalf("REVOKED refusals %v", got)
	}
}

func TestOnlyWebSocketUpgradesAreServed(t *testing.T) {
	h := newHarness(t, nil)
	resp, err := h.srv.Client().Get(h.srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUpgradeRequired || resp.Header.Get("Upgrade") != "websocket" {
		t.Fatalf("plain GET: %d %v", resp.StatusCode, resp.Header)
	}
}

// A connection that does not present a valid upgrade within the handshake timeout is cut (§6.1: unauthenticated
// connections are dropped within seconds).
func TestSilentConnectionsAreCutWithinSeconds(t *testing.T) {
	h := newHarness(t, nil)
	for _, name := range []string{"no TLS handshake", "TLS but no request"} {
		t.Run(name, func(t *testing.T) {
			raw, err := net.Dial("tcp", h.srv.Listener.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			defer raw.Close()
			var conn net.Conn = raw
			if name == "TLS but no request" {
				tc := tls.Client(raw, &tls.Config{InsecureSkipVerify: true})
				if err := tc.Handshake(); err != nil {
					t.Fatal(err)
				}
				conn = tc
			}
			start := time.Now()
			_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
			_, err = io.ReadAll(conn)
			if took := time.Since(start); took > 5*time.Second {
				t.Fatalf("still open after %s (err %v)", took, err)
			}
		})
	}
}

func TestHelloMustArriveInTime(t *testing.T) {
	h := newHarness(t, func(c *config) { c.HelloTimeout = 300 * time.Millisecond })
	tc, _, err := h.dial(h.token(runnerA, processA))
	if err != nil {
		t.Fatal(err)
	}
	c := tc.closed(10 * time.Second)
	if c.GetCode() != linkpb.CloseCode_CLOSE_CODE_PROTOCOL_ERROR {
		t.Fatalf("close %v", c)
	}
	eventually(t, 5*time.Second, "hello_timeout counted", func() bool { return h.g.metrics.handshakes.get("hello_timeout") == 1 })
	if h.g.reg.reserve(runnerA, processB) != true || h.g.reg.reserve(runnerA, processC) != true {
		t.Fatal("the failed handshake kept its slot")
	}
}

func TestHelloIsChecked(t *testing.T) {
	h := newHarness(t, nil)
	cases := []struct {
		name  string
		frame *linkpb.Frame
		code  linkpb.CloseCode
	}{
		{"another process than the token's", helloFrame(processB), linkpb.CloseCode_CLOSE_CODE_UNAUTHENTICATED},
		{"not Hello first", &linkpb.Frame{Body: &linkpb.Frame_Heartbeat{Heartbeat: &linkpb.Heartbeat{ProcessId: processA}}},
			linkpb.CloseCode_CLOSE_CODE_PROTOCOL_ERROR},
		{"only newer protocols", &linkpb.Frame{Body: &linkpb.Frame_Hello{Hello: &linkpb.Hello{
			ProcessId: processA, MinProtocolVersion: 2, MaxProtocolVersion: 3}}}, linkpb.CloseCode_CLOSE_CODE_UPGRADE_REQUIRED},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			tc, _, err := h.dial(h.token(runnerA, processA))
			if err != nil {
				t.Fatal(err)
			}
			tc.send(c.frame)
			if got := tc.closed(10 * time.Second); got.GetCode() != c.code {
				t.Fatalf("close %v, want %v", got, c.code)
			}
		})
	}
	tc, _, _ := h.dial(h.token(runnerA, processA))
	tc.sendRaw([]byte{0xff, 0xff, 0xff})
	if got := tc.closed(10 * time.Second); got.GetCode() != linkpb.CloseCode_CLOSE_CODE_PROTOCOL_ERROR {
		t.Fatalf("garbage first frame: %v", got)
	}
}

func TestHeartbeatsAreRecordedAndAnswered(t *testing.T) {
	h := newHarness(t, nil)
	tc, _ := h.connect(runnerA, processA)
	tc.send(&linkpb.Frame{Body: &linkpb.Frame_Heartbeat{Heartbeat: &linkpb.Heartbeat{ProcessId: processA, IdleCapacity: 3}}})
	ack := tc.expect("heartbeat_ack", 5*time.Second).GetHeartbeatAck()
	if ack.GetMode() != linkpb.Mode_MODE_HTTP || len(ack.GetReconcileJson()) != 0 {
		t.Fatalf("ack %v", ack)
	}
	if h.g.metrics.heartbeats.get() != 1 {
		t.Fatal("heartbeat not counted")
	}
	if !strings.Contains(h.logs.String(), "heartbeat process="+processA) {
		t.Fatalf("no frame summary in the log:\n%s", h.logs.String())
	}
}

func TestNewConnectionsPerAddressAreLimited(t *testing.T) {
	h := newHarness(t, func(c *config) { c.IPRate, c.IPBurst = 0.001, 2 })
	for i := 0; i < 2; i++ {
		h.connect(runnerA, []string{processA, processB}[i])
	}
	_, resp, err := h.dial(h.token(runnerA, processC))
	if err == nil {
		t.Fatal("third connection from one address in a burst of 2 was upgraded")
	}
	body := refusalBody(t, resp)
	if resp.StatusCode != http.StatusTooManyRequests || body["code"] != "RATE_LIMITED" || resp.Header.Get("Retry-After") == "" {
		t.Fatalf("status %d body %v headers %v", resp.StatusCode, body, resp.Header)
	}
}

func TestTwoConnectionsPerRunnerAndTheNewestOfAProcessWins(t *testing.T) {
	h := newHarness(t, nil)
	a1, _ := h.connect(runnerA, processA)
	h.connect(runnerA, processB)
	_, resp, err := h.dial(h.token(runnerA, processC))
	if err == nil {
		t.Fatal("a third process's connection was upgraded")
	}
	if body := refusalBody(t, resp); resp.StatusCode != http.StatusTooManyRequests || body["code"] != "TOO_MANY_CONNECTIONS" {
		t.Fatalf("status %d body %v", resp.StatusCode, body)
	}
	// Process A connecting again replaces its own connection rather than counting a third.
	h.connect(runnerA, processA)
	if c := a1.closed(10 * time.Second); c.GetCode() != linkpb.CloseCode_CLOSE_CODE_SUPERSEDED {
		t.Fatalf("old connection of process A closed with %v", c)
	}
	eventually(t, 5*time.Second, "superseded counted", func() bool { return h.g.metrics.disconnects.get("superseded") == 1 })
	if n := h.g.reg.count(); n != 2 {
		t.Fatalf("%d connections open", n)
	}
	// Another runner is not affected by runner A's limit.
	h.connect("0190a0b0-0000-7000-8000-00000000000b", processC)
}

func TestPingsMeasureRoundTrips(t *testing.T) {
	h := newHarness(t, func(c *config) { c.PingInterval, c.PingTimeout = 50*time.Millisecond, time.Second })
	h.connect(runnerA, processA)
	eventually(t, 5*time.Second, "three round trips", func() bool { n, _ := h.g.metrics.rtt.snapshot(); return n >= 3 })
	if h.g.reg.count() != 1 {
		t.Fatal("connection closed")
	}
}

// A runner that answers no ping (a client that never reads sends no pong) is disconnected once a ping has gone
// unanswered for the ping timeout.
func TestUnansweredPingsDisconnect(t *testing.T) {
	h := newHarness(t, func(c *config) { c.PingInterval, c.PingTimeout = 50*time.Millisecond, 300*time.Millisecond })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, h.url, &websocket.DialOptions{
		HTTPClient: h.srv.Client(), HTTPHeader: http.Header{"Authorization": {"Bearer " + h.token(runnerA, processA)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	b, _ := proto.Marshal(helloFrame(processA))
	if err := ws.Write(ctx, websocket.MessageBinary, b); err != nil {
		t.Fatal(err)
	}
	eventually(t, 15*time.Second, "ping_timeout counted", func() bool { return h.g.metrics.disconnects.get("ping_timeout") == 1 })
}

func TestTokenExpiryEndsTheConnection(t *testing.T) {
	h := newHarness(t, nil)
	// exp is in whole seconds, so this token lasts between 1.5 and 2.5 s.
	tc, _, err := h.dial(h.keys.sign(tokenClaims(runnerA, processA, time.Now().Add(2500*time.Millisecond))))
	if err != nil {
		t.Fatal(err)
	}
	tc.send(helloFrame(processA))
	tc.expect("welcome", 5*time.Second)
	c := tc.closed(10 * time.Second)
	if c.GetCode() != linkpb.CloseCode_CLOSE_CODE_UNAUTHENTICATED || !strings.Contains(c.GetMessage(), "expired") {
		t.Fatalf("close %v", c)
	}
	eventually(t, 5*time.Second, "token_expired counted", func() bool { return h.g.metrics.disconnects.get("token_expired") == 1 })
}

func TestDrainInBatchesWithRandomDelays(t *testing.T) {
	h := newHarness(t, func(c *config) { c.DrainBatch = 2; c.DrainBatchInterval = 400 * time.Millisecond })
	var conns []*testConn
	for i, p := range []string{processA, processB, processC} {
		tc, _ := h.connect([]string{runnerA, "0190a0b0-0000-7000-8000-00000000000b", "0190a0b0-0000-7000-8000-00000000000c"}[i], p)
		conns = append(conns, tc)
	}
	done := make(chan struct{})
	start := time.Now()
	go func() { h.g.drain(context.Background()); close(done) }()

	arrivals := make([]time.Duration, len(conns))
	delays := make([]uint32, len(conns))
	var wg sync.WaitGroup
	for i, tc := range conns {
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case f := <-tc.frames:
				arrivals[i], delays[i] = time.Since(start), f.GetDrain().GetReconnectAfterMs()
			case <-time.After(5 * time.Second):
			}
		}()
	}
	wg.Wait()
	for i, ms := range delays {
		if ms < 100 || ms >= 300 {
			t.Fatalf("connection %d: reconnect_after_ms %d outside [100, 300)", i, ms)
		}
	}
	// New connections are refused while draining.
	_, resp, err := h.dial(h.token("0190a0b0-0000-7000-8000-00000000000d", processA))
	if err == nil || resp.StatusCode != http.StatusServiceUnavailable || resp.Header.Get("Retry-After") == "" {
		t.Fatalf("upgrade while draining: %v %v", err, resp)
	}
	// Two in the first batch and the third one batch interval (400ms) later: compared with each other rather than
	// with the clock, so a slow machine delays all three alike.
	sorted := append([]time.Duration(nil), arrivals...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	if sorted[1]-sorted[0] > 150*time.Millisecond || sorted[2]-sorted[1] < 300*time.Millisecond {
		t.Fatalf("drain arrivals %v: want two in the first batch and one 400ms later", arrivals)
	}
	// None of them reconnects, so the gateway closes each after its delay and the grace.
	for _, tc := range conns {
		if c := tc.closed(10 * time.Second); c.GetCode() != linkpb.CloseCode_CLOSE_CODE_UNSPECIFIED {
			t.Fatalf("close %v", c)
		}
	}
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("drain did not finish")
	}
	m := h.g.metrics
	if m.drainsSent.get() != 3 || m.disconnects.get("drained") != 3 || m.draining.get() != 1 {
		t.Fatalf("drains %v drained %v draining %v", m.drainsSent.get(), m.disconnects.get("drained"), m.draining.get())
	}
}

func TestRevocationsCloseLiveConnections(t *testing.T) {
	h := newHarness(t, nil)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("g", 32) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = io.WriteString(w, `{"since":"2026-10-25T05:00:00.000Z","revocations":[{"credential":"cred-`+runnerA+`","revokedAt":"2026-10-25T06:00:00.000Z"}]}`)
	}))
	defer api.Close()
	tc, _ := h.connect(runnerA, processA)
	other, _ := h.connect("0190a0b0-0000-7000-8000-00000000000b", processB)

	p := &revocationPoller{url: api.URL, token: strings.Repeat("g", 32), client: api.Client(), deny: h.g.deny,
		metrics: h.g.metrics, log: h.g.log, revoked: h.g.kickRevoked}
	if err := p.fetch(context.Background()); err != nil {
		t.Fatal(err)
	}
	if c := tc.closed(10 * time.Second); c.GetCode() != linkpb.CloseCode_CLOSE_CODE_UNAUTHENTICATED {
		t.Fatalf("revoked runner's connection closed with %v", c)
	}
	select {
	case <-other.done:
		t.Fatal("another runner's connection was closed")
	case <-time.After(200 * time.Millisecond):
	}
	if _, resp, _ := h.dial(h.token(runnerA, processA)); refusalBody(t, resp)["reason"] != "REVOKED" {
		t.Fatal("revoked credential upgraded")
	}
	if h.g.metrics.revocationFetches.get("ok") != 1 || h.g.deny.size() != 1 {
		t.Fatal("fetch not counted")
	}

	p.token = "wrong"
	if err := p.fetch(context.Background()); err == nil || h.g.metrics.revocationFetches.get("unauthorized") != 1 {
		t.Fatalf("a refused secret: %v", err)
	}
	if h.g.deny.size() != 1 {
		t.Fatal("a failed read emptied the deny list")
	}
}

// The two invariants B4 must keep when it adds forwarding: a MODE_HTTP connection forwards no Rpc, and a shadow
// mirror is forwarded in no mode.
func TestRpcForwardingInvariants(t *testing.T) {
	shadow := &linkpb.Rpc{RequestId: "shadow:c-1:7"}
	normal := &linkpb.Rpc{RequestId: "r-1"}
	for _, mode := range []linkpb.Mode{linkpb.Mode_MODE_UNSPECIFIED, linkpb.Mode_MODE_HTTP, linkpb.Mode_MODE_LINK} {
		if mayForward(mode, shadow) {
			t.Errorf("a shadow mirror may be forwarded in %v", mode)
		}
		if mayForward(mode, normal) != (mode == linkpb.Mode_MODE_LINK) {
			t.Errorf("%v: an ordinary Rpc may be forwarded = %v", mode, mayForward(mode, normal))
		}
	}

	for _, mode := range []linkpb.Mode{linkpb.Mode_MODE_HTTP, linkpb.Mode_MODE_LINK} {
		t.Run(mode.String(), func(t *testing.T) {
			h := newHarness(t, func(c *config) { c.Mode = mode })
			var forwarded []string
			h.g.forward = func(c *conn, rpc *linkpb.Rpc) {
				forwarded = append(forwarded, rpc.GetRequestId())
				c.send(&linkpb.Frame{Body: &linkpb.Frame_RpcResult{RpcResult: &linkpb.RpcResult{RequestId: rpc.GetRequestId(),
					Outcome: &linkpb.RpcResult_Tunnel{Tunnel: &linkpb.TunnelResponse{Status: 200}}}}}, false)
			}
			tc, w := h.connect(runnerA, processA)
			for _, id := range []string{"r-1", "shadow:" + w.GetConnectionId() + ":99"} {
				tc.send(&linkpb.Frame{Body: &linkpb.Frame_Rpc{Rpc: &linkpb.Rpc{RequestId: id,
					Body: &linkpb.Rpc_Tunnel{Tunnel: &linkpb.TunnelRequest{Method: "POST", Path: "/runner/heartbeat", JsonBody: []byte(`{}`)}}}}})
				res := tc.expect("rpc_result", 5*time.Second).GetRpcResult()
				if res.GetRequestId() != id {
					t.Fatalf("result for %s answers %s", id, res.GetRequestId())
				}
				wantForwarded := mode == linkpb.Mode_MODE_LINK && id == "r-1"
				if (res.GetTunnel() != nil) != wantForwarded {
					t.Fatalf("%s in %v: result %v", id, mode, res)
				}
			}
			want := []string{}
			if mode == linkpb.Mode_MODE_LINK {
				want = []string{"r-1"}
			}
			if strings.Join(forwarded, ",") != strings.Join(want, ",") {
				t.Fatalf("forwarded %v, want %v", forwarded, want)
			}
		})
	}
}

func TestFramesOverTheLimitAreRefusedAndChunksAreJoined(t *testing.T) {
	h := newHarness(t, nil)
	tc, w := h.connect(runnerA, processA)
	// A mirrored event batch far over 256 KiB, sent in Chunks, is joined and compared.
	eb, raw := bigEventBatch(t, 600<<10)
	typed := &linkpb.Frame{Id: 2, Body: &linkpb.Frame_EventBatch{EventBatch: eb}}
	next := uint64(2)
	msgs, err := encodeFrame(typed, maxFrameBytes, func() uint64 { next++; return next })
	if err != nil || len(msgs) < 3 {
		t.Fatalf("%d messages, %v", len(msgs), err)
	}
	for _, m := range msgs {
		tc.sendRaw(m)
	}
	// Its raw half is over the limit too, so it travels in Chunks as well.
	next++
	mirror := &linkpb.Frame{Id: next, Body: &linkpb.Frame_Rpc{Rpc: &linkpb.Rpc{RequestId: "shadow:" + w.GetConnectionId() + ":2",
		Body: &linkpb.Rpc_Tunnel{Tunnel: &linkpb.TunnelRequest{Method: "POST", Path: "/runner/sessions/" + eb.GetSessionId() + "/events", JsonBody: raw}}}}}
	msgs, err = encodeFrame(mirror, maxFrameBytes, func() uint64 { next++; return next })
	if err != nil || len(msgs) < 2 {
		t.Fatalf("%d messages, %v", len(msgs), err)
	}
	for _, m := range msgs {
		tc.sendRaw(m)
	}
	tc.outID = next
	tc.expect("rpc_result", 5*time.Second)
	eventually(t, 5*time.Second, "the joined batch compared", func() bool {
		return h.g.metrics.shadowPairs.get("events", "match") == 1
	})
	// One message over the limit ends the connection.
	tc.sendRaw(make([]byte, maxFrameBytes+1))
	tc.closed(10 * time.Second)
	eventually(t, 5*time.Second, "protocol_error counted", func() bool { return h.g.metrics.disconnects.get("protocol_error") == 1 })
}

func TestUndecodableFramesAreLoggedRaw(t *testing.T) {
	h := newHarness(t, nil)
	tc, _ := h.connect(runnerA, processA)
	tc.sendRaw([]byte{0x0a, 0xff, 0xff, 0xff})
	if c := tc.closed(10 * time.Second); c.GetCode() != linkpb.CloseCode_CLOSE_CODE_PROTOCOL_ERROR {
		t.Fatalf("close %v", c)
	}
	if !strings.Contains(h.logs.String(), `raw="Cv///w=="`) || h.g.metrics.frameDecodeErrors.get() != 1 {
		t.Fatalf("log:\n%s", h.logs.String())
	}
}

func TestMetricsEndpoint(t *testing.T) {
	h := newHarness(t, nil)
	h.connect(runnerA, processA)
	srv := httptest.NewServer(h.g.metricsHandler())
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	text := string(b)
	for _, want := range []string{
		"# TYPE link_connections gauge\nlink_connections 1\n",
		`link_handshakes_total{result="ok"} 1`,
		`link_handshakes_total{result="unauthenticated"} 0`,
		"# TYPE link_handshake_duration_seconds histogram",
		`link_disconnects_total{reason="ping_timeout"} 0`,
		"# TYPE link_rtt_seconds histogram",
		`link_shadow_pairs_total{kind="events",result="mismatch"} 0`,
		`link_gateway_build_info{version="dev"} 1`,
		`link_frames_received_total{type="hello"} 1`,
	} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q", want)
		}
	}
	if t.Failed() {
		t.Log(text)
	}
	resp, err = http.Get(srv.URL + "/healthz")
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("healthz %v %v", resp, err)
	}
	resp.Body.Close()
	h.g.draining.Store(true)
	resp, _ = http.Get(srv.URL + "/healthz")
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("healthz while draining: %d", resp.StatusCode)
	}
	resp.Body.Close()
}
