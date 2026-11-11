package main

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"
)

func init() {
	subagentChildRunners[providerDsh] = runDshChild
}

// dshChildTurnID is the local turn id a DSH SubAgent's one prompt runs under. The child has no Orbit turn: the id only
// keeps the event mapper's turn bookkeeping, and the parent's stream never sees it (rewriteSubagentEvent keeps the
// payload's other fields, and localTurnId names nothing of the parent's).
const dshChildTurnID = "subagent-turn"

// dshChildHome is a DSH SubAgent's own DSH_HOME: under the run that opened its conversation (stateDir), so a resume,
// which runs as a new run, finds the conversation where the first run left it.
func dshChildHome(c subagentChild) string {
	return filepath.Join(firstNonEmpty(c.stateDir, c.scratch), "dsh-home")
}

// prepareDshChildLaunch is the launch of a DSH SubAgent: the session's own preparer (prepareDshLaunch, with its
// credential, file policy and agent overlay), on the child's claim, with the child's own home instead of the
// session's. A test replaces it, as prepareDshSessionLaunch is replaced.
var prepareDshChildLaunch = func(ctx context.Context, child *ClaimedSession, cwd, home string) (DshLaunchSpec, error) {
	input := DshLaunchInput{
		OrbitSessionID: child.SessionID, ExecutionDir: cwd,
		APIKey: child.Agent.Env["ORBIT_DSH_API_KEY"], BaseURL: child.Agent.Env["ORBIT_DSH_BASE_URL"],
		FileMode: dshFileModeForPermission(child.Agent.PermissionMode),
	}
	if strings.TrimSpace(input.APIKey) == "" {
		return DshLaunchSpec{}, errors.New(dshMissingKeyMessage)
	}
	if !dshSessionIDPattern.MatchString(input.OrbitSessionID) {
		return DshLaunchSpec{}, errors.New("DSH_CONFIG_CONFLICT: invalid Orbit session identity")
	}
	if msg := ensureEngine(ctx, providerDsh, func(string) {}); msg != "" {
		return DshLaunchSpec{}, errors.New(msg)
	}
	node, executable, err := dshRuntime()
	if err != nil {
		return DshLaunchSpec{}, err
	}
	spec, err := prepareDshAgentConfigAt(input, dshSessionAgentOverlay(child), executable, home)
	if err != nil {
		return DshLaunchSpec{}, err
	}
	spec.Executable, spec.Args = dshCommand(node, spec.Executable, spec.Args...)
	return spec, nil
}

// sealDshChildProfile seals a child's prepared profile (SealDshProfile); a test's mock launch has none to seal.
var sealDshChildProfile = SealDshProfile

// runDshChild runs DeepSeek Harness as a SubAgent: launched by the session's preparer and ACP driver in the parent's
// cwd, in child mode — its own DSH_HOME and conversation, one prompt, no inbox, no turn ledger, nothing reported as a
// turn, nothing finalized and nothing committed. Every update is parsed by the session's own dshEventMapper; its
// approvals go to the parent's session as the SubAgent's cards. DSH reports neither cost nor tokens, so the result
// carries none.
func runDshChild(ctx context.Context, c subagentChild) (ExecResult, string, error) {
	engineSession := ""
	if c.resume {
		engineSession = c.engineSession
	}
	child := subagentChildJob(c.parent, c.exec, c.def, c.runID, providerDsh, engineSession)
	// DSH has no plan mode: a read-only SubAgent runs under DSH's read-only file policy without asking anyone
	// (Don't Ask). Delegate is withheld by its `orbit mcp` itself (ORBIT_SUBAGENT_RUN_ID); a denylist the server
	// or the definition asks for is refused, as a session's is (dshToolPolicyError).
	if c.def.Readonly {
		child.Agent.PermissionMode = "dontAsk"
	}
	policy, err := dshPermissionPolicyFor(child.Agent.PermissionMode)
	if err == nil {
		err = dshToolPolicyError(child.Agent)
	}
	var mcpServers []interface{}
	if err == nil {
		mcpServers, err = dshMCPServers(child, policy)
	}
	if err != nil {
		return ExecResult{Status: stFailed}, engineSession, err
	}
	home := dshChildHome(c)
	spec, err := prepareDshChildLaunch(ctx, child, c.cwd, home)
	if err != nil {
		return ExecResult{Status: stFailed}, engineSession, err
	}
	if cwd, err := dshCanonicalDir(c.cwd); err != nil || spec.Cwd != cwd {
		return ExecResult{Status: stFailed}, engineSession, errors.New("dsh launch cwd differs from the parent session's working directory")
	}
	emitFor := func(_ string, kind string, payload map[string]interface{}) { c.emit(kind, payload) }
	mapper := newDshEventMapper(engineSession, emitFor)
	permissions := newDshPermissionBridge(func() dshPermissionPolicy { return policy }, mapper.toolCall,
		func(askCtx context.Context, ask dshPermissionAsk) string {
			// The bridge asks under a context of its own; the card is the SubAgent's (withSubagentApprovals).
			return bridgeDshPermission(withSubagentApprovals(askCtx, c.runID), c.t, c.parent.SessionID, ask)
		}, emitFor)
	permissions.workspace = spec.Cwd
	app, err := startDshACP(ctx, spec, mapper, permissions, c.emit)
	if err != nil {
		return ExecResult{Status: stFailed}, engineSession, fmt.Errorf("failed to start DeepSeek Harness: %w", err)
	}
	defer app.dispose()
	defer permissions.close()
	initCtx, initCancel := context.WithTimeout(ctx, 60*time.Second)
	defer initCancel()
	cancelled := func() (ExecResult, string, error) { return ExecResult{Status: stCancelled}, engineSession, nil }
	if err := app.initialize(initCtx); err != nil {
		if ctx.Err() != nil {
			return cancelled()
		}
		return ExecResult{Status: stFailed}, engineSession, err
	}
	// Seal the profile the pinned CLI generated before any conversation is opened or resumed, as a session does.
	if err := sealDshChildProfile(spec); err != nil {
		return ExecResult{Status: stFailed}, engineSession, err
	}
	sessionID := engineSession
	if sessionID == "" {
		if sessionID, err = app.open(initCtx, spec.Cwd, mcpServers); err != nil {
			if ctx.Err() != nil {
				return cancelled()
			}
			return ExecResult{Status: stFailed}, "", err
		}
	} else if err := app.resume(initCtx, sessionID, spec.Cwd, mcpServers); err != nil {
		if ctx.Err() != nil {
			return cancelled()
		}
		return ExecResult{Status: stFailed}, sessionID, fmt.Errorf("DeepSeek Harness could not resume SubAgent conversation %s: %w", sessionID, err)
	}
	mapper.mu.Lock()
	mapper.sessionID = sessionID
	mapper.mu.Unlock()
	if err := app.configure(initCtx, sessionID, child.Agent); err != nil {
		if ctx.Err() != nil {
			return cancelled()
		}
		return ExecResult{Status: stFailed}, sessionID, err
	}
	initCancel()
	if err := mapper.begin(dshChildTurnID); err != nil {
		return ExecResult{Status: stFailed}, sessionID, err
	}
	permissions.begin()
	result, promptErr := app.prompt(ctx, sessionID, dshChildTurnID, c.prompt)
	permissions.close()
	if ctx.Err() != nil {
		// The session ended: settle the mapper so open tools read as ended, and leave the conversation as it is.
		mapper.settle(dshChildTurnID, map[string]interface{}{"stopReason": "cancelled"}, nil)
		return cancelled()
	}
	req, _ := mapper.settle(dshChildTurnID, result, promptErr)
	closeCtx, closeCancel := context.WithTimeout(ctx, 5*time.Second)
	if err := app.closeSession(closeCtx, sessionID); err != nil {
		logln("dsh SubAgent", c.runID, "session/close:", err)
	}
	closeCancel()
	return subagentChildResult(req.Status, req.Result, req.Error, 0, nil), sessionID, nil
}
