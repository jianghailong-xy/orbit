package main

import (
	"fmt"
	"strings"
	"testing"
)

// Interrupt, driven through the real session loop against the fake CLI.
//
// What these pin is the difference between asking and claiming. The loop used to write an
// interrupt frame, emit the transcript's "⊘ interrupted" marker on the next line, and never
// look at what came back — so a CLI that refused the request, or never read it, or had
// already died produced exactly the same transcript as one that stopped. The marker now
// costs an answer, and every way of not getting one is reported instead.

// interruptTurn is the control plane telling the runner to stop the current turn. Ungated
// for the same reason dequeueTurn lets it through mid-message: stopping a turn that is
// running is the entire point, so it does not queue behind the turn it is aimed at.
func interruptTurn(id string) scriptedTurn {
	return scriptedTurn{turn: RunInboxResponse{TurnID: id, Kind: "interrupt"}, ungated: true}
}

// afterTurn holds a turn back until the named turn has settled — the runner reading a
// control turn only after the turn it was aimed at is already over.
func afterTurn(s scriptedTurn, after string) scriptedTurn {
	s.after = after
	return s
}

// interruptRequests returns the interrupt control_requests the CLI actually received.
func interruptRequests(f *fakeClaude) []map[string]interface{} {
	var out []map[string]interface{}
	for _, frame := range f.Stdin() {
		if frame["type"] != frameControlRequest {
			continue
		}
		req, _ := frame["request"].(map[string]interface{})
		if req != nil && req["subtype"] == ctrlInterrupt {
			out = append(out, frame)
		}
	}
	return out
}

// interruptMarkers returns the transcript's interrupt notes.
func (r *deliverySession) interruptMarkers() []RunEvent { return r.eventsOfType(evInterrupt) }

// errorMessages returns the text of every error the run put in the transcript.
func (r *deliverySession) errorMessages() []string {
	var out []string
	for _, e := range r.eventsOfType(evError) {
		msg, _ := e.Payload["message"].(string)
		out = append(out, msg)
	}
	return out
}

// The whole path: a turn is running, the interrupt reaches the CLI as a control_request
// carrying a request_id, the CLI answers that id, and only then does the transcript say
// the turn was interrupted.
func TestSessionInterruptsARunningTurnAndWaitsForTheAnswer(t *testing.T) {
	run := runDeliverySession(t,
		[]fakeStep{
			{Await: "user"},
			{Emit: "replay_user"},
			{Emit: "assistant", Text: "starting the long thing"},
			// The CLI works until it is told to stop, then answers the request by its id
			// and ends the turn the way an interrupted turn ends.
			{Await: "control_request", Subtype: ctrlInterrupt},
			{Emit: "control_response"},
			{Emit: "result", Subtype: "error_during_execution", Text: "interrupted"},
			{Emit: "eof"},
		},
		[]scriptedTurn{messageTurn("turn-1", "start something long"), interruptTurn("int-1")},
		func(r *deliverySession) bool { return len(r.interruptMarkers()) > 0 })

	reqs := interruptRequests(run.fake)
	if len(reqs) != 1 {
		t.Fatalf("the CLI received %d interrupt control_request(s), want exactly 1", len(reqs))
	}
	id, _ := reqs[0]["request_id"].(string)
	if id == "" {
		t.Fatal("the interrupt carried no request_id, so nothing could ever answer it")
	}
	markers := run.interruptMarkers()
	if len(markers) != 1 {
		t.Fatalf("the transcript shows %d interrupt marker(s), want 1", len(markers))
	}
	if got := markers[0].Payload["requestId"]; got != id {
		t.Errorf("the marker names request %v, the CLI was asked under %q", got, id)
	}
	if msgs := run.errorMessages(); len(msgs) != 0 {
		t.Errorf("a confirmed interrupt also reported failures: %v", msgs)
	}
	// The turn ends as interrupted, and the session's process is still the one it was.
	if got := run.turnResult("turn-1"); got == nil || got.Status != stInterrupted {
		t.Errorf("the interrupted turn settled as %v, want %s", got, stInterrupted)
	}
	if n := len(run.fake.Spawns()); n != 1 {
		t.Errorf("the session ran %d processes; an interrupt must not cost the conversation its process", n)
	}
}

// The CLI refuses. Nothing was stopped, so nothing says it was: no interrupt marker, and
// the transcript carries the engine's own reason instead.
func TestSessionReportsARefusedInterruptInsteadOfMarkingIt(t *testing.T) {
	run := runDeliverySession(t,
		[]fakeStep{
			{Await: "user"},
			{Emit: "replay_user"},
			{Emit: "assistant", Text: "working"},
			{Await: "control_request", Subtype: ctrlInterrupt},
			{Emit: "control_response", IsError: true, Text: "interrupt is not supported here"},
			{Emit: "result", Text: "finished anyway"},
			{Emit: "eof"},
		},
		[]scriptedTurn{messageTurn("turn-1", "start something long"), interruptTurn("int-1")},
		func(r *deliverySession) bool { return len(r.errorMessages()) > 0 })

	if markers := run.interruptMarkers(); len(markers) != 0 {
		t.Fatalf("a refused interrupt still marked the turn interrupted: %v", markers)
	}
	msgs := run.errorMessages()
	if len(msgs) != 1 {
		t.Fatalf("a refused interrupt produced %d transcript error(s), want 1: %v", len(msgs), msgs)
	}
	if !strings.Contains(msgs[0], "interrupt is not supported here") {
		t.Errorf("the report lost the engine's own reason: %q", msgs[0])
	}
	// A failed interrupt leaves the session usable, and says so — a person who thinks the
	// run is wedged reaches for something far more destructive.
	if !strings.Contains(msgs[0], "still running") {
		t.Errorf("the report does not say the session survived: %q", msgs[0])
	}
	if n := len(run.fake.Spawns()); n != 1 {
		t.Errorf("the session ran %d processes; a failed interrupt must not be covered up with a kill", n)
	}
}

// A CLI that has stopped reading stdin cannot be asked at all. The interrupt is reported
// as the failure it is, at the door — not accepted and then quietly dropped.
func TestSessionReportsAnInterruptItCouldNotEvenSend(t *testing.T) {
	run := runDeliverySession(t,
		[]fakeStep{
			// stop_reading is a CLI wedged inside a tool call: it keeps writing, and never
			// takes another byte off stdin, so the write queue fills and stays full.
			{Emit: "stop_reading"},
			{Emit: "assistant", Text: "deep inside a tool"},
		},
		append(append([]scriptedTurn{messageTurn("turn-1", "start something long")},
			// Enough traffic to fill the queue behind the wedged CLI, so the interrupt
			// arrives at a runtime with nowhere to put it.
			fillerSteers(claudeWriteQueueDepth+2)...),
			interruptTurn("int-1")),
		func(r *deliverySession) bool { return len(r.errorMessages()) > 0 })

	if markers := run.interruptMarkers(); len(markers) != 0 {
		t.Fatalf("an interrupt that was never sent still marked the turn interrupted: %v", markers)
	}
	if msgs := run.errorMessages(); len(msgs) == 0 {
		t.Fatal("an interrupt that could not be sent reported nothing at all")
	}
}

// fillerSteers makes n steers for the turn in progress, used only to occupy the write
// queue of a CLI that has stopped draining it.
func fillerSteers(n int) []scriptedTurn {
	out := make([]scriptedTurn, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, steerTurn(fmt.Sprintf("filler-%d", i), strings.Repeat("x", 128*1024)))
	}
	return out
}

// The engine also runs turns nobody sent it — a background task reporting in, a scheduled
// wake-up — and those are exactly the ones somebody reaches for stop over. Nothing here
// consults whether a turn of Orbit's own is in flight: the request goes to the CLI, which
// is the only thing that knows what it is doing.
func TestSessionInterruptsATurnItDidNotSend(t *testing.T) {
	run := runDeliverySession(t,
		[]fakeStep{
			{Await: "user"},
			{Emit: "replay_user"},
			{Emit: "result", Text: "done already"},
			// Nothing of Orbit's is in flight from here on: the turn is settled and the
			// engine is talking on its own account.
			{Emit: "assistant", Text: "the background task finished, carrying on"},
			{Await: "control_request", Subtype: ctrlInterrupt},
			{Emit: "control_response"},
			{Emit: "eof"},
		},
		// The interrupt is held back until turn-1 has settled, which is what makes this a
		// stop aimed at a turn Orbit never fed.
		[]scriptedTurn{
			messageTurn("turn-1", "quick one"),
			afterTurn(interruptTurn("int-1"), "turn-1"),
		},
		func(r *deliverySession) bool { return len(r.interruptMarkers()) > 0 })

	if reqs := interruptRequests(run.fake); len(reqs) != 1 {
		t.Fatalf("the CLI received %d interrupt control_request(s), want 1", len(reqs))
	}
	if msgs := run.errorMessages(); len(msgs) != 0 {
		t.Errorf("a confirmed interrupt also reported failures: %v", msgs)
	}
}

// Interrupt-and-send, from the runner's side. The control plane files the follow-up as an
// ordinary message behind the interrupt, so the gate that holds a message until the
// running turn's result is what orders the two — and the frame the person typed reaches
// the CLI only after the turn they stopped is actually over.
func TestSessionDeliversAnInterruptFollowUpOnlyAfterTheTurnEnds(t *testing.T) {
	run := runDeliverySession(t,
		[]fakeStep{
			{Await: "user"},
			{Emit: "replay_user"},
			{Emit: "assistant", Text: "off down the wrong path"},
			{Await: "control_request", Subtype: ctrlInterrupt},
			{Emit: "control_response"},
			{Emit: "result", Subtype: "error_during_execution", Text: "interrupted"},
			{Await: "user"},
			{Emit: "replay_user"},
			{Emit: "result", Text: "done"},
			{Emit: "eof"},
		},
		[]scriptedTurn{
			messageTurn("turn-1", "refactor everything"),
			interruptTurn("int-1"),
			messageTurn("turn-2", "stop — just rename the one file"),
		},
		nil)

	// Order on the wire is the assertion: the follow-up is written after the interrupt,
	// never folded into the turn it was meant to stop.
	var order []string
	for _, frame := range run.fake.Stdin() {
		switch frame["type"] {
		case frameControlRequest:
			req, _ := frame["request"].(map[string]interface{})
			if req != nil && req["subtype"] == ctrlInterrupt {
				order = append(order, "interrupt")
			}
		case frameUser:
			order = append(order, "user:"+userFrameText(t, frame))
		}
	}
	want := []string{"user:refactor everything", "interrupt", "user:stop — just rename the one file"}
	if !equalStrings(order, want) {
		t.Fatalf("the CLI saw %v, want %v", order, want)
	}
	// And the follow-up is a turn of its own, answered on its own — not a steer written
	// into the turn that was being stopped.
	if got := run.turnResult("turn-1"); got == nil || got.Status != stInterrupted {
		t.Errorf("the interrupted turn settled as %v, want %s", got, stInterrupted)
	}
	if got := run.turnResult("turn-2"); got == nil || got.Status != stSucceeded {
		t.Errorf("the follow-up settled as %v, want %s", got, stSucceeded)
	}
	if got := run.deliveryStates("turn-2"); len(got) == 0 || got[len(got)-1] != string(deliveryAcknowledged) {
		t.Errorf("the follow-up's delivery ended at %v, want it acknowledged by the CLI", got)
	}
}
