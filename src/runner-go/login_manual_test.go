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
		if res.URL == "" {
			t.Fatal("no sign-in URL scraped")
		}
		// Feed a bogus code. The CLI answers with "Invalid code." on the same prompt — it does not
		// exit and does not re-prompt — so this is the assertion that the rejection watcher is
		// keyed on something that actually happens. It hung here until the 10-minute timeout when
		// the watcher was (wrongly) looking for a second prompt instead.
		r.submitCode("definitely-not-a-real-code", func(res2 LoginResultRequest) { got <- res2 })
		select {
		case res2 := <-got:
			t.Logf("after bogus code: status=%s message=%q", res2.Status, res2.Message)
			if res2.Status != loginAwaitingCode || res2.Message == "" {
				t.Errorf("a rejected code should come back as %q with an explanation, got %q/%q",
					loginAwaitingCode, res2.Status, res2.Message)
			}
			if res2.URL == "" {
				t.Error("the still-valid sign-in URL was not republished with the rejection")
			}
		case <-time.After(60 * time.Second):
			t.Fatal("a rejected code produced no report — the rejection watcher is not firing")
		}
	case <-time.After(75 * time.Second):
		t.Fatal("relay never reported a sign-in URL")
	}
}
