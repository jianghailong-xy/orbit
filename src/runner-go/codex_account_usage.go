package main

// Codex plan usage, one snapshot per account slot (codex_account_slot.go).
//
// Default's is the probe that has always read the runner's own login: its reads carry the rate-limit
// reset block as well, and the reset steps read through it — reset v1 is Default's alone
// (docs/codex-rate-limit-reset-contract.md §3). Every slot the runner added has a probe of its own,
// which reads that slot's CODEX_HOME and nothing else (fetchCodexAccountPlanUsage) and never carries a
// block. A session's rolling rate limits refresh the probe of the slot it runs on
// (codexSessionAccountSlot). The heartbeat reports Default's snapshot with every other account's under
// Accounts, so no account's numbers stand in for another's.

import (
	"context"
	"net/http"
	"sync"
	"time"
)

// codexRateLimitSink takes a rolling rate-limit snapshot a Codex session running on account slot
// `slot` was sent.
type codexRateLimitSink func(slot string, snapshot map[string]interface{})

type codexAccountUsage struct {
	// Default's probe.
	def *planUsageProbe

	mu    sync.Mutex
	slots map[string]*codexSlotUsage
}

type codexSlotUsage struct {
	probe *planUsageProbe
	// stop ends the slot's read loop; nil while none runs.
	stop context.CancelFunc
	// fingerprint is the account the slot's last successful read turned out to hold, derived with
	// this runner's key from the accountId that read carried — the provider's own id for the
	// account never outlives the read that produced it (§3). Empty until a read names one, and
	// after a read whose account cannot be fingerprinted.
	mu          sync.Mutex
	fingerprint string
}

func newCodexAccountUsage(leaseOwner string) *codexAccountUsage {
	return &codexAccountUsage{def: newCodexPlanUsageProbe(leaseOwner), slots: map[string]*codexSlotUsage{}}
}

// newCodexSlotUsage makes added slot id's entry, whose probe reads that slot and nothing else. The
// slot is resolved on every read, so one that is gone is refused rather than read somewhere else.
func newCodexSlotUsage(id string) *codexSlotUsage {
	s := &codexSlotUsage{}
	s.probe = &planUsageProbe{client: &http.Client{}, name: "codex plan-usage (account " + id + ")"}
	s.probe.fetch = func(ctx context.Context, _ *http.Client) (*PlanUsage, error) {
		home, err := codexAccountSlotHome(id)
		if err != nil {
			return nil, err
		}
		usage, accountID, err := fetchCodexAccountPlanUsage(ctx, home)
		if err != nil {
			return nil, err
		}
		// Each read re-labels the slot: the account in it is whatever signed in there since, and a
		// label left from the account before would call two different accounts the same one.
		s.setFingerprint(codexAccountFingerprintOf(accountID))
		return usage, nil
	}
	return s
}

// setFingerprint records the fingerprint of the account this slot's read found, or forgets the last
// one when the read named no account at all.
func (s *codexSlotUsage) setFingerprint(fingerprint string) {
	s.mu.Lock()
	s.fingerprint = fingerprint
	s.mu.Unlock()
}

func (s *codexSlotUsage) accountFingerprint() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.fingerprint
}

// codexAccountFingerprintOf derives the account fingerprint of a provider accountId on this machine
// (codexAccountFingerprint), or "" when there is no id to derive one from or this machine has no
// usable key. The id itself is not returned, stored or logged anywhere: what leaves is the
// non-reversible fingerprint (docs/codex-rate-limit-reset-contract.md §3).
func codexAccountFingerprintOf(accountID string) string {
	if accountID == "" {
		return ""
	}
	key, err := loadCodexAccountFingerprintKey()
	if err != nil {
		logln("codex account fingerprint unavailable:", err)
		return ""
	}
	return codexAccountFingerprint(key, accountID)
}

// slot returns added slot id's entry, making it on first use. The caller holds u.mu.
func (u *codexAccountUsage) slot(id string) *codexSlotUsage {
	s := u.slots[id]
	if s == nil {
		s = newCodexSlotUsage(id)
		u.slots[id] = s
	}
	return s
}

// forget stops added slot id's read loop and drops everything this runner knew about it, so a
// directory that is gone is not read, and not reported again: the account leaves the heartbeat's
// account list with it (withCodexAccountFingerprints reads from here too).
func (u *codexAccountUsage) forget(id string) {
	u.mu.Lock()
	s := u.slots[id]
	delete(u.slots, id)
	u.mu.Unlock()
	if s != nil && s.stop != nil {
		s.stop()
	}
}

// removeCodexAccount carries out one removal of added slot id: its directory and record go, and so
// does everything this runner reads for it — the probe loop of that account's plan usage is stopped
// with the directory it reads. A read that outlived the directory would open an app-server in a
// CODEX_HOME nothing is left in, and would go on reporting the account as the runner's.
func removeCodexAccount(usage *codexAccountUsage, id string, liveHomes map[string]bool) error {
	if err := removeCodexAccountSlot(id, liveHomes); err != nil {
		return err
	}
	usage.forget(id)
	return nil
}

// accountFingerprintPrefixes is the fingerprint prefix of every Codex account this runner has read
// one for, by slot id: Default's from the reset block of the read that produced its credits, and
// each added slot's from its own probe. A slot nobody has read is absent — an unread account is not
// evidence that two rows are the same one.
func (u *codexAccountUsage) accountFingerprintPrefixes() map[string]string {
	out := map[string]string{}
	if def := u.def.snapshot(); def != nil && def.RateLimitReset != nil {
		if f := def.RateLimitReset.AccountFingerprint; codexAccountFingerprintPattern.MatchString(f) {
			out[codexAccountDefaultSlot] = f[:codexAccountFingerprintPrefixLen]
		}
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	for id, s := range u.slots {
		if f := s.accountFingerprint(); codexAccountFingerprintPattern.MatchString(f) {
			out[id] = f[:codexAccountFingerprintPrefixLen]
		}
	}
	return out
}

// mergeCodexRateLimits is the codexRateLimitSink every Codex session is handed: the snapshot goes to
// the probe of the session's own slot, and to no other.
func (u *codexAccountUsage) mergeCodexRateLimits(slot string, snapshot map[string]interface{}) {
	if slot == codexAccountDefaultSlot {
		u.def.mergeCodexRateLimits(snapshot)
		return
	}
	u.mu.Lock()
	probe := u.slot(slot).probe
	u.mu.Unlock()
	probe.mergeCodexRateLimits(snapshot)
}

// snapshot is the Codex plan usage the heartbeat reports: Default's snapshot, with every other
// account that has been read under Accounts. The probes' snapshots are shared with the probes that
// refresh them, so a snapshot carrying accounts is a copy.
func (u *codexAccountUsage) snapshot() *PlanUsage {
	def := u.def.snapshot()
	u.mu.Lock()
	var accounts map[string]*PlanUsage
	for id, s := range u.slots {
		if usage := s.probe.snapshot(); usage != nil {
			if accounts == nil {
				accounts = map[string]*PlanUsage{}
			}
			accounts[id] = usage
		}
	}
	u.mu.Unlock()
	if accounts == nil {
		return def
	}
	// Before Default has been read, the other accounts ride on a snapshot holding nothing of its own.
	out := PlanUsage{Provider: providerCodex}
	if def != nil {
		out = *def
	}
	out.Accounts = accounts
	return &out
}

// run keeps every account's snapshot fresh on the cadence planUsageProbe.run keeps Default's: Default's
// probe, and a probe per slot the runner added, started once the slot is listed and stopped — its
// snapshot forgotten — once the slot is gone.
func (u *codexAccountUsage) run(ctx context.Context, activeCount func() int, idleEnabled func() bool) {
	u.runWithIntervals(ctx, activeCount, idleEnabled, planUsageCheckInterval, planUsageActiveInterval, planUsageIdleInterval)
}

func (u *codexAccountUsage) runWithIntervals(ctx context.Context, activeCount func() int, idleEnabled func() bool, checkInterval, activeInterval, idleInterval time.Duration) {
	go u.def.runWithIntervals(ctx, activeCount, idleEnabled, checkInterval, activeInterval, idleInterval)
	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()
	for {
		u.syncSlots(ctx, func(loopCtx context.Context, probe *planUsageProbe) {
			go probe.runWithIntervals(loopCtx, activeCount, idleEnabled, checkInterval, activeInterval, idleInterval)
		})
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// syncSlots starts a read loop for every added slot listed that has none, and stops the loop of, and
// forgets, every slot no longer listed. A listing that fails changes nothing.
func (u *codexAccountUsage) syncSlots(ctx context.Context, start func(context.Context, *planUsageProbe)) {
	slots, err := listCodexAccountSlots()
	if err != nil {
		return
	}
	listed := map[string]bool{}
	u.mu.Lock()
	defer u.mu.Unlock()
	for _, slot := range slots {
		if slot.ID == codexAccountDefaultSlot {
			continue
		}
		listed[slot.ID] = true
		if s := u.slot(slot.ID); s.stop == nil {
			loopCtx, stop := context.WithCancel(ctx)
			s.stop = stop
			start(loopCtx, s.probe)
		}
	}
	for id, s := range u.slots {
		if listed[id] {
			continue
		}
		if s.stop != nil {
			s.stop()
		}
		delete(u.slots, id)
	}
}
