package main

import (
	"bytes"
	"strings"
	"testing"
)

const failureSuccessorHandoffFixture = `{"obligationId":"11111111-1111-4111-8111-111111111111","obligationRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","routeDecisionId":"22222222-2222-4222-8222-222222222222","routeDecisionDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}`

func TestTaskCLICreateSendsFailureSuccessorHandoffAsOneObject(t *testing.T) {
	srv, bodies := captureCreateBody(t, "/api/runner/tasks")
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "33333333-3333-4333-8333-333333333333")
	t.Setenv("ORBIT_AGENT_ID", "44444444-4444-4444-8444-444444444444")

	var out bytes.Buffer
	err := cmdTaskCLI([]string{
		"create",
		"--title", "continue failed work",
		"--completion-criterion", "EXECUTABLE",
		"--acceptance-command", "true",
		"--acceptance-expected-exit-code", "0",
		"--supersedes-task-id", "55555555-5555-4555-8555-555555555555",
		"--failure-successor-handoff", failureSuccessorHandoffFixture,
		"--json",
	}, strings.NewReader(""), &out)
	if err != nil {
		t.Fatal(err)
	}

	if len(*bodies) != 1 {
		t.Fatalf("requests = %d", len(*bodies))
	}
	body := (*bodies)[0]
	if body["supersedesTaskId"] != "55555555-5555-4555-8555-555555555555" {
		t.Fatalf("supersedesTaskId = %#v", body["supersedesTaskId"])
	}
	handoff, ok := body["failureSuccessorHandoff"].(map[string]interface{})
	if !ok {
		t.Fatalf("failureSuccessorHandoff = %#v", body["failureSuccessorHandoff"])
	}
	for key, want := range map[string]string{
		"obligationId":        "11111111-1111-4111-8111-111111111111",
		"obligationRevision":  strings.Repeat("a", 64),
		"routeDecisionId":     "22222222-2222-4222-8222-222222222222",
		"routeDecisionDigest": strings.Repeat("b", 64),
	} {
		if handoff[key] != want {
			t.Fatalf("failureSuccessorHandoff.%s = %#v, want %q", key, handoff[key], want)
		}
	}
}

func TestTaskCLIFailureSuccessorHandoffRequiresItsSourceAndValidJSON(t *testing.T) {
	for name, tc := range map[string]struct {
		args []string
		want string
	}{
		"source": {
			args: []string{"create", "--title", "successor", "--completion-criterion", "HUMAN_SIGNOFF", "--failure-successor-handoff", failureSuccessorHandoffFixture},
			want: "requires --supersedes-task-id",
		},
		"json": {
			args: []string{"create", "--title", "successor", "--completion-criterion", "HUMAN_SIGNOFF", "--supersedes-task-id", "source", "--failure-successor-handoff", "[]"},
			want: "must be one JSON object",
		},
	} {
		t.Run(name, func(t *testing.T) {
			var out bytes.Buffer
			err := cmdTaskCLI(tc.args, strings.NewReader(""), &out)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestFailureSuccessorHandoffIsSingleCreateOnlyAndPassedWhole(t *testing.T) {
	tools := toolDescriptors(false, false)
	single := mcpToolProps(tools, "task_create")
	handoff, ok := single["failureSuccessorHandoff"].(map[string]interface{})
	if !ok || handoff["type"] != "object" || handoff["additionalProperties"] != false {
		t.Fatalf("task_create failureSuccessorHandoff schema = %#v", single["failureSuccessorHandoff"])
	}

	batch := mcpToolProps(tools, "task_create_batch")
	tasks, _ := batch["tasks"].(map[string]interface{})
	items, _ := tasks["items"].(map[string]interface{})
	itemProps, _ := items["properties"].(map[string]interface{})
	if itemProps["failureSuccessorHandoff"] != nil {
		t.Fatalf("task_create_batch leaked failureSuccessorHandoff: %#v", itemProps)
	}

	srv, bodies := captureCreateBody(t, "/api/runner/tasks")
	mcp := &mcpServer{agentID: "agent-1", sessionID: "session-1", t: NewTransport(srv.URL, "tok")}
	input := map[string]interface{}{
		"obligationId":        "11111111-1111-4111-8111-111111111111",
		"obligationRevision":  strings.Repeat("a", 64),
		"routeDecisionId":     "22222222-2222-4222-8222-222222222222",
		"routeDecisionDigest": strings.Repeat("b", 64),
	}
	res := mcp.callTool("task_create", map[string]interface{}{
		"title":                   "continue failed work",
		"completionCriterion":     "HUMAN_SIGNOFF",
		"supersedesTaskId":        "55555555-5555-4555-8555-555555555555",
		"failureSuccessorHandoff": input,
	})
	if res["isError"] == true {
		t.Fatalf("task_create returned an error: %#v", res["content"])
	}
	got, _ := (*bodies)[0]["failureSuccessorHandoff"].(map[string]interface{})
	for key, want := range input {
		if got[key] != want {
			t.Fatalf("failureSuccessorHandoff.%s = %#v, want %#v", key, got[key], want)
		}
	}
}
