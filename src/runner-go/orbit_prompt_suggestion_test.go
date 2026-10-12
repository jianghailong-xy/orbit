package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTurnEndSucceededSpellsItTwoWays(t *testing.T) {
	for _, tc := range []struct {
		subtype interface{}
		want    bool
	}{
		{"success", true},  // claude, antigravity, opencode
		{"completed", true}, // codex, kimi, dsh
		{"error", false},
		{"interrupted", false},
		{"", false},
		{nil, false}, // a turn_end with no subtype at all
	} {
		payload := map[string]interface{}{}
		if tc.subtype != nil {
			payload["subtype"] = tc.subtype
		}
		if got := turnEndSucceeded(payload); got != tc.want {
			t.Errorf("turnEndSucceeded(%v) = %v, want %v", tc.subtype, got, tc.want)
		}
	}
}

func TestTurnSuggestionRoundTrip(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/runner/sessions/s1/turns/t1/suggestion" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"suggestion":"  run the tests  "}`)
	}))
	defer srv.Close()

	text, ok := NewTransport(srv.URL, "token").turnSuggestion(context.Background(), "s1", "t1")
	if !ok || text != "run the tests" {
		t.Fatalf("turnSuggestion = %q, %v; want trimmed text, true", text, ok)
	}
}

func TestTurnSuggestionDropsWhatIsNotASuggestion(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
		code int
	}{
		{"the server has nothing to offer", `{}`, 200},
		{"blank text", `{"suggestion":"   "}`, 200},
		{"longer than a suggestion ever is", `{"suggestion":"` + strings.Repeat("x", maxPromptSuggestionRunes+1) + `"}`, 200},
		{"a server error", `{"error":"boom"}`, 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.code)
				fmt.Fprint(w, tc.body)
			}))
			defer srv.Close()

			if text, ok := NewTransport(srv.URL, "token").turnSuggestion(context.Background(), "s1", "t1"); ok || text != "" {
				t.Fatalf("turnSuggestion = %q, %v; want no suggestion", text, ok)
			}
		})
	}
}

func TestFetchOrbitSuggestionFilesItUnlessTheWorldMovedOn(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"suggestion":"跑一遍测试"}`)
	}))
	defer srv.Close()
	transport := NewTransport(srv.URL, "token")

	// The guess lands against the turn it follows when nothing newer happened since.
	var emitted []string
	fetchOrbitSuggestion(context.Background(), transport, "s1", "t1", func() bool { return false }, func(text string) {
		emitted = append(emitted, text)
	})
	if len(emitted) != 1 || emitted[0] != "跑一遍测试" {
		t.Fatalf("emitted = %v, want the suggestion once", emitted)
	}

	// A new message answered what the guess was predicting: stale drops it.
	emitted = nil
	fetchOrbitSuggestion(context.Background(), transport, "s1", "t1", func() bool { return true }, func(text string) {
		emitted = append(emitted, text)
	})
	if len(emitted) != 0 {
		t.Fatalf("emitted = %v, want nothing filed once stale", emitted)
	}
}
