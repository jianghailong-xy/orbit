package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// A Wiki maintenance session's clean start (wiki_maintenance_session.go, contracts/wiki.contract.json
// `maintenance.run`): what the engine is started with, what it is not, and what happens to a run the turn
// limit cut short.

const maintenanceSpaceID = "5pAceMaintenance00001"

// maintenanceJob is a maintenance session as the server claims one: pinned to a configured provider on the
// Claude Code runtime, with the run's guardrails in its agent config — and, around it, everything a clean
// start must leave behind: the runner's own API key and variables, the workspace's, an effort.
func maintenanceJob(t *testing.T) *ClaimedSession {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv("ANTHROPIC_API_KEY", "sk-runner-own-key")
	t.Setenv("RUNNER_OWN_SECRET", "runner-secret")
	t.Setenv("CLAUDE_CODE_ENTRYPOINT", "runner-own-claude")
	maxTurns := 120
	return &ClaimedSession{
		SessionID:   "11111111-2222-4333-8444-555555555555",
		SessionUUID: "11111111-2222-4333-8444-555555555555",
		TaskID:      "21111111-2222-4333-8444-555555555555",
		AgentID:     "31111111-2222-4333-8444-555555555555",
		Title:       "Wiki maintenance run",
		Prompt:      "run the maintenance of the space",
		Agent: AgentExecConfig{
			Provider:           providerClaude,
			Model:              "qwen3.8-27b-fp8",
			PermissionMode:     "dontAsk",
			Effort:             "xhigh",
			MaxTurns:           &maxTurns,
			AllowedTools:       []string{"mcp__orbit__*", "Bash(npm test:*)"},
			SystemPrompt:       "the workspace's own system prompt",
			AppendSystemPrompt: "the workspace's appended prompt",
			McpConfig:          map[string]interface{}{"workspace-server": map[string]interface{}{"command": "workspace-mcp"}},
			Env: map[string]string{
				"ANTHROPIC_BASE_URL":             "http://127.0.0.1:8000",
				"ANTHROPIC_AUTH_TOKEN":           "provider-token",
				"ANTHROPIC_MODEL":                "qwen3.8-27b-fp8",
				"CLAUDE_CODE_MAX_CONTEXT_TOKENS": "131072",
				"CLAUDE_CODE_EFFORT_LEVEL":       "high",
				"ANTHROPIC_API_KEY":              "sk-workspace-key",
				"WORKSPACE_OWN_VAR":              "workspace-value",
			},
		},
		WikiMaintenance: &WikiMaintenanceRun{
			SpaceID:           maintenanceSpaceID,
			WorkspaceID:       "41111111-2222-4333-8444-555555555555",
			Provider:          "local-vllm",
			ProviderFallbacks: []string{},
			MaxTurns:          120,
			DisallowedTools:   []string{"Task", "Agent", "WebFetch", "WebSearch"},
			CleanStart:        true,
		},
	}
}

// startMaintenance prepares the run and spawns it against the fake CLI, as runClaudeSessionProcess does:
// the argv, and the environment the process was started with.
func startMaintenance(t *testing.T, job *ClaimedSession, firstSpawn bool) (args []string, env map[string]string, scratch string) {
	t.Helper()
	fake := newFakeClaude(t, fakeStep{Emit: "system_init"})
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	scratch = t.TempDir()
	if err := prepareWikiMaintenanceStart(job, scratch); err != nil {
		t.Fatal(err)
	}
	args = claudeCommandArgs(job, scratch, firstSpawn)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	proc, err := spawnClaude(ctx, job, t.TempDir(), args)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { proc.stdin.Close(); proc.cmd.Wait() })
	env = map[string]string{}
	for _, kv := range proc.cmd.Env {
		k, v, _ := strings.Cut(kv, "=")
		env[k] = v
	}
	spawns := fake.Spawns()
	if len(spawns) == 0 {
		waitUntil(t, func() bool { return len(fake.Spawns()) > 0 }, "the clean start was never spawned")
		spawns = fake.Spawns()
	}
	if diff := argvDiff(spawns[0].Argv, args); diff != "" {
		t.Fatalf("the process was started with other flags than were built: %s", diff)
	}
	return args, env, scratch
}

func argAfter(args []string, flag string) (string, bool) {
	for i, arg := range args {
		if arg == flag && i+1 < len(args) {
			return args[i+1], true
		}
	}
	return "", false
}

// --bare, no settings of the workspace's, a HOME and a config directory of the session's own with nothing in
// them but the onboarding mark, and the maintenance run's own short system prompt in place of the workspace's
// prompts and the Orbit instructions.
func TestWikiMaintenanceSessionStartsBareInAnEmptyHome(t *testing.T) {
	job := maintenanceJob(t)
	args, env, scratch := startMaintenance(t, job, true)

	for _, want := range [][]string{
		{"-p"},
		{"--bare"},
		{"--setting-sources", ""},
		{"--input-format", "stream-json"},
		{"--output-format", "stream-json"},
		{"--replay-user-messages"},
		{"--tools", "Bash"},
		{"--strict-mcp-config"},
		{"--max-turns", "120"},
		{"--permission-mode", "dontAsk"},
		{"--model", "qwen3.8-27b-fp8"},
		{"--session-id", job.SessionUUID},
	} {
		if !containsArgs(args, want) {
			t.Errorf("argv %q is missing %q", args, want)
		}
	}
	for _, flag := range []string{"--append-system-prompt", "--permission-prompt-tool", "--add-dir", "--effort", "--resume"} {
		if _, found := argAfter(args, flag); found {
			t.Errorf("a clean start carries %s: %q", flag, args)
		}
	}
	prompt, _ := argAfter(args, "--system-prompt")
	if !strings.Contains(prompt, "Wiki maintenance run") || !strings.Contains(prompt, "orbit wiki maintain") ||
		!strings.Contains(prompt, "task_progress_report") || !strings.Contains(prompt, "120 turns") {
		t.Errorf("the system prompt does not say what a maintenance run does: %q", prompt)
	}
	if strings.Contains(prompt, "workspace's own") || strings.Contains(strings.Join(args, " "), "Orbit tasks are the user's durable record") {
		t.Errorf("the workspace's prompts or the Orbit instructions reached a clean start: %q", args)
	}

	home, config := wikiMaintenanceDirs(scratch)
	if env["HOME"] != home || env["CLAUDE_CONFIG_DIR"] != config {
		t.Fatalf("HOME=%q CLAUDE_CONFIG_DIR=%q, want the session's own %q and %q", env["HOME"], env["CLAUDE_CONFIG_DIR"], home, config)
	}
	for _, dir := range []string{home, config} {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 1 || entries[0].Name() != ".claude.json" {
			t.Errorf("%s holds %v, want the onboarding mark alone", dir, entries)
		}
		mark, _ := os.ReadFile(filepath.Join(dir, ".claude.json"))
		if string(mark) != `{"hasCompletedOnboarding":true}` {
			t.Errorf("%s/.claude.json = %s", dir, mark)
		}
	}
	// Where the session's conversation lives is the clean config directory, for the rebuild before a
	// --resume as for the engine.
	if dir, err := claudeSessionAccountDir(job.Agent.Env, t.TempDir()); err != nil || dir != config {
		t.Errorf("the transcript is looked for in %q (%v), want %q", dir, err, config)
	}
	if env["ORBIT_HOME"] != os.Getenv("ORBIT_HOME") {
		t.Errorf("ORBIT_HOME=%q, want the runner's %q: under the clean HOME the CLI would not find its configuration", env["ORBIT_HOME"], os.Getenv("ORBIT_HOME"))
	}
	for key, want := range map[string]string{
		"ORBIT_SESSION_ID":          publicID(job.SessionID),
		"ORBIT_TASK_ID":             publicID(job.TaskID),
		"ORBIT_ALLOW_ORCHESTRATION": "0",
	} {
		if env[key] != want {
			t.Errorf("%s=%q, want %q", key, env[key], want)
		}
	}
	for _, key := range []string{"RUNNER_OWN_SECRET", "CLAUDE_CODE_ENTRYPOINT", "WORKSPACE_OWN_VAR", "ORBIT_BG_SOCKET", "ORBIT_BG_TOKEN"} {
		if value, ok := env[key]; ok {
			t.Errorf("%s=%q reached a clean start", key, value)
		}
	}

	// A re-spawn continues the same conversation, in the same directories, which it does not empty.
	if err := os.WriteFile(filepath.Join(config, "kept.jsonl"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := prepareWikiMaintenanceStart(job, scratch); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(config, "kept.jsonl")); err != nil {
		t.Errorf("a re-spawn emptied the session's own config directory: %v", err)
	}
	if again := claudeCommandArgs(job, scratch, false); !containsArgs(again, []string{"--resume", job.SessionUUID}) {
		t.Errorf("a re-spawn does not resume the conversation: %q", again)
	}
}

// --strict-mcp-config with the orbit server alone, and that server serving the three task tools a run
// reports with: listed, callable, and every other tool neither.
func TestWikiMaintenanceSessionMountsOnlyTheOrbitServerWithItsTools(t *testing.T) {
	job := maintenanceJob(t)
	args, _, _ := startMaintenance(t, job, true)
	path, _ := argAfter(args, "--mcp-config")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		MCPServers map[string]struct {
			Command string            `json:"command"`
			Args    []string          `json:"args"`
			Env     map[string]string `json:"env"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(raw, &config); err != nil {
		t.Fatal(err)
	}
	if len(config.MCPServers) != 1 {
		t.Fatalf("the clean start mounts %d MCP servers, want the orbit server alone: %s", len(config.MCPServers), raw)
	}
	orbit, ok := config.MCPServers["orbit"]
	if !ok || orbit.Command != orbitCLIExecutable() || strings.Join(orbit.Args, " ") != "mcp" {
		t.Fatalf("the one server is not orbit mcp: %s", raw)
	}
	want := "task_get,task_comment,task_progress_report"
	if orbit.Env[envMCPTools] != want {
		t.Errorf("the orbit server is told %s=%q, want %q", envMCPTools, orbit.Env[envMCPTools], want)
	}

	// The server, spawned with that list: tools/list names these three and no other, and a call to any other
	// is refused without reaching Orbit (the server has no transport to reach it with).
	t.Setenv(envMCPTools, orbit.Env[envMCPTools])
	srv := &mcpServer{allowPermissionPrompt: true, onlyTools: mcpToolsFromEnv()}
	resp, _ := srv.handle(&rpcRequest{ID: json.RawMessage("1"), Method: "tools/list"})
	listed := []string{}
	for _, tool := range resp.Result.(map[string]interface{})["tools"].([]map[string]interface{}) {
		listed = append(listed, tool["name"].(string))
	}
	sort.Strings(listed)
	if got := strings.Join(listed, ","); got != "task_comment,task_get,task_progress_report" {
		t.Errorf("the orbit server lists %s", got)
	}
	for _, name := range []string{"task_update", "task_create", "session_create", "wiki_propose", "bg_run", "permission_prompt"} {
		params, _ := json.Marshal(map[string]interface{}{"name": name, "arguments": map[string]interface{}{}})
		resp, _ := srv.handle(&rpcRequest{ID: json.RawMessage("2"), Method: "tools/call", Params: params})
		result, _ := resp.Result.(map[string]interface{})
		if result["isError"] != true {
			t.Errorf("%s was served to a maintenance run: %v", name, resp)
		}
	}

	// The only pre-approvals are those three tools and the `orbit wiki` commands.
	allowed, _ := argAfter(args, "--allowedTools")
	for _, tool := range wikiMaintenanceTools {
		if !strings.Contains(allowed, "mcp__orbit__"+tool) {
			t.Errorf("--allowedTools %q does not pre-approve %s", allowed, tool)
		}
	}
	for _, rule := range strings.Split(allowed, ",") {
		if !strings.HasPrefix(rule, "mcp__orbit__task_") && !strings.Contains(rule, " wiki ") {
			t.Errorf("--allowedTools pre-approves %q, which a maintenance run has no use for", rule)
		}
	}
	if !strings.Contains(allowed, " wiki dossier *)") || !strings.Contains(allowed, " wiki cursor advance *)") {
		t.Errorf("--allowedTools %q leaves out the orbit wiki commands", allowed)
	}
}

// Sub-agents and the web are named in --disallowedTools as well as left out of --tools, and they come from
// the run itself: an agent config that forgot them does not bring them back.
func TestWikiMaintenanceSessionDisallowsSubagentsAndTheWeb(t *testing.T) {
	job := maintenanceJob(t)
	job.Agent.DisallowedTools = []string{"Bash(rm -rf *)"}
	args, _, _ := startMaintenance(t, job, true)
	disallowed, _ := argAfter(args, "--disallowedTools")
	got := map[string]bool{}
	for _, tool := range strings.Split(disallowed, ",") {
		got[tool] = true
	}
	for _, tool := range append([]string{"Task", "Agent", "WebFetch", "WebSearch", "Bash(rm -rf *)"}, builtinTaskTools...) {
		if !got[tool] {
			t.Errorf("--disallowedTools %q does not name %s", disallowed, tool)
		}
	}
	if tools, _ := argAfter(args, "--tools"); tools != "Bash" {
		t.Errorf("--tools %q, want the shell alone", tools)
	}
}

// The provider's token goes out through apiKeyHelper, and no ANTHROPIC_API_KEY — the runner's or the
// workspace's — reaches a bare run, which would send it as x-api-key to an endpoint that answers that 401.
func TestWikiMaintenanceSessionAuthenticatesThroughAPIKeyHelper(t *testing.T) {
	job := maintenanceJob(t)
	args, env, _ := startMaintenance(t, job, true)
	settings := settingsFileFrom(t, args)
	if len(settings) != 1 || settings["apiKeyHelper"] != "printenv ANTHROPIC_AUTH_TOKEN" {
		t.Errorf("the settings a clean start is given = %v, want the apiKeyHelper alone", settings)
	}
	if key, ok := env["ANTHROPIC_API_KEY"]; ok {
		t.Errorf("ANTHROPIC_API_KEY=%q reached a bare run", key)
	}
	for key, want := range map[string]string{
		"ANTHROPIC_BASE_URL":             "http://127.0.0.1:8000",
		"ANTHROPIC_AUTH_TOKEN":           "provider-token",
		"ANTHROPIC_MODEL":                "qwen3.8-27b-fp8",
		"CLAUDE_CODE_MAX_CONTEXT_TOKENS": "131072",
	} {
		if env[key] != want {
			t.Errorf("%s=%q, want the provider's %q", key, env[key], want)
		}
	}
}

// No thinking unless asked: the CLI sends a model it does not know an effort and adaptive thinking of its own
// accord, and neither the workspace's effort nor the provider's effort variable turns that back on.
func TestWikiMaintenanceSessionDoesNotThinkByDefault(t *testing.T) {
	job := maintenanceJob(t)
	args, env, _ := startMaintenance(t, job, true)
	if env["CLAUDE_CODE_EFFORT_LEVEL"] != "unset" || env["MAX_THINKING_TOKENS"] != "0" {
		t.Errorf("CLAUDE_CODE_EFFORT_LEVEL=%q MAX_THINKING_TOKENS=%q, want unset and 0", env["CLAUDE_CODE_EFFORT_LEVEL"], env["MAX_THINKING_TOKENS"])
	}
	if effort, found := argAfter(args, "--effort"); found {
		t.Errorf("a clean start asks for effort %q", effort)
	}
}

// An ordinary session is started as it always was: nothing of the clean start reaches it.
func TestWikiMaintenanceSessionLeavesOrdinarySessionsAlone(t *testing.T) {
	job := maintenanceJob(t)
	job.WikiMaintenance = nil
	args := claudeCommandArgs(job, t.TempDir(), true)
	for _, flag := range []string{"--bare", "--setting-sources", "--tools", "--strict-mcp-config", "--max-turns"} {
		if _, found := argAfter(args, flag); found || containsArgs(args, []string{flag}) {
			t.Errorf("an ordinary session carries %s: %q", flag, args)
		}
	}
	if !containsArgs(args, []string{"--effort", "xhigh"}) {
		t.Errorf("an ordinary session lost its effort: %q", args)
	}
}

// A run that may not start — the server's refusal, or a runtime other than Claude Code — ends FAILED with
// why, and no engine is started for it.
func TestWikiMaintenanceSessionRefusalStartsNoEngine(t *testing.T) {
	// Asserted in the source first, as TestSourceRefusedRunFailsBeforeAnyEngine does, so a build without the
	// check stops here instead of reaching the engine path through the call below.
	source, err := os.ReadFile("session.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(source)[strings.Index(string(source), "func runSessionProcess("):]
	refusal, engine := strings.Index(body, "wikiMaintenanceRefusal(job)"), strings.Index(body, "ensureEngine(")
	if refusal < 0 || engine < 0 || refusal > engine {
		t.Fatalf("runSessionProcess does not stop a refused maintenance run before ensureEngine (refusal check at %d, ensureEngine at %d)", refusal, engine)
	}
	for name, mutate := range map[string]func(*ClaimedSession){
		"refused by the server": func(job *ClaimedSession) {
			job.WikiMaintenance.Refusal = "This Wiki maintenance run did not start: 'codex' runs on the codex runtime."
		},
		"on another runtime": func(job *ClaimedSession) { job.Provider = providerCodex },
	} {
		t.Run(name, func(t *testing.T) {
			fake := newFakeClaude(t, fakeStep{Emit: "system_init"})
			t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
			job := maintenanceJob(t)
			mutate(job)
			var events []string
			emit := func(eventType string, payload map[string]interface{}) {
				msg, _ := payload["message"].(string)
				events = append(events, eventType+": "+msg)
			}
			st, ended, reload := runSessionProcess(context.Background(), context.Background(), nil, job, "", "", t.TempDir(),
				emit, nil, func(string) {}, true, nil, nil, nil, nil, nil)
			if st != stFailed || !ended || reload {
				t.Errorf("runSessionProcess = (%s, ended=%v, reload=%v), want a failed end", st, ended, reload)
			}
			if len(events) != 1 || !strings.HasPrefix(events[0], evError+": This Wiki maintenance run did not start") {
				t.Errorf("events = %q, want one error saying why", events)
			}
			if spawns := fake.Spawns(); len(spawns) != 0 {
				t.Errorf("a refused run started an engine: %v", spawns)
			}
		})
	}
}

// A run cut short by --max-turns failed: the CLI's error_max_turns turn is completed FAILED, and the runner
// records the run on the space's cursor as truncated, as the calling session — the run can no longer say it.
// A run that ends well records nothing there: saying how it went is its own job.
func TestWikiMaintenanceSessionCutShortIsAFailure(t *testing.T) {
	for _, tc := range []struct {
		name      string
		subtype   string
		isError   bool
		status    string
		truncated bool
	}{
		{"cut short", "error_max_turns", true, stFailed, true},
		{"finished", "success", false, stSucceeded, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := newFakeClaude(t,
				fakeStep{Await: "user"},
				fakeStep{Emit: "replay_user"},
				fakeStep{Emit: "system_init"},
				fakeStep{Emit: "tool_use", ToolUseID: "toolu_1", ToolName: "Bash", Input: map[string]interface{}{"command": "orbit wiki maintain"}},
				fakeStep{Emit: "result", Subtype: tc.subtype, IsError: tc.isError, Text: "Reached maximum number of turns (120)"},
			)
			t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
			job := maintenanceJob(t)

			var mu sync.Mutex
			served := false
			var cursorPosts []map[string]interface{}
			var cursorSessions []string
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.HasSuffix(r.URL.Path, "/inbox"):
					mu.Lock()
					first := !served
					served = true
					mu.Unlock()
					if first {
						_ = json.NewEncoder(w).Encode(RunInboxResponse{TurnID: "turn-1", Seq: 1, Kind: "message", Content: job.Prompt})
						return
					}
				case r.Method == http.MethodPost && r.URL.Path == "/api/runner/wiki/spaces/"+maintenanceSpaceID+"/cursor":
					body, _ := io.ReadAll(r.Body)
					var sent map[string]interface{}
					_ = json.Unmarshal(body, &sent)
					mu.Lock()
					cursorPosts = append(cursorPosts, sent)
					cursorSessions = append(cursorSessions, r.Header.Get("X-Orbit-Session-Id"))
					mu.Unlock()
					_, _ = w.Write([]byte(`{"advanced":false,"outcome":"truncated"}`))
					return
				}
				_, _ = w.Write([]byte(`{}`))
			}))
			t.Cleanup(api.Close)

			var settled []TurnCompleteRequest
			complete := func(r TurnCompleteRequest, _ ...context.Context) error {
				mu.Lock()
				defer mu.Unlock()
				settled = append(settled, r)
				return nil
			}
			ctx, cancel := context.WithTimeout(context.Background(), fakeClaudeTimeout)
			defer cancel()
			dir := t.TempDir()
			done := make(chan struct{})
			go func() {
				defer close(done)
				runClaudeSessionProcess(ctx, context.Background(), NewTransport(api.URL, "runner-token"),
					job, "11111111-1111-4111-8111-111111111111", dir, dir,
					func(string, map[string]interface{}) {}, func(string, string, map[string]interface{}) {}, func(string) {},
					true, nil, complete, func(context.Context) bool { return true }, func(error) {})
			}()
			waitUntil(t, func() bool {
				mu.Lock()
				defer mu.Unlock()
				return len(settled) > 0
			}, "the turn was never completed")
			cancel()
			<-done

			mu.Lock()
			defer mu.Unlock()
			if settled[0].TurnID != "turn-1" || settled[0].Status != tc.status || settled[0].Subtype != tc.subtype {
				t.Errorf("the turn was completed %s (%s), want %s (%s)", settled[0].Status, settled[0].Subtype, tc.status, tc.subtype)
			}
			if !tc.truncated {
				if len(cursorPosts) != 0 {
					t.Errorf("a run that finished was recorded on the cursor by the runner: %v", cursorPosts)
				}
				return
			}
			if len(cursorPosts) != 1 {
				t.Fatalf("the cursor was told %d times, want once: %v", len(cursorPosts), cursorPosts)
			}
			if cursorPosts[0]["outcome"] != "truncated" || cursorPosts[0]["to"] != nil {
				t.Errorf("the cursor was told %v, want outcome truncated and no token", cursorPosts[0])
			}
			if why, _ := cursorPosts[0]["error"].(string); !strings.Contains(why, "120 model turns") {
				t.Errorf("the cursor's error does not say the turn limit cut it short: %q", why)
			}
			if cursorSessions[0] != job.SessionID {
				t.Errorf("the cursor was told as session %q, want the run's own %q", cursorSessions[0], job.SessionID)
			}
		})
	}
}

// The reclaim hands the run back, so a restarted runner starts it clean again.
func TestWikiMaintenanceSessionSurvivesAReclaim(t *testing.T) {
	var reclaimed ReclaimResponse
	payload := `{"sessions":[{"sessionId":"s1","title":"Wiki maintenance run","sessionUuid":"u1","maxSeq":3,` +
		`"agent":{"model":"qwen3.8-27b-fp8","permissionMode":"dontAsk","allowedTools":[],"disallowedTools":[]},` +
		`"wikiMaintenance":{"spaceId":"` + maintenanceSpaceID + `","workspaceId":"w1","provider":"local-vllm",` +
		`"providerFallbacks":[],"maxTurns":120,"disallowedTools":["Task","Agent","WebFetch","WebSearch"],"cleanStart":true}}]}`
	if err := json.Unmarshal([]byte(payload), &reclaimed); err != nil {
		t.Fatal(err)
	}
	job := claimedSessionFromReclaim(reclaimed.Sessions[0])
	if !job.wikiMaintenanceCleanStart() || job.WikiMaintenance.SpaceID != maintenanceSpaceID || job.WikiMaintenance.MaxTurns != 120 {
		t.Fatalf("the reclaimed session lost its run: %+v", job.WikiMaintenance)
	}
}

// What this binary does is what the contract says a clean start is: the capability it declares, the MCP
// tools, the one built-in tool, and the run's numbers it is handed.
func TestWikiMaintenanceSessionIsTheContracts(t *testing.T) {
	run := wikiMaintenanceContract(t)["run"].(map[string]interface{})
	if run["capability"] != wikiMaintenanceRunV1 {
		t.Errorf("the contract's capability %v is not %q", run["capability"], wikiMaintenanceRunV1)
	}
	if !strings.Contains(runnerCapabilitiesV1, wikiMaintenanceRunV1) {
		t.Errorf("this runner does not declare %s: %q", wikiMaintenanceRunV1, runnerCapabilitiesV1)
	}
	clean := run["cleanStart"].(map[string]interface{})
	declared := []string{}
	for _, tool := range clean["mcpTools"].([]interface{}) {
		declared = append(declared, tool.(string))
	}
	if strings.Join(declared, ",") != strings.Join(wikiMaintenanceTools, ",") {
		t.Errorf("the MCP tools here are %v, the contract's %v", wikiMaintenanceTools, declared)
	}
	if run["maxTurns"].(float64) != 120 || run["permissionMode"] != "dontAsk" || run["runtime"] != providerClaude {
		t.Errorf("the contract's run is %v", run)
	}
	if run["bashTimeoutMs"] != float64(wikiMaintainRunBudget.Milliseconds()) {
		t.Errorf("the contract's bashTimeoutMs %v is not this runner's Bash budget %d", run["bashTimeoutMs"], wikiMaintainRunBudget.Milliseconds())
	}
	disallowed := []string{}
	for _, tool := range run["disallowedTools"].([]interface{}) {
		disallowed = append(disallowed, tool.(string))
	}
	if strings.Join(disallowed, ",") != "Task,Agent,WebFetch,WebSearch" {
		t.Errorf("the contract's disallowed tools are %v", disallowed)
	}
	flags := strings.Join(func() []string {
		out := []string{}
		for _, flag := range clean["flags"].([]interface{}) {
			out = append(out, flag.(string))
		}
		return out
	}(), " ")
	for _, want := range []string{"--bare", "--setting-sources ''", "--tools " + wikiMaintenanceBuiltinTools, "--strict-mcp-config", "--max-turns 120"} {
		if !strings.Contains(flags, want) {
			t.Errorf("the contract's flags %q do not say %q", flags, want)
		}
	}
}

// ── The real Claude Code, where this machine has one ────────────────────────────────────────────

// testOrbitMCPEnv makes this test binary serve as `orbit mcp` (TestMain), so a real Claude Code that starts
// the maintenance run's orbit server gets the real one, with the real tool list.
const testOrbitMCPEnv = "ORBIT_TEST_AS_ORBIT_MCP"

// maintenanceEndpointRequest is what the fake model endpoint saw of one request.
type maintenanceEndpointRequest struct {
	Authorization, APIKey, Model, System string
	Tools                                []string
	Thinking, Effort                     bool
	Body                                 string
}

// newMaintenanceEndpoint is the model endpoint of a run that never ends on its own: every answer is a
// shell command, as a model that loops would give, so only --max-turns ends the turn.
func newMaintenanceEndpoint(t *testing.T) (string, func() []maintenanceEndpointRequest) {
	t.Helper()
	var mu sync.Mutex
	var seen []maintenanceEndpointRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !strings.HasPrefix(r.URL.Path, "/v1/messages") {
			w.WriteHeader(http.StatusOK) // /health, HEAD /api/hello
			return
		}
		raw, _ := io.ReadAll(r.Body)
		if strings.HasPrefix(r.URL.Path, "/v1/messages/count_tokens") {
			_, _ = w.Write([]byte(`{"input_tokens":1}`))
			return
		}
		var body map[string]interface{}
		_ = json.Unmarshal(raw, &body)
		request := maintenanceEndpointRequest{
			Authorization: r.Header.Get("Authorization"),
			APIKey:        r.Header.Get("X-Api-Key"),
			Body:          string(raw),
		}
		request.Model, _ = body["model"].(string)
		system, _ := json.Marshal(body["system"])
		request.System = string(system)
		tools, _ := body["tools"].([]interface{})
		for _, tool := range tools {
			name, _ := tool.(map[string]interface{})["name"].(string)
			request.Tools = append(request.Tools, name)
		}
		sort.Strings(request.Tools)
		_, request.Thinking = body["thinking"]
		_, request.Effort = body["output_config"]
		mu.Lock()
		seen = append(seen, request)
		n := len(seen)
		mu.Unlock()
		model, _ := body["model"].(string)
		w.Header().Set("Content-Type", "text/event-stream")
		event := func(name string, data interface{}) {
			b, _ := json.Marshal(data)
			_, _ = io.WriteString(w, "event: "+name+"\ndata: "+string(b)+"\n\n")
		}
		event("message_start", map[string]interface{}{"type": "message_start", "message": map[string]interface{}{
			"id": "msg_" + strings.Repeat("x", n), "type": "message", "role": "assistant", "model": model, "content": []interface{}{},
			"stop_reason": nil, "stop_sequence": nil, "usage": map[string]interface{}{"input_tokens": 10, "output_tokens": 1},
		}})
		event("content_block_start", map[string]interface{}{"type": "content_block_start", "index": 0, "content_block": map[string]interface{}{
			"type": "tool_use", "id": "toolu_" + strings.Repeat("y", n), "name": "Bash", "input": map[string]interface{}{},
		}})
		input, _ := json.Marshal(map[string]interface{}{"command": "ls /", "description": "list the root"})
		event("content_block_delta", map[string]interface{}{"type": "content_block_delta", "index": 0, "delta": map[string]interface{}{
			"type": "input_json_delta", "partial_json": string(input),
		}})
		event("content_block_stop", map[string]interface{}{"type": "content_block_stop", "index": 0})
		event("message_delta", map[string]interface{}{"type": "message_delta", "delta": map[string]interface{}{"stop_reason": "tool_use", "stop_sequence": nil},
			"usage": map[string]interface{}{"output_tokens": 5}})
		event("message_stop", map[string]interface{}{"type": "message_stop"})
	}))
	t.Cleanup(srv.Close)
	return srv.URL, func() []maintenanceEndpointRequest {
		mu.Lock()
		defer mu.Unlock()
		return append([]maintenanceEndpointRequest(nil), seen...)
	}
}

// The real CLI takes the clean start as this file builds it, and does with it what the clean start is
// for: every request carries the provider's token as a Bearer and never the runner's ANTHROPIC_API_KEY,
// no thinking and no effort, the maintenance run's own system prompt and nothing of the checkout's
// CLAUDE.md or settings, and exactly the shell and the orbit server's three tools; a command nobody
// pre-approved is refused rather than asked about; and the turn limit ends the turn as error_max_turns.
func TestWikiMaintenanceSessionDrivesTheRealClaudeCodeCleanly(t *testing.T) {
	requireRealClaude(t)
	endpoint, requests := newMaintenanceEndpoint(t)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{}`)) }))
	t.Cleanup(api.Close)
	job := maintenanceJob(t)
	job.Agent.Env["ANTHROPIC_BASE_URL"] = endpoint
	job.WikiMaintenance.MaxTurns = 2
	config, _ := json.Marshal(map[string]string{"serverUrl": api.URL, "runnerToken": "runner-token"})
	if err := os.WriteFile(filepath.Join(os.Getenv("ORBIT_HOME"), "config.json"), config, 0o600); err != nil {
		t.Fatal(err)
	}
	// A checkout that would turn an ordinary Claude Code into something else: its CLAUDE.md, and settings
	// whose env block would send every request to a port nothing listens on.
	execDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(execDir, ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(execDir, "CLAUDE.md"), []byte("# MAINTENANCE-PROBE-CLAUDE-MD\n"), 0o644)
	_ = os.WriteFile(filepath.Join(execDir, ".claude", "settings.json"), []byte(`{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:1"}}`), 0o644)

	scratch := t.TempDir()
	if err := prepareWikiMaintenanceStart(job, scratch); err != nil {
		t.Fatal(err)
	}
	args := claudeCommandArgs(job, scratch, true)
	// Under `go test` the orbit server is this test binary; TestMain serves it as `orbit mcp` when told to.
	mcpPath, _ := argAfter(args, "--mcp-config")
	raw, _ := os.ReadFile(mcpPath)
	var mcp map[string]map[string]map[string]interface{}
	if err := json.Unmarshal(raw, &mcp); err != nil {
		t.Fatal(err)
	}
	mcp["mcpServers"]["orbit"]["env"].(map[string]interface{})[testOrbitMCPEnv] = "1"
	raw, _ = json.Marshal(mcp)
	if err := os.WriteFile(mcpPath, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	proc, err := spawnClaude(ctx, job, execDir, args)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { proc.stdin.Close(); proc.cmd.Wait() })
	var stderr strings.Builder
	go func() { _, _ = io.Copy(&stderr, proc.stderr) }()
	frames := readFrames(t, proc.stdout)
	if _, err := io.WriteString(proc.stdin, userFrame(job.SessionUUID, []map[string]interface{}{
		{"type": "text", "text": "Run the maintenance of the space."},
	})); err != nil {
		t.Fatal(err)
	}
	result := waitFrameTypeWithin(t, frames, "result", realClaudeContractTimeout)
	if result["subtype"] != claudeMaxTurnsSubtype || result["is_error"] != true {
		t.Fatalf("the turn ended %v (is_error %v), want error_max_turns: %v\n%s", result["subtype"], result["is_error"], result, stderr.String())
	}

	seen := requests()
	if len(seen) != 2 {
		t.Fatalf("the endpoint was asked %d times, want once for each of the 2 turns the run was given", len(seen))
	}
	wantTools := "Bash,mcp__orbit__task_comment,mcp__orbit__task_get,mcp__orbit__task_progress_report"
	for i, request := range seen {
		if request.Authorization != "Bearer provider-token" || (request.APIKey != "" && request.APIKey != "provider-token") {
			t.Errorf("request %d authorized with %q / x-api-key %q: want the provider's token as a Bearer, never ANTHROPIC_API_KEY", i, request.Authorization, request.APIKey)
		}
		if got := strings.Join(request.Tools, ","); got != wantTools {
			t.Errorf("request %d offered the tools %s, want %s", i, got, wantTools)
		}
		if request.Thinking || request.Effort {
			t.Errorf("request %d asked the model to think (thinking %v, output_config %v)", i, request.Thinking, request.Effort)
		}
		if request.Model != "qwen3.8-27b-fp8" || !strings.Contains(request.System, "You are a Wiki maintenance run of Orbit") {
			t.Errorf("request %d: model %q, system %s", i, request.Model, request.System)
		}
		for _, leak := range []string{"MAINTENANCE-PROBE-CLAUDE-MD", "Orbit tasks are the user's durable record", "sk-runner-own-key", "sk-workspace-key"} {
			if strings.Contains(request.Body, leak) {
				t.Errorf("request %d carries %q", i, leak)
			}
		}
		t.Logf("request %d: %d bytes", i, len(request.Body))
	}
	// The command the model asked for was never pre-approved: refused, and nobody was asked.
	if !strings.Contains(seen[1].Body, `"is_error":true`) {
		t.Errorf("the unapproved command was not refused: %s", seen[1].Body)
	}
	// The engine took the five hours from the environment: the Bash tool it offers says a call may ask for
	// them, where its own most is ten minutes.
	var offered struct {
		Tools []struct {
			Name        string `json:"name"`
			InputSchema struct {
				Properties map[string]struct {
					Description string `json:"description"`
				} `json:"properties"`
			} `json:"input_schema"`
		} `json:"tools"`
	}
	_ = json.Unmarshal([]byte(seen[0].Body), &offered)
	budget := strconv.FormatInt(wikiMaintainRunBudget.Milliseconds(), 10)
	for _, tool := range offered.Tools {
		if timeout := tool.InputSchema.Properties["timeout"].Description; tool.Name == "Bash" && !strings.Contains(timeout, budget) {
			t.Errorf("the Bash tool offers its timeout as %q: the engine did not take the %s ms of the environment", timeout, budget)
		}
	}
}
