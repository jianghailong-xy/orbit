package main

import "testing"

func TestStartupRefusal(t *testing.T) {
	// The observed case: claude refuses --dangerously-skip-permissions under root,
	// printing the refusal to stderr and exiting 1 before any stream-json message.
	if !startupRefusal(1, false) {
		t.Error("clean exit with no output should be a startup refusal")
	}
	// A clean zero exit with no output is also a refusal: the CLI got past nothing.
	if !startupRefusal(0, false) {
		t.Error("clean zero exit with no output should be a startup refusal")
	}
	// Signal-killed (Go's ProcessState.ExitCode contract is -1) is a real crash —
	// retryable, even before any output.
	if startupRefusal(-1, false) {
		t.Error("a signal-killed process should not be a startup refusal")
	}
	// Any stream-json message proves the CLI started; whatever killed it later is a
	// crash worth respawning, not a deterministic refusal.
	if startupRefusal(1, true) {
		t.Error("an exit after output should not be a startup refusal")
	}
	if startupRefusal(-1, true) {
		t.Error("a signal-killed process after output should not be a startup refusal")
	}
}
