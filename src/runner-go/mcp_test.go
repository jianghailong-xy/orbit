package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
	for _, name := range []string{"session_create", "session_list", "session_search", "session_get", "session_send", "session_interrupt", "session_merge", "session_end", "session_complete", "agent_list", "agent_create", "agent_update"} {
		if !hasMCPTool(on, name) {
			t.Fatalf("%s missing when orchestration enabled", name)
		}
		if hasMCPTool(off, name) {
			t.Fatalf("%s present when orchestration disabled", name)
		}
	}
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

	var gotMethod, gotPath, gotAgent string
	var gotBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotAgent = r.Header.Get("X-Orbit-Agent-Id")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`[{"id":"t1","ref":"s0"},{"id":"t2"}]`))
	}))
	defer srv.Close()

	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create_batch", map[string]interface{}{
		"tasks": []interface{}{
			map[string]interface{}{"title": "first", "ref": "s0"},
			map[string]interface{}{"title": "second", "dependsOnRefs": []interface{}{"s0"}, "assigneeId": nil},
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
	for _, name := range []string{"session_create", "session_list", "session_search", "session_get", "session_send", "session_interrupt", "session_merge", "session_end", "session_complete", "agent_list", "agent_create", "agent_update"} {
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
	for _, want := range []string{"default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"} {
		found := false
		for _, mode := range offered {
			found = found || mode == want
		}
		if !found {
			t.Fatalf("session_create permissionMode enum %#v is missing %q", offered, want)
		}
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
