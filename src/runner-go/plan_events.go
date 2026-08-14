package main

import (
	"strings"
	"sync"
)

// Codex's update_plan tool and Kimi's ACP `plan` update are engine-private scratch
// checklists: they never reach Orbit's task table. Orbit cannot deny either one the way
// it denies claude's built-in Task* family — codex has no tool denylist, and Kimi never
// asks permission for tools it considers safe (see kimiToolPolicyError) — so steering
// them is a prompt-only affair that can fail. It failed invisibly: both streams carried
// these entries and Orbit rendered nothing, so an agent that recorded the user's work as
// engine scratch instead of an Orbit task left no trace in the transcript AND none in
// tool_call, which is the table that diagnosis starts from. Rendering them as tool calls
// puts that choice on the record in both places.

// planEntries pulls the checklist rows out of a plan payload. Codex carries them under
// `items`, ACP under `entries`.
func planEntries(payload map[string]interface{}) []interface{} {
	for _, key := range []string{"items", "entries", "todos", "plan"} {
		if rows, ok := payload[key].([]interface{}); ok && len(rows) > 0 {
			return rows
		}
	}
	return nil
}

// planChecklist renders those rows as a markdown checklist. Field names differ between
// the two protocols and may drift again, so each lookup carries alternatives and a row
// whose shape is unrecognized is skipped rather than rendered as noise.
func planChecklist(rows []interface{}) string {
	var b strings.Builder
	for _, row := range rows {
		text := ""
		done := false
		if entry := mapValue(row); entry != nil {
			text = firstString(entry, "text", "content", "step", "title", "description")
			status := strings.ToLower(firstString(entry, "status", "state"))
			completed, _ := entry["completed"].(bool)
			done = completed || status == "completed" || status == "done"
		} else if s, ok := row.(string); ok {
			text = s
		}
		if strings.TrimSpace(text) == "" {
			continue
		}
		box := "[ ]"
		if done {
			box = "[x]"
		}
		if b.Len() > 0 {
			b.WriteString("\n")
		}
		b.WriteString("- " + box + " " + strings.TrimSpace(text))
	}
	return b.String()
}

// unhandledStreamKinds is process-wide: one line per unrendered kind is the signal,
// repeating it for every item of that kind (or every session) is spam.
var unhandledStreamKinds sync.Map

// logUnhandledStreamKind reports a stream item Orbit renders nowhere. Dropping in
// silence is how the plan gap above survived unnoticed — an engine adds an item type,
// Orbit ignores it, and no one finds out until a user reports missing content. Kinds
// Orbit deliberately does not render are passed as ignored so the line means "new".
func logUnhandledStreamKind(engine, kind string, ignored ...string) {
	kind = strings.TrimSpace(kind)
	if kind == "" {
		return
	}
	for _, known := range ignored {
		if strings.EqualFold(known, kind) {
			return
		}
	}
	if _, seen := unhandledStreamKinds.LoadOrStore(engine+"/"+kind, true); seen {
		return
	}
	logln(engine + ": stream item " + kind + " has no transcript rendering — dropping it")
}
