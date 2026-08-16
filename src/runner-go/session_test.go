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

func TestSessionIDInUse(t *testing.T) {
	// The observed refusal: a first spawn was asked to open an id an earlier spawn had
	// already opened, so claude exits before any output. Respawning with --resume is what
	// recovers it, so this line has to be told apart from every other startup refusal.
	if !sessionIDInUse("Error: Session ID 9d9aa83d-913b-4b6e-9016-db94b21e8671 is already in use.") {
		t.Error("claude's --session-id collision should be recognized")
	}
	// Other startup refusals stay deterministic failures: respawning them burns retries.
	if sessionIDInUse("Error: --dangerously-skip-permissions cannot be used with root") {
		t.Error("an unrelated refusal should not be read as a session-id collision")
	}
	if sessionIDInUse("No conversation found with session ID 9d9aa83d-913b-4b6e-9016-db94b21e8671") {
		t.Error("a failed resume should not be read as a session-id collision")
	}
}
