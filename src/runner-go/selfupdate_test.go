package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func setTestVersion(t *testing.T, v string) {
	t.Helper()
	old := version
	version = v
	t.Cleanup(func() { version = old })
}

// setTestInstallable pins whether an update is considered swappable, so these
// tests do not depend on where the test binary happens to live.
func setTestInstallable(t *testing.T, dir string, ok bool) {
	t.Helper()
	old := selfUpdateInstallable
	selfUpdateInstallable = func() (string, bool) { return dir, ok }
	t.Cleanup(func() { selfUpdateInstallable = old })
}

func TestAvailableSelfUpdate(t *testing.T) {
	if platformKey() == "" {
		t.Skip("self-update is unsupported on this test platform")
	}
	setTestVersion(t, "0.1.80")
	setTestInstallable(t, "/usr/local/bin", true)
	t.Setenv("ORBIT_NO_SELFUPDATE", "")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/dl/version.json" {
			t.Errorf("path = %q, want /dl/version.json", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"version":"0.1.81"}`))
	}))
	defer srv.Close()

	got, ok := availableSelfUpdate(context.Background(), srv.URL+"/")
	if !ok || got != "0.1.81" {
		t.Fatalf("availableSelfUpdate = %q, %v; want 0.1.81, true", got, ok)
	}
}

// A runner whose binary sits in a root-owned directory can never swap itself.
// Reporting the release anyway made runLoop drain and re-exec every check
// interval, tearing live sessions down mid-turn forever at an unchanged version.
func TestAvailableSelfUpdateSkipsUninstallableRelease(t *testing.T) {
	if platformKey() == "" {
		t.Skip("self-update is unsupported on this test platform")
	}
	setTestVersion(t, "0.1.86")
	setTestInstallable(t, "/usr/local/bin", false)
	t.Setenv("ORBIT_NO_SELFUPDATE", "")
	// Pin the "no broker on this machine" branch rather than inheriting whatever the host
	// running the tests happens to have at /run/orbit/host.sock.
	pointRunnerAtBroker(t, filepath.Join(t.TempDir(), "absent.sock"))

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"version":"0.1.96"}`))
	}))
	defer srv.Close()

	if got, ok := availableSelfUpdate(context.Background(), srv.URL); ok || got != "" {
		t.Fatalf("availableSelfUpdate = %q, %v; want no drain for an uninstallable release", got, ok)
	}
}

func TestAvailableSelfUpdateIgnoresCurrentAndOlderVersions(t *testing.T) {
	if platformKey() == "" {
		t.Skip("self-update is unsupported on this test platform")
	}
	setTestVersion(t, "0.1.80")
	t.Setenv("ORBIT_NO_SELFUPDATE", "")

	for _, remote := range []string{"0.1.80", "0.1.79"} {
		t.Run(remote, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(`{"version":"` + remote + `"}`))
			}))
			defer srv.Close()
			if got, ok := availableSelfUpdate(context.Background(), srv.URL); ok || got != "" {
				t.Fatalf("availableSelfUpdate = %q, %v; want no update", got, ok)
			}
		})
	}
}

func TestAvailableSelfUpdateDisabledDoesNotFetch(t *testing.T) {
	if platformKey() == "" {
		t.Skip("self-update is unsupported on this test platform")
	}
	var requests atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		_, _ = w.Write([]byte(`{"version":"99.0.0"}`))
	}))
	defer srv.Close()

	t.Run("environment", func(t *testing.T) {
		setTestVersion(t, "0.1.80")
		t.Setenv("ORBIT_NO_SELFUPDATE", "1")
		if got, ok := availableSelfUpdate(context.Background(), srv.URL); ok || got != "" {
			t.Fatalf("availableSelfUpdate = %q, %v; want disabled", got, ok)
		}
	})
	t.Run("dev build", func(t *testing.T) {
		setTestVersion(t, "dev")
		t.Setenv("ORBIT_NO_SELFUPDATE", "")
		if got, ok := availableSelfUpdate(context.Background(), srv.URL); ok || got != "" {
			t.Fatalf("availableSelfUpdate = %q, %v; want disabled", got, ok)
		}
	})
	if got := requests.Load(); got != 0 {
		t.Fatalf("disabled self-update made %d request(s), want 0", got)
	}
}

// pointRunnerAtBroker aims the runner's update delegation at a socket of the test's own.
func pointRunnerAtBroker(t *testing.T, path string) {
	t.Helper()
	previous := hostdRunnerSocket
	hostdRunnerSocket = path
	t.Cleanup(func() { hostdRunnerSocket = previous })
}

// resetSelfUpdateLogGates lets a test observe the once-per-process lines: both the
// delegation and the blocked warning are deliberately logged once, so without this a test
// would only ever see whichever ran first in the binary.
func resetSelfUpdateLogGates(t *testing.T) {
	t.Helper()
	selfUpdateBlockedOnce = sync.Once{}
	selfUpdateDelegatedOnce = sync.Once{}
	t.Cleanup(func() {
		selfUpdateBlockedOnce = sync.Once{}
		selfUpdateDelegatedOnce = sync.Once{}
	})
}

// recordingBroker stands a broker up on a socket of the test's own, points the runner's
// delegation at it, answers every request with answer, and hands back what it was asked.
func recordingBroker(t *testing.T, answer hostdResponse) chan hostdRequest {
	t.Helper()
	asked := make(chan hostdRequest, 16)
	pointRunnerAtBroker(t, serveRawHostd(t, func(conn net.Conn) {
		var req hostdRequest
		if err := json.NewDecoder(conn).Decode(&req); err != nil {
			t.Error(err)
			return
		}
		asked <- req
		_ = json.NewEncoder(conn).Encode(answer)
	}))
	return asked
}

// The failure this task exists to end: a runner whose binary lives in a root-owned
// directory used to notice every release, install none of them, and say so once. With a
// broker on the machine it asks the broker instead — and does not drain for it, because
// the restart arrives from systemd once the new binary is in place. The heartbeat keeps
// the state it always reported, and its reason says who took the update.
func TestAvailableSelfUpdateDelegatesToTheHostBroker(t *testing.T) {
	if platformKey() == "" {
		t.Skip("self-update is unsupported on this test platform")
	}
	setTestVersion(t, "0.1.86")
	setTestInstallable(t, "/usr/local/bin", false)
	t.Setenv("ORBIT_NO_SELFUPDATE", "")
	t.Setenv("ORBIT_HOME", t.TempDir())
	resetSelfUpdateLogGates(t)
	resetSelfUpdateStatus(t)

	asked := recordingBroker(t, hostdOK(map[string]any{"version": "0.1.96", "accepted": true}))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"version":"0.1.96"}`))
	}))
	defer srv.Close()

	var got string
	var ok bool
	logged := captureRunnerStdout(t, func() { got, ok = availableSelfUpdate(context.Background(), srv.URL) })

	if ok || got != "" {
		t.Fatalf("availableSelfUpdate = %q, %v; a delegated update is not this runner's to drain for", got, ok)
	}
	select {
	case req := <-asked:
		if req.Verb != "update" || req.V != hostdProtocolVersion {
			t.Errorf("broker was asked %+v, want {v:%d, verb:update}", req, hostdProtocolVersion)
		}
	default:
		t.Fatal("the broker was never asked for an update")
	}
	if len(asked) != 0 {
		t.Errorf("the broker was asked %d extra times", len(asked))
	}
	if strings.Contains(logged, "not writable by this user") {
		t.Errorf("logged the blocked warning although the update was delegated:\n%s", logged)
	}
	if !strings.Contains(logged, "host broker") {
		t.Errorf("the delegation left no trace in the log:\n%s", logged)
	}
	r := assertSelfUpdateState(t, selfUpdateStateDirNotWritable,
		"delegated to the host broker at "+hostdRunnerSocket+": it is installing orbit 0.1.96 for every runner on this machine")
	if r.InstallDir != "/usr/local/bin" {
		t.Errorf("installDir = %q; want /usr/local/bin, the directory that is not writable", r.InstallDir)
	}
}

// The startup update finds the same blocked release the periodic check does, and hands it to
// the broker the same way: a runner restarted onto an old binary asks at once rather than a
// check interval later.
func TestSelfUpdateAtStartupDelegatesToTheHostBroker(t *testing.T) {
	resetSelfUpdateStatus(t)
	resetSelfUpdateLogGates(t)
	latest, previous := newRolloutRelease(t, rolloutTestLatest), newRolloutRelease(t, rolloutTestPrevious)
	exe, restarts := runnerOn(t, rolloutTestPrevious)
	current := fileBytes(t, exe)
	setTestInstallable(t, "/usr/local/bin", false)
	cp := serveRollout(t, latest, &previous, releaseAssignment{Version: rolloutTestLatest})
	registerWith(t, cp.srv.URL)
	asked := recordingBroker(t, hostdOK(map[string]any{"version": rolloutTestLatest, "accepted": true}))

	logged := captureRunnerStdout(t, func() { selfUpdate(cp.srv.URL) })

	if n := len(asked); n != 1 {
		t.Fatalf("the broker was asked %d times; want once", n)
	}
	if req := <-asked; req.Verb != "update" || req.V != hostdProtocolVersion {
		t.Errorf("broker was asked %+v, want {v:%d, verb:update}", req, hostdProtocolVersion)
	}
	assertInstalled(t, exe, current)
	if n := restarts.Load(); n != 0 || len(cp.seen(".gz")) != 0 {
		t.Errorf("restarted %d times after downloading %v; want neither — the broker installs it", n, cp.seen(".gz"))
	}
	if strings.Contains(logged, "sudo orbit upgrade") {
		t.Errorf("logged the blocked warning although the update was delegated:\n%s", logged)
	}
	assertSelfUpdateState(t, selfUpdateStateDirNotWritable,
		"delegated to the host broker at "+hostdRunnerSocket+": it is installing orbit "+rolloutTestLatest+" for every runner on this machine")
}

// Whatever the broker answers, the runner's state stays dirNotWritable — no new state for the
// control plane to learn — and the reason carries the answer in the broker's own terms.
func TestSelfUpdateDelegationReportsTheBrokersAnswer(t *testing.T) {
	if platformKey() == "" {
		t.Skip("self-update is unsupported on this test platform")
	}
	for _, tc := range []struct {
		name   string
		answer *hostdResponse // nil: the broker hangs up without one
		want   string
	}{
		{"accepted", &hostdResponse{OK: true, Data: map[string]any{"version": "0.1.96", "from": "0.1.86", "accepted": true}},
			"it is installing orbit 0.1.96 for every runner on this machine"},
		{"skipped", &hostdResponse{OK: true, Data: map[string]any{"skipped": true, "reason": "an update ran 1m0s ago"}},
			"it skipped the request (an update ran 1m0s ago)"},
		{"already current", &hostdResponse{OK: true, Data: map[string]any{"version": "0.1.96", "updated": false}},
			"it reports orbit 0.1.96 installed, the latest release published to every runner"},
		{"declined", &hostdResponse{Error: "refusing to update /usr/local/bin/orbit: it is a symlink"},
			"it declined: refusing to update /usr/local/bin/orbit: it is a symlink"},
		{"no answer", nil, `it did not answer: no answer to "update": EOF`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			setTestVersion(t, "0.1.86")
			setTestInstallable(t, "/usr/local/bin", false)
			t.Setenv("ORBIT_NO_SELFUPDATE", "")
			t.Setenv("ORBIT_HOME", t.TempDir())
			resetSelfUpdateLogGates(t)
			resetSelfUpdateStatus(t)
			pointRunnerAtBroker(t, serveRawHostd(t, func(conn net.Conn) {
				var req hostdRequest
				_ = json.NewDecoder(conn).Decode(&req)
				if tc.answer != nil {
					_ = json.NewEncoder(conn).Encode(*tc.answer)
				}
			}))
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(`{"version":"0.1.96"}`))
			}))
			defer srv.Close()

			var ok bool
			logged := captureRunnerStdout(t, func() { _, ok = availableSelfUpdate(context.Background(), srv.URL) })
			if ok {
				t.Fatal("availableSelfUpdate reported a release this runner cannot install")
			}
			assertSelfUpdateState(t, selfUpdateStateDirNotWritable, "delegated to the host broker at "+hostdRunnerSocket+": "+tc.want)
			if strings.Contains(logged, "sudo orbit upgrade") {
				t.Errorf("logged the blocked warning although there is a broker:\n%s", logged)
			}
		})
	}
}

// A runner a staged rollout holds back wants no release, so it asks the broker for none: with a
// broker on the machine it does exactly what it does on main without one, and reports the same.
func TestSelfUpdateHeldByRolloutLeavesTheBrokerAlone(t *testing.T) {
	latest, previous := newRolloutRelease(t, rolloutTestLatest), newRolloutRelease(t, rolloutTestPrevious)
	for _, tc := range []struct {
		name        string
		installable bool
		state       string
	}{
		{"install directory not writable", false, selfUpdateStateDirNotWritable},
		{"install directory writable", true, selfUpdateStateHeldByRollout},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetSelfUpdateStatus(t)
			resetSelfUpdateLogGates(t)
			exe, restarts := runnerOn(t, rolloutTestPrevious)
			current := fileBytes(t, exe)
			if !tc.installable {
				setTestInstallable(t, "/usr/local/bin", false)
			}
			cp := serveRollout(t, latest, &previous, releaseAssignment{Version: rolloutTestPrevious, HeldByRollout: true})
			registerWith(t, cp.srv.URL)
			asked := recordingBroker(t, hostdOK(map[string]any{"version": rolloutTestLatest, "accepted": true}))

			var ok bool
			logged := captureRunnerStdout(t, func() { _, ok = availableSelfUpdate(context.Background(), cp.srv.URL) })
			if ok {
				t.Fatal("updated although the rollout holds this runner at its release")
			}
			assertSelfUpdateState(t, tc.state, "")
			resetSelfUpdateStatus(t)
			logged += captureRunnerStdout(t, func() { selfUpdate(cp.srv.URL) })
			assertSelfUpdateState(t, tc.state, "")

			if from, held := heldByRollout(); !held || from != rolloutTestLatest {
				t.Errorf("heldByRollout = %q, %v; want %s, true", from, held, rolloutTestLatest)
			}
			if n := len(asked); n != 0 {
				t.Errorf("asked the broker %d times for a release the rollout holds back", n)
			}
			if strings.Contains(logged, "host broker") || strings.Contains(logged, "cannot be installed") {
				t.Errorf("logged about a release this runner does not want:\n%s", logged)
			}
			assertInstalled(t, exe, current)
			if n := restarts.Load(); n != 0 || len(cp.seen(".gz")) != 0 {
				t.Errorf("restarted %d times after downloading %v; want neither", n, cp.seen(".gz"))
			}
		})
	}
}

// Without a broker nothing has changed: the warning is still the only thing standing
// between a pinned runner and silence.
func TestAvailableSelfUpdateStillWarnsWhenThereIsNoBroker(t *testing.T) {
	if platformKey() == "" {
		t.Skip("self-update is unsupported on this test platform")
	}
	setTestVersion(t, "0.1.86")
	setTestInstallable(t, "/usr/local/bin", false)
	t.Setenv("ORBIT_NO_SELFUPDATE", "")
	t.Setenv("ORBIT_HOME", t.TempDir())
	resetSelfUpdateLogGates(t)
	resetSelfUpdateStatus(t)
	pointRunnerAtBroker(t, filepath.Join(t.TempDir(), "absent.sock"))

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"version":"0.1.96"}`))
	}))
	defer srv.Close()

	var got string
	var ok bool
	logged := captureRunnerStdout(t, func() { got, ok = availableSelfUpdate(context.Background(), srv.URL) })

	if ok || got != "" {
		t.Fatalf("availableSelfUpdate = %q, %v; want no drain for an uninstallable release", got, ok)
	}
	if !strings.Contains(logged, "not writable by this user") {
		t.Errorf("a runner with no broker was pinned without saying so:\n%s", logged)
	}
	assertSelfUpdateState(t, selfUpdateStateDirNotWritable, "")
}
