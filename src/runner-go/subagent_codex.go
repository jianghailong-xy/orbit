package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

func init() { subagentChildRunners[providerCodex] = runCodexChild }

// runCodexChild runs Codex as a SubAgent: the session's own app-server launch (startReadyCodexAppServer,
// startCodexAppServer) and notification parsing (handleCodexAppNotification) in the parent's cwd, in child mode —
// its Codex state under the run's own dir, a thread of its own (thread/resume of it on a resume), one turn/start,
// and no inbox, turn-complete, diff, finalize or commit. Approvals go through the session's own bridge, under the
// child's context, so a card names the run (subagentApprovalBody).
func runCodexChild(ctx context.Context, c subagentChild) (ExecResult, string, error) {
	resumeID := ""
	if c.resume {
		resumeID = c.engineSession
	}
	child := subagentChildJob(c.parent, c.exec, c.def, c.runID, providerCodex, resumeID)
	upDir := uploadsDir(child.SessionID)
	_ = os.MkdirAll(upDir, 0o755)
	stateHome := firstNonEmpty(c.stateDir, c.scratch)
	_ = os.MkdirAll(stateHome, 0o700)

	processEnv := envWithAgent(child.Agent.Env)
	state, err := resolveCodexStateDir(stateHome, child.RuntimeSessionID, readSessionMeta(filepath.Join(stateHome, "meta.json")), processEnv, c.cwd)
	if err != nil {
		return ExecResult{Status: stFailed}, "", errors.New("failed to prepare codex state: " + err.Error())
	}
	if state.CodexHome != "" {
		processEnv = envWithValue(processEnv, "CODEX_HOME", state.CodexHome)
	}
	// The layout is recorded in the run's own dir, so a resume of this conversation finds the same state.
	writeSessionMetaWithCodexState(stateHome, child, c.cwd, state.Layout, state.Partition, state.CodexHome)
	if state.Shared {
		if err := ensureSharedCodexStateReady(ctx, ctx, state, processEnv); err != nil {
			if ctx.Err() != nil {
				return ExecResult{Status: stCancelled}, "", nil
			}
			return ExecResult{Status: stFailed}, "", errors.New("failed to initialize shared codex state: " + err.Error())
		}
	}
	initTimeout := codexConnectionInitTimeout
	if state.Layout == codexStateLayoutLegacy {
		initTimeout = codexStateInitTimeout
	}
	autoContext := codexAutoApprovalContextFor(c.cwd, upDir)
	if child.WT != nil && child.WT.RepoDir != "" {
		autoContext = codexAutoApprovalContextFor(c.cwd, upDir, child.WT.RepoDir)
	}
	app, err := startReadyCodexAppServer(ctx, state, initTimeout, func() (*codexAppServer, error) {
		return startCodexAppServer(ctx, child, c.cwd, state.Dir, processEnv, c.emit,
			func(approvalCtx context.Context, request codexApprovalRequest, params map[string]interface{}) bool {
				return bridgeCodexApprovalWithContext(approvalCtx, c.t, child, request, params, autoContext)
			})
	})
	if err != nil {
		if ctx.Err() != nil {
			return ExecResult{Status: stCancelled}, "", nil
		}
		return ExecResult{Status: stFailed}, "", err
	}
	c.started(app.cmd)
	defer app.close()

	threadID, err := app.startOrResumeThread(ctx, child, c.cwd, upDir)
	if err != nil {
		if ctx.Err() != nil {
			return ExecResult{Status: stCancelled}, resumeID, nil
		}
		return ExecResult{Status: stFailed}, resumeID, errors.New("failed to start codex thread: " + err.Error())
	}
	if resumeID == "" && app.currentInstructionMode() == codexInstructionsInjectItems {
		if err := app.injectAgentContext(ctx, threadID, child.Agent, child.insideRecordedWork(), child.watchesOn()); err != nil {
			app.setInstructionMode(codexInstructionsUserInput)
		}
	}
	child.RuntimeSessionID = threadID
	writeSessionMetaWithCodexState(stateHome, child, c.cwd, state.Layout, state.Partition, state.CodexHome)

	var activeMu sync.Mutex
	active := &codexAppActiveTurn{
		orbitTurnID: c.runID,
		result:      codexTurnResult{Status: stSucceeded, Subtype: "completed", RuntimeSessionID: threadID},
	}
	ended := make(chan codexTurnResult, 1)
	finalize := func(result codexTurnResult) {
		a, snapshot, ok := beginCodexAppTurnFinalize(&activeMu, &active)
		if !ok {
			return
		}
		result = mergeCodexChildResult(result, snapshot)
		finishCodexAppTurnFinalize(&activeMu, &active, a)
		ended <- result
	}
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-app.done:
				return
			case msg := <-app.notifications:
				handleCodexAppNotification(threadID, msg, c.emit, &activeMu, &active, finalize, nil, nil, nil, nil)
			}
		}
	}()

	turnID, err := app.startTurn(ctx, threadID, child, c.cwd, upDir, c.runID, c.prompt, nil)
	if err != nil {
		if ctx.Err() != nil {
			return ExecResult{Status: stCancelled}, threadID, nil
		}
		return ExecResult{Status: stFailed}, threadID, errors.New("failed to start codex turn: " + err.Error())
	}
	activeMu.Lock()
	if active != nil && active.codexTurnID == "" {
		active.codexTurnID = turnID
	}
	activeMu.Unlock()

	select {
	case result := <-ended:
		return subagentChildResult(result.Status, result.Result, result.Error, 0, result.Usage), threadID, nil
	case <-ctx.Done():
		return ExecResult{Status: stCancelled}, threadID, nil
	case <-app.done:
		// A last notification may still be on its way to finalize.
		select {
		case result := <-ended:
			return subagentChildResult(result.Status, result.Result, result.Error, 0, result.Usage), threadID, nil
		default:
		}
		if ctx.Err() != nil {
			return ExecResult{Status: stCancelled}, threadID, nil
		}
		msg := "the codex app-server exited before the turn ended"
		if err := app.closedError(); err != nil {
			msg += ": " + err.Error()
		}
		return ExecResult{Status: stFailed}, threadID, errors.New(msg)
	}
}

// mergeCodexChildResult is a turn's end as the session's finalizeActive fills it in from what the turn gathered.
func mergeCodexChildResult(result codexTurnResult, snapshot codexAppTurnSnapshot) codexTurnResult {
	if result.Status == "" {
		result.Status = snapshot.result.Status
	}
	if result.Result == "" {
		result.Result = snapshot.result.Result
	}
	if result.Result == "" {
		result.Result = strings.TrimSpace(snapshot.fullText)
	}
	if result.Result == "" {
		result.Result = strings.TrimSpace(snapshot.deltaText)
	}
	if result.Error == "" {
		result.Error = snapshot.result.Error
	}
	if result.Usage == nil {
		result.Usage = snapshot.result.Usage
	}
	if result.Status == "" {
		result.Status = stSucceeded
	}
	return result
}
