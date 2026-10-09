//go:build linux || darwin

package main

import (
	"os"
	"testing"
	"time"
)

// A settled block of reasoning says how long it took on the stored event, not only on the page that
// watched it stream: the transcript read back later is the stored events, and without this every
// turn but the one on screen said "Thought" where it had said "Thought for 4s". Driven through the
// real supervisor and a fake claude; the verdict is read off what the control plane was sent.
func TestAStoredThinkingBlockSaysHowLongItTook(t *testing.T) {
	fake := newFakeClaude(t,
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "system_init"},
		fakeStep{Emit: "thinking_delta", Text: "weighing whether to go straight to L3"},
		fakeStep{Await: "release", Text: "settle"},
		fakeStep{Emit: "thinking"},
		fakeStep{Emit: "result", Text: "L3 it is"},
	)
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	job := runnerStopJob(t, "sess-thinking-clock")
	api := newRunnerStopControlPlane()
	api.queue(RunInboxResponse{TurnID: "turn-1", Kind: "message", Content: "which level?"})
	superviseUntilRunnerStop(t, job, true, api)

	awaitCondition(t, 30*time.Second, "the reasoning never started streaming", func() bool {
		return api.delivered(func(e RunEvent) bool { return e.Type == evThinkingDelta })
	})
	// The chunk was timed before it was sent, and the block is closed only after this wait, so the
	// stretch is at least this long however loaded the host is.
	const atLeast = 300 * time.Millisecond
	time.Sleep(atLeast)
	fake.Release("settle")
	awaitCondition(t, 30*time.Second, "turn-1 was never answered", func() bool {
		return api.settled("turn-1")
	})

	for _, e := range api.deliveredEvents() {
		if e.Type != evThinking {
			continue
		}
		ms, ok := e.Payload["thinkingMs"].(float64)
		if !ok || time.Duration(ms)*time.Millisecond < atLeast {
			t.Fatalf("stored thinking block = %v, want thinkingMs of at least %v", e.Payload, atLeast)
		}
		return
	}
	t.Fatalf("no thinking block reached the control plane: %v", api.deliveredEvents())
}
