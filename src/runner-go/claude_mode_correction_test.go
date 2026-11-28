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

// The round trip the control plane now makes (apiserver claimPermissionMode): a session spawned in Auto on a model
// whose engine settles on Default and refuses Auto, then moved by a setconfig to a model with Auto, carrying the
// Auto it asked for all along. The process's config still reads `auto`, but the engine said it runs in Default, so
// the setconfig's Auto is news and goes to the engine after its model, and the turn says the mode was applied.
func TestSetConfigAsksForTheAutoItCarriesWhenTheEngineSaidItRunsLower(t *testing.T) {
	const refusal = "Cannot set permission mode to auto: auto mode unavailable for this model"
	run := runDeliverySessionWith(t,
		[]fakeStep{
			{Await: "user"},
			{Emit: "system_init", PermissionMode: "default"},
			{Emit: "replay_user"},
			{Await: "control_request", Subtype: ctrlSetPermissionMode},
			{Emit: "control_response", IsError: true, Text: refusal},
			{Emit: "result", Text: "first"},
			{Await: "control_request", Subtype: ctrlSetModel},
			{Emit: "control_response"},
			{Await: "control_request", Subtype: ctrlSetPermissionMode},
			{Emit: "control_response"},
			{Await: "user"},
			{Emit: "system_init", PermissionMode: "auto"},
			{Emit: "replay_user"},
			{Emit: "result", Text: "second"},
			{Emit: "eof"},
		},
		[]scriptedTurn{
			messageTurn("turn-1", "one"),
			{turn: setConfigTurn("cfg-1", "claude-opus-5", claudeAutoPermissionMode).turn, ungated: true, after: "turn-1"},
			{turn: messageTurn("turn-2", "two").turn, after: "cfg-1"},
		},
		nil, deliveryOptions{claim: func(job *ClaimedSession) {
			job.Agent.PermissionMode = claudeAutoPermissionMode
			job.Agent.Model = "claude-haiku-4-5-20251001"
		}})

	requests := controlRequestsOfSubtype(run.fake, ctrlSetPermissionMode)
	if len(requests) != 2 {
		t.Fatalf("the CLI received set_permission_mode %v, want the correction and then the setconfig's", requests)
	}
	if requests[1]["mode"] != claudeAutoPermissionMode {
		t.Errorf("the setconfig asked for mode %v, want %q", requests[1]["mode"], claudeAutoPermissionMode)
	}
	r := run.turnResult("cfg-1")
	if r == nil || !strings.Contains(r.Result, `permission mode "auto"`) {
		t.Errorf("the setconfig turn settled %+v, want it to say the permission mode was applied", r)
	}
	if run.reload {
		t.Error("a setconfig the engine took asked the supervisor to re-spawn")
	}
}

// And nothing is sent where the engine already said it runs in the mode a setconfig carries.
func TestSetConfigLeavesAnAutoTheEngineReportedAlone(t *testing.T) {
	run := runDeliverySessionWith(t,
		[]fakeStep{
			{Await: "user"},
			{Emit: "system_init", PermissionMode: "auto"},
			{Emit: "replay_user"},
			{Emit: "result", Text: "first"},
			{Await: "user"},
			{Emit: "replay_user"},
			{Emit: "result", Text: "second"},
			{Emit: "eof"},
		},
		[]scriptedTurn{
			messageTurn("turn-1", "one"),
			{turn: setConfigTurn("cfg-1", "claude-opus-5", claudeAutoPermissionMode).turn, ungated: true, after: "turn-1"},
			{turn: messageTurn("turn-2", "two").turn, after: "cfg-1"},
		},
		nil, deliveryOptions{claim: spawnedInAuto})

	if requests := controlRequestsOfSubtype(run.fake, ctrlSetPermissionMode); len(requests) != 0 {
		t.Errorf("the CLI received set_permission_mode %v for the Auto it said it runs in", requests)
	}
	if r := run.turnResult("cfg-1"); r == nil || r.Result != "nothing to change" {
		t.Errorf("the setconfig turn settled %+v, want %q", r, "nothing to change")
	}
}

// setConfigFramesFor: a mode is news against the process's config or the engine's own report, whichever differs.
func TestSetConfigFramesJudgeTheModeAgainstTheEnginesReport(t *testing.T) {
	agent := AgentExecConfig{Model: "claude-opus-5", PermissionMode: claudeAutoPermissionMode}
	for _, tc := range []struct {
		name, payloadMode, engineMode string
		want                          bool
	}{
		{"engine said Default, Auto carried", "auto", "default", true},
		{"engine said Auto, Auto carried", "auto", "auto", false},
		{"engine has not said, Auto carried", "auto", "", false},
		{"engine said Default, Default carried", "default", "default", true},
		{"engine said Plan, Plan carried, config Auto", "plan", "plan", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			frames, err := setConfigFramesFor(`{"model":"claude-opus-5","permissionMode":"`+tc.payloadMode+`"}`, agent, tc.engineMode)
			if err != nil {
				t.Fatal(err)
			}
			got := false
			for _, f := range frames {
				if f.subtype == ctrlSetPermissionMode {
					got = true
				}
				if f.subtype == ctrlSetModel {
					t.Errorf("a model the process runs was sent as %v", f.payload)
				}
			}
			if got != tc.want {
				t.Errorf("payload %q, engine %q, config %q: mode frame %v, want %v", tc.payloadMode, tc.engineMode, agent.PermissionMode, got, tc.want)
			}
		})
	}
}
