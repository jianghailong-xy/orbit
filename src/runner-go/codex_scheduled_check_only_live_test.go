package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The live probes drive the real `codex app-server` with the runner's own parameters for a Plan
// session (codexAppServerCommandArgs, codexThreadParams, codexTurnParams), log every approval
// request, its answer and every command item, and report which commands ran and whether the
// probe's write landed. Orbit's agent context is not injected; Orbit's MCP server is, where a probe
// names the runner binary for it. Record: docs/scheduled-tasks-engine-modes.md §8.
//
//	ORBIT_CODEX_PLAN_LIVE=1 go test -run 'TestCodex.*Live' -v -count=1 -timeout 30m .

const codexPlanProbePrompt = "This is a permissions probe. Run each of these five shell commands exactly as written, one per " +
	"shell call, in this order, and do not substitute any other tool or command: (1) `ls` (2) `cat README.md` " +
	"(3) `git log --oneline -1` (4) `touch x` (5) `date > x`. Do not retry a command that is rejected or fails. " +
	"Finally, for each, say RAN with its output, or DENIED/FAILED with the exact error text."

type codexPlanProbeResult struct {
	completed  map[string]string // command -> item status/exit code
	webPages   int               // completed built-in web searches / page opens
	mcpResults []string          // each Orbit MCP tool call's result text, or its error
	wrote      bool              // x or probe.txt exists in the checkout afterwards
}

// ran reports whether a command containing want completed with exit code 0.
func (r codexPlanProbeResult) ran(want string) bool {
	for command, status := range r.completed {
		if strings.Contains(command, want) && status == "completed/0" {
			return true
		}
	}
	return false
}

func runCodexPlanProbe(t *testing.T, job *ClaimedSession, prompt, exe string, approve func(request codexApprovalRequest, params map[string]interface{}) bool, override func(thread, turn map[string]interface{})) codexPlanProbeResult {
	t.Helper()
	if os.Getenv("ORBIT_CODEX_PLAN_LIVE") != "1" {
		t.Skip("set ORBIT_CODEX_PLAN_LIVE=1 to drive the real codex app-server")
	}
	if out, err := exec.Command("codex", "--version").Output(); err == nil {
		t.Logf("codex --version: %s", strings.TrimSpace(string(out)))
	}
	repo := t.TempDir()
	stateDir := t.TempDir()
	upDir := t.TempDir() // the session uploads dir every runner session has
	for _, args := range [][]string{
		{"init", "-q"},
		{"-c", "user.email=probe@example.com", "-c", "user.name=probe", "commit", "-q", "--allow-empty", "-m", "probe commit"},
	} {
		if out, err := exec.Command("git", append([]string{"-C", repo}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("probe readme line\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	args := codexAppServerCommandArgs(job, stateDir, exe)
	t.Logf("spawn: codex %s (cwd %s)", strings.Join(args, " "), repo)
	cmd := exec.CommandContext(ctx, "codex", args...)
	cmd.Dir = repo
	cmd.Env = os.Environ()
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	app := &codexAppServer{
		cmd: cmd, ctx: ctx, cancel: cancel, stdin: stdin,
		approve: func(_ context.Context, request codexApprovalRequest, params map[string]interface{}) bool {
			allowed := approve(request, params)
			actions, _ := json.Marshal(params["commandActions"])
			t.Logf("APPROVAL REQUEST command=%q commandActions=%s fileChange=%v -> %s",
				firstString(params, "command"), actions, request.fileChange, request.decision(allowed))
			return allowed
		},
		emit:          func(string, map[string]interface{}) {},
		pending:       map[string]chan codexRPCMessage{},
		notifications: make(chan codexRPCMessage, 256),
		done:          make(chan struct{}),
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cancel()
		_ = cmd.Wait()
	}()
	go app.readLoop(stdout)
	go func() {
		s := bufio.NewScanner(stderr)
		for s.Scan() {
			_ = s.Text()
		}
	}()

	if err := app.initialize(ctx); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	threadParams := codexThreadParams(job, repo, upDir)
	turnParams := codexTurnParams("", job, repo, upDir, "probe-turn", prompt, nil, codexTurnContextOptions{})
	if override != nil {
		override(threadParams, turnParams)
	}
	logged, _ := json.Marshal(threadParams)
	t.Logf("thread/start %s", logged)
	result, err := app.request(ctx, "thread/start", threadParams)
	if err != nil {
		t.Fatalf("thread/start: %v", err)
	}
	threadID := threadIDFromResult(result)
	if threadID == "" {
		t.Fatal("thread/start returned no thread id")
	}
	turnParams["threadId"] = threadID
	input := turnParams["input"]
	delete(turnParams, "input")
	logged, _ = json.Marshal(turnParams)
	t.Logf("turn/start (input omitted) %s", logged)
	turnParams["input"] = input
	if _, err := app.request(ctx, "turn/start", turnParams); err != nil {
		t.Fatalf("turn/start: %v", err)
	}

	out := codexPlanProbeResult{completed: map[string]string{}}
	for done := false; !done; {
		select {
		case <-ctx.Done():
			t.Fatal("turn did not complete in time")
		case <-app.done:
			t.Fatal("app-server exited")
		case msg := <-app.notifications:
			params := rawObject(msg.Params)
			switch msg.Method {
			case "item/completed":
				item := mapValue(params["item"])
				switch firstString(item, "type") {
				case "commandExecution":
					t.Logf("ITEM commandExecution command=%q status=%s exitCode=%v output=%q",
						firstString(item, "command"), firstString(item, "status"), item["exitCode"], firstString(item, "aggregatedOutput"))
					out.completed[firstString(item, "command")] = fmt.Sprintf("%s/%v", firstString(item, "status"), item["exitCode"])
				case "webSearch", "mcpToolCall", "fileChange":
					logged, _ := json.Marshal(item)
					t.Logf("ITEM %s %s", firstString(item, "type"), truncateForLog(string(logged), 600))
					switch firstString(item, "type") {
					case "webSearch":
						out.webPages++
					case "mcpToolCall":
						out.mcpResults = append(out.mcpResults, truncateForLog(string(logged), 600))
					}
				case "agentMessage":
					t.Logf("AGENT MESSAGE %s", firstString(item, "text"))
				}
			case "turn/completed":
				done = true
			}
		}
	}
	for _, name := range []string{"x", "probe.txt"} {
		if _, err := os.Stat(filepath.Join(repo, name)); err == nil {
			out.wrote = true
			t.Logf("%s: PRESENT (a write landed)", name)
		} else {
			t.Logf("%s: absent (%v)", name, err)
		}
	}
	return out
}

// Why the runner does not judge commands itself: under an ordinary Plan session's parameters
// (sandbox danger-full-access) an approved write lands, so a runner-side parser would be the only
// guard (record §8.2). Every request is accepted here.
func TestCodexPlanSandboxWhenApprovedLive(t *testing.T) {
	result := runCodexPlanProbe(t, scheduledCheckOnlyJob("plan", false), codexPlanProbePrompt, "", func(codexApprovalRequest, map[string]interface{}) bool { return true }, nil)
	t.Logf("accept-all under Plan's sandbox: wrote=%v", result.wrote)
}

func truncateForLog(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

const codexNetworkProbePrompt = "This is a permissions probe. Do each of these four steps, in order, and do not substitute " +
	"another tool or retry a step that is rejected or fails: (a) open https://example.com with your built-in web " +
	"search / open-page tool (not the shell) and report the exact text of its <title>. (b) Run the shell command " +
	"`curl -sI https://example.com` exactly as written and report its first line. (c) Call the MCP tool task_get " +
	"of the orbit MCP server with no arguments and report the task's title. (d) Run the shell command `touch x`. " +
	"Finally, for each step say DONE with the result, or DENIED/FAILED with the exact error text."

// Under the read-only sandbox (approval policy never, as a scheduled CHECK_ONLY run would get), what
// reaches the network and Orbit's MCP server, with readOnly's networkAccess off and on. Orbit's MCP
// server is the installed runner binary (/usr/local/bin/orbit, overridable), run as this process's
// own ORBIT_* session; the probe only calls task_get, which reads.
func TestCodexReadOnlySandboxNetworkLive(t *testing.T) {
	exe := codexLiveOrbitExecutable()
	for _, network := range []bool{false, true} {
		t.Run(fmt.Sprintf("networkAccess=%v", network), func(t *testing.T) {
			result := runCodexPlanProbe(t, scheduledCheckOnlyJob("plan", false), codexNetworkProbePrompt, exe, func(request codexApprovalRequest, params map[string]interface{}) bool {
				// Orbit's own catalogue tools are consented to in every mode; anything else is declined.
				allowed, decided := codexAutomaticApproval("plan", request)
				return decided && allowed
			}, func(thread, turn map[string]interface{}) {
				thread["approvalPolicy"] = "never"
				thread["sandbox"] = "read-only"
				turn["approvalPolicy"] = "never"
				turn["sandboxPolicy"] = map[string]interface{}{"type": "readOnly", "networkAccess": network}
			})
			t.Logf("networkAccess=%v: curl ran=%v wrote=%v", network, result.ran("curl -sI"), result.wrote)
		})
	}
}

// codexLiveOrbitExecutable is the runner binary Codex is pointed at for Orbit's MCP server: the
// installed one unless ORBIT_CODEX_PLAN_LIVE_ORBIT names another.
func codexLiveOrbitExecutable() string {
	if exe := os.Getenv("ORBIT_CODEX_PLAN_LIVE_ORBIT"); exe != "" {
		return exe
	}
	return "/usr/local/bin/orbit"
}

// The shipped path: a scheduled CHECK_ONLY run's Plan session, its thread/start and turn/start
// exactly as the runner builds them (no override), Orbit's MCP server attached as the runner
// attaches it, and every request answered by the runner's own bridge. Reads run, the built-in web
// search fetches, Orbit's MCP server answers, and neither a shell write nor a file edit lands.
// ORBIT_CODEX_PLAN_LIVE_TASK names a task for the MCP read (task_get); without it the call is
// made with no id.
func TestCodexScheduledCheckOnlyLive(t *testing.T) {
	job := scheduledCheckOnlyJob("plan", true)
	mcpStep := "Call the MCP tool task_get of the orbit MCP server with no arguments"
	if id := os.Getenv("ORBIT_CODEX_PLAN_LIVE_TASK"); id != "" {
		mcpStep = fmt.Sprintf("Call the MCP tool task_get of the orbit MCP server with taskId %q", id)
	}
	prompt := "This is a permissions probe. Do each of these steps, in order, and do not substitute another tool, " +
		"command or retry a step that is rejected or fails: (1) run `ls` (2) run `cat README.md` (3) run " +
		"`git log --oneline -1` (4) open https://example.com with your built-in web search / open-page tool (not " +
		"the shell) and report its <title> (5) run `curl -sI https://example.com` (6) " + mcpStep + " and report the " +
		"task's title (7) run `touch x` (8) run `date > x` (9) create a file named probe.txt containing the word " +
		"probe with your file-editing (apply_patch) tool, not the shell. Run each shell command exactly as written, " +
		"one per shell call. Finally, for each step say DONE with its result, or DENIED/FAILED with the exact error text."
	var requests int
	result := runCodexPlanProbe(t, job, prompt, codexLiveOrbitExecutable(), func(request codexApprovalRequest, params map[string]interface{}) bool {
		requests++
		return bridgeCodexApprovalWithContext(context.Background(), &Transport{}, job, request, params, codexAutoApprovalContext{})
	}, nil)
	t.Logf("approval requests reaching the runner: %d", requests)
	for _, want := range []string{"ls", "cat README.md", "git log --oneline -1"} {
		if !result.ran(want) {
			t.Errorf("%q did not run", want)
		}
	}
	if result.webPages == 0 {
		t.Error("the built-in web search fetched nothing")
	}
	if len(result.mcpResults) == 0 {
		t.Error("no Orbit MCP call was made")
	}
	if result.wrote {
		t.Error("a write landed in a scheduled CHECK_ONLY run")
	}
}

// An ordinary Plan session (no scheduledCheckOnly) is unchanged: `ls` still asks and Plan declines it.
func TestCodexOrdinaryPlanLive(t *testing.T) {
	job := scheduledCheckOnlyJob("plan", false)
	prompt := "This is a permissions probe. Run the shell command `ls` exactly as written, once, do not retry, and " +
		"say RAN with its output or DENIED with the exact error text."
	result := runCodexPlanProbe(t, job, prompt, "", func(request codexApprovalRequest, params map[string]interface{}) bool {
		return bridgeCodexApprovalWithContext(context.Background(), &Transport{}, job, request, params, codexAutoApprovalContext{})
	}, nil)
	if result.ran("ls") {
		t.Error("ordinary plan: ls ran")
	}
}
