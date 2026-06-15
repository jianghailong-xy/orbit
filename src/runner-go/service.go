package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"syscall"
)

// setupService installs + starts a background service that runs `orbit run` and
// restarts on failure. Linux uses systemd; macOS uses a launchd LaunchAgent.
// Returns an error instead of exiting, so `orbit register` can call it best-effort.
// The runner authenticates through the machine's local Claude Code login, so no
// API key is involved here.
func setupService() error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot locate executable: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	orbitHome := baseDir()

	switch runtime.GOOS {
	case "linux":
		return installSystemd(exe, orbitHome)
	case "darwin":
		return installLaunchd(exe, orbitHome)
	default:
		return errors.New("background service is only supported on Linux (systemd) and macOS (launchd); run `orbit run` under your own supervisor")
	}
}

// uninstallService stops and removes the background service, for `orbit
// unregister`. Best-effort: it reports problems but never aborts the unregister.
func uninstallService() {
	switch runtime.GOOS {
	case "linux":
		if os.Geteuid() != 0 {
			fmt.Fprintln(os.Stderr, "note: removing the systemd service needs root — run: sudo systemctl disable --now orbit-runner")
			return
		}
		runQuiet("systemctl", "disable", "--now", "orbit-runner")
		_ = os.Remove("/etc/systemd/system/orbit-runner.service")
		runQuiet("systemctl", "daemon-reload")
		fmt.Println("✓ removed the systemd service")
	case "darwin":
		const label = "com.orbit.runner"
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

func installSystemd(exe, orbitHome string) error {
	unitPath := "/etc/systemd/system/orbit-runner.service"
	unit := fmt.Sprintf(`[Unit]
Description=Orbit runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%s run
Restart=always
RestartSec=5
Environment=ORBIT_HOME=%s

[Install]
WantedBy=multi-user.target
`, exe, orbitHome)

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
		if err := run("systemctl", "enable", "--now", "orbit-runner"); err != nil {
			return errors.New("systemctl enable failed — is this a systemd host?")
		}
	} else {
		sudo, err := exec.LookPath("sudo")
		if err != nil || !interactive() {
			return fmt.Errorf("installing the systemd service needs root: write %s then run `systemctl enable --now orbit-runner`", unitPath)
		}
		tmp, err := os.CreateTemp("", "orbit-runner-*.service")
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
		fmt.Println("\nInstalling the orbit-runner service needs root — you may be prompted for your password.")
		if err := run(sudo, "install", "-m", "0644", tmpPath, unitPath); err != nil {
			return fmt.Errorf("failed to install %s", unitPath)
		}
		if err := run(sudo, "systemctl", "daemon-reload"); err != nil {
			return errors.New("systemctl daemon-reload failed")
		}
		if err := run(sudo, "systemctl", "enable", "--now", "orbit-runner"); err != nil {
			return errors.New("systemctl enable failed")
		}
	}
	fmt.Printf("\n✓ orbit-runner service installed and started.\n" +
		"  Status:  systemctl status orbit-runner\n" +
		"  Logs:    journalctl -u orbit-runner -f\n")
	return nil
}

func installLaunchd(exe, orbitHome string) error {
	const label = "com.orbit.runner"
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

	fmt.Printf("\n✓ orbit-runner LaunchAgent installed and started.\n"+
		"  Plist:   %s\n"+
		"  Logs:    %s\n"+
		"  Stop:    launchctl unload %s\n", plistPath, logPath, plistPath)
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
