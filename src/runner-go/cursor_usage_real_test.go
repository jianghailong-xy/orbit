package main

// Cursor CLI plan usage against Cursor's real dashboard (cursor_usage.go), opt-in: it reads a real account
// and spends no prompt. ORBIT_TEST_REAL_CURSOR_ACCOUNT names an account directory holding a saved sign-in
// where this platform's `agent login` leaves it (cursorStoredLoginPath: xdg-config/cursor/auth.json on Linux,
// home/.cursor/auth.json on macOS) — or where the pinned CLI leaves an API key it traded for a token with
// AGENT_CLI_CREDENTIAL_STORE=file, XDG_CONFIG_HOME=<dir>/xdg-config and HOME=<dir>/home (contract §8.2, §18.3).

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"testing"
	"time"
)

// The account's usage, read the way the runner reads it, with nothing that names the account in what it prints.
func TestCursorUsageReadsTheRealDashboard(t *testing.T) {
	dir := os.Getenv("ORBIT_TEST_REAL_CURSOR_ACCOUNT")
	if dir == "" {
		t.Skip("set ORBIT_TEST_REAL_CURSOR_ACCOUNT to an account directory holding a saved Cursor CLI sign-in")
	}
	usage, err := (&cursorUsageRead{}).fetch(context.Background(), &http.Client{}, dir)
	if err != nil {
		t.Fatal(err)
	}
	if usage.Provider != providerCursor || usage.PlanName == "" || usage.IncludedUsage == nil {
		t.Fatalf("read = %+v", usage)
	}
	starts, err := time.Parse(time.RFC3339, usage.IncludedUsage.StartsAt)
	if err != nil {
		t.Fatalf("startsAt %q: %v", usage.IncludedUsage.StartsAt, err)
	}
	resets, err := time.Parse(time.RFC3339, usage.IncludedUsage.ResetsAt)
	if err != nil || !resets.After(starts) || !resets.After(time.Now()) {
		t.Fatalf("resetsAt %q (startsAt %q): want a reset after the period began, still ahead", usage.IncludedUsage.ResetsAt, usage.IncludedUsage.StartsAt)
	}
	wire, _ := json.Marshal(usage)
	t.Logf("read: %s", wire)
}
