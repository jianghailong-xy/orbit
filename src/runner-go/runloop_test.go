package main

import "testing"

func TestCarryOverModelCatalog(t *testing.T) {
	prev := &ModelCatalog{
		Codex:  []ModelInfo{{Value: "gpt-5.6-sol", Label: "GPT-5.6-Sol", ContextWindow: 372_000}},
		Claude: []ModelInfo{{Value: "claude-opus-5", Label: "Opus 5"}},
	}

	// Claude refreshed, `codex debug models` failed → keep the last good Codex list rather than
	// heartbeating a catalog that blanks it (which would drop the clients to a default window).
	merged := carryOverModelCatalog(prev, &ModelCatalog{
		Claude: []ModelInfo{{Value: "claude-opus-6", Label: "Opus 6"}},
	})
	if len(merged.Codex) != 1 || merged.Codex[0].ContextWindow != 372_000 {
		t.Fatalf("Codex = %#v, want the previous list carried over", merged.Codex)
	}
	if len(merged.Claude) != 1 || merged.Claude[0].Value != "claude-opus-6" {
		t.Fatalf("Claude = %#v, want this round's list", merged.Claude)
	}

	// A fresh Codex list always wins — carrying over must never pin a stale window.
	merged = carryOverModelCatalog(prev, &ModelCatalog{
		Codex: []ModelInfo{{Value: "gpt-5.7", Label: "GPT-5.7", ContextWindow: 512_000}},
	})
	if len(merged.Codex) != 1 || merged.Codex[0].ContextWindow != 512_000 {
		t.Fatalf("Codex = %#v, want this round's list", merged.Codex)
	}
	if len(merged.Claude) != 1 || merged.Claude[0].Value != "claude-opus-5" {
		t.Fatalf("Claude = %#v, want the previous list carried over", merged.Claude)
	}

	// First refresh after startup has nothing to carry over.
	first := &ModelCatalog{Codex: []ModelInfo{{Value: "gpt-5.6-sol", Label: "GPT-5.6-Sol"}}}
	if got := carryOverModelCatalog(nil, first); got != first {
		t.Fatalf("carryOverModelCatalog(nil, first) = %#v, want first unchanged", got)
	}
}
