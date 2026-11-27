package main

import "testing"

// kimiQuotaClassified is what kimiQuotaTurnRecords' turn.ended classifies as.
var kimiQuotaClassified = engineFailure{Kind: failureUsageLimit,
	Said: "429 You exceeded your current token quota: 0 1000000, please check your account balance", Text: kimiQuotaSentence}

// kimiFailureSamples is one recorded turn.ended error per row of kimiFailureRules (matched by name), plus a recorded
// name left unmapped.
var kimiFailureSamples = []failureSample{
	{
		// Kimi 2.1.1's turn.ended for a 429 exceeded_current_quota_error, 2026-10-08 (kimi_account_move_test.go
		// kimiQuotaTurnRecords).
		where: "kimi_account_move_test.go kimiQuotaTurnRecords", code: kimiQuotaExhaustedError,
		said: "429 You exceeded your current token quota: 0 1000000, please check your account balance",
		kind: failureUsageLimit, text: kimiQuotaSentence,
	},
	{
		// The same recording's 400 invalid_request_error (kimiRefusedTurnRecords): a name nothing maps.
		where: "kimi_account_move_test.go kimiRefusedTurnRecords", code: "APIStatusError",
		said: "400 Invalid request: the prompt is malformed", kind: "",
		text: "Kimi Code failed this turn (APIStatusError): 400 Invalid request: the prompt is malformed",
	},
}

func classifyKimiSample(s failureSample) engineFailure {
	err := &kimiTurnError{Name: s.code, Code: "provider.api_error", Message: s.said}
	failure := kimiTurnFailureOf(err)
	if failure.Kind == "" {
		failure.Text = kimiFailureSentence(err)
	}
	return failure
}

func TestKimiFailureRulesFromRecordedErrors(t *testing.T) {
	assertEveryRuleSampled(t, kimiFailureRules, kimiFailureSamples, classifyKimiSample)
	// Matched by the name only: the quota's words under another name are not a spent quota.
	if got := kimiTurnFailureOf(&kimiTurnError{Name: "APIStatusError", Message: "429 You exceeded your current token quota"}); got.Kind != "" {
		t.Fatalf("got %+v", got)
	}
	if got := kimiTurnFailureOf(nil); got != (engineFailure{}) {
		t.Fatalf("got %+v", got)
	}
}

// A finished turn carries the record's classification only when the record's sentence is what it failed with.
func TestKimiFinishedFailureIsTheRecordsOnly(t *testing.T) {
	quota := kimiTurnOutcome{read: true, ran: true, failure: kimiQuotaSentence, classified: kimiQuotaClassified}
	if got := kimiFinishedFailure(kimiQuotaSentence, quota); got.Kind != failureUsageLimit {
		t.Fatalf("got %+v", got)
	}
	if got := kimiFinishedFailure(kimiNoTurn, kimiTurnOutcome{read: true}); got.Kind != "" {
		t.Fatalf("a turn that never opened was classified %+v", got)
	}
	if got := kimiFinishedFailure("", quota); got.Kind != "" {
		t.Fatalf("a refusal (no error text) was classified %+v", got)
	}
	// Admission is what kimiTurnSaidNothing measures.
	silent := &kimiActiveTurn{}
	if got := turnAdmission(!kimiTurnSaidNothing(silent), nil, 0); !*got {
		t.Fatal("a turn that said nothing is an admission failure")
	}
	spoke := &kimiActiveTurn{}
	spoke.text.WriteString("Renaming it now.")
	if got := turnAdmission(!kimiTurnSaidNothing(spoke), nil, 0); *got {
		t.Fatal("a turn that said something was admitted")
	}
}
