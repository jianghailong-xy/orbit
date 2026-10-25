package main

import (
	"strings"
	"testing"
)

// The CLI's --auto-run-when-ready says what the MCP task tools' autoRunWhenReady says
// (task_auto_run_docs_test.go), in the same sentence: a task in no project that has no prerequisites
// is never started by it. Its help used to be "auto-run after dependencies complete", which a task
// with none satisfies by having none, so every place a reader of the CLI meets the flag says so —
// `orbit task create --help`, `orbit task update --help`, and the arguments `orbit capabilities`
// lists for both.
func TestCLITaskHelpSaysAutoRunNeverStartsAnUnfiledTaskWithNoPrerequisites(t *testing.T) {
	const sentence = "A task in no project that has no prerequisites is never started by this flag, however ready it looks: start it with task_start, or give it a runAt."

	// One sentence on both doors, not two that happen to agree today.
	tools := toolDescriptors(false, false)
	batch := mcpToolProps(tools, "task_create_batch")
	tasks, _ := batch["tasks"].(map[string]interface{})
	items, _ := tasks["items"].(map[string]interface{})
	itemProps, _ := items["properties"].(map[string]interface{})
	for label, props := range map[string]map[string]interface{}{
		"task_create":            mcpToolProps(tools, "task_create"),
		"task_create_batch item": itemProps,
		"task_update":            mcpToolProps(tools, "task_update"),
	} {
		autoRun, _ := props["autoRunWhenReady"].(map[string]interface{})
		if description, _ := autoRun["description"].(string); !strings.Contains(description, sentence) {
			t.Errorf("%s autoRunWhenReady does not say the CLI's sentence: %q", label, description)
		}
	}

	// --help wraps its prose; the words are what a reader gets, so runs of whitespace read as one.
	for _, action := range []string{"create", "update"} {
		if help := strings.Join(strings.Fields(taskActionHelp[action]), " "); !strings.Contains(help, sentence) {
			t.Errorf("`orbit task %s --help` does not say: %s", action, sentence)
		}
	}

	for _, tool := range []string{"task_create", "task_update"} {
		var argument string
		for _, spec := range baseCLICapabilities {
			if spec.Tool != tool {
				continue
			}
			for _, candidate := range spec.Arguments {
				if strings.HasPrefix(candidate, "--auto-run-when-ready") {
					argument = candidate
				}
			}
		}
		if !strings.Contains(argument, sentence) {
			t.Errorf("`orbit capabilities` lists %s's --auto-run-when-ready as %q, without: %s", tool, argument, sentence)
		}
	}
}
