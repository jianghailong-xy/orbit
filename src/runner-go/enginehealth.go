package main

import (
	"context"
	"sync"
	"time"
)

// Every engine CLI on this machine is reported, engineSpecs order — including OpenCode, which
// has no relayable sign-in flow.
//
// It used to be only the three a user can sign into, on the reasoning that a row nobody could act
// on is worse than no row. That reasoning belongs to the Providers page, and it silently became
// the whole report: the daily pass updates four engines and its own summary names all four, so
// the machine's update report described software the control plane had never been told existed.
// Which engines you can sign into is the reader's question to ask, not this probe's to decide.

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
	// What the updater last managed to do here, read fresh each probe: the daily loop and
	// `orbit engine-update` both write it, and neither can reach into this snapshot.
	updates := loadEngineUpdateLog()
	out := make([]EngineHealthReport, 0, len(engineSpecs))
	for _, spec := range engineSpecs {
		h := checkEngine(spec, servicePath)
		report := EngineHealthReport{
			Engine:    spec.bin,
			Installed: h.installed,
			Version:   h.version,
			Auth:      authWord(h.auth),
		}
		// An engine that isn't here has no update state worth reporting — the record is about
		// a binary, and a stale one left by an uninstall would describe something gone.
		if rec, ok := updates[spec.bin]; ok && h.installed && rec.Status != "" {
			report.Update = &rec
		}
		out = append(out, report)
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
