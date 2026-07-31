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
	for _, name := range []string{"session_create", "session_list", "session_search", "session_get", "session_send", "session_interrupt", "session_merge", "session_end", "agent_list", "agent_create", "agent_update"} {
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
	for _, name := range []string{"session_create", "session_list", "session_search", "session_get", "session_send", "session_interrupt", "session_merge", "session_end", "agent_list", "agent_create", "agent_update"} {
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
	srv := &mcpServer{allowOrchestration: true}
	res := srv.callTool("session_search", map[string]interface{}{})
	if res["isError"] != true {
		t.Fatalf("session_search with no query: isError = %#v", res["isError"])
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
		for _, field := range []string{"env", "permissionMode", "defaultMergeTarget"} {
			if props[field] == nil {
				t.Fatalf("%s inputSchema missing %s", name, field)
			}
		}
		// Still human-only: an agent must not be able to grant orchestration.
		if props["enableOrchestration"] != nil {
			t.Fatalf("%s must not expose enableOrchestration", name)
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

	mcp := &mcpServer{allowOrchestration: true, sessionID: "s1", t: NewTransport(srv.URL, "tok")}
	args := map[string]interface{}{
		"name":               "child",
		"agentId":            "a1",
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
		if gotBody["permissionMode"] != "acceptEdits" {
			t.Fatalf("%s body permissionMode = %#v", name, gotBody["permissionMode"])
		}
		if gotBody["defaultMergeTarget"] != "develop" {
			t.Fatalf("%s body defaultMergeTarget = %#v", name, gotBody["defaultMergeTarget"])
		}
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
