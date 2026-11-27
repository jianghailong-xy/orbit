package main

import (
	"testing"
	"time"
)

const (
	// testdata/antigravity/error-invalid-key/stderr.txt: real agy 1.2.15 against mockgemini, 2026-10-03; the real API
	// answers an invalid key with the same 400 (docs/antigravity-runtime-contract.md §15).
	agyInvalidKey = "agent executor error: generating and executing: Error 400, Message: API key not valid. Please pass a valid API key., Status: INVALID_ARGUMENT, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo domain:googleapis.com reason:API_KEY_INVALID]]"
	// testdata/antigravity/error-quota-429/stderr.txt: the same recording's 429 with a 40 s RetryInfo.
	agyQuota429 = "agent executor error: generating and executing: Error 429, Message: You exceeded your current quota, Status: RESOURCE_EXHAUSTED, Details: [map[@type:type.googleapis.com/google.rpc.RetryInfo retryDelay:40s]]"
	// docs/antigravity-runtime-contract.md §15 (2026-10-03, measured on runner workstation): a spent Gemini
	// prepayment, every model 402 RESOURCE_EXHAUSTED; the session's error is "agent executor error: generating and
	// executing: Error 402, Message: …" with Google's "Your prepayment credits are depleted…" as its message.
	agyPrepaymentDepleted = "agent executor error: generating and executing: Error 402, Message: Your prepayment credits are depleted…"
)

// antigravityFailureSamples is one recorded error per row of antigravityFailureRules.
var antigravityFailureSamples = []failureSample{
	{where: "testdata/antigravity/error-invalid-key", said: agyInvalidKey, code: "INVALID_ARGUMENT",
		kind: failureCredentialRefused, text: "Failed to authenticate: " + agyInvalidKey},
	{where: "antigravity-runtime-contract.md §15 prepayment depleted", said: agyPrepaymentDepleted,
		kind: failureAccountAction, text: agyPrepaymentDepleted},
	{where: "testdata/antigravity/error-quota-429", said: agyQuota429, code: "RESOURCE_EXHAUSTED",
		kind: failureUsageLimit, text: agyQuota429},
}

func classifyAntigravitySample(s failureSample) engineFailure {
	return antigravityTurnFailureOf(&agyErrorReport{ShortError: s.said, Status: s.code}, "", time.Now())
}

func TestAntigravityFailureRulesFromRecordedReports(t *testing.T) {
	assertEveryRuleSampled(t, antigravityFailureRules, antigravityFailureSamples, classifyAntigravitySample)
	now := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	if got := antigravityTurnFailureOf(&agyErrorReport{ShortError: agyQuota429}, "", now); !got.Until.Equal(now.Add(40 * time.Second)) {
		t.Fatalf("until = %v, want RetryInfo's 40 s after now", got.Until)
	}
	// result.error is read when there is no report, as antigravityErrorText reads it.
	if got := antigravityTurnFailureOf(nil, agyInvalidKey, now); got.Kind != failureCredentialRefused || got.Text != "Failed to authenticate: "+agyInvalidKey {
		t.Fatalf("got %+v", got)
	}
	// A 401 without a recorded report keeps today's sign-in sentence and stays unclassified.
	if got := antigravityTurnFailureOf(&agyErrorReport{ShortError: "Request had invalid authentication credentials.", ErrorCode: 401, Status: "UNAUTHENTICATED"}, "", now); got.Kind != "" || !isAuthError(got.Text) {
		t.Fatalf("got %+v", got)
	}
}

// The recorded samples, replayed through the driver: the failed turn's completion carries the classification and an
// admission; a turn that answered carries neither.
func TestAntigravityTurnCarriesFailureAndAdmission(t *testing.T) {
	_, completions := agyReplay(t, "error-invalid-key", nil)
	got := completions[0]
	if got.Failure == nil || got.Failure.Kind != failureCredentialRefused || got.Failure.Said != agyInvalidKey {
		t.Fatalf("failure = %+v", got.Failure)
	}
	if got.Admission == nil || !*got.Admission {
		t.Fatalf("admission = %v, want true", got.Admission)
	}
	_, completions = agyReplay(t, "error-quota-429", nil)
	if got := completions[0]; got.Failure == nil || got.Failure.Kind != failureUsageLimit || got.Failure.Until == "" {
		t.Fatalf("failure = %+v", got.Failure)
	}
	_, completions = agyReplay(t, "text-multiturn", nil)
	for _, c := range completions {
		if c.Status == stSucceeded && (c.Failure != nil || c.Admission != nil) {
			t.Fatalf("a turn that answered carried %+v / %v", c.Failure, c.Admission)
		}
	}
}
