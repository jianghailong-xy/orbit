package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Unit L7 at a terminal.
//
// What is asserted here is the pair of things a CLI can get wrong independently of the server: the
// route it asks, and the fact that a refusal arrives as something a person can act on rather than
// as one line of JSON. Plus one absence, tested as deliberately as any presence — there is no
// command that ANSWERS a crossing or reopens a settled project, because §7 RB2 puts both of those
// with the account owner and a machine credential is not one.

// oneRequest records the single request a command makes and answers it with `body`.
func oneRequest(t *testing.T, status int, body string) (*httptest.Server, *[]*http.Request, *[]string) {
	t.Helper()
	var seen []*http.Request
	var bodies []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		bodies = append(bodies, string(raw))
		seen = append(seen, r)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv, &seen, &bodies
}

func TestTaskAttributionReadsTheBoundaryForTheCurrentTask(t *testing.T) {
	srv, seen, _ := oneRequest(t, http.StatusOK, `{"taskId":"t1","owning":{"title":"P"}}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_TASK_ID", "task-1")

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"attribution", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if len(*seen) != 1 {
		t.Fatalf("requests = %d", len(*seen))
	}
	// The id comes from the session the command is running in, exactly as `task get` takes it —
	// an attribution read that needed the id typed out would be the one read nobody makes.
	if got := (*seen)[0].URL.Path; got != "/api/runner/tasks/task-1/attribution" {
		t.Fatalf("path = %q", got)
	}
	if (*seen)[0].Method != http.MethodGet {
		t.Fatalf("method = %q — the boundary is a read", (*seen)[0].Method)
	}
	if !strings.Contains(out.String(), `"taskId"`) {
		t.Fatalf("out = %q", out.String())
	}
}

func TestProjectCrossingsSendsTheStateFilterAndRefusesAnInventedOne(t *testing.T) {
	srv, seen, _ := oneRequest(t, http.StatusOK, `[]`)
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdProjectCLI([]string{"crossings", "proj-1", "--state", "PENDING", "--json"},
		strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if got := (*seen)[0].URL.Path; got != "/api/runner/projects/proj-1/handoffs" {
		t.Fatalf("path = %q", got)
	}
	if got := (*seen)[0].URL.Query().Get("state"); got != "PENDING" {
		t.Fatalf("state = %q", got)
	}

	// A typo is a sentence at the terminal, not a 400 after a round trip — the same discipline
	// every other enum flag here has.
	before := len(*seen)
	err := cmdProjectCLI([]string{"crossings", "proj-1", "--state", "MAYBE"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "PENDING") {
		t.Fatalf("err = %v", err)
	}
	if len(*seen) != before {
		t.Fatal("an invented state reached the server")
	}
}

func TestProjectReopenImpactIsAReadAndNamesBothEpochs(t *testing.T) {
	srv, seen, _ := oneRequest(t, http.StatusOK,
		`{"settled":true,"fromEpoch":"3","toEpoch":"4","retiringRuns":2,"acknowledgement":"3"}`)
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdProjectCLI([]string{"reopen-impact", "proj-1", "--json"},
		strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if got := (*seen)[0].URL.Path; got != "/api/runner/projects/proj-1/reopen" {
		t.Fatalf("path = %q", got)
	}
	if (*seen)[0].Method != http.MethodGet {
		t.Fatalf("method = %q — a coordinator reads what a reopen costs, it does not perform one",
			(*seen)[0].Method)
	}
	// Both epochs reach the caller, because what an account owner is being asked for is the
	// difference between them.
	for _, want := range []string{`"fromEpoch":"3"`, `"toEpoch":"4"`, `"acknowledgement":"3"`} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("out = %q missing %q", out.String(), want)
		}
	}
}

func TestCreateBatchDryRunAsksForAPlanAndNotAWrite(t *testing.T) {
	srv, seen, bodies := oneRequest(t, http.StatusOK,
		`{"dryRun":true,"wouldWrite":1,"refused":false,"findings":[],"plan":[{"index":0,"projectTitle":"P"}]}`)
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdTaskCLI(
		[]string{"create-batch", "--tasks", `[{"title":"a","projectId":"proj-1"}]`, "--dry-run", "--json"},
		strings.NewReader(""), &out,
	); err != nil {
		t.Fatal(err)
	}
	if got := (*seen)[0].URL.Path; got != "/api/runner/tasks/batch-create" {
		t.Fatalf("path = %q — a preview served by another route is one that can disagree with the write", got)
	}
	var body map[string]interface{}
	if err := json.Unmarshal([]byte((*bodies)[0]), &body); err != nil {
		t.Fatal(err)
	}
	if body["dryRun"] != true {
		t.Fatalf("body = %v", body)
	}
	if !strings.Contains(out.String(), `"projectTitle":"P"`) {
		t.Fatalf("out = %q — a plan preview that does not name the project is not a preview", out.String())
	}
}

func TestCreateBatchWithoutDryRunSendsNoSuchFlag(t *testing.T) {
	// Absence is the default and it has to STAY absent: `dryRun: false` on the wire would be a
	// caller asserting something about a field older servers do not know.
	srv, _, bodies := oneRequest(t, http.StatusOK, `[]`)
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdTaskCLI(
		[]string{"create-batch", "--tasks", `[{"title":"a"}]`, "--json"}, strings.NewReader(""), &out,
	); err != nil {
		t.Fatal(err)
	}
	var body map[string]interface{}
	if err := json.Unmarshal([]byte((*bodies)[0]), &body); err != nil {
		t.Fatal(err)
	}
	if _, present := body["dryRun"]; present {
		t.Fatalf("body = %v", body)
	}
}

// A refusal the control plane spent a whole contract giving a stable code and one executable
// sentence is worth nothing at a terminal if reading it means parsing JSON by eye.
func TestARefusalPrintsItsCodeAndItsRequiredActionOnTheirOwnLines(t *testing.T) {
	srv, _, _ := oneRequest(t, http.StatusForbidden, `{"statusCode":403,"error":"Forbidden",`+
		`"code":"PROJECT_REOPEN_REQUIRED","rule":"R8_SETTLED_PROJECT","responsible":"USER",`+
		`"requiredAction":"REOPEN_PROJECT_FIRST","message":"PROJECT_REOPEN_REQUIRED (project X): `+
		`That project is settled.","owner":"USER"}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_TASK_ID", "task-1")

	var out bytes.Buffer
	err := cmdTaskCLI([]string{"attribution", "--json"}, strings.NewReader(""), &out)
	if err == nil {
		t.Fatal("a 403 was reported as success")
	}
	text := err.Error()
	for _, want := range []string{
		"refused: PROJECT_REOPEN_REQUIRED",
		"do:      REOPEN_PROJECT_FIRST",
		"owner:   USER",
		"That project is settled.",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("error = %q missing %q", text, want)
		}
	}
	// The raw body stays: a field neither line names, and a code this build has never heard of,
	// are still in there.
	if !strings.Contains(text, `"rule":"R8_SETTLED_PROJECT"`) {
		t.Fatalf("error = %q dropped the body", text)
	}
}

func TestARefusalWithNoCodeIsLeftExactlyAsItWas(t *testing.T) {
	// A class-validator 400 lists field messages and carries no code. Inventing a block for it
	// would be this layer claiming a structure the body does not have.
	srv, _, _ := oneRequest(t, http.StatusBadRequest,
		`{"statusCode":400,"message":["title should not be empty"],"error":"Bad Request"}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_TASK_ID", "task-1")

	var out bytes.Buffer
	err := cmdTaskCLI([]string{"attribution", "--json"}, strings.NewReader(""), &out)
	if err == nil {
		t.Fatal("a 400 was reported as success")
	}
	if strings.Contains(err.Error(), "refused:") {
		t.Fatalf("error = %q invented a refusal block", err.Error())
	}
	if !strings.Contains(err.Error(), "title should not be empty") {
		t.Fatalf("error = %q", err.Error())
	}
}

// §7 RB2 and §7's reopen row, as an assertion rather than as a comment: the two writes L7 is about
// are the account owner's, so no command and no tool here performs either. A machine credential
// that could answer a crossing would be one agent accepting work on another goal's behalf, which is
// the original incident with one more actor in it.
func TestNoMachineDoorAnswersACrossingOrReopensAProject(t *testing.T) {
	for _, spec := range projectCLICapabilities {
		if spec.Mutates && (strings.Contains(spec.Tool, "crossing") || strings.Contains(spec.Tool, "reopen")) {
			t.Fatalf("%s is advertised as a write", spec.Tool)
		}
	}
	for _, tool := range toolDescriptors(true, true) {
		name, _ := tool["name"].(string)
		switch name {
		case "project_crossing_decide", "project_handoff_decide", "project_reopen", "task_handoff_decide":
			t.Fatalf("%s exists; answering a crossing and reopening a project are the owner's", name)
		}
	}
	// And the commands themselves: `crossings` and `reopen-impact` are the only two spellings, so
	// a future `orbit project reopen` cannot arrive without this test noticing.
	for _, verb := range []string{"reopen", "crossing-decide", "handoff-decide"} {
		if _, exists := projectActionHelp[verb]; exists {
			t.Fatalf("orbit project %s exists; that write is the account owner's", verb)
		}
	}
}
