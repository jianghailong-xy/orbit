package main

// Cursor CLI sessions over ACP (docs/cursor-runtime-contract.md §2, §3, §16.3, §16.4).
//
// Each Orbit session runs one resident `agent acp` of the pinned build, prepared by cursor_launch.go:
// newline-delimited JSON-RPC 2.0 on stdio. The process is initialized once and its conversation opened
// with session/new, whose id is the session's runtime session id. One prompt runs at a time: a
// session/prompt sent while another runs cancels it (§3.2), so a message that arrives mid-turn waits
// here for the turn to settle, and a steer is refused. Each turn settles once, on the prompt's answer —
// `end_turn` or `cancelled`, never with usage (§3.2) — so no turn reports a cost or a context reading.
//
// Not here yet: continuing a conversation in a new process (session/load) and reading the failures
// Cursor reports only as text (P5b); approvals through Orbit, Orbit's MCP server and instructions, and
// the permission modes (P5c). Until then every approval Cursor asks for is declined, so a command or an
// MCP call that needs one does not run.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
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
	code int
	text string
}

func (e *cursorCallError) Error() string { return e.text }

type cursorACPClient struct {
	cmd     *exec.Cmd
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

	// What initialize and the session's configuration reported; the session loop's alone.
	images        bool          // promptCapabilities.image: images may go in a prompt as they are
	configOptions []interface{} // the session's mode, model and the model's parameters
}

func startCursorACP(ctx context.Context, spec CursorLaunchSpec, mapper *cursorEventMapper, emit emitFn) (*cursorACPClient, error) {
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
	if err := startSessionProcess(cmd); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		_ = stderr.Close()
		cancel()
		return nil, err
	}
	a := &cursorACPClient{cmd: cmd, cancel: cancel, stdin: stdin, mapper: mapper, secrets: cursorLaunchSecrets(spec.Env),
		pending: map[string]cursorPending{}, writes: make(chan cursorWrite, 16), done: make(chan struct{}), readDone: make(chan struct{})}
	a.wg.Add(3)
	go func() { defer a.wg.Done(); defer close(a.readDone); a.readLoop(stdout) }()
	go func() { defer a.wg.Done(); a.writeLoop() }()
	go func() {
		defer a.wg.Done()
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
	if pending.method == "session/new" && msg.Error == nil {
		if id := firstString(rawObject(msg.Result), "sessionId"); id != "" {
			a.mapper.bind(id)
		}
	}
	pending.reply <- cursorRPCReply{message: msg}
}

// answer replies to a request Cursor CLI sends the client, from the reader, without waiting on
// anything: each has to be answered, or the turn that sent it waits forever (§4.2, §5.2).
func (a *cursorACPClient) answer(msg cursorRPCMessage) {
	var result interface{}
	switch msg.Method {
	case "session/request_permission", "cursor/ask_question":
		// No approval or question reaches a person from this runner yet: declined, so nothing runs.
		logln("cursor: declined", msg.Method, "(approvals are not bridged to Orbit yet)")
		result = map[string]interface{}{"outcome": map[string]interface{}{"outcome": "cancelled"}}
	case "cursor/create_plan":
		// Accepted with no planUri, the CLI saves the plan under its own HOME, the session's, and ends the
		// step (§4.2); the plan is on its card.
		result = map[string]interface{}{"outcome": map[string]interface{}{"outcome": "accepted"}}
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
		if detail := a.redact(kimiRPCErrorDetail(e.Data)); detail != "" && detail != e.Message {
			text += ": " + clip(detail, 300)
		}
		return nil, &cursorCallError{code: e.Code, text: text}
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

// open starts the session's conversation. mcpServers is required (§3.1); Orbit's own MCP server is not
// among them yet (P5c).
func (a *cursorACPClient) open(ctx context.Context, cwd string) (string, error) {
	result, err := a.call(ctx, "session/new", map[string]interface{}{"cwd": cwd, "mcpServers": []interface{}{}})
	if err != nil {
		return "", err
	}
	id := firstString(result, "sessionId")
	if id == "" {
		return "", errors.New("Cursor CLI's session/new returned no sessionId")
	}
	a.configOptions, _ = result["configOptions"].([]interface{})
	return id, nil
}

// configure puts the session on its model and effort with session/set_config_option, never --model
// (§10, §16.3): the model is the whole process's, and an unknown one passed as a flag ends it. A
// session that names no model stays on the one it runs on — Auto, for a new one — or goes back to Auto
// from another. An effort the model does not take is left at the model's own, as on Kimi: a session is
// not failed over a tuning knob.
func (a *cursorACPClient) configure(ctx context.Context, sessionID string, agent AgentExecConfig) error {
	model := strings.TrimSpace(agent.Model)
	current := firstString(cursorSessionOption(a.configOptions, "model"), "currentValue")
	if model == "" && current != "" && !cursorAutoModel(current) {
		model = "default"
	}
	if model != "" && model != current {
		if err := a.setOption(ctx, sessionID, "model", model); err != nil {
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
// after a grace (stopCursorProcess) — since closing stdin does not end it (§3.4). What the CLI wrote
// before it exited is read first: waiting for the process closes its stdout, and a title can still be on
// its way after the last turn (§3.2).
func (a *cursorACPClient) dispose() {
	a.fail(errors.New("the Cursor CLI process was stopped"))
	_ = a.cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-a.readDone:
	case <-time.After(cursorStopGrace):
	}
	stopCursorProcess(a.cmd, a.cancel)
	a.cancel()
	a.wg.Wait()
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
// first, as on every other engine.
func prepareCursorPrompt(ctx context.Context, t *Transport, job *ClaimedSession, resp *RunInboxResponse, images bool, shellContext []string) ([]map[string]interface{}, []map[string]interface{}) {
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
	if text != "" || len(blocks) == 0 {
		blocks = append([]map[string]interface{}{{"type": "text", "text": text}}, blocks...)
	}
	return blocks, refs
}

// cursorResumeUnsupported is what a session that has already talked is told when its process is gone.
// Its conversation continues in a new process only through session/load, which this runner does not
// do yet; a new conversation in its place would drop everything said so far.
const cursorResumeUnsupported = "This Cursor CLI session cannot continue on this Orbit runner yet: its Cursor CLI process has ended, " +
	"and this runner cannot reopen a Cursor CLI conversation in a new process. Start a new session to keep working."

// cursorStopGrace is how long a stopped prompt may take to answer before its process is ended instead;
// Cursor answers a session/cancel within milliseconds (§3.3).
const cursorStopGrace = 10 * time.Second

type cursorPromptResult struct {
	turnID string
	result map[string]interface{}
	err    error
}

func runCursorSessionProcess(p sessionProcessArgs) (string, bool, bool) {
	p.setTurn("")
	// Cursor reports no usage at all (§3.2, §4.1): no turn of it claims a measured $0.
	completeTurn := p.completeTurn
	p.completeTurn = func(req TurnCompleteRequest, providerContexts ...context.Context) error {
		req.UsageUnknown = true
		return completeTurn(req, providerContexts...)
	}
	fail := func(message string) (string, bool, bool) {
		p.emit(evError, map[string]interface{}{"message": message})
		return stFailed, true, false
	}
	if p.job.RuntimeSessionID != "" {
		return fail(cursorResumeUnsupported)
	}
	launch := p.cursorLaunchSpec
	if launch == nil {
		// A dispatched API key is checked before anything starts on it; the answer is kept on the key.
		report := func(sessionID string, report CursorKeyCheckReport) error {
			return p.t.cursorKeyCheck(sessionID, report)
		}
		spec, err := PrepareCursorSessionLaunch(p.ctx, p.job, p.execDir, report)
		if err != nil {
			return fail(err.Error())
		}
		launch = &spec
	}
	if !cursorLaunchSignsIn(launch.Env) {
		return fail("Failed to authenticate: Cursor CLI is not signed in on this runner, and this session brings no Cursor API key. " +
			"Sign in with: " + cursorLoginHint())
	}

	var naming sync.WaitGroup
	defer naming.Wait()
	mapper := newCursorEventMapper(p.emitFor)
	mapper.onTitle = func(title string) {
		// Only when the claim asks for it (session_naming.go): any other session's title is a person's,
		// a task's or the server's, which a title Cursor made up must not replace.
		if p.job.Naming == nil || p.t == nil {
			return
		}
		naming.Add(1)
		go func() {
			defer naming.Done()
			reportSessionNaming(p.t, p.job, title)
		}()
	}
	mapper.onCommands = func(names []string) { slashReg.learnFor(providerCursor, names, nil) }
	app, err := startCursorACP(p.ctx, *launch, mapper, p.emit)
	if err != nil {
		return fail("failed to start Cursor CLI: " + err.Error())
	}
	defer app.dispose()
	initCtx, initCancel := context.WithTimeout(p.ctx, 60*time.Second)
	defer initCancel()
	if err := app.initialize(initCtx); err != nil {
		return fail("Cursor CLI did not start its ACP server: " + err.Error())
	}
	sessionID, err := app.open(initCtx, launch.Cwd)
	if err != nil {
		var refused *cursorCallError
		if errors.As(err, &refused) && refused.code == -32000 {
			return fail("Failed to authenticate: " + err.Error())
		}
		return fail(err.Error())
	}
	p.job.RuntimeSessionID = sessionID
	writeSessionMeta(p.scratchDir, p.job, p.execDir)
	if err := app.configure(initCtx, sessionID, p.job.Agent); err != nil {
		return fail("failed to configure the Cursor CLI session: " + err.Error())
	}
	// The control plane keeps the runtime session id from this event (runtimeInitSessionId).
	p.emit(evSystem, map[string]interface{}{"subtype": "init", "provider": providerCursor, "runtime": "acp",
		"sessionId": sessionID, "cliVersion": launch.Version})

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

	promptDone := make(chan cursorPromptResult, 1)
	var promptWG sync.WaitGroup
	defer func() { app.fail(errors.New("the Cursor CLI session loop stopped")); promptWG.Wait() }()
	var activeID string
	stopped := false // the active turn was stopped here; it settles interrupted whatever Cursor answers
	seen := map[string]bool{}
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
	// report=false settles only here: after a lease loss the turn is the new owner's to settle.
	settle := func(done cursorPromptResult, report bool) string {
		result, err := done.result, done.err
		if stopped {
			result, err = map[string]interface{}{"stopReason": "cancelled"}, nil
		}
		req, ok := mapper.settle(done.turnID, result, err)
		if ok && report {
			worktree(&req)
			if err := p.completeTurn(req); err != nil {
				logln("cursor turn-complete failed for", p.job.SessionID+":", err)
			}
		}
		activeID, stopped = "", false
		p.setTurn("")
		return req.Status
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
	cancelTurn := func() {
		app.post(map[string]interface{}{"jsonrpc": "2.0", "method": "session/cancel",
			"params": map[string]interface{}{"sessionId": sessionID}})
	}
	start := func(resp *RunInboxResponse) bool {
		if !p.waitTurnPermit(p.ctx) {
			return false
		}
		if err := mapper.begin(resp.TurnID); err != nil {
			logln("cursor:", err)
			return true
		}
		activeID = resp.TurnID
		p.setTurn(activeID)
		blocks, refs := prepareCursorPrompt(p.ctx, p.t, p.job, resp, app.images, shellContext)
		shellContext = nil
		userEvent := map[string]interface{}{"text": resp.Content}
		if len(refs) > 0 {
			userEvent["attachments"] = refs
		}
		p.emitFor(activeID, evUser, userEvent)
		turnID := activeID
		promptWG.Add(1)
		go func() {
			defer promptWG.Done()
			result, err := app.prompt(p.ctx, sessionID, blocks)
			if err != nil {
				err = errors.New(app.redact(err.Error()))
			}
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
				settle(<-promptDone, true)
			}
			return stCancelled, true, false
		case <-p.shutdownCtx.Done():
			if activeID != "" {
				stopped = true
				cancelTurn()
				settle(awaitPrompt(), true)
			}
			return stCancelled, true, false
		case err := <-pollErrors:
			// Another owner holds the lease: nothing more runs here on this session's behalf, and the
			// turn is that owner's to settle.
			app.fail(err)
			if activeID != "" {
				stopped = true
				settle(<-promptDone, false)
			}
			p.onLeaseLost(err)
			return stFailed, true, false
		case <-app.done:
			exited := map[string]interface{}{"subtype": "process_exited", "provider": providerCursor, "runtimeSessionId": sessionID}
			if activeID == "" {
				p.emit(evSystem, exited)
				return stFailed, false, false
			}
			status := settle(<-promptDone, true)
			p.emit(evSystem, exited)
			// The prompt is not sent again: its tools may already have run.
			return stFailed, status == stFailed, false
		case done := <-promptDone:
			settle(done, true)
		case resp := <-inbox:
			switch resp.Kind {
			case "message", "shell":
				// One at a time, in order; a turn delivered again is the one already here.
				if !seen[resp.TurnID] {
					seen[resp.TurnID] = true
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
				}
			case "end":
				if activeID != "" {
					stopped = true
					cancelTurn()
					settle(awaitPrompt(), true)
				}
				return stSucceeded, true, false
			case "reload":
				before := cursorLaunchIdentity(p.job.Agent.Env)
				applyRuntimeReload(p.job, resp.Content)
				applyProviderEnv(p.job, resp)
				if cursorLaunchIdentity(p.job.Agent.Env) != before {
					// The workspace's variables, the credential among them, are the process's: a new process.
					if activeID != "" {
						stopped = true
						app.fail(errors.New("the session's Cursor CLI environment changed"))
						settle(<-promptDone, true)
					}
					p.emit(evSystem, map[string]interface{}{"subtype": "reload", "reason": "launch_changed", "provider": providerCursor})
					return stCancelled, false, true
				}
				if err := app.configure(p.ctx, sessionID, p.job.Agent); err != nil {
					p.emit(evError, map[string]interface{}{"message": "failed to reconfigure the Cursor CLI session: " + err.Error()})
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
