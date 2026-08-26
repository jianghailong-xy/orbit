package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestTaskEvidenceFourCLITruthsAndMCPDescriptorsAgree(t *testing.T) {
	for _, usage := range []string{
		"orbit task evidence-list [task-id] [--json]",
		"orbit task evidence-submit [task-id] (--evidence JSON | --evidence-file -)",
	} {
		if !strings.Contains(taskHelp, usage) {
			t.Errorf("group help is missing %q", usage)
		}
	}
	for _, action := range []string{"evidence-list", "evidence-submit"} {
		if !strings.Contains(taskActionHelp[action], "Usage:") {
			t.Errorf("per-action usage is missing for %s", action)
		}
	}

	capabilities := map[string]bool{}
	for _, capability := range baseCLICapabilities {
		capabilities[capability.Tool] = true
	}
	descriptors := map[string]bool{}
	for _, descriptor := range toolDescriptors(false, false) {
		name, _ := descriptor["name"].(string)
		descriptors[name] = true
	}
	for _, tool := range []string{"task_evidence_list", "task_evidence_submit"} {
		if !capabilities[tool] || !descriptors[tool] {
			t.Errorf("%s missing: capability=%v descriptor=%v", tool, capabilities[tool], descriptors[tool])
		}
	}
}

func TestTaskEvidenceCLIAndMCPUseTheSameWireStructure(t *testing.T) {
	type observed struct {
		method  string
		path    string
		agent   string
		session string
		body    map[string]interface{}
	}
	var calls []observed
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := observed{
			method:  r.Method,
			path:    r.URL.Path,
			agent:   r.Header.Get("X-Orbit-Agent-Id"),
			session: r.Header.Get("X-Orbit-Session-Id"),
		}
		if r.Method == http.MethodPost {
			if err := json.NewDecoder(r.Body).Decode(&call.body); err != nil {
				t.Errorf("decode evidence body: %v", err)
			}
		}
		calls = append(calls, call)
		w.Header().Set("content-type", "application/json")
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(`[{"id":"ev-1","revision":"1","evidence":{"exitCode":0}}]`))
			return
		}
		_, _ = w.Write([]byte(`{"id":"ev-1","revision":"1","evidence":{"exitCode":0}}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_TASK_ID", "task-1")
	t.Setenv("ORBIT_SESSION_ID", "session-1")
	t.Setenv("ORBIT_AGENT_ID", "agent-1")

	var cliSubmit bytes.Buffer
	if err := cmdTaskCLI([]string{
		"evidence-submit", "--evidence", `{"exitCode":0,"rawOutput":"ok\n"}`,
		"--idempotency-key", "turn-1", "--json",
	}, strings.NewReader(""), &cliSubmit); err != nil {
		t.Fatal(err)
	}
	mcp := &mcpServer{
		t:         NewTransport(srv.URL, "runner-secret"),
		taskID:    "task-1",
		sessionID: "session-1",
		agentID:   "agent-1",
	}
	result := mcp.callTool("task_evidence_submit", map[string]interface{}{
		"evidence":       map[string]interface{}{"exitCode": float64(0), "rawOutput": "ok\n"},
		"idempotencyKey": "turn-1",
	})
	if result["isError"] == true {
		t.Fatalf("MCP submit failed: %#v", result)
	}

	var cliList bytes.Buffer
	if err := cmdTaskCLI([]string{"evidence-list", "--json"}, strings.NewReader(""), &cliList); err != nil {
		t.Fatal(err)
	}
	result = mcp.callTool("task_evidence_list", map[string]interface{}{})
	if result["isError"] == true {
		t.Fatalf("MCP list failed: %#v", result)
	}

	if len(calls) != 4 {
		t.Fatalf("calls = %#v", calls)
	}
	for i, call := range calls {
		if call.path != "/api/runner/tasks/task-1/evidence" {
			t.Errorf("call %d path = %q", i, call.path)
		}
	}
	if calls[0].method != http.MethodPost || calls[1].method != http.MethodPost ||
		calls[2].method != http.MethodGet || calls[3].method != http.MethodGet {
		t.Fatalf("methods = %#v", calls)
	}
	if !reflect.DeepEqual(calls[0].body, calls[1].body) {
		t.Fatalf("CLI body %#v != MCP body %#v", calls[0].body, calls[1].body)
	}
	for _, call := range calls[:2] {
		if call.agent != "agent-1" || call.session != "session-1" {
			t.Errorf("attribution headers = agent %q session %q", call.agent, call.session)
		}
	}
}

func TestTaskEvidenceSubmitRequiresStructuredEvidenceAndSourceSession(t *testing.T) {
	t.Setenv("ORBIT_TASK_ID", "task-1")
	t.Setenv("ORBIT_SESSION_ID", "")
	var out bytes.Buffer
	err := cmdTaskCLI([]string{"evidence-submit", "--evidence", `{"ok":true}`}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "ORBIT_SESSION_ID is required") {
		t.Fatalf("missing source Session error = %v", err)
	}
	err = cmdTaskCLI([]string{"evidence-submit", "--evidence", `["prose"]`, "--source-session-id", "s"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "one JSON object") {
		t.Fatalf("scalar/array evidence error = %v", err)
	}
}
