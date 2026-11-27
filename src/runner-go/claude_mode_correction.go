package main

import (
	"context"
	"errors"
	"sync"
)

// Putting a Claude engine that settled below the Auto it was spawned with back in Auto, once, and
// saying what came of it.
//
// The CLI does not refuse a mode it cannot run. Asked for Auto (--permission-mode auto) on a model or
// account without it, it starts in Default and says so only in the init frame it writes at the start
// of the turn (measured on Claude Code 2.1.280, claude_models.go, and again on 2.1.332). Nothing else
// reports it, so a session could run its turns in Default while everything Orbit showed said Auto
// (project 350NMcNDulzkqRAFFUsXZ; owner ruling R1: when Auto cannot be obtained, the fix is to obtain
// it).
//
// So the first init frame of every process is read against the mode that process was spawned with.
// When the spawn asked for Auto and the engine settled on a narrower mode, the runner asks for Auto at
// once over the control channel, with the same set_permission_mode a setconfig turn sends
// (claude_setconfig.go). The init frame comes before the turn's first API call, so the request is
// answered long before the first tool of that turn is judged. Measured on 2.1.332: a process that
// started in Default on a model with Auto takes the request, volunteers a status frame naming Auto,
// and the next turn's init frame reads Auto; on Haiku 4.5, which has no Auto, the CLI answers "Cannot
// set permission mode to auto: auto mode unavailable for this model".
//
// Either outcome is a system event. permission_mode_corrected is recorded by the control plane as a
// mode change the runner made (RUNNER_CORRECTION, apiserver sessions/actual-permission-mode.ts), after
// the init frame's own report of the lower mode (the Agent Tools report, sent first). The failure
// carries the engine's words. There is one attempt per process and no retry: a refusal is the engine's
// answer for this model and account, and asking again at every turn's init frame would only repeat it.
// A re-spawn is a new process and makes its own attempt.
//
// Only the first init frame is judged. A later one can be narrower because the engine moved by itself
// (a model entering Plan) or because the owner picked another mode; neither is the engine settling
// below what it was started with, and correcting either would undo a decision someone made.

// The system event subtypes the two outcomes travel as. The first is @orbit/shared's
// PERMISSION_MODE_CORRECTED_EVENT_SUBTYPE, the second its PERMISSION_MODE_CORRECTION_FAILED_EVENT_SUBTYPE.
const (
	permissionModeCorrectedSubtype        = "permission_mode_corrected"
	permissionModeCorrectionFailedSubtype = "permission_mode_correction_failed"
)

// claudeAutoPermissionMode is the mode this file obtains.
const claudeAutoPermissionMode = "auto"

// claudeModeBelowAuto reports whether a mode the engine names is narrower than Auto: one that asks
// (Default, Accept Edits), plans only (Plan), or refuses whatever was not pre-approved (Don't Ask). Bypass
// is wider, and a mode this runner does not know is not ranked at all, so neither is ever "corrected".
func claudeModeBelowAuto(mode string) bool {
	switch mode {
	case "default", "acceptEdits", "plan", "dontAsk":
		return true
	}
	return false
}

// claudeModeCorrection is one process's single chance to correct the mode its engine settled on.
type claudeModeCorrection struct {
	// spawned is the --permission-mode the process was started with: the mode it was asked for.
	spawned string

	mu sync.Mutex
	// judged is set once the first init frame has been read, or once the mode was asked for since.
	judged bool
	// superseded is set when a setconfig turn tells the engine a mode of its own (supersede).
	superseded bool
}

// newClaudeModeCorrection reads the mode a process is spawned with off its argv.
func newClaudeModeCorrection(args []string) *claudeModeCorrection {
	c := &claudeModeCorrection{}
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--permission-mode" {
			c.spawned = args[i+1]
		}
	}
	return c
}

// supersede is called before a setconfig turn tells the engine a mode. From then on the engine's mode is
// that request's to settle: a first init frame read after it reports the mode a person asked for, which
// is no settling below the spawn's, and a correction already on its way is not reported as the mode the
// session runs in, since the person's request is behind it in the same queue.
//
// It and begin hold one lock, so a correction is either written to stdin before the setconfig's frame,
// or not written at all.
func (c *claudeModeCorrection) supersede() {
	c.mu.Lock()
	c.judged, c.superseded = true, true
	c.mu.Unlock()
}

func (c *claudeModeCorrection) wasSuperseded() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.superseded
}

// pendingModeCorrection is a set_permission_mode the runner sent (or failed to send) on its own.
type pendingModeCorrection struct {
	// settled is the mode the engine's init frame named.
	settled string
	waiter  *controlWaiter
	// err is why the request could not be sent at all.
	err error
}

// begin judges one stdout frame. For the process's first top-level init frame, it sends the correction
// when one is owed and returns it; for anything else, and when nothing is owed, it returns nil. Called on
// the stdout reader: sending never blocks (requestControlWith only takes a place in the write queue), and
// the answer, which arrives on that same reader, is waited for by report on a goroutine of its own.
func (c *claudeModeCorrection) begin(rt *claudeRuntime, msg map[string]interface{}) *pendingModeCorrection {
	if msg["type"] != "system" || msg["subtype"] != "init" || msg["parent_tool_use_id"] != nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.judged {
		return nil
	}
	c.judged = true
	settled, _ := msg["permissionMode"].(string)
	if c.spawned != claudeAutoPermissionMode || !claudeModeBelowAuto(settled) {
		return nil
	}
	p := &pendingModeCorrection{settled: settled}
	p.waiter, p.err = rt.requestControlWith(ctrlSetPermissionMode, map[string]interface{}{"mode": claudeAutoPermissionMode})
	return p
}

// report waits for the engine's answer to a correction and says what came of it: in the log, and as the
// system event the control plane records.
func (c *claudeModeCorrection) report(ctx context.Context, rt *claudeRuntime, p *pendingModeCorrection, emit emitFn, sessionID string) {
	err := p.err
	if err == nil {
		err = rt.awaitControl(ctx, p.waiter, claudeSetConfigTimeout)
	}
	refused := p.waiter != nil && p.waiter.resp.Subtype == ctrlError
	switch {
	case err == nil && c.wasSuperseded():
		logln("interactive run", sessionID, "— permission mode: the engine took Auto after settling on", p.settled+
			", but a mode the owner picked has been sent since; that change reports the mode the engine runs in")
	case err == nil:
		logln("interactive run", sessionID, "— permission mode: the engine settled on", p.settled,
			"although it was spawned in Auto; switched it to Auto")
		emit(evSystem, map[string]interface{}{
			"subtype": permissionModeCorrectedSubtype,
			"mode":    claudeAutoPermissionMode,
			"from":    p.settled,
		})
	case !refused && (ctx.Err() != nil || errors.Is(err, errRuntimeGone) || errors.Is(err, errRuntimeClosed)):
		// The process is going away under the request, and its teardown owns what happens next. A re-spawn
		// is a new process, which judges its own init frame. An explicit refusal is still reported: it is a
		// completed answer even when the process exits right after giving it.
		logln("interactive run", sessionID, "— permission mode: switching the engine from", p.settled, "to Auto abandoned:", err)
	default:
		logln("interactive run", sessionID, "— permission mode: the engine settled on", p.settled,
			"although it was spawned in Auto, and could not be switched to Auto:", err)
		emit(evSystem, map[string]interface{}{
			"subtype":   permissionModeCorrectionFailedSubtype,
			"mode":      p.settled,
			"requested": claudeAutoPermissionMode,
			"reason":    err.Error(),
		})
	}
}
