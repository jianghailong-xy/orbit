package main

import (
	"errors"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// register's service step past the hand-off, on the host register_sudo_linux_test.go pretends
// (pretendRegisterHost): what it reports when the runner it started never comes online, and how
// unregister takes an account's runner down again.
// The failure the incident needed register to report, through register's own service step: the unit
// is installed and started, exits at every start and is restarted, and the control plane never hears
// from it. register says so, with the runner's own last words and where to look, and does not say the
// service started.
func TestRegisterReportsAServiceThatNeverCameOnline(t *testing.T) {
	accountHome := t.TempDir()
	account := &user.User{Uid: "4242", Gid: "4242", Username: "c2b", Name: "c2b", HomeDir: accountHome}
	cp := newRegisterStub(t)
	unitDir := pretendRegisterHost(t, func() {}) // started, and never heard from
	t.Setenv("HOME", accountHome)
	t.Setenv("SUDO_USER", "")
	prevEUID, prevCurrent, prevPoll := processEUID, currentUser, onlinePoll
	t.Cleanup(func() { processEUID, currentUser, onlinePoll = prevEUID, prevCurrent, prevPoll })
	processEUID = func() int { return 4242 }
	currentUser = func() (*user.User, error) { return account, nil }
	onlinePoll = 10 * time.Millisecond

	shows := 0
	answerServiceQueries(t, func(cmd string) (string, error) {
		switch {
		case strings.HasPrefix(cmd, "systemctl show orbit-runner-c2b.service "):
			shows++
			if shows == 1 { // read as the service starts: the restarts before this one
				return "LoadState=loaded\nActiveState=active\nSubState=running\nNRestarts=5\nExecMainCode=0\nExecMainStatus=0\n", nil
			}
			return "LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nNRestarts=7\nExecMainCode=1\nExecMainStatus=1\n", nil
		case strings.HasPrefix(cmd, "journalctl -u orbit-runner-c2b.service --since @"):
			return "cannot secure runner config storage: chmod /root/.orbit: permission denied\n", nil
		}
		t.Errorf("asked %q", cmd)
		return "", errors.New("unexpected")
	})

	cfg := &RunnerConfig{ServerURL: cp.URL, RunnerID: registerTestRunnerID, RunnerToken: cp.token, Name: "c2b-load-2"}
	var outcome registerOutcome
	out := captureServiceOutput(t, func() { outcome = startService(cfg, nil) })
	t.Logf("register printed:\n%s", out)

	if outcome != serviceNotOnline {
		t.Errorf("outcome = %v, want serviceNotOnline", outcome)
	}
	if _, err := os.Stat(filepath.Join(unitDir, "orbit-runner-c2b.service")); err != nil {
		t.Fatalf("the unit was not installed, so this is not the failure under test: %v", err)
	}
	for _, want := range []string{
		"✗ c2b-load-2 did not come online: orbit-runner-c2b.service exited with status 1 and was restarted 2 times, and " + cp.URL + " has not heard from it.",
		"    cannot secure runner config storage: chmod /root/.orbit: permission denied",
		"    systemctl status orbit-runner-c2b.service",
		"    journalctl -u orbit-runner-c2b.service -e",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("register output lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "Background service started") {
		t.Errorf("register said the service started:\n%s", out)
	}
}

// unregister goes to the account under sudo too, so that it finds the config register wrote there and
// removes that account's unit.
func TestUnregisterUnderSudoIsHandedToTheAccount(t *testing.T) {
	account := &user.User{Uid: "4242", Gid: "4242", Username: "c2b", Name: "c2b", HomeDir: t.TempDir()}
	pretendRegisterHost(t, func() {})
	t.Setenv("SUDO_USER", "c2b")
	for _, k := range sudoHandOffEnvForTest {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
	sudo, err := exec.LookPath("sudo") // pretendRegisterHost's
	if err != nil {
		t.Fatal(err)
	}
	prevEUID, prevLookup, prevExec, prevDirs := processEUID, lookupUser, execSudoHandOff, sudoSearchDirs
	t.Cleanup(func() {
		processEUID, lookupUser, execSudoHandOff, sudoSearchDirs = prevEUID, prevLookup, prevExec, prevDirs
	})
	sudoSearchDirs = []string{filepath.Dir(sudo)}
	processEUID = func() int { return 0 }
	lookupUser = func(name string) (*user.User, error) {
		if name == account.Username {
			return account, nil
		}
		return user.Lookup(name)
	}
	// What main does for root's own commands under `sudo -i`: root's engine directories first on PATH.
	rootHome := t.TempDir()
	t.Setenv("HOME", rootHome)
	t.Setenv("PATH", runnerEnginePath(rootHome, os.Getenv("PATH")))
	var handedOff []string
	var handedPath string
	execSudoHandOff = func(argv []string) error { handedOff, handedPath = argv, os.Getenv("PATH"); return nil }
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}

	captureServiceOutput(t, func() { unregisterCommand([]string{"unregister", "--yes"}) })
	if want := []string{"-H", "-u", "c2b", "--", "env", exe, "unregister", "--yes"}; len(handedOff) != len(want)+1 || !slices.Equal(handedOff[1:], want) {
		t.Fatalf("unregister under sudo ran %q, want sudo %s", handedOff, strings.Join(want, " "))
	}
	// Where sudo keeps PATH, root's engine directories would reach the account's command.
	if strings.Contains(handedPath, rootHome) {
		t.Errorf("the hand-off kept root's own directories on PATH: %s", handedPath)
	}
}

// An account's unregister takes down the unit register installed for it, through sudo as register
// installed it — at a terminal, or without one when sudo needs no password — and otherwise says what
// to run.
func TestUnregisterRemovesTheAccountsUnitThroughSudo(t *testing.T) {
	account := &user.User{Uid: "4242", Gid: "4242", Username: "c2b", Name: "c2b", HomeDir: t.TempDir()}
	unitDir := pretendRegisterHost(t, func() {})
	t.Setenv("SUDO_USER", "")
	prevEUID, prevCurrent := processEUID, currentUser
	t.Cleanup(func() { processEUID, currentUser = prevEUID, prevCurrent })
	processEUID = func() int { return 4242 }
	currentUser = func() (*user.User, error) { return account, nil }
	sudo, err := exec.LookPath("sudo")
	if err != nil {
		t.Fatal(err)
	}
	commands := recordCommands(t)

	captureServiceOutput(t, uninstallSystemd)
	want := []string{
		sudo + " systemctl disable --now orbit-runner-c2b",
		sudo + " rm -f " + filepath.Join(unitDir, "orbit-runner-c2b.service"),
		sudo + " systemctl daemon-reload",
	}
	if !slices.Equal(*commands, want) {
		t.Fatalf("unregister ran %q, want %q", *commands, want)
	}

	// A sudo that would ask for a password, with no terminal to ask at.
	if err := os.WriteFile(sudo, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	*commands = nil
	out := captureServiceOutput(t, uninstallSystemd)
	if len(*commands) != 0 || !strings.Contains(out, "note: removing the systemd service needs root — run: sudo systemctl disable --now orbit-runner-c2b") {
		t.Fatalf("unregister without a usable sudo ran %q and printed:\n%s", *commands, out)
	}
}
