package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dop251/goja"
)

// Workflow (docs/subagent-workflow-design.md, P1): a parent session's `workflow` call hands the runner a JavaScript
// script, which runs here, in the parent's process tree, and whose every agent() is one SubAgent run on the delegate
// path (subagent.go): the same routing, fallback, approvals, cost and limit. The workflow is always in the
// background: the call answers { workflowRunId, status: "running" } at once, and the workflow's end, reported to
// the server (PATCH …/workflows/:id), is what wakes the parent, once. Its calls owe no wake of their own.
//
// The script's API is Claude Code Workflow's: agent, parallel, pipeline, phase, log, args, and budget in dollars.
// Not in P1: schema (P2), resumeFrom (P2), isolation (P3), nested workflow(). Date.now(), Math.random() and an
// argument-less Date throw, as they will break replay once the journal (P2) replays a script.

const (
	workflowToolName       = "workflow"
	workflowEngineToolName = "mcp__orbit__workflow"

	// workflowScriptCap is the largest script a call may hand over (§5.1).
	workflowScriptCap = 512 * 1024
	// workflowCallCap stops a runaway loop (§4.4): the most agent() calls one workflow makes.
	workflowCallCap = 1000
	// workflowItemsCap is the most items one parallel() or pipeline() takes.
	workflowItemsCap = 4096
)

// workflowLimitRetry is how long a call the session's SubAgent limit turned away waits before asking again.
var workflowLimitRetry = 2 * time.Second

// envWorkflows carries the Agent's Workflows switch into a session (docs/subagent-workflow-design.md §9 D2): the claim
// says `workflowsDisabled` when the session's Agent has Workflows or SubAgents off, the runner injects it as
// ORBIT_WORKFLOWS=off, and `orbit mcp` then leaves the workflow tool out of its list and refuses a call of it. delegate
// does not read it. A spawn reads it once, so an engine started before the switch moved keeps what it was started with.
const envWorkflows = "ORBIT_WORKFLOWS"

// workflowsEnv renders the ORBIT_WORKFLOWS value the runner injects at spawn.
func workflowsEnv(disabled bool) string {
	if disabled {
		return "off"
	}
	return "on"
}

// workflowsEnabledFromEnv reads ORBIT_WORKFLOWS. Only an explicit off turns the tool off: a runner that predates the
// switch injects nothing, and its sessions keep the tool, as they always had it.
func workflowsEnabledFromEnv() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(envWorkflows))) {
	case "off", "0", "false", "no":
		return false
	default:
		return true
	}
}

// workflowsOffMessage is what a workflow call answers in a session spawned with Workflows off.
const workflowsOffMessage = "workflow: Workflows are turned off for this agent (ORBIT_WORKFLOWS=off), so this session " +
	"cannot start one. Hand each piece of work to delegate, or do it in this session."

// isWorkflowToolName reports whether an engine's name for a tool is Orbit's workflow, as isDelegateToolName does.
func isWorkflowToolName(name string) bool {
	n := strings.ToLower(strings.TrimSpace(name))
	return n == workflowToolName || n == workflowEngineToolName || n == "orbit__workflow" || n == "orbit_workflow" ||
		strings.HasSuffix(n, "orbit__workflow") || strings.HasSuffix(n, "orbit.workflow") || strings.HasSuffix(n, "orbit/workflow")
}

// ── The MCP half ─────────────────────────────────────────────────────────────────────────────────────────

func workflowToolDescriptor(obj func(map[string]interface{}, ...string) map[string]interface{}) map[string]interface{} {
	str := func(desc string) map[string]interface{} {
		return map[string]interface{}{"type": "string", "description": desc}
	}
	return map[string]interface{}{
		"name": workflowToolName,
		"description": "Run a JavaScript script that orchestrates many SubAgents deterministically, in the background." +
			" Use it to fan out several SubAgents, in parallel or in phases, whose results you only need combined; delegate" +
			" stays the tool for one independent piece. It is Orbit's own tool and needs no user opt-in, unlike Claude Code's" +
			" built-in Workflow tool." +
			" It returns { workflowRunId, status: \"running\" } at once; Orbit starts one turn in this session with the" +
			" script's return value when the whole workflow ends: end your turn then instead of polling. The script must" +
			" begin with `export const meta = { name, description, phases? }` (a pure literal). Its body may use await and:" +
			" agent(prompt, { label, phase, type, size, model, workspace, needs }) starts one SubAgent (as delegate does)" +
			" and resolves to its result text, or null if it failed; parallel(thunks) runs thunks at once and waits for" +
			" all (a failed one is null); pipeline(items, stage1, stage2, …) runs each item through every stage with no" +
			" barrier between stages (stage callbacks get (previous, item, index)); phase(title) groups later calls;" +
			" log(message) writes a line under this call; args is the args you pass; budget.spentUsd()," +
			" budget.remainingUsd() and budget.maxCostUsd read the spend. Calls share this session's SubAgent limit and" +
			" wait for a free place. SubAgents share your working tree: give parallel ones disjoint files." +
			" Date.now(), Math.random() and new Date() without arguments throw; there is no file or network access." +
			" Use a workflow for a fan-out you only need results from; use tasks for work that needs its own record.",
		"inputSchema": obj(map[string]interface{}{
			"description": str("3 to 8 words saying what the workflow does; shown on its block."),
			"script":      str("The script itself. Give script or scriptPath."),
			"scriptPath":  str("A script file in this working directory, e.g. .orbit/workflows/review.js. Give script or scriptPath."),
			"args":        map[string]interface{}{"description": "Any JSON value, available to the script as the global args."},
			"maxCostUsd": map[string]interface{}{
				"type":        "number",
				"description": "Optional spending limit in US dollars. Once reached, no new agent() starts (it throws WorkflowBudgetSpent); calls already running finish. No limit when left out.",
			},
		}, "description"),
	}
}

// callWorkflow forwards one workflow call to the runner, which answers once the workflow has started.
func (s *mcpServer) callWorkflow(args map[string]interface{}, toolUseID string) map[string]interface{} {
	if os.Getenv(envSubagentRunID) != "" {
		return toolResult("workflow: a SubAgent cannot start a workflow. Do the work yourself.", true)
	}
	// Not listed in such a session; a model that calls it anyway (a name from before a restart) is told why.
	if s.workflowsOff {
		return toolResult(workflowsOffMessage, true)
	}
	socket, token := os.Getenv(envBgSocket), os.Getenv(envBgToken)
	if socket == "" || token == "" {
		return toolResult(bgTransportUnavailable+": this session has no runner-hosted job service, so workflow is unavailable. Do the work yourself.", true)
	}
	script, err := workflowScriptOf(args)
	if err != nil {
		return toolResult("workflow: "+err.Error(), true)
	}
	forward := map[string]interface{}{"toolUseId": toolUseID, "script": script, "description": getString(args, "description")}
	for _, key := range []string{"args", "maxCostUsd"} {
		if v, ok := args[key]; ok {
			forward[key] = v
		}
	}
	raw, err := bgSocketCall(socket, token, "workflow_start", forward)
	if err != nil {
		return toolResult("workflow failed: "+err.Error(), true)
	}
	var started workflowReport
	if err := json.Unmarshal(raw, &started); err != nil {
		return toolResult("workflow failed: "+err.Error(), true)
	}
	// The control plane reads this receipt as a launch, not an end (runner-api.controller workflow receipt).
	return toolResult(prettyJSON(subagentJSON(map[string]interface{}{"workflowRunId": started.WorkflowRunID, "status": "running"})), false)
}

// workflowScriptOf is the call's script: inline, or read from scriptPath under the working directory.
func workflowScriptOf(args map[string]interface{}) (string, error) {
	script, path := getString(args, "script"), strings.TrimSpace(getString(args, "scriptPath"))
	switch {
	case script != "" && path != "":
		return "", errors.New("give script or scriptPath, not both")
	case path != "":
		cwd, _ := os.Getwd()
		full := path
		if !filepath.IsAbs(full) {
			full = filepath.Join(cwd, full)
		}
		info, err := os.Stat(full)
		if err != nil {
			return "", fmt.Errorf("cannot read scriptPath %s: %v", path, err)
		}
		if info.Size() > workflowScriptCap {
			return "", fmt.Errorf("the script is %d bytes, more than the %d a workflow takes", info.Size(), workflowScriptCap)
		}
		b, err := os.ReadFile(full)
		if err != nil {
			return "", fmt.Errorf("cannot read scriptPath %s: %v", path, err)
		}
		script = string(b)
	case strings.TrimSpace(script) == "":
		return "", errors.New("script or scriptPath is required")
	}
	if len(script) > workflowScriptCap {
		return "", fmt.Errorf("the script is %d bytes, more than the %d a workflow takes", len(script), workflowScriptCap)
	}
	return script, nil
}

// ── The runner half ──────────────────────────────────────────────────────────────────────────────────────

// workflowReport is a workflow as the socket answers it.
type workflowReport struct {
	WorkflowRunID string `json:"workflowRunId"`
	Status        string `json:"status"`
}

// workflowRun is one workflow the runner hosts for a session.
type workflowRun struct {
	id, toolUseID string
	cancel        context.CancelFunc
	done          chan struct{}

	// Written under workflowRegistry.mu.
	status     string
	stopReason string
}

type workflowRegistry struct {
	mu   sync.Mutex
	runs map[string]*workflowRun
}

func (g *workflowRegistry) add(r *workflowRun) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.runs == nil {
		g.runs = map[string]*workflowRun{}
	}
	g.runs[r.id] = r
}

// workflowCreateResponse is the server's answer to POST /runner/sessions/:id/workflows.
type workflowCreateResponse struct {
	WorkflowRunID string `json:"workflowRunId"`
	Status        string `json:"status"`
}

func (s *bgJobService) handleWorkflow(op string, args map[string]interface{}) bgSocketResponse {
	if op != "workflow_start" {
		return bgSocketResponse{Error: "unknown workflow operation: " + op}
	}
	report, err := s.startWorkflow(args)
	if err != nil {
		return bgSocketResponse{Error: err.Error()}
	}
	return bgSocketResponse{OK: true, Result: report}
}

// startWorkflow reads the script's meta, opens the workflow on the server and starts running it.
func (s *bgJobService) startWorkflow(args map[string]interface{}) (workflowReport, error) {
	if s.job == nil || s.t == nil || s.bg == nil {
		return workflowReport{}, errors.New("this session's runner cannot host a workflow")
	}
	script := getString(args, "script")
	meta, err := parseWorkflowMeta(script)
	if err != nil {
		return workflowReport{}, err
	}
	maxCost := 0.0
	if v, ok := args["maxCostUsd"]; ok && v != nil {
		f, ok := v.(float64)
		if !ok || f <= 0 {
			return workflowReport{}, errors.New("maxCostUsd must be a positive number of US dollars, or left out for no limit")
		}
		maxCost = f
	}
	description := strings.TrimSpace(getString(args, "description"))
	toolUseID := getString(args, "toolUseId")
	if strings.TrimSpace(toolUseID) == "" {
		toolUseID = delegateCalls.take(s.sessionID, workflowToolName, "", description, delegateCallWait)
	} else {
		delegateCalls.claim(s.sessionID, toolUseID)
	}
	if strings.TrimSpace(toolUseID) == "" {
		id, err := newBgJobID()
		if err != nil {
			return workflowReport{}, err
		}
		toolUseID = "workflow_" + strings.TrimPrefix(id, "bgj_")
	}
	body := map[string]interface{}{
		"toolUseId": toolUseID, "name": meta.Name, "script": script, "phases": meta.Phases,
		"description": firstNonEmpty(description, meta.Description),
	}
	if v, ok := args["args"]; ok {
		body["args"] = v
	}
	if maxCost > 0 {
		body["maxCostUsd"] = maxCost
	}
	var created workflowCreateResponse
	if err := s.t.do(nil, "POST", "/runner/sessions/"+s.sessionID+"/workflows", body, &created, 30*time.Second); err != nil {
		return workflowReport{}, err
	}
	if created.WorkflowRunID == "" {
		return workflowReport{}, errors.New("the server opened no workflow run")
	}
	s.workflows.mu.Lock()
	if existing := s.workflows.runs[created.WorkflowRunID]; existing != nil {
		// A retried call: the workflow it opened is already running here.
		s.workflows.mu.Unlock()
		return workflowReport{WorkflowRunID: existing.id, Status: subagentStatusRunning}, nil
	}
	s.workflows.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	run := &workflowRun{id: created.WorkflowRunID, toolUseID: toolUseID, cancel: cancel, done: make(chan struct{}), status: subagentStatusRunning}
	s.workflows.add(run)
	// The session does not park while a workflow runs, between its calls as much as during them.
	s.bg.subagentsLive.Add(1)
	var scriptArgs interface{}
	if v, ok := args["args"]; ok {
		scriptArgs = v
	}
	go s.runWorkflow(ctx, run, script, scriptArgs, maxCost)
	return workflowReport{WorkflowRunID: run.id, Status: subagentStatusRunning}, nil
}

// runWorkflow runs the script to its end and reports it: the PATCH that owes the parent its one wake, then the
// terminal background_task that clears the workflow call from the session's running SubAgents.
func (s *bgJobService) runWorkflow(ctx context.Context, run *workflowRun, script string, args interface{}, maxCost float64) {
	defer run.cancel()
	host := &workflowSessionHost{s: s, run: run}
	out := runWorkflowScript(ctx, script, args, maxCost, host)

	s.workflows.mu.Lock()
	stopReason := run.stopReason
	s.workflows.mu.Unlock()
	status, result, errText := subagentStatusDone, out.Result, ""
	switch {
	case stopReason == subagentStopRunnerStopped:
		status = subagentStatusInterrupted
		errText = "The workflow was interrupted: the runner process hosting it stopped (a restart or an update). What its" +
			" SubAgents changed so far is in the working tree, uncommitted."
	case stopReason != "" || ctx.Err() != nil:
		status = subagentStatusStopped
		errText = "The workflow was stopped because the session ended."
	case out.Err != "":
		status = subagentStatusFailed
		errText = out.Err
	}
	// The parent is woken unless nobody is left to wake: a workflow stopped because its session ended.
	wake := status != subagentStatusStopped || stopReason == subagentStopHandedOver || (s.keptPastEnd.Load() && stopReason == "")
	s.patchWorkflow(run.id, map[string]interface{}{
		"status": status, "result": result, "error": errText, "costUsd": out.SpentUsd,
		"callsDone": out.CallsDone, "callsFailed": out.CallsFailed, "wake": wake,
	})
	bgStatus := map[string]string{subagentStatusDone: bgStatusCompleted, subagentStatusFailed: bgStatusFailed}[status]
	if bgStatus == "" {
		bgStatus = bgStatusKilled
	}
	summary := fmt.Sprintf("Workflow %s %s: %d calls done, %d failed, $%.2f", run.id, strings.ToLower(status), out.CallsDone, out.CallsFailed, out.SpentUsd)
	s.bg.emit(evBackgroundTask, map[string]interface{}{
		"toolUseId": run.toolUseID, "status": bgStatus, "summary": summary,
		"output": firstNonEmpty(errText, result), "workflowRunId": run.id,
	})
	s.workflows.mu.Lock()
	run.status = status
	close(run.done)
	s.workflows.mu.Unlock()
	s.bg.subagentsLive.Add(-1)
}

// patchWorkflow reports a workflow's end, retrying a transport failure: the server owes the wake from here.
func (s *bgJobService) patchWorkflow(id string, body map[string]interface{}) {
	for attempt := 1; attempt <= 5; attempt++ {
		err := s.t.do(nil, "PATCH", "/runner/sessions/"+s.sessionID+"/workflows/"+id, body, nil, 30*time.Second)
		if err == nil {
			return
		}
		if !isRetryableTransportError(err) || attempt == 5 {
			logln("could not report the end of workflow", id, "of session", s.sessionID+":", err)
			return
		}
		time.Sleep(time.Duration(attempt) * time.Second)
	}
}

// stopWorkflows stops every running workflow's script for reason; its calls are stopped as SubAgents
// (stopSubagents), and each workflow then reports its end. Returns the ones it stopped.
func (s *bgJobService) stopWorkflows(reason string) []*workflowRun {
	s.workflows.mu.Lock()
	defer s.workflows.mu.Unlock()
	var running []*workflowRun
	for _, r := range s.workflows.runs {
		if r.status != subagentStatusRunning {
			continue
		}
		if r.stopReason == "" {
			r.stopReason = reason
		}
		r.cancel()
		running = append(running, r)
	}
	return running
}

// announceWorkflows reports every workflow still running again behind a `resumed` handshake, which empties the
// session's running set on the server (announceSubagents does the same for delegate calls).
func (s *bgJobService) announceWorkflows() {
	s.workflows.mu.Lock()
	var running []*workflowRun
	for _, r := range s.workflows.runs {
		if r.status == subagentStatusRunning {
			running = append(running, r)
		}
	}
	s.workflows.mu.Unlock()
	for _, r := range running {
		s.bg.emit(evBackgroundTask, map[string]interface{}{
			"toolUseId": r.toolUseID, "status": "running", "kind": "subagent", "workflowRunId": r.id,
		})
	}
}

// workflowSessionHost runs a session's workflow calls as SubAgents and draws them in its stream.
type workflowSessionHost struct {
	s   *bgJobService
	run *workflowRun
}

func (h *workflowSessionHost) callToolUseID(index int) string {
	return h.run.toolUseID + "#" + strconv.Itoa(index)
}

func (h *workflowSessionHost) log(message string) {
	h.s.bg.emit(evAssistant, map[string]interface{}{"text": message, "parentToolUseId": h.run.toolUseID, "workflowRunId": h.run.id})
}

// runCall starts one agent() as a SubAgent and waits for its end. The call is drawn as a delegate call nested
// under the workflow call, the way a Claude Code workflow's agents are (claude_workflow_transcript.go).
func (h *workflowSessionHost) runCall(ctx context.Context, c workflowCall) workflowCallResult {
	s, callID := h.s, h.callToolUseID(c.Index)
	input := map[string]interface{}{
		"description": firstNonEmpty(c.Label, c.Type, "agent"), "prompt": c.Prompt, "workflow_phase": c.Phase,
	}
	if c.Type != "" {
		input["type"] = c.Type
	}
	s.bg.emit(evToolUse, map[string]interface{}{
		"id": callID, "name": delegateEngineToolName, "input": input,
		"parentToolUseId": h.run.toolUseID, "workflowRunId": h.run.id,
	})
	finish := func(r workflowCallResult, content interface{}) workflowCallResult {
		s.bg.emit(evToolResult, map[string]interface{}{
			"toolUseId": callID, "parentToolUseId": h.run.toolUseID, "content": prettyJSON(subagentJSON(content)),
			"isError": !r.OK, "workflowRunId": h.run.id,
		})
		return r
	}
	args := map[string]interface{}{
		"toolUseId": callID, "prompt": c.Prompt, "description": firstNonEmpty(c.Label, c.Type, "agent"),
		"workflowRunId": h.run.id, "callIndex": float64(c.Index), "label": c.Label, "phase": c.Phase,
	}
	for key, v := range map[string]string{"type": c.Type, "size": c.Size, "model": c.Model, "workspace": c.Workspace} {
		if v != "" {
			args[key] = v
		}
	}
	if len(c.Needs) > 0 {
		needs := make([]interface{}, len(c.Needs))
		for i, n := range c.Needs {
			needs[i] = n
		}
		args["needs"] = needs
	}
	var report subagentReport
	for {
		var err error
		report, err = s.startSubagent(args)
		if err == nil {
			break
		}
		var httpErr *transportHTTPError
		if !errors.As(err, &httpErr) || httpErr.code() != "SUBAGENT_LIMIT_REACHED" {
			return finish(workflowCallResult{Err: err.Error()}, map[string]interface{}{"status": subagentStatusFailed, "result": "The SubAgent did not start: " + err.Error()})
		}
		// The session runs as many SubAgents as its agent allows: this call waits for a free place.
		select {
		case <-ctx.Done():
			return finish(workflowCallResult{Err: "stopped"}, map[string]interface{}{"status": subagentStatusStopped, "result": "The workflow stopped before this SubAgent started."})
		case <-time.After(workflowLimitRetry):
		}
	}
	run := s.subagents.get(report.RunID)
	if run != nil && ctx.Err() != nil {
		// Stopped while this call was being opened: stopSubagents may have missed it.
		s.workflows.mu.Lock()
		reason := firstNonEmpty(h.run.stopReason, subagentStopSessionEnded)
		s.workflows.mu.Unlock()
		s.stopSubagents(reason)
	}
	if run != nil {
		<-run.done // a stop ends it through stopSubagents, which closes done
		s.subagents.mu.Lock()
		report = run.reportLocked()
		s.subagents.mu.Unlock()
	}
	r := workflowCallResult{OK: report.Status == subagentStatusDone, Result: report.Result, CostUsd: report.CostUsd}
	if !r.OK {
		r.Err = report.Result
	}
	return finish(r, map[string]interface{}{
		"runId": report.RunID, "status": report.Status, "result": report.Result, "changedFiles": nonNilStrings(report.ChangedFiles),
		"model": report.Model, "costUsd": report.CostUsd,
	})
}

// ── The script ──────────────────────────────────────────────────────────────────────────────────────────

// workflowCall is one agent() as the script made it.
type workflowCall struct {
	Index                                   int
	Prompt, Label, Phase, Type, Size, Model string
	Workspace                               string
	Needs                                   []string
}

// workflowCallResult is a call's end as the script reads it: its result text when OK, else null.
type workflowCallResult struct {
	OK      bool
	Result  string
	Err     string
	CostUsd float64
}

// workflowHost is what a script reaches outside its interpreter.
type workflowHost interface {
	// runCall runs one call to its end. Called on a goroutine of its own; ctx ends when the workflow is stopped.
	runCall(ctx context.Context, c workflowCall) workflowCallResult
	log(message string)
}

// workflowOutcome is how a script ended.
type workflowOutcome struct {
	// Result is the script's return value as JSON ("" for undefined); Err why it threw, "" when it returned.
	Result, Err            string
	CallsDone, CallsFailed int
	SpentUsd               float64
}

// workflowMeta is the script's `export const meta`.
type workflowMeta struct {
	Name, Description string
	Phases            []string
}

// parseWorkflowMeta reads the leading `export const meta = {…}` literal, evaluated alone in an empty interpreter.
func parseWorkflowMeta(script string) (workflowMeta, error) {
	start, end, err := workflowMetaSpan(script)
	if err != nil {
		return workflowMeta{}, err
	}
	vm := goja.New()
	timer := time.AfterFunc(time.Second, func() { vm.Interrupt("meta took too long") })
	defer timer.Stop()
	v, err := vm.RunString("(" + script[start:end] + ")")
	if err != nil {
		return workflowMeta{}, fmt.Errorf("the script's meta is not a literal object: %v", err)
	}
	var raw struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Phases      []struct {
			Title string `json:"title"`
		} `json:"phases"`
	}
	b, err := json.Marshal(v.Export())
	if err == nil {
		err = json.Unmarshal(b, &raw)
	}
	if err != nil {
		return workflowMeta{}, fmt.Errorf("the script's meta does not read as { name, description, phases }: %v", err)
	}
	if strings.TrimSpace(raw.Name) == "" || strings.TrimSpace(raw.Description) == "" {
		return workflowMeta{}, errors.New("the script's meta needs a name and a description")
	}
	meta := workflowMeta{Name: strings.TrimSpace(raw.Name), Description: strings.TrimSpace(raw.Description), Phases: []string{}}
	for _, p := range raw.Phases {
		if t := strings.TrimSpace(p.Title); t != "" {
			meta.Phases = append(meta.Phases, t)
		}
	}
	return meta, nil
}

const workflowMetaHead = "export const meta"

// workflowMetaSpan is where the meta object literal sits in the script: after the leading comments, the script must
// begin `export const meta = {`, and the literal ends at its matching brace (strings, templates and comments skipped).
func workflowMetaSpan(script string) (int, int, error) {
	missing := errors.New("the script must begin with `export const meta = { name, description, phases? }`")
	i := skipJSSpaceAndComments(script, 0)
	if !strings.HasPrefix(script[i:], workflowMetaHead) {
		return 0, 0, missing
	}
	i = skipJSSpaceAndComments(script, i+len(workflowMetaHead))
	if i >= len(script) || script[i] != '=' {
		return 0, 0, missing
	}
	i = skipJSSpaceAndComments(script, i+1)
	if i >= len(script) || script[i] != '{' {
		return 0, 0, missing
	}
	start, depth := i, 0
	for i < len(script) {
		switch c := script[i]; c {
		case '{', '[', '(':
			depth++
		case '}', ']', ')':
			depth--
			if depth == 0 {
				return start, i + 1, nil
			}
		case '"', '\'', '`':
			i = skipJSString(script, i)
			continue
		case '/':
			if j := skipJSSpaceAndComments(script, i); j != i {
				i = j
				continue
			}
		}
		i++
	}
	return 0, 0, errors.New("the script's meta literal never closes")
}

func skipJSSpaceAndComments(s string, i int) int {
	for i < len(s) {
		switch {
		case s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r':
			i++
		case strings.HasPrefix(s[i:], "//"):
			if nl := strings.IndexByte(s[i:], '\n'); nl >= 0 {
				i += nl + 1
			} else {
				i = len(s)
			}
		case strings.HasPrefix(s[i:], "/*"):
			if end := strings.Index(s[i+2:], "*/"); end >= 0 {
				i += end + 4
			} else {
				i = len(s)
			}
		default:
			return i
		}
	}
	return i
}

// skipJSString is the index just past the string literal opening at i.
func skipJSString(s string, i int) int {
	quote := s[i]
	for i++; i < len(s); i++ {
		switch s[i] {
		case '\\':
			i++
		case quote:
			return i + 1
		}
	}
	return len(s)
}

// workflowPrelude is the script's world, set up before it runs: the determinism guards, the error types it can
// catch, and the API over the host's __agent / __log / __spent.
const workflowPrelude = `
(() => {
  const nondeterministic = (what) => () => { throw new Error(what + ' is not available in a workflow: pass times in through args') };
  Math.random = nondeterministic('Math.random()');
  const RealDate = Date;
  function WorkflowDate(...a) {
    if (!new.target || a.length === 0) nondeterministic('new Date() without arguments')();
    return new RealDate(...a);
  }
  WorkflowDate.prototype = RealDate.prototype;
  WorkflowDate.UTC = RealDate.UTC;
  WorkflowDate.parse = RealDate.parse;
  WorkflowDate.now = nondeterministic('Date.now()');
  globalThis.Date = WorkflowDate;
})();
class WorkflowBudgetSpent extends Error { constructor(m) { super(m); this.name = 'WorkflowBudgetSpent' } }
class WorkflowCallLimit extends Error { constructor(m) { super(m); this.name = 'WorkflowCallLimit' } }
let __phase = '';
const phase = (title) => { __phase = String(title ?? '') };
const log = (message) => { __log(String(message)) };
const budget = Object.freeze({
  maxCostUsd: __maxCostUsd > 0 ? __maxCostUsd : null,
  spentUsd: () => __spent(),
  remainingUsd: () => __maxCostUsd > 0 ? Math.max(0, __maxCostUsd - __spent()) : Infinity,
});
const __AGENT_OPTS = ['label', 'phase', 'type', 'size', 'model', 'workspace', 'needs'];
const agent = (prompt, opts) => {
  if (typeof prompt !== 'string' || prompt.trim() === '') throw new TypeError('agent(): prompt must be a non-empty string');
  opts = opts ?? {};
  if (typeof opts !== 'object' || Array.isArray(opts)) throw new TypeError('agent(): opts must be an object');
  if ('schema' in opts) throw new TypeError('agent(): schema is not supported yet; leave it out and read the result text');
  if ('isolation' in opts) throw new TypeError('agent(): isolation is not supported yet; give parallel agents disjoint files');
  for (const k of Object.keys(opts)) {
    if (!__AGENT_OPTS.includes(k)) throw new TypeError('agent(): unknown option ' + k + '; known: ' + __AGENT_OPTS.join(', '));
  }
  if (__calls() >= __callCap) throw new WorkflowCallLimit('agent(): this workflow already made ' + __callCap + ' calls, the most one may');
  if (__maxCostUsd > 0 && __spent() >= __maxCostUsd) throw new WorkflowBudgetSpent('agent(): the workflow has spent its $' + __maxCostUsd + ' limit');
  const needs = opts.needs === undefined ? [] : opts.needs;
  if (!Array.isArray(needs) || needs.some((n) => typeof n !== 'string')) throw new TypeError('agent(): needs must be an array of strings');
  const str = (k) => opts[k] === undefined || opts[k] === null ? '' : String(opts[k]);
  return __agent(prompt, str('label'), opts.phase === undefined ? __phase : str('phase'), str('type'), str('size'), str('model'), str('workspace'), needs);
};
const parallel = async (thunks) => {
  if (!Array.isArray(thunks)) throw new TypeError('parallel(): pass an array of functions');
  if (thunks.length > __itemsCap) throw new RangeError('parallel(): at most ' + __itemsCap + ' items');
  return Promise.all(thunks.map((t) => Promise.resolve().then(() => t()).catch((e) => { __log('parallel(): an item failed: ' + e); return null })));
};
const pipeline = async (items, ...stages) => {
  if (!Array.isArray(items)) throw new TypeError('pipeline(): pass an array of items');
  if (items.length > __itemsCap) throw new RangeError('pipeline(): at most ' + __itemsCap + ' items');
  return Promise.all(items.map(async (item, index) => {
    let value = item;
    for (const stage of stages) {
      try { value = await stage(value, item, index) } catch (e) { __log('pipeline(): item ' + index + ' failed: ' + e); return null }
    }
    return value;
  }));
};
`

// runWorkflowScript runs a script to its end: until it returns or throws and every call it started has ended, or
// ctx ends. Its interpreter is touched only from this goroutine; each call runs on its own, and its end comes back
// over a channel and settles the call's promise here.
func runWorkflowScript(ctx context.Context, script string, args interface{}, maxCost float64, host workflowHost) workflowOutcome {
	var out workflowOutcome
	vm := goja.New()
	stopInterrupt := context.AfterFunc(ctx, func() { vm.Interrupt("the workflow was stopped") })
	defer stopInterrupt()

	type settled struct {
		resolve func(interface{}) error
		r       workflowCallResult
	}
	ends := make(chan settled)
	pending, calls := 0, 0
	set := func(name string, v interface{}) {
		if err := vm.Set(name, v); err != nil {
			panic(err)
		}
	}
	set("args", args)
	set("__maxCostUsd", maxCost)
	set("__callCap", workflowCallCap)
	set("__itemsCap", workflowItemsCap)
	set("__spent", func() float64 { return out.SpentUsd })
	set("__calls", func() int { return calls })
	set("__log", func(message string) { host.log(message) })
	set("__agent", func(prompt, label, phase, kind, size, model, workspace string, needs []string) *goja.Promise {
		c := workflowCall{Index: calls, Prompt: prompt, Label: label, Phase: phase, Type: kind, Size: size, Model: model,
			Workspace: workspace, Needs: needs}
		calls++
		pending++
		promise, resolve, _ := vm.NewPromise()
		go func() {
			r := workflowCallResult{Err: "the workflow was stopped"}
			if ctx.Err() == nil {
				r = host.runCall(ctx, c)
			}
			select {
			case ends <- settled{resolve: resolve, r: r}:
			case <-ctx.Done():
			}
		}()
		return promise
	})
	if _, err := vm.RunString(workflowPrelude); err != nil {
		out.Err = "the workflow could not start: " + err.Error()
		return out
	}
	// `export const meta` becomes `const meta` in place, and the body runs as one async function on line 1, so an
	// error's line number is the script's own.
	start, _, err := workflowMetaSpan(script)
	if err != nil {
		out.Err = err.Error()
		return out
	}
	head := strings.Index(script[:start], workflowMetaHead)
	body := script[:head] + strings.Repeat(" ", len("export ")) + script[head+len("export "):]
	value, err := vm.RunScript("workflow.js", "(async () => {"+body+"\n})()")
	if err != nil {
		out.Err = workflowErrorText(err)
		return out
	}
	promise, _ := value.Export().(*goja.Promise)
	flush := goja.MustCompile("", "", false)
	for promise != nil && (promise.State() == goja.PromiseStatePending || pending > 0) {
		select {
		case <-ctx.Done():
			// Its calls are stopped as SubAgents of the session; nothing here waits for them.
			out.Err = "the workflow was stopped"
			return out
		case e := <-ends:
			pending--
			out.SpentUsd += e.r.CostUsd
			if e.r.OK {
				out.CallsDone++
				_ = e.resolve(e.r.Result)
			} else {
				out.CallsFailed++
				_ = e.resolve(nil)
			}
			// Settling a promise only queues its reactions; they run when control next leaves the interpreter.
			if _, err := vm.RunProgram(flush); err != nil {
				out.Err = workflowErrorText(err)
				return out
			}
		}
	}
	if promise == nil {
		return out
	}
	if promise.State() == goja.PromiseStateRejected {
		out.Err = "the script threw: " + workflowValueText(vm, promise.Result())
		return out
	}
	if r := promise.Result(); r != nil && !goja.IsUndefined(r) {
		stringify, _ := goja.AssertFunction(vm.Get("JSON").ToObject(vm).Get("stringify"))
		if j, err := stringify(goja.Undefined(), r); err == nil && !goja.IsUndefined(j) {
			out.Result = j.String()
		}
	}
	return out
}

func workflowErrorText(err error) string {
	var ex *goja.Exception
	if errors.As(err, &ex) {
		return "the script threw: " + ex.String()
	}
	return "the script failed: " + err.Error()
}

// workflowValueText is a thrown value as text: an Error's stack (name, message and the script's line), else its string.
func workflowValueText(vm *goja.Runtime, v goja.Value) string {
	if obj, ok := v.(*goja.Object); ok {
		if stack := obj.Get("stack"); stack != nil && !goja.IsUndefined(stack) {
			return stack.String()
		}
	}
	return v.String()
}
