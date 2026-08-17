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

// callTool dispatches one tool. A tool's own failure (bad args, transport error) is
// reported as a result with isError=true — NOT a JSON-RPC protocol error — per MCP.
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
		raw, err := s.t.listTasks(getString(args, "status"), getString(args, "listId"), getStringSlice(args, "labels"), limit)
		if err != nil {
			return toolResult("list tasks failed: "+err.Error(), true)
		}
		body := prettyJSON(raw)
		if countJSONArray(raw) >= limit {
			body = fmt.Sprintf("Showing the newest %d tasks; narrow with status/listId/labels or raise limit.\n%s", limit, body)
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
		copyIfPresent(body, args, "description", "listId", "assigneeId", "dueDate", "provider", "model", "dependsOnTaskIds", "autoRunWhenReady", "labels")
		// Default the assignee to the current agent when the caller didn't specify one
		// (an explicit assigneeId, including null to leave it unassigned, is respected).
		if _, ok := body["assigneeId"]; !ok && s.agentID != "" {
			body["assigneeId"] = s.agentID
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
			copyIfPresent(body, item, "description", "listId", "assigneeId", "dueDate", "provider", "model", "dependsOnTaskIds", "autoRunWhenReady", "labels", "ref", "dependsOnRefs")
			// Same assignee default as task_create: this agent unless the caller said otherwise.
			if _, ok := body["assigneeId"]; !ok && s.agentID != "" {
				body["assigneeId"] = s.agentID
			}
			bodies = append(bodies, body)
		}
		return s.createBatchWithApproval(bodies)

	case "task_update":
		id, ok := s.resolveTaskID(args)
		if !ok {
			return toolResult(noTaskMsg, true)
		}
		body := map[string]interface{}{}
		copyIfPresent(body, args, "title", "description", "status", "listId", "assigneeId", "dueDate", "provider", "model", "dependsOnTaskIds", "autoRunWhenReady", "labels")
		if len(body) == 0 {
			return toolResult("no fields to update", true)
		}
		raw, err := s.t.updateTask(id, body)
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
		raw, err := s.t.startTask(id)
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
		raw, err := s.t.sendSessionMessage(s.sessionID, s.orchestrationToken, id, map[string]interface{}{"message": msg})
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
		raw, err := s.t.interruptSession(s.sessionID, s.orchestrationToken, id)
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
		copyIfPresent(body, args, "description", "systemPrompt", "appendSystemPrompt", "workDir", "runnerId", "enableWorktree", "env", "defaultMergeTarget")
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
	status := map[string]interface{}{"type": "string", "enum": []string{"OPEN", "IN_PROGRESS", "DONE", "CANCELLED"}}
	providerProp := map[string]interface{}{
		"type":        []string{"string", "null"},
		"description": "Run this task on a specific provider: a built-in engine slug (\"claude\", \"codex\", \"kimi\", \"opencode\") or one of the owner's configured provider slugs. Omit (or pass null) to start where the assignee's project last started, which is almost always right — only pin one when the task genuinely needs that provider. Changing it makes the next run start a fresh session instead of continuing the previous one.",
	}
	modelProp := map[string]interface{}{
		"type":        []string{"string", "null"},
		"description": "Run this task on a specific model id within its provider's model space (e.g. \"claude-opus-5\"). Omit (or pass null) to use the provider's own default. An id the provider doesn't have will fail at run time, not here.",
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
	// The fields of one new task, shared by task_create and every task_create_batch item.
	// A fresh map per call so a caller can extend its copy without touching the other's.
	taskCreateProps := func() map[string]interface{} {
		return map[string]interface{}{
			"title":       str,
			"description": promptDesc,
			"listId":      map[string]interface{}{"type": []string{"string", "null"}},
			"assigneeId":  map[string]interface{}{"type": []string{"string", "null"}},
			"dueDate":     str,
			"provider":    providerProp,
			"model":       modelProp,
			"dependsOnTaskIds": map[string]interface{}{
				"type":        "array",
				"items":       str,
				"description": "Prerequisite task ids this task waits on (each must be owned by the caller). The task is BLOCKED until every prerequisite is DONE, then runs. Use this instead of writing 'wait for X' preconditions into the description. Cannot form a cycle.",
			},
			"autoRunWhenReady": map[string]interface{}{
				"type":        "boolean",
				"description": "Once all prerequisites are DONE, auto-run this task without a manual start (default true). Needs an assignee bound to a runner. Set false to leave it OPEN for a human/agent to start. Ignored when there are no prerequisites.",
			},
			"labels": labelsProp,
		}
	}
	taskBatchItemProps := func() map[string]interface{} {
		props := taskCreateProps()
		props["ref"] = map[string]interface{}{
			"type":        "string",
			"description": "A short label for this item, unique within the batch, so later items can depend on it via dependsOnRefs. Not stored — it only wires the batch together, and comes back on the created task so you can map it to the real id.",
		}
		props["dependsOnRefs"] = map[string]interface{}{
			"type":        "array",
			"items":       str,
			"description": "Refs of EARLIER items in this same batch that must finish before this one runs. Use this for prerequisites created by this call (their ids don't exist yet) and dependsOnTaskIds for tasks that already exist.",
		}
		return props
	}
	tools := []map[string]interface{}{
		{
			"name":        "task_list",
			"description": "List the caller's newest tasks, without their descriptions (task_get returns one task in full). Optionally filter by status, listId or labels.",
			"inputSchema": obj(map[string]interface{}{
				"status": status,
				"listId": str,
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
			"description": "Add one dependency edge: taskId waits for dependsOnTaskId. The server rejects cross-owner tasks, self-dependencies, duplicate edges, and cycles. Prefer this granular edit after reading task_dependency_graph when preserving every other edge.",
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
			"description": "Create ONE task (attributed to this agent). Creating several related tasks? Use task_create_batch instead — it writes them, and the dependency edges between them, in a single atomic call. This only records the task; call task_start when it should run immediately. Always write `description` as a self-contained, executable prompt an agent can act on without prior context (background, files involved, steps, acceptance criteria). assigneeId defaults to this agent when omitted (pass null to leave it unassigned). assigneeId/listId must be owned by the caller; dueDate is an ISO date string. To order work, pass `dependsOnTaskIds` to declare prerequisites natively — do NOT bake ordering into the description as manual preconditions.",
			"inputSchema": obj(taskCreateProps(), "title"),
		},
		{
			"name":        "task_create_batch",
			"description": fmt.Sprintf("Create up to %d tasks in one atomic call (attributed to this agent) — the batch form of task_create, and the right tool whenever a plan produces more than one task. Nothing is written unless every item is valid. Items are created in order, and a later item can depend on an earlier one WITHOUT knowing its id: give the earlier item a `ref` and list that ref in the later item's `dependsOnRefs` (e.g. [{ref:\"s0\",…},{ref:\"s1\",dependsOnRefs:[\"s0\"]}]). `dependsOnTaskIds` still takes ids of tasks that already exist; the two combine. Returns the created tasks in input order, each echoing its `ref`. Tasks are only recorded — call task_start for one that should run now. This BLOCKS until a human approves the batch: they see what would be created and, above all, how many of it starts running within the minute. Send the batch you actually mean — a rejected one costs the whole call, not one item.", maxTaskBatchCreate),
			"inputSchema": obj(map[string]interface{}{
				"tasks": map[string]interface{}{
					"type":        "array",
					"minItems":    1,
					"maxItems":    maxTaskBatchCreate,
					"items":       obj(taskBatchItemProps(), "title"),
					"description": "The tasks to create, in dependency order (prerequisites first).",
				},
			}, "tasks"),
		},
		{
			"name":        "task_update",
			"description": "Update a task's fields. When setting `description`, write it as a self-contained, executable prompt an agent can act on without prior context (background, files involved, steps, acceptance criteria). Pass null for assigneeId/listId/dueDate/provider/model to clear them.",
			"inputSchema": obj(map[string]interface{}{
				"taskId":      taskIDProp,
				"title":       str,
				"description": promptDesc,
				"status":      status,
				"listId":      map[string]interface{}{"type": []string{"string", "null"}},
				"assigneeId":  map[string]interface{}{"type": []string{"string", "null"}},
				"dueDate":     map[string]interface{}{"type": []string{"string", "null"}},
				"provider":    providerProp,
				"model":       modelProp,
				"dependsOnTaskIds": map[string]interface{}{
					"type":        "array",
					"items":       str,
					"description": "Complete replacement for this task's prerequisite ids. Omit to leave dependencies unchanged; pass [] to clear all prerequisites. Each id must be owned by the caller, and the replacement cannot form a cycle.",
				},
				"autoRunWhenReady": map[string]interface{}{
					"type":        "boolean",
					"description": "Once all prerequisites are DONE, auto-run this task without a manual start. Needs an assignee bound to a runner.",
				},
				"labels": map[string]interface{}{
					"type":        "array",
					"items":       str,
					"maxItems":    maxTaskLabels,
					"description": "Complete replacement for this task's labels. Omit to leave them unchanged; pass [] to clear them all.",
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
					"permissionMode": map[string]interface{}{
						"type":        "string",
						"enum":        []string{"default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"},
						"description": "How much the sub-session may do without a human: \"plan\" investigates and proposes without touching anything, \"default\" asks before each unapproved action, \"acceptEdits\" pre-approves file edits only, \"auto\" lets the model decide when to ask, \"dontAsk\"/\"bypassPermissions\" never ask. Omit to use the owner's account default. A mode that asks parks the sub-session on an approval card until a human answers, so pick one only if someone is watching.",
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
				"description": "Send a follow-up message to a running or queued session (e.g. steer a sub-agent that's going off track).",
				"inputSchema": obj(map[string]interface{}{"sessionId": sessionIDProp, "message": str}, "sessionId", "message"),
			},
			map[string]interface{}{
				"name":        "session_interrupt",
				"description": "Interrupt a session's current turn (the process stays alive; you can session_send afterward).",
				"inputSchema": obj(map[string]interface{}{"sessionId": sessionIDProp}, "sessionId"),
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
				"name":        "agent_list",
				"description": "List this owner's agents (id, name, workDir, runner, and the provider the project last ran on). Use to discover which agent to route a sub-task to — resolve an @mention to a name/id, then pass it to session_create (agentName or agentId).",
				"inputSchema": obj(map[string]interface{}{}),
			},
			map[string]interface{}{
				"name":        "agent_create",
				"description": "Create a new agent under this owner, bound to the current runner unless runnerId is given — e.g. to stand up a specialized sub-agent to delegate to. An agent is a machine plus a project directory: it has no provider of its own, so pass `provider` to session_create when a session needs a specific one. NOTE: the orchestration permission cannot be set here; only a human can grant it in the web UI.",
				"inputSchema": obj(map[string]interface{}{
					"name":               str,
					"description":        str,
					"systemPrompt":       str,
					"appendSystemPrompt": str,
					"workDir":            map[string]interface{}{"type": "string", "description": "Project directory on the runner the agent runs in."},
					"runnerId":           map[string]interface{}{"type": "string", "description": "Runner to bind to; defaults to the current runner."},
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
