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
	if behindTheTool := managedSessionSyncs(t, false); behindTheTool == 0 {
		t.Fatal("no sync behind the engine's tool")
	}
}

// On a volume that shares its filesystem (a Docker local volume) the same session is synced before
// the turn and the end are reported, and not behind the tool.
func TestManagedSessionOnASharedVolumeSyncsBeforeReportsOnly(t *testing.T) {
	if behindTheTool := managedSessionSyncs(t, true); behindTheTool != 0 {
		t.Fatalf("%d syncs behind the engine's tool on a shared volume", behindTheTool)
	}
}

// managedSessionSyncs runs one turn whose engine commits, then ends the session, and checks that a
// sync came right before the turn was reported and another right before the end was. It returns how
// many syncs ran behind the tool.
func managedSessionSyncs(t *testing.T, shared bool) int {
	t.Helper()
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
	volumeSharedAs(t, shared)
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
	return behindTheTool
}

func indexOf(steps []string, step string) int {
	for i, s := range steps {
		if s == step {
			return i
		}
	}
	return -1
}

// A session the volume check found in a damaged repository is refused when it is reclaimed. The claim
// that wakes its supervisor brings a fresh payload, and the engine must still not start: the session
// fails with the refusal, which says what is wrong, and no Claude is spawned anywhere.
func TestManagedRunnerRefusesTheClaimOfASessionRefusedAtReclaim(t *testing.T) {
	fake := newFakeClaude(t, fakeStep{Await: "user"})
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	job := runnerStopJob(t, "sess-refused-reclaim")
	withManagedInstance(t, "4", testManagedPodUID)
	recordVolumeSyncs(t)
	reason := "the Git repository at /var/lib/orbit/home/orbit-repos/default cannot be read: its HEAD is empty" + repositoryDamagedAdvice
	job.SourceRefusal = &SourcePinRefusal{Code: repositoryDamagedRefusal, Detail: map[string]interface{}{"reason": reason}}
	api := newRunnerStopControlPlane()
	api.queue(RunInboxResponse{TurnID: "turn-1", Kind: "message", Content: "carry on"})
	sup := superviseUntilRunnerStop(t, job, false, api)

	claim := *job
	claim.SourceRefusal = nil // what a claim payload carries
	if _, ok := sup.pool.activate(&claim); !ok {
		t.Fatal("the claim did not activate the reclaimed supervisor")
	}
	refused := func(e RunEvent) bool {
		message, _ := e.Payload["message"].(string)
		return e.Type == evError && strings.Contains(message, repositoryDamagedRefusal+": "+reason)
	}
	awaitCondition(t, 30*time.Second, "the refusal never reached the control plane", func() bool { return api.delivered(refused) })
	sup.awaitReturn(t, time.Minute)
	if spawns := fake.Spawns(); len(spawns) != 0 {
		t.Fatalf("Claude was spawned for a refused session: %v", spawns)
	}
}
