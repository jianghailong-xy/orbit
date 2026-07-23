package main

import (
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
	for _, name := range []string{"session_create", "session_list", "session_get", "session_send", "session_interrupt"} {
		if !hasMCPTool(on, name) {
			t.Fatalf("%s missing when orchestration enabled", name)
		}
		if hasMCPTool(off, name) {
			t.Fatalf("%s present when orchestration disabled", name)
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
	for _, name := range []string{"session_create", "session_list", "session_get", "session_send", "session_interrupt"} {
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

func hasMCPTool(tools []map[string]interface{}, name string) bool {
	for _, tool := range tools {
		if tool["name"] == name {
			return true
		}
	}
	return false
}
