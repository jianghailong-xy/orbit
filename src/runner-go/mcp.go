package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"time"
)

// orbit mcp — a minimal Model Context Protocol server (JSON-RPC 2.0 over stdio,
// pure stdlib) that lets an in-session Claude agent manage Orbit Tasks/TaskLists.
// The runner injects it into each claude process via --mcp-config; claude speaks to
// it over stdin/stdout, so NOTHING may be printed to stdout except JSON-RPC frames —
// all diagnostics go to stderr.

// cmdMcp serves the MCP protocol until stdin closes. It reads the runner credential
// from config.json (never from the env, so the token stays out of the claude process)
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
		return s.ok(req.ID, map[string]interface{}{"tools": toolDescriptors(s.allowPermissionPrompt, s.allowOrchestration)}), true
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

// callTool dispatches one tool. A tool's own failure (bad args, transport error) is
// reported as a result with isError=true — NOT a JSON-RPC protocol error — per MCP.
func (s *mcpServer) callTool(name string, args map[string]interface{}) map[string]interface{} {
	switch name {
	case "task_list":
		raw, err := s.t.listTasks()
		if err != nil {
			return toolResult("list tasks failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(filterTasks(raw, getString(args, "status"), getString(args, "listId"))), false)

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

	case "task_create":
		title := getString(args, "title")
		if title == "" {
			return toolResult("title is required", true)
		}
		body := map[string]interface{}{"title": title}
		copyIfPresent(body, args, "description", "listId", "assigneeId", "dueDate")
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

	case "task_update":
		id, ok := s.resolveTaskID(args)
		if !ok {
			return toolResult(noTaskMsg, true)
		}
		body := map[string]interface{}{}
		copyIfPresent(body, args, "title", "description", "status", "listId", "assigneeId", "dueDate")
		if len(body) == 0 {
			return toolResult("no fields to update", true)
		}
		raw, err := s.t.updateTask(id, body)
		if err != nil {
			return toolResult("update task failed: "+err.Error(), true)
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

	case "session_create":
		if !s.allowOrchestration {
			return toolResult(orchestrationOffMsg, true)
		}
		prompt := getString(args, "prompt")
		if prompt == "" {
			return toolResult("prompt is required", true)
		}
		body := map[string]interface{}{"prompt": prompt}
		copyIfPresent(body, args, "title", "model")
		// Default the runner agent to the current one unless the caller names another.
		if id := getString(args, "agentId"); id != "" {
			body["agentId"] = id
		} else if s.agentID != "" {
			body["agentId"] = s.agentID
		}
		raw, err := s.t.createSession(s.sessionID, body)
		if err != nil {
			return toolResult("create session failed: "+err.Error(), true)
		}
		if getBool(args, "wait") {
			return s.waitForSession(raw)
		}
		return toolResult(prettyJSON(raw), false)

	case "session_list":
		if !s.allowOrchestration {
			return toolResult(orchestrationOffMsg, true)
		}
		raw, err := s.t.listSessions(sessionListQuery(args))
		if err != nil {
			return toolResult("list sessions failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "session_get":
		if !s.allowOrchestration {
			return toolResult(orchestrationOffMsg, true)
		}
		id := getString(args, "sessionId")
		if id == "" {
			return toolResult("sessionId is required", true)
		}
		raw, err := s.t.getSession(id)
		if err != nil {
			return toolResult("get session failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "session_send":
		if !s.allowOrchestration {
			return toolResult(orchestrationOffMsg, true)
		}
		id := getString(args, "sessionId")
		msg := getString(args, "message")
		if id == "" || msg == "" {
			return toolResult("sessionId and message are required", true)
		}
		raw, err := s.t.sendSessionMessage(id, map[string]interface{}{"message": msg})
		if err != nil {
			return toolResult("send message failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "session_interrupt":
		if !s.allowOrchestration {
			return toolResult(orchestrationOffMsg, true)
		}
		id := getString(args, "sessionId")
		if id == "" {
			return toolResult("sessionId is required", true)
		}
		raw, err := s.t.interruptSession(id)
		if err != nil {
			return toolResult("interrupt session failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "session_merge":
		if !s.allowOrchestration {
			return toolResult(orchestrationOffMsg, true)
		}
		id := getString(args, "sessionId")
		if id == "" {
			return toolResult("sessionId is required", true)
		}
		body := map[string]interface{}{}
		copyIfPresent(body, args, "targetBranch")
		raw, err := s.t.mergeSession(id, body)
		if err != nil {
			return toolResult("merge session failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "session_end":
		if !s.allowOrchestration {
			return toolResult(orchestrationOffMsg, true)
		}
		id := getString(args, "sessionId")
		if id == "" {
			return toolResult("sessionId is required", true)
		}
		raw, err := s.t.endSession(id)
		if err != nil {
			return toolResult("end session failed: "+err.Error(), true)
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

// maxApprovalPolls caps the total wait for a human decision (~25s per poll), so a
// forgotten approval can't wedge the claude process forever.
const maxApprovalPolls = 300

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
	id, err := s.t.createApproval(s.sessionID, map[string]interface{}{
		"toolName":  getString(args, "tool_name"),
		"input":     args["input"],
		"toolUseId": getString(args, "tool_use_id"),
	})
	if err != nil {
		return toolResult(denyJSON("could not register approval: "+err.Error()), false)
	}
	for i := 0; i < maxApprovalPolls; i++ {
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
	return toolResult(denyJSON("approval timed out"), false)
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
	obj := func(props map[string]interface{}, required ...string) map[string]interface{} {
		schema := map[string]interface{}{"type": "object", "properties": props}
		if len(required) > 0 {
			schema["required"] = required
		}
		return schema
	}
	tools := []map[string]interface{}{
		{
			"name":        "task_list",
			"description": "List the caller's tasks. Optionally filter by status or listId.",
			"inputSchema": obj(map[string]interface{}{"status": status, "listId": str}),
		},
		{
			"name":        "task_get",
			"description": "Get one task with its comments and linked sessions.",
			"inputSchema": obj(map[string]interface{}{"taskId": taskIDProp}),
		},
		{
			"name":        "task_create",
			"description": "Create a task (attributed to this agent). Always write `description` as a self-contained, executable prompt an agent can act on without prior context (background, files involved, steps, acceptance criteria). assigneeId defaults to this agent when omitted (pass null to leave it unassigned). assigneeId/listId must be owned by the caller; dueDate is an ISO date string.",
			"inputSchema": obj(map[string]interface{}{
				"title":       str,
				"description": promptDesc,
				"listId":      map[string]interface{}{"type": []string{"string", "null"}},
				"assigneeId":  map[string]interface{}{"type": []string{"string", "null"}},
				"dueDate":     str,
			}, "title"),
		},
		{
			"name":        "task_update",
			"description": "Update a task's fields. When setting `description`, write it as a self-contained, executable prompt an agent can act on without prior context (background, files involved, steps, acceptance criteria). Pass null for assigneeId/listId/dueDate to clear them.",
			"inputSchema": obj(map[string]interface{}{
				"taskId":      taskIDProp,
				"title":       str,
				"description": promptDesc,
				"status":      status,
				"listId":      map[string]interface{}{"type": []string{"string", "null"}},
				"assigneeId":  map[string]interface{}{"type": []string{"string", "null"}},
				"dueDate":     map[string]interface{}{"type": []string{"string", "null"}},
			}),
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
	}
	if includeOrchestration {
		sessionIDProp := map[string]interface{}{"type": "string", "description": "Target session id."}
		sessionStatus := map[string]interface{}{"type": "string", "enum": []string{"PENDING", "RUNNING", "AWAITING_INPUT", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED", "PARKED"}}
		tools = append(tools,
			map[string]interface{}{
				"name":        "session_create",
				"description": "Spawn a new agent session to run a sub-task immediately (L3 orchestration). Returns the new session's id and status; poll session_get for its result. Write `prompt` as a self-contained, executable brief (background, files, steps, acceptance) — the sub-agent has no prior context. agentId defaults to the current agent. Requires orchestration to be enabled for this agent.",
				"inputSchema": obj(map[string]interface{}{
					"prompt":  promptDesc,
					"agentId": map[string]interface{}{"type": []string{"string", "null"}, "description": "Which agent runs it; defaults to the current agent."},
					"title":   str,
					"model":   str,
					"wait":    map[string]interface{}{"type": "boolean", "description": "Block until the new session finishes its first turn (result ready), then return its full state. Default false — returns immediately; poll session_get."},
				}, "prompt"),
			},
			map[string]interface{}{
				"name":        "session_list",
				"description": "List this owner's sessions (optionally filter by status or parentSessionId). Use to see what other sessions are doing and to collect the children you spawned (pass your own session id as parentSessionId).",
				"inputSchema": obj(map[string]interface{}{"status": sessionStatus, "parentSessionId": str}),
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

// waitForSession blocks until the freshly-created child session settles — i.e. leaves
// PENDING/RUNNING (reaching AWAITING_INPUT once its first turn produced a result, or a
// terminal state) — then returns its full row so the caller reads the result inline.
func (s *mcpServer) waitForSession(created json.RawMessage) map[string]interface{} {
	var c struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(created, &c) != nil || c.ID == "" {
		return toolResult(prettyJSON(created), false) // no id to poll; hand back what we have
	}
	for i := 0; i < maxSessionWaitPolls; i++ {
		time.Sleep(sessionWaitInterval)
		raw, err := s.t.getSession(c.ID)
		if err != nil {
			return toolResult("wait: get session failed: "+err.Error(), true)
		}
		var st struct {
			Status string `json:"status"`
		}
		if json.Unmarshal(raw, &st) == nil && sessionSettled(st.Status) {
			return toolResult(prettyJSON(raw), false)
		}
	}
	// Timed out still running: return the latest state (non-error) so the agent can poll on.
	raw, err := s.t.getSession(c.ID)
	if err != nil {
		return toolResult("wait timed out; get session failed: "+err.Error(), true)
	}
	return toolResult(prettyJSON(raw), false)
}

// sessionSettled reports whether a session has no active turn running (its result is ready).
func sessionSettled(status string) bool {
	switch status {
	case "PENDING", "RUNNING", "":
		return false
	default:
		return true // AWAITING_INPUT, SUCCEEDED, FAILED, CANCELLED, INTERRUPTED, PARKED
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

func getString(args map[string]interface{}, key string) string {
	if v, ok := args[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
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

// filterTasks applies optional client-side status/listId filtering (the list endpoint
// returns all of the owner's tasks). Returns raw unchanged when no filter is set.
func filterTasks(raw json.RawMessage, status, listID string) json.RawMessage {
	if status == "" && listID == "" {
		return raw
	}
	var tasks []map[string]interface{}
	if json.Unmarshal(raw, &tasks) != nil {
		return raw
	}
	out := make([]map[string]interface{}, 0, len(tasks))
	for _, tk := range tasks {
		if status != "" {
			if s, _ := tk["status"].(string); s != status {
				continue
			}
		}
		if listID != "" {
			if l, _ := tk["listId"].(string); l != listID {
				continue
			}
		}
		out = append(out, tk)
	}
	b, err := json.Marshal(out)
	if err != nil {
		return raw
	}
	return b
}
