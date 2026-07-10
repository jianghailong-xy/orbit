package main

import "testing"

func TestParseCodexModelCatalog(t *testing.T) {
	raw := []byte(`WARNING: prefix
{
  "models": [
    {
      "slug": "gpt-5.6-terra",
      "display_name": "GPT-5.6-Terra",
      "visibility": "list",
      "priority": 2,
      "context_window": 372000,
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
      "slug": "gpt-5.6-sol",
      "display_name": "GPT-5.6-Sol",
      "visibility": "list",
      "priority": 1,
      "context_window": 372000,
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
	if models[0].Value != "gpt-5.6-sol" || models[1].Value != "gpt-5.6-terra" {
		t.Fatalf("models order = %#v", models)
	}
	if got := models[0].ContextWindow; got != 372000 {
		t.Fatalf("context window = %d, want 372000", got)
	}
	if got := models[1].ReasoningLevels; len(got) != 2 || got[0] != "low" || got[1] != "medium" {
		t.Fatalf("reasoning levels = %#v", got)
	}
	if got := models[1].ServiceTiers; len(got) != 1 || got[0] != "priority" {
		t.Fatalf("service tiers = %#v", got)
	}
}
