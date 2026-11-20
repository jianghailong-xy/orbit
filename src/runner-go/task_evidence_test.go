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
		"Seven things are checked at decision time",
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
		"the deciding session must not have done the work, a session acting for one project may not decide a task in another — a moved task's evidence is decided by the project it is in now",
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

// A run decides another task's evidence only when it is addressed to that run
// (EVIDENCE_JUDGMENT_FROM_RUN_REFUSED), and each place an agent reads what the door checks says so.
func TestEvidenceDecideNamesTheRefusalForARunOfAnotherTask(t *testing.T) {
	description := mcpToolDescription(toolDescriptors(false, false), "task_evidence_decide")
	assertSaysAll(t, "the task_evidence_decide tool description", description,
		"EVIDENCE_JUDGMENT_FROM_RUN_REFUSED",
		"by the session that dispatched a task in no project, by a run of a task that verifies this one, or by the account owner in the app",
	)
	assertSaysAll(t, "`orbit task evidence-decide --help`", collapsedSpace(taskActionHelp["evidence-decide"]),
		"A run of another task, or a conversation a run opened, is refused unless the evidence is addressed to that session",
		"EVIDENCE_JUDGMENT_FROM_RUN_REFUSED",
	)
	var spec cliCapabilitySpec
	for _, candidate := range baseCLICapabilities {
		if candidate.Tool == "task_evidence_decide" {
			spec = candidate
		}
	}
	assertSaysAll(t, "`orbit capabilities` for task_evidence_decide", spec.Description,
		"a run of another task may not decide evidence that is not addressed to it",
	)
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

// collapsedSpace is text with every run of whitespace one space: a usage line the help wraps is
// still the one line the contract writes.
func collapsedSpace(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

func assertSaysAll(t *testing.T, what, text string, phrases ...string) {
	t.Helper()
	for _, phrase := range phrases {
		if !strings.Contains(text, phrase) {
			t.Errorf("%s does not say %q:\n%s", what, phrase, text)
		}
	}
}

// The server binds the standard a revision is judged against (docs/evidence-always-has-an-addressee-design.md
// §2, D1), so neither face asks for `criterion` or needs one: the tool schema requires only `evidence`,
// its description and the CLI help ask for three fields, and an envelope without `criterion` reaches
// the server as written from both.
func TestTaskEvidenceSubmitNeedsNoCriterion(t *testing.T) {
	var submit map[string]interface{}
	for _, descriptor := range toolDescriptors(false, false) {
		if descriptor["name"] == "task_evidence_submit" {
			submit = descriptor
		}
	}
	if submit == nil {
		t.Fatal("task_evidence_submit descriptor missing")
	}
	schema := submit["inputSchema"].(map[string]interface{})
	if required, _ := json.Marshal(schema["required"]); string(required) != `["evidence"]` {
		t.Errorf("required = %s, want only evidence", required)
	}
	evidence := schema["properties"].(map[string]interface{})["evidence"].(map[string]interface{})
	if _, ok := evidence["required"]; ok {
		t.Errorf("evidence schema requires fields: %#v", evidence["required"])
	}
	if _, ok := evidence["properties"]; ok {
		t.Errorf("evidence schema declares properties: %#v", evidence["properties"])
	}
	evidenceDescription, _ := evidence["description"].(string)
	submitDescription, _ := submit["description"].(string)
	help := collapsedSpace(taskActionHelp["evidence-submit"])
	assertSaysAll(t, "the evidence property", evidenceDescription, "The envelope, three fields: `claim`")
	assertSaysAll(t, "the task_evidence_submit description", submitDescription,
		"the three fields are required",
		"an older client's `criterion` is accepted and ignored",
	)
	assertSaysAll(t, "`orbit task evidence-submit --help`", help,
		`The envelope is {"claim": ..., "checks": [...], "gaps": [...]}. It names no standard`,
		`A "criterion" an older client still sends is accepted and ignored.`,
	)
	for where, text := range map[string]string{
		"the evidence property":                evidenceDescription,
		"the task_evidence_submit description": submitDescription,
		"`orbit task evidence-submit --help`":  help,
	} {
		for _, stale := range []string{"four fields", "criterion` ({key, text}", "criterion{key,text}", "copied from the project"} {
			if strings.Contains(text, stale) {
				t.Errorf("%s still asks for a criterion (%q):\n%s", where, stale, text)
			}
		}
	}

	var bodies []map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode evidence body: %v", err)
		}
		bodies = append(bodies, body)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"id":"ev-1","revision":"1"}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_TASK_ID", "task-1")
	t.Setenv("ORBIT_SESSION_ID", "session-1")
	t.Setenv("ORBIT_AGENT_ID", "agent-1")

	const envelope = `{"claim":"done","checks":[{"kind":"TOOL_CALL","ref":"bgj_1"}],"gaps":[]}`
	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"evidence-submit", "--evidence", envelope, "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("CLI submit without criterion: %v", err)
	}
	var want map[string]interface{}
	if err := json.Unmarshal([]byte(envelope), &want); err != nil {
		t.Fatal(err)
	}
	mcp := &mcpServer{t: NewTransport(srv.URL, "runner-secret"), taskID: "task-1", sessionID: "session-1", agentID: "agent-1"}
	if result := mcp.callTool("task_evidence_submit", map[string]interface{}{"evidence": want}); result["isError"] == true {
		t.Fatalf("MCP submit without criterion failed: %#v", result)
	}
	if len(bodies) != 2 {
		t.Fatalf("bodies = %#v", bodies)
	}
	for i, body := range bodies {
		if !reflect.DeepEqual(body["evidence"], want) {
			t.Errorf("call %d evidence = %#v, want %#v", i, body["evidence"], want)
		}
	}
}

// A gap may name the clause of the task's standard it leaves unproven (gapClauses), and a CONFIRM
// is refused while such a gap has no follow-up task (EVIDENCE_JUDGMENT_GAP_WITHOUT_FOLLOW_UP). Both
// tool texts and both help texts say so, so a submitter knows to mark it and a decider knows why.
func TestEvidenceToolsDescribeGapClausesAndTheirFollowUp(t *testing.T) {
	tools := toolDescriptors(false, false)
	assertSaysAll(t, "the task_evidence_submit tool description", mcpToolDescription(tools, "task_evidence_submit"),
		"`gapClauses` is the one optional field",
	)
	submitSchema, _ := json.Marshal(tools)
	assertSaysAll(t, "the task_evidence_submit evidence schema", string(submitSchema),
		"{gap, criterionClause, followUpTaskId?}",
		"Evidence with a clause-naming gap and no followUpTaskId cannot be CONFIRMed, only sent back",
	)
	assertSaysAll(t, "the task_evidence_decide tool description", mcpToolDescription(tools, "task_evidence_decide"),
		"a CONFIRM is refused while a gap names a clause of the task's standard in `gapClauses` without a followUpTaskId",
		"EVIDENCE_JUDGMENT_GAP_WITHOUT_FOLLOW_UP",
		"SEND_BACK is never blocked by gaps",
	)
	assertSaysAll(t, "`orbit task evidence-submit --help`", collapsedSpace(taskActionHelp["evidence-submit"]),
		`"gapClauses": [{"gap": <index into gaps>, "criterionClause": ..., "followUpTaskId": ...}]`,
	)
	assertSaysAll(t, "`orbit task evidence-decide --help`", collapsedSpace(taskActionHelp["evidence-decide"]),
		"(EVIDENCE_JUDGMENT_GAP_WITHOUT_FOLLOW_UP)",
	)
}
