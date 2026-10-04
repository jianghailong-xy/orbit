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

// wikiRunCommands are the commands the server's tasks tell a maintenance session to run, as they write them
// (wiki-maintenance-run.ts maintenanceTaskPrompt, wiki-plan-job.ts planJobPrompt and buildJobPrompt, which the
// pg specs pin): a maintenance run's, a plan job's draft and revision, and a build's. Every one of them is a
// maintenance session, claimed with the same run and started clean the same way.
var wikiRunCommands = []struct{ job, title, command string }{
	{"maintenance run", "Wiki maintenance: Orbit", "orbit wiki maintain --space " + maintenanceSpaceID},
	{"plan draft", "Wiki plan draft: Orbit", "orbit wiki plan draft --space " + maintenanceSpaceID},
	{"plan revision", "Wiki plan redraft: Orbit", "orbit wiki plan revise --space " + maintenanceSpaceID},
	{"documents build", "Wiki documents: Orbit", "orbit wiki docs build --space " + maintenanceSpaceID},
}

// byPath is a bare `orbit …` command written by the CLI's path instead, quoted or not.
func byPath(exe, command string, quoted bool) string {
	if quoted {
		exe = shellQuote(exe)
	}
	return exe + strings.TrimPrefix(command, "orbit")
}

// claudeBashAllows is how Claude Code reads the Bash rules of --allowedTools, as far as a clean start's rules
// go — and as TestWikiMaintenanceSessionRunsItsCommandBareInTheRealClaudeCode sees the real CLI read them:
// `Bash(P *)` allows P alone or with arguments after a space, `Bash(P)` P exactly, and a command that chains,
// pipes, substitutes or redirects is never one these rules allow.
func claudeBashAllows(rules []string, command string) bool {
	if strings.ContainsAny(command, ";&|<>$`\n") {
		return false
	}
	for _, rule := range rules {
		inner, ok := strings.CutPrefix(rule, "Bash(")
		if !ok || !strings.HasSuffix(inner, ")") {
			continue
		}
		inner = strings.TrimSuffix(inner, ")")
		if prefix, wild := strings.CutSuffix(inner, " *"); wild && (command == prefix || strings.HasPrefix(command, prefix+" ")) {
			return true
		}
		if command == inner {
			return true
		}
	}
	return false
}

// linkThisBinaryAsOrbit puts a link named orbit to this test binary — orbitCLIExecutable() under `go test` —
// first on the PATH, so that `orbit` on it is the runner's own CLI, as /usr/local/bin/orbit is on a runner.
func linkThisBinaryAsOrbit(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Symlink(orbitCLIExecutable(), filepath.Join(dir, "orbit")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return dir
}

// Every maintenance session — a maintenance run, a plan job's draft or revision, a build — is started with
// its task's command pre-approved bare, as the task writes it, and by the CLI's path, quoted or not, as the
// system prompt gives it; and with nothing else: no other command of the CLI, no other program, nothing
// chained on, and no bare `orbit` pointed at another PATH.
func TestWikiMaintenanceSessionPreApprovesItsCommandBareAndByPath(t *testing.T) {
	exe := orbitCLIExecutable()
	for _, run := range wikiRunCommands {
		t.Run(run.job, func(t *testing.T) {
			linkThisBinaryAsOrbit(t)
			job := maintenanceJob(t)
			job.Title, job.Prompt = run.title, "Run this once, with the Bash tool:\n\n    "+run.command
			args, env, _ := startMaintenance(t, job, true)
			allowed, _ := argAfter(args, "--allowedTools")
			rules := strings.Split(allowed, ",")
			for _, command := range []string{run.command, byPath(exe, run.command, true), byPath(exe, run.command, false)} {
				if !claudeBashAllows(rules, command) {
					t.Errorf("%q is not pre-approved: --allowedTools %q", command, allowed)
				}
			}
			task := publicID(job.TaskID)
			for _, command := range []string{
				"ls /",
				"orbit task update " + task + " --status DONE",
				byPath(exe, "orbit task update "+task+" --status DONE", false),
				"orbit notify --title done",
				"orbit wikimaintain --space " + maintenanceSpaceID,
				run.command + " && ls /",
				"PATH=/tmp " + run.command,
			} {
				if claudeBashAllows(rules, command) {
					t.Errorf("%q is pre-approved: --allowedTools %q", command, allowed)
				}
			}
			// The engine runs them on the PATH `orbit` was looked up on.
			if env["PATH"] != os.Getenv("PATH") {
				t.Errorf("PATH=%q, want the runner's own %q, on which `orbit` is already the runner's CLI", env["PATH"], os.Getenv("PATH"))
			}
		})
	}
}

// The bare form runs whatever `orbit` the PATH finds, so it is pre-approved only where that is the runner's own
// CLI: the CLI's directory is added to the PATH when that is all it takes, and a PATH on which another `orbit`
// comes first — or an empty or relative directory, where a checkout's own `orbit` would be found — is left as
// it is and gets no bare rule. The rules by the CLI's path stay either way.
func TestWikiMaintenanceSessionPreApprovesBareOrbitOnlyWhereItIsTheRunnersOwn(t *testing.T) {
	program := func(dir string, mode os.FileMode) string {
		path := filepath.Join(dir, "orbit")
		if err := os.WriteFile(path, []byte("#!/bin/sh\n"), mode); err != nil {
			t.Fatal(err)
		}
		return path
	}
	join := func(dirs ...string) string { return strings.Join(dirs, string(os.PathListSeparator)) }
	bin, linked, other, unrunnable, empty := t.TempDir(), t.TempDir(), t.TempDir(), t.TempDir(), t.TempDir()
	exe := program(bin, 0o755)
	if err := os.Symlink(exe, filepath.Join(linked, "orbit")); err != nil {
		t.Fatal(err)
	}
	program(other, 0o755)
	program(unrunnable, 0o644)
	for _, tc := range []struct {
		name, path, exe, want string
		bare                  bool
	}{
		{"on the PATH", join(empty, bin), exe, join(empty, bin), true},
		{"linked on the PATH", join(linked, empty), exe, join(linked, empty), true},
		{"after an orbit that cannot run", join(unrunnable, bin), exe, join(unrunnable, bin), true},
		{"not on the PATH", empty, exe, join(empty, bin), true},
		{"no PATH", "", exe, bin, true},
		{"another orbit first", join(other, bin), exe, join(other, bin), false},
		{"another orbit, and not on the PATH", other, exe, other, false},
		{"an empty directory first", join("", bin), exe, join("", bin), false},
		{"a relative directory first", join("bin", bin), exe, join("bin", bin), false},
		{"no path the rules can name", bin, "", bin, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if path, bare := wikiMaintenancePath(tc.path, tc.exe); path != tc.want || bare != tc.bare {
				t.Errorf("wikiMaintenancePath(%q) = %q, %v; want %q, %v", tc.path, path, bare, tc.want, tc.bare)
			}
		})
	}

	// In the clean start: another `orbit` first on the runner's PATH, and the rules name the CLI by its path alone.
	t.Setenv("PATH", join(other, os.Getenv("PATH")))
	job := maintenanceJob(t)
	args, env, _ := startMaintenance(t, job, true)
	allowed, _ := argAfter(args, "--allowedTools")
	rules := strings.Split(allowed, ",")
	command := "orbit wiki maintain --space " + maintenanceSpaceID
	if claudeBashAllows(rules, command) || strings.Contains(allowed, "Bash(orbit ") {
		t.Errorf("the bare `orbit wiki` is pre-approved where `orbit` is another program: --allowedTools %q", allowed)
	}
	if !claudeBashAllows(rules, byPath(orbitCLIExecutable(), command, true)) || !claudeBashAllows(rules, byPath(orbitCLIExecutable(), command, false)) {
		t.Errorf("the rules by the CLI's path went with the bare ones: --allowedTools %q", allowed)
	}
	if env["PATH"] != os.Getenv("PATH") {
		t.Errorf("PATH=%q, want the runner's own %q as it was", env["PATH"], os.Getenv("PATH"))
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
	for _, want := range []string{"--bare", "--setting-sources ''", "--tools " + wikiMaintenanceBuiltinTools, "--strict-mcp-config", "--max-turns 120",
		"--allowedTools <the orbit MCP tools below and the orbit wiki commands, by the CLI's path and bare (orbitCommand)>"} {
		if !strings.Contains(flags, want) {
			t.Errorf("the contract's flags %q do not say %q", flags, want)
		}
	}
	// The orbit wiki commands by the CLI's path, and bare where `orbit` on the engine's PATH is the runner's
	// own (wikiMaintenanceAllowedTools, wikiMaintenancePath) — the very commands the tasks write.
	orbitCommand, _ := clean["orbitCommand"].(string)
	for _, want := range []string{
		"and no other command of the CLI, are pre-approved by the CLI's absolute path",
		"also as the bare `orbit wiki <command>` the task prompts write",
		"when `orbit` on the PATH the engine is handed is the runner's own executable",
		"with no empty or relative directory before it",
		"with the executable's directory added at its end",
		"the bare form is not pre-approved",
	} {
		if !strings.Contains(orbitCommand, want) {
			t.Errorf("the contract's orbitCommand %q does not say %q", orbitCommand, want)
		}
	}
	tasks := wikiMaintenanceContract(t)["job"].(map[string]interface{})["task"].(map[string]interface{})["description"].(string) + " " +
		wikiContract(t)["plan"].(map[string]interface{})["jobs"].(map[string]interface{})["task"].(map[string]interface{})["description"].(string)
	for _, written := range wikiRunCommands {
		command := "`" + strings.Replace(written.command, maintenanceSpaceID, "<id>", 1) + "`"
		if written.job == "plan revision" {
			command = "`orbit wiki plan draft --space <id>` (or `revise`)"
		}
		if !strings.Contains(tasks, command) {
			t.Errorf("the contract's task descriptions do not write %s, a command a clean start pre-approves bare", command)
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
// shell command, as a model that loops would give, so only --max-turns ends the turn. Given commands, it
// asks for those instead, one an answer and in order, and then ends the turn.
func newMaintenanceEndpoint(t *testing.T, commands ...string) (string, func() []maintenanceEndpointRequest) {
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
		command := "ls /"
		if len(commands) > 0 {
			if n > len(commands) {
				event("content_block_start", map[string]interface{}{"type": "content_block_start", "index": 0, "content_block": map[string]interface{}{
					"type": "text", "text": "",
				}})
				event("content_block_delta", map[string]interface{}{"type": "content_block_delta", "index": 0, "delta": map[string]interface{}{
					"type": "text_delta", "text": "Done.",
				}})
				event("content_block_stop", map[string]interface{}{"type": "content_block_stop", "index": 0})
				event("message_delta", map[string]interface{}{"type": "message_delta", "delta": map[string]interface{}{"stop_reason": "end_turn", "stop_sequence": nil},
					"usage": map[string]interface{}{"output_tokens": 2}})
				event("message_stop", map[string]interface{}{"type": "message_stop"})
				return
			}
			command = commands[n-1]
		}
		event("content_block_start", map[string]interface{}{"type": "content_block_start", "index": 0, "content_block": map[string]interface{}{
			"type": "tool_use", "id": "toolu_" + strings.Repeat("y", n), "name": "Bash", "input": map[string]interface{}{},
		}})
		input, _ := json.Marshal(map[string]interface{}{"command": command, "description": "run the command"})
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

// maintenanceToolResult is one tool result a request to the model carried back.
type maintenanceToolResult struct {
	IsError bool
	Text    string
}

// toolResultsOf are the tool results a request to the model carries, in the order the tools were asked for.
func toolResultsOf(t *testing.T, body string) []maintenanceToolResult {
	t.Helper()
	var request struct {
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal([]byte(body), &request); err != nil {
		t.Fatal(err)
	}
	results := []maintenanceToolResult{}
	for _, message := range request.Messages {
		var blocks []struct {
			Type    string          `json:"type"`
			IsError bool            `json:"is_error"`
			Content json.RawMessage `json:"content"`
		}
		if message.Role != "user" || json.Unmarshal(message.Content, &blocks) != nil {
			continue
		}
		for _, block := range blocks {
			if block.Type == "tool_result" {
				results = append(results, maintenanceToolResult{IsError: block.IsError, Text: string(block.Content)})
			}
		}
	}
	return results
}

// The real CLI, started clean as every maintenance session is, runs each task's command bare — `orbit` on
// its PATH being this runner's own — and by the CLI's path, quoted or not: each one is this runner's CLI,
// reaching the Orbit server as the session. And it still refuses, without asking anybody, any other
// program, a command of the CLI's other families, and a bare `orbit` pointed at another PATH.
func TestWikiMaintenanceSessionRunsItsCommandBareInTheRealClaudeCode(t *testing.T) {
	requireRealClaude(t)
	exe := orbitCLIExecutable()
	linkThisBinaryAsOrbit(t)
	job := maintenanceJob(t)

	// What reached the Orbit server, as which session and from which build: every command names a space of its
	// own, and this test binary says it is version "dev" where an installed `orbit` says its release.
	var mu sync.Mutex
	reached := map[string]string{}
	others := []string{}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if rest, ok := strings.CutPrefix(r.URL.Path, "/api/runner/wiki/spaces/"); ok {
			space, _, _ := strings.Cut(rest, "/")
			mu.Lock()
			reached[space] = r.Header.Get("X-Orbit-Session-Id") + " " + r.Header.Get(runnerCLIVersionHeader)
			mu.Unlock()
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"code":"STUB_CONTROL_PLANE","message":"the stub control plane refuses every run"}`))
			return
		}
		mu.Lock()
		others = append(others, r.Method+" "+r.URL.Path)
		mu.Unlock()
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(api.Close)
	// The CLI reads the runner's configuration only from a private directory, as a runner's is.
	if err := os.Chmod(os.Getenv("ORBIT_HOME"), 0o700); err != nil {
		t.Fatal(err)
	}
	config, _ := json.Marshal(map[string]string{"serverUrl": api.URL, "runnerToken": "runner-token"})
	if err := os.WriteFile(filepath.Join(os.Getenv("ORBIT_HOME"), "config.json"), config, 0o600); err != nil {
		t.Fatal(err)
	}

	space := func(i int) string { return "5pAceRealRun" + strconv.Itoa(100+i) }
	commands, spaces := []string{}, []string{}
	for _, run := range wikiRunCommands {
		for _, form := range []func(string) string{
			func(command string) string { return command },
			func(command string) string { return byPath(exe, command, true) },
			func(command string) string { return byPath(exe, command, false) },
		} {
			spaces = append(spaces, space(len(commands)))
			commands = append(commands, form(strings.Replace(run.command, maintenanceSpaceID, space(len(commands)), 1)))
		}
	}
	ran := len(commands)
	// Another `orbit`, which a bare one must never reach, whatever PATH the command names.
	elsewhere := t.TempDir()
	mark := filepath.Join(elsewhere, "ran")
	if err := os.WriteFile(filepath.Join(elsewhere, "orbit"), []byte("#!/bin/sh\ntouch '"+mark+"'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	commands = append(commands,
		"ls /",
		"orbit task update "+publicID(job.TaskID)+" --status DONE",
		"PATH="+elsewhere+" orbit wiki maintain --space "+space(ran),
	)
	endpoint, requests := newMaintenanceEndpoint(t, commands...)
	job.Agent.Env["ANTHROPIC_BASE_URL"] = endpoint
	job.WikiMaintenance.MaxTurns = len(commands) + 5

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
	proc, err := spawnClaude(ctx, job, t.TempDir(), args)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { proc.stdin.Close(); proc.cmd.Wait() })
	var stderr strings.Builder
	go func() { _, _ = io.Copy(&stderr, proc.stderr) }()
	frames := readFrames(t, proc.stdout)
	if _, err := io.WriteString(proc.stdin, userFrame(job.SessionUUID, []map[string]interface{}{
		{"type": "text", "text": "Run the command your task names."},
	})); err != nil {
		t.Fatal(err)
	}
	result := waitFrameTypeWithin(t, frames, "result", 3*realClaudeContractTimeout)
	if result["subtype"] != "success" {
		t.Fatalf("the turn ended %v: %v\n%s", result["subtype"], result, stderr.String())
	}

	seen := requests()
	results := toolResultsOf(t, seen[len(seen)-1].Body)
	if len(results) != len(commands) {
		t.Fatalf("the model got %d tool results back for the %d commands it ran", len(results), len(commands))
	}
	mu.Lock()
	defer mu.Unlock()
	for i, command := range commands[:ran] {
		if who, ok := reached[spaces[i]]; !ok || who != publicID(job.SessionID)+" "+version {
			t.Errorf("%q did not reach the Orbit server as the session, from this build (reached: %v, as %q): %s", command, ok, who, results[i].Text)
		}
		if !strings.Contains(results[i].Text, "the stub control plane refuses every run") {
			t.Errorf("%q came back with %s, not what the CLI printed of the server's answer", command, results[i].Text)
		}
	}
	for i, command := range commands[ran:] {
		if !results[ran+i].IsError || strings.Contains(results[ran+i].Text, "stub control plane") {
			t.Errorf("%q was not refused: %s", command, results[ran+i].Text)
		}
	}
	if _, ok := reached[space(ran)]; ok {
		t.Errorf("the bare orbit wiki maintain on another PATH reached the server")
	}
	if _, err := os.Stat(mark); err == nil {
		t.Errorf("a bare orbit ran the other `orbit`, on the PATH its command named")
	}
	for _, call := range others {
		if strings.Contains(call, "/tasks/") {
			t.Errorf("a command of another family reached the server: %s", call)
		}
	}
}
