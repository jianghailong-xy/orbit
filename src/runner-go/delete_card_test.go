package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The runner and agent deletes (`orbit runner delete`, `orbit agent delete`, runner_delete, agent_delete):
// each puts the deletion on a confirmation card in front of the account owner and deletes only on their
// yes. The card carries the id alone — the server fills in what the owner reads — and the delete is the
// orchestration door, as the calling session.

// deleteCardServer answers the approval poll with `decision` and a delete with `deleted`, recording every
// request in order, the card it was asked with, and the session headers each delete carried.
func deleteCardServer(t *testing.T, decision string) (*httptest.Server, *[]string, map[string]interface{}, *[]string) {
	t.Helper()
	var hits, sessions []string
	filed := map[string]interface{}{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.Method+" "+r.URL.Path)
		switch {
		case strings.Contains(r.URL.Path, "/approvals/"):
			_, _ = w.Write([]byte(decision))
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			_ = json.NewDecoder(r.Body).Decode(&filed)
			_, _ = w.Write([]byte(`{"id":"ap1","status":"PENDING"}`))
		default:
			sessions = append(sessions, r.Header.Get("X-Orbit-Session-Id")+"/"+r.Header.Get("X-Orbit-Session-Token"))
			_, _ = w.Write([]byte(`{"ok":true,"deleted":{"name":"instance-20261027-071926"}}`))
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &hits, filed, &sessions
}

var deleteCases = []struct {
	name     string
	cli      func([]string, *bytes.Buffer) error
	argv     []string
	tool     string
	args     map[string]interface{}
	toolName string
	card     map[string]interface{}
	write    string
}{
	{
		name: "runner", cli: func(a []string, out *bytes.Buffer) error { return cmdRunnerCLI(a, out) },
		argv: []string{"delete", "--runner-id", "34n3sQFO9ew7TA9mYAxff", "--json"},
		tool: "runner_delete", args: map[string]interface{}{"runnerId": "34n3sQFO9ew7TA9mYAxff"},
		toolName: runnerDeleteApprovalToolName, card: map[string]interface{}{"runnerId": "34n3sQFO9ew7TA9mYAxff"},
		write: "DELETE /api/runner/runners/34n3sQFO9ew7TA9mYAxff",
	},
	{
		name: "agent", cli: func(a []string, out *bytes.Buffer) error { return cmdAgentCLI(a, out) },
		argv: []string{"delete", "34nT1uGkwD5OvyhpTvoko", "--json"},
		tool: "agent_delete", args: map[string]interface{}{"agentId": "34nT1uGkwD5OvyhpTvoko"},
		toolName: agentDeleteApprovalToolName, card: map[string]interface{}{"agentId": "34nT1uGkwD5OvyhpTvoko"},
		write: "DELETE /api/runner/workspaces/34nT1uGkwD5OvyhpTvoko",
	},
}

func orchestratingCLISession(t *testing.T, serverURL string) {
	t.Helper()
	configureCLITestRunner(t, serverURL)
	t.Setenv(envMCPOrchestration, "true")
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envOrchestrationToken, "session-token")
	t.Setenv(envBgJobID, "")
}

func orchestratingMCP(serverURL string) *mcpServer {
	return &mcpServer{
		t: NewTransport(serverURL, "tok"), sessionID: "caller-session", orchestrationToken: "session-token", allowOrchestration: true,
	}
}

func TestDeletesAskTheOwnerThenDeleteAsTheCallingSession(t *testing.T) {
	for _, tc := range deleteCases {
		for _, door := range []string{"cli", "mcp"} {
			t.Run(tc.name+"/"+door, func(t *testing.T) {
				srv, hits, filed, sessions := deleteCardServer(t, `{"status":"ALLOWED"}`)
				var printed string
				if door == "cli" {
					orchestratingCLISession(t, srv.URL)
					var out bytes.Buffer
					if err := tc.cli(tc.argv, &out); err != nil {
						t.Fatalf("%v; hits = %v", err, *hits)
					}
					printed = out.String()
				} else {
					t.Setenv("ORBIT_HOME", t.TempDir())
					t.Setenv(envBgJobID, "")
					res := orchestratingMCP(srv.URL).callTool(tc.tool, tc.args)
					if res["isError"] == true {
						t.Fatalf("%s returned an error: %#v", tc.tool, res["content"])
					}
					printed = fmt.Sprintf("%v", res["content"])
				}
				// Ask, then delete — in that order, and the delete is the last thing done.
				if len(*hits) < 3 || (*hits)[0] != "POST /api/runner/sessions/caller-session/approvals" || (*hits)[len(*hits)-1] != tc.write {
					t.Fatalf("call order = %v", *hits)
				}
				if filed["toolName"] != tc.toolName {
					t.Fatalf("filed as %v", filed["toolName"])
				}
				if got, want := mustJSON(t, filed["input"]), mustJSON(t, tc.card); got != want {
					t.Fatalf("card input = %s, want the id alone: %s", got, want)
				}
				if len(*sessions) != 1 || (*sessions)[0] != "caller-session/session-token" {
					t.Fatalf("the delete went as %v, want the calling session", *sessions)
				}
				if !strings.Contains(printed, "instance-20261027-071926") {
					t.Fatalf("what was deleted is not reported: %q", printed)
				}
			})
		}
	}
}

func TestDeletesDeleteNothingWithoutAYes(t *testing.T) {
	for _, tc := range deleteCases {
		for _, door := range []string{"cli", "mcp"} {
			t.Run(tc.name+"/"+door, func(t *testing.T) {
				srv, hits, filed, _ := deleteCardServer(t, `{"status":"DENIED","message":"keep it, the test is not done"}`)
				var answer string
				if door == "cli" {
					orchestratingCLISession(t, srv.URL)
					var out bytes.Buffer
					err := tc.cli(tc.argv, &out)
					if err == nil {
						t.Fatalf("a declined delete exited 0: %q", out.String())
					}
					answer = err.Error()
				} else {
					t.Setenv("ORBIT_HOME", t.TempDir())
					t.Setenv(envBgJobID, "")
					res := orchestratingMCP(srv.URL).callTool(tc.tool, tc.args)
					if res["isError"] == true {
						t.Fatalf("a refusal is an answer, not an error: %#v", res["content"])
					}
					answer = fmt.Sprintf("%v", res["content"])
				}
				if wroteAnything(*hits) {
					t.Fatalf("deleted without a yes: %v", *hits)
				}
				if filed["toolName"] != tc.toolName {
					t.Fatalf("filed as %v", filed["toolName"])
				}
				if !strings.Contains(answer, "keep it, the test is not done") || !strings.Contains(answer, "nothing was deleted") {
					t.Fatalf("the refusal does not carry the owner's reason: %q", answer)
				}
			})
		}
	}
}

// Without the grant there is no card and no request: the MCP tool says the gate is closed, as every
// orchestration tool does, and an id that could steer the request elsewhere is refused before anyone is asked.
func TestMCPDeletesAskNobodyOutsideTheGate(t *testing.T) {
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	for _, tc := range deleteCases {
		closed := orchestratingMCP(srv.URL)
		closed.allowOrchestration = false
		if res := closed.callTool(tc.tool, tc.args); res["isError"] != true || !strings.Contains(fmt.Sprintf("%v", res["content"]), orchestrationOffMsg) {
			t.Fatalf("%s without orchestration = %#v", tc.tool, res["content"])
		}
		for field := range tc.args {
			if res := orchestratingMCP(srv.URL).callTool(tc.tool, map[string]interface{}{field: "../sessions"}); res["isError"] != true {
				t.Fatalf("%s took an id that is not one: %#v", tc.tool, res["content"])
			}
			if res := orchestratingMCP(srv.URL).callTool(tc.tool, map[string]interface{}{}); res["isError"] != true {
				t.Fatalf("%s ran without its id: %#v", tc.tool, res["content"])
			}
		}
	}
	if requests != 0 {
		t.Fatalf("a refused delete still made %d requests", requests)
	}
}

// A person can take longer to answer than an engine lets a tool call run, so both are handed to a
// runner-hosted job where the engine has such a deadline, as every other call that waits for the owner is.
func TestDeletesWaitForTheOwner(t *testing.T) {
	for _, tc := range deleteCases {
		if !waitsForTheOwner(tc.tool, tc.args) {
			t.Errorf("%s is not marked as waiting for the owner", tc.tool)
		}
	}
}
