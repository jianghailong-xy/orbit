//go:build linux || darwin

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The agent's half of stage 2: the door it comes in through, the hook that sends
// it there, and the settings file that installs the hook.

func newTestBgJobService(t *testing.T) (*bgJobService, *bgTailer, func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	events := &bgJobEvents{}
	bg := newBgTailer(ctx, events.emit, nil)
	dir := t.TempDir()
	svc := &bgJobService{
		bg: bg, token: "test-token", execDir: dir, scratchDir: dir,
	}
	stop := func() {
		for _, job := range bg.listJobs(false) {
			bg.killJob(job.JobID, bgKillTeardownGrace)
		}
		bg.stopAll()
		cancel()
	}
	return svc, bg, stop
}

// One exchange over a real socket: `orbit mcp` cannot spawn a surviving process
// itself, so this hop is the whole mechanism. If it works only in-process, it
// does not work.
func TestBgJobSocketRunsAndReadsAJob(t *testing.T) {
	svc, _, stop := newTestBgJobService(t)
	defer stop()
	socket := filepath.Join(t.TempDir(), "bg.sock")
	token := filepath.Join(t.TempDir(), "bg.token")
	stopService, err := startBgJobService(context.Background(), svc, socket, token)
	if err != nil {
		t.Fatalf("service did not start: %v", err)
	}
	defer stopService()
	if data, err := os.ReadFile(token); err != nil || string(data) != "test-token" {
		t.Fatalf("token file = %q, %v", data, err)
	}

	raw, err := bgSocketCall(socket, "test-token", "run", map[string]interface{}{
		"command": "echo over-the-socket", "kind": bgKindJob,
	})
	if err != nil {
		t.Fatalf("run failed: %v", err)
	}
	var started bgJobStatus
	if err := json.Unmarshal(raw, &started); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(started.JobID, "bgj_") {
		t.Fatalf("jobId = %q, want the runner's own bgj_ id", started.JobID)
	}
	if started.ShellID != started.JobID {
		t.Fatalf("shellId %q and jobId %q disagree — the events could not be matched to the job",
			started.ShellID, started.JobID)
	}
	if !processAlive(started.PID) {
		t.Fatalf("run returned pid %d, which is not running", started.PID)
	}
	if !started.HoldsWorktree {
		t.Fatal("bg_run did not tell the caller its job fences the checkout")
	}

	// Read it back until it has ended, exactly as the agent would.
	deadline := time.Now().Add(10 * time.Second)
	var out bgJobOutput
	for time.Now().Before(deadline) {
		raw, err = bgSocketCall(socket, "test-token", "output", map[string]interface{}{"jobId": started.JobID})
		if err != nil {
			t.Fatalf("output failed: %v", err)
		}
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		if out.Status != bgStatusRunning {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if out.Status != bgStatusCompleted || out.ExitCode == nil || *out.ExitCode != 0 {
		t.Fatalf("output status/exit = %q/%v, want completed/0", out.Status, out.ExitCode)
	}
	if !strings.Contains(out.Output, "over-the-socket") {
		t.Fatalf("output = %q, want the command's stdout", out.Output)
	}

	raw, err = bgSocketCall(socket, "test-token", "list", map[string]interface{}{"includeFinished": true})
	if err != nil {
		t.Fatalf("list failed: %v", err)
	}
	var listed struct {
		Jobs      []bgJobStatus `json:"jobs"`
		LiveCount int           `json:"liveCount"`
	}
	if err := json.Unmarshal(raw, &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Jobs) != 1 || listed.LiveCount != 0 {
		t.Fatalf("list = %+v, want the one finished job and no live ones", listed)
	}
}

// kind is required and has no default. Guessing it is how a six-hour build gets
// treated as a restartable dev server, so the door refuses rather than assumes.
func TestBgJobSocketRefusesAJobWithoutAKind(t *testing.T) {
	svc, _, stop := newTestBgJobService(t)
	defer stop()
	socket := filepath.Join(t.TempDir(), "bg.sock")
	stopService, err := startBgJobService(context.Background(), svc, socket, filepath.Join(t.TempDir(), "bg.token"))
	if err != nil {
		t.Fatal(err)
	}
	defer stopService()

	if _, err := bgSocketCall(socket, "test-token", "run", map[string]interface{}{"command": "true"}); err == nil {
		t.Fatal("a job with no kind was accepted")
	}
	if _, err := bgSocketCall(socket, "test-token", "run", map[string]interface{}{
		"command": "true", "kind": "whatever",
	}); err == nil {
		t.Fatal("a job with an unknown kind was accepted")
	}
	// The paired positive: the same request with a kind is accepted, so the two
	// refusals above are about the kind and not about the door being shut.
	if _, err := bgSocketCall(socket, "test-token", "run", map[string]interface{}{
		"command": "true", "kind": bgKindJob,
	}); err != nil {
		t.Fatalf("a job WITH a kind was refused too: %v", err)
	}
}

// Same host, same user, many sessions: file permissions cannot tell one
// session's engine from another's, so the token has to.
func TestBgJobSocketRefusesAnotherSessionsToken(t *testing.T) {
	svc, bg, stop := newTestBgJobService(t)
	defer stop()
	socket := filepath.Join(t.TempDir(), "bg.sock")
	stopService, err := startBgJobService(context.Background(), svc, socket, filepath.Join(t.TempDir(), "bg.token"))
	if err != nil {
		t.Fatal(err)
	}
	defer stopService()

	if _, err := bgSocketCall(socket, "some-other-sessions-token", "run", map[string]interface{}{
		"command": "sleep 30", "kind": bgKindJob,
	}); err == nil {
		t.Fatal("a request carrying another session's token was served")
	}
	if got := bg.liveJobCount(); got != 0 {
		t.Fatalf("live jobs after a refused request = %d, want 0", got)
	}
}

// A job runs in the session's checkout. Anywhere else is a write outside what
// the worktree fence protects.
func TestBgJobSocketKeepsJobsInsideTheCheckout(t *testing.T) {
	svc, _, stop := newTestBgJobService(t)
	defer stop()
	if _, err := svc.resolveDir("/etc"); err == nil {
		t.Fatal("a job was allowed to run outside the session's directories")
	}
	if dir, err := svc.resolveDir(""); err != nil || dir != svc.execDir {
		t.Fatalf("default dir = %q, %v, want the checkout", dir, err)
	}
	sub := filepath.Join(svc.execDir, "src")
	if dir, err := svc.resolveDir("src"); err != nil || dir != sub {
		t.Fatalf("relative dir = %q, %v, want %q", dir, err, sub)
	}
}

// The tools stay visible when the socket is not there, and say what happened.
// Silently starting an engine-owned shell instead would hand the caller the one
// thing they asked to avoid.
func TestBgToolsReportAnUnavailableTransportRatherThanFallingBack(t *testing.T) {
	t.Setenv(envBgSocket, "")
	t.Setenv(envBgToken, "")
	s := &mcpServer{}
	result, handled := s.callBgTool("bg_run", map[string]interface{}{"command": "true", "kind": bgKindJob})
	if !handled {
		t.Fatal("bg_run was not routed to the background job tools")
	}
	if isErr, _ := result["isError"].(bool); !isErr {
		t.Fatalf("bg_run without a socket did not report an error: %v", result)
	}
	text := toolResultText(result["content"])
	if !strings.Contains(text, bgTransportUnavailable) {
		t.Fatalf("bg_run failure = %q, want the %s code", text, bgTransportUnavailable)
	}
	if !strings.Contains(text, "run_in_background") {
		t.Fatalf("bg_run failure = %q, want it to name the fallback it is refusing", text)
	}
}

// Every advertised tool must be routable, or the model is told about a door that
// is not there.
func TestBgToolsAreAdvertisedAndRouted(t *testing.T) {
	advertised := map[string]bool{}
	for _, descriptor := range toolDescriptors(true, true) {
		name, _ := descriptor["name"].(string)
		if strings.HasPrefix(name, "bg_") {
			advertised[name] = true
		}
	}
	for name := range bgToolNames {
		if !advertised[name] {
			t.Errorf("%s is routed but never advertised", name)
		}
	}
	if len(advertised) != len(bgToolNames) {
		t.Errorf("advertised bg tools = %v, routed = %v", advertised, bgToolNames)
	}
	// kind is required in the schema, not merely described: this is the one place
	// the requirement can be enforced before the model runs anything.
	for _, descriptor := range toolDescriptors(true, true) {
		if name, _ := descriptor["name"].(string); name != "bg_run" {
			continue
		}
		schema, _ := descriptor["inputSchema"].(map[string]interface{})
		required, _ := schema["required"].([]string)
		if !hasStringItem(required, "kind") || !hasStringItem(required, "command") {
			t.Fatalf("bg_run required = %v, want command and kind", required)
		}
	}
}

func hasStringItem(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// The hook is what routes the agent here at all. Its shape is fixed by Claude
// Code: one JSON decision on stdout, per tool call.
func TestBgGuardHookDecisions(t *testing.T) {
	decisionFor := func(in hookInput) (string, string) {
		t.Helper()
		var out bytes.Buffer
		body, err := json.Marshal(in)
		if err != nil {
			t.Fatal(err)
		}
		cmdHookBgGuard(bytes.NewReader(body), &out)
		var decoded struct {
			HookSpecificOutput struct {
				HookEventName string `json:"hookEventName"`
				Decision      string `json:"permissionDecision"`
				Reason        string `json:"permissionDecisionReason"`
			} `json:"hookSpecificOutput"`
		}
		if err := json.Unmarshal(out.Bytes(), &decoded); err != nil {
			t.Fatalf("hook output %q is not a PreToolUse decision: %v", out.String(), err)
		}
		if decoded.HookSpecificOutput.HookEventName != "PreToolUse" {
			t.Fatalf("hookEventName = %q", decoded.HookSpecificOutput.HookEventName)
		}
		return decoded.HookSpecificOutput.Decision, decoded.HookSpecificOutput.Reason
	}

	decision, reason := decisionFor(hookInput{ToolName: "Bash", ToolInput: map[string]interface{}{
		"command": "npm run build 2>&1 | tee build.log", "run_in_background": true,
	}})
	if decision != "deny" {
		t.Fatalf("Bash(run_in_background) decision = %q, want deny", decision)
	}
	if !strings.Contains(reason, "mcp__orbit__bg_run") {
		t.Fatalf("deny reason = %q, want it to name the tool to use instead", reason)
	}

	// The paired positive, twice over: an ordinary Bash call, and a background
	// sub-agent — engine-internal work the runner cannot host and must not block.
	if decision, _ := decisionFor(hookInput{ToolName: "Bash", ToolInput: map[string]interface{}{
		"command": "npm run build",
	}}); decision != "allow" {
		t.Fatalf("foreground Bash decision = %q, want allow", decision)
	}
	if decision, _ := decisionFor(hookInput{ToolName: "Agent", ToolInput: map[string]interface{}{
		"run_in_background": true,
	}}); decision != "allow" {
		t.Fatalf("background sub-agent decision = %q, want allow", decision)
	}

	// A reader asked about a runner-hosted job: the id says whose it is, because
	// the runner issued that prefix itself.
	if decision, reason := decisionFor(hookInput{ToolName: "TaskOutput", ToolInput: map[string]interface{}{
		"task_id": "bgj_0123456789ab",
	}}); decision != "deny" || !strings.Contains(reason, "mcp__orbit__bg_output") {
		t.Fatalf("TaskOutput on a bgj_ id = %q/%q, want deny naming bg_output", decision, reason)
	}
	if decision, _ := decisionFor(hookInput{ToolName: "TaskOutput", ToolInput: map[string]interface{}{
		"task_id": "bei75180m",
	}}); decision != "allow" {
		t.Fatalf("TaskOutput on the engine's own shell = %q, want allow", decision)
	}
}

// The hook only exists in a spawn if the settings file is written and passed.
func TestClaudeSpawnInstallsTheBackgroundGuardHook(t *testing.T) {
	scratch := t.TempDir()
	path, err := writeClaudeSettings(scratch, "/usr/local/bin/orbit")
	if err != nil {
		t.Fatalf("settings not written: %v", err)
	}
	if filepath.Dir(path) != scratch {
		t.Fatalf("settings at %q, want the session's own scratch dir — never the user's ~/.claude", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var settings struct {
		Hooks struct {
			PreToolUse []struct {
				Matcher string `json:"matcher"`
				Hooks   []struct {
					Type    string `json:"type"`
					Command string `json:"command"`
				} `json:"hooks"`
			} `json:"PreToolUse"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(data, &settings); err != nil {
		t.Fatalf("settings %q: %v", data, err)
	}
	matchers := map[string]string{}
	for _, entry := range settings.Hooks.PreToolUse {
		if len(entry.Hooks) != 1 {
			t.Fatalf("matcher %q has %d hooks", entry.Matcher, len(entry.Hooks))
		}
		matchers[entry.Matcher] = entry.Hooks[0].Command
	}
	if got := matchers["Bash"]; got != "/usr/local/bin/orbit hook bg-guard" {
		t.Fatalf("Bash matcher runs %q", got)
	}
	if _, ok := matchers["BashOutput|KillShell|TaskOutput|TaskStop"]; !ok {
		t.Fatalf("no matcher for the background-task readers: %v", matchers)
	}
	// Matching Agent would deny background sub-agents, which the runner cannot
	// host and which work fine today.
	for matcher := range matchers {
		if strings.Contains(matcher, "Agent") {
			t.Fatalf("matcher %q also catches sub-agent launches", matcher)
		}
	}

	// And the spawn actually passes it.
	job := &ClaimedSession{SessionID: "sess-settings", SessionUUID: "u", Provider: providerClaude,
		Agent: AgentExecConfig{Model: "claude-opus-5", PermissionMode: "auto"}}
	args := claudeCommandArgs(job, scratch, true)
	found := ""
	for i, arg := range args {
		if arg == "--settings" && i+1 < len(args) {
			found = args[i+1]
		}
	}
	if found == "" {
		t.Fatalf("claude argv does not pass --settings: %v", args)
	}
	if filepath.Dir(found) != scratch {
		t.Fatalf("--settings %q is not the session's own file", found)
	}
}
