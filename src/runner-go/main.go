package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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

// Exact source tree baked into release binaries, reported by `orbit status` and, before this
// machine registers anything, by `orbit capabilities --json`. Development builds deliberately
// retain the sentinel; production publishing always sets a full git SHA, and the build fails
// if that stamp does not reach the binary (scripts/build-binaries.sh).
var sourceSHA = "dev-local"

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
  orbit engine-update               Update the coding-engine CLIs now (the periodic check, on demand)
  orbit resume [session-id]         Resume a session in its engine's CLI
  orbit task <command>              Manage Orbit tasks
  orbit task-list <command>         Manage Orbit task lists
  orbit project <command>           Manage an Orbit project's durable context
  orbit session <command>           Orchestrate agent sessions (when enabled)
  orbit agent <command>             Inspect, configure and delete agents (when enabled)
  orbit runner <command>            List this account's runners, install engine CLIs on them, delete them (when enabled)
  orbit provider <command>          List and configure the providers sessions and tasks get credentials from
  orbit watch <command>             Wait on Orbit tasks and sessions without polling
  orbit wiki <command>              Read the Orbit wiki and propose to it
  orbit file <command>              Keep files in Orbit instead of in the repository
  orbit secret exec NAME -- CMD     Run CMD with a secret the owner delivered to this runner
  orbit notify --message TEXT       Alert this account's devices with a line you write
  orbit token <command>             Mint/list/revoke credentials for headless processes
  orbit login [--with-token]        Act as yourself: approve a personal access token in the browser
  orbit logout [--keep-token]       Revoke that token and forget it
  orbit whoami [--json]             Show who the CLI acts as, and why
  orbit api [-X METHOD] PATH        Call the Orbit REST API as yourself
  orbit capabilities [--json]       Show the CLI capabilities available to agents
  orbit host setup --server URL     Set this machine up for runners (root, once per host)
  orbit hostd [--foreground]        Serve the machine broker (systemd starts this, not you)
  orbit upgrade                     Force-reinstall the latest binary (if auto-update isn't working)

Run 'orbit <command> --help' for command-specific options.

Every command in 'orbit capabilities' also takes --receipt: it prints, in place of its output, the
receipt the MCP tool of the same operation returns — one JSON document with ok, outcome, the
entity's id and status, the changed fields, the approval outcome and, on a failure, the error code
and whether a resend is safe — and exits non-zero exactly when ok is false. --json still prints the
entity document alone, which is the receipt's entity.

The runner uses each coding engine's local configuration and credentials
(Claude Code, Codex, Kimi Code, OpenCode, Antigravity). Run 'orbit doctor' for
installation and sign-in guidance.

Env:
  ORBIT_HOME               Override the runner's config/runs dir (default: ~/.orbit)
  ORBIT_USER_TOKEN         A personal access token to act as, in place of 'orbit login' (CI, containers)
  ORBIT_SERVER_URL         The server ORBIT_USER_TOKEN belongs to
  ORBIT_NO_SELFUPDATE      Disable startup and periodic runner auto-updates
  ORBIT_NO_ENGINE_UPDATE   Disable the periodic coding-engine CLI update check
`

// Per-command help, shown for `orbit <cmd> --help|-h` and `orbit help <cmd>`.
var cmdHelp = map[string]string{
	"secret": secretHelp,
	"register": `orbit register — register this machine and install the background service

Usage:
  orbit register [options]

Approve the machine in the browser (device-login), or pass --token to skip approval.
This machine becomes one runner. Its name defaults to the machine hostname and
can be changed with --name. Workspaces are configured separately after registration.

The runner belongs to the OS account that registers it. Under sudo that is the account
that ran sudo, and the command runs as that account. It says the machine is online once
the service has reached the server; when that does not happen it says why and exits 1.

Options:
  --server <url>           Control plane base URL (default: ` + defaultServer + `)
  --token <token>          Optional one-time enrollment token (skips browser approval)
  --name <name>            Runner name (default: machine hostname)
  --labels a,b,c           Routing labels (e.g. sg,hdfs)
  --max-concurrent <n>     Max concurrent jobs (default: CPU core count)
  --workdir <path>         Project directory Claude Code runs in (default: current dir)
  --force                  Re-register without confirming, even if this machine is already registered
  --no-service             Register only; don't install/start the background service
  --foreground             Register and run in the foreground now (implies --no-service)
  --no-auto-install-engines  Do not let the runner install a missing coding-engine CLI itself;
                           the session fails and you install it with orbit doctor.
                           Installing on demand is the default.
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
plane, and removes the local config. Under sudo it acts on the runner of the account
that ran sudo, as that account.

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

Reports, for Claude Code, Codex, Kimi Code, OpenCode, and Antigravity, whether the CLI is installed, its version, a
best-effort sign-in check, and whether the background service's PATH can see it —
with the exact install/sign-in command for anything that's missing. Exits non-zero
when no engine is installed.
`,
	"resume": `orbit resume — resume a session in this terminal

Usage:
  orbit resume [session-id]

Resumes the given session in its original engine's CLI and original work directory.
The session ID is the one shown in the web UI URL (e.g. /sessions/<id>). If omitted,
lists sessions available on this machine.

The engine is the one the session runs on, which never changes: this machine's own
record of the run, or for a session that never ran here the engine the control plane
reports for it. A DeepSeek Harness session is not opened here — Orbit drives Harness
over ACP, the Harness it installs has no terminal interface, and the session's
DeepSeek key reaches it only with each run Orbit dispatches — so it is refused,
saying how to continue it instead.
`,
	"upgrade": `orbit upgrade — force-reinstall the latest orbit binary

Usage:
  orbit upgrade

Use this if the startup auto-update isn't working. sudo /usr/local/bin/orbit upgrade
installs the release at /usr/local/bin/orbit, which stays root's own file. Where an
account's runner service still runs that file, it then gives the account its own copy
in ~/.orbit/bin and restarts the service on it, so later releases install themselves.
Where an earlier release linked /usr/local/bin/orbit to an account's copy, it puts
root's own file back in place of the link.
`,
	"engine-update": `orbit engine-update — update the coding-engine CLIs now

Usage:
  orbit engine-update

Runs each installed engine's updater once, against the
binary the background service resolves on its PATH — the same check the runner runs ~10 min
after startup and every 30 min. Unlike the loop's own pass it can't see live sessions, so prefer
running it when the machine is idle. Disable the periodic check with ORBIT_NO_ENGINE_UPDATE.
`,
	"task":      taskHelp,
	"task-list": taskListHelp,
	"project":   projectHelp,
	"session":   sessionHelp,
	"agent":     agentHelp,
	"runner":    runnerHelp,
	"provider":  providerHelp,
	"notify":    notifyHelp,
	"watch":     watchHelp,
	"wiki":      wikiHelp,
	"file":      fileHelp,
	"token":     tokenHelp,
	"login":     loginHelp,
	"logout":    logoutHelp,
	"whoami":    whoamiHelp,
	"api":       apiHelp,
	"host":      hostHelp,
	"capabilities": `orbit capabilities — show agent-safe Orbit CLI capabilities

Usage:
  orbit capabilities [--json]

Shows the commands available through this binary. --json emits a stable,
machine-readable document including argument schemas from the built-in Orbit MCP
server. Session commands appear only inside an orchestration-enabled agent session.
`,
	"hostd": `orbit hostd — serve the machine broker on /run/orbit/host.sock

Usage:
  orbit hostd [--foreground]

The root-owned broker every user's orbit asks to enable, restart or report on their own
runner. Each verb acts on the caller's own orbit-runner@<uid>.service, decided from the
connection's peer credentials and never from the request body.

'orbit host setup' installs the socket and service units that run this; systemd starts
it on the first connection and it exits once the machine goes quiet, so a replaced
binary takes effect on the next call rather than at the next reboot. It is not meant to
be run by hand.

Options:
  --foreground             Serve until stopped rather than exiting once the machine goes
                           quiet, and name the socket on stderr. For watching a broker
                           you started by hand.
`,
	// "mcp" is not here: its help is built from the runtime and operation tables when it is asked
	// for (mcpHelp), so that it says what the server is today.
}

// Command families that print their own per-action help, so `orbit <family> <action> --help` has
// to reach the family rather than being answered here with the family overview. A family missing
// from this set still compiles and still has leaf help — the text is simply unreachable, which is
// how `orbit provider list --help` shipped in 0.1.122 answering with the overview instead.
var leafHelpFamilies = map[string]bool{
	"task":      true,
	"task-list": true,
	"project":   true,
	"watch":     true,
	"wiki":      true,
	"file":      true,
	"session":   true,
	"provider":  true,
	// `agent` has had per-action help since it shipped and has never been able to print it —
	// same omission, found while checking that provider's was reachable.
	"agent":  true,
	"runner": true,
}

func ownsLeafHelp(cmd string) bool { return leafHelpFamilies[cmd] }

// helpFor returns the help text for a subcommand, or the global usage as a fallback.
func helpFor(cmd string) string {
	if cmd == "mcp" {
		return mcpHelp()
	}
	if h, ok := cmdHelp[cmd]; ok {
		return h
	}
	return usage
}

func main() {
	// A session process's keeper (session_scope.go), ahead of everything below: the environment it was
	// started with is the session process's, and goes to it untouched.
	if len(os.Args) > 1 && os.Args[1] == sessionScopeCommand {
		os.Exit(runSessionScope(os.Args[2:]))
	}
	// The credential helper every network git command is given (network_git.go). git runs it, and it
	// answers git and does nothing else.
	if len(os.Args) > 1 && os.Args[1] == gitCredentialReadOnlyCommand {
		os.Exit(runGitCredentialReadOnly(os.Args[2:]))
	}
	// `orbit secret exec NAME -- command…` (secret_exec.go), also ahead of everything below: the command's own
	// arguments are not this CLI's flags (a `--help` among them is the command's), and its environment is the shell's.
	if len(os.Args) > 1 && os.Args[1] == "secret" {
		os.Exit(cmdSecret(os.Args[2:], os.Stdin, os.Stdout, os.Stderr))
	}
	// Services installed by an older Orbit release have a baked PATH that predates one or more
	// official per-user engine directories. Refresh the current process too: doctor/install may
	// correctly find ~/.opencode/bin/opencode, and every later exec must see that same binary
	// without requiring the user to reinstall the service first.
	if home := userHome(); home != "" {
		_ = os.Setenv("PATH", runnerEnginePath(home, os.Getenv("PATH")))
	}

	if err := runOrbitCLI(os.Args[1:], os.Stdin, os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// runOrbitCLI routes one command line and returns the error rather than exiting, so a test can
// execute exactly the argv `orbit capabilities` advertises. main keeps the exit code and the one
// place the message is printed; the per-family prefix is part of the returned error so the text on
// stderr is the one a person has always seen.
func runOrbitCLI(args []string, in io.Reader, out, errW io.Writer) error {
	// `--receipt` on any catalogued command prints its receipt instead of its output (cli_receipt.go).
	if rest, asked := takeReceiptFlag(args); asked {
		return runCLIReceipt(rest, in, out, errW)
	}
	cmd := ""
	if len(args) > 0 {
		cmd = args[0]
	}
	_, bools := parseFlags(args)

	// Top-level help: `orbit`, `orbit help [cmd]`, `orbit --help`, `orbit -h`.
	if cmd == "" || cmd == "help" || cmd == "--help" || cmd == "-h" {
		if len(args) > 1 {
			_, err := fmt.Fprint(out, helpFor(args[1]))
			return err
		}
		_, err := fmt.Fprint(out, usage)
		return err
	}
	// Per-subcommand help: `orbit <cmd> --help|-h` prints that command's help
	// instead of running it.
	// Nested resource commands own their leaf help (for example
	// `orbit task create --help`). Other commands keep the flat help behavior.
	if !ownsLeafHelp(cmd) && wantsHelp(args[1:]) {
		_, err := fmt.Fprint(out, helpFor(cmd))
		return err
	}

	switch cmd {
	case "register":
		registerCommand(args)
	case "run":
		cmdRun()
	case "unregister":
		unregisterCommand(args)
	case "status":
		cmdStatus()
	case "doctor":
		cmdDoctor()
	case "resume":
		cmdResume(args[1:])
	case "task":
		if err := cmdTaskCLI(args[1:], in, out); err != nil {
			return fmt.Errorf("orbit task: %w", err)
		}
	case "task-list":
		if err := cmdTaskListCLI(args[1:], in, out); err != nil {
			return fmt.Errorf("orbit task-list: %w", err)
		}
	case "project":
		if err := cmdProjectCLI(args[1:], in, out); err != nil {
			return fmt.Errorf("orbit project: %w", err)
		}
	case "session":
		if err := cmdSessionCLI(args[1:], in, out); err != nil {
			return fmt.Errorf("orbit session: %w", err)
		}
	case "agent":
		if err := cmdAgentCLI(args[1:], out); err != nil {
			return fmt.Errorf("orbit agent: %w", err)
		}
	case "runner":
		if err := cmdRunnerCLI(args[1:], out); err != nil {
			return fmt.Errorf("orbit runner: %w", err)
		}
	case "provider":
		if err := cmdProviderCLI(args[1:], in, out); err != nil {
			return fmt.Errorf("orbit provider: %w", err)
		}
	case "notify":
		if err := cmdNotifyCLI(args[1:], out); err != nil {
			return fmt.Errorf("orbit notify: %w", err)
		}
	case "watch":
		if err := cmdWatchCLI(args[1:], in, out); err != nil {
			return fmt.Errorf("orbit watch: %w", err)
		}
	case "wiki":
		if err := cmdWikiCLI(args[1:], in, out); err != nil {
			return fmt.Errorf("orbit wiki: %w", err)
		}
	case "file":
		if err := cmdFileCLI(args[1:], out); err != nil {
			return fmt.Errorf("orbit file: %w", err)
		}
	case "token":
		if err := cmdTokenCLI(args[1:], out); err != nil {
			return fmt.Errorf("orbit token: %w", err)
		}
	case "login":
		if err := cmdLoginCLI(args[1:], in, out, errW); err != nil {
			return fmt.Errorf("orbit login: %w", err)
		}
	case "logout":
		if err := cmdLogoutCLI(args[1:], out, errW); err != nil {
			return fmt.Errorf("orbit logout: %w", err)
		}
	case "whoami":
		if err := cmdWhoamiCLI(args[1:], out, errW); err != nil {
			return fmt.Errorf("orbit whoami: %w", err)
		}
	case "api":
		if err := cmdAPICLI(args[1:], in, out, errW); err != nil {
			return fmt.Errorf("orbit api: %w", err)
		}
	case "capabilities":
		if err := cmdCapabilitiesCLI(args[1:], out); err != nil {
			return fmt.Errorf("orbit capabilities: %w", err)
		}
	case "host":
		if err := cmdHostCLI(args[1:], out); err != nil {
			return fmt.Errorf("orbit host: %w", err)
		}
	case "hostd":
		if err := cmdHostd(hostdConfig{}, hostdSystemDefaults(), bools["foreground"], errW); err != nil {
			return fmt.Errorf("orbit hostd: %w", err)
		}
	case "upgrade":
		cmdUpgrade()
	case "engine-update":
		cmdEngineUpdate()
	case "mcp":
		// `orbit mcp help` is a person asking, not an engine: the server would sit reading stdin.
		if len(args) > 1 && args[1] == "help" {
			_, err := fmt.Fprint(out, helpFor("mcp"))
			return err
		}
		cmdMcp()
	case "hook":
		cmdHook(args[1:])
	case "version", "--version", "-v":
		fmt.Fprintln(out, version)
	default:
		return fmt.Errorf("unknown command: %s\n\n%s", cmd, usage)
	}
	return nil

}

// registerCommand is `orbit register` as typed: args is the command and its arguments. Under
// sudo it is the invoking account's to run (handOffUnderSudo).
func registerCommand(args []string) {
	if handOffUnderSudo(args) {
		return
	}
	flags, bools := parseFlags(args)
	cmdRegister(flags, bools)
}

func cmdRegister(flags map[string]string, bools map[string]bool) {
	// Before anything is asked of the control plane or of a person (checkConfigStorage).
	if err := checkConfigStorage(); err != nil {
		who := "this account"
		if u, err := registeringUser(); err == nil {
			who = u.Username
		}
		fmt.Fprintf(os.Stderr, "orbit register: cannot keep the runner's config in %s: %v\nNothing was registered. If an earlier sudo left it to root: sudo chown -R %s %s\n", machineHome(), err, who, machineHome())
		os.Exit(1)
	}
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
	foreground := bools["foreground"]
	// --foreground (and --no-service) skip installing the background service.
	withService := !bools["no-service"] && !foreground
	// `orbit register` run directly (not through install.sh) gets the same opening
	// plan; the installer prints it before downloading.
	if interactive() && os.Getenv("ORBIT_INSTALL_PLAN") != "1" {
		fmt.Print("\nOrbit runner setup\n")
		if withService {
			fmt.Print("  Registers this machine, keeps it running in the background, and\n" +
				"  automatically installs an engine when work needs one.\n")
		} else {
			fmt.Print("  Registers this machine and automatically installs an engine when\n" +
				"  work needs one.\n")
		}
	}
	// Register just this machine as a runner; agents are registered separately.
	// The name defaults to the hostname — confirm/edit it interactively unless
	// --name was passed.
	name := flags["name"]
	if name == "" {
		if interactive() {
			fmt.Print("\n1 · Name this machine\n    Shown in Orbit. You can rename it later.\n")
		}
		name = promptName(defaultRunnerName())
	} else if interactive() {
		fmt.Printf("\n1 · Name this machine\n    %s (from --name)\n", name)
	}
	labels := parseLabels(flags["labels"])
	maxConcurrent := getInt(flags, "max-concurrent", defaultMaxConcurrent())
	token := flags["token"]
	// The directory Claude Code runs in (the project to work on). Defaults to the
	// register cwd so a runner registered inside a repo operates on that repo.
	workDir := flags["workdir"]
	if workDir == "" {
		workDir = registerCwd()
	}
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
			server, labels, maxConcurrent, workDir, false, withService, foreground, proxyVars, bools)
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
	if interactive() {
		fmt.Print("\n2 · Approve this machine\n")
		fmt.Printf("    Approving: %s\n", registerIdentity(name))
		if remoteMachine() {
			fmt.Println("    Open this link on a device with a browser:")
		} else {
			fmt.Println("    Open this link in your browser:")
		}
		fmt.Printf("\n      %s\n\n", link)
		fmt.Printf("    The page must show the same code:  %s\n", start.UserCode)
		fmt.Println("    Only approve if you just ran this command.")
		fmt.Println()
	} else {
		fmt.Printf("\nTo finish registering this machine, open this link and approve it:\n\n"+
			"  %s\n\n  Verification code: %s\n", link, start.UserCode)
	}
	openBrowser(link)

	poll, err := awaitDeviceApproval(t, start, registerWait(start, interactive()))
	if interactive() {
		fmt.Println()
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "\n%v\n", err)
		os.Exit(1)
	}
	finishRegister(poll.RunnerID, poll.RunnerToken, poll.Name,
		server, labels, maxConcurrent, workDir, true, withService, foreground, proxyVars, bools)
}

// awaitDeviceApproval polls a device registration until the browser decides it: the approved poll,
// or why there is none — denied there, or not decided before it expired.
func awaitDeviceApproval(t *Transport, start *DeviceStartResponse, sleep func(time.Duration)) (*DevicePollResponse, error) {
	timedOut := errors.New("✗ This approval link expired — run `orbit register` again for a new one")
	deadline := time.Now().Add(time.Duration(start.ExpiresIn) * time.Second)
	interval := time.Duration(max(1, start.Interval)) * time.Second
	for time.Now().Before(deadline) {
		sleep(interval)
		poll, err := t.devicePoll(start.DeviceCode)
		if err != nil {
			continue // transient — keep waiting until the deadline
		}
		switch poll.Status {
		case "approved":
			return poll, nil
		case "denied":
			return nil, errors.New("✗ Denied in the browser — nothing was added to your account")
		case "expired":
			return nil, timedOut
		}
	}
	return nil, timedOut
}

// registerIdentity is what the approval page shows: the runner name, and the
// hostname when --name chose something else.
func registerIdentity(name string) string {
	host := hostnameOr()
	if host == "" || host == name {
		return name
	}
	return fmt.Sprintf("%s (%s)", name, host)
}

// registerWait is awaitDeviceApproval's sleep. On a terminal it keeps one line
// counting down the link's life; without one it just sleeps.
func registerWait(start *DeviceStartResponse, show bool) func(time.Duration) {
	if !show {
		return time.Sleep
	}
	deadline := time.Now().Add(time.Duration(start.ExpiresIn) * time.Second)
	line := func() string {
		return fmt.Sprintf("    Waiting for approval… %s left · Ctrl-C to cancel ", clockUntil(deadline))
	}
	fmt.Print(line())
	return func(d time.Duration) {
		time.Sleep(d)
		fmt.Printf("\r%s", line())
	}
}

func clockUntil(deadline time.Time) string {
	s := int(time.Until(deadline).Seconds())
	if s < 0 {
		s = 0
	}
	return fmt.Sprintf("%d:%02d", s/60, s%60)
}

// finishRegister persists the machine runner credential, installs the background
// service (unless running in the foreground), and prints the setup receipt.
func finishRegister(runnerID, runnerToken, name string, server string, labels []string, maxConcurrent int, workDir string, browserApproved, withService, foreground bool, proxyVars []envVar, bools map[string]bool) {
	cfg := &RunnerConfig{
		ServerURL: server, RunnerID: runnerID, RunnerToken: runnerToken,
		Name: name, Labels: labels, MaxConcurrent: maxConcurrent, WorkDir: workDir,
		// Engines are installed on demand by default; --no-auto-install-engines
		// turns that off. There is no prompt: the installer's plan says so.
		AutoInstallEngines: autoInstallEnabled(bools),
	}
	if err := saveConfig(cfg); err != nil {
		fmt.Fprintln(os.Stderr, "failed to save config:", err)
		os.Exit(1)
	}
	if browserApproved {
		fmt.Printf("\n    ✓ Approved — %s is now a runner.\n", cfg.Name)
	} else {
		fmt.Printf("\n    ✓ %s is now a runner.\n", cfg.Name)
	}

	outcome := registeredOnly
	if withService {
		outcome = startService(cfg, proxyVars)
	}
	if u, err := registeringUser(); err == nil && u.Username == "root" {
		fmt.Println("    Running as root — agents will have root access on this machine.")
		fmt.Println("    For production, register with a dedicated user.")
	}
	printRegisterReceipt(os.Stdout, cfg, outcome, foreground)
	if outcome == serviceNotOnline {
		os.Exit(1)
	}

	if foreground {
		fmt.Printf("\nrunning %q in the foreground — Ctrl-C to stop\n", cfg.Name)
		// If an update re-execs this process it should come back as a runner, not
		// repeat registration and re-issue the credential from the original argv.
		os.Args = []string{os.Args[0], "run"}
		clearInheritedSessionContext()
		runWithSelfUpdates(cfg, selfUpdate, func() (bool, func()) { return runLoop(cfg) })
	}
}

// startService installs and starts the background service for cfg's runner, then waits for the
// control plane to hear from it (onlineWatch) before saying it started. A service that started but
// was not heard from is reported with why, what it logged and where to look further.
func startService(cfg *RunnerConfig, proxyVars []envVar) registerOutcome {
	me := newCallerTransport(cfg.ServerURL, cfg.RunnerToken, runnerCallerCLI).me
	// What the control plane last heard from this runner, before the service starts: a runner
	// registered again keeps the beats of the process its old credential belonged to.
	before, _ := me()
	started := time.Now()
	svc, err := setupService(machineHome(), proxyVars)
	if err != nil {
		printServiceFailure(os.Stderr, err)
		// Whoever registers under sudo asked for a running service, with root in hand. And
		// an account whose older runner could not be taken down, or whose broker is still
		// working, is left with a runner that is not this registration's.
		var refused *hostdRegisterRefusal
		if handedOffBySudo() || errors.As(err, &refused) && refused.code != hostdRefusedOwnCopy {
			return serviceNotOnline
		}
		return registeredOnly
	}
	gaps := 0
	state := func() (serviceState, bool) { return launchdState(svc.label, &gaps) }
	if svc.unit != "" {
		restarts := systemdRestarts(svc.unit)
		state = func() (serviceState, bool) { return systemdState(svc.unit, restarts) }
	}
	server := strings.TrimRight(cfg.ServerURL, "/")
	fmt.Printf("    Waiting for the runner to reach %s (up to %s)…\n", server, onlineWait)
	watch := onlineWatch{server: server, me: me, state: state, sleep: time.Sleep, now: time.Now, wait: onlineWait, poll: onlinePoll}
	if err := watch.until(before); err != nil {
		printNotOnline(os.Stderr, cfg.Name, svc, err, serviceLog(svc, started.Add(-time.Second), 15))
		return serviceNotOnline
	}
	printServiceStarted(svc.how)
	for _, note := range svc.notes {
		fmt.Println("      " + note)
	}
	return serviceOnline
}

// printServiceFailure says why the background service did not start and what to do
// instead. The machine broker's answers that register stops at (hostdRegisterRefusal) say
// what is in the way and what puts it right, so they are printed whole, in place of the
// foreground hint.
func printServiceFailure(w io.Writer, err error) {
	var refused *hostdRegisterRefusal
	if errors.As(err, &refused) {
		fmt.Fprintf(w, "\n✗ Could not start the background service: %s\n", refused.reason)
		return
	}
	fmt.Fprintf(w, "\n✗ Could not start the background service: %s\n", firstLine(err.Error()))
	fmt.Fprintln(w, "  Start it in the foreground instead:  orbit run")
}

// autoInstallEnabled is the register-time default: engines install on demand
// unless this registration turned it off.
func autoInstallEnabled(bools map[string]bool) bool {
	return !bools["no-auto-install-engines"]
}

// registerOutcome is how a registration ended, for its receipt.
type registerOutcome int

const (
	// registeredOnly: no background service — --no-service, --foreground, or one that could not
	// be installed (printServiceFailure said why).
	registeredOnly registerOutcome = iota
	// serviceOnline: the service started and the control plane heard from it.
	serviceOnline
	// serviceNotOnline: the service was installed and started and the control plane did not hear
	// from it (printNotOnline said why), or under sudo it could not be installed, or the machine
	// broker could not take the account's older runner down (printServiceFailure).
	serviceNotOnline
)

// printRegisterReceipt is the last thing a registration prints: what this machine is, and
// the one thing to do next.
func printRegisterReceipt(w io.Writer, cfg *RunnerConfig, outcome registerOutcome, foreground bool) {
	switch outcome {
	case serviceOnline:
		fmt.Fprintf(w, "\n✓ Setup complete — %s is online.\n\n", cfg.Name)
	case serviceNotOnline:
		fmt.Fprintf(w, "\n✗ Setup incomplete — %s is registered, but not online.\n\n", cfg.Name)
	default:
		fmt.Fprintf(w, "\n✓ Setup complete — %s is registered.\n\n", cfg.Name)
	}
	machine := cfg.Name
	if host := hostnameOr(); host != "" && host != cfg.Name {
		machine = fmt.Sprintf("%s (%s)", cfg.Name, host)
	}
	fmt.Fprintf(w, "    Machine  %s\n", machine)
	// The next step the approval page and Add a runner give: this machine's new session page, whose card
	// asks for a folder and a signed-in CLI.
	switch {
	case foreground:
		fmt.Fprintln(w, "    Next     Start a session; Ctrl-C stops the runner.")
	case outcome == serviceOnline:
		fmt.Fprintln(w, "    Next     Start a session")
	case outcome == serviceNotOnline:
		fmt.Fprintln(w, "    Next     get its service running (see above), then Start a session")
	default:
		fmt.Fprintln(w, "    Next     start it with `orbit run`, then Start a session")
	}
	fmt.Fprintf(w, "             %s/runners/%s/new\n", strings.TrimRight(cfg.ServerURL, "/"), publicID(cfg.RunnerID))
	tools := "    orbit status · orbit doctor · orbit unregister"
	// A runner registered under sudo is the account's, and root's own `orbit status` knows nothing of it.
	if u, err := registeringUser(); err == nil && handedOffBySudo() {
		tools += " (as " + u.Username + ")"
	}
	fmt.Fprintln(w, tools)
}

// unregisterCommand is `orbit unregister` as typed: args is the command and its arguments. Under
// sudo it is the invoking account's to run, as register is (handOffUnderSudo).
func unregisterCommand(args []string) {
	if !stayRootForRunnerLeftInRootsHome() && handOffUnderSudo(args) {
		return
	}
	_, bools := parseFlags(args)
	cmdUnregister(bools)
}

// cmdUnregister tears down this machine's runner: stops/removes the service,
// deletes the runner (and its agents) from the control plane, and drops the config.
func cmdUnregister(bools map[string]bool) {
	cfg := loadConfig()
	if cfg == nil {
		// A service that names this home and finds no config in it exits at every start: an unregister
		// that could not remove it left it so, and running again is how to finish.
		if u, err := registeringUser(); err == nil && serviceNamesMachineHome(runtime.GOOS, u) {
			uninstallService()
			return
		}
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

	// Every secret file this runner wrote goes with it (secret_store.go).
	if n := removeLedgerSecrets(newCallerTransport(cfg.ServerURL, cfg.RunnerToken, runnerCallerCLI)); n > 0 {
		fmt.Printf("✓ removed %d secret file(s) the owner had delivered to this runner\n", n)
	}

	if err := newCallerTransport(cfg.ServerURL, cfg.RunnerToken, runnerCallerCLI).deregister(); err != nil {
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
	// Before anything reads HOME, ORBIT_HOME or PATH — loadConfig below is already one
	// such reader — settle what this process's environment actually is.
	resolveRunnerEnv()
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
	// A managed runner's Pod says which instance it is (managed_instance.go); one that said so
	// unreadably does not start as though it had said nothing.
	if err := checkManagedRunnerInstance(); err != nil {
		fmt.Fprintln(os.Stderr, "managed runner instance:", err)
		os.Exit(1)
	}
	// A managed runner's volume has to survive its node's power loss (volume_durability.go): before
	// anything runs Git there, it looks at what the last stop left.
	recoverManagedRepositories()
	logManagedVolumeSyncs()
	runWithSelfUpdates(cfg, selfUpdate, func() (bool, func()) { return runLoop(cfg) })
	// Its Pod ends Failed, not Succeeded: the instance did not finish, it was retired or fenced.
	if managedInstanceRevokedSeen.Load() {
		os.Exit(3)
	}
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
func runWithSelfUpdates(cfg *RunnerConfig, update func(string), loop func() (bool, func())) {
	superviseSelfUpdates(cfg.ServerURL, update, loop, execCurrentProcess)
}

// superviseSelfUpdates runs loop, which reports whether it drained to re-execute, and what ends the
// jobs its sessions handed on to the image the re-exec starts (handOffJobs).
func superviseSelfUpdates(server string, update func(string), loop func() (bool, func()), restart func() error) {
	update(server)
	updating, endHandedOn := loop()
	if !updating {
		return
	}
	update(server)
	if err := restart(); err != nil {
		fmt.Fprintln(os.Stderr, "runner restart after update attempt failed:", err)
		// No image will adopt what the sessions handed on: end it, as any other runner stop would.
		endHandedOn()
	}
}

func cmdStatus() {
	cfg := loadConfig()
	if cfg == nil {
		fmt.Printf("no runner registered on this machine\nRun `orbit register` to add one.\n")
		return
	}
	fmt.Printf("orbit %s (%s)\n", version, sourceSHA)
	fmt.Printf("\nrunner:  %s (%s)\nserver:  %s\nlabels:  %s\nconfig:  %s\n",
		cfg.Name, cfg.RunnerID, cfg.ServerURL, labelsOrDash(cfg.Labels), configPath())

	me, err := newCallerTransport(cfg.ServerURL, cfg.RunnerToken, runnerCallerCLI).me()
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
		resp, err := newCallerTransport(cfg.ServerURL, cfg.RunnerToken, runnerCallerCLI).sessionMeta(sessionID)
		if err != nil {
			fmt.Fprintf(os.Stderr, "session %q not found: %v\n", sessionID, err)
			os.Exit(1)
		}
		meta = resumeMetaFromServer(resp)
		// Cache it so future resumes are offline-capable.
		_ = os.MkdirAll(sessionDir, 0o755)
		if b, err := json.Marshal(meta); err == nil {
			_ = writeFileAtomically(metaPath, b, 0o644)
		}
	}

	// Refused before anything is printed as resuming: the engine decides, and one this terminal
	// cannot open is said as that rather than as a CLI that starts on a conversation it is not.
	cmd, err := resumeCommand(sessionID, sessionDir, meta)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("resuming session %s", sessionID)
	if meta.Title != "" {
		fmt.Printf(" — %s", meta.Title)
	}
	fmt.Println()
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

// resumeMetaFromServer is the record `orbit resume` keeps of a session it knows only from the control
// plane. Its engine is the session's own as the server reports it (docs/provider-engine-contract.md
// §6.3): `engine`, or — from a control plane older than that field — `provider`, which carried it.
func resumeMetaFromServer(resp *SessionMetaResponse) *sessionMeta {
	meta := &sessionMeta{
		Provider:         strings.TrimSpace(resp.Engine),
		SessionUUID:      resp.SessionUUID,
		RuntimeSessionID: resp.RuntimeSessionID,
		Title:            resp.Title,
	}
	if meta.Provider == "" {
		meta.Provider = resp.Provider
	}
	if resp.WorkDir != nil {
		meta.WorkDir = *resp.WorkDir
	}
	return meta
}

// resumeCommand is the CLI that reopens a session's conversation in this terminal, chosen by the
// engine the session runs on (meta.Provider), or why there is none. Nothing is started here.
func resumeCommand(sessionID, sessionDir string, meta *sessionMeta) (*exec.Cmd, error) {
	var cmd *exec.Cmd
	switch strings.ToLower(strings.TrimSpace(meta.Provider)) {
	case providerCodex:
		state, err := codexStateForResume(sessionDir, meta)
		if err != nil {
			return nil, fmt.Errorf("cannot resolve this Codex session's state: %w", err)
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
		if state.CodexHome != "" {
			cmd.Env = envWithValue(os.Environ(), "CODEX_HOME", state.CodexHome)
		}
	case providerKimi:
		if meta.RuntimeSessionID == "" {
			return nil, fmt.Errorf("this Kimi session has no runtime session id yet")
		}
		cmd = exec.Command(providerKimi, "--resume", meta.RuntimeSessionID)
		// kimi finds the conversation in its KIMI_CODE_HOME: the account's the session ran on, or —
		// with none recorded — Default's, which this terminal's own environment selects.
		if meta.KimiCodeHome != "" {
			cmd.Env = envWithValue(os.Environ(), "KIMI_CODE_HOME", meta.KimiCodeHome)
		}
	case providerOpenCode:
		if meta.RuntimeSessionID == "" {
			return nil, fmt.Errorf("this OpenCode session has not been initialized yet")
		}
		cmd = exec.Command(providerOpenCode, "--session", meta.RuntimeSessionID)
	case providerAntigravity:
		if meta.RuntimeSessionID == "" {
			return nil, fmt.Errorf("this Antigravity session has no conversation yet")
		}
		// The conversation lives in the session's own Gemini directory, not in ~/.gemini; agy
		// reads GEMINI_API_KEY from this terminal's environment.
		geminiDir, err := antigravityGeminiDir(sessionDir)
		if err != nil {
			return nil, fmt.Errorf("cannot resolve this session's Gemini directory: %w", err)
		}
		cmd = exec.Command(agyExecutable, "--gemini_dir="+geminiDir, "--conversation", meta.RuntimeSessionID)
	case providerDsh:
		// Not the claude fallback below, which would start Claude Code on an id that is a Harness
		// conversation. Orbit runs Harness only as an ACP server in a per-session home it seals
		// (dsh_environment.go), the pinned install ships no terminal profile, and the session's key
		// comes with each dispatch and is never stored here — so this terminal has nothing to open.
		return nil, fmt.Errorf("this session runs on DeepSeek Harness, which orbit resume cannot open in a terminal: "+
			"Orbit drives Harness over ACP, the Harness it installs has no terminal interface, and the session's "+
			"DeepSeek key reaches it only with each run Orbit dispatches. Continue it in Orbit, or from here with "+
			"`orbit session send %s --message TEXT --resume-if-ended`", publicID(sessionID))
	case providerCursor:
		// Not the claude fallback either. Orbit drives Cursor CLI over ACP, with a HOME and a
		// conversation store of the session's own (cursor_launch.go), and whether the CLI's terminal
		// interface can open an ACP conversation is unmeasured; the session's credential comes with
		// each run Orbit dispatches.
		return nil, fmt.Errorf("this session runs on Cursor CLI, which orbit resume cannot open in a terminal: "+
			"Orbit drives Cursor CLI over ACP, and the session's credential reaches it only with each run Orbit "+
			"dispatches. Continue it in Orbit, or from here with `orbit session send %s --message TEXT --resume-if-ended`", publicID(sessionID))
	default:
		cmd = exec.Command("claude", "--resume", meta.SessionUUID)
	}
	if meta.WorkDir != "" {
		cmd.Dir = expandTilde(meta.WorkDir)
		if notice := absentCheckoutNotice(sessionID, cmd.Dir); notice != "" {
			return nil, errors.New(notice)
		}
	}
	return cmd, nil
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

// defaultMaxConcurrent is the machine's CPU core count.
func defaultMaxConcurrent() int {
	return runtime.NumCPU()
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
	fmt.Printf("    Name [%s]: ", def)
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
