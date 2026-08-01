package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestTurnCompleteReturnsAuthoritativeSessionStatus(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"queued follow-up", `{"ok":true,"status":"RUNNING"}`, "RUNNING"},
		{"idle", `{"ok":true,"status":"AWAITING_INPUT"}`, stAwaitingInput},
		{"alternate field", `{"ok":true,"sessionStatus":"RUNNING"}`, "RUNNING"},
		{"legacy response", `{"ok":true}`, stAwaitingInput},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/api/runner/sessions/s1/turn-complete" {
					t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
				}
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, tc.body)
			}))
			defer srv.Close()

			got, err := NewTransport(srv.URL, "token").turnComplete(context.Background(), "s1", TurnCompleteRequest{TurnID: "t1"})
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Fatalf("status = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestTurnCompleteRetriesLostCommittedResponse(t *testing.T) {
	var requests atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) <= 3 {
			// Model: the idempotent DB transaction committed, then the connection
			// vanished before its authoritative status reached the runner. Lose
			// several responses to prove this is not a fixed retry-count policy.
			hj, ok := w.(http.Hijacker)
			if !ok {
				t.Fatal("test server does not support hijacking")
			}
			conn, _, err := hj.Hijack()
			if err != nil {
				t.Fatal(err)
			}
			if tcp, ok := conn.(*net.TCPConn); ok {
				_ = tcp.SetLinger(0)
			}
			_ = conn.Close()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"ok":true,"status":"AWAITING_INPUT"}`)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	got, err := NewTransport(srv.URL, "token").turnComplete(ctx, "s1", TurnCompleteRequest{TurnID: "t1"})
	if err != nil {
		t.Fatal(err)
	}
	if got != stAwaitingInput {
		t.Fatalf("status after retry = %q, want %q", got, stAwaitingInput)
	}
	if got := requests.Load(); got != 4 {
		t.Fatalf("request count = %d, want three retries", got)
	}
}

func TestTurnCompleteCarriesStableProcessLeaseOwner(t *testing.T) {
	transport := NewTransport("", "token")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body TurnCompleteRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.LeaseOwner != transport.leaseOwner {
			t.Fatalf("lease owner = %q, want %q", body.LeaseOwner, transport.leaseOwner)
		}
		_, _ = w.Write([]byte(`{"ok":true,"status":"AWAITING_INPUT"}`))
	}))
	defer srv.Close()
	transport.baseURL = srv.URL

	if _, err := transport.turnComplete(context.Background(), "s1", TurnCompleteRequest{TurnID: "t1"}); err != nil {
		t.Fatal(err)
	}
}

func TestPostEventsCarriesStableProcessLeaseOwner(t *testing.T) {
	transport := NewTransport("", "token")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body RunEventBatch
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.LeaseOwner != transport.leaseOwner {
			t.Fatalf("lease owner = %q, want %q", body.LeaseOwner, transport.leaseOwner)
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()
	transport.baseURL = srv.URL

	if err := transport.postEvents(context.Background(), "s1", RunEventBatch{Events: []RunEvent{{Seq: 1}}}); err != nil {
		t.Fatal(err)
	}
}

func TestTurnCompleteStopsRetryingWhenContextIsCancelled(t *testing.T) {
	requestStarted := make(chan struct{}, 1)
	releaseHandler := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestStarted <- struct{}{}
		<-releaseHandler
	}))
	t.Cleanup(func() {
		close(releaseHandler)
		srv.Close()
	})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := NewTransport(srv.URL, "token").turnComplete(ctx, "s1", TurnCompleteRequest{TurnID: "t1"})
		done <- err
	}()

	select {
	case <-requestStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("turn-complete request did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("turnComplete error = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("turnComplete did not stop after context cancellation")
	}
}

func TestStableTurnAckContextOutlivesProviderCancellation(t *testing.T) {
	attempts := make(chan struct{}, 8)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts <- struct{}{}
		http.Error(w, "temporary failure", http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	sessionCtx, cancelSession := context.WithCancel(context.Background())
	defer cancelSession()
	shutdownCtx, beginShutdown := context.WithCancel(context.Background())
	turnAckCtx, cancelTurnAck := contextWithStopGrace(sessionCtx, shutdownCtx, 25*time.Millisecond)
	defer cancelTurnAck()

	// A provider process generation has a shorter lifetime than its session ACK.
	// Cancelling it must not affect the stable ACK context.
	_, cancelProvider := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := NewTransport(srv.URL, "token").turnComplete(turnAckCtx, "s1", TurnCompleteRequest{TurnID: "t1"})
		done <- err
	}()

	select {
	case <-attempts:
	case <-time.After(2 * time.Second):
		t.Fatal("first turn-complete attempt did not start")
	}
	cancelProvider()
	select {
	case <-turnAckCtx.Done():
		t.Fatal("provider cancellation stopped the stable turn ACK context")
	default:
	}
	select {
	case <-attempts:
		// A retry after provider cancellation proves the ACK stayed alive.
	case <-time.After(2 * time.Second):
		t.Fatal("turn-complete did not retry after provider cancellation")
	}

	beginShutdown()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("turnComplete error = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("turn-complete did not stop after the ACK shutdown grace elapsed")
	}
}

func TestRetryReleaseTurnLeasesCallsEndpointUntilSuccess(t *testing.T) {
	const generation = "11111111-1111-4111-8111-111111111111"
	var requests atomic.Int32
	var leaseOwner string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/runner/sessions/s1/release-leases" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["leaseGeneration"] != generation {
			t.Fatalf("lease generation = %q, want %q", body["leaseGeneration"], generation)
		}
		if body["leaseOwner"] != leaseOwner || !uuidRE.MatchString(leaseOwner) {
			t.Fatalf("lease owner = %q, want %q UUID", body["leaseOwner"], leaseOwner)
		}
		if requests.Add(1) < 3 {
			http.Error(w, "temporary failure", http.StatusServiceUnavailable)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "status": stRunning})
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	transport := NewTransport(srv.URL, "token")
	leaseOwner = transport.leaseOwner
	err := retryReleaseTurnLeases(ctx, func(attemptCtx context.Context) error {
		return transport.releaseTurnLeases(attemptCtx, "s1", generation)
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := requests.Load(); got != 3 {
		t.Fatalf("release-leases request count = %d, want 3", got)
	}
}

func TestRetryActivateTurnLeasesCallsEndpointUntilSuccess(t *testing.T) {
	const generation = "33333333-3333-4333-8333-333333333333"
	var requests atomic.Int32
	var leaseOwner string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/runner/sessions/s1/activate-leases" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["leaseGeneration"] != generation {
			t.Fatalf("lease generation = %q, want %q", body["leaseGeneration"], generation)
		}
		if body["leaseOwner"] != leaseOwner || !uuidRE.MatchString(leaseOwner) {
			t.Fatalf("lease owner = %q, want %q UUID", body["leaseOwner"], leaseOwner)
		}
		if requests.Add(1) < 3 {
			http.Error(w, "temporary failure", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	transport := NewTransport(srv.URL, "token")
	leaseOwner = transport.leaseOwner
	err := retryActivateTurnLeases(ctx, func(attemptCtx context.Context) error {
		return transport.activateTurnLeases(attemptCtx, "s1", generation)
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := requests.Load(); got != 3 {
		t.Fatalf("activate-leases request count = %d, want 3", got)
	}
}

func TestRetryActivateTurnLeasesStopsOnOwnerConflict(t *testing.T) {
	var requests atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		http.Error(w, "owner changed", http.StatusConflict)
	}))
	defer srv.Close()
	transport := NewTransport(srv.URL, "token")

	err := retryActivateTurnLeases(context.Background(), func(ctx context.Context) error {
		return transport.activateTurnLeases(ctx, "s1", "33333333-3333-4333-8333-333333333333")
	})
	if !isTransportHTTPStatus(err, http.StatusConflict) {
		t.Fatalf("activate error = %v, want HTTP 409", err)
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("activate request count = %d, want 1", got)
	}
}

func TestInboxCarriesEngineLeaseGeneration(t *testing.T) {
	const generation = "22222222-2222-4222-8222-222222222222"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/runner/sessions/s1/inbox" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if got := r.URL.Query().Get("leaseGeneration"); got != generation {
			t.Fatalf("lease generation = %q, want %q", got, generation)
		}
		_, _ = w.Write([]byte(`{"turnId":"","seq":0,"kind":"message"}`))
	}))
	defer srv.Close()

	got, err := NewTransport(srv.URL, "token").inbox(context.Background(), "s1", generation)
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("empty inbox = %#v, want nil", got)
	}
}

func TestTakeoverCarriesStableRunnerLeaseOwnerAndExpectedPredecessor(t *testing.T) {
	const predecessor = "66666666-6666-4666-8666-666666666666"
	transport := NewTransport("", "token")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/runner/sessions/s1/takeover-leases" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if got, _ := body["leaseOwner"].(string); got != transport.leaseOwner || !uuidRE.MatchString(got) {
			t.Fatalf("lease owner = %q, want %q UUID", got, transport.leaseOwner)
		}
		if got := body["expectedLeaseOwner"]; got != predecessor {
			t.Fatalf("expected lease owner = %#v, want %q", got, predecessor)
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "status": stRunning})
	}))
	defer srv.Close()
	transport.baseURL = srv.URL

	status, err := transport.takeoverTurnLeases(context.Background(), "s1", predecessor)
	if err != nil {
		t.Fatal(err)
	}
	if status != stRunning {
		t.Fatalf("takeover status = %q, want %q", status, stRunning)
	}
}

func TestRetryTakeoverStopsOnCASConflict(t *testing.T) {
	var requests atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		http.Error(w, "owner changed", http.StatusConflict)
	}))
	defer srv.Close()
	transport := NewTransport(srv.URL, "token")

	err := retryTakeoverTurnLeases(context.Background(), func(ctx context.Context) error {
		_, err := transport.takeoverTurnLeases(ctx, "s1", "")
		return err
	})
	if !isTransportHTTPStatus(err, http.StatusConflict) {
		t.Fatalf("takeover error = %v, want HTTP 409", err)
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("takeover request count = %d, want 1", got)
	}
}

func TestLeaseHandshakeRetriesStopOnNonRetryableClientErrors(t *testing.T) {
	for _, tc := range []struct {
		name  string
		retry func(context.Context, func(context.Context) error) error
	}{
		{"takeover", retryTakeoverTurnLeases},
		{"activate", retryActivateTurnLeases},
		{"release", retryReleaseTurnLeases},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var attempts atomic.Int32
			err := tc.retry(context.Background(), func(context.Context) error {
				attempts.Add(1)
				return &transportHTTPError{statusCode: http.StatusForbidden}
			})
			if !isTransportHTTPStatus(err, http.StatusForbidden) {
				t.Fatalf("error = %v, want HTTP 403", err)
			}
			if got := attempts.Load(); got != 1 {
				t.Fatalf("attempts = %d, want 1", got)
			}
		})
	}
}

func TestTakeoverClaimedSessionConfirmsMatchingSnapshotOwnerWithServer(t *testing.T) {
	var requests atomic.Int32
	transport := NewTransport("", "token")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if got := body["leaseOwner"]; got != transport.leaseOwner {
			t.Fatalf("lease owner = %#v, want %q", got, transport.leaseOwner)
		}
		if got := body["expectedLeaseOwner"]; got != transport.leaseOwner {
			t.Fatalf("expected owner = %#v, want matching snapshot %q", got, transport.leaseOwner)
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "status": stRunning})
	}))
	defer srv.Close()
	transport.baseURL = srv.URL
	job := &ClaimedSession{SessionID: "s1", LeaseOwner: transport.leaseOwner}

	status, err := takeoverClaimedSession(context.Background(), transport, job)
	if err != nil {
		t.Fatal(err)
	}
	if status != stRunning {
		t.Fatalf("takeover status = %q, want %q", status, stRunning)
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("takeover request count = %d, want 1", got)
	}
}

func TestOnlyRunningRetainsTurnPermit(t *testing.T) {
	for _, tc := range []struct {
		status string
		want   bool
	}{
		{stRunning, true},
		{stAwaitingInput, false},
		{"PENDING", false},
		{stSucceeded, false},
		{stFailed, false},
		{stCancelled, false},
	} {
		if got := retainsTurnPermit(tc.status); got != tc.want {
			t.Errorf("retainsTurnPermit(%q) = %v, want %v", tc.status, got, tc.want)
		}
	}
}

func TestReclaimInitiallyActive(t *testing.T) {
	for _, tc := range []struct {
		status string
		want   bool
	}{
		{"", true}, // compatibility with old RUNNING-only reclaim responses
		{stRunning, true},
		{"PENDING", false},
		{stAwaitingInput, false},
		{stInterrupted, false},
	} {
		if got := reclaimInitiallyActive(tc.status); got != tc.want {
			t.Errorf("reclaimInitiallyActive(%q) = %v, want %v", tc.status, got, tc.want)
		}
	}
}
