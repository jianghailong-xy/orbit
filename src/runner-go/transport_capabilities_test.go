package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
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

// The claim lease's server side may only reclaim an unactivated claim from a runner that named
// this capability, because naming it is the promise that every claim this loop takes reaches
// `activate-leases`. So it has to be on the claim request itself — the header the claim is
// answered from is what the queue reads to decide whether to arm a deadline, and a capability
// advertised only on the heartbeat would arrive after the decision that needs it.
func TestClaimAdvertisesClaimLeaseCapability(t *testing.T) {
	var header string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header = r.Header.Get(runnerCapabilitiesHeader)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`null`))
	}))
	defer server.Close()

	if _, err := NewTransport(server.URL, "runner-token").claimSession(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(strings.Split(header, ","), sessionClaimLeaseV1) {
		t.Fatalf("capability header %q does not advertise %q", header, sessionClaimLeaseV1)
	}
}
