package main

import (
	"context"
	"sync"
	"time"
)

// The engines a user can sign into from the web (LoginEngine in @orbit/shared), in display
// order. OpenCode is a fourth engine spec but authenticates per-provider with no relayable
// flow, so it is not reported here — a row nobody could ever act on is worse than no row.
var loginEngineBins = []string{providerClaude, providerCodex, providerKimi}

// How often the engine probe re-runs. It spawns a couple of subprocesses per engine (`--version`
// plus the CLI's own auth status), so it must not run on every 30s heartbeat; five minutes keeps
// a sign-in or install made elsewhere from staying wrong for long. Anything this runner does
// itself refreshes it immediately (see runloop).
const engineHealthRefreshInterval = 5 * time.Minute

func authWord(a authState) string {
	switch a {
	case authYes:
		return "yes"
	case authNo:
		return "no"
	}
	return "unknown"
}

// probeEngineHealth checks every login engine on this machine — the same check `orbit doctor`
// prints, reported to the control plane so the web can show and fix this runner's logins.
func probeEngineHealth() []EngineHealthReport {
	servicePath := serviceLoginPath()
	out := make([]EngineHealthReport, 0, len(loginEngineBins))
	for _, bin := range loginEngineBins {
		spec, ok := specFor(bin)
		if !ok {
			continue
		}
		h := checkEngine(spec, servicePath)
		out = append(out, EngineHealthReport{
			Engine:    bin,
			Installed: h.installed,
			Version:   h.version,
			Auth:      authWord(h.auth),
		})
	}
	return out
}

// engineHealthProbe is the cached snapshot the heartbeat attaches: refreshed on a timer in the
// background, and on demand after this runner installs or signs in — never on the heartbeat
// goroutine itself, which must not wait on a wedged CLI.
type engineHealthProbe struct {
	mu       sync.Mutex
	snapshot []EngineHealthReport
	// Serialises refreshes so a forced one during the timer's own run doesn't double the probe.
	refreshMu sync.Mutex
}

func (p *engineHealthProbe) refresh() {
	if !p.refreshMu.TryLock() {
		return
	}
	defer p.refreshMu.Unlock()
	next := probeEngineHealth()
	p.mu.Lock()
	p.snapshot = next
	p.mu.Unlock()
}

// snapshotNow returns the last completed probe, or nil before the first one finishes — which the
// heartbeat omits, leaving the server's stored state alone rather than reporting three unknowns.
func (p *engineHealthProbe) snapshotNow() []EngineHealthReport {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.snapshot
}

func (p *engineHealthProbe) run(ctx context.Context) {
	p.refresh()
	ticker := time.NewTicker(engineHealthRefreshInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.refresh()
		}
	}
}
