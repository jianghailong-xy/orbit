package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// codexAccountSlotTestHomes points the runner at a throwaway HOME and ORBIT_HOME, with no
// CODEX_HOME of its own.
func codexAccountSlotTestHomes(t *testing.T) (home, orbitHome string) {
	t.Helper()
	root := t.TempDir()
	home, orbitHome = filepath.Join(root, "home"), filepath.Join(root, "orbit")
	t.Setenv("HOME", home)
	t.Setenv("ORBIT_HOME", orbitHome)
	t.Setenv("CODEX_HOME", "")
	return home, orbitHome
}

func assertCodexAccountSlotPrivateDir(t *testing.T, dir string) {
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

func TestCodexAccountSlotDefaultIsTheRunnersOwnCodexHome(t *testing.T) {
	home, orbitHome := codexAccountSlotTestHomes(t)
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, codexHome, want string }{
		{"no CODEX_HOME", "", filepath.Join(home, ".codex")},
		{"CODEX_HOME set", filepath.Join(home, "elsewhere"), filepath.Join(home, "elsewhere")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CODEX_HOME", tc.codexHome)
			runnerHome, err := effectiveCodexHome(os.Environ(), cwd)
			if err != nil {
				t.Fatal(err)
			}
			if runnerHome != tc.want {
				t.Fatalf("the runner's own CODEX_HOME = %q, want %q", runnerHome, tc.want)
			}
			got, err := codexAccountSlotHome(codexAccountDefaultSlot)
			if err != nil {
				t.Fatal(err)
			}
			if got != runnerHome {
				t.Fatalf("Default slot = %q, want the runner's own CODEX_HOME %q", got, runnerHome)
			}
			slots, err := listCodexAccountSlots()
			if err != nil {
				t.Fatal(err)
			}
			if len(slots) != 1 || slots[0].ID != codexAccountDefaultSlot || slots[0].CodexHome != runnerHome {
				t.Fatalf("slots = %#v, want only Default at %q", slots, runnerHome)
			}
		})
	}
	// Resolving and listing only read: Default's directory is not created, and a machine that
	// added no account gets no codex-accounts directory.
	for _, p := range []string{filepath.Join(home, ".codex"), filepath.Join(home, "elsewhere"), filepath.Join(orbitHome, "codex-accounts")} {
		if _, err := os.Lstat(p); !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("%s exists after resolving Default (err %v)", p, err)
		}
	}
}

func TestCodexAccountSlotAddedLivesPrivatelyUnderOrbitHome(t *testing.T) {
	home, orbitHome := codexAccountSlotTestHomes(t)
	// Default is signed in; nothing about adding an account may touch its login.
	defaultHome := filepath.Join(home, ".codex")
	if err := os.MkdirAll(defaultHome, 0o700); err != nil {
		t.Fatal(err)
	}
	auth := filepath.Join(defaultHome, "auth.json")
	authBody := []byte(`{"sentinel":"default login"}`)
	if err := os.WriteFile(auth, authBody, 0o600); err != nil {
		t.Fatal(err)
	}
	authBefore, err := os.Stat(auth)
	if err != nil {
		t.Fatal(err)
	}
	// An existing codex-accounts directory left too open is tightened, as ensurePrivateCodexDir does.
	root := filepath.Join(orbitHome, "codex-accounts")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0o755); err != nil {
		t.Fatal(err)
	}

	work, err := createCodexAccountSlot("  Work  ")
	if err != nil {
		t.Fatal(err)
	}
	if work.CodexHome != filepath.Join(root, work.ID) {
		t.Fatalf("added slot at %q, want %q", work.CodexHome, filepath.Join(root, work.ID))
	}
	if !codexAccountSlotIDPattern.MatchString(work.ID) || work.ID == codexAccountDefaultSlot {
		t.Fatalf("slot id %q is not a short lowercase-hex id", work.ID)
	}
	if work.Name != "Work" || work.CreatedAt.IsZero() {
		t.Fatalf("slot = %#v, want name \"Work\" and a creation time", work)
	}
	assertCodexAccountSlotPrivateDir(t, root)
	assertCodexAccountSlotPrivateDir(t, work.CodexHome)
	// The slot is the account's CODEX_HOME and starts empty; its record sits beside it, private.
	if entries, err := os.ReadDir(work.CodexHome); err != nil || len(entries) != 0 {
		t.Fatalf("new slot holds %v (err %v), want nothing", entries, err)
	}
	metaInfo, err := os.Lstat(filepath.Join(root, work.ID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	if !metaInfo.Mode().IsRegular() || (runtime.GOOS != "windows" && metaInfo.Mode().Perm() != 0o600) {
		t.Fatalf("slot record mode = %v, want a regular 0600 file", metaInfo.Mode())
	}
	if got, err := codexAccountSlotHome(work.ID); err != nil || got != work.CodexHome {
		t.Fatalf("resolving %q = %q (err %v), want %q", work.ID, got, err, work.CodexHome)
	}

	// The same name again is a second account, not the first one found again.
	second, err := createCodexAccountSlot("Work")
	if err != nil {
		t.Fatal(err)
	}
	if second.ID == work.ID || second.CodexHome == work.CodexHome {
		t.Fatalf("second slot %#v reused the first %#v", second, work)
	}
	assertCodexAccountSlotPrivateDir(t, second.CodexHome)

	// Slots list in the order they were added, not the order their random ids sort in: whichever
	// of the two has the larger id is made the older one.
	older, newer := work, second
	if older.ID < newer.ID {
		older, newer = newer, older
		older.CreatedAt = newer.CreatedAt.Add(-time.Minute)
		meta, err := json.Marshal(codexAccountSlotMeta{Name: older.Name, CreatedAt: older.CreatedAt})
		if err != nil {
			t.Fatal(err)
		}
		if err := writeFileAtomically(filepath.Join(root, older.ID+".json"), meta, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	slots, err := listCodexAccountSlots()
	if err != nil {
		t.Fatal(err)
	}
	want := []codexAccountSlot{{ID: codexAccountDefaultSlot, CodexHome: defaultHome}, older, newer}
	if len(slots) != len(want) {
		t.Fatalf("slots = %#v, want %#v", slots, want)
	}
	for i := range want {
		got := slots[i]
		if got.ID != want[i].ID || got.Name != want[i].Name || got.CodexHome != want[i].CodexHome || !got.CreatedAt.Equal(want[i].CreatedAt) {
			t.Fatalf("slot %d = %#v, want %#v", i, got, want[i])
		}
	}

	// Default's login is exactly as it was: same bytes, same mtime, nothing added beside it.
	if b, err := os.ReadFile(auth); err != nil || !bytes.Equal(b, authBody) {
		t.Fatalf("Default's auth.json = %q (err %v), want it untouched", b, err)
	}
	authAfter, err := os.Stat(auth)
	if err != nil {
		t.Fatal(err)
	}
	if !authAfter.ModTime().Equal(authBefore.ModTime()) {
		t.Fatalf("Default's auth.json mtime moved from %v to %v", authBefore.ModTime(), authAfter.ModTime())
	}
	if entries, err := os.ReadDir(defaultHome); err != nil || len(entries) != 1 {
		t.Fatalf("Default's CODEX_HOME holds %v (err %v), want only auth.json", entries, err)
	}
}

func TestCodexAccountSlotRefusesLinksAndStrayEntries(t *testing.T) {
	home, orbitHome := codexAccountSlotTestHomes(t)
	root := filepath.Join(orbitHome, "codex-accounts")
	work, err := createCodexAccountSlot("Work")
	if err != nil {
		t.Fatal(err)
	}
	// A link named like a slot is not a slot, nor is a file, nor a directory no slot can be named.
	linked := "0123abcd"
	if err := os.Symlink(t.TempDir(), filepath.Join(root, linked)); err != nil {
		t.Fatal(err)
	}
	file := "89abcdef"
	if err := os.WriteFile(filepath.Join(root, file), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"default", "ABCDEF01"} {
		if err := os.Mkdir(filepath.Join(root, name), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	slots, err := listCodexAccountSlots()
	if err != nil {
		t.Fatal(err)
	}
	if len(slots) != 2 || slots[0].ID != codexAccountDefaultSlot || slots[1].ID != work.ID {
		t.Fatalf("slots = %#v, want Default and %q only", slots, work.ID)
	}
	if slots[0].CodexHome != filepath.Join(home, ".codex") {
		t.Fatalf("Default resolved to %q: a directory named default under codex-accounts is not it", slots[0].CodexHome)
	}
	for _, id := range []string{linked, file, "", "Default", "ABCDEF01", "../" + work.ID, work.ID + "/..", "abc"} {
		if got, err := codexAccountSlotHome(id); err == nil {
			t.Fatalf("slot %q resolved to %q, want refused", id, got)
		}
	}
	if _, err := codexAccountSlotHome("fedcba98"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("an unknown slot resolved with %v, want fs.ErrNotExist", err)
	}

	// A slot whose record is lost is still the account: it lists, unnamed.
	if err := os.Remove(filepath.Join(root, work.ID+".json")); err != nil {
		t.Fatal(err)
	}
	slots, err = listCodexAccountSlots()
	if err != nil {
		t.Fatal(err)
	}
	if len(slots) != 2 || slots[1].ID != work.ID || slots[1].Name != "" || slots[1].CodexHome != work.CodexHome {
		t.Fatalf("slots = %#v, want %q listed unnamed", slots, work.ID)
	}

	// A codex-accounts that is a link is refused whole — no slot is added, listed or resolved
	// through it — while Default, which never lives there, still resolves.
	moved := filepath.Join(orbitHome, "moved")
	if err := os.Rename(root, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(moved, root); err != nil {
		t.Fatal(err)
	}
	if slot, err := createCodexAccountSlot("Other"); err == nil {
		t.Fatalf("added %#v through a linked codex-accounts", slot)
	}
	if slots, err := listCodexAccountSlots(); err == nil {
		t.Fatalf("listed %#v through a linked codex-accounts", slots)
	}
	if got, err := codexAccountSlotHome(work.ID); err == nil {
		t.Fatalf("resolved %q to %q through a linked codex-accounts", work.ID, got)
	}
	if got, err := codexAccountSlotHome(codexAccountDefaultSlot); err != nil || got != filepath.Join(home, ".codex") {
		t.Fatalf("Default = %q (err %v), want %q", got, err, filepath.Join(home, ".codex"))
	}
}

func TestCodexAccountSlotNeedsAName(t *testing.T) {
	_, orbitHome := codexAccountSlotTestHomes(t)
	for _, name := range []string{"", " \t\n"} {
		if slot, err := createCodexAccountSlot(name); err == nil {
			t.Fatalf("added %#v with name %q", slot, name)
		}
	}
	if _, err := os.Lstat(filepath.Join(orbitHome, "codex-accounts")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("a refused add left codex-accounts behind (err %v)", err)
	}
}
