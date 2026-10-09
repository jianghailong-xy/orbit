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

// Skipping ONE landing's merge check is the account owner's decision, taken on a card, and the card
// is the approval the server reads back. These pin both halves: the facts come first and the card
// carries what is being skipped, and nothing but an answered card reaches the door that queues.
// docs/project-integration-line-contract.md §2.4 J-S5.

// One project whose check cannot pass on the machine the runner is on — the case this door was built
// for — and one DONE task whose newest landing stopped on it.
const skipProjectRead = `{
  "id": "proj-1",
  "title": "OpenCode 接进安装通道",
  "integration": {
    "line": "PROJECT_BRANCH",
    "ref": "project/34bZ3",
    "upstreamRef": "main",
    "mergeCheckCommand": "scripts/check.sh",
    "mergeCheckTimeoutSeconds": 3600
  }
}`

const skipTaskRead = `{
  "id": "task-1",
  "title": "让协调会话能跳过这一次落地的 merge check",
  "status": "DONE",
  "projectId": "proj-1",
  "integration": {
    "state": "CHECK_FAILED",
    "landTask": {
      "jobId": "job-1",
      "state": "CHECK_FAILED",
      "phase": "CHECK",
      "generation": "1",
      "blockingReason": {"code": "CHECK_FAILED", "summary": "Checks failed on the combined tree: the merge check exited 127 (expected 0)"}
    }
  }
}`

// whatTheDoorWasTold is the two bodies a skip touches: the card the runner filed for the owner, and
// the call it made once the card was answered. What was approved and what was queued have to be the
// same landing, and the card's id is what ties them.
type whatTheDoorWasTold struct {
	card map[string]interface{}
	body map[string]interface{}
}

// skipCheckServer answers the two reads, the approval file and poll, and the skip itself. Every
// request is recorded in order, and both bodies are kept for inspection.
func skipCheckServer(t *testing.T, decision string, taskRead string) (*httptest.Server, *[]string, *whatTheDoorWasTold) {
	t.Helper()
	var hits []string
	told := &whatTheDoorWasTold{card: map[string]interface{}{}, body: map[string]interface{}{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.Method+" "+r.URL.Path)
		switch {
		case strings.Contains(r.URL.Path, "/approvals/"):
			_, _ = w.Write([]byte(decision))
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			_ = json.NewDecoder(r.Body).Decode(&told.card)
			_, _ = w.Write([]byte(`{"id":"ap-skip-1","status":"PENDING"}`))
		case strings.HasSuffix(r.URL.Path, "/integration/skip-merge-check"):
			// The body the door was called with, kept beside the card: what the owner approved and
			// what was queued have to be the same landing, and the card's id is what ties them.
			_ = json.NewDecoder(r.Body).Decode(&told.body)
			_, _ = w.Write([]byte(`{"taskId":"task-1","jobId":"job-2","generation":2,"skippedCheck":{"reason":"x","approvedByUserId":"owner-1","approvalId":"ap-skip-1"}}`))
		case strings.HasSuffix(r.URL.Path, "/tasks/task-1"):
			_, _ = w.Write([]byte(taskRead))
		default:
			_, _ = w.Write([]byte(skipProjectRead))
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &hits, told
}

func skippedAnything(hits []string) bool {
	for _, hit := range hits {
		if strings.HasSuffix(hit, "/integration/skip-merge-check") {
			return true
		}
	}
	return false
}

func TestMCPSkipMergeCheckAsksBeforeQueueing(t *testing.T) {
	srv, hits, told := skipCheckServer(t, `{"status":"ALLOWED"}`, skipTaskRead)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	res := mcp.callTool("integration_skip_merge_check", map[string]interface{}{
		"projectId": "proj-1", "taskId": "task-1",
		"reason": "scripts/check.sh needs bash 4 and GNU timeout, and this runner has neither",
	})

	if res["isError"] == true {
		t.Fatalf("integration_skip_merge_check returned an error: %#v", res["content"])
	}
	// Read the project and the task, ask about them, then queue — in that order. A skip that reached
	// the door before the card was filed would make the card a formality.
	if len(*hits) < 4 ||
		(*hits)[0] != "GET /api/runner/projects/proj-1" ||
		(*hits)[1] != "GET /api/runner/tasks/task-1" ||
		(*hits)[2] != "POST /api/runner/sessions/sess-1/approvals" ||
		(*hits)[len(*hits)-1] != "POST /api/runner/projects/proj-1/tasks/task-1/integration/skip-merge-check" {
		t.Fatalf("call order = %v", *hits)
	}
	if told.card["toolName"] != integrationSkipMergeCheckApprovalToolName {
		t.Fatalf("filed as %v", told.card["toolName"])
	}
	// The card has to be answerable on its own: which landing, what the check is, what it said, and
	// why the agent thinks the check is what is red. "Skip the red check?" is not a question.
	input, _ := told.card["input"].(map[string]interface{})
	if input["projectId"] != "proj-1" || input["taskId"] != "task-1" ||
		input["projectTitle"] != "OpenCode 接进安装通道" ||
		input["checkCommand"] != "scripts/check.sh" ||
		!strings.Contains(fmt.Sprintf("%v", input["failure"]), "exited 127") ||
		!strings.Contains(fmt.Sprintf("%v", input["reason"]), "GNU timeout") {
		t.Fatalf("card input = %#v", input)
	}
}

// The id of the card travels with the call: it is the approval as far as the server is concerned, so
// the body carries it and an empty one would be refused there.
func TestMCPSkipMergeCheckSendsTheCardItWasApprovedOn(t *testing.T) {
	srv, _, told := skipCheckServer(t, `{"status":"ALLOWED"}`, skipTaskRead)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	res := mcp.callTool("integration_skip_merge_check", map[string]interface{}{
		"projectId": "proj-1", "taskId": "task-1", "reason": "the check cannot run here",
	})

	if res["isError"] == true {
		t.Fatalf("skip returned an error: %#v", res["content"])
	}
	if told.body["approvalId"] != "ap-skip-1" {
		t.Fatalf("the skip did not name the card: %#v", told.body)
	}
	if told.body["reason"] != "the check cannot run here" {
		t.Fatalf("the reason did not travel: %#v", told.body)
	}
}

// A denial, an abandoned card and a card still pending all queue nothing, and all reach the model as
// an ordinary result carrying the reason — which is the owner saying what they want instead.
func TestMCPSkipMergeCheckQueuesNothingWithoutAYes(t *testing.T) {
	for _, tc := range []struct{ decision, reason string }{
		{`{"status":"DENIED","message":"先改检查命令"}`, "先改检查命令"},
		{`{"status":"DENIED"}`, "denied by the user"},
		{`{"status":"ABANDONED","message":"the turn ended"}`, "the turn ended"},
	} {
		t.Run(tc.decision, func(t *testing.T) {
			srv, hits, _ := skipCheckServer(t, tc.decision, skipTaskRead)
			mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

			res := mcp.callTool("integration_skip_merge_check", map[string]interface{}{
				"projectId": "proj-1", "taskId": "task-1", "reason": "the check cannot run here",
			})

			if res["isError"] == true {
				t.Fatalf("a refusal is an answer, not an error: %#v", res["content"])
			}
			if skippedAnything(*hits) {
				t.Fatalf("queued without a yes: %v", *hits)
			}
			if body := fmt.Sprintf("%v", res["content"]); !strings.Contains(body, tc.reason) {
				t.Fatalf("reason not passed back: %v", body)
			}
		})
	}
}

// What this door does not answer is refused before a person is interrupted: a landing that stopped
// anywhere but a check, a task that is not finished, and a project whose check command is what
// stopped it in the first place are three different next steps.
func TestMCPSkipMergeCheckRefusesWhatItCannotSkipWithoutFilingACard(t *testing.T) {
	for _, tc := range []struct{ name, taskRead, want string }{
		{
			"an integration error is the machinery's",
			strings.Replace(skipTaskRead, `"state": "CHECK_FAILED",
    "landTask": {
      "jobId": "job-1",
      "state": "CHECK_FAILED"`, `"state": "ERROR",
    "landTask": {
      "jobId": "job-1",
      "state": "ERROR"`, 1),
			"integration_retry",
		},
		{
			"a task that has not finished has no landing to skip",
			strings.Replace(skipTaskRead, `"status": "DONE"`, `"status": "IN_PROGRESS"`, 1),
			"not DONE",
		},
		{
			"a conflict is the branch's",
			strings.Replace(skipTaskRead, `"state": "CHECK_FAILED",
    "landTask": {
      "jobId": "job-1",
      "state": "CHECK_FAILED"`, `"state": "CONFLICT",
    "landTask": {
      "jobId": "job-1",
      "state": "CONFLICT"`, 1),
			"nothing for this door to take off",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, hits, _ := skipCheckServer(t, `{"status":"ALLOWED"}`, tc.taskRead)
			mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

			res := mcp.callTool("integration_skip_merge_check", map[string]interface{}{
				"projectId": "proj-1", "taskId": "task-1", "reason": "the check cannot run here",
			})

			if res["isError"] != true {
				t.Fatalf("want an error the agent can act on, got %#v", res["content"])
			}
			if body := fmt.Sprintf("%v", res["content"]); !strings.Contains(body, tc.want) {
				t.Fatalf("message = %v, want it to say %q", body, tc.want)
			}
			for _, hit := range *hits {
				if strings.Contains(hit, "/approvals") || strings.HasSuffix(hit, "/skip-merge-check") {
					t.Fatalf("hits = %v, want the two reads alone", *hits)
				}
			}
		})
	}
}

// A task of another project is refused from the reads: a project's coordinator skips a check on its
// own project's landings and nowhere else.
func TestMCPSkipMergeCheckRefusesATaskOfAnotherProject(t *testing.T) {
	srv, hits, _ := skipCheckServer(t, `{"status":"ALLOWED"}`,
		strings.Replace(skipTaskRead, `"projectId": "proj-1"`, `"projectId": "proj-2"`, 1))
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	res := mcp.callTool("integration_skip_merge_check", map[string]interface{}{
		"projectId": "proj-1", "taskId": "task-1", "reason": "the check cannot run here",
	})

	if res["isError"] != true {
		t.Fatalf("a task of another project was accepted: %#v", res["content"])
	}
	if body := fmt.Sprintf("%v", res["content"]); !strings.Contains(body, "not filed under project") {
		t.Fatalf("message = %v", body)
	}
	if len(*hits) != 2 {
		t.Fatalf("hits = %v, want the two reads and no card", *hits)
	}
}

// The reason is what the owner decides on and what stays on the generation afterwards, so a blank one
// is refused here rather than sent to be refused by the door — and nothing is even read.
func TestMCPSkipMergeCheckRequiresAReason(t *testing.T) {
	srv, hits, _ := skipCheckServer(t, `{"status":"ALLOWED"}`, skipTaskRead)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	res := mcp.callTool("integration_skip_merge_check", map[string]interface{}{
		"projectId": "proj-1", "taskId": "task-1", "reason": "   ",
	})

	if res["isError"] != true {
		t.Fatalf("a blank reason was accepted: %#v", res["content"])
	}
	if len(*hits) != 0 {
		t.Fatalf("hits = %v, want nothing sent at all", *hits)
	}
}

// The tool is advertised with what its description promises, and takes exactly the three things the
// door needs. A tool whose schema drifts from its prose is one an agent calls wrongly.
func TestMCPSkipMergeCheckToolShape(t *testing.T) {
	tools := toolDescriptors(false, false)
	if !hasMCPTool(tools, "integration_skip_merge_check") {
		t.Fatal("integration_skip_merge_check missing from the tools")
	}
	props := mcpToolProps(tools, "integration_skip_merge_check")
	for _, want := range []string{"projectId", "taskId", "reason"} {
		if _, ok := props[want]; !ok {
			t.Fatalf("integration_skip_merge_check does not take %q: %#v", want, props)
		}
	}
	if len(props) != 3 {
		t.Fatalf("integration_skip_merge_check takes more than the door reads: %#v", props)
	}
	if got := mcpToolRequired(t, tools, "integration_skip_merge_check"); strings.Join(got, ",") != "projectId,taskId,reason" {
		t.Fatalf("integration_skip_merge_check required = %#v", got)
	}
	desc := mcpToolDescription(tools, "integration_skip_merge_check")
	for _, want := range []string{"NOT RUN", "confirmation card", "ONCE", "CHECK_FAILED", "account owner"} {
		if !strings.Contains(desc, want) {
			t.Fatalf("integration_skip_merge_check's description does not mention %q: %q", want, desc)
		}
	}
	// The card is the owner's, so the call has to be one the runtime hands off rather than holds.
	if !waitsForTheOwner("integration_skip_merge_check", nil) {
		t.Fatal("integration_skip_merge_check is not a call that waits for the owner")
	}
}

// The CLI is the other door onto the same API, and an agent reaches it through its shell. Inside a
// session it asks exactly as the MCP tool does, or a refused skip would simply be retried there — a
// gate one door wide is not a gate.
func TestCLISkipMergeCheckInsideASessionAsksFirst(t *testing.T) {
	srv, hits, told := skipCheckServer(t, `{"status":"ALLOWED"}`, skipTaskRead)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")
	t.Setenv("ORBIT_AGENT_ID", "agent-1")

	var out bytes.Buffer
	if err := cmdProjectCLI([]string{
		"skip-merge-check", "proj-1", "task-1", "--reason", "scripts/check.sh cannot run here", "--json",
	}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}

	if told.card["toolName"] != integrationSkipMergeCheckApprovalToolName {
		t.Fatalf("filed as %v; hits = %v", told.card["toolName"], *hits)
	}
	if last := (*hits)[len(*hits)-1]; last != "POST /api/runner/projects/proj-1/tasks/task-1/integration/skip-merge-check" {
		t.Fatalf("last hit = %q, want the write after the card; hits = %v", last, *hits)
	}
}

func TestCLISkipMergeCheckInsideASessionQueuesNothingWhenDenied(t *testing.T) {
	srv, hits, _ := skipCheckServer(t, `{"status":"DENIED","message":"先改检查命令"}`, skipTaskRead)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")
	t.Setenv("ORBIT_AGENT_ID", "agent-1")

	var out bytes.Buffer
	err := cmdProjectCLI([]string{
		"skip-merge-check", "proj-1", "task-1", "--reason", "scripts/check.sh cannot run here", "--json",
	}, strings.NewReader(""), &out)

	if err == nil || !strings.Contains(err.Error(), "先改检查命令") {
		t.Fatalf("err = %v, want the refusal carrying its reason", err)
	}
	if skippedAnything(*hits) {
		t.Fatalf("queued without a yes: %v", *hits)
	}
}

// A terminal as the person is the owner's own door: no card (they are the person it would ask), and
// the write goes straight through. A terminal with no login and no session is neither side and is
// told so rather than sending a call the server can only refuse.
func TestCLISkipMergeCheckAtATerminal(t *testing.T) {
	srv, hits, told := skipCheckServer(t, `{"status":"DENIED"}`, skipTaskRead)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "")

	var out bytes.Buffer
	err := cmdProjectCLI([]string{
		"skip-merge-check", "proj-1", "task-1", "--reason", "the check cannot run here", "--json",
	}, strings.NewReader(""), &out)

	if err == nil || !strings.Contains(err.Error(), "orbit login") {
		t.Fatalf("err = %v, want the two sides of the door named", err)
	}
	if len(told.card) != 0 || skippedAnything(*hits) {
		t.Fatalf("hits = %v, want nothing sent at all", *hits)
	}
}
