//go:build linux || darwin

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// `orbit session import` produces everything it produces before an engine exists: the transcript
// is located, checked against the workspace, copied where `--resume` will read it, replayed as run
// events and settled with the control plane. Warming an engine is a different job — it only
// matters once somebody speaks — and doing it here costs a resident process and a runner slot per
// imported conversation, which a directory's history (hundreds of transcripts) pays all at once
// and keeps paying until each engine's warm TTL expires.
//
// So the claim that carries an import settles the import and goes cold, and the first message is
// what spawns. These drive the real supervisor through both halves: the fake claude would be
// spawned by anything that spawned one, and the verdict is read off what the control plane was
// actually sent.

// importClaimJob is the claim the control plane hands a runner for an import: the marker naming
// where to find the transcript, and the two fields that say what to do with this claim.
func importClaimJob(t *testing.T, sessionID, uuid, workDir string) *ClaimedSession {
	t.Helper()
	job := runnerStopJob(t, sessionID)
	job.SessionUUID = uuid
	job.WorkDir = workDir
	marker := workDir
	job.ImportSourceCwd = &marker
	// What the control plane says: this claim ends with the import (/import-result parks the
	// session), and the spawn --resumes the conversation already on disk (importedAt).
	job.ImportOnly = true
	job.Resume = true
	return job
}

// writeImportTranscript puts a two-message Claude transcript where this machine's ~/.claude would
// hold one for workDir, and returns its session id.
func writeImportTranscript(t *testing.T, home, workDir, uuid string) string {
	t.Helper()
	var tr importTestTranscript
	tr.add(map[string]interface{}{"type": "ai-title", "aiTitle": "Imported talk", "timestamp": "2026-09-15T10:00:00Z"})
	tr.add(importMsgRow("user", workDir, "2026-09-15T10:00:01Z", map[string]interface{}{"type": "text", "text": "why does the page not open"}))
	tr.add(importMsgRow("assistant", workDir, "2026-09-15T10:00:02Z", map[string]interface{}{"type": "text", "text": "the gateway is down"}))
	projects := filepath.Join(home, ".claude", "projects", claudeProjectSlug(workDir))
	if err := os.MkdirAll(projects, 0o755); err != nil {
		t.Fatal(err)
	}
	tr.write(t, filepath.Join(projects, uuid+".jsonl"))
	return uuid
}

func TestImportClaimSettlesWithoutSpawningAndTheFirstMessageSpawns(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude"))
	work := t.TempDir()
	uuid := writeImportTranscript(t, home, work, "4e453ab7-f37c-494d-8017-bb4e9beffeef")

	fake := newFakeClaude(t,
		fakeStep{Await: "user"},
		fakeStep{Emit: "result", Text: "yes — the gateway is back"},
	)
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	job := importClaimJob(t, "sess-import", uuid, work)
	api := newRunnerStopControlPlane()
	sup := superviseUntilRunnerStop(t, job, true, api)

	// The import is the claim's whole work: the transcript is replayed onto the control plane and
	// settled, with the title it records.
	awaitCondition(t, 30*time.Second, "the import was never settled with the control plane", func() bool {
		return len(api.importResults()) > 0
	})
	posted := api.importResults()
	if !posted[0].Ok || posted[0].Title != "Imported talk" {
		t.Errorf("import-result = %+v, want ok with the transcript's title", posted[0])
	}
	if !api.delivered(func(e RunEvent) bool {
		return e.Type == evAssistant && asString(e.Payload["text"]) == "the gateway is down"
	}) {
		t.Errorf("the replayed transcript never reached the control plane: %v", api.deliveredEvents())
	}

	// …and nothing else is: no engine was spawned for it, and the run did not end — the session is
	// parked, which is the state its first message claims it from.
	awaitCondition(t, 30*time.Second, "the session never parked after its import", func() bool {
		return !sup.pool.isActive(sup.live)
	})
	if spawns := fake.Spawns(); len(spawns) != 0 {
		t.Errorf("importing spawned %d engine(s), want none: %v", len(spawns), spawns)
	}
	if statuses := api.finalizeStatuses(); len(statuses) != 0 {
		t.Errorf("the import ended the run as %v, want it left resumable for the first message", statuses)
	}
	if sup.pool.engineResident(sup.live) {
		t.Error("the import left an engine resident, holding a runner slot for a conversation nobody has spoken to")
	}

	// The first message: the same session claimed again, with the transcript already on disk. This
	// is the claim that spawns, and the one that has to --resume rather than open a new session.
	api.queue(RunInboxResponse{TurnID: "turn-1", Kind: "message", Content: "carry on"})
	claim := *job
	claim.Resume = true
	if _, ok := sup.pool.activate(&claim); !ok {
		t.Fatal("the first message could not activate the parked session")
	}
	awaitCondition(t, time.Minute, "the engine the first message should have started never answered it", func() bool {
		return api.settled("turn-1")
	})
	spawns := fake.Spawns()
	if len(spawns) != 1 {
		t.Fatalf("claude was spawned %d times for the first message, want 1: %v", len(spawns), spawns)
	}
	argv := strings.Join(spawns[0].Argv, " ")
	if !strings.Contains(argv, "--resume "+uuid) {
		t.Errorf("the first message spawned `claude %s`, want it resuming %s: the imported conversation is on disk and a fresh --session-id would not carry it", argv, uuid)
	}
}

// A directory somebody has worked in for months holds hundreds of conversations, and taking them
// all is one action ("All N" on the new-workspace form). Under the old shape that action was N
// claims that each warmed an engine and kept it: N resident processes holding N of the runner's
// slots until their warm TTLs expired, for conversations most of which nobody was about to speak
// to. Importing N must cost N imports — the transcripts are replayed either way — and nothing on
// the runner that scales with N.
func TestImportingManyConversationsLeavesTheRunnerAccountIntact(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude"))
	fake := newFakeClaude(t, fakeStep{Await: "user"})
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	work := t.TempDir()

	api := newRunnerStopControlPlane()
	server := httptest.NewServer(http.HandlerFunc(api.serve))
	t.Cleanup(server.Close)
	pool := newSessionPool(4)
	runnerCtx, stopRunner := context.WithCancel(context.Background())
	// Safety net only; the test body stops the runner itself, after everything it asserts.
	t.Cleanup(stopRunner)

	uuids := []string{
		"11111111-1111-4111-8111-111111111111",
		"22222222-2222-4222-8222-222222222222",
		"33333333-3333-4333-8333-333333333333",
	}
	finished := make(chan struct{}, len(uuids))
	var cancels []context.CancelFunc
	for i, uuid := range uuids {
		writeImportTranscript(t, home, work, uuid)
		job := importClaimJob(t, fmt.Sprintf("sess-import-%d", i), uuid, work)
		// One context per session, as a real claim gives each supervisor its own; the runner's
		// stop is the shared one, so teardown is still the runner's.
		sessionCtx, cancelSession := context.WithCancel(context.Background())
		cancels = append(cancels, cancelSession)
		live, added := pool.register(job, cancelSession, true)
		if !added {
			t.Fatalf("session %d was not registered", i)
		}
		go func(job *ClaimedSession, live *liveSession) {
			defer func() { finished <- struct{}{} }()
			runInteractiveSession(NewTransport(server.URL, "runner-token"), job, sessionCtx, runnerCtx,
				t.TempDir(), nil, pool, live)
			pool.finish(live)
		}(job, live)
	}

	// Every import settles on its own: there is no turn to wait for, and the claim ends when the
	// transcript has been replayed and the control plane has it.
	awaitCondition(t, time.Minute, "not every import settled", func() bool {
		return len(api.importResults()) == len(uuids)
	})
	awaitCondition(t, time.Minute, "the runner's own capacity never came back", func() bool {
		return pool.admissionIdleCapacity() == 4
	})
	if spawns := fake.Spawns(); len(spawns) != 0 {
		t.Errorf("importing %d conversations spawned %d engine(s), want none: %v", len(uuids), len(spawns), spawns)
	}
	if n := pool.residentCount(); n != 0 {
		t.Errorf("%d engines are resident after importing %d conversations, want none", n, len(uuids))
	}

	// Teardown asserted rather than registered: the supervisors have to be stopped (their runner and
	// their sessions) and joined before this test is done, or a goroutine outliving it is itself the
	// leak the case is about.
	stopRunner()
	for _, cancel := range cancels {
		cancel()
	}
	for range uuids {
		select {
		case <-finished:
		case <-time.After(2 * time.Minute):
			t.Error("a supervisor never returned after the runner stopped")
		}
	}
}

// writeLongImportTranscript is a conversation of the kind that used to be refused whole, written
// where this machine's ~/.claude would hold one for workDir: 30 screenshots of 400 KB (12 MB of
// base64), 30 build logs of 100 KB (3 MB of text an import keeps), and one result of 11 MB, more
// than the control plane takes in a request of its own. It returns the transcript's path, the
// prefix every screenshot's base64 starts with, and the build log and the oversized result.
func writeLongImportTranscript(t *testing.T, home, workDir, uuid string) (path, pngMagic, buildLog, dump string) {
	t.Helper()
	pngMagic = "iVBORw0KGgoAAAANSUhEUg"
	screenshot := pngMagic + strings.Repeat("A", 400<<10)
	buildLog = strings.Repeat("compiling module\n", (100<<10)/17)
	dump = strings.Repeat(`{"row":1}`+"\n", (11<<20)/10)
	var tr importTestTranscript
	rows := 0
	row := func(typ string, block map[string]interface{}) {
		rows++
		ts := time.Date(2026, 9, 15, 10, 0, rows, 0, time.UTC).Format(time.RFC3339)
		tr.add(importMsgRow(typ, workDir, ts, block))
	}
	call := func(id, name string, input map[string]interface{}, content interface{}) {
		row("assistant", map[string]interface{}{"type": "tool_use", "id": id, "name": name, "input": input})
		row("user", map[string]interface{}{"type": "tool_result", "tool_use_id": id, "content": content, "is_error": false})
	}
	row("user", map[string]interface{}{"type": "text", "text": "the settings page renders blank, have a look"})
	for i := 0; i < 30; i++ {
		call(fmt.Sprintf("shot-%d", i), "Read", map[string]interface{}{"file_path": fmt.Sprintf("/tmp/shot-%d.png", i)}, []interface{}{
			map[string]interface{}{"type": "image", "source": map[string]interface{}{"type": "base64", "media_type": "image/png", "data": screenshot}},
		})
		call(fmt.Sprintf("build-%d", i), "Bash", map[string]interface{}{"command": "npm run build"}, buildLog)
	}
	call("dump", "Bash", map[string]interface{}{"command": "cat rows.json"}, dump)
	row("assistant", map[string]interface{}{"type": "text", "text": "the settings query returns no rows"})
	projects := filepath.Join(home, ".claude", "projects", claudeProjectSlug(workDir))
	if err := os.MkdirAll(projects, 0o755); err != nil {
		t.Fatal(err)
	}
	path = filepath.Join(projects, uuid+".jsonl")
	tr.write(t, path)
	return path, pngMagic, buildLog, dump
}

// eventsRequest is one /events request as the control plane received it.
type eventsRequest struct {
	size    int
	seqs    []int
	refused bool
}

// recordEventsRequests serves api and keeps every /events request it is sent. It refuses a body
// over the control plane's own 10 MB limit (main.ts) the way that limit does, with a 413, and the
// nth request (counted from 1) with whatever status refuse answers for n, when that is not 0.
func recordEventsRequests(t *testing.T, api *runnerStopControlPlane, refuse func(n int) int) (http.Handler, func() []eventsRequest) {
	var mu sync.Mutex
	var seen []eventsRequest
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/events") {
			body, err := io.ReadAll(r.Body)
			if err != nil {
				t.Errorf("reading an events request: %v", err)
				return
			}
			var batch RunEventBatch
			_ = json.Unmarshal(body, &batch)
			req := eventsRequest{size: len(body)}
			for _, e := range batch.Events {
				req.seqs = append(req.seqs, e.Seq)
			}
			status := 0
			if len(body) > 10<<20 {
				status = http.StatusRequestEntityTooLarge
			}
			mu.Lock()
			if status == 0 && refuse != nil {
				status = refuse(len(seen) + 1)
			}
			req.refused = status != 0
			seen = append(seen, req)
			mu.Unlock()
			if status != 0 {
				http.Error(w, http.StatusText(status), status)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
		}
		api.serve(w, r)
	})
	return handler, func() []eventsRequest {
		mu.Lock()
		defer mu.Unlock()
		return append([]eventsRequest(nil), seen...)
	}
}

// A long conversation is mostly screenshots — Read on an image returns it base64 — and one of 95 MB
// was refused whole (413) when its replay went to the control plane as a single request. Whatever a
// transcript holds now lands: its images are left out of the events, a record too large for any
// request is clipped, and the rest goes out in requests within maxEventBatchBytes.
func TestImportOfALongConversationWithScreenshotsLandsInBoundedRequests(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude"))
	fake := newFakeClaude(t, fakeStep{Await: "user"})
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	work := t.TempDir()
	const uuid = "4e453ab7-f37c-494d-8017-bb4e9beffeef"
	_, pngMagic, buildLog, dump := writeLongImportTranscript(t, home, work, uuid)

	api := newRunnerStopControlPlane()
	handler, requests := recordEventsRequests(t, api, nil)
	superviseUntilRunnerStopOn(t, importClaimJob(t, "sess-import-long", uuid, work), true, api, handler)

	awaitCondition(t, time.Minute, "the import was never settled with the control plane", func() bool {
		return len(api.importResults()) > 0
	})
	if posted := api.importResults()[0]; !posted.Ok {
		t.Fatalf("import-result = %+v, want the conversation stored", posted)
	}
	sent := requests()
	if len(sent) < 2 {
		t.Errorf("the replay went out as %d request(s), want it split", len(sent))
	}
	for i, req := range sent {
		if req.size > maxEventBatchBytes {
			t.Errorf("request %d of %d carried %d bytes, over the %d one may", i+1, len(sent), req.size, maxEventBatchBytes)
		}
	}

	results := map[string]interface{}{}
	for _, e := range api.deliveredEvents() {
		raw, _ := json.Marshal(e.Payload)
		if strings.Contains(string(raw), pngMagic) {
			t.Fatalf("event %d (%s) carries a screenshot's base64", e.Seq, e.Type)
		}
		if e.Type == evToolResult {
			results[asString(e.Payload["toolUseId"])] = e.Payload["content"]
		}
	}
	if len(results) != 61 {
		t.Fatalf("%d tool results were stored, want all 61", len(results))
	}
	note := []interface{}{map[string]interface{}{"type": "text", "text": "[image not imported]"}}
	for i := 0; i < 30; i++ {
		if got := results[fmt.Sprintf("shot-%d", i)]; !reflect.DeepEqual(got, note) {
			t.Fatalf("screenshot %d stored as %v, want the note that stands in for it", i, got)
		}
		if got := results[fmt.Sprintf("build-%d", i)]; got != buildLog {
			t.Fatalf("build log %d stored as %d bytes, want all %d", i, len(asString(got)), len(buildLog))
		}
	}
	clipped := asString(results["dump"])
	if !strings.HasPrefix(clipped, dump[:4096]) || !strings.HasSuffix(clipped, "…") || jsonLen(clipped) > importEventMaxBytes {
		t.Errorf("the 11 MB result stored as %d bytes, want how it starts within %d, marked as clipped", len(clipped), importEventMaxBytes)
	}
	if spawns := fake.Spawns(); len(spawns) != 0 {
		t.Errorf("importing spawned %d engine(s), want none: %v", len(spawns), spawns)
	}
}

// A request refused partway through a flush loses neither what was acknowledged before it nor
// what was to follow it: the unsent rest goes back to the buffer, in order, for the next flush.
// So what the control plane holds is a prefix of the replay at every moment — where a reclaim's
// MaxSeq resumes it — and it ends up holding every event once, in seq order.
func TestImportRequestRefusedPartwayKeepsTheRestInOrder(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude"))
	fake := newFakeClaude(t, fakeStep{Await: "user"})
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	work := t.TempDir()
	const uuid = "4e453ab7-f37c-494d-8017-bb4e9beffeef"
	path, _, _, _ := writeLongImportTranscript(t, home, work, uuid)
	_, _, replay, err := parseImportTranscript(path, nil)
	if err != nil {
		t.Fatal(err)
	}

	api := newRunnerStopControlPlane()
	handler, requests := recordEventsRequests(t, api, func(n int) int {
		if n == 2 {
			return http.StatusBadRequest
		}
		return 0
	})
	superviseUntilRunnerStopOn(t, importClaimJob(t, "sess-import-refused", uuid, work), true, api, handler)

	awaitCondition(t, time.Minute, "the events behind the refused request were never sent again", func() bool {
		return len(api.deliveredEvents()) >= len(replay)
	})
	next := 1
	for i, req := range requests() {
		if req.refused {
			if req.seqs[0] != next {
				t.Fatalf("refused request %d started at seq %d, where %d came next", i+1, req.seqs[0], next)
			}
			continue
		}
		for _, seq := range req.seqs {
			if seq != next {
				t.Fatalf("request %d carries seq %d where %d comes next: %v", i+1, seq, next, requests())
			}
			next++
		}
	}
	if next <= len(replay) {
		t.Errorf("the accepted requests carried seq 1-%d, want all %d events of the replay", next-1, len(replay))
	}
}
