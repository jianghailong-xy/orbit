package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// An idle Codex session switched to another account is left cold by its reload, with no app-server to
// start and carry its thread: the switch carries it, and the account it left is no longer the session's
// (2026-11-16).
func TestAnIdleCodexSessionSwitchedAwayReleasesItsAccount(t *testing.T) {
	m := newCodexAccountDispatchMachine(t)
	m.signIn(t, m.work.Dir)
	other, err := codexAccountKind.create("Other")
	if err != nil {
		t.Fatal(err)
	}
	m.signIn(t, other.Dir)
	const sessionID = "5e6f7a8b-9c0d-4ebf-9012-4c5d6e7f8091"
	const thread = "01a0eae2-75e2-77d0-b2fa-014b49b28711"
	scratch, execDir := runDir(sessionID), t.TempDir()
	if err := os.MkdirAll(scratch, 0o755); err != nil {
		t.Fatal(err)
	}
	job := &ClaimedSession{SessionID: sessionID, SessionUUID: sessionID, Provider: providerCodex, RuntimeSessionID: thread,
		Agent: AgentExecConfig{Provider: providerCodex, Env: map[string]string{"CODEX_HOME": m.work.Dir}}}
	writeSessionMetaWithCodexState(scratch, job, execDir, codexStateLayoutShared, codexStatePartition(m.work.Dir), m.work.Dir)
	rel := filepath.Join("sessions", "2026", "11", "16", "rollout-2026-11-16T03-00-00-"+thread+".jsonl")
	rollout := []byte(`{"type":"session_meta","payload":{"id":"` + thread + `"}}` + "\n")
	if err := os.MkdirAll(filepath.Dir(filepath.Join(m.work.Dir, rel)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(m.work.Dir, rel), rollout, 0o600); err != nil {
		t.Fatal(err)
	}
	if got := codexSessionAccountHomes([]string{sessionID}); len(got[m.work.Dir]) != 1 {
		t.Fatalf("before the switch the session is not on Work: %v", got)
	}

	job.Agent.Env = map[string]string{"CODEX_HOME": other.Dir} // the reload's environment
	moveIdleSessionToItsAccount(job, execDir, scratch)

	if got, err := os.ReadFile(filepath.Join(other.Dir, rel)); err != nil || string(got) != string(rollout) {
		t.Fatalf("the thread on the account it moved to: %q, %v", got, err)
	}
	live := codexSessionAccountHomes([]string{sessionID})
	if len(live[m.work.Dir]) != 0 || len(live[other.Dir]) != 1 {
		t.Fatalf("after the switch the session is on %v, want Other only", live)
	}
}

// The same for Kimi: its conversation is carried to the account it was switched to, and the record
// follows it, so the account it left is free.
func TestAnIdleKimiSessionSwitchedAwayReleasesItsAccount(t *testing.T) {
	kimiAccountTestHomes(t)
	work, err := kimiAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	other, err := kimiAccountKind.create("Other")
	if err != nil {
		t.Fatal(err)
	}
	const sessionID = "6f7a8b9c-0d1e-4fc0-9123-5d6e7f809102"
	scratch, execDir := runDir(sessionID), t.TempDir()
	if err := os.MkdirAll(scratch, 0o755); err != nil {
		t.Fatal(err)
	}
	putKimiSession(t, work.Dir, kimiTestWorkDir, kimiTestSessionID, time.Now().Add(-time.Hour),
		kimiTestTurn{"rename the widget", "renamed it"})
	job := &ClaimedSession{SessionID: sessionID, SessionUUID: sessionID, Provider: providerKimi, RuntimeSessionID: kimiTestSessionID,
		Agent: AgentExecConfig{Provider: providerKimi, Env: map[string]string{"KIMI_CODE_HOME": work.Dir}}}
	writeKimiSessionMeta(scratch, job, execDir) // it ran on Work
	if got := kimiSessionAccountHomes([]string{sessionID}); len(got[work.Dir]) != 1 {
		t.Fatalf("before the switch the session is not on Work: %v", got)
	}

	job.Agent.Env = map[string]string{"KIMI_CODE_HOME": other.Dir}
	moveIdleSessionToItsAccount(job, execDir, scratch)

	if kimiSessionDirIn(other.Dir, kimiTestSessionID) == "" {
		t.Fatal("the conversation was not carried to the account it moved to")
	}
	live := kimiSessionAccountHomes([]string{sessionID})
	if len(live[work.Dir]) != 0 || len(live[other.Dir]) != 1 {
		t.Fatalf("after the switch the session is on %v, want Other only", live)
	}
}
