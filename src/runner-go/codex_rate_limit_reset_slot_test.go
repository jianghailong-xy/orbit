package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Contract v2 on the runner (docs/codex-rate-limit-reset-contract.md §12): every added Codex account slot is
// read in its own CODEX_HOME, and its reset block reaches the heartbeat under that slot's Accounts entry; a
// command naming a slot reads, consumes and refreshes in that slot's CODEX_HOME and nowhere else; a read naming
// another account calls nothing; and a slot that is gone is refused without a read. Every account here is a
// fake app-server's, one per CODEX_HOME. Nothing reaches a real Codex account or spends a real credit.

const (
	codexResetTestWorkAccount = "acct_fixture_work"
	codexResetTestSideAccount = "acct_fixture_side"
)

// codexResetSignedInAs is codexResetSignedIn on the ChatGPT account accountID.
func codexResetSignedInAs(accountID string, count int64, resettable bool) codexResetProviderState {
	state := codexResetSignedIn(count, resettable)
	state.AccountID = &accountID
	return state
}

// slot adds a Codex account slot named name to the harness machine, signed in to provider: the fake serves
// that account to every app-server started in the slot's CODEX_HOME, and to no other. The slot's shared state
// partition is bootstrapped here, so the app-server that does it is not one a test counts.
func (h *codexResetHarness) slot(name string, provider codexResetProviderState) accountSlot {
	h.t.Helper()
	slot, err := codexAccountKind.create(name)
	if err != nil {
		h.t.Fatal(err)
	}
	dir := filepath.Join(slot.Dir, codexResetSlotProviderDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		h.t.Fatal(err)
	}
	state, err := json.Marshal(provider)
	if err != nil {
		h.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, codexResetProviderFile), state, 0o644); err != nil {
		h.t.Fatal(err)
	}
	env := envWithValue(os.Environ(), "CODEX_HOME", slot.Dir)
	cwd, _ := os.Getwd()
	selection, err := codexPlanUsageStateForEnv(env, cwd)
	if err != nil {
		h.t.Fatal(err)
	}
	if err := ensureSharedCodexStateReady(context.Background(), context.Background(), selection, env); err != nil {
		h.t.Fatalf("shared codex state bootstrap for %s: %v", name, err)
	}
	return slot
}

// slotProvider is the state of slot's own account.
func (h *codexResetHarness) slotProvider(slot accountSlot) codexResetProviderState {
	h.t.Helper()
	var snapshot codexResetProviderState
	if err := codexResetUpdateProvider(filepath.Join(slot.Dir, codexResetSlotProviderDir), func(state *codexResetProviderState) {
		snapshot = *state
	}); err != nil {
		h.t.Fatal(err)
	}
	return snapshot
}

// bindToSlot makes the harness operation one for slot, bound to the account accountID.
func (h *codexResetHarness) bindToSlot(slot, accountID string) {
	h.cp.edit(func(op *codexResetModelOperation) {
		op.Slot, op.AccountFingerprint = slot, codexAccountFingerprint(h.key, accountID)
	})
}

// requireOnlyIn fails unless every app-server event in events ran in CODEX_HOME home.
func codexResetRequireOnlyIn(t *testing.T, events []codexResetEvent, home string) {
	t.Helper()
	for _, event := range events {
		if event.Src == "app" && event.CodexHome != home {
			t.Fatalf("an app-server ran in CODEX_HOME %q (%s), want only %q", event.CodexHome, event.Method, home)
		}
	}
}

func codexResetRequireNoAppServer(t *testing.T, events []codexResetEvent) {
	t.Helper()
	for _, event := range events {
		if event.Src == "app" {
			t.Fatalf("an app-server ran (CODEX_HOME %q, %q): %+v", event.CodexHome, event.Method, event)
		}
	}
}

func codexResetRequireUntouched(t *testing.T, who string, provider codexResetProviderState, count int64) {
	t.Helper()
	if len(provider.Answers) != 0 || len(provider.Redeemed) != 0 || provider.AvailableCount != count {
		t.Fatalf("%s's account was consumed in: answered %v, redeemed %v, holds %d (want %d)",
			who, provider.Answers, provider.Redeemed, provider.AvailableCount, count)
	}
}

func codexResetRequireVersion(t *testing.T, results []CodexRateLimitResetResultRequest, version int) {
	t.Helper()
	for _, result := range results {
		if result.ProtocolVersion != version {
			t.Fatalf("result %+v is protocol version %d, want the command's %d", result, result.ProtocolVersion, version)
		}
	}
}

// (a) Each added slot's probe reads that slot's CODEX_HOME — account/read and account/rateLimits/read, as
// Default's does — and its block reaches the heartbeat under that slot's Accounts entry: the slot's own
// account's fingerprint and credits, this process's generation, fetchedAt from the read's start and a sequence
// that counts that slot's reads. A rolling update, which carries no block, keeps the slot's block; a removed
// slot leaves the heartbeat with its block.
func TestCodexResetSlotProbeReportsEachSlotsBlockUnderItsAccount(t *testing.T) {
	fixture := codexResetReadFixture(t, "details-complete")
	fake := newFakeCodexBinary(t, fixture.account, fixture.rateLimits)
	fake.useAsRunnerDefault(t)
	defaultHome := filepath.Join(os.Getenv("HOME"), ".codex")
	work, err := codexAccountKind.create("Work")
	if err != nil {
		t.Fatal(err)
	}
	side, err := codexAccountKind.create("Side")
	if err != nil {
		t.Fatal(err)
	}
	// Work holds 4 credits. Side's CLI names its account but has no credits to report (CREDITS_UNAVAILABLE).
	workRead := codexAccountQuotaRead(8)
	workRead["accountId"] = codexResetTestWorkAccount
	workRead["rateLimitResetCredits"] = map[string]interface{}{"availableCount": 4, "credits": nil}
	answerInCodexHome(t, work.Dir, "rateLimits.json", workRead)
	sideRead := codexAccountQuotaRead(30)
	sideRead["accountId"] = codexResetTestSideAccount
	sideRead["rateLimitResetCredits"] = nil
	answerInCodexHome(t, side.Dir, "rateLimits.json", sideRead)

	ctx := context.Background()
	usage := newCodexAccountUsage(codexResetTestLeaseOwner)
	read, err := usage.def.fetch(ctx, usage.def.client)
	if err != nil {
		t.Fatal(err)
	}
	usage.def.store(read)
	started := 0
	usage.syncSlots(ctx, func(context.Context, *planUsageProbe) { started++ })
	if started != 2 {
		t.Fatalf("started %d slot probes, want Work's and Side's", started)
	}
	// Two reads of each slot, the way its loop makes them.
	var before, after time.Time
	for pass := 0; pass < 2; pass++ {
		before = time.Now()
		for _, id := range []string{work.ID, side.ID} {
			usage.mu.Lock()
			probe := usage.slot(id).probe
			usage.mu.Unlock()
			read, err := probe.fetch(ctx, probe.client)
			if err != nil {
				t.Fatal(err)
			}
			probe.store(read)
		}
		after = time.Now()
	}

	wire, err := json.Marshal(HeartbeatRequest{LeaseOwner: codexResetTestLeaseOwner, PlanUsage: combinePlanUsage(nil, usage.snapshot(), nil, nil)})
	if err != nil {
		t.Fatal(err)
	}
	var beat struct {
		PlanUsage struct {
			RateLimitReset json.RawMessage                       `json:"rateLimitReset"`
			Accounts       map[string]map[string]json.RawMessage `json:"accounts"`
		} `json:"planUsage"`
	}
	if err := json.Unmarshal(wire, &beat); err != nil {
		t.Fatal(err)
	}
	decode := func(who string, raw json.RawMessage) PlanUsageRateLimitReset {
		t.Helper()
		if len(raw) == 0 {
			t.Fatalf("%s carries no reset block on the wire: %s", who, wire)
		}
		block, err := decodeCodexResetWire(raw, codexRateLimitResetBlockViolations)
		if err != nil {
			t.Fatalf("%s's block is not a contract block: %v\n%s", who, err, raw)
		}
		return block
	}
	key := codexResetTestKey(t)
	def := decode("Default", beat.PlanUsage.RateLimitReset)
	if def.AccountFingerprint != codexAccountFingerprint(key, fixture.accountID) || def.Sequence != 1 {
		t.Fatalf("Default's block %+v, want its own account's, read once", def)
	}
	from, to := before.UTC().Format(codexResetFetchedAtLayout), after.UTC().Format(codexResetFetchedAtLayout)
	for _, want := range []struct {
		who, id, account, support string
		credits                   *PlanUsageRateLimitResetCredits
	}{
		{"Work", work.ID, codexResetTestWorkAccount, codexResetSupported, &PlanUsageRateLimitResetCredits{AvailableCount: 4}},
		{"Side", side.ID, codexResetTestSideAccount, codexResetCreditsUnavailable, nil},
	} {
		block := decode(want.who, beat.PlanUsage.Accounts[want.id]["rateLimitReset"])
		if block.Support != want.support || block.AccountFingerprint != codexAccountFingerprint(key, want.account) ||
			!reflect.DeepEqual(block.RateLimitResetCredits, want.credits) {
			t.Fatalf("%s's block %+v, want %s on its own account with %+v", want.who, block, want.support, want.credits)
		}
		// The second read's: this process's generation, the slot's own sequence, and the read's start.
		if block.Generation != codexResetTestLeaseOwner || block.Sequence != 2 || block.FetchedAt < from || block.FetchedAt > to {
			t.Fatalf("%s's block %+v, want generation %s, sequence 2 and fetchedAt in [%s, %s]",
				want.who, block, codexResetTestLeaseOwner, from, to)
		}
	}
	for _, secret := range []string{fixture.accountID, codexResetTestWorkAccount, codexResetTestSideAccount} {
		if strings.Contains(string(wire), secret) {
			t.Fatalf("the provider's account id %q reached the heartbeat: %s", secret, wire)
		}
	}

	// Each slot's reads ran in its own CODEX_HOME, and made account/read as well as account/rateLimits/read.
	spawns := map[string]int{}
	for _, spawn := range fake.spawns(t) {
		spawns[spawn.CodexHome]++
	}
	for home := range spawns {
		if home != "" && home != defaultHome && home != work.Dir && home != side.Dir {
			t.Fatalf("an app-server ran in CODEX_HOME %s", home)
		}
	}
	if spawns[work.Dir] < 2 || spawns[side.Dir] < 2 {
		t.Fatalf("app-servers by CODEX_HOME %v, want at least two reads in each slot's", spawns)
	}
	counts := map[string]int{}
	for _, line := range fake.lines(t, "requests.jsonl") {
		var frame map[string]interface{}
		if err := json.Unmarshal([]byte(line), &frame); err != nil {
			t.Fatal(err)
		}
		method, _ := frame["method"].(string)
		counts[method]++
	}
	if counts[codexAccountReadMethod] != 5 || counts[codexRateLimitsReadMethod] != 5 || counts[codexRateLimitResetConsumeMethod] != 0 {
		t.Fatalf("app-server requests %v, want account/read and account/rateLimits/read for Default once and each slot twice", counts)
	}

	// A rolling update from a session on Work refreshes Work's windows and keeps Work's block.
	kept := *usage.snapshot().Accounts[work.ID].RateLimitReset
	usage.mergeCodexRateLimits(work.ID, map[string]interface{}{
		"limitId": codexPlanLimitID,
		"primary": map[string]interface{}{"usedPercent": 41, "windowDurationMins": 300},
	})
	w := usage.snapshot().Accounts[work.ID]
	if w.Primary == nil || w.Primary.Utilization != 41 || w.RateLimitReset == nil || !reflect.DeepEqual(*w.RateLimitReset, kept) {
		t.Fatalf("after a rolling update Work is %+v with block %+v, want 41%% and the block %+v", w, w.RateLimitReset, kept)
	}

	// Side is removed: its block leaves the heartbeat with its entry, and Work's stays.
	if err := removeCodexAccount(usage, side.ID, nil); err != nil {
		t.Fatal(err)
	}
	if got := usage.snapshot().Accounts; got[side.ID] != nil || got[work.ID] == nil || got[work.ID].RateLimitReset == nil {
		t.Fatalf("after removing Side the accounts are %+v", got)
	}
}

// (b) A CONSUME naming added slot Work reads, consumes and refreshes in Work's CODEX_HOME only: the
// operation's account is Work's, and it is the one credit spent. Default's account and Side's are signed in
// beside it with credits of their own; no app-server opens in either. The results answer in the command's
// version, and the refresh's block lands in Work's snapshot.
func TestCodexResetSlotConsumeRunsOnlyInTheSlotsCodexHome(t *testing.T) {
	h := newCodexResetHarness(t, codexResetSignedIn(2, true))
	work := h.slot("Work", codexResetSignedInAs(codexResetTestWorkAccount, 3, true))
	side := h.slot("Side", codexResetSignedInAs(codexResetTestSideAccount, 5, true))
	h.bindToSlot(work.ID, codexResetTestWorkAccount)
	key := h.cp.operation().ProviderIdempotencyKey
	p := h.process()

	h.mark("consume")
	cmd := p.heartbeat()
	p.finish()
	if cmd == nil || cmd.ProtocolVersion != codexRateLimitResetProtocolVersionV2 || cmd.AccountSlot != work.ID || cmd.Phase != codexResetPhaseConsume {
		t.Fatalf("the heartbeat handed %+v, want a version 2 CONSUME naming Work", cmd)
	}

	events := codexResetAfter(h.events(), "consume")
	codexResetRequireSequence(t, events, codexResetSteps(
		"deliver CONSUME/1",
		codexResetReadRequests, "app "+codexRateLimitResetConsumeMethod,
		"CONSUME_OUTCOME/reset -> APPLIED REFRESHING REFRESH",
		codexResetReadRequests, "deliver REFRESH/1",
		"REFRESHED -> APPLIED SUCCEEDED STOP",
	))
	codexResetRequireOnlyIn(t, events, work.Dir)
	if calls := h.requireOnlyThePersistedKey(events); calls != 1 {
		t.Fatalf("%d consume calls, want 1", calls)
	}

	got := h.slotProvider(work)
	if !reflect.DeepEqual(got.Answers, []string{"reset"}) || !reflect.DeepEqual(got.Redeemed, []string{key}) || got.AvailableCount != 2 {
		t.Fatalf("Work's account answered %v, redeemed %v and holds %d; want one reset under the key, leaving 2",
			got.Answers, got.Redeemed, got.AvailableCount)
	}
	codexResetRequireUntouched(t, "Default", h.provider(nil), 2)
	codexResetRequireUntouched(t, "Side", h.slotProvider(side), 5)

	op := h.cp.operation()
	if op.status() != "SUCCEEDED" {
		t.Fatalf("the operation ended %+v, want SUCCEEDED", op)
	}
	results := h.results(events)
	codexResetRequireVersion(t, results, codexRateLimitResetProtocolVersionV2)
	if results[0].ObservedAccountFingerprint != op.AccountFingerprint {
		t.Fatalf("the outcome observed %q, want Work's account %q", results[0].ObservedAccountFingerprint, op.AccountFingerprint)
	}
	refreshed := results[1].RateLimitReset
	if refreshed == nil || refreshed.AccountFingerprint != op.AccountFingerprint || refreshed.RateLimitResetCredits.AvailableCount != 2 {
		t.Fatalf("REFRESHED carried %+v, want Work's account holding 2", refreshed)
	}
	// The step read through Work's probe: its block is the one Work reports next, and Default has none.
	snapshot := p.usage.snapshot()
	if w := snapshot.Accounts[work.ID]; w == nil || w.RateLimitReset == nil || !reflect.DeepEqual(*w.RateLimitReset, *refreshed) {
		t.Fatalf("Work's snapshot %+v, want the refresh's block %+v", w, refreshed)
	}
	if snapshot.RateLimitReset != nil {
		t.Fatalf("Default's snapshot gained a block %+v from Work's step", snapshot.RateLimitReset)
	}
}

// A REFRESH naming Work is Work's authoritative read, in Work's CODEX_HOME only.
func TestCodexResetSlotRefreshReadsOnlyTheSlot(t *testing.T) {
	h := newCodexResetHarness(t, codexResetSignedIn(2, true))
	work := h.slot("Work", codexResetSignedInAs(codexResetTestWorkAccount, 1, false))
	h.bindToSlot(work.ID, codexResetTestWorkAccount)
	h.cp.edit(func(op *codexResetModelOperation) {
		op.ConsumeState, op.ConsumeOutcome, op.RefreshState = "CONFIRMED", "reset", "PENDING"
	})
	p := h.process()

	h.mark("refresh")
	cmd := p.heartbeat()
	p.finish()
	if cmd == nil || cmd.Phase != codexResetPhaseRefresh || cmd.AccountSlot != work.ID {
		t.Fatalf("the heartbeat handed %+v, want a REFRESH naming Work", cmd)
	}
	events := codexResetAfter(h.events(), "refresh")
	codexResetRequireSequence(t, events, codexResetSteps(
		"deliver REFRESH/1",
		codexResetReadRequests, "deliver REFRESH/1",
		"REFRESHED -> APPLIED SUCCEEDED STOP",
	))
	codexResetRequireOnlyIn(t, events, work.Dir)
	results := h.results(events)
	codexResetRequireVersion(t, results, codexRateLimitResetProtocolVersionV2)
	if b := results[0].RateLimitReset; b == nil || b.AccountFingerprint != h.cp.operation().AccountFingerprint || b.RateLimitResetCredits.AvailableCount != 1 {
		t.Fatalf("REFRESHED carried %+v, want Work's account holding 1", b)
	}
}

// (c) The fingerprint check before the consume holds per slot: a CONSUME naming Work, whose CODEX_HOME now
// holds another account, is CONSUME_NOT_CALLED / ACCOUNT_MISMATCH with zero consume calls anywhere — though the
// operation's own account is signed in to Default right beside it, with credits. Nothing is read in Default's
// login in Work's place.
func TestCodexResetSlotConsumeOnAnotherAccountCallsNothing(t *testing.T) {
	h := newCodexResetHarness(t, codexResetSignedIn(2, true))
	work := h.slot("Work", codexResetSignedInAs(codexResetTestOtherAccount, 3, true))
	// The operation was made for the account Default holds, on Work, before Work was signed in again.
	h.bindToSlot(work.ID, codexResetTestAccountID)
	p := h.process()

	h.mark("consume")
	p.heartbeat()
	p.finish()
	events := codexResetAfter(h.events(), "consume")
	codexResetRequireSequence(t, events, codexResetSteps(
		"deliver CONSUME/1",
		codexResetReadRequests,
		"CONSUME_NOT_CALLED/ACCOUNT_MISMATCH -> APPLIED NOT_ATTEMPTED STOP",
	))
	codexResetRequireOnlyIn(t, events, work.Dir)
	if calls := codexResetConsumeCalls(t, h.events()); len(calls) != 0 {
		t.Fatalf("%d consume calls, want none", len(calls))
	}
	results := h.results(events)
	codexResetRequireVersion(t, results, codexRateLimitResetProtocolVersionV2)
	if observed := results[0].ObservedAccountFingerprint; observed != codexAccountFingerprint(h.key, codexResetTestOtherAccount) {
		t.Fatalf("the refusal observed %q, want the account Work holds now", observed)
	}
	codexResetRequireUntouched(t, "Work", h.slotProvider(work), 3)
	codexResetRequireUntouched(t, "Default", h.provider(nil), 2)
}

// (d) A command naming a slot that is not on this machine — one removed since the operation was made, or one
// it never had — is refused without a read: no app-server opens anywhere, Default's login is not read in its
// place, and nothing makes a probe or a directory for it. A CONSUME is CONSUME_NOT_CALLED / ACCOUNT_MISMATCH,
// a REFRESH REFRESH_FAILED / ACCOUNT_MISMATCH.
func TestCodexResetCommandNamingAMissingSlotIsRefusedWithoutARead(t *testing.T) {
	for _, phase := range []string{codexResetPhaseConsume, codexResetPhaseRefresh} {
		for _, removed := range []bool{true, false} {
			name := phase + "/never added"
			if removed {
				name = phase + "/removed"
			}
			t.Run(name, func(t *testing.T) {
				h := newCodexResetHarness(t, codexResetSignedIn(2, true))
				p := h.process()
				slot := "0badf00d"
				if removed {
					work := h.slot("Work", codexResetSignedInAs(codexResetTestWorkAccount, 3, true))
					if err := removeCodexAccount(p.usage, work.ID, nil); err != nil {
						t.Fatal(err)
					}
					slot = work.ID
				}
				h.bindToSlot(slot, codexResetTestWorkAccount)
				want := "CONSUME_NOT_CALLED/ACCOUNT_MISMATCH -> APPLIED NOT_ATTEMPTED STOP"
				if phase == codexResetPhaseRefresh {
					h.cp.edit(func(op *codexResetModelOperation) {
						op.ConsumeState, op.ConsumeOutcome, op.RefreshState = "CONFIRMED", "reset", "PENDING"
					})
					want = "REFRESH_FAILED/ACCOUNT_MISMATCH -> APPLIED REFRESH_FAILED STOP"
				}

				h.mark("command")
				cmd := p.heartbeat()
				p.finish()
				if cmd == nil || cmd.Phase != phase || cmd.AccountSlot != slot {
					t.Fatalf("the heartbeat handed %+v, want a %s naming %s", cmd, phase, slot)
				}
				events := codexResetAfter(h.events(), "command")
				codexResetRequireSequence(t, events, []string{"deliver " + phase + "/1", want})
				codexResetRequireNoAppServer(t, events)
				codexResetRequireVersion(t, h.results(events), codexRateLimitResetProtocolVersionV2)
				codexResetRequireUntouched(t, "Default", h.provider(nil), 2)
				p.usage.mu.Lock()
				_, probed := p.usage.slots[slot]
				p.usage.mu.Unlock()
				if probed {
					t.Fatalf("the step made a probe for the missing slot %s", slot)
				}
				root, err := accountSlotsDir(codexAccountKind)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := os.Lstat(filepath.Join(root, slot)); !os.IsNotExist(err) {
					t.Fatalf("the missing slot's directory exists after the step: %v", err)
				}
			})
		}
	}
}
