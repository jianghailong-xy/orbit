package main

import "testing"

func TestNormalizeCodexReasoningEffort(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "empty", in: "", want: ""},
		{name: "max maps to xhigh", in: "max", want: "xhigh"},
		{name: "xhigh passes through", in: "xhigh", want: "xhigh"},
		{name: "minimal passes through", in: "minimal", want: "minimal"},
		{name: "unknown falls back to default", in: "ultra", want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizeCodexReasoningEffort(tt.in); got != tt.want {
				t.Fatalf("normalizeCodexReasoningEffort(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestCodexAppServerThreadParams(t *testing.T) {
	job := &ClaimedSession{Agent: AgentExecConfig{Model: "gpt-5.5"}}
	got := codexThreadParams(job, "/repo", "/tmp/uploads")
	if got["cwd"] != "/repo" {
		t.Fatalf("cwd = %v", got["cwd"])
	}
	if got["model"] != "gpt-5.5" {
		t.Fatalf("model = %v", got["model"])
	}
	if got["approvalPolicy"] != "never" {
		t.Fatalf("approvalPolicy = %v", got["approvalPolicy"])
	}
	if got["sandbox"] != "workspace-write" {
		t.Fatalf("sandbox = %v", got["sandbox"])
	}
	roots, ok := got["runtimeWorkspaceRoots"].([]string)
	if !ok || len(roots) != 2 || roots[0] != "/repo" || roots[1] != "/tmp/uploads" {
		t.Fatalf("runtimeWorkspaceRoots = %#v", got["runtimeWorkspaceRoots"])
	}
}

func TestCodexAppServerIDExtraction(t *testing.T) {
	result := map[string]interface{}{
		"thread": map[string]interface{}{"id": "thread-1"},
		"turn":   map[string]interface{}{"id": "turn-1"},
	}
	if got := threadIDFromResult(result); got != "thread-1" {
		t.Fatalf("threadIDFromResult = %q", got)
	}
	if got := turnIDFromResult(result); got != "turn-1" {
		t.Fatalf("turnIDFromResult = %q", got)
	}
}

func TestCodexAppServerTurnParams(t *testing.T) {
	job := &ClaimedSession{Agent: AgentExecConfig{Model: "gpt-5.5", Effort: "max"}}
	got := codexTurnParams("thread-1", job, "/repo", "/tmp/uploads", "orbit-turn-1", "hello", []string{"/tmp/a.png"})
	if got["threadId"] != "thread-1" {
		t.Fatalf("threadId = %v", got["threadId"])
	}
	if got["clientUserMessageId"] != "orbit-turn-1" {
		t.Fatalf("clientUserMessageId = %v", got["clientUserMessageId"])
	}
	if got["effort"] != "xhigh" {
		t.Fatalf("effort = %v", got["effort"])
	}
	input, ok := got["input"].([]map[string]interface{})
	if !ok || len(input) != 2 || input[0]["type"] != "text" || input[1]["type"] != "localImage" {
		t.Fatalf("input = %#v", got["input"])
	}
	sandbox, ok := got["sandboxPolicy"].(map[string]interface{})
	if !ok || sandbox["type"] != "workspaceWrite" || sandbox["networkAccess"] != false {
		t.Fatalf("sandboxPolicy = %#v", got["sandboxPolicy"])
	}
	roots, ok := sandbox["writableRoots"].([]string)
	if !ok || len(roots) != 1 || roots[0] != "/tmp/uploads" {
		t.Fatalf("writableRoots = %#v", sandbox["writableRoots"])
	}
}
