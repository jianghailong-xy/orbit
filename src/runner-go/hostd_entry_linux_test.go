package main

import (
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// What `orbit hostd` has to be: the socket systemd hands over (or one it opens itself),
// serving the same verb table hostd_verbs.go builds — not a second copy of the verb
// list that drifts from it. Linux-only, like everything that authenticates a caller
// with SO_PEERCRED.

// entryIdle is long enough that the requests below never race the idle timer, and short
// enough that a test still ends when they are done.
const entryIdle = time.Second

// Fallback path: no socket activation, so the entry opens the socket itself — the case
// `orbit hostd --foreground` and the E2E's first connect both go through.
func TestHostdEntryServesTheRealVerbsOnASocketItOpensItself(t *testing.T) {
	path := filepath.Join(t.TempDir(), "orbit", "host.sock")
	cfg := hostdConfig{socketPath: path, idleTimeout: entryIdle, getenv: fakeGetenv(nil)}

	done := make(chan error, 1)
	go func() { done <- cmdHostd(cfg, hostdEntrySystem(t), false, io.Discard) }()
	waitForSocket(t, path)

	// A real answer from the real status verb: an empty table would come back "unknown
	// verb", and a table wired to something other than hostdSystem could not report the
	// state the fake systemctl was taught.
	resp := hostdAsk(t, path, `{"v":1,"verb":"status"}`)
	if !resp.OK {
		t.Fatalf("status failed: %s", resp.Error)
	}
	if got, want := resp.Data["unit"], unitForUid(uint32(os.Getuid())); got != want {
		t.Errorf("status unit = %v, want %v (this process's own instance)", got, want)
	}
	if got := resp.Data["activeState"]; got != "active" {
		t.Errorf("activeState = %v, want the state systemctl reported", got)
	}

	// And the whole table, not just the one verb above. Iterated rather than listed, so
	// a verb added to hostd_verbs.go is covered here without this test being edited —
	// which is the only way a test can hold "there is exactly one verb list".
	for verb := range hostdSystemDefaults().verbs() {
		// The response may well be a refusal (uid 0 gets no runner brought up); what it
		// must never be is "this daemon has never heard of that verb".
		if resp := hostdAsk(t, path, `{"v":1,"verb":"`+verb+`"}`); strings.Contains(resp.Error, "unknown verb") {
			t.Errorf("the entry does not serve %q, which hostdSystem.verbs() advertises", verb)
		}
	}

	assertIdleExit(t, done)
}

// Socket-activation path: systemd holds the listening socket across calls and passes it
// in as fd 3, which is how orbit-hostd.socket starts orbit-hostd.service.
func TestHostdEntryAdoptsTheSocketSystemdPassedIn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "passed.sock")
	seed, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	ul := seed.(*net.UnixListener)
	// The socket file belongs to systemd, not to whoever serves it.
	ul.SetUnlinkOnClose(false)
	f, err := ul.File()
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	// A descriptor of the entry's own, the way an exec would leave one.
	fd, err := syscall.Dup(int(f.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	seed.Close()

	unused := filepath.Join(t.TempDir(), "unused.sock")
	cfg := hostdConfig{
		socketPath:  unused,
		idleTimeout: entryIdle,
		getenv:      fakeGetenv(map[string]string{"LISTEN_PID": strconv.Itoa(os.Getpid()), "LISTEN_FDS": "1"}),
		listenFD:    fd,
	}
	done := make(chan error, 1)
	go func() { done <- cmdHostd(cfg, hostdEntrySystem(t), false, io.Discard) }()

	if resp := hostdAsk(t, path, `{"v":1,"verb":"status"}`); !resp.OK {
		t.Fatalf("status over the passed-in socket failed: %s", resp.Error)
	}
	if _, err := os.Stat(unused); !os.IsNotExist(err) {
		t.Error("the entry opened its own socket instead of adopting the one systemd passed")
	}

	assertIdleExit(t, done)
}

// The debug switch: no idle exit (a broker that disappeared 30s into a session is
// exactly what makes one hard to watch) and a line on stderr saying which socket it
// took.
func TestHostdEntryForegroundKeepsServingAndReportsItsSocketOnStderr(t *testing.T) {
	path := filepath.Join(t.TempDir(), "foreground.sock")
	blink := 50 * time.Millisecond
	stderr := &lockedWriter{}

	// Deliberately never stopped: "runs until its listener closes" is the property under
	// test and the entry hands out no other handle on it, so this goroutine outlives the
	// test — serving a socket in the test's own temp dir, reachable by nothing else.
	go func() {
		_ = cmdHostd(hostdConfig{socketPath: path, idleTimeout: blink, getenv: fakeGetenv(nil)}, hostdEntrySystem(t), true, stderr)
	}()
	waitForSocket(t, path)

	// Well past the idle window it was configured with, which --foreground must override.
	time.Sleep(6 * blink)
	if resp := hostdAsk(t, path, `{"v":1,"verb":"status"}`); !resp.OK {
		t.Fatalf("foreground hostd stopped answering: %s", resp.Error)
	}
	if got := stderr.String(); !strings.Contains(got, path) || !strings.Contains(got, "foreground") {
		t.Errorf("stderr = %q, want the socket it took and that it is in the foreground", got)
	}
}

// hostdEntrySystem is the verbs' surroundings, faked: a systemctl that answers instead
// of running, and a passwd database that knows whoever is running the tests — the entry
// tests call over a real socket, so the peer uid is this process's own, not testUID.
func hostdEntrySystem(t *testing.T) hostdSystem {
	t.Helper()
	f, sys := newFakeSystem(t)
	self := uint32(os.Getuid())
	sys.lookupUID = fakeLookupUID(map[string]string{strconv.FormatUint(uint64(self), 10): "tester"})
	f.stdout["systemctl show "+unitForUid(self)+" -p ActiveState -p SubState"] = "ActiveState=active\nSubState=running\n"
	return sys
}

// waitForSocket blocks until the entry's listener is up, which it reaches on its own
// goroutine a moment after the test starts it.
func waitForSocket(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if conn, err := net.Dial("unix", path); err == nil {
			conn.Close()
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("nothing is listening on %s", path)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// assertIdleExit waits for the entry to return the way socket activation expects it to:
// quietly, once nobody has asked for a while.
func assertIdleExit(t *testing.T, done <-chan error) {
	t.Helper()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("idle exit should be a clean return, got %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the entry did not exit after going idle")
	}
}

// lockedWriter collects what the entry writes from its own goroutine while the test
// reads it from this one.
type lockedWriter struct {
	mu sync.Mutex
	b  strings.Builder
}

func (w *lockedWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.b.Write(p)
}

func (w *lockedWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.b.String()
}
