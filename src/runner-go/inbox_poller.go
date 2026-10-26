package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
)

// The inbox poller (docs/runner-link-design.md §5.5, §5.6, §7): how one engine generation of a session takes the turns
// the control plane hands it. Every session loop takes its turns through one: claude (session.go), codex
// (codex_appserver.go, and the exec loop in codex.go), kimi (kimi_acp.go), opencode (opencode.go), antigravity
// (antigravity.go), cursor (cursor_acp.go) and dsh (dsh_acp.go). It does for all of them what each did on its own: the
// loop that fetches, the wait after a fetch that failed, and the table of turns being processed that a turn handed
// over again is checked against.
//
// Over HTTPS it fetches as every runner always has: a long poll (the server holds GET /runner/sessions/:id/inbox for
// 25 s), another as soon as one answers, and another a second after one that failed.
//
// Over the runner link the inbox answers at once and never waits for a turn (wait=0), so the poller fetches only when
// there is something to fetch, and never on a timer:
//
//   - its first fetch: nothing has been heard about the session yet;
//   - an InboxHint for the session, or the session named in the HintState of a HeartbeatAck (link_hints.go);
//   - after a fetch that handed it a turn: more may wait behind it, so it fetches until the inbox answers nothing;
//   - after a fetch that failed, once its backoff has passed: exponential with full jitter from inboxLinkBackoffMin to
//     inboxLinkBackoffMax, never sooner than the answer's retry_after. The question the fetch asked is still open, and
//     no hint need ever answer it: a turn handed out under this generation's lease whose answer was lost is IN_FLIGHT,
//     which no HintState names.
//
// Every fetch over the link says which message or shell turn this process is running in the session (runningTurnId,
// which linkMode.call adds from what the poller records): the control plane hands a turn of this generation's lease
// straight back when the fetch does not name it, which is a fetch whose answer was lost (§5.6), rather than when its
// lease runs out 300 s later. A turn counts as running from the answer that handed it over until the control plane
// takes its turn completion (linkMode.turnDone) or the generation ends (close). The table of turns being processed is
// what keeps a turn handed over again from running twice.
//
// A turn of any other kind — interrupt, end, diff, setconfig, reload, withdraw, a steer — is handed to the session loop
// once. The control plane answers a control turn as it hands it out and never leases a steer again, and over the link
// hands either out again only to a fetch sent again under the request id that handed it out, whose answer never
// arrived (§5.6, task B2b); a second copy that arrives all the same is dropped here, so that it cannot interrupt,
// reconfigure or steer the engine a second time. A fetch over the link that got no answer at all is therefore
// followed by one under its request id, however long the link stays down, until one is answered (linkRequestIDs).
//
// A fetch refused for the lease (isLeaseOwnershipError: 409, 403, 404) ends the poller: the generation never owns the
// inbox again. Nor does a poller whose context has ended, or that has been closed, ever fetch again, in either mode: the
// engine it fetched for is gone, and a control turn handed to it would have no receiver (retirePendingGeneration in
// session.go releases the generation's lease for the same reason).

const (
	// inboxHTTPRetry is the wait after a failed fetch over HTTPS, as it always was.
	inboxHTTPRetry = time.Second
	// The backoff after a failed fetch over the link (§7): exponential, with full jitter.
	inboxLinkBackoffMin = time.Second
	inboxLinkBackoffMax = 30 * time.Second
)

// errInboxPollerClosed is a poller asked for a turn once its generation has ended.
var errInboxPollerClosed = errors.New("the engine generation's inbox poller is closed")

// inboxPoller is the inbox of one engine generation of a session. next is called from one goroutine at a time; the
// table and close from any.
type inboxPoller struct {
	t               *Transport
	sessionID       string
	leaseGeneration string
	// gate says, in link mode, that there is something to fetch: link_hints.go marks it from the time the poller is
	// made until it is closed. Nil on a transport with no link mode.
	gate *linkGate
	// failures counts the fetches in a row that failed, for the link's backoff.
	failures int
	// ids is the request id its fetches go under over the link, kept while one gets no answer.
	ids linkRequestIDs

	mu     sync.Mutex
	closed bool
	// turns are the turns being processed, by id. A loop that never hands back a turn once it has settled it keeps it
	// marked for the generation's life.
	turns map[string]bool
	// handed is the message or shell turn the control plane handed this generation last: what close stops counting as
	// the turn this process runs in the session.
	handed string
	// once are the turns of every other kind handed to this generation, by id: each is handed to the session loop once.
	once map[string]bool
}

// newInboxPoller is the inbox of the engine generation leaseGeneration of a session. close ends it with the generation.
func newInboxPoller(t *Transport, sessionID, leaseGeneration string) *inboxPoller {
	p := &inboxPoller{t: t, sessionID: sessionID, leaseGeneration: leaseGeneration, turns: map[string]bool{}, once: map[string]bool{}}
	if t.link != nil {
		p.gate = t.link.gates.openInbox(sessionID)
	}
	return p
}

// next is the next turn the control plane hands this generation. It waits for one for as long as ctx lasts, and fails
// only when ctx ends (ctx's error), when the poller is closed (errInboxPollerClosed), or when a fetch is refused for the
// lease (isLeaseOwnershipError), which ends the generation's hold on the inbox.
func (p *inboxPoller) next(ctx context.Context) (*RunInboxResponse, error) {
	for {
		if err := p.stopped(ctx); err != nil {
			return nil, err
		}
		onLink := p.t.link != nil && p.t.link.inUse()
		if onLink {
			due, err := p.t.link.gates.take(ctx, func() *linkGate { return p.gate }, linkLongPoll)
			if err != nil {
				return nil, err
			}
			if !due {
				continue // nothing said there is anything to fetch: the mode is looked at again
			}
			if err := p.stopped(ctx); err != nil {
				return nil, err
			}
		}
		resp, err := p.t.inbox(p.ids.with(ctx), p.sessionID, p.leaseGeneration)
		p.ids.settle(err)
		if err != nil {
			if err := p.stopped(ctx); err != nil {
				return nil, err
			}
			if isLeaseOwnershipError(err) {
				return nil, err
			}
			wait := inboxHTTPRetry
			if onLink {
				p.failures++
				wait = inboxLinkBackoff(p.failures, err)
				p.markDue() // the question the fetch asked is still open
			}
			logln(fmt.Sprintf("inbox poll failed for %s: %v; fetching again in %s", p.sessionID, err, wait.Round(time.Millisecond)))
			timer := time.NewTimer(wait)
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil, ctx.Err()
			case <-timer.C:
			}
			continue
		}
		p.failures = 0
		if resp == nil {
			continue // a long poll that held and yielded nothing, or a link fetch with nothing to hand out
		}
		handed := p.handedOver(resp)
		if handed == handedClosed {
			return nil, errInboxPollerClosed
		}
		p.markDue() // more may wait behind it
		if handed == handedAgain {
			logln(fmt.Sprintf("inbox of %s handed over %s turn %s again; it was handed over once and takes effect once",
				p.sessionID, resp.Kind, resp.TurnID))
			continue
		}
		return resp, nil
	}
}

// handover is what handedOver made of a turn a fetch brought back.
type handover int

const (
	handedOn     handover = iota // a turn for the session loop
	handedAgain                  // a turn other than a message or shell turn, handed to this generation already
	handedClosed                 // the poller was closed while the fetch was out
)

// stopped is why the poller fetches nothing more, nil while it may.
func (p *inboxPoller) stopped(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return errInboxPollerClosed
	}
	return nil
}

// markDue makes the next fetch over the link go at once.
func (p *inboxPoller) markDue() {
	if p.gate != nil {
		p.t.link.gates.mark(p.gate)
	}
}

// handedOver records a turn the control plane handed this generation, unless the poller was closed while the fetch was
// out: a message or shell turn is the one this process runs in the session from now on, and a turn of any other kind
// is handed on the first time only. Under p.mu, so that close cannot come between the check and the record.
func (p *inboxPoller) handedOver(resp *RunInboxResponse) handover {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return handedClosed
	}
	if resp.Kind == "message" || resp.Kind == "shell" {
		p.handed = resp.TurnID
		if p.t.link != nil {
			p.t.link.handedTurn(p.sessionID, resp)
		}
		return handedOn
	}
	// A steer the engine could not take is put back in the queue as a message under its own id, and that comes
	// through above.
	if p.once[resp.TurnID] {
		return handedAgain
	}
	p.once[resp.TurnID] = true
	return handedOn
}

// close ends the poller with its engine generation: it fetches nothing more, no hint marks it, and the turn it was handed
// last is no longer one this process runs in the session.
func (p *inboxPoller) close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return
	}
	p.closed = true
	if p.t.link != nil {
		p.t.link.gates.closeInbox(p.sessionID, p.gate)
		if p.handed != "" {
			p.t.link.turnDone(p.sessionID, p.handed)
		}
	}
}

// markInflight takes turnID for processing, and reports false when it is being processed already: the control plane
// hands a turn out again when its lease runs out while it still runs, and over the link when a fetch does not name it.
func (p *inboxPoller) markInflight(turnID string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.turns[turnID] {
		return false
	}
	p.turns[turnID] = true
	return true
}

// isInflight reports whether turnID is being processed.
func (p *inboxPoller) isInflight(turnID string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.turns[turnID]
}

// clearInflight ends turnID's processing: handed over again, it is processed again.
func (p *inboxPoller) clearInflight(turnID string) {
	if turnID == "" {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.turns, turnID)
}

// inboxLinkBackoff is the wait before a fetch over the link goes again after its failures-th failure in a row:
// exponential with full jitter, its ceiling from inboxLinkBackoffMin doubling up to inboxLinkBackoffMax, and never
// sooner than the failed answer asked (inboxRetryAfter).
func inboxLinkBackoff(failures int, err error) time.Duration {
	ceiling := min(inboxLinkBackoffMin<<min(max(failures-1, 0), 5), inboxLinkBackoffMax)
	wait := time.Duration(linkJitter(int64(ceiling))) + time.Millisecond
	return max(wait, inboxRetryAfter(err))
}

// inboxRetryAfter is how long a failed fetch's answer asked to be waited before it is sent again: the retryAfterMs of a
// link call's refusal (runner-link-error.filter.ts), or else its Retry-After; 0 when it asked nothing.
func inboxRetryAfter(err error) time.Duration {
	var httpErr *transportHTTPError
	if !errors.As(err, &httpErr) {
		return 0
	}
	var body struct {
		RetryAfterMs int64 `json:"retryAfterMs"`
	}
	if json.Unmarshal([]byte(httpErr.body), &body) == nil && body.RetryAfterMs > 0 {
		return time.Duration(body.RetryAfterMs) * time.Millisecond
	}
	if wait, ok := wikiRetryAfter(httpErr.retryAfter, time.Now()); ok {
		return wait
	}
	return 0
}
