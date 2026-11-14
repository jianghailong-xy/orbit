package main

// One eval run's session (docs/agent-contract-eval.md): the world it sits in, the ids and directories the runner
// would give it, the runner-side service the Plan gate reads the session's live mode from, and the turn loop every
// driver shares.
//
// The process running the eval is the `orbit` binary the session is given: this test binary serves as `orbit mcp`
// (dsh_mcp_test.go's init) and, under evalCLIEnv, as the `orbit` CLI for every command (TestMain), so an engine
// sees the absolute executable, the MCP config, the allowlist and the instructions production builds from
// os.Executable(). Each run has its own ORBIT_HOME, whose config.json names that run's control plane. It is the
// eval process's own, as a runner's home is the runner's (envWithAgent never lets a session name another), so the
// runs of one eval process go one at a time.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// evalCLIEnv makes this test binary run as the `orbit` CLI for any subcommand (TestMain).
const evalCLIEnv = "ORBIT_EVAL_AS_ORBIT_CLI"

// evalMCPBrokenMarker, present in a run's ORBIT_HOME, makes `orbit mcp` exit before it answers: Orbit's MCP server
// failed to start, which is X1's context.
const evalMCPBrokenMarker = "eval-mcp-broken"

func init() {
	if len(os.Args) < 2 || os.Args[1] != "mcp" {
		return
	}
	if home := os.Getenv("ORBIT_HOME"); home != "" {
		if _, err := os.Stat(filepath.Join(home, evalMCPBrokenMarker)); err == nil {
			fmt.Fprintln(os.Stderr, "orbit mcp: this eval session's Orbit MCP server fails to start on purpose")
			os.Exit(1)
		}
	}
}

// evalCLIDispatch says whether TestMain should run this binary as the `orbit` CLI for os.Args[1].
func evalCLIDispatch(word string) bool {
	return os.Getenv(evalCLIEnv) != "" && word != "" && word != "mcp" && !strings.HasPrefix(word, "-test.")
}

// evalSession is one run's world and session.
type evalSession struct {
	sc       *evalScenario
	plane    *evalPlane
	home     string
	work     string
	scratch  string
	job      *ClaimedSession
	world    evalWorldIDs
	exe      string
	rec      *evalRecorder
	ctx      context.Context
	cancel   context.CancelFunc
	bg       *bgTailer
	stopJobs func()
	tools    []string
	context  evalContextBytes
	logs     []evalTurnLog
	cleanup  []func()
}

// newEvalSession builds the world of sc and the session that runs in it. provider names the engine the job is for.
func newEvalSession(sc *evalScenario, provider string) (*evalSession, error) {
	exe := orbitCLIExecutable()
	if exe == "" {
		return nil, errors.New("this test binary has no absolute path to give the session as its orbit executable")
	}
	s := &evalSession{sc: sc, plane: newEvalPlane(), exe: exe, rec: &evalRecorder{}}
	s.cleanup = append(s.cleanup, s.plane.close)
	if sc.Setup.Owner != nil {
		s.plane.owner = sc.Setup.Owner
	}
	s.plane.orchestration = sc.Setup.Orchestration
	s.plane.dropCreateAnswers = sc.Setup.DropCreateAnswers

	sessionUUID, err := randomUUID()
	if err != nil {
		return nil, err
	}
	agentID := evalPublicID()
	s.plane.selfSession = decodeSessionID(sessionUUID)
	s.plane.selfAgent = agentID
	s.world = evalWorldIDs{SessionID: publicID(sessionUUID), AgentID: agentID, Seeds: map[string]string{}}
	s.plane.agents = []map[string]interface{}{{"id": agentID, "name": "eval-agent", "runnerId": "eval-runner"}}

	if sc.Setup.Project || sc.Setup.TaskLinked {
		s.plane.project = &evalProjectRow{ID: evalPublicID(), Title: evalProjectTitle, Goal: evalProjectGoal, Status: "OPEN",
			Instructions: "Contract first, then discovery, then the person's documentation.", Criteria: evalProjectCriteria}
		s.world.ProjectID = s.plane.project.ID
	}
	if sc.Setup.TaskLinked {
		title, description := sc.Setup.CurrentTitle, sc.Setup.CurrentDescription
		if title == "" {
			title = "Answer the person's questions about the agent-contract project"
			description = "Answer what the person asks about this project from Orbit's own records. Done when they have their answer."
		}
		current := s.plane.seedTask(&evalTaskRow{Title: title, Description: description, Status: "IN_PROGRESS",
			ProjectID: s.world.ProjectID, AssigneeID: agentID})
		s.world.TaskID = current.ID
	}
	for _, seed := range sc.Setup.Seeds {
		row := &evalTaskRow{Title: seed.Title, Description: seed.Description, Status: seed.Status}
		if seed.InProject {
			row.ProjectID = s.world.ProjectID
		}
		if seed.Assigned {
			row.AssigneeID = agentID
		}
		s.world.Seeds[seed.Name] = s.plane.seedTask(row).ID
	}

	for _, dir := range []*string{&s.home, &s.work, &s.scratch} {
		d, err := os.MkdirTemp("", "p201e")
		if err != nil {
			s.close()
			return nil, err
		}
		*dir = d
		s.cleanup = append(s.cleanup, func() { _ = os.RemoveAll(d) })
	}
	if err := s.plane.writeHome(s.home); err != nil {
		s.close()
		return nil, err
	}
	previousHome, hadHome := os.LookupEnv("ORBIT_HOME")
	_ = os.Setenv("ORBIT_HOME", s.home)
	s.cleanup = append(s.cleanup, func() {
		if hadHome {
			_ = os.Setenv("ORBIT_HOME", previousHome)
		} else {
			_ = os.Unsetenv("ORBIT_HOME")
		}
	})
	if sc.Setup.MCPBroken {
		if err := os.WriteFile(filepath.Join(s.home, evalMCPBrokenMarker), []byte("1"), 0o600); err != nil {
			s.close()
			return nil, err
		}
	}

	s.job = &ClaimedSession{
		SessionID: sessionUUID, SessionUUID: sessionUUID, AgentID: agentID, TaskID: s.world.TaskID, Provider: provider,
		AllowOrchestration: sc.Setup.Orchestration,
		Agent: AgentExecConfig{Provider: provider, PermissionMode: sc.Turns[0].Mode,
			Env: map[string]string{evalCLIEnv: "1"}},
	}
	s.ctx, s.cancel = context.WithCancel(context.Background())
	s.cleanup = append(s.cleanup, s.cancel)
	s.bg = newBgTailer(s.ctx, func(string, map[string]interface{}) {}, nil)
	s.cleanup = append(s.cleanup, s.bg.stopAll)
	stop, err := startSessionBgJobService(s.ctx, NewTransport(s.plane.srv.URL, "eval-runner-token"), s.bg, s.job, s.work, s.scratch)
	if err != nil {
		s.close()
		return nil, fmt.Errorf("the session's job service: %w", err)
	}
	s.stopJobs = stop
	s.cleanup = append(s.cleanup, stop)
	return s, nil
}

func (s *evalSession) close() {
	for i := len(s.cleanup) - 1; i >= 0; i-- {
		s.cleanup[i]()
	}
	s.cleanup = nil
}

// env is the environment a process of this session runs with: what spawnClaude gives the engine, which its `orbit
// mcp` and its shell commands inherit.
func (s *evalSession) env(permissionPrompt bool) []string {
	env := envWithAgent(s.job.Agent.Env)
	env = append(env,
		"ORBIT_SESSION_ID="+publicID(s.job.SessionID),
		"ORBIT_AGENT_ID="+publicID(s.job.AgentID),
		"ORBIT_TASK_ID="+publicID(s.job.TaskID),
		"ORBIT_ALLOW_ORCHESTRATION="+orchestrationEnv(s.job.AllowOrchestration),
		envWatches+"="+watchesEnv(s.job.WatchesDisabled),
		envWiki+"="+wikiEnv(s.job.WikiDisabled),
		"ORBIT_SPAWN_DEPTH=0",
	)
	if !permissionPrompt {
		env = append(env, envMCPPermissionPrompt+"=0")
	}
	env = append(env, bgJobEnvPairs(s.job.SessionID)...)
	return runnerChildEnv(env)
}

// setMode publishes the session's permission mode, as the supervisor does when the owner switches it.
func (s *evalSession) setMode(mode string) {
	s.job.Agent.PermissionMode = mode
	s.job.notePermissionMode(mode)
}

// probeMCP starts the session's `orbit mcp` as an engine would and reads what it offers: the instructions, the tool
// list and their sizes. A server that does not start leaves the tool list unknown, which is what the engine has.
func (s *evalSession) probeMCP(permissionPrompt bool) {
	client, err := startEvalMCPClient(s.ctx, s.exe, s.env(permissionPrompt), s.work)
	if err != nil {
		return
	}
	defer client.close()
	s.tools = client.tools
	s.context.MCPInstructions = len(client.instructions)
	s.context.ToolsList = client.toolsListBytes
	s.context.ToolsListed = len(client.tools)
}

// evalEngine is what a driver does for the turn loop.
type evalEngine interface {
	identity() (engine, backend, version, model string)
	// start brings the engine up for the session's first turn.
	start(s *evalSession) error
	// turn delivers one turn's words and returns once the engine has answered it.
	turn(s *evalSession, log *evalTurnLog) error
	// reset compacts the conversation ("compact") or stops the engine and resumes it ("resume").
	reset(s *evalSession, how string) (bool, error)
	stop(s *evalSession)
}

// evalReplyAsks says whether a reply ends the turn asking the person something.
func evalReplyAsks(reply string) bool {
	return strings.Contains(reply, "?")
}

// play runs every turn of the scenario through engine and returns the run, graded or not.
func (s *evalSession) play(engine evalEngine, repeat int, turnTimeout time.Duration) *evalRun {
	started := time.Now()
	run := &evalRun{Scenario: s.sc, Repeat: repeat, Exe: s.exe, World: s.world}
	run.Engine, run.Backend, run.EngineVersion, run.Model = engine.identity()
	defer func() {
		engine.stop(s)
		run.Engine, run.Backend, run.EngineVersion, run.Model = engine.identity()
		run.Ledger = s.plane.snapshot()
		run.ToolsListed = s.tools
		run.Context = s.context
		run.DurationMs = int(time.Since(started).Milliseconds())
		events := s.rec.snapshot()
		for i := range s.logs {
			var mine []evalEvent
			for _, ev := range events {
				if ev.Turn == i {
					mine = append(mine, ev)
				}
			}
			steps, reply, compacted := evalTurnSteps(mine, s.exe)
			s.logs[i].Steps, s.logs[i].Reply = steps, reply
			s.logs[i].Compacted = s.logs[i].Compacted || compacted
			s.logs[i].Telemetry = evalTelemetryOf(mine, run.Engine, s.exe, s.logs[i].Mode, s.job.AllowOrchestration, s.context.EngineInstructions)
			for _, step := range steps {
				if step.Kind == evalStepOrbit && (step.Operation == "guide" || step.Operation == "capabilities" || step.Operation == "help") {
					run.Context.DiscoveryOutput += len(step.Result)
				}
			}
		}
		run.Turns = s.logs
	}()
	if err := engine.start(s); err != nil {
		run.HarnessError = "start: " + err.Error()
		return run
	}
	for spec, turn := range s.sc.Turns {
		log := evalTurnLog{Index: len(s.logs), Spec: spec, Prompt: turn.Prompt, Mode: turn.Mode, Before: turn.Before}
		// The owner switching the session's mode between turns, as the supervisor tells a running engine.
		if spec > 0 && s.sc.Turns[spec-1].Mode != turn.Mode {
			if setter, ok := engine.(evalModeSetter); ok {
				if err := setter.setMode(s, turn.Mode); err != nil {
					run.HarnessError = "mode: " + err.Error()
					return run
				}
			}
		}
		s.setMode(turn.Mode)
		if turn.Before != "" {
			done, err := engine.reset(s, turn.Before)
			if err != nil {
				run.HarnessError = turn.Before + ": " + err.Error()
				return run
			}
			log.ResetDone = done
		}
		if !s.runTurn(engine, &log, turnTimeout, run) {
			return run
		}
		if turn.FollowUp == "" || !evalReplyAsks(s.lastReply()) || s.wroteAny(spec, turn.Expect) {
			continue
		}
		follow := evalTurnLog{Index: len(s.logs), Spec: spec, Prompt: turn.FollowUp, Mode: turn.Mode, FollowUp: true}
		if !s.runTurn(engine, &follow, turnTimeout, run) {
			return run
		}
	}
	return run
}

func (s *evalSession) runTurn(engine evalEngine, log *evalTurnLog, timeout time.Duration, run *evalRun) bool {
	s.plane.setTurn(log.Index)
	s.rec.setTurn(log.Index)
	s.logs = append(s.logs, *log)
	done := make(chan error, 1)
	go func() { done <- engine.turn(s, &s.logs[len(s.logs)-1]) }()
	select {
	case err := <-done:
		if err != nil {
			run.HarnessError = fmt.Sprintf("turn %d: %v", log.Index, err)
			return false
		}
	case <-time.After(timeout):
		run.HarnessError = fmt.Sprintf("turn %d did not end within %s", log.Index, timeout)
		return false
	}
	return true
}

// lastReply is the text of the newest log turn, read from the recorder.
func (s *evalSession) lastReply() string {
	if len(s.logs) == 0 {
		return ""
	}
	var mine []evalEvent
	for _, ev := range s.rec.snapshot() {
		if ev.Turn == len(s.logs)-1 {
			mine = append(mine, ev)
		}
	}
	_, reply, _ := evalTurnSteps(mine, s.exe)
	return reply
}

// wroteAny says whether a write of one of ops landed during the scenario turn spec.
func (s *evalSession) wroteAny(spec int, ops []string) bool {
	ledger := s.plane.snapshot()
	specOf := func(turn int) int {
		if turn >= 0 && turn < len(s.logs) {
			return s.logs[turn].Spec
		}
		return -1
	}
	for _, e := range ledger.Events {
		if specOf(e.Turn) != spec {
			continue
		}
		for _, op := range ops {
			switch {
			case op == "task_create" && e.Kind == "task_created",
				op == "task_create_batch" && e.Kind == "batch_created",
				op == "project_create" && e.Kind == "project_created":
				return true
			}
		}
	}
	return false
}

// ── An MCP client that speaks to the session's `orbit mcp` the way an engine does ───────────────────────

type evalMCPClient struct {
	cmd            *exec.Cmd
	stdin          io.WriteCloser
	out            *bufio.Reader
	next           int
	instructions   string
	tools          []string
	toolsListBytes int
}

func startEvalMCPClient(ctx context.Context, exe string, env []string, dir string) (*evalMCPClient, error) {
	cmd := exec.CommandContext(ctx, exe, "mcp")
	cmd.Env = env
	cmd.Dir = dir
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	c := &evalMCPClient{cmd: cmd, stdin: stdin, out: bufio.NewReaderSize(stdout, 1<<22)}
	init, err := c.request("initialize", map[string]interface{}{"protocolVersion": "2024-11-05",
		"clientInfo": map[string]interface{}{"name": "orbit-agent-eval", "version": "1"}})
	if err != nil {
		c.close()
		return nil, err
	}
	c.instructions = asString(init["instructions"])
	if err := c.notify("notifications/initialized"); err != nil {
		c.close()
		return nil, err
	}
	list, err := c.request("tools/list", map[string]interface{}{})
	if err != nil {
		c.close()
		return nil, err
	}
	raw, _ := json.Marshal(list)
	c.toolsListBytes = len(raw)
	if tools, ok := list["tools"].([]interface{}); ok {
		for _, tool := range tools {
			c.tools = append(c.tools, asString(mapValue(tool)["name"]))
		}
	}
	return c, nil
}

func (c *evalMCPClient) notify(method string) error {
	b, _ := json.Marshal(map[string]interface{}{"jsonrpc": "2.0", "method": method})
	_, err := c.stdin.Write(append(b, '\n'))
	return err
}

func (c *evalMCPClient) request(method string, params map[string]interface{}) (map[string]interface{}, error) {
	c.next++
	id := c.next
	b, _ := json.Marshal(map[string]interface{}{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	if _, err := c.stdin.Write(append(b, '\n')); err != nil {
		return nil, err
	}
	for {
		line, err := c.out.ReadBytes('\n')
		if err != nil {
			return nil, fmt.Errorf("%s: the MCP server closed its output: %w", method, err)
		}
		var msg struct {
			ID     json.RawMessage        `json:"id"`
			Result map[string]interface{} `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(line, &msg) != nil || string(msg.ID) != fmt.Sprint(id) {
			continue
		}
		if msg.Error != nil {
			return nil, fmt.Errorf("%s: %s", method, msg.Error.Message)
		}
		return msg.Result, nil
	}
}

// call makes one tools/call and answers the result as an engine reads it: structuredContent for a success that
// carries it (compact JSON), otherwise the text, and whether it is an error.
func (c *evalMCPClient) call(tool string, args map[string]interface{}) (string, bool, error) {
	result, err := c.request("tools/call", map[string]interface{}{"name": tool, "arguments": args})
	if err != nil {
		return "", true, err
	}
	isErr, _ := result["isError"].(bool)
	if sc, ok := result["structuredContent"]; ok && sc != nil && !isErr {
		raw, _ := json.Marshal(sc)
		return string(raw), false, nil
	}
	return evalContentText(result["content"]), isErr, nil
}

func (c *evalMCPClient) close() {
	_ = c.stdin.Close()
	done := make(chan struct{})
	go func() { _ = c.cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		_ = c.cmd.Process.Kill()
		<-done
	}
}
