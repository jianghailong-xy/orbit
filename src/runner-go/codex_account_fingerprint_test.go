package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// Every Codex account on a runner, Default included, is reported with the prefix of the fingerprint
// of the account it actually holds. Each slot's accountId is read out of that slot's own
// account/rateLimits/read — the read the plan-usage probe already makes — and turned into a
// fingerprint with this machine's key, so two slots holding one account match and two different
// accounts do not. The accountId itself never leaves the machine (docs/codex-rate-limit-reset-
// contract.md §3), and neither does anything else the provider answers that read with.

// codexAccountFingerprintRead is an account/rateLimits/read answer for the account the provider knows
// as accountID, with the reset-credit summary a real read carries beside it.
func codexAccountFingerprintRead(accountID string, used int) map[string]interface{} {
	return map[string]interface{}{
		"rateLimits": map[string]interface{}{
			"limitId": codexPlanLimitID,
			"primary": map[string]interface{}{"usedPercent": used, "windowDurationMins": 300, "resetsAt": 1789003600},
		},
		"rateLimitResetCredits": map[string]interface{}{"availableCount": 1, "credits": nil},
		"accountId":             accountID,
	}
}

// readEveryCodexAccount makes the reads a heartbeat's report is built from: Default's, then every
// listed slot's own.
func readEveryCodexAccount(t *testing.T, usage *codexAccountUsage) {
	t.Helper()
	ctx := context.Background()
	def, err := usage.def.fetch(ctx, usage.def.client)
	if err != nil {
		t.Fatal(err)
	}
	usage.def.store(def)
	usage.syncSlots(ctx, func(_ context.Context, probe *planUsageProbe) {
		read, err := probe.fetch(ctx, probe.client)
		if err != nil {
			t.Fatal(err)
		}
		probe.store(read)
	})
}

// codexAccountRowsForHeartbeat is the engine snapshot the heartbeat carries: every slot on this
// machine, as the engine probe reports them.
func codexAccountRowsForHeartbeat(t *testing.T) []EngineHealthReport {
	t.Helper()
	slots, err := listCodexAccountSlots()
	if err != nil {
		t.Fatal(err)
	}
	accounts := make([]EngineAccountReport, 0, len(slots))
	for _, slot := range slots {
		accounts = append(accounts, EngineAccountReport{
			ID: slot.ID, Name: slot.Name, CodexHome: slot.CodexHome, Auth: "yes",
		})
	}
	return []EngineHealthReport{{Engine: providerCodex, Installed: true, Auth: "yes", Accounts: accounts}}
}

type codexFingerprintHarness struct {
	fake  *fakeCodexBinary
	usage *codexAccountUsage
}

// newCodexFingerprintHarness gives the runner a throwaway machine home, the fake app-server as its
// codex, and two accounts added on top of Default. Each of the three answers account/rateLimits/read
// with the account id its own answers name.
func newCodexFingerprintHarness(t *testing.T, defaultAccount, workAccount, personalAccount string) *codexFingerprintHarness {
	t.Helper()
	fixture := codexResetReadFixture(t, "details-complete")
	fake := newFakeCodexBinary(t, fixture.account, codexAccountFingerprintRead(defaultAccount, 62))
	fake.useAsRunnerDefault(t)
	for _, slot := range []struct{ name, account string }{{"Work", workAccount}, {"Personal", personalAccount}} {
		added, err := createCodexAccountSlot(slot.name)
		if err != nil {
			t.Fatal(err)
		}
		answerInCodexHome(t, added.CodexHome, "rateLimits.json", codexAccountFingerprintRead(slot.account, 8))
	}
	usage := newCodexAccountUsage(codexResetTestLeaseOwner)
	readEveryCodexAccount(t, usage)
	return &codexFingerprintHarness{fake: fake, usage: usage}
}

// prefixes is what the heartbeat would report for every account on this machine, by slot id.
func (h *codexFingerprintHarness) prefixes(t *testing.T) map[string]string {
	t.Helper()
	rows := codexAccountRowsForHeartbeat(t)
	out := withCodexAccountFingerprints(rows, h.usage)
	if len(out) != 1 || len(out[0].Accounts) != 3 {
		t.Fatalf("accounts on the wire = %+v, want Default, Work and Personal", out)
	}
	prefixes := map[string]string{}
	for _, account := range out[0].Accounts {
		prefixes[account.ID] = account.FingerprintPrefix
	}
	return prefixes
}

// assertFingerprintPrefix holds that s is the start of a fingerprint — `cxa1_` and eight lowercase
// hex digits — which is all an account row carries of one.
func assertFingerprintPrefix(t *testing.T, what, s string) {
	t.Helper()
	if len(s) != codexAccountFingerprintPrefixLen || !strings.HasPrefix(s, codexAccountFingerprintPrefix) {
		t.Fatalf("%s's fingerprint prefix = %q, want %s and eight hex digits", what, s, codexAccountFingerprintPrefix)
	}
	for _, r := range s[len(codexAccountFingerprintPrefix):] {
		if !strings.ContainsRune("0123456789abcdef", r) {
			t.Fatalf("%s's fingerprint prefix = %q, want lowercase hex", what, s)
		}
	}
}

// The same account signed into more than one slot: every slot holding it carries the SAME
// fingerprint prefix, Default included — one account, one fingerprint, one key.
func TestCodexAccountFingerprintIsTheSameForOneAccountInTwoSlots(t *testing.T) {
	const account = "acct_orbit_one_account"
	h := newCodexFingerprintHarness(t, account, account, account)

	prefixes := h.prefixes(t)
	slots, err := listCodexAccountSlots()
	if err != nil {
		t.Fatal(err)
	}
	work, personal := slots[1].ID, slots[2].ID
	want := prefixes[codexAccountDefaultSlot]
	assertFingerprintPrefix(t, "Default", want)
	if prefixes[work] != want || prefixes[personal] != want {
		t.Fatalf("prefixes = Default %q, Work %q, Personal %q — one account, one fingerprint",
			prefixes[codexAccountDefaultSlot], prefixes[work], prefixes[personal])
	}
}

// Two different accounts: the prefixes differ, so the page can tell two accounts from one signed in
// twice.
func TestCodexAccountFingerprintDiffersForDifferentAccounts(t *testing.T) {
	h := newCodexFingerprintHarness(t, "acct_orbit_default", "acct_orbit_work", "acct_orbit_personal")

	prefixes := h.prefixes(t)
	slots, err := listCodexAccountSlots()
	if err != nil {
		t.Fatal(err)
	}
	work, personal := slots[1].ID, slots[2].ID
	if prefixes[work] == "" || prefixes[personal] == "" {
		t.Fatalf("a slot was reported without a fingerprint: %+v", prefixes)
	}
	for _, pair := range [][2]string{
		{codexAccountDefaultSlot, work}, {codexAccountDefaultSlot, personal}, {work, personal},
	} {
		if prefixes[pair[0]] == prefixes[pair[1]] {
			t.Fatalf("accounts %s and %s share the fingerprint %q", pair[0], pair[1], prefixes[pair[0]])
		}
	}
}

// Nothing the provider says about who the account is goes on the wire: what the heartbeat carries is
// the prefix of the non-reversible fingerprint, and the accountId it was derived from is not in the
// report — not in the accounts, and not in anything else this machine sends with them.
func TestCodexAccountFingerprintKeepsTheAccountIdOnTheMachine(t *testing.T) {
	const account = "acct_orbit_never_leaves_the_machine"
	h := newCodexFingerprintHarness(t, account, account, "acct_orbit_other_account")

	rows := withCodexAccountFingerprints(codexAccountRowsForHeartbeat(t), h.usage)
	wire, err := json.Marshal(HeartbeatRequest{PlanUsage: h.usage.snapshot(), Engines: rows})
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{account, "acct_orbit_other_account", codexResetTestEmail} {
		if strings.Contains(string(wire), secret) {
			t.Fatalf("the heartbeat carries %q: %s", secret, wire)
		}
	}
	// The reads themselves were the only place it appeared, and they are what produced the
	// fingerprint: the provider's own id is nowhere in what this machine keeps, either.
	h.usage.mu.Lock()
	defer h.usage.mu.Unlock()
	for id, slot := range h.usage.slots {
		if strings.Contains(slot.accountFingerprint(), account) || !codexAccountFingerprintPattern.MatchString(slot.accountFingerprint()) {
			t.Fatalf("account %s keeps %q, want the fingerprint alone", id, slot.accountFingerprint())
		}
	}
}
