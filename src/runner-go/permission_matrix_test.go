//go:build linux || darwin

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The Claude/Codex permission matrix for Orbit's own calls (docs/orbit-agent-contract.md §4.1): for each engine,
// surface, permission mode and kind of call, what happens to the call. permissionMatrix below is the authority.
// docs/permission-matrix.md is it rendered (ORBIT_UPDATE_PERMISSION_MATRIX_DOC=1 go test -run
// TestPermissionMatrixDocIsGenerated .), and TestPermissionMatrixIsWhatTheCodeDoes derives every cell from the code
// that decides it: Orbit's Plan gate (plan_gate.go), Claude's permission prompt for Orbit's tools, the Codex approval
// bridge (codexAutomaticApproval), the background-job gate (background_gate.go), the hook that answers bg_run in
// Claude's Plan, the CLI allowlist (orbitCLIAllowedTools), the catalogue's cards and annotations — and from a model
// of each engine's own decision, the one part that is not Orbit's code:
//
//   - Claude Code (measured on 2.1.325, TestRealClaudePlanModeHoldsOnlyTheOrbitToolsThatWrite): a call an allow
//     rule covers runs in every mode — the mcp__orbit__* rule every session has (ALWAYS_ALLOWED_TOOLS) and the CLI
//     allowlist alike, Plan included — except that Plan holds back an MCP tool whose annotations do not say
//     readOnlyHint, and asks the permission prompt about it.
//   - Codex (codex-rs 0.167.2, core/src/mcp_tool_call.rs and codex-mcp/src/mcp/mod.rs): no consent at all under the
//     `never` policy with full disk access, which is what Orbit runs Don't Ask and Bypass under; otherwise consent
//     only for a call whose annotations do not say readOnlyHint and say, or default to, destructive or open-world.
//     In Auto a consent goes to Codex's own reviewer first (codexApprovalsReviewer). A shell command is asked about
//     unless the policy is `never`, and Codex is handed no allowlist of Orbit's commands.

const (
	cellRuns       = "runs"        // runs, and nobody is asked
	cellOrbitCard  = "Orbit card"  // Orbit's own card for the write (or the job), which runs once the owner says yes
	cellRefused    = "refused"     // refused by Orbit with what to do instead: the Plan gate, or the background-job gate
	cellDeclined   = "declined"    // the engine's own prompt is answered no, unasked: Plan cannot run what it asks about
	cellEngineCard = "engine card" // the engine's own prompt goes to the owner on a card
	cellAutoReview = "auto review" // the engine's own Auto review judges it first
)

const (
	surfaceClaudeMCP = "Claude · MCP"
	surfaceClaudeCLI = "Claude · CLI"
	surfaceCodexMCP  = "Codex · MCP"
	surfaceCodexCLI  = "Codex · CLI"
)

var matrixModes = []string{"plan", "default", "acceptEdits", "dontAsk", "auto", "bypassPermissions"}

var matrixModeTitles = map[string]string{
	"plan": "Plan", "default": "Default", "acceptEdits": "Accept Edits", "dontAsk": "Don't Ask", "auto": "Auto",
	"bypassPermissions": "Bypass",
}

// matrixCall is one kind of call, by an operation of the catalogue that is an example of it.
type matrixCall struct {
	Class string
	Tool  string
	Args  map[string]interface{}
	// The command line after `orbit`, flags included; nil where the operation has no CLI command.
	Argv []string
	// A third-party MCP server's name; empty for Orbit's own.
	Server string
}

var (
	matrixRead       = matrixCall{Class: "read", Tool: "task_get", Args: map[string]interface{}{"taskId": "T1"}, Argv: []string{"task", "get", "T1"}}
	matrixWait       = matrixCall{Class: "wait on Orbit's own work", Tool: "task_await", Args: map[string]interface{}{"taskIds": []interface{}{"T1"}}, Argv: []string{"task", "await", "--task-id", "T1"}}
	matrixQuestion   = matrixCall{Class: "a line or a question for the owner", Tool: "notify", Args: map[string]interface{}{"message": "plan ready"}, Argv: []string{"notify", "--message", "plan ready"}}
	matrixPreview    = matrixCall{Class: "preview (writes nothing)", Tool: "task_create_batch", Args: map[string]interface{}{"dryRun": true, "tasks": []interface{}{map[string]interface{}{"title": "a", "description": "d", "completionCriterion": "EVIDENCE_JUDGMENT", "acceptanceCriteria": "x"}}}, Argv: []string{"task", "create-batch", "--tasks-file", "-", "--dry-run"}}
	matrixWrite      = matrixCall{Class: "write: a schedule (`runAt`)", Tool: "task_update", Args: map[string]interface{}{"taskId": "T1", "runAt": "2026-11-15T09:00:00Z"}, Argv: []string{"task", "update", "T1", "--run-at", "2026-11-15T09:00:00Z"}}
	matrixDependency = matrixCall{Class: "write: a dependency edge", Tool: "task_dependency_remove", Args: map[string]interface{}{"taskId": "T1", "dependsOnTaskId": "T0"}, Argv: []string{"task", "dependency-remove", "T1", "T0"}}
	matrixDestroy    = matrixCall{Class: "destructive write", Tool: "task_delete", Args: map[string]interface{}{"taskId": "T1"}, Argv: []string{"task", "delete", "T1"}}
	matrixCarded     = matrixCall{Class: "write that files its own card", Tool: "task_create", Args: map[string]interface{}{"title": "x", "completionCriterion": "EVIDENCE_JUDGMENT", "acceptanceCriteria": "x"}, Argv: []string{"task", "create", "--title", "x"}}
	matrixJob        = matrixCall{Class: "background job", Tool: "bg_run", Args: map[string]interface{}{"command": "true", "kind": "job"}}
	matrixThirdParty = matrixCall{Class: "a third-party server's tool", Tool: "deploy", Server: "acme"}
)

// matrixRow is one kind of call on one surface, and what each mode does with it, in matrixModes order.
type matrixRow struct {
	Call  matrixCall
	Cells [6]string
}

var (
	runsEverywhere     = [6]string{cellRuns, cellRuns, cellRuns, cellRuns, cellRuns, cellRuns}
	refusedOnlyInPlan  = [6]string{cellRefused, cellRuns, cellRuns, cellRuns, cellRuns, cellRuns}
	ownCardOutsidePlan = [6]string{cellRefused, cellOrbitCard, cellOrbitCard, cellOrbitCard, cellOrbitCard, cellOrbitCard}
	backgroundGate     = [6]string{cellRefused, cellOrbitCard, cellOrbitCard, cellRefused, cellRuns, cellRuns}
)

// permissionMatrix is the authority: what each engine, surface and mode does with each kind of Orbit call.
var permissionMatrix = []struct {
	Surface string
	Note    string
	Rows    []matrixRow
}{
	{surfaceClaudeMCP, "Orbit's MCP tools under Claude Code's `mcp__orbit__*` allow rule (ALWAYS_ALLOWED_TOOLS). In Plan, Claude Code holds back a tool not annotated read-only and asks the permission prompt, which Orbit answers itself, with no card: yes to a call Plan runs, and its Plan refusal to a write.", []matrixRow{
		{matrixRead, runsEverywhere},
		{matrixWait, runsEverywhere},
		{matrixQuestion, runsEverywhere},
		{matrixPreview, runsEverywhere},
		{matrixWrite, refusedOnlyInPlan},
		{matrixDependency, refusedOnlyInPlan},
		{matrixDestroy, refusedOnlyInPlan},
		{matrixCarded, ownCardOutsidePlan},
		{matrixJob, backgroundGate},
	}},
	{surfaceClaudeCLI, "The in-session `orbit` CLI through Claude Code's shell, where every command `capabilities --json` offers the session is pre-approved (orbitCLIAllowedTools, generated from the catalogue). Claude Code runs an allowlisted command in every mode, Plan included, so the CLI's own Plan gate refuses a write there, with the MCP tool's words.", []matrixRow{
		{matrixRead, runsEverywhere},
		{matrixWait, runsEverywhere},
		{matrixQuestion, runsEverywhere},
		{matrixPreview, runsEverywhere},
		{matrixWrite, refusedOnlyInPlan},
		{matrixDependency, refusedOnlyInPlan},
		{matrixDestroy, refusedOnlyInPlan},
		{matrixCarded, ownCardOutsidePlan},
	}},
	{surfaceCodexMCP, "Orbit's MCP tools under Codex, whose consent the runner answers (codexAutomaticApproval): an Orbit tool recognized by its catalogue name is consented to in every mode, so what happens is Orbit's own gates'. Codex asks at all only about a tool whose annotations do not say read-only and do say destructive or open-world.", []matrixRow{
		{matrixRead, runsEverywhere},
		{matrixWait, runsEverywhere},
		{matrixQuestion, runsEverywhere},
		{matrixPreview, runsEverywhere},
		{matrixWrite, refusedOnlyInPlan},
		{matrixDependency, refusedOnlyInPlan},
		{matrixDestroy, [6]string{cellRefused, cellRuns, cellRuns, cellRuns, cellAutoReview, cellRuns}},
		{matrixCarded, ownCardOutsidePlan},
		{matrixJob, [6]string{cellRefused, cellOrbitCard, cellOrbitCard, cellRefused, cellAutoReview, cellRuns}},
		{matrixThirdParty, [6]string{cellDeclined, cellEngineCard, cellEngineCard, cellRuns, cellAutoReview, cellRuns}},
	}},
	{surfaceCodexCLI, "The in-session `orbit` CLI through Codex's shell. Codex is handed no allowlist, so an `orbit` command is a shell command like any other there; Orbit's MCP tools are Codex's way in.", []matrixRow{
		{matrixRead, [6]string{cellDeclined, cellEngineCard, cellEngineCard, cellRuns, cellAutoReview, cellRuns}},
		{matrixWrite, [6]string{cellDeclined, cellEngineCard, cellEngineCard, cellRuns, cellAutoReview, cellRuns}},
		{matrixCarded, [6]string{cellDeclined, cellEngineCard, cellEngineCard, cellOrbitCard, cellAutoReview, cellOrbitCard}},
	}},
}

// matrixExecutable is the absolute path the allowlist names, as a runner advertises it.
const matrixExecutable = "/usr/local/bin/orbit"

// TestPermissionMatrixIsWhatTheCodeDoes derives every cell of the matrix and holds it to the table.
func TestPermissionMatrixIsWhatTheCodeDoes(t *testing.T) {
	for _, surface := range permissionMatrix {
		for _, row := range surface.Rows {
			for i, mode := range matrixModes {
				if got := matrixCell(t, surface.Surface, mode, row.Call); got != row.Cells[i] {
					t.Errorf("%s, %s, %s (%s): %s, the matrix says %s", surface.Surface, row.Call.Class, matrixModeTitles[mode],
						row.Call.Tool, got, row.Cells[i])
				}
			}
		}
	}
}

// The promise the matrix exists to keep, checked across it rather than cell by cell: outside Plan, no engine puts a
// card in front of the owner for an Orbit call unless that call is a write that files its own; in Plan a write is
// never made; and an Orbit read is never refused or asked about, in any mode, on either engine's MCP surface.
func TestPermissionMatrixKeepsItsPromises(t *testing.T) {
	for _, surface := range permissionMatrix {
		for _, row := range surface.Rows {
			op := catalogOperation(row.Call.Tool)
			for i, mode := range matrixModes {
				cell := row.Cells[i]
				if op == nil || surface.Surface == surfaceCodexCLI {
					continue // a third-party tool, or Codex's own shell policy
				}
				if mode == "plan" && op.Plan == planRefused && !strings.Contains(row.Call.Class, "preview") && cell != cellRefused {
					t.Errorf("%s: %s in Plan is %s, want it refused", surface.Surface, row.Call.Class, cell)
				}
				if op.Plan == planRuns && cell != cellRuns {
					t.Errorf("%s: %s in %s is %s; a call Plan runs must run in every mode", surface.Surface, row.Call.Class, mode, cell)
				}
				if cell == cellEngineCard {
					t.Errorf("%s: %s in %s asks the owner through the engine", surface.Surface, row.Call.Class, mode)
				}
			}
		}
	}
}

func matrixCell(t *testing.T, surface, mode string, call matrixCall) string {
	t.Helper()
	switch surface {
	case surfaceClaudeMCP:
		if call.Tool == "bg_run" {
			// Claude's PreToolUse hook answers bg_run in Plan before Claude Code's own check (hook_bg_guard.go).
			decision := bgGuardDecision(hookInput{HookEventName: "PreToolUse", ToolName: claudeToolName("bg_run"), ToolInput: call.Args, PermissionMode: mode})
			if out, _ := decision["hookSpecificOutput"].(map[string]interface{}); out["permissionDecision"] == "deny" {
				return cellRefused
			}
		}
		if mode == "plan" && matrixAnnotations(t, call)["readOnlyHint"] != true {
			if answer := claudePromptAnswer(t, mode, call); answer["behavior"] != "allow" {
				if strings.Contains(fmt.Sprint(answer["message"]), "this session is in Plan mode") {
					return cellRefused
				}
				return cellDeclined
			}
		}
		return orbitCallCell(t, mode, call, false, providerClaude)
	case surfaceClaudeCLI:
		op := catalogOperation(call.Tool)
		rule := "Bash(" + matrixExecutable + " " + strings.Join(op.CLI.Argv[1:], " ") + " *)"
		if !stringSet(orbitCLIAllowedTools(matrixExecutable, true))[rule] {
			return cellEngineCard
		}
		return orbitCallCell(t, mode, call, true, providerClaude)
	case surfaceCodexMCP:
		server := call.Server
		if server == "" {
			server = codexOrbitMCPServer
		}
		var annotations map[string]interface{}
		if call.Server == "" {
			annotations = matrixAnnotations(t, call)
		}
		if codexAsksMCPConsent(mode, annotations) {
			if mode == "auto" {
				return cellAutoReview
			}
			allowed, decided := codexAutomaticApproval(mode, codexApprovalRequest{mcpTool: true, server: server, tool: call.Tool})
			switch {
			case !decided:
				return cellEngineCard
			case !allowed:
				return cellDeclined
			}
		}
		if call.Server != "" {
			return cellRuns
		}
		return orbitCallCell(t, mode, call, false, providerCodex)
	case surfaceCodexCLI:
		if codexApprovalPolicy(mode) != "never" {
			if mode == "auto" {
				return cellAutoReview
			}
			allowed, decided := codexAutomaticApproval(mode, codexApprovalRequest{})
			switch {
			case !decided:
				return cellEngineCard
			case !allowed:
				return cellDeclined
			}
		}
		return orbitCallCell(t, mode, call, true, providerCodex)
	}
	t.Fatalf("no surface %q", surface)
	return ""
}

// orbitCallCell is what happens once the engine lets a call through to Orbit: the Plan gate, then the background-job
// gate for a job, then the operation's own card — which a preview never files, since it writes nothing
// (waitsForTheOwner).
func orbitCallCell(t *testing.T, mode string, call matrixCall, cli bool, engine string) string {
	t.Helper()
	preview := false
	if cli {
		if err := cliPlanRefusal(call.Argv, planModeIs(mode)); err != nil {
			return cellRefused
		}
		preview = cliPlanPreview(call.Tool, call.Argv)
	} else {
		// Through `orbit mcp` itself — tools/call's own path, strict input and receipt included — so the cell is what
		// the server answers and not what the gate function says in isolation. Its transport reaches nothing: a call
		// the gate lets through fails on the network, fast, and only Plan's refusal reads as one.
		s := &mcpServer{t: NewTransport("http://127.0.0.1:1", "tok"), sessionID: "matrix", taskID: "T1", permissionMode: planModeIs(mode)}
		args := map[string]interface{}{}
		for key, value := range call.Args {
			args[key] = value
		}
		if matrixRefusedInPlan(s.invokeTool(call.Tool, args)) {
			return cellRefused
		}
		preview = !waitsForTheOwner(call.Tool, call.Args) && catalogPlanPreviewArgs[call.Tool] != ""
	}
	if preview {
		return cellRuns
	}
	if call.Tool == "bg_run" {
		verdict := (&bgJobService{engine: engine, mode: func() string { return mode }}).admit(bgJobSpec{Command: "true", Kind: bgKindJob})
		switch {
		case verdict.refusal != "":
			return cellRefused
		case verdict.ask:
			return cellOrbitCard
		}
		return cellRuns
	}
	if catalogOperation(call.Tool).Approval == approvalKindCard {
		return cellOrbitCard
	}
	return cellRuns
}

// matrixRefusedInPlan reads an MCP answer as Plan's refusal: the receipt's SESSION_IN_PLAN_MODE for a tool that
// answers with one, and the refusal's words for one that keeps an answer of its own (the wiki tools').
func matrixRefusedInPlan(res map[string]interface{}) bool {
	if receipt, ok := res["structuredContent"].(toolReceipt); ok {
		return !receipt.OK && receipt.Error != nil && receipt.Error.Code == errorCodeSessionInPlanMode
	}
	return res["isError"] == true && strings.HasPrefix(resultText(res), planGateRefusalLead)
}

// The examples are real calls: each one's arguments pass the strict input its tool is judged by (tool_schema.go), so
// a cell is never a refusal of the arguments read as one of the mode.
func TestPermissionMatrixExamplesAreValidCalls(t *testing.T) {
	for _, call := range []matrixCall{matrixRead, matrixWait, matrixQuestion, matrixPreview, matrixWrite, matrixDependency, matrixDestroy, matrixCarded, matrixJob} {
		if violations := validateToolArguments(catalogOperation(call.Tool), call.Args); len(violations) > 0 {
			t.Errorf("%s's example arguments are not a valid call: %v", call.Tool, violations)
		}
	}
}

// claudePromptAnswer is what Orbit's permission prompt answers Claude Code about one of Orbit's tools. Its transport
// reaches nothing, so an answer that needed a card would come back as a refusal to file one, and read as declined.
func claudePromptAnswer(t *testing.T, mode string, call matrixCall) map[string]interface{} {
	t.Helper()
	s := &mcpServer{t: NewTransport("http://127.0.0.1:1", "tok"), sessionID: "matrix", allowPermissionPrompt: true,
		permissionMode: planModeIs(mode)}
	res := s.callTool("permission_prompt", map[string]interface{}{"tool_name": claudeToolName(call.Tool), "input": call.Args, "tool_use_id": "toolu_matrix"})
	var answer map[string]interface{}
	if err := json.Unmarshal([]byte(resultText(res)), &answer); err != nil {
		t.Fatalf("permission_prompt for %s answered %q: %v", call.Tool, resultText(res), err)
	}
	return answer
}

// matrixAnnotations are the annotations tools/list declares for the call's tool.
func matrixAnnotations(t *testing.T, call matrixCall) map[string]interface{} {
	t.Helper()
	for _, descriptor := range toolDescriptors(true, true) {
		if descriptor["name"] == call.Tool {
			annotations, _ := descriptor["annotations"].(map[string]interface{})
			return annotations
		}
	}
	t.Fatalf("%s is not in tools/list", call.Tool)
	return nil
}

// codexAsksMCPConsent is whether Codex 0.167.2 asks for consent before an MCP tool call in a session Orbit started in
// this mode: never under the `never` policy with full disk access (mcp_permission_prompt_is_auto_approved), which
// is what Orbit runs Don't Ask and Bypass under (codexApprovalPolicy, codexSandboxPolicy); otherwise as the server's
// default `auto` tools approval mode decides it (requires_mcp_tool_approval).
func codexAsksMCPConsent(mode string, annotations map[string]interface{}) bool {
	if codexApprovalPolicy(mode) == "never" && codexSandboxMode(mode) == "danger-full-access" {
		return false
	}
	if annotations["destructiveHint"] == true {
		return true
	}
	if annotations["readOnlyHint"] == true {
		return false
	}
	destructive, said := annotations["destructiveHint"].(bool)
	if !said {
		destructive = true
	}
	openWorld, said := annotations["openWorldHint"].(bool)
	if !said {
		openWorld = true
	}
	return destructive || openWorld
}

// renderPermissionMatrixMarkdown is docs/permission-matrix.md: the matrix, rendered from the table the code is held to.
func renderPermissionMatrixMarkdown() string {
	var b strings.Builder
	b.WriteString("# Claude/Codex permission matrix for Orbit's own calls\n\n")
	b.WriteString("> Generated from `src/runner-go/permission_matrix_test.go` — do not edit by hand. The test that renders it ")
	b.WriteString("derives every cell from the code that decides it, so this is what the runner does, not what it is meant to do.\n\n")
	b.WriteString("What happens to each kind of Orbit call, per engine, surface and permission mode ")
	b.WriteString("(docs/orbit-agent-contract.md §4.1). The product rule it keeps: **Orbit's own tools never ask through the engine** ")
	b.WriteString("(`ALWAYS_ALLOWED_TOOLS`); a write that needs the owner files Orbit's own card, in every mode; and **Plan reads, waits ")
	b.WriteString("and asks the owner, and refuses every other write**, on every engine and on both surfaces, by the session's live ")
	b.WriteString("mode — so a switch into or out of Plan, by the owner or by Claude Code itself, counts from the next call. What ")
	b.WriteString("each operation does in Plan is the operation catalogue's `Plan` column (docs/operation-catalog.md).\n\n")
	b.WriteString("| Cell | Meaning |\n| --- | --- |\n")
	for _, cell := range [][2]string{
		{cellRuns, "runs, and nobody is asked"},
		{cellOrbitCard, "Orbit's own card for the write (or, for a background job, the background-job gate's); it runs once the owner says yes"},
		{cellRefused, "refused by Orbit with what to do instead: Plan's write refusal — a receipt with `ok: false`, `outcome: refused` and `SESSION_IN_PLAN_MODE` (`retry: wait`) — or the background-job gate's refusal"},
		{cellDeclined, "the engine's own prompt is answered no without asking anybody: Plan cannot run what it asks about"},
		{cellEngineCard, "the engine's own prompt goes to the owner on a card"},
		{cellAutoReview, "the engine's own Auto review judges it first (Codex's reviewer)"},
	} {
		fmt.Fprintf(&b, "| %s | %s |\n", cell[0], cell[1])
	}
	for _, surface := range permissionMatrix {
		fmt.Fprintf(&b, "\n## %s\n\n%s\n\n", surface.Surface, surface.Note)
		b.WriteString("| Call | Example |")
		for _, mode := range matrixModes {
			b.WriteString(" " + matrixModeTitles[mode] + " |")
		}
		b.WriteString("\n| --- | --- |" + strings.Repeat(" --- |", len(matrixModes)) + "\n")
		for _, row := range surface.Rows {
			example := "`" + row.Call.Tool + "`"
			switch {
			case row.Call.Server != "":
				example = "`" + row.Call.Server + "." + row.Call.Tool + "`"
			case strings.HasSuffix(surface.Surface, "CLI"):
				example = "`orbit " + strings.Join(row.Call.Argv, " ") + "`"
			case row.Call.Tool == "task_create_batch":
				example = "`task_create_batch` with `dryRun`"
			case row.Call.Tool == "task_update":
				example = "`task_update` with `runAt`"
			}
			fmt.Fprintf(&b, "| %s | %s |", row.Call.Class, example)
			for _, cell := range row.Cells {
				b.WriteString(" " + cell + " |")
			}
			b.WriteString("\n")
		}
	}
	b.WriteString("\n## Notes\n\n")
	for _, note := range []string{
		"**How the engines are modelled.** Everything in a cell is Orbit's code except the engine's own first decision. " +
			"Claude Code's is as measured on 2.1.325: a call an allow rule covers runs in every mode, Plan included, except that " +
			"Plan holds back an MCP tool whose annotations do not say `readOnlyHint` and asks the permission prompt " +
			"(`TestRealClaudePlanModeHoldsOnlyTheOrbitToolsThatWrite` runs the installed CLI against it). Codex's is codex-rs " +
			"0.167.2's: no consent under the `never` policy with full disk access (Don't Ask, Bypass), otherwise consent only " +
			"for a tool whose annotations do not say read-only and do say, or default to, destructive or open-world, and in Auto " +
			"its own reviewer first. The catalogue declares `readOnlyHint`, `destructiveHint` and `openWorldHint` for every " +
			"Orbit tool (`withCatalogAnnotations`), which is what keeps both engines from asking about Orbit's reads.",
		"**A schedule and a dependency edge need no card, in any mode but Plan.** `task_update` with `runAt` " +
			"(`PATCH /runner/tasks/:id`) and `task_dependency_add` / `task_dependency_remove` " +
			"(`POST`/`DELETE /runner/tasks/:id/dependencies`) can start recorded work later, but no sooner than `task_start` " +
			"does now, and `task_start` needs no card once the work is recorded (contract R1.4): the owner answered for the " +
			"work when it was filed. A card here would ask the owner the same question again for every reschedule. In Plan " +
			"they are writes and are refused, with the rest.",
		"**Don't Ask asks nobody but Orbit's own cards.** A write that files its card still asks (a question is not a " +
			"job), and a background job is refused. On Codex, Don't Ask runs every command unasked: Codex takes no allowlist.",
		"**Where the gate reads the mode, and when it cannot.** The runner hosting the session answers it over the " +
			"session's socket (`bgJobService`, op `mode`). The gate fails closed: a write is refused, with the reason and " +
			"the receipt code `PERMISSION_MODE_UNREADABLE` (`retry: resend`), when the socket does not answer and when a " +
			"session process the runner started (`ORBIT_RUNNER_CHILD`) has no socket at all, because that mode may be " +
			"Plan. There is no gate where there is no session process: a person's own " +
			"terminal, and a runner-hosted background job, whose environment carries the session but never the socket, so a " +
			"job started before Plan can still write (the hosted wait for the owner is gated at its own door). Like the " +
			"background-job gate, this protects against an agent acting ahead of the owner, not against a hostile process on " +
			"the machine.",
	} {
		b.WriteString("- " + note + "\n")
	}
	return b.String()
}

func TestPermissionMatrixDocIsGenerated(t *testing.T) {
	path := filepath.Join("..", "..", "docs", "permission-matrix.md")
	want := renderPermissionMatrixMarkdown()
	if os.Getenv("ORBIT_UPDATE_PERMISSION_MATRIX_DOC") == "1" {
		if err := os.WriteFile(path, []byte(want), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (regenerate with ORBIT_UPDATE_PERMISSION_MATRIX_DOC=1 go test -run TestPermissionMatrixDocIsGenerated .)", err)
	}
	if string(got) != want {
		t.Fatal("docs/permission-matrix.md is not the matrix rendered (regenerate with ORBIT_UPDATE_PERMISSION_MATRIX_DOC=1 go test -run TestPermissionMatrixDocIsGenerated .)")
	}
}
