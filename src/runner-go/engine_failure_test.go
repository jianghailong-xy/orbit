package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

// failureSample is one recorded error shape and what its engine's table says of it. where says where the sample
// was recorded; the per-engine tests keep one per rule (assertEveryRuleSampled).
type failureSample struct {
	where      string
	said, code string
	kind       string
	text       string // the sentence Orbit shows; "" leaves it unchecked
}

// assertEveryRuleSampled checks each sample against classify, and that every rule of rules is the first match of
// at least one sample: a rule with no recorded sample is a guess (§5.3).
func assertEveryRuleSampled(t *testing.T, rules []failureRule, samples []failureSample, classify func(failureSample) engineFailure) {
	t.Helper()
	covered := map[int]bool{}
	for _, sample := range samples {
		got := classify(sample)
		if got.Kind != sample.kind {
			t.Errorf("%s: %q classified %q, want %q", sample.where, sample.said, got.Kind, sample.kind)
		}
		if sample.text != "" && got.Text != sample.text {
			t.Errorf("%s: %q shown as %q, want today's %q", sample.where, sample.said, got.Text, sample.text)
		}
		for i, rule := range rules {
			if rule.matches(strings.TrimSpace(sample.said), sample.code) {
				covered[i] = true
				break
			}
		}
	}
	for i, rule := range rules {
		if !covered[i] {
			t.Errorf("rule %d (%+v) has no recorded sample", i, rule)
		}
	}
}

// The census (§5.3 item 3): every engine of AgentProvider has a table, read from the enum itself so an engine added
// there fails here until its table — empty, if nothing is mapped — exists.
func TestEngineFailureCensus(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "shared", "src", "enums.ts"))
	if err != nil {
		t.Fatal(err)
	}
	block := regexp.MustCompile(`(?s)export enum AgentProvider \{(.*?)\n\}`).FindSubmatch(source)
	if block == nil {
		t.Fatal("enums.ts has no AgentProvider enum")
	}
	var engines []string
	for _, m := range regexp.MustCompile(`(?m)^\s*[A-Z_]+\s*=\s*'([^']+)'`).FindAllSubmatch(block[1], -1) {
		engines = append(engines, string(m[1]))
	}
	if len(engines) < 7 {
		t.Fatalf("read %d engines from AgentProvider (%q): the census reads the enum wrong", len(engines), engines)
	}
	for _, engine := range engines {
		if _, ok := engineFailureRules[engine]; !ok {
			t.Errorf("engine %q of AgentProvider has no failure table: add one to engineFailureRules (an empty one says nothing is mapped)", engine)
		}
	}
	known := map[string]bool{}
	for _, engine := range engines {
		known[engine] = true
	}
	var names []string
	for engine := range engineFailureRules {
		names = append(names, engine)
	}
	sort.Strings(names)
	for _, engine := range names {
		if !known[engine] {
			t.Errorf("engineFailureRules has a table for %q, which AgentProvider does not name", engine)
		}
		for i, rule := range engineFailureRules[engine] {
			matchers := 0
			for _, m := range []string{rule.Equals, rule.Prefix, rule.Code} {
				if m != "" {
					matchers++
				}
			}
			if matchers != 1 {
				t.Errorf("%s rule %d has %d matchers, want exactly one: %+v", engine, i, matchers, rule)
			}
			if rule.AndContains != "" && rule.Prefix == "" {
				t.Errorf("%s rule %d narrows a matcher that is not a Prefix: %+v", engine, i, rule)
			}
			if !failureKinds[rule.Kind] {
				t.Errorf("%s rule %d has kind %q, which is not a RunFailureKind", engine, i, rule.Kind)
			}
			switch rule.Scope {
			case "", failureScopeModel, failureScopeRunner, failureScopeRequest:
			default:
				t.Errorf("%s rule %d has scope %q", engine, i, rule.Scope)
			}
		}
	}
}

func TestMatchFailureFirstRuleWinsAndUnknownStaysUnclassified(t *testing.T) {
	rules := []failureRule{
		{Prefix: "Error: Retriable", Kind: failureTransport},
		{Prefix: "Error: ", Kind: failureRequestRefused, Text: func(said string) string { return "shown: " + said }},
		{Code: "quota", Kind: failureUsageLimit},
	}
	if got := matchFailure(rules, "  Error: Retriable socket  ", ""); got.Kind != failureTransport || got.Said != "Error: Retriable socket" || got.Text != got.Said {
		t.Fatalf("got %+v", got)
	}
	if got := matchFailure(rules, "Error: x", ""); got.Kind != failureRequestRefused || got.Text != "shown: Error: x" {
		t.Fatalf("got %+v", got)
	}
	if got := matchFailure(rules, "whatever", "quota"); got.Kind != failureUsageLimit {
		t.Fatalf("got %+v", got)
	}
	// An empty code never matches a Code rule, and a sentence no rule names is unclassified, its words kept.
	if got := matchFailure([]failureRule{{Code: "x", Kind: failureCapacity}}, "billing failed", ""); got.Kind != "" || got.Text != "billing failed" || got.wire() != nil {
		t.Fatalf("got %+v", got)
	}
}

// §5.1 on the wire: failure and admission are left out when nil; admission false is sent; until goes only with
// USAGE_LIMIT and CAPACITY; said is cut to 300 characters.
func TestFailureAndAdmissionSerializeAsSpecified(t *testing.T) {
	encode := func(v interface{}) map[string]interface{} {
		t.Helper()
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		var out map[string]interface{}
		_ = json.Unmarshal(b, &out)
		return out
	}
	plain := encode(TurnCompleteRequest{TurnID: "t", Status: stFailed, Error: "boom"})
	if _, ok := plain["failure"]; ok {
		t.Fatalf("an unclassified failure was sent: %v", plain)
	}
	if _, ok := plain["admission"]; ok {
		t.Fatalf("an unmeasured admission was sent: %v", plain)
	}

	until := time.Date(2026, 8, 9, 13, 26, 0, 0, time.UTC)
	long := strings.Repeat("é", 400)
	req := TurnCompleteRequest{TurnID: "t", Status: stFailed, Error: "x"}.withFailure(
		engineFailure{Kind: failureUsageLimit, Until: until, Said: long, Text: "x"}, turnAdmission(true, nil, 0))
	got := encode(req)
	failure, _ := got["failure"].(map[string]interface{})
	if failure["kind"] != failureUsageLimit || failure["until"] != "2026-08-09T13:26:00Z" || failure["scope"] != nil {
		t.Fatalf("failure = %v", failure)
	}
	if said, _ := failure["said"].(string); len([]rune(said)) != failureSaidMax || !strings.HasPrefix(long, said) {
		t.Fatalf("said kept %d characters, want %d", len([]rune(said)), failureSaidMax)
	}
	if admission, ok := got["admission"]; !ok || admission != false {
		t.Fatalf("admission = %v (sent %v), want false sent", admission, ok)
	}

	// until is dropped for a kind that does not last until a time; scope is sent when set.
	access := encode(engineFailure{Kind: failureAccountAction, Scope: failureScopeModel, Until: until, Said: "s"}.wire())
	if access["until"] != nil || access["scope"] != failureScopeModel || access["kind"] != failureAccountAction {
		t.Fatalf("failure = %v", access)
	}

	// A turn that did not fail sends neither, whatever it was given.
	ok := encode(TurnCompleteRequest{TurnID: "t", Status: stSucceeded}.withFailure(
		engineFailure{Kind: failureTransport}, turnAdmission(false, nil, 0)))
	if ok["failure"] != nil || ok["admission"] != nil {
		t.Fatalf("a succeeded turn carried %v", ok)
	}

	// Finalize: the same two fields, the same rules.
	yes := true
	fin := encode(RunFinalizeRequest{Status: stFailed, Failure: &RunFailure{Kind: failureCapacity, Scope: failureScopeModel}, Admission: &yes})
	if f, _ := fin["failure"].(map[string]interface{}); f["kind"] != failureCapacity || fin["admission"] != true {
		t.Fatalf("finalize = %v", fin)
	}
	if bare := encode(RunFinalizeRequest{Status: stSucceeded}); bare["failure"] != nil || bare["admission"] != nil {
		t.Fatalf("finalize = %v", bare)
	}
}

func TestTurnAdmissionCountsBilledTokens(t *testing.T) {
	for _, c := range []struct {
		produced bool
		usage    *TokenUsage
		cost     float64
		want     bool
	}{
		{false, nil, 0, true},
		{false, &TokenUsage{}, 0, true},
		{true, nil, 0, false},
		{false, &TokenUsage{CacheReadInputTokens: 1}, 0, false},
		{false, nil, 0.01, false},
	} {
		if got := turnAdmission(c.produced, c.usage, c.cost); got == nil || *got != c.want {
			t.Errorf("turnAdmission(%v, %+v, %v) = %v, want %v", c.produced, c.usage, c.cost, got, c.want)
		}
	}
}

// Cross-version (§10, Mixed versions): an older server reads only `error`, so the sentence every rule shows must
// still satisfy today's markers where it did before — a spent quota opens with the quota's words, a refused
// credential still reads "Failed to authenticate", a connection failure never does, and no other kind starts to.
func TestEveryRuleTextKeepsTodaysServerMarkers(t *testing.T) {
	samples := map[string][]failureSample{
		providerCursor:      cursorFailureSamples,
		providerCodex:       codexFailureSamples,
		providerClaude:      claudeFailureSamples,
		providerKimi:        kimiFailureSamples,
		providerAntigravity: antigravityFailureSamples,
	}
	classify := map[string]func(failureSample) engineFailure{
		providerCursor:      classifyCursorSample,
		providerCodex:       classifyCodexSample,
		providerClaude:      classifyClaudeSample,
		providerKimi:        classifyKimiSample,
		providerAntigravity: classifyAntigravitySample,
	}
	for engine, list := range samples {
		for _, sample := range list {
			got := classify[engine](sample)
			usage, auth := isUsageLimitText(got.Text), isAuthError(got.Text)
			switch got.Kind {
			case failureUsageLimit:
				// Kimi's, Cursor's, Codex's and Claude's open with the words; agy's never did (it is a 429 sentence).
				if engine != providerAntigravity && !usage {
					t.Errorf("%s %s: %q no longer reads as a spent quota", engine, sample.where, got.Text)
				}
			case failureCredentialRefused:
				if !auth || !strings.HasPrefix(got.Text, "Failed to authenticate") {
					t.Errorf("%s %s: %q no longer reads as a sign-in failure", engine, sample.where, got.Text)
				}
			case failureCapacity:
				if !isCodexCapacityError(got.Text) {
					t.Errorf("%s %s: %q no longer reads as capacity", engine, sample.where, got.Text)
				}
			default:
				if usage || auth {
					t.Errorf("%s %s: %q (%s) now reads as a quota or a sign-in", engine, sample.where, got.Text, got.Kind)
				}
			}
			if got.Kind == failureTransport && isAuthError(got.Text) {
				t.Errorf("%s %s: a connection failure reads as a sign-in: %q", engine, sample.where, got.Text)
			}
		}
	}
}

// The kinds the runner sends are exactly @orbit/shared's RunFailureKind: a kind the server does not know is read as
// none, so a drift either way would silently drop a classification.
func TestEngineFailureKindsMatchSharedEnum(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "shared", "src", "runFailureKind.ts"))
	if err != nil {
		t.Fatal(err)
	}
	block := regexp.MustCompile(`(?s)export enum RunFailureKind \{(.*?)\n\}`).FindSubmatch(source)
	if block == nil {
		t.Fatal("runFailureKind.ts has no RunFailureKind enum")
	}
	shared := map[string]bool{}
	for _, m := range regexp.MustCompile(`(?m)^\s*[A-Z_]+\s*=\s*'([^']+)'`).FindAllSubmatch(block[1], -1) {
		shared[string(m[1])] = true
	}
	if len(shared) != len(failureKinds) {
		t.Fatalf("shared RunFailureKind has %d kinds, the runner %d", len(shared), len(failureKinds))
	}
	for kind := range failureKinds {
		if !shared[kind] {
			t.Errorf("the runner's kind %q is not a RunFailureKind", kind)
		}
	}
}
