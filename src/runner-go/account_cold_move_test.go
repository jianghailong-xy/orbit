package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A removal whose sessions were moved off the account, and which have no engine running, carries each
// one's conversation to the account it was moved to and then removes the account (2026-11-17: 16 Codex
// sessions parked since early October kept their account from being removed, their reloads waiting for
// a claim that never came).

func coldMoveTestHomes(t *testing.T) {
	t.Helper()
	claudeAccountSlotTestHomes(t)
	t.Setenv("CODEX_HOME", "")
}

// writeCodexThread puts a thread's rollout under home, as Codex keeps one.
func writeCodexThread(t *testing.T, home, thread string) (string, []byte) {
	t.Helper()
	rel := filepath.Join("sessions", "2026", "10", "04", "rollout-2026-10-04T03-11-00-"+thread+".jsonl")
	body := []byte(`{"type":"session_meta","payload":{"id":"` + thread + `"}}` + "\n")
	if err := os.MkdirAll(filepath.Dir(filepath.Join(home, rel)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, rel), body, 0o600); err != nil {
		t.Fatal(err)
	}
	return rel, body
}

// codexSessionOn records a Codex session that ran on account home, with thread.
func codexSessionOn(t *testing.T, id, thread, home string) {
	t.Helper()
	scratch := runDir(id)
	if err := os.MkdirAll(scratch, 0o755); err != nil {
		t.Fatal(err)
	}
	job := &ClaimedSession{SessionID: id, SessionUUID: id, Provider: providerCodex, RuntimeSessionID: thread}
	writeSessionMetaWithCodexState(scratch, job, t.TempDir(), codexStateLayoutShared, codexStatePartition(home), home)
}

func always(string) bool { return true }

func TestACodexSessionWithNoEngineIsCarriedOffAnAccountBeingRemoved(t *testing.T) {
	coldMoveTestHomes(t)
	leaving, err := codexAccountKind.create("Leaving")
	if err != nil {
		t.Fatal(err)
	}
	staying, err := codexAccountKind.create("Staying")
	if err != nil {
		t.Fatal(err)
	}
	const id = "01a10476-c8ed-7115-8e07-1ebd8a57c836"
	const thread = "01a0f000-0000-7000-8000-000000000001"
	rel, body := writeCodexThread(t, leaving.Dir, thread)
	codexSessionOn(t, id, thread, leaving.Dir)

	live := codexSessionAccountHomes([]string{id})
	if err := codexAccountKind.remove(leaving.ID, live); err == nil {
		t.Fatal("the account was removed with the session's thread in it")
	}
	dir, carried := carryColdSessionsOff(codexAccountKind, leaving.ID, []AccountRemoveMove{{SessionID: id, Account: staying.ID}}, live, always)
	if dir != filepath.Clean(leaving.Dir) || len(carried) != 1 || carried[0] != id {
		t.Fatalf("carried %v off %s, want the session off %s", carried, dir, leaving.Dir)
	}
	if got, err := os.ReadFile(filepath.Join(staying.Dir, rel)); err != nil || string(got) != string(body) {
		t.Fatalf("the thread in the account it moved to: %q, %v", got, err)
	}
	meta := readSessionMeta(filepath.Join(runDir(id), "meta.json"))
	if meta == nil || meta.CodexStateHome != staying.Dir || meta.CodexStatePartition != codexStatePartition(staying.Dir) ||
		meta.RuntimeSessionID != thread {
		t.Fatalf("the session's record: %+v", meta)
	}
	if err := codexAccountKind.remove(leaving.ID, codexSessionAccountHomes([]string{id})); err != nil {
		t.Fatalf("removing the account it left: %v", err)
	}
	if _, err := os.Stat(filepath.Join(staying.Dir, rel)); err != nil {
		t.Fatalf("removing the old account took the thread: %v", err)
	}
}

// Onto Default as well: the record names the runner's own CODEX_HOME, as a session started there has.
func TestACodexSessionWithNoEngineIsCarriedToDefault(t *testing.T) {
	coldMoveTestHomes(t)
	leaving, err := codexAccountKind.create("Leaving")
	if err != nil {
		t.Fatal(err)
	}
	def, err := codexAccountKind.home(accountSlotDefaultID)
	if err != nil {
		t.Fatal(err)
	}
	const id = "01a0eccc-6164-72e9-a236-7db07d8053ca"
	const thread = "01a0f000-0000-7000-8000-000000000002"
	rel, _ := writeCodexThread(t, leaving.Dir, thread)
	codexSessionOn(t, id, thread, leaving.Dir)

	_, carried := carryColdSessionsOff(codexAccountKind, leaving.ID, []AccountRemoveMove{{SessionID: id, Account: "default"}},
		codexSessionAccountHomes([]string{id}), always)
	if len(carried) != 1 {
		t.Fatalf("carried %v", carried)
	}
	if _, err := os.Stat(filepath.Join(def, rel)); err != nil {
		t.Fatalf("the thread on Default: %v", err)
	}
	if meta := readSessionMeta(filepath.Join(runDir(id), "meta.json")); meta == nil || meta.CodexStateHome != filepath.Clean(def) {
		t.Fatalf("the session's record: %+v", meta)
	}
}

// A session with an engine running is left to its reload; one moved to an account this runner does not
// have, and one the removal does not name, stay where they are — and so does the account.
func TestOnlyANamedSessionWithNoEngineIsCarriedOntoAnAccountThatIsHere(t *testing.T) {
	coldMoveTestHomes(t)
	leaving, err := codexAccountKind.create("Leaving")
	if err != nil {
		t.Fatal(err)
	}
	staying, err := codexAccountKind.create("Staying")
	if err != nil {
		t.Fatal(err)
	}
	const running, elsewhere, unnamed = "01a10001-0000-7000-8000-000000000001", "01a10001-0000-7000-8000-000000000002", "01a10001-0000-7000-8000-000000000003"
	for i, id := range []string{running, elsewhere, unnamed} {
		thread := "01a0f000-0000-7000-8000-00000000001" + string(rune('0'+i))
		writeCodexThread(t, leaving.Dir, thread)
		codexSessionOn(t, id, thread, leaving.Dir)
	}
	ids := []string{running, elsewhere, unnamed}
	live := codexSessionAccountHomes(ids)
	moves := []AccountRemoveMove{{SessionID: running, Account: staying.ID}, {SessionID: elsewhere, Account: "c0ffee42"}}
	_, carried := carryColdSessionsOff(codexAccountKind, leaving.ID, moves, live, func(id string) bool { return id != running })
	if len(carried) != 0 {
		t.Fatalf("carried %v", carried)
	}
	if got := codexSessionAccountHomes(ids)[filepath.Clean(leaving.Dir)]; len(got) != 3 {
		t.Fatalf("sessions still on the account: %v, want all three", got)
	}
	if err := codexAccountKind.remove(leaving.ID, codexSessionAccountHomes(ids)); err == nil {
		t.Fatal("the account was removed with sessions still in it")
	}
}

func TestAClaudeSessionWithNoEngineIsCarriedOffAnAccountBeingRemoved(t *testing.T) {
	claudeAccountSlotTestHomes(t)
	work, err := claudeAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	personal, err := claudeAccountKind.create("Personal")
	if err != nil {
		t.Fatal(err)
	}
	execDir := t.TempDir()
	const id = "9c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f"
	scratch := runDir(id)
	if err := os.MkdirAll(scratch, 0o755); err != nil {
		t.Fatal(err)
	}
	fromWork, _ := claudeTranscriptPathIn(work.Dir, execDir, id)
	if err := os.MkdirAll(filepath.Dir(fromWork), 0o755); err != nil {
		t.Fatal(err)
	}
	said := claudeTurns(t, time.Now().Add(-time.Hour), "hello", "from Work")
	if err := os.WriteFile(fromWork, said, 0o600); err != nil {
		t.Fatal(err)
	}
	job := &ClaimedSession{SessionID: id, SessionUUID: id, Provider: providerClaude,
		Agent: AgentExecConfig{Provider: providerClaude, Env: map[string]string{"CLAUDE_CONFIG_DIR": work.Dir}}}
	writeClaudeSessionMeta(scratch, job, execDir)

	_, carried := carryColdSessionsOff(claudeAccountKind, work.ID, []AccountRemoveMove{{SessionID: id, Account: personal.ID}},
		claudeSessionAccountDirs([]string{id}), always)
	if len(carried) != 1 {
		t.Fatalf("carried %v", carried)
	}
	dst, _ := claudeTranscriptPathIn(personal.Dir, execDir, id)
	if got, err := os.ReadFile(dst); err != nil || string(got) != string(said) {
		t.Fatalf("the conversation on the account it moved to: %q, %v", got, err)
	}
	if meta := readSessionMeta(filepath.Join(scratch, "meta.json")); meta == nil || meta.ClaudeConfigDir != personal.Dir {
		t.Fatalf("the session's record: %+v", meta)
	}
	if err := claudeAccountKind.remove(work.ID, claudeSessionAccountDirs([]string{id})); err != nil {
		t.Fatalf("removing the account it left: %v", err)
	}
	if _, err := os.Stat(dst); err != nil {
		t.Fatalf("removing the old account took the conversation: %v", err)
	}
	if _, err := os.Stat(fromWork); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the old account is still there: %v", err)
	}
}

// The pool's word on whether a session has an engine: none starting or running, no permit, no takeover.
func TestAPoolSessionIsColdOnlyWithNoEngineNoPermitAndNoTakeover(t *testing.T) {
	p := newSessionPool(2)
	p.sessions["cold"] = &liveSession{id: "cold"}
	p.sessions["resident"] = &liveSession{id: "resident", resident: true}
	p.sessions["active"] = &liveSession{id: "active", active: true}
	p.sessions["detaching"] = &liveSession{id: "detaching", detaching: true}
	p.sessions["reclaiming"] = &liveSession{id: "reclaiming"}
	p.reclaiming["reclaiming"] = true
	for id, want := range map[string]bool{"cold": true, "resident": false, "active": false, "detaching": false, "reclaiming": false, "absent": false} {
		if got := p.isCold(id); got != want {
			t.Errorf("isCold(%q) = %v, want %v", id, got, want)
		}
	}
}
