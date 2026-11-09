//go:build cursor_real && darwin

package main

import (
	"context"
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

// This opt-in probe spends two real prompts and waits for a real owner card.
// The control-plane fixture drives turns; approval provenance comes from Orbit.
func TestCursorRealMacOSSandboxEscape(t *testing.T) {
	if os.Getenv("ORBIT_CURSOR_MAC_LIVE") != "1" {
		t.Skip("set ORBIT_CURSOR_MAC_LIVE=1 to spend two prompts and request an owner approval")
	}
	session := os.Getenv("ORBIT_CURSOR_LIVE_SESSION")
	jobID := os.Getenv("ORBIT_CURSOR_LIVE_JOB")
	out := os.Getenv("ORBIT_CURSOR_REAL_OUT")
	cfg := loadConfig()
	if session == "" || jobID == "" || !filepath.IsAbs(out) || cfg == nil {
		t.Fatal("requires ORBIT_CURSOR_LIVE_SESSION, ORBIT_CURSOR_LIVE_JOB, absolute ORBIT_CURSOR_REAL_OUT and runner config")
	}
	transport := newCallerTransport(cfg.ServerURL, cfg.RunnerToken, runnerCallerMCP)
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
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	var decision *ApprovalDecisionResponse
	var decisionMu sync.Mutex
	run := runCursorSession(t, cursorRunOptions{
		executable: cli, sameHome: true, execDir: work, timeout: 15 * time.Minute,
		env: map[string]string{name: token}, first: first, then: then,
		agent: func(a *AgentExecConfig) { a.PermissionMode = "auto" },
		onCard: func(card cursorTestCard) []RunInboxResponse {
			if firstString(mapValue(card.Input), "command") != approved {
				t.Errorf("unexpected approval card: %v", card.Input)
				return nil
			}
			id, err := transport.createApproval(ctx, session, map[string]interface{}{
				"toolName": card.ToolName, "input": card.Input, "toolUseId": base,
				"backgroundJobId": jobID,
			})
			if err != nil {
				t.Errorf("real card: %v", err)
				return nil
			}
			t.Logf("REAL_OWNER_CARD %s command=%s", id, approved)
			go func() {
				for ctx.Err() == nil {
					d, err := transport.pollApproval(ctx, session, id)
					if err != nil {
						t.Errorf("real card answer: %v", err)
						break
					}
					if d.Status == "PENDING" {
						continue
					}
					decisionMu.Lock()
					decision = d
					decisionMu.Unlock()
					t.Logf("REAL_OWNER_DECISION id=%s status=%s decidedById=%s", id, d.Status, d.DecidedByID)
					return
				}
			}()
			return nil
		},
		approve: func(card cursorTestCard) cursorTestDecision {
			if firstString(mapValue(card.Input), "command") != approved {
				return cursorTestDecision{Status: "DENIED"}
			}
			decisionMu.Lock()
			defer decisionMu.Unlock()
			if decision == nil {
				return cursorTestDecision{Status: "PENDING"}
			}
			return cursorTestDecision{Status: decision.Status, DecidedByID: decision.DecidedByID, Message: decision.Message}
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
		t.Log("CASE_B cleanup: removed")
	}
}
