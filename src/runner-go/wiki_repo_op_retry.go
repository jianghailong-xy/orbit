package main

// What a finished wiki repository operation reports, sent again inside the window it is still worth
// sending in.
//
// 2026-10-09, canary: the runner wikova and the control plane timed out between each other (14:42, 15:34,
// 16:0x, 16:47 and 17:47Z), and each time a repository operation that had already been run went
// unreported — five sends, five failures, the result dropped, and the maintenance job that waited for it
// recorded a REPO_OP_WAIT and ran the operation again.
//
// The integration jobs' results were fixed the same way that day (63ac99fc5, integration_result_spool.go):
// sent again with a wait that grows to a cap, and spooled to disk. A repository operation's result needs
// neither the unbounded half nor the file, because it is useful only inside a window the runner can name:
//
//   - the job that asked for the operation waits at most 300 seconds for it itself
//     (WIKI_MAINTAIN_JOB.repoWaitSeconds, wikiMaintain.ts — WIKI_DOCS_BUILD_JOB.repoWaitSeconds, wikiDocs.ts);
//   - the control plane's sweep settles a running operation whose claim has been silent for
//     WIKI_REPO_OPS.abandonedSeconds — 900 (src/shared/src/wikiRepoOps.ts) — and a result that arrives
//     after that is answered with the row's state, accepted=false: nobody can use it any more;
//   - this path renews nothing while it reports: the claim's heartbeat is the one that handed the
//     operation over, and staging a fragment is the only renewal a runner sends here.
//
// So the window is the server's own abandonment number, counted from the claim — the heartbeat that put
// the operation in this process's hands — and the whole report happens inside it. There is nothing to
// spool: a process that stops before the window ends leaves no report worth replaying, since the answer
// would reach a job that has given up by then, and the operation is settled failed by the sweep either
// way.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"
)

const (
	// wikiRepoOpResultWindow is how long a result is worth sending: the claim plus
	// WIKI_REPO_OPS.abandonedSeconds, the server's own number for how long a running operation's claim may
	// stay silent before the sweep settles it failed. A result sent inside that window can still be
	// applied; one sent after it is answered with the row's state, which is the server saying it is of no
	// use to anybody. It is deliberately the wider number: a job stops waiting at 300 seconds, and the
	// sweep closes an operation whose job has ended after WIKI_REPO_OPS.staleSeconds, but neither of those
	// is knowable from here — the operation's queue time is not sent with it.
	wikiRepoOpResultWindow = 900 * time.Second

	// wikiRepoOpResultWindowGuard is what keeps every send inside that window rather than at its edge: the
	// claim was stamped by the control plane a moment before the same heartbeat response handed this
	// process the operation, so a clock started here runs a little late, and the sweep runs on a pass
	// rather than at the instant the window ends.
	wikiRepoOpResultWindowGuard = 30 * time.Second
)

// wikiRepoOpRetryPolicy is the wait between sends of a repository operation's result (or of one of its
// fragments), and the window all of them happen inside.
//
// HOW LONG, AND WHY THESE NUMBERS. The first wait is 2 seconds, doubling to a 30-second cap, jittered
// 75-125%: the wiki door's own numbers (wiki_retry.go), for the same reason — a control plane that is down
// costs one request per operation per half minute at worst, and one that comes back is heard from within
// half a minute of it. What differs from the door's policy is the budget: not a duration of retrying but
// the life of the answer, so the retrying ends when the latest it could still be used does.
type wikiRepoOpRetryPolicy struct {
	first, max time.Duration
	// window is how long a result is worth sending, counted from the claim, and guard is what keeps every
	// send strictly inside it (both above). The clock they are measured on is now.
	window, guard time.Duration
	// send is the most one send can take — the result route's wikiRepoOpResultTimeout and the fragment
	// route's own 60 seconds (transport.go) — since a send is started only when the whole of it fits in
	// the window still ahead.
	send time.Duration
	// now is the clock the window is measured on; a test gives it one of its own.
	now func() time.Time
	// jitter spreads one wait, so that runners which failed together do not all come back together.
	jitter func(time.Duration) time.Duration
	// sleep waits, or returns early when ctx ends: a runner that is stopping must not be held back by a
	// report it cannot finish (nothing is spooled for the next process, by the file comment above).
	sleep func(ctx context.Context, d time.Duration)
}

var wikiRepoOpRetry = wikiRepoOpRetryPolicy{
	first:  2 * time.Second,
	max:    30 * time.Second,
	window: wikiRepoOpResultWindow,
	guard:  wikiRepoOpResultWindowGuard,
	send:   60 * time.Second,
	now:    time.Now,
	jitter: wikiRetryJitter,
	sleep: func(ctx context.Context, d time.Duration) {
		timer := time.NewTimer(d)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
		}
	},
}

// wait is the pause after n failed sends: first, doubled n-1 times, jittered, never more than max.
func (p wikiRepoOpRetryPolicy) wait(n int) time.Duration {
	d := p.max
	if n <= 20 && p.first<<(n-1) < p.max {
		d = p.first << (n - 1)
	}
	return min(p.jitter(d), p.max)
}

// deadline is the instant a result stops being worth sending: the claim — the heartbeat that handed this
// process the operation — plus the window, less the guard.
func (p wikiRepoOpRetryPolicy) deadline(claimed time.Time) time.Time {
	return claimed.Add(p.window - p.guard)
}

// fits says whether a send that waits wait and then takes up to p.send fits inside the window still ahead
// of deadline. Every send is made only when it does, so the reporting as a whole ends inside the window
// however many tries it takes.
func (p wikiRepoOpRetryPolicy) fits(deadline time.Time, wait time.Duration) bool {
	return p.now().Add(wait + p.send).Before(deadline)
}

// wikiRepoOpDelivery is one send's outcome. settled is true when the control plane has answered for good:
// it took the result — accepted true, or false for an operation it had settled already — or refused it in
// a way that sending it again cannot change.
type wikiRepoOpDelivery struct {
	answer  *WikiRepoOpResultResponse
	err     error
	settled bool
}

// sendWikiRepoOpResult makes one attempt at reporting what an operation came to.
func sendWikiRepoOpResult(ctx context.Context, t *Transport, opID string, body WikiRepoOpResultRequest) wikiRepoOpDelivery {
	answer, err := t.wikiRepoOpResult(ctx, opID, body)
	if err == nil {
		return wikiRepoOpDelivery{answer: answer, settled: true}
	}
	return wikiRepoOpDelivery{err: err, settled: !wikiRepoOpResultWorthSendingAgain(err)}
}

// wikiRepoOpResultWorthSendingAgain says whether an answer to a result could be a different one later. A
// failure with no answer at all — a connection that failed, a request that timed out — could: nothing was
// decided. So could the answers that say the control plane itself is unwell (5xx, and 408 or 429 from the
// edge), and its 401 and 403: a credential the operator is about to fix is a runner nobody can send
// anything from *yet*. Every other answer settles it, and the operation with it:
//
//	409 STALE_CLAIM    the claim moved on; this result is about an operation that is not this process's
//	404 NOT_FOUND      the operation does not exist (another account's, or gone)
//	400 INVALID_RESULT the result cannot be one, and the server fails the operation under the same claim
//	422 UNSTORABLE_RESULT the database will not hold it; the operation is failed with why
//
// — whatever the answer, the job waiting on the operation has been or is about to be told, and sending
// the same bytes again is noise.
func wikiRepoOpResultWorthSendingAgain(err error) bool {
	var httpErr *transportHTTPError
	if !errors.As(err, &httpErr) {
		return true
	}
	if httpErr.statusCode == http.StatusUnauthorized || httpErr.statusCode == http.StatusForbidden {
		return true
	}
	return isRetryableTransportError(err)
}

// reportWikiRepoOpResult sends an operation's result until the control plane answers for good or the
// window is spent, whichever comes first. Every retry and the ending are logged.
func reportWikiRepoOpResult(ctx context.Context, t *Transport, cmd WikiRepoOpCommand, body WikiRepoOpResultRequest, deadline time.Time) {
	p := wikiRepoOpRetry
	for attempt := 1; ; attempt++ {
		if !p.fits(deadline, 0) {
			// The operation's own work took the window: whatever this result says can no longer reach
			// anybody, and the sweep is about to close the row.
			logln("wiki repo op", cmd.ID, "the window a result is worth sending inside was spent before it could go out; nothing is sent")
			return
		}
		delivery := sendWikiRepoOpResult(ctx, t, cmd.ID, body)
		if delivery.settled {
			finishWikiRepoOpResult(cmd, body, delivery)
			return
		}
		if ctx.Err() != nil {
			logln("wiki repo op", cmd.ID, "result not delivered and this runner is stopping:", delivery.err)
			return
		}
		wait := p.wait(attempt)
		if !p.fits(deadline, wait) {
			logln("wiki repo op", cmd.ID, fmt.Sprintf("result not delivered on attempt %d:", attempt), delivery.err,
				"and the window a result is worth sending inside is spent, so it will not be sent again")
			return
		}
		logln("wiki repo op", cmd.ID, fmt.Sprintf("result not delivered on attempt %d:", attempt), delivery.err,
			"sending it again in", wait.Round(100*time.Millisecond))
		p.sleep(ctx, wait)
	}
}

// finishWikiRepoOpResult writes down how the report ended. Either way the control plane has answered for
// good, so nothing is sent again: it took the result (accepted true), or the operation was already settled
// and the answer carries the row's state (accepted false), or it refused the result for good.
func finishWikiRepoOpResult(cmd WikiRepoOpCommand, body WikiRepoOpResultRequest, delivery wikiRepoOpDelivery) {
	if delivery.err != nil {
		logln("wiki repo op", cmd.ID, "result refused, so it will not be sent again:", delivery.err)
		return
	}
	logln("wiki repo op", cmd.ID, "reported", body.State, fmt.Sprintf("accepted=%v", delivery.answer.Accepted))
}
