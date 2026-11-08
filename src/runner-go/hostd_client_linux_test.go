package main

import (
	"errors"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The whole point of the broker path, end to end: `orbit register` and `orbit
// unregister` on a host that has been set up reach the runner through a socket, and
// nothing anywhere near them shells out to sudo or systemctl.
func TestRegisterAndUnregisterGoThroughTheBrokerWithoutRoot(t *testing.T) {
	asked, path := serveStubHostd(t)
	commands := recordCommands(t)
	unit := unitForUid(uint32(os.Getuid()))

	var svc *runnerService
	out := captureServiceOutput(t, func() {
		var err error
		svc, err = setupServiceLinux(path, nil, func() (*runnerService, error) {
			t.Error("the sudo path ran even though the broker enabled the runner")
			return nil, nil
		})
		if err != nil {
			t.Errorf("register: %v", err)
		}
	})
	if got := *asked; len(got) != 1 || got[0] != "enable" {
		t.Fatalf("broker was asked %v, want exactly [enable]", got)
	}
	// The service register waits on is the unit the broker says it started.
	if svc == nil || svc.unit != unit || svc.how != "runs at boot" {
		t.Fatalf("register's service step returned %+v, want unit %s that runs at boot", svc, unit)
	}
	// Started is said once the control plane has heard from the runner (startService), not
	// when the broker answers.
	if strings.Contains(out, "Background service started") {
		t.Errorf("register said the service started before anything heard from it:\n%s", out)
	}
	out = captureServiceOutput(t, func() { printServiceStarted(svc.how) })
	user := "this account"
	if u, err := registeringUser(); err == nil {
		user = u.Username
	}
	for _, want := range []string{
		"Background service started as " + user,
		"(runs at boot)",
		"Stop or remove it later with `orbit unregister`",
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
		if _, err := setupServiceLinux(absent, nil, func() (*runnerService, error) { installed = true; return nil, nil }); err != nil {
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
		if _, err := setupServiceLinux(path, nil, func() (*runnerService, error) { installed = true; return nil, nil }); err != nil {
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
		if _, err := setupServiceLinux(path, nil, func() (*runnerService, error) { installed = true; return nil, nil }); err != nil {
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

// A broker that takes the connection and then goes quiet may be draining an older runner,
// and is never gone around: the sudo path would install a unit beside the instance it is
// about to start. Register and unregister wait for it, say so, and after hostdAnswerWait
// stop with the reason, with no sudo fallback. This runs the product chain —
// setupServiceLinux → registerViaHostd → hostdDo → hostdCall — so that dropping hostdCall's
// deadline, or falling through to the legacy closure, fails here rather than passing on a
// test's private copy of the behaviour.
func TestASilentBrokerIsWaitedForAndNeverRoutedToSudo(t *testing.T) {
	silent := make(chan struct{})
	defer close(silent)
	path := serveRawHostd(t, func(conn net.Conn) {
		<-silent // accept, read nothing, answer nothing
	})
	shortenHostdTimeout(t)
	commands := recordCommands(t)

	errs := make(chan error, 1)
	out := captureServiceOutput(t, func() {
		mustGiveUp(t, "register", func() {
			_, err := setupServiceLinux(path, nil, func() (*runnerService, error) {
				t.Error("the sudo path ran while the broker may still be carrying out the enable")
				return nil, nil
			})
			if err != nil {
				printServiceFailure(os.Stderr, err)
			}
			errs <- err
		})
	})
	var refused *hostdRegisterRefusal
	if err := <-errs; !errors.As(err, &refused) || refused.code != hostdNoAnswer {
		t.Fatalf("register's service step returned %v, want the %q stop", err, hostdNoAnswer)
	}
	for _, want := range []string{`Waiting for the machine broker to finish "enable"`, path, "has not answered within", "stops here rather than go around it"} {
		if !strings.Contains(out, want) {
			t.Errorf("register output must say %q; got:\n%s", want, out)
		}
	}
	for _, never := range []string{"sudo", "falling back", "Start it in the foreground"} {
		if strings.Contains(out, never) {
			t.Errorf("register output says %q; got:\n%s", never, out)
		}
	}

	out = captureServiceOutput(t, func() {
		mustGiveUp(t, "unregister", func() {
			uninstallServiceLinux(path, func() { t.Error("the sudo removal ran while the broker may still be carrying out the disable") })
		})
	})
	if !strings.Contains(out, `Waiting for the machine broker to finish "disable"`) || !strings.Contains(out, "has not answered within") {
		t.Errorf("unregister output does not say it waited and why it stopped; got:\n%s", out)
	}
	if strings.Contains(out, "sudo") {
		t.Errorf("unregister output mentions sudo; got:\n%s", out)
	}
	if len(*commands) != 0 {
		t.Fatalf("the broker path shelled out to %v", *commands)
	}
}

// A broker draining an older runner answers enable long after hostdCallTimeout's five
// seconds, and past hostd's own hostdConnTimeout of ten: register waits for it, says it is
// waiting, and takes the instance it started, with no sudo fallback. Real timeouts, a real
// hostd serving loop over a real socket.
func TestABrokerThatAnswersAfterMoreThanFiveSecondsIsWaitedFor(t *testing.T) {
	const drain = 11 * time.Second
	if drain <= hostdCallTimeout || drain <= hostdConnTimeout {
		t.Fatalf("fixture: a drain of %s is not past hostdCallTimeout (%s) and hostdConnTimeout (%s)", drain, hostdCallTimeout, hostdConnTimeout)
	}
	path, stop := startHostd(t, map[string]hostdVerb{
		"enable": func(peer hostdPeer, _ hostdRequest) hostdResponse {
			time.Sleep(drain)
			return hostdOK(map[string]any{"uid": peer.UID, "unit": testUnit})
		},
	})
	defer stop()
	commands := recordCommands(t)

	var svc *runnerService
	start := time.Now()
	out := captureServiceOutput(t, func() {
		var err error
		svc, err = setupServiceLinux(path, nil, func() (*runnerService, error) {
			t.Error("the sudo path ran while the broker was still draining")
			return nil, nil
		})
		if err != nil {
			t.Errorf("register: %v", err)
		}
	})
	if took := time.Since(start); took < drain {
		t.Errorf("register returned after %s, before the broker answered", took)
	}
	if svc == nil || svc.unit != testUnit {
		t.Fatalf("register's service step returned %+v, want the instance the broker started, %s", svc, testUnit)
	}
	if !strings.Contains(out, `Waiting for the machine broker to finish "enable" — it may be draining an older runner`) {
		t.Errorf("register did not say it was waiting; got:\n%s", out)
	}
	for _, never := range []string{"sudo", "falling back"} {
		if strings.Contains(out, never) {
			t.Errorf("register output says %q; got:\n%s", never, out)
		}
	}
	if len(*commands) != 0 {
		t.Fatalf("the broker path shelled out to %v", *commands)
	}
}

// hostd's refusal to enable while an older runner unit of the account will not go down is
// not one to route around either: register stops at it with hostd's message and no sudo
// fallback, whose unit would be yet another runner beside it. Unregister prints disable's
// report and does not reach for the sudo removal, which would remove the unit file of a
// unit that is still running. Each answer is the real verb's, served over a real socket to
// the real client chain.
func TestRegisterStopsAtTheBrokersOlderRunnerRefusalWithoutSudo(t *testing.T) {
	f, sys := newFakeSystem(t)
	setInstance(f, testUidUnit, strconv.Itoa(testUID), "enabled", "active")
	f.fail["systemctl stop "+testUidUnit] = errors.New("exit status 4")
	f.stdout["systemctl stop "+testUidUnit] = "Failed to stop " + testUidUnit + ": Operation refused, unit " + testUidUnit + " may be requested by dependency only (it is configured to refuse manual start/stop).\n"
	enable := sys.verbs()["enable"](testPeer, hostdRequest{V: 1, Verb: "enable"})
	disable := sys.verbs()["disable"](testPeer, hostdRequest{V: 1, Verb: "disable"})
	if enable.OK || enable.Code != hostdRefusedOlderRunner || disable.OK || disable.Code != hostdRefusedOlderRunner {
		t.Fatalf("fixture: enable = %+v, disable = %+v, want both older-runner refusals", enable, disable)
	}
	path, stop := startHostd(t, map[string]hostdVerb{
		"enable":  func(hostdPeer, hostdRequest) hostdResponse { return enable },
		"disable": func(hostdPeer, hostdRequest) hostdResponse { return disable },
	})
	defer stop()
	commands := recordCommands(t)

	var err error
	out := captureServiceOutput(t, func() {
		_, err = setupServiceLinux(path, nil, func() (*runnerService, error) {
			t.Error("the sudo path ran although the account's older runner is still up")
			return nil, nil
		})
		if err != nil {
			printServiceFailure(os.Stderr, err)
		}
	})
	var refused *hostdRegisterRefusal
	if !errors.As(err, &refused) || refused.code != hostdRefusedOlderRunner {
		t.Fatalf("register's service step returned %v, want the broker's older-runner refusal", err)
	}
	if want := "✗ Could not start the background service: " + enable.Error + "\n"; !strings.Contains(out, want) {
		t.Errorf("register output must carry hostd's message whole, %q; got:\n%s", want, out)
	}
	for _, never := range []string{"sudo", "falling back", "Start it in the foreground"} {
		if strings.Contains(out, never) {
			t.Errorf("register output says %q; got:\n%s", never, out)
		}
	}

	out = captureServiceOutput(t, func() {
		uninstallServiceLinux(path, func() { t.Error("the sudo removal ran although the account's older runner is still up") })
	})
	if !strings.Contains(out, disable.Error) || strings.Contains(out, "sudo") || strings.Contains(out, "removed the") {
		t.Errorf("unregister output must carry disable's report and claim no removal; got:\n%s", out)
	}
	if len(*commands) != 0 {
		t.Fatalf("register shelled out to %v", *commands)
	}
}

// The shared template carries no per-user environment, so a proxy the legacy path would
// have baked into its own unit is not carried over. Say so rather than let the runner
// come up unproxied and leave the user to work out why.
func TestRegisterWarnsThatTheSharedTemplateDropsTheProxy(t *testing.T) {
	_, path := serveStubHostd(t)
	proxy := proxyServiceEnv("http://proxy.internal:3128", "https://orbit.example", "")

	out := captureServiceOutput(t, func() {
		if _, err := setupServiceLinux(path, proxy, func() (*runnerService, error) { t.Error("fell back"); return nil, nil }); err != nil {
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

	unit := unitForAccount("tester")
	assertArgv(t, f.ran, []string{"systemctl", "disable", "--now", unit})
	if !strings.Contains(out, "removed the "+unit) {
		t.Errorf("unregister output does not report the removal; got:\n%s", out)
	}
	// The systemctl above was hostd's, on the far side of the socket. This side ran
	// nothing — that is the difference the whole change is about.
	if len(*commands) != 0 {
		t.Fatalf("the client shelled out to %v", *commands)
	}
}

// hostd's enable refusing an account with no copy of its own to run is not a refusal to route
// around: `orbit register` stops at it, prints the broker's reason and its one command, and
// never reaches for the sudo path, whose unit would run another binary beside the template.
// Each refusal is the real enable verb's, served over a real socket to the real client chain.
func TestRegisterStopsAtTheBrokersOwnCopyRefusalWithoutSudo(t *testing.T) {
	for _, tc := range []struct {
		name    string
		arrange func(f *fakeSystem, sys *hostdSystem)
		want    []string
	}{{
		name:    "no executable copy",
		arrange: func(f *fakeSystem, _ *hostdSystem) { f.executable = false },
		want: []string{
			"✗ Could not start the background service: refusing to enable orbit-runner@alice.service: it runs alice's own ~/.orbit/bin/orbit, and /home/alice/.orbit/bin/orbit is missing or alice cannot execute it. Put a copy there, then run `orbit register` again:\n" +
				"  mkdir -p -m 0700 ~/.orbit && install -D -m 0755 /usr/local/bin/orbit ~/.orbit/bin/orbit\n",
		},
	}, {
		name: "no home",
		arrange: func(_ *fakeSystem, sys *hostdSystem) {
			sys.lookupUID = func(uid string) (*user.User, error) {
				return &user.User{Uid: uid, Gid: uid, Username: testUser, HomeDir: "/nonexistent"}, nil
			}
		},
		want: []string{`alice has no home directory to keep it in (the passwd database gives "/nonexistent"). Register from an account that has a home directory.`},
	}, {
		name:    "a copy that could not be checked",
		arrange: func(f *fakeSystem, _ *hostdSystem) { f.checkErr = errors.New("no answer within 3s") },
		want:    []string{"hostd could not check /home/alice/.orbit/bin/orbit as alice: no answer within 3s."},
	}} {
		t.Run(tc.name, func(t *testing.T) {
			f, sys := newFakeSystem(t)
			tc.arrange(f, &sys)
			refusal := sys.verbs()["enable"](testPeer, hostdRequest{V: 1, Verb: "enable"})
			if refusal.OK || refusal.Code != hostdRefusedOwnCopy {
				t.Fatalf("fixture: enable = %+v, want the own-copy refusal", refusal)
			}
			path, stop := startHostd(t, map[string]hostdVerb{
				"enable": func(hostdPeer, hostdRequest) hostdResponse { return refusal },
			})
			defer stop()
			commands := recordCommands(t)

			var err error
			out := captureServiceOutput(t, func() {
				_, err = setupServiceLinux(path, nil, func() (*runnerService, error) {
					t.Error("the sudo path ran although the broker said the account has no copy of its own")
					return nil, nil
				})
				if err != nil {
					printServiceFailure(os.Stderr, err)
				}
			})
			var refused *hostdRegisterRefusal
			if !errors.As(err, &refused) {
				t.Fatalf("register's service step returned %v, want the broker's refusal", err)
			}
			for _, want := range tc.want {
				if !strings.Contains(out, want) {
					t.Errorf("register output must say %q; got:\n%s", want, out)
				}
			}
			for _, never := range []string{"sudo", "falling back", "Start it in the foreground"} {
				if strings.Contains(out, never) {
					t.Errorf("register output says %q; got:\n%s", never, out)
				}
			}
			if len(*commands) != 0 {
				t.Fatalf("register shelled out to %v", *commands)
			}
		})
	}
}

// uid 0's refusal is the one the sudo path still takes, as it always has: root's runner is a
// legacy unit, never an instance, and the broker carries no code for it.
func TestRootsRefusalStillFallsBackToTheSudoPath(t *testing.T) {
	_, sys := newFakeSystem(t)
	refusal := sys.verbs()["enable"](hostdPeer{UID: 0, PID: 7}, hostdRequest{V: 1, Verb: "enable"})
	if refusal.OK || refusal.Code != "" {
		t.Fatalf("fixture: root's enable = %+v, want a plain refusal", refusal)
	}
	path, stop := startHostd(t, map[string]hostdVerb{
		"enable": func(hostdPeer, hostdRequest) hostdResponse { return refusal },
	})
	defer stop()

	installed := false
	out := captureServiceOutput(t, func() {
		if _, err := setupServiceLinux(path, nil, func() (*runnerService, error) { installed = true; return nil, nil }); err != nil {
			t.Error(err)
		}
	})
	if !installed {
		t.Error("root's refused enable must still leave the runner installed the old way")
	}
	if want := `note: the machine broker refused "enable" (refusing to enable orbit-runner@root.service: the runner must not run as root`; !strings.Contains(out, want) {
		t.Errorf("register output must say %q; got:\n%s", want, out)
	}
	if !strings.Contains(out, "falling back to the sudo path") {
		t.Errorf("register output does not say it falls back; got:\n%s", out)
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
