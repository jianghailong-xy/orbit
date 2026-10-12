package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

const (
	rolloutTestPrevious = "0.1.200"
	rolloutTestLatest   = "0.1.300"
	rolloutTestToken    = "runner-token-rollout"

	upgradeHelperVersionEnv = "ORBIT_UPGRADE_HELPER_VERSION"
)

// rolloutRelease is one release as /dl publishes it: its manifest, and the build an install of it
// leaves in place of the executable.
type rolloutRelease struct {
	manifest Manifest
	binary   []byte
	gz       []byte
}

func newRolloutRelease(t *testing.T, ver string) rolloutRelease {
	t.Helper()
	binary, gz := fakeRelease(t, ver, "rollout "+ver)
	m := sha256TestManifest(publishedAssets(gz))
	m.Version = ver
	m.RunsAssignedRelease = true
	return rolloutRelease{manifest: m, binary: binary, gz: gz}
}

// fakeControlPlane publishes latest at /dl/ and, when there is one, previous at /dl/previous/, and
// answers GET /api/runner/release with its assignment — or with status, when that is set.
type fakeControlPlane struct {
	srv *httptest.Server

	mu       sync.Mutex
	assign   releaseAssignment
	status   int
	requests []string // every request's path and query
	auth     []string // the Authorization of every request that carried one
}

func serveRollout(t *testing.T, latest rolloutRelease, previous *rolloutRelease, assign releaseAssignment) *fakeControlPlane {
	t.Helper()
	cp := &fakeControlPlane{assign: assign}
	asset := "orbit-" + platformKey() + ".gz"
	cp.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cp.mu.Lock()
		cp.requests = append(cp.requests, r.URL.RequestURI())
		if a := r.Header.Get("Authorization"); a != "" {
			cp.auth = append(cp.auth, a)
		}
		assign, status := cp.assign, cp.status
		cp.mu.Unlock()
		switch {
		case r.URL.Path == "/dl/version.json":
			_ = json.NewEncoder(w).Encode(latest.manifest)
		case r.URL.Path == "/dl/"+asset:
			_, _ = w.Write(latest.gz)
		case previous != nil && r.URL.Path == "/dl/previous/version.json":
			_ = json.NewEncoder(w).Encode(previous.manifest)
		case previous != nil && r.URL.Path == "/dl/previous/"+asset:
			_, _ = w.Write(previous.gz)
		case r.URL.Path == "/api/runner/release" && status != 0:
			http.Error(w, `{"code":"REFUSED"}`, status)
		case r.URL.Path == "/api/runner/release":
			_ = json.NewEncoder(w).Encode(assign)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(cp.srv.Close)
	return cp
}

func (cp *fakeControlPlane) setAssignment(assign releaseAssignment) {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	cp.assign = assign
}

func (cp *fakeControlPlane) setStatus(status int) {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	cp.status = status
}

// seen lists the requests whose path and query contain part.
func (cp *fakeControlPlane) seen(part string) []string {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	var out []string
	for _, r := range cp.requests {
		if strings.Contains(r, part) {
			out = append(out, r)
		}
	}
	return out
}

// registerWith gives this machine a runner registered at server, as `orbit register` leaves it.
func registerWith(t *testing.T, server string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	cfg, err := json.Marshal(RunnerConfig{ServerURL: server, RunnerID: "runner-rollout", RunnerToken: rolloutTestToken})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), cfg, 0o600); err != nil {
		t.Fatal(err)
	}
}

// runnerOn makes this process a self-updating runner on release ver whose executable is exe, and
// counts the restarts an installed update asks for instead of re-executing the test binary.
func runnerOn(t *testing.T, ver string) (exe string, restarts *atomic.Int32) {
	t.Helper()
	if platformKey() == "" {
		t.Skip("self-update is unsupported on this test platform")
	}
	setTestVersion(t, ver)
	t.Setenv("ORBIT_NO_SELFUPDATE", "")
	exe = installedBinary(t)
	setTestInstallable(t, filepath.Dir(exe), true)
	oldTarget, oldRestart := selfUpdateTarget, restartIntoUpdate
	restarts = &atomic.Int32{}
	selfUpdateTarget = func() (string, error) { return exe, nil }
	restartIntoUpdate = func() error { restarts.Add(1); return nil }
	t.Cleanup(func() {
		selfUpdateTarget, restartIntoUpdate = oldTarget, oldRestart
		recordRolloutHold("")
	})
	return exe, restarts
}

func fileBytes(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestSelfUpdateInstallsAHigherAssignedRelease(t *testing.T) {
	latest, previous := newRolloutRelease(t, rolloutTestLatest), newRolloutRelease(t, rolloutTestPrevious)
	exe, restarts := runnerOn(t, rolloutTestPrevious)
	cp := serveRollout(t, latest, &previous, releaseAssignment{Version: rolloutTestLatest})
	registerWith(t, cp.srv.URL)

	if got, ok := availableSelfUpdate(context.Background(), cp.srv.URL); !ok || got != rolloutTestLatest {
		t.Fatalf("availableSelfUpdate = %q, %v; want %s, true", got, ok, rolloutTestLatest)
	}
	selfUpdate(cp.srv.URL)

	assertInstalled(t, exe, latest.binary)
	if n := restarts.Load(); n != 1 {
		t.Errorf("restarted %d times; want once, into %s", n, rolloutTestLatest)
	}
	// It asked as itself, naming both releases /dl publishes.
	asked := cp.seen("/api/runner/release")
	if len(asked) == 0 || asked[0] != "/api/runner/release?latest=0.1.300&previous=0.1.200" {
		t.Errorf("asked %v; want /api/runner/release?latest=0.1.300&previous=0.1.200", asked)
	}
	for _, a := range cp.auth {
		if a != "Bearer "+rolloutTestToken {
			t.Errorf("a request carried Authorization %q; want the runner's own credential", a)
		}
	}
}

func TestSelfUpdateRollsBackWhenTheControlPlaneMarksARollback(t *testing.T) {
	latest, previous := newRolloutRelease(t, rolloutTestLatest), newRolloutRelease(t, rolloutTestPrevious)
	exe, restarts := runnerOn(t, rolloutTestLatest)
	cp := serveRollout(t, latest, &previous, releaseAssignment{Version: rolloutTestPrevious, Rollback: true})
	registerWith(t, cp.srv.URL)

	if got, ok := availableSelfUpdate(context.Background(), cp.srv.URL); !ok || got != rolloutTestPrevious {
		t.Fatalf("availableSelfUpdate = %q, %v; want %s, true: a rollback is installed although it is older",
			got, ok, rolloutTestPrevious)
	}
	selfUpdate(cp.srv.URL)

	assertInstalled(t, exe, previous.binary)
	if n := restarts.Load(); n != 1 {
		t.Errorf("restarted %d times; want once, into %s", n, rolloutTestPrevious)
	}
	if got := cp.seen(".gz"); len(got) != 1 || got[0] != "/dl/previous/orbit-"+platformKey()+".gz" {
		t.Errorf("downloaded %v; want only the previous release's asset", got)
	}
}

func TestSelfUpdateNeverDowngradesWithoutARollback(t *testing.T) {
	latest, previous := newRolloutRelease(t, rolloutTestLatest), newRolloutRelease(t, rolloutTestPrevious)
	for name, assign := range map[string]releaseAssignment{
		"assigned an older release":         {Version: rolloutTestPrevious},
		"held at it by a rollout":           {Version: rolloutTestPrevious, HeldByRollout: true},
		"a rollback to the release it runs": {Version: rolloutTestLatest, Rollback: true},
	} {
		t.Run(name, func(t *testing.T) {
			exe, restarts := runnerOn(t, rolloutTestLatest)
			current := fileBytes(t, exe)
			cp := serveRollout(t, latest, &previous, assign)
			registerWith(t, cp.srv.URL)

			if got, ok := availableSelfUpdate(context.Background(), cp.srv.URL); ok || got != "" {
				t.Fatalf("availableSelfUpdate = %q, %v; want no update", got, ok)
			}
			selfUpdate(cp.srv.URL)

			assertInstalled(t, exe, current)
			if n := restarts.Load(); n != 0 {
				t.Errorf("restarted %d times; want none", n)
			}
			if got := cp.seen(".gz"); len(got) != 0 {
				t.Errorf("downloaded %v; want nothing", got)
			}
			if len(cp.seen("/api/runner/release")) == 0 {
				t.Error("never asked the control plane which release to run")
			}
		})
	}
}

// A runner rolled back to a release from before assignment would read /dl/version.json at its next
// check and reinstall the release it was rolled back from, draining its sessions both times.
func TestSelfUpdateRefusesARollbackToAReleaseBeforeAssignment(t *testing.T) {
	latest, previous := newRolloutRelease(t, rolloutTestLatest), newRolloutRelease(t, rolloutTestPrevious)
	previous.manifest.RunsAssignedRelease = false
	exe, restarts := runnerOn(t, rolloutTestLatest)
	current := fileBytes(t, exe)
	cp := serveRollout(t, latest, &previous, releaseAssignment{Version: rolloutTestPrevious, Rollback: true})
	registerWith(t, cp.srv.URL)

	if got, ok := availableSelfUpdate(context.Background(), cp.srv.URL); ok || got != "" {
		t.Fatalf("availableSelfUpdate = %q, %v; want no rollback to a release that would undo it", got, ok)
	}
	selfUpdate(cp.srv.URL)
	assertInstalled(t, exe, current)
	if n := restarts.Load(); n != 0 || len(cp.seen(".gz")) != 0 {
		t.Errorf("restarted %d times after downloading %v; want neither", n, cp.seen(".gz"))
	}
}

func TestSelfUpdateRecordsWhenARolloutHoldsItBack(t *testing.T) {
	latest, previous := newRolloutRelease(t, rolloutTestLatest), newRolloutRelease(t, rolloutTestPrevious)
	runnerOn(t, rolloutTestPrevious)
	cp := serveRollout(t, latest, &previous, releaseAssignment{Version: rolloutTestPrevious, HeldByRollout: true})
	registerWith(t, cp.srv.URL)

	if _, ok := availableSelfUpdate(context.Background(), cp.srv.URL); ok {
		t.Fatal("updated although the rollout holds this runner at its release")
	}
	if from, held := heldByRollout(); !held || from != rolloutTestLatest {
		t.Fatalf("heldByRollout = %q, %v; want %s, true", from, held, rolloutTestLatest)
	}

	// The rollout reaches it: nothing holds it back any more, and it updates.
	cp.setAssignment(releaseAssignment{Version: rolloutTestLatest})
	if got, ok := availableSelfUpdate(context.Background(), cp.srv.URL); !ok || got != rolloutTestLatest {
		t.Fatalf("availableSelfUpdate = %q, %v; want %s, true", got, ok, rolloutTestLatest)
	}
	if from, held := heldByRollout(); held {
		t.Fatalf("heldByRollout = %q, true once the rollout reached the runner", from)
	}

	// A runner already on the latest release is held back from nothing, wherever the rollout is.
	setTestVersion(t, rolloutTestLatest)
	cp.setAssignment(releaseAssignment{Version: rolloutTestPrevious, HeldByRollout: true})
	if _, ok := availableSelfUpdate(context.Background(), cp.srv.URL); ok {
		t.Fatal("a runner on the latest release left it for the previous one")
	}
	if from, held := heldByRollout(); held {
		t.Fatalf("heldByRollout = %q, true for a runner already on the latest release", from)
	}
}

func TestSelfUpdateTakesTheLatestFromAControlPlaneWithoutAssignment(t *testing.T) {
	latest, previous := newRolloutRelease(t, rolloutTestLatest), newRolloutRelease(t, rolloutTestPrevious)
	runnerOn(t, rolloutTestPrevious)
	cp := serveRollout(t, latest, &previous, releaseAssignment{})
	cp.setStatus(http.StatusNotFound)
	registerWith(t, cp.srv.URL)
	recordRolloutHold(rolloutTestLatest)

	if got, ok := availableSelfUpdate(context.Background(), cp.srv.URL); !ok || got != rolloutTestLatest {
		t.Fatalf("availableSelfUpdate = %q, %v; want %s, true, as before assignment", got, ok, rolloutTestLatest)
	}
	if from, held := heldByRollout(); held {
		t.Fatalf("heldByRollout = %q, true from a control plane that holds nobody", from)
	}
}

func TestSelfUpdateKeepsItsReleaseWhenTheControlPlaneRefuses(t *testing.T) {
	latest, previous := newRolloutRelease(t, rolloutTestLatest), newRolloutRelease(t, rolloutTestPrevious)
	runnerOn(t, rolloutTestPrevious)
	cp := serveRollout(t, latest, &previous, releaseAssignment{Version: rolloutTestLatest})
	cp.setStatus(http.StatusConflict)
	registerWith(t, cp.srv.URL)

	if got, ok := availableSelfUpdate(context.Background(), cp.srv.URL); ok || got != "" {
		t.Fatalf("availableSelfUpdate = %q, %v; want no update while the control plane assigns nothing", got, ok)
	}
	if got := cp.seen(".gz"); len(got) != 0 {
		t.Errorf("downloaded %v; want nothing", got)
	}
}

func TestSelfUpdateWithNoPreviousReleaseNamesOnlyTheLatest(t *testing.T) {
	latest := newRolloutRelease(t, rolloutTestLatest)
	runnerOn(t, rolloutTestPrevious)
	cp := serveRollout(t, latest, nil, releaseAssignment{Version: rolloutTestLatest})
	registerWith(t, cp.srv.URL)

	if got, ok := availableSelfUpdate(context.Background(), cp.srv.URL); !ok || got != rolloutTestLatest {
		t.Fatalf("availableSelfUpdate = %q, %v; want %s, true", got, ok, rolloutTestLatest)
	}
	if asked := cp.seen("/api/runner/release"); len(asked) != 1 || asked[0] != "/api/runner/release?latest=0.1.300" {
		t.Errorf("asked %v; want /api/runner/release?latest=0.1.300", asked)
	}
}

func TestSelfUpdateSendsItsCredentialOnlyToTheServerItRegisteredWith(t *testing.T) {
	latest, previous := newRolloutRelease(t, rolloutTestLatest), newRolloutRelease(t, rolloutTestPrevious)
	runnerOn(t, rolloutTestPrevious)
	cp := serveRollout(t, latest, &previous, releaseAssignment{Version: rolloutTestPrevious, HeldByRollout: true})
	registerWith(t, "https://another-control-plane.example")

	if got, ok := availableSelfUpdate(context.Background(), cp.srv.URL); !ok || got != rolloutTestLatest {
		t.Fatalf("availableSelfUpdate = %q, %v; want the latest, %s, as a runner registered nowhere here", got, ok, rolloutTestLatest)
	}
	if asked := cp.seen("/api/runner/release"); len(asked) != 0 || len(cp.auth) != 0 {
		t.Errorf("asked %v with %v; want no question and no credential", asked, cp.auth)
	}
}

func TestAssignedManifestRefusesAReleaseDlDoesNotPublish(t *testing.T) {
	latest, previous := newRolloutRelease(t, rolloutTestLatest), newRolloutRelease(t, rolloutTestPrevious)
	runnerOn(t, rolloutTestPrevious)
	cp := serveRollout(t, latest, &previous, releaseAssignment{Version: "0.1.250"})
	registerWith(t, cp.srv.URL)

	if _, err := publishedManifest(context.Background(), cp.srv.URL); err == nil ||
		!strings.Contains(err.Error(), `assigned release "0.1.250", which /dl does not publish`) {
		t.Fatalf("publishedManifest error = %v; want the unpublished assignment named", err)
	}
	if _, err := fetchManifest(context.Background(), cp.srv.URL, "missing/"); !errors.Is(err, errNotPublished) {
		t.Fatalf("fetchManifest of a missing manifest = %v; want errNotPublished", err)
	}
}

// `orbit upgrade` installs the release the runner's own update check would: back to the previous
// one under a rollback, and nothing when the runner already runs something newer than its
// assignment. upgrade ends its process on failure, so it runs in a child copy of this test binary.
func TestUpgradeInstallsTheAssignedRelease(t *testing.T) {
	latest, previous := newRolloutRelease(t, rolloutTestLatest), newRolloutRelease(t, rolloutTestPrevious)
	for _, tc := range []struct {
		name    string
		assign  releaseAssignment
		install []byte // nil: the current binary stays
		output  []string
	}{{
		name:    "a rollback installs the previous release",
		assign:  releaseAssignment{Version: rolloutTestPrevious, Rollback: true},
		install: previous.binary,
		output:  []string{"the control plane rolled 0.1.300 back; installing 0.1.200...", "✓ orbit is now 0.1.200"},
	}, {
		name:   "an older assignment without one installs nothing",
		assign: releaseAssignment{Version: rolloutTestPrevious, HeldByRollout: true},
		output: []string{"orbit 0.1.300 is newer than 0.1.200, the release", "assigns this runner; nothing to install"},
	}} {
		t.Run(tc.name, func(t *testing.T) {
			if platformKey() == "" {
				t.Skip("self-update is unsupported on this test platform")
			}
			exe := installedBinary(t)
			current := fileBytes(t, exe)
			cp := serveRollout(t, latest, &previous, tc.assign)
			registerWith(t, cp.srv.URL)

			cmd := exec.Command(os.Args[0], "-test.run=^TestUpgradeRolloutHelper$")
			cmd.Env = append(os.Environ(), upgradeHelperServerEnv+"="+cp.srv.URL, upgradeHelperTargetEnv+"="+exe,
				upgradeHelperVersionEnv+"="+rolloutTestLatest)
			out, err := cmd.CombinedOutput()
			t.Logf("orbit upgrade output:\n%s", out)
			if err != nil {
				t.Fatalf("orbit upgrade: %v", err)
			}
			want := current
			if tc.install != nil {
				want = tc.install
			}
			assertInstalled(t, exe, want)
			for _, line := range tc.output {
				if !bytes.Contains(out, []byte(line)) {
					t.Errorf("orbit upgrade output does not say %q", line)
				}
			}
		})
	}
}

// TestUpgradeRolloutHelper is the child half of TestUpgradeInstallsTheAssignedRelease: `orbit
// upgrade` at the version, against the server and replacing the binary, it is handed.
func TestUpgradeRolloutHelper(t *testing.T) {
	server := os.Getenv(upgradeHelperServerEnv)
	if server == "" || os.Getenv(upgradeHelperVersionEnv) == "" {
		t.Skip("child process of TestUpgradeInstallsTheAssignedRelease")
	}
	version = os.Getenv(upgradeHelperVersionEnv)
	target := os.Getenv(upgradeHelperTargetEnv)
	selfUpdateTarget = func() (string, error) { return target, nil }
	upgrade(server)
	os.Exit(0)
}
