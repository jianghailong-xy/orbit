package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

// fakeClaudeForAccountHealth writes a claude that answers `auth status` the way the real one does —
// the JSON its `loggedIn` field carries, read from the credentials file in the CLAUDE_CONFIG_DIR it
// runs with (else the machine's own ~/.claude) — and appends that directory to the returned log,
// "<own>" for a call left on the runner's own environment. PATH is the fake's directory alone:
// checkEngine falls back to PATH, and a real claude found there would be asked about the throwaway
// directories instead of the fake.
func fakeClaudeForAccountHealth(t *testing.T) (binDir, calls string) {
	t.Helper()
	binDir = t.TempDir()
	t.Setenv("PATH", binDir)
	calls = filepath.Join(t.TempDir(), "auth-status.log")
	writeFakeBin(t, binDir, "claude", `dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
case "$1 $2" in
"--version "*) echo "2.1.283 (Claude Code)" ;;
"auth status")
	printf '%s\n' "${CLAUDE_CONFIG_DIR:-<own>}" >> '`+calls+`'
	if [ -f "$dir/.credentials.json" ]; then echo '{"loggedIn":true}'; else echo '{"loggedIn":false}'; fi ;;
*) exit 2 ;;
esac`)
	return binDir, calls
}

func signInClaudeDir(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".credentials.json"), []byte(`{"claudeAiOauth":{"accessToken":"t"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
}

func claudeSpecForTest(t *testing.T) engineSpec {
	t.Helper()
	spec, ok := specFor(providerClaude)
	if !ok {
		t.Fatal("no claude engine spec")
	}
	return spec
}

func TestClaudeEngineHealthAccountsProbeEachSlotInItsOwnConfigDir(t *testing.T) {
	home, _ := claudeAccountSlotTestHomes(t)
	signInClaudeDir(t, filepath.Join(home, ".claude"))
	work, err := claudeAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	personal, err := claudeAccountKind.create("Personal")
	if err != nil {
		t.Fatal(err)
	}
	signInClaudeDir(t, personal.Dir)
	binDir, calls := fakeClaudeForAccountHealth(t)

	reports := probeEngines([]engineSpec{claudeSpecForTest(t)}, binDir)
	raw, _ := reports[0].Accounts, 0
	if len(raw) != 3 {
		t.Fatalf("accounts = %#v, want Default, Work and Personal", raw)
	}
	byID := map[string]EngineAccountReport{}
	for _, account := range raw {
		byID[account.ID] = account
	}
	want := map[string]EngineAccountReport{
		accountSlotDefaultID: {ID: accountSlotDefaultID, Dir: filepath.Join(home, ".claude"), Auth: "yes"},
		work.ID:                 {ID: work.ID, Name: "Work", Dir: work.Dir, Auth: "no"},
		personal.ID:             {ID: personal.ID, Name: "Personal", Dir: personal.Dir, Auth: "yes"},
	}
	for id, wantAccount := range want {
		got := byID[id]
		// A Claude account has no codex-named field to carry: that name belongs to Codex, and
		// repeating it here would be a lie on the wire.
		if got.CodexHome != "" {
			t.Fatalf("claude account %s carried codexHome %q", id, got.CodexHome)
		}
		got.CodexHome = ""
		if !reflect.DeepEqual(got, wantAccount) {
			t.Fatalf("account %s = %#v, want %#v", id, got, wantAccount)
		}
	}

	// One `auth status` per added account, each in its own CLAUDE_CONFIG_DIR. Default's is the
	// engine probe's own, run in the runner's environment exactly as before accounts.
	b, err := os.ReadFile(calls)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Fields(string(b))
	sort.Strings(got)
	wantCalls := []string{"<own>", work.Dir, personal.Dir}
	sort.Strings(wantCalls)
	if !reflect.DeepEqual(got, wantCalls) {
		t.Fatalf("auth status ran in %q, want once in each of %q", got, wantCalls)
	}
}

func TestClaudeEngineHealthAccountsOneAccountIsJustDefault(t *testing.T) {
	home, orbitHome := claudeAccountSlotTestHomes(t)
	signInClaudeDir(t, filepath.Join(home, ".claude"))
	binDir, calls := fakeClaudeForAccountHealth(t)

	reports := probeEngines([]engineSpec{claudeSpecForTest(t)}, binDir)
	want := []EngineAccountReport{{ID: accountSlotDefaultID, Dir: filepath.Join(home, ".claude"), Auth: "yes"}}
	if !reflect.DeepEqual(reports[0].Accounts, want) {
		t.Fatalf("accounts = %#v, want only Default", reports[0].Accounts)
	}
	// A machine that never added an account costs the probe nothing extra, and gains no
	// claude-accounts directory from being asked.
	if b, _ := os.ReadFile(calls); strings.TrimSpace(string(b)) != "<own>" {
		t.Fatalf("auth status calls = %q, want only the engine probe's own", b)
	}
	if _, err := os.Lstat(filepath.Join(orbitHome, "claude-accounts")); !os.IsNotExist(err) {
		t.Fatalf("probing created claude-accounts (err %v)", err)
	}
}

// TestClaudeEngineHealthAccountsFollowTheSlotsNotDefault: each row speaks for its own directory, so
// a signed-out slot is visible even while Default is signed in.
func TestClaudeEngineHealthAccountsFollowTheSlotsNotDefault(t *testing.T) {
	home, _ := claudeAccountSlotTestHomes(t)
	signInClaudeDir(t, filepath.Join(home, ".claude"))
	work, err := claudeAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	binDir, _ := fakeClaudeForAccountHealth(t)

	reports := probeEngines([]engineSpec{claudeSpecForTest(t)}, binDir)
	if reports[0].Auth != "yes" {
		t.Fatalf("engine auth = %q, want Default's signed-in answer", reports[0].Auth)
	}
	want := []EngineAccountReport{
		{ID: accountSlotDefaultID, Dir: filepath.Join(home, ".claude"), Auth: "yes"},
		{ID: work.ID, Name: "Work", Dir: work.Dir, Auth: "no"},
	}
	if !reflect.DeepEqual(reports[0].Accounts, want) {
		t.Fatalf("accounts = %#v\nwant %#v", reports[0].Accounts, want)
	}
}

// TestClaudeEngineHealthDoesNotAskTheCLIAboutATokenNearExpiry: within five minutes of a token's
// expiry, or past it, `claude auth status` refreshes the token and exits without waiting for the new
// one — on wikova (2026-10-02, five-minute probes under a load of 40) that left Default and an account
// holding refresh tokens the server had already spent: Signed in on the page, 401 from every usage
// read, signed out by the next refresh. A login whose credentials file holds a refresh token is now
// signed in on the file's word, wherever its expiry stands, and the CLI is not run for it at all.
// One whose tokens the CLI emptied — what it leaves of a login whose refresh was refused — is still
// the CLI's to answer, and it answers signed out.
func TestClaudeEngineHealthDoesNotAskTheCLIAboutATokenNearExpiry(t *testing.T) {
	home, _ := claudeAccountSlotTestHomes(t)
	_, statuses := fakeClaudeTokenCLI(t, "refresh", "fresh-token")
	binDir := os.Getenv("PATH") // the fake's directory alone
	writeClaudeLogin(t, filepath.Join(home, ".claude"), "default-token", time.Now().Add(time.Minute))
	due, err := claudeAccountKind.create("Due")
	if err != nil {
		t.Fatal(err)
	}
	writeClaudeLogin(t, due.Dir, "due-token", time.Now().Add(4*time.Minute))
	expired, err := claudeAccountKind.create("Expired")
	if err != nil {
		t.Fatal(err)
	}
	writeClaudeLogin(t, expired.Dir, "expired-token", time.Now().Add(-time.Hour))
	fresh, err := claudeAccountKind.create("Fresh")
	if err != nil {
		t.Fatal(err)
	}
	writeClaudeLogin(t, fresh.Dir, "fresh-token", time.Now().Add(7*time.Hour))
	cleared, err := claudeAccountKind.create("Cleared")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cleared.Dir, ".credentials.json"),
		[]byte(`{"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":null}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	for round := 0; round < 2; round++ {
		reports := probeEngines([]engineSpec{claudeSpecForTest(t)}, binDir)
		got := map[string]string{}
		for _, account := range reports[0].Accounts {
			got[account.ID] = account.Auth
		}
		want := map[string]string{
			accountSlotDefaultID: "yes",
			due.ID:               "yes",
			expired.ID:           "yes",
			fresh.ID:             "yes",
			cleared.ID:           "no",
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("round %d: accounts = %v, want %v", round, got, want)
		}
	}
	// Two rounds, and the CLI asked about nothing but the login with no refresh token.
	if got := statuses(); !reflect.DeepEqual(got, []string{cleared.Dir, cleared.Dir}) {
		t.Fatalf("auth status ran for %q, want only the cleared login, once a round", got)
	}
}

// TestClaudeEngineHealthGivesEachAccountItsOwnBudget: the accounts the CLI is still asked about used
// to share one ten-second budget, so a slow answer — a CLI starting under a load of 40 — left the
// accounts after it none: killed mid-answer, and reported unknown.
func TestClaudeEngineHealthGivesEachAccountItsOwnBudget(t *testing.T) {
	claudeAccountSlotTestHomes(t)
	sleep, err := exec.LookPath("sleep")
	if err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	t.Setenv("PATH", bin)
	for _, name := range []string{"Work", "Personal", "Spare", "Fourth"} {
		if _, err := claudeAccountKind.create(name); err != nil {
			t.Fatal(err)
		}
	}
	previous := accountLoginStatusTimeout
	accountLoginStatusTimeout = 3 * time.Second
	t.Cleanup(func() { accountLoginStatusTimeout = previous })

	// A second each: four would not fit one shared budget of three.
	claude := writeFakeBin(t, bin, "claude", `case "$1 $2" in "auth status") '`+sleep+`' 1; echo '{"loggedIn":false}' ;; *) exit 2 ;; esac`)
	for _, account := range accountHealth(claudeAccountKind, claude, authNo) {
		if account.Auth != "no" {
			t.Fatalf("account %s (%s) = %q, want each answered in its own budget", account.ID, account.Name, account.Auth)
		}
	}
}

// The macOS Keychain item Claude Code 2.1.288 keeps a login in: one name for the CLI's own login,
// and the first eight hex digits of the config directory's SHA-256 after it for one run with
// CLAUDE_CONFIG_DIR (sha256("/Users/me/.orbit/claude-accounts/3fa91c2e") begins ff7ed2bc).
func TestClaudeKeychainServiceIsTheCLIs(t *testing.T) {
	if got := claudeKeychainService(""); got != "Claude Code-credentials" {
		t.Fatalf("own login = %q", got)
	}
	if got := claudeKeychainService("/Users/me/.orbit/claude-accounts/3fa91c2e"); got != "Claude Code-credentials-ff7ed2bc" {
		t.Fatalf("an account = %q", got)
	}
}
