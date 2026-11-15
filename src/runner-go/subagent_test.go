package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// A child event reaches the parent nested under the delegate call, with every tool id the child minted prefixed by
// the run id, so the parent's nested rendering draws it and no id collides with the parent's own.
func TestRewriteSubagentEventNestsUnderTheDelegateCall(t *testing.T) {
	const run, parent = "run1", "toolu_parent"

	use, ok := rewriteSubagentEvent(run, parent, evToolUse, map[string]interface{}{
		"id": "toolu_1", "name": "Edit", "input": map[string]interface{}{"file_path": "a.go"},
	})
	if !ok || use["id"] != "run1:toolu_1" || use["parentToolUseId"] != parent || use["name"] != "Edit" ||
		use["subagentRunId"] != run {
		t.Fatalf("tool_use rewritten as %v (kept %v)", use, ok)
	}
	result, ok := rewriteSubagentEvent(run, parent, evToolResult, map[string]interface{}{
		"toolUseId": "toolu_1", "content": "ok", "isError": false,
	})
	if !ok || result["toolUseId"] != "run1:toolu_1" || result["parentToolUseId"] != parent || result["content"] != "ok" {
		t.Fatalf("tool_result rewritten as %v (kept %v)", result, ok)
	}
	text, ok := rewriteSubagentEvent(run, parent, evAssistant, map[string]interface{}{"text": "done"})
	if !ok || text["parentToolUseId"] != parent || text["text"] != "done" {
		t.Fatalf("assistant rewritten as %v (kept %v)", text, ok)
	}

	// The child's own nested call (its own Agent tool) stays nested under that call, now prefixed.
	inner, ok := rewriteSubagentEvent(run, parent, evToolUse, map[string]interface{}{
		"id": "toolu_9", "name": "Read", "parentToolUseId": "toolu_agent",
	})
	if !ok || inner["id"] != "run1:toolu_9" || inner["parentToolUseId"] != "run1:toolu_agent" {
		t.Fatalf("nested tool_use rewritten as %v", inner)
	}

	// The payload the child's parser built is left as it was.
	original := map[string]interface{}{"id": "toolu_2", "name": "Bash"}
	rewriteSubagentEvent(run, parent, evToolUse, original)
	if original["id"] != "toolu_2" || original["parentToolUseId"] != nil {
		t.Fatalf("the child's payload was modified: %v", original)
	}
}

func TestRewriteSubagentEventDropsWhatTheParentMustNotSee(t *testing.T) {
	for _, eventType := range []string{evSystem, evTextDelta, evThinkingDelta, evBackgroundTask, evTaskProgress, evTurnEnd} {
		if out, ok := rewriteSubagentEvent("run1", "toolu_parent", eventType, map[string]interface{}{"subtype": "init"}); ok {
			t.Errorf("%s was kept: %v", eventType, out)
		}
	}
}

func TestSubagentFileCollectorCountsSucceededEditsOnce(t *testing.T) {
	c := newSubagentFileCollector("/work/tree")
	c.note(evToolUse, map[string]interface{}{"id": "1", "name": "Edit", "input": map[string]interface{}{"file_path": "/work/tree/src/a.go"}})
	c.note(evToolResult, map[string]interface{}{"toolUseId": "1", "isError": false})
	c.note(evToolUse, map[string]interface{}{"id": "2", "name": "Write", "input": map[string]interface{}{"file_path": "/work/tree/src/a.go"}})
	c.note(evToolResult, map[string]interface{}{"toolUseId": "2"})
	c.note(evToolUse, map[string]interface{}{"id": "3", "name": "Write", "input": map[string]interface{}{"file_path": "/work/tree/b.txt"}})
	c.note(evToolResult, map[string]interface{}{"toolUseId": "3", "isError": true})
	c.note(evToolUse, map[string]interface{}{"id": "4", "name": "Read", "input": map[string]interface{}{"file_path": "/work/tree/c.go"}})
	c.note(evToolResult, map[string]interface{}{"toolUseId": "4"})
	c.note(evToolUse, map[string]interface{}{"id": "5", "name": "NotebookEdit", "input": map[string]interface{}{"notebook_path": "/elsewhere/n.ipynb"}})
	c.note(evToolResult, map[string]interface{}{"toolUseId": "5"})
	if want := []string{"src/a.go", "/elsewhere/n.ipynb"}; !reflect.DeepEqual(c.changed, want) {
		t.Fatalf("changed = %v, want %v", c.changed, want)
	}
}

// Two parallel SubAgents that changed the same file: the one that ended later names the other in its result.
func TestSameFileNotesNameTheEarlierParallelRun(t *testing.T) {
	t0 := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	a := subagentSpan{ID: "runA", Started: t0, Ended: t0.Add(2 * time.Minute), Changed: []string{"x.go", "shared.go"}}
	b := subagentSpan{ID: "runB", Started: t0.Add(time.Minute), Ended: t0.Add(3 * time.Minute), Changed: []string{"shared.go", "y.go"}}

	if got, want := sameFileNotes(b, []subagentSpan{a}), []string{"Also changed by runA: shared.go"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("later run's notes = %v, want %v", got, want)
	}
	// The earlier one says nothing about the later, which tells the pair.
	if got := sameFileNotes(a, []subagentSpan{b}); len(got) != 0 {
		t.Fatalf("earlier run's notes = %v, want none", got)
	}
	// One still running is not named yet: its own end names this one.
	running := subagentSpan{ID: "runC", Started: t0, Changed: []string{"shared.go"}}
	if got := sameFileNotes(b, []subagentSpan{running}); len(got) != 0 {
		t.Fatalf("notes about a running run = %v, want none", got)
	}
	// Not parallel: it had ended before this one started.
	before := subagentSpan{ID: "runD", Started: t0.Add(-time.Hour), Ended: t0.Add(-time.Minute), Changed: []string{"shared.go"}}
	if got := sameFileNotes(b, []subagentSpan{before}); len(got) != 0 {
		t.Fatalf("notes about a sequential run = %v, want none", got)
	}
	// No shared file, no note.
	other := subagentSpan{ID: "runE", Started: t0, Ended: t0.Add(90 * time.Second), Changed: []string{"z.go"}}
	if got := sameFileNotes(b, []subagentSpan{other}); len(got) != 0 {
		t.Fatalf("notes without a shared file = %v, want none", got)
	}
}

func TestDelegateToolIsOfferedToTopLevelSessionsOnly(t *testing.T) {
	srv := &mcpServer{}
	list := func() []string {
		resp, _ := srv.handle(&rpcRequest{JSONRPC: "2.0", ID: []byte("1"), Method: "tools/list"})
		tools := resp.Result.(map[string]interface{})["tools"].([]map[string]interface{})
		var names []string
		for _, tool := range tools {
			names = append(names, tool["name"].(string))
		}
		return names
	}
	t.Setenv(envSubagentRunID, "")
	if names := strings.Join(list(), ","); !strings.Contains(","+names+",", ",delegate,") {
		t.Fatalf("a top-level session is not offered delegate: %s", names)
	}
	t.Setenv(envSubagentRunID, "run1")
	if names := strings.Join(list(), ","); strings.Contains(","+names+",", ",delegate,") {
		t.Fatalf("a SubAgent is offered delegate: %s", names)
	}
	if res := srv.callDelegate(map[string]interface{}{"prompt": "x", "description": "y"}, "toolu_1"); res["isError"] != true {
		t.Fatalf("a SubAgent's delegate call was not refused: %v", res)
	}
}

func TestSubagentPreambleSaysTheRules(t *testing.T) {
	for _, rule := range []string{"working tree", "Do not commit", "branches", "stash", "one paragraph"} {
		if !strings.Contains(subagentPreamble, rule) {
			t.Errorf("the preamble does not say %q", rule)
		}
	}
}

// §5.3: a SubAgent's engine is never handed delegate — not by its `orbit mcp`, and not in its own tool list.
func TestSubagentChildToolListLacksDelegate(t *testing.T) {
	parent := &ClaimedSession{SessionID: "sess-1", Provider: providerClaude}
	exec := AgentExecConfig{Model: "claude-sonnet-5-5", PermissionMode: "default"}
	general := definitionNamed(t, loadSubagentDefinitions(t.TempDir(), ""), "general")
	child, args := claudeChildSession(parent, exec, general, "run1", "uuid-1", false, t.TempDir())
	disallowed := argValue(args, "--disallowedTools")
	if !strings.Contains(","+disallowed+",", ","+delegateEngineToolName+",") {
		t.Fatalf("the child's --disallowedTools lacks %s: %q", delegateEngineToolName, disallowed)
	}
	if child.Agent.Env[envSubagentRunID] != "run1" {
		t.Fatalf("the child is not marked as a SubAgent: %v", child.Agent.Env)
	}
	// What its `orbit mcp` lists, started with that mark.
	t.Setenv(envSubagentRunID, "run1")
	resp, _ := (&mcpServer{}).handle(&rpcRequest{JSONRPC: "2.0", ID: []byte("1"), Method: "tools/list"})
	for _, tool := range resp.Result.(map[string]interface{})["tools"].([]map[string]interface{}) {
		if tool["name"] == delegateToolName {
			t.Fatal("a SubAgent's orbit mcp lists delegate")
		}
	}
}

// §5.3: a SubAgent asks nobody. Its AskUserQuestion and its plan approval are refused with an English message
// telling it to put the question in its result: by the permission prompt, and by the hook in modes that skip it.
func TestSubagentQuestionsAndPlansAreRefused(t *testing.T) {
	t.Setenv(envSubagentRunID, "run1")
	srv := &mcpServer{sessionID: "sess-parent"} // no transport: a refusal files no card
	for _, tool := range []string{"AskUserQuestion", "ExitPlanMode"} {
		res := srv.permissionPrompt(map[string]interface{}{
			"tool_name": tool, "tool_use_id": "toolu_q", "input": map[string]interface{}{"questions": []interface{}{}},
		})
		text := res["content"].([]map[string]interface{})[0]["text"].(string)
		var answer map[string]interface{}
		if err := json.Unmarshal([]byte(text), &answer); err != nil {
			t.Fatalf("%s: answer %q: %v", tool, text, err)
		}
		if answer["behavior"] != "deny" || answer["message"] != subagentAsksNobodyReason {
			t.Fatalf("%s was not refused with the SubAgent message: %v", tool, answer)
		}
		for _, mode := range []string{"default", "plan", "auto", "bypassPermissions"} {
			out := bgGuardDecision(hookInput{ToolName: tool, PermissionMode: mode})
			spec, _ := out["hookSpecificOutput"].(map[string]interface{})
			if spec["permissionDecision"] != "deny" || spec["permissionDecisionReason"] != subagentAsksNobodyReason {
				t.Fatalf("hook in %s let a SubAgent's %s through: %v", mode, tool, out)
			}
		}
	}
	for _, phrase := range []string{"You are a SubAgent", "cannot ask the user", "put your question", "in your result"} {
		if !strings.Contains(subagentAsksNobodyReason, phrase) {
			t.Errorf("the refusal does not say %q: %s", phrase, subagentAsksNobodyReason)
		}
	}

	// Outside a SubAgent the hook gives no verdict on them, in any mode: an allow would answer a person's question.
	t.Setenv(envSubagentRunID, "")
	for _, mode := range []string{"default", "auto", "bypassPermissions"} {
		if out := bgGuardDecision(hookInput{ToolName: "AskUserQuestion", PermissionMode: mode}); len(out) != 0 {
			t.Fatalf("hook gave a top-level session's question a verdict in %s: %v", mode, out)
		}
	}
	if _, refusal := approvalBodyOfPrompt(map[string]interface{}{"tool_name": "AskUserQuestion", "tool_use_id": "toolu_q"}); refusal != "" {
		t.Fatalf("a top-level session's question was refused: %s", refusal)
	}
}

// §5.3: a SubAgent's card is filed under the parent's session, naming the run, with the call id the parent's
// transcript gives that call.
func TestSubagentApprovalCardNamesItsRun(t *testing.T) {
	args := map[string]interface{}{"tool_name": "Bash", "tool_use_id": "toolu_7", "input": map[string]interface{}{"command": "go test ./..."}}
	t.Setenv(envSubagentRunID, "")
	if body, _ := approvalBodyOfPrompt(args); body["toolUseId"] != "toolu_7" || body["subagentRunId"] != nil {
		t.Fatalf("a top-level card was changed: %v", body)
	}
	t.Setenv(envSubagentRunID, "run1")
	body, refusal := approvalBodyOfPrompt(args)
	if refusal != "" || body["subagentRunId"] != "run1" || body["toolUseId"] != "run1:toolu_7" || body["toolName"] != "Bash" {
		t.Fatalf("SubAgent card = %v (refusal %q)", body, refusal)
	}
	use, _ := rewriteSubagentEvent("run1", "toolu_delegate", evToolUse, map[string]interface{}{"id": "toolu_7", "name": "Bash"})
	if use["id"] != body["toolUseId"] {
		t.Fatalf("the card names %v, the transcript draws %v", body["toolUseId"], use["id"])
	}
}

// A definition's permissionMode reaches the server, which holds it to the parent's; an unknown one is dropped.
func TestSubagentDefinitionPermissionModeIsSent(t *testing.T) {
	project := t.TempDir()
	writeDefinition(t, project, ".claude/agents", "wide.md", "---\npermissionMode: bypassPermissions\n---\nGo.\n")
	writeDefinition(t, project, ".claude/agents", "odd.md", "---\npermissionMode: yolo\n---\nGo.\n")
	defs := loadSubagentDefinitions(project, "")
	if body := subagentStartBody(map[string]interface{}{}, definitionNamed(t, defs, "wide"), "toolu_1", false); body["permissionMode"] != "bypassPermissions" {
		t.Fatalf("permissionMode not sent: %v", body)
	}
	if body := subagentStartBody(map[string]interface{}{}, definitionNamed(t, defs, "odd"), "toolu_1", false); body["permissionMode"] != nil {
		t.Fatalf("an unknown permissionMode was sent: %v", body)
	}
}

// A child that writes through a shell (Codex's printf, a codegen run) leaves no edit-tool path: its run's
// changedFiles still name the file, read off the working tree, once beside what its edit tools named.
func TestSubagentChangedFilesIncludeShellWrites(t *testing.T) {
	dir := t.TempDir()
	for _, args := range [][]string{{"init", "-q"}, {"-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base"}} {
		if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	before, ok := takeSubagentTreeSnapshot(dir)
	if !ok {
		t.Fatal("no snapshot of a git checkout")
	}
	c := newSubagentFileCollector(dir)
	c.note(evToolUse, map[string]interface{}{"id": "w1", "name": "Write", "input": map[string]interface{}{"file_path": filepath.Join(dir, "a.txt")}})
	c.note(evToolResult, map[string]interface{}{"toolUseId": "w1"})
	for _, name := range []string{"a.txt", "notes/codex.txt"} {
		_ = os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0o755)
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	after, _ := takeSubagentTreeSnapshot(dir)
	c.addTreeChanges(after.changedSince(before, nil))
	if want := []string{"a.txt", "notes/codex.txt"}; !reflect.DeepEqual(c.changed, want) {
		t.Fatalf("changedFiles = %v, want %v", c.changed, want)
	}
}
