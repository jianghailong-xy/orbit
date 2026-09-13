//go:build linux || darwin

package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The session's own end is one of the three things allowed to end a runner-hosted job, beside its
// own exit and an explicit kill, and it has to reach the control plane the way those do: as the
// job's one terminal background_task. Where it did not, the job's last delivered event stayed
// `running` for a process that was gone. A runner stop says so now (background_runner_stop_test.go);
// these are the three ways the end of a session still killed a job and said nothing:
//
//   - A failed turn seals event admission on the provider's way out, and the drain that ends the
//     session's jobs runs after that, in the supervisor — so what the drain ended was dropped at
//     the seal.
//   - A cancelled session, or a supervisor that lost its session, kills the jobs through the
//     context they run under. No kill of the runner's own named that end, and finishJob reported a
//     job that ended under a cancelled context only when one had.
//   - A job started while the session's drain was waiting is in no snapshot of it, and was killed
//     only when stopAll cancelled that same context: the second case's silence again.
//
// All three drive the real supervisor with the runner stop cases' fixture. Jobs go in through the
// session's own socket, and the verdict is read off what the stub control plane accepted — which,
// like the real one, is nothing once the session is closed.

// assertOneTerminalReport is the verdict the three share: exactly one terminal report accepted for
// the job, with the status and reason given, and a process that is gone. It runs once the supervisor
// has returned, and the supervisor joins every job's waiter — the runner's own Wait on the process —
// before it does, so the process has been reaped and no zombie can answer signal 0.
func assertOneTerminalReport(t *testing.T, api *runnerStopControlPlane, job bgJobStatus, status, reason string) {
	t.Helper()
	terminal := api.terminalReports(job.JobID)
	if len(terminal) != 1 {
		t.Errorf("%s %s: terminal reports the control plane accepted = %v, want exactly one (sent after it had closed the session: %v)",
			job.Kind, job.JobID, terminal, api.lateTerminalReports(job.JobID))
	} else {
		if got := asString(terminal[0]["status"]); got != status {
			t.Errorf("%s %s was reported %q, want %q", job.Kind, job.JobID, got, status)
		}
		if got := asString(terminal[0]["reason"]); got != reason {
			t.Errorf("%s %s was reported with reason %q, want %q", job.Kind, job.JobID, got, reason)
		}
	}
	if processAlive(job.PID) {
		t.Errorf("%s %s (pid %d) is still alive after its session ended", job.Kind, job.JobID, job.PID)
	}
}

// A failed turn — production session 01a066d7, 2026-09-12. Its failure was handed to the supervisor
// at 02:07:21 and settled at 02:07:52, bgDrainWaitCap apart, and bgj_a9523657661a, which the drain in
// between waited out and killed, had nothing but `running` on the control plane.
//
// The CLI reads the message and never echoes it back, so once the session is ended the message's
// delivery is unconfirmed and its turn is settled as failed (settleUndeliveredMessages). That is the
// provider path that seals event admission and hands the acknowledgement to the supervisor, which
// drains the jobs and then acknowledges. The kills have to be accepted before that acknowledgement
// closes the session.
func TestFailedTurnDeliversTheKillsOfItsDrainBeforeTheAcknowledgement(t *testing.T) {
	fake := newFakeClaude(t, fakeStep{Await: "user"})
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	job := runnerStopJob(t, "sess-failed-turn-drain")
	api := newRunnerStopControlPlane()
	api.queue(RunInboxResponse{TurnID: "turn-1", Kind: "message", Content: "run the full suite"})
	sup := superviseUntilRunnerStop(t, job, true, api)
	awaitCondition(t, 30*time.Second, "the CLI never read the message", func() bool {
		for _, frame := range fake.Stdin() {
			if frame["type"] == frameUser {
				return true
			}
		}
		return false
	})

	suite := sup.mustRun(t, "exec sleep 300", bgKindJob)
	devServer := sup.mustRun(t, "exec sleep 300", bgKindService)
	awaitCondition(t, 15*time.Second, "the launches were never delivered", func() bool {
		return api.delivered(isJobLaunch(suite.JobID)) && api.delivered(isJobLaunch(devServer.JobID))
	})

	api.queue(RunInboxResponse{TurnID: "end-1", Kind: "end"})
	// The drain gives the job bgDrainWaitCap before it kills it.
	sup.awaitReturn(t, 2*time.Minute)

	failed := false
	for _, completion := range api.turnCompletions() {
		failed = failed || (completion.TurnID == "turn-1" && completion.Status == stFailed)
	}
	if !failed {
		t.Fatalf("turn-1 was never settled as failed, so the session did not end the way this case is about: %+v",
			api.turnCompletions())
	}
	assertOneTerminalReport(t, api, suite, bgStatusKilled, bgDrainCapReason)
	assertOneTerminalReport(t, api, devServer, bgStatusKilled, "drain")
	// What the seal guarantees: nothing lands behind the acknowledgement. Admitting the drain's kills
	// must not have let anything through after it.
	if late := api.lateEvents(); len(late) != 0 {
		t.Errorf("events reached the control plane after the failed turn closed the session: %v", late)
	}
}

// A cancelled session. The cancel ends the jobs at once — they run under the session's context — and
// is filed as the cancel it is: neither the session's drain, which it never ran, nor a runner stop.
// Losing the session to a newer owner cancels the same context; what differs there is that this
// runner can no longer deliver anything at all.
func TestSessionCancelReportsTheJobsItKills(t *testing.T) {
	job := runnerStopJob(t, "sess-cancelled")
	api := newRunnerStopControlPlane()
	sup := superviseUntilRunnerStop(t, job, false, api)

	build := sup.mustRun(t, "exec sleep 300", bgKindJob)
	devServer := sup.mustRun(t, "exec sleep 300", bgKindService)
	awaitCondition(t, 15*time.Second, "the launches were never delivered", func() bool {
		return api.delivered(isJobLaunch(build.JobID)) && api.delivered(isJobLaunch(devServer.JobID))
	})

	sup.end()
	sup.awaitReturn(t, time.Minute)

	if got := api.finalizeStatuses(); len(got) != 1 || got[0] != stCancelled {
		t.Fatalf("the session was finalized as %v, want once as %s: this case is about a cancelled session", got, stCancelled)
	}
	assertOneTerminalReport(t, api, build, bgStatusKilled, "session_cancelled")
	assertOneTerminalReport(t, api, devServer, bgStatusKilled, "session_cancelled")
}

// A job started during the session's drain. The drain waits bgDrainWaitCap for the jobs running when
// it began, and the session's socket is served until the supervisor returns, so a job can be started
// in between: one that is in no snapshot of the drain.
//
// The session ends by its own `end` — no failed turn, no cancel — so the drain is all this case is
// about. A job that finishes when the test says so holds the drain open, and a service says when the
// drain took its snapshot: a drain kills services at once, marked in the same critical section.
func TestJobStartedDuringTheSessionDrainIsReportedWhenTheSessionEndsIt(t *testing.T) {
	fake := newFakeClaude(t, fakeStep{Emit: "system_init"})
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	job := runnerStopJob(t, "sess-drain-late-job")
	api := newRunnerStopControlPlane()
	sup := superviseUntilRunnerStop(t, job, true, api)

	release := filepath.Join(t.TempDir(), "release")
	holding := sup.mustRun(t, "while [ ! -e '"+release+"' ]; do sleep 0.05; done", bgKindJob)
	devServer := sup.mustRun(t, "exec sleep 300", bgKindService)
	awaitCondition(t, 15*time.Second, "the launches were never delivered", func() bool {
		return api.delivered(isJobLaunch(holding.JobID)) && api.delivered(isJobLaunch(devServer.JobID))
	})

	api.queue(RunInboxResponse{TurnID: "end-1", Kind: "end"})
	awaitCondition(t, 30*time.Second, "the session's drain never killed its service", func() bool {
		return len(api.terminalReports(devServer.JobID)) > 0
	})
	late := sup.mustRun(t, "exec sleep 300", bgKindJob)
	awaitCondition(t, 15*time.Second, "the late job's launch was never delivered", func() bool {
		return api.delivered(isJobLaunch(late.JobID))
	})
	if err := os.WriteFile(release, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	sup.awaitReturn(t, time.Minute)

	if got := api.finalizeStatuses(); len(got) != 1 || got[0] != stSucceeded {
		t.Fatalf("the session was finalized as %v, want once as %s: this case is about a session's own end", got, stSucceeded)
	}
	// The drain was still waiting when the late job started: it waited this one out.
	assertOneTerminalReport(t, api, holding, bgStatusCompleted, "")
	assertOneTerminalReport(t, api, late, bgStatusKilled, bgDrainCapReason)
}
