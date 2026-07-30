package main

import (
	"os"
	"testing"
	"time"
)

// End-to-end check of the relay against the real CLI, opt-in via ORBIT_MANUAL_LOGIN_CHECK=1.
// Skipped by default: it needs network and the claude binary, and it opens (never completes) a
// real authorization. HOME is redirected so it cannot read or write this machine's credentials.
//
// Worth running after a claude CLI upgrade — the relay scrapes the CLI's own output, so this is
// what catches the day that output changes shape.
func TestManualLoginRelayEndToEnd(t *testing.T) {
	if os.Getenv("ORBIT_MANUAL_LOGIN_CHECK") != "1" {
		t.Skip("manual check")
	}
	dir := t.TempDir()
	t.Setenv("HOME", dir)

	got := make(chan LoginResultRequest, 4)
	r := &loginRelay{}
	r.start(func(res LoginResultRequest) { got <- res })

	select {
	case res := <-got:
		t.Logf("status=%s url=%.90s… message=%s", res.Status, res.URL, res.Message)
		if res.Status != loginAwaitingCode {
			t.Fatalf("expected %q, got %q (%s)", loginAwaitingCode, res.Status, res.Message)
		}
		// Second report: feed a bogus code and confirm it reaches the CLI and resolves.
		r.submitCode("definitely-not-a-real-code", func(res2 LoginResultRequest) { got <- res2 })
		select {
		case res2 := <-got:
			t.Logf("after bogus code: status=%s message=%s", res2.Status, res2.Message)
		case <-time.After(90 * time.Second):
			t.Log("no terminal report within 90s (CLI may still be retrying) — URL scrape still proven")
		}
	case <-time.After(75 * time.Second):
		t.Fatal("relay never reported a sign-in URL")
	}
}
