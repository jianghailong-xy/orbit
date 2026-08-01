package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestFinalizeRunUsesCanonicalRoute(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		_ = json.NewEncoder(w).Encode(RunFinalizeResponse{Ok: true, KeepCheckout: false})
	}))
	defer server.Close()

	keep, err := NewTransport(server.URL, "").finalizeRun("session-1", RunFinalizeRequest{Status: "SUCCEEDED"})
	if err != nil {
		t.Fatalf("finalizeRun: %v", err)
	}
	if keep {
		t.Fatal("Completed session checkout should not be kept")
	}
	if want := []string{"/api/runner/sessions/session-1/finalize"}; !reflect.DeepEqual(paths, want) {
		t.Fatalf("paths = %v, want %v", paths, want)
	}
}

func TestFinalizeRunFallsBackToLegacyCompleteRouteOn404(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		if r.URL.Path == "/api/runner/sessions/session-1/finalize" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(RunFinalizeResponse{Ok: true, KeepCheckout: true})
	}))
	defer server.Close()

	keep, err := NewTransport(server.URL, "").finalizeRun("session-1", RunFinalizeRequest{Status: "CANCELLED"})
	if err != nil {
		t.Fatalf("finalizeRun fallback: %v", err)
	}
	if !keep {
		t.Fatal("resumable session checkout should be kept")
	}
	want := []string{
		"/api/runner/sessions/session-1/finalize",
		"/api/runner/sessions/session-1/complete",
	}
	if !reflect.DeepEqual(paths, want) {
		t.Fatalf("paths = %v, want %v", paths, want)
	}
}

func TestCompleteSessionFallsBackToLegacyArchiveRouteOn404(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		if got := r.Header.Get("X-Orbit-Session-Token"); got != "credential" {
			t.Fatalf("orchestration credential = %q", got)
		}
		if r.URL.Path == "/api/runner/sessions/session-1/complete-session" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	if _, err := NewTransport(server.URL, "").completeSession(
		"caller", "credential", "session-1",
	); err != nil {
		t.Fatalf("completeSession fallback: %v", err)
	}
	want := []string{
		"/api/runner/sessions/session-1/complete-session",
		"/api/runner/sessions/session-1/archive",
	}
	if !reflect.DeepEqual(paths, want) {
		t.Fatalf("paths = %v, want %v", paths, want)
	}
}
