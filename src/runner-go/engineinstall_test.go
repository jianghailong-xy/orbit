package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// withFakeEngine swaps the engine table for one whose binary does not exist anywhere on this
// machine (the real claude/codex/kimi may be installed on a dev box, defeating the point), and
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

// Verbatim from a session that failed on this (orbitd.io/sessions/33yiyd1Su3ZPLjIzJCuOz):
// codex was installed and spawned fine, its credentials were simply refused. It reported
// that as five reconnect attempts and a raw transport error, which the clients rendered as
// a red line about a network problem — no sign-in card, no way forward.
const realCodex401 = "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, " +
	"url: https://api.openai.com/v1/responses, cf-ray: a23848f3ab42ce09-SIN, request id: req_9d8ff0d464f441fab058c9a4fa729244"

func TestAsAuthErrorRescuesCodex401(t *testing.T) {
	got := asAuthError(realCodex401)
	if !isAuthError(got) {
		t.Fatalf("a refused credential must read as an auth failure, got %q", got)
	}
	// The original text survives: which credential was rejected is the useful part.
	if !strings.Contains(got, "Missing bearer") {
		t.Errorf("original detail was dropped: %q", got)
	}
	// Already-shaped messages (claude says it itself) must not be double-prefixed.
	claude := "Failed to authenticate: OAuth session expired and could not be refreshed"
	if got := asAuthError(claude); got != claude {
		t.Errorf("claude's own message was rewritten: %q", got)
	}
	// Narrow: ordinary failures stay ordinary, or every red line would offer a sign-in card.
	for _, ordinary := range []string{
		"stream disconnected before completion",
		"unexpected status 500 Internal Server Error",
		"HTTP error: 404 Not Found",
		"tool exited with status 401 files changed", // a number, not a rejection
	} {
		if got := asAuthError(ordinary); got != ordinary {
			t.Errorf("rewrote an unrelated error %q -> %q", ordinary, got)
		}
	}
}

func TestEngineAuthPreflightSkipsInjectedCredentials(t *testing.T) {
	// A configured provider brings its own key; the CLI's local login is irrelevant then,
	// and its "signed out" answer would fail a session that works perfectly.
	if !hasInjectedCredentials(providerCodex, map[string]string{"OPENAI_BASE_URL": "https://x/v1"}) {
		t.Error("codex: OPENAI_BASE_URL should count as injected credentials")
	}
	if !hasInjectedCredentials(providerClaude, map[string]string{"ANTHROPIC_AUTH_TOKEN": "sk-x"}) {
		t.Error("claude: ANTHROPIC_AUTH_TOKEN should count as injected credentials")
	}
	if !hasInjectedCredentials(providerKimi, map[string]string{
		"KIMI_MODEL_NAME": "kimi-for-coding", "KIMI_MODEL_API_KEY": "sk-x",
	}) {
		t.Error("kimi: a complete KIMI_MODEL_* override should count as injected credentials")
	}
	if hasInjectedCredentials(providerKimi, map[string]string{"KIMI_MODEL_API_KEY": "sk-x"}) {
		t.Error("kimi: KIMI_MODEL_API_KEY without the model-name switch is inactive")
	}
	if hasInjectedCredentials(providerKimi, map[string]string{"KIMI_API_KEY": "sk-x"}) {
		t.Error("kimi: conventional provider keys are config-file-only")
	}
	if hasInjectedCredentials(providerCodex, map[string]string{"OPENAI_API_KEY": "  "}) {
		t.Error("blank values are not credentials")
	}
	if hasInjectedCredentials(providerClaude, map[string]string{"OPENAI_API_KEY": "sk-x"}) {
		t.Error("the other engine's key says nothing about claude's login")
	}
	if hasInjectedCredentials(providerKimi, map[string]string{"ANTHROPIC_API_KEY": "sk-x"}) {
		t.Error("the other engine's key says nothing about kimi's login")
	}
	// With a key present the probe never runs, so even a signed-out machine passes.
	if msg := engineAuthPreflight(providerCodex, map[string]string{"OPENAI_API_KEY": "sk-x"}); msg != "" {
		t.Errorf("preflight must not block an API-key session: %q", msg)
	}
}

func TestEngineAuthPreflightOnASignedOutEngine(t *testing.T) {
	// The signed-out path can't be staged through PATH: engineAuthPreflight resolves the
	// binary the way the runner execs it, and serviceLoginPath puts ~/.local/bin first —
	// where a dev machine's real, signed-in codex lives. So exercise the two halves it
	// composes, and leave the resolution to lookEngine's own tests.
	fake := writeFakeBin(t, t.TempDir(), providerCodex, "exit 1") // `login status` says signed out
	if got := probeAuth(providerCodex, fake); got != authNo {
		t.Fatalf("a non-zero `codex login status` means signed out, got %v", got)
	}
	if !strings.HasPrefix(engineSignedOutMessage(providerCodex), "Failed to authenticate") {
		t.Fatal("the message that pairs with authNo must carry the card's prefix")
	}
	// And on this machine, where codex is installed and signed in, nothing is blocked.
	if msg := engineAuthPreflight(providerCodex, nil); msg != "" {
		t.Errorf("a signed-in (or unprobeable) engine must not be blocked: %q", msg)
	}
}
