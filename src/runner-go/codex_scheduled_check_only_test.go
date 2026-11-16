package main

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
)

func scheduledCheckOnlyJob(mode string, flag bool) *ClaimedSession {
	job := &ClaimedSession{SessionID: "s1"}
	job.Agent.PermissionMode = mode
	job.Agent.ScheduledCheckOnly = flag
	return job
}

// A scheduled CHECK_ONLY run's Plan session starts its thread and every turn in Codex's read-only
// sandbox with approval policy never and no network for the shell (record §8).
func TestCodexScheduledCheckOnlyRunsInTheReadOnlySandbox(t *testing.T) {
	job := scheduledCheckOnlyJob("plan", true)
	thread := codexThreadParams(job, "/w", "/u")
	if thread["approvalPolicy"] != "never" || thread["sandbox"] != "read-only" {
		t.Errorf("thread/start = approvalPolicy %v, sandbox %v; want never, read-only", thread["approvalPolicy"], thread["sandbox"])
	}
	turn := codexTurnParams("t", job, "/w", "/u", "c", "p", nil, codexTurnContextOptions{})
	if turn["approvalPolicy"] != "never" {
		t.Errorf("turn/start approvalPolicy = %v, want never", turn["approvalPolicy"])
	}
	want := map[string]interface{}{"type": "readOnly", "networkAccess": false}
	if !reflect.DeepEqual(turn["sandboxPolicy"], want) {
		t.Errorf("turn/start sandboxPolicy = %v, want %v", turn["sandboxPolicy"], want)
	}
}

// Every other session is exactly as before: an ordinary Plan session (no flag, as from an
// ordinary claim or an older control plane) stays on untrusted with full access, so it asks about
// every command and Plan declines them, `ls` included; and the flag on any other mode changes
// nothing.
func TestCodexScheduledCheckOnlyLeavesEveryOtherSessionAlone(t *testing.T) {
	for _, mode := range []string{"plan", "default", "acceptEdits", "auto", "dontAsk", "bypassPermissions"} {
		base := scheduledCheckOnlyJob(mode, false)
		wantThread := codexThreadParams(base, "/w", "/u")
		wantTurn := codexTurnParams("t", base, "/w", "/u", "c", "p", nil, codexTurnContextOptions{})
		cases := []*ClaimedSession{base}
		if mode != "plan" {
			cases = append(cases, scheduledCheckOnlyJob(mode, true))
		}
		for _, job := range cases {
			if got := codexThreadParams(job, "/w", "/u"); !reflect.DeepEqual(got, wantThread) {
				t.Errorf("%s flag=%v: thread/start %v, want %v", mode, job.Agent.ScheduledCheckOnly, got, wantThread)
			}
			if got := codexTurnParams("t", job, "/w", "/u", "c", "p", nil, codexTurnContextOptions{}); !reflect.DeepEqual(got, wantTurn) {
				t.Errorf("%s flag=%v: turn/start %v, want %v", mode, job.Agent.ScheduledCheckOnly, got, wantTurn)
			}
		}
	}
	plan := scheduledCheckOnlyJob("plan", false)
	if p := codexThreadParams(plan, "/w", "/u"); p["approvalPolicy"] != "untrusted" || p["sandbox"] != "danger-full-access" {
		t.Errorf("ordinary plan thread/start = %v / %v, want untrusted / danger-full-access", p["approvalPolicy"], p["sandbox"])
	}
	ls := map[string]interface{}{
		"command":        "/bin/bash -lc ls",
		"commandActions": []interface{}{map[string]interface{}{"type": "listFiles", "command": "ls"}},
	}
	if bridgeCodexApproval(context.Background(), &Transport{}, plan, codexApprovalRequest{}, ls) {
		t.Error("ordinary plan: ls was accepted")
	}
	// A request that still reaches a scheduled run's bridge (none should, under never) is declined too.
	if bridgeCodexApproval(context.Background(), &Transport{}, scheduledCheckOnlyJob("plan", true), codexApprovalRequest{}, ls) {
		t.Error("scheduled CHECK_ONLY: an approval request was accepted")
	}
}

// The claim field's wire name is the apiserver's (AgentExecConfig.scheduledCheckOnly in
// @orbit/shared); absent decodes to false.
func TestAgentExecConfigScheduledCheckOnlyWire(t *testing.T) {
	var with, without ClaimedSession
	if err := json.Unmarshal([]byte(`{"sessionId":"s","agent":{"permissionMode":"plan","scheduledCheckOnly":true}}`), &with); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(`{"sessionId":"s","agent":{"permissionMode":"plan"}}`), &without); err != nil {
		t.Fatal(err)
	}
	if !with.Agent.ScheduledCheckOnly || without.Agent.ScheduledCheckOnly {
		t.Errorf("scheduledCheckOnly decoded as %v / %v, want true / false", with.Agent.ScheduledCheckOnly, without.Agent.ScheduledCheckOnly)
	}
}
