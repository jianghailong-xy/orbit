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
}

func newCodexAccountUsage(leaseOwner string) *codexAccountUsage {
	return &codexAccountUsage{def: newCodexPlanUsageProbe(leaseOwner), slots: map[string]*codexSlotUsage{}}
}

// newCodexSlotPlanUsageProbe reads added slot id. The slot is resolved on every read, so one that is
// gone is refused rather than read somewhere else.
func newCodexSlotPlanUsageProbe(id string) *planUsageProbe {
	fetch := func(ctx context.Context, _ *http.Client) (*PlanUsage, error) {
		home, err := codexAccountSlotHome(id)
		if err != nil {
			return nil, err
		}
		return fetchCodexAccountPlanUsage(ctx, home)
	}
	return &planUsageProbe{client: &http.Client{}, name: "codex plan-usage (account " + id + ")", fetch: fetch}
}

// slot returns added slot id's entry, making it on first use. The caller holds u.mu.
func (u *codexAccountUsage) slot(id string) *codexSlotUsage {
	s := u.slots[id]
	if s == nil {
		s = &codexSlotUsage{probe: newCodexSlotPlanUsageProbe(id)}
		u.slots[id] = s
	}
	return s
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
