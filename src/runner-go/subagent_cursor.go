package main

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"
)

// Cursor CLI as a SubAgent (docs/subagent-design.md §5.1): the session's own launch (prepareCursorLaunch), ACP
// client (startCursorACP), event mapper and permission bridge, in child mode — in the parent's cwd, its CLI state in
// a directory of the run's own, one prompt, no inbox, no turn ledger, no checkout of its own, nothing finalized and
// nothing committed.

func init() {
	subagentChildRunners[providerCursor] = runCursorChild
}

// cursorChildTurnID names the child's one turn to the mapper and the bridge. Its events reach the parent through
// c.emit, which carries no turn of its own.
const cursorChildTurnID = "subagent"

// cursorChildCard files a SubAgent's approval card: under the run (withSubagentApprovals), as the bridge's own
// context is not the child's. Its questions and plans ask nobody (§5.3).
func cursorChildCard(card cursorApprovalCard, runID string) cursorApprovalCard {
	return func(ctx context.Context, toolName string, input interface{}, toolUseID string) (*ApprovalDecisionResponse, error) {
		if toolName == "AskUserQuestion" || toolName == "ExitPlanMode" {
			return &ApprovalDecisionResponse{Status: "DENIED", Message: subagentAsksNobodyReason}, nil
		}
		return card(withSubagentApprovals(ctx, runID), toolName, input, toolUseID)
	}
}

// cursorChildExecutable is the pinned Cursor CLI build a child runs on, installed first when this runner may. A
// variable, for a test to run a recorded CLI instead.
var cursorChildExecutable = func(ctx context.Context) (string, error) {
	if msg := ensureEngine(ctx, providerCursor, func(string) {}); msg != "" {
		return "", errors.New(msg)
	}
	return cursorExecutablePath()
}

func runCursorChild(ctx context.Context, c subagentChild) (ExecResult, string, error) {
	conversation := ""
	if c.resume {
		conversation = c.engineSession
	}
	child := subagentChildJob(c.parent, c.exec, c.def, c.runID, providerCursor, conversation)
	stateDir := firstNonEmpty(c.stateDir, c.scratch)
	fail := func(err error) (ExecResult, string, error) { return ExecResult{Status: stFailed}, conversation, err }

	exe, err := cursorChildExecutable(ctx)
	if err != nil {
		return fail(err)
	}
	// The CLI's config, data and HOME are the run's own; a resume finds its conversation store in the opening run's.
	launch, err := prepareCursorLaunch(child, c.cwd, exe, filepath.Join(stateDir, "cursor"))
	if err != nil {
		return fail(err)
	}
	if !cursorLaunchSignsIn(launch.Env) {
		return fail(errors.New(cursorSignedOutMessage()))
	}
	policy, err := cursorPermissionPolicyFor(child.Agent.PermissionMode)
	if err == nil {
		err = cursorToolPolicyError(child.Agent)
	}
	var servers []interface{}
	if err == nil {
		servers, err = cursorMCPServers(child)
	}
	if err == nil && policy.Mode != "bypassPermissions" {
		err = guardCursorUserConfig(launch)
	}
	if err != nil {
		return fail(err)
	}

	emitFor := func(_ string, eventType string, payload map[string]interface{}) { c.emit(eventType, payload) }
	mapper := newCursorEventMapper(emitFor)
	preApproved := AgentExecConfig{AllowedTools: append([]string(nil), child.Agent.AllowedTools...)}
	bridge := newCursorPermissionBridge(policy, mapper.permissionAsk, mapper.refuse, mapper.withdraw, func(ask cursorPermissionAsk) bool {
		return cursorPreApproved(preApproved, ask)
	}, cursorChildCard(bridgeCursorCard(c.t, child.SessionID), c.runID), emitFor, launch.Cwd)
	bridge.prepareSandbox(ctx, child, runnerCursorSandboxInstaller, detectCursorSandbox, installCursorBubblewrap)
	app, err := startCursorACP(ctx, launch, mapper, bridge, c.emit)
	if err != nil {
		return fail(fmt.Errorf("failed to start Cursor CLI: %w", err))
	}
	defer app.dispose()
	defer func() { bridge.close(); bridge.wait() }()

	initCtx, initCancel := context.WithTimeout(ctx, 60*time.Second)
	defer initCancel()
	if err := app.initialize(initCtx); err != nil {
		return fail(fmt.Errorf("Cursor CLI did not start its ACP server: %w", err))
	}
	noReport := func(string, CursorKeyCheckReport) error { return nil }
	method := "session/load"
	if conversation == "" || cursorConversationUnspoken(launch.ConfigDir, conversation) {
		method = "session/new"
		conversation, err = app.open(initCtx, launch.Cwd, servers)
	} else {
		err = app.load(initCtx, conversation, launch.Cwd, servers)
	}
	if err != nil {
		if ctx.Err() != nil {
			return ExecResult{Status: stCancelled}, conversation, nil
		}
		return fail(errors.New(cursorOpenFailure(ctx, launch, child, method, err, noReport)))
	}
	child.RuntimeSessionID = conversation
	if err := app.configure(initCtx, conversation, child.Agent); err != nil {
		return fail(errors.New(cursorConfigureFailure(err)))
	}
	if err := app.enterMode(initCtx, conversation, policy.ACPMode); err != nil {
		return fail(fmt.Errorf("Cursor CLI did not take the SubAgent into its %s mode, so nothing was sent to it: %v", policy.ACPMode, err))
	}
	initCancel()

	// A new conversation carries the instructions (the preamble among them) ahead of its first prompt; a loaded
	// one has them from its first turn.
	instructions := ""
	if method == "session/new" {
		instructions = cursorAgentInstructions(child)
	}
	if err := mapper.begin(cursorChildTurnID); err != nil {
		return fail(err)
	}
	blocks, _ := prepareCursorPrompt(ctx, c.t, child, &RunInboxResponse{TurnID: cursorChildTurnID, Content: c.prompt},
		app.images, nil, instructions)
	bridge.begin(cursorChildTurnID)
	promptDone := make(chan cursorPromptResult, 1)
	go func() {
		result, err := app.prompt(ctx, conversation, blocks)
		promptDone <- cursorPromptResult{turnID: cursorChildTurnID, result: result, err: err}
	}()

	stopped := false
	var done cursorPromptResult
	select {
	case done = <-promptDone:
	case <-ctx.Done():
		// The session ended: Cursor is told, and the process goes with the deferred dispose.
		stopped = true
		bridge.stop(func() {
			app.post(map[string]interface{}{"jsonrpc": "2.0", "method": "session/cancel",
				"params": map[string]interface{}{"sessionId": conversation}})
		})
		select {
		case done = <-promptDone:
		case <-time.After(cursorStopGrace):
			app.fail(errors.New("Cursor CLI did not answer a stopped prompt"))
			done = <-promptDone
		}
	}
	bridge.close()
	end := cursorTurnEnd{result: done.result, err: done.err, stopped: stopped}
	if !end.answered() && !stopped && app.connectionClosed() {
		end.exit = app.awaitExit(cursorExitGrace)
		end.closed = end.exit == ""
	}
	result, err := cursorSettlementOutcome(end)
	if err != nil {
		err = errors.New(app.redact(err.Error()))
	}
	req, _ := mapper.settle(cursorChildTurnID, result, err)
	// What the turn says of its account's quota, as a session's turn is kept (cursor_usage.go).
	noteCursorTurn(cursorSessionAccount(child), req)
	if ctx.Err() != nil {
		return ExecResult{Status: stCancelled, Result: req.Result}, conversation, nil
	}
	if req.Status == "" {
		req.Status = stFailed
	}
	// Cursor reports no usage and no cost (§3.2): none is claimed.
	return subagentChildResult(req.Status, strings.TrimSpace(req.Result), req.Error, 0, nil), conversation, nil
}
