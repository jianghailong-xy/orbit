package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// jsonlLine builds a transcript entry whose user-message content is `content`, matching the
// shape Claude writes (message.content as a JSON string).
func jsonlLine(t *testing.T, content string) string {
	t.Helper()
	b, err := json.Marshal(map[string]interface{}{
		"type":    "user",
		"message": map[string]interface{}{"role": "user", "content": content},
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(b) + "\n"
}

func taskNotif(taskID, toolUseID, status string) string {
	return "<task-notification>\n" +
		"<task-id>" + taskID + "</task-id>\n" +
		"<tool-use-id>" + toolUseID + "</tool-use-id>\n" +
		"<status>" + status + "</status>\n" +
		"<summary>done</summary>\n" +
		"</task-notification>"
}

// bgCollector returns an emit fn plus a pointer to captured "<toolUseId>|<status>" pairs.
func bgCollector() (emitFn, *[]string) {
	var got []string
	emit := func(eventType string, payload map[string]interface{}) {
		if eventType == evBackgroundTask {
			got = append(got, asString(payload["toolUseId"])+"|"+asString(payload["status"]))
		}
	}
	return emit, &got
}

func TestScanTranscriptEmitsAndDedupes(t *testing.T) {
	emit, got := bgCollector()
	bg := newBgTailer(context.Background(), emit)
	path := filepath.Join(t.TempDir(), "s.jsonl")
	content := jsonlLine(t, taskNotif("bok", "toolu_A", "completed")) +
		jsonlLine(t, taskNotif("bei", "toolu_B", "running")) +
		jsonlLine(t, "plain text, no notification here")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	off := bg.scanTranscript(path, 0)
	if len(*got) != 2 {
		t.Fatalf("first scan: want 2 events, got %v", *got)
	}
	// Re-scanning from the returned offset (no new bytes) must not re-emit.
	bg.scanTranscript(path, off)
	if len(*got) != 2 {
		t.Fatalf("rescan re-emitted: %v", *got)
	}
}

func TestScanTranscriptIncremental(t *testing.T) {
	emit, got := bgCollector()
	bg := newBgTailer(context.Background(), emit)
	path := filepath.Join(t.TempDir(), "s.jsonl")
	if err := os.WriteFile(path, []byte(jsonlLine(t, taskNotif("a", "toolu_A", "completed"))), 0o644); err != nil {
		t.Fatal(err)
	}
	off := bg.scanTranscript(path, 0)

	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(jsonlLine(t, taskNotif("b", "toolu_B", "failed"))); err != nil {
		t.Fatal(err)
	}
	f.Close()

	bg.scanTranscript(path, off)
	if len(*got) != 2 || (*got)[1] != "toolu_B|failed" {
		t.Fatalf("incremental scan: got %v", *got)
	}
}

// A completion delivered via both the stdout path (bgTaskFromNotification) and the transcript
// tail must produce exactly one event.
func TestNotificationDedupeAcrossSources(t *testing.T) {
	emit, got := bgCollector()
	bg := newBgTailer(context.Background(), emit)
	n := taskNotif("bok", "toolu_A", "completed")

	bgTaskFromNotification(n, emit, bg) // stdout path
	path := filepath.Join(t.TempDir(), "s.jsonl")
	if err := os.WriteFile(path, []byte(jsonlLine(t, n)), 0o644); err != nil {
		t.Fatal(err)
	}
	bg.scanTranscript(path, 0) // transcript path, same notification

	if len(*got) != 1 {
		t.Fatalf("want 1 event after dedupe, got %v", *got)
	}
}

// A partial trailing line (mid-write, no newline yet) must not be consumed until it completes.
func TestScanTranscriptPartialLine(t *testing.T) {
	emit, got := bgCollector()
	bg := newBgTailer(context.Background(), emit)
	path := filepath.Join(t.TempDir(), "s.jsonl")
	full := jsonlLine(t, taskNotif("a", "toolu_A", "completed")) // trailing '\n'

	if err := os.WriteFile(path, []byte(full[:len(full)-5]), 0o644); err != nil { // drop newline + tail
		t.Fatal(err)
	}
	off := bg.scanTranscript(path, 0)
	if len(*got) != 0 || off != 0 {
		t.Fatalf("partial line consumed early: events=%v off=%d", *got, off)
	}
	if err := os.WriteFile(path, []byte(full), 0o644); err != nil {
		t.Fatal(err)
	}
	bg.scanTranscript(path, off)
	if len(*got) != 1 {
		t.Fatalf("completed line not emitted: %v", *got)
	}
}

func TestScanTranscriptBoundsHugeIrrelevantLinesAndContinues(t *testing.T) {
	emit, got := bgCollector()
	bg := newBgTailer(context.Background(), emit)
	path := filepath.Join(t.TempDir(), "s.jsonl")
	huge := strings.Repeat("x", transcriptRelevantLineCap+transcriptReadBuffer) + "\n"
	content := huge + jsonlLine(t, taskNotif("a", "toolu_A", "completed"))
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	off := bg.scanTranscript(path, 0)
	if off != int64(len(content)) {
		t.Fatalf("scan offset = %d, want %d", off, len(content))
	}
	if len(*got) != 1 || (*got)[0] != "toolu_A|completed" {
		t.Fatalf("notification after huge line = %v", *got)
	}
}

func TestReadCappedReturnsOnlyTheFileTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "output")
	prefix := strings.Repeat("p", bgTailCap)
	tail := strings.Repeat("t", bgTailCap)
	if err := os.WriteFile(path, []byte(prefix+tail), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := readCapped(path); got != tail {
		t.Fatalf("tail length/content mismatch: got %d bytes", len(got))
	}
}

// A shell dies with the engine that launched it, and Claude writes a <task-notification> only
// for a shell that ends on its own — so the stop has to report it, or it stays "running" for
// the rest of the session. Runner-owned `!`-shells outlive the engine and are left alone.
func TestKillEngineShellsReportsOnlyEngineOwnedShells(t *testing.T) {
	emit, got := bgCollector()
	bg := newBgTailer(context.Background(), emit)
	defer bg.stopAll()
	dir := t.TempDir()
	bg.startTail("toolu_A", "bei1", filepath.Join(dir, "bei1.output"), true)
	bg.startTail("toolu_B", "bei2", filepath.Join(dir, "bei2.output"), false)

	bg.killEngineShells()

	if len(*got) != 1 || (*got)[0] != "toolu_A|killed" {
		t.Fatalf("want the engine-owned shell killed only, got %v", *got)
	}
	if _, ok := bg.live["toolu_B"]; !ok {
		t.Fatal("runner-owned shell must survive its engine stopping")
	}
}

// Whichever terminal signal lands first wins: a notification arriving after the engine stop
// (the transcript tail re-reads the whole file) must not report the same shell twice.
func TestLateNotificationDoesNotRelitigateAKilledShell(t *testing.T) {
	emit, got := bgCollector()
	bg := newBgTailer(context.Background(), emit)
	defer bg.stopAll()
	bg.startTail("toolu_A", "bei1", filepath.Join(t.TempDir(), "bei1.output"), true)

	bg.killEngineShells()
	bgTaskFromNotification(taskNotif("bei1", "toolu_A", "completed"), emit, bg)

	if len(*got) != 1 || (*got)[0] != "toolu_A|killed" {
		t.Fatalf("want a single terminal report, got %v", *got)
	}
}

// watchJSONL must return once the session run ends (stopAll), not leak a goroutine.
func TestWatchJSONLStopsOnStopAll(t *testing.T) {
	emit, _ := bgCollector()
	bg := newBgTailer(context.Background(), emit)
	bg.startTranscriptWatcher("no-such-session-uuid")
	bg.stopAll()
}

func TestUserTextFromJSONL(t *testing.T) {
	// content as a plain string
	if got := userTextFromJSONL(jsonlLine(t, "hello")); got != "hello" {
		t.Fatalf("string content: got %q", got)
	}
	// content as an array of blocks
	line, _ := json.Marshal(map[string]interface{}{
		"message": map[string]interface{}{
			"content": []map[string]interface{}{
				{"type": "text", "text": "a"},
				{"type": "image", "text": "ignored"},
				{"type": "text", "text": "b"},
			},
		},
	})
	if got := userTextFromJSONL(string(line)); got != "a\nb\n" {
		t.Fatalf("array content: got %q", got)
	}
	// malformed
	if got := userTextFromJSONL("{not json"); got != "" {
		t.Fatalf("malformed: got %q", got)
	}
}

func TestFindClaudeTranscriptViaConfigDir(t *testing.T) {
	base := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", base)
	dir := filepath.Join(base, "projects", "-some-escaped-cwd")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	uuid := "14059555-3b07-407b-8146-83f21c8f4314"
	want := filepath.Join(dir, uuid+".jsonl")
	if err := os.WriteFile(want, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := findClaudeTranscript(uuid); got != want {
		t.Fatalf("find: got %q want %q", got, want)
	}
	if got := findClaudeTranscript("no-such-uuid"); got != "" {
		t.Fatalf("missing uuid: got %q", got)
	}
}
