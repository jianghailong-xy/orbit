package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// shellTurnTimeout bounds a `!`-prefixed shell command so a hung process (e.g. a stray
// `tail -f`) can't pin the session's turn loop. The poller runs the command inline, so
// nothing else on the session advances until it returns or the context is cancelled.
//
// It is NOT the default for a task's EXECUTABLE acceptance command — acceptanceTurnTimeout is.
// The two were a single constant until the acceptance default was raised, and separating them is
// exactly what that raise is allowed to change: the reason a person waiting at a prompt gets two
// minutes is not the reason an unattended test suite gets what it gets. See shellTurnBudget for
// which of them a given turn is run under.
const (
	shellTurnTimeout = 2 * time.Minute
	// acceptanceTurnTimeout is the budget the server-generated EXECUTABLE acceptance command runs
	// under when its task declares no `acceptanceTimeoutSeconds`.
	//
	// Two minutes was the wrong default for the work it was the default for. Of the tasks that had
	// declared a budget by 2026-09-06 not one asked for less than 300s and the common declarations
	// were 3000-4200s, so the default was a number every author had to know the knob existed to
	// escape, and a task whose author did not know it was judged by host load. An hour holds a real
	// suite; a task that needs more still says so, and one that wants the old bound declares 120.
	//
	// It buys wall-clock and decides nothing. A command that outlives this is killed, reported as
	// exit -1 and compared literally against the task's expectation exactly as before — raising a
	// default cannot turn a failing suite into a passing one. The cost is the other side of the
	// same fact: an acceptance command that HANGS now holds its session for an hour rather than
	// two minutes, which is the exposure tasks declaring 3600-7200 already ran under.
	acceptanceTurnTimeout = time.Hour
	// tool_output is broadcast-only, so it cannot use the realtime bridge's durable-row
	// fallback when a JSON event exceeds PostgreSQL NOTIFY's payload limit. 1 KiB remains
	// below the bridge's 7 KiB safety envelope even when every byte needs a six-byte JSON
	// escape. Keep in sync with TOOL_OUTPUT_SNAPSHOT_MAX_BYTES in @orbit/shared.
	foregroundShellOutputCap = 1024
	foregroundShellPoll      = 250 * time.Millisecond
	// tool_output is intentionally not durable. Replaying an unchanged non-empty snapshot lets
	// a newly opened/reconnected subscriber recover the current tail without waiting for the
	// process to print another byte.
	foregroundShellReplay = 5 * time.Second
)

// shellOutputSnapshotter is the small common surface shared by ordinary `!` shells and typed
// EXECUTABLE acceptance shells. Their authoritative capture policies differ, but both expose the
// current combined stdout+stderr tail for the same transient tool_output protocol.
type shellOutputSnapshotter interface {
	snapshot(int) string
}

type foregroundShellSnapshotState struct {
	last       string
	lastAt     time.Time
	hasEmitted bool
}

// shouldEmit is the pure timing policy behind live shell snapshots. Changes are eligible on the
// next 250ms poll; unchanged non-empty output is replayed every five seconds for reconnecting
// subscribers. `now` is supplied by the caller so the policy is deterministic in unit tests.
func (s *foregroundShellSnapshotState) shouldEmit(content string, now time.Time) bool {
	if content == "" {
		return false
	}
	if s.hasEmitted && content == s.last && now.Sub(s.lastAt) < foregroundShellReplay {
		return false
	}
	s.last = content
	s.lastAt = now
	s.hasEmitted = true
	return true
}

func appendCappedTail(tail, p []byte, limit int) []byte {
	if limit <= 0 {
		return tail[:0]
	}
	if len(p) >= limit {
		return append(tail[:0], p[len(p)-limit:]...)
	}
	if overflow := len(tail) + len(p) - limit; overflow > 0 {
		copy(tail, tail[overflow:])
		tail = tail[:len(tail)-overflow]
	}
	return append(tail, p...)
}

// cappedUTF8Tail returns at most the last limit raw bytes, advancing past any UTF-8 continuation
// bytes at the cut and dropping a final rune prefix that a Writer call split mid-code-point. For
// valid UTF-8 output this preserves whole CJK/emoji code points instead of handing encoding/json
// an orphaned fragment that it would replace with U+FFFD. Invalid binary remains best-effort text:
// utf8.FullRune deliberately treats a complete invalid encoding as complete, so only a genuinely
// incomplete valid-rune prefix is removed. The authoritative full capture is untouched.
func cappedUTF8Tail(data []byte, limit int) []byte {
	if limit <= 0 {
		return data[:0]
	}
	tail := data
	if len(tail) > limit {
		tail = tail[len(tail)-limit:]
	}
	// A rolling buffer may already contain exactly `limit` bytes after dropping its prefix, so
	// inspect the first byte even when this call did not itself perform the slice.
	for len(tail) > 0 && tail[0]&0xc0 == 0x80 {
		tail = tail[1:]
	}
	if len(tail) == 0 {
		return tail
	}
	lastStart := len(tail) - 1
	for lastStart > 0 && !utf8.RuneStart(tail[lastStart]) {
		lastStart--
	}
	if !utf8.FullRune(tail[lastStart:]) {
		tail = tail[:lastStart]
	}
	return tail
}

// shellOutputBuffer keeps an ordinary foreground shell's complete output (the existing durable
// tool_result contract) while making concurrent snapshots safe as exec drains stdout/stderr.
type shellOutputBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *shellOutputBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Write(p)
}

func (b *shellOutputBuffer) snapshot(limit int) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(cappedUTF8Tail(b.buffer.Bytes(), limit))
}

func (b *shellOutputBuffer) output() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.String()
}

// waitWithForegroundShellOutput waits for a started process while publishing capped snapshots:
// changed output on the 250ms poll, plus a five-second replay while unchanged so a new/reconnected
// subscriber recovers the current tail. Wait runs on its own goroutine so this goroutine remains
// the sole emitter: the final snapshot is therefore ordered before (and never confused with) the
// authoritative tool_result the caller emits after this function returns.
func waitWithForegroundShellOutput(wait func() error, output shellOutputSnapshotter, emit emitFn, toolUseID string) error {
	waited := make(chan error, 1)
	go func() { waited <- wait() }()

	ticker := time.NewTicker(foregroundShellPoll)
	defer ticker.Stop()
	var snapshotState foregroundShellSnapshotState
	emitSnapshot := func(now time.Time) {
		content := output.snapshot(foregroundShellOutputCap)
		if !snapshotState.shouldEmit(content, now) {
			return
		}
		emit(evToolOutput, map[string]interface{}{
			"toolUseId": toolUseID,
			"content":   content,
		})
	}
	for {
		select {
		case err := <-waited:
			emitSnapshot(time.Now())
			return err
		case now := <-ticker.C:
			emitSnapshot(now)
		}
	}
}

// shellTurnBudget answers the one question a shell turn has to settle before it starts: how long
// may this process run? The answer is decided by the KIND of turn first and the task's declaration
// second — never the other way round.
//
// `interactive` is a person waiting at a prompt: two minutes, for the reason shellTurnTimeout
// gives, and a budget that somehow rides along on such a delivery is read by nothing.
// `acceptance` is the server-generated EXECUTABLE command, a test suite nobody is watching, and a
// declared `acceptanceTimeoutSeconds` replaces it for that task alone. Both defaults are
// parameters rather than reads of the constants so the substitution can be exercised at
// millisecond scale instead of across a real hour.
//
// This changes how long a command may run and nothing else. A command that outlives whichever
// budget applies is still killed, still reported as exit -1, and still compared literally against
// the task's expectation like any other integer — 0227 removed the typed termination that could
// tell a kill from a disagreement, and nothing here brings it back.
func shellTurnBudget(resp *RunInboxResponse, interactive, acceptance time.Duration) time.Duration {
	if resp == nil || !resp.TaskAcceptance {
		return interactive
	}
	if resp.AcceptanceTimeoutSeconds <= 0 {
		return acceptance
	}
	return time.Duration(resp.AcceptanceTimeoutSeconds) * time.Second
}

// runShellTurn executes `command` with bash in execDir — with the agent's configured env
// layered on the runner's own, matching the claude process — bypassing claude entirely. This is
// also the frozen EXECUTABLE completion environment documented in docs/task-completion-criteria.md.
// It
// emits a Bash tool_use/tool_result pair — the same shape claude's own Bash tool emits,
// so the transcript renders it identically (a `$ command` card + output) with no UI
// changes — and returns the combined stdout+stderr plus the process exit code.
func runShellTurn(ctx context.Context, execDir, command string, emit emitFn, turnID string, env map[string]string, budget time.Duration) (string, int) {
	toolUseID := "shell-" + turnID
	emit(evToolUse, map[string]interface{}{
		"id": toolUseID, "name": "Bash", "input": map[string]interface{}{"command": command},
	})
	cctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	cmd := exec.CommandContext(cctx, "bash", "-lc", command)
	configureSessionProcessTree(cmd)
	cmd.Dir = execDir
	cmd.Env = envWithAgent(env)
	var combined shellOutputBuffer
	cmd.Stdout = &combined
	cmd.Stderr = &combined
	err := cmd.Start()
	if err == nil {
		err = waitWithForegroundShellOutput(
			func() error { return waitSessionProcessTree(cmd) }, &combined, emit, toolUseID,
		)
	}
	out := combined.output()
	exit := 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			exit = ee.ExitCode()
		} else {
			// Failed to start, or killed by the timeout/shutdown — surface why inline.
			exit = -1
			out += "\n[" + err.Error() + "]"
		}
		// A command killed at its budget arrives here as an *ExitError too — SIGKILL, so
		// ExitCode() is already -1 — which means the branch above never ran and the transcript
		// showed a truncated log and an exit code that a genuinely failing suite could equally
		// have produced. Say which one it was, in the output TEXT and nowhere else: no typed
		// termination field, no change to the exit code, and nothing stored. The transcript is
		// the only place this difference is recorded, which is the accepted consequence of 0230.
		// `ctx.Err() == nil` keeps the claim honest: a supervisor shutting the session down
		// cancels this context too, and that is not the budget expiring.
		if errors.Is(cctx.Err(), context.DeadlineExceeded) && ctx.Err() == nil {
			out += fmt.Sprintf(
				"\n[orbit: killed at this shell turn's %s budget — the budget expired, the command"+
					" did not report a failure of its own. Exit -1 is compared literally and still"+
					" derives FAILED; declare acceptanceTimeoutSeconds on the task to raise it.]",
				budget)
		}
	}
	emit(evToolResult, map[string]interface{}{
		"toolUseId": toolUseID, "content": out, "isError": exit != 0,
	})
	return out, exit
}

// splitBackground detects a user `!`-shell asking to run in the background — a single trailing
// `&` (not `&&`) — and returns the command without it. Mirrors shell convention.
func splitBackground(command string) (string, bool) {
	t := strings.TrimRight(command, " \t\n")
	if strings.HasSuffix(t, "&") && !strings.HasSuffix(t, "&&") {
		if cmd := strings.TrimRight(t[:len(t)-1], " \t\n"); cmd != "" {
			return cmd, true
		}
	}
	return command, false
}

// shellTurnBackgroundCommand applies the user-shell `&` convenience only to user turns. A Task's
// server-generated EXECUTABLE command needs a completed process and its exit code, so it always takes the
// synchronous branch and executes resp.Content exactly as stored.
func shellTurnBackgroundCommand(resp *RunInboxResponse) (string, bool) {
	command, background := splitBackground(resp.Content)
	return command, background && !resp.TaskAcceptance
}

// shortShellID derives a short, display-friendly id for a user background shell from its turn id.
func shortShellID(turnID string) string {
	s := strings.ReplaceAll(turnID, "-", "")
	if len(s) > 8 {
		s = s[:8]
	}
	return "sh" + s
}

// runShellTurnBackground launches a user `!cmd &` shell in the background and returns at once.
// It emits the same launch shape as an agent background shell (a shell- tool_use + a "running
// in background with ID…" result), so the existing Background-processes tray, the live status,
// and the completion toast all pick it up unchanged; bgTailer owns the spawn, the output tail,
// and the exit report.
func runShellTurnBackground(bg *bgTailer, execDir, scratchDir, command, turnID string, emit emitFn, env map[string]string) {
	toolUseID := "shell-" + turnID
	shellID := shortShellID(turnID)
	outputPath := filepath.Join(scratchDir, shellID+".output")
	emit(evToolUse, map[string]interface{}{
		"id": toolUseID, "name": "Bash",
		"input": map[string]interface{}{"command": command, "run_in_background": true},
	})
	if err := bg.startUserShell(execDir, command, toolUseID, shellID, outputPath, env); err != nil {
		emit(evToolResult, map[string]interface{}{
			"toolUseId": toolUseID, "content": "[failed to start: " + err.Error() + "]", "isError": true,
		})
		return
	}
	emit(evToolResult, map[string]interface{}{
		"toolUseId": toolUseID,
		"content": fmt.Sprintf(
			"Command running in background with ID: %s. Output is being written to: %s. You will be notified when it completes.",
			shellID, outputPath),
	})
}

// runSynchronousShellTurn executes the server-generated EXECUTABLE acceptance command in the
// foreground and reports its exit code and complete output. There is one protocol: the control
// plane compares that exit code against the task's declared expectation. A process that never
// exited (timeout, cancellation, signal, failed start) has no exit code to report and is reported
// as a failed turn like any other -- 0227 removed the typed-termination protocol that used to
// tell those apart, and nothing here may reintroduce it.
func runSynchronousShellTurn(
	ctx context.Context,
	t *Transport,
	job *ClaimedSession,
	execDir string,
	resp *RunInboxResponse,
	emit emitFn,
) (TurnCompleteRequest, error) {
	out, exitCode := runShellTurn(
		ctx, execDir, resp.Content, emit, resp.TurnID, job.Agent.Env,
		shellTurnBudget(resp, shellTurnTimeout, acceptanceTurnTimeout),
	)
	return TurnCompleteRequest{
		TurnID: resp.TurnID, Status: stSucceeded, Result: fmt.Sprintf("exit %d", exitCode),
		ShellExitCode: &exitCode, ShellOutput: &out, Subtype: "shell",
	}, nil
}
