package main

import (
	"bufio"
	"context"
	"encoding/base64"
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

const (
	providerClaude = "claude"
	providerCodex  = "codex"
)

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
	Provider         string `json:"provider,omitempty"`
	SessionUUID      string `json:"sessionUuid"`
	RuntimeSessionID string `json:"runtimeSessionId,omitempty"`
	WorkDir          string `json:"workDir"`
	Title            string `json:"title"`
}

func runtimeProvider(job *ClaimedSession) string {
	p := strings.ToLower(strings.TrimSpace(job.Provider))
	if p == "" {
		p = strings.ToLower(strings.TrimSpace(job.Agent.Provider))
	}
	if p == providerCodex {
		return providerCodex
	}
	return providerClaude
}

func syncJobProvider(job *ClaimedSession) {
	p := runtimeProvider(job)
	job.Provider = p
	if job.Agent.Provider == "" {
		job.Agent.Provider = p
	}
	if p == providerClaude && job.RuntimeSessionID == "" {
		job.RuntimeSessionID = job.SessionUUID
	}
}

func currentRuntimeSessionID(job *ClaimedSession) string {
	if job.RuntimeSessionID != "" {
		return job.RuntimeSessionID
	}
	if runtimeProvider(job) == providerClaude {
		return job.SessionUUID
	}
	return ""
}

func writeSessionMeta(scratch string, job *ClaimedSession, execDir string) {
	meta := sessionMeta{
		Provider:         runtimeProvider(job),
		SessionUUID:      job.SessionUUID,
		RuntimeSessionID: currentRuntimeSessionID(job),
		WorkDir:          execDir,
		Title:            job.Title,
	}
	if b, err := json.Marshal(meta); err == nil {
		_ = os.WriteFile(filepath.Join(scratch, "meta.json"), b, 0o644)
	}
}

func runInteractiveSession(t *Transport, job *ClaimedSession, ctx context.Context, shutdownCtx context.Context, execDir string, onCodexRateLimits func(map[string]interface{})) {
	syncJobProvider(job)
	scratch := filepath.Join(runsDir(), job.SessionID)
	_ = os.MkdirAll(scratch, 0o755)

	// Persist enough metadata for `orbit resume` to work offline.
	writeSessionMeta(scratch, job, execDir)

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

	// Watches background-shell output files for live output and turns Claude's
	// <task-notification> messages into durable completion events. Shared across respawns;
	// all tails stop when this session run returns.
	bg := newBgTailer(ctx, emit)
	defer bg.stopAll()
	// Claude records background-shell completions in its transcript even while the session is
	// idle, but only streams them to stdout on the next turn; tail the transcript so a shell
	// that finishes between turns still clears from the "Background processes" tray. (Claude
	// only — Codex has no such transcript; the glob would simply never match.)
	if runtimeProvider(job) == providerClaude {
		go bg.watchJSONL(job.SessionUUID)
	}

	logln(fmt.Sprintf("> interactive run %s — %s", job.SessionID, job.Title))
	status := stCancelled
	// A reclaimed or revived session's claude session already exists, so even its
	// first spawn must --resume (firstSpawn=false), not --session-id.
	firstSpawn := !job.Reclaimed && !job.Resume
	respawns := 0
	for {
		if ctx.Err() != nil || shutdownCtx.Err() != nil {
			break
		}
		st, ended, reload := runSessionProcess(ctx, shutdownCtx, t, job, execDir, scratch, emit, setTurn, firstSpawn, bg, onCodexRateLimits)
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

	// Graceful drain: the runner is shutting down and this wasn't a real cancel/end (a
	// UI cancel sets ctx.Err; an end/crash sets stSucceeded/stFailed). Leave the session
	// AWAITING_INPUT — skip complete — so the next runner reclaims and --resumes it. Its
	// in-flight turn, if any, already finished and acked during the drain.
	if shutdownCtx.Err() != nil && ctx.Err() == nil && status == stCancelled {
		logln(fmt.Sprintf("⏸ interactive run %s — detached for shutdown (resumable)", job.SessionID))
		return
	}

	// Finalize the session's worktree (when isolated): commit the work onto its branch and
	// compute the diff, so the branch is usable for a manual merge even after the checkout
	// is removed. A SUCCEEDED/FAILED run is done — drop the checkout (the branch stays); a
	// CANCELLED one keeps its checkout for a possible resume and is reaped by gcWorktrees.
	// A cancelled run is still resumable (server settles it PARKED for idle/user-end), so its
	// finalize commit is a *park checkpoint* — tagged for undo-on-resume rather than permanent.
	cr := CompleteRequest{Status: status, IsolationStatus: job.IsolationStatus, RuntimeSessionID: currentRuntimeSessionID(job)}
	if runtimeProvider(job) == providerClaude {
		cr.ClaudeSessionID = job.SessionUUID
	}
	if job.WT != nil {
		cr.Branch = job.WT.Branch
		cr.BaseSha = job.WT.BaseSha
		cr.ChangedFiles, cr.ChangedDiff = finalizeWorktree(job.WT, status == stCancelled)
		// Candidate merge targets for the ended session's "Merge to…" dropdown.
		cr.MergeTargets = mergeTargetsForWT(job.WT)
	}
	if err := t.complete(job.SessionID, cr); err != nil {
		logln("complete failed for", job.SessionID+":", err)
	} else {
		logln(fmt.Sprintf("■ interactive run %s → %s", job.SessionID, status))
	}
	if job.WT != nil && (status == stSucceeded || status == stFailed) {
		removeWorktree(job.WT)
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

// envWithAgent returns the runner's own environment with the agent's custom env vars
// layered on top. Shared by the claude process and `!`-shells so a command run either
// way sees the same configured environment.
func envWithAgent(agentEnv map[string]string) []string {
	env := os.Environ()
	for k, v := range agentEnv {
		env = append(env, k+"="+v)
	}
	return env
}

func runSessionProcess(ctx context.Context, shutdownCtx context.Context, t *Transport, job *ClaimedSession, execDir, scratchDir string, emit emitFn, setTurn func(string), firstSpawn bool, bg *bgTailer, onCodexRateLimits func(map[string]interface{})) (string, bool, bool) {
	provider := runtimeProvider(job)
	// Fail fast with an actionable message if the engine CLI isn't on PATH — the
	// provider constants match the binary names. ended=true so we don't respawn.
	if _, err := exec.LookPath(provider); err != nil {
		emit(evError, map[string]interface{}{"message": engineMissingMessage(provider)})
		return stFailed, true, false
	}
	if provider == providerCodex {
		return runCodexSessionProcess(ctx, shutdownCtx, t, job, execDir, scratchDir, emit, setTurn, firstSpawn, bg, onCodexRateLimits)
	}
	return runClaudeSessionProcess(ctx, shutdownCtx, t, job, execDir, scratchDir, emit, setTurn, firstSpawn, bg)
}

// runClaudeSessionProcess spawns ONE claude process and drives it until the session
// ends (an 'end' turn closes stdin) or the process exits. Returns (status, ended,
// reload). ended=false means the caller should re-spawn: reload=true for a requested
// model/permission-mode change, reload=false for an unexpected crash.
func runClaudeSessionProcess(ctx context.Context, shutdownCtx context.Context, t *Transport, job *ClaimedSession, execDir, scratchDir string, emit emitFn, setTurn func(string), firstSpawn bool, bg *bgTailer) (string, bool, bool) {
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
	// Uploaded attachments land in the session's uploads dir, which is OUTSIDE execDir so they
	// stay out of git (see writeUpload). Add it as an explicit working dir so claude can read
	// them without a per-read permission prompt; created up front so the flag points at an
	// existing dir even before the first upload arrives.
	upDir := uploadsDir(job.SessionID)
	if err := os.MkdirAll(upDir, 0o755); err == nil {
		args = append(args, "--add-dir", upDir)
	}

	procCtx, procCancel := context.WithCancel(ctx)
	defer procCancel()
	// pollCtx gates only the inbox poller. On runner shutdown we cancel it to stop
	// pulling new turns WITHOUT tearing down claude, so an in-flight turn can finish and
	// ack before we detach. It derives from procCtx, so procCancel also stops the poller.
	pollCtx, pollCancel := context.WithCancel(procCtx)
	defer pollCancel()
	cmd := exec.CommandContext(procCtx, "claude", args...)
	cmd.Dir = execDir
	// Start from the runner's own env, then layer the agent's custom env vars on top.
	cmd.Env = envWithAgent(job.Agent.Env)
	// Inject session context so the built-in `orbit mcp` server (a child of claude)
	// knows where it is. The runner token is NOT passed here — `orbit mcp` reads it
	// from config.json so it never lands in the claude process environment.
	// Appended last so a custom env var can't shadow the session context.
	cmd.Env = append(cmd.Env,
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
		// Buffered `!`-shell output: each shell turn appends command+output here; the next
		// real message prepends + clears it so claude sees it as context (CLI `!` semantics).
		// Poller-goroutine-local (no lock), and intentionally lost on respawn.
		var pendingShellCtx []string
		for pollCtx.Err() == nil {
			resp, err := t.inbox(pollCtx, job.SessionID)
			if err != nil {
				if pollCtx.Err() != nil {
					return
				}
				logln("inbox poll failed for", job.SessionID+":", err)
				time.Sleep(time.Second)
				continue
			}
			if resp == nil {
				continue // long-poll timeout, re-poll
			}
			if pollCtx.Err() != nil {
				return // drain raced a pulled turn: drop it (the next runner re-delivers)
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
				// Build the claude user message by dispatching each attachment on its MIME
				// type: images and PDFs are inlined as base64 content blocks; anything else is
				// written to the session's uploads dir outside the worktree for claude to read
				// with its tools (its path is announced in the text below, kept out of git so it
				// isn't auto-committed or merged). The runner fetches each blob (runner-scoped); a
				// fetch/write failure drops just that one so the turn still goes through rather
				// than stalling. attRefs (id+mime+name) ride on the `user` event so the web can
				// render the attachments (image thumbnails / file chips) after a reload.
				content := []map[string]interface{}{}
				var attRefs []map[string]interface{}
				var writtenPaths []string
				for _, att := range resp.Attachments {
					data, ferr := t.fetchAttachment(procCtx, job.SessionID, att.ID)
					if ferr != nil {
						logln("attachment fetch failed for", job.SessionID, att.ID+":", ferr)
						continue
					}
					switch {
					// Only the media types Claude accepts as image blocks; other image/* (svg,
					// bmp, tiff) and every non-image, non-PDF type fall through to disk.
					case att.MimeType == "image/png" || att.MimeType == "image/jpeg" ||
						att.MimeType == "image/webp" || att.MimeType == "image/gif":
						content = append(content, map[string]interface{}{
							"type": "image",
							"source": map[string]interface{}{
								"type":       "base64",
								"media_type": att.MimeType,
								"data":       base64.StdEncoding.EncodeToString(data),
							},
						})
					case att.MimeType == "application/pdf":
						content = append(content, map[string]interface{}{
							"type": "document",
							"source": map[string]interface{}{
								"type":       "base64",
								"media_type": att.MimeType,
								"data":       base64.StdEncoding.EncodeToString(data),
							},
						})
					default:
						abs, werr := writeUpload(job.SessionID, att.FileName, att.ID, data)
						if werr != nil {
							logln("attachment write failed for", job.SessionID, att.ID+":", werr)
							continue
						}
						writtenPaths = append(writtenPaths, abs)
					}
					attRefs = append(attRefs, map[string]interface{}{"id": att.ID, "mime": att.MimeType, "name": att.FileName})
				}
				// Prepend any buffered `!`-shell output as context - claude sees the
				// command+output with this message (CLI `!` semantics), no turn spent on it.
				feedText := resp.Content
				if len(pendingShellCtx) > 0 {
					feedText = strings.Join(pendingShellCtx, "\n") + "\n\n" + resp.Content
					pendingShellCtx = nil
				}
				// Tell claude where the written-to-disk uploads landed (absolute paths outside
				// the worktree), so it reads them with its tools instead of expecting inline
				// content it never received.
				if len(writtenPaths) > 0 {
					note := fmt.Sprintf("[The user uploaded %d file(s), saved at: %s - read or process them with your tools as needed.]",
						len(writtenPaths), strings.Join(writtenPaths, ", "))
					if feedText != "" {
						feedText = note + "\n\n" + feedText
					} else {
						feedText = note
					}
				}
				// Keep the text block unless this is an inline-attachment-only turn with
				// nothing to feed.
				if feedText != "" || len(content) == 0 {
					content = append(content, map[string]interface{}{"type": "text", "text": feedText})
				}
				userEv := map[string]interface{}{"text": resp.Content}
				if len(attRefs) > 0 {
					userEv["attachments"] = attRefs
				}
				emit(evUser, userEv)
				select {
				case pending <- resp.TurnID:
				case <-procCtx.Done():
					return
				}
				line, _ := json.Marshal(map[string]interface{}{
					"type": "user",
					"message": map[string]interface{}{
						"role":    "user",
						"content": content,
					},
				})
				if err := writeStdin(string(line) + "\n"); err != nil {
					logln("stdin write failed for", job.SessionID+":", err)
					return
				}
			case "shell":
				// `!`-prefixed shell command: run it on the runner (no claude), echo the
				// output, and buffer it for the next message's context. Dedup on turnId so
				// a lease re-delivery can't re-run side effects.
				inflightMu.Lock()
				if inflight[resp.TurnID] {
					inflightMu.Unlock()
					continue
				}
				inflight[resp.TurnID] = true
				inflightMu.Unlock()
				setTurn(resp.TurnID)
				if shCmd, isBg := splitBackground(resp.Content); isBg {
					// `!cmd &`: launch detached and finish the turn now — the process keeps
					// running, surfaced in the Background-processes tray (output + completion),
					// not buffered into the next message's context.
					runShellTurnBackground(bg, execDir, scratchDir, shCmd, resp.TurnID, emit, job.Agent.Env)
					if err := t.turnComplete(job.SessionID, TurnCompleteRequest{
						TurnID: resp.TurnID, Status: stSucceeded,
						Result: "started in background", Subtype: "shell",
						RuntimeSessionID: currentRuntimeSessionID(job),
					}); err != nil {
						logln("shell turn-complete failed for", job.SessionID+":", err)
					}
				} else {
					shOut, shExit := runShellTurn(procCtx, execDir, resp.Content, emit, resp.TurnID, job.Agent.Env)
					pendingShellCtx = append(pendingShellCtx,
						fmt.Sprintf("<bash-input>%s</bash-input>\n<bash-stdout>%s</bash-stdout>", resp.Content, shOut))
					if err := t.turnComplete(job.SessionID, TurnCompleteRequest{
						TurnID: resp.TurnID, Status: stSucceeded,
						Result: fmt.Sprintf("exit %d", shExit), Subtype: "shell",
						RuntimeSessionID: currentRuntimeSessionID(job),
					}); err != nil {
						logln("shell turn-complete failed for", job.SessionID+":", err)
					}
				}
				inflightMu.Lock()
				delete(inflight, resp.TurnID)
				inflightMu.Unlock()
				setTurn("")
			case "interrupt":
				ctrl, _ := json.Marshal(map[string]interface{}{
					"type":       "control_request",
					"request_id": nextReqID(),
					"request":    map[string]interface{}{"subtype": "interrupt"},
				})
				_ = writeStdin(string(ctrl) + "\n")
				emit(evInterrupt, map[string]interface{}{})
			case "reload":
				// Model / permission-mode / effort changed on this idle session.
				// --model, --permission-mode and --effort are spawn flags, so we apply
				// the new values to job.Agent and tear claude down; the outer loop
				// re-spawns with --resume + the new flags (full context preserved).
				// Only the changed fields are carried, so an untouched field keeps its
				// running value. Effort is a *string so present-but-empty can clear it
				// back to the model default (drop --effort) — "" that model/mode can't.
				var cfg struct {
					Model          string  `json:"model"`
					PermissionMode string  `json:"permissionMode"`
					Effort         *string `json:"effort"`
				}
				if json.Unmarshal([]byte(resp.Content), &cfg) == nil {
					if cfg.Model != "" {
						job.Agent.Model = cfg.Model
					}
					if cfg.PermissionMode != "" {
						job.Agent.PermissionMode = cfg.PermissionMode
					}
					if cfg.Effort != nil {
						job.Agent.Effort = *cfg.Effort
					}
				}
				reloadRequested.Store(true)
				procCancel() // kill claude; the main loop returns reload=true to re-spawn
				return
			case "diff":
				// On-demand live-diff refresh: the web opened a file's diff and the stored
				// snapshot may lag the current worktree (the heartbeat refreshes the file list
				// but not the patch text). Recompute the full live diff and push it back so the
				// drawer shows the real diff within a second or two. Read-only (throwaway temp
				// index, like the heartbeat's liveDiffStat), so it's safe even mid-turn; no
				// claude involvement and no turn consumed. Acked server-side on delivery, so
				// there's no redelivery to dedup against.
				liveFiles, livePatches := liveDiff(job.WT)
				if err := t.diffResult(job.SessionID, DiffResultRequest{
					ChangedFiles:  liveFiles,
					ChangedDiff:   livePatches,
					WorktreeDirty: worktreeIsDirty(job.WT),
					BranchMerged:  branchMergedInto(job.WT),
				}); err != nil {
					logln("diff-result failed for", job.SessionID+":", err)
				}
			case "end":
				endSession()
				return
			}
		}
	}()

	// Drain watcher: on runner shutdown, stop pulling new turns and let any in-flight
	// turn finish + ack (pending drains as the stdout reader acks each `result`), then
	// tear claude down. The caller detaches without finalizing, so the next runner
	// reclaims + --resumes. Idle sessions (pending empty) detach at once.
	go func() {
		select {
		case <-procCtx.Done():
			return
		case <-shutdownCtx.Done():
		}
		pollCancel()
		tk := time.NewTicker(150 * time.Millisecond)
		defer tk.Stop()
		deadline := time.After(shutdownDrainTimeout)
		for len(pending) > 0 {
			select {
			case <-tk.C:
			case <-procCtx.Done():
				return
			case <-deadline:
				logln("drain timeout for", job.SessionID+"; tearing down mid-turn")
				procCancel()
				return
			}
		}
		procCancel()
	}()

	// Stdout reader (this goroutine): normalize messages; on each per-turn `result`
	// ack the oldest fed message turn via /turn-complete.
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
	// Text of the most recent assistant message this turn — a Claude API error (e.g.
	// content filtering) shows up here while the trailing `result` still says success,
	// so we use it to fail the turn below. Reset once the turn's `result` is handled.
	var lastAssistantText string
	// Running context-window occupancy: the latest top-level assistant message's total
	// tokens (input + cache + output). Carried into each turn_end event so the clients'
	// context gauge updates live and, via event replay, on session reopen. Persists
	// across turns within this process — the latest value is always the current context.
	var contextTokens int
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var msg map[string]interface{}
		if json.Unmarshal([]byte(line), &msg) != nil {
			continue
		}
		handleMessage(msg, emit, bg)
		if msg["type"] == "assistant" {
			if txt := assistantText(msg); txt != "" {
				lastAssistantText = txt
			}
			if ct := contextTokensFromAssistant(msg); ct > 0 {
				contextTokens = ct
			}
		}
		if msg["type"] == "result" {
			r := resultFrom(msg, procCtx)
			turnStatus := stSucceeded
			if r.Subtype == "error_during_execution" {
				turnStatus = stInterrupted
			} else if r.Status == stFailed {
				turnStatus = stFailed
			}
			// A Claude API error returns as assistant text + a "success" result with no
			// is_error, so it slips past resultFrom. Treat the turn as failed so the
			// control plane surfaces it (and reclaims a task session) instead of parking
			// the session as if the turn succeeded.
			if turnStatus == stSucceeded && (isAPIError(r.Result) || isAPIError(lastAssistantText)) {
				turnStatus = stFailed
			}
			lastAssistantText = ""
			if r.ClaudeSessionID != "" {
				job.RuntimeSessionID = r.ClaudeSessionID
				writeSessionMeta(scratchDir, job, execDir)
			}
			emit(evTurnEnd, map[string]interface{}{
				"subtype":       r.Subtype,
				"numTurns":      r.NumTurns,
				"costUsd":       r.CostUsd,
				"contextTokens": contextTokens,
			})
			var turnID string
			select {
			case turnID = <-pending:
			default:
			}
			if turnID != "" {
				// Live worktree state for the composer's status bar: what this turn left in
				// the worktree (uncommitted), so the diff updates each turn, not just at end.
				liveFiles, livePatches := liveDiff(job.WT)
				if err := t.turnComplete(job.SessionID, TurnCompleteRequest{
					TurnID:           turnID,
					Status:           turnStatus,
					Result:           r.Result,
					Subtype:          r.Subtype,
					NumTurns:         r.NumTurns,
					CostUsd:          r.CostUsd,
					Usage:            r.Usage,
					ModelUsage:       r.ModelUsage,
					RuntimeSessionID: currentRuntimeSessionID(job),
					IsolationStatus:  job.IsolationStatus,
					ChangedFiles:     liveFiles,
					ChangedDiff:      livePatches,
					WorktreeDirty:    worktreeIsDirty(job.WT),
					BranchMerged:     branchMergedInto(job.WT),
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
	}
	if shutdownCtx.Err() != nil {
		return stCancelled, true, false // graceful drain -> caller detaches without finalizing
	}
	return stFailed, false, false // unexpected exit -> respawn with --resume
}

// writeUpload saves a non-image/-PDF attachment into the session's uploads dir, which lives
// OUTSIDE the git worktree (see uploadsDir) so attachments are never swept into the session's
// auto-commit, surfaced in the live diff, or merged to main. Returns the ABSOLUTE path to hand
// to claude. The name is reduced to its base (no path traversal) and falls back to the
// attachment id when unusable.
func writeUpload(sessionID, name, id string, data []byte) (string, error) {
	base := filepath.Base(strings.TrimSpace(name))
	if base == "." || base == ".." || base == string(filepath.Separator) || base == "" {
		base = id
	}
	dir := uploadsDir(sessionID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	p := filepath.Join(dir, base)
	if err := os.WriteFile(p, data, 0o644); err != nil {
		return "", err
	}
	return p, nil
}
