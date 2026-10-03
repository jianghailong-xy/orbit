package main

// Claude's accounts each spend their own subscription, so each has its own quota read: one probe
// per account, reading that account's own credentials file (planusage.go) and asking Anthropic's
// usage endpoint with that account's token. The container mirrors codexAccountUsage — Default's
// probe plus one per added account, all kept fresh by a loop — and is deliberately smaller, because
// none of what makes Codex's version long applies here: the CLI's credentials name no account (so
// there is no fingerprint), Claude has no rate-limit reset block, and a running Claude session
// pushes no rolling rate-limit snapshot of its own to merge.

import (
	"context"
	"net/http"
	"sync"
	"time"
)

type claudeAccountUsage struct {
	// def is the login the runner's own environment selects — the machine's Default account.
	def   *planUsageProbe
	mu    sync.Mutex
	slots map[string]*claudeSlotUsage
}

type claudeSlotUsage struct {
	probe *planUsageProbe
	stop  context.CancelFunc
}

func newClaudeAccountUsage() *claudeAccountUsage {
	return &claudeAccountUsage{def: newClaudePlanUsageProbe(), slots: map[string]*claudeSlotUsage{}}
}

// newClaudeSlotUsage is one added account's read: the account's directory is resolved on every pass,
// so a slot that moved under the runner's feet is read where it is now, and one that is gone stops
// being readable at all rather than answering from Default.
func newClaudeSlotUsage(id string) *claudeSlotUsage {
	read := &claudeUsageRead{name: "claude plan-usage (account " + id + ")"}
	fetch := func(ctx context.Context, client *http.Client) (*PlanUsage, error) {
		dir, err := claudeAccountKind.home(id)
		if err != nil {
			return nil, err
		}
		return read.fetch(ctx, client, dir)
	}
	return &claudeSlotUsage{probe: &planUsageProbe{
		client: &http.Client{},
		name:   read.name,
		fetch:  fetch,
	}}
}

// slot returns added account id's entry, making it on first use. The caller holds u.mu.
func (u *claudeAccountUsage) slot(id string) *claudeSlotUsage {
	s := u.slots[id]
	if s == nil {
		s = newClaudeSlotUsage(id)
		u.slots[id] = s
	}
	return s
}

// forget stops added account id's read loop and drops everything this runner knew about it, so a
// directory that is gone is not read, and not reported again: the account leaves the heartbeat's
// account list with it.
func (u *claudeAccountUsage) forget(id string) {
	u.mu.Lock()
	s := u.slots[id]
	delete(u.slots, id)
	u.mu.Unlock()
	if s != nil && s.stop != nil {
		s.stop()
	}
}

// removeClaudeAccount carries out one removal of added account id: its directory and record go, and
// so does everything this runner reads for it — the probe loop of that account's plan usage is
// stopped with the directory it reads, or a read that outlived it would go on reporting an account
// the runner no longer has.
func removeClaudeAccount(usage *claudeAccountUsage, id string, liveDirs map[string]bool) error {
	if err := claudeAccountKind.remove(id, liveDirs); err != nil {
		return err
	}
	usage.forget(id)
	return nil
}

// snapshot is the Claude plan usage the heartbeat reports: Default's snapshot, with every account
// that has been read under Accounts. The probes' snapshots are shared with the probes that refresh
// them, so a snapshot carrying accounts is a copy.
func (u *claudeAccountUsage) snapshot() *PlanUsage {
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
	out := PlanUsage{Provider: providerClaude}
	if def != nil {
		out = *def
	}
	out.Accounts = accounts
	return &out
}

// run keeps every account's snapshot fresh on the cadence planUsageProbe.run keeps Default's.
func (u *claudeAccountUsage) run(ctx context.Context, activeCount func() int, idleEnabled func() bool) {
	u.runWithIntervals(ctx, activeCount, idleEnabled, planUsageCheckInterval, planUsageActiveInterval, planUsageIdleInterval)
}

func (u *claudeAccountUsage) runWithIntervals(ctx context.Context, activeCount func() int, idleEnabled func() bool, checkInterval, activeInterval, idleInterval time.Duration) {
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
func (u *claudeAccountUsage) syncSlots(ctx context.Context, start func(context.Context, *planUsageProbe)) {
	slots, err := claudeAccountKind.list()
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
