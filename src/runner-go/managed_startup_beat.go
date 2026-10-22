package main

import (
	"context"
	"time"
)

// A managed instance's first heartbeat goes before its first claim (docs/managed-runner-design.md,
// "Implementation record: capacity, wake and sleep"). The manager makes a mapping READY only on a
// heartbeat newer than the instance's start that reports a runtime it can run
// (src/apiserver/src/managed-runners/managed-runner-manager.ts, `starting`), and the ticker's first beat
// comes half a minute after the start. An instance woken from sleep claimed and answered turns all that
// time while its mapping still read STARTING, and an auto retry, which waits for READY, waited as long
// (T06, 2026-10-18). A self-managed runner has no READY to reach and claims at once, as it always has.
const (
	// How long the first beat waits for the engine probe's first answer, so that it says what is
	// installed and signed in here, which READY reads. The probe asks a few CLIs; a wedged one is not
	// waited for any longer than this.
	managedStartupProbeWait = 20 * time.Second
	// How soon a first beat that was refused or went unanswered is sent again.
	managedStartupBeatRetry = 2 * time.Second
)

// managedStartupBeat sends a managed instance's first heartbeat once the engine probe has answered
// (`probed` closed) or probeWait has passed, and again every retry while beat reports it was not
// taken. It stops when one is taken, when ctx ends (the instance is stopping and claims nothing), or
// once limit has passed since it began, by when the ticker's own first beat is due. It answers whether
// a beat was taken.
func managedStartupBeat(ctx context.Context, probed <-chan struct{}, probeWait, retry, limit time.Duration, beat func() bool) bool {
	deadline := time.NewTimer(limit)
	defer deadline.Stop()
	probeTimer := time.NewTimer(probeWait)
	defer probeTimer.Stop()
	select {
	case <-probed:
	case <-probeTimer.C:
	case <-ctx.Done():
		return false
	case <-deadline.C:
		return false
	}
	for {
		if beat() {
			return true
		}
		again := time.NewTimer(retry)
		select {
		case <-again.C:
		case <-ctx.Done():
			again.Stop()
			return false
		case <-deadline.C:
			again.Stop()
			return false
		}
	}
}
