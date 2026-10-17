package main

import (
	"testing"
)

// Withdrawing a steer, end to end: the inbox hands the session a message, a steer written into its
// turn while a tool runs, and then a `withdraw` turn naming the steer. The fake CLI reads the
// steer, queues it as the real one does, and answers `cancel_async_message` the way the script
// says the real one would. What the transcript and the withdraw turn's completion say is the
// assertion.

// withdrawTurn is the control turn the control plane files to take back the steer for target,
// handed over once the engine has read that steer.
func withdrawTurn(id, target, targetText string) scriptedTurn {
	return scriptedTurn{
		turn:            RunInboxResponse{TurnID: id, Kind: "withdraw", Content: `{"turnId":"` + target + `"}`},
		ungated:         true,
		afterEngineRead: target,
	}
}

// steerAfterRead is a steer handed over only once the engine has read the message that opened the
// turn, so it is written into a turn that is running rather than refused for having none.
func steerAfterRead(id, text, opening string) scriptedTurn {
	s := steerTurn(id, text)
	s.afterEngineRead = opening
	return s
}

// controlRequests lists the control_request frames written to the CLI with this subtype.
func controlRequests(run *deliverySession, subtype string) []map[string]interface{} {
	var out []map[string]interface{}
	for _, frame := range run.fake.Stdin() {
		if frame["type"] != frameControlRequest {
			continue
		}
		if req, _ := frame["request"].(map[string]interface{}); req != nil && req["subtype"] == subtype {
			out = append(out, req)
		}
	}
	return out
}

func userEventPayload(run *deliverySession, turnID string) map[string]interface{} {
	for _, e := range run.eventsOfType(evUser) {
		if e.TurnID == turnID {
			return e.Payload
		}
	}
	return nil
}

func TestWithdrawDropsASteerTheEngineHasNotReadYet(t *testing.T) {
	run := runDeliverySession(t,
		[]fakeStep{
			{Emit: "system_init", Version: "2.1.300"},
			{Await: "user"}, // the message that opens the turn
			{Emit: "replay_user"},
			{Emit: "tool_use", ToolUseID: "toolu_1", ToolName: "Bash", Input: map[string]interface{}{"command": "sleep 20"}},
			{Await: "user"}, // the steer: read off stdin and queued while the tool runs, not yet echoed
			{Await: "control_request", Subtype: ctrlCancelAsyncMessage},
			{Emit: "control_response", Response: map[string]interface{}{"cancelled": true}},
			{Emit: "tool_result", ToolUseID: "toolu_1", Text: "done"},
			{Emit: "result", Text: "built"},
			{Emit: "eof"},
		},
		[]scriptedTurn{
			messageTurn("turn-1", "build it"),
			steerAfterRead("steer-1", "then push it to main", "turn-1"),
			withdrawTurn("withdraw-1", "steer-1", "then push it to main"),
		}, nil)

	// The steer went in under its own turn's id, which is the only handle the withdrawal has on it.
	frames := run.fake.Stdin()
	if len(frames) < 2 || userFrameText(t, frames[1]) != "then push it to main" {
		t.Fatalf("stdin frames = %v, want the opening message then the steer", frames)
	}
	if frames[1]["uuid"] != "steer-1" {
		t.Errorf("the steer's frame carried uuid %v, want its turn id steer-1", frames[1]["uuid"])
	}
	if _, has := frames[0]["uuid"]; has {
		t.Errorf("an ordinary message's frame carried a uuid %v: only a steer is named by its turn", frames[0]["uuid"])
	}
	// Offered as withdrawable on the event that opened its bubble — this CLI is one the withdrawal
	// was measured on.
	if p := userEventPayload(run, "steer-1"); p == nil || p["withdrawable"] != true {
		t.Errorf("the steer's user event = %v, want it marked withdrawable", p)
	}
	// The CLI was asked to drop exactly that message.
	asked := controlRequests(run, ctrlCancelAsyncMessage)
	if len(asked) != 1 || asked[0]["message_uuid"] != "steer-1" {
		t.Fatalf("cancel_async_message requests = %v, want one naming steer-1", asked)
	}
	// Every client takes the bubble down…
	states := run.deliveryStates("steer-1")
	if len(states) == 0 || states[len(states)-1] != string(deliveryWithdrawn) {
		t.Fatalf("the steer's delivery states = %v, want it to end withdrawn", states)
	}
	for _, s := range states {
		if s == string(deliveryAcknowledged) {
			t.Fatalf("a withdrawn steer was reported read: %v", states)
		}
	}
	// …and the person who asked hears the outcome on the withdraw turn.
	w := run.turnResult("withdraw-1")
	if w == nil || w.Status != stSucceeded || w.Subtype != subtypeSteerWithdraw || w.Result != withdrawWithdrawn {
		t.Fatalf("the withdraw turn settled as %+v, want a %s completion saying %s", w, subtypeSteerWithdraw, withdrawWithdrawn)
	}
	// The steer's own row is the control plane's to remove: nothing settles it here.
	if s := run.turnResult("steer-1"); s != nil {
		t.Errorf("a withdrawn steer was settled as %+v", s)
	}
	// The turn it was aimed at carries on and ends as usual — no fence, no second process.
	if settled := run.turnResult("turn-1"); settled == nil || settled.Status != stSucceeded || settled.Result != "built" {
		t.Fatalf("the running turn settled as %+v, want its own result", settled)
	}
	if spawns := run.fake.Spawns(); len(spawns) != 1 {
		t.Errorf("claude was spawned %d time(s); a withdrawal must not cost the session its process", len(spawns))
	}
}

func TestWithdrawLeavesASteerTheEngineAnswersItHasRead(t *testing.T) {
	run := runDeliverySession(t,
		[]fakeStep{
			{Emit: "system_init", Version: "2.1.300"},
			{Await: "user"},
			{Emit: "replay_user"},
			{Emit: "tool_use", ToolUseID: "toolu_1", ToolName: "Bash", Input: map[string]interface{}{"command": "ls"}},
			{Await: "user"}, // the steer
			{Await: "control_request", Subtype: ctrlCancelAsyncMessage},
			// It had been taken into the turn first: the CLI says so, then echoes it.
			{Emit: "control_response", Response: map[string]interface{}{"cancelled": false}},
			{Emit: "replay_user"},
			{Emit: "tool_result", ToolUseID: "toolu_1", Text: "widget.go"},
			{Emit: "result", Text: "listed"},
			{Emit: "eof"},
		},
		[]scriptedTurn{
			messageTurn("turn-1", "list the files"),
			steerAfterRead("steer-1", "and count them", "turn-1"),
			withdrawTurn("withdraw-1", "steer-1", "and count them"),
		}, nil)

	w := run.turnResult("withdraw-1")
	if w == nil || w.Subtype != subtypeSteerWithdraw || w.Result != withdrawAlreadyRead {
		t.Fatalf("the withdraw turn settled as %+v, want %s", w, withdrawAlreadyRead)
	}
	if w.Error == "" {
		t.Error("an already-read withdrawal says nothing about why it did not happen")
	}
	// The message is exactly where it would have been: read into the turn, settled on its echo.
	if states := run.deliveryStates("steer-1"); len(states) == 0 || states[len(states)-1] != string(deliveryAcknowledged) {
		t.Fatalf("the steer's delivery states = %v, want it read", states)
	}
	if s := run.turnResult("steer-1"); s == nil || s.Subtype != subtypeSteer || s.Status != stSucceeded {
		t.Fatalf("the steer settled as %+v, want its ordinary steer completion", s)
	}
}

func TestWithdrawAfterTheEchoAsksTheEngineNothing(t *testing.T) {
	steer := steerAfterRead("steer-1", "and count them", "turn-1")
	withdraw := withdrawTurn("withdraw-1", "steer-1", "and count them")
	withdraw.after = "steer-1" // asked only once the steer has been read and settled
	run := runDeliverySession(t,
		[]fakeStep{
			{Emit: "system_init", Version: "2.1.300"},
			{Await: "user"},
			{Emit: "replay_user"},
			{Emit: "tool_use", ToolUseID: "toolu_1", ToolName: "Bash", Input: map[string]interface{}{"command": "ls"}},
			{Await: "user"},
			{Emit: "replay_user"}, // the steer, read into the turn
			{Emit: "tool_result", ToolUseID: "toolu_1", Text: "widget.go"},
			{Emit: "result", Text: "listed"},
		},
		[]scriptedTurn{messageTurn("turn-1", "list the files"), steer, withdraw},
		func(r *deliverySession) bool { return r.turnResult("withdraw-1") != nil })

	w := run.turnResult("withdraw-1")
	if w == nil || w.Result != withdrawAlreadyRead {
		t.Fatalf("the withdraw turn settled as %+v, want %s from what this process saw", w, withdrawAlreadyRead)
	}
	if asked := controlRequests(run, ctrlCancelAsyncMessage); len(asked) != 0 {
		t.Errorf("the CLI was asked to drop a message this process saw it read: %v", asked)
	}
}

func TestWithdrawOfAMessageThisProcessNeverHadSaysSo(t *testing.T) {
	stray := withdrawTurn("withdraw-1", "steer-elsewhere", "")
	stray.afterEngineRead = "turn-1"
	run := runDeliverySession(t,
		[]fakeStep{
			{Emit: "system_init", Version: "2.1.300"},
			{Await: "user"},
			{Emit: "replay_user"},
		},
		[]scriptedTurn{messageTurn("turn-1", "list the files"), stray},
		func(r *deliverySession) bool { return r.turnResult("withdraw-1") != nil })

	if w := run.turnResult("withdraw-1"); w == nil || w.Result != withdrawNotWaiting {
		t.Fatalf("the withdraw turn settled as %+v, want %s", w, withdrawNotWaiting)
	}
	if asked := controlRequests(run, ctrlCancelAsyncMessage); len(asked) != 0 {
		t.Errorf("the CLI was asked to drop a message it was never given: %v", asked)
	}
}

func TestASteerToAnOlderCLIIsNotOfferedForWithdrawal(t *testing.T) {
	run := runDeliverySession(t,
		[]fakeStep{
			{Emit: "system_init", Version: "2.1.280"},
			{Await: "user"},
			{Emit: "replay_user"},
			{Await: "user"},
			{Emit: "replay_user"},
			{Emit: "result", Text: "ok"},
			{Emit: "eof"},
		},
		[]scriptedTurn{
			messageTurn("turn-1", "list the files"),
			steerAfterRead("steer-1", "and count them", "turn-1"),
		}, nil)

	p := userEventPayload(run, "steer-1")
	if p == nil {
		t.Fatal("the steer never entered the transcript")
	}
	if _, offered := p["withdrawable"]; offered {
		t.Errorf("a steer to claude 2.1.280 was offered for withdrawal: %v", p)
	}
}
