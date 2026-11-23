package main

import (
	"net/http"
	"testing"
)

// The fallback ask carries what the child's adapter classified and its admission (§5.1), beside today's error.
func TestSubagentFallbackAskCarriesFailureAndAdmission(t *testing.T) {
	admitted := true
	rig := &subagentFallbackRig{
		children: []ExecResult{
			{Status: stFailed, ErrorMsg: agyQuota429, Failure: &RunFailure{Kind: failureUsageLimit, Said: agyQuota429}, Admission: &admitted},
			{Status: stSucceeded, Result: "Fixed it in a_test.go"},
		},
		answers: []func(http.ResponseWriter){
			moveTo(2, providerCodex, "gpt-5.5", "Moved to gpt-5.5 after gemini-3.8-flash's account hit its limit"),
		},
	}
	report := rig.run(t)
	if len(rig.fallbacks) != 1 {
		t.Fatalf("asked %d times, want once: a classified usage limit moves even when its words carry no marker", len(rig.fallbacks))
	}
	ask := rig.fallbacks[0]
	failure, _ := ask["failure"].(map[string]interface{})
	if ask["error"] != agyQuota429 || failure["kind"] != failureUsageLimit || failure["said"] != agyQuota429 || ask["admission"] != true {
		t.Fatalf("ask = %v", ask)
	}
	if report.Status != subagentStatusDone {
		t.Fatalf("report = %+v", report)
	}

	// Without a classification the ask is today's: no failure, no admission.
	plain := subagentFallbackBody(sessionLimit, ExecResult{Status: stSucceeded, Result: sessionLimit}, subagentDefinition{})
	if _, ok := plain["failure"]; ok {
		t.Fatalf("ask = %v", plain)
	}
	if _, ok := plain["admission"]; ok {
		t.Fatalf("ask = %v", plain)
	}
	refused := false
	explicit := subagentFallbackBody("x", ExecResult{Status: stFailed, Admission: &refused}, subagentDefinition{})
	if v, ok := explicit["admission"]; !ok || v != false {
		t.Fatalf("admission false was not sent: %v", explicit)
	}
}

// The classified kind decides first, over today's moves (§7.3; moving on the account's other kinds is phase 2): a
// spent quota, capacity or a refused sign-in moves; an account that needs action, a connection failure or a refused
// request is the run's result, whatever its words.
func TestSubagentLimitFailureAsksTheClassificationFirst(t *testing.T) {
	for _, c := range []struct {
		kind string
		want bool
	}{
		{failureUsageLimit, true},
		{failureCapacity, true},
		{failureCredentialRefused, true},
		{failureAccountAction, false},
		{failureAccessDenied, false},
		{failureTransport, false},
		{failureRequestRefused, false},
	} {
		res := ExecResult{Status: stFailed, ErrorMsg: "provider words", Failure: &RunFailure{Kind: c.kind, Said: "provider words"}}
		text, got := subagentLimitFailure(res, nil)
		if got != c.want || (got && text != "provider words") {
			t.Errorf("%s: subagentLimitFailure = %q, %v; want %v", c.kind, text, got, c.want)
		}
	}
	// A classified connection failure is not moved, even though its words open as a sign-in.
	cloudflare := ExecResult{Status: stFailed, ErrorMsg: "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare",
		Failure: &RunFailure{Kind: failureTransport}}
	if _, got := subagentLimitFailure(cloudflare, nil); got {
		t.Fatal("a connection failure was moved")
	}
}
