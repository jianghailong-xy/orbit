package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A coordinator can already read the work filed under its project (`--project-id` on task list),
// but everything it created landed under no project at all — so the read it was given answered
// about work somebody else had filed. These tests pin the write half to the wire: the project has
// to reach the server on the create, or the task exists and is invisible to the project it is for.

// captureCreateBody stands in for POST /runner/tasks and records what was sent, so a flag that is
// parsed and then dropped before the body fails here rather than reading as a task filed nowhere.
func captureCreateBody(t *testing.T, path string) (*httptest.Server, *[]map[string]interface{}) {
	t.Helper()
	var bodies []map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != path {
			t.Errorf("request = %s %s, want POST %s", r.Method, r.URL.Path, path)
		}
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		bodies = append(bodies, body)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"id":"created-task"}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &bodies
}

func TestTaskCLICreateSendsProjectID(t *testing.T) {
	srv, bodies := captureCreateBody(t, "/api/runner/tasks")
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdTaskCLI([]string{"create", "--title", "Ship it", "--completion-criterion", "HUMAN_SIGNOFF", "--project-id", "proj-1", "--json"},
		strings.NewReader(""), &out)
	if err != nil {
		t.Fatal(err)
	}

	if len(*bodies) != 1 {
		t.Fatalf("requests = %d", len(*bodies))
	}
	if got := (*bodies)[0]["projectId"]; got != "proj-1" {
		t.Fatalf("projectId = %#v, body = %#v", got, (*bodies)[0])
	}
}

// The project is one field among many, and the flag that adds it must not cost another: a create
// that files under a project still has to carry its list, labels, prerequisites and schedule.
func TestTaskCLICreateCombinesProjectIDWithTheOtherFields(t *testing.T) {
	srv, bodies := captureCreateBody(t, "/api/runner/tasks")
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdTaskCLI([]string{
		"create",
		"--title", "Ship it",
		"--completion-criterion", "HUMAN_SIGNOFF",
		"--description", "Do the thing",
		"--project-id", "proj-1",
		"--list-id", "list-1",
		"--assignee-id", "agent-9",
		"--due-date", "2026-09-01",
		"--depends-on", "dep-1,dep-2",
		"--label", "shard-3",
		"--auto-run-when-ready=false",
		"--json",
	}, strings.NewReader(""), &out)
	if err != nil {
		t.Fatal(err)
	}

	body := (*bodies)[0]
	// listId and projectId are orthogonal: the list decides how it runs, the project says what it
	// is for, and a task filed under both must reach the server carrying both.
	if body["projectId"] != "proj-1" || body["listId"] != "list-1" {
		t.Fatalf("projectId/listId = %#v / %#v", body["projectId"], body["listId"])
	}
	if body["title"] != "Ship it" || body["description"] != "Do the thing" || body["assigneeId"] != "agent-9" {
		t.Fatalf("body lost a field: %#v", body)
	}
	if body["dueDate"] != "2026-09-01" || body["autoRunWhenReady"] != false {
		t.Fatalf("body = %#v", body)
	}
	if deps, _ := body["dependsOnTaskIds"].([]interface{}); len(deps) != 2 {
		t.Fatalf("dependsOnTaskIds = %#v", body["dependsOnTaskIds"])
	}
	if labels, _ := body["labels"].([]interface{}); len(labels) != 1 || labels[0] != "shard-3" {
		t.Fatalf("labels = %#v", body["labels"])
	}
}

// Every create that existed before this flag must still send the request it sent before: an empty
// projectId in the body is not "no project", it is an id the server has to reject.
func TestTaskCLICreateOmitsProjectIDWhenNotAsked(t *testing.T) {
	srv, bodies := captureCreateBody(t, "/api/runner/tasks")
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"create", "--title", "Ship it", "--completion-criterion", "HUMAN_SIGNOFF", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}

	if _, present := (*bodies)[0]["projectId"]; present {
		t.Fatalf("projectId sent without the flag: %#v", (*bodies)[0])
	}
}

// `--project-id ""` is a typo or an unset shell variable, not a request to file under nothing.
// Caught locally, because the alternative is a round trip that writes nothing and reports a
// validation error about a field the caller never meant to send.
func TestTaskCLICreateRejectsABlankProjectIDWithoutCallingTheServer(t *testing.T) {
	var requests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{"id":"created-task"}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdTaskCLI([]string{"create", "--title", "Ship it", "--project-id", "", "--json"},
		strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "--project-id cannot be empty") {
		t.Fatalf("err = %v", err)
	}
	if requests != 0 {
		t.Fatalf("requests = %d, want the blank flag caught before the round trip", requests)
	}
}

// The field is declared once and shared, so it has to appear on both doors: a schema carrying it
// on task_create alone leaves a plan of several tasks unable to file any of them.
func TestMCPTaskCreateTakesAProjectIDOnSingleAndBatchItems(t *testing.T) {
	tools := toolDescriptors(false, false)

	single := mcpToolProps(tools, "task_create")
	singleProject, _ := single["projectId"].(map[string]interface{})
	if singleProject["type"] != "string" {
		t.Fatalf("task_create projectId schema = %#v", single["projectId"])
	}

	batch := mcpToolProps(tools, "task_create_batch")
	tasks, _ := batch["tasks"].(map[string]interface{})
	items, _ := tasks["items"].(map[string]interface{})
	itemProps, _ := items["properties"].(map[string]interface{})
	itemProject, _ := itemProps["projectId"].(map[string]interface{})
	if itemProject["type"] != "string" {
		t.Fatalf("task_create_batch item projectId schema = %#v", itemProps["projectId"])
	}

	// Optional on both: a task that belongs to no project is still the ordinary case.
	for _, name := range []string{"task_create", "task_create_batch"} {
		for _, tool := range tools {
			if tool["name"] != name {
				continue
			}
			schema, _ := tool["inputSchema"].(map[string]interface{})
			required, _ := schema["required"].([]string)
			for _, field := range required {
				if field == "projectId" {
					t.Fatalf("%s made projectId required", name)
				}
			}
			// The model has to be told which of listId/projectId answers which question, or it
			// will reach for whichever it saw last.
			description, _ := tool["description"].(string)
			if !strings.Contains(description, "projectId") {
				t.Fatalf("%s description does not mention projectId: %q", name, description)
			}
		}
	}
	if !strings.Contains(itemProject["description"].(string), "listId") {
		t.Fatalf("projectId description does not distinguish it from listId: %q", itemProject["description"])
	}
}

func TestMCPTaskCreateSendsTheProjectIDToTheServer(t *testing.T) {
	srv, bodies := captureCreateBody(t, "/api/runner/tasks")

	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create", map[string]interface{}{
		"title":               "Ship it",
		"projectId":           "proj-1",
		"listId":              "list-1",
		"completionCriterion": "HUMAN_SIGNOFF",
	})
	if res["isError"] == true {
		t.Fatalf("task_create returned an error: %#v", res["content"])
	}

	body := (*bodies)[0]
	if body["projectId"] != "proj-1" || body["listId"] != "list-1" {
		t.Fatalf("task_create body = %#v", body)
	}
}

// The batch is the tool a plan actually uses, and it copies its fields through a second, separate
// list — so it is the one that silently drops a field the single form carries. It also runs the
// approval path, where the body is built once for the preview and again for the write.
func TestMCPTaskCreateBatchSendsEveryItemsProjectID(t *testing.T) {
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
			map[string]interface{}{"title": "first", "projectId": "proj-1", "ref": "s0", "completionCriterion": "HUMAN_SIGNOFF"},
			map[string]interface{}{"title": "second", "projectId": "proj-1", "dependsOnRefs": []interface{}{"s0"}, "completionCriterion": "HUMAN_SIGNOFF"},
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
			if item["projectId"] != "proj-1" {
				t.Fatalf("%s tasks[%d] projectId = %#v", label, i, item["projectId"])
			}
		}
		// The batch wiring still works alongside it.
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

// A project id the model invented, or one owned by somebody else, is refused by the server. Unlike
// the read path — where an unknown project is an empty list — a rejected write has to surface as an
// error, or the model believes it filed work under a project that never received it.
func TestMCPTaskCreateReportsARejectedProjectID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"statusCode":400,"message":"project not found"}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{agentID: "agent-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create", map[string]interface{}{
		"title":               "Ship it",
		"projectId":           "proj-nobody-owns",
		"completionCriterion": "HUMAN_SIGNOFF",
	})
	if res["isError"] != true {
		t.Fatalf("a rejected project isError = %#v", res["isError"])
	}
	content, _ := res["content"].([]map[string]interface{})
	text, _ := content[0]["text"].(string)
	if !strings.Contains(text, "create task failed") || !strings.Contains(text, "400") {
		t.Fatalf("task_create 400 result = %q", text)
	}
}

// `orbit capabilities` is how an agent finds the CLI door, and `--help` is how a person does. The
// generic parity tests check that the two agree; this pins what they have to agree about.
func TestTaskCreateCapabilitiesAndHelpAdvertiseTheProjectFlag(t *testing.T) {
	var spec cliCapabilitySpec
	for _, candidate := range baseCLICapabilities {
		if candidate.Tool == "task_create" {
			spec = candidate
		}
	}
	if spec.Tool == "" {
		t.Fatal("task_create has no CLI capability")
	}
	if !strings.Contains(strings.Join(spec.Arguments, " "), "--project-id") {
		t.Fatalf("task_create arguments = %v", spec.Arguments)
	}
	if !strings.Contains(spec.Description, "--project-id") {
		t.Fatalf("task_create description does not explain the flag: %q", spec.Description)
	}
	if help := taskActionHelp["create"]; !strings.Contains(help, "--project-id") {
		t.Fatalf("`orbit task create --help` does not document --project-id")
	}
	// The batch command takes the same item fields, and its help is the only place that says so.
	if help := taskActionHelp["create-batch"]; !strings.Contains(help, "projectId") {
		t.Fatalf("`orbit task create-batch --help` does not list projectId among the item fields")
	}
}
