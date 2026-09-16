package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writeTranscript puts a transcript in the project directory Claude Code would record it in for
// cwd, with the given mtime, and returns its path.
func writeTranscript(t *testing.T, base, cwd, id string, modified time.Time, lines ...string) string {
	t.Helper()
	dir := filepath.Join(base, "projects", claudeProjectSlug(cwd))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, id+".jsonl")
	body := ""
	for _, line := range lines {
		body += line + "\n"
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, modified, modified); err != nil {
		t.Fatal(err)
	}
	return path
}

func userLine(text string) string {
	return `{"type":"user","message":{"role":"user","content":"` + text + `"}}`
}

func assistantLine(text string) string {
	return `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"` + text + `"}]}}`
}

// The offer the new-workspace form makes is made entirely out of this scan, so what it counts and
// what it refuses to count is the feature.
func TestScanClaudeHistory(t *testing.T) {
	base := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", base)
	cwd := "/root/take-over-me"
	now := time.Now()

	newest := "11111111-1111-4111-8111-111111111111"
	older := "22222222-2222-4222-8222-222222222222"
	stale := "33333333-3333-4333-8333-333333333333"
	bookkeeping := "44444444-4444-4444-8444-444444444444"

	writeTranscript(t, base, cwd, newest, now.Add(-2*time.Hour),
		userLine("take this over"),
		assistantLine("on it"),
		`{"type":"ai-title","aiTitle":"first principles"}`,
		userLine("keep going"),
	)
	writeTranscript(t, base, cwd, older, now.Add(-72*time.Hour),
		userLine("an older thread"),
		assistantLine("answered"),
	)
	// Outside the window: rolling cleanup is about to take it, and promising to import it would be
	// promising history nobody kept.
	writeTranscript(t, base, cwd, stale, now.Add(-45*24*time.Hour), userLine("ancient"))
	// Bookkeeping only — `--resume` answers "No conversation found" for exactly this file, so
	// offering it would promise something the import would then refuse.
	writeTranscript(t, base, cwd, bookkeeping, now.Add(-time.Hour),
		`{"type":"last-prompt","prompt":"hi"}`,
		`{"type":"ai-title","aiTitle":"never really started"}`,
	)
	// Not a transcript: the directory belongs to Claude Code, and whatever else it keeps there is
	// not something an import could be keyed on.
	if err := os.WriteFile(filepath.Join(base, "projects", claudeProjectSlug(cwd), "notes.jsonl"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := scanClaudeHistory(cwd)
	if got.Error != "" {
		t.Fatalf("unexpected error: %s", got.Error)
	}
	if got.WorkDir != cwd {
		t.Fatalf("workDir = %q, want %q", got.WorkDir, cwd)
	}
	if got.WindowDays != 30 {
		t.Fatalf("windowDays = %d, want 30", got.WindowDays)
	}
	if len(got.Transcripts) != 2 {
		t.Fatalf("transcripts = %d (%+v), want 2 — the stale, bookkeeping-only and non-transcript files must not be offered", len(got.Transcripts), got.Transcripts)
	}
	if got.Conversations != 2 {
		t.Fatalf("conversations = %d, want 2", got.Conversations)
	}
	// Newest first: the first entry is the one the offer calls "the one I'm in the middle of".
	if got.Transcripts[0].ClaudeSessionID != newest {
		t.Fatalf("first transcript = %q, want the most recently touched %q", got.Transcripts[0].ClaudeSessionID, newest)
	}
	if got.Transcripts[1].ClaudeSessionID != older {
		t.Fatalf("second transcript = %q, want %q", got.Transcripts[1].ClaudeSessionID, older)
	}
	if got.Transcripts[0].Title != "first principles" {
		t.Fatalf("title = %q, want the transcript's own ai-title", got.Transcripts[0].Title)
	}
	if got.Transcripts[0].Messages != 3 {
		t.Fatalf("messages = %d, want the 3 user/assistant records", got.Transcripts[0].Messages)
	}
	if got.Events != 5 {
		t.Fatalf("events = %d, want 5 across both transcripts", got.Events)
	}
	if got.Bytes <= 0 {
		t.Fatalf("bytes = %d, want the transcripts' size on disk", got.Bytes)
	}
	if got.Transcripts[0].LastActiveAt == "" {
		t.Fatal("lastActiveAt is empty — the offer states when the conversation was last touched")
	}
}

// A directory nobody has run claude in is an ordinary answer with nothing in it, not a failure:
// the form must be able to tell "there is no history here" from "I could not look", because only
// the second one is worth saying out loud.
func TestScanClaudeHistoryEmptyDirectoryIsNotAnError(t *testing.T) {
	base := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", base)

	got := scanClaudeHistory("/root/never-used-here")
	if got.Error != "" {
		t.Fatalf("error = %q, want none for a directory with no project dir", got.Error)
	}
	if got.Conversations != 0 || len(got.Transcripts) != 0 {
		t.Fatalf("got %d conversations / %d transcripts, want nothing", got.Conversations, len(got.Transcripts))
	}
}

// The scan has to read the same directory `--resume` does, uncollapsed runs and all. A slug
// computed any other way would report history the import then cannot find.
func TestScanClaudeHistoryReadsTheResumeDirectory(t *testing.T) {
	base := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", base)
	// Two separators in a row and a dot: the case where collapsing runs would give a different,
	// wrong directory (/root/.orbit/x -> -root--orbit-x).
	cwd := "/root/.orbit/worktrees/take-over"
	id := "55555555-5555-4555-8555-555555555555"
	writeTranscript(t, base, cwd, id, time.Now(), userLine("hello"), assistantLine("hi"))

	resumeReads, err := claudeTranscriptPath(cwd, id)
	if err != nil {
		t.Fatal(err)
	}
	got := scanClaudeHistory(cwd)
	if len(got.Transcripts) != 1 || got.Transcripts[0].ClaudeSessionID != id {
		t.Fatalf("scan found %+v, want the transcript at %s", got.Transcripts, resumeReads)
	}
	if _, err := os.Stat(resumeReads); err != nil {
		t.Fatalf("the file the scan reported is not where --resume looks (%s): %v", resumeReads, err)
	}
}
