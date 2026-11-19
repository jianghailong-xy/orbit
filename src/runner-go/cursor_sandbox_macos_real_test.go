//go:build cursor_real && darwin

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCursorRealSandboxMacOS(t *testing.T) {
	r := realCursorEnv(t)
	useCursorEscapeAuthPlatform(t, "linux") // The launcher is held on macOS; this test still drives it.
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	outside, err := os.MkdirTemp(home, ".orbit-cursor-real-sandbox-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(outside)
	previous := cursorShellCLIDir
	cursorShellCLIDir = func(string) string { return filepath.Dir(r.cli) }
	t.Cleanup(func() { cursorShellCLIDir = previous })
	blocked := "python3 - <<'PY'\nfrom pathlib import Path\n(Path.home() / 'outside-file').write_text('blocked')\nPY"
	run := r.run(t, realScenario{name: "sandbox-macos", mode: "auto", fixture: func(t *testing.T, work string) {
		t.Setenv("HOME", outside)
		if err := os.MkdirAll(runnerCacheRoot(), 0700); err != nil {
			t.Fatal(err)
		}
	}, prompts: []string{
		"Use only the Shell tool. Run this exact command once, without changing or retrying it. Report its stderr and stop:\n" + blocked,
	}, approve: func(card cursorTestCard) cursorTestDecision {
		return cursorTestDecision{Status: "DENIED"}
	}})
	report := newRealReport(t)
	report.check("sandbox-configured", run.spec.shellConfig != "", "launcher configured: %v", run.spec.shellConfig != "")
	report.facts["classifierAllows"] = cursorAutoAllows(blocked, run.work, true)
	report.facts["escapePolicy"] = "macOS refuses all escape grants: peer PID/UID alone cannot establish trusted executable, live CLI ancestry/generation, cwd and conversation. No person-approved escape or human click is claimed."
	report.facts["command"] = blocked
	report.check("home-write-blocked", !exists(filepath.Join(outside, "outside-file")), "outside-file absent")
	report.check("no-approval-card", len(run.cards) == 0, "received %d cards", len(run.cards))
	var output strings.Builder
	for _, e := range run.events {
		if e.typ == evToolResult {
			data, _ := json.Marshal(e.payload)
			output.Write(data)
		}
	}
	report.check("english-sandbox-message", strings.Contains(output.String(), "Orbit's Auto sandbox"), "tool output contains sandbox explanation")
	report.check("seatbelt-denial", strings.Contains(output.String(), "Operation not permitted"), "tool output contains macOS filesystem denial")
	report.check("turn-completed", len(run.completions) == 1, "completed %d turns", len(run.completions))
	r.save(t, "sandbox-macos", "process", run, report)
}
