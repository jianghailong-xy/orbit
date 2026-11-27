package main

import (
	"testing"
)

// cursorFailureSamples is one recorded sentence per row of cursorFailureRules, plus the unclassified "Error: …" arm.
var cursorFailureSamples = []failureSample{
	{
		// Measured: P0a's quota-exhausted incident (docs/cursor-runtime-contract.md §12, "额度用尽"), replayed by
		// cursor_acp_lifecycle_test.go usage-limit from the background-shell-and-commit recording.
		where: "cursor-runtime-contract.md §12 quota-exhausted", said: "Upgrade your plan to continue",
		kind: failureUsageLimit, text: `You've hit your usage limit on Cursor. Cursor said: "Upgrade your plan to continue."`,
	},
	{
		// The pinned build's fixed copy (contract §12 "轮中认证失效", source A@15087), the sentence
		// cursor_acp_lifecycle_test.go turn-failure-sentences already pins.
		where: "cursor-runtime-contract.md §12 mid-turn sign-in (A@15087)", said: "Please sign in to continue",
		kind: failureCredentialRefused,
		text: `Failed to authenticate: Cursor said: "Please sign in to continue." Sign in to Cursor CLI again, or save a new Cursor API key, then send the message again.`,
	},
	{
		// Contract §12 (source A@15425); the full sentence is cursor_acp_lifecycle_test.go turn-failure-sentences'.
		where: "cursor-runtime-contract.md §12 [unauthenticated] (A@15425)",
		said:  "Error: [unauthenticated] Backend rejected authentication. Verify this is a User API Key for the same endpoint/environment, then rerun with --debug for request-level auth logs.",
		kind:  failureCredentialRefused,
		text:  "Failed to authenticate: Cursor rejected this session's credential ([unauthenticated] Backend rejected authentication. Verify this is a User API Key for the same endpoint/environment, then rerun with --debug for request-level auth logs.)",
	},
	{
		// Measured: the provider-refusal-after-crash incident (contract §12 "模型提供方拒答").
		where: "cursor-runtime-contract.md §12 provider-refusal-after-crash",
		said:  "Request blocked We are unable to complete this request because it was blocked under the model provider's usage guidelines. Try a less sensitive prompt.",
		kind:  failureRequestRefused,
		text:  "Cursor's model provider refused this request: Request blocked We are unable to complete this request because it was blocked under the model provider's usage guidelines. Try a less sensitive prompt.",
	},
	{
		// The incident: five refused runs from 2026-11-22 17:19 (docs/routing-account-health-design.md §1).
		where: "routing-account-health-design.md §1 incident", said: "Add a payment method to continue",
		kind: failureAccountAction, text: `Cursor said: "Add a payment method to continue." The Cursor account needs this before the session can go on.`,
	},
	{
		// The pinned build's prompt-handler copy (6136.index.js@15087), pinned by cursor_acp_lifecycle_test.go
		// turn-failure-sentences; not measured on an account.
		where: "cursor_acp_lifecycle_test.go turn-failure-sentences (6136.index.js@15087)", said: "Check your settings to continue",
		kind: failureAccountAction, text: `Cursor said: "Check your settings to continue." The Cursor account needs this before the session can go on.`,
	},
	{
		// Measured: p0c/network-drop-mid-turn (contract §12 "轮中断网"), which recommends this row.
		where: "cursor-runtime-contract.md §12 p0c/network-drop-mid-turn",
		said:  "Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)",
		kind:  failureTransport,
		text:  "Cursor CLI failed this turn: Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)",
	},
	{
		// The table's default arm: any other "Error: …" fails the turn, unclassified (cursor_acp_lifecycle_test.go).
		where: "cursor_acp_lifecycle_test.go turn-failure-sentences", said: "Error: ConnectError: [unavailable] read ECONNRESET",
		kind: "", text: "Cursor CLI failed this turn: Error: ConnectError: [unavailable] read ECONNRESET",
	},
}

func classifyCursorSample(s failureSample) engineFailure { return cursorTurnFailureOf("\n\n" + s.said) }

func TestCursorFailureRulesFromRecordedSentences(t *testing.T) {
	assertEveryRuleSampled(t, cursorFailureRules, cursorFailureSamples, classifyCursorSample)
	// Every sentence is still what cursorTurnFailure reports, and nothing else is a failure.
	for _, s := range cursorFailureSamples {
		if got := cursorTurnFailure("\n\n" + s.said); got != s.text {
			t.Errorf("cursorTurnFailure(%q) = %q, want %q", s.said, got, s.text)
		}
	}
	for _, chunk := range []string{"Upgrade your plan to continue", "\n\nI added a payment method to continue.", "\n\nRequest blocked by the firewall"} {
		if got := cursorTurnFailureOf(chunk); got != (engineFailure{}) {
			t.Errorf("%q is the agent's text, got %+v", chunk, got)
		}
	}
}

// settle carries the classification and the admission of a failed turn: true for the incident's shape — the
// sentence and nothing else — false once the turn said anything, nil on a turn that did not fail.
func TestCursorSettleCarriesFailureAndAdmission(t *testing.T) {
	settle := func(t *testing.T, chunks ...string) TurnCompleteRequest {
		t.Helper()
		var events cursorEvents
		m := newCursorEventMapper(events.emitFor)
		m.bind("s")
		if err := m.begin("turn"); err != nil {
			t.Fatal(err)
		}
		for _, text := range chunks {
			m.update(map[string]interface{}{"sessionId": "s", "update": map[string]interface{}{
				"sessionUpdate": "agent_message_chunk", "content": map[string]interface{}{"type": "text", "text": text}}})
		}
		req, ok := m.settle("turn", map[string]interface{}{"stopReason": "end_turn"}, nil)
		if !ok {
			t.Fatal("the turn did not settle")
		}
		return req
	}

	refused := settle(t, "\n\nAdd a payment method to continue")
	if refused.Status != stFailed || refused.Error != `Cursor said: "Add a payment method to continue." The Cursor account needs this before the session can go on.` {
		t.Fatalf("settled %+v", refused)
	}
	if refused.Failure == nil || refused.Failure.Kind != failureAccountAction || refused.Failure.Said != "Add a payment method to continue" {
		t.Fatalf("failure = %+v", refused.Failure)
	}
	if refused.Admission == nil || !*refused.Admission {
		t.Fatalf("admission = %v, want true: nothing came before the sentence", refused.Admission)
	}

	worked := settle(t, "Working", " on it.", "\n\nError: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)")
	if worked.Failure == nil || worked.Failure.Kind != failureTransport || worked.Admission == nil || *worked.Admission {
		t.Fatalf("settled %+v / failure %+v / admission %v, want TRANSPORT and admission false", worked, worked.Failure, worked.Admission)
	}

	unknown := settle(t, "\n\nError: ConnectError: [unavailable] read ECONNRESET")
	if unknown.Status != stFailed || unknown.Failure != nil || unknown.Admission == nil || !*unknown.Admission {
		t.Fatalf("an unclassified failure settled %+v / %+v / %v, want no failure and admission true", unknown, unknown.Failure, unknown.Admission)
	}

	ok := settle(t, "All done.")
	if ok.Status != stSucceeded || ok.Failure != nil || ok.Admission != nil {
		t.Fatalf("a turn that went well carried %+v / %v", ok.Failure, ok.Admission)
	}
}
