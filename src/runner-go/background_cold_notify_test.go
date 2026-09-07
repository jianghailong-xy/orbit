//go:build linux || darwin

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Stage 2b, the runner half. Stage 2 made a job survive its engine; the consequence
// is that a job can now finish when there is no engine at all — and a completion
// nobody is told about is the "come back and find out" this project exists to remove.
//
// Two things are asserted together, because either alone is a lie: the durable
// background_task event carries the exit code the runner's own Wait returned, AND the
// account's existing push channel was actually reached. An event nobody reads and an
// alert with no record behind it are the two ways this can be wrong.

// notifyRecorder stands in for `orbit notify` — the same call the agent's notify tool
// and `orbit notify --message` make. It records rather than sends, and it is the only
// thing in this test that could tell a human anything.
type notifyRecorder struct {
	mu   sync.Mutex
	sent []string
	err  error
}

func (n *notifyRecorder) notify(message string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.sent = append(n.sent, message)
	return n.err
}

func (n *notifyRecorder) messages() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]string(nil), n.sent...)
}

// wireColdAlerts gives the harness's tailer exactly what session.go gives the real
// one: the pool's own answer to "is an engine resident", and the push channel.
func (h *evictionHarness) wireColdAlerts() *notifyRecorder {
	rec := &notifyRecorder{}
	h.bg.notifyWhenCold(func() bool { return h.pool.engineResident(h.live) }, rec.notify)
	return rec
}

// gatedJob is a job that runs until the test lets it exit, so "it finished while the
// session was cold" is a fact this test establishes rather than a race it hopes to win.
func gatedJob(dir string, exitCode int) (command string, release func()) {
	marker := filepath.Join(dir, "release")
	return fmt.Sprintf("while [ ! -f %q ]; do sleep 0.02; done; exit %d", marker, exitCode),
		func() { os.WriteFile(marker, []byte("go"), 0o644) }
}

func awaitNotification(t *testing.T, rec *notifyRecorder, timeout time.Duration) []string {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if sent := rec.messages(); len(sent) > 0 {
			return sent
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("nothing was pushed to the owner within %s", timeout)
	return nil
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

func TestRunnerOwnedJobFinishingColdAlertsTheOwnerWithItsExitCode(t *testing.T) {
	h := newEvictionHarness(t, "coldnotify", 1)
	rec := h.wireColdAlerts()
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

	sent := awaitNotification(t, rec, 15*time.Second)
	if len(sent) != 1 {
		t.Fatalf("pushed %d alerts, want exactly one: %v", len(sent), sent)
	}
	// The alert has to name the job and how it ended, because it is read on a lock
	// screen and the whole decision it supports is "do I need to go look".
	if !strings.Contains(sent[0], job.JobID) {
		t.Fatalf("the alert does not name the job: %q", sent[0])
	}
	if !strings.Contains(sent[0], "7") {
		t.Fatalf("the alert does not carry the exit code: %q", sent[0])
	}
}

// The paired positive: the same fixture, same job, same completion — with an engine
// resident. The terminal event must still be there (so this is not a run in which
// nothing happened), and the alert must not be, because the engine is about to be
// handed this event on its next turn and a channel that fires for things already on
// screen is a channel people turn off.
func TestRunnerOwnedJobFinishingWarmReportsWithoutAlerting(t *testing.T) {
	h := newEvictionHarness(t, "warmnotify", 1)
	rec := h.wireColdAlerts()
	h.startEngine()

	command, release := gatedJob(h.dir, 7)
	job := h.startJob(command, bgKindJob)
	if !h.pool.engineResident(h.live) {
		t.Fatal("the engine is not resident — this is the cold case, not the control")
	}

	release()
	event := h.events.awaitTerminal(t, job.JobID, 15*time.Second)
	exit, ok := event["exitCode"].(int)
	if !ok || exit != 7 {
		t.Fatalf("exitCode = %#v, want 7 — the reporting path did not run at all", event["exitCode"])
	}

	// The terminal event above is the synchronisation point: alertIfNobodyIsWatching
	// runs on the same goroutine, immediately after the emit that produced it.
	if sent := rec.messages(); len(sent) != 0 {
		t.Fatalf("alerted the owner about a job their own engine is here to read: %v", sent)
	}
}

// A kill is not news. Whoever asked for it is holding the answer, and a drain kill
// happens while the session is being torn down around it — so neither may spend the
// one alert a minute this account gets.
func TestKilledJobDoesNotAlertEvenWhenCold(t *testing.T) {
	h := newEvictionHarness(t, "killnotify", 1)
	rec := h.wireColdAlerts()
	h.startEngine()
	job := h.startJob("sleep 30", bgKindJob)

	h.park()
	h.clock.Advance(warmEngineTTL + time.Second)
	h.afterEngineStopped()
	if h.pool.engineResident(h.live) {
		t.Fatal("the engine is still resident — this run does not exercise the cold path at all")
	}

	if _, err := h.bg.killJob(job.JobID, bgKillTeardownGrace); err != nil {
		t.Fatalf("killing %s failed: %v", job.JobID, err)
	}
	event := h.events.awaitTerminal(t, job.JobID, 15*time.Second)
	if got := asString(event["status"]); got != bgStatusKilled {
		t.Fatalf("status = %q, want %q", got, bgStatusKilled)
	}
	if sent := rec.messages(); len(sent) != 0 {
		t.Fatalf("alerted the owner about a kill they asked for: %v", sent)
	}
}
