package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// The runner protocol in which a turn's outcome and a session's release are two reports (docs/session-three-state-
// plan.md steps 6.1 and 6.2, design §3 and §12). Under it a failed turn is reported as the turn's outcome: the control
// plane records the failure, drains the queue, arms any retry and answers RUNNING, holding the session (on this runner's
// slot, its teardown cancel set) until this runner reports the release, POST /runner/sessions/:id/release. That
// report carries no status word; the server reads what the release is from the row. Without it, the old protocol: a
// failed turn releases the session in the same write and is answered FAILED, and a run's end is the finalize.
//
// When this runner speaks it. Only while the latest successful heartbeat answer of its own server says
// `sessionReleaseV1` (the apiserver's switch ORBIT_SESSION_RELEASE_V1, which its operator turns on once every replica
// serves the protocol): a replica that does not would release a held failed turn as a stop and lose the failure, and
// no request reaching a new replica can say none is left. A process that has had no answer yet declares nothing, and
// the first answer without the word turns it off. Declared per report, in the body (`releaseProtocol`): a runner on the
// link cannot send a header of its own, and the server reads either.
//
// What it is declared on: the report of a failed turn that ends the run (turnCompletionEndsSession), and the release.
// No other turn report: a turn reported SUCCEEDED can still fail its session at the server (an acceptance mismatch),
// and its RUNNING answer would then be a hold this runner could not tell from a permit handed to a queued follow-up.
//
// Once a failed turn it declared on is answered RUNNING, the session is held and only a release ends it: never the old
// finalize, whatever the heartbeat says meanwhile, because a replica without the protocol would read that finalize as
// a stop. A 404 for the route is such a replica, so the release goes again (releaseHoldRetryWindow); past that the
// control plane's cancel-grace backstop releases the hold as the failure it is.
const sessionReleaseV1 = "session-release/v1"

// releaseHoldRetryWindow is how long the release of a held failed turn is sent again while the control plane cannot
// take it (unreachable, or a replica that predates the route): past the reaper's cancel grace (two minutes), after which
// the hold is released by that backstop and a release has nothing left to do. A variable only so tests can shorten it.
var releaseHoldRetryWindow = 4 * time.Minute

// releaseRetryPause is the wait between two sends of a held failed turn's release that the route was missing for.
var releaseRetryPause = 2 * time.Second

// noteSessionReleaseOffer records what a successful heartbeat answer of this runner's server said about the protocol.
func (t *Transport) noteSessionReleaseOffer(resp *HeartbeatResponse) {
	if resp == nil {
		return
	}
	if prev := t.releaseOffered.Swap(resp.SessionReleaseV1); prev != resp.SessionReleaseV1 {
		if resp.SessionReleaseV1 {
			logln("the control plane offers " + sessionReleaseV1 + ": a failed turn and the release are reported separately from now on")
		} else {
			logln("the control plane no longer offers " + sessionReleaseV1 + ": failed turns and run ends are reported as before")
		}
	}
}

// offersSessionRelease is whether this runner declares the protocol on what it reports now.
func (t *Transport) offersSessionRelease() bool { return t.releaseOffered.Load() }

// turnCompleteReporting is turnComplete, declaring the protocol on the report of a failed turn that ends the run while
// the server offers it. declared says whether this report did, which is what tells a RUNNING answer to it apart: a
// hold, under the new protocol, where the old one answers a failed turn FAILED.
func (t *Transport) turnCompleteReporting(ctx context.Context, sessionID string, b TurnCompleteRequest) (status string, declared bool, err error) {
	b.ReleaseProtocol = ""
	if turnCompletionEndsSession(b) && t.offersSessionRelease() {
		b.ReleaseProtocol = sessionReleaseV1
		declared = true
	}
	status, err = t.turnComplete(ctx, sessionID, b)
	return status, declared, err
}

// heldByFailedTurn is whether a turn report's answer leaves the session held for a release: the report declared the
// protocol, and the session was not released by it.
func heldByFailedTurn(declared bool, status string) bool { return declared && status == stRunning }

// failedTurnHold is what this run knows of the hold its failed turn's report may have made.
type failedTurnHold int

const (
	// holdNone: no failed turn of this run was reported under the protocol.
	holdNone failedTurnHold = iota
	// holdUnknown: a failed turn's report declared the protocol and its answer never came (the teardown cancel that very
	// report asks for can cut the request off, a connection can drop). The session may be held, so it is ended as a held
	// one is, by the release alone, and with the cut-off failure said too: the server reads the hold first if there is
	// one, an end asked if there is one, and otherwise records the failure on the turn the release cuts off (readRelease).
	holdUnknown
	// holdConfirmed: the report was answered RUNNING; the failure is the turn's already.
	holdConfirmed
)

// holdAfterReport is what a failed turn's report, declared or not, tells of the hold: answered RUNNING is one; no
// answer at all (an error that is not the server's own answer) may be one; anything else is none.
func holdAfterReport(declared bool, status string, err error) failedTurnHold {
	if !declared {
		return holdNone
	}
	if err == nil {
		if status == stRunning {
			return holdConfirmed
		}
		return holdNone
	}
	var answered *transportHTTPError
	if errors.As(err, &answered) || isLeaseOwnershipError(err) {
		return holdNone
	}
	return holdUnknown
}

// RunReleaseRequest is the release report (POST /runner/sessions/:id/release): the finalize report without its status
// word and the Claude session id, both of which the server reads nothing from.
type RunReleaseRequest struct {
	RunFinalizeRequest
	// CutOffTurnOutcome is "FAILED" when the run failed with no turn this runner could report (an engine that died past
	// its respawn budget, a spawn that failed): the turn the release cuts off records the failure. Empty otherwise.
	CutOffTurnOutcome string
}

func (r RunReleaseRequest) MarshalJSON() ([]byte, error) {
	raw, err := json.Marshal(r.RunFinalizeRequest)
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	delete(fields, "status")
	delete(fields, "claudeSessionId")
	fields["releaseProtocol"], _ = json.Marshal(sessionReleaseV1)
	if r.CutOffTurnOutcome != "" {
		fields["cutOffTurnOutcome"], _ = json.Marshal(r.CutOffTurnOutcome)
	}
	return json.Marshal(fields)
}

// releaseRequestOf is the release report of a run's end, as finalizeRequest reports it under the old protocol. A run
// that failed says so as the cut-off turn's outcome, unless its failed turn's report was answered with the hold, which
// already carries the failure.
func releaseRequestOf(finalizeRequest RunFinalizeRequest, hold failedTurnHold) RunReleaseRequest {
	req := RunReleaseRequest{RunFinalizeRequest: finalizeRequest}
	if finalizeRequest.Status == stFailed && hold != holdConfirmed {
		req.CutOffTurnOutcome = stFailed
	}
	return req
}

// releaseRun reports the release; like finalizeRun it answers whether the checkout is kept, keeping it on any error.
func (t *Transport) releaseRun(ctx context.Context, sessionID string, b RunReleaseRequest) (bool, error) {
	var r RunFinalizeResponse
	b.LeaseOwner = t.leaseOwner
	b.RunFinalizeRequest = scrubRunFinalize(b.RunFinalizeRequest, sessionID)
	worktreeReports.reported(sessionID)
	if err := t.do(ctx, "POST", "/runner/sessions/"+sessionID+"/release", b, &r, 35*time.Second); err != nil {
		return true, err
	}
	return r.KeepCheckout, nil
}

// releaseRouteMissing is whether err is a server that has no release route: an older one, whose framework answers an
// unknown route 404 "Cannot POST …", as opposed to a 404 about the session.
func releaseRouteMissing(err error) bool {
	var httpErr *transportHTTPError
	return errors.As(err, &httpErr) && httpErr.statusCode == http.StatusNotFound &&
		strings.Contains(httpErr.body, "Cannot "+httpErr.method+" ")
}

// endRun reports a run's end: the release under the new protocol, the finalize under the old one.
//
//   - held (a failed turn this run reported holds the session, or may): the release, and only it. A route missing is a replica
//     without the protocol; the release is sent again for releaseHoldRetryWindow, and the old finalize never.
//   - offered (the server's latest answer offers the protocol): the release; a route missing is a server that
//     predates it, which the old finalize serves as it always has.
//   - neither: the old finalize, exactly as before.
//
// protocol names the report that ended it, for the log.
func endRun(ctx context.Context, t *Transport, sessionID string, finalizeRequest RunFinalizeRequest, hold failedTurnHold) (protocol string, err error) {
	held := hold != holdNone
	finalize := func() error {
		return retryIdempotentWhile(ctx, func(attemptCtx context.Context) error {
			_, attemptErr := t.finalizeRun(attemptCtx, sessionID, finalizeRequest)
			return attemptErr
		}, isRetryableTransportError)
	}
	if !held && !t.offersSessionRelease() {
		return "finalize", finalize()
	}
	release := releaseRequestOf(finalizeRequest, hold)
	send := func() error {
		return retryIdempotentWhile(ctx, func(attemptCtx context.Context) error {
			_, attemptErr := t.releaseRun(attemptCtx, sessionID, release)
			return attemptErr
		}, isRetryableTransportError)
	}
	err = send()
	if !releaseRouteMissing(err) {
		return "release", err
	}
	if !held {
		logln("the control plane has no release route for " + sessionID + ": its run's end is reported by the finalize, as before")
		return "finalize", finalize()
	}
	deadline := time.Now().Add(releaseHoldRetryWindow)
	for releaseRouteMissing(err) && time.Now().Before(deadline) {
		logln("the release of " + sessionID + ", held by its failed turn, reached a control plane without the route; it goes again (never the finalize, which that server would read as a stop)")
		select {
		case <-ctx.Done():
			return "release", ctx.Err()
		case <-time.After(releaseRetryPause):
		}
		err = send()
	}
	return "release", err
}
