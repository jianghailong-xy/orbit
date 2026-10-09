package main

import (
	"testing"
	"time"
)

// thinkingAt is a moment `offset` into a turn, on the clock the runner stamps events with.
func thinkingAt(offset time.Duration) time.Time {
	return time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC).Add(offset)
}

func thinkingMsOf(t *testing.T, payload map[string]interface{}) (int64, bool) {
	t.Helper()
	v, ok := payload["thinkingMs"]
	if !ok {
		return 0, false
	}
	ms, isInt := v.(int64)
	if !isInt {
		t.Fatalf("thinkingMs = %#v, want whole milliseconds", v)
	}
	return ms, true
}

// Claude's shape: a block's deltas, then the block itself with no text of its own. The stored
// block is what a transcript read back later has, so it is what has to carry the duration.
func TestAThinkingBlockCarriesHowLongItsStretchStreamed(t *testing.T) {
	var c thinkingClock
	c.observe(evThinkingDelta, map[string]interface{}{"text": "weighing whether"}, thinkingAt(0))
	c.observe(evThinkingDelta, map[string]interface{}{"text": " to go straight to L3"}, thinkingAt(1500*time.Millisecond))
	block := map[string]interface{}{"text": ""}

	stored := c.observe(evThinking, block, thinkingAt(4200*time.Millisecond))

	if ms, ok := thinkingMsOf(t, stored); !ok || ms != 4200 {
		t.Fatalf("stored block = %v, want thinkingMs 4200", stored)
	}
	if _, written := block["thinkingMs"]; written {
		t.Error("the engine's own payload map was written to; the stamp belongs on a copy")
	}
}

// Kimi closes one block for the whole turn, at its end. Between its first thought and that block
// sit tool calls and a streamed reply, none of which is reasoning.
func TestReasoningTheModelPausedIsCountedWithoutThePause(t *testing.T) {
	var c thinkingClock
	c.observe(evThinkingDelta, map[string]interface{}{"text": "first I need the file"}, thinkingAt(0))
	c.observe(evToolUse, map[string]interface{}{"id": "call_1", "name": "Read"}, thinkingAt(2*time.Second))
	c.observe(evToolResult, map[string]interface{}{"toolUseId": "call_1"}, thinkingAt(30*time.Second))
	c.observe(evThinkingDelta, map[string]interface{}{"text": "now the fix"}, thinkingAt(31*time.Second))
	c.observe(evTextDelta, map[string]interface{}{"text": "Done"}, thinkingAt(34*time.Second))

	stored := c.observe(evThinking, map[string]interface{}{"text": "first I need the file now the fix"}, thinkingAt(60*time.Second))

	if ms, ok := thinkingMsOf(t, stored); !ok || ms != 5000 {
		t.Fatalf("stored block = %v, want thinkingMs 5000: two stretches of 2s and 3s, not the 60s turn", stored)
	}
}

// dsh and opencode write their reasoning as durable blocks with no deltas ahead of them, and a
// block straight after one that was claimed has nothing behind it either: no start was seen, so
// no duration is stated rather than a wrong one.
func TestABlockNothingStreamedStatesNoDuration(t *testing.T) {
	var c thinkingClock
	if stored := c.observe(evThinking, map[string]interface{}{"text": "from an engine that streams no deltas"}, thinkingAt(time.Second)); stored["thinkingMs"] != nil {
		t.Fatalf("a block nothing streamed was stamped: %v", stored)
	}

	c.observe(evThinkingDelta, map[string]interface{}{"text": "a"}, thinkingAt(2*time.Second))
	c.observe(evThinking, map[string]interface{}{"text": "a"}, thinkingAt(3*time.Second))
	if stored := c.observe(evThinking, map[string]interface{}{"text": "b"}, thinkingAt(9*time.Second)); stored["thinkingMs"] != nil {
		t.Fatalf("a second block inherited the first one's stretch: %v", stored)
	}
}

// What ends a turn's live drafts on the clients ends an unclaimed stretch here, so the next one is
// not billed for it. A steer is written into the running turn and ends nothing.
func TestABoundaryEndsAStretchThatNeverGotABlock(t *testing.T) {
	boundaries := []struct {
		name      string
		eventType string
		payload   map[string]interface{}
	}{
		{"reply", evAssistant, map[string]interface{}{"text": "here"}},
		{"turn end", evTurnEnd, map[string]interface{}{}},
		{"interrupt", evInterrupt, map[string]interface{}{}},
		{"error", evError, map[string]interface{}{"message": "API Error: 529"}},
		{"next message", evUser, map[string]interface{}{"text": "go on"}},
		{"engine restart", evSystem, map[string]interface{}{"subtype": "resumed"}},
	}
	for _, b := range boundaries {
		t.Run(b.name, func(t *testing.T) {
			var c thinkingClock
			c.observe(evThinkingDelta, map[string]interface{}{"text": "abandoned"}, thinkingAt(0))
			c.observe(b.eventType, b.payload, thinkingAt(5*time.Second))
			c.observe(evThinkingDelta, map[string]interface{}{"text": "fresh"}, thinkingAt(20*time.Second))

			stored := c.observe(evThinking, map[string]interface{}{"text": ""}, thinkingAt(21*time.Second))

			if ms, ok := thinkingMsOf(t, stored); !ok || ms != 1000 {
				t.Fatalf("stored block = %v, want thinkingMs 1000: only the stretch after the %s", stored, b.name)
			}
		})
	}

	var c thinkingClock
	c.observe(evThinkingDelta, map[string]interface{}{"text": "weighing"}, thinkingAt(0))
	c.observe(evUser, map[string]interface{}{"text": "also check the logs", "steer": true}, thinkingAt(time.Second))
	stored := c.observe(evThinking, map[string]interface{}{"text": ""}, thinkingAt(3*time.Second))
	if ms, ok := thinkingMsOf(t, stored); !ok || ms != 3000 {
		t.Fatalf("stored block = %v, want thinkingMs 3000: a steer does not end the stretch", stored)
	}
}

// A sub-agent's blocks arrive while its parent's stretch may be open, but only the parent's
// deltas reach the stream: the sub-agent's events neither take the parent's time nor end it.
func TestASubAgentNeitherClaimsNorEndsItsParentsStretch(t *testing.T) {
	var c thinkingClock
	c.observe(evThinkingDelta, map[string]interface{}{"text": "while that agent works"}, thinkingAt(0))

	sub := c.observe(evThinking, map[string]interface{}{"text": "the sub-agent's own", "parentToolUseId": "toolu_task"}, thinkingAt(time.Second))
	c.observe(evAssistant, map[string]interface{}{"text": "found it", "parentToolUseId": "toolu_task"}, thinkingAt(2*time.Second))
	parent := c.observe(evThinking, map[string]interface{}{"text": ""}, thinkingAt(3*time.Second))

	if sub["thinkingMs"] != nil {
		t.Errorf("the sub-agent's block took its parent's time: %v", sub)
	}
	if ms, ok := thinkingMsOf(t, parent); !ok || ms != 3000 {
		t.Fatalf("parent's block = %v, want thinkingMs 3000", parent)
	}
}
