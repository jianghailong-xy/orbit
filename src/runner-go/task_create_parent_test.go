package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A coordinator can file a task under a project, but every task it created was a peer of every
// other — there was no way to say that one task is a PART of another, so work broken into steps
// arrived as a flat pile with the relationship living only in the prose. These tests pin the write
// to the wire: the parent has to reach the server on the create, or the subtask is created loose
// and nothing says what it belongs to.
//
// The server never infers the project from the parent — it compares the parent's project against
// the projectId of THIS request — so the pairing of the two fields is the thing most worth pinning,
// and it is asserted on every path below rather than only on the single form.

func TestTaskCLICreateSendsParentTaskIDWithItsProject(t *testing.T) {
	srv, bodies := captureCreateBody(t, "/api/runner/tasks")
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdTaskCLI([]string{
		"create", "--title", "Step one",
		"--completion-criterion", "EVIDENCE_JUDGMENT",
		"--project-id", "proj-1",
		"--parent-task-id", "task-parent",
		"--json",
	}, strings.NewReader(""), &out)
	if err != nil {
		t.Fatal(err)
	}

	if len(*bodies) != 1 {
		t.Fatalf("requests = %d", len(*bodies))
	}
	body := (*bodies)[0]
	// Both, together: the server checks the parent against the project on this request, so a body
	// carrying only one of them is either a rejected write or a subtask filed in the wrong place.
	if body["parentTaskId"] != "task-parent" {
		t.Fatalf("parentTaskId = %#v, body = %#v", body["parentTaskId"], body)
	}
	if body["projectId"] != "proj-1" {
		t.Fatalf("projectId = %#v, body = %#v", body["projectId"], body)
	}
	if body["title"] != "Step one" {
		t.Fatalf("body lost a field: %#v", body)
	}
}

// A projectless parent is the other legal shape, and it is the one a flag that quietly defaulted a
// project would break: no projectId at all must stay no projectId at all.
func TestTaskCLICreateSendsParentTaskIDWithoutAProject(t *testing.T) {
	srv, bodies := captureCreateBody(t, "/api/runner/tasks")
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdTaskCLI([]string{"create", "--title", "Step one", "--completion-criterion", "EVIDENCE_JUDGMENT", "--parent-task-id", "task-parent", "--json"},
		strings.NewReader(""), &out)
	if err != nil {
		t.Fatal(err)
	}

	body := (*bodies)[0]
	if body["parentTaskId"] != "task-parent" {
		t.Fatalf("parentTaskId = %#v, body = %#v", body["parentTaskId"], body)
	}
	if _, present := body["projectId"]; present {
		t.Fatalf("a projectless parent had a project invented for it: %#v", body)
	}
}

// Every create that existed before this flag must still send the request it sent before: an empty
// parentTaskId in the body is not "no parent", it is an id the server has to look up and reject.
func TestTaskCLICreateOmitsParentTaskIDWhenNotAsked(t *testing.T) {
	srv, bodies := captureCreateBody(t, "/api/runner/tasks")
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"create", "--title", "Ship it", "--completion-criterion", "EVIDENCE_JUDGMENT", "--project-id", "proj-1", "--json"},
		strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}

	if _, present := (*bodies)[0]["parentTaskId"]; present {
		t.Fatalf("parentTaskId sent without the flag: %#v", (*bodies)[0])
	}
}

// `--parent-task-id ""` is a typo or an unset shell variable, not a request to create a top-level
// task. Caught locally, because the alternative is a round trip that writes nothing and comes back
// with a validation error about a field the caller never meant to send.
func TestTaskCLICreateRejectsABlankParentTaskIDWithoutCallingTheServer(t *testing.T) {
	var requests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{"id":"created-task"}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdTaskCLI([]string{"create", "--title", "Ship it", "--parent-task-id", "", "--json"},
		strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "--parent-task-id cannot be empty") {
		t.Fatalf("err = %v", err)
	}
	if requests != 0 {
		t.Fatalf("requests = %d, want the blank flag caught before the round trip", requests)
	}
}

// The field is declared once and shared, so it has to appear on both doors: a schema carrying it on
// task_create alone leaves a plan that breaks work into steps unable to attach any of them.
func TestMCPTaskCreateTakesAParentTaskIDOnSingleAndBatchItems(t *testing.T) {
	tools := toolDescriptors(false, false)

	single := mcpToolProps(tools, "task_create")
	singleParent, _ := single["parentTaskId"].(map[string]interface{})
	if singleParent["type"] != "string" {
		t.Fatalf("task_create parentTaskId schema = %#v", single["parentTaskId"])
	}

	batch := mcpToolProps(tools, "task_create_batch")
	tasks, _ := batch["tasks"].(map[string]interface{})
	items, _ := tasks["items"].(map[string]interface{})
	itemProps, _ := items["properties"].(map[string]interface{})
	itemParent, _ := itemProps["parentTaskId"].(map[string]interface{})
	if itemParent["type"] != "string" {
		t.Fatalf("task_create_batch item parentTaskId schema = %#v", itemProps["parentTaskId"])
	}

	// Optional on both: a top-level task is still the ordinary case.
	for _, name := range []string{"task_create", "task_create_batch"} {
		for _, tool := range tools {
			if tool["name"] != name {
				continue
			}
			schema, _ := tool["inputSchema"].(map[string]interface{})
			required, _ := schema["required"].([]string)
			for _, field := range required {
				if field == "parentTaskId" {
					t.Fatalf("%s made parentTaskId required", name)
				}
			}
			description, _ := tool["description"].(string)
			if !strings.Contains(description, "parentTaskId") {
				t.Fatalf("%s description does not mention parentTaskId: %q", name, description)
			}
		}
	}

	// The two things a model cannot recover from by retrying: sending a parent without the matching
	// project (rejected, because the project is not inherited), and reaching for parentTaskId to
	// nest one item of a batch under another, which refs do not do and this field cannot express.
	parentDesc, _ := itemParent["description"].(string)
	if !strings.Contains(parentDesc, "projectId") {
		t.Fatalf("parentTaskId description does not tie it to projectId: %q", parentDesc)
	}
	if !strings.Contains(parentDesc, "EXISTING") {
		t.Fatalf("parentTaskId description does not say the parent must already exist: %q", parentDesc)
	}
	for _, tool := range tools {
		if tool["name"] != "task_create_batch" {
			continue
		}
		description, _ := tool["description"].(string)
		if !strings.Contains(description, "ref") {
			t.Fatalf("task_create_batch does not separate parentTaskId from refs: %q", description)
		}
	}
}

func TestMCPTaskCreateSendsTheParentTaskIDToTheServer(t *testing.T) {
	srv, bodies := captureCreateBody(t, "/api/runner/tasks")

	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create", map[string]interface{}{
		"title":               "Step one",
		"projectId":           "proj-1",
		"parentTaskId":        "task-parent",
		"completionCriterion": "EVIDENCE_JUDGMENT",
	})
	if res["isError"] == true {
		t.Fatalf("task_create returned an error: %#v", res["content"])
	}

	body := (*bodies)[0]
	if body["parentTaskId"] != "task-parent" || body["projectId"] != "proj-1" {
		t.Fatalf("task_create body = %#v", body)
	}
}

// The batch copies its fields through a second, separate list from the single form — so it is the
// one that silently drops a field task_create carries, and this test fails on its own if that list
// is left alone. It also runs the approval path, where the body is built once for the preview card
// and again for the write: a parent that reaches only the second is a card that under-describes
// what a human is being asked to approve.
func TestMCPTaskCreateBatchSendsEveryItemsParentTaskID(t *testing.T) {
	var previewBody, createBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/tasks/batch-preview"):
			_ = json.NewDecoder(r.Body).Decode(&previewBody)
			_, _ = w.Write([]byte(`{"taskCount":2,"startingNow":1}`))
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			_, _ = w.Write([]byte(`{"id":"ap1","status":"ALLOWED"}`))
		case strings.Contains(r.URL.Path, "/approvals/"):
			_, _ = w.Write([]byte(`{"status":"ALLOWED"}`))
		default:
			_ = json.NewDecoder(r.Body).Decode(&createBody)
			_, _ = w.Write([]byte(`[{"id":"t1"},{"id":"t2"}]`))
		}
	}))
	defer srv.Close()

	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create_batch", map[string]interface{}{
		"tasks": []interface{}{
			map[string]interface{}{"title": "first", "projectId": "proj-1", "parentTaskId": "task-parent", "ref": "s0", "completionCriterion": "EVIDENCE_JUDGMENT"},
			map[string]interface{}{"title": "second", "projectId": "proj-1", "parentTaskId": "task-parent", "dependsOnRefs": []interface{}{"s0"}, "completionCriterion": "EVIDENCE_JUDGMENT"},
		},
	})
	if res["isError"] == true {
		t.Fatalf("task_create_batch returned an error: %#v", res["content"])
	}

	for label, body := range map[string]map[string]interface{}{"preview": previewBody, "create": createBody} {
		sent, _ := body["tasks"].([]interface{})
		if len(sent) != 2 {
			t.Fatalf("%s body = %#v, want two tasks", label, body)
		}
		for i, raw := range sent {
			item, _ := raw.(map[string]interface{})
			if item["parentTaskId"] != "task-parent" {
				t.Fatalf("%s tasks[%d] parentTaskId = %#v", label, i, item["parentTaskId"])
			}
			// Sent together or the server refuses the pair, so losing either loses the subtask.
			if item["projectId"] != "proj-1" {
				t.Fatalf("%s tasks[%d] projectId = %#v", label, i, item["projectId"])
			}
		}
		// The batch's own wiring is untouched by it: refs still order the items they always did,
		// which is the distinction the schema promises and this asserts alongside.
		first, _ := sent[0].(map[string]interface{})
		second, _ := sent[1].(map[string]interface{})
		if first["ref"] != "s0" {
			t.Fatalf("%s tasks[0] ref = %#v", label, first["ref"])
		}
		if refs, _ := second["dependsOnRefs"].([]interface{}); len(refs) != 1 || refs[0] != "s0" {
			t.Fatalf("%s tasks[1] dependsOnRefs = %#v", label, second["dependsOnRefs"])
		}
	}
}

// Items of one batch may hang off different parents — copying the field from the first item to all
// of them, or hoisting it batch-wide, would file work under a task it does not belong to.
func TestMCPTaskCreateBatchKeepsEachItemsOwnParent(t *testing.T) {
	var createBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/tasks/batch-preview"):
			_, _ = w.Write([]byte(`{"taskCount":2,"startingNow":0}`))
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			_, _ = w.Write([]byte(`{"id":"ap1","status":"ALLOWED"}`))
		case strings.Contains(r.URL.Path, "/approvals/"):
			_, _ = w.Write([]byte(`{"status":"ALLOWED"}`))
		default:
			_ = json.NewDecoder(r.Body).Decode(&createBody)
			_, _ = w.Write([]byte(`[{"id":"t1"},{"id":"t2"}]`))
		}
	}))
	defer srv.Close()

	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create_batch", map[string]interface{}{
		"tasks": []interface{}{
			map[string]interface{}{"title": "under A", "parentTaskId": "parent-a", "completionCriterion": "EVIDENCE_JUDGMENT"},
			map[string]interface{}{"title": "top level", "completionCriterion": "EVIDENCE_JUDGMENT"},
		},
	})
	if res["isError"] == true {
		t.Fatalf("task_create_batch returned an error: %#v", res["content"])
	}

	sent, _ := createBody["tasks"].([]interface{})
	if len(sent) != 2 {
		t.Fatalf("create body = %#v", createBody)
	}
	first, _ := sent[0].(map[string]interface{})
	second, _ := sent[1].(map[string]interface{})
	if first["parentTaskId"] != "parent-a" {
		t.Fatalf("tasks[0] parentTaskId = %#v", first["parentTaskId"])
	}
	if _, present := second["parentTaskId"]; present {
		t.Fatalf("a top-level item inherited a parent from its neighbour: %#v", second)
	}
}

// The mismatch this feature can actually produce: a parent that is real and owned, named alongside
// the wrong project (or none), because the server does not inherit one from the parent. It has to
// surface as an error carrying the server's remedy — a subtask reported as created but written
// nowhere is the outcome a coordinator cannot detect.
func TestMCPTaskCreateReportsAParentInAnotherProject(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"statusCode":400,"message":"A subtask must be in the same project as its parent task — file both under the same project (or neither) before linking them"}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{agentID: "agent-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create", map[string]interface{}{
		"title":               "Step one",
		"projectId":           "proj-2",
		"parentTaskId":        "task-in-proj-1",
		"completionCriterion": "EVIDENCE_JUDGMENT",
	})
	if res["isError"] != true {
		t.Fatalf("a cross-project parent isError = %#v", res["isError"])
	}
	content, _ := res["content"].([]map[string]interface{})
	text, _ := content[0]["text"].(string)
	if !strings.Contains(text, "create task failed") || !strings.Contains(text, "400") {
		t.Fatalf("task_create 400 result = %q", text)
	}
	// The remedy has to come back with it, or the model retries the same pairing.
	if !strings.Contains(text, "same project as its parent") {
		t.Fatalf("the server's explanation did not reach the caller: %q", text)
	}
}

// A parent nobody owns, or that does not exist, is a 404 rather than a validation error — also an
// error the caller must see, and by the same door.
func TestMCPTaskCreateReportsAnUnknownParent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"statusCode":404,"message":"parent task not found"}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{agentID: "agent-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create", map[string]interface{}{
		"title":               "Step one",
		"parentTaskId":        "task-nobody-owns",
		"completionCriterion": "EVIDENCE_JUDGMENT",
	})
	if res["isError"] != true {
		t.Fatalf("an unknown parent isError = %#v", res["isError"])
	}
	content, _ := res["content"].([]map[string]interface{})
	text, _ := content[0]["text"].(string)
	if !strings.Contains(text, "parent task not found") {
		t.Fatalf("task_create 404 result = %q", text)
	}
}

// The CLI door has to report it too, rather than exiting zero on a subtask that was never written.
func TestTaskCLICreateReportsARejectedParent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"statusCode":400,"message":"A subtask must be in the same project as its parent task"}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdTaskCLI([]string{"create", "--title", "Step one", "--completion-criterion", "EVIDENCE_JUDGMENT", "--parent-task-id", "task-parent", "--json"},
		strings.NewReader(""), &out)
	if err == nil {
		t.Fatalf("a rejected parent exited zero, output = %q", out.String())
	}
	if !strings.Contains(err.Error(), "same project as its parent") {
		t.Fatalf("err = %v", err)
	}
}

// `orbit capabilities` is how an agent finds the CLI door, and `--help` is how a person does. The
// generic parity tests check that the two agree; this pins what they have to agree about.
func TestTaskCreateCapabilitiesAndHelpAdvertiseTheParentFlag(t *testing.T) {
	var spec cliCapabilitySpec
	for _, candidate := range baseCLICapabilities {
		if candidate.Tool == "task_create" {
			spec = candidate
		}
	}
	if spec.Tool == "" {
		t.Fatal("task_create has no CLI capability")
	}
	if !strings.Contains(strings.Join(spec.Arguments, " "), "--parent-task-id") {
		t.Fatalf("task_create arguments = %v", spec.Arguments)
	}
	if !strings.Contains(spec.Description, "--parent-task-id") {
		t.Fatalf("task_create description does not explain the flag: %q", spec.Description)
	}

	help := taskActionHelp["create"]
	if !strings.Contains(help, "--parent-task-id") {
		t.Fatalf("`orbit task create --help` does not document --parent-task-id")
	}
	// The pairing is the part a person gets wrong from the flag name alone, so both doors say it.
	// Case-insensitively: the prose puts SAME in caps where the emphasis earns it.
	if !strings.Contains(help, "--project-id") || !strings.Contains(strings.ToLower(help), "same project") {
		t.Fatalf("`orbit task create --help` does not explain the shared project: %q", help)
	}
	if !strings.Contains(strings.ToLower(spec.Description), "same project") {
		t.Fatalf("task_create capability description omits the shared-project rule: %q", spec.Description)
	}
	// The batch command takes the same item fields, and its help is the only place that says so.
	batchHelp := taskActionHelp["create-batch"]
	if !strings.Contains(batchHelp, "parentTaskId") {
		t.Fatalf("`orbit task create-batch --help` does not list parentTaskId among the item fields")
	}
	if !strings.Contains(batchHelp, "already exists") {
		t.Fatalf("create-batch help does not separate parentTaskId from refs: %q", batchHelp)
	}
}
