package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// The registration that left c2b-load-2 dead on 2026-10-31: the account c2b ran `sudo -i`, then
// `orbit register`. Run as root, register kept the credential under root's home and gave the unit it
// installed to run as c2b ORBIT_HOME=/root/.orbit, which c2b cannot enter, so the runner exited at
// every start while register said it was online. Under sudo, register is c2b's own registration: it
// runs as c2b, as `sudo -H -u c2b` starts it, and the config it writes and the ORBIT_HOME of the unit it
// installs are both in c2b's home.
//
// The test runs `orbit register` as typed, as a root this process pretends to be, against a stub
// control plane, with the unit directory, the broker socket and sudo, systemctl and journalctl in
// temporary places. Where register hands itself over, the test plays sudo: it becomes c2b and runs
// what register asked to run.
func TestRegisterUnderSudoKeepsTheRunnerInTheAccountsHome(t *testing.T) {
	rootHome, accountHome := t.TempDir(), t.TempDir()
	account := &user.User{Uid: "4242", Gid: "4242", Username: "c2b", Name: "c2b", HomeDir: accountHome}
	root := &user.User{Uid: "0", Gid: "0", Username: "root", Name: "root", HomeDir: rootHome}
	cp := newRegisterStub(t)
	unitDir := pretendRegisterHost(t, cp.beat)

	// Root under `sudo -i` from c2b: root's own HOME, SUDO_USER naming c2b.
	t.Setenv("HOME", rootHome)
	t.Setenv("SUDO_USER", "c2b")
	for _, k := range sudoHandOffEnvForTest {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
	prevEUID, prevCurrent, prevLookup := processEUID, currentUser, lookupUser
	t.Cleanup(func() { processEUID, currentUser, lookupUser = prevEUID, prevCurrent, prevLookup })
	processEUID = func() int { return 0 }
	currentUser = func() (*user.User, error) { return root, nil }
	lookupUser = func(name string) (*user.User, error) {
		if name == account.Username {
			return account, nil
		}
		return user.Lookup(name)
	}

	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	var handedOff []string
	prevExec := execSudoHandOff
	t.Cleanup(func() { execSudoHandOff = prevExec })
	execSudoHandOff = func(argv []string) error {
		handedOff = argv
		at := slices.Index(argv, exe)
		if at < 0 {
			t.Fatalf("the hand-off does not run this binary (%s): %q", exe, argv)
		}
		// What `sudo -H -u c2b -- env K=V… <exe> …` makes of this process: c2b, with c2b's
		// HOME, SUDO_USER naming root, and the variables env sets.
		for _, kv := range argv[slices.Index(argv, "env")+1 : at] {
			k, v, _ := strings.Cut(kv, "=")
			t.Setenv(k, v)
		}
		processEUID = func() int { return 4242 }
		currentUser = func() (*user.User, error) { return account, nil }
		t.Setenv("HOME", accountHome)
		t.Setenv("SUDO_USER", "root")
		registerCommand(argv[at+1:])
		return nil
	}

	args := []string{"register", "--server", cp.URL, "--token", "e2e-enroll", "--name", "c2b-load-2"}
	out := captureServiceOutput(t, func() { registerCommand(args) })
	t.Logf("orbit register under sudo printed:\n%s", out)

	if want := []string{"sudo", "-H", "-u", "c2b", "--", "env", exe}; len(handedOff) < len(want) ||
		filepath.Base(handedOff[0]) != want[0] || !slices.Equal(handedOff[1:len(want)], want[1:]) {
		t.Errorf("register under sudo was not handed to c2b as `sudo -H -u c2b -- env %s register …`; it ran %q", exe, handedOff)
	} else if got := handedOff[len(want):]; !slices.Equal(got, args) {
		t.Errorf("the hand-off runs `%s`, want the command as typed: `%s`", strings.Join(got, " "), strings.Join(args, " "))
	}

	accountOrbit := filepath.Join(accountHome, ".orbit")
	config := filepath.Join(accountOrbit, "config.json")
	if _, err := os.Stat(filepath.Join(rootHome, ".orbit", "config.json")); err == nil {
		t.Errorf("register under sudo wrote the runner's config under root's home, %s", filepath.Join(rootHome, ".orbit"))
	}
	if b, err := os.ReadFile(config); err != nil {
		t.Errorf("register under sudo did not write the runner's config in c2b's home: %v", err)
	} else {
		var cfg RunnerConfig
		if err := json.Unmarshal(b, &cfg); err != nil || cfg.RunnerToken != cp.token || cfg.Name != "c2b-load-2" {
			t.Errorf("c2b's %s holds %s, want the credential the control plane issued", config, b)
		}
		assertPrivateMode(t, accountOrbit, machineHomePerm)
		assertPrivateMode(t, config, configFilePerm)
	}

	unit, err := os.ReadFile(filepath.Join(unitDir, "orbit-runner-c2b.service"))
	if err != nil {
		t.Fatalf("no unit installed for c2b: %v\noutput:\n%s", err, out)
	}
	for _, want := range []string{"User=c2b\n", "Environment=HOME=" + accountHome + "\n", "Environment=ORBIT_HOME=" + accountOrbit + "\n"} {
		if !strings.Contains(string(unit), want) {
			t.Errorf("c2b's unit lacks %q:\n%s", strings.TrimSpace(want), unit)
		}
	}
	for _, want := range []string{"✓ Background service started as c2b (runs at boot).", "✓ Setup complete — c2b-load-2 is online."} {
		if !strings.Contains(out, want) {
			t.Errorf("register output lacks %q:\n%s", want, out)
		}
	}
}

// sudoHandOffEnvForTest is the environment a hand-off may carry over, cleared so the command line it
// builds holds only what the test sets.
var sudoHandOffEnvForTest = []string{
	"ORBIT_HOME", "ORBIT_INSTALL_PLAN", "https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "no_proxy", "NO_PROXY",
}

// registerStub is the least of a control plane `orbit register --token` needs: it mints one runner
// and answers GET /runner/me with the runner's last beat, which beat records.
type registerStub struct {
	*httptest.Server
	token string

	mu   sync.Mutex
	last *time.Time
}

func newRegisterStub(t *testing.T) *registerStub {
	t.Helper()
	s := &registerStub{token: "runner-token-c2b"}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/runner/register", func(w http.ResponseWriter, r *http.Request) {
		var req RegisterRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		_ = json.NewEncoder(w).Encode(RegisterResponse{RunnerID: registerTestRunnerID, RunnerToken: s.token, Name: req.Name})
	})
	mux.HandleFunc("GET /api/runner/me", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+s.token {
			http.Error(w, `{"error":"unknown runner credential"}`, http.StatusUnauthorized)
			return
		}
		s.mu.Lock()
		var last *string
		if s.last != nil {
			at := s.last.UTC().Format(time.RFC3339Nano)
			last = &at
		}
		s.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": registerTestRunnerID, "name": "c2b-load-2", "status": "ONLINE", "online": last != nil,
			"lastHeartbeatAt": last, "workspaces": []any{},
		})
	})
	s.Server = httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s
}

// beat is the runner's heartbeat reaching the control plane.
func (s *registerStub) beat() {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	s.last = &now
}

// pretendRegisterHost points register's service step at a temporary unit directory and a broker
// socket that is not there, and puts stand-ins for sudo (which needs no password here), systemctl
// (whose units are all running) and journalctl first on PATH. Of the commands register runs through
// run and runQuiet it carries out only two: `install … <unit>` copies the unit into place, and a
// restart of a unit calls onRestart — the runner it starts, beating. It returns the unit directory.
func pretendRegisterHost(t *testing.T, onRestart func()) string {
	t.Helper()
	unitDir, bin := t.TempDir(), t.TempDir()
	prevDir, prevSocket, prevRootOwned := serviceUnitDir, serviceBrokerSocket, rootOwnedDir
	prevRun, prevQuiet := run, runQuiet
	t.Cleanup(func() {
		serviceUnitDir, serviceBrokerSocket, rootOwnedDir = prevDir, prevSocket, prevRootOwned
		run, runQuiet = prevRun, prevQuiet
	})
	serviceUnitDir = unitDir
	serviceBrokerSocket = filepath.Join(t.TempDir(), "host.sock")
	rootOwnedDir = func(string) bool { return false }

	for name, script := range map[string]string{
		"sudo":       "exit 0\n",
		"systemctl":  `[ "$1" = show ] && printf 'LoadState=loaded\nActiveState=active\nSubState=running\nNRestarts=0\nExecMainCode=0\nExecMainStatus=0\n'` + "\nexit 0\n",
		"journalctl": "exit 0\n",
	} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\n"+script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	run = func(name string, args ...string) error {
		if filepath.Base(name) == "sudo" {
			name, args = args[0], args[1:]
		}
		switch {
		case name == "install" && len(args) == 4:
			b, err := os.ReadFile(args[2])
			if err != nil {
				return err
			}
			return os.WriteFile(args[3], b, 0o644)
		case name == "systemctl" && len(args) == 2 && args[0] == "restart":
			onRestart()
		}
		return nil
	}
	runQuiet = func(string, ...string) {}
	return unitDir
}

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
	prevEUID, prevLookup, prevExec := processEUID, lookupUser, execSudoHandOff
	t.Cleanup(func() { processEUID, lookupUser, execSudoHandOff = prevEUID, prevLookup, prevExec })
	processEUID = func() int { return 0 }
	lookupUser = func(name string) (*user.User, error) {
		if name == account.Username {
			return account, nil
		}
		return user.Lookup(name)
	}
	var handedOff []string
	execSudoHandOff = func(argv []string) error { handedOff = argv; return nil }
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}

	captureServiceOutput(t, func() { unregisterCommand([]string{"unregister", "--yes"}) })
	if want := []string{"-H", "-u", "c2b", "--", "env", exe, "unregister", "--yes"}; len(handedOff) != len(want)+1 || !slices.Equal(handedOff[1:], want) {
		t.Fatalf("unregister under sudo ran %q, want sudo %s", handedOff, strings.Join(want, " "))
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
