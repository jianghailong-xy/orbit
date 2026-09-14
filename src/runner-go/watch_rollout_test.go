package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"testing"
)

// Watch's rollout flag in the runner (watch_rollout.go, docs/watch-rollout.md): a session spawned with Watch off
// meets Orbit as it was before watches, a session spawned with Watch on is kept from polling Orbit's own work, and
// a control plane that has Watch off for the account is read the way a control plane without Watch always was.

func mcpToolNames(t *testing.T, srv *mcpServer) map[string]bool {
	t.Helper()
	response, respond := srv.handle(&rpcRequest{ID: json.RawMessage(`1`), Method: "tools/list"})
	if !respond {
		t.Fatalf("tools/list got no response")
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	var listed struct {
		Result struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(encoded, &listed); err != nil {
		t.Fatalf("tools/list answered %s: %v", encoded, err)
	}
	names := map[string]bool{}
	for _, tool := range listed.Result.Tools {
		names[tool.Name] = true
	}
	return names
}

func TestWatchesOffLeavesTheWatchToolsOutAndRefusesThem(t *testing.T) {
	on := mcpToolNames(t, &mcpServer{sessionID: "caller-session", allowOrchestration: true})
	off := mcpToolNames(t, &mcpServer{sessionID: "caller-session", allowOrchestration: true, watchesOff: true})
	for name := range watchToolNames {
		if !on[name] {
			t.Errorf("%s is missing from a session with Watch on", name)
		}
		if off[name] {
			t.Errorf("%s is listed in a session spawned with Watch off", name)
		}
	}
	// The paired positive: the filter takes the watch tools and nothing else.
	for _, name := range []string{"task_get", "session_get", "session_create", "bg_run", "schedule_wakeup"} {
		if !off[name] {
			t.Errorf("%s went missing along with the watch tools", name)
		}
	}
	if len(on)-len(off) != len(watchToolNames) {
		t.Errorf("Watch off took %d tools out, want exactly the %d watch tools", len(on)-len(off), len(watchToolNames))
	}

	// A model that calls one anyway (a guessed name, a list read before a restart) is told why, and nothing is sent:
	// this server has no transport, so a request would panic.
	srv := &mcpServer{sessionID: "caller-session", allowOrchestration: true, watchesOff: true}
	for name := range watchToolNames {
		result := srv.callTool(name, map[string]interface{}{"taskIds": []interface{}{"t1"}, "sessionIds": []interface{}{"s1"}, "watchId": "w1"})
		encoded, _ := json.Marshal(result)
		if !strings.Contains(string(encoded), `"isError":true`) || !strings.Contains(string(encoded), "ORBIT_WATCHES=off") {
			t.Errorf("%s in a session with Watch off answered %s", name, encoded)
		}
	}
}

func TestSessionCreateWaitWithWatchesOffWaitsInlineWithoutAWatch(t *testing.T) {
	shortenSessionWait(t)
	t.Setenv(envWatches, "off")

	settles := &sessionWaitServer{t: t, statuses: []string{"RUNNING", "AWAITING_INPUT"}}
	out, err := runSessionCreateWait(t, settles)
	if err != nil {
		t.Fatal(err)
	}
	if n := settles.count("POST /api/runner/watches"); n != 0 {
		t.Fatalf("a session spawned with Watch off recorded %d watch(es) for its wait", n)
	}
	if n := settles.count("GET /api/runner/sessions/child-session"); n < 2 {
		t.Fatalf("the wait polled the child %d time(s), want it to wait inline: %v", n, settles.requests)
	}
	if strings.TrimSpace(out) != `{"id":"child-session","status":"AWAITING_INPUT","result":"done"}` {
		t.Fatalf("a settled answer = %s, want the session exactly as it was before watches", out)
	}

	// Not settled in time: nothing holds the wait, and the answer says so instead of passing for a normal return.
	running := &sessionWaitServer{t: t, statuses: []string{"RUNNING"}}
	out, err = runSessionCreateWait(t, running)
	if err != nil {
		t.Fatal(err)
	}
	var answer struct {
		Watch *sessionWaitWatch `json:"watch"`
	}
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		t.Fatalf("answer %s: %v", out, err)
	}
	if answer.Watch == nil || answer.Watch.Code != watchesDisabledCode || answer.Watch.ID != "" {
		t.Fatalf("an unsettled answer with Watch off carries watch %+v, want no id and code %s", answer.Watch, watchesDisabledCode)
	}
	if running.count("POST /api/runner/watches") != 0 {
		t.Fatalf("the unsettled wait recorded a watch: %v", running.requests)
	}
	wait := sessionWait{sessionID: "child-session", watch: answer.Watch}
	if note := wait.unbackedNote("session_get", "session_await"); strings.Contains(note, "session_await") {
		t.Fatalf("the note sends a session with Watch off to an await it does not have: %q", note)
	}
}

// A control plane with Watch off for the account refuses the watch with the 404 a control plane without Watch gives,
// so a runner released before the flag waits inline on it too; this one also says why.
func TestSessionCreateWaitOnAServerWithWatchesOffWaitsInline(t *testing.T) {
	shortenSessionWait(t)
	const refusal = `{"code":"WATCHES_DISABLED","message":"Watch is not on for this account on this Orbit server (ORBIT_WATCHES=drain), so no watch was made. Watches made before can still be read, paused and cancelled."}`
	server := &sessionWaitServer{t: t, statuses: []string{"RUNNING"}, watchCode: http.StatusNotFound, watchBody: refusal}
	out, err := runSessionCreateWait(t, server)
	if err != nil {
		t.Fatal(err)
	}
	if n := server.count("POST /api/runner/watches"); n != 1 {
		t.Fatalf("the refused watch was asked for %d time(s), want once: a refusal is not retried", n)
	}
	if n := server.count("GET /api/runner/sessions/child-session"); n < 2 {
		t.Fatalf("the wait polled the child %d time(s), want it to wait inline", n)
	}
	var answer struct {
		Watch *sessionWaitWatch `json:"watch"`
	}
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		t.Fatalf("answer %s: %v", out, err)
	}
	if answer.Watch == nil || answer.Watch.Code != watchesDisabledCode || !strings.Contains(answer.Watch.Error, "Watch is not on") {
		t.Fatalf("watch = %+v, want the refusal code and why no watch backs the wait", answer.Watch)
	}

	refused := &transportHTTPError{method: "POST", path: "/runner/watches", statusCode: http.StatusNotFound, body: refusal}
	if !watchDoorMissing(refused) {
		t.Fatalf("the refusal is not what a runner without the flag reads as a missing watch door, so it would not wait inline")
	}
	if !watchesDisabledByServer(refused) {
		t.Fatalf("the refusal is not read as Watch switched off")
	}
	// The paired negative: the door's own 404 for one watch is neither.
	missing := &transportHTTPError{method: "GET", path: "/runner/watches/w1", statusCode: http.StatusNotFound,
		body: `{"message":"watch not found","error":"Not Found","statusCode":404}`}
	if watchDoorMissing(missing) || watchesDisabledByServer(missing) {
		t.Fatalf("a watch that is not found reads as a door that is missing or switched off")
	}
	message := watchCallError("task_await", refused).Error()
	for _, phrase := range []string{watchesDisabledCode, "Do not fall back to polling"} {
		if !strings.Contains(message, phrase) {
			t.Errorf("task_await refused with Watch off says %q, want it to contain %q", message, phrase)
		}
	}
}

func TestWatchCommandsAreNeitherOfferedNorRunWithWatchesOff(t *testing.T) {
	configureCLITestRunner(t, "http://127.0.0.1:9")
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv("ORBIT_AGENT_ID", "")
	t.Setenv("ORBIT_SERVICE_TOKEN", "")
	t.Setenv(envMCPOrchestration, "true")
	offered := func() map[string]bool {
		ids := map[string]bool{}
		for _, capability := range buildCLICapabilities("/usr/local/bin/orbit").Capabilities {
			ids[capability.ID] = true
		}
		return ids
	}
	t.Setenv(envWatches, "on")
	on := offered()
	t.Setenv(envWatches, "off")
	off := offered()
	for name := range watchToolNames {
		if !on[name] {
			t.Errorf("capabilities with Watch on do not offer %s", name)
		}
		if off[name] {
			t.Errorf("capabilities with Watch off offer %s", name)
		}
	}
	for _, name := range []string{"task_get", "session_get", "session_create"} {
		if !off[name] {
			t.Errorf("%s went missing from capabilities along with the watch commands", name)
		}
	}

	var out bytes.Buffer
	for command, run := range map[string]func() error{
		"orbit task await": func() error { return cliTaskAwait([]string{"--task-id", "t1"}, &out) },
		"orbit session await": func() error {
			return cliSessionAwait([]string{"--session-id", "s1"}, &out, cliOrchestrationContext{sessionID: "caller-session"})
		},
		"orbit watch list": func() error { return cmdWatchCLI([]string{"list"}, strings.NewReader(""), &out) },
	} {
		if err := run(); err == nil || !strings.Contains(err.Error(), "ORBIT_WATCHES=off") {
			t.Errorf("%s with Watch off = %v, want the refusal that names ORBIT_WATCHES=off", command, err)
		}
	}
}

func TestInstructionsLeaveTheWaitParagraphOutWithWatchesOff(t *testing.T) {
	exe := "/usr/local/bin/orbit"
	on := orbitCLIInstructions(exe, true, true)
	off := orbitCLIInstructions(exe, true, false)
	if !strings.Contains(on, orbitWaitInstructions) {
		t.Fatalf("the instructions with Watch on do not route waits to task_await: %q", on)
	}
	if strings.Replace(on, orbitWaitInstructions, "", 1) != off {
		t.Fatalf("Watch off changed more than the wait paragraph:\n on: %q\noff: %q", on, off)
	}
	// Every provider that renders the instructions carries the claim's flag through to them.
	job := &ClaimedSession{TaskID: "t1", WatchesDisabled: true}
	rendered := map[string]string{
		"claude":           strings.Join(appendClaudeAgentInstructionArgs(nil, AgentExecConfig{}, exe, false, job.insideRecordedWork(), job.watchesOn()), "\n"),
		"codex items":      fmt.Sprint(codexInjectedAgentItems(AgentExecConfig{}, exe, job.insideRecordedWork(), job.watchesOn())),
		"codex context":    fmt.Sprint(codexAgentAdditionalContext(AgentExecConfig{}, exe, 1, job.insideRecordedWork(), job.watchesOn())),
		"codex legacy":     codexLegacyAgentContext(AgentExecConfig{}, exe, job.insideRecordedWork(), job.watchesOn()),
		"kimi":             kimiPromptText(AgentExecConfig{}, exe, "hello", job.insideRecordedWork(), job.watchesOn()),
		"opencode":         openCodeOrbitCLIInstructions(exe, job.insideRecordedWork(), job.watchesOn()),
		"claude, Watch on": strings.Join(appendClaudeAgentInstructionArgs(nil, AgentExecConfig{}, exe, false, true, true), "\n"),
	}
	for provider, text := range rendered {
		wantParagraph := provider == "claude, Watch on"
		if strings.Contains(text, "call task_await or session_await") != wantParagraph {
			t.Errorf("%s renders the wait paragraph = %v, want %v", provider, !wantParagraph, wantParagraph)
		}
	}
}

func TestClaimedWatchesDisabledDecodesAndDefaultsToOn(t *testing.T) {
	var disabled, legacy ClaimedSession
	if err := json.Unmarshal([]byte(`{"sessionId":"s1","watchesDisabled":true}`), &disabled); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(`{"sessionId":"s1"}`), &legacy); err != nil {
		t.Fatal(err)
	}
	var none *ClaimedSession
	if disabled.watchesOn() || !legacy.watchesOn() || !none.watchesOn() {
		t.Fatalf("watchesOn: disabled=%v legacy=%v nil=%v, want false, true, true", disabled.watchesOn(), legacy.watchesOn(), none.watchesOn())
	}
	if watchesEnv(true) != "off" || watchesEnv(false) != "on" {
		t.Fatalf("watchesEnv renders %q/%q", watchesEnv(true), watchesEnv(false))
	}
	for value, want := range map[string]bool{"": true, "on": true, "off": false, " OFF ": false, "0": false, "garbage": true} {
		t.Setenv(envWatches, value)
		if got := watchesEnabledFromEnv(); got != want {
			t.Errorf("ORBIT_WATCHES=%q reads as enabled=%v, want %v", value, got, want)
		}
	}
}

func guardDecision(tool string, input map[string]interface{}) (string, string) {
	out := bgGuardDecision(hookInput{HookEventName: "PreToolUse", ToolName: tool, ToolInput: input})
	specific, _ := out["hookSpecificOutput"].(map[string]interface{})
	decision, _ := specific["permissionDecision"].(string)
	reason, _ := specific["permissionDecisionReason"].(string)
	return decision, reason
}

type guardCall struct {
	tool  string
	input map[string]interface{}
}

func command(text string) map[string]interface{} {
	return map[string]interface{}{"command": text}
}

// The polls in these cases have the shapes found in one deployment's tool calls (docs/watch-rollout.md §4).
var orbitPolls = []guardCall{
	{"Bash", command("sleep 25; /usr/local/bin/orbit session get 34Auoj4e88z3k8M19wwn8 --json | jq '{status,runStatus}'")},
	{"Bash", command(`for i in $(seq 1 30); do st=$(orbit task get 34NcutOmkLEub00h4jw5a --json | jq -r .status); [ "$st" = DONE ] && break; sleep 60; done`)},
	{"Bash", map[string]interface{}{"command": "while true; do orbit task list --json; sleep 30; done", "run_in_background": true}},
	{"Monitor", map[string]interface{}{"command": `while :; do docker exec -i orbit-postgres psql -U orbit -d orbit -tAc "select status from task where id='x'"; sleep 30; done`, "description": "the task", "persistent": true}},
	{"mcp__orbit__bg_run", map[string]interface{}{"command": "watch -n 30 '/usr/local/bin/orbit' session list --json", "kind": "watch"}},
	{"Bash", command("python3 - <<'EOF'\nimport subprocess, time\nwhile True:\n    subprocess.run('orbit session get X --json', shell=True)\n    time.sleep(20)\nEOF")},
	{"Bash", command(`until curl -s -H "Authorization: Bearer $T" "$ORBIT/api/sessions/X" | grep -q AWAITING_INPUT; do sleep 10; done`)},
}

func TestBgGuardRefusesPollingOrbitWorkAndNothingElse(t *testing.T) {
	t.Setenv(envWatches, "")
	for _, call := range orbitPolls {
		decision, reason := guardDecision(call.tool, call.input)
		if decision != "deny" || reason != bgGuardOrbitPollReason {
			t.Errorf("%s %q = %s (%q), want the refusal that sends the wait to task_await", call.tool, call.input["command"], decision, reason)
		}
	}
	for _, call := range []guardCall{
		{"Bash", command("/usr/local/bin/orbit task get 34NcutOmkLEub00h4jw5a --json")},
		{"Bash", command("/usr/local/bin/orbit task await --task-id 34NcutOmkLEub00h4jw5a --json")},
		{"Bash", command("sleep 30 && gh run view 17632 --json status -R jianghailong-xy/orbit")},
		{"Bash", command(`docker exec orbit-postgres psql -U orbit -d orbit -tAc "select status from task where id='x'"`)},
		{"Bash", command(`sleep 5; psql -d shop -c "select * from task"`)},
		{"Bash", command("sleep 120")},
		{"mcp__orbit__bg_run", map[string]interface{}{"command": "npm run dev -- --port 5173", "kind": "service"}},
		// A script run by its path is not opened: its contents are not something the hook can read reliably.
		{"mcp__orbit__bg_run", map[string]interface{}{"command": "bash scratch/watch-tasks.sh 34NcutOmkLEub00h4jw5a 12 20", "kind": "watch"}},
		{"Monitor", map[string]interface{}{"command": "tail -F build.log | grep --line-buffered -E 'FAIL|ok '", "persistent": true}},
	} {
		if decision, reason := guardDecision(call.tool, call.input); decision != "allow" {
			t.Errorf("%s %q = %s (%q), want allow", call.tool, call.input["command"], decision, reason)
		}
	}
	// A background shell that polls nothing is still sent to bg_run, and still told how to wait on Orbit's work.
	decision, reason := guardDecision("Bash", map[string]interface{}{"command": "npm test", "run_in_background": true})
	if decision != "deny" || reason != bgGuardDenyReason {
		t.Errorf("a background npm test = %s (%q), want the bg_run refusal", decision, reason)
	}
}

func TestBgGuardLetsPollsThroughWithWatchesOff(t *testing.T) {
	t.Setenv(envWatches, "off")
	for _, call := range orbitPolls {
		decision, reason := guardDecision(call.tool, call.input)
		if call.input["run_in_background"] == true {
			// Still a shell the engine owns: the bg_run refusal stands, without the await it cannot point at.
			if decision != "deny" || strings.Contains(reason, "task_await") {
				t.Errorf("a background poll with Watch off = %s (%q), want the bg_run refusal without await advice", decision, reason)
			}
			continue
		}
		if decision != "allow" {
			t.Errorf("%s %q with Watch off = %s (%q), want allow: polling is how waiting worked before watches", call.tool, call.input["command"], decision, reason)
		}
	}
	decision, reason := guardDecision("ScheduleWakeup", map[string]interface{}{"delaySeconds": 600})
	if decision != "deny" || !strings.Contains(reason, "mcp__orbit__schedule_wakeup") || strings.Contains(reason, "task_await") {
		t.Errorf("ScheduleWakeup with Watch off = %s (%q), want the schedule_wakeup refusal without await advice", decision, reason)
	}
}

func TestClaudeSettingsSendMonitorAndBgRunThroughTheGuard(t *testing.T) {
	path, err := writeClaudeSettings(t.TempDir(), "/usr/local/bin/orbit", false)
	if err != nil {
		t.Fatal(err)
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
					Command string `json:"command"`
				} `json:"hooks"`
			} `json:"PreToolUse"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(data, &settings); err != nil {
		t.Fatalf("settings %s: %v", data, err)
	}
	for _, tool := range []string{"Bash", "Monitor", "mcp__orbit__bg_run"} {
		reached := false
		for _, entry := range settings.Hooks.PreToolUse {
			if regexp.MustCompile("^(?:"+entry.Matcher+")$").MatchString(tool) && len(entry.Hooks) == 1 &&
				entry.Hooks[0].Command == "/usr/local/bin/orbit hook bg-guard" {
				reached = true
			}
		}
		if !reached {
			t.Errorf("no PreToolUse matcher sends %s to the bg-guard hook: %s", tool, data)
		}
	}
	// The negative the matchers must keep: other MCP tools are not sent through the hook.
	for _, entry := range settings.Hooks.PreToolUse {
		if regexp.MustCompile("^(?:" + entry.Matcher + ")$").MatchString("mcp__orbit__task_get") {
			t.Errorf("matcher %q also sends task_get through the hook", entry.Matcher)
		}
	}
}
