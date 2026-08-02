package main

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestUpdateErrDetail(t *testing.T) {
	// Prefers the line naming the cause (EACCES) over npm's "see the log" trailer, which
	// is the actual last line — the whole point of scanning past package-manager trailers.
	npmOut := "npm error code EACCES\nnpm error syscall rename\nnpm error path /usr/lib/node_modules/@openai/codex\nnpm error A complete log of this run can be found in: /root/.npm/_logs/x-debug-0.log\n"
	if got := updateErrDetail(errors.New("exit status 243"), []byte(npmOut)); got != "npm error code EACCES" {
		t.Fatalf("want EACCES cause line, got %q", got)
	}
	// No EACCES/permission line: falls back to the last error line (still skipping the trailer).
	genOut := "warming up\nError: network unreachable\nA complete log of this run can be found in: /x.log\n"
	if got := updateErrDetail(errors.New("exit status 1"), []byte(genOut)); got != "Error: network unreachable" {
		t.Fatalf("want last error line, got %q", got)
	}
	// Falls back to the Go error when the command produced no output.
	if got := updateErrDetail(errors.New(`exec: "sh": not found`), nil); got != `exec: "sh": not found` {
		t.Fatalf("want error fallback, got %q", got)
	}
}

func TestKimiUpdatePreservesInstallSource(t *testing.T) {
	home := filepath.Join(string(filepath.Separator), "home", "alice")
	spec, ok := specFor(providerKimi)
	if !ok {
		t.Fatal("Kimi engine spec missing")
	}
	standalone := filepath.Join(home, ".local", "bin", "kimi")
	if got, ok := engineUpdateCommand(spec, standalone, home); !ok || got != spec.installCmd {
		t.Fatalf("standalone update = (%q, %v), want official installer", got, ok)
	}
	for _, managed := range []string{"/usr/local/bin/kimi", "/opt/homebrew/bin/kimi"} {
		if got, ok := engineUpdateCommand(spec, managed, home); ok || got != "" {
			t.Fatalf("package-managed %s update = (%q, %v), want skip", managed, got, ok)
		}
	}
}

func TestEngineSpecsUpdateCmd(t *testing.T) {
	specs := map[string]engineSpec{}
	for _, s := range engineSpecs {
		specs[s.bin] = s
	}
	// Claude and Codex update via their own unattended updaters. Kimi's update command
	// becomes a manual hint without a TTY, so it deliberately repeats the official
	// idempotent installer via the empty-command fallback.
	if got := specs[providerClaude].updateCmd; got != "claude update" {
		t.Fatalf("claude updateCmd = %q, want %q", got, "claude update")
	}
	if got := specs[providerCodex].updateCmd; got != "codex update" {
		t.Fatalf("codex updateCmd = %q, want %q", got, "codex update")
	}
	if got := specs[providerKimi].updateCmd; got != "" {
		t.Fatalf("kimi updateCmd = %q, want the unattended installer fallback", got)
	}
	if got := specs[providerOpenCode].updateCmd; got != "opencode upgrade" {
		t.Fatalf("opencode updateCmd = %q, want %q", got, "opencode upgrade")
	}
	// No other engine may rely on the installCmd fallback for its daily update.
	for _, s := range engineSpecs {
		if s.updateCmd == "" && s.bin != providerKimi {
			t.Errorf("%s has no updateCmd; the installCmd fallback can target a different install than PATH", s.name)
		}
	}
}
