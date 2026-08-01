package main

import (
	"context"
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

func TestTurnCompleteStopsRetryingWhenContextIsCancelled(t *testing.T) {
	requestStarted := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestStarted <- struct{}{}
		<-r.Context().Done()
	}))
	defer srv.Close()

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
	var requests atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/runner/sessions/s1/release-leases" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
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
	err := retryReleaseTurnLeases(ctx, func(attemptCtx context.Context) error {
		return transport.releaseTurnLeases(attemptCtx, "s1")
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := requests.Load(); got != 3 {
		t.Fatalf("release-leases request count = %d, want 3", got)
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
