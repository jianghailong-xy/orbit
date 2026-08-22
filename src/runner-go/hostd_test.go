package main

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The design decision this whole file rests on: instances are keyed by uid, because
// unit-name escaping is not injective over the usernames Linux actually allows.
func TestUnitForUidKeysOnUidNotUsername(t *testing.T) {
	if got, want := unitForUid(1000), "orbit-runner@1000.service"; got != want {
		t.Errorf("unitForUid(1000) = %q, want %q", got, want)
	}
	if got, want := unitForUid(0), "orbit-runner@0.service"; got != want {
		t.Errorf("unitForUid(0) = %q, want %q", got, want)
	}
	// systemdServiceFor("alice.b") and systemdServiceFor("alice_b") are the same unit —
	// its escaping is not injective over the usernames Linux allows. uids are.
	if unitForUid(1001) == unitForUid(1002) {
		t.Fatal("distinct uids produced the same unit name")
	}
}

func TestHostdHandleDispatchesToTheVerbWithThePeer(t *testing.T) {
	var seen hostdPeer
	verbs := map[string]hostdVerb{
		"status": func(peer hostdPeer, req hostdRequest) hostdResponse {
			seen = peer
			return hostdOK(map[string]any{"unit": unitForUid(peer.UID)})
		},
	}
	peer := hostdPeer{UID: 1000, PID: 4242}
	resp := hostdHandle([]byte(`{"v":1,"verb":"status"}`), peer, verbs)
	if !resp.OK {
		t.Fatalf("expected ok, got error %q", resp.Error)
	}
	if seen != peer {
		t.Errorf("verb saw peer %+v, want %+v", seen, peer)
	}
	if got := resp.Data["unit"]; got != "orbit-runner@1000.service" {
		t.Errorf("data unit = %v, want orbit-runner@1000.service", got)
	}
}

// A request that names its own target is the confused-deputy attempt hostd exists to
// refuse. It must fail before dispatch, and say why.
func TestHostdHandleRefusesRequestsThatNameATarget(t *testing.T) {
	cases := []struct{ name, body, field string }{
		{"user", `{"v":1,"verb":"start","user":"root"}`, "user"},
		{"uid", `{"v":1,"verb":"start","uid":0}`, "uid"},
		{"target", `{"v":1,"verb":"start","target":"orbit-runner@0.service"}`, "target"},
		{"camel case", `{"v":1,"verb":"start","targetUser":"root"}`, "targetUser"},
		{"snake case", `{"v":1,"verb":"start","run_as":"root"}`, "run_as"},
		{"kebab case", `{"v":1,"verb":"start","on-behalf-of":"root"}`, "on-behalf-of"},
		{"upper case", `{"v":1,"verb":"start","UID":0}`, "UID"},
		{"nested object", `{"v":1,"verb":"start","args":{"account":"root"}}`, "account"},
		{"nested in array", `{"v":1,"verb":"start","args":[{"login":"root"}]}`, "login"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			called := false
			verbs := map[string]hostdVerb{
				"start": func(hostdPeer, hostdRequest) hostdResponse {
					called = true
					return hostdOK(nil)
				},
			}
			resp := hostdHandle([]byte(c.body), hostdPeer{UID: 1000}, verbs)
			if resp.OK {
				t.Fatal("a request naming a target was accepted")
			}
			if called {
				t.Fatal("the verb ran; the target field must be refused before dispatch")
			}
			if !strings.Contains(resp.Error, c.field) {
				t.Errorf("error %q does not name the refused field %q", resp.Error, c.field)
			}
			if !strings.Contains(resp.Error, "peer credentials") {
				t.Errorf("error %q does not explain where the target comes from", resp.Error)
			}
		})
	}
}

// Every malformed input is an answer, never a panic: hostd stays up for the next caller.
func TestHostdHandleAnswersBadRequestsWithoutCrashing(t *testing.T) {
	verbs := map[string]hostdVerb{
		"status": func(hostdPeer, hostdRequest) hostdResponse { return hostdOK(nil) },
	}
	cases := []struct{ name, body, wants string }{
		{"truncated json", `{"v":1,"verb":`, "malformed"},
		{"not json at all", `systemctl start something`, "malformed"},
		{"empty body", ``, "malformed"},
		{"json array", `[{"v":1,"verb":"status"}]`, "malformed"},
		{"wrong field type", `{"v":"one","verb":"status"}`, "malformed"},
		{"future version", `{"v":2,"verb":"status"}`, "version"},
		{"missing version", `{"verb":"status"}`, "version"},
		{"unknown verb", `{"v":1,"verb":"rm -rf"}`, `unknown verb "rm -rf"`},
		{"missing verb", `{"v":1}`, "missing verb"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			resp := hostdHandle([]byte(c.body), hostdPeer{UID: 1000}, verbs)
			if resp.OK {
				t.Fatal("a bad request was accepted")
			}
			if !strings.Contains(resp.Error, c.wants) {
				t.Errorf("error %q does not mention %q", resp.Error, c.wants)
			}
		})
	}
}

// The response is what a caller parses; keep the three documented keys on the wire.
func TestHostdResponseWireShape(t *testing.T) {
	body, err := json.Marshal(hostdFail("nope"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"ok":false`) || !strings.Contains(string(body), `"error":"nope"`) {
		t.Errorf("failure response = %s", body)
	}
	body, err = json.Marshal(hostdOK(map[string]any{"active": true}))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"ok":true`) || !strings.Contains(string(body), `"active":true`) {
		t.Errorf("success response = %s", body)
	}
}

func TestSystemdListenFDs(t *testing.T) {
	self := os.Getpid()
	cases := []struct {
		name string
		env  map[string]string
		want int
	}{
		{"one socket handed over", map[string]string{"LISTEN_PID": strconv.Itoa(self), "LISTEN_FDS": "1"}, 1},
		{"several sockets", map[string]string{"LISTEN_PID": strconv.Itoa(self), "LISTEN_FDS": "3"}, 3},
		{"no handover at all", map[string]string{}, 0},
		// Inherited by a child: the handover belonged to its parent, not to it.
		{"another process's handover", map[string]string{"LISTEN_PID": strconv.Itoa(self + 1), "LISTEN_FDS": "1"}, 0},
		{"count missing", map[string]string{"LISTEN_PID": strconv.Itoa(self)}, 0},
		{"count not a number", map[string]string{"LISTEN_PID": strconv.Itoa(self), "LISTEN_FDS": "many"}, 0},
		{"count zero", map[string]string{"LISTEN_PID": strconv.Itoa(self), "LISTEN_FDS": "0"}, 0},
		{"count negative", map[string]string{"LISTEN_PID": strconv.Itoa(self), "LISTEN_FDS": "-1"}, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := systemdListenFDs(fakeGetenv(c.env), self); got != c.want {
				t.Errorf("systemdListenFDs(%v) = %d, want %d", c.env, got, c.want)
			}
		})
	}
}

// Fallback path: no socket activation, so hostd creates the socket itself — including
// the /run/orbit directory, which does not survive a reboot.
func TestHostdListenCreatesItsOwnSocketWhenNotActivated(t *testing.T) {
	path := filepath.Join(t.TempDir(), "orbit", "host.sock")
	l, err := hostdListen(hostdConfig{socketPath: path, getenv: fakeGetenv(nil)})
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("socket was not created: %v", err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("%s is not a socket (mode %v)", path, info.Mode())
	}
	// Any local user must be able to connect; who they are is settled by SO_PEERCRED.
	if perm := info.Mode().Perm(); perm != hostdSocketPerm {
		t.Errorf("socket mode = %o, want %o", perm, hostdSocketPerm)
	}

	conn, err := net.Dial("unix", path)
	if err != nil {
		t.Fatalf("nothing is listening on the socket we just created: %v", err)
	}
	conn.Close()
}

// A socket file left behind by a crash is stale and must be replaced; one with a live
// hostd behind it must not be, or a foreground run would silently steal the machine's
// broker from the activated one.
func TestHostdListenReplacesAStaleSocketButNotALiveOne(t *testing.T) {
	dir := t.TempDir()

	// What a crashed hostd leaves behind: the socket file, with nobody behind it.
	stale := filepath.Join(dir, "stale.sock")
	crashed, err := net.Listen("unix", stale)
	if err != nil {
		t.Fatal(err)
	}
	crashed.(*net.UnixListener).SetUnlinkOnClose(false)
	crashed.Close()
	l, err := hostdListen(hostdConfig{socketPath: stale, getenv: fakeGetenv(nil)})
	if err != nil {
		t.Fatalf("a stale socket should be replaced, got: %v", err)
	}
	defer l.Close()

	if _, err := hostdListen(hostdConfig{socketPath: stale, getenv: fakeGetenv(nil)}); err == nil {
		t.Fatal("a second hostd took over a socket that was still being served")
	}
}

// Socket-activation path: systemd holds the listening socket and passes it as fd 3.
func TestHostdListenAdoptsTheSocketSystemdPassedIn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "passed.sock")
	seed, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	ul := seed.(*net.UnixListener)
	// systemd, not this process, owns the socket file — same as the real handover.
	ul.SetUnlinkOnClose(false)
	f, err := ul.File()
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	// Hand hostd a descriptor of its own, the way an exec would.
	fd, err := syscall.Dup(int(f.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	seed.Close()

	unused := filepath.Join(t.TempDir(), "unused.sock")
	l, err := hostdListen(hostdConfig{
		socketPath: unused,
		getenv:     fakeGetenv(map[string]string{"LISTEN_PID": strconv.Itoa(os.Getpid()), "LISTEN_FDS": "1"}),
		listenFD:   fd,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()

	if _, err := os.Stat(unused); !os.IsNotExist(err) {
		t.Error("hostd created its own socket instead of adopting the one it was passed")
	}
	go func() {
		if c, err := net.Dial("unix", path); err == nil {
			c.Close()
		}
	}()
	conn, err := l.Accept()
	if err != nil {
		t.Fatalf("the adopted listener does not accept: %v", err)
	}
	conn.Close()
}

// Idle exit is what makes socket activation work: hostd goes away when nothing is
// asking, systemd keeps the socket, and the next connect starts whatever binary is on
// disk by then.
func TestHostdServeExitsWhenIdle(t *testing.T) {
	idle := 150 * time.Millisecond
	l, err := net.Listen("unix", filepath.Join(t.TempDir(), "idle.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()

	done := make(chan error, 1)
	start := time.Now()
	go func() { done <- hostdServe(l, hostdConfig{idleTimeout: idle}, nil) }()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("idle exit should be a clean return, got %v", err)
		}
		if elapsed := time.Since(start); elapsed < idle {
			t.Fatalf("exited after %v, before the %v idle window elapsed", elapsed, idle)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("hostd did not exit after going idle")
	}
}

// A negative timeout is the foreground/debug escape hatch: serve until told to stop.
func TestHostdServeWithoutIdleTimeoutRunsUntilTheListenerCloses(t *testing.T) {
	l, err := net.Listen("unix", filepath.Join(t.TempDir(), "forever.sock"))
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- hostdServe(l, hostdConfig{idleTimeout: -1}, nil) }()

	select {
	case <-done:
		t.Fatal("hostd exited on its own with the idle timeout disabled")
	case <-time.After(100 * time.Millisecond):
	}
	l.Close()
	select {
	case err := <-done:
		if err == nil {
			t.Error("a closed listener is not an idle exit; it should be reported")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("hostd kept serving a closed listener")
	}
}

func TestHostdConfigDefaults(t *testing.T) {
	cfg := hostdConfig{}.withDefaults()
	if cfg.socketPath != "/run/orbit/host.sock" {
		t.Errorf("socketPath = %q", cfg.socketPath)
	}
	if cfg.idleTimeout != 30*time.Second {
		t.Errorf("idleTimeout = %v", cfg.idleTimeout)
	}
	if cfg.listenFD != 3 {
		t.Errorf("listenFD = %d, want the sd_listen_fds first descriptor", cfg.listenFD)
	}
	if cfg.pid != os.Getpid() || cfg.getenv == nil {
		t.Errorf("pid = %d, getenv set = %v", cfg.pid, cfg.getenv != nil)
	}
}

func fakeGetenv(vars map[string]string) func(string) string {
	return func(key string) string { return vars[key] }
}
