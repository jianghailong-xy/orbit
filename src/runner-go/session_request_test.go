package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

// Session requests (docs/session-request-reply-contract.md §3): session_send and project_send carry
// expectReply, replyOptions and replyWithinSeconds, and session_reply answers a request. The MCP
// tools and the CLI are two doors onto one API, so each pair has to put the same request on the
// wire — and a send that asks for no reply must stay byte-for-byte the request every installed
// server knows.

type recordedCall struct {
	path string
	body map[string]interface{}
}

func recordingServer(t *testing.T, answer string) (*httptest.Server, *[]recordedCall) {
	t.Helper()
	var calls []recordedCall
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		raw, _ := io.ReadAll(r.Body)
		if len(raw) > 0 {
			decoder := json.NewDecoder(bytes.NewReader(raw))
			decoder.UseNumber()
			_ = decoder.Decode(&body)
		}
		calls = append(calls, recordedCall{r.URL.Path, body})
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(answer))
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func asksForReply(options []interface{}, within interface{}) map[string]interface{} {
	body := map[string]interface{}{"message": "merge now or wait?", "expectReply": true}
	if options != nil {
		body["replyOptions"] = options
	}
	if within != nil {
		body["replyWithinSeconds"] = within
	}
	return body
}

func TestSessionSendAsksForAReplyTheSameWayThroughBothDoors(t *testing.T) {
	srv, calls := recordingServer(t, `{"turnId":"turn-1","placement":"accepted","requestId":"34Yreq","replyBy":"2026-10-02T18:00:00.000Z"}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv(envMCPOrchestration, "true")
	t.Setenv("ORBIT_SESSION_ID", "parent-session")
	t.Setenv(envOrchestrationToken, "session-token")

	options := `[{"label":"merge now","description":"the checks are green"},{"label":"wait"}]`
	var out bytes.Buffer
	for _, args := range [][]string{
		{"send", "child", "--message", "merge now or wait?", "--expect-reply", "--reply-options", options, "--reply-within-seconds", "3600"},
		{"send", "child", "--message", "merge now or wait?", "--expect-reply"},
		{"send", "child", "--message", "merge now or wait?"},
	} {
		out.Reset()
		if err := cmdSessionCLI(args, strings.NewReader(""), &out); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
		if !strings.Contains(out.String(), `"requestId"`) {
			t.Fatalf("%v: the receipt was not handed back: %s", args, out.String())
		}
	}

	mcp := &mcpServer{
		sessionID: "parent-session", orchestrationToken: "session-token",
		allowOrchestration: true, t: NewTransport(srv.URL, "runner-secret"),
	}
	var decoded []interface{}
	if err := json.Unmarshal([]byte(options), &decoded); err != nil {
		t.Fatal(err)
	}
	for _, args := range []map[string]interface{}{
		{"sessionId": "child", "message": "merge now or wait?", "expectReply": true, "replyOptions": decoded, "replyWithinSeconds": 3600},
		{"sessionId": "child", "message": "merge now or wait?", "expectReply": true},
		// An explicit false is the default, not a third state.
		{"sessionId": "child", "message": "merge now or wait?", "expectReply": false},
	} {
		if res := mcp.callTool("session_send", args); res["isError"] == true {
			t.Fatalf("%v: session_send errored: %#v", args, res["content"])
		}
	}

	numbered := []interface{}{
		map[string]interface{}{"label": "merge now", "description": "the checks are green"},
		map[string]interface{}{"label": "wait"},
	}
	plain := map[string]interface{}{"message": "merge now or wait?"}
	want := []recordedCall{
		{"/api/runner/sessions/child/turns", asksForReply(numbered, json.Number("3600"))},
		{"/api/runner/sessions/child/turns", asksForReply(nil, nil)},
		{"/api/runner/sessions/child/turns", plain},
		{"/api/runner/sessions/child/turns", asksForReply(numbered, json.Number("3600"))},
		{"/api/runner/sessions/child/turns", asksForReply(nil, nil)},
		{"/api/runner/sessions/child/turns", plain},
	}
	if !reflect.DeepEqual(*calls, want) {
		t.Fatalf("requests =\n%#v\nwant\n%#v", *calls, want)
	}
}

func TestTheReplyFlagsMeanNothingWithoutExpectReplyAndAreChecked(t *testing.T) {
	srv, calls := recordingServer(t, `{}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv(envMCPOrchestration, "true")
	t.Setenv("ORBIT_SESSION_ID", "parent-session")
	t.Setenv(envOrchestrationToken, "session-token")

	for _, args := range [][]string{
		{"send", "child", "--message", "x", "--reply-options", `[{"label":"a"},{"label":"b"}]`},
		{"send", "child", "--message", "x", "--reply-within-seconds", "600"},
		{"send", "child", "--message", "x", "--expect-reply", "--reply-options", `[{"label":"only one"}]`},
		{"send", "child", "--message", "x", "--expect-reply", "--reply-options", `[{"label":"a"},{"label":"b","colour":"red"}]`},
		{"send", "child", "--message", "x", "--expect-reply", "--reply-options", `not json`},
		{"send", "child", "--message", "x", "--expect-reply", "--reply-within-seconds", "59"},
	} {
		if err := cmdSessionCLI(args, strings.NewReader(""), io.Discard); err == nil {
			t.Fatalf("%v was accepted", args)
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("a refused send still reached the server: %#v", *calls)
	}
}

func TestSessionReplyReachesTheRequestThroughBothDoors(t *testing.T) {
	srv, calls := recordingServer(t, `{"requestId":"34Yreq","state":"REPLIED","handOff":"QUEUED"}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv(envMCPOrchestration, "true")
	t.Setenv("ORBIT_SESSION_ID", "recipient-session")
	t.Setenv(envOrchestrationToken, "session-token")

	var out bytes.Buffer
	for _, args := range [][]string{
		{"reply", "34Yreq", "--option", "1", "--message", "after review"},
		{"reply", "34Yreq", "--message-file", "-"},
		{"reply", "34Yreq", "--option", "0"},
	} {
		out.Reset()
		stdin := ""
		if strings.Contains(strings.Join(args, " "), "--message-file") {
			stdin = "the port is 8443\n"
		}
		if err := cmdSessionCLI(args, strings.NewReader(stdin), &out); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
	}
	for _, args := range [][]string{
		{"reply", "34Yreq"},
		{"reply", "--message", "who am I answering?"},
		{"reply", "34Yreq", "--option", "4"},
	} {
		if err := cmdSessionCLI(args, strings.NewReader(""), io.Discard); err == nil {
			t.Fatalf("%v was accepted", args)
		}
	}

	mcp := &mcpServer{
		sessionID: "recipient-session", orchestrationToken: "session-token",
		allowOrchestration: true, t: NewTransport(srv.URL, "runner-secret"),
	}
	if res := mcp.callTool("session_reply", map[string]interface{}{
		"requestId": "34Yreq", "option": float64(1), "message": "after review",
	}); res["isError"] == true {
		t.Fatalf("session_reply errored: %#v", res["content"])
	}
	for _, args := range []map[string]interface{}{
		{"message": "no request named"},
		{"requestId": "34Yreq"},
		{"requestId": "34Yreq", "message": "   "},
	} {
		if res := mcp.callTool("session_reply", args); res["isError"] != true {
			t.Fatalf("%v was accepted", args)
		}
	}

	want := []recordedCall{
		{"/api/runner/session-requests/34Yreq/reply", map[string]interface{}{"option": json.Number("1"), "message": "after review"}},
		{"/api/runner/session-requests/34Yreq/reply", map[string]interface{}{"message": "the port is 8443\n"}},
		{"/api/runner/session-requests/34Yreq/reply", map[string]interface{}{"option": json.Number("0")}},
		{"/api/runner/session-requests/34Yreq/reply", map[string]interface{}{"option": json.Number("1"), "message": "after review"}},
	}
	if !reflect.DeepEqual(*calls, want) {
		t.Fatalf("requests =\n%#v\nwant\n%#v", *calls, want)
	}
}

func TestSessionReplyIsAnOrchestrationTool(t *testing.T) {
	names := func(includeOrchestration bool) map[string]bool {
		found := map[string]bool{}
		for _, tool := range toolDescriptors(true, includeOrchestration) {
			found[tool["name"].(string)] = true
		}
		return found
	}
	if !names(true)["session_reply"] {
		t.Fatal("session_reply is not offered where session_send is")
	}
	if names(false)["session_reply"] {
		t.Fatal("session_reply is offered with session orchestration switched off")
	}
	off := &mcpServer{sessionID: "recipient-session", allowOrchestration: false}
	if res := off.callTool("session_reply", map[string]interface{}{"requestId": "r", "message": "m"}); res["isError"] != true {
		t.Fatal("session_reply ran with session orchestration switched off")
	}
}

func TestProjectSendAsksTheCoordinatorForAReplyTheSameWayThroughBothDoors(t *testing.T) {
	srv, calls := recordingServer(t, `{"sessionId":"coord","created":false,"turn":{"clientTurnId":"k"},"requestId":"34Yreq","replyBy":"2026-10-02T18:00:00.000Z"}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv(envMCPOrchestration, "true")
	t.Setenv("ORBIT_SESSION_ID", "worker-session")
	t.Setenv(envOrchestrationToken, "session-token")

	var out bytes.Buffer
	if err := cmdProjectCLI([]string{"send", "proj-1", "--message", "blocked on a decision", "--expect-reply", "--reply-within-seconds", "600"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	mcp := &mcpServer{
		sessionID: "worker-session", orchestrationToken: "session-token",
		allowOrchestration: true, t: NewTransport(srv.URL, "runner-secret"),
	}
	if res := mcp.callTool("project_send", map[string]interface{}{
		"projectId": "proj-1", "message": "blocked on a decision", "expectReply": true, "replyWithinSeconds": 600,
	}); res["isError"] == true {
		t.Fatalf("project_send errored: %#v", res["content"])
	}
	body := map[string]interface{}{"message": "blocked on a decision", "expectReply": true, "replyWithinSeconds": json.Number("600")}
	want := []recordedCall{
		{"/api/runner/projects/proj-1/coordinator/messages", body},
		{"/api/runner/projects/proj-1/coordinator/messages", body},
	}
	if !reflect.DeepEqual(*calls, want) {
		t.Fatalf("requests =\n%#v\nwant\n%#v", *calls, want)
	}
}
