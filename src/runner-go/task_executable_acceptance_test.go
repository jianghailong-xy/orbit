package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTaskAcceptanceCommandProducesRawOutputAndExitCodeWithoutAModel(t *testing.T) {
	output, exitCode := runShellTurn(
		context.Background(),
		t.TempDir(),
		"printf 'raw output'; exit 7",
		func(string, map[string]interface{}) {},
		"acceptance-turn",
		nil,
	)
	if output != "raw output" || exitCode != 7 {
		t.Fatalf("shell result = (%q, %d), want raw output and exit 7", output, exitCode)
	}
}

func TestTaskAcceptanceCommandEnvironmentContract(t *testing.T) {
	execDir := t.TempDir()
	t.Setenv("N1_RUNNER_VALUE", "runner")
	t.Setenv("N1_OVERRIDE", "runner")
	t.Setenv("ORBIT_TASK_ID", "stale-task-context")
	output, exitCode := runShellTurn(
		context.Background(),
		execDir,
		`printf '%s\n%s\n%s\n%s\n%s' "$PWD" "$N1_RUNNER_VALUE" "$N1_AGENT_VALUE" "$N1_OVERRIDE" "${ORBIT_TASK_ID-unset}"`,
		func(string, map[string]interface{}) {},
		"acceptance-environment",
		map[string]string{
			"N1_AGENT_VALUE": "agent",
			"N1_OVERRIDE":    "agent",
			"ORBIT_TASK_ID":  "agent-task-context",
		},
	)
	want := strings.Join([]string{execDir, "runner", "agent", "agent", "unset"}, "\n")
	if exitCode != 0 || output != want {
		t.Fatalf("shell environment = (%q, %d), want (%q, 0)", output, exitCode, want)
	}

	doc, err := os.ReadFile(filepath.Join("..", "..", "docs", "task-completion-criteria.md"))
	if err != nil {
		t.Fatal(err)
	}
	for _, contract := range []string{
		"session execution directory", "runner process environment", "COORDINATOR_PG_URL",
	} {
		if !strings.Contains(string(doc), contract) {
			t.Errorf("executable environment documentation omits %q", contract)
		}
	}
}

func TestMCPTaskToolsDeclareAndForwardOnlyTheExecutableAcceptancePair(t *testing.T) {
	tools := toolDescriptors(false, false)
	create := mcpToolProps(tools, "task_create")
	update := mcpToolProps(tools, "task_update")
	if create["acceptanceCommand"].(map[string]interface{})["type"] != "string" {
		t.Fatalf("task_create acceptanceCommand schema = %#v", create["acceptanceCommand"])
	}
	if create["acceptanceExpectedExitCode"].(map[string]interface{})["type"] != "integer" {
		t.Fatalf("task_create acceptanceExpectedExitCode schema = %#v", create["acceptanceExpectedExitCode"])
	}
	for _, field := range []string{"acceptanceCommand", "acceptanceExpectedExitCode"} {
		if _, ok := update[field].(map[string]interface{})["type"].([]string); !ok {
			t.Fatalf("task_update %s is not nullable: %#v", field, update[field])
		}
	}

	var bodies []map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		bodies = append(bodies, body)
		_, _ = w.Write([]byte(`{"id":"task-1"}`))
	}))
	defer srv.Close()
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}
	if result := mcp.callTool("task_create", map[string]interface{}{
		"title":                      "mechanical",
		"acceptanceCommand":          "test -f result.json",
		"acceptanceExpectedExitCode": 0,
	}); result["isError"] == true {
		t.Fatalf("task_create failed: %#v", result["content"])
	}
	if result := mcp.callTool("task_update", map[string]interface{}{
		"taskId":                     "task-1",
		"acceptanceCommand":          nil,
		"acceptanceExpectedExitCode": nil,
	}); result["isError"] == true {
		t.Fatalf("task_update failed: %#v", result["content"])
	}
	if bodies[0]["acceptanceCommand"] != "test -f result.json" || bodies[0]["acceptanceExpectedExitCode"] != float64(0) {
		t.Fatalf("create body = %#v", bodies[0])
	}
	if command, present := bodies[1]["acceptanceCommand"]; !present || command != nil {
		t.Fatalf("update did not clear acceptanceCommand: %#v", bodies[1])
	}
	if exitCode, present := bodies[1]["acceptanceExpectedExitCode"]; !present || exitCode != nil {
		t.Fatalf("update did not clear acceptanceExpectedExitCode: %#v", bodies[1])
	}
}

func TestTaskAcceptanceShellNeverTakesTheBackgroundShortcut(t *testing.T) {
	userCommand, userBackground := shellTurnBackgroundCommand(&RunInboxResponse{Content: "check.sh &"})
	if userCommand != "check.sh" || !userBackground {
		t.Fatalf("ordinary shell = (%q, %v), want background check.sh", userCommand, userBackground)
	}

	acceptance := &RunInboxResponse{Content: "check.sh &", TaskAcceptance: true}
	_, acceptanceBackground := shellTurnBackgroundCommand(acceptance)
	if acceptanceBackground {
		t.Fatal("a task acceptance command was detached, so it cannot report a definitive exit code")
	}
}

func TestTaskAcceptanceProtocolPreservesZeroAndEmptyRawOutput(t *testing.T) {
	zero, empty := 0, ""
	body, err := json.Marshal(TurnCompleteRequest{
		TurnID: "turn-1", Status: stSucceeded,
		ShellExitCode: &zero, ShellOutput: &empty,
	})
	if err != nil {
		t.Fatal(err)
	}
	encoded := string(body)
	for _, want := range []string{`"shellExitCode":0`, `"shellOutput":""`} {
		if !strings.Contains(encoded, want) {
			t.Fatalf("turn completion %s omits %s", encoded, want)
		}
	}

	inbox, err := json.Marshal(RunInboxResponse{TurnID: "turn-1", Kind: "shell", TaskAcceptance: true})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(inbox), `"taskAcceptance":true`) {
		t.Fatalf("acceptance provenance omitted from inbox JSON: %s", inbox)
	}
}
