package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// claudeAccountSlotTestHomes points the runner at a throwaway HOME and ORBIT_HOME, with no
// CLAUDE_CONFIG_DIR of its own.
func claudeAccountSlotTestHomes(t *testing.T) (home, orbitHome string) {
	t.Helper()
	root := t.TempDir()
	home, orbitHome = filepath.Join(root, "home"), filepath.Join(root, "orbit")
	t.Setenv("HOME", home)
	t.Setenv("ORBIT_HOME", orbitHome)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	return home, orbitHome
}

func assertClaudeAccountSlotPrivateDir(t *testing.T, dir string) {
	t.Helper()
	info, err := os.Lstat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		t.Fatalf("%s is not a real directory: %v", dir, info.Mode())
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o700 {
		t.Fatalf("%s mode = %04o, want 0700", dir, info.Mode().Perm())
	}
}

func TestClaudeAccountSlotDefaultIsTheRunnersOwnConfigDir(t *testing.T) {
	home, orbitHome := claudeAccountSlotTestHomes(t)
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, configDir, want string }{
		{"no CLAUDE_CONFIG_DIR", "", filepath.Join(home, ".claude")},
		{"CLAUDE_CONFIG_DIR set", filepath.Join(home, "elsewhere"), filepath.Join(home, "elsewhere")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CLAUDE_CONFIG_DIR", tc.configDir)
			runnerDir, err := effectiveClaudeConfigDir(os.Environ(), cwd)
			if err != nil {
				t.Fatal(err)
			}
			if runnerDir != tc.want {
				t.Fatalf("the runner's own config dir = %q, want %q", runnerDir, tc.want)
			}
			got, err := claudeAccountKind.home(accountSlotDefaultID)
			if err != nil {
				t.Fatal(err)
			}
			if got != runnerDir {
				t.Fatalf("Default slot = %q, want the runner's own config dir %q", got, runnerDir)
			}
			slots, err := claudeAccountKind.list()
			if err != nil {
				t.Fatal(err)
			}
			if len(slots) != 1 || slots[0].ID != accountSlotDefaultID || slots[0].Dir != runnerDir {
				t.Fatalf("slots = %#v, want just Default at %q", slots, runnerDir)
			}
			if _, err := os.Lstat(filepath.Join(orbitHome, "claude-accounts")); !os.IsNotExist(err) {
				t.Fatalf("listing created claude-accounts (err %v)", err)
			}
		})
	}

	// A relative CLAUDE_CONFIG_DIR resolves against this process's cwd — the CLI treats it the same
	// way, and a slot path has to be absolute for engines spawned elsewhere.
	t.Setenv("CLAUDE_CONFIG_DIR", "relative-claude")
	got, err := effectiveClaudeConfigDir(os.Environ(), cwd)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(cwd, "relative-claude"); got != want {
		t.Fatalf("relative config dir resolved to %q, want %q", got, want)
	}
}

func TestClaudeAccountSlotAddedLivesPrivatelyUnderOrbitHome(t *testing.T) {
	home, orbitHome := claudeAccountSlotTestHomes(t)
	work, err := claudeAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(orbitHome, "claude-accounts")
	if filepath.Dir(work.Dir) != root {
		t.Fatalf("added slot lives at %q, want under %q", work.Dir, root)
	}
	if work.ID == accountSlotDefaultID || len(work.ID) != 8 {
		t.Fatalf("added slot id = %q, want 4 random bytes in hex", work.ID)
	}
	assertClaudeAccountSlotPrivateDir(t, work.Dir)
	assertClaudeAccountSlotPrivateDir(t, root)

	// The record beside it carries the name the user gave, and nothing else about the account.
	meta, err := readAccountSlotMeta(root, work.ID)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Name != "Work" || meta.CreatedAt.IsZero() {
		t.Fatalf("record = %#v", meta)
	}
	if info, err := os.Lstat(accountSlotMetaPath(root, work.ID)); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("record mode: %v %v", info.Mode(), err)
	}

	slots, err := claudeAccountKind.list()
	if err != nil {
		t.Fatal(err)
	}
	if len(slots) != 2 || slots[0].ID != accountSlotDefaultID || slots[1].ID != work.ID || slots[1].Name != "Work" {
		t.Fatalf("slots = %#v, want Default then Work", slots)
	}
	if got, err := claudeAccountKind.home(work.ID); err != nil || got != work.Dir {
		t.Fatalf("home(%q) = %q (%v), want %q", work.ID, got, err, work.Dir)
	}

	// Default is this machine's own config dir: never removable, and never a slot to add to.
	if err := claudeAccountKind.remove(accountSlotDefaultID, nil); err == nil {
		t.Fatal("removed Default")
	}
	if _, err := claudeAccountKind.home("not-hex"); err == nil {
		t.Fatal("resolved an id that is not a slot")
	}
	if _, err := claudeAccountKind.home("deadbeef"); err == nil {
		t.Fatal("resolved a slot that was never added")
	}

	// A removal is idempotent — the control plane redelivers it until this runner reports — and it
	// takes the account's directory and its record with it.
	if err := claudeAccountKind.remove(work.ID, nil); err != nil {
		t.Fatal(err)
	}
	if err := claudeAccountKind.remove(work.ID, nil); err != nil {
		t.Fatalf("second removal of the same account: %v", err)
	}
	if _, err := os.Lstat(work.Dir); !os.IsNotExist(err) {
		t.Fatalf("the directory outlived its removal (err %v)", err)
	}
	if _, err := os.Lstat(accountSlotMetaPath(root, work.ID)); !os.IsNotExist(err) {
		t.Fatalf("the record outlived its removal (err %v)", err)
	}
	// And the home the runner's own environment selects is not where a slot lives.
	def, err := claudeAccountKind.home(accountSlotDefaultID)
	if err != nil {
		t.Fatal(err)
	}
	if def != filepath.Join(home, ".claude") {
		t.Fatalf("Default = %q", def)
	}
}

// TestClaudeAccountSlotALiveSessionIsRefused: a slot whose directory a running session is in is not
// removable — the session's thread lives there — and the refusal names the account.
func TestClaudeAccountSlotALiveSessionIsRefused(t *testing.T) {
	claudeAccountSlotTestHomes(t)
	work, err := claudeAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	if err := claudeAccountKind.remove(work.ID, map[string]bool{work.Dir: true}); err == nil {
		t.Fatal("removed a slot a live session is in")
	}
	if _, err := os.Lstat(work.Dir); err != nil {
		t.Fatalf("the refused slot is gone: %v", err)
	}
}

// TestClaudeSessionAccountDirResolvesTheSessionsOwnDirectory: the directory a session's CLI runs
// with — the one dispatch named, else the runner's own — which is what decides where its
// transcripts are read from and which login the spawn preflight asks about.
func TestClaudeSessionAccountDirResolvesTheSessionsOwnDirectory(t *testing.T) {
	home, _ := claudeAccountSlotTestHomes(t)
	work, err := claudeAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	def := filepath.Join(home, ".claude")
	for _, tc := range []struct {
		name  string
		agent map[string]string
		want  string
	}{
		{"the account dispatch named", map[string]string{"CLAUDE_CONFIG_DIR": work.Dir}, work.Dir},
		{"the machine's own login", map[string]string{"CLAUDE_CONFIG_DIR": def}, def},
		{"no choice at all", nil, def},
		{"a directory no slot is", map[string]string{"CLAUDE_CONFIG_DIR": filepath.Join(home, "elsewhere")}, filepath.Join(home, "elsewhere")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := claudeSessionAccountDir(tc.agent, "/tmp")
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Fatalf("config dir = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestClaudeSessionAccountDirsReadTheSessionsRecord: the directories a removal refuses to delete,
// read from each running session's own record rather than from a claim that may have moved on.
func TestClaudeSessionAccountDirsReadTheSessionsRecord(t *testing.T) {
	_, _ = claudeAccountSlotTestHomes(t)
	work, err := claudeAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	// A session's record lives in runDir(session), which this throwaway ORBIT_HOME owns.
	writeSessionRecordForTest(t, runDir("s-with"), sessionMeta{Provider: providerClaude, ClaudeConfigDir: work.Dir})
	writeSessionRecordForTest(t, runDir("s-without"), sessionMeta{Provider: providerClaude})

	dirs := claudeSessionAccountDirs([]string{"s-with", "s-without"})
	want := map[string]bool{filepath.Clean(work.Dir): true}
	if len(dirs) != len(want) || !dirs[filepath.Clean(work.Dir)] {
		t.Fatalf("live dirs = %#v, want %#v", dirs, want)
	}
}

// writeSessionRecordForTest writes a session's meta.json the way the runner does.
func writeSessionRecordForTest(t *testing.T, dir string, meta sessionMeta) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(meta)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), b, 0o644); err != nil {
		t.Fatal(err)
	}
}
