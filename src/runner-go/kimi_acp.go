package main

// Kimi Code runtime integration.
//
// Kimi's supported IDE/runtime surface is ACP (`kimi acp`): newline-delimited
// JSON-RPC over stdio. Driving that protocol instead of launching `kimi -p` for
// every turn preserves a real Kimi session, gives us an explicit turn boundary,
// supports cancellation, and lets Orbit inject its MCP server without writing
// project-local Kimi configuration.

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	kimiACPProtocolVersion = 1
	kimiCancelWriteTimeout = 2 * time.Second
)

type kimiRPCError struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
}

type kimiRPCMessage struct {
	ID     interface{}     `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *kimiRPCError   `json:"error,omitempty"`
}

// kimiInboundItem keeps ACP notifications and response barriers on one FIFO.
// Kimi emits transcript deltas as notifications immediately before the prompt
// response. A response must not wake its waiter until every preceding delta has
// been applied, otherwise finishTurn clears the active accumulator and loses the
// tail of the answer. A barrier has no message and is acknowledged by the single
// notification consumer.
type kimiInboundItem struct {
	message *kimiRPCMessage
	barrier chan struct{}
}

type kimiPendingRequest struct {
	id     string
	method string
	ch     chan kimiRPCMessage
}

// kimiOutbound is one entry in the ACP client's single FIFO writer. Keeping
// writes out of the session select loop means a large image prompt cannot stop
// Orbit from observing Stop or graceful shutdown while Kimi is slow to read.
// Permission responses carry a generation-checked cancelled fallback so a
// queued decision from an old turn cannot become valid again in a later turn.
type kimiOutbound struct {
	wire                 []byte
	cancelledWire        []byte
	permissionGeneration uint64
	checkPermission      bool
	ack                  chan error
}

type kimiRPCFailure struct {
	method string
	err    kimiRPCError
}

// kimiRPCErrorDataMax caps how much of a JSON-RPC error's `data` reaches the
// transcript. The useful part of an ACP failure is a sentence; the cap keeps a
// server that answers with its whole request context from flooding the session.
const kimiRPCErrorDataMax = 300

func (e *kimiRPCFailure) Error() string {
	msg := e.method + ": " + e.err.Message
	if e.err.Message == "" {
		msg = e.method + " failed"
	}
	if detail := kimiRPCErrorDetail(e.err.Data); detail != "" && detail != e.err.Message {
		return msg + " (" + clip(detail, kimiRPCErrorDataMax) + ")"
	}
	return msg
}

// kimiRPCErrorDetail renders a JSON-RPC error's `data` member as one line.
//
// `message` is by spec a short summary ("Internal error"), with the sentence that
// actually says what went wrong carried in `data` — Kimi rejects an MCP server it
// cannot identify with data.details, and dropping it left the transcript with a
// bare "session/new: Internal error" nobody could act on. Named string fields win
// because they are the human-readable part; anything else is JSON so the operator
// at least sees what the engine sent.
func kimiRPCErrorDetail(data interface{}) string {
	switch v := data.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(v)
	case map[string]interface{}:
		if len(v) == 0 {
			return ""
		}
		if s := firstString(v, "details", "detail", "message", "error", "reason", "description"); s != "" {
			return strings.TrimSpace(s)
		}
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		return ""
	}
	return string(encoded)
}

type kimiACPClient struct {
	cmd    *exec.Cmd
	cancel context.CancelFunc
	stdin  io.WriteCloser

	mu      sync.Mutex
	nextID  int64
	pending map[string]chan kimiRPCMessage
	closed  bool

	outMu     sync.Mutex
	outQueue  []kimiOutbound
	outWake   chan struct{}
	outClosed bool

	notifications chan kimiInboundItem
	done          chan struct{}
	doneOnce      sync.Once
	wg            sync.WaitGroup

	// The `thinking` levels this session's handshake advertised. Written once
	// during the handshake and read by configureSession, both on the session
	// loop — a later reload reconfigures against the same engine generation.
	thinkingOptions []string

	permissionCtx context.Context
	permission    func(context.Context, map[string]interface{}) map[string]interface{}
	permissionMu  sync.Mutex
	permissions   map[string]context.CancelFunc
	permissionOff bool
	permissionGen uint64
}

func (a *kimiACPClient) nextRequestID() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.nextID++
	return fmt.Sprintf("orbit-kimi-%d", a.nextID)
}

// queueRequest atomically registers a waiter against closeDone and appends the
// request to the writer FIFO. The returned write acknowledgement is deliberately
// separate: the main session loop can enqueue a prompt and immediately resume
// selecting inbox controls, while a later cancel is still ordered after it.
func (a *kimiACPClient) queueRequest(method string, params map[string]interface{}) (*kimiPendingRequest, <-chan error, error) {
	id := a.nextRequestID()
	ch := make(chan kimiRPCMessage, 1)
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return nil, nil, fmt.Errorf("kimi acp closed")
	}
	a.pending[id] = ch
	a.mu.Unlock()
	ack, err := a.queueWrite(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	})
	if err != nil {
		a.forget(id)
		return nil, nil, err
	}
	return &kimiPendingRequest{id: id, method: method, ch: ch}, ack, nil
}

func (a *kimiACPClient) waitRequest(ctx context.Context, pending *kimiPendingRequest) (map[string]interface{}, error) {
	select {
	case msg, ok := <-pending.ch:
		if !ok {
			return nil, fmt.Errorf("kimi acp closed")
		}
		if msg.Error != nil {
			return nil, &kimiRPCFailure{method: pending.method, err: *msg.Error}
		}
		return rawObject(msg.Result), nil
	case <-ctx.Done():
		a.forget(pending.id)
		return nil, ctx.Err()
	}
}

func (a *kimiACPClient) request(ctx context.Context, method string, params map[string]interface{}) (map[string]interface{}, error) {
	pending, writeAck, err := a.queueRequest(method, params)
	if err != nil {
		return nil, err
	}
	select {
	case err := <-writeAck:
		if err != nil {
			a.forget(pending.id)
			return nil, err
		}
	case <-ctx.Done():
		a.forget(pending.id)
		return nil, ctx.Err()
	case <-a.done:
		a.forget(pending.id)
		return nil, fmt.Errorf("kimi acp closed")
	}
	return a.waitRequest(ctx, pending)
}

func (a *kimiACPClient) notify(method string, params map[string]interface{}) error {
	ack, err := a.queueNotify(method, params)
	if err != nil {
		return err
	}
	select {
	case err := <-ack:
		return err
	case <-a.done:
		return fmt.Errorf("kimi acp closed")
	}
}

func (a *kimiACPClient) queueNotify(method string, params map[string]interface{}) (<-chan error, error) {
	return a.queueWrite(map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	})
}

func (a *kimiACPClient) forget(id string) {
	a.mu.Lock()
	delete(a.pending, id)
	a.mu.Unlock()
}

func marshalKimiWire(msg map[string]interface{}) ([]byte, error) {
	b, err := json.Marshal(msg)
	if err != nil {
		return nil, err
	}
	wire := make([]byte, len(b)+1)
	copy(wire, b)
	wire[len(b)] = '\n'
	return wire, nil
}

func (a *kimiACPClient) queueWrite(msg map[string]interface{}) (<-chan error, error) {
	wire, err := marshalKimiWire(msg)
	if err != nil {
		return nil, err
	}
	return a.enqueueOutbound(kimiOutbound{wire: wire})
}

func (a *kimiACPClient) write(msg map[string]interface{}) error {
	ack, err := a.queueWrite(msg)
	if err != nil {
		return err
	}
	select {
	case err := <-ack:
		return err
	case <-a.done:
		return fmt.Errorf("kimi acp closed")
	}
}

func (a *kimiACPClient) enqueueOutbound(item kimiOutbound) (<-chan error, error) {
	item.ack = make(chan error, 1)
	a.outMu.Lock()
	if a.outClosed {
		a.outMu.Unlock()
		return nil, fmt.Errorf("kimi acp closed")
	}
	a.outQueue = append(a.outQueue, item)
	a.outMu.Unlock()
	select {
	case a.outWake <- struct{}{}:
	default:
	}
	return item.ack, nil
}

func (a *kimiACPClient) dequeueOutbound() (kimiOutbound, bool) {
	a.outMu.Lock()
	defer a.outMu.Unlock()
	if len(a.outQueue) == 0 {
		return kimiOutbound{}, false
	}
	item := a.outQueue[0]
	a.outQueue[0] = kimiOutbound{}
	a.outQueue = a.outQueue[1:]
	return item, true
}

func (a *kimiACPClient) closeOutbound(err error) {
	a.outMu.Lock()
	if a.outClosed {
		a.outMu.Unlock()
		return
	}
	a.outClosed = true
	queued := a.outQueue
	a.outQueue = nil
	a.outMu.Unlock()
	for _, item := range queued {
		item.ack <- err
		close(item.ack)
	}
}

func (a *kimiACPClient) permissionGenerationValid(generation uint64) bool {
	a.permissionMu.Lock()
	defer a.permissionMu.Unlock()
	return !a.permissionOff && a.permissionGen == generation
}

func (a *kimiACPClient) permissionGenerationSnapshot() uint64 {
	a.permissionMu.Lock()
	defer a.permissionMu.Unlock()
	return a.permissionGen
}

func kimiCancelledPermissionResult() map[string]interface{} {
	return map[string]interface{}{"outcome": map[string]interface{}{"outcome": "cancelled"}}
}

func (a *kimiACPClient) queuePermissionResponse(id interface{}, result map[string]interface{}, generation uint64) (<-chan error, error) {
	wire, err := marshalKimiWire(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      id,
		"result":  result,
	})
	if err != nil {
		return nil, err
	}
	cancelledWire, err := marshalKimiWire(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      id,
		"result":  kimiCancelledPermissionResult(),
	})
	if err != nil {
		return nil, err
	}
	return a.enqueueOutbound(kimiOutbound{
		wire:                 wire,
		cancelledWire:        cancelledWire,
		permissionGeneration: generation,
		checkPermission:      true,
	})
}

func (a *kimiACPClient) writerLoop() {
	for {
		item, ok := a.dequeueOutbound()
		if !ok {
			select {
			case <-a.outWake:
				continue
			case <-a.done:
				return
			}
		}
		wire := item.wire
		if item.checkPermission && !a.permissionGenerationValid(item.permissionGeneration) {
			wire = item.cancelledWire
		}
		n, err := a.stdin.Write(wire)
		if err == nil && n != len(wire) {
			err = io.ErrShortWrite
		}
		item.ack <- err
		close(item.ack)
		if err != nil {
			a.cancel()
			return
		}
	}
}

func (a *kimiACPClient) readLoop(r io.Reader) {
	defer a.closeDone()
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var msg kimiRPCMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			logln("kimi acp emitted malformed JSON:", err)
			return
		}
		if msg.Method != "" && msg.ID != nil {
			// A permission decision can wait on a human for hours. Never block the
			// stdout reader: prompt updates and session/cancel must keep flowing.
			// Snapshot the turn generation here, before goroutine scheduling, so an
			// old request cannot be reclassified after a new turn opens the gate.
			generation := a.permissionGenerationSnapshot()
			a.wg.Add(1)
			go func() {
				defer a.wg.Done()
				a.handleServerRequest(msg, generation)
			}()
			continue
		}
		if msg.ID != nil {
			// All notification items already read from stdout must be applied before
			// this response is visible to its waiter. Backpressure is intentional:
			// transcript/tool terminal events are durable data and may not be dropped.
			barrier := make(chan struct{})
			select {
			case a.notifications <- kimiInboundItem{barrier: barrier}:
			case <-a.done:
				return
			}
			select {
			case <-barrier:
			case <-a.done:
				return
			}
			a.deliverResponse(msg)
			continue
		}
		if msg.Method != "" {
			copy := msg
			select {
			case a.notifications <- kimiInboundItem{message: &copy}:
			case <-a.done:
				return
			}
		}
	}
	if err := sc.Err(); err != nil {
		logln("kimi acp stdout read failed:", err)
	}
}

func (a *kimiACPClient) deliverResponse(msg kimiRPCMessage) {
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

func (a *kimiACPClient) handleServerRequest(msg kimiRPCMessage, generation uint64) {
	params := rawObject(msg.Params)
	if msg.Method == "session/request_permission" && a.permission != nil {
		base := a.permissionCtx
		if base == nil {
			base = context.Background()
		}
		ctx, cancel := context.WithCancel(base)
		key := rpcIDKey(msg.ID)
		a.permissionMu.Lock()
		blocked := a.permissionOff || generation != a.permissionGen
		if !blocked {
			if prior := a.permissions[key]; prior != nil {
				prior()
			}
			a.permissions[key] = cancel
		}
		a.permissionMu.Unlock()
		if blocked {
			cancel()
			_ = a.write(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      msg.ID,
				"result":  kimiCancelledPermissionResult(),
			})
			return
		}
		defer func() {
			cancel()
			a.permissionMu.Lock()
			if a.permissionGen == generation {
				delete(a.permissions, key)
			}
			a.permissionMu.Unlock()
		}()
		result := a.permission(ctx, params)
		if ctx.Err() != nil {
			result = kimiCancelledPermissionResult()
		}
		if ack, err := a.queuePermissionResponse(msg.ID, result, generation); err == nil {
			select {
			case <-ack:
			case <-a.done:
			}
		}
		return
	}
	_ = a.write(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      msg.ID,
		"error": map[string]interface{}{
			"code":    -32601,
			"message": "Orbit runner does not implement ACP request " + msg.Method,
		},
	})
}

// beginPermissionTurn opens the approval channel for a newly written prompt.
// cancelPermissions closes it for Stop/end/turn completion and cancels every
// reverse RPC already polling the control plane. Requests that race in after a
// Stop inherit the closed state and fail closed immediately.
func (a *kimiACPClient) beginPermissionTurn() {
	a.permissionMu.Lock()
	a.permissionGen++
	a.permissionOff = false
	a.permissionMu.Unlock()
}

func (a *kimiACPClient) cancelPermissions() {
	a.permissionMu.Lock()
	a.permissionGen++
	a.permissionOff = true
	for id, cancel := range a.permissions {
		cancel()
		delete(a.permissions, id)
	}
	a.permissionMu.Unlock()
}

func (a *kimiACPClient) closeDone() {
	a.doneOnce.Do(func() {
		// EOF makes this ACP generation unusable. Tear down stdin immediately so
		// a writer blocked on a large prompt cannot prevent the prompt waiter from
		// publishing its terminal result to the app.done branch.
		if a.cancel != nil {
			a.cancel()
		}
		if a.stdin != nil {
			_ = a.stdin.Close()
		}
		a.cancelPermissions()
		a.mu.Lock()
		a.closed = true
		for id, ch := range a.pending {
			delete(a.pending, id)
			close(ch)
		}
		a.mu.Unlock()
		a.closeOutbound(fmt.Errorf("kimi acp closed"))
		close(a.done)
	})
}

func (a *kimiACPClient) close() {
	a.cancelPermissions()
	a.cancel()
	_ = a.stdin.Close()
	_ = waitSessionProcessTree(a.cmd)
	a.closeDone()
	a.wg.Wait()
}

func startKimiACP(ctx context.Context, t *Transport, job *ClaimedSession, execDir, kimiHome string, emit emitFn) (*kimiACPClient, error) {
	procCtx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(procCtx, providerKimi, "acp")
	configureSessionProcessTree(cmd)
	cmd.Dir = execDir
	cmd.Env = envWithAgent(job.Agent.Env)
	cmd.Env = append(cmd.Env,
		"ORBIT_SESSION_ID="+publicID(job.SessionID),
		"ORBIT_AGENT_ID="+publicID(job.AgentID),
		"ORBIT_TASK_ID="+publicID(job.TaskID),
		"ORBIT_ALLOW_ORCHESTRATION="+orchestrationEnv(job.AllowOrchestration),
		envMCPPermissionPrompt+"=0",
	)
	// The session's private Kimi home (see kimi_home.go), so runner-owned
	// configuration never lands in the user's own ~/.kimi-code.
	cmd.Env = envWithValue(cmd.Env, "KIMI_CODE_HOME", kimiHome)
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
	app := &kimiACPClient{
		cmd:           cmd,
		cancel:        cancel,
		stdin:         stdin,
		pending:       map[string]chan kimiRPCMessage{},
		outWake:       make(chan struct{}, 1),
		notifications: make(chan kimiInboundItem, 256),
		done:          make(chan struct{}),
		permissionCtx: procCtx,
		permissions:   map[string]context.CancelFunc{},
		permissionOff: true,
	}
	app.permission = func(permissionCtx context.Context, params map[string]interface{}) map[string]interface{} {
		return bridgeKimiPermission(permissionCtx, t, job, params)
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		_ = stderr.Close()
		cancel()
		return nil, err
	}
	app.wg.Add(3)
	go func() {
		defer app.wg.Done()
		app.writerLoop()
	}()
	go func() {
		defer app.wg.Done()
		app.readLoop(stdout)
	}()
	go func() {
		defer app.wg.Done()
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for sc.Scan() {
			emit(evSystem, map[string]interface{}{"stderr": stripANSI(sc.Text()) + "\n"})
		}
	}()
	return app, nil
}

func (a *kimiACPClient) initialize(ctx context.Context) error {
	_, err := a.request(ctx, "initialize", map[string]interface{}{
		"protocolVersion": kimiACPProtocolVersion,
		"clientCapabilities": map[string]interface{}{
			// Kimi runs locally on the runner and can use its own filesystem
			// backend. Advertising false prevents unnecessary reverse fs RPCs.
			"fs": map[string]interface{}{
				"readTextFile":  false,
				"writeTextFile": false,
			},
		},
		"clientInfo": map[string]interface{}{
			"name":    "orbit",
			"title":   "Orbit",
			"version": "0.1.0",
		},
	})
	if err != nil {
		return err
	}
	_, err = a.request(ctx, "authenticate", map[string]interface{}{"methodId": "login"})
	return err
}

func kimiAuthMessage(err error) string {
	if failure, ok := err.(*kimiRPCFailure); ok && failure.err.Code == -32000 {
		return "Failed to authenticate: Kimi Code is signed out on this runner"
	}
	msg := err.Error()
	if strings.Contains(strings.ToLower(msg), "auth") && !isAuthError(msg) {
		return "Failed to authenticate: " + msg
	}
	return asAuthError(msg)
}

func (a *kimiACPClient) startOrResumeSession(ctx context.Context, job *ClaimedSession, execDir string) (string, error) {
	params := map[string]interface{}{
		"cwd":        execDir,
		"mcpServers": kimiMCPServers(job.Agent),
	}
	if job.RuntimeSessionID == "" {
		result, err := a.request(ctx, "session/new", params)
		if err != nil {
			return "", err
		}
		id := firstString(result, "sessionId", "session_id")
		if id == "" {
			return "", fmt.Errorf("session/new response did not include sessionId")
		}
		a.thinkingOptions = kimiConfigOptionValues(result, "thinking")
		return id, nil
	}
	params["sessionId"] = job.RuntimeSessionID
	result, err := a.request(ctx, "session/resume", params)
	if err != nil {
		return "", err
	}
	a.thinkingOptions = kimiConfigOptionValues(result, "thinking")
	return job.RuntimeSessionID, nil
}

// The values a `session/new` or `session/resume` result advertises for one
// config option's picker. Empty when the handshake does not describe it, which
// callers must read as "unknown", not as "nothing is allowed".
func kimiConfigOptionValues(result map[string]interface{}, configID string) []string {
	rows, _ := result["configOptions"].([]interface{})
	for _, row := range rows {
		option, _ := row.(map[string]interface{})
		if option == nil || firstString(option, "id") != configID {
			continue
		}
		choices, _ := option["options"].([]interface{})
		values := make([]string, 0, len(choices))
		for _, choice := range choices {
			if entry, _ := choice.(map[string]interface{}); entry != nil {
				if value := firstString(entry, "value"); value != "" {
					values = append(values, value)
				}
			}
		}
		return values
	}
	return nil
}

func kimiModeForPermission(mode string) string {
	switch mode {
	case "plan":
		return "plan"
	case "auto":
		return "auto"
	case "bypassPermissions":
		return "yolo"
	case "dontAsk":
		// Orbit's Don't Ask is fail-closed: unmatched permission prompts
		// are rejected. Kimi's `auto` is the opposite (fully autonomous),
		// so keep Kimi manual and let bridgeKimiPermission auto-reject.
		return "default"
	default:
		// Kimi has no accept-edits-only mode. Keeping it manual is safer:
		// ACP permission requests are bridged to Orbit's existing approval UI.
		return "default"
	}
}

// Kimi ACP does not currently expose its native per-session agent-file/tool-
// activation policy. Permission requests can enforce Don't Ask and pre-approved
// rules, but a denylist must also suppress tools Kimi considers safe (and hence
// never asks about). Refuse that strict configuration rather than silently run a
// disabled tool; ordinary Kimi agents have an empty denylist.
func kimiToolPolicyError(agent AgentExecConfig) string {
	for _, rule := range agent.DisallowedTools {
		if strings.TrimSpace(rule) != "" {
			return "Kimi ACP cannot enforce disallowedTools before execution yet; remove the denylist or use another runtime"
		}
	}
	return ""
}

func (a *kimiACPClient) configureSession(ctx context.Context, sessionID string, agent AgentExecConfig) error {
	setOption := func(configID, value string) (map[string]interface{}, error) {
		return a.request(ctx, "session/set_config_option", map[string]interface{}{
			"sessionId": sessionID,
			"configId":  configID,
			"value":     value,
		})
	}
	set := func(configID, value string) error {
		_, err := setOption(configID, value)
		return err
	}
	// KIMI_MODEL_* synthesizes an in-memory default alias. Setting Orbit's
	// managed model immediately afterwards would switch back to the OAuth model
	// and defeat the injected API key, so retain Kimi's environment-selected
	// default in that explicit override mode.
	if agent.Model != "" && !kimiUsesEnvModel(agent.Env) {
		result, err := setOption("model", agent.Model)
		if err != nil {
			return err
		}
		// Thinking levels are declared per model — K2.7 Coding declares none, K3
		// declares low/high/max — and this response re-describes the pickers for the
		// model just selected. The handshake's list belongs to the session's previous
		// model, so adopt this one before asking for a level.
		if levels := kimiConfigOptionValues(result, "thinking"); len(levels) > 0 {
			a.thinkingOptions = levels
		}
	}
	// `on` means the selected model's default thought level. This also gives
	// an explicit reset target when Orbit's effort picker is changed to Default.
	effort := kimiSupportedEffort(agent.Effort, a.thinkingOptions)
	if err := set("thinking", effort); err != nil {
		// Belt and braces for a handshake that described no picker: absorb the
		// rejection rather than failing the session over a tuning knob.
		if effort == "on" || !kimiRejectedEffort(err) {
			return err
		}
		logln("kimi rejected thinking effort", effort+"; falling back to the model default")
		if err := set("thinking", "on"); err != nil {
			return err
		}
	}
	return set("mode", kimiModeForPermission(agent.PermissionMode))
}

// The thinking level to ask for, given what this session's handshake advertised.
// Kimi validates the level against the current model's declared support_efforts,
// which is per-model and only knowable from the running CLI — a KIMI_MODEL_*
// provider declares none at all, so its picker offers nothing but off/on.
// Sending a level it never offered is answered with invalid_params, and the CLI
// prints that rejection to stderr, which Orbit surfaces as a failure in the
// transcript. So ask for the model's own default instead of provoking it.
func kimiSupportedEffort(effort string, advertised []string) string {
	if effort == "" {
		return "on"
	}
	// No picker described: the handshake predates config options, or this is a
	// stub. Send the request through and let the engine be the arbiter.
	if len(advertised) == 0 {
		return effort
	}
	for _, value := range advertised {
		if value == effort {
			return effort
		}
	}
	return "on"
}

// Kimi answers an unsupported thinking level with JSON-RPC invalid_params,
// raised before it reaches the engine so the session is otherwise untouched.
func kimiRejectedEffort(err error) bool {
	failure, ok := err.(*kimiRPCFailure)
	return ok && failure.err.Code == -32602
}

func kimiUsesEnvModel(env map[string]string) bool {
	return envValueWithAgentOverride(env, "KIMI_MODEL_NAME") != "" &&
		envValueWithAgentOverride(env, "KIMI_MODEL_API_KEY") != ""
}

// An MCP server reaches Kimi by one of two routes, and which route is not Orbit's to
// pick. The engine's own acpMcpServersToConfigRecord throws "does not declare a
// runtime identity" for any ACP entry without a `type`, and the stdio variant of its
// schema has no such field to set — so as of 0.38.0 a stdio server declared here fails
// session/new outright, which is the whole reason for the Kimi home overlay. It
// converts only `type` http and sse, dropping anything else with a warning, and its
// initialize result advertises exactly mcpCapabilities {http, sse}.
//
// So stdio servers move to the overlay's mcp.json (kimiMCPConfigRecord) and http/sse
// stay on ACP. Two routes rather than one, deliberately: ACP is the only route the
// engine still advertises for the transports it does accept, it is the shape already
// in use here, and moving those to the file too would be an unverified change to the
// one part of this that still works. The routes compose rather than compete — the ACP
// list becomes a per-session overlay merged over the file-declared servers by name
// (MergedMcpConnectionView), so file entries survive, and no name is ever put on both
// routes anyway.
func kimiMCPServers(agent AgentExecConfig) []map[string]interface{} {
	names := make([]string, 0, len(agent.McpConfig))
	for name := range agent.McpConfig {
		names = append(names, name)
	}
	sort.Strings(names)
	servers := make([]map[string]interface{}, 0, len(names))
	for _, name := range names {
		if converted := kimiMCPServer(name, agent.McpConfig[name]); converted != nil {
			servers = append(servers, converted)
		}
	}
	return servers
}

func kimiMCPServer(name string, value interface{}) map[string]interface{} {
	m := mapValue(value)
	if m == nil || strings.TrimSpace(name) == "" {
		return nil
	}
	// Command first, matching kimiMCPConfigEntry, so an entry naming both a command
	// and a url lands on exactly one route rather than being started twice.
	if firstString(m, "command") != "" {
		return nil
	}
	url := firstString(m, "url")
	if url == "" {
		return nil
	}
	typ := strings.ToLower(firstString(m, "type", "transport"))
	if typ != "sse" {
		typ = "http"
	}
	return map[string]interface{}{
		"name":    name,
		"type":    typ,
		"url":     url,
		"headers": kimiNameValuePairs(m["headers"]),
	}
}

// kimiMCPConfigRecord is the mcpServers body of the overlay home's mcp.json: every
// stdio server, keyed by name rather than listed. Orbit's own MCP server is always
// among them.
func kimiMCPConfigRecord(agent AgentExecConfig, orbitExe string) map[string]interface{} {
	servers := map[string]interface{}{}
	for name, value := range agent.McpConfig {
		if entry := kimiMCPConfigEntry(name, value); entry != nil {
			servers[name] = entry
		}
	}
	if orbitExe != "" {
		servers["orbit"] = map[string]interface{}{
			"command": orbitExe,
			"args":    []string{"mcp"},
			// Empty on purpose. `orbit mcp` reads the session it belongs to from
			// ORBIT_SESSION_ID and friends, which it inherits through kimi from the
			// env startKimiACP sets. Writing the ids here would pin this session's
			// identity into a file instead.
			"env": map[string]string{},
		}
	}
	return servers
}

func kimiMCPConfigEntry(name string, value interface{}) map[string]interface{} {
	m := mapValue(value)
	if m == nil || strings.TrimSpace(name) == "" {
		return nil
	}
	command := firstString(m, "command")
	if command == "" {
		return nil
	}
	return map[string]interface{}{
		"command": command,
		"args":    stringSlice(m["args"]),
		"env":     kimiStringMap(m["env"]),
	}
}

func stringSlice(value interface{}) []string {
	switch values := value.(type) {
	case []string:
		return append([]string(nil), values...)
	case []interface{}:
		out := make([]string, 0, len(values))
		for _, value := range values {
			if s, ok := value.(string); ok {
				out = append(out, s)
			}
		}
		return out
	default:
		return []string{}
	}
}

// kimiStringMap is kimiNameValuePairs' counterpart for the config file, which spells
// env and headers as an object where ACP wants a [{name,value}] array. Both start from
// the same source shapes, so normalize once and fold.
func kimiStringMap(value interface{}) map[string]string {
	out := map[string]string{}
	for _, pair := range kimiNameValuePairs(value) {
		out[pair["name"]] = pair["value"]
	}
	return out
}

func kimiNameValuePairs(value interface{}) []map[string]string {
	pairs := []map[string]string{}
	switch values := value.(type) {
	case map[string]string:
		keys := make([]string, 0, len(values))
		for key := range values {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			pairs = append(pairs, map[string]string{"name": key, "value": values[key]})
		}
	case map[string]interface{}:
		keys := make([]string, 0, len(values))
		for key := range values {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			pairs = append(pairs, map[string]string{"name": key, "value": asString(values[key])})
		}
	case []interface{}:
		for _, value := range values {
			row := mapValue(value)
			if row != nil && firstString(row, "name") != "" {
				pairs = append(pairs, map[string]string{
					"name":  firstString(row, "name"),
					"value": firstString(row, "value"),
				})
			}
		}
	}
	return pairs
}

func kimiAgentInstructions(agent AgentExecConfig, orbitExe string) string {
	parts := []string{}
	if strings.TrimSpace(agent.SystemPrompt) != "" {
		parts = append(parts, agent.SystemPrompt)
	}
	if appendPrompt := strings.TrimSpace(withOrbitCLIInstructions(agent.AppendSystemPrompt, orbitExe)); appendPrompt != "" {
		parts = append(parts, appendPrompt)
	}
	if len(agent.AllowedTools) > 0 {
		parts = append(parts, "Only use these tools when their Kimi equivalents are available: "+strings.Join(agent.AllowedTools, ", ")+".")
	}
	if len(agent.DisallowedTools) > 0 {
		parts = append(parts, "Do not use these tools: "+strings.Join(agent.DisallowedTools, ", ")+".")
	}
	return strings.Join(parts, "\n\n")
}

func kimiPromptText(agent AgentExecConfig, orbitExe, text string) string {
	instructions := kimiAgentInstructions(agent, orbitExe)
	if instructions == "" {
		return text
	}
	return "<orbit-agent-instructions>\n" + instructions + "\n</orbit-agent-instructions>\n\n" + text
}

type kimiPreparedPrompt struct {
	blocks []map[string]interface{}
	refs   []map[string]interface{}
}

func prepareKimiPrompt(ctx context.Context, t *Transport, job *ClaimedSession, resp *RunInboxResponse, pendingShellCtx []string) kimiPreparedPrompt {
	blocks := []map[string]interface{}{}
	refs := []map[string]interface{}{}
	writtenPaths := []string{}
	for _, att := range resp.Attachments {
		data, err := t.fetchAttachment(ctx, job.SessionID, att.ID)
		if err != nil {
			logln("attachment fetch failed for", job.SessionID, att.ID+":", err)
			continue
		}
		if att.MimeType == "image/png" || att.MimeType == "image/jpeg" ||
			att.MimeType == "image/webp" || att.MimeType == "image/gif" {
			blocks = append(blocks, map[string]interface{}{
				"type":     "image",
				"data":     base64.StdEncoding.EncodeToString(data),
				"mimeType": att.MimeType,
			})
		} else {
			path, writeErr := writeUpload(job.SessionID, att.FileName, att.ID, data)
			if writeErr != nil {
				logln("attachment write failed for", job.SessionID, att.ID+":", writeErr)
				continue
			}
			writtenPaths = append(writtenPaths, path)
		}
		refs = append(refs, map[string]interface{}{"id": att.ID, "mime": att.MimeType, "name": att.FileName})
	}
	feedText := resp.Content
	if len(pendingShellCtx) > 0 {
		feedText = strings.Join(pendingShellCtx, "\n") + "\n\n" + feedText
	}
	if len(writtenPaths) > 0 {
		note := fmt.Sprintf("[The user uploaded %d file(s), saved at: %s - read or process them with your tools as needed.]",
			len(writtenPaths), strings.Join(writtenPaths, ", "))
		if feedText != "" {
			feedText = note + "\n\n" + feedText
		} else {
			feedText = note
		}
	}
	feedText = kimiPromptText(job.Agent, orbitCLIExecutable(), feedText)
	if feedText != "" || len(blocks) == 0 {
		blocks = append(blocks, map[string]interface{}{"type": "text", "text": feedText})
	}
	return kimiPreparedPrompt{blocks: blocks, refs: refs}
}

type kimiActiveTurn struct {
	orbitTurnID string
	text        strings.Builder
	thought     strings.Builder
	seenTools   map[string]bool
	doneTools   map[string]bool
	plans       int // plan updates seen this turn; makes each one a distinct tool id
	// Context-window occupancy as Kimi last reported it this turn, and the window it is a
	// fraction of (usage_update). Read out on turn_end, and mid-turn by the pinger.
	contextTokens int
	contextWindow int
}

func kimiContentText(value interface{}) string {
	content := mapValue(value)
	if content != nil && firstString(content, "type") == "text" {
		return firstString(content, "text")
	}
	return ""
}

func kimiToolOutput(update map[string]interface{}) string {
	if raw, ok := update["rawOutput"].(string); ok {
		return raw
	}
	if raw, ok := update["raw_output"].(string); ok {
		return raw
	}
	var texts []string
	if rows, ok := update["content"].([]interface{}); ok {
		for _, rowValue := range rows {
			row := mapValue(rowValue)
			if row == nil {
				continue
			}
			if text := kimiContentText(row["content"]); text != "" {
				texts = append(texts, text)
			}
		}
	}
	if len(texts) > 0 {
		return strings.Join(texts, "\n")
	}
	if raw := firstPresent(update, "rawOutput", "raw_output"); raw != nil {
		if b, err := json.Marshal(raw); err == nil {
			return string(b)
		}
	}
	return ""
}

func learnKimiCommands(update map[string]interface{}) {
	rows, _ := update["availableCommands"].([]interface{})
	commands := make([]string, 0, len(rows))
	for _, rowValue := range rows {
		row := mapValue(rowValue)
		if name := firstString(row, "name"); name != "" {
			commands = append(commands, name)
		}
	}
	slashReg.learnFor(providerKimi, commands, nil)
}

// withKimiContextWindow attaches the gauge's denominator, preferring the one Kimi reports beside
// each reading (usage_update's `size`) over the catalog's entry for the configured model id: it
// moves with the model the session is actually on — 262144 on K2.7, 1048576 on K3 — and is right
// without waiting for a catalog refresh. 0 means Kimi said nothing, and the catalog answers.
func withKimiContextWindow(payload map[string]interface{}, job *ClaimedSession, window int) map[string]interface{} {
	if window > 0 {
		payload["contextWindow"] = window
		return payload
	}
	return withContextWindow(payload, job)
}

// kimiTurnEndPayload closes the turn with the gauge's last reading: the occupancy Kimi reported
// during it, over the window Kimi named beside it. Kimi bills no cost and runs one ACP prompt per
// Orbit turn, so the other two are constants.
func kimiTurnEndPayload(turn *kimiActiveTurn, subtype string, job *ClaimedSession) map[string]interface{} {
	return withKimiContextWindow(map[string]interface{}{
		"subtype":       subtype,
		"numTurns":      1,
		"costUsd":       0,
		"contextTokens": turn.contextTokens,
	}, job, turn.contextWindow)
}

func handleKimiNotification(sessionID string, msg kimiRPCMessage, emit emitFn, activeMu *sync.Mutex, active **kimiActiveTurn) {
	if msg.Method != "session/update" {
		return
	}
	params := rawObject(msg.Params)
	if id := firstString(params, "sessionId", "session_id"); sessionID != "" && id != "" && id != sessionID {
		return
	}
	update := mapValue(params["update"])
	if update == nil {
		return
	}
	kind := firstString(update, "sessionUpdate", "session_update")
	if kind == "available_commands_update" {
		learnKimiCommands(update)
		return
	}
	activeMu.Lock()
	defer activeMu.Unlock()
	if *active == nil {
		return
	}
	a := *active
	switch kind {
	case "agent_message_chunk":
		if text := kimiContentText(update["content"]); text != "" {
			a.text.WriteString(text)
			emit(evTextDelta, map[string]interface{}{"text": text})
		}
	case "agent_thought_chunk":
		if text := kimiContentText(update["content"]); text != "" {
			a.thought.WriteString(text)
			emit(evThinkingDelta, map[string]interface{}{"text": text})
		}
	case "tool_call":
		id := firstString(update, "toolCallId", "tool_call_id")
		if id != "" && !a.seenTools[id] {
			a.seenTools[id] = true
			emit(evToolUse, map[string]interface{}{
				"id":    id,
				"name":  firstString(update, "title"),
				"input": firstPresent(update, "rawInput", "raw_input"),
			})
		}
	case "tool_call_update":
		status := strings.ToLower(firstString(update, "status"))
		id := firstString(update, "toolCallId", "tool_call_id")
		if id != "" && (status == "completed" || status == "failed") && !a.doneTools[id] {
			a.doneTools[id] = true
			emit(evToolResult, map[string]interface{}{
				"toolUseId": id,
				"content":   kimiToolOutput(update),
				"isError":   status == "failed",
			})
		}
	// ACP delivers Kimi's scratch checklist as a plan update rather than a tool call,
	// and Orbit rendered none of it. See plan_events.go. Each update replaces the whole
	// plan, so it gets its own id: successive versions are separate cards, not one card
	// whose result keeps being overwritten.
	case "plan":
		rows := planEntries(update)
		if len(rows) == 0 {
			return
		}
		a.plans++
		id := fmt.Sprintf("kimi-plan-%d", a.plans)
		emit(evToolUse, map[string]interface{}{
			"id":    id,
			"name":  "plan",
			"input": map[string]interface{}{"entries": rows},
		})
		emit(evToolResult, map[string]interface{}{
			"toolUseId": id,
			"content":   planChecklist(rows),
			"isError":   false,
		})
	// Kimi reports occupancy and the window it is a fraction of on every turn. Dropped here,
	// both halves of the gauge were missing and every Kimi session read 0%.
	case "usage_update":
		if used := toInt(update["used"]); used > 0 {
			a.contextTokens = used
		}
		if size := toInt(update["size"]); size > 0 {
			a.contextWindow = size
		}
	default:
		// user_message_chunk is Orbit's own prompt echoed back, and mode changes have no
		// transcript representation by design; config_option_update and session_info_update
		// describe the session rather than its content. None is a gap worth reporting.
		logUnhandledStreamKind("kimi", kind, "user_message_chunk", "current_mode_update",
			"config_option_update", "session_info_update")
	}
}

type kimiPromptResult struct {
	turnID string
	result map[string]interface{}
	err    error
}

func runKimiSessionProcess(ctx context.Context, shutdownCtx context.Context, t *Transport, job *ClaimedSession, leaseGeneration, execDir, scratchDir string, emit emitFn, emitFor emitTurnFn, setTurn func(string), _ bool, bg *bgTailer, completeTurn turnCompleter, waitTurnPermit turnPermitWaiter, onLeaseLost leaseLossHandler) (string, bool, bool) {
	setTurn("")
	if err := guardKimiProjectMCP(execDir); err != nil {
		emit(evError, map[string]interface{}{"message": err.Error()})
		return stFailed, true, false
	}
	if msg := kimiToolPolicyError(job.Agent); msg != "" {
		emit(evError, map[string]interface{}{"message": msg})
		return stFailed, true, false
	}
	realHome, err := effectiveKimiHome(envWithAgent(job.Agent.Env), execDir)
	if err != nil {
		emit(evError, map[string]interface{}{"message": "failed to resolve the Kimi home directory: " + err.Error()})
		return stFailed, true, false
	}
	kimiHome, err := prepareKimiHomeOverlay(scratchDir, realHome)
	if err != nil {
		emit(evError, map[string]interface{}{"message": "failed to prepare the private Kimi home: " + err.Error()})
		return stFailed, true, false
	}
	// Registered before the spawn so a failed start is cleaned up too. Defers run
	// LIFO, so the overlay outlives the process it belongs to.
	defer func() { _ = removeKimiHomeOverlay(kimiHome) }()
	if err := writeKimiHomeMCPConfig(kimiHome, kimiMCPConfigRecord(job.Agent, orbitCLIExecutable())); err != nil {
		emit(evError, map[string]interface{}{"message": "failed to write the Kimi MCP configuration: " + err.Error()})
		return stFailed, true, false
	}

	app, err := startKimiACP(ctx, t, job, execDir, kimiHome, emit)
	if err != nil {
		emit(evError, map[string]interface{}{"message": "failed to spawn kimi acp: " + err.Error()})
		return stFailed, true, false
	}
	defer app.close()

	var activeMu sync.Mutex
	var active *kimiActiveTurn
	var expectedSessionID atomic.Value
	expectedSessionID.Store("")
	// Consume from process start, including initialize/session-new. Responses
	// carry FIFO barriers, so this single consumer is the ordering authority for
	// every notification that precedes them on Kimi's stdout.
	app.wg.Add(1)
	go func() {
		defer app.wg.Done()
		// Kimi reports usage mid-turn; a tool-heavy turn is many minutes from its turn_end, so
		// move the gauge as the reading moves instead of leaving it empty until then.
		var ctxPing contextPinger
		process := func(item kimiInboundItem) {
			if item.barrier != nil {
				close(item.barrier)
				return
			}
			if item.message != nil {
				handleKimiNotification(expectedSessionID.Load().(string), *item.message, emit, &activeMu, &active)
				activeMu.Lock()
				tokens, window := 0, 0
				if active != nil {
					tokens, window = active.contextTokens, active.contextWindow
				}
				activeMu.Unlock()
				ctxPing.ping(func(eventType string, payload map[string]interface{}) {
					emit(eventType, withKimiContextWindow(payload, job, window))
				}, tokens, job)
			}
		}
		for {
			select {
			case <-ctx.Done():
				return
			case <-app.done:
				// readLoop closes done only after EOF, so no producer remains. Drain
				// every queued tail event before this engine generation can return.
				for {
					select {
					case item := <-app.notifications:
						process(item)
					default:
						return
					}
				}
			case item := <-app.notifications:
				process(item)
			}
		}
	}()

	if err := app.initialize(ctx); err != nil {
		emit(evError, map[string]interface{}{"message": kimiAuthMessage(err)})
		return stFailed, true, false
	}
	sessionID, err := app.startOrResumeSession(ctx, job, execDir)
	if err != nil {
		emit(evError, map[string]interface{}{"message": kimiAuthMessage(err)})
		return stFailed, true, false
	}
	job.RuntimeSessionID = sessionID
	expectedSessionID.Store(sessionID)
	writeSessionMeta(scratchDir, job, execDir)
	if err := app.configureSession(ctx, sessionID, job.Agent); err != nil {
		emit(evError, map[string]interface{}{"message": "failed to configure Kimi session: " + err.Error()})
		return stFailed, true, false
	}
	emit(evSystem, map[string]interface{}{
		"subtype":   "init",
		"sessionId": sessionID,
		"provider":  providerKimi,
		"runtime":   "acp",
	})
	pollCtx, pollCancel := context.WithCancel(ctx)
	defer pollCancel()
	inboxCh := make(chan *RunInboxResponse, 8)
	app.wg.Add(1)
	go func() {
		defer app.wg.Done()
		for pollCtx.Err() == nil {
			resp, pollErr := t.inbox(pollCtx, job.SessionID, leaseGeneration)
			if pollErr != nil {
				if pollCtx.Err() != nil {
					return
				}
				if isLeaseOwnershipError(pollErr) {
					onLeaseLost(pollErr)
					return
				}
				logln("inbox poll failed for", job.SessionID+":", pollErr)
				select {
				case <-time.After(time.Second):
				case <-pollCtx.Done():
					return
				}
				continue
			}
			if resp == nil {
				continue
			}
			select {
			case inboxCh <- resp:
			case <-pollCtx.Done():
				return
			}
		}
	}()

	promptDone := make(chan kimiPromptResult, 1)
	inflight := map[string]bool{}
	var pendingShellCtx []string
	draining := false
	var drainTimer <-chan time.Time
	shutdownDone := shutdownCtx.Done()
	interruptRequested := false

	finishTurn := func(done kimiPromptResult) {
		activeMu.Lock()
		if active == nil || active.orbitTurnID != done.turnID {
			activeMu.Unlock()
			return
		}
		turn := active
		active = nil
		activeMu.Unlock()
		app.cancelPermissions()

		status, subtype := stSucceeded, "completed"
		resultText := strings.TrimSpace(turn.text.String())
		if done.err != nil {
			status, subtype = stFailed, "error"
			resultText = done.err.Error()
			emit(evError, map[string]interface{}{"message": resultText})
		} else {
			switch strings.ToLower(firstString(done.result, "stopReason", "stop_reason")) {
			case "cancelled":
				status, subtype = stInterrupted, "interrupted"
			case "refusal":
				status, subtype = stFailed, "refusal"
			}
		}
		if thought := strings.TrimSpace(turn.thought.String()); thought != "" {
			emit(evThinking, map[string]interface{}{"text": thought})
		}
		if text := strings.TrimSpace(turn.text.String()); text != "" {
			emit(evAssistant, map[string]interface{}{"text": text})
		}
		emit(evTurnEnd, kimiTurnEndPayload(turn, subtype, job))
		liveFiles, livePatches := liveDiff(job.WT)
		if completeErr := completeTurn(TurnCompleteRequest{
			TurnID:           done.turnID,
			Status:           status,
			Result:           resultText,
			Subtype:          subtype,
			NumTurns:         1,
			RuntimeSessionID: sessionID,
			IsolationStatus:  job.IsolationStatus,
			ChangedFiles:     liveFiles,
			ChangedDiff:      livePatches,
			WorktreeDirty:    worktreeIsDirty(job.WT),
			BranchSha:        effectiveBranchSha(job.WT),
			BranchMerged:     branchMergedInto(job.WT),
			WorktreeBranch:   currentBranch(job.WT),
		}); completeErr != nil {
			logln("turn-complete failed for", job.SessionID+":", completeErr)
		}
		delete(inflight, done.turnID)
		setTurn("")
	}

	for {
		select {
		case <-ctx.Done():
			app.cancelPermissions()
			return stCancelled, true, false
		case <-shutdownDone:
			if !draining {
				draining = true
				shutdownDone = nil
				pollCancel()
				drainTimer = time.After(shutdownDrainTimeout)
				activeMu.Lock()
				idle := active == nil
				activeMu.Unlock()
				if idle {
					return stCancelled, true, false
				}
			}
		case <-drainTimer:
			app.cancelPermissions()
			return stCancelled, true, false
		case <-app.done:
			if ctx.Err() != nil || shutdownCtx.Err() != nil {
				return stCancelled, true, false
			}
			// closeDone atomically closes every pending response channel before
			// done. An active prompt waiter therefore has exactly one terminal
			// result to publish; wait for it instead of using a scheduling timeout
			// that could replay an already side-effecting turn.
			activeMu.Lock()
			hadActiveTurn := active != nil
			activeMu.Unlock()
			if hadActiveTurn {
				select {
				case done := <-promptDone:
					if interruptRequested {
						done.err = nil
						done.result = map[string]interface{}{"stopReason": "cancelled"}
						finishTurn(done)
					} else if done.err == nil || !strings.Contains(done.err.Error(), "kimi acp closed") {
						finishTurn(done)
					}
				case <-ctx.Done():
					return stCancelled, true, false
				case <-shutdownCtx.Done():
					return stCancelled, true, false
				}
			}
			return stFailed, false, false
		case done := <-promptDone:
			if interruptRequested {
				done.err = nil
				done.result = map[string]interface{}{"stopReason": "cancelled"}
			}
			finishTurn(done)
			interruptRequested = false
			if draining {
				return stCancelled, true, false
			}
		case resp := <-inboxCh:
			if draining || resp == nil {
				continue
			}
			switch resp.Kind {
			case "steer":
				// A message meant to join the turn already running. This engine's turn call is
				// outstanding until the turn ends, so there is nothing to hand it to — refuse it
				// where the sender can see it rather than let a leased turn go quiet.
				refuseUnsupportedSteer(resp.TurnID, resp.Content, providerKimi, job, emitFor, completeTurn)

			case "message":
				if !waitTurnPermit(ctx) {
					return stCancelled, true, false
				}
				setTurn(resp.TurnID)
				if inflight[resp.TurnID] {
					continue
				}
				activeMu.Lock()
				busy := active != nil
				if !busy {
					active = &kimiActiveTurn{
						orbitTurnID: resp.TurnID,
						seenTools:   map[string]bool{},
						doneTools:   map[string]bool{},
					}
				}
				activeMu.Unlock()
				if busy {
					emit(evError, map[string]interface{}{"message": "Kimi already has an active turn"})
					setTurn("")
					continue
				}
				inflight[resp.TurnID] = true
				prepared := prepareKimiPrompt(ctx, t, job, resp, pendingShellCtx)
				pendingShellCtx = nil
				userEvent := map[string]interface{}{"text": resp.Content}
				if len(prepared.refs) > 0 {
					userEvent["attachments"] = prepared.refs
				}
				emit(evUser, userEvent)
				turnID := resp.TurnID
				interruptRequested = false
				app.beginPermissionTurn()
				pending, writeAck, promptErr := app.queueRequest("session/prompt", map[string]interface{}{
					"sessionId": sessionID,
					"prompt":    prepared.blocks,
				})
				if promptErr != nil {
					promptDone <- kimiPromptResult{turnID: turnID, err: promptErr}
					continue
				}
				app.wg.Add(1)
				go func() {
					defer app.wg.Done()
					var result map[string]interface{}
					var waitErr error
					select {
					case waitErr = <-writeAck:
						if waitErr == nil {
							result, waitErr = app.waitRequest(ctx, pending)
						} else {
							app.forget(pending.id)
						}
					case <-app.done:
						app.forget(pending.id)
						waitErr = fmt.Errorf("kimi acp closed")
					case <-ctx.Done():
						app.forget(pending.id)
						waitErr = ctx.Err()
					}
					select {
					case promptDone <- kimiPromptResult{turnID: turnID, result: result, err: waitErr}:
					case <-ctx.Done():
					}
				}()

			case "shell":
				if !waitTurnPermit(ctx) {
					return stCancelled, true, false
				}
				if inflight[resp.TurnID] {
					continue
				}
				inflight[resp.TurnID] = true
				setTurn(resp.TurnID)
				if shellCommand, background := splitBackground(resp.Content); background {
					runShellTurnBackground(bg, execDir, scratchDir, shellCommand, resp.TurnID, emit, job.Agent.Env)
					if err := completeTurn(TurnCompleteRequest{
						TurnID: resp.TurnID, Status: stSucceeded, Result: "started in background", Subtype: "shell",
						RuntimeSessionID: sessionID, BranchSha: effectiveBranchSha(job.WT),
					}); err != nil {
						logln("shell turn-complete failed for", job.SessionID+":", err)
					}
				} else {
					output, exitCode := runShellTurn(ctx, execDir, resp.Content, emit, resp.TurnID, job.Agent.Env)
					pendingShellCtx = append(pendingShellCtx,
						fmt.Sprintf("<bash-input>%s</bash-input>\n<bash-stdout>%s</bash-stdout>", resp.Content, output))
					if err := completeTurn(TurnCompleteRequest{
						TurnID: resp.TurnID, Status: stSucceeded, Result: fmt.Sprintf("exit %d", exitCode), Subtype: "shell",
						RuntimeSessionID: sessionID, BranchSha: effectiveBranchSha(job.WT),
					}); err != nil {
						logln("shell turn-complete failed for", job.SessionID+":", err)
					}
				}
				delete(inflight, resp.TurnID)
				setTurn("")

			case "interrupt":
				emit(evInterrupt, map[string]interface{}{})
				interruptRequested = true
				app.cancelPermissions()
				ack, cancelErr := app.queueNotify("session/cancel", map[string]interface{}{"sessionId": sessionID})
				if cancelErr != nil {
					app.cancel()
				} else {
					// A wedged child may stop reading midway through a large prompt. The
					// FIFO preserves prompt->cancel order; this watchdog bounds the wait
					// and recycles the engine if those bytes cannot be delivered.
					app.wg.Add(1)
					go func() {
						defer app.wg.Done()
						select {
						case err := <-ack:
							if err != nil {
								app.cancel()
							}
						case <-time.After(kimiCancelWriteTimeout):
							app.cancel()
						case <-app.done:
						}
					}()
				}

			case "reload":
				applyRuntimeReload(job, resp.Content)
				if applyProviderEnv(job, resp) {
					// KIMI_MODEL_* is read when the CLI starts — it is what makes the ACP
					// process talk to this provider at all — so a switch cannot be
					// reconfigured into the running session. Re-spawn instead; the ACP
					// session id is on the job and the conversation resumes with it.
					return stCancelled, false, true
				}
				if err := app.configureSession(ctx, sessionID, job.Agent); err != nil {
					emit(evError, map[string]interface{}{"message": "failed to reconfigure Kimi session: " + err.Error()})
				} else {
					emit(evSystem, map[string]interface{}{
						"subtype": "resumed", "reason": "config_changed", "runtime": "acp",
					})
				}

			case "diff":
				liveFiles, livePatches := liveDiff(job.WT)
				if err := t.diffResult(job.SessionID, DiffResultRequest{
					ChangedFiles: liveFiles, ChangedDiff: livePatches,
					WorktreeDirty: worktreeIsDirty(job.WT), BranchMerged: branchMergedInto(job.WT),
					BranchSha: effectiveBranchSha(job.WT), WorktreeBranch: currentBranch(job.WT),
				}); err != nil {
					logln("diff-result failed for", job.SessionID+":", err)
				}

			case "end":
				app.cancelPermissions()
				return stSucceeded, true, false
			}
		}
	}
}

func bridgeKimiPermission(ctx context.Context, t *Transport, job *ClaimedSession, params map[string]interface{}) map[string]interface{} {
	if ctx.Err() != nil {
		return kimiCancelledPermissionResult()
	}
	toolCall := mapValue(params["toolCall"])
	if toolCall == nil {
		toolCall = mapValue(params["tool_call"])
	}
	options, _ := params["options"].([]interface{})
	toolName := firstString(toolCall, "title")
	toolUseID := firstString(toolCall, "toolCallId", "tool_call_id")
	input := firstPresent(toolCall, "rawInput", "raw_input")
	if input == nil {
		input = toolCall
	}
	question, questionOptions := kimiQuestionFromPermission(toolCall, options)
	if question != "" && len(questionOptions) > 0 {
		toolName = "AskUserQuestion"
		input = map[string]interface{}{
			"questions": []map[string]interface{}{{
				"question": question,
				"options":  questionOptions,
			}},
		}
	}
	if ctx.Err() != nil {
		return kimiCancelledPermissionResult()
	}
	if optionID, decided := kimiAutomaticPermissionOption(job, toolName, input, options, question); decided {
		if ctx.Err() != nil {
			return kimiCancelledPermissionResult()
		}
		if optionID == "" {
			return kimiCancelledPermissionResult()
		}
		return map[string]interface{}{
			"outcome": map[string]interface{}{"outcome": "selected", "optionId": optionID},
		}
	}
	approvalID, err := t.createApproval(ctx, job.SessionID, map[string]interface{}{
		"toolName":  toolName,
		"input":     input,
		"toolUseId": toolUseID,
	})
	if err != nil {
		return kimiCancelledPermissionResult()
	}
	for {
		if ctx.Err() != nil {
			return kimiCancelledPermissionResult()
		}
		decision, pollErr := t.pollApproval(ctx, job.SessionID, approvalID)
		if pollErr != nil {
			return kimiCancelledPermissionResult()
		}
		if decision.Status == "PENDING" {
			continue
		}
		optionID := kimiPermissionOption(options, decision, question)
		if optionID == "" {
			return kimiCancelledPermissionResult()
		}
		return map[string]interface{}{
			"outcome": map[string]interface{}{"outcome": "selected", "optionId": optionID},
		}
	}
}

// kimiAutomaticPermissionOption applies Orbit's non-interactive policy before
// creating a UI approval. Questions and plan choices always reach the user.
// Explicit deny rules win, explicit allow rules are one-shot approved, Accept
// Edits approves Kimi's file mutation tools, and Don't Ask rejects every other
// permission prompt. The second return value distinguishes "ask the user"
// from a fail-closed decision when Kimi supplies no matching reject option.
func kimiAutomaticPermissionOption(job *ClaimedSession, toolName string, input interface{}, options []interface{}, question string) (string, bool) {
	if job == nil || question != "" {
		return "", false
	}
	selectDecision := func(allowed bool) (string, bool) {
		status := "DENIED"
		if allowed {
			status = "ALLOWED"
		}
		return kimiPermissionOption(options, &ApprovalDecisionResponse{Status: status}, ""), true
	}
	for _, rule := range job.Agent.DisallowedTools {
		if kimiToolMatchesRule(rule, toolName, input) {
			return selectDecision(false)
		}
	}
	allowed := appendUnique(job.Agent.AllowedTools,
		orbitCLIAllowedTools(
			orbitCLIPermissionExecutable(orbitCLIExecutable()),
			job.AllowOrchestration && strings.TrimSpace(job.OrchestrationToken) != "",
		)...)
	for _, rule := range allowed {
		if kimiToolMatchesRule(rule, toolName, input) {
			return selectDecision(true)
		}
	}
	if job.Agent.PermissionMode == "acceptEdits" && (toolName == "Edit" || toolName == "Write") {
		return selectDecision(true)
	}
	if job.Agent.PermissionMode == "dontAsk" {
		return selectDecision(false)
	}
	return "", false
}

// kimiToolMatchesRule recognizes the conservative subset shared by Orbit's
// configured rules and the rules it generates itself: exact tool names,
// trailing-star tool globs (`mcp__orbit__*`), and non-shell Tool(subject) forms.
// Shell subjects are never auto-approved: matching their raw command prefix
// cannot prove that a suffix contains no operator, redirection, or substitution.
// Anything more exotic fails closed.
func kimiToolMatchesRule(rule, toolName string, input interface{}) bool {
	rule = strings.TrimSpace(rule)
	if rule == "" || toolName == "" {
		return false
	}
	if open := strings.IndexByte(rule, '('); open >= 0 && strings.HasSuffix(rule, ")") {
		if strings.TrimSpace(rule[:open]) != toolName {
			return false
		}
		if toolName == "Bash" || toolName == "Terminal" {
			return false
		}
		pattern := strings.TrimSpace(rule[open+1 : len(rule)-1])
		return kimiRuleValueMatches(pattern, kimiToolRuleSubject(toolName, input))
	}
	return kimiRuleValueMatches(rule, toolName)
}

func kimiRuleValueMatches(pattern, value string) bool {
	if pattern == value {
		return true
	}
	if strings.HasSuffix(pattern, "*") && !strings.Contains(pattern[:len(pattern)-1], "*") {
		return strings.HasPrefix(value, strings.TrimSuffix(pattern, "*"))
	}
	return false
}

func kimiToolRuleSubject(toolName string, input interface{}) string {
	m := mapValue(input)
	if m == nil {
		return ""
	}
	if toolName == "Bash" || toolName == "Terminal" {
		return firstString(m, "command", "cmd")
	}
	return firstString(m, "path", "file_path", "filePath", "url", "query")
}

func kimiQuestionFromPermission(toolCall map[string]interface{}, options []interface{}) (string, []map[string]interface{}) {
	var question string
	if rows, ok := toolCall["content"].([]interface{}); ok {
		for _, rowValue := range rows {
			row := mapValue(rowValue)
			if text := kimiContentText(row["content"]); text != "" {
				question = text
				break
			}
		}
	}
	questionOptions := []map[string]interface{}{}
	for _, optionValue := range options {
		option := mapValue(optionValue)
		id := firstString(option, "optionId", "option_id")
		if option == nil || (!strings.HasPrefix(id, "q0_opt_") && !strings.HasPrefix(id, "plan_")) {
			continue
		}
		questionOptions = append(questionOptions, map[string]interface{}{
			"label": firstString(option, "name"),
		})
	}
	if len(questionOptions) == 0 {
		return "", nil
	}
	return question, questionOptions
}

func kimiPermissionOption(options []interface{}, decision *ApprovalDecisionResponse, question string) string {
	if decision == nil {
		return ""
	}
	if decision.Status == "ALLOWED" && question != "" {
		labels := decision.Answers[question]
		if len(labels) > 0 {
			for _, optionValue := range options {
				option := mapValue(optionValue)
				if firstString(option, "name") == labels[0] {
					return firstString(option, "optionId", "option_id")
				}
			}
		}
	}
	wantAllow := decision.Status == "ALLOWED"
	wantAlways := wantAllow && len(decision.resolveRememberRules()) > 0
	var fallback string
	for _, optionValue := range options {
		option := mapValue(optionValue)
		id := firstString(option, "optionId", "option_id")
		kind := strings.ToLower(firstString(option, "kind"))
		if id == "" {
			continue
		}
		if wantAllow && strings.HasPrefix(kind, "allow_") {
			if fallback == "" {
				fallback = id
			}
			if (wantAlways && kind == "allow_always") || (!wantAlways && kind == "allow_once") {
				return id
			}
		}
		if !wantAllow && strings.HasPrefix(kind, "reject_") {
			if fallback == "" {
				fallback = id
			}
			if kind == "reject_once" {
				return id
			}
		}
	}
	return fallback
}
