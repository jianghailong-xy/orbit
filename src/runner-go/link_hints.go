package main

import (
	"context"
	"sync"
	"time"

	"orbit/linkpb"
)

// What the daemon's long polls wait on in link mode (docs/runner-link-design.md §5.5, §5.6). Over the link, the claim,
// the inbox, the wake and an approval's decision answer at once rather than hang, and the runner asks only once
// something says there is an answer to have:
//
//   - a Hint frame: ClaimHint, InboxHint for the session, CommandsHint (the wake: the next heartbeat carries what
//     waits), ApprovalHint for the approval;
//   - the HintState every HeartbeatAck carries, which says the same thing again whole, so a hint that was lost costs at
//     most one heartbeat interval;
//   - a new connection: hints sent while there was none are lost, so everything is asked once more.
//
// Each of those makes its gate due, and a long poll that finds its gate due asks once and clears it. The first ask
// for a session's inbox or an approval is due too: nothing has been heard about it yet. So a hint, or a HintState
// entry, marks only a gate a long poll has made: one for a session or an approval nobody asks about would never be
// deleted, and a gate made later is due anyway. A long poll that waits its whole window (linkLongPoll) answers that
// nothing came, without asking, as an HTTP long poll that timed out does. An approval's gate waits
// linkApprovalRecheck at most: the fallback for a decision no hint and no HintState names.

// linkGates are the gates of one link mode.
type linkGates struct {
	mu       sync.Mutex
	claim    *linkGate
	wake     *linkGate
	inbox    map[string]*linkGate // by session, as decodeSessionID spells it
	approval map[string]*linkGate // by approval, as decodeSessionID spells it
}

// linkGate is whether something waits to be asked for, and the channel a long poll waiting for that sleeps on.
type linkGate struct {
	due bool
	ch  chan struct{} // closed when due is set while a long poll waits; nil while none does
}

func newLinkGates() *linkGates {
	return &linkGates{claim: &linkGate{due: true}, wake: &linkGate{}, inbox: map[string]*linkGate{}, approval: map[string]*linkGate{}}
}

func (g *linkGate) markLocked() {
	g.due = true
	if g.ch != nil {
		close(g.ch)
		g.ch = nil
	}
}

// take waits until the gate get names is due, for at most wait, and clears it. It reports whether it was due: false
// when the wait ran out first, and with ctx's error when ctx ended first.
func (gs *linkGates) take(ctx context.Context, get func() *linkGate, wait time.Duration) (bool, error) {
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for {
		gs.mu.Lock()
		g := get()
		if g.due {
			g.due = false
			gs.mu.Unlock()
			return true, nil
		}
		if g.ch == nil {
			g.ch = make(chan struct{})
		}
		ch := g.ch
		gs.mu.Unlock()
		select {
		case <-ch:
		case <-timer.C:
			return false, nil
		case <-ctx.Done():
			return false, ctx.Err()
		}
	}
}

// keyed is the gate of key in gates, made due when there is none yet: the first ask.
func keyed(gates map[string]*linkGate, key string) *linkGate {
	g := gates[key]
	if g == nil {
		g = &linkGate{due: true}
		gates[key] = g
	}
	return g
}

func (gs *linkGates) takeClaim(ctx context.Context, wait time.Duration) (bool, error) {
	return gs.take(ctx, func() *linkGate { return gs.claim }, wait)
}

func (gs *linkGates) takeWake(ctx context.Context, wait time.Duration) (bool, error) {
	return gs.take(ctx, func() *linkGate { return gs.wake }, wait)
}

func (gs *linkGates) takeInbox(ctx context.Context, sessionID string, wait time.Duration) (bool, error) {
	key := decodeSessionID(sessionID)
	return gs.take(ctx, func() *linkGate { return keyed(gs.inbox, key) }, wait)
}

func (gs *linkGates) takeApproval(ctx context.Context, approvalID string, wait time.Duration) (bool, error) {
	key := decodeSessionID(approvalID)
	return gs.take(ctx, func() *linkGate { return keyed(gs.approval, key) }, wait)
}

func (gs *linkGates) markClaim() {
	gs.mu.Lock()
	gs.claim.markLocked()
	gs.mu.Unlock()
}

func (gs *linkGates) markWake() {
	gs.mu.Lock()
	gs.wake.markLocked()
	gs.mu.Unlock()
}

// markInbox and markApproval mark a gate a long poll has made. One that does not exist is due when it is made.
func (gs *linkGates) markInbox(sessionID string) {
	gs.mu.Lock()
	if g := gs.inbox[decodeSessionID(sessionID)]; g != nil {
		g.markLocked()
	}
	gs.mu.Unlock()
}

func (gs *linkGates) markApproval(approvalID string) {
	gs.mu.Lock()
	if g := gs.approval[decodeSessionID(approvalID)]; g != nil {
		g.markLocked()
	}
	gs.mu.Unlock()
}

// markAll makes every gate due: a new connection, which missed whatever was hinted while there was none. The wake
// among them sends the connection's first heartbeat at once, as Welcome asks (§5.3), and its HeartbeatAck carries what
// waits.
func (gs *linkGates) markAll() {
	gs.mu.Lock()
	defer gs.mu.Unlock()
	gs.claim.markLocked()
	gs.wake.markLocked()
	for _, g := range gs.inbox {
		g.markLocked()
	}
	for _, g := range gs.approval {
		g.markLocked()
	}
}

// hint takes one Hint frame. A watchers hint is the live stream's (link_events_live.go), which link_work.go hands it to.
func (gs *linkGates) hint(h *linkpb.Hint) {
	switch kind := h.GetKind().(type) {
	case *linkpb.Hint_Claim:
		gs.markClaim()
	case *linkpb.Hint_Inbox:
		gs.markInbox(kind.Inbox.GetSessionId())
	case *linkpb.Hint_Commands:
		gs.markWake()
	case *linkpb.Hint_Approval:
		gs.markApproval(kind.Approval.GetApprovalId())
	}
}

// state takes the HintState of a Welcome or HeartbeatAck: what waits now, whole. Absent, it says nothing about what
// waits, which is not the same as nothing waiting.
func (gs *linkGates) state(h *linkpb.HintState) {
	if h == nil {
		return
	}
	if h.GetClaim() {
		gs.markClaim()
	}
	for _, id := range h.GetInboxSessionIds() {
		gs.markInbox(id)
	}
	for _, a := range h.GetApprovals() {
		gs.markApproval(a.GetApprovalId())
	}
}

// keepInbox forgets the inbox gates of sessions no heartbeat names any more, unless a long poll waits on one.
func (gs *linkGates) keepInbox(sessionIDs []string) {
	keep := make(map[string]bool, len(sessionIDs))
	for _, id := range sessionIDs {
		keep[decodeSessionID(id)] = true
	}
	gs.mu.Lock()
	defer gs.mu.Unlock()
	for key, g := range gs.inbox {
		if !keep[key] && g.ch == nil {
			delete(gs.inbox, key)
		}
	}
}

// forgetApproval drops an approval's gate once it is decided.
func (gs *linkGates) forgetApproval(approvalID string) {
	gs.mu.Lock()
	defer gs.mu.Unlock()
	key := decodeSessionID(approvalID)
	if g := gs.approval[key]; g != nil && g.ch == nil {
		delete(gs.approval, key)
	}
}
