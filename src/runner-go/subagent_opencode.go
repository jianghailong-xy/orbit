package main

import (
	"context"
	"os"
)

func init() {
	subagentChildRunners[providerOpenCode] = runOpenCodeChild
}

// runOpenCodeChild runs OpenCode as a SubAgent: one `opencode run` of the session's own turn code (runOpenCodeTurn,
// handleOpenCodeEvent) in the parent's cwd, with its config dir, agent and instructions under the run's own scratch
// dir. No inbox, no turn completion, no diff report and nothing committed. A resume continues the run's OpenCode
// session (--session), which OpenCode keeps in its own data dir, not under the scratch dir.
func runOpenCodeChild(ctx context.Context, c subagentChild) (ExecResult, string, error) {
	conversation := ""
	if c.resume {
		conversation = c.engineSession
	}
	child := subagentChildJob(c.parent, c.exec, c.def, c.runID, providerOpenCode, conversation)
	// A new OpenCode session is titled by --title; the SubAgent's is not the parent's.
	child.Title = "SubAgent " + c.runID
	if err := os.MkdirAll(c.scratch, 0o700); err != nil {
		return ExecResult{Status: stFailed}, conversation, err
	}
	res := runOpenCodeTurn(ctx, child, c.cwd, c.scratch, c.prompt, nil, c.emit)
	if res.RuntimeSessionID != "" {
		conversation = res.RuntimeSessionID
	}
	if res.Status == stCancelled || res.Status == stInterrupted {
		return ExecResult{Status: stCancelled, Result: res.Result, CostUsd: res.CostUSD, Usage: res.Usage}, conversation, nil
	}
	out := subagentChildResult(res.Status, res.Result, res.Error, res.CostUSD, res.Usage)
	if res.NumTurns > 0 {
		out.NumTurns = res.NumTurns
	}
	return out, conversation, nil
}
