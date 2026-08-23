package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// project_get rides no gate: reading the goal you are working towards is not an orchestration
// power, and the session that most needs it — a project coordinator — has no session_* tools.
func TestMCPProjectGetIsPartOfTheBaseTools(t *testing.T) {
	tools := toolDescriptors(false, false)
	if !hasMCPTool(tools, "project_get") {
		t.Fatal("project_get missing from the base tools")
	}
	props := mcpToolProps(tools, "project_get")
	projectID, _ := props["projectId"].(map[string]interface{})
	if projectID["type"] != "string" {
		t.Fatalf("project_get projectId schema = %#v", props["projectId"])
	}
	// One input, and it is required: there is no current-project env to default to.
	if len(props) != 1 {
		t.Fatalf("project_get properties = %#v", props)
	}
	for _, tool := range tools {
		if tool["name"] != "project_get" {
			continue
		}
		schema, _ := tool["inputSchema"].(map[string]interface{})
		required, _ := schema["required"].([]string)
		if len(required) != 1 || required[0] != "projectId" {
			t.Fatalf("project_get required = %#v", schema["required"])
		}
	}
	// The tool is only useful if the model can tell it from task_list; the description has to say
	// what it returns and what it deliberately does not.
	for _, tool := range tools {
		if tool["name"] != "project_get" {
			continue
		}
		description, _ := tool["description"].(string)
		for _, want := range []string{"acceptanceCriteria", "instructions", "task_list"} {
			if !strings.Contains(description, want) {
				t.Fatalf("project_get description does not mention %q: %q", want, description)
			}
		}
	}
}

func TestMCPProjectGetReadsTheRunnerProjectRoute(t *testing.T) {
	var method, path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		_, _ = w.Write([]byte(projectDetailJSON))
	}))
	defer srv.Close()

	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("project_get", map[string]interface{}{"projectId": "proj-1"})
	if res["isError"] == true {
		t.Fatalf("project_get returned an error: %#v", res["content"])
	}
	if method != http.MethodGet || path != "/api/runner/projects/proj-1" {
		t.Fatalf("project_get hit %s %s", method, path)
	}
	// The payload reaches the model whole — goal, acceptance criteria, instructions and tallies.
	content, _ := res["content"].([]map[string]interface{})
	text, _ := content[0]["text"].(string)
	for _, want := range []string{"Index the corpus", "Every shard reported", "tasksByStatus"} {
		if !strings.Contains(text, want) {
			t.Fatalf("project_get result does not carry %q: %q", want, text)
		}
	}
}

func TestMCPProjectGetRequiresAProjectID(t *testing.T) {
	mcp := &mcpServer{taskID: "task-1", t: NewTransport("http://127.0.0.1:1", "tok")}
	res := mcp.callTool("project_get", map[string]interface{}{})
	if res["isError"] != true {
		t.Fatalf("project_get without an id isError = %#v", res["isError"])
	}
	content, _ := res["content"].([]map[string]interface{})
	if len(content) == 0 || !strings.Contains(content[0]["text"].(string), "projectId is required") {
		t.Fatalf("project_get without an id result = %#v", res)
	}
}

func TestMCPProjectGetReportsTheServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"statusCode":404,"message":"project not found"}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("project_get", map[string]interface{}{"projectId": "proj-1"})
	if res["isError"] != true {
		t.Fatalf("a 404 project read isError = %#v", res["isError"])
	}
	content, _ := res["content"].([]map[string]interface{})
	text, _ := content[0]["text"].(string)
	if !strings.Contains(text, "get project failed") || !strings.Contains(text, "404") {
		t.Fatalf("project_get 404 result = %q", text)
	}
}

func TestMCPProjectIDCannotEscapeTheProjectRoute(t *testing.T) {
	mcp := &mcpServer{t: NewTransport("http://127.0.0.1:1", "tok")}
	for _, id := range []string{"../sessions", "..%2Fsessions", "a/b"} {
		res := mcp.callTool("project_get", map[string]interface{}{"projectId": id})
		if res["isError"] != true {
			t.Fatalf("project_get(%q) isError = %#v", id, res["isError"])
		}
		content, _ := res["content"].([]map[string]interface{})
		if len(content) == 0 || !strings.Contains(content[0]["text"].(string), "single safe path segment") {
			t.Fatalf("project_get(%q) result = %#v", id, res)
		}
	}
}

// The project surface is closed over these eleven tools. Listing projects, opening a coordinator
// and triggering a coordination run stay the human's door, so another tool appearing here is a
// decision somebody makes rather than something a refactor adds.
//
// project_status joined in unit 20 (contract AC10) and is a READ. The manual trigger that shipped
// beside it deliberately did not: enqueuing a signal attributed to USER is how a person drives a
// MANUAL project, so an agent able to do it would be driving its own coordinator.
func TestMCPExposesExactlyTheThirteenProjectTools(t *testing.T) {
	for _, tools := range [][]map[string]interface{}{
		toolDescriptors(false, false),
		toolDescriptors(true, true),
	} {
		seen := map[string]bool{}
		for _, tool := range tools {
			name, _ := tool["name"].(string)
			if strings.HasPrefix(name, "project_") {
				seen[name] = true
			}
		}
		for _, want := range []string{
			"project_get", "project_status", "project_verifications", "project_create",
			"project_update", "project_delete",
			// Unit 25C: the blocker read, open and resolved. Ungated for the reason the rest are —
			// the session that most needs to know why a project is not moving is its coordinator.
			"project_blockers",
			// Unit 25A: native acceptance. Three of the four are writes, and they are here rather
			// than behind the orchestration gate for the reason project_create is — the session
			// that most needs to run a project's acceptance is a coordinator, which has no
			// session_* tools at all.
			"project_acceptance", "project_acceptance_run", "project_acceptance_verdict",
			"project_merge_evidence",
			// Unit L7: two READS and no third write. A coordinator refused
			// CROSS_PROJECT_APPROVAL_REQUIRED or PROJECT_REOPEN_REQUIRED is entitled to know what
			// it is waiting on and what asking a person for it would cost them; it is not entitled
			// to answer the crossing (§7 RB2 — the approver is the account owner, never the target
			// project's coordinator) or to reopen a settled project it wants to write into. The
			// absence of a `project_reopen` beside `project_reopen_impact` is the whole point.
			"project_crossings", "project_reopen_impact",
		} {
			if !seen[want] {
				t.Fatalf("%s missing from the tools", want)
			}
			delete(seen, want)
		}
		if len(seen) != 0 {
			t.Fatalf("unexpected project tools exposed: %#v", seen)
		}
	}
}

// Ungated for the same reason project_get is: the session that most needs to record what a body of
// work is for — a coordinator — has no session_* tools at all.
func TestMCPProjectWritesArePartOfTheBaseTools(t *testing.T) {
	tools := toolDescriptors(false, false)

	createProps := mcpToolProps(tools, "project_create")
	for _, field := range []string{"title", "goal", "acceptanceCriteria", "instructions"} {
		prop, _ := createProps[field].(map[string]interface{})
		if prop["type"] != "string" {
			t.Fatalf("project_create %s schema = %#v", field, createProps[field])
		}
	}
	if len(createProps) != 4 {
		t.Fatalf("project_create properties = %#v", createProps)
	}
	if got := mcpToolRequired(t, tools, "project_create"); len(got) != 1 || got[0] != "title" {
		t.Fatalf("project_create required = %#v", got)
	}

	updateProps := mcpToolProps(tools, "project_update")
	if len(updateProps) != 7 {
		t.Fatalf("project_update properties = %#v", updateProps)
	}
	// The seventh is the compare-and-swap fence, and it is a STRING: configRevision is a bigint
	// column served as a decimal string, and a numeric schema would tell a model to round it.
	revisionProp, _ := updateProps["expectedConfigRevision"].(map[string]interface{})
	if revisionProp["type"] != "string" {
		t.Fatalf("project_update expectedConfigRevision type = %#v", revisionProp["type"])
	}
	// The prose fields accept null, and that is not decoration: without it a model following the
	// schema has no way to express "there is no stated goal any more" and would send "" instead.
	for _, field := range []string{"goal", "acceptanceCriteria", "instructions"} {
		prop, _ := updateProps[field].(map[string]interface{})
		types, _ := prop["type"].([]string)
		if len(types) != 2 || types[0] != "string" || types[1] != "null" {
			t.Fatalf("project_update %s type = %#v", field, prop["type"])
		}
	}
	// status is a closed set, and the three the server's DTO validates against.
	statusProp, _ := updateProps["status"].(map[string]interface{})
	statusEnum, _ := statusProp["enum"].([]string)
	if strings.Join(statusEnum, ",") != "OPEN,DONE,CANCELLED" {
		t.Fatalf("project_update status enum = %#v", statusProp["enum"])
	}
	if got := mcpToolRequired(t, tools, "project_update"); len(got) != 1 || got[0] != "projectId" {
		t.Fatalf("project_update required = %#v", got)
	}
	deleteProps := mcpToolProps(tools, "project_delete")
	if len(deleteProps) != 1 {
		t.Fatalf("project_delete properties = %#v", deleteProps)
	}
	if got := mcpToolRequired(t, tools, "project_delete"); len(got) != 1 || got[0] != "projectId" {
		t.Fatalf("project_delete required = %#v", got)
	}
	deleteDescription := mcpToolDescription(tools, "project_delete")
	for _, want := range []string{"Permanently", "cannot be undone", "holds tasks", "refused"} {
		if !strings.Contains(deleteDescription, want) {
			t.Fatalf("project_delete description does not mention %q: %q", want, deleteDescription)
		}
	}

	// The descriptions are what a model decides from, so they have to state the scope it writes
	// into and that writing is its call to make — the old wording said these fields were the
	// owner's alone, which is exactly the belief that would stop it recording a goal it was asked
	// for. Nothing may claim they are human-only.
	for _, name := range []string{"project_get", "project_create", "project_update", "project_delete"} {
		description := mcpToolDescription(tools, name)
		if !strings.Contains(description, "account this runner belongs to") {
			t.Fatalf("%s description does not state its owner scope: %q", name, description)
		}
		for _, forbidden := range []string{"Read-only", "human-only", "owner's statement"} {
			if strings.Contains(description, forbidden) {
				t.Fatalf("%s description still claims %q: %q", name, forbidden, description)
			}
		}
	}
	for _, name := range []string{"project_create", "project_update"} {
		if !strings.Contains(mcpToolDescription(tools, name), "authority") {
			t.Fatalf("%s does not tell the model it may write these fields", name)
		}
	}
	if !strings.Contains(mcpToolDescription(tools, "project_update"), "null to clear") {
		t.Fatalf("project_update does not document the null clear: %q", mcpToolDescription(tools, "project_update"))
	}
}

func mcpToolRequired(t *testing.T, tools []map[string]interface{}, name string) []string {
	t.Helper()
	for _, tool := range tools {
		if tool["name"] != name {
			continue
		}
		schema, _ := tool["inputSchema"].(map[string]interface{})
		required, _ := schema["required"].([]string)
		return required
	}
	t.Fatalf("%s missing from the tools", name)
	return nil
}

func mcpToolDescription(tools []map[string]interface{}, name string) string {
	for _, tool := range tools {
		if tool["name"] == name {
			description, _ := tool["description"].(string)
			return description
		}
	}
	return ""
}

func TestMCPProjectCreatePostsTheRunnerProjectRoute(t *testing.T) {
	var method, path string
	var body map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(projectCreatedJSON))
	}))
	defer srv.Close()

	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("project_create", map[string]interface{}{
		"title":              "Crawl",
		"goal":               "Index the corpus",
		"acceptanceCriteria": "Every shard reported",
		"instructions":       "Work shard by shard",
	})
	if res["isError"] == true {
		t.Fatalf("project_create returned an error: %#v", res["content"])
	}
	if method != http.MethodPost || path != "/api/runner/projects" {
		t.Fatalf("project_create hit %s %s", method, path)
	}
	want := map[string]interface{}{
		"title":              "Crawl",
		"goal":               "Index the corpus",
		"acceptanceCriteria": "Every shard reported",
		"instructions":       "Work shard by shard",
	}
	if fmt.Sprintf("%v", body) != fmt.Sprintf("%v", want) {
		t.Fatalf("project_create body = %#v", body)
	}
	// The created project reaches the model whole, id included — that id is what task_create then
	// files work under.
	content, _ := res["content"].([]map[string]interface{})
	if text, _ := content[0]["text"].(string); !strings.Contains(text, "proj-2") {
		t.Fatalf("project_create result = %q", text)
	}
}

// Fields the model did not name must not be invented: the server stores blank prose as null, so a
// phantom "" would be recorded as a goal that was stated and left empty.
func TestMCPProjectCreateSendsOnlyWhatWasGiven(t *testing.T) {
	var body map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(projectCreatedJSON))
	}))
	defer srv.Close()

	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("project_create", map[string]interface{}{"title": "Crawl"})
	if res["isError"] == true {
		t.Fatalf("project_create returned an error: %#v", res["content"])
	}
	if len(body) != 1 || body["title"] != "Crawl" {
		t.Fatalf("project_create body = %#v", body)
	}
}

func TestMCPProjectCreateRequiresATitle(t *testing.T) {
	var hit bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
	}))
	defer srv.Close()

	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("project_create", map[string]interface{}{"goal": "Index the corpus"})
	if res["isError"] != true {
		t.Fatalf("project_create without a title isError = %#v", res["isError"])
	}
	content, _ := res["content"].([]map[string]interface{})
	if len(content) == 0 || !strings.Contains(content[0]["text"].(string), "title is required") {
		t.Fatalf("project_create without a title result = %#v", res)
	}
	if hit {
		t.Fatal("project_create called the server with no title")
	}
}

func TestMCPProjectDeleteUsesTheGuardedRunnerRoute(t *testing.T) {
	var method, path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("project_delete", map[string]interface{}{"projectId": "proj-1"})
	if res["isError"] == true {
		t.Fatalf("project_delete returned an error: %#v", res["content"])
	}
	if method != http.MethodDelete || path != "/api/runner/projects/proj-1" {
		t.Fatalf("project_delete hit %s %s", method, path)
	}
	content, _ := res["content"].([]map[string]interface{})
	if text, _ := content[0]["text"].(string); !strings.Contains(text, `"ok": true`) {
		t.Fatalf("project_delete result = %q", text)
	}
}

func TestMCPProjectDeleteRequiresASafeProjectID(t *testing.T) {
	mcp := &mcpServer{t: NewTransport("http://127.0.0.1:1", "tok")}
	for _, args := range []map[string]interface{}{{}, {"projectId": "../tasks"}} {
		res := mcp.callTool("project_delete", args)
		if res["isError"] != true {
			t.Fatalf("project_delete(%#v) isError = %#v", args, res["isError"])
		}
	}
}

// Omitted, replaced and cleared are three different instructions, and the difference only survives
// if the handler copies keys rather than reading values: a `goal` read as a string turns an
// explicit null into "", and a nil-skipping copy turns it into "leave the goal alone".
func TestMCPProjectUpdateDistinguishesOmittedFromNull(t *testing.T) {
	var raw string
	var body map[string]interface{}
	var method, path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		b, _ := io.ReadAll(r.Body)
		raw = string(b)
		_ = json.Unmarshal(b, &body)
		_, _ = w.Write([]byte(projectDetailJSON))
	}))
	defer srv.Close()

	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("project_update", map[string]interface{}{
		"projectId": "proj-1",
		"goal":      nil,
		"status":    "DONE",
	})
	if res["isError"] == true {
		t.Fatalf("project_update returned an error: %#v", res["content"])
	}
	if method != http.MethodPatch || path != "/api/runner/projects/proj-1" {
		t.Fatalf("project_update hit %s %s", method, path)
	}
	value, present := body["goal"]
	if !present || value != nil {
		t.Fatalf("project_update dropped the null goal clear: %s", raw)
	}
	if body["status"] != "DONE" {
		t.Fatalf("project_update status = %#v", body["status"])
	}
	// acceptanceCriteria and instructions were never mentioned, so they must not appear at all —
	// a key present with any value is an instruction to write that field.
	for _, omitted := range []string{"acceptanceCriteria", "instructions", "title"} {
		if _, present := body[omitted]; present {
			t.Fatalf("project_update sent %s nobody asked for: %s", omitted, raw)
		}
	}
	if len(body) != 2 {
		t.Fatalf("project_update body = %s", raw)
	}
}

func TestMCPProjectUpdateRequiresAnIDAndAField(t *testing.T) {
	var hit bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
	}))
	defer srv.Close()

	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("project_update", map[string]interface{}{"status": "DONE"})
	if res["isError"] != true {
		t.Fatalf("project_update without an id isError = %#v", res["isError"])
	}
	content, _ := res["content"].([]map[string]interface{})
	if !strings.Contains(content[0]["text"].(string), "projectId is required") {
		t.Fatalf("project_update without an id result = %#v", res)
	}

	// An update naming no field would come back 200 having changed nothing, which reads to the
	// model as a successful edit.
	res = mcp.callTool("project_update", map[string]interface{}{"projectId": "proj-1"})
	if res["isError"] != true {
		t.Fatalf("empty project_update isError = %#v", res["isError"])
	}
	content, _ = res["content"].([]map[string]interface{})
	if !strings.Contains(content[0]["text"].(string), "no fields to update") {
		t.Fatalf("empty project_update result = %#v", res)
	}
	if hit {
		t.Fatal("an invalid project_update reached the server")
	}
}

// A failed write is reported as a failure and attempted exactly once: a tool that retried on its
// own could create a second project, or apply an edit twice, on the strength of one call.
func TestMCPProjectWriteFailuresDoNotRetry(t *testing.T) {
	for _, tc := range []struct {
		tool   string
		args   map[string]interface{}
		status int
		want   string
	}{
		{"project_create", map[string]interface{}{"title": "Crawl"}, http.StatusBadRequest, "create project failed"},
		{"project_update", map[string]interface{}{"projectId": "proj-1", "status": "DONE"}, http.StatusNotFound, "update project failed"},
		{"project_delete", map[string]interface{}{"projectId": "proj-1"}, http.StatusConflict, "delete project failed"},
	} {
		calls := 0
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls++
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(`{"statusCode":0,"message":"nope"}`))
		}))

		mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}
		res := mcp.callTool(tc.tool, tc.args)
		srv.Close()

		if res["isError"] != true {
			t.Fatalf("%s on a %d isError = %#v", tc.tool, tc.status, res["isError"])
		}
		content, _ := res["content"].([]map[string]interface{})
		text, _ := content[0]["text"].(string)
		if !strings.Contains(text, tc.want) || !strings.Contains(text, fmt.Sprint(tc.status)) {
			t.Fatalf("%s result = %q", tc.tool, text)
		}
		if calls != 1 {
			t.Fatalf("%s made %d requests for one call", tc.tool, calls)
		}
	}
}

func TestMCPProjectUpdateIDCannotEscapeTheProjectRoute(t *testing.T) {
	mcp := &mcpServer{t: NewTransport("http://127.0.0.1:1", "tok")}
	for _, id := range []string{"../sessions", "..%2Fsessions", "a/b"} {
		res := mcp.callTool("project_update", map[string]interface{}{"projectId": id, "status": "DONE"})
		if res["isError"] != true {
			t.Fatalf("project_update(%q) isError = %#v", id, res["isError"])
		}
		content, _ := res["content"].([]map[string]interface{})
		if len(content) == 0 || !strings.Contains(content[0]["text"].(string), "single safe path segment") {
			t.Fatalf("project_update(%q) result = %#v", id, res)
		}
	}
}

// The calling session goes with the create, so the server can record this session's workspace as
// the project's coordinator default. This is the MCP half of the same contract `orbit project
// create` holds — both read the one session id the runner injected, and a project created by
// either has to be coordinatable the same way.
func TestMCPProjectCreateCarriesTheCallingSession(t *testing.T) {
	var session, method, path string
	var body map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		session = r.Header.Get("X-Orbit-Session-Id")
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(projectCreatedJSON))
	}))
	defer srv.Close()

	// Base62, the spelling the runner injects and the only one a model ever sees. Forwarded
	// verbatim: the server decodes it, and an id re-spelled here would match nothing.
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "343dlzsYWKo5z8l2M8tsB"}
	res := mcp.callTool("project_create", map[string]interface{}{"title": "Crawl"})
	if res["isError"] == true {
		t.Fatalf("project_create returned an error: %#v", res["content"])
	}
	if method != http.MethodPost || path != "/api/runner/projects" {
		t.Fatalf("project_create hit %s %s", method, path)
	}
	if session != "343dlzsYWKo5z8l2M8tsB" {
		t.Fatalf("project_create session header = %q", session)
	}
	// Context, not content: no workspace field appears in the body, because where the coordinator
	// opens is the server's conclusion about the session rather than this process's request.
	if len(body) != 1 || body["title"] != "Crawl" {
		t.Fatalf("project_create body = %#v", body)
	}
}

// `orbit mcp` outside a session (the runner injects nothing) must send no header at all rather
// than an empty one, which the server would look up as a session and refuse.
func TestMCPProjectCreateWithNoSessionSendsNoHeader(t *testing.T) {
	sawSessionHeader := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, sawSessionHeader = r.Header["X-Orbit-Session-Id"]
		_, _ = w.Write([]byte(projectCreatedJSON))
	}))
	defer srv.Close()

	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("project_create", map[string]interface{}{"title": "Crawl"})
	if res["isError"] == true {
		t.Fatalf("project_create returned an error: %#v", res["content"])
	}
	if sawSessionHeader {
		t.Fatal("project_create with no session sent a session header")
	}
}

// Only the create. A coordinator default is settled once, when the project is recorded; a read or
// an edit sent from wherever the agent happens to be now is not a request to move it.
func TestMCPProjectReadAndUpdateCarryNoSession(t *testing.T) {
	for _, tc := range []struct {
		tool string
		args map[string]interface{}
	}{
		{"project_get", map[string]interface{}{"projectId": "proj-1"}},
		{"project_update", map[string]interface{}{"projectId": "proj-1", "status": "DONE"}},
	} {
		sawSessionHeader := true
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, sawSessionHeader = r.Header["X-Orbit-Session-Id"]
			_, _ = w.Write([]byte(projectDetailJSON))
		}))

		mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "sess-1"}
		res := mcp.callTool(tc.tool, tc.args)
		srv.Close()
		if res["isError"] == true {
			t.Fatalf("%s returned an error: %#v", tc.tool, res["content"])
		}
		if sawSessionHeader {
			t.Fatalf("%s sent a session header", tc.tool)
		}
	}
}

// The description is what stops the model reinventing the workaround. "Holds no tasks" on its own
// reads as "so it cannot be coordinated yet", and the model's next move is to file a task purely
// to give the coordinator somewhere to run.
func TestMCPProjectCreateDescriptionStatesTheCoordinatorDefault(t *testing.T) {
	tools := toolDescriptors(false, false)
	var description string
	for _, tool := range tools {
		if tool["name"] == "project_create" {
			description, _ = tool["description"].(string)
		}
	}
	if description == "" {
		t.Fatal("project_create has no description")
	}
	for _, want := range []string{"coordinator", "session", "workspace"} {
		if !strings.Contains(strings.ToLower(description), want) {
			t.Fatalf("project_create description does not mention %q: %q", want, description)
		}
	}
	// And it must not promise an input that does not exist: the workspace comes from the session,
	// so a model hunting for a workspace argument would be hunting for nothing.
	props := mcpToolProps(tools, "project_create")
	for _, name := range []string{"workspaceId", "coordinatorWorkspaceId", "sessionId"} {
		if _, ok := props[name]; ok {
			t.Fatalf("project_create exposes a %q input", name)
		}
	}
}

// ── project_status (contract AC10, unit 20) ───────────────────────────────────────────────────

// The same read the CLI and the web app get, through the tool a coordinator calls. It has to reach
// the coordinator-status route specifically: the plain project read returns prose and tallies and
// says nothing about why the loop is or is not moving.
func TestMCPProjectStatusReadsTheCoordinatorStatusRoute(t *testing.T) {
	var path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		_, _ = w.Write([]byte(`{"projectId":"proj-1","runtime":{"runState":"PLANNING"}}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("project_status", map[string]interface{}{"projectId": "proj-1"})
	if res["isError"] == true {
		t.Fatalf("project_status result = %#v", res)
	}
	if path != "/api/runner/projects/proj-1/coordinator/status" {
		t.Fatalf("project_status hit %s", path)
	}
	content, _ := res["content"].([]map[string]interface{})
	text, _ := content[0]["text"].(string)
	if !strings.Contains(text, `"runState"`) {
		t.Fatalf("project_status returned %q", text)
	}
}

func TestMCPProjectStatusRequiresAProjectID(t *testing.T) {
	mcp := &mcpServer{t: NewTransport("http://127.0.0.1:1", "tok")}
	res := mcp.callTool("project_status", map[string]interface{}{})
	if res["isError"] != true {
		t.Fatalf("project_status without an id isError = %#v", res["isError"])
	}
	content, _ := res["content"].([]map[string]interface{})
	if !strings.Contains(content[0]["text"].(string), "projectId is required") {
		t.Fatalf("project_status without an id result = %#v", res)
	}
}

// The fence is forwarded as the caller spelled it, and only when the caller sent it. Dropping it
// would silently turn a compare-and-swap into a last-write-wins; inventing one would refuse writes
// nobody asked to fence.
func TestMCPProjectUpdateForwardsTheFenceOnlyWhenSent(t *testing.T) {
	var body map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body = nil
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(`{"id":"proj-1"}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}
	mcp.callTool("project_update", map[string]interface{}{
		"projectId": "proj-1", "title": "Crawl", "expectedConfigRevision": "7",
	})
	if body["expectedConfigRevision"] != "7" {
		t.Fatalf("project_update body = %#v", body)
	}

	mcp.callTool("project_update", map[string]interface{}{"projectId": "proj-1", "title": "Crawl"})
	if _, present := body["expectedConfigRevision"]; present {
		t.Fatalf("project_update invented a fence: %#v", body)
	}
}

// A fence alone names nothing to write. Sending it would be a request the server accepts and that
// changes nothing, which reads back to the model as an edit that went through.
func TestMCPProjectUpdateRefusesAFenceWithNoFields(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("an update with no fields reached the server")
		_, _ = w.Write([]byte(`{"id":"proj-1"}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("project_update", map[string]interface{}{
		"projectId": "proj-1", "expectedConfigRevision": "7",
	})
	if res["isError"] != true {
		t.Fatalf("a fence-only update isError = %#v", res["isError"])
	}
}
