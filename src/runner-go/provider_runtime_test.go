package main

import "testing"

// Every engine this runner drives declares its own transport, so how a session is run is a
// property of the provider rather than something the session loop infers from its name.
func TestProviderRuntimesDeclareOneTransportPerEngine(t *testing.T) {
	want := map[string]providerTransport{
		providerDsh:      transportJSONRPC,
		providerClaude:   transportStreamJSON,
		providerCodex:    transportJSONRPC,
		providerKimi:     transportJSONRPC,
		providerOpenCode: transportOneShot,
		// One resident agy, a `user` line per turn on a stdin that stays open.
		providerAntigravity: transportStreamJSON,
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

func TestDshACPDispatchPreservesLegacyDeepSeek(t *testing.T) {
	legacy := &ClaimedSession{Provider: "deepseek", SessionUUID: "legacy-claude-id"}
	syncJobProvider(legacy)
	if runtimeProvider(legacy) != providerClaude || legacy.RuntimeSessionID != "legacy-claude-id" {
		t.Fatalf("legacy DeepSeek changed runtime identity: %+v", legacy)
	}
	harness := &ClaimedSession{Provider: providerDsh, SessionUUID: "orbit-id"}
	syncJobProvider(harness)
	if runtimeProvider(harness) != providerDsh || currentRuntimeSessionID(harness) != "" {
		t.Fatalf("Harness must learn its own id from ACP: %+v", harness)
	}
	if providerRuntimeFor(providerDsh).steersMidTurn {
		t.Fatal("dsh must not claim mid-turn steer")
	}
}
