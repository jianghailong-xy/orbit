package main

import (
	"strings"
	"testing"
)

// A task in no project that has no prerequisites is never started by autoRunWhenReady: the
// dependency sweep wants an edge and the independent release a project, and the server pins that in
// independent-task-release.pg.spec.ts (11). Read as "once all of its zero prerequisites are DONE",
// the flag promised the opposite, so every door that takes it has to say so in as many words.
func TestMCPTaskToolsSayAutoRunNeverStartsAnUnfiledTaskWithNoPrerequisites(t *testing.T) {
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
		autoRun, ok := props["autoRunWhenReady"].(map[string]interface{})
		if !ok {
			t.Fatalf("%s declares no autoRunWhenReady: %#v", label, props["autoRunWhenReady"])
		}
		description, _ := autoRun["description"].(string)
		for _, phrase := range []string{
			// the case, named as the case
			"A task in no project that has no prerequisites is never started by this flag",
			// and what does start it
			"task_start", "runAt",
		} {
			if !strings.Contains(description, phrase) {
				t.Errorf("%s autoRunWhenReady description does not state %q: %q", label, phrase, description)
			}
		}
	}
}
