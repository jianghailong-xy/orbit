package main

import (
	"strings"
	"testing"
)

// fedText is the text of the user frame the fake CLI read at position i.
func fedText(t *testing.T, s *supervisedSession, i int) string {
	t.Helper()
	frames := s.fake.Stdin()
	var users []map[string]interface{}
	for _, frame := range frames {
		if frame["type"] == "user" {
			users = append(users, frame)
		}
	}
	if i >= len(users) {
		t.Fatalf("the CLI read %d user frames, want at least %d", len(users), i+1)
	}
	var text strings.Builder
	content, _ := mapValue(users[i]["message"])["content"].([]interface{})
	for _, block := range content {
		if s, ok := mapValue(block)["text"].(string); ok {
			text.WriteString(s)
		}
	}
	return text.String()
}

// After a compaction the next message the engine reads is led by the note, once; the first message, and the one
// after, carry nothing; and the clients' own record of the message is the person's words alone.
func TestTheMessageAfterACompactionCarriesTheContextResetNote(t *testing.T) {
	pool := newSessionPoolWithClock(1, newFakePoolClock())
	s := superviseClaudeSession(t, pool,
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "system_init"},
		fakeStep{Emit: "system_status", Subtype: "compact_boundary"},
		fakeStep{Emit: "result", Text: "compacted"},
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "result", Text: "continued"},
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "result", Text: "done"},
	)
	// Each later message reaches the parked session the way runLoop hands one over: a claim, then the inbox.
	claimAndSend := func(turnID, content string) {
		claim := *s.job
		if _, ok := pool.activate(&claim); !ok {
			t.Fatalf("the parked session could not be claimed for %s", turnID)
		}
		s.queue(RunInboxResponse{TurnID: turnID, Kind: "message", Content: content})
		s.awaitParked(turnID)
	}
	s.awaitParked("turn-1")
	claimAndSend("turn-2", "Continue.")
	claimAndSend("turn-3", "And then?")

	if first := fedText(t, s, 0); strings.Contains(first, "this conversation was compacted or resumed") {
		t.Errorf("the session's first message carried the note: %q", first)
	}
	note := withContextResetNote("", true, s.job.insideRecordedWork())
	if second := fedText(t, s, 1); second != note+"\n\nContinue." {
		t.Errorf("the message after the compaction = %q, want the note and then the person's words", second)
	}
	if third := fedText(t, s, 2); strings.Contains(third, note) {
		t.Errorf("the note was carried twice: %q", third)
	}
	for _, e := range s.eventsOf(func(e RunEvent) bool { return e.Type == evUser }) {
		if strings.Contains(asString(e.Payload["text"]), "Orbit: this conversation was compacted") {
			t.Errorf("the clients' user event carries the note: %v", e.Payload)
		}
	}
}

// A slash command after a compaction reaches the CLI as the person typed it: the CLI runs `/compact` only when the
// text starts with it, so the note in front turned it into a plain message the agent answered. The note waits for
// the next ordinary message instead.
func TestASlashCommandAfterACompactionIsFedBareAndTheNoteWaits(t *testing.T) {
	pool := newSessionPoolWithClock(1, newFakePoolClock())
	s := superviseClaudeSession(t, pool,
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "system_init"},
		fakeStep{Emit: "system_status", Subtype: "compact_boundary"},
		fakeStep{Emit: "result", Text: "compacted"},
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "result", Text: "compacted again"},
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "result", Text: "continued"},
	)
	claimAndSend := func(turnID, content string) {
		claim := *s.job
		if _, ok := pool.activate(&claim); !ok {
			t.Fatalf("the parked session could not be claimed for %s", turnID)
		}
		s.queue(RunInboxResponse{TurnID: turnID, Kind: "message", Content: content})
		s.awaitParked(turnID)
	}
	s.awaitParked("turn-1")
	claimAndSend("turn-2", "/compact")
	claimAndSend("turn-3", "Continue.")

	if second := fedText(t, s, 1); second != "/compact" {
		t.Errorf("the slash command after the compaction = %q, want it bare", second)
	}
	note := withContextResetNote("", true, s.job.insideRecordedWork())
	if third := fedText(t, s, 2); third != note+"\n\nContinue." {
		t.Errorf("the message after the slash command = %q, want the note and then the person's words", third)
	}
}

// What the CLI reads as a slash command: a leading `/name`, not a path such as `/root/x is missing`.
func TestIsClaudeSlashCommand(t *testing.T) {
	for text, want := range map[string]bool{
		"/compact": true, "/compact keep the plan": true, "/review 12": true, "/plugin:skill": true,
		"Continue.": false, "": false, "/": false, " /compact": false, "/root/x is missing": false,
	} {
		if got := isClaudeSlashCommand(text); got != want {
			t.Errorf("isClaudeSlashCommand(%q) = %v, want %v", text, got, want)
		}
	}
}

// A turn that touched Orbit files its counts-only telemetry just ahead of its turn_end, through the session's own
// emit path, as every engine's turns do.
func TestATurnThatTouchedOrbitFilesItsTelemetryBeforeItsTurnEnd(t *testing.T) {
	t.Setenv(agentContractTelemetryEnv, "")
	pool := newSessionPoolWithClock(1, newFakePoolClock())
	receipt := `{"receiptVersion":1,"ok":true,"outcome":"read","operation":"task_get","id":"t1","status":"OPEN"}`
	s := superviseClaudeSession(t, pool,
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "system_init"},
		fakeStep{Emit: "tool_use", ToolUseID: "toolu_get", ToolName: "mcp__orbit__task_get", Input: map[string]interface{}{}},
		fakeStep{Emit: "tool_result", ToolUseID: "toolu_get", Text: receipt},
		fakeStep{Emit: "assistant", Text: "read it"},
		fakeStep{Emit: "result", Text: "read it"},
	)
	s.awaitParked("turn-1")
	s.awaitEvents("the turn's end", 1, isTurnEnd)
	s.mu.Lock()
	events := append([]RunEvent(nil), s.events...)
	s.mu.Unlock()
	telemetryAt, endAt := -1, -1
	for i, e := range events {
		if e.Type == evSystem && e.Payload["subtype"] == agentContractTelemetrySubtype {
			telemetryAt = i
			summary := mapValue(e.Payload["agentContractTelemetry"])
			if evalInt(summary["orbitCalls"]) != 1 || evalInt(summary["firstOrbitSuccessStep"]) != 1 ||
				evalInt(mapValue(summary["operations"])["task_get"]) != 1 {
				t.Errorf("summary = %v", summary)
			}
		}
		if e.Type == evTurnEnd && endAt < 0 {
			endAt = i
		}
	}
	if telemetryAt < 0 || endAt < 0 || telemetryAt > endAt {
		t.Fatalf("telemetry at %d, turn_end at %d in %d events: want the summary just before the turn's end", telemetryAt, endAt, len(events))
	}
}

// Codex's next turn after a compaction or a resume leads with the note, once; an ordinary turn carries nothing.
func TestCodexTurnAfterACompactionOrAResumeCarriesTheContextResetNote(t *testing.T) {
	app := &codexAppServer{instructionMode: codexInstructionsAdditionalContext}
	if got := app.turnPrompt("first", true); got != "first" {
		t.Fatalf("an ordinary turn = %q", got)
	}
	app.markInstructionContextForRefresh()
	if got := app.turnPrompt("Continue.", true); got != orbitContextResetNote+"\n\nContinue." {
		t.Fatalf("the turn after a compaction = %q", got)
	}
	if got := app.turnPrompt("again", true); got != "again" {
		t.Fatalf("the note was carried twice: %q", got)
	}
	// A resumed thread is the other reset (startOrResumeThread sets it on thread/resume).
	app.resetNotePending.Store(true)
	if got := app.turnPrompt("", true); got != orbitContextResetNote {
		t.Fatalf("an empty turn after a resume = %q", got)
	}
	// A session that runs no task is told to re-read what it names, not a task it does not have.
	app.resetNotePending.Store(true)
	if got := app.turnPrompt("Continue.", false); got != orbitContextResetNoteFree+"\n\nContinue." ||
		strings.Contains(got, "task_get") {
		t.Fatalf("the turn after a reset in a session with no task = %q", got)
	}
}
