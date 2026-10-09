//go:build linux

package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// addAntigravityAccount adds a slot the way "+ Account" does, with a Google sign-in saved in it when
// token is not nil.
func addAntigravityAccount(t *testing.T, name string, token []byte) accountSlot {
	t.Helper()
	slot, err := antigravityAccountKind.create(name)
	if err != nil {
		t.Fatal(err)
	}
	if token != nil {
		if err := os.MkdirAll(filepath.Join(slot.Dir, "antigravity-cli"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(antigravityTokenFile(slot.Dir), token, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return slot
}

func TestAntigravityAccountCommandRunsInTheAccountsDirectory(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	work := addAntigravityAccount(t, "Work", nil)
	env := []string{"PATH=/usr/bin:/bin", antigravityAccountDirVar + "=" + work.Dir}
	cmd, cleanup, err := antigravityGoogleCommand(context.Background(), "/fake/agy", env, false, "models")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	if got := cmd.Args; len(got) != 4 || got[1] != "--gemini_dir="+work.Dir {
		t.Fatalf("an account's command must run in that account's directory: %v", got)
	}
	if envValue(cmd.Env, antigravityAccountDirVar) != "" {
		t.Fatal("agy must not see which account it runs on")
	}
	if _, err := os.Stat(filepath.Join(antigravityGoogleDir(), "antigravity-cli")); err == nil {
		t.Fatal("an account's command wrote into Default's directory")
	}
}

func TestAntigravityAccountHealthReportsEachAccountsQuota(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv("GEMINI_API_KEY", "")
	bin := replayGoogleProbe(t, loadGoogleProbeRecording(t, "google-auth-print-usage.json"))
	saveGoogleSignIn(t)
	work := addAntigravityAccount(t, "Work", googleSignInPlaceholder(t))
	spare := addAntigravityAccount(t, "Spare", nil)
	reports := probeEngines([]engineSpec{{name: "Antigravity", bin: providerAntigravity, exe: "agy"}}, filepath.Dir(bin))
	if len(reports) != 1 {
		t.Fatalf("reports = %+v", reports)
	}
	r := reports[0]
	if r.Auth != "yes" || r.AuthSource != "google" {
		t.Fatalf("engine = %s %q", r.Auth, r.AuthSource)
	}
	want := map[string]string{accountSlotDefaultID: "yes", work.ID: "yes", spare.ID: "no"}
	if len(r.Accounts) != 3 {
		t.Fatalf("accounts = %+v", r.Accounts)
	}
	for _, account := range r.Accounts {
		if account.Auth != want[account.ID] {
			t.Fatalf("account %s auth = %s, want %s", account.ID, account.Auth, want[account.ID])
		}
		if account.CodexHome != "" {
			t.Fatalf("an Antigravity account carries Codex's field: %+v", account)
		}
	}
	if r.Accounts[1].Name != "Work" || r.Accounts[1].Dir != work.Dir {
		t.Fatalf("added account = %+v", r.Accounts[1])
	}
	if r.PlanUsage == nil || len(r.PlanUsage.Buckets) != 4 {
		t.Fatalf("Default's quota is the snapshot's own: %+v", r.PlanUsage)
	}
	if got := r.PlanUsage.Accounts[work.ID]; got == nil || len(got.Buckets) != 4 || got.Provider != providerAntigravity {
		t.Fatalf("Work's quota = %+v", got)
	}
	if _, ok := r.PlanUsage.Accounts[spare.ID]; ok {
		t.Fatal("a signed-out account reported quota")
	}
}

func TestAntigravityAccountsOnAKeyRunner(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv("GEMINI_API_KEY", "fake-key")
	bin := replayGoogleProbe(t, loadGoogleProbeRecording(t, "google-auth-print-usage.json"))
	work := addAntigravityAccount(t, "Work", googleSignInPlaceholder(t))
	reports := probeEngines([]engineSpec{{name: "Antigravity", bin: providerAntigravity, exe: "agy"}}, filepath.Dir(bin))
	r := reports[0]
	// The engine runs on the key; Default — the runner's Google sign-in — has none.
	if r.Auth != "yes" || r.AuthSource != "env_key" || len(r.Accounts) != 2 || r.Accounts[0].Auth != "no" || r.Accounts[1].Auth != "yes" {
		t.Fatalf("key runner = %+v", r)
	}
	if r.PlanUsage == nil || len(r.PlanUsage.Buckets) != 0 || r.PlanUsage.Accounts[work.ID] == nil {
		t.Fatalf("only Work has quota to report: %+v", r.PlanUsage)
	}
}

func TestAntigravitySessionRunsOnItsAccount(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv("GEMINI_API_KEY", "")
	saveGoogleSignIn(t)
	workToken := []byte(`{"placeholder":"work"}`)
	work := addAntigravityAccount(t, "Work", workToken)
	signedOut := addAntigravityAccount(t, "Spare", nil)
	def, _ := filepath.Abs(antigravityGoogleDir())

	if dir, err := antigravitySessionGoogleDir(nil); err != nil || dir != def {
		t.Fatalf("no account named = %q %v, want Default", dir, err)
	}
	if dir, err := antigravitySessionGoogleDir(map[string]string{antigravityAccountDirVar: work.Dir}); err != nil || dir != work.Dir {
		t.Fatalf("Work = %q %v", dir, err)
	}
	for _, elsewhere := range []string{t.TempDir(), filepath.Join(filepath.Dir(work.Dir), "0000000g"), filepath.Dir(work.Dir)} {
		if _, err := antigravitySessionGoogleDir(map[string]string{antigravityAccountDirVar: elsewhere}); err == nil {
			t.Fatalf("a directory that is no account of this runner was accepted: %s", elsewhere)
		}
	}

	job := &ClaimedSession{SessionID: "s1", Provider: providerAntigravity}
	job.Agent.Env = map[string]string{antigravityAccountDirVar: work.Dir}
	if got := antigravitySessionAuth(job); got != antigravityAuthGoogle {
		t.Fatalf("Work's session auth = %s", got)
	}
	scratch := t.TempDir()
	dir, err := prepareAntigravityGeminiDir(scratch, job, "orbit", true)
	if err != nil {
		t.Fatal(err)
	}
	if copied, err := os.ReadFile(antigravityTokenFile(dir)); err != nil || string(copied) != string(workToken) {
		t.Fatalf("the session's copy is not Work's sign-in: %q %v", copied, err)
	}
	if envValue(antigravityEnv(job, t.TempDir()), antigravityAccountDirVar) != "" {
		t.Fatal("agy must not see which account it runs on")
	}
	if msg := engineAuthPreflight(providerAntigravity, job.Agent.Env); msg != "" {
		t.Fatalf("a signed-in account was refused: %s", msg)
	}

	// An account with no sign-in runs on nothing — never on a key it was not picked for.
	job.Agent.Env = map[string]string{antigravityAccountDirVar: signedOut.Dir}
	t.Setenv("GEMINI_API_KEY", "fake-key")
	if got := antigravitySessionAuth(job); got != antigravityAuthNone {
		t.Fatalf("a signed-out account fell back to %s", got)
	}
	if msg := engineAuthPreflight(providerAntigravity, map[string]string{antigravityAccountDirVar: signedOut.Dir}); msg != antigravityAccountSignedOutMessage {
		t.Fatalf("preflight = %q", msg)
	}
	if msg := engineAuthPreflight(providerAntigravity, map[string]string{antigravityAccountDirVar: t.TempDir()}); !strings.HasPrefix(msg, "Failed to authenticate: this runner has no Antigravity account at ") {
		t.Fatalf("preflight for an unknown account = %q", msg)
	}

	// Default without a Google sign-in still runs on the runner's own key, as it always did.
	if err := os.Remove(antigravityGoogleTokenPath()); err != nil {
		t.Fatal(err)
	}
	job.Agent.Env = nil
	if got := antigravitySessionAuth(job); got != antigravityAuthEnvKey {
		t.Fatalf("Default on a key = %s", got)
	}
}

func TestAntigravityAccountRemovalWaitsForItsSessions(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	work := addAntigravityAccount(t, "Work", googleSignInPlaceholder(t))
	job := &ClaimedSession{SessionID: "0196e000-0000-7000-8000-00000000a001", Provider: providerAntigravity}
	job.Agent.Env = map[string]string{antigravityAccountDirVar: work.Dir}
	if err := os.MkdirAll(runDir(job.SessionID), 0o700); err != nil {
		t.Fatal(err)
	}
	writeSessionMeta(runDir(job.SessionID), job, t.TempDir())
	live := antigravityAccountKind.liveDirs([]string{job.SessionID})
	if !live[work.Dir] {
		t.Fatalf("a session on Work is not counted: %v", live)
	}
	if err := antigravityAccountKind.remove(work.ID, live); err == nil {
		t.Fatal("removed an account a running session is on")
	}
	// Moved back to Default between turns: the record follows, and the account can go.
	job.Agent.Env = nil
	writeSessionMeta(runDir(job.SessionID), job, t.TempDir())
	if live := antigravityAccountKind.liveDirs([]string{job.SessionID}); len(live) != 0 {
		t.Fatalf("a session back on Default still holds Work: %v", live)
	}
	if err := removeAccount(antigravityAccountKind, nil, nil, nil, work.ID, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(work.Dir); !os.IsNotExist(err) {
		t.Fatalf("Work's directory survived its removal: %v", err)
	}
}

func TestAntigravityGoogleLoginAddsAnAccount(t *testing.T) {
	h := newGoogleLoginHarness(t, "success")
	start := LoginCommand{Engine: providerAntigravity, Attempt: "google-add", AccountName: "Work"}
	h.relay.start(start, func(r LoginResultRequest) { h.reports <- r })
	res := h.wait(t, loginAwaitingCode)
	if res.Account == "" || res.Account == accountSlotDefaultID {
		t.Fatalf("the sign-in does not name the account it adds: %+v", res)
	}
	h.relay.submitCode(LoginCommand{Engine: providerAntigravity, Attempt: "google-add", Account: res.Account, Code: googleReplayCode},
		func(r LoginResultRequest) { h.reports <- r })
	h.wait(t, loginDone)
	h.relay.stop()
	slots, err := antigravityAccountKind.list()
	if err != nil || len(slots) != 2 || slots[1].ID != res.Account || slots[1].Name != "Work" {
		t.Fatalf("slots = %+v %v", slots, err)
	}
	if stat, err := os.Stat(antigravityTokenFile(slots[1].Dir)); err != nil || stat.Mode().Perm() != 0o600 {
		t.Fatal("the added account holds no private sign-in")
	}
	if _, err := os.Stat(antigravityGoogleTokenPath()); !os.IsNotExist(err) {
		t.Fatalf("adding an account signed Default in: %v", err)
	}
}

func TestAntigravityGoogleLoginTakesBackAnAccountNobodySignedIn(t *testing.T) {
	h := newGoogleLoginHarness(t, "hang")
	h.relay.timeout = 2 * time.Second
	h.relay.start(LoginCommand{Engine: providerAntigravity, Attempt: "google-add", AccountName: "Work"}, func(r LoginResultRequest) { h.reports <- r })
	res := h.wait(t, loginAwaitingCode)
	h.relay.submitCode(LoginCommand{Engine: providerAntigravity, Attempt: "google-add", Account: res.Account, Code: googleReplayCode},
		func(r LoginResultRequest) { h.reports <- r })
	h.wait(t, loginFailed)
	h.relay.stop()
	if slots, err := antigravityAccountKind.list(); err != nil || len(slots) != 1 {
		t.Fatalf("a failed sign-in left its account behind: %+v %v", slots, err)
	}
}

func TestAntigravityGoogleLoginCodeWithoutAnAccountFindsItsAttempt(t *testing.T) {
	h := newGoogleLoginHarness(t, "success")
	h.relay.start(LoginCommand{Engine: providerAntigravity, Attempt: "google-add", AccountName: "Work"}, func(r LoginResultRequest) { h.reports <- r })
	res := h.wait(t, loginAwaitingCode)
	// A control plane that names no account with the code still reaches the sign-in for its attempt.
	h.relay.submitCode(LoginCommand{Engine: providerAntigravity, Attempt: "google-add", Code: googleReplayCode},
		func(r LoginResultRequest) { h.reports <- r })
	h.wait(t, loginDone)
	h.relay.stop()
	if _, err := os.Stat(filepath.Join(filepath.Dir(antigravityGoogleDir()), "..", "antigravity-accounts", res.Account)); err != nil {
		t.Fatalf("the account the code belonged to is gone: %v", err)
	}
}
