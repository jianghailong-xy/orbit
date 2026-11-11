package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// SubAgent (docs/subagent-design.md §2, §5.1, §6.3): a parent session's `delegate` call, run by the runner as a
// child engine in the parent session's own working directory.
//
// The two halves meet over the session's background-job socket, as bg_run's do (background_socket.go). `orbit
// mcp` is a child of the parent's engine, so it only forwards the call: the runner, which hosts the session,
// opens the run on the server (POST /runner/sessions/:id/subagents), starts the child engine under the session's
// lifetime, writes every child event into the parent's event stream nested under the delegate call, and reports
// the end (PATCH …/subagents/:runId). A foreground call then waits for the end in slices short enough for one
// socket exchange; a background one, or a foreground one whose wait ran out, is woken through the same
// background-wake door a bg_run job wakes its session through.

const (
	// envSubagentRunID marks an engine started as a SubAgent. Its `orbit mcp` offers no delegate tool:
	// a SubAgent cannot hand work on again (§0).
	envSubagentRunID = "ORBIT_SUBAGENT_RUN_ID"

	delegateToolName = "delegate"
	// The tool's name as the parent's engine reports it, which the events ingest counts (RUNTIME_SUBAGENT_TOOLS).
	delegateEngineToolName = "mcp__orbit__delegate"

	subagentStatusRunning     = "RUNNING"
	subagentStatusDone        = "DONE"
	subagentStatusFailed      = "FAILED"
	subagentStatusInterrupted = "INTERRUPTED"
	subagentStatusStopped     = "STOPPED"

	// The wake a SubAgent's end sends names this kind, so the parent reads it apart from a bg_run job.
	subagentWakeKind = "subagent"
	// How much of a result a wake quotes. The control plane takes up to 8000 characters of excerpt.
	subagentWakeExcerptCap = 6000
)

// subagentPreamble is the fixed English text every SubAgent's prompt starts with (§3).
const subagentPreamble = "You are a SubAgent: another agent handed you the task below, and you are working in that agent's own " +
	"working tree, beside its uncommitted changes. Edit files directly where the task asks for it. Do not commit, do not " +
	"switch or create branches, do not run git stash, reset or checkout, and do not revert changes you did not make: " +
	"other agents may be working in this tree at the same time. You cannot ask the user anything; when something is " +
	"unclear, decide sensibly and say so in your result. When you are done, reply with one paragraph of result: what " +
	"you found or changed, and anything the agent that sent you should check."

// subagentWaitSlice is how long one subagent_wait exchange holds the socket: well inside bgSocketTimeout.
var subagentWaitSlice = 20 * time.Second

// subagentEditTool is how a child tool's input names the files it writes.
type subagentEditTool struct {
	// fields are the input fields that may name the file, tried in order: a string names one, a list of strings
	// several (Codex's apply_patch card lists every file of its patch).
	fields []string
	// patchField is an input field holding an apply_patch text, whose "*** Add File:" style headers name the files.
	patchField string
	// writes, when set, says whether this call writes at all (DSH's str_replace_editor also views).
	writes func(input map[string]interface{}) bool
}

// subagentEditTools are the child tools that write files, by the name each engine's event parser gives them:
//   - Claude Code, Cursor (cursorEditCall) and Antigravity (canonicalAgyTool): Edit, MultiEdit, Write, NotebookEdit
//     with file_path / notebook_path;
//   - Kimi: Edit and Write, whose input names the file `path`;
//   - Codex: apply_patch, the card of a fileChange item, with the paths in `files`;
//   - DSH: write and edit (file_path), and str_replace_editor (path) unless it only views;
//   - OpenCode: Write, Edit and MultiEdit (canonicalOpenCodeToolName, file_path), and ApplyPatch with the patch text.
var subagentEditTools = map[string]subagentEditTool{
	"Edit":         {fields: []string{"file_path", "path"}},
	"MultiEdit":    {fields: []string{"file_path", "path"}},
	"Write":        {fields: []string{"file_path", "path"}},
	"NotebookEdit": {fields: []string{"notebook_path"}},
	"apply_patch":  {fields: []string{"files"}},
	"ApplyPatch":   {patchField: "patch_text"},
	"write":        {fields: []string{"file_path", "path"}},
	"edit":         {fields: []string{"file_path", "path"}},
	"str_replace_editor": {fields: []string{"path"}, writes: func(input map[string]interface{}) bool {
		return asString(input["command"]) != "view"
	}},
}

// paths is what one call of the tool writes, as its input names them.
func (t subagentEditTool) paths(input map[string]interface{}) []string {
	if input == nil || (t.writes != nil && !t.writes(input)) {
		return nil
	}
	var out []string
	for _, field := range t.fields {
		switch v := input[field].(type) {
		case string:
			if strings.TrimSpace(v) != "" {
				out = append(out, v)
			}
		case []interface{}:
			for _, item := range v {
				if s := asString(item); strings.TrimSpace(s) != "" {
					out = append(out, s)
				}
			}
		case []string:
			for _, s := range v {
				if strings.TrimSpace(s) != "" {
					out = append(out, s)
				}
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	if t.patchField != "" {
		return applyPatchPaths(asString(input[t.patchField]))
	}
	return nil
}

// applyPatchPaths are the files an apply_patch text adds, updates, deletes or moves to.
func applyPatchPaths(patch string) []string {
	var out []string
	for _, line := range strings.Split(patch, "\n") {
		line = strings.TrimSpace(line)
		for _, header := range []string{"*** Add File:", "*** Update File:", "*** Delete File:", "*** Move to:"} {
			if rest, ok := strings.CutPrefix(line, header); ok {
				if p := strings.TrimSpace(rest); p != "" {
					out = append(out, p)
				}
			}
		}
	}
	return out
}

// ── The MCP half ─────────────────────────────────────────────────────────────────────────────────────────

// delegateToolDescriptor is the tool's contract (§2). Offered only to a top-level session (callers check
// envSubagentRunID).
func delegateToolDescriptor(obj func(map[string]interface{}, ...string) map[string]interface{}, defs []subagentDefinition) map[string]interface{} {
	str := func(desc string) map[string]interface{} {
		return map[string]interface{}{"type": "string", "description": desc}
	}
	return map[string]interface{}{
		"name": delegateToolName,
		"description": "Hand a self-contained piece of work to a SubAgent: another coding engine that Orbit starts in this" +
			" session's own working directory. It sees your uncommitted changes, edits files directly and never commits;" +
			" its edits stay in your working tree for you to review and commit. Its progress is shown nested under this" +
			" call. In the foreground (the default) the call returns { runId, status, result, changedFiles, model, costUsd }" +
			" when it ends; if it runs longer than this call may wait, the call returns status \"running\" and Orbit starts" +
			" a turn in this session with the result when it ends: end your turn then instead of polling. With" +
			" background: true it returns { runId, status: \"running\" } at once and Orbit wakes this session with the" +
			" result when it ends. SubAgents share your working tree; give parallel ones disjoint files. A SubAgent cannot" +
			" ask the user anything and cannot delegate further. " + subagentTypesDescription(defs),
		"inputSchema": obj(map[string]interface{}{
			"description": str("3 to 8 words saying what the SubAgent does; shown on its block."),
			"prompt":      str("The complete brief. The SubAgent has none of your context: say what to do, where, and what to hand back."),
			"type":        str("One of the types listed in this tool's description; default \"general\"."),
			"size": map[string]interface{}{
				"type": "string", "enum": []string{"S", "M", "L", "XL"},
				"description": "How hard the work is: S mechanical, M a well-specified change, L cross-module or unknown cause, XL design-level.",
			},
			"sizeReason": str("One sentence on why that size."),
			"model":      str("A model id to run on, skipping Orbit's choice."),
			"background": map[string]interface{}{
				"type":        "boolean",
				"description": "Return at once and be woken with the result when the SubAgent ends (default false, or the type's is_background).",
			},
			"resume": str("The runId of a finished SubAgent of this session to continue: it keeps its own conversation and gets prompt as its next message."),
		}, "description", "prompt"),
	}
}

// schemaObject is an object schema, as toolDescriptors builds its own.
func schemaObject(props map[string]interface{}, required ...string) map[string]interface{} {
	schema := map[string]interface{}{"type": "object", "properties": props}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

// callDelegate forwards one delegate call to the runner and, in the foreground, waits for its end.
func (s *mcpServer) callDelegate(args map[string]interface{}, toolUseID string) map[string]interface{} {
	if os.Getenv(envSubagentRunID) != "" {
		return toolResult("delegate: a SubAgent cannot start another SubAgent. Do the work yourself.", true)
	}
	socket, token := os.Getenv(envBgSocket), os.Getenv(envBgToken)
	if socket == "" || token == "" {
		return toolResult(bgTransportUnavailable+": this session has no runner-hosted job service, so delegate is unavailable. Do the work yourself.", true)
	}
	// Claude Code says which call this is (_meta "claudecode/toolUseId"); for an engine that does not, the runner
	// reads the call from the session's own stream (delegateCallLog).
	forward := map[string]interface{}{"toolUseId": toolUseID}
	for _, key := range []string{"description", "prompt", "type", "size", "sizeReason", "model", "background", "resume"} {
		if v, ok := args[key]; ok {
			forward[key] = v
		}
	}
	raw, err := bgSocketCall(socket, token, "subagent_start", forward)
	if err != nil {
		return toolResult("delegate failed: "+err.Error(), true)
	}
	var started subagentReport
	if err := json.Unmarshal(raw, &started); err != nil {
		return toolResult("delegate failed: "+err.Error(), true)
	}
	if getBool(args, "background") {
		return toolResult(prettyJSON(subagentJSON(map[string]interface{}{"runId": started.RunID, "status": "running"})), false)
	}
	budget := time.Duration(sessionWaitPolls(spawnDepthFromEnv())) * sessionWaitInterval
	deadline := time.Now().Add(budget)
	for {
		left := time.Until(deadline)
		if left <= 0 {
			break
		}
		slice := subagentWaitSlice
		if left < slice {
			slice = left
		}
		raw, err := bgSocketCall(socket, token, "subagent_wait", map[string]interface{}{
			"runId": started.RunID, "waitMs": float64(slice.Milliseconds()),
		})
		if err != nil {
			break
		}
		var report subagentReport
		if json.Unmarshal(raw, &report) == nil && report.Status != subagentStatusRunning {
			return delegateResult(report)
		}
	}
	// Out of time: the runner wakes this session when the run ends. Asked as one exchange, so a run that ended
	// meanwhile is answered with its result instead.
	raw, err = bgSocketCall(socket, token, "subagent_detach", map[string]interface{}{"runId": started.RunID})
	if err == nil {
		var report subagentReport
		if json.Unmarshal(raw, &report) == nil && report.Status != subagentStatusRunning {
			return delegateResult(report)
		}
	}
	return toolResult(prettyJSON(subagentJSON(map[string]interface{}{
		"runId":  started.RunID,
		"status": "running",
		"note": fmt.Sprintf("SubAgent %s is still running after the %s this call may wait. Orbit starts a turn in this"+
			" session with its result when it ends: end your turn now; do not poll for it.", started.RunID, budget),
	})), false)
}

func delegateResult(r subagentReport) map[string]interface{} {
	return toolResult(prettyJSON(subagentJSON(map[string]interface{}{
		"runId":        r.RunID,
		"status":       r.Status,
		"result":       r.Result,
		"changedFiles": nonNilStrings(r.ChangedFiles),
		"model":        r.Model,
		"costUsd":      r.CostUsd,
	})), r.Status == subagentStatusFailed)
}

func subagentJSON(v interface{}) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func nonNilStrings(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// ── The runner half ──────────────────────────────────────────────────────────────────────────────────────

// subagentReport is one run as the socket answers it.
type subagentReport struct {
	RunID        string   `json:"runId"`
	Status       string   `json:"status"`
	Result       string   `json:"result,omitempty"`
	ChangedFiles []string `json:"changedFiles,omitempty"`
	Model        string   `json:"model,omitempty"`
	CostUsd      float64  `json:"costUsd"`
}

// subagentRun is one SubAgent the runner hosts for a session.
type subagentRun struct {
	id          string
	toolUseID   string
	description string
	background  bool
	model       string
	engine      string
	kind        string
	// The child engine's own conversation id, which resume continues.
	engineSession string
	done          chan struct{}

	// Written under subagentRegistry.mu.
	startedAt time.Time
	endedAt   time.Time
	status    string
	result    string
	changed   []string
	costUsd   float64
	// detached marks a foreground run whose call stopped waiting: its end wakes the session.
	detached bool
}

func (r *subagentRun) reportLocked() subagentReport {
	return subagentReport{
		RunID: r.id, Status: r.status, Result: r.result, ChangedFiles: append([]string(nil), r.changed...),
		Model: r.model, CostUsd: r.costUsd,
	}
}

// subagentRegistry is one session's SubAgents, kept after they end: resume and the same-file note read them.
type subagentRegistry struct {
	mu   sync.Mutex
	runs map[string]*subagentRun
}

func (g *subagentRegistry) get(runID string) *subagentRun {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.runs[runID]
}

func (g *subagentRegistry) add(r *subagentRun) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.runs == nil {
		g.runs = map[string]*subagentRun{}
	}
	g.runs[r.id] = r
}

// subagentSpan is what the same-file note reads of a run: when it ran and what it changed.
type subagentSpan struct {
	ID      string
	Started time.Time
	Ended   time.Time // zero while it runs
	Changed []string
}

// sameFileNotes is what a run that just ended adds to its result about files another run changed while their
// lifetimes overlapped (§5.4: no lock, so the parent checks). Only runs that ended before this one are named:
// one still running is named in its own result when it ends, so each pair is told once, by the later of the two.
func sameFileNotes(self subagentSpan, others []subagentSpan) []string {
	mine := map[string]bool{}
	for _, p := range self.Changed {
		mine[p] = true
	}
	var notes []string
	for _, o := range others {
		if o.ID == self.ID || o.Ended.IsZero() || o.Ended.After(self.Ended) {
			continue
		}
		if !o.Ended.After(self.Started) {
			continue // it had ended before this one began: not parallel
		}
		for _, p := range o.Changed {
			if mine[p] {
				notes = append(notes, fmt.Sprintf("Also changed by %s: %s", o.ID, p))
			}
		}
	}
	sort.Strings(notes)
	return notes
}

// subagentToolID is a child's tool id as its parent's session knows it: prefixed with the run id. The events and
// the child's approval cards (approvalBodyOfPrompt) spell it alike, so a card names the call drawn in the block.
func subagentToolID(runID, id string) string {
	if id == "" {
		return ""
	}
	return runID + ":" + id
}

// rewriteSubagentEvent is a child engine event as the parent session's stream carries it, or false for one the
// parent must not see. Every kept event nests under the delegate call (parentToolUseId), and every tool id the
// child minted is prefixed with the run id, so a child's toolu_1 never collides with the parent's or another
// child's. A child's own nested call (its own Agent tool) keeps its nesting, one level further down.
//
// Dropped: live deltas (they carry no parent and would animate the parent's own text), system frames (an init or
// a resume of the child would read as the parent's engine restarting), and the child's background lifecycle and
// progress events, whose ids would clear or add the parent's own running work.
func rewriteSubagentEvent(runID, parentToolUseID, eventType string, payload map[string]interface{}) (map[string]interface{}, bool) {
	switch eventType {
	case evAssistant, evThinking, evToolUse, evToolResult, evToolOutput, evError:
	default:
		return nil, false
	}
	prefix := func(id string) string { return subagentToolID(runID, id) }
	out := make(map[string]interface{}, len(payload)+1)
	for k, v := range payload {
		out[k] = v
	}
	if inner := asString(payload["parentToolUseId"]); inner != "" {
		out["parentToolUseId"] = prefix(inner)
	} else {
		out["parentToolUseId"] = parentToolUseID
	}
	if eventType == evToolUse {
		out["id"] = prefix(asString(payload["id"]))
	}
	if id := asString(payload["toolUseId"]); id != "" {
		out["toolUseId"] = prefix(id)
	}
	out["subagentRunId"] = runID
	return out, true
}

// subagentFileCollector gathers changedFiles from the child's edit tools: a path counts once its call's
// result came back without an error.
type subagentFileCollector struct {
	cwd     string
	pending map[string][]string // child tool id → the paths it writes
	changed []string
	seen    map[string]bool
}

func newSubagentFileCollector(cwd string) *subagentFileCollector {
	return &subagentFileCollector{cwd: cwd, pending: map[string][]string{}, seen: map[string]bool{}}
}

// note reads one child event, before it is rewritten.
func (c *subagentFileCollector) note(eventType string, payload map[string]interface{}) {
	switch eventType {
	case evToolUse:
		tool, ok := subagentEditTools[asString(payload["name"])]
		if !ok {
			return
		}
		input, _ := payload["input"].(map[string]interface{})
		var paths []string
		for _, p := range tool.paths(input) {
			paths = append(paths, c.relative(p))
		}
		if len(paths) > 0 {
			c.pending[asString(payload["id"])] = paths
		}
	case evToolResult:
		id := asString(payload["toolUseId"])
		paths, ok := c.pending[id]
		if !ok {
			return
		}
		delete(c.pending, id)
		if failed, _ := payload["isError"].(bool); failed {
			return
		}
		for _, path := range paths {
			if !c.seen[path] {
				c.seen[path] = true
				c.changed = append(c.changed, path)
			}
		}
	}
}

func (c *subagentFileCollector) relative(path string) string {
	if c.cwd == "" || !filepath.IsAbs(path) {
		return filepath.ToSlash(filepath.Clean(path))
	}
	if rel, err := filepath.Rel(c.cwd, path); err == nil && !strings.HasPrefix(rel, "..") {
		return filepath.ToSlash(rel)
	}
	return filepath.ToSlash(path)
}

// subagentCreateResponse is the server's answer to the POST (SubagentRunCreateResponse).
type subagentCreateResponse struct {
	RunID    string          `json:"runId"`
	Status   string          `json:"status"`
	Decision json.RawMessage `json:"decision"`
	Exec     AgentExecConfig `json:"exec"`
}

// subagentRecord is what the runner keeps on disk of a finished run so resume finds its conversation after a
// restart of this process.
type subagentRecord struct {
	RunID         string `json:"runId"`
	Engine        string `json:"engine"`
	EngineSession string `json:"engineSession"`
	// Type is the definition the run ran as, which a resume without a type runs as again.
	Type string `json:"type,omitempty"`
}

func subagentDir(sessionID, runID string) string {
	return filepath.Join(runDir(sessionID), "subagents", runID)
}

func (s *bgJobService) handleSubagent(op string, args map[string]interface{}) bgSocketResponse {
	switch op {
	case "subagent_start":
		report, err := s.startSubagent(args)
		if err != nil {
			return bgSocketResponse{Error: err.Error()}
		}
		return bgSocketResponse{OK: true, Result: report}
	case "subagent_wait":
		run := s.subagents.get(getString(args, "runId"))
		if run == nil {
			return bgSocketResponse{Error: "no SubAgent run " + getString(args, "runId") + " in this session"}
		}
		wait, _ := bgOptionalInt(args, "waitMs")
		if wait <= 0 || time.Duration(wait)*time.Millisecond > subagentWaitSlice {
			wait = int(subagentWaitSlice / time.Millisecond)
		}
		select {
		case <-run.done:
		case <-time.After(time.Duration(wait) * time.Millisecond):
		}
		s.subagents.mu.Lock()
		defer s.subagents.mu.Unlock()
		return bgSocketResponse{OK: true, Result: run.reportLocked()}
	case "subagent_detach":
		run := s.subagents.get(getString(args, "runId"))
		if run == nil {
			return bgSocketResponse{Error: "no SubAgent run " + getString(args, "runId") + " in this session"}
		}
		s.subagents.mu.Lock()
		defer s.subagents.mu.Unlock()
		if run.status == subagentStatusRunning {
			run.detached = true
		}
		return bgSocketResponse{OK: true, Result: run.reportLocked()}
	}
	return bgSocketResponse{Error: "unknown SubAgent operation: " + op}
}

// startSubagent opens the run on the server and starts its child engine. Returns once the child is running.
func (s *bgJobService) startSubagent(args map[string]interface{}) (subagentReport, error) {
	if s.job == nil || s.t == nil || s.bg == nil {
		return subagentReport{}, errors.New("this session's runner cannot host a SubAgent")
	}
	toolUseID := getString(args, "toolUseId")
	prompt := getString(args, "prompt")
	if strings.TrimSpace(prompt) == "" {
		return subagentReport{}, errors.New("prompt is required")
	}
	kind := strings.TrimSpace(getString(args, "type"))
	// Resume continues a finished run's own conversation, on the engine it ran on.
	var resumeFrom *subagentRecord
	if resumeID := strings.TrimSpace(getString(args, "resume")); resumeID != "" {
		rec, err := s.subagentRecord(resumeID)
		if err != nil {
			return subagentReport{}, err
		}
		resumeFrom = rec
		if kind == "" {
			kind = rec.Type
		}
	}
	// Read from the directory the child runs in, so a definition on the session's own branch is found.
	def, err := findSubagentDefinition(sessionSubagentDefinitions(s.execDir), kind)
	if err != nil {
		return subagentReport{}, err
	}
	background, err := subagentBackground(args, def)
	if err != nil {
		return subagentReport{}, err
	}
	// A resume continues the run's own conversation, which only its engine holds and not every engine reopens.
	if resumeFrom != nil {
		if err := subagentResumeRefusal(resumeFrom); err != nil {
			return subagentReport{}, err
		}
	}
	if strings.TrimSpace(toolUseID) == "" {
		// An engine that does not say which call this is: the call its engine announced in the session's stream.
		toolUseID = delegateCalls.take(s.sessionID, getString(args, "prompt"), getString(args, "description"), delegateCallWait)
	} else {
		delegateCalls.claim(s.sessionID, toolUseID)
	}
	if strings.TrimSpace(toolUseID) == "" {
		// Nothing announced it either; the run still works, its events nest under an id no call carries.
		id, err := newBgJobID()
		if err != nil {
			return subagentReport{}, err
		}
		toolUseID = "delegate_" + strings.TrimPrefix(id, "bgj_")
	}
	body := subagentStartBody(args, def, toolUseID, background)
	var created subagentCreateResponse
	if err := s.t.do(nil, "POST", "/runner/sessions/"+s.sessionID+"/subagents", body, &created, 30*time.Second); err != nil {
		return subagentReport{}, err
	}
	if created.RunID == "" {
		return subagentReport{}, errors.New("the server opened no SubAgent run")
	}
	if existing := s.subagents.get(created.RunID); existing != nil {
		// A retried call: the run it opened is already hosted here.
		s.subagents.mu.Lock()
		defer s.subagents.mu.Unlock()
		return existing.reportLocked(), nil
	}
	engine := subagentEngine(created.Exec, s.job)
	if resumeFrom != nil && resumeFrom.Engine != "" {
		engine = resumeFrom.Engine
	}
	engineSession := ""
	if resumeFrom != nil {
		engineSession = resumeFrom.EngineSession
	} else if engine == providerClaude {
		// Claude Code is told its conversation's id; every other engine names the one it opens.
		if engineSession, err = randomUUID(); err != nil {
			return subagentReport{}, err
		}
	}
	run := &subagentRun{
		id: created.RunID, toolUseID: toolUseID, description: getString(args, "description"),
		background: background, model: created.Exec.Model, engine: engine, engineSession: engineSession, kind: def.Name,
		done: make(chan struct{}), startedAt: time.Now(), status: subagentStatusRunning,
	}
	s.subagents.add(run)
	go s.runSubagent(run, created.Exec, def, prompt, resumeFrom != nil)
	s.subagents.mu.Lock()
	defer s.subagents.mu.Unlock()
	return run.reportLocked(), nil
}

func (s *bgJobService) subagentRecord(runID string) (*subagentRecord, error) {
	if run := s.subagents.get(runID); run != nil {
		s.subagents.mu.Lock()
		status := run.status
		s.subagents.mu.Unlock()
		if status == subagentStatusRunning {
			return nil, fmt.Errorf("SubAgent %s is still running; resume it once it has ended", runID)
		}
		return &subagentRecord{RunID: run.id, Engine: run.engine, EngineSession: run.engineSession, Type: run.kind}, nil
	}
	raw, err := os.ReadFile(filepath.Join(subagentDir(s.sessionID, runID), "run.json"))
	if err != nil {
		return nil, fmt.Errorf("no finished SubAgent run %s in this session to resume", runID)
	}
	var rec subagentRecord
	if err := json.Unmarshal(raw, &rec); err != nil || rec.EngineSession == "" {
		return nil, fmt.Errorf("SubAgent run %s left no conversation to resume", runID)
	}
	return &rec, nil
}

// runSubagent runs the child to its end, then reports it: the PATCH, the parent's answer, and a wake when one is owed.
func (s *bgJobService) runSubagent(run *subagentRun, exec AgentExecConfig, def subagentDefinition, prompt string, resume bool) {
	ctx := s.bg.ctx
	dir := subagentDir(s.sessionID, run.id)
	_ = os.MkdirAll(dir, 0o700)
	_ = writeJSONFile(filepath.Join(dir, "run.json"), subagentRecord{RunID: run.id, Engine: run.engine, EngineSession: run.engineSession, Type: run.kind})
	files := newSubagentFileCollector(s.execDir)
	emit := func(eventType string, payload map[string]interface{}) {
		files.note(eventType, payload)
		if out, ok := rewriteSubagentEvent(run.id, run.toolUseID, eventType, payload); ok {
			s.bg.emit(eventType, out)
		}
	}
	var res ExecResult
	var err error
	if runChild, ok := subagentChildRunners[run.engine]; !ok {
		err = fmt.Errorf("SubAgents cannot run on the %s engine on this runner", run.engine)
	} else {
		var conversation string
		res, conversation, err = runChild(withSubagentApprovals(ctx, run.id), subagentChild{
			t: s.t, parent: s.job, exec: exec, def: def, runID: run.id, engineSession: run.engineSession, resume: resume,
			cwd: s.execDir, scratch: dir, prompt: prompt, emit: emit,
		})
		if conversation != "" && conversation != run.engineSession {
			// The conversation the engine opened, which a resume continues.
			s.subagents.mu.Lock()
			run.engineSession = conversation
			s.subagents.mu.Unlock()
			_ = writeJSONFile(filepath.Join(dir, "run.json"), subagentRecord{RunID: run.id, Engine: run.engine, EngineSession: conversation, Type: run.kind})
		}
	}
	status, result := subagentStatusDone, strings.TrimSpace(res.Result)
	switch {
	case ctx.Err() != nil:
		status = subagentStatusStopped
		if result == "" {
			result = "The SubAgent was stopped because the session ended."
		}
	case err != nil:
		status = subagentStatusFailed
		result = strings.TrimSpace("The SubAgent failed: " + err.Error() + "\n" + result)
	case res.Status != stSucceeded || isAPIError(result) || isAuthError(result):
		status = subagentStatusFailed
		if result == "" {
			result = "The SubAgent failed: " + firstNonEmpty(res.ErrorMsg, res.Subtype, "no result")
		}
	}

	s.subagents.mu.Lock()
	run.endedAt = time.Now()
	run.changed = files.changed
	self := subagentSpan{ID: run.id, Started: run.startedAt, Ended: run.endedAt, Changed: run.changed}
	var others []subagentSpan
	for _, o := range s.subagents.runs {
		if o != run {
			others = append(others, subagentSpan{ID: o.id, Started: o.startedAt, Ended: o.endedAt, Changed: o.changed})
		}
	}
	if notes := sameFileNotes(self, others); len(notes) > 0 {
		result = strings.TrimSpace(result + "\n\n" + strings.Join(notes, "\n"))
	}
	run.status, run.result, run.costUsd = status, result, res.CostUsd
	report := run.reportLocked()
	s.subagents.mu.Unlock()

	s.patchSubagent(run.id, report, res.Usage)
	s.subagents.mu.Lock()
	wakeOwed := run.background || run.detached
	close(run.done)
	s.subagents.mu.Unlock()
	if !wakeOwed {
		return
	}
	// The terminal background_task clears the delegate call from the session's running SubAgents, as a
	// background Agent's does; the wake brings the result to the parent.
	bgStatus := map[string]string{subagentStatusDone: bgStatusCompleted, subagentStatusFailed: bgStatusFailed}[status]
	if bgStatus == "" {
		bgStatus = bgStatusKilled
	}
	s.bg.emit(evBackgroundTask, map[string]interface{}{
		"toolUseId": run.toolUseID, "status": bgStatus, "summary": "SubAgent " + run.id + " " + strings.ToLower(status),
		"output": result, "subagentRunId": run.id,
	})
	if ctx.Err() != nil || s.bg.wake == nil {
		return
	}
	outputPath := filepath.Join(dir, "result.txt")
	_ = os.WriteFile(outputPath, []byte(result), 0o600)
	excerpt := strings.ToValidUTF8(strings.ReplaceAll(result, "\x00", ""), "")
	if len(excerpt) > subagentWakeExcerptCap {
		excerpt = excerpt[:subagentWakeExcerptCap] + "…"
	}
	wake := bgWake{
		WakeID: run.id + ":" + bgWakeOnExit, JobID: run.id, Trigger: bgWakeOnExit, Kind: subagentWakeKind,
		Command: "delegate: " + firstNonEmpty(run.description, run.id), Description: "SubAgent " + strings.ToLower(status),
		Status: bgStatus, OutputPath: outputPath, OutputSize: int64(len(result)), OutputExcerpt: excerpt,
	}
	if bgStatus == bgStatusKilled {
		wake.Reason = "session_cancelled"
	}
	for attempt := 1; attempt <= bgWakeAttempts+3; attempt++ {
		err := s.bg.wake(wake)
		if err == nil || !isRetryableTransportError(err) {
			if err != nil {
				logln("could not wake the session for SubAgent", run.id+":", err)
			}
			return
		}
		time.Sleep(time.Duration(attempt) * bgWakeRetryDelay)
	}
}

// patchSubagent reports a run's end. Asked again while the control plane does not answer: the run's cost reaches
// the parent session only through it, and a repeated report is applied once.
func (s *bgJobService) patchSubagent(runID string, report subagentReport, usage *TokenUsage) {
	body := map[string]interface{}{
		"status":        report.Status,
		"resultSummary": report.Result,
		"changedFiles":  nonNilStrings(report.ChangedFiles),
		"costUsd":       report.CostUsd,
	}
	if usage != nil {
		body["usage"] = usage
	}
	for attempt := 1; attempt <= 5; attempt++ {
		err := s.t.do(nil, "PATCH", "/runner/sessions/"+s.sessionID+"/subagents/"+runID, body, nil, 15*time.Second)
		if err == nil {
			return
		}
		if !isRetryableTransportError(err) || attempt == 5 {
			logln("could not report the end of SubAgent", runID+":", err)
			return
		}
		time.Sleep(time.Duration(attempt) * time.Second)
	}
}

// subagentBackground is the call's background, or the definition's is_background when the call leaves it out.
func subagentBackground(args map[string]interface{}, def subagentDefinition) (bool, error) {
	if _, set := args["background"]; !set && def.Background != nil {
		return *def.Background, nil
	}
	return bgOptionalBool(args, "background")
}

// claudeChildSession is the session a Claude SubAgent is spawned as, and its argv: the parent's, in child mode,
// with the definition applied — the preamble and the definition's body as its appended system prompt, plan mode
// and no edit tools when it is read-only, and its tools (--tools) and disallowedTools.
func claudeChildSession(parent *ClaimedSession, exec AgentExecConfig, def subagentDefinition, runID, engineSession string,
	resume bool, scratch string) (*ClaimedSession, []string) {
	child := subagentChildJob(parent, exec, def, runID, providerClaude, "")
	child.SessionUUID = engineSession
	args := claudeCommandArgs(child, scratch, !resume)
	if len(def.Tools) > 0 {
		args = append(args, "--tools", strings.Join(def.Tools, ","))
	}
	return child, args
}

// runClaudeChild runs Claude Code as a SubAgent: launched by the session's own argv and spawn code in the parent's
// cwd, in child mode — its own scratch dir, its own conversation, one prompt, no checkout of its own, nothing
// finalized and nothing committed. Every stream message is parsed by the session's own handleMessage.
func runClaudeChild(ctx context.Context, c subagentChild) (ExecResult, string, error) {
	res, err := runClaudeChildProcess(ctx, c.parent, c.exec, c.def, c.runID, c.engineSession, c.resume, c.cwd, c.scratch, c.prompt, c.emit)
	return res, c.engineSession, err
}

func runClaudeChildProcess(ctx context.Context, parent *ClaimedSession, exec AgentExecConfig, def subagentDefinition, runID,
	engineSession string, resume bool, cwd, scratch, prompt string, emit emitFn) (ExecResult, error) {
	child, args := claudeChildSession(parent, exec, def, runID, engineSession, resume, scratch)
	sp, err := spawnClaude(ctx, child, cwd, args)
	if err != nil {
		return ExecResult{}, err
	}
	var stderrTail strings.Builder
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		sc := bufio.NewScanner(sp.stderr)
		for sc.Scan() {
			if stderrTail.Len() < 4000 {
				stderrTail.WriteString(sc.Text() + "\n")
			}
		}
	}()
	frame := userFrame(engineSession, []map[string]interface{}{{"type": "text", "text": prompt}})
	if _, err := io.WriteString(sp.stdin, frame); err != nil {
		_ = sp.stdin.Close()
		_, _ = io.Copy(io.Discard, sp.stdout)
		<-stderrDone
		_ = waitSessionProcessTree(sp.cmd)
		return ExecResult{}, err
	}
	var res ExecResult
	got := false
	sc := bufio.NewScanner(sp.stdout)
	sc.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
	for sc.Scan() {
		var msg map[string]interface{}
		if json.Unmarshal([]byte(strings.TrimSpace(sc.Text())), &msg) != nil {
			continue
		}
		if _, ok := parseControlResponse(msg); ok {
			continue
		}
		if msg["type"] == "result" {
			res, got = resultFrom(msg, ctx), true
			break
		}
		handleMessage(msg, emit, nil)
	}
	_ = sp.stdin.Close()
	// Drain what is left so the CLI can exit, then reap it and anything it left in its process group.
	_, _ = io.Copy(io.Discard, sp.stdout)
	<-stderrDone
	waitErr := waitSessionProcessTree(sp.cmd)
	if !got {
		if ctx.Err() != nil {
			return ExecResult{Status: stCancelled}, nil
		}
		msg := strings.TrimSpace(stderrTail.String())
		if msg == "" && waitErr != nil {
			msg = waitErr.Error()
		}
		return ExecResult{Status: stFailed}, fmt.Errorf("the engine ended without a result: %s", firstNonEmpty(msg, "no output"))
	}
	return res, nil
}

func writeJSONFile(path string, v interface{}) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}

// ── Child mode, by engine ────────────────────────────────────────────────────────────────────────────────

// subagentChild is one SubAgent's child engine as its runner gets it: the parent's claim, the execution target the
// server answered, and where it runs — the parent's own cwd, with a scratch dir of its own.
type subagentChild struct {
	t      *Transport
	parent *ClaimedSession
	exec   AgentExecConfig
	def    subagentDefinition
	runID  string
	// engineSession is the conversation to continue (resume) or, for Claude Code, the id to open one under; ""
	// lets the engine name the one it opens.
	engineSession string
	resume        bool
	cwd, scratch  string
	prompt        string
	emit          emitFn
}

// subagentChildRunner runs one SubAgent to its end in child mode: the engine's own launch and event parsing, under
// ctx (the session's lifetime), one prompt, no checkout of its own, nothing finalized and nothing committed. It
// returns the engine's final result, cost and usage, and the id of the conversation it ran in, which a resume
// continues.
type subagentChildRunner func(ctx context.Context, c subagentChild) (ExecResult, string, error)

// subagentChildRunners are the engines a SubAgent can run on. Each engine's runner sits beside its session code
// (subagent_<engine>.go) and registers itself here.
var subagentChildRunners = map[string]subagentChildRunner{
	providerClaude: runClaudeChild,
}

// subagentResumeless are the engines whose child mode cannot reopen a finished conversation, with why.
var subagentResumeless = map[string]string{}

// subagentResumeRefusal refuses a resume the run's engine cannot do, before any run is opened for it.
func subagentResumeRefusal(rec *subagentRecord) error {
	if why, ok := subagentResumeless[rec.Engine]; ok {
		return fmt.Errorf("SubAgent %s ran on %s, which cannot resume a SubAgent's conversation (%s). Start a new SubAgent with the full brief instead", rec.RunID, rec.Engine, why)
	}
	if rec.Engine != providerClaude && rec.EngineSession == "" {
		return fmt.Errorf("SubAgent run %s left no conversation to resume", rec.RunID)
	}
	return nil
}

// subagentEngine is the engine the server's execution target names, else the parent's own.
func subagentEngine(exec AgentExecConfig, parent *ClaimedSession) string {
	return runtimeProvider(&ClaimedSession{Provider: exec.Provider, Agent: AgentExecConfig{Provider: parent.Provider}})
}

// subagentChildJob is the claim a child engine is launched from: the parent's, in child mode, on the server's
// execution target, with the definition applied — the preamble and the definition's body as its appended system
// prompt, no delegate, plan mode and no edit tools when it is read-only. engineSession is the conversation a
// resume continues (RuntimeSessionID, which every engine's open-or-resume reads), "" for a new one.
func subagentChildJob(parent *ClaimedSession, exec AgentExecConfig, def subagentDefinition, runID, provider, engineSession string) *ClaimedSession {
	child := *parent
	child.Provider = provider
	child.Agent = exec
	child.Agent.Provider = provider
	child.Agent.McpConfig = parent.Agent.McpConfig
	child.Agent.PromptSuggestions = false
	child.Agent.FastMode = false
	child.Agent.Env = map[string]string{}
	for k, v := range exec.Env {
		child.Agent.Env[k] = v
	}
	// Every engine's `orbit mcp` reads it: a SubAgent is neither offered nor served delegate (§0).
	child.Agent.Env[envSubagentRunID] = runID
	child.Agent.AppendSystemPrompt = subagentSystemPrompt(def)
	// No delegate: a SubAgent cannot hand work on (§5.1 step 3). Its `orbit mcp` offers none either; this keeps
	// the engine's own tool list without it too.
	child.Agent.DisallowedTools = appendUnique(exec.DisallowedTools, append([]string{delegateEngineToolName}, def.DisallowedTools...)...)
	if def.Readonly {
		// The server already narrows a read-only run to plan mode (§5.3); kept here so the child never reads wider.
		child.Agent.PermissionMode = "plan"
		child.Agent.DisallowedTools = appendUnique(child.Agent.DisallowedTools, subagentReadonlyDisallowed...)
	}
	child.RuntimeSessionID = engineSession
	// The session's own business, which a child has no part in: naming it, and its live mode (the server's
	// answer is the child's mode).
	child.Naming = nil
	child.liveMode = nil
	return &child
}

// subagentChildResult is a child turn's end as an ExecResult.
func subagentChildResult(status, result, errText string, costUsd float64, usage *TokenUsage) ExecResult {
	if status == "" {
		status = stSucceeded
	}
	res := ExecResult{Status: status, Result: strings.TrimSpace(result), CostUsd: costUsd, Usage: usage, NumTurns: 1}
	if status != stSucceeded {
		res.ErrorMsg = strings.TrimSpace(errText)
		res.Subtype = status
		if res.Result == "" {
			res.Result = res.ErrorMsg
		}
	}
	return res
}

// ── Approvals of a child engine ──────────────────────────────────────────────────────────────────────────

type subagentApprovalKey struct{}

// withSubagentApprovals marks ctx as a SubAgent's: an approval card a runner-side bridge files under it (Codex, Kimi,
// Cursor, DSH, Antigravity ask through Transport.createApproval with the child's context) names the run, and its
// call's id carries the run id as a prefix, as the parent's transcript writes it (rewriteSubagentEvent) — the same
// card approvalBodyOfPrompt files for a Claude child.
func withSubagentApprovals(ctx context.Context, runID string) context.Context {
	return context.WithValue(ctx, subagentApprovalKey{}, runID)
}

// subagentApprovalBody is body as a SubAgent files it, when ctx is one's; body otherwise.
func subagentApprovalBody(ctx context.Context, body interface{}) interface{} {
	if ctx == nil {
		return body
	}
	runID, _ := ctx.Value(subagentApprovalKey{}).(string)
	m, ok := body.(map[string]interface{})
	if runID == "" || !ok {
		return body
	}
	out := make(map[string]interface{}, len(m)+1)
	for k, v := range m {
		out[k] = v
	}
	if id := asString(m["toolUseId"]); id != "" && !strings.HasPrefix(id, runID+":") {
		out["toolUseId"] = subagentToolID(runID, id)
	}
	out["subagentRunId"] = runID
	return out
}

// ── The delegate call's id, for engines that do not send it ─────────────────────────────────────────────

// delegateCallWait is how long a delegate call with no id waits for its engine's tool_use to reach the stream: an
// engine announces the call as it makes it, so the two cross on their way to the runner.
var delegateCallWait = 3 * time.Second

// delegateCall is a delegate tool call one session's engine announced.
type delegateCall struct {
	id, prompt, description string
	taken                   bool
}

// delegateCallLog is each session's delegate calls as its engine announced them in the session's event stream.
// Claude Code tells `orbit mcp` which call a tools/call is (_meta "claudecode/toolUseId"); Codex and the ACP
// engines do not, so the runner, which sees every event the session emits, takes the id from the call's tool_use:
// the one whose prompt is the call's, else the oldest one not yet taken.
type delegateCallLog struct {
	mu       sync.Mutex
	changed  chan struct{}
	sessions map[string][]*delegateCall
}

var delegateCalls = &delegateCallLog{changed: make(chan struct{}), sessions: map[string][]*delegateCall{}}

// delegateCallLogCap bounds what one session keeps: the most recent calls.
const delegateCallLogCap = 32

// isDelegateToolName reports whether an engine's name for a tool is Orbit's delegate: mcp__orbit__delegate
// (Claude Code, Cursor, DSH, Antigravity, OpenCode), orbit__delegate (Codex), or a bare one.
func isDelegateToolName(name string) bool {
	n := strings.ToLower(strings.TrimSpace(name))
	return n == delegateToolName || n == delegateEngineToolName || n == "orbit__delegate" || n == "orbit_delegate" ||
		strings.HasSuffix(n, "orbit__delegate") || strings.HasSuffix(n, "orbit.delegate") || strings.HasSuffix(n, "orbit/delegate")
}

// note reads one event the session emitted.
func (l *delegateCallLog) note(sessionID, eventType string, payload map[string]interface{}) {
	if eventType != evToolUse || !isDelegateToolName(asString(payload["name"])) || asString(payload["subagentRunId"]) != "" {
		return
	}
	id := asString(payload["id"])
	if id == "" {
		return
	}
	input, _ := payload["input"].(map[string]interface{})
	if input == nil {
		// An input as JSON text (an MCP call's arguments, as some engines carry them).
		if raw := asString(payload["input"]); raw != "" {
			_ = json.Unmarshal([]byte(raw), &input)
		}
	}
	key := decodeSessionID(sessionID)
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, c := range l.sessions[key] {
		if c.id == id {
			return
		}
	}
	calls := append(l.sessions[key], &delegateCall{id: id, prompt: asString(input["prompt"]), description: asString(input["description"])})
	if len(calls) > delegateCallLogCap {
		calls = calls[len(calls)-delegateCallLogCap:]
	}
	l.sessions[key] = calls
	close(l.changed)
	l.changed = make(chan struct{})
}

// claim marks a call as taken by the id its engine sent.
func (l *delegateCallLog) claim(sessionID, id string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, c := range l.sessions[decodeSessionID(sessionID)] {
		if c.id == id {
			c.taken = true
		}
	}
}

// take is the id of the call a delegate with this prompt is, waiting up to wait for it to be announced; "" when
// none was.
func (l *delegateCallLog) take(sessionID, prompt, description string, wait time.Duration) string {
	key := decodeSessionID(sessionID)
	deadline := time.Now().Add(wait)
	for {
		l.mu.Lock()
		var match, oldest *delegateCall
		for _, c := range l.sessions[key] {
			if c.taken {
				continue
			}
			if oldest == nil {
				oldest = c
			}
			if match == nil && c.prompt != "" && c.prompt == prompt && (description == "" || c.description == "" || c.description == description) {
				match = c
			}
		}
		if match == nil && oldest != nil && oldest.prompt == "" {
			// A call announced without its input: the oldest open one.
			match = oldest
		}
		if match != nil {
			match.taken = true
			l.mu.Unlock()
			return match.id
		}
		changed := l.changed
		l.mu.Unlock()
		left := time.Until(deadline)
		if left <= 0 {
			return ""
		}
		select {
		case <-changed:
		case <-time.After(left):
		}
	}
}

// forget drops a session's calls when it ends.
func (l *delegateCallLog) forget(sessionID string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.sessions, decodeSessionID(sessionID))
}
