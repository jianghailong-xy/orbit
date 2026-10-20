package main

// The install relay's Cursor CLI half (docs/cursor-runtime-contract.md §1, §16.1). A person's Install,
// and Reinstall over a build that is not the pinned one, reach this runner as the same request on a
// heartbeat ({engine: cursor}). The runner downloads the pinned build from the release it was pinned
// against — a local stand-in here, never the network — checks it, puts it in Orbit's version directory,
// and reports the outcome only once its engine report says what the install left, sending the heartbeat
// that carries it at once. Every other engine keeps its own installer. Named in
// scripts/test-cursor-install-relay.mjs.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// installRelayPlane is the control plane's side of the relay, in its wire shapes: it hands a heartbeat
// the install request while its slot is pending, as drainInstallRequest does, takes the runner's reports
// (POST /runner/install-result), and keeps every heartbeat it got and what the runner's engine snapshot
// said of the engine as each report arrived.
type installRelayPlane struct {
	engine string
	health *engineHealthProbe

	mu        sync.Mutex
	slot      string
	reports   []InstallResultRequest
	atReport  []EngineHealthReport
	beats     []HeartbeatRequest
	providers []string
}

func newInstallRelayPlane(t *testing.T, engine string, health *engineHealthProbe) (*installRelayPlane, *Transport) {
	t.Helper()
	p := &installRelayPlane{engine: engine, health: health, slot: "pending"}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		p.mu.Lock()
		defer p.mu.Unlock()
		w.Header().Set("content-type", "application/json")
		switch req.URL.Path {
		case "/api/runner/heartbeat":
			var beat HeartbeatRequest
			if err := json.NewDecoder(req.Body).Decode(&beat); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			p.beats = append(p.beats, beat)
			p.providers = append(p.providers, req.Header.Get("X-Orbit-Supported-Providers"))
			if p.slot != "pending" {
				_, _ = w.Write([]byte(`{}`))
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"installRequest": map[string]string{"engine": p.engine, "attempt": "2026-10-19T08:00:00.000Z", "mode": "install"},
			})
		case "/api/runner/install-result":
			var res InstallResultRequest
			if err := json.NewDecoder(req.Body).Decode(&res); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			p.reports = append(p.reports, res)
			p.atReport = append(p.atReport, engineReportOf(p.health.snapshotNow(), p.engine))
			p.slot = res.Status
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			http.NotFound(w, req)
		}
	}))
	t.Cleanup(server.Close)
	return p, NewTransport(server.URL, "runner-token")
}

// relayOnce is one heartbeat of the run loop's, with the engine snapshot it attaches, and what the run
// loop does with the install request it is handed (runloop.go): the relay, given the engine probe and
// the heartbeat to send once the outcome is reported. It returns once that heartbeat has gone.
func (p *installRelayPlane) relayOnce(t *testing.T, transport *Transport) {
	t.Helper()
	resp, err := transport.heartbeat(HeartbeatRequest{Status: "ONLINE", IdleCapacity: 1, Engines: p.health.snapshotNow()})
	if err != nil {
		t.Fatal(err)
	}
	ir := resp.InstallRequest
	if ir == nil || ir.Engine != p.engine || ir.Mode != "install" || ir.Attempt == "" {
		t.Fatalf("the heartbeat handed over %+v, want an install of %s", ir, p.engine)
	}
	relay := &installRelay{}
	beaten := make(chan struct{})
	relay.start(ir.Engine, func(res InstallResultRequest) {
		if err := transport.installResult(res); err != nil {
			t.Errorf("install-result: %v", err)
		}
	}, p.health, func() {
		// What beatNow asks of the run loop: a heartbeat, now, with the snapshot as it stands.
		if _, err := transport.heartbeat(HeartbeatRequest{Status: "ONLINE", IdleCapacity: 1, Engines: p.health.snapshotNow()}); err != nil {
			t.Errorf("the heartbeat after the outcome: %v", err)
		}
		close(beaten)
	})
	select {
	case <-beaten:
	case <-time.After(2 * time.Minute):
		t.Fatal("the relay never sent the heartbeat after its outcome")
	}
	relay.stop()
}

// outcome is the relay's two reports, what the engine snapshot said as the last one arrived, and what
// the heartbeat right after it carried and declared — after checking that the relay said what it ran,
// then how it ended, and nothing else.
func (p *installRelayPlane) outcome(t *testing.T, command string) (InstallResultRequest, EngineHealthReport, EngineHealthReport, string) {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.reports) != 2 || p.reports[0].Status != installInstalling || p.reports[0].Command != command || p.reports[1].Command != command {
		t.Fatalf("install reports = %+v, want installing then an outcome, each naming %q", p.reports, command)
	}
	if len(p.beats) != 2 {
		t.Fatalf("heartbeats = %d, want the one that handed the install over and the one right after it", len(p.beats))
	}
	return p.reports[1], p.atReport[1], engineReportOf(p.beats[1].Engines, p.engine), p.providers[1]
}

// engineReportOf is engine's entry in a heartbeat's engine report, or a zero report when it has none.
func engineReportOf(reports []EngineHealthReport, engine string) EngineHealthReport {
	for _, report := range reports {
		if report.Engine == engine {
			return report
		}
	}
	return EngineHealthReport{}
}

// cursorOnlyHealth is the run loop's engine probe asking Cursor CLI alone — the machine's own CLIs stay
// out of these tests — with its first answer already in.
func cursorOnlyHealth() *engineHealthProbe {
	health := &engineHealthProbe{probe: func() []EngineHealthReport { return probeEngineHealthOf(providerCursor) }}
	health.refresh()
	return health
}

// declaresCursor is whether an X-Orbit-Supported-Providers names Cursor CLI.
func declaresCursor(header string) bool {
	for _, provider := range strings.Split(header, ",") {
		if strings.TrimSpace(provider) == providerCursor {
			return true
		}
	}
	return false
}

// assertPinnedCursorReady fails unless report is the pinned build, installed and ready here.
func assertPinnedCursorReady(t *testing.T, label string, report EngineHealthReport) {
	t.Helper()
	if !report.Installed || report.Version != "2026.10.14-941492e" || report.InstallationError != "" {
		t.Fatalf("%s: Cursor CLI = %+v, want the pinned 2026.10.14-941492e installed and ready", label, report)
	}
}

// cursorVersionDirs are the entries of Orbit's Cursor CLI versions directory, staging leftovers included.
func cursorVersionDirs(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(cursorVersionsDir())
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names
}

// A person's Install of Cursor CLI, handed over on a heartbeat: the runner downloads the pinned build
// 2026.10.14-941492e once, from its pinned path, checks and publishes it, says what it is running and
// that it is done — and by then its engine report already has the build installed and ready, which the
// heartbeat right after the outcome carries, now declaring provider:cursor. The register-time consent is
// not asked: pressing Install is it. Nothing lands in the runner user's ~/.cursor family.
func TestCursorInstallRelayInstallsThePinnedBuild(t *testing.T) {
	if cursorSupportedVersion != "2026.10.14-941492e" {
		t.Fatalf("the pinned build is %s, not the 2026.10.14-941492e this relay installs", cursorSupportedVersion)
	}
	home := useCursorRealHome(t)
	r := newFakeCursorRelease(t)
	allowCursorInstall(t, false)
	health := cursorOnlyHealth()
	if before := engineReportOf(health.snapshotNow(), providerCursor); before.Installed || !strings.HasPrefix(before.InstallationError, "CURSOR_NOT_INSTALLED:") {
		t.Fatalf("before the install: %+v", before)
	}
	plane, transport := newInstallRelayPlane(t, providerCursor, health)
	if declaresCursor(sentSupportedProviders(t)) {
		t.Fatal("provider:cursor was declared before anything was installed")
	}

	plane.relayOnce(t, transport)

	res, atOutcome, beat, declared := plane.outcome(t, cursorInstallDescription)
	if res.Status != installDone || res.Message != "" {
		t.Fatalf("outcome = %+v", res)
	}
	assertPinnedCursorReady(t, "the engine report as done arrived", atOutcome)
	assertPinnedCursorReady(t, "the heartbeat right after", beat)
	if !declaresCursor(declared) {
		t.Fatalf("the heartbeat right after declared %q, without cursor", declared)
	}
	want := "/2026.10.14-941492e/linux/x64/agent-cli-package.tar.gz"
	if paths := r.requestPaths(); len(paths) != 1 || paths[0] != want {
		t.Fatalf("downloads = %q, want just %s", paths, want)
	}
	exe, err := cursorExecutablePath()
	if err != nil || exe != filepath.Join(home, ".orbit", "cursor", "versions", "2026.10.14-941492e", cursorEntryPoint) {
		t.Fatalf("cursorExecutablePath = %q, %v", exe, err)
	}
	if dirs := cursorVersionDirs(t); len(dirs) != 1 || dirs[0] != cursorSupportedVersion {
		t.Fatalf("versions directory = %v", dirs)
	}
	for _, call := range r.calls(t) {
		if len(call.Args) != 1 || call.Args[0] != "--version" {
			t.Fatalf("the install ran %v: only the version probe should run", call.Args)
		}
		assertProbeHome(t, call, home)
	}
	assertNoCursorStateIn(t, home)
}

// Reinstall is the same request. Over a pinned version directory that is provably not the pinned build —
// one that says it is another version, or one with no entry point (which reads as not installed) — the
// checked tarball takes its place, and a build an earlier pin installed keeps its own directory,
// untouched. A pinned build that is ready is neither downloaded nor written again. Only the person's
// request replaces: a session's own install still reports another build and changes nothing.
func TestCursorReinstallReplacesAnotherBuild(t *testing.T) {
	t.Run("another-version", func(t *testing.T) {
		home := useCursorRealHome(t)
		r := newFakeCursorRelease(t)
		allowCursorInstall(t, true)
		earlier := filepath.Dir(publishFakeCursorVersion(t, r, "2026.10.01-0000001", "2026.10.01-0000001"))
		earlierDigest := cursorTreeDigest(t, earlier)
		publishFakeCursorVersion(t, r, cursorSupportedVersion, "2026.10.16-e3cb207")
		health := cursorOnlyHealth()
		before := engineReportOf(health.snapshotNow(), providerCursor)
		if !before.Installed || before.Version != "2026.10.16-e3cb207" || !strings.HasPrefix(before.InstallationError, "CURSOR_VERSION_INCOMPATIBLE:") {
			t.Fatalf("before the Reinstall: %+v", before)
		}
		// A session's own install reports the build there and leaves it as it is.
		if msg := ensureEngine(context.Background(), providerCursor, func(string) {}); !strings.HasPrefix(msg, "CURSOR_VERSION_INCOMPATIBLE:") {
			t.Fatalf("ensureEngine over another build = %q", msg)
		}
		if len(r.requestPaths()) != 0 {
			t.Fatal("a session's install downloaded over another build")
		}
		plane, transport := newInstallRelayPlane(t, providerCursor, health)

		plane.relayOnce(t, transport)

		res, atOutcome, beat, declared := plane.outcome(t, cursorInstallDescription)
		if res.Status != installDone {
			t.Fatalf("outcome = %+v", res)
		}
		assertPinnedCursorReady(t, "the engine report as done arrived", atOutcome)
		assertPinnedCursorReady(t, "the heartbeat right after", beat)
		if !declaresCursor(declared) {
			t.Fatalf("the heartbeat right after declared %q, without cursor", declared)
		}
		if _, err := cursorExecutablePath(); err != nil {
			t.Fatalf("after the Reinstall: %v", err)
		}
		if len(r.requestPaths()) != 1 {
			t.Fatalf("downloads = %q, want one", r.requestPaths())
		}
		if cursorTreeDigest(t, earlier) != earlierDigest {
			t.Fatal("the build an earlier pin installed was touched")
		}
		if dirs := cursorVersionDirs(t); len(dirs) != 2 || dirs[0] != "2026.10.01-0000001" || dirs[1] != cursorSupportedVersion {
			t.Fatalf("versions directory = %v: the replaced build or a staging directory was left behind", dirs)
		}
		assertNoCursorStateIn(t, home)
	})

	t.Run("no-entry-point", func(t *testing.T) {
		home := useCursorRealHome(t)
		r := newFakeCursorRelease(t)
		if err := os.MkdirAll(cursorVersionDir(), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(cursorVersionDir(), "index.js"), []byte("// half a build\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		health := cursorOnlyHealth()
		if before := engineReportOf(health.snapshotNow(), providerCursor); before.Installed || !strings.HasPrefix(before.InstallationError, "CURSOR_NOT_INSTALLED:") {
			t.Fatalf("before the Install: %+v", before)
		}
		plane, transport := newInstallRelayPlane(t, providerCursor, health)

		plane.relayOnce(t, transport)

		res, atOutcome, beat, _ := plane.outcome(t, cursorInstallDescription)
		if res.Status != installDone {
			t.Fatalf("outcome = %+v", res)
		}
		assertPinnedCursorReady(t, "the engine report as done arrived", atOutcome)
		assertPinnedCursorReady(t, "the heartbeat right after", beat)
		if len(r.requestPaths()) != 1 {
			t.Fatalf("downloads = %q, want one", r.requestPaths())
		}
		if dirs := cursorVersionDirs(t); len(dirs) != 1 || dirs[0] != cursorSupportedVersion {
			t.Fatalf("versions directory = %v", dirs)
		}
		assertNoCursorStateIn(t, home)
	})

	t.Run("pinned-build-ready", func(t *testing.T) {
		useCursorRealHome(t)
		r := newFakeCursorRelease(t)
		installFakeCursor(t)
		digest := cursorTreeDigest(t, cursorVersionDir())
		downloads := len(r.requestPaths())
		plane, transport := newInstallRelayPlane(t, providerCursor, cursorOnlyHealth())

		plane.relayOnce(t, transport)

		res, atOutcome, _, _ := plane.outcome(t, cursorInstallDescription)
		if res.Status != installDone {
			t.Fatalf("outcome = %+v", res)
		}
		assertPinnedCursorReady(t, "the engine report as done arrived", atOutcome)
		if len(r.requestPaths()) != downloads || cursorTreeDigest(t, cursorVersionDir()) != digest {
			t.Fatal("a pinned build that was ready was downloaded or written again")
		}
	})
}

// What a Reinstall cannot prove is another build, or cannot replace with the checked one, stays exactly
// as it was, and the relay says why it failed: a download refused against the pinned size and SHA-256
// leaves the build there in place, and a build that did not answer its version probe — on a loaded
// machine, a busy CLI sessions may be running on — is not replaced at all.
func TestCursorReinstallKeepsWhatItCannotReplace(t *testing.T) {
	t.Run("download-refused", func(t *testing.T) {
		home := useCursorRealHome(t)
		r := newFakeCursorRelease(t)
		publishFakeCursorVersion(t, r, cursorSupportedVersion, "2026.10.16-e3cb207")
		digest := cursorTreeDigest(t, cursorVersionDir())
		tampered := append([]byte(nil), r.tarball...)
		tampered[len(tampered)/2] ^= 0xff
		r.serve(tampered)
		plane, transport := newInstallRelayPlane(t, providerCursor, cursorOnlyHealth())

		plane.relayOnce(t, transport)

		res, atOutcome, _, declared := plane.outcome(t, cursorInstallDescription)
		if res.Status != installFailed || !strings.HasPrefix(res.Message, "CURSOR_INSTALL_FAILED:") || !strings.Contains(res.Message, "SHA-256") {
			t.Fatalf("outcome = %+v, want the refused download", res)
		}
		if !strings.HasPrefix(atOutcome.InstallationError, "CURSOR_VERSION_INCOMPATIBLE:") || atOutcome.Version != "2026.10.16-e3cb207" {
			t.Fatalf("the engine report as the failure arrived: %+v", atOutcome)
		}
		if declaresCursor(declared) {
			t.Fatal("provider:cursor was declared on another build")
		}
		if cursorTreeDigest(t, cursorVersionDir()) != digest {
			t.Fatal("the build there was changed by a Reinstall that failed")
		}
		if dirs := cursorVersionDirs(t); len(dirs) != 1 || dirs[0] != cursorSupportedVersion {
			t.Fatalf("versions directory = %v", dirs)
		}
		assertNoCursorStateIn(t, home)
	})

	t.Run("no-version-answer", func(t *testing.T) {
		useCursorRealHome(t)
		r := newFakeCursorRelease(t)
		if err := os.MkdirAll(cursorVersionDir(), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(cursorVersionDir(), cursorEntryPoint), []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		digest := cursorTreeDigest(t, cursorVersionDir())
		plane, transport := newInstallRelayPlane(t, providerCursor, cursorOnlyHealth())

		plane.relayOnce(t, transport)

		res, _, _, _ := plane.outcome(t, cursorInstallDescription)
		if res.Status != installFailed || !strings.HasPrefix(res.Message, "CURSOR_INSTALL_FAILED:") || !strings.Contains(res.Message, "version probe") {
			t.Fatalf("outcome = %+v, want the version probe's failure", res)
		}
		if len(r.requestPaths()) != 0 || cursorTreeDigest(t, cursorVersionDir()) != digest {
			t.Fatal("a build that did not answer its version probe was replaced")
		}
	})
}

// Every other engine's install keeps its own installer through the same relay: the command it reports
// is that engine's, the installer runs once, and the engine report as done arrives already has it — and
// nothing of Cursor CLI is downloaded or started for it.
func TestInstallRelayKeepsEveryOtherEngineOnItsOwnInstaller(t *testing.T) {
	useCursorRealHome(t)
	r := newFakeCursorRelease(t)
	dir := t.TempDir()
	target, runs := filepath.Join(dir, "orbit-fake-engine"), filepath.Join(dir, "runs")
	installCmd := "echo ran >> " + runs + " && printf '#!/bin/sh\\nexit 0\\n' > " + target + " && chmod +x " + target
	saved := engineSpecs
	engineSpecs = []engineSpec{{name: "Fake Engine", bin: "orbit-fake-engine", installCmd: installCmd, installAlt: "-"}, cursorSpecForTest(t)}
	t.Cleanup(func() { engineSpecs = saved })
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	health := &engineHealthProbe{probe: func() []EngineHealthReport { return probeEngineHealthOf("orbit-fake-engine") }}
	health.refresh()
	if before := engineReportOf(health.snapshotNow(), "orbit-fake-engine"); before.Installed {
		t.Fatalf("before the install: %+v", before)
	}
	plane, transport := newInstallRelayPlane(t, "orbit-fake-engine", health)

	plane.relayOnce(t, transport)

	res, atOutcome, beat, _ := plane.outcome(t, installCmd)
	if res.Status != installDone {
		t.Fatalf("outcome = %+v", res)
	}
	if !atOutcome.Installed || !beat.Installed {
		t.Fatalf("the engine report as done arrived = %+v, and right after = %+v", atOutcome, beat)
	}
	if b, _ := os.ReadFile(runs); strings.Count(string(b), "ran") != 1 {
		t.Fatalf("the engine's installer ran %d times, want once", strings.Count(string(b), "ran"))
	}
	if len(r.requestPaths()) != 0 || len(r.calls(t)) != 0 {
		t.Fatalf("Cursor CLI was downloaded %v or started %v for another engine's install", r.requestPaths(), r.calls(t))
	}
}
