package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestParseRealTranscript is skipped wherever the sample does not exist (CI), and pins the
// conversion against a transcript written by a real Claude Code run on the machines that have
// it: 158 user/assistant rows, tool calls, compaction records, the works.
func TestParseRealTranscript(t *testing.T) {
	path := filepath.Join(os.Getenv("HOME"), ".claude", "projects", "-root-orbit", "4e453ab7-f37c-494d-8017-bb4e9beffeef.jsonl")
	if _, err := os.Stat(path); err != nil {
		t.Skip("real transcript sample not present")
	}
	cwd, title, events, err := parseImportTranscript(path)
	if err != nil {
		t.Fatalf("parseImportTranscript(real sample): %v", err)
	}
	if cwd != "/root/orbit" {
		t.Errorf("cwd = %q, want /root/orbit", cwd)
	}
	if title == "" {
		t.Errorf("title = %q, want the session's ai-title", title)
	}
	// This sample is a long tool chain: 50 tool calls answered by 50 results, 17 assistant
	// messages, and the user typing twice. The parse above already round-trip-checked the
	// conversion against the transcript itself; pin the volume so a silent drop is visible.
	results := 0
	uses := 0
	for _, e := range events {
		switch e.Type {
		case evToolResult:
			results++
		case evToolUse:
			uses++
		}
	}
	if uses != 50 || results != 50 {
		t.Errorf("tool events = %d uses / %d results, want 50/50", uses, results)
	}
	if len(events) < 100 {
		t.Errorf("only %d events from a 158-row transcript", len(events))
	}
}
