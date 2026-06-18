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
)

// setupService installs + starts a background service that runs `orbit run` (with
// ORBIT_HOME=orbitHome) and restarts on failure. Linux uses systemd; macOS uses a
// launchd LaunchAgent. Returns an error instead of exiting, so `orbit register` can
// call it best-effort. The runner authenticates through the machine's local Claude
// Code login, so no API key is involved here.
func setupService(orbitHome string) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot locate executable: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}

	switch runtime.GOOS {
	case "linux":
		return installSystemd(exe, orbitHome, systemdService)
	case "darwin":
		return installLaunchd(exe, orbitHome, launchdLabel)
	default:
		return errors.New("background service is only supported on Linux (systemd) and macOS (launchd); run `orbit run` under your own supervisor")
	}
}

// uninstallService stops and removes the machine's runner service, for
// `orbit unregister`. Best-effort: it reports problems but never aborts.
func uninstallService() {
	switch runtime.GOOS {
	case "linux":
		svc := systemdService
		if os.Geteuid() != 0 {
			fmt.Fprintf(os.Stderr, "note: removing the systemd service needs root — run: sudo systemctl disable --now %s\n", svc)
			return
		}
		runQuiet("systemctl", "disable", "--now", svc)
		_ = os.Remove("/etc/systemd/system/" + svc + ".service")
		runQuiet("systemctl", "daemon-reload")
		fmt.Printf("✓ removed the %s service\n", svc)
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

func installSystemd(exe, orbitHome, svc string) error {
	unitPath := "/etc/systemd/system/" + svc + ".service"

	// The runner — and the `claude` processes it spawns — should operate as the
	// user who ran `orbit register`, not root, so files and git ops are owned by
	// that user and claude reads that user's ~/.claude login.
	u, err := registeringUser()
	if err != nil {
		return fmt.Errorf("cannot determine the user to run the service as: %w", err)
	}
	grp := primaryGroup(u)

	// systemd gives services a minimal PATH and does not source the user's shell,
	// so the `claude` CLI (installed in ~/.local/bin) isn't found. Bake in the
	// user's login PATH at install time, mirroring the launchd path; ensure
	// ~/.local/bin is on it since that's where the official installer puts claude.
	pathEnv := userLoginPath(u, os.Getenv("PATH"))
	localBin := filepath.Join(u.HomeDir, ".local", "bin")
	if !pathContains(pathEnv, localBin) {
		pathEnv = localBin + ":" + pathEnv
	}

	unit := fmt.Sprintf(`[Unit]
Description=Orbit runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=%s
Group=%s
ExecStart=%s run
Restart=always
RestartSec=5
Environment=HOME=%s
Environment=ORBIT_HOME=%s
Environment=PATH=%s

[Install]
WantedBy=multi-user.target
`, u.Username, grp, exe, u.HomeDir, orbitHome, pathEnv)

	// Writing the unit + enabling it needs root. When we aren't root, do just
	// those steps via sudo (prompts once) so `orbit register` ends with a live
	// service without a separate command.
	if os.Geteuid() == 0 {
		if err := os.WriteFile(unitPath, []byte(unit), 0o644); err != nil {
			return fmt.Errorf("failed to write %s: %w", unitPath, err)
		}
		if err := run("systemctl", "daemon-reload"); err != nil {
			return errors.New("systemctl daemon-reload failed — is this a systemd host?")
		}
		if err := run("systemctl", "enable", "--now", svc); err != nil {
			return errors.New("systemctl enable failed — is this a systemd host?")
		}
		// Dropping privileges to another user: hand them the runner's config + run
		// scratch so the service (now that user) can read/write them.
		if u.Uid != "0" {
			_ = run("chown", "-R", u.Username+":"+grp, orbitHome)
		}
	} else {
		sudo, err := exec.LookPath("sudo")
		if err != nil || !interactive() {
			return fmt.Errorf("installing the systemd service needs root: write %s then run `systemctl enable --now %s`", unitPath, svc)
		}
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
		fmt.Printf("\nInstalling the %s service needs root — you may be prompted for your password.\n", svc)
		if err := run(sudo, "install", "-m", "0644", tmpPath, unitPath); err != nil {
			return fmt.Errorf("failed to install %s", unitPath)
		}
		if err := run(sudo, "systemctl", "daemon-reload"); err != nil {
			return errors.New("systemctl daemon-reload failed")
		}
		if err := run(sudo, "systemctl", "enable", "--now", svc); err != nil {
			return errors.New("systemctl enable failed")
		}
	}
	fmt.Printf("\n✓ %s service installed and started as user %q.\n"+
		"  Status:  systemctl status %s\n"+
		"  Logs:    journalctl -u %s -f\n", svc, u.Username, svc, svc)
	return nil
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
		return "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
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

func installLaunchd(exe, orbitHome, label string) error {
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

	plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
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
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>%s</string>
  <key>StandardErrorPath</key><string>%s</string>
</dict>
</plist>
`, label, exe, orbitHome, home, pathEnv, logPath, logPath)

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

func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// runQuiet runs a best-effort command, discarding its output and result — for
// steps like a pre-unload that legitimately fail (and complain) when there's
// nothing to undo.
func runQuiet(name string, args ...string) {
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
