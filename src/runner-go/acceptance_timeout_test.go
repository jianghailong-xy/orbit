package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// decodeInboxTurn builds a delivery the way the control plane does — as JSON off the wire —
// rather than by naming struct fields. Deliberate: it is what lets this test be written against,
// and fail on, a tree that carries no budget field at all, instead of failing to compile.
func decodeInboxTurn(t *testing.T, payload string) *RunInboxResponse {
	t.Helper()
	var resp RunInboxResponse
	if err := json.Unmarshal([]byte(payload), &resp); err != nil {
		t.Fatal(err)
	}
	return &resp
}

func runAcceptanceShellTurn(t *testing.T, resp *RunInboxResponse) TurnCompleteRequest {
	t.Helper()
	req, err := runSynchronousShellTurn(
		context.Background(), nil, &ClaimedSession{}, t.TempDir(), resp,
		func(string, map[string]interface{}) {},
	)
	if err != nil {
		t.Fatal(err)
	}
	return req
}

func TestAcceptanceTimeoutDeclaredBudgetBoundsTheAcceptanceCommand(t *testing.T) {
	started := time.Now()
	req := runAcceptanceShellTurn(t, decodeInboxTurn(t, `{
		"turnId": "acceptance-declared-budget",
		"kind": "shell",
		"content": "sleep 3; echo finished",
		"taskAcceptance": true,
		"acceptanceTimeoutSeconds": 1
	}`))
	elapsed := time.Since(started)
	if req.ShellExitCode == nil {
		t.Fatal("the acceptance turn reported no exit code at all")
	}
	if *req.ShellExitCode != -1 {
		t.Fatalf("a declared 1s budget did not bound a 3s command: exit %d after %s — "+
			"the hard-coded two-minute ceiling is still the only budget",
			*req.ShellExitCode, elapsed.Round(time.Millisecond))
	}
	if elapsed > 2*time.Second {
		t.Fatalf("the command ran %s, so it was not cut at its declared 1s budget",
			elapsed.Round(time.Millisecond))
	}
	if req.ShellOutput != nil && strings.Contains(*req.ShellOutput, "finished") {
		t.Fatalf("the command ran to completion under the default budget: %q", *req.ShellOutput)
	}
}

// A task that declares a budget LONGER than the default gets it. Proving that with the real two
// minutes would need a command that runs for two minutes, so the default is supplied as an
// argument and compressed: shellTurnBudget is the single policy both this and production use, and
// production passes shellTurnTimeout into exactly this parameter.
func TestAcceptanceTimeoutDeclaredBudgetOutlivesTheDefault(t *testing.T) {
	resp := decodeInboxTurn(t, `{
		"turnId": "acceptance-outlives-default",
		"kind": "shell",
		"content": "sleep 1; echo finished",
		"taskAcceptance": true,
		"acceptanceTimeoutSeconds": 5
	}`)
	compressedDefault := 150 * time.Millisecond
	budget := shellTurnBudget(resp, compressedDefault)
	if budget != 5*time.Second {
		t.Fatalf("declared budget = %s, want 5s", budget)
	}
	output, exitCode := runShellTurn(
		context.Background(), t.TempDir(), resp.Content,
		func(string, map[string]interface{}) {}, resp.TurnID, nil, budget,
	)
	// The command outlives the default and fits the declaration, which under the old single
	// hard-coded ceiling was not a state a command could be in.
	if exitCode != 0 || !strings.Contains(output, "finished") {
		t.Fatalf("a command longer than the default but inside its declared budget did not "+
			"complete: exit %d, output %q", exitCode, output)
	}
}

func TestAcceptanceTimeoutDefaultsToTwoMinutesWhenUndeclared(t *testing.T) {
	if shellTurnTimeout != 2*time.Minute {
		t.Fatalf("the default shell turn budget is %s, want 2m", shellTurnTimeout)
	}
	undeclared := decodeInboxTurn(t, `{
		"turnId": "acceptance-undeclared",
		"kind": "shell",
		"content": "true",
		"taskAcceptance": true
	}`)
	if got := shellTurnBudget(undeclared, shellTurnTimeout); got != 2*time.Minute {
		t.Fatalf("an acceptance turn declaring no budget ran under %s, want the 2m default", got)
	}
	// Absent is 0, and neither a zero nor a negative declaration invents a budget of its own.
	for _, seconds := range []int{0, -1, -900} {
		resp := *undeclared
		resp.AcceptanceTimeoutSeconds = seconds
		if got := shellTurnBudget(&resp, shellTurnTimeout); got != 2*time.Minute {
			t.Fatalf("acceptanceTimeoutSeconds=%d produced %s, want the 2m default", seconds, got)
		}
	}
	if got := shellTurnBudget(nil, shellTurnTimeout); got != 2*time.Minute {
		t.Fatalf("a turn with no delivery at all ran under %s, want the 2m default", got)
	}
	// And an undeclared acceptance command still runs: the default is a budget, not a block.
	req := runAcceptanceShellTurn(t, undeclared)
	if req.ShellExitCode == nil || *req.ShellExitCode != 0 {
		t.Fatalf("undeclared acceptance turn = %v, want exit 0", req.ShellExitCode)
	}
}

// Negative control. `!`-prefixed interactive shells share runSynchronousShellTurn with acceptance
// commands and must NOT have picked up the task's budget along the way: a person waiting at a
// prompt gets the same two minutes they always did, even if a budget is somehow on the delivery.
func TestAcceptanceTimeoutLeavesTheInteractiveShellBudgetAlone(t *testing.T) {
	interactive := decodeInboxTurn(t, `{
		"turnId": "interactive-shell",
		"kind": "shell",
		"content": "sleep 2; echo finished",
		"acceptanceTimeoutSeconds": 1
	}`)
	if interactive.TaskAcceptance {
		t.Fatal("the fixture is an acceptance turn, so it cannot show what interactive shells do")
	}
	if got := shellTurnBudget(interactive, shellTurnTimeout); got != shellTurnTimeout {
		t.Fatalf("an interactive `!`-shell ran under %s, want the unchanged %s", got, shellTurnTimeout)
	}
	// Behaviourally too: a 1s budget on the delivery does not cut a 2s interactive command.
	req := runAcceptanceShellTurn(t, interactive)
	if req.ShellExitCode == nil || *req.ShellExitCode != 0 {
		t.Fatalf("interactive shell exit = %v, want 0 — it was cut at a budget it must not read",
			req.ShellExitCode)
	}
	if req.ShellOutput == nil || !strings.Contains(*req.ShellOutput, "finished") {
		t.Fatalf("interactive shell output = %v, want the completed command", req.ShellOutput)
	}
}

// Negative control. Making the budget configurable changed how long a command may run and nothing
// about what its outcome means. The owner's 0230 decision stands: a killed command reports -1, -1
// is compared literally against the declared expectation, and every non-matching code derives
// FAILED. Nothing typed the termination and nothing recorded why.
func TestAcceptanceTimeoutStillReportsMinusOneAndDerivesFailed(t *testing.T) {
	req := runAcceptanceShellTurn(t, decodeInboxTurn(t, `{
		"turnId": "acceptance-over-budget",
		"kind": "shell",
		"content": "sleep 3",
		"taskAcceptance": true,
		"acceptanceTimeoutSeconds": 1
	}`))
	if req.ShellExitCode == nil || *req.ShellExitCode != -1 {
		t.Fatalf("over-budget acceptance exit = %v, want -1", req.ShellExitCode)
	}
	// stSucceeded is what makes the control plane COMPARE the code. Reporting the turn as failed
	// would make it uncomparable and leave the task pending instead of deriving FAILED.
	if req.Status != stSucceeded || req.Subtype != "shell" {
		t.Fatalf("over-budget acceptance turn = (%q, %q), want a succeeded shell turn",
			req.Status, req.Subtype)
	}
	const declaredExpectation = 0
	if *req.ShellExitCode == declaredExpectation {
		t.Fatal("a killed command must not compare equal to the declared expectation")
	}

	// No typed termination came back with it: the wire still carries an exit code and output and
	// nothing that says which KIND of ending this was.
	encoded, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{
		"termination", "Termination", "timedOut", "TIMED_OUT", "CANCELLED", "SIGNALED",
		"START_FAILED", "INFRASTRUCTURE_LOST", "admission", "attempt",
	} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("turn completion reintroduces typed termination (%q): %s", forbidden, encoded)
		}
	}

	// And the documented consequence the account owner accepted is still the documented one.
	doc, err := os.ReadFile(filepath.Join("..", "..", "docs", "task-completion-criteria.md"))
	if err != nil {
		t.Fatal(err)
	}
	for _, contract := range []string{
		"Two consequences follow and are accepted",
		"not distinguishable",
		"The runner reports `-1` for all of them",
	} {
		if !strings.Contains(string(doc), contract) {
			t.Errorf("the accepted EXECUTABLE consequences no longer say %q", contract)
		}
	}
}

// The budget is now the difference between a suite that fits and one that does not, so a reader
// of the transcript has to be able to tell "killed at the ceiling" from "the tests went red".
// Text only: same exit code, same protocol, nothing stored.
func TestAcceptanceTimeoutIsNamedInTheTranscriptWhenItFires(t *testing.T) {
	killed := runAcceptanceShellTurn(t, decodeInboxTurn(t, `{
		"turnId": "acceptance-diagnostic",
		"kind": "shell",
		"content": "echo running; sleep 3",
		"taskAcceptance": true,
		"acceptanceTimeoutSeconds": 1
	}`))
	if killed.ShellOutput == nil {
		t.Fatal("the killed turn reported no output at all")
	}
	for _, want := range []string{"budget", "1s", "acceptanceTimeoutSeconds"} {
		if !strings.Contains(*killed.ShellOutput, want) {
			t.Fatalf("a killed acceptance command does not say %q, so it reads like a failing "+
				"suite: %q", want, *killed.ShellOutput)
		}
	}
	if !strings.Contains(*killed.ShellOutput, "running") {
		t.Fatalf("the diagnostic replaced the command's own output: %q", *killed.ShellOutput)
	}

	// A command that genuinely failed is NOT annotated: the note has to mean one thing.
	red := runAcceptanceShellTurn(t, decodeInboxTurn(t, `{
		"turnId": "acceptance-red-suite",
		"kind": "shell",
		"content": "echo FAIL; exit 1",
		"taskAcceptance": true,
		"acceptanceTimeoutSeconds": 30
	}`))
	if red.ShellExitCode == nil || *red.ShellExitCode != 1 {
		t.Fatalf("a genuinely failing command reported %v, want its own exit 1", red.ShellExitCode)
	}
	if red.ShellOutput == nil || strings.Contains(*red.ShellOutput, "budget") {
		t.Fatalf("a genuinely failing command was annotated as a timeout: %v", red.ShellOutput)
	}
}

// Where the knob was silently dropped: mcp.go's per-tool field whitelists. A field the schema
// advertises but copyIfPresent does not forward is a knob that accepts 900 without error, reads
// back nothing, and changes nothing — which is what this whole change is about.
func TestAcceptanceTimeoutFieldReachesTheServerThroughEveryTaskWriteTool(t *testing.T) {
	tools := toolDescriptors(false, false)
	create := mcpToolProps(tools, "task_create")
	update := mcpToolProps(tools, "task_update")
	if create["acceptanceTimeoutSeconds"].(map[string]interface{})["type"] != "integer" {
		t.Fatalf("task_create acceptanceTimeoutSeconds schema = %#v", create["acceptanceTimeoutSeconds"])
	}
	if _, ok := update["acceptanceTimeoutSeconds"].(map[string]interface{})["type"].([]string); !ok {
		t.Fatalf("task_update acceptanceTimeoutSeconds is not nullable: %#v",
			update["acceptanceTimeoutSeconds"])
	}
	batchItems := mcpToolProps(tools, "task_create_batch")["tasks"].(map[string]interface{})
	itemProps := batchItems["items"].(map[string]interface{})["properties"].(map[string]interface{})
	if itemProps["acceptanceTimeoutSeconds"] == nil {
		t.Fatal("task_create_batch items do not declare acceptanceTimeoutSeconds")
	}

	var bodies []map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		bodies = append(bodies, body)
		_, _ = w.Write([]byte(`{"id":"task-1"}`))
	}))
	defer srv.Close()
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}

	if result := mcp.callTool("task_create", map[string]interface{}{
		"title":                      "a suite that needs longer than two minutes",
		"completionCriterion":        "EXECUTABLE",
		"acceptanceCommand":          "go test ./...",
		"acceptanceExpectedExitCode": 0,
		"acceptanceTimeoutSeconds":   900,
	}); result["isError"] == true {
		t.Fatalf("task_create failed: %#v", result["content"])
	}
	if result := mcp.callTool("task_create_batch", map[string]interface{}{
		"dryRun": true,
		"tasks": []interface{}{map[string]interface{}{
			"title":                      "batched",
			"completionCriterion":        "EXECUTABLE",
			"acceptanceCommand":          "go test ./...",
			"acceptanceExpectedExitCode": 0,
			"acceptanceTimeoutSeconds":   900,
		}},
	}); result["isError"] == true {
		t.Fatalf("task_create_batch failed: %#v", result["content"])
	}
	if result := mcp.callTool("task_update", map[string]interface{}{
		"taskId":                   "task-1",
		"acceptanceTimeoutSeconds": 900,
	}); result["isError"] == true {
		t.Fatalf("task_update failed: %#v", result["content"])
	}

	if len(bodies) != 3 {
		t.Fatalf("expected create, batch and update bodies, got %d", len(bodies))
	}
	if bodies[0]["acceptanceTimeoutSeconds"] != float64(900) {
		t.Fatalf("task_create dropped acceptanceTimeoutSeconds: %#v", bodies[0])
	}
	batched := bodies[1]["tasks"].([]interface{})[0].(map[string]interface{})
	if batched["acceptanceTimeoutSeconds"] != float64(900) {
		t.Fatalf("task_create_batch dropped acceptanceTimeoutSeconds: %#v", batched)
	}
	if bodies[2]["acceptanceTimeoutSeconds"] != float64(900) {
		t.Fatalf("task_update dropped acceptanceTimeoutSeconds: %#v", bodies[2])
	}
	// Clearing it is a real write, not an omission the server would read as "unchanged".
	if result := mcp.callTool("task_update", map[string]interface{}{
		"taskId":                   "task-1",
		"acceptanceTimeoutSeconds": nil,
	}); result["isError"] == true {
		t.Fatalf("task_update clear failed: %#v", result["content"])
	}
	if value, present := bodies[3]["acceptanceTimeoutSeconds"]; !present || value != nil {
		t.Fatalf("task_update did not clear acceptanceTimeoutSeconds: %#v", bodies[3])
	}
}
