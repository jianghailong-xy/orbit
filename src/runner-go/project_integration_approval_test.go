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

// Changing a project's merge check from a session is a PROPOSAL the account owner answers, and these
// pin both halves of it: the card comes first and says what is being changed, and nothing but a yes
// reaches the door that writes. The other half of that decision — where a project's work LANDS — is
// refused outright, and a card must not be wasted asking about it.
//
// The server is the half that decides; `projects/project-integration-approval.pg.spec.ts` holds it
// to that. What is here is the runner's: which calls ask, what the card says, and that the session
// travels with the write so the server is looking for a card at all.

// One project read, as `project_get` and the card both take it.
const mergeCheckProjectRead = `{
  "id": "proj-1",
  "title": "Checkout rewrite",
  "integration": {
    "line": "MAIN",
    "ref": "main",
    "upstreamRef": "main",
    "source": "EXPLICIT",
    "locked": false,
    "mergeCheckCommand": "npm run lint",
    "mergeCheckTimeoutSeconds": 600
  }
}`

// mergeCheckServer answers the project read, the approval poll with `decision`, and the update
// itself. Every request is recorded in order, and the body of the last update is kept.
func mergeCheckServer(t *testing.T, decision string) (*httptest.Server, *[]string, *map[string]interface{}, *map[string]interface{}) {
	t.Helper()
	var hits []string
	filed := map[string]interface{}{}
	written := map[string]interface{}{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.Method+" "+r.URL.Path)
		switch {
		case strings.Contains(r.URL.Path, "/approvals/"):
			_, _ = w.Write([]byte(decision))
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			_ = json.NewDecoder(r.Body).Decode(&filed)
			_, _ = w.Write([]byte(`{"id":"ap1","status":"PENDING"}`))
		case r.Method == http.MethodPatch:
			_ = json.NewDecoder(r.Body).Decode(&written)
			_, _ = w.Write([]byte(`{"id":"proj-1","title":"Checkout rewrite"}`))
		default:
			_, _ = w.Write([]byte(mergeCheckProjectRead))
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &hits, &filed, &written
}

func updatedProject(hits []string) bool {
	for _, hit := range hits {
		if strings.HasPrefix(hit, "PATCH ") {
			return true
		}
	}
	return false
}

// Which calls ask the owner, and which do not. The line is the account owner's outright, so a
// request carrying one is refused by the server whatever the owner answers — asking about it would
// be an interruption with no yes that changes anything.
func TestWaitsForTheOwnerAsksForAMergeCheckAndNothingElse(t *testing.T) {
	for _, tc := range []struct {
		name string
		args map[string]interface{}
		want bool
	}{
		{"a merge check", map[string]interface{}{
			"projectId":   "proj-1",
			"integration": map[string]interface{}{"mergeCheckCommand": "npm test"},
		}, true},
		{"a merge check's budget alone", map[string]interface{}{
			"projectId":   "proj-1",
			"integration": map[string]interface{}{"mergeCheckTimeoutSeconds": 900},
		}, true},
		{"clearing the check", map[string]interface{}{
			"projectId":   "proj-1",
			"integration": map[string]interface{}{"mergeCheckCommand": nil},
		}, true},
		{"a merge check and its budget", map[string]interface{}{
			"projectId": "proj-1",
			"integration": map[string]interface{}{
				"mergeCheckCommand": "npm test", "mergeCheckTimeoutSeconds": 900,
			},
		}, true},
		// The prose fields are an agent's own to write, and asking about them is the interruption
		// the owner asked to be spared.
		{"a rename", map[string]interface{}{"projectId": "proj-1", "title": "another name"}, false},
		{"a new goal", map[string]interface{}{"projectId": "proj-1", "goal": "ship it"}, false},
		{"instructions", map[string]interface{}{"projectId": "proj-1", "instructions": "be careful"}, false},
		{"acceptance criteria", map[string]interface{}{
			"projectId": "proj-1",
			"acceptanceCriteriaItems": []interface{}{
				map[string]interface{}{"text": "it boots", "verificationMethod": "boot it"},
			},
		}, false},
		{"the revision fence", map[string]interface{}{"projectId": "proj-1", "expectedConfigRevision": "3"}, false},
		{"nothing at all", map[string]interface{}{"projectId": "proj-1"}, false},
		// The line: refused by the server, card or no card.
		{"the line", map[string]interface{}{
			"projectId":   "proj-1",
			"integration": map[string]interface{}{"line": "PROJECT_BRANCH"},
		}, false},
		{"the project branch", map[string]interface{}{
			"projectId":   "proj-1",
			"integration": map[string]interface{}{"projectBranchName": "refs/heads/project/next"},
		}, false},
		{"the upstream", map[string]interface{}{
			"projectId":   "proj-1",
			"integration": map[string]interface{}{"upstreamRef": "refs/heads/trunk"},
		}, false},
		// A line field beside the merge check a card WOULD cover: the request is refused whole, so
		// the card would be asked for nothing.
		{"the line and a merge check", map[string]interface{}{
			"projectId": "proj-1",
			"integration": map[string]interface{}{
				"line": "PROJECT_BRANCH", "mergeCheckCommand": "npm test",
			},
		}, false},
		// Anything else in the object, fail-closed: the server refuses what it was not asked about.
		{"an escalation window", map[string]interface{}{
			"projectId":   "proj-1",
			"integration": map[string]interface{}{"exceptionEscalationSeconds": 3600},
		}, false},
		// The line's own fields are not merge-check fields, and a spell-alike is not one either.
		{"a field nobody defined", map[string]interface{}{
			"projectId":   "proj-1",
			"integration": map[string]interface{}{"mergeCheck": "npm test"},
		}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := waitsForTheOwner("project_update", tc.args); got != tc.want {
				t.Fatalf("waitsForTheOwner(project_update, %v) = %v, want %v", tc.args, got, tc.want)
			}
		})
	}
	// The condition is project_update's alone. A create asks for its own reason — nothing is created
	// on the owner's behalf without their yes — whatever body it carries, and a read asks nobody.
	hostile := map[string]interface{}{"integration": map[string]interface{}{"mergeCheckCommand": "x"}}
	if !waitsForTheOwner("project_create", hostile) {
		t.Fatal("a project create stopped asking the owner")
	}
	for _, name := range []string{"project_delete", "project_get"} {
		if waitsForTheOwner(name, hostile) {
			t.Fatalf("%s was treated as asking about a merge check", name)
		}
	}
}

func TestMCPProjectUpdateAsksBeforeChangingTheMergeCheck(t *testing.T) {
	srv, hits, filed, written := mergeCheckServer(t, `{"status":"ALLOWED"}`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	res := mcp.callTool("project_update", map[string]interface{}{
		"projectId":   "proj-1",
		"integration": map[string]interface{}{"mergeCheckCommand": "npm test"},
	})

	if res["isError"] == true {
		t.Fatalf("project_update returned an error: %#v", res["content"])
	}
	// Read the project, ask about it, then write — in that order. A write that reached the door
	// before the card was filed would make the card a formality, and the server would refuse it.
	if len(*hits) < 3 ||
		(*hits)[0] != "GET /api/runner/projects/proj-1" ||
		(*hits)[1] != "POST /api/runner/sessions/sess-1/approvals" ||
		(*hits)[len(*hits)-1] != "PATCH /api/runner/projects/proj-1" {
		t.Fatalf("call order = %v", *hits)
	}
	if (*filed)["toolName"] != projectIntegrationApprovalToolName {
		t.Fatalf("filed as %v", (*filed)["toolName"])
	}
	// The card has to be answerable on its own: which project, what the check is NOW — read, not
	// remembered — and what it would become.
	input, _ := (*filed)["input"].(map[string]interface{})
	if input["projectId"] != "proj-1" || input["projectTitle"] != "Checkout rewrite" ||
		input["currentMergeCheckCommand"] != "npm run lint" ||
		input["mergeCheckCommand"] != "npm test" {
		t.Fatalf("card input = %#v", input)
	}
	if got, _ := input["currentMergeCheckTimeoutSeconds"].(float64); got != 600 {
		t.Fatalf("card currentMergeCheckTimeoutSeconds = %#v", input["currentMergeCheckTimeoutSeconds"])
	}
	// And what the card authorised is what was sent: the same change, on the same session.
	integration, _ := (*written)["integration"].(map[string]interface{})
	if integration["mergeCheckCommand"] != "npm test" || len(integration) != 1 {
		t.Fatalf("written integration = %#v", (*written)["integration"])
	}
}

// A denial and an abandoned card both leave the check alone, and both reach the model as an ordinary
// result carrying the reason — which is the owner saying what they want instead.
func TestMCPProjectUpdateWritesNothingWithoutAYes(t *testing.T) {
	for _, tc := range []struct{ decision, reason string }{
		{`{"status":"DENIED","message":"先别动这条"}`, "先别动这条"},
		{`{"status":"DENIED"}`, "denied by the user"},
		{`{"status":"ABANDONED","message":"the turn ended"}`, "the turn ended"},
	} {
		t.Run(tc.decision, func(t *testing.T) {
			srv, hits, _, _ := mergeCheckServer(t, tc.decision)
			mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

			res := mcp.callTool("project_update", map[string]interface{}{
				"projectId":   "proj-1",
				"integration": map[string]interface{}{"mergeCheckCommand": "npm test"},
			})

			if updatedProject(*hits) {
				t.Fatalf("wrote without a yes: %v", *hits)
			}
			if res["isError"] == true {
				t.Fatalf("a refusal is an answer, not an error: %#v", res["content"])
			}
			if body := fmt.Sprintf("%v", res["content"]); !strings.Contains(body, tc.reason) {
				t.Fatalf("reason not passed back: %v", body)
			}
		})
	}
}

// The line is not a question, and the owner is not interrupted with one: no card is filed, and the
// request goes to the door to be refused there — where the refusal can say what the rule is.
func TestMCPProjectUpdateDoesNotAskAboutTheLine(t *testing.T) {
	for _, integration := range []map[string]interface{}{
		{"line": "PROJECT_BRANCH"},
		{"projectBranchName": "refs/heads/project/next"},
		{"line": "MAIN", "mergeCheckCommand": "npm test"},
	} {
		srv, hits, _, written := mergeCheckServer(t, `{"status":"ALLOWED"}`)
		mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

		mcp.callTool("project_update", map[string]interface{}{
			"projectId": "proj-1", "integration": integration,
		})

		for _, hit := range *hits {
			if strings.Contains(hit, "/approvals") {
				t.Fatalf("a card was filed for %v: %v", integration, *hits)
			}
			if hit == "GET /api/runner/projects/proj-1" {
				t.Fatalf("the project was read for a card that is not filed: %v", *hits)
			}
		}
		if !updatedProject(*hits) {
			t.Fatalf("%v never reached the door: %v", integration, *hits)
		}
		// And nothing was invented on the way: the object the caller wrote is the object sent.
		if got := fmt.Sprintf("%v", (*written)["integration"]); got != fmt.Sprintf("%v", integration) {
			t.Fatalf("sent %v, want %v", got, integration)
		}
	}
}

// A rename, a goal, or a set of instructions is an agent's own to write, and reaching for a card
// would be the interruption the owner asked to be spared.
func TestMCPProjectUpdateWithoutAMergeCheckAsksNobody(t *testing.T) {
	srv, hits, _, _ := mergeCheckServer(t, `{"status":"DENIED"}`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	res := mcp.callTool("project_update", map[string]interface{}{
		"projectId": "proj-1", "title": "a better name",
	})

	if res["isError"] == true {
		t.Fatalf("rename failed: %#v", res["content"])
	}
	if len(*hits) != 1 || (*hits)[0] != "PATCH /api/runner/projects/proj-1" {
		t.Fatalf("hits = %v, want the write alone", *hits)
	}
}

// Headless there is nobody to ask, so the write goes ahead rather than blocking forever on a card no
// UI will ever show — and there is no card to build, so the project read is not spent.
func TestMCPProjectUpdateHeadlessDoesNotAsk(t *testing.T) {
	srv, hits, _, _ := mergeCheckServer(t, `{"status":"DENIED"}`)
	mcp := &mcpServer{agentID: "agent-1", t: NewTransport(srv.URL, "tok")}

	res := mcp.callTool("project_update", map[string]interface{}{
		"projectId":   "proj-1",
		"integration": map[string]interface{}{"mergeCheckCommand": "npm test"},
	})

	if res["isError"] == true {
		t.Fatalf("headless update failed: %#v", res["content"])
	}
	if len(*hits) != 1 || (*hits)[0] != "PATCH /api/runner/projects/proj-1" {
		t.Fatalf("headless hits = %v, want the write alone", *hits)
	}
}

// The CLI is the other door onto the same API, and an agent reaches it through its shell. Inside a
// session it asks exactly as the MCP tool does, or a refused change would simply be retried there —
// a gate one door wide is not a gate.
func TestCLIProjectUpdateInsideASessionAsksFirst(t *testing.T) {
	srv, hits, filed, _ := mergeCheckServer(t, `{"status":"ALLOWED"}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")
	t.Setenv("ORBIT_AGENT_ID", "agent-1")

	var out bytes.Buffer
	if err := cmdProjectCLI([]string{
		"update", "proj-1", "--merge-check-command", "npm test", "--json",
	}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}

	if (*filed)["toolName"] != projectIntegrationApprovalToolName {
		t.Fatalf("filed as %v; hits = %v", (*filed)["toolName"], *hits)
	}
	if last := (*hits)[len(*hits)-1]; last != "PATCH /api/runner/projects/proj-1" {
		t.Fatalf("last hit = %q, want the write after the card; hits = %v", last, *hits)
	}
}

func TestCLIProjectUpdateInsideASessionWritesNothingWhenDenied(t *testing.T) {
	srv, hits, _, _ := mergeCheckServer(t, `{"status":"DENIED","message":"先别动这条"}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")
	t.Setenv("ORBIT_AGENT_ID", "agent-1")

	var out bytes.Buffer
	err := cmdProjectCLI([]string{
		"update", "proj-1", "--merge-check-command", "npm test", "--json",
	}, strings.NewReader(""), &out)

	if err == nil || !strings.Contains(err.Error(), "先别动这条") {
		t.Fatalf("err = %v, want the refusal carrying its reason", err)
	}
	if updatedProject(*hits) {
		t.Fatalf("wrote without a yes: %v", *hits)
	}
}

// An update that carries no merge check asks nobody AND says nothing about the session, exactly as
// it always has (`TestProjectReadUpdateAndDeleteCarryNoSession`): a revision is not a "where am I"
// question. The session rides only where the server needs it to match a card.
func TestCLIProjectUpdateWithoutAMergeCheckAsksNobodyAndSendsNoSession(t *testing.T) {
	var sessions []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sessions = append(sessions, r.Header.Get("X-Orbit-Session-Id"))
		_, _ = w.Write([]byte(`{"id":"proj-1","title":"a better name"}`))
	}))
	t.Cleanup(srv.Close)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")
	t.Setenv("ORBIT_AGENT_ID", "agent-1")

	var out bytes.Buffer
	if err := cmdProjectCLI([]string{
		"update", "proj-1", "--title", "a better name", "--json",
	}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}

	if len(sessions) != 1 || sessions[0] != "" {
		t.Fatalf("sessions = %v, want the write alone and no header", sessions)
	}
}

// A project created from a session takes no integration setting at all, and says so before anybody
// is asked: the server refuses the object whole there, so a card would be an interruption whose one
// possible answer is "that was refused anyway".
func TestCLIProjectCreateInsideASessionRefusesIntegrationBeforeAsking(t *testing.T) {
	srv, hits, _, _ := mergeCheckServer(t, `{"status":"ALLOWED"}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")
	t.Setenv("ORBIT_AGENT_ID", "agent-1")

	var out bytes.Buffer
	err := cmdProjectCLI([]string{
		"create", "--title", "another project", "--merge-check-command", "npm test", "--json",
	}, strings.NewReader(""), &out)

	if err == nil || !strings.Contains(err.Error(), "orbit project update --merge-check-command") {
		t.Fatalf("err = %v, want it to say where a session sets a merge check", err)
	}
	if len(*hits) != 0 {
		t.Fatalf("hits = %v, want nothing sent at all", *hits)
	}
}
