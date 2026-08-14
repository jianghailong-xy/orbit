package main

import "testing"

func TestModelContextWindowAnswersFromTheRuntimeCatalog(t *testing.T) {
	t.Cleanup(func() { publishModelCatalog(nil) })
	publishModelCatalog(&ModelCatalog{
		Claude: []ModelInfo{{Value: "claude-opus-5", Label: "Opus 5", ContextWindow: 1_000_000}},
		Codex:  []ModelInfo{{Value: "gpt-5.6-sol", Label: "GPT-5.6-Sol", ContextWindow: 272_000}},
	})

	cases := []struct {
		runtime, model string
		want           int
	}{
		{providerClaude, "claude-opus-5", 1_000_000},
		{providerCodex, "gpt-5.6-sol", 272_000},
		// A model the runtime never reported: a custom provider borrowing the runtime, or a
		// CLI too old to answer. No reading, so the clients keep their own fallback.
		{providerClaude, "deepseek-v4-pro", 0},
		{providerClaude, "", 0},
		// Catalogs are per runtime — a Codex model is not a Claude one.
		{providerClaude, "gpt-5.6-sol", 0},
		{providerKimi, "claude-opus-5", 0},
	}
	for _, c := range cases {
		if got := modelContextWindow(c.runtime, c.model); got != c.want {
			t.Errorf("modelContextWindow(%q, %q) = %d, want %d", c.runtime, c.model, got, c.want)
		}
	}
}

func TestModelContextWindowIsZeroBeforeTheFirstRefresh(t *testing.T) {
	t.Cleanup(func() { publishModelCatalog(nil) })
	publishModelCatalog(nil)
	if got := modelContextWindow(providerClaude, "claude-opus-5"); got != 0 {
		t.Fatalf("modelContextWindow before refresh = %d, want 0", got)
	}
}

func TestWithContextWindowPairsTheReadingOrSaysNothing(t *testing.T) {
	t.Cleanup(func() { publishModelCatalog(nil) })
	publishModelCatalog(&ModelCatalog{
		Claude: []ModelInfo{{Value: "claude-opus-5", ContextWindow: 1_000_000}},
	})

	job := &ClaimedSession{Provider: providerClaude, Agent: AgentExecConfig{Model: "claude-opus-5"}}
	got := withContextWindow(map[string]interface{}{"contextTokens": 165_000}, job)
	if got["contextWindow"] != 1_000_000 {
		t.Fatalf("contextWindow = %v, want 1000000", got["contextWindow"])
	}
	if got["contextTokens"] != 165_000 {
		t.Fatalf("payload lost its tokens: %#v", got)
	}

	// An unknown window is absent rather than 0: the key's absence is what tells the clients to
	// fall back, while a 0 would have to be special-cased at every reader.
	byok := &ClaimedSession{Provider: providerClaude, Agent: AgentExecConfig{Model: "deepseek-v4-pro"}}
	got = withContextWindow(map[string]interface{}{"contextTokens": 165_000}, byok)
	if _, ok := got["contextWindow"]; ok {
		t.Fatalf("unknown window reported anyway: %#v", got)
	}
}
