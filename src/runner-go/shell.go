package main

import (
	"context"
	"os/exec"
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
