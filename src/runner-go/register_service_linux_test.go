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

// fakeAccounts answers lookupUser for the accounts a test names, and nothing else, so that no real
// account's home is read.
func fakeAccounts(t *testing.T, accounts ...*user.User) {
	t.Helper()
	prev := lookupUser
	t.Cleanup(func() { lookupUser = prev })
	lookupUser = func(name string) (*user.User, error) {
		for _, u := range accounts {
			if u.Username == name {
				return u, nil
			}
		}
		return nil, errors.New("no such account")
	}
}

// pretendSudoHandOff takes pretendRegisterHost's sudo for the system's, says every account can run this
// binary, and records what a hand-off would have run.
func pretendSudoHandOff(t *testing.T) *[]string {
	t.Helper()
	sudo, err := exec.LookPath("sudo") // pretendRegisterHost's
	if err != nil {
		t.Fatal(err)
	}
	var handedOff []string
	prevExec, prevDirs, prevCanRun := execSudoHandOff, sudoSearchDirs, accountCanRun
	t.Cleanup(func() { execSudoHandOff, sudoSearchDirs, accountCanRun = prevExec, prevDirs, prevCanRun })
	sudoSearchDirs = []string{filepath.Dir(sudo)}
	accountCanRun = func(*user.User, string) (bool, error) { return true, nil }
	execSudoHandOff = func(argv []string) error { handedOff = argv; return nil }
	return &handedOff
}

// unregister goes to the account under sudo too, so that it finds the config register wrote there and
// removes that account's unit.
func TestUnregisterUnderSudoIsHandedToTheAccount(t *testing.T) {
	account := &user.User{Uid: "4242", Gid: "4242", Username: "c2b", Name: "c2b", HomeDir: t.TempDir()}
	root := &user.User{Uid: "0", Gid: "0", Username: "root", Name: "root", HomeDir: t.TempDir()}
	pretendRegisterHost(t, func() {})
	fakeAccounts(t, account, root)
	prevKnown := accountKnownToSystem
	t.Cleanup(func() { accountKnownToSystem = prevKnown })
	accountKnownToSystem = func(string) bool { return false }
	t.Setenv("SUDO_USER", "c2b")
	for _, k := range sudoHandOffEnvForTest {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
	prevEUID := processEUID
	t.Cleanup(func() { processEUID = prevEUID })
	processEUID = func() int { return 0 }
	handedOff := pretendSudoHandOff(t)
	// What main does for root's own commands under `sudo -i`: root's engine directories first on PATH.
	t.Setenv("HOME", root.HomeDir)
	t.Setenv("PATH", runnerEnginePath(root.HomeDir, os.Getenv("PATH")))
	var handedPath string
	record := execSudoHandOff
	execSudoHandOff = func(argv []string) error { handedPath = os.Getenv("PATH"); return record(argv) }
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}

	captureServiceOutput(t, func() { unregisterCommand([]string{"unregister", "--yes"}) })
	if want := []string{"-E", "-H", "-u", "c2b", "--", exe, "unregister", "--yes"}; len(*handedOff) != len(want)+1 || !slices.Equal((*handedOff)[1:], want) {
		t.Fatalf("unregister under sudo ran %q, want sudo %s", *handedOff, strings.Join(want, " "))
	}
	// Where sudo keeps PATH, root's engine directories would reach the account's command.
	if strings.Contains(handedPath, root.HomeDir) {
		t.Errorf("the hand-off kept root's own directories on PATH: %s", handedPath)
	}
}

// A host the incident already happened to: the unit runs as the account with ORBIT_HOME in root's home,
// where only root can reach the credential. Handed to the account, unregister would find no runner and
// leave that unit restarting for good, so this one stays root's, and it deletes the runner, the unit and
// the config.
func TestUnregisterUnderSudoRemovesARunnerLeftInRootsHome(t *testing.T) {
	account := &user.User{Uid: "4242", Gid: "4242", Username: "c2b", Name: "c2b", HomeDir: t.TempDir()}
	root := &user.User{Uid: "0", Gid: "0", Username: "root", Name: "root", HomeDir: t.TempDir()}
	cp := newRegisterStub(t)
	unitDir := pretendRegisterHost(t, func() {})
	fakeAccounts(t, account, root)
	t.Setenv("SUDO_USER", "c2b")
	t.Setenv("HOME", root.HomeDir)
	t.Setenv("ORBIT_HOME", "")
	os.Unsetenv("ORBIT_HOME")
	prevEUID := processEUID
	t.Cleanup(func() { processEUID = prevEUID })
	processEUID = func() int { return 0 }
	handedOff := pretendSudoHandOff(t)

	orbitHome := filepath.Join(root.HomeDir, ".orbit")
	unitPath := filepath.Join(unitDir, "orbit-runner-c2b.service")
	unit := renderSystemdUnit("c2b", "c2b", "/usr/local/bin/orbit", account.HomeDir, orbitHome, "/usr/bin:/bin", nil)
	if err := os.WriteFile(unitPath, []byte(unit), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ORBIT_HOME", orbitHome)
	if err := saveConfig(&RunnerConfig{ServerURL: cp.URL, RunnerID: registerTestRunnerID, RunnerToken: cp.token, Name: "c2b-load-2"}); err != nil {
		t.Fatal(err)
	}
	os.Unsetenv("ORBIT_HOME")
	commands := recordCommands(t)

	out := captureServiceOutput(t, func() { unregisterCommand([]string{"unregister", "--yes"}) })
	t.Logf("orbit unregister under sudo printed:\n%s", out)

	if *handedOff != nil {
		t.Errorf("unregister was handed to the account, which cannot reach the credential: %q", *handedOff)
	}
	if want := []string{"systemctl disable --now orbit-runner-c2b", "systemctl daemon-reload"}; !slices.Equal(*commands, want) {
		t.Errorf("unregister ran %q, want %q", *commands, want)
	}
	if _, err := os.Stat(unitPath); !os.IsNotExist(err) {
		t.Errorf("the unit is still there: %v", err)
	}
	if _, err := os.Stat(filepath.Join(orbitHome, "config.json")); !os.IsNotExist(err) {
		t.Errorf("the config is still there: %v", err)
	}
	cp.mu.Lock()
	with := cp.deregisteredWith
	cp.mu.Unlock()
	if with != "Bearer "+cp.token {
		t.Errorf("the runner was deregistered with %q, want its own credential", with)
	}
}

// An account's unregister takes down the unit register installed for it, through sudo as register
// installed it, and says it did only when sudo did.
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
	unitPath := filepath.Join(unitDir, "orbit-runner-c2b.service")
	commands := recordCommands(t)

	// With no unit there is nothing to ask root for.
	out := captureServiceOutput(t, uninstallSystemd)
	if len(*commands) != 0 || strings.TrimSpace(out) != "" {
		t.Fatalf("with no unit, unregister ran %q and printed:\n%s", *commands, out)
	}

	// On a set-up host whose broker did not answer, the runner is an instance only root can stop now.
	template := filepath.Join(unitDir, filepath.Base(hostRunnerTemplatePath))
	if err := os.WriteFile(template, []byte("[Service]\nUser=%I\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out = captureServiceOutput(t, uninstallSystemd)
	if want := "note: the machine broker did not take down this account's runner — run: sudo systemctl disable --now orbit-runner@c2b.service"; len(*commands) != 0 || !strings.Contains(out, want) {
		t.Fatalf("with a template and no unit, unregister ran %q and printed:\n%s", *commands, out)
	}
	if err := os.Remove(template); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(unitPath, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	out = captureServiceOutput(t, uninstallSystemd)
	want := []string{
		sudo + " systemctl disable --now orbit-runner-c2b",
		sudo + " rm -f " + unitPath,
		sudo + " systemctl daemon-reload",
	}
	if !slices.Equal(*commands, want) {
		t.Fatalf("unregister ran %q, want %q", *commands, want)
	}
	if !strings.Contains(out, "✓ removed the orbit-runner-c2b service") {
		t.Errorf("unregister printed:\n%s", out)
	}

	// A sudo that refuses, the password mistyped, or a systemctl with no systemd to reach: every step is
	// still tried, and nothing is claimed.
	recorded := run
	run = func(name string, args ...string) error {
		_ = recorded(name, args...)
		return errors.New("exit status 1")
	}
	*commands = nil
	out = captureServiceOutput(t, uninstallSystemd)
	run = recorded
	if !slices.Equal(*commands, want) {
		t.Errorf("unregister with a failing sudo ran %q, want every step: %q", *commands, want)
	}
	if strings.Contains(out, "✓ removed") || !strings.Contains(out, "note: could not remove the orbit-runner-c2b service — run: sudo systemctl disable --now orbit-runner-c2b && sudo rm -f "+unitPath) {
		t.Errorf("unregister with a sudo that refuses printed:\n%s", out)
	}

	// A sudo that would ask for a password, with no terminal to ask at.
	if err := os.WriteFile(sudo, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	*commands = nil
	out = captureServiceOutput(t, uninstallSystemd)
	if len(*commands) != 0 || !strings.Contains(out, "note: removing the systemd service needs root — run: sudo systemctl disable --now orbit-runner-c2b") {
		t.Fatalf("unregister without a usable sudo ran %q and printed:\n%s", *commands, out)
	}
}

// An unregister that could not take the unit down left it restarting with no config. Running again finishes
// the job, for the unit that names this home and no other: an ORBIT_HOME with no runner in it, a trial one,
// is no reason to stop the account's real runner.
func TestUnregisterFinishesAServiceLeftWithNoConfig(t *testing.T) {
	account := &user.User{Uid: "4242", Gid: "4242", Username: "c2b", Name: "c2b", HomeDir: t.TempDir()}
	unitDir := pretendRegisterHost(t, func() {})
	t.Setenv("SUDO_USER", "")
	t.Setenv("HOME", account.HomeDir)
	orbitHome := filepath.Join(account.HomeDir, ".orbit")
	t.Setenv("ORBIT_HOME", orbitHome)
	prevEUID, prevCurrent := processEUID, currentUser
	t.Cleanup(func() { processEUID, currentUser = prevEUID, prevCurrent })
	processEUID = func() int { return 4242 }
	currentUser = func() (*user.User, error) { return account, nil }
	sudo, err := exec.LookPath("sudo")
	if err != nil {
		t.Fatal(err)
	}
	unit := filepath.Join(unitDir, "orbit-runner-c2b.service")
	if err := os.WriteFile(unit, []byte(renderSystemdUnit("c2b", "c2b", "/x/orbit", account.HomeDir, orbitHome, "/usr/bin", nil)), 0o644); err != nil {
		t.Fatal(err)
	}
	commands := recordCommands(t)

	t.Setenv("ORBIT_HOME", filepath.Join(account.HomeDir, ".orbit-trial"))
	out := captureServiceOutput(t, func() { unregisterCommand([]string{"unregister", "--yes"}) })
	if len(*commands) != 0 || !strings.Contains(out, "no runner registered on this machine") {
		t.Fatalf("with another ORBIT_HOME, unregister ran %q and printed:\n%s", *commands, out)
	}

	t.Setenv("ORBIT_HOME", orbitHome)
	out = captureServiceOutput(t, func() { unregisterCommand([]string{"unregister", "--yes"}) })
	if want := sudo + " systemctl disable --now orbit-runner-c2b"; len(*commands) == 0 || (*commands)[0] != want {
		t.Fatalf("unregister ran %q, want %q first; printed:\n%s", *commands, want, out)
	}
	if strings.Contains(out, "no runner registered") {
		t.Errorf("unregister printed:\n%s", out)
	}
}

// Under sudo someone asked for a running service with root in hand. A service step that cannot get root
// again, with no terminal and a sudo that wants a password, is no finished setup, and register says so
// and exits 1. Nobody's sudo is involved in a plain account's registration, which ends as it did.
func TestRegisterUnderSudoCountsAServiceItCouldNotInstallAsNotOnline(t *testing.T) {
	account := &user.User{Uid: "4242", Gid: "4242", Username: "c2b", Name: "c2b", HomeDir: t.TempDir()}
	cp := newRegisterStub(t)
	pretendRegisterHost(t, func() {})
	sudo, err := exec.LookPath("sudo")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sudo, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", account.HomeDir)
	prevEUID, prevCurrent := processEUID, currentUser
	t.Cleanup(func() { processEUID, currentUser = prevEUID, prevCurrent })
	processEUID = func() int { return 4242 }
	currentUser = func() (*user.User, error) { return account, nil }
	cfg := &RunnerConfig{ServerURL: cp.URL, RunnerID: registerTestRunnerID, RunnerToken: cp.token, Name: "c2b-load-2"}

	for _, tc := range []struct {
		name, sudoUser, mark string
		want                 registerOutcome
	}{
		{"handed off", "root", "1", serviceNotOnline},
		{"root's own sudo -u", "root", "", registeredOnly},
		{"a plain account", "", "", registeredOnly},
	} {
		t.Setenv("SUDO_USER", tc.sudoUser)
		t.Setenv(sudoHandOffMark, tc.mark)
		var outcome registerOutcome
		out := captureServiceOutput(t, func() { outcome = startService(cfg, nil) })
		if outcome != tc.want {
			t.Errorf("%s: outcome = %v, want %v", tc.name, outcome, tc.want)
		}
		if wantLine := "✗ Could not start the background service: installing the systemd service needs root, and c2b has no sudo that works without a terminal: run this at a terminal"; !strings.Contains(out, wantLine) {
			t.Errorf("%s: output lacks %q:\n%s", tc.name, wantLine, out)
		}
	}
}
