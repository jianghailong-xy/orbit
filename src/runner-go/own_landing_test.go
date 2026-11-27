package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Revision 42 (§12.7): a task's own work session is offered session_get with Session orchestration off, saying it
// reads only its task's landing; a session of no task is not, and with orchestration on the tool is the ordinary one.
func TestOwnTaskLandingSessionGetListedForATaskSessionWithOrchestrationOff(t *testing.T) {
	describe := func(srv *mcpServer) (bool, string) {
		for _, tool := range srv.listedToolDescriptors() {
			if name, _ := tool["name"].(string); name == "session_get" {
				description, _ := tool["description"].(string)
				return true, description
			}
		}
		return false, ""
	}
	listed, description := describe(&mcpServer{sessionID: "work-session", taskID: "task-1"})
	if !listed {
		t.Fatalf("session_get is not offered to a task's work session with orchestration off")
	}
	if !strings.Contains(description, "its own task's landing") || !strings.Contains(description, "Any other session is refused") {
		t.Fatalf("session_get offered for its own landing does not say so: %q", description)
	}
	if listed, _ := describe(&mcpServer{sessionID: "plain-session"}); listed {
		t.Fatalf("session_get is offered with orchestration off to a session of no task")
	}
	if listed, _ := describe(&mcpServer{taskID: "task-1"}); listed {
		t.Fatalf("session_get is offered with orchestration off without a session context")
	}
	listed, description = describe(&mcpServer{sessionID: "work-session", taskID: "task-1", allowOrchestration: true})
	if !listed || strings.Contains(description, "Session orchestration is off") {
		t.Fatalf("with orchestration on, session_get is the ordinary tool: listed=%v %q", listed, description)
	}
	// The catalogue's own description names the landing read, for every session that has the tool.
	if !strings.Contains(description, "A task's own work session may read its own task's landing") {
		t.Fatalf("session_get does not describe the landing read: %q", description)
	}
}

// With orchestration off, a task's work session's session_get goes to the own-landing door as that session and without
// any orchestration credential, and the server's answer comes back as it is.
func TestOwnTaskLandingSessionGetSendsTheSessionWithoutACredential(t *testing.T) {
	var path, sessionHeader, tokenHeader string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		sessionHeader = r.Header.Get("X-Orbit-Session-Id")
		tokenHeader = r.Header.Get("X-Orbit-Session-Token")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"landing-1","sessionKind":"LANDING","landing":{"sessionId":"landing-1"}}`))
	}))
	defer server.Close()
	srv := &mcpServer{t: NewTransport(server.URL, "tok"), sessionID: "work-session", taskID: "task-1"}
	res := srv.callTool("session_get", map[string]interface{}{"sessionId": "landing-1", "summary": false})
	if res["isError"] == true {
		t.Fatalf("session_get of its own landing failed: %#v", res)
	}
	if path != "/api/runner/landings/landing-1" || sessionHeader != "work-session" || tokenHeader != "" {
		t.Fatalf("request = %s session=%q token=%q", path, sessionHeader, tokenHeader)
	}
	content, _ := res["content"].([]map[string]interface{})
	if len(content) == 0 || !strings.Contains(content[0]["text"].(string), `"sessionKind": "LANDING"`) {
		t.Fatalf("session_get answer = %#v", res["content"])
	}
	// A session of no task still gets the orchestration-off refusal, without a request.
	path = ""
	plain := &mcpServer{t: NewTransport(server.URL, "tok"), sessionID: "plain-session"}
	if res := plain.callTool("session_get", map[string]interface{}{"sessionId": "landing-1"}); res["isError"] != true || path != "" {
		t.Fatalf("session_get with orchestration off and no task: %#v, request %q", res, path)
	}
}
