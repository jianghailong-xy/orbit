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

// startCursorSession starts the session process a launch describes, as the ACP driver will, plus the
// credential the session brings. It returns a function that sends one request and reads its answer, and
// one that kills the process tree the way a crash or a runner restart ends it.
func startCursorSession(t *testing.T, spec CursorLaunchSpec, credential string) (func(id int, method string) string, func()) {
	t.Helper()
	cmd := exec.CommandContext(context.Background(), spec.Executable, spec.Args...)
	cmd.Dir = spec.Cwd
	cmd.Env = append(append([]string(nil), spec.Env...), credential)
	configureSessionProcessTree(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	var stopped bool
	stop := func() {
		if !stopped {
			stopped = true
			_ = terminateSessionProcessTree(cmd)
			_ = cmd.Wait()
		}
	}
	t.Cleanup(stop)
	replies := bufio.NewReader(stdout)
	ask := func(id int, method string) string {
		t.Helper()
		params := "{}"
		if method == "session/new" {
			params = fmt.Sprintf(`{"cwd":%q,"mcpServers":[]}`, spec.Cwd)
		}
		if _, err := fmt.Fprintf(stdin, `{"jsonrpc":"2.0","id":%d,"method":%q,"params":%s}`+"\n", id, method, params); err != nil {
			t.Fatal(err)
		}
		line, err := replies.ReadString('\n')
		if err != nil {
			t.Fatalf("%s: %v", method, err)
		}
		return line
	}
	return ask, stop
}

func envMap(env []string) map[string]string {
	out := map[string]string{}
	for _, entry := range env {
		k, v, _ := strings.Cut(entry, "=")
		out[k] = v
	}
	return out
}

// Every session gets a CURSOR_CONFIG_DIR, a CURSOR_DATA_DIR and a HOME of its own, private, inside its
// scratch directory; another process of the same session — after a crash, a restart — finds the
// conversation store and the CLI's own settings where the last one left them, and no other session sees
// them.
func TestCursorLaunchSpecIsolatesSessionDirectories(t *testing.T) {
	home := useCursorRealHome(t)
	newFakeCursorRelease(t)
	allowCursorInstall(t, true)
	execDir := t.TempDir()
	jobA := &ClaimedSession{SessionID: "11111111-2222-4333-8444-555555555555", AgentID: "a", TaskID: "t"}
	jobB := &ClaimedSession{SessionID: "21111111-2222-4333-8444-555555555555", AgentID: "a"}

	a, err := PrepareCursorSessionLaunch(context.Background(), jobA, execDir, nil) // installs on demand
	if err != nil {
		t.Fatal(err)
	}
	b, err := PrepareCursorSessionLaunch(context.Background(), jobB, execDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	wantExe := filepath.Join(home, ".orbit", "cursor", "versions", cursorSupportedVersion, cursorEntryPoint)
	for _, spec := range []CursorLaunchSpec{a, b} {
		if spec.Executable != wantExe || spec.Version != cursorSupportedVersion {
			t.Fatalf("launch runs %q (%s), want the pinned %q", spec.Executable, spec.Version, wantExe)
		}
		if real, _ := filepath.EvalSymlinks(execDir); spec.Cwd != real {
			t.Fatalf("launch cwd = %q, want the session checkout %q", spec.Cwd, real)
		}
	}
	for session, spec := range map[*ClaimedSession]CursorLaunchSpec{jobA: a, jobB: b} {
		dir := filepath.Join(runDir(session.SessionID), "cursor")
		env := envMap(spec.Env)
		for key, want := range map[string]string{"CURSOR_CONFIG_DIR": filepath.Join(dir, "config"),
			"CURSOR_DATA_DIR": filepath.Join(dir, "data"), "HOME": filepath.Join(dir, "home")} {
			if env[key] != want {
				t.Fatalf("%s %s = %q, want %q", session.SessionID, key, env[key], want)
			}
			info, err := os.Lstat(want)
			if err != nil || !info.IsDir() || info.Mode().Perm() != 0o700 {
				t.Fatalf("%s is not a private directory: %v %v", want, info, err)
			}
		}
		if spec.ConfigDir != env["CURSOR_CONFIG_DIR"] || spec.DataDir != env["CURSOR_DATA_DIR"] || spec.Home != env["HOME"] {
			t.Fatalf("the spec's directories disagree with its environment: %+v", spec)
		}
	}
	if a.ConfigDir == b.ConfigDir || a.DataDir == b.DataDir || a.Home == b.Home {
		t.Fatal("two sessions share Cursor CLI directories")
	}

	ask, crash := startCursorSession(t, a, "CURSOR_API_KEY=session-key")
	if line := ask(1, "session/new"); !strings.Contains(line, `"sessionId":"fake-session"`) {
		t.Fatalf("session/new = %q", line)
	}
	store := filepath.Join(a.ConfigDir, "acp-sessions", "fake-session", "store.db")
	if _, err := os.Stat(store); err != nil {
		t.Fatalf("the conversation store is not in the session's config directory: %v", err)
	}
	crash()

	again, err := PrepareCursorSessionLaunch(context.Background(), jobA, execDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if again.ConfigDir != a.ConfigDir || again.DataDir != a.DataDir || again.Home != a.Home {
		t.Fatalf("the next process of the session got other directories: %+v", again)
	}
	if data, err := os.ReadFile(store); err != nil || string(data) != "conversation" {
		t.Fatalf("the conversation store did not survive the restart: %q, %v", data, err)
	}
	var config map[string]interface{}
	data, err := os.ReadFile(filepath.Join(again.ConfigDir, "cli-config.json"))
	if err != nil || json.Unmarshal(data, &config) != nil || config["channel"] != "static" || config["permissions"] == nil {
		t.Fatalf("cli-config.json after a restart = %s, %v: the CLI's settings and Orbit's channel both stay", data, err)
	}
	if _, err := os.Stat(filepath.Join(b.ConfigDir, "acp-sessions")); !os.IsNotExist(err) {
		t.Fatal("another session's config directory holds this session's conversation")
	}
	if err := os.WriteFile(filepath.Join(b.ConfigDir, "cli-config.json"), []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := PrepareCursorSessionLaunch(context.Background(), jobB, execDir, nil); err == nil || !strings.HasPrefix(err.Error(), "CURSOR_CONFIG_CONFLICT:") {
		t.Fatalf("a cli-config.json Orbit cannot read = %v, want a refusal that leaves it alone", err)
	}
	if data, _ := os.ReadFile(filepath.Join(b.ConfigDir, "cli-config.json")); string(data) != "not json" {
		t.Fatal("an unreadable cli-config.json was overwritten")
	}
	for _, bad := range []string{"../escape", "a/b", ""} {
		if _, err := prepareCursorLaunchFor(t, bad, execDir); err == nil {
			t.Fatalf("session id %q was given a directory", bad)
		}
	}
	assertNoCursorStateIn(t, home)
}

func prepareCursorLaunchFor(t *testing.T, sessionID, execDir string) (CursorLaunchSpec, error) {
	t.Helper()
	return PrepareCursorSessionLaunch(context.Background(), &ClaimedSession{SessionID: sessionID}, execDir, nil)
}

// The CLI's environment is an allowlist of the runner's, the workspace's variables over it, and what the
// contract names over both: nothing of the runner's own credentials or configuration, memory-only
// credential storage, no browser, no direnv, no debug log, whatever the workspace sets. The commands the
// agent runs get the real HOME back and none of the CLI's own variables, through orbit-bash, and still
// see the workspace's.
func TestCursorLaunchSpecWhitelistsEnvironment(t *testing.T) {
	home := useCursorRealHome(t)
	r := newFakeCursorRelease(t)
	exe := installFakeCursor(t)
	for key, value := range map[string]string{
		"CURSOR_API_KEY": "runner-cursor-key", "CURSOR_AUTH_TOKEN": "runner-cursor-token", "CURSOR_CONFIG_DIR": "/runner/cursor",
		"CURSOR_DATA_DIR": "/runner/cursor-data", "XDG_CONFIG_HOME": "/runner/xdg", "AGENT_CLI_CREDENTIAL_STORE": "file",
		"ANTHROPIC_API_KEY": "runner-anthropic", "OPENAI_API_KEY": "runner-openai", "GITHUB_TOKEN": "runner-github",
		"NODE_OPTIONS": "--require /tmp/evil.js", "ORBIT_USER_TOKEN": "runner-user-token", "SHELL": "/bin/zsh",
		"LANG": "C.UTF-8", "HTTPS_PROXY": "http://proxy.invalid:3128",
	} {
		t.Setenv(key, value)
	}
	job := &ClaimedSession{SessionID: "31111111-2222-4333-8444-555555555555", AgentID: "a", TaskID: "t", SpawnDepth: 1,
		Agent: AgentExecConfig{Env: map[string]string{"ANTHROPIC_API_KEY": "agent-anthropic", "CURSOR_API_KEY": "key_from-the-workspace",
			"WORKSPACE_VALUE": "workspace", "HOME": "/workspace/home", "CURSOR_CONFIG_DIR": "/workspace/cursor",
			"AGENT_CLI_CREDENTIAL_STORE": "file", "ORBIT_SESSION_ID": "another-session", "ORBIT_HOME": "/workspace/orbit"}}}
	execDir := t.TempDir()
	spec, err := prepareCursorLaunch(job, execDir, exe, filepath.Join(runDir(job.SessionID), "cursor"))
	if err != nil {
		t.Fatal(err)
	}

	allowed := map[string]bool{}
	for _, key := range []string{"PATH", envRunnerChild, "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TMPDIR", "ORBIT_HOME",
		"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
		"SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY",
		"HOME", "SHELL", "CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR", "AGENT_CLI_CREDENTIAL_STORE", "NO_OPEN_BROWSER", "DIRENV_DISABLE",
		"CURSOR_AGENT_DISABLE_DEBUG_LOG", "ORBIT_SESSION_ID", "ORBIT_AGENT_ID", "ORBIT_TASK_ID", "ORBIT_ALLOW_ORCHESTRATION",
		envWatches, envWiki, envSpawnDepth, envBgSocket, envBgToken,
		// The workspace's own variables, its key among them.
		"ANTHROPIC_API_KEY", "CURSOR_API_KEY", "WORKSPACE_VALUE"} {
		allowed[key] = true
	}
	seen := map[string]bool{}
	for _, entry := range spec.Env {
		key, _, _ := strings.Cut(entry, "=")
		if !allowed[key] {
			t.Errorf("the launch environment carries %s", key)
		}
		if seen[key] {
			t.Errorf("the launch environment sets %s twice", key)
		}
		seen[key] = true
		for _, secret := range []string{"runner-cursor-key", "runner-cursor-token", "runner-anthropic", "runner-openai",
			"runner-github", "runner-user-token", "evil.js", "/workspace/", "another-session"} {
			if strings.Contains(entry, secret) {
				t.Errorf("the launch environment carries %q", entry)
			}
		}
	}
	env := envMap(spec.Env)
	for key, want := range map[string]string{
		"AGENT_CLI_CREDENTIAL_STORE": "memory", "NO_OPEN_BROWSER": "1", "DIRENV_DISABLE": "1", "CURSOR_AGENT_DISABLE_DEBUG_LOG": "1",
		"NODE_USE_ENV_PROXY": "1", "HTTPS_PROXY": "http://proxy.invalid:3128", "LANG": "C.UTF-8", envRunnerChild: "1",
		"ORBIT_SESSION_ID": publicID(job.SessionID), "ORBIT_AGENT_ID": publicID("a"), "ORBIT_TASK_ID": publicID("t"), envSpawnDepth: "1",
		"CURSOR_CONFIG_DIR": spec.ConfigDir, "CURSOR_DATA_DIR": spec.DataDir, "HOME": spec.Home,
		"CURSOR_API_KEY": "key_from-the-workspace", "WORKSPACE_VALUE": "workspace", "ANTHROPIC_API_KEY": "agent-anthropic",
	} {
		if env[key] != want {
			t.Errorf("%s = %q, want %q", key, env[key], want)
		}
	}
	if !strings.HasSuffix(env["SHELL"], string(os.PathSeparator)+"orbit-bash") || !strings.Contains(filepath.Base(env["SHELL"]), "bash") {
		t.Fatalf("SHELL = %q: the CLI uses $SHELL only when its path names bash", env["SHELL"])
	}

	// What the process started from the launch really runs with: the launch environment, nothing added.
	ask, _ := startCursorSession(t, spec, "CURSOR_API_KEY=session-key")
	ask(1, "initialize")
	var started fakeCursorCall
	for _, call := range r.calls(t) {
		if len(call.Args) > 0 && call.Args[0] == "acp" {
			started = call
		}
	}
	if strings.Join(started.Args, " ") != "acp --disable-auto-update --disable-indexing --disable-project-configs" || started.Dir != spec.Cwd {
		t.Fatalf("started %v in %s", started.Args, started.Dir)
	}
	got := envMap(started.Env)
	want := envMap(append(append([]string(nil), spec.Env...), "CURSOR_API_KEY=session-key"))
	for key, value := range want {
		if got[key] != value {
			t.Errorf("the session process has %s=%q, the launch said %q", key, got[key], value)
		}
	}
	for key := range got {
		if _, ok := want[key]; !ok && key != "PWD" && key != "SHLVL" && key != "_" && key != "OLDPWD" {
			t.Errorf("the session process has %s, which the launch never gave it", key)
		}
	}

	// A command the agent runs: through orbit-bash, with the real HOME and without the CLI's variables.
	shell := exec.Command(env["SHELL"], "-O", "extglob", "-c", `printf 'HOME=%s\n' "$HOME"; env`)
	shell.Env = append(append([]string(nil), spec.Env...), "CURSOR_API_KEY=session-key", "CURSOR_AUTH_TOKEN=session-token", "XDG_CONFIG_HOME="+spec.Home)
	out, err := shell.CombinedOutput()
	if err != nil {
		t.Fatalf("orbit-bash: %v: %s", err, out)
	}
	lines := strings.Split(string(out), "\n")
	if lines[0] != "HOME="+home {
		t.Fatalf("a command saw %q, want the runner user's real HOME %s", lines[0], home)
	}
	commandEnv := envMap(lines[1:])
	for _, key := range []string{"CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR"} {
		if value, ok := commandEnv[key]; ok {
			t.Errorf("a command sees %s=%q", key, value)
		}
	}
	// The runner's own XDG_CONFIG_HOME, given back in place of whatever the CLI's environment held (§8.4).
	if commandEnv["XDG_CONFIG_HOME"] != "/runner/xdg" {
		t.Errorf("a command sees XDG_CONFIG_HOME=%q, want the runner's own", commandEnv["XDG_CONFIG_HOME"])
	}
	if commandEnv["HOME"] != home || commandEnv["ORBIT_SESSION_ID"] != publicID(job.SessionID) || commandEnv["WORKSPACE_VALUE"] != "workspace" {
		t.Errorf("a command's HOME = %q, ORBIT_SESSION_ID = %q, WORKSPACE_VALUE = %q", commandEnv["HOME"], commandEnv["ORBIT_SESSION_ID"], commandEnv["WORKSPACE_VALUE"])
	}

	// The spec never prints or serializes its environment, where the session's credential will be.
	spec.Env = append(spec.Env, "CURSOR_API_KEY=printed-secret")
	encoded, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{spec.String(), fmt.Sprintf("%v", spec), fmt.Sprintf("%+v", spec), fmt.Sprintf("%#v", spec), string(encoded)} {
		if strings.Contains(text, "printed-secret") {
			t.Fatalf("the launch spec printed its environment: %s", text)
		}
	}
	assertNoCursorStateIn(t, home)
}

// The session's Cursor CLI runs on three layers of environment, each over the ones before
// (docs/cursor-runtime-contract.md §16.3): the runner's allowlist, the workspace's variables, and what the
// contract fixes with the credential Orbit chose. A key or token of the workspace's own is the session's
// credential, as the control plane's sign-in preflight counts it and hasInjectedCredentials reads it; a
// dispatched key replaces it; the Default account's login is used only when the session brings none.
func TestCursorLaunchEnvironmentLayers(t *testing.T) {
	launch := func(t *testing.T, env map[string]string) map[string]string {
		t.Helper()
		job := &ClaimedSession{SessionID: "61111111-2222-4333-8444-555555555555", AgentID: "a", Agent: AgentExecConfig{Env: env}}
		spec, err := prepareCursorLaunch(job, t.TempDir(), "/opt/cursor/cursor-agent", filepath.Join(runDir(job.SessionID), "cursor"))
		if err != nil {
			t.Fatal(err)
		}
		return envMap(spec.Env)
	}
	t.Run("workspace-key-without-a-login", func(t *testing.T) {
		useCursorRealHome(t)
		env := map[string]string{"CURSOR_API_KEY": "key_from-the-workspace"}
		got := launch(t, env)
		if got["CURSOR_API_KEY"] != "key_from-the-workspace" || got["AGENT_CLI_CREDENTIAL_STORE"] != "memory" {
			t.Fatalf("the CLI runs on CURSOR_API_KEY %q, store %q: want the workspace's key, in memory", got["CURSOR_API_KEY"], got["AGENT_CLI_CREDENTIAL_STORE"])
		}
		if _, ok := got["CURSOR_AUTH_TOKEN"]; ok || !hasInjectedCredentials(providerCursor, env) {
			t.Fatal("a session that brings its own key is not counted as one")
		}
		if msg := engineAuthPreflight(providerCursor, env); msg != "" {
			t.Fatalf("a session with a key of its own was held to the runner's sign-in: %s", msg)
		}
	})
	t.Run("dispatched-key-wins", func(t *testing.T) {
		useCursorRealHome(t)
		signInCursorDefault(t, cursorTestToken(t, time.Now().Add(time.Hour)))
		got := launch(t, map[string]string{cursorAPIKeyVar: cursorTestKey,
			"CURSOR_API_KEY": "key_from-the-workspace", "CURSOR_AUTH_TOKEN": "token-from-the-workspace"})
		if got["CURSOR_API_KEY"] != cursorTestKey {
			t.Fatalf("the CLI runs on CURSOR_API_KEY %q, want the dispatched key", got["CURSOR_API_KEY"])
		}
		for _, key := range []string{"CURSOR_AUTH_TOKEN", cursorAPIKeyVar} {
			if value, ok := got[key]; ok {
				t.Errorf("beside the dispatched key the CLI also has %s=%q", key, value)
			}
		}
	})
	t.Run("default-login-only-without-a-credential-of-its-own", func(t *testing.T) {
		useCursorRealHome(t)
		token := cursorTestToken(t, time.Now().Add(time.Hour))
		signInCursorDefault(t, token)
		if got := launch(t, map[string]string{"WORKSPACE_VALUE": "workspace"}); got["CURSOR_AUTH_TOKEN"] != token {
			t.Fatalf("a session that brings no credential runs on CURSOR_AUTH_TOKEN %q, want the Default account's login", got["CURSOR_AUTH_TOKEN"])
		}
		got := launch(t, map[string]string{"CURSOR_AUTH_TOKEN": "token-from-the-workspace"})
		if got["CURSOR_AUTH_TOKEN"] != "token-from-the-workspace" {
			t.Fatalf("a session with a token of its own runs on %q", got["CURSOR_AUTH_TOKEN"])
		}
		signInCursorDefault(t, cursorTestToken(t, time.Now().Add(time.Minute)))
		got = launch(t, nil)
		if value, ok := got["CURSOR_AUTH_TOKEN"]; ok {
			t.Fatalf("a login past the CLI's own expiry threshold was handed over: %q", value)
		}
		if cursorLaunchSignsIn(mapEnv(got)) {
			t.Fatal("a launch with no credential reads as signed in")
		}
	})
	t.Run("contract-variables-win", func(t *testing.T) {
		useCursorRealHome(t)
		got := launch(t, map[string]string{"HOME": "/workspace/home", "SHELL": "/bin/zsh", "CURSOR_CONFIG_DIR": "/workspace/cursor",
			"CURSOR_DATA_DIR": "/workspace/data", "AGENT_CLI_CREDENTIAL_STORE": "file", "NO_OPEN_BROWSER": "0", "DIRENV_DISABLE": "0",
			"ORBIT_SESSION_ID": "another-session", "ORBIT_HOME": "/workspace/orbit", cursorAccountDirVar: cursorDefaultAccountDir(),
			"CURSOR_API_KEY": "key_from-the-workspace"})
		for key, value := range got {
			if strings.HasPrefix(value, "/workspace/") || value == "another-session" || value == "/bin/zsh" ||
				(key == "AGENT_CLI_CREDENTIAL_STORE" && value != "memory") || ((key == "NO_OPEN_BROWSER" || key == "DIRENV_DISABLE") && value != "1") {
				t.Errorf("the workspace set the contract's %s=%q", key, value)
			}
		}
		if _, ok := got[cursorAccountDirVar]; ok {
			t.Errorf("%s reached the CLI", cursorAccountDirVar)
		}
		if got["ORBIT_SESSION_ID"] != publicID("61111111-2222-4333-8444-555555555555") {
			t.Errorf("ORBIT_SESSION_ID = %q", got["ORBIT_SESSION_ID"])
		}
	})
	t.Run("workspace-variables-reach-commands", func(t *testing.T) {
		home := useCursorRealHome(t)
		job := &ClaimedSession{SessionID: "71111111-2222-4333-8444-555555555555", AgentID: "a", Agent: AgentExecConfig{Env: map[string]string{
			"WORKSPACE_VALUE": "workspace", "CURSOR_API_KEY": "key_from-the-workspace"}}}
		spec, err := prepareCursorLaunch(job, t.TempDir(), "/opt/cursor/cursor-agent", filepath.Join(runDir(job.SessionID), "cursor"))
		if err != nil {
			t.Fatal(err)
		}
		// A command the agent runs, the way the CLI runs it: in $SHELL, with the CLI's environment.
		shell := exec.Command(envMap(spec.Env)["SHELL"], "-O", "extglob", "-c", `printf '%s|%s|%s' "$WORKSPACE_VALUE" "$HOME" "${CURSOR_API_KEY-unset}"`)
		shell.Env = spec.Env
		out, err := shell.CombinedOutput()
		if err != nil {
			t.Fatalf("orbit-bash: %v: %s", err, out)
		}
		if want := "workspace|" + home + "|unset"; string(out) != want {
			t.Fatalf("a command saw %q, want the workspace's variable, the real HOME and no credential: %q", out, want)
		}
	})
}

// mapEnv is envMap's inverse, in no particular order.
func mapEnv(env map[string]string) []string {
	out := make([]string, 0, len(env))
	for key, value := range env {
		out = append(out, key+"="+value)
	}
	return out
}

// Nothing the runner starts on Cursor CLI's behalf — the install's version probe, the health and
// sign-in probes, the catalogue, a session — writes or reads the runner user's ~/.cursor or
// ~/.config/cursor, though this build writes under HOME on every start; and nothing writes a
// credential to disk.
func TestCursorNeverWritesRealCursorHome(t *testing.T) {
	home := useCursorRealHome(t)
	r := newFakeCursorRelease(t)
	allowCursorInstall(t, true)
	if msg := ensureEngine(context.Background(), providerCursor, func(string) {}); msg != "" {
		t.Fatal(msg)
	}
	signInCursorDefault(t, cursorTestToken(t, time.Now().Add(time.Hour)))
	if h, _ := cursorHealth(t); h.auth != authYes {
		t.Fatalf("health = %+v", h)
	}
	if models, err := fetchCursorModelCatalog(context.Background()); err != nil || len(models) == 0 {
		t.Fatalf("catalogue = %d, %v", len(models), err)
	}
	job := &ClaimedSession{SessionID: "41111111-2222-4333-8444-555555555555", AgentID: "a"}
	spec, err := PrepareCursorSessionLaunch(context.Background(), job, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	ask, _ := startCursorSession(t, spec, "CURSOR_API_KEY=session-key")
	if line := ask(1, "initialize"); !strings.Contains(line, `"protocolVersion":1`) {
		t.Fatalf("initialize = %q", line)
	}
	if line := ask(2, "session/new"); !strings.Contains(line, "fake-session") {
		t.Fatalf("session/new = %q", line)
	}
	kinds := map[string]bool{}
	for _, call := range r.calls(t) {
		if len(call.Args) > 0 {
			kinds[call.Args[0]] = true
		}
		if got, _ := call.env("HOME"); got == home {
			t.Errorf("%v ran with the runner user's HOME", call.Args)
		}
		if store, _ := call.env("AGENT_CLI_CREDENTIAL_STORE"); store != "memory" {
			t.Errorf("%v kept credentials in %q", call.Args, store)
		}
	}
	for _, kind := range []string{"--version", "models", "acp"} {
		if !kinds[kind] {
			t.Fatalf("no %s ran: the test did not cover it (%v)", kind, kinds)
		}
	}
	// The fake writes under whatever HOME it is given: the session's home has its state, the user's none.
	if _, err := os.Stat(filepath.Join(spec.Home, ".cursor", "agent-cli-state.json")); err != nil {
		t.Fatalf("the CLI's HOME state is not in the session's home: %v", err)
	}
	assertNoCursorStateIn(t, home)
	var credentials []string
	_ = filepath.WalkDir(filepath.Join(home, ".orbit"), func(path string, entry os.DirEntry, err error) error {
		if err == nil && entry.Name() == "auth.json" && path != cursorStoredLoginPath(cursorDefaultAccountDir()) {
			credentials = append(credentials, path)
		}
		return nil
	})
	if len(credentials) != 0 {
		t.Fatalf("a credential was written to disk: %v", credentials)
	}
	logs, _ := filepath.Glob(filepath.Join(os.TempDir(), "cursor-agent-logs-*"))
	if len(logs) != 0 {
		t.Fatalf("the CLI wrote debug logs: %v", logs)
	}
}
