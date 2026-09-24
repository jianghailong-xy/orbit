package main

import (
	"context"
	"os"
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
	return probeEngines(engineSpecs, serviceLoginPath())
}

func probeEngines(specs []engineSpec, servicePath string) []EngineHealthReport {
	// What the updater last managed to do here, read fresh each probe: the daily loop and
	// `orbit engine-update` both write it, and neither can reach into this snapshot.
	updates := loadEngineUpdateLog()
	out := make([]EngineHealthReport, 0, len(specs))
	for _, spec := range specs {
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
		if spec.bin == providerCodex && h.installed {
			report.Accounts = codexAccountHealth(h.path, h.auth)
		}
		out = append(out, report)
	}
	return out
}

// codexAccountHealth asks every Codex account slot on this machine whether it is signed in. An
// account's login lives in its CODEX_HOME, so each slot gets its own `codex login status`, run in
// that slot's CODEX_HOME. Default's is the one the engine probe just ran — in the runner's own
// environment, which is what selects Default — so its answer is reused instead of asked twice.
// Nil when the slots can't be listed: the report then reads as the one account it was before.
func codexAccountHealth(binPath string, defaultAuth authState) []EngineAccountReport {
	slots, err := listCodexAccountSlots()
	if err != nil {
		return nil
	}
	out := make([]EngineAccountReport, 0, len(slots))
	for _, slot := range slots {
		auth := defaultAuth
		if slot.ID != codexAccountDefaultSlot {
			auth = codexSlotLoginStatus(binPath, slot.CodexHome)
		}
		out = append(out, EngineAccountReport{
			ID:        slot.ID,
			Name:      slot.Name,
			CodexHome: slot.CodexHome,
			Auth:      authWord(auth),
		})
	}
	return out
}

func codexSlotLoginStatus(binPath, codexHome string) authState {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return codexLoginStatus(ctx, binPath, envWithValue(os.Environ(), "CODEX_HOME", codexHome))
}

// codexAccountFingerprintPrefixLen is how much of an account fingerprint the heartbeat's account
// list carries: enough to tell accounts apart on the page, and nothing that could stand in for the
// whole fingerprint the rate-limit reset binds its operations to.
const codexAccountFingerprintPrefixLen = len(codexAccountFingerprintPrefix) + 8

// withCodexAccountFingerprints labels every Codex account in an engine snapshot with the prefix of
// the account fingerprint this runner has read for it — each slot's own, read out of that slot's
// CODEX_HOME (codexAccountUsage.accountFingerprintPrefixes), so two slots holding one account carry
// the same prefix and the page can say so. A slot nobody has read one for is left unlabelled rather
// than given another account's. The snapshot is shared with the probe that refreshes it, so a
// labelled copy is returned rather than the snapshot written to.
func withCodexAccountFingerprints(engines []EngineHealthReport, codexUsage *codexAccountUsage) []EngineHealthReport {
	if codexUsage == nil {
		return engines
	}
	prefixes := codexUsage.accountFingerprintPrefixes()
	if len(prefixes) == 0 {
		return engines
	}
	out := append([]EngineHealthReport(nil), engines...)
	for i := range out {
		if out[i].Engine != providerCodex || len(out[i].Accounts) == 0 {
			continue
		}
		accounts := append([]EngineAccountReport(nil), out[i].Accounts...)
		for j := range accounts {
			if prefix := prefixes[accounts[j].ID]; prefix != "" {
				accounts[j].FingerprintPrefix = prefix
			}
		}
		out[i].Accounts = accounts
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
