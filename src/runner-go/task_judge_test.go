package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Migration 0224 deleted the human step. `task_signoff` was headless-only precisely because it
// signed FOR a person, and hiding it from a live session was how that was enforced at this door.
// `task_judge` is the same call with that requirement gone, so the gate has to be gone too: a
// session that is expected to decide its own evidence judgment must be able to see the command.
func TestTaskJudgeIsAdvertisedInsideASessionAsWellAsHeadless(t *testing.T) {
	if !strings.Contains(taskActionHelp["judge"], "EVIDENCE_JUDGMENT judgment request") ||
		!strings.Contains(taskActionHelp["judge"], "request id, evidence digest") ||
		!strings.Contains(taskActionHelp["judge"], "same transaction") {
		t.Fatalf("task judge help omits request binding/atomicity: %q", taskActionHelp["judge"])
	}
	foundCLI := false
	for _, capability := range baseCLICapabilities {
		if capability.Tool == "task_judge" {
			foundCLI = true
			if capability.HeadlessOnly {
				t.Fatal("task_judge must not be headless-only: an agent has to be able to decide")
			}
		}
		if capability.Tool == "task_signoff" {
			t.Fatal("task_signoff must not survive the removal of the human step")
		}
	}
	if !foundCLI {
		t.Fatal("task_judge missing from CLI capabilities")
	}
	for _, sessionID := range []string{"session-1", ""} {
		t.Setenv("ORBIT_SESSION_ID", sessionID)
		found := false
		for _, capability := range buildCLICapabilities("/usr/local/bin/orbit").Capabilities {
			if capability.ID == "task_judge" {
				found = true
			}
		}
		if !found {
			t.Fatalf("capability document omitted task_judge for ORBIT_SESSION_ID=%q", sessionID)
		}
	}
}

// `task_signoff` is gone from every door; `task_judge` replaces it and IS dispatchable, because a
// criterion an agent is expected to decide has to be reachable from the agent's own tool surface.
func TestMCPTaskSignoffIsGoneAndTaskJudgeReplacedIt(t *testing.T) {
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
	tools := toolDescriptors(false, false)
	if hasMCPTool(tools, "task_signoff") {
		t.Fatal("task_signoff must not survive the removal of the human step")
	}
	if !hasMCPTool(tools, "task_judge") {
		t.Fatal("an agent that is expected to decide must be given task_judge")
	}

	result := mcp.callTool("task_signoff", map[string]interface{}{
		"requestId":      "request-1",
		"evidenceDigest": strings.Repeat("a", 64),
		"evidence":       "reviewed build 42",
	})
	if result["isError"] != true || requests != 0 {
		t.Fatalf("removed task_signoff = %#v, requests = %d", result, requests)
	}

	result = mcp.callTool("task_judge", map[string]interface{}{
		"requestId":      "request-1",
		"evidenceDigest": strings.Repeat("a", 64),
		"evidence":       "reviewed build 42",
	})
	if result["isError"] == true || requests != 1 {
		t.Fatalf("task_judge = %#v, requests = %d", result, requests)
	}
}

func TestMCPBlankTaskJudgeAlsoCannotReachTransport(t *testing.T) {
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{"status":"DONE"}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{taskID: "task-1", t: NewTransport(srv.URL, "token")}
	result := mcp.callTool("task_judge", map[string]interface{}{
		"requestId": "request-1", "evidenceDigest": strings.Repeat("a", 64), "evidence": " \n\t",
	})
	if result["isError"] != true || requests != 0 {
		t.Fatalf("blank task_judge = %#v, requests = %d", result, requests)
	}
}

func TestCLITaskJudgeCarriesTheDecidingSessionAndBindsTheRequest(t *testing.T) {
	var gotSession string
	var gotBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSession = r.Header.Get("X-Orbit-Session-Id")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`{"status":"DONE"}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	for _, sessionID := range []string{"", "session-9"} {
		t.Setenv("ORBIT_SESSION_ID", sessionID)
		gotSession, gotBody = "", nil
		var out bytes.Buffer
		if err := cmdTaskCLI(
			[]string{"judge", "task-1", "--request-id", "request-1", "--evidence-digest", strings.Repeat("b", 64), "--evidence-file", "-", "--json"},
			strings.NewReader("reviewed pg evidence\n"),
			&out,
		); err != nil {
			t.Fatal(err)
		}
		if gotSession != sessionID {
			t.Fatalf("judge carried session %q, want %q", gotSession, sessionID)
		}
		if gotBody["evidence"] != "reviewed pg evidence\n" {
			t.Fatalf("judge body = %#v", gotBody)
		}
		if gotBody["requestId"] != "request-1" || gotBody["evidenceDigest"] != strings.Repeat("b", 64) {
			t.Fatalf("judge request binding = %#v", gotBody)
		}
	}
}
