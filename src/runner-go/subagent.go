package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
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
//
// The wake for a run's end is the server's (docs/subagent-design.md §2, §5.2): the PATCH that ends the run says
// whether one is owed, and the server files it in the run's own words, `<orbit-subagent-finished>`. A foreground
// call that stops waiting records that on the server first (subagent_detach), so a runner that restarts in the
// meantime cannot lose the wake: the server ends a run its runner left RUNNING when the next runner process takes
// the session over, and wakes the parent with why.
//
// Lifecycle (§5.2): the parent's engine may end its turn and be recycled while a SubAgent runs, but the idle
// park is deferred until none runs (the pool's subagentProbe). The parent's end stops every SubAgent first —
// SIGINT to its process group, subagentStopGrace, then the kill — and they are reported STOPPED before
// finalizeWorktree runs, which leaves what a stopped SubAgent touched out of the commit (holdSubagentPaths). A
// runner that stops ends them the same way, as INTERRUPTED, and the server wakes the parent with the reason.

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

	// Why the runner stops a SubAgent: the parent session ended (STOPPED), or the runner process hosting it is
	// stopping (INTERRUPTED).
	subagentStopSessionEnded  = "session_ended"
	subagentStopRunnerStopped = bgRunnerShutdownReason
	// The session moved to another runner process (ownership lost): STOPPED, and the parent is owed a wake there.
	subagentStopHandedOver = "session_moved"
)

// subagentStopGrace is how long a SubAgent asked to stop has to exit before it is killed (§5.2: 10 s), and
// subagentStopReportWait how long its stop then waits for the run to be reported before the session goes on
// ending. Variables only so a test need not sit them out.
var (
	subagentStopGrace      = 10 * time.Second
	subagentStopReportWait = 30 * time.Second
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

// subagentEditTools are the child tools whose input names a file they write, and the input field that names it.
var subagentEditTools = map[string]string{
	"Edit":         "file_path",
	"MultiEdit":    "file_path",
	"Write":        "file_path",
	"NotebookEdit": "notebook_path",
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
	if strings.TrimSpace(toolUseID) == "" {
		// An engine that does not say which call this is (Claude Code sends it as _meta "claudecode/toolUseId").
		// The run still works; its events nest under an id no call carries.
		id, err := newBgJobID()
		if err != nil {
			return toolResult("delegate failed: "+err.Error(), true)
		}
		toolUseID = "delegate_" + strings.TrimPrefix(id, "bgj_")
	}
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
	// cmd is the child engine once spawned, and stopReason why the runner stopped it (subagentStop…), empty
	// while nothing has. cancel kills it.
	cmd        *exec.Cmd
	stopReason string
	cancel     context.CancelFunc
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
	pending map[string]string // child tool id → path
	changed []string
	seen    map[string]bool
}

func newSubagentFileCollector(cwd string) *subagentFileCollector {
	return &subagentFileCollector{cwd: cwd, pending: map[string]string{}, seen: map[string]bool{}}
}

// note reads one child event, before it is rewritten.
func (c *subagentFileCollector) note(eventType string, payload map[string]interface{}) {
	switch eventType {
	case evToolUse:
		field, ok := subagentEditTools[asString(payload["name"])]
		if !ok {
			return
		}
		input, _ := payload["input"].(map[string]interface{})
		if path := asString(input[field]); path != "" {
			c.pending[asString(payload["id"])] = c.relative(path)
		}
	case evToolResult:
		id := asString(payload["toolUseId"])
		path, ok := c.pending[id]
		if !ok {
			return
		}
		delete(c.pending, id)
		if failed, _ := payload["isError"].(bool); failed {
			return
		}
		if !c.seen[path] {
			c.seen[path] = true
			c.changed = append(c.changed, path)
		}
	}
}

// touched is every path the child changed or was changing when it stopped: an edit whose result never came back
// may have left its file half-written.
func (c *subagentFileCollector) touched() []string {
	paths := append([]string(nil), c.changed...)
	seen := map[string]bool{}
	for _, p := range paths {
		seen[p] = true
	}
	for _, p := range c.pending {
		if !seen[p] {
			seen[p] = true
			paths = append(paths, p)
		}
	}
	sort.Strings(paths)
	return paths
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
		if run.status == subagentStatusRunning {
			run.detached = true
		}
		report := run.reportLocked()
		s.subagents.mu.Unlock()
		if report.Status == subagentStatusRunning {
			// The server holds the wake from here, whatever happens to this runner before the run ends.
			s.recordSubagentDetach(run.id)
		}
		return bgSocketResponse{OK: true, Result: report}
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
	// Child mode exists for Claude Code so far; P1 runs every SubAgent on the parent's own engine.
	if engine := runtimeProvider(s.job); engine != providerClaude {
		return subagentReport{}, fmt.Errorf("SubAgents cannot run on the %s engine on this runner yet. Do the work yourself", engine)
	}
	body := subagentStartBody(args, def, toolUseID, background)
	if description := strings.TrimSpace(getString(args, "description")); description != "" {
		body["description"] = description
	}
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
	engineSession := ""
	if resumeFrom != nil {
		engineSession = resumeFrom.EngineSession
	} else if engineSession, err = randomUUID(); err != nil {
		return subagentReport{}, err
	}
	// Not the session's context: cancelling that would kill the child at once, and its end is stopSubagents'
	// to make, with its grace, before the session's finalize (stopAll calls it first).
	ctx, cancel := context.WithCancel(context.Background())
	run := &subagentRun{
		id: created.RunID, toolUseID: toolUseID, description: getString(args, "description"),
		background: background, model: created.Exec.Model, engine: providerClaude, engineSession: engineSession, kind: def.Name,
		done: make(chan struct{}), startedAt: time.Now(), status: subagentStatusRunning, cancel: cancel,
	}
	s.subagents.add(run)
	s.bg.subagentsLive.Add(1)
	go s.runSubagent(ctx, run, created.Exec, def, prompt, resumeFrom != nil)
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

// runSubagent runs the child to its end, then reports it: the PATCH (which says whether the server owes the parent
// a wake), and for a run nobody is waiting on inline, the terminal background_task that clears it from the
// session's running SubAgents.
func (s *bgJobService) runSubagent(ctx context.Context, run *subagentRun, target AgentExecConfig, def subagentDefinition,
	prompt string, resume bool) {
	defer run.cancel()
	dir := subagentDir(s.sessionID, run.id)
	_ = os.MkdirAll(dir, 0o700)
	_ = writeJSONFile(filepath.Join(dir, "run.json"), subagentRecord{RunID: run.id, Engine: run.engine, EngineSession: run.engineSession, Type: run.kind})
	files := newSubagentFileCollector(s.execDir)
	// The tree as the child found it, so a stop can tell what changed while it ran (subagent_tree.go).
	before, treeKnown := takeSubagentTreeSnapshot(s.execDir)
	emit := func(eventType string, payload map[string]interface{}) {
		files.note(eventType, payload)
		if out, ok := rewriteSubagentEvent(run.id, run.toolUseID, eventType, payload); ok {
			s.bg.emit(eventType, out)
		}
	}
	spawned := func(cmd *exec.Cmd) {
		s.subagents.mu.Lock()
		run.cmd = cmd
		stopping := run.stopReason != ""
		s.subagents.mu.Unlock()
		if stopping {
			// Asked to stop while it was starting.
			_ = interruptSessionProcessGroup(cmd)
		}
	}
	res, err := runClaudeChild(ctx, s.job, target, def, run.id, run.engineSession, resume, s.execDir, dir, prompt, emit, spawned)
	s.subagents.mu.Lock()
	stopReason := run.stopReason
	s.subagents.mu.Unlock()
	status, result := subagentStatusDone, strings.TrimSpace(res.Result)
	switch {
	case stopReason == subagentStopRunnerStopped:
		status = subagentStatusInterrupted
		result = strings.TrimSpace("The SubAgent was interrupted: the runner process hosting it stopped (a restart or an" +
			" update). What it changed so far is in the working tree, uncommitted.\n" + result)
	case stopReason == subagentStopHandedOver:
		status = subagentStatusStopped
		result = strings.TrimSpace("The SubAgent was stopped when this session moved to another runner process. What it" +
			" changed so far is in the working tree, uncommitted.\n" + result)
	case stopReason != "" || ctx.Err() != nil:
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
	if status == subagentStatusStopped || status == subagentStatusInterrupted {
		// What a stopped SubAgent touched may be half-written: the session's finalize commit leaves it out. That is
		// every file its edit tools named, and every file of the tree that changed while it ran — through Bash as
		// much as through those tools — except what the parent's own edit tools wrote meanwhile.
		held := map[string]bool{}
		for _, p := range files.touched() {
			if !filepath.IsAbs(p) {
				p = filepath.Join(s.execDir, filepath.FromSlash(p))
			}
			held[filepath.Clean(p)] = true
		}
		root := s.execDir
		if treeKnown {
			if after, ok := takeSubagentTreeSnapshot(s.execDir); ok {
				for _, p := range after.changedSince(before, s.bg.parentEdits.since(run.startedAt)) {
					held[p] = true
				}
			}
			root = before.root
		}
		paths := make([]string, 0, len(held))
		for p := range held {
			paths = append(paths, p)
		}
		holdSubagentPaths(s.sessionID, s.execDir, paths)
		if note := subagentHeldNote(run.id, root, paths); note != "" {
			result = strings.TrimSpace(result + "\n\n" + note)
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
	// A wake is owed to a parent nobody answers inline: a background run, a foreground one whose call stopped
	// waiting, and any run the runner's stop interrupted, whose call (if any) went with the parent's engine. Not
	// to a run stopped because its session ended: there is nobody left to wake.
	// A run stopped because the session moved owes one too: the session goes on in its new home.
	answeredElsewhere := run.background || run.detached || status == subagentStatusInterrupted
	wake := (answeredElsewhere && status != subagentStatusStopped) || stopReason == subagentStopHandedOver
	s.subagents.mu.Unlock()

	_ = os.WriteFile(filepath.Join(dir, "result.txt"), []byte(result), 0o600)
	s.patchSubagent(run.id, report, res.Usage, wake)
	if answeredElsewhere || status == subagentStatusStopped {
		// The terminal background_task clears the delegate call from the session's running SubAgents, as a
		// background Agent's does.
		bgStatus := map[string]string{subagentStatusDone: bgStatusCompleted, subagentStatusFailed: bgStatusFailed}[status]
		if bgStatus == "" {
			bgStatus = bgStatusKilled
		}
		s.bg.emit(evBackgroundTask, map[string]interface{}{
			"toolUseId": run.toolUseID, "status": bgStatus, "summary": "SubAgent " + run.id + " " + strings.ToLower(status),
			"output": result, "subagentRunId": run.id,
		})
	}
	s.bg.subagentsLive.Add(-1)
	s.subagents.mu.Lock()
	close(run.done)
	s.subagents.mu.Unlock()
}

// stopSubagents ends every SubAgent of the session still running, for reason (subagentStop…): SIGINT to its
// process group, subagentStopGrace to exit, then the kill. Returns once each has been reported, or
// subagentStopReportWait after the kill. Run before the session's finalize commit (§5.2), so nothing a
// SubAgent is still writing is captured by it.
func (s *bgJobService) stopSubagents(reason string) {
	s.subagents.mu.Lock()
	var running []*subagentRun
	for _, r := range s.subagents.runs {
		if r.status != subagentStatusRunning {
			continue
		}
		if r.stopReason == "" {
			r.stopReason = reason
		}
		running = append(running, r)
		if r.cmd != nil {
			_ = interruptSessionProcessGroup(r.cmd)
		}
	}
	s.subagents.mu.Unlock()
	if len(running) == 0 {
		return
	}
	logln(fmt.Sprintf("stopping %d SubAgent(s) of session %s (%s)", len(running), s.sessionID, reason))
	waitAll := func(limit time.Duration) bool {
		deadline := time.After(limit)
		for _, r := range running {
			select {
			case <-r.done:
			case <-deadline:
				return false
			}
		}
		return true
	}
	if waitAll(subagentStopGrace) {
		return
	}
	for _, r := range running {
		r.cancel()
	}
	if !waitAll(subagentStopReportWait) {
		logln("SubAgents of session", s.sessionID, "were killed but not all reported in time")
	}
}

// announceSubagents reports every SubAgent still running again, behind a `resumed` handshake: the control plane
// empties the session's running set on that handshake (runner-api.controller bgReset), and these runs did not end
// with the replaced engine. A foreground run's call did, though — it was the replaced engine's — so its end is now
// owed as a wake, recorded on the server as a detach would be.
func (s *bgJobService) announceSubagents() {
	s.subagents.mu.Lock()
	var running []subagentReport
	var toolUseIDs []string
	var orphaned []string
	for _, r := range s.subagents.runs {
		if r.status != subagentStatusRunning {
			continue
		}
		if !r.background && !r.detached {
			r.detached = true
			orphaned = append(orphaned, r.id)
		}
		running = append(running, r.reportLocked())
		toolUseIDs = append(toolUseIDs, r.toolUseID)
	}
	s.subagents.mu.Unlock()
	for i, r := range running {
		s.bg.emit(evBackgroundTask, map[string]interface{}{
			"toolUseId": toolUseIDs[i], "status": "running", "kind": "subagent", "subagentRunId": r.RunID,
		})
	}
	for _, id := range orphaned {
		go s.recordSubagentDetach(id)
	}
}

// recordSubagentDetach tells the server that the call waiting for a run has stopped waiting, so the run's end
// wakes the parent (§2). A failure is logged and survived: the run's own report says the same.
func (s *bgJobService) recordSubagentDetach(runID string) {
	body := map[string]interface{}{"status": subagentStatusRunning, "wake": true}
	for attempt := 1; attempt <= 3; attempt++ {
		err := s.t.do(nil, "PATCH", "/runner/sessions/"+s.sessionID+"/subagents/"+runID, body, nil, 15*time.Second)
		if err == nil {
			return
		}
		if !isRetryableTransportError(err) || attempt == 3 {
			logln("could not record that the call for SubAgent", runID, "stopped waiting:", err)
			return
		}
		time.Sleep(time.Duration(attempt) * time.Second)
	}
}

// patchSubagent reports a run's end. Asked again while the control plane does not answer: the run's cost reaches
// the parent session only through it, and a repeated report is applied once.
func (s *bgJobService) patchSubagent(runID string, report subagentReport, usage *TokenUsage, wake bool) {
	body := map[string]interface{}{
		"status":        report.Status,
		"resultSummary": report.Result,
		"changedFiles":  nonNilStrings(report.ChangedFiles),
		"costUsd":       report.CostUsd,
		"wake":          wake,
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
func claudeChildSession(parent *ClaimedSession, target AgentExecConfig, def subagentDefinition, runID, engineSession string,
	resume bool, scratch string) (*ClaimedSession, []string) {
	child := *parent
	child.Provider = providerClaude
	child.Agent = target
	child.Agent.Provider = providerClaude
	child.Agent.McpConfig = parent.Agent.McpConfig
	child.Agent.PromptSuggestions = false
	child.Agent.FastMode = false
	child.Agent.Env = map[string]string{}
	for k, v := range target.Env {
		child.Agent.Env[k] = v
	}
	child.Agent.Env[envSubagentRunID] = runID
	child.Agent.AppendSystemPrompt = subagentSystemPrompt(def)
	// No delegate: a SubAgent cannot hand work on (§5.1 step 3). Its `orbit mcp` offers none either; this keeps
	// the engine's own tool list without it too.
	child.Agent.DisallowedTools = appendUnique(target.DisallowedTools, append([]string{delegateEngineToolName}, def.DisallowedTools...)...)
	if def.Readonly {
		// The server already narrows a read-only run to plan mode (§5.3); kept here so the child never reads wider.
		child.Agent.PermissionMode = "plan"
		child.Agent.DisallowedTools = appendUnique(child.Agent.DisallowedTools, subagentReadonlyDisallowed...)
	}
	child.SessionUUID = engineSession
	args := claudeCommandArgs(&child, scratch, !resume)
	if len(def.Tools) > 0 {
		args = append(args, "--tools", strings.Join(def.Tools, ","))
	}
	return &child, args
}

// runClaudeChild runs Claude Code as a SubAgent: launched by the session's own argv and spawn code in the parent's
// cwd, in child mode — its own scratch dir, its own conversation, one prompt, no checkout of its own, nothing
// finalized and nothing committed. Every stream message is parsed by the session's own handleMessage.
func runClaudeChild(ctx context.Context, parent *ClaimedSession, target AgentExecConfig, def subagentDefinition, runID,
	engineSession string, resume bool, cwd, scratch, prompt string, emit emitFn, spawned func(*exec.Cmd)) (ExecResult, error) {
	child, args := claudeChildSession(parent, target, def, runID, engineSession, resume, scratch)
	sp, err := spawnClaude(ctx, child, cwd, args)
	if err != nil {
		return ExecResult{}, err
	}
	if spawned != nil {
		spawned(sp.cmd)
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

// subagentHeld is, by session, the absolute paths a stopped SubAgent touched that its session's next finalize
// commit leaves out (holdSubagentPaths, unstageSubagentPaths).
var subagentHeld = struct {
	sync.Mutex
	paths map[string]map[string]bool
}{paths: map[string]map[string]bool{}}

// holdSubagentPaths records what a stopped SubAgent touched, relative to cwd, for the session's finalize commit to
// leave out: the file may be half-written, and a commit — a park checkpoint included — would make it look like
// work. It stays in the working tree, uncommitted, where the parent finds it on resume.
func holdSubagentPaths(sessionID, cwd string, paths []string) {
	if len(paths) == 0 {
		return
	}
	key := decodeSessionID(sessionID)
	subagentHeld.Lock()
	defer subagentHeld.Unlock()
	held := subagentHeld.paths[key]
	if held == nil {
		held = map[string]bool{}
		subagentHeld.paths[key] = held
	}
	for _, p := range paths {
		if !filepath.IsAbs(p) {
			p = filepath.Join(cwd, filepath.FromSlash(p))
		}
		held[filepath.Clean(p)] = true
	}
}

// takeSubagentHeldPaths hands over, once, the paths held for a session, relative to the checkout root dir. A
// path outside it is dropped: git has nothing to say about it.
func takeSubagentHeldPaths(sessionID, dir string) []string {
	key := decodeSessionID(sessionID)
	subagentHeld.Lock()
	held := subagentHeld.paths[key]
	delete(subagentHeld.paths, key)
	subagentHeld.Unlock()
	root := dir
	if resolved, err := filepath.EvalSymlinks(dir); err == nil {
		root = resolved
	}
	var rel []string
	for p := range held {
		r, err := filepath.Rel(dir, p)
		if err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
			r, err = filepath.Rel(root, p)
			if err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
				continue
			}
		}
		rel = append(rel, filepath.ToSlash(r))
	}
	sort.Strings(rel)
	return rel
}

// unstageSubagentPaths takes the paths a stopped SubAgent of the session touched out of what finalize staged, so
// the commit does not hold them. Called after staging and before the commit.
func unstageSubagentPaths(dir, sessionID string) {
	paths := takeSubagentHeldPaths(sessionID, dir)
	if len(paths) == 0 {
		return
	}
	args := append([]string{"rm", "--cached", "--quiet", "--ignore-unmatch", "--"}, paths...)
	if _, err := git(dir, "rev-parse", "--verify", "--quiet", "HEAD"); err == nil {
		args = append([]string{"reset", "--quiet", "--"}, paths...)
	}
	if _, err := git(dir, args...); err != nil {
		logln("could not leave the files of a stopped SubAgent out of the commit of session", sessionID+":", err)
		return
	}
	logln(fmt.Sprintf("session %s — left %d file(s) a stopped SubAgent touched out of the commit: %s",
		sessionID, len(paths), strings.Join(paths, ", ")))
}
