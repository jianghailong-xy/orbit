package main

import (
	"context"
	"os"
	"sync"
	"sync/atomic"
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

// engineSignedOutSeen is told when a session finds its engine signed out as it starts it — an
// Antigravity whose Google sign-in agy refused (antigravity_google_session.go). The run loop then
// re-probes the engines and beats at once, so the heartbeat carries the sign-out, the yes -> no edge the
// control plane notifies on, now rather than at the next refresh. Unset — in tests, outside the run
// loop — it does nothing.
var engineSignedOutSeen atomic.Pointer[func()]

func noteEngineSignedOut() {
	if seen := engineSignedOutSeen.Load(); seen != nil {
		(*seen)()
	}
}

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

// probeEngineHealthOf is probeEngineHealth for one engine: empty when no spec names it.
func probeEngineHealthOf(engine string) []EngineHealthReport {
	for _, spec := range engineSpecs {
		if spec.bin == engine {
			return probeEngines([]engineSpec{spec}, serviceLoginPath())
		}
	}
	return nil
}

func probeEngines(specs []engineSpec, servicePath string) []EngineHealthReport {
	// What the updater last managed to do here, read fresh each probe: the update loop and
	// `orbit engine-update` both write it, and neither can reach into this snapshot.
	updates := loadEngineUpdateLog()
	out := make([]EngineHealthReport, 0, len(specs))
	for _, spec := range specs {
		h := checkEngine(spec, servicePath)
		report := EngineHealthReport{
			Engine:            spec.bin,
			Installed:         h.installed,
			Version:           h.version,
			Auth:              authWord(h.auth),
			AuthSource:        h.authSource,
			PlanUsage:         h.planUsage,
			InstallationError: h.installError,
			KimiRegion:        h.kimiRegion,
		}
		if spec.bin == providerDsh {
			report.Auth = "unknown"
			report.Dsh = dshRuntimeHealth(h.version, false, h.installed && h.installError == "" && dshCatalogReadable())
		}
		// An engine that isn't here has no update state worth reporting — the record is about
		// a binary, and a stale one left by an uninstall would describe something gone.
		if rec, ok := updates[spec.bin]; ok && h.installed && rec.Status != "" {
			report.Update = &rec
		}
		// An engine whose CLI keeps a login per directory reports one entry per account: the one
		// the user added, and Default. The engines without accounts simply say nothing here.
		if kind, ok := accountSlotKindFor(spec.bin); ok && h.installed {
			defaultAuth := h.auth
			// Antigravity's Default account is the runner's Google sign-in. A runner that runs agy on
			// its own GEMINI_API_KEY is signed in as an engine, but that account is not.
			if spec.bin == providerAntigravity && h.authSource != "google" {
				defaultAuth = authNo
			}
			var usage map[string]*PlanUsage
			report.Accounts, usage = accountHealthWithUsage(kind, h.path, defaultAuth, h.kimiRegion)
			if len(usage) > 0 {
				report.PlanUsage = withAccountUsage(report.PlanUsage, spec.bin, usage)
			}
		}
		out = append(out, report)
	}
	return out
}

// accountHealth asks every added account slot on this machine whether it is signed in. An account's
// login lives in its own directory, so each slot gets the CLI's own status question, run in that
// directory. Default's is the one the engine probe just ran — in the runner's own environment, which
// is what selects Default — so its answer is reused instead of asked twice. Nil when the slots can't
// be listed: the report then reads as the one account it was before.
func accountHealth(kind accountSlotKind, binPath string, defaultAuth authState) []EngineAccountReport {
	out, _ := accountHealthWithUsage(kind, binPath, defaultAuth, "")
	return out
}

// accountHealthWithUsage is accountHealth plus, for a kind whose status question reads quota too
// (usageStatus), each added account's own quota by slot id. Default's is the engine probe's own, and
// so is the site of Default's Kimi login (defaultRegion): an added Kimi account's is read from its own
// directory, signed in or not — a Re-sign in starts on the site the account was on.
func accountHealthWithUsage(kind accountSlotKind, binPath string, defaultAuth authState, defaultRegion string) ([]EngineAccountReport, map[string]*PlanUsage) {
	slots, err := kind.list()
	if err != nil {
		return nil, nil
	}
	out := make([]EngineAccountReport, 0, len(slots))
	var usage map[string]*PlanUsage
	for _, slot := range slots {
		auth := defaultAuth
		if slot.ID != accountSlotDefaultID {
			if kind.usageStatus != nil {
				var read *PlanUsage
				auth, read = accountUsageStatus(kind, binPath, slot.Dir)
				if read != nil {
					if usage == nil {
						usage = map[string]*PlanUsage{}
					}
					usage[slot.ID] = read
				}
			} else {
				auth = accountLoginStatus(kind, binPath, slot.Dir)
			}
		}
		report := EngineAccountReport{
			ID:        slot.ID,
			Name:      slot.Name,
			Dir:       slot.Dir,
			CodexHome: codexHomeOf(kind, slot.Dir),
			Auth:      authWord(auth),
		}
		if kind.engine == providerClaude && auth == authYes {
			report.LoginExpiresAt = claudeLoginExpiry(slot)
		}
		if kind.engine == providerKimi {
			report.KimiRegion = defaultRegion
			if slot.ID != accountSlotDefaultID {
				report.KimiRegion = probeKimiLoginRegion(binPath, envWithValue(os.Environ(), kind.varName, slot.Dir))
			}
		}
		out = append(out, report)
	}
	return out, usage
}

// claudeLoginExpiry is when a Claude account's login lapses, RFC 3339, or "" when its stored
// credentials record no such time or hold no refresh token to lapse. Default's login is read where
// the quota read reads it — the runner's own, the Keychain on a Mac — and an added account's from
// its own directory, never from Default's.
func claudeLoginExpiry(slot accountSlot) string {
	dir := slot.Dir
	if slot.ID == accountSlotDefaultID {
		dir = ""
	}
	login, err := claudeStoredLoginIn(dir)
	if err != nil || !login.refreshable || login.loginExpiresAt.IsZero() {
		return ""
	}
	return login.loginExpiresAt.UTC().Format(time.RFC3339)
}

// withAccountUsage files each added account's own quota under the engine snapshot's accounts, the
// way Codex and Claude report theirs (PlanUsage.Accounts): the buckets beside them stay Default's,
// and a snapshot is made for them when Default has none of its own to report.
func withAccountUsage(own *PlanUsage, engine string, accounts map[string]*PlanUsage) *PlanUsage {
	out := &PlanUsage{Provider: engine}
	if own != nil {
		copied := *own
		out = &copied
	}
	out.Accounts = accounts
	return out
}

// accountLoginStatusTimeout is how long one account's status question may take. Each account has
// its own: under a load of 40 a CLI can take most of ten seconds to answer, and accounts sharing one
// budget left the later ones none — a CLI killed mid-answer, and for Claude possibly mid-refresh.
var accountLoginStatusTimeout = 10 * time.Second

func accountLoginStatus(kind accountSlotKind, binPath, dir string) authState {
	ctx, cancel := context.WithTimeout(context.Background(), accountLoginStatusTimeout)
	defer cancel()
	return kind.loginStatus(ctx, binPath, dir)
}

func accountUsageStatus(kind accountSlotKind, binPath, dir string) (authState, *PlanUsage) {
	ctx, cancel := context.WithTimeout(context.Background(), accountLoginStatusTimeout)
	defer cancel()
	return kind.usageStatus(ctx, binPath, dir)
}

// codexHomeOf repeats a Codex account's directory under the historical field name. The control
// plane's sanitizer drops an account whose `codexHome` is empty — every replica older than `home`
// would then report no accounts at all and run pinned workspaces on Default — so the field keeps
// travelling for as long as such a reader can serve a response. Empty for every other engine,
// whose accounts never had that name.
func codexHomeOf(kind accountSlotKind, dir string) string {
	if kind.engine == providerCodex {
		return dir
	}
	return ""
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
	// Serialises refreshes. One asked for while another runs waits for it and then probes again:
	// the run in flight may have asked the CLIs before whatever prompted this one — a sign-in that
	// just landed, an install that just finished — and dropping the request, which a TryLock here
	// did, left the Providers page calling a freshly signed-in engine signed out until the next
	// five-minute tick.
	refreshMu sync.Mutex
	// What a refresh runs: probeEngineHealth, unless a test stands in for the machine's CLIs.
	probe func() []EngineHealthReport
	// What refreshEngine runs: probeEngineHealthOf, unless a test stands in for the machine's CLIs.
	probeOne func(engine string) []EngineHealthReport
	// Told when a refresh finds an engine signed in that the probe last found signed out. A
	// signed-out engine can be empty in the model catalog (readModelCatalog), so without this the
	// models of an engine someone just signed into would stay out of the picker until the hourly
	// refresh. Called on the refreshing goroutine, so it hands its work off rather than doing it.
	onSignIn func()
	// The engines whose last conclusive answer was "signed out", kept by refresh under refreshMu.
	// An "unknown" isn't conclusive — a CLI that wouldn't say this time says nothing about its
	// login — so it neither ends a sign-out nor starts one.
	wasSignedOut map[string]bool
	// The site each Kimi account's login was on at the last probe that read one, by account id, kept
	// the same way. A sign-in on the other site rewrites the models that account's config lists — the
	// list the catalog reads, when it is the account the catalog reads (kimiCatalogHome) — so it is a
	// sign-in the catalog has to hear about even though the engine was never signed out
	// (kimi_region.go).
	kimiRegions map[string]string
}

func (p *engineHealthProbe) refresh() {
	p.refreshMu.Lock()
	defer p.refreshMu.Unlock()
	p.refreshLocked()
}

func (p *engineHealthProbe) refreshLocked() {
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

// refreshEngine re-probes one engine and puts its answer in place of the one the snapshot had,
// leaving every other engine's as it was. A sign-in that just landed changes one engine, and a full
// refresh asks every CLI on the machine one after another — seconds, more on a loaded box — before
// the heartbeat can say the engine is signed in. Serialised with refresh, for the reason given there.
// Before the first full probe there is nothing to put it into, so that one runs instead.
func (p *engineHealthProbe) refreshEngine(engine string) {
	p.refreshMu.Lock()
	defer p.refreshMu.Unlock()
	probeOne := p.probeOne
	if probeOne == nil {
		probeOne = probeEngineHealthOf
	}
	p.mu.Lock()
	known := false
	for _, r := range p.snapshot {
		known = known || r.Engine == engine
	}
	p.mu.Unlock()
	if !known {
		p.refreshLocked()
		return
	}
	reports := probeOne(engine)
	if len(reports) != 1 || reports[0].Engine != engine {
		return
	}
	p.mu.Lock()
	next := append([]EngineHealthReport(nil), p.snapshot...)
	for i := range next {
		if next[i].Engine == engine {
			next[i] = reports[0]
		}
	}
	p.snapshot = next
	p.mu.Unlock()
	if p.signedInSinceLastProbe(reports) && p.onSignIn != nil {
		p.onSignIn()
	}
}

// signedInSinceLastProbe records each engine's answer and says whether one the probe last found
// signed out is signed in now — or, for Kimi, has an account signed in on the other site.
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
		if r.Engine == providerKimi && p.kimiSiteMoved(r) {
			signedIn = true
		}
	}
	return signedIn
}

// kimiSiteMoved records the site each of Kimi's accounts is on and says whether a signed-in one is
// on another site than the probe last read for it. A report that lists no accounts
// is read as Default alone, the account its own auth and kimiRegion describe. An account read on no
// site this time keeps the last one: a probe that could not say is not a move, and neither is a first
// reading.
func (p *engineHealthProbe) kimiSiteMoved(r EngineHealthReport) bool {
	if p.kimiRegions == nil {
		p.kimiRegions = map[string]string{}
	}
	accounts := r.Accounts
	if len(accounts) == 0 {
		accounts = []EngineAccountReport{{ID: accountSlotDefaultID, Auth: r.Auth, KimiRegion: r.KimiRegion}}
	}
	moved := false
	for _, account := range accounts {
		if account.KimiRegion == "" {
			continue
		}
		if last := p.kimiRegions[account.ID]; account.Auth == "yes" && last != "" && last != account.KimiRegion {
			moved = true
		}
		p.kimiRegions[account.ID] = account.KimiRegion
	}
	return moved
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
