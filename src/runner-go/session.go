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
func runInteractiveSession(t *Transport, job *ClaimedJob, ctx context.Context, execDir string) {
	scratch := filepath.Join(runsDir(), job.RunID)
	_ = os.MkdirAll(scratch, 0o755)

	// Session-scoped, monotonic event seq that survives respawn. Continues from the
	// server's high-water mark so post-respawn events don't collide (skipDuplicates).
	seq := job.MaxSeq + 1
	var seqMu sync.Mutex

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
		if err := t.postEvents(job.RunID, RunEventBatch{Events: events}); err != nil {
			logln("event flush failed for", job.RunID+":", err)
		}
	}
	emit := func(eventType string, payload map[string]interface{}) {
		seqMu.Lock()
		s := seq
		seq++
		seqMu.Unlock()
		bufMu.Lock()
		buf = append(buf, RunEvent{Seq: s, Type: eventType, TS: nowISO(), Payload: payload})
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

	logln(fmt.Sprintf("> interactive run %s — %s", job.RunID, job.Title))
	status := stCancelled
	for attempt := 0; attempt <= maxRespawns; attempt++ {
		if ctx.Err() != nil {
			break
		}
		st, ended := runSessionProcess(ctx, t, job, execDir, scratch, emit, attempt == 0)
		if ended {
			status = st
			break
		}
		if attempt < maxRespawns {
			emit(evSystem, map[string]interface{}{"subtype": "resumed", "attempt": attempt + 1})
			logln(fmt.Sprintf("interactive run %s — claude exited unexpectedly; resuming (attempt %d)", job.RunID, attempt+1))
			time.Sleep(time.Duration(attempt+1) * time.Second)
		} else {
			status = stFailed
		}
	}
	if ctx.Err() != nil {
		status = stCancelled
	}

	close(stopFlush)
	flushWg.Wait()
	flush()

	if err := t.complete(job.RunID, CompleteRequest{Status: status}); err != nil {
		logln("complete failed for", job.RunID+":", err)
	} else {
		logln(fmt.Sprintf("■ interactive run %s → %s", job.RunID, status))
	}
}

// runSessionProcess spawns ONE claude process and drives it until the session
// ends (an 'end' turn closes stdin) or the process exits. Returns (status, ended);
// ended=false means an unexpected crash that the caller should --resume.
func runSessionProcess(ctx context.Context, t *Transport, job *ClaimedJob, execDir, scratchDir string, emit emitFn, firstSpawn bool) (string, bool) {
	a := job.Agent
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
	if len(a.AllowedTools) > 0 {
		args = append(args, "--allowedTools", strings.Join(a.AllowedTools, ","))
	}
	if len(a.DisallowedTools) > 0 {
		args = append(args, "--disallowedTools", strings.Join(a.DisallowedTools, ","))
	}
	if a.McpConfig != nil {
		mcpPath := filepath.Join(scratchDir, "mcp.json")
		b, _ := json.Marshal(map[string]interface{}{"mcpServers": a.McpConfig})
		_ = os.WriteFile(mcpPath, b, 0o644)
		args = append(args, "--mcp-config", mcpPath)
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
	cmd.Env = os.Environ()
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		emit(evError, map[string]interface{}{"message": "failed to spawn claude: " + err.Error()})
		return stFailed, true // a spawn failure won't be fixed by respawning
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
			resp, err := t.inbox(procCtx, job.RunID)
			if err != nil {
				if procCtx.Err() != nil {
					return
				}
				logln("inbox poll failed for", job.RunID+":", err)
				time.Sleep(time.Second)
				continue
			}
			if resp == nil {
				continue // long-poll timeout, re-poll
			}
			switch resp.Kind {
			case "message":
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
					logln("stdin write failed for", job.RunID+":", err)
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
				if err := t.turnComplete(job.RunID, TurnCompleteRequest{
					TurnID:     turnID,
					Status:     turnStatus,
					Result:     r.Result,
					Subtype:    r.Subtype,
					NumTurns:   r.NumTurns,
					CostUsd:    r.CostUsd,
					Usage:      r.Usage,
					ModelUsage: r.ModelUsage,
				}); err != nil {
					logln("turn-complete failed for", job.RunID+":", err)
				}
				inflightMu.Lock()
				delete(inflight, turnID)
				inflightMu.Unlock()
			}
		}
	}
	_ = cmd.Wait()
	procCancel()
	<-pollDone

	if ctx.Err() != nil {
		return stCancelled, true
	}
	select {
	case <-endedCh:
		return stSucceeded, true // user ended the session
	default:
		return stFailed, false // unexpected exit -> respawn with --resume
	}
}
