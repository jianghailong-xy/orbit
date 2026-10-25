package main

import (
	"bytes"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"orbit/link-gateway/linkpb"
)

// Control requests forwarded to the apiserver's internal listener (forward.go, backend.go).

func TestARequestIsForwardedWithTheRunnersTokenAndWhatHelloDeclared(t *testing.T) {
	backend := newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"sessionId":"s-1","note":"<as it was>"}`))
	})
	h := newLinkHarness(t, []*fakeBackend{backend}, nil)
	token := h.token(runnerA, processA)
	tc, _, err := h.dial(token)
	if err != nil {
		t.Fatal(err)
	}
	tc.send(linkHello(processA))
	if w := tc.expect("welcome", 5*time.Second).GetWelcome(); w.GetMode() != linkpb.Mode_MODE_LINK {
		t.Fatalf("Welcome says %v", w.GetMode())
	}

	tc.send(&linkpb.Frame{Body: &linkpb.Frame_Rpc{Rpc: &linkpb.Rpc{RequestId: "claim-1", SessionId: "0190a0b0-0000-7000-8000-0000000000c1", AfterSeq: 41,
		Body: &linkpb.Rpc_Tunnel{Tunnel: &linkpb.TunnelRequest{Method: "GET", Path: "/runner/sessions/claim?wait=0"}}}}})
	res := tc.await("rpc_result", 5*time.Second, nil).GetRpcResult()
	if res.GetRequestId() != "claim-1" || res.GetTunnel().GetStatus() != 200 ||
		string(res.GetTunnel().GetJsonBody()) != `{"sessionId":"s-1","note":"<as it was>"}` {
		t.Fatalf("result %v", res)
	}
	got := backend.requestsTo("/api/runner/sessions/claim")
	if len(got) != 1 {
		t.Fatalf("%d calls reached the backend", len(got))
	}
	call := got[0]
	if call.Method != "GET" || call.Path != "/api/runner/sessions/claim?wait=0" {
		t.Fatalf("%s %s", call.Method, call.Path)
	}
	want := map[string]string{
		"Authorization":                      "Bearer " + strings.Repeat("g", 32),
		"X-Orbit-Runner-Link-Token":          token,
		"X-Orbit-Link-Request-Id":            "claim-1",
		"X-Orbit-Link-Session-Id":            "0190a0b0-0000-7000-8000-0000000000c1",
		"X-Orbit-Link-After-Seq":             "41",
		"X-Orbit-Link-Gateway-Id":            nodeName(),
		"X-Orbit-Runner-Capabilities":        "session-terminal-handoff-v1,source-pin/v1",
		"X-Orbit-Runner-Os":                  "linux",
		"X-Orbit-Supported-Providers":        "claude,codex",
		"X-Orbit-Runner-Capability-Revision": "2",
		"X-Orbit-Runner-Schema-Revision":     "3",
		"X-Orbit-Runner-Contract-Digest":     "bbdd980c",
		"X-Orbit-Cli-Version":                "0.1.240",
		"X-Orbit-Managed-Runner-Generation":  "7",
		"X-Orbit-Managed-Runner-Pod-Uid":     "pod-1",
	}
	for name, value := range want {
		if got := call.Header.Get(name); got != value {
			t.Errorf("%s: %q, want %q", name, got, value)
		}
	}

	// A body travels byte for byte, and a request without session or after_seq carries neither header.
	body := []byte(`{"text": "a é <b>", "n": 1.50}`)
	res = tc.rpc("merge-1", "POST", "/runner/sessions/0190a0b0-0000-7000-8000-0000000000c1/merge-result", body)
	if res.GetTunnel().GetStatus() != 200 {
		t.Fatalf("result %v", res)
	}
	posted := backend.requestsTo("/api/runner/sessions/0190a0b0-0000-7000-8000-0000000000c1/merge-result")
	if len(posted) != 1 || !bytes.Equal(posted[0].Body, body) || posted[0].Header.Get("Content-Type") != "application/json" {
		t.Fatalf("posted %+v", posted)
	}
	if posted[0].Header.Get("X-Orbit-Link-After-Seq") != "" || posted[0].Header.Get("X-Orbit-Link-Session-Id") != "" {
		t.Fatalf("headers %v", posted[0].Header)
	}
	if got := h.g.metrics.rpcResults.get("2xx"); got != 2 {
		t.Fatalf("link_rpc_results_total{result=\"2xx\"} = %v", got)
	}
}

func TestTheRoutesAnswerComesBackWhateverItsStatus(t *testing.T) {
	cases := []struct {
		name       string
		status     int
		header     map[string]string
		body       string
		retryAfter uint32
	}{
		{"a retryable refusal with its hint in milliseconds", 503, map[string]string{"Retry-After-Ms": "2000", "Retry-After": "2"},
			`{"code":"DATABASE_UNAVAILABLE","retryable":true,"retryAfterMs":2000}`, 2000},
		{"the hint in the body alone", 503, nil, `{"code":"RUNNER_LINK_AFTER_SEQ_PENDING","retryable":true,"retryAfterMs":250}`, 250},
		{"Retry-After in seconds alone", 429, map[string]string{"Retry-After": "3"}, `{"code":"TOO_MANY_REQUESTS","retryable":true}`, 3000},
		{"a final refusal", 409, nil, `{"code":"CONFLICT","retryable":false,"message":"session is no longer open"}`, 0},
		{"not found", 404, nil, `{"statusCode":404,"code":"NOT_FOUND","retryable":false}`, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			backend := newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
				for k, v := range c.header {
					w.Header().Set(k, v)
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(c.status)
				_, _ = w.Write([]byte(c.body))
			})
			h := newLinkHarness(t, []*fakeBackend{backend}, nil)
			tc, _ := h.connectLink(runnerA, processA)
			res := tc.rpc("r-1", "POST", "/runner/sessions/0190a0b0-0000-7000-8000-0000000000c1/turn-complete", []byte(`{}`))
			tun := res.GetTunnel()
			if tun == nil || int(tun.GetStatus()) != c.status || string(tun.GetJsonBody()) != c.body || tun.GetRetryAfterMs() != c.retryAfter {
				t.Fatalf("result %v", res)
			}
			// An answer is relayed, never retried: the route decided.
			if n := len(backend.requests()); n != 1 {
				t.Fatalf("%d calls", n)
			}
		})
	}
}

func TestAMalformedRequestIsRefusedWithoutACall(t *testing.T) {
	backend := newFakeBackend(t, nil)
	h := newLinkHarness(t, []*fakeBackend{backend}, nil)
	tc, _ := h.connectLink(runnerA, processA)
	cases := []struct{ name, id, method, path string }{
		{"not a runner route", "r-1", "POST", "/auth/login"},
		{"a dot segment", "r-2", "GET", "/runner/../auth/login"},
		{"a doubled slash", "r-3", "GET", "/runner//sessions/claim"},
		{"an escape", "r-4", "GET", "/runner/%2e%2e/auth/login"},
		{"a trailing slash", "r-5", "GET", "/runner/sessions/claim/"},
		{"a space", "r-6", "GET", "/runner/sessions/claim?x= y"},
		{"a backslash", "r-7", "GET", `/runner\sessions`},
		{"another method", "r-8", "TRACE", "/runner/sessions/claim"},
		{"no request id", "", "GET", "/runner/sessions/claim"},
		{"a request id with a space", "bad id", "GET", "/runner/sessions/claim"},
	}
	for _, c := range cases {
		tc.send(&linkpb.Frame{Body: &linkpb.Frame_Rpc{Rpc: &linkpb.Rpc{RequestId: c.id,
			Body: &linkpb.Rpc_Tunnel{Tunnel: &linkpb.TunnelRequest{Method: c.method, Path: c.path}}}}})
		res := tc.await("rpc_result", 5*time.Second, nil).GetRpcResult()
		if f := res.GetFailure(); f.GetCode() != "RPC_BAD_REQUEST" || f.GetRetryable() || res.GetRequestId() != c.id {
			t.Errorf("%s: %v", c.name, res)
		}
	}
	tc.send(&linkpb.Frame{Body: &linkpb.Frame_Rpc{Rpc: &linkpb.Rpc{RequestId: "r-9"}}})
	if f := tc.await("rpc_result", 5*time.Second, nil).GetRpcResult().GetFailure(); f.GetCode() != "RPC_BAD_REQUEST" {
		t.Errorf("an Rpc without a TunnelRequest: %v", f)
	}
	if n := len(backend.requests()); n != 0 {
		t.Fatalf("%d calls reached the backend", n)
	}
}

// A runner that disconnects has its calls cancelled: the route sees its request close, as a claim waiting for its lock
// sees the runner hang up over HTTPS (§6.4, hungUp).
func TestARunnerThatDisconnectsCancelsItsCalls(t *testing.T) {
	arrived := make(chan struct{})
	hungUp := make(chan time.Duration, 1)
	backend := newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		start := time.Now()
		close(arrived)
		select {
		case <-r.Context().Done():
			hungUp <- time.Since(start)
		case <-time.After(10 * time.Second):
			writeJSON(w, 200, map[string]any{})
		}
	})
	h := newLinkHarness(t, []*fakeBackend{backend}, nil)
	tc, _ := h.connectLink(runnerA, processA)
	tc.send(&linkpb.Frame{Body: &linkpb.Frame_Rpc{Rpc: &linkpb.Rpc{RequestId: "claim-1",
		Body: &linkpb.Rpc_Tunnel{Tunnel: &linkpb.TunnelRequest{Method: "GET", Path: "/runner/sessions/claim"}}}}})
	select {
	case <-arrived:
	case <-time.After(5 * time.Second):
		t.Fatal("the call never reached the backend")
	}
	_ = tc.ws.CloseNow()
	select {
	case d := <-hungUp:
		t.Logf("the route saw the hang-up %s after the call arrived", d)
	case <-time.After(5 * time.Second):
		t.Fatal("the route never saw the runner hang up")
	}
	eventually(t, 5*time.Second, "the call counted as cancelled", func() bool { return h.g.metrics.rpcResults.get("CANCELLED") == 1 })
	if n := len(backend.requests()); n != 1 {
		t.Fatalf("the cancelled call was sent %d times", n)
	}
}

// cutOff is a backend that reads each request in full and closes the connection without answering: the call may have
// run there, and its answer is lost.
func cutOff(w http.ResponseWriter, r *http.Request, body []byte) {
	conn, _, err := w.(http.Hijacker).Hijack()
	if err == nil {
		_ = conn.Close()
	}
}

func TestAnIdempotentCallWhoseAnswerIsLostIsSentAgainOnTheNextBackend(t *testing.T) {
	var lost atomic.Int32
	first := newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		lost.Add(1)
		cutOff(w, r, body)
	})
	second := newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		writeJSON(w, 200, map[string]string{"from": "second"})
	})
	h := newLinkHarness(t, []*fakeBackend{first, second}, nil)
	tc, _ := h.connectLink(runnerA, processA)
	// Started on the first backend each time, round-robin, so every call meets the lost answer there once.
	h.g.backends.next.Store(0)
	res := tc.rpc("inbox-1", "GET", "/runner/sessions/0190a0b0-0000-7000-8000-0000000000c1/inbox?runningTurnId=", nil)
	if res.GetTunnel().GetStatus() != 200 || !strings.Contains(string(res.GetTunnel().GetJsonBody()), "second") {
		t.Fatalf("a GET whose answer was lost: %v", res)
	}
	if got := h.g.metrics.backendRetries.get("rpc", "lost"); got != 1 {
		t.Fatalf("retries after a lost answer: %v", got)
	}

	// A POST may have run where its answer was lost: it is not sent again on the runner's behalf.
	h.g.backends.next.Store(0)
	res = tc.rpc("complete-1", "POST", "/runner/sessions/0190a0b0-0000-7000-8000-0000000000c1/turn-complete", []byte(`{}`))
	if f := res.GetFailure(); f.GetCode() != "BACKEND_CUT_OFF" || !f.GetRetryable() {
		t.Fatalf("a POST whose answer was lost: %v", res)
	}
	if n := len(second.requestsTo("/api/runner/sessions/0190a0b0-0000-7000-8000-0000000000c1/turn-complete")); n != 0 {
		t.Fatalf("the POST was sent again on the second backend %d times", n)
	}
	if lost.Load() != 2 {
		t.Fatalf("the first backend saw %d calls", lost.Load())
	}
}

// deadBackend is the address of a backend that is not listening: a dial there fails, and no handler runs.
func deadBackend(t *testing.T) string {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	return "http://" + addr
}

func TestACallThatReachedNoBackendIsSentAgainOnTheNextWhateverItIs(t *testing.T) {
	alive := newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		writeJSON(w, 200, map[string]string{"stored": "yes"})
	})
	h := newHarness(t, func(c *config) {
		c.Mode = linkpb.Mode_MODE_LINK
		c.InternalAPIURLs = []string{deadBackend(t), alive.url()}
		c.link.RetryBudget, c.link.BackendDownFor = 2*time.Second, time.Minute
	})
	tc, _ := h.connectLink(runnerA, processA)
	h.g.backends.next.Store(0)
	res := tc.rpc("complete-1", "POST", "/runner/sessions/0190a0b0-0000-7000-8000-0000000000c1/turn-complete", []byte(`{"turnId":"t-1"}`))
	if res.GetTunnel().GetStatus() != 200 {
		t.Fatalf("a POST that reached no backend: %v", res)
	}
	if got := h.g.metrics.backendRetries.get("rpc", "not_delivered"); got != 1 {
		t.Fatalf("retries: %v", got)
	}
	// The backend that could not be dialed is passed over for a while: the next call goes straight to the other one.
	h.g.backends.next.Store(0)
	tc.rpc("complete-2", "POST", "/runner/sessions/0190a0b0-0000-7000-8000-0000000000c1/turn-complete", []byte(`{"turnId":"t-2"}`))
	if got := h.g.metrics.backendRetries.get("rpc", "not_delivered"); got != 1 {
		t.Fatalf("the dead backend was tried again at once: %v retries", got)
	}
	if n := len(alive.requests()); n != 2 {
		t.Fatalf("the live backend saw %d calls", n)
	}
}

func TestNoBackendAnsweringIsARetryableFailure(t *testing.T) {
	h := newHarness(t, func(c *config) {
		c.Mode = linkpb.Mode_MODE_LINK
		c.InternalAPIURLs = []string{deadBackend(t), deadBackend(t)}
		c.link.RetryBudget = 500 * time.Millisecond
	})
	tc, _ := h.connectLink(runnerA, processA)
	start := time.Now()
	res := tc.rpc("claim-1", "GET", "/runner/sessions/claim", nil)
	f := res.GetFailure()
	if f.GetCode() != "BACKEND_UNAVAILABLE" || !f.GetRetryable() || f.GetRetryAfterMs() != 1000 {
		t.Fatalf("result %v", res)
	}
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("the retries took %s, past their budget", took)
	}
	if h.g.reg.count() != 1 {
		t.Fatal("the connection was closed")
	}
}

func TestACallWithNoAnswerInTimeIsARetryableFailure(t *testing.T) {
	backend := newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	})
	h := newLinkHarness(t, []*fakeBackend{backend}, func(c *config) { c.RPCTimeout = 300 * time.Millisecond })
	tc, _ := h.connectLink(runnerA, processA)
	res := tc.rpc("complete-1", "POST", "/runner/sessions/0190a0b0-0000-7000-8000-0000000000c1/turn-complete", []byte(`{}`))
	if f := res.GetFailure(); f.GetCode() != "BACKEND_TIMEOUT" || !f.GetRetryable() {
		t.Fatalf("result %v", res)
	}
}

func TestCallsPastTheConnectionsBoundAreRefusedRetryable(t *testing.T) {
	release := make(chan struct{})
	backend := newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
		writeJSON(w, 200, map[string]any{})
	})
	h := newLinkHarness(t, []*fakeBackend{backend}, func(c *config) { c.link.MaxRPCsInFlight = 2 })
	tc, _ := h.connectLink(runnerA, processA)
	for _, id := range []string{"r-1", "r-2", "r-3"} {
		tc.send(&linkpb.Frame{Body: &linkpb.Frame_Rpc{Rpc: &linkpb.Rpc{RequestId: id,
			Body: &linkpb.Rpc_Tunnel{Tunnel: &linkpb.TunnelRequest{Method: "GET", Path: "/runner/wake"}}}}})
	}
	res := tc.await("rpc_result", 5*time.Second, nil).GetRpcResult()
	if res.GetRequestId() != "r-3" || res.GetFailure().GetCode() != "RPC_TOO_MANY_IN_FLIGHT" || !res.GetFailure().GetRetryable() {
		t.Fatalf("the third call: %v", res)
	}
	close(release)
	for i := 0; i < 2; i++ {
		if res := tc.await("rpc_result", 5*time.Second, nil).GetRpcResult(); res.GetTunnel().GetStatus() != 200 {
			t.Fatalf("result %v", res)
		}
	}
}

// What the gateway is configured with: forwarding needs the internal listener, and NATS credentials are a seed.
func TestTheLinkSettingsAreChecked(t *testing.T) {
	keys := newTestKeys(t)
	base := map[string]string{
		"LINK_PUBLIC_KEYS": publicPEM(t, keys.pub), "LINK_GATEWAY_TOKEN": strings.Repeat("g", 32),
		"LINK_API_URL": "http://apiserver:3000", "LINK_TLS_MODE": "off",
	}
	read := func(extra map[string]string) (config, error) {
		env := map[string]string{}
		for k, v := range base {
			env[k] = v
		}
		for k, v := range extra {
			env[k] = v
		}
		return configFromEnv(func(k string) string { return env[k] })
	}
	if c, err := read(nil); err != nil || c.Mode != linkpb.Mode_MODE_HTTP {
		t.Fatalf("by default: %v, %v", c.Mode, err)
	}
	if _, err := read(map[string]string{"LINK_MODE": "link"}); err == nil || !strings.Contains(err.Error(), "LINK_INTERNAL_API_URLS") {
		t.Fatalf("link mode without backends: %v", err)
	}
	c, err := read(map[string]string{"LINK_MODE": "link", "LINK_INTERNAL_API_URLS": "http://apiserver:3001/, http://apiserver-b:3001"})
	if err != nil || c.Mode != linkpb.Mode_MODE_LINK || strings.Join(c.InternalAPIURLs, " ") != "http://apiserver:3001 http://apiserver-b:3001" {
		t.Fatalf("link mode: %v %v, %v", c.Mode, c.InternalAPIURLs, err)
	}
	for _, bad := range []map[string]string{
		{"LINK_MODE": "shadow"},
		{"LINK_INTERNAL_API_URLS": "apiserver:3001"},
		{"LINK_INTERNAL_API_URLS": "http://apiserver:3001/api"},
		{"LINK_NATS_URL": "nats://user:secret@nats:4222"},
	} {
		if _, err := read(bad); err == nil {
			t.Errorf("%v was accepted", bad)
		}
	}
	// A seed that is not one is refused, and the refusal never repeats it.
	_, err = read(map[string]string{"LINK_NATS_SEED": "SUNOTASEEDATALLBUTITLOOKSSECRET"})
	if err == nil || strings.Contains(err.Error(), "SUNOTASEED") {
		t.Fatalf("a bad seed: %v", err)
	}
}
