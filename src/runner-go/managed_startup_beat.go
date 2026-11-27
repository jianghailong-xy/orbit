package main

import (
	"context"
	"fmt"
	"time"
)

// runnerProcessStarted is when this process began, as near as Go can say: what the startup line measures a managed
// instance's first heartbeat from.
var runnerProcessStarted = time.Now()

// startupBeatTiming is what a managed instance's first heartbeat took, as the runner logs it (startupBeatLine).
type startupBeatTiming struct {
	taken bool
	// How long it waited before the first attempt, and whether the engine probe had answered by then (else
	// managedStartupProbeWait ran out, or the instance stopped).
	waited time.Duration
	probed bool
	// How many beats were sent, and how long the last one took from its send to its answer.
	attempts      int
	lastRoundTrip time.Duration
	// From the process's start to the end of the last attempt.
	sinceStart time.Duration
}

// startupBeatLine says where a managed instance's first heartbeat spent its time, so that a slow start says whether it
// waited for the engine probe, for the control plane's answer, or for attempts the control plane refused.
func startupBeatLine(t startupBeatTiming) string {
	outcome := "taken"
	if !t.taken {
		outcome = "not taken"
	}
	probe := "after the engine probe answered"
	if !t.probed {
		probe = "without the engine probe's answer"
	}
	return fmt.Sprintf("startup heartbeat: %s, %s after the runner started: waited %s, %s; %d attempt(s), the last answered in %s",
		outcome, roundedDuration(t.sinceStart), roundedDuration(t.waited), probe, t.attempts, roundedDuration(t.lastRoundTrip))
}

// A managed instance's first heartbeat goes before its first claim (docs/managed-runner-design.md,
// "Implementation record: capacity, wake and sleep"). The manager makes a mapping READY only on a
// heartbeat newer than the instance's start that reports a runtime it can run
// (src/apiserver/src/managed-runners/managed-runner-manager.ts, `starting`), and the ticker's first beat
// comes half a minute after the start. An instance woken from sleep claimed and answered turns all that
// time while its mapping still read STARTING, and an auto retry, which waits for READY, waited as long
// (T06, 2026-10-18). A self-managed runner has no READY to reach and claims at once, as it always has;
// its first heartbeat follows its reclaim (runLoop).
const (
	// How long the first beat waits for the engine probe's first answer, so that it says what is
	// installed and signed in here, which READY reads. The probe asks a few CLIs; a wedged one is not
	// waited for any longer than this.
	managedStartupProbeWait = 20 * time.Second
	// How soon a first beat that was refused or went unanswered is sent again.
	managedStartupBeatRetry = 2 * time.Second
)

// beatOnceProbed asks for a beat when the engine probe first answers, for a self-managed runner, whose
// first heartbeat does not wait for it: the machine's engines reach the control plane seconds after it
// comes up rather than at the next tick.
func beatOnceProbed(ctx context.Context, probed <-chan struct{}, beat func()) {
	select {
	case <-probed:
		beat()
	case <-ctx.Done():
	}
}

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
