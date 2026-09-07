//go:build linux || darwin

package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Stage 4: Codex, OpenCode and Kimi reach the runner-hosted background job path.
//
// Stage 2 built that path and served it only for Claude — but the bg_* tools are
// advertised by the `orbit` MCP server, which every engine is configured with, so
// the gate never hid the tools from the other three. It only guaranteed they were
// refused (BG_TRANSPORT_UNAVAILABLE). Each case below follows one engine's whole
// chain: the REAL spawn hands the engine an environment, a job is started using
// the socket and token out of THAT environment — never values the test computed
// for itself, which is the only way the assertion is about the wiring — and the
// job then outlives the eviction of the engine that asked for it.
//
// Every case carries stage 2's paired positive. "The process is still alive" and
// "nothing was reported killed" are both naturally true of a fixture that wired
// nothing at all, so each one also holds an engine-owned shell that must really
// die, and be really reported killed, in the same eviction.

// providerBgFixture is one session with the real background-job service serving,
// stage 2's eviction harness around it, and a fake engine on PATH that reports
// the two variables its spawn was given.
type providerBgFixture struct {
	*evictionHarness
	job     *ClaimedSession
	binDir  string
	capture string
}

// newProviderBgFixture serves the socket before the engine is spawned, which is
// the order runInteractiveSession uses: every provider reads the token file at
// spawn time, so a service started afterwards would be invisible to it.
func newProviderBgFixture(t *testing.T, executable, id string) *providerBgFixture {
	t.Helper()
	// ORBIT_HOME decides where the socket file lives, and a unix socket path is
	// capped at bgSocketPathCap. t.TempDir() names itself after the test and would
	// blow straight through that, so this root is deliberately short — a bind that
	// fails on length would fail these tests for a reason that is not the wiring.
	home, err := os.MkdirTemp("", "obg")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	t.Setenv("ORBIT_HOME", home)

	h := newEvictionHarness(t, id, 1)
	h.startEngine()

	binDir := filepath.Join(home, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	capture := filepath.Join(home, "captured-transport")
	// Two lines, always written: an engine spawned without the transport reports
	// two empty ones, which is a legible failure rather than a missing file that
	// could equally mean the fake never ran.
	writeFakeBin(t, binDir, executable,
		`printf '%s\n%s\n' "$ORBIT_BG_SOCKET" "$ORBIT_BG_TOKEN" > "$ORBIT_TEST_CAPTURE_FILE"`)
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	job := &ClaimedSession{
		SessionID:   id,
		SessionUUID: "11111111-1111-4111-8111-111111111111",
		Agent: AgentExecConfig{
			Model:          "model",
			PermissionMode: "dontAsk",
			Env:            map[string]string{"ORBIT_TEST_CAPTURE_FILE": capture},
		},
	}
	stopService, err := startSessionBgJobService(context.Background(), h.bg, job, h.dir, h.dir)
	if err != nil {
		t.Fatalf("background job service did not start: %v", err)
	}
	t.Cleanup(stopService)

	return &providerBgFixture{evictionHarness: h, job: job, binDir: binDir, capture: capture}
}

// engineTransport is the socket and token the engine's own spawn gave it. This is
// the value `orbit mcp` reads out of its inherited environment, so reading it back
// from the fake engine is what makes these tests about the provider wiring rather
// than about startJob.
func (f *providerBgFixture) engineTransport(t *testing.T) (string, string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		data, err := os.ReadFile(f.capture)
		if err == nil {
			fields := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
			if len(fields) == 2 && fields[0] != "" && fields[1] != "" {
				return fields[0], fields[1]
			}
			t.Fatalf("the engine was spawned with no background job transport"+
				" (ORBIT_BG_SOCKET/ORBIT_BG_TOKEN): %q", data)
		}
		if time.Now().After(deadline) {
			t.Fatalf("the fake engine never reported its environment: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// startJobThroughEngineTransport makes the hop `orbit mcp` makes: a real socket
// call, addressed with the engine's own coordinates.
func (f *providerBgFixture) startJobThroughEngineTransport(t *testing.T, command string) bgJobStatus {
	t.Helper()
	socket, token := f.engineTransport(t)
	raw, err := bgSocketCall(socket, token, "run", map[string]interface{}{
		"command":     command,
		"kind":        bgKindJob,
		"description": "stage 4 liveness",
	})
	if err != nil {
		t.Fatalf("bg_run over the engine's own socket failed: %v", err)
	}
	var status bgJobStatus
	if err := json.Unmarshal(raw, &status); err != nil {
		t.Fatalf("bg_run result was not a job status: %v (%s)", err, raw)
	}
	if !processAlive(status.PID) {
		t.Fatalf("bg_run reported pid %d, which is not running", status.PID)
	}
	return status
}

// engineOwnedShell is the paired positive: a shell that IS a child of the engine,
// registered exactly as Claude's tool_result registers one. It must die in the
// same eviction the runner-hosted job survives, otherwise this fixture proves
// only that nothing was evicted at all.
func (f *providerBgFixture) engineOwnedShell(t *testing.T, toolUseID string) int {
	t.Helper()
	cmd := exec.CommandContext(f.engineCtx, "bash", "-lc", "sleep 30")
	configureSessionProcessTree(cmd)
	cmd.Dir = f.dir
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting the engine-owned control shell failed: %v", err)
	}
	// Reap it, so signal 0 stops answering for a zombie and "still alive" means it.
	go func() { _ = waitSessionProcessTree(cmd) }()
	output := filepath.Join(f.dir, toolUseID+".output")
	if err := os.WriteFile(output, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	f.bg.onToolResult(toolUseID, "Command running in background with ID: "+toolUseID+
		". Output is being written to: "+output+". You will be notified when it completes.")
	return cmd.Process.Pid
}

// evictEngine runs the real pool eviction and reports what the supervisor reports.
func (f *providerBgFixture) evictEngine() {
	f.park()
	// An engine-owned shell renews the warm TTL (stage 0's deferral), so the clock
	// has to walk past the residency hard cap for the eviction to happen at all.
	f.clock.Advance(warmResidencyHardCap + time.Second)
	f.afterEngineStopped()
}

// assertSurvivedEviction is the shared verdict: the runner-hosted job is still a
// live process and was never reported killed, while the engine's own shell died
// and was.
func (f *providerBgFixture) assertSurvivedEviction(t *testing.T, job bgJobStatus, controlPID int, controlID string) {
	t.Helper()
	if !processAlive(job.PID) {
		t.Fatalf("the runner-hosted job (pid %d) died with the engine that asked for it", job.PID)
	}
	// Only a TERMINAL report contradicts survival. A job that outlives its engine
	// says so with a non-terminal report of its own, so counting every event would
	// read that announcement as the death it denies.
	var terminal []map[string]interface{}
	for _, p := range f.events.forJob(job.JobID) {
		if isTerminalBgStatus(asString(p["status"])) {
			terminal = append(terminal, p)
		}
	}
	if len(terminal) != 0 {
		t.Fatalf("the runner-hosted job was reported terminal by an engine eviction: %v", terminal)
	}
	if !f.holdsWorktree(job.JobID) {
		t.Fatalf("a job that outlived its engine no longer fences the checkout: %v",
			f.pool.worktreeHolders(f.id))
	}
	// The control, so that none of the above can pass by accident.
	waitProcessGone(t, controlPID, 5*time.Second)
	killed := f.events.withStatus("killed")
	if len(killed) != 1 || asString(killed[0]["toolUseId"]) != controlID {
		t.Fatalf("killed events = %v, want exactly the engine-owned control %q", killed, controlID)
	}
}

// Codex. Its spawn now carries the transport — and Codex needs one thing no other
// engine does: the two names must also be on mcp_servers.orbit.env_vars, because
// Codex hands an MCP server that ALLOWLIST rather than its own environment, so a
// variable missing from it never arrives however carefully the spawn sets it.
func TestCodexRunnerOwnedJobSurvivesItsEngine(t *testing.T) {
	f := newProviderBgFixture(t, providerCodex, "s-codex")

	args := codexAppServerCommandArgs(f.job, f.dir, "/usr/local/bin/orbit")
	for _, name := range []string{envBgSocket, envBgToken} {
		if !strings.Contains(strings.Join(args, " "), name) {
			t.Fatalf("%s is not on Codex's MCP env allowlist, so `orbit mcp` will never see it: %v", name, args)
		}
	}

	app, err := startCodexAppServer(context.Background(), f.job, f.dir, f.dir,
		envWithAgent(f.job.Agent.Env), func(string, map[string]interface{}) {}, nil)
	if err != nil {
		t.Fatalf("startCodexAppServer: %v", err)
	}
	defer func() {
		app.cancel()
		_ = app.cmd.Wait()
	}()

	job := f.startJobThroughEngineTransport(t, "sleep 30")
	control := f.engineOwnedShell(t, "toolu_codex")
	f.evictEngine()
	f.assertSurvivedEviction(t, job, control, "toolu_codex")
}

// OpenCode, which gains the most from this: its bash tool takes
// {command, timeout, workdir, description} and runs to completion, so before this
// wiring an OpenCode agent had no way at all to leave work running past its turn.
// The config content is asserted alongside the process environment because that
// generated block is what OpenCode actually hands its local MCP servers.
func TestOpenCodeRunnerOwnedJobSurvivesItsEngine(t *testing.T) {
	f := newProviderBgFixture(t, providerOpenCode, "s-opencode")

	content, err := openCodeConfigContent(f.job, f.dir, "orbit", nil)
	if err != nil {
		t.Fatalf("openCodeConfigContent: %v", err)
	}
	var config struct {
		MCP map[string]struct {
			Environment map[string]string `json:"environment"`
		} `json:"mcp"`
	}
	if err := json.Unmarshal([]byte(content), &config); err != nil {
		t.Fatalf("generated OpenCode config is not JSON: %v", err)
	}
	for _, name := range []string{envBgSocket, envBgToken} {
		if config.MCP["orbit"].Environment[name] == "" {
			t.Fatalf("%s is missing from the orbit MCP server's environment block: %s", name, content)
		}
	}

	runOpenCodeTurn(context.Background(), f.job, f.dir, f.dir, "hello", nil,
		func(string, map[string]interface{}) {})

	job := f.startJobThroughEngineTransport(t, "sleep 30")
	control := f.engineOwnedShell(t, "toolu_opencode")
	f.evictEngine()
	f.assertSurvivedEviction(t, job, control, "toolu_opencode")
}

// Kimi, the one engine with a real Bash(run_in_background) of its own. It gets the
// transport; what it cannot get is stage 2's guard, so the native call stays
// reachable and still dies with the engine — see startKimiACP for why, and
// TestKimiNativeBackgroundShellIsReportedKilled for what the user sees when it does.
func TestKimiRunnerOwnedJobSurvivesItsEngine(t *testing.T) {
	f := newProviderBgFixture(t, providerKimi, "s-kimi")

	app, err := startKimiACP(context.Background(), NewTransport("http://127.0.0.1:1", "runner-token"),
		f.job, f.dir, filepath.Join(f.dir, "kimi-home"), func(string, map[string]interface{}) {})
	if err != nil {
		t.Fatalf("startKimiACP: %v", err)
	}
	defer app.close()

	job := f.startJobThroughEngineTransport(t, "sleep 30")
	control := f.engineOwnedShell(t, "toolu_kimi")
	f.evictEngine()
	f.assertSurvivedEviction(t, job, control, "toolu_kimi")
}

// The honest half of the Kimi verdict. Orbit cannot refuse Kimi's own
// run_in_background — `orbit hook bg-guard` reads tool_name/tool_input and Kimi's
// PreToolUse payload spells them toolName/toolInput, and a hook that parses
// neither fails OPEN — so the least Orbit owes the user is to say when one of
// those shells is taken. Before this, nothing registered them and the loss was
// entirely silent.
func TestKimiNativeBackgroundShellIsReportedKilled(t *testing.T) {
	f := newProviderBgFixture(t, providerKimi, "s-kimibg")

	var mu sync.Mutex
	var active *kimiActiveTurn
	gauge := &kimiUsageGauge{}
	notify := func(update map[string]interface{}) {
		handleKimiNotification("kimi-1", kimiNotification(t, "kimi-1", update),
			func(string, map[string]interface{}) {}, &mu, &active, gauge, f.bg)
	}
	active = &kimiActiveTurn{orbitTurnID: "t1", seenTools: map[string]bool{}, doneTools: map[string]bool{}}

	// The negative control first, and it must stay out: a foreground Bash leaves
	// nothing running, so registering it would make every ordinary command look
	// like abandoned background work.
	notify(map[string]interface{}{
		"sessionUpdate": "tool_call", "toolCallId": "kimi_fg", "title": "Bash",
		"rawInput": map[string]interface{}{"command": "ls"},
	})
	if f.bg.hasLiveEngineShells() {
		t.Fatal("a foreground Bash call was registered as a background shell")
	}

	notify(map[string]interface{}{
		"sessionUpdate": "tool_call", "toolCallId": "kimi_bg", "title": "Bash",
		"rawInput": map[string]interface{}{
			"command": "npm run build", "run_in_background": true, "description": "build",
		},
	})
	if !f.bg.hasLiveEngineShells() {
		t.Fatal("Kimi's run_in_background shell was not registered, so its death stays invisible")
	}

	f.evictEngine()

	killed := f.events.withStatus("killed")
	if len(killed) != 1 || asString(killed[0]["toolUseId"]) != "kimi_bg" {
		t.Fatalf("killed events = %v, want exactly the backgrounded Bash call", killed)
	}
	if summary := asString(killed[0]["summary"]); summary == "" {
		t.Fatalf("the user is told a background command stopped, but not why: %v", killed[0])
	}
}
