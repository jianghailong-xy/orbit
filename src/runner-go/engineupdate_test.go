package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
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
}

func TestKimiUpdatePreservesInstallSource(t *testing.T) {
	home := filepath.Join(string(filepath.Separator), "home", "alice")
	spec, ok := specFor(providerKimi)
	if !ok {
		t.Fatal("Kimi engine spec missing")
	}
	standalone := filepath.Join(home, ".local", "bin", "kimi")
	if got, ok := engineUpdateCommand(spec, standalone, home); !ok || got != spec.installCmd {
		t.Fatalf("standalone update = (%q, %v), want official installer", got, ok)
	}
	for _, managed := range []string{"/usr/local/bin/kimi", "/opt/homebrew/bin/kimi"} {
		if got, ok := engineUpdateCommand(spec, managed, home); ok || got != "" {
			t.Fatalf("package-managed %s update = (%q, %v), want skip", managed, got, ok)
		}
	}
}

func TestRecordEngineUpdateCarriesLastSuccess(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())

	ok := recordEngineUpdate(providerClaude, updateOK, "")
	if ok.Status != updateOK || ok.At == "" || ok.OkAt != ok.At {
		t.Fatalf("a clean update = %+v, want ok with okAt set to its own time", ok)
	}
	if _, err := time.Parse(time.RFC3339, ok.At); err != nil {
		t.Fatalf("At is not RFC3339: %v", err)
	}

	// The point of the whole record: a failure today must not erase the fact that it worked
	// yesterday, or "erroring right now" and "hasn't worked in weeks" render identically.
	failed := recordEngineUpdate(providerClaude, updateFailed, "npm error code EACCES")
	if failed.Status != updateFailed || failed.OkAt != ok.OkAt {
		t.Fatalf("after a failure = %+v, want okAt %q preserved", failed, ok.OkAt)
	}
	if failed.Message != "npm error code EACCES" {
		t.Fatalf("message = %q, want the machine's own words", failed.Message)
	}
	// Same for a deliberate skip — it is not an attempt that failed, and not one that worked.
	skipped := recordEngineUpdate(providerClaude, updateSkipped, "Installed by a package manager")
	if skipped.Status != updateSkipped || skipped.OkAt != ok.OkAt {
		t.Fatalf("after a skip = %+v, want okAt %q preserved", skipped, ok.OkAt)
	}

	// It survives the process that wrote it: this is what makes a restarted runner able to say
	// "updated 6h ago" instead of going quiet for a day.
	log := loadEngineUpdateLog()
	if got := log[providerClaude]; got.Status != updateSkipped || got.OkAt != ok.OkAt {
		t.Fatalf("reloaded = %+v, want the last record with okAt intact", got)
	}
	// One engine's record says nothing about another's.
	if _, ok := log[providerCodex]; ok {
		t.Fatal("recording claude wrote a codex record")
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

	lines := updateEngines(ctx, func(string) int { return 0 }, nil)

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

	if lines := updateEngines(ctx, func(string) int { return 0 }, nil); len(lines) != 0 {
		t.Fatalf("shutdown produced %q, want silence", lines)
	}
	if log := loadEngineUpdateLog(); len(log) != 0 {
		t.Fatalf("shutdown recorded %v, want nothing", log)
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
