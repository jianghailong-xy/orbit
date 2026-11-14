package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
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

// "Chat about this" is the owner's way to talk a proposal over: it carries their words (decidedById
// set) and writes nothing. The agent gets those words as a message to answer, with the proposal still
// open, not as the reason it was refused; at both doors.
func TestCreatesAnsweredByChatAboutThisAreNotARefusal(t *testing.T) {
	const words = "Will there be two databases during the move?"
	decision := `{"status":"DENIED","message":"` + words + `","decidedById":"user-1"}`
	check := func(t *testing.T, hits []string, body string) {
		if wroteAnything(hits) {
			t.Fatalf("wrote without a yes: %v", hits)
		}
		if !strings.Contains(body, words) || !strings.Contains(body, "Chat about this") {
			t.Fatalf("owner's words not handed over as a chat: %v", body)
		}
		if strings.Contains(body, "rejected") {
			t.Fatalf("a chat reads as a refusal: %v", body)
		}
	}
	t.Run("mcp", func(t *testing.T) {
		srv, hits, _ := createApprovalServer(t, decision, `{"id":"x"}`)
		mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
		res := mcp.callTool("project_create", map[string]interface{}{"title": "P"})
		if res["isError"] == true {
			t.Fatalf("a chat is an answer, not an error: %#v", res["content"])
		}
		check(t, *hits, fmt.Sprintf("%v", res["content"]))
	})
	t.Run("cli", func(t *testing.T) {
		srv, hits, _ := createApprovalServer(t, decision, `{"id":"x"}`)
		configureCLITestRunner(t, srv.URL)
		t.Setenv("ORBIT_SESSION_ID", "sess-1")
		t.Setenv("ORBIT_AGENT_ID", "agent-1")
		t.Setenv(envOrchestrationToken, "")
		err := cmdProjectCLI([]string{"create", "--title", "P", "--json"}, strings.NewReader(""), &bytes.Buffer{})
		if err == nil {
			t.Fatal("a create the owner has not said yes to succeeded")
		}
		check(t, *hits, err.Error())
	})
}

// Headless there is nobody to ask, so this process raises no card and sends the write alone. The
// control plane then refuses a machine-credential write with no acting session
// (`task-write-approval.ts`); what is asserted here is the runner's half — it must not block on a
// card no conversation will ever show.
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

// A declined card is ONE document on both surfaces (docs/orbit-agent-contract.md §6.1, gap G4): the
// same code, the same tool, the same reason — the MCP tool as its result text, the CLI as its error
// (and so a non-zero exit). The transport is the only difference, and an agent classifies by the
// document rather than by which door it knocked on.
func TestADeclinedCardIsOneDocumentOnBothSurfaces(t *testing.T) {
	document := func(t *testing.T, text string) map[string]interface{} {
		t.Helper()
		var doc map[string]interface{}
		if err := json.Unmarshal([]byte(text), &doc); err != nil {
			t.Fatalf("not the shared refusal document: %v (%q)", err, text)
		}
		return doc
	}

	srv, _, _ := createApprovalServer(t, `{"status":"DENIED","message":"not now"}`, `{"id":"x"}`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create", map[string]interface{}{
		"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT",
	})
	if res["isError"] == true {
		t.Fatalf("a refusal is an answer, not an error: %s", resultText(res))
	}
	mcpDocument := document(t, resultText(res))

	cliSrv, _, _ := createApprovalServer(t, `{"status":"DENIED","message":"not now"}`, `{"id":"x"}`)
	configureCLITestRunner(t, cliSrv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")
	t.Setenv("ORBIT_AGENT_ID", "agent-1")
	var out bytes.Buffer
	err := cmdTaskCLI([]string{"create", "--title", "a", "--completion-criterion", "EVIDENCE_JUDGMENT", "--json"},
		strings.NewReader(""), &out)
	if err == nil {
		t.Fatal("a declined card was reported as success")
	}
	cliDocument := document(t, err.Error())

	for _, key := range []string{"refused", "code", "tool", "message"} {
		if mcpDocument[key] != cliDocument[key] {
			t.Errorf("%s differs: MCP %v, CLI %v", key, mcpDocument[key], cliDocument[key])
		}
	}
	if mcpDocument["code"] != approvalDeclinedCode || mcpDocument["tool"] != taskCreateApprovalToolName {
		t.Fatalf("document = %#v", mcpDocument)
	}
	if mcpDocument["message"] != "the human rejected this task: not now" {
		t.Fatalf("message = %v", mcpDocument["message"])
	}
}

// A batch is the same document, with the batch card's name.
func TestADeclinedBatchIsTheSameDocument(t *testing.T) {
	srv, _, _ := createApprovalServer(t, `{"status":"DENIED","message":"too many"}`, `{"id":"x"}`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("task_create_batch", map[string]interface{}{
		"tasks": []interface{}{map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT"}},
	})
	if res["isError"] == true {
		t.Fatalf("a refusal is an answer, not an error: %s", resultText(res))
	}
	var doc map[string]interface{}
	if err := json.Unmarshal([]byte(resultText(res)), &doc); err != nil {
		t.Fatalf("not the shared refusal document: %v (%q)", err, resultText(res))
	}
	if doc["code"] != approvalDeclinedCode || doc["tool"] != batchApprovalToolName {
		t.Fatalf("document = %#v", doc)
	}
	if doc["message"] != "the human rejected this batch: too many" {
		t.Fatalf("message = %v", doc["message"])
	}
}

// A card outlives the door going down. The runner restart and apiserver rebuild that happen under
// a running session are exactly when a poll fails, and the card is already on the human's screen
// by then: ending the loop there leaves a live-looking card nothing reads, and the retry the agent
// then makes files a second one beside it.
func TestMCPCreateKeepsReadingTheCardThroughADoorOutage(t *testing.T) {
	restore := approvalPollRetryDelay
	approvalPollRetryDelay = time.Millisecond
	t.Cleanup(func() { approvalPollRetryDelay = restore })

	var filed, polls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/approvals/"):
			polls++
			if polls <= 2 { // the apiserver is being restarted under us
				w.WriteHeader(http.StatusBadGateway)
				_, _ = w.Write([]byte("502 error code: 502"))
				return
			}
			_, _ = w.Write([]byte(`{"status":"ALLOWED"}`)) // the human answers the card they were shown
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			filed++
			_, _ = w.Write([]byte(`{"id":"ap1","status":"PENDING"}`))
		default:
			_, _ = w.Write([]byte(`{"id":"t1"}`))
		}
	}))
	t.Cleanup(srv.Close)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	res := mcp.callTool("task_create", map[string]interface{}{
		"title": "Fix login redirect", "completionCriterion": "EVIDENCE_JUDGMENT",
	})

	if res["isError"] == true {
		t.Fatalf("an outage was reported as a failed create: %#v", res["content"])
	}
	if filed != 1 {
		t.Fatalf("filed %d cards, want the one the human is looking at", filed)
	}
	if polls != 3 {
		t.Fatalf("polled %d times, want the two refusals and the answer", polls)
	}
}

// The other direction: a refusal from the door IS an answer about the card, so the loop stops
// rather than spinning on a row that is gone.
func TestMCPCreateStopsWhenTheCardIsGone(t *testing.T) {
	restore := approvalPollRetryDelay
	approvalPollRetryDelay = time.Millisecond
	t.Cleanup(func() { approvalPollRetryDelay = restore })

	var hits []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.Method+" "+r.URL.Path)
		switch {
		case strings.Contains(r.URL.Path, "/approvals/"):
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte("no such approval"))
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			_, _ = w.Write([]byte(`{"id":"ap1","status":"PENDING"}`))
		default:
			_, _ = w.Write([]byte(`{"id":"t1"}`))
		}
	}))
	t.Cleanup(srv.Close)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	res := mcp.callTool("task_create", map[string]interface{}{
		"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT",
	})

	if res["isError"] != true {
		t.Fatalf("a card that cannot be read is an error, got %#v", res["content"])
	}
	if wroteAnything(hits) {
		t.Fatalf("wrote without a yes: %v", hits)
	}
}

// A dry run writes nothing, so nobody is asked. The CLI door is pinned above; this is the MCP one,
// where the agent actually reaches it — and the assertion is on the wire, because "it asks nobody"
// is only true if no card was FILED, not merely if none was waited on.
func TestMCPCreateBatchDryRunAsksNobody(t *testing.T) {
	srv, hits, _ := createApprovalServer(t, `{"status":"DENIED"}`, `{"dryRun":true,"wouldWrite":1,"plan":[]}`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	res := mcp.callTool("task_create_batch", map[string]interface{}{
		"dryRun": true,
		"tasks": []interface{}{
			map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT"},
		},
	})

	if res["isError"] == true {
		t.Fatalf("dry run failed: %#v", res["content"])
	}
	for _, hit := range *hits {
		if strings.Contains(hit, "/approvals") {
			t.Fatalf("a preview that writes nothing raised a card: %v", *hits)
		}
	}
	if len(*hits) != 1 {
		t.Fatalf("hits = %v, want the preview call alone", *hits)
	}
}

// A card asked for from inside a runner-hosted job names that job, and one asked for in the turn
// does not.
//
// The job id is what the reaper checks a card against before collecting it: a card that names a job
// still in the session's running set is left PENDING when the turn ends, because the CLI that filed
// it is still polling for the answer (apiserver sessions/abandoned-approvals.ts). Both halves are
// asserted, because a card that names a job it does not belong to would keep a question alive that
// nobody is reading.
func TestCardsNameTheBackgroundJobThatAskedForThem(t *testing.T) {
	ask := func(t *testing.T, jobID string) map[string]interface{} {
		t.Helper()
		if jobID == "" {
			t.Setenv(envBgJobID, "")
		} else {
			t.Setenv(envBgJobID, jobID)
		}
		srv, _, filed := createApprovalServer(t, `{"status":"ALLOWED"}`, `{"id":"t1"}`)
		mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
		if res := mcp.callTool("task_create", map[string]interface{}{
			"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT",
		}); res["isError"] == true {
			t.Fatalf("task_create returned an error: %#v", res["content"])
		}
		return filed
	}

	filed := ask(t, "bgj_0123456789ab")
	if filed["backgroundJobId"] != "bgj_0123456789ab" {
		t.Fatalf("card backgroundJobId = %#v, want the job the CLI runs in", filed["backgroundJobId"])
	}
	if filed["toolName"] != taskCreateApprovalToolName {
		t.Fatalf("filed as %v", filed["toolName"])
	}

	inTurn := ask(t, "")
	if _, named := inTurn["backgroundJobId"]; named {
		t.Fatalf("an in-turn ask named a job: %#v", inTurn["backgroundJobId"])
	}
}

// The clients read the owner's words back out of what ownerChatReply writes (ownerChatWords in
// @orbit/shared and its native copies); the shared fixture's first case is what this writer must write.
func TestOwnerChatReplyMatchesTheClientsFixture(t *testing.T) {
	raw, err := os.ReadFile("../shared/src/owner-chat-reply.fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		WriterWords string `json:"writerWords"`
		Cases       []struct {
			Result string `json:"result"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if got := ownerChatReply(fixture.WriterWords); got != fixture.Cases[0].Result {
		t.Fatalf("the runner writes\n%q\nthe clients read\n%q", got, fixture.Cases[0].Result)
	}
}

// Claude Code and Codex record a result's structuredContent in place of its text, so the clients also
// read the owner's words out of the chat receipt. The fixture's two receipt cases are what this runner
// answers a project_create card with: the owner's "Chat about this", which carries the words, and a
// bare no, which carries none.
func TestChatReceiptMatchesTheClientsFixture(t *testing.T) {
	raw, err := os.ReadFile("../shared/src/owner-chat-reply.fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		WriterWords string `json:"writerWords"`
		Cases       []struct {
			Name   string `json:"name"`
			Result string `json:"result"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	results := map[string]string{}
	for _, c := range fixture.Cases {
		results[c.Name] = c.Result
	}
	words, _ := json.Marshal(fixture.WriterWords)
	for name, decision := range map[string]string{
		"the receipt an engine shows in place of the text": `{"status":"DENIED","message":` + string(words) + `,"decidedById":"user-1"}`,
		"a declined card's receipt":                        `{"status":"DENIED","decidedById":"user-1"}`,
	} {
		want, ok := results[name]
		if !ok {
			t.Fatalf("the fixture has no case %q", name)
		}
		_, srv := newContractServer(t, decision, func(*http.Request, map[string]interface{}) (int, string) { return 200, `{"id":"x"}` })
		result, _ := rpcCall(t, contractMCP(srv.URL), "project_create", map[string]interface{}{"title": "Move the database"})
		got, _ := json.Marshal(result["structuredContent"])
		var gotDoc, wantDoc interface{}
		_ = json.Unmarshal(got, &gotDoc)
		if err := json.Unmarshal([]byte(want), &wantDoc); err != nil {
			t.Fatalf("%s: the fixture's result is not a receipt: %v", name, err)
		}
		if !reflect.DeepEqual(gotDoc, wantDoc) {
			t.Fatalf("%s: the runner answers\n%s\nthe clients read\n%s", name, got, want)
		}
	}
}
