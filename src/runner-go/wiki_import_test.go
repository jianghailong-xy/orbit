package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// `orbit wiki import` against a fake vLLM endpoint (contract `import`, criterion 1).
//
// The stand-ins are the ones `orbit wiki verify`'s tests drive (wiki_verify_test.go): the fake model
// endpoint, answering what a test scripts per note, and the fake Claude Code between it and the
// command. Beside them is a fake Orbit door for the import's two routes, which keeps notes one per
// content and "redacts" one secret — so a test can tell the text the model was handed from the file
// that was read — and answers each op as the space's review mode would.

// fakeImportSecret is the one secret the fake door takes out of a note, as the server's redactor takes
// out the owner's workspace.env values.
const fakeImportSecret = "SECRET-VALUE-123"

type fakeImportRequest struct {
	Session   string
	DryRun    bool
	Key       string
	Rationale string
	Ops       []map[string]interface{}
}

type fakeImportDoor struct {
	URL      string
	mu       sync.Mutex
	mode     string
	queueCap int
	// Paths the door refuses as a note (WIKI_SCHEMA), as the server refuses a text past its limit.
	refusePaths   map[string]bool
	notes         map[string]map[string]interface{}
	registrations []string
	sessions      []string
	requests      []fakeImportRequest
	answers       map[string][]byte
	pending       int
	nextID        int
}

func newFakeImportDoor(t *testing.T, mode string) *fakeImportDoor {
	t.Helper()
	door := &fakeImportDoor{mode: mode, queueCap: 30, refusePaths: map[string]bool{}, notes: map[string]map[string]interface{}{}, answers: map[string][]byte{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		door.mu.Lock()
		defer door.mu.Unlock()
		door.sessions = append(door.sessions, r.Header.Get("X-Orbit-Session-Id"))
		w.Header().Set("content-type", "application/json")
		raw, _ := io.ReadAll(r.Body)
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/runner/wiki/spaces/space-1/notes":
			door.note(w, raw)
		case r.Method == http.MethodPost && r.URL.Path == "/api/runner/wiki/spaces/space-1/imports":
			door.propose(t, w, r, raw)
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Cannot POST"}`))
		}
	}))
	t.Cleanup(srv.Close)
	door.URL = srv.URL
	return door
}

func (d *fakeImportDoor) note(w http.ResponseWriter, raw []byte) {
	var body struct {
		Path string `json:"path"`
		Text string `json:"text"`
	}
	_ = json.Unmarshal(raw, &body)
	d.registrations = append(d.registrations, body.Path)
	if d.refusePaths[body.Path] {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"code":"WIKI_SCHEMA","message":"the note does not have the shape this contract gives it","errors":[{"path":"text","message":"must be at most 100000 characters"}]}`))
		return
	}
	text := strings.ReplaceAll(body.Text, fakeImportSecret, "[redacted]")
	sum := sha256.Sum256([]byte(text))
	key := hex.EncodeToString(sum[:])
	note, known := d.notes[key]
	if !known {
		d.nextID++
		note = map[string]interface{}{"id": fmt.Sprintf("note-%d", d.nextID), "spaceId": "space-1", "path": body.Path,
			"contentSha256": key, "chars": len([]rune(text)), "redacted": text != body.Text, "text": text}
		d.notes[key] = note
	}
	answer := map[string]interface{}{"created": !known}
	for k, v := range note {
		answer[k] = v
	}
	out, _ := json.Marshal(answer)
	_, _ = w.Write(out)
}

func (d *fakeImportDoor) propose(t *testing.T, w http.ResponseWriter, r *http.Request, raw []byte) {
	var body struct {
		Ops            []map[string]interface{} `json:"ops"`
		Rationale      string                   `json:"rationale"`
		IdempotencyKey string                   `json:"idempotencyKey"`
		DryRun         bool                     `json:"dryRun"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Errorf("a proposal that is not JSON: %s", raw)
	}
	d.requests = append(d.requests, fakeImportRequest{Session: r.Header.Get("X-Orbit-Session-Id"), DryRun: body.DryRun,
		Key: body.IdempotencyKey, Rationale: body.Rationale, Ops: body.Ops})
	if recorded, ok := d.answers[body.IdempotencyKey]; ok && body.IdempotencyKey != "" {
		_, _ = w.Write(recorded)
		return
	}
	outcomes := []map[string]interface{}{}
	waiting, recorded, firstStatus := 0, 0, 0
	for seq, op := range body.Ops {
		entry, _ := op["entry"].(map[string]interface{})
		title, _ := entry["title"].(string)
		refuse := func(code string, status int) {
			outcomes = append(outcomes, map[string]interface{}{"seq": seq, "status": "refused",
				"reasons": []interface{}{map[string]interface{}{"code": code, "message": "refused by the fake door: " + code}}})
			if firstStatus == 0 {
				firstStatus = status
			}
		}
		if strings.Contains(title, "REFUSE-SCHEMA") {
			refuse("WIKI_SCHEMA", http.StatusBadRequest)
			continue
		}
		ids := map[string]interface{}{"opId": nil, "entryId": nil}
		if !body.DryRun {
			d.nextID++
			ids = map[string]interface{}{"opId": fmt.Sprintf("op-%d", d.nextID), "entryId": fmt.Sprintf("entry-%d", d.nextID)}
		}
		outcome := map[string]interface{}{"seq": seq, "opId": ids["opId"], "entryId": ids["entryId"]}
		switch d.mode {
		case "tiered":
			outcome["status"], outcome["revision"] = "applied", 1
		case "automatic":
			outcome["status"], outcome["waitsFor"] = "pending", "verification"
		case "manual":
			switch {
			case waiting >= 5:
				refuse("WIKI_QUOTA", http.StatusTooManyRequests)
				continue
			case d.pending+waiting >= d.queueCap:
				refuse("WIKI_REVIEW_QUEUE_FULL", http.StatusTooManyRequests)
				continue
			}
			waiting++
			outcome["status"] = "pending"
		}
		recorded++
		outcomes = append(outcomes, outcome)
	}
	answer := map[string]interface{}{"changesetId": nil, "replayed": false, "ops": outcomes}
	if body.DryRun {
		answer["dryRun"] = true
	} else if recorded > 0 {
		d.pending += waiting
		answer["changesetId"] = fmt.Sprintf("cs-%d", len(d.requests))
	}
	out, _ := json.Marshal(answer)
	if !body.DryRun && recorded == 0 && firstStatus != 0 {
		w.WriteHeader(firstStatus)
	}
	if body.IdempotencyKey != "" && !body.DryRun {
		replay := map[string]interface{}{}
		for k, v := range answer {
			replay[k] = v
		}
		replay["replayed"] = true
		d.answers[body.IdempotencyKey], _ = json.Marshal(replay)
	}
	_, _ = w.Write(out)
}

func (d *fakeImportDoor) Requests() []fakeImportRequest {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]fakeImportRequest{}, d.requests...)
}

func (d *fakeImportDoor) Registrations() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string{}, d.registrations...)
}

// proposed is every op the door recorded for real, in order.
func (d *fakeImportDoor) proposed() []map[string]interface{} {
	var out []map[string]interface{}
	for _, request := range d.Requests() {
		if !request.DryRun {
			out = append(out, request.Ops...)
		}
	}
	return out
}

// wikiImportSession points the CLI at the door and the model endpoint as a session on the local
// model's provider has them, plants what must not reach the clean call, and gives the anchors a
// repository of the test's own.
func wikiImportSession(t *testing.T, door *fakeImportDoor, vllm *fakeVLLM) {
	t.Helper()
	home := t.TempDir()
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}
	config := `{"serverUrl":` + strconv.Quote(door.URL) + `,"runnerId":"r1","runnerToken":"runner-token","name":"test"}`
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ORBIT_HOME", home)
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envWiki, "on")
	t.Setenv("ANTHROPIC_BASE_URL", vllm.URL)
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "tok-local-vllm")
	t.Setenv("ANTHROPIC_MODEL", "qwen3.8-27b-fp8")
	t.Setenv("CLAUDE_CODE_MAX_CONTEXT_TOKENS", "131072")
	// Planted: a bare run would send this as x-api-key; the session's own effort, which would have the
	// local model think; a socket of the session's own Claude Code; Orbit's own token.
	t.Setenv("ANTHROPIC_API_KEY", "sk-must-not-reach-the-importer")
	t.Setenv("CLAUDE_CODE_EFFORT_LEVEL", "high")
	t.Setenv("CLAUDE_CODE_MESSAGING_SOCKET", "/tmp/the-session-own-socket.sock")
	t.Setenv("ORBIT_BG_TOKEN", "bg-token-must-not-leak")
	previous := wikiImportRepoDir
	wikiImportRepoDir = wikiImportTestRepo(t)
	t.Cleanup(func() { wikiImportRepoDir = previous })
}

// wikiImportTestRepo is a repository of two files and one commit (wikiImportTestHead names it).
func wikiImportTestRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for path, text := range map[string]string{"src/app/main.go": "package main\n", "docs/guide.md": "# Guide\n"} {
		full := filepath.Join(dir, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, args := range [][]string{
		{"init", "-q"},
		// Named as the repository a note's absolute paths name it: /root/orbit/docs/guide.md.
		{"remote", "add", "origin", "https://github.com/wikova/orbit.git"},
		{"add", "."},
		{"-c", "user.email=spec@orbit.invalid", "-c", "user.name=spec", "commit", "-q", "-m", "the repository"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	return dir
}

func wikiImportTestHead(t *testing.T) string {
	t.Helper()
	out, err := exec.Command("git", "-C", wikiImportRepoDir, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(out))
}

// memoryLibrary writes a memory directory: each file under its name, with the frontmatter type given.
func memoryLibrary(t *testing.T, files map[string][2]string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "memory")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, file := range files {
		kind, body := file[0], file[1]
		text := body
		if kind != "" {
			text = "---\nname: " + strings.TrimSuffix(name, ".md") + "\ndescription: a test note\nmetadata:\n  type: " + kind +
				"\n  modified: 2026-09-20T10:00:00.000Z\n---\n\n" + body
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// scripted answers each note by its path; notes it names nothing for get [].
func scripted(answers map[string]string) func(prompt string) (int, string) {
	return func(prompt string) (int, string) {
		for path, answer := range answers {
			if strings.Contains(prompt, "==== NOTE ("+path+",") {
				return http.StatusOK, answer
			}
		}
		return http.StatusOK, "[]"
	}
}

func runImport(t *testing.T, args ...string) (string, error) {
	t.Helper()
	var out strings.Builder
	err := cmdWikiCLI(append([]string{"import"}, args...), strings.NewReader(""), &out)
	return out.String(), err
}

func importSummary(t *testing.T, args ...string) (wikiImportSummary, error) {
	t.Helper()
	out, err := runImport(t, append(args, "--json")...)
	var summary wikiImportSummary
	if jsonErr := json.Unmarshal([]byte(strings.TrimSpace(out)), &summary); jsonErr != nil {
		t.Fatalf("the summary is not JSON (%v): %q (run error: %v)", jsonErr, out, err)
	}
	return summary, err
}

func entryOf(op map[string]interface{}) map[string]interface{} {
	entry, _ := op["entry"].(map[string]interface{})
	return entry
}

func titles(ops []map[string]interface{}) []string {
	out := []string{}
	for _, op := range ops {
		title, _ := entryOf(op)["title"].(string)
		out = append(out, title)
	}
	return out
}

// ── One import, end to end ──────────────────────────────────────────────────────────────────────

func TestWikiImportRegistersEachFileAsANoteAndProposesWhatTheModelRead(t *testing.T) {
	library := memoryLibrary(t, map[string][2]string{
		"MEMORY.md":         {"", "- [Rules](feedback-rules.md) — the index, which only repeats the files"},
		"feedback-rules.md": {"feedback", "Reply in Chinese; code stays as it is.\nNever store a secret: the vault key is " + fakeImportSecret + ".\n"},
		"project-status.md": {"project", "The import task is in progress."},
		"reference-release.md": {"reference", "`release.sh next` tags at once: it is not a dry run.\n" +
			"The guard lives in src/app/main.go, and docs/guide.md explains it.\n"},
	})
	door := newFakeImportDoor(t, "tiered")
	// The repository's one commit, named short: set once the session has made the repository.
	var head string
	vllm := newFakeVLLM(t, func(prompt string) (int, string) {
		return scripted(map[string]string{
			"memory/feedback-rules.md": `[{"kind":"convention","title":"Reply in Chinese","summary":"Answer the owner in Chinese; leave code as it is.",` +
				`"rule":"Reply in Chinese","scope":"every reply","exceptions":"","anchors":{"paths":[],"commits":[]},"quote":"Reply in Chinese; code stays as it is."},` +
				`{"kind":"principle","title":"Secrets are never stored","summary":"x","statement":"Never store a secret.","rationale":"It leaks.","quote":"Never store a secret"}]`,
			"memory/reference-release.md": "Here is what I found.\n```json\n" +
				`[{"kind":"pitfall","title":"release.sh next tags at once","summary":"It is not a dry run.",` +
				`"trigger":{"paths":[],"commands":["release.sh next"],"errorSignature":""},"symptom":"A tag appears","cause":"next tags","fix":"Run it only to release",` +
				`"anchors":{"paths":["src/app/main.go","/root/orbit/docs/guide.md","src/does/not/exist.go"],"commits":["` + head[:9] + `","0000000"]},` +
				`"quote":"release.sh next tags at once: it is not a dry run."}]` + "\n```",
		})(prompt)
	})
	spawns := fakeVerifyClaude(t)
	wikiImportSession(t, door, vllm)
	head = wikiImportTestHead(t)

	summary, err := importSummary(t, "--from", library, "--space", "space-1")
	if err != nil {
		t.Fatalf("orbit wiki import: %v", err)
	}

	// Each file one note, the owner's own guidance first, and the library's index never.
	if got := door.Registrations(); !reflect.DeepEqual(got, []string{"memory/feedback-rules.md", "memory/reference-release.md", "memory/project-status.md"}) {
		t.Errorf("registered %v", got)
	}
	// The model read what the server kept — the secret redacted — never the file as it was read.
	requests := vllm.Requests()
	if len(requests) != 3 {
		t.Fatalf("the model was asked %d times, want once per note", len(requests))
	}
	handed := false
	for _, request := range requests {
		if strings.Contains(request.Prompt, fakeImportSecret) {
			t.Errorf("the file's secret reached the model:\n%s", request.Prompt)
		}
		if !strings.Contains(request.System, "You compile durable engineering knowledge") || request.Tools != 0 {
			t.Errorf("the call carried %d tools and the system prompt %s", request.Tools, request.System)
		}
		if strings.Contains(request.Prompt, "==== NOTE (memory/feedback-rules.md, 2026-09-20) ====") {
			handed = strings.Contains(request.Prompt, "the vault key is [redacted].")
		}
	}
	if !handed {
		t.Error("the model was not handed the kept text, under the note's path and date")
	}
	if n := len(spawns()); n != 3 {
		t.Errorf("Claude Code ran %d times, want once per note", n)
	}

	// A dry run first, then the ops that passed it, under a key; every op an add citing its note.
	props := door.Requests()
	if len(props) != 2 || !props[0].DryRun || props[1].DryRun || props[0].Key != "" || !strings.HasPrefix(props[1].Key, "wiki-import:") {
		t.Fatalf("proposals = %#v", props)
	}
	if !reflect.DeepEqual(props[0].Ops, props[1].Ops) {
		t.Error("what was proposed is not what the dry run checked")
	}
	for _, request := range props {
		if request.Session != "caller-session" {
			t.Errorf("a proposal went to the door as %q, not as the session running the import", request.Session)
		}
	}
	ops := door.proposed()
	if got := titles(ops); !reflect.DeepEqual(got, []string{"Reply in Chinese", "release.sh next tags at once"}) {
		t.Fatalf("proposed %v: the principle is the owner's and never proposed", got)
	}
	convention, pitfall := ops[0], ops[1]
	source := convention["sources"].([]interface{})[0].(map[string]interface{})
	if source["kind"] != "note" || source["ref"] != "note-1" || source["quote"] != "Reply in Chinese; code stays as it is." {
		t.Errorf("the convention cites %v", source)
	}
	fields := entryOf(convention)["fields"].(map[string]interface{})
	if !reflect.DeepEqual(fields, map[string]interface{}{"rule": "Reply in Chinese", "scope": []interface{}{"every reply"}}) {
		t.Errorf("the convention's fields = %v: a lone scope is a list of one, and a blank exception is left out", fields)
	}
	// The model dropped the backticks from its quote: the note's own span is cited instead.
	pitfallSource := pitfall["sources"].([]interface{})[0].(map[string]interface{})
	if pitfallSource["quote"] != "`release.sh next` tags at once: it is not a dry run." || pitfallSource["ref"] != "note-2" {
		t.Errorf("the pitfall cites %v", pitfallSource)
	}
	// Only the anchors this checkout has: the paths it holds, made relative, and its commit in full; the
	// made-up path and a sha that names no commit are gone.
	anchors := entryOf(pitfall)["anchors"]
	want := []interface{}{
		map[string]interface{}{"type": "path", "path": "src/app/main.go"},
		map[string]interface{}{"type": "path", "path": "docs/guide.md"},
		map[string]interface{}{"type": "commit", "sha": head},
	}
	if !reflect.DeepEqual(anchors, want) {
		t.Errorf("anchors = %v, want %v", anchors, want)
	}
	if trigger := entryOf(pitfall)["fields"].(map[string]interface{})["trigger"]; !reflect.DeepEqual(trigger, map[string]interface{}{"paths": []interface{}{}, "commands": []interface{}{"release.sh next"}}) {
		t.Errorf("trigger = %v", trigger)
	}

	if summary.NewNotes != 3 || summary.Entries != 2 || summary.Principles != 1 || summary.Proposed != 2 || summary.Applied != 2 ||
		summary.Calls != 3 || summary.Remaining != 0 || summary.Files != 3 {
		t.Errorf("summary = %+v", summary)
	}
}

// ── The review mode's answer, a batch at a time ─────────────────────────────────────────────────

func manyEntries(prefix string, n int) string {
	entries := []string{}
	for i := 1; i <= n; i++ {
		entries = append(entries, fmt.Sprintf(`{"kind":"concept","title":"%s %d","summary":"What %s %d means.","definition":"It is %d.","boundaries":"Not %d.","anchors":{"paths":[],"commits":[]},"quote":"fact"}`,
			prefix, i, prefix, i, i, i+1))
	}
	return "[" + strings.Join(entries, ",") + "]"
}

func TestWikiImportProposesWhatNeedsReviewABatchAtATime(t *testing.T) {
	library := memoryLibrary(t, map[string][2]string{
		"feedback-a.md": {"feedback", "A fact, and another fact."},
		"feedback-b.md": {"feedback", "More fact here."},
	})
	door := newFakeImportDoor(t, "manual")
	vllm := newFakeVLLM(t, scripted(map[string]string{
		"memory/feedback-a.md": strings.Replace(manyEntries("Alpha", 4), `"title":"Alpha 2"`, `"title":"Alpha 2 REFUSE-SCHEMA"`, 1),
		"memory/feedback-b.md": manyEntries("Beta", 4),
	}))
	fakeVerifyClaude(t)
	wikiImportSession(t, door, vllm)

	// Manual: five that wait for review a request. The dry run says which pass; one refused for what it
	// says is dropped, and from the first one refused for room the rest wait for the next run.
	summary, err := importSummary(t, "--from", library, "--space", "space-1", "--concurrency", "2")
	if err != nil {
		t.Fatalf("orbit wiki import: %v", err)
	}
	if got := titles(door.proposed()); !reflect.DeepEqual(got, []string{"Alpha 1", "Alpha 3", "Alpha 4", "Beta 1", "Beta 2"}) {
		t.Fatalf("proposed %v", got)
	}
	if summary.Pending != 5 || summary.Refused != 1 || summary.Deferred != 2 || summary.Remaining != 1 {
		t.Errorf("summary = %+v", summary)
	}
	if len(summary.Refusals) != 1 || summary.Refusals[0].Code != "WIKI_SCHEMA" || summary.Refusals[0].File != "memory/feedback-a.md" {
		t.Errorf("refusals = %+v", summary.Refusals)
	}

	// The next run proposes what waited, and reads nothing again.
	calls := len(vllm.Requests())
	summary, err = importSummary(t, "--from", library, "--space", "space-1")
	if err != nil {
		t.Fatalf("the second run: %v", err)
	}
	if got := titles(door.proposed()); !reflect.DeepEqual(got[5:], []string{"Beta 3", "Beta 4"}) {
		t.Errorf("the second run proposed %v", got[5:])
	}
	if len(vllm.Requests()) != calls || summary.Remaining != 0 || summary.Pending != 2 {
		t.Errorf("the second run asked the model %d more times; summary %+v", len(vllm.Requests())-calls, summary)
	}

	// A queue with no room: nothing can be proposed, so the run says so and exits non-zero.
	door.mu.Lock()
	door.pending, door.queueCap = 30, 30
	door.mu.Unlock()
	more := memoryLibrary(t, map[string][2]string{"feedback-c.md": {"feedback", "The last fact."}})
	vllmAgain := newFakeVLLM(t, scripted(map[string]string{"memory/feedback-c.md": manyEntries("Gamma", 2)}))
	t.Setenv("ANTHROPIC_BASE_URL", vllmAgain.URL)
	summary, err = importSummary(t, "--from", more, "--space", "space-1")
	if err == nil || !strings.Contains(err.Error(), "WIKI_REVIEW_QUEUE_FULL") {
		t.Fatalf("a run with no room = %v, want a stop naming the full queue", err)
	}
	if summary.Proposed != 0 || summary.Deferred != 2 || !strings.Contains(summary.Stopped, "no room") {
		t.Errorf("summary = %+v", summary)
	}
}

func TestWikiImportAppliesAndHoldsAsTheSpacesModeSays(t *testing.T) {
	for _, mode := range []struct {
		name              string
		applied, verifies int
	}{{"tiered", 2, 0}, {"automatic", 0, 2}} {
		t.Run(mode.name, func(t *testing.T) {
			library := memoryLibrary(t, map[string][2]string{"reference-a.md": {"reference", "Two facts."}})
			door := newFakeImportDoor(t, mode.name)
			vllm := newFakeVLLM(t, scripted(map[string]string{"memory/reference-a.md": manyEntries("Fact", 2)}))
			fakeVerifyClaude(t)
			wikiImportSession(t, door, vllm)
			out, err := runImport(t, "--from", library, "--space", "space-1")
			if err != nil {
				t.Fatalf("orbit wiki import: %v\n%s", err, out)
			}
			wantLine := fmt.Sprintf("Proposed 2 ops: %d applied, 0 wait for the owner's review, %d wait for their verification (orbit wiki verify --space space-1)", mode.applied, mode.verifies)
			if !strings.Contains(out, wantLine) {
				t.Errorf("the output does not say %q:\n%s", wantLine, out)
			}
		})
	}
}

// ── Where a run stops, and where the next one starts ────────────────────────────────────────────

func TestWikiImportResumesWhereTheLastRunStopped(t *testing.T) {
	library := memoryLibrary(t, map[string][2]string{
		"feedback-1.md": {"feedback", "fact one"},
		"feedback-2.md": {"feedback", "fact two"},
		"feedback-3.md": {"feedback", "fact three"},
	})
	door := newFakeImportDoor(t, "tiered")
	vllm := newFakeVLLM(t, scripted(map[string]string{
		"memory/feedback-1.md": manyEntries("One", 2),
		"memory/feedback-2.md": manyEntries("Two", 2),
		"memory/feedback-3.md": manyEntries("Three", 2),
	}))
	fakeVerifyClaude(t)
	wikiImportSession(t, door, vllm)
	args := []string{"--from", library, "--space", "space-1", "--max-ops", "3", "--concurrency", "1"}

	first, err := importSummary(t, args...)
	if err != nil {
		t.Fatalf("the first run: %v", err)
	}
	if got := titles(door.proposed()); !reflect.DeepEqual(got, []string{"One 1", "One 2", "Two 1"}) || first.Calls != 2 || first.Remaining != 2 {
		t.Fatalf("the first run proposed %v with %d calls, %d files left", got, first.Calls, first.Remaining)
	}
	second, err := importSummary(t, args...)
	if err != nil {
		t.Fatalf("the second run: %v", err)
	}
	if got := titles(door.proposed()); !reflect.DeepEqual(got[3:], []string{"Two 2", "Three 1", "Three 2"}) || second.Calls != 1 || second.Remaining != 0 {
		t.Fatalf("the second run proposed %v with %d calls, %d files left", got[3:], second.Calls, second.Remaining)
	}
	third, err := importSummary(t, args...)
	if err != nil || third.Calls != 0 || third.Proposed != 0 || len(door.Registrations()) != 3 {
		t.Fatalf("a run with nothing left: %v, %+v, %d registrations", err, third, len(door.Registrations()))
	}

	// A file whose text changed is a new note, read again; the others are left alone.
	if err := os.WriteFile(filepath.Join(library, "feedback-2.md"), []byte("fact two, and now a third"), 0o644); err != nil {
		t.Fatal(err)
	}
	fourth, err := importSummary(t, args...)
	if err != nil || fourth.NewNotes != 1 || fourth.Calls != 1 {
		t.Fatalf("after a change: %v, %+v", err, fourth)
	}
	if got := door.Registrations(); got[len(got)-1] != "memory/feedback-2.md" {
		t.Errorf("registrations %v", got)
	}

	// A machine that remembers nothing — another --state — finds every text already in the space, and
	// neither reads nor proposes any of it again.
	proposedBefore, callsBefore := len(door.proposed()), len(vllm.Requests())
	fresh, err := importSummary(t, append(args, "--state", filepath.Join(t.TempDir(), "elsewhere.json"))...)
	if err != nil || fresh.KnownNotes != 3 || fresh.NewNotes != 0 {
		t.Fatalf("a fresh machine: %v, %+v", err, fresh)
	}
	if len(door.proposed()) != proposedBefore || len(vllm.Requests()) != callsBefore {
		t.Error("a text the space already held was read or proposed from again")
	}
}

func TestWikiImportSendsABatchAgainUnderTheSameKey(t *testing.T) {
	library := memoryLibrary(t, map[string][2]string{"feedback-1.md": {"feedback", "fact one"}})
	door := newFakeImportDoor(t, "tiered")
	vllm := newFakeVLLM(t, scripted(map[string]string{"memory/feedback-1.md": manyEntries("One", 2)}))
	fakeVerifyClaude(t)
	wikiImportSession(t, door, vllm)
	if _, err := importSummary(t, "--from", library, "--space", "space-1"); err != nil {
		t.Fatal(err)
	}
	// The answer to the proposal never reached the machine: its memory still has the ops unanswered.
	statePath := wikiImportDefaultState("space-1", library)
	raw, _ := os.ReadFile(statePath)
	var state wikiImportState
	if err := json.Unmarshal(raw, &state); err != nil {
		t.Fatal(err)
	}
	file := state.Files["memory/feedback-1.md"]
	for i := range file.Ops {
		file.Ops[i].Outcome, file.Ops[i].OpID, file.Ops[i].EntryID = "", "", ""
	}
	file.Status = wikiImportExtracted
	raw, _ = json.Marshal(state)
	if err := os.WriteFile(statePath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := importSummary(t, "--from", library, "--space", "space-1"); err != nil {
		t.Fatal(err)
	}
	var keys []string
	for _, request := range door.Requests() {
		if !request.DryRun {
			keys = append(keys, request.Key)
		}
	}
	if len(keys) != 2 || keys[0] != keys[1] {
		t.Errorf("the batch was sent again under %v: the same ops go under the same key, which the server replays", keys)
	}
}

// ── The endpoint ────────────────────────────────────────────────────────────────────────────────

func TestWikiImportStopsAtTheFirst401(t *testing.T) {
	library := memoryLibrary(t, map[string][2]string{
		"feedback-1.md": {"feedback", "fact one"},
		"feedback-2.md": {"feedback", "fact two"},
	})
	door := newFakeImportDoor(t, "tiered")
	refused := newFakeVLLM(t, func(string) (int, string) { return http.StatusUnauthorized, "" })
	fakeVerifyClaude(t)
	wikiImportSession(t, door, refused)
	_, err := runImport(t, "--from", library, "--space", "space-1", "--concurrency", "1")
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("a refused token = %v, want the run to stop on the 401", err)
	}
	if n := len(refused.Requests()); n != 1 {
		t.Errorf("the endpoint was asked %d times: the first 401 ends the run", n)
	}
	if len(door.Requests()) != 0 {
		t.Error("something was proposed after the 401")
	}
	// With the token right, the next run reads the file it could not, and the rest.
	good := newFakeVLLM(t, scripted(map[string]string{"memory/feedback-1.md": manyEntries("One", 1), "memory/feedback-2.md": manyEntries("Two", 1)}))
	t.Setenv("ANTHROPIC_BASE_URL", good.URL)
	summary, err := importSummary(t, "--from", library, "--space", "space-1")
	if err != nil || summary.Proposed != 2 || summary.Remaining != 0 {
		t.Fatalf("the next run: %v, %+v", err, summary)
	}
}

func TestWikiImportWaitsForTheEndpointToBeHealthy(t *testing.T) {
	library := memoryLibrary(t, map[string][2]string{"feedback-1.md": {"feedback", "fact one"}})
	door := newFakeImportDoor(t, "tiered")
	vllm := newFakeVLLM(t, scripted(map[string]string{"memory/feedback-1.md": manyEntries("One", 1)}))
	target, _ := url.Parse(vllm.URL)
	proxy := httputil.NewSingleHostReverseProxy(target)
	var mu sync.Mutex
	healthChecks, healthyAfter := 0, 2
	tunnel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			mu.Lock()
			healthChecks++
			up := healthChecks > healthyAfter
			mu.Unlock()
			if !up {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
		}
		proxy.ServeHTTP(w, r)
	}))
	t.Cleanup(tunnel.Close)
	fakeVerifyClaude(t)
	wikiImportSession(t, door, vllm)
	t.Setenv("ANTHROPIC_BASE_URL", tunnel.URL)
	previousWait, previousPoll := wikiImportHealthWait, wikiImportHealthPoll
	wikiImportHealthWait, wikiImportHealthPoll = 5*time.Second, 10*time.Millisecond
	t.Cleanup(func() { wikiImportHealthWait, wikiImportHealthPoll = previousWait, previousPoll })

	summary, err := importSummary(t, "--from", library, "--space", "space-1")
	if err != nil || summary.Proposed != 1 {
		t.Fatalf("an endpoint that comes back: %v, %+v", err, summary)
	}
	if healthChecks != healthyAfter+1 || len(vllm.Requests()) != 1 {
		t.Errorf("health asked %d times, the model %d: the run waits for /health 200 and asks nothing before", healthChecks, len(vllm.Requests()))
	}

	// One that never does: nothing is read, the run says why, and the next run starts from there.
	more := memoryLibrary(t, map[string][2]string{"feedback-2.md": {"feedback", "fact two"}})
	mu.Lock()
	healthyAfter = 1 << 30
	mu.Unlock()
	wikiImportHealthWait = 50 * time.Millisecond
	calls := len(vllm.Requests())
	_, err = runImport(t, "--from", more, "--space", "space-1")
	if err == nil || !strings.Contains(err.Error(), "was not ready") || len(vllm.Requests()) != calls {
		t.Fatalf("an endpoint that stays down = %v, with %d calls", err, len(vllm.Requests())-calls)
	}
}

// ── The clean launch ────────────────────────────────────────────────────────────────────────────

func TestWikiImportLaunchesTheVerifiersCleanClaudeCodeWithoutThinking(t *testing.T) {
	library := memoryLibrary(t, map[string][2]string{"feedback-1.md": {"feedback", "fact one"}})
	door := newFakeImportDoor(t, "tiered")
	vllm := newFakeVLLM(t, scripted(map[string]string{"memory/feedback-1.md": manyEntries("One", 1)}))
	spawns := fakeVerifyClaude(t)
	wikiImportSession(t, door, vllm)
	realHome, _ := os.UserHomeDir()
	if _, err := runImport(t, "--from", library, "--space", "space-1"); err != nil {
		t.Fatal(err)
	}
	runs := spawns()
	if len(runs) != 1 {
		t.Fatalf("Claude Code ran %d times, want once", len(runs))
	}
	run := runs[0]
	settings := ""
	for i, arg := range run.Args {
		if arg == "--settings" && i+1 < len(run.Args) {
			settings = run.Args[i+1]
		}
	}
	// The verifier's launch, flag for flag, with the importer's own system prompt.
	want := wikiVerifyClaudeArgs("qwen3.8-27b-fp8", settings)
	for i := range want {
		if want[i] == wikiVerifySystemPrompt {
			want[i] = wikiImportSystemPrompt
		}
	}
	if !reflect.DeepEqual(run.Args, want) {
		t.Fatalf("argv = %#v\nwant %#v", run.Args, want)
	}
	if !strings.Contains(run.Prompt, "==== NOTE (memory/feedback-1.md, 2026-09-20) ====") {
		t.Errorf("the prompt did not arrive on stdin: %q", run.Prompt)
	}
	env := map[string]string{}
	for _, pair := range run.Env {
		if key, value, ok := strings.Cut(pair, "="); ok {
			env[key] = value
		}
	}
	// No thinking, whatever effort the session's provider declared.
	if env["CLAUDE_CODE_EFFORT_LEVEL"] != "unset" || env["MAX_THINKING_TOKENS"] != "0" {
		t.Errorf("CLAUDE_CODE_EFFORT_LEVEL=%q MAX_THINKING_TOKENS=%q: the import reads without thinking", env["CLAUDE_CODE_EFFORT_LEVEL"], env["MAX_THINKING_TOKENS"])
	}
	for key, value := range env {
		switch {
		case key == fakeVerifyClaudeDirEnv:
		case strings.HasPrefix(key, "ORBIT_"):
			t.Errorf("the session's %s=%s reached the clean call", key, value)
		case strings.HasPrefix(key, "CLAUDE_CODE_") && key != "CLAUDE_CODE_MAX_CONTEXT_TOKENS" && key != "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" && key != "CLAUDE_CODE_EFFORT_LEVEL":
			t.Errorf("the session's own Claude Code variable %s=%s reached the clean call", key, value)
		}
	}
	if _, leaked := env["ANTHROPIC_API_KEY"]; leaked {
		t.Error("ANTHROPIC_API_KEY reached the clean call")
	}
	if env["ANTHROPIC_AUTH_TOKEN"] != "tok-local-vllm" || env["ANTHROPIC_BASE_URL"] != vllm.URL {
		t.Errorf("the provider's endpoint and token did not reach it: %v", env)
	}
	for _, dir := range []string{env["HOME"], env["CLAUDE_CONFIG_DIR"]} {
		if dir == "" || dir == realHome || strings.HasPrefix(dir, realHome+"/.claude") {
			t.Errorf("HOME / CLAUDE_CONFIG_DIR = %q: the clean call runs in empty directories of its own", dir)
		}
	}
	request := vllm.Requests()[0]
	if request.Authorization != "Bearer tok-local-vllm" || (request.APIKey != "" && request.APIKey != "tok-local-vllm") {
		t.Errorf("authorized with %q / x-api-key %q", request.Authorization, request.APIKey)
	}
}

// ── What the model answers ──────────────────────────────────────────────────────────────────────

func TestWikiImportReadsTheModelsAnswerTheWayItComes(t *testing.T) {
	entry := `{"kind":"concept","title":"A","summary":"B","definition":"C","boundaries":"D","quote":"E"}`
	for name, answer := range map[string]string{
		"bare":                  "[" + entry + "]",
		"in a fence":            "```json\n[" + entry + "]\n```",
		"after some reasoning":  "Let me think about the note [first] step.\n[" + entry + "]",
		"wrapped":               `{"entries":[` + entry + `]}`,
		"with a trailing comma": "[" + entry + ",]",
		"with a bare quote":     `[{"kind":"concept","title":"A","summary":"B","definition":"C","boundaries":"D","quote":"he said "stop" twice"}]`,
	} {
		entries, ok := parseWikiImportAnswer(answer)
		if !ok || len(entries) != 1 || entries[0]["title"] != "A" {
			t.Errorf("%s: parsed %v, %v", name, entries, ok)
		}
	}
	if entries, ok := parseWikiImportAnswer("Nothing here is worth keeping.\n[]"); !ok || len(entries) != 0 {
		t.Errorf("[] is an answer of no entries: %v %v", entries, ok)
	}
	for _, answer := range []string{"I cannot tell.", `{"verdict":"supported"}`, "[1, 2, 3]"} {
		if entries, ok := parseWikiImportAnswer(answer); ok {
			t.Errorf("%q read as entries: %v", answer, entries)
		}
	}
}

func TestWikiImportCitesTheNotesOwnWords(t *testing.T) {
	note := "Run `scripts/run-pg-spec.sh`   before you\ntrust a green **pg spec**: “a skip is red”."
	for quote, want := range map[string]string{
		"Run `scripts/run-pg-spec.sh` before you trust": "Run `scripts/run-pg-spec.sh` before you trust",
		"Run scripts/run-pg-spec.sh before you trust":   "Run `scripts/run-pg-spec.sh`   before you\ntrust",
		"trust a green pg spec":                         "trust a green **pg spec**",
		"Run scripts/run-pg-spec.sh":                    "Run `scripts/run-pg-spec.sh`",
		`"a skip is red"`:                               "“a skip is red”",
	} {
		got, ok := wikiImportQuote(note, quote)
		if !ok || got != want {
			t.Errorf("quote %q = %q, %v; want %q", quote, got, ok, want)
		}
		// Whatever is cited, the note holds it — the check the server makes.
		if collapse := func(s string) string { return strings.Join(strings.Fields(s), " ") }; !strings.Contains(collapse(note), collapse(got)) {
			t.Errorf("%q is not the note's own words", got)
		}
	}
	for _, quote := range []string{"", "a paraphrase the note never says"} {
		if got, ok := wikiImportQuote(note, quote); ok {
			t.Errorf("quote %q = %q: a quote the note does not hold is left out", quote, got)
		}
	}
}

func TestWikiImportHoldsEachEntryToItsKindsFields(t *testing.T) {
	note := wikiImportNote{id: "note-9", path: "memory/x.md", date: "2026-09-20", text: "the note's text: run `make`"}
	decision := map[string]interface{}{"kind": "decision", "title": strings.Repeat("t", 150), "summary": "s", "context": "c", "decision": "d",
		"alternatives": map[string]interface{}{"option": "o", "whyRejected": "w"}, "consequences": "q", "decidedAt": "2026-13-45"}
	op, problems := wikiImportOpFrom(decision, "decision", note, nil)
	if len(problems) > 0 {
		t.Fatalf("problems: %v", problems)
	}
	draft := entryOf(op.Body)
	fields := draft["fields"].(map[string]interface{})
	if len([]rune(draft["title"].(string))) != 120 || fields["decidedAt"] != "2026-09-20" ||
		!reflect.DeepEqual(fields["alternatives"], []interface{}{map[string]interface{}{"option": "o", "whyRejected": "w"}}) {
		t.Errorf("the decision = %v: a title cut to 120, a date that is not one read as the note's, one alternative a list of one", draft)
	}
	recipe := map[string]interface{}{"kind": "recipe", "title": "t", "summary": "s", "fields": map[string]interface{}{"steps": []interface{}{"a", " ", "b"}, "verify": map[string]interface{}{"command": "make", "expectedExit": "2"}}}
	op, problems = wikiImportOpFrom(recipe, "recipe", note, nil)
	if len(problems) > 0 || !reflect.DeepEqual(entryOf(op.Body)["fields"], map[string]interface{}{"steps": []interface{}{"a", "b"}, "verify": map[string]interface{}{"command": "make", "expectedExit": 2}}) {
		t.Errorf("the recipe = %v (%v): fields nested or flat, blanks left out, an exit code written as text", entryOf(op.Body), problems)
	}
	for kind, entry := range map[string]map[string]interface{}{
		"pitfall":    {"title": "t", "summary": "s", "trigger": map[string]interface{}{"paths": []interface{}{}}, "symptom": "a", "cause": "b", "fix": "c"},
		"convention": {"title": "t", "summary": "s", "rule": "r"},
		"concept":    {"title": "", "summary": "s", "definition": "d", "boundaries": "b"},
		"assumption": {"title": "t", "summary": "s"},
	} {
		if _, problems := wikiImportOpFrom(entry, kind, note, nil); len(problems) == 0 {
			t.Errorf("a %s missing what it needs was let through", kind)
		}
	}
}

func TestWikiImportAsksOnceMoreWithWhatWasWrong(t *testing.T) {
	library := memoryLibrary(t, map[string][2]string{
		"feedback-1.md": {"feedback", "fact one"},
		"feedback-2.md": {"feedback", "fact two"},
	})
	door := newFakeImportDoor(t, "tiered")
	vllm := newFakeVLLM(t, func(prompt string) (int, string) {
		retry := strings.Contains(prompt, "SOME ENTRIES IN YOUR ANSWER WERE REJECTED")
		switch {
		case strings.Contains(prompt, "==== NOTE (memory/feedback-1.md,") && retry:
			return http.StatusOK, `[{"kind":"convention","title":"Keep it","summary":"s","rule":"Keep it","scope":["here"]}]`
		case strings.Contains(prompt, "==== NOTE (memory/feedback-1.md,"):
			return http.StatusOK, `[{"kind":"convention","title":"Keep it","summary":"s","rule":"Keep it"},` +
				`{"kind":"concept","title":"Also","summary":"s","definition":"d","boundaries":"b"}]`
		default:
			return http.StatusOK, "I would rather not."
		}
	})
	fakeVerifyClaude(t)
	wikiImportSession(t, door, vllm)
	summary, err := importSummary(t, "--from", library, "--space", "space-1", "--concurrency", "1")
	if err != nil {
		t.Fatalf("orbit wiki import: %v", err)
	}
	requests := vllm.Requests()
	if len(requests) != 4 {
		t.Fatalf("the model was asked %d times: once per file, and once more for each answer that did not hold up", len(requests))
	}
	if !strings.Contains(requests[1].Prompt, `entry "Keep it": scope is missing`) {
		t.Errorf("the second ask does not say what was wrong:\n%s", requests[1].Prompt)
	}
	if !strings.Contains(requests[3].Prompt, "YOUR ANSWER WAS NOT A JSON ARRAY") {
		t.Errorf("the second ask of an unreadable answer does not say so:\n%s", requests[3].Prompt)
	}
	if got := titles(door.proposed()); !reflect.DeepEqual(got, []string{"Also", "Keep it"}) {
		t.Errorf("proposed %v: the corrected entry joins the one that held up", got)
	}
	if summary.Failed != 1 || summary.Dropped != 0 || summary.Remaining != 0 {
		t.Errorf("summary = %+v: a file the model never answered readably is failed, and not read again", summary)
	}
}

func TestWikiImportTitlesAChineseNotesEntriesInChinese(t *testing.T) {
	library := memoryLibrary(t, map[string][2]string{
		"feedback-zh.md": {"feedback", "发版前先核对 `origin/main`：别直接给会话分支打 tag，否则客户端会倒退。\n"},
		"feedback-en.md": {"feedback", "Check `origin/main` before tagging a release.\n"},
	})
	door := newFakeImportDoor(t, "tiered")
	vllm := newFakeVLLM(t, func(prompt string) (int, string) {
		retry := strings.Contains(prompt, "SOME ENTRIES IN YOUR ANSWER WERE REJECTED")
		switch {
		case strings.Contains(prompt, "==== NOTE (memory/feedback-zh.md,") && retry:
			return http.StatusOK, `[{"kind":"convention","title":"发版前先核对 origin/main","summary":"别给会话分支打 tag。","rule":"先核对 origin/main 再打 tag","scope":["发版"]}]`
		case strings.Contains(prompt, "==== NOTE (memory/feedback-zh.md,"):
			return http.StatusOK, `[{"kind":"convention","title":"Check origin/main before a release","summary":"别给会话分支打 tag。","rule":"先核对 origin/main 再打 tag","scope":["发版"]}]`
		default:
			return http.StatusOK, `[{"kind":"convention","title":"Check origin/main before tagging","summary":"Never tag a session branch.","rule":"Check origin/main first","scope":["releases"]}]`
		}
	})
	fakeVerifyClaude(t)
	wikiImportSession(t, door, vllm)
	if _, err := importSummary(t, "--from", library, "--space", "space-1", "--concurrency", "1"); err != nil {
		t.Fatalf("orbit wiki import: %v", err)
	}
	requests := vllm.Requests()
	if len(requests) != 3 {
		t.Fatalf("the model was asked %d times: once per note, and once more for the English title", len(requests))
	}
	const line = "This note is written in Chinese: write every title, summary and text field in Chinese"
	for _, request := range requests {
		chinese := strings.Contains(request.Prompt, "==== NOTE (memory/feedback-zh.md,")
		if strings.Contains(request.Prompt, line) != chinese {
			t.Errorf("the language line is %v in the prompt for a note that is Chinese: %v", !chinese, chinese)
		}
	}
	asked := false
	for _, request := range requests {
		asked = asked || strings.Contains(request.Prompt, `entry "Check origin/main before a release": title is not in the note's language`)
	}
	if !asked {
		t.Error("no second ask says the Chinese note's title is in the wrong language")
	}
	if got := titles(door.proposed()); !reflect.DeepEqual(got, []string{"Check origin/main before tagging", "发版前先核对 origin/main"}) {
		t.Errorf("proposed %v: the Chinese note's entry in Chinese, the English note's in English", got)
	}
}

func TestWikiImportReadsANotesLanguageFromItsProse(t *testing.T) {
	for text, want := range map[string]string{
		"发版前先核对 `origin/main`，再跑 `.claude/skills/release/release.sh next`。":                                                          "Chinese",
		"---\nname: x\ndescription: 中文的描述\n---\nThe body is English prose about the release script, with one word in Chinese: 发版.\n": "",
		"```\n中文 inside a code block only\n```\nThe rest is English prose about the release script.":                                 "",
		"Run it twice.": "",
		"":              "",
	} {
		if got := wikiImportNoteLanguage(text); got != want {
			t.Errorf("wikiImportNoteLanguage(%q) = %q, want %q", text, got, want)
		}
	}
}

func TestWikiImportTakesAVerifyCommandOnlyAsTheNoteWritesIt(t *testing.T) {
	note := wikiImportNote{id: "note-7", path: "memory/x.md", date: "2026-09-20",
		text: "开工先在 main 上取 full-api 基线，见 [[full-api-red-on-main]]：\n```bash\n$ npm run test:full-api   -- --main\n```\n再跑 `git status --short`。\n"}
	recipe := func(command string) map[string]interface{} {
		return map[string]interface{}{"kind": "recipe", "title": "取基线", "summary": "s", "steps": []interface{}{"a"},
			"verify": map[string]interface{}{"command": command, "expectedExit": 0}}
	}
	for _, command := range []string{"npm run test:full-api -- --main", "$ npm run test:full-api -- --main", "git status --short"} {
		if _, problems := wikiImportOpFrom(recipe(command), "recipe", note, nil); len(problems) > 0 {
			t.Errorf("the note's own command %q was refused: %v", command, problems)
		}
	}
	// A description, a command the note never writes, and two spans of its prose that are no command.
	for _, command := range []string{"full-api on main", "npm run test:full-api -- --branch", "见 [[full-api-red-on-main]]", "full-api-red-on-main"} {
		_, problems := wikiImportOpFrom(recipe(command), "recipe", note, nil)
		if len(problems) != 1 || !strings.Contains(problems[0], "is not a command the note gives") {
			t.Errorf("verify.command %q was let through (%v): only a command the note writes is one", command, problems)
		}
	}
}

func TestWikiImportLeavesOutWhatIsNotANote(t *testing.T) {
	library := memoryLibrary(t, map[string][2]string{
		"feedback-ok.md":      {"feedback", "fact"},
		"feedback-empty.md":   {"", "   \n"},
		"feedback-long.md":    {"", strings.Repeat("x", wikiImportNoteMaxChars+1)},
		"notes.txt":           {"", "not Markdown"},
		".hidden.md":          {"", "hidden"},
		"feedback-refused.md": {"feedback", "the server will not take this one"},
	})
	if err := os.WriteFile(filepath.Join(library, "feedback-binary.md"), []byte{0xff, 0xfe, 0x00, 0x41}, 0o644); err != nil {
		t.Fatal(err)
	}
	door := newFakeImportDoor(t, "tiered")
	door.refusePaths["memory/feedback-refused.md"] = true
	vllm := newFakeVLLM(t, scripted(map[string]string{"memory/feedback-ok.md": manyEntries("Ok", 1)}))
	fakeVerifyClaude(t)
	wikiImportSession(t, door, vllm)
	summary, err := importSummary(t, "--from", library, "--space", "space-1")
	if err != nil {
		t.Fatalf("orbit wiki import: %v", err)
	}
	if got := door.Registrations(); !reflect.DeepEqual(got, []string{"memory/feedback-ok.md", "memory/feedback-refused.md"}) {
		t.Errorf("registered %v", got)
	}
	if summary.Skipped != 4 || summary.Proposed != 1 || summary.Files != 5 || summary.Remaining != 0 {
		t.Errorf("summary = %+v: the empty, the too long, the binary and the refused file are left out", summary)
	}
	// One file on its own is imported under its own name.
	single := filepath.Join(t.TempDir(), "CLAUDE.md")
	if err := os.WriteFile(single, []byte("Agents read this first."), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := importSummary(t, "--from", single, "--space", "space-1"); err != nil {
		t.Fatal(err)
	}
	if got := door.Registrations(); got[len(got)-1] != "CLAUDE.md" {
		t.Errorf("a single file registered as %q", got[len(got)-1])
	}
}

// ── The command, its words, and who may run it ──────────────────────────────────────────────────

func TestWikiImportNeedsASessionTheSwitchAndItsFlags(t *testing.T) {
	t.Setenv("ORBIT_SESSION_ID", "")
	t.Setenv(envWiki, "on")
	if _, err := runImport(t, "--from", "x", "--space", "s1"); err == nil || !strings.Contains(err.Error(), "ORBIT_SESSION_ID") {
		t.Errorf("outside a session = %v", err)
	}
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envWiki, "off")
	if _, err := runImport(t, "--from", "x", "--space", "s1"); err == nil || !strings.Contains(err.Error(), "ORBIT_WIKI=off") {
		t.Errorf("with the wiki off = %v", err)
	}
	t.Setenv(envWiki, "on")
	for _, args := range [][]string{
		{"--space", "s1"},
		{"--from", "x"},
		{"--from", "x", "--space", "s1", "--max-ops", "31"},
		{"--from", "x", "--space", "s1", "--concurrency", "0"},
		{"--from", "x", "--space", "a/b"},
	} {
		if _, err := runImport(t, args...); err == nil {
			t.Errorf("orbit wiki import %v was taken", args)
		}
	}
	var help strings.Builder
	if err := cmdWikiCLI([]string{"import", "--help"}, strings.NewReader(""), &help); err != nil || help.String() != wikiImportHelp {
		t.Errorf("orbit wiki import --help = %v, %q", err, help.String())
	}
	if !strings.Contains(wikiHelp, "orbit wiki import --from <dir|file> --space ID") {
		t.Error("`orbit wiki --help` does not list the import")
	}
}

func TestWikiImportIsTheContractsAndIsPreApproved(t *testing.T) {
	imports := wikiContract(t)["import"].(map[string]interface{})
	cli := imports["cli"].(map[string]interface{})
	if cli["precondition"] != wikiImportPrecondition {
		t.Errorf("the precondition this binary ships is not the contract's:\n here: %q\n there: %q", wikiImportPrecondition, cli["precondition"])
	}
	rules := imports["rules"].(map[string]interface{})
	for name, value := range map[string]int{"entriesPerNote": wikiImportEntriesPerNote, "opsPerRun": wikiImportOpsPerRun, "noteMaxChars": wikiImportNoteMaxChars} {
		if int(rules[name].(float64)) != value {
			t.Errorf("import.rules.%s is %v in the contract and %d here", name, rules[name], value)
		}
	}
	routes := wikiSurface(t)["doors"].(map[string]interface{})["runner"].(map[string]interface{})["importRoutes"]
	if !reflect.DeepEqual(routes, []interface{}{"POST /api/runner/wiki/spaces/:id/notes", "POST /api/runner/wiki/spaces/:id/imports"}) {
		t.Errorf("the contract's import routes are %v", routes)
	}
	if wikiToolNames["wiki_import"] {
		t.Error("the import runs a model, which is a runner's work, and no MCP tool")
	}

	spec := wikiImportCLICapabilities[0]
	if spec.Tool != "wiki_import" || !reflect.DeepEqual(spec.Argv, []string{"orbit", "wiki", "import"}) || !spec.SessionOnly || !spec.Mutates {
		t.Fatalf("the capability is %#v", spec)
	}
	if !strings.HasPrefix(spec.Description, wikiImportPrecondition) || !strings.Contains(wikiImportHelp, wikiImportPrecondition) {
		t.Error("the description or the help does not lead with the precondition")
	}
	if strings.Index(wikiImportHelp, wikiImportPrecondition) > strings.Index(wikiImportHelp, "Each file is registered") {
		t.Error("the help states the mechanics before the precondition")
	}
	for _, phrase := range []string{"never write an entry yourself", "A principle is never proposed", "at most 30 a run", "stops at the first 401"} {
		if !strings.Contains(spec.Description, phrase) {
			t.Errorf("the description does not say %q", phrase)
		}
	}
	// Every flag it advertises is one the parser takes, documented in its help and named in its schema.
	fs := flag.NewFlagSet("orbit wiki import", flag.ContinueOnError)
	for _, name := range []string{"from", "space", "model", "state"} {
		fs.String(name, "", "")
	}
	fs.Int("max-ops", 0, "")
	fs.Int("concurrency", 0, "")
	fs.Bool("json", false, "")
	advertised := []string{}
	for _, argument := range spec.Arguments {
		for _, word := range strings.Fields(argument) {
			if strings.HasPrefix(word, "--") {
				name := strings.TrimPrefix(word, "--")
				advertised = append(advertised, name)
				if fs.Lookup(name) == nil || !strings.Contains(wikiImportHelp, "--"+name) {
					t.Errorf("--%s is advertised and is not parsed and documented", name)
				}
			}
		}
	}
	properties, _ := spec.InputSchema["properties"].(map[string]interface{})
	names := []string{}
	for name := range properties {
		names = append(names, name)
		if fs.Lookup(name) == nil {
			t.Errorf("the schema names --%s, which the parser does not take", name)
		}
	}
	sort.Strings(names)
	if !reflect.DeepEqual(names, []string{"concurrency", "from", "max-ops", "model", "space", "state"}) || !reflect.DeepEqual(spec.InputSchema["required"], []string{"from", "space"}) {
		t.Errorf("the schema = %#v", spec.InputSchema)
	}
	if len(advertised) != 7 {
		t.Errorf("advertised %v", advertised)
	}
	// Pre-approved for the session it runs in, as the other wiki verbs are.
	exe := "/usr/local/bin/orbit"
	if rules := strings.Join(orbitCLIAllowedTools(exe, false), "\n"); !strings.Contains(rules, "Bash("+exe+" wiki import *)") {
		t.Errorf("orbit wiki import is advertised and pre-approved for nobody: %q", rules)
	}
}
