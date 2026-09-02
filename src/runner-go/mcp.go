package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// orbit mcp — a minimal Model Context Protocol server (JSON-RPC 2.0 over stdio,
// pure stdlib) that lets an in-session coding agent manage Orbit Tasks/TaskLists.
// The runner injects it into each runtime's MCP config; the engine speaks to
// it over stdin/stdout, so NOTHING may be printed to stdout except JSON-RPC frames —
// all diagnostics go to stderr.

// cmdMcp serves the MCP protocol until stdin closes. It reads the runner credential
// from config.json (never from the env, so the token stays out of the engine process)
// and the session context from the env vars the runner injected at spawn.
func cmdMcp() {
	cfg := loadConfig()
	if cfg == nil {
		fmt.Fprintln(os.Stderr, "orbit mcp: no runner config — run `orbit register` first")
		os.Exit(1)
	}
	srv := &mcpServer{
		t:                     NewTransport(cfg.ServerURL, cfg.RunnerToken),
		sessionID:             os.Getenv("ORBIT_SESSION_ID"),
		agentID:               os.Getenv("ORBIT_AGENT_ID"),
		taskID:                os.Getenv("ORBIT_TASK_ID"),
		orchestrationToken:    os.Getenv(envOrchestrationToken),
		allowPermissionPrompt: mcpPermissionPromptEnabled(),
		allowOrchestration:    mcpOrchestrationEnabled(),
	}
	srv.serve(os.Stdin, os.Stdout)
}

type mcpServer struct {
	t                     *Transport
	sessionID             string
	agentID               string // attributes created tasks/comments; "" => server falls back to USER
	taskID                string // the "current task" default for get/update/comment
	orchestrationToken    string // signed proof binding orchestration calls to sessionID
	allowPermissionPrompt bool   // Claude-only live approval bridge
	allowOrchestration    bool   // L3: expose session_* tools (Agent.enableOrchestration)
}

const envMCPPermissionPrompt = "ORBIT_MCP_PERMISSION_PROMPT"

func mcpPermissionPromptEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(envMCPPermissionPrompt))) {
	case "0", "false", "no", "off":
		return false
	default:
		return true
	}
}

const envMCPOrchestration = "ORBIT_ALLOW_ORCHESTRATION"
const envOrchestrationToken = "ORBIT_ORCHESTRATION_TOKEN"

// mcpOrchestrationEnabled gates the session_* tools. Unlike the permission prompt it defaults
// OFF: only an agent whose enableOrchestration is set (surfaced via this env) may orchestrate.
func mcpOrchestrationEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(envMCPOrchestration))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// orchestrationEnabled requires the agent opt-in and an exact session context.
// The credential is read (or, if absent/invalid, refreshed) lazily by Transport,
// so a long-lived MCP process never depends on its startup environment snapshot.
func (s *mcpServer) orchestrationEnabled() bool {
	return s.allowOrchestration &&
		strings.TrimSpace(s.sessionID) != ""
}

// orchestrationEnv renders the ORBIT_ALLOW_ORCHESTRATION value the runner injects at spawn.
func orchestrationEnv(allow bool) string {
	if allow {
		return "1"
	}
	return "0"
}

// ── JSON-RPC 2.0 wire types ────────────────────────────────────────────────

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"` // absent => notification
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  interface{}     `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// serve reads newline/whitespace-delimited JSON-RPC requests and writes responses.
// json.Decoder/Encoder handle the framing (one value per read, newline per write).
func (s *mcpServer) serve(in io.Reader, out io.Writer) {
	dec := json.NewDecoder(in)
	enc := json.NewEncoder(out)
	for {
		var req rpcRequest
		if err := dec.Decode(&req); err != nil {
			if err != io.EOF {
				fmt.Fprintln(os.Stderr, "orbit mcp: decode error:", err)
			}
			return // EOF (claude closed stdin) or unrecoverable parse error
		}
		if resp, respond := s.handle(&req); respond {
			if err := enc.Encode(resp); err != nil {
				fmt.Fprintln(os.Stderr, "orbit mcp: encode error:", err)
				return
			}
		}
	}
}

func (s *mcpServer) handle(req *rpcRequest) (rpcResponse, bool) {
	isNotification := len(req.ID) == 0
	switch req.Method {
	case "initialize":
		pv := "2024-11-05"
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		if len(req.Params) > 0 && json.Unmarshal(req.Params, &p) == nil && p.ProtocolVersion != "" {
			pv = p.ProtocolVersion
		}
		return s.ok(req.ID, map[string]interface{}{
			"protocolVersion": pv,
			"capabilities":    map[string]interface{}{"tools": map[string]interface{}{}},
			"serverInfo":      map[string]interface{}{"name": "orbit", "version": version},
		}), true
	case "notifications/initialized", "notifications/cancelled":
		return rpcResponse{}, false // notifications get no response
	case "ping":
		return s.ok(req.ID, struct{}{}), true
	case "tools/list":
		return s.ok(req.ID, map[string]interface{}{"tools": toolDescriptors(s.allowPermissionPrompt, s.orchestrationEnabled())}), true
	case "tools/call":
		var p struct {
			Name      string                 `json:"name"`
			Arguments map[string]interface{} `json:"arguments"`
		}
		if json.Unmarshal(req.Params, &p) != nil {
			return s.err(req.ID, -32602, "invalid params"), true
		}
		return s.ok(req.ID, s.callTool(p.Name, p.Arguments)), true
	default:
		if isNotification {
			return rpcResponse{}, false // ignore unknown notifications
		}
		return s.err(req.ID, -32601, "method not found: "+req.Method), true
	}
}

func (s *mcpServer) ok(id json.RawMessage, result interface{}) rpcResponse {
	return rpcResponse{JSONRPC: "2.0", ID: id, Result: result}
}

func (s *mcpServer) err(id json.RawMessage, code int, msg string) rpcResponse {
	return rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: msg}}
}

// ── Tools ───────────────────────────────────────────────────────────────────

const noTaskMsg = "no taskId given and no current task in context (ORBIT_TASK_ID unset)"

const orchestrationOffMsg = "session orchestration is not enabled for this agent"

// How many tasks one task_create_batch call may create. Mirrors the server's
// TASK_BATCH_CREATE_MAX so the tool rejects an oversized batch before the round-trip.
const maxTaskBatchCreate = 50

// How many labels one task may carry. Mirrors the server's TASK_LABEL_MAX_COUNT so the schema
// states the bound the write would be rejected against anyway.
const maxTaskLabels = 16

// How long a task's acceptance criteria may be. Mirrors the server's
// MAX_TASK_ACCEPTANCE_CRITERIA_CHARS, for the same reason as the bounds above: the schema states
// the cap the write would be rejected against, rather than letting a model discover it by 400.
const maxTaskAcceptanceCriteriaChars = 4000

// Audit explanation for deliberately keeping a criterion after the server questions its shape.
// Mirrors MAX_TASK_CRITERION_OVERRIDE_REASON_CHARS.
const maxTaskCriterionOverrideReasonChars = 2000

// Project criteria have the same total compatibility projection cap as the server and a bounded
// number of structural items, so a malformed plan is rejected before the HTTP round-trip.
const maxProjectAcceptanceCriteriaChars = 4000
const maxProjectAcceptanceCriteriaItems = 100
const maxProjectAcceptanceVerificationMethodChars = 4000

func (s *mcpServer) callTool(name string, args map[string]interface{}) map[string]interface{} {
	switch name {
	case "task_list":
		limit, err := getBoundedOptionalNumber(args, "limit", maxTaskListLimit)
		if err != nil {
			return toolResult(err.Error(), true)
		}
		if limit == 0 {
			limit = defaultTaskListLimit
		}
		raw, err := s.t.listTasks(getString(args, "status"), getString(args, "listId"), getString(args, "projectId"), getStringSlice(args, "labels"), limit)
		if err != nil {
			return toolResult("list tasks failed: "+err.Error(), true)
		}
		body := prettyJSON(raw)
		if countJSONArray(raw) >= limit {
			body = fmt.Sprintf("Showing the newest %d tasks; narrow with status/listId/projectId/labels or raise limit.\n%s", limit, body)
		}
		return toolResult(body, false)

	case "task_labels":
		raw, err := s.t.labelSummary(getString(args, "listId"))
		if err != nil {
			return toolResult("label summary failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "task_get":
		id, ok := s.resolveTaskID(args)
		if !ok {
			return toolResult(noTaskMsg, true)
		}
		raw, err := s.t.getTask(id)
		if err != nil {
			return toolResult("get task failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "task_evidence_list":
		id, ok := s.resolveTaskID(args)
		if !ok {
			return toolResult(noTaskMsg, true)
		}
		raw, err := s.t.listTaskEvidence(id)
		if err != nil {
			return toolResult("list task evidence failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "task_evidence_submit":
		id, ok := s.resolveTaskID(args)
		if !ok {
			return toolResult(noTaskMsg, true)
		}
		if strings.TrimSpace(s.sessionID) == "" {
			return toolResult("task_evidence_submit requires an Orbit task Session", true)
		}
		evidence, ok := args["evidence"].(map[string]interface{})
		if !ok || evidence == nil {
			return toolResult("evidence must be one JSON object", true)
		}
		body := map[string]interface{}{"evidence": evidence}
		copyIfPresent(body, args, "idempotencyKey")
		raw, err := s.t.submitTaskEvidence(id, s.agentID, s.sessionID, body)
		if err != nil {
			return toolResult("submit task evidence failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "task_judge":
		id, ok := s.resolveTaskID(args)
		if !ok {
			return toolResult(noTaskMsg, true)
		}
		requestID := strings.TrimSpace(getString(args, "requestId"))
		if requestID == "" {
			return toolResult("requestId is required: name the open EVIDENCE_JUDGMENT request", true)
		}
		digest := strings.ToLower(strings.TrimSpace(getString(args, "evidenceDigest")))
		if !isSHA256Hex(digest) {
			return toolResult("evidenceDigest must be the request's 64-character sha256 digest", true)
		}
		finding := getString(args, "evidence")
		if strings.TrimSpace(finding) == "" {
			return toolResult("evidence is required: state the finding this judgment rests on", true)
		}
		raw, err := s.t.judgeTask(s.sessionID, id, requestID, digest, finding)
		if err != nil {
			return toolResult("judge task failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "project_get":
		id := getString(args, "projectId")
		if id == "" {
			return toolResult("projectId is required", true)
		}
		raw, err := s.t.getProject(id)
		if err != nil {
			return toolResult("get project failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "project_crossings":
		id := getString(args, "projectId")
		if id == "" {
			return toolResult("projectId is required", true)
		}
		state := getString(args, "state")
		if state != "" && !isHandoffState(state) {
			return toolResult("state must be one of PENDING, APPROVED, DENIED, APPLIED", true)
		}
		raw, err := s.t.getProjectHandoffs(id, state)
		if err != nil {
			return toolResult("get project crossings failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "project_reopen_impact":
		id := getString(args, "projectId")
		if id == "" {
			return toolResult("projectId is required", true)
		}
		raw, err := s.t.getProjectReopenImpact(id)
		if err != nil {
			return toolResult("get project reopen impact failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "task_attribution":
		id, ok := s.resolveTaskID(args)
		if !ok {
			return toolResult(noTaskMsg, true)
		}
		raw, err := s.t.getTaskAttribution(id)
		if err != nil {
			return toolResult("get task attribution failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "merge_receipt":
		id := getString(args, "sessionId")
		if id == "" {
			id = strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))
		}
		if id == "" {
			return toolResult("sessionId is required", true)
		}
		body := map[string]interface{}{}
		copyIfPresent(body, args, "result", "sourceSha", "targetBranch", "sourceBranch",
			"targetShaBefore", "targetShaAfter", "rebaseBaseSha", "conflicts")
		if message := getString(args, "message"); message != "" {
			body["detail"] = map[string]interface{}{"message": message}
		}
		raw, err := s.t.recordMergeReceipt(id, body)
		if err != nil {
			return toolResult("record merge receipt failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "merge_receipts":
		id := getString(args, "sessionId")
		if id == "" {
			id = strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))
		}
		if id == "" {
			return toolResult("sessionId is required", true)
		}
		raw, err := s.t.listMergeReceipts(id, int(getNumber(args, "limit")))
		if err != nil {
			return toolResult("list merge receipts failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "project_acceptance":
		id := getString(args, "projectId")
		if id == "" {
			return toolResult("projectId is required", true)
		}
		raw, err := s.t.getProjectAcceptance(id)
		if err != nil {
			return toolResult("get project acceptance failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "project_acceptance_run":
		id := getString(args, "projectId")
		if id == "" {
			return toolResult("projectId is required", true)
		}
		// The server derives the evidence-version identity from the durable facts.
		raw, err := s.t.openProjectAcceptanceRun(id, map[string]interface{}{})
		if err != nil {
			return toolResult("evaluate project acceptance evidence version failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "project_acceptance_verdict":
		id := getString(args, "projectId")
		runID := getString(args, "runId")
		if id == "" || runID == "" {
			return toolResult("projectId and runId are required", true)
		}
		criteria, ok := args["criteria"].([]interface{})
		if !ok || len(criteria) == 0 {
			return toolResult("criteria must be a non-empty array with one entry per stated criterion", true)
		}
		raw, err := s.t.finalizeProjectAcceptanceRun(id, runID, map[string]interface{}{"criteria": criteria})
		if err != nil {
			return toolResult("append project acceptance conclusions failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "project_merge_evidence":
		id := getString(args, "projectId")
		requirement := getString(args, "requirementId")
		branch := getString(args, "targetBranch")
		hash := getString(args, "contentHash")
		if id == "" || requirement == "" || branch == "" {
			return toolResult("projectId, requirementId and targetBranch are required", true)
		}
		if !isSHA256Hex(hash) {
			return toolResult("contentHash must be 64 hex characters: a sha256 of the CONTENT you "+
				"read, not a commit SHA and not `git branch --contains` (a squash makes both wrong)", true)
		}
		body := map[string]interface{}{
			"requirementId": requirement,
			"targetBranch":  branch,
			"contentHash":   strings.ToLower(hash),
		}
		copyIfPresent(body, args, "source", "detail")
		raw, err := s.t.recordProjectMergeEvidence(id, body)
		if err != nil {
			return toolResult("record project merge evidence failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "project_create":
		title := getString(args, "title")
		if title == "" {
			return toolResult("title is required", true)
		}
		_, legacyCriteria := args["acceptanceCriteria"]
		_, structuredCriteria := args["acceptanceCriteriaItems"]
		if legacyCriteria {
			return toolResult(runnerLegacyProjectCriteriaError, true)
		}
		body := map[string]interface{}{"title": title}
		copyIfPresent(body, args, "goal", "instructions")
		if structuredCriteria {
			items, err := normalizeMCPProjectAcceptanceItems(args["acceptanceCriteriaItems"], false)
			if err != nil {
				return toolResult(err.Error(), true)
			}
			body["acceptanceCriteriaItems"] = items
		}
		// The calling session goes with it, the same as it does on task_create — here so the
		// server can bind THIS session as the new project's coordinator, which is what makes
		// opening the project later come back to this conversation instead of starting another.
		raw, err := s.t.createProject(s.sessionID, body)
		if err != nil {
			return toolResult("create project failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "project_update":
		id := getString(args, "projectId")
		if id == "" {
			return toolResult("projectId is required", true)
		}
		_, legacyCriteria := args["acceptanceCriteria"]
		_, structuredCriteria := args["acceptanceCriteriaItems"]
		if legacyCriteria {
			return toolResult(runnerLegacyProjectCriteriaError, true)
		}
		if status, present := args["status"]; present {
			statusText, ok := status.(string)
			if !ok || (statusText != "OPEN" && statusText != "CANCELLED") {
				return toolResult("status must be OPEN or CANCELLED; DONE is derived automatically", true)
			}
		}
		body := map[string]interface{}{}
		// The same present-only copy task_update uses, and it is what gives each prose field all
		// three outcomes for free: absent stays absent (the project keeps what it states), a string
		// is forwarded as given, and an explicit null survives as null rather than being mistaken
		// for "not supplied" — that last one is the whole clear path.
		copyIfPresent(body, args, "title", "goal", "instructions", "status")
		if structuredCriteria {
			items, err := normalizeMCPProjectAcceptanceItems(args["acceptanceCriteriaItems"], true)
			if err != nil {
				return toolResult(err.Error(), true)
			}
			body["acceptanceCriteriaItems"] = items
		}
		// The fence, counted separately: it names no field to write, so an update carrying only it
		// would be a request that changes nothing while claiming to have gone through.
		fields := len(body)
		copyIfPresent(body, args, "expectedConfigRevision")
		if fields == 0 {
			return toolResult("no fields to update", true)
		}
		raw, err := s.t.updateProject(id, body)
		if err != nil {
			return toolResult("update project failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "project_delete":
		id := getString(args, "projectId")
		if id == "" {
			return toolResult("projectId is required", true)
		}
		raw, err := s.t.deleteProject(id)
		if err != nil {
			return toolResult("delete project failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "task_dependency_graph":
		id, ok := s.resolveTaskID(args)
		if !ok {
			return toolResult(noTaskMsg, true)
		}
		maxDepth, err := getBoundedOptionalNumber(args, "maxDepth", 32)
		if err != nil {
			return toolResult(err.Error(), true)
		}
		maxNodes, err := getBoundedOptionalNumber(args, "maxNodes", 500)
		if err != nil {
			return toolResult(err.Error(), true)
		}
		raw, err := s.t.taskDependencyGraph(id, maxDepth, maxNodes)
		if err != nil {
			return toolResult("get task dependency graph failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "task_dependency_add":
		id, ok := s.resolveTaskID(args)
		if !ok {
			return toolResult(noTaskMsg, true)
		}
		dependsOnTaskID := getString(args, "dependsOnTaskId")
		if dependsOnTaskID == "" {
			return toolResult("dependsOnTaskId is required", true)
		}
		raw, err := s.t.addTaskDependency(id, dependsOnTaskID)
		if err != nil {
			return toolResult("add task dependency failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "task_dependency_remove":
		id, ok := s.resolveTaskID(args)
		if !ok {
			return toolResult(noTaskMsg, true)
		}
		dependsOnTaskID := getString(args, "dependsOnTaskId")
		if dependsOnTaskID == "" {
			return toolResult("dependsOnTaskId is required", true)
		}
		raw, err := s.t.removeTaskDependency(id, dependsOnTaskID)
		if err != nil {
			return toolResult("remove task dependency failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "task_create":
		title := getString(args, "title")
		if title == "" {
			return toolResult("title is required", true)
		}
		body := map[string]interface{}{"title": title}
		copyIfPresent(body, args, "description", "listId", "projectId", "parentTaskId", "verifiesTaskId", "acceptanceCriteria", "criterionKey", "completionCriterion", "completionCriterionOverrideReason", "acceptanceCommand", "acceptanceExpectedExitCode", "acceptanceTimeoutSeconds", "acceptanceOwnerTimeoutCeilingSeconds", "assigneeId", "dueDate", "provider", "model", "dependsOnTaskIds", "autoRunWhenReady", "completionPolicy", "labels", "supersedesTaskId", "failureSuccessorHandoff")
		// Default the assignee to the current agent when the caller didn't specify one
		// (an explicit assigneeId, including null to leave it unassigned, is respected).
		if _, ok := body["assigneeId"]; !ok && s.agentID != "" {
			body["assigneeId"] = s.agentID
		}
		if err := requireRunnerTaskCompletionDeclaration(body); err != nil {
			return toolResult(err.Error(), true)
		}
		raw, err := s.t.createTask(s.agentID, s.sessionID, body)
		if err != nil {
			return toolResult("create task failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "task_create_batch":
		items, _ := args["tasks"].([]interface{})
		if len(items) == 0 {
			return toolResult("tasks must be a non-empty array", true)
		}
		if len(items) > maxTaskBatchCreate {
			return toolResult(fmt.Sprintf("tasks accepts at most %d items per call", maxTaskBatchCreate), true)
		}
		bodies := make([]map[string]interface{}, 0, len(items))
		for i, raw := range items {
			item, ok := raw.(map[string]interface{})
			if !ok {
				return toolResult(fmt.Sprintf("tasks[%d] must be an object", i), true)
			}
			title := getString(item, "title")
			if title == "" {
				return toolResult(fmt.Sprintf("tasks[%d]: title is required", i), true)
			}
			body := map[string]interface{}{"title": title}
			copyIfPresent(body, item, "description", "listId", "projectId", "parentTaskId", "verifiesTaskId", "acceptanceCriteria", "criterionKey", "completionCriterion", "completionCriterionOverrideReason", "acceptanceCommand", "acceptanceExpectedExitCode", "acceptanceTimeoutSeconds", "acceptanceOwnerTimeoutCeilingSeconds", "assigneeId", "dueDate", "provider", "model", "dependsOnTaskIds", "autoRunWhenReady", "completionPolicy", "labels", "supersedesTaskId", "ref", "dependsOnRefs", "parentRef", "verifiesRef")
			// Same assignee default as task_create: this agent unless the caller said otherwise.
			if _, ok := body["assigneeId"]; !ok && s.agentID != "" {
				body["assigneeId"] = s.agentID
			}
			if err := requireRunnerTaskCompletionDeclaration(body); err != nil {
				return toolResult(fmt.Sprintf("tasks[%d]: %s", i, err), true)
			}
			bodies = append(bodies, body)
		}
		// Unit L7: a dry run writes nothing, so there is nothing to ask a person about. It goes
		// straight through rather than through `createBatchWithApproval`, whose whole subject is
		// runs about to start — a preview starts none, and a card asking to approve a write that
		// will not happen is a card that teaches people to click through cards.
		if getBool(args, "dryRun") {
			return s.createBatchNow(map[string]interface{}{"tasks": bodies, "dryRun": true})
		}
		return s.createBatchWithApproval(bodies)

	case "task_update":
		id, ok := s.resolveTaskID(args)
		if !ok {
			return toolResult(noTaskMsg, true)
		}
		body := map[string]interface{}{}
		// acceptanceCriteria rides the same present-only copy as every other field, which is what
		// gives it all three outcomes for free: absent stays absent (the task keeps what it says),
		// a string is forwarded as given, and an explicit null survives as null rather than being
		// mistaken for "not supplied" — that last one is the whole clear path.
		copyIfPresent(body, args, "title", "description", "status", "listId", "assigneeId", "parentTaskId", "verifiesTaskId", "dueDate", "provider", "model", "acceptanceCriteria", "completionCriterion", "acceptanceCommand", "acceptanceExpectedExitCode", "acceptanceTimeoutSeconds", "acceptanceOwnerTimeoutCeilingSeconds", "dependsOnTaskIds", "autoRunWhenReady", "completionPolicy", "verdict", "labels", "supersededByTaskId", "terminalReason")
		if len(body) == 0 {
			return toolResult("no fields to update", true)
		}
		raw, err := s.t.updateTask(s.sessionID, id, body)
		if err != nil {
			return toolResult("update task failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "task_delete":
		id, ok := s.resolveTaskID(args)
		if !ok {
			return toolResult(noTaskMsg, true)
		}
		raw, err := s.t.deleteTask(id)
		if err != nil {
			return toolResult("delete task failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "task_start":
		id, ok := s.resolveTaskID(args)
		if !ok {
			return toolResult(noTaskMsg, true)
		}
		// One name for THIS tool call, drawn once here: everything below — a redirect, any retry
		// of the POST — is the same request, and a second task_start is a second run. A draw that
		// fails stops the call rather than starting an unnamed run the model could not retry.
		token, err := newRunRequestToken()
		if err != nil {
			return toolResult("start task failed: "+err.Error(), true)
		}
		raw, err := s.t.startTask(id, token)
		if err != nil {
			return toolResult("start task failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "task_comment":
		id, ok := s.resolveTaskID(args)
		if !ok {
			return toolResult(noTaskMsg, true)
		}
		body := getString(args, "body")
		if body == "" {
			return toolResult("body is required", true)
		}
		raw, err := s.t.commentTask(id, s.agentID, body)
		if err != nil {
			return toolResult("comment failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "tasklist_list":
		raw, err := s.t.listTaskLists()
		if err != nil {
			return toolResult("list task-lists failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "tasklist_create":
		title := getString(args, "title")
		if title == "" {
			return toolResult("title is required", true)
		}
		raw, err := s.t.createTaskList(title)
		if err != nil {
			return toolResult("create task-list failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "tasklist_get":
		id := getString(args, "listId")
		if id == "" {
			return toolResult("listId is required", true)
		}
		raw, err := s.t.getTaskList(id)
		if err != nil {
			return toolResult("get task-list failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "tasklist_update":
		id := getString(args, "listId")
		if id == "" {
			return toolResult("listId is required", true)
		}
		body := map[string]interface{}{}
		// Only the keys the caller actually sent: a partial edit must not blank the rest of the
		// policy, and the server distinguishes absent from null.
		copyIfPresent(body, args, "title", "instructions", "note", "foremanWorkspaceId")
		copyIfPresent(body, args, "paused", "maxConcurrent", "foremanStallMinutes", "verifyOnDone")
		if len(body) == 0 {
			return toolResult("nothing to update", true)
		}
		raw, err := s.t.updateTaskList(id, s.agentID, s.sessionID, body)
		if err != nil {
			return toolResult("update task-list failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "tasklist_propose_dag":
		return s.proposeDag(args)

	case "tasklist_delete":
		id := getString(args, "listId")
		if id == "" {
			return toolResult("listId is required", true)
		}
		raw, err := s.t.deleteTaskList(id)
		if err != nil {
			return toolResult("delete task-list failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "provider_list":
		raw, err := s.t.listProviders()
		if err != nil {
			return toolResult("list providers failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "notify":
		message := getString(args, "message")
		if message == "" {
			return toolResult("message is required", true)
		}
		raw, err := s.t.notify(s.sessionID, message)
		if err != nil {
			return toolResult("notify failed: "+err.Error(), true)
		}
		// Not an error result when nothing was delivered: the call did what it could, and
		// "delivered": false with a reason is the answer, not a failure of the tool. The agent
		// needs to read it either way — it is what decides whether a human has actually been told.
		return toolResult(prettyJSON(raw), false)

	case "session_create":
		if !s.orchestrationEnabled() {
			return toolResult(orchestrationOffMsg, true)
		}
		prompt := getString(args, "prompt")
		if prompt == "" {
			return toolResult("prompt is required", true)
		}
		body := map[string]interface{}{"prompt": prompt}
		copyIfPresent(body, args, "title", "model", "provider", "permissionMode")
		// Route to a target agent: an explicit agentId wins; else an @-mentioned agentName
		// (resolved to that owner's agent server-side); else default to the current agent.
		if id := getString(args, "agentId"); id != "" {
			body["agentId"] = id
		} else if name := getString(args, "agentName"); name != "" {
			body["agentName"] = name
		} else if s.agentID != "" {
			body["agentId"] = s.agentID
		}
		raw, err := s.t.createSession(s.sessionID, s.orchestrationToken, body)
		if err != nil {
			return toolResult("create session failed: "+err.Error(), true)
		}
		if getBool(args, "wait") {
			return s.waitForSession(raw)
		}
		return toolResult(prettyJSON(raw), false)

	case "session_list":
		if !s.orchestrationEnabled() {
			return toolResult(orchestrationOffMsg, true)
		}
		raw, err := s.t.listSessions(s.sessionID, s.orchestrationToken, sessionListQuery(args))
		if err != nil {
			return toolResult("list sessions failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "session_search":
		if !s.orchestrationEnabled() {
			return toolResult(orchestrationOffMsg, true)
		}
		if getString(args, "query") == "" {
			return toolResult("query is required", true)
		}
		raw, err := s.t.searchSessions(s.sessionID, s.orchestrationToken, sessionSearchQuery(args))
		if err != nil {
			return toolResult("search sessions failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "session_get":
		if !s.orchestrationEnabled() {
			return toolResult(orchestrationOffMsg, true)
		}
		id := getString(args, "sessionId")
		if id == "" {
			return toolResult("sessionId is required", true)
		}
		raw, err := s.t.getSession(s.sessionID, s.orchestrationToken, id)
		if err != nil {
			return toolResult("get session failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "session_send":
		if !s.orchestrationEnabled() {
			return toolResult(orchestrationOffMsg, true)
		}
		id := getString(args, "sessionId")
		msg := getString(args, "message")
		if id == "" || msg == "" {
			return toolResult("sessionId and message are required", true)
		}
		body := map[string]interface{}{"message": msg}
		copyIfPresent(body, args, "clientTurnId")
		raw, err := s.t.sendSessionMessage(s.sessionID, s.orchestrationToken, id, body)
		if err != nil {
			return toolResult("send message failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "session_interrupt":
		if !s.orchestrationEnabled() {
			return toolResult(orchestrationOffMsg, true)
		}
		id := getString(args, "sessionId")
		if id == "" {
			return toolResult("sessionId is required", true)
		}
		// With a message this is one operation, not an interrupt followed by a send: the
		// interrupt drops what was queued behind the running turn, so a message sent as a
		// second call would be racing that delete.
		var body interface{}
		if follow := strings.TrimSpace(getString(args, "message")); follow != "" {
			req := map[string]interface{}{"message": follow}
			copyIfPresent(req, args, "clientTurnId")
			body = req
		}
		raw, err := s.t.interruptSession(s.sessionID, s.orchestrationToken, id, body)
		if err != nil {
			return toolResult("interrupt session failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "session_merge":
		if !s.orchestrationEnabled() {
			return toolResult(orchestrationOffMsg, true)
		}
		id := getString(args, "sessionId")
		if id == "" {
			return toolResult("sessionId is required", true)
		}
		body := map[string]interface{}{}
		copyIfPresent(body, args, "targetBranch")
		raw, err := s.t.mergeSession(s.sessionID, s.orchestrationToken, id, body)
		if err != nil {
			return toolResult("merge session failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "session_end":
		if !s.orchestrationEnabled() {
			return toolResult(orchestrationOffMsg, true)
		}
		id := getString(args, "sessionId")
		if id == "" {
			return toolResult("sessionId is required", true)
		}
		raw, err := s.t.endSession(s.sessionID, s.orchestrationToken, id)
		if err != nil {
			return toolResult("end session failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "session_complete":
		if !s.orchestrationEnabled() {
			return toolResult(orchestrationOffMsg, true)
		}
		id := getString(args, "sessionId")
		if id == "" {
			return toolResult("sessionId is required", true)
		}
		raw, err := s.t.completeSession(s.sessionID, s.orchestrationToken, id)
		if err != nil {
			return toolResult("complete session failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "session_delete":
		if !s.orchestrationEnabled() {
			return toolResult(orchestrationOffMsg, true)
		}
		id := getString(args, "sessionId")
		if id == "" {
			return toolResult("sessionId is required", true)
		}
		raw, err := s.t.deleteSession(s.sessionID, s.orchestrationToken, id)
		if err != nil {
			return toolResult("delete session failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "agent_list":
		if !s.orchestrationEnabled() {
			return toolResult(orchestrationOffMsg, true)
		}
		raw, err := s.t.listAgents(s.sessionID, s.orchestrationToken)
		if err != nil {
			return toolResult("list agents failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "agent_create":
		if !s.orchestrationEnabled() {
			return toolResult(orchestrationOffMsg, true)
		}
		name := getString(args, "name")
		if name == "" {
			return toolResult("name is required", true)
		}
		body := map[string]interface{}{"name": name}
		copyIfPresent(body, args, "description", "systemPrompt", "appendSystemPrompt", "workDir", "runnerId", "repoUrl", "enableWorktree", "env", "defaultMergeTarget")
		raw, err := s.t.createAgent(s.sessionID, s.orchestrationToken, body)
		if err != nil {
			return toolResult("create agent failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "agent_update":
		if !s.orchestrationEnabled() {
			return toolResult(orchestrationOffMsg, true)
		}
		id := getString(args, "agentId")
		if id == "" {
			return toolResult("agentId is required", true)
		}
		body := map[string]interface{}{}
		copyIfPresent(body, args, "name", "description", "systemPrompt", "appendSystemPrompt", "workDir", "runnerId", "enableWorktree", "env", "defaultMergeTarget")
		if len(body) == 0 {
			return toolResult("no fields to update", true)
		}
		raw, err := s.t.updateAgent(s.sessionID, s.orchestrationToken, id, body)
		if err != nil {
			return toolResult("update agent failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "permission_prompt":
		if !s.allowPermissionPrompt {
			return toolResult(denyJSON("permission approvals are disabled for this provider"), false)
		}
		return s.permissionPrompt(args)

	default:
		return toolResult("unknown tool: "+name, true)
	}
}

// batchApprovalToolName is the batch-create card's key, alongside dagApprovalToolName. Building
// a DAG and restructuring one are the same decision seen from two ends, so they are gated the
// same way and rendered by two cards that read alike.
const batchApprovalToolName = "orbit_task_batch"

// createBatchWithApproval puts a batch of new tasks in front of a human before writing any of it.
//
// This is the tool that builds a DAG, and it is the most consequential thing an agent does here
// while looking like the least: fifty titles say nothing, and what actually happens is some number
// of runs starting within the minute. This deployment has the cautionary case — one session
// created 43 lists and ~21,500 tasks before anybody looked.
//
// A single task_create stays ungated on purpose. It writes one task and can start one run, and
// gating the most ordinary operation an agent performs would make it unusable; the batch is where
// the reach is, and it is the only place `dependsOnRefs` — a DAG in one call — can be expressed.
func (s *mcpServer) createBatchWithApproval(bodies []map[string]interface{}) map[string]interface{} {
	body := map[string]interface{}{"tasks": bodies}
	if s.sessionID == "" {
		// Headless (a CLI-shaped call with no session): there is nobody to ask and no card to
		// show, so the write goes ahead exactly as it did before.
		return s.createBatchNow(body)
	}
	preview, err := s.t.batchPreview(s.agentID, s.sessionID, body)
	if err != nil {
		return toolResult("batch preview failed: "+err.Error(), true)
	}
	// Ask about the consequence, not about the operation.
	//
	// What an approval protects is runs starting — real model calls, real money, real side
	// effects — not rows being written. A batch that starts nothing is a bookkeeping write, and
	// gating those made the tool unusable at any real scale: fifty items per call means a
	// 27,000-task campaign is 550 cards, none of which decide anything.
	//
	// This also gives the escape hatch back to the human without a new switch. Building into a
	// paused list, or with autoRunWhenReady off, starts nothing — so it is never asked — and one
	// deliberate unpause releases the campaign afterwards. `paused` was already the control for
	// "I am still assembling this"; it now does that job here too.
	var startsNow struct {
		StartingNow int `json:"startingNow"`
	}
	if err := json.Unmarshal(preview, &startsNow); err == nil && startsNow.StartingNow == 0 {
		return s.createBatchNow(body)
	}
	input := map[string]interface{}{"tasks": bodies, "preview": json.RawMessage(preview)}
	id, err := s.t.createApproval(context.Background(), s.sessionID, map[string]interface{}{
		"toolName": batchApprovalToolName,
		"input":    input,
	})
	if err != nil {
		return toolResult("could not register approval: "+err.Error(), true)
	}
	for {
		dec, err := s.t.pollApproval(context.Background(), s.sessionID, id)
		if err != nil {
			return toolResult("approval poll failed: "+err.Error(), true)
		}
		switch dec.Status {
		case "ALLOWED":
			return s.createBatchNow(body)
		case "DENIED":
			msg := dec.Message
			if msg == "" {
				msg = "denied by the user"
			}
			return toolResult("the human rejected this batch: "+msg, false)
		}
	}
}

func (s *mcpServer) createBatchNow(body map[string]interface{}) map[string]interface{} {
	raw, err := s.t.createTasksBatch(s.agentID, s.sessionID, body)
	if err != nil {
		return toolResult("create tasks failed: "+err.Error(), true)
	}
	return toolResult(prettyJSON(raw), false)
}

// dagApprovalToolName is what the approval is filed under, and what the web keys its typed card
// off. Not an `mcp__orbit__` name: this is not the engine's permission prompt for a tool call, it
// is Orbit asking about a change of its own, and a card that rendered it as "allow this tool?"
// would put the decision in the wrong frame.
const dagApprovalToolName = "orbit_dag_change"

// proposeDag runs a DAG restructure past a human before writing any of it.
//
// The approval is raised explicitly rather than left to the engine's own permission gating,
// because that gating is a function of the session's permission mode: on a session running
// permissively the write would land silently, and "silently" is the one thing a batch that can
// release forty tasks into the dispatcher must never be. One card for the whole batch, carrying
// the server-computed impact — the human is approving what results, not fourteen edge writes.
func (s *mcpServer) proposeDag(args map[string]interface{}) map[string]interface{} {
	if s.sessionID == "" {
		return toolResult("no session context (ORBIT_SESSION_ID unset)", true)
	}
	listID := getString(args, "listId")
	if listID == "" {
		return toolResult("listId is required", true)
	}
	ops, ok := args["ops"].([]interface{})
	if !ok || len(ops) == 0 {
		return toolResult("ops is required and must be a non-empty array", true)
	}
	body := map[string]interface{}{"ops": ops}
	if note := getString(args, "note"); note != "" {
		body["note"] = note
	}
	preview, err := s.t.dagPreview(listID, body)
	if err != nil {
		return toolResult("dag preview failed: "+err.Error(), true)
	}
	// A batch that cannot be applied is not a decision to put in front of a human — it is a
	// mistake to hand straight back, with the cycle named so it can be fixed in one more turn.
	var p struct {
		Cycle []struct {
			Title string `json:"title"`
		} `json:"cycle"`
		EffectiveCount int `json:"effectiveCount"`
		NoopCount      int `json:"noopCount"`
	}
	if err := json.Unmarshal(preview, &p); err == nil {
		if len(p.Cycle) > 0 {
			titles := make([]string, 0, len(p.Cycle))
			for _, c := range p.Cycle {
				titles = append(titles, c.Title)
			}
			return toolResult("rejected: these changes would create a cycle: "+strings.Join(titles, " -> "), true)
		}
		if p.EffectiveCount == 0 {
			return toolResult("nothing to do: every proposed edge is already in the state you asked for ("+
				strconv.Itoa(p.NoopCount)+" no-op(s)). Re-read the graph with task_dependency_graph before proposing again.", true)
		}
	}
	input := map[string]interface{}{"listId": listID, "ops": ops, "preview": json.RawMessage(preview)}
	if note := getString(args, "note"); note != "" {
		input["note"] = note
	}
	id, err := s.t.createApproval(context.Background(), s.sessionID, map[string]interface{}{
		"toolName": dagApprovalToolName,
		"input":    input,
	})
	if err != nil {
		return toolResult("could not register approval: "+err.Error(), true)
	}
	// Unbounded, exactly like permissionPrompt: this asks a human who may be asleep, and a
	// deadline here would turn "not answered yet" into a silent abandonment of the restructure.
	for {
		dec, err := s.t.pollApproval(context.Background(), s.sessionID, id)
		if err != nil {
			return toolResult("approval poll failed: "+err.Error(), true)
		}
		switch dec.Status {
		case "ALLOWED":
			applied, err := s.t.dagApply(listID, body)
			if err != nil {
				// Approved but unapplicable: the graph moved while the card was open. Say so
				// plainly — the alternative is an agent that believes it restructured the list.
				return toolResult("approved, but applying failed: "+err.Error(), true)
			}
			return toolResult(prettyJSON(applied), false)
		case "DENIED":
			msg := dec.Message
			if msg == "" {
				msg = "denied by the user"
			}
			return toolResult("the human rejected this DAG change: "+msg, false)
		}
	}
}

// permissionPrompt is claude's --permission-prompt-tool: it registers the gated tool
// call as a pending approval, blocks until a human allows/denies it (re-polling across
// the server's long-poll windows), and returns the decision in the shape claude wants:
//
//	{"behavior":"allow","updatedInput":{...}}  or  {"behavior":"deny","message":"..."}
//
// Fails CLOSED (deny) on any transport error — a control-plane outage must never
// silently auto-approve a gated action.
func (s *mcpServer) permissionPrompt(args map[string]interface{}) map[string]interface{} {
	if s.sessionID == "" {
		return toolResult(denyJSON("no session context (ORBIT_SESSION_ID unset)"), false)
	}
	id, err := s.t.createApproval(context.Background(), s.sessionID, map[string]interface{}{
		"toolName":  getString(args, "tool_name"),
		"input":     args["input"],
		"toolUseId": getString(args, "tool_use_id"),
	})
	if err != nil {
		return toolResult(denyJSON("could not register approval: "+err.Error()), false)
	}
	// Poll without a wall-clock cap: an approval is an asynchronous ask of a human who
	// may be asleep, and a self-imposed deadline turns "not answered yet" into a hard
	// deny. Nothing leaks — this server is claude's stdio child, so cancelling the
	// session kills claude, our stdin hits EOF and the process exits mid-poll.
	for {
		dec, err := s.t.pollApproval(context.Background(), s.sessionID, id)
		if err != nil {
			return toolResult(denyJSON("approval poll failed: "+err.Error()), false)
		}
		switch dec.Status {
		case "ALLOWED":
			// AskUserQuestion's "answer" rides back as updatedInput.answers (question
			// text -> picked labels); claude reads it and formats the tool result.
			if getString(args, "tool_name") == "AskUserQuestion" {
				return toolResult(allowJSON(askQuestionInput(args["input"], dec.Answers), nil), false)
			}
			// "Allow + remember same kind": add session-scoped permission rules so
			// claude's own engine auto-allows future matching calls without re-prompting.
			return toolResult(allowJSON(args["input"], rememberPermissions(dec.resolveRememberRules())), false)
		case "DENIED":
			msg := dec.Message
			if msg == "" {
				msg = "denied by the user"
			}
			return toolResult(denyJSON(msg), false)
		}
		// PENDING: the server's long-poll window elapsed undecided — re-poll.
	}
}

// askQuestionInput rebuilds AskUserQuestion's input for an allow decision: the
// original questions plus the human's answers. claude validates this against a
// strict object schema, so we pass only the keys it accepts (questions + answers).
// answers is question text -> picked option labels; a multi-pick array is joined
// by claude itself.
func askQuestionInput(input interface{}, answers map[string][]string) map[string]interface{} {
	out := map[string]interface{}{}
	if m, ok := input.(map[string]interface{}); ok {
		if q, ok := m["questions"]; ok {
			out["questions"] = q
		}
	}
	if answers == nil {
		answers = map[string][]string{}
	}
	out["answers"] = answers
	return out
}

// rememberPermissions turns "remember same kind" rules into claude's updatedPermissions
// payload: add the rules for this session only (claude's engine matches future calls).
// Returns nil when there are none, so allowJSON omits the field (the common case).
func rememberPermissions(rules []PermissionRule) []interface{} {
	var rs []interface{}
	for _, rule := range rules {
		if rule.ToolName == "" {
			continue
		}
		r := map[string]interface{}{"toolName": rule.ToolName}
		if rule.RuleContent != "" {
			r["ruleContent"] = rule.RuleContent
		}
		rs = append(rs, r)
	}
	if len(rs) == 0 {
		return nil
	}
	return []interface{}{map[string]interface{}{
		"type":        "addRules",
		"rules":       rs,
		"behavior":    "allow",
		"destination": "session",
	}}
}

func allowJSON(input interface{}, updatedPermissions []interface{}) string {
	if input == nil {
		input = map[string]interface{}{}
	}
	out := map[string]interface{}{"behavior": "allow", "updatedInput": input}
	if len(updatedPermissions) > 0 {
		out["updatedPermissions"] = updatedPermissions
	}
	b, err := json.Marshal(out)
	if err != nil {
		return `{"behavior":"allow","updatedInput":{}}`
	}
	return string(b)
}

func denyJSON(message string) string {
	b, err := json.Marshal(map[string]interface{}{"behavior": "deny", "message": message})
	if err != nil {
		return `{"behavior":"deny","message":"denied"}`
	}
	return string(b)
}

// resolveTaskID prefers an explicit taskId arg, then the injected current task.
func (s *mcpServer) resolveTaskID(args map[string]interface{}) (string, bool) {
	if id := getString(args, "taskId"); id != "" {
		return id, true
	}
	if s.taskID != "" {
		return s.taskID, true
	}
	return "", false
}

// toolDescriptors is the tools/list payload. Claude namespaces these as
// mcp__orbit__<name> for the allowlist; the agent allowlist defaults to mcp__orbit__*.
func toolDescriptors(includePermissionPrompt, includeOrchestration bool) []map[string]interface{} {
	str := map[string]interface{}{"type": "string"}
	taskIDProp := map[string]interface{}{"type": "string", "description": "Task id; defaults to the current task (ORBIT_TASK_ID) if omitted"}
	promptDesc := map[string]interface{}{"type": "string", "description": "Write this as a self-contained, executable prompt for the task — background, files involved, concrete steps, and acceptance criteria — so an agent with no prior conversation context can pick it up and act on it directly."}
	// FAILED is one of the five values TaskStatus has always had, and the server has always
	// accepted it — it was missing from this enum alone, which made "put a task back the way its
	// run left it" unreachable from any tool while remaining reachable from raw SQL.
	status := map[string]interface{}{
		"type": "string",
		"enum": []string{"OPEN", "IN_PROGRESS", "DONE", "CANCELLED", "FAILED"},
		"description": "FAILED is what a run that died leaves behind; write it to restore that " +
			"outcome, never to express \"I could not finish\" about work nobody ran. Pair it with " +
			"supersededByTaskId in ONE call when a later attempt took over, so the attempt keeps " +
			"how it ended and gains what replaced it.",
	}
	taskUpdateStatus := map[string]interface{}{
		"type": "string",
		"enum": []string{"OPEN", "IN_PROGRESS", "DONE", "CANCELLED", "FAILED"},
		"description": "Direct DONE is refused for every person, coordinator, and execution " +
			"session; satisfy the task's declared EXECUTABLE, VERIFICATION, or EVIDENCE_JUDGMENT " +
			"criterion instead. FAILED remains writable as a run's conservative self-report.",
	}
	providerProp := map[string]interface{}{
		"type":        []string{"string", "null"},
		"description": "Run this task on a specific provider: a built-in engine slug (\"claude\", \"codex\", \"kimi\", \"opencode\") or one of the owner's configured provider slugs. Omit (or pass null) to start where the assignee's project last started, which is almost always right — only pin one when the task genuinely needs that provider. Changing it makes the next run start a fresh session instead of continuing the previous one.",
	}
	modelProp := map[string]interface{}{
		"type":        []string{"string", "null"},
		"description": "Run this task on a specific model id within its provider's model space (e.g. \"claude-opus-5\"). Omit (or pass null) to use the provider's own default. An id the provider doesn't have will fail at run time, not here.",
	}
	// Files a new task under a project, on task_create and every task_create_batch item alike.
	// Not nullable, unlike listId: on a create there is nothing to clear, and null would be an id
	// the server rejects rather than a shorthand for "no project".
	projectIDProp := map[string]interface{}{
		"type": "string",
		"description": "File this task under a project you own — what to pass when the work is part of a " +
			"goal you were given (project_get names it). Orthogonal to listId: the project says what the " +
			"work is FOR, the list decides how it is dispatched, so a task may have one of each, either, " +
			"or neither. Omit it when the work belongs to no project; a project that does not exist, or " +
			"belongs to somebody else, is rejected rather than filed nowhere.",
	}
	// Makes the new task a subtask of one that already exists, on task_create and every
	// task_create_batch item alike. Not nullable for the same reason as projectId: on a create
	// there is no existing link to clear.
	parentTaskIDProp := map[string]interface{}{
		"type": "string",
		"description": "Make this task a subtask of an EXISTING task you own — how to break a piece of " +
			"work into steps that stay attached to it. The parent must be in the SAME project as this " +
			"task, so a subtask of a project's task normally passes both parentTaskId and that same " +
			"projectId; a parent filed under no project needs projectId omitted here too. The project " +
			"is NOT inherited from the parent — a mismatch (or a parent that does not exist, or belongs " +
			"to somebody else) is rejected rather than filed loose. Names a task that already exists: " +
			"to hang an item under another item of this same task_create_batch call, whose id does not " +
			"exist yet, use `parentRef` instead. Either spelling is membership, not ordering — when a " +
			"task RUNS is dependsOnTaskIds/dependsOnRefs, a separate question.",
	}
	// The same link on the edit door, where it also has to be removable. A decomposition is
	// usually understood after the tasks exist — a step turns out to belong under a different
	// piece of work, or under none — so re-parenting has to be expressible without deleting and
	// recreating the task, which would lose its comments, its sessions and its edges. Nullable,
	// unlike the create prop above: on a create there is no existing link to clear.
	updateParentTaskIDProp := map[string]interface{}{
		"type": []string{"string", "null"},
		"description": "Make this task a subtask of another task you own, or pass null to detach it " +
			"and leave it standing on its own; omit it to leave the current parent alone. The parent " +
			"must be in the SAME project as this task — re-file one of them first if they differ. " +
			"Refused when it would make a task its own parent, or name one of its own subtasks as its " +
			"parent (that closes a loop). Membership, not ordering: this says what the task is PART OF " +
			"and changes nothing about when it runs — that is dependsOnTaskIds.",
	}
	// Both task write doors have a field of their own for what proves the work is done, so their
	// `description` must stop asking for one: promptDesc above tells the caller to put acceptance
	// criteria inside the prompt, and next to acceptanceCriteria that is an instruction to write the
	// same thing twice — two copies that drift, with nothing saying which one settles the task.
	// Shared by task_create, every task_create_batch item and task_update, because a prompt edited
	// through the update door must not reintroduce the copy the create door just gave up.
	// session_create deliberately keeps promptDesc: it takes no acceptanceCriteria, so for it the
	// prompt really is the only place the criteria can live.
	taskDescriptionProp := map[string]interface{}{
		"type": "string",
		"description": "Write this as a self-contained, executable prompt for the task — background, " +
			"files involved, and concrete steps — so an agent with no prior conversation context can " +
			"pick it up and act on it directly. Say what to DO here; what would PROVE it done belongs " +
			"in `acceptanceCriteria`, not repeated here.",
	}
	// States what would settle this one task, on task_create and every task_create_batch item alike.
	// Capped here at the server's own limit so an over-long value is caught before the round trip.
	acceptanceCriteriaProp := map[string]interface{}{
		"type":      "string",
		"maxLength": maxTaskAcceptanceCriteriaChars,
		"description": fmt.Sprintf("What would settle that THIS task is done: the observable, "+
			"independently verifiable result — a command that passes, a file that exists, a number "+
			"that moved — stated so somebody who did not watch the work can check it. Distinct from "+
			"`description`, which says what work to PERFORM, and from the project's own "+
			"acceptanceCriteria (project_get), which settles the whole goal rather than this one "+
			"step. Coexists with projectId and parentTaskId: a subtask filed under a project still "+
			"states what would settle itself, not what would settle its parent or its project. Up "+
			"to %d characters.", maxTaskAcceptanceCriteriaChars),
	}
	criterionOverrideReasonProp := map[string]interface{}{
		"type":      "string",
		"minLength": 1,
		"maxLength": maxTaskCriterionOverrideReasonChars,
		"description": "Why this task deliberately keeps the declared completionCriterion after " +
			"TASK_CRITERION_SHAPE_ADVICE questioned it. Omit on the first attempt. If the server " +
			"suggests another criterion, either adopt that suggestion or retry with this non-blank " +
			"audit explanation; Orbit stores it on the task and task_get reads it back.",
	}
	// Which of the PROJECT's stated acceptance criteria a new task serves. Required of a project's
	// one-shot judgment session and of nobody else, so the description says who has to send it
	// rather than marking it required — a person filing work has never had to justify it to a gate.
	criterionKeyProp := map[string]interface{}{
		"type":      "string",
		"maxLength": 64,
		"description": "Which of the PROJECT's stated acceptance criteria this new task serves — " +
			"one of the `key` values project_get returns beside each criterion. A project " +
			"coordinator's one-shot judgment session MUST send it and the server refuses the create " +
			"without it; every other caller may omit it. It is what bounds a coordinator filing " +
			"more work on the fact that the criteria are FINITE and a person wrote them: work that " +
			"serves none of them is work the project was not asked for. Re-read the keys before " +
			"sending one — editing a criterion's text changes its key.",
	}
	// The same field on the edit door, where it also has to be removable. Criteria are usually
	// written before the work is understood, so what settles a task is whatever it says at the end,
	// not what it was created with — an agent that discovers the real test has to be able to record
	// it, and one that finds the recorded test was wrong has to be able to take it back. Nullable,
	// unlike the create prop above: on a create there is no existing value to clear.
	updateAcceptanceCriteriaProp := map[string]interface{}{
		"type":      []string{"string", "null"},
		"maxLength": maxTaskAcceptanceCriteriaChars,
		"description": fmt.Sprintf("What would settle that THIS task is done: the observable, "+
			"independently verifiable result — a command that passes, a file that exists, a number "+
			"that moved — stated so somebody who did not watch the work can check it. Whole-field "+
			"replacement, not an append: OMIT it to leave the task's current criteria exactly as they "+
			"are, pass a string to REPLACE them (the empty string records that the task has none "+
			"worth stating), pass null to CLEAR them. Expect to use it after creation — what proves a "+
			"task done is often only knowable once the work is understood. Distinct from "+
			"`description`, which says what work to PERFORM, and from the project's own "+
			"acceptanceCriteria (project_get), which settles the whole goal rather than this one "+
			"step: editing a task's criteria never touches its project's, and copying the project's "+
			"onto a task claims one step settles everything. Up to %d characters.",
			maxTaskAcceptanceCriteriaChars),
	}
	labelsProp := map[string]interface{}{
		"type":        "array",
		"items":       str,
		"maxItems":    maxTaskLabels,
		"description": "Grouping labels for this task, orthogonal to listId: the list decides how the task runs, a label only says which tasks belong together, so a task has one list and any number of labels. Use them for the axis the list cannot express — the batch, dataset, shard or upstream commit a task belongs to — and label facts, not judgements: `CC-MAIN-2017-34` groups reliably because it is copied from the work, `important` does not because the next call spells it differently. Matched exactly, case included. task_list filters on them and task_labels reports each label's progress, so a label nobody will query is just a longer title.",
	}
	obj := func(props map[string]interface{}, required ...string) map[string]interface{} {
		schema := map[string]interface{}{"type": "object", "properties": props}
		if len(required) > 0 {
			schema["required"] = required
		}
		return schema
	}
	projectCriterionTextProp := map[string]interface{}{
		"type":      "string",
		"minLength": 1,
		"maxLength": maxProjectAcceptanceCriteriaChars,
		"description": "One atomic, independently judgeable project outcome. Keep it on one line " +
			"during the legacy compatibility window; inline Markdown is allowed.",
	}
	projectCriterionMethodProp := map[string]interface{}{
		"type":      "string",
		"minLength": 1,
		"maxLength": maxProjectAcceptanceVerificationMethodChars,
		"description": "Required. The concrete procedure and evidence that decides whether this " +
			"assertion holds (for example a command plus expected exit code, a named spec, or a " +
			"human review against identified direct evidence). A code comment is not a method.",
	}
	projectCriterionKindProp := map[string]interface{}{
		"type": "string",
		"enum": []string{"EXECUTABLE", "VERIFICATION", "EVIDENCE_JUDGMENT"},
		"description": "Required peer criterion, using the same enum as Task. EXECUTABLE consumes " +
			"the declared evidence Task's exact command exit code; VERIFICATION consumes an " +
			"independent verifier Task verdict; EVIDENCE_JUDGMENT waits for a person. No fallback chain.",
	}
	projectCriterionProps := func(allowID bool) map[string]interface{} {
		props := map[string]interface{}{
			"text":                              projectCriterionTextProp,
			"verificationMethod":                projectCriterionMethodProp,
			"completionCriterion":               projectCriterionKindProp,
			"acceptanceCommand":                 map[string]interface{}{"type": "string", "description": "Required only for EXECUTABLE."},
			"acceptanceExpectedExitCode":        map[string]interface{}{"type": "integer", "description": "Required only for EXECUTABLE."},
			"evidenceTaskId":                    map[string]interface{}{"type": "string", "description": "EXECUTABLE source Task or independent VERIFICATION Task."},
			"completionCriterionOverrideReason": map[string]interface{}{"type": "string", "maxLength": 2000, "description": "Why a caller kept a declaration questioned by the shared N23 advisory."},
		}
		if allowID {
			props["id"] = map[string]interface{}{"type": "string"}
		}
		return props
	}
	projectCriteriaCreateProp := map[string]interface{}{
		"type":     "array",
		"maxItems": maxProjectAcceptanceCriteriaItems,
		"description": "The project's acceptance criteria as explicit assertion + method + peer " +
			"criterion items. This is the runner write shape; all three fields are required.",
		"items": obj(projectCriterionProps(false), "text", "verificationMethod", "completionCriterion"),
	}
	projectCriteriaUpdateProp := map[string]interface{}{
		"type":     "array",
		"maxItems": maxProjectAcceptanceCriteriaItems,
		"description": "Whole structured replacement; text, verificationMethod and completionCriterion are required. " +
			"Preserve an item's id from project_get to " +
			"edit or reorder it without replacing its identity; omit id to add a new item; [] clears all. " +
			"currentStatus is derived and is not an input. Legacy acceptanceCriteria is not a " +
			"runner write shape.",
		"items": obj(projectCriterionProps(true), "text", "verificationMethod", "completionCriterion"),
	}
	// The fields of one new task, shared by task_create and every task_create_batch item.
	// A fresh map per call so a caller can extend its copy without touching the other's.
	taskCreateProps := func() map[string]interface{} {
		return map[string]interface{}{
			"title":              str,
			"description":        taskDescriptionProp,
			"listId":             map[string]interface{}{"type": []string{"string", "null"}},
			"assigneeId":         map[string]interface{}{"type": []string{"string", "null"}},
			"projectId":          projectIDProp,
			"parentTaskId":       parentTaskIDProp,
			"acceptanceCriteria": acceptanceCriteriaProp,
			"criterionKey":       criterionKeyProp,
			"completionCriterion": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"EXECUTABLE", "VERIFICATION", "EVIDENCE_JUDGMENT"},
				"description": "The task's one normal completion criterion. EXECUTABLE uses acceptanceCommand plus acceptanceExpectedExitCode; VERIFICATION uses an independent task's verdict with completionPolicy VERIFICATION_PASSED; EVIDENCE_JUDGMENT uses one decision on the task's own submitted evidence. They are peer choices, not a fallback chain. Runner task creation always requires this explicit field; related command, policy, and verifier fields do not replace it.",
			},
			"completionCriterionOverrideReason": criterionOverrideReasonProp,
			"acceptanceCommand": map[string]interface{}{
				"type":        "string",
				"minLength":   1,
				"description": "The one EXECUTABLE shell acceptance command. Set it together with acceptanceExpectedExitCode; after the execution turn, the existing task session runs it and the server derives DONE/FAILED from the exit code without an LLM judgement. If one command is not enough, split the task.",
			},
			"acceptanceExpectedExitCode": map[string]interface{}{
				"type":        "integer",
				"description": "The exit code that derives DONE for acceptanceCommand. Only a typed EXITED result with a different actual code derives FAILED; timeout, cancellation, signal, start failure and infrastructure loss remain actionable. Set both fields together.",
			},
			"acceptanceTimeoutSeconds": map[string]interface{}{
				"type": "integer", "minimum": 1, "maximum": 86400,
				"description": "Requested EXECUTABLE wall-clock budget. Presence opts into v2 pre-spawn admission; omission keeps the N-1 legacy plan. Admission uses exactly this value and never clamps it.",
			},
			"acceptanceOwnerTimeoutCeilingSeconds": map[string]interface{}{
				"type": "integer", "minimum": 1, "maximum": 86400,
				"description": "Owner ceiling checked at admission. Omit to bind it to acceptanceTimeoutSeconds; a lower explicit value is REJECTED before spawn.",
			},
			"dueDate":  str,
			"provider": providerProp,
			"model":    modelProp,
			"dependsOnTaskIds": map[string]interface{}{
				"type":        "array",
				"items":       str,
				"description": "Prerequisite task ids this task waits on (each must be owned by the caller). The task is BLOCKED until every prerequisite is DONE, then runs. Use this instead of writing 'wait for X' preconditions into the description. Cannot form a cycle.",
			},
			"autoRunWhenReady": map[string]interface{}{
				"type":        "boolean",
				"description": "Once all prerequisites are DONE, auto-run this task without a manual start (default true). Needs an assignee bound to a runner. Set false to leave it OPEN for a human/agent to start. Ignored when there are no prerequisites.",
			},
			"completionPolicy": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"MANUAL", "ALL_CHILDREN_DONE", "VERIFICATION_PASSED"},
				"description": "How this task rolls up subtasks. MANUAL (default) performs no child aggregation; the declared completionCriterion decides DONE. ALL_CHILDREN_DONE derives completion when every direct subtask is DONE or CANCELLED and at least one is DONE — and reopens it if one is later reopened, added or fails, so a parent never claims more than its subtasks support. VERIFICATION_PASSED uses independent PASS verdict evidence. Direct status DONE is never a completion mechanism.",
			},
			"verifiesTaskId": map[string]interface{}{
				"type":        "string",
				"description": "File this task as a VERIFICATION of that task: it exists to check whether the named task actually did what it claims. This is what makes a check a structured relation instead of a naming convention — it is the precondition for task_update's `verdict`, and the only thing `completionPolicy: VERIFICATION_PASSED` counts. The subject must be owned by you, must not be this task, must not itself be a verification, and must be in the SAME project (a check filed across that line is counted by nobody). A verification is expected to run as its OWN session: concluding one from the session that ran the subject is refused.",
			},
			"supersedesTaskId": map[string]interface{}{
				"type": "string",
				"description": "The attempt this new task REPLACES, recorded in the same write that " +
					"creates it. The predecessor keeps the CANCELLED or FAILED it ended with — the " +
					"original outcome is the fact being preserved — and gains a pointer to this task " +
					"plus terminalReason SUPERSEDED, so \"who ended up doing this\" becomes a relation " +
					"a query can follow instead of a sentence in a description. Use this rather than " +
					"creating the replacement and linking it afterwards: the two-call version has a " +
					"window, and an attempt left in that window reads to every downstream gate as an " +
					"ordinary unfinished failure — this deployment re-dispatched one months later. " +
					"Refused if the predecessor is still open, belongs to another owner or another " +
					"project, or has already been replaced (two racing replacements give one winner " +
					"and one error, never a pointer that depends on timing).",
			},
			"failureSuccessorHandoff": map[string]interface{}{
				"type":        "object",
				"description": "The exact routed Failure Continuation this successor atomically takes over. Use only with supersedesTaskId and copy all four values from the FAILURE_CONTINUATION_ACTIONABLE opening. The server creates/adopts one current successor, advances its binding generation, rebinds downstream dependencies, resolves the continuation, and durably auto-dispatches a capable ownerless route. Replay the same object after a lost response; do not task_update or task_start afterwards.",
				"properties": map[string]interface{}{
					"obligationId":       str,
					"obligationRevision": map[string]interface{}{"type": "string", "pattern": "^[0-9a-f]{64}$"},
					"routeDecisionId":    str,
					"routeDecisionDigest": map[string]interface{}{
						"type": "string", "pattern": "^[0-9a-f]{64}$",
					},
				},
				"required":             []string{"obligationId", "obligationRevision", "routeDecisionId", "routeDecisionDigest"},
				"additionalProperties": false,
			},
			"labels": labelsProp,
		}
	}
	taskBatchItemProps := func() map[string]interface{} {
		props := taskCreateProps()
		// A failure takeover is one serialized current-binding decision, never one item in a
		// separately approved DAG batch. The server enforces the same rule for non-MCP callers.
		delete(props, "failureSuccessorHandoff")
		props["ref"] = map[string]interface{}{
			"type":        "string",
			"description": "A short label for this item, unique within the batch, so later items can depend on it via dependsOnRefs. Not stored — it only wires the batch together, and comes back on the created task so you can map it to the real id.",
		}
		props["dependsOnRefs"] = map[string]interface{}{
			"type":        "array",
			"items":       str,
			"description": "Refs of EARLIER items in this same batch that must finish before this one runs. Use this for prerequisites created by this call (their ids don't exist yet) and dependsOnTaskIds for tasks that already exist.",
		}
		props["verifiesRef"] = map[string]interface{}{
			"type":        "string",
			"description": "Ref of an EARLIER item in this same batch that this item VERIFIES — how a phase and the check on that phase land in one atomic call. Use verifiesTaskId instead for a subject that already exists; naming both is rejected. The item it points at must carry the same projectId as this one and must not itself be a verification. This is the pairing that makes a VERIFICATION_PASSED parent expressible: filed as two calls, the window between them is a parent that can never complete.",
		}
		props["parentRef"] = map[string]interface{}{
			"type":        "string",
			"description": "Ref of an EARLIER item in this same batch that this item is a PART OF — how a plan lands as a tree in one call, since the parent it names is being created by this very batch and has no id yet. Use parentTaskId instead for a parent that already exists; naming both is rejected, because it names two parents. The item it points at must carry the same projectId as this one (the project is never inherited). Membership, not ordering: dependsOnRefs decides when this item may run, parentRef only says what it is part of.",
		}
		return props
	}
	tools := []map[string]interface{}{
		{
			"name":        "task_list",
			"description": "List the caller's newest tasks, without their descriptions (task_get returns one task in full). Optionally filter by status, listId, projectId or labels. Rows carry projectId, parentTaskId and acceptanceCriteria, so which project a task belongs to, what it is part of, and what would settle it are readable without fetching each task.",
			"inputSchema": obj(map[string]interface{}{
				"status": status,
				"listId": str,
				"projectId": map[string]interface{}{
					"type": "string",
					"description": "Only tasks filed under this project — the read a project coordinator " +
						"wants, since every other filter here answers across all projects. Use project_get " +
						"for what the project is FOR (goal, acceptanceCriteria, instructions); this returns " +
						"the work filed under it. A project that does not exist, or belongs to somebody " +
						"else, lists as empty, exactly like any other filter matching nothing.",
				},
				"labels": map[string]interface{}{
					"type":        "array",
					"items":       str,
					"description": "Only tasks carrying ALL of these labels. Matched exactly, case included. Use task_labels first when the exact spelling of a label is not already known.",
				},
				"limit": map[string]interface{}{"type": "integer", "minimum": 1, "maximum": maxTaskListLimit, "description": fmt.Sprintf("Maximum tasks to return (default %d, server cap %d).", defaultTaskListLimit, maxTaskListLimit)},
			}),
		},
		{
			"name":        "task_labels",
			"description": "Every label in use with its own status breakdown (total/open/inProgress/done/failed/cancelled), newest work included. This is the tool for \"how far along is each batch\" — it answers for all labels in one call, where task_list would have to be run once per label. Optionally scope to one listId. Also the way to discover how labels are actually spelled before filtering on one.",
			"inputSchema": obj(map[string]interface{}{
				"listId": str,
			}),
		},
		{
			"name":        "task_get",
			"description": "Get one task with its comments and linked sessions.",
			"inputSchema": obj(map[string]interface{}{"taskId": taskIDProp}),
		},
		{
			"name":        "task_evidence_list",
			"description": "List the task's explicit structured completion-evidence revisions in stable task-local order. This reads the evidence ledger directly; comments, final replies and Session lifecycle state are not evidence.",
			"inputSchema": obj(map[string]interface{}{"taskId": taskIDProp}),
		},
		{
			"name":        "task_evidence_submit",
			"description": "Submit structured completion evidence as a first-class immutable fact from the current task Session. A retry key and canonical evidence digest replay the same revision; substantively changed evidence appends one. This does not write task.status, change Session state, add a comment or send a notification.",
			"inputSchema": obj(map[string]interface{}{
				"taskId": taskIDProp,
				"evidence": map[string]interface{}{
					"type":        "object",
					"description": "Structured facts supporting completion, such as commands, raw outputs, exit codes and artifact hashes. Object-key order is not significant; array order and string whitespace are.",
				},
				"idempotencyKey": map[string]interface{}{
					"type":        "string",
					"minLength":   1,
					"maxLength":   200,
					"description": "Stable identity reused for every transport retry of this submission.",
				},
			}, "evidence"),
		},
		{
			"name": "task_judge",
			"description": "Decide the task's one OPEN EVIDENCE_JUDGMENT request against the exact " +
				"evidence revision it is bound to. `requestId` and `evidenceDigest` must name that " +
				"current request and its digest; a superseded evidence version is refused rather " +
				"than silently redirected. `evidence` is the finding the decision rests on and may " +
				"not be blank — it is the whole audit for this conclusion, so state what you " +
				"checked and what it showed rather than that you approve. The same transaction " +
				"derives task.status = DONE, closes the request and clears its derived signal and " +
				"blocker; it writes no comment and sends no notification. This settles only a task " +
				"whose declared completionCriterion is EVIDENCE_JUDGMENT: EXECUTABLE is settled by " +
				"its command's exit code and VERIFICATION by an independent verifier's verdict.",
			"inputSchema": obj(map[string]interface{}{
				"taskId": taskIDProp,
				"requestId": map[string]interface{}{
					"type":        "string",
					"minLength":   1,
					"description": "The task's current OPEN EVIDENCE_JUDGMENT judgment request id.",
				},
				"evidenceDigest": map[string]interface{}{
					"type":        "string",
					"minLength":   64,
					"maxLength":   64,
					"description": "The 64-character sha256 digest that request is bound to.",
				},
				"evidence": map[string]interface{}{
					"type":        "string",
					"minLength":   1,
					"description": "The finding this judgment rests on. Non-blank; recorded verbatim.",
				},
			}, "requestId", "evidenceDigest", "evidence"),
		},
		{
			"name":        "task_attribution",
			"description": "Read one task's attribution boundary — five answers in one read. `owning`: the project this work COUNTS TOWARDS, with its title, Base62 id, status and acceptance epoch; that column is the only authoritative attribution there is. `discovery`: where the work was NOTICED — the project it was found in, the trigger event, the source task and the source session — carried as evidence and labelled `EVIDENCE_ONLY`, because finding work somewhere grants nothing about where you may file it. `acceptance`: the project's stated criteria that CITE this task, each with the verdict it reached, the epoch it was reached in, and whether that is still current — an old PASS stays readable and stops counting once the project is reopened. `crossing`: the declared cross-project crossing that touches this task, with the stable code and required action a writer meeting it is given. `blocker`: the attribution blocker holding this work up, with its code, its owner and the one sentence that would clear it. Every absent fact is null beside a reason, so \"no criterion cites this\" and \"this build cannot tell you\" read differently. Read it BEFORE writing where you are not certain the work belongs — the alternative is learning it from the refusal, which is after the decision was made.",
			"inputSchema": obj(map[string]interface{}{"taskId": taskIDProp}),
		},
		{
			"name": "project_get",
			"description": "Read one project's durable context: its goal, what would settle that " +
				"the goal was reached (acceptanceCriteria), how the work is to be done " +
				"(instructions), its status, the session and workspace it is coordinated from, and " +
				"how its tasks are distributed (_count and tasksByStatus). This is what a project " +
				"coordinator works FROM — read it before deciding what to file or whether the work " +
				"is finished, because none of it is repeated in a task's description. Returns the " +
				"shape of the project, not its tasks: use task_list for those. Reads the projects " +
				"of the account this runner belongs to; write these same fields with " +
				"project_create and project_update.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project to read, as shown in its web UI URL (/projects/<id>).",
				},
			}, "projectId"),
		},
		{
			"name":        "project_crossings",
			"description": "Read every declared cross-project crossing this project is an end of, in BOTH directions — the ones asking to move work INTO it and the ones asking to move work OUT. Each row names the two ends by title and by id, what the crossing is about, its state (PENDING / APPROVED / DENIED / APPLIED), the crossing key that identifies the MOVE rather than the row, and when it was asked, answered and expires. Read it when a write was refused CROSS_PROJECT_APPROVAL_REQUIRED or APPROVAL_PENDING: that refusal is about a row in this list, and this is how you learn whether the question is still waiting, was refused, or has already been spent. There is deliberately no tool that ANSWERS one — the approver of a cross-project crossing is the account owner, never the target project's coordinator, because one agent accepting work on another goal's behalf is precisely the failure this boundary exists to prevent. Say what is waiting and on whom; do not answer it.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project to read, as shown in its web UI URL (/projects/<id>).",
				},
				"state": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"PENDING", "APPROVED", "DENIED", "APPLIED"},
					"description": "Only crossings in that state. Omit for all of them.",
				},
			}, "projectId"),
		},
		{
			"name":        "project_reopen_impact",
			"description": "Read what reopening a settled project would COST: the acceptance epoch it is in, the one a reopen would start, how many acceptance attempts stop being current when it does, whether its DONE rests on the pre-acceptance compatibility stamp, and the acknowledgement a reopen has to name. Read it when a write was refused PROJECT_REOPEN_REQUIRED. A reopen is not an undo — it starts a NEW acceptance epoch and every PASS the project has stops being current, still readable and no longer a claim about the world the project is in — so an account owner being asked for one should be asked with those numbers rather than with \"can you reopen this\". Read only: reopening is the owner's door, and a coordinator does not reopen a settled project it wants to write into.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project to read, as shown in its web UI URL (/projects/<id>).",
				},
			}, "projectId"),
		},
		{
			"name": "merge_receipt",
			"description": "Record that a session's branch was merged, for a merge Orbit did not " +
				"perform — the `git merge --ff-only` an agent runs in its own worktree, which is how " +
				"branches actually land. Without it the control plane has nothing: merge status blank " +
				"and \"already in main\" false, permanently, because the only code that ever writes " +
				"those is Orbit's own Merge button. The receipt is append-only and names the session, " +
				"its task, its project, and every SHA the claim can be re-checked against. Recording " +
				"the same merge twice is a no-op: the second call returns the first receipt. Give " +
				"FULL 40-character object names — an abbreviated SHA is refused, because it resolves " +
				"against a repository that has since gained objects and can silently come to mean a " +
				"different commit. `rebaseBaseSha` is the field people skip and the one that decides " +
				"whether the tests that passed were about this tree: omit it only if the source was " +
				"genuinely not rebased. This is not an orchestration power and needs no orchestration " +
				"grant: it records work that already happened, inside your own tenant.",
			"inputSchema": obj(map[string]interface{}{
				"sessionId": map[string]interface{}{
					"type":        "string",
					"description": "The session whose branch was merged; defaults to the current session.",
				},
				"result": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"MERGED", "ALREADY_MERGED", "CONFLICT", "ERROR"},
					"description": "MERGED moved the target. ALREADY_MERGED is a RESULT, not a no-op — it is the answer when the target already contained this work, which is the external fast-forward case and every re-run. CONFLICT names the paths in `conflicts`; ERROR is everything else.",
				},
				"sourceSha":       map[string]interface{}{"type": "string", "description": "The full 40-character tip that was merged."},
				"targetBranch":    map[string]interface{}{"type": "string", "description": "The branch it was merged into."},
				"sourceBranch":    map[string]interface{}{"type": "string", "description": "Defaults to the session's own recorded branch."},
				"targetShaBefore": map[string]interface{}{"type": "string", "description": "The target tip before the merge."},
				"targetShaAfter":  map[string]interface{}{"type": "string", "description": "The target tip after it. REQUIRED for result MERGED: a merge that cannot say where the target ended up is a claim, not a receipt."},
				"rebaseBaseSha":   map[string]interface{}{"type": "string", "description": "The base the source was rebased onto before this merge was computed. Omitted means it was not rebased."},
				"conflicts": map[string]interface{}{
					"type": "array", "items": map[string]interface{}{"type": "string"},
					"description": "Paths git reported as conflicting. Only for result CONFLICT.",
				},
				"message": map[string]interface{}{"type": "string", "description": "Git's message, for a conflict or an error."},
			}, "result", "sourceSha", "targetBranch"),
		},
		{
			"name": "merge_receipts",
			"description": "List the merges recorded against a session's branch, newest first: what " +
				"was merged, into what, the target tip before and after, the base the source was " +
				"rebased onto, the result and any conflicting paths. The durable answer to \"did this " +
				"session's work land\", which the session's own merge status cannot give — that column " +
				"is the Merge button's live state and is deliberately cleared when a session resumes.",
			"inputSchema": obj(map[string]interface{}{
				"sessionId": map[string]interface{}{
					"type":        "string",
					"description": "The session to read; defaults to the current session.",
				},
				"limit": map[string]interface{}{"type": "integer", "description": "Maximum receipts to return (default 50, cap 200)."},
			}),
		},
		{
			"name": "project_acceptance",
			"description": "Read the evidence a project's DONE would be checked against, and " +
				"whether it would be allowed right now. A comment saying the tests passed is not " +
				"evidence this server can check; a run in this record is. Returns: the stated " +
				"structured checklist (legacy text is conservatively backfilled one non-blank " +
				"physical line per item), which an acceptance run must answer item for item; " +
				"acceptanceDigest, the identity of the unordered criterion propositions and newest " +
				"merge observation per requirement; every evidence version with the current " +
				"per-criterion projection and its append-only conclusion events; what each target " +
				"branch was last observed to CONTAIN and at which " +
				"refGeneration; the append-only audit of runs opened and concluded, DONEs bound " +
				"and refused, and every reopen with the fact that caused it; the current " +
				"revision-bearing criteriaDigest; and doneGate — " +
				"allowed, or the code and sentence the write would be refused with " +
				"(ACCEPTANCE_MISSING when there is no usable PASS, ACCEPTANCE_BLOCKED when a blocker " +
				"or unresolved verification failure is still open).",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project to read, as shown in its web UI URL (/projects/<id>).",
				},
			}, "projectId"),
		},
		{
			"name": "project_acceptance_run",
			"description": "Evaluate a project's current acceptance evidence version. The operation " +
				"is idempotent: concurrent evaluators of the same criteria and merge evidence receive " +
				"the same immutable version row and checklist. Evidence changes advance the version " +
				"automatically; prior conclusion events carry forward until a newer-version event " +
				"refutes them. A project that states no acceptance criteria is " +
				"refused, because an acceptance with nothing to check would pass by having nothing " +
				"to fail.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project to run acceptance on, as shown in its web UI URL.",
				},
			}, "projectId"),
		},
		{
			"name": "project_acceptance_verdict",
			"description": "Append evidence-backed conclusion events for the EVIDENCE_JUDGMENT criteria " +
				"in a project acceptance version. EXECUTABLE and VERIFICATION are evaluated only from " +
				"their declared durable inputs and reject a fallback human verdict. Address each human " +
				"criterion by criterionId (its stable structured identity), " +
				"ordinal (its position in the snapshot), or criterionKey (legacy content identity). " +
				"Every EVIDENCE_JUDGMENT criterion must be answered: a missing one is " +
				"refused, because a project-level PASS is the conjunction of them and one nobody " +
				"checked is not a pass. The current verdict is DERIVED and cannot be " +
				"supplied — all PASS is PASS, any FAIL is FAIL, anything else is INCONCLUSIVE — " +
				"which is the whole difference between this and writing 'all green' in a task " +
				"comment. Put real evidence in each entry's `evidence`: the observation, output, " +
				"artifact hash, and environment. Every event records who concluded, when, and the evidence " +
				"version it was based on. A judgment-session or machine-attributed call may refute; " +
				"PASS must use the owner-attributed channel. That is workflow and audit provenance, " +
				"not proof of human presence.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project whose evidence version is being concluded against.",
				},
				"runId": map[string]interface{}{
					"type":        "string",
					"description": "The evidence version to conclude against, as returned by project_acceptance_run.",
				},
				"criteria": map[string]interface{}{
					"type": "array",
					"description": "One entry per EVIDENCE_JUDGMENT criterion: {criterionId, ordinal or criterionKey, " +
						"verdict: PASS|FAIL|INCONCLUSIVE, summary, evidence, evidenceTaskId, " +
						"evidenceSessionId}.",
					"items": map[string]interface{}{"type": "object"},
				},
			}, "projectId", "runId", "criteria"),
		},
		{
			"name": "project_merge_evidence",
			"description": "Record what a target branch was observed to CONTAIN — the merge half " +
				"of a project's acceptance evidence. Hash the content you actually read (a " +
				"normalized `git grep` result, a blob or tree digest, a rendered diff), never " +
				"`git branch --contains`: after a squash merge that answer is a guaranteed false " +
				"negative while the content is plainly there. Same content as the last " +
				"observation and only the observation time moves; different content writes a new " +
				"row one refGeneration up, which is what makes 'the branch changed and changed " +
				"back' visible to a database that cannot lock a git ref. Different content advances " +
				"the evidence version automatically and re-evaluates the current acceptance standing " +
				"without a manual reopen.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project this observation belongs to.",
				},
				"requirementId": map[string]interface{}{
					"type":        "string",
					"description": "What was required, in the words the acceptance criteria use.",
				},
				"targetBranch": map[string]interface{}{
					"type":        "string",
					"description": "Where it had to land, e.g. main or feat/project.",
				},
				"contentHash": map[string]interface{}{
					"type":        "string",
					"description": "sha256 of the observed content, 64 hex characters.",
				},
				"source": map[string]interface{}{
					"type":        "string",
					"description": "Who observed it. Defaults to MERGE_EVIDENCE_WRITER.",
				},
				"detail": map[string]interface{}{
					"type":        "object",
					"description": "The raw observation behind the hash: the command, its output, the blob ids.",
				},
			}, "projectId", "requirementId", "targetBranch", "contentHash"),
		},
		{
			"name": "project_create",
			"description": "Create a project in the account this runner belongs to — the durable " +
				"context a whole body of work is carried out from, as opposed to a task, which is " +
				"one piece of that work. Use it when you are asked to set up or plan out a body of " +
				"work: state what it is trying to achieve (goal), what would settle that the goal " +
				"was reached (acceptanceCriteriaItems), and how the work is to be done (instructions). " +
				"You have the authority to write these fields — record what you were asked for " +
				"rather than waiting for somebody to type it in. Do not wait to be asked, either: " +
				"when what you are looking at spans more than one session — it will not finish in " +
				"this conversation, it will exhaust your context, or it runs over days — or breaks " +
				"into steps that depend on one another, or wants several agents on different parts " +
				"of it, then PROPOSE recording it as a project before you start working. Say why, " +
				"because the reason is the whole point: a project moves the plan out of this " +
				"conversation and into the task graph, so when this session ends or your context " +
				"runs out the plan is still there and whoever picks it up next does not have to " +
				"re-derive it. Propose, then wait for a yes — this call is the answer to that " +
				"question, not a way around asking it. A single reported bug can still have this " +
				"shape; one bug does not imply one task. Do not create a standalone task as a " +
				"substitute while waiting for the answer. The " +
				"project starts OPEN and holds no tasks — file them afterwards with task_create / " +
				"task_create_batch passing its projectId, which is what connects the work to what " +
				"it is for. Created from inside a session, the project is bound to THIS session " +
				"as its coordinator, in the same write that creates it, along with the workspace " +
				"this session runs in — so opening the project's coordinator later comes back to " +
				"this conversation rather than starting a fresh one that knows none of it. There " +
				"is nothing to pass and nothing to choose; created outside a session there is no " +
				"such binding. One session coordinates at most one project: recording a second " +
				"one from this same conversation is refused, and nothing is created. Existing " +
				"legacy acceptanceCriteria text remains readable through project_get and writable " +
				"through the old user/JWT API compatibility path. It is not an agent fallback: this " +
				"runner tool refuses it because it would silently create EVIDENCE_JUDGMENT; every new " +
				"item must declare its completionCriterion explicitly.",
			"inputSchema": obj(map[string]interface{}{
				"title": map[string]interface{}{
					"type":        "string",
					"description": "What this body of work is called.",
				},
				"goal": map[string]interface{}{
					"type":        "string",
					"description": "What this project is trying to achieve, in at most 4,000 characters.",
				},
				"acceptanceCriteriaItems": projectCriteriaCreateProp,
				"instructions": map[string]interface{}{
					"type":        "string",
					"description": "How this project's work is to be done: standing guidance that applies across its tasks. Max 10,000 characters.",
				},
			}, "title"),
		},
		{
			"name": "project_update",
			"description": "Update a project in the account this runner belongs to: rename it, " +
				"revise what it is trying to achieve (goal), what would settle that the goal was " +
				"reached (acceptanceCriteriaItems) or how the work is to be done (instructions), and " +
				"cancel or reopen work. You have authority to write these configuration fields. " +
				"Sending acceptanceCriteriaItems replaces the criteria in force immediately: it is " +
				"the standard this project is judged by, so read project_get first and send the " +
				"complete set you mean. " +
				"Existing legacy acceptanceCriteria text remains readable through project_get and " +
				"writable through the old user/JWT API compatibility path. It is not an agent " +
				"fallback: this runner tool refuses it because it would silently create " +
				"EVIDENCE_JUDGMENT; use acceptanceCriteriaItems with an explicit completionCriterion " +
				"on every item, and [] to clear the set. A " +
				"project's one-shot JUDGMENT session " +
				"(the one a committed fact opens, not the user-origin conversation) cannot " +
				"write acceptance criteria. Direct status DONE is refused for every actor: it is " +
				"produced automatically only when the exact confirmed standard set has PASS for " +
				"every peer criterion. Only the fields you pass are sent, so " +
				"revising the goal never blanks the instructions: omit a field to leave it " +
				"untouched, pass a string to replace it, pass null to clear it. CANCELLED says the " +
				"goal will not be pursued; OPEN reopens it. Read project_get first when the current context is not " +
				"already known — each prose field is a whole-field replacement, not an append.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The project to update, as shown in its web UI URL (/projects/<id>).",
				},
				"title": str,
				"goal": map[string]interface{}{
					"type":        []string{"string", "null"},
					"description": "Replace what this project is trying to achieve (max 4,000 characters), or null to leave it with no stated goal.",
				},
				"acceptanceCriteriaItems": projectCriteriaUpdateProp,
				"instructions": map[string]interface{}{
					"type":        []string{"string", "null"},
					"description": "Replace how this project's work is to be done (max 10,000 characters), or null to leave it with no standing instructions.",
				},
				"status": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"OPEN", "CANCELLED"},
					"description": "OPEN reopens work; CANCELLED abandons it. DONE is derived and cannot be supplied.",
				},
				"expectedConfigRevision": map[string]interface{}{
					"type": "string",
					"description": "The configRevision you read from project_status, as a " +
						"compare-and-swap: the write commits only if the project is still at that " +
						"revision, and is refused with STALE_CONFIG_REVISION otherwise, with " +
						"nothing written. Pass it when you read the project first and are acting " +
						"on what you read — the owner may have changed its coordination settings " +
						"since, and being told beats silently overwriting a decision you did not " +
						"see. Omit it if you did not read one; the write then behaves as it always " +
						"has.",
				},
			}, "projectId"),
		},
		{
			"name": "project_delete",
			"description": "Permanently delete an empty project in the account this runner belongs " +
				"to. This cannot be undone. A project that still holds tasks is refused atomically: " +
				"none of those tasks is deleted or detached, because the project records what each " +
				"task is for. Move them to another project or delete them first.",
			"inputSchema": obj(map[string]interface{}{
				"projectId": map[string]interface{}{
					"type":        "string",
					"description": "The empty project to permanently delete, as shown in its web UI URL (/projects/<id>).",
				},
			}, "projectId"),
		},
		{
			"name":        "task_dependency_graph",
			"description": "Read the multi-level upstream dependency DAG for a task before changing its ordering. Returns the focus task, its transitive prerequisites, and directed prerequisite-to-dependent edges; taskId defaults to the current task. The server bounds traversal and reports when the result is truncated.",
			"inputSchema": obj(map[string]interface{}{
				"taskId":   taskIDProp,
				"maxDepth": map[string]interface{}{"type": "integer", "minimum": 1, "maximum": 32, "description": "Maximum prerequisite levels to traverse (default 8, server cap 32)."},
				"maxNodes": map[string]interface{}{"type": "integer", "minimum": 1, "maximum": 500, "description": "Maximum task nodes to return (default 100, server cap 500)."},
			}),
		},
		{
			"name":        "task_dependency_add",
			"description": "Add one dependency edge: taskId waits for dependsOnTaskId. The server rejects cross-owner tasks, self-dependencies, duplicate edges, and cycles. Prefer this granular edit after reading task_dependency_graph when preserving every other edge. Point the edge at the SUBJECT, not at its verification task: waiting until A is verified is dependsOnTaskId=A, and once anything checks A the server holds that edge until A's latest check has actually PASSED — a check that finished DONE with a FAIL verdict does not release it, and filing a new check closes the question again. An edge naming the check resolves to the same gate, so older plans keep working; it just reads as being about one run.",
			"inputSchema": obj(map[string]interface{}{
				"taskId": taskIDProp,
				"dependsOnTaskId": map[string]interface{}{
					"type":        "string",
					"description": "Prerequisite task id that must finish before taskId can run.",
				},
			}, "dependsOnTaskId"),
		},
		{
			"name":        "task_dependency_remove",
			"description": "Idempotently remove one dependency edge from taskId to dependsOnTaskId, leaving every other edge unchanged; an already-absent edge is a no-op. Read task_dependency_graph first when the surrounding DAG is not already known.",
			"inputSchema": obj(map[string]interface{}{
				"taskId": taskIDProp,
				"dependsOnTaskId": map[string]interface{}{
					"type":        "string",
					"description": "Prerequisite task id whose edge should be removed from taskId.",
				},
			}, "dependsOnTaskId"),
		},
		{
			"name":        "task_create",
			"description": "Create ONE task (attributed to this agent). Before using it for newly discovered work, apply project_create's scope rule: a single reported bug can still span more than one session or require dependent phases. In that case PROPOSE a project and wait for a yes; do not park the work as a standalone task while waiting. Creating several related tasks after that decision? Use task_create_batch instead — it writes them, and the dependency edges between them, in a single atomic call. This only records the task; call task_start when it should run immediately. Always write `description` as a self-contained, executable prompt an agent can act on without prior context (background, files involved, steps). assigneeId defaults to this agent when omitted (pass null to leave it unassigned). assigneeId/listId/projectId/parentTaskId must be owned by the caller; dueDate is an ISO date string. Pass `projectId` to file the task under a project — orthogonal to listId, which decides dispatch policy, where the project states what the work is for. Pass `parentTaskId` to make it a subtask of an existing task, which must be in the same project as this one — a subtask of a project's task normally passes both, since the project is not inherited from the parent. Pass `acceptanceCriteria` to state what would settle that this task is done — the observable result a reader can verify, as opposed to `description`, which says what work to perform. Always declare completionCriterion explicitly; EVIDENCE_JUDGMENT is available but never inferred by this runner write, and related command, policy, or verifier fields do not replace the declaration. If TASK_CRITERION_SHAPE_ADVICE questions the chosen criterion, adopt its suggestedCriterion or retry with a non-blank completionCriterionOverrideReason, which is stored for later readers. To order work, pass `dependsOnTaskIds` to declare prerequisites natively — do NOT bake ordering into the description as manual preconditions. Prerequisites name the SUBJECT of the work, not its verification task — the server already holds a dependency on a verified task until its check PASSES.",
			"inputSchema": func() map[string]interface{} {
				return obj(taskCreateProps(), "title", "completionCriterion")
			}(),
		},
		{
			"name":        "task_create_batch",
			"description": fmt.Sprintf("Create up to %d tasks in one atomic call (attributed to this agent) — the batch form of task_create, and the right tool whenever a plan produces more than one task. Nothing is written unless every item is valid. Every item declares completionCriterion explicitly; EVIDENCE_JUDGMENT is available but never inferred from omission, and a verifier relation (including verifiesRef), executable pair, or completion policy does not replace that declaration. Items are created in order, and a later item can depend on an earlier one WITHOUT knowing its id: give the earlier item a `ref` and list that ref in the later item's `dependsOnRefs` (e.g. [{ref:\"s0\",…},{ref:\"s1\",dependsOnRefs:[\"s0\"]}]). `dependsOnTaskIds` still takes ids of tasks that already exist; the two combine. Each item takes the same fields as task_create, `projectId` and `acceptanceCriteria` included, so a plan for one project files every task it produces under that project in the same call, each carrying what would settle it. Items nest the same way they order: `parentRef` names an EARLIER item's ref as this item's PARENT, so a plan lands as a tree — its steps written as parts of the piece of work being planned, in the same call that creates it. `parentTaskId` stays for hanging items under a task that ALREADY exists (same project as the item); one item cannot carry both. The two ref fields answer different questions: `dependsOnRefs` is when an item may run, parentRef is what it is a part of. Returns the created tasks in input order, each echoing its `ref`. Tasks are only recorded — call task_start for one that should run now. This BLOCKS until a human approves the batch: they see what would be created and, above all, how many of it starts running within the minute. Send the batch you actually mean — a rejected one costs the whole call, not one item.", maxTaskBatchCreate),
			"inputSchema": obj(map[string]interface{}{
				"tasks": map[string]interface{}{
					"type":     "array",
					"minItems": 1,
					"maxItems": maxTaskBatchCreate,
					"items": func() map[string]interface{} {
						return obj(taskBatchItemProps(), "title", "completionCriterion")
					}(),
					"description": "The tasks to create, in dependency order (prerequisites first).",
				},
				"dryRun": map[string]interface{}{
					"type":        "boolean",
					"description": "Judge this plan and write NONE of it — not one task, and not even the approval question a declared cross-project crossing would otherwise file. Answers with `plan` (where every item would land: project id, title, status and acceptance epoch), `findings` (every check that refuses or warns, in a fixed order) and `wouldWrite` (how many rows the real call would add). Use it whenever you are not certain which project a plan files into: a refusal tells you which item is wrong, and this tells you where the items that are RIGHT would go. It asks nobody for approval, because it starts nothing.",
				},
			}, "tasks"),
		},
		{
			"name":        "task_update",
			"description": "Update a task's fields. Direct status DONE is refused for every actor; the refusal names the declared EXECUTABLE, VERIFICATION, or EVIDENCE_JUDGMENT path. FAILED remains writable as a run's conservative self-report. When setting `description`, write it as a self-contained, executable prompt an agent can act on without prior context (background, files involved, steps) — what would PROVE the task done goes in `acceptanceCriteria`, not into the prompt. `acceptanceCriteria` is editable for the whole life of the task, which is where it usually gets written: omit it to leave the current criteria untouched, pass a string to replace them, pass null to clear them. It states what settles THIS task, not the project it is filed under (project_get). `parentTaskId` moves this task under another one you own (same project, never itself or one of its own subtasks) — membership only, with no effect on when it runs. Pass null for assigneeId/listId/parentTaskId/dueDate/provider/model to clear them.",
			"inputSchema": obj(map[string]interface{}{
				"taskId":             taskIDProp,
				"title":              str,
				"description":        taskDescriptionProp,
				"status":             taskUpdateStatus,
				"listId":             map[string]interface{}{"type": []string{"string", "null"}},
				"assigneeId":         map[string]interface{}{"type": []string{"string", "null"}},
				"parentTaskId":       updateParentTaskIDProp,
				"dueDate":            map[string]interface{}{"type": []string{"string", "null"}},
				"provider":           providerProp,
				"model":              modelProp,
				"acceptanceCriteria": updateAcceptanceCriteriaProp,
				"completionCriterion": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"EXECUTABLE", "VERIFICATION", "EVIDENCE_JUDGMENT"},
					"description": "Replace the task's one normal completion criterion. Omit to preserve it; a criterion cannot be cleared. EXECUTABLE, VERIFICATION and EVIDENCE_JUDGMENT are peers, not an escalation order.",
				},
				"acceptanceCommand": map[string]interface{}{
					"type":        []string{"string", "null"},
					"description": "The one EXECUTABLE shell acceptance command. Set it together with acceptanceExpectedExitCode; null/null clears executable acceptance. Omit both to preserve them. One command only — split the task if that is insufficient.",
				},
				"acceptanceExpectedExitCode": map[string]interface{}{
					"type":        []string{"integer", "null"},
					"description": "The exit code that mechanically derives DONE. Only typed EXITED can be compared; all non-exit termination kinds keep the goal actionable. Set or clear it together with acceptanceCommand.",
				},
				"acceptanceTimeoutSeconds": map[string]interface{}{
					"type": []string{"integer", "null"}, "minimum": 1, "maximum": 86400,
					"description": "Replace the requested v2 budget; null returns to legacy/N-1 acceptance, omission preserves it.",
				},
				"acceptanceOwnerTimeoutCeilingSeconds": map[string]interface{}{
					"type": []string{"integer", "null"}, "minimum": 1, "maximum": 86400,
					"description": "Replace the owner ceiling. It is negotiated and never used as a silent clamp.",
				},
				"dependsOnTaskIds": map[string]interface{}{
					"type":        "array",
					"items":       str,
					"description": "Complete replacement for this task's prerequisite ids. Omit to leave dependencies unchanged; pass [] to clear all prerequisites. Each id must be owned by the caller, and the replacement cannot form a cycle.",
				},
				"autoRunWhenReady": map[string]interface{}{
					"type":        "boolean",
					"description": "Once all prerequisites are DONE, auto-run this task without a manual start. Needs an assignee bound to a runner.",
				},
				"completionPolicy": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"MANUAL", "ALL_CHILDREN_DONE", "VERIFICATION_PASSED"},
					"description": "How this task rolls up subtasks. MANUAL (default) performs no child aggregation; the declared completionCriterion decides DONE. ALL_CHILDREN_DONE derives completion when every direct subtask is DONE or CANCELLED and at least one is DONE — and reopens it if one is later reopened, added or fails. VERIFICATION_PASSED uses independent PASS verdict evidence. Direct status DONE is never a completion mechanism. Switching back to MANUAL stops child recomputation without undoing what it last concluded.",
				},
				"verifiesTaskId": map[string]interface{}{
					"type":        []string{"string", "null"},
					"description": "The task this one exists to check. Omit to leave the relation alone, null to detach it, an id to point this task at that subject — the same rules as on task_create. Refused once this verification has concluded anything: the consequences already applied name the subject they were about, so re-pointing it afterwards would leave them asserting something about a task this check no longer verifies. File a new verification instead.",
				},
				"verdict": map[string]interface{}{
					"type":        []string{"string", "null"},
					"enum":        []interface{}{"PASS", "FAIL", "INCONCLUSIVE", nil},
					"description": "This VERIFICATION task's conclusion about the task it verifies. Only a task with verifiesTaskId set can carry one. Omit to leave it alone, null to revoke it — revoking a PASS reopens a subject that VERIFICATION_PASSED had completed.",
				},
				"labels": map[string]interface{}{
					"type":        "array",
					"items":       str,
					"maxItems":    maxTaskLabels,
					"description": "Complete replacement for this task's labels. Omit to leave them unchanged; pass [] to clear them all.",
				},
				"supersededByTaskId": map[string]interface{}{
					"type":        []string{"string", "null"},
					"description": "The later attempt that took this one's place. This is what makes \"we re-ran it from scratch\" a relation instead of a sentence in a comment: it names the successor, so a reader of the cancelled attempt can follow the chain to whoever ended up doing the work, and a list can tell an attempt that was REPLACED from one that was simply dropped. Only a CANCELLED or FAILED task may name one, the successor must be owned by you and in the SAME project, and the chain may not close a loop. It writes nothing to `status` — the original outcome is the fact being preserved, not the one being tidied away. Omit to leave the link alone, null to unlink.",
				},
				"terminalReason": map[string]interface{}{
					"type":        []string{"string", "null"},
					"enum":        []interface{}{"SUPERSEDED", "ABANDONED", nil},
					"description": "Why this task stopped, when its status alone does not say. Setting supersededByTaskId implies SUPERSEDED and needs no second spelling; ABANDONED is the other case — dropped on purpose, with nothing replacing it. FAILED and CANCELLED are not values here because they are already `status`.",
				},
			}),
		},
		{
			"name":        "task_delete",
			"description": "Permanently delete a task. This cannot be undone. Comments and dependency edges are deleted; finished sessions are retained and detached from the task, but a run still in flight is stopped — with the task gone it has no way left to finish. taskId defaults to the current task.",
			"inputSchema": obj(map[string]interface{}{"taskId": taskIDProp}),
		},
		{
			"name":        "task_start",
			"description": "Start a task immediately on its assigned agent. Creates or resumes the task-linked session and queues it for the assignee's runner. The task must have an assignee bound to a runner and all prerequisites must be complete. Returns the session id; taskId defaults to the current task.",
			"inputSchema": obj(map[string]interface{}{"taskId": taskIDProp}),
		},
		{
			"name":        "task_comment",
			"description": "Add a comment to a task (attributed to this agent).",
			"inputSchema": obj(map[string]interface{}{"taskId": taskIDProp, "body": str}, "body"),
		},
		{
			"name":        "tasklist_list",
			"description": "List the caller's task lists (groups) with task counts.",
			"inputSchema": obj(map[string]interface{}{}),
		},
		{
			"name":        "tasklist_create",
			"description": "Create a task list (group).",
			"inputSchema": obj(map[string]interface{}{"title": str}, "title"),
		},
		{
			"name": "tasklist_get",
			"description": "Get one task list's dispatch policy and progress: its standing instructions, " +
				"paused flag, concurrency cap, foreman settings, task counts by status, how many " +
				"sessions are live, and when it last started anything. Returns the shape of the list, " +
				"not its tasks — use task_list for those. `failuresByCause` attributes this list's " +
				"failed runs to what actually broke, so the right lever gets pulled: `quota` means " +
				"wait or switch provider, `infrastructure` means a runner was down, `contentFilter` " +
				"means the request itself was refused, `unattributed` needs a human. Note that none " +
				"of these is fixed by rewriting instructions — check the attribution before " +
				"concluding a campaign has a prompt problem.",
			"inputSchema": obj(map[string]interface{}{"listId": str}, "listId"),
		},
		{
			"name": "tasklist_update",
			"description": "Change a task list's dispatch policy. `instructions` are standing instructions " +
				"spliced into every task run's prompt in this list, so one write changes how every " +
				"task not yet started will be run — prefer it over editing task descriptions one by " +
				"one. `paused` stops dispatch without touching runs already in flight. " +
				"`maxConcurrent` caps how many of this list's tasks run at once. Send only the fields " +
				"you mean to change, and a `note` saying why: every change is recorded as a revision " +
				"attributed to this agent and session, and a human can restore an earlier one.",
			"inputSchema": obj(map[string]interface{}{
				"listId":              str,
				"title":               str,
				"instructions":        str,
				"paused":              map[string]interface{}{"type": "boolean"},
				"verifyOnDone":        map[string]interface{}{"type": "boolean"},
				"maxConcurrent":       map[string]interface{}{"type": "integer"},
				"foremanWorkspaceId":  str,
				"foremanStallMinutes": map[string]interface{}{"type": "integer"},
				"note":                str,
			}, "listId"),
		},
		{
			"name": "tasklist_propose_dag",
			"description": "Propose a batch of dependency changes to a list's DAG, for a human to " +
				"approve. Use this to restructure — re-point prerequisites, parallelise a chain, " +
				"insert a blocking task — instead of task_dependency_add/remove one edge at a time: " +
				"the batch is previewed, approved and applied as one unit, so dispatch never sees a " +
				"half-rewritten graph and starts the wrong work. This BLOCKS until the human decides. " +
				"They see what you are writing plus what results from it — above all which tasks " +
				"become runnable, because those start within the minute. `note` is what they judge " +
				"it by: say what the restructure is for, not what the edges are.",
			"inputSchema": obj(map[string]interface{}{
				"listId": str,
				"ops": map[string]interface{}{
					"type":        "array",
					"description": "Each edge to add or remove. `taskId` waits on `dependsOnTaskId`. The dependent must be in this list; the prerequisite may be anywhere.",
					"items": obj(map[string]interface{}{
						"op":              map[string]interface{}{"type": "string", "enum": []string{"add", "remove"}},
						"taskId":          str,
						"dependsOnTaskId": str,
					}, "op", "taskId", "dependsOnTaskId"),
				},
				"note": str,
			}, "listId", "ops"),
		},
		{
			"name": "tasklist_delete",
			"description": "Delete a task list. The list's tasks are NOT deleted — they are detached and " +
				"become listless, keeping their assignees, dependencies and sessions; what is destroyed " +
				"is the grouping, its standing instructions, and its policy revisions. This cannot be " +
				"undone. To stop a list from dispatching without discarding any of that, set `paused` " +
				"with tasklist_update instead.",
			"inputSchema": obj(map[string]interface{}{"listId": str}, "listId"),
		},
		{
			"name": "provider_list",
			"description": "List the provider slugs `provider` accepts here — the built-in engines (builtin true) " +
				"plus the ones configured on this account, each with the runtime it borrows and the models it " +
				"offers. Read this before pinning a `provider` on a task or session: a configured provider's " +
				"slug is derived from its label, not chosen, so it cannot be guessed from the vendor's name, " +
				"and a slug that is not on this list is refused with \"provider not available\".",
			"inputSchema": obj(map[string]interface{}{}),
		},
		{
			"name": "notify",
			"description": "Alert the human this session belongs to, on their phone and Mac, with a line you write. " +
				"For the two moments a transcript cannot cover: you need something only they can give (a decision, a " +
				"credential, an answer) and are otherwise stuck, or the thing they said they were waiting for is done. " +
				"Say what happened and what you need in one sentence — it is read on a lock screen, and anything past " +
				"~200 characters is cut. They can reply straight from the notification, which arrives in this session. " +
				"NOT for progress updates, step-by-step narration, or anything they will see when they next look: this " +
				"interrupts a person, and one that did not need to be sent teaches them to ignore the next one. " +
				"At most one per session per minute. Read the result rather than assuming it landed — `delivered` is " +
				"false with a `reason` when they have no device registered, have turned these off, or were just " +
				"alerted; nothing is lost when it does (your message is still in the transcript), but nobody was told, " +
				"so keep going rather than wait for a reply that isn't coming.",
			"inputSchema": obj(map[string]interface{}{
				"message": map[string]interface{}{
					"type":        "string",
					"description": "The line to show. The session's title is already the alert's heading, so don't restate it — say only what happened or what you need.",
				},
			}, "message"),
		},
	}
	if includeOrchestration {
		sessionIDProp := map[string]interface{}{"type": "string", "description": "Target session id."}
		sessionStatus := map[string]interface{}{"type": "string", "enum": []string{"PENDING", "RUNNING", "AWAITING_INPUT", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"}}
		// Agent config shared by agent_create/agent_update. env is stored (and injected into the
		// engine process) as a flat string map, so the whole map is replaced on every write.
		envProp := map[string]interface{}{
			"type":                 "object",
			"additionalProperties": str,
			"description":          "Environment variables injected into the agent's engine process, as a flat string→string map. REPLACES the whole map. Existing values are intentionally secret and are not returned by agent_list, so provide the complete desired map.",
		}
		mergeTargetProp := map[string]interface{}{
			"type":        "string",
			"description": "Branch this agent's sessions merge into by default. Omit to leave the runner's auto-detect (main, else master).",
		}
		repoURLProp := map[string]interface{}{
			"type":        "string",
			"maxLength":   2048,
			"description": "Git remote for this workspace. With workDir omitted, creating the workspace immediately queues a clone on runnerId (or the current runner) and returns provisionState CLONING; poll agent_list until READY or FAILED. With workDir present, records that the existing checkout came from this remote and returns READY without cloning.",
		}
		tools = append(tools,
			map[string]interface{}{
				"name":        "session_create",
				"description": "Spawn a new agent session to run a sub-task immediately (L3 orchestration). Returns the new session's id and status; poll session_get for its result. Write `prompt` as a self-contained, executable brief (background, files, steps, acceptance) — the sub-agent has no prior context. When the user @mentions an agent in their message, pass that agent's name as `agentName` to run the sub-task under it (use agent_list to discover names); otherwise it runs under the current agent. Requires orchestration to be enabled for this agent. Fails with \"already has N unfinished sessions\" when this run is holding too much unfinished work at once — that is backpressure, not an error in your request: let some of the sessions you started finish, then spawn again.",
				"inputSchema": obj(map[string]interface{}{
					"prompt":    promptDesc,
					"agentId":   map[string]interface{}{"type": []string{"string", "null"}, "description": "Which agent runs it (by id); defaults to the current agent."},
					"agentName": map[string]interface{}{"type": "string", "description": "Route to an agent by name (e.g. from an @mention). Resolved to that owner's agent; ignored if agentId is set."},
					"title":     str,
					"model":     str,
					"provider":  map[string]interface{}{"type": "string", "description": "Run this session on a specific provider: a built-in engine slug (\"claude\", \"codex\", \"kimi\", \"opencode\") or one of the owner's configured provider slugs. Omit to start where the target agent's project last started — an agent has no provider of its own."},
					// The enum is what a model actually chooses from, so it lists only the modes this
					// machine can run — a root runner drops "bypassPermissions", which claude refuses
					// under root by exiting during startup. Offering it there is how a sub-session got
					// created that could never produce a turn.
					"permissionMode": map[string]interface{}{
						"type":        "string",
						"enum":        offeredPermissionModes(),
						"description": strings.TrimSpace("How much the sub-session may do without a human: \"plan\" investigates and proposes without touching anything, \"default\" asks before each unapproved action, \"acceptEdits\" pre-approves file edits only, \"auto\" lets the model decide when to ask, \"dontAsk\"/\"bypassPermissions\" never ask. Omit to use the owner's account default. A mode that asks parks the sub-session on an approval card until a human answers, so pick one only if someone is watching. " + rootWithheldPermissionModeNote()),
					},
					"wait": map[string]interface{}{"type": "boolean", "description": "Block until the new session finishes its first turn (result ready), then return its full state. Default false — returns immediately; poll session_get."},
				}, "prompt"),
			},
			map[string]interface{}{
				"name":        "session_list",
				"description": "List this owner's sessions (optionally filter by status or parentSessionId). Use to see what other sessions are doing and to collect the children you spawned (pass your own session id as parentSessionId).",
				"inputSchema": obj(map[string]interface{}{"status": sessionStatus, "parentSessionId": str}),
			},
			map[string]interface{}{
				"name":        "session_search",
				"description": "Find this owner's sessions by keyword or id — a session id (the Base62 short id these tools return and Orbit URLs carry), a raw UUID from an older link, or an 8–12 character UUID prefix resolves the corresponding session (all matches are returned if a prefix is ambiguous); text search matches session titles, opening prompts, last replies, branch names and the joined agent/task names, plus the conversation text itself for queries of 3+ characters (the response's `contentSearched` says whether message bodies were in scope). Spans Open, Completed and Trash; each hit carries `matchField`, a text snippet, lifecycleState and completedAt/deletedAt so you can tell where it lives. Hits are ranked by where the query matched, how exactly, and how recently the session was touched, then capped at `limit` — compare `total` against the number of hits to see whether a common word matched far more than came back, and narrow the query if it did. During rolling upgrades, filingState and archivedAt may also appear as compatibility aliases. Use session_list instead to see what is running right now.",
				"inputSchema": obj(map[string]interface{}{
					"query": map[string]interface{}{"type": "string", "description": "Text to look for, or a session id (Base62; a raw UUID or an 8–12 character UUID prefix also resolves). Text is matched literally (case-insensitive), not as a regex or keyword set."},
					"limit": map[string]interface{}{"type": "integer", "description": "Max hits to return. Default 20, capped at 50."},
				}, "query"),
			},
			map[string]interface{}{
				"name":        "session_get",
				"description": "Get one session's current status and latest output (to collect a spawned sub-task's result).",
				"inputSchema": obj(map[string]interface{}{"sessionId": sessionIDProp}, "sessionId"),
			},
			map[string]interface{}{
				"name":        "session_send",
				"description": "Send a message to a session you started (e.g. correct a sub-agent that's going off track, or answer one that is waiting for you). The server decides where it lands and reports it in `placement`: `steer` writes it into the turn already running, which gets no independent reply and cannot be withdrawn, while `accepted`/`queued` files it as that session's next turn. Reuse clientTurnId after an uncertain response.",
				"inputSchema": obj(map[string]interface{}{
					"sessionId":    sessionIDProp,
					"message":      str,
					"clientTurnId": map[string]interface{}{"type": "string", "description": "Optional idempotency key. Re-sending the same CURRENT_WORK payload with this key returns its existing receipt instead of delivering twice — use it when retrying a call whose answer you never saw. Omitted, every call is a new logical send."},
				}, "sessionId", "message"),
			},
			map[string]interface{}{
				"name":        "session_interrupt",
				"description": "Interrupt a session's current turn (the process stays alive; you can session_send afterward). Interrupting DROPS whatever was queued behind that turn — stopping means stop. To stop the turn and redirect it, pass `message`: that files the follow-up in the same operation, after the drop, so it survives and runs as the next turn. Accepting this is not a promise the engine stopped; the session's transcript carries an `interrupt` event when it actually did.",
				"inputSchema": obj(map[string]interface{}{
					"sessionId":    sessionIDProp,
					"message":      map[string]interface{}{"type": "string", "description": "What to do instead, sent atomically with the stop. Omitted → a plain interrupt, and anything queued behind the running turn is dropped with nothing put in its place."},
					"clientTurnId": map[string]interface{}{"type": "string", "description": "Optional idempotency key for the follow-up; a retry with the same key re-files neither the interrupt nor the message. Ignored without `message`."},
				}, "sessionId"),
			},
			map[string]interface{}{
				"name":        "session_merge",
				"description": "Merge a session's git worktree branch into its target branch (default: the runner's main/master). Only for worktree-isolated sessions; fails cleanly on conflict.",
				"inputSchema": obj(map[string]interface{}{"sessionId": sessionIDProp, "targetBranch": str}, "sessionId"),
			},
			map[string]interface{}{
				"name":        "session_end",
				"description": "End a session (park it; it can be resumed later). Frees its runner slot.",
				"inputSchema": obj(map[string]interface{}{"sessionId": sessionIDProp}, "sessionId"),
			},
			map[string]interface{}{
				"name":        "session_complete",
				"description": "Complete a session. Ends it if live and moves it from Open to Completed; it can still be moved back to Open later.",
				"inputSchema": obj(map[string]interface{}{"sessionId": sessionIDProp}, "sessionId"),
			},
			map[string]interface{}{
				"name":        "session_delete",
				"description": "Move a session to Trash. Ends it first if it is live, but retains its transcript and other data so a human can restore it later. This is not a permanent purge.",
				"inputSchema": obj(map[string]interface{}{"sessionId": sessionIDProp}, "sessionId"),
			},
			map[string]interface{}{
				"name":        "agent_list",
				"description": "List this owner's agents/workspaces (id, name, repoUrl, workDir, runner, provisioning result, and the provider the project last ran on). provisionState READY means the directory is usable; CLONING means the runner is still cloning and sessions cannot start; FAILED means clone stopped and provisionError carries git's stderr. Poll this after agent_create returns CLONING. Use the list to discover which agent to route a sub-task to — resolve an @mention to a name/id, then pass it to session_create (agentName or agentId).",
				"inputSchema": obj(map[string]interface{}{}),
			},
			map[string]interface{}{
				"name":        "agent_create",
				"description": "Create a new agent/workspace under this owner, bound to the current runner unless runnerId is given — e.g. to stand up a specialized sub-agent to delegate to. repoUrl without workDir immediately queues a clone on that runner. The returned provisionState is the receipt: READY means the directory is usable; CLONING means clone is still in flight and sessions cannot start; FAILED means clone stopped and provisionError carries git's stderr. Poll agent_list after CLONING instead of treating the returned id as proof clone succeeded. repoUrl with workDir records an existing checkout and clones nothing. An agent has no provider of its own, so pass `provider` to session_create when a session needs a specific one. NOTE: the orchestration permission cannot be set here; only a human can grant it in the web UI.",
				"inputSchema": obj(map[string]interface{}{
					"name":               str,
					"description":        str,
					"systemPrompt":       str,
					"appendSystemPrompt": str,
					"workDir":            map[string]interface{}{"type": "string", "description": "Project directory on the runner the agent runs in."},
					"runnerId":           map[string]interface{}{"type": "string", "description": "Runner to bind to; defaults to the current runner."},
					"repoUrl":            repoURLProp,
					"enableWorktree":     map[string]interface{}{"type": "boolean", "description": "Run each of the agent's sessions in its own git worktree."},
					"env":                envProp,
					"defaultMergeTarget": mergeTargetProp,
				}, "name"),
			},
			map[string]interface{}{
				"name":        "agent_update",
				"description": "Update an existing agent's fields (name, system prompt, workDir, etc.). An agent has no provider to set — that is per session. Cannot change the orchestration permission (human-only, web UI).",
				"inputSchema": obj(map[string]interface{}{
					"agentId":            map[string]interface{}{"type": "string", "description": "Agent id to update."},
					"name":               str,
					"description":        str,
					"systemPrompt":       str,
					"appendSystemPrompt": str,
					"workDir":            str,
					"runnerId":           str,
					"enableWorktree":     map[string]interface{}{"type": "boolean"},
					"env":                envProp,
					"defaultMergeTarget": mergeTargetProp,
				}, "agentId"),
			},
		)
	}
	if includePermissionPrompt {
		tools = append(tools, map[string]interface{}{
			// Claude Code's --permission-prompt-tool target. Claude calls it (not the
			// agent) when a tool needs permission; it blocks on a human allow/deny.
			"name":        "permission_prompt",
			"description": "Internal: handles Claude Code tool-permission prompts. Not for direct use.",
			"inputSchema": obj(map[string]interface{}{
				"tool_name":   str,
				"input":       map[string]interface{}{"type": "object"},
				"tool_use_id": str,
			}),
		})
	}
	return tools
}

// ── helpers ───────────────────────────────────────────────────────────────

func toolResult(text string, isErr bool) map[string]interface{} {
	return map[string]interface{}{
		"content": []map[string]interface{}{{"type": "text", "text": text}},
		"isError": isErr,
	}
}

// sessionWaitInterval * maxSessionWaitPolls caps how long session_create(wait) blocks the
// parent's tool call before handing back the last known state (~3s * 200 = ~10 min).
const sessionWaitInterval = 3 * time.Second
const maxSessionWaitPolls = 200

// envSpawnDepth carries how many spawn links sit above this session (a root is 0).
const envSpawnDepth = "ORBIT_SPAWN_DEPTH"

// A wait may not outlast the wait that is waiting on it. Every level used to get the same
// full budget, so the arithmetic could not work: a parent's 10 minutes has to cover its
// child's ENTIRE execution, and the child's own wait alone could spend all 10 — the outer
// call then times out and reports a still-PENDING grandchild as though the work were merely
// slow, which is indistinguishable from real progress.
//
// Halving per level makes the nested budget a strict fraction of the enclosing one
// (10min > 5min > 2.5min …), so the inner wait always resolves first and the outer one
// returns a settled answer. The floor keeps the deepest level long enough to be useful; it
// stays well under one interval of its parent's remaining budget at every supported depth.
const minSessionWaitPolls = 10

func sessionWaitPolls(depth int) int {
	polls := maxSessionWaitPolls
	for i := 0; i < depth && polls > minSessionWaitPolls; i++ {
		polls /= 2
	}
	if polls < minSessionWaitPolls {
		return minSessionWaitPolls
	}
	return polls
}

// spawnDepthFromEnv reads this session's depth. Absent or unparseable means depth 0 — an
// older server that does not send it, where the previous single-budget behaviour applies.
func spawnDepthFromEnv() int {
	d, err := strconv.Atoi(strings.TrimSpace(os.Getenv(envSpawnDepth)))
	if err != nil || d < 0 {
		return 0
	}
	return d
}

// waitForSession blocks until the freshly-created child session settles — i.e. leaves
// PENDING/RUNNING (reaching AWAITING_INPUT once its first turn produced a result, or a
// terminal state) — then returns its full row so the caller reads the result inline.
func (s *mcpServer) waitForSession(created json.RawMessage) map[string]interface{} {
	raw, err := waitForSessionRaw(s.t, cliOrchestrationContext{
		sessionID: s.sessionID,
		token:     s.orchestrationToken,
	}, created)
	if err != nil {
		return toolResult("wait: "+err.Error(), true)
	}
	return toolResult(prettyJSON(raw), false)
}

// sessionSettled reports whether a session has no active turn running (its result is ready).
func sessionSettled(status string) bool {
	switch status {
	case "PENDING", "RUNNING", "":
		return false
	default:
		return true // AWAITING_INPUT, SUCCEEDED, FAILED, CANCELLED, INTERRUPTED
	}
}

func getBool(args map[string]interface{}, key string) bool {
	if v, ok := args[key].(bool); ok {
		return v
	}
	return false
}

// sessionListQuery builds the optional ?status=&parentSessionId= filter for session_list.
func sessionListQuery(args map[string]interface{}) string {
	q := url.Values{}
	if v := getString(args, "status"); v != "" {
		q.Set("status", v)
	}
	if v := getString(args, "parentSessionId"); v != "" {
		q.Set("parentSessionId", v)
	}
	if len(q) == 0 {
		return ""
	}
	return "?" + q.Encode()
}

// sessionSearchQuery builds ?q=&limit= for session_search. The server defaults and caps
// the limit, so an absent or unparseable one is simply left off.
func sessionSearchQuery(args map[string]interface{}) string {
	q := url.Values{}
	q.Set("q", getString(args, "query"))
	if n := getNumber(args, "limit"); n > 0 {
		q.Set("limit", strconv.Itoa(n))
	}
	return "?" + q.Encode()
}

// getNumber reads a numeric argument. JSON numbers decode to float64, but models routinely
// send them quoted, so a numeric string counts too.
func getNumber(args map[string]interface{}, key string) int {
	switch v := args[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case string:
		n, _ := strconv.Atoi(v)
		return n
	}
	return 0
}

// getBoundedOptionalNumber validates a numeric MCP argument before it becomes an HTTP
// query parameter. Zero means absent; an explicitly invalid value is never silently
// replaced by the backend default.
func getBoundedOptionalNumber(args map[string]interface{}, key string, maximum int) (int, error) {
	raw, present := args[key]
	if !present {
		return 0, nil
	}
	var n int
	switch value := raw.(type) {
	case float64:
		if value < 1 || value > float64(maximum) || value != float64(int(value)) {
			return 0, fmt.Errorf("%s must be an integer from 1 to %d", key, maximum)
		}
		n = int(value)
	case string:
		parsed, err := strconv.Atoi(value)
		if err != nil {
			return 0, fmt.Errorf("%s must be an integer from 1 to %d", key, maximum)
		}
		n = parsed
	default:
		return 0, fmt.Errorf("%s must be an integer from 1 to %d", key, maximum)
	}
	if n < 1 || n > maximum {
		return 0, fmt.Errorf("%s must be an integer from 1 to %d", key, maximum)
	}
	return n, nil
}

func getString(args map[string]interface{}, key string) string {
	if v, ok := args[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// getStringSlice reads an array-of-strings argument, tolerating the single string a model
// sometimes sends when the schema says array. Non-string entries are skipped rather than
// failing the call: one malformed element should not lose a filter the caller did express.
func getStringSlice(args map[string]interface{}, key string) []string {
	switch v := args[key].(type) {
	case string:
		if v == "" {
			return nil
		}
		return []string{v}
	case []interface{}:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if s, ok := item.(string); ok && s != "" {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

// copyIfPresent passes through keys the caller supplied (including explicit null,
// so e.g. listId:null reaches the server as a clear).
func copyIfPresent(dst, src map[string]interface{}, keys ...string) {
	for _, k := range keys {
		if v, ok := src[k]; ok {
			dst[k] = v
		}
	}
}

func prettyJSON(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "(empty)"
	}
	var buf bytes.Buffer
	if json.Indent(&buf, raw, "", "  ") != nil {
		return string(raw)
	}
	return buf.String()
}

// countJSONArray reports how many elements a raw JSON array holds, so a caller can tell a full
// page from a complete answer. Anything that is not an array counts as zero.
func countJSONArray(raw json.RawMessage) int {
	var items []json.RawMessage
	if json.Unmarshal(raw, &items) != nil {
		return 0
	}
	return len(items)
}
