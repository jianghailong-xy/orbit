package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// project_request_done: a project's coordinator asks the account owner to record the project done,
// and the server checks the project first. What is tested here is the runner's half, as for
// project_request_start: the tool is offered, the request is sent as the calling session with the
// call and the gaps as given, a refusal comes back as a list a model can act on line by line, and the
// CLI twin sends the same request.

// doneRequestNotReadyBody is a refusal as the server words it, every finding at once.
const doneRequestNotReadyBody = `{
  "code": "DONE_REQUEST_NOT_READY",
  "message": "this project is not ready to be recorded done: 4 checks refused it, and nothing was filed",
  "written": 0,
  "findings": [
    {"severity": "REFUSE", "code": "DONE_CRITERION_UNSATISFIED",
     "message": "criterion 2 is not met: 1 task serving it has not settled",
     "requiredAction": "Settle the work named here — each task by its own completion criterion — then ask again.",
     "criterion": {"key": "50RtdT7hcp2b0PzhjbSRYR", "ordinal": 2, "text": "a request that is not ready is refused"},
     "reason": null,
     "tasks": [{"taskId": "34X0Dq5lZ1bVEtGtglygk", "title": "B · the request door"}], "items": [], "jobs": []},
    {"severity": "REFUSE", "code": "DONE_TASKS_IN_FLIGHT",
     "message": "1 task is still running, queued for a runner or IN_PROGRESS, so the project is still moving",
     "requiredAction": "Let them finish (task_await), or cancel the ones no longer wanted, then ask again.",
     "criterion": null, "reason": null,
     "tasks": [{"taskId": "34X0DqI36auFRW9PTr9Rj", "title": "C · the card"}], "items": [], "jobs": []},
    {"severity": "REFUSE", "code": "DONE_OWNER_ITEMS_OPEN",
     "message": "1 item is waiting on the owner, and a project is not recorded done over them",
     "requiredAction": "Have each one answered or handled — or withdraw a question of your own with open_item_resolve — then ask again.",
     "criterion": null, "reason": null, "tasks": [],
     "items": [{"itemId": "34XitemQuestion000001", "kind": "COORDINATOR_QUESTION", "title": "Which goes first?"}],
     "jobs": []},
    {"severity": "REFUSE", "code": "DONE_INTEGRATION_IN_FLIGHT",
     "message": "1 landing or merge into main is queued or running, so where the work ends up is not settled yet",
     "requiredAction": "Wait for them to finish — Orbit reads the landing again when they do — then ask again.",
     "criterion": null, "reason": null, "tasks": [], "items": [],
     "jobs": [{"integrationJobId": "34XjobLanding00000001", "kind": "LAND_TASK", "state": "RUNNING", "taskId": "34X0Dq5lZ1bVEtGtglygk"}]},
    {"severity": "WARN", "code": "DONE_CRITERION_UNLANDED",
     "message": "criterion 3's work made no commits of its own, so there is nothing to land and no merge for a receipt to record; none of the gaps names it",
     "requiredAction": "Name it as a gap: why Orbit cannot prove it, and what you checked instead.",
     "criterion": {"key": "4OaRXeFQzer8d8g8SUubPY", "ordinal": 3, "text": "it goes live"},
     "reason": "NOTHING_TO_LAND",
     "tasks": [{"taskId": "34Y7UuRAfwd8m2Jy5lsN0", "title": "go live"}], "items": [], "jobs": []}
  ]
}`

// doneRequestFiledBody is a filed request, with the one warning it carries.
const doneRequestFiledBody = `{
  "itemId": "34XdoneReq00000000001",
  "state": "OPEN",
  "alreadyOpen": false,
  "superseded": null,
  "criteriaDigest": "c2b4e16c4b59",
  "stateDigest": "9f1c",
  "judgment": "The goal is met; the go-live made no commits, and I checked it is live.",
  "gaps": [{"criterionKey": "4OaRXeFQzer8d8g8SUubPY", "title": "Go-live has nothing to land",
            "whyNotProven": "its task made no commits", "coordinatorChecked": "the live bundle has the new strings",
            "evidenceRefs": ["34Y4xlxE"]}],
  "warnings": [
    {"severity": "WARN", "code": "DONE_CRITERION_UNLANDED",
     "message": "criterion 3's work made no commits of its own, so there is nothing to land and no merge for a receipt to record",
     "requiredAction": "Name it as a gap: why Orbit cannot prove it, and what you checked instead.",
     "criterion": {"key": "4OaRXeFQzer8d8g8SUubPY", "ordinal": 3, "text": "it goes live"},
     "reason": "NOTHING_TO_LAND",
     "tasks": [{"taskId": "34Y7UuRAfwd8m2Jy5lsN0", "title": "go live"}], "items": [], "jobs": []}
  ]
}`

type doneRequestSeen struct {
	method, path, session string
	body                  map[string]interface{}
}

// doneRequestServer answers the done-request route with status and body, and records what it was
// sent. Any other path is a failure: the tool has exactly one door.
func doneRequestServer(t *testing.T, status int, answer string) (*httptest.Server, *[]doneRequestSeen) {
	t.Helper()
	seen := &[]doneRequestSeen{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		*seen = append(*seen, doneRequestSeen{
			method:  r.Method,
			path:    r.URL.Path,
			session: r.Header.Get("X-Orbit-Session-Id"),
			body:    body,
		})
		if r.URL.Path != "/api/runner/projects/proj-1/done-requests" {
			t.Errorf("project_request_done reached %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(answer))
	}))
	t.Cleanup(srv.Close)
	return srv, seen
}

// One gap as a model sends it over MCP: a JSON object, its references an array.
func doneGapArg() map[string]interface{} {
	return map[string]interface{}{
		"criterionKey":       " 4OaRXeFQzer8d8g8SUubPY ",
		"title":              " Go-live has nothing to land ",
		"whyNotProven":       " its task made no commits, so there is no merge to hold a receipt for ",
		"coordinatorChecked": " main contains all 15 files this project changed ",
		"evidenceRefs":       []interface{}{" 34Y4xlxE ", "https://example.invalid/walkthrough"},
	}
}

// Offered to every session, like project_request_start: it records nothing, so it rides no
// orchestration gate — and the description has to say when to call it and what happens, because a
// coordinator that learns either by trying has already told the owner something untrue.
func TestProjectRequestDoneIsABaseToolThatSaysWhenToCallIt(t *testing.T) {
	for _, tools := range [][]map[string]interface{}{toolDescriptors(false, false), toolDescriptors(true, true)} {
		if !hasMCPTool(tools, "project_request_done") {
			t.Fatal("project_request_done is missing from the tools")
		}
	}
	tools := toolDescriptors(false, false)
	props := mcpToolProps(tools, "project_request_done")
	for _, want := range []string{"projectId", "judgment", "gaps"} {
		if _, ok := props[want]; !ok {
			t.Fatalf("project_request_done does not take %q: %#v", want, props)
		}
	}
	for _, tool := range tools {
		if tool["name"] != "project_request_done" {
			continue
		}
		schema, _ := tool["inputSchema"].(map[string]interface{})
		required, _ := schema["required"].([]string)
		if strings.Join(required, ",") != "projectId,judgment,gaps" {
			t.Fatalf("project_request_done requires %v", required)
		}
		// Every part of a gap the owner decides on is required; the headline is not.
		gaps, _ := props["gaps"].(map[string]interface{})
		items, _ := gaps["items"].(map[string]interface{})
		gapRequired, _ := items["required"].([]string)
		if strings.Join(gapRequired, ",") != "criterionKey,whyNotProven,coordinatorChecked,evidenceRefs" {
			t.Fatalf("a gap requires %v", gapRequired)
		}
		gapProps, _ := items["properties"].(map[string]interface{})
		if _, ok := gapProps["title"]; !ok {
			t.Fatalf("a gap cannot carry a title: %#v", gapProps)
		}
	}
	description := mcpToolDescription(tools, "project_request_done")
	for _, want := range []string{
		// When: Orbit cannot prove it, and the coordinator checked anyway.
		"when it cannot",
		// What a refusal is: every reason, and nothing filed.
		"every reason listed at once",
		"nothing is filed",
		// Each of the four refusals, by what it is about.
		"a criterion its work has not met",
		"a task running, queued or IN_PROGRESS",
		"an item waiting on the owner",
		"a landing or a merge into main queued or running",
		// What success is: immediate, with the id and the warnings.
		"returns AT ONCE",
		"a warning for every criterion not landed on main",
		// What the owner and the row see.
		"Is this project done?",
		"Ready to close",
		// What voids it.
		"voids it",
	} {
		if !strings.Contains(description, want) {
			t.Fatalf("project_request_done's description does not say %q: %q", want, description)
		}
	}
}

func TestProjectRequestDonePostsTheCallAndGapsAsTheCallingSession(t *testing.T) {
	srv, seen := doneRequestServer(t, http.StatusCreated, doneRequestFiledBody)
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "343dlzsYWKo5z8l2M8tsB"}

	res := mcp.callTool("project_request_done", map[string]interface{}{
		"projectId": "proj-1",
		"judgment":  "  The goal is met; the go-live made no commits, and I checked it is live.  ",
		"gaps":      []interface{}{doneGapArg()},
	})
	if res["isError"] == true {
		t.Fatalf("project_request_done returned an error: %s", toolText(t, res))
	}
	if len(*seen) != 1 {
		t.Fatalf("project_request_done made %d requests", len(*seen))
	}
	sent := (*seen)[0]
	if sent.method != http.MethodPost {
		t.Fatalf("project_request_done used %s", sent.method)
	}
	// The acting session IS the authority the server checks.
	if sent.session != "343dlzsYWKo5z8l2M8tsB" {
		t.Fatalf("project_request_done session header = %q", sent.session)
	}
	want := map[string]interface{}{
		"judgment": "The goal is met; the go-live made no commits, and I checked it is live.",
		"gaps": []interface{}{map[string]interface{}{
			"criterionKey":       "4OaRXeFQzer8d8g8SUubPY",
			"title":              "Go-live has nothing to land",
			"whyNotProven":       "its task made no commits, so there is no merge to hold a receipt for",
			"coordinatorChecked": "main contains all 15 files this project changed",
			"evidenceRefs":       []interface{}{"34Y4xlxE", "https://example.invalid/walkthrough"},
		}},
	}
	gotJSON, _ := json.Marshal(sent.body)
	wantJSON, _ := json.Marshal(want)
	if string(gotJSON) != string(wantJSON) {
		t.Fatalf("project_request_done sent\n%s\nwant\n%s", gotJSON, wantJSON)
	}

	text := toolText(t, res)
	for _, want := range []string{
		"34XdoneReq00000000001", // the request, by the id the done door takes
		"Is this project done?",
		"nothing is waiting on this call",
		"voids this request",
		"DONE_CRITERION_UNLANDED", // the warning the owner reads beside it
		"reason: NOTHING_TO_LAND",
		"do: Name it as a gap",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("project_request_done's result does not say %q:\n%s", want, text)
		}
	}
}

// Nothing Orbit cannot prove is an empty list, which is sent; a lone reference string is read as a
// list of one, and a blank headline is left out.
func TestProjectRequestDoneSendsAnEmptyGapListAndToleratesALoneReference(t *testing.T) {
	srv, seen := doneRequestServer(t, http.StatusCreated, doneRequestFiledBody)
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "343dlzsYWKo5z8l2M8tsB"}
	if res := mcp.callTool("project_request_done", map[string]interface{}{
		"projectId": "proj-1", "judgment": "Orbit can prove every criterion.", "gaps": []interface{}{},
	}); res["isError"] == true {
		t.Fatalf("an empty gap list was refused: %s", toolText(t, res))
	}
	gaps, ok := (*seen)[0].body["gaps"].([]interface{})
	if !ok || len(gaps) != 0 {
		t.Fatalf("an empty gap list was sent as %#v", (*seen)[0].body["gaps"])
	}

	gap := doneGapArg()
	gap["evidenceRefs"] = " 34Y4xlxE "
	gap["title"] = "   "
	if res := mcp.callTool("project_request_done", map[string]interface{}{
		"projectId": "proj-1", "judgment": "Done.", "gaps": []interface{}{gap},
	}); res["isError"] == true {
		t.Fatalf("a lone reference was refused: %s", toolText(t, res))
	}
	sent := (*seen)[1].body["gaps"].([]interface{})[0].(map[string]interface{})
	refs, _ := sent["evidenceRefs"].([]interface{})
	if len(refs) != 1 || refs[0] != "34Y4xlxE" {
		t.Fatalf("a lone reference was sent as %#v", sent["evidenceRefs"])
	}
	if _, titled := sent["title"]; titled {
		t.Fatalf("a blank headline was sent: %#v", sent)
	}
}

// Every reason the server gave, one per line with what to do — the whole point of returning them at
// once is that the caller fixes the project in one pass.
func TestProjectRequestDoneListsEveryReasonTheServerGave(t *testing.T) {
	srv, _ := doneRequestServer(t, http.StatusConflict, doneRequestNotReadyBody)
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "343dlzsYWKo5z8l2M8tsB"}
	res := mcp.callTool("project_request_done", map[string]interface{}{
		"projectId": "proj-1", "judgment": "Done.", "gaps": []interface{}{},
	})
	if res["isError"] != true {
		t.Fatalf("a refused request reads as filed: %#v", res)
	}
	text := toolText(t, res)
	for _, want := range []string{
		"not ready to be recorded done, and nothing was filed",
		"- DONE_CRITERION_UNSATISFIED: criterion 2 is not met",
		"criterion 2 (50RtdT7hcp2b0PzhjbSRYR): a request that is not ready is refused",
		"task 34X0Dq5lZ1bVEtGtglygk: B · the request door",
		"- DONE_TASKS_IN_FLIGHT:",
		"task 34X0DqI36auFRW9PTr9Rj: C · the card",
		"- DONE_OWNER_ITEMS_OPEN:",
		"item 34XitemQuestion000001 (COORDINATOR_QUESTION): Which goes first?",
		"- DONE_INTEGRATION_IN_FLIGHT:",
		"job 34XjobLanding00000001: LAND_TASK RUNNING (task 34X0Dq5lZ1bVEtGtglygk)",
		"- DONE_CRITERION_UNLANDED:",
		"reason: NOTHING_TO_LAND",
		"do: Let them finish (task_await)",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("the refusal does not say %q:\n%s", want, text)
		}
	}
	// The refusals come first, and the warning is said to be one.
	if strings.Index(text, "DONE_CRITERION_UNLANDED") < strings.Index(text, "DONE_INTEGRATION_IN_FLIGHT") {
		t.Fatalf("a warning is listed among the refusals:\n%s", text)
	}
	if !strings.Contains(text, "would not refuse it") {
		t.Fatalf("the warnings are not told apart from the refusals:\n%s", text)
	}
}

// Any other refusal — the wrong session, a project already done — travels as the server raised it.
func TestProjectRequestDonePassesOtherRefusalsThrough(t *testing.T) {
	srv, _ := doneRequestServer(t, http.StatusForbidden,
		`{"code":"DONE_REQUEST_COORDINATOR_ONLY","message":"only the conversation coordinating this project may ask its owner to record it done."}`)
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "not-the-coordinator"}
	res := mcp.callTool("project_request_done", map[string]interface{}{
		"projectId": "proj-1", "judgment": "Done.", "gaps": []interface{}{},
	})
	if res["isError"] != true {
		t.Fatalf("a refused request reads as filed: %#v", res)
	}
	if text := toolText(t, res); !strings.Contains(text, "DONE_REQUEST_COORDINATOR_ONLY") {
		t.Fatalf("the refusal's code is lost:\n%s", text)
	}
}

// A shape the server would only refuse is refused before the round trip.
func TestProjectRequestDoneRefusesABadShapeBeforeARoundTrip(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("a malformed request reached the server: %s %s", r.Method, r.URL.Path)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "343dlzsYWKo5z8l2M8tsB"}
	valid := func() map[string]interface{} {
		return map[string]interface{}{
			"projectId": "proj-1", "judgment": "Done.", "gaps": []interface{}{doneGapArg()},
		}
	}
	gapWith := func(mutate func(map[string]interface{})) func(map[string]interface{}) {
		return func(a map[string]interface{}) {
			gap := doneGapArg()
			mutate(gap)
			a["gaps"] = []interface{}{gap}
		}
	}
	for name, mutate := range map[string]func(map[string]interface{}){
		"no project":                func(a map[string]interface{}) { delete(a, "projectId") },
		"no judgment":               func(a map[string]interface{}) { delete(a, "judgment") },
		"a blank judgment":          func(a map[string]interface{}) { a["judgment"] = "   " },
		"no gaps at all":            func(a map[string]interface{}) { delete(a, "gaps") },
		"gaps as an object":         func(a map[string]interface{}) { a["gaps"] = doneGapArg() },
		"a gap that is a string":    func(a map[string]interface{}) { a["gaps"] = []interface{}{"criterion 3"} },
		"a gap with no criterion":   gapWith(func(g map[string]interface{}) { delete(g, "criterionKey") }),
		"a gap with no why":         gapWith(func(g map[string]interface{}) { g["whyNotProven"] = " " }),
		"a gap with no check":       gapWith(func(g map[string]interface{}) { delete(g, "coordinatorChecked") }),
		"a gap with no evidence":    gapWith(func(g map[string]interface{}) { delete(g, "evidenceRefs") }),
		"a gap with empty evidence": gapWith(func(g map[string]interface{}) { g["evidenceRefs"] = []interface{}{} }),
		"a blank reference":         gapWith(func(g map[string]interface{}) { g["evidenceRefs"] = []interface{}{"a", " "} }),
		"a reference not a string":  gapWith(func(g map[string]interface{}) { g["evidenceRefs"] = []interface{}{float64(3)} }),
	} {
		args := valid()
		mutate(args)
		if res := mcp.callTool("project_request_done", args); res["isError"] != true {
			t.Fatalf("%s was accepted: %#v", name, args)
		}
	}
}

// The CLI twin sends the same request as the session it runs in — the gaps inline or from stdin —
// and renders a refusal the same way.
func TestProjectRequestDoneCLISendsTheSameRequest(t *testing.T) {
	srv, seen := doneRequestServer(t, http.StatusCreated, doneRequestFiledBody)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")
	t.Setenv("ORBIT_SERVICE_TOKEN", "")

	gaps := `[{"criterionKey":"4OaRXeFQzer8d8g8SUubPY","title":"Go-live has nothing to land",` +
		`"whyNotProven":"its task made no commits","coordinatorChecked":"the live bundle has the new strings",` +
		`"evidenceRefs":["34Y4xlxE"]}]`
	var out bytes.Buffer
	if err := cmdProjectCLI([]string{
		"request-done", "proj-1", "--judgment", "The goal is met.", "--gaps", gaps, "--json",
	}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if len(*seen) != 1 || (*seen)[0].session != "sess-1" {
		t.Fatalf("request-done sent %#v", *seen)
	}
	body := (*seen)[0].body
	sentGaps, _ := body["gaps"].([]interface{})
	if body["judgment"] != "The goal is met." || len(sentGaps) != 1 {
		t.Fatalf("request-done sent %#v", body)
	}
	if gap, _ := sentGaps[0].(map[string]interface{}); gap["criterionKey"] != "4OaRXeFQzer8d8g8SUubPY" ||
		gap["title"] != "Go-live has nothing to land" {
		t.Fatalf("request-done sent the gap %#v", sentGaps[0])
	}
	if !strings.Contains(out.String(), "34XdoneReq00000000001") {
		t.Fatalf("request-done printed %q", out.String())
	}

	// The same gaps from stdin.
	out.Reset()
	if err := cmdProjectCLI([]string{
		"request-done", "proj-1", "--judgment", "The goal is met.", "--gaps-file", "-",
	}, strings.NewReader(gaps), &out); err != nil {
		t.Fatal(err)
	}
	if len(*seen) != 2 {
		t.Fatalf("request-done with --gaps-file sent %d requests", len(*seen))
	}
	if got, _ := json.Marshal((*seen)[1].body); string(got) != mustJSON(t, (*seen)[0].body) {
		t.Fatalf("--gaps-file sent %s, --gaps sent %s", got, mustJSON(t, (*seen)[0].body))
	}

	// Leaving the gaps out is not "none": [] says that.
	err := cmdProjectCLI([]string{"request-done", "proj-1", "--judgment", "Done."},
		strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "--gaps") {
		t.Fatalf("a request with no gaps flag was accepted: %v", err)
	}
	err = cmdProjectCLI([]string{"request-done", "proj-1", "--judgment", "Done.", "--gaps", "{"},
		strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "JSON") {
		t.Fatalf("gaps that are not JSON were accepted: %v", err)
	}
	if len(*seen) != 2 {
		t.Fatalf("a refused command reached the server: %#v", *seen)
	}
}

func TestProjectRequestDoneCLIRendersEveryReason(t *testing.T) {
	srv, _ := doneRequestServer(t, http.StatusConflict, doneRequestNotReadyBody)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")
	t.Setenv("ORBIT_SERVICE_TOKEN", "")

	var out bytes.Buffer
	err := cmdProjectCLI([]string{"request-done", "proj-1", "--judgment", "Done.", "--gaps", "[]"},
		strings.NewReader(""), &out)
	if err == nil {
		t.Fatal("a refused request exited cleanly")
	}
	for _, want := range []string{
		"DONE_CRITERION_UNSATISFIED", "DONE_TASKS_IN_FLIGHT", "DONE_OWNER_ITEMS_OPEN",
		"DONE_INTEGRATION_IN_FLIGHT", "do: ",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("the refusal does not say %q:\n%v", want, err)
		}
	}
}

// A terminal outside a session has no conversation to ask as: told here, not by a 403.
func TestProjectRequestDoneCLINeedsTheSession(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("request-done reached the server with no session: %s %s", r.Method, r.URL.Path)
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "")

	var out bytes.Buffer
	err := cmdProjectCLI([]string{"request-done", "proj-1", "--judgment", "Done.", "--gaps", "[]"},
		strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "ORBIT_SESSION_ID") {
		t.Fatalf("request-done without a session: %v", err)
	}
}
