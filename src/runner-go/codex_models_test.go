package main

import "testing"

func TestParseCodexModelCatalog(t *testing.T) {
	raw := []byte(`WARNING: prefix
{
  "models": [
    {
      "slug": "gpt-5.4",
      "display_name": "GPT-5.4",
      "visibility": "list",
      "priority": 16,
      "context_window": 272000,
      "default_reasoning_level": "medium",
      "supported_reasoning_levels": [{"effort": "low"}, {"effort": "medium"}],
      "service_tiers": [{"id": "priority"}]
    },
    {
      "slug": "codex-auto-review",
      "display_name": "Codex Auto Review",
      "visibility": "hide",
      "priority": 43
    },
    {
      "slug": "gpt-5.6",
      "display_name": "GPT-5.6",
      "visibility": "list",
      "priority": 0,
      "context_window": 272000,
      "supported_reasoning_levels": [{"effort": "xhigh"}]
    }
  ]
}`)
	models, err := parseCodexModelCatalog(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 {
		t.Fatalf("len(models) = %d, want 2", len(models))
	}
	if models[0].Value != "gpt-5.6" || models[1].Value != "gpt-5.4" {
		t.Fatalf("models order = %#v", models)
	}
	if got := models[0].ContextWindow; got != 272000 {
		t.Fatalf("context window = %d, want 272000", got)
	}
	if got := models[1].ReasoningLevels; len(got) != 2 || got[0] != "low" || got[1] != "medium" {
		t.Fatalf("reasoning levels = %#v", got)
	}
	if got := models[1].ServiceTiers; len(got) != 1 || got[0] != "priority" {
		t.Fatalf("service tiers = %#v", got)
	}
}
