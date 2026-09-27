package main

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
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
