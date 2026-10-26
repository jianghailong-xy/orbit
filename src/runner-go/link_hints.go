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
//   - a new connection: hints sent while there was none are lost, so the claim and the approvals are asked once more,
//     and the wake sends the connection's first heartbeat at once. Its HeartbeatAck's HintState names every session
//     with a turn waiting in its inbox, so the inboxes are not each asked again (§10).
//
// Each of those makes its gate due, and a long poll that finds its gate due asks once and clears it. The first ask
// for an approval is due too: nothing has been heard about it yet. So a hint, or a HintState entry, marks only a gate
// a long poll has made: one for an approval nobody asks about would never be deleted, and a gate made later is due
// anyway. A long poll that waits its whole window (linkLongPoll) answers that nothing came, without asking, as an
// HTTP long poll that timed out does. An approval's gate waits linkApprovalRecheck at most: the fallback for a
// decision no hint and no HintState names.
//
// A session's inbox gate is its inbox poller's (inbox_poller.go), which decides when to fetch: openInbox makes it,
// due, for the poller's first fetch, and closeInbox forgets it when the engine generation ends. Hints mark it while it
// is open.

// linkGates are the gates of one link mode.
type linkGates struct {
	mu       sync.Mutex
	claim    *linkGate
	wake     *linkGate
	inbox    map[string]*linkGate // the open inbox pollers', by session, as decodeSessionID spells it
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

// openInbox makes the inbox gate of a session's inbox poller, due: its first fetch asks, nothing having been heard
// about the session yet. A poller opened for a session that has one takes its place: the newest engine generation is
// the one the inbox serves.
func (gs *linkGates) openInbox(sessionID string) *linkGate {
	g := &linkGate{due: true}
	gs.mu.Lock()
	gs.inbox[decodeSessionID(sessionID)] = g
	gs.mu.Unlock()
	return g
}

// closeInbox forgets the gate openInbox made, unless a newer poller of the session has taken its place, and wakes the
// poller if it waits on it, so it sees that it is closed.
func (gs *linkGates) closeInbox(sessionID string, g *linkGate) {
	gs.mu.Lock()
	defer gs.mu.Unlock()
	key := decodeSessionID(sessionID)
	if gs.inbox[key] == g {
		delete(gs.inbox, key)
	}
	g.markLocked()
}

// mark makes one gate due: the inbox poller's own, after a fetch that handed it a turn or one that failed.
func (gs *linkGates) mark(g *linkGate) {
	gs.mu.Lock()
	g.markLocked()
	gs.mu.Unlock()
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

// markInbox marks the gate of the session's open inbox poller, and markApproval the gate a long poll has made. One that
// does not exist is due when it is made.
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

// markAll makes the gates due that a new connection needs asked again, having missed whatever was hinted while there
// was none. The wake among them sends the connection's first heartbeat at once, as Welcome asks (§5.3), and its
// HeartbeatAck carries what waits: its HintState names the sessions with a turn waiting in their inbox, whose pollers
// ask then, so the inbox gates are left as they are (§10: a mass reconnect must not have every session ask).
func (gs *linkGates) markAll() {
	gs.mu.Lock()
	defer gs.mu.Unlock()
	gs.claim.markLocked()
	gs.wake.markLocked()
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

// forgetApproval drops an approval's gate once it is decided.
func (gs *linkGates) forgetApproval(approvalID string) {
	gs.mu.Lock()
	defer gs.mu.Unlock()
	key := decodeSessionID(approvalID)
	if g := gs.approval[key]; g != nil && g.ch == nil {
		delete(gs.approval, key)
	}
}
