package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestTaskEvidenceFourCLITruthsAndMCPDescriptorsAgree(t *testing.T) {
	for _, usage := range []string{
		"orbit task evidence-list [task-id] [--json]",
		"orbit task evidence-submit [task-id] (--evidence JSON | --evidence-file -)",
		"orbit task evidence-decide [task-id] --decision CONFIRM|SEND_BACK --evidence-revision N",
	} {
		if !strings.Contains(taskHelp, usage) {
			t.Errorf("group help is missing %q", usage)
		}
	}
	for _, action := range []string{"evidence-list", "evidence-submit", "evidence-decide"} {
		if !strings.Contains(taskActionHelp[action], "Usage:") {
			t.Errorf("per-action usage is missing for %s", action)
		}
	}

	capabilities := map[string]bool{}
	for _, capability := range baseCLICapabilities {
		capabilities[capability.Tool] = true
	}
	descriptors := map[string]bool{}
	for _, descriptor := range toolDescriptors(false, false) {
		name, _ := descriptor["name"].(string)
		descriptors[name] = true
	}
	for _, tool := range []string{"task_evidence_list", "task_evidence_submit", "task_evidence_decide"} {
		if !capabilities[tool] || !descriptors[tool] {
			t.Errorf("%s missing: capability=%v descriptor=%v", tool, capabilities[tool], descriptors[tool])
		}
	}
}

// The decision door refuses a session acting for one project the evidence of a task in another
// (EVIDENCE_JUDGMENT_TASK_IN_ANOTHER_PROJECT): a confirmed move takes the task's undecided evidence
// to the project it moved into, so the project it left can no longer decide it. Each place an agent
// reads what the door checks names that refusal, and none still counts four checks.
func TestEvidenceDecideNamesTheRefusalForATaskInAnotherProject(t *testing.T) {
	tools := toolDescriptors(false, false)
	description := mcpToolDescription(tools, "task_evidence_decide")
	assertSaysAll(t, "the task_evidence_decide tool description", description,
		"Five things are checked at decision time",
		"a session that acts for one project — its coordinator, a judgment session opened for it, a run of one of its tasks — must not decide a task that is in another project (EVIDENCE_JUDGMENT_TASK_IN_ANOTHER_PROJECT",
		"a task's evidence is decided from the project it is in now, and a task moved out takes its undecided evidence with it, so the project it left can no longer decide it",
	)

	help := collapsedSpace(taskActionHelp["evidence-decide"])
	assertSaysAll(t, "`orbit task evidence-decide --help`", help,
		"A session that acts for one project (its coordinator, a judgment session opened for it, a run of one of its tasks) is refused for a task in another (EVIDENCE_JUDGMENT_TASK_IN_ANOTHER_PROJECT)",
		"a task's evidence is decided from the project it is in now, and a task moved out takes its undecided evidence with it, so the project it left can no longer decide it.",
	)

	var spec cliCapabilitySpec
	for _, candidate := range baseCLICapabilities {
		if candidate.Tool == "task_evidence_decide" {
			spec = candidate
		}
	}
	assertSaysAll(t, "`orbit capabilities` for task_evidence_decide", spec.Description,
		"the deciding session must not have done the work, and a session acting for one project may not decide a task in another — a moved task's evidence is decided by the project it is in now",
	)

	for where, text := range map[string]string{
		"the task_evidence_decide tool description":     description,
		"`orbit task evidence-decide --help`":           help,
		"`orbit capabilities` for task_evidence_decide": spec.Description,
	} {
		if strings.Contains(strings.ToLower(text), "four things") {
			t.Errorf("%s still counts four checks:\n%s", where, text)
		}
	}
}

func TestTaskEvidenceCLIAndMCPUseTheSameWireStructure(t *testing.T) {
	type observed struct {
		method  string
		path    string
		agent   string
		session string
		body    map[string]interface{}
	}
	var calls []observed
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := observed{
			method:  r.Method,
			path:    r.URL.Path,
			agent:   r.Header.Get("X-Orbit-Agent-Id"),
			session: r.Header.Get("X-Orbit-Session-Id"),
		}
		if r.Method == http.MethodPost {
			if err := json.NewDecoder(r.Body).Decode(&call.body); err != nil {
				t.Errorf("decode evidence body: %v", err)
			}
		}
		calls = append(calls, call)
		w.Header().Set("content-type", "application/json")
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(`[{"id":"ev-1","revision":"1","evidence":{"exitCode":0}}]`))
			return
		}
		_, _ = w.Write([]byte(`{"id":"ev-1","revision":"1","evidence":{"exitCode":0}}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_TASK_ID", "task-1")
	t.Setenv("ORBIT_SESSION_ID", "session-1")
	t.Setenv("ORBIT_AGENT_ID", "agent-1")

	var cliSubmit bytes.Buffer
	if err := cmdTaskCLI([]string{
		"evidence-submit", "--evidence", `{"exitCode":0,"rawOutput":"ok\n"}`,
		"--idempotency-key", "turn-1", "--json",
	}, strings.NewReader(""), &cliSubmit); err != nil {
		t.Fatal(err)
	}
	mcp := &mcpServer{
		t:         NewTransport(srv.URL, "runner-secret"),
		taskID:    "task-1",
		sessionID: "session-1",
		agentID:   "agent-1",
	}
	result := mcp.callTool("task_evidence_submit", map[string]interface{}{
		"evidence":       map[string]interface{}{"exitCode": float64(0), "rawOutput": "ok\n"},
		"idempotencyKey": "turn-1",
	})
	if result["isError"] == true {
		t.Fatalf("MCP submit failed: %#v", result)
	}

	var cliList bytes.Buffer
	if err := cmdTaskCLI([]string{"evidence-list", "--json"}, strings.NewReader(""), &cliList); err != nil {
		t.Fatal(err)
	}
	result = mcp.callTool("task_evidence_list", map[string]interface{}{})
	if result["isError"] == true {
		t.Fatalf("MCP list failed: %#v", result)
	}

	if len(calls) != 4 {
		t.Fatalf("calls = %#v", calls)
	}
	for i, call := range calls {
		if call.path != "/api/runner/tasks/task-1/evidence" {
			t.Errorf("call %d path = %q", i, call.path)
		}
	}
	if calls[0].method != http.MethodPost || calls[1].method != http.MethodPost ||
		calls[2].method != http.MethodGet || calls[3].method != http.MethodGet {
		t.Fatalf("methods = %#v", calls)
	}
	if !reflect.DeepEqual(calls[0].body, calls[1].body) {
		t.Fatalf("CLI body %#v != MCP body %#v", calls[0].body, calls[1].body)
	}
	for _, call := range calls[:2] {
		if call.agent != "agent-1" || call.session != "session-1" {
			t.Errorf("attribution headers = agent %q session %q", call.agent, call.session)
		}
	}
}

func TestTaskEvidenceSubmitRequiresStructuredEvidenceAndSourceSession(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv("ORBIT_TASK_ID", "task-1")
	t.Setenv("ORBIT_SESSION_ID", "")
	var out bytes.Buffer
	err := cmdTaskCLI([]string{"evidence-submit", "--evidence", `{"ok":true}`}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "ORBIT_SESSION_ID is required") {
		t.Fatalf("missing source Session error = %v", err)
	}
	err = cmdTaskCLI([]string{"evidence-submit", "--evidence", `["prose"]`, "--source-session-id", "s"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "one JSON object") {
		t.Fatalf("scalar/array evidence error = %v", err)
	}
}

// The decision door has to be the same door over both faces, for the same reason submission does:
// an agent that reads `capabilities --json` and an agent holding the MCP tool must send the same
// request, and the deciding Session must be the authenticated header on both — a decision whose
// author could be typed into the body would be a decision anybody could attribute to a session
// that never made it.
func TestTaskEvidenceDecideCLIAndMCPUseTheSameWireStructure(t *testing.T) {
	type observed struct {
		path    string
		session string
		body    map[string]interface{}
	}
	var calls []observed
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := observed{path: r.URL.Path, session: r.Header.Get("X-Orbit-Session-Id")}
		if err := json.NewDecoder(r.Body).Decode(&call.body); err != nil {
			t.Errorf("decode decision body: %v", err)
		}
		calls = append(calls, call)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"id":"dec-1","decision":"SEND_BACK","evidenceRevision":"2"}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_TASK_ID", "task-1")
	t.Setenv("ORBIT_SESSION_ID", "session-2")
	t.Setenv("ORBIT_AGENT_ID", "agent-1")

	var cliOut bytes.Buffer
	if err := cmdTaskCLI([]string{
		"evidence-decide", "--decision", "SEND_BACK", "--evidence-revision", "2",
		"--note", "cite the manifest", "--json",
	}, strings.NewReader(""), &cliOut); err != nil {
		t.Fatal(err)
	}
	mcp := &mcpServer{
		t:         NewTransport(srv.URL, "runner-secret"),
		taskID:    "task-1",
		sessionID: "session-2",
		agentID:   "agent-1",
	}
	result := mcp.callTool("task_evidence_decide", map[string]interface{}{
		"decision": "SEND_BACK", "evidenceRevision": "2", "note": "cite the manifest",
	})
	if result["isError"] == true {
		t.Fatalf("MCP decide failed: %#v", result)
	}

	if len(calls) != 2 {
		t.Fatalf("calls = %#v", calls)
	}
	for i, call := range calls {
		if call.path != "/api/runner/tasks/task-1/evidence/decision" {
			t.Errorf("call %d path = %q", i, call.path)
		}
		if call.session != "session-2" {
			t.Errorf("call %d deciding session header = %q", i, call.session)
		}
	}
	if !reflect.DeepEqual(calls[0].body, calls[1].body) {
		t.Fatalf("CLI body %#v != MCP body %#v", calls[0].body, calls[1].body)
	}
}

// The three refusals a decider can be given before anything leaves the machine.
func TestTaskEvidenceDecideRefusesLocallyWithoutDecisionRevisionOrSession(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv("ORBIT_TASK_ID", "task-1")
	t.Setenv("ORBIT_SESSION_ID", "session-2")
	var out bytes.Buffer
	err := cmdTaskCLI([]string{"evidence-decide", "--evidence-revision", "2"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "--decision must be CONFIRM or SEND_BACK") {
		t.Fatalf("missing decision error = %v", err)
	}
	err = cmdTaskCLI([]string{"evidence-decide", "--decision", "CONFIRM"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "--evidence-revision is required") {
		t.Fatalf("missing revision error = %v", err)
	}
	t.Setenv("ORBIT_SESSION_ID", "")
	err = cmdTaskCLI([]string{
		"evidence-decide", "--decision", "CONFIRM", "--evidence-revision", "2",
	}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "ORBIT_SESSION_ID is required") {
		t.Fatalf("missing deciding session error = %v", err)
	}
}
