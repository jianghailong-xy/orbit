//go:build linux

package main

import (
	"errors"
	"testing"
	"time"
)

// A self-update that cannot re-execute leaves the jobs its sessions handed on with no image to adopt
// them, and a process about to exit under them. They are ended as any other runner stop ends the jobs
// it hosts: killed, and reported once as the runner's stop — through the event stream of a session
// whose supervisor has already returned.
func TestASelfUpdateThatCannotReexecEndsTheJobsItHandedOn(t *testing.T) {
	job := runnerStopJob(t, "sess-reexec-fails")
	api := newRunnerStopControlPlane()
	pool := newSessionPool(4)
	sup := superviseImage(t, job, pool, api, errRunnerSelfUpdate)
	build := sup.mustRun(t, "exec sleep 300", bgKindJob)
	awaitCondition(t, 15*time.Second, "the launch was never delivered", func() bool {
		return api.delivered(isJobLaunch(build.JobID))
	})

	superviseSelfUpdates("https://control.example",
		func(string) {},
		func() (bool, func()) {
			sup.stop()
			sup.awaitReturn(t, 2*time.Minute)
			// Handed on: still running and unreported when the re-exec is tried.
			requireRunning(t, build.PID, "the job handed on for the re-exec")
			if got := api.terminalReports(build.JobID); len(got) != 0 {
				t.Fatalf("the job was reported ended before the re-exec was tried: %v", got)
			}
			return true, func() { pool.endHostlessJobs(bgRunnerShutdownReason) }
		},
		func() error { return errors.New("exec: exec format error") })

	assertEndedByRunnerStop(t, api, build)
	requireNoRecord(t, job.SessionID, build.JobID, "the job was ended")
}
