package main

import (
	"encoding/json"
	"strings"
)

// Changing a running session's model or permission mode without taking its process away.
//
// Both settings used to be spawn flags and nothing else, so the only way to change either
// was to build another process: `reload` applied the new values to job.Agent, killed
// claude, and let the outer loop bring it back with --resume. That works, but it costs the
// session its process for every model switch, and — because a re-spawn mid-turn would
// abort the turn it is meant to configure — the control plane had to hold the change until
// the engine was idle. A person who changed the model while a turn was running watched it
// not take effect until the turn ended.
//
// Neither setting is actually built into the process. A resident CLI can be told about
// both over the control channel it already services for interrupts, so `setconfig` carries
// them instead, and this file turns one such turn into the requests that say so. Effort
// and the provider environment stay on `reload`: those really are decided when the process
// is built.
//
// The fallback is the old path, unchanged. A CLI that refuses the request or never answers
// it gets the re-spawn it would have got before this existed — which is why the new values
// are written to job.Agent either way (session.go).

// claudeSetConfigTimeout bounds the wait for a set_model / set_permission_mode answer.
//
// The same deadline an interrupt gets, for the same reason: the CLI services its control
// channel independently of whatever tool it is running, so silence this long after the
// frame reached its stdin means it is not servicing control at all. The difference is what
// happens next — an interrupt that goes unanswered is reported and nothing else can be
// done, while this one still has the re-spawn to fall back on.
const claudeSetConfigTimeout = claudeInterruptTimeout

// setConfigFrame is one control_request a `setconfig` turn resolves to: the subtype, the
// argument that rides beside it in the same request object, the field it settles on the
// agent, and what to call it when a person has to be told what happened to it.
type setConfigFrame struct {
	subtype string
	payload map[string]interface{}
	apply   func(*AgentExecConfig)
	what    string
}

// setConfigFrames reads one `setconfig` payload and returns the control requests that
// actually change something.
//
// The control plane sends the whole committed pair every time — the turn says what the
// session's config now IS, not which half of it moved — so which fields are news is decided
// here, against the values this process is running with. It matters beyond a wasted round
// trip: a refusal falls back to a re-spawn, so asking the CLI to load the model it already
// has is a way to lose the process over a setting that never changed.
//
// An empty string is "not stated" rather than "clear it", exactly as `reload` reads the same
// two fields — neither a model nor a permission mode has an empty value to be set to.
func setConfigFrames(content string, agent AgentExecConfig) ([]setConfigFrame, error) {
	var cfg struct {
		Model          string `json:"model"`
		PermissionMode string `json:"permissionMode"`
	}
	if err := json.Unmarshal([]byte(content), &cfg); err != nil {
		return nil, err
	}
	var out []setConfigFrame
	if model := cfg.Model; model != "" && model != agent.Model {
		out = append(out, setConfigFrame{
			subtype: ctrlSetModel,
			payload: map[string]interface{}{"model": model},
			apply:   func(a *AgentExecConfig) { a.Model = model },
			what:    `model "` + model + `"`,
		})
	}
	if mode := cfg.PermissionMode; mode != "" && mode != agent.PermissionMode {
		out = append(out, setConfigFrame{
			subtype: ctrlSetPermissionMode,
			payload: map[string]interface{}{"mode": mode},
			apply:   func(a *AgentExecConfig) { a.PermissionMode = mode },
			what:    `permission mode "` + mode + `"`,
		})
	}
	return out, nil
}

// setConfigApplied says what a set of frames did, for a log line and for the turn's own
// result. A payload that restates the running config asks for none, which is a real
// outcome rather than a silence: the control plane sends one of these for every config
// PATCH, including the ones where only effort moved.
func setConfigApplied(frames []setConfigFrame) string {
	if len(frames) == 0 {
		return "nothing to change"
	}
	parts := make([]string, 0, len(frames))
	for _, f := range frames {
		parts = append(parts, f.what)
	}
	return "applied to the running engine: " + strings.Join(parts, ", ")
}

// setConfigDegradedNotice is what the transcript says when a change that was supposed to
// land quietly has to become a re-spawn instead.
//
// It says three things, because a session that simply goes quiet for a few seconds says
// none of them: the change is not lost, the engine is restarting rather than wedged, and
// what the engine's own objection was. Reporting a degradation is the point — the failure
// this replaces is a control frame that was refused and then covered up by a re-spawn that
// looked, from the outside, exactly like the feature working.
func setConfigDegradedNotice(cause error) string {
	return "Could not change " + cause.Error() +
		". Restarting the engine with the new settings instead — the conversation is resumed in full, and nothing is lost."
}

// subtypeSetConfig marks the completion of a `setconfig` turn.
//
// Always SUCCEEDED, on both paths, and that is not a rounding-up of the degraded one. The
// status answers what became of the TURN, and a turn that ended in a re-spawn was carried
// out — by the slower route, which the transcript's notice says out loud. FAILED means
// something else here: a failed turn terminalizes the Session (turnCompletionEndsSession),
// so reporting a fallback that worked as a failure would end a healthy conversation over a
// setting that did, in the end, change.
const subtypeSetConfig = "setconfig"

// settleSetConfigTurn closes a `setconfig` turn's own row, whatever became of the request.
//
// Unconditional on purpose. Today's control plane acks control turns as it delivers them,
// so this is usually an idempotent no-op — but "usually a no-op" is not a reason for a
// runner to leave a turn it was handed unanswered, and the runner is the only side that
// knows whether the frames landed. It settles the row and nothing else: no numTurns (a
// control frame is not a turn of the conversation), and no bearing on the session's status.
func settleSetConfigTurn(turnID, result string, job *ClaimedSession, completeTurn turnCompleter) {
	if err := completeTurn(TurnCompleteRequest{
		TurnID:           turnID,
		Status:           stSucceeded,
		Result:           result,
		Subtype:          subtypeSetConfig,
		RuntimeSessionID: currentRuntimeSessionID(job),
		BranchSha:        effectiveBranchSha(job.WT),
	}); err != nil {
		logln("setconfig turn-complete failed for", job.SessionID+":", err)
	}
}
