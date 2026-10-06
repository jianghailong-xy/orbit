package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

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
	if _, err := transport.claimSession(context.Background()); err != nil {
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
