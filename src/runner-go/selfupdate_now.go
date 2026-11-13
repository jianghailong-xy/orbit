package main

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"time"
)

// The owner's Update Now (HeartbeatResponse.SelfUpdateNow, docs/runner-update-drain-design.md §4,
// D4): install the waiting release now, interrupting the turns in flight. It is the self-update stop
// an idle runner takes, with two differences, both because the owner said "interrupt these turns":
// the pool closes for the update with turns still in flight (sessionPool.closeForUpdateNow), and the
// stop gives an engine's turn no drain at all (stopDrainBudget) — it is cut at once, marked
// interrupted with reason runner_update, and its session detaches resumable, as any runner stop's
// does. The updated image reclaims each session and the control plane hands the cut turn back as the
// update's continuation. An automatic update still never interrupts a turn (closeForUpdate).

// selfUpdateNowCapabilityV1 declares that this runner honours Update Now: @orbit/shared's
// SELF_UPDATE_NOW_V1. The control plane refuses Update Now for a runner that does not declare it.
const selfUpdateNowCapabilityV1 = "self-update-now/v1"

// The interrupt event's reasons: a turn a runner stop cut once its drain ran out, and one the owner's
// Update Now cut (@orbit/shared RUNNER_UPDATE_INTERRUPT_REASON).
const (
	interruptReasonRunnerRestart = "runner_restart"
	interruptReasonRunnerUpdate  = "runner_update"
)

// errRunnerUpdateNow is the cause runLoop stops with for Update Now. It wraps errRunnerSelfUpdate:
// the stop re-executes like any self-update, so the sessions' background jobs are handed on.
var errRunnerUpdateNow = fmt.Errorf("%w on the owner's Update Now, interrupting the turns in flight", errRunnerSelfUpdate)

// updateNowTarget is the release Update Now restarts into, for the interrupt events it causes.
var updateNowTarget atomic.Pointer[string]

// stoppingForUpdateNow is whether shutdownCtx ended for the owner's Update Now.
func stoppingForUpdateNow(shutdownCtx context.Context) bool {
	return shutdownCtx.Err() != nil && errors.Is(context.Cause(shutdownCtx), errRunnerUpdateNow)
}

// stopDrainBudget is how long a turn in flight may go on once the runner's stop has begun: drain
// (shutdownDrainTimeout) for every stop but Update Now, which cuts it at once.
func stopDrainBudget(shutdownCtx context.Context, drain time.Duration) time.Duration {
	if stoppingForUpdateNow(shutdownCtx) {
		return 0
	}
	return drain
}

// stopInterruptPayload is the interrupt event a runner stop marks a cut turn with: the reason names
// the cause, and an Update Now names the release too, which the control plane's continuation and the
// clients' "interrupted — the runner updated to 0.1.254" read.
func stopInterruptPayload(shutdownCtx context.Context) map[string]interface{} {
	if !stoppingForUpdateNow(shutdownCtx) {
		return map[string]interface{}{"reason": interruptReasonRunnerRestart}
	}
	payload := map[string]interface{}{"reason": interruptReasonRunnerUpdate}
	if target := updateNowTarget.Load(); target != nil && *target != "" {
		payload["targetVersion"] = *target
	}
	return payload
}

// updateNowRestart is what the image an update restarts into reports about the restart: when the
// stop began and how many turns an Update Now interrupted for it (selfUpdateRecord), for the Updated card.
var updateNowRestart struct {
	startedAt   atomic.Pointer[time.Time]
	interrupted atomic.Int32
}

func noteUpdateRestart(at time.Time, interrupted int) {
	updateNowRestart.startedAt.Store(&at)
	updateNowRestart.interrupted.Store(int32(interrupted))
}
