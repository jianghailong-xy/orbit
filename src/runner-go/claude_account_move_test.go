package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A Claude session moved to another of this machine's accounts finds its conversation there before its
// `--resume`: the transcript and the directory beside it are copied from the account that last wrote
// it — whole, where a rebuild from the event log would shorten a long one — and the account it came
// from keeps its copy. A conversation no other account holds is left to the rebuild.
func TestClaudeConversationFollowsASessionToAnotherAccount(t *testing.T) {
	home, _ := claudeAccountSlotTestHomes(t)
	work, err := claudeAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	personal, err := claudeAccountKind.create("Personal")
	if err != nil {
		t.Fatal(err)
	}
	execDir := t.TempDir()
	const id = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
	conversation := func(said string) []byte {
		return []byte(`{"type":"user","message":{"role":"user","content":"hello"}}` + "\n" +
			`{"type":"assistant","message":{"role":"assistant","content":"` + said + `"}}` + "\n")
	}
	put := func(path string, data []byte, at time.Time) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, at, at); err != nil {
			t.Fatal(err)
		}
	}
	// Default ran it first; Work ran it last, and has a sub-agent's transcript and a tool result beside it.
	fromDefault, _ := claudeTranscriptPathIn(filepath.Join(home, ".claude"), execDir, id)
	fromWork, _ := claudeTranscriptPathIn(work.Dir, execDir, id)
	put(fromDefault, conversation("from Default"), time.Now().Add(-2*time.Hour))
	put(fromWork, conversation("from Work"), time.Now().Add(-time.Minute))
	side := strings.TrimSuffix(fromWork, ".jsonl")
	put(filepath.Join(side, "subagents", "agent-1.jsonl"), []byte(`{"type":"user"}`+"\n"), time.Now())
	put(filepath.Join(side, "tool-results", "toolu_1.txt"), []byte("large output"), time.Now())

	job := &ClaimedSession{SessionID: id, SessionUUID: id, Provider: providerClaude,
		Agent: AgentExecConfig{Provider: providerClaude, Env: map[string]string{"CLAUDE_CONFIG_DIR": personal.Dir}}}
	// No transport: carrying it needs no event log, and a rebuild would have asked for one.
	if !ensureClaudeTranscript(context.Background(), nil, job, execDir, func(string, map[string]interface{}) {}) {
		t.Fatal("the moved session was told there is nothing to resume")
	}
	dst, _ := claudeTranscriptPathIn(personal.Dir, execDir, id)
	if got, err := os.ReadFile(dst); err != nil || string(got) != string(conversation("from Work")) {
		t.Fatalf("the conversation in the account it moved to: %q, %v", got, err)
	}
	for _, rel := range []string{filepath.Join("subagents", "agent-1.jsonl"), filepath.Join("tool-results", "toolu_1.txt")} {
		if _, err := os.Stat(filepath.Join(strings.TrimSuffix(dst, ".jsonl"), rel)); err != nil {
			t.Fatalf("%s did not come along: %v", rel, err)
		}
	}
	if _, err := os.Stat(fromWork); err != nil {
		t.Fatalf("the account it came from lost its copy: %v", err)
	}
	// Nobody holds this one: nothing is carried, and the caller rebuilds.
	other, _ := claudeTranscriptPathIn(personal.Dir, execDir, "8b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e")
	if carryClaudeConversation(personal.Dir, execDir, "8b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e", other) {
		t.Fatal("a conversation no account holds was carried")
	}
}
