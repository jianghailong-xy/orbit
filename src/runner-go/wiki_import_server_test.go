package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// `orbit wiki import` when the server reads (contract `import.server`, wiki_import_server.go): the
// command's half of it. The server's half — the job that reads the notes with the System model and
// proposes what it found — is src/apiserver/src/wiki-worker/wiki-import-job.pg.spec.ts; here a fake door
// plays it, registering notes as the real one does (the fake import door's own note route) and answering
// the job routes from a script, so a test can hold the command to what it hands the job and to what it
// makes of the report.

// fakeImportServer is the door when the account's wiki runs on the server.
type fakeImportServer struct {
	door *fakeImportDoor
	URL  string
	mu   sync.Mutex
	// executor is what GET .../import answers; modelState what every read of a job says of the model.
	executor   string
	modelState string
	// jobs are the jobs made, by id, in order; run turns a job's input into its report.
	jobs  []fakeImportJob
	run   func(input fakeImportJobInput) map[string]interface{}
	reads int
	// failWith ends the next job failed, with this error; retries holds every job queued, tried that many times.
	failWith string
	retries  int
	// probeMissing answers the executor route 404, as a server never asked by an older command looks to it;
	// probeFails answers it 500.
	probeMissing bool
	probeFails   bool
	// bodies are the note registrations as they arrived.
	bodies []map[string]interface{}
}

type fakeImportJobInput struct {
	ID           string              `json:"id"`
	MaxOps       int                 `json:"maxOps"`
	Concurrency  int                 `json:"concurrency"`
	CheckoutRoot string              `json:"checkoutRoot"`
	Notes        []wikiImportJobNote `json:"notes"`
}

type fakeImportJob struct {
	input fakeImportJobInput
	reads int
}

func newFakeImportServer(t *testing.T, run func(input fakeImportJobInput) map[string]interface{}) *fakeImportServer {
	t.Helper()
	door := &fakeImportDoor{mode: "tiered", queueCap: 30, refusePaths: map[string]bool{}, notes: map[string]map[string]interface{}{}, answers: map[string][]byte{}}
	s := &fakeImportServer{door: door, executor: "server", modelState: "up", run: run}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		w.Header().Set("content-type", "application/json")
		raw, _ := io.ReadAll(r.Body)
		const space = "/api/runner/wiki/spaces/space-1"
		switch {
		case r.Method == http.MethodPost && r.URL.Path == space+"/notes":
			var body map[string]interface{}
			_ = json.Unmarshal(raw, &body)
			s.bodies = append(s.bodies, body)
			if s.executor == "server" && body["readBy"] != "server" {
				// The server reads this account's notes: a command that would read one itself is refused.
				w.WriteHeader(http.StatusConflict)
				_, _ = w.Write([]byte(`{"code":"WIKI_SERVER_EXECUTES","message":"this account's wiki import runs on the Orbit server"}`))
				return
			}
			if s.executor != "server" {
				door.note(w, raw)
				return
			}
			// What the server reads is not handed back.
			recorder := httptest.NewRecorder()
			door.note(recorder, raw)
			var answer map[string]interface{}
			_ = json.Unmarshal(recorder.Body.Bytes(), &answer)
			delete(answer, "text")
			_ = json.NewEncoder(w).Encode(answer)
		case r.Method == http.MethodGet && r.URL.Path == space+"/import" && s.probeMissing:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Cannot GET"}`))
		case r.Method == http.MethodGet && r.URL.Path == space+"/import" && s.probeFails:
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"message":"Internal server error"}`))
		case r.Method == http.MethodGet && r.URL.Path == space+"/import":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"executor": s.executor, "model": "qwen3-system", "modelState": s.modelState})
		case r.Method == http.MethodPost && r.URL.Path == space+"/import-jobs":
			var input fakeImportJobInput
			if err := json.Unmarshal(raw, &input); err != nil {
				t.Errorf("a job body that is not JSON: %s", raw)
			}
			for _, job := range s.jobs {
				if job.input.ID == input.ID {
					_ = json.NewEncoder(w).Encode(map[string]interface{}{"id": input.ID, "state": "queued"})
					return
				}
			}
			s.jobs = append(s.jobs, fakeImportJob{input: input})
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"id": input.ID, "state": "queued"})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, space+"/import-jobs/"):
			s.reads++
			id := strings.TrimPrefix(r.URL.Path, space+"/import-jobs/")
			for i := range s.jobs {
				job := &s.jobs[i]
				if job.input.ID != id {
					continue
				}
				job.reads++
				answer := map[string]interface{}{"id": id, "model": map[string]interface{}{"name": "qwen3-system", "state": s.modelState}}
				switch {
				case s.retries > 0:
					answer["state"], answer["startedAt"], answer["attempts"], answer["error"] = "queued", "2026-10-08T00:00:00.000Z", s.retries, "REPO_OP_WAIT: the census"
				case s.modelState != "up" || job.reads == 1:
					// A model that is away holds the job where it is; and every job is queued when first read.
					answer["state"], answer["startedAt"] = "queued", nil
				case s.failWith != "":
					answer["state"], answer["error"] = "failed", s.failWith
					s.failWith = ""
				default:
					answer["state"], answer["startedAt"], answer["report"] = "succeeded", "2026-10-08T00:00:00.000Z", s.run(job.input)
				}
				_ = json.NewEncoder(w).Encode(answer)
				return
			}
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"no such import job","statusCode":404}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Cannot ` + r.Method + `"}`))
		}
	}))
	t.Cleanup(srv.Close)
	s.URL = srv.URL
	return s
}

func (s *fakeImportServer) Jobs() []fakeImportJobInput {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []fakeImportJobInput{}
	for _, job := range s.jobs {
		out = append(out, job.input)
	}
	return out
}

// wikiImportServerSession is wikiImportSession with the door the server's, and no model of the session's:
// the server reads, so nothing of ANTHROPIC_* is needed, and a Claude Code that ran would be a failure.
func wikiImportServerSession(t *testing.T, server *fakeImportServer) func() []fakeVerifySpawn {
	t.Helper()
	spawns := fakeVerifyClaude(t)
	home := t.TempDir()
	config := `{"serverUrl":` + strconv.Quote(server.URL) + `,"runnerId":"r1","runnerToken":"runner-token","name":"test"}`
	if err := os.WriteFile(home+"/config.json", []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ORBIT_HOME", home)
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envWiki, "on")
	for _, name := range []string{"ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", "ANTHROPIC_API_KEY"} {
		t.Setenv(name, "")
	}
	previous, previousPoll := wikiImportRepoDir, wikiImportJobPoll
	wikiImportRepoDir = wikiImportTestRepo(t)
	wikiImportJobPoll = 5 * time.Millisecond
	t.Cleanup(func() { wikiImportRepoDir, wikiImportJobPoll = previous, previousPoll })
	return spawns
}

// readAll is a run that reads every note it is handed and finds `found[file]` entries in it, proposing all
// of them up to the run's room (as `applied`, in a tiered space): the report a job of the server makes.
func readAll(found map[string]int) func(input fakeImportJobInput) map[string]interface{} {
	return func(input fakeImportJobInput) map[string]interface{} {
		notes := []interface{}{}
		summary := map[string]interface{}{"refusals": []interface{}{}, "stopped": ""}
		count := func(key string, n int) {
			was, _ := summary[key].(int)
			summary[key] = was + n
		}
		room := input.MaxOps
		for _, note := range input.Notes {
			ops := []interface{}{}
			status := "read"
			if len(note.Ops) > 0 {
				status = "carried"
				for _, op := range note.Ops {
					outcome := ""
					if room > 0 {
						outcome, room = "applied", room-1
						count("applied", 1)
						count("proposed", 1)
					}
					ops = append(ops, map[string]interface{}{"index": op.Index, "outcome": outcome})
				}
			} else {
				count("read", 1)
				count("calls", 1)
				count("inputTokens", 100)
				count("outputTokens", 20)
				for i := 0; i < found[note.File]; i++ {
					outcome := ""
					if room > 0 {
						outcome, room = "applied", room-1
						count("applied", 1)
						count("proposed", 1)
					}
					count("entries", 1)
					body := map[string]interface{}{"op": "add", "entry": map[string]interface{}{"kind": "concept", "title": fmt.Sprintf("%s %d", note.File, i+1)},
						"sources": []interface{}{map[string]interface{}{"kind": "note", "ref": note.NoteID}}}
					ops = append(ops, map[string]interface{}{"index": i, "body": body, "outcome": outcome, "opId": fmt.Sprintf("op-%s-%d", note.File, i)})
				}
			}
			notes = append(notes, map[string]interface{}{"file": note.File, "noteId": note.NoteID, "status": status, "principles": 0, "dropped": 0, "ops": ops})
			if room == 0 {
				break
			}
		}
		return map[string]interface{}{"kind": "import", "model": "qwen3-system", "snapshot": nil, "summary": summary, "notes": notes}
	}
}

func TestWikiImportOnTheServerHandsTheNotesToTheServersJob(t *testing.T) {
	library := memoryLibrary(t, map[string][2]string{
		"MEMORY.md":            {"", "- [Rules](feedback-rules.md) — the index, which only repeats the files"},
		"feedback-rules.md":    {"feedback", "Reply in Chinese.\nThe vault key is " + fakeImportSecret + ".\n"},
		"project-status.md":    {"project", "The import task is in progress."},
		"reference-release.md": {"reference", "`release.sh next` tags at once."},
	})
	server := newFakeImportServer(t, readAll(map[string]int{"memory/feedback-rules.md": 1, "memory/reference-release.md": 2}))
	spawns := wikiImportServerSession(t, server)

	out, err := runImport(t, "--from", library, "--space", "space-1")
	if err != nil {
		t.Fatalf("orbit wiki import: %v\n%s", err, out)
	}
	// The files still go to the server as notes, the owner's own guidance first and the index never; and no
	// model of this machine's is asked anything.
	if got := server.door.Registrations(); !reflect.DeepEqual(got, []string{"memory/feedback-rules.md", "memory/reference-release.md", "memory/project-status.md"}) {
		t.Errorf("registered %v", got)
	}
	if n := len(spawns()); n != 0 {
		t.Errorf("Claude Code ran %d times: the server reads", n)
	}
	for _, body := range server.bodies {
		if body["readBy"] != "server" {
			t.Errorf("a registration did not say the server reads it: %v", body["path"])
		}
	}
	// One job, handed every note in the order the run would read them, each with its id, its file and its date.
	jobs := server.Jobs()
	if len(jobs) != 1 {
		t.Fatalf("%d jobs were made", len(jobs))
	}
	job := jobs[0]
	if job.MaxOps != 30 || job.Concurrency != 4 || job.CheckoutRoot != wikiImportRepoDir {
		t.Errorf("the job was made with %d ops, %d at once, from %q", job.MaxOps, job.Concurrency, job.CheckoutRoot)
	}
	files := []string{}
	for _, note := range job.Notes {
		files = append(files, note.File)
		if note.Date != "2026-09-20" || !strings.HasPrefix(note.NoteID, "note-") || len(note.Ops) != 0 {
			t.Errorf("a note handed as %+v", note)
		}
	}
	if !reflect.DeepEqual(files, []string{"memory/feedback-rules.md", "memory/reference-release.md", "memory/project-status.md"}) {
		t.Errorf("the notes went in as %v", files)
	}
	// What it prints is the report's, and says which job it was.
	for _, line := range []string{
		"Imported from " + library + " into space space-1: 3 files registered as new notes, 0 files already in the space, 0 files left out.",
		"The model found 3 entries.",
		"Proposed 3 ops: 3 applied, 0 wait for the owner's review, 0 wait for their verification (orbit wiki verify --space space-1).",
		"Model qwen3-system: 3 calls, 300 tokens in and 60 out",
		"Read on the Orbit server: import job " + job.ID + ".",
		"memory/reference-release.md: 2 entries",
		"memory/project-status.md: nothing worth an entry",
		"Every file under " + library + " is imported.",
	} {
		if !strings.Contains(out, line) {
			t.Errorf("the output does not say %q:\n%s", line, out)
		}
	}
	// Remembered here as a run on this machine would remember it: every file done, and the job collected.
	state, err := loadWikiImportState(wikiImportDefaultState("space-1", library), "space-1", library)
	if err != nil {
		t.Fatal(err)
	}
	if state.Job != "" || state.Calls != 3 {
		t.Errorf("the state remembers job %q and %d calls", state.Job, state.Calls)
	}
	for rel, file := range state.Files {
		if file.Status != wikiImportDone {
			t.Errorf("%s is %s", rel, file.Status)
		}
	}
	if ops := state.Files["memory/reference-release.md"].Ops; len(ops) != 2 || ops[1].OpID != "op-memory/reference-release.md-1" || ops[1].Outcome != "applied" {
		t.Errorf("the ops remembered are %+v", ops)
	}
}

func TestWikiImportOnTheServerPrintsTheJobsReportAsItIs(t *testing.T) {
	library := memoryLibrary(t, map[string][2]string{"feedback-a.md": {"feedback", "A fact."}})
	report := map[string]interface{}{
		"kind": "import", "model": "qwen3-system",
		"summary": map[string]interface{}{
			"entries": 6, "principles": 1, "dropped": 2, "failed": 0, "proposed": 3, "applied": 0, "pending": 2, "verifying": 1,
			"refused": 1, "deferred": 2, "calls": 2, "inputTokens": 1234, "outputTokens": 567,
			"refusals": []interface{}{map[string]interface{}{"file": "memory/feedback-a.md", "title": "Alpha 2", "code": "WIKI_SCHEMA", "why": "the title is blank"}},
			"stopped":  "",
		},
		"notes": []interface{}{},
	}
	server := newFakeImportServer(t, func(fakeImportJobInput) map[string]interface{} { return report })
	wikiImportServerSession(t, server)
	summary, err := importSummary(t, "--from", library, "--space", "space-1")
	if err != nil {
		t.Fatalf("orbit wiki import: %v", err)
	}
	want := wikiImportSummary{
		SpaceID: "space-1", From: library, Model: "qwen3-system", State: summary.State, Files: 1, Remaining: 1, NewNotes: 1,
		Entries: 6, Principles: 1, Dropped: 2, Proposed: 3, Pending: 2, Verifying: 1, Refused: 1, Deferred: 2,
		Calls: 2, InputTokens: 1234, OutputTokens: 567, Seconds: summary.Seconds, Job: server.Jobs()[0].ID,
		Refusals: []wikiImportRefusal{{File: "memory/feedback-a.md", Title: "Alpha 2", Code: "WIKI_SCHEMA", Why: "the title is blank"}},
	}
	if !reflect.DeepEqual(summary, want) {
		t.Errorf("the summary is not the report's:\n got %+v\nwant %+v", summary, want)
	}
}

func TestWikiImportOnTheServerCarriesWhatWaitedToTheNextJob(t *testing.T) {
	library := memoryLibrary(t, map[string][2]string{
		"feedback-1.md": {"feedback", "fact one"},
		"feedback-2.md": {"feedback", "fact two"},
		"feedback-3.md": {"feedback", "fact three"},
	})
	server := newFakeImportServer(t, readAll(map[string]int{"memory/feedback-1.md": 2, "memory/feedback-2.md": 2, "memory/feedback-3.md": 2}))
	wikiImportServerSession(t, server)
	args := []string{"--from", library, "--space", "space-1", "--max-ops", "3", "--concurrency", "1"}

	first, err := importSummary(t, args...)
	if err != nil || first.Proposed != 3 || first.Remaining != 2 {
		t.Fatalf("the first run: %v, %+v", err, first)
	}
	// The next job carries the op the first did not propose, at its index, and the note it did not reach.
	second, err := importSummary(t, args...)
	if err != nil || second.Proposed != 3 || second.Remaining != 0 {
		t.Fatalf("the second run: %v, %+v", err, second)
	}
	jobs := server.Jobs()
	if len(jobs) != 2 {
		t.Fatalf("%d jobs", len(jobs))
	}
	handed := jobs[1].Notes
	if len(handed) != 2 || handed[0].File != "memory/feedback-2.md" || len(handed[0].Ops) != 1 || handed[0].Ops[0].Index != 1 ||
		handed[1].File != "memory/feedback-3.md" || len(handed[1].Ops) != 0 {
		t.Fatalf("the second job was handed %+v", handed)
	}
	if title := handed[0].Ops[0].Body["entry"].(map[string]interface{})["title"]; title != "memory/feedback-2.md 2" {
		t.Errorf("the carried op is %v", handed[0].Ops[0].Body)
	}
	// Nothing is left: a third run makes no job at all, and registers nothing again.
	third, err := importSummary(t, args...)
	if err != nil || third.Proposed != 0 || len(server.Jobs()) != 2 || len(server.door.Registrations()) != 3 {
		t.Fatalf("a run with nothing left: %v, %+v, %d jobs, %d registrations", err, third, len(server.Jobs()), len(server.door.Registrations()))
	}
}

func TestWikiImportOnTheServerCollectsAJobTheLastRunLeft(t *testing.T) {
	library := memoryLibrary(t, map[string][2]string{"feedback-1.md": {"feedback", "fact one"}})
	server := newFakeImportServer(t, readAll(map[string]int{"memory/feedback-1.md": 1, "memory/feedback-2.md": 1}))
	wikiImportServerSession(t, server)
	// The model refused the deployment's key: the run stops waiting at once, and leaves the job to the server.
	server.modelState = "auth_failed"
	_, err := runImport(t, "--from", library, "--space", "space-1")
	if err == nil || !strings.Contains(err.Error(), "refused the deployment's key (401)") || !strings.Contains(err.Error(), "the next run of this command collects") {
		t.Fatalf("a refused key = %v", err)
	}
	state, _ := loadWikiImportState(wikiImportDefaultState("space-1", library), "space-1", library)
	if state.Job == "" || state.Job != server.Jobs()[0].ID {
		t.Fatalf("the job %q was not remembered", state.Job)
	}
	// The key is fixed: the next run collects that job, and makes none of its own.
	server.modelState = "up"
	summary, err := importSummary(t, "--from", library, "--space", "space-1")
	if err != nil || summary.Proposed != 1 || summary.Job != state.Job || summary.Remaining != 0 {
		t.Fatalf("the next run: %v, %+v", err, summary)
	}
	if len(server.Jobs()) != 1 {
		t.Errorf("%d jobs: the run that collects a job makes none", len(server.Jobs()))
	}
	// A job the server never held — its request lost before it arrived — is let go, and the run begins afresh.
	fresh := memoryLibrary(t, map[string][2]string{"feedback-2.md": {"feedback", "fact two"}})
	statePath := wikiImportDefaultState("space-1", fresh)
	lost := &wikiImportState{Version: 1, Space: "space-1", From: fresh, Files: map[string]*wikiImportFile{}, Job: "0b8f5e2c-1111-4222-8333-444455556666", path: statePath}
	if err := lost.save(); err != nil {
		t.Fatal(err)
	}
	summary, err = importSummary(t, "--from", fresh, "--space", "space-1")
	if err != nil || summary.Proposed != 1 || len(server.Jobs()) != 2 {
		t.Fatalf("after a lost job: %v, %+v, %d jobs", err, summary, len(server.Jobs()))
	}
}

func TestWikiImportOnTheServerStopsWaitingForAModelThatIsAway(t *testing.T) {
	library := memoryLibrary(t, map[string][2]string{"feedback-1.md": {"feedback", "fact one"}})
	server := newFakeImportServer(t, readAll(map[string]int{"memory/feedback-1.md": 1}))
	wikiImportServerSession(t, server)
	previous := wikiImportHealthWait
	wikiImportHealthWait = 50 * time.Millisecond
	t.Cleanup(func() { wikiImportHealthWait = previous })
	server.modelState = "down"
	_, err := runImport(t, "--from", library, "--space", "space-1")
	if err == nil || !strings.Contains(err.Error(), "was not ready within") {
		t.Fatalf("a model that stays down = %v", err)
	}
	server.modelState = "unconfigured"
	_, err = runImport(t, "--from", library, "--space", "space-1")
	if err == nil || !strings.Contains(err.Error(), "no System model configured") {
		t.Fatalf("no System model = %v", err)
	}
	// A job the server keeps trying: the run waits through some of it, not forever.
	server.modelState, server.retries = "up", wikiImportJobAttempts
	_, err = runImport(t, "--from", library, "--space", "space-1")
	if err == nil || !strings.Contains(err.Error(), "has failed 3 times (REPO_OP_WAIT: the census)") {
		t.Fatalf("a job that keeps failing = %v", err)
	}
	if len(server.Jobs()) != 1 {
		t.Errorf("%d jobs: a run that stopped waiting leaves its job for the next one", len(server.Jobs()))
	}
}

func TestWikiImportOnTheServerHandsAFailedJobsNotesToTheNextOne(t *testing.T) {
	library := memoryLibrary(t, map[string][2]string{"feedback-1.md": {"feedback", "fact one"}})
	server := newFakeImportServer(t, readAll(map[string]int{"memory/feedback-1.md": 1}))
	wikiImportServerSession(t, server)
	server.failWith = "the import's proposal was refused: WIKI_SESSION_EXCLUDED: no"
	_, err := runImport(t, "--from", library, "--space", "space-1")
	if err == nil || !strings.Contains(err.Error(), "WIKI_SESSION_EXCLUDED") {
		t.Fatalf("a failed job = %v", err)
	}
	summary, err := importSummary(t, "--from", library, "--space", "space-1")
	if err != nil || summary.Proposed != 1 || len(server.Jobs()) != 2 || summary.NewNotes != 0 {
		t.Fatalf("the next run: %v, %+v, %d jobs", err, summary, len(server.Jobs()))
	}
	if got := server.Jobs()[1].Notes; len(got) != 1 || got[0].File != "memory/feedback-1.md" {
		t.Errorf("the next job was handed %+v", got)
	}
}

func TestWikiImportOnTheRunnerWhenTheServerSaysSo(t *testing.T) {
	library := memoryLibrary(t, map[string][2]string{"feedback-1.md": {"feedback", "fact one"}})
	server := newFakeImportServer(t, readAll(nil))
	server.executor = "runner"
	vllm := newFakeVLLM(t, scripted(map[string]string{"memory/feedback-1.md": manyEntries("One", 1)}))
	spawns := fakeVerifyClaude(t)
	wikiImportSession(t, &fakeImportDoor{URL: server.URL}, vllm)
	// The fake server answers the notes route only; the runner's own path proposes through /imports, which
	// this door does not have — what matters is that the job routes are never asked and the model is.
	_, _ = runImport(t, "--from", library, "--space", "space-1")
	if len(server.Jobs()) != 0 || len(spawns()) != 1 || len(vllm.Requests()) != 1 {
		t.Errorf("under runner: %d jobs, Claude Code ran %d times, the model asked %d times", len(server.Jobs()), len(spawns()), len(vllm.Requests()))
	}
}

func TestWikiImportOnTheServerIsTheContracts(t *testing.T) {
	imports := wikiContract(t)["import"].(map[string]interface{})
	server, ok := imports["server"].(map[string]interface{})
	if !ok {
		t.Fatal("the contract's import has no server section")
	}
	if server["systemPrompt"] != wikiImportSystemPrompt {
		t.Errorf("the import's system prompt is the contract's on both paths:\n here: %q\n there: %q", wikiImportSystemPrompt, server["systemPrompt"])
	}
	if int(server["maxNotes"].(float64)) != wikiImportJobMaxNotes {
		t.Errorf("import.server.maxNotes is %v, and %d here", server["maxNotes"], wikiImportJobMaxNotes)
	}
	routes := wikiSurface(t)["doors"].(map[string]interface{})["runner"].(map[string]interface{})["importJobRoutes"]
	want := []interface{}{
		"GET /api/runner/wiki/spaces/:id/import",
		"POST /api/runner/wiki/spaces/:id/import-jobs",
		"GET /api/runner/wiki/spaces/:id/import-jobs/:jobId",
	}
	if !reflect.DeepEqual(routes, want) {
		t.Errorf("the contract's import job routes are %v", routes)
	}
}

// An orbit wiki import that predates the server's import never asks which path it takes: it registers a note
// and would read it with the session's own model. Against an account the server reads for, the note route
// refuses it before anything is registered — so it stops there, and no model of the session's is asked.
func TestWikiImportThatPredatesTheServersImportStopsBeforeAnyModel(t *testing.T) {
	library := memoryLibrary(t, map[string][2]string{"feedback-1.md": {"feedback", "fact one"}})
	server := newFakeImportServer(t, readAll(nil))
	server.probeMissing = true
	vllm := newFakeVLLM(t, scripted(map[string]string{"memory/feedback-1.md": manyEntries("One", 1)}))
	spawns := fakeVerifyClaude(t)
	wikiImportSession(t, &fakeImportDoor{URL: server.URL}, vllm)
	_, err := runImport(t, "--from", library, "--space", "space-1")
	if err == nil || !strings.Contains(err.Error(), "WIKI_SERVER_EXECUTES") {
		t.Fatalf("an import that reads for itself, against an account the server reads for = %v", err)
	}
	if len(spawns()) != 0 || len(vllm.Requests()) != 0 || len(server.Jobs()) != 0 {
		t.Errorf("Claude Code ran %d times and the model was asked %d times: nothing may read for the session", len(spawns()), len(vllm.Requests()))
	}
	if len(server.bodies) != 1 || server.bodies[0]["readBy"] != nil {
		t.Errorf("the registrations were %v", server.bodies)
	}
}

// A command that cannot learn which path to take goes its own, and an account the server reads for still
// stops it at the first registration: asking wrong costs a refusal, never a model call.
func TestWikiImportThatCannotAskWhichPathStopsBeforeAnyModel(t *testing.T) {
	library := memoryLibrary(t, map[string][2]string{"feedback-1.md": {"feedback", "fact one"}})
	server := newFakeImportServer(t, readAll(nil))
	server.probeFails = true
	vllm := newFakeVLLM(t, scripted(map[string]string{"memory/feedback-1.md": manyEntries("One", 1)}))
	spawns := fakeVerifyClaude(t)
	wikiImportSession(t, &fakeImportDoor{URL: server.URL}, vllm)
	// A 500 is no transient failure the transport sends again (wiki_retry.go): the run asks once and goes on.
	_, err := runImport(t, "--from", library, "--space", "space-1")
	if err == nil || !strings.Contains(err.Error(), "WIKI_SERVER_EXECUTES") {
		t.Fatalf("an import that could not ask = %v", err)
	}
	if len(spawns()) != 0 || len(vllm.Requests()) != 0 || len(server.Jobs()) != 0 {
		t.Errorf("Claude Code ran %d times and the model was asked %d times", len(spawns()), len(vllm.Requests()))
	}
}
