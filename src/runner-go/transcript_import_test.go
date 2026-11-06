package main

import (
	"bytes"
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

	gotCwd, gotTitle, events, err := parseImportTranscript(path, nil)
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
	_, title, _, err := parseImportTranscript(path, nil)
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
		if _, _, _, err := parseImportTranscript(path, nil); err == nil || !strings.Contains(err.Error(), "holds no conversation") {
			t.Errorf("err = %v, want the no-conversation refusal", err)
		}
	})
	// A line that is not JSON is skipped rather than refused, so a file with nothing else in it
	// has no conversation left — and the refusal says why.
	t.Run("not JSON at all", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "t.jsonl")
		if err := os.WriteFile(path, []byte("this is not json\n{\"neither\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		var skipped []int
		_, _, _, err := parseImportTranscript(path, func(line int) { skipped = append(skipped, line) })
		if err == nil || !strings.Contains(err.Error(), "holds no conversation (none of its lines is JSON)") {
			t.Errorf("err = %v, want the no-conversation refusal saying no line is JSON", err)
		}
		if !reflect.DeepEqual(skipped, []int{1, 2}) {
			t.Errorf("skipped lines %v, want [1 2]", skipped)
		}
	})
}

// copyTranscriptForSession rewrites the recorded cwd on every row whose cwd differs, leaves rows
// without a cwd byte-for-byte alone, and keeps an unparseable line verbatim rather than editing
// a record it does not understand.
func TestCopyTranscriptForSession(t *testing.T) {
	var tr importTestTranscript
	tr.add(importMsgRow("user", "/old/proj", "2026-09-15T10:00:00Z", map[string]interface{}{"type": "text", "text": "hi"}))
	tr.add(map[string]interface{}{"type": "summary", "summary": "no cwd here"})
	tr.add(importMsgRow("user", "/old/proj", "2026-09-15T10:00:01Z", map[string]interface{}{"type": "tool_result", "tool_use_id": "t1", "content": "x"}))
	tr.lines = append(tr.lines, "{a line no parser should touch")

	src := filepath.Join(t.TempDir(), "src.jsonl")
	tr.write(t, src)
	dst := filepath.Join(t.TempDir(), "proj", "dst.jsonl")
	if err := copyTranscriptForSession(src, dst, "/new/proj", "", ""); err != nil {
		t.Fatalf("copyTranscriptForSession: %v", err)
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

// What the copy rewrites, it rewrites and nothing else. A row already recorded in the session's
// own directory is copied byte for byte. A row whose cwd changes keeps every other value as Claude
// wrote it: an integer past float64's precision, `<`, `>` and `&` in text, key order inside the
// values. On 2026-11-06 a re-encode of each row sorted every key and turned 84 rows' `<>&` into
// Unicode escapes, in the original file itself. The copy also keeps the source's owner-only mode,
// where it used to come out world-readable.
func TestCopyTranscriptForSessionRewritesOnlyWhatChanges(t *testing.T) {
	const here = "/ws/proj"
	unchanged := `{"type":"user","cwd":"/ws/proj","message":{"content":"<b>a</b> & b","role":"user"},"sessionId":"s-1"}`
	moved := `{"type":"assistant","cwd":"/old/proj","costUSD":12345678901234567890,"message":{"role":"assistant","content":"x<y && y>z"},"sessionId":"s-1"}`
	src := filepath.Join(t.TempDir(), "src.jsonl")
	if err := os.WriteFile(src, []byte(unchanged+"\n"+moved+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(t.TempDir(), "proj", "dst.jsonl")
	if err := copyTranscriptForSession(src, dst, here, "", ""); err != nil {
		t.Fatalf("copyTranscriptForSession: %v", err)
	}
	raw, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("copied %d lines, want 2", len(lines))
	}
	if lines[0] != unchanged {
		t.Errorf("a row already in this directory was re-encoded:\n got %s\nwant %s", lines[0], unchanged)
	}
	for _, kept := range []string{`12345678901234567890`, `"x<y && y>z"`, `{"role":"assistant","content":"x<y && y>z"}`} {
		if !strings.Contains(lines[1], kept) {
			t.Errorf("the rewritten row lost %s: %s", kept, lines[1])
		}
	}
	if !strings.Contains(lines[1], `"cwd":"/ws/proj"`) {
		t.Errorf("the rewritten row's cwd is not the session's: %s", lines[1])
	}
	info, err := os.Stat(dst)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Errorf("copy mode = %o, want the source's 600", got)
	}
}

// A fork renames the conversation in each record that names it, and only there: a record naming
// another conversation, or none, keeps what it had.
func TestCopyTranscriptForSessionForksTheSessionID(t *testing.T) {
	const original = "4e453ab7-f37c-494d-8017-bb4e9beffeef"
	fork := importForkSessionID(original)
	rows := []string{
		`{"type":"user","cwd":"/ws/proj","sessionId":"` + original + `","message":{"content":"hi"}}`,
		`{"type":"session-owner","sessionId":"` + original + `"}`,
		`{"type":"user","cwd":"/ws/proj","sessionId":"another-conversation","message":{"content":"hi"}}`,
		`{"type":"summary","summary":"names nobody"}`,
	}
	src := filepath.Join(t.TempDir(), "src.jsonl")
	if err := os.WriteFile(src, []byte(strings.Join(rows, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(t.TempDir(), "proj", fork+".jsonl")
	if err := copyTranscriptForSession(src, dst, "/ws/proj", original, fork); err != nil {
		t.Fatalf("copyTranscriptForSession: %v", err)
	}
	raw, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	for i, want := range []string{fork, fork, "another-conversation", ""} {
		var rec struct {
			SessionID string `json:"sessionId"`
		}
		if err := json.Unmarshal([]byte(lines[i]), &rec); err != nil {
			t.Fatalf("line %d not JSON: %v", i, err)
		}
		if rec.SessionID != want {
			t.Errorf("line %d sessionId = %q, want %q", i, rec.SessionID, want)
		}
	}
	if lines[2] != rows[2] || lines[3] != rows[3] {
		t.Errorf("rows the fork does not name were rewritten:\n%s\n%s", lines[2], lines[3])
	}
}

// The fork id is a version-5 UUID of the original under importForkNamespace, which the control
// plane derives too (apiserver sessions/import-fork.ts pins the same vectors). These were computed
// with Python's uuid.uuid5, the reference both are checked against.
func TestImportForkSessionIDIsTheSharedUUIDv5(t *testing.T) {
	for original, want := range map[string]string{
		"0d8c31b9-db03-4aa7-8e3d-11fb96358552": "65e78295-ae77-576c-86dc-427eaeceb83e",
		"4e453ab7-f37c-494d-8017-bb4e9beffeef": "59373f01-c835-536d-9fba-7095cf012000",
		"4E453AB7-F37C-494D-8017-BB4E9BEFFEEF": "59373f01-c835-536d-9fba-7095cf012000",
	} {
		if got := importForkSessionID(original); got != want {
			t.Errorf("importForkSessionID(%s) = %s, want %s", original, got, want)
		}
	}
}

// When the place --resume reads for the imported session is the transcript itself, which is what a
// workspace with no worktree, in the directory the conversation was recorded in, on the terminal's
// own Claude config, comes to, the import forks: the original is left exactly as it was, and the
// session resumes a copy under its own Claude session id once the control plane has taken it. On
// 2026-11-06 an import there rewrote the original in place, and the person's terminal then kept
// writing the file the Orbit session would resume.
func TestRunTranscriptImportForksATranscriptItWouldShare(t *testing.T) {
	const uuid = "4e453ab7-f37c-494d-8017-bb4e9beffeef"
	fork := importForkSessionID(uuid)
	run := func(t *testing.T, answer string) (job *ClaimedSession, posted ImportResultRequest, original, placed string, before []byte) {
		t.Helper()
		home := t.TempDir()
		t.Setenv("HOME", home)
		t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude"))
		workDir := filepath.Join(home, "proj")
		if err := os.MkdirAll(workDir, 0o755); err != nil {
			t.Fatal(err)
		}

		var tr importTestTranscript
		tr.add(importMsgRow("user", workDir, "2026-09-15T10:00:01Z", map[string]interface{}{"type": "text", "text": "<hi> & bye"}))
		tr.add(importMsgRow("assistant", workDir, "2026-09-15T10:00:02Z", map[string]interface{}{"type": "text", "text": "hello"}))
		projects := filepath.Join(home, ".claude", "projects", claudeProjectSlug(workDir))
		if err := os.MkdirAll(projects, 0o755); err != nil {
			t.Fatal(err)
		}
		original = filepath.Join(projects, uuid+".jsonl")
		tr.write(t, original)
		if err := os.Chmod(original, 0o600); err != nil {
			t.Fatal(err)
		}
		var err error
		if before, err = os.ReadFile(original); err != nil {
			t.Fatal(err)
		}
		placed = filepath.Join(projects, fork+".jsonl")

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if err := json.NewDecoder(r.Body).Decode(&posted); err != nil {
				t.Errorf("decoding the import result: %v", err)
			}
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(answer))
		}))
		defer srv.Close()

		marker := workDir
		job = &ClaimedSession{SessionID: "s1", SessionUUID: uuid, WorkDir: workDir, ImportSourceCwd: &marker}
		emit := func(string, map[string]interface{}) {}
		transport := &Transport{baseURL: srv.URL, client: srv.Client()}
		// No worktree: the session runs in the workspace directory itself.
		if err := runTranscriptImport(context.Background(), transport, job, workDir, emit, func(context.Context) error { return nil }); err != nil {
			t.Fatalf("runTranscriptImport: %v", err)
		}
		return job, posted, original, placed, before
	}
	assertOriginalUntouched := func(t *testing.T, original string, before []byte) {
		t.Helper()
		after, err := os.ReadFile(original)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(after, before) {
			t.Errorf("the original transcript was written:\nbefore %s\nafter  %s", before, after)
		}
		if info, err := os.Stat(original); err != nil || info.Mode().Perm() != 0o600 {
			t.Errorf("the original's mode changed: %v %v", info.Mode(), err)
		}
	}

	t.Run("the control plane takes the fork", func(t *testing.T) {
		job, posted, original, placed, before := run(t, `{"ok":true,"applied":true,"runtimeSessionId":"`+fork+`"}`)
		if !posted.Ok || !posted.Forked {
			t.Errorf("import result = %+v, want an ok that says it forked", posted)
		}
		assertOriginalUntouched(t, original, before)
		copied, err := os.ReadFile(placed)
		if err != nil {
			t.Fatalf("no fork where --resume %s reads: %v", fork, err)
		}
		if strings.Contains(string(copied), uuid) || !strings.Contains(string(copied), fork) {
			t.Errorf("the fork still names the original conversation: %s", copied)
		}
		if info, err := os.Stat(placed); err != nil || info.Mode().Perm() != 0o600 {
			t.Errorf("the fork's mode is not the original's: %v %v", info.Mode(), err)
		}
		if job.SessionUUID != fork {
			t.Errorf("the session resumes %s, want the fork %s", job.SessionUUID, fork)
		}
	})

	t.Run("a control plane that predates forks keeps the transcript where it is", func(t *testing.T) {
		job, posted, original, placed, before := run(t, `{"ok":true,"applied":true}`)
		if !posted.Forked {
			t.Errorf("import result = %+v, want the fork asked for", posted)
		}
		assertOriginalUntouched(t, original, before)
		if _, err := os.Stat(placed); !os.IsNotExist(err) {
			t.Errorf("the fork nothing resumes was left in the terminal's history: %v", err)
		}
		if job.SessionUUID != uuid {
			t.Errorf("the session resumes %s, want the original %s", job.SessionUUID, uuid)
		}
	})
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

// A screenshot a tool returned is base64 in the transcript, hundreds of kilobytes of it, and a long
// conversation replayed with them was too large to store. The events leave every image and document
// out, with a note where each was, and keep the text around them; the replay self-check holds.
func TestParseImportTranscriptLeavesImagesOut(t *testing.T) {
	const png, pdf = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "JVBERi0xLjQKJcfsj6IKNSAwIG9iago"
	var tr importTestTranscript
	tr.add(importMsgRow("user", "/ws", "2026-09-15T10:00:00Z", map[string]interface{}{"type": "text", "text": "what does the page look like"}))
	tr.add(importMsgRow("assistant", "/ws", "2026-09-15T10:00:01Z",
		map[string]interface{}{"type": "tool_use", "id": "t1", "name": "Read", "input": map[string]interface{}{"file_path": "/ws/shot.png"}},
		map[string]interface{}{"type": "tool_use", "id": "t2", "name": "Read", "input": map[string]interface{}{"file_path": "/ws/spec.pdf"}},
		map[string]interface{}{"type": "tool_use", "id": "t3", "name": "Bash", "input": map[string]interface{}{"command": "ls"}},
	))
	tr.add(importMsgRow("user", "/ws", "2026-09-15T10:00:02Z",
		map[string]interface{}{"type": "tool_result", "tool_use_id": "t1", "content": []interface{}{
			map[string]interface{}{"type": "image", "source": map[string]interface{}{"type": "base64", "media_type": "image/png", "data": png}},
		}},
		map[string]interface{}{"type": "tool_result", "tool_use_id": "t2", "content": []interface{}{
			map[string]interface{}{"type": "text", "text": "Page 1 of 3"},
			map[string]interface{}{"type": "document", "source": map[string]interface{}{"type": "base64", "media_type": "application/pdf", "data": pdf}},
		}},
		map[string]interface{}{"type": "tool_result", "tool_use_id": "t3", "content": "shot.png spec.pdf"},
	))
	tr.add(importMsgRow("assistant", "/ws", "2026-09-15T10:00:03Z", map[string]interface{}{"type": "text", "text": "a login form"}))

	events := mustParseEvents(t, writeImportFixture(t, &tr))
	got := map[string]interface{}{}
	for _, e := range events {
		if e.Type == evToolResult {
			got[asString(e.Payload["toolUseId"])] = e.Payload["content"]
		}
	}
	want := map[string]interface{}{
		"t1": []interface{}{map[string]interface{}{"type": "text", "text": "[image not imported]"}},
		"t2": []interface{}{
			map[string]interface{}{"type": "text", "text": "Page 1 of 3"},
			map[string]interface{}{"type": "text", "text": "[document not imported]"},
		},
		"t3": "shot.png spec.pdf",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("tool results stored as %v, want %v", got, want)
	}
	if raw := dumpEvents(events); strings.Contains(raw, png) || strings.Contains(raw, pdf) {
		t.Errorf("the events still carry base64: %s", raw)
	}
}

// A record too large for a request of its own would refuse the whole import, so any record past
// importEventMaxBytes is clipped: it keeps how it starts and every short field, and the replay
// self-check still holds, both sides reading the record as stored.
func TestParseImportTranscriptClipsAnOversizedRecord(t *testing.T) {
	huge := strings.Repeat("0123456789abcdef", (3<<20)/16)
	var tr importTestTranscript
	tr.add(importMsgRow("user", "/ws", "2026-09-15T10:00:00Z", map[string]interface{}{"type": "text", "text": "here is the log: " + huge}))
	tr.add(importMsgRow("assistant", "/ws", "2026-09-15T10:00:01Z", map[string]interface{}{
		"type": "tool_use", "id": "t1", "name": "Write", "input": map[string]interface{}{"file_path": "/ws/log.txt", "content": huge},
	}))
	tr.add(importMsgRow("user", "/ws", "2026-09-15T10:00:02Z", map[string]interface{}{"type": "tool_result", "tool_use_id": "t1", "content": huge}))
	tr.add(importMsgRow("assistant", "/ws", "2026-09-15T10:00:03Z", map[string]interface{}{"type": "text", "text": "saved"}))

	events := mustParseEvents(t, writeImportFixture(t, &tr))
	if len(events) != 4 {
		t.Fatalf("parsed %d events, want 4: %v", len(events), dumpEvents(events))
	}
	clipped := func(what string, v interface{}, prefix string) {
		t.Helper()
		s := asString(v)
		if n := jsonLen(s); n > importEventMaxBytes {
			t.Errorf("%s stored as %d bytes, over the %d one record may take", what, n, importEventMaxBytes)
		}
		if !strings.HasPrefix(s, prefix+"0123456789abcdef") || !strings.HasSuffix(s, "…") {
			t.Errorf("%s stored as %.40q…%q, want how it starts, marked as clipped", what, s, s[max(0, len(s)-8):])
		}
	}
	clipped("the user's text", events[0].Payload["text"], "here is the log: ")
	input, _ := events[1].Payload["input"].(map[string]interface{})
	if input["file_path"] != "/ws/log.txt" {
		t.Errorf("the Write's file_path stored as %v, want it whole", input["file_path"])
	}
	clipped("the Write's content", input["content"], "")
	clipped("the tool result", events[2].Payload["content"], "")
	if events[3].Payload["text"] != "saved" {
		t.Errorf("a short record stored as %v, want it as written", events[3].Payload["text"])
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
	_, _, events, err := parseImportTranscript(path, nil)
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
		if posted.Forked {
			t.Errorf("import result = %+v: a copy in the session's own checkout is no fork", posted)
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

// Claude Code now and then runs two writes together on one transcript line. That one line used to
// refuse the whole conversation, and the imported session went to Trash with "holds a line that is
// not JSON". The line is skipped now, before either side of the replay self-check reads it: every
// record before and after it imports, and the copy --resume reads still holds it as it was.
func TestImportSkipsACorruptLine(t *testing.T) {
	const (
		uuid  = "4e453ab7-f37c-494d-8017-bb4e9beffeef"
		title = "Ship the build"
		t1    = "2026-09-15T10:00:01Z"
		t2    = "2026-09-15T10:00:02Z"
		t3    = "2026-09-15T10:00:03Z"
		t5    = "2026-09-15T10:00:05Z"
		t6    = "2026-09-15T10:00:06Z"
		t7    = "2026-09-15T10:00:07Z"
		// As one was found on a runner host: a hook record cut off mid-key, the next record (an
		// assistant message) run straight onto it.
		corrupt = `{"type":"attachment","attachment":{"type":"hook_success","hookName":"PreToolUse:Bash"},"uui` +
			`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Running the build."}]},"timestamp":"2026-09-15T10:00:04Z"}`
	)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude"))
	work := filepath.Join(home, "proj")

	var tr importTestTranscript
	tr.add(map[string]interface{}{"type": "ai-title", "aiTitle": title, "timestamp": "2026-09-15T10:00:00Z"})
	tr.add(importMsgRow("user", work, t1, map[string]interface{}{"type": "text", "text": "check the build"}))
	tr.add(importMsgRow("assistant", work, t2, map[string]interface{}{
		"type": "tool_use", "id": "t1", "name": "Bash", "input": map[string]interface{}{"command": "make"},
	}))
	tr.add(importMsgRow("user", work, t3, map[string]interface{}{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}))
	tr.lines = append(tr.lines, corrupt) // line 5
	tr.add(importMsgRow("assistant", work, t5, map[string]interface{}{"type": "text", "text": "The build passes."}))
	tr.add(importMsgRow("user", work, t6, map[string]interface{}{"type": "text", "text": "ship it"}))
	tr.add(importMsgRow("assistant", work, t7, map[string]interface{}{"type": "text", "text": "Shipped."}))
	src := filepath.Join(home, ".claude", "projects", claudeProjectSlug(work), uuid+".jsonl")
	if err := os.MkdirAll(filepath.Dir(src), 0o755); err != nil {
		t.Fatal(err)
	}
	tr.write(t, src)
	// Nothing of line 5, not even its timestamp: the reply after it is stamped with its own.
	want := []StoredEvent{
		{Seq: 1, Type: evUser, Payload: map[string]interface{}{"text": "check the build"}, Ts: mustParseTs(t, t1)},
		{Seq: 2, Type: evToolUse, Payload: map[string]interface{}{"id": "t1", "name": "Bash", "input": map[string]interface{}{"command": "make"}}, Ts: mustParseTs(t, t2)},
		{Seq: 3, Type: evToolResult, Payload: map[string]interface{}{"toolUseId": "t1", "content": "ok", "isError": false}, Ts: mustParseTs(t, t3)},
		{Seq: 4, Type: evAssistant, Payload: map[string]interface{}{"text": "The build passes."}, Ts: mustParseTs(t, t5)},
		{Seq: 5, Type: evUser, Payload: map[string]interface{}{"text": "ship it"}, Ts: mustParseTs(t, t6)},
		{Seq: 6, Type: evAssistant, Payload: map[string]interface{}{"text": "Shipped."}, Ts: mustParseTs(t, t7)},
	}

	t.Run("the parse skips that line and keeps the rest", func(t *testing.T) {
		var skipped []int
		cwd, gotTitle, events, err := parseImportTranscript(src, func(line int) { skipped = append(skipped, line) })
		if err != nil {
			t.Fatalf("parseImportTranscript: %v", err)
		}
		if !reflect.DeepEqual(skipped, []int{5}) {
			t.Errorf("skipped lines %v, want [5]", skipped)
		}
		if cwd != work || gotTitle != title {
			t.Errorf("cwd, title = %q, %q, want %q, %q", cwd, gotTitle, work, title)
		}
		if !reflect.DeepEqual(events, want) {
			t.Errorf("events mismatch:\n got %s\nwant %s", dumpEvents(events), dumpEvents(want))
		}
	})

	t.Run("the import step stores the conversation", func(t *testing.T) {
		var posted ImportResultRequest
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if err := json.NewDecoder(r.Body).Decode(&posted); err != nil {
				t.Errorf("decoding the import result: %v", err)
			}
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true,"applied":true}`))
		}))
		defer srv.Close()

		job := &ClaimedSession{SessionID: "s1", SessionUUID: uuid, WorkDir: work, ImportSourceCwd: &work}
		var events []StoredEvent
		emit := func(eventType string, payload map[string]interface{}) {
			events = append(events, StoredEvent{Type: eventType, Payload: payload})
		}
		execDir := t.TempDir()
		transport := &Transport{baseURL: srv.URL, client: srv.Client()}
		if err := runTranscriptImport(context.Background(), transport, job, execDir, emit, func(context.Context) error { return nil }); err != nil {
			t.Fatalf("runTranscriptImport: %v", err)
		}
		if !posted.Ok || posted.Title != title {
			t.Errorf("import result = %+v, want ok with the transcript's title", posted)
		}
		if len(events) != len(want) {
			t.Fatalf("replayed %s, want %s", dumpEvents(events), dumpEvents(want))
		}
		for i := range want {
			if events[i].Type != want[i].Type || !reflect.DeepEqual(events[i].Payload, want[i].Payload) {
				t.Errorf("event %d = %s %v, want %s %v", i+1, events[i].Type, events[i].Payload, want[i].Type, want[i].Payload)
			}
		}
		dst, err := claudeTranscriptPathIn(filepath.Join(home, ".claude"), execDir, uuid)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := os.ReadFile(dst)
		if err != nil {
			t.Fatalf("the copy --resume reads: %v", err)
		}
		if !strings.Contains(string(raw), "\n"+corrupt+"\n") {
			t.Errorf("the copy --resume reads does not hold line 5 as it was:\n%s", raw)
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
