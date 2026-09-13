//go:build linux || darwin

package main

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

// adoptRecordedJobs rebuilds the jobs an earlier image of this runner handed on when it re-executed
// into a self-update (handOffJobs). It runs before the reclaim and before any worktree sweep: until
// the pool holds a job again, the sweep takes its checkout for one nobody is using.
//
// Every record is held against the one fact that cannot be made up: whether its pid is this
// process's child. A self-update keeps the pid, so a job the old image never reaped still is. One
// that is not was never handed on, or was reaped by whoever wrote the record, and anything this image
// said about how it ended would be a guess. Its record is discarded and nothing is reported: the
// control plane already reads a job last reported by a runner process that has gone as one with no
// end report (apiserver runner-api/background-jobs-context.ts), and an event from this process would
// make it read as a job the current runner still hosts.
func (p *sessionPool) adoptRecordedJobs() {
	for _, found := range readBgJobRecords() {
		rec := found.record
		if found.problem != "" {
			logln(fmt.Sprintf("background job record %s: %s — not adopted, no end report", found.path, found.problem))
			_ = os.Remove(found.path)
			continue
		}
		exited, exit, err := reapIfExited(rec.PID)
		if err != nil {
			logln(fmt.Sprintf("background %s %s of session %s: pid %d is not this runner's child (%v) — not adopted, no end report",
				rec.Kind, rec.JobID, rec.SessionID, rec.PID, err))
			_ = os.Remove(found.path)
			continue
		}
		job := adoptedJob(rec)
		if exited {
			// What it left running in its group goes with it, as when the runner reaps a job it hosts.
			_ = terminateProcessTree(rec.PID)
			job.adoptedExit = &exit
			logln(fmt.Sprintf("background %s %s of session %s exited (%d) while the runner re-executed; adopted to report its end",
				rec.Kind, rec.JobID, rec.SessionID, exit))
		} else {
			p.holdWorktreeWriter(rec.SessionID, rec.JobID, bgHold{name: rec.JobID, runnerHosted: true, watch: rec.Kind == bgKindWatch})
			logln(fmt.Sprintf("background %s %s of session %s (pid %d) adopted across the runner's re-exec",
				rec.Kind, rec.JobID, rec.SessionID, rec.PID))
		}
		p.keepHostlessJob(rec.SessionID, job)
	}
}

// adoptedJob is a job rebuilt from its record. It has no exec.Cmd — that stayed with the image that
// started it — so it is killed by its process group and reaped by its pid.
func adoptedJob(rec bgJobRecord) *bgJob {
	pid := rec.PID
	return &bgJob{
		id:           rec.JobID,
		kind:         rec.Kind,
		command:      rec.Command,
		description:  rec.Description,
		outputPath:   rec.OutputPath,
		pid:          pid,
		startedAt:    rec.StartedAt,
		done:         make(chan struct{}),
		wakeOnExit:   rec.WakeOnExit,
		wakeOnOutput: rec.WakeOnOutput,
		status:       bgStatusRunning,
		wokenThrough: rec.WokenThrough,
		outputWakes:  rec.OutputWakes,
		recorded:     true,
		kill:         func() { _ = terminateProcessTree(pid) },
		reap:         func() int { return reapChild(pid) },
	}
}

// reapIfExited reaps the child pid if it has exited, with its exit code. An error means pid is not
// this process's child.
func reapIfExited(pid int) (bool, int, error) {
	var status syscall.WaitStatus
	reaped, err := syscall.Wait4(pid, &status, syscall.WNOHANG, nil)
	for errors.Is(err, syscall.EINTR) {
		reaped, err = syscall.Wait4(pid, &status, syscall.WNOHANG, nil)
	}
	if err != nil || reaped == 0 {
		return false, 0, err
	}
	return true, waitStatusExitCode(status), nil
}

// reapChild waits for the child pid, reaps it, and ends what it left running in its group.
func reapChild(pid int) int {
	var status syscall.WaitStatus
	_, err := syscall.Wait4(pid, &status, 0, nil)
	for errors.Is(err, syscall.EINTR) {
		_, err = syscall.Wait4(pid, &status, 0, nil)
	}
	if err != nil {
		return -1
	}
	_ = terminateProcessTree(pid)
	return waitStatusExitCode(status)
}

// waitStatusExitCode reads a wait status as os.ProcessState.ExitCode does: the code the process exited
// with, or -1 for one a signal ended.
func waitStatusExitCode(status syscall.WaitStatus) int {
	if status.Exited() {
		return status.ExitStatus()
	}
	return -1
}
