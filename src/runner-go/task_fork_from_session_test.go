package main

import (
	"strings"
	"testing"
)

// forkFromSession (docs/task-fork-from-session-design.md §2.1, SR55) is declared on both create doors,
// and until this runner takes the snapshot itself (phase P2) both refuse it before anything is posted:
// a flag the server never saw would create a task that starts from the workspace's checkout instead of
// this session's, which is the one outcome the fork exists to prevent.

func TestMCPTaskToolsDeclareForkFromSession(t *testing.T) {
	tools := toolDescriptors(false, false)
	batch := mcpToolProps(tools, "task_create_batch")
	tasks, _ := batch["tasks"].(map[string]interface{})
	items, _ := tasks["items"].(map[string]interface{})
	itemProps, _ := items["properties"].(map[string]interface{})

	for label, props := range map[string]map[string]interface{}{
		"task_create":            mcpToolProps(tools, "task_create"),
		"task_create_batch item": itemProps,
	} {
		fork, ok := props["forkFromSession"].(map[string]interface{})
		if !ok || fork["type"] != "boolean" {
			t.Fatalf("%s forkFromSession = %#v, want a boolean", label, props["forkFromSession"])
		}
		description, _ := fork["description"].(string)
		for _, phrase := range []string{"not committed", "this machine", "code binding"} {
			if !strings.Contains(description, phrase) {
				t.Errorf("%s forkFromSession description does not say %q: %q", label, phrase, description)
			}
		}
	}
	if _, declared := mcpToolProps(tools, "task_update")["forkFromSession"]; declared {
		t.Errorf("task_update declares forkFromSession: a fork is a fact of the task's creation and is never edited")
	}
}

func TestMCPTaskCreateRefusesForkFromSessionUntilTheSnapshotExists(t *testing.T) {
	srv, bodies := captureCreateBody(t, "/api/runner/tasks")
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	single := mcp.callTool("task_create", map[string]interface{}{
		"title":               "Continue from here",
		"forkFromSession":     true,
		"completionCriterion": "EVIDENCE_JUDGMENT",
	})
	batch := mcp.callTool("task_create_batch", map[string]interface{}{
		"tasks": []interface{}{
			map[string]interface{}{"title": "Plain", "completionCriterion": "EVIDENCE_JUDGMENT"},
			map[string]interface{}{"title": "Forked", "forkFromSession": true, "completionCriterion": "EVIDENCE_JUDGMENT"},
		},
	})
	for label, res := range map[string]map[string]interface{}{"task_create": single, "task_create_batch": batch} {
		if res["isError"] != true {
			t.Fatalf("%s accepted forkFromSession: %#v", label, res["content"])
		}
		text := resultText(res)
		if !strings.Contains(text, "forkFromSession is not available on this runner yet") {
			t.Errorf("%s refusal does not say why: %q", label, text)
		}
	}
	if !strings.Contains(resultText(batch), "tasks[1]:") {
		t.Errorf("the batch refusal does not name the item: %q", resultText(batch))
	}
	if len(*bodies) != 0 {
		t.Fatalf("a refused fork still posted %d request(s): %#v", len(*bodies), *bodies)
	}
}
