package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"math/big"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// One shared reader so sequential prompts (confirm, name) don't drop buffered input.
var stdinReader = bufio.NewReader(os.Stdin)

// interactive reports whether stdin can carry an answer back from a person.
//
// A pipe or a redirected file is not a character device, so those are already out —
// but /dev/null is one, and it is exactly what systemd, launchd, cron and agent
// harnesses hand a process they run unattended. Counting it as interactive makes
// every prompt answer itself with its default: `orbit doctor` then starts a sign-in
// flow nobody is there to finish, and `orbit register` consents on the user's behalf.
//
// isatty(3) would be the general answer, but it costs either a module dependency
// (this binary deliberately has none) or a per-OS ioctl whose behaviour can't be
// verified on both targets from one machine. /dev/null is the only null-ish device
// anything realistically redirects stdin from.
func interactive() bool {
	fi, err := os.Stdin.Stat()
	if err != nil || fi.Mode()&os.ModeCharDevice == 0 {
		return false
	}
	devNull, err := os.Stat(os.DevNull)
	return err != nil || !os.SameFile(fi, devNull)
}

// Overridden at build time with -ldflags "-X main.version=...". A "dev" build
// disables self-update.
var version = "dev"

// Control plane the runner defaults to (used by `orbit register` when no --server is given).
// Overridden at build time with -ldflags "-X main.defaultServer=..." so a self-hosted web
// image bakes its own PUBLIC_ORIGIN in; a plain `go build` keeps the hosted default.
var defaultServer = "https://orbitd.io"

var usage = `orbit — register a machine and run coding-agent tasks for an Orbit control plane

Usage:
  orbit register [options]          Register this machine + install the service (approve in the browser)
  orbit run                         Start the runner loop in the foreground
  orbit unregister [--yes]          Remove this runner: delete it server-side, stop the service, drop local config
  orbit status                      Show this directory's runner and its control-plane status
  orbit doctor                      Check the coding-engine CLIs, sign-in, and service PATH
  orbit engine-update               Update the coding-engine CLIs now (the daily check, on demand)
  orbit resume [session-id]         Resume a session in its coding runtime
  orbit task <command>              Manage Orbit tasks
  orbit task-list <command>         Manage Orbit task lists
  orbit session <command>           Orchestrate agent sessions (when enabled)
  orbit agent <command>             Inspect and configure agents (when enabled)
  orbit token <command>             Mint/list/revoke credentials for headless processes
  orbit capabilities [--json]       Show the CLI capabilities available to agents
  orbit upgrade                     Force-reinstall the latest binary (if auto-update isn't working)

Run 'orbit <command> --help' for command-specific options.

The runner uses each coding engine's local configuration and credentials
(Claude Code, Codex, Kimi Code, OpenCode). Run 'orbit doctor' for installation
and sign-in guidance.

Env:
  ORBIT_HOME               Override the runner's config/runs dir (default: ~/.orbit)
  ORBIT_NO_SELFUPDATE      Disable startup and periodic runner auto-updates
  ORBIT_NO_ENGINE_UPDATE   Disable the daily coding-engine CLI update check
`

// Per-command help, shown for `orbit <cmd> --help|-h` and `orbit help <cmd>`.
var cmdHelp = map[string]string{
	"register": `orbit register — register this machine and install the background service

Usage:
  orbit register [options]

Approve the machine in the browser (device-login), or pass --token to skip approval.
This machine becomes one runner (named by hostname); each coding agent installed
here is registered as an agent "<name>/<agentkey>" that runs in this directory.

Options:
  --server <url>           Control plane base URL (default: ` + defaultServer + `)
  --token <token>          Optional one-time enrollment token (skips browser approval)
  --name <name>            Base name for the agents (default: "<dir>@<hostname>"); the runner is named by hostname
  --labels a,b,c           Routing labels (e.g. sg,hdfs)
  --max-concurrent <n>     Max concurrent jobs (default: 16)
  --workdir <path>         Project directory Claude Code runs in (default: current dir)
  --force                  Re-register without confirming, even if this machine is already registered
  --no-service             Register only; don't install/start the background service
  --foreground             Register and run in the foreground now (implies --no-service)
  --auto-install-engines   Let the runner install a missing coding-engine CLI itself, the first
  --no-auto-install-engines  time a session needs one. Asked interactively when neither is
                           passed; an unattended register defaults to not installing.
  --proxy [<url>]          Use an HTTP proxy for claude on the runner so it can reach
                           the Anthropic API on a proxied network. Bare --proxy uses
                           $https_proxy/$http_proxy; or pass a URL. If omitted and a
                           proxy is set in your shell, you are asked. The control-plane
                           host is auto-added to no_proxy.
`,
	"run": `orbit run — start the runner loop in the foreground

Usage:
  orbit run

Runs this machine's runner. It claims sessions for any of its agents and runs each
in that agent's project directory.
`,
	"unregister": `orbit unregister — remove this machine's runner

Usage:
  orbit unregister [--yes]

Stops the background service, deletes the runner (and its agents) from the control
plane, and removes the local config.

Options:
  --yes, --force           Skip the confirmation prompt
`,
	"status": `orbit status — show this directory's runner and its control-plane status

Usage:
  orbit status
`,
	"doctor": `orbit doctor — check the coding-engine CLIs this runner needs

Usage:
  orbit doctor

Reports, for Claude Code, Codex, Kimi Code, and OpenCode, whether the CLI is installed, its version, a
best-effort sign-in check, and whether the background service's PATH can see it —
with the exact install/sign-in command for anything that's missing. Exits non-zero
when no engine is installed. Runs automatically at the end of 'orbit register'.
`,
	"resume": `orbit resume — resume a session in this terminal

Usage:
  orbit resume [session-id]

Resumes the given session in its original coding runtime and
original work directory. The session ID is the one shown in the web UI URL
(e.g. /sessions/<id>). If omitted, lists sessions available on this machine.
`,
	"upgrade": `orbit upgrade — force-reinstall the latest orbit binary

Usage:
  orbit upgrade

Use this if the startup auto-update isn't working.
`,
	"engine-update": `orbit engine-update — update the coding-engine CLIs now

Usage:
  orbit engine-update

Runs each installed engine's updater once, against the
binary the background service resolves on its PATH — the same check the runner runs ~10 min
after startup and every 24h. Unlike the daily run it can't see live sessions, so prefer
running it when the machine is idle. Disable the daily check with ORBIT_NO_ENGINE_UPDATE.
`,
	"task":      taskHelp,
	"task-list": taskListHelp,
	"session":   sessionHelp,
	"agent":     agentHelp,
	"token":     tokenHelp,
	"capabilities": `orbit capabilities — show agent-safe Orbit CLI capabilities

Usage:
  orbit capabilities [--json]

Shows the commands available through this binary. --json emits a stable,
machine-readable document including argument schemas from the built-in Orbit MCP
server. Session commands appear only inside an orchestration-enabled agent session.
`,
	"mcp": `orbit mcp — run the Task/TaskList MCP server (stdio)

Usage:
  orbit mcp

Speaks the Model Context Protocol over stdin/stdout so a Claude Code session can
manage Orbit Tasks. The runner injects this server into each session via --mcp-config;
it is not meant to be run by hand. It reads the runner credential from config.json and
the session context (ORBIT_SESSION_ID / ORBIT_AGENT_ID / ORBIT_TASK_ID) from the env.
`,
}

// helpFor returns the help text for a subcommand, or the global usage as a fallback.
func helpFor(cmd string) string {
	if h, ok := cmdHelp[cmd]; ok {
		return h
	}
	return usage
}

func main() {
	// Services installed by an older Orbit release have a baked PATH that predates one or more
	// official per-user engine directories. Refresh the current process too: doctor/install may
	// correctly find ~/.opencode/bin/opencode, and every later exec must see that same binary
	// without requiring the user to reinstall the service first.
	if home := userHome(); home != "" {
		_ = os.Setenv("PATH", runnerEnginePath(home, os.Getenv("PATH")))
	}

	args := os.Args[1:]
	cmd := ""
	if len(args) > 0 {
		cmd = args[0]
	}
	flags, bools := parseFlags(args)

	// Top-level help: `orbit`, `orbit help [cmd]`, `orbit --help`, `orbit -h`.
	if cmd == "" || cmd == "help" || cmd == "--help" || cmd == "-h" {
		if len(args) > 1 {
			fmt.Print(helpFor(args[1]))
		} else {
			fmt.Print(usage)
		}
		return
	}
	// Per-subcommand help: `orbit <cmd> --help|-h` prints that command's help
	// instead of running it.
	// Nested resource commands own their leaf help (for example
	// `orbit task create --help`). Other commands keep the flat help behavior.
	if cmd != "task" && cmd != "task-list" && cmd != "session" && wantsHelp(args[1:]) {
		fmt.Print(helpFor(cmd))
		return
	}

	switch cmd {
	case "register":
		cmdRegister(flags, bools)
	case "run":
		cmdRun()
	case "unregister":
		cmdUnregister(bools)
	case "status":
		cmdStatus()
	case "doctor":
		cmdDoctor()
	case "resume":
		cmdResume(args[1:])
	case "task":
		if err := cmdTaskCLI(args[1:], os.Stdin, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "orbit task:", err)
			os.Exit(1)
		}
	case "task-list":
		if err := cmdTaskListCLI(args[1:], os.Stdin, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "orbit task-list:", err)
			os.Exit(1)
		}
	case "session":
		if err := cmdSessionCLI(args[1:], os.Stdin, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "orbit session:", err)
			os.Exit(1)
		}
	case "agent":
		if err := cmdAgentCLI(args[1:], os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "orbit agent:", err)
			os.Exit(1)
		}
	case "token":
		if err := cmdTokenCLI(args[1:], os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "orbit token:", err)
			os.Exit(1)
		}
	case "capabilities":
		if err := cmdCapabilitiesCLI(args[1:], os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "orbit capabilities:", err)
			os.Exit(1)
		}
	case "upgrade":
		cmdUpgrade()
	case "engine-update":
		cmdEngineUpdate()
	case "mcp":
		cmdMcp()
	case "version", "--version", "-v":
		fmt.Println(version)
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n%s", cmd, usage)
		os.Exit(1)
	}
}

func cmdRegister(flags map[string]string, bools map[string]bool) {
	// One runner per machine. Re-registering re-issues its credential, so confirm
	// before clobbering the config.
	if existing := loadConfig(); existing != nil && !bools["force"] {
		ok := confirm(fmt.Sprintf(
			"This machine is already registered as %q (%s).\nRegister again (re-issues its credential)? [Y/n] ",
			existing.Name, existing.ServerURL), true)
		if !ok {
			fmt.Println("aborted — pass --force to re-register without confirming")
			os.Exit(0)
		}
	}

	server := strings.TrimRight(getStr(flags, "server", defaultServer), "/")
	// Register just this machine as a runner; agents are registered separately.
	// The name defaults to the hostname — confirm/edit it interactively unless
	// --name was passed.
	name := flags["name"]
	if name == "" {
		name = promptName(defaultRunnerName())
	}
	labels := parseLabels(flags["labels"])
	maxConcurrent := getInt(flags, "max-concurrent", 16)
	token := flags["token"]
	foreground := bools["foreground"]
	// The directory Claude Code runs in (the project to work on). Defaults to the
	// register cwd so a runner registered inside a repo operates on that repo.
	workDir := flags["workdir"]
	if workDir == "" {
		if cwd, err := os.Getwd(); err == nil {
			workDir = cwd
		}
	}
	// --foreground (and --no-service) skip installing the background service.
	withService := !bools["no-service"] && !foreground
	// The runner spawns claude -p, which on a proxied network must use the same
	// HTTP proxy to reach the Anthropic API. Let the user opt in.
	proxyVars := proxyServiceEnv(resolveProxy(flags, bools), server, firstNonEmpty(os.Getenv("no_proxy"), os.Getenv("NO_PROXY")))
	if len(proxyVars) > 0 {
		fmt.Printf("the runner will use HTTP proxy %s for claude\n", proxyVars[0].V)
	}
	t := NewTransport(server, "")

	// Legacy path: an explicit enrollment token skips browser approval.
	if token != "" {
		res, err := t.register(RegisterRequest{
			EnrollmentToken: token, Name: name, Hostname: hostnameOr(),
			Labels: labels, MaxConcurrent: maxConcurrent, Version: version, WorkDir: workDir,
		})
		if err != nil {
			fmt.Fprintln(os.Stderr, "registration failed:", err)
			os.Exit(1)
		}
		finishRegister(res.RunnerID, res.RunnerToken, res.Name,
			server, labels, maxConcurrent, workDir, withService, foreground, proxyVars, bools)
		return
	}

	// Device-login flow: approve this machine in the browser, like `claude` login.
	start, err := t.deviceStart(DeviceStartRequest{
		Name: name, Hostname: hostnameOr(), Labels: labels,
		MaxConcurrent: maxConcurrent, Version: version, WorkDir: workDir,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "registration failed:", err)
		os.Exit(1)
	}
	link := server + "/enroll?code=" + url.QueryEscape(start.UserCode)
	fmt.Printf("\nTo finish registering this machine, open Orbit and approve it:\n\n"+
		"  %s\n\n  Verification code: %s\n\nWaiting for approval...\n", link, start.UserCode)
	openBrowser(link)

	deadline := time.Now().Add(time.Duration(start.ExpiresIn) * time.Second)
	interval := time.Duration(max(1, start.Interval)) * time.Second
	for time.Now().Before(deadline) {
		time.Sleep(interval)
		poll, err := t.devicePoll(start.DeviceCode)
		if err != nil {
			continue // transient — keep waiting until the deadline
		}
		if poll.Status == "approved" {
			finishRegister(poll.RunnerID, poll.RunnerToken, poll.Name,
				server, labels, maxConcurrent, workDir, withService, foreground, proxyVars, bools)
			return
		}
		if poll.Status == "expired" {
			break
		}
	}
	fmt.Fprintln(os.Stderr, "registration timed out — please run `orbit register` again")
	os.Exit(1)
}

// autoInstallConsent decides whether this runner may install an engine CLI on its own when a
// session first needs one (see ensureEngine). Explicit flags win; otherwise we ask. An
// unattended register — a provisioning script, no terminal to answer — records no consent
// rather than assuming it: installing software on someone's machine is not a default.
func autoInstallConsent(bools map[string]bool) bool {
	switch {
	case bools["no-auto-install-engines"]:
		return false
	case bools["auto-install-engines"]:
		return true
	case interactive():
		return confirm("\nMay this runner install a coding CLI by itself when a session first needs one?\n"+
			"  (otherwise that session fails and you install it here with `orbit doctor`)\n  [Y/n] ", true)
	}
	return false
}

// finishRegister persists the machine runner credential and installs the
// background service (unless running in the foreground).
func finishRegister(runnerID, runnerToken, name string, server string, labels []string, maxConcurrent int, workDir string, withService, foreground bool, proxyVars []envVar, bools map[string]bool) {
	cfg := &RunnerConfig{
		ServerURL: server, RunnerID: runnerID, RunnerToken: runnerToken,
		Name: name, Labels: labels, MaxConcurrent: maxConcurrent, WorkDir: workDir,
	}
	if err := saveConfig(cfg); err != nil {
		fmt.Fprintln(os.Stderr, "failed to save config:", err)
		os.Exit(1)
	}
	fmt.Printf("\n✓ registered runner %q (%s).\n", cfg.Name, cfg.RunnerID)

	// Report the engines but install nothing: which ones this machine needs depends on
	// the agents you point at it, which don't exist yet. They're installed on demand
	// instead, the first time a session actually asks for one — so all registration
	// needs is the consent for that, which has to be collected here because the runtime
	// install happens unattended.
	runDoctor(false, proxyVars)
	cfg.AutoInstallEngines = autoInstallConsent(bools)
	if err := saveConfig(cfg); err != nil {
		fmt.Fprintln(os.Stderr, "failed to save config:", err)
		os.Exit(1)
	}
	fmt.Println("\nSign in to the engines you'll use: press the sign-in button in Orbit, or run `orbit doctor` here.")

	if foreground {
		fmt.Printf("running %q in the foreground — Ctrl-C to stop\n", cfg.Name)
		// If an update re-execs this process it should come back as a runner, not
		// repeat registration and re-issue the credential from the original argv.
		os.Args = []string{os.Args[0], "run"}
		clearInheritedSessionContext()
		runWithSelfUpdates(cfg, selfUpdate, func() bool { return runLoop(cfg) })
		return
	}
	if !withService {
		fmt.Println("  Start it with:  orbit run")
		return
	}
	if err := setupService(machineHome(), proxyVars); err != nil {
		fmt.Fprintf(os.Stderr, "\nnote: could not auto-install the background service (%s)\n", firstLine(err.Error()))
		fmt.Fprintln(os.Stderr, "  you can run it in the foreground instead:  orbit run")
	}
}

// cmdUnregister tears down this machine's runner: stops/removes the service,
// deletes the runner (and its agents) from the control plane, and drops the config.
func cmdUnregister(bools map[string]bool) {
	cfg := loadConfig()
	if cfg == nil {
		fmt.Println("no runner registered on this machine")
		return
	}
	if !bools["yes"] && !bools["force"] {
		if !confirm(fmt.Sprintf(
			"Unregister runner %q — stop its service, delete it (and its agents) from %s, and remove local config? [y/N] ",
			cfg.Name, cfg.ServerURL), false) {
			fmt.Println("aborted")
			return
		}
	}

	uninstallService() // stop + remove the background service first

	if err := NewTransport(cfg.ServerURL, cfg.RunnerToken).deregister(); err != nil {
		fmt.Fprintf(os.Stderr, "note: could not delete %q from the control plane (%s)\n", cfg.Name, firstLine(err.Error()))
	} else {
		fmt.Printf("✓ deleted %q from the control plane\n", cfg.Name)
	}

	if err := os.Remove(configPath()); err != nil && !os.IsNotExist(err) {
		fmt.Fprintln(os.Stderr, "failed to remove config:", err)
		os.Exit(1)
	}
	fmt.Printf("✓ unregistered %q\n", cfg.Name)
}

func cmdRun() {
	clearInheritedSessionContext()
	// Runner startup is a trusted path (unlike an agent-invoked read-only CLI
	// command), so migrate the legacy 0755/0644 credential storage before use.
	if err := hardenConfigStorage(); err != nil && !os.IsNotExist(err) {
		fmt.Fprintln(os.Stderr, "cannot secure runner config storage:", err)
		os.Exit(1)
	}
	cfg := loadConfig()
	if cfg == nil {
		fmt.Fprintln(os.Stderr, "no runner config found — run `orbit register` first")
		os.Exit(1)
	}
	runWithSelfUpdates(cfg, selfUpdate, func() bool { return runLoop(cfg) })
}

// clearInheritedSessionContext removes a legacy/stale session identity inherited
// from launchd or an invoking shell. Clearing only the proof is insufficient now
// that a session id + allow gate can lazily refresh it. This is intentionally
// runner-mode only: an already-running old provider's `orbit mcp` process may
// still need its environment fallback during a rolling upgrade.
func clearInheritedSessionContext() {
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if sessionContextEnvKey(key) {
			_ = os.Unsetenv(key)
		}
	}
}

// runWithSelfUpdates supervises startup and live updates. A successful
// selfUpdate replaces this process and never returns. If a post-drain update
// attempt returns, re-exec even the current binary so stopped runLoop goroutines
// can never overlap a fresh reclaim in the same process.
func runWithSelfUpdates(cfg *RunnerConfig, update func(string), loop func() bool) {
	superviseSelfUpdates(cfg.ServerURL, update, loop, execCurrentProcess)
}

func superviseSelfUpdates(server string, update func(string), loop func() bool, restart func() error) {
	update(server)
	if !loop() {
		return
	}
	update(server)
	if err := restart(); err != nil {
		fmt.Fprintln(os.Stderr, "runner restart after update attempt failed:", err)
	}
}

func cmdStatus() {
	cfg := loadConfig()
	if cfg == nil {
		fmt.Printf("no runner registered on this machine\nRun `orbit register` to add one.\n")
		return
	}
	fmt.Printf("orbit %s\n", version)
	fmt.Printf("\nrunner:  %s (%s)\nserver:  %s\nlabels:  %s\nconfig:  %s\n",
		cfg.Name, cfg.RunnerID, cfg.ServerURL, labelsOrDash(cfg.Labels), configPath())

	me, err := NewTransport(cfg.ServerURL, cfg.RunnerToken).me()
	if err != nil {
		msg := firstLine(err.Error())
		if strings.Contains(msg, "401") {
			fmt.Println("status:  credential invalid — re-register with `orbit register --force`")
		} else {
			fmt.Printf("status:  control plane unreachable (%s)\n", msg)
		}
		return
	}
	ago := "never"
	if me.LastHeartbeatAt != nil {
		if ts, err := time.Parse(time.RFC3339, *me.LastHeartbeatAt); err == nil {
			ago = fmt.Sprintf("%ds ago", int(time.Since(ts).Seconds()))
		}
	}
	st := "offline"
	if me.Online {
		st = "online"
	}
	fmt.Printf("status:  %s (last heartbeat %s)\n", st, ago)
	if len(me.Agents) > 0 {
		fmt.Println("agents:")
		for _, a := range me.Agents {
			dir := a.WorkDir
			if dir == "" {
				dir = "—"
			}
			fmt.Printf("  • %s → %s\n", a.Name, dir)
		}
	}
}

func cmdResume(args []string) {
	runs := runsDir()

	// No session ID: list sessions available on this machine.
	if len(args) == 0 || args[0] == "" {
		entries, err := os.ReadDir(runs)
		if err != nil || len(entries) == 0 {
			fmt.Println("no sessions found on this machine")
			return
		}
		fmt.Println("sessions on this machine:")
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			id := e.Name()
			meta := readSessionMeta(filepath.Join(runs, id, "meta.json"))
			if meta != nil && meta.Title != "" {
				fmt.Printf("  %s  %s\n", id, meta.Title)
			} else {
				fmt.Printf("  %s\n", id)
			}
		}
		fmt.Println("\nRun:  orbit resume <session-id>")
		return
	}

	// Web URLs carry the base62 public id; the runner and server key sessions by
	// the raw UUID. Decode here so both the local run dir and the server lookup
	// resolve.
	sessionID := decodeSessionID(args[0])
	sessionDir := filepath.Join(runs, sessionID)
	metaPath := filepath.Join(sessionDir, "meta.json")
	meta := readSessionMeta(metaPath)
	if meta == nil {
		// Fall back to the server for sessions that predate local meta storage.
		cfg := loadConfig()
		if cfg == nil {
			fmt.Fprintln(os.Stderr, "no runner config — run `orbit register` first")
			os.Exit(1)
		}
		resp, err := NewTransport(cfg.ServerURL, cfg.RunnerToken).sessionMeta(sessionID)
		if err != nil {
			fmt.Fprintf(os.Stderr, "session %q not found: %v\n", sessionID, err)
			os.Exit(1)
		}
		meta = &sessionMeta{
			Provider:         resp.Provider,
			SessionUUID:      resp.SessionUUID,
			RuntimeSessionID: resp.RuntimeSessionID,
			Title:            resp.Title,
		}
		if resp.WorkDir != nil {
			meta.WorkDir = *resp.WorkDir
		}
		// Cache it so future resumes are offline-capable.
		_ = os.MkdirAll(sessionDir, 0o755)
		if b, err := json.Marshal(meta); err == nil {
			_ = writeFileAtomically(metaPath, b, 0o644)
		}
	}

	fmt.Printf("resuming session %s", sessionID)
	if meta.Title != "" {
		fmt.Printf(" — %s", meta.Title)
	}
	fmt.Println()

	var cmd *exec.Cmd
	switch strings.ToLower(strings.TrimSpace(meta.Provider)) {
	case providerCodex:
		state, err := codexStateForResume(sessionDir, meta)
		if err != nil {
			fmt.Fprintln(os.Stderr, "cannot resolve this Codex session's state:", err)
			os.Exit(1)
		}
		sessionID := meta.RuntimeSessionID
		if sessionID == "" {
			sessionID = meta.SessionUUID
		}
		args := []string{"-c", fmt.Sprintf("sqlite_home=%q", state.Dir), "-s", "danger-full-access", "-a", "never"}
		if meta.WorkDir != "" {
			args = append(args, "-C", expandTilde(meta.WorkDir))
		}
		args = append(args, "resume", "--include-non-interactive", sessionID)
		cmd = exec.Command("codex", args...)
		if state.Shared {
			cmd.Env = envWithValue(os.Environ(), "CODEX_HOME", state.CodexHome)
		}
	case providerKimi:
		if meta.RuntimeSessionID == "" {
			fmt.Fprintln(os.Stderr, "this Kimi session has no runtime session id yet")
			os.Exit(1)
		}
		cmd = exec.Command(providerKimi, "--resume", meta.RuntimeSessionID)
	case providerOpenCode:
		if meta.RuntimeSessionID == "" {
			fmt.Fprintln(os.Stderr, "this OpenCode session has not been initialized yet")
			os.Exit(1)
		}
		cmd = exec.Command(providerOpenCode, "--session", meta.RuntimeSessionID)
	default:
		cmd = exec.Command("claude", "--resume", meta.SessionUUID)
	}
	if meta.WorkDir != "" {
		cmd.Dir = expandTilde(meta.WorkDir)
	}
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		os.Exit(1)
	}
}

const base62Alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

var uuidRE = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// decodeSessionID turns the base62 public id shown in web URLs into the
// canonical lowercase UUID the runner and server key by. A raw UUID passes
// through; anything that isn't decodable base62 is returned unchanged so the
// lookup degrades to "not found" instead of crashing. Mirrors the web's
// decodeId / @orbit/shared toUuid.
func decodeSessionID(id string) string {
	if uuidRE.MatchString(id) {
		return strings.ToLower(id)
	}
	n := new(big.Int)
	base := big.NewInt(62)
	for _, ch := range id {
		v := strings.IndexRune(base62Alphabet, ch)
		if v < 0 {
			return id // not valid base62 — let the lookup fail cleanly
		}
		n.Mul(n, base)
		n.Add(n, big.NewInt(int64(v)))
	}
	if n.BitLen() > 128 {
		return id // overflows a 128-bit UUID
	}
	hex := fmt.Sprintf("%032x", n)
	return fmt.Sprintf("%s-%s-%s-%s-%s", hex[0:8], hex[8:12], hex[12:16], hex[16:20], hex[20:32])
}

// publicID is decodeSessionID's inverse: the base62 spelling an id has everywhere a person or a
// model can see it. Idempotent — an id already in the short form comes back unchanged — so it is
// safe to apply at a boundary without first knowing which spelling arrived.
//
// Anything that is not a UUID is returned as-is, for the same reason decodeSessionID does it: this
// is a rendering step, not a validator, and an empty AgentID/TaskID (both legitimately absent) has
// to survive it untouched.
func publicID(id string) string {
	if !uuidRE.MatchString(id) {
		return id
	}
	n := new(big.Int)
	n.SetString(strings.ReplaceAll(strings.ToLower(id), "-", ""), 16)
	if n.Sign() == 0 {
		return "0"
	}
	base := big.NewInt(62)
	rem := new(big.Int)
	var out []byte
	for n.Sign() > 0 {
		n.DivMod(n, base, rem)
		out = append([]byte{base62Alphabet[rem.Int64()]}, out...)
	}
	return string(out)
}

func readSessionMeta(path string) *sessionMeta {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var m sessionMeta
	if err := json.Unmarshal(b, &m); err != nil {
		return nil
	}
	return &m
}

func cmdUpgrade() {
	server := defaultServer
	if cfg := loadConfig(); cfg != nil {
		server = cfg.ServerURL
	}
	upgrade(strings.TrimRight(server, "/"))
}

// ── small helpers ─────────────────────────────────────────────────────────

// wantsHelp reports whether a help flag appears in argv. It scans the raw args
// because parseFlags only recognizes `--`-prefixed flags and would miss `-h`.
func wantsHelp(argv []string) bool {
	for _, a := range argv {
		if a == "--help" || a == "-h" {
			return true
		}
	}
	return false
}

// parseFlags supports `--key value`, `--key=value`, and boolean `--flag`.
func parseFlags(argv []string) (map[string]string, map[string]bool) {
	strs := map[string]string{}
	bools := map[string]bool{}
	for i := 0; i < len(argv); i++ {
		a := argv[i]
		if !strings.HasPrefix(a, "--") {
			continue
		}
		body := a[2:]
		if eq := strings.Index(body, "="); eq >= 0 {
			strs[body[:eq]] = body[eq+1:]
			continue
		}
		if i+1 < len(argv) && !strings.HasPrefix(argv[i+1], "--") {
			strs[body] = argv[i+1]
			i++
		} else {
			bools[body] = true
		}
	}
	return strs, bools
}

func getStr(m map[string]string, k, def string) string {
	if v, ok := m[k]; ok && v != "" {
		return v
	}
	return def
}

func getInt(m map[string]string, k string, def int) int {
	if v, ok := m[k]; ok {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func parseLabels(s string) []string {
	out := []string{}
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func labelsOrDash(labels []string) string {
	if len(labels) == 0 {
		return "—"
	}
	return strings.Join(labels, ", ")
}

func hostnameOr() string {
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	return "runner"
}

// defaultRunnerName is the machine's hostname, used as the default runner name.
func defaultRunnerName() string {
	return hostnameOr()
}

// promptName asks the user to confirm/edit the runner name; Enter keeps the
// default. Non-interactive callers get the default unchanged.
func promptName(def string) string {
	if !interactive() {
		return def
	}
	fmt.Printf("Runner name [%s]: ", def)
	line, _ := stdinReader.ReadString('\n')
	if s := strings.TrimSpace(line); s != "" {
		return s
	}
	return def
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// openBrowser best-effort opens a URL; harmless on headless hosts.
func openBrowser(link string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", link)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", link)
	default:
		cmd = exec.Command("xdg-open", link)
	}
	_ = cmd.Start()
}

// confirm asks a yes/no question. Enter (or a non-interactive caller) returns
// defaultYes.
func confirm(question string, defaultYes bool) bool {
	if !interactive() {
		return defaultYes
	}
	fmt.Print(question)
	line, _ := stdinReader.ReadString('\n')
	s := strings.ToLower(strings.TrimSpace(line))
	if s == "" {
		return defaultYes
	}
	if defaultYes {
		return s != "n" && s != "no"
	}
	return s == "y" || s == "yes"
}

// firstNonEmpty returns the first non-empty string.
func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// resolveProxy decides the HTTP proxy to bake into the runner service: an explicit
// --proxy <url>, the environment proxy when --proxy is bare or the user opts in at
// the prompt, or "" for none.
func resolveProxy(flags map[string]string, bools map[string]bool) string {
	if v := flags["proxy"]; v != "" {
		return v
	}
	envProxy := firstNonEmpty(os.Getenv("https_proxy"), os.Getenv("HTTPS_PROXY"), os.Getenv("http_proxy"), os.Getenv("HTTP_PROXY"))
	if bools["proxy"] {
		if envProxy == "" {
			fmt.Fprintln(os.Stderr, "note: --proxy given but no http(s)_proxy in the environment; registering without a proxy")
		}
		return envProxy
	}
	if envProxy != "" && interactive() {
		if confirm(fmt.Sprintf("Use detected HTTP proxy %s for the runner (so claude -p can reach the Anthropic API)? [y/N] ", envProxy), false) {
			return envProxy
		}
	}
	return ""
}
