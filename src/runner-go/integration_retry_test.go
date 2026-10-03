package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// integration_retry is a coordinator's one way to run a DONE task's failed landing again (contract
// §2.3 J-T1b). Like ask_owner and open_item_resolve it is not a `project_*` tool by name: it acts on
// a task's landing, and the closed set in TestMCPExposesExactlyTheProjectTools is the set of tools
// that read and write a project. It is in the base tools because the conversation that needs it — a
// coordinator — is given no orchestration grant for it: it opens no session.
func TestMCPIntegrationRetryIsPartOfTheBaseTools(t *testing.T) {
	for _, tools := range [][]map[string]interface{}{toolDescriptors(false, false), toolDescriptors(true, true)} {
		if !hasMCPTool(tools, "integration_retry") {
			t.Fatal("integration_retry missing from the tools")
		}
		props := mcpToolProps(tools, "integration_retry")
		if len(props) != 3 {
			t.Fatalf("integration_retry properties = %#v", props)
		}
		for _, want := range []string{"projectId", "taskId", "reason"} {
			if _, ok := props[want]; !ok {
				t.Fatalf("integration_retry does not take %q: %#v", want, props)
			}
		}
		if got := mcpToolRequired(t, tools, "integration_retry"); strings.Join(got, ",") != "projectId,taskId,reason" {
			t.Fatalf("integration_retry required = %#v", got)
		}
	}
	// What a model has to know before it reaches for the door: which failures it answers, that
	// task_start is NOT the way, and that a conflict is refused here.
	desc := mcpToolDescription(toolDescriptors(false, false), "integration_retry")
	for _, want := range []string{"CHECK_FAILED", "CHECK_TIMED_OUT", "ERROR", "task_start", "CONFLICT", "task_reopen"} {
		if !strings.Contains(desc, want) {
			t.Fatalf("integration_retry's description does not mention %q: %q", want, desc)
		}
	}
}

func TestMCPIntegrationRetryPostsTheReasonAsTheCallingSession(t *testing.T) {
	var method, path, session string
	var body map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		session = r.Header.Get("X-Orbit-Session-Id")
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(`{"taskId":"34Y7Utvsd47A14DjMzIzD","jobId":"34YQqf0aGNxJ3SuXyDxyF",` +
			`"generation":2,"failureClass":"CHECK_FAILED","supersededItemIds":[]}`))
	}))
	defer srv.Close()

	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "34Y7Myo7G89Vk0fVpelbt"}
	res := mcp.callTool("integration_retry", map[string]interface{}{
		"projectId": "34Y7My8sqhKLWtmCQYv1l",
		"taskId":    "34Y7Utvsd47A14DjMzIzD",
		"reason":    "  the merge check's runner-go baseline was repaired on the project branch  ",
	})
	if res["isError"] == true {
		t.Fatalf("integration_retry returned an error: %#v", res["content"])
	}
	if method != http.MethodPost ||
		path != "/api/runner/projects/34Y7My8sqhKLWtmCQYv1l/tasks/34Y7Utvsd47A14DjMzIzD/integration/retry" {
		t.Fatalf("integration_retry hit %s %s", method, path)
	}
	// The acting session IS the authority the server checks against the project's coordinator
	// pointer: a rerun sent without it would be one nobody proved the caller may ask for.
	if session != "34Y7Myo7G89Vk0fVpelbt" {
		t.Fatalf("integration_retry session header = %q", session)
	}
	if body["reason"] != "the merge check's runner-go baseline was repaired on the project branch" {
		t.Fatalf("integration_retry sent reason %#v", body["reason"])
	}
	if len(body) != 1 {
		t.Fatalf("integration_retry sent more than the reason: %#v", body)
	}
	content, _ := res["content"].([]map[string]interface{})
	text, _ := content[0]["text"].(string)
	if !strings.Contains(text, "if it fails, a new item reaches you") || !strings.Contains(text, `"generation": 2`) {
		t.Fatalf("integration_retry's result does not say what happens next: %q", text)
	}
}

func TestMCPIntegrationRetryRequiresAProjectATaskAndAReason(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("integration_retry reached the server without what it needs")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "34Y7Myo7G89Vk0fVpelbt"}
	for _, args := range []map[string]interface{}{
		{"taskId": "task-1", "reason": "fixed"},
		{"projectId": "proj-1", "reason": "fixed"},
		{"projectId": "proj-1", "taskId": "task-1"},
		{"projectId": "proj-1", "taskId": "task-1", "reason": " \n\t "},
	} {
		if res := mcp.callTool("integration_retry", args); res["isError"] != true {
			t.Fatalf("integration_retry accepted %#v", args)
		}
	}
}

// A refusal is the server's, with its code first: the model reads which rule it met — the landing
// is in flight, the failure is the owner's — and the raw body underneath.
func TestMCPIntegrationRetryPassesTheServersRefusalThrough(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"INTEGRATION_RETRY_IN_FLIGHT","message":"generation 2 of this ` +
			`task's landing is already QUEUED: nothing new is queued beside it.","statusCode":409}`))
	}))
	defer srv.Close()
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "34Y7Myo7G89Vk0fVpelbt"}
	res := mcp.callTool("integration_retry", map[string]interface{}{
		"projectId": "proj-1", "taskId": "task-1", "reason": "the baseline was repaired",
	})
	if res["isError"] != true {
		t.Fatalf("a refused rerun was reported as done: %#v", res["content"])
	}
	content, _ := res["content"].([]map[string]interface{})
	text, _ := content[0]["text"].(string)
	if !strings.Contains(text, "INTEGRATION_RETRY_IN_FLIGHT") || !strings.Contains(text, "409") {
		t.Fatalf("integration_retry hid the server's refusal: %q", text)
	}
}
