package main

import (
	"encoding/json"
	"sync"
	"testing"
	"time"
)

// codexUsageLimit0161 is what codex-cli 0.161.0 failed a turn on when the backend answered 429 usage_limit_reached
// (docs/evidence/codex-fixture/rate-limit-timeline-codex-0.161.0.txt, verdict usageLimit; recorded on the HPC,
// 2026-10-07, whose clock is UTC+8: the window's resetsAt 4102444800 is this sentence's "Jan 1st, 2100 8:00 AM").
const codexUsageLimit0161 = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Jan 1st, 2100 8:00 AM."

// codexFailureSamples is one recorded error per row of codexFailureRules, plus a recorded shape left unmapped.
var codexFailureSamples = []failureSample{
	{
		where: "codex-fixture/rate-limit-timeline-codex-0.161.0.txt usageLimit (codexErrorInfo)",
		said:  codexUsageLimit0161, code: "usageLimitExceeded", kind: failureUsageLimit, text: codexUsageLimit0161,
	},
	{
		// session.error on FAILED runs, as @orbit/shared USAGE_LIMIT_ERROR_MARKERS quotes it (events.ts) and
		// docs/quota-limit-retry-design.md lists it from `select distinct`; no codexErrorInfo with it.
		where: "events.ts USAGE_LIMIT_ERROR_MARKERS (Codex app-server)",
		said:  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 9th, 2026 1:26 PM.",
		kind:  failureUsageLimit,
	},
	{
		// The same 0.161 sentence as turn/completed's error carries it, where no codexErrorInfo is read.
		where: "codex-fixture/rate-limit-timeline-codex-0.161.0.txt usageLimit (message only)",
		said:  codexUsageLimit0161, kind: failureUsageLimit,
	},
	{
		// events.ts RETRYABLE_ENGINE_ERROR_PREFIXES: the task run it killed on 2026-09-29; codex_capacity_retry_test.go.
		where: "events.ts RETRYABLE_ENGINE_ERROR_PREFIXES (2026-09-29)",
		said:  codexCapacityMessage, kind: failureCapacity, text: codexCapacityMessage,
	},
	{
		// Verbatim from session 33yiyd1Su3ZPLjIzJCuOz (engineinstall_test.go realCodex401).
		where: "engineinstall_test.go realCodex401", said: realCodex401,
		kind: failureCredentialRefused, text: "Failed to authenticate: " + realCodex401,
	},
	{
		// Recorded, and deliberately unmapped: a rate limit Codex gave up retrying is AutoRetryService's to re-send.
		where: "codex-fixture/rate-limit-timeline-codex-0.161.0.txt rateLimit",
		said:  "exceeded retry limit, last status: 429 Too Many Requests", code: "responseTooManyFailedAttempts", kind: "",
	},
}

func classifyCodexSample(s failureSample) engineFailure {
	return codexTurnFailureOf(codexTurnResult{Status: stFailed, Error: s.said, failureSaid: s.said, failureCode: s.code})
}

func TestCodexFailureRulesFromRecordedErrors(t *testing.T) {
	assertEveryRuleSampled(t, codexFailureRules, codexFailureSamples, classifyCodexSample)
	if got := codexTurnFailureOf(codexTurnResult{Status: stSucceeded, Error: codexCapacityMessage}); got.Kind != "" {
		t.Fatalf("a turn that did not fail was classified %+v", got)
	}
}

// A spent quota's reset is the sentence's, read in the runner's own time: the 0.161 recording's reset, read at its
// UTC+8, is exactly the window's resetsAt.
func TestCodexUsageLimitResetIsRead(t *testing.T) {
	recorded := time.FixedZone("HPC", 8*3600)
	if got := codexUsageLimitReset(codexUsageLimit0161, recorded); !got.Equal(time.Unix(4102444800, 0)) {
		t.Fatalf("reset = %v, want the window's resetsAt %v", got, time.Unix(4102444800, 0).UTC())
	}
	if got := codexUsageLimitReset("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 9th, 2026 1:26 PM.", time.UTC); !got.Equal(time.Date(2026, 8, 9, 13, 26, 0, 0, time.UTC)) {
		t.Fatalf("reset = %v", got)
	}
	if got := codexUsageLimitReset("You've hit your usage limit. Try again later.", time.UTC); !got.IsZero() {
		t.Fatalf("a sentence naming no time gave %v", got)
	}
	if f := classifyCodexSample(codexFailureSamples[0]); f.Until.IsZero() || f.wire().Until == "" {
		t.Fatalf("the usage limit went out with no until: %+v", f.wire())
	}
}

// The app-server's notifications carry the classification to the turn's end: the error's own words and its
// codexErrorInfo, before asAuthError rewords them, and an admission measured from what the turn put out.
func TestCodexAppTurnCarriesFailureAndAdmission(t *testing.T) {
	run := func(t *testing.T, msgs ...codexRPCMessage) ExecResult {
		t.Helper()
		var mu sync.Mutex
		active := &codexAppActiveTurn{orbitTurnID: "run", result: codexTurnResult{Status: stSucceeded, Subtype: "completed"}}
		var ended *codexTurnResult
		finalize := func(result codexTurnResult) {
			_, snapshot, ok := beginCodexAppTurnFinalize(&mu, &active)
			if !ok {
				return
			}
			result = mergeCodexChildResult(result, snapshot)
			ended = &result
		}
		for _, msg := range msgs {
			handleCodexAppNotification("thread-1", msg, func(string, map[string]interface{}) {}, &mu, &active, finalize, nil, nil, nil, nil)
		}
		if ended == nil {
			t.Fatal("the turn never ended")
		}
		return codexChildResult(*ended)
	}
	notification := func(method string, params map[string]interface{}) codexRPCMessage {
		raw, _ := json.Marshal(params)
		return codexRPCMessage{Method: method, Params: raw}
	}
	failedTurn := notification("turn/completed", map[string]interface{}{"threadId": "thread-1",
		"turn": map[string]interface{}{"id": "t1", "status": "failed"}})

	// The usage limit as 0.161 sent it: an error notification with codexErrorInfo, then the failed turn.
	limited := run(t,
		notification("error", map[string]interface{}{"threadId": "thread-1", "willRetry": false,
			"error": map[string]interface{}{"message": codexUsageLimit0161, "codexErrorInfo": "usageLimitExceeded"}}),
		failedTurn)
	if limited.Status != stFailed || limited.ErrorMsg != codexUsageLimit0161 {
		t.Fatalf("result = %+v", limited)
	}
	if limited.Failure == nil || limited.Failure.Kind != failureUsageLimit || limited.Failure.Until == "" || limited.Failure.Said != codexUsageLimit0161 {
		t.Fatalf("failure = %+v", limited.Failure)
	}
	if limited.Admission == nil || !*limited.Admission {
		t.Fatalf("admission = %v, want true", limited.Admission)
	}

	// A refused credential is classified on Codex's words, and shown as today's sign-in sentence.
	refused := run(t, notification("error", map[string]interface{}{"threadId": "thread-1",
		"error": map[string]interface{}{"message": realCodex401}}), failedTurn)
	if refused.ErrorMsg != "Failed to authenticate: "+realCodex401 || refused.Failure == nil || refused.Failure.Kind != failureCredentialRefused || refused.Failure.Said != realCodex401 {
		t.Fatalf("result = %+v / %+v", refused, refused.Failure)
	}

	// A turn that ran a command before it hit capacity was admitted: admission false.
	worked := run(t,
		notification("item/started", map[string]interface{}{"threadId": "thread-1",
			"item": map[string]interface{}{"type": "commandExecution", "id": "c1", "command": "ls"}}),
		notification("turn/completed", map[string]interface{}{"threadId": "thread-1",
			"turn": map[string]interface{}{"id": "t1", "status": "failed", "error": map[string]interface{}{"message": codexCapacityMessage}}}))
	if worked.Failure == nil || worked.Failure.Kind != failureCapacity || worked.Failure.Scope != failureScopeModel || worked.Admission == nil || *worked.Admission {
		t.Fatalf("failure = %+v, admission = %v", worked.Failure, worked.Admission)
	}

	// A turn that went well carries neither.
	ok := run(t, notification("turn/completed", map[string]interface{}{"threadId": "thread-1",
		"turn": map[string]interface{}{"id": "t1", "status": "completed"}}))
	if ok.Status != stSucceeded || ok.Failure != nil || ok.Admission != nil {
		t.Fatalf("result = %+v", ok)
	}
}
