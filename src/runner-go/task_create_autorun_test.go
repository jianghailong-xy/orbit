package main

import (
	"strings"
	"testing"
	"time"
)

func withAutoRunRequired(t *testing.T) {
	t.Helper()
	old := autoRunDeclarationRequired
	autoRunDeclarationRequired = true
	t.Cleanup(func() { autoRunDeclarationRequired = old })
}

func TestAutoRunDeclarationIsRequiredOfAnAgentCreate(t *testing.T) {
	withAutoRunRequired(t)
	for _, tc := range []struct {
		name string
		item map[string]interface{}
		ok   bool
	}{
		{"missing", map[string]interface{}{"title": "t"}, false},
		{"null", map[string]interface{}{"title": "t", "autoRunWhenReady": nil}, false},
		{"true", map[string]interface{}{"title": "t", "autoRunWhenReady": true}, true},
		{"false", map[string]interface{}{"title": "t", "autoRunWhenReady": false}, true},
	} {
		err := requireRunnerTaskAutoRunDeclaration(tc.item)
		if (err == nil) != tc.ok {
			t.Errorf("%s: err = %v, want ok = %v", tc.name, err, tc.ok)
		}
		if err != nil {
			for _, want := range []string{"autoRunWhenReady", "starts by itself", "stays recorded"} {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("%s: the refusal does not say %q: %v", tc.name, want, err)
				}
			}
		}
	}
}

func TestMCPTaskCreateRefusesAMissingAutoRunBeforeAnyRequest(t *testing.T) {
	withAutoRunRequired(t)
	s := &mcpServer{sessionID: "s1"}
	for name, args := range map[string]map[string]interface{}{
		"task_create": {"title": "t", "completionCriterion": "EVIDENCE_JUDGMENT"},
		"task_create_batch": {"tasks": []interface{}{
			map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT", "autoRunWhenReady": true},
			map[string]interface{}{"title": "b", "completionCriterion": "EVIDENCE_JUDGMENT"},
		}},
	} {
		result := s.runTool(name, args)
		text := resultText(result)
		if result["isError"] != true || !strings.Contains(text, "autoRunWhenReady is required") {
			t.Errorf("%s: want a refusal naming autoRunWhenReady, got %v", name, text)
		}
		if name == "task_create_batch" && !strings.Contains(text, "tasks[1]") {
			t.Errorf("the batch refusal does not name the item: %s", text)
		}
	}
}

func TestDerivedCreateKeys(t *testing.T) {
	var keys derivedCreateKeys
	t0 := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
	args := map[string]interface{}{"title": "t", "autoRunWhenReady": false}
	first := keys.derive("s1", "task_create", args, t0)
	if again := keys.derive("s1", "task_create", args, t0.Add(createKeyWindow-time.Second)); again != first {
		t.Errorf("a retry inside the window got a new key: %s then %s", first, again)
	}
	if later := keys.derive("s1", "task_create", args, t0.Add(createKeyWindow)); later == first {
		t.Errorf("a call after the window got the first key again: %s", later)
	}
	for name, other := range map[string]string{
		"arguments": keys.derive("s1", "task_create", map[string]interface{}{"title": "u", "autoRunWhenReady": false}, t0),
		"tool":      keys.derive("s1", "task_create_batch", args, t0),
		"session":   keys.derive("s2", "task_create", args, t0),
	} {
		if other == first {
			t.Errorf("a different %s gave the same key %s", name, first)
		}
	}
	if len(first) > 200 {
		t.Errorf("the key is %d characters; the tools take at most 200", len(first))
	}
}

func TestMCPDerivesAKeyOnlyWhenTheCallerGaveNone(t *testing.T) {
	s := &mcpServer{sessionID: "s1"}
	args := map[string]interface{}{"title": "t"}
	got := s.withDerivedCreateKey("task_create", args)
	if key := getString(got, "idempotencyKey"); !strings.HasPrefix(key, "auto-") {
		t.Errorf("no key derived: %v", got)
	}
	if _, mutated := args["idempotencyKey"]; mutated {
		t.Error("the caller's arguments were changed")
	}
	own := map[string]interface{}{"title": "t", "idempotencyKey": "mine"}
	if key := getString(s.withDerivedCreateKey("task_create", own), "idempotencyKey"); key != "mine" {
		t.Errorf("a key the caller gave was replaced by %q", key)
	}
	if _, ok := s.withDerivedCreateKey("task_create_batch", map[string]interface{}{"dryRun": true})["idempotencyKey"]; ok {
		t.Error("a dry run was given a key")
	}
	if _, ok := s.withDerivedCreateKey("task_update", args)["idempotencyKey"]; ok {
		t.Error("a tool that is not a create was given a key")
	}
}

func TestPrimerNoLongerCarriesTheSentencesTheMechanismsReplace(t *testing.T) {
	for _, gone := range []string{"autoRunWhenReady defaults to true", "Key task_create"} {
		if strings.Contains(agentPrimer, gone) {
			t.Errorf("the primer still says %q", gone)
		}
	}
}

func TestAKeylessCreateAgainstTheServerFilesOnceInsideTheWindowAndAgainAfterIt(t *testing.T) {
	server := &mcpServer{sessionID: "s1"}
	clock := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
	old := createKeyNow
	createKeyNow = func() time.Time { return clock }
	t.Cleanup(func() { createKeyNow = old })
	args := map[string]interface{}{"title": "t", "autoRunWhenReady": false}
	key := func() string { return getString(server.withDerivedCreateKey("task_create", args), "idempotencyKey") }
	first := key()
	clock = clock.Add(createKeyWindow - time.Minute)
	if got := key(); got != first {
		t.Errorf("a retry inside the window was keyed %s, first %s", got, first)
	}
	clock = clock.Add(2 * time.Minute)
	if got := key(); got == first {
		t.Errorf("a deliberate re-create after the window kept the key %s", first)
	}
}
