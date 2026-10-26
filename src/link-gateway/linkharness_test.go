package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"
	"time"

	"orbit/link-gateway/linkpb"
)

// A gateway in MODE_LINK and the apiserver instances it forwards to: each backend is an httptest server that records
// every call and answers it with the test's handler, standing in for the internal listener of
// src/apiserver/src/runner-api/runner-link-call.ts.

// backendRequest is one call a backend received.
type backendRequest struct {
	Method, Path string
	Header       http.Header
	Body         []byte
}

type fakeBackend struct {
	t   testing.TB
	srv *httptest.Server
	mu  sync.Mutex
	got []backendRequest
	// handle answers a call; nil answers 200 {}.
	handle func(w http.ResponseWriter, r *http.Request, body []byte)
	// welcome answers the welcome route, which every MODE_LINK connection calls before its Welcome (welcome.go); nil
	// answers each session asked about at durable seq 0, held, and no release. Those calls are recorded apart, in
	// welcomes, so that a test of another route counts that route's calls alone.
	welcome  func(w http.ResponseWriter, r *http.Request, body []byte)
	welcomes []backendRequest
}

const welcomePath = "/api/runner/link/welcome"

func newFakeBackend(t testing.TB, handle func(w http.ResponseWriter, r *http.Request, body []byte)) *fakeBackend {
	t.Helper()
	b := &fakeBackend{t: t, handle: handle}
	b.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		got := backendRequest{Method: r.Method, Path: r.URL.RequestURI(), Header: r.Header.Clone(), Body: body}
		if r.URL.Path == welcomePath {
			b.mu.Lock()
			b.welcomes = append(b.welcomes, got)
			welcome := b.welcome
			b.mu.Unlock()
			if welcome == nil {
				welcome = welcomeEveryoneHeld
			}
			welcome(w, r, body)
			return
		}
		b.mu.Lock()
		b.got = append(b.got, got)
		handle := b.handle
		b.mu.Unlock()
		if handle == nil {
			writeJSON(w, http.StatusOK, map[string]any{})
			return
		}
		handle(w, r, body)
	}))
	t.Cleanup(b.srv.Close)
	return b
}

func (b *fakeBackend) url() string { return b.srv.URL }

func (b *fakeBackend) requests() []backendRequest {
	b.mu.Lock()
	defer b.mu.Unlock()
	return slices.Clone(b.got)
}

// requestsTo is what reached path, the query left out.
func (b *fakeBackend) requestsTo(path string) []backendRequest {
	var out []backendRequest
	for _, r := range b.requests() {
		if p, _, _ := cutQuery(r.Path); p == path {
			out = append(out, r)
		}
	}
	return out
}

func (b *fakeBackend) setHandler(handle func(w http.ResponseWriter, r *http.Request, body []byte)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.handle = handle
}

func (b *fakeBackend) setWelcome(welcome func(w http.ResponseWriter, r *http.Request, body []byte)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.welcome = welcome
}

func (b *fakeBackend) welcomeCalls() []backendRequest {
	b.mu.Lock()
	defer b.mu.Unlock()
	return slices.Clone(b.welcomes)
}

// welcomeEveryoneHeld is the welcome route's answer for a process holding every session it names, none of whose events
// are stored yet, with no release assigned.
func welcomeEveryoneHeld(w http.ResponseWriter, _ *http.Request, body []byte) {
	var asked struct {
		SessionIDs []string `json:"sessionIds"`
	}
	_ = json.Unmarshal(body, &asked)
	sessions := []map[string]any{}
	for _, id := range asked.SessionIDs {
		sessions = append(sessions, map[string]any{"sessionId": id, "durableSeq": 0, "leaseHeld": true})
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": sessions})
}

func cutQuery(p string) (string, string, bool) {
	for i := 0; i < len(p); i++ {
		if p[i] == '?' {
			return p[:i], p[i+1:], true
		}
	}
	return p, "", false
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// newLinkHarness is a gateway in MODE_LINK forwarding to backends, in order.
func newLinkHarness(t *testing.T, backends []*fakeBackend, mutate func(*config)) *harness {
	t.Helper()
	return newHarness(t, func(c *config) {
		c.Mode = linkpb.Mode_MODE_LINK
		for _, b := range backends {
			c.InternalAPIURLs = append(c.InternalAPIURLs, b.url())
		}
		c.link.RetryBudget = 2 * time.Second
		c.link.BackendDownFor = 500 * time.Millisecond
		// Every batch forwarded alone, the route each test here holds the gateway to; merged calls have tests of their
		// own (events_merge_test.go), which set a window.
		c.link.Merge.Window = 0
		if mutate != nil {
			mutate(c)
		}
	})
}

// linkHello is a Hello declaring what a runner declares (src/runner-go/link_client.go linkHello).
func linkHello(process string) *linkpb.Frame {
	return &linkpb.Frame{Body: &linkpb.Frame_Hello{Hello: &linkpb.Hello{
		ProcessId: process, RunnerVersion: "0.1.240", Os: "linux", MinProtocolVersion: 1, MaxProtocolVersion: 1,
		Capabilities:       []string{"session-terminal-handoff-v1", "source-pin/v1"},
		SupportedProviders: []string{"claude", "codex"},
		WriteContract:      &linkpb.WriteContract{CapabilityRevision: 2, SchemaRevision: 3, ContractDigest: "bbdd980c"},
		ManagedInstance:    &linkpb.ManagedInstance{Generation: "7", PodUid: "pod-1"},
	}}}
}

// connectLink opens a connection that says linkHello, and returns its Welcome.
func (h *harness) connectLink(runner, process string) (*testConn, *linkpb.Welcome) {
	h.t.Helper()
	tc, resp, err := h.dial(h.token(runner, process))
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		h.t.Fatalf("dial: %v (status %d)", err, status)
	}
	tc.send(linkHello(process))
	return tc, tc.expect("welcome", 5*time.Second).GetWelcome()
}

// await reads frames until one is body and satisfies match (nil matches any), skipping the rest.
func (tc *testConn) await(body string, timeout time.Duration, match func(*linkpb.Frame) bool) *linkpb.Frame {
	tc.t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case f := <-tc.frames:
			if bodyName(f) == body && (match == nil || match(f)) {
				return f
			}
		case <-tc.done:
			tc.t.Fatalf("connection ended waiting for %s: %v", body, tc.err)
		case <-deadline:
			tc.t.Fatalf("no matching %s within %s", body, timeout)
		}
	}
}

// rpc sends a tunnelled request and waits for its result.
func (tc *testConn) rpc(id, method, path string, body []byte) *linkpb.RpcResult {
	tc.t.Helper()
	tc.send(&linkpb.Frame{Body: &linkpb.Frame_Rpc{Rpc: &linkpb.Rpc{RequestId: id,
		Body: &linkpb.Rpc_Tunnel{Tunnel: &linkpb.TunnelRequest{Method: method, Path: path, JsonBody: body}}}}})
	return tc.await("rpc_result", 10*time.Second, func(f *linkpb.Frame) bool { return f.GetRpcResult().GetRequestId() == id }).GetRpcResult()
}
