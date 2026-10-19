//go:build linux || darwin

package main

import (
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// Through the real supervisor and a scripted Claude: a managed runner syncs its volume behind the
// engine's tool, after the turn's work and before the control plane hears the turn is over, and
// again before the session's end is reported. What the engine wrote in that turn — its transcript,
// its Git work — is then on the disk whenever the control plane thinks it happened.
func TestManagedSessionSyncsItsVolumeBeforeReportingTheTurnAndTheEnd(t *testing.T) {
	fake := newFakeClaude(t,
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "system_init"},
		fakeStep{Emit: "tool_use", ToolUseID: "toolu_commit", ToolName: "Bash", Input: map[string]interface{}{"command": "git commit -qam change"}},
		fakeStep{Emit: "tool_result", ToolUseID: "toolu_commit", Text: "committed"},
		fakeStep{Emit: "assistant", Text: "committed"},
		fakeStep{Emit: "result", Text: "committed"},
	)
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	job := runnerStopJob(t, "sess-durable-turn")
	withManagedInstance(t, "4", testManagedPodUID)
	syncs := recordVolumeSyncs(t)
	api := newRunnerStopControlPlane()
	api.queue(RunInboxResponse{TurnID: "turn-1", Kind: "message", Content: "commit the change"})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/turn-complete"):
			syncs.note("turn-complete")
		case strings.HasSuffix(r.URL.Path, "/finalize"):
			syncs.note("finalize")
		}
		api.serve(w, r)
	})
	sup := superviseUntilRunnerStopOn(t, job, true, api, handler)
	awaitCondition(t, 30*time.Second, "the turn was never reported complete", func() bool {
		return len(api.turnCompletions()) > 0
	})
	sup.end()
	sup.awaitReturn(t, time.Minute)

	steps := syncs.steps()
	turn, end := indexOf(steps, "turn-complete"), indexOf(steps, "finalize")
	if turn < 1 || steps[turn-1] != "sync" {
		t.Fatalf("order %v: the turn was reported without a volume sync right before it", steps)
	}
	if end < 0 || steps[end-1] != "sync" || end-1 <= turn {
		t.Fatalf("order %v: the session's end was reported without a volume sync of its own right before it", steps)
	}
	home := os.Getenv("ORBIT_HOME")
	behindTheTool := 0
	for _, paths := range syncs.syncs {
		if paths[0] != home {
			t.Fatalf("a sync named %v, want ORBIT_HOME %s first", paths, home)
		}
		if len(paths) == 1 {
			behindTheTool++ // the background one names only the volume; a report's names its session's checkout too
		}
	}
	if behindTheTool == 0 {
		t.Fatalf("no sync behind the engine's tool: %v", syncs.syncs)
	}
}

func indexOf(steps []string, step string) int {
	for i, s := range steps {
		if s == step {
			return i
		}
	}
	return -1
}
