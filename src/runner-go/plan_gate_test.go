//go:build linux || darwin

package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Orbit's Plan gate (plan_gate.go): in Plan mode a session reads, waits and asks the owner, and changes nothing
// until the plan is approved, on every engine and on both surfaces. These tests hold the policy to the catalogue,
// and each door — `orbit mcp`, Claude's permission prompt for Orbit's tools, the hosted owner wait and the
// in-session CLI — to the policy, with the live mode read from a real session socket. The per-engine,
// per-mode matrix the policy is part of is permission_matrix_test.go.

// planModeIs is a mode reader for the gate that answers one mode for a session it knows.
func planModeIs(mode string) func() (string, bool, error) {
	return func() (string, bool, error) { return mode, true, nil }
}

// planGateControlPlane is a stub control plane that answers every request with an empty object and records it,
// so a test can say that a refused call reached nothing.
type planGateControlPlane struct {
	mu       sync.Mutex
	requests []string
	srv      *httptest.Server
}

func newPlanGateControlPlane(t *testing.T) *planGateControlPlane {
	t.Helper()
	c := &planGateControlPlane{}
	c.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		c.requests = append(c.requests, r.Method+" "+r.URL.Path)
		c.mu.Unlock()
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/approvals"):
			_, _ = w.Write([]byte(`{"id":"card-1","status":"PENDING"}`))
		case strings.Contains(r.URL.Path, "/approvals/"):
			_, _ = w.Write([]byte(`{"id":"card-1","status":"ALLOWED"}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(c.srv.Close)
	return c
}

func (c *planGateControlPlane) seen() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.requests...)
}

// Every operation states what Plan does with it, and the statement is the catalogue's: a read runs, bg_run is
// its own gate's, a write runs only when the catalogue says why it changes no work, and every other write is
// refused. The tables the rule reads name real operations, so none of them can go stale unnoticed.
func TestEveryOperationHasAPlanPolicy(t *testing.T) {
	built := operationCatalog()
	for _, op := range built.Ops {
		var want operationPlan
		switch {
		case catalogPlanOwnGates[op.Tool] != "":
			want = planOwnGate
		case !op.Mutates, catalogPlanRunsWrites[op.Tool] != "":
			want = planRuns
		default:
			want = planRefused
		}
		if op.Plan != want {
			t.Errorf("%s: Plan = %q, want %q", op.Tool, op.Plan, want)
		}
		if (op.PlanReason != "") != (catalogPlanOwnGates[op.Tool] != "" || catalogPlanRunsWrites[op.Tool] != "") {
			t.Errorf("%s: PlanReason %q does not match the tables", op.Tool, op.PlanReason)
		}
	}
	for tool := range catalogPlanRunsWrites {
		if op := built.ByTool[tool]; op == nil || !op.Mutates {
			t.Errorf("catalogPlanRunsWrites names %s, which is not a write of the catalogue", tool)
		}
	}
	for tool := range catalogPlanOwnGates {
		if built.ByTool[tool] == nil {
			t.Errorf("catalogPlanOwnGates names %s, which the catalogue does not declare", tool)
		}
	}
	for tool, arg := range catalogPlanPreviewArgs {
		op := built.ByTool[tool]
		if op == nil || op.MCP == nil {
			t.Errorf("catalogPlanPreviewArgs names %s, which is not an MCP tool of the catalogue", tool)
			continue
		}
		props, _ := op.MCP.InputSchema["properties"].(map[string]interface{})
		if _, ok := props[arg]; !ok {
			t.Errorf("%s takes no %q, which catalogPlanPreviewArgs says makes it a preview", tool, arg)
		}
	}
	for tool := range catalogOpenWorld {
		if built.ByTool[tool] == nil {
			t.Errorf("catalogOpenWorld names %s, which the catalogue does not declare", tool)
		}
	}
	// The cases this change was made for, said out loud.
	for tool, want := range map[string]operationPlan{
		"task_get": planRuns, "task_list": planRuns, "project_get": planRuns, "task_dependency_graph": planRuns,
		"task_await": planRuns, "notify": planRuns, "request_owner_action": planRuns,
		"task_create": planRefused, "task_update": planRefused, "task_comment": planRefused, "task_start": planRefused,
		"task_dependency_add": planRefused, "task_dependency_remove": planRefused, "session_create": planRefused,
		"agent_update": planRefused, "project_create": planRefused, "bg_kill": planRefused, "bg_run": planOwnGate,
	} {
		if got := built.ByTool[tool].Plan; got != want {
			t.Errorf("%s: Plan = %q, want %q", tool, got, want)
		}
	}
}

// The annotations every engine reads say what the catalogue says: a read is read-only, a write says whether it
// destroys, and only a background job reaches beyond Orbit. Claude Code's Plan mode runs a call it is told is
// read-only and holds any other; Codex asks for consent only for a call that is not read-only and is destructive
// or open-world. A descriptor's own annotations may say more than the catalogue (file_fetch writes a local file),
// never less.
func TestCatalogAnnotationsSayWhatTheCatalogueSays(t *testing.T) {
	for _, op := range operationCatalog().Ops {
		if op.MCP == nil {
			continue
		}
		annotations, _ := op.MCP.Extra["annotations"].(map[string]interface{})
		if annotations == nil {
			t.Errorf("%s carries no annotations", op.Tool)
			continue
		}
		readOnly, _ := annotations["readOnlyHint"].(bool)
		if readOnly && op.Mutates {
			t.Errorf("%s writes but says readOnlyHint true", op.Tool)
		}
		if !readOnly && !op.Mutates && op.Tool != "file_fetch" {
			t.Errorf("%s only reads but does not say readOnlyHint true", op.Tool)
		}
		if op.Mutates {
			if destructive, ok := annotations["destructiveHint"].(bool); !ok || destructive != op.Destructive {
				t.Errorf("%s: destructiveHint = %v, the catalogue says destructive=%v", op.Tool, annotations["destructiveHint"], op.Destructive)
			}
		}
		if openWorld, ok := annotations["openWorldHint"].(bool); !ok || openWorld != catalogOpenWorld[op.Tool] {
			t.Errorf("%s: openWorldHint = %v, want %v", op.Tool, annotations["openWorldHint"], catalogOpenWorld[op.Tool])
		}
	}
}

// In Plan a write is refused before anything is filed or written, with what to do instead; a read, a wait, a
// question for the owner and a preview run; and bg_run is left to the background-job gate, whose own refusal says
// what to do. Outside Plan nothing is refused, and with no session to ask about there is no gate at all.
func TestPlanGateRefusesWritesAndRunsEverythingElse(t *testing.T) {
	refused := []string{"task_update", "task_create", "task_comment", "task_dependency_remove", "task_evidence_submit",
		"session_create", "agent_delete", "project_update", "provider_create", "wiki_propose", "file_upload", "bg_kill"}
	runs := []string{"task_get", "task_list", "project_get", "session_get", "task_await", "watch_create", "notify",
		"ask_owner", "request_owner_action", "schedule_wakeup", "bg_run", "bg_output", "permission_prompt", "not_a_tool"}
	for _, tool := range refused {
		refusal := mcpPlanRefusal(tool, map[string]interface{}{}, planModeIs("plan"))
		if !strings.Contains(refusal, "this session is in Plan mode") || !strings.Contains(refusal, tool+" writes to Orbit") ||
			!strings.Contains(refusal, "Nothing was written") || !strings.Contains(refusal, "Put it in your plan") {
			t.Errorf("Plan let %s through, or said so badly: %q", tool, refusal)
		}
		for _, mode := range []string{"default", "acceptEdits", "auto", "dontAsk", "bypassPermissions"} {
			if refusal := mcpPlanRefusal(tool, nil, planModeIs(mode)); refusal != "" {
				t.Errorf("%s refused %s: %q", mode, tool, refusal)
			}
		}
		if refusal := mcpPlanRefusal(tool, nil, func() (string, bool, error) { return "", false, nil }); refusal != "" {
			t.Errorf("with no session to ask about, %s was refused: %q", tool, refusal)
		}
	}
	for _, tool := range runs {
		if refusal := mcpPlanRefusal(tool, map[string]interface{}{}, planModeIs("plan")); refusal != "" {
			t.Errorf("Plan refused %s: %q", tool, refusal)
		}
	}
	if refusal := mcpPlanRefusal("task_create_batch", map[string]interface{}{"dryRun": true}, planModeIs("plan")); refusal != "" {
		t.Errorf("Plan refused a dry-run batch, which writes nothing: %q", refusal)
	}
	if refusal := mcpPlanRefusal("task_create_batch", map[string]interface{}{"dryRun": false}, planModeIs("plan")); refusal == "" {
		t.Error("Plan let a batch through")
	}
}

// A read never asks for the mode, so it costs nothing and never fails on a mode that cannot be read; a write on a
// mode that cannot be read is refused, since nobody can say it is not Plan.
func TestPlanGateReadsTheModeOnlyForAWriteAndFailsClosed(t *testing.T) {
	asked := 0
	unreadable := func() (string, bool, error) { asked++; return "", true, os.ErrDeadlineExceeded }
	if refusal := mcpPlanRefusal("task_get", nil, unreadable); refusal != "" || asked != 0 {
		t.Fatalf("a read asked for the mode (%d) or was refused: %q", asked, refusal)
	}
	refusal := mcpPlanRefusal("task_update", nil, unreadable)
	if asked != 1 || !strings.Contains(refusal, "could not read this session's permission mode") || !strings.Contains(refusal, "Nothing was written") {
		t.Fatalf("a write on an unreadable mode: asked %d, %q", asked, refusal)
	}
}

// The mode comes from the runner that hosts the session, as it is now: an owner can switch it, and Claude Code
// enters and leaves Plan by itself, and only the runner sees either. With no session, or no socket to ask, there is
// nothing to read and no gate; a socket that does not answer is a mode that cannot be read.
func TestSessionPermissionModeIsTheRunnersLiveMode(t *testing.T) {
	f := newGateFixture(t, "plan")
	t.Setenv("ORBIT_SESSION_ID", "sess-gate")
	t.Setenv(envBgSocket, f.socket)
	t.Setenv(envBgToken, "tok")
	if mode, known, err := sessionPermissionMode(); mode != "plan" || !known || err != nil {
		t.Fatalf("sessionPermissionMode() = %q, %v, %v; want plan", mode, known, err)
	}
	f.setMode("default")
	if mode, _, err := sessionPermissionMode(); mode != "default" || err != nil {
		t.Fatalf("after the switch: %q, %v", mode, err)
	}

	t.Setenv(envBgToken, "not-the-token")
	if _, known, err := sessionPermissionMode(); !known || err == nil {
		t.Fatalf("a socket that refused the call read as %v, %v", known, err)
	}
	t.Setenv(envBgSocket, filepath.Join(f.dir, "no.sock"))
	if _, known, err := sessionPermissionMode(); !known || err == nil {
		t.Fatalf("a socket that is not there read as %v, %v", known, err)
	}

	t.Setenv(envBgSocket, "")
	if _, known, err := sessionPermissionMode(); known || err != nil {
		t.Fatalf("with no socket to ask: %v, %v; want no session to gate", known, err)
	}
	t.Setenv(envBgSocket, f.socket)
	t.Setenv(envBgToken, "tok")
	t.Setenv("ORBIT_SESSION_ID", "")
	if _, known, err := sessionPermissionMode(); known || err != nil {
		t.Fatalf("with no session: %v, %v; want no session to gate", known, err)
	}
}

// Through `orbit mcp` itself: a write in Plan comes back as the refusal and reaches no control plane, a read runs,
// and a switch out of Plan lets the same write through without a respawn.
func TestOrbitMCPRefusesAWriteInPlanBeforeItReachesTheControlPlane(t *testing.T) {
	f := newGateFixture(t, "plan")
	t.Setenv("ORBIT_SESSION_ID", "sess-gate")
	t.Setenv(envBgSocket, f.socket)
	t.Setenv(envBgToken, "tok")
	plane := newPlanGateControlPlane(t)
	s := &mcpServer{t: NewTransport(plane.srv.URL, "tok"), sessionID: "sess-gate", taskID: "task-1"}

	res := s.callTool("task_update", map[string]interface{}{"taskId": "task-1", "title": "renamed"})
	if res["isError"] != true || !strings.Contains(resultText(res), "this session is in Plan mode") {
		t.Fatalf("task_update in Plan = %v", res)
	}
	if seen := plane.seen(); len(seen) != 0 {
		t.Fatalf("a refused write reached the control plane: %v", seen)
	}
	if res := s.callTool("task_get", map[string]interface{}{"taskId": "task-1"}); res["isError"] == true {
		t.Fatalf("task_get in Plan = %v", res)
	}
	f.setMode("default")
	if res := s.callTool("task_update", map[string]interface{}{"taskId": "task-1", "title": "renamed"}); res["isError"] == true {
		t.Fatalf("task_update after leaving Plan = %v", res)
	}
	var patched bool
	for _, request := range plane.seen() {
		patched = patched || strings.HasPrefix(request, "PATCH ")
	}
	if !patched {
		t.Fatalf("the write never reached the control plane after leaving Plan: %v", plane.seen())
	}
}

// A create that would wait for the owner is refused in Plan before it is handed to a job or files a card: the
// hosted `orbit mcp` has no socket to read the mode from, so the hand-off must not be where the mode is first read.
// The socket's own door for the hosted wait refuses it too (TestBgOwnerWaitIsItsOwnOperation).
func TestPlanGateRefusesAnOwnerWaitBeforeTheHandOff(t *testing.T) {
	plane := newPlanGateControlPlane(t)
	s := &mcpServer{t: NewTransport(plane.srv.URL, "tok"), sessionID: "sess-gate", callTimeout: time.Minute,
		permissionMode: planModeIs("plan")}
	for _, name := range []string{"task_create", "task_create_batch", "project_create", "provider_create", "tasklist_propose_dag"} {
		res := s.callTool(name, map[string]interface{}{"title": "x", "tasks": []interface{}{ownerWaitTaskArgs}})
		if res["isError"] != true || !strings.Contains(resultText(res), "this session is in Plan mode") {
			t.Errorf("%s in Plan = %v", name, res)
		}
	}
	if seen := plane.seen(); len(seen) != 0 {
		t.Fatalf("a refused create reached the control plane: %v", seen)
	}
}

// Claude Code asks about one of Orbit's own tools only in Plan, where it holds back any MCP tool not said to be
// read-only. The answer is the Plan gate's, with no card: a call Plan runs is allowed, a write is denied with the
// refusal the tool would return. A name the catalogue does not declare, and any other tool, still go to the card.
func TestClaudePermissionPromptAnswersOrbitToolsWithoutACard(t *testing.T) {
	plane := newPlanGateControlPlane(t)
	s := &mcpServer{t: NewTransport(plane.srv.URL, "tok"), sessionID: "sess-gate", allowPermissionPrompt: true,
		permissionMode: planModeIs("plan")}
	prompt := func(tool string) map[string]interface{} {
		var answer map[string]interface{}
		res := s.callTool("permission_prompt", map[string]interface{}{"tool_name": tool, "input": map[string]interface{}{"taskId": "task-1"}, "tool_use_id": "toolu_1"})
		if err := json.Unmarshal([]byte(resultText(res)), &answer); err != nil {
			t.Fatalf("%s: %v in %q", tool, err, resultText(res))
		}
		return answer
	}
	for _, tool := range []string{"task_await", "notify", "file_fetch"} {
		if answer := prompt(claudeToolName(tool)); answer["behavior"] != "allow" {
			t.Errorf("%s in Plan = %v, want allowed", tool, answer)
		}
	}
	answer := prompt(claudeToolName("task_update"))
	if answer["behavior"] != "deny" || !strings.Contains(answer["message"].(string), "this session is in Plan mode") {
		t.Errorf("task_update in Plan = %v, want the Plan refusal", answer)
	}
	if seen := plane.seen(); len(seen) != 0 {
		t.Fatalf("an Orbit tool's prompt filed a card: %v", seen)
	}
	s.permissionMode = planModeIs("default")
	if answer := prompt(claudeToolName("task_update")); answer["behavior"] != "allow" {
		t.Errorf("task_update outside Plan = %v, want allowed", answer)
	}
	if seen := plane.seen(); len(seen) != 0 {
		t.Fatalf("an Orbit tool's prompt filed a card: %v", seen)
	}
	for _, tool := range []string{claudeToolName("not_a_tool"), "Bash", "mcp__acme__deploy"} {
		before := len(plane.seen())
		prompt(tool)
		if len(plane.seen()) == before {
			t.Errorf("%s did not go to the card", tool)
		}
	}
}

// The in-session CLI is held to the same policy, with the same refusal naming the command: a write is refused, a
// read, a help request and a preview run, and a command the catalogue does not declare is not the gate's.
func TestCLIPlanGateRefusesTheSameWrites(t *testing.T) {
	for _, tc := range []struct {
		args    []string
		refused bool
	}{
		{[]string{"task", "update", "task-1", "--title", "x"}, true},
		{[]string{"task", "comment", "task-1", "--body", "x"}, true},
		{[]string{"task", "create", "--title", "x"}, true},
		{[]string{"task", "dependency-remove", "a", "b"}, true},
		{[]string{"project", "update", "p", "--title", "x"}, true},
		{[]string{"session", "merge", "s"}, true},
		{[]string{"session", "merge-receipt", "s", "--result", "MERGED"}, true},
		{[]string{"wiki", "import", "./docs"}, true},
		{[]string{"task", "create-batch", "--tasks-file", "-"}, true},
		{[]string{"task", "create-batch", "--tasks-file", "-", "--dry-run"}, false},
		{[]string{"task", "create-batch", "--dry-run=false"}, true},
		{[]string{"task-list", "propose-dag", "l", "--add", "a:b"}, false},
		{[]string{"task-list", "propose-dag", "l", "--add", "a:b", "--apply"}, true},
		{[]string{"task-list", "propose-dag", "l", "--add", "a:b", "--apply=false"}, false},
		{[]string{"task-list", "propose-dag", "l", "--apply=maybe"}, true},
		{[]string{"task", "get", "task-1"}, false},
		{[]string{"task", "list", "--json"}, false},
		{[]string{"task", "await", "--task-id", "t"}, false},
		{[]string{"notify", "--message", "plan ready"}, false},
		{[]string{"task", "update", "--help"}, false},
		{[]string{"session", "merge-receipts", "s"}, false},
		{[]string{"capabilities", "--json"}, false},
		{[]string{"mcp"}, false},
	} {
		err := cliPlanRefusal(tc.args, planModeIs("plan"))
		if got := err != nil; got != tc.refused {
			t.Errorf("orbit %s in Plan: refused=%v, want %v (%v)", strings.Join(tc.args, " "), got, tc.refused, err)
		}
		if err != nil && !strings.Contains(err.Error(), "orbit "+strings.Join(tc.args[:2], " ")) {
			t.Errorf("the refusal of orbit %s does not name the command: %v", strings.Join(tc.args, " "), err)
		}
		if err := cliPlanRefusal(tc.args, planModeIs("default")); err != nil {
			t.Errorf("orbit %s outside Plan was refused: %v", strings.Join(tc.args, " "), err)
		}
	}
}

// End to end through the CLI's own router, with the mode read from a real session socket: the write exits with
// the refusal and reaches no control plane; leaving Plan lets it through.
func TestTheInSessionCLIRefusesAWriteInPlan(t *testing.T) {
	f := newGateFixture(t, "plan")
	plane := newPlanGateControlPlane(t)
	home := t.TempDir()
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}
	config, _ := json.Marshal(RunnerConfig{ServerURL: plane.srv.URL, RunnerID: "r", RunnerToken: "tok"})
	if err := os.WriteFile(filepath.Join(home, "config.json"), config, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ORBIT_HOME", home)
	t.Setenv("ORBIT_SESSION_ID", "sess-gate")
	t.Setenv(envBgSocket, f.socket)
	t.Setenv(envBgToken, "tok")
	var out bytes.Buffer
	err := runOrbitCLI([]string{"task", "comment", "task-1", "--body", "noted"}, strings.NewReader(""), &out, &out)
	if err == nil || !strings.Contains(err.Error(), "orbit task comment writes to Orbit") {
		t.Fatalf("orbit task comment in Plan = %v (%s)", err, out.String())
	}
	if seen := plane.seen(); len(seen) != 0 {
		t.Fatalf("a refused write reached the control plane: %v", seen)
	}
	f.setMode("acceptEdits")
	_ = runOrbitCLI([]string{"task", "comment", "task-1", "--body", "noted"}, strings.NewReader(""), &out, &out)
	if len(plane.seen()) == 0 {
		t.Fatal("the write never reached the control plane after leaving Plan")
	}
}
