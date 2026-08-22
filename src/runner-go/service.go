package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

// One runner per machine, so the background service has a single fixed name.
const (
	systemdService = "orbit-runner"
	launchdLabel   = "com.orbit.runner"
	// Where system-level unit files live. Named rather than spelled out at each use
	// site because hostd's migration reads the same directory through an injectable
	// field so tests can point it at a temporary one.
	systemdUnitDir = "/etc/systemd/system"
)

// setupService installs + starts a background service that runs `orbit run` (with
// ORBIT_HOME=orbitHome) and restarts on failure. Linux uses systemd; macOS uses a
// launchd LaunchAgent. Returns an error instead of exiting, so `orbit register` can
// call it best-effort. The runner authenticates through the machine's local Claude
// Code login, so no API key is involved here.
func setupService(orbitHome string, proxyVars []envVar) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot locate executable: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}

	switch runtime.GOOS {
	case "linux":
		return setupServiceLinux(hostdSocketPath, proxyVars, func() error {
			return installSystemd(exe, orbitHome, systemdService, proxyVars)
		})
	case "darwin":
		return installLaunchd(exe, orbitHome, launchdLabel, proxyVars)
	default:
		return errors.New("background service is only supported on Linux (systemd) and macOS (launchd); run `orbit run` under your own supervisor")
	}
}

// setupServiceLinux installs the runner service the best way this host allows. With
// `orbit host setup` done, that is the machine broker: enabling this user's instance is
// a socket call that needs no root at all. Anything else — no broker, or a broker that
// will not answer — installs a unit of our own through sudo, so a host that was never
// set up (or was set up badly) still ends a registration with a live runner.
func setupServiceLinux(socketPath string, proxyVars []envVar, installLegacy func() error) error {
	if registerViaHostd(socketPath, proxyVars) {
		return nil
	}
	return installLegacy()
}

// uninstallService stops and removes the machine's runner service, for
// `orbit unregister`. Best-effort: it reports problems but never aborts.
func uninstallService() {
	switch runtime.GOOS {
	case "linux":
		uninstallServiceLinux(hostdSocketPath, uninstallSystemd)
	case "darwin":
		label := launchdLabel
		home := os.Getenv("HOME")
		if home == "" {
			if h, err := os.UserHomeDir(); err == nil {
				home = h
			}
		}
		plistPath := filepath.Join(home, "Library", "LaunchAgents", label+".plist")
		runQuiet("launchctl", "unload", plistPath)
		if err := os.Remove(plistPath); err != nil {
			if os.IsNotExist(err) {
				return
			}
			fmt.Fprintf(os.Stderr, "note: could not remove %s (%v)\n  remove it with: sudo rm %s\n", plistPath, err, plistPath)
			return
		}
		fmt.Println("✓ removed the LaunchAgent")
	}
}

// uninstallServiceLinux is setupServiceLinux's counterpart: ask the broker to take this
// user's instance down, and only reach for sudo when it cannot.
func uninstallServiceLinux(socketPath string, removeLegacy func()) {
	if unregisterViaHostd(socketPath) {
		return
	}
	removeLegacy()
}

// uninstallSystemd is the pre-broker removal path, unchanged: it needs root, because
// the unit it is removing is one `orbit register` wrote into /etc/systemd/system.
func uninstallSystemd() {
	// Remove this OS user's per-user unit (orbit-runner-<user>); fall back to the
	// bare legacy name if the user can't be resolved.
	svc, username := systemdService, ""
	if u, err := registeringUser(); err == nil {
		username = u.Username
		svc = systemdServiceFor(username)
	}
	if os.Geteuid() != 0 {
		fmt.Fprintf(os.Stderr, "note: removing the systemd service needs root — run: sudo systemctl disable --now %s\n", svc)
		return
	}
	runQuiet("systemctl", "disable", "--now", svc)
	_ = os.Remove("/etc/systemd/system/" + svc + ".service")
	// Also drop a leftover legacy single-runner unit, but only if it's this user's.
	if svc != systemdService && unitRunsAsUser(systemdService, username) {
		runQuiet("systemctl", "disable", "--now", systemdService)
		_ = os.Remove("/etc/systemd/system/" + systemdService + ".service")
	}
	runQuiet("systemctl", "daemon-reload")
	fmt.Printf("✓ removed the %s service\n", svc)
}

func installSystemd(exe, orbitHome, svc string, proxyVars []envVar) error {
	// The runner — and the `claude` processes it spawns — should operate as the
	// user who ran `orbit register`, not root, so files and git ops are owned by
	// that user and claude reads that user's ~/.claude login.
	u, err := registeringUser()
	if err != nil {
		return fmt.Errorf("cannot determine the user to run the service as: %w", err)
	}
	grp := primaryGroup(u)

	// One runner per OS user, not per machine: name the unit after the user so two
	// users on one host run independent services instead of overwriting a single
	// system-wide unit. `svc` (the bare "orbit-runner") is the legacy pre-naming name,
	// kept only to migrate an older single-runner install below.
	legacySvc := svc
	svc = systemdServiceFor(u.Username)
	unitPath := "/etc/systemd/system/" + svc + ".service"

	// systemd gives services a minimal PATH and does not source the user's shell,
	// so coding CLIs installed below the user's home aren't found. Bake in the
	// user's login PATH at install time, mirroring the launchd path, plus the
	// private bin dirs the official Claude/Kimi/OpenCode installers write to.
	pathEnv := runnerEnginePath(u.HomeDir, userLoginPath(u, os.Getenv("PATH")))

	unit := fmt.Sprintf(`[Unit]
Description=Orbit runner (%s)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=%s
Group=%s
ExecStart=%s run
Restart=always
RestartSec=5
# Send SIGTERM to the runner only (not the claude children), so on stop/restart the
# runner can drain — finish in-flight turns and detach — before claude is torn down.
# The runner's complete shutdown envelope stays below this legacy-compatible value:
# provider drain + lease release + event flush + a racing finalization + margin.
KillMode=mixed
TimeoutStopSec=180
Environment=HOME=%s
Environment=ORBIT_HOME=%s
Environment=PATH=%s
%s
[Install]
WantedBy=multi-user.target
`, u.Username, u.Username, grp, exe, u.HomeDir, orbitHome, pathEnv, systemdProxyEnv(proxyVars))

	// Writing the unit + enabling it needs root. When we aren't root, run the install
	// step and every systemctl call via sudo (prompts once) so `orbit register` ends
	// with a live service without a separate command.
	root := os.Geteuid() == 0
	var sudo string
	if !root {
		s, err := exec.LookPath("sudo")
		if err != nil || !interactive() {
			return fmt.Errorf("installing the systemd service needs root: write %s then run `systemctl enable %s && systemctl restart %s`", unitPath, svc, svc)
		}
		sudo = s
		fmt.Printf("\nInstalling the %s service needs root — you may be prompted for your password.\n", svc)
	}
	// systemctl, as root directly or via sudo.
	sctl := func(args ...string) error {
		if root {
			return run("systemctl", args...)
		}
		return run(sudo, append([]string{"systemctl"}, args...)...)
	}

	// Write the unit file (root writes it directly; non-root installs it via sudo).
	if root {
		if err := os.WriteFile(unitPath, []byte(unit), 0o644); err != nil {
			return fmt.Errorf("failed to write %s: %w", unitPath, err)
		}
	} else {
		tmp, err := os.CreateTemp("", svc+"-*.service")
		if err != nil {
			return err
		}
		tmpPath := tmp.Name()
		defer os.Remove(tmpPath)
		if _, err := tmp.WriteString(unit); err != nil {
			tmp.Close()
			return err
		}
		tmp.Close()
		if err := run(sudo, "install", "-m", "0644", tmpPath, unitPath); err != nil {
			return fmt.Errorf("failed to install %s", unitPath)
		}
	}

	// Migrate a pre-naming install: older orbit used a single `orbit-runner` unit. If
	// it's this same user's, stop + remove it so we don't double-run (the old one would
	// 401 forever on its now-rotated token). A legacy unit owned by a different user is
	// that user's runner — leave it.
	migrateLegacyUnit(sctl, root, sudo, legacySvc, svc, u.Username)

	if err := sctl("daemon-reload"); err != nil {
		return errors.New("systemctl daemon-reload failed — is this a systemd host?")
	}
	if err := sctl("enable", svc); err != nil {
		return errors.New("systemctl enable failed — is this a systemd host?")
	}
	// Dropping privileges to another user: hand them the runner's config + run scratch
	// so the service (now that user) can read/write them. Do this before the (re)start
	// below so the service comes up able to read the new config. Only when we're root —
	// a non-root register already runs as the owning user.
	if root && u.Uid != "0" {
		_ = run("chown", "-R", u.Username+":"+grp, orbitHome)
	}
	// restart, not just start: a re-register rewrites config.json with a freshly issued
	// credential, but `enable --now`/`start` is a no-op on an already-running unit — the
	// live runner would keep its stale in-memory token and 401 until restarted. restart
	// starts a stopped unit and replaces a running one.
	if err := sctl("restart", svc); err != nil {
		return errors.New("systemctl restart failed — is this a systemd host?")
	}

	fmt.Printf("\n✓ %s service installed and started as user %q.\n"+
		"  Status:  systemctl status %s\n"+
		"  Logs:    journalctl -u %s -f\n", svc, u.Username, svc, svc)
	return nil
}

// systemdServiceFor returns the per-OS-user runner unit name (e.g. "orbit-runner-alice"),
// so different users on one host get independent services. Characters a systemd unit name
// disallows are mapped to '_'.
func systemdServiceFor(username string) string {
	var b strings.Builder
	b.WriteString(systemdService)
	b.WriteByte('-')
	for _, r := range username {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	return b.String()
}

// migrateLegacyUnit removes the pre-naming single `orbit-runner` unit when it belongs to
// the user we're installing a per-user unit for, so the two don't double-run. No-op when
// the new name is the legacy name, the legacy unit is absent, or it runs as a different
// user (that's their runner).
func migrateLegacyUnit(sctl func(...string) error, root bool, sudo, legacySvc, newSvc, username string) {
	if newSvc == legacySvc || !unitRunsAsUser(legacySvc, username) {
		return
	}
	_ = sctl("disable", "--now", legacySvc)
	legacyPath := "/etc/systemd/system/" + legacySvc + ".service"
	if root {
		_ = os.Remove(legacyPath)
	} else {
		_ = run(sudo, "rm", "-f", legacyPath)
	}
}

// unitRunsAsUser reports whether the given systemd unit exists and its User= is username.
// Used to decide whether a legacy `orbit-runner` unit is safe to migrate/remove on behalf
// of that user, without disturbing another user's runner.
func unitRunsAsUser(svc, username string) bool {
	return unitRunsAsUserIn(systemdUnitDir, execStdout, svc, username)
}

// unitRunsAsUserIn is unitRunsAsUser with its two touchpoints — where unit files live and
// how a command is run — passed in, so hostd can apply the identical rule against an
// injected systemctl and a temporary directory. One implementation, not two: both callers
// decide the same thing about the same units, and a second copy would drift.
func unitRunsAsUserIn(unitDir string, stdout func(string, ...string) (string, error), svc, username string) bool {
	if username == "" {
		return false
	}
	if _, err := os.Stat(filepath.Join(unitDir, svc+".service")); err != nil {
		return false
	}
	out, _ := stdout("systemctl", "show", svc+".service", "-p", "User", "--value")
	return strings.TrimSpace(out) == username
}

// execStdout runs a command and returns its standard output alone. Values read back out
// of `systemctl show -p X --value` are compared verbatim, so stderr folded into the same
// string would corrupt the comparison.
func execStdout(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).Output()
	return string(out), err
}

// registeringUser is the account the runner service should run as: the human who
// ran `orbit register`. Under sudo that's $SUDO_USER; otherwise the current user.
func registeringUser() (*user.User, error) {
	if su := os.Getenv("SUDO_USER"); su != "" && su != "root" {
		if u, err := user.Lookup(su); err == nil {
			return u, nil
		}
	}
	return user.Current()
}

// primaryGroup resolves a user's primary group name, falling back to the username
// (the common user-private-group convention) when the group can't be looked up.
func primaryGroup(u *user.User) string {
	if g, err := user.LookupGroupId(u.Gid); err == nil {
		return g.Name
	}
	return u.Username
}

// runnerEnginePath adds the private-bin destinations used by the official engine
// installers. Each installer's own way onto PATH is to append an export line to a
// shell rc file, which a service never sources — so without this an engine installs
// successfully and is still unreachable. An engine may also be installed on demand
// after the unit/plist was written, so every directory must be present even when it
// does not exist yet.
//
// Prepending one at a time reverses engineInstallerDirs: the last entry there leads
// the PATH this returns. That reversal is the point — see engineInstallerDirs.
func runnerEnginePath(home, path string) string {
	for _, dir := range engineInstallerDirs(home) {
		if !pathContains(path, dir) {
			path = dir + ":" + path
		}
	}
	return path
}

// engineInstallerDirs lists the directories the official engine installers drop a binary into,
// in reverse PATH precedence order — ~/.kimi-code/bin, ~/.opencode/bin, ~/.local/bin — because
// runnerEnginePath prepends them one at a time. The PATH it builds therefore reads them the
// other way round, ~/.local/bin outermost: Claude and Codex install there, and keeping it first
// preserves the resolution order that predates the private dirs (OpenCode and Kimi each use a
// private dir instead). That produced order is what every unit and plist already on disk was
// baked with; doctor_test.go's TestEngineInstallPathsIncludeOpenCode and
// TestServicePathReversesInstallerDirsSoLocalBinLeads hold it in place.
//
// One list, because two questions read it and they must agree: which directories a service's
// PATH needs, and whether a binary found on that PATH is an official install Orbit may re-run
// the installer against. They disagreed once — the PATH learned ~/.kimi-code/bin while the
// update check still recognised only ~/.local/bin, so a correctly installed Kimi was written
// off as package-managed and silently never updated again.
func engineInstallerDirs(home string) []string {
	if home == "" {
		return nil
	}
	home = filepath.Clean(home)
	return []string{
		filepath.Join(home, ".kimi-code", "bin"),
		filepath.Join(home, ".opencode", "bin"),
		filepath.Join(home, ".local", "bin"),
	}
}

// installedByOfficialInstaller reports whether this binary sits where an official installer puts
// it — the only kind Orbit updates by re-running that installer. Anything else came from a
// package manager, which owns updating it (and would end up with a second, shadowing copy if
// Orbit ran the installer beside it).
func installedByOfficialInstaller(binPath, home string) bool {
	dir := filepath.Dir(filepath.Clean(binPath))
	for _, d := range engineInstallerDirs(home) {
		if dir == d {
			return true
		}
	}
	return false
}

// defaultSystemPath is the last-resort PATH: what a POSIX system guarantees, used when
// neither the target user's login shell nor the current process can name a better one.
const defaultSystemPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// userLoginPath returns the target user's login PATH. When we're root dropping to
// another user, the process PATH is root's (or sudo-sanitized), so query that
// user's own login shell; otherwise the current PATH already is theirs.
func userLoginPath(u *user.User, fallback string) string {
	if u.Uid != strconv.Itoa(os.Getuid()) {
		if out, err := exec.Command("su", "-", u.Username, "-c", "printenv PATH").Output(); err == nil {
			if p := strings.TrimSpace(string(out)); p != "" {
				return p
			}
		}
	}
	if fallback == "" {
		return defaultSystemPath
	}
	return fallback
}

func pathContains(path, dir string) bool {
	for _, p := range strings.Split(path, ":") {
		if p == dir {
			return true
		}
	}
	return false
}

func installLaunchd(exe, orbitHome, label string, proxyVars []envVar) error {
	home := os.Getenv("HOME")
	if home == "" {
		if h, err := os.UserHomeDir(); err == nil {
			home = h
		}
	}
	plistPath := filepath.Join(home, "Library", "LaunchAgents", label+".plist")
	logPath := filepath.Join(orbitHome, "runner.log")

	// Keep the runner's working dir (config + logs) owned by this user, not root —
	// the agent runs as the user, so root-owned debris from a past `sudo orbit`
	// run would make it unreadable/unwritable.
	ensureOwnedByUser(orbitHome)

	// launchd starts agents with a minimal PATH and no HOME, so the `claude` CLI
	// the runner shells out to isn't found (and couldn't locate ~/.claude even if
	// it were). Bake in the install-time PATH — where `claude` lives in this shell
	// — plus HOME, so the background agent sees the same tools the user does.
	pathEnv := os.Getenv("PATH")
	if pathEnv == "" {
		pathEnv = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
	}
	pathEnv = runnerEnginePath(home, pathEnv)

	plist := renderLaunchdPlist(exe, orbitHome, label, home, pathEnv, logPath, proxyVars)

	agentsDir := filepath.Dir(plistPath)
	if err := writePlist(agentsDir, plistPath, plist); err != nil {
		if !os.IsPermission(err) {
			return err
		}
		// Managed Macs often ship a root-owned ~/Library/LaunchAgents. Hand it back
		// to this user with sudo, then retry — the agent must load in the user's own
		// session to keep the login-Keychain access Claude Code's login relies on.
		if rerr := repairAgentsDir(agentsDir); rerr != nil {
			return fmt.Errorf("failed to write %s: %w", plistPath, rerr)
		}
		if err := writePlist(agentsDir, plistPath, plist); err != nil {
			return fmt.Errorf("failed to write %s: %w", plistPath, err)
		}
	}
	runQuiet("launchctl", "unload", plistPath) // best-effort; ignore "not loaded" noise
	if err := run("launchctl", "load", "-w", plistPath); err != nil {
		return fmt.Errorf("launchctl load failed")
	}

	fmt.Printf("\n✓ %s LaunchAgent installed and started.\n"+
		"  Plist:   %s\n"+
		"  Logs:    %s\n"+
		"  Stop:    launchctl unload %s\n", label, plistPath, logPath, plistPath)
	return nil
}

func renderLaunchdPlist(exe, orbitHome, label, home, pathEnv, logPath string, proxyVars []envVar) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>%s</string>
  <key>ProgramArguments</key>
  <array>
    <string>%s</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ORBIT_HOME</key><string>%s</string>
    <key>HOME</key><string>%s</string>
    <key>PATH</key><string>%s</string>
%s  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Keep launchd's SIGTERM-to-SIGKILL window above the runner's complete
       provider-drain, lease-release, event-flush, and finalization envelope. -->
  <key>ExitTimeOut</key><integer>180</integer>
  <key>StandardOutPath</key><string>%s</string>
  <key>StandardErrorPath</key><string>%s</string>
</dict>
</plist>
`, label, exe, orbitHome, home, pathEnv, launchdProxyEnv(proxyVars), logPath, logPath)
}

// run and runQuiet are vars, not plain funcs, so a test can record what a path shells
// out to. That the broker path shells out to nothing at all — no sudo, no systemctl —
// is the property worth guarding: it is the whole reason that path exists.
var run = func(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// runQuiet runs a best-effort command, discarding its output and result — for
// steps like a pre-unload that legitimately fail (and complain) when there's
// nothing to undo.
var runQuiet = func(name string, args ...string) {
	_ = exec.Command(name, args...).Run()
}

// writePlist writes the LaunchAgent plist, creating its directory.
func writePlist(dir, path, content string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), 0o644)
}

// repairAgentsDir takes ownership of a locked ~/Library/LaunchAgents (common on
// MDM-managed Macs) with sudo, so the LaunchAgent can be installed as this user.
func repairAgentsDir(dir string) error {
	u, err := user.Current()
	if err != nil {
		return err
	}
	manual := fmt.Sprintf("run: sudo mkdir -p %s && sudo chown -R %s %s", dir, u.Username, dir)
	sudo, err := exec.LookPath("sudo")
	if err != nil || !interactive() {
		return errors.New(manual)
	}
	fmt.Printf("\n%s isn't writable. Taking ownership needs administrator rights —\nyou may be prompted for your password.\n", dir)
	if err := run(sudo, "mkdir", "-p", dir); err != nil {
		return errors.New(manual)
	}
	if err := run(sudo, "chown", "-R", u.Username, dir); err != nil {
		return errors.New(manual)
	}
	return nil
}

// ensureOwnedByUser restores user ownership of dir if it ended up root-owned
// (e.g. from an earlier `sudo orbit` run), so the runner's logs and config stay
// readable/writable by the user the agent runs as. Best-effort.
func ensureOwnedByUser(dir string) {
	fi, err := os.Stat(dir)
	if err != nil {
		return
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || int(st.Uid) == os.Getuid() {
		return
	}
	u, err := user.Current()
	if err != nil {
		return
	}
	sudo, err := exec.LookPath("sudo")
	if err != nil || !interactive() {
		fmt.Printf("note: %s is owned by another user; fix with: sudo chown -R %s %s\n", dir, u.Username, dir)
		return
	}
	fmt.Printf("\n%s is owned by another user (likely a past sudo run). Restoring it to %s —\nyou may be prompted for your password.\n", dir, u.Username)
	_ = run(sudo, "chown", "-R", u.Username, dir)
}

// --- proxy-into-service support (orbit register --proxy) ---

// envVar is one service environment entry. Proxy vars are an ordered slice (not a
// map) so the generated plist/unit is deterministic.
type envVar struct{ K, V string }

// proxyServiceEnv returns the proxy env vars to bake into the runner background
// service, or nil when proxy is empty. The control-plane host (from server) plus
// localhost are added to no_proxy so the runner-to-server traffic bypasses the
// proxy; any pre-existing no_proxy is preserved.
func proxyServiceEnv(proxy, server, envNoProxy string) []envVar {
	if proxy == "" {
		return nil
	}
	parts := []string{"localhost", "127.0.0.1", "::1"}
	if h := hostOnly(server); h != "" {
		parts = append(parts, h)
	}
	if envNoProxy != "" {
		parts = append(parts, envNoProxy)
	}
	noProxy := strings.Join(parts, ",")
	return []envVar{
		{"http_proxy", proxy}, {"https_proxy", proxy},
		{"HTTP_PROXY", proxy}, {"HTTPS_PROXY", proxy},
		{"no_proxy", noProxy}, {"NO_PROXY", noProxy},
	}
}

// hostOnly extracts the bare host from a URL (http://h:port/path -> h).
func hostOnly(raw string) string {
	s := raw
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	if i := strings.IndexAny(s, ":/"); i >= 0 {
		s = s[:i]
	}
	return s
}

func systemdProxyEnv(vars []envVar) string {
	s := ""
	for _, e := range vars {
		s += fmt.Sprintf("Environment=%s=%s\n", e.K, e.V)
	}
	return s
}

func launchdProxyEnv(vars []envVar) string {
	s := ""
	for _, e := range vars {
		s += fmt.Sprintf("    <key>%s</key><string>%s</string>\n", e.K, e.V)
	}
	return s
}
