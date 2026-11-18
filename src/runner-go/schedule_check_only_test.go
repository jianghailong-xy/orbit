package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// argAfter is the value that follows flag in argv, and whether the flag is there.
func argAfter(args []string, flag string) (string, bool) {
	for i, arg := range args {
		if arg == flag && i+1 < len(args) {
			return args[i+1], true
		}
	}
	return "", false
}

// A scheduled CHECK_ONLY run on Claude Code (design §6.2): no settings file of its own, no Orbit CLI allow rule, and
// the CLI denied by this runner's own path instead of the server's `*/orbit *` patterns. Every other session is as
// before.
func TestClaudeScheduledCheckOnlyArgs(t *testing.T) {
	exe := orbitCLIPermissionExecutable(orbitCLIExecutable())
	if exe == "" {
		t.Skip("this test binary's path cannot be carried in Claude's rule grammar")
	}
	job := claudeSpawnJob(t)
	job.Agent.PermissionMode = "default"
	job.Agent.ScheduledCheckOnly = true
	job.Agent.AllowedTools = []string{"mcp__orbit__task_get", "WebFetch", "Bash(npm test:*)"}
	job.Agent.DisallowedTools = []string{"Edit", "Write", "NotebookEdit", "Bash(*/orbit *)", "Bash('*/orbit' *)", "mcp__orbit__bg_run"}
	args := claudeCommandArgs(job, t.TempDir(), true)

	sources, ok := argAfter(args, "--setting-sources")
	if !ok || sources != "" {
		t.Fatalf("--setting-sources %q (present %v), want an empty list: %v", sources, ok, args)
	}
	if _, ok := argAfter(args, "--settings"); !ok {
		t.Errorf("the runner's own --settings file is gone: %v", args)
	}
	if tools, ok := argAfter(args, "--tools"); !ok || tools != "Bash,Read,Grep,Glob,WebFetch,WebSearch,ToolSearch" {
		t.Errorf("--tools %q (present %v): only the built-ins a check uses", tools, ok)
	}
	allowed, _ := argAfter(args, "--allowedTools")
	if allowed != "mcp__orbit__task_get,WebFetch,Bash(npm test:*)" {
		t.Errorf("--allowedTools %q: exactly the claim's, with no Orbit CLI rule", allowed)
	}
	denied, _ := argAfter(args, "--disallowedTools")
	rules := strings.Split(denied, ",")
	has := func(rule string) bool {
		for _, r := range rules {
			if r == rule {
				return true
			}
		}
		return false
	}
	for _, want := range []string{
		"Edit", "Write", "NotebookEdit", "mcp__orbit__bg_run", "TodoWrite",
		"Bash(" + exe + ")", "Bash(" + exe + " *)", "Bash('" + exe + "')", "Bash('" + exe + "' *)",
	} {
		if !has(want) {
			t.Errorf("--disallowedTools is missing %q: %s", want, denied)
		}
	}
	for _, gone := range []string{"Bash(*/orbit *)", "Bash('*/orbit' *)"} {
		if has(gone) {
			t.Errorf("--disallowedTools still has %q, which also refuses `ls /root/orbit`: %s", gone, denied)
		}
	}

	// The same session not serving a scheduled check: the CLI allowed by path, settings loaded as before.
	job.Agent.ScheduledCheckOnly = false
	args = claudeCommandArgs(job, t.TempDir(), true)
	if _, ok := argAfter(args, "--setting-sources"); ok {
		t.Errorf("an ordinary session got --setting-sources: %v", args)
	}
	if _, ok := argAfter(args, "--tools"); ok {
		t.Errorf("an ordinary session got --tools: %v", args)
	}
	allowed, _ = argAfter(args, "--allowedTools")
	if !strings.Contains(allowed, "Bash("+exe+" task update *)") {
		t.Errorf("an ordinary session lost the Orbit CLI allow rules: %s", allowed)
	}
	denied, _ = argAfter(args, "--disallowedTools")
	if !strings.Contains(denied, "Bash(*/orbit *)") || strings.Contains(denied, "Bash("+exe+" *)") {
		t.Errorf("an ordinary session's deny list changed: %s", denied)
	}
}

// An executable the rule grammar cannot carry keeps the server's patterns: nothing is left unanchored and undenied.
func TestCheckOnlyDisallowedToolsKeepsTheServerPatternsForAnUnusablePath(t *testing.T) {
	in := []string{"Edit", "Bash(*/orbit *)", "Bash('*/orbit' *)"}
	for _, exe := range []string{"", "relative/orbit", "/opt/a,b/orbit", "/opt/(x)/orbit"} {
		if got := checkOnlyDisallowedTools(in, exe); strings.Join(got, ",") != strings.Join(in, ",") {
			t.Errorf("%q: %v", exe, got)
		}
	}
	got := checkOnlyDisallowedTools(in, "/usr/local/bin/orbit")
	want := "Edit,Bash(/usr/local/bin/orbit),Bash(/usr/local/bin/orbit *),Bash('/usr/local/bin/orbit'),Bash('/usr/local/bin/orbit' *)"
	if strings.Join(got, ",") != want {
		t.Errorf("got %v, want %s", got, want)
	}
}

// In such a run every ask about an Orbit tool is refused by the runner, with no card, whatever the catalogue says
// of the tool: a read, a write, one this runner does not know. Outside such a run the Plan gate's answer is unchanged.
func TestScheduledCheckOnlyRefusesEveryOrbitToolPrompt(t *testing.T) {
	notPlan := func() (string, bool, error) { return "default", true, nil }
	ask := func(srv *mcpServer, tool string) map[string]interface{} {
		res := srv.permissionPrompt(map[string]interface{}{
			"tool_name": tool, "tool_use_id": "toolu_1", "input": map[string]interface{}{"taskId": "t"},
		})
		var answer map[string]interface{}
		text := res["content"].([]map[string]interface{})[0]["text"].(string)
		if err := json.Unmarshal([]byte(text), &answer); err != nil {
			t.Fatalf("%s: %q: %v", tool, text, err)
		}
		return answer
	}
	t.Setenv(envScheduledCheckOnly, "1")
	srv := &mcpServer{sessionID: "sess-1", permissionMode: notPlan} // no transport: a card would fail loudly
	for _, tool := range []string{"bg_run", "task_update", "session_merge", "task_start", "task_get", "a_tool_from_a_newer_runner"} {
		answer := ask(srv, claudeToolName(tool))
		if answer["behavior"] != "deny" || answer["message"] != checkOnlyOrbitToolRefusal {
			t.Errorf("%s in a scheduled check: %v", tool, answer)
		}
	}
	t.Setenv(envScheduledCheckOnly, "0")
	if answer := ask(srv, claudeToolName("task_update")); answer["behavior"] != "allow" {
		t.Errorf("outside a scheduled check, task_update outside Plan is the Plan gate's allow, got %v", answer)
	}
}

// The two schedule operations whose owner step is a card say so in the capability document; the rest of the
// schedule tools involve nobody.
func TestScheduleToolInteractions(t *testing.T) {
	for tool, want := range map[string]string{
		"schedule_create": interactionCard, "schedule_update": interactionCard,
		"schedule_end": interactionNone, "schedule_pause": interactionNone, "schedule_run_report": interactionNone,
		"schedule_get": interactionNone,
		// Still the owner's decision elsewhere: the override is the schedule tools' alone.
		"project_request_start": interactionOwnerDecision,
	} {
		op := catalogOperation(tool)
		if op == nil {
			t.Fatalf("%s is not in the catalogue", tool)
		}
		if got := op.interaction(); got != want {
			t.Errorf("%s: interaction %q, want %q", tool, got, want)
		}
	}
}

// Recovery's listedTools counts what tools/list lists: schedule_run_report only in a scheduled run's session.
func TestListedToolsMatchToolsListForScheduleRunReport(t *testing.T) {
	t.Setenv(envSubagentRunID, "")
	for _, run := range []bool{false, true} {
		srv := &mcpServer{scheduleRun: run}
		_, listed := srv.listedTools()[scheduleRunReportTool]
		resp, _ := srv.handle(&rpcRequest{JSONRPC: "2.0", ID: []byte("1"), Method: "tools/list"})
		inList := false
		for _, tool := range resp.Result.(map[string]interface{})["tools"].([]map[string]interface{}) {
			if tool["name"] == scheduleRunReportTool {
				inList = true
			}
		}
		if listed != run || inList != run {
			t.Errorf("scheduleRun=%v: listedTools has it %v, tools/list has it %v", run, listed, inList)
		}
	}
}

// Such a run loads no settings file (--setting-sources ''), so the runner's own --settings file carries what of the
// user's settings.json the engine needs to reach its endpoint: env and credential helpers, never permissions or hooks.
func TestScheduledCheckOnlyKeepsUserEnvAndCredentialHelpersOnly(t *testing.T) {
	cfg := t.TempDir()
	user := `{"env":{"HTTPS_PROXY":"http://127.0.0.1:3128","ANTHROPIC_BASE_URL":"https://gw.example"},` +
		`"apiKeyHelper":"/opt/key-helper","awsAuthRefresh":"aws sso login",` +
		`"permissions":{"allow":["Bash(cp:*)"]},"hooks":{"PreToolUse":[]},"model":"x"}`
	if err := os.WriteFile(filepath.Join(cfg, "settings.json"), []byte(user), 0o644); err != nil {
		t.Fatal(err)
	}
	job := claudeSpawnJob(t)
	job.Agent.PermissionMode = "default"
	job.Agent.Env = map[string]string{"CLAUDE_CONFIG_DIR": cfg}
	read := func(args []string) map[string]json.RawMessage {
		path, ok := argAfter(args, "--settings")
		if !ok {
			t.Fatalf("no --settings: %v", args)
		}
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var settings map[string]json.RawMessage
		if err := json.Unmarshal(b, &settings); err != nil {
			t.Fatal(err)
		}
		return settings
	}

	job.Agent.ScheduledCheckOnly = true
	settings := read(claudeCommandArgs(job, t.TempDir(), true))
	if string(settings["env"]) != `{"ANTHROPIC_BASE_URL":"https://gw.example","HTTPS_PROXY":"http://127.0.0.1:3128"}` &&
		string(settings["env"]) != `{"HTTPS_PROXY":"http://127.0.0.1:3128","ANTHROPIC_BASE_URL":"https://gw.example"}` {
		t.Errorf("env %s", settings["env"])
	}
	if string(settings["apiKeyHelper"]) != `"/opt/key-helper"` || string(settings["awsAuthRefresh"]) != `"aws sso login"` {
		t.Errorf("credential helpers not kept: %v", settings)
	}
	if _, has := settings["permissions"]; has {
		t.Errorf("the user's permissions reached the run's settings: %s", settings["permissions"])
	}
	if _, has := settings["model"]; has {
		t.Errorf("a key that is not how the engine reaches its endpoint was kept: %v", settings)
	}
	// The runner's own keys stand: its hooks, not the user's empty list.
	if !strings.Contains(string(settings["hooks"]), "bg-guard") && orbitCLIExecutable() != "" {
		t.Errorf("the runner's hooks were replaced: %s", settings["hooks"])
	}
	if string(settings["disableClaudeAiConnectors"]) != "true" {
		t.Errorf("the runner's own settings are gone: %v", settings)
	}

	// Any other session loads the user's settings itself, so the runner's file carries none of them.
	job.Agent.ScheduledCheckOnly = false
	settings = read(claudeCommandArgs(job, t.TempDir(), true))
	for _, key := range checkOnlyInheritedSettingKeys {
		if _, has := settings[key]; has {
			t.Errorf("an ordinary session's --settings file carries %s", key)
		}
	}
}

// Every Orbit tool `orbit mcp` can serve (every switch on, a scheduled run's session, outside a SubAgent) is on one of
// the control plane's lists for a CHECK_ONLY run on Claude Code (apiserver schedule-access.ts): allowed, or denied by
// name. A tool on neither would reach this runner's prompt refusal only, and an older runner's allow.
func TestEveryServedOrbitToolIsOnACheckOnlyList(t *testing.T) {
	t.Setenv(envSubagentRunID, "")
	t.Setenv(envWatches, "1")
	t.Setenv(envWiki, "1")
	source, err := os.ReadFile(filepath.Join("..", "apiserver", "src", "schedules", "schedule-access.ts"))
	if err != nil {
		t.Fatal(err)
	}
	srv := &mcpServer{sessionID: "sess-1", allowOrchestration: true, scheduleRun: true, allowPermissionPrompt: true}
	names := map[string]bool{}
	for _, tool := range srv.listedToolDescriptors() {
		names[tool["name"].(string)] = true
	}
	for _, op := range operationCatalog().Ops {
		if op.MCP != nil {
			names[op.Tool] = true
		}
	}
	if !names[delegateToolName] || !names["bg_run"] || !names[scheduleRunReportTool] {
		t.Fatalf("the served set is not the whole set: %v", names)
	}
	for name := range names {
		if name == "permission_prompt" {
			continue // the engine's door for every ask, a shell command's included
		}
		if !strings.Contains(string(source), "'"+claudeToolName(name)+"'") {
			t.Errorf("%s is served by orbit mcp and is on neither CHECK_ONLY list in schedule-access.ts", claudeToolName(name))
		}
	}
}
