package main

import (
	"context"
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
// first, as always. The stream's sender sends it; this waits. A refusal the stream gives up on, or one of the session's
// own (it is not this process's, or no longer open), ends the wait: the first leaves the events in the spool, the second
// drops them, as the supervisor's flush does.
func (e *linkEvents) sendHeld(ctx context.Context, sessionID string) error {
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
		if err := s.waitStored(ctx); err != nil {
			return err
		}
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
		if err := streams.sendHeld(sendCtx, sessionID); err != nil && sendCtx.Err() == nil {
			streams.log(fmt.Sprintf("runner link: what idle session %s held is not all stored (%v); its next supervisor sends it first", sessionID, err))
		}
	}()
	active := pool.waitActive(live, jobCtx, loopCtx)
	stopSending()
	<-sent
	return active
}
