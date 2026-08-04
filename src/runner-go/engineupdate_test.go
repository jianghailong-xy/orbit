package main

import (
	"errors"
	"os"
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
