package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
)

// The Go half of the recovery wire contract: this parser is held to the same vectors as
// src/shared/src/recovery.spec.ts (contracts/recovery.fixtures.json), its tables to
// contracts/recovery.contract.json, and the legacy refusal block to the text it has always printed.

type recoveryContractCase struct {
	Name       string              `json:"name"`
	Input      recoveryObservation `json:"input"`
	Expect     json.RawMessage     `json:"expect"`
	LegacyText string              `json:"legacyText"`
}

type recoveryContractFile struct {
	ContractVersion       int                           `json:"contractVersion"`
	EnvelopeFields        []string                      `json:"envelopeFields"`
	Enums                 map[string][]string           `json:"enums"`
	ActionCodePattern     string                        `json:"actionCodePattern"`
	ActionCodes           map[string]string             `json:"actionCodes"`
	DefaultActionByPolicy map[string]*string            `json:"defaultActionByPolicy"`
	LegacyCodes           map[string]recoveryLegacyCode `json:"legacyCodes"`
	LegacyOwnerToActor    map[string]string             `json:"legacyOwnerToActor"`
	LegacyResourceKeys    [][2]string                   `json:"legacyResourceKeys"`
	ResendActionCodes     []string                      `json:"resendActionCodes"`
	RequestIDResourceType string                        `json:"requestIdResourceType"`
	Invariants            struct {
		Rules []struct {
			ID string `json:"id"`
		} `json:"rules"`
	} `json:"invariants"`
	StatusPolicies struct {
		Safe             []int `json:"SAFE"`
		AfterStateChange []int `json:"AFTER_STATE_CHANGE"`
	} `json:"statusPolicies"`
}

func loadRecoveryJSON(t *testing.T, path string, into interface{}) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, into); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
}

func loadRecoveryFixtures(t *testing.T) []recoveryContractCase {
	t.Helper()
	var file struct {
		ContractVersion int                    `json:"contractVersion"`
		Cases           []recoveryContractCase `json:"cases"`
	}
	loadRecoveryJSON(t, "../../contracts/recovery.fixtures.json", &file)
	if file.ContractVersion != recoveryContractVersion || len(file.Cases) == 0 {
		t.Fatalf("fixtures: version %d, %d cases", file.ContractVersion, len(file.Cases))
	}
	return file.Cases
}

func recoveryAsJSONValue(t *testing.T, v interface{}) interface{} {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out interface{}
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestRecoveryContractTablesMatchTheContract(t *testing.T) {
	var contract recoveryContractFile
	loadRecoveryJSON(t, "../../contracts/recovery.contract.json", &contract)
	if contract.ContractVersion != recoveryContractVersion {
		t.Fatalf("contractVersion %d", contract.ContractVersion)
	}
	wantEnums := map[string][]string{
		"kind": recoveryKinds, "effect": recoveryEffects, "retryPolicy": recoveryRetryPolicies,
		"actor": recoveryActors, "userConfirmation": recoveryUserConfirmations,
	}
	if !reflect.DeepEqual(contract.Enums, wantEnums) {
		t.Errorf("enums: contract %v, Go %v", contract.Enums, wantEnums)
	}
	if contract.ActionCodePattern != recoveryActionCodePattern.String() {
		t.Errorf("actionCodePattern: contract %q, Go %q", contract.ActionCodePattern, recoveryActionCodePattern)
	}
	if len(contract.ActionCodes) != len(recoveryActionCodes) {
		t.Errorf("actionCodes: contract %d, Go %d", len(contract.ActionCodes), len(recoveryActionCodes))
	}
	for _, code := range recoveryActionCodes {
		if _, ok := contract.ActionCodes[code]; !ok {
			t.Errorf("action code %s is not in the contract", code)
		}
	}
	for policy, action := range contract.DefaultActionByPolicy {
		want := ""
		if action != nil {
			want = *action
		}
		if recoveryDefaultActionByPolicy[policy] != want {
			t.Errorf("default action for %s: contract %q, Go %q", policy, want, recoveryDefaultActionByPolicy[policy])
		}
	}
	if len(contract.DefaultActionByPolicy) != len(recoveryDefaultActionByPolicy) {
		t.Errorf("defaultActionByPolicy has %d policies, Go %d", len(contract.DefaultActionByPolicy), len(recoveryDefaultActionByPolicy))
	}
	if !reflect.DeepEqual(contract.LegacyCodes, recoveryLegacyCodes) {
		t.Errorf("legacyCodes: contract %v, Go %v", contract.LegacyCodes, recoveryLegacyCodes)
	}
	if !reflect.DeepEqual(contract.LegacyOwnerToActor, recoveryLegacyOwnerToActor) {
		t.Errorf("legacyOwnerToActor: contract %v, Go %v", contract.LegacyOwnerToActor, recoveryLegacyOwnerToActor)
	}
	if !reflect.DeepEqual(contract.LegacyResourceKeys, recoveryLegacyResourceKeys) {
		t.Errorf("legacyResourceKeys: contract %v, Go %v", contract.LegacyResourceKeys, recoveryLegacyResourceKeys)
	}
	if !reflect.DeepEqual(contract.StatusPolicies.Safe, recoveryStatusSafe) ||
		!reflect.DeepEqual(contract.StatusPolicies.AfterStateChange, recoveryStatusAfterStateChg) {
		t.Errorf("statusPolicies: contract %+v", contract.StatusPolicies)
	}
	if !reflect.DeepEqual(contract.ResendActionCodes, recoveryResendActionCodes) ||
		contract.RequestIDResourceType != recoveryRequestIDResourceType {
		t.Errorf("resendActionCodes %v / requestIdResourceType %q", contract.ResendActionCodes, contract.RequestIDResourceType)
	}
	var ruleIDs []string
	for _, r := range contract.Invariants.Rules {
		ruleIDs = append(ruleIDs, r.ID)
	}
	wantRules := []string{"COMMITTED_NEVER_RESENT", "UNKNOWN_VERIFIES_FIRST", "SAME_REQUEST_ID_NEEDS_AN_ID",
		"CONFIRMATION_BLOCKS_AUTOMATIC_RESEND", "RESEND_ACTION_MATCHES_POLICY", "NEVER_HAS_NO_WAIT"}
	if !reflect.DeepEqual(ruleIDs, wantRules) {
		t.Errorf("invariant rules: contract %v, Go %v", ruleIDs, wantRules)
	}
	// The envelope's JSON fields, in the contract's order.
	env, _ := parseRecovery(recoveryObservation{Source: "UNKNOWN", Message: "x"})
	data, _ := json.Marshal(env)
	var keys []string
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.Token()
	for dec.More() {
		key, _ := dec.Token()
		keys = append(keys, key.(string))
		var skip json.RawMessage
		dec.Decode(&skip)
	}
	if !reflect.DeepEqual(keys, contract.EnvelopeFields) {
		t.Errorf("envelope fields: Go %v, contract %v", keys, contract.EnvelopeFields)
	}
}

// The server names actions; this client decides which tool or command carries one out. So no
// action code may be an MCP tool's name, in any spelling.
func TestRecoveryActionCodesAreNeverToolNamesOrCommands(t *testing.T) {
	codes := append([]string{}, recoveryActionCodes...)
	for _, legacy := range recoveryLegacyCodes {
		if legacy.ActionCode != "" {
			codes = append(codes, legacy.ActionCode)
		}
	}
	for _, action := range recoveryDefaultActionByPolicy {
		if action != "" {
			codes = append(codes, action)
		}
	}
	tools := map[string]bool{}
	for _, tool := range toolDescriptors(true, true) {
		name, _ := tool["name"].(string)
		tools[strings.ToUpper(name)] = true
	}
	if len(tools) == 0 {
		t.Fatal("no MCP tools listed")
	}
	known := map[string]bool{}
	for _, code := range recoveryActionCodes {
		known[code] = true
	}
	for _, code := range codes {
		if !recoveryActionCodePattern.MatchString(code) {
			t.Errorf("action code %q is not a token", code)
		}
		if tools[code] {
			t.Errorf("action code %q is an MCP tool's name", code)
		}
		if strings.HasPrefix(code, "ORBIT_") {
			t.Errorf("action code %q reads as a CLI command", code)
		}
		if !known[code] {
			t.Errorf("action code %q is not in the contract's registry", code)
		}
	}
}

func TestRecoveryParsesTheSharedFixtures(t *testing.T) {
	for _, c := range loadRecoveryFixtures(t) {
		t.Run(c.Name, func(t *testing.T) {
			env, ok := parseRecovery(c.Input)
			var got interface{}
			if ok {
				got = recoveryAsJSONValue(t, env)
			}
			var want interface{}
			if err := json.Unmarshal(c.Expect, &want); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				gotJSON, _ := json.Marshal(got)
				t.Errorf("parseRecovery:\n got %s\nwant %s", gotJSON, c.Expect)
			}
		})
	}
}

// The "refused / what / owner / do" block, and the whole Error() line around it, stay what every
// reader of today's text reads: transportHTTPError.refusal is the code that prints it, unchanged.
func TestRecoveryLegacyRefusalTextIsUnchanged(t *testing.T) {
	for _, c := range loadRecoveryFixtures(t) {
		if c.Input.Source != "HTTP" {
			continue
		}
		t.Run(c.Name, func(t *testing.T) {
			e := &transportHTTPError{method: "POST", path: "/api/runner/x", statusCode: c.Input.Status, body: c.Input.Body}
			if got := e.refusal(); got != c.LegacyText {
				t.Errorf("refusal block:\n got %q\nwant %q", got, c.LegacyText)
			}
			want := fmt.Sprintf("POST /api/runner/x -> %d %s", c.Input.Status, c.Input.Body)
			if c.LegacyText != "" {
				want = fmt.Sprintf("POST /api/runner/x -> %d\n%s%s", c.Input.Status, c.LegacyText, c.Input.Body)
			}
			if got := e.Error(); got != want {
				t.Errorf("Error():\n got %q\nwant %q", got, want)
			}
		})
	}
}

// Rewording every English sentence of a failure changes nothing a recovery branch reads.
func TestRecoveryBranchNeverReadsProse(t *testing.T) {
	branch := func(e recoveryEnvelope) recoveryEnvelope {
		e.Message, e.RequiredAction = "", nil
		return e
	}
	for _, c := range loadRecoveryFixtures(t) {
		before, ok := parseRecovery(c.Input)
		reworded := c.Input
		switch c.Input.Source {
		case "HTTP":
			var body map[string]interface{}
			if json.Unmarshal([]byte(c.Input.Body), &body) != nil {
				continue
			}
			if _, isString := body["message"].(string); isString {
				body["message"] = "never retry this, it can never work"
			}
			if _, isList := body["message"].([]interface{}); isList {
				body["message"] = []string{"retry the same request"}
			}
			if action, isString := body["requiredAction"].(string); isString && !recoveryActionCodePattern.MatchString(action) {
				body["requiredAction"] = "retry the same request with the same id"
			}
			data, _ := json.Marshal(body)
			reworded.Body = string(data)
		default:
			reworded.Message = "retry now, it is safe, nothing was written"
		}
		after, okAfter := parseRecovery(reworded)
		if ok != okAfter || !reflect.DeepEqual(branch(before), branch(after)) {
			t.Errorf("%s: rewording changed the branch\nbefore %+v\nafter  %+v", c.Name, branch(before), branch(after))
		}
	}
}

func TestRecoveryOfReadsEveryErrorThisClientMeets(t *testing.T) {
	answered := recoveryOf(&transportHTTPError{statusCode: 429, retryAfter: "4", body: ""}, false)
	if answered.Kind != "TRANSPORT" || answered.Retry.Policy != "SAFE" || answered.Retry.AfterSeconds == nil || *answered.Retry.AfterSeconds != 4 {
		t.Errorf("429: %+v", answered)
	}
	wrapped := recoveryOf(fmt.Errorf("start task: %w", &transportHTTPError{statusCode: 409,
		body: `{"code":"TASK_RUN_REQUEST_IN_PROGRESS","message":"busy"}`}), true)
	if wrapped.Code != taskRunRequestInProgress || wrapped.Retry.Policy != "SAME_REQUEST_ID" {
		t.Errorf("wrapped refusal: %+v", wrapped)
	}
	local := recoveryOf(&recoveryLocalError{code: "MISSING_ARGUMENT", message: "taskId is required"}, false)
	if local.Kind != "VALIDATION" || local.Code != "LOCAL_MISSING_ARGUMENT" || local.Effect != "NONE" {
		t.Errorf("local: %+v", local)
	}
	noAnswer := recoveryOf(&url.Error{Op: "Post", URL: "https://x", Err: errors.New("connection refused")}, false)
	if noAnswer.Code != "TRANSPORT_NO_ANSWER" || noAnswer.Effect != "UNKNOWN" || noAnswer.Retry.Policy != "VERIFY_THEN_RETRY" {
		t.Errorf("no answer: %+v", noAnswer)
	}
	unknown := recoveryOf(errors.New("boom"), false)
	if unknown.Kind != "UNKNOWN" || unknown.Code != "UNKNOWN_ERROR" || unknown.Effect != "UNKNOWN" {
		t.Errorf("unknown: %+v", unknown)
	}
}

// recoveryInvariantViolations is contract `invariants.holdsOnEveryEnvelope`, as checks.
func recoveryInvariantViolations(e recoveryEnvelope, requestIDSent bool) []string {
	var out []string
	action := ""
	if e.ActionCode != nil {
		action = *e.ActionCode
	}
	resend := recoveryIsResend(action)
	hasRequestID := requestIDSent
	for _, r := range e.Resources {
		if r.Type == recoveryRequestIDResourceType {
			hasRequestID = true
		}
	}
	p := e.Retry.Policy
	if e.Effect == "COMMITTED" && (p != "NEVER" || resend) {
		out = append(out, "COMMITTED resent")
	}
	if e.Effect == "UNKNOWN" && !((p == "VERIFY_THEN_RETRY" || p == "SAME_REQUEST_ID") && action == recoveryDefaultActionByPolicy[p]) {
		out = append(out, "UNKNOWN not verified first")
	}
	if p == "SAFE" && e.Effect != "NONE" {
		out = append(out, "SAFE without NONE")
	}
	if p == "SAME_REQUEST_ID" && !hasRequestID {
		out = append(out, "SAME_REQUEST_ID without a request id")
	}
	if e.UserConfirmation == "REQUIRED" && (p == "SAFE" || p == "SAME_REQUEST_ID" || resend) {
		out = append(out, "automatic resend past a confirmation")
	}
	if action == "RETRY" && p != "SAFE" {
		out = append(out, "RETRY off SAFE")
	}
	if action == "RETRY_SAME_REQUEST" && p != "SAME_REQUEST_ID" {
		out = append(out, "RETRY_SAME_REQUEST off SAME_REQUEST_ID")
	}
	if p == "NEVER" && e.Retry.AfterSeconds != nil {
		out = append(out, "NEVER with a wait")
	}
	return out
}

func TestRecoveryInvariantsHoldOnEveryFixture(t *testing.T) {
	for _, c := range loadRecoveryFixtures(t) {
		env, ok := parseRecovery(c.Input)
		if !ok {
			continue
		}
		if v := recoveryInvariantViolations(env, c.Input.RequestIDSent); len(v) > 0 {
			t.Errorf("%s: %v", c.Name, v)
		}
	}
}

// Every stated (effect, retryPolicy, actionCode, userConfirmation) a server block can carry, with no request
// id, one sent by the client, or one named by the answer, on a 409, a 503 and a 201, with and without
// `retryable: true`: the same enumeration as recovery.spec.ts's.
func TestRecoveryInvariantsHoldOnEveryServerBlockCombination(t *testing.T) {
	actions := append([]string{""}, recoveryActionCodes...)
	checked := 0
	for _, status := range []int{409, 503, 201} {
		for _, retryable := range []bool{false, true} {
			for _, effect := range recoveryEffects {
				for _, policy := range recoveryRetryPolicies {
					for _, action := range actions {
						for _, confirmation := range recoveryUserConfirmations {
							for _, id := range []string{"none", "sent", "named"} {
								block := map[string]interface{}{"effect": effect, "retryPolicy": policy,
									"userConfirmation": confirmation, "retryAfterSeconds": 2}
								if action != "" {
									block["actionCode"] = action
								}
								body := map[string]interface{}{"code": "X_COMBINATION", "message": "combination", "recovery": block}
								if retryable {
									body["retryable"] = true
								}
								if id == "named" {
									body["triggerId"] = "trg_x"
								}
								data, _ := json.Marshal(body)
								obs := recoveryObservation{Source: "HTTP", Status: status, Body: string(data), RequestIDSent: id == "sent"}
								env, ok := parseRecovery(obs)
								if !ok {
									t.Fatalf("%s: no envelope", data)
								}
								if v := recoveryInvariantViolations(env, obs.RequestIDSent); len(v) > 0 {
									t.Fatalf("%s -> %+v: %v", data, env, v)
								}
								checked++
							}
						}
					}
				}
			}
		}
	}
	if want := 3 * 2 * len(recoveryEffects) * len(recoveryRetryPolicies) * len(actions) * len(recoveryUserConfirmations) * 3; checked != want || want != 4860 {
		t.Errorf("checked %d combinations, want %d (4860)", checked, want)
	}
}
