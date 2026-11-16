//go:build linux || darwin

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A runner-owned job can finish when there is no engine at all. Its end is told by the durable
// background_task event (with the exit code the runner's own Wait returned), and, when it asked
// to, by waking its session. It never pushes a raw "Background job … ended" line to the owner's
// phone: that was agent plumbing on a lock screen, so the notifier that sent it is gone.

// gatedJob is a job that runs until the test lets it exit, so "it finished while the
// session was cold" is a fact this test establishes rather than a race it hopes to win.
func gatedJob(dir string, exitCode int) (command string, release func()) {
	marker := filepath.Join(dir, "release")
	return fmt.Sprintf("while [ ! -f %q ]; do sleep 0.02; done; exit %d", marker, exitCode),
		func() { os.WriteFile(marker, []byte("go"), 0o644) }
}

// runningEventFor returns the durable launch event — the one the apiserver folds with
// the terminal one to tell a replacement engine where to find the output.
func runningEventFor(events *bgJobEvents, jobID string) map[string]interface{} {
	for _, p := range events.forJob(jobID) {
		if asString(p["status"]) == bgStatusRunning {
			return p
		}
	}
	return nil
}

func TestRunnerOwnedJobFinishingColdRecordsItsExitCode(t *testing.T) {
	h := newEvictionHarness(t, "coldnotify", 1)
	h.startEngine()

	command, release := gatedJob(h.dir, 7)
	job := h.startJob(command, bgKindJob)

	// The launch is durable in its own right: the command and the output file are the
	// two things a replacement engine cannot reconstruct from a transcript that stops
	// before the job ended.
	launch := runningEventFor(h.events, job.JobID)
	if launch == nil {
		t.Fatalf("no durable running background_task for %s: %v", job.JobID, h.events.forJob(job.JobID))
	}
	if got := asString(launch["outputPath"]); got != job.OutputPath {
		t.Fatalf("launch outputPath = %q, want %q", got, job.OutputPath)
	}
	if got := asString(launch["command"]); got != command {
		t.Fatalf("launch command = %q, want the command that was run", got)
	}
	if got := asString(launch["kind"]); got != bgKindJob {
		t.Fatalf("launch kind = %q, want %q", got, bgKindJob)
	}

	// Go cold the way a real session does: park, let the warm TTL expire, and let the
	// engine's own Wait return. Nothing is left that could read this job's outcome.
	h.park()
	h.clock.Advance(warmEngineTTL + time.Second)
	h.afterEngineStopped()
	if h.pool.engineResident(h.live) {
		t.Fatal("the engine is still resident — this run does not exercise the cold path at all")
	}
	if !processAlive(job.PID) {
		t.Fatalf("job %s (pid %d) did not survive to finish cold", job.JobID, job.PID)
	}

	release()

	event := h.events.awaitTerminal(t, job.JobID, 15*time.Second)
	if got := asString(event["status"]); got != bgStatusFailed {
		t.Fatalf("status = %q, want %q for a non-zero exit", got, bgStatusFailed)
	}
	exit, ok := event["exitCode"].(int)
	if !ok || exit != 7 {
		t.Fatalf("exitCode = %#v, want the 7 the runner's own Wait returned", event["exitCode"])
	}
	if got := asString(event["outputPath"]); got != job.OutputPath {
		t.Fatalf("terminal outputPath = %q, want %q", got, job.OutputPath)
	}
}
