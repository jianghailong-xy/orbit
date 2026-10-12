package main

import (
	"sync"
	"sync/atomic"
	"time"
)

// Idle sleep of a managed runner (docs/managed-runner-design.md, "Provisioning retry wake and sleep";
// the control plane's half is src/apiserver/src/managed-runners/managed-runner-sleep.ts).
//
// A managed instance reports in every heartbeat what it is doing — turns in flight, background jobs
// of its sessions, heartbeat-delivered operations and sign-ins or installs still running, and events
// it has not yet had acknowledged — and how long all of that has been nothing. The manager drains a
// runner whose records and report both say idle, and asks it, in its heartbeat answers, to stop for
// sleep. The instance accepts only while it is still idle, by echoing the request in `sleepReady`,
// and stops only once the control plane confirms that acceptance: the confirmation and the manager
// calling the drain off are exclusive on the control plane's side, so this process never exits for a
// drain that was abandoned. Stopping is the ordinary drain, ending in exit 0, so the Pod ends
// Succeeded with the kubelet's report of the stop — the proof the manager needs before it gives the
// runner's compute back. A self-managed runner reports nothing and is never asked.

const managedRunnerSleepCapabilityV1 = "managed-runner-sleep-v1"

// ManagedWorkload mirrors @orbit/shared ManagedRunnerWorkload.
type ManagedWorkload struct {
	ActiveTurns     int    `json:"activeTurns"`
	BackgroundJobs  int    `json:"backgroundJobs"`
	Operations      int    `json:"operations"`
	UnflushedEvents int    `json:"unflushedEvents"`
	IdleSeconds     int64  `json:"idleSeconds"`
	SleepReady      string `json:"sleepReady,omitempty"`
}

func (w ManagedWorkload) idle() bool {
	return w.ActiveTurns == 0 && w.BackgroundJobs == 0 && w.Operations == 0 && w.UnflushedEvents == 0
}

// ManagedSleepRequest mirrors @orbit/shared ManagedRunnerSleepRequest.
type ManagedSleepRequest struct {
	RequestedAt string `json:"requestedAt"`
	Confirmed   bool   `json:"confirmed,omitempty"`
}

// managedSleep is one process's side of the handshake: how long it has been idle, the request it
// accepts while it stays idle, and the one whose acceptance it has actually sent.
type managedSleep struct {
	mu        sync.Mutex
	now       func() time.Time
	idleSince time.Time
	accepted  string
	// sent is the request an acceptance went out for. The control plane confirms only what it was
	// sent, and once it has recorded that acceptance the drain can no longer be called off — so a
	// confirmation of it stops this process even if work began meanwhile (the drain then lets that
	// work finish, as any stop does) or the confirming answer was lost and is repeated.
	sent      string
	confirmed bool
}

func newManagedSleep() *managedSleep { return &managedSleep{now: time.Now} }

// report completes counts into the heartbeat's workload: the idle duration, and the acceptance while
// there is one to send. Work of any kind restarts the idle clock and withdraws an acceptance.
func (m *managedSleep) report(counts ManagedWorkload) ManagedWorkload {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	if !counts.idle() {
		m.idleSince = time.Time{}
		m.accepted = ""
		counts.IdleSeconds = 0
		counts.SleepReady = ""
		return counts
	}
	if m.idleSince.IsZero() {
		m.idleSince = now
	}
	counts.IdleSeconds = int64(now.Sub(m.idleSince) / time.Second)
	counts.SleepReady = m.accepted
	if m.accepted != "" {
		m.sent = m.accepted
	}
	return counts
}

// answer acts on a heartbeat's answer. stop: the control plane confirmed the acceptance this process
// sent, so it stops claiming, drains and exits. beat: an acceptance was just made and should reach
// the control plane at once rather than at the next tick. A request withdrawn, or one met while busy,
// leaves nothing accepted.
func (m *managedSleep) answer(request *ManagedSleepRequest, idle bool) (stop bool, beat bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.confirmed {
		return false, false
	}
	if request == nil || request.RequestedAt == "" {
		m.accepted = ""
		return false, false
	}
	if request.Confirmed {
		if request.RequestedAt != m.sent {
			return false, false
		}
		m.confirmed = true
		return true, false
	}
	if !idle {
		m.accepted = ""
		return false, false
	}
	if m.accepted == request.RequestedAt {
		return false, false
	}
	m.accepted = request.RequestedAt
	return false, true
}

// countedOps is the heartbeat's WaitGroup of the work its answers start — landings, repository
// operations, merges, commits, uploads, history scans, rate-limit reset steps — that also says how
// much of it is running, which the workload report needs and a WaitGroup cannot tell.
type countedOps struct {
	wg sync.WaitGroup
	n  atomic.Int64
}

func (c *countedOps) Add(delta int) {
	c.n.Add(int64(delta))
	c.wg.Add(delta)
}

func (c *countedOps) Done() {
	c.n.Add(-1)
	c.wg.Done()
}

func (c *countedOps) Wait() { c.wg.Wait() }

func (c *countedOps) inFlight() int {
	if n := c.n.Load(); n > 0 {
		return int(n)
	}
	return 0
}

// eventBacklog counts one supervisor's events not yet acknowledged by the control plane: buffered,
// or in a batch still being posted. Registered while its supervisor runs, so what a supervisor that
// ended could not flush is not counted against the machine for ever.
type eventBacklog struct{ n atomic.Int64 }

var eventBacklogs sync.Map // *eventBacklog → struct{}

func newEventBacklog() (*eventBacklog, func()) {
	backlog := &eventBacklog{}
	eventBacklogs.Store(backlog, struct{}{})
	return backlog, func() { eventBacklogs.Delete(backlog) }
}

func (b *eventBacklog) buffered() { b.n.Add(1) }

// settled: a batch the control plane acknowledged, or one that will never be sent.
func (b *eventBacklog) settled(n int) { b.n.Add(-int64(n)) }

// unflushedEventCount is every running supervisor's backlog.
func unflushedEventCount() int {
	var total int64
	eventBacklogs.Range(func(key, _ any) bool {
		if n := key.(*eventBacklog).n.Load(); n > 0 {
			total += n
		}
		return true
	})
	return int(total)
}

// managedWorkloadCounts is what this process is doing, for the workload report.
func managedWorkloadCounts(pool *sessionPool, ops *countedOps, login *loginRelay, install *installRelay) ManagedWorkload {
	return ManagedWorkload{
		ActiveTurns:     pool.turnsInFlight(),
		BackgroundJobs:  pool.backgroundJobTotal(),
		Operations:      ops.inFlight() + login.inFlight() + install.inFlight(),
		UnflushedEvents: unflushedEventCount(),
	}
}
