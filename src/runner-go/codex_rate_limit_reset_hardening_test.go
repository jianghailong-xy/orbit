package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The hardening of the reset step (docs/codex-rate-limit-reset-runbook.md), against the consume tests' fake
// app-server and control plane (codex_rate_limit_reset_consume_test.go): the two rules that keep a consume call
// from landing where its operation cannot account for it, and the telemetry lines a step writes. Nothing here
// reaches a real Codex account or spends a real credit.

// Once a call of a claim went out it may have spent a credit, whatever came back. A later attempt of that claim
// that cannot call — another account, a sign-out, a CLI without reset credits — must not report
// CONSUME_NOT_CALLED: the control plane would settle NOT_ATTEMPTED ("no credit was used") on the word of the
// claim that did call. The step ends unreported and the claim stays one that may have called, which settles
// UNRESOLVED. Paired: the same change before any call is reported, and settles NOT_ATTEMPTED.
func TestCodexResetConsumeNeverReportsNotCalledOnceACallWentOut(t *testing.T) {
	consume := codexRateLimitResetConsumeMethod
	other := codexResetTestOtherAccount
	for _, tc := range []struct {
		name   string
		change func(*codexResetProviderState)
		code   string
	}{
		{name: "another account signed in", change: func(s *codexResetProviderState) { s.AccountID = &other }, code: "ACCOUNT_MISMATCH"},
		{name: "signed out", change: func(s *codexResetProviderState) { s.Account = nil }, code: "UNSUPPORTED_AUTH"},
		{name: "a CLI without reset credits", change: func(s *codexResetProviderState) { s.NoResetCredits = true }, code: "PROVIDER_UNSUPPORTED"},
	} {
		t.Run(tc.name+" after a call timed out", func(t *testing.T) {
			h := newCodexResetHarness(t, codexResetSignedIn(2, true))
			h.provider(func(s *codexResetProviderState) {
				s.Faults = []codexResetProviderFault{{Method: consume, Do: "spendThenHang"}}
			})
			retrying := h.cp.stopAt("CONSUME_RETRYING", true)
			p := h.process(func(c *codexResetConsumer) { c.consumeTimeout = 2 * time.Second })
			logs := captureRunnerStdout(t, func() {
				p.heartbeat()
				retrying.await(t)
				h.provider(tc.change)
				close(retrying.release)
				p.finish()
			})

			events := h.events()
			codexResetRequireSequence(t, events, codexResetSteps(
				"deliver CONSUME/1", codexResetReadRequests, "app "+consume,
				"CONSUME_RETRYING/PROVIDER_TIMEOUT -> APPLIED CONSUMING RETRY_CONSUME (held)",
				codexResetReadRequests,
			))
			if calls := h.requireOnlyThePersistedKey(events); calls != 1 {
				t.Fatalf("%d consume calls, want the one that timed out", calls)
			}
			if provider := h.provider(nil); provider.AvailableCount != 1 {
				t.Fatalf("the provider holds %d credits, want 1: the call that timed out spent one", provider.AvailableCount)
			}
			op := h.cp.operation()
			if op.status() != "CONSUMING" || op.ClaimsWithUnknownCall != 1 || op.FailureCode != "" {
				t.Fatalf("the operation is %+v (%s); want it still CONSUMING with the claim that called unaccounted for, "+
					"so that it can only settle UNRESOLVED", op, op.status())
			}
			stopped := codexResetLogLineFor(t, logs, "consume", "stopped")
			if stopped["reason"] != "not_called_after_a_call" || stopped["code"] != tc.code || stopped["operationId"] != op.ID {
				t.Fatalf("the step's stop was logged as %v, want reason not_called_after_a_call and code %s for %s", stopped, tc.code, op.ID)
			}
		})
	}

	t.Run("paired: the same change before any call is reported", func(t *testing.T) {
		h := newCodexResetHarness(t, codexResetSignedIn(2, true))
		h.provider(func(s *codexResetProviderState) { s.AccountID = &other })
		p := h.process()
		p.heartbeat()
		p.finish()
		results := h.results(h.events())
		if len(results) != 1 || results[0].Kind != "CONSUME_NOT_CALLED" || results[0].Code != "ACCOUNT_MISMATCH" {
			t.Fatalf("results %+v, want one CONSUME_NOT_CALLED / ACCOUNT_MISMATCH", results)
		}
		if status := h.cp.operation().status(); status != "NOT_ATTEMPTED" {
			t.Fatalf("the operation ended %s, want NOT_ATTEMPTED", status)
		}
	})
}

// A consume call starts only while the claim's latest delivery is younger than callFreshness. An attempt past it
// reads, calls nothing and reports nothing until the next heartbeat delivers the claim again; a process whose
// claim is no longer delivered (taken over, settled, or its process draining) stops without calling again, so a
// stale process never calls consume after its successor's outcome was confirmed.
func TestCodexResetConsumeCallsOnlyWhileItsClaimIsDelivered(t *testing.T) {
	consume := "app " + codexRateLimitResetConsumeMethod

	t.Run("an attempt past the freshness bound waits for the next delivery, then calls", func(t *testing.T) {
		h := newCodexResetHarness(t, codexResetSignedIn(2, true))
		h.provider(func(s *codexResetProviderState) {
			s.Faults = []codexResetProviderFault{{Method: codexRateLimitResetConsumeMethod, Do: "error"}}
		})
		retrying := h.cp.stopAt("CONSUME_RETRYING", true)
		p := h.process()
		var awaited atomic.Int64
		p.relay.awaiting = func(codexResetClaim) {
			awaited.Add(1)
			p.heartbeat()
		}
		p.heartbeat()
		retrying.await(t)
		h.clock.advance(codexResetCallFreshness)
		close(retrying.release)
		p.finish()

		codexResetRequireSequence(t, h.events(), codexResetSteps(
			"deliver CONSUME/1", codexResetReadRequests, consume,
			"CONSUME_RETRYING/PROVIDER_ERROR -> APPLIED CONSUMING RETRY_CONSUME (held)",
			codexResetReadRequests, "deliver CONSUME/1",
			codexResetReadRequests, consume, "CONSUME_OUTCOME/reset -> APPLIED REFRESHING REFRESH",
			codexResetReadRequests, "REFRESHED -> APPLIED SUCCEEDED STOP",
		))
		if awaited.Load() != 1 {
			t.Fatalf("the step waited for a delivery %d times, want once", awaited.Load())
		}
	})

	t.Run("a process whose claim was taken over never calls after its successor's outcome", func(t *testing.T) {
		h := newCodexResetHarness(t, codexResetSignedIn(2, true))
		h.provider(func(s *codexResetProviderState) {
			s.Faults = []codexResetProviderFault{{Method: codexRateLimitResetConsumeMethod, Do: "error"}}
		})
		retrying := h.cp.stopAt("CONSUME_RETRYING", true)
		old := h.process()
		old.relay.awaiting = func(codexResetClaim) {
			// The old process's heartbeat is handed nothing now, and no later one will be either.
			old.heartbeat()
			h.clock.advance(codexResetReceiptWindow)
		}
		var logs string
		logs = captureRunnerStdout(t, func() {
			old.heartbeat()
			retrying.await(t)

			// The old process stops heartbeating long enough for its claim to be taken over, and its successor
			// consumes and confirms under the same key.
			h.clock.advance(h.cp.takeover + time.Second)
			successor := h.process()
			successor.heartbeat()
			successor.finish()
			h.mark("successor confirmed")

			close(retrying.release)
			old.finish()
		})

		events := h.events()
		h.requireOnlyThePersistedKey(events)
		for _, step := range codexResetSequence(codexResetAfter(events, "successor confirmed")) {
			if step == consume {
				t.Fatalf("a consume call after the successor's outcome was confirmed:\n%s", strings.Join(codexResetSequence(events), "\n"))
			}
		}
		if provider := h.provider(nil); provider.AvailableCount != 1 || len(provider.Redeemed) != 1 {
			t.Fatalf("the provider holds %d credits and redeemed %v, want exactly one spent", provider.AvailableCount, provider.Redeemed)
		}
		if op := h.cp.operation(); op.status() != "SUCCEEDED" || op.ClaimGeneration != 2 {
			t.Fatalf("the operation ended %+v (%s), want SUCCEEDED by the successor's claim", op, op.status())
		}
		if stopped := codexResetLogLineFor(t, logs, "consume", "stopped"); stopped["reason"] != "claim_not_delivered" ||
			stopped["claimGeneration"] != float64(1) {
			t.Fatalf("the old process's stop was logged as %v, want reason claim_not_delivered for claim 1", stopped)
		}
	})
}

// The call freshness bound is what keeps a call inside the claim's lease: started inside it, a call ends before a
// claim renewed at the delivery's heartbeat can be taken over.
func TestCodexResetCallFreshnessEndsCallsInsideTheTakeoverWindow(t *testing.T) {
	takeover := time.Duration(loadCodexResetContract(t).Timing["claimTakeoverAfterMs"]) * time.Millisecond
	if slack := takeover - codexResetCallFreshness - codexResetConsumeTimeout; slack < 10*time.Second {
		t.Fatalf("a call started %v after its delivery and running its full %v ends %v before a takeover at %v; want at least 10s",
			codexResetCallFreshness, codexResetConsumeTimeout, slack, takeover)
	}
	if codexResetCallFreshness > codexRateLimitResetCommandFreshness {
		t.Fatalf("the call freshness %v is looser than the contract's command freshness %v", codexResetCallFreshness, codexRateLimitResetCommandFreshness)
	}
}

// A line names the operation, the process and the protocol's own words, and nothing else: a value outside its
// field's vocabulary, or containing the key it is told to hide, is "[redacted]".
func TestCodexResetLogLinesCarryTheOperationAndNothingSecret(t *testing.T) {
	const key = "3d4e5f60-7182-4a93-8b04-c1d2e3f4a5b6"
	const operation = "018f6d2a-7c3e-7a41-9b2d-5e6f7a8b9c0d"
	const leaseOwner = "6f1c2b7e-4d3a-4b8e-9c21-7a5e0d3f9b12"

	var good map[string]interface{}
	line := codexResetLogLine(codexResetLogEvent{
		Stage: "consume", Event: "called", OperationID: operation, Process: codexResetProcessTag(leaseOwner),
		Phase: "CONSUME", ClaimGeneration: 2, Attempt: 3, Kind: "CONSUME_OUTCOME", Outcome: "reset", Account: "match",
	}, key)
	if err := json.Unmarshal([]byte(line), &good); err != nil {
		t.Fatalf("%v: %s", err, line)
	}
	want := map[string]interface{}{
		"stage": "consume", "event": "called", "operationId": operation, "process": "6f1c2b7e", "phase": "CONSUME",
		"claimGeneration": float64(2), "attempt": float64(3), "kind": "CONSUME_OUTCOME", "outcome": "reset", "account": "match",
	}
	if fmt.Sprint(good) != fmt.Sprint(want) {
		t.Fatalf("line %s, want %v", line, want)
	}

	secrets := []string{key, codexResetTestAccountID, codexResetTestEmail, "sk-live-orbit-test-token", "runner-token-orbit-test"}
	bad := codexResetLogLine(codexResetLogEvent{
		Stage: "consume", Event: "Bearer sk-live-orbit-test-token", OperationID: key, Process: codexResetTestAccountID,
		Phase: "CONSUME ", Kind: "consume", Outcome: "reset\n{\"forged\":true}", Code: "orbit-test-secret",
		Disposition: "OK", Status: "SUCCEEDED", Next: codexResetTestEmail, Account: codexResetTestEmail,
		Reason: "token=runner-token-orbit-test", Error: "dial tcp 10.0.0.1:443: " + key,
	}, key)
	for _, secret := range secrets {
		if strings.Contains(bad, secret) {
			t.Fatalf("%q reached the line %s", secret, bad)
		}
	}
	var redacted map[string]interface{}
	if err := json.Unmarshal([]byte(bad), &redacted); err != nil {
		t.Fatalf("%v: %s", err, bad)
	}
	for field, value := range redacted {
		switch field {
		case "stage", "status":
			continue
		}
		if value != codexResetLogRedacted {
			t.Fatalf("field %s kept %v in %s", field, value, bad)
		}
	}
	// A value that is fine anywhere else is redacted when it holds the key.
	if hidden := codexResetLogLine(codexResetLogEvent{Stage: "delivery", Event: "started", OperationID: key}, key); strings.Contains(hidden, key) {
		t.Fatalf("the key reached a line as an operation id: %s", hidden)
	}

	// An error is named by its kind: a transport error's text carries the response body.
	body := `{"code":"STALE_CLAIM","echo":"` + key + `"}`
	for err, class := range map[error]string{
		&transportHTTPError{method: "POST", path: codexResetResultPath, statusCode: 502, body: body}: "http_502",
		&codexResetResultRefused{code: "STALE_CLAIM"}:                                                "refused",
		fmt.Errorf("post: %w", errors.New("connection reset by "+key)):                               "transport",
	} {
		if got := codexResetErrorClass(err); got != class {
			t.Fatalf("%v is classed %q, want %q", err, got, class)
		}
	}
}

// A whole step on one process writes the operation's history under its operationId, stage by stage, and no line
// carries the key, the account id, the email, the runner token or a runner environment value.
func TestCodexResetStepLogsItsStagesUnderTheOperation(t *testing.T) {
	h := newCodexResetHarness(t, codexResetSignedIn(2, true))
	secret := "orbit-test-secret-runner-environment"
	t.Setenv("ORBIT_TEST_RESET_ENV_SENTINEL", secret)
	h.cp.loseReceipts("CONSUME_OUTCOME", 1)
	p := h.process()
	logs := captureRunnerStdout(t, func() {
		p.heartbeat()
		p.finish()
	})
	op := h.cp.operation()
	if op.status() != "SUCCEEDED" {
		t.Fatalf("the operation ended %s", op.status())
	}
	for _, text := range []string{op.ProviderIdempotencyKey, codexResetTestAccountID, codexResetTestEmail, "runner-token", secret} {
		if strings.Contains(logs, text) {
			t.Fatalf("%q reached the runner's log:\n%s", text, logs)
		}
	}
	var history []string
	for _, line := range codexResetLogLines(t, logs) {
		if line["operationId"] != op.ID {
			t.Fatalf("a reset line of this step names another operation: %v", line)
		}
		history = append(history, fmt.Sprintf("%v/%v", line["stage"], line["event"]))
	}
	want := []string{
		"delivery/started", "consume/calling", "consume/called",
		"receipt/resending", "receipt/received",
		"refresh/read", "receipt/received",
	}
	if strings.Join(history, " ") != strings.Join(want, " ") {
		t.Fatalf("the step logged %v, want %v", history, want)
	}
}

// codexResetLogLines are the `codex-reset` lines of a captured runner log, decoded.
func codexResetLogLines(t *testing.T, logs string) []map[string]interface{} {
	t.Helper()
	var out []map[string]interface{}
	for _, text := range strings.Split(logs, "\n") {
		at := strings.Index(text, "] codex-reset ")
		if at < 0 {
			continue
		}
		var line map[string]interface{}
		if err := json.Unmarshal([]byte(text[at+len("] codex-reset "):]), &line); err != nil {
			t.Fatalf("a reset line is not JSON: %v\n%s", err, text)
		}
		out = append(out, line)
	}
	return out
}

// codexResetLogLineFor is the last reset line of stage and event in a captured log.
func codexResetLogLineFor(t *testing.T, logs, stage, event string) map[string]interface{} {
	t.Helper()
	var found map[string]interface{}
	for _, line := range codexResetLogLines(t, logs) {
		if line["stage"] == stage && line["event"] == event {
			found = line
		}
	}
	if found == nil {
		t.Fatalf("no %s/%s line in:\n%s", stage, event, logs)
	}
	return found
}
