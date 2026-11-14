package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// An OpenCode SubAgent runs one `opencode run` in the parent's cwd with its own config dir, feeds its events to the
// run's emit, and returns the final text, cost and usage with the OpenCode session it ran in. Its `orbit mcp` carries
// ORBIT_SUBAGENT_RUN_ID, so delegate is not offered to it, and a resume continues the same session.
func TestRunOpenCodeChildRunsOneTurnInTheParentsCwd(t *testing.T) {
	bin, cwd, scratch := t.TempDir(), t.TempDir(), t.TempDir()
	argsPath, configPath, pwdPath := filepath.Join(bin, "args"), filepath.Join(bin, "config"), filepath.Join(bin, "pwd")
	script := `printf '%s\n' "$@" > "$CAPTURE_ARGS"
printf '%s' "$OPENCODE_CONFIG_CONTENT" > "$CAPTURE_CONFIG"
pwd > "$CAPTURE_PWD"
cat > /dev/null
printf '%s\n' '{"type":"step_start","sessionID":"ses_child","part":{"type":"step-start"}}'
printf '%s\n' '{"type":"tool_use","sessionID":"ses_child","part":{"tool":"write","callID":"c1","state":{"status":"completed","input":{"filePath":"` + cwd + `/notes.txt","content":"x"},"output":"ok"}}}'
printf '%s\n' '{"type":"tool_use","sessionID":"ses_child","part":{"tool":"apply_patch","callID":"c2","state":{"status":"completed","input":{"patchText":"*** Begin Patch\n*** Update File: src/a.go\n@@\n-a\n+b\n*** End Patch"},"output":"ok"}}}'
printf '%s\n' '{"type":"text","sessionID":"ses_child","part":{"type":"text","text":"Wrote notes.txt."}}'
printf '%s\n' '{"type":"step_finish","sessionID":"ses_child","part":{"type":"step-finish","cost":0.012,"tokens":{"total":3,"input":2,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}}}'`
	writeFakeBin(t, bin, providerOpenCode, script)
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))

	parent := &ClaimedSession{SessionID: "orbit-parent", Title: "Parent session", Provider: providerOpenCode,
		Agent: AgentExecConfig{Provider: providerOpenCode}}
	exec := AgentExecConfig{Provider: providerOpenCode, PermissionMode: "acceptEdits", Env: map[string]string{
		"CAPTURE_ARGS": argsPath, "CAPTURE_CONFIG": configPath, "CAPTURE_PWD": pwdPath,
	}}
	files := newSubagentFileCollector(cwd)
	emit := func(typ string, payload map[string]interface{}) { files.note(typ, payload) }
	c := subagentChild{parent: parent, exec: exec, def: subagentDefinition{Name: "general"}, runID: "run1",
		cwd: cwd, scratch: scratch, prompt: "write notes", emit: emit}

	res, conversation, err := runOpenCodeChild(context.Background(), c)
	if err != nil || res.Status != stSucceeded || res.Result != "Wrote notes.txt." || conversation != "ses_child" {
		t.Fatalf("result = %#v, conversation %q, err %v", res, conversation, err)
	}
	if res.CostUsd != 0.012 || res.Usage == nil || res.Usage.InputTokens != 2 || res.Usage.OutputTokens != 1 {
		t.Fatalf("cost/usage = %v / %#v", res.CostUsd, res.Usage)
	}
	if want := []string{"notes.txt", "src/a.go"}; !reflect.DeepEqual(files.changed, want) {
		t.Fatalf("changed = %v, want %v", files.changed, want)
	}
	if pwd, _ := os.ReadFile(pwdPath); strings.TrimSpace(string(pwd)) != cwd {
		t.Fatalf("ran in %q, want the parent's cwd %q", pwd, cwd)
	}
	args, _ := os.ReadFile(argsPath)
	if strings.Contains(string(args), "--session=") || strings.Contains(string(args), "--title=Parent session") {
		t.Fatalf("a new SubAgent opened under the parent's session or title: %q", args)
	}
	raw, _ := os.ReadFile(configPath)
	var config map[string]interface{}
	if err := json.Unmarshal(raw, &config); err != nil {
		t.Fatalf("config: %v (%s)", err, raw)
	}
	if orbit := mapValue(mapValue(config["mcp"])["orbit"]); orbit != nil {
		if got := asString(mapValue(orbit["environment"])[envSubagentRunID]); got != "run1" {
			t.Fatalf("orbit mcp %s = %q, want run1", envSubagentRunID, got)
		}
	} else if orbitCLIExecutable() != "" {
		t.Fatalf("config has no orbit MCP server: %s", raw)
	}
	instructions, _ := config["instructions"].([]interface{})
	if len(instructions) == 0 {
		t.Fatalf("no instructions in config: %s", raw)
	}
	if body, _ := os.ReadFile(asString(instructions[len(instructions)-1])); !strings.Contains(string(body), "You are a SubAgent") {
		t.Fatalf("instructions lack the SubAgent preamble: %q", body)
	}

	// A resume continues the run's own OpenCode session.
	c.resume, c.engineSession = true, "ses_child"
	if _, conversation, err := runOpenCodeChild(context.Background(), c); err != nil || conversation != "ses_child" {
		t.Fatalf("resume: conversation %q, err %v", conversation, err)
	}
	args, _ = os.ReadFile(argsPath)
	if !strings.Contains(string(args), "--session=ses_child") {
		t.Fatalf("resume args = %q", args)
	}
	if _, ok := subagentChildRunners[providerOpenCode]; !ok {
		t.Fatal("OpenCode child runner is not registered")
	}
}

func TestRunOpenCodeChildStopsWithTheSession(t *testing.T) {
	bin := t.TempDir()
	writeFakeBin(t, bin, providerOpenCode, `sleep 30`)
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	c := subagentChild{parent: &ClaimedSession{SessionID: "p"}, exec: AgentExecConfig{Provider: providerOpenCode},
		runID: "run2", cwd: t.TempDir(), scratch: t.TempDir(), prompt: "x", emit: func(string, map[string]interface{}) {}}
	res, _, err := runOpenCodeChild(ctx, c)
	if err != nil || res.Status != stCancelled {
		t.Fatalf("cancelled child = %#v, %v", res, err)
	}
}
