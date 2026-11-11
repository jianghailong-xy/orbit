package main

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Each engine's file-write tools, as its event parser names them and spells their input, count in changedFiles
// once their call came back without an error; their reads do not.
func TestSubagentFileCollectorReadsEveryEnginesEditTools(t *testing.T) {
	const cwd = "/work/tree"
	type call struct {
		name  string
		input map[string]interface{}
	}
	cases := []struct {
		engine string
		calls  []call
		want   []string
	}{
		{providerClaude, []call{
			{"Edit", map[string]interface{}{"file_path": cwd + "/a.go"}},
			{"MultiEdit", map[string]interface{}{"file_path": cwd + "/b.go"}},
			{"Write", map[string]interface{}{"file_path": cwd + "/c.go"}},
			{"NotebookEdit", map[string]interface{}{"notebook_path": cwd + "/n.ipynb"}},
			{"Read", map[string]interface{}{"file_path": cwd + "/r.go"}},
		}, []string{"a.go", "b.go", "c.go", "n.ipynb"}},
		// A fileChange item's card (codex.go): every file of the patch, in `files`.
		{providerCodex, []call{
			{"apply_patch", map[string]interface{}{"files": []interface{}{cwd + "/a.go", "docs/b.md"}}},
			{"commandExecution", map[string]interface{}{"command": "cat a.go"}},
		}, []string{"a.go", "docs/b.md"}},
		// Kimi's Edit and Write name the file `path`.
		{providerKimi, []call{
			{"Edit", map[string]interface{}{"path": "src/a.go", "old_string": "x", "new_string": "y"}},
			{"Write", map[string]interface{}{"path": cwd + "/NOTES.md", "content": "n"}},
			{"Read", map[string]interface{}{"path": "src/r.go"}},
		}, []string{"src/a.go", "NOTES.md"}},
		// cursorEditCall: Edit or Write with file_path.
		{providerCursor, []call{
			{"Edit", map[string]interface{}{"file_path": cwd + "/a.go", "old_string": "x", "new_string": "y"}},
			{"Write", map[string]interface{}{"file_path": cwd + "/new.go", "content": "package x"}},
			{"Read", map[string]interface{}{"file_path": cwd + "/r.go"}},
		}, []string{"a.go", "new.go"}},
		// DSH: write and edit with file_path; str_replace_editor with path, except a view.
		{providerDsh, []call{
			{"write", map[string]interface{}{"file_path": cwd + "/w.go", "content": "x"}},
			{"edit", map[string]interface{}{"file_path": cwd + "/e.go", "old_string": "x", "new_string": "y"}},
			{"str_replace_editor", map[string]interface{}{"command": "str_replace", "path": cwd + "/s.go"}},
			{"str_replace_editor", map[string]interface{}{"command": "view", "path": cwd + "/v.go"}},
			{"read", map[string]interface{}{"file_path": cwd + "/r.go"}},
		}, []string{"w.go", "e.go", "s.go"}},
		// canonicalOpenCodeToolName + normalizeOpenCodeInputKeys: Write/Edit/MultiEdit with file_path, and
		// ApplyPatch with the patch text.
		{providerOpenCode, []call{
			{"Write", map[string]interface{}{"file_path": cwd + "/w.go"}},
			{"Edit", map[string]interface{}{"file_path": cwd + "/e.go"}},
			{"MultiEdit", map[string]interface{}{"file_path": cwd + "/m.go"}},
			{"ApplyPatch", map[string]interface{}{"patch_text": "*** Begin Patch\n*** Add File: added.txt\n+hi\n" +
				"*** Update File: src/u.go\n*** Move to: src/moved.go\n@@\n-a\n+b\n*** Delete File: gone.txt\n*** End Patch\n"}},
			{"Read", map[string]interface{}{"file_path": cwd + "/r.go"}},
		}, []string{"w.go", "e.go", "m.go", "added.txt", "src/u.go", "src/moved.go", "gone.txt"}},
		// canonicalAgyTool: write_to_file → Write, replace_file_content → Edit, both with file_path.
		{providerAntigravity, []call{
			{"Write", map[string]interface{}{"file_path": cwd + "/w.go"}},
			{"Edit", map[string]interface{}{"file_path": cwd + "/e.go"}},
			{"Read", map[string]interface{}{"file_path": cwd + "/r.go"}},
		}, []string{"w.go", "e.go"}},
	}
	for _, tc := range cases {
		t.Run(tc.engine, func(t *testing.T) {
			c := newSubagentFileCollector(cwd)
			for i, k := range tc.calls {
				id := tc.engine + "-" + string(rune('a'+i))
				c.note(evToolUse, map[string]interface{}{"id": id, "name": k.name, "input": k.input})
				c.note(evToolResult, map[string]interface{}{"toolUseId": id, "isError": false})
			}
			// A failed write counts nothing.
			first := tc.calls[0]
			c.note(evToolUse, map[string]interface{}{"id": "failed", "name": first.name, "input": map[string]interface{}{
				"file_path": cwd + "/failed.go", "path": cwd + "/failed.go", "files": []interface{}{"failed.go"},
			}})
			c.note(evToolResult, map[string]interface{}{"toolUseId": "failed", "isError": true})
			if !reflect.DeepEqual(c.changed, tc.want) {
				t.Fatalf("changed = %v, want %v", c.changed, tc.want)
			}
		})
	}
}

// Every engine but Claude Code is told nothing of the delegate call's id by its `orbit mcp`; the runner takes it
// from the tool_use the engine announced in the session's stream, by the call's prompt.
func TestDelegateCallLogTakesTheAnnouncedCall(t *testing.T) {
	log := &delegateCallLog{changed: make(chan struct{}), sessions: map[string][]*delegateCall{}}
	const sess = "sess-1"
	log.note(sess, evToolUse, map[string]interface{}{"id": "call_a", "name": "orbit__delegate",
		"input": map[string]interface{}{"description": "A", "prompt": "do A"}})
	log.note(sess, evToolUse, map[string]interface{}{"id": "call_b", "name": "mcp__orbit__delegate",
		"input": `{"description":"B","prompt":"do B"}`})
	// Not a delegate, and a SubAgent's own (rewritten) call: neither is a candidate.
	log.note(sess, evToolUse, map[string]interface{}{"id": "call_c", "name": "Bash", "input": map[string]interface{}{"prompt": "do B"}})
	log.note(sess, evToolUse, map[string]interface{}{"id": "run:x", "name": "mcp__orbit__delegate", "subagentRunId": "run",
		"input": map[string]interface{}{"prompt": "do B"}})

	if got := log.take(sess, "do B", "B", 0); got != "call_b" {
		t.Fatalf("take(do B) = %q, want call_b", got)
	}
	if got := log.take(sess, "do B", "B", 0); got != "" {
		t.Fatalf("a call taken once was taken again: %q", got)
	}
	if got := log.take("other", "do A", "A", 0); got != "" {
		t.Fatalf("another session's call was taken: %q", got)
	}
	// One whose id the engine sent is claimed, so a call without one does not take it.
	log.claim(sess, "call_a")
	if got := log.take(sess, "do A", "A", 0); got != "" {
		t.Fatalf("a claimed call was taken: %q", got)
	}

	// The call crosses its tool_use on the way in: take waits for it.
	go func() {
		time.Sleep(50 * time.Millisecond)
		log.note(sess, evToolUse, map[string]interface{}{"id": "call_late", "name": "orbit__delegate",
			"input": map[string]interface{}{"prompt": "late"}})
	}()
	if got := log.take(sess, "late", "", 2*time.Second); got != "call_late" {
		t.Fatalf("take(late) = %q, want call_late", got)
	}

	// A call announced with no input (an engine that sends the arguments later) is the oldest open one.
	log.note(sess, evToolUse, map[string]interface{}{"id": "call_bare", "name": "delegate"})
	if got := log.take(sess, "anything", "", 0); got != "call_bare" {
		t.Fatalf("take(bare) = %q, want call_bare", got)
	}
	log.forget(sess)
	if len(log.sessions) != 0 {
		t.Fatalf("forget left %v", log.sessions)
	}
}

func TestIsDelegateToolNameReadsEachEnginesSpelling(t *testing.T) {
	for _, name := range []string{"mcp__orbit__delegate", "orbit__delegate", "delegate", "orbit_delegate"} {
		if !isDelegateToolName(name) {
			t.Errorf("%s is not read as delegate", name)
		}
	}
	for _, name := range []string{"mcp__orbit__task_get", "Task", "delegate_work", "mcp__other__delegates"} {
		if isDelegateToolName(name) {
			t.Errorf("%s is read as delegate", name)
		}
	}
}

// An approval a runner-side bridge (Codex, Kimi, Cursor, DSH, Antigravity) files under a SubAgent's context is the
// card approvalBodyOfPrompt files for a Claude child: it names the run and its call id carries the run's prefix.
func TestSubagentApprovalBodyNamesTheRun(t *testing.T) {
	body := map[string]interface{}{"toolName": "Bash", "input": map[string]interface{}{"command": "ls"}, "toolUseId": "call_1"}
	if got := subagentApprovalBody(context.Background(), body); !reflect.DeepEqual(got, body) {
		t.Fatalf("a session's own card was changed: %v", got)
	}
	ctx, cancel := context.WithCancel(withSubagentApprovals(context.Background(), "run7"))
	defer cancel()
	got, _ := subagentApprovalBody(ctx, body).(map[string]interface{})
	if got["toolUseId"] != "run7:call_1" || got["subagentRunId"] != "run7" || got["toolName"] != "Bash" {
		t.Fatalf("SubAgent card = %v", got)
	}
	if body["toolUseId"] != "call_1" || body["subagentRunId"] != nil {
		t.Fatalf("the bridge's body was modified: %v", body)
	}
	again, _ := subagentApprovalBody(ctx, got).(map[string]interface{})
	if again["toolUseId"] != "run7:call_1" {
		t.Fatalf("a prefixed id was prefixed again: %v", again["toolUseId"])
	}
}

// Every engine of the task has a child runner, and the claim it is launched from carries the run id (which every
// engine's `orbit mcp` reads to leave delegate out), the preamble and no delegate.
func TestEveryEngineHasAChildRunner(t *testing.T) {
	for _, engine := range []string{providerClaude, providerCodex, providerKimi, providerCursor, providerDsh, providerOpenCode, providerAntigravity} {
		if subagentChildRunners[engine] == nil {
			t.Errorf("no child runner for %s", engine)
		}
	}
	parent := &ClaimedSession{SessionID: "s", Provider: providerCodex, RuntimeSessionID: "parent-thread",
		Agent: AgentExecConfig{Provider: providerCodex, PermissionMode: "acceptEdits", Env: map[string]string{"A": "1"}}}
	child := subagentChildJob(parent, AgentExecConfig{Provider: providerCodex, Env: map[string]string{"B": "2"}, PermissionMode: "acceptEdits"},
		subagentDefinition{Name: "explore", Readonly: true}, "run9", providerCodex, "")
	if child.Agent.Env[envSubagentRunID] != "run9" || child.Agent.Env["B"] != "2" || child.Agent.Env["A"] != "" {
		t.Fatalf("child env = %v", child.Agent.Env)
	}
	if child.RuntimeSessionID != "" || child.Agent.PermissionMode != "plan" {
		t.Fatalf("child continues %q in %q", child.RuntimeSessionID, child.Agent.PermissionMode)
	}
	if !strings.HasPrefix(child.Agent.AppendSystemPrompt, subagentPreamble) {
		t.Fatalf("child system prompt = %q", child.Agent.AppendSystemPrompt)
	}
	// Only Claude Code takes a denylist for it: Kimi and DSH refuse any, and every `orbit mcp` leaves delegate out.
	if len(child.Agent.DisallowedTools) != 0 {
		t.Fatalf("a Codex child was given a denylist: %v", child.Agent.DisallowedTools)
	}
	claudeChild := subagentChildJob(parent, AgentExecConfig{}, subagentDefinition{Readonly: true}, "run9", providerClaude, "")
	if !containsString(claudeChild.Agent.DisallowedTools, delegateEngineToolName) || !containsString(claudeChild.Agent.DisallowedTools, "Write") {
		t.Fatalf("a Claude child may delegate or write: %v", claudeChild.Agent.DisallowedTools)
	}
	if parent.Agent.Env[envSubagentRunID] != "" || parent.RuntimeSessionID != "parent-thread" {
		t.Fatalf("the parent's claim was changed: %+v", parent)
	}
	if got := subagentEngine(AgentExecConfig{Provider: "kimi"}, parent); got != providerKimi {
		t.Fatalf("engine of a kimi target = %s", got)
	}
	if got := subagentEngine(AgentExecConfig{}, parent); got != providerCodex {
		t.Fatalf("engine with no target = %s, want the parent's", got)
	}
}

func TestSubagentResumeRefusalSaysWhy(t *testing.T) {
	subagentResumeless["test-engine"] = "it keeps no conversation"
	defer delete(subagentResumeless, "test-engine")
	err := subagentResumeRefusal(&subagentRecord{RunID: "r1", Engine: "test-engine", EngineSession: "x"})
	if err == nil || !strings.Contains(err.Error(), "cannot resume") || !strings.Contains(err.Error(), "it keeps no conversation") {
		t.Fatalf("refusal = %v", err)
	}
	if err := subagentResumeRefusal(&subagentRecord{RunID: "r2", Engine: providerCodex}); err == nil {
		t.Fatal("a Codex run with no thread was resumed")
	}
	if err := subagentResumeRefusal(&subagentRecord{RunID: "r3", Engine: providerCodex, EngineSession: "thr"}); err != nil {
		t.Fatalf("a Codex run with its thread was refused: %v", err)
	}
}
