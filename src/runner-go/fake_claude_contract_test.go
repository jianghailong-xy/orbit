package main

import (
	"testing"
)

// What the fixture must guarantee before anything is built on it. Every wait below is on
// a protocol event — a frame arriving, a process exiting — never on a duration.

func TestFakeClaudeRecordsArgvAndStdin(t *testing.T) {
	f := newFakeClaude(t,
		fakeStep{Await: "user"},
		fakeStep{Emit: "result", Text: "ok"},
	)
	argv := []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--session-id", "sess-1"}
	run := f.start(argv...)

	run.send(userFrame("sess-1", []map[string]interface{}{{"type": "text", "text": "hi"}}))
	run.nextOfType("result")

	spawns := f.Spawns()
	if len(spawns) != 1 {
		t.Fatalf("spawns = %d, want 1", len(spawns))
	}
	if len(spawns[0].Argv) != len(argv) {
		t.Fatalf("argv = %v, want %v", spawns[0].Argv, argv)
	}
	for i, a := range argv {
		if spawns[0].Argv[i] != a {
			t.Fatalf("argv = %v, want %v", spawns[0].Argv, argv)
		}
	}
	if spawns[0].PID == 0 {
		t.Error("spawn record has no pid")
	}

	frames := f.Stdin()
	if len(frames) != 1 {
		t.Fatalf("stdin frames = %d, want 1", len(frames))
	}
	if frames[0]["type"] != "user" || frames[0]["session_id"] != "sess-1" {
		t.Errorf("recorded frame = %v, want the user frame verbatim", frames[0])
	}
}

// `result` closes a turn, not the process: the fake must still be there for the next
// message, and only stdin EOF ends it. This is the timing the persistent-process work
// depends on, so it is pinned here rather than assumed.
func TestFakeClaudeOutlivesResultAndTakesASecondTurn(t *testing.T) {
	f := newFakeClaude(t,
		fakeStep{Emit: "system_init"},
		fakeStep{Await: "user"},
		fakeStep{Emit: "result", Text: "first"},
		fakeStep{Await: "user"},
		fakeStep{Emit: "result", Text: "second"},
	)
	run := f.start("-p", "--session-id", "sess-2")

	if init := run.nextOfType("system"); init["subtype"] != "init" || init["session_id"] != "sess-2" {
		t.Errorf("init = %v, want subtype init for sess-2", init)
	}
	msg := func(text string) string {
		return userFrame("sess-2", []map[string]interface{}{{"type": "text", "text": text}})
	}
	run.send(msg("one"))
	if got := run.nextOfType("result"); got["result"] != "first" {
		t.Fatalf("first result = %v", got)
	}
	// The process is still alive after a result — the proof is that it answers again.
	run.send(msg("two"))
	if got := run.nextOfType("result"); got["result"] != "second" {
		t.Fatalf("second result = %v", got)
	}
	if n := len(f.Spawns()); n != 1 {
		t.Errorf("spawns = %d, want 1 (both turns went to the same process)", n)
	}
	if got := f.WaitStdin(2); len(got) != 2 {
		t.Fatalf("stdin frames = %d, want 2", len(got))
	}

	run.closeStdin()
	if err := run.waitExit(); err != nil {
		t.Errorf("exit after stdin EOF: %v", err)
	}
}

// The frames the fake emits must be the ones the runner already knows how to read, or
// tests built on it would pass against a dialect nothing speaks.
func TestFakeClaudeFramesParseAsRunnerEvents(t *testing.T) {
	f := newFakeClaude(t,
		fakeStep{Emit: "system_init"},
		fakeStep{Emit: "tool_use", ToolUseID: "toolu_1", ToolName: "Bash",
			Input: map[string]interface{}{"command": "echo hi"}},
		fakeStep{Emit: "tool_result", ToolUseID: "toolu_1", Text: "hi"},
		fakeStep{Emit: "result", Text: "done"},
		fakeStep{Emit: "eof"},
	)
	run := f.start("-p", "--session-id", "sess-3", "--model", "claude-opus-5")

	type event struct {
		kind    string
		payload map[string]interface{}
	}
	var events []event
	for {
		msg, ok := run.next()
		if !ok {
			break
		}
		if msg["type"] == "result" {
			if res := resultFrom(msg, t.Context()); res.Result != "done" || res.Status != stSucceeded {
				t.Errorf("resultFrom = %+v, want done/succeeded", res)
			}
			continue
		}
		handleMessage(msg, func(kind string, p map[string]interface{}) {
			events = append(events, event{kind, p})
		}, nil)
	}
	if len(events) != 3 {
		t.Fatalf("events = %+v, want system + tool_use + tool_result", events)
	}
	if events[0].kind != evSystem || events[0].payload["subtype"] != "init" ||
		events[0].payload["model"] != "claude-opus-5" {
		t.Errorf("event 0 = %+v, want system/init carrying the spawned model", events[0])
	}
	if events[1].kind != evToolUse || events[1].payload["id"] != "toolu_1" ||
		events[1].payload["name"] != "Bash" {
		t.Errorf("event 1 = %+v, want tool_use toolu_1/Bash", events[1])
	}
	if events[2].kind != evToolResult || events[2].payload["toolUseId"] != "toolu_1" ||
		events[2].payload["content"] != "hi" {
		t.Errorf("event 2 = %+v, want tool_result for toolu_1", events[2])
	}
}

// Interrupt is a control_request we send; the answer comes back tagged with the id we
// chose. Without that correlation an interrupt cannot be told from any other reply.
func TestFakeClaudeAnswersInterruptWithMatchingRequestID(t *testing.T) {
	f := newFakeClaude(t,
		fakeStep{Await: "control_request", Subtype: "interrupt"},
		fakeStep{Emit: "control_response", Response: map[string]interface{}{"acknowledged": true}},
	)
	run := f.start("-p")

	run.send(controlRequestFrame("req-42", "interrupt"))
	answer, ok := parseControlResponse(run.nextOfType("control_response"))
	if !ok {
		t.Fatal("the fake's answer is not a control_response")
	}
	if answer.RequestID != "req-42" {
		t.Errorf("RequestID = %q, want req-42", answer.RequestID)
	}
	if answer.Subtype != "success" || answer.Response["acknowledged"] != true {
		t.Errorf("answer = %+v, want a success carrying the payload", answer)
	}
}

// The other direction: the CLI asks (can_use_tool), Orbit answers, and the CLI only
// proceeds once the answer carrying its request_id arrives.
func TestFakeClaudeCanUseToolRoundTrip(t *testing.T) {
	f := newFakeClaude(t,
		fakeStep{Await: "user"},
		fakeStep{Emit: "control_request", Subtype: "can_use_tool", RequestID: "req-cr-1",
			Request: map[string]interface{}{"tool_name": "Bash", "tool_use_id": "toolu_9",
				"input": map[string]interface{}{"command": "ls"}}},
		fakeStep{Await: "control_response", RequestID: "req-cr-1"},
		fakeStep{Emit: "result", Text: "allowed"},
	)
	run := f.start("-p", "--session-id", "sess-4")

	run.send(userFrame("sess-4", []map[string]interface{}{{"type": "text", "text": "run ls"}}))
	ask, ok := parseControlRequest(run.nextOfType("control_request"))
	if !ok {
		t.Fatal("the fake's ask is not a control_request")
	}
	if ask.Subtype != "can_use_tool" || ask.Request["tool_name"] != "Bash" {
		t.Fatalf("ask = %+v, want can_use_tool for Bash", ask)
	}

	run.send(controlResponseFrame(ask.RequestID, map[string]interface{}{"behavior": "allow"}))
	// Reaching the result proves the fake matched the answer to req-cr-1 and moved on.
	if got := run.nextOfType("result"); got["result"] != "allowed" {
		t.Fatalf("result = %v, want allowed", got)
	}

	frames := f.WaitStdin(2)
	reply, ok := parseControlResponse(frames[1])
	if !ok || reply.RequestID != "req-cr-1" {
		t.Errorf("recorded reply = %v, want a control_response for req-cr-1", frames[1])
	}
}

// A scripted eof ends the process without stdin closing — the one terminal condition the
// runner may not confuse with a turn boundary.
func TestFakeClaudeScriptedEOF(t *testing.T) {
	f := newFakeClaude(t,
		fakeStep{Emit: "system_init"},
		fakeStep{Emit: "eof"},
	)
	run := f.start("-p", "--session-id", "sess-5")

	run.nextOfType("system")
	if _, ok := run.next(); ok {
		t.Fatal("expected stdout EOF after the eof step")
	}
	if err := run.waitExit(); err != nil {
		t.Errorf("exit after eof: %v", err)
	}
}
