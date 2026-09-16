package main

import (
	"strings"
	"testing"
)

// The two facts about the VERIFICATION shape that a caller can only learn from the contract,
// because nothing in a write that looks like it worked says otherwise:
//
//   - a row whose policy is VERIFICATION_PASSED has no work of its own, so it is a pure gate: a
//     manual execute is refused with 409 and auto-dispatch passes over it;
//   - nothing on the server files its verifier, so the check has to arrive in the SAME call — as
//     `verification` beside a single create, or as `verifiesRef` on a batch item.
//
// Both halves are pinned by the words that carry the meaning, not by the sentence that spells it,
// so rewording is allowed and losing either half is not.
func TestTaskCreateCompletionCriterionNamesThePureGateAndTheMissingVerifier(t *testing.T) {
	description := contractText(taskCreateCriterionDescription(t))

	for _, meaning := range []struct {
		what  string
		words []string
	}{
		{"the pure gate is not dispatchable", []string{"pure gate", "not dispatchable", "409", "auto-dispatch"}},
		{"the verifier is not filed for the caller", []string{"never files", "same call", "verification", "verifiesRef"}},
	} {
		for _, word := range meaning.words {
			if !strings.Contains(description, contractText(word)) {
				t.Errorf("task_create completionCriterion does not say %s: missing %q", meaning.what, word)
			}
		}
	}
}

// The same contract is restated wherever a caller chooses a criterion, and each surface names the
// pairing field it can actually carry. A surface that keeps only one half tells an agent it has
// paired a subject when it has not, which is the whole failure this wording exists to prevent.
func TestTaskCreateBatchAndTheCLIStateTheSameTwoFacts(t *testing.T) {
	tools := toolDescriptors(false, false)
	surfaces := []struct {
		label string
		text  string
		words []string
	}{
		{"MCP task_create", mcpToolDescription(tools, "task_create"),
			[]string{"pure gate", "not dispatchable", "409", "verification"}},
		{"MCP task_create_batch", mcpToolDescription(tools, "task_create_batch"),
			[]string{"pure gate", "not dispatchable", "409", "verifiesRef"}},
		{"MCP batch item verifiesRef", batchVerifiesRefDescription(t),
			[]string{"never creates", "same call", "409"}},
		{"CLI task create help", taskActionHelp["create"],
			[]string{"pure gate", "not dispatchable", "409", "same call", "verification", "verifiesRef"}},
		{"CLI task create-batch help", taskActionHelp["create-batch"],
			[]string{"pure gate", "not dispatchable", "409", "verifiesRef"}},
	}
	for _, surface := range surfaces {
		if surface.text == "" {
			t.Errorf("%s: no help or description text to check", surface.label)
			continue
		}
		text := contractText(surface.text)
		for _, word := range surface.words {
			if !strings.Contains(text, contractText(word)) {
				t.Errorf("%s does not carry the pairing contract: missing %q", surface.label, word)
			}
		}
	}
}

// contractText flattens a description or a help text so a word can be looked for across the line
// wrapping the long literals are written with, and case-insensitively so camelCase field names
// are matched by the words that carry them.
func contractText(text string) string {
	return strings.ToLower(strings.Join(strings.Fields(text), " "))
}

func taskCreateCriterionDescription(t *testing.T) string {
	t.Helper()
	props := mcpToolProps(toolDescriptors(false, false), "task_create")
	if props == nil {
		t.Fatal("task_create is missing from the MCP tool descriptors")
	}
	criterion, _ := props["completionCriterion"].(map[string]interface{})
	description, _ := criterion["description"].(string)
	if description == "" {
		t.Fatalf("task_create completionCriterion has no description: %#v", props["completionCriterion"])
	}
	return description
}

func batchVerifiesRefDescription(t *testing.T) string {
	t.Helper()
	props := mcpToolProps(toolDescriptors(false, false), "task_create_batch")
	if props == nil {
		t.Fatal("task_create_batch is missing from the MCP tool descriptors")
	}
	tasks, _ := props["tasks"].(map[string]interface{})
	items, _ := tasks["items"].(map[string]interface{})
	verifiesRef, _ := items["properties"].(map[string]interface{})["verifiesRef"].(map[string]interface{})
	description, _ := verifiesRef["description"].(string)
	if description == "" {
		t.Fatalf("task_create_batch item verifiesRef has no description: %#v", items)
	}
	return description
}
