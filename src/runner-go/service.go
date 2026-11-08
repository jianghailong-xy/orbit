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
	"time"
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

// What `orbit register` and `orbit unregister` reach outside their own process, as vars so a
// test can drive the real paths against a temporary unit directory, a broker socket that is
// not there and an account the machine running it does not have: the unit directory the legacy
// path writes, the broker socket it asks first, this process's effective uid (root writes a
// unit itself, anyone else through sudo) and the account it runs as.
var (
	serviceUnitDir      = systemdUnitDir
	serviceBrokerSocket = hostdSocketPath
	processEUID         = os.Geteuid
	currentUser         = user.Current
)

// setupService installs + starts a background service that runs `orbit run` (with
// ORBIT_HOME=orbitHome) and restarts on failure, and returns the service it started, for
// `orbit register` to wait on. Linux uses systemd; macOS uses a launchd LaunchAgent.
// Returns an error instead of exiting, so `orbit register` can call it best-effort. The
// runner authenticates through the machine's local Claude Code login, so no API key is
// involved here.
func setupService(orbitHome string, proxyVars []envVar) (*runnerService, error) {
	// The symlink-resolved path, the file a self-update replaces: with install.sh's layout,
	// ~/.orbit/bin/orbit rather than the /usr/local/bin/orbit link to it.
	exe, err := resolvedExecutable()
	if err != nil {
		return nil, fmt.Errorf("cannot locate executable: %w", err)
	}

	switch runtime.GOOS {
	case "linux":
		return setupServiceLinux(serviceBrokerSocket, proxyVars, func() (*runnerService, error) {
			return installSystemd(exe, orbitHome, systemdService, proxyVars)
		})
	case "darwin":
		return installLaunchd(exe, orbitHome, launchdLabel, proxyVars)
	default:
		return nil, errors.New("background service is only supported on Linux (systemd) and macOS (launchd); run `orbit run` under your own supervisor")
	}
}

// setupServiceLinux installs the runner service the best way this host allows. With
// `orbit host setup` done, that is the machine broker: enabling this user's instance is
// a socket call that needs no root at all. Anything else — no broker, or a broker that
// will not answer — installs a unit of our own through sudo, so a host that was never
// set up (or was set up badly) still ends a registration with a live runner. Except the
// answers in hostdStopsRegister (hostdRegisterRefusal): this account has no copy of its
// own for its instance to run, an older runner unit of the account could not be taken
// down, or the broker took the request and is still working on it. Each ends the
// registration's service step with the broker's reason, since the sudo path's unit would
// be a second runner.
func setupServiceLinux(socketPath string, proxyVars []envVar, installLegacy func() (*runnerService, error)) (*runnerService, error) {
	unit, err := registerViaHostd(socketPath, proxyVars)
	switch {
	case err != nil:
		return nil, err
	case unit != "":
		return &runnerService{unit: unit, how: "runs at boot"}, nil
	}
	return installLegacy()
}

// uninstallService stops and removes the machine's runner service, for
// `orbit unregister`. Best-effort: it reports problems but never aborts.
func uninstallService() {
	switch runtime.GOOS {
	case "linux":
		uninstallServiceLinux(serviceBrokerSocket, uninstallSystemd)
	case "darwin":
		home := os.Getenv("HOME")
		if home == "" {
			if h, err := os.UserHomeDir(); err == nil {
				home = h
			}
		}
		uninstallLaunchd(home, launchdLabel)
	}
}

// uninstallLaunchd takes the agent down from the domain its plist put it in and removes the plist.
func uninstallLaunchd(home, label string) {
	plistPath := filepath.Join(home, "Library", "LaunchAgents", label+".plist")
	installed, _ := os.ReadFile(plistPath)
	bootoutLaunchd(launchdDomain(string(installed), launchdUID()), label)
	if err := os.Remove(plistPath); err != nil {
		if os.IsNotExist(err) {
			return
		}
		fmt.Fprintf(os.Stderr, "note: could not remove %s (%v)\n  remove it with: sudo rm %s\n", plistPath, err, plistPath)
		return
	}
	fmt.Println("✓ removed the LaunchAgent")
}

// uninstallServiceLinux is setupServiceLinux's counterpart: ask the broker to take this
// user's instance down, and only reach for sudo when it cannot.
func uninstallServiceLinux(socketPath string, removeLegacy func()) {
	if unregisterViaHostd(socketPath) {
		return
	}
	removeLegacy()
}

// uninstallSystemd is the pre-broker removal path: it needs root, because the unit it is
// removing is one `orbit register` wrote into /etc/systemd/system. Anyone else goes through
// sudo, as register did to write it.
func uninstallSystemd() {
	// Remove this OS user's per-user unit (orbit-runner-<user>); fall back to the
	// bare legacy name if the user can't be resolved.
	svc, username := systemdService, ""
	if u, err := registeringUser(); err == nil {
		username = u.Username
		svc = systemdServiceFor(username)
	}
	// Also a leftover legacy single-runner unit, but only if it's this user's.
	legacy := svc != systemdService && unitRunsAsUser(systemdService, username)
	if processEUID() != 0 {
		removeUnitsThroughSudo(svc, username, legacy)
		return
	}
	runQuiet("systemctl", "disable", "--now", svc)
	_ = os.Remove(filepath.Join(serviceUnitDir, svc+".service"))
	if legacy {
		runQuiet("systemctl", "disable", "--now", systemdService)
		_ = os.Remove(filepath.Join(serviceUnitDir, systemdService+".service"))
	}
	runQuiet("systemctl", "daemon-reload")
	fmt.Printf("✓ removed the %s service\n", svc)
}

// removeUnitsThroughSudo is uninstallSystemd for an account: it asks root for nothing when the account has
// no unit (--no-service, or one already gone), and says it removed a unit only when sudo did. With a unit,
// both steps are tried whatever became of the other: a systemctl that cannot reach systemd still leaves a
// file to take away.
func removeUnitsThroughSudo(svc, username string, legacy bool) {
	var units []string
	if fileExists(filepath.Join(serviceUnitDir, svc+".service")) {
		units = append(units, svc)
	}
	if legacy {
		units = append(units, systemdService)
	}
	if len(units) == 0 {
		// On a set-up host the runner is an instance of the machine's template, which only the broker
		// takes down without root, and it did not (uninstallServiceLinux brought this here).
		if template := (hostdSystem{unitDir: serviceUnitDir}); fileExists(filepath.Join(serviceUnitDir, filepath.Base(hostRunnerTemplatePath))) {
			instance := unitForUid(uint32(os.Getuid()))
			if template.namesInstances() {
				instance = unitForAccount(username)
			}
			fmt.Fprintf(os.Stderr, "note: the machine broker did not take down this account's runner — run: sudo systemctl disable --now %s\n", instance)
		}
		return
	}
	sudo, err := exec.LookPath("sudo")
	if err != nil || !sudoUsable(sudo) {
		fmt.Fprintf(os.Stderr, "note: removing the systemd service needs root — run: sudo systemctl disable --now %s\n", strings.Join(units, " "))
		return
	}
	if interactive() {
		fmt.Printf("\nRemoving the %s service needs root — you may be prompted for your password.\n", units[0])
	}
	for _, unit := range units {
		path := filepath.Join(serviceUnitDir, unit+".service")
		disabled := run(sudo, "systemctl", "disable", "--now", unit) == nil
		removed := run(sudo, "rm", "-f", path) == nil
		if disabled && removed {
			fmt.Printf("✓ removed the %s service\n", unit)
		} else {
			fmt.Fprintf(os.Stderr, "note: could not remove the %s service — run: sudo systemctl disable --now %s && sudo rm -f %s\n", unit, unit, path)
		}
	}
	_ = run(sudo, "systemctl", "daemon-reload")
}

// sudoUsable reports whether this process can get root through sudo: at a terminal sudo can
// ask for a password, and without one it must need none, which `sudo -n true` finds out by
// running nothing.
func sudoUsable(sudo string) bool {
	return interactive() || exec.Command(sudo, "-n", "true").Run() == nil
}

func installSystemd(exe, orbitHome, svc string, proxyVars []envVar) (*runnerService, error) {
	// The runner — and the `claude` processes it spawns — should operate as the
	// user who ran `orbit register`, not root, so files and git ops are owned by
	// that user and claude reads that user's ~/.claude login.
	u, err := registeringUser()
	if err != nil {
		return nil, fmt.Errorf("cannot determine the user to run the service as: %w", err)
	}
	grp := primaryGroup(u)

	// One runner per OS user, not per machine: name the unit after the user so two
	// users on one host run independent services instead of overwriting a single
	// system-wide unit. `svc` (the bare "orbit-runner") is the legacy pre-naming name,
	// kept only to migrate an older single-runner install below.
	legacySvc := svc
	svc = systemdServiceFor(u.Username)
	unitPath := filepath.Join(serviceUnitDir, svc+".service")

	// systemd gives services a minimal PATH and does not source the user's shell,
	// so coding CLIs installed below the user's home aren't found. Bake in the
	// user's login PATH at install time, mirroring the launchd path, plus the
	// private bin dirs the official Claude/Kimi/OpenCode installers write to.
	pathEnv := runnerEnginePath(u.HomeDir, userLoginPath(u, os.Getenv("PATH")))

	// Writing the unit + enabling it needs root. When we aren't root, run the install
	// step and every systemctl call via sudo (prompts once at a terminal; without one,
	// only a sudo that needs no password will do) so `orbit register` ends with a live
	// service without a separate command.
	root := processEUID() == 0
	var sudo string
	if !root {
		s, err := exec.LookPath("sudo")
		if err != nil {
			return nil, fmt.Errorf("installing the systemd service needs root: write %s then run `systemctl enable %s && systemctl restart %s`", unitPath, svc, svc)
		}
		if !sudoUsable(s) {
			return nil, fmt.Errorf("installing the systemd service needs root, and %s has no sudo that works without a terminal: run this at a terminal, give %s sudo that needs no password, or write %s then run `systemctl enable %s && systemctl restart %s`", u.Username, u.Username, unitPath, svc, svc)
		}
		sudo = s
		if interactive() {
			fmt.Printf("\nInstalling the %s service needs root — you may be prompted for your password.\n", svc)
		}
	}
	// systemctl, as root directly or via sudo.
	sctl := func(args ...string) error {
		if root {
			return run("systemctl", args...)
		}
		return run(sudo, append([]string{"systemctl"}, args...)...)
	}

	// The unit runs the copy in the user's ~/.orbit/bin — moved there first if it still sits
	// in root's /usr/local/bin — so the runner can replace it when it updates itself.
	exe = adoptUserBin(exe, u, systemdServicesRunning(serviceUnitDir, exe), root, sudo)
	unit := renderSystemdUnit(u.Username, grp, exe, u.HomeDir, orbitHome, pathEnv, proxyVars)

	// Write the unit file (root writes it directly; non-root installs it via sudo).
	if root {
		if err := os.WriteFile(unitPath, []byte(unit), 0o644); err != nil {
			return nil, fmt.Errorf("failed to write %s: %w", unitPath, err)
		}
	} else {
		tmp, err := os.CreateTemp("", svc+"-*.service")
		if err != nil {
			return nil, err
		}
		tmpPath := tmp.Name()
		defer os.Remove(tmpPath)
		if _, err := tmp.WriteString(unit); err != nil {
			tmp.Close()
			return nil, err
		}
		tmp.Close()
		if err := run(sudo, "install", "-m", "0644", tmpPath, unitPath); err != nil {
			return nil, fmt.Errorf("failed to install %s", unitPath)
		}
	}

	// Migrate a pre-naming install: older orbit used a single `orbit-runner` unit. If
	// it's this same user's, stop + remove it so we don't double-run (the old one would
	// 401 forever on its now-rotated token). A legacy unit owned by a different user is
	// that user's runner — leave it.
	migrateLegacyUnit(sctl, root, sudo, legacySvc, svc, u.Username)

	if err := sctl("daemon-reload"); err != nil {
		return nil, errors.New("systemctl daemon-reload failed — is this a systemd host?")
	}
	if err := sctl("enable", svc); err != nil {
		return nil, errors.New("systemctl enable failed — is this a systemd host?")
	}
	// restart, not just start: a re-register rewrites config.json with a freshly issued
	// credential, but `enable --now`/`start` is a no-op on an already-running unit — the
	// live runner would keep its stale in-memory token and 401 until restarted. restart
	// starts a stopped unit and replaces a running one.
	if err := sctl("restart", svc); err != nil {
		return nil, errors.New("systemctl restart failed — is this a systemd host?")
	}
	return &runnerService{unit: svc + ".service", how: "runs at boot"}, nil
}

// renderSystemdUnit is the per-user runner unit installSystemd writes: exe run as username,
// with the account's home, the runner's state dir and its login PATH baked in.
func renderSystemdUnit(username, group, exe, home, orbitHome, pathEnv string, proxyVars []envVar) string {
	return fmt.Sprintf(`[Unit]
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
`, username, username, group, exe, home, orbitHome, pathEnv, systemdProxyEnv(proxyVars))
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
	legacyPath := filepath.Join(serviceUnitDir, legacySvc+".service")
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
	return unitRunsAsUserIn(serviceUnitDir, execStdout, svc, username)
}

// unitRunsAsUserIn is unitRunsAsUser with its two touchpoints — where unit files live and
// how a command is run — passed in, so hostd can apply the identical rule against an
// injected systemctl and a temporary directory. One implementation, not two: both callers
// decide the same thing about the same units, and a second copy would drift. users are
// the User= values that make the unit this account's: its name and, from hostd on a host
// whose instances are named after accounts, its uid in digits, which systemd reads as the
// same account. An empty one never matches.
func unitRunsAsUserIn(unitDir string, stdout func(string, ...string) (string, error), svc string, users ...string) bool {
	named := false
	for _, u := range users {
		named = named || u != ""
	}
	if !named {
		return false
	}
	if _, err := os.Stat(filepath.Join(unitDir, svc+".service")); err != nil {
		return false
	}
	out, _ := stdout("systemctl", "show", svc+".service", "-p", "User", "--value")
	got := strings.TrimSpace(out)
	for _, u := range users {
		if u != "" && got == u {
			return true
		}
	}
	return false
}

// execStdout runs a command and returns its standard output alone. Values read back out
// of `systemctl show -p X --value` are compared verbatim, so stderr folded into the same
// string would corrupt the comparison.
func execStdout(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).Output()
	return string(out), err
}

// registeringUser is the account the runner service should run as: the human who
// ran `orbit register`. When sudo made this process root that's $SUDO_USER (sudoAccount);
// otherwise the current user, `sudo -u svc` included: there $SUDO_USER is whoever typed it,
// and the command and its config are svc's.
func registeringUser() (*user.User, error) {
	if u, ok := sudoAccount(); ok {
		return u, nil
	}
	return currentUser()
}

// primaryGroup resolves a user's primary group name, falling back to its number, which
// systemd takes as well: a release build reads /etc/group alone, where an LDAP account's
// group is not. With neither, the username (the common user-private-group convention).
func primaryGroup(u *user.User) string {
	if g, err := user.LookupGroupId(u.Gid); err == nil {
		return g.Name
	}
	if u.Gid != "" {
		return u.Gid
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
//
// Orbit's own ripgrep directory goes at the other end, last (pathWithManagedRgLast), so
// an rg anywhere else on the PATH is found before it.
func runnerEnginePath(home, path string) string {
	for _, dir := range engineInstallerDirs(home) {
		if !pathContains(path, dir) {
			path = dir + ":" + path
		}
	}
	return pathWithManagedRgLast(path)
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

func installLaunchd(exe, orbitHome, label string, proxyVars []envVar) (*runnerService, error) {
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

	// The agent runs the copy in the user's ~/.orbit/bin — moved there first if it still sits
	// in root's /usr/local/bin — so the runner can replace it when it updates itself.
	if u, err := registeringUser(); err == nil {
		sudo := ""
		if s, err := exec.LookPath("sudo"); err == nil && interactive() {
			sudo = s
		}
		exe = adoptUserBin(exe, u, nil, processEUID() == 0, sudo)
	}

	// launchd starts agents with a minimal PATH and no HOME, so the `claude` CLI
	// the runner shells out to isn't found (and couldn't locate ~/.claude even if
	// it were). Bake in the install-time PATH — where `claude` lives in this shell
	// — plus HOME, so the background agent sees the same tools the user does.
	pathEnv := os.Getenv("PATH")
	if pathEnv == "" {
		pathEnv = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
	}
	pathEnv = runnerEnginePath(home, pathEnv)

	uid := launchdUID()
	background := launchdNeedsBackground(uid)
	// Read before it is replaced: it says where the agent it describes was loaded.
	installed, _ := os.ReadFile(plistPath)
	plist := renderLaunchdPlist(exe, orbitHome, label, home, pathEnv, logPath, background, proxyVars)

	agentsDir := filepath.Dir(plistPath)
	if err := writePlist(agentsDir, plistPath, plist); err != nil {
		if !os.IsPermission(err) {
			return nil, err
		}
		// Managed Macs often ship a root-owned ~/Library/LaunchAgents. Hand it back
		// to this user with sudo, then retry — the agent must load in the user's own
		// session to keep the login-Keychain access Claude Code's login relies on.
		if rerr := repairAgentsDir(agentsDir); rerr != nil {
			return nil, fmt.Errorf("failed to write %s: %w", plistPath, rerr)
		}
		if err := writePlist(agentsDir, plistPath, plist); err != nil {
			return nil, fmt.Errorf("failed to write %s: %w", plistPath, err)
		}
	}
	// What the runner logs from here on is this start's (runnerService.logFrom). Noted as each bootstrap
	// is asked for, so that what counts is the one that succeeds: the runner this one replaces goes on
	// logging its drain after bootout has returned, and has stopped by then.
	var logFrom int64
	noteLogEnd := func() {
		if fi, err := os.Stat(logPath); err == nil {
			logFrom = fi.Size()
		}
	}
	if err := startLaunchd(launchdDomain(string(installed), uid), launchdDomain(plist, uid), plistPath, label, noteLogEnd); err != nil {
		return nil, err
	}
	svc := &runnerService{label: label, logPath: logPath, logFrom: logFrom, how: "starts at login"}
	if background {
		svc.how = launchdBackgroundHow
		svc.notes = []string{
			"After a restart, start it again over SSH: launchctl bootstrap " + launchdDomain(plist, uid) + " " + plistPath,
			launchdKeychainNote,
		}
	}
	return svc, nil
}

// launchdSessionKey limits a LaunchAgent to one session type. An agent with no such key is an Aqua
// one, which loads only into the desktop session of an account logged in at the Mac's screen. Over
// SSH, an account with no desktop session has only its Background session.
const launchdSessionKey = "<key>LimitLoadToSessionType</key>"

// How register describes a Background agent. Nothing starts one by itself: launchd loads the account's
// agents for a desktop login, and an SSH login that brings the Background session up loads none of them.
// Nor can that session read the login Keychain, whoever unlocked it: a shell's unlocking stays in that
// shell. Claude Code then keeps a login in its credentials file, which the session reads like any other
// file, but a login made at the desktop stays in the Keychain and reads as signed out.
const (
	launchdBackgroundHow = "runs until this Mac restarts"
	launchdKeychainNote  = "It cannot read this account's login Keychain: a Claude login kept there shows as signed out until you sign in again from Orbit."
)

// launchdUID is the account whose agent this process installs or removes: the one it runs as. Under
// sudo, register and unregister are handed to the account first (handOffUnderSudo), and what stays
// root is about root's own runner.
func launchdUID() string {
	if u, err := currentUser(); err == nil && u.Uid != "" {
		return u.Uid
	}
	return strconv.Itoa(os.Getuid())
}

// launchdNeedsBackground reports whether the account has no desktop session for an Aqua agent to
// load into. launchd is asked about the account rather than about this shell: `launchctl managername`
// says Background in any SSH shell, also on an account that is at its desktop too, and that one has
// its login Keychain only in an Aqua agent. Root's agent loads into the system domain, which has no
// sessions.
func launchdNeedsBackground(uid string) bool {
	if uid == "0" {
		return false
	}
	_, err := serviceQuery("launchctl", "print", "gui/"+uid)
	return err != nil
}

// launchdDomain is where the agent plist describes belongs. The plist is the record of that: root
// restarts agents on an upgrade, where no shell of the account's is there to ask, and a plist that
// names no session is what every install before this one wrote.
func launchdDomain(plist, uid string) string {
	switch {
	case uid == "0":
		return "system"
	case plistSessionType(plist) == "Background":
		return "user/" + uid
	}
	return "gui/" + uid
}

// plistSessionType is the session type a plist limits its agent to, or nothing when it does not.
func plistSessionType(plist string) string {
	_, rest, ok := strings.Cut(plist, launchdSessionKey)
	if !ok {
		return ""
	}
	_, rest, ok = strings.Cut(rest, "<string>")
	if !ok {
		return ""
	}
	session, _, _ := strings.Cut(rest, "</string>")
	return session
}

// bootoutLaunchd removes the agent an earlier registration, or the macOS app, loaded in domain, and
// reports whether there was one.
func bootoutLaunchd(domain, label string) bool {
	_, err := runCapture("launchctl", "bootout", domain+"/"+label)
	return err == nil
}

// How long startLaunchd goes on past a bootstrap launchd refuses for a job still there. bootout
// returns at once, while the old runner drains, and bootstrap fails until it has exited: for up to
// launchdDrainTries when bootout removed a job, the 180 s ExitTimeOut an older register wrote and a
// margin, though launchd may stop it sooner (at 60 s on macOS 26 and 27.2). With nothing removed there is
// no such wait to sit through, and launchd says the same words for an agent it will never load. Vars so a
// test need not sit through them.
var (
	launchdBootstrapTries = 3
	launchdDrainTries     = 190
	launchdBootstrapPause = time.Second
)

// startLaunchd moves the agent from oldDomain, where the plist replaced by this install put it, to
// domain. `launchctl load` is no way to do it: it lands wherever launchctl runs, and on an account with
// no desktop session it aborts having loaded nothing. A refusal is reported in launchd's own words, the
// only thing that says why. beforeBootstrap runs right before each try.
func startLaunchd(oldDomain, domain, plistPath, label string, beforeBootstrap func()) error {
	tries := launchdBootstrapTries
	if bootoutLaunchd(oldDomain, label) {
		tries = launchdDrainTries
	}
	// `load -w` cleared a disabled mark; bootstrap refuses a disabled job.
	runQuiet("launchctl", "enable", domain+"/"+label)

	var out string
	var err error
	for attempt := 0; attempt < tries; attempt++ {
		beforeBootstrap()
		if out, err = runCapture("launchctl", "bootstrap", domain, plistPath); err == nil {
			return nil
		}
		if !launchdBootstrapRetry(out) {
			break
		}
		if attempt == 0 && tries == launchdDrainTries {
			fmt.Println("    Waiting for the runner already here to stop…")
		}
		if attempt+1 < tries {
			time.Sleep(launchdBootstrapPause)
		}
	}
	msg := "launchctl bootstrap " + domain + " failed"
	if out != "" {
		return errors.New(msg + ": " + firstLine(out))
	}
	return fmt.Errorf("%s (%w)", msg, err)
}

// launchdBootstrapRetry is whether launchd's refusal is the one a job still there produces. A
// malformed plist or a domain that does not exist says the same thing on every try.
func launchdBootstrapRetry(out string) bool {
	for _, transient := range []string{"Input/output error", "Operation already in progress", "already bootstrapped"} {
		if strings.Contains(out, transient) {
			return true
		}
	}
	return false
}

// printServiceStarted is the one success line every service path ends with, once the
// control plane has heard from the runner it started, so `orbit register` reads the same
// whatever started it.
func printServiceStarted(how string) {
	user := "this account"
	if u, err := registeringUser(); err == nil {
		user = u.Username
	}
	fmt.Printf("    ✓ Background service started as %s (%s).\n"+
		"      Stop or remove it later with `orbit unregister`.\n", user, how)
}

// launchdExitTimeOutSeconds is the plist's ExitTimeOut: what launchd gives the runner between SIGTERM and
// SIGKILL when launchd is what stops it. Measured 2026-11-03 with a job that takes 100 s to leave after
// SIGTERM, on macOS 26.6.2 and 15.8.2 (GitHub's runners) and 27.2 (a real Mac):
//   - macOS 26 and 27 cap the key at 60: `launchctl print` reads `exit timeout = 60` for 61 and for
//     2147483647, and launchd kills the job then. On macOS 26 the cap is the same for an Aqua agent in
//     gui/<uid>, a Background one in user/<uid> (the one kind tried on 27.2), a daemon in system, with or
//     without UserName, and an agent an app registers through SMAppService. ProcessType and every other key
//     tried leave it alone, MaxExitTimeOut
//     among them. launchd's own strings also name a boot argument, launch_max_exit_timeout, not tried: it is
//     the machine owner's to set and not the runner's. macOS 15 honours any value.
//   - Every macOS: with no key the window is 5 s, and 0, which launchd.plist(5) calls infinity, kills the
//     job at once with no SIGTERM. So does EnableTransactions.
//   - The clock runs only for launchd's own stop: bootout, kickstart -k, stop, remove, unload. A SIGTERM from
//     anybody else (kill, launchctl kill) starts none, and KeepAlive restarts the job when it leaves, even a
//     job `launchctl disable` has disabled. A bootout after such a SIGTERM starts the 60 s from the bootout.
//   - bootout with a service target returns at once. bootout with a plist path, kickstart -k and unload wait
//     for the job to be gone.
//   - A job killed at the limit leaves behind what runs in a process group of its own, as every engine and
//     every check does (configureSessionProcessTree), so a runner that is killed orphans them.
//
// So every Mac is asked for the same 60 s, which every macOS measured gives, and the runner's whole stop
// stays inside it (THE BUDGETS, shutdown_drain.go). Signalling the runner first would buy time only on the
// paths Orbit runs itself: launchd's own stops, a logout or a shutdown among them by launchd.plist(5), would
// still be held to this, and the runner cannot tell one SIGTERM from another.
const launchdExitTimeOutSeconds = 60

func renderLaunchdPlist(exe, orbitHome, label, home, pathEnv, logPath string, background bool, proxyVars []envVar) string {
	session := ""
	if background {
		session = "  " + launchdSessionKey + "<string>Background</string>\n"
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>%s</string>
%s  <key>ProgramArguments</key>
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
  <!-- launchd's SIGTERM-to-SIGKILL window. macOS 26 and later read anything above 60 as 60, and a
       plist with no key gets 5 s. The runner's whole stop stays inside this. -->
  <key>ExitTimeOut</key><integer>%d</integer>
  <key>StandardOutPath</key><string>%s</string>
  <key>StandardErrorPath</key><string>%s</string>
</dict>
</plist>
`, label, session, exe, orbitHome, home, pathEnv, launchdProxyEnv(proxyVars), launchdExitTimeOutSeconds, logPath, logPath)
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

// runCapture is run for a command whose refusal has to be reported: launchctl's own sentence is
// the only thing that says why a LaunchAgent would not load, so it cannot be discarded.
var runCapture = func(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
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
