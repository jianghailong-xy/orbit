package main

import "testing"

// Every engine this runner drives declares its own transport, so how a session is run is a
// property of the provider rather than something the session loop infers from its name.
func TestProviderRuntimesDeclareOneTransportPerEngine(t *testing.T) {
	want := map[string]providerTransport{
		providerClaude:   transportStreamJSON,
		providerCodex:    transportJSONRPC,
		providerKimi:     transportJSONRPC,
		providerOpenCode: transportOneShot,
		providerDSH:      transportStreamJSON,
	}
	if len(providerRuntimes) != len(want) {
		t.Fatalf("providerRuntimes has %d entries, want %d — a new engine needs a transport here", len(providerRuntimes), len(want))
	}
	for provider, transport := range want {
		rt, ok := providerRuntimes[provider]
		if !ok {
			t.Errorf("no runtime declared for %q", provider)
			continue
		}
		if rt.transport != transport {
			t.Errorf("%s transport = %q, want %q", provider, rt.transport, transport)
		}
		if rt.run == nil {
			t.Errorf("%s declares a transport but no session driver", provider)
		}
	}
}

// The dispatch is the table: every declared engine is reachable by name, so no entry can
// end up shadowed by another provider's driver.
func TestRuntimeProviderResolvesEveryDeclaredRuntime(t *testing.T) {
	for provider := range providerRuntimes {
		if got := runtimeProvider(&ClaimedSession{Provider: provider}); got != provider {
			t.Errorf("runtimeProvider(%q) = %q", provider, got)
		}
		if providerRuntimeFor(provider).run == nil {
			t.Errorf("providerRuntimeFor(%q) has no driver", provider)
		}
	}
	// A blank or unknown name is not a provider; it falls back to the default engine,
	// which must therefore always be one the table holds.
	for _, name := range []string{"", "  ", "gpt-9"} {
		got := runtimeProvider(&ClaimedSession{Provider: name})
		if got != providerClaude {
			t.Errorf("runtimeProvider(%q) = %q, want the default %q", name, got, providerClaude)
		}
		if providerRuntimeFor(got).run == nil {
			t.Fatalf("the default provider %q has no runtime", got)
		}
	}
}
