package main

import (
	"encoding/json"
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
