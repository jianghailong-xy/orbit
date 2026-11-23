package main

import (
	"testing"
)

// claudeOAuthExpired is Claude Code's own sentence for a sign-in it could not refresh (quoted by @orbit/shared
// isAuthErrorText and by isAuthError, and by engineinstall_test.go as Claude's real message).
const claudeOAuthExpired = "Failed to authenticate: OAuth session expired and could not be refreshed"

// claudeFailureSamples is one recorded reply per row of claudeFailureRules.
var claudeFailureSamples = []failureSample{
	{
		// session.error of FAILED runs, `select distinct` (docs/quota-limit-retry-design.md); events.ts markers.
		where: "quota-limit-retry-design.md (session.error)", said: "You've hit your session limit · resets 6:20pm (Europe/Berlin)",
		kind: failureUsageLimit, text: "You've hit your session limit · resets 6:20pm (Europe/Berlin)",
	},
	{
		// Claude Code 2.1.312 and later (events.ts USAGE_LIMIT_ERROR_MARKERS).
		where: "events.ts USAGE_LIMIT_ERROR_MARKERS (2.1.312)", said: "You've hit your 5-hour limit · resets 1:30pm (America/Los_Angeles)",
		kind: failureUsageLimit,
	},
	{
		where: "quota-limit-retry-design.md (session.error)", said: "You've hit your weekly limit · resets Aug 3, 1pm (Europe/Berlin)",
		kind: failureUsageLimit,
	},
	{
		// Verbatim from FAILED sessions on 2026-11-13, all signed in (claude_test.go TestIsAPIErrorAndIsAuthError).
		where: "claude_test.go 2026-11-13 ECONNRESET",
		said:  "Failed to authenticate. API Error: 403 ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
		kind:  failureTransport,
	},
	{
		where: "claude_test.go 2026-11-13 Cloudflare", said: "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare",
		kind: failureTransport, text: "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare",
	},
	{
		where: "events.ts isAuthErrorText / claude.go isAuthError", said: claudeOAuthExpired,
		kind: failureCredentialRefused, text: claudeOAuthExpired,
	},
}

func classifyClaudeSample(s failureSample) engineFailure { return claudeTurnFailureOf(s.said) }

func TestClaudeFailureRulesFromRecordedReplies(t *testing.T) {
	assertEveryRuleSampled(t, claudeFailureRules, claudeFailureSamples, classifyClaudeSample)
	// The carve-out holds for any text isConnectionFailure calls the connection's, whatever its spelling.
	for _, text := range []string{
		"Failed to authenticate. api error: 403 attention required | cloudflare edge",
		"Failed to authenticate: read econnreset",
	} {
		if !isConnectionFailure(text) {
			t.Fatalf("%q is not a connection failure", text)
		}
		if got := claudeTurnFailureOf(text); got.Kind != failureTransport {
			t.Errorf("%q classified %q, want TRANSPORT", text, got.Kind)
		}
	}
	// The first text that classifies wins; a reply quoting a failure mid-sentence classifies nothing.
	if got := claudeTurnFailureOf("", claudeOAuthExpired); got.Kind != failureCredentialRefused {
		t.Fatalf("got %+v", got)
	}
	if got := claudeTurnFailureOf("The deploy log said Failed to authenticate, so I rotated the key."); got.Kind != "" {
		t.Fatalf("got %+v", got)
	}
}

func TestClaudeTurnOutputAdmission(t *testing.T) {
	assistant := func(blocks ...map[string]interface{}) map[string]interface{} {
		content := make([]interface{}, len(blocks))
		for i, b := range blocks {
			content[i] = b
		}
		return map[string]interface{}{"type": "assistant", "message": map[string]interface{}{"content": content}}
	}
	text := func(s string) map[string]interface{} { return map[string]interface{}{"type": "text", "text": s} }

	var only claudeTurnOutput
	only.observe(assistant(text(claudeOAuthExpired)))
	if got := only.admission(ExecResult{Usage: &TokenUsage{}}, claudeOAuthExpired); !*got {
		t.Fatal("the failure as the turn's one reply is an admission failure")
	}
	if got := only.admission(ExecResult{Usage: &TokenUsage{OutputTokens: 3}}, claudeOAuthExpired); *got {
		t.Fatal("a turn with billed tokens was admitted")
	}
	var tool claudeTurnOutput
	tool.observe(assistant(map[string]interface{}{"type": "tool_use", "id": "t", "name": "Bash"}))
	tool.observe(assistant(text(claudeOAuthExpired)))
	if got := tool.admission(ExecResult{}, claudeOAuthExpired); *got {
		t.Fatal("a turn that called a tool was admitted")
	}
	var replied claudeTurnOutput
	replied.observe(assistant(text("Looking at it.")))
	replied.observe(assistant(text(claudeOAuthExpired)))
	if got := replied.admission(ExecResult{}, claudeOAuthExpired); *got {
		t.Fatal("a turn that replied first was admitted")
	}
	var silent claudeTurnOutput
	silent.observe(map[string]interface{}{"type": "user"})
	if got := silent.admission(ExecResult{}, "API Error: 500"); !*got {
		t.Fatal("a turn that put out nothing is an admission failure")
	}
}
