package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func appendKimiWire(t *testing.T, wire string, records ...map[string]interface{}) {
	t.Helper()
	f, err := os.OpenFile(wire, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for _, rec := range records {
		raw, _ := json.Marshal(rec)
		if _, err := f.Write(append(raw, '\n')); err != nil {
			t.Fatal(err)
		}
	}
}

func kimiWirePrompt(text string) map[string]interface{} {
	return map[string]interface{}{"type": "turn.prompt", "agentId": "main", "turnId": 1,
		"input": []map[string]interface{}{{"type": "text", "text": text}}}
}

// TestKimiInstructionsRideTheFirstPromptAndTheFirstAfterAReset reads the ledger the way a session's prompts do: the
// conversation's first prompt carries the instructions, later ones do not, a compaction of the main agent brings them
// back, a sub-agent's does not, and a resumed conversation is judged by its own history.
func TestKimiInstructionsRideTheFirstPromptAndTheFirstAfterAReset(t *testing.T) {
	wire := filepath.Join(t.TempDir(), "wire.jsonl")
	l := &kimiInstructionLedger{wire: wire}
	if !l.due() {
		t.Fatal("a conversation with no wire yet is owed its instructions")
	}
	appendKimiWire(t, wire, kimiWirePrompt(kimiInstructionsOpen+"Orbit tasks are the user's durable record.\n</orbit-agent-instructions>\n\nhi"))
	if l.due() {
		t.Fatal("a conversation whose first prompt carried the instructions still holds them")
	}
	appendKimiWire(t, wire, kimiWirePrompt("second"), map[string]interface{}{"type": "context.apply_compaction", "agentId": "sub-1", "summary": "x"})
	if l.due() {
		t.Fatal("a sub-agent's compaction does not take the main agent's instructions away")
	}
	appendKimiWire(t, wire, map[string]interface{}{"type": "context.apply_compaction", "agentId": "main", "summary": "x"})
	if !l.due() {
		t.Fatal("after a compaction the next prompt carries the instructions again")
	}
	appendKimiWire(t, wire, kimiWirePrompt(kimiInstructionsOpen+"Orbit tasks are the user's durable record.\n</orbit-agent-instructions>\n\nthird"))
	if l.due() {
		t.Fatal("the prompt after the compaction carried them")
	}
	if resumed := (&kimiInstructionLedger{wire: wire}); resumed.due() {
		t.Fatal("a resumed conversation whose history holds them is not sent them again")
	}
	appendKimiWire(t, wire, map[string]interface{}{"type": "context.apply_compaction", "agentId": "main", "summary": "x"})
	if resumed := (&kimiInstructionLedger{wire: wire}); !resumed.due() {
		t.Fatal("a resumed conversation compacted since its last instructions is sent them again")
	}
	if err := os.WriteFile(wire, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if !l.due() {
		t.Fatal("a wire that was emptied is read again from its start")
	}
	if !(*kimiInstructionLedger)(nil).due() {
		t.Fatal("no ledger: every prompt carries them")
	}
}
