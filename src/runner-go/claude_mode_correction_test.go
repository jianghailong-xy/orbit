package main

import (
	"strings"
	"testing"
)

// A Claude engine that settles below the Auto it was spawned with, driven through the real session loop
// against the fake CLI over its real stdin/stdout (claude_mode_correction.go).
//
// The fake answers the way the real CLI was measured to (Claude Code 2.1.332): a process spawned with
// --permission-mode auto that cannot have it names Default in its init frame and nowhere else; a
// set_permission_mode auto it can honour is answered with a success and a status frame naming Auto; one
// it cannot is answered with its own refusal. claude_mode_correction_real_cli_test.go holds the same
// path to the installed CLI.

// spawnedInAuto is the claim of a session whose engine is to run in Auto.
func spawnedInAuto(job *ClaimedSession) { job.Agent.PermissionMode = claudeAutoPermissionMode }

// systemEvents returns the run's system events of one subtype, in the order they were emitted.
func (r *deliverySession) systemEvents(subtype string) []RunEvent {
	var out []RunEvent
	for _, e := range r.eventsOfType(evSystem) {
		if e.Payload["subtype"] == subtype {
			out = append(out, e)
		}
	}
	return out
}

// position is the index of the first event that matches, in the order the run emitted them, or -1.
func (r *deliverySession) position(match func(RunEvent) bool) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, e := range r.events {
		if match(e) {
			return i
		}
	}
	return -1
}

// reportsEngineMode matches the Agent Tools report that carries the mode the engine's init frame named.
func reportsEngineMode(mode string) func(RunEvent) bool {
	return func(e RunEvent) bool {
		if e.Type != evSystem || e.Payload["subtype"] != agentToolsEventSubtype {
			return false
		}
		report, _ := e.Payload["agentTools"].(map[string]interface{})
		return report["permissionMode"] == mode
	}
}

// The whole correction: the engine spawned in Auto settles on Default, the runner asks for Auto at once,
// the engine takes it, and the run says so in the event the control plane records as a runner correction.
func TestSessionSwitchesAnEngineThatSettledBelowAutoToAuto(t *testing.T) {
	run := runDeliverySessionWith(t,
		[]fakeStep{
			{Await: "user"},
			{Emit: "system_init", PermissionMode: "default"},
			{Emit: "replay_user"},
			// Asked within the first turn, before it has produced anything: the correction does not wait
			// for the turn to end.
			{Await: "control_request", Subtype: ctrlSetPermissionMode},
			{Emit: "control_response"},
			{Emit: "system_status", PermissionMode: "auto"},
			{Emit: "assistant", Text: "working on it"},
			{Emit: "result", Text: "done"},
			{Emit: "eof"},
		},
		[]scriptedTurn{messageTurn("turn-1", "do the work")},
		nil, deliveryOptions{claim: spawnedInAuto})

	requests := controlRequestsOfSubtype(run.fake, ctrlSetPermissionMode)
	if len(requests) != 1 {
		t.Fatalf("the CLI received %d set_permission_mode request(s), want exactly 1", len(requests))
	}
	if got := requests[0]["mode"]; got != claudeAutoPermissionMode {
		t.Errorf("the CLI was asked for mode %v, want %q", got, claudeAutoPermissionMode)
	}
	waitUntil(t, func() bool { return len(run.systemEvents(permissionModeCorrectedSubtype)) > 0 },
		"the run never reported the correction")
	corrected := run.systemEvents(permissionModeCorrectedSubtype)
	if len(corrected) != 1 {
		t.Fatalf("the run reported %d corrections, want exactly 1", len(corrected))
	}
	if got := corrected[0].Payload; got["mode"] != claudeAutoPermissionMode || got["from"] != "default" {
		t.Errorf("the correction reads %v, want mode %q from %q", got, claudeAutoPermissionMode, "default")
	}
	// The lower mode is reported before the correction, so the control plane, which records both in the
	// order they were sent, ends on Auto.
	lower := run.position(reportsEngineMode("default"))
	fixed := run.position(func(e RunEvent) bool {
		return e.Type == evSystem && e.Payload["subtype"] == permissionModeCorrectedSubtype
	})
	if lower < 0 || lower > fixed {
		t.Errorf("the Agent Tools report naming Default is at %d and the correction at %d; want the report first", lower, fixed)
	}
	if failed := run.systemEvents(permissionModeCorrectionFailedSubtype); len(failed) != 0 {
		t.Errorf("a correction the engine took was also reported as failed: %v", failed)
	}
	if run.reload {
		t.Error("a correction the engine took asked the supervisor to re-spawn")
	}
}

// A CLI that will not take Auto (Haiku 4.5's answer, verbatim) is reported with its own words, and asked
// once: the init frames of the turns after it name Default again, and none of them is asked again.
func TestSessionReportsAnEngineThatRefusesAutoAndAsksOnlyOnce(t *testing.T) {
	const refusal = "Cannot set permission mode to auto: auto mode unavailable for this model"
	run := runDeliverySessionWith(t,
		[]fakeStep{
			{Await: "user"},
			{Emit: "system_init", PermissionMode: "default"},
			{Emit: "replay_user"},
			{Await: "control_request", Subtype: ctrlSetPermissionMode},
			{Emit: "control_response", IsError: true, Text: refusal},
			{Emit: "result", Text: "first"},
			{Await: "user"},
			{Emit: "system_init", PermissionMode: "default"},
			{Emit: "replay_user"},
			{Emit: "result", Text: "second"},
			// The third turn's frame is written after anything the runner sent on the second init frame,
			// so a second request would already be on the fake's record when this is read.
			{Await: "user"},
			{Emit: "system_init", PermissionMode: "default"},
			{Emit: "replay_user"},
			{Emit: "result", Text: "third"},
			{Emit: "eof"},
		},
		[]scriptedTurn{messageTurn("turn-1", "one"), messageTurn("turn-2", "two"), messageTurn("turn-3", "three")},
		nil, deliveryOptions{claim: spawnedInAuto})

	if requests := controlRequestsOfSubtype(run.fake, ctrlSetPermissionMode); len(requests) != 1 {
		t.Fatalf("the CLI received %d set_permission_mode request(s) over three turns, want exactly 1", len(requests))
	}
	waitUntil(t, func() bool { return len(run.systemEvents(permissionModeCorrectionFailedSubtype)) > 0 },
		"the run never reported the refused correction")
	failed := run.systemEvents(permissionModeCorrectionFailedSubtype)
	if len(failed) != 1 {
		t.Fatalf("the run reported %d failed corrections, want exactly 1", len(failed))
	}
	got := failed[0].Payload
	if got["mode"] != "default" || got["requested"] != claudeAutoPermissionMode {
		t.Errorf("the failure reads %v, want mode %q and requested %q", got, "default", claudeAutoPermissionMode)
	}
	if reason, _ := got["reason"].(string); !strings.Contains(reason, refusal) {
		t.Errorf("the failure's reason is %q, want it to carry the engine's own words %q", reason, refusal)
	}
	if corrected := run.systemEvents(permissionModeCorrectedSubtype); len(corrected) != 0 {
		t.Errorf("a refused correction was reported as made: %v", corrected)
	}
	if run.reload {
		t.Error("a refused correction asked the supervisor to re-spawn; the engine's answer stands")
	}
	for _, turn := range []string{"turn-1", "turn-2", "turn-3"} {
		if r := run.turnResult(turn); r == nil || r.Status != stSucceeded {
			t.Errorf("turn %s ended %+v, want it to run to its result: a refused correction ends nothing", turn, r)
		}
	}
}

// Nothing is sent where nothing is owed: an engine that settled on the Auto it was asked for, a spawn
// that asked for another mode, a settled mode wider than Auto or one this runner cannot rank, and an init
// frame that names no mode.
func TestSessionAsksForAutoOnlyWhenTheEngineSettledBelowIt(t *testing.T) {
	for _, tc := range []struct {
		name, spawned, settled string
	}{
		{"settled on the Auto it was asked for", "auto", "auto"},
		{"asked for Default and got it", "default", "default"},
		{"asked for Accept Edits and got it", "acceptEdits", "acceptEdits"},
		{"settled wider than Auto", "auto", "bypassPermissions"},
		{"settled on a mode this runner does not know", "auto", "someFutureMode"},
		{"named no mode at all", "auto", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			run := runDeliverySessionWith(t,
				[]fakeStep{
					{Await: "user"},
					{Emit: "system_init", PermissionMode: tc.settled},
					{Emit: "replay_user"},
					{Emit: "result", Text: "first"},
					// A request sent on the first init frame is written before the second turn's frame.
					{Await: "user"},
					{Emit: "replay_user"},
					{Emit: "result", Text: "second"},
					{Emit: "eof"},
				},
				[]scriptedTurn{messageTurn("turn-1", "one"), messageTurn("turn-2", "two")},
				nil, deliveryOptions{claim: func(job *ClaimedSession) { job.Agent.PermissionMode = tc.spawned }})

			if requests := controlRequestsOfSubtype(run.fake, ctrlSetPermissionMode); len(requests) != 0 {
				t.Errorf("spawned in %q and settled on %q, the CLI was asked for %v", tc.spawned, tc.settled, requests)
			}
			if n := len(run.systemEvents(permissionModeCorrectedSubtype)) + len(run.systemEvents(permissionModeCorrectionFailedSubtype)); n != 0 {
				t.Errorf("spawned in %q and settled on %q, the run reported %d correction outcome(s)", tc.spawned, tc.settled, n)
			}
		})
	}
}

// A mode the owner picks before the engine's first turn reaches the engine first, and the init frame that
// follows names it. That is the owner's Default, not the engine settling below the Auto it was spawned
// with, and switching it to Auto would overrule the owner with a wider mode than they chose.
func TestSessionLeavesAModeTheOwnerPickedBeforeTheFirstTurnAlone(t *testing.T) {
	run := runDeliverySessionWith(t,
		[]fakeStep{
			{Await: "control_request", Subtype: ctrlSetPermissionMode},
			{Emit: "control_response"},
			{Await: "user"},
			{Emit: "system_init", PermissionMode: "default"},
			{Emit: "replay_user"},
			{Emit: "result", Text: "first"},
			{Await: "user"},
			{Emit: "replay_user"},
			{Emit: "result", Text: "second"},
			{Emit: "eof"},
		},
		[]scriptedTurn{
			// The model restates the one the session runs on (claudeSpawnJob), so the only frame is the mode.
			setConfigTurn("cfg-1", "claude-opus-5", "default"),
			{turn: messageTurn("turn-1", "one").turn, after: "cfg-1"},
			messageTurn("turn-2", "two"),
		},
		nil, deliveryOptions{claim: spawnedInAuto})

	requests := controlRequestsOfSubtype(run.fake, ctrlSetPermissionMode)
	if len(requests) != 1 || requests[0]["mode"] != "default" {
		t.Fatalf("the CLI received set_permission_mode %v, want only the owner's one request for %q", requests, "default")
	}
	if n := len(run.systemEvents(permissionModeCorrectedSubtype)) + len(run.systemEvents(permissionModeCorrectionFailedSubtype)); n != 0 {
		t.Errorf("the run reported %d correction outcome(s) over a mode the owner picked", n)
	}
}

// The mode a process is judged against is the one its own argv asked for: every spawn, first or resumed,
// carries the session's mode and so its own attempt, and an Ask, which always starts in Don't Ask
// whatever its claim says (help_ask.go), is never switched to Auto.
func TestEveryClaudeSpawnIsJudgedAgainstTheModeItsArgvAskedFor(t *testing.T) {
	for _, firstSpawn := range []bool{true, false} {
		job := claudeSpawnJob(t)
		spawnedInAuto(job)
		if got := newClaudeModeCorrection(claudeCommandArgs(job, t.TempDir(), firstSpawn)).spawned; got != claudeAutoPermissionMode {
			t.Errorf("firstSpawn=%v: the correction reads the spawn's mode as %q, want %q", firstSpawn, got, claudeAutoPermissionMode)
		}
	}
	ask := claudeSpawnJob(t)
	spawnedInAuto(ask)
	ask.HelpAsk = &HelpAskMarker{}
	if got := newClaudeModeCorrection(claudeCommandArgs(ask, t.TempDir(), true)).spawned; got == claudeAutoPermissionMode {
		t.Errorf("an Ask is judged as spawned in %q; it starts in Don't Ask whatever its claim says", got)
	}
}

// What counts as below Auto is the modes that do less than it, and nothing else.
func TestClaudeModeBelowAutoRanksOnlyNarrowerModes(t *testing.T) {
	for mode, below := range map[string]bool{
		"default": true, "acceptEdits": true, "plan": true, "dontAsk": true,
		"auto": false, "bypassPermissions": false, "": false, "someFutureMode": false,
	} {
		if got := claudeModeBelowAuto(mode); got != below {
			t.Errorf("claudeModeBelowAuto(%q) = %v, want %v", mode, got, below)
		}
	}
}

// engineModeReports is the sequence of modes the run's Agent Tools reports named, in the order sent.
func (r *deliverySession) engineModeReports() []string {
	var out []string
	for _, e := range r.systemEvents(agentToolsEventSubtype) {
		report, _ := e.Payload["agentTools"].(map[string]interface{})
		mode, _ := report["permissionMode"].(string)
		out = append(out, mode)
	}
	return out
}

// The disableAutoMode case task 354kzrnSltZOM5gAfavxq measured on a real login (Claude Code 2.1.332): the
// init frame names Auto and the status frame after it names Default. The mode reported is the one the
// status frame names, and the correction is owed on it: asked once, and its outcome reported, whether the
// engine refuses it (disableAutoMode's own words) or takes it. Status frames naming Default again later
// are neither reported again nor asked about again.
func TestSessionJudgesTheModeAStatusFrameSettlesOnAfterAnInitFrameNamingAuto(t *testing.T) {
	const refusal = "Cannot set permission mode to auto: auto mode disabled by settings"
	for _, tc := range []struct {
		name    string
		answer  []fakeStep
		reports []string
	}{
		{
			name:    "refused",
			answer:  []fakeStep{{Emit: "control_response", IsError: true, Text: refusal}},
			reports: []string{"auto", "default"},
		},
		{
			name:    "taken",
			answer:  []fakeStep{{Emit: "control_response"}, {Emit: "system_status", PermissionMode: "auto"}},
			reports: []string{"auto", "default", "auto"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			steps := []fakeStep{
				{Await: "user"},
				{Emit: "system_init", PermissionMode: "auto"},
				{Emit: "replay_user"},
				{Emit: "system_status", PermissionMode: "default"},
				{Await: "control_request", Subtype: ctrlSetPermissionMode},
			}
			steps = append(steps, tc.answer...)
			steps = append(steps, []fakeStep{
				{Emit: "assistant", Text: "working on it"},
				{Emit: "result", Text: "first"},
				// The engine names Default again in the turns after: nothing new to report, nothing to ask.
				{Await: "user"},
				{Emit: "system_init", PermissionMode: "auto"},
				{Emit: "replay_user"},
				{Emit: "system_status", PermissionMode: "default"},
				{Emit: "result", Text: "second"},
				{Await: "user"},
				{Emit: "replay_user"},
				{Emit: "result", Text: "third"},
				{Emit: "eof"},
			}...)
			run := runDeliverySessionWith(t, steps,
				[]scriptedTurn{messageTurn("turn-1", "one"), messageTurn("turn-2", "two"), messageTurn("turn-3", "three")},
				nil, deliveryOptions{claim: spawnedInAuto})

			requests := controlRequestsOfSubtype(run.fake, ctrlSetPermissionMode)
			if len(requests) != 1 || requests[0]["mode"] != claudeAutoPermissionMode {
				t.Fatalf("the CLI received set_permission_mode %v over three turns, want exactly one request for %q", requests, claudeAutoPermissionMode)
			}
			outcome := permissionModeCorrectedSubtype
			if tc.name == "refused" {
				outcome = permissionModeCorrectionFailedSubtype
			}
			waitUntil(t, func() bool { return len(run.systemEvents(outcome)) > 0 }, "the run never reported the correction's outcome")
			events := run.systemEvents(outcome)
			if len(events) != 1 {
				t.Fatalf("the run reported %d %s events, want exactly 1", len(events), outcome)
			}
			got := events[0].Payload
			if tc.name == "refused" {
				if got["mode"] != "default" || got["requested"] != claudeAutoPermissionMode {
					t.Errorf("the failure reads %v, want mode %q and requested %q", got, "default", claudeAutoPermissionMode)
				}
				if reason, _ := got["reason"].(string); !strings.Contains(reason, refusal) {
					t.Errorf("the failure's reason is %q, want the engine's own words %q", reason, refusal)
				}
				if corrected := run.systemEvents(permissionModeCorrectedSubtype); len(corrected) != 0 {
					t.Errorf("a refused correction was reported as made: %v", corrected)
				}
			} else {
				if got["mode"] != claudeAutoPermissionMode || got["from"] != "default" {
					t.Errorf("the correction reads %v, want mode %q from %q", got, claudeAutoPermissionMode, "default")
				}
				if failed := run.systemEvents(permissionModeCorrectionFailedSubtype); len(failed) != 0 {
					t.Errorf("a correction the engine took was also reported as failed: %v", failed)
				}
			}
			// Each change of the mode the engine names is reported once, the lower one before the outcome.
			// The second turn's init frame names Auto again; it is the engine's word, and reported as such.
			reports := run.engineModeReports()
			if len(reports) < len(tc.reports) || strings.Join(reports[:len(tc.reports)], ",") != strings.Join(tc.reports, ",") {
				t.Errorf("the Agent Tools reports named %v, want them to start %v", reports, tc.reports)
			}
			for i := 1; i < len(reports); i++ {
				if reports[i] == reports[i-1] {
					t.Errorf("the Agent Tools reports named %v: %q twice in a row, an unchanged mode reported again", reports, reports[i])
				}
			}
			lower := run.position(reportsEngineMode("default"))
			reported := run.position(func(e RunEvent) bool { return e.Type == evSystem && e.Payload["subtype"] == outcome })
			if lower < 0 || lower > reported {
				t.Errorf("the report naming Default is at %d and the outcome at %d; want the report first", lower, reported)
			}
			if run.reload {
				t.Error("the correction asked the supervisor to re-spawn")
			}
		})
	}
}

// The order the installed CLI was measured in (claude_mode_correction_real_cli_test.go): a status frame
// naming Default before the first init frame, which names Default too. Nothing is reported or judged
// before the init frame, which is then judged as before: one request, one report of Default first.
func TestSessionJudgesTheInitFrameAfterAStatusFrameThatCameBeforeIt(t *testing.T) {
	run := runDeliverySessionWith(t,
		[]fakeStep{
			{Emit: "system_status", PermissionMode: "default"},
			{Await: "user"},
			{Emit: "system_init", PermissionMode: "default"},
			{Emit: "replay_user"},
			{Await: "control_request", Subtype: ctrlSetPermissionMode},
			{Emit: "control_response", IsError: true, Text: "Cannot set permission mode to auto: auto mode disabled by settings"},
			{Emit: "result", Text: "first"},
			{Emit: "eof"},
		},
		[]scriptedTurn{messageTurn("turn-1", "one")},
		nil, deliveryOptions{claim: spawnedInAuto})

	if requests := controlRequestsOfSubtype(run.fake, ctrlSetPermissionMode); len(requests) != 1 {
		t.Fatalf("the CLI received %d set_permission_mode request(s), want exactly 1", len(requests))
	}
	waitUntil(t, func() bool { return len(run.systemEvents(permissionModeCorrectionFailedSubtype)) > 0 },
		"the run never reported the refused correction")
	if got := run.engineModeReports(); strings.Join(got, ",") != "default" {
		t.Errorf("the Agent Tools reports named %v, want one naming %q", got, "default")
	}
	if lower, failed := run.position(reportsEngineMode("default")), run.position(func(e RunEvent) bool {
		return e.Type == evSystem && e.Payload["subtype"] == permissionModeCorrectionFailedSubtype
	}); lower < 0 || lower > failed {
		t.Errorf("the report naming Default is at %d and the failure at %d; want the report first", lower, failed)
	}
}

// Only the first turn is judged. A narrower mode after it is the engine moving by itself or someone's
// pick, and so is Plan inside it (the model's EnterPlanMode: settling falls back to Default, never to
// Plan); neither is switched back to Auto. Both are still reported: they are the mode the engine runs in.
func TestSessionLeavesAModeTheEngineMovesToByItselfAlone(t *testing.T) {
	for _, tc := range []struct {
		name    string
		steps   []fakeStep
		reports []string
	}{
		{
			name: "Default after the first turn",
			steps: []fakeStep{
				{Await: "user"},
				{Emit: "system_init", PermissionMode: "auto"},
				{Emit: "replay_user"},
				{Emit: "result", Text: "first"},
				{Await: "user"},
				{Emit: "replay_user"},
				{Emit: "system_status", PermissionMode: "default"},
				{Emit: "result", Text: "second"},
			},
			reports: []string{"auto", "default"},
		},
		{
			name: "Plan inside the first turn, then Default",
			steps: []fakeStep{
				{Await: "user"},
				{Emit: "system_init", PermissionMode: "auto"},
				{Emit: "replay_user"},
				{Emit: "assistant", Text: "planning first"},
				{Emit: "system_status", PermissionMode: "plan"},
				{Emit: "system_status", PermissionMode: "default"},
				{Emit: "result", Text: "first"},
				{Await: "user"},
				{Emit: "replay_user"},
				{Emit: "result", Text: "second"},
			},
			reports: []string{"auto", "plan", "default"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			steps := append(tc.steps,
				// Anything the runner sent on the frames above is written before this turn's frame.
				fakeStep{Await: "user"}, fakeStep{Emit: "replay_user"}, fakeStep{Emit: "result", Text: "third"}, fakeStep{Emit: "eof"})
			run := runDeliverySessionWith(t, steps,
				[]scriptedTurn{messageTurn("turn-1", "one"), messageTurn("turn-2", "two"), messageTurn("turn-3", "three")},
				nil, deliveryOptions{claim: spawnedInAuto})

			if requests := controlRequestsOfSubtype(run.fake, ctrlSetPermissionMode); len(requests) != 0 {
				t.Errorf("the CLI was asked for %v over a mode the engine moved to by itself", requests)
			}
			if n := len(run.systemEvents(permissionModeCorrectedSubtype)) + len(run.systemEvents(permissionModeCorrectionFailedSubtype)); n != 0 {
				t.Errorf("the run reported %d correction outcome(s)", n)
			}
			if got := run.engineModeReports(); strings.Join(got, ",") != strings.Join(tc.reports, ",") {
				t.Errorf("the Agent Tools reports named %v, want %v", got, tc.reports)
			}
		})
	}
}
