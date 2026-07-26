package main

import (
	"errors"
	"testing"
)

func TestUpdateErrDetail(t *testing.T) {
	// Prefers the CLI's last output line (the actionable one) over the Go error.
	if got := updateErrDetail(errors.New("exit status 1"), []byte("npm WARN foo\nnpm ERR! code EACCES\n")); got != "npm ERR! code EACCES" {
		t.Fatalf("want last output line, got %q", got)
	}
	// Falls back to the error when the command produced no output.
	if got := updateErrDetail(errors.New(`exec: "sh": not found`), nil); got != `exec: "sh": not found` {
		t.Fatalf("want error fallback, got %q", got)
	}
}

func TestEngineSpecsUpdateCmd(t *testing.T) {
	specs := map[string]engineSpec{}
	for _, s := range engineSpecs {
		specs[s.bin] = s
	}
	// Both engines update via their own updater, which acts on whichever install PATH
	// resolves. Neither may fall back to installCmd: `npm i -g @openai/codex` targets
	// `npm prefix -g` regardless of PATH, so it silently upgraded a copy the runner never
	// execs on the root runner, and died with EACCES on the non-root one.
	if got := specs[providerClaude].updateCmd; got != "claude update" {
		t.Fatalf("claude updateCmd = %q, want %q", got, "claude update")
	}
	if got := specs[providerCodex].updateCmd; got != "codex update" {
		t.Fatalf("codex updateCmd = %q, want %q", got, "codex update")
	}
	// No engine may rely on the installCmd fallback for its daily update.
	for _, s := range engineSpecs {
		if s.updateCmd == "" {
			t.Errorf("%s has no updateCmd; the installCmd fallback can target a different install than PATH", s.name)
		}
	}
}
