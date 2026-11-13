package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
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
		t:                     newCallerTransport(cfg.ServerURL, cfg.RunnerToken, runnerCallerMCP),
		sessionID:             os.Getenv("ORBIT_SESSION_ID"),
		agentID:               os.Getenv("ORBIT_AGENT_ID"),
		taskID:                os.Getenv("ORBIT_TASK_ID"),
		orchestrationToken:    os.Getenv(envOrchestrationToken),
		allowPermissionPrompt: mcpPermissionPromptEnabled(),
		allowOrchestration:    mcpOrchestrationEnabled(),
		watchesOff:            !watchesEnabledFromEnv(),
		wikiOff:               !wikiEnabledFromEnv(),
		onlyTools:             mcpToolsFromEnv(),
		callTimeout:           mcpCallTimeoutFromEnv(),
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
	allowOrchestration    bool   // L3: expose session_* tools (the account's orchestration switch)
	watchesOff            bool   // spawned with ORBIT_WATCHES=off: no watch tools (watch_rollout.go)
	wikiOff               bool   // spawned with ORBIT_WIKI=off: no wiki tools (wiki_tools.go)
	// Spawned with ORBIT_MCP_TOOLS: these tools and no others, listed or called (the runner-hosted job an
	// owner's wait is handed to, handOffOwnerWait). Nil serves every tool.
	onlyTools map[string]bool
	// How long the engine lets one tool call run before it reports the call failed (ORBIT_MCP_CALL_TIMEOUT_SECONDS);
	// 0 when it waits for as long as the call takes. See handOffOwnerWait.
	callTimeout time.Duration
}

const envMCPPermissionPrompt = "ORBIT_MCP_PERMISSION_PROMPT"

// envMCPCallTimeout is set by a runtime whose engine ends an MCP tool call on its own deadline, and
// whose mcpServers declaration cannot change it (DeepSeek Harness, dsh_mcp.go). Unset, every call
// behaves as it always has.
const envMCPCallTimeout = "ORBIT_MCP_CALL_TIMEOUT_SECONDS"

func mcpCallTimeoutFromEnv() time.Duration {
	seconds, err := strconv.Atoi(strings.TrimSpace(os.Getenv(envMCPCallTimeout)))
	if err != nil || seconds <= 0 {
		return 0
	}
	return time.Duration(seconds) * time.Second
}

// longestInlineWait is how long a call may hold the engine's tool call waiting for something: half the
// engine's deadline, leaving the rest for the round-trips around the wait. 0 means no cap.
func longestInlineWait(callTimeout time.Duration) time.Duration {
	return callTimeout / 2
}

// envMCPTools names the only tools `orbit mcp` serves, comma-separated, when it is set: the job an owner's
// wait is handed to sets it to the one tool that job waits in (handOffOwnerWait).
const envMCPTools = "ORBIT_MCP_TOOLS"

// mcpToolsFromEnv is ORBIT_MCP_TOOLS as a set, or nil when it is not set: every tool.
func mcpToolsFromEnv() map[string]bool {
	raw, ok := os.LookupEnv(envMCPTools)
	if !ok {
		return nil
	}
	only := map[string]bool{}
	for _, name := range strings.Split(raw, ",") {
		if name = strings.TrimSpace(name); name != "" {
			only[name] = true
		}
	}
	return only
}

// onlyMCPTools keeps the tools `only` names, in the order they are listed.
func onlyMCPTools(tools []map[string]interface{}, only map[string]bool) []map[string]interface{} {
	kept := make([]map[string]interface{}, 0, len(only))
	for _, tool := range tools {
		if name, _ := tool["name"].(string); only[name] {
			kept = append(kept, tool)
		}
	}
	return kept
}

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
// OFF: only a session whose account has Session orchestration on (surfaced via this env) may
// orchestrate.
func mcpOrchestrationEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(envMCPOrchestration))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// orchestrationEnabled requires the account's switch and an exact session context.
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
		tools := toolDescriptors(s.allowPermissionPrompt, s.orchestrationEnabled())
		if s.watchesOff {
			tools = withoutWatchTools(tools)
		}
		if s.wikiOff {
			tools = withoutWikiTools(tools)
		}
		if s.onlyTools != nil {
			tools = onlyMCPTools(tools, s.onlyTools)
		}
		return s.ok(req.ID, map[string]interface{}{"tools": tools}), true
	case "tools/call":
		var p struct {
			Name      string                 `json:"name"`
			Arguments map[string]interface{} `json:"arguments"`
		}
		if json.Unmarshal(req.Params, &p) != nil {
			return s.err(req.ID, -32602, "invalid params"), true
		}
		if s.onlyTools != nil && !s.onlyTools[p.Name] {
			return s.ok(req.ID, toolResult(p.Name+" is not served in this session", true)), true
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

// Where the switch is: its own card on the web's and the Mac's Settings, and a row of the Sessions page
// on the phones (docs/mocks/ios-settings-order).
const orchestrationOffMsg = "session orchestration is turned off for this account (Settings → Session orchestration; on a phone, Settings → Sessions → Session orchestration)"

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

const maxTaskModelHintReasonChars = 500

const taskModelHintDescription = "Suggested difficulty tier: S = mechanical edits, copy changes, version upgrades (Sonnet · low); " +
	"M = a well-specified feature or fix (Sonnet · medium); " +
	"L = unknown root cause, concurrency, cross-module work, migrations, or dispatch/core paths (Opus · high); " +
	"XL = architecture design, long unattended work, or repeated failures at L (Opus · max). " +
	"Codex uses the same default model with low/medium/high/xhigh for S/M/L/XL. " +
	"modelHint is a suggestion that failures can escalate; model is a hard pin that takes precedence. " +
	"To pin the engine (the CLI) or the provider (the credential), use engine and provider. " +
	"Omit to preserve the suggestion on update; null clears it."

// The range of a task's priority: the server's TASK_PRIORITY_MIN/MAX, which are the INTEGER
// column's own, stated in the schema for the same reason as the bounds above.
const (
	taskPriorityMin = -2147483648
	taskPriorityMax = 2147483647
)

// What `priority` does, stated once for task_update and `orbit task update --priority`, so the two
// doors cannot come to describe different fields. The server decides all of it (TasksService); this
// is the sentence a caller reads before choosing a number.
const taskPriorityDescription = "Where this task stands in its list's queue. When the list has more ready tasks than free slots (its maxConcurrent), the server's automatic dispatch — the once-a-minute scan, and the start that follows a prerequisite finishing — gives the next slot to the highest priority first; a coordinated project's concurrency budget is dealt the same way. " +
	"An integer: higher goes first, 0 is what every task has until somebody sets it, and a negative value goes after everything left at 0. Equal priorities keep the order they already had, so tasks nobody sets are dispatched exactly as before. " +
	"It only orders tasks that are ready: it starts nothing by itself, gets past no gate (a paused list's dispatchHold, prerequisites, a future runAt, the list's cap), and does not move the list ahead of other lists. task_start ignores it. " +
	"Omit to leave it as it is; null returns the task to 0."

// Audit explanation for deliberately keeping a criterion after the server questions its shape.
// Mirrors MAX_TASK_CRITERION_OVERRIDE_REASON_CHARS.
const maxTaskCriterionOverrideReasonChars = 2000

// maxOwnerConfirmationReasonNoteChars bounds the sentence beside ownerConfirmationReason, as the
// server does (apiserver tasks/owner-confirmation-reason.ts).
const maxOwnerConfirmationReasonNoteChars = 500

// ownerConfirmationReasons is why only the account owner can settle an OWNER_CONFIRMED task, the
// server's whole list (apiserver tasks/owner-confirmation-reason.ts). A session declaring
// OWNER_CONFIRMED on a task in no project, or in a project whose Automatic is off, names one.
var ownerConfirmationReasons = []string{"DEPLOY", "IRREVERSIBLE", "OWNER_DEVICE_OR_ACCOUNT", "OWNER_TRADE_OFF"}

// ownerConfirmationReasonDescription is the rule, said once for the three task tools and the CLI.
const ownerConfirmationReasonDescription = "Why only the account owner can settle this " +
	"OWNER_CONFIRMED task. Required when a session declares OWNER_CONFIRMED on a task in no " +
	"project, or in a project whose Automatic is off: DEPLOY (a release, a deploy, shipping a " +
	"build, a change to a live database), IRREVERSIBLE (a step that cannot be undone, such as a " +
	"DROP or deleting data), OWNER_DEVICE_OR_ACCOUNT (the owner's own device, account or keys) or " +
	"OWNER_TRADE_OFF (a trade-off only the owner can make). Without one the write is refused 409 " +
	"OWNER_CONFIRMATION_REASON_REQUIRED and nothing is written. If none of the four is true, the " +
	"work is not the owner's to settle: declare EVIDENCE_JUDGMENT with acceptanceCriteria instead. " +
	"Outside a project, each evidence revision its run submits is then handed to the session that " +
	"filed the task — this one — to decide with task_evidence_decide, and the owner is asked only " +
	"if that session has not decided within 30 minutes or has ended. In an Automatic project the " +
	"criterion the task serves decides instead and no reason is asked. Stored on the task; " +
	"task_get reads it back."

// Project criteria have the same total compatibility projection cap as the server and a bounded
// number of structural items, so a malformed plan is rejected before the HTTP round-trip.
const maxProjectAcceptanceCriteriaChars = 4000
const maxProjectAcceptanceCriteriaItems = 100
const maxProjectAcceptanceVerificationMethodChars = 4000

func (s *mcpServer) callTool(name string, args map[string]interface{}) map[string]interface{} {
	// Runner-hosted background jobs are not a control-plane call at all: they are
	// forwarded to the local runner over this session's socket (mcp_bg.go).
	if result, handled := s.callBgTool(name, args); handled {
		return result
	}
	// Watches are control-plane calls, but they act for this session and share their argument
	// handling with `orbit watch` (watch_tools.go).
	if result, handled := s.callWatchTool(name, args); handled {
		return result
	}
	// The wiki tools are the same kind of call: they act for this session, and `orbit wiki` runs the
	// same runWikiTool (wiki_tools.go).
	if result, handled := s.callWikiTool(name, args); handled {
		return result
	}
	// So are the file tools: `orbit file` runs the same runFileTool (file_tools.go).
	if result, handled := s.callFileTool(name, args); handled {
		return result
	}
	if s.callTimeout > 0 && s.sessionID != "" && waitsForTheOwner(name, args) {
		return s.handOffOwnerWait(name, args)
	}
	switch name {
	case "task_list":
		limit, err := getBoundedOptionalNumber(args, "limit", maxTaskListLimit)
		if err != nil {
			return toolResult(err.Error(), true)
		}
		if limit == 0 {
			limit = defaultTaskListLimit
		}
		minPriority, err := getOptionalPriority(args, "minPriority")
		if err != nil {
			return toolResult(err.Error(), true)
		}
		raw, err := s.t.listTasks(getString(args, "status"), getString(args, "listId"), getString(args, "projectId"), getStringSlice(args, "labels"), limit, minPriority)
		if err != nil {
			return toolResult("list tasks failed: "+err.Error(), true)
		}
		body := prettyJSON(raw)
		if countJSONArray(raw) >= limit {
			body = fmt.Sprintf("Showing the newest %d tasks; narrow with status/listId/projectId/labels/minPriority or raise limit.\n%s", limit, body)
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

	case "task_evidence_decide":
		id, ok := s.resolveTaskID(args)
		if !ok {
			return toolResult(noTaskMsg, true)
		}
		if strings.TrimSpace(s.sessionID) == "" {
			return toolResult("task_evidence_decide requires an Orbit Session", true)
		}
		decision := getString(args, "decision")
		if decision != "CONFIRM" && decision != "SEND_BACK" {
			return toolResult("decision must be CONFIRM or SEND_BACK", true)
		}
		revision := getString(args, "evidenceRevision")
		if revision == "" {
			return toolResult("evidenceRevision is required: name the revision you are answering", true)
		}
		body := map[string]interface{}{"decision": decision, "evidenceRevision": revision}
		copyIfPresent(body, args, "note")
		raw, err := s.t.decideTaskEvidence(id, s.agentID, s.sessionID, body)
		if err != nil {
			return toolResult("decide task evidence failed: "+err.Error(), true)
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

	case "project_integration_get":
		id := getString(args, "projectId")
		if id == "" {
			return toolResult("projectId is required", true)
		}
		// The acting session is the read's second gate: the line is a project's own work, and the
		// server refuses a session that is not one of the project's. A missing one is refused here
		// rather than sent, so the answer names the reason instead of a bare 403.
		if strings.TrimSpace(s.sessionID) == "" {
			return toolResult("project_integration_get requires an Orbit Session: the line is read as "+
				"a session in the project", true)
		}
		raw, err := s.t.getProjectIntegration(s.sessionID, id,
			getString(args, "jobId"), getNumberAsString(args, "claim"), getNumberAsString(args, "round"),
			getNumberAsString(args, "check"), getString(args, "cursor"), getString(args, "timelineCursor"))
		if err != nil {
			return toolResult("read project integration failed: "+err.Error(), true)
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
		if getString(args, "result") == "ALREADY_MERGED" {
			if err := checkAlreadyMergedSource(getString(args, "sourceSha"), getString(args, "targetBranch"),
				getString(args, "targetShaBefore"), getString(args, "targetShaAfter")); err != nil {
				return toolResult(err.Error(), true)
			}
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
		_, structuredCriteria := args["acceptanceCriteriaItems"]
		body := map[string]interface{}{"title": title}
		copyIfPresent(body, args, "goal", "instructions", "workspaceId")
		if structuredCriteria {
			items, err := normalizeMCPProjectAcceptanceItems(args["acceptanceCriteriaItems"], false)
			if err != nil {
				return toolResult(err.Error(), true)
			}
			body["acceptanceCriteriaItems"] = items
		}
		if declined, err := askBeforeCreate(s.t, s.sessionID, projectCreateApprovalToolName, body); err != nil {
			return toolResult(err.Error(), true)
		} else if declined != "" {
			return toolResult("the human rejected this project: "+declined, false)
		}
		// The calling session goes with it, the same as it does on task_create — here so the
		// server can bind THIS session as the new project's coordinator, which is what makes
		// opening the project later come back to this conversation instead of starting another.
		raw, err := s.t.createProject(s.sessionID, s.orchestrationToken, body)
		if err != nil {
			return toolResult("create project failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "project_update":
		id := getString(args, "projectId")
		if id == "" {
			return toolResult("projectId is required", true)
		}
		_, structuredCriteria := args["acceptanceCriteriaItems"]
		if status, present := args["status"]; present {
			statusText, ok := status.(string)
			if !ok || (statusText != "OPEN" && statusText != "DONE" && statusText != "CANCELLED") {
				return toolResult("status must be OPEN, DONE or CANCELLED", true)
			}
		}
		body := map[string]interface{}{}
		// The same present-only copy task_update uses, and it is what gives each prose field all
		// three outcomes for free: absent stays absent (the project keeps what it states), a string
		// is forwarded as given, and an explicit null survives as null rather than being mistaken
		// for "not supplied" — that last one is the whole clear path.
		copyIfPresent(body, args, "title", "goal", "instructions", "status")
		// The integration line travels as the object it is. Forwarded rather than picked apart here,
		// so the fields the server validates are the fields the caller wrote; the server refuses the
		// whole request when a session is on it, which is every call made through this tool.
		if integration, present := args["integration"]; present {
			settings, ok := integration.(map[string]interface{})
			if !ok {
				return toolResult("integration must be an object", true)
			}
			body["integration"] = settings
		}
		// The explicit non-code mark: true sets it, false clears it. Only a boolean: the server
		// records who wrote it, so an accidental string must not reach it as some other value.
		if nonCode, present := args["nonCode"]; present {
			value, ok := nonCode.(bool)
			if !ok {
				return toolResult("nonCode must be true or false", true)
			}
			body["nonCode"] = value
		}
		// The mark's optional reason travels with it; the server refuses it sent alone.
		if reason, present := args["nonCodeReason"]; present && reason != nil {
			value, ok := reason.(string)
			if !ok {
				return toolResult("nonCodeReason must be a string", true)
			}
			body["nonCodeReason"] = value
		}
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
		// A merge-check change goes to the owner first, and the edit itself goes with the calling
		// session. Not to move anything — the server settles a project's coordinator when it is
		// created — but so the acceptance criteria this body may carry are recorded as THIS
		// conversation's words, a loosening it proposes is filed under this session rather than
		// under the account owner who never asked for it, and a merge check is written against the
		// card this session was answered on rather than against a card filed somewhere else.
		raw, declined, err := updateProjectWithApproval(s.t, s.sessionID, id, body)
		if err != nil {
			return toolResult("update project failed: "+err.Error(), true)
		}
		if declined != "" {
			return toolResult("the owner did not approve this merge-check change: "+declined, false)
		}
		return toolResult(prettyJSON(raw), false)

	case "project_blocker_resolve":
		id := getString(args, "projectId")
		blockerID := getString(args, "blockerId")
		if id == "" || blockerID == "" {
			return toolResult("projectId and blockerId are required", true)
		}
		reason := strings.TrimSpace(getString(args, "reason"))
		if reason == "" {
			return toolResult("reason is required: say why this blocker is no longer blocking. It "+
				"is what the owner is deciding on, and it stays on the row afterwards", true)
		}
		raw, declined, err := resolveBlockerWithApproval(s.t, s.sessionID, id, blockerID, reason)
		if err != nil {
			return toolResult("resolve blocker failed: "+err.Error(), true)
		}
		if declined != "" {
			return toolResult("the human left this blocker open: "+declined, false)
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

	case "project_ensure_coordinator":
		// The door spends a live orchestration credential, so the gate is the same one the session_*
		// tools ride rather than the ungated read/create path the other project tools take.
		if !s.orchestrationEnabled() {
			return toolResult(orchestrationOffMsg, true)
		}
		id := getString(args, "projectId")
		if id == "" {
			return toolResult("projectId is required", true)
		}
		// The acting session IS the authority: the replacement is opened for the conversation that
		// asks, and a session this project points at authenticating the call answers exactly as one
		// that can receive a message does — reused, not rotated away mid-request.
		raw, err := s.t.ensureProjectCoordinator(s.sessionID, s.orchestrationToken, id)
		if err != nil {
			return toolResult("ensure project coordinator failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "project_send":
		// The other half of the same door, and gated the same way: it spends the caller's
		// orchestration credential on a delivery that may open a conversation, so it rides the gate
		// the session_* tools ride rather than the ungated project_* path.
		if !s.orchestrationEnabled() {
			return toolResult(orchestrationOffMsg, true)
		}
		id := getString(args, "projectId")
		message := getString(args, "message")
		if id == "" || message == "" {
			return toolResult("projectId and message are required", true)
		}
		// No sessionId in the body: the PROJECT is the address, and the conversation it resolves to
		// is decided by the server at the moment of delivery. The acting session travels as the
		// header it already is, which is also what makes the delivery the caller's own.
		body := map[string]interface{}{"message": message}
		copyIfPresent(body, args, "clientTurnId")
		copySessionRequestArgs(body, args)
		raw, err := s.t.sendProjectCoordinator(s.sessionID, s.orchestrationToken, id, body)
		if err != nil {
			return toolResult("send to project coordinator failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "ask_owner":
		id := getString(args, "projectId")
		if id == "" {
			return toolResult("projectId is required", true)
		}
		question := strings.TrimSpace(getString(args, "question"))
		if question == "" {
			return toolResult("question is required", true)
		}
		body := map[string]interface{}{"question": question}
		// The options travel as the caller wrote them: the server is what decides whether 0, 2, 3
		// or 4 of them is a question, and picking them apart here would be a second opinion about
		// the same rule.
		copyIfPresent(body, args, "options", "recommendedOption", "ifUnanswered", "clientQuestionId", "forRunQuestion")
		if blocked := getStringSlice(args, "blocksTaskIds"); len(blocked) > 0 {
			body["blocksTaskIds"] = blocked
		}
		// The asking session IS the authority here: the server checks it against the project's own
		// coordinator pointer, so a call made from anywhere else is refused rather than filed.
		raw, err := s.t.askOwner(s.sessionID, id, body)
		if err != nil {
			return toolResult("ask owner failed: "+err.Error(), true)
		}
		return toolResult("The question is with the account owner. Their answer will arrive as a "+
			"message in this conversation; nothing is waiting on this call.\n"+prettyJSON(raw), false)

	case "request_owner_action":
		body, err := ownerRequestBody(args, time.Now())
		if err != nil {
			return toolResult(err.Error(), true)
		}
		// The destination is checked here, on the machine it names, before the owner is asked for anything: a path
		// the runner would refuse to write is a request that could only fail (secret_path.go).
		if spec, ok := body["secretSpec"]; ok {
			if err := checkSecretSpec(spec); err != nil {
				return toolResult("request owner action refused: "+err.Error(), true)
			}
		}
		raw, err := s.t.fileOwnerRequest(s.sessionID, body)
		if err != nil {
			return toolResult("request owner action failed: "+err.Error(), true)
		}
		return toolResult("The request is with the account owner. Its outcome will arrive as a turn in "+
			"this conversation; nothing is waiting on this call.\n"+prettyJSON(raw), false)

	case "withdraw_owner_request":
		id := strings.TrimSpace(getString(args, "requestId"))
		if id == "" {
			return toolResult("requestId is required", true)
		}
		body := map[string]interface{}{}
		if reason := strings.TrimSpace(getString(args, "reason")); reason != "" {
			body["reason"] = reason
		}
		raw, err := s.t.withdrawOwnerRequest(s.sessionID, id, body)
		if err != nil {
			return toolResult("withdraw owner request failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "project_request_start":
		id := getString(args, "projectId")
		if id == "" {
			return toolResult("projectId is required", true)
		}
		body, err := projectStartRequestBody(args)
		if err != nil {
			return toolResult(err.Error(), true)
		}
		// The asking session IS the authority, as it is for ask_owner: the server checks it against
		// the project's own coordinator pointer, so a call made from anywhere else files nothing.
		raw, err := s.t.requestProjectStart(s.sessionID, id, body)
		if err != nil {
			return toolResult(projectStartRequestRefusal(err), true)
		}
		return toolResult(projectStartRequestFiled(raw), false)

	case "project_request_done":
		id := getString(args, "projectId")
		if id == "" {
			return toolResult("projectId is required", true)
		}
		body, err := projectDoneRequestBody(args)
		if err != nil {
			return toolResult(err.Error(), true)
		}
		// The asking session IS the authority, as it is for project_request_start: the server checks
		// it against the project's own coordinator pointer, so a call made from anywhere else files
		// nothing.
		raw, err := s.t.requestProjectDone(s.sessionID, id, body)
		if err != nil {
			return toolResult(projectDoneRequestRefusal(err), true)
		}
		return toolResult(projectDoneRequestFiled(raw), false)

	case "criterion_confirm", "criterion_confirmation_withdraw", "criterion_check_start":
		id := getString(args, "projectId")
		criterionID := getString(args, "criterionId")
		if id == "" || criterionID == "" {
			return toolResult("projectId and criterionId are required", true)
		}
		body := map[string]interface{}{}
		path := "/confirmations"
		switch name {
		case "criterion_confirm":
			copyIfPresent(body, args, "note", "attachmentIds", "revision")
		case "criterion_confirmation_withdraw":
			path = "/confirmations/withdraw"
		case "criterion_check_start":
			path = "/checks"
			copyIfPresent(body, args, "workspaceId", "instructions")
		}
		// The acting session IS the authority: the server checks it against the project's own
		// coordinator pointer, so a call from any other conversation writes nothing.
		raw, err := s.t.criterionConfirmationCall(s.sessionID, id, criterionID, path, body)
		if err != nil {
			return toolResult(name+" failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "criterion_check_report":
		verdict := getString(args, "verdict")
		if verdict != "PASS" && verdict != "FAIL" {
			return toolResult("verdict must be PASS or FAIL", true)
		}
		if s.sessionID == "" {
			return toolResult("criterion_check_report requires an Orbit Session: it reports the check that session is running", true)
		}
		body := map[string]interface{}{"verdict": verdict}
		copyIfPresent(body, args, "note", "attachmentIds")
		raw, err := s.t.reportCriterionCheck(s.sessionID, body)
		if err != nil {
			return toolResult("criterion_check_report failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "open_item_resolve":
		id := getString(args, "projectId")
		itemID := getString(args, "itemId")
		if id == "" || itemID == "" {
			return toolResult("projectId and itemId are required", true)
		}
		note := strings.TrimSpace(getString(args, "note"))
		if note == "" {
			return toolResult("note is required: this door is how an ending the platform could "+
				"not see gets written down, so the sentence you give is the whole of its evidence", true)
		}
		// The acting session IS the authority here, exactly as it is for ask_owner: the server
		// checks it against the project's own coordinator pointer, so a call made from anywhere
		// else is refused rather than closing somebody else's item.
		raw, err := s.t.resolveOpenItem(s.sessionID, id, itemID, note)
		if err != nil {
			return toolResult("resolve open item failed: "+err.Error(), true)
		}
		return toolResult("The item is closed, with your reason on it.\n"+prettyJSON(raw), false)

	case "open_item_hand_over":
		id := getString(args, "projectId")
		itemID := getString(args, "itemId")
		if id == "" || itemID == "" {
			return toolResult("projectId and itemId are required", true)
		}
		note := strings.TrimSpace(getString(args, "note"))
		if note == "" {
			return toolResult("note is required: explain why the coordinator is handing this item to the account owner", true)
		}
		// The acting session IS the authority: the server checks it against the project's coordinator
		// pointer and refuses an item that is already the owner's or a caller from another session.
		raw, err := s.t.handOverOpenItem(s.sessionID, id, itemID, note)
		if err != nil {
			return toolResult("hand over open item failed: "+err.Error(), true)
		}
		return toolResult("The item is now with the account owner, with your explanation on it.\n"+
			prettyJSON(raw), false)

	case "integration_retry":
		id := getString(args, "projectId")
		taskID := getString(args, "taskId")
		promotionID := getString(args, "promotionId")
		if id == "" || (taskID == "") == (promotionID == "") {
			return toolResult("projectId and exactly one of taskId or promotionId are required: taskId for "+
				"a DONE task's failed landing, promotionId for a blocked merge of the project branch into main "+
				"(an item that names no task)", true)
		}
		reason := strings.TrimSpace(getString(args, "reason"))
		if reason == "" {
			return toolResult("reason is required: say why running this landing again will come out "+
				"differently. The platform never reruns a failed landing by itself, so a rerun nobody "+
				"explained is exactly the silent retry it refuses to make", true)
		}
		// The acting session IS the authority, as it is for open_item_resolve: the server checks it
		// against the project's own coordinator pointer, and refuses — with the reason — a landing
		// that is in flight, a failure that is the account owner's, or a task of another project.
		if promotionID != "" {
			raw, err := s.t.retryPromotionCheck(s.sessionID, id, promotionID, reason)
			if err != nil {
				return toolResult("integration retry failed: "+err.Error(), true)
			}
			return toolResult("The candidate's check is queued again, with your reason on it, and your open "+
				"items about it are now being handled: they stay open until the check reports. If it passes "+
				"they are marked handled in your name and the merge goes on as before — the owner's card, or "+
				"the Automatic setting; if it fails, a new item reaches you on its own and these are marked "+
				"superseded.\n"+prettyJSON(raw), false)
		}
		raw, err := s.t.retryIntegration(s.sessionID, id, taskID, reason)
		if err != nil {
			return toolResult("integration retry failed: "+err.Error(), true)
		}
		return toolResult("The next generation of this task's landing is queued, with your reason on it, "+
			"and your open items about the failed one are now being handled: they stay open until it "+
			"reports. If it lands they are marked handled in your name and it goes on to the merge check "+
			"like any landing; if it fails, a new item reaches you on its own and these are marked "+
			"superseded.\n"+prettyJSON(raw), false)

	case "integration_abandon":
		id := getString(args, "projectId")
		jobID := getString(args, "jobId")
		if id == "" || jobID == "" {
			return toolResult("projectId and jobId are required: the job to abandon is one the project's "+
				"runner has stopped reporting on", true)
		}
		reason := strings.TrimSpace(getString(args, "reason"))
		if reason == "" {
			return toolResult("reason is required: say why this job's runner is not coming back. It stays "+
				"on the job as the record of why the work was given up", true)
		}
		// The acting session IS the authority, as it is for integration_retry: the server checks it
		// against the project's own coordinator pointer, and refuses a job that is still reporting
		// (its lease has not expired) or one that is not running at all.
		raw, err := s.t.abandonIntegrationJob(s.sessionID, id, jobID, reason)
		if err != nil {
			return toolResult("integration abandon failed: "+err.Error(), true)
		}
		return toolResult("The job is ended as an error with your reason on it, and nothing is queued "+
			"in its place. If its runner may have pushed, the record says so and the merge may already "+
			"have happened; the next job on this repository and branch can be claimed now.\n"+
			prettyJSON(raw), false)

	case "integration_request_promotion":
		id := getString(args, "projectId")
		reason := strings.TrimSpace(getString(args, "reason"))
		if id == "" || reason == "" {
			return toolResult("projectId and a nonblank reason are required", true)
		}
		raw, err := s.t.requestPromotion(s.sessionID, id, reason)
		if err != nil {
			return toolResult("integration request promotion failed: "+err.Error(), true)
		}
		return toolResult("Promotion request recorded. It remains pending until a candidate is created; normal checks and merge authorization still apply.\n"+prettyJSON(raw), false)

	case "integration_observe":
		id := getString(args, "projectId")
		if id == "" {
			return toolResult("projectId is required: the project whose line Orbit should look at again", true)
		}
		reason := strings.TrimSpace(getString(args, "reason"))
		if reason == "" {
			return toolResult("reason is required: say why the work may be on the line now — what changed "+
				"since Orbit last looked. It stays on the items the observation handles", true)
		}
		// The acting session IS the authority, as it is for integration_retry: the server checks it
		// against the project's own coordinator pointer, and refuses a project with no repository bound.
		raw, err := s.t.observeIntegration(s.sessionID, id, reason)
		if err != nil {
			return toolResult("integration observe failed: "+err.Error(), true)
		}
		return toolResult("An observation of the project's line is queued, with your reason on it (queued: "+
			"false means the one already queued takes it in). Your open items about work not yet seen on the "+
			"line read as being handled until it reports: a task whose commit it sees is recorded as landed, "+
			"its item closes and the tasks waiting on it start; an item about a commit it does not see stays "+
			"open as it was. Read the project again once the observation has run.\n"+prettyJSON(raw), false)

	case "integration_skip_merge_check":
		id := getString(args, "projectId")
		taskID := getString(args, "taskId")
		if id == "" || taskID == "" {
			return toolResult("projectId and taskId are required: the landing whose merge check is to "+
				"be skipped is one DONE task's landing onto this project's own branch", true)
		}
		reason := strings.TrimSpace(getString(args, "reason"))
		if reason == "" {
			return toolResult("reason is required: say why this check should not hold up this landing. "+
				"It is what the account owner decides on, and it stays on the generation that skips the "+
				"check and on every record of it", true)
		}
		// The facts first, before anybody is interrupted: which project and which landing this is,
		// what stopped, and the check command that would be skipped. A card that asked "skip the red
		// check?" would be unanswerable, and an id that names no failed check is refused here rather
		// than in front of a person.
		facts, err := skipMergeCheckFacts(s.t, id, taskID, reason)
		if err != nil {
			return toolResult(err.Error(), true)
		}
		// The card, and nothing else: the account owner's yes is what makes a skip legitimate, and a
		// decline is an answer — the landing stands as it failed and nothing is queued.
		approvalID, declined, err := askForSkipMergeCheck(s.t, s.sessionID, facts)
		if err != nil {
			return toolResult(err.Error(), true)
		}
		if declined != "" {
			return toolResult("the human did not approve skipping this check, and nothing was queued: "+
				declined, false)
		}
		raw, err := s.t.skipIntegrationMergeCheck(s.sessionID, id, taskID, reason, approvalID)
		if err != nil {
			return toolResult("skip merge check failed: "+err.Error(), true)
		}
		return toolResult("One landing is queued again with this project's merge check NOT run — skipped, "+
			"not passed: the generation records the check it skipped, your reason and the card the "+
			"account owner approved it on, and any item it goes on to open carries the same. Nothing "+
			"else changed: the project's own merge check command is untouched, and the next landing and "+
			"every merge into main are checked exactly as before. Your open items about the failed "+
			"check are now being handled: they stay open until it lands.\n"+prettyJSON(raw), false)

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
		copyIfPresent(body, args, "description", "attachmentIds", "listId", "projectId", "fixesOpenItemId", "parentTaskId", "verifiesTaskId", "verification", "acceptanceCriteria", "criterionKey", "codeless", "completionCriterion", "completionCriterionOverrideReason", "ownerConfirmationReason", "ownerConfirmationReasonNote", "acceptanceCommand", "acceptanceExpectedExitCode", "acceptanceTimeoutSeconds", "assigneeId", "dueDate", "runAt", "engine", "provider", "model", "modelHint", "modelHintReason", "dependsOnTaskIds", "autoRunWhenReady", "completionPolicy", "labels", "supersedesTaskId", "handoff")
		// Before the card, so the card's forecast says what the yes will do (task_start_now.go).
		startNow := getBool(args, "startNow")
		if startNow {
			if err := applyStartNow(body, time.Now()); err != nil {
				return toolResult(err.Error(), true)
			}
		}
		if err := requireHandoffNamesItsDestination(body); err != nil {
			return toolResult(err.Error(), true)
		}
		// Default the assignee to the current agent when the caller didn't specify one
		// (an explicit assigneeId, including null to leave it unassigned, is respected).
		if _, ok := body["assigneeId"]; !ok && s.agentID != "" {
			body["assigneeId"] = s.agentID
		}
		if err := requireRunnerTaskCompletionDeclaration(body); err != nil {
			return toolResult(err.Error(), true)
		}
		declined, startAfterCreate, err := askBeforeTaskCreate(s.t, s.sessionID, body)
		if err != nil {
			return toolResult(err.Error(), true)
		} else if declined != "" {
			return toolResult("the human rejected this task: "+declined, false)
		}
		// The owner's "Create and start" does what startNow does. It is their later and explicit
		// answer, so it takes the place of any schedule the agent proposed on the card.
		if startAfterCreate && !startNow {
			body["runAt"] = dueNow(time.Now())
		}
		raw, err := s.t.createTask(s.agentID, s.sessionID, body)
		if err != nil {
			// Verbatim, plus how to ASK when the refusal is the one whose own requiredAction says
			// a handoff may be requested. This is the door where asking gets somewhere.
			return toolResult("create task failed: "+err.Error()+
				crossProjectCrossingGuidance(err), true)
		}
		if startNow || startAfterCreate {
			started, deferred := startCreatedTask(s.t, raw)
			return toolResult(startedTaskResult(raw, started, deferred), false)
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
			copyIfPresent(body, item, "description", "attachmentIds", "listId", "projectId", "fixesOpenItemId", "parentTaskId", "verifiesTaskId", "acceptanceCriteria", "criterionKey", "codeless", "completionCriterion", "completionCriterionOverrideReason", "ownerConfirmationReason", "ownerConfirmationReasonNote", "acceptanceCommand", "acceptanceExpectedExitCode", "acceptanceTimeoutSeconds", "assigneeId", "dueDate", "runAt", "engine", "provider", "model", "modelHint", "modelHintReason", "dependsOnTaskIds", "autoRunWhenReady", "completionPolicy", "labels", "supersedesTaskId", "ref", "dependsOnRefs", "parentRef", "verifiesRef", "handoff")
			// An item's startNow is its schedule alone: runAt = now, which the batch card already
			// counts as starting within the minute. No item is started one by one — the server's
			// once-a-minute scan starts them, so a batch stays one decision about how many runs begin.
			if getBool(item, "startNow") {
				if err := applyStartNow(body, time.Now()); err != nil {
					return toolResult(fmt.Sprintf("tasks[%d]: %s", i, err), true)
				}
			}
			// Per item, because a crossing is per item: one plan can file most of its work at home
			// and one piece of it over the line, and the item that crosses is the one that has to
			// name where it is going.
			if err := requireHandoffNamesItsDestination(body); err != nil {
				return toolResult(fmt.Sprintf("tasks[%d]: %s", i, err), true)
			}
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

	case "task_batch_pin":
		body := map[string]interface{}{}
		copyIfPresent(body, args, "taskIds", "projectId", "listId", "labels", "engine", "provider", "model")
		raw, err := s.t.pinTasksBatch(s.agentID, s.sessionID, body)
		if err != nil {
			// Verbatim. The two refusals this door has of its own are the codes the server sends
			// (PIN_BATCH_NO_SELECTOR, PIN_BATCH_NOTHING_TO_WRITE), and a model that is told only
			// "request failed" retries the same write.
			return toolResult("batch pin failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

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
		copyIfPresent(body, args, "title", "description", "status", "listId", "projectId", "fixesOpenItemId", "assigneeId", "parentTaskId", "verifiesTaskId", "dueDate", "runAt", "engine", "provider", "model", "modelHint", "modelHintReason", "acceptanceCriteria", "criterionKey", "codeless", "codelessReason", "completionCriterion", "completionCriterionOverrideReason", "ownerConfirmationReason", "ownerConfirmationReasonNote", "acceptanceCommand", "acceptanceExpectedExitCode", "acceptanceTimeoutSeconds", "dependsOnTaskIds", "autoRunWhenReady", "priority", "completionPolicy", "verdict", "labels", "supersededByTaskId", "terminalReason", "handoff")
		if len(body) == 0 {
			return toolResult("no fields to update", true)
		}
		if err := requireHandoffNamesItsDestination(body); err != nil {
			return toolResult(err.Error(), true)
		}
		raw, err := s.t.updateTask(s.sessionID, id, body)
		if err != nil {
			// Verbatim, plus the address of the crossing when the refusal is one a projectId move
			// can meet. A model that is told only "request failed" retries the same write.
			return toolResult("update task failed: "+err.Error()+
				crossProjectCrossingGuidance(err), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "task_reopen":
		id, ok := s.resolveTaskID(args)
		if !ok {
			return toolResult(noTaskMsg, true)
		}
		raw, err := s.t.updateTask(s.sessionID, id, reopenTaskBody())
		if err != nil {
			// Verbatim, like task_update: a model told only "request failed" retries the same write,
			// and the refusal block already carries the code and the next step.
			return toolResult("reopen task failed: "+err.Error(), true)
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
		raw, err := s.t.commentTask(id, s.agentID, s.sessionID, body)
		if err != nil {
			return toolResult("comment failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "task_request_confirmation":
		id, ok := s.resolveTaskID(args)
		if !ok {
			return toolResult(noTaskMsg, true)
		}
		// The declaration is the run's own statement, taken only from the task's own execution
		// session while it is in a turn — so a call with no session has nothing to declare with.
		if strings.TrimSpace(s.sessionID) == "" {
			return toolResult("task_request_confirmation requires an Orbit task Session", true)
		}
		raw, err := s.t.claimOwnerConfirmation(id, s.agentID, s.sessionID)
		if err != nil {
			return toolResult("declare the task finished failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "task_confirmation_review", "task_confirmation_return":
		return s.answerConfirmationReview(name, args)

	case "task_progress_report":
		id, ok := s.resolveTaskID(args)
		if !ok {
			return toolResult(noTaskMsg, true)
		}
		text, err := runTaskProgressTool(s.t, id, args)
		if err != nil {
			return toolResult(err.Error(), true)
		}
		return toolResult(text, false)

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

	case "provider_create":
		body := map[string]interface{}{}
		copyIfPresent(body, args, "label", "runtime", "baseUrl", "apiKey", "models", "defaultModel")
		for _, required := range providerCreateRequired(body) {
			if _, ok := body[required]; !ok {
				return toolResult(required+" is required", true)
			}
		}
		if declined, err := askBeforeCreate(s.t, s.sessionID, providerCreateApprovalToolName, providerCard("", body)); err != nil {
			return toolResult(err.Error(), true)
		} else if declined != "" {
			return toolResult("the human rejected this provider: "+declined, false)
		}
		raw, err := s.t.createProvider(body)
		if err != nil {
			return toolResult("create provider failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "provider_update":
		slug := getString(args, "slug")
		if slug == "" {
			return toolResult("slug is required", true)
		}
		body := map[string]interface{}{}
		copyIfPresent(body, args, "label", "runtime", "baseUrl", "apiKey", "models", "defaultModel")
		if len(body) == 0 {
			return toolResult("no fields to update", true)
		}
		if declined, err := askBeforeCreate(s.t, s.sessionID, providerUpdateApprovalToolName, providerCard(slug, body)); err != nil {
			return toolResult(err.Error(), true)
		} else if declined != "" {
			return toolResult("the human rejected this change: "+declined, false)
		}
		raw, err := s.t.updateProvider(slug, body)
		if err != nil {
			return toolResult("update provider failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "provider_delete":
		slug := getString(args, "slug")
		if slug == "" {
			return toolResult("slug is required", true)
		}
		if declined, err := askBeforeCreate(s.t, s.sessionID, providerDeleteApprovalToolName, providerCard(slug, nil)); err != nil {
			return toolResult(err.Error(), true)
		} else if declined != "" {
			return toolResult("the human rejected this deletion: "+declined, false)
		}
		raw, err := s.t.deleteProvider(slug)
		if err != nil {
			return toolResult("delete provider failed: "+err.Error(), true)
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

	case "schedule_wakeup":
		// No session id to take: a wakeup is always for the session this server runs in.
		if s.sessionID == "" {
			return toolResult("schedule_wakeup wakes the session it is called from, and this MCP server is not running inside one", true)
		}
		body, refused := scheduleWakeupBody(args)
		if refused != "" {
			return toolResult(refused, true)
		}
		loop := body["recurring"] == true
		receipt, err := s.t.scheduleWakeup(s.sessionID, body)
		if err != nil {
			if loop && scheduleWakeupLoopReadAsOneShot(err) {
				return toolResult("schedule_wakeup failed: "+scheduleWakeupNoLoops+". It read the call as one wakeup, which needs "+
					"delaySeconds and reason, and refused it: nothing was scheduled. "+scheduleWakeupNoLoopsAdvice+"\n"+err.Error(), true)
			}
			return toolResult("schedule_wakeup failed: "+err.Error(), true)
		}
		switch {
		case receipt.Outcome == "CANCELLED":
			return toolResult(scheduledWakeupStopNote(receipt), false)
		case loop && !receipt.Recurring:
			// Never reported as a loop: no loop is running, and the agent has to know it.
			return toolResult(scheduledWakeupLoopRefusedNote(receipt), true)
		case loop:
			return toolResult(scheduledWakeupLoopNote(receipt), false)
		}
		var note strings.Builder
		fmt.Fprintf(&note, "Wakeup scheduled for %s (in %ds)", receipt.DueAt, receipt.DelaySeconds)
		if receipt.Clamped {
			note.WriteString(", clamped to [60, 3600]")
		}
		if receipt.Replaced {
			note.WriteString(", replacing the one that was pending")
		}
		note.WriteString(". Orbit's server holds it: when it is due, a turn starts in this session even if this engine has been recycled by then. Nothing more to do this turn.")
		return toolResult(note.String(), false)

	case "session_create":
		if !s.orchestrationEnabled() {
			return toolResult(orchestrationOffMsg, true)
		}
		prompt := getString(args, "prompt")
		if prompt == "" {
			return toolResult("prompt is required", true)
		}
		body := map[string]interface{}{"prompt": prompt}
		copyIfPresent(body, args, "title", "model", "engine", "provider", "permissionMode")
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
		// Sent only when true. Omitted, the request is the one every installed client sends, so a
		// server that predates the flag cannot read anything into its absence.
		if getBool(args, "resumeIfEnded") {
			body["resumeIfEnded"] = true
		}
		copySessionRequestArgs(body, args)
		raw, err := s.t.sendSessionMessage(s.sessionID, s.orchestrationToken, id, body)
		if err != nil {
			return toolResult("send message failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "session_reply":
		if !s.orchestrationEnabled() {
			return toolResult(orchestrationOffMsg, true)
		}
		requestID := getString(args, "requestId")
		if requestID == "" {
			return toolResult("requestId is required", true)
		}
		message, messageSet := args["message"].(string)
		var option *int
		if _, given := args["option"]; given && args["option"] != nil {
			chosen := getNumber(args, "option")
			option = &chosen
		}
		if strings.TrimSpace(message) == "" && option == nil && args["answers"] == nil {
			return toolResult("give answers for a run question, or option (the index of the answer you choose), message, or both", true)
		}
		body := sessionReplyBody(message, messageSet, option)
		copyIfPresent(body, args, "answers")
		raw, err := s.t.sendSessionReply(s.sessionID, s.orchestrationToken, requestID, body)
		if err != nil {
			return toolResult("reply failed: "+err.Error(), true)
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
		wait, err := getBoundedOptionalNumber(args, "waitSeconds", maxMergeWaitSeconds)
		if err != nil {
			return toolResult(err.Error(), true)
		}
		// A wait the engine cuts short would report a merge that then lands as a failed call. Running
		// out of a shorter wait is not a failure and says so (merge_receipts has the outcome).
		if longest := int(longestInlineWait(s.callTimeout) / time.Second); s.callTimeout > 0 && wait > longest {
			wait = longest
		}
		body := map[string]interface{}{}
		copyIfPresent(body, args, "targetBranch")
		if wait > 0 {
			body["waitSeconds"] = wait
		}
		// The client deadline has to outlast the wait the server was asked to take, or the answer
		// comes back as "context deadline exceeded" instead of as the outcome.
		raw, err := s.t.mergeSession(s.sessionID, s.orchestrationToken, id, body, mergeCallTimeout(wait))
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

	case "runner_list":
		if !s.orchestrationEnabled() {
			return toolResult(orchestrationOffMsg, true)
		}
		raw, err := s.t.listRunners(s.sessionID, s.orchestrationToken)
		if err != nil {
			return toolResult("list runners failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "runner_engine_install":
		if !s.orchestrationEnabled() {
			return toolResult(orchestrationOffMsg, true)
		}
		runnerID, engine := getString(args, "runnerId"), getString(args, "engine")
		if runnerID == "" || engine == "" {
			return toolResult("runnerId and engine are required", true)
		}
		mode := "install"
		if getBool(args, "update") {
			mode = "update"
		}
		raw, err := s.t.requestEngineInstall(s.sessionID, s.orchestrationToken, runnerID, engine, mode)
		if err != nil {
			return toolResult("request the "+mode+" failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "runner_engine_install_status":
		if !s.orchestrationEnabled() {
			return toolResult(orchestrationOffMsg, true)
		}
		runnerID := getString(args, "runnerId")
		if runnerID == "" {
			return toolResult("runnerId is required", true)
		}
		raw, err := s.t.engineInstallState(s.sessionID, s.orchestrationToken, runnerID)
		if err != nil {
			return toolResult("read the install status failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "runner_delete":
		if !s.orchestrationEnabled() {
			return toolResult(orchestrationOffMsg, true)
		}
		runnerID := getString(args, "runnerId")
		if runnerID == "" {
			return toolResult("runnerId is required", true)
		}
		if err := validatePathSegmentID(runnerID); err != nil {
			return toolResult("runner "+err.Error(), true)
		}
		if declined, err := askBeforeCreate(s.t, s.sessionID, runnerDeleteApprovalToolName, map[string]interface{}{"runnerId": runnerID}); err != nil {
			return toolResult(err.Error(), true)
		} else if declined != "" {
			return toolResult("the human rejected this deletion, and nothing was deleted: "+declined, false)
		}
		raw, err := s.t.deleteRunner(s.sessionID, s.orchestrationToken, runnerID)
		if err != nil {
			return toolResult("delete runner failed: "+err.Error(), true)
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
		if declined, err := askBeforeAgentWrite(s.t, s.sessionID, "", body); err != nil {
			return toolResult(err.Error(), true)
		} else if declined != "" {
			return toolResult("the human rejected this write, and nothing was written: "+declined, false)
		}
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
		if declined, err := askBeforeAgentWrite(s.t, s.sessionID, id, body); err != nil {
			return toolResult(err.Error(), true)
		} else if declined != "" {
			return toolResult("the human rejected this write, and nothing was written: "+declined, false)
		}
		raw, err := s.t.updateAgent(s.sessionID, s.orchestrationToken, id, body)
		if err != nil {
			return toolResult("update agent failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(raw), false)

	case "agent_delete":
		if !s.orchestrationEnabled() {
			return toolResult(orchestrationOffMsg, true)
		}
		id := getString(args, "agentId")
		if id == "" {
			return toolResult("agentId is required", true)
		}
		if err := validatePathSegmentID(id); err != nil {
			return toolResult("agent "+err.Error(), true)
		}
		if declined, err := askBeforeCreate(s.t, s.sessionID, agentDeleteApprovalToolName, map[string]interface{}{"agentId": id}); err != nil {
			return toolResult(err.Error(), true)
		} else if declined != "" {
			return toolResult("the human rejected this deletion, and nothing was deleted: "+declined, false)
		}
		raw, err := s.t.deleteAgent(s.sessionID, s.orchestrationToken, id)
		if err != nil {
			return toolResult("delete agent failed: "+err.Error(), true)
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

// taskCreateApprovalToolName and projectCreateApprovalToolName key the cards for the two single
// creates. The owner asked that nothing be created on their behalf without their saying yes first,
// so from inside a session every create is asked: one task, a batch, or a project alike.
const (
	taskCreateApprovalToolName    = "orbit_task_create"
	projectCreateApprovalToolName = "orbit_project_create"
)

// blockerResolveApprovalToolName keys the card that ends a project blocker.
//
// Not a create, and here for the opposite reason the creates are: a blocker is the project SAYING it
// needs a person, and `required_action` is addressed to one. So the agent's part is to argue that the
// condition is gone and the owner's part is to agree or not — which is what this card is, and why the
// tool cannot be reached without one.
const blockerResolveApprovalToolName = "orbit_blocker_resolve"

// integrationSkipMergeCheckApprovalToolName keys the card that lets ONE landing run without its
// merge check (docs/project-integration-line-contract.md §2.4 J-S5).
//
// A different question from every other card here: nothing is created and no wait is ended. What the
// account owner answers is whether this one landing may go on with the check that just failed taken
// off it — and the server reads the card back by id when the skip is asked for, so a card filed
// under any other name opens nothing, and neither does one raised about another task.
//
// Its neighbour below is the OTHER half of the same subject, and they are deliberately two cards:
// a skip is one landing going on unchecked, a change is every later landing being checked by
// something else. "Let this one through" and "stop running that command" are different decisions,
// and an owner who grants one has not granted the other.
const integrationSkipMergeCheckApprovalToolName = "orbit_integration_skip_merge_check"

// projectIntegrationApprovalToolName keys the card that lets a session change a project's MERGE
// CHECK.
//
// A third reason again, and it is the line between two decisions that travel in one object. Where a
// project's work LANDS is the account owner's (contract L5) and stays theirs: a session sending a
// line field is refused whatever anybody answers. What is CHECKED on the combined tree before a
// landing is a judgement the session holding a failing check is the one that can make, so it is
// asked about rather than forbidden — and the card is what the server matches the write against
// (`projects/project-integration-approval.ts`), which is why the two ends spell this name the same
// way and why a proposal the owner did not read cannot be written.
const projectIntegrationApprovalToolName = "orbit_project_update_integration"

// ownerWaitTools are the calls that put a card in front of the owner and block until it is answered.
var ownerWaitTools = map[string]bool{
	"task_create": true, "task_create_batch": true, "project_create": true, "project_blocker_resolve": true,
	"tasklist_propose_dag": true, "provider_create": true, "provider_update": true, "provider_delete": true,
	"integration_skip_merge_check": true, "runner_delete": true, "agent_delete": true,
}

// The merge-check fields, in the spelling the server's DTO and the card both use. Everything else
// in an integration object — the line (`line`, `projectBranchName`, `upstreamRef`) and anything a
// later version adds — belongs to the account owner, which is what `mergeCheckProposal` says by
// refusing to cover it.
var integrationMergeCheckFields = []string{"mergeCheckCommand", "mergeCheckTimeoutSeconds", "landingCheckCommand", "landingCheckTimeoutSeconds"}

// waitsForTheOwner says whether a call puts a card in front of the owner and blocks until it is
// answered.
func waitsForTheOwner(name string, args map[string]interface{}) bool {
	if name == "agent_create" || name == "agent_update" {
		return agentWriteNeedsCard(args)
	}
	if name == "project_update" {
		// An update asks only when it proposes a merge check and nothing else. A title, a goal or a
		// set of instructions is an agent's own to write; a LINE field is refused by the server
		// whatever the owner answers, and a card for it would interrupt them with a question that
		// cannot change anything.
		_, gated := mergeCheckProposal(integrationSettingsOf(args))
		return gated
	}
	// A dry-run batch writes nothing and asks nobody (task_create_batch).
	return ownerWaitTools[name] && !(name == "task_create_batch" && getBool(args, "dryRun"))
}

// handOffOwnerWait runs a call that waits for the owner in a runner-hosted job instead of in this one,
// when the engine ends tool calls on a deadline of its own (envMCPCallTimeout).
//
// A person can take longer than that deadline. Held here, the engine would tell the model the call
// failed while this process went on waiting, and the write would still happen once the owner
// confirmed: a failure the model acts on, and a side effect it never hears of. Cancelling on the
// engine's say-so cannot fix that alone — the card is already on the owner's screen. So the call
// returns at once, saying truthfully that nothing is written yet, and the job runs the very same call
// (the same `orbit mcp`, this session's identity, its card naming the job so it outlives the turn).
// When the owner answers, the job exits with what the call would have returned and wakes the session.
// Without a job service to hand it to, the call is refused before any card is filed.
func (s *mcpServer) handOffOwnerWait(name string, args map[string]interface{}) map[string]interface{} {
	refuse := func(why string) map[string]interface{} {
		return toolResult(fmt.Sprintf("%s was not run, and nothing was filed or written: it waits for the owner's "+
			"confirmation, which can take longer than this engine lets a tool call run (%s), so it cannot be held "+
			"in this call, and %s. Ask the owner in the conversation instead.", name, s.callTimeout, why), true)
	}
	socket, token := os.Getenv(envBgSocket), os.Getenv(envBgToken)
	if socket == "" || token == "" {
		return refuse("this session has no runner-hosted background job service to hand the wait to")
	}
	// Its own operation, not `run`: the gate on `run` is about commands, and this is a question put to a
	// person, which Plan and Don't Ask may do (bgJobService.startOwnerWait).
	raw, err := bgSocketCall(socket, token, "owner_wait", map[string]interface{}{"tool": name, "arguments": args})
	if err != nil {
		return refuse("handing the wait to a runner-hosted job failed: " + err.Error())
	}
	var job struct {
		JobID string `json:"jobId"`
	}
	_ = json.Unmarshal(raw, &job)
	return toolResult(fmt.Sprintf("Not done yet — handed to runner-hosted job %s. %s waits for the owner's "+
		"confirmation, which can take longer than this engine lets a tool call run (%s), so that job asks them and "+
		"waits instead of this call. Nothing is written unless the owner confirms; if they do, the job performs the "+
		"write itself. Do not call %s again for the same thing. When the owner answers, the job exits and Orbit "+
		"wakes this session with its output: the JSON-RPC reply carrying exactly what this call would have "+
		"returned (what was created, or the refusal). If there is nothing else to do, end your turn; bg_output "+
		"reads the job at any time.\n%s", job.JobID, name, s.callTimeout, name, prettyJSON(raw)), false)
}

// askBeforeCreate files a card for a create and blocks until the human answers it. It returns
// declined == "" for a yes, and otherwise the reason to hand back in place of the write. The MCP
// tools and the CLI both call it, so an agent refused at one door does not find the other open.
//
// Headless (no session) there is nobody to ask and no card to show, so the write goes ahead as it
// always has. Anything but a yes writes nothing — a denial, an abandoned card, a status this runner
// does not know — and a transport failure is never a silent yes: it is polled again (see
// approvalPollIsAnswered), because the card is already in front of a human.
func askBeforeCreate(t *Transport, sessionID, toolName string, input interface{}) (declined string, err error) {
	dec, err := askCreateCard(t, sessionID, toolName, input, nil)
	if err != nil || dec == nil {
		return "", err
	}
	return declinedReason(dec), nil
}

// askBeforeTaskCreate is askBeforeCreate for a single task create, the one card whose yes can carry a
// second choice: the owner's "Create and start" (startAfterCreate), which asks for the task to be
// started as soon as it is written (task_start_now.go). Anything but a yes carries no start.
//
// The card says that this asker acts on that choice (acceptsStartAfterCreate, beside the input, never
// in the body the create sends). Clients offer the button, and the server takes the choice, only on a
// card that says so — a runner that predates it would read the yes and only create the task.
func askBeforeTaskCreate(t *Transport, sessionID string, body map[string]interface{}) (declined string, startAfterCreate bool, err error) {
	dec, err := askCreateCard(t, sessionID, taskCreateApprovalToolName, body,
		map[string]interface{}{"acceptsStartAfterCreate": true})
	if err != nil || dec == nil {
		return "", false, err
	}
	if declined := declinedReason(dec); declined != "" {
		return declined, false, nil
	}
	return "", dec.StartAfterCreate, nil
}

// declinedReason is "" for a yes, and otherwise what to hand back in place of the write.
func declinedReason(dec *ApprovalDecisionResponse) string {
	if dec.Status == "ALLOWED" {
		return ""
	}
	if dec.Message != "" {
		return dec.Message
	}
	return "denied by the user"
}

// askCreateCard files the card and waits for its answer; nil, with nothing filed, when headless.
// declares are fields of the filing beside the input: what this asker says about itself.
func askCreateCard(t *Transport, sessionID, toolName string, input interface{}, declares map[string]interface{}) (*ApprovalDecisionResponse, error) {
	if sessionID == "" {
		return nil, nil
	}
	body := map[string]interface{}{
		"toolName": toolName,
		"input":    input,
	}
	for key, value := range declares {
		body[key] = value
	}
	// Who is asking, when it is a runner-hosted job rather than the turn: this loop is a process
	// that goes on polling after the turn ends, so the server must not collect the card when the
	// turn does (apiserver sessions/abandoned-approvals.ts). The runner exported the id to this
	// process's environment; an in-turn MCP call has none, and its card is collected with the turn
	// exactly as it always was.
	if jobID := strings.TrimSpace(os.Getenv(envBgJobID)); jobID != "" {
		body["backgroundJobId"] = jobID
	}
	id, err := t.createApproval(context.Background(), sessionID, body)
	if err != nil {
		return nil, fmt.Errorf("could not register approval: %w", err)
	}
	// Unbounded, exactly like permissionPrompt: this asks a human who may be asleep, and a deadline
	// here would turn "not answered yet" into a refusal nobody gave.
	dec, err := awaitApprovalDecision(context.Background(), t, sessionID, id)
	if err != nil {
		return nil, fmt.Errorf("approval poll failed: %w", err)
	}
	return dec, nil
}

// awaitApprovalDecision reads a card until it is no longer PENDING, and is the one loop every reader
// of an approval waits in — the Claude permission prompt, the Codex and Kimi bridges, the DAG card
// and the create cards. A failed poll that says nothing about the card (approvalPollIsAnswered) is
// waited out and the card read again; one that does answer it ends the wait with its error, and so
// does ctx. There is no other bound: the card is a human's to answer, and they may be asleep.
//
// One loop because the rule has to be the same everywhere, and a copy is where it went missing:
// 2026-09-16 put the retry into the create cards' loop alone, and on 2026-09-26 the permission
// prompt's own loop still ended on a deploy's first 502 — the engine asked again, the owner
// approved the second card, and the first sat PENDING on the conversation's row.
func awaitApprovalDecision(ctx context.Context, t *Transport, sessionID, approvalID string) (*ApprovalDecisionResponse, error) {
	for {
		dec, err := t.pollApproval(ctx, sessionID, approvalID)
		if err == nil {
			if dec.Status != "PENDING" {
				return dec, nil
			}
			continue // the server's long-poll window elapsed undecided
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if approvalPollIsAnswered(err) {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(approvalPollRetryDelay):
		}
	}
}

// How long to wait before reading a card again after a failure that said nothing about it. Small,
// because the door is usually back within one restart; a variable so a test can shrink it.
var approvalPollRetryDelay = 2 * time.Second

// approvalPollIsAnswered says whether a failed poll ANSWERED the question this loop is asking —
// "is this card still a live question?" — and is therefore a reason to stop reading it.
//
// Two cases and no others. A refusal from the door IS that answer: a 404 for a card that is gone, a
// 403 for a session that is no longer this runner's. Asking again can only repeat it. Everything
// else — no response at all, a 5xx, a timeout — says nothing about the card, which is still filed
// and still on somebody's screen with its buttons live.
//
// Giving up on that second kind is what 2026-09-16 looked like: one 502 while the apiserver was
// being restarted ended this loop, the row stayed PENDING with nothing left to read it, and the
// agent — correctly, having been handed an error — filed a second card. The human then had two
// identical cards, answered the older one, and nothing happened. So a failure that says nothing
// leaves the card alone and this loop keeps reading it: the card and the loop that consumes its
// answer live and die together, which is the property every reader of an approval assumes.
func approvalPollIsAnswered(err error) bool {
	httpErr, answered := err.(*transportHTTPError)
	return answered && httpErr.statusCode >= 400 && httpErr.statusCode < 500
}

// askBeforeBatch is askBeforeCreate for a batch, whose card carries the server-computed preview:
// fifty titles say nothing, and the counts — above all how many start running within the minute —
// are what the human is actually deciding on.
func askBeforeBatch(t *Transport, agentID, sessionID string, bodies []map[string]interface{}) (declined string, err error) {
	if sessionID == "" {
		return "", nil
	}
	preview, err := t.batchPreview(agentID, sessionID, map[string]interface{}{"tasks": bodies})
	if err != nil {
		return "", fmt.Errorf("batch preview failed: %w", err)
	}
	return askBeforeCreate(t, sessionID, batchApprovalToolName, map[string]interface{}{
		"tasks":   bodies,
		"preview": json.RawMessage(preview),
	})
}

// createBatchWithApproval puts a batch of new tasks in front of a human before writing any of it.
//
// This is the tool that builds a DAG, and it is the most consequential thing an agent does here
// while looking like the least: fifty titles say nothing, and what actually happens is some number
// of runs starting within the minute. This deployment has the cautionary case — one session
// created 43 lists and ~21,500 tasks before anybody looked.
func (s *mcpServer) createBatchWithApproval(bodies []map[string]interface{}) map[string]interface{} {
	declined, err := askBeforeBatch(s.t, s.agentID, s.sessionID, bodies)
	if err != nil {
		return toolResult(err.Error(), true)
	}
	if declined != "" {
		return toolResult("the human rejected this batch: "+declined, false)
	}
	return s.createBatchNow(map[string]interface{}{"tasks": bodies})
}

func (s *mcpServer) createBatchNow(body map[string]interface{}) map[string]interface{} {
	raw, err := s.t.createTasksBatch(s.agentID, s.sessionID, body)
	if err != nil {
		return toolResult("create tasks failed: "+err.Error()+
			crossProjectCrossingGuidance(err), true)
	}
	return toolResult(prettyJSON(raw), false)
}

// One open blocker as the confirmation card reads it, taken from the project read. Only the fields
// a person decides on: what kind of wait this is, what it asked for, and what it is about.
type blockerCardFacts struct {
	ID             string `json:"id"`
	Kind           string `json:"kind"`
	Owner          string `json:"owner"`
	Severity       string `json:"severity"`
	RequiredAction string `json:"requiredAction"`
	SubjectType    string `json:"subjectType"`
	SubjectTitle   string `json:"subjectTitle"`
	FirstSeenAt    string `json:"firstSeenAt"`
}

// resolveBlockerWithApproval ends one open blocker, and only after the account owner says so.
//
// The card is built from the project read rather than from what the caller typed: an agent that
// passes the wrong id would otherwise put a card in front of a person that names a blocker nobody
// can see, and "resolve 3x1o4llO…?" is not a question anyone can answer. So the blocker is looked up
// first, the card carries what it asked for beside the agent's argument that it no longer applies,
// and an id that names no OPEN blocker is refused here — before a human is interrupted with it.
//
// Headless there is no session, no card and nobody to ask, and the write goes straight through: that
// caller is the owner operating their own machine, which is the same rule every create here follows.
func resolveBlockerWithApproval(t *Transport, sessionID, projectID, blockerID, reason string) (raw json.RawMessage, declined string, err error) {
	if sessionID != "" {
		facts, projectTitle, err := openBlockerFacts(t, projectID, blockerID)
		if err != nil {
			return nil, "", err
		}
		declined, err := askBeforeCreate(t, sessionID, blockerResolveApprovalToolName, map[string]interface{}{
			"projectId":    projectID,
			"projectTitle": projectTitle,
			"blockerId":    blockerID,
			"reason":       reason,
			"blocker":      facts,
		})
		if err != nil {
			return nil, "", err
		}
		if declined != "" {
			return nil, declined, nil
		}
	}
	raw, err = t.resolveProjectBlocker(projectID, blockerID, map[string]interface{}{"reason": reason})
	return raw, "", err
}

// integrationSettingsOf reads an update's `integration` object, when it carries one.
func integrationSettingsOf(args map[string]interface{}) map[string]interface{} {
	settings, _ := args["integration"].(map[string]interface{})
	return settings
}

// mergeCheckCardRequired says whether this body has to be put in front of the owner before it is
// sent — the condition `waitsForTheOwner` applies to the tool's own arguments.
func mergeCheckCardRequired(body map[string]interface{}) bool {
	_, gated := mergeCheckProposal(integrationSettingsOf(body))
	return gated
}

func isMergeCheckField(key string) bool {
	for _, field := range integrationMergeCheckFields {
		if key == field {
			return true
		}
	}
	return false
}

// mergeCheckProposal returns the merge-check fields `settings` names — the whole of what a card is
// about — and whether this object is one a card can cover at all.
//
// An object that names a line field, or any other field this session does not write, is not: the
// server refuses that request whatever the owner answers, so a card for it would be a question with
// no yes that changes anything. A key present with a null value counts as named, exactly as it does
// on the server, where `null` is a setting ("put the timeout back to its default") rather than an
// absence.
func mergeCheckProposal(settings map[string]interface{}) (map[string]interface{}, bool) {
	proposal := map[string]interface{}{}
	for _, field := range integrationMergeCheckFields {
		if value, present := settings[field]; present {
			proposal[field] = value
		}
	}
	if len(proposal) == 0 {
		return nil, false
	}
	for key := range settings {
		if !isMergeCheckField(key) {
			return nil, false
		}
	}
	return proposal, true
}

// skipMergeCheckFacts reads what the skip card is decided on, before any card is filed: the project
// and the landing it names, what that landing stopped on, and the check command that would be
// skipped. The project read carries the check (`integration.mergeCheckCommand`) and the task read
// carries the landing's own sentence (`integration.blockingReason.summary`), which is where both are
// written for a person already.
//
// It refuses here — without interrupting anybody — when the landing is not one this door answers: a
// task that is not DONE, one whose newest landing never failed, or one that stopped on something
// other than a check. That is not a substitute for the server's own decision (the server re-reads
// every fact under the task's row lock); it is so that a person is never shown a card for a skip
// that cannot be queued.
func skipMergeCheckFacts(t *Transport, projectID, taskID, reason string) (map[string]interface{}, error) {
	projectRaw, err := t.getProject(projectID)
	if err != nil {
		return nil, fmt.Errorf("read project %s: %w", projectID, err)
	}
	var project struct {
		Title       string `json:"title"`
		Integration struct {
			MergeCheckCommand   string  `json:"mergeCheckCommand"`
			LandingCheckCommand *string `json:"landingCheckCommand"`
			// The project's main branch by name, which the card's note says every merge into is
			// still checked; null with no repository bound.
			UpstreamRef *string `json:"upstreamRef"`
		} `json:"integration"`
	}
	if err := json.Unmarshal(projectRaw, &project); err != nil {
		return nil, fmt.Errorf("read project %s: %w", projectID, err)
	}
	taskRaw, err := t.getTask(taskID)
	if err != nil {
		return nil, fmt.Errorf("read task %s: %w", taskID, err)
	}
	var task struct {
		Title       string `json:"title"`
		Status      string `json:"status"`
		ProjectID   string `json:"projectId"`
		Integration struct {
			State    string `json:"state"`
			LandTask *struct {
				State          string `json:"state"`
				Phase          string `json:"phase"`
				Generation     string `json:"generation"`
				BlockingReason *struct {
					Code    string `json:"code"`
					Summary string `json:"summary"`
				} `json:"blockingReason"`
			} `json:"landTask"`
		} `json:"integration"`
	}
	if err := json.Unmarshal(taskRaw, &task); err != nil {
		return nil, fmt.Errorf("read task %s: %w", taskID, err)
	}
	if task.ProjectID != "" && task.ProjectID != projectID {
		return nil, fmt.Errorf("task %s is not filed under project %s: a project's coordinator skips a "+
			"check on its own project's landings", taskID, projectID)
	}
	if task.Status != "DONE" {
		return nil, fmt.Errorf("task %s is %s, not DONE: a landing delivers a finished task's work, so "+
			"there is no finished delivery whose check could be taken off", taskID, task.Status)
	}
	// A check that ran out of its budget is the same state from here: the runner records it as
	// CHECK_FAILED with `timedOut` on the check it killed, so one state covers both and the class the
	// server decides on is read off that column there.
	landing := task.Integration.LandTask
	if landing == nil || landing.State != "CHECK_FAILED" {
		what := "no landing on this project's integration line"
		if landing != nil {
			what = fmt.Sprintf("its newest landing is %s", landing.State)
		}
		if landing != nil && landing.State == "ERROR" {
			return nil, fmt.Errorf("task %s: %s. The integration machinery stopped rather than a check "+
				"disagreeing, and there is no check to skip: run the landing again with integration_retry "+
				"and say what changed", taskID, what)
		}
		return nil, fmt.Errorf("task %s: %s. A merge check is skipped only where a check RAN and its "+
			"result is not accepted, so there is nothing for this door to take off: read the landing's "+
			"own item, or the project's integration read", taskID, what)
	}
	checkCommand := project.Integration.MergeCheckCommand
	if project.Integration.LandingCheckCommand != nil {
		checkCommand = *project.Integration.LandingCheckCommand
	}
	if checkCommand == "" {
		return nil, fmt.Errorf("project %s has no merge check command, so this landing was never stopped "+
			"by one and there is nothing to skip", projectID)
	}
	summary := ""
	if landing.BlockingReason != nil {
		summary = landing.BlockingReason.Summary
	}
	return map[string]interface{}{
		"projectId":    projectID,
		"projectTitle": project.Title,
		"taskId":       taskID,
		"taskTitle":    task.Title,
		// The command that would NOT run, verbatim: the decision is about that command, and a card
		// that paraphrased it would be asking about something nobody can see.
		"checkCommand": checkCommand,
		"failure":      summary,
		"generation":   landing.Generation,
		"reason":       reason,
		"mainBranch":   project.Integration.UpstreamRef,
	}, nil
}

// askForSkipMergeCheck files the skip card and returns its id once the account owner has answered it,
// with declined != "" when the answer was no.
//
// The id is the whole reason this does not go through askBeforeCreate, which answers only yes or no:
// the card IS the approval as far as the server is concerned — the skip is refused unless it names an
// ALLOWED card raised by this same conversation about this same landing — so the id has to travel
// with the call. Headless there is no session and nobody to ask, and it returns empty: that caller is
// the owner operating their own machine, and their own door takes no card (see the CLI).
func askForSkipMergeCheck(t *Transport, sessionID string, facts map[string]interface{}) (approvalID, declined string, err error) {
	if sessionID == "" {
		return "", "", nil
	}
	body := map[string]interface{}{
		"toolName": integrationSkipMergeCheckApprovalToolName,
		"input":    facts,
	}
	// As for every other card: a runner-hosted job outlives the turn it was raised in, and the server
	// must know that when it decides whether the card still has a reader.
	if jobID := strings.TrimSpace(os.Getenv(envBgJobID)); jobID != "" {
		body["backgroundJobId"] = jobID
	}
	id, err := t.createApproval(context.Background(), sessionID, body)
	if err != nil {
		return "", "", fmt.Errorf("could not register approval: %w", err)
	}
	dec, err := awaitApprovalDecision(context.Background(), t, sessionID, id)
	if err != nil {
		return "", "", fmt.Errorf("approval poll failed: %w", err)
	}
	if dec.Status == "ALLOWED" {
		return id, "", nil
	}
	if dec.Message != "" {
		return id, dec.Message, nil
	}
	return id, "denied by the user", nil
}

// projectMergeCheckCard is the card the owner answers before a merge check moves: which project,
// what the check is now, and what it would become.
//
// The two CURRENT values come from the project read rather than from the caller, for the reason
// `openBlockerFacts` reads the blocker: the card's whole job is to say what is being changed, and an
// agent's recollection of the value it is changing is exactly the thing a person is there to check.
// The proposed values are the caller's own, because they are the request.
func projectMergeCheckCard(t *Transport, projectID string, proposal map[string]interface{}) (map[string]interface{}, error) {
	raw, err := t.getProject(projectID)
	if err != nil {
		return nil, fmt.Errorf("read project %s: %w", projectID, err)
	}
	var project struct {
		Title       string `json:"title"`
		Integration struct {
			LandingCheckCommand        interface{} `json:"landingCheckCommand"`
			LandingCheckTimeoutSeconds interface{} `json:"landingCheckTimeoutSeconds"`
			MergeCheckCommand          interface{} `json:"mergeCheckCommand"`
			MergeCheckTimeoutSeconds   interface{} `json:"mergeCheckTimeoutSeconds"`
		} `json:"integration"`
	}
	if err := json.Unmarshal(raw, &project); err != nil {
		return nil, fmt.Errorf("read project %s: %w", projectID, err)
	}
	input := map[string]interface{}{
		"projectId":                         projectID,
		"projectTitle":                      project.Title,
		"currentLandingCheckCommand":        project.Integration.LandingCheckCommand,
		"currentLandingCheckTimeoutSeconds": project.Integration.LandingCheckTimeoutSeconds,
		"currentMergeCheckCommand":          project.Integration.MergeCheckCommand,
		"currentMergeCheckTimeoutSeconds":   project.Integration.MergeCheckTimeoutSeconds,
	}
	for key, value := range proposal {
		input[key] = value
	}
	return input, nil
}

// updateProjectWithApproval performs a project update, putting the merge-check change it carries in
// front of the account owner first — the same shape as `resolveBlockerWithApproval`, and for a
// stronger version of the same reason: the server writes a session's merge check only against an
// ALLOWED card whose input reproduces this exact proposal, so a runner that skipped the card would
// have its write refused with a 403 telling the agent to go and ask.
//
// An update carrying no merge check — a rename, a new goal, a line field the server will refuse —
// files nothing and reaches the door unchanged.
//
// Headless there is no session, no card and nobody to ask, and the write goes straight through: that
// caller is the owner operating their own machine, which is the same rule every create here follows.
func updateProjectWithApproval(t *Transport, sessionID, projectID string, body map[string]interface{}) (raw json.RawMessage, declined string, err error) {
	if sessionID != "" {
		settings, _ := body["integration"].(map[string]interface{})
		if proposal, gated := mergeCheckProposal(settings); gated {
			input, err := projectMergeCheckCard(t, projectID, proposal)
			if err != nil {
				return nil, "", err
			}
			declined, err := askBeforeCreate(t, sessionID, projectIntegrationApprovalToolName, input)
			if err != nil {
				return nil, "", err
			}
			if declined != "" {
				return nil, declined, nil
			}
		}
	}
	raw, err = t.updateProject(sessionID, projectID, body)
	return raw, "", err
}

// openBlockerFacts finds one still-open blocker in the project read, by the id spelling that read
// returns. A resolved one and an unknown one are told apart because they are different mistakes: the
// first already ended (and 0125 makes that final), the second is an id to go and check.
func openBlockerFacts(t *Transport, projectID, blockerID string) (*blockerCardFacts, string, error) {
	raw, err := t.getProject(projectID)
	if err != nil {
		return nil, "", fmt.Errorf("read project %s: %w", projectID, err)
	}
	var project struct {
		Title    string `json:"title"`
		Blockers struct {
			Open     []blockerCardFacts `json:"open"`
			Resolved []blockerCardFacts `json:"resolved"`
		} `json:"blockers"`
	}
	if err := json.Unmarshal(raw, &project); err != nil {
		return nil, "", fmt.Errorf("read project %s: %w", projectID, err)
	}
	for i := range project.Blockers.Open {
		if project.Blockers.Open[i].ID == blockerID {
			return &project.Blockers.Open[i], project.Title, nil
		}
	}
	for i := range project.Blockers.Resolved {
		if project.Blockers.Resolved[i].ID == blockerID {
			return nil, "", fmt.Errorf("blocker %s is already resolved, and a resolution is final", blockerID)
		}
	}
	return nil, "", fmt.Errorf("no open blocker %s on project %s: pass an id from that project's "+
		"blockers.open, spelled as the project read spells it", blockerID, projectID)
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
	dec, err := awaitApprovalDecision(context.Background(), s.t, s.sessionID, id)
	if err != nil {
		return toolResult("approval poll failed: "+err.Error(), true)
	}
	if dec.Status == "ALLOWED" {
		applied, err := s.t.dagApply(listID, body)
		if err != nil {
			// Approved but unapplicable: the graph moved while the card was open. Say so
			// plainly — the alternative is an agent that believes it restructured the list.
			return toolResult("approved, but applying failed: "+err.Error(), true)
		}
		return toolResult(prettyJSON(applied), false)
	}
	msg := dec.Message
	if msg == "" {
		msg = "denied by the user"
	}
	return toolResult("the human rejected this DAG change: "+msg, false)
}

// permissionPrompt is claude's --permission-prompt-tool: it registers the gated tool
// call as a pending approval, blocks until a human allows/denies it (re-polling across
// the server's long-poll windows), and returns the decision in the shape claude wants:
//
//	{"behavior":"allow","updatedInput":{...}}  or  {"behavior":"deny","message":"..."}
//
// Fails CLOSED — a control-plane outage never approves anything. A failed poll that says
// nothing about the card is waited out and the card read again (awaitApprovalDecision),
// since the card is still on the owner's screen; one that does answer it, or any decision
// but an allow, denies.
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
	dec, err := awaitApprovalDecision(context.Background(), s.t, s.sessionID, id)
	if err != nil {
		return toolResult(denyJSON("approval poll failed: "+err.Error()), false)
	}
	if dec.Status == "ALLOWED" {
		// AskUserQuestion's "answer" rides back as updatedInput.answers (question
		// text -> picked labels); claude reads it and formats the tool result.
		if getString(args, "tool_name") == "AskUserQuestion" {
			return toolResult(allowJSON(askQuestionInput(args["input"], dec.Answers), nil), false)
		}
		// "Allow + remember same kind": add session-scoped permission rules so
		// claude's own engine auto-allows future matching calls without re-prompting.
		return toolResult(allowJSON(args["input"], rememberPermissions(dec.resolveRememberRules())), false)
	}
	msg := dec.Message
	if msg == "" {
		msg = "denied by the user"
	}
	return toolResult(denyJSON(msg), false)
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

// toolDescriptors is the tools/list payload, projected from the operation catalogue
// (operation_catalog.go). Claude namespaces these as mcp__orbit__<name> for the allowlist; the
// agent allowlist defaults to mcp__orbit__*.
func toolDescriptors(includePermissionPrompt, includeOrchestration bool) []map[string]interface{} {
	return catalogToolDescriptors(includePermissionPrompt, includeOrchestration)
}

// ── schedule_wakeup ───────────────────────────────────────────────────────

// scheduleWakeupBody is the request a schedule_wakeup call sends, or why it sends none
// (docs/long-running-loop-contract.md §1.1). What a loop needs is refused here as the control plane
// refuses it, and a loop's fields without recurring: true are refused here alone: a control plane that
// predates loops strips the fields it does not know, so it would hold one wakeup and drop them unsaid.
func scheduleWakeupBody(args map[string]interface{}) (map[string]interface{}, string) {
	if getBool(args, "stop") {
		return map[string]interface{}{"stop": true}, ""
	}
	if !getBool(args, "recurring") {
		if args["everySeconds"] != nil || args["until"] != nil {
			return nil, "everySeconds and until belong to a loop: send them with recurring: true"
		}
		delay, ok := args["delaySeconds"].(float64)
		if !ok {
			return nil, "delaySeconds (a number of seconds) is required unless stop or recurring is true"
		}
		reason := getString(args, "reason")
		if reason == "" {
			return nil, "reason is required unless stop or recurring is true"
		}
		body := map[string]interface{}{"delaySeconds": delay, "reason": reason}
		if prompt := getString(args, "prompt"); prompt != "" {
			body["prompt"] = prompt
		}
		return body, ""
	}
	every, ok := args["everySeconds"].(float64)
	if !ok {
		return nil, "everySeconds (the seconds between ticks) is required with recurring: true"
	}
	prompt := getString(args, "prompt")
	if strings.TrimSpace(prompt) == "" {
		return nil, "prompt is required with recurring: true: it is what every tick's turn is to do"
	}
	body := map[string]interface{}{"recurring": true, "everySeconds": every, "prompt": prompt}
	if v := args["delaySeconds"]; v != nil {
		delay, ok := v.(float64)
		if !ok {
			return nil, "delaySeconds, when the first tick is due, is a number of seconds"
		}
		body["delaySeconds"] = delay
	}
	if v := args["until"]; v != nil {
		until, ok := v.(string)
		if !ok || strings.TrimSpace(until) == "" {
			return nil, "until is an ISO 8601 date-time, such as 2026-11-08T09:00:00Z"
		}
		body["until"] = until
	}
	if reason := getString(args, "reason"); reason != "" {
		body["reason"] = reason
	}
	return body, ""
}

// What a loop request meets on a control plane that predates loops (contract §1.1, version skew), and
// what to do there instead.
const (
	scheduleWakeupNoLoops       = "this Orbit server predates recurring wakeups, so no loop is running"
	scheduleWakeupNoLoopsAdvice = "On this server, schedule one wakeup at a time (delaySeconds, reason and prompt) and " +
		"call schedule_wakeup again from each woken turn; stop: true cancels the pending one."
)

// scheduleWakeupLoopReadAsOneShot reports a loop request refused by a control plane that predates loops:
// it strips the loop's fields and refuses what is left as a one-shot wakeup missing its delaySeconds or
// its reason, in class-validator's words for them. A control plane that holds loops says neither to a
// loop request, because scheduleWakeupBody sends delaySeconds only as a number and reason only as a
// string, and it asks for neither of a loop.
func scheduleWakeupLoopReadAsOneShot(err error) bool {
	var refused *transportHTTPError
	if !errors.As(err, &refused) || refused.statusCode != http.StatusBadRequest {
		return false
	}
	return strings.Contains(refused.body, "delaySeconds must be a number") || strings.Contains(refused.body, "reason must be a string")
}

// scheduledWakeupLoopRefusedNote answers a loop request that a control plane which predates loops held
// as one wakeup: what it holds instead, which the agent can keep or cancel.
func scheduledWakeupLoopRefusedNote(r scheduledWakeupReceipt) string {
	var note strings.Builder
	fmt.Fprintf(&note, "schedule_wakeup failed: %s. It held the call as one wakeup instead, due %s (in %ds)", scheduleWakeupNoLoops, r.DueAt, r.DelaySeconds)
	if r.Replaced {
		note.WriteString(", replacing the one that was pending")
	}
	note.WriteString(". " + scheduleWakeupNoLoopsAdvice)
	return note.String()
}

// scheduledWakeupLoopNote is the receipt of a loop the control plane holds: when its first tick is due,
// how long it runs, what was clamped, and whether it replaced a loop.
func scheduledWakeupLoopNote(r scheduledWakeupReceipt) string {
	var note strings.Builder
	fmt.Fprintf(&note, "Loop scheduled: a tick every %ds until %s. The first tick is due %s (in %ds).", r.EverySeconds, r.Until, r.DueAt, r.DelaySeconds)
	var clamped []string
	if from := r.ClampedFrom.EverySeconds; from != nil {
		clamped = append(clamped, fmt.Sprintf("everySeconds %s became %d", strconv.FormatFloat(*from, 'f', -1, 64), r.EverySeconds))
	}
	if from := r.ClampedFrom.DelaySeconds; from != nil {
		clamped = append(clamped, fmt.Sprintf("delaySeconds %s became %d", strconv.FormatFloat(*from, 'f', -1, 64), r.DelaySeconds))
	}
	if len(clamped) > 0 {
		note.WriteString(" Clamped to [60, 86400] seconds: " + strings.Join(clamped, ", ") + ".")
	}
	if from := r.ClampedFrom.Until; from != "" {
		fmt.Fprintf(&note, " The until asked for, %s, is more than 30 days out: the loop ends at %s instead.", from, r.Until)
	}
	if r.Replaced {
		note.WriteString(" It replaces the loop that was running, which has ended.")
	}
	note.WriteString(" Orbit's server holds the loop and schedules every tick itself: each starts a turn in this session with your " +
		"prompt, even if this engine was recycled or the runner restarted, and a tick that cannot run is counted as missed while the next " +
		"one is still scheduled. Do not call schedule_wakeup again to keep it going; stop: true ends it.")
	return note.String()
}

// scheduledWakeupStopNote says what a stop cancelled, the one-shot wakeup and the loop each on its own:
// a stop takes both, and finding neither is an answer, not an error.
func scheduledWakeupStopNote(r scheduledWakeupReceipt) string {
	if r.Cancelled == 0 && r.LoopsStopped == 0 {
		return "Nothing to stop: no wakeup was pending and no loop was running."
	}
	wakeup := "no one-shot wakeup was pending"
	if r.Cancelled > 0 {
		wakeup = "the pending one-shot wakeup is cancelled"
	}
	loop := "no loop was running"
	if r.LoopsStopped > 0 {
		loop = "the loop has ended, and no further tick of it is scheduled"
	}
	return "Stopped: " + wakeup + "; " + loop + "."
}

// ── helpers ───────────────────────────────────────────────────────────────

func toolResult(text string, isErr bool) map[string]interface{} {
	return map[string]interface{}{
		"content": []map[string]interface{}{{"type": "text", "text": text}},
		"isError": isErr,
	}
}

// sessionWaitInterval * maxSessionWaitPolls caps how long session_create(wait) blocks the
// parent's tool call before handing back the last known state and the watch that keeps waiting
// (~3s * 200 = ~10 min). A variable only so tests can wait in milliseconds.
var sessionWaitInterval = 3 * time.Second

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
		polls = minSessionWaitPolls
	}
	// Under an engine that ends the call itself (envMCPCallTimeout), the wait ends first: the session
	// was already created, and a call reported failed would invite a second one. The watch the wait
	// records keeps waiting either way.
	if limit := longestInlineWait(mcpCallTimeoutFromEnv()); limit > 0 && time.Duration(polls)*sessionWaitInterval > limit {
		polls = int(limit / sessionWaitInterval)
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

// waitForSession waits for the freshly-created child session to settle — to leave PENDING/RUNNING,
// reaching AWAITING_INPUT once its first turn produced a result, or a terminal state — behind a watch
// that keeps waiting on the server whenever this call cannot (session_wait.go).
func (s *mcpServer) waitForSession(created json.RawMessage) map[string]interface{} {
	wait, err := waitForSessionDurably(s.t, cliOrchestrationContext{
		sessionID: s.sessionID,
		token:     s.orchestrationToken,
	}, created)
	if err != nil {
		return toolResult("wait: "+err.Error(), true)
	}
	return toolResult(wait.text(), false)
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

// getOptionalPriority reads an optional priority floor. Absent or null is no floor — and a
// pointer, because 0 is a floor a caller can mean. Anything that is not an integer in the column's
// range is refused here, before it becomes a query parameter the server would only refuse.
func getOptionalPriority(args map[string]interface{}, key string) (*int, error) {
	raw, present := args[key]
	if !present || raw == nil {
		return nil, nil
	}
	bad := fmt.Errorf("%s must be an integer from %d to %d", key, taskPriorityMin, taskPriorityMax)
	var n int
	switch value := raw.(type) {
	case float64:
		if value < taskPriorityMin || value > taskPriorityMax || value != float64(int(value)) {
			return nil, bad
		}
		n = int(value)
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(value))
		if err != nil || parsed < taskPriorityMin || parsed > taskPriorityMax {
			return nil, bad
		}
		n = parsed
	default:
		return nil, bad
	}
	return &n, nil
}

// getNumberAsString reads a numeric argument that travels on as a query value. An agent sends a
// claim generation or a round as a number as often as a quoted one, so both reach the server as
// plain digits: 3 and "3" are "3", and an integral number is written out in full rather than as
// the exponent the server's digits-only check would refuse. A JSON number has already been decoded
// to a float64 by the time it gets here, so above 2^53 only a quoted value keeps every digit. Nothing
// is judged here — a negative or fractional number is spelled out ("-1", "2.5") exactly as a bad
// string is passed on, and the server refuses both with the one message it gives for that field.
func getNumberAsString(args map[string]interface{}, key string) string {
	switch v := args[key].(type) {
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case int:
		return strconv.Itoa(v)
	}
	return ""
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
//
// []string is read as well, and not only []interface{}: the arguments of a tool reached from the
// CLI are built by this binary rather than decoded from JSON, and a caller that hands over the
// natural Go type must not have its values silently dropped for it.
func getStringSlice(args map[string]interface{}, key string) []string {
	switch v := args[key].(type) {
	case string:
		if v == "" {
			return nil
		}
		return []string{v}
	case []string:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if item != "" {
				out = append(out, item)
			}
		}
		return out
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

// maxOwnerRequestExpiresIn is a year in seconds: long enough for any real deadline, and small enough
// that the conversion to a time.Duration cannot overflow.
const maxOwnerRequestExpiresIn = 365 * 24 * 60 * 60

// ownerRequestBody is what POST /runner/owner-requests takes for one request_owner_action call. The
// per-kind rules (which fields go with which kind) are the server's, so those fields travel as the
// caller wrote them; the one translation is expiresIn, since the server takes an absolute expiresAt.
func ownerRequestBody(args map[string]interface{}, now time.Time) (map[string]interface{}, error) {
	kind := getString(args, "kind")
	title := strings.TrimSpace(getString(args, "title"))
	why := strings.TrimSpace(getString(args, "why"))
	if kind == "" || title == "" || why == "" {
		return nil, errors.New("kind, title and why are required")
	}
	body := map[string]interface{}{"kind": kind, "title": title, "why": why}
	copyIfPresent(body, args, "ifUnanswered", "steps", "secretSpec", "options", "recommendedOption", "clientRequestId")
	if blocked := getStringSlice(args, "blocksTaskIds"); len(blocked) > 0 {
		body["blocksTaskIds"] = blocked
	}
	expiresIn, err := getBoundedOptionalNumber(args, "expiresIn", maxOwnerRequestExpiresIn)
	if err != nil {
		return nil, err
	}
	if expiresIn > 0 {
		body["expiresAt"] = now.Add(time.Duration(expiresIn) * time.Second).UTC().Format(time.RFC3339)
	}
	return body, nil
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
