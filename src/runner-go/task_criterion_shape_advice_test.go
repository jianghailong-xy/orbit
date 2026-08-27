package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const criterionAdviceJSON = `{
  "code":"TASK_CRITERION_SHAPE_ADVICE",
  "kind":"ADVISORY",
  "advisory":true,
  "message":"Use EXECUTABLE, or explain this override.",
  "suggestedCriterion":"EXECUTABLE",
  "requiredAction":"USE_SUGGESTED_CRITERION_OR_EXPLAIN_OVERRIDE"
}`

func criterionAdviceText(t *testing.T, result map[string]interface{}) string {
	t.Helper()
	content, ok := result["content"].([]map[string]interface{})
	if !ok || len(content) != 1 {
		t.Fatalf("tool content = %#v", result["content"])
	}
	text, _ := content[0]["text"].(string)
	return text
}

func TestCLITaskCreatePresentsCriterionAdviceAndForwardsTheOverride(t *testing.T) {
	var bodies []map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		bodies = append(bodies, body)
		if body["completionCriterionOverrideReason"] == nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(criterionAdviceJSON))
			return
		}
		_, _ = w.Write([]byte(`{"id":"task-1"}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	base := []string{
		"create", "--title", "mechanical task",
		"--acceptance-criteria", "spec 通过",
		"--completion-criterion", "HUMAN_SIGNOFF",
		"--json",
	}
	var out bytes.Buffer
	err := cmdTaskCLI(base, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "advice: TASK_CRITERION_SHAPE_ADVICE") ||
		strings.Contains(err.Error(), "refused: TASK_CRITERION_SHAPE_ADVICE") {
		t.Fatalf("criterion advice = %v", err)
	}

	reason := "L0 cannot safely validate its own execution path"
	out.Reset()
	withOverride := append([]string{}, base[:len(base)-1]...)
	withOverride = append(withOverride, "--completion-criterion-override-reason", reason, "--json")
	if err := cmdTaskCLI(withOverride, strings.NewReader(""), &out); err != nil {
		t.Fatalf("criterion override: %v", err)
	}
	if got := bodies[1]["completionCriterionOverrideReason"]; got != reason {
		t.Fatalf("completionCriterionOverrideReason = %#v", got)
	}
}

func TestMCPTaskCreatePresentsCriterionAdviceAndForwardsSingleAndBatchOverrides(t *testing.T) {
	var bodies []map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		bodies = append(bodies, body)
		if body["completionCriterionOverrideReason"] == nil && body["tasks"] == nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(criterionAdviceJSON))
			return
		}
		_, _ = w.Write([]byte(`{"id":"task-1","tasks":[]}`))
	}))
	defer srv.Close()
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}

	result := mcp.callTool("task_create", map[string]interface{}{
		"title": "mechanical task", "acceptanceCriteria": "spec 通过",
		"completionCriterion": "HUMAN_SIGNOFF",
	})
	text := criterionAdviceText(t, result)
	if result["isError"] != true || !strings.Contains(text, "advice: TASK_CRITERION_SHAPE_ADVICE") ||
		strings.Contains(text, "refused: TASK_CRITERION_SHAPE_ADVICE") {
		t.Fatalf("MCP criterion advice = %#v", result)
	}

	reason := "a human must authorize the irreversible migration"
	result = mcp.callTool("task_create", map[string]interface{}{
		"title": "migration", "acceptanceCriteria": "spec 通过",
		"completionCriterion": "HUMAN_SIGNOFF", "completionCriterionOverrideReason": reason,
	})
	if result["isError"] == true || bodies[1]["completionCriterionOverrideReason"] != reason {
		t.Fatalf("MCP override = %#v, body = %#v", result, bodies[1])
	}

	batchReason := "release authority belongs to a person"
	result = mcp.callTool("task_create_batch", map[string]interface{}{
		"tasks": []interface{}{map[string]interface{}{
			"title": "release", "completionCriterion": "HUMAN_SIGNOFF",
			"completionCriterionOverrideReason": batchReason,
		}},
		"dryRun": true,
	})
	items, _ := bodies[2]["tasks"].([]interface{})
	item, _ := items[0].(map[string]interface{})
	if result["isError"] == true || item["completionCriterionOverrideReason"] != batchReason {
		t.Fatalf("MCP batch override = %#v, body = %#v", result, bodies[2])
	}

	prop := mcpToolProps(toolDescriptors(false, false), "task_create")["completionCriterionOverrideReason"]
	if prop == nil {
		t.Fatal("task_create MCP schema omits completionCriterionOverrideReason")
	}
}
