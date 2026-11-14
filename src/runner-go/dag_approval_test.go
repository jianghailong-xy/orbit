package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// The two surfaces are one policy.
//
// An agent reaches the same writes over MCP and over the in-session CLI. These pin that the SAME
// input produces the same card, the same write and the same attribution whichever door it used —
// and that the DAG batch, whose CLI door used to write with no approval at all, now asks exactly
// where the MCP tool does (docs/orbit-agent-contract.md §2.4, gap G4).

type surfaceCall struct {
	method  string
	path    string
	headers http.Header
	body    map[string]interface{}
}

type surfaceRecorder struct {
	mu    sync.Mutex
	calls []surfaceCall
}

func (r *surfaceRecorder) add(call surfaceCall) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, call)
}

// callsMatching returns the recorded requests whose path contains `fragment`.
func (r *surfaceRecorder) callsMatching(fragment string) []surfaceCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []surfaceCall
	for _, call := range r.calls {
		if strings.Contains(call.path, fragment) {
			out = append(out, call)
		}
	}
	return out
}

// parityServer answers the three doors the task and DAG writes use. The preview says one edge is
// effective; the card is answered with `decision`; every other request answers `writeBody`.
func parityServer(t *testing.T, decision, writeBody string) (*httptest.Server, *surfaceRecorder) {
	t.Helper()
	recorder := &surfaceRecorder{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := map[string]interface{}{}
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		recorder.add(surfaceCall{r.Method, r.URL.Path, r.Header.Clone(), body})
		switch {
		case strings.Contains(r.URL.Path, "/approvals/"):
			_, _ = w.Write([]byte(decision))
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			_, _ = w.Write([]byte(`{"id":"ap1","status":"PENDING"}`))
		case strings.Contains(r.URL.Path, "/dag-preview"):
			_, _ = w.Write([]byte(`{"effectiveCount":1,"noopCount":0}`))
		default:
			_, _ = w.Write([]byte(writeBody))
		}
	}))
	t.Cleanup(srv.Close)
	return srv, recorder
}

// cardAndWrite returns the one card the surface filed and the one write it made, failing when
// either is missing or made twice. Everything under /approvals and every preview is not a write.
func cardAndWrite(t *testing.T, recorder *surfaceRecorder) (card map[string]interface{}, write surfaceCall) {
	t.Helper()
	var filed []map[string]interface{}
	for _, call := range recorder.calls {
		if strings.HasSuffix(call.path, "/approvals") {
			filed = append(filed, call.body)
		}
	}
	if len(filed) != 1 {
		t.Fatalf("filed %d cards, want one: %+v", len(filed), recorder.calls)
	}
	var writes []surfaceCall
	for _, call := range recorder.calls {
		if call.method != "POST" && call.method != "PATCH" {
			continue
		}
		if strings.Contains(call.path, "/approvals") || strings.Contains(call.path, "preview") {
			continue
		}
		writes = append(writes, call)
	}
	if len(writes) != 1 {
		t.Fatalf("made %d writes, want one: %+v", len(writes), recorder.calls)
	}
	return filed[0], writes[0]
}

// sameOnBothSurfaces compares what the two doors asked and what they wrote, field by field.
func sameOnBothSurfaces(t *testing.T, mcpCard map[string]interface{}, mcpWrite surfaceCall, cliCard map[string]interface{}, cliWrite surfaceCall) {
	t.Helper()
	mcpCardJSON, _ := json.Marshal(mcpCard)
	cliCardJSON, _ := json.Marshal(cliCard)
	if string(mcpCardJSON) != string(cliCardJSON) {
		t.Errorf("card differs: MCP %s, CLI %s", mcpCardJSON, cliCardJSON)
	}
	if mcpWrite.method != cliWrite.method || mcpWrite.path != cliWrite.path {
		t.Errorf("write differs: MCP %s %s, CLI %s %s", mcpWrite.method, mcpWrite.path, cliWrite.method, cliWrite.path)
	}
	mcpBody, _ := json.Marshal(mcpWrite.body)
	cliBody, _ := json.Marshal(cliWrite.body)
	if string(mcpBody) != string(cliBody) {
		t.Errorf("write body differs: MCP %s, CLI %s", mcpBody, cliBody)
	}
	for _, header := range []string{"X-Orbit-Session-Id", "X-Orbit-Agent-Id"} {
		if got, want := cliWrite.headers.Get(header), mcpWrite.headers.Get(header); got != want {
			t.Errorf("%s differs: MCP %q, CLI %q", header, want, got)
		}
	}
}

func TestTaskCreateAsksTheSameQuestionOnBothSurfaces(t *testing.T) {
	input := map[string]interface{}{"title": "Fix login redirect", "completionCriterion": "EVIDENCE_JUDGMENT"}

	mcpSrv, mcpRecorder := parityServer(t, `{"status":"ALLOWED"}`, `{"id":"t1"}`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(mcpSrv.URL, "tok")}
	if res := mcp.callTool("task_create", input); res["isError"] == true {
		t.Fatalf("MCP task_create: %s", resultText(res))
	}
	mcpCard, mcpWrite := cardAndWrite(t, mcpRecorder)

	cliSrv, cliRecorder := parityServer(t, `{"status":"ALLOWED"}`, `{"id":"t1"}`)
	configureCLITestRunner(t, cliSrv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")
	t.Setenv("ORBIT_AGENT_ID", "agent-1")
	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"create", "--title", "Fix login redirect",
		"--completion-criterion", "EVIDENCE_JUDGMENT", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("CLI task create: %v", err)
	}
	cliCard, cliWrite := cardAndWrite(t, cliRecorder)

	sameOnBothSurfaces(t, mcpCard, mcpWrite, cliCard, cliWrite)
	if mcpCard["toolName"] != taskCreateApprovalToolName || mcpWrite.path != "/api/runner/tasks" {
		t.Fatalf("card=%v write=%+v", mcpCard["toolName"], mcpWrite.path)
	}
}

func TestTaskCreateBatchAsksTheSameQuestionOnBothSurfaces(t *testing.T) {
	tasks := []interface{}{map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT"}}

	mcpSrv, mcpRecorder := parityServer(t, `{"status":"ALLOWED"}`, `[{"id":"t1"}]`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(mcpSrv.URL, "tok")}
	if res := mcp.callTool("task_create_batch", map[string]interface{}{"tasks": tasks}); res["isError"] == true {
		t.Fatalf("MCP task_create_batch: %s", resultText(res))
	}
	mcpCard, mcpWrite := cardAndWrite(t, mcpRecorder)

	cliSrv, cliRecorder := parityServer(t, `{"status":"ALLOWED"}`, `[{"id":"t1"}]`)
	configureCLITestRunner(t, cliSrv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")
	t.Setenv("ORBIT_AGENT_ID", "agent-1")
	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"create-batch",
		"--tasks", `[{"title":"a","completionCriterion":"EVIDENCE_JUDGMENT"}]`, "--json"},
		strings.NewReader(""), &out); err != nil {
		t.Fatalf("CLI task create-batch: %v", err)
	}
	cliCard, cliWrite := cardAndWrite(t, cliRecorder)

	sameOnBothSurfaces(t, mcpCard, mcpWrite, cliCard, cliWrite)
	if mcpCard["toolName"] != batchApprovalToolName || mcpWrite.path != "/api/runner/tasks/batch-create" {
		t.Fatalf("card=%v write=%+v", mcpCard["toolName"], mcpWrite.path)
	}
}

func TestTasklistProposeDagAsksTheSameQuestionOnBothSurfaces(t *testing.T) {
	ops := []interface{}{map[string]interface{}{"op": "add", "taskId": "t1", "dependsOnTaskId": "p1"}}

	mcpSrv, mcpRecorder := parityServer(t, `{"status":"ALLOWED"}`, `{"added":1,"removed":0}`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(mcpSrv.URL, "tok")}
	if res := mcp.callTool("tasklist_propose_dag", map[string]interface{}{"listId": "list-1", "ops": ops}); res["isError"] == true {
		t.Fatalf("MCP tasklist_propose_dag: %s", resultText(res))
	}
	mcpCard, mcpWrite := cardAndWrite(t, mcpRecorder)

	cliSrv, cliRecorder := parityServer(t, `{"status":"ALLOWED"}`, `{"added":1,"removed":0}`)
	configureCLITestRunner(t, cliSrv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")
	t.Setenv("ORBIT_AGENT_ID", "agent-1")
	var out bytes.Buffer
	if err := cmdTaskListCLI([]string{"propose-dag", "list-1", "--add", "t1:p1", "--apply", "--json"},
		strings.NewReader(""), &out); err != nil {
		t.Fatalf("CLI propose-dag: %v", err)
	}
	cliCard, cliWrite := cardAndWrite(t, cliRecorder)

	sameOnBothSurfaces(t, mcpCard, mcpWrite, cliCard, cliWrite)
	if mcpCard["toolName"] != dagApprovalToolName || mcpWrite.path != "/api/runner/task-lists/list-1/dag-apply" {
		t.Fatalf("card=%v write=%+v", mcpCard["toolName"], mcpWrite.path)
	}
}

func TestCLIDagApplyInsideASessionAsksBeforeWriting(t *testing.T) {
	srv, recorder := parityServer(t, `{"status":"ALLOWED"}`, `{"added":1,"removed":0}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")

	var out bytes.Buffer
	if err := cmdTaskListCLI([]string{"propose-dag", "list-1", "--add", "t1:p1", "--apply", "--json"},
		strings.NewReader(""), &out); err != nil {
		t.Fatalf("propose-dag: %v", err)
	}
	// The order is the rule: preview, the card, and only then the write.
	var order []string
	for _, call := range recorder.calls {
		switch {
		case strings.Contains(call.path, "/dag-preview"):
			order = append(order, "preview")
		case strings.HasSuffix(call.path, "/approvals"):
			order = append(order, "card")
		case strings.Contains(call.path, "/dag-apply"):
			order = append(order, "apply")
		case strings.Contains(call.path, "/approvals/"):
			order = append(order, "poll")
		}
	}
	if strings.Join(order, ",") != "preview,card,poll,apply" {
		t.Fatalf("call order = %v", order)
	}
}

func TestCLIDagApplyWritesNothingWhenDenied(t *testing.T) {
	srv, recorder := parityServer(t, `{"status":"DENIED","message":"not this graph"}`, `{"added":1,"removed":0}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")

	var out bytes.Buffer
	err := cmdTaskListCLI([]string{"propose-dag", "list-1", "--add", "t1:p1", "--apply", "--json"},
		strings.NewReader(""), &out)
	if err == nil {
		t.Fatal("a declined card was reported as success")
	}
	for _, call := range recorder.calls {
		if strings.Contains(call.path, "/dag-apply") {
			t.Fatalf("wrote without a yes: %+v", recorder.calls)
		}
	}
	// The one refusal document, with the code both surfaces report.
	var refusal struct {
		Refused bool   `json:"refused"`
		Code    string `json:"code"`
		Tool    string `json:"tool"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal([]byte(err.Error()), &refusal); err != nil {
		t.Fatalf("the refusal is not the shared document: %v (%s)", err, err.Error())
	}
	if !refusal.Refused || refusal.Code != approvalDeclinedCode || refusal.Tool != dagApprovalToolName {
		t.Fatalf("refusal = %+v", refusal)
	}
	if !strings.Contains(refusal.Message, "not this graph") {
		t.Fatalf("the person's reason is missing: %q", refusal.Message)
	}
}

// A process in no session has no card to raise and sends the apply alone. That request is REFUSED
// by the control plane (`task-write-approval.ts`: the machine credential has no card-free write),
// and the CLI reports its refusal; what is asserted here is the request shape the runner sends, so
// the two layers stay distinguishable.
func TestCLIDagApplyHeadlessSendsTheApplyWithoutACard(t *testing.T) {
	srv, recorder := parityServer(t, `{"status":"DENIED"}`, `{"added":1,"removed":0}`)
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "")

	var out bytes.Buffer
	if err := cmdTaskListCLI([]string{"propose-dag", "list-1", "--add", "t1:p1", "--apply", "--json"},
		strings.NewReader(""), &out); err != nil {
		t.Fatalf("propose-dag: %v", err)
	}
	for _, call := range recorder.calls {
		if strings.Contains(call.path, "/approvals") {
			t.Fatalf("a headless apply raised a card: %+v", recorder.calls)
		}
	}
	if len(recorder.callsMatching("/dag-apply")) != 1 {
		t.Fatalf("calls = %+v", recorder.calls)
	}
}

// A batch that cannot be applied is nobody's decision: it is refused before a card is filed, so the
// person is never asked to approve a change the graph would refuse anyway.
func TestDagChangeWithACycleAsksNobody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/dag-preview") {
			_, _ = w.Write([]byte(`{"effectiveCount":2,"cycle":[{"taskId":"a","title":"A"},{"taskId":"b","title":"B"}]}`))
			return
		}
		t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(srv.Close)

	_, _, err := dagChangeWithApproval(NewTransport(srv.URL, "tok"), "sess-1", "list-1",
		[]interface{}{map[string]interface{}{"op": "add", "taskId": "a", "dependsOnTaskId": "b"}}, "")
	if err == nil || !strings.Contains(err.Error(), "would create a cycle: A -> B") {
		t.Fatalf("err = %v", err)
	}
}
