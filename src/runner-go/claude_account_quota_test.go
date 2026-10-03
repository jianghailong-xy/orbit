package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
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

// writeClaudeLogin is writeClaudeCredentials with the token's expiry, which the CLI records in
// milliseconds since the epoch.
func writeClaudeLogin(t *testing.T, dir, token string, expiresAt time.Time) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(map[string]any{
		"claudeAiOauth": map[string]any{
			"accessToken":      token,
			"refreshToken":     "r",
			"expiresAt":        expiresAt.UnixMilli(),
			"subscriptionType": "max",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".credentials.json"), body, 0o600); err != nil {
		t.Fatal(err)
	}
}

// fakeClaudeTokenCLI puts on PATH a `claude` that does what the real one does in a login's config directory
// (CLAUDE_CONFIG_DIR, else ~/.claude). Run as `claude -p /help --no-session-persistence`, it refreshes
// the token the way mode says the server answers: "refresh" writes a fresh token, good for eight
// hours; "refuse" changes nothing and exits 1, as the real one does offline; "zombie" — a refresh
// token the server already spent — empties both tokens, as the real one does on invalid_grant. Any
// other `-p` run changes nothing and exits 1. `auth status` answers loggedIn while an access token is
// stored. Every run is recorded: refreshes() returns the CLAUDE_CONFIG_DIR of each `-p` run, and
// statuses() that of each `auth status`, "" for a run that named none.
func fakeClaudeTokenCLI(t *testing.T, mode, fresh string) (refreshes, statuses func() []string) {
	t.Helper()
	bin := t.TempDir()
	log := filepath.Join(bin, "runs")
	expires := strconv.FormatInt(time.Now().Add(8*time.Hour).UnixMilli(), 10)
	creds := `"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json"`
	script := `#!/bin/sh
if [ "$1 $2" = "auth status" ]; then
  printf 'status\t%s\n' "$CLAUDE_CONFIG_DIR" >> '` + log + `'
  if [ -f ` + creds + ` ] && ! grep -q '"accessToken":""' ` + creds + `; then echo '{"loggedIn":true}'; else echo '{"loggedIn":false}'; fi
  exit 0
fi
printf 'refresh\t%s\n' "$CLAUDE_CONFIG_DIR" >> '` + log + `'
print=0 help=0 persist=1
for arg in "$@"; do
  [ "$arg" = "-p" ] && print=1
  [ "$arg" = "/help" ] && help=1
  [ "$arg" = "--no-session-persistence" ] && persist=0
done
[ "$print" = 1 ] && [ "$help" = 1 ] && [ "$persist" = 0 ] || exit 1
[ -n "$FAKE_CLAUDE_HOLD" ] && while [ -e "$FAKE_CLAUDE_HOLD" ]; do sleep 0.05; done
`
	switch mode {
	case "refresh":
		script += `printf '{"claudeAiOauth":{"accessToken":"` + fresh + `","refreshToken":"r2","expiresAt":` + expires + `}}' > ` + creds + "\n"
	case "zombie":
		script += `printf '{"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":null}}' > ` + creds + "\n"
	default:
		script += "exit 1\n"
	}
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	runs := func(kind string) []string {
		b, err := os.ReadFile(log)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			t.Fatal(err)
		}
		var dirs []string
		for _, line := range strings.Split(strings.TrimSuffix(string(b), "\n"), "\n") {
			if k, dir, _ := strings.Cut(line, "\t"); k == kind {
				dirs = append(dirs, dir)
			}
		}
		return dirs
	}
	return func() []string { return runs("refresh") }, func() []string { return runs("status") }
}

// TestClaudeAccountQuotaHasClaudeCodeRefreshAnExpiredToken: an account no session runs on has nothing
// that refreshes its token in time — on wikova (2026-10-02) such an account read 401 for twelve hours,
// its reading frozen. The read asks the CLI to refresh it, in that account's own directory and with a
// run that bills nothing, then reads with the token the CLI left. The expired token is never sent,
// and no token reaches the log.
func TestClaudeAccountQuotaHasClaudeCodeRefreshAnExpiredToken(t *testing.T) {
	home, _ := claudeAccountSlotTestHomes(t)
	srv, tokens := claudeUsageServer(t, 100)
	planUsageURL = srv.URL
	refreshes, _ := fakeClaudeTokenCLI(t, "refresh", "fresh-token")
	work, err := claudeAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	writeClaudeLogin(t, filepath.Join(home, ".claude"), "default-token", time.Now().Add(time.Hour))
	expiry := time.Now().Add(-time.Hour)
	writeClaudeLogin(t, work.Dir, "expired-token", expiry)

	usage := newClaudeAccountUsage()
	var workUsage *PlanUsage
	logs := captureRunnerStdout(t, func() {
		read(t, usage.def)
		workUsage = read(t, usage.slot(work.ID).probe)
	})
	if workUsage == nil || workUsage.FiveHour == nil || workUsage.FiveHour.Utilization != 100 {
		t.Fatalf("work usage = %#v, want the reading the refreshed token got", workUsage)
	}
	// Default's token was good and the CLI was left alone for it; Work's was refreshed in Work's own
	// directory, not the machine's.
	if got := refreshes(); !slices.Equal(got, []string{work.Dir}) {
		t.Fatalf("claude refreshed for %q, want once, for %s", got, work.Dir)
	}
	if got := tokens(); !slices.Equal(got, []string{"Bearer default-token", "Bearer fresh-token"}) {
		t.Fatalf("tokens seen = %q, want Default's then Work's refreshed one — never the expired one", got)
	}
	want := "claude plan-usage (account " + work.ID + "): Claude Code refreshed the access token (expiry " +
		expiry.UTC().Format(time.RFC3339) + ")"
	if !strings.Contains(logs, want) {
		t.Fatalf("the probe logged:\n%s\nwant a line %q", logs, want)
	}
	for _, token := range []string{"default-token", "expired-token", "fresh-token"} {
		if strings.Contains(logs, token) {
			t.Fatalf("%q reached the log:\n%s", token, logs)
		}
	}

	// The machine's own login is refreshed the same way, in the directory the runner's environment
	// selects: no CLAUDE_CONFIG_DIR of the read's own.
	writeClaudeLogin(t, filepath.Join(home, ".claude"), "default-token", time.Now().Add(-time.Minute))
	captureRunnerStdout(t, func() { read(t, usage.def) })
	if got := refreshes(); !slices.Equal(got, []string{work.Dir, ""}) {
		t.Fatalf("claude refreshed for %q, want Work's directory, then the runner's own", got)
	}
	if got := tokens(); got[len(got)-1] != "Bearer fresh-token" {
		t.Fatalf("tokens seen = %q, want Default read with its refreshed token", got)
	}
}

// TestClaudeAccountQuotaRefreshesBeforeTheTokenExpires: a token within the CLI's own five minutes is
// refreshed then, so the reading never meets an expired one. A CLI that does not refresh it leaves a
// token still good for a few minutes, and the read goes on with it.
func TestClaudeAccountQuotaRefreshesBeforeTheTokenExpires(t *testing.T) {
	for _, tc := range []struct {
		mode, want string
	}{
		{"refresh", "Bearer fresh-token"},
		{"refuse", "Bearer due-token"},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			claudeAccountSlotTestHomes(t)
			srv, tokens := claudeUsageServer(t, 3)
			planUsageURL = srv.URL
			refreshes, _ := fakeClaudeTokenCLI(t, tc.mode, "fresh-token")
			work, err := claudeAccountKind.create("Work")
			if err != nil {
				t.Fatal(err)
			}
			writeClaudeLogin(t, work.Dir, "due-token", time.Now().Add(2*time.Minute))

			probe := newClaudeAccountUsage().slot(work.ID).probe
			captureRunnerStdout(t, func() { read(t, probe) })
			if got := refreshes(); !slices.Equal(got, []string{work.Dir}) {
				t.Fatalf("claude refreshed for %q, want once, for Work", got)
			}
			if got := tokens(); !slices.Equal(got, []string{tc.want}) {
				t.Fatalf("tokens seen = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestClaudeAccountQuotaDoesNotResendARefusedToken: a token the endpoint answered 401 is not sent
// again. On wikova the same dead token went out every ten minutes for twelve hours, and the 401s
// came with 429s. A token that is not due is not the CLI's to refresh, either: the read waits for a
// new one — signed in again, or refreshed once it is due — and reads with it at once.
func TestClaudeAccountQuotaDoesNotResendARefusedToken(t *testing.T) {
	claudeAccountSlotTestHomes(t)
	var mu sync.Mutex
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Header.Get("authorization"))
		mu.Unlock()
		if r.Header.Get("authorization") == "Bearer revoked-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"five_hour": map[string]any{"utilization": 7}})
	}))
	t.Cleanup(srv.Close)
	planUsageURL = srv.URL
	tokens := func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), seen...)
	}
	refreshes, _ := fakeClaudeTokenCLI(t, "refresh", "fresh-token")
	work, err := claudeAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	writeClaudeLogin(t, work.Dir, "revoked-token", time.Now().Add(time.Hour))

	probe := newClaudeAccountUsage().slot(work.ID).probe
	var errs []string
	for pass := 0; pass < 3; pass++ {
		_, err := probe.fetch(context.Background(), probe.client)
		if err == nil {
			t.Fatalf("pass %d read with a refused token", pass)
		}
		errs = append(errs, err.Error())
	}
	if got := tokens(); !slices.Equal(got, []string{"Bearer revoked-token"}) {
		t.Fatalf("tokens seen = %q, want the refused token sent once", got)
	}
	// Every pass says the same thing, so the probe's log says it once.
	if errs[1] != errs[0] || errs[2] != errs[0] {
		t.Fatalf("the passes said %q, want one thing", errs)
	}
	if got := refreshes(); len(got) != 0 {
		t.Fatalf("claude refreshed for %q over a token that was not due", got)
	}

	writeClaudeLogin(t, work.Dir, "new-token", time.Now().Add(time.Hour))
	if got := read(t, probe); got == nil || got.FiveHour == nil || got.FiveHour.Utilization != 7 {
		t.Fatalf("usage = %#v, want the new token's reading", got)
	}
	if got := tokens(); !slices.Equal(got, []string{"Bearer revoked-token", "Bearer new-token"}) {
		t.Fatalf("tokens seen = %q", got)
	}
}

// TestClaudeAccountQuotaWaitsBeforeAskingClaudeCodeAgain: a CLI that leaves the token expired — no
// network, a server that will not answer — is not run again on every pass, and the expired token is
// not sent meanwhile: the read says what is wrong instead.
func TestClaudeAccountQuotaWaitsBeforeAskingClaudeCodeAgain(t *testing.T) {
	claudeAccountSlotTestHomes(t)
	srv, tokens := claudeUsageServer(t, 1)
	planUsageURL = srv.URL
	refreshes, _ := fakeClaudeTokenCLI(t, "refuse", "")
	work, err := claudeAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	expiry := time.Now().Add(-time.Hour)
	writeClaudeLogin(t, work.Dir, "expired-token", expiry)

	probe := newClaudeAccountUsage().slot(work.ID).probe
	want := "access token expired at " + expiry.UTC().Format(time.RFC3339) + "; Claude Code did not refresh it: exit status 1"
	for pass := 0; pass < 2; pass++ {
		_, err := probe.fetch(context.Background(), probe.client)
		if err == nil || err.Error() != want {
			t.Fatalf("pass %d: err = %v, want %q", pass, err, want)
		}
	}
	if got := refreshes(); len(got) != 1 {
		t.Fatalf("claude refreshed %d times in two passes, want once", len(got))
	}
	if got := tokens(); len(got) != 0 {
		t.Fatalf("tokens seen = %q, want the expired token never sent", got)
	}

	previous := claudeTokenRefreshRetry
	claudeTokenRefreshRetry = 0
	t.Cleanup(func() { claudeTokenRefreshRetry = previous })
	if _, err := probe.fetch(context.Background(), probe.client); err == nil {
		t.Fatal("read with a token the CLI did not refresh")
	}
	if got := refreshes(); len(got) != 2 {
		t.Fatalf("claude refreshed %d times, want asked again once the retry was due", len(got))
	}
}

// TestClaudeAccountQuotaReportsAZombieLoginSignedOut: a login whose refresh token the server already
// spent — what the engine probe's cut-short refreshes left behind — cannot be refreshed. Asked, the CLI
// empties it; the read says the login is signed out instead of sending anything, and the engine
// probe, which used to read Signed in over twelve hours of 401s, now says Signed out too.
func TestClaudeAccountQuotaReportsAZombieLoginSignedOut(t *testing.T) {
	claudeAccountSlotTestHomes(t)
	srv, tokens := claudeUsageServer(t, 1)
	planUsageURL = srv.URL
	refreshes, _ := fakeClaudeTokenCLI(t, "zombie", "")
	work, err := claudeAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	writeClaudeLogin(t, work.Dir, "zombie-token", time.Now().Add(-time.Hour))
	if got := accountLoginStatus(claudeAccountKind, "claude", work.Dir); got != authYes {
		t.Fatalf("before the refresh the login reads %v, want signed in: nothing has tried it yet", got)
	}

	probe := newClaudeAccountUsage().slot(work.ID).probe
	_, err = probe.fetch(context.Background(), probe.client)
	if err == nil || !strings.HasPrefix(err.Error(), "signed out:") {
		t.Fatalf("err = %v, want the login reported signed out", err)
	}
	if got := refreshes(); len(got) != 1 {
		t.Fatalf("claude refreshed %d times, want once", len(got))
	}
	if got := tokens(); len(got) != 0 {
		t.Fatalf("tokens seen = %q, want nothing sent", got)
	}
	if got := accountLoginStatus(claudeAccountKind, "claude", work.Dir); got != authNo {
		t.Fatalf("after the refresh the login reads %v, want signed out", got)
	}
}

// TestClaudeTokenRefreshRunsOncePerDirectory: one directory never has two refresh runs at once — a
// second ask while the first is under way is turned away, not queued — while another directory's
// goes ahead. And a refresh is not cut off with the read that asked for it: stopped once the server
// has rotated the token, it would leave the login holding a spent one.
func TestClaudeTokenRefreshRunsOncePerDirectory(t *testing.T) {
	home, _ := claudeAccountSlotTestHomes(t)
	refreshes, _ := fakeClaudeTokenCLI(t, "refresh", "fresh-token")
	work, err := claudeAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	writeClaudeLogin(t, work.Dir, "expired-token", time.Now().Add(-time.Hour))
	writeClaudeLogin(t, filepath.Join(home, ".claude"), "expired-token", time.Now().Add(-time.Hour))
	hold := filepath.Join(t.TempDir(), "hold")
	if err := os.WriteFile(hold, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_CLAUDE_HOLD", hold)

	// The read that asked is gone before the refresh has finished.
	gone, cancel := context.WithCancel(context.Background())
	cancel()
	first := make(chan error, 1)
	go func() { first <- refreshClaudeToken(gone, work.Dir) }()
	deadline := time.Now().Add(10 * time.Second)
	for len(refreshes()) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if err := refreshClaudeToken(context.Background(), work.Dir); !errors.Is(err, errClaudeRefreshRunning) {
		t.Fatalf("a second refresh in the same directory: err = %v, want it turned away", err)
	}
	if err := os.Remove(hold); err != nil {
		t.Fatal(err)
	}
	if err := <-first; err != nil {
		t.Fatalf("the first refresh: %v", err)
	}
	if err := refreshClaudeToken(context.Background(), ""); err != nil {
		t.Fatalf("the runner's own login, a directory of its own: %v", err)
	}
	if got := refreshes(); !slices.Equal(got, []string{work.Dir, ""}) {
		t.Fatalf("claude refreshed for %q, want Work once, then the runner's own", got)
	}
	login, err := claudeOAuthLoginIn(work.Dir)
	if err != nil || login.accessToken != "fresh-token" {
		t.Fatalf("Work after its refresh: %v, want the refreshed token — the refresh ran to its end", err)
	}
}
