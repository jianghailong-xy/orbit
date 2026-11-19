//go:build cursor_real && linux

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCursorRealSandbox4(t *testing.T) {
	r := realCursorEnv(t)
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
	blocked := "python3 - <<'PY'\nimport os\nfrom pathlib import Path\nPath(os.environ['HOME'], 'outside-file').write_text('blocked')\nPY"
	planted := `printf() { /usr/bin/touch "$HOME/planted-executed"; builtin printf "$@"; }`
	approved := `printf approved > "$HOME/approved-file"`
	run := r.run(t, realScenario{name: "sandbox-4-linux", mode: "auto", fixture: func(t *testing.T, work string) {
		t.Setenv("HOME", outside)
		if err := os.MkdirAll(runnerCacheRoot(), 0700); err != nil {
			t.Fatal(err)
		}
	}, prompts: []string{
		"Use only the Shell tool. Run this exact command once, without changing or retrying it. Report its stderr and stop:\n" + blocked,
		"Use only the Shell tool. Define this function in one shell call, exactly as written. Do not invoke it or run other commands:\n" + planted,
		"Use only the Shell tool. Run this exact command once, without changing or retrying it, then stop:\n" + approved,
		"Use only the Shell tool. Run exactly `type printf` once, then stop.",
	}, approve: func(card cursorTestCard) cursorTestDecision {
		decision := cursorTestDecision{Status: "ALLOWED"}
		if firstString(mapValue(card.Input), "command") == approved {
			decision.DecidedByID = "controlled-harness-person"
		}
		return decision
	}})
	report := newRealReport(t)
	report.facts["approvalSource"] = "Controlled card-path harness; DecidedByID simulates the server's person answer. No production human UI click is claimed."
	report.facts["cwdPolicy"] = "Approved command uses wrapper startup cwd, without replaying snapshot cwd or state."
	report.check("home-write-blocked", !exists(filepath.Join(outside, "outside-file")), "outside-file absent")
	data, _ := os.ReadFile(filepath.Join(outside, "approved-file"))
	report.check("approved-write-succeeded", string(data) == "approved", "approved-file content %q", data)
	report.check("planted-function-not-executed", !exists(filepath.Join(outside, "planted-executed")), "planted-executed absent")
	var output strings.Builder
	for _, e := range run.events {
		if e.typ == evToolResult {
			output.WriteString(asString(e.payload["content"]))
			b, _ := json.Marshal(e.payload)
			output.Write(b)
		}
	}
	report.check("english-sandbox-message", strings.Contains(output.String(), "Orbit's Auto sandbox"), "tool output contains sandbox explanation")
	report.check("sandbox-snapshot-preserved", strings.Contains(output.String(), "printf is a function") && strings.Contains(output.String(), "planted-executed"), "later sandboxed command sees the persisted function")
	report.check("all-turns-completed", len(run.completions) == 4, "completed %d of four turns", len(run.completions))
	report.facts["commands"] = []string{blocked, planted, approved, "type printf"}
	r.save(t, "sandbox-4-linux", "process", run, report)
}
