package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

// importTestTranscript assembles a synthetic Claude transcript as JSONL. Rows are written in
// the real transcript's shape: user/assistant rows carry cwd and a timestamp, bookkeeping rows
// carry neither.
type importTestTranscript struct {
	lines []string
}

func (b *importTestTranscript) add(v map[string]interface{}) {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	b.lines = append(b.lines, string(raw))
}

func (b *importTestTranscript) write(t *testing.T, path string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(strings.Join(b.lines, "\n") + "\n"); err != nil {
		t.Fatal(err)
	}
}

func importMsgRow(typ, cwd, ts string, content ...map[string]interface{}) map[string]interface{} {
	blocks := make([]interface{}, len(content))
	for i, b := range content {
		blocks[i] = b
	}
	return map[string]interface{}{
		"type":      typ,
		"message":   map[string]interface{}{"role": typ, "content": blocks},
		"sessionId": "4e453ab7-f37c-494d-8017-bb4e9beffeef",
		"cwd":       cwd,
		"timestamp": ts,
	}
}

// TestParseImportTranscriptRoundTrip feeds a transcript that exercises every normalization the
// forward function performs — sidechains, thinking blocks, empty text, an answered tool call, an
// unanswered one, and a compaction — and checks the events it produces. parseImportTranscript's
// internal self-check already replays the events and compares them to the transcript; this test
// pins the event stream itself.
func TestParseImportTranscriptRoundTrip(t *testing.T) {
	const (
		cwd   = "/ws/proj"
		t0    = "2026-09-15T10:00:00Z"
		t1    = "2026-09-15T10:00:01Z"
		t2    = "2026-09-15T10:00:02Z"
		t3    = "2026-09-15T10:00:03Z"
		t4    = "2026-09-15T10:00:04Z"
		t5    = "2026-09-15T10:00:05Z"
		t6    = "2026-09-15T10:00:06Z"
		t7    = "2026-09-15T10:00:07Z"
		title = "First principles design"
	)
	var tr importTestTranscript
	tr.add(map[string]interface{}{"type": "summary", "summary": "bookkeeping", "leafUuid": "x"})
	tr.add(map[string]interface{}{"type": "ai-title", "aiTitle": title, "timestamp": t0})
	tr.add(importMsgRow("user", cwd, t1, map[string]interface{}{"type": "text", "text": "Hello"}))
	tr.add(importMsgRow("assistant", cwd, t2,
		map[string]interface{}{"type": "text", "text": "Hi there"},
		map[string]interface{}{"type": "tool_use", "id": "t1", "name": "Bash", "input": map[string]interface{}{"command": "ls"}},
		map[string]interface{}{"type": "thinking", "thinking": "dropped"},
		map[string]interface{}{"type": "text", "text": "  "},
	))
	tr.add(importMsgRow("user", cwd, t3, map[string]interface{}{
		"type": "tool_result", "tool_use_id": "t1", "content": "file.txt", "is_error": false,
	}))
	tr.add(importMsgRow("assistant", cwd, t4, map[string]interface{}{"type": "text", "text": "Done"}))
	tr.add(importMsgRow("assistant", cwd, t5, map[string]interface{}{
		"type": "tool_use", "id": "t2", "name": "Read", "input": map[string]interface{}{"file_path": "a.txt"},
	}))
	// Compacted here: the direct side flushes the still-open t2, and the forward function does
	// the same when replaying, so both sides agree and the events themselves invent nothing.
	tr.add(map[string]interface{}{
		"type": "user", "isCompactSummary": true, "cwd": cwd, "timestamp": t6,
		"message": map[string]interface{}{"role": "user", "content": "Summary of the above"},
	})
	tr.add(importMsgRow("user", cwd, t7, map[string]interface{}{"type": "text", "text": "next please"}))
	// A sidechain branch: not the main conversation, so it contributes nothing.
	side := importMsgRow("user", cwd, t7, map[string]interface{}{"type": "text", "text": "ignored branch"})
	side["isSidechain"] = true
	tr.add(side)
	tr.add(importMsgRow("assistant", cwd, t7, map[string]interface{}{"type": "text", "text": "Final answer"}))

	dir := t.TempDir()
	path := filepath.Join(dir, "sample.jsonl")
	tr.write(t, path)

	gotCwd, gotTitle, events, err := parseImportTranscript(path)
	if err != nil {
		t.Fatalf("parseImportTranscript: %v", err)
	}
	if gotCwd != cwd {
		t.Errorf("cwd = %q, want %q", gotCwd, cwd)
	}
	if gotTitle != title {
		t.Errorf("title = %q, want %q", gotTitle, title)
	}
	want := []StoredEvent{
		{Seq: 1, Type: evUser, Payload: map[string]interface{}{"text": "Hello"}, Ts: mustParseTs(t, t1)},
		{Seq: 2, Type: evAssistant, Payload: map[string]interface{}{"text": "Hi there"}, Ts: mustParseTs(t, t2)},
		{Seq: 3, Type: evToolUse, Payload: map[string]interface{}{"id": "t1", "name": "Bash", "input": map[string]interface{}{"command": "ls"}}, Ts: mustParseTs(t, t2)},
		{Seq: 4, Type: evToolResult, Payload: map[string]interface{}{"toolUseId": "t1", "content": "file.txt", "isError": false}, Ts: mustParseTs(t, t3)},
		{Seq: 5, Type: evAssistant, Payload: map[string]interface{}{"text": "Done"}, Ts: mustParseTs(t, t4)},
		{Seq: 6, Type: evToolUse, Payload: map[string]interface{}{"id": "t2", "name": "Read", "input": map[string]interface{}{"file_path": "a.txt"}}, Ts: mustParseTs(t, t5)},
		{Seq: 7, Type: evSystem, Payload: map[string]interface{}{"subtype": "compact_summary", "text": "Summary of the above"}, Ts: mustParseTs(t, t6)},
		{Seq: 8, Type: evUser, Payload: map[string]interface{}{"text": "next please"}, Ts: mustParseTs(t, t7)},
		{Seq: 9, Type: evAssistant, Payload: map[string]interface{}{"text": "Final answer"}, Ts: mustParseTs(t, t7)},
	}
	if !reflect.DeepEqual(events, want) {
		t.Errorf("events mismatch:\n got %s\nwant %s", dumpEvents(events), dumpEvents(want))
	}
}

// The last ai-title wins: Claude retitles a session, and the transcript's newest title is the
// session's.
func TestParseImportTranscriptLastTitleWins(t *testing.T) {
	var tr importTestTranscript
	tr.add(map[string]interface{}{"type": "ai-title", "aiTitle": "First attempt", "timestamp": "2026-09-15T10:00:00Z"})
	tr.add(map[string]interface{}{"type": "ai-title", "aiTitle": "Better title", "timestamp": "2026-09-15T10:00:01Z"})
	tr.add(importMsgRow("user", "/ws", "2026-09-15T10:00:02Z", map[string]interface{}{"type": "text", "text": "hi"}))
	dir := t.TempDir()
	path := filepath.Join(dir, "t.jsonl")
	tr.write(t, path)
	_, title, _, err := parseImportTranscript(path)
	if err != nil {
		t.Fatalf("parseImportTranscript: %v", err)
	}
	if title != "Better title" {
		t.Errorf("title = %q, want %q", title, "Better title")
	}
}

func TestParseImportTranscriptRefuses(t *testing.T) {
	t.Run("no conversation", func(t *testing.T) {
		var tr importTestTranscript
		tr.add(map[string]interface{}{"type": "summary", "summary": "x"})
		tr.add(map[string]interface{}{"type": "ai-title", "aiTitle": "Title only"})
		tr.add(importMsgRow("assistant", "/ws", "2026-09-15T10:00:00Z", map[string]interface{}{"type": "text", "text": "nobody asked"}))
		path := writeImportFixture(t, &tr)
		if _, _, _, err := parseImportTranscript(path); err == nil || !strings.Contains(err.Error(), "holds no conversation") {
			t.Errorf("err = %v, want the no-conversation refusal", err)
		}
	})
	t.Run("not JSON", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "t.jsonl")
		if err := os.WriteFile(path, []byte("this is not json\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, _, _, err := parseImportTranscript(path); err == nil || !strings.Contains(err.Error(), "not JSON") {
			t.Errorf("err = %v, want the not-JSON refusal", err)
		}
	})
}

// copyTranscriptRewritingCwd rewrites the recorded cwd on every row that has one, leaves rows
// without a cwd byte-for-byte alone, and keeps an unparseable line verbatim rather than editing
// a record it does not understand.
func TestCopyTranscriptRewritingCwd(t *testing.T) {
	var tr importTestTranscript
	tr.add(importMsgRow("user", "/old/proj", "2026-09-15T10:00:00Z", map[string]interface{}{"type": "text", "text": "hi"}))
	tr.add(map[string]interface{}{"type": "summary", "summary": "no cwd here"})
	tr.add(importMsgRow("user", "/old/proj", "2026-09-15T10:00:01Z", map[string]interface{}{"type": "tool_result", "tool_use_id": "t1", "content": "x"}))
	tr.lines = append(tr.lines, "{a line no parser should touch")

	src := filepath.Join(t.TempDir(), "src.jsonl")
	tr.write(t, src)
	dst := filepath.Join(t.TempDir(), "proj", "dst.jsonl")
	if err := copyTranscriptRewritingCwd(src, dst, "/new/proj"); err != nil {
		t.Fatalf("copyTranscriptRewritingCwd: %v", err)
	}
	raw, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	if len(lines) != 4 {
		t.Fatalf("copied %d lines, want 4", len(lines))
	}
	var user map[string]interface{}
	if err := json.Unmarshal([]byte(lines[0]), &user); err != nil {
		t.Fatalf("line 0 not JSON: %v", err)
	}
	if user["cwd"] != "/new/proj" {
		t.Errorf("line 0 cwd = %v, want /new/proj", user["cwd"])
	}
	if lines[1] != tr.lines[1] {
		t.Errorf("line 1 changed: %q", lines[1])
	}
	var result map[string]interface{}
	if err := json.Unmarshal([]byte(lines[2]), &result); err != nil {
		t.Fatalf("line 2 not JSON: %v", err)
	}
	if result["cwd"] != "/new/proj" {
		t.Errorf("line 2 cwd = %v, want /new/proj", result["cwd"])
	}
	if lines[3] != tr.lines[3] {
		t.Errorf("unparseable line changed: %q", lines[3])
	}
}

// findClaudeTranscripts globs every project directory, not just the first match — a previous
// import may have left a copy under a dead checkout, and the caller tries candidates in order.
func TestFindClaudeTranscriptsGlobsAllDirectories(t *testing.T) {
	base := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", base)
	for _, proj := range []string{"aaa-bbb", "ccc"} {
		dir := filepath.Join(base, "projects", proj)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "4e453ab7-f37c-494d-8017-bb4e9beffeef.jsonl"), []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(base, "projects", "aaa-bbb", "00000000-0000-0000-0000-000000000000.jsonl"), []byte("y\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := findClaudeTranscripts("4e453ab7-f37c-494d-8017-bb4e9beffeef")
	sort.Strings(got)
	want := []string{
		filepath.Join(base, "projects", "aaa-bbb", "4e453ab7-f37c-494d-8017-bb4e9beffeef.jsonl"),
		filepath.Join(base, "projects", "ccc", "4e453ab7-f37c-494d-8017-bb4e9beffeef.jsonl"),
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("findClaudeTranscripts = %v, want %v", got, want)
	}
}

// The same transcript parses to the same events every time — no map-order nondeterminism in the
// payloads the round-trip compares.
func TestParseImportTranscriptDeterministic(t *testing.T) {
	var tr importTestTranscript
	tr.add(importMsgRow("user", "/ws", "2026-09-15T10:00:00Z",
		map[string]interface{}{"type": "text", "text": "one"},
		map[string]interface{}{"type": "tool_result", "tool_use_id": "orphan", "content": "dangling"},
	))
	tr.add(importMsgRow("assistant", "/ws", "2026-09-15T10:00:01Z",
		map[string]interface{}{"type": "tool_use", "id": "t1", "name": "Bash", "input": map[string]interface{}{"command": "ls", "flags": []interface{}{"-a", "-l"}}},
		map[string]interface{}{"type": "text", "text": "ran"},
	))
	tr.add(importMsgRow("user", "/ws", "2026-09-15T10:00:02Z", map[string]interface{}{"type": "tool_result", "tool_use_id": "t1", "content": []interface{}{
		map[string]interface{}{"type": "text", "text": "part "},
		map[string]interface{}{"type": "text", "text": "two"},
	}, "is_error": false}))
	path := writeImportFixture(t, &tr)
	first := mustParseEvents(t, path)
	second := mustParseEvents(t, path)
	if !reflect.DeepEqual(first, second) {
		t.Errorf("two parses differ:\n first %s\nsecond %s", dumpEvents(first), dumpEvents(second))
	}
}

func writeImportFixture(t *testing.T, tr *importTestTranscript) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "t.jsonl")
	tr.write(t, path)
	return path
}

func mustParseEvents(t *testing.T, path string) []StoredEvent {
	t.Helper()
	_, _, events, err := parseImportTranscript(path)
	if err != nil {
		t.Fatalf("parseImportTranscript(%s): %v", path, err)
	}
	return events
}

func mustParseTs(t *testing.T, s string) time.Time {
	t.Helper()
	ts, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		t.Fatalf("bad test timestamp %q: %v", s, err)
	}
	return ts
}

func dumpEvents(events []StoredEvent) string {
	raw, err := json.Marshal(events)
	if err != nil {
		return err.Error()
	}
	return string(raw)
}

// A workspace's workDir is stored as the user typed it, so the claim payload carries `~/orbit`
// while the transcript records the absolute `/root/orbit`. Comparing the two literally never
// matches, and this refusal Trashes the session — so the import expands the tilde against this
// machine's home, the way every other consumer of a workDir here already does.
func TestRunTranscriptImportTildeWorkDir(t *testing.T) {
	const uuid = "4e453ab7-f37c-494d-8017-bb4e9beffeef"
	run := func(t *testing.T, cwdFor func(home string) string) (ImportResultRequest, []StoredEvent, error) {
		t.Helper()
		home := t.TempDir()
		t.Setenv("HOME", home)
		t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude"))
		recordedCwd := cwdFor(home)

		var tr importTestTranscript
		tr.add(map[string]interface{}{"type": "ai-title", "aiTitle": "Imported talk", "timestamp": "2026-09-15T10:00:00Z"})
		tr.add(importMsgRow("user", recordedCwd, "2026-09-15T10:00:01Z", map[string]interface{}{"type": "text", "text": "hi"}))
		tr.add(importMsgRow("assistant", recordedCwd, "2026-09-15T10:00:02Z", map[string]interface{}{"type": "text", "text": "hello"}))
		projects := filepath.Join(home, ".claude", "projects", claudeProjectSlug(recordedCwd))
		if err := os.MkdirAll(projects, 0o755); err != nil {
			t.Fatal(err)
		}
		tr.write(t, filepath.Join(projects, uuid+".jsonl"))

		var posted ImportResultRequest
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api/runner/sessions/s1/import-result" {
				t.Errorf("unexpected request to %s", r.URL.Path)
			}
			if err := json.NewDecoder(r.Body).Decode(&posted); err != nil {
				t.Errorf("decoding the import result: %v", err)
			}
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true,"applied":true}`))
		}))
		defer srv.Close()

		// The web path records the workspace workDir itself as the marker, so this carries a
		// tilde too — claudeTranscriptPath has to resolve it to find the file directly.
		marker := "~/proj"
		job := &ClaimedSession{SessionID: "s1", SessionUUID: uuid, WorkDir: "~/proj", ImportSourceCwd: &marker}
		var events []StoredEvent
		emit := func(eventType string, payload map[string]interface{}) {
			events = append(events, StoredEvent{Type: eventType, Payload: payload})
		}
		transport := &Transport{baseURL: srv.URL, client: srv.Client()}
		err := runTranscriptImport(context.Background(), transport, job, t.TempDir(), emit, func(context.Context) error { return nil })
		return posted, events, err
	}

	t.Run("a cwd under this machine's home is inside a tilde workDir", func(t *testing.T) {
		posted, events, err := run(t, func(home string) string { return filepath.Join(home, "proj") })
		if err != nil {
			t.Fatalf("runTranscriptImport: %v", err)
		}
		if !posted.Ok || posted.Title != "Imported talk" {
			t.Errorf("import result = %+v, want ok with the transcript's title", posted)
		}
		if len(events) != 2 || events[0].Type != evUser || events[1].Type != evAssistant {
			t.Errorf("replayed %s, want the transcript's two messages", dumpEvents(events))
		}
	})

	t.Run("a cwd outside the expanded workDir is still refused", func(t *testing.T) {
		posted, events, err := run(t, func(string) string { return "/elsewhere/proj" })
		if err == nil || !strings.Contains(err.Error(), "/elsewhere/proj") {
			t.Fatalf("err = %v, want the outside-the-workspace refusal", err)
		}
		if posted.Ok {
			t.Errorf("import result = %+v, want the failure that Trashes the session", posted)
		}
		if len(events) != 0 {
			t.Errorf("replayed %s, want nothing from a refused transcript", dumpEvents(events))
		}
	})
}

// The directory Claude keeps a transcript in is derived from the session's cwd, so a tilde in it
// has to be resolved before the slug is built — filepath.Abs would otherwise hang "~/proj" off
// the process's own cwd and name a project directory that does not exist.
func TestClaudeTranscriptPathExpandsTilde(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude"))
	const uuid = "4e453ab7-f37c-494d-8017-bb4e9beffeef"
	got, err := claudeTranscriptPath("~/proj", uuid)
	if err != nil {
		t.Fatalf("claudeTranscriptPath: %v", err)
	}
	want := filepath.Join(home, ".claude", "projects", claudeProjectSlug(filepath.Join(home, "proj")), uuid+".jsonl")
	if got != want {
		t.Errorf("claudeTranscriptPath = %q, want %q", got, want)
	}
}
