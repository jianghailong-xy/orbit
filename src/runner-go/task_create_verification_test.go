package main

import (
	"bytes"
	"strings"
	"testing"
)

// The pairing rule needs a spelling on this side, and only on the single door: a subject and the
// check that settles it are written in one call, and the batch door expresses that with verifiesRef
// between its own items. So `verification` is a property of task_create's schema and NOT of a batch
// item — advertising it there would invite a call the server refuses.
func TestMCPTaskCreateTakesTheVerificationSubObjectAndBatchItemsDoNot(t *testing.T) {
	tools := toolDescriptors(false, false)

	props := mcpToolProps(tools, "task_create")
	verification, _ := props["verification"].(map[string]interface{})
	if verification == nil {
		t.Fatal("task_create has no verification property: a subject cannot be filed with its check")
	}
	if verification["type"] != "object" {
		t.Fatalf("verification type = %v, want object", verification["type"])
	}
	sub, _ := verification["properties"].(map[string]interface{})
	for _, field := range []string{"title", "assigneeId", "description"} {
		if sub[field] == nil {
			t.Fatalf("verification has no %s property", field)
		}
	}
	required, ok := verification["required"].([]string)
	if !ok || len(required) != 1 || required[0] != "title" {
		t.Fatalf("verification required = %v, want [title]", verification["required"])
	}

	batch := mcpToolProps(tools, "task_create_batch")
	tasks, _ := batch["tasks"].(map[string]interface{})
	items, _ := tasks["items"].(map[string]interface{})
	itemProps, _ := items["properties"].(map[string]interface{})
	if itemProps["verification"] != nil {
		t.Fatal("task_create_batch items advertise verification, which the server refuses there")
	}
	if itemProps["verifiesRef"] == nil {
		t.Fatal("task_create_batch items lost verifiesRef, the pairing the batch door does take")
	}
}

func TestMCPTaskCreateSendsTheVerificationThrough(t *testing.T) {
	srv, bodies := captureCreateBody(t, "/api/runner/tasks")

	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create", map[string]interface{}{
		"title":               "完成门禁：X 通过独立 QA",
		"completionCriterion": "VERIFICATION",
		"completionPolicy":    "VERIFICATION_PASSED",
		"verification": map[string]interface{}{
			"title":      "[VERIFY] 完成门禁：X 通过独立 QA",
			"assigneeId": "agent-2",
		},
	})
	if res["isError"] == true {
		t.Fatalf("task_create returned an error: %#v", res["content"])
	}

	body := (*bodies)[0]
	verification, _ := body["verification"].(map[string]interface{})
	if verification == nil {
		t.Fatalf("task_create body dropped verification: %#v", body)
	}
	if verification["title"] != "[VERIFY] 完成门禁：X 通过独立 QA" || verification["assigneeId"] != "agent-2" {
		t.Fatalf("verification passed through as %#v", verification)
	}
	if body["completionPolicy"] != "VERIFICATION_PASSED" {
		t.Fatalf("the subject's own declaration changed: %#v", body)
	}
}

// The CLI takes three flat flags rather than a JSON blob, the same way --handoff-reason spells the
// handoff object. A named title is what makes the sub-object present at all.
func TestTaskCLICreateBuildsTheVerificationSubObject(t *testing.T) {
	srv, bodies := captureCreateBody(t, "/api/runner/tasks")
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "")
	t.Setenv("ORBIT_AGENT_ID", "")

	var out bytes.Buffer
	err := cmdTaskCLI([]string{
		"create",
		"--title", "完成门禁：X 通过独立 QA",
		"--completion-criterion", "VERIFICATION",
		"--completion-policy", "VERIFICATION_PASSED",
		"--project-id", "proj-1",
		"--verification-title", "[VERIFY] 完成门禁：X 通过独立 QA",
		"--verification-assignee-id", "agent-2",
		"--verification-description", "核实上一条是否真的完成",
		"--json",
	}, strings.NewReader(""), &out)
	if err != nil {
		t.Fatalf("task create: %v", err)
	}

	body := (*bodies)[0]
	verification, _ := body["verification"].(map[string]interface{})
	if verification == nil {
		t.Fatalf("cli dropped verification: %#v", body)
	}
	if verification["title"] != "[VERIFY] 完成门禁：X 通过独立 QA" {
		t.Fatalf("verification title = %v", verification["title"])
	}
	if verification["assigneeId"] != "agent-2" {
		t.Fatalf("verification assigneeId = %v", verification["assigneeId"])
	}
	if verification["description"] != "核实上一条是否真的完成" {
		t.Fatalf("verification description = %v", verification["description"])
	}
	if _, present := verification["projectId"]; present {
		t.Fatalf("cli invented a project for the check: %#v", verification)
	}
}

// Both refusals are local: a verifier is a task, and a task with no title is not one; and a row
// cannot be the check of another task and the subject of a check of its own.
func TestTaskCLICreateRefusesHalfAVerifierAndTwoSpellingsOfOneLink(t *testing.T) {
	srv, bodies := captureCreateBody(t, "/api/runner/tasks")
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "")
	t.Setenv("ORBIT_AGENT_ID", "")

	base := []string{"create", "--title", "T", "--completion-criterion", "VERIFICATION"}
	for _, args := range [][]string{
		append(append([]string{}, base...), "--verification-assignee-id", "agent-2"),
		append(append([]string{}, base...), "--verification-title", "  "),
		append(append([]string{}, base...), "--verification-title", "[VERIFY] T", "--verifies-task-id", "t-1"),
	} {
		var out bytes.Buffer
		err := cmdTaskCLI(args, strings.NewReader(""), &out)
		if err == nil {
			t.Fatalf("%v was accepted; want a local refusal", args)
		}
	}
	if len(*bodies) != 0 {
		t.Fatalf("a refused create still reached the server: %#v", *bodies)
	}
}
