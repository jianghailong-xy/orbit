//go:build linux || darwin

package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// The runner replaces a session's engine in place — for a setting only a new process can take, for
// a CURRENT_WORK frame it fenced, for an engine that crashed in the middle of a turn — and says so
// with a `resumed` system event. On that event the control plane empties the session's running
// background set, which the session list and header read "Background running" from (apiserver
// runner-api.controller bgReset): the replaced engine's own shells died with it. The jobs the runner
// hosts did not, and one the control plane is not told about again reads as not running until it ends.
//
// Driven through the real supervisor, runInteractiveSession, against the fake CLI, with the jobs run
// over the session's real socket; the verdict is read off what the control plane was actually sent.

// withoutIdleMs is a `running` report with its `idleMs` taken off: the one field that legitimately
// differs between a launch report and a re-announcement minutes later, since it is a duration that
// grows while the job produces nothing — and both jobs here are `exec sleep 300`, which produce
// nothing at all. Everything else about the report is the job's identity, and that is what has to
// match: the control plane rebuilds the job off it.
func withoutIdleMs(payload map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{}, len(payload))
	for k, v := range payload {
		if k != "idleMs" {
			out[k] = v
		}
	}
	return out
}

// deliveredEvents is every event the control plane accepted, in the order it accepted them.
func (c *runnerStopControlPlane) deliveredEvents() []RunEvent {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]RunEvent(nil), c.events...)
}

// settled reports whether the runner acknowledged turnID.
func (c *runnerStopControlPlane) settled(turnID string) bool {
	for _, completion := range c.turnCompletions() {
		if completion.TurnID == turnID {
			return true
		}
	}
	return false
}

// kill is bg_kill as the agent makes it, over the session's socket.
func (s *runnerStopSupervisor) kill(t *testing.T, jobID string) {
	t.Helper()
	token, err := os.ReadFile(bgTokenPath(s.job.SessionID))
	if err == nil {
		_, err = bgSocketCall(bgSocketPath(s.job.SessionID), strings.TrimSpace(string(token)), "kill",
			map[string]interface{}{"jobId": jobID})
	}
	if err != nil {
		t.Logf("bg_kill %s: %v", jobID, err)
	}
}

// A claim has made a parked session active, and the control plane hands the runner the `reload` it
// queued ahead of the claim's message: fast mode, which only a new process takes. By then the session
// hosts a job and a service that are running, a job that has ended, and a shell the old engine
// started itself.
func TestEngineRebuiltForAConfigChangeAnnouncesTheJobsThatOutlivedIt(t *testing.T) {
	devServerOutput := filepath.Join(t.TempDir(), "b7k2m9.output")
	fake := newFakeClaude(t,
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "system_init"},
		fakeStep{Emit: "tool_use", ToolUseID: "toolu_devserver", ToolName: "Bash",
			Input: map[string]interface{}{"command": "npm run dev", "run_in_background": true}},
		fakeStep{Emit: "tool_result", ToolUseID: "toolu_devserver",
			Text: "Command running in background with ID: b7k2m9. Output is being written to: " + devServerOutput},
		fakeStep{Emit: "result", Text: "the dev server is up"},
	)
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	job := runnerStopJob(t, "sess-resumed-jobs")
	api := newRunnerStopControlPlane()
	api.queue(RunInboxResponse{TurnID: "turn-1", Kind: "message", Content: "start the dev server"})
	sup := superviseUntilRunnerStop(t, job, true, api)
	awaitCondition(t, 30*time.Second, "turn-1 was never acknowledged and parked", func() bool {
		return api.settled("turn-1") && !sup.pool.isActive(sup.live)
	})

	build := sup.mustRun(t, "exec sleep 300", bgKindJob)
	preview := sup.mustRun(t, "exec sleep 300", bgKindService)
	lint, err := sup.run(t, "exit 3", bgKindJob)
	if err != nil {
		t.Fatalf("bg_run of a job that exits at once failed: %v", err)
	}
	// Ahead of the supervisor's own teardown, which would give the job bgDrainWaitCap to finish.
	t.Cleanup(func() {
		sup.kill(t, build.JobID)
		sup.kill(t, preview.JobID)
	})
	awaitCondition(t, 15*time.Second, "the launches, and the end of the job that exited, were never delivered", func() bool {
		return api.delivered(isJobLaunch(build.JobID)) && api.delivered(isJobLaunch(preview.JobID)) &&
			len(api.terminalReports(lint.JobID)) == 1
	})

	// The claim as runLoop hands it over, then the two turns the control plane queued behind it, in
	// the order it hands them out: the reload first.
	claim := *job
	if _, ok := sup.pool.activate(&claim); !ok {
		t.Fatal("the claim could not activate the parked session")
	}
	api.queue(RunInboxResponse{TurnID: "reload-1", Kind: "reload", Content: `{"fastMode":true}`})
	api.queue(RunInboxResponse{TurnID: "turn-2", Kind: "message", Content: "carry on"})
	// A turn is acknowledged only after every event before it has been sent, so once the rebuilt
	// engine has answered turn-2, whatever the runner said about the rebuild is on the control plane.
	awaitCondition(t, time.Minute, "the rebuilt engine never answered turn-2", func() bool {
		return api.settled("turn-2")
	})
	if n := len(fake.Spawns()); n != 2 {
		t.Fatalf("claude was spawned %d times, want 2: the reload rebuilds the engine once", n)
	}

	events := api.deliveredEvents()
	var resumed *RunEvent
	for i := range events {
		if events[i].Type == evSystem && events[i].Payload["subtype"] == "resumed" {
			resumed = &events[i]
			break
		}
	}
	if resumed == nil || resumed.Payload["reason"] != "config_changed" {
		t.Fatalf("the rebuild was not marked by a config_changed resumed handshake (%+v): the control plane never emptied the set, so nothing here is tested", resumed)
	}
	// The `running` reports the runner sent, split at the handshake: before it the launch, after it
	// whatever puts the id back.
	launched := map[string]map[string]interface{}{}
	again := map[string][]map[string]interface{}{}
	for _, e := range events {
		if e.Type != evBackgroundTask || asString(e.Payload["status"]) != bgStatusRunning {
			continue
		}
		id := asString(e.Payload["toolUseId"])
		switch {
		case e.Seq > resumed.Seq:
			again[id] = append(again[id], e.Payload)
		case launched[id] == nil:
			launched[id] = e.Payload
		}
	}

	for _, running := range []bgJobStatus{build, preview} {
		// Signal 0 on a child of this process that nothing has reaped: the job outlived the engine.
		if !processAlive(running.PID) {
			t.Errorf("%s %s (pid %d) did not outlive the engine it was started beside", running.Kind, running.JobID, running.PID)
			continue
		}
		switch reports := again[running.JobID]; {
		case len(reports) == 0:
			t.Errorf("%s %s is still running, and nothing the runner sent after the resumed handshake says so: the session reads it as not running until it ends",
				running.Kind, running.JobID)
		case len(reports) > 1:
			t.Errorf("%s %s was announced %d times after one handshake, want once: %v", running.Kind, running.JobID, len(reports), reports)
		case !reflect.DeepEqual(withoutIdleMs(reports[0]), withoutIdleMs(launched[running.JobID])):
			t.Errorf("%s %s was announced as %v, want the report its launch sent: %v",
				running.Kind, running.JobID, reports[0], launched[running.JobID])
		case reports[0]["idleMs"] == nil:
			t.Errorf("%s %s was announced without the idle duration that says it is still moving: %v",
				running.Kind, running.JobID, reports[0])
		}
	}
	if reports := again[lint.JobID]; len(reports) != 0 {
		t.Errorf("job %s had ended before the rebuild, and was announced running after the handshake: %v", lint.JobID, reports)
	}
	// The old engine's own shell was running when the engine went, so it was reported killed with it —
	if !api.delivered(func(e RunEvent) bool {
		return e.Seq < resumed.Seq && e.Type == evBackgroundTask &&
			asString(e.Payload["toolUseId"]) == "toolu_devserver" && asString(e.Payload["status"]) == bgStatusKilled
	}) {
		t.Error("the old engine's own shell was never reported killed with it, so it was not running when the engine was replaced, and the check below proves nothing")
	}
	// — and nothing puts it back.
	if reports := again["toolu_devserver"]; len(reports) != 0 {
		t.Errorf("the old engine's own shell died with it, and was announced running after the handshake: %v", reports)
	}
}
