package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Creating a subtask was already expressible; maintaining the tree was not. A decomposition is
// usually understood after the tasks exist — a step turns out to belong under a different piece of
// work, or under none — and until this, the only way to say so was to delete the task and recreate
// it, losing its comments, its sessions and its edges. These tests pin the two doors that were
// missing: re-parenting an existing task (task_update), and creating a tree in one call, where a
// parent's id does not exist yet (task_create_batch's parentRef).

// capturePatchBody records the PATCH bodies an update sends, the way captureCreateBody does for
// creates. Separate because absent-vs-null is the whole question on this path: a key missing from
// the body means "leave the parent alone" and a key set to null means "detach", and only a decoded
// map can tell the two apart.
func capturePatchBody(t *testing.T) (*httptest.Server, *[]map[string]interface{}) {
	t.Helper()
	var bodies []map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch {
			t.Errorf("request = %s %s, want PATCH", r.Method, r.URL.Path)
		}
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		bodies = append(bodies, body)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"id":"task-1"}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &bodies
}

func TestTaskCLIUpdateSendsTheNewParentTaskID(t *testing.T) {
	srv, bodies := capturePatchBody(t)
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"update", "task-1", "--parent-task-id", "task-parent", "--json"},
		strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}

	body := (*bodies)[0]
	if body["parentTaskId"] != "task-parent" {
		t.Fatalf("parentTaskId = %#v, body = %#v", body["parentTaskId"], body)
	}
	// Membership only: re-parenting must not quietly rewrite the task's prerequisites, which are
	// the thing that actually decides when it runs.
	if _, present := body["dependsOnTaskIds"]; present {
		t.Fatalf("re-parenting touched the dependency edges: %#v", body)
	}
}

// --clear-parent has to reach the wire as an explicit null. Dropping the key would be "leave the
// parent alone", so a detach that silently became a no-op would report success and change nothing.
func TestTaskCLIUpdateClearsTheParentWithAnExplicitNull(t *testing.T) {
	srv, bodies := capturePatchBody(t)
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"update", "task-1", "--clear-parent", "--json"},
		strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}

	body := (*bodies)[0]
	value, present := body["parentTaskId"]
	if !present || value != nil {
		t.Fatalf("parentTaskId = %#v (present = %v), want an explicit null", value, present)
	}
}

// The other half of the same rule: an update that says nothing about the parent must not send the
// field at all, or every rename would detach the task it renamed.
func TestTaskCLIUpdateLeavesTheParentAloneWhenNotAsked(t *testing.T) {
	srv, bodies := capturePatchBody(t)
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"update", "task-1", "--title", "Renamed", "--json"},
		strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}

	if _, present := (*bodies)[0]["parentTaskId"]; present {
		t.Fatalf("parentTaskId sent without either flag: %#v", (*bodies)[0])
	}
}

// Both contradictory instructions and a blank id are caught locally, before any request: the same
// treatment --clear-list/--list-id already get, because a round trip that writes nothing and
// returns a validation error about a field the caller never meant to send explains nothing.
func TestTaskCLIUpdateRejectsContradictoryParentFlagsWithoutCallingTheServer(t *testing.T) {
	var requests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{"id":"task-1"}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdTaskCLI([]string{"update", "task-1", "--parent-task-id", "p1", "--clear-parent", "--json"},
		strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "--clear-parent and --parent-task-id cannot be used together") {
		t.Fatalf("err = %v", err)
	}

	err = cmdTaskCLI([]string{"update", "task-1", "--parent-task-id", "", "--json"},
		strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "--parent-task-id cannot be empty") {
		t.Fatalf("err = %v", err)
	}
	if requests != 0 {
		t.Fatalf("requests = %d, want both caught before the round trip", requests)
	}
}

// The MCP door forwards the same three states, and the null is the one a present-only copy gets
// wrong: `parentTaskId: null` has to survive as null rather than being read as "not supplied".
func TestMCPTaskUpdateForwardsTheParentIncludingAnExplicitNull(t *testing.T) {
	srv, bodies := capturePatchBody(t)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	if res := mcp.callTool("task_update", map[string]interface{}{
		"taskId": "task-1", "parentTaskId": "task-parent",
	}); res["isError"] == true {
		t.Fatalf("task_update returned an error: %#v", res["content"])
	}
	if res := mcp.callTool("task_update", map[string]interface{}{
		"taskId": "task-1", "parentTaskId": nil,
	}); res["isError"] == true {
		t.Fatalf("task_update returned an error: %#v", res["content"])
	}

	if len(*bodies) != 2 {
		t.Fatalf("requests = %d", len(*bodies))
	}
	if (*bodies)[0]["parentTaskId"] != "task-parent" {
		t.Fatalf("link body = %#v", (*bodies)[0])
	}
	value, present := (*bodies)[1]["parentTaskId"]
	if !present || value != nil {
		// Without the key the server leaves the parent alone, so a detach reported as done would
		// have changed nothing at all.
		t.Fatalf("detach body = %#v", (*bodies)[1])
	}
}

func TestMCPTaskUpdateDeclaresANullableParentTaskID(t *testing.T) {
	props := mcpToolProps(toolDescriptors(false, false), "task_update")
	parent, _ := props["parentTaskId"].(map[string]interface{})
	types, _ := parent["type"].([]string)
	if len(types) != 2 || types[0] != "string" || types[1] != "null" {
		t.Fatalf("task_update parentTaskId schema = %#v", props["parentTaskId"])
	}
	// Nullable alone does not say what null MEANS, and the two rules a caller cannot recover from
	// by retrying are the shared project and the loop.
	description, _ := parent["description"].(string)
	for _, phrase := range []string{"null", "SAME project", "subtask"} {
		if !strings.Contains(description, phrase) {
			t.Fatalf("task_update parentTaskId description omits %q: %q", phrase, description)
		}
	}

	// And the CLI door says the same thing, in both places a person or an agent reads it.
	var spec cliCapabilitySpec
	for _, candidate := range baseCLICapabilities {
		if candidate.Tool == "task_update" {
			spec = candidate
		}
	}
	arguments := strings.Join(spec.Arguments, " ")
	if !strings.Contains(arguments, "--parent-task-id") || !strings.Contains(arguments, "--clear-parent") {
		t.Fatalf("task_update arguments = %v", spec.Arguments)
	}
	help := taskActionHelp["update"]
	if !strings.Contains(help, "--parent-task-id") || !strings.Contains(help, "--clear-parent") {
		t.Fatalf("`orbit task update --help` does not document the parent flags: %q", help)
	}
}

// The batch's items are copied through their own field list, so a field added to the single form's
// list is not on this one — and parentRef exists ONLY here, which makes that list the only place it
// can be dropped. Asserted on the preview body too: the card a human approves has to describe the
// same batch the write then creates.
func TestMCPTaskCreateBatchSendsEachItemsParentRef(t *testing.T) {
	var previewBody, createBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/tasks/batch-preview"):
			_ = json.NewDecoder(r.Body).Decode(&previewBody)
			_, _ = w.Write([]byte(`{"taskCount":3,"startingNow":0}`))
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			_, _ = w.Write([]byte(`{"id":"ap1","status":"ALLOWED"}`))
		case strings.Contains(r.URL.Path, "/approvals/"):
			_, _ = w.Write([]byte(`{"status":"ALLOWED"}`))
		default:
			_ = json.NewDecoder(r.Body).Decode(&createBody)
			_, _ = w.Write([]byte(`[{"id":"t1"},{"id":"t2"},{"id":"t3"}]`))
		}
	}))
	defer srv.Close()

	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create_batch", map[string]interface{}{
		"tasks": []interface{}{
			map[string]interface{}{"title": "epic", "projectId": "proj-1", "ref": "epic", "completionCriterion": "EVIDENCE_JUDGMENT"},
			map[string]interface{}{"title": "parse", "projectId": "proj-1", "ref": "parse", "parentRef": "epic", "completionCriterion": "EVIDENCE_JUDGMENT"},
			map[string]interface{}{
				"title": "backfill", "projectId": "proj-1", "parentRef": "epic",
				"dependsOnRefs": []interface{}{"parse"}, "completionCriterion": "EVIDENCE_JUDGMENT",
			},
		},
	})
	if res["isError"] == true {
		t.Fatalf("task_create_batch returned an error: %#v", res["content"])
	}

	for label, body := range map[string]map[string]interface{}{"preview": previewBody, "create": createBody} {
		sent, _ := body["tasks"].([]interface{})
		if len(sent) != 3 {
			t.Fatalf("%s body = %#v, want three tasks", label, body)
		}
		root, _ := sent[0].(map[string]interface{})
		if _, present := root["parentRef"]; present {
			t.Fatalf("%s tasks[0] was given a parent it never named: %#v", label, root)
		}
		for i := 1; i < 3; i++ {
			item, _ := sent[i].(map[string]interface{})
			if item["parentRef"] != "epic" {
				t.Fatalf("%s tasks[%d] parentRef = %#v", label, i, item["parentRef"])
			}
		}
		// The two axes stay separate on the wire: the third item is a part of the epic AND waits
		// on its sibling, and neither field may be turned into the other.
		last, _ := sent[2].(map[string]interface{})
		if refs, _ := last["dependsOnRefs"].([]interface{}); len(refs) != 1 || refs[0] != "parse" {
			t.Fatalf("%s tasks[2] dependsOnRefs = %#v", label, last["dependsOnRefs"])
		}
	}
}

// parentRef belongs to the batch item only: task_create writes one task, so a ref to an item of
// the same call is a thing it cannot have. Declaring it there would invite a call that names a
// parent nothing in the request creates.
func TestMCPParentRefIsDeclaredOnBatchItemsOnly(t *testing.T) {
	tools := toolDescriptors(false, false)

	if props := mcpToolProps(tools, "task_create"); props["parentRef"] != nil {
		t.Fatalf("task_create declares parentRef: %#v", props["parentRef"])
	}

	batch := mcpToolProps(tools, "task_create_batch")
	tasks, _ := batch["tasks"].(map[string]interface{})
	items, _ := tasks["items"].(map[string]interface{})
	itemProps, _ := items["properties"].(map[string]interface{})
	parentRef, _ := itemProps["parentRef"].(map[string]interface{})
	if parentRef["type"] != "string" {
		t.Fatalf("task_create_batch item parentRef schema = %#v", itemProps["parentRef"])
	}
	// The three rules the server enforces and a caller cannot guess: backwards-only, one parent
	// per item, and the project that is never inherited.
	description, _ := parentRef["description"].(string)
	for _, phrase := range []string{"EARLIER", "parentTaskId", "projectId"} {
		if !strings.Contains(description, phrase) {
			t.Fatalf("parentRef description omits %q: %q", phrase, description)
		}
	}

	// Both doors have to say what parentRef is FOR, or it reads as a second spelling of
	// dependsOnRefs and a plan comes back ordered but flat.
	for _, tool := range tools {
		if tool["name"] != "task_create_batch" {
			continue
		}
		if toolDescription, _ := tool["description"].(string); !strings.Contains(toolDescription, "parentRef") {
			t.Fatalf("task_create_batch description does not mention parentRef: %q", toolDescription)
		}
	}
	if !strings.Contains(taskActionHelp["create-batch"], "parentRef") {
		t.Fatalf("`orbit task create-batch --help` does not document parentRef")
	}
	for _, spec := range baseCLICapabilities {
		if spec.Tool == "task_create_batch" && !strings.Contains(spec.Description, "parentRef") {
			t.Fatalf("task_create_batch capability description omits parentRef: %q", spec.Description)
		}
	}
}
