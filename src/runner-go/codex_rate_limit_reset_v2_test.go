package main

import (
	"encoding/hex"
	"encoding/json"
	"reflect"
	"sort"
	"testing"
	"time"
)

// Contract v2 of docs/codex-rate-limit-reset-contract.md (§12): a reset block per Codex account and a
// command that names its account slot, checked against the same contract and fixtures as
// @orbit/shared's codexRateLimitReset.spec.ts. These are named TestCodexRateLimitReset… so that
// `go test -run CodexRateLimitReset ./...` runs them, and the v1 contract checks with them.

const (
	codexResetFixtureWorkSlot  = "3fa91c2e"
	codexResetFixtureSpareSlot = "7b04d1e9"
)

func TestCodexRateLimitResetV2RunsTheContractChecks(t *testing.T) {
	for name, check := range map[string]func(*testing.T){
		"constants":           TestCodexResetRunnerConstantsMatchTheContract,
		"vocabulary":          TestCodexResetRunnerVocabularyMatchesTheContract,
		"status derivation":   TestCodexResetStatusDerivationMatchesTheContract,
		"field by field":      TestCodexResetGoMirrorMatchesTheContractFieldByField,
		"provider reads":      TestCodexResetProviderReadsMapLosslessly,
		"fingerprints":        TestCodexAccountFingerprintIsKeyedAndOpaque,
		"wire fixtures":       TestCodexResetWireFixturesValidateLikeShared,
		"v1 legacy heartbeat": TestCodexResetLegacyHeartbeatStillParsesUnchanged,
		"v1 block heartbeats": TestCodexResetHeartbeatCarriesTheBlockNestedAndFlat,
		"consume params":      TestCodexResetConsumeSendsOnlyThePersistedKey,
		"disposition":         TestCodexResetCommandDispositionFencesLeaseAndFreshness,
		"no raw account data": TestCodexResetBlockCarriesNoRawAccountData,
	} {
		t.Run(name, check)
	}
}

func TestCodexRateLimitResetV2ConstantsMatchTheContract(t *testing.T) {
	contract := loadCodexResetContract(t)
	if !reflect.DeepEqual(contract.ProtocolVersions, codexRateLimitResetProtocolVersions) {
		t.Fatalf("protocol versions: contract %v, runner %v", contract.ProtocolVersions, codexRateLimitResetProtocolVersions)
	}
	if contract.CapabilityV2 != codexRateLimitResetCapabilityV2 {
		t.Fatalf("v2 capability: contract %q, runner %q", contract.CapabilityV2, codexRateLimitResetCapabilityV2)
	}
	slot := contract.AccountSlot
	accounts, _ := reflect.TypeOf(PlanUsage{}).FieldByName("Accounts")
	accountsTag, _ := codexResetJSONTag(accounts)
	if slot.Default != accountSlotDefaultID || slot.Pattern != accountSlotIDPattern.String() ||
		slot.SnapshotAccountsField != accountsTag ||
		slot.CommandSlotFromProtocolVersion != codexRateLimitResetProtocolVersionV2 ||
		slot.AddedSlotCapability != codexRateLimitResetCapabilityV2 {
		t.Fatalf("account slot drifted: %+v", slot)
	}
}

func TestCodexRateLimitResetV2KeepsV1HeartbeatsUnchanged(t *testing.T) {
	fixtures := loadCodexResetFixtures(t)
	for _, name := range []string{"legacy", "nestedReset", "flatReset"} {
		var request HeartbeatRequest
		if err := json.Unmarshal(fixtures.Heartbeats[name], &request); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		snapshot := request.PlanUsage
		if snapshot.Codex != nil {
			snapshot = snapshot.Codex
		}
		if snapshot.Accounts != nil {
			t.Fatalf("%s: a v1 heartbeat grew added-slot snapshots", name)
		}
		if snapshot.RateLimitReset != nil && snapshot.RateLimitReset.ProtocolVersion != codexRateLimitResetProtocolVersion {
			t.Fatalf("%s: Default's block is version %d", name, snapshot.RateLimitReset.ProtocolVersion)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(fixtures.Heartbeats[name], &fields); err != nil {
			t.Fatal(err)
		}
		codexResetSameJSON(t, name+" planUsage round trip", request.PlanUsage, fields["planUsage"])
	}
}

func TestCodexRateLimitResetV2HeartbeatCarriesABlockPerAccount(t *testing.T) {
	fixtures := loadCodexResetFixtures(t)
	key, err := hex.DecodeString(fixtures.FingerprintKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	var request HeartbeatRequest
	if err := json.Unmarshal(fixtures.Heartbeats["perAccount"], &request); err != nil {
		t.Fatal(err)
	}
	codex := request.PlanUsage.Codex
	if codex == nil {
		t.Fatal("the per-account heartbeat carries no Codex snapshot")
	}
	want := map[string]string{
		accountSlotDefaultID:       codexAccountFingerprint(key, "acct_fixture_primary"),
		codexResetFixtureWorkSlot:  codexAccountFingerprint(key, "acct_fixture_work"),
		codexResetFixtureSpareSlot: codexAccountFingerprint(key, "acct_fixture_spare"),
	}
	blocks := map[string]*PlanUsageRateLimitReset{accountSlotDefaultID: codex.RateLimitReset}
	slots := make([]string, 0, len(codex.Accounts))
	for slot, snapshot := range codex.Accounts {
		if !accountSlotIDPattern.MatchString(slot) {
			t.Errorf("accounts key %q is not a slot id", slot)
		}
		slots = append(slots, slot)
		blocks[slot] = snapshot.RateLimitReset
	}
	sort.Strings(slots)
	if !reflect.DeepEqual(slots, []string{codexResetFixtureWorkSlot, codexResetFixtureSpareSlot}) {
		t.Fatalf("added slots %v", slots)
	}
	for slot, fingerprint := range want {
		block := blocks[slot]
		if block == nil {
			t.Fatalf("%s: no block", slot)
		}
		if violations := codexRateLimitResetBlockViolations(*block); len(violations) > 0 {
			t.Fatalf("%s: %v", slot, violations)
		}
		if block.AccountFingerprint != fingerprint {
			t.Errorf("%s: fingerprint %s, want %s", slot, block.AccountFingerprint, fingerprint)
		}
		if block.Generation != request.LeaseOwner {
			t.Errorf("%s: block generation %s, heartbeat leaseOwner %s", slot, block.Generation, request.LeaseOwner)
		}
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(fixtures.Heartbeats["perAccount"], &fields); err != nil {
		t.Fatal(err)
	}
	codexResetSameJSON(t, "perAccount planUsage round trip", request.PlanUsage, fields["planUsage"])
}

func TestCodexRateLimitResetV2CommandNamesItsSlot(t *testing.T) {
	fixtures := loadCodexResetFixtures(t)
	sent := time.Now()
	for name, phase := range map[string]string{"consumeAddedSlot": codexResetPhaseConsume, "refreshAddedSlot": codexResetPhaseRefresh} {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(fixtures.HeartbeatResponses[name], &fields); err != nil {
			t.Fatal(err)
		}
		command, err := decodeCodexResetWire(fields["codexRateLimitResetRequest"], codexResetCommandViolations)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if command.ProtocolVersion != codexRateLimitResetProtocolVersionV2 || command.Phase != phase ||
			command.AccountSlot != codexResetFixtureWorkSlot {
			t.Fatalf("%s: %+v", name, command)
		}
		var response HeartbeatResponse
		if err := json.Unmarshal(fixtures.HeartbeatResponses[name], &response); err != nil {
			t.Fatal(err)
		}
		if response.CodexRateLimitResetRequest == nil || *response.CodexRateLimitResetRequest != command {
			t.Fatalf("%s: the heartbeat response decodes to %+v", name, response.CodexRateLimitResetRequest)
		}
		// This binary still speaks protocol 1 only: it refuses a v2 consume without calling anything,
		// and ignores a v2 refresh, rather than acting on Default's login for an added slot.
		wantDisposition := codexResetCommandIgnore
		if phase == codexResetPhaseConsume {
			wantDisposition = codexResetCommandRefuseProtocol
			params, err := codexResetConsumeParams(command)
			if err != nil || !reflect.DeepEqual(params, map[string]interface{}{"idempotencyKey": command.ProviderIdempotencyKey}) {
				t.Fatalf("%s: consume params %v / %v", name, params, err)
			}
		}
		if got := codexResetCommandDisposition(command, command.LeaseOwner, sent, sent.Add(time.Second)); got != wantDisposition {
			t.Fatalf("%s: disposition %s, want %s", name, got, wantDisposition)
		}
	}
	var consume HeartbeatResponse
	if err := json.Unmarshal(fixtures.HeartbeatResponses["consumeAddedSlot"], &consume); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name    string
		version int
		slot    string
		valid   bool
	}{
		{"v2 on Default", 2, accountSlotDefaultID, true},
		{"v2 on an added slot", 2, codexResetFixtureWorkSlot, true},
		{"v2 naming no slot", 2, "", false},
		{"v2 naming a made-up slot", 2, "work", false},
		{"v1 on Default", 1, "", true},
		{"v1 naming a slot", 1, codexResetFixtureWorkSlot, false},
		{"v3", 3, codexResetFixtureWorkSlot, false},
	} {
		command := *consume.CodexRateLimitResetRequest
		command.ProtocolVersion, command.AccountSlot = tc.version, tc.slot
		if valid := len(codexResetCommandViolations(command)) == 0; valid != tc.valid {
			t.Errorf("%s: valid=%v, want %v", tc.name, valid, tc.valid)
		}
	}
}
