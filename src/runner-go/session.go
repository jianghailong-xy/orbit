package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const maxRespawns = 5

var ctrlReqCounter int64

func nextReqID() string {
	return "req-" + strconv.FormatInt(atomic.AddInt64(&ctrlReqCounter, 1), 10)
}

// runInteractiveSession drives a long-lived `claude` process for an interactive
// session (Route B): it pulls user turns from the per-run inbox, feeds them over
// stdin as stream-json, streams events back, acks each turn via /turn-complete,
// and respawns with --resume on an unexpected crash. It finalizes the run on exit.
// sessionMeta is written to the scratch directory so `orbit resume` can find
// the claude session UUID and work directory without querying the server.
type sessionMeta struct {
	SessionUUID string `json:"sessionUuid"`
	WorkDir     string `json:"workDir"`
	Title       string `json:"title"`
}

func runInteractiveSession(t *Transport, job *ClaimedSession, ctx context.Context, execDir string) {
	scratch := filepath.Join(runsDir(), job.SessionID)
	_ = os.MkdirAll(scratch, 0o755)

	// Persist enough metadata for `orbit resume` to work offline.
	if b, err := json.Marshal(sessionMeta{SessionUUID: job.SessionUUID, WorkDir: execDir, Title: job.Title}); err == nil {
		_ = os.WriteFile(filepath.Join(scratch, "meta.json"), b, 0o644)
	}

	// Session-scoped, monotonic event seq that survives respawn. Continues from the
	// server's high-water mark so post-respawn events don't collide (skipDuplicates).
	seq := job.MaxSeq + 1
	var seqMu sync.Mutex

	// turnId of the message currently being processed; stamped onto every emitted
	// event so output is attributable to the conversation_turn that produced it.
	// "" for session-level events (claude system init, resumed, stderr). Turns are
	// strictly serialized server-side, so a single tracked value suffices.
	var curTurnMu sync.Mutex
	curTurn := ""
	setTurn := func(id string) {
		curTurnMu.Lock()
		curTurn = id
		curTurnMu.Unlock()
	}

	var bufMu sync.Mutex
	var buf []RunEvent
	flush := func() {
		bufMu.Lock()
		if len(buf) == 0 {
			bufMu.Unlock()
			return
		}
		events := buf
		buf = nil
		bufMu.Unlock()
		if err := t.postEvents(job.SessionID, RunEventBatch{Events: events}); err != nil {
			logln("event flush failed for", job.SessionID+":", err)
		}
	}
	emit := func(eventType string, payload map[string]interface{}) {
		seqMu.Lock()
		s := seq
		seq++
		seqMu.Unlock()
		curTurnMu.Lock()
		tid := curTurn
		curTurnMu.Unlock()
		bufMu.Lock()
		buf = append(buf, RunEvent{Seq: s, Type: eventType, TS: nowISO(), TurnID: tid, Payload: payload})
		bufMu.Unlock()
		// Do NOT postEvents inline: emit runs on the stdout-reader goroutine, and a
		// slow post must never stall draining claude's stdout (backpressure freeze).
		// The 250ms flush goroutine owns all network sends.
	}

	// Snappier streaming for interactive: flush every 250ms (vs 1s one-shot).
	stopFlush := make(chan struct{})
	var flushWg sync.WaitGroup
	flushWg.Add(1)
	go func() {
		defer flushWg.Done()
		tk := time.NewTicker(250 * time.Millisecond)
		defer tk.Stop()
		for {
			select {
			case <-stopFlush:
				return
			case <-tk.C:
				flush()
			}
		}
	}()

	logln(fmt.Sprintf("> interactive run %s — %s", job.SessionID, job.Title))
	status := stCancelled
	// A reclaimed or revived session's claude session already exists, so even its
	// first spawn must --resume (firstSpawn=false), not --session-id.
	firstSpawn := !job.Reclaimed && !job.Resume
	respawns := 0
	for {
		if ctx.Err() != nil {
			break
		}
		st, ended, reload := runSessionProcess(ctx, t, job, execDir, scratch, emit, setTurn, firstSpawn)
		firstSpawn = false
		if ended {
			status = st
			break
		}
		setTurn("") // 'resumed' is session-level, not part of any turn
		if reload {
			// The user changed the model / permission-mode mid-session: re-spawn with
			// --resume + the new flags (already applied to job.Agent). Not a crash, so
			// it doesn't consume the respawn budget and skips the back-off sleep.
			emit(evSystem, map[string]interface{}{"subtype": "resumed", "reason": "config_changed"})
			logln(fmt.Sprintf("interactive run %s — config changed; resuming with model=%s mode=%s", job.SessionID, job.Agent.Model, job.Agent.PermissionMode))
			continue
		}
		// Unexpected crash — resume up to maxRespawns times with a small back-off.
		respawns++
		if respawns > maxRespawns {
			status = stFailed
			break
		}
		emit(evSystem, map[string]interface{}{"subtype": "resumed", "attempt": respawns})
		logln(fmt.Sprintf("interactive run %s — claude exited unexpectedly; resuming (attempt %d)", job.SessionID, respawns))
		time.Sleep(time.Duration(respawns) * time.Second)
	}
	if ctx.Err() != nil {
		status = stCancelled
	}

	close(stopFlush)
	flushWg.Wait()
	flush()

	if err := t.complete(job.SessionID, CompleteRequest{Status: status}); err != nil {
		logln("complete failed for", job.SessionID+":", err)
	} else {
		logln(fmt.Sprintf("■ interactive run %s → %s", job.SessionID, status))
	}
}

// builtinTaskTools are Claude's built-in task/todo tools. They are disabled for
// every session because they collide with Orbit's own mcp__orbit__task_* tools:
// an agent asked to "create tasks" reaches for these, but their todos live only in
// the claude process and never reach Orbit's database, so the tasks never show in
// the UI. Disabling them forces all task work through the orbit MCP server.
var builtinTaskTools = []string{"TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TaskOutput", "TaskStop"}

// withBuiltinTaskToolsDisallowed appends builtinTaskTools to the agent's configured
// disallow list, de-duplicated and order-stable.
func withBuiltinTaskToolsDisallowed(configured []string) []string {
	seen := make(map[string]bool, len(configured)+len(builtinTaskTools))
	out := make([]string, 0, len(configured)+len(builtinTaskTools))
	for _, t := range append(append([]string{}, configured...), builtinTaskTools...) {
		if t != "" && !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return out
}

// runSessionProcess spawns ONE claude process and drives it until the session
// ends (an 'end' turn closes stdin) or the process exits. Returns (status, ended);
// ended=false means an unexpected crash that the caller should --resume.
// Returns (status, ended, reload). ended=false means the caller should re-spawn:
// reload=true for a requested model/permission-mode change (re-spawn with the new
// flags now on job.Agent), reload=false for an unexpected crash.
func runSessionProcess(ctx context.Context, t *Transport, job *ClaimedSession, execDir, scratchDir string, emit emitFn, setTurn func(string), firstSpawn bool) (string, bool, bool) {
	// Reset turn attribution for this (possibly re-spawned) process: events before
	// the first turn is (re-)fed — claude's system/init — are session-level (null).
	setTurn("")
	a := job.Agent
	// Set when an inbox 'reload' turn asks us to re-spawn with a new model/mode.
	var reloadRequested atomic.Bool
	// --max-turns / --max-budget-usd are process-wide (Phase 0), so they are
	// intentionally NOT passed for a long-lived interactive session.
	args := []string{
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--include-partial-messages",
		"--replay-user-messages",
		"--verbose",
		"--model", a.Model,
		"--permission-mode", a.PermissionMode,
	}
	if a.Effort != "" {
		args = append(args, "--effort", a.Effort)
	}
	// Apply the agent's configured prompts (claim payload carries both; previously
	// dropped here). --system-prompt replaces the default, --append-system-prompt adds.
	if a.SystemPrompt != "" {
		args = append(args, "--system-prompt", a.SystemPrompt)
	}
	if a.AppendSystemPrompt != "" {
		args = append(args, "--append-system-prompt", a.AppendSystemPrompt)
	}
	if len(a.AllowedTools) > 0 {
		args = append(args, "--allowedTools", strings.Join(a.AllowedTools, ","))
	}
	// Orbit ships its own task tools via the `orbit` MCP server (mcp__orbit__task_*).
	// Claude's built-in Task* tools collide by intent: an agent told to "create tasks"
	// reaches for them, but those entries are session-local todos that never reach
	// Orbit's DB — so the tasks never appear in the UI. Always disable the built-in
	// family so task work is forced through the orbit MCP server.
	if disallowed := withBuiltinTaskToolsDisallowed(a.DisallowedTools); len(disallowed) > 0 {
		args = append(args, "--disallowedTools", strings.Join(disallowed, ","))
	}
	// Always pass an --mcp-config: merge the agent's configured servers with the
	// built-in `orbit` server (this same binary in `mcp` mode), so every session can
	// manage Tasks. os.Executable() is resolved per-spawn, so it survives self-update.
	servers := map[string]interface{}{}
	for k, v := range a.McpConfig {
		servers[k] = v
	}
	if exe, err := os.Executable(); err == nil {
		servers["orbit"] = map[string]interface{}{"command": exe, "args": []string{"mcp"}}
	}
	if len(servers) > 0 {
		mcpPath := filepath.Join(scratchDir, "mcp.json")
		b, _ := json.Marshal(map[string]interface{}{"mcpServers": servers})
		_ = os.WriteFile(mcpPath, b, 0o644)
		args = append(args, "--mcp-config", mcpPath)
		// Route tool-permission prompts (incl. plan-mode ExitPlanMode) to the orbit MCP
		// server's permission_prompt tool, which blocks on a human allow/deny in the UI.
		// The orbit server is always injected above, so this target always exists.
		args = append(args, "--permission-prompt-tool", "mcp__orbit__permission_prompt")
	}
	if firstSpawn {
		args = append(args, "--session-id", job.SessionUUID)
	} else {
		args = append(args, "--resume", job.SessionUUID)
	}

	procCtx, procCancel := context.WithCancel(ctx)
	defer procCancel()
	cmd := exec.CommandContext(procCtx, "claude", args...)
	cmd.Dir = execDir
	// Inject session context so the built-in `orbit mcp` server (a child of claude)
	// knows where it is. The runner token is NOT passed here — `orbit mcp` reads it
	// from config.json so it never lands in the claude process environment.
	cmd.Env = append(os.Environ(),
		"ORBIT_SESSION_ID="+job.SessionID,
		"ORBIT_AGENT_ID="+job.AgentID, // empty => orbit mcp falls back to USER attribution
		"ORBIT_TASK_ID="+job.TaskID,   // empty => no "current task"
	)
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		emit(evError, map[string]interface{}{"message": "failed to spawn claude: " + err.Error()})
		return stFailed, true, false // a spawn failure won't be fixed by respawning
	}

	go func() {
		s := bufio.NewScanner(stderr)
		s.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for s.Scan() {
			emit(evSystem, map[string]interface{}{"stderr": s.Text() + "\n"})
		}
	}()

	pending := make(chan string, 8) // message turnIds fed but not yet resulted (FIFO)
	inflight := map[string]bool{}   // turnIds being processed (dedup lease re-delivery)
	var inflightMu sync.Mutex
	endedCh := make(chan struct{})
	var endOnce sync.Once
	endSession := func() {
		endOnce.Do(func() {
			close(endedCh)
			_ = stdin.Close()
		})
	}

	var stdinMu sync.Mutex
	writeStdin := func(line string) error {
		stdinMu.Lock()
		defer stdinMu.Unlock()
		_, err := io.WriteString(stdin, line)
		return err
	}

	// Inbox poller: pulls turns and acts immediately so interrupt/end land mid-turn.
	pollDone := make(chan struct{})
	go func() {
		defer close(pollDone)
		for procCtx.Err() == nil {
			resp, err := t.inbox(procCtx, job.SessionID)
			if err != nil {
				if procCtx.Err() != nil {
					return
				}
				logln("inbox poll failed for", job.SessionID+":", err)
				time.Sleep(time.Second)
				continue
			}
			if resp == nil {
				continue // long-poll timeout, re-poll
			}
			switch resp.Kind {
			case "message":
				// Attribute this process's output to this turn. Set BEFORE the dedup
				// early-return so a lease re-delivery (turn still running) still tags
				// the resumed/replayed output with the correct turn.
				setTurn(resp.TurnID)
				// The inbox lease can re-deliver a turn still running (turn > lease).
				// Dedup by turnId so we never double-feed claude or desync `pending`.
				inflightMu.Lock()
				dup := inflight[resp.TurnID]
				if !dup {
					inflight[resp.TurnID] = true
				}
				inflightMu.Unlock()
				if dup {
					continue
				}
				emit(evUser, map[string]interface{}{"text": resp.Content})
				select {
				case pending <- resp.TurnID:
				case <-procCtx.Done():
					return
				}
				line, _ := json.Marshal(map[string]interface{}{
					"type": "user",
					"message": map[string]interface{}{
						"role":    "user",
						"content": []map[string]interface{}{{"type": "text", "text": resp.Content}},
					},
				})
				if err := writeStdin(string(line) + "\n"); err != nil {
					logln("stdin write failed for", job.SessionID+":", err)
					return
				}
			case "interrupt":
				ctrl, _ := json.Marshal(map[string]interface{}{
					"type":       "control_request",
					"request_id": nextReqID(),
					"request":    map[string]interface{}{"subtype": "interrupt"},
				})
				_ = writeStdin(string(ctrl) + "\n")
				emit(evInterrupt, map[string]interface{}{})
			case "reload":
				// Model / permission-mode changed on this idle session. --model and
				// --permission-mode are spawn flags, so we apply the new values to
				// job.Agent and tear claude down; the outer loop re-spawns with
				// --resume + the new flags (full context preserved). Only the changed
				// fields are carried, so an untouched field keeps its running value.
				var cfg struct {
					Model          string `json:"model"`
					PermissionMode string `json:"permissionMode"`
				}
				if json.Unmarshal([]byte(resp.Content), &cfg) == nil {
					if cfg.Model != "" {
						job.Agent.Model = cfg.Model
					}
					if cfg.PermissionMode != "" {
						job.Agent.PermissionMode = cfg.PermissionMode
					}
				}
				reloadRequested.Store(true)
				procCancel() // kill claude; the main loop returns reload=true to re-spawn
				return
			case "end":
				endSession()
				return
			}
		}
	}()

	// Stdout reader (this goroutine): normalize messages; on each per-turn `result`
	// ack the oldest fed message turn via /turn-complete.
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var msg map[string]interface{}
		if json.Unmarshal([]byte(line), &msg) != nil {
			continue
		}
		handleMessage(msg, emit)
		if msg["type"] == "result" {
			r := resultFrom(msg, procCtx)
			turnStatus := stSucceeded
			if r.Subtype == "error_during_execution" {
				turnStatus = stInterrupted
			} else if r.Status == stFailed {
				turnStatus = stFailed
			}
			emit(evTurnEnd, map[string]interface{}{
				"subtype":  r.Subtype,
				"numTurns": r.NumTurns,
				"costUsd":  r.CostUsd,
			})
			var turnID string
			select {
			case turnID = <-pending:
			default:
			}
			if turnID != "" {
				if err := t.turnComplete(job.SessionID, TurnCompleteRequest{
					TurnID:     turnID,
					Status:     turnStatus,
					Result:     r.Result,
					Subtype:    r.Subtype,
					NumTurns:   r.NumTurns,
					CostUsd:    r.CostUsd,
					Usage:      r.Usage,
					ModelUsage: r.ModelUsage,
				}); err != nil {
					logln("turn-complete failed for", job.SessionID+":", err)
				}
				inflightMu.Lock()
				delete(inflight, turnID)
				inflightMu.Unlock()
				setTurn("") // turn acked; until the next message, events are session-level
			}
		}
	}
	_ = cmd.Wait()
	procCancel()
	<-pollDone

	if ctx.Err() != nil {
		return stCancelled, true, false
	}
	if reloadRequested.Load() {
		return stCancelled, false, true // config changed -> respawn with the new flags
	}
	select {
	case <-endedCh:
		return stSucceeded, true, false // user ended the session
	default:
		return stFailed, false, false // unexpected exit -> respawn with --resume
	}
}
