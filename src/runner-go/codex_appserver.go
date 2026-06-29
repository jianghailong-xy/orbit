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
	orbitTurnID string
	codexTurnID string
	result      codexTurnResult
	fullText    strings.Builder
	deltaText   strings.Builder
}

func runCodexAppServerSessionProcess(ctx context.Context, shutdownCtx context.Context, t *Transport, job *ClaimedSession, execDir, scratchDir string, emit emitFn, setTurn func(string), _ bool, bg *bgTailer) (string, bool, bool) {
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
		emit(evTurnEnd, map[string]interface{}{
			"subtype":  result.Subtype,
			"numTurns": 1,
			"costUsd":  0,
		})
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
				handleCodexAppNotification(msg, emit, &activeMu, &active, finalizeActive)
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
		prepared := prepareCodexTurn(ctx, t, job, resp, pendingShellCtx)
		userEv := map[string]interface{}{"text": resp.Content}
		if len(prepared.AttachmentRefs) > 0 {
			userEv["attachments"] = prepared.AttachmentRefs
		}
		emit(evUser, userEv)

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

		codexTurnID, err := app.startTurn(ctx, threadID, job, execDir, upDir, resp.TurnID, prepared.Prompt, prepared.ImagePaths)
		if err != nil {
			emit(evError, map[string]interface{}{"message": "failed to start codex turn: " + err.Error()})
			finalizeActive(codexTurnResult{
				Status:  stFailed,
				Subtype: "turn_start_failed",
				Error:   err.Error(),
				Result:  err.Error(),
			})
			return
		}
		activeMu.Lock()
		if active != nil && active.orbitTurnID == resp.TurnID && active.codexTurnID == "" {
			active.codexTurnID = codexTurnID
		}
		activeMu.Unlock()
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
			activeMu.Lock()
			var codexTurnID string
			if active != nil {
				codexTurnID = active.codexTurnID
			}
			activeMu.Unlock()
			if codexTurnID != "" {
				if _, err := app.request(ctx, "turn/interrupt", map[string]interface{}{"threadId": threadID, "turnId": codexTurnID}); err != nil {
					logln("codex turn/interrupt failed for", job.SessionID+":", err)
				}
			}
			emit(evInterrupt, map[string]interface{}{})

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
			activeMu.Lock()
			var codexTurnID string
			if active != nil {
				codexTurnID = active.codexTurnID
			}
			activeMu.Unlock()
			if codexTurnID != "" {
				_, _ = app.request(ctx, "turn/interrupt", map[string]interface{}{"threadId": threadID, "turnId": codexTurnID})
			}
			return stSucceeded, true, false
		}
	}
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
		"sandboxPolicy": map[string]interface{}{
			"type":          "workspaceWrite",
			"networkAccess": false,
			"writableRoots": []string{upDir},
		},
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
		"sandbox":        "workspace-write",
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

func handleCodexAppNotification(msg codexRPCMessage, emit emitFn, activeMu *sync.Mutex, active **codexAppActiveTurn, finalize func(codexTurnResult)) {
	params := rawObject(msg.Params)
	switch msg.Method {
	case "thread/started":
		if threadID := nestedString(params, "thread", "id"); threadID != "" {
			emit(evSystem, map[string]interface{}{"subtype": "resumed", "sessionId": threadID, "provider": providerCodex, "runtime": "app-server"})
		}
	case "turn/started":
		turnID := nestedString(params, "turn", "id")
		if turnID != "" {
			activeMu.Lock()
			if *active != nil {
				(*active).codexTurnID = turnID
			}
			activeMu.Unlock()
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
		if delta := firstString(params, "delta"); delta != "" {
			emit(evThinking, map[string]interface{}{"text": delta})
		}
	case "item/started":
		activeMu.Lock()
		if *active != nil {
			handleCodexItem(map[string]interface{}{"item": firstPresent(params, "item")}, emit, &(*active).result, &(*active).fullText, false)
		}
		activeMu.Unlock()
	case "item/completed":
		activeMu.Lock()
		if *active != nil {
			handleCodexItem(map[string]interface{}{"item": firstPresent(params, "item")}, emit, &(*active).result, &(*active).fullText, true)
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
