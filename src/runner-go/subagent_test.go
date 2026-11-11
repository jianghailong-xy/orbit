package main

import (
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
