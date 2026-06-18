package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
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
		t:         NewTransport(cfg.ServerURL, cfg.RunnerToken),
		sessionID: os.Getenv("ORBIT_SESSION_ID"),
		agentID:   os.Getenv("ORBIT_AGENT_ID"),
		taskID:    os.Getenv("ORBIT_TASK_ID"),
	}
	srv.serve(os.Stdin, os.Stdout)
}

type mcpServer struct {
	t         *Transport
	sessionID string
	agentID   string // attributes created tasks/comments; "" => server falls back to USER
	taskID    string // the "current task" default for get/update/comment
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
		return s.ok(req.ID, map[string]interface{}{"tools": toolDescriptors()}), true
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
		raw, err := s.t.createTask(s.agentID, body)
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

	case "permission_prompt":
		return s.permissionPrompt(args)

	default:
		return toolResult("unknown tool: "+name, true)
	}
}

// maxApprovalPolls caps the total wait for a human decision (~25s per poll), so a
// forgotten approval can't wedge the claude process forever.
const maxApprovalPolls = 120

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
			return toolResult(allowJSON(args["input"]), false)
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

func allowJSON(input interface{}) string {
	if input == nil {
		input = map[string]interface{}{}
	}
	b, err := json.Marshal(map[string]interface{}{"behavior": "allow", "updatedInput": input})
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
func toolDescriptors() []map[string]interface{} {
	str := map[string]interface{}{"type": "string"}
	taskIDProp := map[string]interface{}{"type": "string", "description": "Task id; defaults to the current task (ORBIT_TASK_ID) if omitted"}
	status := map[string]interface{}{"type": "string", "enum": []string{"OPEN", "IN_PROGRESS", "DONE", "CANCELLED"}}
	obj := func(props map[string]interface{}, required ...string) map[string]interface{} {
		schema := map[string]interface{}{"type": "object", "properties": props}
		if len(required) > 0 {
			schema["required"] = required
		}
		return schema
	}
	return []map[string]interface{}{
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
			"description": "Create a task (attributed to this agent). assigneeId/listId must be owned by the caller; dueDate is an ISO date string.",
			"inputSchema": obj(map[string]interface{}{
				"title":       str,
				"description": str,
				"listId":      str,
				"assigneeId":  str,
				"dueDate":     str,
			}, "title"),
		},
		{
			"name":        "task_update",
			"description": "Update a task's fields. Pass null for assigneeId/listId/dueDate to clear them.",
			"inputSchema": obj(map[string]interface{}{
				"taskId":      taskIDProp,
				"title":       str,
				"description": str,
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
		{
			// Claude Code's --permission-prompt-tool target. Claude calls it (not the
			// agent) when a tool needs permission; it blocks on a human allow/deny.
			"name":        "permission_prompt",
			"description": "Internal: handles Claude Code tool-permission prompts. Not for direct use.",
			"inputSchema": obj(map[string]interface{}{
				"tool_name":   str,
				"input":       map[string]interface{}{"type": "object"},
				"tool_use_id": str,
			}),
		},
	}
}

// ── helpers ───────────────────────────────────────────────────────────────

func toolResult(text string, isErr bool) map[string]interface{} {
	return map[string]interface{}{
		"content": []map[string]interface{}{{"type": "text", "text": text}},
		"isError": isErr,
	}
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
