package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// The TERMINAL credential on this machine (docs/terminal-session-design.md, "The terminal credential"): kept in the
// OS keychain, or in a 0600 file under ORBIT_HOME when there is none, and never in the environment — neither this
// process's nor that of the keychain tool it runs, nor that tool's arguments.

const fakeTerminalToken = "orbit_term_FAKEsecretFAKEsecretFAKEsecretFAKEsecret0"

// fakeTerminalServer is the apiserver's side of a terminal sign-in: start and poll (the runner credential), and
// GET /api/terminals/self (the terminal credential), answering `self` with selfStatus.
type fakeTerminalServer struct {
	*httptest.Server
	mu         sync.Mutex
	starts     int
	polls      int
	selfCalls  int
	selfStatus int
	auth       []string
}

func newFakeTerminalServer(t *testing.T) *fakeTerminalServer {
	f := &fakeTerminalServer{selfStatus: http.StatusOK}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.auth = append(f.auth, r.Method+" "+r.URL.Path+" "+r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/runner/terminal-login/start":
			f.starts++
			_ = json.NewEncoder(w).Encode(map[string]any{"deviceCode": "device-code", "userCode": "7KQ-4MZ", "machineName": "dev-laptop", "interval": 1, "expiresIn": 600})
		case "POST /api/runner/terminal-login/poll":
			f.polls++
			if f.polls < 2 {
				_ = json.NewEncoder(w).Encode(map[string]any{"status": "pending"})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status": "approved", "token": fakeTerminalToken, "terminalId": "term-1", "machineName": "dev-laptop",
				"expiresAt": time.Now().Add(30 * 24 * time.Hour).UTC().Format(time.RFC3339Nano),
			})
		case "GET /api/terminals/self":
			f.selfCalls++
			w.WriteHeader(f.selfStatus)
			_, _ = w.Write([]byte(`{}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(f.Close)
	return f
}

// terminalTestMachine is a registered runner in a fresh ORBIT_HOME, talking to server.
func terminalTestMachine(t *testing.T, server string) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	t.Setenv("ORBIT_SESSION_ID", "")
	data, _ := json.Marshal(RunnerConfig{ServerURL: server, RunnerID: "runner-1", RunnerToken: "runner-token", Name: "dev-laptop"})
	if err := os.WriteFile(filepath.Join(home, "config.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	prevSleep := terminalLoginSleep
	terminalLoginSleep = func(time.Duration) {}
	t.Cleanup(func() { terminalLoginSleep = prevSleep })
	return home
}

// fakeKeychainTool installs a stand-in for `secret-tool` (Linux) or `security` (macOS) that records each call's
// arguments, environment and stdin, and keeps what it is given in a file. `fail` makes every store fail.
func fakeKeychainTool(t *testing.T, osName string, fail bool) (logDir string) {
	t.Helper()
	logDir = t.TempDir()
	bin := filepath.Join(t.TempDir(), "tool")
	failStore := "0"
	if fail {
		failStore = "1"
	}
	script := `#!/bin/sh
LOG='` + logDir + `'
n=$(ls -d "$LOG"/call-* 2>/dev/null | wc -l | tr -d ' ')
call="$LOG/call-$n"
mkdir -p "$call"
printf '%s\n' "$@" > "$call/argv"
env > "$call/env"
cat > "$call/stdin"
case "$1" in
  store) [ ` + failStore + ` = 1 ] && exit 1; cp "$call/stdin" "$LOG/item" ;;
  lookup) [ -f "$LOG/item" ] || exit 1; cat "$LOG/item" ;;
  clear) rm -f "$LOG/item" ;;
  -i) [ ` + failStore + ` = 1 ] && exit 1; cp "$call/stdin" "$LOG/item-cmd" ;;
  find-generic-password) [ -f "$LOG/item" ] || exit 44; cat "$LOG/item" ;;
  delete-generic-password) rm -f "$LOG/item" ;;
esac
exit 0
`
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	prevOS, prevLook := terminalKeychainOS, terminalLookPath
	terminalKeychainOS = osName
	terminalLookPath = func(string) (string, error) { return bin, nil }
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/0/bus")
	t.Cleanup(func() { terminalKeychainOS, terminalLookPath = prevOS, prevLook })
	return logDir
}

// noKeychain leaves the machine without one: Linux with no session bus.
func noKeychain(t *testing.T) {
	prevOS := terminalKeychainOS
	terminalKeychainOS = "linux"
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "")
	t.Cleanup(func() { terminalKeychainOS = prevOS })
}

// assertNotInEnvironment holds that no variable of this process carries the credential.
func assertNotInEnvironment(t *testing.T, secret string) {
	t.Helper()
	for _, kv := range os.Environ() {
		if strings.Contains(kv, secret) {
			t.Fatalf("an environment variable carries the terminal credential: %s", strings.SplitN(kv, "=", 2)[0])
		}
	}
}

// assertToolCallsClean holds that no keychain tool call was handed the credential as an argument or in its environment.
func assertToolCallsClean(t *testing.T, logDir, secret string) int {
	t.Helper()
	calls, _ := filepath.Glob(filepath.Join(logDir, "call-*"))
	for _, call := range calls {
		for _, part := range []string{"argv", "env"} {
			data, _ := os.ReadFile(filepath.Join(call, part))
			if strings.Contains(string(data), secret) || strings.Contains(string(data), hex.EncodeToString([]byte(secret))) {
				t.Fatalf("%s of a keychain tool call carries the terminal credential:\n%s", part, data)
			}
		}
	}
	return len(calls)
}

func TestTerminalCredentialIsStoredInTheSecretServiceNotTheEnvironment(t *testing.T) {
	server := newFakeTerminalServer(t)
	home := terminalTestMachine(t, server.URL)
	logDir := fakeKeychainTool(t, "linux", false)

	var out bytes.Buffer
	cred, err := ensureTerminalCredential(&out)
	if err != nil {
		t.Fatal(err)
	}
	if cred.Token != fakeTerminalToken || cred.RunnerID != "runner-1" || cred.MachineName != "dev-laptop" {
		t.Fatalf("credential = %+v", cred)
	}
	for _, want := range []string{"Approve this terminal in the Orbit app on your phone.", "Terminal on dev-laptop · code 7KQ-4MZ", "Secret Service"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output lacks %q:\n%s", want, out.String())
		}
	}
	item, err := os.ReadFile(filepath.Join(logDir, "item"))
	if err != nil || !strings.Contains(string(item), fakeTerminalToken) {
		t.Fatalf("the Secret Service holds no credential: %v %q", err, item)
	}
	if _, err := os.Stat(filepath.Join(home, "terminal.json")); !os.IsNotExist(err) {
		t.Fatalf("a keychain-kept credential also left a file under ORBIT_HOME: %v", err)
	}
	if assertToolCallsClean(t, logDir, fakeTerminalToken) == 0 {
		t.Fatal("no keychain tool was called")
	}
	assertNotInEnvironment(t, fakeTerminalToken)
	// Start and poll went with the runner credential; nothing went with the terminal's before it existed.
	for _, line := range server.auth {
		if strings.Contains(line, "/api/runner/terminal-login/") && !strings.HasSuffix(line, "Bearer runner-token") {
			t.Errorf("a sign-in call did not carry the runner credential: %s", line)
		}
	}

	// Read back from the keychain, and reused while the server takes it: no second sign-in.
	again, err := ensureTerminalCredential(&bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if again.Token != fakeTerminalToken || server.starts != 1 || server.selfCalls != 1 {
		t.Fatalf("not reused: token %q, starts %d, self calls %d", again.Token, server.starts, server.selfCalls)
	}
}

func TestTerminalCredentialIsStoredInTheMacOSKeychainThroughStdin(t *testing.T) {
	terminalTestMachine(t, "http://orbit.test")
	logDir := fakeKeychainTool(t, "darwin", false)
	cred := &terminalCredential{ServerURL: "http://orbit.test", RunnerID: "runner-1", TerminalID: "term-1", MachineName: "dev-laptop",
		Token: fakeTerminalToken, ExpiresAt: time.Now().Add(time.Hour)}
	where, err := saveTerminalCredential(cred)
	if err != nil || where != "macOS Keychain" {
		t.Fatalf("saved to %q: %v", where, err)
	}
	command, _ := os.ReadFile(filepath.Join(logDir, "item-cmd"))
	data, _ := json.Marshal(cred)
	if !strings.HasPrefix(string(command), "add-generic-password -U -s 'orbit-terminal'") || !strings.Contains(string(command), "-X "+hex.EncodeToString(data)) {
		t.Fatalf("security -i was not handed the item on stdin: %q", command)
	}
	assertToolCallsClean(t, logDir, fakeTerminalToken)
	assertNotInEnvironment(t, fakeTerminalToken)

	// What `security find-generic-password -w` prints is read back.
	if err := os.WriteFile(filepath.Join(logDir, "item"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if got := loadTerminalCredential("http://orbit.test"); got == nil || got.Token != fakeTerminalToken {
		t.Fatalf("read back %+v", got)
	}
}

func TestTerminalCredentialFallsBackToA0600FileUnderOrbitHome(t *testing.T) {
	for _, tc := range []struct {
		name  string
		setup func(t *testing.T)
	}{
		{"no keychain", noKeychain},
		{"the keychain refuses", func(t *testing.T) { fakeKeychainTool(t, "linux", true) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := newFakeTerminalServer(t)
			home := terminalTestMachine(t, server.URL)
			tc.setup(t)
			var out bytes.Buffer
			if _, err := ensureTerminalCredential(&out); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(home, "terminal.json")
			info, err := os.Stat(path)
			if err != nil {
				t.Fatalf("no file under ORBIT_HOME: %v", err)
			}
			if info.Mode().Perm() != 0o600 {
				t.Fatalf("%s has mode %o, want 0600", path, info.Mode().Perm())
			}
			data, _ := os.ReadFile(path)
			if !strings.Contains(string(data), fakeTerminalToken) {
				t.Fatalf("the file holds no credential: %s", data)
			}
			if !strings.Contains(out.String(), path) {
				t.Errorf("the output does not say where it was kept:\n%s", out.String())
			}
			leftovers, _ := filepath.Glob(filepath.Join(home, ".terminal-*"))
			if len(leftovers) != 0 {
				t.Fatalf("temporary files left behind: %v", leftovers)
			}
			assertNotInEnvironment(t, fakeTerminalToken)
		})
	}
}

func TestTerminalCredentialIsReplacedWhenRefusedOrExpired(t *testing.T) {
	t.Run("refused 401", func(t *testing.T) {
		server := newFakeTerminalServer(t)
		home := terminalTestMachine(t, server.URL)
		noKeychain(t)
		if _, err := saveTerminalCredential(&terminalCredential{ServerURL: server.URL, RunnerID: "runner-1", Token: terminalTokenPrefix + "revoked",
			ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
			t.Fatal(err)
		}
		server.selfStatus = http.StatusUnauthorized
		cred, err := ensureTerminalCredential(&bytes.Buffer{})
		if err != nil {
			t.Fatal(err)
		}
		if server.selfCalls != 1 || server.starts != 1 || cred.Token != fakeTerminalToken {
			t.Fatalf("self calls %d, starts %d, token %q", server.selfCalls, server.starts, cred.Token)
		}
		if data, _ := os.ReadFile(filepath.Join(home, "terminal.json")); strings.Contains(string(data), "revoked") {
			t.Fatal("the refused credential is still kept")
		}
	})
	t.Run("expired", func(t *testing.T) {
		server := newFakeTerminalServer(t)
		terminalTestMachine(t, server.URL)
		noKeychain(t)
		if _, err := saveTerminalCredential(&terminalCredential{ServerURL: server.URL, RunnerID: "runner-1", Token: terminalTokenPrefix + "old",
			ExpiresAt: time.Now().Add(-time.Minute)}); err != nil {
			t.Fatal(err)
		}
		if _, err := ensureTerminalCredential(&bytes.Buffer{}); err != nil {
			t.Fatal(err)
		}
		if server.selfCalls != 0 || server.starts != 1 {
			t.Fatalf("an expired credential was tried (%d self calls) or not replaced (%d starts)", server.selfCalls, server.starts)
		}
	})
}

func TestTerminalSignInNeedsARegisteredRunnerAndRefusesInsideASession(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv("ORBIT_SESSION_ID", "")
	if _, err := ensureTerminalCredential(&bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "Run `orbit register` first") {
		t.Fatalf("err = %v", err)
	}
	t.Setenv("ORBIT_SESSION_ID", "some-session")
	if _, err := ensureTerminalCredential(&bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "inside an Orbit session") {
		t.Fatalf("err = %v", err)
	}
}
