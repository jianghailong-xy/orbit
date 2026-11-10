//go:build cursor_real && darwin

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// This opt-in probe spends two real prompts and waits for the owner via a local file.
// The coordinator obtains the owner card answer before writing the file.
func TestCursorRealMacOSSandboxEscape(t *testing.T) {
	if os.Getenv("ORBIT_CURSOR_MAC_LIVE") != "1" {
		t.Skip("set ORBIT_CURSOR_MAC_LIVE=1 to spend two prompts and request an owner approval")
	}
	approvalFile := os.Getenv("ORBIT_CURSOR_LIVE_APPROVAL_FILE")
	out := os.Getenv("ORBIT_CURSOR_REAL_OUT")
	if !filepath.IsAbs(approvalFile) || !filepath.IsAbs(out) {
		t.Fatal("requires absolute ORBIT_CURSOR_LIVE_APPROVAL_FILE and ORBIT_CURSOR_REAL_OUT")
	}
	if _, err := os.Stat(approvalFile); !os.IsNotExist(err) {
		t.Fatal("approval file must be absent before the run")
	}
	cli, err := cursorExecutablePath()
	if err != nil {
		t.Fatal(err)
	}
	name, token, err := cursorLaunchCredential(&ClaimedSession{Agent: AgentExecConfig{Env: map[string]string{}}})
	if err != nil || name == "" {
		t.Fatalf("signed-in credential unavailable: %v", err)
	}
	home := userHome()
	base := fmt.Sprintf(".orbit-macos-sandbox-escape-%d", time.Now().UnixNano())
	blockedPath, approvedPath := filepath.Join(home, base+"-blocked"), filepath.Join(home, base+"-approved")
	defer os.Remove(blockedPath)
	defer os.Remove(approvedPath)
	useCursorRealHome(t)
	t.Setenv("HOME", home)
	if err := os.MkdirAll(runnerCacheRoot(), 0700); err != nil {
		t.Fatal(err)
	}
	work := filepath.Join(t.TempDir(), "work")
	if err := os.MkdirAll(work, 0755); err != nil {
		t.Fatal(err)
	}
	if data, err := exec.Command("git", "init", "-q", work).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, data)
	}
	blocked := "python3 - <<'PY'\nfrom pathlib import Path\n(Path.home() / '" + base + "-blocked').write_text('blocked')\nPY"
	approved := "printf approved > \"$HOME/" + base + "-approved\""
	first, then := cursorTurns(
		cursorMessage("case-a", "Use only the Shell tool. Run this exact command once without changing or retrying it. Report stderr and stop:\n"+blocked),
		cursorMessage("case-b", "Use only the Shell tool. Run this exact command once without changing or retrying it. Wait for the person's approval if needed, then stop:\n"+approved),
	)
	var decision *ApprovalDecisionResponse
	var decisionMu sync.Mutex
	run := runCursorSession(t, cursorRunOptions{
		executable: cli, sameHome: true, execDir: work, timeout: 30 * time.Minute,
		env: map[string]string{name: token}, first: first, then: then,
		agent: func(a *AgentExecConfig) { a.PermissionMode = "auto" },
		onCard: func(card cursorTestCard) []RunInboxResponse {
			if firstString(mapValue(card.Input), "command") != approved {
				t.Errorf("unexpected approval card: %v", card.Input)
				return nil
			}
			t.Logf("APPROVAL NEEDED: %s (request %s)", approved, card.ID)
			t.Logf("Waiting for owner answer via coordinator; approval file: %s", approvalFile)
			return nil
		},
		approve: func(card cursorTestCard) cursorTestDecision {
			if firstString(mapValue(card.Input), "command") != approved {
				return cursorTestDecision{Status: "DENIED"}
			}
			decisionMu.Lock()
			defer decisionMu.Unlock()
			if decision == nil {
				answer, err := os.ReadFile(approvalFile)
				if err != nil {
					return cursorTestDecision{Status: "PENDING"}
				}
				switch strings.TrimSpace(string(answer)) {
				case "approve " + card.ID:
					decision = &ApprovalDecisionResponse{Status: "ALLOWED", DecidedByID: "owner-via-coordinator-card"}
				case "deny " + card.ID:
					decision = &ApprovalDecisionResponse{Status: "DENIED", DecidedByID: "owner-via-coordinator-card"}
				default:
					return cursorTestDecision{Status: "PENDING"}
				}
				t.Logf("OWNER_DECISION request=%s status=%s source=owner via coordinator card", card.ID, decision.Status)
			}
			return cursorTestDecision{Status: decision.Status, DecidedByID: decision.DecidedByID}
		},
	})
	if err := os.MkdirAll(out, 0755); err != nil {
		t.Fatal(err)
	}
	record, _ := json.MarshalIndent(map[string]interface{}{
		"host": "longdeMac-mini.local", "cli": cli, "launch": run.spec,
		"blockedCommand": blocked, "approvedCommand": approved,
		"cards": run.cards, "ownerDecision": decision, "sandboxConfig": run.spec.shellConfig,
	}, "", "  ")
	// cursorEvent fields are private; record the event payloads explicitly.
	var events []map[string]interface{}
	for _, e := range run.events {
		events = append(events, map[string]interface{}{"turn": e.turn, "type": e.typ, "payload": e.payload})
	}
	eventData, _ := json.MarshalIndent(events, "", "  ")
	if err := os.WriteFile(filepath.Join(out, "launch-and-approval.json"), record, 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(out, "events.json"), eventData, 0644); err != nil {
		t.Fatal(err)
	}
	if run.spec.shellConfig == "" {
		t.Error("sandbox not configured")
	}
	if len(run.cards) != 1 {
		t.Errorf("got %d cards, want only Case B", len(run.cards))
	}
	if decision == nil || decision.Status != "ALLOWED" || decision.DecidedByID == "" {
		t.Error("no real person approval")
	}
	output := string(eventData)
	if !strings.Contains(output, "Operation not permitted") || !strings.Contains(output, "Orbit's Auto sandbox") {
		t.Error("missing Seatbelt denial and sandbox explanation")
	}
	for _, path := range []string{blockedPath, approvedPath} {
		data, err := exec.Command("ls", "-l", path).CombinedOutput()
		t.Logf("ls -l %s\n%s(exit error: %v)", path, data, err)
	}
	if exists(blockedPath) {
		t.Error("Case A wrote outside workspace")
	} else if len(run.cards) == 1 {
		t.Log("CASE_A test -e: absent; no approval card")
	}
	data, err := os.ReadFile(approvedPath)
	if err != nil || string(data) != "approved" {
		t.Errorf("Case B content=%q error=%v", data, err)
	} else {
		t.Log("CASE_B test -e: exists; content=approved")
	}
	if len(run.completions) != 2 {
		t.Errorf("completed %d turns, want 2", len(run.completions))
	}
	if err := os.Remove(approvedPath); err != nil {
		t.Error(err)
	} else {
		t.Logf("CASE_B cleanup: removed; test -e: %t", exists(approvedPath))
		if exists(approvedPath) {
			t.Error("approved probe remains after cleanup")
		}
	}
}
