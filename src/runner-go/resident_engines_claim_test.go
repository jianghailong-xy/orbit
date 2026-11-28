package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
)

// A claim and a reclaim name the sessions whose engine runs in this process, so the control plane does not record the
// claim's mode over the mode such an engine reported (project 350NMcNDulzkqRAFFUsXZ, task 355HRRGxWhaMY3lI9wr5B). An
// engine on its way out, a detaching supervisor and a cold one are not named: the next claim spawns their engine.
func TestClaimAndReclaimNameTheResidentEngines(t *testing.T) {
	const (
		warm     = "11111111-1111-4111-8111-111111111111"
		running  = "22222222-2222-4222-8222-222222222222"
		cold     = "33333333-3333-4333-8333-333333333333"
		evicting = "44444444-4444-4444-8444-444444444444"
		leaving  = "55555555-5555-4555-8555-555555555555"
	)
	pool := newSessionPool(4)
	pool.sessions[running] = &liveSession{id: running, resident: true, active: true}
	pool.sessions[warm] = &liveSession{id: warm, resident: true}
	pool.sessions[cold] = &liveSession{id: cold}
	pool.sessions[evicting] = &liveSession{id: evicting, resident: true, evictRequested: true}
	pool.sessions[leaving] = &liveSession{id: leaving, resident: true, detaching: true}
	if got, want := pool.residentEngineSessionIDs(), []string{warm, running}; !reflect.DeepEqual(got, want) {
		t.Fatalf("residentEngineSessionIDs = %v, want %v", got, want)
	}

	var mu sync.Mutex
	seen := map[string][]string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		_, has := r.URL.Query()["residentEngines"]
		if has {
			seen[r.URL.Path] = append(seen[r.URL.Path], r.URL.Query().Get("residentEngines"))
		} else {
			seen[r.URL.Path] = append(seen[r.URL.Path], "<absent>")
		}
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
	// A transport no pool is wired to (every one but runLoop's) says nothing.
	if _, err := transport.claimSession(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	transport.residentEngines = pool.residentEngineSessionIDs
	if _, err := transport.claimSession(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := transport.reclaim(context.Background()); err != nil {
		t.Fatal(err)
	}
	// With no engine resident, nothing is added.
	transport.residentEngines = func() []string { return nil }
	if _, err := transport.reclaim(context.Background()); err != nil {
		t.Fatal(err)
	}

	want := map[string][]string{
		"/api/runner/sessions/claim":   {"<absent>", warm + "," + running},
		"/api/runner/sessions/reclaim": {warm + "," + running, "<absent>"},
	}
	if !reflect.DeepEqual(seen, want) {
		t.Fatalf("residentEngines sent = %v, want %v", seen, want)
	}
}
