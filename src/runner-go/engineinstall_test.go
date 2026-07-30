package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// withFakeEngine swaps the engine table for one whose binary does not exist anywhere on this
// machine (the real claude/codex are installed on a dev box, which would defeat the point), and
// whose "installer" is a shell command the test controls. `dir` goes on PATH, so an installer
// that writes a binary there is one the runner can then find.
func withFakeEngine(t *testing.T, dir, installCmd string) (bin string) {
	t.Helper()
	bin = "orbit-fake-engine"
	saved := engineSpecs
	engineSpecs = []engineSpec{{name: "Fake Engine", bin: bin, installCmd: installCmd, installAlt: "-"}}
	t.Cleanup(func() { engineSpecs = saved })
	// Keep the real PATH: the installer runs through `sh`, which has to be findable.
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	return bin
}

func TestEnsureEngineRefusesWithoutConsent(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "ran")
	bin := withFakeEngine(t, dir, "touch "+marker)
	configureEngineInstall(false, nil)
	t.Cleanup(func() { configureEngineInstall(false, nil) })

	msg := ensureEngine(context.Background(), bin, func(string) { t.Error("nothing should be announced") })
	if !strings.Contains(msg, "not found") {
		t.Fatalf("want the missing-engine message, got %q", msg)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a runner without consent must not run an installer")
	}
}

func TestEnsureEngineInstallsOnDemand(t *testing.T) {
	dir := t.TempDir()
	target, runs := filepath.Join(dir, "orbit-fake-engine"), filepath.Join(dir, "runs")
	bin := withFakeEngine(t, dir,
		"echo ran >> "+runs+" && printf '#!/bin/sh\\nexit 0\\n' > "+target+" && chmod +x "+target)
	configureEngineInstall(true, nil)
	t.Cleanup(func() { configureEngineInstall(false, nil) })

	var notes []string
	msg := ensureEngine(context.Background(), bin, func(n string) { notes = append(notes, n) })
	if msg != "" {
		t.Fatalf("install should have succeeded, got %q", msg)
	}
	if len(notes) == 0 || !strings.Contains(notes[0], "Installing Fake Engine") {
		t.Fatalf("the session should be told an install is happening, got %v", notes)
	}
	// Already installed: the next session to need this engine must go straight through.
	if msg := ensureEngine(context.Background(), bin, func(string) { t.Error("nothing to announce") }); msg != "" {
		t.Fatalf("an installed engine should be ready, got %q", msg)
	}
	if b, _ := os.ReadFile(runs); strings.Count(string(b), "ran") != 1 {
		t.Fatalf("installer should have run exactly once, ran %d times", strings.Count(string(b), "ran"))
	}
}

func TestEnsureEngineReportsAFailedInstall(t *testing.T) {
	bin := withFakeEngine(t, t.TempDir(), "exit 3")
	configureEngineInstall(true, nil)
	t.Cleanup(func() { configureEngineInstall(false, nil) })

	msg := ensureEngine(context.Background(), bin, func(string) {})
	if !strings.Contains(msg, "installing it failed") || !strings.Contains(msg, "orbit doctor") {
		t.Fatalf("a failed install must say so and point somewhere, got %q", msg)
	}
}

func TestEnsureEngineReportsAnInstallerThatLies(t *testing.T) {
	bin := withFakeEngine(t, t.TempDir(), "exit 0") // exits clean, installs nothing
	configureEngineInstall(true, nil)
	t.Cleanup(func() { configureEngineInstall(false, nil) })

	msg := ensureEngine(context.Background(), bin, func(string) {})
	if !strings.Contains(msg, "still isn't on the service PATH") {
		t.Fatalf("want the installer-lied message, got %q", msg)
	}
}

// The web transcript only offers its sign-in card for text that reads as an auth failure
// (isAuthErrorText in @orbit/shared keys on this exact prefix), and that card is the whole
// remedy for an engine installed on a machine nobody has a terminal on.
func TestEngineSignedOutMessageTriggersTheWebCard(t *testing.T) {
	msg := engineSignedOutMessage(providerCodex)
	if !strings.HasPrefix(msg, "Failed to authenticate") {
		t.Fatalf("message must carry the prefix the web card keys on: %q", msg)
	}
	if !strings.Contains(msg, "Codex") || !strings.Contains(msg, "codex login") {
		t.Fatalf("message should name the engine and its sign-in: %q", msg)
	}
}
