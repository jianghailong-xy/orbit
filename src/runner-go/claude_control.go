package main

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// The control channel: the requests Orbit sends a running `claude`, and the answer each
// one waits for.
//
// A control_request is how a turn is stopped without killing anything. The process keeps
// its conversation, its stdin and its place in the session — which is the whole
// difference between an interrupt and an end. Tearing the process down would also stop
// the turn, and it would look identical from the outside for about a second, but it
// throws away a resumable context and everything the CLI had not yet flushed. So a kill
// is never how this is done, and — the failure this file exists to make impossible — a
// kill is never how a failed interrupt is covered up either.
//
// What makes an interrupt an operation rather than a wish is that it has an answer:
//
//	→ {"type":"control_request","request_id":"req-3-1","request":{"subtype":"interrupt"}}
//	← {"type":"control_response","response":{"subtype":"success","request_id":"req-3-1",…}}
//
// Everything here is about that correlation. The reply carries the id it answers, so it
// is routed to the one request waiting for it and to nothing else; a request that is
// never answered fails on a deadline instead of hanging; and every way out is definite,
// so silence is never read as consent.

// claudeInterruptTimeout bounds the wait for an interrupt's answer.
//
// The CLI services its control channel independently of whatever tool it is running —
// that independence is the reason the channel exists — so an interrupt that is still
// unanswered this long after its bytes reached stdin means the CLI is not servicing
// control at all. Generous rather than snappy on purpose: reporting a failure for an
// engine that was merely slow would teach people to distrust the one signal that says
// their stop did not take.
const claudeInterruptTimeout = 30 * time.Second

// The interrupt control subtype, named once so the frame builder and the waiter agree.
const ctrlInterrupt = "interrupt"

var (
	// The CLI answered, and its answer was a refusal. Carried through with the CLI's own
	// message when it gave one, since only it knows why.
	errControlRefused = errors.New("the engine refused the control request")
	// Nothing came back before the deadline. Distinct from a refusal: the CLI never said
	// what it did, so whether the turn stopped is unknown — and unknown is reported, not
	// rounded up to done.
	errControlUnanswered = errors.New("the engine did not answer the control request in time")
)

// controlWaiter is one outstanding control_request: the id the CLI must echo back, and
// the place its answer is delivered.
type controlWaiter struct {
	id      string
	subtype string
	// generation of the process this was sent to. An answer naming any other generation
	// belongs to a process that is already gone (see controlIDGeneration).
	generation uint64
	done       chan struct{}
	settled    atomic.Bool
	resp       claudeControlResponse
	err        error
}

// settle records this request's outcome, once. Whichever path gets there first is the
// answer: a CLI reply, a stdin that broke, a process that exited, a deadline. A second
// attempt — the classic case being a response that arrives just after the timeout — finds
// the request already settled and changes nothing, so a late success cannot resurrect an
// operation the caller has already been told failed.
func (w *controlWaiter) settle(resp claudeControlResponse, err error) bool {
	if !w.settled.CompareAndSwap(false, true) {
		return false
	}
	w.resp, w.err = resp, err
	close(w.done)
	return true
}

// controlRequestID mints the id for one request: "req-<generation>-<n>".
//
// Unique for the life of the runner, and self-describing. The counter alone would repeat
// across a re-spawn — a session that crashes and resumes starts a second CLI whose first
// interrupt would otherwise be req-1 all over again — and the two processes' stdout can
// overlap while one is being torn down. Naming the generation in the id makes a straggler
// from the old process recognisable as one instead of being matched against the new
// process's identically numbered request.
func controlRequestID(generation, n uint64) string {
	return fmt.Sprintf("req-%d-%d", generation, n)
}

// controlIDGeneration reads the process generation back out of a request id, or 0 for an
// id this runner did not mint (generations start at 1). What it is for is attribution: an
// answer nobody is waiting for is worth a log line naming the process it came from, since
// a straggler from a torn-down generation and a reply to a request that already timed out
// are different problems.
func controlIDGeneration(id string) uint64 {
	rest, ok := strings.CutPrefix(id, "req-")
	if !ok {
		return 0
	}
	gen, _, ok := strings.Cut(rest, "-")
	if !ok {
		return 0
	}
	n, err := strconv.ParseUint(gen, 10, 64)
	if err != nil {
		return 0
	}
	return n
}

// requestControl sends one control_request through the same single-writer queue every
// other frame goes through, and registers the waiter its answer will resolve.
//
// Registered before the frame is handed over, so an answer cannot arrive before there is
// anywhere to route it; and reserved before the waiter exists, so a runtime that will
// never carry the frame — a closed stdin, a CLI that stopped reading, a process already
// gone — is reported as the failure it is instead of leaving a request outstanding for
// something that was never sent.
func (r *claudeRuntime) requestControl(subtype string) (*controlWaiter, error) {
	slot, err := r.reserve()
	if err != nil {
		return nil, err
	}
	w := &controlWaiter{
		id:         controlRequestID(r.generation, r.ctrlSeq.Add(1)),
		subtype:    subtype,
		generation: r.generation,
		done:       make(chan struct{}),
	}
	r.mu.Lock()
	if r.closed || r.phase == phaseTerminal {
		r.mu.Unlock()
		slot.abandon()
		return nil, errRuntimeGone
	}
	if r.control == nil {
		r.control = map[string]*controlWaiter{}
	}
	r.control[w.id] = w
	r.mu.Unlock()
	receipt := slot.commit(controlRequestFrame(w.id, subtype))
	// The writer answers on its own schedule, and a frame it establishes will never
	// arrive is a request that can never be answered. Settle it the moment that is known
	// rather than making the caller sit out the full deadline for a reply that is not
	// coming. Every receipt settles exactly once, so this goroutine always ends.
	go func() {
		if err := receipt.wait(context.Background()); err != nil {
			r.settleControl(w.id, claudeControlResponse{}, err)
		}
	}()
	return w, nil
}

// awaitControl blocks for one request's own answer, and retires it either way.
//
// Every exit is definite — the CLI's answer, a failure the runtime already knows about, a
// deadline, or the caller giving up — and each one takes the waiter out of the routing
// table on the way, so a response that shows up afterwards has nothing left to resolve.
func (r *claudeRuntime) awaitControl(ctx context.Context, w *controlWaiter, timeout time.Duration) error {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-w.done:
	case <-timer.C:
		w.settle(claudeControlResponse{}, errControlUnanswered)
	case <-ctx.Done():
		w.settle(claudeControlResponse{}, ctx.Err())
	}
	// Wait on the answer even when this goroutine just gave it. Its own settle may have
	// lost the race to a reply landing at the same instant, and the winner writes the
	// answer before closing this — so this is both what orders the read and what makes the
	// error returned the one that actually settled the request.
	<-w.done
	r.retireControl(w.id)
	return w.err
}

// resolveControl routes one control_response to the request waiting for it, and reports
// whether it matched anything.
//
// An id this runtime is not waiting on resolves nothing: a straggler from an earlier
// process (whose ids name a generation this table never minted), a second answer to a
// request that already timed out, a reply to something else entirely. Routing by id
// rather than by "the last thing we sent" is what makes that distinction possible at all
// — with one shared slot, a late answer to a dead request would be handed to whoever is
// waiting now.
func (r *claudeRuntime) resolveControl(resp claudeControlResponse) bool {
	if resp.Subtype == ctrlError {
		msg := resp.Error
		if msg == "" {
			msg = errControlRefused.Error()
		}
		return r.settleControl(resp.RequestID, resp, errors.New(msg))
	}
	return r.settleControl(resp.RequestID, resp, nil)
}

// settleControl answers the named request and takes it out of the routing table.
func (r *claudeRuntime) settleControl(id string, resp claudeControlResponse, err error) bool {
	r.mu.Lock()
	w := r.control[id]
	delete(r.control, id)
	r.mu.Unlock()
	if w == nil {
		return false
	}
	return w.settle(resp, err)
}

// retireControl drops a request the caller has stopped waiting for.
func (r *claudeRuntime) retireControl(id string) {
	r.mu.Lock()
	delete(r.control, id)
	r.mu.Unlock()
}

// failPendingControl settles everything still outstanding with one definite failure.
//
// Called where the process stops being able to answer at all — stdout at EOF, a stdin
// that broke — so nobody waits out a deadline for a reply that cannot come, and nothing
// reads the silence that follows as the operation having worked.
func (r *claudeRuntime) failPendingControl(err error) {
	r.mu.Lock()
	waiters := make([]*controlWaiter, 0, len(r.control))
	for id, w := range r.control {
		waiters = append(waiters, w)
		delete(r.control, id)
	}
	r.mu.Unlock()
	for _, w := range waiters {
		w.settle(claudeControlResponse{}, err)
	}
}

// interruptRuntime stops the turn a resident CLI is running, and answers for it.
//
// Returns nil only when that CLI answered this exact request with a success. Everything
// else — a queue that would not take the frame, a stdin that broke, a refusal, silence
// past the deadline, the process going away mid-request — comes back as an error naming
// what happened. There is no path here that gives up on the protocol and reaches for the
// process instead: an interrupt that cannot be confirmed is reported, because the session
// is still alive and the person who pressed stop needs to know it did not take.
func interruptRuntime(ctx context.Context, rt *claudeRuntime) (string, error) {
	w, err := rt.requestControl(ctrlInterrupt)
	if err != nil {
		return "", err
	}
	return w.id, rt.awaitControl(ctx, w, claudeInterruptTimeout)
}

// interruptFailureMessage turns a failed interrupt into the line the transcript shows.
//
// It has to say two things at once: the turn is still running, and nothing has been lost.
// A person who pressed stop and sees nothing happen otherwise concludes the session is
// wedged and reaches for something more destructive — when the conversation is intact and
// the turn will still end on its own.
func interruptFailureMessage(err error) string {
	return "could not stop the current turn: " + err.Error() +
		". The session is still running and its context is intact; the turn will finish on its own, or you can end the session."
}
