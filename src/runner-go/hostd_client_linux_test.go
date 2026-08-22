package main

import (
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// The whole point of the broker path, end to end: `orbit register` and `orbit
// unregister` on a host that has been set up reach the runner through a socket, and
// nothing anywhere near them shells out to sudo or systemctl.
func TestRegisterAndUnregisterGoThroughTheBrokerWithoutRoot(t *testing.T) {
	asked, path := serveStubHostd(t)
	commands := recordCommands(t)
	unit := unitForUid(uint32(os.Getuid()))

	out := captureServiceOutput(t, func() {
		err := setupServiceLinux(path, nil, func() error {
			t.Error("the sudo path ran even though the broker enabled the runner")
			return nil
		})
		if err != nil {
			t.Errorf("register: %v", err)
		}
	})
	if got := *asked; len(got) != 1 || got[0] != "enable" {
		t.Fatalf("broker was asked %v, want exactly [enable]", got)
	}
	for _, want := range []string{
		unit,
		"Status:  systemctl status " + unit,
		"Logs:    journalctl -u " + unit + " -f",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("register output missing %q; got:\n%s", want, out)
		}
	}

	out = captureServiceOutput(t, func() {
		uninstallServiceLinux(path, func() {
			t.Error("the sudo path ran even though the broker disabled the runner")
		})
	})
	if got := *asked; len(got) != 2 || got[1] != "disable" {
		t.Fatalf("broker was asked %v, want [enable disable]", got)
	}
	if !strings.Contains(out, "removed the "+unit) {
		t.Errorf("unregister output does not report the removal; got:\n%s", out)
	}

	if len(*commands) != 0 {
		t.Fatalf("the broker path shelled out to %v; it must run no commands at all", *commands)
	}
}

// A machine nobody ran `orbit host setup` on has no socket, and that is not a problem
// worth reporting: it is simply a machine that installs its unit the old way.
func TestNoBrokerFallsBackToSudoSilently(t *testing.T) {
	absent := filepath.Join(t.TempDir(), "host.sock")

	installed := false
	out := captureServiceOutput(t, func() {
		if err := setupServiceLinux(absent, nil, func() error { installed = true; return nil }); err != nil {
			t.Error(err)
		}
	})
	if !installed {
		t.Fatal("register did not fall back to the sudo install")
	}
	if strings.TrimSpace(out) != "" {
		t.Errorf("a machine with no broker should say nothing about it; got:\n%s", out)
	}

	removed := false
	out = captureServiceOutput(t, func() { uninstallServiceLinux(absent, func() { removed = true }) })
	if !removed {
		t.Fatal("unregister did not fall back to the sudo removal")
	}
	if strings.TrimSpace(out) != "" {
		t.Errorf("a machine with no broker should say nothing about it; got:\n%s", out)
	}
}

// A broker that answers "no" is a different story from one that is not there: the
// machine was set up, so the user is told what it said before the sudo path takes over.
func TestABrokerThatRefusesSaysWhyAndStillFallsBack(t *testing.T) {
	const reason = "uid 4242 has no account on this machine"
	path, stop := startHostd(t, map[string]hostdVerb{
		"enable":  func(hostdPeer, hostdRequest) hostdResponse { return hostdFail("%s", reason) },
		"disable": func(hostdPeer, hostdRequest) hostdResponse { return hostdFail("%s", reason) },
	})
	defer stop()

	installed := false
	out := captureServiceOutput(t, func() {
		if err := setupServiceLinux(path, nil, func() error { installed = true; return nil }); err != nil {
			t.Error(err)
		}
	})
	if !installed {
		t.Error("a refused enable must still leave the runner installed the old way")
	}
	if !strings.Contains(out, reason) {
		t.Errorf("register output does not say why the broker refused; got:\n%s", out)
	}

	removed := false
	out = captureServiceOutput(t, func() { uninstallServiceLinux(path, func() { removed = true }) })
	if !removed {
		t.Error("a refused disable must still fall back to the sudo removal")
	}
	if !strings.Contains(out, reason) {
		t.Errorf("unregister output does not say why the broker refused; got:\n%s", out)
	}
}

// A socket file with nothing behind it is what a crashed broker leaves. The user hears
// about that one — the machine was set up, so silence would be misleading.
func TestADeadSocketSaysWhyAndFallsBack(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host.sock")
	l, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	// Go unlinks a socket it created when the listener closes; a broker that crashed
	// did not get that courtesy, and the file it left is the case under test.
	l.(*net.UnixListener).SetUnlinkOnClose(false)
	l.Close()

	installed := false
	out := captureServiceOutput(t, func() {
		if err := setupServiceLinux(path, nil, func() error { installed = true; return nil }); err != nil {
			t.Error(err)
		}
	})
	if !installed {
		t.Error("a dead broker must not stop the registration")
	}
	if !strings.Contains(out, path) {
		t.Errorf("register output does not name the broker it could not reach; got:\n%s", out)
	}
}

// The shared template carries no per-user environment, so a proxy the legacy path would
// have baked into its own unit is not carried over. Say so rather than let the runner
// come up unproxied and leave the user to work out why.
func TestRegisterWarnsThatTheSharedTemplateDropsTheProxy(t *testing.T) {
	_, path := serveStubHostd(t)
	proxy := proxyServiceEnv("http://proxy.internal:3128", "https://orbit.example", "")

	out := captureServiceOutput(t, func() {
		if err := setupServiceLinux(path, proxy, func() error { t.Error("fell back"); return nil }); err != nil {
			t.Error(err)
		}
	})
	if !strings.Contains(out, "--proxy is not carried into") {
		t.Errorf("register output does not warn about the dropped proxy; got:\n%s", out)
	}
}

// The stubs above answer whatever they are asked, so they would keep passing if the
// client and the broker drifted onto different names for the same operation. This is
// the join: the client's verbs against hostd's actual table. "unknown verb" is the only
// failure worth naming here — a refusal on its merits still proves the verb exists.
func TestTheClientsVerbsAreOnesHostdActuallyServes(t *testing.T) {
	_, sys := newFakeSystem(t)
	path, stop := startHostd(t, sys.verbs())
	defer stop()

	for _, verb := range []string{"enable", "disable"} {
		resp, err := hostdCall(path, verb)
		if err != nil {
			t.Fatalf("%s: %v", verb, err)
		}
		if strings.Contains(resp.Error, "unknown verb") {
			t.Errorf("hostd does not serve %q — the client and the broker have drifted apart", verb)
		}
	}
}

// And the whole chain once, for effect: `orbit unregister` → socket → the real disable
// verb → the argv systemd would have been handed. disable rather than enable because
// enable is refused to uid 0 by design and this suite runs as root in CI.
func TestUnregisterReachesSystemdThroughTheRealBroker(t *testing.T) {
	uid := uint32(os.Getuid())
	f, sys := newFakeSystem(t)
	// The verbs refuse a uid with no account, and the suite's own uid is whatever the
	// machine running it happens to use.
	sys.lookupUID = fakeLookupUID(map[string]string{strconv.FormatUint(uint64(uid), 10): "tester"})
	path, stop := startHostd(t, sys.verbs())
	defer stop()
	commands := recordCommands(t)

	out := captureServiceOutput(t, func() {
		uninstallServiceLinux(path, func() { t.Error("fell back although the broker answered") })
	})

	assertArgv(t, f.ran, []string{"systemctl", "disable", "--now", unitForUid(uid)})
	if !strings.Contains(out, "removed the "+unitForUid(uid)) {
		t.Errorf("unregister output does not report the removal; got:\n%s", out)
	}
	// The systemctl above was hostd's, on the far side of the socket. This side ran
	// nothing — that is the difference the whole change is about.
	if len(*commands) != 0 {
		t.Fatalf("the client shelled out to %v", *commands)
	}
}

// serveStubHostd runs a real hostd — T1's server, real peer credentials — over verbs
// that record what they were asked and answer with the instance the kernel says the
// caller owns. Returns the recording and the socket path.
func serveStubHostd(t *testing.T) (*[]string, string) {
	t.Helper()
	var asked []string
	record := func(verb string) hostdVerb {
		return func(peer hostdPeer, _ hostdRequest) hostdResponse {
			asked = append(asked, verb)
			return hostdOK(map[string]any{"uid": peer.UID, "unit": unitForUid(peer.UID)})
		}
	}
	path, stop := startHostd(t, map[string]hostdVerb{"enable": record("enable"), "disable": record("disable")})
	t.Cleanup(stop)
	return &asked, path
}

// recordCommands swaps in command runners that execute nothing and remember everything,
// so a test can assert that a path ran no commands rather than trust that it didn't.
func recordCommands(t *testing.T) *[]string {
	t.Helper()
	var seen []string
	prevRun, prevQuiet := run, runQuiet
	run = func(name string, args ...string) error {
		seen = append(seen, strings.TrimSpace(name+" "+strings.Join(args, " ")))
		return nil
	}
	runQuiet = func(name string, args ...string) {
		seen = append(seen, strings.TrimSpace(name+" "+strings.Join(args, " ")))
	}
	t.Cleanup(func() { run, runQuiet = prevRun, prevQuiet })
	return &seen
}

// captureServiceOutput collects both streams fn writes to. The register path prints its
// result to stdout and its reasons to stderr, and reading only one of them would miss
// half of what the user actually sees.
func captureServiceOutput(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	prevOut, prevErr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = w, w
	collected := make(chan string, 1)
	go func() {
		b, _ := io.ReadAll(r)
		collected <- string(b)
	}()

	fn()

	os.Stdout, os.Stderr = prevOut, prevErr
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	out := <-collected
	r.Close()
	return out
}
