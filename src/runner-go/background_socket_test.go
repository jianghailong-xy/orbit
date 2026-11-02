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
		bg: bg, token: "test-token", execDir: dir, scratchDir: dir, mode: func() string { return "auto" },
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

	// The job waits for this file, written once its pid has been looked at: a job that is only
	// `echo` can be over, and reaped, before the reply to `run` reaches the caller.
	release := filepath.Join(t.TempDir(), "release")
	raw, err := bgSocketCall(socket, "test-token", "run", map[string]interface{}{
		"command": "echo over-the-socket; while [ ! -e " + shellQuote(release) + " ]; do sleep 0.01; done",
		"kind":    bgKindJob,
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
	if err := os.WriteFile(release, nil, 0o600); err != nil {
		t.Fatal(err)
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

// A job runs inside its session, and the gated writes have to be able to tell.
//
// `envWithAgent` strips session context from the inherited environment and from the caller's `env`
// alike, which is right: an agent may not CLAIM a session. But nothing used to put back the one the
// runner KNOWS, so every job ran with `ORBIT_SESSION_ID` empty — and empty is exactly what
// `askBeforeCreate` reads as "there is nobody to ask", the terminal case. `orbit task create`,
// `orbit task create-batch`, `orbit project create` and `orbit project resolve-blocker` therefore
// wrote with no confirmation card at all from inside a job.
//
// The job never lacked the AUTHORITY for those writes — it reaches the runner token through
// ORBIT_HOME either way — so what the stripping removed was only the ability to ASK. On 2026-09-17
// that turned "put this blocker in front of the owner" into "resolve it", with no card ever shown.
func TestBgJobCarriesTheSessionTheRunnerKnowsSoGatedWritesStillAsk(t *testing.T) {
	svc, _, stop := newTestBgJobService(t)
	defer stop()
	// The runner holds sessions as UUIDs; everything an agent reads or types is base62, so the job
	// is handed the same spelling every other injection site uses. The expected value is written
	// out rather than computed with `publicID`, which would only assert that one function agrees
	// with itself.
	svc.sessionID = "01a0b054-0e51-730d-8025-958b250fcf35"
	const sessionPublicID = "34QUYxDhxmt3NInyOJmmj"
	socket := filepath.Join(t.TempDir(), "bg.sock")
	token := filepath.Join(t.TempDir(), "bg.token")
	stopService, err := startBgJobService(context.Background(), svc, socket, token)
	if err != nil {
		t.Fatalf("service did not start: %v", err)
	}
	defer stopService()

	raw, err := bgSocketCall(socket, "test-token", "run", map[string]interface{}{
		"command": `printf 'SESSION=[%s]\n' "$ORBIT_SESSION_ID"`,
		"kind":    bgKindJob,
		// The caller's own claim, which must lose to the runner's knowledge rather than win over it.
		"env": map[string]interface{}{"ORBIT_SESSION_ID": "session-the-agent-claims"},
	})
	if err != nil {
		t.Fatalf("run failed: %v", err)
	}
	var started bgJobStatus
	if err := json.Unmarshal(raw, &started); err != nil {
		t.Fatal(err)
	}

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
	if out.Status != bgStatusCompleted {
		t.Fatalf("job status = %q, want it to have finished", out.Status)
	}
	if !strings.Contains(out.Output, "SESSION=["+sessionPublicID+"]") {
		t.Fatalf("job environment = %q, want SESSION=[%s] — an empty one is the terminal case, and "+
			"gated writes take it without asking anybody; the raw UUID is a spelling nothing else "+
			"here speaks", strings.TrimSpace(out.Output), sessionPublicID)
	}
}

// A job also carries WHICH job it is, so a card it asks for is not collected with the turn.
//
// The session id alone made the gated writes ask; it did not keep the card alive to be answered. A
// runner-hosted job outlives the turn — that is what hosting it on the runner is for — and the CLI
// inside it goes on polling after the turn ends, so the turn-ended reaper collected the card and the
// owner's later Allow reached nobody (apiserver sessions/abandoned-approvals.ts). The card now names
// the job, off the environment the launcher writes here. It is the runner's own id in both senses
// that matter: the value `bg_list` and `bg_output` answer to, and one the caller's own `env` cannot
// claim any more than it can claim a session.
func TestBgJobCarriesItsOwnIdSoItsCardsOutliveTheTurn(t *testing.T) {
	svc, _, stop := newTestBgJobService(t)
	defer stop()
	svc.sessionID = "01a0b054-0e51-730d-8025-958b250fcf35"
	socket := filepath.Join(t.TempDir(), "bg.sock")
	token := filepath.Join(t.TempDir(), "bg.token")
	stopService, err := startBgJobService(context.Background(), svc, socket, token)
	if err != nil {
		t.Fatalf("service did not start: %v", err)
	}
	defer stopService()

	raw, err := bgSocketCall(socket, "test-token", "run", map[string]interface{}{
		"command": `printf 'JOB=[%s]\n' "$ORBIT_BG_JOB_ID"`,
		"kind":    bgKindJob,
		// The claim, which must lose: a job that can name another job can keep another job's card
		// alive, and the reaper would read that as "somebody is still reading this".
		"env": map[string]interface{}{"ORBIT_BG_JOB_ID": "bgj_claimedsomeoneelses"},
	})
	if err != nil {
		t.Fatalf("run failed: %v", err)
	}
	var started bgJobStatus
	if err := json.Unmarshal(raw, &started); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(started.JobID, "bgj_") || started.JobID == "bgj_claimedsomeoneelses" {
		t.Fatalf("job id = %q, want the runner's own token", started.JobID)
	}

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
	if out.Status != bgStatusCompleted {
		t.Fatalf("job status = %q, want it to have finished", out.Status)
	}
	if !strings.Contains(out.Output, "JOB=["+started.JobID+"]") {
		t.Fatalf("job environment = %q, want JOB=[%s]: the id the job files its cards under, and "+
			"what the reaper checks them against", strings.TrimSpace(out.Output), started.JobID)
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
			HookSpecificOutput *struct {
				HookEventName string `json:"hookEventName"`
				Decision      string `json:"permissionDecision"`
				Reason        string `json:"permissionDecisionReason"`
			} `json:"hookSpecificOutput"`
		}
		if err := json.Unmarshal(out.Bytes(), &decoded); err != nil {
			t.Fatalf("hook output %q is not JSON: %v", out.String(), err)
		}
		if decoded.HookSpecificOutput == nil {
			return "", "" // no verdict: the call takes the session's own permission flow
		}
		if decoded.HookSpecificOutput.HookEventName != "PreToolUse" {
			t.Fatalf("hookEventName = %q", decoded.HookSpecificOutput.HookEventName)
		}
		return decoded.HookSpecificOutput.Decision, decoded.HookSpecificOutput.Reason
	}
	const noVerdict = ""
	everyMode := []string{"default", "acceptEdits", "plan", "dontAsk", "auto", "bypassPermissions", "", "a-mode-from-later"}
	// What the hook has no objection to: approved in the modes that do not ask, and left to the session's
	// own permission flow in every other, because Claude Code reads an allow as a person's approval.
	noObjection := func(mode string) string {
		if mode == "auto" || mode == "bypassPermissions" {
			return "allow"
		}
		return noVerdict
	}

	for _, mode := range everyMode {
		decision, reason := decisionFor(hookInput{ToolName: "Bash", PermissionMode: mode, ToolInput: map[string]interface{}{
			"command": "npm run build 2>&1 | tee build.log", "run_in_background": true,
		}})
		if decision != "deny" {
			t.Fatalf("%q: Bash(run_in_background) decision = %q, want deny", mode, decision)
		}
		if !strings.Contains(reason, "mcp__orbit__bg_run") {
			t.Fatalf("%q: deny reason = %q, want it to name the tool to use instead", mode, reason)
		}

		// An ordinary Bash call, the same path's Monitor, and a background sub-agent: engine-internal
		// work the runner cannot host and must not block.
		if decision, _ := decisionFor(hookInput{ToolName: "Bash", PermissionMode: mode, ToolInput: map[string]interface{}{
			"command": "npm run build",
		}}); decision != noObjection(mode) {
			t.Fatalf("%q: foreground Bash decision = %q, want %q", mode, decision, noObjection(mode))
		}
		if decision, _ := decisionFor(hookInput{ToolName: "Monitor", PermissionMode: mode, ToolInput: map[string]interface{}{
			"command": "tail -f build.log",
		}}); decision != noObjection(mode) {
			t.Fatalf("%q: Monitor decision = %q, want %q", mode, decision, noObjection(mode))
		}
		if decision, _ := decisionFor(hookInput{ToolName: "Agent", PermissionMode: mode, ToolInput: map[string]interface{}{
			"run_in_background": true,
		}}); decision != noObjection(mode) {
			t.Fatalf("%q: background sub-agent decision = %q, want %q", mode, decision, noObjection(mode))
		}

		// A reader asked about a runner-hosted job: the id says whose it is, because
		// the runner issued that prefix itself.
		if decision, reason := decisionFor(hookInput{ToolName: "TaskOutput", PermissionMode: mode, ToolInput: map[string]interface{}{
			"task_id": "bgj_0123456789ab",
		}}); decision != "deny" || !strings.Contains(reason, "mcp__orbit__bg_output") {
			t.Fatalf("%q: TaskOutput on a bgj_ id = %q/%q, want deny naming bg_output", mode, decision, reason)
		}
		if decision, _ := decisionFor(hookInput{ToolName: "TaskOutput", PermissionMode: mode, ToolInput: map[string]interface{}{
			"task_id": "bei75180m",
		}}); decision != noObjection(mode) {
			t.Fatalf("%q: TaskOutput on the engine's own shell = %q, want %q", mode, decision, noObjection(mode))
		}

		// bg_run itself: refused here in Plan, so no pointless card comes first, and otherwise the
		// runner's gate decides.
		decision, reason = decisionFor(hookInput{ToolName: "mcp__orbit__bg_run", PermissionMode: mode, ToolInput: map[string]interface{}{
			"command": "npm run build", "kind": "job",
		}})
		if mode == "plan" {
			if decision != "deny" || reason != bgGatePlanRefusal {
				t.Fatalf("bg_run in Plan = %q/%q, want the gate's refusal", decision, reason)
			}
		} else if decision != noObjection(mode) {
			t.Fatalf("%q: bg_run decision = %q, want %q", mode, decision, noObjection(mode))
		}

		// The two timers keep being refused whatever the mode.
		for _, tool := range []string{"ScheduleWakeup", "CronCreate"} {
			if decision, _ := decisionFor(hookInput{ToolName: tool, PermissionMode: mode}); decision != "deny" {
				t.Fatalf("%q: %s = %q, want deny", mode, tool, decision)
			}
		}
	}
}

// A hook that could not read its payload gives no verdict either: nothing is approved on its account, and
// nothing is blocked.
func TestBgGuardHookUnreadablePayloadGivesNoVerdict(t *testing.T) {
	var out bytes.Buffer
	cmdHookBgGuard(strings.NewReader("not json"), &out)
	if strings.TrimSpace(out.String()) != "{}" {
		t.Fatalf("hook output = %q, want an empty object", out.String())
	}
}

// The hook only exists in a spawn if the settings file is written and passed.
func TestClaudeSpawnInstallsTheBackgroundGuardHook(t *testing.T) {
	scratch := t.TempDir()
	path, err := writeClaudeSettings(scratch, "/usr/local/bin/orbit", false)
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
