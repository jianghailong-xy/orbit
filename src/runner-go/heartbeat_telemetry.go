package main

import (
	"context"
	"sort"
	"sync"
	"time"
)

// Live worktree state is useful UI telemetry, but it is not runner liveness.
// Keep the whole best-effort scan comfortably inside one heartbeat interval and
// never let it delay the control heartbeat itself.
const (
	heartbeatTelemetryTimeout         = 10 * time.Second
	heartbeatTelemetryMaxChangedFiles = 256
	heartbeatTelemetryMaxMergeTargets = 128
)

type heartbeatTelemetryTarget struct {
	// supervisor is identity-only. All fields read by the async collector are
	// immutable DTO values captured while sessionPool.mu is held.
	supervisor       *liveSession
	sessionID        string
	isolationStatus  string
	worktree         *Worktree
	permitGeneration uint64
}

type heartbeatTelemetrySample struct {
	target heartbeatTelemetryTarget
	state  SessionLiveState
}

type heartbeatTelemetryCollector func(context.Context, []heartbeatTelemetryTarget) []heartbeatTelemetrySample

// heartbeatTelemetryProbe is a single-flight, latest-wins background cache. A
// blocked/slow scan can consume at most one worker and one pending refresh; the
// heartbeat goroutine only reads the last completed snapshot.
type heartbeatTelemetryProbe struct {
	collect heartbeatTelemetryCollector
	timeout time.Duration
	wake    chan struct{}
	done    chan struct{}

	pendingMu sync.Mutex
	pending   []heartbeatTelemetryTarget

	stateMu sync.RWMutex
	state   []heartbeatTelemetrySample
}

func newHeartbeatTelemetryProbe(timeout time.Duration, collect heartbeatTelemetryCollector) *heartbeatTelemetryProbe {
	if timeout <= 0 {
		timeout = heartbeatTelemetryTimeout
	}
	if collect == nil {
		collect = collectHeartbeatSessionStates
	}
	return &heartbeatTelemetryProbe{
		collect: collect,
		timeout: timeout,
		wake:    make(chan struct{}, 1),
		done:    make(chan struct{}),
	}
}

// trigger replaces any queued work with the newest active-session snapshot and
// never waits for the collector. This is safe to call directly on a heartbeat tick.
func (p *heartbeatTelemetryProbe) trigger(targets []heartbeatTelemetryTarget) {
	p.pendingMu.Lock()
	p.pending = append(p.pending[:0], targets...)
	p.pendingMu.Unlock()
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

func (p *heartbeatTelemetryProbe) takePending() []heartbeatTelemetryTarget {
	p.pendingMu.Lock()
	defer p.pendingMu.Unlock()
	return append([]heartbeatTelemetryTarget(nil), p.pending...)
}

func (p *heartbeatTelemetryProbe) run(ctx context.Context) {
	defer close(p.done)
	for {
		select {
		case <-ctx.Done():
			return
		case <-p.wake:
			jobs := p.takePending()
			scanCtx, cancel := context.WithTimeout(ctx, p.timeout)
			state := p.collect(scanCtx, jobs)
			cancel()
			if ctx.Err() != nil {
				return
			}
			p.stateMu.Lock()
			p.state = append(p.state[:0], state...)
			p.stateMu.Unlock()
		}
	}
}

func (p *heartbeatTelemetryProbe) wait() { <-p.done }

// snapshotFor filters the cache against the current active set. A session that
// parked after its last scan must not have stale mid-turn state replayed after its
// turn-complete update.
func (p *heartbeatTelemetryProbe) snapshotFor(activeTargets []heartbeatTelemetryTarget) []SessionLiveState {
	active := make(map[string]heartbeatTelemetryTarget, len(activeTargets))
	for _, target := range activeTargets {
		if target.sessionID != "" {
			active[target.sessionID] = target
		}
	}
	p.stateMu.RLock()
	defer p.stateMu.RUnlock()
	out := make([]SessionLiveState, 0, len(p.state))
	for _, sample := range p.state {
		current, ok := active[sample.state.SessionID]
		if ok && current.supervisor == sample.target.supervisor && current.permitGeneration == sample.target.permitGeneration {
			out = append(out, sample.state)
		}
	}
	return out
}

// collectHeartbeatSessionStates is the only live-status path that uses bounded
// Git commands. A shared deadline caps the whole batch rather than multiplying a
// timeout by the number of sessions. If it expires mid-session, that incomplete
// row is omitted and the server retains the last complete state for it.
func collectHeartbeatSessionStates(ctx context.Context, targets []heartbeatTelemetryTarget) []heartbeatTelemetrySample {
	ops := contextWorktreeGitOps(ctx)
	state := make([]heartbeatTelemetrySample, 0, len(targets))
	for _, target := range targets {
		if ctx.Err() != nil {
			break
		}
		if target.sessionID == "" || target.isolationStatus == "" {
			continue
		}
		// Base-SHA healing is intentionally local to the immutable worktree copy
		// captured by heartbeatSnapshot. The collector never reads ClaimedSession.
		changedFiles := ops.liveDiffStat(target.worktree)
		if len(changedFiles) > heartbeatTelemetryMaxChangedFiles {
			changedFiles = changedFiles[:heartbeatTelemetryMaxChangedFiles]
		}
		mergeTargets := ops.mergeTargetsForWT(target.worktree)
		if len(mergeTargets) > heartbeatTelemetryMaxMergeTargets {
			mergeTargets = mergeTargets[:heartbeatTelemetryMaxMergeTargets]
		}
		entry := SessionLiveState{
			SessionID:       target.sessionID,
			IsolationStatus: target.isolationStatus,
			ChangedFiles:    changedFiles,
			BranchSha:       ops.effectiveBranchSha(target.worktree),
			WorktreeDirty:   ops.worktreeIsDirty(target.worktree),
			MergeTargets:    mergeTargets,
			BranchMerged:    ops.branchMergedInto(target.worktree),
			WorktreeBranch:  ops.currentBranch(target.worktree),
		}
		if ctx.Err() != nil {
			break
		}
		state = append(state, heartbeatTelemetrySample{target: target, state: entry})
	}
	return state
}

// heartbeatSessionSnapshot keeps lease supervision over every local supervisor,
// while worktree telemetry is restricted to active turns and read from cache.
func heartbeatSessionSnapshot(pool *sessionPool, telemetry *heartbeatTelemetryProbe) (
	map[string]context.CancelFunc,
	[]string,
	[]SessionLiveState,
	[]heartbeatTelemetryTarget,
) {
	cancels, activeTargets := pool.heartbeatSnapshot()
	ids := make([]string, 0, len(cancels))
	for id := range cancels {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	live := telemetry.snapshotFor(activeTargets)
	return cancels, ids, live, activeTargets
}

type heartbeatSendFunc func(HeartbeatRequest) (*HeartbeatResponse, error)

// sendHeartbeatCycle owns the session-related portion of the real heartbeat
// critical path. It always attempts the POST before kicking off the next telemetry
// scan, and returns the exact cancellation snapshot paired with that request.
func sendHeartbeatCycle(
	pool *sessionPool,
	telemetry *heartbeatTelemetryProbe,
	request HeartbeatRequest,
	send heartbeatSendFunc,
) (*HeartbeatResponse, map[string]context.CancelFunc, error) {
	cancels, supervised, sessions, targets := heartbeatSessionSnapshot(pool, telemetry)
	request.SupervisedSessionIDs = supervised
	request.Sessions = sessions
	response, err := send(request)
	telemetry.trigger(targets)
	return response, cancels, err
}

// runHeartbeatTicks makes cadence deterministic in tests. Production passes a
// real ticker; a tick handler must remain bounded by the heartbeat HTTP timeout.
func runHeartbeatTicks(stop <-chan struct{}, ticks <-chan time.Time, heartbeat func()) {
	for {
		select {
		case <-stop:
			return
		case <-ticks:
			heartbeat()
		}
	}
}
