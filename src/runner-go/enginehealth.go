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
// the whole report: the periodic pass updates four engines and its own summary names all four, so
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
	// What the updater last managed to do here, read fresh each probe: the update loop and
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

// signedOut is whether this report says, beyond doubt, that nothing on the engine can run until
// someone signs in: the CLI's own answer is "no", and so is every account's. "unknown" is not a
// sign-out, and neither is a Codex whose Default is signed out while another account is signed in.
func (r EngineHealthReport) signedOut() bool {
	if r.Auth != "no" {
		return false
	}
	for _, account := range r.Accounts {
		if account.Auth != "no" {
			return false
		}
	}
	return true
}

// signedIn is whether anything on the engine is signed in: the CLI itself, or any Codex account.
func (r EngineHealthReport) signedIn() bool {
	if r.Auth == "yes" {
		return true
	}
	for _, account := range r.Accounts {
		if account.Auth == "yes" {
			return true
		}
	}
	return false
}

// engineHealthProbe is the cached snapshot the heartbeat attaches: refreshed on a timer in the
// background, and on demand after this runner installs or signs in — never on the heartbeat
// goroutine itself, which must not wait on a wedged CLI.
type engineHealthProbe struct {
	mu       sync.Mutex
	snapshot []EngineHealthReport
	// Serialises refreshes so a forced one during the timer's own run doesn't double the probe.
	refreshMu sync.Mutex
	// What a refresh runs: probeEngineHealth, unless a test stands in for the machine's CLIs.
	probe func() []EngineHealthReport
	// Told when a refresh finds an engine signed in that the probe last found signed out. A
	// signed-out engine can be empty in the model catalog (readModelCatalog), so without this the
	// models of an engine someone just signed into would stay out of the picker until the hourly
	// refresh. Called on the refreshing goroutine, so it hands its work off rather than doing it.
	onSignIn func()
	// The engines whose last conclusive answer was "signed out", kept by refresh under refreshMu.
	// An "unknown" isn't conclusive — a CLI that wouldn't say this time says nothing about its
	// login — so it neither ends a sign-out nor starts one.
	wasSignedOut map[string]bool
}

func (p *engineHealthProbe) refresh() {
	if !p.refreshMu.TryLock() {
		return
	}
	defer p.refreshMu.Unlock()
	probe := p.probe
	if probe == nil {
		probe = probeEngineHealth
	}
	next := probe()
	p.mu.Lock()
	p.snapshot = next
	p.mu.Unlock()
	// Only now, so the refresh this asks for already reads the engine as signed in.
	if p.signedInSinceLastProbe(next) && p.onSignIn != nil {
		p.onSignIn()
	}
}

// signedInSinceLastProbe records each engine's answer and says whether one the probe last found
// signed out is signed in now.
func (p *engineHealthProbe) signedInSinceLastProbe(reports []EngineHealthReport) bool {
	if p.wasSignedOut == nil {
		p.wasSignedOut = map[string]bool{}
	}
	signedIn := false
	for _, r := range reports {
		switch {
		case r.signedOut():
			p.wasSignedOut[r.Engine] = true
		case r.signedIn():
			signedIn = signedIn || p.wasSignedOut[r.Engine]
			delete(p.wasSignedOut, r.Engine)
		}
	}
	return signedIn
}

// signedOut is whether the last completed probe found engine signed out (see
// EngineHealthReport.signedOut). False before the first one finishes: an engine nobody has asked
// yet isn't known to be anything.
func (p *engineHealthProbe) signedOut(engine string) bool {
	for _, r := range p.snapshotNow() {
		if r.Engine == engine {
			return r.signedOut()
		}
	}
	return false
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
