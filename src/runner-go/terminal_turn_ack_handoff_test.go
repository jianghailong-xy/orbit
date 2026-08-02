package main

import (
	"testing"
)

func TestTerminalTurnAckHandoffDeduplicatesAndClearsExactTurn(t *testing.T) {
	var handoff terminalTurnAckHandoff
	first := TurnCompleteRequest{TurnID: "turn-1", Status: stFailed, Result: "first"}
	if !handoff.store(first, 7) {
		t.Fatal("initial terminal ack handoff was rejected")
	}
	if !handoff.store(first, 7) {
		t.Fatal("idempotent terminal ack handoff was rejected")
	}
	if handoff.store(first, 8) {
		t.Fatal("a different permit generation replaced the pending handoff")
	}
	if handoff.store(TurnCompleteRequest{TurnID: "turn-2", Status: stFailed}, 7) {
		t.Fatal("a different terminal turn replaced the pending handoff")
	}

	got, ok := handoff.load()
	if !ok || got.request.TurnID != first.TurnID || got.request.Result != first.Result || got.permitGeneration != 7 {
		t.Fatalf("pending handoff = %#v, %v; want original request", got, ok)
	}
	handoff.clear("turn-2")
	if _, ok := handoff.load(); !ok {
		t.Fatal("mismatched completion cleared the pending handoff")
	}
	handoff.clear(first.TurnID)
	if got, ok := handoff.load(); ok {
		t.Fatalf("settled handoff remained pending: %#v", got)
	}
}

func TestTerminalTurnCompleteStatusRejectsOpenStates(t *testing.T) {
	for _, status := range []string{stSucceeded, stFailed, stCancelled} {
		if !terminalTurnCompleteStatus(status) {
			t.Errorf("terminalTurnCompleteStatus(%q) = false", status)
		}
	}
	for _, status := range []string{"", stPending, stRunning, stAwaitingInput, stInterrupted} {
		if terminalTurnCompleteStatus(status) {
			t.Errorf("terminalTurnCompleteStatus(%q) = true", status)
		}
	}
}
