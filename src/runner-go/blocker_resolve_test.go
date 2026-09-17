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

// Ending a project blocker is an agent's proposal and the account owner's decision. These pin both
// halves: the card comes first and carries enough of the blocker to be answerable, and nothing but a
// yes reaches the door that writes.

// One project read with two blockers on it: one still open, one already resolved.
const blockerProjectRead = `{
  "id": "proj-1",
  "title": "Checkout rewrite",
  "blockers": {
    "open": [{
      "id": "blk-open",
      "kind": "HUMAN_DECISION_REQUIRED",
      "owner": "USER",
      "severity": "CRITICAL",
      "requiredAction": "Read the argued exemption and rule on it before this merges.",
      "subjectType": "TASK",
      "subjectId": "task-9",
      "subjectTitle": "Port the payment form",
      "firstSeenAt": "2026-09-17T16:45:02.096Z"
    }],
    "resolved": [{"id": "blk-done", "kind": "MERGE_CONFLICT", "resolvedAt": "2026-09-16T10:00:00.000Z"}],
    "resolvedCount": 1
  }
}`

// blockerResolveServer answers the project read with `blockerProjectRead`, the approval poll with
// `decision`, and the resolve itself with the resolved row. Every request is recorded in order.
func blockerResolveServer(t *testing.T, decision string) (*httptest.Server, *[]string, map[string]interface{}) {
	t.Helper()
	var hits []string
	filed := map[string]interface{}{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.Method+" "+r.URL.Path)
		switch {
		case strings.Contains(r.URL.Path, "/approvals/"):
			_, _ = w.Write([]byte(decision))
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			_ = json.NewDecoder(r.Body).Decode(&filed)
			_, _ = w.Write([]byte(`{"id":"ap1","status":"PENDING"}`))
		case strings.HasSuffix(r.URL.Path, "/resolve"):
			_, _ = w.Write([]byte(`{"id":"blk-open","resolvedBy":"COORDINATOR"}`))
		default:
			_, _ = w.Write([]byte(blockerProjectRead))
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &hits, filed
}

func resolvedAnything(hits []string) bool {
	for _, hit := range hits {
		if strings.HasSuffix(hit, "/resolve") {
			return true
		}
	}
	return false
}

func TestMCPBlockerResolveAsksBeforeWriting(t *testing.T) {
	srv, hits, filed := blockerResolveServer(t, `{"status":"ALLOWED"}`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	res := mcp.callTool("project_blocker_resolve", map[string]interface{}{
		"projectId": "proj-1", "blockerId": "blk-open",
		"reason": "the exemption was withdrawn and the criterion is met on the branch",
	})

	if res["isError"] == true {
		t.Fatalf("project_blocker_resolve returned an error: %#v", res["content"])
	}
	// Read the blocker, ask about it, then write — in that order. A resolve that reached the door
	// before the card was filed would make the card a formality.
	if len(*hits) < 3 ||
		(*hits)[0] != "GET /api/runner/projects/proj-1" ||
		(*hits)[1] != "POST /api/runner/sessions/sess-1/approvals" ||
		(*hits)[len(*hits)-1] != "POST /api/runner/projects/proj-1/blockers/blk-open/resolve" {
		t.Fatalf("call order = %v", *hits)
	}
	if filed["toolName"] != blockerResolveApprovalToolName {
		t.Fatalf("filed as %v", filed["toolName"])
	}
	// The card has to be answerable on its own: what this blocker asked for, what it is about, and
	// what the agent says has changed. An id and a reason alone is a question nobody can rule on.
	input, _ := filed["input"].(map[string]interface{})
	if input["blockerId"] != "blk-open" || input["projectTitle"] != "Checkout rewrite" ||
		!strings.Contains(fmt.Sprintf("%v", input["reason"]), "exemption was withdrawn") {
		t.Fatalf("card input = %#v", input)
	}
	blocker, _ := input["blocker"].(map[string]interface{})
	if blocker["kind"] != "HUMAN_DECISION_REQUIRED" ||
		blocker["requiredAction"] != "Read the argued exemption and rule on it before this merges." ||
		blocker["subjectTitle"] != "Port the payment form" {
		t.Fatalf("card blocker = %#v", blocker)
	}
}

// A denial and an abandoned card both leave the blocker open, and both reach the model as an
// ordinary result carrying the reason — which is the owner saying what they want instead.
func TestMCPBlockerResolveWritesNothingWithoutAYes(t *testing.T) {
	for _, tc := range []struct{ decision, reason string }{
		{`{"status":"DENIED","message":"这条要我自己判"}`, "这条要我自己判"},
		{`{"status":"DENIED"}`, "denied by the user"},
		{`{"status":"ABANDONED","message":"the turn ended"}`, "the turn ended"},
	} {
		t.Run(tc.decision, func(t *testing.T) {
			srv, hits, _ := blockerResolveServer(t, tc.decision)
			mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

			res := mcp.callTool("project_blocker_resolve", map[string]interface{}{
				"projectId": "proj-1", "blockerId": "blk-open", "reason": "the work landed",
			})

			if resolvedAnything(*hits) {
				t.Fatalf("resolved without a yes: %v", *hits)
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

// An id that names no open blocker is the agent's mistake, and it is caught before a person is
// interrupted with a card they cannot answer. The two ways to get it wrong read differently,
// because they call for different next steps.
func TestMCPBlockerResolveRefusesWhatIsNotOpenWithoutFilingACard(t *testing.T) {
	for _, tc := range []struct{ name, blockerID, want string }{
		{"already resolved", "blk-done", "already resolved"},
		{"no such blocker", "blk-nope", "no open blocker"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, hits, _ := blockerResolveServer(t, `{"status":"ALLOWED"}`)
			mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

			res := mcp.callTool("project_blocker_resolve", map[string]interface{}{
				"projectId": "proj-1", "blockerId": tc.blockerID, "reason": "the work landed",
			})

			if res["isError"] != true {
				t.Fatalf("want an error the agent can act on, got %#v", res["content"])
			}
			if body := fmt.Sprintf("%v", res["content"]); !strings.Contains(body, tc.want) {
				t.Fatalf("message = %v, want it to say %q", body, tc.want)
			}
			for _, hit := range *hits {
				if strings.Contains(hit, "/approvals") || strings.HasSuffix(hit, "/resolve") {
					t.Fatalf("hits = %v, want the project read alone", *hits)
				}
			}
		})
	}
}

// The reason is what the owner decides on and what stays on the row afterwards, so a blank one is
// refused here rather than sent to be refused by the door.
func TestMCPBlockerResolveRequiresAReason(t *testing.T) {
	srv, hits, _ := blockerResolveServer(t, `{"status":"ALLOWED"}`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	res := mcp.callTool("project_blocker_resolve", map[string]interface{}{
		"projectId": "proj-1", "blockerId": "blk-open", "reason": "   ",
	})

	if res["isError"] != true {
		t.Fatalf("a blank reason was accepted: %#v", res["content"])
	}
	if len(*hits) != 0 {
		t.Fatalf("hits = %v, want nothing sent at all", *hits)
	}
}

// Headless there is nobody to ask, so the resolution goes ahead rather than blocking forever on a
// card no UI will ever show — and there is no card to build, so the project read is not spent.
func TestMCPBlockerResolveHeadlessDoesNotAsk(t *testing.T) {
	srv, hits, _ := blockerResolveServer(t, `{"status":"DENIED"}`)
	mcp := &mcpServer{agentID: "agent-1", t: NewTransport(srv.URL, "tok")}

	res := mcp.callTool("project_blocker_resolve", map[string]interface{}{
		"projectId": "proj-1", "blockerId": "blk-open", "reason": "the work landed",
	})

	if res["isError"] == true {
		t.Fatalf("headless resolve failed: %#v", res["content"])
	}
	if len(*hits) != 1 || (*hits)[0] != "POST /api/runner/projects/proj-1/blockers/blk-open/resolve" {
		t.Fatalf("headless hits = %v, want the write alone", *hits)
	}
}

// The CLI is the other door onto the same API, and an agent reaches it through its shell. Inside a
// session it asks exactly as the MCP tool does, or a refused resolution would simply be retried
// there — a gate one door wide is not a gate.
func TestCLIResolveBlockerInsideASessionAsksFirst(t *testing.T) {
	srv, hits, filed := blockerResolveServer(t, `{"status":"ALLOWED"}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")
	t.Setenv("ORBIT_AGENT_ID", "agent-1")

	var out bytes.Buffer
	if err := cmdProjectCLI([]string{
		"resolve-blocker", "proj-1", "--blocker-id", "blk-open", "--reason", "the work landed", "--json",
	}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}

	if filed["toolName"] != blockerResolveApprovalToolName {
		t.Fatalf("filed as %v; hits = %v", filed["toolName"], *hits)
	}
	if last := (*hits)[len(*hits)-1]; last != "POST /api/runner/projects/proj-1/blockers/blk-open/resolve" {
		t.Fatalf("last hit = %q, want the write after the card; hits = %v", last, *hits)
	}
}

func TestCLIResolveBlockerInsideASessionWritesNothingWhenDenied(t *testing.T) {
	srv, hits, _ := blockerResolveServer(t, `{"status":"DENIED","message":"这条要我自己判"}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")
	t.Setenv("ORBIT_AGENT_ID", "agent-1")

	var out bytes.Buffer
	err := cmdProjectCLI([]string{
		"resolve-blocker", "proj-1", "--blocker-id", "blk-open", "--reason", "the work landed", "--json",
	}, strings.NewReader(""), &out)

	if err == nil || !strings.Contains(err.Error(), "这条要我自己判") {
		t.Fatalf("err = %v, want the refusal carrying its reason", err)
	}
	if resolvedAnything(*hits) {
		t.Fatalf("resolved without a yes: %v", *hits)
	}
}
