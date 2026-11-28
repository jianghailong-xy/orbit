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
// account without it, it starts in Default and says so only in the frames that name its mode (measured
// on Claude Code 2.1.280, claude_models.go, and again on 2.1.332). Nothing else reports it, so a session
// could run its turns in Default while everything Orbit showed said Auto (project 350NMcNDulzkqRAFFUsXZ;
// owner ruling R1: when Auto cannot be obtained, the fix is to obtain it).
//
// So the mode a process settles on is read against the mode that process was spawned with. When the
// spawn asked for Auto and the engine settled on a narrower mode, the runner asks for Auto at once over
// the control channel, with the same set_permission_mode a setconfig turn sends (claude_setconfig.go).
// Measured on 2.1.332: a process that started in Default on a model with Auto takes the request,
// volunteers a status frame naming Auto, and the next turn's init frame reads Auto; on Haiku 4.5, which
// has no Auto, the CLI answers "Cannot set permission mode to auto: auto mode unavailable for this model";
// with permissions.disableAutoMode "disable" in its settings, "Cannot set permission mode to auto: auto
// mode disabled by settings".
//
// Where the settled mode is said: the init frame names the mode the turn starts in, but the CLI also
// names its mode in system/status frames, and the two do not always agree. Signed in with an account
// whose Auto gate is on and with disableAutoMode set, 2.1.332 names Default in a status frame, before or
// after an init frame that may name Auto (task 354kzrnSltZOM5gAfavxq saw init Auto, then status Default,
// on a real login; claude_mode_correction_real_cli_test.go records status Default, then init Default).
// So every top-level init and status frame that names a mode is a reading, and the latest one is the
// mode the engine runs in. Each is reported as the engine's own word, in the Agent Tools report
// (agentToolsReporter.sendMode), whenever it differs from the one reported last.
//
// What is judged is the first turn's: the readings from the process's first init frame to the end of
// its first turn (its first top-level result). The init frame comes before the turn's first API call,
// and a status frame after it settles what the init frame named, so a correction sent on either is
// answered long before the first tool of that turn is judged. A status frame before the first init is
// reported by nothing (there is no report to restate yet) and judged by nothing: the init frame that
// follows it names the mode the turn starts in. After the first turn, a narrower reading is the engine
// moving by itself (a model entering Plan) or the owner picking another mode; neither is the engine
// settling below what it was started with, and correcting either would undo a decision someone made.
// For the same reason a status frame naming Plan inside the first turn ends the judging: settling falls
// back to Default, never to Plan, so Plan there is the model's EnterPlanMode.
//
// Either outcome is a system event. permission_mode_corrected is recorded by the control plane as a
// mode change the runner made (RUNNER_CORRECTION, apiserver sessions/actual-permission-mode.ts), after
// the report of the lower mode (the Agent Tools report, sent first). The failure carries the engine's
// words. There is one attempt per process and no retry: a refusal is the engine's answer for this model
// and account, and asking again at every reading would only repeat it. A re-spawn is a new process and
// makes its own attempt.

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
	// initSeen is set by the process's first top-level init frame, which opens the judging.
	initSeen bool
	// judged is set once a correction was sent, once the first turn has ended, once the model entered
	// Plan in it, or once the mode was asked for since: from then on nothing is judged.
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

// supersede is called before a setconfig turn tells the engine a mode: the owner's pick, or a change Orbit
// made. From then on the engine's mode is that request's to settle: a reading after it reports the mode
// that was asked for, which is no settling below the spawn's, and a correction already on
// its way is not reported as the mode the session runs in, since the setconfig's request is behind it in
// the same queue.
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
	// settled is the mode the engine's init or status frame named.
	settled string
	waiter  *controlWaiter
	// err is why the request could not be sent at all.
	err error
}

// claudeEngineModeReading is the mode a top-level init or status frame names, if it names one.
func claudeEngineModeReading(msg map[string]interface{}) (string, bool) {
	if msg["type"] != "system" || (msg["subtype"] != "init" && msg["subtype"] != "status") || msg["parent_tool_use_id"] != nil {
		return "", false
	}
	mode, _ := msg["permissionMode"].(string)
	return mode, mode != ""
}

// begin judges one stdout frame. For a mode reading in the first turn that is owed a correction, it sends
// the correction and returns it; for anything else it returns nil. Called on the stdout reader with every
// frame: sending never blocks (requestControlWith only takes a place in the write queue), and the answer,
// which arrives on that same reader, is waited for by report on a goroutine of its own.
func (c *claudeModeCorrection) begin(rt *claudeRuntime, msg map[string]interface{}) *pendingModeCorrection {
	c.mu.Lock()
	defer c.mu.Unlock()
	if msg["type"] == "system" && msg["subtype"] == "init" && msg["parent_tool_use_id"] == nil {
		c.initSeen = true
	}
	if c.judged || !c.initSeen {
		return nil
	}
	if msg["type"] == "result" {
		c.judged = true
		return nil
	}
	settled, ok := claudeEngineModeReading(msg)
	if !ok || c.spawned != claudeAutoPermissionMode {
		return nil
	}
	if msg["subtype"] == "status" && settled == "plan" {
		c.judged = true
		return nil
	}
	if !claudeModeBelowAuto(settled) {
		return nil
	}
	c.judged = true
	p := &pendingModeCorrection{settled: settled}
	p.waiter, p.err = rt.requestControlWith(ctrlSetPermissionMode, map[string]interface{}{"mode": claudeAutoPermissionMode})
	return p
}

// claudeEngineModeFrame is what the stdout reader does with one frame for the mode the engine runs in:
// an init frame becomes the session's Agent Tools report, which names its mode; a status frame naming a
// mode restates that report with it; and then the correction judges the frame. The report goes first, so
// the control plane, which records both in the order they are sent, records the lower mode and then the
// correction. A correction it returns is the caller's to report.
func claudeEngineModeFrame(job *ClaimedSession, rt *claudeRuntime, msg map[string]interface{}, agentTools *agentToolsReporter, modeFix *claudeModeCorrection, emit emitFn) *pendingModeCorrection {
	if msg["type"] == "system" && msg["subtype"] == "init" && msg["parent_tool_use_id"] == nil {
		agentTools.send(claudeAgentToolsReport(job, msg), emit)
	} else if mode, ok := claudeEngineModeReading(msg); ok {
		agentTools.sendMode(mode, emit)
	}
	return modeFix.begin(rt, msg)
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
			", but a setconfig has sent the engine a mode since; that change reports the mode the engine runs in")
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
		// is a new process, which judges its own first turn. An explicit refusal is still reported: it is a
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
