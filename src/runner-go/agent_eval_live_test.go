package main

// The black-box half of the agent-contract eval (docs/agent-contract-eval.md §Layers): the real engine, at the version
// this machine has, with a real model, in a session spawned the way the runner spawns one, against the eval's
// control plane. Nothing reaches an Orbit account; the engine reaches its model provider with the login this
// machine's runner gives its own sessions, so a run costs what a session's turns cost.
//
//   - Claude Code: production's claudeCommandArgs (the instructions carriers, the MCP config naming this binary as
//     `orbit mcp`, the allowlist, the permission prompt, the hooks, the playbooks plugin), spawnClaude and its
//     stream read through handleMessage, the runner's own translation into run events. A mode switch is the
//     set_permission_mode control request the supervisor sends; a compaction is the person's "/compact"; a resume
//     is a new process with --resume.
//   - Codex: production's startCodexAppServer and handshake (codexAppServerCommandArgs, the shared state partition
//     the runner's sessions use, under its own lock), thread and turn builders, the application context, the managed
//     skill root, handleCodexAppNotification, and bridgeCodexApprovalWithContext pointed at the eval's control plane,
//     so a consent Orbit does not answer itself becomes a card the eval's owner answers. A compaction is
//     thread/compact/start; a resume is a new app-server with thread/resume.
//
// TestAgentEvalLive runs only when ORBIT_AGENT_EVAL=live; scripts/agent-eval.sh is how to run it.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const (
	evalLiveEnv        = "ORBIT_AGENT_EVAL"
	evalEnginesEnv     = "ORBIT_AGENT_EVAL_ENGINES"
	evalScenariosEnv   = "ORBIT_AGENT_EVAL_SCENARIOS"
	evalRepeatsEnv     = "ORBIT_AGENT_EVAL_REPEATS"
	evalClaudeModelEnv = "ORBIT_AGENT_EVAL_CLAUDE_MODEL"
	evalCodexModelEnv  = "ORBIT_AGENT_EVAL_CODEX_MODEL"
	evalEffortEnv      = "ORBIT_AGENT_EVAL_EFFORT"
	evalReportEnv      = "ORBIT_AGENT_EVAL_REPORT"
	evalBaselineEnv    = "ORBIT_AGENT_EVAL_BASELINE"
	evalTurnTimeoutEnv = "ORBIT_AGENT_EVAL_TURN_TIMEOUT"
	evalRepoSHAEnv     = "ORBIT_AGENT_EVAL_REPO_SHA"
	evalRunnerHomeEnv  = "ORBIT_AGENT_EVAL_RUNNER_HOME"
	evalClaudeBinEnv   = "ORBIT_AGENT_EVAL_CLAUDE_BIN"
	evalCodexBinEnv    = "ORBIT_AGENT_EVAL_CODEX_BIN"
	// evalTranscriptsEnv names a directory each live run's transcript is kept in, for TestAgentEvalRegrade. A
	// transcript holds the engine's words and the tools' answers: it is a local diagnostic, never part of a report,
	// never uploaded or committed.
	evalTranscriptsEnv = "ORBIT_AGENT_EVAL_TRANSCRIPTS"
)

// evalTranscript is one live run as it was played, everything a newer grader needs to judge it again.
type evalTranscript struct {
	ScenarioHash string `json:"scenarioHash"`
	// RepoSHA is the commit the run was played on: what a report regraded from it describes.
	RepoSHA       string           `json:"repoSha,omitempty"`
	Scenario      string           `json:"scenario"`
	Engine        string           `json:"engine"`
	Backend       string           `json:"backend"`
	EngineVersion string           `json:"engineVersion"`
	Model         string           `json:"model"`
	Repeat        int              `json:"repeat"`
	Exe           string           `json:"exe"`
	Orchestration bool             `json:"orchestration"`
	World         evalWorldIDs     `json:"world"`
	Turns         []evalTurnLog    `json:"turns"`
	Events        []evalEvent      `json:"events"`
	Ledger        evalLedger       `json:"ledger"`
	ToolsListed   []string         `json:"toolsListed"`
	Context       evalContextBytes `json:"context"`
	HarnessError  string           `json:"harnessError,omitempty"`
	DurationMs    int              `json:"durationMs"`
	Skip          *evalSkip        `json:"skip,omitempty"`
	Files         []string         `json:"files,omitempty"`
	// LeftOut is the instruction units the run was played without (ORBIT_AGENT_EVAL_LEAVE_OUT).
	LeftOut []string `json:"leftOut,omitempty"`
}

func writeEvalTranscript(dir string, tr evalTranscript) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	name := strings.NewReplacer("/", "_", "@", "_").Replace(fmt.Sprintf("%s-%s-%s-%s-%d", tr.Engine, tr.EngineVersion, tr.Model, tr.Scenario, tr.Repeat))
	raw, err := json.Marshal(tr)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, name+".json"), raw, 0o600)
}

// evalPinEngine puts bin first on the eval process's PATH as name, for the run: the spawn sites resolve their engine
// off PATH (spawnClaude, startCodexAppServer), which is how one machine measures two versions of one engine. It
// answers the binary the run will spawn.
func evalPinEngine(s *evalSession, name, bin string) (string, error) {
	if bin == "" {
		exe, ok := lookPathIn(name, runnerEnginePath(userHome(), os.Getenv("PATH")))
		if !ok {
			return "", fmt.Errorf("no %s binary on this machine", name)
		}
		return exe, nil
	}
	dir := filepath.Join(s.home, "engine-bin")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if err := os.Symlink(bin, filepath.Join(dir, name)); err != nil && !os.IsExist(err) {
		return "", err
	}
	previous := os.Getenv("PATH")
	_ = os.Setenv("PATH", dir+string(os.PathListSeparator)+previous)
	s.cleanup = append(s.cleanup, func() { _ = os.Setenv("PATH", previous) })
	return bin, nil
}

var evalVersionRE = regexp.MustCompile(`\d+\.\d+\.\d+`)

// evalModeSetter is an engine that has to be told when the owner switches the session's mode between turns.
type evalModeSetter interface {
	setMode(s *evalSession, mode string) error
}

// ── Claude Code ──────────────────────────────────────────────────────────────────────────────────────

type claudeEvalResult struct {
	usage   evalUsage
	isError bool
	subtype string
}

type claudeEvalEngine struct {
	model, effort, version string
	proc                   *claudeSpawn
	rt                     *claudeRuntime
	results                chan claudeEvalResult
	readDone               chan struct{}
	stderrMu               sync.Mutex
	stderr                 []byte
	compacted              atomic.Bool
	sessionDir             string
	// asyncAgents counts the engine's own background agents launched and not yet reported back. Each one's report
	// arrives in a turn the engine starts by itself, as a session's self-driven turn does under the runner, and the
	// person's next message waits for it.
	asyncAgents atomic.Int32
	// reset mirrors runClaudeSessionProcess's contextReset: set by a compact_boundary and by a resumed process,
	// carried by the next message as orbitContextResetNote (context_reset_note.go).
	resetNote atomic.Bool
}

func (e *claudeEvalEngine) identity() (string, string, string, string) {
	return providerClaude, "live", e.version, e.model
}

func (e *claudeEvalEngine) start(s *evalSession) error {
	exe, err := evalPinEngine(s, providerClaude, os.Getenv(evalClaudeBinEnv))
	if err != nil {
		return err
	}
	e.version = evalVersionRE.FindString(engineVersion(exe))
	s.job.Provider, s.job.Agent.Provider = providerClaude, providerClaude
	s.job.Agent.Model, s.job.Agent.Effort = e.model, e.effort
	// What the control plane hands every session (apiserver common/permission-mode.ts ALWAYS_ALLOWED_TOOLS).
	s.job.Agent.AllowedTools = []string{"mcp__orbit__*"}
	s.probeMCP(true)
	s.context.EngineInstructions = len(orbitCLIInstructionsFor(s.job, s.exe))
	if dir, err := claudeSessionAccountDir(s.job.Agent.Env, s.work); err == nil {
		e.sessionDir = filepath.Join(dir, "projects", claudeProjectSlug(s.work))
	}
	return e.spawn(s, true)
}

func (e *claudeEvalEngine) spawn(s *evalSession, first bool) error {
	proc, err := spawnClaude(s.ctx, s.job, s.work, claudeCommandArgs(s.job, s.scratch, first))
	if err != nil {
		return err
	}
	e.proc, e.rt = proc, newClaudeRuntime(proc)
	e.results = make(chan claudeEvalResult, 8)
	e.readDone = make(chan struct{})
	go func() {
		r := bufio.NewReader(proc.stderr)
		buf := make([]byte, 4096)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				e.stderrMu.Lock()
				e.stderr = append(e.stderr, buf[:n]...)
				if len(e.stderr) > 64<<10 {
					e.stderr = e.stderr[len(e.stderr)-(64<<10):]
				}
				e.stderrMu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()
	go func() {
		defer close(e.readDone)
		sc := bufio.NewScanner(proc.stdout)
		sc.Buffer(make([]byte, 0, 1<<20), 64<<20)
		for sc.Scan() {
			var msg map[string]interface{}
			if json.Unmarshal(sc.Bytes(), &msg) != nil {
				continue
			}
			if resp, ok := parseControlResponse(msg); ok {
				e.rt.resolveControl(resp)
				continue
			}
			handleMessage(msg, s.rec.emit, nil)
			switch msg["type"] {
			case "system":
				switch msg["subtype"] {
				case "init":
					if mode := asString(msg["permissionMode"]); mode != "" {
						s.job.notePermissionMode(mode)
					}
				case "compact_boundary":
					e.compacted.Store(true)
					if msg["parent_tool_use_id"] == nil {
						e.resetNote.Store(true)
					}
				}
			case "user":
				// An async sub-agent's launch, as Claude Code 2.1.325 answers the Agent tool that ran it in the background.
				content, _ := mapValue(msg["message"])["content"].([]interface{})
				for _, block := range content {
					if b := mapValue(block); b["type"] == "tool_result" && strings.Contains(toolResultText(b["content"]), "Async agent launched successfully") {
						e.asyncAgents.Add(1)
					}
				}
			case "result":
				usage := mapValue(msg["usage"])
				res := claudeEvalResult{isError: msg["is_error"] == true, subtype: asString(msg["subtype"])}
				res.usage.InputTokens = evalInt(usage["input_tokens"]) + evalInt(usage["cache_creation_input_tokens"])
				res.usage.CachedInputTokens = evalInt(usage["cache_read_input_tokens"])
				res.usage.OutputTokens = evalInt(usage["output_tokens"])
				res.usage.DurationMs = evalInt(msg["duration_ms"])
				select {
				case e.results <- res:
				default:
				}
			}
		}
		e.rt.failPendingControl(errRuntimeGone)
	}()
	return nil
}

func evalInt(v interface{}) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case json.Number:
		i, _ := n.Int64()
		return int(i)
	case int:
		return n
	}
	return 0
}

func (e *claudeEvalEngine) stderrTail() string {
	e.stderrMu.Lock()
	defer e.stderrMu.Unlock()
	tail := string(e.stderr)
	if len(tail) > 2000 {
		tail = tail[len(tail)-2000:]
	}
	return tail
}

func (e *claudeEvalEngine) send(s *evalSession, text string) (claudeEvalResult, error) {
	// Drain a result an earlier frame left behind.
	for len(e.results) > 0 {
		<-e.results
	}
	if err := e.rt.send(userFrame(s.job.SessionUUID, []map[string]interface{}{{"type": "text", "text": text}})); err != nil {
		return claudeEvalResult{}, err
	}
	var res claudeEvalResult
	select {
	case res = <-e.results:
	case <-e.readDone:
		return claudeEvalResult{}, fmt.Errorf("claude exited before answering: %s", e.stderrTail())
	case <-s.ctx.Done():
		return claudeEvalResult{}, s.ctx.Err()
	}
	// The engine's own background agents report back in turns it starts itself; the turn is over when they have.
	for e.asyncAgents.Load() > 0 {
		select {
		case more := <-e.results:
			e.asyncAgents.Add(-1)
			res.usage.InputTokens += more.usage.InputTokens
			res.usage.CachedInputTokens += more.usage.CachedInputTokens
			res.usage.OutputTokens += more.usage.OutputTokens
			res.usage.DurationMs += more.usage.DurationMs
		case <-time.After(5 * time.Minute):
			e.asyncAgents.Store(0)
		case <-e.readDone:
			return res, nil
		}
	}
	return res, nil
}

func (e *claudeEvalEngine) turn(s *evalSession, log *evalTurnLog) error {
	// The message as the session's delivery feeds it: led by the note after a compaction or a resume.
	res, err := e.send(s, withContextResetNote(log.Prompt, e.resetNote.Swap(false), s.job.insideRecordedWork()))
	if err != nil {
		return err
	}
	log.Usage = res.usage
	if res.isError {
		log.Error = res.subtype
	}
	return nil
}

func (e *claudeEvalEngine) setMode(s *evalSession, mode string) error {
	w, err := e.rt.requestControlWith(ctrlSetPermissionMode, map[string]interface{}{"mode": mode})
	if err != nil {
		return err
	}
	select {
	case <-w.done:
		return w.err
	case <-time.After(30 * time.Second):
		return errors.New("claude did not answer set_permission_mode")
	}
}

func (e *claudeEvalEngine) reset(s *evalSession, how string) (bool, error) {
	// What the reset itself says belongs to the turn after it.
	s.rec.setTurn(len(s.logs))
	s.plane.setTurn(len(s.logs))
	switch how {
	case "compact":
		e.compacted.Store(false)
		if _, err := e.send(s, "/compact"); err != nil {
			return false, err
		}
		return e.compacted.Load(), nil
	case "resume":
		e.stopProcess()
		if err := e.spawn(s, false); err != nil {
			return false, err
		}
		e.resetNote.Store(true)
		return true, nil
	}
	return false, fmt.Errorf("unknown reset %q", how)
}

func (e *claudeEvalEngine) stopProcess() {
	if e.proc == nil {
		return
	}
	_ = e.proc.stdin.Close()
	select {
	case <-e.readDone:
	case <-time.After(20 * time.Second):
		if e.proc.cmd.Process != nil {
			_ = e.proc.cmd.Process.Kill()
		}
		<-e.readDone
	}
	_ = e.rt.wait()
	e.proc = nil
}

func (e *claudeEvalEngine) stop(*evalSession) {
	e.stopProcess()
	// The eval's conversation is the eval's: its transcript directory goes with the run's working directory.
	if e.sessionDir != "" && strings.Contains(e.sessionDir, "-p201e") {
		_ = os.RemoveAll(e.sessionDir)
	}
}

// ── Codex ────────────────────────────────────────────────────────────────────────────────────────────

type codexEvalEngine struct {
	model, effort, version string
	app                    *codexAppServer
	threadID               string
	upDir                  string
	state                  codexStateSelection
	processEnv             []string
	activeMu               sync.Mutex
	active                 *codexAppActiveTurn
	done                   chan codexTurnResult
	loopDone               chan struct{}
	compacted              atomic.Bool
	nextTurn               int
}

func (e *codexEvalEngine) identity() (string, string, string, string) {
	if e.model == "" {
		return providerCodex, "live", e.version, "engine-default"
	}
	return providerCodex, "live", e.version, e.model
}

// runnerCodexState is the shared Codex state the runner's own sessions use for codexHome: the partition
// sharedCodexStateForEnv selects, under the runner's home rather than the eval's, so an eval thread lives where a
// session's would instead of replaying the whole history into a fresh state directory. The eval's ORBIT_HOME is
// given the runner's handshake lock for that partition, so the two never initialize it at once. ok is false when
// the runner has no such state yet, and the eval then makes its own, as a first session would.
func runnerCodexState(evalHome, codexHome string) (codexStateSelection, bool, error) {
	runnerHome := os.Getenv(evalRunnerHomeEnv)
	if runnerHome == "" {
		runnerHome = filepath.Join(userHome(), ".orbit")
	}
	partition := codexStatePartition(codexHome)
	dir := filepath.Join(runnerHome, "codex-state", partition)
	if info, err := os.Lstat(dir); err != nil || !info.IsDir() {
		return codexStateSelection{}, false, nil
	}
	lock := filepath.Join(runnerHome, ".codex-state-"+partition+".init.lock")
	if _, err := os.Stat(lock); err == nil {
		if err := os.Symlink(lock, filepath.Join(evalHome, ".codex-state-"+partition+".init.lock")); err != nil && !os.IsExist(err) {
			return codexStateSelection{}, false, err
		}
	}
	return codexStateSelection{Dir: dir, Layout: codexStateLayoutShared, Partition: partition, CodexHome: codexHome, Shared: true}, true, nil
}

func (e *codexEvalEngine) start(s *evalSession) error {
	exe, err := evalPinEngine(s, providerCodex, os.Getenv(evalCodexBinEnv))
	if err != nil {
		return err
	}
	e.version = evalVersionRE.FindString(engineVersion(exe))
	s.job.Provider, s.job.Agent.Provider = providerCodex, providerCodex
	s.job.Agent.Model, s.job.Agent.Effort = e.model, e.effort
	s.job.Agent.AllowedTools = []string{"mcp__orbit__*"}
	e.upDir = uploadsDir(s.job.SessionID)
	_ = os.MkdirAll(e.upDir, 0o755)
	e.processEnv = envWithAgent(s.job.Agent.Env)
	codexHome, err := effectiveCodexHome(e.processEnv, s.work)
	if err != nil {
		return err
	}
	state, shared, err := runnerCodexState(s.home, codexHome)
	if err != nil {
		return err
	}
	if !shared {
		if state, err = resolveCodexStateDir(s.scratch, "", nil, e.processEnv, s.work); err != nil {
			return err
		}
	}
	e.state = state
	if e.state.CodexHome != "" {
		e.processEnv = envWithValue(e.processEnv, "CODEX_HOME", e.state.CodexHome)
	}
	if err := ensureSharedCodexStateReady(s.ctx, s.ctx, e.state, e.processEnv); err != nil {
		return err
	}
	s.probeMCP(false)
	s.context.EngineInstructions = len(codexAgentContextOf(s.job.Agent, s.exe, s.job.insideRecordedWork(), s.job.watchesOn(), true))
	return e.spawn(s)
}

func (e *codexEvalEngine) spawn(s *evalSession) error {
	plane := NewTransport(s.plane.srv.URL, "eval-runner-token")
	app, err := startReadyCodexAppServer(s.ctx, e.state, codexConnectionInitTimeout, func() (*codexAppServer, error) {
		return startCodexAppServer(s.ctx, s.job, s.work, e.state.Dir, e.processEnv, s.rec.emit,
			func(ctx context.Context, request codexApprovalRequest, params map[string]interface{}) bool {
				return bridgeCodexApprovalWithContext(ctx, plane, s.job, request, params, codexAutoApprovalContextFor(s.work, e.upDir))
			})
	})
	if err != nil {
		return err
	}
	e.app = app
	if root := writeCodexManagedSkillRoot(s.scratch); root != "" {
		_, _ = app.request(s.ctx, "skills/extraRoots/set", map[string]interface{}{"extraRoots": []string{root}})
	}
	resumed := s.job.RuntimeSessionID != ""
	threadID, err := app.startOrResumeThread(s.ctx, s.job, s.work, e.upDir)
	if err != nil {
		return fmt.Errorf("thread: %w", err)
	}
	if !resumed && app.currentInstructionMode() == codexInstructionsInjectItems {
		if err := app.injectAgentContext(s.ctx, threadID, s.job.Agent, agentShape(s.job.Agent, app.orbitExecutable, s.job.insideRecordedWork(), s.job.watchesOn(), true)); err != nil {
			app.setInstructionMode(codexInstructionsUserInput)
		}
	}
	e.threadID = threadID
	s.job.RuntimeSessionID = threadID
	e.done = make(chan codexTurnResult, 4)
	e.loopDone = make(chan struct{})
	go func() {
		defer close(e.loopDone)
		for {
			select {
			case <-app.done:
				return
			case <-s.ctx.Done():
				return
			case msg := <-app.notifications:
				if codexNotificationCompacted(msg) {
					e.compacted.Store(true)
				}
				handleCodexAppNotification(threadID, msg, s.rec.emit, &e.activeMu, &e.active, e.finalize,
					func(codexTurnID string) { markCodexAppTurnStarted(&e.activeMu, &e.active, "", codexTurnID) }, nil, nil, nil)
			}
		}
	}()
	return nil
}

func (e *codexEvalEngine) finalize(result codexTurnResult) {
	a, snapshot, ok := beginCodexAppTurnFinalize(&e.activeMu, &e.active)
	if !ok {
		return
	}
	if result.Usage == nil {
		result.Usage = snapshot.result.Usage
	}
	if result.Status == "" {
		result.Status = snapshot.result.Status
	}
	finishCodexAppTurnFinalize(&e.activeMu, &e.active, a)
	select {
	case e.done <- result:
	default:
	}
}

func (e *codexEvalEngine) turn(s *evalSession, log *evalTurnLog) error {
	e.nextTurn++
	orbitTurnID := fmt.Sprintf("eval-turn-%d", e.nextTurn)
	e.activeMu.Lock()
	if e.active != nil {
		e.activeMu.Unlock()
		return errors.New("a codex turn is still active")
	}
	e.active = &codexAppActiveTurn{orbitTurnID: orbitTurnID,
		result: codexTurnResult{Status: stSucceeded, Subtype: "completed", RuntimeSessionID: e.threadID}}
	e.activeMu.Unlock()
	if ok, _ := beginCodexAppTurnStart(&e.activeMu, &e.active, orbitTurnID); !ok {
		return errors.New("the codex turn could not begin")
	}
	codexTurnID, err := e.app.startTurn(s.ctx, e.threadID, s.job, s.work, e.upDir, orbitTurnID, log.Prompt, nil)
	if err != nil {
		e.activeMu.Lock()
		e.active = nil
		e.activeMu.Unlock()
		return fmt.Errorf("turn/start: %w", err)
	}
	markCodexAppTurnStarted(&e.activeMu, &e.active, orbitTurnID, codexTurnID)
	select {
	case res := <-e.done:
		if res.Usage != nil {
			log.Usage.InputTokens = res.Usage.InputTokens + res.Usage.CacheCreationInputTokens
			log.Usage.CachedInputTokens = res.Usage.CacheReadInputTokens
			log.Usage.OutputTokens = res.Usage.OutputTokens
		}
		if res.Status != stSucceeded {
			log.Error = res.Status + ": " + res.Subtype
		}
		return nil
	case <-e.loopDone:
		return errors.New("codex app-server exited during the turn")
	}
}

func (e *codexEvalEngine) reset(s *evalSession, how string) (bool, error) {
	s.rec.setTurn(len(s.logs))
	s.plane.setTurn(len(s.logs))
	switch how {
	case "compact":
		e.compacted.Store(false)
		if _, err := e.app.request(s.ctx, "thread/compact/start", map[string]interface{}{"threadId": e.threadID}); err != nil {
			return false, err
		}
		deadline := time.Now().Add(5 * time.Minute)
		for !e.compacted.Load() && time.Now().Before(deadline) {
			select {
			case <-e.loopDone:
				return false, errors.New("codex app-server exited while compacting")
			case <-time.After(500 * time.Millisecond):
			}
		}
		// A compaction may run as a turn of its own; let it settle before the next one starts.
		time.Sleep(2 * time.Second)
		e.activeMu.Lock()
		e.active = nil
		e.activeMu.Unlock()
		return e.compacted.Load(), nil
	case "resume":
		e.app.close()
		<-e.loopDone
		if err := e.spawn(s); err != nil {
			return false, err
		}
		return true, nil
	}
	return false, fmt.Errorf("unknown reset %q", how)
}

func (e *codexEvalEngine) stop(*evalSession) {
	if e.app != nil {
		e.app.close()
		if e.loopDone != nil {
			<-e.loopDone
		}
		e.app = nil
	}
}

// ── The live eval ────────────────────────────────────────────────────────────────────────────────────

func evalEnvList(key, fallback string) []string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		value = fallback
	}
	var out []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	return out
}

// evalSelectedScenarios is the suite, narrowed to the ids ORBIT_AGENT_EVAL_SCENARIOS names ("E1*" names a prefix).
func evalSelectedScenarios() []*evalScenario {
	want := evalEnvList(evalScenariosEnv, "all")
	var out []*evalScenario
	for _, sc := range evalScenarios() {
		for _, w := range want {
			if w == "all" || sc.ID == w || (strings.HasSuffix(w, "*") && strings.HasPrefix(sc.ID, strings.TrimSuffix(w, "*"))) {
				out = append(out, sc)
				break
			}
		}
	}
	return out
}

func evalRepoSHA() string {
	if sha := os.Getenv(evalRepoSHAEnv); sha != "" {
		return sha
	}
	out, err := exec.Command("git", "rev-parse", "HEAD").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func TestAgentEvalLive(t *testing.T) {
	if os.Getenv(evalLiveEnv) != "live" {
		t.Skipf("the black-box eval runs real engines and models; set %s=live (scripts/agent-eval.sh)", evalLiveEnv)
	}
	useEvalLeaveOut(t)
	if left := evalLeftOutList(); len(left) > 0 {
		t.Logf("instruction units left out: %s", strings.Join(left, ", "))
	}
	repeats, _ := strconv.Atoi(os.Getenv(evalRepeatsEnv))
	if repeats < 1 {
		repeats = 1
	}
	turnTimeout := 8 * time.Minute
	if d, err := time.ParseDuration(os.Getenv(evalTurnTimeoutEnv)); err == nil && d > 0 {
		turnTimeout = d
	}
	report := os.Getenv(evalReportEnv)
	if report == "" {
		report = filepath.Join(t.TempDir(), "agent-eval-report.json")
	}
	var baseline *evalReport
	if path := os.Getenv(evalBaselineEnv); path != "" {
		b, err := readEvalReport(path)
		if err != nil {
			t.Fatalf("baseline: %v", err)
		}
		baseline = b
	}
	claudeModel := os.Getenv(evalClaudeModelEnv)
	if claudeModel == "" {
		claudeModel = "claude-sonnet-5-5"
	}
	// Unset, Codex runs its own configured default, as a session with no model of its own does.
	codexModel := os.Getenv(evalCodexModelEnv)
	effort := os.Getenv(evalEffortEnv)
	var runs []*evalRun
	var skipped []evalSkip
	for _, engine := range evalEnvList(evalEnginesEnv, "claude,codex") {
		for _, sc := range evalSelectedScenarios() {
			if reason := evalNotApplicable(sc, engine); reason != "" {
				t.Logf("%s %s: not applicable: %s", engine, sc.ID, reason)
				skip := evalSkip{Scenario: sc.ID, Engine: engine, Reason: reason}
				skipped = append(skipped, skip)
				if dir := os.Getenv(evalTranscriptsEnv); dir != "" {
					if err := writeEvalTranscript(dir, evalTranscript{ScenarioHash: evalScenarioHash(), Scenario: sc.ID, Engine: engine,
						Model: "skip", Skip: &skip}); err != nil {
						t.Errorf("transcript: %v", err)
					}
				}
				continue
			}
			for repeat := 1; repeat <= repeats; repeat++ {
				var eng evalEngine
				switch engine {
				case providerClaude:
					eng = &claudeEvalEngine{model: claudeModel, effort: effort}
				case providerCodex:
					eng = &codexEvalEngine{model: codexModel, effort: effort}
				case providerKimi:
					// The engine's own configured model, as a session with no model of its own runs.
					eng = &kimiEvalEngine{}
				default:
					t.Fatalf("%s names no engine the eval drives: %s", evalEnginesEnv, engine)
				}
				s, err := newEvalSession(sc, engine)
				if err != nil {
					t.Fatalf("%s: %v", sc.ID, err)
				}
				run := s.play(eng, repeat, turnTimeout)
				orchestration := s.job.AllowOrchestration
				s.close()
				if dir := os.Getenv(evalTranscriptsEnv); dir != "" {
					if err := writeEvalTranscript(dir, evalTranscript{ScenarioHash: evalScenarioHash(), RepoSHA: evalRepoSHA(), Scenario: sc.ID, Engine: run.Engine,
						Backend: run.Backend, EngineVersion: run.EngineVersion, Model: run.Model, Repeat: repeat, Exe: run.Exe,
						Orchestration: orchestration, World: run.World, Turns: run.Turns, Events: run.Events, Ledger: run.Ledger,
						ToolsListed: run.ToolsListed, Context: run.Context, HarnessError: run.HarnessError, DurationMs: run.DurationMs,
						Files: run.Files, LeftOut: evalLeftOutList()}); err != nil {
						t.Errorf("transcript: %v", err)
					}
				}
				verdict, clauses := run.grade()
				t.Logf("%s %s %s run %d: %s (%d ms)%s", engine, run.EngineVersion, sc.ID, repeat, verdict, run.DurationMs, evalHarnessNote(run))
				for _, c := range clauses {
					if !c.Passed {
						t.Logf("    %s: %s", c.ID, c.Why)
					}
				}
				if os.Getenv("ORBIT_AGENT_EVAL_DEBUG") != "" {
					t.Logf("%s", evalDebugRun(run))
				}
				runs = append(runs, run)
			}
		}
	}
	rep := buildEvalReport(runs, evalRepoSHA(), baseline, skipped...)
	if err := writeEvalReport(rep, report); err != nil {
		t.Fatal(err)
	}
	t.Logf("report: %s (gate %s)", report, rep.Gate.Verdict)
	for _, reason := range rep.Gate.Reasons {
		t.Logf("  %s", reason)
	}
	if rep.Gate.Verdict != evalVerdictPass {
		t.Errorf("the release gate is %s", rep.Gate.Verdict)
	}
}

func evalHarnessNote(run *evalRun) string {
	if run.HarnessError == "" {
		return ""
	}
	return " harness: " + run.HarnessError
}

// TestAgentEvalCompareReports compares two reports written by the live eval (scripts/agent-eval.sh compare).
func TestAgentEvalCompareReports(t *testing.T) {
	pair := os.Getenv("ORBIT_AGENT_EVAL_COMPARE")
	if pair == "" {
		t.Skip("set ORBIT_AGENT_EVAL_COMPARE=BASELINE.json,REPORT.json (scripts/agent-eval.sh compare)")
	}
	paths := strings.SplitN(pair, ",", 2)
	if len(paths) != 2 {
		t.Fatalf("ORBIT_AGENT_EVAL_COMPARE=%q names no pair", pair)
	}
	base, err := readEvalReport(paths[0])
	if err != nil {
		t.Fatal(err)
	}
	cur, err := readEvalReport(paths[1])
	if err != nil {
		t.Fatal(err)
	}
	c := compareEvalReports(base, cur, evalGate())
	t.Logf("baseline %s (%s, contract %s) against %s (%s, contract %s); same suite: %v", base.GeneratedAt, base.Source.RepoSHA,
		base.Contract.ContractVersion, cur.GeneratedAt, cur.Source.RepoSHA, cur.Contract.ContractVersion, c.SameSuite)
	for _, sec := range []struct {
		name string
		list []string
	}{{"regressed", c.Regressions}, {"improved", c.Improvements}, {"new", c.New}, {"gone", c.Gone}, {"warning", c.Warnings}} {
		for _, item := range sec.list {
			t.Logf("%s: %s", sec.name, item)
		}
	}
	if len(c.Regressions) > 0 {
		t.Errorf("%d cells regressed", len(c.Regressions))
	}
}

// TestAgentEvalMergeReports merges reports of one suite into one (scripts/agent-eval.sh merge).
func TestAgentEvalMergeReports(t *testing.T) {
	spec := os.Getenv("ORBIT_AGENT_EVAL_MERGE")
	if spec == "" {
		t.Skip("set ORBIT_AGENT_EVAL_MERGE=OUT.json,IN.json,IN.json… (scripts/agent-eval.sh merge)")
	}
	paths := strings.Split(spec, ",")
	if len(paths) < 2 {
		t.Fatalf("ORBIT_AGENT_EVAL_MERGE=%q names no input", spec)
	}
	var reports []*evalReport
	for _, path := range paths[1:] {
		rep, err := readEvalReport(path)
		if err != nil {
			t.Fatal(err)
		}
		reports = append(reports, rep)
	}
	merged, err := mergeEvalReports(reports)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeEvalReport(merged, paths[0]); err != nil {
		t.Fatal(err)
	}
	t.Logf("merged %d reports into %s: %d runs, gate %s", len(reports), paths[0], len(merged.Runs), merged.Gate.Verdict)
	for _, reason := range merged.Gate.Reasons {
		t.Logf("  %s", reason)
	}
}

// TestAgentEvalRegrade grades kept transcripts again with this code's graders and writes the report
// (scripts/agent-eval.sh regrade): a grader fix re-reads what the engines did instead of paying for them to do it
// again. Only a transcript played under this code's scenarios (evalScenarioHash) is read.
func TestAgentEvalRegrade(t *testing.T) {
	spec := os.Getenv("ORBIT_AGENT_EVAL_REGRADE")
	if spec == "" {
		t.Skip("set ORBIT_AGENT_EVAL_REGRADE=OUT.json,TRANSCRIPT_DIR (scripts/agent-eval.sh regrade)")
	}
	parts := strings.SplitN(spec, ",", 2)
	if len(parts) != 2 {
		t.Fatalf("ORBIT_AGENT_EVAL_REGRADE=%q names no transcript directory", spec)
	}
	entries, err := os.ReadDir(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var runs []*evalRun
	var skipped []evalSkip
	seenSkips := map[string]bool{}
	played := map[string]bool{}
	leftOut := map[string]bool{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(parts[1], entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		var tr evalTranscript
		if err := json.Unmarshal(raw, &tr); err != nil {
			t.Fatalf("%s: %v", entry.Name(), err)
		}
		if tr.ScenarioHash != evalScenarioHash() {
			t.Fatalf("%s was played under scenarios %.12s, this code's are %.12s", entry.Name(), tr.ScenarioHash, evalScenarioHash())
		}
		if tr.Skip == nil {
			played[tr.RepoSHA] = true
			leftOut[strings.Join(tr.LeftOut, ",")] = true
		}
		if tr.Skip != nil {
			if key := tr.Skip.Scenario + "|" + tr.Skip.Engine; !seenSkips[key] {
				seenSkips[key] = true
				skipped = append(skipped, *tr.Skip)
			}
			continue
		}
		sc := evalScenarioByID(tr.Scenario)
		if sc == nil {
			t.Fatalf("%s names no scenario of this suite", entry.Name())
		}
		run := &evalRun{Scenario: sc, Engine: tr.Engine, Backend: tr.Backend, EngineVersion: tr.EngineVersion, Model: tr.Model,
			Repeat: tr.Repeat, Exe: tr.Exe, World: tr.World, Turns: tr.Turns, Events: tr.Events, Ledger: tr.Ledger,
			ToolsListed: tr.ToolsListed, Context: tr.Context, HarnessError: tr.HarnessError, DurationMs: tr.DurationMs, Files: tr.Files}
		run.rebuildTurns(tr.Orchestration)
		runs = append(runs, run)
	}
	sort.SliceStable(runs, func(i, j int) bool {
		a, b := runs[i], runs[j]
		if a.Engine+a.Model != b.Engine+b.Model {
			return a.Engine+a.Model < b.Engine+b.Model
		}
		if a.Scenario.ID != b.Scenario.ID {
			return a.Scenario.ID < b.Scenario.ID
		}
		return a.Repeat < b.Repeat
	})
	// The report describes the commit the engines were played on, when every transcript names the same one; a
	// transcript that names none (written before RepoSHA was kept) leaves it to ORBIT_AGENT_EVAL_REPO_SHA.
	repoSHA := evalRepoSHA()
	if len(played) == 1 {
		for sha := range played {
			if sha != "" {
				repoSHA = sha
			}
		}
	}
	// The report names the units the runs were played without, which every transcript must agree on.
	if len(leftOut) > 1 {
		t.Fatalf("the transcripts were played with different instruction units left out: %v", leftOut)
	}
	for list := range leftOut {
		units, err := parseInstructionUnits(list)
		if err != nil {
			t.Fatal(err)
		}
		setEvalLeaveOut(t, units)
	}
	rep := buildEvalReport(runs, repoSHA, nil, skipped...)
	if err := writeEvalReport(rep, parts[0]); err != nil {
		t.Fatal(err)
	}
	t.Logf("regraded %d runs into %s: gate %s", len(runs), parts[0], rep.Gate.Verdict)
	for _, reason := range rep.Gate.Reasons {
		t.Logf("  %s", reason)
	}
}
