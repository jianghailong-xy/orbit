package main

import (
	"errors"
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
