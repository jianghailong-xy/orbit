package main

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
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

			got, err := NewTransport(srv.URL, "token").turnComplete("s1", TurnCompleteRequest{TurnID: "t1"})
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
		if requests.Add(1) == 1 {
			// Model: the idempotent DB transaction committed, then the connection
			// vanished before its authoritative status reached the runner.
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

	got, err := NewTransport(srv.URL, "token").turnComplete("s1", TurnCompleteRequest{TurnID: "t1"})
	if err != nil {
		t.Fatal(err)
	}
	if got != stAwaitingInput {
		t.Fatalf("status after retry = %q, want %q", got, stAwaitingInput)
	}
	if got := requests.Load(); got != 2 {
		t.Fatalf("request count = %d, want one retry", got)
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
