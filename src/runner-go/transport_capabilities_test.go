package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTransportAdvertisesSupportedProviders(t *testing.T) {
	seen := map[string]bool{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-Orbit-Supported-Providers"); got != runnerSupportedProviders {
			t.Errorf("provider capability header = %q, want %q", got, runnerSupportedProviders)
		}
		seen[r.URL.Path] = true
		w.Header().Set("content-type", "application/json")
		if r.URL.Path == "/api/runner/sessions/reclaim" {
			_, _ = w.Write([]byte(`{"sessions":[]}`))
			return
		}
		_, _ = w.Write([]byte(`null`))
	}))
	defer server.Close()

	if _, err := NewTransport(server.URL, "runner-token").claimSession(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := NewTransport(server.URL, "runner-token").reclaim(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/runner/sessions/claim", "/api/runner/sessions/reclaim"} {
		if !seen[path] {
			t.Errorf("request %s was not observed", path)
		}
	}
}
