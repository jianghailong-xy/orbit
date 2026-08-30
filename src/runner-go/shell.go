package main

import (
	"bytes"
	"context"
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
const (
	shellTurnTimeout = 2 * time.Minute
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

// runShellTurn executes `command` with bash in execDir — with the agent's configured env
// layered on the runner's own, matching the claude process — bypassing claude entirely. This is
// also the frozen EXECUTABLE completion environment documented in docs/task-completion-criteria.md.
// It
// emits a Bash tool_use/tool_result pair — the same shape claude's own Bash tool emits,
// so the transcript renders it identically (a `$ command` card + output) with no UI
// changes — and returns the combined stdout+stderr plus the process exit code.
func runShellTurn(ctx context.Context, execDir, command string, emit emitFn, turnID string, env map[string]string) (string, int) {
	toolUseID := "shell-" + turnID
	emit(evToolUse, map[string]interface{}{
		"id": toolUseID, "name": "Bash", "input": map[string]interface{}{"command": command},
	})
	cctx, cancel := context.WithTimeout(ctx, shellTurnTimeout)
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
