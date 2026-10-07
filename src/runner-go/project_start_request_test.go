package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// project_request_start: a project's coordinator asks the account owner to start the project, and
// the server checks the plan first. What is tested here is the runner's half — the tool is offered,
// the request is sent as the calling session with the settings as given, a refusal comes back as a
// list a model can act on line by line, and the CLI twin sends the same request.

// startRequestNotReadyBody is a refusal as the server words it, every finding at once.
const startRequestNotReadyBody = `{
  "code": "START_REQUEST_NOT_READY",
  "message": "this plan is not ready to start: 2 checks refused it, and nothing was filed",
  "written": 0,
  "findings": [
    {"severity": "REFUSE", "code": "START_CRITERION_UNSERVED",
     "message": "no task serves criterion 2, so nothing would ever satisfy it",
     "requiredAction": "File a task for it, or point one at it: criterionKey 50RtdT7hcp2b0PzhjbSRYR on task_create or task_update.",
     "criterion": {"key": "50RtdT7hcp2b0PzhjbSRYR", "ordinal": 2, "text": "a plan that is not ready is refused"},
     "tasks": []},
    {"severity": "REFUSE", "code": "START_TASK_HAS_NO_RUNNER",
     "message": "1 task is not assigned to an enabled workspace bound to a runner, so nothing would start them",
     "requiredAction": "Assign each one to a workspace on a runner (task_update assigneeId), then ask again.",
     "criterion": null,
     "tasks": [{"taskId": "34X0Dq5lZ1bVEtGtglygk", "title": "B · the web card"}]},
    {"severity": "WARN", "code": "START_TASKS_START_BY_HAND",
     "message": "1 task is set to start by hand (autoRunWhenReady=false): they wait for the coordinator even after the project starts",
     "requiredAction": "Set autoRunWhenReady on the ones Orbit should start by itself, or start them with task_start once the project has started.",
     "criterion": null,
     "tasks": [{"taskId": "34X0DqI36auFRW9PTr9Rj", "title": "C · the native card"}]}
  ]
}`

// startRequestFiledBody is a filed request, with the one warning it carries.
const startRequestFiledBody = `{
  "itemId": "34XstartReq0000000001",
  "state": "OPEN",
  "alreadyOpen": false,
  "superseded": null,
  "settings": {"line": "PROJECT_BRANCH", "automatic": true, "maxConcurrentTasks": 3, "mergeCheckCommand": null},
  "why": "B and C both build on A",
  "criteriaDigest": "c2b4e16c4b59",
  "planDigest": "9f1c",
  "repository": "https://example.invalid/orbit",
  "warnings": [
    {"severity": "WARN", "code": "START_NO_MERGE_CHECK",
     "message": "Automatic is on and tasks land on a project branch with no merge check: the branch would merge into main with nothing run on the combined tree",
     "requiredAction": "Suggest a mergeCheckCommand — the command that proves the combined tree works.",
     "criterion": null, "tasks": []}
  ]
}`

// startRequestServer answers the start-request route with status and body, and records what it was
// sent. Any other path is a failure: the tool has exactly one door.
func startRequestServer(t *testing.T, status int, answer string) (*httptest.Server, *[]startRequestSeen) {
	t.Helper()
	seen := &[]startRequestSeen{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		*seen = append(*seen, startRequestSeen{
			method:  r.Method,
			path:    r.URL.Path,
			session: r.Header.Get("X-Orbit-Session-Id"),
			body:    body,
		})
		if r.URL.Path != "/api/runner/projects/proj-1/start-requests" {
			t.Errorf("project_request_start reached %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(answer))
	}))
	t.Cleanup(srv.Close)
	return srv, seen
}

type startRequestSeen struct {
	method, path, session string
	body                  map[string]interface{}
}

func toolText(t *testing.T, res map[string]interface{}) string {
	t.Helper()
	content, _ := res["content"].([]map[string]interface{})
	if len(content) == 0 {
		t.Fatalf("tool result has no content: %#v", res)
	}
	text, _ := content[0]["text"].(string)
	return text
}

// Offered to every session, like ask_owner: it starts nothing, so it rides no orchestration gate —
// and the description has to say when to call it and what happens, because a coordinator that
// learns either by trying has already told the owner something untrue.
func TestProjectRequestStartIsABaseToolThatSaysWhenToCallIt(t *testing.T) {
	for _, tools := range [][]map[string]interface{}{toolDescriptors(false, false), toolDescriptors(true, true)} {
		if !hasMCPTool(tools, "project_request_start") {
			t.Fatal("project_request_start is missing from the tools")
		}
	}
	tools := toolDescriptors(false, false)
	props := mcpToolProps(tools, "project_request_start")
	for _, want := range []string{
		"projectId", "line", "projectBranchName", "automatic", "maxConcurrentTasks",
		"mergeCheckCommand", "why",
	} {
		if _, ok := props[want]; !ok {
			t.Fatalf("project_request_start does not take %q: %#v", want, props)
		}
	}
	for _, tool := range tools {
		if tool["name"] != "project_request_start" {
			continue
		}
		schema, _ := tool["inputSchema"].(map[string]interface{})
		required, _ := schema["required"].([]string)
		if strings.Join(required, ",") != "projectId,line,maxConcurrentTasks,why" {
			t.Fatalf("project_request_start requires %v", required)
		}
	}
	description := mcpToolDescription(tools, "project_request_start")
	for _, want := range []string{
		// When: after the plan is written and every criterion is served.
		"once the plan is written",
		"EVERY acceptance criterion served by at least one task",
		// What a refusal is: every reason, and nothing filed.
		"every reason listed at once",
		"nothing is filed",
		// What success is: immediate, with the id and the warnings.
		"returns AT ONCE",
		"itemId and any warnings",
		// Why it matters: task_start is refused until the start.
		"task_start is refused",
	} {
		if !strings.Contains(description, want) {
			t.Fatalf("project_request_start's description does not say %q: %q", want, description)
		}
	}
}

func TestProjectRequestStartPostsTheSettingsAsTheCallingSession(t *testing.T) {
	srv, seen := startRequestServer(t, http.StatusCreated, startRequestFiledBody)
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "343dlzsYWKo5z8l2M8tsB"}

	res := mcp.callTool("project_request_start", map[string]interface{}{
		"projectId":          "proj-1",
		"line":               "PROJECT_BRANCH",
		"projectBranchName":  "refs/heads/project/next",
		"automatic":          true,
		"maxConcurrentTasks": float64(3),
		"mergeCheckCommand":  " npm test ",
		"why":                " B and C both build on A ",
	})
	if res["isError"] == true {
		t.Fatalf("project_request_start returned an error: %s", toolText(t, res))
	}
	if len(*seen) != 1 {
		t.Fatalf("project_request_start made %d requests", len(*seen))
	}
	sent := (*seen)[0]
	if sent.method != http.MethodPost {
		t.Fatalf("project_request_start used %s", sent.method)
	}
	// The acting session IS the authority the server checks.
	if sent.session != "343dlzsYWKo5z8l2M8tsB" {
		t.Fatalf("project_request_start session header = %q", sent.session)
	}
	want := map[string]interface{}{
		"line":               "PROJECT_BRANCH",
		"projectBranchName":  "refs/heads/project/next",
		"automatic":          true,
		"maxConcurrentTasks": float64(3),
		"mergeCheckCommand":  "npm test",
		"why":                "B and C both build on A",
	}
	for key, value := range want {
		if sent.body[key] != value {
			t.Fatalf("project_request_start sent %s = %#v, want %#v (body %#v)", key, sent.body[key], value, sent.body)
		}
	}
	if len(sent.body) != len(want) {
		t.Fatalf("project_request_start sent fields it was not given: %#v", sent.body)
	}

	text := toolText(t, res)
	for _, want := range []string{
		"34XstartReq0000000001", // the request, by the id the start door takes
		"nothing is waiting on this call",
		"task_start is refused",
		"START_NO_MERGE_CHECK", // the warning, which is the coordinator's and not on the owner's card
		"do: Suggest a mergeCheckCommand",
		"the owner's card does not show them",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("project_request_start's result does not say %q:\n%s", want, text)
		}
	}
}

// A merge check left out suggests none, and a blank one is the same: neither is sent.
func TestProjectRequestStartLeavesOutWhatWasNotSuggested(t *testing.T) {
	srv, seen := startRequestServer(t, http.StatusCreated, startRequestFiledBody)
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "343dlzsYWKo5z8l2M8tsB"}
	res := mcp.callTool("project_request_start", map[string]interface{}{
		"projectId":          "proj-1",
		"line":               "MAIN",
		"automatic":          false,
		"maxConcurrentTasks": "2",
		"mergeCheckCommand":  "   ",
		"why":                "one urgent fix",
	})
	if res["isError"] == true {
		t.Fatalf("project_request_start returned an error: %s", toolText(t, res))
	}
	body := (*seen)[0].body
	if _, sent := body["mergeCheckCommand"]; sent {
		t.Fatalf("a blank merge check was sent: %#v", body)
	}
	if _, sent := body["projectBranchName"]; sent {
		t.Fatalf("a branch nobody named was sent: %#v", body)
	}
	if body["automatic"] != false || body["maxConcurrentTasks"] != float64(2) || body["line"] != "MAIN" {
		t.Fatalf("project_request_start sent %#v", body)
	}
}

// Automatic left out is on: the owner's card opens with it on whatever is sent, so leaving it out is a
// suggestion rather than a refusal.
func TestProjectRequestStartLeftOutAutomaticIsOn(t *testing.T) {
	srv, seen := startRequestServer(t, http.StatusCreated, startRequestFiledBody)
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "343dlzsYWKo5z8l2M8tsB"}
	res := mcp.callTool("project_request_start", map[string]interface{}{
		"projectId":          "proj-1",
		"line":               "PROJECT_BRANCH",
		"maxConcurrentTasks": float64(3),
		"why":                "B and C both build on A",
	})
	if res["isError"] == true {
		t.Fatalf("project_request_start returned an error: %s", toolText(t, res))
	}
	if got := (*seen)[0].body["automatic"]; got != true {
		t.Fatalf("project_request_start with no automatic sent automatic = %#v, want true", got)
	}
}

// Every reason the server gave, one per line with what to do — the whole point of returning them at
// once is that the caller fixes the plan in one pass.
func TestProjectRequestStartListsEveryReasonTheServerGave(t *testing.T) {
	srv, _ := startRequestServer(t, http.StatusConflict, startRequestNotReadyBody)
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "343dlzsYWKo5z8l2M8tsB"}
	res := mcp.callTool("project_request_start", map[string]interface{}{
		"projectId": "proj-1", "line": "PROJECT_BRANCH", "automatic": true,
		"maxConcurrentTasks": float64(3), "why": "ready",
	})
	if res["isError"] != true {
		t.Fatalf("a refused request reads as filed: %#v", res)
	}
	text := toolText(t, res)
	for _, want := range []string{
		"not ready to start, and nothing was filed",
		"- START_CRITERION_UNSERVED: no task serves criterion 2",
		"criterion 2 (50RtdT7hcp2b0PzhjbSRYR): a plan that is not ready is refused",
		"do: File a task for it, or point one at it: criterionKey 50RtdT7hcp2b0PzhjbSRYR",
		"- START_TASK_HAS_NO_RUNNER:",
		"task 34X0Dq5lZ1bVEtGtglygk: B · the web card",
		"do: Assign each one to a workspace on a runner",
		"- START_TASKS_START_BY_HAND:",
		"task 34X0DqI36auFRW9PTr9Rj: C · the native card",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("the refusal does not say %q:\n%s", want, text)
		}
	}
	// The refusals come first, and the warning is said to be one.
	if strings.Index(text, "START_TASKS_START_BY_HAND") < strings.Index(text, "START_TASK_HAS_NO_RUNNER") {
		t.Fatalf("a warning is listed among the refusals:\n%s", text)
	}
	if !strings.Contains(text, "would not refuse it") {
		t.Fatalf("the warnings are not told apart from the refusals:\n%s", text)
	}
}

// Any other refusal — the wrong session, a started project — travels as the server raised it.
func TestProjectRequestStartPassesOtherRefusalsThrough(t *testing.T) {
	srv, _ := startRequestServer(t, http.StatusForbidden,
		`{"code":"START_REQUEST_COORDINATOR_ONLY","message":"only the conversation coordinating this project may ask its owner to start it."}`)
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "not-the-coordinator"}
	res := mcp.callTool("project_request_start", map[string]interface{}{
		"projectId": "proj-1", "line": "MAIN", "automatic": false,
		"maxConcurrentTasks": float64(1), "why": "ready",
	})
	if res["isError"] != true {
		t.Fatalf("a refused request reads as filed: %#v", res)
	}
	if text := toolText(t, res); !strings.Contains(text, "START_REQUEST_COORDINATOR_ONLY") {
		t.Fatalf("the refusal's code is lost:\n%s", text)
	}
}

// A shape the server would only refuse is refused before the round trip.
func TestProjectRequestStartRefusesABadShapeBeforeARoundTrip(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("a malformed request reached the server: %s %s", r.Method, r.URL.Path)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "343dlzsYWKo5z8l2M8tsB"}
	valid := func() map[string]interface{} {
		return map[string]interface{}{
			"projectId": "proj-1", "line": "PROJECT_BRANCH", "automatic": true,
			"maxConcurrentTasks": float64(3), "why": "ready",
		}
	}
	for name, mutate := range map[string]func(map[string]interface{}){
		"no project":               func(a map[string]interface{}) { delete(a, "projectId") },
		"no line":                  func(a map[string]interface{}) { delete(a, "line") },
		"an unknown line":          func(a map[string]interface{}) { a["line"] = "SOMEWHERE" },
		"automatic as a string":    func(a map[string]interface{}) { a["automatic"] = "yes" },
		"no concurrency":           func(a map[string]interface{}) { delete(a, "maxConcurrentTasks") },
		"zero concurrency":         func(a map[string]interface{}) { a["maxConcurrentTasks"] = float64(0) },
		"too much concurrency":     func(a map[string]interface{}) { a["maxConcurrentTasks"] = float64(101) },
		"no reason":                func(a map[string]interface{}) { delete(a, "why") },
		"a blank reason":           func(a map[string]interface{}) { a["why"] = "   " },
		"a branch for a main line": func(a map[string]interface{}) { a["line"] = "MAIN"; a["projectBranchName"] = "refs/heads/x" },
	} {
		args := valid()
		mutate(args)
		if res := mcp.callTool("project_request_start", args); res["isError"] != true {
			t.Fatalf("%s was accepted: %#v", name, args)
		}
	}
}

// The CLI twin sends the same request as the session it runs in, and renders a refusal the same way.
func TestProjectRequestStartCLISendsTheSameRequest(t *testing.T) {
	srv, seen := startRequestServer(t, http.StatusCreated, startRequestFiledBody)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")
	t.Setenv("ORBIT_SERVICE_TOKEN", "")

	var out bytes.Buffer
	if err := cmdProjectCLI([]string{
		"request-start", "proj-1", "--line", "PROJECT_BRANCH", "--automatic",
		"--max-concurrent-tasks", "3", "--merge-check-command", "npm test",
		"--why", "B and C both build on A", "--json",
	}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if len(*seen) != 1 || (*seen)[0].session != "sess-1" {
		t.Fatalf("request-start sent %#v", *seen)
	}
	body := (*seen)[0].body
	if body["line"] != "PROJECT_BRANCH" || body["automatic"] != true ||
		body["maxConcurrentTasks"] != float64(3) || body["mergeCheckCommand"] != "npm test" ||
		body["why"] != "B and C both build on A" {
		t.Fatalf("request-start sent %#v", body)
	}
	if _, sent := body["projectBranchName"]; sent {
		t.Fatalf("request-start sent a branch nobody named: %#v", body)
	}
	if !strings.Contains(out.String(), "34XstartReq0000000001") {
		t.Fatalf("request-start printed %q", out.String())
	}

	// --automatic=false is a suggestion too, and leaving the flag out suggests it on.
	out.Reset()
	if err := cmdProjectCLI([]string{
		"request-start", "proj-1", "--line", "MAIN", "--automatic=false",
		"--max-concurrent-tasks", "1", "--why", "one fix",
	}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if got := (*seen)[1].body["automatic"]; got != false {
		t.Fatalf("--automatic=false sent automatic = %#v", got)
	}
	if err := cmdProjectCLI([]string{
		"request-start", "proj-1", "--line", "MAIN", "--max-concurrent-tasks", "1", "--why", "one fix",
	}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if got := (*seen)[2].body["automatic"]; got != true {
		t.Fatalf("a request with no Automatic flag sent automatic = %#v, want it on", got)
	}
}

func TestProjectRequestStartCLIRendersEveryReason(t *testing.T) {
	srv, _ := startRequestServer(t, http.StatusConflict, startRequestNotReadyBody)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")
	t.Setenv("ORBIT_SERVICE_TOKEN", "")

	var out bytes.Buffer
	err := cmdProjectCLI([]string{
		"request-start", "proj-1", "--line", "PROJECT_BRANCH", "--automatic",
		"--max-concurrent-tasks", "3", "--why", "ready",
	}, strings.NewReader(""), &out)
	if err == nil {
		t.Fatal("a refused request exited cleanly")
	}
	for _, want := range []string{"START_CRITERION_UNSERVED", "START_TASK_HAS_NO_RUNNER", "do: "} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("the refusal does not say %q:\n%v", want, err)
		}
	}
}

// A terminal outside a session has no conversation to ask as: told here, not by a 403.
func TestProjectRequestStartCLINeedsTheSession(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("request-start reached the server with no session: %s %s", r.Method, r.URL.Path)
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "")

	var out bytes.Buffer
	err := cmdProjectCLI([]string{
		"request-start", "proj-1", "--line", "MAIN", "--automatic=false",
		"--max-concurrent-tasks", "1", "--why", "one fix",
	}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "ORBIT_SESSION_ID") {
		t.Fatalf("request-start without a session: %v", err)
	}
}
