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

// The shape that took every session on a Mac mini down for three hours on 2026-10-05: the engine
// is present, executable and on the service PATH, and cannot be run at all (macOS killed its
// native install at exec, exit 137, no output). Both checks Orbit had answered "fine" — the binary
// is there — so the machine kept being handed sessions that could only fail, and neither the
// Install button nor the update loop would run an installer for an engine it could find.
func TestEnsureEngineRepairsAnEngineThatDoesNotRun(t *testing.T) {
	dir := t.TempDir()
	dead := filepath.Join(dir, "orbit-fake-engine")
	if err := os.WriteFile(dead, []byte("#!/bin/sh\nkill -9 $$\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	runs := filepath.Join(dir, "runs")
	bin := withFakeEngine(t, dir,
		"printf '#!/bin/sh\\nexit 0\\n' > "+dead+" && chmod +x "+dead+" && echo ran >> "+runs)
	configureEngineInstall(true, nil)
	t.Cleanup(func() { configureEngineInstall(false, nil) })

	var notes []string
	if msg := ensureEngine(context.Background(), bin, func(n string) { notes = append(notes, n) }); msg != "" {
		t.Fatalf("the install should have left a runnable engine, got %q", msg)
	}
	if len(notes) == 0 || !strings.Contains(notes[0], "Reinstalling Fake Engine") {
		t.Fatalf("the session must be told the engine is being repaired, not installed: %v", notes)
	}
	if b, _ := os.ReadFile(runs); strings.Count(string(b), "ran") != 1 {
		t.Fatalf("the installer should have run exactly once, ran %d times", strings.Count(string(b), "ran"))
	}
}

// Without install consent the session cannot be repaired, and what it is told has to be the truth
// somebody can act on: the binary is right there and does not run — the one thing "not found"
// would send them looking for.
func TestEnsureEngineNamesAnEngineThatDoesNotRunWithoutConsent(t *testing.T) {
	dir := t.TempDir()
	dead := filepath.Join(dir, "orbit-fake-engine")
	if err := os.WriteFile(dead, []byte("#!/bin/sh\nkill -9 $$\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	runs := filepath.Join(dir, "runs")
	bin := withFakeEngine(t, dir, "echo ran >> "+runs)
	configureEngineInstall(false, nil)
	t.Cleanup(func() { configureEngineInstall(false, nil) })

	msg := ensureEngine(context.Background(), bin, func(string) {})
	if !strings.Contains(msg, "does not run") || !strings.Contains(msg, dead) {
		t.Fatalf("want a message naming the binary that does not run, got %q", msg)
	}
	if strings.Contains(msg, "not found") {
		t.Fatalf("an engine that is installed must not be reported as missing: %q", msg)
	}
	if _, err := os.Stat(runs); err == nil {
		t.Fatal("a runner without consent must not run an installer")
	}
}

// The button a human presses to fix a machine, which used to answer "done" for exactly the
// machines that needed it.
func TestInstallEngineNowRepairsAnEngineThatDoesNotRun(t *testing.T) {
	dir := t.TempDir()
	dead := filepath.Join(dir, "orbit-fake-engine")
	if err := os.WriteFile(dead, []byte("#!/bin/sh\nkill -9 $$\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	runs := filepath.Join(dir, "runs")
	bin := withFakeEngine(t, dir,
		"printf '#!/bin/sh\\nexit 0\\n' > "+dead+" && chmod +x "+dead+" && echo ran >> "+runs)
	spec, ok := specFor(bin)
	if !ok {
		t.Fatal("fixture lost its engine spec")
	}

	res := installEngineNow(spec)
	if res.Status != installDone {
		t.Fatalf("repair result = %+v, want done once the engine runs again", res)
	}
	if b, _ := os.ReadFile(runs); strings.Count(string(b), "ran") != 1 {
		t.Fatal("the Install button answered done without running the installer for a binary that does not run")
	}
}

// The repair for a file whose bytes are fine and whose identity is not: on 2026-10-05 a Mac mini's
// native Claude Code could not be exec'd at all (exit 137, no output, no log) while a copy of the
// very same bytes ran perfectly — and the state came back, so the repair had to be cheap. What the
// copy has to produce is a NEW file at the same path; rewriting the one that is there would keep
// the identity that is the problem.
func TestRematerializeEngineGivesTheFileANewIdentity(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "orbit-fake-engine")
	if err := os.WriteFile(target, []byte("#!/bin/sh\necho fake-1.0\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	bin := withFakeEngine(t, dir, "true")
	before, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}

	if !rematerializeEngine(bin) {
		t.Fatal("a runnable engine, copied to a fresh file, must report the repair as done")
	}
	after, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if os.SameFile(before, after) {
		t.Fatal("the file was not replaced — a new identity is the whole repair")
	}
	if b, _ := os.ReadFile(target); !strings.Contains(string(b), "fake-1.0") {
		t.Fatalf("the bytes did not survive the copy: %q", b)
	}
	if _, err := os.Stat(target + ".orbit-renew"); err == nil {
		t.Fatal("the copy was left behind beside the install")
	}
}

// Everything this cannot copy stays the installer's job, and it has to say so rather than leave a
// half-repaired engine behind: nothing on PATH, and a path that is not a binary at all.
func TestRematerializeEngineLeavesWhatItCannotCopyAlone(t *testing.T) {
	dir := t.TempDir()
	bin := withFakeEngine(t, dir, "true")
	if rematerializeEngine(bin) {
		t.Fatal("an engine that is not on PATH is nothing to copy")
	}
	if err := os.Mkdir(filepath.Join(dir, "orbit-fake-engine"), 0o755); err != nil {
		t.Fatal(err)
	}
	if rematerializeEngine(bin) {
		t.Fatal("a directory where the binary should be is not an install to refresh")
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
	t.Setenv("KIMI_MODEL_NAME", "")
	t.Setenv("KIMI_MODEL_API_KEY", "")
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

	t.Setenv("KIMI_MODEL_NAME", "process-model")
	t.Setenv("KIMI_MODEL_API_KEY", "process-key")
	if !hasInjectedCredentials(providerKimi, nil) {
		t.Error("kimi: process KIMI_MODEL_* should count as injected credentials")
	}
	if hasInjectedCredentials(providerKimi, map[string]string{"KIMI_MODEL_API_KEY": ""}) {
		t.Error("kimi: an explicit empty Agent key should disable the process override")
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
	// An engine that can't be resolved at all is ensureEngine's business, and the probe
	// declines to block it. Asserted on a name that exists nowhere, so it holds on any
	// machine — the case below returns early exactly when this one would apply.
	if msg := engineAuthPreflight("orbit-not-an-engine", nil); msg != "" {
		t.Errorf("an unresolvable engine must not be blocked here: %q", msg)
	}
	// And the composition agrees with this machine's own probe. Asserting agreement
	// rather than a fixed verdict keeps the test honest wherever it runs: a dev box with
	// a signed-in codex and a container with an installed-but-signed-out one both hold.
	path, installed := lookEngine(providerCodex)
	if !installed {
		return // ensureEngine, not preflight, owns the missing-binary case
	}
	msg := engineAuthPreflight(providerCodex, nil)
	if probeAuth(providerCodex, path) == authNo {
		if msg == "" {
			t.Error("a signed-out engine must be blocked by preflight")
		}
	} else if msg != "" {
		t.Errorf("a signed-in (or unprobeable) engine must not be blocked: %q", msg)
	}
}
