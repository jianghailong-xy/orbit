package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"strings"
	"testing"
)

// A runner whose install directory it can write — an instance on its account's own
// ~/.orbit/bin/orbit — updates itself and never hands its own update to the host broker. Once it
// has installed a release into its own copy, it asks the broker's update verb once, so that hostd's
// binary follows; whatever the broker answers is logged and never stops the update.

// followingBroker stands a broker up that answers update with answer (none at all when nil) and
// records, for each request, the verb and what the runner's own copy held at that moment.
func followingBroker(t *testing.T, exe string, answer *hostdResponse) chan []byte {
	t.Helper()
	asked := make(chan []byte, 16)
	pointRunnerAtBroker(t, serveRawHostd(t, func(conn net.Conn) {
		var req hostdRequest
		if err := json.NewDecoder(conn).Decode(&req); err != nil {
			t.Error(err)
			return
		}
		if req.Verb != "update" || req.V != hostdProtocolVersion {
			t.Errorf("broker was asked %+v, want {v:%d, verb:update}", req, hostdProtocolVersion)
		}
		asked <- fileBytes(t, exe)
		if answer != nil {
			_ = json.NewEncoder(conn).Encode(*answer)
		}
	}))
	return asked
}

func TestARunnerOnAWritableCopyUpdatesItselfThenAsksHostdOnce(t *testing.T) {
	declined := hostdResponse{Error: "refusing to update /usr/local/bin/orbit: its directory /usr/local/bin is not root's alone (owned by uid 0, mode 2775)"}
	for _, tc := range []struct {
		name string
		// from is the release the runner's own copy is on: (b) covers an account's older copy,
		// 0.1.243, from before hostd's update was limited to its own binary, run by the new template.
		from   string
		answer *hostdResponse
		want   string
	}{
		{"accepted", rolloutTestPrevious, &hostdResponse{OK: true, Data: map[string]any{"version": rolloutTestLatest, "from": rolloutTestPrevious, "accepted": true}},
			"it is installing orbit " + rolloutTestLatest + " as its own binary"},
		{"an older copy (0.1.243)", "0.1.243", &hostdResponse{OK: true, Data: map[string]any{"version": rolloutTestLatest, "accepted": true}},
			"it is installing orbit " + rolloutTestLatest + " as its own binary"},
		{"skipped", rolloutTestPrevious, &hostdResponse{OK: true, Data: map[string]any{"skipped": true, "reason": "an update ran 1m0s ago"}},
			"it skipped the request (an update ran 1m0s ago)"},
		{"declined", rolloutTestPrevious, &declined, "it declined: " + declined.Error},
		{"no answer", rolloutTestPrevious, nil, "it did not answer: "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetSelfUpdateStatus(t)
			resetSelfUpdateLogGates(t)
			latest, previous := newRolloutRelease(t, rolloutTestLatest), newRolloutRelease(t, rolloutTestPrevious)
			exe, restarts := runnerOn(t, tc.from)
			cp := serveRollout(t, latest, &previous, releaseAssignment{Version: rolloutTestLatest})
			registerWith(t, cp.srv.URL)
			asked := followingBroker(t, exe, tc.answer)

			// The periodic check drains for the release: it is this runner's own to install.
			var drain bool
			logged := captureRunnerStdout(t, func() {
				_, drain = availableSelfUpdate(context.Background(), cp.srv.URL)
			})
			if !drain {
				t.Fatalf("availableSelfUpdate did not report %s for a runner that can install it", rolloutTestLatest)
			}
			if n := len(asked); n != 0 {
				t.Fatalf("the release check asked the broker %d times; a runner that can write its directory never delegates", n)
			}

			logged += captureRunnerStdout(t, func() { selfUpdate(cp.srv.URL) })

			assertInstalled(t, exe, latest.binary)
			if n := len(cp.seen(".gz")); n != 1 {
				t.Errorf("downloaded %d times, want once: the runner installs its own release", n)
			}
			if n := restarts.Load(); n != 1 {
				t.Errorf("restarted %d times, want once, into %s, whatever the broker said", n, rolloutTestLatest)
			}
			if n := len(asked); n != 1 {
				t.Fatalf("the broker was asked %d times, want once", n)
			}
			if held := <-asked; !bytes.Equal(held, latest.binary) {
				t.Error("the broker was asked before the release was in the runner's own copy")
			}
			want := "installed orbit " + rolloutTestLatest + " into this runner's own copy; asked the host broker at " + hostdRunnerSocket + " to update its own binary: " + tc.want
			if !strings.Contains(logged, want) {
				t.Errorf("the log lacks %q:\n%s", want, logged)
			}
			if strings.Contains(logged, "delegated to the host broker") {
				t.Errorf("the runner delegated its own update:\n%s", logged)
			}
			if r := reported(t); r.State == selfUpdateStateDirNotWritable || r.State == selfUpdateStateFailed {
				t.Errorf("reported %q (%s) for an update the runner installed itself", r.State, r.Reason)
			}
		})
	}
}

// A machine with no broker — a host nobody set up — installs as it always did and asks nobody.
func TestARunnerWithNoBrokerUpdatesItselfAndAsksNobody(t *testing.T) {
	resetSelfUpdateStatus(t)
	latest, previous := newRolloutRelease(t, rolloutTestLatest), newRolloutRelease(t, rolloutTestPrevious)
	exe, restarts := runnerOn(t, rolloutTestPrevious) // with no broker socket
	cp := serveRollout(t, latest, &previous, releaseAssignment{Version: rolloutTestLatest})
	registerWith(t, cp.srv.URL)

	logged := captureRunnerStdout(t, func() { selfUpdate(cp.srv.URL) })

	assertInstalled(t, exe, latest.binary)
	if n := restarts.Load(); n != 1 {
		t.Errorf("restarted %d times; want once", n)
	}
	if strings.Contains(logged, "host broker") {
		t.Errorf("a runner with no broker mentioned one:\n%s", logged)
	}
}

// A release the runner fails to install is not followed: the broker is asked only once the
// release is in the runner's own copy.
func TestARunnerThatFailsToInstallDoesNotAskHostd(t *testing.T) {
	resetSelfUpdateStatus(t)
	latest, previous := newRolloutRelease(t, rolloutTestLatest), newRolloutRelease(t, rolloutTestPrevious)
	key := platformKey()
	asset := latest.manifest.Assets[key]
	asset.SHA256 = strings.Repeat("0", 64)
	latest.manifest.Assets = map[string]ManifestAsset{key: asset}
	exe, restarts := runnerOn(t, rolloutTestPrevious)
	current := fileBytes(t, exe)
	cp := serveRollout(t, latest, &previous, releaseAssignment{Version: rolloutTestLatest})
	registerWith(t, cp.srv.URL)
	asked := followingBroker(t, exe, &hostdResponse{OK: true, Data: map[string]any{"accepted": true}})

	captureRunnerStdout(t, func() { selfUpdate(cp.srv.URL) })

	assertInstalled(t, exe, current)
	if n := restarts.Load(); n != 0 {
		t.Errorf("restarted %d times after a failed install", n)
	}
	if n := len(asked); n != 0 {
		t.Errorf("the broker was asked %d times about a release the runner did not install", n)
	}
}
