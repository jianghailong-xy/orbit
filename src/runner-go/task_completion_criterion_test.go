package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

var completionCriteria = []string{"EXECUTABLE", "VERIFICATION", "HUMAN_SIGNOFF"}

func stringEnum(t *testing.T, property map[string]interface{}) []string {
	t.Helper()
	raw, ok := property["enum"].([]string)
	if !ok {
		t.Fatalf("enum = %#v", property["enum"])
	}
	return raw
}

func TestMCPTaskCreateExposesAndForwardsTheThreePeerCompletionCriteria(t *testing.T) {
	create := mcpToolProps(toolDescriptors(false, false), "task_create")
	update := mcpToolProps(toolDescriptors(false, false), "task_update")
	for _, props := range []map[string]interface{}{create, update} {
		criterion, ok := props["completionCriterion"].(map[string]interface{})
		if !ok {
			t.Fatalf("completionCriterion schema = %#v", props["completionCriterion"])
		}
		if got := strings.Join(stringEnum(t, criterion), ","); got != strings.Join(completionCriteria, ",") {
			t.Fatalf("completionCriterion enum = %q", got)
		}
		description := strings.ToLower(criterion["description"].(string))
		if !strings.Contains(description, "peer") || strings.Contains(description, "after failure") {
			t.Fatalf("criterion is not documented as a peer choice: %q", criterion["description"])
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
	for _, criterion := range completionCriteria {
		result := mcp.callTool("task_create", map[string]interface{}{
			"title": "criterion " + criterion, "completionCriterion": criterion,
		})
		if result["isError"] == true {
			t.Fatalf("task_create %s failed: %#v", criterion, result["content"])
		}
	}
	for i, criterion := range completionCriteria {
		if bodies[i]["completionCriterion"] != criterion {
			t.Fatalf("body %d = %#v", i, bodies[i])
		}
	}
}

func TestCLITaskCreateExposesAndForwardsTheThreePeerCompletionCriteria(t *testing.T) {
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
	configureCLITestRunner(t, srv.URL)

	for _, criterion := range completionCriteria {
		args := []string{"create", "--title", "criterion " + criterion,
			"--completion-criterion", criterion, "--json"}
		if criterion == "EXECUTABLE" {
			args = append(args, "--acceptance-command", "true", "--acceptance-expected-exit-code", "0")
		}
		if criterion == "VERIFICATION" {
			args = append(args, "--completion-policy", "VERIFICATION_PASSED")
		}
		var out bytes.Buffer
		if err := cmdTaskCLI(args, strings.NewReader(""), &out); err != nil {
			t.Fatalf("task create %s: %v", criterion, err)
		}
	}
	for i, criterion := range completionCriteria {
		if bodies[i]["completionCriterion"] != criterion {
			t.Fatalf("body %d = %#v", i, bodies[i])
		}
	}

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{
		"create", "--title", "bad", "--completion-criterion", "ESCALATE_TO_HUMAN",
	}, strings.NewReader(""), &out); err == nil {
		t.Fatal("CLI accepted a fourth completion criterion")
	}
}

func TestTaskCompletionCriterionStaysInHelpCapabilitiesCLIAndMCP(t *testing.T) {
	for _, action := range []string{"create", "update"} {
		if !strings.Contains(taskActionHelp[action], "--completion-criterion") {
			t.Errorf("task %s help omits --completion-criterion", action)
		}
	}
	for _, tool := range []string{"task_create", "task_update"} {
		found := false
		for _, spec := range baseCLICapabilities {
			if spec.Tool == tool {
				found = strings.Contains(strings.Join(spec.Arguments, " "), "--completion-criterion")
			}
		}
		if !found {
			t.Errorf("%s capabilities omit --completion-criterion", tool)
		}
		if _, ok := mcpToolProps(toolDescriptors(false, false), tool)["completionCriterion"]; !ok {
			t.Errorf("%s MCP schema omits completionCriterion", tool)
		}
	}
}

func TestRunnerCLITaskCreateRefusesImplicitHumanSignoffBeforeHTTP(t *testing.T) {
	var requests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{"id":"task-1"}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdTaskCLI([]string{"create", "--title", "ambiguous"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "implicitly create HUMAN_SIGNOFF") ||
		!strings.Contains(err.Error(), "completionCriterion") {
		t.Fatalf("implicit criterion error = %v", err)
	}
	if requests != 0 {
		t.Fatalf("implicit HUMAN_SIGNOFF made %d HTTP requests", requests)
	}

	err = cmdTaskCLI([]string{
		"create-batch", "--tasks", `[{"title":"explicit","completionCriterion":"HUMAN_SIGNOFF"},{"title":"ambiguous"}]`,
	}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "tasks[1]") ||
		!strings.Contains(err.Error(), "implicitly create HUMAN_SIGNOFF") {
		t.Fatalf("implicit batch criterion error = %v", err)
	}
	if requests != 0 {
		t.Fatalf("implicit batch HUMAN_SIGNOFF made %d HTTP requests", requests)
	}

	for _, args := range [][]string{
		{"create", "--title", "verifier", "--verifies-task-id", "subject"},
		{"create", "--title", "executable", "--acceptance-command", "true", "--acceptance-expected-exit-code", "0"},
		{"create", "--title", "subject", "--completion-policy", "VERIFICATION_PASSED"},
	} {
		if err := cmdTaskCLI(args, strings.NewReader(""), &out); err == nil ||
			!strings.Contains(err.Error(), "completionCriterion is required") {
			t.Errorf("related fields inferred a completion criterion for %v: %v", args, err)
		}
	}
	if requests != 0 {
		t.Fatalf("criterion inference attempts made %d HTTP requests", requests)
	}
}

func TestMCPTaskCreateRefusesImplicitHumanSignoffBeforeHTTP(t *testing.T) {
	var requests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{"id":"task-1"}`))
	}))
	defer srv.Close()
	mcp := &mcpServer{agentID: "agent-1", sessionID: "session-1", t: NewTransport(srv.URL, "tok")}

	for label, result := range map[string]map[string]interface{}{
		"single": mcp.callTool("task_create", map[string]interface{}{"title": "ambiguous"}),
		"verifier-shape": mcp.callTool("task_create", map[string]interface{}{
			"title": "verifier", "verifiesTaskId": "subject",
		}),
		"executable-shape": mcp.callTool("task_create", map[string]interface{}{
			"title": "executable", "acceptanceCommand": "true", "acceptanceExpectedExitCode": 0,
		}),
		"verification-policy-shape": mcp.callTool("task_create", map[string]interface{}{
			"title": "subject", "completionPolicy": "VERIFICATION_PASSED",
		}),
		"batch": mcp.callTool("task_create_batch", map[string]interface{}{
			"tasks": []interface{}{map[string]interface{}{"title": "ambiguous"}},
		}),
		"batch-verifies-ref": mcp.callTool("task_create_batch", map[string]interface{}{
			"tasks": []interface{}{map[string]interface{}{
				"title": "verifier", "verifiesRef": "subject",
			}},
		}),
	} {
		if result["isError"] != true {
			t.Errorf("%s implicit criterion result = %#v", label, result)
			continue
		}
		content, _ := result["content"].([]map[string]interface{})
		if len(content) == 0 || !strings.Contains(content[0]["text"].(string), "implicitly create HUMAN_SIGNOFF") {
			t.Errorf("%s refusal = %#v", label, result)
		}
	}
	if requests != 0 {
		t.Fatalf("implicit MCP HUMAN_SIGNOFF made %d HTTP requests", requests)
	}
}

func TestMCPTaskCreateSchemasRequireAnExplicitCompletionCriterion(t *testing.T) {
	var singleSchema, batchItemSchema map[string]interface{}
	for _, tool := range toolDescriptors(false, false) {
		schema, _ := tool["inputSchema"].(map[string]interface{})
		switch tool["name"] {
		case "task_create":
			singleSchema = schema
		case "task_create_batch":
			properties, _ := schema["properties"].(map[string]interface{})
			tasks, _ := properties["tasks"].(map[string]interface{})
			batchItemSchema, _ = tasks["items"].(map[string]interface{})
		}
	}

	for label, schema := range map[string]map[string]interface{}{
		"single":     singleSchema,
		"batch item": batchItemSchema,
	} {
		required, ok := schema["required"].([]string)
		if !ok {
			t.Fatalf("%s required = %#v", label, schema["required"])
		}
		hasCriterion := false
		for _, field := range required {
			hasCriterion = hasCriterion || field == "completionCriterion"
		}
		if !hasCriterion {
			t.Errorf("%s does not require completionCriterion: %#v", label, required)
		}
		if _, exists := schema["anyOf"]; exists {
			t.Errorf("%s still exposes criterion inference alternatives: %#v", label, schema["anyOf"])
		}
	}
}
