package main

import (
	"context"
	"errors"
	"fmt"
)

// The spool of a session the runner takes back idle (task 34mwBTpOPo3S9LM2SXs10). Its supervisor starts at the
// session's next claim (runLoop registers it cold), and sent what an earlier process left in the spool only then: a
// session nobody spoke to for 72 hours lost it to the spool's cleanup. At its start the runner takes over every open
// session it is assigned, idle ones included (reclaimMissingSessions), so this process may store their events now, and
// does, while the session waits for its claim.
//
// What it cannot send: the spool of a session the reclaim does not hand back to this runner, which is no longer open
// (the control plane stores no event of a closed session) or is another runner's. That stays until the spool's 72-hour
// cleanup, which says what it removes; a session revived meanwhile sends it from its next supervisor.

// sendHeld sends what a session's stream holds, which an earlier process left in its spool, and returns once it is
// stored, or once ctx ends: the session's claim, its end, the runner's stop. Its supervisor then sends what is left
// first, as always. Over the link the stream's sender sends it; over HTTPS it goes from here, a batch at a time in seq
// order, as the supervisor's flush sends it (session.go). A refusal the HTTPS flush gives up on, or one of the session's
// own (it is not this process's, or no longer open), ends the send: the first leaves the events to the supervisor's
// flush, the second drops them, as the flush does.
func (e *linkEvents) sendHeld(ctx context.Context, t *Transport, sessionID string) error {
	s := e.open(sessionID)
	defer s.release()
	held, through := s.holding()
	if held == 0 {
		return nil
	}
	e.log(fmt.Sprintf("runner link: session %s is idle; the %d events through seq %d an earlier process could not send go now, not at its next claim",
		sessionID, held, through))
	for {
		if held, _ := s.holding(); held == 0 {
			e.log(fmt.Sprintf("runner link: the events idle session %s held through seq %d are stored", sessionID, through))
			return nil
		}
		if s.onLink() {
			err := s.waitStored(ctx)
			if errors.Is(err, errLinkEventsOffLink) {
				continue // what the stream holds goes over HTTPS
			}
			if err != nil {
				return err
			}
			continue
		}
		batch := s.heldHead(maxEventBatchBytes)
		if len(batch) == 0 {
			if err := s.givenUp(); err != nil {
				return err // what it holds stays in the spool
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			continue // the link came back in use meanwhile, or a segment held only what is stored already
		}
		rejections := 0
		retry := eventFlushRetryPolicy(&rejections)
		err := retryIdempotentWhile(ctx, func(attemptCtx context.Context) error {
			return t.postEventsHTTPS(attemptCtx, sessionID, RunEventBatch{Events: batch})
		}, func(err error) bool { return !errors.Is(err, errLinkEventsMoved) && retry(err) })
		if errors.Is(err, errLinkEventsMoved) {
			continue // the control plane takes the session's events over the link now
		}
		if isLeaseOwnershipError(err) {
			s.fail(err)
		}
		if err != nil {
			return err
		}
		s.storedOverHTTPS(batch[0].Seq, batch[len(batch)-1].Seq)
	}
}

// waitActiveSendingHeld is pool.waitActive for a session registered idle, sending meanwhile what an earlier process
// left in its spool (sendHeld). The send ends before this returns, so the supervisor that starts next sends what is
// left itself, and nothing goes twice at once.
func waitActiveSendingHeld(t *Transport, pool *sessionPool, live *liveSession, sessionID string, jobCtx, loopCtx context.Context) bool {
	streams := t.eventStreams()
	if streams == nil {
		return pool.waitActive(live, jobCtx, loopCtx)
	}
	sendCtx, stopSending := contextUntilEither(jobCtx, loopCtx)
	sent := make(chan struct{})
	go func() {
		defer close(sent)
		if err := streams.sendHeld(sendCtx, t, sessionID); err != nil && sendCtx.Err() == nil {
			streams.log(fmt.Sprintf("runner link: what idle session %s held is not all stored (%v); its next supervisor sends it first", sessionID, err))
		}
	}()
	active := pool.waitActive(live, jobCtx, loopCtx)
	stopSending()
	<-sent
	return active
}
