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
	"strings"
	"sync"
	"time"
)

type codexRPCError struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
}

type codexRPCMessage struct {
	ID     interface{}     `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *codexRPCError  `json:"error,omitempty"`
}

type codexAppServer struct {
	cmd    *exec.Cmd
	cancel context.CancelFunc
	stdin  io.WriteCloser

	writeMu sync.Mutex
	mu      sync.Mutex
	nextID  int64
	pending map[string]chan codexRPCMessage

	notifications chan codexRPCMessage
	done          chan struct{}
	doneOnce      sync.Once
}

type codexAppActiveTurn struct {
	orbitTurnID        string
	codexTurnID        string
	startSent          bool
	interruptRequested bool
	interruptSent      bool
	result             codexTurnResult
	fullText           strings.Builder
	deltaText          strings.Builder
	thinkText          strings.Builder
}

func runCodexAppServerSessionProcess(ctx context.Context, shutdownCtx context.Context, t *Transport, job *ClaimedSession, execDir, scratchDir string, emit emitFn, setTurn func(string), _ bool, bg *bgTailer, onRateLimits func(map[string]interface{})) (string, bool, bool) {
	setTurn("")
	upDir := uploadsDir(job.SessionID)
	_ = os.MkdirAll(upDir, 0o755)

	app, err := startCodexAppServer(ctx, job, execDir, scratchDir, emit)
	if err != nil {
		emit(evError, map[string]interface{}{"message": "failed to spawn codex app-server: " + err.Error()})
		return stFailed, true, false
	}
	defer app.close()

	if err := app.initialize(ctx); err != nil {
		emit(evError, map[string]interface{}{"message": "failed to initialize codex app-server: " + err.Error()})
		return stFailed, true, false
	}
	threadID, err := app.startOrResumeThread(ctx, job, execDir, upDir)
	if err != nil {
		emit(evError, map[string]interface{}{"message": "failed to start codex thread: " + err.Error()})
		return stFailed, true, false
	}
	job.RuntimeSessionID = threadID
	writeSessionMeta(scratchDir, job, execDir)
	emit(evSystem, map[string]interface{}{"subtype": "init", "sessionId": threadID, "provider": providerCodex, "runtime": "app-server"})

	var activeMu sync.Mutex
	var active *codexAppActiveTurn
	inflight := map[string]bool{}
	var inflightMu sync.Mutex

	clearInflight := func(turnID string) {
		if turnID == "" {
			return
		}
		inflightMu.Lock()
		delete(inflight, turnID)
		inflightMu.Unlock()
	}

	finalizeActive := func(result codexTurnResult) {
		activeMu.Lock()
		if active == nil {
			activeMu.Unlock()
			return
		}
		a := active
		if result.Status == "" {
			result.Status = a.result.Status
		}
		if result.Subtype == "" {
			result.Subtype = a.result.Subtype
		}
		if result.Result == "" {
			result.Result = a.result.Result
		}
		if result.Result == "" {
			result.Result = strings.TrimSpace(a.fullText.String())
		}
		if result.Result == "" {
			result.Result = strings.TrimSpace(a.deltaText.String())
		}
		if result.Error == "" {
			result.Error = a.result.Error
		}
		if result.Usage == nil {
			result.Usage = a.result.Usage
		}
		orbitTurnID := a.orbitTurnID
		active = nil
		activeMu.Unlock()

		if result.Status == "" {
			result.Status = stSucceeded
		}
		if result.Subtype == "" {
			result.Subtype = "completed"
		}
		if result.Status == stFailed && result.Result == "" {
			result.Result = result.Error
		}
		emit(evTurnEnd, codexTurnEndPayload(result, 1, 0))
		liveFiles, livePatches := liveDiff(job.WT)
		if err := t.turnComplete(job.SessionID, TurnCompleteRequest{
			TurnID:           orbitTurnID,
			Status:           result.Status,
			Result:           result.Result,
			Subtype:          result.Subtype,
			NumTurns:         1,
			CostUsd:          0,
			Usage:            result.Usage,
			RuntimeSessionID: currentRuntimeSessionID(job),
			IsolationStatus:  job.IsolationStatus,
			ChangedFiles:     liveFiles,
			ChangedDiff:      livePatches,
			WorktreeDirty:    worktreeIsDirty(job.WT),
			BranchMerged:     branchMergedInto(job.WT),
		}); err != nil {
			logln("turn-complete failed for", job.SessionID+":", err)
		}
		clearInflight(orbitTurnID)
		setTurn("")
	}

	sendInterrupt := func(codexTurnID string) {
		if codexTurnID == "" {
			return
		}
		go func(turnID string) {
			reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			if _, err := app.request(reqCtx, "turn/interrupt", map[string]interface{}{"threadId": threadID, "turnId": turnID}); err != nil {
				logln("codex turn/interrupt failed for", job.SessionID+":", err)
			}
		}(codexTurnID)
	}

	requestActiveInterrupt := func(finalizeBeforeStart bool) {
		codexTurnID, beforeStart := requestCodexAppInterrupt(&activeMu, &active)
		if beforeStart && finalizeBeforeStart {
			finalizeActive(codexTurnResult{Status: stInterrupted, Subtype: "interrupted"})
			return
		}
		sendInterrupt(codexTurnID)
	}

	recordCodexTurnID := func(orbitTurnID, codexTurnID string) {
		sendInterrupt(markCodexAppTurnStarted(&activeMu, &active, orbitTurnID, codexTurnID))
	}

	notificationsDone := make(chan struct{})
	go func() {
		defer close(notificationsDone)
		for {
			select {
			case <-ctx.Done():
				return
			case <-app.done:
				return
			case msg := <-app.notifications:
				handleCodexAppNotification(msg, emit, &activeMu, &active, finalizeActive, func(codexTurnID string) {
					recordCodexTurnID("", codexTurnID)
				}, func(text string) string {
					return rewriteLocalMarkdownImages(ctx, t, job.SessionID, text, []string{execDir, upDir})
				}, onRateLimits)
			}
		}
	}()

	pollCtx, pollCancel := context.WithCancel(ctx)
	defer pollCancel()
	go func() {
		select {
		case <-app.done:
			pollCancel()
		case <-shutdownCtx.Done():
			pollCancel()
		case <-ctx.Done():
		}
	}()

	startTurn := func(resp *RunInboxResponse, pendingShellCtx []string) {
		activeMu.Lock()
		if active != nil {
			activeMu.Unlock()
			emit(evError, map[string]interface{}{"message": "codex app-server already has an active turn"})
			clearInflight(resp.TurnID)
			setTurn("")
			return
		}
		active = &codexAppActiveTurn{
			orbitTurnID: resp.TurnID,
			result:      codexTurnResult{Status: stSucceeded, Subtype: "completed", RuntimeSessionID: threadID},
		}
		activeMu.Unlock()

		userEv := map[string]interface{}{"text": resp.Content}
		if refs := turnAttachmentRefs(resp.Attachments); len(refs) > 0 {
			userEv["attachments"] = refs
		}
		emit(evUser, userEv)

		respCopy := *resp
		shellCtx := append([]string(nil), pendingShellCtx...)
		go func() {
			prepared := prepareCodexTurn(ctx, t, job, &respCopy, shellCtx)

			ok, interrupted := beginCodexAppTurnStart(&activeMu, &active, respCopy.TurnID)
			if !ok {
				return
			}
			if interrupted {
				finalizeActive(codexTurnResult{Status: stInterrupted, Subtype: "interrupted"})
				return
			}

			codexTurnID, err := app.startTurn(ctx, threadID, job, execDir, upDir, respCopy.TurnID, prepared.Prompt, prepared.ImagePaths)
			if err != nil {
				activeMu.Lock()
				same := active != nil && active.orbitTurnID == respCopy.TurnID
				interrupted := same && active.interruptRequested
				activeMu.Unlock()
				if !same {
					return
				}
				if interrupted {
					finalizeActive(codexTurnResult{Status: stInterrupted, Subtype: "interrupted"})
					return
				}
				emit(evError, map[string]interface{}{"message": "failed to start codex turn: " + err.Error()})
				finalizeActive(codexTurnResult{
					Status:  stFailed,
					Subtype: "turn_start_failed",
					Error:   err.Error(),
					Result:  err.Error(),
				})
				return
			}
			recordCodexTurnID(respCopy.TurnID, codexTurnID)
		}()
	}

	waitForIdle := func() {
		tk := time.NewTicker(150 * time.Millisecond)
		defer tk.Stop()
		deadline := time.After(shutdownDrainTimeout)
		for {
			activeMu.Lock()
			idle := active == nil
			activeMu.Unlock()
			if idle {
				return
			}
			select {
			case <-tk.C:
			case <-deadline:
				logln("codex app-server drain timeout for", job.SessionID)
				return
			case <-ctx.Done():
				return
			}
		}
	}

	var pendingShellCtx []string
	for {
		select {
		case <-ctx.Done():
			return stCancelled, true, false
		case <-shutdownCtx.Done():
			pollCancel()
			waitForIdle()
			return stCancelled, true, false
		case <-app.done:
			select {
			case <-shutdownCtx.Done():
				return stCancelled, true, false
			default:
				return stFailed, false, false
			}
		default:
		}

		resp, err := t.inbox(pollCtx, job.SessionID)
		if err != nil {
			if pollCtx.Err() != nil {
				continue
			}
			logln("inbox poll failed for", job.SessionID+":", err)
			time.Sleep(time.Second)
			continue
		}
		if resp == nil {
			continue
		}

		switch resp.Kind {
		case "message":
			setTurn(resp.TurnID)
			inflightMu.Lock()
			dup := inflight[resp.TurnID]
			if !dup {
				inflight[resp.TurnID] = true
			}
			inflightMu.Unlock()
			if dup {
				continue
			}
			startTurn(resp, pendingShellCtx)
			pendingShellCtx = nil

		case "shell":
			inflightMu.Lock()
			if inflight[resp.TurnID] {
				inflightMu.Unlock()
				continue
			}
			inflight[resp.TurnID] = true
			inflightMu.Unlock()
			setTurn(resp.TurnID)
			if shCmd, isBg := splitBackground(resp.Content); isBg {
				runShellTurnBackground(bg, execDir, scratchDir, shCmd, resp.TurnID, emit, job.Agent.Env)
				if err := t.turnComplete(job.SessionID, TurnCompleteRequest{
					TurnID: resp.TurnID, Status: stSucceeded,
					Result: "started in background", Subtype: "shell",
					RuntimeSessionID: currentRuntimeSessionID(job),
				}); err != nil {
					logln("shell turn-complete failed for", job.SessionID+":", err)
				}
			} else {
				shOut, shExit := runShellTurn(ctx, execDir, resp.Content, emit, resp.TurnID, job.Agent.Env)
				pendingShellCtx = append(pendingShellCtx,
					fmt.Sprintf("<bash-input>%s</bash-input>\n<bash-stdout>%s</bash-stdout>", resp.Content, shOut))
				if err := t.turnComplete(job.SessionID, TurnCompleteRequest{
					TurnID: resp.TurnID, Status: stSucceeded,
					Result: fmt.Sprintf("exit %d", shExit), Subtype: "shell",
					RuntimeSessionID: currentRuntimeSessionID(job),
				}); err != nil {
					logln("shell turn-complete failed for", job.SessionID+":", err)
				}
			}
			clearInflight(resp.TurnID)
			setTurn("")

		case "interrupt":
			emit(evInterrupt, map[string]interface{}{})
			requestActiveInterrupt(true)

		case "reload":
			applyRuntimeReload(job, resp.Content)
			emit(evSystem, map[string]interface{}{"subtype": "resumed", "reason": "config_changed", "runtime": "app-server"})

		case "diff":
			liveFiles, livePatches := liveDiff(job.WT)
			if err := t.diffResult(job.SessionID, DiffResultRequest{
				ChangedFiles:  liveFiles,
				ChangedDiff:   livePatches,
				WorktreeDirty: worktreeIsDirty(job.WT),
				BranchMerged:  branchMergedInto(job.WT),
			}); err != nil {
				logln("diff-result failed for", job.SessionID+":", err)
			}

		case "end":
			requestActiveInterrupt(false)
			return stSucceeded, true, false
		}
	}
}

func requestCodexAppInterrupt(activeMu *sync.Mutex, active **codexAppActiveTurn) (string, bool) {
	activeMu.Lock()
	defer activeMu.Unlock()
	if *active == nil {
		return "", false
	}
	(*active).interruptRequested = true
	if !(*active).startSent && (*active).codexTurnID == "" {
		return "", true
	}
	if (*active).codexTurnID == "" || (*active).interruptSent {
		return "", false
	}
	(*active).interruptSent = true
	return (*active).codexTurnID, false
}

func markCodexAppTurnStarted(activeMu *sync.Mutex, active **codexAppActiveTurn, orbitTurnID, codexTurnID string) string {
	if codexTurnID == "" {
		return ""
	}
	activeMu.Lock()
	defer activeMu.Unlock()
	if *active == nil {
		return ""
	}
	if orbitTurnID != "" && (*active).orbitTurnID != orbitTurnID {
		return ""
	}
	(*active).codexTurnID = codexTurnID
	if !(*active).interruptRequested || (*active).interruptSent {
		return ""
	}
	(*active).interruptSent = true
	return codexTurnID
}

func beginCodexAppTurnStart(activeMu *sync.Mutex, active **codexAppActiveTurn, orbitTurnID string) (bool, bool) {
	activeMu.Lock()
	defer activeMu.Unlock()
	if *active == nil || (*active).orbitTurnID != orbitTurnID {
		return false, false
	}
	if (*active).interruptRequested {
		return true, true
	}
	(*active).startSent = true
	return true, false
}

func turnAttachmentRefs(atts []TurnAttachment) []map[string]interface{} {
	if len(atts) == 0 {
		return nil
	}
	refs := make([]map[string]interface{}, 0, len(atts))
	for _, att := range atts {
		refs = append(refs, map[string]interface{}{"id": att.ID, "mime": att.MimeType, "name": att.FileName})
	}
	return refs
}

func startCodexAppServer(ctx context.Context, job *ClaimedSession, execDir, scratchDir string, emit emitFn) (*codexAppServer, error) {
	procCtx, cancel := context.WithCancel(ctx)
	args := []string{"app-server", "--stdio"}
	stateDir := filepath.Join(scratchDir, "codex-state")
	_ = os.MkdirAll(stateDir, 0o755)
	args = append(args, "-c", fmt.Sprintf("sqlite_home=%q", stateDir))
	if exe, err := os.Executable(); err == nil {
		args = append(args,
			"-c", fmt.Sprintf("mcp_servers.orbit.command=%q", exe),
			"-c", `mcp_servers.orbit.args=["mcp"]`,
		)
	}
	cmd := exec.CommandContext(procCtx, "codex", args...)
	cmd.Dir = execDir
	cmd.Env = envWithAgent(job.Agent.Env)
	cmd.Env = append(cmd.Env,
		"ORBIT_SESSION_ID="+job.SessionID,
		"ORBIT_AGENT_ID="+job.AgentID,
		"ORBIT_TASK_ID="+job.TaskID,
		envMCPPermissionPrompt+"=0",
	)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	app := &codexAppServer{
		cmd:           cmd,
		cancel:        cancel,
		stdin:         stdin,
		pending:       map[string]chan codexRPCMessage{},
		notifications: make(chan codexRPCMessage, 256),
		done:          make(chan struct{}),
	}
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, err
	}
	go app.readLoop(stdout)
	go func() {
		s := bufio.NewScanner(stderr)
		s.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for s.Scan() {
			emit(evSystem, map[string]interface{}{"stderr": s.Text() + "\n"})
		}
	}()
	return app, nil
}

func (a *codexAppServer) initialize(ctx context.Context) error {
	if _, err := a.request(ctx, "initialize", map[string]interface{}{
		"clientInfo": map[string]interface{}{
			"name":    "orbit",
			"title":   "Orbit",
			"version": "0.1.0",
		},
		"capabilities": map[string]interface{}{"experimentalApi": true},
	}); err != nil {
		return err
	}
	return a.notify("initialized", map[string]interface{}{})
}

func (a *codexAppServer) startOrResumeThread(ctx context.Context, job *ClaimedSession, execDir, upDir string) (string, error) {
	params := codexThreadParams(job, execDir, upDir)
	method := "thread/start"
	if job.RuntimeSessionID != "" {
		method = "thread/resume"
		params["threadId"] = job.RuntimeSessionID
	}
	result, err := a.request(ctx, method, params)
	if err != nil {
		return "", err
	}
	if id := threadIDFromResult(result); id != "" {
		return id, nil
	}
	if job.RuntimeSessionID != "" {
		return job.RuntimeSessionID, nil
	}
	return "", fmt.Errorf("%s response did not include thread.id", method)
}

func (a *codexAppServer) startTurn(ctx context.Context, threadID string, job *ClaimedSession, execDir, upDir, orbitTurnID, prompt string, imagePaths []string) (string, error) {
	result, err := a.request(ctx, "turn/start", codexTurnParams(threadID, job, execDir, upDir, orbitTurnID, prompt, imagePaths))
	if err != nil {
		return "", err
	}
	return turnIDFromResult(result), nil
}

func codexTurnParams(threadID string, job *ClaimedSession, execDir, upDir, orbitTurnID, prompt string, imagePaths []string) map[string]interface{} {
	input := []map[string]interface{}{}
	if strings.TrimSpace(prompt) != "" || len(imagePaths) == 0 {
		input = append(input, map[string]interface{}{"type": "text", "text": prompt})
	}
	for _, p := range imagePaths {
		input = append(input, map[string]interface{}{"type": "localImage", "path": p})
	}
	params := map[string]interface{}{
		"threadId":            threadID,
		"clientUserMessageId": orbitTurnID,
		"input":               input,
		"cwd":                 execDir,
		"approvalPolicy":      "never",
		"runtimeWorkspaceRoots": []string{
			execDir,
			upDir,
		},
		// danger-full-access mirrors the Claude path, which runs unsandboxed in execDir.
		// approvalPolicy is already "never" (Orbit fully trusts the agent), so codex's
		// sandbox is the only thing left restricting it — and workspace-write (network off,
		// writableRoots limited to the uploads dir) breaks git: fetch has no network, and a
		// worktree session's real .git lives outside the workspace so FETCH_HEAD writes get
		// denied. Full access removes that asymmetry with Claude.
		"sandboxPolicy": map[string]interface{}{"type": "dangerFullAccess"},
	}
	if job.Agent.Model != "" {
		params["model"] = job.Agent.Model
	}
	if effort := normalizeCodexReasoningEffort(job.Agent.Effort); effort != "" {
		params["effort"] = effort
	}
	return params
}

func codexThreadParams(job *ClaimedSession, execDir, upDir string) map[string]interface{} {
	params := map[string]interface{}{
		"cwd":            execDir,
		"approvalPolicy": "never",
		"sandbox":        "danger-full-access", // see codexTurnParams: parity with unsandboxed Claude
		"runtimeWorkspaceRoots": []string{
			execDir,
			upDir,
		},
		"threadSource": "orbit",
	}
	if job.Agent.Model != "" {
		params["model"] = job.Agent.Model
	}
	return params
}

func (a *codexAppServer) request(ctx context.Context, method string, params map[string]interface{}) (map[string]interface{}, error) {
	id := a.nextRequestID()
	ch := make(chan codexRPCMessage, 1)
	a.mu.Lock()
	a.pending[id] = ch
	a.mu.Unlock()
	if err := a.write(map[string]interface{}{"id": id, "method": method, "params": params}); err != nil {
		a.forget(id)
		return nil, err
	}
	select {
	case msg, ok := <-ch:
		if !ok {
			return nil, fmt.Errorf("codex app-server closed")
		}
		if msg.Error != nil {
			return nil, fmt.Errorf("%s: %s", method, msg.Error.Message)
		}
		return rawObject(msg.Result), nil
	case <-ctx.Done():
		a.forget(id)
		return nil, ctx.Err()
	case <-a.done:
		a.forget(id)
		return nil, fmt.Errorf("codex app-server closed")
	}
}

func (a *codexAppServer) notify(method string, params map[string]interface{}) error {
	return a.write(map[string]interface{}{"method": method, "params": params})
}

func (a *codexAppServer) nextRequestID() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.nextID++
	return fmt.Sprintf("orbit-%d", a.nextID)
}

func (a *codexAppServer) forget(id string) {
	a.mu.Lock()
	delete(a.pending, id)
	a.mu.Unlock()
}

func (a *codexAppServer) write(msg map[string]interface{}) error {
	b, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	if _, err := a.stdin.Write(append(b, '\n')); err != nil {
		return err
	}
	return nil
}

func (a *codexAppServer) readLoop(r io.Reader) {
	defer a.closeDone()
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var msg codexRPCMessage
		if json.Unmarshal([]byte(line), &msg) != nil {
			continue
		}
		if msg.Method != "" && msg.ID != nil {
			a.handleServerRequest(msg)
			continue
		}
		if msg.ID != nil {
			a.deliverResponse(msg)
			continue
		}
		if msg.Method != "" {
			select {
			case a.notifications <- msg:
			default:
				logln("codex app-server notification dropped:", msg.Method)
			}
		}
	}
}

func (a *codexAppServer) deliverResponse(msg codexRPCMessage) {
	id := rpcIDKey(msg.ID)
	a.mu.Lock()
	ch := a.pending[id]
	delete(a.pending, id)
	a.mu.Unlock()
	if ch != nil {
		ch <- msg
		close(ch)
	}
}

func (a *codexAppServer) handleServerRequest(msg codexRPCMessage) {
	method := strings.ToLower(msg.Method)
	var result map[string]interface{}
	switch {
	case strings.Contains(method, "commandexecution") || strings.Contains(method, "filechange"):
		result = map[string]interface{}{"decision": "decline"}
	case strings.Contains(method, "execcommand") || strings.Contains(method, "applypatch"):
		result = map[string]interface{}{"decision": "denied"}
	default:
		_ = a.write(map[string]interface{}{
			"id": msg.ID,
			"error": map[string]interface{}{
				"code":    -32601,
				"message": "Orbit runner does not implement app-server request " + msg.Method,
			},
		})
		return
	}
	_ = a.write(map[string]interface{}{"id": msg.ID, "result": result})
}

func (a *codexAppServer) closeDone() {
	a.doneOnce.Do(func() {
		close(a.done)
		a.mu.Lock()
		for id, ch := range a.pending {
			delete(a.pending, id)
			close(ch)
		}
		a.mu.Unlock()
	})
}

func (a *codexAppServer) close() {
	a.cancel()
	_ = a.stdin.Close()
	_ = a.cmd.Wait()
	a.closeDone()
}

func handleCodexAppNotification(msg codexRPCMessage, emit emitFn, activeMu *sync.Mutex, active **codexAppActiveTurn, finalize func(codexTurnResult), onTurnStarted func(string), processAssistant assistantTextProcessor, onRateLimits func(map[string]interface{})) {
	params := rawObject(msg.Params)
	switch msg.Method {
	case "account/rateLimits/updated":
		if snapshot := mapValue(firstPresent(params, "rateLimits", "rate_limits")); snapshot != nil && onRateLimits != nil {
			onRateLimits(snapshot)
		}
	case "thread/started":
		if threadID := nestedString(params, "thread", "id"); threadID != "" {
			emit(evSystem, map[string]interface{}{"subtype": "resumed", "sessionId": threadID, "provider": providerCodex, "runtime": "app-server"})
		}
	case "turn/started":
		turnID := nestedString(params, "turn", "id")
		if turnID != "" {
			if onTurnStarted != nil {
				onTurnStarted(turnID)
			} else {
				activeMu.Lock()
				if *active != nil {
					(*active).codexTurnID = turnID
				}
				activeMu.Unlock()
			}
		}
	case "item/agentMessage/delta":
		if delta := firstString(params, "delta"); delta != "" {
			emit(evTextDelta, map[string]interface{}{"text": delta})
			activeMu.Lock()
			if *active != nil {
				(*active).deltaText.WriteString(delta)
			}
			activeMu.Unlock()
		}
	case "item/reasoning/textDelta", "item/reasoning/summaryTextDelta":
		// Streaming increment: animate it live via thinking_delta (ephemeral, not
		// persisted) and accumulate it — the completed reasoning item carries no
		// text of its own, so the durable `thinking` event is flushed from here.
		if delta := firstString(params, "delta"); delta != "" {
			emit(evThinkingDelta, map[string]interface{}{"text": delta})
			activeMu.Lock()
			if *active != nil {
				(*active).thinkText.WriteString(delta)
			}
			activeMu.Unlock()
		}
	case "item/started":
		activeMu.Lock()
		if *active != nil {
			handleCodexItem(map[string]interface{}{"item": firstPresent(params, "item")}, emit, &(*active).result, &(*active).fullText, false, processAssistant)
		}
		activeMu.Unlock()
	case "item/completed":
		item := mapValue(firstPresent(params, "item"))
		activeMu.Lock()
		if *active != nil {
			if strings.Contains(strings.ToLower(firstString(item, "type", "kind")), "reasoning") {
				// Flush the streamed reasoning as ONE durable thinking event so it
				// survives turn end / reload, instead of a persisted row per delta.
				text := strings.TrimSpace((*active).thinkText.String())
				(*active).thinkText.Reset()
				if text == "" {
					text = codexText(item)
				}
				if text != "" {
					emit(evThinking, map[string]interface{}{"text": text})
				}
			} else {
				handleCodexItem(map[string]interface{}{"item": item}, emit, &(*active).result, &(*active).fullText, true, processAssistant)
			}
		}
		activeMu.Unlock()
	case "error":
		errMsg := nestedString(params, "error", "message")
		if errMsg == "" {
			errMsg = "codex app-server error"
		}
		emit(evError, map[string]interface{}{"message": errMsg})
		activeMu.Lock()
		if *active != nil {
			(*active).result.Status = stFailed
			(*active).result.Subtype = "error"
			(*active).result.Error = errMsg
		}
		activeMu.Unlock()
	case "thread/tokenUsage/updated":
		turnID := firstString(params, "turnId", "turn_id")
		tokenUsage := firstPresent(params, "tokenUsage", "token_usage")
		activeMu.Lock()
		if *active != nil && ((*active).codexTurnID == "" || turnID == "" || (*active).codexTurnID == turnID) {
			if contextTokens := codexThreadContextTokens(tokenUsage); contextTokens > 0 {
				(*active).result.ContextTokens = contextTokens
			}
			if usage := codexThreadLastUsage(tokenUsage); usage != nil {
				(*active).result.Usage = usage
			}
		}
		activeMu.Unlock()
	case "turn/completed":
		turn := mapValue(params["turn"])
		status := strings.ToLower(firstString(turn, "status"))
		errMsg := nestedString(turn, "error", "message")
		result := codexTurnResult{RuntimeSessionID: firstString(params, "threadId")}
		switch status {
		case "failed":
			result.Status = stFailed
			result.Subtype = "failed"
			result.Error = errMsg
		case "interrupted":
			result.Status = stInterrupted
			result.Subtype = "interrupted"
		default:
			result.Status = stSucceeded
			result.Subtype = "completed"
		}
		if usage := codexUsage(firstPresent(params, "usage")); usage != nil {
			result.Usage = usage
		} else if usage := codexUsage(firstPresent(turn, "usage")); usage != nil {
			result.Usage = usage
		}
		finalize(result)
	}
}

func rawObject(raw json.RawMessage) map[string]interface{} {
	if len(raw) == 0 {
		return map[string]interface{}{}
	}
	var m map[string]interface{}
	if json.Unmarshal(raw, &m) != nil || m == nil {
		return map[string]interface{}{}
	}
	return m
}

func rpcIDKey(id interface{}) string {
	switch v := id.(type) {
	case string:
		return v
	default:
		return fmt.Sprintf("%v", v)
	}
}

func threadIDFromResult(result map[string]interface{}) string {
	return nestedString(result, "thread", "id")
}

func turnIDFromResult(result map[string]interface{}) string {
	return nestedString(result, "turn", "id")
}

func nestedString(m map[string]interface{}, path ...string) string {
	cur := m
	for i, p := range path {
		if i == len(path)-1 {
			return asString(cur[p])
		}
		next := mapValue(cur[p])
		if next == nil {
			return ""
		}
		cur = next
	}
	return ""
}
