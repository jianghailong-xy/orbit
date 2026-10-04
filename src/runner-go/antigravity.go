package main

// Antigravity CLI (`agy`) runtime integration.
//
// One resident agy per session, driven headless in stream-json:
//
//	agy --gemini_dir=<session dir> --print= --input-format stream-json --output-format stream-json
//	    --disable-slash-commands --print-timeout=0s [--conversation <id>] [--model <m> --effort <e>]
//	    [--mode plan|accept-edits | --dangerously-skip-permissions]
//
// Each user message is one `{"event":"user",...}` line on a stdin that stays open, and each turn ends
// with one `result`: a turn boundary, not an exit. docs/antigravity-runtime-contract.md is what agy
// was measured to do; the § references below point into it.
//
// The agy process ends on an interrupt (SIGINT), on a model or API error, and when its stdin closes,
// but the conversation does not: the next process starts with --conversation <id> in the same Gemini
// directory and the whole history is there (§4). So this loop owns a process that comes and goes
// inside one engine generation, while the supervisor still sees one generation per claim.
//
// A message is written to agy only while no turn is running. agy would queue one written mid-turn
// and run it as the next turn (§8), but a queued line dies with the process when the turn is
// interrupted, so Orbit keeps the queue itself. A steer is refused: nothing can join a running turn.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// agyInterruptGrace is how long an interrupted agy has to write its `result` and exit before its
	// process tree is killed. It took 0.8–1.3s when measured (§4.1).
	agyInterruptGrace = 10 * time.Second
	// agyStopGrace is how long agy has to finish by itself once its stdin is closed.
	agyStopGrace = 5 * time.Second
)

// agyErrorReport is the `AGY_ERROR: {...}` line agy prints on stderr when a turn ends on a real error
// (§2.2): the machine-readable twin of result.error.
type agyErrorReport struct {
	ShortError string `json:"short_error"`
	Status     string `json:"status"`
	ErrorCode  int    `json:"error_code"`
	CodeKind   string `json:"code_kind"`
	Retryable  bool   `json:"retryable"`
	ErrorID    string `json:"error_id"`
}

// agyProcess is one agy process. Its stdout events arrive in order on events, which closes at EOF;
// exited closes once the process has been reaped and its process group is gone.
type agyProcess struct {
	cmd    *exec.Cmd
	cancel context.CancelFunc
	stdin  io.WriteCloser
	// requested is the conversation this process was started to continue ("" for a new one).
	requested string
	events    chan map[string]interface{}
	exited    chan struct{}
	// abandoned closes when the session loop stops reading events: the reader then drops them, so a
	// stream nobody consumes cannot hold agy's stdout, and its reaping, hostage.
	abandoned     chan struct{}
	abandonedOnce sync.Once

	// google is a process on the runner's Google sign-in: tokenCopy is the copy of it the process runs
	// on, removed once it has been reaped, and logFile agy's own log (classifyAgyAuthEnd).
	google    bool
	tokenCopy string
	logFile   string

	writeMu sync.Mutex

	mu         sync.Mutex
	agyErr     *agyErrorReport
	lastStderr string
	// authLines are the stderr lines that speak of authentication, for classifyAgyAuthEnd.
	authLines []string
	waitErr   error
	exitCode  int

	// Read and written by the session loop only.
	// gate is Orbit's approval gate when this process runs behind it, nil otherwise.
	gate        *agyApprovalGate
	initialized bool
	retiring    bool // interrupted or reconfigured: never written to again
	eventsDone  bool
}

func (p *agyProcess) noteError(report agyErrorReport) {
	p.mu.Lock()
	p.agyErr = &report
	p.mu.Unlock()
}

func (p *agyProcess) noteStderr(line string) {
	p.mu.Lock()
	p.lastStderr = line
	if strings.Contains(strings.ToLower(line), "authentication") && len(p.authLines) < 8 {
		p.authLines = append(p.authLines, line)
	}
	p.mu.Unlock()
}

// authEnd is what this process's end says about the Google sign-in it ran on (classifyAgyAuthEnd).
// Asked once it has been reaped; a process on an API key says nothing.
func (p *agyProcess) authEnd() agyAuthEnd {
	if !p.google {
		return agyAuthEndOther
	}
	p.mu.Lock()
	exitCode, stderr := p.exitCode, strings.Join(p.authLines, "\n")
	p.mu.Unlock()
	return classifyAgyAuthEnd(exitCode, p.initialized, stderr, readAgyLog(p.logFile))
}

func (p *agyProcess) errorReport() (*agyErrorReport, string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.agyErr, p.lastStderr
}

// exitDetail describes how the process ended, for a turn that it took down with it.
func (p *agyProcess) exitDetail() string {
	p.mu.Lock()
	waitErr := p.waitErr
	p.mu.Unlock()
	report, last := p.errorReport()
	reason := ""
	switch {
	case report != nil && report.ShortError != "":
		reason = report.ShortError
	case last != "":
		reason = strings.TrimPrefix(last, "error: ")
	}
	code := "exited"
	if waitErr != nil {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) && exitErr.ExitCode() >= 0 {
			code = "exited with code " + strconv.Itoa(exitErr.ExitCode())
		} else {
			code = waitErr.Error()
		}
	}
	if reason == "" {
		return "Antigravity " + code + " before finishing the turn"
	}
	return "Antigravity " + code + " before finishing the turn: " + reason
}

// send writes one stdin line without holding up the session loop: a large prompt can sit in the
// pipe while agy is busy. Only one frame is ever outstanding (a turn's), so order cannot suffer. A
// failed write means agy is gone, which the loop learns from its exit.
func (p *agyProcess) send(frame []byte) {
	go func() {
		p.writeMu.Lock()
		defer p.writeMu.Unlock()
		if _, err := p.stdin.Write(frame); err != nil {
			logln("antigravity: writing to agy failed:", err)
		}
	}()
}

// closeStdin asks agy to finish: it completes the turn it is on, then exits 0.
func (p *agyProcess) closeStdin() {
	go func() {
		p.writeMu.Lock()
		defer p.writeMu.Unlock()
		_ = p.stdin.Close()
	}()
}

// interrupt is the runner's Stop: SIGINT to agy's whole process group (interruptSessionProcessGroup).
// agy kills the command it is running, writes a `result` with error "interrupted", and exits 1.
func (p *agyProcess) interrupt() {
	if err := interruptSessionProcessGroup(p.cmd); err != nil && !errors.Is(err, os.ErrProcessDone) {
		logln("antigravity: interrupting agy failed:", err)
		p.cancel()
	}
}

// stop ends the process however it is doing: stdin closed first, so an idle agy exits on its own,
// then its tree killed if it has not after grace. Returns once it has been reaped.
func (p *agyProcess) stop(grace time.Duration) {
	p.abandonedOnce.Do(func() { close(p.abandoned) })
	p.closeStdin()
	select {
	case <-p.exited:
		return
	case <-time.After(grace):
	}
	p.cancel()
	<-p.exited
}

// agyStderrWriter turns agy's stderr into transcript lines. agy is quiet there: what it does print is
// a reason, and the four kinds this loop reports in its own words are kept out of the transcript so
// the reason is not shown twice.
type agyStderrWriter struct {
	proc *agyProcess
	emit emitFn
	buf  []byte
}

func (w *agyStderrWriter) Write(p []byte) (int, error) {
	w.buf = append(w.buf, p...)
	for {
		i := bytes.IndexByte(w.buf, '\n')
		if i < 0 {
			break
		}
		w.line(string(w.buf[:i]))
		w.buf = w.buf[i+1:]
	}
	if len(w.buf) > 64*1024 {
		w.flush()
	}
	return len(p), nil
}

func (w *agyStderrWriter) flush() {
	if len(w.buf) > 0 {
		w.line(string(w.buf))
		w.buf = nil
	}
}

func (w *agyStderrWriter) line(raw string) {
	line := strings.TrimRight(stripANSI(raw), "\r")
	if strings.TrimSpace(line) == "" {
		return
	}
	if rest, ok := strings.CutPrefix(line, "AGY_ERROR: "); ok {
		var report agyErrorReport
		if json.Unmarshal([]byte(rest), &report) == nil {
			w.proc.noteError(report)
			return
		}
	}
	w.proc.noteStderr(line)
	// Said in the loop's own words instead: the error a turn's result also carries (§2.4), a soft
	// denial (§5.2), a conversation --conversation could not find (§4.3), and a Google sign-in agy
	// refused, whose "Run 'agy' to log in" is not the way to sign in here (§16.4).
	if strings.HasPrefix(line, "error: ") || strings.HasPrefix(line, "jetski: no output produced") ||
		(strings.HasPrefix(line, "warning: conversation ") && strings.HasSuffix(line, " not found")) ||
		strings.HasPrefix(line, "Error: authentication required") {
		logln("antigravity:", line)
		return
	}
	w.emit(evSystem, map[string]interface{}{"stderr": line + "\n"})
}

// antigravityArgs is the argv for one agy process (§1.1). gated: Orbit's approval hook is confirmed
// in force for it (antigravityPermissionArgs).
func antigravityArgs(job *ClaimedSession, geminiDir string, gated bool) []string {
	args := []string{
		"--gemini_dir=" + geminiDir,
		// `--print=`, with the `=`: a bare --print followed by a flag is an error (§1.2).
		"--print=", "--input-format", "stream-json", "--output-format", "stream-json",
		// A message starting with "/" is text for the model; agy answering `/model` itself would end
		// the process (§10.1).
		"--disable-slash-commands",
		// No time limit on a turn, whatever agy's default becomes.
		"--print-timeout=0s",
	}
	if id := strings.TrimSpace(job.RuntimeSessionID); id != "" {
		args = append(args, "--conversation", id)
	}
	args = append(args, antigravityModelArgs(job.Agent.Model, job.Agent.Effort, antigravityCatalogModels())...)
	return append(args, antigravityPermissionArgs(job.Agent.PermissionMode, gated)...)
}

// antigravityEnv is agy's environment: the agent's on top of the runner's, the session context Orbit's
// own MCP server and CLI read, and the self-update switched off. HOME is left alone (§3).
func antigravityEnv(job *ClaimedSession, execDir string) []string {
	env := replaceEnv(envWithAgent(job.Agent.Env), map[string]string{
		"PWD":                       execDir,
		"ORBIT_SESSION_ID":          publicID(job.SessionID),
		"ORBIT_AGENT_ID":            publicID(job.AgentID),
		"ORBIT_TASK_ID":             publicID(job.TaskID),
		"ORBIT_ALLOW_ORCHESTRATION": orchestrationEnv(job.AllowOrchestration),
		envWatches:                  watchesEnv(job.WatchesDisabled),
		envWiki:                     wikiEnv(job.WikiDisabled),
		envMCPPermissionPrompt:      "0",
		// Without it every start spawns a detached `agy --bg-updater` that replaces the binary in
		// place, and only the lowercase "true" turns it off (§6). The binary changes when Orbit's
		// engine updater says so.
		"AGY_CLI_DISABLE_AUTO_UPDATE": "true",
	})
	// Runner-hosted background jobs (mcp__orbit__bg_run): `orbit mcp` inherits these through agy.
	// agy's own run_command can also leave a command running past its call (WaitMsBeforeAsync); that
	// one is agy's, and stops with agy.
	return append(env, bgJobEnvPairs(job.SessionID)...)
}

// startAgyProcess starts agy and the goroutines that read it. The process leads its own process
// group (configureSessionProcessTree): an interrupt signals the group, and every teardown — context
// cancel, the reaper below — kills the group and every descendant it can still see. gate is the
// approval gate the process runs behind, already confirmed (installAntigravityApprovalGate), or nil.
// google is a process on the copy of the runner's Google sign-in already in geminiDir: it gets the
// environment that keeps agy to it, and a log of its own (antigravityGoogleLogFile).
func startAgyProcess(ctx context.Context, job *ClaimedSession, execDir, geminiDir string, google bool, gate *agyApprovalGate, emit emitFn) (*agyProcess, error) {
	procCtx, cancel := context.WithCancel(ctx)
	args, env := antigravityArgs(job, geminiDir, gate != nil), antigravityEnv(job, execDir)
	if google {
		args = append(args, "--log-file="+antigravityGoogleLogFile(geminiDir))
		env = antigravityGoogleEnv(env, geminiDir)
	}
	cmd := exec.CommandContext(procCtx, agyExecutable, args...)
	configureSessionProcessTree(cmd)
	cmd.Dir = execDir
	cmd.Env = env
	p := &agyProcess{
		cmd:       cmd,
		cancel:    cancel,
		requested: strings.TrimSpace(job.RuntimeSessionID),
		events:    make(chan map[string]interface{}, 256),
		exited:    make(chan struct{}),
		abandoned: make(chan struct{}),
		gate:      gate,
		google:    google,
	}
	if google {
		p.tokenCopy, p.logFile = antigravityTokenFile(geminiDir), antigravityGoogleLogFile(geminiDir)
	}
	stderr := &agyStderrWriter{proc: p, emit: emit}
	// A writer rather than a pipe, so Wait itself drains stderr to the end: the AGY_ERROR line of a
	// failing turn is printed just before agy exits.
	cmd.Stderr = stderr
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
	p.stdin = stdin
	if err := startSessionProcess(cmd); err != nil {
		_ = stdin.Close()
		cancel()
		return nil, err
	}
	go func() {
		defer close(p.exited)
		defer cancel()
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" {
				continue
			}
			var event map[string]interface{}
			if err := json.Unmarshal([]byte(line), &event); err != nil {
				logln("antigravity: agy emitted invalid JSON:", firstLine(line))
				continue
			}
			select {
			case p.events <- event:
			case <-p.abandoned:
			}
		}
		if err := sc.Err(); err != nil {
			logln("antigravity: reading agy's output failed:", err)
		}
		close(p.events)
		// Reaps agy, then kills whatever is left in its process group — a hook's child that outlived
		// it, say (§4.1, §13).
		waitErr := waitSessionProcessTree(cmd)
		stderr.flush()
		// The sign-in copy lives exactly as long as the agy that runs on it.
		if p.tokenCopy != "" {
			if err := os.Remove(p.tokenCopy); err != nil && !errors.Is(err, os.ErrNotExist) {
				logln("antigravity: removing the session's Google sign-in copy failed:", err)
			}
		}
		exitCode := -1
		if cmd.ProcessState != nil {
			exitCode = cmd.ProcessState.ExitCode()
		}
		p.mu.Lock()
		p.waitErr = waitErr
		p.exitCode = exitCode
		p.mu.Unlock()
	}()
	return p, nil
}

// agyTurn is the Orbit turn agy is running.
type agyTurn struct {
	turnID       string
	acknowledged bool
	// text is each agent_response step's streamed text, by step index; all is the turn's text so far.
	text map[int]*strings.Builder
	all  strings.Builder
	// The tool steps seen, by step index: a tool_use is emitted once (toolsOpen holds its id), its
	// result once.
	toolsOpen map[int]string
	toolsDone map[int]bool
	// pending is the result of a tool step that finished with neither output nor error. It is sent
	// when the turn goes on; if the turn ends right after it instead, that tool was the one agy
	// refused (§5.2), and it is sent as the refusal.
	pending *agyToolResult
	// lastStep is the step_type of the turn's latest step, and lastTool the latest tool step.
	lastStep string
	lastTool *agyToolResult

	usage         TokenUsage
	contextTokens int
	errorStep     bool
	interrupted   bool
}

type agyToolResult struct {
	id, rawName, output, errText string
}

func newAgyTurn(turnID string) *agyTurn {
	return &agyTurn{
		turnID:    turnID,
		text:      map[int]*strings.Builder{},
		toolsOpen: map[int]string{},
		toolsDone: map[int]bool{},
	}
}

// handleAgyStep maps one step_update onto the transcript (§2.2).
func handleAgyStep(step map[string]interface{}, turn *agyTurn, emit emitFn) {
	kind := firstString(step, "step_type")
	state := strings.ToUpper(firstString(step, "state"))
	index := toInt(step["step_index"])
	conversation := firstString(step, "conversation_id")
	if kind != "tool" && turn.pending != nil {
		// The model answered after a tool that printed nothing (a write, say): an ordinary result.
		emitAgyToolResult(emit, *turn.pending, false)
		turn.pending = nil
	}
	switch kind {
	case "user_input":
		if state == "DONE" && !turn.acknowledged {
			turn.acknowledged = true
			emit(evUserDelivery, map[string]interface{}{
				"turnId": turn.turnID, "delivery": string(deliveryAcknowledged),
			})
		}
	case "agent_response":
		if delta, _ := step["text_delta"].(string); delta != "" {
			b := turn.text[index]
			if b == nil {
				b = &strings.Builder{}
				turn.text[index] = b
			}
			b.WriteString(delta)
			turn.all.WriteString(delta)
			emit(evTextDelta, map[string]interface{}{"text": delta})
		}
		if state == "DONE" {
			// A DONE without text is a model call that went on to call a tool: its usage counts,
			// nothing is said (§2.2).
			if b := turn.text[index]; b != nil && b.Len() > 0 {
				emit(evAssistant, map[string]interface{}{"text": b.String()})
			}
			delete(turn.text, index)
			if usage := mapValue(step["usage"]); usage != nil {
				// Each step's usage is that one model call (§9.3). Measured on 1.2.16 with the mock
				// answering prompt 1200 / cached 300 / output 40 / thoughts 7: input_tokens 900 — the
				// prompt without the cache reads, which come separately — and output_tokens 47, the
				// thinking included. claude's split, so the fields map one to one, and the context
				// the call filled is all three; total_tokens (947) leaves the cache reads out.
				input, cached, output := toInt(usage["input_tokens"]), toInt(usage["cache_read_tokens"]), toInt(usage["output_tokens"])
				turn.usage.InputTokens += input
				turn.usage.CacheReadInputTokens += cached
				turn.usage.OutputTokens += output
				if occupied := input + cached + output; occupied > 0 {
					turn.contextTokens = occupied
				}
			}
		}
	case "tool":
		info := mapValue(step["tool_info"])
		rawName := firstString(info, "name")
		if rawName == "" {
			rawName = firstString(step, "tool_name")
		}
		id := conversation + ":" + strconv.Itoa(index)
		if _, seen := turn.toolsOpen[index]; !seen {
			turn.toolsOpen[index] = id
			name, input := canonicalAgyTool(rawName, info["parameters"])
			emit(evToolUse, map[string]interface{}{"id": id, "name": name, "input": input})
		}
		if (state == "DONE" || state == "ERROR") && !turn.toolsDone[index] {
			turn.toolsDone[index] = true
			result := agyToolResult{id: id, rawName: rawName, output: asString(info["output"])}
			if state == "ERROR" {
				result.errText = firstString(mapValue(info["error"]), "message")
				if result.errText == "" {
					result.errText = "the tool failed"
				}
			}
			turn.lastTool = &result
			if state == "DONE" && result.output == "" {
				turn.pending = &result
			} else {
				emitAgyToolResult(emit, result, false)
			}
		}
	case "error_message":
		turn.errorStep = true
	default:
		// system_message is agy telling the model it restarted (§4.2), unknown is ask_question, which
		// headless agy answers itself with "User Skipped" (§10.2), checkpoint is a compaction marker.
		logUnhandledStreamKind("antigravity", kind, "system_message", "unknown", "checkpoint")
	}
	if kind != "" && kind != "user_input" {
		turn.lastStep = kind
	}
}

func emitAgyToolResult(emit emitFn, result agyToolResult, refused bool) {
	content, isError := result.output, false
	if result.errText != "" {
		content, isError = result.errText, true
	}
	if refused {
		content, isError = "Not run: "+agyRefusal(result.rawName), true
	}
	emit(evToolResult, map[string]interface{}{"toolUseId": result.id, "content": content, "isError": isError})
}

// closeUnansweredAgyTools gives each of the turn's tool calls that has no result one, marked as an
// error, in the order they were made. A turn cut short leaves the step agy was running ACTIVE for
// good — an interrupted command never reaches DONE (§4.1) — and a call with no result reads as still
// running for as long as the session is open.
func closeUnansweredAgyTools(emit emitFn, turn *agyTurn, content string) {
	var open []int
	for index := range turn.toolsOpen {
		if !turn.toolsDone[index] {
			open = append(open, index)
		}
	}
	sort.Ints(open)
	for _, index := range open {
		turn.toolsDone[index] = true
		emit(evToolResult, map[string]interface{}{"toolUseId": turn.toolsOpen[index], "content": content, "isError": true})
	}
}

// agyUnansweredToolText is the result of a tool call its turn ended under, by how the turn ended.
func agyUnansweredToolText(status string) string {
	switch status {
	case stInterrupted:
		return "Interrupted: the turn was stopped while this tool was running."
	case stFailed:
		return "Interrupted: the turn failed while this tool was running."
	}
	return "Interrupted: the turn ended while this tool was running."
}

// canonicalAgyTool names agy's tools the way Orbit's cards know them (§2.3). agy streams only a
// display subset of each call's parameters — no file contents, no diff — so a card shows what
// there is, and a file change shows up in the session's diff.
func canonicalAgyTool(name string, params interface{}) (string, interface{}) {
	p := mapValue(params)
	switch name {
	case "run_command":
		return "Bash", map[string]interface{}{"command": firstString(p, "CommandLine")}
	case "view_file":
		return "Read", map[string]interface{}{"file_path": firstString(p, "AbsolutePath")}
	case "write_to_file":
		return "Write", map[string]interface{}{"file_path": firstString(p, "TargetFile")}
	case "replace_file_content", "multi_replace_file_content":
		return "Edit", map[string]interface{}{"file_path": firstString(p, "TargetFile")}
	case "read_url_content":
		return "WebFetch", map[string]interface{}{"url": firstString(p, "Url", "URL", "url")}
	case "search_web":
		return "WebSearch", params
	case "call_mcp_tool":
		server, tool := firstString(p, "ServerName"), firstString(p, "ToolName")
		if server != "" && tool != "" {
			args := p["Arguments"]
			if args == nil {
				args = map[string]interface{}{}
			}
			return "mcp__" + server + "__" + tool, args
		}
	}
	if params == nil {
		params = map[string]interface{}{}
	}
	return name, params
}

// agyPermission is the permission agy asks for a tool, in its own words (§5.1).
func agyPermission(rawName string) string {
	switch rawName {
	case "run_command":
		return "command"
	case "write_to_file", "replace_file_content", "multi_replace_file_content":
		return "write_file"
	case "view_file":
		return "read_file"
	case "read_url_content", "search_web":
		return "read_url"
	case "call_mcp_tool":
		return "mcp"
	}
	return rawName
}

// agyRefusal is agy's own refusal, which only the modes that ask nobody see: in Default and Accept
// Edits a person decides through Orbit's approval hook instead.
func agyRefusal(rawName string) string {
	return "Antigravity refuses the \"" + agyPermission(rawName) + "\" permission in this session's permission mode, which does not ask for approval."
}

// agySoftDenied reports whether a turn ended because agy refused a tool nobody could approve (§5.2):
// no reply, a refusal on record, and the turn's last step that tool — the model never saw a result.
// denied_actions alone cannot say it: it is the whole conversation's set.
func agySoftDenied(turn *agyTurn, result map[string]interface{}) bool {
	if strings.TrimSpace(firstString(result, "response")) != "" || turn.lastStep != "tool" || turn.lastTool == nil {
		return false
	}
	denied, _ := result["denied_actions"].([]interface{})
	if len(denied) == 0 {
		return false
	}
	if turn.pending != nil {
		return true
	}
	text := strings.ToLower(turn.lastTool.errText)
	return strings.Contains(text, "denied permission") || strings.Contains(text, "permission check failed")
}

// antigravityErrorText is the reason a turn failed with, in the shape the clients key on: a rejected
// key reads as the sign-in failure it is (isAuthErrorText in @orbit/shared).
func antigravityErrorText(report *agyErrorReport, resultError string) string {
	text := strings.TrimSpace(resultError)
	if report != nil && strings.TrimSpace(report.ShortError) != "" {
		text = strings.TrimSpace(report.ShortError)
	}
	if text == "" {
		return "Antigravity reported an error"
	}
	if strings.Contains(text, "API_KEY_INVALID") || strings.Contains(text, "API key not valid") ||
		(report != nil && (report.ErrorCode == 401 || report.Status == "UNAUTHENTICATED")) {
		if !isAuthError(text) {
			return "Failed to authenticate: " + text
		}
	}
	return text
}

// agyDriver is the session loop's state: the process of the moment and the turn it is running.
type agyDriver struct {
	ctx          context.Context
	t            *Transport
	job          *ClaimedSession
	execDir      string
	scratchDir   string
	emit         emitFn
	setTurn      func(string)
	completeTurn turnCompleter

	proc *agyProcess
	turn *agyTurn
	// stopTimer runs while a retiring process is on its way out (interrupt, reload): if it fires
	// first, the process is killed with its tree.
	stopTimer *time.Timer
	ctxPing   contextPinger
	// gateBroken is why the approval gate stopped holding (breakGate): the session ends once the
	// process it broke in is gone.
	gateBroken string
	// signedOut is set once agy refused the runner's Google sign-in (signOut): the session ends.
	signedOut bool
}

// spawn starts the next agy, continuing the session's conversation if it has one. In the modes that
// ask, it does not start one until agy has confirmed Orbit's approval hook is loaded.
func (d *agyDriver) spawn() error {
	orbitExe := orbitCLIExecutable()
	auth := antigravitySessionAuth(d.job)
	google := auth == antigravityAuthGoogle
	logln("antigravity:", d.job.SessionID+":", "starting agy, auth source", auth)
	dir, err := prepareAntigravityGeminiDir(d.scratchDir, d.job, orbitExe, google)
	if err != nil {
		return fmt.Errorf("prepare the private Gemini directory: %w", err)
	}
	started := false
	defer func() {
		// No agy runs on the copy prepare made: it goes now rather than with a process's exit.
		if google && !started {
			if err := removeAntigravityToken(dir); err != nil {
				logln("antigravity: removing the session's Google sign-in copy failed:", err)
			}
		}
	}()
	var gate *agyApprovalGate
	if antigravityAsksForApproval(d.job.Agent.PermissionMode) {
		if gate, err = installAntigravityApprovalGate(d.ctx, d.job, d.execDir, dir, orbitExe, google); err != nil {
			return err
		}
	} else if err := removeAntigravityApprovalGate(dir); err != nil {
		return fmt.Errorf("remove the approval hook a mode that asked left behind: %w", err)
	}
	proc, err := startAgyProcess(d.ctx, d.job, d.execDir, dir, google, gate, d.emit)
	if err != nil {
		return err
	}
	started = true
	d.proc = proc
	return nil
}

// signOut reports the session signed out: agy refused the runner's Google sign-in. Reported the way
// a signed-out claude or codex is before it spawns (engineAuthPreflight): the turn — or, between
// turns, the session — fails with an authentication failure, which the transcript answers with its
// sign-in card, and the session ends. The runner re-probes its engines at once, so the heartbeat
// carries the sign-out the control plane notifies on.
func (d *agyDriver) signOut() {
	d.signedOut = true
	logln("antigravity:", d.job.SessionID+":", "agy refused this runner's Google sign-in; the session ends signed out")
	if d.turn != nil {
		d.failTurn(antigravityGoogleSignedOutMessage)
	} else {
		d.emit(evError, map[string]interface{}{"message": antigravityGoogleSignedOutMessage})
	}
	noteEngineSignedOut()
}

// breakGate stops a process whose approval gate no longer holds (agyApprovalGate.check): its turn
// fails with the reason, agy is interrupted — which stops a command it is running — and the session
// ends with it rather than go on with nobody in the loop.
func (d *agyDriver) breakGate(problem string) {
	d.gateBroken = "Orbit stopped Antigravity because its approval hook is no longer in force: " + problem +
		". Without it nothing would ask before agy acts, so this session cannot go on."
	logln("antigravity:", d.job.SessionID+":", d.gateBroken)
	if d.turn != nil {
		d.failTurn(d.gateBroken)
	} else {
		d.emit(evError, map[string]interface{}{"message": d.gateBroken})
	}
	if p := d.proc; p != nil && !p.retiring {
		p.retiring = true
		p.interrupt()
		if d.stopTimer == nil {
			d.stopTimer = time.NewTimer(agyInterruptGrace)
		}
	}
}

// events and exited are the select cases for the current process: its events until they are all
// read, then its exit — so the last `result` is always handled before the exit that follows it.
func (d *agyDriver) events() <-chan map[string]interface{} {
	if d.proc == nil || d.proc.eventsDone {
		return nil
	}
	return d.proc.events
}

func (d *agyDriver) exited() <-chan struct{} {
	if d.proc == nil || !d.proc.eventsDone {
		return nil
	}
	return d.proc.exited
}

func (d *agyDriver) stopTimerC() <-chan time.Time {
	if d.stopTimer == nil {
		return nil
	}
	return d.stopTimer.C
}

// retire stops writing to the current process and lets it finish by itself: the next turn starts
// a new one. Used when the process's flags no longer describe the session. An idle agy exits at
// once on a closed stdin; one that does not is killed after agyStopGrace, so the next turn is
// never left waiting on it.
func (d *agyDriver) retire() {
	if d.proc != nil && !d.proc.retiring {
		d.proc.retiring = true
		d.proc.closeStdin()
		if d.stopTimer == nil {
			d.stopTimer = time.NewTimer(agyStopGrace)
		}
	}
}

func (d *agyDriver) handleEvent(event map[string]interface{}) {
	switch firstString(event, "event") {
	case "init":
		d.handleInit(event)
	case "step_update":
		step := mapValue(event["step_update"])
		if step == nil {
			return
		}
		// Every step, a turn's or not: agy can call the model by itself between turns.
		if p := d.proc; p != nil && p.gate != nil && d.gateBroken == "" {
			if problem := p.gate.check(step); problem != "" {
				d.breakGate(problem)
				return
			}
		}
		if d.turn == nil {
			return
		}
		handleAgyStep(step, d.turn, d.emit)
		d.ctxPing.ping(func(eventType string, payload map[string]interface{}) {
			d.emit(eventType, withAntigravityContextWindow(payload, d.job))
		}, d.turn.contextTokens, d.job)
	case "result":
		if d.turn == nil {
			return
		}
		result := mapValue(event["result"])
		// A Google sign-in agy could not use ends the process before any init (§16.4). Whether it was
		// refused or the network failed is known once the process has exited, so the turn waits for
		// that (processExited); the process gets nothing more to do.
		if p := d.proc; p != nil && p.google && !p.initialized && firstString(result, "error") == "authentication failed or timed out" {
			d.retire()
			return
		}
		d.finishTurn(result, "")
	default:
		logUnhandledStreamKind("antigravity", firstString(event, "event"))
	}
}

// handleInit learns the conversation the process is on. Asked to continue one, agy silently starts
// a new conversation when it cannot find it (§4.3): the id is the only sign, so the session is told
// its earlier context is gone, and the new id is kept.
func (d *agyDriver) handleInit(event map[string]interface{}) {
	p := d.proc
	if p == nil {
		return
	}
	id := firstString(event, "conversation_id")
	p.initialized = true
	if id == "" {
		return
	}
	if p.requested != "" && id != p.requested {
		d.emit(evSystem, map[string]interface{}{
			"notice": "Antigravity could not find this session's earlier conversation (" + p.requested +
				") and started a new one: what was said before is not in its context.",
			"noticeKind": "antigravity-conversation-lost",
		})
	}
	if d.job.RuntimeSessionID != id {
		d.job.RuntimeSessionID = id
		writeSessionMeta(d.scratchDir, d.job, d.execDir)
	}
	d.emit(evSystem, map[string]interface{}{"subtype": "init", "sessionId": id, "provider": providerAntigravity})
}

// startTurn hands a message to agy, starting a process first if there is none.
func (d *agyDriver) startTurn(resp *RunInboxResponse, pendingShellCtx []string) {
	d.setTurn(resp.TurnID)
	d.turn = newAgyTurn(resp.TurnID)
	text, refs := prepareAntigravityPrompt(d.ctx, d.t, d.job, resp, pendingShellCtx)
	userEvent := map[string]interface{}{"text": resp.Content}
	if len(refs) > 0 {
		userEvent["attachments"] = refs
	}
	d.emit(evUser, userEvent)
	if d.proc == nil {
		if err := d.spawn(); errors.Is(err, errAgySignInRefused) {
			d.signOut()
			return
		} else if errors.Is(err, errAgySignInUnchecked) {
			d.failTurn(antigravityGoogleUnreachableMessage)
			return
		} else if err != nil {
			d.failTurn("failed to start Antigravity: " + err.Error())
			return
		}
	}
	frame, err := json.Marshal(map[string]interface{}{
		"event":   "user",
		"message": map[string]interface{}{"content": text},
	})
	if err != nil {
		d.failTurn("encode the message for Antigravity: " + err.Error())
		return
	}
	d.proc.send(append(frame, '\n'))
}

// prepareAntigravityPrompt is a turn's text. agy's stream-json input takes text only (§1.1), so every
// attachment — images included — is saved beside the session and named in the prompt for agy's own
// tools to open.
func prepareAntigravityPrompt(ctx context.Context, t *Transport, job *ClaimedSession, resp *RunInboxResponse, pendingShellCtx []string) (string, []map[string]interface{}) {
	var refs []map[string]interface{}
	var paths []string
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
		paths = append(paths, path)
		refs = append(refs, map[string]interface{}{"id": att.ID, "mime": att.MimeType, "name": att.FileName})
	}
	text := resp.Content
	if len(pendingShellCtx) > 0 {
		text = strings.Join(pendingShellCtx, "\n") + "\n\n" + text
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
	return text, refs
}

// interrupt is Stop on a running turn: the process group gets SIGINT, the turn ends INTERRUPTED with
// the `result` agy writes for it, and the next turn starts a new process on the same conversation
// (§4.1). A process still running after the grace is killed with its tree.
func (d *agyDriver) interrupt() {
	if d.turn == nil {
		return
	}
	d.turn.interrupted = true
	if d.proc == nil {
		return
	}
	d.proc.retiring = true
	d.proc.interrupt()
	if d.stopTimer == nil {
		d.stopTimer = time.NewTimer(agyInterruptGrace)
	}
}

// failTurn ends the running turn on something that is not agy's answer.
func (d *agyDriver) failTurn(message string) {
	d.finishTurn(nil, message)
}

// finishTurn settles the running turn: from its `result`, or with failure set when there is none
// (§2.4). result.status is not read: once a conversation has hit a real error, agy reports every
// later turn as ERROR with that old error.
func (d *agyDriver) finishTurn(result map[string]interface{}, failure string) {
	turn := d.turn
	if turn == nil {
		return
	}
	status, subtype, errText := stSucceeded, "success", ""
	resultError := firstString(result, "error")
	switch {
	case turn.interrupted || (result != nil && resultError == "interrupted"):
		status, subtype = stInterrupted, "interrupted"
	case failure != "":
		status, subtype, errText = stFailed, "error", failure
	case turn.errorStep || (d.proc != nil && !d.proc.initialized):
		// A process that never initialized failed to start (an invalid --model, say): agy says so
		// in a `result` and exits.
		var report *agyErrorReport
		if d.proc != nil {
			report, _ = d.proc.errorReport()
		}
		status, subtype, errText = stFailed, "error", antigravityErrorText(report, resultError)
	case agySoftDenied(turn, result):
		status, subtype = stFailed, "permission_denied"
		errText = "This turn stopped at a tool that was not allowed to run: " + agyRefusal(turn.lastTool.rawName) +
			" To let it run, switch the session to Default or Accept Edits (you are asked first) or Bypass permissions, or allow it with a permission rule."
	}
	if turn.pending != nil {
		emitAgyToolResult(d.emit, *turn.pending, subtype == "permission_denied")
		turn.pending = nil
	}
	// Whatever agy says about a step after this goes nowhere: the turn is over.
	closeUnansweredAgyTools(d.emit, turn, agyUnansweredToolText(status))
	if errText != "" {
		d.emit(evError, map[string]interface{}{"message": errText})
	}
	resultText := strings.TrimSpace(firstString(result, "response"))
	if resultText == "" {
		resultText = strings.TrimSpace(turn.all.String())
	}
	d.emit(evTurnEnd, withAntigravityContextWindow(map[string]interface{}{
		"subtype":  subtype,
		"numTurns": 1, // agy's num_turns counts the whole conversation
		// agy reports no cost.
		"costUsd":       0,
		"contextTokens": turn.contextTokens,
	}, d.job))
	usage := turn.usage
	liveFiles, livePatches := liveDiff(d.job.WT)
	if err := d.completeTurn(TurnCompleteRequest{
		TurnID:           turn.turnID,
		Status:           status,
		Result:           resultText,
		Error:            errText,
		Subtype:          subtype,
		NumTurns:         1,
		Usage:            &usage,
		RuntimeSessionID: currentRuntimeSessionID(d.job),
		IsolationStatus:  d.job.IsolationStatus,
		ChangedFiles:     liveFiles,
		ChangedDiff:      livePatches,
		BaseSha:          d.job.WT.baseSha(),
		WorktreeDirty:    worktreeIsDirty(d.job.WT),
		BranchSha:        effectiveBranchSha(d.job.WT),
		BranchMerged:     branchMergedInto(d.job.WT),
		WorktreeBranch:   currentBranch(d.job.WT),
	}); err != nil {
		logln("turn-complete failed for", d.job.SessionID+":", err)
	}
	d.turn = nil
	d.setTurn("")
}

// processExited handles the current process going away: its turn, if one was still running, ends
// with it, and the next turn starts a new process — unless agy refused the runner's Google sign-in,
// which ends the session signed out (signOut).
func (d *agyDriver) processExited() {
	p := d.proc
	if d.stopTimer != nil {
		d.stopTimer.Stop()
		d.stopTimer = nil
	}
	switch end := p.authEnd(); {
	case end == agyAuthEndRefused:
		d.signOut()
	case end == agyAuthEndNetwork && d.turn != nil:
		d.finishTurn(nil, antigravityGoogleUnreachableMessage)
	case end == agyAuthEndNetwork:
		logln("antigravity: agy for", d.job.SessionID, "could not check this runner's Google sign-in (a network error); the next turn tries again")
	case d.turn != nil:
		d.finishTurn(nil, p.exitDetail())
	case !p.retiring:
		logln("antigravity: agy for", d.job.SessionID, "stopped between turns ("+p.exitDetail()+"); the next turn resumes the conversation")
	}
	d.proc = nil
}

// withAntigravityContextWindow is withContextWindow with agy's own table as the fallback: a session
// on agy's default model names none, and one that names a full slug ("…-high") is not a catalog row.
func withAntigravityContextWindow(payload map[string]interface{}, job *ClaimedSession) map[string]interface{} {
	payload = withContextWindow(payload, job)
	if _, ok := payload["contextWindow"]; !ok {
		if w := antigravityContextWindow(job.Agent.Model); w > 0 {
			payload["contextWindow"] = w
		}
	}
	return payload
}

type agyInboxResult struct {
	response *RunInboxResponse
	err      error
}

// runAntigravitySessionProcess drives one engine generation of an Antigravity session.
func runAntigravitySessionProcess(ctx context.Context, shutdownCtx context.Context, t *Transport, job *ClaimedSession, leaseGeneration, execDir, scratchDir string, emit emitFn, emitFor emitTurnFn, setTurn func(string), _ bool, bg *bgTailer, completeTurn turnCompleter, waitTurnPermit turnPermitWaiter, onLeaseLost leaseLossHandler) (string, bool, bool) {
	setTurn("")
	if err := guardAntigravityProjectConfig(execDir, job.Agent.PermissionMode); err != nil {
		emit(evError, map[string]interface{}{"message": err.Error()})
		return stFailed, true, false
	}
	d := &agyDriver{
		ctx: ctx, t: t, job: job, execDir: execDir, scratchDir: scratchDir,
		emit: emit, setTurn: setTurn, completeTurn: completeTurn,
	}
	defer func() {
		if d.stopTimer != nil {
			d.stopTimer.Stop()
		}
		if d.proc != nil {
			d.proc.stop(agyStopGrace)
		}
	}()
	// Started before the first message so the conversation exists, and its id is known, as soon as
	// the session runs.
	if err := d.spawn(); errors.Is(err, errAgySignInRefused) {
		d.signOut()
		return stFailed, true, false
	} else if errors.Is(err, errAgySignInUnchecked) {
		// As when the session's own agy meets it (processExited): the first turn tries again.
		logln("antigravity: agy for", job.SessionID, "could not check this runner's Google sign-in (a network error); the next turn tries again")
	} else if err != nil {
		emit(evError, map[string]interface{}{"message": "failed to start Antigravity: " + err.Error()})
		return stFailed, true, false
	}

	inboxCtx, stopInbox := contextUntilEither(ctx, shutdownCtx)
	defer stopInbox()
	inboxCh := make(chan agyInboxResult, 16)
	go func() {
		for inboxCtx.Err() == nil {
			resp, err := t.inbox(inboxCtx, job.SessionID, leaseGeneration)
			select {
			case inboxCh <- agyInboxResult{response: resp, err: err}:
			case <-inboxCtx.Done():
				return
			}
			// A superseded generation never regains ownership: stop rather than spin on 409s.
			if err != nil && isLeaseOwnershipError(err) {
				return
			}
			if err != nil && inboxCtx.Err() == nil {
				select {
				case <-time.After(time.Second):
				case <-inboxCtx.Done():
					return
				}
			}
		}
	}()

	var queued []*RunInboxResponse
	queuedIDs := map[string]bool{}
	seen := map[string]bool{}
	var pendingShellCtx []string
	var pendingReloads []*RunInboxResponse
	endRequested := false
	draining := false
	var drainTimer <-chan time.Time
	shutdownDone := shutdownCtx.Done()

	applyReloads := func() {
		if len(pendingReloads) == 0 {
			return
		}
		for _, reload := range pendingReloads {
			applyRuntimeReload(job, reload.Content)
			applyProviderEnv(job, reload)
		}
		pendingReloads = nil
		// Model, effort, permission mode and environment are all fixed when agy starts.
		d.retire()
		emit(evSystem, map[string]interface{}{"subtype": "resumed", "reason": "config_changed"})
	}

	// handleIdle runs one inbox item while no turn is running. done ends this generation with status.
	handleIdle := func(resp *RunInboxResponse) (status string, done bool) {
		switch resp.Kind {
		case "message":
			if seen[resp.TurnID] {
				return "", false
			}
			// The permit is also lost when the session detaches or leaves the pool, which does not
			// cancel ctx: end here rather than go on taking messages nobody may run.
			if !waitTurnPermit(ctx) {
				return stCancelled, true
			}
			seen[resp.TurnID] = true
			d.startTurn(resp, pendingShellCtx)
			pendingShellCtx = nil
		case "shell":
			if seen[resp.TurnID] {
				return "", false
			}
			if !waitTurnPermit(ctx) {
				return stCancelled, true
			}
			seen[resp.TurnID] = true
			setTurn(resp.TurnID)
			if command, background := shellTurnBackgroundCommand(resp); background {
				runShellTurnBackground(bg, execDir, scratchDir, command, resp.TurnID, emit, job.Agent.Env)
				if err := completeTurn(TurnCompleteRequest{
					TurnID: resp.TurnID, Status: stSucceeded, Result: "started in background", Subtype: "shell",
					RuntimeSessionID: currentRuntimeSessionID(job), BranchSha: effectiveBranchSha(job.WT),
				}); err != nil {
					logln("shell turn-complete failed for", job.SessionID+":", err)
				}
			} else {
				// A runner stop leaves the command the drain budget an active turn gets.
				shellCtx, stopShell := contextWithStopGrace(ctx, shutdownCtx, shutdownDrainTimeout)
				req, shellErr := runSynchronousShellTurn(shellCtx, t, job, execDir, resp, emit)
				stopShell()
				if shellErr != nil {
					logln("executable shell start failed for", job.SessionID+":", shellErr)
					req = TurnCompleteRequest{TurnID: resp.TurnID, Status: stFailed, Result: shellErr.Error(), Subtype: "shell"}
				}
				if req.ShellOutput != nil {
					pendingShellCtx = append(pendingShellCtx, fmt.Sprintf("<bash-input>%s</bash-input>\n<bash-stdout>%s</bash-stdout>", resp.Content, *req.ShellOutput))
				}
				req.RuntimeSessionID = currentRuntimeSessionID(job)
				req.BranchSha = effectiveBranchSha(job.WT)
				if err := completeTurn(req); err != nil {
					logln("shell turn-complete failed for", job.SessionID+":", err)
				}
			}
			setTurn("")
		case "steer":
			refuseUnsupportedSteer(resp.TurnID, resp.Content, providerAntigravity, job, emitFor, completeTurn)
		case "interrupt":
			emit(evInterrupt, map[string]interface{}{})
		case "reload":
			pendingReloads = append(pendingReloads, resp)
			applyReloads()
		case "diff":
			reportOpenCodeDiff(inboxCtx, t, job)
		case "end":
			return stSucceeded, true
		default:
			reportUnknownInboxKind(resp, job, completeTurn)
		}
		return "", false
	}

	for {
		// Between turns, queued work runs once the process it would be written to — if one is on its
		// way out — is gone: a new process must not open the conversation while the old one still has it.
		if d.turn == nil && (d.proc == nil || !d.proc.retiring) {
			if d.gateBroken != "" || d.signedOut {
				return stFailed, true, false
			}
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
				if status, done := handleIdle(resp); done {
					return status, true, false
				}
				continue
			}
		}
		select {
		case <-ctx.Done():
			return stCancelled, true, false
		case <-shutdownDone:
			shutdownDone = nil
			draining = true
			stopInbox()
			drainTimer = time.After(shutdownDrainTimeout)
		case <-drainTimer:
			logln("Antigravity drain timeout for", job.SessionID+"; stopping the running turn")
			return stCancelled, true, false
		case <-d.stopTimerC():
			d.stopTimer = nil
			if d.proc != nil && d.proc.retiring {
				logln("antigravity: agy did not stop when asked; killing its process tree")
				d.proc.cancel()
			}
		case event, ok := <-d.events():
			if !ok {
				d.proc.eventsDone = true
				continue
			}
			d.handleEvent(event)
			if d.turn == nil {
				applyReloads()
			}
		case <-d.exited():
			d.processExited()
			if d.turn == nil {
				applyReloads()
			}
		case item := <-inboxCh:
			if item.err != nil {
				if isLeaseOwnershipError(item.err) {
					stopInbox()
					onLeaseLost(item.err)
					return stCancelled, true, false
				}
				if inboxCtx.Err() == nil {
					logln("inbox poll failed for", job.SessionID+":", item.err)
				}
				continue
			}
			resp := item.response
			if resp == nil || draining {
				continue
			}
			if d.turn == nil && (d.proc == nil || !d.proc.retiring) && len(queued) == 0 {
				if status, done := handleIdle(resp); done {
					return status, true, false
				}
				continue
			}
			switch resp.Kind {
			case "interrupt":
				emit(evInterrupt, map[string]interface{}{})
				d.interrupt()
			case "steer":
				refuseUnsupportedSteer(resp.TurnID, resp.Content, providerAntigravity, job, emitFor, completeTurn)
			case "end":
				endRequested = true
				queued, queuedIDs = nil, map[string]bool{}
				d.interrupt()
			case "reload":
				// agy's flags are fixed for its life; the change applies from the next process.
				pendingReloads = append(pendingReloads, resp)
			case "diff":
				reportOpenCodeDiff(inboxCtx, t, job)
			default:
				if resp.TurnID != "" && !seen[resp.TurnID] && !queuedIDs[resp.TurnID] && !endRequested &&
					(d.turn == nil || resp.TurnID != d.turn.turnID) {
					queued = append(queued, resp)
					queuedIDs[resp.TurnID] = true
				}
			}
		}
	}
}

// reportUnknownInboxKind settles an inbox turn of a kind this runner does not know: the arm a control
// plane newer than the runner reaches. Reported as that turn's failure, never the session's
// (subtypeUnknownKind) — same as the claude loop.
func reportUnknownInboxKind(resp *RunInboxResponse, job *ClaimedSession, completeTurn turnCompleter) {
	logln(fmt.Sprintf("interactive run %s — ignoring an inbox turn of unknown kind %q; this runner is older than the control plane that sent it", job.SessionID, resp.Kind))
	if err := completeTurn(TurnCompleteRequest{
		TurnID:           resp.TurnID,
		Status:           stFailed,
		Result:           fmt.Sprintf("this runner does not understand turns of kind %q; upgrade the runner", resp.Kind),
		Subtype:          subtypeUnknownKind,
		RuntimeSessionID: currentRuntimeSessionID(job),
		BranchSha:        effectiveBranchSha(job.WT),
	}); err != nil {
		logln("unknown-kind turn-complete failed for", job.SessionID+":", err)
	}
}
