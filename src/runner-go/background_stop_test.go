//go:build linux || darwin

package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The composer's Stop ends the session's background work along with the turn it is stopping.
//
// It is the ONE exception to "no kill on this path", and it has to stay one: the interrupt's
// contract is that the engine's process, its conversation and its stdin survive it, which is the
// entire difference from `end`. So every way of asking for an interrupt that does NOT carry the
// explicit flag has to leave background work exactly as it found it — the engine interrupting
// itself, the MCP tool, the CLI, and the browser's plain interrupt — and that is what the
// negative control here pins.
//
// What Stop ends, and how the two halves differ, is the point of the first test: the runner's own
// jobs are killed for real (their waiter reports the exit), and the engine's own tasks — the
// shells and Monitors running inside a process this runner does not own — are reported killed so
// the session's background tray resolves rather than claiming a stopped watcher is still running.
// A `!cmd &` shell the PERSON started is deliberately not in either half.

// The explicit flag is the whole contract: read it wrong in the "on" direction and a plain
// interrupt silently becomes an `end`'s little brother. Everything that is not exactly this
// payload reads as no.
func TestStopBackgroundWorkIsReadOnlyFromItsExplicitFlag(t *testing.T) {
	for _, tc := range []struct {
		content string
		want    bool
	}{
		{`{"stopBackgroundWork":true}`, true},
		{`{"stopBackgroundWork":false}`, false},
		{`{"content":"stop that","attachmentIds":["a1"]}`, false}, // the follow-up payload, unchanged
		{`{"content":"x","attachmentIds":[],"stopBackgroundWork":true}`, true},
		{"", false},
		{"not json", false},
		{`{"stopBackgroundWork":"yes"}`, false},
	} {
		if got := stopBackgroundWorkRequested(tc.content); got != tc.want {
			t.Errorf("stopBackgroundWorkRequested(%q) = %v, want %v", tc.content, got, tc.want)
		}
	}
}

// One call, every kind. The runner-hosted jobs are the kill that is real; the engine's own
// shells, Monitors and Workflows end their standing in the session, and the hold that keeps the
// checkout fenced for a shell is released with it. The user's own `!cmd &` shell is asserted
// still running in the same fixture: the exclusion is a decision, not an oversight, and a test is
// where it is visible.
func TestStopBackgroundWorkEndsEveryKindExceptTheUsersOwnShell(t *testing.T) {
	h := newEvictionHarness(t, "stopbgwork", 1)
	h.startEngine()

	shellOutput := filepath.Join(h.dir, "bei9.output")
	h.bg.onToolResult("toolu_shell", "Command running in background with ID: bei9. Output is being"+
		" written to: "+shellOutput+". You will be notified when it completes.")
	h.bg.onToolResult("toolu_monitor", monitorTimeoutReceipt)
	if !h.holdsWorktree("bei9") {
		t.Fatalf("fixture: the engine's shell is not holding the checkout, so the release below proves nothing")
	}

	// A background Workflow, registered the way the agent's own receipt registers it.
	configDir := t.TempDir()
	const sessionUUID = "sess-workflow-stop"
	if err := os.MkdirAll(filepath.Join(configDir, "projects", "project", "sess-workflow-stop",
		"subagents", "workflows", "wf_test"), 0o755); err != nil {
		t.Fatal(err)
	}
	transcript := filepath.Join(configDir, "projects", "project", sessionUUID+".jsonl")
	if err := os.WriteFile(transcript, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	wfDir := filepath.Join(configDir, "projects", "project", sessionUUID, "subagents", "workflows", "wf_test")
	h.bg.mu.Lock()
	h.bg.claudeSessionUUID, h.bg.claudeConfigDir = sessionUUID, configDir
	h.bg.mu.Unlock()
	h.bg.onToolResult("toolu_wf", "Workflow launched in background. Task ID: w1\nTranscript dir: "+wfDir)
	wf := h.bg.workflowTranscript("toolu_wf")
	wf.mu.Lock()
	if a := wf.agent("a1", "reader", "Understand"); a == nil {
		wf.mu.Unlock()
		t.Fatal("fixture: the workflow agent was not registered")
	}
	wf.mu.Unlock()

	job := h.startJob("exec sleep 300", bgKindJob)
	devServer := h.startJob("exec sleep 300", bgKindService)

	// The person's own `!cmd &`, which Stop deliberately does not end.
	userShell := filepath.Join(h.dir, "user.out")
	if err := h.bg.startUserShell(h.dir, "exec sleep 300", "toolu_user", "user1", userShell, nil); err != nil {
		t.Fatalf("starting the user shell failed: %v", err)
	}

	h.bg.stopBackgroundWork()

	// The runner-hosted jobs: killed for real, each reported by its own waiter with the reason.
	for _, j := range []bgJobStatus{job, devServer} {
		report := h.events.awaitTerminal(t, j.JobID, 15*time.Second)
		if got := asString(report["status"]); got != bgStatusKilled {
			t.Errorf("%s %s was reported %q, want %q", j.Kind, j.JobID, got, bgStatusKilled)
		}
		if got := asString(report["reason"]); got != bgStopReason {
			t.Errorf("%s %s was reported with reason %q, want %q", j.Kind, j.JobID, got, bgStopReason)
		}
		if processAlive(j.PID) {
			t.Errorf("%s %s (pid %d) is still alive after Stop", j.Kind, j.JobID, j.PID)
		}
		if h.holdsWorktree(j.JobID) {
			t.Errorf("%s %s still holds the checkout after Stop", j.Kind, j.JobID)
		}
	}

	// The engine's own shell: reported killed, and no longer fencing the checkout.
	shell := h.events.terminalsFor("toolu_shell")
	if len(shell) != 1 || asString(shell[0]["status"]) != "killed" ||
		asString(shell[0]["shellId"]) != "bei9" {
		t.Errorf("the engine's shell was not reported killed by Stop: %v", shell)
	}
	if h.holdsWorktree("bei9") {
		t.Errorf("the engine's shell still holds the checkout after Stop")
	}

	// The Monitor: reported the way the tray tells it from a shell.
	monitor := h.events.terminalsFor("toolu_monitor")
	if len(monitor) != 1 || asString(monitor[0]["status"]) != "killed" ||
		asString(monitor[0]["tool"]) != "Monitor" || asString(monitor[0]["shellId"]) != "b97q4j1iy" {
		t.Errorf("the Monitor was not reported killed by Stop: %v", monitor)
	}
	if h.bg.hasLiveMonitors() {
		t.Errorf("a Monitor is still counted live after Stop")
	}

	// The Workflow: finished, with its un-ended agent marked failed rather than left running.
	wf.mu.Lock()
	finished, agentEnded, agentFailed := wf.finished, wf.agents["a1"].ended, wf.agents["a1"].failed
	wf.mu.Unlock()
	if !finished || !agentEnded || !agentFailed {
		t.Errorf("the workflow's agent was left running: finished=%v ended=%v failed=%v",
			finished, agentEnded, agentFailed)
	}

	// The person's own `!cmd &` shell: untouched, and still running — and the tray keeps saying so.
	if reports := h.events.forJob("toolu_user"); len(reports) != 0 {
		t.Errorf("the user's own shell was reported terminal by Stop: %v", reports)
	}
	h.bg.mu.Lock()
	_, live := h.bg.live["toolu_user"]
	h.bg.mu.Unlock()
	if !live {
		t.Errorf("the user's own shell stopped being tracked, so nothing can ever report its real exit")
	}

	// The session is not ended, and its tailer is still serving: work can still start.
	h.startJob("exec sleep 1", bgKindJob)
	if h.bg.ctx.Err() != nil {
		t.Errorf("Stop ended the session's background tailer: %v", h.bg.ctx.Err())
	}
}

// The negative control, with its positive in the same fixture. A plain interrupt — no flag — reaches
// the engine and emits the transcript marker exactly as it always has, and the jobs neither die nor
// get a terminal report: that is the difference between `interrupt` and `end`, and the thing the
// flag must not erode. The flagged interrupt that follows in the same session does kill them, which
// is also what proves the negative half was not passing for want of the machinery.
func TestAPlainInterruptLeavesBackgroundWorkRunning(t *testing.T) {
	fake := newFakeClaude(t,
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Await: "control_request", Subtype: ctrlInterrupt},
		fakeStep{Emit: "control_response"},
		fakeStep{Emit: "result", Subtype: "error_during_execution", Text: "interrupted"},
		fakeStep{Await: "control_request", Subtype: ctrlInterrupt},
		fakeStep{Emit: "control_response"},
		fakeStep{Emit: "result", Subtype: "error_during_execution", Text: "interrupted"},
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "result", Subtype: "success", Text: "still here"},
	)
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	job := runnerStopJob(t, "sess-stop-negative")
	api := newRunnerStopControlPlane()
	sup := superviseUntilRunnerStop(t, job, true, api)

	api.queue(RunInboxResponse{TurnID: "turn-1", Kind: "message", Content: "start something long"})
	awaitCondition(t, 30*time.Second, "the CLI never read the opening message", func() bool {
		return fake.userFrames() >= 1
	})
	build := sup.mustRun(t, "exec sleep 300", bgKindJob)
	awaitCondition(t, 15*time.Second, "the job's launch was never delivered", func() bool {
		return api.delivered(isJobLaunch(build.JobID))
	})

	// The plain interrupt: the engine is asked, it answers, the marker lands — and the job is
	// still running, with nothing said about it.
	api.queue(RunInboxResponse{TurnID: "int-1", Kind: "interrupt"})
	awaitCondition(t, 30*time.Second, "the plain interrupt never reached the transcript", func() bool {
		return api.delivered(isInterruptMarker)
	})
	if reports := api.terminalReports(build.JobID); len(reports) != 0 {
		t.Fatalf("a plain interrupt reported the job terminal: %v", reports)
	}
	if !processAlive(build.PID) {
		t.Fatalf("a plain interrupt killed the job (pid %d) — Stop and interrupt are no longer different", build.PID)
	}

	// The same session, the same job, the flagged interrupt: now it ends.
	api.queue(RunInboxResponse{TurnID: "int-2", Kind: "interrupt", Content: `{"stopBackgroundWork":true}`})
	awaitCondition(t, 30*time.Second, "the job was never killed by the flagged interrupt", func() bool {
		return len(api.terminalReports(build.JobID)) > 0
	})
	terminal := api.terminalReports(build.JobID)
	if len(terminal) != 1 || asString(terminal[0]["status"]) != bgStatusKilled ||
		asString(terminal[0]["reason"]) != bgStopReason {
		t.Fatalf("the job's terminal report = %v, want one %s/%s", terminal, bgStatusKilled, bgStopReason)
	}
	if processAlive(build.PID) {
		t.Fatalf("the job (pid %d) survived the flagged interrupt", build.PID)
	}
	// The session is not ended by any of it: it is still attached, and still takes turns — which is
	// the invariant the whole feature is fenced by (Stop ≠ End). A turn settling hands the runner's
	// permit back (completeTurn → pool.park), and in production the next message's claim is what
	// re-opens the executable lane; this is that claim.
	if sup.returned() {
		t.Fatalf("the session ended when its background work was stopped")
	}
	if _, ok := sup.pool.activate(sup.job); !ok {
		t.Fatalf("the session could not be claimed again for a second turn")
	}
	api.queue(RunInboxResponse{TurnID: "turn-2", Kind: "message", Content: "are you still there?"})
	awaitCondition(t, 30*time.Second, "the session stopped taking turns after Stop", func() bool {
		return fake.userFrames() >= 2
	})
}

// isInterruptMarker is the transcript's interrupted marker, which only an engine answer produces.
func isInterruptMarker(e RunEvent) bool { return e.Type == evInterrupt }

// userFrames counts the user turns the fake CLI actually read off stdin — the session's own proof
// that it is still taking turns.
func (f *fakeClaude) userFrames() int {
	n := 0
	for _, frame := range f.Stdin() {
		if frame["type"] == frameUser {
			n++
		}
	}
	return n
}
