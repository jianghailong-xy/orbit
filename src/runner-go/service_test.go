package main

import (
	"errors"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
)

func TestSystemdServiceFor(t *testing.T) {
	cases := []struct{ user, want string }{
		{"husong", "orbit-runner-husong"},
		{"alice_2", "orbit-runner-alice_2"},
		{"web-svc", "orbit-runner-web-svc"},
		// Characters not allowed in a systemd unit name are mapped to '_'.
		{"foo.bar", "orbit-runner-foo_bar"},
		{"a/b c", "orbit-runner-a_b_c"},
	}
	for _, c := range cases {
		if got := systemdServiceFor(c.user); got != c.want {
			t.Errorf("systemdServiceFor(%q) = %q, want %q", c.user, got, c.want)
		}
	}
	// Distinct users must yield distinct unit names — the whole point of per-user units.
	if systemdServiceFor("alice") == systemdServiceFor("bob") {
		t.Fatal("different users produced the same unit name")
	}
}

func TestLaunchdPlistAllowsCompleteGracefulShutdown(t *testing.T) {
	plist := renderLaunchdPlist(
		"/usr/local/bin/orbit",
		"/Users/test/.orbit",
		launchdLabel,
		"/Users/test",
		"/usr/local/bin:/usr/bin:/bin",
		"/Users/test/.orbit/runner.log",
		nil,
	)
	if !strings.Contains(plist, "<key>ExitTimeOut</key><integer>180</integer>") {
		t.Fatal("LaunchAgent plist does not preserve the runner's graceful-shutdown envelope")
	}
}

// recordLaunchctl stands in for the two command seams startLaunchd uses: the best-effort
// pre-unload/enable calls are recorded, and every bootstrap answers with out/err.
func recordLaunchctl(t *testing.T, out string, err error) (*[]string, *[]string) {
	t.Helper()
	var quiet, captured []string
	prevQuiet, prevCapture := runQuiet, runCapture
	runQuiet = func(name string, args ...string) {
		quiet = append(quiet, strings.TrimSpace(name+" "+strings.Join(args, " ")))
	}
	runCapture = func(name string, args ...string) (string, error) {
		captured = append(captured, strings.TrimSpace(name+" "+strings.Join(args, " ")))
		return out, err
	}
	t.Cleanup(func() { runQuiet, runCapture = prevQuiet, prevCapture })
	return &quiet, &captured
}

// A LaunchAgent belongs to a GUI session, not to whatever bootstrap namespace an SSH command
// happens to run in: the installer must name the account's domain explicitly, and remove an old
// registration before loading the new one.
func TestStartLaunchdUsesTheUsersGUIDomain(t *testing.T) {
	quiet, captured := recordLaunchctl(t, "", nil)
	const plist = "/Users/austin/Library/LaunchAgents/com.orbit.runner.plist"
	if err := startLaunchd("gui/501", plist, launchdLabel); err != nil {
		t.Fatal(err)
	}
	assertCommands(t, *quiet,
		"launchctl bootout gui/501 "+plist,
		"launchctl bootout gui/501/"+launchdLabel,
		"launchctl unload "+plist,
		"launchctl enable gui/501/"+launchdLabel,
	)
	assertCommands(t, *captured, "launchctl bootstrap gui/501 "+plist)
}

// launchctl's refusal is the only thing that says why the LaunchAgent would not load; the
// installer must carry it into the error instead of replacing it with "load failed".
func TestStartLaunchdReportsLaunchctlsOwnRefusal(t *testing.T) {
	const detail = "Bootstrap failed: 125: Domain does not support specified action"
	_, captured := recordLaunchctl(t, detail, errors.New("exit status 1"))
	err := startLaunchd("gui/501", "/Users/austin/Library/LaunchAgents/com.orbit.runner.plist", launchdLabel)
	if err == nil || !strings.Contains(err.Error(), detail) {
		t.Fatalf("startLaunchd error = %v, want launchctl's %q", err, detail)
	}
	if !strings.Contains(err.Error(), "no GUI login session") {
		t.Fatalf("startLaunchd error = %v, want the headless explanation", err)
	}
	if len(*captured) != 1 {
		t.Fatalf("bootstrap calls = %d, want 1 for a refusal waiting cannot change", len(*captured))
	}
}

// bootout can return while the old runner is still draining; bootstrap refuses until it has
// exited. Those refusals are retried, and the last one is reported if they never stop.
func TestStartLaunchdWaitsForTheOldJobToDrain(t *testing.T) {
	prevTries, prevPause := launchdBootstrapTries, launchdBootstrapPause
	launchdBootstrapTries, launchdBootstrapPause = 2, 0
	t.Cleanup(func() { launchdBootstrapTries, launchdBootstrapPause = prevTries, prevPause })

	const detail = "Bootstrap failed: 5: Input/output error"
	_, captured := recordLaunchctl(t, detail, errors.New("exit status 1"))
	err := startLaunchd("gui/501", "/Users/austin/Library/LaunchAgents/com.orbit.runner.plist", launchdLabel)
	if err == nil || !strings.Contains(err.Error(), detail) {
		t.Fatalf("startLaunchd error = %v, want %q", err, detail)
	}
	if len(*captured) != 2 {
		t.Fatalf("bootstrap calls = %d, want 2 retries", len(*captured))
	}
}

// The installer must bootstrap the account that registered, not root's domain when register was
// handed off from sudo, and must not fall back to the legacy `load -w` path.
func TestInstallLaunchdUsesTheRegisteringUsersDomain(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SUDO_USER", "")
	orbitHome := filepath.Join(home, ".orbit")
	if err := os.MkdirAll(filepath.Join(orbitHome, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(orbitHome, "bin", "orbit")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	prevUser, prevRoot, prevRun := currentUser, rootOwnedDir, run
	currentUser = func() (*user.User, error) {
		return &user.User{Username: "austin", Uid: "501", Gid: "20", HomeDir: home}, nil
	}
	rootOwnedDir = func(string) bool { return false }
	run = func(name string, args ...string) error {
		t.Fatalf("installLaunchd used the legacy launchctl path: %s %s", name, strings.Join(args, " "))
		return nil
	}
	t.Cleanup(func() {
		currentUser, rootOwnedDir, run = prevUser, prevRoot, prevRun
	})

	quiet, captured := recordLaunchctl(t, "", nil)
	if _, err := installLaunchd(exe, orbitHome, launchdLabel, nil); err != nil {
		t.Fatal(err)
	}
	plist := filepath.Join(home, "Library", "LaunchAgents", launchdLabel+".plist")
	assertCommands(t, *quiet,
		"launchctl bootout gui/501 "+plist,
		"launchctl bootout gui/501/"+launchdLabel,
		"launchctl unload "+plist,
		"launchctl enable gui/501/"+launchdLabel,
	)
	assertCommands(t, *captured, "launchctl bootstrap gui/501 "+plist)
}
