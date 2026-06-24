package main

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// shellTurnTimeout bounds a `!`-prefixed shell command so a hung process (e.g. a stray
// `tail -f`) can't pin the session's turn loop. The poller runs the command inline, so
// nothing else on the session advances until it returns or the context is cancelled.
const shellTurnTimeout = 2 * time.Minute

// runShellTurn executes `command` with bash in execDir, bypassing claude entirely. It
// emits a Bash tool_use/tool_result pair — the same shape claude's own Bash tool emits,
// so the transcript renders it identically (a `$ command` card + output) with no UI
// changes — and returns the combined stdout+stderr plus the process exit code.
func runShellTurn(ctx context.Context, execDir, command string, emit emitFn, turnID string) (string, int) {
	toolUseID := "shell-" + turnID
	emit(evToolUse, map[string]interface{}{
		"id": toolUseID, "name": "Bash", "input": map[string]interface{}{"command": command},
	})
	cctx, cancel := context.WithTimeout(ctx, shellTurnTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, "bash", "-lc", command)
	cmd.Dir = execDir
	out, err := cmd.CombinedOutput()
	exit := 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			exit = ee.ExitCode()
		} else {
			// Failed to start, or killed by the timeout/shutdown — surface why inline.
			exit = -1
			out = append(out, []byte("\n["+err.Error()+"]")...)
		}
	}
	emit(evToolResult, map[string]interface{}{
		"toolUseId": toolUseID, "content": string(out), "isError": exit != 0,
	})
	return string(out), exit
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
func runShellTurnBackground(bg *bgTailer, execDir, scratchDir, command, turnID string, emit emitFn) {
	toolUseID := "shell-" + turnID
	shellID := shortShellID(turnID)
	outputPath := filepath.Join(scratchDir, shellID+".output")
	emit(evToolUse, map[string]interface{}{
		"id": toolUseID, "name": "Bash",
		"input": map[string]interface{}{"command": command, "run_in_background": true},
	})
	if err := bg.startUserShell(execDir, command, toolUseID, shellID, outputPath); err != nil {
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
