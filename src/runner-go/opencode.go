package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	errOpenCodeInterrupted     = errors.New("OpenCode turn interrupted")
	errOpenCodeEndRequested    = errors.New("OpenCode session ended")
	errOpenCodeShutdownTimeout = errors.New("OpenCode shutdown drain timed out")
)

type openCodeTurnResult struct {
	Status           string
	Result           string
	Subtype          string
	Error            string
	RuntimeSessionID string
	Usage            *TokenUsage
	ContextTokens    int
	NumTurns         int
	CostUSD          float64
}

type openCodePreparedTurn struct {
	Prompt         string
	AttachmentRefs []map[string]interface{}
	FilePaths      []string
}

type openCodeInboxResult struct {
	response *RunInboxResponse
	err      error
}

// runOpenCodeSessionProcess keeps inbox polling independent from the one-shot
// `opencode run` process. Unlike the legacy Codex exec loop, this lets an interrupt
// cancel the active child immediately while keeping the Orbit session available for
// another turn. Runner shutdown stops polling but drains an active turn.
func runOpenCodeSessionProcess(ctx context.Context, shutdownCtx context.Context, t *Transport, job *ClaimedSession, leaseGeneration, execDir, scratchDir string, emit emitFn, setTurn func(string), _ bool, bg *bgTailer, completeTurn turnCompleter, waitTurnPermit turnPermitWaiter, onLeaseLost leaseLossHandler) (string, bool, bool) {
	setTurn("")
	inboxCtx, stopInbox := contextUntilEither(ctx, shutdownCtx)
	defer stopInbox()
	inboxCh := make(chan openCodeInboxResult, 16)
	go func() {
		for inboxCtx.Err() == nil {
			resp, err := t.inbox(inboxCtx, job.SessionID, leaseGeneration)
			select {
			case inboxCh <- openCodeInboxResult{response: resp, err: err}:
			case <-inboxCtx.Done():
				return
			}
			// A superseded generation never regains ownership, so stop polling instead of
			// spinning on 409s; the main loop hands this session back below.
			if err != nil && isLeaseOwnershipError(err) {
				return
			}
			if err != nil && inboxCtx.Err() == nil {
				time.Sleep(time.Second)
			}
		}
	}()

	var pendingShellCtx []string
	var pendingReloads []*RunInboxResponse
	var queued []*RunInboxResponse
	seen := map[string]bool{}
	queuedIDs := map[string]bool{}
	var activeID string
	var activeCancel context.CancelCauseFunc
	var activeDone <-chan openCodeTurnResult
	endRequested := false
	draining := false
	ctxDone := ctx.Done()
	shutdownDone := shutdownCtx.Done()
	// Start the drain budget at the actual shutdown signal, even if the inbox
	// goroutine is briefly busy finishing a synchronous control operation.
	drainWatchCtx, stopDrainWatch := context.WithCancel(ctx)
	defer stopDrainWatch()
	shutdownExpired := make(chan struct{}, 1)
	go func() {
		select {
		case <-shutdownCtx.Done():
			timer := time.NewTimer(shutdownDrainTimeout)
			defer timer.Stop()
			select {
			case <-timer.C:
				shutdownExpired <- struct{}{}
			case <-drainWatchCtx.Done():
			}
		case <-drainWatchCtx.Done():
		}
	}()

	startMessage := func(resp *RunInboxResponse) {
		// A long-poll response can already be buffered when turn-complete parks the
		// session. Reject settled redeliveries before waiting for a fresh permit, or
		// they can block control handling and later replay completed side effects.
		if seen[resp.TurnID] {
			return
		}
		if !waitTurnPermit(ctx) {
			return
		}
		if seen[resp.TurnID] {
			return
		}
		seen[resp.TurnID] = true
		activeID = resp.TurnID
		setTurn(resp.TurnID)

		turnCtx, cancel := context.WithCancelCause(ctx)
		activeCancel = cancel
		done := make(chan openCodeTurnResult, 1)
		activeDone = done
		respCopy := *resp
		respCopy.Attachments = append([]TurnAttachment(nil), resp.Attachments...)
		shellCtx := append([]string(nil), pendingShellCtx...)
		pendingShellCtx = nil
		userEv := map[string]interface{}{"text": resp.Content}
		if refs := turnAttachmentRefs(resp.Attachments); len(refs) > 0 {
			userEv["attachments"] = refs
		}
		emit(evUser, userEv)

		go func() {
			// Attachment fetches can each take tens of seconds. Keep them off the
			// inbox goroutine so interrupt/end/shutdown can cancel this turn at once.
			prepared := prepareOpenCodeTurn(turnCtx, t, job, &respCopy, shellCtx)
			if turnCtx.Err() != nil {
				done <- cancelledOpenCodeTurn(turnCtx, job.RuntimeSessionID)
				return
			}
			done <- runOpenCodeTurn(turnCtx, job, execDir, scratchDir, prepared.Prompt, prepared.FilePaths, emit)
		}()
	}

	finishTurn := func(result openCodeTurnResult) {
		turnID := activeID
		if activeCancel != nil {
			activeCancel(nil)
		}
		if result.RuntimeSessionID != "" {
			job.RuntimeSessionID = result.RuntimeSessionID
			writeSessionMeta(scratchDir, job, execDir)
		}
		numTurns := result.NumTurns
		if numTurns < 1 {
			numTurns = 1
		}
		emit(evTurnEnd, withContextWindow(map[string]interface{}{
			"subtype":       result.Subtype,
			"numTurns":      numTurns,
			"costUsd":       result.CostUSD,
			"contextTokens": result.ContextTokens,
		}, job))
		liveFiles, livePatches := liveDiff(job.WT)
		if err := completeTurn(TurnCompleteRequest{
			TurnID:           turnID,
			Status:           result.Status,
			Result:           result.Result,
			Subtype:          result.Subtype,
			NumTurns:         numTurns,
			CostUsd:          result.CostUSD,
			Usage:            result.Usage,
			RuntimeSessionID: currentRuntimeSessionID(job),
			IsolationStatus:  job.IsolationStatus,
			ChangedFiles:     liveFiles,
			ChangedDiff:      livePatches,
			WorktreeDirty:    worktreeIsDirty(job.WT),
			BranchMerged:     branchMergedInto(job.WT),
			WorktreeBranch:   currentBranch(job.WT),
		}); err != nil {
			logln("turn-complete failed for", job.SessionID+":", err)
		}
		activeID = ""
		activeCancel = nil
		activeDone = nil
		setTurn("")
		if len(pendingReloads) > 0 {
			for _, reload := range pendingReloads {
				applyRuntimeReload(job, reload.Content)
				applyProviderEnv(job, reload)
			}
			pendingReloads = nil
			emit(evSystem, map[string]interface{}{"subtype": "resumed", "reason": "config_changed"})
		}
	}

	handleIdle := func(resp *RunInboxResponse) (ended bool) {
		switch resp.Kind {
		case "message":
			startMessage(resp)
		case "shell":
			if seen[resp.TurnID] || !waitTurnPermit(ctx) {
				return false
			}
			seen[resp.TurnID] = true
			setTurn(resp.TurnID)
			if shCmd, isBg := splitBackground(resp.Content); isBg {
				runShellTurnBackground(bg, execDir, scratchDir, shCmd, resp.TurnID, emit, job.Agent.Env)
				if err := completeTurn(TurnCompleteRequest{TurnID: resp.TurnID, Status: stSucceeded, Result: "started in background", Subtype: "shell", RuntimeSessionID: currentRuntimeSessionID(job)}); err != nil {
					logln("shell turn-complete failed for", job.SessionID+":", err)
				}
			} else {
				shellCtx, stopShell := contextUntilEither(ctx, shutdownCtx)
				shOut, shExit := runShellTurn(shellCtx, execDir, resp.Content, emit, resp.TurnID, job.Agent.Env)
				stopShell()
				pendingShellCtx = append(pendingShellCtx, fmt.Sprintf("<bash-input>%s</bash-input>\n<bash-stdout>%s</bash-stdout>", resp.Content, shOut))
				if err := completeTurn(TurnCompleteRequest{TurnID: resp.TurnID, Status: stSucceeded, Result: fmt.Sprintf("exit %d", shExit), Subtype: "shell", RuntimeSessionID: currentRuntimeSessionID(job)}); err != nil {
					logln("shell turn-complete failed for", job.SessionID+":", err)
				}
			}
			setTurn("")
		case "interrupt":
			emit(evInterrupt, map[string]interface{}{})
		case "reload":
			applyRuntimeReload(job, resp.Content)
			// No re-spawn: OpenCode runs one child per turn, so the next one is already
			// launched with whatever environment job.Agent holds by then.
			applyProviderEnv(job, resp)
			emit(evSystem, map[string]interface{}{"subtype": "resumed", "reason": "config_changed"})
		case "diff":
			reportOpenCodeDiff(inboxCtx, t, job)
		case "end":
			return true
		}
		return false
	}

	for {
		if activeID == "" {
			if endRequested {
				return stSucceeded, true, false
			}
			if ctx.Err() != nil || draining {
				return stCancelled, true, false
			}
			if len(queued) > 0 {
				resp := queued[0]
				queued = queued[1:]
				delete(queuedIDs, resp.TurnID)
				if handleIdle(resp) {
					return stSucceeded, true, false
				}
				continue
			}
		}

		select {
		case <-ctxDone:
			ctxDone = nil
			stopInbox()
			if activeCancel != nil {
				activeCancel(context.Canceled)
			}
		case <-shutdownDone:
			shutdownDone = nil
			draining = true
			stopInbox()
		case <-shutdownExpired:
			draining = true
			stopInbox()
			logln("OpenCode drain timeout for", job.SessionID+"; cancelling active turn")
			if activeCancel != nil {
				activeCancel(errOpenCodeShutdownTimeout)
			}
		case result := <-activeDone:
			finishTurn(result)
		case item := <-inboxCh:
			if item.err != nil {
				if isLeaseOwnershipError(item.err) {
					stopInbox()
					if activeCancel != nil {
						activeCancel(context.Canceled)
					}
					onLeaseLost(item.err)
					return stCancelled, true, false
				}
				if inboxCtx.Err() == nil {
					logln("inbox poll failed for", job.SessionID+":", item.err)
				}
				continue
			}
			resp := item.response
			if resp == nil {
				continue
			}
			if activeID == "" {
				if handleIdle(resp) {
					return stSucceeded, true, false
				}
				continue
			}
			switch resp.Kind {
			case "interrupt":
				activeCancel(errOpenCodeInterrupted)
				emit(evInterrupt, map[string]interface{}{})
			case "end":
				endRequested = true
				queued = nil
				queuedIDs = map[string]bool{}
				activeCancel(errOpenCodeEndRequested)
			case "reload":
				// The active child reads job.Agent while it builds args/config. Defer
				// mutations until it finishes so this turn has one immutable snapshot
				// and the next turn receives every queued partial reload in order.
				pendingReloads = append(pendingReloads, resp)
			case "diff":
				reportOpenCodeDiff(inboxCtx, t, job)
			case "message", "shell":
				if resp.TurnID != activeID && !seen[resp.TurnID] && !queuedIDs[resp.TurnID] && !endRequested {
					queued = append(queued, resp)
					queuedIDs[resp.TurnID] = true
				}
			}
		}
	}
}

func reportOpenCodeDiff(ctx context.Context, t *Transport, job *ClaimedSession) {
	liveFiles, livePatches := liveDiff(job.WT)
	if err := t.diffResultContext(ctx, job.SessionID, DiffResultRequest{
		ChangedFiles: liveFiles, ChangedDiff: livePatches,
		WorktreeDirty: worktreeIsDirty(job.WT), BranchMerged: branchMergedInto(job.WT),
		WorktreeBranch: currentBranch(job.WT),
	}); err != nil && ctx.Err() == nil {
		logln("diff-result failed for", job.SessionID+":", err)
	}
}

func prepareOpenCodeTurn(ctx context.Context, t *Transport, job *ClaimedSession, resp *RunInboxResponse, pendingShellCtx []string) openCodePreparedTurn {
	prompt := resp.Content
	if len(pendingShellCtx) > 0 {
		prompt = strings.Join(pendingShellCtx, "\n") + "\n\n" + prompt
	}
	prepared := openCodePreparedTurn{Prompt: prompt}
	for _, att := range resp.Attachments {
		data, err := t.fetchAttachment(ctx, job.SessionID, att.ID)
		if err != nil {
			logln("attachment fetch failed for", job.SessionID, att.ID+":", err)
			continue
		}
		path, err := writeUpload(job.SessionID, att.FileName, att.ID, data)
		if err != nil {
			logln("attachment write failed for", job.SessionID, att.ID+":", err)
			continue
		}
		prepared.FilePaths = append(prepared.FilePaths, path)
		prepared.AttachmentRefs = append(prepared.AttachmentRefs, map[string]interface{}{"id": att.ID, "mime": att.MimeType, "name": att.FileName})
	}
	if strings.TrimSpace(prepared.Prompt) == "" && len(prepared.FilePaths) > 0 {
		prepared.Prompt = "Please review the attached file(s)."
	}
	return prepared
}

func openCodeCommandArgs(job *ClaimedSession, execDir string, filePaths []string, agentName string) []string {
	// --pure prevents repository plugins from executing outside Orbit's tool policy.
	args := []string{"--pure", "run", "--format=json", "--thinking", "--agent=" + agentName, "--dir=" + execDir}
	if job.RuntimeSessionID != "" {
		args = append(args, "--session="+job.RuntimeSessionID)
	} else if strings.TrimSpace(job.Title) != "" {
		args = append(args, "--title="+job.Title)
	}
	if strings.TrimSpace(job.Agent.Model) != "" {
		args = append(args, "--model="+job.Agent.Model)
	}
	if strings.TrimSpace(job.Agent.Effort) != "" {
		args = append(args, "--variant="+job.Agent.Effort)
	}
	permissionMode := strings.TrimSpace(job.Agent.PermissionMode)
	if permissionMode == "auto" || permissionMode == "bypassPermissions" {
		// This compatibility spelling works in both current OpenCode and releases
		// predating the public --auto alias. AcceptEdits remains narrowly expressed
		// in the agent permissions; only Auto/Bypass approve every asked permission.
		args = append(args, "--dangerously-skip-permissions")
	}
	for _, path := range filePaths {
		args = append(args, "--file="+path)
	}
	return args
}

func runOpenCodeTurn(ctx context.Context, job *ClaimedSession, execDir, scratchDir, prompt string, filePaths []string, emit emitFn) openCodeTurnResult {
	result := openCodeTurnResult{Status: stSucceeded, Subtype: "success", RuntimeSessionID: job.RuntimeSessionID}
	if ctx.Err() != nil {
		return cancelledOpenCodeTurn(ctx, result.RuntimeSessionID)
	}
	var escaping []string
	if openCodeGuardedMode(job.Agent.PermissionMode) {
		var err error
		if escaping, err = openCodeEscapingWorkspacePaths(execDir); err != nil {
			message := "refusing unsafe OpenCode workspace: " + err.Error()
			result.Status, result.Subtype, result.Error, result.Result = stFailed, "config_error", message, message
			emit(evError, map[string]interface{}{"message": message})
			return result
		}
		if len(escaping) > 0 {
			// Denied below in the agent's permission map rather than failing the turn: a
			// checkout may legitimately link a vendor dir (Orbit's own worktrees symlink
			// node_modules), and refusing outright would make those sessions unusable.
			emit(evSystem, map[string]interface{}{
				"subtype": "workspace_symlinks_denied",
				"paths":   escaping,
			})
		}
	}
	agentName, err := newOpenCodeAgentName()
	if err != nil {
		message := "create isolated OpenCode agent name: " + err.Error()
		result.Status, result.Subtype, result.Error, result.Result = stFailed, "config_error", message, message
		emit(evError, map[string]interface{}{"message": message})
		return result
	}
	configContent, err := openCodeConfigContent(job, scratchDir, agentName, escaping)
	if err != nil {
		result.Status, result.Subtype, result.Error, result.Result = stFailed, "config_error", err.Error(), err.Error()
		emit(evError, map[string]interface{}{"message": err.Error()})
		return result
	}
	cmd := exec.CommandContext(ctx, providerOpenCode, openCodeCommandArgs(job, execDir, filePaths, agentName)...)
	cmd.Dir = execDir
	cmd.Env = replaceEnv(envWithAgent(job.Agent.Env), map[string]string{
		"PWD":                         execDir,
		"OPENCODE_CONFIG_CONTENT":     configContent,
		"OPENCODE_CLIENT":             "orbit",
		"OPENCODE_DISABLE_AUTOUPDATE": "1",
		// Orbit conversations must never be published through OpenCode's sharing
		// service. The disable flag also stops an already-shared resumed session
		// from syncing new messages; the auto flag is cleared for older releases.
		"OPENCODE_DISABLE_SHARE": "1",
		"OPENCODE_AUTO_SHARE":    "0",
		// Project MCP servers start before OpenCode asks agent permissions. Disable
		// all repository config in guarded modes so an untrusted checkout cannot
		// execute a local MCP process outside Orbit's policy. Inline, agent-owned
		// config above remains enabled and supplies Orbit's authorized MCP servers.
		"OPENCODE_DISABLE_PROJECT_CONFIG": openCodeProjectConfigFlag(job.Agent.PermissionMode),
		"ORBIT_SESSION_ID":                publicID(job.SessionID),
		"ORBIT_AGENT_ID":                  publicID(job.AgentID),
		"ORBIT_TASK_ID":                   publicID(job.TaskID),
		"ORBIT_ALLOW_ORCHESTRATION":       orchestrationEnv(job.AllowOrchestration),
		envOrchestrationToken:             job.OrchestrationToken,
		envMCPPermissionPrompt:            "0",
	})
	cmd.Stdin = strings.NewReader(prompt)
	configureSessionProcessTree(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return failedOpenCodeSpawn("stdout", err, emit)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return failedOpenCodeSpawn("stderr", err, emit)
	}
	if err := cmd.Start(); err != nil {
		if ctx.Err() != nil {
			return cancelledOpenCodeTurn(ctx, result.RuntimeSessionID)
		}
		return failedOpenCodeSpawn("process", err, emit)
	}

	var stderrWG sync.WaitGroup
	stderrWG.Add(1)
	go func() {
		defer stderrWG.Done()
		scanner := bufio.NewScanner(stderr)
		scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for scanner.Scan() {
			emit(evSystem, map[string]interface{}{"stderr": stripANSI(scanner.Text()) + "\n"})
		}
	}()

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
	// Occupancy accumulates over the turn's steps but only ships with turn_end; report it as it
	// moves so a long turn's gauge isn't stuck at its pre-turn reading.
	var ctxPing contextPinger
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var event map[string]interface{}
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			logln("opencode emitted invalid JSON:", firstLine(line))
			continue
		}
		handleOpenCodeEvent(event, emit, &result)
		ctxPing.ping(emit, result.ContextTokens, job)
	}
	waitErr := waitSessionProcessTree(cmd)
	stderrWG.Wait()
	if ctx.Err() != nil {
		applyOpenCodeCancellation(ctx, &result)
	} else if scanner.Err() != nil && result.Status == stSucceeded {
		result.Status, result.Subtype, result.Error = stFailed, "stream_error", scanner.Err().Error()
		emit(evError, map[string]interface{}{"message": result.Error})
	} else if waitErr != nil && result.Status == stSucceeded {
		result.Status, result.Subtype, result.Error = stFailed, "process_error", waitErr.Error()
		emit(evError, map[string]interface{}{"message": result.Error})
	}
	if result.Result == "" {
		result.Result = result.Error
	}
	return result
}

func cancelledOpenCodeTurn(ctx context.Context, runtimeSessionID string) openCodeTurnResult {
	result := openCodeTurnResult{RuntimeSessionID: runtimeSessionID}
	applyOpenCodeCancellation(ctx, &result)
	return result
}

func applyOpenCodeCancellation(ctx context.Context, result *openCodeTurnResult) {
	if errors.Is(context.Cause(ctx), errOpenCodeInterrupted) {
		result.Status = stInterrupted
		result.Subtype = "interrupted"
		return
	}
	result.Status = stCancelled
	result.Subtype = "cancelled"
}

func failedOpenCodeSpawn(stage string, err error, emit emitFn) openCodeTurnResult {
	message := "failed to start OpenCode " + stage + ": " + err.Error()
	emit(evError, map[string]interface{}{"message": message})
	return openCodeTurnResult{Status: stFailed, Subtype: "spawn_failed", Error: message, Result: message}
}

func handleOpenCodeEvent(event map[string]interface{}, emit emitFn, result *openCodeTurnResult) {
	sessionID := firstString(event, "sessionID", "sessionId")
	if sessionID != "" && result.RuntimeSessionID == "" {
		result.RuntimeSessionID = sessionID
		emit(evSystem, map[string]interface{}{"subtype": "init", "sessionId": sessionID, "provider": providerOpenCode})
	}
	eventType := firstString(event, "type")
	part := mapValue(event["part"])
	switch eventType {
	case "step_start":
		// Once this turn-scoped marker is flushed and persisted, the server can
		// recognize a started turn even though OpenCode reports tool_use only after
		// the tool finishes. A crash before the next event flush remains replayable.
		emit(evSystem, map[string]interface{}{"subtype": "step_start", "sessionId": sessionID})
	case "text":
		if text := firstString(part, "text"); text != "" {
			emit(evAssistant, map[string]interface{}{"text": text})
			result.Result = text
		}
	case "reasoning":
		if text := firstString(part, "text"); text != "" {
			emit(evThinking, map[string]interface{}{"text": text})
		}
	case "tool_use":
		handleOpenCodeTool(part, emit)
	case "step_finish":
		result.NumTurns++
		result.CostUSD += toFloat(firstPresent(part, "cost"))
		if usage, contextTokens := openCodeUsage(part["tokens"]); usage != nil {
			if result.Usage == nil {
				result.Usage = &TokenUsage{}
			}
			result.Usage.InputTokens += usage.InputTokens
			result.Usage.OutputTokens += usage.OutputTokens
			result.Usage.CacheCreationInputTokens += usage.CacheCreationInputTokens
			result.Usage.CacheReadInputTokens += usage.CacheReadInputTokens
			result.ContextTokens = contextTokens
		}
	case "error":
		message, auth := openCodeError(event["error"])
		if auth && !isAuthError(message) {
			message = "Failed to authenticate: " + message
		} else {
			message = asAuthError(message)
		}
		result.Status, result.Subtype, result.Error = stFailed, "error", message
		if message != "" {
			emit(evError, map[string]interface{}{"message": message})
		}
	}
}

func handleOpenCodeTool(part map[string]interface{}, emit emitFn) {
	if part == nil {
		return
	}
	state := mapValue(part["state"])
	if state == nil {
		return
	}
	id := firstString(part, "callID", "id")
	rawName := firstString(part, "tool")
	name := canonicalOpenCodeToolName(rawName)
	input := normalizeOpenCodeToolInput(rawName, firstPresent(state, "input"))
	emit(evToolUse, map[string]interface{}{"id": fallbackID(id, "opencode-tool"), "name": name, "input": input})
	status := strings.ToLower(firstString(state, "status"))
	content := firstPresent(state, "output", "error")
	emit(evToolResult, map[string]interface{}{"toolUseId": fallbackID(id, "opencode-tool"), "content": content, "isError": status == "error" || status == "failed"})
}

func canonicalOpenCodeToolName(name string) string {
	if strings.HasPrefix(name, "orbit_") {
		return "mcp__orbit__" + strings.TrimPrefix(name, "orbit_")
	}
	switch strings.ToLower(name) {
	case "bash":
		return "Bash"
	case "read":
		return "Read"
	case "write":
		return "Write"
	case "edit":
		return "Edit"
	case "multiedit", "multi_edit":
		return "MultiEdit"
	case "apply_patch", "applypatch", "patch":
		return "ApplyPatch"
	case "glob":
		return "Glob"
	case "grep":
		return "Grep"
	case "todowrite", "todo_write":
		return "TodoWrite"
	case "todoread", "todo_read":
		return "TodoRead"
	case "webfetch", "web_fetch":
		return "WebFetch"
	case "websearch", "web_search":
		return "WebSearch"
	case "task":
		return "Task"
	case "agent":
		return "Agent"
	case "question", "askuserquestion", "ask_user_question":
		return "AskUserQuestion"
	case "toolsearch", "tool_search":
		return "ToolSearch"
	case "exitplanmode", "exit_plan_mode":
		return "ExitPlanMode"
	case "skill":
		return "Skill"
	case "lsp":
		return "LSP"
	case "list":
		return "List"
	}
	return name
}

func normalizeOpenCodeToolInput(name string, value interface{}) interface{} {
	if strings.HasPrefix(name, "orbit_") {
		return value
	}
	switch strings.ToLower(name) {
	case "bash", "read", "write", "edit", "multiedit", "multi_edit", "apply_patch", "applypatch", "patch",
		"glob", "grep", "todowrite", "todo_write", "todoread", "todo_read", "webfetch", "web_fetch",
		"websearch", "web_search", "task", "agent", "question", "askuserquestion", "ask_user_question",
		"toolsearch", "tool_search", "exitplanmode", "exit_plan_mode", "skill", "lsp", "list":
		value = normalizeOpenCodeInputKeys(value)
	default:
		return value
	}
	if strings.EqualFold(name, "grep") {
		if input := mapValue(value); input != nil && input["glob"] == nil && input["include"] != nil {
			input["glob"] = input["include"]
			delete(input, "include")
		}
	}
	return value
}

func normalizeOpenCodeInputKeys(value interface{}) interface{} {
	switch current := value.(type) {
	case map[string]interface{}:
		out := make(map[string]interface{}, len(current))
		for key, item := range current {
			out[key] = normalizeOpenCodeInputKeys(item)
		}
		for old, canonical := range map[string]string{
			"filePath":             "file_path",
			"oldString":            "old_string",
			"newString":            "new_string",
			"replaceAll":           "replace_all",
			"patchText":            "patch_text",
			"numResults":           "num_results",
			"contextMaxCharacters": "context_max_characters",
			"subagentType":         "subagent_type",
			"taskId":               "task_id",
		} {
			if item, ok := current[old]; ok {
				if _, exists := current[canonical]; !exists {
					out[canonical] = normalizeOpenCodeInputKeys(item)
				}
				delete(out, old)
			}
		}
		return out
	case []interface{}:
		out := make([]interface{}, len(current))
		for i, item := range current {
			out[i] = normalizeOpenCodeInputKeys(item)
		}
		return out
	default:
		return value
	}
}

func openCodeUsage(v interface{}) (*TokenUsage, int) {
	tokens := mapValue(v)
	if tokens == nil {
		return nil, 0
	}
	cache := mapValue(tokens["cache"])
	input := toInt(tokens["input"])
	output := toInt(tokens["output"])
	reasoning := toInt(tokens["reasoning"])
	read, write := 0, 0
	if cache != nil {
		read, write = toInt(cache["read"]), toInt(cache["write"])
	}
	// Current OpenCode releases report visible output and reasoning separately.
	// Older releases included reasoning in output; a present total lets us retain
	// compatibility without double-counting their payloads.
	reportedTotal := toInt(tokens["total"])
	outputTokens := output + reasoning
	if reportedTotal > 0 && reportedTotal <= input+output+read+write {
		outputTokens = output
	}
	usage := &TokenUsage{InputTokens: input, OutputTokens: outputTokens, CacheCreationInputTokens: write, CacheReadInputTokens: read}
	contextTokens := reportedTotal
	if contextTokens <= 0 {
		contextTokens = input + outputTokens + read + write
	}
	return usage, contextTokens
}

func openCodeError(v interface{}) (message string, providerAuth bool) {
	errValue := mapValue(v)
	if errValue == nil {
		return asString(v), false
	}
	name := firstString(errValue, "name", "type")
	data := mapValue(errValue["data"])
	message = firstString(data, "message", "responseBody")
	if message == "" {
		message = firstString(errValue, "message", "error")
	}
	if provider := firstString(data, "providerID", "providerId"); provider != "" {
		message = "[" + provider + "] " + message
	}
	if message == "" {
		if raw, err := json.Marshal(errValue); err == nil {
			message = string(raw)
		}
	}
	return message, name == "ProviderAuthError"
}

func newOpenCodeAgentName() (string, error) {
	var entropy [16]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return "", err
	}
	return "orbit" + hex.EncodeToString(entropy[:]), nil
}

func openCodeConfigContent(job *ClaimedSession, scratchDir, agentName string, escapingPaths []string) (string, error) {
	base := strings.TrimSpace(job.Agent.Env["OPENCODE_CONFIG_CONTENT"])
	if base == "" {
		base = strings.TrimSpace(os.Getenv("OPENCODE_CONFIG_CONTENT"))
	}
	config := map[string]interface{}{}
	if base != "" {
		if err := json.Unmarshal([]byte(base), &config); err != nil {
			return "", fmt.Errorf("invalid OPENCODE_CONFIG_CONTENT: %w", err)
		}
		if config == nil {
			return "", fmt.Errorf("invalid OPENCODE_CONFIG_CONTENT: expected a JSON object")
		}
	}
	// An Orbit runtime must not inherit `share:auto` from the runner account or
	// agent environment. OPENCODE_DISABLE_SHARE is also forced on the child, but
	// keeping the resolved config disabled protects older OpenCode releases.
	config["share"] = "disabled"
	if openCodeGuardedMode(job.Agent.PermissionMode) {
		// OpenCode's read/edit implementations can start LSP servers and formatters
		// without a separate tool permission. Both may resolve executables from the
		// checkout, so disable them at the config layer in guarded modes.
		config["lsp"] = false
		config["formatter"] = false
	}

	executable := orbitCLIExecutable()
	agents := ensureObject(config, "agent")
	orbitAgent := ensureObject(agents, agentName)
	orbitAgent["description"] = "Orbit runtime agent"
	orbitAgent["mode"] = "primary"
	// An OpenCode agent.prompt replaces the provider-specific system prompt. Set it
	// only for Orbit's explicit replacement prompt; append instructions live in the
	// top-level instructions list so the provider default remains intact otherwise.
	if strings.TrimSpace(job.Agent.SystemPrompt) != "" {
		systemPath := filepath.Join(scratchDir, "opencode-system-prompt.txt")
		if err := os.WriteFile(systemPath, []byte(job.Agent.SystemPrompt), 0o600); err != nil {
			return "", fmt.Errorf("write OpenCode system prompt: %w", err)
		}
		orbitAgent["prompt"] = "{file:" + systemPath + "}"
	} else {
		delete(orbitAgent, "prompt")
	}
	appendPrompt := strings.TrimSpace(strings.Join(nonEmptyStrings(
		job.Agent.AppendSystemPrompt,
		openCodeOrbitCLIInstructions(executable),
	), "\n\n"))
	if appendPrompt != "" {
		instructionsPath := filepath.Join(scratchDir, "opencode-instructions.txt")
		if err := os.WriteFile(instructionsPath, []byte(appendPrompt), 0o600); err != nil {
			return "", fmt.Errorf("write OpenCode instructions: %w", err)
		}
		config["instructions"] = appendConfigString(config["instructions"], instructionsPath)
	}
	if job.Agent.MaxTurns != nil && *job.Agent.MaxTurns > 0 {
		orbitAgent["steps"] = *job.Agent.MaxTurns
	} else {
		delete(orbitAgent, "steps")
	}
	// Orbit owns the `orbit` agent's permission policy. Do not inherit an exact
	// allow from OPENCODE_CONFIG_CONTENT that could outrank dontAsk's wildcard deny.
	permission := map[string]interface{}{}
	orbitAgent["permission"] = permission
	permission["todowrite"] = "deny"
	applyOpenCodePermissions(permission, job.Agent, escapingPaths)

	mcp := ensureObject(config, "mcp")
	for name, raw := range job.Agent.McpConfig {
		if converted := openCodeMCPServer(raw); converted != nil {
			mcp[name] = converted
		}
	}
	if executable != "" {
		mcp["orbit"] = map[string]interface{}{
			"type":    "local",
			"command": []string{executable, "mcp"},
			"enabled": true,
			"timeout": 30000,
			"environment": map[string]string{
				"ORBIT_SESSION_ID":          publicID(job.SessionID),
				"ORBIT_AGENT_ID":            publicID(job.AgentID),
				"ORBIT_TASK_ID":             publicID(job.TaskID),
				"ORBIT_ALLOW_ORCHESTRATION": orchestrationEnv(job.AllowOrchestration),
				envOrchestrationToken:       job.OrchestrationToken,
				envMCPPermissionPrompt:      "0",
			},
		}
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		return "", fmt.Errorf("encode OpenCode config: %w", err)
	}
	return string(encoded), nil
}

func nonEmptyStrings(values ...string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			out = append(out, value)
		}
	}
	return out
}

func openCodeOrbitCLIInstructions(executable string) string {
	return strings.Replace(orbitCLIInstructions(executable), "mcp__orbit__*", "orbit_*", 1)
}

func appendConfigString(value interface{}, addition string) []string {
	var result []string
	switch values := value.(type) {
	case []string:
		result = append(result, values...)
	case []interface{}:
		for _, item := range values {
			if text := asString(item); text != "" {
				result = append(result, text)
			}
		}
	}
	for _, existing := range result {
		if existing == addition {
			return result
		}
	}
	return append(result, addition)
}

func ensureObject(parent map[string]interface{}, key string) map[string]interface{} {
	if value := mapValue(parent[key]); value != nil {
		return value
	}
	value := map[string]interface{}{}
	parent[key] = value
	return value
}

func applyOpenCodePermissions(permission map[string]interface{}, agent AgentExecConfig, escapingPaths []string) {
	mode := strings.TrimSpace(agent.PermissionMode)
	guarded := openCodeGuardedMode(mode)
	if guarded {
		decision := "ask"
		if mode == "dontAsk" {
			decision = "deny"
		}
		// OpenCode is permissive by default. Orbit's Don't Ask means an
		// unapproved tool is denied; the other guarded modes ask (which the
		// non-interactive runner rejects). Repository inspection remains usable in
		// every mode so the coding agent can understand the checkout safely.
		permission["*"] = decision
		// A bare read=allow would be appended after OpenCode's built-in sensitive-file
		// rules and reopen .env files. Re-state that path policy inside Orbit's rule.
		permission["read"] = map[string]interface{}{
			"*":             "allow",
			"*.env":         decision,
			"*.env.*":       decision,
			"*.env.example": "allow",
			// OpenCode exposes MCP resources through the read permission. Keep
			// inherited/global servers behind the guarded default rather than
			// letting read:* bypass MCP tool policy.
			"mcp:*": decision,
		}
		// grep can target a specific hidden file and return its contents without
		// going through read permission, so it is not part of this safe baseline.
		for _, name := range []string{"glob", "list", "todoread", "skill"} {
			permission[name] = "allow"
		}
		permission["lsp"] = "deny"
		// OpenCode's built-in subagents have their own, broader permission sets.
		// Letting a guarded primary agent call Task would therefore bypass Orbit's
		// shell/edit/read policy instead of inheriting it.
		permission["task"] = "deny"
		if mode == "acceptEdits" {
			// Accept file edits automatically; everything else keeps the guarded
			// baseline above.
			permission["edit"] = "allow"
		}
	} else {
		permission["*"] = "allow"
	}

	// Explicit allow/deny lists refine the mode baseline. Deny is applied last so
	// an administrator's block always wins over an allow for the same tool.
	for _, tool := range agent.AllowedTools {
		if name := openCodePermissionTool(tool, false); name != "" {
			// Guarded modes already allow ordinary reads. Do not let a legacy/common
			// AllowedTools:[Read] collapse the path map and reopen .env files.
			if name == "read" && permission["read"] != nil {
				continue
			}
			if name == "task" && guarded {
				continue
			}
			permission[name] = "allow"
		}
		if guarded {
			if pattern := openCodeMCPResourceServerPattern(tool); pattern != "" {
				mapValue(permission["read"])[pattern] = "allow"
			}
		}
	}
	for _, tool := range agent.DisallowedTools {
		if name := openCodePermissionTool(tool, true); name != "" {
			permission[name] = "deny"
		}
		if guarded {
			if pattern := openCodeMCPResourceServerPattern(tool); pattern != "" {
				mapValue(permission["read"])[pattern] = "deny"
			}
		}
	}
	if mode == "plan" {
		for _, name := range []string{"edit", "write", "patch"} {
			permission[name] = "deny"
		}
		// Non-interactive OpenCode rejects an "ask" decision, preserving plan mode
		// even for shell commands that could otherwise mutate the checkout.
		permission["bash"] = "ask"
	}

	// A workspace symlink whose target resolves outside the checkout: OpenCode's lexical
	// boundary check passes but the kernel walks out of the workspace. Deny those paths
	// explicitly, last, so neither the mode baseline nor an AllowedTools entry reopens them.
	// `edit` collapses Edit/Write/ApplyPatch, so it has to become a map wherever a plain
	// decision would otherwise allow the whole tool (acceptEdits, and the ungated modes).
	if guarded && len(escapingPaths) > 0 {
		read := mapValue(permission["read"])
		edit, ok := permission["edit"].(map[string]interface{})
		if !ok {
			edit = map[string]interface{}{}
			if current := asString(permission["edit"]); current != "" {
				edit["*"] = current
			}
			permission["edit"] = edit
		}
		for _, rel := range escapingPaths {
			for _, pattern := range []string{rel, rel + "/**"} {
				if read != nil {
					read[pattern] = "deny"
				}
				edit[pattern] = "deny"
			}
		}
	}
}

func openCodeGuardedMode(mode string) bool {
	mode = strings.TrimSpace(mode)
	return mode != "auto" && mode != "bypassPermissions"
}

func openCodeProjectConfigFlag(mode string) string {
	if openCodeGuardedMode(mode) {
		return "1"
	}
	return "0"
}

// openCodeEscapingWorkspacePaths closes a gap in OpenCode's lexical external-directory check:
// its read/edit tools follow symlinks after permission evaluation, so a link whose resolved
// target sits outside the checkout passes that check and then walks out of the workspace.
//
// It reports the workspace-relative paths to deny rather than failing the session: a checkout may
// legitimately link a vendor directory to a shared location (Orbit's own worktrees symlink
// node_modules back to the main repo), and refusing those outright would make every guarded
// OpenCode session on such a checkout unusable. A dangling link is reported too — a later edit
// could otherwise materialize its target outside the checkout.
//
// `.git` is skipped: it holds no agent-authored content, is never reachable through a tool the
// permission map gates by path, and dominates the walk cost on a large repository. Note that
// WalkDir does not follow symlinks, so a symlinked vendor tree costs a single entry here.
func openCodeEscapingWorkspacePaths(root string) ([]string, error) {
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve checkout: %w", err)
	}
	resolvedRoot, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return nil, fmt.Errorf("resolve checkout: %w", err)
	}
	resolvedRoot = filepath.Clean(resolvedRoot)
	var escaping []string
	walkErr := filepath.WalkDir(resolvedRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return fmt.Errorf("inspect checkout: %w", walkErr)
		}
		if entry.IsDir() && entry.Name() == ".git" && path != resolvedRoot {
			return fs.SkipDir
		}
		if entry.Type()&os.ModeSymlink == 0 {
			return nil
		}
		rel, relErr := filepath.Rel(resolvedRoot, path)
		if relErr != nil {
			rel = entry.Name()
		}
		rel = filepath.ToSlash(rel)
		target, targetErr := filepath.EvalSymlinks(path)
		if targetErr != nil {
			// Dangling: nothing to compare against, so treat it as escaping.
			escaping = append(escaping, rel)
			return nil
		}
		target = filepath.Clean(target)
		targetRel, targetRelErr := filepath.Rel(resolvedRoot, target)
		if targetRelErr != nil || filepath.IsAbs(targetRel) || targetRel == ".." || strings.HasPrefix(targetRel, ".."+string(os.PathSeparator)) {
			escaping = append(escaping, rel)
			return nil
		}
		// A directory link placed deeper than its target can combine with `..` segments so
		// OpenCode's lexical boundary check sees an in-workspace path while the kernel walks
		// above the checkout after resolving the link.
		info, statErr := os.Stat(path)
		if statErr != nil {
			escaping = append(escaping, rel)
			return nil
		}
		if info.IsDir() && openCodePathDepth(filepath.ToSlash(targetRel)) < openCodePathDepth(rel) {
			escaping = append(escaping, rel)
		}
		return nil
	})
	if walkErr != nil {
		return nil, walkErr
	}
	sort.Strings(escaping)
	return escaping, nil
}

func openCodePathDepth(path string) int {
	if path == "." || path == "" {
		return 0
	}
	depth := 0
	for _, part := range strings.Split(path, "/") {
		if part != "" && part != "." {
			depth++
		}
	}
	return depth
}

func openCodePermissionTool(tool string, deny bool) string {
	tool = strings.TrimSpace(tool)
	if tool == "" {
		return ""
	}
	if i := strings.IndexByte(tool, '('); i >= 0 {
		if !deny {
			return "" // do not broaden a scoped allow rule to the whole tool
		}
		tool = tool[:i]
	}
	tool = strings.TrimSpace(tool)
	if server, name, ok := openCodeMCPToolParts(tool); ok {
		return sanitizeOpenCodeMCPPermissionPart(server, false) + "_" + sanitizeOpenCodeMCPPermissionPart(name, true)
	}
	switch strings.ToLower(tool) {
	case "bash":
		return "bash"
	case "read":
		return "read"
	// OpenCode's Edit, Write, and ApplyPatch tools all ask the single `edit`
	// permission. Collapse legacy/runtime aliases so explicit denies cannot miss
	// a mutation path (and explicit allows match what OpenCode actually checks).
	case "edit", "multiedit", "write", "patch", "applypatch", "apply_patch":
		return "edit"
	case "webfetch":
		return "webfetch"
	case "websearch":
		return "websearch"
	}
	return strings.ToLower(tool)
}

func openCodeMCPToolParts(tool string) (server, name string, ok bool) {
	if !strings.HasPrefix(tool, "mcp__") {
		return "", "", false
	}
	parts := strings.SplitN(strings.TrimPrefix(tool, "mcp__"), "__", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func sanitizeOpenCodeMCPPermissionPart(value string, preserveWildcard bool) string {
	var out strings.Builder
	for _, char := range value {
		if char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '_' || char == '-' || preserveWildcard && char == '*' {
			out.WriteRune(char)
		} else {
			out.WriteByte('_')
		}
	}
	return out.String()
}

func openCodeMCPResourceServerPattern(tool string) string {
	server, name, ok := openCodeMCPToolParts(strings.TrimSpace(tool))
	if !ok || name != "*" || strings.Contains(server, "*") {
		return ""
	}
	return "mcp:" + server + ":*"
}

func openCodeMCPServer(raw interface{}) map[string]interface{} {
	server := mapValue(raw)
	if server == nil {
		return nil
	}
	out := map[string]interface{}{}
	for key, value := range server {
		out[key] = value
	}
	kind := strings.ToLower(strings.TrimSpace(firstString(server, "type")))
	if kind == "" && len(openCodeMCPCommand(server["command"])) > 0 {
		kind = "stdio"
	}
	if kind == "" && firstString(server, "url") != "" {
		kind = "http"
	}
	switch kind {
	case "local", "stdio":
		argv := openCodeMCPCommand(server["command"])
		for _, arg := range openCodeMCPCommand(server["args"]) {
			argv = append(argv, arg)
		}
		if len(argv) == 0 {
			return nil
		}
		out["type"], out["command"] = "local", argv
		if env, ok := out["env"]; ok {
			out["environment"] = env
			delete(out, "env")
		}
		delete(out, "args")
		return out
	case "remote", "http", "sse":
		if firstString(server, "url") == "" {
			return nil
		}
		out["type"] = "remote"
		return out
	default:
		return nil
	}
}

func openCodeMCPCommand(value interface{}) []string {
	switch parts := value.(type) {
	case string:
		if strings.TrimSpace(parts) != "" {
			return []string{parts}
		}
	case []string:
		return append([]string(nil), parts...)
	case []interface{}:
		out := make([]string, 0, len(parts))
		for _, part := range parts {
			if text := asString(part); text != "" {
				out = append(out, text)
			}
		}
		return out
	}
	return nil
}

func replaceEnv(env []string, replacements map[string]string) []string {
	for key, value := range replacements {
		prefix := key + "="
		filtered := env[:0]
		for _, entry := range env {
			if !strings.HasPrefix(entry, prefix) {
				filtered = append(filtered, entry)
			}
		}
		env = append(filtered, prefix+value)
	}
	return env
}
