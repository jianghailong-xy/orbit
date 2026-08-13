package main

import (
	"context"
	"os"
	"sync"
	"time"
)

// Answering "is this agent's working directory actually there, and can it be worktree-isolated?"
// costs a stat plus a `git rev-parse` per agent. That is cheap but not free, and a hung network
// mount would make it unbounded — so it runs on the same single-flight, latest-wins background
// cache the session telemetry uses, and the heartbeat only ever reads the last completed scan.
const (
	agentDirProbeTimeout = 10 * time.Second
	agentDirProbeMax     = 200
)

type agentDirProbe struct {
	timeout time.Duration
	wake    chan struct{}
	done    chan struct{}

	pendingMu sync.Mutex
	pending   []AgentDirTarget

	stateMu sync.RWMutex
	state   []AgentDirProbe
	// Distinguishes "no scan has completed yet" from "scanned, and found nothing" — the
	// control plane must keep its previous snapshot in the first case rather than being told
	// every directory vanished.
	scanned bool
}

func newAgentDirProbe(timeout time.Duration) *agentDirProbe {
	if timeout <= 0 {
		timeout = agentDirProbeTimeout
	}
	return &agentDirProbe{
		timeout: timeout,
		wake:    make(chan struct{}, 1),
		done:    make(chan struct{}),
	}
}

// trigger replaces any queued work with the newest target set and never waits for the scan.
// Safe to call directly on a heartbeat tick.
func (p *agentDirProbe) trigger(targets []AgentDirTarget) {
	if len(targets) > agentDirProbeMax {
		targets = targets[:agentDirProbeMax]
	}
	p.pendingMu.Lock()
	p.pending = append(p.pending[:0], targets...)
	p.pendingMu.Unlock()
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

func (p *agentDirProbe) takePending() []AgentDirTarget {
	p.pendingMu.Lock()
	defer p.pendingMu.Unlock()
	return append([]AgentDirTarget(nil), p.pending...)
}

func (p *agentDirProbe) run(ctx context.Context) {
	defer close(p.done)
	for {
		select {
		case <-ctx.Done():
			return
		case <-p.wake:
			jobs := p.takePending()
			scanCtx, cancel := context.WithTimeout(ctx, p.timeout)
			state := scanAgentDirs(scanCtx, jobs)
			cancel()
			if ctx.Err() != nil {
				return
			}
			p.stateMu.Lock()
			p.state = append(p.state[:0], state...)
			p.scanned = true
			p.stateMu.Unlock()
		}
	}
}

func (p *agentDirProbe) wait() { <-p.done }

// snapshot returns the last completed scan, or nil before the first one finishes. A finished
// scan that found nothing returns an empty (non-nil) slice: "this runner has no agent
// directories" is an answer, and only the never-scanned case may look like silence.
func (p *agentDirProbe) snapshot() []AgentDirProbe {
	p.stateMu.RLock()
	defer p.stateMu.RUnlock()
	if !p.scanned {
		return nil
	}
	out := make([]AgentDirProbe, len(p.state))
	copy(out, p.state)
	return out
}

// scanAgentDirs reports what is on disk at each target. A path that isn't a directory counts as
// missing: the runner would fail to run there just the same, and saying "exists" of a plain file
// would be a worse answer than saying it isn't there. isGitRepo is the same check setupWorktree
// makes, so the form can't promise isolation the runner would then decline.
func scanAgentDirs(ctx context.Context, targets []AgentDirTarget) []AgentDirProbe {
	out := make([]AgentDirProbe, 0, len(targets))
	for _, t := range targets {
		if ctx.Err() != nil {
			break
		}
		if t.AgentID == "" || t.WorkDir == "" {
			continue
		}
		dir := expandTilde(t.WorkDir)
		info, err := os.Stat(dir)
		if err != nil || !info.IsDir() {
			out = append(out, AgentDirProbe{AgentID: t.AgentID, Exists: false})
			continue
		}
		out = append(out, AgentDirProbe{AgentID: t.AgentID, Exists: true, IsGitRepo: isGitRepo(dir)})
	}
	return out
}
