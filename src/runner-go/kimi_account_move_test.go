package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// The session id and working directory the fixtures below are written for, as Kimi Code 2.1.1 named
// them in a throwaway home (2026-10-08): a session made by `kimi acp` in /tmp/kimi-probe-420ea6/run/work
// went to sessions/wd_work_efe2cf4c3e2c/session_cb58dff9-d359-4dd8-850a-198af33eb43e.
const (
	kimiTestSessionID = "session_cb58dff9-d359-4dd8-850a-198af33eb43e"
	kimiTestWorkDir   = "/tmp/kimi-probe-420ea6/run/work"
)

var kimiWorkDirSlugJunk = regexp.MustCompile(`[^a-z0-9._-]+`)

// kimiWorkDirKey is Kimi's encodeWorkDirKey (agent-core-v2 workdir-slug.ts): the bucket a session's
// directory is made in under sessions/, "wd_" + its working directory's name slugged (lowercase, runs
// of anything else as "-", dashes trimmed, 40 characters at most, "workspace" when nothing is left) +
// "_" + the first 12 hex of the sha-256 of the whole path.
func kimiWorkDirKey(workDir string) string {
	normalized := strings.TrimRight(strings.ReplaceAll(workDir, `\`, "/"), "/")
	slug := strings.Trim(kimiWorkDirSlugJunk.ReplaceAllString(strings.ToLower(normalized[strings.LastIndex(normalized, "/")+1:]), "-"), "-")
	if len(slug) > 40 {
		slug = strings.Trim(slug[:40], "-")
	}
	if slug == "" || slug == "." || slug == ".." {
		slug = "workspace"
	}
	sum := sha256.Sum256([]byte(normalized))
	return "wd_" + slug + "_" + hex.EncodeToString(sum[:])[:12]
}

// The fixtures name their buckets the way Kimi does: every directory below got the bucket beside it
// from the real kimi 2.1.1.
func TestKimiWorkDirKeyIsKimisOwn(t *testing.T) {
	for workDir, want := range map[string]string{
		kimiTestWorkDir: "wd_work_efe2cf4c3e2c",
		"/tmp/kimi-probe-420ea6/run/dirs/My Repo.v2!":                                                      "wd_my-repo.v2_051b7d218cf0",
		"/tmp/kimi-probe-420ea6/run/dirs/----":                                                             "wd_workspace_e7ae3b307420",
		"/tmp/kimi-probe-420ea6/run/dirs/中文目录":                                                             "wd_workspace_5078dcdc44f4",
		"/tmp/kimi-probe-420ea6/run/dirs/A_very-Long.Directory_Name_That_Keeps_Going_Past_Forty_Chars_Yes": "wd_a_very-long.directory_name_that_keeps_go_aecd23a578f4",
	} {
		if got := kimiWorkDirKey(workDir); got != want {
			t.Errorf("kimiWorkDirKey(%q) = %q, want %q", workDir, got, want)
		}
	}
}

// kimiTestTurn is one exchange of a conversation: what was said, and the reply.
type kimiTestTurn struct{ said, reply string }

// putKimiSession writes session id's directory into home as Kimi Code 2.1.x writes it for a session in
// workDir — state.json, the main agent's wire, a sub-agent's, the session's log and its notify state —
// holding turns, the first said at start and each a minute after the one before. Its records are the
// ones kimi 2.1.1 wrote for a turn, with their fields. It returns the directory.
func putKimiSession(t *testing.T, home, workDir, id string, start time.Time, turns ...kimiTestTurn) string {
	t.Helper()
	dir := filepath.Join(home, "sessions", kimiWorkDirKey(workDir), id)
	// Kimi's modes: its directories private but logs/, its files private but the log.
	for _, sub := range []string{"agents/main", "agents/agent-explore-1", "notify", "logs"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chmod(filepath.Join(dir, "logs"), 0o755); err != nil {
		t.Fatal(err)
	}
	created := start.Add(-time.Second).UnixMilli()
	head := []map[string]interface{}{
		{"type": "metadata", "protocol_version": "1.5", "created_at": created},
		{"type": "runtime.set_binding", "workspaceId": kimiWorkDirKey(workDir), "runtimeId": "local", "agentId": "main", "time": created + 7},
		{"type": "runtime.set_binding", "workspaceId": kimiWorkDirKey(workDir), "runtimeId": "acp:" + id, "agentId": "main", "time": created + 26},
	}
	writeKimiWire(t, filepath.Join(dir, "agents", "main", "wire.jsonl"), head, false)
	writeKimiWire(t, filepath.Join(dir, "agents", "agent-explore-1", "wire.jsonl"), []map[string]interface{}{
		{"type": "metadata", "protocol_version": "1.5", "created_at": created + 40},
	}, false)
	putKimiFile(t, filepath.Join(dir, "notify", "state.json"), []byte(`{"enabled":false}`), 0o600)
	putKimiFile(t, filepath.Join(dir, "logs", "kimi-code.log"), []byte("session started\n"), 0o644)
	writeKimiState(t, dir, workDir, id, created, created)
	continueKimiSession(t, dir, start, turns...)
	return dir
}

// continueKimiSession appends turns to the conversation in dir — the records Kimi writes for each, the
// first said at start and each a minute after the one before — and moves its state.json on with them,
// as the account the session runs on does when it answers.
func continueKimiSession(t *testing.T, dir string, start time.Time, turns ...kimiTestTurn) {
	t.Helper()
	wire := filepath.Join(dir, "agents", "main", "wire.jsonl")
	next := len(kimiTestTurnsIn(t, dir))
	var records []map[string]interface{}
	var at int64
	for i, turn := range turns {
		at = start.Add(time.Duration(i) * time.Minute).UnixMilli()
		turnID := next + i
		promptID := fmt.Sprintf("msg_%02dTEST", turnID)
		user := []map[string]interface{}{{"type": "text", "text": turn.said}}
		records = append(records,
			map[string]interface{}{"type": "turn.prompt", "agentId": "main", "input": user, "origin": map[string]interface{}{"kind": "user"}, "promptId": promptID, "turnId": turnID, "time": at},
			map[string]interface{}{"type": "context.append_message", "agentId": "main", "message": map[string]interface{}{"role": "user", "content": user, "id": promptID, "toolCalls": []interface{}{}, "origin": map[string]interface{}{"kind": "user"}}, "time": at + 1},
			map[string]interface{}{"turnId": turnID, "queueItemId": promptID, "type": "agent.turn.started", "time": at + 2, "kind": "event"},
			map[string]interface{}{"type": "context.append_loop_event", "agentId": "main", "event": map[string]interface{}{"type": "content.part", "turnId": fmt.Sprint(turnID), "step": 1, "part": map[string]interface{}{"type": "text", "text": turn.reply}}, "time": at + 40},
			map[string]interface{}{"message": map[string]interface{}{"message": map[string]interface{}{"role": "assistant", "content": []map[string]interface{}{{"type": "text", "text": turn.reply}}, "toolCalls": []interface{}{}}}, "type": "agent.message.appended", "time": at + 41, "kind": "event"},
			map[string]interface{}{"type": "turn.ended", "agentId": "main", "turnId": turnID, "reason": "completed", "durationMs": 58, "time": at + 43},
			map[string]interface{}{"type": "prompt.completed", "agentId": "main", "promptId": promptID, "finishedAt": time.UnixMilli(at + 44).UTC().Format("2006-01-02T15:04:05.000Z"), "reason": "completed", "time": at + 44},
		)
	}
	writeKimiWire(t, wire, records, true)
	var state map[string]interface{}
	if err := json.Unmarshal([]byte(readFile(t, filepath.Join(dir, "state.json"))), &state); err != nil {
		t.Fatal(err)
	}
	if len(turns) > 0 {
		state["updatedAt"] = at + 44
		state["lastPrompt"] = turns[len(turns)-1].said
		state["lastTurnReason"] = "completed"
		if state["title"] == "New Session" {
			state["title"] = turns[0].said
		}
	}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	putKimiFile(t, filepath.Join(dir, "state.json"), data, 0o600)
}

func putKimiFile(t *testing.T, path string, data []byte, perm fs.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, data, perm); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, perm); err != nil {
		t.Fatal(err)
	}
}

func writeKimiState(t *testing.T, dir, workDir, id string, created, updated int64) {
	t.Helper()
	data, err := json.Marshal(map[string]interface{}{
		"id": id, "version": 2, "cwd": workDir, "createdAt": created, "updatedAt": updated, "archived": false,
		"agents": map[string]interface{}{
			"main":            map[string]interface{}{"homedir": filepath.Join(dir, "agents", "main"), "type": "main"},
			"agent-explore-1": map[string]interface{}{"homedir": filepath.Join(dir, "agents", "agent-explore-1"), "type": "sub", "parentAgentId": "main"},
		},
		"custom": map[string]interface{}{}, "title": "New Session", "titleKind": "replaceable", "isCustomTitle": false,
	})
	if err != nil {
		t.Fatal(err)
	}
	putKimiFile(t, filepath.Join(dir, "state.json"), data, 0o600)
}

func writeKimiWire(t *testing.T, path string, records []map[string]interface{}, appendTo bool) {
	t.Helper()
	flags := os.O_WRONLY | os.O_CREATE | os.O_TRUNC
	if appendTo {
		flags = os.O_WRONLY | os.O_CREATE | os.O_APPEND
	}
	f, err := os.OpenFile(path, flags, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for _, record := range records {
		line, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write(append(line, '\n')); err != nil {
			t.Fatal(err)
		}
	}
}

// kimiTestTurnsIn is what was said in the conversation in dir, turn by turn, read from its main
// agent's wire as Kimi replays it: each turn.prompt's text.
func kimiTestTurnsIn(t *testing.T, dir string) []string {
	t.Helper()
	f, err := os.Open(filepath.Join(dir, "agents", "main", "wire.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var said []string
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1<<20), 1<<24)
	for scanner.Scan() {
		var rec struct {
			Type  string `json:"type"`
			Input []struct {
				Text string `json:"text"`
			} `json:"input"`
		}
		if json.Unmarshal(scanner.Bytes(), &rec) == nil && rec.Type == "turn.prompt" && len(rec.Input) > 0 {
			said = append(said, rec.Input[0].Text)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return said
}

// kimiTreeContents is every entry under dir by its path relative to dir: a directory's mode, a file's
// mode and digest — what "the same copy" means between two accounts, whose files were written at
// different times.
func kimiTreeContents(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, path)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.IsDir() {
			out[rel] = info.Mode().String()
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		out[rel] = info.Mode().String() + " " + hex.EncodeToString(sum[:])
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// kimiIndexLines is home's session_index.jsonl, a line at a time.
func kimiIndexLines(t *testing.T, home string) []kimiSessionIndexEntry {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(home, "session_index.jsonl"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var lines []kimiSessionIndexEntry
	for _, line := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
		var entry kimiSessionIndexEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatalf("session_index.jsonl line %q: %v", line, err)
		}
		lines = append(lines, entry)
	}
	return lines
}

// kimiHomeState is what a carry into home may change: everything under its sessions/ as
// kimiTreeSnapshot sees it, and its other entries by name, mode and content — not the times of home
// itself, which the carry's staging directory moves even when it fails.
func kimiHomeState(t *testing.T, home string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for rel, entry := range kimiTreeSnapshot(t, filepath.Join(home, "sessions")) {
		out[filepath.Join("sessions", rel)] = entry
	}
	entries, err := os.ReadDir(home)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() == "sessions" {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			t.Fatal(err)
		}
		digest := ""
		if info.Mode().IsRegular() {
			sum := sha256.Sum256([]byte(readFile(t, filepath.Join(home, entry.Name()))))
			digest = hex.EncodeToString(sum[:])
		}
		out[entry.Name()] = info.Mode().String() + " " + digest
	}
	return out
}

// assertNoKimiCarryLeftovers fails when a carry left its staging directory in home, or anything under
// sessions/ that Kimi would list as a session but is not one.
func assertNoKimiCarryLeftovers(t *testing.T, home string) {
	t.Helper()
	if stages, _ := filepath.Glob(filepath.Join(home, ".orbit-kimi-carry-*")); len(stages) > 0 {
		t.Fatalf("the carry left its staging behind: %v", stages)
	}
	buckets, _ := os.ReadDir(filepath.Join(home, "sessions"))
	for _, bucket := range buckets {
		if strings.HasPrefix(bucket.Name(), ".") {
			continue
		}
		ids, _ := os.ReadDir(filepath.Join(home, "sessions", bucket.Name()))
		for _, id := range ids {
			if kimiSessionStatePath(filepath.Join(home, "sessions", bucket.Name(), id.Name())) == "" {
				t.Fatalf("sessions/%s/%s is no session Kimi can read", bucket.Name(), id.Name())
			}
		}
	}
}

// kimiMoveTestHomes is kimiAccountTestHomes with Work added beside Default, each readied the way a
// session's run readies the account it is about to run on before anything is carried into it
// (ensureKimiHomeStores, which makes Default's home where it is missing).
func kimiMoveTestHomes(t *testing.T) (string, accountSlot) {
	t.Helper()
	defaultHome, _ := kimiAccountTestHomes(t)
	work, err := kimiAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	for _, home := range []string{defaultHome, work.Dir} {
		if err := ensureKimiHomeStores(home); err != nil {
			t.Fatal(err)
		}
	}
	return defaultHome, work
}

// A Kimi session moved to another of this machine's accounts finds its conversation there before it
// resumes: the whole of sessions/<bucket>/<id> — the main agent's wire, a sub-agent's, the log — is
// copied from the account that ran it, where Kimi looks a session up by id, and the account it came
// from keeps its copy. The home it went to gains the session's index line, naming the directory in that
// home; it had no workspaces.json, and is not given one (Kimi builds it from the index). A conversation
// no account holds is not carried.
func TestKimiConversationFollowsASessionToAnotherAccount(t *testing.T) {
	defaultHome, work := kimiMoveTestHomes(t)
	start := time.Now().Add(-3 * time.Hour)
	onDefault := putKimiSession(t, defaultHome, kimiTestWorkDir, kimiTestSessionID, start,
		kimiTestTurn{"rename the widget", "renamed it"}, kimiTestTurn{"and the gadget", "gadget renamed"})
	leftOnDefault := kimiTreeContents(t, onDefault)
	defaultBefore := kimiTreeSnapshot(t, defaultHome)

	carried, err := carryKimiConversation(work.Dir, kimiTestSessionID)
	if err != nil || !carried {
		t.Fatalf("carry = %v, %v; want the conversation carried to Work", carried, err)
	}
	found := kimiSessionDirIn(work.Dir, kimiTestSessionID)
	want := filepath.Join(work.Dir, "sessions", kimiWorkDirKey(kimiTestWorkDir), kimiTestSessionID)
	if found != want {
		t.Fatalf("looked up by id on Work: %q, want %q", found, want)
	}
	if got := kimiTreeContents(t, found); !reflect.DeepEqual(got, leftOnDefault) {
		t.Fatalf("the copy on Work is not the conversation on Default:\n got %v\nwant %v", got, leftOnDefault)
	}
	if said := kimiTestTurnsIn(t, found); !reflect.DeepEqual(said, []string{"rename the widget", "and the gadget"}) {
		t.Fatalf("turns on Work = %q", said)
	}
	wantLine := kimiSessionIndexEntry{SessionID: kimiTestSessionID, SessionDir: want, WorkDir: kimiTestWorkDir}
	if lines := kimiIndexLines(t, work.Dir); !reflect.DeepEqual(lines, []kimiSessionIndexEntry{wantLine}) {
		t.Fatalf("Work's session_index.jsonl = %+v, want %+v", lines, wantLine)
	}
	if info, err := os.Stat(filepath.Join(work.Dir, "session_index.jsonl")); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("Work's session_index.jsonl: %v, %v; want it private", info, err)
	}
	if _, err := os.Stat(filepath.Join(work.Dir, "workspaces.json")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("Work was given a workspaces.json it did not keep (err %v)", err)
	}
	if marks, _ := filepath.Glob(filepath.Join(work.Dir, "sessions", ".index-dirty", kimiTestSessionID+".*")); len(marks) != 1 {
		t.Fatalf("dirty marks on Work = %v, want one for the carried session", marks)
	}
	assertNoKimiCarryLeftovers(t, work.Dir)
	if after := kimiTreeSnapshot(t, defaultHome); !reflect.DeepEqual(after, defaultBefore) {
		t.Fatalf("carrying the conversation away changed Default:\nbefore %v\nafter  %v", defaultBefore, after)
	}

	// Nobody holds this one: nothing is carried, and Work's sessions are as they were.
	carried, err = carryKimiConversation(work.Dir, "session_00000000-0000-4000-8000-000000000000")
	if err != nil || carried {
		t.Fatalf("a conversation no account holds: carried = %v, %v", carried, err)
	}
}

// Switched from one account to the other and back, twice, a session resumes everything it said on
// both: each time, the account it lands on is handed the copy from the account it left, whose last
// turns are later than the copy it left behind there — so the copy it left is replaced, never resumed.
// Neither account loses its copy, and the index line is written once per account however often the
// session comes back.
func TestKimiConversationMovedBackAndForthKeepsEveryTurn(t *testing.T) {
	defaultHome, work := kimiMoveTestHomes(t)
	start := time.Now().Add(-10 * time.Hour)
	said := []string{"rename the widget", "and the gadget"}
	onWork := putKimiSession(t, work.Dir, kimiTestWorkDir, kimiTestSessionID, start,
		kimiTestTurn{said[0], "renamed it"}, kimiTestTurn{said[1], "gadget renamed"})

	// resumeOn carries the conversation to home and goes on there for two more turns, an hour later
	// than whatever was said before.
	resumeOn := func(home string, turns ...string) string {
		t.Helper()
		if carried, err := carryKimiConversation(home, kimiTestSessionID); err != nil || !carried {
			t.Fatalf("carry to %s = %v, %v", home, carried, err)
		}
		dir := kimiSessionDirIn(home, kimiTestSessionID)
		if got := kimiTestTurnsIn(t, dir); !reflect.DeepEqual(got, said) {
			t.Fatalf("resumed on %s with %q, want every turn said so far: %q", home, got, said)
		}
		start = start.Add(time.Hour)
		for _, turn := range turns {
			continueKimiSession(t, dir, start, kimiTestTurn{turn, "done: " + turn})
			start = start.Add(time.Minute)
			said = append(said, turn)
		}
		return dir
	}
	onDefault := resumeOn(defaultHome, "now the sprocket", "and the cog")
	resumeOn(work.Dir, "back on Work: the flange")
	resumeOn(defaultHome, "Default again: the bolt")
	resumeOn(work.Dir)

	if got := kimiTestTurnsIn(t, onWork); !reflect.DeepEqual(got, said) {
		t.Fatalf("Work's copy at the end = %q, want %q", got, said)
	}
	if got := kimiTestTurnsIn(t, onDefault); !reflect.DeepEqual(got, said) {
		t.Fatalf("Default's copy at the end = %q, want %q", got, said)
	}
	for _, home := range []string{defaultHome, work.Dir} {
		want := []kimiSessionIndexEntry{{SessionID: kimiTestSessionID, SessionDir: kimiSessionDirIn(home, kimiTestSessionID), WorkDir: kimiTestWorkDir}}
		if lines := kimiIndexLines(t, home); !reflect.DeepEqual(lines, want) {
			t.Fatalf("%s's session_index.jsonl after four moves = %+v, want %+v", home, lines, want)
		}
		assertNoKimiCarryLeftovers(t, home)
	}
}

// The copy on the account a session resumes on is replaced only by a newer one: it stays when it is
// the newest any account holds — the only one, the same as another account's, or ahead of it — and is
// not rewritten; with none there, the newest other account's is carried, of several. Newer is read
// from the copies — their records' updatedAt and their wires' last stamps — not from when their files
// were written: a copy left behind is replaced however recently its files were touched, and one whose
// last turn was cut short before its state.json caught up still counts that turn.
func TestKimiConversationOnTheResumingAccountIsReplacedOnlyByANewerOne(t *testing.T) {
	start := time.Now().Add(-10 * time.Hour)
	behind := []kimiTestTurn{{"rename the widget", "renamed it"}}
	ahead := append(append([]kimiTestTurn(nil), behind...), kimiTestTurn{"and the gadget", "gadget renamed"})
	type copyOf struct {
		turns []kimiTestTurn // nil: that account holds no copy
		// cutShort ends the copy in a turn its engine was stopped in the middle of: its records are in
		// the wire, an hour after the copy's last turn, and its state.json never caught up with them.
		cutShort bool
	}
	for _, tc := range []struct {
		name              string
		here, work, other copyOf
		want              int // turns in the copy here afterwards
		wantCarried       bool
	}{
		{name: "no copy here", work: copyOf{turns: ahead}, want: 2, wantCarried: true},
		{name: "only a copy here", here: copyOf{turns: ahead}, want: 2},
		{name: "the same copy on both", here: copyOf{turns: ahead}, work: copyOf{turns: ahead}, want: 2},
		{name: "the copy here is ahead", here: copyOf{turns: ahead}, work: copyOf{turns: behind}, want: 2},
		{name: "the copy here is behind", here: copyOf{turns: behind}, work: copyOf{turns: ahead}, want: 2, wantCarried: true},
		// The record of the two copies says the same; the wire of the other has a turn more.
		{name: "the other copy ends in a turn cut short", here: copyOf{turns: ahead}, work: copyOf{turns: ahead, cutShort: true}, want: 3, wantCarried: true},
		{name: "the copy here ends in a turn cut short", here: copyOf{turns: ahead, cutShort: true}, work: copyOf{turns: ahead}, want: 3},
		{name: "the newest of two other accounts", work: copyOf{turns: behind}, other: copyOf{turns: ahead}, want: 2, wantCarried: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			defaultHome, work := kimiMoveTestHomes(t)
			other, err := kimiAccountKind.create("Other")
			if err != nil {
				t.Fatal(err)
			}
			put := func(home string, c copyOf) {
				if c.turns == nil {
					return
				}
				dir := putKimiSession(t, home, kimiTestWorkDir, kimiTestSessionID, start, c.turns...)
				if c.cutShort {
					state := readFile(t, filepath.Join(dir, "state.json"))
					continueKimiSession(t, dir, start.Add(time.Hour), kimiTestTurn{"half a turn", "…"})
					putKimiFile(t, filepath.Join(dir, "state.json"), []byte(state), 0o600)
				}
				// Whatever the account's copy holds, its files were written just now — a carry, a copy
				// by hand, anything: only what they hold may decide which is newer.
				now := time.Now()
				_ = filepath.WalkDir(dir, func(path string, _ fs.DirEntry, _ error) error { return os.Chtimes(path, now, now) })
			}
			// Here is Default; the others are Work and Other.
			put(defaultHome, tc.here)
			put(work.Dir, tc.work)
			put(other.Dir, tc.other)
			var before map[string]string
			if tc.here.turns != nil {
				before = kimiTreeSnapshot(t, kimiSessionDirIn(defaultHome, kimiTestSessionID))
			}

			carried, err := carryKimiConversation(defaultHome, kimiTestSessionID)
			if err != nil || carried != tc.wantCarried {
				t.Fatalf("carried = %v, %v; want %v", carried, err, tc.wantCarried)
			}
			here := kimiSessionDirIn(defaultHome, kimiTestSessionID)
			if got := kimiTestTurnsIn(t, here); len(got) != tc.want {
				t.Fatalf("the copy here holds %q, want %d turns", got, tc.want)
			}
			if !tc.wantCarried && !reflect.DeepEqual(kimiTreeSnapshot(t, here), before) {
				t.Fatalf("the copy here was rewritten:\nbefore %v\nafter  %v", before, kimiTreeSnapshot(t, here))
			}
			assertNoKimiCarryLeftovers(t, defaultHome)
		})
	}
}

// A carry that fails leaves the account it was carrying to as it was: a copy that breaks off midway
// is never put in place, and a copy already there that the new one was about to replace is put back
// when the replacing fails. Either way nothing is left behind that Kimi would list as a session, the
// account it came from is untouched, and the session's run fails rather than resume the older copy —
// its kimi never starts — so the next run carries it again.
func TestKimiCarryThatFailsLeavesTheAccountAsItWas(t *testing.T) {
	setup := func(t *testing.T) (string, accountSlot, map[string]string, map[string]string) {
		t.Helper()
		defaultHome, work := kimiMoveTestHomes(t)
		start := time.Now().Add(-5 * time.Hour)
		putKimiSession(t, work.Dir, kimiTestWorkDir, kimiTestSessionID, start, kimiTestTurn{"rename the widget", "renamed it"})
		onDefault := putKimiSession(t, defaultHome, kimiTestWorkDir, kimiTestSessionID, start,
			kimiTestTurn{"rename the widget", "renamed it"}, kimiTestTurn{"and the gadget", "gadget renamed"})
		return defaultHome, work, kimiHomeState(t, work.Dir), kimiTreeContents(t, onDefault)
	}
	restore := func(t *testing.T) {
		copyFile, rename := kimiCarryCopyFile, kimiCarryRename
		t.Cleanup(func() { kimiCarryCopyFile, kimiCarryRename = copyFile, rename })
	}

	t.Run("the copy breaks off midway", func(t *testing.T) {
		restore(t)
		defaultHome, work, workBefore, defaultCopy := setup(t)
		copied := 0
		kimiCarryCopyFile = func(src, dst string, perm fs.FileMode) error {
			if copied++; copied == 3 {
				return errors.New("no space left on device")
			}
			return copyKimiSessionFile(src, dst, perm)
		}
		carried, err := carryKimiConversation(work.Dir, kimiTestSessionID)
		if carried || err == nil || !strings.Contains(err.Error(), "no space left on device") {
			t.Fatalf("carry = %v, %v; want it to fail on the copy", carried, err)
		}
		if after := kimiHomeState(t, work.Dir); !reflect.DeepEqual(after, workBefore) {
			t.Fatalf("a failed carry changed Work:\nbefore %v\nafter  %v", workBefore, after)
		}
		assertNoKimiCarryLeftovers(t, work.Dir)
		if got := kimiTreeContents(t, kimiSessionDirIn(defaultHome, kimiTestSessionID)); !reflect.DeepEqual(got, defaultCopy) {
			t.Fatal("a failed carry changed the copy it was carrying")
		}
	})

	t.Run("putting it in place fails", func(t *testing.T) {
		restore(t)
		_, work, workBefore, _ := setup(t)
		kimiCarryRename = func(from, to string) error {
			if strings.HasPrefix(to, filepath.Join(work.Dir, "sessions")) && strings.Contains(from, ".orbit-kimi-carry-") &&
				filepath.Base(from) == kimiTestSessionID {
				return errors.New("input/output error")
			}
			return os.Rename(from, to)
		}
		carried, err := carryKimiConversation(work.Dir, kimiTestSessionID)
		if carried || err == nil || !strings.Contains(err.Error(), "input/output error") {
			t.Fatalf("carry = %v, %v; want it to fail putting the copy in place", carried, err)
		}
		// The copy Work had was set aside for the new one, and is back where it was, as it was — the
		// directories it went through aside, whose times a rename moves.
		after := kimiHomeState(t, work.Dir)
		for path, entry := range workBefore {
			if strings.HasPrefix(entry, "d") && after[path] != "" {
				continue
			}
			if after[path] != entry {
				t.Fatalf("%s after the failed carry = %q, want %q", path, after[path], entry)
			}
		}
		if len(after) != len(workBefore) {
			t.Fatalf("a failed carry left Work with other entries:\nbefore %v\nafter  %v", workBefore, after)
		}
		assertNoKimiCarryLeftovers(t, work.Dir)
	})

	t.Run("the run fails, and its kimi never starts", func(t *testing.T) {
		restore(t)
		_, work, workBefore, _ := setup(t)
		installFakeKimiForAccounts(t)
		capture := filepath.Join(t.TempDir(), "capture")
		t.Setenv("FAKE_KIMI_ACP_CAPTURE", capture)
		kimiCarryCopyFile = func(string, string, fs.FileMode) error { return errors.New("no space left on device") }
		job := &ClaimedSession{SessionID: "kimi-move-session", SessionUUID: "kimi-move-session", Provider: providerKimi,
			RuntimeSessionID: kimiTestSessionID, Agent: AgentExecConfig{Provider: providerKimi, Env: map[string]string{"KIMI_CODE_HOME": work.Dir}}}
		var mu sync.Mutex
		var said []string
		emit := func(eventType string, payload map[string]interface{}) {
			if eventType == evError {
				mu.Lock()
				said = append(said, fmt.Sprint(payload["message"]))
				mu.Unlock()
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		status, _, _ := runKimiSessionProcess(ctx, ctx, NewTransport("http://127.0.0.1:1", "runner-token"), job, "1", t.TempDir(), t.TempDir(),
			emit, nil, func(string) {}, false, nil, nil, nil, nil)
		if status != stFailed {
			t.Fatalf("status = %q, want the run failed", status)
		}
		mu.Lock()
		defer mu.Unlock()
		if len(said) != 1 || !strings.Contains(said[0], "failed to bring this session's Kimi conversation to the account it now runs on") ||
			!strings.Contains(said[0], "no space left on device") {
			t.Fatalf("errors = %q, want the failed carry named", said)
		}
		if _, err := os.Lstat(capture); !errors.Is(err, fs.ErrNotExist) {
			t.Fatal("kimi started on the copy the failed carry left behind")
		}
		if after := kimiHomeState(t, work.Dir); !reflect.DeepEqual(after, workBefore) {
			t.Fatalf("the failed run changed Work:\nbefore %v\nafter  %v", workBefore, after)
		}
	})
}

// The index line and the workspace a carry writes are Kimi's own shapes, written the way Kimi would: a
// line is added once however often the session comes back, after a line for it that names another
// directory (the overlay's, which Kimi passes over) and after a last line somebody left unfinished; a
// workspaces.json the home keeps gains the session's workspace, or takes it off its deleted list, and
// keeps everything else it holds; one it cannot read is left as it is.
func TestKimiCarryWritesTheIndexLineAndWorkspaceAsKimiWould(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "sessions", kimiWorkDirKey(kimiTestWorkDir), kimiTestSessionID)
	entry := kimiSessionIndexEntry{SessionID: kimiTestSessionID, SessionDir: dir, WorkDir: kimiTestWorkDir}
	overlayLine := `{"sessionId":"` + kimiTestSessionID + `","sessionDir":"/root/.orbit/runs/x/kimi-home/sessions/` +
		kimiWorkDirKey(kimiTestWorkDir) + `/` + kimiTestSessionID + `","workDir":"` + kimiTestWorkDir + `"}`
	putFile(t, filepath.Join(home, "session_index.jsonl"), []byte(overlayLine+"\n"+`{"sessionId":"session_x","sessio`), time.Now())
	for range 2 {
		if err := ensureKimiSessionIndexEntry(home, entry); err != nil {
			t.Fatal(err)
		}
	}
	line, _ := json.Marshal(entry)
	if got, want := readFile(t, filepath.Join(home, "session_index.jsonl")), overlayLine+"\n"+`{"sessionId":"session_x","sessio`+"\n"+string(line)+"\n"; got != want {
		t.Fatalf("session_index.jsonl =\n%s\nwant\n%s", got, want)
	}

	bucket := kimiWorkDirKey(kimiTestWorkDir)
	catalog := func(body string) map[string]interface{} {
		t.Helper()
		path := filepath.Join(home, "workspaces.json")
		putFile(t, path, []byte(body), time.Now())
		if err := ensureKimiWorkspace(home, bucket, kimiTestWorkDir); err != nil {
			t.Fatal(err)
		}
		var out map[string]interface{}
		if err := json.Unmarshal([]byte(readFile(t, path)), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	other := `"wd_other_0123456789ab":{"root":"/srv/other","name":"other","created_at":"2026-10-01T00:00:00.000Z","last_opened_at":"2026-10-01T00:00:00.000Z"}`
	got := catalog(`{"version":1,"workspaces":{` + other + `},"deleted_workspace_ids":[],"future_field":7}`)
	workspaces := got["workspaces"].(map[string]interface{})
	ours, _ := workspaces[bucket].(map[string]interface{})
	if ours["root"] != kimiTestWorkDir || ours["name"] != "work" || ours["created_at"] == nil || ours["last_opened_at"] == nil {
		t.Fatalf("the session's workspace = %v", ours)
	}
	if _, ok := workspaces["wd_other_0123456789ab"]; !ok || got["future_field"] != float64(7) || got["version"] != float64(1) {
		t.Fatalf("the catalog lost what it held: %v", got)
	}
	got = catalog(`{"version":1,"workspaces":{"` + bucket + `":{"root":"` + kimiTestWorkDir + `","name":"renamed by hand","created_at":"2026-10-01T00:00:00.000Z","last_opened_at":"2026-10-01T00:00:00.000Z"}},"deleted_workspace_ids":["` + bucket + `","wd_gone_0123456789ab"]}`)
	if deleted := got["deleted_workspace_ids"]; !reflect.DeepEqual(deleted, []interface{}{"wd_gone_0123456789ab"}) {
		t.Fatalf("deleted ids = %v, want the session's workspace taken off them", deleted)
	}
	if name := got["workspaces"].(map[string]interface{})[bucket].(map[string]interface{})["name"]; name != "renamed by hand" {
		t.Fatalf("the workspace already listed was rewritten: name %v", name)
	}
	const unreadable = `{"version":1,"workspaces":`
	putFile(t, filepath.Join(home, "workspaces.json"), []byte(unreadable), time.Now())
	if err := ensureKimiWorkspace(home, bucket, kimiTestWorkDir); err == nil || readFile(t, filepath.Join(home, "workspaces.json")) != unreadable {
		t.Fatalf("an unreadable catalog: err %v, now %q", err, readFile(t, filepath.Join(home, "workspaces.json")))
	}
}

// A session's record keeps the account its Kimi conversation is in until the engine that starts on
// another carries it there: a claim already naming the account the session moves to, written before
// the engine starts, does not move it — a run that fails before then leaves the conversation where
// the record says — and the engine's start does. A session with no conversation yet records the
// account its claim names at once.
func TestKimiSessionRecordMovesWithTheConversation(t *testing.T) {
	_, _ = kimiAccountTestHomes(t)
	work, err := kimiAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	scratch, execDir := t.TempDir(), t.TempDir()
	meta := func() *sessionMeta { return readSessionMeta(filepath.Join(scratch, "meta.json")) }
	job := &ClaimedSession{SessionID: "kimi-record", SessionUUID: "kimi-record", Provider: providerKimi,
		Agent: AgentExecConfig{Provider: providerKimi}}

	writeSessionMeta(scratch, job, execDir)
	job.RuntimeSessionID = kimiTestSessionID
	writeKimiSessionMeta(scratch, job, execDir) // its engine started on Default
	if m := meta(); m == nil || m.KimiCodeHome != "" || m.RuntimeSessionID != kimiTestSessionID {
		t.Fatalf("on Default: %+v", m)
	}

	job.Agent.Env = map[string]string{"KIMI_CODE_HOME": work.Dir} // moved to Work; the claim comes in
	writeSessionMeta(scratch, job, execDir)
	if m := meta(); m.KimiCodeHome != "" {
		t.Fatalf("before its engine started on Work, the record says %q, not Default where the conversation is", m.KimiCodeHome)
	}
	writeKimiSessionMeta(scratch, job, execDir)
	if m := meta(); m.KimiCodeHome != work.Dir {
		t.Fatalf("its engine started on Work, the record says %q", m.KimiCodeHome)
	}

	fresh, freshScratch := &ClaimedSession{SessionID: "kimi-fresh", SessionUUID: "kimi-fresh", Provider: providerKimi,
		Agent: AgentExecConfig{Provider: providerKimi, Env: map[string]string{"KIMI_CODE_HOME": work.Dir}}}, t.TempDir()
	writeSessionMeta(freshScratch, fresh, execDir)
	if m := readSessionMeta(filepath.Join(freshScratch, "meta.json")); m == nil || m.KimiCodeHome != work.Dir {
		t.Fatalf("a session with no conversation yet records %+v, want Work", m)
	}
}

// What Kimi 2.1.1 writes to a turn's wire, verbatim but for times and ids, for a turn it ended on the
// account's usage limit and for one a provider refused for another reason (2026-10-08, a model endpoint
// answering 429 exceeded_current_quota_error and 400 invalid_request_error).
const (
	kimiQuotaTurnRecords = `{"type":"turn.prompt","agentId":"main","input":[{"type":"text","text":"hit the QUOTA now"}],"origin":{"kind":"user"},"promptId":"msg_01M4DXWCAMYGAFSX1NYWZH1W1K","turnId":1,"time":1791468908890}
{"type":"context.append_loop_event","agentId":"main","event":{"type":"step.end","uuid":"d1fb74e4-b4a6-4716-a24c-ea21590c7992","turnId":"1","step":1,"finishReason":"error"},"time":1791468908938}
{"type":"turn.step.interrupted","agentId":"main","turnId":1,"step":1,"reason":"error","message":"[provider.api_error] 429 You exceeded your current token quota: 0 1000000, please check your account balance","time":1791468908941}
{"turnId":1,"outcome":"failed","errorMessage":"[object Object]","type":"agent.turn.ended","time":1791468908938,"kind":"event"}
{"type":"turn.ended","agentId":"main","turnId":1,"reason":"failed","error":{"code":"provider.api_error","message":"429 You exceeded your current token quota: 0 1000000, please check your account balance","name":"APIProviderQuotaExhaustedError","details":{"statusCode":429,"requestId":null,"traceId":null},"retryable":false},"durationMs":49,"time":1791468908941}
{"type":"prompt.completed","agentId":"main","promptId":"msg_01M4DXWCAMYGAFSX1NYWZH1W1K","finishedAt":"2026-10-08T14:15:08.944Z","reason":"failed","time":1791468908944}
`
	kimiRefusedTurnRecords = `{"type":"turn.prompt","agentId":"main","input":[{"type":"text","text":"a BADREQ turn"}],"origin":{"kind":"user"},"promptId":"msg_01M4DY0BADREQ0000000000000","turnId":1,"time":1791470069600}
{"type":"turn.step.interrupted","agentId":"main","turnId":1,"step":1,"reason":"error","message":"[provider.api_error] 400 Invalid request: the prompt is malformed","time":1791470069711}
{"type":"turn.ended","agentId":"main","turnId":1,"reason":"failed","error":{"code":"provider.api_error","message":"400 Invalid request: the prompt is malformed","name":"APIStatusError","details":{"statusCode":400,"requestId":null,"traceId":null},"retryable":false},"durationMs":99,"time":1791470069712}
`
	kimiQuotaSentence = "You've hit your usage limit on this Kimi Code account — 429 You exceeded your current token quota: 0 1000000, please check your account balance"
)

// Kimi answers a turn it ended on the account's usage limit the way it answers one that went well —
// end_turn, and not a word of why — so the turn's own records say it: the main agent's turn.ended for
// the turn that opened past where the wire stood when it was prompted, failed on
// APIProviderQuotaExhaustedError. The sentence it is reported with opens with the words the control
// plane and the clients read as a spent quota. A turn that ended well, one that failed for another
// reason, and the late end of the turn before are none of that; an end that reaches the wire a moment
// after the answer is waited for; one that never does is given up on.
func TestKimiTurnUsageLimitIsReadFromTheTurnsOwnRecord(t *testing.T) {
	start := time.Now().Add(-time.Hour)
	wireWith := func(t *testing.T, after string) (string, int64) {
		t.Helper()
		home := t.TempDir()
		dir := putKimiSession(t, home, kimiTestWorkDir, kimiTestSessionID, start, kimiTestTurn{"rename the widget", "renamed it"})
		wire, from := kimiTurnWire(home, kimiTestSessionID)
		if wire != filepath.Join(dir, "agents", "main", "wire.jsonl") || from == 0 {
			t.Fatalf("the turn's wire = %q from %d", wire, from)
		}
		if after != "" {
			f, err := os.OpenFile(wire, os.O_WRONLY|os.O_APPEND, 0)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.WriteString(after); err != nil {
				t.Fatal(err)
			}
			_ = f.Close()
		}
		return wire, from
	}
	ctx := context.Background()

	wire, from := wireWith(t, kimiQuotaTurnRecords)
	if got := kimiTurnUsageLimit(ctx, wire, from); got != kimiQuotaSentence {
		t.Fatalf("a turn ended on the usage limit is reported as %q, want %q", got, kimiQuotaSentence)
	}
	if !strings.HasPrefix(strings.ToLower(kimiQuotaSentence), "you've hit your usage limit") {
		t.Fatal("the sentence does not open with the words read as a spent quota")
	}
	// The control plane's spec of what it does with such a turn is about these very words.
	spec, err := os.ReadFile(filepath.Join("..", "apiserver", "src", "runner-api", "kimi-usage-limit-switch.pg.spec.ts"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(spec), `"`+kimiQuotaSentence+`"`) {
		t.Fatalf("kimi-usage-limit-switch.pg.spec.ts does not report the turn as the runner does: %q", kimiQuotaSentence)
	}

	for name, after := range map[string]string{
		"a turn that went well": `{"type":"turn.prompt","agentId":"main","turnId":1,"input":[{"type":"text","text":"x"}],"time":1}` + "\n" +
			`{"type":"turn.ended","agentId":"main","turnId":1,"reason":"completed","durationMs":58,"time":2}` + "\n",
		"a turn a provider refused for another reason": kimiRefusedTurnRecords,
		// The turn before ended on the limit, its record late enough to land past where this turn's
		// prompt found the wire; this turn went well.
		"the late end of the turn before": `{"type":"turn.ended","agentId":"main","turnId":0,"reason":"failed","error":{"name":"APIProviderQuotaExhaustedError","message":"429 quota"},"time":1}` + "\n" +
			`{"type":"turn.prompt","agentId":"main","turnId":1,"input":[{"type":"text","text":"x"}],"time":2}` + "\n" +
			`{"type":"turn.ended","agentId":"main","turnId":1,"reason":"completed","time":3}` + "\n",
	} {
		wire, from := wireWith(t, after)
		if got := kimiTurnUsageLimit(ctx, wire, from); got != "" {
			t.Errorf("%s is reported as %q", name, got)
		}
	}

	// The end reaches the wire a moment after the answer — half of its line first.
	wire, from = wireWith(t, kimiQuotaTurnRecords[:strings.Index(kimiQuotaTurnRecords, `{"type":"turn.ended"`)+20])
	go func() {
		time.Sleep(150 * time.Millisecond)
		f, err := os.OpenFile(wire, os.O_WRONLY|os.O_APPEND, 0)
		if err == nil {
			_, _ = f.WriteString(kimiQuotaTurnRecords[strings.Index(kimiQuotaTurnRecords, `{"type":"turn.ended"`)+20:])
			_ = f.Close()
		}
	}()
	if got := kimiTurnUsageLimit(ctx, wire, from); got != kimiQuotaSentence {
		t.Fatalf("an end written after the answer is reported as %q", got)
	}

	// It never does: given up on after kimiTurnOutcomeWait, and the turn stands as answered.
	wire, from = wireWith(t, `{"type":"turn.prompt","agentId":"main","turnId":1,"input":[{"type":"text","text":"x"}],"time":2}`+"\n")
	began := time.Now()
	if got := kimiTurnUsageLimit(ctx, wire, from); got != "" || time.Since(began) < kimiTurnOutcomeWait {
		t.Fatalf("an end never written: %q after %v", got, time.Since(began))
	}
	if got := kimiTurnUsageLimit(ctx, "", 0); got != "" {
		t.Fatalf("no wire found for the session: %q", got)
	}
}

// The whole of it against the real CLI — checked when asked (ORBIT_REAL_KIMI=1), since it runs the
// machine's kimi. No account and no network: a throwaway HOME is Default, a throwaway ORBIT_HOME holds
// Work, and every session talks to a model endpoint in this test through Kimi's own environment-backed
// model (KIMI_MODEL_*). The session runs through runKimiSessionProcess, overlay and all, as dispatch
// runs it: it starts on Default, is moved to Work, back to Default and to Work again, and every time
// the model is sent every turn said before it, on whichever account it was said. Work's own kimi
// lists the session by id. A turn the endpoint then refuses for a spent quota is reported failed on
// the account's usage limit, in the words the control plane moves a session on.
func TestRealKimiConversationFollowsTheSessionBetweenAccounts(t *testing.T) {
	if os.Getenv("ORBIT_REAL_KIMI") != "1" {
		t.Skip("set ORBIT_REAL_KIMI=1 to move a session between Kimi accounts with the real CLI")
	}
	bin, err := exec.LookPath(providerKimi)
	if err != nil {
		t.Fatal("ORBIT_REAL_KIMI=1, but this machine has no kimi")
	}
	version, _ := exec.Command(bin, "--version").Output()
	t.Logf("kimi %s at %s", strings.TrimSpace(string(version)), bin)
	defaultHome, _ := kimiAccountTestHomes(t)
	t.Setenv("PATH", filepath.Dir(bin)+string(os.PathListSeparator)+os.Getenv("PATH"))
	work, err := kimiAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}

	// The model: an OpenAI-compatible endpoint answering "ACK: <what was just said>", and refusing a
	// turn that says QUOTA as the Kimi platform refuses a spent quota.
	var modelMu sync.Mutex
	var heard [][]string // what each request carried the person as having said, in order
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Messages []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if r.Method != http.MethodPost || json.NewDecoder(r.Body).Decode(&req) != nil {
			http.NotFound(w, r)
			return
		}
		var said []string
		for _, m := range req.Messages {
			if m.Role != "user" {
				continue
			}
			var text string
			if json.Unmarshal(m.Content, &text) != nil {
				var parts []struct {
					Text string `json:"text"`
				}
				_ = json.Unmarshal(m.Content, &parts)
				for _, p := range parts {
					text += p.Text
				}
			}
			if strings.HasPrefix(strings.TrimSpace(text), "<system-reminder>") {
				continue // Kimi's own reminder, sent as a user message of its own
			}
			// The runner's instructions lead every prompt it sends (prepareKimiPrompt); what was said
			// follows them.
			if _, after, ok := strings.Cut(text, "</orbit-agent-instructions>"); ok {
				text = after
			}
			said = append(said, strings.TrimSpace(text))
		}
		modelMu.Lock()
		heard = append(heard, said)
		modelMu.Unlock()
		last := ""
		if len(said) > 0 {
			last = said[len(said)-1]
		}
		if strings.Contains(last, "QUOTA") {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":{"message":"You exceeded your current token quota: 0 1000000, please check your account balance","type":"exceeded_current_quota_error"}}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		chunk := func(delta map[string]interface{}, finish interface{}) {
			b, _ := json.Marshal(map[string]interface{}{"id": "chatcmpl-test", "object": "chat.completion.chunk", "created": 1, "model": "fake-model",
				"choices": []interface{}{map[string]interface{}{"index": 0, "delta": delta, "finish_reason": finish}},
				"usage":   map[string]interface{}{"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}})
			_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
		}
		chunk(map[string]interface{}{"role": "assistant", "content": ""}, nil)
		chunk(map[string]interface{}{"content": "ACK: " + last}, nil)
		chunk(map[string]interface{}{}, "stop")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(model.Close)

	// The control plane's half: turns handed out on the inbox, completions taken down.
	inbox := make(chan RunInboxResponse, 4)
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/inbox") {
			select {
			case turn := <-inbox:
				_ = json.NewEncoder(w).Encode(turn)
			case <-time.After(time.Second):
				_, _ = w.Write([]byte(`{}`))
			case <-r.Context().Done():
			}
			return
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(control.Close)

	execDir, scratch := t.TempDir(), t.TempDir()
	runtimeID := ""
	turnNo := 0
	var said []string
	// stint runs the session on home ("" for Default) the way a claim naming that account runs it, for
	// the turns given, and returns what each was completed with.
	stint := func(home string, turns ...string) []TurnCompleteRequest {
		t.Helper()
		env := map[string]string{
			"KIMI_MODEL_NAME": "fake-model", "KIMI_MODEL_API_KEY": "sk-test", "KIMI_MODEL_PROVIDER_TYPE": "kimi",
			"KIMI_MODEL_BASE_URL": model.URL + "/v1", testOrbitMCPEnv: "1",
		}
		if home != "" {
			env["KIMI_CODE_HOME"] = home
		}
		job := &ClaimedSession{SessionID: "kimi-move-real", SessionUUID: "kimi-move-real", Provider: providerKimi,
			RuntimeSessionID: runtimeID, Agent: AgentExecConfig{Provider: providerKimi, Env: env}}
		completions := make(chan TurnCompleteRequest, 4)
		var errMu sync.Mutex
		var errs []string
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		done := make(chan string, 1)
		go func() {
			status, _, _ := runKimiSessionProcess(ctx, ctx, NewTransport(control.URL, "runner-token"), job, "1", execDir, scratch,
				func(kind string, payload map[string]interface{}) {
					if kind == evError {
						errMu.Lock()
						errs = append(errs, fmt.Sprint(payload["message"]))
						errMu.Unlock()
					}
				},
				func(string, string, map[string]interface{}) {}, func(string) {}, false, nil,
				func(req TurnCompleteRequest, _ ...context.Context) error { completions <- req; return nil },
				func(context.Context) bool { return true },
				func(err error) { t.Errorf("lease lost: %v", err) })
			done <- status
		}()
		var out []TurnCompleteRequest
		for _, text := range turns {
			turnNo++
			inbox <- RunInboxResponse{TurnID: fmt.Sprintf("t%d", turnNo), Kind: "message", Content: text}
			select {
			case req := <-completions:
				out = append(out, req)
				runtimeID = req.RuntimeSessionID
			case status := <-done:
				errMu.Lock()
				defer errMu.Unlock()
				t.Fatalf("the session ended (%s) before %q was answered: %q", status, text, errs)
			case <-ctx.Done():
				t.Fatalf("%q was never answered", text)
			}
			said = append(said, text)
		}
		inbox <- RunInboxResponse{TurnID: "end", Kind: "end"}
		select {
		case status := <-done:
			if status != stSucceeded {
				errMu.Lock()
				defer errMu.Unlock()
				t.Fatalf("the session on %q ended %s: %q", home, status, errs)
			}
		case <-ctx.Done():
			t.Fatal("the session never ended")
		}
		return out
	}
	// heardLast is what the model was sent as said before and in the last request.
	heardLast := func() []string {
		modelMu.Lock()
		defer modelMu.Unlock()
		if len(heard) == 0 {
			return nil
		}
		return heard[len(heard)-1]
	}
	answered := func(reqs []TurnCompleteRequest) {
		t.Helper()
		for _, req := range reqs {
			if req.Status != stSucceeded || req.Error != "" || !strings.HasPrefix(req.Result, "ACK: ") {
				t.Fatalf("turn %s = %+v, want it answered", req.TurnID, req)
			}
		}
		if got := heardLast(); !reflect.DeepEqual(got, said) {
			t.Fatalf("the model was sent %q, want every turn said so far: %q", got, said)
		}
	}
	recorded := func(want string) {
		t.Helper()
		if meta := readSessionMeta(filepath.Join(scratch, "meta.json")); meta == nil || meta.KimiCodeHome != want {
			t.Fatalf("the session's record = %+v, want its account's home %q", meta, want)
		}
	}

	answered(stint("", "rename the widget", "and the gadget"))
	recorded("")
	if runtimeID == "" || kimiSessionDirIn(defaultHome, runtimeID) == "" {
		t.Fatalf("Kimi session %q is not in Default's home", runtimeID)
	}
	answered(stint(work.Dir, "now the sprocket on Work"))
	recorded(work.Dir)
	if kimiSessionDirIn(defaultHome, runtimeID) == "" {
		t.Fatal("Default lost its copy")
	}
	answered(stint("", "back on Default: the cog"))
	recorded("")
	answered(stint(work.Dir, "Work again: the flange"))
	recorded(work.Dir)

	// Work's own kimi finds it by id — no overlay, the account's home itself.
	list := exec.Command(bin, "session", "list", "--all", "--json")
	list.Dir = execDir
	list.Env = append(os.Environ(), "KIMI_CODE_HOME="+work.Dir, "KIMI_MODEL_NAME=fake-model", "KIMI_MODEL_API_KEY=sk-test",
		"KIMI_MODEL_PROVIDER_TYPE=kimi", "KIMI_MODEL_BASE_URL="+model.URL+"/v1")
	listed, err := list.Output()
	if err != nil {
		t.Fatalf("kimi session list on Work: %v", err)
	}
	var sessions []struct {
		ID         string `json:"id"`
		SessionDir string `json:"sessionDir"`
	}
	if err := json.Unmarshal(listed, &sessions); err != nil || len(sessions) != 1 || sessions[0].ID != runtimeID ||
		sessions[0].SessionDir != kimiSessionDirIn(work.Dir, runtimeID) {
		t.Fatalf("kimi session list on Work = %s (%v), want the session in Work's home", listed, err)
	}
	var indexed []string
	for _, line := range kimiIndexLines(t, work.Dir) {
		if line.SessionID == runtimeID {
			indexed = append(indexed, line.SessionDir)
		}
	}
	if !reflect.DeepEqual(indexed, []string{kimiSessionDirIn(work.Dir, runtimeID)}) {
		t.Fatalf("Work's index lines for the session name %q, want its directory in Work once", indexed)
	}

	// The endpoint refuses the next turn for a spent quota: Kimi answers it as ended, and the runner
	// reports it failed on the account's usage limit.
	refused := stint(work.Dir, "and now we hit the QUOTA")
	if len(refused) != 1 || refused[0].Status != stFailed || !strings.HasPrefix(refused[0].Error, "You've hit your usage limit on this Kimi Code account") ||
		!strings.Contains(refused[0].Error, "exceeded your current token quota") {
		t.Fatalf("the turn the quota stopped = %+v", refused)
	}
}
