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
	"regexp"
	"strings"
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
	secrets       []string      // launch credentials, masked out of every diagnostic
	// permissions answers session/request_permission; without it every request is cancelled.
	permissions *dshPermissionBridge
}

// permissions may be nil; it is attached before the reader starts, so every approval request
// this process sends reaches it.
func startDshACP(ctx context.Context, spec DshLaunchSpec, mapper *dshEventMapper, permissions *dshPermissionBridge, emit emitFn) (*dshACPClient, error) {
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
	a := &dshACPClient{cmd: cmd, cancel: cancel, stdin: stdin, mapper: mapper, secrets: dshLaunchSecrets(spec.Env),
		pending: map[string]chan dshRPCReply{}, writes: make(chan dshWrite, 16), done: make(chan struct{})}
	if permissions != nil {
		permissions.reply = a.respondPermission
		a.permissions = permissions
	}
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
			logln("dsh stderr:", a.redact(stripANSI(sc.Text())))
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
			if msg.ID != nil && msg.Method == "session/request_permission" && a.permissions != nil {
				a.permissions.request(msg.ID, rawObject(msg.Params))
			} else if msg.ID != nil {
				// No other reverse request is served, and without a bridge approvals fail closed.
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
		// A card left open on a lost transport can only be withdrawn: nothing could act on it.
		if a.permissions != nil {
			a.permissions.close()
		}
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
			return a.decodeReply(method, reply)
		default:
			return nil, err
		}
	}
	select {
	case reply := <-ch:
		return a.decodeReply(method, reply)
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// The error stays an error, so a masked credential never hides a failed terminal state.
func (a *dshACPClient) decodeReply(method string, reply dshRPCReply) (map[string]interface{}, error) {
	if reply.err != nil {
		return nil, reply.err
	}
	if e := reply.message.Error; e != nil {
		return nil, &dshCallError{
			text:           fmt.Sprintf("dsh %s (%d): %s %s", method, e.Code, a.redact(e.Message), clip(a.redact(kimiRPCErrorDetail(e.Data)), 300)),
			upstreamStatus: dshUpstreamStatus(e.Data),
		}
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

// respondPermission answers one reverse request; dsh reads it by the server's RPC id.
func (a *dshACPClient) respondPermission(id interface{}, outcome map[string]interface{}) error {
	return a.write(context.Background(), map[string]interface{}{"jsonrpc": "2.0", "id": id,
		"result": map[string]interface{}{"outcome": outcome}})
}

func (a *dshACPClient) open(ctx context.Context, cwd string, mcpServers []interface{}) (string, error) {
	if mcpServers == nil {
		mcpServers = []interface{}{}
	}
	result, err := a.call(ctx, "session/new", map[string]interface{}{"cwd": cwd, "mcpServers": mcpServers})
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

// resume reattaches the durable runtime id. A failure is reported, never replaced by new:
// a fresh session would silently drop the conversation the user is continuing.
// MCP connections are not persisted, so every resume declares the servers again.
func (a *dshACPClient) resume(ctx context.Context, sessionID, cwd string, mcpServers []interface{}) error {
	if mcpServers == nil {
		mcpServers = []interface{}{}
	}
	result, err := a.call(ctx, "session/resume", map[string]interface{}{"sessionId": sessionID, "cwd": cwd, "mcpServers": mcpServers})
	if err != nil {
		return err
	}
	a.configOptions, _ = result["configOptions"].([]interface{})
	return nil
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
	if a.permissions != nil {
		a.permissions.wait()
	}
}

var dshSecretPattern = regexp.MustCompile(`sk-[A-Za-z0-9_-]{8,}`)

func dshLaunchSecrets(env []string) []string {
	var secrets []string
	for _, entry := range env {
		if value, ok := strings.CutPrefix(entry, "ORBIT_DSH_API_KEY="); ok && value != "" {
			secrets = append(secrets, value)
		}
	}
	return secrets
}

// redact masks the launch key, and anything shaped like a provider key, in text dsh wrote.
func (a *dshACPClient) redact(text string) string {
	for _, secret := range a.secrets {
		text = strings.ReplaceAll(text, secret, "[redacted]")
	}
	return dshSecretPattern.ReplaceAllString(text, "sk-[redacted]")
}

const (
	dshTurnPrompted = "prompted"
	dshTurnSettled  = "settled"
	// How long a stopped prompt may take to answer before its process is ended instead.
	dshStopGrace = 10 * time.Second
)

type dshTurnRecord struct {
	State     string   `json:"state"`
	OpenTools []string `json:"openTools,omitempty"`
	Status    string   `json:"status,omitempty"`
	Subtype   string   `json:"subtype,omitempty"`
	Result    string   `json:"result,omitempty"`
	Error     string   `json:"error,omitempty"`
}

// dshTurnLedger lives in the retained DSH_HOME. Orbit's queue knows a turn was leased, not
// whether its prompt reached dsh before a crash; this record does, across processes, runner
// restarts and lease owners, so a redelivered turn is never prompted twice.
type dshTurnLedger struct {
	mu               sync.Mutex
	path             string
	RuntimeSessionID string                    `json:"runtimeSessionId,omitempty"`
	Turns            map[string]*dshTurnRecord `json:"turns"`
}

func loadDshTurnLedger(home string) (*dshTurnLedger, error) {
	l := &dshTurnLedger{path: filepath.Join(home, "orbit-turns.json"), Turns: map[string]*dshTurnRecord{}}
	data, err := os.ReadFile(l.path)
	if os.IsNotExist(err) {
		return l, nil
	}
	if err != nil || json.Unmarshal(data, l) != nil {
		return nil, fmt.Errorf("DSH_CONFIG_CONFLICT: the session's turn ledger cannot be read; recovery data retained")
	}
	if l.Turns == nil {
		l.Turns = map[string]*dshTurnRecord{}
	}
	return l, nil
}

// update applies fn and persists the result before returning.
func (l *dshTurnLedger) update(fn func()) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	fn()
	data, err := json.Marshal(l)
	if err != nil {
		return err
	}
	return writeDshConfigFile(l.path, data)
}

func (l *dshTurnLedger) get(turnID string) (dshTurnRecord, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	rec, ok := l.Turns[turnID]
	if !ok {
		return dshTurnRecord{}, false
	}
	copied := *rec
	copied.OpenTools = append([]string(nil), rec.OpenTools...)
	return copied, true
}

// dshSettlementOutcome applies the settlement precedence, highest first:
//  1. a local stop (interrupt, end, shutdown, session cancel, lease loss) settles cancelled,
//     whatever dsh answers afterwards, a late end_turn included;
//  2. dsh's prompt response: end_turn, max_tokens (the output limit), refusal or cancelled;
//  3. a JSON-RPC error answering the prompt (a protocol or model failure);
//  4. process exit or transport loss without any response.
//
// call() already lets a response that precedes EOF win over the transport close (2 over 4),
// and a JSON-RPC id carries exactly one of a result or an error (2 and 3 never meet).
func dshSettlementOutcome(stopped bool, result map[string]interface{}, err error) (map[string]interface{}, error) {
	if stopped {
		return map[string]interface{}{"stopReason": "cancelled"}, nil
	}
	return result, err
}

func dshCanonicalDir(dir string) (string, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(abs)
}

// What the launch environment fixes: changing any of it needs a new process.
func dshLaunchIdentity(job *ClaimedSession) string {
	return strings.Join([]string{job.Agent.Env["ORBIT_DSH_API_KEY"], job.Agent.Env["ORBIT_DSH_BASE_URL"],
		dshFileModeForPermission(job.Agent.PermissionMode)}, "\x00")
}

type dshPromptResult struct {
	turnID string
	result map[string]interface{}
	err    error
}

func runDshSessionProcess(p sessionProcessArgs) (string, bool, bool) {
	p.setTurn("")
	// dsh reports context occupancy only, never cost or tokens (P0): no turn of it claims a measured $0.
	completeTurn := p.completeTurn
	p.completeTurn = func(req TurnCompleteRequest, providerContexts ...context.Context) error {
		req.UsageUnknown = true
		return completeTurn(req, providerContexts...)
	}
	fail := func(message string) (string, bool, bool) {
		p.emit(evError, map[string]interface{}{"message": message})
		return stFailed, true, false
	}
	// What dsh cannot enforce is refused before anything is prepared or started.
	policy, err := dshPermissionPolicyFor(p.job.Agent.PermissionMode)
	if err == nil {
		err = dshToolPolicyError(p.job.Agent)
	}
	var mcpServers []interface{}
	if err == nil {
		mcpServers, err = dshMCPServers(p.job, policy)
	}
	if err != nil {
		return fail(err.Error())
	}
	spec := p.dshLaunchSpec
	prepared := spec == nil
	if prepared {
		launch, err := prepareDshSessionLaunch(p.ctx, p.job, p.execDir)
		if err != nil {
			return fail(err.Error())
		}
		spec = &launch
	}
	// One canonical cwd for the launch, new/resume and the identity P2 persisted.
	if cwd, err := dshCanonicalDir(p.execDir); err != nil || spec.Cwd != cwd {
		return fail("dsh launch cwd differs from the session workspace")
	}
	ledger, err := loadDshTurnLedger(spec.DshHome)
	if err != nil {
		return fail(err.Error())
	}
	runtimeID := p.job.RuntimeSessionID
	if runtimeID == "" {
		// Opened before Orbit heard the id: the retained state still names it.
		runtimeID = ledger.RuntimeSessionID
	} else if ledger.RuntimeSessionID != "" && ledger.RuntimeSessionID != runtimeID {
		return fail("DSH_CONFIG_CONFLICT: Orbit's runtime session id differs from the retained Harness state; recovery data retained")
	}
	mapper := newDshEventMapper(runtimeID, p.emitFor)
	mapper.onTool = func(turnID, toolID string, done bool) {
		err := ledger.update(func() {
			rec := ledger.Turns[turnID]
			if rec == nil || rec.State != dshTurnPrompted {
				return
			}
			if !done {
				rec.OpenTools = append(rec.OpenTools, toolID)
				return
			}
			for i, id := range rec.OpenTools {
				if id == toolID {
					rec.OpenTools = append(rec.OpenTools[:i:i], rec.OpenTools[i+1:]...)
					break
				}
			}
		})
		if err != nil {
			logln("dsh turn ledger:", err)
		}
	}
	permissions := newDshPermissionBridge(func() dshPermissionPolicy {
		// Read per request: a reload between Default and Don't Ask keeps the process.
		current, err := dshPermissionPolicyFor(p.job.Agent.PermissionMode)
		if err != nil {
			return dshPermissionPolicy{}
		}
		return current
	}, mapper.toolCall, func(ctx context.Context, ask dshPermissionAsk) string {
		return bridgeDshPermission(ctx, p.t, p.job.SessionID, ask)
	}, func(turnID, kind string, payload map[string]interface{}) {
		mapper.mu.Lock()
		payload["runtimeSessionId"] = mapper.sessionID
		mapper.mu.Unlock()
		if turnID != "" {
			payload["localTurnId"] = turnID
		}
		p.emitFor(turnID, kind, payload)
	})
	permissions.workspace = spec.Cwd
	app, err := startDshACP(p.ctx, *spec, mapper, permissions, p.emit)
	if err != nil {
		return fail("failed to start DeepSeek Harness: " + err.Error())
	}
	defer app.dispose()
	initCtx, initCancel := context.WithTimeout(p.ctx, 60*time.Second)
	defer initCancel()
	if err := app.initialize(initCtx); err != nil {
		return fail(err.Error())
	}
	// Seal the profile the pinned CLI generated before any session is opened or resumed.
	if prepared {
		if err := SealDshProfile(*spec); err != nil {
			return fail(err.Error())
		}
	}
	sessionID := runtimeID
	if sessionID == "" {
		if sessionID, err = app.open(initCtx, spec.Cwd, mcpServers); err != nil {
			return fail(err.Error())
		}
	} else if err := app.resume(initCtx, sessionID, spec.Cwd, mcpServers); err != nil {
		return fail("DeepSeek Harness could not resume session " + sessionID + ": " + err.Error())
	}
	if err := ledger.update(func() { ledger.RuntimeSessionID = sessionID }); err != nil {
		return fail("DSH_CONFIG_CONFLICT: cannot persist the runtime session id: " + err.Error())
	}
	p.job.RuntimeSessionID = sessionID
	mapper.mu.Lock()
	mapper.sessionID = sessionID
	mapper.mu.Unlock()
	writeSessionMeta(p.scratchDir, p.job, p.execDir)
	if err := app.configure(initCtx, sessionID, p.job.Agent); err != nil {
		return fail(err.Error())
	}
	p.emit(evSystem, map[string]interface{}{"subtype": "init", "provider": providerDsh, "runtime": "acp",
		"sessionId": sessionID, "runtimeSessionId": sessionID, "cliVersion": spec.Version, "resumed": runtimeID != ""})

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
	stopped := false // a local stop of the active turn; see dshSettlementOutcome
	seen := map[string]bool{}
	var queued []*RunInboxResponse
	worktree := func(req *TurnCompleteRequest) {
		req.IsolationStatus = p.job.IsolationStatus
		req.ChangedFiles, req.ChangedDiff = liveDiff(p.job.WT)
		req.BaseSha = p.job.WT.baseSha()
		req.WorktreeDirty = worktreeIsDirty(p.job.WT)
		req.BranchSha, req.BranchMerged = effectiveBranchSha(p.job.WT), branchMergedInto(p.job.WT)
		req.WorktreeBranch = currentBranch(p.job.WT)
	}
	// report=false settles only locally: after a lease loss the turn and its prompted record
	// belong to the new owner, which settles it without replaying the prompt.
	settle := func(done dshPromptResult, report bool) string {
		permissions.close()
		result, err := dshSettlementOutcome(stopped, done.result, done.err)
		req, ok := mapper.settle(done.turnID, result, err)
		if ok && report {
			if err := ledger.update(func() {
				ledger.Turns[req.TurnID] = &dshTurnRecord{State: dshTurnSettled, Status: req.Status,
					Subtype: req.Subtype, Result: req.Result, Error: req.Error}
			}); err != nil {
				logln("dsh turn ledger:", err)
			}
			worktree(&req)
			if err := p.completeTurn(req); err != nil {
				logln("dsh turn-complete failed:", err)
			}
		}
		activeID, stopped = "", false
		p.setTurn("")
		return req.Status
	}
	awaitPrompt := func() dshPromptResult {
		select {
		case done := <-promptDone:
			return done
		case <-time.After(dshStopGrace):
			app.fail(fmt.Errorf("dsh did not answer a stopped prompt"))
			return <-promptDone
		}
	}
	// A turn a previous process already prompted. Its first settlement is reported again; a turn
	// that never settled is interrupted, not replayed, because its tools may already have run.
	recoverTurn := func(resp *RunInboxResponse, rec dshTurnRecord) {
		req := TurnCompleteRequest{TurnID: resp.TurnID, Status: rec.Status, Subtype: rec.Subtype, Result: rec.Result,
			Error: rec.Error, NumTurns: 1, RuntimeSessionID: sessionID}
		if rec.State != dshTurnSettled {
			attribution := func(payload map[string]interface{}) map[string]interface{} {
				payload["runtimeSessionId"], payload["localTurnId"] = sessionID, resp.TurnID
				return payload
			}
			for _, id := range rec.OpenTools {
				p.emitFor(resp.TurnID, evToolResult, attribution(map[string]interface{}{
					"toolUseId": id, "toolCallId": id, "status": "failed", "isError": true,
					"content": "dsh stopped before this tool returned a final status; side effects may have occurred",
				}))
			}
			req.Status, req.Subtype = stInterrupted, "interrupted"
			req.Error = "DeepSeek Harness stopped during this turn; it was not replayed because its tools may already have run"
			p.emitFor(resp.TurnID, evError, attribution(map[string]interface{}{"message": req.Error}))
			p.emitFor(resp.TurnID, evTurnEnd, attribution(map[string]interface{}{"subtype": req.Subtype, "numTurns": 1, "recovered": true}))
			if err := ledger.update(func() {
				ledger.Turns[req.TurnID] = &dshTurnRecord{State: dshTurnSettled, Status: req.Status, Subtype: req.Subtype, Error: req.Error}
			}); err != nil {
				logln("dsh turn ledger:", err)
			}
		}
		worktree(&req)
		if err := p.completeTurn(req); err != nil {
			logln("dsh turn-complete failed:", err)
		}
	}
	start := func(resp *RunInboxResponse) bool {
		if !p.waitTurnPermit(p.ctx) {
			return false
		}
		if rec, ok := ledger.get(resp.TurnID); ok {
			p.setTurn(resp.TurnID)
			recoverTurn(resp, rec)
			p.setTurn("")
			return true
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
			settle(dshPromptResult{turnID: activeID, err: fmt.Errorf("DeepSeek Harness ACP does not support attachments in this composition")}, true)
			return true
		}
		turnID := activeID
		permissions.begin()
		// Recorded before the prompt is written: from here a crash leaves a turn that must not be replayed.
		if err := ledger.update(func() { ledger.Turns[turnID] = &dshTurnRecord{State: dshTurnPrompted} }); err != nil {
			settle(dshPromptResult{turnID: turnID, err: fmt.Errorf("cannot record the turn before prompting dsh: %v", err)}, true)
			return true
		}
		promptWG.Add(1)
		go func() {
			defer promptWG.Done()
			result, err := app.prompt(p.ctx, sessionID, turnID, resp.Content)
			promptDone <- dshPromptResult{turnID: turnID, result: result, err: err}
		}()
		return true
	}
	closeSession := func() {
		permissions.close()
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := app.closeSession(closeCtx, sessionID); err != nil {
			p.emit(evError, map[string]interface{}{"message": err.Error()})
			app.fail(err)
		}
	}
	// runAcceptance runs a task's EXECUTABLE acceptance command on the runner in the session's
	// worktree, with the same runSynchronousShellTurn every other engine uses, and reports its exit
	// code and output in the same shape. dsh is idle while it runs and is never told about it.
	runAcceptance := func(resp *RunInboxResponse) bool {
		if !p.waitTurnPermit(p.ctx) {
			return false
		}
		p.setTurn(resp.TurnID)
		req, err := runSynchronousShellTurn(p.ctx, p.t, p.job, p.execDir, resp,
			func(typ string, payload map[string]interface{}) { p.emitFor(resp.TurnID, typ, payload) })
		if err != nil {
			req = TurnCompleteRequest{TurnID: resp.TurnID, Status: stFailed, Result: err.Error(), Subtype: "shell"}
		}
		req.RuntimeSessionID = sessionID
		req.BranchSha = effectiveBranchSha(p.job.WT)
		if err := p.completeTurn(req); err != nil {
			logln("dsh acceptance turn-complete failed:", err)
		}
		p.setTurn("")
		return true
	}
	for {
		if activeID == "" && len(queued) > 0 {
			next := queued[0]
			queued = queued[1:]
			if next.Kind == "shell" {
				if !runAcceptance(next) {
					return stCancelled, true, false
				}
				continue
			}
			if !start(next) {
				return stCancelled, true, false
			}
			continue
		}
		select {
		case <-p.ctx.Done():
			permissions.close()
			if activeID != "" {
				stopped = true
				settle(<-promptDone, true)
			}
			return stCancelled, true, false
		case <-p.shutdownCtx.Done():
			stopped = activeID != ""
			closeSession()
			if activeID != "" {
				settle(awaitPrompt(), true)
			}
			return stCancelled, true, false
		case err := <-pollErrors:
			// Another owner holds the lease: end the process tree first, so nothing more runs on
			// this session's behalf, then settle locally and leave the turn to that owner.
			permissions.close()
			app.fail(err)
			if activeID != "" {
				stopped = true
				settle(<-promptDone, false)
			}
			p.onLeaseLost(err)
			return stFailed, true, false
		case <-app.done:
			if activeID == "" {
				p.emit(evSystem, map[string]interface{}{"subtype": "process_exited", "provider": providerDsh,
					"runtimeSessionId": sessionID})
				// An idle exit loses nothing: the session goes cold and the next message resumes it.
				return stFailed, false, false
			}
			status := settle(<-promptDone, true)
			p.emit(evSystem, map[string]interface{}{"subtype": "process_exited", "provider": providerDsh,
				"runtimeSessionId": sessionID})
			// No automatic prompt replay: tools may already have produced side effects. A failed
			// turn ends the session; a turn stopped first leaves it resumable.
			return stFailed, status == stFailed, false
		case done := <-promptDone:
			settle(done, true)
		case resp := <-inbox:
			switch resp.Kind {
			case "message":
				// One prompt at a time; the rest wait in Orbit's queue, or here when a lease
				// expiry redelivered them. A redelivered active, queued or settled turn is dropped.
				if !seen[resp.TurnID] {
					seen[resp.TurnID] = true
					queued = append(queued, resp)
				}
			case "steer":
				refuseUnsupportedSteer(resp.TurnID, resp.Content, providerDsh, p.job, p.emitFor, p.completeTurn)
			case "interrupt":
				p.emit(evInterrupt, map[string]interface{}{})
				if activeID == "" {
					continue
				}
				stopped = true
				// Close the approval path first: an Allow decided after this point is never written,
				// and one already written precedes the cancel on the wire.
				permissions.close()
				cancelCtx, cancel := context.WithTimeout(p.ctx, 2*time.Second)
				err := app.write(cancelCtx, map[string]interface{}{"jsonrpc": "2.0", "method": "session/cancel",
					"params": map[string]interface{}{"sessionId": sessionID}})
				cancel()
				if err != nil {
					app.fail(err)
				}
			case "end":
				stopped = activeID != ""
				closeSession()
				if activeID != "" {
					settle(awaitPrompt(), true)
				}
				return stSucceeded, true, false
			case "reload":
				before := dshLaunchIdentity(p.job)
				applyRuntimeReload(p.job, resp.Content)
				applyProviderEnv(p.job, resp)
				if dshLaunchIdentity(p.job) != before {
					// Key, endpoint and file policy are fixed in the process environment: end this
					// process and Prepare again from the latest dispatch. Nothing is replayed.
					if activeID != "" {
						stopped = true
						permissions.close()
						app.fail(fmt.Errorf("dsh launch configuration changed"))
						settle(<-promptDone, true)
					}
					p.emit(evSystem, map[string]interface{}{"subtype": "reload", "reason": "launch_changed", "provider": providerDsh})
					return stCancelled, false, true
				}
				if err := app.configure(p.ctx, sessionID, p.job.Agent); err != nil {
					p.emit(evError, map[string]interface{}{"message": err.Error()})
				}
			case "diff":
				files, patches := liveDiff(p.job.WT)
				if err := p.t.diffResult(p.job.SessionID, DiffResultRequest{
					ChangedFiles: files, ChangedDiff: patches, BaseSha: p.job.WT.baseSha(),
					WorktreeDirty: worktreeIsDirty(p.job.WT), BranchMerged: branchMergedInto(p.job.WT),
					BranchSha: effectiveBranchSha(p.job.WT), WorktreeBranch: currentBranch(p.job.WT),
				}); err != nil {
					logln("diff-result failed for", p.job.SessionID+":", err)
				}
			case "shell":
				if seen[resp.TurnID] {
					continue
				}
				seen[resp.TurnID] = true
				if resp.TaskAcceptance {
					// The server-generated EXECUTABLE command is the runner's, not the engine's: it
					// waits behind the messages ahead of it and then runs in the worktree exactly as
					// every other engine runs it (runAcceptance), never through dsh or its model.
					queued = append(queued, resp)
					continue
				}
				// A person's `!` shell has no bridge in this composition (P5); the turn still reaches a terminal.
				if err := p.completeTurn(TurnCompleteRequest{TurnID: resp.TurnID, Status: stFailed, Subtype: subtypeUnknownKind,
					Result: "DeepSeek Harness sessions do not run shell turns", RuntimeSessionID: sessionID,
					BranchSha: effectiveBranchSha(p.job.WT)}); err != nil {
					logln("dsh shell refusal turn-complete failed:", err)
				}
			default:
				reportUnknownInboxKind(resp, p.job, p.completeTurn)
			}
		}
	}
}
