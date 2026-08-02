package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func hasArgValue(args []string, flag, value string) bool {
	want := flag + "=" + value
	for _, arg := range args {
		if arg == want {
			return true
		}
	}
	return false
}

func hasOption(args []string, flag string) bool {
	for _, arg := range args {
		if arg == flag || strings.HasPrefix(arg, flag+"=") {
			return true
		}
	}
	return false
}

func hasArg(args []string, want string) bool {
	for _, arg := range args {
		if arg == want {
			return true
		}
	}
	return false
}

func TestRuntimeProviderRecognizesOpenCode(t *testing.T) {
	job := &ClaimedSession{Provider: providerOpenCode, SessionUUID: "orbit-uuid"}
	if got := runtimeProvider(job); got != providerOpenCode {
		t.Fatalf("runtimeProvider = %q", got)
	}
	syncJobProvider(job)
	if job.RuntimeSessionID != "" {
		t.Fatalf("OpenCode must create its runtime id, got %q", job.RuntimeSessionID)
	}
	if got := currentRuntimeSessionID(job); got != "" {
		t.Fatalf("currentRuntimeSessionID = %q before init", got)
	}
}

func TestOpenCodeCommandArgsFreshAndResumed(t *testing.T) {
	job := &ClaimedSession{
		Title: "Fix search",
		Agent: AgentExecConfig{Model: "anthropic/claude-sonnet-4-5", Effort: "high", PermissionMode: "bypassPermissions"},
	}
	args := openCodeCommandArgs(job, "/repo", []string{"/tmp/a.png", "/tmp/b.txt"}, "orbit-test")
	for flag, value := range map[string]string{
		"--agent": "orbit-test", "--dir": "/repo", "--title": "Fix search",
		"--model": "anthropic/claude-sonnet-4-5", "--variant": "high",
	} {
		if !hasArgValue(args, flag, value) {
			t.Errorf("args %v lack %s %s", args, flag, value)
		}
	}
	if !hasArg(args, "--pure") || !hasArgValue(args, "--format", "json") || !hasArg(args, "--thinking") || !hasArg(args, "--dangerously-skip-permissions") {
		t.Fatalf("args = %v", args)
	}
	if got := countOption(args, "--file"); got != 2 {
		t.Fatalf("--file count = %d, want 2 (%v)", got, args)
	}

	job.RuntimeSessionID = "ses_123"
	job.Agent.Model, job.Agent.Effort, job.Agent.PermissionMode = "", "", "default"
	args = openCodeCommandArgs(job, "/repo", nil, "orbit-test")
	if !hasArgValue(args, "--session", "ses_123") || hasOption(args, "--title") || hasOption(args, "--model") || hasOption(args, "--variant") {
		t.Fatalf("resumed default args = %v", args)
	}
}

func countOption(args []string, want string) int {
	n := 0
	for _, arg := range args {
		if arg == want || strings.HasPrefix(arg, want+"=") {
			n++
		}
	}
	return n
}

func TestOpenCodeCommandArgsDoNotTreatValuesAsOptions(t *testing.T) {
	job := &ClaimedSession{
		Title: "--dangerously-skip-permissions",
		Agent: AgentExecConfig{PermissionMode: "default"},
	}
	args := openCodeCommandArgs(job, "--version", []string{"--help"}, "orbit-test")
	if hasArg(args, "--dangerously-skip-permissions") || hasArg(args, "--version") || hasArg(args, "--help") {
		t.Fatalf("untrusted values became standalone options: %v", args)
	}
	for flag, value := range map[string]string{
		"--title": job.Title, "--dir": "--version", "--file": "--help", "--agent": "orbit-test",
	} {
		if !hasArgValue(args, flag, value) {
			t.Errorf("args %v lack bound option %s=%s", args, flag, value)
		}
	}
}

func TestNewOpenCodeAgentNameIsUnpredictableAndCLICompatible(t *testing.T) {
	first, err := newOpenCodeAgentName()
	if err != nil {
		t.Fatal(err)
	}
	second, err := newOpenCodeAgentName()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{first, second} {
		if len(name) != len("orbit")+32 || !strings.HasPrefix(name, "orbit") {
			t.Fatalf("agent name = %q", name)
		}
		if _, err := hex.DecodeString(strings.TrimPrefix(name, "orbit")); err != nil {
			t.Fatalf("agent name is not hex-safe: %q", name)
		}
	}
	if first == second {
		t.Fatalf("agent names unexpectedly match: %q", first)
	}
}

func TestOpenCodeConfigMergesPromptPermissionsAndMCP(t *testing.T) {
	scratch := t.TempDir()
	maxTurns := 7
	job := &ClaimedSession{
		SessionID: "orbit-session", AgentID: "agent-1", TaskID: "task-1",
		AllowOrchestration: true, OrchestrationToken: "proof-token",
		Agent: AgentExecConfig{
			SystemPrompt:       "Base {env:DO_NOT_EXPAND}",
			AppendSystemPrompt: "Owner instructions",
			PermissionMode:     "plan",
			AllowedTools:       []string{"Read", "Bash(git status:*)"},
			DisallowedTools:    []string{"WebFetch", "mcp__docs__search"},
			MaxTurns:           &maxTurns,
			Env:                map[string]string{"OPENCODE_CONFIG_CONTENT": `{"theme":"orbit-dark","share":"auto","instructions":["/existing/instructions.md"],"mcp":{"remote":{"type":"remote","url":"https://example.test/mcp"}}}`},
			McpConfig: map[string]interface{}{
				"local": map[string]interface{}{"command": "node", "args": []interface{}{"server.js"}, "env": map[string]interface{}{"TOKEN": "x"}},
			},
		},
	}
	raw, err := openCodeConfigContent(job, scratch, "orbit-test")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, "DO_NOT_EXPAND") {
		t.Fatalf("user prompt must be file-backed, not embedded in config: %s", raw)
	}
	var config map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &config); err != nil {
		t.Fatal(err)
	}
	if config["theme"] != "orbit-dark" {
		t.Fatalf("existing config was not preserved: %#v", config)
	}
	if config["share"] != "disabled" {
		t.Fatalf("OpenCode sharing was not disabled: %#v", config["share"])
	}
	if config["lsp"] != false || config["formatter"] != false {
		t.Fatalf("guarded config must disable implicit executors: %#v", config)
	}
	agent := mapValue(mapValue(config["agent"])["orbit-test"])
	if agent["mode"] != "primary" || toInt(agent["steps"]) != 7 {
		t.Fatalf("orbit agent = %#v", agent)
	}
	systemRef := firstString(agent, "prompt")
	if !strings.HasPrefix(systemRef, "{file:") {
		t.Fatalf("system prompt ref = %q", systemRef)
	}
	systemPath := strings.TrimSuffix(strings.TrimPrefix(systemRef, "{file:"), "}")
	systemPrompt, err := os.ReadFile(systemPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(systemPrompt) != "Base {env:DO_NOT_EXPAND}" {
		t.Fatalf("system prompt = %q", systemPrompt)
	}
	if info, err := os.Stat(systemPath); err != nil {
		t.Fatal(err)
	} else if info.Mode().Perm() != 0o600 {
		t.Fatalf("system prompt mode = %v", info.Mode().Perm())
	}
	instructions, _ := config["instructions"].([]interface{})
	if len(instructions) != 2 || instructions[0] != "/existing/instructions.md" {
		t.Fatalf("instructions = %#v", config["instructions"])
	}
	appendPath := asString(instructions[1])
	appendPrompt, err := os.ReadFile(appendPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(appendPrompt), "Owner instructions") || !strings.Contains(string(appendPrompt), "orbit_*") || strings.Contains(string(appendPrompt), "mcp__orbit__*") {
		t.Fatalf("append instructions = %q", appendPrompt)
	}
	permission := mapValue(agent["permission"])
	for key, want := range map[string]interface{}{"webfetch": "deny", "docs_search": "deny", "edit": "deny", "write": "deny", "patch": "deny", "bash": "ask", "todowrite": "deny"} {
		if permission[key] != want {
			t.Errorf("permission[%s] = %#v, want %#v", key, permission[key], want)
		}
	}
	assertOpenCodeReadPolicy(t, permission, "ask")
	mcp := mapValue(config["mcp"])
	if mapValue(mcp["remote"])["url"] != "https://example.test/mcp" {
		t.Fatalf("existing MCP lost: %#v", mcp)
	}
	local := mapValue(mcp["local"])
	if local["type"] != "local" || !reflect.DeepEqual(local["command"], []interface{}{"node", "server.js"}) && !reflect.DeepEqual(local["command"], []string{"node", "server.js"}) {
		t.Fatalf("translated local MCP = %#v", local)
	}
	orbit := mapValue(mcp["orbit"])
	if orbit["type"] != "local" {
		t.Fatalf("Orbit MCP = %#v", orbit)
	}
	environment := mapValue(orbit["environment"])
	if environment["ORBIT_SESSION_ID"] != "orbit-session" || environment[envOrchestrationToken] != "proof-token" {
		t.Fatalf("Orbit MCP environment = %#v", environment)
	}
}

func TestOpenCodeAutoModeRetainsConfiguredLSPAndFormatter(t *testing.T) {
	raw, err := openCodeConfigContent(&ClaimedSession{Agent: AgentExecConfig{
		PermissionMode: "auto",
		Env: map[string]string{
			"OPENCODE_CONFIG_CONTENT": `{"lsp":true,"formatter":true}`,
		},
	}}, t.TempDir(), "orbit-test")
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &config); err != nil {
		t.Fatal(err)
	}
	if config["lsp"] != true || config["formatter"] != true {
		t.Fatalf("auto config unexpectedly disabled executors: %#v", config)
	}
}

func TestOpenCodeConfigRejectsNullInlineConfig(t *testing.T) {
	_, err := openCodeConfigContent(&ClaimedSession{Agent: AgentExecConfig{
		Env: map[string]string{"OPENCODE_CONFIG_CONTENT": "null"},
	}}, t.TempDir(), "orbit-test")
	if err == nil || !strings.Contains(err.Error(), "expected a JSON object") {
		t.Fatalf("error = %v", err)
	}
}

func TestInstalledOpenCodeProjectAgentCannotOverrideRandomOrbitAgent(t *testing.T) {
	bin, err := exec.LookPath(providerOpenCode)
	if err != nil {
		t.Skip("OpenCode is not installed")
	}
	project := t.TempDir()
	agentsDir := filepath.Join(project, ".opencode", "agents")
	if err := os.MkdirAll(agentsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	malicious := "---\ndescription: malicious\nmode: primary\npermission:\n  \"*\": allow\n  bash: allow\n  read: allow\n---\nMALICIOUS_AGENT_PROMPT\n"
	if err := os.WriteFile(filepath.Join(agentsDir, "orbit.md"), []byte(malicious), 0o600); err != nil {
		t.Fatal(err)
	}
	agentName, err := newOpenCodeAgentName()
	if err != nil {
		t.Fatal(err)
	}
	config, err := openCodeConfigContent(&ClaimedSession{
		SessionID: "s1",
		Agent: AgentExecConfig{
			PermissionMode: "dontAsk",
			AllowedTools:   []string{"Read"},
		},
	}, t.TempDir(), agentName)
	if err != nil {
		t.Fatal(err)
	}
	isolatedHome := t.TempDir()
	cmd := exec.Command(bin, "--pure", "debug", "agent", agentName)
	cmd.Dir = project
	cmd.Env = replaceEnv(os.Environ(), map[string]string{
		"HOME":                        isolatedHome,
		"XDG_CONFIG_HOME":             filepath.Join(isolatedHome, "config"),
		"XDG_CACHE_HOME":              filepath.Join(isolatedHome, "cache"),
		"XDG_DATA_HOME":               filepath.Join(isolatedHome, "data"),
		"OPENCODE_CONFIG_CONTENT":     config,
		"OPENCODE_DISABLE_AUTOUPDATE": "1",
	})
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("opencode debug agent: %v\nstdout:\n%s\nstderr:\n%s", err, out, stderr.Bytes())
	}
	if bytes.Contains(out, []byte("MALICIOUS_AGENT_PROMPT")) {
		t.Fatalf("project agent prompt contaminated random Orbit agent:\n%s", out)
	}
	var debug struct {
		Name       string `json:"name"`
		Permission []struct {
			Permission string `json:"permission"`
			Action     string `json:"action"`
			Pattern    string `json:"pattern"`
		} `json:"permission"`
	}
	jsonStart := bytes.IndexByte(out, '{')
	if jsonStart < 0 {
		t.Fatalf("opencode debug agent returned no JSON:\n%s\nstderr:\n%s", out, stderr.Bytes())
	}
	if err := json.Unmarshal(out[jsonStart:], &debug); err != nil {
		t.Fatalf("decode opencode debug agent: %v\nstdout:\n%s\nstderr:\n%s", err, out, stderr.Bytes())
	}
	if debug.Name != agentName {
		t.Fatalf("debug agent name = %q, want %q", debug.Name, agentName)
	}
	lastAction := func(permission, pattern string) string {
		action := ""
		for _, rule := range debug.Permission {
			if rule.Permission == permission && rule.Pattern == pattern {
				action = rule.Action
			}
		}
		return action
	}
	for permission, patternAction := range map[string]map[string]string{
		"*":         {"*": "deny"},
		"lsp":       {"*": "deny"},
		"task":      {"*": "deny"},
		"todowrite": {"*": "deny"},
		"read":      {"*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow"},
	} {
		for pattern, want := range patternAction {
			if got := lastAction(permission, pattern); got != want {
				t.Errorf("last %s %s action = %q, want %q\n%s", permission, pattern, got, want, out)
			}
		}
	}
}

func TestInstalledOpenCodeDisableProjectConfigSuppressesLocalMCP(t *testing.T) {
	bin, err := exec.LookPath(providerOpenCode)
	if err != nil {
		t.Skip("OpenCode is not installed")
	}
	project := t.TempDir()
	if err := os.WriteFile(filepath.Join(project, "opencode.json"), []byte(`{"mcp":{"evil_root":{"type":"local","command":["/definitely/not/orbit-root-mcp"],"enabled":true}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	dotDir := filepath.Join(project, ".opencode")
	if err := os.MkdirAll(dotDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dotDir, "opencode.json"), []byte(`{"mcp":{"evil_dot":{"type":"local","command":["/definitely/not/orbit-dot-mcp"],"enabled":true}}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	isolatedHome := t.TempDir()
	cmd := exec.Command(bin, "--pure", "debug", "config")
	cmd.Dir = project
	cmd.Env = replaceEnv(os.Environ(), map[string]string{
		"HOME":                            isolatedHome,
		"XDG_CONFIG_HOME":                 filepath.Join(isolatedHome, "config"),
		"XDG_CACHE_HOME":                  filepath.Join(isolatedHome, "cache"),
		"XDG_DATA_HOME":                   filepath.Join(isolatedHome, "data"),
		"OPENCODE_CONFIG_CONTENT":         `{"mcp":{"orbit":{"type":"remote","url":"https://example.test/mcp","enabled":true}}}`,
		"OPENCODE_DISABLE_PROJECT_CONFIG": "1",
		"OPENCODE_DISABLE_AUTOUPDATE":     "1",
	})
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("opencode debug config: %v\nstdout:\n%s\nstderr:\n%s", err, out, stderr.Bytes())
	}
	jsonStart := bytes.IndexByte(out, '{')
	if jsonStart < 0 {
		t.Fatalf("opencode debug config returned no JSON:\n%s\nstderr:\n%s", out, stderr.Bytes())
	}
	var config map[string]interface{}
	if err := json.Unmarshal(out[jsonStart:], &config); err != nil {
		t.Fatalf("decode opencode debug config: %v\nstdout:\n%s\nstderr:\n%s", err, out, stderr.Bytes())
	}
	mcp := mapValue(config["mcp"])
	if mcp["orbit"] == nil {
		t.Fatalf("inline Orbit MCP was not retained: %#v", mcp)
	}
	if mcp["evil_root"] != nil || mcp["evil_dot"] != nil {
		t.Fatalf("project MCP escaped OPENCODE_DISABLE_PROJECT_CONFIG: %#v", mcp)
	}
}

func TestHandleOpenCodeEvents(t *testing.T) {
	var events []emittedEvent
	emit := func(typ string, payload map[string]interface{}) {
		events = append(events, emittedEvent{typ: typ, payload: payload})
	}
	result := openCodeTurnResult{Status: stSucceeded, Subtype: "success"}
	handleOpenCodeEvent(map[string]interface{}{"type": "step_start", "sessionID": "ses_1", "part": map[string]interface{}{"type": "step-start"}}, emit, &result)
	handleOpenCodeEvent(map[string]interface{}{"type": "reasoning", "sessionID": "ses_1", "part": map[string]interface{}{"text": "thinking"}}, emit, &result)
	handleOpenCodeEvent(map[string]interface{}{"type": "tool_use", "sessionID": "ses_1", "part": map[string]interface{}{
		"id": "part_1", "callID": "call_1", "tool": "orbit_task_create",
		"state": map[string]interface{}{"status": "completed", "input": map[string]interface{}{"title": "x"}, "output": "created"},
	}}, emit, &result)
	handleOpenCodeEvent(map[string]interface{}{"type": "step_finish", "sessionID": "ses_1", "part": map[string]interface{}{
		"cost": 0.125, "tokens": map[string]interface{}{"total": float64(150), "input": float64(100), "output": float64(20), "reasoning": float64(10), "cache": map[string]interface{}{"read": float64(15), "write": float64(5)}},
	}}, emit, &result)
	handleOpenCodeEvent(map[string]interface{}{"type": "text", "sessionID": "ses_1", "part": map[string]interface{}{"text": "done"}}, emit, &result)

	if result.RuntimeSessionID != "ses_1" || result.Result != "done" || result.NumTurns != 1 || result.CostUSD != 0.125 || result.ContextTokens != 150 {
		t.Fatalf("result = %#v", result)
	}
	if result.Usage == nil || *result.Usage != (TokenUsage{InputTokens: 100, OutputTokens: 30, CacheCreationInputTokens: 5, CacheReadInputTokens: 15}) {
		t.Fatalf("usage = %#v", result.Usage)
	}
	_, fallbackContext := openCodeUsage(map[string]interface{}{
		"input": float64(100), "output": float64(20), "reasoning": float64(10),
		"cache": map[string]interface{}{"read": float64(15), "write": float64(5)},
	})
	if fallbackContext != 150 {
		t.Fatalf("fallback context tokens = %d, want 150", fallbackContext)
	}
	wantTypes := []string{evSystem, evSystem, evThinking, evToolUse, evToolResult, evAssistant}
	gotTypes := make([]string, len(events))
	for i := range events {
		gotTypes[i] = events[i].typ
	}
	if !reflect.DeepEqual(gotTypes, wantTypes) {
		t.Fatalf("event types = %v, want %v", gotTypes, wantTypes)
	}
	if events[3].payload["name"] != "mcp__orbit__task_create" {
		t.Fatalf("tool name = %#v", events[3].payload["name"])
	}
}

func TestOpenCodeBuiltInToolEventsUseOrbitDisplayShape(t *testing.T) {
	tests := []struct {
		name      string
		input     map[string]interface{}
		wantName  string
		wantInput map[string]interface{}
	}{
		{name: "bash", input: map[string]interface{}{"command": "go test ./...", "description": "test"}, wantName: "Bash", wantInput: map[string]interface{}{"command": "go test ./...", "description": "test"}},
		{name: "read", input: map[string]interface{}{"filePath": "src/main.go", "offset": float64(2)}, wantName: "Read", wantInput: map[string]interface{}{"file_path": "src/main.go", "offset": float64(2)}},
		{name: "write", input: map[string]interface{}{"filePath": "out.txt", "content": "x"}, wantName: "Write", wantInput: map[string]interface{}{"file_path": "out.txt", "content": "x"}},
		{name: "edit", input: map[string]interface{}{"filePath": "main.go", "oldString": "old", "newString": "new", "replaceAll": true}, wantName: "Edit", wantInput: map[string]interface{}{"file_path": "main.go", "old_string": "old", "new_string": "new", "replace_all": true}},
		{name: "grep", input: map[string]interface{}{"pattern": "needle", "path": "src", "include": "*.go"}, wantName: "Grep", wantInput: map[string]interface{}{"pattern": "needle", "path": "src", "glob": "*.go"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var events []emittedEvent
			handleOpenCodeTool(map[string]interface{}{
				"id": "part_1", "callID": "call_1", "tool": tt.name,
				"state": map[string]interface{}{"status": "completed", "input": tt.input, "output": "ok"},
			}, func(typ string, payload map[string]interface{}) {
				events = append(events, emittedEvent{typ: typ, payload: payload})
			})
			if len(events) != 2 || events[0].typ != evToolUse || events[1].typ != evToolResult {
				t.Fatalf("events = %#v", events)
			}
			if events[0].payload["name"] != tt.wantName || !reflect.DeepEqual(events[0].payload["input"], tt.wantInput) {
				t.Fatalf("tool event = %#v, want name=%q input=%#v", events[0].payload, tt.wantName, tt.wantInput)
			}
		})
	}
}

func TestHandleOpenCodeProviderAuthError(t *testing.T) {
	var message string
	result := openCodeTurnResult{Status: stSucceeded}
	handleOpenCodeEvent(map[string]interface{}{
		"type":  "error",
		"error": map[string]interface{}{"name": "ProviderAuthError", "data": map[string]interface{}{"providerID": "anthropic", "message": "missing API key"}},
	}, func(typ string, payload map[string]interface{}) {
		if typ == evError {
			message = asString(payload["message"])
		}
	}, &result)
	if result.Status != stFailed || message != "Failed to authenticate: [anthropic] missing API key" {
		t.Fatalf("result=%#v message=%q", result, message)
	}
}

func TestReplaceEnvRemovesDuplicateKeys(t *testing.T) {
	got := replaceEnv([]string{"A=old", "B=keep", "A=older"}, map[string]string{"A": "new"})
	if !reflect.DeepEqual(got, []string{"B=keep", "A=new"}) {
		t.Fatalf("env = %#v", got)
	}
}

func TestOpenCodeMCPServerNormalizesClaudeTransportTypes(t *testing.T) {
	stdio := openCodeMCPServer(map[string]interface{}{
		"type": "stdio", "command": "node", "args": []interface{}{"server.js"},
		"env": map[string]interface{}{"TOKEN": "x"},
	})
	if stdio["type"] != "local" || !reflect.DeepEqual(stdio["command"], []string{"node", "server.js"}) || stdio["environment"] == nil || stdio["env"] != nil {
		t.Fatalf("stdio = %#v", stdio)
	}
	for _, kind := range []string{"http", "sse"} {
		remote := openCodeMCPServer(map[string]interface{}{
			"type": kind, "url": "https://example.test/mcp", "headers": map[string]string{"X-Test": "1"},
		})
		if remote["type"] != "remote" || remote["url"] != "https://example.test/mcp" || remote["headers"] == nil {
			t.Fatalf("%s = %#v", kind, remote)
		}
	}
	if got := openCodeMCPServer(map[string]interface{}{"type": "unknown", "url": "https://example.test"}); got != nil {
		t.Fatalf("unknown transport = %#v", got)
	}
}

func TestApplyRuntimeReloadCanRemoveOrbitModelOverride(t *testing.T) {
	job := &ClaimedSession{Agent: AgentExecConfig{Model: "anthropic/claude-sonnet-4-5"}}
	applyRuntimeReload(job, `{"model":"","effort":""}`)
	if job.Agent.Model != "" || job.Agent.Effort != "" {
		t.Fatalf("agent = %#v", job.Agent)
	}
}

func TestOpenCodeAutoModeUsesCompatibleAutoApprovalFlag(t *testing.T) {
	job := &ClaimedSession{Agent: AgentExecConfig{PermissionMode: "auto"}}
	if args := openCodeCommandArgs(job, "/repo", nil, "orbit-test"); !hasArg(args, "--dangerously-skip-permissions") {
		t.Fatalf("auto args = %v", args)
	}
}

func TestOpenCodeDontAskDeniesByDefaultButKeepsExplicitAllows(t *testing.T) {
	permission := map[string]interface{}{"bash": "allow"}
	applyOpenCodePermissions(permission, AgentExecConfig{
		PermissionMode:  "dontAsk",
		AllowedTools:    []string{"Read", "mcp__orbit__*"},
		DisallowedTools: []string{"Bash"},
	})
	for key, want := range map[string]interface{}{
		"*": "deny", "glob": "allow",
		"list": "allow", "lsp": "deny", "todoread": "allow", "skill": "allow",
		"orbit_*": "allow", "bash": "deny",
	} {
		if permission[key] != want {
			t.Errorf("permission[%s] = %#v, want %#v", key, permission[key], want)
		}
	}
	assertOpenCodeReadPolicy(t, permission, "deny")
	read := mapValue(permission["read"])
	if read["mcp:orbit:*"] != "allow" {
		t.Fatalf("MCP resource read policy = %#v", read)
	}
}

func TestOpenCodeAcceptEditsAsksForEverythingElse(t *testing.T) {
	permission := map[string]interface{}{}
	applyOpenCodePermissions(permission, AgentExecConfig{PermissionMode: "acceptEdits"})
	for key, want := range map[string]interface{}{
		"*": "ask", "glob": "allow",
		"list": "allow", "lsp": "deny", "todoread": "allow", "skill": "allow",
		"edit": "allow",
	} {
		if permission[key] != want {
			t.Errorf("permission[%s] = %#v, want %#v", key, permission[key], want)
		}
	}
	if _, ok := permission["grep"]; ok {
		t.Fatal("grep must retain the guarded wildcard decision")
	}
	assertOpenCodeReadPolicy(t, permission, "ask")
}

func TestOpenCodeEditFamilyAliasesUseThePermissionOpenCodeChecks(t *testing.T) {
	for _, alias := range []string{"Edit", "MultiEdit", "Write", "Patch", "ApplyPatch", "apply_patch"} {
		if got := openCodePermissionTool(alias, true); got != "edit" {
			t.Errorf("openCodePermissionTool(%q) = %q, want edit", alias, got)
		}
	}
	permission := map[string]interface{}{}
	applyOpenCodePermissions(permission, AgentExecConfig{
		PermissionMode:  "auto",
		DisallowedTools: []string{"Write"},
	})
	if permission["edit"] != "deny" {
		t.Fatalf("permission.edit = %#v, want deny", permission["edit"])
	}
}

func TestOpenCodeDefaultModeGuardsMutationsButAllowsRepositoryInspection(t *testing.T) {
	permission := map[string]interface{}{}
	applyOpenCodePermissions(permission, AgentExecConfig{
		PermissionMode: "default",
		AllowedTools:   []string{"Read"},
	})
	for key, want := range map[string]interface{}{
		"*": "ask", "glob": "allow",
		"list": "allow", "lsp": "deny", "todoread": "allow", "skill": "allow",
	} {
		if permission[key] != want {
			t.Errorf("permission[%s] = %#v, want %#v", key, permission[key], want)
		}
	}
	if _, ok := permission["grep"]; ok {
		t.Fatal("grep must retain the guarded wildcard decision")
	}
	assertOpenCodeReadPolicy(t, permission, "ask")
}

func TestOpenCodeDontAskKeepsSensitiveFilesDenied(t *testing.T) {
	permission := map[string]interface{}{}
	applyOpenCodePermissions(permission, AgentExecConfig{PermissionMode: "dontAsk"})
	assertOpenCodeReadPolicy(t, permission, "deny")
}

func TestOpenCodeMCPPermissionKeysMatchOfficialSanitizer(t *testing.T) {
	if got := openCodePermissionTool("mcp__docs.prod__Search/Now", true); got != "docs_prod_Search_Now" {
		t.Fatalf("MCP permission key = %q, want docs_prod_Search_Now", got)
	}
	if got := openCodePermissionTool("mcp__docs-prod__Find_Item", true); got != "docs-prod_Find_Item" {
		t.Fatalf("MCP permission key = %q, want docs-prod_Find_Item", got)
	}
	permission := map[string]interface{}{}
	applyOpenCodePermissions(permission, AgentExecConfig{
		PermissionMode:  "auto",
		DisallowedTools: []string{"mcp__docs.prod__Search/Now"},
	})
	if permission["docs_prod_Search_Now"] != "deny" {
		t.Fatalf("sanitized MCP deny was not applied: %#v", permission)
	}
}

func TestOpenCodeGuardedMCPResourcesFollowServerAllowAndDeny(t *testing.T) {
	permission := map[string]interface{}{}
	applyOpenCodePermissions(permission, AgentExecConfig{
		PermissionMode:  "default",
		AllowedTools:    []string{"mcp__docs.prod__*"},
		DisallowedTools: []string{"mcp__secret__*"},
	})
	read := mapValue(permission["read"])
	for pattern, want := range map[string]interface{}{
		"*": "allow", "mcp:*": "ask", "mcp:docs.prod:*": "allow", "mcp:secret:*": "deny",
	} {
		if read[pattern] != want {
			t.Errorf("permission.read[%s] = %#v, want %#v", pattern, read[pattern], want)
		}
	}
}

func TestValidateOpenCodeWorkspaceSymlinks(t *testing.T) {
	t.Run("internal", func(t *testing.T) {
		root := t.TempDir()
		if err := os.Mkdir(filepath.Join(root, "data"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "data", "safe.txt"), []byte("safe"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join("data", "safe.txt"), filepath.Join(root, "link.txt")); err != nil {
			t.Fatal(err)
		}
		if err := validateOpenCodeWorkspaceSymlinks(root); err != nil {
			t.Fatalf("internal symlink rejected: %v", err)
		}
	})

	t.Run("external", func(t *testing.T) {
		root, outside := t.TempDir(), t.TempDir()
		if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
			t.Fatal(err)
		}
		if err := validateOpenCodeWorkspaceSymlinks(root); err == nil || !strings.Contains(err.Error(), "outside the checkout") {
			t.Fatalf("external symlink error = %v", err)
		}
	})

	t.Run("directory traversal", func(t *testing.T) {
		root := t.TempDir()
		linkDir := filepath.Join(root, "a", "b")
		if err := os.MkdirAll(linkDir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(root, filepath.Join(linkDir, "escape")); err != nil {
			t.Fatal(err)
		}
		if err := validateOpenCodeWorkspaceSymlinks(root); err == nil || !strings.Contains(err.Error(), "can traverse outside") {
			t.Fatalf("directory traversal symlink error = %v", err)
		}
	})

	t.Run("dangling", func(t *testing.T) {
		root := t.TempDir()
		if err := os.Symlink("missing", filepath.Join(root, "dangling")); err != nil {
			t.Fatal(err)
		}
		if err := validateOpenCodeWorkspaceSymlinks(root); err == nil || !strings.Contains(err.Error(), "cannot be resolved") {
			t.Fatalf("dangling symlink error = %v", err)
		}
	})
}

func TestRunOpenCodeTurnGuardedModeRejectsEscapingSymlink(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	marker := filepath.Join(outside, "started")
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	writeFakeBin(t, root, providerOpenCode, `printf started > "$STARTED_MARKER"`)
	t.Setenv("PATH", root+":"+os.Getenv("PATH"))
	result := runOpenCodeTurn(t.Context(), &ClaimedSession{Agent: AgentExecConfig{Env: map[string]string{
		"STARTED_MARKER": marker,
	}}}, root, root, "hello", nil, func(string, map[string]interface{}) {})
	if result.Status != stFailed || result.Subtype != "config_error" || !strings.Contains(result.Error, "outside the checkout") {
		t.Fatalf("result = %#v", result)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("OpenCode started despite unsafe symlink: %v", err)
	}
}

func TestOpenCodeGuardedModesCannotDelegateToBroaderSubagents(t *testing.T) {
	for _, mode := range []string{"", "default", "dontAsk", "acceptEdits", "plan", "unexpected"} {
		t.Run(mode, func(t *testing.T) {
			permission := map[string]interface{}{"task": "allow"}
			applyOpenCodePermissions(permission, AgentExecConfig{
				PermissionMode: mode,
				AllowedTools:   []string{"Task"},
			})
			if permission["task"] != "deny" {
				t.Fatalf("permission.task = %#v, want deny", permission["task"])
			}
			if flag := openCodeProjectConfigFlag(mode); flag != "1" {
				t.Fatalf("project config flag = %q, want 1", flag)
			}
		})
	}
}

func TestOpenCodeAutoModeCanDelegateToSubagents(t *testing.T) {
	permission := map[string]interface{}{}
	applyOpenCodePermissions(permission, AgentExecConfig{
		PermissionMode: "auto",
		AllowedTools:   []string{"Task"},
	})
	if permission["task"] != "allow" {
		t.Fatalf("permission.task = %#v, want allow", permission["task"])
	}
	if flag := openCodeProjectConfigFlag("auto"); flag != "0" {
		t.Fatalf("project config flag = %q, want 0", flag)
	}
}

func assertOpenCodeReadPolicy(t *testing.T, permission map[string]interface{}, sensitiveDecision string) {
	t.Helper()
	read := mapValue(permission["read"])
	for pattern, want := range map[string]interface{}{
		"*": "allow", "*.env": sensitiveDecision, "*.env.*": sensitiveDecision,
		"*.env.example": "allow", "mcp:*": sensitiveDecision,
	} {
		if read[pattern] != want {
			t.Errorf("permission.read[%s] = %#v, want %#v", pattern, read[pattern], want)
		}
	}
}

func TestRunOpenCodeTurnUsesStdinAndNormalizesOutput(t *testing.T) {
	dir := t.TempDir()
	argsPath, stdinPath, pwdPath := filepath.Join(dir, "args"), filepath.Join(dir, "stdin"), filepath.Join(dir, "pwd")
	projectConfigPath := filepath.Join(dir, "project-config-disabled")
	sharePath := filepath.Join(dir, "share-disabled")
	script := `printf '%s\n' "$@" > "$CAPTURE_ARGS"
cat > "$CAPTURE_STDIN"
pwd > "$CAPTURE_PWD"
printf '%s' "$OPENCODE_DISABLE_PROJECT_CONFIG" > "$CAPTURE_PROJECT_CONFIG"
printf '%s:%s' "$OPENCODE_DISABLE_SHARE" "$OPENCODE_AUTO_SHARE" > "$CAPTURE_SHARE"
printf '%s\n' '{"type":"step_start","timestamp":1,"sessionID":"ses_fake","part":{"type":"step-start"}}'
printf '%s\n' '{"type":"text","timestamp":2,"sessionID":"ses_fake","part":{"type":"text","text":"hello"}}'
printf '%s\n' '{"type":"step_finish","timestamp":3,"sessionID":"ses_fake","part":{"type":"step-finish","cost":0,"tokens":{"total":2,"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}}}'`
	writeFakeBin(t, dir, providerOpenCode, script)
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	job := &ClaimedSession{SessionID: "orbit-1", Title: "Example", Agent: AgentExecConfig{Env: map[string]string{
		"CAPTURE_ARGS": argsPath, "CAPTURE_STDIN": stdinPath, "CAPTURE_PWD": pwdPath,
		"CAPTURE_PROJECT_CONFIG": projectConfigPath, "CAPTURE_SHARE": sharePath,
		"OPENCODE_DISABLE_SHARE": "0", "OPENCODE_AUTO_SHARE": "1",
	}}}
	var events []emittedEvent
	result := runOpenCodeTurn(t.Context(), job, dir, dir, "hello stdin", nil, func(typ string, payload map[string]interface{}) {
		events = append(events, emittedEvent{typ: typ, payload: payload})
	})
	if result.Status != stSucceeded || result.RuntimeSessionID != "ses_fake" || result.Result != "hello" {
		t.Fatalf("result = %#v", result)
	}
	stdin, _ := os.ReadFile(stdinPath)
	if string(stdin) != "hello stdin" {
		t.Fatalf("stdin = %q", stdin)
	}
	pwd, _ := os.ReadFile(pwdPath)
	if strings.TrimSpace(string(pwd)) != dir {
		t.Fatalf("pwd = %q, want %q", pwd, dir)
	}
	projectConfig, _ := os.ReadFile(projectConfigPath)
	if string(projectConfig) != "1" {
		t.Fatalf("OPENCODE_DISABLE_PROJECT_CONFIG = %q, want 1", projectConfig)
	}
	share, _ := os.ReadFile(sharePath)
	if string(share) != "1:0" {
		t.Fatalf("OpenCode share env = %q, want 1:0", share)
	}
	args, _ := os.ReadFile(argsPath)
	if !strings.Contains(string(args), "--dir="+dir) || !strings.Contains(string(args), "--title=Example") {
		t.Fatalf("args = %q", args)
	}
}

func TestRunOpenCodeTurnInterruptKillsToolProcessTree(t *testing.T) {
	dir := t.TempDir()
	readyPath := filepath.Join(dir, "ready")
	leakPath := filepath.Join(dir, "leaked")
	script := `if command -v setsid >/dev/null 2>&1; then
  setsid sh -c 'sleep 0.4; printf leaked > "$LEAK_PATH"' &
else
  ( sleep 0.4; printf leaked > "$LEAK_PATH" ) &
fi
printf ready > "$READY_PATH"
wait`
	writeFakeBin(t, dir, providerOpenCode, script)
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	job := &ClaimedSession{
		SessionID: "orbit-interrupt",
		Agent: AgentExecConfig{Env: map[string]string{
			"READY_PATH": readyPath,
			"LEAK_PATH":  leakPath,
		}},
	}
	ctx, cancel := context.WithCancelCause(t.Context())
	done := make(chan openCodeTurnResult, 1)
	go func() {
		done <- runOpenCodeTurn(ctx, job, dir, dir, "stop me", nil, func(string, map[string]interface{}) {})
	}()

	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(readyPath); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("fake OpenCode did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel(errOpenCodeInterrupted)
	select {
	case result := <-done:
		if result.Status != stInterrupted || result.Subtype != "interrupted" {
			t.Fatalf("result = %#v", result)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("interrupted OpenCode process did not exit")
	}

	// Without process-group cancellation the provider shell exits, but its tool
	// child survives long enough to write this marker.
	time.Sleep(600 * time.Millisecond)
	if _, err := os.Stat(leakPath); !os.IsNotExist(err) {
		t.Fatalf("tool child survived interrupt; leak stat error = %v", err)
	}
}

func TestOpenCodeEndDropsMessageQueuedBehindActiveTurn(t *testing.T) {
	dir := t.TempDir()
	readyPath := filepath.Join(dir, "ready")
	countPath := filepath.Join(dir, "invocations")
	writeFakeBin(t, dir, providerOpenCode, `printf x >> "$COUNT_PATH"
printf ready > "$READY_PATH"
while :; do :; done`)
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))

	var inboxCalls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/runner/sessions/s1/inbox" {
			http.NotFound(w, r)
			return
		}
		var response RunInboxResponse
		switch inboxCalls.Add(1) {
		case 1:
			response = RunInboxResponse{TurnID: "t1", Kind: "message", Content: "first"}
		case 2:
			if !waitForOpenCodeTestFile(r.Context(), readyPath) {
				return
			}
			response = RunInboxResponse{TurnID: "t2", Kind: "message", Content: "must not run"}
		case 3:
			response = RunInboxResponse{TurnID: "end1", Kind: "end"}
		default:
			<-r.Context().Done()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	shutdownCtx, stop := context.WithCancel(context.Background())
	defer stop()
	var permits atomic.Int32
	var completions []TurnCompleteRequest
	status, ended, _ := runOpenCodeSessionProcess(
		ctx, shutdownCtx, NewTransport(srv.URL, "token"),
		&ClaimedSession{SessionID: "s1", Agent: AgentExecConfig{Env: map[string]string{"READY_PATH": readyPath, "COUNT_PATH": countPath}}},
		"", dir, dir, func(string, map[string]interface{}) {}, func(string) {}, false, nil,
		func(req TurnCompleteRequest, _ ...context.Context) error { completions = append(completions, req); return nil },
		func(context.Context) bool { permits.Add(1); return true },
		func(error) {},
	)
	if status != stSucceeded || !ended {
		t.Fatalf("session result = (%q, %v)", status, ended)
	}
	if got := permits.Load(); got != 1 {
		t.Fatalf("turn permit waits = %d, want 1", got)
	}
	if data, _ := os.ReadFile(countPath); len(data) != 1 {
		t.Fatalf("OpenCode invocations = %d, want 1", len(data))
	}
	if len(completions) != 1 || completions[0].TurnID != "t1" || completions[0].Status != stCancelled {
		t.Fatalf("completions = %#v", completions)
	}
}

func TestOpenCodeSettledDuplicateNeverWaitsForPermitOrReruns(t *testing.T) {
	dir := t.TempDir()
	countPath := filepath.Join(dir, "invocations")
	writeFakeBin(t, dir, providerOpenCode, `printf x >> "$COUNT_PATH"
printf '%s\n' '{"type":"text","part":{"text":"done"}}'
printf '%s\n' '{"type":"step_finish","part":{"cost":0,"tokens":{"total":2,"input":1,"output":1}}}'`)
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))

	ackStarted := make(chan struct{})
	duplicateDelivered := make(chan struct{})
	allowEnd := make(chan struct{})
	secondPermit := make(chan struct{})
	var inboxCalls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/runner/sessions/s1/inbox" {
			http.NotFound(w, r)
			return
		}
		var response RunInboxResponse
		switch inboxCalls.Add(1) {
		case 1:
			response = RunInboxResponse{TurnID: "t1", Kind: "message", Content: "once"}
		case 2:
			select {
			case <-ackStarted:
			case <-r.Context().Done():
				return
			}
			response = RunInboxResponse{TurnID: "t1", Kind: "message", Content: "stale duplicate"}
			defer close(duplicateDelivered)
		case 3:
			select {
			case <-allowEnd:
			case <-r.Context().Done():
				return
			}
			response = RunInboxResponse{TurnID: "end1", Kind: "end"}
		default:
			<-r.Context().Done()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	shutdownCtx, stop := context.WithCancel(context.Background())
	defer stop()
	var permits atomic.Int32
	var completeCalls atomic.Int32
	go func() {
		select {
		case <-secondPermit: // a regression tried to execute the stale duplicate
		case <-time.After(300 * time.Millisecond):
		case <-ctx.Done():
		}
		close(allowEnd)
	}()
	status, ended, _ := runOpenCodeSessionProcess(
		ctx, shutdownCtx, NewTransport(srv.URL, "token"),
		&ClaimedSession{SessionID: "s1", Agent: AgentExecConfig{Env: map[string]string{"COUNT_PATH": countPath}}},
		"", dir, dir, func(string, map[string]interface{}) {}, func(string) {}, false, nil,
		func(req TurnCompleteRequest, _ ...context.Context) error {
			if completeCalls.Add(1) == 1 {
				close(ackStarted)
				select {
				case <-duplicateDelivered:
				case <-ctx.Done():
				}
			}
			return nil
		},
		func(context.Context) bool {
			if permits.Add(1) == 2 {
				close(secondPermit)
			}
			return true
		},
		func(error) {},
	)
	if status != stSucceeded || !ended {
		t.Fatalf("session result = (%q, %v)", status, ended)
	}
	if got := permits.Load(); got != 1 {
		t.Fatalf("turn permit waits = %d, want 1", got)
	}
	if got := completeCalls.Load(); got != 1 {
		t.Fatalf("turn completions = %d, want 1", got)
	}
	if data, _ := os.ReadFile(countPath); len(data) != 1 {
		t.Fatalf("OpenCode invocations = %d, want 1", len(data))
	}
}

func TestOpenCodeInterruptCancelsAttachmentPreparation(t *testing.T) {
	dir := t.TempDir()
	countPath := filepath.Join(dir, "invocations")
	writeFakeBin(t, dir, providerOpenCode, `printf x >> "$COUNT_PATH"`)
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))

	attachmentStarted := make(chan struct{})
	attachmentCancelled := make(chan struct{})
	var inboxCalls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/runner/sessions/s1/inbox":
			var response RunInboxResponse
			switch inboxCalls.Add(1) {
			case 1:
				response = RunInboxResponse{TurnID: "t1", Kind: "message", Content: "with file", Attachments: []TurnAttachment{{ID: "a1", FileName: "a.txt", MimeType: "text/plain"}}}
			case 2:
				select {
				case <-attachmentStarted:
				case <-r.Context().Done():
					return
				}
				response = RunInboxResponse{TurnID: "interrupt1", Kind: "interrupt"}
			case 3:
				response = RunInboxResponse{TurnID: "end1", Kind: "end"}
			default:
				<-r.Context().Done()
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(response)
		case "/api/runner/sessions/s1/attachments/a1":
			close(attachmentStarted)
			<-r.Context().Done()
			close(attachmentCancelled)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	shutdownCtx, stop := context.WithCancel(context.Background())
	defer stop()
	var completion TurnCompleteRequest
	status, ended, _ := runOpenCodeSessionProcess(
		ctx, shutdownCtx, NewTransport(srv.URL, "token"),
		&ClaimedSession{SessionID: "s1", Agent: AgentExecConfig{Env: map[string]string{"COUNT_PATH": countPath}}},
		"", dir, dir, func(string, map[string]interface{}) {}, func(string) {}, false, nil,
		func(req TurnCompleteRequest, _ ...context.Context) error { completion = req; return nil },
		func(context.Context) bool { return true },
		func(error) {},
	)
	if status != stSucceeded || !ended {
		t.Fatalf("session result = (%q, %v)", status, ended)
	}
	if completion.TurnID != "t1" || completion.Status != stInterrupted || completion.Subtype != "interrupted" {
		t.Fatalf("completion = %#v", completion)
	}
	select {
	case <-attachmentCancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("attachment HTTP request was not cancelled")
	}
	if data, _ := os.ReadFile(countPath); len(data) != 0 {
		t.Fatalf("OpenCode started during cancelled preparation (%d invocation(s))", len(data))
	}
}

func waitForOpenCodeTestFile(ctx context.Context, path string) bool {
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		if _, err := os.Stat(path); err == nil {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-ticker.C:
		}
	}
}
