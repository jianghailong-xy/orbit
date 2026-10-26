package main

// Cursor CLI sessions over ACP (docs/cursor-runtime-contract.md §2, §3, §16.3, §16.4).
//
// Each Orbit session runs one resident `agent acp` of the pinned build, prepared by cursor_launch.go:
// newline-delimited JSON-RPC 2.0 on stdio. The process is initialized once and its conversation opened
// with session/new, whose id is the session's runtime session id; a later process of the same session
// continues that conversation with session/load (§3.5) and never opens another in its place. One prompt
// runs at a time: a session/prompt sent while another runs cancels it (§3.2), so a message that arrives
// mid-turn waits here for the turn to settle, and a steer is refused. A stop is a session/cancel.
//
// Each turn settles once (cursorSettlementOutcome): on Cursor's answer to its prompt — `end_turn`, read
// for the error sentence Cursor CLI ends a failed turn with (cursor_events.go), or `cancelled` — and, when
// none comes, on Orbit's own stop, the process exiting, or the connection closing. Never with usage (§3.2),
// so no turn reports a cost or a context reading. A turn whose prompt may have reached Cursor is never
// sent again: the session's turn ledger (cursorTurnLedger) settles one that an earlier process or runner
// left unsettled as interrupted, since its tools may already have run.
//
// What Cursor CLI asks the client while a turn runs — an approval, a plan to accept, a question — the
// permission bridge answers (cursor_permissions.go), for the session's permission mode: unasked, or from
// a person on Orbit's card, and cancelled once the turn is stopped, its process lost or it settled. Each
// conversation is opened and continued with Orbit's MCP server (cursor_mcp.go), and its first prompt
// carries Orbit's agent instructions ahead of the person's message: Cursor CLI reads no user-level rules
// file Orbit could put them in (§7.2).

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type cursorRPCError struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
}

type cursorRPCMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      interface{}     `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *cursorRPCError `json:"error,omitempty"`
}

type cursorRPCReply struct {
	message cursorRPCMessage
	err     error
}

type cursorPending struct {
	method string
	reply  chan cursorRPCReply
}

type cursorWrite struct {
	wire []byte
	ack  chan error // nil for a line nothing waits on
}

// cursorCallError is a JSON-RPC error Cursor CLI answered a request with.
type cursorCallError struct {
	code   int
	text   string
	detail string // the error's data, where Cursor says what failed ("Invalid model value: …")
}

func (e *cursorCallError) Error() string { return e.text }

type cursorACPClient struct {
	cmd     *exec.Cmd
	scope   *sessionScope // what the process runs in (session_scope.go): everything it starts ends with it
	cancel  context.CancelFunc
	stdin   io.WriteCloser
	mapper  *cursorEventMapper
	secrets []string // the session's credential, masked out of everything Cursor CLI writes

	mu          sync.Mutex
	nextID      int
	pending     map[string]cursorPending
	terminalErr error

	writes   chan cursorWrite
	done     chan struct{}
	readDone chan struct{} // closed once the reader has taken everything the CLI wrote
	once     sync.Once
	wg       sync.WaitGroup

	// The process is reaped once, by its watcher: after the reader has taken everything (or when
	// dispose asks, reapNow), so the wait never closes a pipe with output still in it.
	stderrDone chan struct{}
	reapNow    chan struct{}
	reapOnce   sync.Once
	exited     chan struct{} // closed once the process has been reaped
	exit       string        // how it ended ("exit status 1", "signal: killed"); set before exited closes

	// bridge answers the approvals, plans and questions Cursor CLI asks for; nil declines them all.
	bridge *cursorPermissionBridge

	// What initialize and the session's configuration reported; the session loop's alone.
	images        bool          // promptCapabilities.image: images may go in a prompt as they are
	configOptions []interface{} // the session's mode, model and the model's parameters

	// mode is the Cursor session mode Cursor last reported (its answer to session/new or session/load, or
	// a current_mode_update); "" once the model may have switched it itself (cursorEventMapper.onSwitchMode).
	modeMu sync.Mutex
	mode   string
}

func startCursorACP(ctx context.Context, spec CursorLaunchSpec, mapper *cursorEventMapper, bridge *cursorPermissionBridge, emit emitFn) (*cursorACPClient, error) {
	if spec.Version != cursorSupportedVersion {
		return nil, fmt.Errorf("CURSOR_VERSION_INCOMPATIBLE: Orbit runs Cursor CLI %s, not %q", cursorSupportedVersion, spec.Version)
	}
	if !filepath.IsAbs(spec.Executable) || !filepath.IsAbs(spec.Cwd) {
		return nil, errors.New("CURSOR_CONFIG_CONFLICT: the Cursor CLI launch needs an absolute entry point and working directory")
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
	// In a scope of its own: the CLI runs its commands detached, and one it leaves behind when it ends —
	// above all when it is killed mid-turn — must end with the session too (§3.4).
	scope, err := startInSessionScope(cmd)
	if err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		_ = stderr.Close()
		cancel()
		return nil, err
	}
	a := &cursorACPClient{cmd: cmd, scope: scope, cancel: cancel, stdin: stdin, mapper: mapper, secrets: cursorLaunchSecrets(spec.Env),
		pending: map[string]cursorPending{}, writes: make(chan cursorWrite, 16), done: make(chan struct{}), readDone: make(chan struct{}),
		stderrDone: make(chan struct{}), reapNow: make(chan struct{}), exited: make(chan struct{}), bridge: bridge}
	if bridge != nil {
		bridge.reply = a.respond
	}
	mapper.onMode = a.setMode
	a.wg.Add(4)
	go func() { defer a.wg.Done(); defer close(a.readDone); a.readLoop(stdout) }()
	go func() { defer a.wg.Done(); a.writeLoop() }()
	go func() { defer a.wg.Done(); a.watchExit() }()
	go func() {
		defer a.wg.Done()
		defer close(a.stderrDone)
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
		for sc.Scan() {
			// Empty while all is well; what it says when the CLI refuses to start (an invalid project
			// cli.json, an unknown model: §2.1) is the only account of why.
			emit(evSystem, map[string]interface{}{"stderr": a.redact(stripANSI(sc.Text())) + "\n"})
		}
	}()
	return a, nil
}

// readLoop is the one reader of Cursor CLI's stdout, and applies every update before it reads the next
// line: a prompt's answer reaches its waiter only after everything the turn streamed ahead of it.
func (a *cursorACPClient) readLoop(r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var msg cursorRPCMessage
		if err := json.Unmarshal(line, &msg); err != nil || msg.JSONRPC != "2.0" {
			a.fail(errors.New("Cursor CLI wrote a line that is not JSON-RPC"))
			return
		}
		switch {
		case msg.Method != "" && msg.ID != nil:
			a.answer(msg)
		case msg.Method == "session/update":
			a.mapper.update(rawObject(msg.Params))
		case msg.Method != "":
			// A notification of no other kind is defined (§4).
		default:
			a.deliver(msg)
		}
	}
	err := sc.Err()
	if err == nil {
		err = io.EOF
	}
	a.fail(fmt.Errorf("Cursor CLI's ACP connection closed: %w", err))
}

func (a *cursorACPClient) deliver(msg cursorRPCMessage) {
	if msg.ID == nil || (msg.Error == nil && len(msg.Result) == 0) || (msg.Error != nil && len(msg.Result) > 0) {
		a.fail(errors.New("Cursor CLI wrote an invalid ACP response"))
		return
	}
	key := rpcIDKey(msg.ID)
	a.mu.Lock()
	pending, ok := a.pending[key]
	delete(a.pending, key)
	a.mu.Unlock()
	if !ok {
		return // its caller gave up waiting
	}
	switch {
	case pending.method == "session/new" && msg.Error == nil:
		if id := firstString(rawObject(msg.Result), "sessionId"); id != "" {
			a.mapper.bind(id)
		}
	case pending.method == "session/load":
		// The replay is over: what follows is the session's own again.
		a.mapper.loaded()
	}
	pending.reply <- cursorRPCReply{message: msg}
}

// answer replies to a request Cursor CLI sends the client, from the reader, without waiting on
// anything: each has to be answered, or the turn that sent it waits forever (§4.2, §5.2).
func (a *cursorACPClient) answer(msg cursorRPCMessage) {
	var result interface{}
	switch msg.Method {
	case "session/request_permission", "cursor/ask_question", "cursor/create_plan":
		if a.bridge == nil {
			// Nobody can be asked: declined, so nothing runs.
			result = cursorCancelled()
			break
		}
		params := rawObject(msg.Params)
		switch msg.Method {
		case "session/request_permission":
			a.bridge.permission(msg.ID, params)
		case "cursor/ask_question":
			a.bridge.question(msg.ID, params)
		default:
			a.bridge.plan(msg.ID, params)
		}
		return
	case "cursor/update_todos", "cursor/task", "cursor/generate_image":
		// Reports of what a tool already did, on its card; the CLI waits for no particular answer (§4.2).
		result = map[string]interface{}{}
	default:
		a.post(map[string]interface{}{"jsonrpc": "2.0", "id": msg.ID,
			"error": map[string]interface{}{"code": -32601, "message": "Orbit does not handle " + msg.Method}})
		return
	}
	a.post(map[string]interface{}{"jsonrpc": "2.0", "id": msg.ID, "result": result})
}

// respond answers a request Cursor CLI sent the client.
func (a *cursorACPClient) respond(id interface{}, result map[string]interface{}) {
	a.post(map[string]interface{}{"jsonrpc": "2.0", "id": id, "result": result})
}

func (a *cursorACPClient) fail(err error) {
	a.once.Do(func() {
		a.mu.Lock()
		a.terminalErr = err
		for id, pending := range a.pending {
			pending.reply <- cursorRPCReply{err: err}
			delete(a.pending, id)
		}
		close(a.done)
		a.mu.Unlock()
		_ = a.stdin.Close()
	})
}

func (a *cursorACPClient) writeLoop() {
	for {
		select {
		case <-a.done:
			return
		case item := <-a.writes:
			n, err := a.stdin.Write(item.wire)
			if err == nil && n != len(item.wire) {
				err = io.ErrShortWrite
			}
			if item.ack != nil {
				item.ack <- err
			}
			if err != nil {
				a.fail(fmt.Errorf("writing to Cursor CLI failed: %w", err))
				return
			}
		}
	}
}

func (a *cursorACPClient) closedErr() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.terminalErr != nil {
		return a.terminalErr
	}
	return errors.New("Cursor CLI's ACP connection closed")
}

// connectionClosed is whether the connection has ended, from either side.
func (a *cursorACPClient) connectionClosed() bool {
	select {
	case <-a.done:
		return true
	default:
		return false
	}
}

// watchExit reaps the process once it is done with its output — its stdout read to the end, then its
// stderr, which a command it left running may hold open, for a moment at most — or once dispose stops
// waiting for that, and records how the process ended.
func (a *cursorACPClient) watchExit() {
	select {
	case <-a.readDone:
		select {
		case <-a.stderrDone:
		case <-a.reapNow:
		case <-time.After(cursorExitGrace):
		}
	case <-a.reapNow:
	}
	err := waitSessionProcessTree(a.cmd)
	if state := a.cmd.ProcessState; state != nil {
		a.exit = state.String()
	} else if err != nil {
		a.exit = err.Error()
	}
	close(a.exited)
}

// awaitExit is how the process ended, waiting up to wait for it to; "" when it is still running.
func (a *cursorACPClient) awaitExit(wait time.Duration) string {
	select {
	case <-a.exited:
		return a.exit
	case <-time.After(wait):
		return ""
	}
}

// post queues a line and returns without waiting for it to be written.
func (a *cursorACPClient) post(value map[string]interface{}) {
	wire, err := json.Marshal(value)
	if err != nil {
		a.fail(err)
		return
	}
	select {
	case a.writes <- cursorWrite{wire: append(wire, '\n')}:
	case <-a.done:
	}
}

func (a *cursorACPClient) write(ctx context.Context, value map[string]interface{}) error {
	wire, err := json.Marshal(value)
	if err != nil {
		return err
	}
	item := cursorWrite{wire: append(wire, '\n'), ack: make(chan error, 1)}
	select {
	case a.writes <- item:
	case <-a.done:
		return a.closedErr()
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case err := <-item.ack:
		return err
	case <-a.done:
		return a.closedErr()
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (a *cursorACPClient) call(ctx context.Context, method string, params map[string]interface{}) (map[string]interface{}, error) {
	a.mu.Lock()
	if a.terminalErr != nil {
		err := a.terminalErr
		a.mu.Unlock()
		return nil, err
	}
	a.nextID++
	id := fmt.Sprintf("orbit-cursor-%d", a.nextID)
	reply := make(chan cursorRPCReply, 1)
	a.pending[id] = cursorPending{method: method, reply: reply}
	a.mu.Unlock()
	defer func() { a.mu.Lock(); delete(a.pending, id); a.mu.Unlock() }()
	if err := a.write(ctx, map[string]interface{}{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		// An answer that came in just ahead of the connection closing still counts.
		select {
		case r := <-reply:
			return a.decode(method, r)
		default:
			return nil, err
		}
	}
	select {
	case r := <-reply:
		return a.decode(method, r)
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (a *cursorACPClient) decode(method string, reply cursorRPCReply) (map[string]interface{}, error) {
	if reply.err != nil {
		return nil, reply.err
	}
	if e := reply.message.Error; e != nil {
		text := fmt.Sprintf("Cursor CLI's %s failed (%d): %s", method, e.Code, a.redact(e.Message))
		detail := a.redact(kimiRPCErrorDetail(e.Data))
		if detail != "" && detail != e.Message {
			text += ": " + clip(detail, 300)
		}
		return nil, &cursorCallError{code: e.Code, text: text, detail: detail}
	}
	var result map[string]interface{}
	if json.Unmarshal(reply.message.Result, &result) != nil || result == nil {
		return nil, fmt.Errorf("Cursor CLI's %s answered with something that is not an object", method)
	}
	return result, nil
}

// initialize is the handshake the contract settled on (§2.2, cursorInitializeParams). Its answer says
// whether a prompt may carry images.
func (a *cursorACPClient) initialize(ctx context.Context) error {
	result, err := a.call(ctx, "initialize", cursorInitializeParams())
	if err != nil {
		return err
	}
	if toInt(result["protocolVersion"]) != 1 {
		return errors.New("Cursor CLI speaks another ACP protocol version")
	}
	a.images = mapValue(mapValue(result["agentCapabilities"])["promptCapabilities"])["image"] == true
	return nil
}

// open starts the session's conversation with the session's MCP servers, Orbit's among them (§3.1, §6).
func (a *cursorACPClient) open(ctx context.Context, cwd string, servers []interface{}) (string, error) {
	result, err := a.call(ctx, "session/new", map[string]interface{}{"cwd": cwd, "mcpServers": servers})
	if err != nil {
		return "", err
	}
	id := firstString(result, "sessionId")
	if id == "" {
		return "", errors.New("Cursor CLI's session/new returned no sessionId")
	}
	a.configOptions, _ = result["configOptions"].([]interface{})
	a.setMode(firstString(mapValue(result["modes"]), "currentModeId"))
	return id, nil
}

// load continues the session's conversation in this process (§3.5) in the checkout it was had in. Cursor
// replays it as session/update before it answers, and the mapper drops all of it: Orbit's transcript
// already holds that conversation, under ids of its own, which the replay's do not match.
func (a *cursorACPClient) load(ctx context.Context, sessionID, cwd string, servers []interface{}) error {
	a.mapper.load(sessionID)
	result, err := a.call(ctx, "session/load", map[string]interface{}{"sessionId": sessionID, "cwd": cwd, "mcpServers": servers})
	if err != nil {
		return err
	}
	a.configOptions, _ = result["configOptions"].([]interface{})
	a.setMode(firstString(mapValue(result["modes"]), "currentModeId"))
	return nil
}

func (a *cursorACPClient) setMode(mode string) {
	a.modeMu.Lock()
	a.mode = mode
	a.modeMu.Unlock()
}

func (a *cursorACPClient) currentMode() string {
	a.modeMu.Lock()
	defer a.modeMu.Unlock()
	return a.mode
}

// enterMode puts the session in the Cursor mode its permission mode runs in (agent, or plan) unless Cursor
// last reported it there. session/set_mode, which Cursor answers with a current_mode_update (§3.1).
func (a *cursorACPClient) enterMode(ctx context.Context, sessionID, mode string) error {
	if a.currentMode() == mode {
		return nil
	}
	if _, err := a.call(ctx, "session/set_mode", map[string]interface{}{"sessionId": sessionID, "modeId": mode}); err != nil {
		return err
	}
	a.setMode(mode)
	return nil
}

// configure puts the session on its model, the model's settings and its effort with
// session/set_config_option, never --model (§10, §16.3): the model is the whole process's, and an
// unknown one passed as a flag ends it. The session's model value names the model and the context and
// fast lane it runs with, the way Cursor writes a variant (`claude-opus-5-5[context=1m,fast=true]`,
// decodeCursorModel): the bare model is selected first, then each of those settings the model lists —
// at the value named, or at the model's own default where the value names none, since the process can
// be on a setting an earlier selection left (the CLI keeps its selection in its config, §3.1). A
// session that names no model stays on the one it runs on — Auto, for a new one — or goes back to
// Auto from another, and Auto takes no settings. A setting or an effort the model does not take is
// left at the model's own and logged, as on Kimi: a session is not failed over a tuning knob.
func (a *cursorACPClient) configure(ctx context.Context, sessionID string, agent AgentExecConfig) error {
	model, settings := decodeCursorModel(agent.Model)
	current := firstString(cursorSessionOption(a.configOptions, "model"), "currentValue")
	if model == "" && current != "" && !cursorAutoModel(current) {
		model = "default"
	}
	if model != "" && model != current {
		if err := a.setOption(ctx, sessionID, "model", model); err != nil {
			return err
		}
	}
	selected := firstString(cursorSessionOption(a.configOptions, "model"), "currentValue")
	named := map[string]string{}
	for _, setting := range settings {
		switch {
		case cursorAutoModel(selected):
			logln("cursor: Auto takes no model settings; ignoring", setting.id+"="+setting.value)
		case !slices.Contains(cursorVariantParameters, setting.id):
			logln("cursor: a model value sets only the context and fast lane; ignoring", setting.id+"="+setting.value)
		default:
			named[setting.id] = setting.value
		}
	}
	for _, id := range cursorVariantParameters {
		option := cursorSessionOption(a.configOptions, id)
		value, asked := named[id]
		if option == nil {
			if asked {
				logln("cursor: the session's model takes no", id+"; ignoring", value)
			}
			continue
		}
		fallback := cursorParameterDefault(selected, id)
		if asked && !cursorOffers(option, value) {
			logln("cursor: the session's model does not offer", id, value+"; leaving it at the model's own", firstNonEmpty(fallback, firstString(option, "currentValue")))
			asked = false
		}
		if !asked {
			value = fallback
		}
		if value == "" || value == firstString(option, "currentValue") || !cursorOffers(option, value) {
			continue
		}
		if err := a.setOption(ctx, sessionID, id, value); err != nil {
			return err
		}
	}
	effort := strings.TrimSpace(agent.Effort)
	if effort == "" {
		return nil
	}
	option := cursorEffortOption(a.configOptions)
	switch {
	case option == nil:
		logln("cursor: the session's model takes no effort; ignoring", effort)
	case firstString(option, "currentValue") == effort:
	case !cursorOffers(option, effort):
		logln("cursor: the session's model does not offer effort", effort+"; leaving it at", firstString(option, "currentValue"))
	default:
		return a.setOption(ctx, sessionID, firstString(option, "id"), effort)
	}
	return nil
}

func (a *cursorACPClient) setOption(ctx context.Context, sessionID, id, value string) error {
	result, err := a.call(ctx, "session/set_config_option", map[string]interface{}{"sessionId": sessionID, "configId": id, "value": value})
	if err != nil {
		return err
	}
	if options, ok := result["configOptions"].([]interface{}); ok {
		a.configOptions = options
	}
	return nil
}

func (a *cursorACPClient) prompt(ctx context.Context, sessionID string, blocks []map[string]interface{}) (map[string]interface{}, error) {
	return a.call(ctx, "session/prompt", map[string]interface{}{"sessionId": sessionID, "prompt": blocks})
}

// dispose ends the process the way it ends cleanly — SIGTERM, which it handles, and its whole tree
// after a grace — since closing stdin does not end it (§3.4). On Linux its exit is its scope's: by then
// whatever it started has gone too, the commands it detached among them. What the CLI wrote before it exited is
// read first: reaping the process closes its stdout, and a title can still be on its way after the last
// turn (§3.2).
func (a *cursorACPClient) dispose() {
	a.fail(errors.New("the Cursor CLI process was stopped"))
	_ = a.cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-a.readDone:
	case <-time.After(cursorStopGrace):
	}
	a.reapOnce.Do(func() { close(a.reapNow) })
	select {
	case <-a.exited:
	case <-time.After(5 * time.Second):
		a.cancel()
		<-a.exited
	}
	a.cancel()
	a.wg.Wait()
	a.scope.close()
}

// redact masks the session's credential in text Cursor CLI wrote.
func (a *cursorACPClient) redact(text string) string {
	for _, secret := range a.secrets {
		text = strings.ReplaceAll(text, secret, "[redacted]")
	}
	return text
}

func cursorLaunchSecrets(env []string) []string {
	var secrets []string
	for _, entry := range env {
		for _, key := range []string{"CURSOR_API_KEY=", "CURSOR_AUTH_TOKEN="} {
			if value, ok := strings.CutPrefix(entry, key); ok && value != "" {
				secrets = append(secrets, value)
			}
		}
	}
	return secrets
}

func cursorSessionOption(options []interface{}, id string) map[string]interface{} {
	for _, raw := range options {
		if option := mapValue(raw); firstString(option, "id") == id {
			return option
		}
	}
	return nil
}

// cursorAutoModel is Auto under either picker: `default` with the parameterized one, `default[]` without.
func cursorAutoModel(value string) bool {
	return value == "default" || strings.HasPrefix(value, "default[")
}

// cursorEffortOption is the selected model's effort: its thought_level that is a scale rather than an
// on/off switch, whatever the model calls it (effort, reasoning_effort, reasoning: §10).
func cursorEffortOption(options []interface{}) map[string]interface{} {
	for _, raw := range options {
		option := mapValue(raw)
		if firstString(option, "category") != "thought_level" {
			continue
		}
		values := map[string]bool{}
		rows, _ := option["options"].([]interface{})
		for _, row := range rows {
			values[firstString(mapValue(row), "value")] = true
		}
		if len(values) == 2 && values["true"] && values["false"] {
			continue
		}
		return option
	}
	return nil
}

func cursorOffers(option map[string]interface{}, value string) bool {
	rows, _ := option["options"].([]interface{})
	for _, row := range rows {
		if firstString(mapValue(row), "value") == value {
			return true
		}
	}
	return false
}

// cursorLaunchSignsIn is whether a launch carries a credential the CLI signs in with (§2.3).
func cursorLaunchSignsIn(env []string) bool {
	for _, entry := range env {
		if key, value, _ := strings.Cut(entry, "="); (key == "CURSOR_API_KEY" || key == "CURSOR_AUTH_TOKEN") && strings.TrimSpace(value) != "" {
			return true
		}
	}
	return false
}

// cursorLaunchIdentity is what the session's process was started from and cannot change while it runs:
// the workspace's variables, its credential among them (cursor_launch.go).
func cursorLaunchIdentity(env map[string]string) string {
	pairs := make([]string, 0, len(env))
	for key, value := range env {
		pairs = append(pairs, key+"="+value)
	}
	sort.Strings(pairs)
	return strings.Join(pairs, "\x00")
}

// prepareCursorPrompt builds a turn's prompt. An image goes in as an image block while the CLI takes
// them (initialize's promptCapabilities.image); any other attachment, and an image when it does not, is
// saved beside the session and named in the text. A person's shell commands since the last turn come
// first, as on every other engine, and Orbit's agent instructions, when given, ahead of everything.
func prepareCursorPrompt(ctx context.Context, t *Transport, job *ClaimedSession, resp *RunInboxResponse, images bool, shellContext []string, instructions string) ([]map[string]interface{}, []map[string]interface{}) {
	var blocks, refs []map[string]interface{}
	var paths []string
	for _, att := range resp.Attachments {
		data, err := t.fetchAttachment(ctx, job.SessionID, att.ID)
		if err != nil {
			logln("attachment fetch failed for", job.SessionID, att.ID+":", err)
			continue
		}
		switch att.MimeType {
		case "image/png", "image/jpeg", "image/webp", "image/gif":
			if images {
				blocks = append(blocks, map[string]interface{}{"type": "image", "mimeType": att.MimeType,
					"data": base64.StdEncoding.EncodeToString(data)})
				refs = append(refs, map[string]interface{}{"id": att.ID, "mime": att.MimeType, "name": att.FileName})
				continue
			}
		}
		path, err := writeUpload(job.SessionID, att.FileName, att.ID, data)
		if err != nil {
			logln("attachment write failed for", job.SessionID, att.ID+":", err)
			continue
		}
		paths = append(paths, path)
		refs = append(refs, map[string]interface{}{"id": att.ID, "mime": att.MimeType, "name": att.FileName})
	}
	text := resp.Content
	if len(shellContext) > 0 {
		text = strings.Join(shellContext, "\n") + "\n\n" + text
	}
	if len(paths) > 0 {
		note := fmt.Sprintf("[The user uploaded %d file(s), saved at: %s - read or process them with your tools as needed.]",
			len(paths), strings.Join(paths, ", "))
		if strings.TrimSpace(text) != "" {
			text = note + "\n\n" + text
		} else {
			text = note
		}
	}
	if instructions != "" {
		text = "<orbit-agent-instructions>\n" + instructions + "\n</orbit-agent-instructions>\n\n" + text
	}
	if text != "" || len(blocks) == 0 {
		blocks = append([]map[string]interface{}{{"type": "text", "text": text}}, blocks...)
	}
	return blocks, refs
}

// cursorAgentInstructions are Orbit's agent instructions for a Cursor CLI conversation: the workspace's
// system prompt and its appended one, with Orbit's own (withOrbitCLIInstructions) — Orbit's MCP tools
// named as Cursor shows them, a server's tools rather than mcp__orbit__* names. They go ahead of the
// conversation's first prompt (§7.2: no user-level rules file reaches the model), and stay in the
// conversation Cursor keeps from then on.
func cursorAgentInstructions(job *ClaimedSession) string {
	var parts []string
	if strings.TrimSpace(job.Agent.SystemPrompt) != "" {
		parts = append(parts, strings.TrimSpace(job.Agent.SystemPrompt))
	}
	appended := strings.TrimSpace(withOrbitCLIInstructions(job.Agent.AppendSystemPrompt, orbitCLIExecutable(), job.insideRecordedWork(), job.watchesOn()))
	if appended != "" {
		parts = append(parts, strings.Replace(appended, "the `mcp__orbit__*` tools", "the tools of the `orbit` MCP server", 1))
	}
	return strings.Join(parts, "\n\n")
}

// cursorStopGrace is how long a stopped prompt may take to answer before its process is ended instead;
// Cursor answers a session/cancel within milliseconds (§3.3). A variable, for a test to shorten.
var cursorStopGrace = 10 * time.Second

// cursorExitGrace is how long a turn whose connection ended waits to learn whether the process exited,
// and how long a process's stderr may stay open after its stdout before the process is reaped anyway.
const cursorExitGrace = 2 * time.Second

type cursorPromptResult struct {
	turnID string
	result map[string]interface{}
	err    error
}

// cursorTurnEnd is what is known of how a turn ended when it settles.
type cursorTurnEnd struct {
	result  map[string]interface{} // Cursor's answer to the turn's session/prompt; nil when none came
	err     error                  // why none came, or the JSON-RPC error the prompt was answered with
	stopped bool                   // Orbit stopped the turn: an interrupt, the session's end or cancel, a shutdown, a reload
	exit    string                 // how the process ended, when it ended without answering
	closed  bool                   // the connection ended without an answer while the process went on running
}

// answered is whether Cursor answered the prompt: with a stop reason, or with a JSON-RPC error.
func (e cursorTurnEnd) answered() bool {
	var refused *cursorCallError
	return e.result != nil || errors.As(e.err, &refused)
}

// cursorSettlementOutcome is what a turn settles on — the first of these that holds:
//  1. Cursor's answer to the prompt: end_turn or cancelled, which the mapper reads, or a JSON-RPC error,
//     which fails the turn: a protocol error is never a success. It outranks Orbit's own stop because
//     Cursor answers a session/cancel within milliseconds (§3.3): an end_turn that crossed a stop is a
//     turn that had finished before the stop reached it.
//  2. Orbit stopped the turn and no answer came before the process was ended: interrupted.
//  3. The process exited without answering — a crash (§12): failed, with how it exited.
//  4. The connection ended without an answer while the process went on running: failed.
//
// Last comes the lease going to another owner while none of these has happened yet: the turn is not
// settled here at all, but left prompted in the turn ledger for the runner that holds the lease
// (cursorTurnLedger). Whichever it is, the prompt is not sent again: its tools may already have run.
func cursorSettlementOutcome(end cursorTurnEnd) (map[string]interface{}, error) {
	const notSentAgain = " The turn was not sent again: its tools may already have run."
	switch {
	case end.answered():
		return end.result, end.err
	case end.stopped:
		return map[string]interface{}{"stopReason": "cancelled"}, nil
	case end.exit != "":
		return nil, fmt.Errorf("Cursor CLI exited during this turn (%s) without answering it.%s", end.exit, notSentAgain)
	case end.closed:
		return nil, fmt.Errorf("Cursor CLI's connection ended during this turn without an answer, while the process kept running (%v).%s", end.err, notSentAgain)
	}
	return nil, end.err
}

// The states of a turn in the session's turn ledger.
const (
	cursorTurnPrompted = "prompted"
	cursorTurnSettled  = "settled"
)

// cursorLedgerSettledKept is how many settled turns the ledger keeps: more than a redelivery reaches back.
const cursorLedgerSettledKept = 32

type cursorTurnRecord struct {
	State     string   `json:"state"`
	Seq       int      `json:"seq"`
	OpenTools []string `json:"openTools,omitempty"`
	Status    string   `json:"status,omitempty"`
	Subtype   string   `json:"subtype,omitempty"`
	Result    string   `json:"result,omitempty"`
	Error     string   `json:"error,omitempty"`
}

// cursorTurnLedger is the session's record of its turns that reached Cursor CLI, kept beside its
// conversation store (<runs>/<session>/cursor/orbit-turns.json) so that it outlives the process and the
// runner. Orbit's queue knows a turn was leased, not whether its prompt went out before a crash; this
// does. A turn is recorded before its prompt is written, so one delivered again — after a runner restart,
// or to the runner a lease moved to — is never prompted twice: one that settled is reported as it
// settled, one that did not is settled interrupted, the cards it left open closed.
type cursorTurnLedger struct {
	mu    sync.Mutex
	path  string
	Seq   int                          `json:"seq"`
	Turns map[string]*cursorTurnRecord `json:"turns"`
}

func loadCursorTurnLedger(dir string) (*cursorTurnLedger, error) {
	l := &cursorTurnLedger{path: filepath.Join(dir, "orbit-turns.json"), Turns: map[string]*cursorTurnRecord{}}
	data, err := os.ReadFile(l.path)
	if errors.Is(err, os.ErrNotExist) {
		return l, nil
	}
	if err != nil || json.Unmarshal(data, l) != nil {
		return nil, fmt.Errorf("CURSOR_CONFIG_CONFLICT: the session's turn ledger %s cannot be read; it is left as it is", l.path)
	}
	if l.Turns == nil {
		l.Turns = map[string]*cursorTurnRecord{}
	}
	return l, nil
}

// update applies change, and writes the ledger when change says it changed it.
func (l *cursorTurnLedger) update(change func() bool) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !change() {
		return nil
	}
	data, err := json.Marshal(l)
	if err != nil {
		return err
	}
	return writeFileAtomically(l.path, data, 0o600)
}

func (l *cursorTurnLedger) get(turnID string) (cursorTurnRecord, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	rec, ok := l.Turns[turnID]
	if !ok {
		return cursorTurnRecord{}, false
	}
	copied := *rec
	copied.OpenTools = append([]string(nil), rec.OpenTools...)
	return copied, true
}

// prompted records a turn whose prompt is about to be written.
func (l *cursorTurnLedger) prompted(turnID string) error {
	return l.update(func() bool {
		l.Seq++
		l.Turns[turnID] = &cursorTurnRecord{State: cursorTurnPrompted, Seq: l.Seq}
		return true
	})
}

// tool records a card of a prompted turn opening or closing (cursorEventMapper.onTool).
func (l *cursorTurnLedger) tool(turnID, toolID string, open bool) {
	err := l.update(func() bool {
		rec := l.Turns[turnID]
		if rec == nil || rec.State != cursorTurnPrompted {
			return false
		}
		if open {
			rec.OpenTools = append(rec.OpenTools, toolID)
			return true
		}
		for i, id := range rec.OpenTools {
			if id == toolID {
				rec.OpenTools = append(rec.OpenTools[:i:i], rec.OpenTools[i+1:]...)
				return true
			}
		}
		return false
	})
	if err != nil {
		logln("cursor turn ledger:", err)
	}
}

// settled records how a turn settled, and forgets the oldest settled turns past cursorLedgerSettledKept.
func (l *cursorTurnLedger) settled(req TurnCompleteRequest) error {
	return l.update(func() bool {
		rec := l.Turns[req.TurnID]
		if rec == nil {
			l.Seq++
			rec = &cursorTurnRecord{Seq: l.Seq}
		}
		l.Turns[req.TurnID] = &cursorTurnRecord{State: cursorTurnSettled, Seq: rec.Seq, Status: req.Status,
			Subtype: req.Subtype, Result: req.Result, Error: req.Error}
		for {
			oldest, settled := "", 0
			for id, rec := range l.Turns {
				if rec.State == cursorTurnSettled {
					settled++
					if oldest == "" || rec.Seq < l.Turns[oldest].Seq {
						oldest = id
					}
				}
			}
			if settled <= cursorLedgerSettledKept {
				return true
			}
			delete(l.Turns, oldest)
		}
	})
}

// cursorConversationUnspoken is whether Cursor CLI holds the session's conversation without a word said
// in it: session/new writes its meta.json and the first prompt its store.db, and session/load answers one
// without a store "not found" (§3.5) — there is nothing in it to continue.
func cursorConversationUnspoken(configDir, sessionID string) bool {
	if sessionID == "" || sessionID != filepath.Base(sessionID) || strings.HasPrefix(sessionID, ".") {
		return false
	}
	dir := filepath.Join(configDir, "acp-sessions", sessionID)
	if _, err := os.Stat(filepath.Join(dir, "meta.json")); err != nil {
		return false
	}
	_, err := os.Stat(filepath.Join(dir, "store.db"))
	return errors.Is(err, os.ErrNotExist)
}

// cursorOpenFailure is how a session ends its start when Cursor CLI would not open or continue its
// conversation (§2.3, §3.1, §12, §16.6):
//   - -32000 "Authentication required": the CLI has no credential it can sign in with;
//   - -32603 "Failed to initialize session services": what an invalid credential and an unreachable Cursor
//     API both answer. A key is put to `agent models` to tell the two apart, as §9 measured it;
//   - -32602 `Session "<id>" not found`, to session/load: the CLI holds no such conversation. It is said to
//     be gone, never replaced by a new one, which would drop everything said in it.
//
// Anything else — the account having switched teams among it — is said as Cursor said it.
func cursorOpenFailure(ctx context.Context, launch CursorLaunchSpec, job *ClaimedSession, method string, err error, report cursorKeyReporter) string {
	var refused *cursorCallError
	if !errors.As(err, &refused) {
		return fmt.Sprintf("Cursor CLI did not answer its %s: %v", method, err)
	}
	switch {
	case refused.code == -32000:
		return "Failed to authenticate: " + refused.text
	case refused.code == -32603 && refused.detail == "Failed to initialize session services":
		switch cursorKeyVerdict(ctx, launch, job, report) {
		case cursorKeyInvalid:
			return cursorAPIKeyInvalidMessage
		case cursorKeyUnreachable:
			return `Cursor CLI could not reach the Cursor API ("Failed to reach the Cursor API"), so it could not open this session. ` +
				"Check the runner's network and proxy settings, then send the message again."
		}
	case method == "session/load" && refused.code == -32602 && strings.HasSuffix(refused.detail, "not found"):
		return fmt.Sprintf("Cursor CLI has no conversation %s for this session on this runner (%s), so it cannot continue it here. "+
			"Orbit does not start a new conversation in its place, which would drop everything said so far: start a new session to keep working.",
			job.RuntimeSessionID, refused.detail)
	}
	return refused.text
}

// cursorKeyVerdict is what `agent models` says of the API key the session's CLI runs on (checkCursorAPIKey):
// valid, invalid, unreachable, or "" — no answer it can read, or a session on a login. A dispatched key's
// answer goes to the control plane, which keeps it on the key, as at the key's first check
// (checkCursorSessionKey).
func cursorKeyVerdict(ctx context.Context, launch CursorLaunchSpec, job *ClaimedSession, report cursorKeyReporter) string {
	var key string
	for _, entry := range launch.Env {
		if value, ok := strings.CutPrefix(entry, "CURSOR_API_KEY="); ok {
			key = value
		}
	}
	if key == "" {
		return ""
	}
	state := checkCursorAPIKey(ctx, launch.Executable, key)
	if state != "" && report != nil && key == cursorSessionKey(job) {
		if err := report(job.SessionID, CursorKeyCheckReport{State: state, KeyFingerprint: cursorKeyFingerprint(key)}); err != nil {
			logln("cursor:", job.SessionID+":", "could not report the API key check:", err)
		}
	}
	return state
}

// cursorConfigureFailure is how a session ends its start when Cursor CLI would not put it on its model:
// one the account is not offered is answered -32602 "Invalid model value" (§10).
func cursorConfigureFailure(err error) string {
	var refused *cursorCallError
	if errors.As(err, &refused) && refused.code == -32602 && strings.HasPrefix(refused.detail, "Invalid model value") {
		return "Cursor CLI does not offer the model this session asks for (" + refused.detail + "). Choose another model, then send the message again."
	}
	return "failed to configure the Cursor CLI session: " + err.Error()
}

func runCursorSessionProcess(p sessionProcessArgs) (string, bool, bool) {
	p.setTurn("")
	// Cursor reports no usage at all (§3.2, §4.1): no turn of it claims a measured $0. What a turn says of
	// its account's quota — the usage limit met, or a turn the account ran — is kept for that account's
	// plan usage (noteCursorTurn).
	completeTurn := p.completeTurn
	account := cursorSessionAccount(p.job)
	p.completeTurn = func(req TurnCompleteRequest, providerContexts ...context.Context) error {
		req.UsageUnknown = true
		noteCursorTurn(account, req)
		return completeTurn(req, providerContexts...)
	}
	fail := func(message string) (string, bool, bool) {
		p.emit(evError, map[string]interface{}{"message": message})
		return stFailed, true, false
	}
	// A conversation the session has talked in stays on the account or key it was opened on (D5): one its
	// workspace has since been moved off is refused here, before anything starts or is checked.
	identity := cursorCredentialIdentity(p.job)
	if refusal := cursorIdentityRefusal(p.scratchDir, p.job, identity); refusal != "" {
		return fail(refusal)
	}
	// A dispatched API key is checked before anything starts on it, and again when Cursor will not open a
	// conversation on it; each answer is kept on the key.
	report := func(sessionID string, report CursorKeyCheckReport) error {
		return p.t.cursorKeyCheck(sessionID, report)
	}
	launch := p.cursorLaunchSpec
	if launch == nil {
		spec, err := PrepareCursorSessionLaunch(p.ctx, p.job, p.execDir, report)
		if err != nil {
			return fail(err.Error())
		}
		launch = &spec
	}
	if !cursorLaunchSignsIn(launch.Env) {
		return fail(cursorSignedOutMessage())
	}
	// What the session's permission mode cannot be held to is refused before anything starts: a mode
	// Cursor CLI has no equivalent of, a denylist, an MCP server it would drop, and — in every mode but
	// Bypass, which lets everything run anyway — configuration Cursor CLI would run without asking.
	policy, err := cursorPermissionPolicyFor(p.job.Agent.PermissionMode)
	if err == nil {
		err = cursorToolPolicyError(p.job.Agent)
	}
	var servers []interface{}
	if err == nil {
		servers, err = cursorMCPServers(p.job)
	}
	if err == nil && policy.Mode != "bypassPermissions" {
		err = guardCursorUserConfig(*launch)
	}
	if err != nil {
		return fail(err.Error())
	}
	dir, err := cursorSessionDir(p.job.SessionID)
	var ledger *cursorTurnLedger
	if err == nil {
		ledger, err = loadCursorTurnLedger(dir)
	}
	if err != nil {
		return fail(err.Error())
	}

	var naming sync.WaitGroup
	defer naming.Wait()
	// Cursor names a conversation from the first prompt it is sent (§3.2). A conversation opened here has
	// Orbit's agent instructions ahead of that prompt, so its name sums up those rather than the person's
	// message — "Orbit Agent Instructions" in P8 — in whatever words Cursor picks. None is reported: the
	// session keeps the title cut from the person's first message.
	var openedWithInstructions atomic.Bool
	mapper := newCursorEventMapper(p.emitFor)
	mapper.onTitle = func(title string) {
		// Only when the claim asks for it (session_naming.go): any other session's title is a person's,
		// a task's or the server's, which a title Cursor made up must not replace.
		if p.job.Naming == nil || p.t == nil {
			return
		}
		if openedWithInstructions.Load() {
			logln("session title: Cursor CLI named", p.job.SessionID, "from Orbit's agent instructions, not the person's message; not reported")
			return
		}
		naming.Add(1)
		go func() {
			defer naming.Done()
			reportSessionNaming(p.t, p.job, title)
		}()
	}
	mapper.onCommands = func(names []string) { slashReg.learnFor(providerCursor, names, nil) }
	mapper.onTool = ledger.tool
	// A mode the model switched itself (§4.2), heard by the reader and handled by the loop.
	switched := make(chan struct{}, 1)
	mapper.onSwitchMode = func(string, string) {
		select {
		case switched <- struct{}{}:
		default:
		}
	}
	// The rules the session was dispatched with do not change while it runs; the mode can (reload).
	preApproved := AgentExecConfig{AllowedTools: append([]string(nil), p.job.Agent.AllowedTools...)}
	bridge := newCursorPermissionBridge(policy, mapper.permissionAsk, mapper.refuse, mapper.withdraw, func(ask cursorPermissionAsk) bool {
		return cursorPreApproved(preApproved, ask)
	}, bridgeCursorCard(p.t, p.job.SessionID), p.emitFor, launch.Cwd)
	app, err := startCursorACP(p.ctx, *launch, mapper, bridge, p.emit)
	if err != nil {
		return fail("failed to start Cursor CLI: " + err.Error())
	}
	defer app.dispose()
	// Every card still open is withdrawn, and answered cancelled, before the process goes.
	defer func() { bridge.close(); bridge.wait() }()
	initCtx, initCancel := context.WithTimeout(p.ctx, 60*time.Second)
	defer initCancel()
	if err := app.initialize(initCtx); err != nil {
		return fail("Cursor CLI did not start its ACP server: " + err.Error())
	}
	// A session that has talked continues its conversation, in this process, under the same id. One that
	// has none opens one, and so does one whose conversation never had a prompt — its turns so far were
	// shell turns: Cursor cannot load that, and there is nothing in it to lose (§3.5, §13.3).
	sessionID, method := p.job.RuntimeSessionID, "session/load"
	switch {
	case sessionID == "":
		method = "session/new"
		sessionID, err = app.open(initCtx, launch.Cwd, servers)
	case cursorConversationUnspoken(launch.ConfigDir, sessionID):
		method = "session/new"
		if sessionID, err = app.open(initCtx, launch.Cwd, servers); err == nil {
			p.emit(evSystem, map[string]interface{}{"noticeKind": "cursor-conversation-reopened",
				"notice": "Cursor CLI had not been sent a message in this session's conversation yet, so a new conversation was opened in its place."})
		}
	default:
		err = app.load(initCtx, sessionID, launch.Cwd, servers)
	}
	if err != nil {
		return fail(cursorOpenFailure(p.ctx, *launch, p.job, method, err, report))
	}
	p.job.RuntimeSessionID = sessionID
	writeCursorSessionMeta(p.scratchDir, p.job, p.execDir, identity)
	if err := app.configure(initCtx, sessionID, p.job.Agent); err != nil {
		return fail(cursorConfigureFailure(err))
	}
	if err := app.enterMode(initCtx, sessionID, policy.ACPMode); err != nil {
		return fail(fmt.Sprintf("Cursor CLI did not take the session into its %s mode, so nothing was sent to it: %v", policy.ACPMode, err))
	}
	// A conversation opened here has had no prompt yet: its first carries Orbit's agent instructions. A
	// loaded one has them from its first turn.
	instructions := ""
	if method == "session/new" {
		instructions = cursorAgentInstructions(p.job)
	}
	openedWithInstructions.Store(instructions != "")
	// The control plane keeps the runtime session id from this event (runtimeInitSessionId).
	p.emit(evSystem, map[string]interface{}{"subtype": "init", "provider": providerCursor, "runtime": "acp",
		"sessionId": sessionID, "cliVersion": launch.Version, "resumed": method == "session/load"})

	pollCtx, pollCancel := context.WithCancel(p.ctx)
	defer pollCancel()
	// The generation's inbox poller: what fetches its turns, and the turnIds already taken on, which
	// a redelivery of one is dropped against for the generation's whole life.
	poller := newInboxPoller(p.t, p.job.SessionID, p.leaseGeneration)
	defer poller.close()
	inbox := make(chan *RunInboxResponse, 8)
	pollErrors := make(chan error, 1)
	var pollWG sync.WaitGroup
	pollWG.Add(1)
	defer func() { pollCancel(); pollWG.Wait() }()
	go func() {
		defer pollWG.Done()
		for pollCtx.Err() == nil {
			resp, err := poller.next(pollCtx)
			if err != nil {
				if pollCtx.Err() == nil && isLeaseOwnershipError(err) {
					select {
					case pollErrors <- err:
					case <-pollCtx.Done():
					}
				}
				return
			}
			select {
			case inbox <- resp:
			case <-pollCtx.Done():
				return
			}
		}
	}()

	promptDone := make(chan cursorPromptResult, 1)
	var promptWG sync.WaitGroup
	defer func() { app.fail(errors.New("the Cursor CLI session loop stopped")); promptWG.Wait() }()
	var activeID string
	// Whether the active turn was stopped here (cursorSettlementOutcome), and when the stop gives up on
	// Cursor's answer. refused says why, when Orbit stopped it for leaving its permission mode.
	stopped := false
	refused := ""
	var stopDeadline <-chan time.Time
	var queued []*RunInboxResponse
	var shellContext []string
	worktree := func(req *TurnCompleteRequest) {
		req.IsolationStatus = p.job.IsolationStatus
		req.ChangedFiles, req.ChangedDiff = liveDiff(p.job.WT)
		req.BaseSha = p.job.WT.baseSha()
		req.WorktreeDirty = worktreeIsDirty(p.job.WT)
		req.BranchSha, req.BranchMerged = effectiveBranchSha(p.job.WT), branchMergedInto(p.job.WT)
		req.WorktreeBranch = currentBranch(p.job.WT)
	}
	settle := func(done cursorPromptResult) string {
		// The turn is over: nothing it asked for may be answered but cancelled from here.
		bridge.close()
		if refused != "" && done.err == nil {
			done.err = errors.New(refused)
		}
		end := cursorTurnEnd{result: done.result, err: done.err, stopped: stopped}
		if !end.answered() && !stopped && app.connectionClosed() {
			end.exit = app.awaitExit(cursorExitGrace)
			end.closed = end.exit == ""
		}
		result, err := cursorSettlementOutcome(end)
		if err != nil {
			err = errors.New(app.redact(err.Error()))
		}
		req, ok := mapper.settle(done.turnID, result, err)
		if ok {
			// Recorded before it is reported: a redelivery after a crash in between is answered from here.
			if err := ledger.settled(req); err != nil {
				logln("cursor turn ledger:", err)
			}
			worktree(&req)
			if err := p.completeTurn(req); err != nil {
				logln("cursor turn-complete failed for", p.job.SessionID+":", err)
			}
		}
		activeID, stopped, refused, stopDeadline = "", false, "", nil
		p.setTurn("")
		return req.Status
	}
	// exited ends the loop on the process having gone: a turn it took with it settled as failed, and the
	// session with it; after an idle exit, the next message continues the conversation in a new process.
	exited := func(status string) (string, bool, bool) {
		event := map[string]interface{}{"subtype": "process_exited", "provider": providerCursor, "runtimeSessionId": sessionID}
		if exit := app.awaitExit(cursorExitGrace); exit != "" {
			event["exit"] = exit
		}
		p.emit(evSystem, event)
		return stFailed, status == stFailed, false
	}
	// A turn delivered again whose prompt an earlier process or runner sent. One that settled is reported
	// as it settled; one that did not is settled interrupted, the cards it left open closed, and is not
	// sent again: its tools may already have run.
	recoverTurn := func(resp *RunInboxResponse, rec cursorTurnRecord) {
		req := TurnCompleteRequest{TurnID: resp.TurnID, Status: rec.Status, Subtype: rec.Subtype, Result: rec.Result,
			Error: rec.Error, NumTurns: 1, RuntimeSessionID: sessionID}
		if rec.State != cursorTurnSettled {
			for _, id := range rec.OpenTools {
				p.emitFor(resp.TurnID, evToolResult, map[string]interface{}{"toolUseId": id, "isError": true,
					"content": "Cursor CLI stopped before this tool reported a result; it may have run."})
			}
			req.Status, req.Subtype = stInterrupted, "interrupted"
			req.Error = "Cursor CLI stopped during this turn, and the turn was not sent again: its tools may already have run."
			p.emitFor(resp.TurnID, evError, map[string]interface{}{"message": req.Error})
			p.emitFor(resp.TurnID, evTurnEnd, map[string]interface{}{"subtype": req.Subtype, "numTurns": 1, "recovered": true})
			if err := ledger.settled(req); err != nil {
				logln("cursor turn ledger:", err)
			}
		}
		worktree(&req)
		if err := p.completeTurn(req); err != nil {
			logln("cursor turn-complete failed for", p.job.SessionID+":", err)
		}
	}
	awaitPrompt := func() cursorPromptResult {
		select {
		case done := <-promptDone:
			return done
		case <-time.After(cursorStopGrace):
			app.fail(errors.New("Cursor CLI did not answer a stopped prompt"))
			return <-promptDone
		}
	}
	// cancelTurn stops the running turn: what it asked for is answered cancelled first, then Cursor is told.
	cancelTurn := func() {
		bridge.close()
		app.post(map[string]interface{}{"jsonrpc": "2.0", "method": "session/cancel",
			"params": map[string]interface{}{"sessionId": sessionID}})
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
		if err := mapper.begin(resp.TurnID); err != nil {
			logln("cursor:", err)
			return true
		}
		activeID = resp.TurnID
		p.setTurn(activeID)
		blocks, refs := prepareCursorPrompt(p.ctx, p.t, p.job, resp, app.images, shellContext, instructions)
		shellContext = nil
		userEvent := map[string]interface{}{"text": resp.Content}
		if len(refs) > 0 {
			userEvent["attachments"] = refs
		}
		p.emitFor(activeID, evUser, userEvent)
		turnID := activeID
		// The mode the permission mode runs in, again if the model may have switched it since (§4.2).
		mode := bridge.policy().ACPMode
		modeCtx, modeCancel := context.WithTimeout(p.ctx, 30*time.Second)
		err := app.enterMode(modeCtx, sessionID, mode)
		modeCancel()
		if err != nil {
			settle(cursorPromptResult{turnID: turnID,
				err: fmt.Errorf("Cursor CLI did not take the session into its %s mode, so this message was not sent to it: %v", mode, err)})
			return true
		}
		// Recorded before the prompt is written: from here on, a crash leaves a turn that is not sent again.
		if err := ledger.prompted(turnID); err != nil {
			settle(cursorPromptResult{turnID: turnID,
				err: fmt.Errorf("Orbit could not record this turn before sending it to Cursor CLI, so it was not sent: %v", err)})
			return true
		}
		instructions = ""
		bridge.begin(turnID)
		promptWG.Add(1)
		go func() {
			defer promptWG.Done()
			result, err := app.prompt(p.ctx, sessionID, blocks)
			promptDone <- cursorPromptResult{turnID: turnID, result: result, err: err}
		}()
		return true
	}
	// runShell runs a shell turn on the runner, in the worktree, while Cursor is idle: a task's
	// EXECUTABLE acceptance command, or a person's `!` command. Cursor is never told about either.
	runShell := func(resp *RunInboxResponse) bool {
		if !p.waitTurnPermit(p.ctx) {
			return false
		}
		p.setTurn(resp.TurnID)
		emit := func(typ string, payload map[string]interface{}) { p.emitFor(resp.TurnID, typ, payload) }
		var req TurnCompleteRequest
		if command, background := shellTurnBackgroundCommand(resp); background {
			runShellTurnBackground(p.bg, p.execDir, p.scratchDir, command, resp.TurnID, emit, p.job.Agent.Env)
			req = TurnCompleteRequest{TurnID: resp.TurnID, Status: stSucceeded, Result: "started in background", Subtype: "shell"}
		} else {
			var err error
			req, err = runSynchronousShellTurn(p.ctx, p.t, p.job, p.execDir, resp, emit)
			if err != nil {
				req = TurnCompleteRequest{TurnID: resp.TurnID, Status: stFailed, Result: err.Error(), Subtype: "shell"}
			}
			// A person's command and its output are context for their next message; an acceptance
			// command is the runner's own.
			if req.ShellOutput != nil && !resp.TaskAcceptance {
				shellContext = append(shellContext,
					fmt.Sprintf("<bash-input>%s</bash-input>\n<bash-stdout>%s</bash-stdout>", resp.Content, *req.ShellOutput))
			}
		}
		req.RuntimeSessionID = sessionID
		req.BranchSha = effectiveBranchSha(p.job.WT)
		if err := p.completeTurn(req); err != nil {
			logln("cursor shell turn-complete failed for", p.job.SessionID+":", err)
		}
		p.setTurn("")
		return true
	}
	for {
		if activeID == "" && len(queued) > 0 {
			next := queued[0]
			queued = queued[1:]
			run := start
			if next.Kind == "shell" {
				run = runShell
			}
			if !run(next) {
				return stCancelled, true, false
			}
			continue
		}
		select {
		case <-p.ctx.Done():
			if activeID != "" {
				stopped = true
				bridge.close()
				settle(<-promptDone)
			}
			return stCancelled, true, false
		case <-p.shutdownCtx.Done():
			if activeID != "" {
				stopped = true
				cancelTurn()
				settle(awaitPrompt())
			}
			return stCancelled, true, false
		case err := <-pollErrors:
			// Another owner holds the lease, and nothing more runs here on this session's behalf. A turn whose
			// answer — or the error its connection ended with — is in already settles on it; one still running
			// is the new owner's: it finds the turn prompted in the ledger and settles it without prompting it
			// again. Nothing of it goes out from here.
			bridge.close()
			if activeID != "" {
				select {
				case done := <-promptDone:
					settle(done)
				default:
					app.fail(err)
					mapper.abandon(activeID)
					<-promptDone
					activeID = ""
					p.setTurn("")
				}
			}
			app.fail(err)
			p.onLeaseLost(err)
			return stFailed, true, false
		case <-app.done:
			status := ""
			if activeID != "" {
				status = settle(<-promptDone)
			}
			return exited(status)
		case <-stopDeadline:
			// Cursor answers a cancel within milliseconds (§3.3): one that does not come is a CLI that can no
			// longer be talked to, so the process is ended, and the turn settles as Orbit stopped it.
			app.fail(errors.New("Cursor CLI did not answer a stopped prompt"))
			stopDeadline = nil
		case <-switched:
			// The model switched Cursor's mode itself, which Cursor approves asking nobody, and announces no
			// mode (§4.2): measured, an edit after a switch out of plan mode is written. The next prompt puts
			// the session back in its mode first; in Plan the turn is stopped where it is, before anything the
			// switch lets through can run.
			app.setMode("")
			if activeID != "" && !stopped && bridge.policy().ACPMode == "plan" {
				stopped = true
				refused = "Cursor CLI switched itself out of Plan mode, so Orbit stopped the turn before anything could run outside Plan."
				p.emitFor(activeID, evSystem, map[string]interface{}{"noticeKind": "cursor-plan-mode-left", "provider": providerCursor, "notice": refused})
				cancelTurn()
				stopDeadline = time.After(cursorStopGrace)
			}
		case done := <-promptDone:
			if status := settle(done); app.connectionClosed() {
				return exited(status)
			}
		case resp := <-inbox:
			switch resp.Kind {
			case "message", "shell":
				// One at a time, in order; a turn delivered again is the one already here.
				if poller.markInflight(resp.TurnID) {
					queued = append(queued, resp)
				}
			case "steer":
				refuseUnsupportedSteer(resp.TurnID, resp.Content, providerCursor, p.job, p.emitFor, p.completeTurn)
			case "interrupt":
				stopBackgroundWorkForTurn(p.bg, resp)
				p.emit(evInterrupt, map[string]interface{}{})
				if activeID != "" && !stopped {
					stopped = true
					cancelTurn()
					stopDeadline = time.After(cursorStopGrace)
				}
			case "end":
				if activeID != "" {
					stopped = true
					cancelTurn()
					settle(awaitPrompt())
				}
				return stSucceeded, true, false
			case "reload":
				before, beforeMode := cursorLaunchIdentity(p.job.Agent.Env), p.job.Agent.PermissionMode
				applyRuntimeReload(p.job, resp.Content)
				applyProviderEnv(p.job, resp)
				if next, err := cursorPermissionPolicyFor(p.job.Agent.PermissionMode); err != nil {
					// Not taken up: the session keeps the mode it runs in.
					p.emit(evError, map[string]interface{}{"message": err.Error()})
					p.job.Agent.PermissionMode = beforeMode
				} else {
					bridge.setPolicy(next)
				}
				// The workspace's variables, the credential among them, and the flags a permission mode starts
				// the CLI with (Bypass's --force) are the process's: a new process.
				if cursorLaunchIdentity(p.job.Agent.Env) != before ||
					strings.Join(cursorPermissionArgs(p.job.Agent.PermissionMode), " ") != strings.Join(cursorPermissionArgs(beforeMode), " ") {
					if activeID != "" {
						stopped = true
						bridge.close()
						app.fail(errors.New("the session's Cursor CLI launch changed"))
						settle(<-promptDone)
					}
					p.emit(evSystem, map[string]interface{}{"subtype": "reload", "reason": "launch_changed", "provider": providerCursor})
					return stCancelled, false, true
				}
				if err := app.configure(p.ctx, sessionID, p.job.Agent); err != nil {
					p.emit(evError, map[string]interface{}{"message": "failed to reconfigure the Cursor CLI session: " + err.Error()})
				}
				if err := app.enterMode(p.ctx, sessionID, bridge.policy().ACPMode); err != nil {
					p.emit(evError, map[string]interface{}{"message": "Cursor CLI did not change the session's mode; the next message tries again: " + err.Error()})
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
			default:
				reportUnknownInboxKind(resp, p.job, p.completeTurn)
			}
		}
	}
}
