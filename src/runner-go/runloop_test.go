package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func TestRuntimeModelRefreshCadence(t *testing.T) {
	if got := time.Duration(runtimeDefaultRefreshHeartbeatTicks) * heartbeatInterval; got != 5*time.Minute {
		t.Fatalf("runtime default refresh cadence = %s, want 5m", got)
	}
	if got := time.Duration(modelCatalogRefreshHeartbeatTicks) * heartbeatInterval; got != time.Hour {
		t.Fatalf("model catalog refresh cadence = %s, want 1h", got)
	}
}

func TestWaitForRunLoopStopUpdate(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	reason, remote := waitForRunLoopStop(ctx, nil, "https://control.example", time.Millisecond,
		func(_ context.Context, server string) (string, bool) {
			if server != "https://control.example" {
				t.Errorf("server = %q", server)
			}
			return "0.1.81", true
		})
	if reason != runLoopStopUpdate || remote != "0.1.81" {
		t.Fatalf("stop = %v, %q; want update, 0.1.81", reason, remote)
	}
}

func TestWaitForRunLoopStopSignalDoesNotRequestUpdate(t *testing.T) {
	signals := make(chan os.Signal, 1)
	signals <- syscall.SIGTERM
	checks := 0
	reason, remote := waitForRunLoopStop(context.Background(), signals, "https://control.example", time.Hour,
		func(context.Context, string) (string, bool) {
			checks++
			return "99.0.0", true
		})
	if reason != runLoopStopSignal || remote != "" {
		t.Fatalf("stop = %v, %q; want signal", reason, remote)
	}
	if checks != 0 {
		t.Fatalf("update checker called %d time(s) after SIGTERM, want 0", checks)
	}
}

func TestWaitForRunLoopStopSignalWinsDuringUpdateCheck(t *testing.T) {
	signals := make(chan os.Signal, 1)
	checkStarted := make(chan struct{})
	finishCheck := make(chan struct{})
	result := make(chan runLoopStopReason, 1)
	go func() {
		reason, _ := waitForRunLoopStop(context.Background(), signals, "https://control.example", time.Millisecond,
			func(context.Context, string) (string, bool) {
				close(checkStarted)
				<-finishCheck
				return "0.1.81", true
			})
		result <- reason
	}()

	select {
	case <-checkStarted:
	case <-time.After(time.Second):
		t.Fatal("update check did not start")
	}
	signals <- syscall.SIGTERM
	close(finishCheck)
	select {
	case reason := <-result:
		if reason != runLoopStopSignal {
			t.Fatalf("stop = %v, want SIGTERM to win over update", reason)
		}
	case <-time.After(time.Second):
		t.Fatal("waitForRunLoopStop did not return")
	}
}

func TestWaitForRunLoopStopContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	reason, remote := waitForRunLoopStop(ctx, nil, "https://control.example", time.Hour, nil)
	if reason != runLoopStopNone || remote != "" {
		t.Fatalf("stop = %v, %q; want context cancellation", reason, remote)
	}
}

func TestRestartForUpdateYieldsToSignalReceivedWhileDraining(t *testing.T) {
	signals := make(chan os.Signal, 1)
	signals <- syscall.SIGTERM
	if restartForUpdate(true, false, signals) {
		t.Fatal("restartForUpdate = true with pending SIGTERM, want normal exit")
	}
	if restartForUpdate(false, false, nil) {
		t.Fatal("restartForUpdate = true without update request")
	}
	if restartForUpdate(true, true, nil) {
		t.Fatal("restartForUpdate = true after drain timeout")
	}
}

func TestSelfUpdateSupervisorReexecsInsteadOfReusingStoppedRunLoop(t *testing.T) {
	var events []string
	superviseSelfUpdates("https://control.example",
		func(server string) { events = append(events, "update:"+server) },
		func() bool {
			events = append(events, "loop")
			return true
		},
		func() error {
			events = append(events, "reexec")
			return nil
		})
	want := []string{
		"update:https://control.example", "loop", "update:https://control.example", "reexec",
	}
	if !reflect.DeepEqual(events, want) {
		t.Fatalf("events = %#v, want %#v", events, want)
	}
}

func TestCarryOverModelCatalog(t *testing.T) {
	prev := &ModelCatalog{
		Codex:  []ModelInfo{{Value: "gpt-5.6-sol", Label: "GPT-5.6-Sol", ContextWindow: 372_000}},
		Claude: []ModelInfo{{Value: "claude-opus-5", Label: "Opus 5"}},
	}

	// Claude refreshed, `codex debug models` failed → keep the last good Codex list rather than
	// heartbeating a catalog that blanks it (which would drop the clients to a default window).
	merged := carryOverModelCatalog(prev, &ModelCatalog{
		Claude: []ModelInfo{{Value: "claude-opus-6", Label: "Opus 6"}},
	})
	if len(merged.Codex) != 1 || merged.Codex[0].ContextWindow != 372_000 {
		t.Fatalf("Codex = %#v, want the previous list carried over", merged.Codex)
	}
	if len(merged.Claude) != 1 || merged.Claude[0].Value != "claude-opus-6" {
		t.Fatalf("Claude = %#v, want this round's list", merged.Claude)
	}

	// A fresh Codex list always wins — carrying over must never pin a stale window.
	merged = carryOverModelCatalog(prev, &ModelCatalog{
		Codex: []ModelInfo{{Value: "gpt-5.7", Label: "GPT-5.7", ContextWindow: 512_000}},
	})
	if len(merged.Codex) != 1 || merged.Codex[0].ContextWindow != 512_000 {
		t.Fatalf("Codex = %#v, want this round's list", merged.Codex)
	}
	if len(merged.Claude) != 1 || merged.Claude[0].Value != "claude-opus-5" {
		t.Fatalf("Claude = %#v, want the previous list carried over", merged.Claude)
	}

	// First refresh after startup has nothing to carry over.
	first := &ModelCatalog{Codex: []ModelInfo{{Value: "gpt-5.6-sol", Label: "GPT-5.6-Sol"}}}
	if got := carryOverModelCatalog(nil, first); got != first {
		t.Fatalf("carryOverModelCatalog(nil, first) = %#v, want first unchanged", got)
	}
}

func TestReclaimStatusOpenRejectsTerminalAndUnknownRows(t *testing.T) {
	for _, tc := range []struct {
		status string
		open   bool
	}{
		{"", true}, // legacy reclaim responses contained RUNNING rows only
		{stPending, true},
		{stRunning, true},
		{stAwaitingInput, true},
		{stInterrupted, true},
		{stSucceeded, false},
		{stFailed, false},
		{stCancelled, false},
		{"FUTURE_TERMINAL", false},
	} {
		if got := reclaimStatusOpen(tc.status); got != tc.open {
			t.Errorf("reclaimStatusOpen(%q) = %v, want %v", tc.status, got, tc.open)
		}
	}
}

func TestReclaimMissingSessionsUsesStableTakeoverOrder(t *testing.T) {
	var mu sync.Mutex
	var takeoverOrder []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/runner/sessions/reclaim":
			_ = json.NewEncoder(w).Encode(ReclaimResponse{Sessions: []ReclaimSession{
				{SessionID: "b", Status: stAwaitingInput},
				{SessionID: "a", Status: stRunning},
				{SessionID: "c", Status: stInterrupted},
			}})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/takeover-leases"):
			parts := strings.Split(r.URL.Path, "/")
			id := parts[len(parts)-2]
			mu.Lock()
			takeoverOrder = append(takeoverOrder, id)
			mu.Unlock()
			status := stAwaitingInput
			if id == "a" {
				status = stRunning
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "status": status})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	starts, err := reclaimMissingSessions(context.Background(), NewTransport(srv.URL, "token"), func() map[string]bool {
		return map[string]bool{}
	})
	if err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	gotOrder := append([]string(nil), takeoverOrder...)
	mu.Unlock()
	if strings.Join(gotOrder, ",") != "a,b,c" {
		t.Fatalf("takeover order = %v, want [a b c]", gotOrder)
	}
	if len(starts) != 3 || starts[0].job.SessionID != "a" || !starts[0].initiallyActive {
		t.Fatalf("reclaimed starts = %#v", starts)
	}
}

func TestAmbiguousClaimCanBeRecoveredFromAuthoritativeReclaim(t *testing.T) {
	var claimCommitted atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/runner/sessions/claim":
			claimCommitted.Store(true)
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			_ = conn.Close() // commit happened, but the runner never received the session id
		case r.Method == http.MethodGet && r.URL.Path == "/api/runner/sessions/reclaim":
			if !claimCommitted.Load() {
				t.Error("reclaim happened before the simulated claim commit")
			}
			_ = json.NewEncoder(w).Encode(ReclaimResponse{Sessions: []ReclaimSession{{
				SessionID: "claimed-after-eof", Status: stRunning,
			}}})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/takeover-leases"):
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "status": stRunning})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	transport := NewTransport(srv.URL, "token")
	if job, err := transport.claimSession(context.Background()); err == nil || job != nil {
		t.Fatalf("ambiguous claim = (%#v, %v), want a response-loss error", job, err)
	}
	pool := newSessionPool(1)
	if _, added := pool.register(poolJob("claimed-after-eof"), func() {}, false); !added {
		t.Fatal("failed to register the pre-existing cold supervisor")
	}
	starts, err := reclaimMissingSessions(context.Background(), transport, pool.reclaimStates)
	if err != nil {
		t.Fatal(err)
	}
	if len(starts) != 1 || starts[0].job.SessionID != "claimed-after-eof" || !starts[0].initiallyActive {
		t.Fatalf("recovered starts = %#v", starts)
	}
	for _, start := range starts {
		if _, ok := pool.activate(start.job); !ok {
			t.Fatalf("recovered known supervisor %s was not activated", start.job.SessionID)
		}
	}
	if got := pool.activeCount(); got != 1 {
		t.Fatalf("active permits after response-loss recovery = %d, want 1", got)
	}
}
