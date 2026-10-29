package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// startNow and the owner's "Create and start" (task_start_now.go): one approval that creates a task
// and starts it. These pin what reaches the server and in which order — runAt = now on the card and
// in the create, then the run request — that a refused start still hands back the created task, that
// neither happens without being asked for, and that a batch only schedules.

// startNowHit is one request the fake control plane received.
type startNowHit struct {
	method, path string
	body         map[string]interface{}
}

// startNowServer answers the approval poll with `decision`, a create with a task whose id is t1, a
// batch create with two tasks, the batch preview with an empty forecast, and a start with `startStatus`
// and `startBody`. It records every request in order.
func startNowServer(t *testing.T, decision string, startStatus int, startBody string) (*httptest.Server, func() []startNowHit) {
	t.Helper()
	var mu sync.Mutex
	var hits []startNowHit
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit := startNowHit{method: r.Method, path: r.URL.Path}
		_ = json.NewDecoder(r.Body).Decode(&hit.body)
		mu.Lock()
		hits = append(hits, hit)
		mu.Unlock()
		switch {
		case strings.Contains(r.URL.Path, "/approvals/"):
			_, _ = w.Write([]byte(decision))
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			_, _ = w.Write([]byte(`{"id":"ap1","status":"PENDING"}`))
		case strings.HasSuffix(r.URL.Path, "/execute"):
			w.WriteHeader(startStatus)
			_, _ = w.Write([]byte(startBody))
		case strings.HasSuffix(r.URL.Path, "/batch-preview"):
			_, _ = w.Write([]byte(`{"taskCount":2,"startingNow":1,"needsManualStart":1}`))
		case strings.HasSuffix(r.URL.Path, "/batch-create"):
			_, _ = w.Write([]byte(`[{"id":"t1","title":"a"},{"id":"t2","title":"b"}]`))
		default:
			_, _ = w.Write([]byte(`{"id":"t1","title":"Fix login redirect","status":"OPEN"}`))
		}
	}))
	t.Cleanup(srv.Close)
	return srv, func() []startNowHit {
		mu.Lock()
		defer mu.Unlock()
		return append([]startNowHit(nil), hits...)
	}
}

func startNowPaths(hits []startNowHit) []string {
	paths := make([]string, 0, len(hits))
	for _, hit := range hits {
		paths = append(paths, hit.method+" "+hit.path)
	}
	return paths
}

// hitTo returns the requests made to paths ending in suffix.
func hitsTo(hits []startNowHit, method, suffix string) []startNowHit {
	var out []startNowHit
	for _, hit := range hits {
		if hit.method == method && strings.HasSuffix(hit.path, suffix) {
			out = append(out, hit)
		}
	}
	return out
}

// assertDueNow fails unless value is an RFC 3339 instant in UTC, between before and after.
func assertDueNow(t *testing.T, what string, value interface{}, before, after time.Time) {
	t.Helper()
	text, ok := value.(string)
	if !ok {
		t.Fatalf("%s runAt = %#v, want an RFC 3339 string", what, value)
	}
	at, err := time.Parse(time.RFC3339, text)
	if err != nil {
		t.Fatalf("%s runAt %q is not RFC 3339: %v", what, text, err)
	}
	if !strings.HasSuffix(text, "Z") {
		t.Fatalf("%s runAt %q is not UTC", what, text)
	}
	// To the second, so it may read up to a second before `before`; never after the call.
	if at.Before(before.Truncate(time.Second)) || at.After(after) {
		t.Fatalf("%s runAt %s is not now (call ran %s .. %s)", what, text, before.UTC().Format(time.RFC3339Nano), after.UTC().Format(time.RFC3339Nano))
	}
}

func TestTaskCreateStartNowSchedulesOnTheCardAndStartsAfterTheCreate(t *testing.T) {
	srv, hits := startNowServer(t, `{"status":"ALLOWED"}`, http.StatusCreated, `{"id":"s1","status":"PENDING"}`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	before := time.Now()
	res := mcp.callTool("task_create", map[string]interface{}{
		"title": "Fix login redirect", "completionCriterion": "EVIDENCE_JUDGMENT", "startNow": true,
	})
	after := time.Now()

	if res["isError"] == true {
		t.Fatalf("task_create returned an error: %v", resultText(res))
	}
	got := hits()
	// The card first, then the create, then the start — and the start names the task the create made.
	want := []string{
		"POST /api/runner/sessions/sess-1/approvals",
		"GET /api/runner/sessions/sess-1/approvals/ap1",
		"POST /api/runner/tasks",
		"POST /api/runner/tasks/t1/execute",
	}
	if strings.Join(startNowPaths(got), "\n") != strings.Join(want, "\n") {
		t.Fatalf("requests =\n%s\nwant\n%s", strings.Join(startNowPaths(got), "\n"), strings.Join(want, "\n"))
	}
	// On the card BEFORE anyone answers it, so its forecast says the task starts within the minute.
	card, _ := got[0].body["input"].(map[string]interface{})
	assertDueNow(t, "card", card["runAt"], before, after)
	create := got[2].body
	assertDueNow(t, "create", create["runAt"], before, after)
	if create["runAt"] != card["runAt"] {
		t.Fatalf("the create's runAt %v is not the one the card showed (%v)", create["runAt"], card["runAt"])
	}
	// startNow is the runner's word for it; the server is sent the schedule alone.
	if _, sent := card["startNow"]; sent {
		t.Fatalf("startNow reached the card: %#v", card)
	}
	if _, sent := create["startNow"]; sent {
		t.Fatalf("startNow reached the create: %#v", create)
	}
	// Named like task_start's own request, so a resend of it is the same run.
	if trigger, _ := got[3].body["triggerId"].(string); trigger == "" {
		t.Fatalf("the start carries no triggerId: %#v", got[3].body)
	}
	text := resultText(res)
	if !strings.Contains(text, `"id": "t1"`) || !strings.Contains(text, "Started at once") || !strings.Contains(text, `"id": "s1"`) {
		t.Fatalf("result does not carry the task and its run: %s", text)
	}
}

func TestTaskCreateWithoutStartNowNeitherSchedulesNorStarts(t *testing.T) {
	for name, args := range map[string]map[string]interface{}{
		"absent": {"title": "Fix login redirect", "completionCriterion": "EVIDENCE_JUDGMENT"},
		"false":  {"title": "Fix login redirect", "completionCriterion": "EVIDENCE_JUDGMENT", "startNow": false},
	} {
		t.Run(name, func(t *testing.T) {
			srv, hits := startNowServer(t, `{"status":"ALLOWED"}`, http.StatusCreated, `{"id":"s1"}`)
			mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

			res := mcp.callTool("task_create", args)

			if res["isError"] == true {
				t.Fatalf("task_create returned an error: %v", resultText(res))
			}
			got := hits()
			if starts := hitsTo(got, "POST", "/execute"); len(starts) != 0 {
				t.Fatalf("started a task nobody asked to start: %v", startNowPaths(got))
			}
			card, _ := got[0].body["input"].(map[string]interface{})
			if _, scheduled := card["runAt"]; scheduled {
				t.Fatalf("the card carries a runAt nobody asked for: %#v", card)
			}
			if _, scheduled := hitsTo(got, "POST", "/api/runner/tasks")[0].body["runAt"]; scheduled {
				t.Fatalf("the create carries a runAt nobody asked for")
			}
			if strings.Contains(resultText(res), "Started") || strings.Contains(resultText(res), "deferred") {
				t.Fatalf("the result talks about a start: %s", resultText(res))
			}
		})
	}
}

func TestTaskCreateStartNowWithRunAtIsRefusedBeforeAnyCard(t *testing.T) {
	srv, hits := startNowServer(t, `{"status":"ALLOWED"}`, http.StatusCreated, `{"id":"s1"}`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	res := mcp.callTool("task_create", map[string]interface{}{
		"title": "Fix login redirect", "completionCriterion": "EVIDENCE_JUDGMENT",
		"startNow": true, "runAt": "2026-11-01T09:00:00Z",
	})

	if res["isError"] != true {
		t.Fatalf("startNow beside runAt was accepted: %v", resultText(res))
	}
	if got := hits(); len(got) != 0 {
		t.Fatalf("a refusal reached the server (a card was raised or something written): %v", startNowPaths(got))
	}
	if text := resultText(res); !strings.Contains(text, "startNow cannot be combined with runAt") {
		t.Fatalf("refusal does not say why: %s", text)
	}
}

func TestTaskCreateStartNowTakesANullOrBlankRunAtAsNoSchedule(t *testing.T) {
	for name, runAt := range map[string]interface{}{"null": nil, "blank": "  "} {
		t.Run(name, func(t *testing.T) {
			srv, hits := startNowServer(t, `{"status":"ALLOWED"}`, http.StatusCreated, `{"id":"s1"}`)
			mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

			before := time.Now()
			res := mcp.callTool("task_create", map[string]interface{}{
				"title": "Fix login redirect", "completionCriterion": "EVIDENCE_JUDGMENT", "startNow": true, "runAt": runAt,
			})

			if res["isError"] == true {
				t.Fatalf("task_create returned an error: %v", resultText(res))
			}
			assertDueNow(t, "create", hitsTo(hits(), "POST", "/api/runner/tasks")[0].body["runAt"], before, time.Now())
		})
	}
}

func TestTaskCreateStartNowRefusedStartStillReturnsTheCreatedTask(t *testing.T) {
	refusal := `{"statusCode":409,"code":"TASK_DEPENDENCIES_PENDING","message":"a prerequisite is not DONE yet"}`
	srv, hits := startNowServer(t, `{"status":"ALLOWED"}`, http.StatusConflict, refusal)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	res := mcp.callTool("task_create", map[string]interface{}{
		"title": "Fix login redirect", "completionCriterion": "EVIDENCE_JUDGMENT", "startNow": true,
	})

	// The create happened, so the call succeeded: a refused start is a note, not a failure.
	if res["isError"] == true {
		t.Fatalf("a refused start turned the create into an error: %v", resultText(res))
	}
	if creates := hitsTo(hits(), "POST", "/api/runner/tasks"); len(creates) != 1 {
		t.Fatalf("creates = %d", len(creates))
	}
	text := resultText(res)
	if !strings.Contains(text, `"id": "t1"`) {
		t.Fatalf("the created task is missing from the result: %s", text)
	}
	if !strings.Contains(text, "Created, but its start was deferred") || !strings.Contains(text, "TASK_DEPENDENCIES_PENDING") ||
		!strings.Contains(text, "once-a-minute scan") {
		t.Fatalf("the result does not say the start was deferred and why: %s", text)
	}
	// One line, after the task: the note is the whole of the result's last line.
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if note := lines[len(lines)-1]; !strings.HasPrefix(note, "Created, but its start was deferred") || !strings.Contains(note, "do not ask the person") {
		t.Fatalf("the deferral note is not one line: %q", note)
	}
}

func TestTaskCreateCardStartAfterCreateTakesTheStartNowPath(t *testing.T) {
	srv, hits := startNowServer(t, `{"status":"ALLOWED","startAfterCreate":true}`, http.StatusCreated, `{"id":"s1","status":"PENDING"}`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	before := time.Now()
	res := mcp.callTool("task_create", map[string]interface{}{
		"title": "Fix login redirect", "completionCriterion": "EVIDENCE_JUDGMENT",
	})
	after := time.Now()

	if res["isError"] == true {
		t.Fatalf("task_create returned an error: %v", resultText(res))
	}
	got := hits()
	// The card was raised as a plain create — the owner chose the start on it.
	card, _ := got[0].body["input"].(map[string]interface{})
	if _, scheduled := card["runAt"]; scheduled {
		t.Fatalf("the card carries a runAt the agent never asked for: %#v", card)
	}
	// From the yes on, exactly startNow's path: runAt = now in the create, then the start.
	creates := hitsTo(got, "POST", "/api/runner/tasks")
	if len(creates) != 1 {
		t.Fatalf("creates = %d (%v)", len(creates), startNowPaths(got))
	}
	assertDueNow(t, "create", creates[0].body["runAt"], before, after)
	if starts := hitsTo(got, "POST", "/api/runner/tasks/t1/execute"); len(starts) != 1 {
		t.Fatalf("the owner's Create and start did not start the task: %v", startNowPaths(got))
	}
	if !strings.Contains(resultText(res), "Started at once") {
		t.Fatalf("result = %s", resultText(res))
	}
}

func TestTaskCreateCardStartAfterCreateOnARefusalStartsNothing(t *testing.T) {
	// A server never sends it on a refusal; a runner that read it anyway must still write nothing.
	srv, hits := startNowServer(t, `{"status":"DENIED","startAfterCreate":true,"message":"not now"}`, http.StatusCreated, `{"id":"s1"}`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	res := mcp.callTool("task_create", map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT"})

	if got := hits(); len(hitsTo(got, "POST", "/api/runner/tasks")) != 0 || len(hitsTo(got, "POST", "/execute")) != 0 {
		t.Fatalf("a refused card wrote or started something: %v", startNowPaths(got))
	}
	if !strings.Contains(resultText(res), "not now") {
		t.Fatalf("result = %s", resultText(res))
	}
}

func TestTaskCreateBatchStartNowSchedulesItsItemsAndStartsNone(t *testing.T) {
	srv, hits := startNowServer(t, `{"status":"ALLOWED"}`, http.StatusCreated, `{"id":"s1"}`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	before := time.Now()
	res := mcp.callTool("task_create_batch", map[string]interface{}{"tasks": []interface{}{
		map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT", "startNow": true},
		map[string]interface{}{"title": "b", "completionCriterion": "EVIDENCE_JUDGMENT"},
	}})
	after := time.Now()

	if res["isError"] == true {
		t.Fatalf("task_create_batch returned an error: %v", resultText(res))
	}
	got := hits()
	// The scan starts the item: the batch is never followed by a start of its own.
	if starts := hitsTo(got, "POST", "/execute"); len(starts) != 0 {
		t.Fatalf("a batch item was started one by one: %v", startNowPaths(got))
	}
	items := func(hit startNowHit) []interface{} {
		if input, ok := hit.body["input"].(map[string]interface{}); ok {
			list, _ := input["tasks"].([]interface{})
			return list
		}
		list, _ := hit.body["tasks"].([]interface{})
		return list
	}
	for _, at := range []struct{ method, suffix string }{
		{"POST", "/batch-preview"}, {"POST", "/approvals"}, {"POST", "/batch-create"},
	} {
		found := hitsTo(got, at.method, at.suffix)
		if len(found) != 1 {
			t.Fatalf("%s %s: %d requests (%v)", at.method, at.suffix, len(found), startNowPaths(got))
		}
		list := items(found[0])
		if len(list) != 2 {
			t.Fatalf("%s carries %d items", at.suffix, len(list))
		}
		first, _ := list[0].(map[string]interface{})
		second, _ := list[1].(map[string]interface{})
		assertDueNow(t, at.suffix+" item 0", first["runAt"], before, after)
		if _, scheduled := second["runAt"]; scheduled {
			t.Fatalf("%s: the item without startNow got a runAt: %#v", at.suffix, second)
		}
		if _, sent := first["startNow"]; sent {
			t.Fatalf("%s: startNow reached the server: %#v", at.suffix, first)
		}
	}
}

func TestTaskCreateBatchItemWithStartNowAndRunAtIsRefusedBeforeAnyCard(t *testing.T) {
	srv, hits := startNowServer(t, `{"status":"ALLOWED"}`, http.StatusCreated, `{"id":"s1"}`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	res := mcp.callTool("task_create_batch", map[string]interface{}{"tasks": []interface{}{
		map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT"},
		map[string]interface{}{"title": "b", "completionCriterion": "EVIDENCE_JUDGMENT", "startNow": true, "runAt": "2026-11-01T09:00:00Z"},
	}})

	if res["isError"] != true {
		t.Fatalf("startNow beside runAt was accepted: %v", resultText(res))
	}
	if got := hits(); len(got) != 0 {
		t.Fatalf("the refusal reached the server: %v", startNowPaths(got))
	}
	if text := resultText(res); !strings.Contains(text, "tasks[1]: startNow cannot be combined with runAt") {
		t.Fatalf("refusal = %s", text)
	}
}

// A card the owner answers after the engine's call deadline is waited for by a runner-hosted job,
// which replays the call as one JSON-RPC request on `orbit mcp`'s stdin (handOffOwnerWait). That is
// the same handler, so the same requests reach the server.
func TestTaskCreateStartNowReplayedByAJobTakesTheSamePath(t *testing.T) {
	srv, hits := startNowServer(t, `{"status":"ALLOWED"}`, http.StatusCreated, `{"id":"s1","status":"PENDING"}`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok"),
		onlyTools: map[string]bool{"task_create": true}}

	// Built as handOffOwnerWait builds the request it saves for the job.
	params, _ := json.Marshal(map[string]interface{}{"name": "task_create", "arguments": map[string]interface{}{
		"title": "Fix login redirect", "completionCriterion": "EVIDENCE_JUDGMENT", "startNow": true,
	}})
	request, _ := json.Marshal(rpcRequest{JSONRPC: "2.0", ID: json.RawMessage("1"), Method: "tools/call", Params: params})
	var out bytes.Buffer
	before := time.Now()
	mcp.serve(bytes.NewReader(append(request, '\n')), &out)
	after := time.Now()

	got := hits()
	want := []string{
		"POST /api/runner/sessions/sess-1/approvals",
		"GET /api/runner/sessions/sess-1/approvals/ap1",
		"POST /api/runner/tasks",
		"POST /api/runner/tasks/t1/execute",
	}
	if strings.Join(startNowPaths(got), "\n") != strings.Join(want, "\n") {
		t.Fatalf("requests =\n%s", strings.Join(startNowPaths(got), "\n"))
	}
	card, _ := got[0].body["input"].(map[string]interface{})
	assertDueNow(t, "card", card["runAt"], before, after)
	if !strings.Contains(out.String(), "Started at once") {
		t.Fatalf("the job's reply does not carry the start: %s", out.String())
	}
}

func TestCLITaskCreateStartNowMatchesTheTool(t *testing.T) {
	srv, hits := startNowServer(t, `{"status":"ALLOWED"}`, http.StatusCreated, `{"id":"s1","status":"PENDING"}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")
	t.Setenv("ORBIT_AGENT_ID", "agent-1")
	t.Setenv(envBgJobID, "")
	var notices bytes.Buffer
	previous := cliNoticeOut
	cliNoticeOut = &notices
	t.Cleanup(func() { cliNoticeOut = previous })

	before := time.Now()
	var out bytes.Buffer
	err := cmdTaskCLI([]string{"create", "--title", "Fix login redirect",
		"--completion-criterion", "EVIDENCE_JUDGMENT", "--start-now", "--json"}, strings.NewReader(""), &out)
	after := time.Now()
	if err != nil {
		t.Fatal(err)
	}
	got := hits()
	want := []string{
		"POST /api/runner/sessions/sess-1/approvals",
		"GET /api/runner/sessions/sess-1/approvals/ap1",
		"POST /api/runner/tasks",
		"POST /api/runner/tasks/t1/execute",
	}
	if strings.Join(startNowPaths(got), "\n") != strings.Join(want, "\n") {
		t.Fatalf("requests =\n%s", strings.Join(startNowPaths(got), "\n"))
	}
	card, _ := got[0].body["input"].(map[string]interface{})
	assertDueNow(t, "card", card["runAt"], before, after)
	// stdout is still the created task alone, so --json stays one document.
	var task map[string]interface{}
	if err := json.Unmarshal(out.Bytes(), &task); err != nil || task["id"] != "t1" {
		t.Fatalf("stdout = %q (%v)", out.String(), err)
	}
	if !strings.Contains(notices.String(), "started at once") || !strings.Contains(notices.String(), `"id":"s1"`) {
		t.Fatalf("notice = %q", notices.String())
	}
}

func TestCLITaskCreateStartNowWithRunAtIsRefusedBeforeAnyCard(t *testing.T) {
	srv, hits := startNowServer(t, `{"status":"ALLOWED"}`, http.StatusCreated, `{"id":"s1"}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")

	var out bytes.Buffer
	err := cmdTaskCLI([]string{"create", "--title", "a", "--completion-criterion", "EVIDENCE_JUDGMENT",
		"--start-now", "--run-at", "2026-11-01T09:00:00Z"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "--start-now cannot be combined with --run-at") {
		t.Fatalf("err = %v", err)
	}
	if got := hits(); len(got) != 0 {
		t.Fatalf("the refusal reached the server: %v", startNowPaths(got))
	}
}

func TestCLITaskCreateCardStartAfterCreateStartsTheTask(t *testing.T) {
	srv, hits := startNowServer(t, `{"status":"ALLOWED","startAfterCreate":true}`, http.StatusCreated, `{"id":"s1"}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")
	t.Setenv(envBgJobID, "")
	previous := cliNoticeOut
	cliNoticeOut = &bytes.Buffer{}
	t.Cleanup(func() { cliNoticeOut = previous })

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"create", "--title", "a", "--completion-criterion", "EVIDENCE_JUDGMENT", "--json"},
		strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	got := hits()
	if creates := hitsTo(got, "POST", "/api/runner/tasks"); len(creates) != 1 || creates[0].body["runAt"] == nil {
		t.Fatalf("the create does not carry the owner's start: %v", startNowPaths(got))
	}
	if starts := hitsTo(got, "POST", "/api/runner/tasks/t1/execute"); len(starts) != 1 {
		t.Fatalf("not started: %v", startNowPaths(got))
	}
}

func TestCLITaskCreateBatchStartNowSchedulesTheItem(t *testing.T) {
	srv, hits := startNowServer(t, `{"status":"ALLOWED"}`, http.StatusCreated, `{"id":"s1"}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "")

	before := time.Now()
	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"create-batch", "--json", "--tasks",
		`[{"title":"a","completionCriterion":"EVIDENCE_JUDGMENT","startNow":true},{"title":"b","completionCriterion":"EVIDENCE_JUDGMENT"}]`},
		strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	got := hits()
	creates := hitsTo(got, "POST", "/batch-create")
	if len(creates) != 1 || len(hitsTo(got, "POST", "/execute")) != 0 {
		t.Fatalf("requests = %v", startNowPaths(got))
	}
	list, _ := creates[0].body["tasks"].([]interface{})
	first, _ := list[0].(map[string]interface{})
	second, _ := list[1].(map[string]interface{})
	assertDueNow(t, "item 0", first["runAt"], before, time.Now())
	if _, sent := first["startNow"]; sent {
		t.Fatalf("startNow reached the server: %#v", first)
	}
	if _, scheduled := second["runAt"]; scheduled {
		t.Fatalf("item 1 got a runAt: %#v", second)
	}
}

// The descriptions are what decide whether an agent uses it: pass startNow when the person wants the
// work run now, and then do not ask them again — said on both create doors, kept apart from
// autoRunWhenReady (which waits for prerequisites), and absent from task_update, which creates nothing.
func TestTaskCreateToolsSayWhenToPassStartNowAndThatOneApprovalCoversIt(t *testing.T) {
	tools := toolDescriptors(false, false)
	batch := mcpToolProps(tools, "task_create_batch")
	tasks, _ := batch["tasks"].(map[string]interface{})
	items, _ := tasks["items"].(map[string]interface{})
	itemProps, _ := items["properties"].(map[string]interface{})

	for label, props := range map[string]map[string]interface{}{
		"task_create":            mcpToolProps(tools, "task_create"),
		"task_create_batch item": itemProps,
	} {
		startNow, ok := props["startNow"].(map[string]interface{})
		if !ok || startNow["type"] != "boolean" {
			t.Fatalf("%s declares no boolean startNow: %#v", label, props["startNow"])
		}
		description, _ := startNow["description"].(string)
		for _, phrase := range []string{"wants", "run now", "do not ask them", "Not autoRunWhenReady", "runAt"} {
			if !strings.Contains(description, phrase) {
				t.Errorf("%s startNow does not say %q: %s", label, phrase, description)
			}
		}
		autoRun, _ := props["autoRunWhenReady"].(map[string]interface{})
		if text, _ := autoRun["description"].(string); !strings.Contains(text, "pass startNow instead") {
			t.Errorf("%s autoRunWhenReady does not point at startNow: %s", label, text)
		}
	}
	if _, present := mcpToolProps(tools, "task_update")["startNow"]; present {
		t.Error("task_update offers startNow, but an update creates nothing to start")
	}
	for _, descriptor := range tools {
		name, _ := descriptor["name"].(string)
		text, _ := descriptor["description"].(string)
		switch name {
		case "task_create":
			if !strings.Contains(text, "startNow: true") || !strings.Contains(text, "do not ask them a second time") {
				t.Errorf("task_create's description does not say when to pass startNow: %s", text)
			}
		case "task_create_batch":
			if !strings.Contains(text, "startNow: true") || !strings.Contains(text, "within the minute") {
				t.Errorf("task_create_batch's description does not say what an item's startNow does: %s", text)
			}
		}
	}
}
