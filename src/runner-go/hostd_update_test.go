package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// The update verb, driven against a machine the test owns: a fake systemctl, an install directory
// in a temp dir named by a runner template as `orbit host setup` writes it, and an httptest control
// plane publishing real releases (fakeRelease: executables that answer `version` and
// `capabilities --json`, with their sha256 in the manifest). Nothing here stands in for the logic
// under test — the verb, the release checks, the swap and the roll are the real ones. The one
// thing a test cannot do is become another user, so the probe runner records each command,
// Credential and all, and then runs the download as itself.

type hostdUpdateHarness struct {
	t *testing.T

	root         string
	dir          string // the install directory
	installed    string // the machine binary the runner template's ExecStart= names
	configPath   string
	templatePath string
	stampPath    string

	mu               sync.Mutex
	runs             [][]string
	queries          [][]string
	probed           []*exec.Cmd
	installedVersion string
	// units is what `systemctl list-units` reports, verbatim.
	units string

	cp     *fakeControlPlane
	update hostdUpdate
}

func newHostdUpdateHarness(t *testing.T, installed string, latest rolloutRelease) *hostdUpdateHarness {
	t.Helper()
	if platformKey() == "" {
		t.Skip("no release is published for this test platform")
	}
	h := &hostdUpdateHarness{
		t:                t,
		root:             t.TempDir(),
		installedVersion: installed,
		units: "orbit-runner@1000.service   loaded active running Orbit runner (uid 1000)\n" +
			"orbit-runner@1001.service   loaded active running Orbit runner (uid 1001)\n" +
			"orbit-hostd.service         loaded active running Orbit host broker\n",
	}
	h.dir = filepath.Join(h.root, "usr", "local", "bin")
	h.installed = filepath.Join(h.dir, "orbit")
	h.configPath = filepath.Join(h.root, "etc", "orbit", "config.json")
	h.templatePath = filepath.Join(h.root, "etc", "systemd", "system", "orbit-runner@.service")
	h.stampPath = filepath.Join(h.root, "run", "orbit", "last-update")
	for _, dir := range []string{h.dir, filepath.Dir(h.configPath), filepath.Dir(h.templatePath)} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	h.write(h.installed, []byte("the binary installed right now"), 0o755)
	h.write(h.templatePath, []byte(hostRunnerTemplate(h.installed)), 0o644)

	// The control plane also publishes a previous release and assigns runners to it, so a test
	// can tell "what /dl publishes to everybody" from "what one runner was assigned".
	previous := newRolloutRelease(t, rolloutTestPrevious)
	h.cp = serveRollout(t, latest, &previous, releaseAssignment{Version: rolloutTestPrevious, HeldByRollout: true})
	h.writeConfig(h.cp.srv.URL)

	h.update = hostdUpdate{
		sys: hostdSystem{
			run: func(name string, args ...string) (string, error) {
				h.record(&h.runs, name, args)
				return "", nil
			},
			query: func(name string, args ...string) (string, error) {
				h.record(&h.queries, name, args)
				switch {
				case name == h.installed && len(args) == 1 && args[0] == "version":
					h.mu.Lock()
					defer h.mu.Unlock()
					return h.installedVersion + "\n", nil
				case name == "systemctl":
					return h.units, nil
				}
				return "", fmt.Errorf("unexpected query: %s %v", name, args)
			},
			lookupUID: func(uid string) (*user.User, error) {
				return &user.User{Uid: uid, Gid: uid, Username: "user" + uid}, nil
			},
		},
		configPath:   h.configPath,
		templatePath: h.templatePath,
		stampPath:    h.stampPath,
		// Simulate the daemon as systemd runs it. Every privilege decision below is the one
		// production makes, not a test-only branch.
		geteuid: func() int { return 0 },
		// The files this test creates are its own; they stand for root's.
		rootUID: uint32(os.Geteuid()),
		runProbe: func(cmd *exec.Cmd) ([]byte, error) {
			h.mu.Lock()
			h.probed = append(h.probed, cmd)
			h.mu.Unlock()
			return exec.Command(cmd.Path, cmd.Args[1:]...).Output()
		},
		// Inline, so the test asserts on finished side effects instead of sleeping for them.
		// Production hands this to hostdRunBackground.
		background: func(f func()) { f() },
	}
	return h
}

func (h *hostdUpdateHarness) write(path string, data []byte, mode os.FileMode) {
	h.t.Helper()
	if err := os.WriteFile(path, data, mode); err != nil {
		h.t.Fatal(err)
	}
}

func (h *hostdUpdateHarness) record(into *[][]string, name string, args []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	*into = append(*into, append([]string{name}, args...))
}

func (h *hostdUpdateHarness) writeConfig(server string) {
	h.t.Helper()
	h.write(h.configPath, []byte(`{"server":"`+server+`"}`+"\n"), 0o644)
}

func (h *hostdUpdateHarness) ask(uid uint32) hostdResponse {
	h.t.Helper()
	return h.update.verb(hostdPeer{UID: uid, PID: 4242}, hostdRequest{V: hostdProtocolVersion, Verb: "update"})
}

// restarts is the units the roll actually restarted, in order.
func (h *hostdUpdateHarness) restarts() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var units []string
	for _, argv := range h.runs {
		if len(argv) == 3 && argv[0] == "systemctl" && argv[1] == "restart" {
			units = append(units, argv[2])
		}
	}
	return units
}

func (h *hostdUpdateHarness) downloads() int {
	return len(h.cp.seen(".gz"))
}

// leftovers reports any half-installed download still sitting in dir.
func leftovers(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var found []string
	for _, e := range entries {
		if strings.Contains(e.Name(), ".new-") {
			found = append(found, e.Name())
		}
	}
	return found
}

// assertNoSideEffects checks that a refused or skipped update changed nothing since before was
// taken: no request to the control plane (so no manifest and no download), no command run or
// executed — not even the installed binary's version — nothing restarted, no rate-limit window
// consumed, and the installed binary as it was.
func (h *hostdUpdateHarness) assertNoSideEffects(before hostdSideEffects) {
	h.t.Helper()
	after := h.sideEffects()
	if len(after.requests) != len(before.requests) {
		h.t.Errorf("contacted the control plane: %v", after.requests[len(before.requests):])
	}
	if after.queries != before.queries || after.runs != before.runs || after.probes != before.probes {
		h.t.Errorf("ran commands: queries %d → %d, runs %d → %d, probes %d → %d",
			before.queries, after.queries, before.runs, after.runs, before.probes, after.probes)
	}
	if !bytes.Equal(after.installed, before.installed) {
		h.t.Error("the installed binary changed")
	}
	if !after.stamp.Equal(before.stamp) {
		h.t.Errorf("the rate-limit stamp moved: %v → %v", before.stamp, after.stamp)
	}
	if left := leftovers(h.t, h.dir); len(left) != 0 {
		h.t.Errorf("left a download behind: %v", left)
	}
}

type hostdSideEffects struct {
	requests              []string
	queries, runs, probes int
	installed             []byte
	stamp                 time.Time
}

func (h *hostdUpdateHarness) sideEffects() hostdSideEffects {
	h.t.Helper()
	h.cp.mu.Lock()
	requests := append([]string(nil), h.cp.requests...)
	h.cp.mu.Unlock()
	h.mu.Lock()
	s := hostdSideEffects{requests: requests, queries: len(h.queries), runs: len(h.runs), probes: len(h.probed)}
	h.mu.Unlock()
	s.installed, _ = os.ReadFile(h.installed)
	if fi, err := os.Stat(h.stampPath); err == nil {
		s.stamp = fi.ModTime()
	}
	return s
}

func gzipped(t *testing.T, payload []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	if _, err := gz.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// The whole path: a newer release is read from the public manifest, downloaded, checked against
// its sha256, its version and its write contract — each asked of the download as the caller —
// swapped in atomically, and only then are the machine's runner instances rolled: the ones
// systemd actually reports, one at a time.
func TestHostdUpdateInstallsAndRollsEveryRunnerInstance(t *testing.T) {
	latest := newRolloutRelease(t, rolloutTestLatest)
	h := newHostdUpdateHarness(t, rolloutTestPrevious, latest)
	before, err := os.Stat(h.installed)
	if err != nil {
		t.Fatal(err)
	}

	resp := h.ask(1000)
	if !resp.OK {
		t.Fatalf("update failed: %s", resp.Error)
	}
	if got := resp.Data["version"]; got != rolloutTestLatest {
		t.Errorf("version = %v, want the accepted release %s", got, rolloutTestLatest)
	}
	if got := resp.Data["from"]; got != rolloutTestPrevious {
		t.Errorf("from = %v, want the installed %s", got, rolloutTestPrevious)
	}
	if got := resp.Data["accepted"]; got != true {
		t.Errorf("accepted = %v, want true", got)
	}
	// The public manifest, then this platform's asset beside it — and nothing else: no question
	// about which release some runner is assigned.
	asset := "/dl/orbit-" + platformKey() + ".gz"
	if got := h.cp.seen("/"); !equalStrings(got, []string{"/dl/version.json", asset}) {
		t.Errorf("requests = %v, want [/dl/version.json %s]", got, asset)
	}
	assertInstalled(t, h.installed, latest.binary)
	// Swapped in by rename, not written over: a runner starting mid-update must exec one whole
	// binary or the other, and an in-place write would hand it neither.
	after, err := os.Stat(h.installed)
	if err != nil {
		t.Fatal(err)
	}
	if os.SameFile(before, after) {
		t.Error("the installed binary was overwritten in place rather than renamed over")
	}
	want := []string{"orbit-runner@1000.service", "orbit-runner@1001.service"}
	if got := h.restarts(); !equalStrings(got, want) {
		t.Errorf("restarted %v, want exactly the enumerated instances %v, in order", got, want)
	}
	if got := h.runs; len(got) != len(want) {
		t.Errorf("ran %d commands, want only the %d restarts: %v", len(got), len(want), got)
	}

	// Both checks that execute the download ran against the download itself, before it took the
	// installed binary's name: its version, and the write contract main's chain checks next.
	var asked []string
	for _, probe := range h.probed {
		if !strings.HasPrefix(probe.Path, h.installed+".new-") {
			t.Errorf("probe ran %q, want the freshly downloaded file, not the installed one", probe.Path)
		}
		asked = append(asked, strings.Join(probe.Args[1:], " "))
	}
	if !equalStrings(asked, []string{"version", "capabilities --json"}) {
		t.Errorf("asked the download %q, want its version and then its write contract", asked)
	}
}

// The release a shared binary is updated to is the one /dl publishes to every runner — read with
// no credential at all. Root may well have registered a runner of its own, whose config the
// runner-side check would find and whose token it would send, and whichever runner asked may be
// held back by a staged rollout; neither decides what every account on the machine execs.
func TestHostdUpdateReadsThePublicManifestWithNoRunnerToken(t *testing.T) {
	latest := newRolloutRelease(t, rolloutTestLatest)
	h := newHostdUpdateHarness(t, rolloutTestPrevious, latest)
	// Root's own runner, registered with this very control plane, which holds runners at the
	// previous release — and a link assignment saying the same.
	registerWith(t, h.cp.srv.URL)
	if got := runnerTokenFor(h.cp.srv.URL); got != rolloutTestToken {
		t.Fatalf("runnerTokenFor = %q; the fixture should give root a runner token for this server", got)
	}
	setLinkAssignedRelease(&releaseAssignment{Version: rolloutTestPrevious})
	t.Cleanup(func() { setLinkAssignedRelease(nil) })

	if resp := h.ask(1000); !resp.OK || resp.Data["version"] != rolloutTestLatest {
		t.Fatalf("update = %+v, want %s accepted", resp, rolloutTestLatest)
	}
	h.cp.mu.Lock()
	auth := append([]string(nil), h.cp.auth...)
	h.cp.mu.Unlock()
	if len(auth) != 0 {
		t.Errorf("sent Authorization %v; the machine's update reads /dl as anybody does", auth)
	}
	if asked := h.cp.seen("/api/runner/release"); len(asked) != 0 {
		t.Errorf("asked %v which release to run; a shared binary is no runner's to assign", asked)
	}
	if got := h.cp.seen("/dl/previous/"); len(got) != 0 {
		t.Errorf("read the previous release %v; only the published latest is installed", got)
	}
	assertInstalled(t, h.installed, latest.binary)
}

// A download that fails any of the release checks is not installed, nothing is restarted for it,
// and nothing of it is left beside the installed binary. These are main's checks — the same
// refusal the runner's own update logs — not a second, laxer set.
func TestHostdUpdateInstallsNothingThatFailsTheReleaseChecks(t *testing.T) {
	if platformKey() == "" {
		t.Skip("no release is published for this test platform")
	}
	key := platformKey()
	for _, tc := range []struct {
		name string
		// tamper turns a genuine release into the one served.
		tamper func(t *testing.T, r *rolloutRelease)
		probes []string // what was asked of the download before it was refused
		log    []string
	}{{
		name: "sha256 mismatch",
		tamper: func(t *testing.T, r *rolloutRelease) {
			_, r.gz = fakeRelease(t, rolloutTestLatest, "tampered") // the manifest keeps the genuine digest
		},
		probes: nil, // refused before anything was written, let alone executed
		log:    []string{"downloaded orbit-" + key + ".gz has sha256 ", "but version.json publishes ", "keeping current version"},
	}, {
		name: "self-test reports another version",
		tamper: func(t *testing.T, r *rolloutRelease) {
			r.binary, r.gz = fakeRelease(t, "0.1.250", "answers the wrong version")
			r.manifest.Assets = publishedAssets(r.gz) // digest matches: only the self-test can tell
		},
		probes: []string{"version"},
		log:    []string{"downloaded update failed self-test; keeping current version"},
	}, {
		name: "a different write contract",
		tamper: func(t *testing.T, r *rolloutRelease) {
			r.binary = bytes.Replace(r.binary, []byte(runnerWriteContractDigest), []byte("another-contract"), 1)
			r.gz = gzipped(t, r.binary)
			r.manifest.Assets = publishedAssets(r.gz)
		},
		probes: []string{"version", "capabilities --json"},
		log:    []string{"downloaded update reports a different runner write contract; keeping current version"},
	}} {
		t.Run(tc.name, func(t *testing.T) {
			release := newRolloutRelease(t, rolloutTestLatest)
			tc.tamper(t, &release)
			h := newHostdUpdateHarness(t, rolloutTestPrevious, release)
			before, _ := os.ReadFile(h.installed)

			var resp hostdResponse
			logged := captureRunnerStdout(t, func() { resp = h.ask(1000) })
			t.Logf("hostd logged:\n%s", logged)
			if !resp.OK || resp.Data["accepted"] != true {
				t.Fatalf("update = %+v, want it accepted (the checks run after the answer)", resp)
			}
			if h.downloads() != 1 {
				t.Errorf("downloaded %d times, want 1", h.downloads())
			}
			assertInstalled(t, h.installed, before)
			if got := h.restarts(); len(got) != 0 {
				t.Errorf("restarted %v for a release that was refused", got)
			}
			var asked []string
			for _, probe := range h.probed {
				asked = append(asked, strings.Join(probe.Args[1:], " "))
			}
			if !equalStrings(asked, tc.probes) {
				t.Errorf("asked the download %q, want %q", asked, tc.probes)
			}
			for _, want := range append(tc.log, "is unchanged and no runner was restarted") {
				if !strings.Contains(logged, want) {
					t.Errorf("the journal does not say %q", want)
				}
			}
		})
	}
}

// A machine that is already current must not download anything and must not touch a single
// runner: a restart is a live session torn down, and there is nothing here to gain by it.
func TestHostdUpdateLeavesAnUpToDateMachineAlone(t *testing.T) {
	for _, installed := range []string{rolloutTestLatest, "0.1.400"} {
		t.Run(installed, func(t *testing.T) {
			h := newHostdUpdateHarness(t, installed, newRolloutRelease(t, rolloutTestLatest))
			before := h.sideEffects()

			resp := h.ask(1000)
			if !resp.OK {
				t.Fatalf("update failed: %s", resp.Error)
			}
			if got := resp.Data["updated"]; got != false {
				t.Errorf("updated = %v, want false", got)
			}
			if got := resp.Data["version"]; got != installed {
				t.Errorf("version = %v, want the installed %s", got, installed)
			}
			if h.downloads() != 0 {
				t.Errorf("downloaded %d times, want 0", h.downloads())
			}
			if got := h.restarts(); len(got) != 0 {
				t.Errorf("restarted %v, want nothing", got)
			}
			if len(h.probed) != 0 {
				t.Errorf("executed a download %d times, want never", len(h.probed))
			}
			if !bytes.Equal(fileBytes(t, h.installed), before.installed) {
				t.Error("the installed binary was replaced although no newer release exists")
			}
		})
	}
}

// Ten runners notice the same release within a minute of each other. The first does the work;
// the rest are told it just happened, and cost the machine nothing — not a request, not an exec.
func TestHostdUpdateIsRateLimited(t *testing.T) {
	h := newHostdUpdateHarness(t, rolloutTestPrevious, newRolloutRelease(t, rolloutTestLatest))

	if resp := h.ask(1000); !resp.OK || resp.Data["accepted"] != true {
		t.Fatalf("first update = %+v, want an accepted install", resp)
	}
	before := h.sideEffects()

	resp := h.ask(1001)
	if !resp.OK {
		t.Fatalf("second update failed: %s", resp.Error)
	}
	if resp.Data["skipped"] != true {
		t.Errorf("second update = %+v, want skipped", resp.Data)
	}
	h.assertNoSideEffects(before)

	// And the window ends: past it, a newer release is installed as usual.
	newer := newRolloutRelease(t, "0.1.400")
	next := serveRollout(t, newer, nil, releaseAssignment{Version: "0.1.400"})
	h.writeConfig(next.srv.URL)
	h.update.now = func() time.Time { return time.Now().Add(hostdUpdateInterval + time.Minute) }
	if resp := h.ask(1000); !resp.OK || resp.Data["accepted"] != true {
		t.Fatalf("update after the rate-limit window = %+v, want an accepted install", resp)
	}
	if got := next.seen(".gz"); len(got) != 1 {
		t.Errorf("downloads after the window = %v, want one", got)
	}
	assertInstalled(t, h.installed, newer.binary)
}

// The rate limit holds for callers that arrive together, which is exactly when it matters: every
// runner on a machine that just booted checks at the same moment.
func TestHostdUpdateRateLimitHoldsForCallersArrivingTogether(t *testing.T) {
	h := newHostdUpdateHarness(t, rolloutTestPrevious, newRolloutRelease(t, rolloutTestLatest))

	const callers = 8
	answers := make(chan hostdResponse, callers)
	var wg sync.WaitGroup
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func(uid uint32) {
			defer wg.Done()
			answers <- h.update.verb(hostdPeer{UID: uid, PID: 4242}, hostdRequest{V: hostdProtocolVersion, Verb: "update"})
		}(uint32(1000 + i))
	}
	wg.Wait()
	close(answers)

	accepted, skipped := 0, 0
	for resp := range answers {
		switch {
		case !resp.OK:
			t.Errorf("a caller was refused: %s", resp.Error)
		case resp.Data["accepted"] == true:
			accepted++
		case resp.Data["skipped"] == true:
			skipped++
		}
	}
	if accepted != 1 || skipped != callers-1 {
		t.Errorf("accepted %d and skipped %d of %d callers, want exactly one install", accepted, skipped, callers)
	}
	if h.downloads() != 1 {
		t.Errorf("downloaded %d times, want once", h.downloads())
	}
	if got := len(h.restarts()); got != 2 {
		t.Errorf("restarted %d units, want the two instances once each", got)
	}
}

// The ironclad rule, from the side where dropping privileges cannot work: root asking a root
// daemon leaves nothing to drop to, so there is no way to verify the download without running it
// as root — and so it is not done at all.
func TestHostdUpdateRefusesToVerifyADownloadAsRoot(t *testing.T) {
	h := newHostdUpdateHarness(t, rolloutTestPrevious, newRolloutRelease(t, rolloutTestLatest))
	before := h.sideEffects()

	resp := h.ask(0)
	if resp.OK {
		t.Fatal("hostd accepted an update on behalf of uid 0")
	}
	if !strings.Contains(resp.Error, "uid 0") {
		t.Errorf("error = %q, want it to name the refusal", resp.Error)
	}
	h.assertNoSideEffects(before)
	if _, err := os.Stat(h.stampPath); err == nil {
		t.Error("a refused update consumed the rate-limit window")
	}
}

// What root downloads is decided by root's own config file, never by the caller. A request that
// carries a server, an artifact, a version and a digest of its own is answered from
// /etc/orbit/config.json regardless.
func TestHostdUpdateTakesItsReleaseFromTheMachineConfigNotTheRequest(t *testing.T) {
	latest := newRolloutRelease(t, rolloutTestLatest)
	h := newHostdUpdateHarness(t, rolloutTestPrevious, latest)

	rogueRelease := newRolloutRelease(t, "99.0.0")
	var rogueHits int
	var rogueMu sync.Mutex
	rogue := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		rogueMu.Lock()
		rogueHits++
		rogueMu.Unlock()
		_ = json.NewEncoder(w).Encode(rogueRelease.manifest)
	}))
	defer rogue.Close()

	body, err := json.Marshal(map[string]any{
		"v": hostdProtocolVersion, "verb": "update",
		"server": rogue.URL, "url": rogue.URL + "/dl/orbit-" + platformKey() + ".gz",
		"version": "99.0.0", "artifact": rogue.URL + "/payload", "sha256": rogueRelease.manifest.Assets[platformKey()].SHA256,
	})
	if err != nil {
		t.Fatal(err)
	}
	resp := hostdHandle(body, hostdPeer{UID: 1000, PID: 4242}, map[string]hostdVerb{"update": h.update.verb})
	if !resp.OK {
		t.Fatalf("update failed: %s", resp.Error)
	}
	rogueMu.Lock()
	hits := rogueHits
	rogueMu.Unlock()
	if hits != 0 {
		t.Fatalf("the caller's server was contacted %d time(s)", hits)
	}
	if got := resp.Data["version"]; got != rolloutTestLatest {
		t.Errorf("version = %v, want the one the machine config's server publishes", got)
	}
	assertInstalled(t, h.installed, latest.binary)
}

// Only the machine's own binary is replaced. The runner template naming a symlink into an
// account's ~/.orbit/bin — that account's install, which its runner updates itself — is refused
// before anything is fetched, written or executed: root writes nothing it downloaded into a home.
func TestHostdUpdateRefusesASymlinkIntoAUsersHome(t *testing.T) {
	h := newHostdUpdateHarness(t, rolloutTestPrevious, newRolloutRelease(t, rolloutTestLatest))
	home := filepath.Join(h.root, "home", "alice")
	own := userBinPath(home)
	if err := os.MkdirAll(filepath.Dir(own), 0o755); err != nil {
		t.Fatal(err)
	}
	h.write(own, []byte("alice's own orbit"), 0o755)
	if err := os.Remove(h.installed); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(own, h.installed); err != nil {
		t.Fatal(err)
	}
	before := h.sideEffects()

	resp := h.ask(1000)
	if resp.OK {
		t.Fatalf("hostd agreed to update a binary in a user's home: %+v", resp.Data)
	}
	if !strings.Contains(resp.Error, "symlink") || !strings.Contains(resp.Error, own) {
		t.Errorf("error = %q, want it to say the target is a symlink to %s", resp.Error, own)
	}
	h.assertNoSideEffects(before)
	if _, err := os.Stat(h.stampPath); err == nil {
		t.Error("a refused update consumed the rate-limit window")
	}
	if got := fileBytes(t, own); string(got) != "alice's own orbit" {
		t.Errorf("the account's own binary changed: %q", got)
	}
	if dest, err := os.Readlink(h.installed); err != nil || dest != own {
		t.Errorf("the link is now %q (%v), want it left pointing at %s", dest, err, own)
	}
	if left := leftovers(t, filepath.Dir(own)); len(left) != 0 {
		t.Errorf("wrote a download into the user's home: %v", left)
	}
}

// The same rule for a binary that is not root's, or that sits where another account can write:
// either way it is not the machine's to replace, and nothing happens.
func TestHostdUpdateRefusesABinaryThatIsNotRootsAlone(t *testing.T) {
	for _, tc := range []struct {
		name, want string
		arrange    func(h *hostdUpdateHarness)
	}{{
		name: "owned by another account",
		want: "rather than root",
		// The test cannot chown its files to someone else, so it says root is someone else.
		arrange: func(h *hostdUpdateHarness) { h.update.rootUID = uint32(os.Geteuid()) + 1 },
	}, {
		name: "in a directory others can write",
		want: "is not root's alone",
		arrange: func(h *hostdUpdateHarness) {
			if err := os.Chmod(h.dir, 0o775); err != nil {
				h.t.Fatal(err)
			}
		},
	}} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHostdUpdateHarness(t, rolloutTestPrevious, newRolloutRelease(t, rolloutTestLatest))
			tc.arrange(h)
			before := h.sideEffects()

			resp := h.ask(1000)
			if resp.OK {
				t.Fatalf("hostd agreed to update %s: %+v", h.installed, resp.Data)
			}
			if !strings.Contains(resp.Error, tc.want) {
				t.Errorf("error = %q, want it to say %q", resp.Error, tc.want)
			}
			h.assertNoSideEffects(before)
		})
	}
}

// The machine's config is the only source of the server, so a machine that has none says so
// rather than guessing — and does not spend the rate-limit window on the answer.
func TestHostdUpdateReportsAMachineThatWasNeverSetUp(t *testing.T) {
	h := newHostdUpdateHarness(t, rolloutTestPrevious, newRolloutRelease(t, rolloutTestLatest))
	if err := os.Remove(h.configPath); err != nil {
		t.Fatal(err)
	}

	resp := h.ask(1000)
	if resp.OK {
		t.Fatalf("update succeeded without a machine config: %+v", resp.Data)
	}
	if !strings.Contains(resp.Error, "orbit host setup") {
		t.Errorf("error = %q, want the fix in it", resp.Error)
	}
	if _, err := os.Stat(h.stampPath); err == nil {
		t.Error("a failed update consumed the rate-limit window; the next caller would be told 'skipped' instead of the reason")
	}
}

// The verb is reachable through the table hostd actually dispatches on.
func TestHostdUpdateIsRegisteredAsAVerb(t *testing.T) {
	if _, ok := hostdSystemDefaults().verbs()["update"]; !ok {
		t.Fatal("hostd does not offer an update verb")
	}
}

// The wire shape of the delegation, from the runner's side of the socket.
func TestHostdUpdateAnswersTheProtocolsVerbName(t *testing.T) {
	var raw map[string]any
	body, err := json.Marshal(hostdRequest{V: hostdProtocolVersion, Verb: "update"})
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatal(err)
	}
	if raw["verb"] != "update" || raw["v"] != float64(hostdProtocolVersion) {
		t.Fatalf("request body = %v, want {v:1, verb:update}", raw)
	}
}

// The update answers its caller in milliseconds and then works for minutes — downloading,
// swapping, and rolling instances that each take up to TimeoutStopSec to drain. Idle exit must not
// cut that short: a socket that is quiet because the work moved off it is not a machine with
// nothing left to do.
func TestHostdServeStaysUpWhileAnAcceptedUpdateIsStillRunning(t *testing.T) {
	l, err := net.Listen("unix", filepath.Join(t.TempDir(), "busy.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()

	installing := make(chan struct{})
	hostdRunBackground(func() { <-installing })

	done := make(chan error, 1)
	go func() { done <- hostdServe(l, hostdConfig{idleTimeout: 50 * time.Millisecond}, nil) }()

	select {
	case <-done:
		t.Fatal("hostd exited while an accepted update was still installing")
	case <-time.After(400 * time.Millisecond):
	}

	close(installing)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("idle exit should be a clean return, got %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("hostd did not exit once the update had finished")
	}
}
