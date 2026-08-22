package main

// The DSH runtime: Orbit drives `dsh` (DeepSeek Harness) through the
// dsh-orbit-bridge.mjs engine process (task t5's artifact), which speaks the same
// stream-json JSONL protocol as claude on stdin/stdout — one bridge process per
// session, `user` frames in, `assistant`/`result` frames out. The bridge in turn
// spawns `dsh --profile headless "<prompt>"` per turn, so sessions have no agent
// continuity across turns (documented in docs/dsh-orbit-integration.md).
//
// The bridge reuses claude's frame shapes (userFrame / controlRequestFrame /
// parseControlResponse / handleMessage / resultFrom), so this driver mirrors
// runClaudeSessionProcess with the differences that matter:
//
//   - spawn is `node <bridge> --session-id <uuid>` instead of the claude CLI;
//   - the bridge is stateless: no --resume transcript, no sessionIDTaken, no
//     --replay-user-messages echo (delivery tops out at "written", never
//     "acknowledged");
//   - steers are refused unconditionally (the bridge queues user frames rather
//     than folding them into the running turn — see providerTransport.ts);
//   - a `result` with subtype "cancelled" maps to stInterrupted (the bridge's
//     interrupt/timeout outcome), and RuntimeSessionID stays empty (the engine
//     has no session id of its own; the Orbit SessionUUID is the only key).

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// dshBridgePath locates dsh-orbit-bridge.mjs: the DSH_ORBIT_BRIDGE env var wins,
// then the runner's own executable dir, then the repo-layout sibling
// ../orbit-dsh/. Absent on this machine means a session cannot run at all, so
// spawnDSH fails with a message naming the fix instead of a raw exec error.
func dshBridgePath() string {
	if p := strings.TrimSpace(os.Getenv("DSH_ORBIT_BRIDGE")); p != "" {
		return p
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	dir := filepath.Dir(exe)
	for _, cand := range []string{
		filepath.Join(dir, "dsh-orbit-bridge.mjs"),
		filepath.Join(dir, "..", "orbit-dsh", "dsh-orbit-bridge.mjs"),
	} {
		if fi, err := os.Stat(cand); err == nil && !fi.IsDir() {
			return cand
		}
	}
	return ""
}

// dshCommandArgs builds the bridge argv for one spawn. Like claude, the user's
// prompt is deliberately NOT argv: every turn is a `user` frame on stdin. The
// bridge is stateless, so a first spawn and a respawn are the same spawn.
func dshCommandArgs(job *ClaimedSession) []string {
	args := []string{"--session-id", job.SessionUUID}
	if model := strings.TrimSpace(job.Agent.Model); model != "" {
		args = append(args, "--model", model)
	}
	return args
}

// spawnDSH starts `node <bridge> [--session-id …] [--model …]` in execDir with the
// session's environment and the same ORBIT_* session context claude gets. Returns
// the same pipe bundle claudeSpawn holds, so the runtime below it is shared.
func spawnDSH(ctx context.Context, job *ClaimedSession, execDir string) (*claudeSpawn, error) {
	bridge := dshBridgePath()
	if bridge == "" {
		return nil, errors.New("dsh-orbit-bridge.mjs not found — set DSH_ORBIT_BRIDGE or place the bridge next to the orbit executable")
	}
	args := append([]string{bridge}, dshCommandArgs(job)...)
	cmd := exec.CommandContext(ctx, "node", args...)
	configureSessionProcessTree(cmd)
	cmd.Dir = execDir
	// Start from the runner's own env, then layer the agent's custom env on top,
	// exactly like spawnClaude. DSH_HOME / DEEPSEEK_API_KEY pass through; the
	// bridge forwards its whole environment to the dsh child it spawns per turn.
	cmd.Env = envWithAgent(job.Agent.Env)
	cmd.Env = append(cmd.Env,
		"ORBIT_SESSION_ID="+publicID(job.SessionID),
		"ORBIT_AGENT_ID="+publicID(job.AgentID),
		"ORBIT_TASK_ID="+publicID(job.TaskID),
		"ORBIT_ALLOW_ORCHESTRATION="+orchestrationEnv(job.AllowOrchestration),
		"ORBIT_SPAWN_DEPTH="+strconv.Itoa(job.SpawnDepth),
	)
	sp := &claudeSpawn{cmd: cmd}
	var err error
	if sp.stdin, err = cmd.StdinPipe(); err != nil {
		return nil, err
	}
	if sp.stdout, err = cmd.StdoutPipe(); err != nil {
		return nil, err
	}
	if sp.stderr, err = cmd.StderrPipe(); err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return sp, nil
}

// dshRuntime is a claudeRuntime with a name of its own in logs. The claude
// runtime type is protocol-level (a stdin queue, phases, control routing) and the
// bridge speaks exactly that protocol, so it is reused as-is; only String() —
// which labels every queue/control failure in logs and delivery errors — is
// overridden so a DSH session reads as "dsh runtime" rather than "claude runtime".
type dshRuntime struct {
	*claudeRuntime
}

func newDSHRuntime(proc *claudeSpawn) *dshRuntime {
	return &dshRuntime{claudeRuntime: newClaudeRuntime(proc)}
}

func (r *dshRuntime) String() string {
	return fmt.Sprintf("dsh runtime %d (pid %d)", r.generation, r.pid())
}

// runDSHSessionProcess spawns ONE bridge process and drives it until the session
// ends (an 'end' turn closes stdin) or the process exits. Returns (status, ended,
// reload) with the same contract as runClaudeSessionProcess: ended=false means the
// caller should re-spawn, reload=true for a requested config change.
func runDSHSessionProcess(ctx context.Context, shutdownCtx context.Context, t *Transport, job *ClaimedSession, leaseGeneration, execDir, scratchDir string, emit emitFn, emitFor emitTurnFn, setTurn func(string), firstSpawn bool, bg *bgTailer, completeTurn turnCompleter, waitTurnPermit turnPermitWaiter, onLeaseLost leaseLossHandler) (string, bool, bool) {
	setTurn("")
	var reloadRequested atomic.Bool
	var sawOutput atomic.Bool

	procCtx, procCancel := context.WithCancel(ctx)
	defer procCancel()
	pollCtx, pollCancel := context.WithCancel(procCtx)
	defer pollCancel()
	proc, err := spawnDSH(procCtx, job, execDir)
	if err != nil {
		emit(evError, map[string]interface{}{"message": "failed to spawn dsh bridge: " + err.Error()})
		return stFailed, true, false // a spawn failure won't be fixed by respawning
	}
	rt := newDSHRuntime(proc)
	defer rt.close()
	cmd, stdout, stderr := proc.cmd, proc.stdout, proc.stderr

	var stderrWg sync.WaitGroup
	stderrWg.Add(1)
	go func() {
		defer stderrWg.Done()
		s := bufio.NewScanner(stderr)
		s.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for s.Scan() {
			emit(evSystem, map[string]interface{}{"stderr": stripANSI(s.Text()) + "\n"})
		}
	}()

	pending := make(chan string, 8) // message turnIds fed but not yet resulted (FIFO)
	inflight := map[string]bool{}
	var inflightMu sync.Mutex
	deliveries := &deliveryLedger{}
	reportDelivery := deliveryReporter(func(turnID string, state deliveryState, reason string, retryable bool) {
		p := map[string]interface{}{"turnId": turnID, "delivery": string(state)}
		if reason != "" {
			p["reason"] = reason
			p["retryable"] = retryable
		}
		emit(evUserDelivery, p)
	})
	endedCh := make(chan struct{})
	var endOnce sync.Once
	endSession := func() {
		endOnce.Do(func() {
			close(endedCh)
			rt.close()
		})
	}

	// Inbox poller: pulls turns and acts immediately so interrupt/end land mid-turn.
	pollDone := make(chan struct{})
	go func() {
		defer close(pollDone)
		var pendingShellCtx []string
		for pollCtx.Err() == nil {
			resp, err := t.inbox(pollCtx, job.SessionID, leaseGeneration)
			if err != nil {
				if pollCtx.Err() != nil {
					return
				}
				if isLeaseOwnershipError(err) {
					onLeaseLost(err)
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
			case "message", "steer":
				// The DSH bridge queues user frames while a turn runs; it cannot fold
				// a message into the turn already in flight. The control plane is
				// asked first (supportsMidTurnSteer returns false for dsh), so a
				// steer reaching here is the two of them disagreeing — refuse loudly
				// rather than let the bridge's queued frame desync the ack queue.
				if resp.Kind == "steer" {
					refuseUnsupportedSteer(resp.TurnID, resp.Content, providerDSH, job, emitFor, completeTurn)
					continue
				}
				if !waitTurnPermit(procCtx) {
					return
				}
				setTurn(resp.TurnID)
				inflightMu.Lock()
				dup := inflight[resp.TurnID]
				if !dup {
					inflight[resp.TurnID] = true
				}
				inflightMu.Unlock()
				if dup {
					continue
				}
				delivery := newMessageDelivery(resp.TurnID, false)
				// Every attachment is written to the session's uploads dir (outside
				// the worktree) and announced in the text: the bridge accepts only
				// text blocks, and the dsh agent it spawns runs with execDir as its
				// cwd, so it can read the files with its tools.
				content := []map[string]interface{}{}
				var attRefs []map[string]interface{}
				var writtenPaths []string
				for _, att := range resp.Attachments {
					data, ferr := t.fetchAttachment(procCtx, job.SessionID, att.ID)
					if ferr != nil {
						logln("attachment fetch failed for", job.SessionID, att.ID+":", ferr)
						continue
					}
					abs, werr := writeUpload(job.SessionID, att.FileName, att.ID, data)
					if werr != nil {
						logln("attachment write failed for", job.SessionID, att.ID+":", werr)
						continue
					}
					writtenPaths = append(writtenPaths, abs)
					attRefs = append(attRefs, map[string]interface{}{"id": att.ID, "mime": att.MimeType, "name": att.FileName})
				}
				feedText := resp.Content
				if len(pendingShellCtx) > 0 {
					feedText = strings.Join(pendingShellCtx, "\n") + "\n\n" + resp.Content
				}
				if len(writtenPaths) > 0 {
					note := fmt.Sprintf("[The user uploaded %d file(s), saved at: %s - read or process them with your tools as needed.]",
						len(writtenPaths), strings.Join(writtenPaths, ", "))
					if feedText != "" {
						feedText = note + "\n\n" + feedText
					} else {
						feedText = note
					}
				}
				content = append(content, map[string]interface{}{"type": "text", "text": feedText})
				userEv := map[string]interface{}{"text": resp.Content}
				if len(attRefs) > 0 {
					userEv["attachments"] = attRefs
				}
				slot, err := rt.reserve()
				if err != nil {
					logln("feeding a turn to", rt.String(), "failed for", job.SessionID+":", err)
					deliveries.fail(delivery)
					reportDelivery(resp.TurnID, deliveryFailed, err.Error(), true)
					failUndeliveredTurn(resp.TurnID, err, job, completeTurn)
					setTurn("")
					inflightMu.Lock()
					delete(inflight, resp.TurnID)
					inflightMu.Unlock()
					continue
				}
				deliveries.accept(delivery, slot.receipt)
				pendingShellCtx = nil // this message carries it now
				userEv["delivery"] = string(deliveryEnqueued)
				emitFor(resp.TurnID, evUser, userEv)
				select {
				case pending <- resp.TurnID:
				case <-procCtx.Done():
					slot.abandon()
					return
				}
				receipt := slot.commit(userFrame(job.SessionUUID, content))
				rt.beginTurn()
				go func(d *messageDelivery, turnID string) {
					switch err := receipt.wait(procCtx); {
					case err == nil:
						if deliveries.markWritten(d) {
							reportDelivery(turnID, deliveryWritten, "", false)
						}
					case procCtx.Err() != nil:
						// The process is going away; its teardown accounts for what it
						// still owed (see settleUndeliveredMessages).
					default:
						if deliveries.fail(d) {
							reportDelivery(turnID, deliveryFailed, err.Error(), true)
							failUndeliveredTurn(turnID, err, job, completeTurn)
						}
					}
				}(delivery, resp.TurnID)
			case "shell":
				if !waitTurnPermit(procCtx) {
					return
				}
				inflightMu.Lock()
				if inflight[resp.TurnID] {
					inflightMu.Unlock()
					continue
				}
				inflight[resp.TurnID] = true
				inflightMu.Unlock()
				setTurn(resp.TurnID)
				if shCmd, isBg := splitBackground(resp.Content); isBg {
					runShellTurnBackground(bg, execDir, scratchDir, shCmd, resp.TurnID, emit, job.Agent.Env)
					if err := completeTurn(TurnCompleteRequest{
						TurnID: resp.TurnID, Status: stSucceeded,
						Result: "started in background", Subtype: "shell",
						BranchSha: effectiveBranchSha(job.WT),
					}); err != nil {
						logln("shell turn-complete failed for", job.SessionID+":", err)
					}
				} else {
					shOut, shExit := runShellTurn(procCtx, execDir, resp.Content, emit, resp.TurnID, job.Agent.Env)
					pendingShellCtx = append(pendingShellCtx,
						fmt.Sprintf("<bash-input>%s</bash-input>\n<bash-stdout>%s</bash-stdout>", resp.Content, shOut))
					if err := completeTurn(TurnCompleteRequest{
						TurnID: resp.TurnID, Status: stSucceeded,
						Result: fmt.Sprintf("exit %d", shExit), Subtype: "shell",
						BranchSha: effectiveBranchSha(job.WT),
					}); err != nil {
						logln("shell turn-complete failed for", job.SessionID+":", err)
					}
				}
				inflightMu.Lock()
				delete(inflight, resp.TurnID)
				inflightMu.Unlock()
				setTurn("")
			case "interrupt":
				// The bridge answers control_request/interrupt with a control_response
				// and kills its dsh child, then emits a `cancelled` result. Asked
				// unconditionally, like claude: a turn nobody sent may still be running.
				w, err := rt.requestControl(ctrlInterrupt)
				if err != nil {
					logln("interrupting", rt.String(), "failed for", job.SessionID+":", err)
					emit(evError, map[string]interface{}{"message": interruptFailureMessage(err)})
					continue
				}
				go func(w *controlWaiter) {
					err := rt.awaitControl(procCtx, w, claudeInterruptTimeout)
					switch {
					case err == nil:
						emit(evInterrupt, map[string]interface{}{"requestId": w.id})
					case procCtx.Err() != nil:
						logln("interrupt", w.id, "for", job.SessionID, "abandoned:", err)
					default:
						logln("interrupt", w.id, "for", job.SessionID, "failed:", err)
						emit(evError, map[string]interface{}{"message": interruptFailureMessage(err)})
					}
				}(w)
			case "reload":
				// Model/permission-mode/effort changed on this idle session. DSH has
				// no --resume continuity, so a reload just re-spawns a fresh bridge
				// with the updated job (and env). Only the changed fields are carried.
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
				applyProviderEnv(job, resp)
				reloadRequested.Store(true)
				procCancel() // kill the bridge; the main loop returns reload=true to re-spawn
				return
			case "diff":
				liveFiles, livePatches := liveDiff(job.WT)
				if err := t.diffResult(job.SessionID, DiffResultRequest{
					ChangedFiles:   liveFiles,
					ChangedDiff:    livePatches,
					WorktreeDirty:  worktreeIsDirty(job.WT),
					BranchSha:      effectiveBranchSha(job.WT),
					BranchMerged:   branchMergedInto(job.WT),
					WorktreeBranch: currentBranch(job.WT),
				}); err != nil {
					logln("diff-result failed for", job.SessionID+":", err)
				}
			case "end":
				endSession()
				return
			}
		}
	}()

	go watchShutdownDrain(procCtx, shutdownCtx, pending, shutdownDrainTimeout,
		pollCancel, procCancel, emit, job.SessionID)

	// Stdout reader (this goroutine): normalize messages; on each per-turn `result`
	// ack the oldest fed message turn via /turn-complete.
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
	var lastAssistantText string
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
		sawOutput.Store(true)
		if resp, ok := parseControlResponse(msg); ok {
			if !rt.resolveControl(resp) {
				logln("dropping an unmatched control_response", resp.RequestID,
					fmt.Sprintf("(generation %d)", controlIDGeneration(resp.RequestID)),
					"for", job.SessionID, "on", rt.String())
			}
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
			rt.endTurn()
			turnStatus := stSucceeded
			switch {
			case r.Subtype == "cancelled":
				turnStatus = stInterrupted // bridge's interrupt/timeout outcome
			case r.Subtype == "error_during_execution":
				turnStatus = stInterrupted
			case r.Status == stFailed:
				turnStatus = stFailed
			}
			if turnStatus == stSucceeded &&
				(isAPIError(r.Result) || isAPIError(lastAssistantText) ||
					isAuthError(r.Result) || isAuthError(lastAssistantText)) {
				turnStatus = stFailed
			}
			lastAssistantText = ""
			emit(evTurnEnd, withContextWindow(map[string]interface{}{
				"subtype":       r.Subtype,
				"numTurns":      r.NumTurns,
				"costUsd":       r.CostUsd,
				"contextTokens": contextTokens,
			}, job))
			var turnID string
			select {
			case turnID = <-pending:
			default:
			}
			if turnID != "" {
				liveFiles, livePatches := liveDiff(job.WT)
				if err := completeTurn(TurnCompleteRequest{
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
					BranchSha:        effectiveBranchSha(job.WT),
					BranchMerged:     branchMergedInto(job.WT),
					WorktreeBranch:   currentBranch(job.WT),
				}); err != nil {
					logln("turn-complete failed for", job.SessionID+":", err)
				}
				inflightMu.Lock()
				delete(inflight, turnID)
				inflightMu.Unlock()
				setTurn("")
			}
		}
	}
	// stdout EOF: the bridge is on its way out. Reclaim the child (and anything it
	// left running) once the writer has finished with stdin.
	rt.markTerminal()
	_ = rt.wait()
	settleUndeliveredMessages(deliveries, job, completeTurn, reportDelivery)
	stderrWg.Wait()
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
	// A clean exit with nothing on stdout is a startup refusal (bridge missing,
	// node missing): the same spawn with the same arguments refuses the same way.
	if cmd.ProcessState != nil && startupRefusal(cmd.ProcessState.ExitCode(), sawOutput.Load()) {
		return stFailed, true, false
	}
	return stFailed, false, false // unexpected exit -> respawn (fresh bridge)
}

// dshCLIAvailable reports whether the dsh CLI is on PATH — the runtime default
// probe's availability gate (runtime_defaults.go).
func dshCLIAvailable() bool {
	_, err := exec.LookPath("dsh")
	return err == nil
}

// fetchDSHDefaultModel reports the model the headless profile runs by default.
// DSH has no cheap "what model" query; the constant below is the composed
// headless default verified via `dsh --profile headless --dump-config`
// (deepseek-official/deepseek-v4-flash on the reference machine), overridable
// per deployment with DSH_ORBIT_MODEL.
func fetchDSHDefaultModel() (string, error) {
	if model := strings.TrimSpace(os.Getenv("DSH_ORBIT_MODEL")); model != "" {
		return model, nil
	}
	return "deepseek-official/deepseek-v4-flash", nil
}
