package main

import (
	"strings"
	"time"
	"unicode/utf8"
)

// The failure kinds of docs/routing-account-health-design.md §4 (RunFailureKind in @orbit/shared). A kind is a claim
// the provider made, read off an error shape an adapter has been shown; the zero kind is "not classified".
const (
	failureUsageLimit        = "USAGE_LIMIT"
	failureCapacity          = "CAPACITY"
	failureAccountAction     = "ACCOUNT_ACTION_REQUIRED"
	failureCredentialRefused = "CREDENTIAL_REFUSED"
	failureAccessDenied      = "ACCESS_DENIED"
	failureTransport         = "TRANSPORT"
	failureRequestRefused    = "REQUEST_REFUSED"
)

// failureKinds is every kind the wire knows.
var failureKinds = map[string]bool{
	failureUsageLimit: true, failureCapacity: true, failureAccountAction: true, failureCredentialRefused: true,
	failureAccessDenied: true, failureTransport: true, failureRequestRefused: true,
}

// The scopes of a kind (§4); "" is the account.
const (
	failureScopeModel   = "model"
	failureScopeRunner  = "runner"
	failureScopeRequest = "request"
)

// failureSaidMax is how much of the provider's words goes on the wire (§5.1).
const failureSaidMax = 300

// engineFailure is a turn failure as an adapter classified it (§5.3). The zero Kind is "not classified".
type engineFailure struct {
	Kind  string    // failureUsageLimit, failureAccountAction, … ; "" when unknown
	Scope string    // "" means account
	Until time.Time // zero when the provider named none
	Said  string    // the provider's words, unedited
	Text  string    // the sentence Orbit shows, as today
}

// failureRule matches one error shape of one engine. Exactly one of Equals, Prefix and Code is set; AndContains
// narrows a Prefix to the sentences that also contain it.
type failureRule struct {
	Equals      string // the whole sentence
	Prefix      string
	AndContains string
	Code        string // an error name, status or code the engine reports as data
	Kind        string
	Scope       string
	Text        func(said string) string // the sentence Orbit shows; nil keeps the provider's words
}

func (r failureRule) matches(said, code string) bool {
	switch {
	case r.Equals != "":
		return said == r.Equals
	case r.Prefix != "":
		return strings.HasPrefix(said, r.Prefix) &&
			(r.AndContains == "" || strings.Contains(said, r.AndContains))
	case r.Code != "":
		return code != "" && code == r.Code
	}
	return false
}

// matchFailure is the first rule of rules that matches the provider's words or code, as the failure it names;
// unclassified, with said as its Text, when none does. said is matched trimmed.
func matchFailure(rules []failureRule, said, code string) engineFailure {
	said = strings.TrimSpace(said)
	for _, rule := range rules {
		if !rule.matches(said, code) {
			continue
		}
		text := said
		if rule.Text != nil {
			text = rule.Text(said)
		}
		return engineFailure{Kind: rule.Kind, Scope: rule.Scope, Said: said, Text: text}
	}
	return engineFailure{Text: said}
}

// engineFailureRules is each engine's table, by AgentProvider. An empty table is the explicit statement "nothing
// mapped; the breaker covers it" (§5.3); an engine with no entry fails TestEngineFailureCensus.
var engineFailureRules = map[string][]failureRule{
	providerClaude:      claudeFailureRules,
	providerCodex:       codexFailureRules,
	providerKimi:        kimiFailureRules,
	providerAntigravity: antigravityFailureRules,
	providerCursor:      cursorFailureRules,
	// Nothing recorded yet for these: every failure stays unclassified.
	providerOpenCode: {},
	providerDsh:      {},
}

// RunFailure is engineFailure on the wire (`failure` on /turn-complete, /finalize and the SubAgent fallback ask).
type RunFailure struct {
	Kind  string `json:"kind"`
	Scope string `json:"scope,omitempty"`
	Until string `json:"until,omitempty"`
	Said  string `json:"said,omitempty"`
}

// wire is the failure as it is sent: nil when it is not classified. until goes only with the two kinds that last
// until a time, and the provider's words are cut to failureSaidMax characters.
func (f engineFailure) wire() *RunFailure {
	if f.Kind == "" {
		return nil
	}
	out := &RunFailure{Kind: f.Kind, Scope: f.Scope, Said: clipRunes(f.Said, failureSaidMax)}
	if !f.Until.IsZero() && (f.Kind == failureUsageLimit || f.Kind == failureCapacity) {
		out.Until = f.Until.UTC().Format(time.RFC3339)
	}
	return out
}

// clipRunes is s cut to at most max characters, never inside one.
func clipRunes(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	runes := []rune(s)
	return string(runes[:max])
}

// turnAdmission is §5.2's measurement of a failed turn: true when the engine produced nothing in it — no assistant
// text but the failure itself, no tool call, no billed token. Always a pointer: false is sent, not left out.
func turnAdmission(produced bool, usage *TokenUsage, costUsd float64) *bool {
	admission := !produced && costUsd == 0 && !usage.billed()
	return &admission
}

// billed reports a usage that counts any token.
func (u *TokenUsage) billed() bool {
	return u != nil && u.InputTokens+u.OutputTokens+u.CacheCreationInputTokens+u.CacheReadInputTokens > 0
}

// withFailure is req carrying what its turn failed with and whether the engine produced anything first. Both go
// only on a FAILED turn; any other end sends neither.
func (req TurnCompleteRequest) withFailure(failure engineFailure, admission *bool) TurnCompleteRequest {
	if req.Status != stFailed {
		return req
	}
	req.Failure, req.Admission = failure.wire(), admission
	return req
}
