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

// The owner's rule: nothing is created on their behalf without their saying yes first. These pin
// the order on the wire (the card before the write), what anything but a yes does (writes nothing,
// and tells the model why), and the one place nobody is asked: headless, where no card could show.

// createApprovalServer answers the approval poll with `decision` and any other request with
// `writeBody`. It records every request in order, and the approval the card was filed as.
func createApprovalServer(t *testing.T, decision, writeBody string) (*httptest.Server, *[]string, map[string]interface{}) {
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
		default:
			_, _ = w.Write([]byte(writeBody))
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &hits, filed
}

func wroteAnything(hits []string) bool {
	for _, hit := range hits {
		if !strings.Contains(hit, "/approvals") {
			return true
		}
	}
	return false
}

func TestMCPTaskCreateAsksBeforeWriting(t *testing.T) {
	srv, hits, filed := createApprovalServer(t, `{"status":"ALLOWED"}`, `{"id":"t1"}`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	res := mcp.callTool("task_create", map[string]interface{}{
		"title": "Fix login redirect", "description": "the why", "completionCriterion": "EVIDENCE_JUDGMENT",
	})

	if res["isError"] == true {
		t.Fatalf("task_create returned an error: %#v", res["content"])
	}
	// Ask, then write — in that order. A write that reached the server before the card was filed
	// would make the card a formality.
	if len(*hits) < 3 ||
		(*hits)[0] != "POST /api/runner/sessions/sess-1/approvals" ||
		(*hits)[len(*hits)-1] != "POST /api/runner/tasks" {
		t.Fatalf("call order = %v", *hits)
	}
	if filed["toolName"] != taskCreateApprovalToolName {
		t.Fatalf("filed as %v", filed["toolName"])
	}
	// The card shows what would be written, so it carries the body the write then sends.
	if input, _ := filed["input"].(map[string]interface{}); input["title"] != "Fix login redirect" || input["description"] != "the why" {
		t.Fatalf("card input = %#v", filed["input"])
	}
}

func TestMCPProjectCreateAsksBeforeWriting(t *testing.T) {
	srv, hits, filed := createApprovalServer(t, `{"status":"ALLOWED"}`, `{"id":"p1"}`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	res := mcp.callTool("project_create", map[string]interface{}{"title": "Checkout rewrite", "goal": "one page"})

	if res["isError"] == true {
		t.Fatalf("project_create returned an error: %#v", res["content"])
	}
	if len(*hits) < 3 ||
		(*hits)[0] != "POST /api/runner/sessions/sess-1/approvals" ||
		(*hits)[len(*hits)-1] != "POST /api/runner/projects" {
		t.Fatalf("call order = %v", *hits)
	}
	if filed["toolName"] != projectCreateApprovalToolName {
		t.Fatalf("filed as %v", filed["toolName"])
	}
	if input, _ := filed["input"].(map[string]interface{}); input["title"] != "Checkout rewrite" || input["goal"] != "one page" {
		t.Fatalf("card input = %#v", filed["input"])
	}
}

// A denial and an abandoned card both leave nothing behind, and both reach the model as an ordinary
// result carrying the reason, so it can respond instead of retrying blind.
func TestMCPCreatesWriteNothingWithoutAYes(t *testing.T) {
	for _, tc := range []struct {
		tool     string
		args     map[string]interface{}
		decision string
		reason   string
	}{
		{"task_create", map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT"}, `{"status":"DENIED","message":"不要建"}`, "不要建"},
		{"project_create", map[string]interface{}{"title": "P"}, `{"status":"DENIED"}`, "denied by the user"},
		// The turn that raised it ended unanswered: that is not a yes either.
		{"task_create", map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT"}, `{"status":"ABANDONED","message":"the turn ended"}`, "the turn ended"},
	} {
		t.Run(tc.tool+" "+tc.decision, func(t *testing.T) {
			srv, hits, _ := createApprovalServer(t, tc.decision, `{"id":"x"}`)
			mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

			res := mcp.callTool(tc.tool, tc.args)

			if wroteAnything(*hits) {
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

// Headless there is nobody to ask, so the write goes ahead rather than blocking forever on a card no
// UI will ever show.
func TestMCPCreatesHeadlessDoNotAsk(t *testing.T) {
	for tool, args := range map[string]map[string]interface{}{
		"task_create":    {"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT"},
		"project_create": {"title": "P"},
	} {
		srv, hits, _ := createApprovalServer(t, `{"status":"DENIED"}`, `{"id":"x"}`)
		mcp := &mcpServer{agentID: "agent-1", t: NewTransport(srv.URL, "tok")}

		if res := mcp.callTool(tool, args); res["isError"] == true {
			t.Fatalf("headless %s failed: %#v", tool, res["content"])
		}
		if len(*hits) != 1 || strings.Contains((*hits)[0], "/approvals") {
			t.Fatalf("headless %s hits = %v, want the write alone", tool, *hits)
		}
	}
}

// The CLI is the other door onto the same API, and an agent reaches it through its shell. Inside a
// session it asks exactly as the MCP tools do, or a refused create would simply be retried there.
func TestCLICreatesInsideASessionAskFirst(t *testing.T) {
	for _, tc := range []struct {
		name     string
		run      func(out *bytes.Buffer) error
		toolName string
		write    string
	}{
		{"task create", func(out *bytes.Buffer) error {
			return cmdTaskCLI([]string{"create", "--title", "a", "--completion-criterion", "EVIDENCE_JUDGMENT", "--json"}, strings.NewReader(""), out)
		}, taskCreateApprovalToolName, "POST /api/runner/tasks"},
		{"task create-batch", func(out *bytes.Buffer) error {
			return cmdTaskCLI([]string{"create-batch", "--tasks", `[{"title":"a","completionCriterion":"EVIDENCE_JUDGMENT"}]`, "--json"}, strings.NewReader(""), out)
		}, batchApprovalToolName, "POST /api/runner/tasks/batch-create"},
		{"project create", func(out *bytes.Buffer) error {
			return cmdProjectCLI([]string{"create", "--title", "P", "--json"}, strings.NewReader(""), out)
		}, projectCreateApprovalToolName, "POST /api/runner/projects"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv, hits, filed := createApprovalServer(t, `{"status":"ALLOWED"}`, `{"id":"x"}`)
			configureCLITestRunner(t, srv.URL)
			t.Setenv("ORBIT_SESSION_ID", "sess-1")
			t.Setenv("ORBIT_AGENT_ID", "agent-1")
			t.Setenv(envOrchestrationToken, "")

			var out bytes.Buffer
			if err := tc.run(&out); err != nil {
				t.Fatal(err)
			}
			if filed["toolName"] != tc.toolName {
				t.Fatalf("filed as %v; hits = %v", filed["toolName"], *hits)
			}
			if last := (*hits)[len(*hits)-1]; last != tc.write {
				t.Fatalf("last hit = %q, want the write after the card; hits = %v", last, *hits)
			}
		})
	}
}

func TestCLICreateInsideASessionWritesNothingWhenDenied(t *testing.T) {
	srv, hits, _ := createApprovalServer(t, `{"status":"DENIED","message":"不要建"}`, `{"id":"x"}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")
	t.Setenv("ORBIT_AGENT_ID", "agent-1")

	var out bytes.Buffer
	err := cmdTaskCLI([]string{"create", "--title", "a", "--completion-criterion", "EVIDENCE_JUDGMENT", "--json"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "不要建") {
		t.Fatalf("err = %v, want the refusal carrying its reason", err)
	}
	if wroteAnything(*hits) {
		t.Fatalf("wrote without a yes: %v", *hits)
	}
}

// A dry run writes nothing, so there is nothing to ask about, session or not.
func TestCLICreateBatchDryRunInsideASessionDoesNotAsk(t *testing.T) {
	srv, hits, _ := createApprovalServer(t, `{"status":"DENIED"}`, `{"dryRun":true}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"create-batch", "--tasks", `[{"title":"a","completionCriterion":"EVIDENCE_JUDGMENT"}]`, "--dry-run", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if len(*hits) != 1 || strings.Contains((*hits)[0], "/approvals") {
		t.Fatalf("hits = %v, want the preview alone", *hits)
	}
}
