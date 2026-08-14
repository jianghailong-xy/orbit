package main

import (
	"strings"
	"sync"
)

// The denominator of the clients' context gauge, published by the runner next to the numerator.
//
// The gauge is a fraction. Its numerator is an observation — the engine reports occupancy and it
// rides `turn_end`/`system:context` up to the clients. Its denominator used to be a belief: three
// hand-maintained tables (a provider preset, web's, Swift's) keyed on a model id, consulted in an
// order that put the hand-typed ones ahead of the runner's own probe. Keying on the id can't work
// even in principle — `opus` and `opus[1m]` are one model with two windows, and the answer also
// moves with CLI version, account and gateway — so the tables were wrong by construction and only
// looked right because the fallback invented a plausible 200k.
//
// So the runner answers it, from its own probe of the CLI that produces the tokens (see
// fetchClaudeContextWindow, and `context_window` in the Codex/OpenCode/Kimi catalogs), and ships it
// with the reading. The clients divide instead of guessing.
//
// Process-wide because the catalog refresher and the sessions are independent goroutines, and this
// is a cache of the runner's own observation of public facts — nothing per-session or secret
// passes through it. Mirrors the apiserver's own model-catalog cache for the same reasons.
var (
	modelWindowMu sync.RWMutex
	modelWindows  *ModelCatalog
)

// publishModelCatalog hands each refresh to the sessions. Called with the catalog the heartbeat
// reports, so what a session divides by is what the picker offered.
func publishModelCatalog(c *ModelCatalog) {
	modelWindowMu.Lock()
	modelWindows = c
	modelWindowMu.Unlock()
}

// modelContextWindow is 0 whenever the runner has no observation to offer: before the first
// refresh, for a CLI whose window it can't read, or for a model that isn't the runtime's own (a
// custom provider borrowing the runtime — its window belongs to the control-plane row that
// configured it). 0 means "no reading", never "small window".
//
// Resolved per emit rather than once per session so a session that outlives a refresh picks up
// the corrected number, and so a session that starts before the first refresh isn't stuck at 0.
func modelContextWindow(runtime, model string) int {
	model = strings.TrimSpace(model)
	if model == "" {
		return 0
	}
	modelWindowMu.RLock()
	catalog := modelWindows
	modelWindowMu.RUnlock()
	if catalog == nil {
		return 0
	}
	var models []ModelInfo
	switch runtime {
	case providerCodex:
		models = catalog.Codex
	case providerKimi:
		models = catalog.Kimi
	case providerOpenCode:
		models = catalog.OpenCode
	default:
		models = catalog.Claude
	}
	for _, m := range models {
		if m.Value == model {
			return m.ContextWindow
		}
	}
	return 0
}

// withContextWindow attaches the denominator to a payload that carries contextTokens, so the two
// halves of the gauge travel as one reading — same event, same model, same moment. Omitted when
// there is no reading, which leaves the clients on their fallback rather than on a guess of ours.
func withContextWindow(payload map[string]interface{}, job *ClaimedSession) map[string]interface{} {
	if w := modelContextWindow(runtimeProvider(job), job.Agent.Model); w > 0 {
		payload["contextWindow"] = w
	}
	return payload
}
