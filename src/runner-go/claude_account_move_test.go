package main

import (
	"context"
	"encoding/json"
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

// claudeTurns is turns as the CLI writes them into a transcript: one record each, stamped a minute
// apart from at, then the bookkeeping it writes without a stamp.
func claudeTurns(t *testing.T, at time.Time, turns ...string) []byte {
	t.Helper()
	var b strings.Builder
	for i, text := range turns {
		role := "user"
		if i%2 == 1 {
			role = "assistant"
		}
		line, err := json.Marshal(map[string]interface{}{
			"type": role, "timestamp": at.Add(time.Duration(i) * time.Minute).UTC().Format(time.RFC3339Nano),
			"message": map[string]interface{}{"role": role, "content": text},
		})
		if err != nil {
			t.Fatal(err)
		}
		b.Write(line)
		b.WriteByte('\n')
	}
	b.WriteString(`{"type":"last-prompt","lastPrompt":"` + turns[0] + `"}` + "\n")
	return []byte(b.String())
}

// Switched to another account and back, a session resumes what it said on both. Back on the account it
// ran on first, it finds the copy it left there, and the turns it had on the other account since are
// carried over that copy — the transcript and the directory beside it — where the copy used to be
// resumed as it was and those turns were gone, without the session knowing (2026-10-03: Default to
// 29e631a9 and back).
func TestClaudeConversationMovedBackToAnAccountKeepsTheTurnsItHadOnTheOther(t *testing.T) {
	home, _ := claudeAccountSlotTestHomes(t)
	work, err := claudeAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	execDir := t.TempDir()
	const id = "06e3d13c-f25f-4764-afe6-b046f4aa315c"
	job := &ClaimedSession{SessionID: id, SessionUUID: id, Provider: providerClaude, Agent: AgentExecConfig{Provider: providerClaude}}
	resumeOn := func(configDir string) string {
		t.Helper()
		job.Agent.Env = map[string]string{"CLAUDE_CONFIG_DIR": configDir}
		if !ensureClaudeTranscript(context.Background(), eventLogNobodyReads(t), job, execDir, noEmit) {
			t.Fatal("the session was told there is nothing to resume")
		}
		path, _ := claudeTranscriptPathIn(configDir, execDir, id)
		return path
	}

	defaultDir := filepath.Join(home, ".claude")
	onDefault, _ := claudeTranscriptPathIn(defaultDir, execDir, id)
	start := time.Now().Add(-10 * time.Hour)
	putFile(t, onDefault, claudeTurns(t, start, "rename the widget", "renamed it", "and the gadget", "gadget renamed"), start.Add(4*time.Minute))
	leftOnDefault := readFile(t, onDefault)

	// On Work, the conversation follows, and goes on there.
	onWork := resumeOn(work.Dir)
	if got := readFile(t, onWork); got != leftOnDefault {
		t.Fatalf("the conversation carried to Work:\n%s", got)
	}
	later := start.Add(5 * time.Hour)
	continued := leftOnDefault + string(claudeTurns(t, later, "now the sprocket", "sprocket renamed on Work"))
	putFile(t, onWork, []byte(continued), later.Add(2*time.Minute))
	putFile(t, filepath.Join(strings.TrimSuffix(onWork, ".jsonl"), "tool-results", "toolu_9.txt"), []byte("large output"), later)

	// Back on Default, where the copy it left is still there.
	back := resumeOn(defaultDir)
	if got := readFile(t, back); got != continued {
		t.Fatalf("back on Default, the conversation resumed is not the one continued on Work — %q is missing:\n%s",
			"sprocket renamed on Work", got)
	}
	if _, err := os.Stat(filepath.Join(strings.TrimSuffix(back, ".jsonl"), "tool-results", "toolu_9.txt")); err != nil {
		t.Fatalf("the tool result written on Work did not come back with the conversation: %v", err)
	}
	if got := readFile(t, onWork); got != continued {
		t.Fatalf("Work lost its copy:\n%s", got)
	}
}

// The copy on the account a session resumes on is replaced only by a newer one. It stays when it is the
// newest any account holds — the only one, the same as the other account's, or ahead of it — and is not
// rewritten; with none here, the other account's is carried. Newer is read from the records, so a copy
// left behind is replaced however recently its file was written, and one ahead stays however recently
// the other's was. The event log is never read: there is always a conversation to resume.
func TestClaudeConversationOnTheResumingAccountIsReplacedOnlyByANewerOne(t *testing.T) {
	const id = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
	start := time.Now().Add(-10 * time.Hour)
	behind := claudeTurns(t, start, "rename the widget", "renamed it")
	ahead := append(append([]byte(nil), behind...), claudeTurns(t, start.Add(time.Hour), "and the gadget", "gadget renamed")...)
	// When each file was last written: as its last turn was, or later — by a carry, or anything else.
	aheadEnded, afterThem := start.Add(time.Hour+time.Minute), time.Now()
	for _, tc := range []struct {
		name              string
		here, there       []byte // nil: that account holds no copy
		hereAt, thereAt   time.Time
		want              []byte
		wantHereRewritten bool
	}{
		{name: "no copy here", there: ahead, thereAt: aheadEnded, want: ahead, wantHereRewritten: true},
		{name: "only a copy here", here: ahead, hereAt: aheadEnded, want: ahead},
		// As a carry leaves it: the same conversation, its file written later there.
		{name: "the same copy on both", here: ahead, hereAt: aheadEnded, there: ahead, thereAt: afterThem, want: ahead},
		{name: "the copy here is ahead", here: ahead, hereAt: aheadEnded, there: behind, thereAt: afterThem, want: ahead},
		{name: "the copy here is behind", here: behind, hereAt: afterThem, there: ahead, thereAt: aheadEnded, want: ahead, wantHereRewritten: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			claudeAccountSlotTestHomes(t)
			personal, err := claudeAccountKind.create("Personal")
			if err != nil {
				t.Fatal(err)
			}
			work, err := claudeAccountKind.create("Work")
			if err != nil {
				t.Fatal(err)
			}
			execDir := t.TempDir()
			here, _ := claudeTranscriptPathIn(personal.Dir, execDir, id)
			if tc.here != nil {
				putFile(t, here, tc.here, tc.hereAt)
			}
			if tc.there != nil {
				there, _ := claudeTranscriptPathIn(work.Dir, execDir, id)
				putFile(t, there, tc.there, tc.thereAt)
			}
			before, _ := os.Stat(here)

			job := &ClaimedSession{SessionID: id, SessionUUID: id, Provider: providerClaude,
				Agent: AgentExecConfig{Provider: providerClaude, Env: map[string]string{"CLAUDE_CONFIG_DIR": personal.Dir}}}
			if !ensureClaudeTranscript(context.Background(), eventLogNobodyReads(t), job, execDir, noEmit) {
				t.Fatal("the session was told there is nothing to resume")
			}
			if got := readFile(t, here); got != string(tc.want) {
				t.Fatalf("the conversation resumed:\n%s\nwant:\n%s", got, tc.want)
			}
			after, err := os.Stat(here)
			if err != nil {
				t.Fatal(err)
			}
			if rewritten := before == nil || !os.SameFile(before, after); rewritten != tc.wantHereRewritten {
				t.Fatalf("the copy here was rewritten: %v, want %v", rewritten, tc.wantHereRewritten)
			}
		})
	}
}

// A copy is dated by the records at its end: past the bookkeeping the CLI writes without a stamp, by the
// latest of the stamps there (the CLI writes them only nearly in order), and further back than the first
// stretch read when the last record is longer than it. A file with no stamp near its end is as new as
// its file.
func TestClaudeConversationIsDatedByTheRecordsAtItsEnd(t *testing.T) {
	stamp := func(s string) time.Time {
		at, err := time.Parse(time.RFC3339Nano, s)
		if err != nil {
			t.Fatal(err)
		}
		return at
	}
	written := time.Now().Add(-time.Hour)
	for _, tc := range []struct {
		name string
		body string
		want time.Time
	}{
		{"bookkeeping after the last turn",
			`{"type":"user","timestamp":"2026-10-03T17:34:01.050Z"}` + "\n" + `{"type":"assistant","timestamp":"2026-10-03T17:34:14.684Z"}` + "\n" +
				`{"type":"last-prompt","lastPrompt":"go on"}` + "\n" + `{"type":"mode","mode":"default"}` + "\n",
			stamp("2026-10-03T17:34:14.684Z")},
		{"stamps nearly in order",
			`{"type":"attachment","timestamp":"2026-10-03T17:34:14.309Z"}` + "\n" + `{"type":"assistant","timestamp":"2026-10-03T17:34:14.307Z"}` + "\n",
			stamp("2026-10-03T17:34:14.309Z")},
		{"a last record longer than the first stretch",
			`{"type":"user","timestamp":"2026-10-03T08:00:00Z"}` + "\n" +
				`{"type":"user","timestamp":"2026-10-03T09:00:00Z","message":"` + strings.Repeat("x", 3*transcriptReadBuffer) + `"}` + "\n",
			stamp("2026-10-03T09:00:00Z")},
		{"no stamp at all", `{"type":"user","message":{"role":"user","content":"hello"}}` + "\n", written},
	} {
		path := filepath.Join(t.TempDir(), "conversation.jsonl")
		putFile(t, path, []byte(tc.body), written)
		if got := claudeConversationMovedAt(path); !got.Equal(tc.want) {
			t.Errorf("%s: dated %v, want %v", tc.name, got, tc.want)
		}
	}
}
