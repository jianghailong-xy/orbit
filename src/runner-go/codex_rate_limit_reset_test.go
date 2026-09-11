package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

// The Go half of the Codex rate-limit reset contract, checked against the same repository files
// @orbit/shared's codexRateLimitReset.spec.ts reads: the contract, its wire fixtures and the
// provider schema it was defined against. No test here starts a Codex process or touches a credit.

type codexResetContractFile struct {
	ProtocolVersion int    `json:"protocolVersion"`
	Capability      string `json:"capability"`
	Provider        struct {
		AccountReadMethod string   `json:"accountReadMethod"`
		ReadMethod        string   `json:"readMethod"`
		ConsumeMethod     string   `json:"consumeMethod"`
		ConsumeParamKeys  []string `json:"consumeParamKeys"`
		ConsumeOutcomes   []string `json:"consumeOutcomes"`
		OutcomeEffects    map[string]struct {
			Consumed        bool `json:"consumed"`
			RefreshRequired bool `json:"refreshRequired"`
		} `json:"outcomeEffects"`
	} `json:"provider"`
	Timing             map[string]int64  `json:"timing"`
	Limits             map[string]int    `json:"limits"`
	Formats            map[string]string `json:"formats"`
	AccountFingerprint struct {
		Pattern       string `json:"pattern"`
		MessagePrefix string `json:"messagePrefix"`
		KeyFile       string `json:"keyFile"`
		KeyBytes      int    `json:"keyBytes"`
	} `json:"accountFingerprint"`
	Enums       map[string][]string `json:"enums"`
	GoEnums     []string            `json:"goEnums"`
	ResultKinds map[string]struct {
		Phases        []string `json:"phases"`
		Carries       string   `json:"carries"`
		Codes         []string `json:"codes"`
		TerminalCodes []string `json:"terminalCodes"`
	} `json:"resultKinds"`
	StatusDerivation []struct {
		ConsumeState   string  `json:"consumeState"`
		ConsumeOutcome *string `json:"consumeOutcome"`
		RefreshState   string  `json:"refreshState"`
		Status         string  `json:"status"`
	} `json:"statusDerivation"`
	Wire map[string]struct {
		Layers []string             `json:"layers"`
		Fields map[string][2]string `json:"fields"`
	} `json:"wire"`
	Extensions map[string]struct {
		Go     string               `json:"go"`
		Fields map[string][2]string `json:"fields"`
	} `json:"extensions"`
}

type codexResetNamedFixture struct {
	Name  string          `json:"name"`
	Value json.RawMessage `json:"value"`
}

type codexResetFixtureSet struct {
	Valid   []codexResetNamedFixture `json:"valid"`
	Invalid []codexResetNamedFixture `json:"invalid"`
}

type codexResetFixtureFile struct {
	FingerprintKeyHex string `json:"fingerprintKeyHex"`
	Fingerprints      []struct {
		AccountID   string `json:"accountId"`
		Fingerprint string `json:"fingerprint"`
	} `json:"fingerprints"`
	ProviderReads []struct {
		Name       string                 `json:"name"`
		Account    map[string]interface{} `json:"account"`
		RateLimits map[string]interface{} `json:"rateLimits"`
		Expect     struct {
			Support               string          `json:"support"`
			AccountID             *string         `json:"accountId"`
			RateLimitResetCredits json.RawMessage `json:"rateLimitResetCredits"`
		} `json:"expect"`
	} `json:"providerReads"`
	Blocks             codexResetFixtureSet       `json:"blocks"`
	Commands           codexResetFixtureSet       `json:"commands"`
	Results            codexResetFixtureSet       `json:"results"`
	ResultResponses    codexResetFixtureSet       `json:"resultResponses"`
	OperationViews     codexResetFixtureSet       `json:"operationViews"`
	Heartbeats         map[string]json.RawMessage `json:"heartbeats"`
	HeartbeatResponses map[string]json.RawMessage `json:"heartbeatResponses"`
	ConsumeParams      struct {
		HeartbeatResponse string                 `json:"heartbeatResponse"`
		Expect            map[string]interface{} `json:"expect"`
	} `json:"consumeParams"`
}

func loadCodexResetJSON(t *testing.T, path string, into interface{}) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, into); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
}

func loadCodexResetContract(t *testing.T) codexResetContractFile {
	t.Helper()
	var contract codexResetContractFile
	loadCodexResetJSON(t, "../../contracts/codex-rate-limit-reset.contract.json", &contract)
	return contract
}

func loadCodexResetFixtures(t *testing.T) codexResetFixtureFile {
	t.Helper()
	var fixtures codexResetFixtureFile
	loadCodexResetJSON(t, "../../contracts/codex-rate-limit-reset.fixtures.json", &fixtures)
	return fixtures
}

// codexResetSameJSON compares what got marshals to with want, as JSON values rather than bytes.
func codexResetSameJSON(t *testing.T, what string, got interface{}, want []byte) {
	t.Helper()
	gotJSON, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var gotValue, wantValue interface{}
	if err := json.Unmarshal(gotJSON, &gotValue); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(want, &wantValue); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gotValue, wantValue) {
		t.Fatalf("%s:\n got %s\nwant %s", what, gotJSON, want)
	}
}

func TestCodexResetRunnerConstantsMatchTheContract(t *testing.T) {
	contract := loadCodexResetContract(t)
	if contract.ProtocolVersion != codexRateLimitResetProtocolVersion || contract.Capability != codexRateLimitResetCapabilityV1 {
		t.Fatalf("contract %d/%q, runner %d/%q", contract.ProtocolVersion, contract.Capability,
			codexRateLimitResetProtocolVersion, codexRateLimitResetCapabilityV1)
	}
	provider := contract.Provider
	if provider.AccountReadMethod != codexAccountReadMethod || provider.ReadMethod != codexRateLimitsReadMethod ||
		provider.ConsumeMethod != codexRateLimitResetConsumeMethod {
		t.Fatalf("provider methods drifted: %+v", provider)
	}
	if !reflect.DeepEqual(provider.ConsumeOutcomes, codexRateLimitResetConsumeOutcomes) {
		t.Fatalf("outcomes: contract %v, runner %v", provider.ConsumeOutcomes, codexRateLimitResetConsumeOutcomes)
	}
	if len(provider.OutcomeEffects) != len(codexRateLimitResetOutcomeEffects) {
		t.Fatalf("outcome effects: contract %d, runner %d", len(provider.OutcomeEffects), len(codexRateLimitResetOutcomeEffects))
	}
	for outcome, want := range provider.OutcomeEffects {
		got, ok := codexRateLimitResetOutcomeEffects[outcome]
		if !ok || got.Consumed != want.Consumed || got.RefreshRequired != want.RefreshRequired {
			t.Fatalf("%s: contract %+v, runner %+v", outcome, want, got)
		}
	}
	if contract.Limits["maxCreditDetails"] != codexRateLimitResetMaxCreditDetails ||
		contract.Limits["maxCreditTextLength"] != codexRateLimitResetMaxCreditText ||
		contract.Limits["maxMessageLength"] != codexRateLimitResetMaxMessage {
		t.Fatalf("limits drifted: %v", contract.Limits)
	}
	if time.Duration(contract.Timing["commandFreshnessMs"])*time.Millisecond != codexRateLimitResetCommandFreshness {
		t.Fatalf("command freshness: contract %dms, runner %s", contract.Timing["commandFreshnessMs"], codexRateLimitResetCommandFreshness)
	}
	formats := map[string]string{
		"uuid":             codexResetUUIDPattern.String(),
		"timestampMs":      codexResetTimestampMsPattern.String(),
		"timestampSeconds": codexResetTimestampSecondsPattern.String(),
	}
	if !reflect.DeepEqual(contract.Formats, formats) {
		t.Fatalf("formats: contract %v, runner %v", contract.Formats, formats)
	}
	fingerprint := contract.AccountFingerprint
	if fingerprint.Pattern != codexAccountFingerprintPattern.String() ||
		fingerprint.MessagePrefix != codexAccountFingerprintMessage ||
		fingerprint.KeyFile != codexAccountFingerprintKeyFile ||
		fingerprint.KeyBytes != codexAccountFingerprintKeySize ||
		!strings.HasPrefix(fingerprint.Pattern, "^"+codexAccountFingerprintPrefix) {
		t.Fatalf("fingerprint drifted: %+v", fingerprint)
	}
}

func TestCodexResetRunnerVocabularyMatchesTheContract(t *testing.T) {
	contract := loadCodexResetContract(t)
	declared := append([]string(nil), contract.GoEnums...)
	mirrored := make([]string, 0, len(codexRateLimitResetEnums))
	for name := range codexRateLimitResetEnums {
		mirrored = append(mirrored, name)
	}
	sort.Strings(declared)
	sort.Strings(mirrored)
	if !reflect.DeepEqual(declared, mirrored) {
		t.Fatalf("Go enums: contract %v, runner %v", declared, mirrored)
	}
	for _, name := range contract.GoEnums {
		if !reflect.DeepEqual(codexRateLimitResetEnums[name], contract.Enums[name]) {
			t.Errorf("%s: contract %v, runner %v", name, contract.Enums[name], codexRateLimitResetEnums[name])
		}
	}
	if len(contract.ResultKinds) != len(codexRateLimitResetResultKinds) {
		t.Fatalf("result kinds: contract %d, runner %d", len(contract.ResultKinds), len(codexRateLimitResetResultKinds))
	}
	for kind, want := range contract.ResultKinds {
		got, ok := codexRateLimitResetResultKinds[kind]
		if !ok || !reflect.DeepEqual(got.Phases, want.Phases) || got.Carries != want.Carries ||
			!reflect.DeepEqual(got.Codes, want.Codes) || !reflect.DeepEqual(got.TerminalCodes, want.TerminalCodes) {
			t.Errorf("%s: contract %+v, runner %+v", kind, want, got)
		}
	}
}

func TestCodexResetStatusDerivationMatchesTheContract(t *testing.T) {
	contract := loadCodexResetContract(t)
	key := func(consume string, outcome *string, refresh string) string {
		spelled := "null"
		if outcome != nil {
			spelled = *outcome
		}
		return consume + "/" + spelled + "/" + refresh
	}
	want := map[string]string{}
	for _, row := range contract.StatusDerivation {
		want[key(row.ConsumeState, row.ConsumeOutcome, row.RefreshState)] = row.Status
	}
	outcomes := []*string{nil}
	for i := range codexRateLimitResetConsumeOutcomes {
		outcomes = append(outcomes, &codexRateLimitResetConsumeOutcomes[i])
	}
	for _, consume := range codexRateLimitResetEnums["consumeState"] {
		for _, refresh := range codexRateLimitResetEnums["refreshState"] {
			for _, outcome := range outcomes {
				if got := codexResetOperationStatus(consume, outcome, refresh); got != want[key(consume, outcome, refresh)] {
					t.Errorf("%s: runner %q, contract %q", key(consume, outcome, refresh), got, want[key(consume, outcome, refresh)])
				}
			}
		}
	}
}

func TestCodexResetGoMirrorMatchesTheContractFieldByField(t *testing.T) {
	contract := loadCodexResetContract(t)
	mirrors := map[string]reflect.Type{
		"PlanUsageRateLimitReset":           reflect.TypeOf(PlanUsageRateLimitReset{}),
		"PlanUsageRateLimitResetCredits":    reflect.TypeOf(PlanUsageRateLimitResetCredits{}),
		"PlanUsageRateLimitResetCredit":     reflect.TypeOf(PlanUsageRateLimitResetCredit{}),
		"CodexRateLimitResetCommand":        reflect.TypeOf(CodexRateLimitResetCommand{}),
		"CodexRateLimitResetResultRequest":  reflect.TypeOf(CodexRateLimitResetResultRequest{}),
		"CodexRateLimitResetResultResponse": reflect.TypeOf(CodexRateLimitResetResultResponse{}),
		"CodexRateLimitResetOperationView":  reflect.TypeOf(CodexRateLimitResetOperationView{}),
		"CodexRateLimitResetResultRefusal":  reflect.TypeOf(CodexRateLimitResetResultRefusal{}),
	}
	goLayer := 0
	for name, spec := range contract.Wire {
		mirror, mirrored := mirrors[name]
		if !codexResetOneOf(spec.Layers, "go") {
			if mirrored {
				t.Errorf("%s has a Go mirror but the contract keeps it out of the runner", name)
			}
			continue
		}
		goLayer++
		if !mirrored {
			t.Errorf("contract type %s has no Go mirror", name)
			continue
		}
		codexResetCheckFields(t, name, mirror, spec.Fields, true)
	}
	if goLayer != len(mirrors) {
		t.Errorf("contract puts %d types in Go, the runner mirrors %d", goLayer, len(mirrors))
	}
	hosts := map[string]reflect.Type{"PlanUsage": reflect.TypeOf(PlanUsage{}), "HeartbeatResponse": reflect.TypeOf(HeartbeatResponse{})}
	for name, extension := range contract.Extensions {
		host, ok := hosts[extension.Go]
		if !ok {
			t.Errorf("%s extends unknown Go type %s", name, extension.Go)
			continue
		}
		codexResetCheckFields(t, name, host, extension.Fields, false)
	}
}

// codexResetCheckFields holds a Go struct to the contract's [presence, nullability] per field:
// optional is omitempty, nullable is a nil-able Go type sent as null, and required non-null is a
// value type no JSON null can reach. exact also refuses Go fields the contract does not list.
func codexResetCheckFields(t *testing.T, name string, typ reflect.Type, fields map[string][2]string, exact bool) {
	t.Helper()
	seen := map[string]bool{}
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		tag, omitempty := codexResetJSONTag(field)
		if tag == "" {
			continue
		}
		spec, listed := fields[tag]
		if !listed {
			if exact {
				t.Errorf("%s.%s is not in the contract", name, tag)
			}
			continue
		}
		seen[tag] = true
		presence, nullability := spec[0], spec[1]
		if (presence == "optional") != omitempty {
			t.Errorf("%s.%s: contract says %s, omitempty=%v", name, tag, presence, omitempty)
		}
		nilable := codexResetNilable(field.Type)
		switch {
		case presence == "optional" && nullability == "nullable":
			t.Errorf("%s.%s: Go cannot tell an absent field from a null one", name, tag)
		case nullability == "nullable" && !nilable:
			t.Errorf("%s.%s: nullable in the contract, %s in Go", name, tag, field.Type)
		case presence == "required" && nullability == "non-null" && nilable:
			t.Errorf("%s.%s: required non-null in the contract, nil-able %s in Go", name, tag, field.Type)
		}
	}
	for tag := range fields {
		if !seen[tag] {
			t.Errorf("%s.%s is in the contract but not in Go", name, tag)
		}
	}
}

func TestCodexResetProviderReadsMapLosslessly(t *testing.T) {
	fixtures := loadCodexResetFixtures(t)
	if len(fixtures.ProviderReads) == 0 {
		t.Fatal("no provider read fixtures")
	}
	for _, read := range fixtures.ProviderReads {
		read := read
		t.Run(read.Name, func(t *testing.T) {
			support, accountID, credits := codexRateLimitResetFromRead(read.Account, read.RateLimits)
			if support != read.Expect.Support {
				t.Fatalf("support %s, want %s", support, read.Expect.Support)
			}
			wantAccount := ""
			if read.Expect.AccountID != nil {
				wantAccount = *read.Expect.AccountID
			}
			if accountID != wantAccount {
				t.Fatalf("account id %q, want %q", accountID, wantAccount)
			}
			codexResetSameJSON(t, "rateLimitResetCredits", credits, read.Expect.RateLimitResetCredits)
		})
	}
}

func TestCodexResetDetailCapNeverChangesTheCount(t *testing.T) {
	rows := make([]interface{}, 0, codexRateLimitResetMaxCreditDetails+1)
	for i := 0; i <= codexRateLimitResetMaxCreditDetails; i++ {
		rows = append(rows, map[string]interface{}{
			"id": fmt.Sprintf("rlrc_%d", i), "resetType": "codexRateLimits", "status": "available", "grantedAt": float64(1788000000),
		})
	}
	account := map[string]interface{}{"account": map[string]interface{}{"type": "chatgpt"}}
	read := map[string]interface{}{
		"rateLimitResetCredits": map[string]interface{}{"availableCount": float64(150), "credits": rows},
		"accountId":             "acct_fixture_primary",
	}
	support, _, credits := codexRateLimitResetFromRead(account, read)
	if support != codexResetSupported || credits == nil {
		t.Fatalf("support %s, credits %v", support, credits)
	}
	if credits.AvailableCount != 150 || len(credits.Credits) != codexRateLimitResetMaxCreditDetails {
		t.Fatalf("count %d with %d rows, want 150 with %d", credits.AvailableCount, len(credits.Credits), codexRateLimitResetMaxCreditDetails)
	}
}

func TestCodexAccountFingerprintIsKeyedAndOpaque(t *testing.T) {
	fixtures := loadCodexResetFixtures(t)
	key, err := hex.DecodeString(fixtures.FingerprintKeyHex)
	if err != nil || len(key) != codexAccountFingerprintKeySize {
		t.Fatalf("fixture key: %v (%d bytes)", err, len(key))
	}
	for _, fixture := range fixtures.Fingerprints {
		got := codexAccountFingerprint(key, fixture.AccountID)
		if got != fixture.Fingerprint || !codexAccountFingerprintPattern.MatchString(got) || strings.Contains(got, fixture.AccountID) {
			t.Fatalf("%s: fingerprint %s, want %s", fixture.AccountID, got, fixture.Fingerprint)
		}
	}
	otherKey := append([]byte(nil), key...)
	otherKey[0] ^= 0xff
	if codexAccountFingerprint(otherKey, fixtures.Fingerprints[0].AccountID) == fixtures.Fingerprints[0].Fingerprint {
		t.Fatal("the fingerprint does not depend on the runner-local key")
	}
}

func TestCodexResetWireFixturesValidateLikeShared(t *testing.T) {
	fixtures := loadCodexResetFixtures(t)
	groups := []struct {
		name   string
		set    codexResetFixtureSet
		decode func([]byte) error
	}{
		{"blocks", fixtures.Blocks, func(data []byte) error {
			_, err := decodeCodexResetWire(data, codexRateLimitResetBlockViolations)
			return err
		}},
		{"commands", fixtures.Commands, func(data []byte) error {
			_, err := decodeCodexResetWire(data, codexResetCommandViolations)
			return err
		}},
		{"results", fixtures.Results, func(data []byte) error {
			_, err := decodeCodexResetWire(data, codexResetResultViolations)
			return err
		}},
		{"resultResponses", fixtures.ResultResponses, func(data []byte) error {
			_, err := decodeCodexResetWire(data, codexResetResultResponseViolations)
			return err
		}},
		{"operationViews", fixtures.OperationViews, func(data []byte) error {
			_, err := decodeCodexResetWire(data, codexResetOperationViewViolations)
			return err
		}},
	}
	for _, group := range groups {
		if len(group.set.Valid) == 0 || len(group.set.Invalid) == 0 {
			t.Fatalf("%s: a fixture set is empty", group.name)
		}
		for _, fixture := range group.set.Valid {
			if err := group.decode(fixture.Value); err != nil {
				t.Errorf("%s/%s should be valid: %v", group.name, fixture.Name, err)
			}
		}
		for _, fixture := range group.set.Invalid {
			if err := group.decode(fixture.Value); err == nil {
				t.Errorf("%s/%s should be refused", group.name, fixture.Name)
			}
		}
	}
	var result CodexRateLimitResetResultRequest
	if err := json.Unmarshal(fixtures.Results.Valid[0].Value, &result); err != nil {
		t.Fatal(err)
	}
	result.Message = strings.Repeat("x", codexRateLimitResetMaxMessage+1)
	if len(codexResetResultViolations(result)) == 0 {
		t.Fatal("a message over the cap was accepted")
	}
}

func TestCodexResetLegacyHeartbeatStillParsesUnchanged(t *testing.T) {
	fixtures := loadCodexResetFixtures(t)
	var request HeartbeatRequest
	if err := json.Unmarshal(fixtures.Heartbeats["legacy"], &request); err != nil {
		t.Fatal(err)
	}
	usage := request.PlanUsage
	if usage == nil || usage.Claude == nil || usage.Codex == nil {
		t.Fatalf("legacy plan usage lost: %+v", usage)
	}
	if usage.RateLimitReset != nil || usage.Claude.RateLimitReset != nil || usage.Codex.RateLimitReset != nil {
		t.Fatal("a heartbeat without the block grew one")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(fixtures.Heartbeats["legacy"], &fields); err != nil {
		t.Fatal(err)
	}
	codexResetSameJSON(t, "legacy planUsage round trip", usage, fields["planUsage"])
	var response HeartbeatResponse
	if err := json.Unmarshal(fixtures.HeartbeatResponses["legacy"], &response); err != nil {
		t.Fatal(err)
	}
	if response.CodexRateLimitResetRequest != nil {
		t.Fatal("a legacy heartbeat response produced a reset command")
	}
}

func TestCodexResetHeartbeatCarriesTheBlockNestedAndFlat(t *testing.T) {
	fixtures := loadCodexResetFixtures(t)
	for _, name := range []string{"nestedReset", "flatReset"} {
		var request HeartbeatRequest
		if err := json.Unmarshal(fixtures.Heartbeats[name], &request); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		snapshot := request.PlanUsage
		if snapshot != nil && snapshot.Codex != nil {
			snapshot = snapshot.Codex
		}
		if snapshot == nil || snapshot.RateLimitReset == nil {
			t.Fatalf("%s: the block did not survive decoding", name)
		}
		if violations := codexRateLimitResetBlockViolations(*snapshot.RateLimitReset); len(violations) > 0 {
			t.Fatalf("%s: %v", name, violations)
		}
		if snapshot.RateLimitReset.Generation != request.LeaseOwner {
			t.Fatalf("%s: block generation %s, heartbeat leaseOwner %s", name, snapshot.RateLimitReset.Generation, request.LeaseOwner)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(fixtures.Heartbeats[name], &fields); err != nil {
			t.Fatal(err)
		}
		codexResetSameJSON(t, name+" planUsage round trip", request.PlanUsage, fields["planUsage"])
	}
}

func TestCodexResetConsumeSendsOnlyThePersistedKey(t *testing.T) {
	fixtures := loadCodexResetFixtures(t)
	contract := loadCodexResetContract(t)
	var consume HeartbeatResponse
	if err := json.Unmarshal(fixtures.HeartbeatResponses[fixtures.ConsumeParams.HeartbeatResponse], &consume); err != nil {
		t.Fatal(err)
	}
	command := consume.CodexRateLimitResetRequest
	if command == nil {
		t.Fatal("the consume heartbeat response carries no command")
	}
	params, err := codexResetConsumeParams(*command)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(params, fixtures.ConsumeParams.Expect) {
		t.Fatalf("params %v, want %v", params, fixtures.ConsumeParams.Expect)
	}
	keys := make([]string, 0, len(params))
	for key := range params {
		keys = append(keys, key)
	}
	if !reflect.DeepEqual(keys, contract.Provider.ConsumeParamKeys) {
		t.Fatalf("param keys %v, contract %v", keys, contract.Provider.ConsumeParamKeys)
	}
	again, err := codexResetConsumeParams(*command)
	if err != nil || !reflect.DeepEqual(params, again) {
		t.Fatalf("a redelivered command produced different params: %v / %v", again, err)
	}
	var refresh HeartbeatResponse
	if err := json.Unmarshal(fixtures.HeartbeatResponses["refresh"], &refresh); err != nil {
		t.Fatal(err)
	}
	if _, err := codexResetConsumeParams(*refresh.CodexRateLimitResetRequest); err == nil {
		t.Fatal("a REFRESH command produced consume params")
	}
	keyless := *command
	keyless.ProviderIdempotencyKey = ""
	if _, err := codexResetConsumeParams(keyless); err == nil {
		t.Fatal("a consume without the persisted key produced params")
	}
}

func TestCodexResetCommandDispositionFencesLeaseAndFreshness(t *testing.T) {
	fixtures := loadCodexResetFixtures(t)
	var response HeartbeatResponse
	if err := json.Unmarshal(fixtures.HeartbeatResponses["consume"], &response); err != nil {
		t.Fatal(err)
	}
	own := *response.CodexRateLimitResetRequest
	received := time.Now()
	cases := []struct {
		name   string
		mutate func(*CodexRateLimitResetCommand)
		owner  string
		age    time.Duration
		want   string
	}{
		{"this process's fresh command", nil, own.LeaseOwner, 5 * time.Second, codexResetCommandAct},
		{"another process's claim", nil, "0b9e8d7c-6a5f-4e3d-8c2b-1a0f9e8d7c6b", 5 * time.Second, codexResetCommandIgnore},
		{"a command from a stale heartbeat response", nil, own.LeaseOwner, codexRateLimitResetCommandFreshness + time.Second, codexResetCommandIgnore},
		{"a consume of a newer protocol", func(c *CodexRateLimitResetCommand) { c.ProtocolVersion = 2 }, own.LeaseOwner, time.Second, codexResetCommandRefuseProtocol},
		{"a consume without its key", func(c *CodexRateLimitResetCommand) { c.ProviderIdempotencyKey = "" }, own.LeaseOwner, time.Second, codexResetCommandIgnore},
	}
	for _, tc := range cases {
		command := own
		if tc.mutate != nil {
			tc.mutate(&command)
		}
		if got := codexResetCommandDisposition(command, tc.owner, received, received.Add(tc.age)); got != tc.want {
			t.Errorf("%s: %s, want %s", tc.name, got, tc.want)
		}
	}
}

func TestCodexResetBlockCarriesNoRawAccountData(t *testing.T) {
	fixtures := loadCodexResetFixtures(t)
	key, err := hex.DecodeString(fixtures.FingerprintKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	read := fixtures.ProviderReads[0]
	support, accountID, credits := codexRateLimitResetFromRead(read.Account, read.RateLimits)
	block := PlanUsageRateLimitReset{
		ProtocolVersion: codexRateLimitResetProtocolVersion, Support: support,
		AccountFingerprint: codexAccountFingerprint(key, accountID), RateLimitResetCredits: credits,
		FetchedAt: "2026-09-11T04:21:30.123Z", Generation: "6f1c2b7e-4d3a-4b8e-9c21-7a5e0d3f9b12", Sequence: 1,
	}
	if violations := codexRateLimitResetBlockViolations(block); len(violations) > 0 {
		t.Fatal(violations)
	}
	data, err := json.Marshal(block)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{accountID, "fixture@example.invalid"} {
		if secret == "" || bytes.Contains(data, []byte(secret)) {
			t.Fatalf("the wire block carries %q: %s", secret, data)
		}
	}
}

func codexResetEvidence(t *testing.T, name string) map[string]interface{} {
	t.Helper()
	var document map[string]interface{}
	loadCodexResetJSON(t, "../../docs/evidence/codex-rate-limit-reset-0.154.0/"+name+".json", &document)
	return document
}

func codexResetEvidenceAt(t *testing.T, document map[string]interface{}, path ...string) interface{} {
	t.Helper()
	var current interface{} = document
	for _, key := range path {
		object, ok := current.(map[string]interface{})
		if !ok {
			t.Fatalf("%s is not an object", strings.Join(path, "."))
		}
		current = object[key]
	}
	return current
}

func codexResetEvidenceStrings(t *testing.T, value interface{}) []string {
	t.Helper()
	items, ok := value.([]interface{})
	if !ok {
		t.Fatalf("not a list: %v", value)
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, fmt.Sprint(item))
	}
	return out
}

func TestCodexResetProviderSchemaEvidenceMatchesTheMirror(t *testing.T) {
	contract := loadCodexResetContract(t)
	consume := codexResetEvidence(t, "ConsumeAccountRateLimitResetCreditResponse")
	var outcomes []string
	for _, entry := range codexResetEvidenceAt(t, consume, "definitions", "ConsumeAccountRateLimitResetCreditOutcome", "oneOf").([]interface{}) {
		outcomes = append(outcomes, codexResetEvidenceStrings(t, entry.(map[string]interface{})["enum"])...)
	}
	if !reflect.DeepEqual(outcomes, codexRateLimitResetConsumeOutcomes) {
		t.Fatalf("provider outcomes %v, runner %v", outcomes, codexRateLimitResetConsumeOutcomes)
	}
	params := codexResetEvidence(t, "ConsumeAccountRateLimitResetCreditParams")
	if required := codexResetEvidenceStrings(t, params["required"]); !reflect.DeepEqual(required, contract.Provider.ConsumeParamKeys) {
		t.Fatalf("provider requires %v, the contract sends %v", required, contract.Provider.ConsumeParamKeys)
	}
	if _, offered := codexResetEvidenceAt(t, params, "properties").(map[string]interface{})["creditId"]; !offered {
		t.Fatal("the provider no longer offers creditId; the v1 decision not to send it needs revisiting")
	}
	read := codexResetEvidence(t, "GetAccountRateLimitsResponse")
	if required := codexResetEvidenceStrings(t, read["required"]); !reflect.DeepEqual(required, []string{"rateLimits"}) {
		t.Fatalf("read response requires %v", required)
	}
	summary := codexResetEvidenceAt(t, read, "definitions", "RateLimitResetCreditsSummary").(map[string]interface{})
	if required := codexResetEvidenceStrings(t, summary["required"]); !reflect.DeepEqual(required, []string{"availableCount"}) {
		t.Fatalf("summary requires %v", required)
	}
	upstream := []string{}
	for name := range codexResetEvidenceAt(t, read, "definitions", "RateLimitResetCredit", "properties").(map[string]interface{}) {
		upstream = append(upstream, name)
	}
	mirrored := []string{}
	credit := reflect.TypeOf(PlanUsageRateLimitResetCredit{})
	for i := 0; i < credit.NumField(); i++ {
		name, _ := codexResetJSONTag(credit.Field(i))
		mirrored = append(mirrored, name)
	}
	sort.Strings(upstream)
	sort.Strings(mirrored)
	if !reflect.DeepEqual(upstream, mirrored) {
		t.Fatalf("provider credit fields %v, runner mirror %v", upstream, mirrored)
	}
}
