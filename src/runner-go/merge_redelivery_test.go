package main

import (
	"os"
	"strings"
	"testing"
)

// The second check of 2026-11-13: a heartbeat answer drained before the first check's result was
// stored arrived after the runner had posted it, and named the same merge operation. The runner had
// forgotten it, so it ran the check again with the record the first run was handed.
func TestAnAnsweredMergeOperationIsNotRunAgain(t *testing.T) {
	answered := answeredOperations{}
	first := manualWorktreeOperationKey{kind: "merge", sessionID: "s", operationID: "op-1", leaseOwner: "owner"}
	if answered.answered(first) {
		t.Fatal("an operation nobody answered counts as answered")
	}
	answered.answer(first)
	if !answered.answered(first) {
		t.Fatal("the redelivered operation would run again")
	}
	// The session's next check is a new operation, and runs.
	next := first
	next.operationID = "op-2"
	if answered.answered(next) {
		t.Fatal("the session's next operation is refused")
	}
	answered.answer(next)
	if len(answered) != 1 || !answered.answered(next) {
		t.Fatalf("want only the latest operation per session, got %+v", answered)
	}
	other := first
	other.leaseOwner = "successor"
	if answered.answered(other) {
		t.Fatal("another process's claim of the operation counts as answered")
	}
	// A legacy command names no operation: nothing tells its redelivery apart from a new one.
	legacy := manualWorktreeOperationKey{kind: "merge", sessionID: "legacy"}
	answered.answer(legacy)
	if answered.answered(legacy) {
		t.Fatal("a legacy command without an operation id counts as answered")
	}
}

// runLoop is tested by its source in this tree: the merge loop asks before taking a command on, and
// records the operation once the control plane took its result.
func TestTheRunLoopSkipsAnsweredMergeOperations(t *testing.T) {
	src, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	for _, code := range []string{
		"busy := mergingNow[m.SessionID] || mergesAnswered.answered(answeredKey)",
		"delete(mergeOutcomes, key)\n\t\t\t\t\t\tmergesAnswered.answer(key)\n\t\t\t\t\t\tmergeMu.Unlock()\n\t\t\t\t\t}\n\t\t\t\t}(m, snapshot)",
	} {
		if !strings.Contains(body, code) {
			t.Errorf("runLoop no longer reads: %s", code)
		}
	}
}
