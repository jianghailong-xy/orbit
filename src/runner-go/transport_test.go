package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestRunNowHeartbeatAdvertisesCapabilityAndAppliesBurst(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/heartbeat") {
			if !contains(strings.Split(r.Header.Get("X-Orbit-Runner-Capabilities"), ","), "over-capacity/v1") {
				t.Error("heartbeat omitted the Run now capability")
			}
			_, _ = w.Write([]byte(`{"maxConcurrent":1,"burstConcurrent":2}`))
			return
		}
		_, _ = w.Write([]byte(`{"sessionId":"overflow","overCapacity":true}`))
	}))
	defer server.Close()
	if !contains(linkHello("runner-process").GetCapabilities(), "over-capacity/v1") {
		t.Fatal("runner link Hello omitted the capability forwarded with heartbeats")
	}

	p := newSessionPool(1)
	registerPoolSession(t, p, "ordinary", true)
	if p.canClaim() {
		t.Fatal("the runner used burst room before receiving the setting")
	}
	tr := NewTransport(server.URL, "runner-token")
	resp, err := tr.heartbeat(HeartbeatRequest{})
	if err != nil {
		t.Fatal(err)
	}
	p.applyConcurrency(resp.MaxConcurrent, resp.BurstConcurrent)
	if !p.canClaim() {
		t.Fatal("the heartbeat's burst setting did not reopen the claim loop")
	}
	job, err := tr.claimSession(context.Background(), nil)
	if err != nil || job == nil {
		t.Fatalf("claim = %v, %v", job, err)
	}
	first, _ := p.register(job, func() {}, true)
	if !p.isActive(first) {
		t.Fatal("the wire claim did not acquire an overflow permit")
	}
	p.applyConcurrency(1, nil)
	if !p.canClaim() {
		t.Fatal("a heartbeat without burstConcurrent cleared the configured burst")
	}
	zero := 0
	p.applyConcurrency(1, &zero)
	second, _ := p.register(&ClaimedSession{SessionID: "overflow-2", OverCapacity: true}, func() {}, true)
	if p.canClaim() || p.isActive(second) || !p.isActive(first) {
		t.Fatal("setting zero should close burst admission and let an existing turn finish")
	}
}

// The P1b gate hands a Harness session only to a runner that names dsh on claim/reclaim and whose
// heartbeat persisted provider:dsh from the same header; a runner that names neither never gets one.
func TestTransportDeclaresDshOnClaimReclaimAndHeartbeat(t *testing.T) {
	var mu sync.Mutex
	seen := map[string]string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen[r.URL.Path] = r.Header.Get("X-Orbit-Supported-Providers")
		mu.Unlock()
		w.Header().Set("content-type", "application/json")
		if r.URL.Path == "/api/runner/sessions/reclaim" {
			_, _ = w.Write([]byte(`{"sessions":[]}`))
			return
		}
		_, _ = w.Write([]byte(`null`))
	}))
	defer server.Close()

	transport := NewTransport(server.URL, "runner-token")
	if _, err := transport.claimSession(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := transport.reclaim(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := transport.heartbeat(HeartbeatRequest{}); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/runner/sessions/claim", "/api/runner/sessions/reclaim", "/api/runner/heartbeat"} {
		header, ok := seen[path]
		if !ok {
			t.Fatalf("request %s was not observed", path)
		}
		if !contains(strings.Split(header, ","), providerDsh) {
			t.Errorf("%s provider header = %q, want it to name %s", path, header, providerDsh)
		}
		for _, provider := range []string{"claude", "codex", "opencode", providerAntigravity} {
			if !contains(strings.Split(header, ","), provider) {
				t.Errorf("%s provider header = %q dropped %s", path, header, provider)
			}
		}
	}
}
