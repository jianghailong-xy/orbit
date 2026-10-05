package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

type dshRPCError struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
}

type dshRPCMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      interface{}     `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *dshRPCError    `json:"error,omitempty"`
}

type dshRPCReply struct {
	message dshRPCMessage
	err     error
}

type dshWrite struct {
	wire []byte
	ack  chan error
}

type dshACPClient struct {
	cmd           *exec.Cmd
	cancel        context.CancelFunc
	stdin         io.WriteCloser
	mapper        *dshEventMapper
	mu            sync.Mutex
	nextID        int
	pending       map[string]chan dshRPCReply
	terminalErr   error
	writes        chan dshWrite
	done          chan struct{}
	once          sync.Once
	wg            sync.WaitGroup
	configOptions []interface{} // configured only by the session loop
}

func startDshACP(ctx context.Context, spec DshLaunchSpec, mapper *dshEventMapper, emit emitFn) (*dshACPClient, error) {
	if spec.Version != dshSupportedVersion {
		return nil, fmt.Errorf("unsupported dsh CLI version %q; require %s", spec.Version, dshSupportedVersion)
	}
	if !filepath.IsAbs(spec.Executable) || !filepath.IsAbs(spec.Cwd) || !filepath.IsAbs(spec.DshHome) {
		return nil, fmt.Errorf("dsh launch requires absolute executable, cwd and DSH_HOME")
	}
	procCtx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(procCtx, spec.Executable, spec.Args...)
	configureSessionProcessTree(cmd)
	cmd.Dir, cmd.Env = spec.Cwd, append([]string{}, spec.Env...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		cancel()
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		cancel()
		return nil, err
	}
	if err := startSessionProcess(cmd); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		_ = stderr.Close()
		cancel()
		return nil, err
	}
	a := &dshACPClient{cmd: cmd, cancel: cancel, stdin: stdin, mapper: mapper,
		pending: map[string]chan dshRPCReply{}, writes: make(chan dshWrite, 16), done: make(chan struct{})}
	emit(evSystem, map[string]interface{}{"subtype": "launch", "provider": providerDsh, "runtime": "acp",
		"executable": spec.Executable, "argv": spec.Args, "cliVersion": spec.Version,
		"dshHome": spec.DshHome, "configHash": spec.ConfigHash})
	a.wg.Add(3)
	go func() { defer a.wg.Done(); a.readLoop(stdout) }()
	go func() { defer a.wg.Done(); a.writeLoop() }()
	go func() {
		defer a.wg.Done()
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
		for sc.Scan() {
			// Startup diagnostics remain diagnostics, never a successful ACP result.
			logln("dsh stderr:", stripANSI(sc.Text()))
		}
	}()
	return a, nil
}

// One reader applies updates synchronously before releasing any response waiter.
// This is the response barrier: emitFor must finish before the next wire line is read.
func (a *dshACPClient) readLoop(r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for sc.Scan() {
		var msg dshRPCMessage
		if err := json.Unmarshal(sc.Bytes(), &msg); err != nil || msg.JSONRPC != "2.0" {
			a.fail(fmt.Errorf("dsh emitted invalid JSON-RPC"))
			return
		}
		if msg.Method != "" {
			if msg.ID != nil {
				// P4 wires the permission bridge. Until then reverse requests fail closed.
				response := map[string]interface{}{"jsonrpc": "2.0", "id": msg.ID,
					"error": map[string]interface{}{"code": -32601, "message": "unsupported ACP request " + msg.Method}}
				if msg.Method == "session/request_permission" {
					delete(response, "error")
					response["result"] = map[string]interface{}{"outcome": map[string]interface{}{"outcome": "cancelled"}}
				}
				if err := a.write(context.Background(), response); err != nil {
					a.fail(err)
					return
				}
			} else if msg.Method == "session/update" && a.mapper != nil {
				if err := a.mapper.update(rawObject(msg.Params)); err != nil {
					a.fail(err)
					return
				}
			}
			continue
		}
		if msg.ID == nil || (msg.Error == nil && len(msg.Result) == 0) || (msg.Error != nil && len(msg.Result) > 0) {
			a.fail(fmt.Errorf("dsh emitted invalid ACP response"))
			return
		}
		a.mu.Lock()
		ch := a.pending[rpcIDKey(msg.ID)]
		delete(a.pending, rpcIDKey(msg.ID))
		if ch != nil {
			ch <- dshRPCReply{message: msg}
		}
		a.mu.Unlock()
	}
	err := sc.Err()
	if err == nil {
		err = io.EOF
	}
	a.fail(fmt.Errorf("dsh ACP transport closed: %w", err))
}

func (a *dshACPClient) fail(err error) {
	a.once.Do(func() {
		a.mu.Lock()
		a.terminalErr = err
		for id, ch := range a.pending {
			ch <- dshRPCReply{err: err}
			delete(a.pending, id)
		}
		close(a.done)
		a.mu.Unlock()
		_ = a.stdin.Close()
		a.cancel()
	})
}

func (a *dshACPClient) writeLoop() {
	for {
		select {
		case <-a.done:
			return
		case item := <-a.writes:
			n, err := a.stdin.Write(item.wire)
			if err == nil && n != len(item.wire) {
				err = io.ErrShortWrite
			}
			item.ack <- err
			if err != nil {
				a.fail(err)
				return
			}
		}
	}
}

func (a *dshACPClient) write(ctx context.Context, value map[string]interface{}) error {
	wire, err := json.Marshal(value)
	if err != nil {
		return err
	}
	item := dshWrite{wire: append(wire, '\n'), ack: make(chan error, 1)}
	select {
	case a.writes <- item:
	case <-a.done:
		return fmt.Errorf("dsh ACP transport closed")
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case err := <-item.ack:
		return err
	case <-a.done:
		return fmt.Errorf("dsh ACP transport closed")
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (a *dshACPClient) call(ctx context.Context, method string, params map[string]interface{}) (map[string]interface{}, error) {
	a.mu.Lock()
	if a.terminalErr != nil {
		err := a.terminalErr
		a.mu.Unlock()
		return nil, err
	}
	a.nextID++
	id := fmt.Sprintf("orbit-dsh-%d", a.nextID)
	ch := make(chan dshRPCReply, 1)
	a.pending[id] = ch
	a.mu.Unlock()
	defer func() { a.mu.Lock(); delete(a.pending, id); a.mu.Unlock() }()
	if err := a.write(ctx, map[string]interface{}{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		// A response followed immediately by EOF still wins over the transport close.
		select {
		case reply := <-ch:
			return dshDecodeReply(method, reply)
		default:
			return nil, err
		}
	}
	select {
	case reply := <-ch:
		return dshDecodeReply(method, reply)
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func dshDecodeReply(method string, reply dshRPCReply) (map[string]interface{}, error) {
	if reply.err != nil {
		return nil, reply.err
	}
	if e := reply.message.Error; e != nil {
		return nil, fmt.Errorf("dsh %s (%d): %s %s", method, e.Code, e.Message, clip(kimiRPCErrorDetail(e.Data), 300))
	}
	var result map[string]interface{}
	if json.Unmarshal(reply.message.Result, &result) != nil || result == nil {
		return nil, fmt.Errorf("dsh %s returned a non-object result", method)
	}
	return result, nil
}

func (a *dshACPClient) initialize(ctx context.Context) error {
	result, err := a.call(ctx, "initialize", map[string]interface{}{"protocolVersion": 1,
		"clientCapabilities": map[string]interface{}{}, "clientInfo": map[string]interface{}{"name": "orbit", "version": version}})
	if err == nil && toInt(result["protocolVersion"]) != 1 {
		err = fmt.Errorf("dsh negotiated unsupported ACP protocol version")
	}
	return err
}

func (a *dshACPClient) open(ctx context.Context, cwd string) (string, error) {
	result, err := a.call(ctx, "session/new", map[string]interface{}{"cwd": cwd, "mcpServers": []interface{}{}})
	if err != nil {
		return "", err
	}
	sessionID := firstString(result, "sessionId")
	if sessionID == "" {
		return "", fmt.Errorf("dsh session/new returned no sessionId")
	}
	a.configOptions, _ = result["configOptions"].([]interface{})
	return sessionID, nil
}

func (a *dshACPClient) configure(ctx context.Context, sessionID string, agent AgentExecConfig) error {
	for _, selection := range []struct{ id, value string }{{"model", agent.Model}, {"reasoning_effort", agent.Effort}} {
		if selection.value == "" {
			continue
		}
		value, err := dshConfigValue(a.configOptions, selection.id, selection.value)
		if err != nil {
			return err
		}
		result, err := a.call(ctx, "session/set_config_option", map[string]interface{}{
			"sessionId": sessionID, "configId": selection.id, "value": value})
		if err != nil {
			return err
		}
		a.configOptions, _ = result["configOptions"].([]interface{})
	}
	return nil
}

func dshConfigValue(options []interface{}, id, requested string) (string, error) {
	var matches []string
	var walk func([]interface{})
	walk = func(rows []interface{}) {
		for _, raw := range rows {
			row := mapValue(raw)
			if nested, ok := row["options"].([]interface{}); ok {
				walk(nested)
				continue
			}
			value := firstString(row, "value")
			if value == requested {
				matches = append(matches, value)
				continue
			}
			// A model's display label is not its identity. Match only its live wire tuple.
			var tuple []string
			if id == "model" && json.Unmarshal([]byte(value), &tuple) == nil && len(tuple) == 2 && tuple[1] == requested {
				matches = append(matches, value)
			}
		}
	}
	for _, raw := range options {
		row := mapValue(raw)
		if firstString(row, "id") == id {
			rows, _ := row["options"].([]interface{})
			walk(rows)
		}
	}
	if len(matches) != 1 {
		return "", fmt.Errorf("dsh config %s value %q is not uniquely advertised by this session", id, requested)
	}
	return matches[0], nil
}

func (a *dshACPClient) prompt(ctx context.Context, sessionID, turnID, text string) (map[string]interface{}, error) {
	return a.call(ctx, "session/prompt", map[string]interface{}{"sessionId": sessionID,
		"prompt": []map[string]interface{}{{"type": "text", "text": text}}})
}

func (a *dshACPClient) closeSession(ctx context.Context, sessionID string) error {
	_, err := a.call(ctx, "session/close", map[string]interface{}{"sessionId": sessionID})
	return err
}

func (a *dshACPClient) dispose() {
	a.fail(fmt.Errorf("dsh ACP disposed"))
	_ = waitSessionProcessTree(a.cmd)
	a.wg.Wait()
}

type dshPromptResult struct {
	turnID string
	result map[string]interface{}
	err    error
}

func runDshSessionProcess(p sessionProcessArgs) (string, bool, bool) {
	p.setTurn("")
	spec := p.dshLaunchSpec
	if spec == nil {
		prepared, err := prepareDshSessionLaunch(p.ctx, p.job, p.scratchDir, p.execDir)
		if err != nil {
			p.emit(evError, map[string]interface{}{"message": err.Error()})
			return stFailed, true, false
		}
		spec = &prepared
	}
	if spec.Cwd != p.execDir {
		p.emit(evError, map[string]interface{}{"message": "dsh launch cwd differs from the session workspace"})
		return stFailed, true, false
	}
	mapper := newDshEventMapper(p.job.RuntimeSessionID, p.emitFor)
	app, err := startDshACP(p.ctx, *spec, mapper, p.emit)
	if err != nil {
		p.emit(evError, map[string]interface{}{"message": "failed to start DeepSeek Harness: " + err.Error()})
		return stFailed, true, false
	}
	defer app.dispose()
	initCtx, initCancel := context.WithTimeout(p.ctx, 60*time.Second)
	defer initCancel()
	if err := app.initialize(initCtx); err != nil {
		p.emit(evError, map[string]interface{}{"message": err.Error()})
		return stFailed, true, false
	}
	// P3b owns durable recovery and its races. Never replace an existing id with new.
	if p.job.RuntimeSessionID != "" {
		p.emit(evError, map[string]interface{}{"message": "DeepSeek Harness recovery requires the durable session lifecycle adapter"})
		return stFailed, true, false
	}
	sessionID, err := app.open(initCtx, p.execDir)
	if err != nil {
		p.emit(evError, map[string]interface{}{"message": err.Error()})
		return stFailed, true, false
	}
	p.job.RuntimeSessionID = sessionID
	mapper.mu.Lock()
	mapper.sessionID = sessionID
	mapper.mu.Unlock()
	writeSessionMeta(p.scratchDir, p.job, p.execDir)
	if err := app.configure(initCtx, sessionID, p.job.Agent); err != nil {
		p.emit(evError, map[string]interface{}{"message": err.Error()})
		return stFailed, true, false
	}
	p.emit(evSystem, map[string]interface{}{"subtype": "init", "provider": providerDsh, "runtime": "acp",
		"sessionId": sessionID, "runtimeSessionId": sessionID, "cliVersion": spec.Version})

	pollCtx, pollCancel := context.WithCancel(p.ctx)
	defer pollCancel()
	inbox := make(chan *RunInboxResponse, 8)
	pollErrors := make(chan error, 1)
	var pollWG sync.WaitGroup
	pollWG.Add(1)
	defer func() { pollCancel(); pollWG.Wait() }()
	go func() {
		defer pollWG.Done()
		for pollCtx.Err() == nil {
			resp, err := p.t.inbox(pollCtx, p.job.SessionID, p.leaseGeneration)
			if err != nil {
				if pollCtx.Err() != nil {
					return
				}
				if isLeaseOwnershipError(err) {
					select {
					case pollErrors <- err:
					case <-pollCtx.Done():
					}
					return
				}
				select {
				case <-time.After(time.Second):
				case <-pollCtx.Done():
					return
				}
				continue
			}
			if resp != nil {
				select {
				case inbox <- resp:
				case <-pollCtx.Done():
					return
				}
			}
		}
	}()

	promptDone := make(chan dshPromptResult, 1)
	var promptWG sync.WaitGroup
	defer func() { app.fail(fmt.Errorf("dsh session loop stopped")); promptWG.Wait() }()
	var activeID string
	interrupted := false
	seen := map[string]bool{}
	var queued []*RunInboxResponse
	finish := func(done dshPromptResult) {
		if interrupted {
			done.result, done.err = map[string]interface{}{"stopReason": "cancelled"}, nil
		}
		req, ok := mapper.settle(done.turnID, done.result, done.err)
		if !ok {
			return
		}
		req.IsolationStatus = p.job.IsolationStatus
		req.ChangedFiles, req.ChangedDiff = liveDiff(p.job.WT)
		req.BaseSha = p.job.WT.baseSha()
		req.WorktreeDirty = worktreeIsDirty(p.job.WT)
		req.BranchSha, req.BranchMerged = effectiveBranchSha(p.job.WT), branchMergedInto(p.job.WT)
		req.WorktreeBranch = currentBranch(p.job.WT)
		if err := p.completeTurn(req); err != nil {
			logln("dsh turn-complete failed:", err)
		}
		activeID, interrupted = "", false
		p.setTurn("")
	}
	start := func(resp *RunInboxResponse) bool {
		if !p.waitTurnPermit(p.ctx) {
			return false
		}
		activeID = resp.TurnID
		p.setTurn(activeID)
		if err := mapper.begin(activeID); err != nil {
			p.emit(evError, map[string]interface{}{"message": err.Error()})
			return false
		}
		p.emitFor(activeID, evUser, map[string]interface{}{"text": resp.Content,
			"runtimeSessionId": sessionID, "localTurnId": activeID})
		if len(resp.Attachments) > 0 {
			finish(dshPromptResult{turnID: activeID, err: fmt.Errorf("DeepSeek Harness ACP does not support attachments in this composition")})
			return true
		}
		turnID := activeID
		promptWG.Add(1)
		go func() {
			defer promptWG.Done()
			result, err := app.prompt(p.ctx, sessionID, turnID, resp.Content)
			promptDone <- dshPromptResult{turnID: turnID, result: result, err: err}
		}()
		return true
	}
	closeSession := func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := app.closeSession(closeCtx, sessionID); err != nil {
			p.emit(evError, map[string]interface{}{"message": err.Error()})
			app.fail(err)
		}
	}
	for {
		if activeID == "" && len(queued) > 0 {
			next := queued[0]
			queued = queued[1:]
			if !start(next) {
				return stCancelled, true, false
			}
		}
		select {
		case <-p.ctx.Done():
			if activeID != "" {
				finish(dshPromptResult{turnID: activeID, err: p.ctx.Err()})
			}
			return stCancelled, true, false
		case <-p.shutdownCtx.Done():
			closeSession()
			if activeID != "" {
				interrupted = true
				finish(<-promptDone)
			}
			return stCancelled, true, false
		case err := <-pollErrors:
			app.fail(err)
			if activeID != "" {
				finish(<-promptDone)
			}
			p.onLeaseLost(err)
			return stFailed, true, false
		case <-app.done:
			if activeID != "" {
				finish(<-promptDone)
			}
			p.emit(evSystem, map[string]interface{}{"subtype": "process_exited", "provider": providerDsh,
				"runtimeSessionId": sessionID})
			// No automatic prompt replay: tools may already have produced side effects.
			return stFailed, true, false
		case done := <-promptDone:
			finish(done)
		case resp := <-inbox:
			switch resp.Kind {
			case "message":
				if !seen[resp.TurnID] {
					seen[resp.TurnID] = true
					queued = append(queued, resp)
				}
			case "steer":
				refuseUnsupportedSteer(resp.TurnID, resp.Content, providerDsh, p.job, p.emitFor, p.completeTurn)
			case "interrupt":
				interrupted = activeID != ""
				p.emit(evInterrupt, map[string]interface{}{})
				cancelCtx, cancel := context.WithTimeout(p.ctx, 2*time.Second)
				err := app.write(cancelCtx, map[string]interface{}{"jsonrpc": "2.0", "method": "session/cancel",
					"params": map[string]interface{}{"sessionId": sessionID}})
				cancel()
				if err != nil {
					app.fail(err)
				}
			case "end":
				closeSession()
				if activeID != "" {
					interrupted = true
					finish(<-promptDone)
				}
				return stSucceeded, true, false
			case "reload":
				p.emit(evError, map[string]interface{}{"message": "DeepSeek Harness live configuration reload requires the session lifecycle adapter"})
			default:
				p.emit(evError, map[string]interface{}{"message": "unsupported DeepSeek Harness inbox kind " + resp.Kind})
			}
		}
	}
}
