package main

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// The real DeepSeek 401 as dsh 0.2.0-rc.2 relays it (P6, harness/dsh_p6_invalidkey_real_test.go):
// upstream status and error type dropped, the masked key between "api key" and "is invalid".
const dshRealInvalidKeyMessage = "Internal error: turn failed: Authentication Fails, Your api key: ****0000 is invalid (request_id: 64d2f58d-15e2-4744-aafd-d463abb21741) "

// First-prompt failures of the mock dsh (TestDshACPHelperProcess), in the measured ACP error shape.
var dshMockPromptFailures = map[string]map[string]interface{}{
	"real-401":         {"code": -32603, "message": dshRealInvalidKeyMessage},
	"real-429":         {"code": -32603, "message": "Internal error: turn failed: Rate Limit Reached"},
	"structured-401":   {"code": -32603, "message": "Internal error: turn failed: synthetic-401", "data": map[string]interface{}{"status": 401}},
	"structured-503":   {"code": -32603, "message": "Internal error: turn failed: invalid api key?", "data": map[string]interface{}{"error": map[string]interface{}{"statusCode": 503}}},
	"network-dropped":  {"code": -32603, "message": "Internal error: turn failed: fetch failed: socket hang up (ECONNRESET)"},
	"server-error-500": {"code": -32603, "message": "Internal error: turn failed: synthetic-500"},
}

func TestDshFailureSemanticsRequestValidation(t *testing.T) {
	for _, tc := range []struct {
		name       string
		err        error
		validation string
		diagnostic string
	}{
		{"real-deepseek-401", errors.New("dsh session/prompt (-32603): " + dshRealInvalidKeyMessage), "invalid", "DSH_CREDENTIAL_INVALID"},
		{"masked-key-alone", errors.New("dsh session/prompt (-32603): Internal error: turn failed: Your API key: sk-****abcd is invalid"), "invalid", "DSH_CREDENTIAL_INVALID"},
		{"authentication-fails", errors.New("dsh session/prompt (-32603): Internal error: turn failed: Authentication Fails"), "invalid", "DSH_CREDENTIAL_INVALID"},
		{"runner-code-roundtrip", errors.New("DSH_CREDENTIAL_INVALID: dsh session/prompt (-32603): turn failed"), "invalid", "DSH_CREDENTIAL_INVALID"},
		{"structured-401", &dshCallError{text: "dsh session/prompt (-32603): Internal error: turn failed: synthetic-401", upstreamStatus: 401}, "invalid", "DSH_CREDENTIAL_INVALID"},
		{"structured-429-beats-wording", &dshCallError{text: "dsh session/prompt (-32603): invalid api key", upstreamStatus: 429}, "unknown", "DSH_REQUEST_FAILED"},
		{"structured-503", &dshCallError{text: "dsh session/prompt (-32603): turn failed", upstreamStatus: 503}, "unknown", "DSH_REQUEST_FAILED"},
		{"rate-limit-text", errors.New("dsh session/prompt (-32603): Internal error: turn failed: Rate Limit Reached"), "unknown", "DSH_REQUEST_FAILED"},
		{"rate-limit-429", errors.New("dsh session/prompt (-32603): Internal error: turn failed: synthetic-429"), "unknown", "DSH_REQUEST_FAILED"},
		{"server-error-5xx", errors.New("dsh session/prompt (-32603): Internal error: turn failed: 503 Service Unavailable"), "unknown", "DSH_REQUEST_FAILED"},
		{"insufficient-balance-402", errors.New("dsh session/prompt (-32603): Internal error: turn failed: Insufficient Balance"), "unknown", "DSH_REQUEST_FAILED"},
		{"network-reset", errors.New("dsh session/prompt (-32603): Internal error: turn failed: fetch failed: socket hang up (ECONNRESET)"), "unknown", "DSH_REQUEST_FAILED"},
		{"transport-closed", errors.New("dsh ACP transport closed: EOF"), "unknown", "DSH_REQUEST_FAILED"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			validation, diagnostic := dshRequestValidation(tc.err, false, "")
			if validation != tc.validation || diagnostic != tc.diagnostic {
				t.Fatalf("classification = %q/%q, want %q/%q", validation, diagnostic, tc.validation, tc.diagnostic)
			}
		})
	}
}

// The structured status comes from the JSON-RPC reply itself, and the diagnostic keeps the launch
// key out even when the upstream echoes it.
func TestDshFailureSemanticsDecodedReplyKeepsStatusAndRedacts(t *testing.T) {
	secret := "sk-p6-deliberately-invalid-0000"
	client := &dshACPClient{secrets: []string{secret}}
	for _, tc := range []struct {
		name       string
		data       interface{}
		diagnostic string
	}{
		{"status-401", map[string]interface{}{"status": float64(401)}, "DSH_CREDENTIAL_INVALID"},
		{"nested-status-429", map[string]interface{}{"error": map[string]interface{}{"status_code": float64(429)}}, "DSH_REQUEST_FAILED"},
		{"no-data", nil, "DSH_CREDENTIAL_INVALID"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := client.decodeReply("session/prompt", dshRPCReply{message: dshRPCMessage{Error: &dshRPCError{
				Code: -32603, Message: "Internal error: turn failed: Your api key: " + secret + " is invalid", Data: tc.data}}})
			if err == nil {
				t.Fatal("an error reply decoded as success")
			}
			if _, diagnostic := dshRequestValidation(err, false, ""); diagnostic != tc.diagnostic {
				t.Fatalf("diagnostic = %q, want %q (%v)", diagnostic, tc.diagnostic, err)
			}
			if strings.Contains(err.Error(), secret) || strings.Contains(dshTurnError(err), secret) {
				t.Fatalf("diagnostic exposed the launch key: %q", dshTurnError(err))
			}
		})
	}
}

// A dsh turn the real endpoint rejected fails with the runner's own code in front, on the
// completion and the transcript error alike; a rate limit, a 5xx or a dropped connection does not.
func TestDshFailureSemanticsTurnCompletion(t *testing.T) {
	for _, tc := range []struct {
		mode    string
		invalid bool
	}{
		{"real-401", true},
		{"structured-401", true},
		{"real-429", false},
		{"structured-503", false},
		{"server-error-500", false},
		{"network-dropped", false},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			status, ended, replay, completions, events, _ := dshRunMockSession(t, tc.mode, true)
			if status != stSucceeded || !ended || replay || len(completions) != 2 {
				t.Fatalf("session after a failed turn = %s %v %v, completions %+v", status, ended, replay, completions)
			}
			failed := completions[0]
			if failed.Status != stFailed || failed.Subtype != "error" {
				t.Fatalf("rejected turn was not FAILED: %+v", failed)
			}
			if tc.mode == "structured-503" && !strings.HasPrefix(failed.Error, "DSH_REQUEST_FAILED: ") {
				t.Fatalf("a status-decided failure did not carry the runner's verdict: %q", failed.Error)
			}
			if got := strings.HasPrefix(failed.Error, "DSH_CREDENTIAL_INVALID: "); got != tc.invalid {
				t.Fatalf("completion error %q: credential-invalid prefix = %v, want %v", failed.Error, got, tc.invalid)
			}
			if validation, _ := dshRequestValidation(errors.New(failed.Error), false, ""); (validation == "invalid") != tc.invalid {
				t.Fatalf("completion error reclassified as %q: %q", validation, failed.Error)
			}
			transcript := ""
			for _, event := range events {
				if event.turn == failed.TurnID && event.typ == evError {
					transcript = event.payload["message"].(string)
				}
			}
			if transcript != failed.Error {
				t.Fatalf("transcript error %q differs from completion %q", transcript, failed.Error)
			}
			if completions[1].Status != stSucceeded {
				t.Fatalf("next turn did not succeed: %+v", completions[1])
			}
		})
	}
}

// F1: no dsh completion claims a measured $0; every other engine's cost is sent as before.
func TestDshFailureSemanticsUsageUnknownOmitsCost(t *testing.T) {
	_, _, _, completions, _, _ := dshRunMockSession(t, "real-401", true)
	for _, completion := range completions {
		if !completion.UsageUnknown || completion.Usage != nil || completion.ModelUsage != nil {
			t.Fatalf("dsh completion claimed usage: %+v", completion)
		}
		wire := dshFailureSemanticsWire(t, completion)
		if _, present := wire["costUsd"]; present {
			t.Fatalf("dsh completion sent costUsd: %v", wire)
		}
		if wire["turnId"] != completion.TurnID || wire["status"] != completion.Status {
			t.Fatalf("shadowing costUsd lost other fields: %v", wire)
		}
	}
	for _, tc := range []struct {
		name    string
		request TurnCompleteRequest
		want    float64
	}{
		{"claude-measured-cost", TurnCompleteRequest{TurnID: "t", Status: stSucceeded, CostUsd: 0.0123}, 0.0123},
		{"codex-measured-zero", TurnCompleteRequest{TurnID: "t", Status: stSucceeded, CostUsd: 0, Usage: &TokenUsage{InputTokens: 10}}, 0},
		{"with-worktree-snapshot", TurnCompleteRequest{TurnID: "t", Status: stSucceeded, CostUsd: 1.5, BaseSha: "abc"}, 1.5},
	} {
		t.Run(tc.name, func(t *testing.T) {
			wire := dshFailureSemanticsWire(t, tc.request)
			if wire["costUsd"] != tc.want {
				t.Fatalf("known cost changed on the wire: %v", wire)
			}
			if tc.request.BaseSha != "" && wire["changedFiles"] == nil {
				t.Fatalf("worktree snapshot lost its explicit file list: %v", wire)
			}
		})
	}
	unknown := dshFailureSemanticsWire(t, TurnCompleteRequest{TurnID: "t", Status: stSucceeded, UsageUnknown: true, BaseSha: "abc"})
	if _, present := unknown["costUsd"]; present || unknown["changedFiles"] == nil {
		t.Fatalf("unknown usage with a worktree snapshot: %v", unknown)
	}
	finalize, err := json.Marshal(RunFinalizeRequest{Status: stSucceeded})
	if err != nil || strings.Contains(string(finalize), "costUsd") {
		t.Fatalf("run finalize claimed a cost nothing measured: %s %v", finalize, err)
	}
}

func dshFailureSemanticsWire(t *testing.T, request TurnCompleteRequest) map[string]interface{} {
	t.Helper()
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]interface{}
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	return wire
}
