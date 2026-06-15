package main

import (
	"bufio"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
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

register options:
  --server <url>           Control plane base URL (default: ` + defaultServer + `)
  --token <token>          Optional one-time enrollment token (skips browser approval)
  --name <name>            Runner name (default: "<dir> @ <hostname>")
  --labels a,b,c           Routing labels (e.g. sg,hdfs)
  --max-concurrent <n>     Max concurrent jobs (default: 1)
  --force                  Re-register even if this directory already has a runner
  --no-service             Register only; don't install/start the background service
  --foreground             Register and run in the foreground now (implies --no-service)

The runner drives the machine's local Claude Code login (run 'claude' then '/login');
no API key is required.

Env:
  ORBIT_HOME               Override config/runs dir (default: ./.orbit in the current directory)
  ORBIT_NO_SELFUPDATE      Disable the startup auto-update
`

func main() {
	args := os.Args[1:]
	cmd := ""
	if len(args) > 0 {
		cmd = args[0]
	}
	flags, bools := parseFlags(args)

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
	case "", "help", "--help", "-h":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n%s", cmd, usage)
		os.Exit(1)
	}
}

func cmdRegister(flags map[string]string, bools map[string]bool) {
	// A machine can host many runners — one per directory. Re-registering the
	// same directory overwrites its config, so confirm first.
	if existing := loadConfig(); existing != nil && !bools["force"] {
		ok := confirm(fmt.Sprintf(
			"This directory already has runner %q registered.\nRegister a new one here (overwrites %s)? [Y/n] ",
			existing.Name, configPath()), true)
		if !ok {
			fmt.Println("aborted — use `orbit register` in another directory, or pass --force")
			os.Exit(0)
		}
	}

	server := strings.TrimRight(getStr(flags, "server", defaultServer), "/")
	// Name defaults to "<dir> @ <hostname>"; confirm/edit it interactively unless
	// --name was passed.
	name := flags["name"]
	if name == "" {
		name = promptName(defaultAgentName())
	}
	labels := parseLabels(flags["labels"])
	maxConcurrent := getInt(flags, "max-concurrent", 1)
	// Detect the coding agents installed here (Claude Code, Codex) and let the
	// user pick which to register; the default is all of them. Then make the
	// chosen agents usable — install any that are missing, and confirm Claude
	// Code is logged in — before registering this machine.
	selected := selectAgents()
	ensureAgentsReady(selected)
	agents := agentKeys(selected)
	token := flags["token"]
	foreground := bools["foreground"]
	// --foreground (and --no-service) skip installing the background service.
	withService := !bools["no-service"] && !foreground
	t := NewTransport(server, "")

	// Legacy path: an explicit enrollment token skips browser approval.
	if token != "" {
		res, err := t.register(RegisterRequest{
			EnrollmentToken: token, Name: name, Hostname: hostnameOr(),
			Labels: labels, MaxConcurrent: maxConcurrent, Version: version,
		})
		if err != nil {
			fmt.Fprintln(os.Stderr, "registration failed:", err)
			os.Exit(1)
		}
		finishRegister(res.RunnerID, res.RunnerToken, res.Name, server, labels, agents, maxConcurrent, withService, foreground)
		return
	}

	// Device-login flow: approve this machine in the browser, like `claude` login.
	start, err := t.deviceStart(DeviceStartRequest{
		Name: name, Hostname: hostnameOr(), Labels: labels,
		MaxConcurrent: maxConcurrent, Version: version,
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
			finishRegister(poll.RunnerID, poll.RunnerToken, poll.Name, server, labels, agents, maxConcurrent, withService, foreground)
			return
		}
		if poll.Status == "expired" {
			break
		}
	}
	fmt.Fprintln(os.Stderr, "registration timed out — please run `orbit register` again")
	os.Exit(1)
}

func finishRegister(runnerID, runnerToken, name, server string, labels, agents []string, maxConcurrent int, withService, foreground bool) {
	cfg := &RunnerConfig{
		ServerURL: server, RunnerID: runnerID, RunnerToken: runnerToken,
		Name: name, Labels: labels, MaxConcurrent: maxConcurrent, Agents: agents,
	}
	if err := saveConfig(cfg); err != nil {
		fmt.Fprintln(os.Stderr, "failed to save config:", err)
		os.Exit(1)
	}
	fmt.Printf("\n✓ registered runner %q (%s).\n", name, runnerID)
	if len(agents) > 0 {
		fmt.Printf("  agents:  %s\n", strings.Join(agents, ", "))
	}

	if foreground {
		fmt.Println("running in the foreground — Ctrl-C to stop")
		runLoop(cfg)
		return
	}
	if !withService {
		fmt.Println("  Start it with:  orbit run")
		return
	}
	// Auto-install the background service so the machine starts working immediately.
	if err := setupService(); err != nil {
		fmt.Fprintf(os.Stderr, "\nnote: could not auto-install the service (%s)\n", firstLine(err.Error()))
		fmt.Fprintln(os.Stderr, "  you can run it in the foreground instead:  orbit run")
	}
}

// cmdUnregister tears down this directory's runner: stops/removes the service,
// deletes the runner from the control plane, and drops the local config.
func cmdUnregister(bools map[string]bool) {
	cfg := loadConfig()
	if cfg == nil {
		cwd, _ := os.Getwd()
		fmt.Printf("no runner registered in %s\n", cwd)
		return
	}
	if !bools["yes"] && !bools["force"] {
		if !confirm(fmt.Sprintf(
			"Unregister runner %q — stop its service, delete it from %s, and remove local config? [y/N] ",
			cfg.Name, cfg.ServerURL), false) {
			fmt.Println("aborted")
			return
		}
	}

	uninstallService() // stop + remove the background service first

	if err := NewTransport(cfg.ServerURL, cfg.RunnerToken).deregister(); err != nil {
		fmt.Fprintf(os.Stderr, "note: could not delete the runner from the control plane (%s)\n", firstLine(err.Error()))
	} else {
		fmt.Println("✓ deleted from the control plane")
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
		cwd, _ := os.Getwd()
		fmt.Printf("no runner registered in %s\nRun `orbit register` to add one.\n", cwd)
		return
	}
	fmt.Printf("orbit %s\nrunner:  %s (%s)\nserver:  %s\nlabels:  %s\nconfig:  %s\n",
		version, cfg.Name, cfg.RunnerID, cfg.ServerURL, labelsOrDash(cfg.Labels), configPath())

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
}

func cmdUpgrade() {
	server := defaultServer
	if cfg := loadConfig(); cfg != nil {
		server = cfg.ServerURL
	}
	upgrade(strings.TrimRight(server, "/"))
}

// ── small helpers ─────────────────────────────────────────────────────────

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

// defaultAgentName is "<current directory name> @ <hostname>".
func defaultAgentName() string {
	dir := "runner"
	if cwd, err := os.Getwd(); err == nil {
		dir = filepath.Base(cwd)
	}
	return dir + " @ " + hostnameOr()
}

// promptName asks the user to confirm/edit the runner name; Enter keeps the
// default. Non-interactive callers get the default unchanged.
func promptName(def string) string {
	if !interactive() {
		return def
	}
	fmt.Printf("Agent name [%s]: ", def)
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
