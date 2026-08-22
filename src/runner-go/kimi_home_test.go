package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// fakeKimiHome builds a real home holding a representative subset of the borrowed
// entries. Everything else in kimiHomeOverlayEntries is deliberately absent: Kimi
// gains and drops entries between versions, and a missing one must not fail a session.
func fakeKimiHome(t *testing.T) (string, []string) {
	t.Helper()
	home := t.TempDir()
	dirs := []string{"credentials", "sessions", "logs"}
	files := []string{"config.toml", "device_id", "session_index.jsonl"}
	for _, name := range dirs {
		if err := os.Mkdir(filepath.Join(home, name), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(home, name, "kept.json"), []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range files {
		if err := os.WriteFile(filepath.Join(home, name), []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return home, append(dirs, files...)
}

func TestPrepareKimiHomeOverlayLinksPresentEntriesAndSkipsMissing(t *testing.T) {
	home, present := fakeKimiHome(t)
	scratch := t.TempDir()

	overlay, err := prepareKimiHomeOverlay(scratch, home)
	if err != nil {
		t.Fatalf("prepareKimiHomeOverlay: %v", err)
	}

	info, err := os.Lstat(overlay)
	if err != nil {
		t.Fatal(err)
	}
	if !info.IsDir() {
		t.Fatalf("overlay %s is not a directory", overlay)
	}
	if got := info.Mode().Perm(); got != machineHomePerm {
		t.Fatalf("overlay mode = %04o, want %04o", got, machineHomePerm)
	}

	presence := map[string]bool{}
	for _, name := range present {
		presence[name] = true
	}
	for _, name := range kimiHomeOverlayEntries {
		path := filepath.Join(overlay, name)
		entry, err := os.Lstat(path)
		if !presence[name] {
			if err == nil {
				t.Fatalf("%s is absent from the real home but present in the overlay", name)
			}
			if !os.IsNotExist(err) {
				t.Fatalf("lstat %s: %v", path, err)
			}
			continue
		}
		if err != nil {
			t.Fatalf("lstat %s: %v", path, err)
		}
		if entry.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("%s is not a symlink (mode %v); the overlay must borrow, not copy", name, entry.Mode())
		}
		target, err := os.Readlink(path)
		if err != nil {
			t.Fatal(err)
		}
		if want := filepath.Join(home, name); target != want {
			t.Fatalf("%s links to %q, want %q", name, target, want)
		}
	}
}

func TestPrepareKimiHomeOverlayReplacesAPreviousRun(t *testing.T) {
	home, _ := fakeKimiHome(t)
	scratch := t.TempDir()

	first, err := prepareKimiHomeOverlay(scratch, home)
	if err != nil {
		t.Fatalf("prepareKimiHomeOverlay: %v", err)
	}
	// A resume finds the previous run's links still in place.
	second, err := prepareKimiHomeOverlay(scratch, home)
	if err != nil {
		t.Fatalf("prepareKimiHomeOverlay on resume: %v", err)
	}
	if first != second {
		t.Fatalf("overlay moved between runs: %q then %q", first, second)
	}
	if _, err := os.Readlink(filepath.Join(second, "credentials")); err != nil {
		t.Fatalf("credentials link after resume: %v", err)
	}
}

func TestRemoveKimiHomeOverlayLeavesTheRealHomeIntact(t *testing.T) {
	home, present := fakeKimiHome(t)
	scratch := t.TempDir()

	overlay, err := prepareKimiHomeOverlay(scratch, home)
	if err != nil {
		t.Fatalf("prepareKimiHomeOverlay: %v", err)
	}
	// What the engine itself may leave behind in its home: a plain file and a real
	// directory, neither of which is a link out of the overlay.
	if err := os.WriteFile(filepath.Join(overlay, "mcp.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(overlay, "runtime", "nested"), 0o700); err != nil {
		t.Fatal(err)
	}

	if err := removeKimiHomeOverlay(overlay); err != nil {
		t.Fatalf("removeKimiHomeOverlay: %v", err)
	}
	if _, err := os.Lstat(overlay); !os.IsNotExist(err) {
		t.Fatalf("overlay still present: %v", err)
	}
	for _, name := range present {
		if _, err := os.Lstat(filepath.Join(home, name)); err != nil {
			t.Fatalf("cleanup followed a link into the real home: %s is gone (%v)", name, err)
		}
	}
	// The contents behind the linked directories, not just the directories.
	if _, err := os.Lstat(filepath.Join(home, "credentials", "kept.json")); err != nil {
		t.Fatalf("cleanup deleted credentials through the link: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(home, "sessions", "kept.json")); err != nil {
		t.Fatalf("cleanup deleted session history through the link: %v", err)
	}

	// Cleaning up twice, or a session that never built an overlay, is not an error.
	if err := removeKimiHomeOverlay(overlay); err != nil {
		t.Fatalf("removeKimiHomeOverlay on a missing overlay: %v", err)
	}
	if err := removeKimiHomeOverlay(""); err != nil {
		t.Fatalf("removeKimiHomeOverlay(\"\"): %v", err)
	}
}

func TestRemoveKimiHomeOverlayDoesNotDescendThroughALink(t *testing.T) {
	home, _ := fakeKimiHome(t)
	scratch := t.TempDir()
	link := filepath.Join(scratch, "kimi-home")
	// The overlay path itself is a link to the real home: unlink it, never walk it.
	if err := os.Symlink(home, link); err != nil {
		t.Fatal(err)
	}

	if err := removeKimiHomeOverlay(link); err != nil {
		t.Fatalf("removeKimiHomeOverlay: %v", err)
	}
	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Fatalf("link still present: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(home, "credentials", "kept.json")); err != nil {
		t.Fatalf("cleanup emptied the real home through the link: %v", err)
	}
}

func TestEffectiveKimiHomeResolvesFromTheInjectedEnvironment(t *testing.T) {
	cwd := t.TempDir()
	home := t.TempDir()

	got, err := effectiveKimiHome([]string{"HOME=" + home}, cwd)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(home, ".kimi-code"); got != want {
		t.Fatalf("effectiveKimiHome(HOME) = %q, want %q", got, want)
	}

	// An explicit override wins, and a relative one resolves against the session cwd
	// rather than the runner's, since the overlay's links have to be absolute.
	got, err = effectiveKimiHome([]string{"HOME=" + home, "KIMI_CODE_HOME=shared/kimi"}, cwd)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(cwd, "shared", "kimi"); got != want {
		t.Fatalf("effectiveKimiHome(KIMI_CODE_HOME) = %q, want %q", got, want)
	}
}

func TestKimiACPSubprocessRunsAgainstTheOverlayHome(t *testing.T) {
	root := t.TempDir()
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	capture := filepath.Join(root, "captured-home")
	writeFakeBin(t, binDir, providerKimi, "printf '%s' \"$KIMI_CODE_HOME\" > \"$ORBIT_TEST_CAPTURE_FILE\"")
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	home, _ := fakeKimiHome(t)
	overlay, err := prepareKimiHomeOverlay(t.TempDir(), home)
	if err != nil {
		t.Fatal(err)
	}
	job := &ClaimedSession{
		SessionID: "kimi-session",
		Agent: AgentExecConfig{Env: map[string]string{
			"ORBIT_TEST_CAPTURE_FILE": capture,
			// Agent configuration must not decide where the engine's home is.
			"KIMI_CODE_HOME": filepath.Join(root, "agent-controlled"),
		}},
	}

	app, err := startKimiACP(context.Background(), NewTransport("http://127.0.0.1:1", "runner-token"), job, root, overlay, func(string, map[string]interface{}) {})
	if err != nil {
		t.Fatalf("startKimiACP: %v", err)
	}
	defer app.close()

	deadline := time.Now().Add(5 * time.Second)
	for {
		got, err := os.ReadFile(capture)
		if err == nil {
			if string(got) != overlay {
				t.Fatalf("kimi acp ran with KIMI_CODE_HOME=%q, want the overlay %q", got, overlay)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("kimi acp never reported its home: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
