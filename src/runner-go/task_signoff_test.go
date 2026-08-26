package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTaskSignoffIsAlignedAcrossMCPAndCLI(t *testing.T) {
	tools := toolDescriptors(false, false)
	if !hasMCPTool(tools, "task_signoff") {
		t.Fatal("task_signoff missing from the base task tools")
	}
	props := mcpToolProps(tools, "task_signoff")
	requestID, _ := props["requestId"].(map[string]interface{})
	if requestID["type"] != "string" || requestID["minLength"] != 1 {
		t.Fatalf("task_signoff requestId schema = %#v", requestID)
	}
	digest, _ := props["evidenceDigest"].(map[string]interface{})
	if digest["pattern"] != "^[0-9a-fA-F]{64}$" {
		t.Fatalf("task_signoff evidenceDigest schema = %#v", digest)
	}
	evidence, _ := props["evidence"].(map[string]interface{})
	if evidence["type"] != "string" || evidence["minLength"] != 1 {
		t.Fatalf("task_signoff evidence schema = %#v", evidence)
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
		}
	}
	if !foundCLI {
		t.Fatal("task_signoff missing from CLI capabilities")
	}
}

func TestMCPTaskSignoffCarriesSessionAndEvidence(t *testing.T) {
	var gotMethod, gotPath, gotSession string
	var gotBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotSession = r.Header.Get("X-Orbit-Session-Id")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`{"status":"DONE"}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{
		taskID:    "task-1",
		sessionID: "session-1",
		t:         NewTransport(srv.URL, "token"),
	}
	digest := strings.Repeat("a", 64)
	result := mcp.callTool("task_signoff", map[string]interface{}{
		"requestId":      "request-1",
		"evidenceDigest": digest,
		"evidence":       "reviewed build 42",
	})
	if result["isError"] == true {
		t.Fatalf("task_signoff returned error: %#v", result["content"])
	}
	if gotMethod != http.MethodPost || gotPath != "/api/runner/tasks/task-1/signoff" {
		t.Fatalf("task_signoff hit %s %s", gotMethod, gotPath)
	}
	if gotSession != "session-1" {
		t.Fatalf("task_signoff session header = %q", gotSession)
	}
	if gotBody["evidence"] != "reviewed build 42" {
		t.Fatalf("task_signoff body = %#v", gotBody)
	}
	if gotBody["requestId"] != "request-1" || gotBody["evidenceDigest"] != digest {
		t.Fatalf("task_signoff request binding = %#v", gotBody)
	}
}

func TestTaskSignoffRejectsBlankEvidenceBeforeTransport(t *testing.T) {
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
