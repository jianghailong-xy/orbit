package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// claudeUsageServer stands in for Anthropic's usage endpoint, recording the bearer token of every
// read so the test can say WHICH login was asked, with the five-hour window it answers.
func claudeUsageServer(t *testing.T, utilization float64) (*httptest.Server, func() []string) {
	t.Helper()
	var mu sync.Mutex
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Header.Get("authorization"))
		mu.Unlock()
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"five_hour": map[string]any{"utilization": utilization, "resets_at": "2026-09-26T20:00:00Z"},
		})
	}))
	t.Cleanup(srv.Close)
	return srv, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), seen...)
	}
}

// writeClaudeCredentials puts one login's OAuth token in the directory its CLI would keep it in.
func writeClaudeCredentials(t *testing.T, dir, token string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(map[string]any{
		"claudeAiOauth": map[string]any{"accessToken": token, "refreshToken": "r", "subscriptionType": "max"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".credentials.json"), body, 0o600); err != nil {
		t.Fatal(err)
	}
}

// read is one probe's own read, without the refresh loop: what the heartbeat's periodic pass does.
func read(t *testing.T, probe *planUsageProbe) *PlanUsage {
	t.Helper()
	usage, err := probe.fetch(context.Background(), probe.client)
	if err != nil {
		t.Fatalf("read %s: %v", probe.name, err)
	}
	probe.store(usage)
	return probe.snapshot()
}

func TestClaudeAccountQuotaReadsEachAccountWithItsOwnToken(t *testing.T) {
	home, _ := claudeAccountSlotTestHomes(t)
	srv, tokens := claudeUsageServer(t, 12)
	planUsageURL = srv.URL
	// The machine's own login, and one added account with a token of its own.
	writeClaudeCredentials(t, filepath.Join(home, ".claude"), "default-token")
	work, err := claudeAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	writeClaudeCredentials(t, work.Dir, "work-token")

	usage := newClaudeAccountUsage()
	def := read(t, usage.def)
	slot := usage.slot(work.ID)
	workUsage := read(t, slot.probe)

	if def == nil || workUsage == nil {
		t.Fatalf("read nothing: default=%v work=%v", def, workUsage)
	}
	// Each read carried its own login's token: the whole point of one account per directory.
	if got := tokens(); len(got) != 2 || got[0] != "Bearer default-token" || got[1] != "Bearer work-token" {
		t.Fatalf("tokens seen = %q, want the default's then Work's own", got)
	}

	snapshot := usage.snapshot()
	if snapshot == nil || snapshot.Provider != providerClaude {
		t.Fatalf("snapshot = %#v, want the claude snapshot", snapshot)
	}
	// Default's windows are the snapshot's own; Work's are its entry, and never merged into them.
	if snapshot.FiveHour == nil || snapshot.FiveHour.Utilization != 12 {
		t.Fatalf("default windows = %#v", snapshot.FiveHour)
	}
	entry := snapshot.Accounts[work.ID]
	if entry == nil || entry.FiveHour == nil || entry.FiveHour.Utilization != 12 {
		t.Fatalf("work entry = %#v", entry)
	}
	if entry.Accounts != nil {
		t.Fatal("an account's own snapshot carries no accounts of its own")
	}
}

// TestClaudeAccountQuotaNeverBorrowsTheMachinesLogin: a slot nobody has signed in reports nothing at
// all, even while the machine's own login has credentials on disk — the macOS Keychain fallback is
// one global item, and a read that took it would report Default's quota as this account's.
func TestClaudeAccountQuotaNeverBorrowsTheMachinesLogin(t *testing.T) {
	home, _ := claudeAccountSlotTestHomes(t)
	srv, tokens := claudeUsageServer(t, 99)
	planUsageURL = srv.URL
	writeClaudeCredentials(t, filepath.Join(home, ".claude"), "default-token")
	work, err := claudeAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}

	usage := newClaudeAccountUsage()
	slot := usage.slot(work.ID)
	if _, err := slot.probe.fetch(context.Background(), slot.probe.client); err == nil {
		t.Fatal("read a slot with no credentials of its own")
	}
	// Nothing was asked, and the account contributes nothing to the heartbeat.
	if got := tokens(); len(got) != 0 {
		t.Fatalf("tokens seen = %q, want no read at all", got)
	}
	if snapshot := usage.snapshot(); snapshot != nil {
		if _, ok := snapshot.Accounts[work.ID]; ok {
			t.Fatalf("an unread account was reported: %#v", snapshot.Accounts)
		}
	}

	// And once it is signed in, its own token is the one used.
	writeClaudeCredentials(t, work.Dir, "work-token")
	read(t, slot.probe)
	snapshot := usage.snapshot()
	if snapshot == nil || snapshot.Accounts[work.ID] == nil {
		t.Fatalf("signed-in account missing from %#v", snapshot)
	}
	if got := tokens(); len(got) != 1 || got[0] != "Bearer work-token" {
		t.Fatalf("tokens seen = %q, want Work's own", got)
	}
}

// TestClaudeAccountQuotaForgetsARemovedAccount: the probe loop goes with the directory, so a removed
// account is not read again and leaves the heartbeat's account list.
func TestClaudeAccountQuotaForgetsARemovedAccount(t *testing.T) {
	home, _ := claudeAccountSlotTestHomes(t)
	srv, _ := claudeUsageServer(t, 5)
	planUsageURL = srv.URL
	writeClaudeCredentials(t, filepath.Join(home, ".claude"), "default-token")
	work, err := claudeAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	writeClaudeCredentials(t, work.Dir, "work-token")

	usage := newClaudeAccountUsage()
	read(t, usage.def)
	read(t, usage.slot(work.ID).probe)
	if snapshot := usage.snapshot(); snapshot == nil || snapshot.Accounts[work.ID] == nil {
		t.Fatalf("work missing before the removal: %#v", snapshot)
	}

	if err := removeClaudeAccount(usage, work.ID, nil); err != nil {
		t.Fatal(err)
	}
	if snapshot := usage.snapshot(); snapshot != nil {
		if _, ok := snapshot.Accounts[work.ID]; ok {
			t.Fatalf("a removed account is still reported: %#v", snapshot.Accounts)
		}
	}
	if _, err := os.Lstat(work.Dir); !os.IsNotExist(err) {
		t.Fatalf("the directory outlived the removal (err %v)", err)
	}
}
