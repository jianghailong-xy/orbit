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

// A session's write to what decides a workspace's next session (agent_create, agent_update, `orbit agent
// create`, `orbit agent update`): put on a confirmation card in front of the account owner first, and written
// only on their yes, whatever the session's mode. A write of the rest of a workspace asks nobody.

// agentWriteServer answers the approval poll with `decision` and any other request as a write, recording
// the requests in order, the card, and the body the write carried.
func agentWriteServer(t *testing.T, decision string) (*httptest.Server, *[]string, map[string]interface{}, map[string]interface{}) {
	t.Helper()
	var hits []string
	filed, written := map[string]interface{}{}, map[string]interface{}{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.Method+" "+r.URL.Path)
		switch {
		case strings.Contains(r.URL.Path, "/approvals/"):
			_, _ = w.Write([]byte(decision))
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			_ = json.NewDecoder(r.Body).Decode(&filed)
			_, _ = w.Write([]byte(`{"id":"ap1","status":"PENDING"}`))
		default:
			_ = json.NewDecoder(r.Body).Decode(&written)
			_, _ = w.Write([]byte(`{"id":"34nT1uGkwD5OvyhpTvoko","name":"reviewer"}`))
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &hits, filed, written
}

// One write of each card field, at each door, in each spelling.
var agentCardWrites = []struct {
	field string
	flags []string
	value interface{}
}{
	{"env", []string{"--env", "REGION=eu"}, map[string]interface{}{"REGION": "eu"}},
	{"workDir", []string{"--work-dir", "/srv/other"}, "/srv/other"},
	{"systemPrompt", []string{"--system-prompt", "be brief"}, "be brief"},
	{"appendSystemPrompt", []string{"--append-system-prompt", "and careful"}, "and careful"},
	{"runnerId", []string{"--runner-id", "34n3sQFO9ew7TA9mYAxff"}, "34n3sQFO9ew7TA9mYAxff"},
	{"enableWorktree", []string{"--enable-worktree=false"}, false},
}

func agentWriteAt(t *testing.T, srvURL, door, tool string, field string, flags []string, value interface{}) (string, error) {
	t.Helper()
	if door == "cli" {
		orchestratingCLISession(t, srvURL)
		argv := []string{"create", "--name", "reviewer"}
		if tool == "agent_update" {
			argv = []string{"update", "34nT1uGkwD5OvyhpTvoko"}
		}
		var out bytes.Buffer
		err := cmdAgentCLI(append(append(argv, flags...), "--json"), &out)
		return out.String(), err
	}
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv(envBgJobID, "")
	args := map[string]interface{}{"name": "reviewer"}
	if tool == "agent_update" {
		args = map[string]interface{}{"agentId": "34nT1uGkwD5OvyhpTvoko"}
	}
	args[field] = value
	res := orchestratingMCP(srvURL).callTool(tool, args)
	if res["isError"] == true {
		return "", fmt.Errorf("%v", res["content"])
	}
	return fmt.Sprintf("%v", res["content"]), nil
}

func TestWorkspaceWriteAsksTheOwnerThenWritesWhatTheCardSaid(t *testing.T) {
	for _, tool := range []string{"agent_create", "agent_update"} {
		for _, door := range []string{"cli", "mcp"} {
			for _, tc := range agentCardWrites {
				t.Run(tool+"/"+door+"/"+tc.field, func(t *testing.T) {
					srv, hits, filed, written := agentWriteServer(t, `{"status":"ALLOWED"}`)
					if _, err := agentWriteAt(t, srv.URL, door, tool, tc.field, tc.flags, tc.value); err != nil {
						t.Fatalf("%v; hits = %v", err, *hits)
					}
					want := "POST /api/runner/agents"
					toolName, id := "orbit_agent_create", interface{}(nil)
					if tool == "agent_update" {
						want = "PATCH /api/runner/agents/34nT1uGkwD5OvyhpTvoko"
						toolName, id = "orbit_agent_update", "34nT1uGkwD5OvyhpTvoko"
					}
					if len(*hits) < 3 || (*hits)[0] != "POST /api/runner/sessions/caller-session/approvals" || (*hits)[len(*hits)-1] != want {
						t.Fatalf("call order = %v, want the card first and %q last", *hits, want)
					}
					if filed["toolName"] != toolName {
						t.Fatalf("filed as %v", filed["toolName"])
					}
					card, _ := filed["input"].(map[string]interface{})
					if card["agentId"] != id {
						t.Fatalf("card names agent %v, want %v", card["agentId"], id)
					}
					if got, want := mustJSON(t, card[tc.field]), mustJSON(t, tc.value); got != want {
						t.Fatalf("card %s = %s, want %s", tc.field, got, want)
					}
					if got, want := mustJSON(t, written[tc.field]), mustJSON(t, tc.value); got != want {
						t.Fatalf("write %s = %s, want %s", tc.field, got, want)
					}
				})
			}
		}
	}
}

func TestWorkspaceWriteWritesNothingWithoutAYes(t *testing.T) {
	for _, tool := range []string{"agent_create", "agent_update"} {
		for _, door := range []string{"cli", "mcp"} {
			t.Run(tool+"/"+door, func(t *testing.T) {
				srv, hits, filed, _ := agentWriteServer(t, `{"status":"DENIED","message":"not that key"}`)
				printed, err := agentWriteAt(t, srv.URL, door, tool, "env", []string{"--env", "REGION=eu"}, map[string]interface{}{"REGION": "eu"})
				answer := printed
				if door == "cli" {
					if err == nil {
						t.Fatalf("a declined write exited 0: %q", printed)
					}
					answer = err.Error()
				} else if err != nil {
					t.Fatalf("a refusal is an answer, not an error: %v", err)
				}
				if wroteAnything(*hits) {
					t.Fatalf("wrote without a yes: %v", *hits)
				}
				if len(filed) == 0 {
					t.Fatal("no card was filed")
				}
				if !strings.Contains(answer, "not that key") || !strings.Contains(answer, "nothing was written") {
					t.Fatalf("the refusal does not carry the owner's reason: %q", answer)
				}
			})
		}
	}
}

// `name`, `description` and `defaultMergeTarget` decide nothing about the next session: no card, one request.
func TestWorkspaceWriteOfTheRestAsksNobody(t *testing.T) {
	for _, door := range []string{"cli", "mcp"} {
		t.Run(door, func(t *testing.T) {
			srv, hits, filed, written := agentWriteServer(t, `{"status":"DENIED"}`)
			if _, err := agentWriteAt(t, srv.URL, door, "agent_update", "description", []string{"--description", "reviews"}, "reviews"); err != nil {
				t.Fatal(err)
			}
			if _, err := agentWriteAt(t, srv.URL, door, "agent_update", "defaultMergeTarget", []string{"--default-merge-target", "develop"}, "develop"); err != nil {
				t.Fatal(err)
			}
			if _, err := agentWriteAt(t, srv.URL, door, "agent_create", "description", []string{"--description", "reviews"}, "reviews"); err != nil {
				t.Fatal(err)
			}
			if len(*hits) != 3 || len(filed) != 0 {
				t.Fatalf("hits = %v, filed = %v", *hits, filed)
			}
			if written["name"] != "reviewer" {
				t.Fatalf("the create carried %v", written)
			}
		})
	}
}

// A person can take longer than an engine lets a tool call run, so a write that asks is handed to a
// runner-hosted job where the engine has such a deadline. A write that asks nobody is not, and a retired
// field the MCP tool does not forward does not make one ask.
func TestWorkspaceWriteWaitsForTheOwnerOnlyWhenItAsks(t *testing.T) {
	for _, tool := range []string{"agent_create", "agent_update"} {
		for _, tc := range agentCardWrites {
			if !waitsForTheOwner(tool, map[string]interface{}{tc.field: tc.value}) {
				t.Errorf("%s naming %s does not wait for the owner", tool, tc.field)
			}
		}
		for _, args := range []map[string]interface{}{
			{"name": "x"}, {"description": "x"}, {"defaultMergeTarget": "x"},
			{"permissionMode": "plan"}, {"provider": "codex"}, {"model": "m"}, {"env": nil},
		} {
			if waitsForTheOwner(tool, args) {
				t.Errorf("%s with %v waits for the owner", tool, args)
			}
		}
	}
}

// The retired fields earlier sessions still send write nothing: no body to send, and no card about it.
func TestWorkspaceWriteOfRetiredFieldsAsksNobodyAndWritesNothing(t *testing.T) {
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	res := orchestratingMCP(srv.URL).callTool("agent_update", map[string]interface{}{
		"agentId": "a1", "permissionMode": "plan", "provider": "codex", "model": "m",
	})
	if res["isError"] != true || requests != 0 {
		t.Fatalf("result = %#v after %d requests", res["content"], requests)
	}
}

// An engine with a call deadline hands the wait to a job. What the runner keeps and reports about that job
// names no value: the request reaches it through a private file it unlinks once open.
func TestWorkspaceWriteHandedToAJobKeepsTheValueOutOfTheJobRecord(t *testing.T) {
	const secret = "value-that-stays-out-of-the-job-record"
	// Don't Ask refuses every background job and still hosts this wait, which is not one. (Plan refuses the write
	// itself before any wait: TestBgOwnerWaitIsItsOwnOperation.)
	f := newGateFixture(t, "dontAsk")
	raw, err := bgSocketCall(f.socket, "tok", "owner_wait", map[string]interface{}{
		"tool":      "agent_update",
		"arguments": map[string]interface{}{"agentId": "a1", "env": map[string]interface{}{"API_KEY": secret}},
	})
	if err != nil {
		t.Fatalf("Don't Ask refused the hosted wait: %v", err)
	}
	if strings.Contains(string(raw), secret) || !strings.Contains(string(raw), envMCPTools+"='agent_update'") {
		t.Fatalf("the job's record = %s", raw)
	}
}
