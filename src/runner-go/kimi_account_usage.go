package main

// Kimi Code plan usage, one snapshot per account (kimi_account_slot.go): Default's — the KIMI_CODE_HOME
// the runner's own environment selects — and every added account's own, each read from that account's
// home (kimi_usage.go). The container is claudeAccountUsage's, for the same reasons: a login per
// directory, nothing naming the account inside it, and no rolling snapshot pushed by a session. The
// heartbeat reports Default's windows as planUsage.kimi's own and every other account's under its
// accounts, by slot id (combinePlanUsage). A read that fails leaves the account's last reading in place
// with the fetchedAt it was read at — what a page shows as stale — and is logged once, not every pass.

import (
	"context"
	"net/http"
	"sync"
	"time"
)

type kimiAccountUsage struct {
	def   *planUsageProbe
	mu    sync.Mutex
	slots map[string]*kimiSlotUsage
}

type kimiSlotUsage struct {
	probe *planUsageProbe
	stop  context.CancelFunc
}

func newKimiAccountUsage() *kimiAccountUsage {
	return &kimiAccountUsage{def: newKimiPlanUsageProbe(accountSlotDefaultID), slots: map[string]*kimiSlotUsage{}}
}

// newKimiPlanUsageProbe reads account id. Its home is resolved on every pass, so a slot that moved is
// read where it is now, and one that is gone stops being readable rather than answering from Default.
func newKimiPlanUsageProbe(id string) *planUsageProbe {
	name := "kimi plan-usage"
	if id != accountSlotDefaultID {
		name += " (account " + id + ")"
	}
	read := &kimiUsageRead{}
	fetch := func(ctx context.Context, client *http.Client) (*PlanUsage, error) {
		home, err := kimiAccountKind.home(id)
		if err != nil {
			return nil, err
		}
		return read.fetch(ctx, client, home)
	}
	return &planUsageProbe{client: &http.Client{}, name: name, fetch: fetch}
}

// slot returns added account id's entry, making it on first use. The caller holds u.mu.
func (u *kimiAccountUsage) slot(id string) *kimiSlotUsage {
	s := u.slots[id]
	if s == nil {
		s = &kimiSlotUsage{probe: newKimiPlanUsageProbe(id)}
		u.slots[id] = s
	}
	return s
}

// forget stops added account id's read loop and drops what this runner read for it, so the account
// leaves the heartbeat's list with its directory.
func (u *kimiAccountUsage) forget(id string) {
	u.mu.Lock()
	s := u.slots[id]
	delete(u.slots, id)
	u.mu.Unlock()
	if s != nil && s.stop != nil {
		s.stop()
	}
}

// removeKimiAccount carries out one removal of added account id: its directory and record, and the
// read of its quota with them.
func removeKimiAccount(usage *kimiAccountUsage, id string, liveDirs map[string]bool) error {
	if err := kimiAccountKind.remove(id, liveDirs); err != nil {
		return err
	}
	usage.forget(id)
	return nil
}

// snapshot is the Kimi plan usage the heartbeat reports: Default's snapshot, with every account that
// has been read under Accounts. A snapshot carrying accounts is a copy, as the probes share theirs.
func (u *kimiAccountUsage) snapshot() *PlanUsage {
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
	out := PlanUsage{Provider: providerKimi}
	if def != nil {
		out = *def
	}
	out.Accounts = accounts
	return &out
}

// run keeps every account's snapshot fresh on the cadence planUsageProbe.run keeps Claude's and
// Codex's: Default's, and one loop per added account, started once it is listed and stopped once it
// is gone.
func (u *kimiAccountUsage) run(ctx context.Context, activeCount func() int, idleEnabled func() bool) {
	u.runWithIntervals(ctx, activeCount, idleEnabled, planUsageCheckInterval, planUsageActiveInterval, planUsageIdleInterval)
}

func (u *kimiAccountUsage) runWithIntervals(ctx context.Context, activeCount func() int, idleEnabled func() bool, checkInterval, activeInterval, idleInterval time.Duration) {
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

// syncSlots starts a read loop for every added account listed that has none, and stops the loop of,
// and forgets, every account no longer listed. A listing that fails changes nothing.
func (u *kimiAccountUsage) syncSlots(ctx context.Context, start func(context.Context, *planUsageProbe)) {
	slots, err := kimiAccountKind.list()
	if err != nil {
		return
	}
	listed := map[string]bool{}
	u.mu.Lock()
	defer u.mu.Unlock()
	for _, slot := range slots {
		if slot.ID == accountSlotDefaultID {
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
