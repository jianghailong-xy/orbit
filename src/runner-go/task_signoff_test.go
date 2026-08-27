package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTaskSignoffIsAHeadlessHumanCLIDoorNotAnMCPTool(t *testing.T) {
	tools := toolDescriptors(false, false)
	if hasMCPTool(tools, "task_signoff") {
		t.Fatal("a coordinator/task session must not receive a control that signs for the person")
	}
	if !strings.Contains(taskActionHelp["signoff"], "HUMAN_SIGNOFF judgment request") ||
		!strings.Contains(taskActionHelp["signoff"], "request id, evidence digest") ||
		!strings.Contains(taskActionHelp["signoff"], "same transaction") {
		t.Fatalf("task signoff help omits request binding/atomicity: %q", taskActionHelp["signoff"])
	}
	foundCLI := false
	for _, capability := range baseCLICapabilities {
		if capability.Tool == "task_signoff" {
			foundCLI = true
			if !capability.HeadlessOnly {
				t.Fatal("task_signoff CLI capability must be headless-only")
			}
		}
	}
	if !foundCLI {
		t.Fatal("task_signoff missing from CLI capabilities")
	}
	t.Setenv("ORBIT_SESSION_ID", "session-1")
	for _, capability := range buildCLICapabilities("/usr/local/bin/orbit").Capabilities {
		if capability.ID == "task_signoff" {
			t.Fatal("task_signoff was advertised to a running coordinator")
		}
	}
	t.Setenv("ORBIT_SESSION_ID", "")
	foundHeadless := false
	for _, capability := range buildCLICapabilities("/usr/local/bin/orbit").Capabilities {
		if capability.ID == "task_signoff" {
			foundHeadless = true
			if capability.MCPInputSchema != nil {
				t.Fatalf("headless-only signoff claimed an MCP schema: %#v", capability.MCPInputSchema)
			}
		}
	}
	if !foundHeadless {
		t.Fatal("headless human capability document omitted task_signoff")
	}
}

func TestMCPTaskSignoffIsNotDispatchable(t *testing.T) {
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{"status":"DONE"}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{
		taskID:    "task-1",
		sessionID: "session-1",
		t:         NewTransport(srv.URL, "token"),
	}
	result := mcp.callTool("task_signoff", map[string]interface{}{
		"requestId":      "request-1",
		"evidenceDigest": strings.Repeat("a", 64),
		"evidence":       "reviewed build 42",
	})
	if result["isError"] != true || requests != 0 {
		t.Fatalf("unadvertised task_signoff = %#v, requests = %d", result, requests)
	}
}

func TestMCPBlankTaskSignoffAlsoCannotReachTransport(t *testing.T) {
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{"status":"DONE"}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{taskID: "task-1", t: NewTransport(srv.URL, "token")}
	result := mcp.callTool("task_signoff", map[string]interface{}{
		"requestId": "request-1", "evidenceDigest": strings.Repeat("a", 64), "evidence": " \n\t",
	})
	if result["isError"] != true || requests != 0 {
		t.Fatalf("blank task_signoff = %#v, requests = %d", result, requests)
	}
}

func TestCLITaskSignoffUsesHeadlessHumanDoor(t *testing.T) {
	var gotSession string
	var gotBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSession = r.Header.Get("X-Orbit-Session-Id")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`{"status":"DONE"}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "")

	var out bytes.Buffer
	if err := cmdTaskCLI(
		[]string{"signoff", "task-1", "--request-id", "request-1", "--evidence-digest", strings.Repeat("b", 64), "--evidence-file", "-", "--json"},
		strings.NewReader("human reviewed pg evidence\n"),
		&out,
	); err != nil {
		t.Fatal(err)
	}
	if gotSession != "" {
		t.Fatalf("headless signoff unexpectedly carried session %q", gotSession)
	}
	if gotBody["evidence"] != "human reviewed pg evidence\n" {
		t.Fatalf("headless signoff body = %#v", gotBody)
	}
	if gotBody["requestId"] != "request-1" || gotBody["evidenceDigest"] != strings.Repeat("b", 64) {
		t.Fatalf("headless signoff request binding = %#v", gotBody)
	}
}
