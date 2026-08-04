package main

import (
	"reflect"
	"testing"
)

// Verbatim shape of `kimi provider list --json` (0.32.0), trimmed to the fields the
// catalog reads.
var kimiProviderListJSON = []byte(`{
  "providers": {
    "managed:kimi-code": {"type": "kimi", "apiKey": "", "baseUrl": "https://api.kimi.com/coding/v1"}
  },
  "models": {
    "kimi-code/kimi-for-coding": {
      "provider": "managed:kimi-code",
      "model": "kimi-for-coding",
      "maxContextSize": 262144,
      "capabilities": ["thinking", "always_thinking", "tool_use"],
      "displayName": "K2.7 Coding"
    },
    "kimi-code/k3": {
      "provider": "managed:kimi-code",
      "model": "k3",
      "maxContextSize": 1048576,
      "capabilities": ["thinking", "always_thinking", "tool_use"],
      "displayName": "K3",
      "supportEfforts": ["low", "high", "max"],
      "defaultEffort": "high"
    }
  }
}`)

func TestParseKimiModelCatalog(t *testing.T) {
	models, err := parseKimiModelCatalog(kimiProviderListJSON)
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 {
		t.Fatalf("models = %#v, want 2", models)
	}
	// The CLI's own object order is the picker order: the managed default leads.
	got := models[0]
	if got.Value != "kimi-code/kimi-for-coding" || got.Label != "K2.7 Coding" || got.ContextWindow != 262144 {
		t.Fatalf("first model = %#v", got)
	}
	// A model that declares no efforts must report none, not the runtime-wide list: an
	// empty row is what tells the clients to offer Default only.
	if got.ReasoningLevels != nil || got.DefaultReasoningLevel != "" {
		t.Fatalf("first model efforts = %#v / %q", got.ReasoningLevels, got.DefaultReasoningLevel)
	}
	got = models[1]
	if got.Value != "kimi-code/k3" || got.Label != "K3" || got.ContextWindow != 1048576 {
		t.Fatalf("second model = %#v", got)
	}
	if want := []string{"low", "high", "max"}; !reflect.DeepEqual(got.ReasoningLevels, want) {
		t.Fatalf("second model efforts = %#v, want %#v", got.ReasoningLevels, want)
	}
	if got.DefaultReasoningLevel != "high" {
		t.Fatalf("second model default effort = %q", got.DefaultReasoningLevel)
	}
}

func TestParseKimiModelCatalogLabelsUnnamedModel(t *testing.T) {
	models, err := parseKimiModelCatalog([]byte(`{"models": {"local/mine": {"maxContextSize": 128000}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0].Label != "local/mine" {
		t.Fatalf("models = %#v", models)
	}
}

func TestParseKimiModelCatalogRejectsEmptyOutput(t *testing.T) {
	for _, out := range []string{"", "kimi: not signed in\n", `{"providers": {}, "models": {}}`} {
		if _, err := parseKimiModelCatalog([]byte(out)); err == nil {
			t.Fatalf("expected an error for %q", out)
		}
	}
}
