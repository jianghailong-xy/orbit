package main

import (
	"bufio"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// One shared reader so sequential prompts (confirm, name) don't drop buffered input.
var stdinReader = bufio.NewReader(os.Stdin)

func interactive() bool {
	fi, _ := os.Stdin.Stat()
	return fi != nil && fi.Mode()&os.ModeCharDevice != 0
}

// Overridden at build time with -ldflags "-X main.version=...". A "dev" build
// disables self-update.
var version = "dev"

const defaultServer = "https://orbit.wikova.com"

var usage = `orbit — register a machine and run Claude Code tasks for an Orbit control plane

Usage:
  orbit register [options]          Register this machine + install the service (approve in the browser)
  orbit run                         Start the runner loop in the foreground
  orbit unregister [--yes]          Remove this runner: delete it server-side, stop the service, drop local config
  orbit status                      Show this directory's runner and its control-plane status
  orbit upgrade                     Force-reinstall the latest binary (if auto-update isn't working)

Run 'orbit <command> --help' for command-specific options.

The runner drives the machine's local Claude Code login (run 'claude' then '/login');
no API key is required.

Env:
  ORBIT_HOME               Override the runner's config/runs dir (default: ~/.orbit)
  ORBIT_NO_SELFUPDATE      Disable the startup auto-update
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
	"upgrade": `orbit upgrade — force-reinstall the latest orbit binary

Usage:
  orbit upgrade

Use this if the startup auto-update isn't working.
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
	if wantsHelp(args[1:]) {
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
	case "upgrade":
		cmdUpgrade()
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
			server, labels, maxConcurrent, workDir, withService, foreground)
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
				server, labels, maxConcurrent, workDir, withService, foreground)
			return
		}
		if poll.Status == "expired" {
			break
		}
	}
	fmt.Fprintln(os.Stderr, "registration timed out — please run `orbit register` again")
	os.Exit(1)
}

// finishRegister persists the machine runner credential and installs the
// background service (unless running in the foreground).
func finishRegister(runnerID, runnerToken, name string, server string, labels []string, maxConcurrent int, workDir string, withService, foreground bool) {
	cfg := &RunnerConfig{
		ServerURL: server, RunnerID: runnerID, RunnerToken: runnerToken,
		Name: name, Labels: labels, MaxConcurrent: maxConcurrent, WorkDir: workDir,
	}
	if err := saveConfig(cfg); err != nil {
		fmt.Fprintln(os.Stderr, "failed to save config:", err)
		os.Exit(1)
	}
	fmt.Printf("\n✓ registered runner %q (%s).\n", cfg.Name, cfg.RunnerID)

	if foreground {
		fmt.Printf("running %q in the foreground — Ctrl-C to stop\n", cfg.Name)
		runLoop(cfg)
		return
	}
	if !withService {
		fmt.Println("  Start it with:  orbit run")
		return
	}
	if err := setupService(machineHome()); err != nil {
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
	cfg := loadConfig()
	if cfg == nil {
		fmt.Fprintln(os.Stderr, "no runner config found — run `orbit register` first")
		os.Exit(1)
	}
	selfUpdate(cfg.ServerURL) // pull a newer orbit before settling into the loop
	runLoop(cfg)
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
