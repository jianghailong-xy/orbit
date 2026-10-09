package main

import (
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

func TestMCPPermissionPromptToolCanBeDisabled(t *testing.T) {
	if !hasMCPTool(toolDescriptors(true, false), "permission_prompt") {
		t.Fatalf("permission_prompt missing when enabled")
	}
	if hasMCPTool(toolDescriptors(false, false), "permission_prompt") {
		t.Fatalf("permission_prompt present when disabled")
	}
}

func TestMCPPermissionPromptEnv(t *testing.T) {
	t.Setenv(envMCPPermissionPrompt, "0")
	if mcpPermissionPromptEnabled() {
		t.Fatalf("mcpPermissionPromptEnabled = true for 0")
	}
	t.Setenv(envMCPPermissionPrompt, "false")
	if mcpPermissionPromptEnabled() {
		t.Fatalf("mcpPermissionPromptEnabled = true for false")
	}
	t.Setenv(envMCPPermissionPrompt, "")
	if !mcpPermissionPromptEnabled() {
		t.Fatalf("mcpPermissionPromptEnabled = false by default")
	}
}

func TestMCPPermissionPromptDisabledFailsClosed(t *testing.T) {
	srv := &mcpServer{allowPermissionPrompt: false}
	res := srv.callTool("permission_prompt", map[string]interface{}{})
	content, ok := res["content"].([]map[string]interface{})
	if !ok || len(content) == 0 {
		t.Fatalf("permission_prompt result content = %#v", res["content"])
	}
	text, _ := content[0]["text"].(string)
	if !strings.Contains(text, `"behavior":"deny"`) {
		t.Fatalf("permission_prompt disabled result = %q", text)
	}
}

func TestMCPOrchestrationToolsGated(t *testing.T) {
	on := toolDescriptors(false, true)
	off := toolDescriptors(false, false)
	for _, name := range []string{"session_create", "session_list", "session_search", "session_get", "session_await", "session_send", "session_interrupt", "session_merge", "session_end", "session_complete", "session_delete", "agent_list", "agent_create", "agent_update"} {
		if !hasMCPTool(on, name) {
			t.Fatalf("%s missing when orchestration enabled", name)
		}
		if hasMCPTool(off, name) {
			t.Fatalf("%s present when orchestration disabled", name)
		}
	}
}

// session_send no longer hard-codes CURRENT_WORK (0225): the server decides between joining the
// running turn and filing the next one, and a description that still promised an explicit refusal
// would send a caller looking for an error it can no longer get — the very reason a coordinator
// could not reach a session that was waiting for it.
func TestSessionSendDescriptionDoesNotPromiseACurrentWorkOnlyRefusal(t *testing.T) {
	var description string
	for _, tool := range toolDescriptors(false, true) {
		if tool["name"] == "session_send" {
			description, _ = tool["description"].(string)
			break
		}
	}
	for name, text := range map[string]string{
		"MCP":      description,
		"CLI help": sessionActionHelp["send"],
		"headless": headlessActionDescription["send"],
	} {
		if strings.Contains(text, "CURRENT_WORK") {
			t.Errorf("%s session_send description still names the removed intent: %q", name, text)
		}
		if strings.Contains(text, "never queue") {
			t.Errorf("%s session_send description still promises no queue: %q", name, text)
		}
		if !strings.Contains(text, "placement") {
			t.Errorf("%s session_send description does not name the server's placement: %q", name, text)
		}
		if !strings.Contains(text, "next turn") {
			t.Errorf("%s session_send description omits the next-turn landing: %q", name, text)
		}
	}
}

func TestMCPTaskRequestConfirmationPostsTheClaimWithBothAttributionHeaders(t *testing.T) {
	if !hasMCPTool(toolDescriptors(false, false), "task_request_confirmation") {
		t.Fatalf("task_request_confirmation missing from the base task tools")
	}

	var gotMethod, gotPath, gotAgent, gotSession string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotAgent, gotSession = r.Header.Get("X-Orbit-Agent-Id"), r.Header.Get("X-Orbit-Session-Id")
		w.Write([]byte(`{"id":"c1","alreadyDeclared":false}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{taskID: "t1", agentID: "a1", sessionID: "s1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_request_confirmation", map[string]interface{}{})
	if res["isError"] == true {
		t.Fatalf("task_request_confirmation returned an error: %#v", res["content"])
	}
	if gotMethod != http.MethodPost || gotPath != "/api/runner/tasks/t1/owner-confirmation/claim" {
		t.Fatalf("task_request_confirmation hit %s %s", gotMethod, gotPath)
	}
	// Both headers: the session is the declaration's subject, so it is authenticated rather than
	// typed into the body — the control plane takes it only from the task's own run.
	if gotAgent != "a1" || gotSession != "s1" {
		t.Fatalf("attribution headers = agent %q, session %q", gotAgent, gotSession)
	}
}

func TestMCPTaskCommentPostsWithBothAttributionHeaders(t *testing.T) {
	var gotMethod, gotPath, gotAgent, gotSession string
	var gotBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotAgent, gotSession = r.Header.Get("X-Orbit-Agent-Id"), r.Header.Get("X-Orbit-Session-Id")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Write([]byte(`{"id":"c1"}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{taskID: "t1", agentID: "a1", sessionID: "s1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_comment", map[string]interface{}{"body": "looked at it"})
	if res["isError"] == true {
		t.Fatalf("task_comment returned an error: %#v", res["content"])
	}
	if gotMethod != http.MethodPost || gotPath != "/api/runner/tasks/t1/comments" || gotBody["body"] != "looked at it" {
		t.Fatalf("task_comment sent %s %s %#v", gotMethod, gotPath, gotBody)
	}
	// The session is what lets the control plane record which run, and which attempt, wrote it.
	if gotAgent != "a1" || gotSession != "s1" {
		t.Fatalf("attribution headers = agent %q, session %q", gotAgent, gotSession)
	}
}

func TestMCPTaskRequestConfirmationRefusesOutsideASession(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.Write([]byte(`{"id":"c1"}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{taskID: "t1", agentID: "a1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_request_confirmation", map[string]interface{}{})
	if res["isError"] != true {
		t.Fatalf("a declaration with no session was accepted: %#v", res)
	}
	if called {
		t.Fatal("the door was reached without a session to declare from")
	}
}

func TestMCPConfirmationReviewToolsPostTheInputUnderTheReviewingSession(t *testing.T) {
	for _, tool := range []string{"task_confirmation_review", "task_confirmation_return"} {
		if !hasMCPTool(toolDescriptors(false, false), tool) {
			t.Fatalf("%s missing from the base task tools", tool)
		}
	}
	srv, calls := confirmationReviewServer(t)
	// The reviewer's own task is a different one: the tool must not default to it.
	mcp := &mcpServer{taskID: "own-task", agentID: "a1", sessionID: "reviewer", t: NewTransport(srv.URL, "tok")}
	review := mcp.callTool("task_confirmation_review", map[string]interface{}{
		"taskId":    "t9",
		"requestId": "0199a0b1-0000-7000-8000-000000000001",
		"judgment":  "Ready, one call for you.",
		"checked":   []interface{}{map[string]interface{}{"text": "suite passes", "evidenceRefs": []interface{}{"abc123"}}},
	})
	if review["isError"] == true {
		t.Fatalf("task_confirmation_review returned an error: %#v", review["content"])
	}
	returned := mcp.callTool("task_confirmation_return", map[string]interface{}{
		"taskId":    "t9",
		"requestId": "0199a0b1-0000-7000-8000-000000000001",
		"reason":    "The migration is missing.",
		"problems":  []interface{}{map[string]interface{}{"text": "no migration"}},
	})
	if returned["isError"] == true {
		t.Fatalf("task_confirmation_return returned an error: %#v", returned["content"])
	}
	if len(*calls) != 2 {
		t.Fatalf("calls = %#v", *calls)
	}
	for i, want := range []string{
		"/api/runner/tasks/t9/owner-confirmation/review",
		"/api/runner/tasks/t9/owner-confirmation/return",
	} {
		call := (*calls)[i]
		if call.method != http.MethodPost || call.path != want {
			t.Errorf("call %d hit %s %s, want POST %s", i, call.method, call.path, want)
		}
		if call.agent != "a1" || call.session != "reviewer" {
			t.Errorf("call %d attribution = agent %q, session %q", i, call.agent, call.session)
		}
		if _, ok := call.body["taskId"]; ok {
			t.Errorf("call %d carried taskId in the body as well as the path: %#v", i, call.body)
		}
		if call.body["requestId"] != "0199a0b1-0000-7000-8000-000000000001" {
			t.Errorf("call %d body = %#v", i, call.body)
		}
	}
	if (*calls)[0].body["judgment"] != "Ready, one call for you." || (*calls)[1].body["reason"] != "The migration is missing." {
		t.Errorf("bodies = %#v", *calls)
	}
}

func TestMCPConfirmationReviewToolsNeedTheTaskAndASession(t *testing.T) {
	srv, calls := confirmationReviewServer(t)
	inSession := &mcpServer{taskID: "own-task", agentID: "a1", sessionID: "reviewer", t: NewTransport(srv.URL, "tok")}
	headless := &mcpServer{taskID: "own-task", agentID: "a1", t: NewTransport(srv.URL, "tok")}
	for _, tool := range []string{"task_confirmation_review", "task_confirmation_return"} {
		if res := inSession.callTool(tool, map[string]interface{}{"requestId": "x"}); res["isError"] != true {
			t.Errorf("%s with no taskId was accepted: %#v", tool, res)
		}
		if res := headless.callTool(tool, map[string]interface{}{"taskId": "t9", "requestId": "x"}); res["isError"] != true {
			t.Errorf("%s with no session was accepted: %#v", tool, res)
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("the door was reached without a task or a session: %#v", *calls)
	}
}

func TestMCPTaskRequestConfirmationSaysTheReviewerIsAskedFirst(t *testing.T) {
	for _, tool := range toolDescriptors(false, false) {
		if tool["name"] != "task_request_confirmation" {
			continue
		}
		description, _ := tool["description"].(string)
		if !strings.Contains(description, "If the task has a reviewer, Orbit asks it first and the owner's card waits until the review is in.") {
			t.Fatalf("task_request_confirmation does not say a reviewer is asked first: %q", description)
		}
		return
	}
	t.Fatal("task_request_confirmation missing")
}

func TestMCPTaskStartIsPartOfTaskTools(t *testing.T) {
	if !hasMCPTool(toolDescriptors(false, false), "task_start") {
		t.Fatalf("task_start missing from the base task tools")
	}
}

func TestMCPTaskDeleteUsesCurrentTaskAndDeleteEndpoint(t *testing.T) {
	if !hasMCPTool(toolDescriptors(false, false), "task_delete") {
		t.Fatalf("task_delete missing from the base task tools")
	}

	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{taskID: "t1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_delete", map[string]interface{}{})
	if res["isError"] == true {
		t.Fatalf("task_delete returned an error: %#v", res["content"])
	}
	if gotMethod != http.MethodDelete || gotPath != "/api/runner/tasks/t1" {
		t.Fatalf("task_delete hit %s %s", gotMethod, gotPath)
	}
}

func TestMCPTaskDependencyToolsArePartOfBaseTaskTools(t *testing.T) {
	tools := toolDescriptors(false, false)
	for _, name := range []string{"task_dependency_graph", "task_dependency_add", "task_dependency_remove"} {
		if !hasMCPTool(tools, name) {
			t.Fatalf("%s missing from the base task tools", name)
		}
	}
	for _, name := range []string{"task_dependency_add", "task_dependency_remove"} {
		props := mcpToolProps(tools, name)
		dep, _ := props["dependsOnTaskId"].(map[string]interface{})
		if dep["type"] != "string" {
			t.Fatalf("%s dependsOnTaskId schema = %#v", name, props["dependsOnTaskId"])
		}
	}
}

func TestMCPTaskDependencyToolsUseBoundedGraphAndGranularEdgeEndpoints(t *testing.T) {
	type request struct {
		method string
		path   string
		query  string
		body   map[string]interface{}
	}
	var requests []request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		req := request{method: r.Method, path: r.URL.Path, query: r.URL.RawQuery}
		if r.Body != nil && r.ContentLength != 0 {
			_ = json.NewDecoder(r.Body).Decode(&req.body)
		}
		requests = append(requests, req)
		_, _ = w.Write([]byte(`{"focusTaskId":"focus","nodes":[],"edges":[]}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{taskID: "focus", t: NewTransport(srv.URL, "tok")}
	calls := []struct {
		name string
		args map[string]interface{}
	}{
		{name: "task_dependency_graph", args: map[string]interface{}{"maxDepth": float64(12), "maxNodes": float64(300)}},
		{name: "task_dependency_add", args: map[string]interface{}{"dependsOnTaskId": "prereq"}},
		{name: "task_dependency_remove", args: map[string]interface{}{"taskId": "dependent", "dependsOnTaskId": "prereq"}},
	}
	for _, call := range calls {
		if res := mcp.callTool(call.name, call.args); res["isError"] == true {
			t.Fatalf("%s returned an error: %#v", call.name, res["content"])
		}
	}

	want := []request{
		{method: http.MethodGet, path: "/api/runner/tasks/focus/dependency-graph", query: "maxDepth=12&maxNodes=300"},
		{method: http.MethodPost, path: "/api/runner/tasks/focus/dependencies", body: map[string]interface{}{"dependsOnTaskId": "prereq"}},
		{method: http.MethodDelete, path: "/api/runner/tasks/dependent/dependencies/prereq"},
	}
	if len(requests) != len(want) {
		t.Fatalf("requests = %#v", requests)
	}
	for i := range want {
		if requests[i].method != want[i].method || requests[i].path != want[i].path || requests[i].query != want[i].query {
			t.Fatalf("request %d = %#v, want %#v", i, requests[i], want[i])
		}
		if want[i].body != nil && requests[i].body["dependsOnTaskId"] != want[i].body["dependsOnTaskId"] {
			t.Fatalf("request %d body = %#v, want %#v", i, requests[i].body, want[i].body)
		}
	}
}

func TestMCPTaskStartUsesCurrentTaskAndExecuteEndpoint(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		w.Write([]byte(`{"ok":true,"sessionId":"s1"}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{taskID: "t1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_start", map[string]interface{}{})
	if res["isError"] == true {
		t.Fatalf("task_start returned an error: %#v", res["content"])
	}
	if gotMethod != http.MethodPost || gotPath != "/api/runner/tasks/t1/execute" {
		t.Fatalf("task_start hit %s %s", gotMethod, gotPath)
	}
}

func TestMCPTaskUpdateCarriesDependencyReplacement(t *testing.T) {
	props := mcpToolProps(toolDescriptors(false, false), "task_update")
	depSchema, ok := props["dependsOnTaskIds"].(map[string]interface{})
	if !ok {
		t.Fatalf("task_update inputSchema missing dependsOnTaskIds: %#v", props["dependsOnTaskIds"])
	}
	if depSchema["type"] != "array" {
		t.Fatalf("dependsOnTaskIds type = %#v, want array", depSchema["type"])
	}
	items, _ := depSchema["items"].(map[string]interface{})
	if items["type"] != "string" {
		t.Fatalf("dependsOnTaskIds items = %#v, want strings", depSchema["items"])
	}
	description, _ := depSchema["description"].(string)
	if !strings.Contains(description, "Complete replacement") || !strings.Contains(description, "pass [] to clear") {
		t.Fatalf("dependsOnTaskIds description does not explain replacement/clear semantics: %q", description)
	}

	var gotMethod, gotPath string
	var gotBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		json.NewDecoder(r.Body).Decode(&gotBody)
		w.Write([]byte(`{"id":"t1"}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_update", map[string]interface{}{
		"taskId":           "t1",
		"dependsOnTaskIds": []interface{}{},
	})
	if res["isError"] == true {
		t.Fatalf("task_update returned an error: %#v", res["content"])
	}
	if gotMethod != http.MethodPatch || gotPath != "/api/runner/tasks/t1" {
		t.Fatalf("task_update hit %s %s", gotMethod, gotPath)
	}
	deps, ok := gotBody["dependsOnTaskIds"].([]interface{})
	if !ok || len(deps) != 0 {
		t.Fatalf("task_update body dependsOnTaskIds = %#v, want present empty array", gotBody["dependsOnTaskIds"])
	}
}

func TestMCPTaskCreateBatchPostsEveryItemInOneCall(t *testing.T) {
	props := mcpToolProps(toolDescriptors(false, false), "task_create_batch")
	tasks, ok := props["tasks"].(map[string]interface{})
	if !ok || tasks["type"] != "array" {
		t.Fatalf("task_create_batch tasks schema = %#v", props["tasks"])
	}
	items, _ := tasks["items"].(map[string]interface{})
	itemProps, _ := items["properties"].(map[string]interface{})
	for _, field := range []string{"title", "description", "dependsOnTaskIds", "ref", "dependsOnRefs"} {
		if itemProps[field] == nil {
			t.Fatalf("task_create_batch item schema missing %q: %#v", field, itemProps)
		}
	}
	// The single-task tool must not grow the batch-only wiring fields.
	if single := mcpToolProps(toolDescriptors(false, false), "task_create"); single["ref"] != nil {
		t.Fatalf("task_create leaked the batch-only ref field: %#v", single["ref"])
	}

	// A batch now goes preview -> approval -> create, so the fake server has to play all three.
	// The create call is the one this test is about; `hits` records the order so the write can be
	// shown to happen after the human said yes, not before.
	var gotMethod, gotPath, gotAgent string
	var gotBody map[string]interface{}
	var hits []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.URL.Path)
		switch {
		case strings.HasSuffix(r.URL.Path, "/tasks/batch-preview"):
			_, _ = w.Write([]byte(`{"taskCount":2,"startingNow":1}`))
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			_, _ = w.Write([]byte(`{"id":"ap1","status":"ALLOWED"}`))
		case strings.Contains(r.URL.Path, "/approvals/"):
			_, _ = w.Write([]byte(`{"status":"ALLOWED"}`))
		default:
			gotMethod, gotPath = r.Method, r.URL.Path
			gotAgent = r.Header.Get("X-Orbit-Agent-Id")
			_ = json.NewDecoder(r.Body).Decode(&gotBody)
			_, _ = w.Write([]byte(`[{"id":"t1","ref":"s0"},{"id":"t2"}]`))
		}
	}))
	defer srv.Close()

	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create_batch", map[string]interface{}{
		"tasks": []interface{}{
			map[string]interface{}{"title": "first", "ref": "s0", "completionCriterion": "EVIDENCE_JUDGMENT"},
			map[string]interface{}{"title": "second", "dependsOnRefs": []interface{}{"s0"}, "assigneeId": nil, "completionCriterion": "EVIDENCE_JUDGMENT"},
		},
	})
	if res["isError"] == true {
		t.Fatalf("task_create_batch returned an error: %#v", res["content"])
	}
	if gotMethod != http.MethodPost || gotPath != "/api/runner/tasks/batch-create" {
		t.Fatalf("task_create_batch hit %s %s", gotMethod, gotPath)
	}
	if gotAgent != "agent-1" {
		t.Fatalf("agent header = %q", gotAgent)
	}
	sent, _ := gotBody["tasks"].([]interface{})
	if len(sent) != 2 {
		t.Fatalf("body = %#v, want two tasks in one request", gotBody)
	}
	first, _ := sent[0].(map[string]interface{})
	second, _ := sent[1].(map[string]interface{})
	// Omitted assignee defaults to this agent; an explicit null stays unassigned.
	if first["assigneeId"] != "agent-1" || first["ref"] != "s0" {
		t.Fatalf("tasks[0] = %#v", first)
	}
	if assignee, present := second["assigneeId"]; !present || assignee != nil {
		t.Fatalf("tasks[1] assigneeId = %#v, want an explicit null", second["assigneeId"])
	}
	if refs, _ := second["dependsOnRefs"].([]interface{}); len(refs) != 1 || refs[0] != "s0" {
		t.Fatalf("tasks[1] dependsOnRefs = %#v", second["dependsOnRefs"])
	}
}

func TestMCPTaskCreateBatchRejectsBadInputBeforeTheRoundTrip(t *testing.T) {
	mcp := &mcpServer{agentID: "agent-1", t: NewTransport("http://127.0.0.1:1", "tok")}
	oversized := make([]interface{}, maxTaskBatchCreate+1)
	for i := range oversized {
		oversized[i] = map[string]interface{}{"title": "t"}
	}
	cases := map[string]interface{}{
		"empty":      []interface{}{},
		"untitled":   []interface{}{map[string]interface{}{"description": "no title"}},
		"not object": []interface{}{"nope"},
		"oversized":  oversized,
	}
	for name, tasks := range cases {
		if res := mcp.callTool("task_create_batch", map[string]interface{}{"tasks": tasks}); res["isError"] != true {
			t.Fatalf("%s batch isError = %#v", name, res["isError"])
		}
	}
}

func TestMCPTaskIDsCannotEscapeTaskRoute(t *testing.T) {
	mcp := &mcpServer{t: NewTransport("http://127.0.0.1:1", "tok")}
	for _, tool := range []string{"task_get", "task_delete"} {
		for _, id := range []string{"../sessions", "..%2Fsessions", "a/b"} {
			res := mcp.callTool(tool, map[string]interface{}{"taskId": id})
			if res["isError"] != true {
				t.Fatalf("%s(%q) isError = %#v", tool, id, res["isError"])
			}
			content, _ := res["content"].([]map[string]interface{})
			if len(content) == 0 || !strings.Contains(content[0]["text"].(string), "single safe path segment") {
				t.Fatalf("%s(%q) result = %#v", tool, id, res)
			}
		}
	}
}

func TestMCPTaskDependencyIDsCannotEscapeTaskRoute(t *testing.T) {
	mcp := &mcpServer{taskID: "task-1", t: NewTransport("http://127.0.0.1:1", "tok")}
	for _, tool := range []string{"task_dependency_add", "task_dependency_remove"} {
		res := mcp.callTool(tool, map[string]interface{}{"dependsOnTaskId": "../sessions"})
		if res["isError"] != true {
			t.Fatalf("%s unsafe prerequisite isError = %#v", tool, res["isError"])
		}
		content, _ := res["content"].([]map[string]interface{})
		if len(content) == 0 || !strings.Contains(content[0]["text"].(string), "single safe path segment") {
			t.Fatalf("%s unsafe prerequisite result = %#v", tool, res)
		}
	}
}

func TestMCPTaskDependencyGraphRejectsInvalidBounds(t *testing.T) {
	mcp := &mcpServer{taskID: "task-1", t: NewTransport("http://127.0.0.1:1", "tok")}
	for _, args := range []map[string]interface{}{
		{"maxDepth": float64(0)},
		{"maxDepth": float64(33)},
		{"maxDepth": 1.5},
		{"maxNodes": float64(501)},
	} {
		res := mcp.callTool("task_dependency_graph", args)
		if res["isError"] != true {
			t.Fatalf("task_dependency_graph(%#v) isError = %#v", args, res["isError"])
		}
		content, _ := res["content"].([]map[string]interface{})
		if len(content) == 0 || !strings.Contains(content[0]["text"].(string), "must be an integer") {
			t.Fatalf("task_dependency_graph(%#v) result = %#v", args, res)
		}
	}
}

func TestMCPOrchestrationEnv(t *testing.T) {
	t.Setenv(envMCPOrchestration, "")
	if mcpOrchestrationEnabled() {
		t.Fatalf("mcpOrchestrationEnabled = true by default")
	}
	t.Setenv(envMCPOrchestration, "1")
	if !mcpOrchestrationEnabled() {
		t.Fatalf("mcpOrchestrationEnabled = false for 1")
	}
	t.Setenv(envMCPOrchestration, "true")
	if !mcpOrchestrationEnabled() {
		t.Fatalf("mcpOrchestrationEnabled = false for true")
	}
}

func TestMCPSessionToolsDisabledAreError(t *testing.T) {
	srv := &mcpServer{allowOrchestration: false}
	for _, name := range []string{"session_create", "session_list", "session_search", "session_get", "session_await", "session_send", "session_interrupt", "session_merge", "session_end", "session_complete", "session_delete", "agent_list", "agent_create", "agent_update"} {
		res := srv.callTool(name, map[string]interface{}{})
		if res["isError"] != true {
			t.Fatalf("%s with orchestration off: isError = %#v", name, res["isError"])
		}
	}
}

func TestSessionListQuery(t *testing.T) {
	if q := sessionListQuery(map[string]interface{}{}); q != "" {
		t.Fatalf("empty-args query = %q, want empty", q)
	}
	if q := sessionListQuery(map[string]interface{}{"status": "RUNNING"}); q != "?status=RUNNING" {
		t.Fatalf("status query = %q", q)
	}
}

func TestSessionSearchQuery(t *testing.T) {
	if q := sessionSearchQuery(map[string]interface{}{"query": "merge conflict"}); q != "?q=merge+conflict" {
		t.Fatalf("query = %q", q)
	}
	// A limit arrives as a JSON number, but models often quote it.
	if q := sessionSearchQuery(map[string]interface{}{"query": "a", "limit": float64(5)}); q != "?limit=5&q=a" {
		t.Fatalf("float limit query = %q", q)
	}
	if q := sessionSearchQuery(map[string]interface{}{"query": "a", "limit": "5"}); q != "?limit=5&q=a" {
		t.Fatalf("string limit query = %q", q)
	}
	// An unusable limit is left off so the server's own default applies.
	if q := sessionSearchQuery(map[string]interface{}{"query": "a", "limit": "many"}); q != "?q=a" {
		t.Fatalf("bad limit query = %q", q)
	}
}

// An empty query must be rejected locally: server-side it would mean "return recents",
// which is session_list's job, not a search result.
func TestSessionSearchRequiresQuery(t *testing.T) {
	srv := &mcpServer{
		allowOrchestration: true,
		sessionID:          "s1",
		orchestrationToken: "session-token",
	}
	res := srv.callTool("session_search", map[string]interface{}{})
	if res["isError"] != true {
		t.Fatalf("session_search with no query: isError = %#v", res["isError"])
	}
}

func TestMCPSessionCompleteUsesCompleteSessionEndpoint(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{
		t:                  NewTransport(srv.URL, "runner-token"),
		sessionID:          "caller-session",
		orchestrationToken: "session-token",
		allowOrchestration: true,
	}
	res := mcp.callTool("session_complete", map[string]interface{}{"sessionId": "child-session"})
	if res["isError"] == true {
		t.Fatalf("session_complete returned an error: %#v", res["content"])
	}
	if gotMethod != http.MethodPost || gotPath != "/api/runner/sessions/child-session/complete-session" {
		t.Fatalf("session_complete hit %s %s", gotMethod, gotPath)
	}
}

func TestMCPSessionDeleteUsesSoftDeleteEndpoint(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{
		t:                  NewTransport(srv.URL, "runner-token"),
		sessionID:          "caller-session",
		orchestrationToken: "session-token",
		allowOrchestration: true,
	}
	res := mcp.callTool("session_delete", map[string]interface{}{"sessionId": "child-session"})
	if res["isError"] == true {
		t.Fatalf("session_delete returned an error: %#v", res["content"])
	}
	if gotMethod != http.MethodDelete || gotPath != "/api/runner/sessions/child-session" {
		t.Fatalf("session_delete hit %s %s", gotMethod, gotPath)
	}
}

// The permission posture belongs to the run, and a spawned run is the one nobody is sitting in
// front of: an orchestrator that knows its sub-task is read-only (plan) or unattended (dontAsk)
// has to be able to say so instead of taking whatever the account defaults to. A param the schema
// advertises but callTool drops is silently ignored, so assert both ends.
func TestMCPSessionCreateCarriesPermissionMode(t *testing.T) {
	props := mcpToolProps(toolDescriptors(false, true), "session_create")
	schema, _ := props["permissionMode"].(map[string]interface{})
	if schema["type"] != "string" {
		t.Fatalf("session_create permissionMode schema = %#v", props["permissionMode"])
	}
	offered, _ := schema["enum"].([]string)
	// Compared against the helper rather than a literal list, because the answer is per-machine: a
	// root runner withholds "bypassPermissions" (TestOfferedPermissionModes covers both branches
	// deterministically). A literal here would fail whenever the suite itself runs as root.
	for _, want := range offeredPermissionModes() {
		found := false
		for _, mode := range offered {
			found = found || mode == want
		}
		if !found {
			t.Fatalf("session_create permissionMode enum %#v is missing %q", offered, want)
		}
	}
	if len(offered) != len(offeredPermissionModes()) {
		t.Fatalf("session_create permissionMode enum %#v is not what this machine offers (%#v)",
			offered, offeredPermissionModes())
	}

	var gotBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody = nil
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`{"id":"child","status":"PENDING"}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{
		t:                  NewTransport(srv.URL, "runner-token"),
		sessionID:          "caller-session",
		orchestrationToken: "session-token",
		allowOrchestration: true,
	}
	res := mcp.callTool("session_create", map[string]interface{}{
		"prompt":         "audit the migration, change nothing",
		"permissionMode": "plan",
	})
	if res["isError"] == true {
		t.Fatalf("session_create returned an error: %#v", res["content"])
	}
	if gotBody["permissionMode"] != "plan" {
		t.Fatalf("session_create body permissionMode = %#v", gotBody["permissionMode"])
	}

	// Omitted must stay omitted: the account default is the server's to apply, and a runner that
	// filled in a mode of its own would overrule it on every spawn.
	if res := mcp.callTool("session_create", map[string]interface{}{"prompt": "ship it"}); res["isError"] == true {
		t.Fatalf("session_create returned an error: %#v", res["content"])
	}
	if _, ok := gotBody["permissionMode"]; ok {
		t.Fatalf("session_create invented a permissionMode: %#v", gotBody["permissionMode"])
	}
}

func TestSessionSettled(t *testing.T) {
	for _, s := range []string{"PENDING", "RUNNING", ""} {
		if sessionSettled(s) {
			t.Fatalf("sessionSettled(%q) = true, want false", s)
		}
	}
	for _, s := range []string{"AWAITING_INPUT", "SUCCEEDED", "FAILED", "CANCELLED"} {
		if !sessionSettled(s) {
			t.Fatalf("sessionSettled(%q) = false, want true", s)
		}
	}
}

// The agent tools must advertise the full config surface an orchestrator may write, and
// actually forward it — a param in the schema that callTool drops is silently ignored.
func TestMCPAgentToolsCarryAgentConfig(t *testing.T) {
	tools := toolDescriptors(false, true)
	for _, name := range []string{"agent_create", "agent_update"} {
		props := mcpToolProps(tools, name)
		for _, field := range []string{"env", "defaultMergeTarget"} {
			if props[field] == nil {
				t.Fatalf("%s inputSchema missing %s", name, field)
			}
		}
		// Still human-only: an agent must not be able to grant orchestration.
		if props["enableOrchestration"] != nil {
			t.Fatalf("%s must not expose enableOrchestration", name)
		}
		if props["model"] != nil {
			t.Fatalf("%s must not expose the retired per-agent model", name)
		}
		// The permission posture is per session, defaulted from the account — an agent has none.
		// The server drops the field, so advertising it would promise supervision that never
		// arrives, which is worse than not offering it at all.
		if props["permissionMode"] != nil {
			t.Fatalf("%s must not expose permissionMode — it is not an agent field", name)
		}
	}
	var gotPath string
	var gotBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		json.NewDecoder(r.Body).Decode(&gotBody)
		w.Write([]byte(`{"id":"a1"}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{allowOrchestration: true, sessionID: "s1", orchestrationToken: "session-token", t: NewTransport(srv.URL, "tok")}
	args := map[string]interface{}{
		"name":               "child",
		"agentId":            "a1",
		"model":              "gpt-retired-agent-default",
		"env":                map[string]interface{}{"FOO": "bar"},
		"permissionMode":     "acceptEdits",
		"defaultMergeTarget": "develop",
	}
	for _, tc := range []struct{ tool, path string }{
		{"agent_create", "/api/runner/agents"},
		{"agent_update", "/api/runner/agents/a1"},
	} {
		name := tc.tool
		gotBody = nil
		if res := mcp.callTool(name, args); res["isError"] == true {
			t.Fatalf("%s returned an error: %#v", name, res["content"])
		}
		if gotPath != tc.path {
			t.Fatalf("%s hit %q, want %q", name, gotPath, tc.path)
		}
		if env, _ := gotBody["env"].(map[string]interface{}); env["FOO"] != "bar" {
			t.Fatalf("%s body env = %#v", name, gotBody["env"])
		}
		if _, ok := gotBody["permissionMode"]; ok {
			t.Fatalf("%s forwarded permissionMode, which the agent does not own: %#v", name, gotBody["permissionMode"])
		}
		if gotBody["defaultMergeTarget"] != "develop" {
			t.Fatalf("%s body defaultMergeTarget = %#v", name, gotBody["defaultMergeTarget"])
		}
		if _, ok := gotBody["model"]; ok {
			t.Fatalf("%s forwarded retired per-agent model: %#v", name, gotBody["model"])
		}
	}
}

func TestMCPAgentUpdateRejectsUnsafeIDBeforeTransport(t *testing.T) {
	requestCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	mcp := &mcpServer{
		allowOrchestration: true,
		sessionID:          "s1",
		orchestrationToken: "session-token",
		t:                  NewTransport(srv.URL, "tok"),
	}
	result := mcp.callTool("agent_update", map[string]interface{}{
		"agentId": "../sessions",
		"name":    "unsafe",
	})
	if result["isError"] != true {
		t.Fatalf("agent_update result = %#v, want error", result)
	}
	if requestCount != 0 {
		t.Fatalf("unsafe agent id sent %d requests, want 0", requestCount)
	}
}

// mcpToolProps returns a tool's inputSchema properties map.
func mcpToolProps(tools []map[string]interface{}, name string) map[string]interface{} {
	for _, tool := range tools {
		if tool["name"] != name {
			continue
		}
		schema, _ := tool["inputSchema"].(map[string]interface{})
		props, _ := schema["properties"].(map[string]interface{})
		return props
	}
	return nil
}

func hasMCPTool(tools []map[string]interface{}, name string) bool {
	for _, tool := range tools {
		if tool["name"] == name {
			return true
		}
	}
	return false
}

func TestMCPTaskListPolicyToolsSendOnlyWhatWasSet(t *testing.T) {
	tools := toolDescriptors(false, false)
	for _, name := range []string{"tasklist_get", "tasklist_update"} {
		if !hasMCPTool(tools, name) {
			t.Fatalf("%s missing from the base task tools", name)
		}
	}

	var gotMethod, gotPath, gotAgent, gotSession string
	var body map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotAgent = r.Header.Get("X-Orbit-Agent-Id")
		gotSession = r.Header.Get("X-Orbit-Session-Id")
		json.NewDecoder(r.Body).Decode(&body)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{agentID: "workspace-1", sessionID: "session-9", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("tasklist_update", map[string]interface{}{
		"listId":       "list-1",
		"instructions": "按 manifest 逐个下载。",
		"paused":       true,
		"note":         "disk below floor",
	})
	if res["isError"] == true {
		t.Fatalf("tasklist_update returned an error: %#v", res["content"])
	}
	if gotMethod != http.MethodPatch || gotPath != "/api/runner/task-lists/list-1" {
		t.Fatalf("tasklist_update hit %s %s", gotMethod, gotPath)
	}
	// Attribution: the revision this creates has to name the agent AND the run that made it.
	// The agent alone is not enough — a workspace has thousands of sessions, and the point of
	// recording the author is that a human can open the run and read why.
	if gotAgent != "workspace-1" || gotSession != "session-9" {
		t.Fatalf("attribution headers = agent %q session %q", gotAgent, gotSession)
	}
	// Every field the caller set must survive the trip — a silently dropped key would mean an
	// agent believing it had changed policy that never moved.
	if body["instructions"] != "按 manifest 逐个下载。" || body["paused"] != true ||
		body["note"] != "disk below floor" {
		t.Fatalf("body = %#v", body)
	}
	// And nothing the caller did not set: a partial edit must never blank the rest of the policy.
	// listId included: it addresses the list in the path, and echoing it into the body would be
	// the signature of blindly forwarding the whole argument map.
	for _, absent := range []string{"listId", "title", "maxConcurrent", "foremanWorkspaceId", "foremanStallMinutes"} {
		if _, ok := body[absent]; ok {
			t.Fatalf("tasklist_update sent unset field %q: %#v", absent, body)
		}
	}
}

func TestMCPTaskListUpdateRequiresAListId(t *testing.T) {
	mcp := &mcpServer{t: NewTransport("http://127.0.0.1:1", "tok")}
	if res := mcp.callTool("tasklist_update", map[string]interface{}{"paused": true}); res["isError"] != true {
		t.Fatalf("tasklist_update without listId did not error: %#v", res)
	}
	// A call that names a list but changes nothing is a mistake worth reporting rather than an
	// empty PATCH that records a no-op revision.
	if res := mcp.callTool("tasklist_update", map[string]interface{}{"listId": "list-1"}); res["isError"] != true {
		t.Fatalf("empty tasklist_update did not error: %#v", res)
	}
}

func TestMCPTaskListDelete(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{agentID: "workspace-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("tasklist_delete", map[string]interface{}{"listId": "list-1"})
	if res["isError"] == true {
		t.Fatalf("tasklist_delete returned an error: %#v", res["content"])
	}
	if gotMethod != http.MethodDelete || gotPath != "/api/runner/task-lists/list-1" {
		t.Fatalf("tasklist_delete hit %s %s", gotMethod, gotPath)
	}
	// Without an id this must fail here, not send DELETE to the collection route.
	if res := mcp.callTool("tasklist_delete", map[string]interface{}{}); res["isError"] != true {
		t.Fatalf("tasklist_delete without listId did not error: %#v", res)
	}
}

// Building a DAG is the most consequential thing an agent does here and the least visible: fifty
// titles say nothing, and what happens is some number of runs starting within the minute. This
// deployment created 43 lists and ~21,500 tasks from one session before anyone looked, which is
// why the batch is gated rather than the tool being trusted to be used sparingly.
func TestMCPTaskCreateBatchAsksBeforeWriting(t *testing.T) {
	var hits []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.URL.Path)
		switch {
		case strings.HasSuffix(r.URL.Path, "/tasks/batch-preview"):
			_, _ = w.Write([]byte(`{"taskCount":2,"startingNow":2}`))
		case strings.Contains(r.URL.Path, "/approvals/"):
			_, _ = w.Write([]byte(`{"status":"ALLOWED"}`))
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			_, _ = w.Write([]byte(`{"id":"ap1","status":"ALLOWED"}`))
		default:
			_, _ = w.Write([]byte(`[{"id":"t1"},{"id":"t2"}]`))
		}
	}))
	defer srv.Close()

	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create_batch", map[string]interface{}{
		"tasks": []interface{}{map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT"}, map[string]interface{}{"title": "b", "completionCriterion": "EVIDENCE_JUDGMENT"}},
	})
	if res["isError"] == true {
		t.Fatalf("batch returned an error: %#v", res["content"])
	}
	// Preview, then ask, then write — in that order. A write that reached the server before the
	// approval was registered would make the card a formality.
	if len(hits) < 3 ||
		!strings.HasSuffix(hits[0], "/tasks/batch-preview") ||
		!strings.HasSuffix(hits[1], "/approvals") ||
		!strings.HasSuffix(hits[len(hits)-1], "/tasks/batch-create") {
		t.Fatalf("call order = %v", hits)
	}
}

func TestMCPTaskCreateBatchWritesNothingWhenDenied(t *testing.T) {
	var wrote bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/tasks/batch-preview"):
			_, _ = w.Write([]byte(`{"taskCount":1,"startingNow":1}`))
		case strings.Contains(r.URL.Path, "/approvals/"):
			_, _ = w.Write([]byte(`{"status":"DENIED","message":"太多了"}`))
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			_, _ = w.Write([]byte(`{"id":"ap1","status":"PENDING"}`))
		default:
			wrote = true
			_, _ = w.Write([]byte(`[{"id":"t1"}]`))
		}
	}))
	defer srv.Close()

	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create_batch", map[string]interface{}{
		"tasks": []interface{}{map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT"}},
	})

	if wrote {
		t.Fatal("a denied batch still wrote its tasks")
	}
	// The refusal reaches the model as an ordinary result, carrying the human's reason, so it can
	// respond to it instead of retrying blind.
	body := fmt.Sprintf("%v", res["content"])
	if !strings.Contains(body, "太多了") {
		t.Fatalf("deny message not passed back: %v", body)
	}
}

// Headless there is nobody to ask, so the write must go ahead exactly as it did before rather
// than blocking forever on an approval no UI will ever show.
// A batch that starts nothing used to go through unasked, as a bookkeeping write. The owner's rule
// is that nothing is created on their behalf without a yes, and fifty tasks that wait are still
// fifty tasks they did not agree to.
func TestMCPTaskCreateBatchAsksEvenWhenNothingStarts(t *testing.T) {
	var asked bool
	var wrote bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/tasks/batch-preview"):
			_, _ = w.Write([]byte(`{"taskCount":50,"startingNow":0,"needsManualStart":50}`))
		case strings.Contains(r.URL.Path, "/approvals/"):
			_, _ = w.Write([]byte(`{"status":"ALLOWED"}`))
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			asked = true
			_, _ = w.Write([]byte(`{"id":"ap1","status":"PENDING"}`))
		default:
			wrote = true
			_, _ = w.Write([]byte(`[{"id":"t1"}]`))
		}
	}))
	defer srv.Close()

	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create_batch", map[string]interface{}{
		"tasks": []interface{}{map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT"}},
	})

	if res["isError"] == true {
		t.Fatalf("batch returned an error: %#v", res["content"])
	}
	if !asked {
		t.Fatal("a batch that starts nothing was written without asking")
	}
	if !wrote {
		t.Fatal("an approved batch was not written")
	}
}

// The consequence is what earns a card: these begin within the minute.
func TestMCPTaskCreateBatchStillAsksWhenRunsWouldStart(t *testing.T) {
	var asked bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/tasks/batch-preview"):
			_, _ = w.Write([]byte(`{"taskCount":50,"startingNow":40}`))
		case strings.Contains(r.URL.Path, "/approvals/"):
			_, _ = w.Write([]byte(`{"status":"ALLOWED"}`))
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			asked = true
			_, _ = w.Write([]byte(`{"id":"ap1","status":"PENDING"}`))
		default:
			_, _ = w.Write([]byte(`[{"id":"t1"}]`))
		}
	}))
	defer srv.Close()

	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
	mcp.callTool("task_create_batch", map[string]interface{}{
		"tasks": []interface{}{map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT"}},
	})

	if !asked {
		t.Fatal("a batch that starts 40 runs was written without asking")
	}
}

func TestMCPTaskCreateBatchHeadlessDoesNotAsk(t *testing.T) {
	var asked bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "approval") || strings.Contains(r.URL.Path, "preview") {
			asked = true
		}
		_, _ = w.Write([]byte(`[{"id":"t1"}]`))
	}))
	defer srv.Close()

	mcp := &mcpServer{agentID: "agent-1", sessionID: "", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create_batch", map[string]interface{}{
		"tasks": []interface{}{map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT"}},
	})

	if res["isError"] == true {
		t.Fatalf("headless batch failed: %#v", res["content"])
	}
	if asked {
		t.Fatal("headless batch tried to raise an approval")
	}
}

// The MCP tools and the CLI are two doors onto one API, so what they put on the wire has to be
// the same request. `orbit session send/interrupt` is pinned by TestSessionCLIExactRoutes…; this
// is the other door, checked against the same expectations.
func TestMCPSessionSendAndInterruptPutTheSameRequestOnTheWire(t *testing.T) {
	type call struct {
		path string
		body map[string]interface{}
	}
	var calls []call
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		raw, _ := io.ReadAll(r.Body)
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &body)
		}
		calls = append(calls, call{r.URL.Path, body})
		w.Write([]byte(`{"ok":true,"turnId":"turn-1","seq":7,"kind":"steer"}`))
	}))
	defer srv.Close()
	mcp := &mcpServer{
		sessionID: "parent", orchestrationToken: "tok", allowOrchestration: true,
		t: NewTransport(srv.URL, "runner-secret"),
	}

	// A send with the caller's own idempotency key: a retried tool call returns the turn already
	// filed rather than queueing the message a second time.
	if res := mcp.callTool("session_send", map[string]interface{}{
		"sessionId": "child", "message": "adjust the tests", "clientTurnId": "key-1",
	}); res["isError"] == true {
		t.Fatalf("session_send errored: %#v", res["content"])
	}
	// …and without one, which is what every caller sent before: the server mints it.
	if res := mcp.callTool("session_send", map[string]interface{}{
		"sessionId": "child", "message": "adjust the tests",
	}); res["isError"] == true {
		t.Fatalf("session_send errored: %#v", res["content"])
	}
	// A plain stop stays a bodyless POST…
	if res := mcp.callTool("session_interrupt", map[string]interface{}{
		"sessionId": "child",
	}); res["isError"] == true {
		t.Fatalf("session_interrupt errored: %#v", res["content"])
	}
	// …and "stop that and do THIS instead" is one request, never a stop followed by a send: the
	// interrupt drops what was queued behind the running turn, so a separate send would be racing
	// that delete, and one arriving just after would be steered INTO the turn being stopped.
	if res := mcp.callTool("session_interrupt", map[string]interface{}{
		"sessionId": "child", "message": "do this instead", "clientTurnId": "key-2",
	}); res["isError"] == true {
		t.Fatalf("session_interrupt errored: %#v", res["content"])
	}

	want := []call{
		{"/api/runner/sessions/child/turns", map[string]interface{}{"message": "adjust the tests", "clientTurnId": "key-1"}},
		{"/api/runner/sessions/child/turns", map[string]interface{}{"message": "adjust the tests"}},
		{"/api/runner/sessions/child/interrupt", nil},
		{"/api/runner/sessions/child/interrupt", map[string]interface{}{"message": "do this instead", "clientTurnId": "key-2"}},
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("requests =\n%#v\nwant\n%#v", calls, want)
	}
}

// ownerWaitDouble is a control plane whose create cards stay PENDING until the test answers them.
type ownerWaitDouble struct {
	mu       sync.Mutex
	cards    []map[string]interface{}
	status   map[string]string
	created  []http.Header
	requests []string
	srv      *httptest.Server
}

func newOwnerWaitDouble(t *testing.T) *ownerWaitDouble {
	d := &ownerWaitDouble{status: map[string]string{}}
	d.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		d.mu.Lock()
		defer d.mu.Unlock()
		d.requests = append(d.requests, r.Method+" "+r.URL.Path)
		switch {
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/approvals"):
			id := fmt.Sprintf("card-%d", len(d.cards)+1)
			d.cards = append(d.cards, body)
			d.status[id] = "PENDING"
			_, _ = fmt.Fprintf(w, `{"id":%q,"status":"PENDING"}`, id)
		case strings.Contains(r.URL.Path, "/approvals/"):
			_, _ = fmt.Fprintf(w, `{"status":%q}`, d.status[r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]])
		case r.Method == "POST" && r.URL.Path == "/api/runner/tasks":
			d.created = append(d.created, r.Header.Clone())
			_, _ = w.Write([]byte(`{"id":"handed-off-task"}`))
		default:
			http.Error(w, "unexpected", http.StatusNotFound)
		}
	}))
	t.Cleanup(d.srv.Close)
	return d
}

func (d *ownerWaitDouble) snapshot() (cards []map[string]interface{}, created []http.Header, requests []string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append(cards, d.cards...), append(created, d.created...), append(requests, d.requests...)
}

func (d *ownerWaitDouble) decide(id, status string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.status[id] = status
}

var ownerWaitTaskArgs = map[string]interface{}{"title": "handed off", "completionCriterion": "EVIDENCE_JUDGMENT"}

func resultText(res map[string]interface{}) string {
	return res["content"].([]map[string]interface{})[0]["text"].(string)
}

// Under an engine that ends tool calls on its own deadline, a create that waits for the owner returns
// at once and hands the wait to a runner-hosted job: the job files the card (naming itself, so the card
// outlives the turn), writes only on a confirmation, and wakes the session with the call's own result.
func TestMCPOwnerWaitIsHandedOffUnderAnEngineDeadline(t *testing.T) {
	d := newOwnerWaitDouble(t)
	// The job runs this test binary as `orbit mcp`, which reaches the double through ORBIT_HOME.
	home, err := os.MkdirTemp("", "mcpho")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	config, _ := json.Marshal(RunnerConfig{ServerURL: d.srv.URL, RunnerID: "r", RunnerToken: "tok"})
	if err := os.WriteFile(filepath.Join(home, "config.json"), config, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ORBIT_HOME", home)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var wakesMu sync.Mutex
	wakes := map[string]bgWake{}
	bg := newBgTailer(ctx, func(string, map[string]interface{}) {}, nil)
	bg.wakeSessionVia(func(w bgWake) error { wakesMu.Lock(); wakes[w.JobID] = w; wakesMu.Unlock(); return nil })
	defer bg.stopAll()
	svc := &bgJobService{bg: bg, token: "ho-token", execDir: home, scratchDir: home, sessionID: "sess-ho"}
	socket := filepath.Join(home, "bg.sock")
	stop, err := startBgJobService(ctx, svc, socket, filepath.Join(home, "bg.token"))
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	t.Setenv(envBgSocket, socket)
	t.Setenv(envBgToken, "ho-token")
	s := &mcpServer{t: NewTransport(d.srv.URL, "tok"), sessionID: "sess-ho", agentID: "agent-ho", taskID: "task-ho", callTimeout: time.Minute}

	for i, decision := range []string{"ALLOWED", "DENIED"} {
		started := time.Now()
		res := s.callTool("task_create", ownerWaitTaskArgs)
		text := resultText(res)
		jobID := handedOffJobID(text)
		if res["isError"] == true || !strings.Contains(text, "Not done yet") || jobID == "" || time.Since(started) > 5*time.Second {
			t.Fatalf("the call did not return at once with its job: %s", text)
		}
		var cards []map[string]interface{}
		awaitCondition(t, 30*time.Second, "the job never filed the card", func() bool {
			cards, _, _ = d.snapshot()
			return len(cards) == i+1
		})
		if cards[i]["toolName"] != taskCreateApprovalToolName || cards[i]["backgroundJobId"] != jobID {
			t.Fatalf("card = %+v", cards[i])
		}
		time.Sleep(300 * time.Millisecond)
		if _, created, _ := d.snapshot(); len(created) != i {
			t.Fatal("a task was written before the owner answered")
		}
		d.decide(fmt.Sprintf("card-%d", i+1), decision)
		var wake bgWake
		awaitCondition(t, 30*time.Second, "the job never woke the session", func() bool {
			wakesMu.Lock()
			defer wakesMu.Unlock()
			wake = wakes[jobID]
			return wake.JobID != ""
		})
		_, created, _ := d.snapshot()
		switch decision {
		case "ALLOWED":
			if len(created) != 1 || created[0].Get("X-Orbit-Agent-Id") != "agent-ho" || created[0].Get("X-Orbit-Session-Id") != "sess-ho" ||
				!strings.Contains(wake.OutputExcerpt, "handed-off-task") {
				t.Fatalf("confirmed: created=%v wake=%q", created, wake.OutputExcerpt)
			}
		case "DENIED":
			if len(created) != 1 || !strings.Contains(wake.OutputExcerpt, "the human rejected this task") {
				t.Fatalf("declined: created=%d wake=%q", len(created), wake.OutputExcerpt)
			}
		}
	}
	if leftovers, _ := filepath.Glob(filepath.Join(os.TempDir(), "orbit-mcp-handoff-*.json")); len(leftovers) != 0 {
		t.Fatalf("request files left behind: %v", leftovers)
	}
}

// With nowhere to hand the wait to, the call is refused before anything is filed: a refusal the model
// sees, and nothing the owner could still confirm into a write.
func TestMCPOwnerWaitIsRefusedWithoutAJobService(t *testing.T) {
	d := newOwnerWaitDouble(t)
	t.Setenv(envBgSocket, "")
	t.Setenv(envBgToken, "")
	s := &mcpServer{t: NewTransport(d.srv.URL, "tok"), sessionID: "sess-ho", agentID: "agent-ho", callTimeout: time.Minute}
	for _, name := range []string{"task_create", "task_create_batch", "project_create", "project_blocker_resolve",
		"tasklist_propose_dag", "provider_create", "provider_update", "provider_delete"} {
		res := s.callTool(name, map[string]interface{}{"title": "x", "tasks": []interface{}{ownerWaitTaskArgs}})
		if text := resultText(res); res["isError"] != true || !strings.Contains(text, "nothing was filed or written") {
			t.Fatalf("%s: %s", name, text)
		}
	}
	if _, _, requests := d.snapshot(); len(requests) != 0 {
		t.Fatalf("a refused call reached the control plane: %v", requests)
	}
}

// Every other runtime starts `orbit mcp` without a deadline, and a create there still asks and waits
// inside the call, exactly as before: the card is filed by this process and the write follows the yes.
func TestMCPOwnerWaitBlocksInTheCallWithoutAnEngineDeadline(t *testing.T) {
	t.Setenv(envMCPCallTimeout, "")
	if got := mcpCallTimeoutFromEnv(); got != 0 {
		t.Fatalf("no deadline set, read %s", got)
	}
	d := newOwnerWaitDouble(t)
	s := &mcpServer{t: NewTransport(d.srv.URL, "tok"), sessionID: "sess-ho", agentID: "agent-ho"}
	done := make(chan map[string]interface{})
	go func() { done <- s.callTool("task_create", ownerWaitTaskArgs) }()
	awaitCondition(t, 10*time.Second, "no card was filed", func() bool { cards, _, _ := d.snapshot(); return len(cards) == 1 })
	select {
	case res := <-done:
		t.Fatalf("the call returned before the owner answered: %v", res)
	case <-time.After(500 * time.Millisecond):
	}
	if cards, _, _ := d.snapshot(); cards[0]["backgroundJobId"] != nil {
		t.Fatalf("the card was filed by a job: %+v", cards[0])
	}
	d.decide("card-1", "ALLOWED")
	res := <-done
	if _, created, _ := d.snapshot(); res["isError"] == true || len(created) != 1 || !strings.Contains(resultText(res), "handed-off-task") {
		t.Fatalf("result = %v, created = %d", res, len(created))
	}
	// A dry-run batch asks nobody, and is not handed off even under a deadline.
	if waitsForTheOwner("task_create_batch", map[string]interface{}{"dryRun": true}) {
		t.Fatal("a dry run was treated as waiting for the owner")
	}
}

// The inline waits a call may hold — session_create's wait, session_merge's waitSeconds — end within half
// the engine's deadline, and are untouched without one.
func TestMCPInlineWaitsEndBeforeAnEngineDeadline(t *testing.T) {
	t.Setenv(envMCPCallTimeout, "")
	if got := sessionWaitPolls(0); got != maxSessionWaitPolls {
		t.Fatalf("without a deadline polls = %d", got)
	}
	t.Setenv(envMCPCallTimeout, "60")
	if got := time.Duration(sessionWaitPolls(0)) * sessionWaitInterval; got > 30*time.Second || got <= 0 {
		t.Fatalf("under a 60s deadline the session wait is %s", got)
	}
	var mu sync.Mutex
	var waits []interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		waits = append(waits, body["waitSeconds"])
		mu.Unlock()
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	for _, timeout := range []time.Duration{0, time.Minute} {
		s := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "sess-ho", allowOrchestration: true, callTimeout: timeout}
		if res := s.callTool("session_merge", map[string]interface{}{"sessionId": "child", "waitSeconds": float64(120)}); res["isError"] == true {
			t.Fatalf("merge: %v", res)
		}
	}
	if fmt.Sprint(waits) != "[120 30]" {
		t.Fatalf("waitSeconds sent = %v, want 120 without a deadline and 30 under 60s", waits)
	}
}

// engineDoorCall is one MCP tool call that may carry `engine`, and the request it must turn into.
type engineDoorCall struct {
	tool    string
	request string
	args    map[string]interface{}
	// body reads the object the engine belongs on out of the forwarded request body.
	body func(map[string]interface{}) map[string]interface{}
}

func engineDoorCalls(pins map[string]interface{}) []engineDoorCall {
	with := func(args map[string]interface{}) map[string]interface{} {
		for key, value := range pins {
			args[key] = value
		}
		return args
	}
	whole := func(body map[string]interface{}) map[string]interface{} { return body }
	return []engineDoorCall{
		{tool: "session_create", request: "POST /api/runner/sessions", body: whole,
			args: with(map[string]interface{}{"prompt": "review the change"})},
		{tool: "task_create", request: "POST /api/runner/tasks", body: whole,
			args: with(map[string]interface{}{"title": "Pinned", "completionCriterion": "EVIDENCE_JUDGMENT"})},
		{tool: "task_create_batch", request: "POST /api/runner/tasks/batch-create",
			args: map[string]interface{}{"tasks": []interface{}{
				with(map[string]interface{}{"title": "Pinned", "completionCriterion": "EVIDENCE_JUDGMENT"}),
			}},
			body: func(body map[string]interface{}) map[string]interface{} {
				items, _ := body["tasks"].([]interface{})
				if len(items) != 1 {
					return nil
				}
				item, _ := items[0].(map[string]interface{})
				return item
			}},
		{tool: "task_update", request: "PATCH /api/runner/tasks/task-1", body: whole,
			args: with(map[string]interface{}{"taskId": "task-1"})},
		{tool: "task_batch_pin", request: "POST /api/runner/tasks/batch-pin", body: whole,
			args: with(map[string]interface{}{"projectId": "01a02d83-7c58-708c-8d7c-103d15523d70"})},
	}
}

// callEngineDoor runs one call against a stand-in control plane and returns the request it made. The
// task tools run headless, so no confirmation card stands between the call and its write; the session
// tool runs from a session with orchestration on, which is the only place it exists.
func callEngineDoor(t *testing.T, call engineDoorCall) (string, map[string]interface{}) {
	t.Helper()
	var requests []string
	var gotBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		gotBody = nil
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`{"id":"created","changed":1}`))
	}))
	defer srv.Close()
	mcp := &mcpServer{t: NewTransport(srv.URL, "runner-token"), agentID: "agent-1"}
	if call.tool == "session_create" {
		mcp.sessionID, mcp.orchestrationToken, mcp.allowOrchestration = "caller-session", "session-token", true
	}
	if res := mcp.callTool(call.tool, call.args); res["isError"] == true {
		t.Fatalf("%s returned an error: %#v", call.tool, res["content"])
	}
	if len(requests) != 1 || requests[0] != call.request {
		t.Fatalf("%s made %v, want one %s", call.tool, requests, call.request)
	}
	return requests[0], call.body(gotBody)
}

// T5 (docs/provider-engine-contract.md §6.1–6.2): every MCP door that writes a provider also takes
// `engine` and hands it to the server as given — a value, and on the task pins null, which clears only
// the engine pin.
func TestMCPEngineReachesEveryDoorThatTakesIt(t *testing.T) {
	for _, call := range engineDoorCalls(map[string]interface{}{"engine": "dsh", "provider": "deepseek-2"}) {
		t.Run(call.tool, func(t *testing.T) {
			_, body := callEngineDoor(t, call)
			if body["engine"] != "dsh" || body["provider"] != "deepseek-2" {
				t.Fatalf("%s forwarded %#v, want engine dsh on provider deepseek-2", call.tool, body)
			}
		})
	}
	for _, call := range engineDoorCalls(map[string]interface{}{"engine": nil}) {
		if call.tool != "task_update" && call.tool != "task_batch_pin" {
			continue
		}
		t.Run(call.tool+" clears", func(t *testing.T) {
			_, body := callEngineDoor(t, call)
			if engine, present := body["engine"]; !present || engine != nil {
				t.Fatalf("%s engine = %#v (present=%v), want an explicit null", call.tool, engine, present)
			}
		})
	}
}

// The calls written before engines existed name only a provider. They must reach the server exactly
// as they did — no engine at all, not a null one and not a guess — so the server runs each on the
// engine that provider always ran on.
func TestMCPProviderAloneSendsNoEngine(t *testing.T) {
	for _, call := range engineDoorCalls(map[string]interface{}{"provider": "deepseek-2"}) {
		t.Run(call.tool, func(t *testing.T) {
			_, body := callEngineDoor(t, call)
			if body["provider"] != "deepseek-2" {
				t.Fatalf("%s forwarded %#v, want provider deepseek-2", call.tool, body)
			}
			if engine, present := body["engine"]; present {
				t.Fatalf("%s invented an engine: %#v", call.tool, engine)
			}
		})
	}
}

// Each of the five schemas declares `engine` with all six engines, in the CLI names a person knows
// them by; the task pins take null too, since null is how a pin is cleared.
func TestMCPEngineSchemasNameTheSixEngines(t *testing.T) {
	tools := toolDescriptors(false, true)
	batchItem := func() map[string]interface{} {
		props := mcpToolProps(tools, "task_create_batch")
		tasks, _ := props["tasks"].(map[string]interface{})
		items, _ := tasks["items"].(map[string]interface{})
		itemProps, _ := items["properties"].(map[string]interface{})
		return itemProps
	}
	for _, tc := range []struct {
		tool     string
		props    map[string]interface{}
		nullable bool
	}{
		{tool: "session_create", props: mcpToolProps(tools, "session_create")},
		{tool: "task_create", props: mcpToolProps(tools, "task_create"), nullable: true},
		{tool: "task_create_batch item", props: batchItem(), nullable: true},
		{tool: "task_update", props: mcpToolProps(tools, "task_update"), nullable: true},
		{tool: "task_batch_pin", props: mcpToolProps(tools, "task_batch_pin"), nullable: true},
	} {
		t.Run(tc.tool, func(t *testing.T) {
			engine, _ := tc.props["engine"].(map[string]interface{})
			if engine == nil {
				t.Fatalf("%s has no engine property", tc.tool)
			}
			var enum []string
			hasNull := false
			switch values := engine["enum"].(type) {
			case []string:
				enum = values
			case []interface{}:
				for _, value := range values {
					if value == nil {
						hasNull = true
						continue
					}
					enum = append(enum, value.(string))
				}
			}
			if !reflect.DeepEqual(enum, []string{"claude", "codex", "kimi", "antigravity", "opencode", "dsh"}) {
				t.Fatalf("%s engine enum = %#v", tc.tool, engine["enum"])
			}
			if hasNull != tc.nullable {
				t.Fatalf("%s engine enum null = %v, want %v", tc.tool, hasNull, tc.nullable)
			}
			description, _ := engine["description"].(string)
			for _, name := range []string{"Claude Code", "Codex", "Kimi Code", "Antigravity CLI", "OpenCode", "DeepSeek Harness"} {
				if !strings.Contains(description, name) {
					t.Fatalf("%s engine description does not name %s: %q", tc.tool, name, description)
				}
			}
		})
	}
}

// The provider tools and the fields that name a provider describe the split: a provider is where a
// credential comes from, the engine is the CLI, every engine is named, and deleting a key no longer
// claims to move what used it onto the runner's Claude sign-in.
func TestMCPProviderAndAgentDescriptionsFollowTheDecoupledModel(t *testing.T) {
	tools := toolDescriptors(false, true)
	description := func(name string) string {
		for _, tool := range tools {
			if tool["name"] == name {
				text, _ := tool["description"].(string)
				return text
			}
		}
		t.Fatalf("no MCP tool %s", name)
		return ""
	}
	propDescription := func(tool, prop string) string {
		schema, _ := mcpToolProps(tools, tool)[prop].(map[string]interface{})
		text, _ := schema["description"].(string)
		return text
	}

	deletion := description("provider_delete")
	if strings.Contains(deletion, "built-in claude") || strings.Contains(deletion, "runs on the built-in") {
		t.Fatalf("provider_delete still says a deleted key's work moves to Claude: %q", deletion)
	}
	for _, want := range []string{"keep their engine", "cannot start again until it is re-pinned"} {
		if !strings.Contains(deletion, want) {
			t.Fatalf("provider_delete does not say %q: %q", want, deletion)
		}
	}
	list := description("provider_list")
	for _, want := range []string{"`engines`", "credential", "antigravity", "dsh", "DeepSeek Harness on the owner's first enabled DeepSeek key"} {
		if !strings.Contains(list, want) {
			t.Fatalf("provider_list does not say %q: %q", want, list)
		}
	}
	for _, tool := range []string{"provider_create", "provider_update"} {
		schema, _ := mcpToolProps(tools, tool)["runtime"].(map[string]interface{})
		if !reflect.DeepEqual(schema["enum"], []string{"claude", "codex", "kimi", "antigravity"}) {
			t.Fatalf("%s runtime enum = %#v, want the four protocols", tool, schema["enum"])
		}
		if text, _ := schema["description"].(string); !strings.Contains(text, "protocol") || strings.Contains(text, "coding engine that drives it") {
			t.Fatalf("%s runtime is not described as the protocol: %q", tool, text)
		}
	}
	if !strings.Contains(description("provider_update"), "refused while an open session or a task pin uses the key") {
		t.Fatalf("provider_update does not say when a protocol change is refused: %q", description("provider_update"))
	}
	for _, tool := range []string{"task_create", "task_update", "task_batch_pin", "session_create"} {
		text := propDescription(tool, "provider")
		for _, want := range []string{"credential", "\"claude\"", "\"codex\"", "\"kimi\"", "\"antigravity\"", "\"opencode\"", "\"dsh\"", "provider_list"} {
			if !strings.Contains(text, want) {
				t.Fatalf("%s provider description does not say %s: %q", tool, want, text)
			}
		}
	}
	if text := propDescription("task_create", "model"); !strings.Contains(text, "engine and provider") {
		t.Fatalf("task_create model description = %q", text)
	}
	if strings.Contains(taskModelHintDescription, "The engine is still specified with provider") ||
		!strings.Contains(taskModelHintDescription, "engine and provider") {
		t.Fatalf("taskModelHintDescription = %q", taskModelHintDescription)
	}
	if !strings.Contains(description("agent_list"), "lastEngine") {
		t.Fatalf("agent_list does not name the engine the project last ran on: %q", description("agent_list"))
	}
	for _, tool := range []string{"agent_create", "agent_update"} {
		if !strings.Contains(description(tool), "no engine or provider") {
			t.Fatalf("%s does not say an agent has no engine or provider: %q", tool, description(tool))
		}
	}
}
