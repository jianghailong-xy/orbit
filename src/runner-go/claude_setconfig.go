package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Changing a running session's model, permission mode or reasoning effort without taking
// its process away.
//
// All three used to be spawn flags and nothing else, so the only way to change any of them
// was to build another process: `reload` applied the new values to job.Agent, killed
// claude, and let the outer loop bring it back with --resume. That works, but it costs the
// session its process for every model switch, and — because a re-spawn mid-turn would
// abort the turn it is meant to configure — the control plane had to hold the change until
// the engine was idle. A person who changed the model while a turn was running watched it
// not take effect until the turn ended.
//
// None of the three is actually built into the process. A resident CLI can be told about
// each over the control channel it already services for interrupts, so `setconfig` carries
// them instead, and this file turns one such turn into the requests that say so. Only the
// provider environment stays on `reload`: that one really is decided when the process is
// built.
//
// The fallback is the old path, unchanged. A CLI that refuses the request, never answers
// it, or is too old to act on it gets the re-spawn it would have got before this existed —
// which is why the new values are written to job.Agent either way (session.go).

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
// agent, what to call it when a person has to be told what happened to it, and the oldest
// CLI that may be sent it.
type setConfigFrame struct {
	subtype string
	payload map[string]interface{}
	apply   func(*AgentExecConfig)
	what    string
	// minEngine is the lowest CLI version known to ACT on this frame, or "" when the
	// engine's own answer settles that (see unsupportedBy).
	minEngine string
}

// claudeEffortFloor is the oldest `claude` Orbit will send an effortLevel to.
//
// Version-gated because this one frame has no readback. set_model and set_permission_mode
// answer for themselves — a CLI that does not know the subtype, the mode or the model says
// so, and the runner degrades on its words. apply_flag_settings answers `{"subtype":
// "success"}` unconditionally: an unknown settings key, a level that is not a level, an
// empty settings object and a version that never had the feature all get the same success,
// none of them change anything, and no status frame or init field reports the effort in
// force afterwards. So "it replied success" is not evidence, and an implementation built on
// it would leave the control plane showing an effort the engine is not using — with nothing
// anywhere saying so. The version the process itself announced is the only thing left to
// judge on, and a process that has announced nothing is judged as not able (unsupportedBy).
//
// 2.1.235 is the oldest version the behaviour was measured on (request bodies captured
// through a recording proxy: the frame moved `output_config.effort` on 2.1.235, 2.1.238 and
// 2.1.241, against a paired control that did not send it). It is a floor, not a discovery of
// where support began — anything older simply has not been checked, and is re-spawned.
//
// The measurement also fixes one thing this runner must NOT do: `CLAUDE_CODE_EFFORT_LEVEL`
// in the engine's environment makes the frame inert — still answered `success`, still
// changing nothing. Orbit does not set it (claude_spawn.go passes --effort and nothing
// else), and must not start: doing so would silently turn every effort change back into a
// lie, in exactly the way no test here could catch.
const claudeEffortFloor = "2.1.235"

// errEngineCannotApply is a frame that was never sent, because the process it was for
// cannot be trusted to act on it. Handled exactly like a refusal — the values still land on
// job.Agent and the re-spawn still carries them — and worded so the transcript's degraded
// notice says which engine, and against what.
var errEngineCannotApply = errors.New("this engine cannot apply it to a running session")

// unsupportedBy reports why this frame must not be handed to a process announcing
// `version`, or nil when it may go. "" is a process that has not announced one yet: the CLI
// names its version in the init handshake it emits at the start of each turn, so a spawn
// that has not been asked for a turn yet is genuinely unknown — and unknown is degraded
// rather than assumed, since assuming is how an effort change goes missing in silence.
func (f setConfigFrame) unsupportedBy(version string) error {
	if f.minEngine == "" || claudeVersionAtLeast(version, f.minEngine) {
		return nil
	}
	if version == "" {
		return fmt.Errorf("%w — it has not said which version it is, and the setting is only known to take effect on %s and newer",
			errEngineCannotApply, f.minEngine)
	}
	return fmt.Errorf("%w — it is %s, and the setting is only known to take effect on %s and newer",
		errEngineCannotApply, version, f.minEngine)
}

// claudeVersionAtLeast compares two dotted CLI versions numerically, so 2.1.241 is newer
// than 2.1.9 (which a string compare gets backwards) and 3.0.0 is newer than either. A
// version it cannot read at all is not at least anything: the caller degrades, which is the
// safe direction for a frame whose effect cannot be checked.
func claudeVersionAtLeast(version, floor string) bool {
	have, want := versionNumbers(version), versionNumbers(floor)
	if len(have) == 0 {
		return false
	}
	for i, w := range want {
		h := 0
		if i < len(have) {
			h = have[i]
		}
		if h != w {
			return h > w
		}
	}
	return true
}

// versionNumbers reads the leading number out of each dotted component, so a pre-release
// like "2.1.235-rc.1" is still recognisably 2.1.235. Returns nil for anything whose first
// component is not a number, which is how "unreadable" reaches claudeVersionAtLeast.
func versionNumbers(version string) []int {
	var out []int
	for _, part := range strings.Split(strings.TrimSpace(version), ".") {
		digits := 0
		for digits < len(part) && part[digits] >= '0' && part[digits] <= '9' {
			digits++
		}
		if digits == 0 {
			break
		}
		n, err := strconv.Atoi(part[:digits])
		if err != nil {
			break
		}
		out = append(out, n)
	}
	return out
}

// setConfigFrames reads one `setconfig` payload and returns the control requests that
// actually change something.
//
// The control plane sends the whole committed model/mode pair every time — the turn says
// what the session's config now IS, not which half of it moved — so which fields are news is
// decided here, against the values this process is running with. It matters beyond a wasted
// round trip: a refusal falls back to a re-spawn, so asking the CLI to load the model it
// already has is a way to lose the process over a setting that never changed.
//
// For those two an empty string is "not stated" rather than "clear it", exactly as `reload`
// reads the same fields — neither a model nor a permission mode has an empty value to be set
// to. Effort does have one, so it is a *string and is stated only when the PATCH moved it:
// a session with no effort of its own inherits its WORKSPACE's at claim time, so "the
// session's committed effort" is not what this process is running, and restating it every
// time would clear a workspace default nobody touched. Absent and null both read as nil,
// and both mean the same thing here — say nothing about effort.
func setConfigFrames(content string, agent AgentExecConfig) ([]setConfigFrame, error) {
	var cfg struct {
		Model          string  `json:"model"`
		PermissionMode string  `json:"permissionMode"`
		Effort         *string `json:"effort"`
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
	if cfg.Effort != nil && *cfg.Effort != agent.Effort {
		effort := *cfg.Effort
		// null, not "" and not an omitted key: null is what tells the CLI to go back to the
		// model's own default, which is precisely what Orbit's empty effort means and what
		// dropping --effort does at spawn. An empty string here would be a level that is not
		// a level — answered `success`, and ignored.
		var level interface{}
		if effort != "" {
			level = effort
		}
		out = append(out, setConfigFrame{
			subtype:   ctrlApplyFlagSettings,
			payload:   map[string]interface{}{"settings": map[string]interface{}{"effortLevel": level}},
			apply:     func(a *AgentExecConfig) { a.Effort = effort },
			what:      effortName(effort),
			minEngine: claudeEffortFloor,
		})
	}
	return out, nil
}

// effortName is what a person is told this frame was about, including the one case with no
// value to name: clearing an effort hands the model back its own default.
func effortName(effort string) string {
	if effort == "" {
		return "reasoning effort (back to the model default)"
	}
	return `reasoning effort "` + effort + `"`
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
