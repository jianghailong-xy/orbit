package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestUpdateErrDetail(t *testing.T) {
	// Prefers the line naming the cause (EACCES) over npm's "see the log" trailer, which
	// is the actual last line — the whole point of scanning past package-manager trailers.
	npmOut := "npm error code EACCES\nnpm error syscall rename\nnpm error path /usr/lib/node_modules/@openai/codex\nnpm error A complete log of this run can be found in: /root/.npm/_logs/x-debug-0.log\n"
	if got := updateErrDetail(errors.New("exit status 243"), []byte(npmOut)); got != "npm error code EACCES" {
		t.Fatalf("want EACCES cause line, got %q", got)
	}
	// No EACCES/permission line: falls back to the last error line (still skipping the trailer).
	genOut := "warming up\nError: network unreachable\nA complete log of this run can be found in: /x.log\n"
	if got := updateErrDetail(errors.New("exit status 1"), []byte(genOut)); got != "Error: network unreachable" {
		t.Fatalf("want last error line, got %q", got)
	}
	// Falls back to the Go error when the command produced no output.
	if got := updateErrDetail(errors.New(`exec: "sh": not found`), nil); got != `exec: "sh": not found` {
		t.Fatalf("want error fallback, got %q", got)
	}
	// Output that names no cause at all: Kimi's installer dying under `set -euo pipefail` on a
	// silent curl, whose last line is the step it was announcing, not the failure. Reported on
	// its own it accuses a URL that is fine, so the exit status has to come with it.
	kimiOut := "==> Detected linux-x64\n==> Resolving latest version from https://code.kimi.com/kimi-code/latest\n"
	want := "exit status 6 — last output: ==> Resolving latest version from https://code.kimi.com/kimi-code/latest"
	if got := updateErrDetail(errors.New("exit status 6"), []byte(kimiOut)); got != want {
		t.Fatalf("want status plus last line, got %q", got)
	}
}

func TestKimiUpdatePreservesInstallSource(t *testing.T) {
	home := filepath.Join(string(filepath.Separator), "home", "alice")
	spec, ok := specFor(providerKimi)
	if !ok {
		t.Fatal("Kimi engine spec missing")
	}
	// Every directory the official installer is known to use, current and historical. The
	// current one is the reason this test exists in this shape: it recognised only ~/.local/bin
	// while the installer had moved to ~/.kimi-code/bin, so a real, correctly installed Kimi
	// (v0.32.0 at /root/.kimi-code/bin/kimi) was written off as package-managed and never
	// updated again — with the suite green the whole time.
	for _, dir := range []string{
		filepath.Join(home, ".kimi-code", "bin"),
		filepath.Join(home, ".local", "bin"),
	} {
		official := filepath.Join(dir, "kimi")
		if got, ok := engineUpdateCommand(spec, official, home); !ok || got != spec.installCmd {
			t.Fatalf("official install at %s = (%q, %v), want the installer re-run", official, got, ok)
		}
	}
	// A package manager owns updating its own copy; re-running the installer beside it would
	// leave a second, shadowing binary.
	for _, managed := range []string{"/usr/local/bin/kimi", "/opt/homebrew/bin/kimi", "/usr/bin/kimi"} {
		if got, ok := engineUpdateCommand(spec, managed, home); ok || got != "" {
			t.Fatalf("package-managed %s update = (%q, %v), want skip", managed, got, ok)
		}
	}
	// No home, nothing to compare against: don't guess an install is ours.
	if _, ok := engineUpdateCommand(spec, filepath.Join(home, ".kimi-code", "bin", "kimi"), ""); ok {
		t.Fatal("with no home directory, an install must not be treated as official")
	}
}

// The two readers of engineInstallerDirs have to agree: a directory the service PATH adds is
// exactly a directory whose binaries are official installs. They drifted apart once, and only
// the live machine noticed.
func TestEngineInstallerDirsAgreeWithServicePath(t *testing.T) {
	home := filepath.Join(string(filepath.Separator), "home", "alice")
	dirs := engineInstallerDirs(home)
	if len(dirs) == 0 {
		t.Fatal("no installer directories")
	}
	path := runnerEnginePath(home, "/usr/bin")
	for _, dir := range dirs {
		if !pathContains(path, dir) {
			t.Errorf("%s is treated as an official install location but is missing from the service PATH", dir)
		}
		if !installedByOfficialInstaller(filepath.Join(dir, "kimi"), home) {
			t.Errorf("%s is on the service PATH but not recognised as an official install location", dir)
		}
	}
	// A directory that merely contains one of these as a prefix is not one of them.
	if installedByOfficialInstaller(filepath.Join(home, ".local", "bin", "nested", "kimi"), home) {
		t.Error("a nested directory must not count as an official install location")
	}
	if engineInstallerDirs("") != nil {
		t.Error("with no home there are no installer directories to name")
	}
}

// What engineInstallerDirs documents about order has to be what runnerEnginePath's loop does.
// It drifted once already: the list was lifted out of runnerEnginePath and the comment that came
// with it called the slice "PATH precedence order", while the prepend loop went on reversing it —
// a claim about the produced PATH that no test could contradict, because none asserted the order.
func TestServicePathReversesInstallerDirsSoLocalBinLeads(t *testing.T) {
	home := filepath.Join(string(filepath.Separator), "home", "alice")
	dirs := engineInstallerDirs(home)
	if len(dirs) == 0 {
		t.Fatal("no installer directories")
	}
	// Derived from the list, never spelled out: a directory added there is covered by this
	// assertion the moment it is added, rather than the day someone updates a literal.
	reversed := make([]string, 0, len(dirs))
	for i := len(dirs) - 1; i >= 0; i-- {
		reversed = append(reversed, dirs[i])
	}
	want := strings.Join(reversed, ":") + ":/usr/bin"
	if got := runnerEnginePath(home, "/usr/bin"); got != want {
		t.Errorf("service PATH = %q, want %q", got, want)
	}
	// Stated once more the way the comments state it, so a failure names the promise it broke.
	if reversed[0] != filepath.Join(home, ".local", "bin") {
		t.Errorf("~/.local/bin must lead the engine dirs (the Claude/Codex resolution order), got %q", reversed[0])
	}
}

func TestRecordEngineUpdateCarriesLastSuccess(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())

	ok := recordEngineUpdate(providerClaude, updateUpdated, "", engineUpdateFacts{installed: "2.1.228", latest: "2.1.228"})
	if ok.Status != updateUpdated || ok.At == "" || ok.OkAt != ok.At || ok.UpdatedAt != ok.At {
		t.Fatalf("a real update = %+v, want updated with okAt and updatedAt set to its own time", ok)
	}
	if _, err := time.Parse(time.RFC3339, ok.At); err != nil {
		t.Fatalf("At is not RFC3339: %v", err)
	}

	// The point of the whole record: a failure today must not erase the fact that it worked
	// yesterday, or "erroring right now" and "hasn't worked in weeks" render identically.
	failed := recordEngineUpdate(providerClaude, updateFailed, "npm error code EACCES", engineUpdateFacts{installed: "2.1.228", latest: "2.1.229"})
	if failed.Status != updateFailed || failed.OkAt != ok.OkAt || failed.UpdatedAt != ok.UpdatedAt {
		t.Fatalf("after a failure = %+v, want okAt %q and updatedAt %q preserved", failed, ok.OkAt, ok.UpdatedAt)
	}
	if failed.Message != "npm error code EACCES" {
		t.Fatalf("message = %q, want the machine's own words", failed.Message)
	}
	// Same for a deliberate skip — it is not an attempt that failed, and not one that worked.
	skipped := recordEngineUpdate(providerClaude, updateSkipped, "Installed by a package manager", engineUpdateFacts{})
	if skipped.Status != updateSkipped || skipped.OkAt != ok.OkAt {
		t.Fatalf("after a skip = %+v, want okAt %q preserved", skipped, ok.OkAt)
	}
	// A pass that found nothing to fetch must not be able to set updatedAt: that is the whole
	// reason the two words exist. Workstation reported a green okAt for two days off no-ops
	// while it had in fact stopped being able to download anything at all.
	checked := recordEngineUpdate(providerClaude, updateChecked, "", engineUpdateFacts{installed: "2.1.228", latest: "2.1.228"})
	if checked.Status != updateChecked || checked.UpdatedAt != ok.UpdatedAt || checked.OkAt != checked.At {
		t.Fatalf("a no-op pass = %+v, want checked with updatedAt %q untouched", checked, ok.UpdatedAt)
	}

	// It survives the process that wrote it: this is what makes a restarted runner able to say
	// "updated 6h ago" instead of going quiet for a day.
	log := loadEngineUpdateLog()
	if got := log[providerClaude]; got.Status != updateChecked || got.OkAt != checked.OkAt {
		t.Fatalf("reloaded = %+v, want the last record with okAt intact", got)
	}
	// One engine's record says nothing about another's.
	if _, ok := log[providerCodex]; ok {
		t.Fatal("recording claude wrote a codex record")
	}
}

// Drift is the reading the alarm is built on, so it has to survive every way a pass can decline to
// do anything — and it has to stop the moment the machine catches up.
func TestRecordEngineUpdateTracksDrift(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())

	current := recordEngineUpdate(providerClaude, updateChecked, "", engineUpdateFacts{installed: "2.1.226 (Claude Code)", latest: "2.1.226"})
	if current.BehindSince != "" {
		t.Fatalf("a current engine = %+v, want no drift clock running", current)
	}
	// A release ships. The updater then fails — and the drift clock starts anyway, because being
	// behind is a fact about the binary, not about what the last command returned.
	behind := recordEngineUpdate(providerClaude, updateFailed, "timed out", engineUpdateFacts{installed: "2.1.226 (Claude Code)", latest: "2.1.228"})
	if behind.BehindSince == "" || behind.Latest != "2.1.228" {
		t.Fatalf("a machine left behind = %+v, want the drift clock started against 2.1.228", behind)
	}
	// It keeps running rather than restarting: "9d behind" is the number that makes this worth
	// showing, and re-stamping it every night would pin it at "1d behind" forever.
	still := recordEngineUpdate(providerClaude, updateFailed, "timed out again", engineUpdateFacts{installed: "2.1.226 (Claude Code)", latest: "2.1.228"})
	if still.BehindSince != behind.BehindSince {
		t.Fatalf("drift restarted: %q -> %q", behind.BehindSince, still.BehindSince)
	}
	// An unreachable release feed is not evidence of anything. Carrying the last known latest
	// forward is what keeps the drift visible through a network blip.
	blind := recordEngineUpdate(providerClaude, updateFailed, "no feed", engineUpdateFacts{installed: "2.1.226 (Claude Code)"})
	if blind.BehindSince != behind.BehindSince || blind.Latest != "2.1.228" {
		t.Fatalf("after an unreachable feed = %+v, want drift and latest carried", blind)
	}
	// Caught up: the clock clears, and only an actual version match may clear it.
	caught := recordEngineUpdate(providerClaude, updateUpdated, "", engineUpdateFacts{installed: "2.1.228 (Claude Code)", latest: "2.1.228"})
	if caught.BehindSince != "" {
		t.Fatalf("after catching up = %+v, want the drift clock cleared", caught)
	}
}

// The busiest runner is the one that skips every pass, and skipping is not recorded as an outcome
// — so without this the machine most likely to drift is the one that says the least about it.
func TestNoteEngineDriftRecordsWithoutClaimingAnAttempt(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	dir := t.TempDir()
	stub := filepath.Join(dir, providerClaude)
	if err := os.WriteFile(stub, []byte("#!/bin/sh\necho '2.1.226 (Claude Code)'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	feed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("2.1.228\n"))
	}))
	defer feed.Close()

	before := recordEngineUpdate(providerClaude, updateChecked, "nothing to do", engineUpdateFacts{})
	noteEngineDrift(context.Background(), engineSpec{name: "Claude Code", bin: providerClaude, latestURL: feed.URL}, dir)

	got := loadEngineUpdateLog()[providerClaude]
	if got.BehindSince == "" || got.Latest != "2.1.228" {
		t.Fatalf("a skipped-but-drifting engine = %+v, want the drift recorded", got)
	}
	// Nothing was attempted, so nothing may claim one: a skip that moved `at` would read as a
	// pass that ran, and a skip that moved `okAt` would read as one that worked.
	if got.Status != before.Status || got.At != before.At || got.OkAt != before.OkAt || got.Message != before.Message {
		t.Fatalf("a drift note rewrote the last attempt: %+v, want %+v", got, before)
	}
}

func TestLoadEngineUpdateLogTolerates(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	// Never recorded anything: an empty map, not a nil one to index into.
	if log := loadEngineUpdateLog(); len(log) != 0 {
		t.Fatalf("missing file = %v, want empty", log)
	}
	// Garbage on disk must not take the heartbeat's engine probe down with it.
	if err := os.WriteFile(engineUpdateLogPath(), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if log := loadEngineUpdateLog(); len(log) != 0 {
		t.Fatalf("corrupt file = %v, want empty", log)
	}
}

// Three paths can want this machine's one global package-manager prefix: the daily loop, a
// browser-requested update, and a session's on-demand install. The relay's own single-flight
// covers only the second — it is not a lock the daily timer ever touches — so the update path
// has to take the install lock like everything else.
//
// This was a real collision, not a hypothetical: a runner that came online at 10:11 fired its
// first daily pass at 10:21:11.839 (engineUpdateInitialDelay), and a relay update landing
// 182ms later ran a second `codex update` beside it.
func TestUpdateEngineSerializesWithInstalls(t *testing.T) {
	engineInstall.mu.Lock()
	done := make(chan struct{})
	go func() {
		defer close(done)
		// Nothing on PATH: this returns the moment it holds the lock, so "goroutine finished"
		// means exactly "it got past the lock".
		updateEngine(context.Background(), engineSpec{name: "Nope", bin: "orbit-no-such-engine"}, t.TempDir(), nil)
	}()

	select {
	case <-done:
		engineInstall.mu.Unlock()
		t.Fatal("updateEngine proceeded while an install held the lock — two package managers can now run against the same prefix")
	case <-time.After(100 * time.Millisecond):
	}

	engineInstall.mu.Unlock()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("updateEngine never proceeded after the install released the lock")
	}
}

// The pass, not the engine, is the unit that has to fit: the control plane retires a relay slot
// after 12 minutes without knowing how many engines a machine has, and every update holds the
// package-manager lock a session's on-demand install may be waiting on.
func TestEngineUpdateBudgetBoundsTheWholePass(t *testing.T) {
	if engineUpdateBudget > 12*time.Minute {
		t.Fatalf("pass budget %v outlives the control plane's 12m relay timeout — a still-running pass would be declared failed", engineUpdateBudget)
	}
	// Otherwise the per-engine ceiling is the pass ceiling, and one wedged updater takes the
	// whole budget with nothing left for the engines behind it.
	if engineUpdateTimeout >= engineUpdateBudget {
		t.Fatalf("per-engine ceiling %v leaves no budget for the other engines (pass budget %v)", engineUpdateTimeout, engineUpdateBudget)
	}
}

func TestUpdateEnginesOutOfBudgetBlamesNoEngine(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	// A pass whose budget is already gone: nothing gets to run.
	ctx, cancel := context.WithTimeout(context.Background(), 0)
	defer cancel()

	lines := updateEngines(ctx, func(string) int { return 0 }, nil, nil)

	if len(lines) != len(engineSpecs) {
		t.Fatalf("got %d lines for %d engines: %q", len(lines), len(engineSpecs), lines)
	}
	for _, l := range lines {
		if !strings.Contains(l, "not reached") {
			t.Errorf("line %q should say the engine was never reached", l)
		}
	}
	// The point: an engine that never ran must not be recorded as a failure, or the row would
	// wear a warning earned by a wedged neighbour.
	if log := loadEngineUpdateLog(); len(log) != 0 {
		t.Fatalf("out-of-budget pass recorded %v — unreached engines must file nothing", log)
	}
}

func TestUpdateEnginesShutdownIsSilent(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	// Cancelled, not expired: the runner is going down. That is not news about this machine's
	// engines, so it must not turn into a report claiming they were skipped.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if lines := updateEngines(ctx, func(string) int { return 0 }, nil, nil); len(lines) != 0 {
		t.Fatalf("shutdown produced %q, want silence", lines)
	}
	if log := loadEngineUpdateLog(); len(log) != 0 {
		t.Fatalf("shutdown recorded %v, want nothing", log)
	}
}

// fakeUpdatableEngine puts a stub engine in `dir` whose --version reads a file its own
// "updater" rewrites. That file is how a test sees the binary actually move — an exit code
// cannot tell an update that landed from one that wrote somewhere nothing execs — and `runs`
// counts how many times the updater was allowed to run at all.
func fakeUpdatableEngine(t *testing.T, dir, bin, installed, latest, latestURL string) (spec engineSpec, runs string) {
	t.Helper()
	version := filepath.Join(dir, bin+".version")
	runs = filepath.Join(dir, bin+".runs")
	if err := os.WriteFile(version, []byte(installed+" (Fake Engine)\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, bin), []byte("#!/bin/sh\ncat "+version+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return engineSpec{
		name: bin,
		bin:  bin,
		// Appends a mark before moving the version, so an updater that ran and failed is still
		// distinguishable from one that was never started.
		updateCmd: "printf x >> " + runs + "; printf '" + latest + " (Fake Engine)\\n' > " + version,
		latestURL: latestURL,
	}, runs
}

func engineUpdateRuns(t *testing.T, runs string) int {
	t.Helper()
	b, err := os.ReadFile(runs)
	if errors.Is(err, os.ErrNotExist) {
		return 0
	}
	if err != nil {
		t.Fatal(err)
	}
	return len(b)
}

// The behaviour this whole file's skip exists to enable: an engine stepped over because sessions
// were running on it is installed the moment they finish, not at the next 24h tick.
//
// Skipping a busy engine was only half an answer. The retry was the daily ticker, which samples
// the machine at one fixed instant — and a runner that always has work is busy at that instant
// essentially always, so the machine doing the most work was the one that never updated. Live on
// 2026-09-23: wikova sat on Claude Code behind 2.1.280 with behindSince climbing, and the models
// the picker probes out of that CLI were missing Opus 5.5 until somebody ran `claude update` by
// hand.
func TestBusyEngineUpdatesTheMomentItsSessionsFinish(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("needs a shell")
	}
	t.Setenv("ORBIT_HOME", t.TempDir())
	dir := t.TempDir()
	const latest = "2.1.280"
	feed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(latest))
	}))
	defer feed.Close()

	// Two engines, one busy and one not: the skip is per engine, so a machine mid-turn on Claude
	// still updates Codex in the same pass.
	busy, busyRuns := fakeUpdatableEngine(t, dir, "orbit-fake-busy", "2.1.226", latest, feed.URL)
	idle, idleRuns := fakeUpdatableEngine(t, dir, "orbit-fake-idle", "2.1.226", latest, feed.URL)
	saved := engineSpecs
	engineSpecs = []engineSpec{busy, idle}
	t.Cleanup(func() { engineSpecs = saved })
	t.Cleanup(func() { clearDeferredEngineUpdate(busy.bin); clearDeferredEngineUpdate(idle.bin) })
	// Keep the real PATH: the updater runs through `sh`, which has to be findable.
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))

	active := map[string]int{busy.bin: 4}
	activeCount := func(bin string) int { return active[bin] }

	lines := updateEngines(context.Background(), activeCount, nil, nil)

	if engineUpdateRuns(t, busyRuns) != 0 {
		t.Fatal("swapped the binary of an engine with sessions running on it")
	}
	if engineUpdateRuns(t, idleRuns) != 1 {
		t.Fatal("one busy engine held up an idle one — the skip is per engine, not per machine")
	}
	if len(lines) != 2 || !strings.Contains(lines[0], "4 sessions running") {
		t.Fatalf("lines = %q, want the busy engine to say it is waiting on its sessions", lines)
	}
	log := loadEngineUpdateLog()
	// A skip is not an outcome: nothing attempted, nothing filed. Only the drift is, because
	// being behind is true whoever is busy.
	if got := log[busy.bin]; got.Status != "" || got.BehindSince == "" || got.Latest != latest {
		t.Fatalf("skipped engine = %+v, want no recorded attempt but the drift measured", got)
	}

	// Still busy: the retry must not install behind a live session either.
	retryDeferredEngineUpdates(context.Background(), activeCount, nil, nil)
	if engineUpdateRuns(t, busyRuns) != 0 {
		t.Fatal("the idle retry ran an updater while sessions were still running")
	}

	// The last session ends. This is the edge the whole change is about.
	active[busy.bin] = 0
	retryDeferredEngineUpdates(context.Background(), activeCount, nil, nil)

	if engineUpdateRuns(t, busyRuns) != 1 {
		t.Fatal("the engine went idle and its deferred update never ran")
	}
	if got := loadEngineUpdateLog()[busy.bin]; got.Status != updateUpdated || got.BehindSince != "" {
		t.Fatalf("after the retry = %+v, want it recorded as updated with the drift cleared", got)
	}

	// The to-do is discharged, not standing: a retry every 15s must not keep re-running a
	// package manager against an engine that is already current.
	retryDeferredEngineUpdates(context.Background(), activeCount, nil, nil)
	if engineUpdateRuns(t, busyRuns) != 1 {
		t.Fatal("the deferred update stayed filed after it ran")
	}
}

const fakeClaudeLatest = "2.1.280"

// fakeClaudeInstall makes a Claude Code install at 2.1.226 the only engine, with a release feed
// offering fakeClaudeLatest, laid out the way one of its two installers does it. Native: every
// release its own file under share/claude/versions/, linked from bin/claude, and an updater that
// writes the new release beside the old one and re-points the link. npm: the package's cli.js
// behind the same link, and an updater that rewrites it in place. Returns the file counting the
// updater's runs.
//
// Named `claude`, unlike the fakes above, because that is the engine the layout is asked about —
// which makes the service PATH matter: serviceLoginPath puts the installer dirs a PATH lacks in
// front of it, ~/.local/bin among them, where a dev machine's real claude lives. Naming them after
// the fake's dir leaves nothing to prepend, and the result is checked rather than trusted.
func fakeClaudeInstall(t *testing.T, native bool) (runs string) {
	t.Helper()
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("needs a shell")
	}
	t.Setenv("ORBIT_HOME", t.TempDir())
	feed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(fakeClaudeLatest))
	}))
	t.Cleanup(feed.Close)

	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	installed := filepath.Join(dir, "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js")
	next := installed
	if native {
		versions := filepath.Join(dir, "share", "claude", "versions")
		installed, next = filepath.Join(versions, "2.1.226"), filepath.Join(versions, fakeClaudeLatest)
	}
	for _, d := range []string{bin, filepath.Dir(installed)} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(installed, []byte("#!/bin/sh\necho '2.1.226 (Claude Code)'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(bin, providerClaude)
	if err := os.Symlink(installed, link); err != nil {
		t.Fatal(err)
	}
	runs = filepath.Join(dir, "update.runs")
	update := "printf x >> " + runs + "; printf '#!/bin/sh\\necho \"" + fakeClaudeLatest + " (Claude Code)\"\\n' > " + next + "; chmod +x " + next
	if native {
		update += "; ln -sf " + next + " " + link
	}
	saved := engineSpecs
	engineSpecs = []engineSpec{{name: "Claude Code", bin: providerClaude, updateCmd: update, latestURL: feed.URL}}
	t.Cleanup(func() { engineSpecs = saved })
	t.Cleanup(func() { clearDeferredEngineUpdate(providerClaude) })

	path := []string{bin}
	if u, err := user.Current(); err == nil {
		path = append(path, engineInstallerDirs(u.HomeDir)...)
	}
	t.Setenv("PATH", strings.Join(append(path, os.Getenv("PATH")), ":"))
	if got, _ := lookPathIn(providerClaude, serviceLoginPath()); got != link {
		t.Fatalf("the service PATH resolves claude to %q, not the fake at %s", got, link)
	}
	return runs
}

// A native Claude Code install updates under its running sessions rather than waiting for them.
// Its updater puts the new release beside the one they are running and re-points the link, so the
// skip protected nothing and only held back the version the next spawn gets. Live on 2026-09-23 an
// interactive 2.1.278, two days into its run, carried on straight through the update to 2.1.280,
// as did the four runner engines running at that moment.
func TestNativeClaudeUpdatesWhileItsSessionsRun(t *testing.T) {
	runs := fakeClaudeInstall(t, true)
	active := map[string]int{providerClaude: 3}
	activeCount := func(bin string) int { return active[bin] }

	lines := updateEngines(context.Background(), activeCount, nil, nil)

	if engineUpdateRuns(t, runs) != 1 {
		t.Fatal("a native install waited on its sessions — its updater replaces nothing they run")
	}
	if deferredEngineUpdates()[providerClaude] {
		t.Fatal("updated, and still filed for the idle retry")
	}
	if got := loadEngineUpdateLog()[providerClaude]; got.Status != updateUpdated || versionNumber(got.Latest) != fakeClaudeLatest {
		t.Fatalf("recorded %+v, want it updated to %s", got, fakeClaudeLatest)
	}
	if len(lines) != 1 || strings.Contains(lines[0], "once they finish") ||
		!strings.Contains(lines[0], "(3 sessions) keeps the version it started with") {
		t.Fatalf("lines = %q, want the update reported, saying the running sessions keep theirs", lines)
	}
	// Nothing left owing: the retry must not run the updater a second time.
	retryDeferredEngineUpdates(context.Background(), activeCount, nil, nil)
	if engineUpdateRuns(t, runs) != 1 {
		t.Fatal("the idle retry updated an engine the pass already had")
	}
}

// npm-installed Claude Code keeps the skip: npm rewrites the package in place, and nobody has shown
// that to be safe under a session running out of it. Same engine, same busy sessions as the native
// case — the layout is the only difference, and it is what decides.
func TestNpmClaudeStillWaitsForItsSessions(t *testing.T) {
	runs := fakeClaudeInstall(t, false)
	active := map[string]int{providerClaude: 3}
	activeCount := func(bin string) int { return active[bin] }

	lines := updateEngines(context.Background(), activeCount, nil, nil)

	if engineUpdateRuns(t, runs) != 0 {
		t.Fatal("rewrote an npm install under the sessions running out of it")
	}
	if !deferredEngineUpdates()[providerClaude] {
		t.Fatal("skipped without filing it for the idle retry")
	}
	if len(lines) != 1 || !strings.Contains(lines[0], "3 sessions running, it'll update once they finish") {
		t.Fatalf("lines = %q, want it waiting on its sessions", lines)
	}

	active[providerClaude] = 0
	retryDeferredEngineUpdates(context.Background(), activeCount, nil, nil)
	if engineUpdateRuns(t, runs) != 1 {
		t.Fatal("its sessions finished and the deferred update never ran")
	}
}

// Narrow on purpose: whatever this lets through is updated under live sessions, so anything that
// isn't plainly the native installer's own layout keeps the skip.
func TestNativeClaudeInstallIsOnlyTheVersionsLayout(t *testing.T) {
	dir := t.TempDir()
	file := func(path string) string {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		return path
	}
	claude := engineSpec{bin: providerClaude}
	release := file(filepath.Join(dir, "share", "claude", "versions", "2.1.280"))
	for _, c := range []struct {
		name   string
		spec   engineSpec
		target string // what the PATH entry links to; empty for a plain file
		want   bool
	}{
		{"native install", claude, release, true},
		{"npm install", claude, file(filepath.Join(dir, "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js")), false},
		{"plain file on PATH", claude, "", false},
		{"another engine linked the same way", engineSpec{bin: providerCodex}, release, false},
		{"a half-written download", claude, file(filepath.Join(dir, "share", "claude", "versions", "2.1.280.tmp.4242.1790000000")), false},
		{"someone else's versions dir", claude, file(filepath.Join(dir, "share", "other", "versions", "2.1.280")), false},
	} {
		t.Run(c.name, func(t *testing.T) {
			pathDir := t.TempDir()
			entry := filepath.Join(pathDir, c.spec.bin)
			if c.target == "" {
				file(entry)
			} else if err := os.Symlink(c.target, entry); err != nil {
				t.Fatal(err)
			}
			got, ok := nativeClaudeInstall(c.spec, pathDir)
			if ok != c.want {
				t.Fatalf("native = %v (resolved to %q), want %v", ok, got, c.want)
			}
			if want, _ := filepath.EvalSymlinks(c.target); ok && got != want {
				t.Fatalf("resolved to %q, want the release file %q", got, want)
			}
		})
	}
}

// ORBIT_NO_ENGINE_UPDATE turns off automatic engine updates — all of them. The idle retry is a
// second scheduler inside the same loop, so "disabled" has to mean it too; a machine that opted
// out must not find an engine swapped under it the moment it goes quiet.
func TestNoEngineUpdateEnvDisablesTheIdleRetryToo(t *testing.T) {
	t.Setenv("ORBIT_NO_ENGINE_UPDATE", "1")
	deferEngineUpdate("orbit-fake-optedout")
	t.Cleanup(func() { clearDeferredEngineUpdate("orbit-fake-optedout") })

	// Cancellable so that a run which does NOT return promptly — the failure this asserts
	// against — is stopped here rather than left sleeping out engineUpdateInitialDelay.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		engineUpdateLoop(ctx, func(string) int { return 0 }, nil, nil)
	}()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("engineUpdateLoop kept running with ORBIT_NO_ENGINE_UPDATE set")
	}
	if !deferredEngineUpdates()["orbit-fake-optedout"] {
		t.Fatal("the opted-out loop discharged a deferred update")
	}
}

// The failure this reproduces: every installer forks, exec.CommandContext kills only the `sh`,
// and the forked child keeps the output pipe open — so CombinedOutput blocks past the deadline
// and the caller keeps engineInstall.mu. Observed live as an `opencode upgrade` still running
// 14 minutes into a 5-minute ceiling, with the machine unable to install any engine behind it.
func TestEngineCommandTimesOutDespiteForkedChild(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("needs a shell")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	// A child that outlives its shell and holds the inherited pipe — exactly what a forking
	// installer does. Without the process-tree teardown, CombinedOutput waits on this sleep.
	cmd := exec.CommandContext(ctx, "sh", "-c", "sleep 60 & sleep 60")
	configureEngineCommandTree(cmd)

	start := time.Now()
	done := make(chan struct{})
	go func() { defer close(done); _, _ = cmd.CombinedOutput() }()

	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("the command outlived its context — a forked child is holding the output pipe, and with it the package-manager lock")
	}
	// WaitDelay adds a few seconds of grace; anything near the child's 60s means it was awaited.
	if elapsed := time.Since(start); elapsed > 15*time.Second {
		t.Fatalf("took %v to give up on a 300ms deadline", elapsed)
	}
}

// An install this runner can't replace is an answer, not an attempt. Live symptom: `opencode
// upgrade` under a non-root runner, against a root-owned npm prefix, wedged for the whole
// ceiling on every pass and reported a failure that retrying reproduces forever.
func TestEngineBinaryUpdatable(t *testing.T) {
	if target := os.Getenv(engineUnwritableChildEnv); target != "" {
		assertEngineBinaryNotUpdatable(t, target)
		return
	}
	dir := t.TempDir()

	own := filepath.Join(dir, "mine")
	if err := os.WriteFile(own, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if real, ok := engineBinaryUpdatable(own); !ok || real != own {
		t.Fatalf("own binary = (%q, %v), want updatable", real, ok)
	}

	// What /usr/bin/opencode actually is: a link into a prefix elsewhere. The link's own mode
	// says nothing about whether the thing it points at can be replaced, so the target is what
	// gets checked — and reported, since that is the path the user has to go fix.
	link := filepath.Join(dir, "linked")
	if err := os.Symlink(own, link); err != nil {
		t.Fatal(err)
	}
	if real, ok := engineBinaryUpdatable(link); !ok || real != own {
		t.Fatalf("symlink = (%q, %v), want the resolved target", real, ok)
	}

	// Anything that isn't a permission problem stays a normal update attempt: a racing
	// uninstall must not be explained to the user as somebody else's install.
	if _, ok := engineBinaryUpdatable(filepath.Join(dir, "gone")); !ok {
		t.Fatal("a missing binary should not read as 'not yours'")
	}

	theirs := filepath.Join(dir, "theirs")
	if err := os.WriteFile(theirs, []byte("#!/bin/sh\n"), 0o555); err != nil {
		t.Fatal(err)
	}
	assertEngineBinaryNotUpdatableAsRunner(t, theirs)
}

func TestRunnerUserLabelAlwaysNamesSomething(t *testing.T) {
	// This lands in a message whose only job is "this install isn't yours" — an empty name
	// would make it unactionable, so the uid fallback has to produce something comparable
	// against `ls -l`.
	if label := runnerUserLabel(); strings.TrimSpace(label) == "" {
		t.Fatal("runnerUserLabel returned nothing")
	}
}

func TestPlural(t *testing.T) {
	// This lands in a sentence a user reads while waiting on their own button press.
	if got := plural(1, "session"); got != "1 session" {
		t.Fatalf("plural(1) = %q", got)
	}
	if got := plural(3, "session"); got != "3 sessions" {
		t.Fatalf("plural(3) = %q", got)
	}
}

func TestEngineUpdateManualCmdIsReal(t *testing.T) {
	// The panel prints this as the way to do by hand what the button does. If the subcommand
	// is ever renamed, this catches the panel telling users to run something that doesn't exist.
	if !strings.HasSuffix(engineUpdateManualCmd, "engine-update") {
		t.Fatalf("manual command = %q, want the `orbit engine-update` entry point", engineUpdateManualCmd)
	}
}

func TestEngineSpecsUpdateCmd(t *testing.T) {
	specs := map[string]engineSpec{}
	for _, s := range engineSpecs {
		specs[s.bin] = s
	}
	// Claude and Codex update via their own unattended updaters. Kimi's update command
	// becomes a manual hint without a TTY, so it deliberately repeats the official
	// idempotent installer via the empty-command fallback.
	if got := specs[providerClaude].updateCmd; got != "claude update" {
		t.Fatalf("claude updateCmd = %q, want %q", got, "claude update")
	}
	if got := specs[providerCodex].updateCmd; got != "codex update" {
		t.Fatalf("codex updateCmd = %q, want %q", got, "codex update")
	}
	if got := specs[providerKimi].updateCmd; got != "" {
		t.Fatalf("kimi updateCmd = %q, want the unattended installer fallback", got)
	}
	if got := specs[providerOpenCode].updateCmd; got != "opencode upgrade" {
		t.Fatalf("opencode updateCmd = %q, want %q", got, "opencode upgrade")
	}
	// No other engine may rely on the installCmd fallback for its daily update.
	for _, s := range engineSpecs {
		if s.updateCmd == "" && s.bin != providerKimi {
			t.Errorf("%s has no updateCmd; the installCmd fallback can target a different install than PATH", s.name)
		}
	}
}

func TestLatestEngineVersion(t *testing.T) {
	// A bare version body (Claude, Kimi) and a JSON field (the npm feeds Codex and OpenCode
	// publish to) are the two shapes in use; both have to reduce to the same comparable number.
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("2.1.228\n"))
	}))
	defer plain.Close()
	if got := latestEngineVersion(context.Background(), engineSpec{latestURL: plain.URL}); got != "2.1.228" {
		t.Fatalf("plain feed = %q, want 2.1.228", got)
	}
	npm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"name":"@openai/codex","version":"0.147.0"}`))
	}))
	defer npm.Close()
	if got := latestEngineVersion(context.Background(), engineSpec{latestURL: npm.URL, latestField: "version"}); got != "0.147.0" {
		t.Fatalf("npm feed = %q, want 0.147.0", got)
	}

	// Every way of not getting an answer has to come back empty rather than confidently wrong:
	// an empty latest means "we don't know", and the caller then updates exactly as it always did.
	// A feed answering with an HTML error page is the one that matters — CDNs do it constantly,
	// and a version number scraped out of one would park a machine on a release that never shipped.
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("<html><body>502 1.2.3</body></html>"))
	}))
	defer bad.Close()
	if got := latestEngineVersion(context.Background(), engineSpec{latestURL: bad.URL}); got != "" {
		t.Fatalf("a 502 = %q, want no answer at all", got)
	}
	if got := latestEngineVersion(context.Background(), engineSpec{}); got != "" {
		t.Fatalf("an engine with no feed = %q, want no answer", got)
	}
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	dead.Close()
	if got := latestEngineVersion(context.Background(), engineSpec{latestURL: dead.URL}); got != "" {
		t.Fatalf("an unreachable feed = %q, want no answer", got)
	}
}

func TestSameVersionComparesTheNumbers(t *testing.T) {
	// What the CLIs actually print, against what the feeds actually return.
	for _, c := range []struct {
		installed, latest string
		want              bool
	}{
		{"2.1.228 (Claude Code)", "2.1.228", true},
		{"codex-cli 0.147.0", "0.147.0", true},
		{"2.1.226 (Claude Code)", "2.1.228", false},
		// Neither side parseable is "don't know", and don't-know must never read as "behind":
		// a machine whose --version output we can't read has done nothing wrong.
		{"", "2.1.228", false},
		{"2.1.228 (Claude Code)", "", false},
		{"some build", "another build", false},
	} {
		if got := sameVersion(c.installed, c.latest); got != c.want {
			t.Errorf("sameVersion(%q, %q) = %v, want %v", c.installed, c.latest, got, c.want)
		}
	}
}

// Knowing what is published turns the daily pass into a decision. When there is nothing to fetch,
// the right amount of package manager to run is none — it keeps the machine's one install slot
// free and leaves the pass budget to the engines that do need it.
func TestUpdateEngineSkipsTheCommandWhenAlreadyCurrent(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	dir := t.TempDir()
	stub := filepath.Join(dir, providerClaude)
	if err := os.WriteFile(stub, []byte("#!/bin/sh\necho '2.1.228 (Claude Code)'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	feed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("2.1.228"))
	}))
	defer feed.Close()
	ran := filepath.Join(dir, "the-updater-ran")

	rec, line := updateEngine(context.Background(), engineSpec{
		name: "Claude Code", bin: providerClaude, updateCmd: "touch " + ran, latestURL: feed.URL,
	}, dir, nil)

	if _, err := os.Stat(ran); err == nil {
		t.Fatal("ran the update command for a version that is already the newest one published")
	}
	if rec.Status != updateChecked || rec.UpdatedAt != "" || rec.BehindSince != "" {
		t.Fatalf("record = %+v, want checked with no update claimed and no drift", rec)
	}
	if !strings.Contains(line, "already up to date") {
		t.Fatalf("line = %q, want it to say there was nothing to fetch", line)
	}
}

// The counterpart: a machine that is behind still runs its updater, and what it reports names the
// version it was reaching for. "Update timed out" is unactionable; "2.1.226 → 2.1.228" is not.
func TestUpdateEngineNamesTheVersionItWasFetching(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	dir := t.TempDir()
	stub := filepath.Join(dir, providerClaude)
	if err := os.WriteFile(stub, []byte("#!/bin/sh\necho '2.1.226 (Claude Code)'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	feed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("2.1.228"))
	}))
	defer feed.Close()

	rec, _ := updateEngine(context.Background(), engineSpec{
		name: "Claude Code", bin: providerClaude, updateCmd: "echo 'boom' >&2; exit 1", latestURL: feed.URL,
	}, dir, nil)

	if rec.Status != updateFailed || !strings.Contains(rec.Message, "2.1.226 → 2.1.228") {
		t.Fatalf("record = %+v, want a failure naming the version step", rec)
	}
	if rec.BehindSince == "" || rec.Latest != "2.1.228" {
		t.Fatalf("record = %+v, want the drift clock running against 2.1.228", rec)
	}
}

func TestEngineOutputProgress(t *testing.T) {
	// A command that was stopped having said nothing, versus one that was still talking. The
	// stopwatch reads the same for both; the two need opposite responses, and this is the line
	// that tells them apart.
	silent := &engineOutput{}
	if got := silent.progress(); got != "it printed nothing at all" {
		t.Fatalf("silent progress = %q", got)
	}
	talking := &engineOutput{}
	if _, err := talking.Write([]byte(strings.Repeat("x", 2048))); err != nil {
		t.Fatal(err)
	}
	if got := talking.progress(); !strings.Contains(got, "2.0 KB") || !strings.Contains(got, "ago") {
		t.Fatalf("talking progress = %q, want how much and how long ago", got)
	}
	// Bounded: the tail is what the error message reads, and an updater with a lot to say must
	// not be able to hold all of it. The last lines are the ones that name the cause.
	flood := &engineOutput{}
	if _, err := flood.Write([]byte(strings.Repeat("a\n", engineOutputTail) + "npm error code EACCES\n")); err != nil {
		t.Fatal(err)
	}
	if len(flood.bytes()) > engineOutputTail {
		t.Fatalf("kept %d bytes, want at most %d", len(flood.bytes()), engineOutputTail)
	}
	if updateErrDetail(errors.New("exit status 1"), flood.bytes()) != "npm error code EACCES" {
		t.Fatal("the tail dropped the line that names the cause")
	}
}

// The arrow needs both ends. On a loaded machine a 300MB CLI can miss the version probe's own
// ceiling, and that machine — the one whose updates then time out — is exactly where this message
// has to be readable. Observed live as "→ 2.1.229: `claude update` was still running…", a target
// version arriving from nowhere.
func TestUpdateEngineMessageSurvivesAnUnreadableInstalledVersion(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	dir := t.TempDir()
	// A binary that refuses to answer --version, which is what engineVersion returning "" means.
	stub := filepath.Join(dir, providerClaude)
	if err := os.WriteFile(stub, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	feed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("2.1.229"))
	}))
	defer feed.Close()

	rec, _ := updateEngine(context.Background(), engineSpec{
		name: "Claude Code", bin: providerClaude, updateCmd: "echo boom >&2; exit 1", latestURL: feed.URL,
	}, dir, nil)

	if strings.Contains(rec.Message, "→") {
		t.Fatalf("message = %q, want no half-drawn arrow when the installed version is unknown", rec.Message)
	}
	if !strings.Contains(rec.Message, "fetching 2.1.229") {
		t.Fatalf("message = %q, want it to still name the version it was reaching for", rec.Message)
	}
}

// The picker's list is probed out of the engine CLIs themselves, so the one event that changes it
// between catalog passes is a CLI that moves versions — and installing that CLI is this loop's
// job. Live on 2026-09-24: a runner was auto-updated to Claude Code 2.1.280 at 16:20Z, a CLI that
// can run Opus 5.5, and its catalog went on listing `claude-opus-5` for up to four hours, because
// installing a newer CLI re-read nothing. So a pass that really moved a version reports it.
func TestUpdatedEngineReReadsTheModelCatalog(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("needs a shell")
	}
	t.Setenv("ORBIT_HOME", t.TempDir())
	dir := t.TempDir()
	const latest = "2.1.280"
	feed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(latest))
	}))
	defer feed.Close()

	a, aRuns := fakeUpdatableEngine(t, dir, "orbit-fake-a", "2.1.226", latest, feed.URL)
	b, bRuns := fakeUpdatableEngine(t, dir, "orbit-fake-b", "0.9.0", latest, feed.URL)
	saved := engineSpecs
	engineSpecs = []engineSpec{a, b}
	t.Cleanup(func() { engineSpecs = saved })
	// Keep the real PATH: the updater runs through `sh`, which has to be findable.
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))

	refreshes := 0
	updateEngines(context.Background(), func(string) int { return 0 }, nil, func() { refreshes++ })

	if engineUpdateRuns(t, aRuns) != 1 || engineUpdateRuns(t, bRuns) != 1 {
		t.Fatalf("the pass moved %d + %d versions, want both engines updated",
			engineUpdateRuns(t, aRuns), engineUpdateRuns(t, bRuns))
	}
	// Once for the pass, not once per engine: the refresh re-reads every runtime it can see, and a
	// second request arriving during one is dropped by its own TryLock anyway.
	if refreshes != 1 {
		t.Fatalf("a pass that moved two versions re-read the catalog %d times, want 1", refreshes)
	}
}

// The other half of that contract: nothing moved, so there is nothing new to read. Both of these
// are passes that leave the CLIs exactly as they were — one the release feed says is already
// current (no package manager runs at all), one whose updater failed — and the catalog is a probe
// of those CLIs.
func TestAPassThatChangesNoVersionLeavesTheModelCatalogAlone(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("needs a shell")
	}
	t.Setenv("ORBIT_HOME", t.TempDir())
	dir := t.TempDir()
	const installed = "2.1.226"
	feed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(installed))
	}))
	defer feed.Close()

	current, currentRuns := fakeUpdatableEngine(t, dir, "orbit-fake-current", installed, installed, feed.URL)
	// No feed to ask, so the updater is what decides — and it fails. Built from the same fake so
	// the binary and its --version are real files, then given an updater that only exits non-zero.
	broken, brokenRuns := fakeUpdatableEngine(t, dir, "orbit-fake-broken", "0.9.0", "9.9.9", "")
	broken.updateCmd = "printf x >> " + brokenRuns + "; echo 'npm error code EACCES' >&2; exit 1"
	saved := engineSpecs
	engineSpecs = []engineSpec{current, broken}
	t.Cleanup(func() { engineSpecs = saved })
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))

	refreshes := 0
	updateEngines(context.Background(), func(string) int { return 0 }, nil, func() { refreshes++ })

	if engineUpdateRuns(t, currentRuns) != 0 {
		t.Fatal("an engine the feed says is current ran its updater")
	}
	// Without this the test would pass on a pass that never got as far as an update at all.
	if engineUpdateRuns(t, brokenRuns) != 1 {
		t.Fatal("the failing engine's updater never ran, so nothing here proves a failed update is quiet")
	}
	if log := loadEngineUpdateLog(); log[current.bin].Status != updateChecked || log[broken.bin].Status != updateFailed {
		t.Fatalf("recorded %q / %q, want %q / %q",
			log[current.bin].Status, log[broken.bin].Status, updateChecked, updateFailed)
	}
	if refreshes != 0 {
		t.Fatalf("no engine changed version, yet the catalog was re-read %d times", refreshes)
	}
}

// The idle retry is a second scheduler for the same work, so it owes the same report: the engine it
// installs the moment the machine falls idle may well be the one whose new models the picker is
// missing, and making it wait for the catalog ticker would be the same staleness one path over.
func TestTheIdleRetryReReadsTheModelCatalogWhenItUpdates(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("needs a shell")
	}
	t.Setenv("ORBIT_HOME", t.TempDir())
	dir := t.TempDir()
	const latest = "2.1.280"
	feed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(latest))
	}))
	defer feed.Close()

	busy, busyRuns := fakeUpdatableEngine(t, dir, "orbit-fake-busy", "2.1.226", latest, feed.URL)
	saved := engineSpecs
	engineSpecs = []engineSpec{busy}
	t.Cleanup(func() { engineSpecs = saved })
	t.Cleanup(func() { clearDeferredEngineUpdate(busy.bin) })
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))

	active := map[string]int{busy.bin: 3}
	activeCount := func(bin string) int { return active[bin] }
	refreshes := 0
	onUpdated := func() { refreshes++ }

	updateEngines(context.Background(), activeCount, nil, onUpdated)
	if refreshes != 0 {
		t.Fatal("the engine was skipped for being busy, and the catalog re-read for it anyway")
	}

	active[busy.bin] = 0
	retryDeferredEngineUpdates(context.Background(), activeCount, nil, onUpdated)
	if engineUpdateRuns(t, busyRuns) != 1 {
		t.Fatal("the engine went idle and its deferred update never ran")
	}
	if refreshes != 1 {
		t.Fatalf("the idle retry installed a new version and re-read the catalog %d times, want 1", refreshes)
	}

	// The to-do is discharged by the retry, so the runs that follow within seconds of each other —
	// every engineIdleRetryInterval — must not keep re-reading a catalog nothing changed.
	retryDeferredEngineUpdates(context.Background(), activeCount, nil, onUpdated)
	if refreshes != 1 {
		t.Fatalf("a retry with nothing left to install re-read the catalog (%d calls)", refreshes)
	}
}

// The third way an engine's version moves on this machine: the Engines panel's Update button, which
// runs through the same pass (see installRelay.startUpdate). Pressing it is what someone does when
// the picker looks wrong, so it is the last path that may leave the picker as it was.
func TestTheUpdateButtonReReadsTheModelCatalogAfterAVersionChange(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("needs a shell")
	}
	t.Setenv("ORBIT_HOME", t.TempDir())
	dir := t.TempDir()
	const latest = "2.1.280"
	feed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(latest))
	}))
	defer feed.Close()

	spec, runs := fakeUpdatableEngine(t, dir, "orbit-relay-fake", "2.1.226", latest, feed.URL)
	saved := engineSpecs
	engineSpecs = []engineSpec{spec}
	t.Cleanup(func() { engineSpecs = saved })
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))

	refreshes := make(chan struct{}, 4)
	done := make(chan struct{})
	relay := &installRelay{}
	relay.startUpdate(func(string) int { return 0 }, nil,
		func(InstallResultRequest) {}, func() { close(done) }, func() { refreshes <- struct{}{} })

	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("the update relay never finished")
	}
	if engineUpdateRuns(t, runs) != 1 {
		t.Fatal("the relay never ran the fake updater")
	}
	select {
	case <-refreshes:
	default:
		t.Fatal("the Update button moved an engine's version and nothing re-read the catalog")
	}
	select {
	case <-refreshes:
		t.Fatal("the catalog was re-read more than once for one run of the button")
	default:
	}
}
