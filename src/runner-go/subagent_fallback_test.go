package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// subagentFallbackRig hosts one SubAgent run against a fake control plane and fake child engines: each child call
// takes the next scripted end, and each ask for the next candidate the next scripted answer.
type subagentFallbackRig struct {
	mu        sync.Mutex
	children  []ExecResult
	childErrs []error
	answers   []func(w http.ResponseWriter)
	// What happened, in order.
	ran       []string // engine|model|prompt
	fallbacks []map[string]interface{}
	patch     map[string]interface{}
}

func (r *subagentFallbackRig) child(engine string) subagentChildRunner {
	return func(ctx context.Context, c subagentChild) (ExecResult, string, error) {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.ran = append(r.ran, engine+"|"+c.exec.Model+"|"+c.prompt)
		n := len(r.ran) - 1
		var err error
		if n < len(r.childErrs) {
			err = r.childErrs[n]
		}
		return r.children[n], "", err
	}
}

func (r *subagentFallbackRig) run(t *testing.T) subagentReport {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		raw, _ := io.ReadAll(req.Body)
		var body map[string]interface{}
		_ = json.Unmarshal(raw, &body)
		r.mu.Lock()
		defer r.mu.Unlock()
		switch {
		case req.Method == "POST" && strings.HasSuffix(req.URL.Path, "/runner/sessions/sess1/subagents/run1/fallback"):
			r.fallbacks = append(r.fallbacks, body)
			r.answers[len(r.fallbacks)-1](w)
		case req.Method == "PATCH" && strings.HasSuffix(req.URL.Path, "/runner/sessions/sess1/subagents/run1"):
			r.patch = body
			_, _ = w.Write([]byte(`{"runId":"run1","status":"DONE","applied":true}`))
		default:
			http.Error(w, "unexpected "+req.Method+" "+req.URL.Path, http.StatusNotFound)
		}
	}))
	defer srv.Close()

	saved := map[string]subagentChildRunner{}
	for _, engine := range []string{providerClaude, providerCodex} {
		saved[engine] = subagentChildRunners[engine]
		subagentChildRunners[engine] = r.child(engine)
	}
	defer func() {
		for engine, runner := range saved {
			subagentChildRunners[engine] = runner
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &bgJobService{
		bg: newBgTailer(ctx, func(string, map[string]interface{}) {}, nil), t: NewTransport(srv.URL, "runner-token"),
		sessionID: "sess1", execDir: t.TempDir(), job: &ClaimedSession{Provider: providerClaude},
	}
	runCtx, runCancel := context.WithCancel(context.Background())
	run := &subagentRun{
		id: "run1", toolUseID: "toolu_delegate", model: "claude-opus-5-5", engine: providerClaude, engineSession: "e1",
		kind: "general", done: make(chan struct{}), status: subagentStatusRunning, cancel: runCancel,
	}
	s.subagents.add(run)
	s.bg.subagentsLive.Add(1)
	s.runSubagent(runCtx, run, AgentExecConfig{Provider: providerClaude, Model: "claude-opus-5-5"},
		subagentDefinition{Name: "general", Source: "builtin"}, "Fix the flaky test", false)
	s.subagents.mu.Lock()
	defer s.subagents.mu.Unlock()
	return run.reportLocked()
}

func moveTo(attempt int, engine, model, reason string) func(w http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		b, _ := json.Marshal(map[string]interface{}{
			"runId": "run1", "attempt": attempt, "reason": reason,
			"exec": map[string]interface{}{"provider": engine, "model": model},
		})
		_, _ = w.Write(b)
	}
}

const sessionLimit = "You've hit your session limit · resets 6:20pm (Europe/Berlin)"

// A usage limit on the first candidate: the runner asks for the next one and starts the SubAgent there with the
// same prompt; the run ends with the second attempt's result.
func TestSubagentMovesToTheNextCandidateAfterAUsageLimit(t *testing.T) {
	rig := &subagentFallbackRig{
		children: []ExecResult{
			{Status: stSucceeded, Result: sessionLimit, CostUsd: 0.01},
			{Status: stSucceeded, Result: "Fixed it in a_test.go", CostUsd: 0.25},
		},
		answers: []func(http.ResponseWriter){
			moveTo(2, providerCodex, "gpt-5.5", "Moved to gpt-5.5 after claude-opus-5-5's account hit its limit"),
		},
	}
	report := rig.run(t)
	t.Logf("child runs: %q", rig.ran)
	t.Logf("fallback asks: %v", rig.fallbacks)
	t.Logf("PATCH: %v", rig.patch)
	want := []string{"claude|claude-opus-5-5|Fix the flaky test", "codex|gpt-5.5|Fix the flaky test"}
	if strings.Join(rig.ran, "\n") != strings.Join(want, "\n") {
		t.Fatalf("children ran %q, want %q", rig.ran, want)
	}
	if len(rig.fallbacks) != 1 || rig.fallbacks[0]["error"] != sessionLimit {
		t.Fatalf("fallback asks = %v, want one carrying the limit's words", rig.fallbacks)
	}
	if report.Status != subagentStatusDone || report.Result != "Fixed it in a_test.go" || report.Model != "gpt-5.5" {
		t.Fatalf("report = %+v", report)
	}
	if rig.patch["status"] != subagentStatusDone || rig.patch["costUsd"] != 0.26 {
		t.Fatalf("PATCH = %v, want DONE with both attempts' cost", rig.patch)
	}
}

// A third limit in a row, after two moves, ends the call failed without a third ask.
func TestSubagentFailsAfterTwoMoves(t *testing.T) {
	rig := &subagentFallbackRig{
		children: []ExecResult{
			{Status: stSucceeded, Result: sessionLimit},
			{Status: stFailed, ErrorMsg: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage"},
			{Status: stSucceeded, Result: "You've hit your weekly limit · resets 1pm"},
		},
		answers: []func(http.ResponseWriter){
			moveTo(2, providerCodex, "gpt-5.5", "Moved to gpt-5.5 after claude-opus-5-5's account hit its limit"),
			moveTo(3, providerClaude, "claude-sonnet-5-5", "Moved to claude-sonnet-5-5 after gpt-5.5's account hit its limit"),
		},
	}
	report := rig.run(t)
	t.Logf("child runs: %q", rig.ran)
	t.Logf("result: %s", report.Result)
	if len(rig.ran) != 3 || len(rig.fallbacks) != 2 {
		t.Fatalf("ran %d children and asked %d times, want 3 and 2", len(rig.ran), len(rig.fallbacks))
	}
	if report.Status != subagentStatusFailed || rig.patch["status"] != subagentStatusFailed ||
		!strings.Contains(report.Result, "was moved 2 times") {
		t.Fatalf("report = %+v", report)
	}
}

// Any other failure is the result, once: no ask, no second attempt.
func TestSubagentPlainFailureIsNotMoved(t *testing.T) {
	rig := &subagentFallbackRig{
		children:  []ExecResult{{Status: stFailed, ErrorMsg: "API Error: 400 invalid_request_error"}},
		childErrs: []error{errors.New("the engine ended without a result: segfault")},
	}
	report := rig.run(t)
	t.Logf("child runs: %q", rig.ran)
	t.Logf("result: %s", report.Result)
	if len(rig.ran) != 1 || len(rig.fallbacks) != 0 {
		t.Fatalf("ran %d children and asked %d times, want 1 and 0", len(rig.ran), len(rig.fallbacks))
	}
	if report.Status != subagentStatusFailed || !strings.Contains(report.Result, "segfault") {
		t.Fatalf("report = %+v", report)
	}
}

// No candidate left: the server's NO_SUBAGENT_PROVIDER, with each provider's reason, is the call's result.
func TestSubagentNoProviderLeftIsTheResult(t *testing.T) {
	const message = "No provider is left to run this SubAgent in tier M. Each provider's reason:\n" +
		"- claude (claude), claude-sonnet-5-5: the account hit its limit\n- deepseek (claude): Blocked in the SubAgents settings"
	rig := &subagentFallbackRig{
		children: []ExecResult{{Status: stSucceeded, Result: sessionLimit}},
		answers: []func(http.ResponseWriter){func(w http.ResponseWriter) {
			w.WriteHeader(http.StatusConflict)
			b, _ := json.Marshal(map[string]interface{}{"code": "NO_SUBAGENT_PROVIDER", "message": message, "statusCode": 409})
			_, _ = w.Write(b)
		}},
	}
	report := rig.run(t)
	t.Logf("result: %s", report.Result)
	if len(rig.ran) != 1 || report.Status != subagentStatusFailed ||
		!strings.Contains(report.Result, "NO_SUBAGENT_PROVIDER: "+message) {
		t.Fatalf("ran %q, report = %+v", rig.ran, report)
	}
}

func TestSubagentLimitFailureReadsOnlyLimitsAndCapacity(t *testing.T) {
	cases := []struct {
		res  ExecResult
		err  error
		want bool
	}{
		{ExecResult{Status: stSucceeded, Result: sessionLimit}, nil, true},
		{ExecResult{Status: stSucceeded, Result: "I looked into why yesterday's nightly run failed, and the log said: You've hit your session limit"}, nil, false},
		{ExecResult{Status: stFailed, ErrorMsg: "Selected model is at capacity. Please try a different model."}, nil, true},
		{ExecResult{Status: stSucceeded, Result: "The pool was at capacity, so I resized it."}, nil, false},
		{ExecResult{Status: stFailed, ErrorMsg: "API Error: 500"}, nil, false},
		{ExecResult{}, errors.New("the engine ended without a result: no output"), false},
	}
	for _, c := range cases {
		if _, got := subagentLimitFailure(c.res, c.err); got != c.want {
			t.Errorf("subagentLimitFailure(%+v, %v) = %v, want %v", c.res, c.err, got, c.want)
		}
	}
}
