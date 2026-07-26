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
	// Claude updates via its own updater; codex has none, so it falls back to the
	// idempotent installer (installCmd).
	if got := specs[providerClaude].updateCmd; got != "claude update" {
		t.Fatalf("claude updateCmd = %q, want %q", got, "claude update")
	}
	if got := specs[providerCodex].updateCmd; got != "" {
		t.Fatalf("codex updateCmd = %q, want empty (falls back to installCmd)", got)
	}
}
