package main

import (
	"encoding/json"
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
// installs are both in c2b's home. So is the PATH that unit runs with: it ends in c2b's own Orbit ripgrep
// directory, and nothing of root's is on it.
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
	// What main does for root's own commands: root's engine directories first on PATH, and Orbit's ripgrep
	// directory in root's runner home last.
	t.Setenv("PATH", runnerEnginePath(rootHome, os.Getenv("PATH")))
	prevEUID, prevCurrent, prevLookup := processEUID, currentUser, lookupUser
	t.Cleanup(func() { processEUID, currentUser, lookupUser = prevEUID, prevCurrent, prevLookup })
	processEUID = func() int { return 0 }
	currentUser = func() (*user.User, error) { return root, nil }
	lookupUser = func(name string) (*user.User, error) {
		switch name {
		case account.Username:
			return account, nil
		case root.Username:
			return root, nil
		}
		return user.Lookup(name)
	}

	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	sudo, err := exec.LookPath("sudo") // pretendRegisterHost's
	if err != nil {
		t.Fatal(err)
	}
	var handedOff []string
	prevExec, prevDirs, prevCanRun := execSudoHandOff, sudoSearchDirs, accountCanRun
	t.Cleanup(func() { execSudoHandOff, sudoSearchDirs, accountCanRun = prevExec, prevDirs, prevCanRun })
	sudoSearchDirs = []string{filepath.Dir(sudo)}
	accountCanRun = func(*user.User, string) (bool, error) { return true, nil }
	execSudoHandOff = func(argv []string) error {
		handedOff = argv
		at := slices.Index(argv, exe)
		if at < 0 {
			t.Fatalf("the hand-off does not run this binary (%s): %q", exe, argv)
		}
		// What `sudo -E -H -u c2b -- <exe> …` makes of this process: c2b, with c2b's HOME, and
		// SUDO_USER naming root.
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

	if want := []string{"sudo", "-E", "-H", "-u", "c2b", "--", exe}; len(handedOff) < len(want) ||
		filepath.Base(handedOff[0]) != want[0] || !slices.Equal(handedOff[1:len(want)], want[1:]) {
		t.Errorf("register under sudo was not handed to c2b as `sudo -E -H -u c2b -- %s register …`; it ran %q", exe, handedOff)
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
	var unitPath string
	for _, line := range strings.Split(string(unit), "\n") {
		if path, ok := strings.CutPrefix(line, "Environment=PATH="); ok {
			unitPath = path
		}
	}
	entries := strings.Split(unitPath, ":")
	if want := filepath.Join(accountOrbit, "tools", "ripgrep", managedRgVersion); entries[len(entries)-1] != want {
		t.Errorf("c2b's unit runs with PATH=%s, want it to end in c2b's own %s", unitPath, want)
	}
	if strings.Contains(unitPath, rootHome) {
		t.Errorf("c2b's unit runs with PATH=%s, which names root's own directories", unitPath)
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
	"SSL_CERT_FILE", "SSL_CERT_DIR",
}

// registerStub is the least of a control plane `orbit register --token` needs: it mints one runner
// and answers GET /runner/me with the runner's last beat, which beat records.
type registerStub struct {
	*httptest.Server
	token string

	mu               sync.Mutex
	last             *time.Time
	deregisteredWith string
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
	mux.HandleFunc("POST /api/runner/deregister", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.deregisteredWith = r.Header.Get("Authorization")
		s.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
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
