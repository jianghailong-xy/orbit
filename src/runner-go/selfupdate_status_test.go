package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The heartbeat's selfUpdate field: where this runner's updates of itself stand, so the Runners page
// can say why a runner is not updating instead of guessing from runsAsRoot. Each state below is
// reached the way production reaches it — the startup update, a periodic or requested release
// check, the turn gate — against a fake /dl and control plane.

// resetSelfUpdateStatus starts a test with nothing recorded about this runner's updates, and leaves
// nothing behind for the next one.
func resetSelfUpdateStatus(t *testing.T) {
	t.Helper()
	clearStatus := func() {
		selfUpdateStatus.mu.Lock()
		defer selfUpdateStatus.mu.Unlock()
		selfUpdateStatus.state, selfUpdateStatus.reason, selfUpdateStatus.installDir = "", "", ""
	}
	clearStatus()
	t.Cleanup(clearStatus)
}

// reported is what the next heartbeat would carry.
func reported(t *testing.T) SelfUpdateReport {
	t.Helper()
	r := selfUpdateReport()
	if r == nil {
		t.Fatal("selfUpdateReport() = nil after the updater looked; want a report")
	}
	return *r
}

func assertSelfUpdateState(t *testing.T, want, wantReason string) SelfUpdateReport {
	t.Helper()
	r := reported(t)
	if r.State != want || r.Reason != wantReason {
		t.Fatalf("reported state %q, reason %q; want %q, %q", r.State, r.Reason, want, wantReason)
	}
	return r
}

// countingServer answers every request with status and counts them.
func countingServer(t *testing.T, status int) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(status)
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

func TestSelfUpdateStatusIsNotReportedBeforeAnythingLooked(t *testing.T) {
	resetSelfUpdateStatus(t)
	if r := selfUpdateReport(); r != nil {
		t.Fatalf("selfUpdateReport() = %+v before any check; want nil, which the control plane stores as not reported", *r)
	}
}

func TestSelfUpdateStatusEnabledOnTheAssignedRelease(t *testing.T) {
	resetSelfUpdateStatus(t)
	latest, previous := newRolloutRelease(t, rolloutTestLatest), newRolloutRelease(t, rolloutTestPrevious)
	exe, restarts := runnerOn(t, rolloutTestLatest)
	cp := serveRollout(t, latest, &previous, releaseAssignment{Version: rolloutTestLatest})
	registerWith(t, cp.srv.URL)

	selfUpdate(cp.srv.URL)
	r := assertSelfUpdateState(t, selfUpdateStateEnabled, "")
	if r.InstallDir != filepath.Dir(exe) {
		t.Errorf("installDir = %q; want %q, the directory an update replaces the binary in", r.InstallDir, filepath.Dir(exe))
	}
	if _, ok := availableSelfUpdate(context.Background(), cp.srv.URL); ok {
		t.Fatal("a runner on its assigned release found an update")
	}
	assertSelfUpdateState(t, selfUpdateStateEnabled, "")
	if n := restarts.Load(); n != 0 {
		t.Errorf("restarted %d times; want none", n)
	}
}

func TestSelfUpdateStatusDisabledByEnv(t *testing.T) {
	exe, err := resolvedExecutable()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, version, env, reason string
	}{
		{"ORBIT_NO_SELFUPDATE", rolloutTestPrevious, "1", "ORBIT_NO_SELFUPDATE is set"},
		{"a development build", "dev", "", "development build"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetSelfUpdateStatus(t)
			setTestVersion(t, tc.version)
			t.Setenv("ORBIT_NO_SELFUPDATE", tc.env)
			t.Setenv("ORBIT_HOME", t.TempDir())
			srv, hits := countingServer(t, http.StatusOK)

			selfUpdate(srv.URL)
			r := assertSelfUpdateState(t, selfUpdateStateDisabledByEnv, tc.reason)
			if r.InstallDir != filepath.Dir(exe) {
				t.Errorf("installDir = %q; want %q", r.InstallDir, filepath.Dir(exe))
			}
			if n := hits.Load(); n != 0 {
				t.Errorf("a disabled updater made %d request(s); want none", n)
			}
		})
	}
}

// A root-owned install directory pins a runner to its release for good, so it is reported whether or
// not a release is waiting — and ahead of a rollout that would only hold the runner back for now.
func TestSelfUpdateStatusDirNotWritable(t *testing.T) {
	latest, previous := newRolloutRelease(t, rolloutTestLatest), newRolloutRelease(t, rolloutTestPrevious)
	for _, tc := range []struct {
		name   string
		runs   string
		assign releaseAssignment
	}{
		{"a newer release is waiting", rolloutTestPrevious, releaseAssignment{Version: rolloutTestLatest}},
		{"on the assigned release", rolloutTestLatest, releaseAssignment{Version: rolloutTestLatest}},
		{"held back by a rollout", rolloutTestPrevious, releaseAssignment{Version: rolloutTestPrevious, HeldByRollout: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetSelfUpdateStatus(t)
			exe, restarts := runnerOn(t, tc.runs)
			current := fileBytes(t, exe)
			setTestInstallable(t, "/usr/local/bin", false)
			cp := serveRollout(t, latest, &previous, tc.assign)
			registerWith(t, cp.srv.URL)

			if _, ok := availableSelfUpdate(context.Background(), cp.srv.URL); ok {
				t.Fatal("availableSelfUpdate reported a release this runner cannot install")
			}
			r := assertSelfUpdateState(t, selfUpdateStateDirNotWritable, "")
			if r.InstallDir != "/usr/local/bin" {
				t.Errorf("installDir = %q; want /usr/local/bin, the directory that is not writable", r.InstallDir)
			}

			resetSelfUpdateStatus(t)
			selfUpdate(cp.srv.URL)
			assertSelfUpdateState(t, selfUpdateStateDirNotWritable, "")
			assertInstalled(t, exe, current)
			if n := restarts.Load(); n != 0 || len(cp.seen(".gz")) != 0 {
				t.Errorf("restarted %d times after downloading %v; want neither", n, cp.seen(".gz"))
			}
		})
	}
}

// The turn gate's deferral is waitingForIdle, and the first check that finds the runner idle says
// enabled again as it lets the update through.
func TestSelfUpdateStatusWaitingForIdle(t *testing.T) {
	resetSelfUpdateStatus(t)
	latest, previous := newRolloutRelease(t, rolloutTestLatest), newRolloutRelease(t, rolloutTestPrevious)
	runnerOn(t, rolloutTestPrevious)
	cp := serveRollout(t, latest, &previous, releaseAssignment{Version: rolloutTestLatest})
	registerWith(t, cp.srv.URL)
	p := newSessionPool(2)
	s := registerPoolSession(t, p, "a", true)
	check := updateWhenNoTurnInFlight(availableSelfUpdate, p, time.Minute)

	if remote, ok := check(context.Background(), cp.srv.URL); ok || remote != "" {
		t.Fatalf("check with a turn in flight = %q, %v; want it deferred", remote, ok)
	}
	assertSelfUpdateState(t, selfUpdateStateWaitingForIdle, "")

	parkPoolSession(p, s)
	if remote, ok := check(context.Background(), cp.srv.URL); !ok || remote != rolloutTestLatest {
		t.Fatalf("check with nothing in flight = %q, %v; want %s", remote, ok, rolloutTestLatest)
	}
	assertSelfUpdateState(t, selfUpdateStateEnabled, "")
}

func TestSelfUpdateStatusFailedReleaseCheck(t *testing.T) {
	resetSelfUpdateStatus(t)
	runnerOn(t, rolloutTestPrevious)
	srv, _ := countingServer(t, http.StatusInternalServerError)
	registerWith(t, srv.URL)

	if _, ok := availableSelfUpdate(context.Background(), srv.URL); ok {
		t.Fatal("a check that could not read /dl found an update")
	}
	assertSelfUpdateState(t, selfUpdateStateFailed, "cannot read the release to install: HTTP 500")

	resetSelfUpdateStatus(t)
	selfUpdate(srv.URL)
	assertSelfUpdateState(t, selfUpdateStateFailed, "cannot read the release to install: HTTP 500")
}

// An install that fails says why in the runner's own words — the same line runner.log has.
func TestSelfUpdateStatusFailedInstall(t *testing.T) {
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

	selfUpdate(cp.srv.URL)
	r := reported(t)
	if r.State != selfUpdateStateFailed {
		t.Fatalf("reported state %q; want %q", r.State, selfUpdateStateFailed)
	}
	want := "installing " + rolloutTestLatest + ": downloaded orbit-" + key + ".gz has sha256 "
	if !strings.HasPrefix(r.Reason, want) || !strings.HasSuffix(r.Reason, "; keeping current version") {
		t.Errorf("reason = %q; want the sha256 refusal, beginning %q", r.Reason, want)
	}
	assertInstalled(t, exe, current)
	if n := restarts.Load(); n != 0 {
		t.Errorf("restarted %d times; want none", n)
	}
	if last := lastSelfUpdate(); last != (selfUpdateRecord{}) {
		t.Errorf("a failed install recorded %+v as the last update", last)
	}
}

func TestSelfUpdateStatusHeldByRollout(t *testing.T) {
	resetSelfUpdateStatus(t)
	latest, previous := newRolloutRelease(t, rolloutTestLatest), newRolloutRelease(t, rolloutTestPrevious)
	runnerOn(t, rolloutTestPrevious)
	cp := serveRollout(t, latest, &previous, releaseAssignment{Version: rolloutTestPrevious, HeldByRollout: true})
	registerWith(t, cp.srv.URL)

	if _, ok := availableSelfUpdate(context.Background(), cp.srv.URL); ok {
		t.Fatal("updated although the rollout holds this runner at its release")
	}
	assertSelfUpdateState(t, selfUpdateStateHeldByRollout, "")

	// The rollout reaches it: the update it is about to install is no longer held back.
	cp.setAssignment(releaseAssignment{Version: rolloutTestLatest})
	if _, ok := availableSelfUpdate(context.Background(), cp.srv.URL); !ok {
		t.Fatal("no update once the rollout reached the runner")
	}
	assertSelfUpdateState(t, selfUpdateStateEnabled, "")
}

// The update ends in a re-exec, so the image that starts is the one to report it: the record is on
// disk, and every report reads it from there.
func TestSelfUpdateStatusRecordsTheLastUpdate(t *testing.T) {
	resetSelfUpdateStatus(t)
	latest, previous := newRolloutRelease(t, rolloutTestLatest), newRolloutRelease(t, rolloutTestPrevious)
	exe, restarts := runnerOn(t, rolloutTestPrevious)
	cp := serveRollout(t, latest, &previous, releaseAssignment{Version: rolloutTestLatest})
	registerWith(t, cp.srv.URL)

	before := time.Now().UTC().Truncate(time.Second)
	selfUpdate(cp.srv.URL)
	after := time.Now().UTC()
	assertInstalled(t, exe, latest.binary)
	if n := restarts.Load(); n != 1 {
		t.Fatalf("restarted %d times; want once, into %s", n, rolloutTestLatest)
	}

	info, err := os.Stat(selfUpdateRecordPath())
	if err != nil {
		t.Fatalf("no record of the update on disk: %v", err)
	}
	if perm := info.Mode().Perm(); perm != configFilePerm {
		t.Errorf("record mode = %o; want %o, like the config beside it", perm, configFilePerm)
	}

	// The restarted image: nothing in memory but what its own startup update found.
	resetSelfUpdateStatus(t)
	setTestVersion(t, rolloutTestLatest)
	selfUpdate(cp.srv.URL)
	r := assertSelfUpdateState(t, selfUpdateStateEnabled, "")
	if r.LastUpdatedFrom != rolloutTestPrevious || r.LastUpdatedTo != rolloutTestLatest {
		t.Errorf("last update %q -> %q; want %s -> %s", r.LastUpdatedFrom, r.LastUpdatedTo, rolloutTestPrevious, rolloutTestLatest)
	}
	at, err := time.Parse(time.RFC3339, r.LastUpdatedAt)
	if err != nil || at.Before(before) || at.After(after) {
		t.Errorf("lastUpdatedAt = %q (%v); want an RFC3339 time between %s and %s", r.LastUpdatedAt, err, before, after)
	}
}

// What the control plane receives: the report under selfUpdate, every field under its @orbit/shared
// name, and the key absent altogether until something has looked.
func TestHeartbeatSerializesSelfUpdate(t *testing.T) {
	resetSelfUpdateStatus(t)
	t.Setenv("ORBIT_HOME", t.TempDir())
	bodies := make(chan map[string]json.RawMessage, 16)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/runner/heartbeat" {
			http.NotFound(w, r)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var body map[string]json.RawMessage
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("heartbeat body is not a JSON object: %v", err)
		}
		bodies <- body
		_, _ = w.Write([]byte(`{"cancelSessionIds":[],"maxConcurrent":1,"checkSelfUpdate":true}`))
	}))
	defer srv.Close()
	tr := NewTransport(srv.URL, "runner-token")
	beat := func() (*HeartbeatResponse, map[string]json.RawMessage) {
		t.Helper()
		resp, err := tr.heartbeat(HeartbeatRequest{Status: "ONLINE", Version: rolloutTestLatest, SelfUpdate: selfUpdateReport()})
		if err != nil {
			t.Fatal(err)
		}
		return resp, <-bodies
	}

	if _, body := beat(); body["selfUpdate"] != nil {
		t.Fatalf("selfUpdate = %s before anything looked; want the key omitted", body["selfUpdate"])
	}

	recordSelfUpdate(rolloutTestPrevious, rolloutTestLatest, time.Date(2026, 10, 6, 6, 0, 0, 0, time.UTC))
	noteSelfUpdate(selfUpdateStateFailed, "installing 0.1.400: download failed: HTTP 502", "/home/u/.orbit/bin")
	resp, body := beat()
	var got map[string]interface{}
	if err := json.Unmarshal(body["selfUpdate"], &got); err != nil {
		t.Fatalf("selfUpdate = %s: %v", body["selfUpdate"], err)
	}
	want := map[string]interface{}{
		"state":           "failed",
		"reason":          "installing 0.1.400: download failed: HTTP 502",
		"installDir":      "/home/u/.orbit/bin",
		"lastUpdatedAt":   "2026-10-06T06:00:00Z",
		"lastUpdatedFrom": rolloutTestPrevious,
		"lastUpdatedTo":   rolloutTestLatest,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("selfUpdate = %v;\nwant %v", got, want)
	}
	if !resp.CheckSelfUpdate {
		t.Error("checkSelfUpdate: true in the response did not reach HeartbeatResponse.CheckSelfUpdate")
	}

	// Each state under the spelling @orbit/shared RunnerSelfUpdateState gives it; no reason, no key.
	for _, state := range []string{"enabled", "disabledByEnv", "dirNotWritable", "waitingForIdle", "failed", "heldByRollout"} {
		noteSelfUpdate(state, "", "")
		_, body := beat()
		var got map[string]interface{}
		if err := json.Unmarshal(body["selfUpdate"], &got); err != nil {
			t.Fatal(err)
		}
		if got["state"] != state {
			t.Errorf("state = %v; want %q", got["state"], state)
		}
		if _, ok := got["reason"]; ok {
			t.Errorf("%s: reason = %v; want the key omitted when there is none", state, got["reason"])
		}
	}
}

func TestHeartbeatResponseWithoutCheckSelfUpdateAsksForNothing(t *testing.T) {
	var resp HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"cancelSessionIds":[],"maxConcurrent":2}`), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.CheckSelfUpdate {
		t.Fatal("checkSelfUpdate = true on a response that omits it: an older control plane would trigger a check every beat")
	}
}

// Update Runner Now: a request runs the check at once, an hour before its tick — and a turn in flight
// still defers the update it finds, which is reported rather than acted on.
func TestWaitForRunLoopStopChecksWhenAsked(t *testing.T) {
	resetSelfUpdateStatus(t)
	t.Run("idle: the update it finds stops the loop", func(t *testing.T) {
		checkNow := make(chan struct{}, 1)
		checkNow <- struct{}{}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		reason, remote := waitForRunLoopStop(ctx, nil, "https://control.example", time.Hour,
			func(context.Context, string) (string, bool) { return rolloutTestLatest, true }, checkNow)
		if reason != runLoopStopUpdate || remote != rolloutTestLatest {
			t.Fatalf("stop = %v, %q; want the update the requested check found", reason, remote)
		}
	})
	t.Run("a turn in flight: deferred and reported", func(t *testing.T) {
		p := newSessionPool(2)
		registerPoolSession(t, p, "a", true)
		checked := make(chan struct{}, 1)
		gated := updateWhenNoTurnInFlight(func(context.Context, string) (string, bool) {
			noteSelfUpdate(selfUpdateStateEnabled, "", "/home/u/.orbit/bin")
			return rolloutTestLatest, true
		}, p, time.Hour)
		check := func(ctx context.Context, server string) (string, bool) {
			remote, ok := gated(ctx, server)
			checked <- struct{}{}
			return remote, ok
		}
		checkNow := make(chan struct{}, 1)
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan runLoopStopReason, 1)
		go func() {
			reason, _ := waitForRunLoopStop(ctx, nil, "https://control.example", time.Hour, check, checkNow)
			done <- reason
		}()
		checkNow <- struct{}{}
		select {
		case <-checked:
		case <-time.After(5 * time.Second):
			t.Fatal("the requested check never ran")
		}
		assertSelfUpdateState(t, selfUpdateStateWaitingForIdle, "")
		cancel()
		if reason := <-done; reason != runLoopStopNone {
			t.Fatalf("stop = %v; want the loop still running until cancelled", reason)
		}
	})
	t.Run("self-update off: a request is left unread", func(t *testing.T) {
		checkNow := make(chan struct{}, 1)
		checkNow <- struct{}{}
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		defer cancel()
		if reason, _ := waitForRunLoopStop(ctx, nil, "https://control.example", time.Hour, nil, checkNow); reason != runLoopStopNone {
			t.Fatalf("stop = %v; want none", reason)
		}
	})
}
