package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Removing a Codex account from this machine: the slot's directory and its record go, and so does
// the probe that reads it. Default never does — it is the CODEX_HOME the runner's own environment
// selects, the one a terminal's `codex` shares — and neither does a slot a live session is stuck
// to, whose thread lives in that directory.

// codexRemoveSlotHome is the slot's CODEX_HOME, or "" once it is gone.
func codexRemoveSlotHome(t *testing.T, id string) string {
	t.Helper()
	home, err := codexAccountSlotHome(id)
	if err != nil {
		return ""
	}
	return home
}

// assertSlotGone holds that the slot is not on this machine at all: no directory, no record, and no
// entry in what the runner lists — so the heartbeat stops reporting the account with it.
func assertSlotGone(t *testing.T, id string) {
	t.Helper()
	if home := codexRemoveSlotHome(t, id); home != "" {
		t.Fatalf("slot %s still resolves to %s", id, home)
	}
	slots, err := listCodexAccountSlots()
	if err != nil {
		t.Fatal(err)
	}
	for _, slot := range slots {
		if slot.ID == id {
			t.Fatalf("slot %s is still listed: %+v", id, slots)
		}
	}
	for _, path := range []string{filepath.Join(machineHome(), "codex-accounts", id), codexAccountSlotMetaPath(filepath.Join(machineHome(), "codex-accounts"), id)} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatalf("%s is still on disk (err %v)", path, err)
		}
	}
}

// addedSlotIDs is every account this machine added, in the order the runner lists them.
func addedSlotIDs(t *testing.T) []string {
	t.Helper()
	slots, err := listCodexAccountSlots()
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, slot := range slots {
		if slot.ID != codexAccountDefaultSlot {
			ids = append(ids, slot.ID)
		}
	}
	return ids
}

func TestCodexAccountSlotRemoveDeletesTheSlotAndStopsItsProbe(t *testing.T) {
	home, _ := codexAccountSlotTestHomes(t)
	// Default is signed in, and it is the account a removal must never touch.
	defaultHome := filepath.Join(home, ".codex")
	signInCodexHome(t, defaultHome)
	sentinel := filepath.Join(defaultHome, "auth.json")
	before, err := os.ReadFile(sentinel)
	if err != nil {
		t.Fatal(err)
	}
	work, err := createCodexAccountSlot("Work")
	if err != nil {
		t.Fatal(err)
	}
	// A slot Codex has been in: whatever the CLI keeps in its CODEX_HOME, credentials included.
	signInCodexHome(t, work.CodexHome)
	if err := os.MkdirAll(filepath.Join(work.CodexHome, "sessions"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(work.CodexHome, "sessions", "thread.jsonl"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	// The runner's probes: one loop per listed slot, started the way run() starts them.
	usage := newCodexAccountUsage(codexResetTestLeaseOwner)
	loops := map[*planUsageProbe]context.Context{}
	usage.syncSlots(context.Background(), func(ctx context.Context, probe *planUsageProbe) {
		loops[probe] = ctx
	})
	workProbe := usage.slots[work.ID].probe
	if loops[workProbe] == nil {
		t.Fatal("the slot's usage probe was never started")
	}

	if err := removeCodexAccount(usage, work.ID, nil); err != nil {
		t.Fatal(err)
	}
	assertSlotGone(t, work.ID)
	// The probe stopped with the directory: its loop is cancelled and the runner keeps nothing
	// about the account, so the next heartbeat's account list does not name it.
	if loops[workProbe].Err() == nil {
		t.Fatal("the slot's usage probe still runs after the account is gone")
	}
	if _, ok := usage.slots[work.ID]; ok {
		t.Fatal("the runner still keeps the removed account's usage probe")
	}
	if slots, err := listCodexAccountSlots(); err != nil || len(slots) != 1 || slots[0].ID != codexAccountDefaultSlot {
		t.Fatalf("slots = %+v (%v), want Default alone", slots, err)
	}
	// Default is untouched: removing another account is not about Default's CODEX_HOME at all.
	if now, err := os.ReadFile(sentinel); err != nil || string(now) != string(before) {
		t.Fatalf("Default's credentials are %s (%v)", now, err)
	}

	// Removing it again is the state that was asked for, not an error: the request is redelivered
	// until the runner reports, so the same removal can arrive twice.
	if err := removeCodexAccount(usage, work.ID, nil); err != nil {
		t.Fatalf("removing an account that is already gone: %v", err)
	}
}

func TestCodexAccountSlotRemoveRefusesDefault(t *testing.T) {
	home, _ := codexAccountSlotTestHomes(t)
	defaultHome := filepath.Join(home, ".codex")
	signInCodexHome(t, defaultHome)
	sentinel := filepath.Join(defaultHome, "auth.json")
	before, err := os.ReadFile(sentinel)
	if err != nil {
		t.Fatal(err)
	}

	usage := newCodexAccountUsage(codexResetTestLeaseOwner)
	err = removeCodexAccount(usage, codexAccountDefaultSlot, nil)
	if err == nil || !strings.Contains(err.Error(), "cannot be removed") {
		t.Fatalf("removing Default = %v, want a refusal naming it", err)
	}
	if now, err := os.ReadFile(sentinel); err != nil || string(now) != string(before) {
		t.Fatalf("Default's credentials are %s (%v)", now, err)
	}
	if got := codexRemoveSlotHome(t, codexAccountDefaultSlot); got != defaultHome {
		t.Fatalf("Default resolves to %q, want %q", got, defaultHome)
	}
}

func TestCodexAccountSlotRemoveRefusesASlotALiveSessionIsIn(t *testing.T) {
	_, orbitHome := codexAccountSlotTestHomes(t)
	work, err := createCodexAccountSlot("Work")
	if err != nil {
		t.Fatal(err)
	}
	signInCodexHome(t, work.CodexHome)
	// A session this runner is running, stuck to the slot: its meta records the CODEX_HOME its
	// state was first opened under, which is the slot's own (codexSessionAccountEnv).
	const sessionID = "019fc086-c7c7-7c92-8215-778ad8a6280a"
	writeSessionInCodexHome(t, orbitHome, sessionID, work.CodexHome)
	liveHomes := codexSessionAccountHomes([]string{sessionID})
	if !liveHomes[work.CodexHome] {
		t.Fatalf("the live session's CODEX_HOME is not %q: %+v", work.CodexHome, liveHomes)
	}

	usage := newCodexAccountUsage(codexResetTestLeaseOwner)
	loops := map[*planUsageProbe]context.Context{}
	usage.syncSlots(context.Background(), func(ctx context.Context, probe *planUsageProbe) {
		loops[probe] = ctx
	})
	workProbe := usage.slots[work.ID].probe

	err = removeCodexAccount(usage, work.ID, liveHomes)
	if err == nil || !strings.Contains(err.Error(), "in use by a session") {
		t.Fatalf("removing a slot a live session is in = %v, want a refusal naming the session", err)
	}
	// Refused, not half-done: the account and its credentials are exactly where they were.
	if home := codexRemoveSlotHome(t, work.ID); home != work.CodexHome {
		t.Fatalf("slot %s resolves to %q, want %q", work.ID, home, work.CodexHome)
	}
	if _, err := os.Stat(filepath.Join(work.CodexHome, "auth.json")); err != nil {
		t.Fatalf("the refused removal took the account's credentials: %v", err)
	}
	if loops[workProbe].Err() != nil {
		t.Fatal("a refused removal stopped the account's usage probe")
	}

	// The session ends: the same removal now goes through, because what refused it is gone.
	if err := os.RemoveAll(runDir(sessionID)); err != nil {
		t.Fatal(err)
	}
	if err := removeCodexAccount(usage, work.ID, codexSessionAccountHomes([]string{sessionID})); err != nil {
		t.Fatal(err)
	}
	assertSlotGone(t, work.ID)
}

// fakeCodexThatCannotSignIn is codex failing its own sign-in: it prints the device page — so the
// attempt reaches the relay as a real one the user could have been watching — and then exits
// non-zero, which is what a CLI that cannot reach the provider does. `login status` stays signed
// out, exactly as it is in a CODEX_HOME nothing has signed into.
const fakeCodexThatCannotSignIn = `home=${CODEX_HOME:-$HOME/.codex}
printf '%s\t%s\t%s\n' "$*" "$home" "$CODEX_HOME" >> "$FAKE_CODEX_SEEN"
case "$*" in
"login --help") echo "      --device-auth  Sign in with a device code" ;;
"login --device-auth")
	printf '1. Open this link in your browser and sign in to your account\n   https://auth.openai.com/codex/device\n\n'
	printf '2. Enter this one-time code (expires in 15 minutes)\n   ABCD-EFGH\n\n'
	exit 1
	;;
"login status") exit 1 ;;
*) exit 2 ;;
esac`

// hangUpOnFakeCodexSignIn kills the sign-in where it stands, the way the relay's timeout does and
// the way a user who gives up mid-flow gets there: the CLI dies without having signed anything in.
// The relay's teardown — the reclaim included — has finished when this returns.
func hangUpOnFakeCodexSignIn(t *testing.T, h *codexLoginHarness, account string) {
	t.Helper()
	key := loginAccountKey(providerCodex, account)
	h.relay.mu.Lock()
	run := h.relay.runs[key]
	h.relay.mu.Unlock()
	if run == nil {
		t.Fatalf("no sign-in running for %q", key)
	}
	run.cancel()
	h.relay.wg.Wait()
}

// waitSlotGone waits for a slot to leave this machine, up to a deadline. The reclaim runs in the
// sign-in's own teardown, after the report a test has already waited for.
func waitSlotGone(t *testing.T, id string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		if codexRemoveSlotHome(t, id) == "" {
			assertSlotGone(t, id)
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("slot %s is still on the machine", id)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// "+ Account" that fails, is given up on, or times out leaves nothing behind: the slot the attempt
// created goes with it, so trying again does not accumulate empty accounts of the same name.
func TestCodexAccountSlotRemoveTakesBackTheEmptySlotAnAddAccountAttemptLeftBehind(t *testing.T) {
	h := newCodexLoginHarness(t)

	h.start(LoginCommand{Attempt: "attempt-1", AccountName: "Work"})
	first := h.waitReport(t, "attempt-1", loginAwaitingApproval).Account
	// The account is on the machine while the user is still deciding: that is the slot this test
	// is about, and it is what the page is showing them.
	if codexRemoveSlotHome(t, first) == "" {
		t.Fatalf("the added slot %q is not on the machine while its sign-in waits", first)
	}
	hangUpOnFakeCodexSignIn(t, h, first)
	if failed := h.waitReport(t, "attempt-1", loginFailed); failed.Account != first {
		t.Fatalf("the failure names account %q, want %q", failed.Account, first)
	}
	assertSlotGone(t, first)

	// Trying again is one account, not two: the empty one from before is gone, and the second
	// attempt's own slot is the only one the machine holds.
	h.start(LoginCommand{Attempt: "attempt-2", AccountName: "Work"})
	second := h.waitReport(t, "attempt-2", loginAwaitingApproval).Account
	if second == "" || second == first {
		t.Fatalf("the second attempt reported account %q, want a new slot (the first was %q)", second, first)
	}
	if got := addedSlotIDs(t); len(got) != 1 || got[0] != second {
		t.Fatalf("accounts on the machine = %v, want the second attempt's %q alone", got, second)
	}
	hangUpOnFakeCodexSignIn(t, h, second)
	h.waitReport(t, "attempt-2", loginFailed)
	if got := addedSlotIDs(t); len(got) != 0 {
		t.Fatalf("accounts left behind = %v, want none", got)
	}

	// A redelivery of the start that just ended adds nothing either. The server redelivers it every
	// heartbeat until this runner's report lands, so the attempt is still being asked for after it
	// is over: the account is not added again, no sign-in is begun, and the card is told why.
	h.start(LoginCommand{Attempt: "attempt-2", AccountName: "Work"})
	h.start(LoginCommand{Attempt: "attempt-2", AccountName: "Work"})
	if got := addedSlotIDs(t); len(got) != 0 {
		t.Fatalf("a redelivered start added an account: %v", got)
	}
	h.relay.mu.Lock()
	running := len(h.relay.runs)
	h.relay.mu.Unlock()
	if running != 0 {
		t.Fatalf("a redelivered start began %d sign-in(s)", running)
	}
	h.mu.Lock()
	reports := append([]LoginResultRequest(nil), h.reports...)
	h.mu.Unlock()
	if last := reports[len(reports)-1]; last.Status != loginFailed || last.Attempt != "attempt-2" ||
		!strings.Contains(last.Message, "did not complete") {
		t.Fatalf("the redelivery was answered with %+v, want the failure of attempt-2", last)
	}
}

// A sign-in that fails outright is the same story: the slot the attempt added is reclaimed, and the
// machine keeps nothing of an account that never signed in.
func TestCodexAccountSlotRemoveTakesBackTheSlotOfASignInThatFailed(t *testing.T) {
	h := newCodexLoginHarness(t)
	writeFakeBin(t, filepath.Dir(lookLoginEnginePath(t)), providerCodex, fakeCodexThatCannotSignIn)

	h.start(LoginCommand{Attempt: "attempt-1", AccountName: "Personal"})
	failed := h.waitReport(t, "attempt-1", loginFailed)
	if failed.Account == "" {
		t.Fatalf("the failed sign-in named no account: %+v", failed)
	}
	if h.calls(t) == nil {
		t.Fatal("codex never ran: the attempt did not reach the CLI")
	}
	h.relay.wg.Wait()
	assertSlotGone(t, failed.Account)

	// And again: no second empty account of the same name.
	h.start(LoginCommand{Attempt: "attempt-2", AccountName: "Personal"})
	second := h.waitReport(t, "attempt-2", loginFailed).Account
	h.relay.wg.Wait()
	if second == "" || second == failed.Account {
		t.Fatalf("the second attempt reported account %q, want a new slot (the first was %q)", second, failed.Account)
	}
	assertSlotGone(t, second)
	if got := addedSlotIDs(t); len(got) != 0 {
		t.Fatalf("accounts left behind = %v, want none", got)
	}
}

// Two attempts at once, for two different accounts: each one's slot is its own, so the first
// attempt ending without a sign-in takes ITS slot away even though the second is the one the relay
// is adding for now — which is the same accumulate-by-retrying case, just with the two overlapping.
func TestCodexAccountSlotRemoveTakesBackTheSlotOfAnEarlierAttemptStillRunning(t *testing.T) {
	h := newCodexLoginHarness(t)

	h.start(LoginCommand{Attempt: "attempt-1", AccountName: "Work"})
	first := h.waitReport(t, "attempt-1", loginAwaitingApproval).Account
	// The user gives up on the first, names another account, and starts again — the two sign-ins
	// run side by side, because they write different CODEX_HOMEs.
	h.start(LoginCommand{Attempt: "attempt-2", AccountName: "Personal"})
	second := h.waitReport(t, "attempt-2", loginAwaitingApproval).Account

	h.relay.mu.Lock()
	running := len(h.relay.runs)
	h.relay.mu.Unlock()
	if running != 2 {
		t.Fatalf("%d sign-in(s) running, want both attempts", running)
	}

	// The first CLI dies where it stood, having signed nothing in.
	h.relay.mu.Lock()
	run := h.relay.runs[loginAccountKey(providerCodex, first)]
	h.relay.mu.Unlock()
	if run == nil {
		t.Fatalf("no sign-in running for %q", first)
	}
	run.cancel()
	if failed := h.waitReport(t, "attempt-1", loginFailed); failed.Account != first {
		t.Fatalf("the failure names account %q, want %q", failed.Account, first)
	}
	waitSlotGone(t, first)
	if got := addedSlotIDs(t); len(got) != 1 || got[0] != second {
		t.Fatalf("accounts on the machine = %v, want the second attempt's %q alone", got, second)
	}

	// And the second one, still waiting for its user, is untouched by all of it.
	approveFakeCodexSignIn(t, codexRemoveSlotHome(t, second))
	if done := h.waitReport(t, "attempt-2", loginDone); done.Account != second {
		t.Fatalf("the outcome names account %q, want %q", done.Account, second)
	}
	h.relay.stop()
	assertSignedInto(t, codexRemoveSlotHome(t, second))
}

// A sign-in that cannot even start — this machine has no codex, or one too old for the device flow
// — adds the account first and then finds it cannot use it. The account goes back with the attempt:
// the failure is the answer, not a slot to clean up by hand.
func TestCodexAccountSlotRemoveTakesBackTheSlotOfASignInThatCouldNotStart(t *testing.T) {
	h := newCodexLoginHarness(t)
	// The binary the relay probes is not there: `start` says so rather than running anything.
	lookup := lookLoginEngine
	lookLoginEngine = func(string) (string, bool) { return "", false }
	t.Cleanup(func() { lookLoginEngine = lookup })

	h.start(LoginCommand{Attempt: "attempt-1", AccountName: "Work"})
	failed := h.waitReport(t, "attempt-1", loginFailed)
	if !strings.Contains(failed.Message, "too old to sign in from the browser") {
		t.Fatalf("the failure reads %q, want the machine's own reason", failed.Message)
	}
	assertSlotGone(t, failed.Account)
	if got := addedSlotIDs(t); len(got) != 0 {
		t.Fatalf("accounts left behind = %v, want none", got)
	}
	if h.calls(t) != nil {
		t.Fatal("codex ran although the relay has none to run")
	}
}

// A sign-in that DOES complete keeps its account: it is what the user asked for, and the reclaim is
// only ever about the slot an attempt left empty.
func TestCodexAccountSlotRemoveKeepsTheSlotOfASignInThatCompleted(t *testing.T) {
	h := newCodexLoginHarness(t)

	h.start(LoginCommand{Attempt: "attempt-1", AccountName: "Personal"})
	added := h.waitReport(t, "attempt-1", loginAwaitingApproval).Account
	approveFakeCodexSignIn(t, codexRemoveSlotHome(t, added))
	if done := h.waitReport(t, "attempt-1", loginDone); done.Account != added {
		t.Fatalf("the outcome names account %q, want %q", done.Account, added)
	}
	h.relay.stop()
	home := codexRemoveSlotHome(t, added)
	if home == "" {
		t.Fatal("a completed sign-in's account was reclaimed")
	}
	assertSignedInto(t, home)
	h.assertDefaultUntouched(t)
}

// The reclaim is the same removal the page asks for, so it refuses the same thing: a slot a live
// session is stuck to is left alone even when the sign-in that created it is given up on.
func TestCodexAccountSlotRemoveReclaimLeavesASlotALiveSessionIsIn(t *testing.T) {
	h := newCodexLoginHarness(t)
	const sessionID = "019fc086-c7c7-7c92-8215-778ad8a6280a"
	h.relay.liveSessionIDs = func() []string { return []string{sessionID} }

	h.start(LoginCommand{Attempt: "attempt-1", AccountName: "Work"})
	added := h.waitReport(t, "attempt-1", loginAwaitingApproval).Account
	// The session is on the slot the attempt just added: this directory is where its thread lives.
	writeSessionInCodexHome(t, machineHome(), sessionID, codexRemoveSlotHome(t, added))

	hangUpOnFakeCodexSignIn(t, h, added)
	if failed := h.waitReport(t, "attempt-1", loginFailed); failed.Account != added {
		t.Fatalf("the failure names account %q, want %q", failed.Account, added)
	}
	if codexRemoveSlotHome(t, added) == "" {
		t.Fatal("a slot a live session is in was reclaimed out from under it")
	}
}

// lookLoginEnginePath is the codex binary the relay probes and execs, which the sign-in harness
// installed a fake behind.
func lookLoginEnginePath(t *testing.T) string {
	t.Helper()
	path, ok := lookLoginEngine(providerCodex)
	if !ok {
		t.Fatal("the relay has no codex on this machine")
	}
	return path
}

// writeSessionInCodexHome records a session of this machine whose Codex state lives in codexHome,
// under orbitHome's runs directory: what makes the slot one a live session is in
// (codexSessionAccountHomes).
func writeSessionInCodexHome(t *testing.T, orbitHome, sessionID, codexHome string) {
	t.Helper()
	dir := filepath.Join(orbitHome, "runs", decodeSessionID(sessionID))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	meta, err := json.Marshal(sessionMeta{
		Provider: providerCodex, SessionUUID: sessionID,
		CodexStateLayout: codexStateLayoutShared, CodexStateHome: codexHome,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), meta, 0o600); err != nil {
		t.Fatal(err)
	}
}
