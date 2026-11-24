package main

import (
	"errors"
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

// The classified kind decides first, over the words (docs/routing-account-health-design.md §7.3): a spent quota,
// capacity and an account that refused the run (its credential, an action it needs, a use it does not allow) move;
// a connection failure or a refused request is the run's result, whatever its words.
func TestSubagentLimitFailureAsksTheClassificationFirst(t *testing.T) {
	for _, c := range []struct {
		kind string
		want bool
	}{
		{failureUsageLimit, true},
		{failureCapacity, true},
		{failureCredentialRefused, true},
		{failureAccountAction, true},
		{failureAccessDenied, true},
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
	// A refused request stays the result even when the child ended before producing anything.
	admitted := true
	refused := ExecResult{Status: stFailed, ErrorMsg: "prompt is too long", Failure: &RunFailure{Kind: failureRequestRefused}, Admission: &admitted}
	if _, got := subagentLimitFailure(refused, nil); got {
		t.Fatal("a refused request was moved")
	}
}

// An unclassified failure moves when the child ended before its engine produced anything (§5.2): the account would
// not start it. Not when it did some work, not when the runner measured nothing, and not on a dropped connection.
func TestSubagentLimitFailureMovesAnUnclassifiedAdmissionFailure(t *testing.T) {
	yes, no := true, false
	const cursorPayment = "Upgrade your plan to keep going"
	for _, c := range []struct {
		name string
		res  ExecResult
		err  error
		want string
	}{
		{"refused at admission", ExecResult{Status: stFailed, ErrorMsg: cursorPayment, Admission: &yes}, nil, cursorPayment},
		{"the engine's error alone", ExecResult{Status: stFailed, Admission: &yes}, errors.New("the engine exited 1"), "the engine exited 1"},
		{"it did some work", ExecResult{Status: stFailed, ErrorMsg: cursorPayment, Admission: &no}, nil, ""},
		{"no measurement", ExecResult{Status: stFailed, ErrorMsg: cursorPayment}, nil, ""},
		{"a dropped connection", ExecResult{Status: stFailed, ErrorMsg: "API Error: Connection error. ECONNRESET", Admission: &yes}, nil, ""},
		{"a success is the result", ExecResult{Status: stSucceeded, Result: "Done", Admission: &yes}, nil, ""},
		{"nothing to say", ExecResult{Status: stFailed, Admission: &yes}, nil, ""},
	} {
		text, got := subagentLimitFailure(c.res, c.err)
		if got != (c.want != "") || text != c.want {
			t.Errorf("%s: subagentLimitFailure = %q, %v; want %q", c.name, text, got, c.want)
		}
	}
}
