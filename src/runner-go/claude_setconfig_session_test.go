package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// Changing a live session's config, driven through the real session loop against the fake
// CLI over its real stdin/stdout.
//
// What these pin is the difference between telling the engine and replacing it. Every one
// of these changes used to cost the session its process: the runner wrote the new flags
// onto job.Agent, killed claude, and let the outer loop bring it back with --resume. The
// change landed, so from the outside it looked like it worked — which is exactly why the
// tests here assert on the process and the transcript, not just on the setting. A
// re-spawn that nobody asked for and nobody was told about is the failure being removed,
// and it is invisible to any assertion that only reads the config back.

// setConfigTurn is the control plane telling the runner what this session's model and
// permission mode now are. Ungated on purpose: the server hands this kind over on the same
// arm as interrupt/end/diff, mid-turn included, which is the whole reason it is a kind of
// its own rather than a `reload`.
func setConfigTurn(id, model, permissionMode string) scriptedTurn {
	content, err := json.Marshal(map[string]string{"model": model, "permissionMode": permissionMode})
	if err != nil {
		panic(err)
	}
	return scriptedTurn{
		turn:    RunInboxResponse{TurnID: id, Kind: "setconfig", Content: string(content)},
		ungated: true,
	}
}

// controlRequestsOfSubtype returns the control_requests of one subtype the CLI actually
// received, in order.
func controlRequestsOfSubtype(f *fakeClaude, subtype string) []map[string]interface{} {
	var out []map[string]interface{}
	for _, frame := range f.Stdin() {
		if frame["type"] != frameControlRequest {
			continue
		}
		req, _ := frame["request"].(map[string]interface{})
		if req != nil && req["subtype"] == subtype {
			out = append(out, req)
		}
	}
	return out
}

// notices returns the transcript's user-visible notices of one kind.
func (r *deliverySession) notices(kind string) []string {
	var out []string
	for _, e := range r.eventsOfType(evSystem) {
		if e.Payload["noticeKind"] == kind {
			text, _ := e.Payload["notice"].(string)
			out = append(out, text)
		}
	}
	return out
}

// resumedMarkers returns the session-level "the engine was restarted" markers. The outer
// loop is what emits these, so a run that never asks to re-spawn can never produce one —
// which is why the reload flag is asserted beside them.
func (r *deliverySession) resumedMarkers() []RunEvent {
	var out []RunEvent
	for _, e := range r.eventsOfType(evSystem) {
		if e.Payload["subtype"] == "resumed" {
			out = append(out, e)
		}
	}
	return out
}

// The whole path: a turn is running, the config change reaches the CLI as a control_request
// carrying the new mode, the CLI agrees, and the session carries on in the SAME process —
// no re-spawn, no restart marker, and the next turn goes to the process that was already
// there.
func TestSessionAppliesAConfigChangeToTheRunningEngine(t *testing.T) {
	run := runDeliverySession(t,
		[]fakeStep{
			{Await: "user"},
			{Emit: "replay_user"},
			{Emit: "assistant", Text: "working on it"},
			// Mid-turn: the CLI is between its own output and its result when it is told.
			{Await: "control_request", Subtype: ctrlSetPermissionMode},
			{Emit: "control_response"},
			{Emit: "result", Text: "done"},
			// The second turn proves the process survived: a re-spawned CLI would be a new
			// process, and this script only ever runs once.
			{Await: "user"},
			{Emit: "replay_user"},
			{Emit: "result", Text: "done again"},
			{Emit: "eof"},
		},
		[]scriptedTurn{
			messageTurn("turn-1", "start something long"),
			// The payload restates the model the session is already on, exactly as the
			// control plane sends it: the turn says what the config IS, not what moved.
			setConfigTurn("cfg-1", "claude-opus-5", "plan"),
			messageTurn("turn-2", "and now this"),
		}, nil)

	modes := controlRequestsOfSubtype(run.fake, ctrlSetPermissionMode)
	if len(modes) != 1 {
		t.Fatalf("the CLI received %d set_permission_mode request(s), want exactly 1", len(modes))
	}
	if got := modes[0]["mode"]; got != "plan" {
		t.Errorf("the CLI was asked for mode %v, want %q", got, "plan")
	}
	// The restated model is not news, and asking for it would risk the process over a
	// setting that never changed (a refusal falls back to a re-spawn).
	if models := controlRequestsOfSubtype(run.fake, ctrlSetModel); len(models) != 0 {
		t.Errorf("the CLI was asked to load the model it is already running: %v", models)
	}
	// Nothing was restarted, so nothing says it was.
	if run.reload {
		t.Error("an applied config change still asked the supervisor to re-spawn")
	}
	if n := len(run.fake.Spawns()); n != 1 {
		t.Errorf("the session ran %d processes; a config the engine accepted must not cost it its process", n)
	}
	if markers := run.resumedMarkers(); len(markers) != 0 {
		t.Errorf("the transcript claims the session was resumed: %v", markers)
	}
	if notes := run.notices("setconfig-degraded"); len(notes) != 0 {
		t.Errorf("a change the engine accepted was reported as degraded: %v", notes)
	}
	// The turn is settled either way — see TestSessionSettlesASetConfigTurnOnEveryPath.
	if got := run.turnResult("cfg-1"); got == nil || got.Status != stSucceeded {
		t.Fatalf("the setconfig turn settled as %v, want %s", got, stSucceeded)
	}
	// And the conversation kept going in the process that was already there.
	if got := run.turnResult("turn-2"); got == nil || got.Status != stSucceeded {
		t.Errorf("the turn after the config change settled as %v, want %s", got, stSucceeded)
	}
	// job.Agent is what the NEXT process would be built from. Leaving it stale is how a
	// runner comes back up on the model the user stopped using.
	if got := run.job.Agent.PermissionMode; got != "plan" {
		t.Errorf("the claim still carries permission mode %q, want plan", got)
	}
	if got := run.job.Agent.Model; got != "claude-opus-5" {
		t.Errorf("the claim's model became %q; a restated model must not move it", got)
	}
}

// The model half, and the frame the CLI reads it out of.
func TestSessionSetsTheModelOnTheRunningEngine(t *testing.T) {
	run := runDeliverySession(t,
		[]fakeStep{
			{Await: "user"},
			{Emit: "replay_user"},
			{Await: "control_request", Subtype: ctrlSetModel},
			{Emit: "control_response"},
			{Emit: "result", Text: "done"},
			{Emit: "eof"},
		},
		[]scriptedTurn{
			messageTurn("turn-1", "start something long"),
			setConfigTurn("cfg-1", "claude-sonnet-5", "acceptEdits"),
		}, nil)

	models := controlRequestsOfSubtype(run.fake, ctrlSetModel)
	if len(models) != 1 {
		t.Fatalf("the CLI received %d set_model request(s), want exactly 1", len(models))
	}
	if got := models[0]["model"]; got != "claude-sonnet-5" {
		t.Errorf("the CLI was asked for model %v, want %q", got, "claude-sonnet-5")
	}
	if modes := controlRequestsOfSubtype(run.fake, ctrlSetPermissionMode); len(modes) != 0 {
		t.Errorf("the CLI was asked for the permission mode it already has: %v", modes)
	}
	if run.reload {
		t.Error("an applied model change still asked the supervisor to re-spawn")
	}
	if got := run.job.Agent.Model; got != "claude-sonnet-5" {
		t.Errorf("the claim still carries model %q, want claude-sonnet-5", got)
	}
}

// The engine refuses, and the change falls back to the path this kind exists to avoid.
//
// Paired with its own control group — the identical run whose only difference is that the
// CLI says yes. Without it the assertions below would pass just as well against a runner
// that re-spawned on every config change, which is precisely the behaviour being replaced.
func TestSessionFallsBackToARespawnWhenTheEngineWillNotTakeAConfigChange(t *testing.T) {
	for _, tc := range []struct {
		name       string
		refuse     bool
		wantReload bool
	}{
		{name: "the engine agrees", refuse: false, wantReload: false},
		{name: "the engine refuses", refuse: true, wantReload: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			script := []fakeStep{
				{Await: "user"},
				{Emit: "replay_user"},
				{Emit: "assistant", Text: "working on it"},
				{Await: "control_request", Subtype: ctrlSetPermissionMode},
				{Emit: "control_response", IsError: tc.refuse, Text: "no such permission mode"},
			}
			if !tc.refuse {
				// A CLI that agreed keeps its process, so this script has to end the run
				// itself. The refusing one does not: the runner tears its process down,
				// which is what stdout reaching EOF with no `eof` step proves.
				script = append(script, fakeStep{Emit: "result", Text: "done"}, fakeStep{Emit: "eof"})
			}
			run := runDeliverySession(t, script,
				[]scriptedTurn{
					messageTurn("turn-1", "start something long"),
					setConfigTurn("cfg-1", "claude-opus-5", "plan"),
				}, nil)

			if run.reload != tc.wantReload {
				t.Fatalf("the run asked for a re-spawn = %v, want %v", run.reload, tc.wantReload)
			}
			notes := run.notices("setconfig-degraded")
			if !tc.refuse {
				if len(notes) != 0 {
					t.Fatalf("a change the engine accepted was reported as degraded: %v", notes)
				}
				return
			}
			// A degradation nobody is told about is a re-spawn that looks, from the
			// outside, exactly like the feature working.
			if len(notes) != 1 {
				t.Fatalf("the transcript carries %d degradation notice(s), want 1: %v", len(notes), notes)
			}
			if !strings.Contains(notes[0], "no such permission mode") {
				t.Errorf("the notice lost the engine's own reason: %q", notes[0])
			}
			if !strings.Contains(notes[0], "plan") {
				t.Errorf("the notice does not say which setting could not be applied: %q", notes[0])
			}
			// It also has to say the session survived — a person watching it go quiet for
			// a few seconds otherwise concludes it crashed.
			if !strings.Contains(notes[0], "nothing is lost") {
				t.Errorf("the notice does not say the conversation survives: %q", notes[0])
			}
			// The values go on the claim even though the CLI would not take them: the
			// process the fallback builds next is the one that has to carry them.
			if got := run.job.Agent.PermissionMode; got != "plan" {
				t.Errorf("the claim still carries permission mode %q, want plan — the re-spawn would come back with the old flag", got)
			}
		})
	}
}

// Every path settles the turn. The control plane hands this turn over and stops asking
// about it; whatever the runner decides to do with it, leaving the row unanswered is not
// one of the options.
//
// The assertion is the turn's terminal state, not that some function was called: a
// completion the runner reports as FAILED would terminalize the whole Session
// (turnCompletionEndsSession), which for a change that DID take effect — by the slower
// route — would end a healthy conversation.
func TestSessionSettlesASetConfigTurnOnEveryPath(t *testing.T) {
	for _, tc := range []struct {
		name       string
		turn       scriptedTurn
		script     []fakeStep
		wantResult string
	}{
		{
			name: "applied to the running engine",
			turn: setConfigTurn("cfg-1", "claude-opus-5", "plan"),
			script: []fakeStep{
				{Await: "user"}, {Emit: "replay_user"},
				{Await: "control_request", Subtype: ctrlSetPermissionMode},
				{Emit: "control_response"},
				{Emit: "result", Text: "done"}, {Emit: "eof"},
			},
			wantResult: "applied to the running engine",
		},
		{
			name: "refused, and fell back to a re-spawn",
			turn: setConfigTurn("cfg-1", "claude-opus-5", "plan"),
			script: []fakeStep{
				{Await: "user"}, {Emit: "replay_user"},
				{Await: "control_request", Subtype: ctrlSetPermissionMode},
				{Emit: "control_response", IsError: true, Text: "no such permission mode"},
			},
			wantResult: "fell back to a re-spawn",
		},
		{
			name: "nothing in it had changed",
			// The control plane sends one of these for every config PATCH, including the
			// ones where only effort moved. Nothing to ask the CLI, and still a turn.
			turn: setConfigTurn("cfg-1", "claude-opus-5", "acceptEdits"),
			script: []fakeStep{
				{Await: "user"}, {Emit: "replay_user"},
				{Emit: "result", Text: "done"}, {Emit: "eof"},
			},
			wantResult: "nothing to change",
		},
		{
			name: "the payload could not be read",
			turn: scriptedTurn{
				turn:    RunInboxResponse{TurnID: "cfg-1", Kind: "setconfig", Content: "{not json"},
				ungated: true,
			},
			script: []fakeStep{
				{Await: "user"}, {Emit: "replay_user"},
				{Emit: "result", Text: "done"}, {Emit: "eof"},
			},
			wantResult: "unreadable payload",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			run := runDeliverySession(t, tc.script,
				[]scriptedTurn{messageTurn("turn-1", "start something long"), tc.turn}, nil)

			got := run.turnResult("cfg-1")
			if got == nil {
				t.Fatal("the setconfig turn was never settled; the control plane will keep it and stop asking")
			}
			if got.Status != stSucceeded {
				t.Errorf("the turn settled as %s, want %s — a failed turn ends the whole session", got.Status, stSucceeded)
			}
			if got.Subtype != subtypeSetConfig {
				t.Errorf("the completion is filed as %q, want %q", got.Subtype, subtypeSetConfig)
			}
			if !strings.Contains(got.Result, tc.wantResult) {
				t.Errorf("the completion says %q, want it to say %q", got.Result, tc.wantResult)
			}
		})
	}
}

// After it services a set_model, the CLI writes a line of its own: a user-role message
// whose content is the bare string "<local-command-stdout>Set model to X</local-command-stdout>".
//
// It is the CLI talking to itself, and it must stay that way. Two things could go wrong,
// and both are silent: it could enter the transcript as a user message nobody sent, or —
// worse — be mistaken for the --replay-user-messages echo, which is what acknowledges a
// delivery, and acknowledge a message the engine has not actually read yet.
//
// The control group is the same run with a real echo in its place. Without it this test
// would pass against a runner that had stopped acknowledging anything at all.
func TestLocalCommandStdoutIsNotAUserMessageAndAcknowledgesNothing(t *testing.T) {
	for _, tc := range []struct {
		name    string
		echo    fakeStep
		wantAck bool
	}{
		{name: "a replayed user message", echo: fakeStep{Emit: "replay_user"}, wantAck: true},
		{
			name:    "the CLI's own set_model output",
			echo:    fakeStep{Emit: "local_command_stdout", Text: "Set model to claude-sonnet-5"},
			wantAck: false,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			run := runDeliverySession(t,
				[]fakeStep{
					{Await: "user"},
					{Await: "control_request", Subtype: ctrlSetModel},
					{Emit: "control_response"},
					tc.echo,
					{Emit: "result", Text: "done"},
					{Emit: "eof"},
				},
				[]scriptedTurn{
					messageTurn("turn-1", "start something long"),
					setConfigTurn("cfg-1", "claude-sonnet-5", "acceptEdits"),
				}, nil)

			acked := false
			for _, state := range run.deliveryStates("turn-1") {
				if state == string(deliveryAcknowledged) {
					acked = true
				}
			}
			if acked != tc.wantAck {
				t.Fatalf("the message was reported acknowledged = %v, want %v (states: %v)",
					acked, tc.wantAck, run.deliveryStates("turn-1"))
			}
			if tc.wantAck {
				return
			}
			// And nothing of it reached the transcript, under any event type.
			for _, e := range run.events {
				payload, err := json.Marshal(e.Payload)
				if err != nil {
					t.Fatal(err)
				}
				if strings.Contains(string(payload), "local-command-stdout") {
					t.Errorf("the CLI's own output entered the transcript as a %s event: %s", e.Type, payload)
				}
			}
		})
	}
}

// An inbox turn of a kind this binary does not implement — the arm a half-upgraded fleet
// reaches, where the control plane is newer than some of the runners answering to it.
//
// The control group is a `diff` turn: a control turn this runner DOES implement, delivered
// the same way, in the same run. It settles nothing, which is what every kind used to do
// here — including the ones the runner had never heard of. The pair is what shows the new
// arm firing on exactly one of them.
func TestSessionSettlesAnUnknownTurnKindInsteadOfDroppingItSilently(t *testing.T) {
	for _, tc := range []struct {
		name        string
		kind        string
		wantSettled bool
	}{
		{name: "a kind this runner implements", kind: "diff", wantSettled: false},
		{name: "a kind this runner has never heard of", kind: "definitely-not-a-real-kind", wantSettled: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var run *deliverySession
			log := captureRunnerStdout(t, func() {
				run = runDeliverySession(t,
					[]fakeStep{
						{Await: "user"},
						{Emit: "replay_user"},
						{Emit: "result", Text: "done"},
						{Emit: "eof"},
					},
					[]scriptedTurn{
						{turn: RunInboxResponse{TurnID: "odd-1", Kind: tc.kind}, ungated: true},
						// Ordinary work behind it, so the run reaches a point where a
						// settlement would certainly have been recorded — and so the
						// session is shown carrying on regardless of what came before.
						messageTurn("turn-1", "carry on"),
					}, nil)
			})

			if got := run.turnResult("turn-1"); got == nil || got.Status != stSucceeded {
				t.Fatalf("the ordinary turn settled as %v, want %s — the run never got far enough to judge the other one", got, stSucceeded)
			}
			settled := run.turnResult("odd-1")
			if !tc.wantSettled {
				if settled != nil {
					t.Fatalf("a kind the runner handles was also settled by the unknown-kind arm: %v", settled)
				}
				return
			}
			if settled == nil {
				t.Fatal("the unknown turn was dropped without a word — nothing answered it, and nothing said so")
			}
			if settled.Status != stFailed {
				t.Errorf("the unknown turn settled as %s, want %s: it was not carried out and never will be", settled.Status, stFailed)
			}
			if settled.Subtype != subtypeUnknownKind {
				t.Errorf("the completion is filed as %q, want %q", settled.Subtype, subtypeUnknownKind)
			}
			if !strings.Contains(settled.Result, tc.kind) {
				t.Errorf("the completion does not name the kind it could not handle: %q", settled.Result)
			}
			// Whoever is reading the runner's log is the one who can act on this.
			if !strings.Contains(log, tc.kind) {
				t.Errorf("the log does not name the unknown kind: %s", log)
			}
			// And the session is untouched: an out-of-date runner is not a reason to end
			// somebody's conversation.
			if run.reload {
				t.Error("an unknown kind cost the session its process")
			}
		})
	}
}

// The completion's own consequence, in isolation: a failed turn is what makes the runner
// seal a session's event stream and hand it to the supervisor to terminalize. An
// unrecognised kind must not do that — it is one instruction the runner could not carry
// out, in a conversation that is otherwise in perfect health.
func TestAnUnknownKindCompletionDoesNotEndTheSession(t *testing.T) {
	for _, tc := range []struct {
		name string
		req  TurnCompleteRequest
		want bool
	}{
		{
			name: "an ordinary turn that failed",
			req:  TurnCompleteRequest{Status: stFailed, Subtype: "delivery_failed"},
			want: true,
		},
		{
			name: "a steer that failed",
			req:  TurnCompleteRequest{Status: stFailed, Subtype: subtypeSteer},
			want: false,
		},
		{
			name: "a turn kind this runner does not implement",
			req:  TurnCompleteRequest{Status: stFailed, Subtype: subtypeUnknownKind},
			want: false,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := turnCompletionEndsSession(tc.req); got != tc.want {
				t.Errorf("turnCompletionEndsSession = %v, want %v", got, tc.want)
			}
		})
	}
}

// Which fields a setconfig payload actually asks for, read against the config the process
// is running with.
//
// The control plane sends the whole committed pair every time — the turn says what the
// session's config IS, not which half of it moved — so this comparison is the only thing
// standing between "the permission mode changed" and a set_model for a model that did not.
// It is not a matter of one wasted round trip: a refused frame falls back to a re-spawn, so
// asking for a setting that never changed is a way to lose the process over nothing.
func TestSetConfigFramesAskOnlyForWhatChanged(t *testing.T) {
	running := AgentExecConfig{Model: "claude-opus-5", PermissionMode: "acceptEdits"}
	for _, tc := range []struct {
		name    string
		content string
		want    []string
	}{
		{
			name:    "the model moved",
			content: `{"model":"claude-sonnet-5","permissionMode":"acceptEdits"}`,
			want:    []string{ctrlSetModel},
		},
		{
			name:    "the permission mode moved",
			content: `{"model":"claude-opus-5","permissionMode":"plan"}`,
			want:    []string{ctrlSetPermissionMode},
		},
		{
			name:    "both moved",
			content: `{"model":"claude-sonnet-5","permissionMode":"plan"}`,
			want:    []string{ctrlSetModel, ctrlSetPermissionMode},
		},
		{
			name:    "the pair was restated unchanged",
			content: `{"model":"claude-opus-5","permissionMode":"acceptEdits"}`,
			want:    nil,
		},
		{
			// Neither field has an empty value it could be set to, so an absent one is
			// "not stated" — the same reading `reload` gives these two fields.
			name:    "a field the payload does not carry",
			content: `{"permissionMode":"plan"}`,
			want:    []string{ctrlSetPermissionMode},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			frames, err := setConfigFrames(tc.content, running)
			if err != nil {
				t.Fatalf("setConfigFrames: %v", err)
			}
			var got []string
			for _, f := range frames {
				got = append(got, f.subtype)
			}
			if !equalStrings(got, tc.want) {
				t.Fatalf("frames = %v, want %v", got, tc.want)
			}
		})
	}
	if _, err := setConfigFrames("{not json", running); err == nil {
		t.Error("an unreadable payload was accepted as an empty one")
	}
}

// The values a set of frames carries are the ones that end up on the claim, which is what
// the NEXT process is built from — the fallback re-spawn, a crash resume, a later effort
// change. A runner that applied the frames but not the claim would come back up on the
// model the person stopped using, with the control plane showing the one they chose.
func TestSetConfigFramesCarryTheValuesOntoTheClaim(t *testing.T) {
	agent := AgentExecConfig{Model: "claude-opus-5", PermissionMode: "acceptEdits"}
	frames, err := setConfigFrames(`{"model":"claude-sonnet-5","permissionMode":"plan"}`, agent)
	if err != nil {
		t.Fatalf("setConfigFrames: %v", err)
	}
	for _, f := range frames {
		f.apply(&agent)
	}
	if agent.Model != "claude-sonnet-5" || agent.PermissionMode != "plan" {
		t.Fatalf("the claim ended up at %+v, want the new model and mode", agent)
	}
}
