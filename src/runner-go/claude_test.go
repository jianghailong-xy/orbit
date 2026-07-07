package main

import "testing"

// The context gauge reads the latest top-level assistant message's usage. Claude's
// input_tokens EXCLUDES cached tokens (cache_read/creation are counted separately), so
// all four components sum into the current context-window occupancy.
func TestContextTokensFromAssistant(t *testing.T) {
	usage := map[string]interface{}{
		"input_tokens":                float64(1000),
		"cache_read_input_tokens":     float64(90000),
		"cache_creation_input_tokens": float64(3000),
		"output_tokens":               float64(500),
	}
	mk := func(parent string) map[string]interface{} {
		m := map[string]interface{}{
			"type":    "assistant",
			"message": map[string]interface{}{"usage": usage},
		}
		if parent != "" {
			m["parent_tool_use_id"] = parent
		}
		return m
	}

	if got := contextTokensFromAssistant(mk("")); got != 94500 {
		t.Fatalf("top-level sum = %d, want 94500", got)
	}
	// A sub-agent message (parent_tool_use_id set) runs in its own context — ignore it.
	if got := contextTokensFromAssistant(mk("toolu_abc")); got != 0 {
		t.Fatalf("sub-agent = %d, want 0", got)
	}
	// No message.usage → 0 (e.g. a `result` message carries usage at the top level, not
	// under message, so it must not be mistaken for a context reading).
	noUsage := map[string]interface{}{"type": "assistant", "message": map[string]interface{}{}}
	if got := contextTokensFromAssistant(noUsage); got != 0 {
		t.Fatalf("no usage = %d, want 0", got)
	}
}
