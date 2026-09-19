//go:build linux || darwin

package main

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// A runner-hosted job that is up and no longer producing anything is a hang — a deadlock, a wait on
// a lock or a socket that will never answer — and it looks exactly like a working job from
// everywhere the control plane can see: same process, same `running` report, same absence of any
// end. What separates them is whether its output is still moving, which is the one thing this
// runner knows and nobody else does (it tails each job's .output file).
//
// So every `running` report states it, as `idleMs`: how long the job has produced NOTHING, on this
// runner's clock. The control plane restates that in its own timebase and drops a job that has been
// silent past its threshold out of the clients' in-flight marker while leaving it in
// `runningBgShells` — the process is real, it just is not work in progress.
//
// The clock here is a parameter, never a wait: both sides of the threshold have to be asserted in
// one run, and the far side is ten minutes away. `runningPayload(at)` and `idleMillis(at)` take the
// instant they are asked about; the threshold itself is the control plane's
// (BG_JOB_ACTIVITY_STALE_AFTER_MS, src/apiserver/src/sessions/background-job-activity.ts), named
// below only to say which side of it each case is on.

// staleAfter mirrors the control plane's threshold. This runner does not apply it and has no copy of
// it — it reports the duration, and the control plane decides — so this is a test saying "past
// here" rather than a second definition. Moving that constant does not invalidate these assertions,
// which are about the field.
const staleAfter = 10 * time.Minute

func TestARunningJobReportsHowLongItHasBeenSilent(t *testing.T) {
	launched := time.Date(2026, 9, 19, 3, 0, 0, 0, time.UTC)
	job := &bgJob{
		id:           "bgj_activity",
		kind:         bgKindJob,
		command:      "npm run build",
		status:       bgStatusRunning,
		startedAt:    launched,
		lastOutputAt: launched,
	}

	// At the launch, and on every heartbeat until it writes something, a job that has produced
	// nothing reports its age. That is what makes a job that hangs immediately go quiet on the
	// clients' marker rather than breathing until somebody kills it.
	for _, silentFor := range []time.Duration{0, time.Second, staleAfter + time.Minute, 6 * time.Hour} {
		at := launched.Add(silentFor)
		if got, want := job.idleMillis(at), silentFor.Milliseconds(); got != want {
			t.Errorf("a job silent for %s reported %dms of silence, want %dms", silentFor, got, want)
		}
		payload := job.runningPayload(at)
		if got := payload["idleMs"]; got != silentFor.Milliseconds() {
			t.Errorf("the running report of a job silent for %s carried idleMs=%v, want %dms",
				silentFor, got, silentFor.Milliseconds())
		}
		// The rest of the report is the job's identity: the control plane reads the job off these
		// fields (runner-api.controller bgRunning), and a report it cannot read is a job it drops.
		if payload["kind"] != bgKindJob || payload["toolUseId"] != job.id ||
			payload["status"] != bgStatusRunning || payload["outputPath"] != job.outputPath {
			t.Errorf("the running report lost the job's identity: %v", payload)
		}
	}

	// And a job that has just written reports that instead: the same job, one output away from
	// being counted as work in flight again.
	writtenAt := launched.Add(20 * time.Minute)
	job.lastOutputAt = writtenAt
	if got := job.idleMillis(writtenAt.Add(3 * time.Second)); got != 3000 {
		t.Errorf("a job that wrote 3s ago reported %dms of silence, want 3000ms", got)
	}
	if got := job.idleMillis(writtenAt); got != 0 {
		t.Errorf("a job reported %dms of silence at the instant it wrote, want 0ms", got)
	}
	// Both sides of the threshold, on one job: silent long enough to be dropped, then writing.
	if idle := job.idleMillis(writtenAt.Add(staleAfter + time.Second)); idle <= staleAfter.Milliseconds() {
		t.Errorf("a job silent for %s reported %dms, which is not past the %s it has to be past",
			staleAfter+time.Second, idle, staleAfter)
	}

	// A clock that stepped backwards while a job was writing must not report output the job has not
	// written yet — the control plane clamps the same way, and the wire should not need it to.
	if got := job.idleMillis(writtenAt.Add(-time.Minute)); got != 0 {
		t.Errorf("a clock that stepped back an hour made the job report %dms of silence, want 0ms", got)
	}
}

// The other half, and the one no clock can be injected into: the runner has to NOTICE that a job
// wrote something. Driven through the real output tail over a real file, because "the tail saw it
// change" is the whole claim — a job that writes to a file nobody tails would report its age
// forever, and one that writes nothing is exactly the job the marker is supposed to drop.
func TestAWriteToTheOutputFileEndsTheSilenceTheJobReports(t *testing.T) {
	outputPath := filepath.Join(t.TempDir(), "bgj_live.output")
	// Empty at the start. A read of a file nothing has written to stamps nothing, so the write below
	// is what moves the job out of its silence — through the one branch of the tail that stamping
	// lives on, whether the tail's first read catches the write or a later tick does.
	if err := os.WriteFile(outputPath, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	// One collector for both kinds of event, under its own lock: the tail emits from its own
	// goroutine for as long as the test runs, and swapping the tailer's emit mid-test to change what
	// is captured would be a race with it.
	var collectedMu sync.Mutex
	var outputIDs []string
	var running []map[string]interface{}
	emit := func(eventType string, payload map[string]interface{}) {
		collectedMu.Lock()
		defer collectedMu.Unlock()
		switch eventType {
		case evBackgroundOutput:
			outputIDs = append(outputIDs, asString(payload["toolUseId"]))
		case evBackgroundTask:
			running = append(running, payload)
		}
	}
	bg := newBgTailer(context.Background(), emit, nil)
	// Cancels this tailer's context: the tail and the heartbeat stop with it. Not stopAll, which is
	// for a session ending and would drain the two jobs here — they are records of a job, not
	// processes, and there is nothing to drain.
	defer bg.cancel()

	stale := time.Now().Add(-time.Hour)
	live := &bgJob{
		id: "bgj_live", kind: bgKindJob, command: "npm run build",
		outputPath: outputPath, status: bgStatusRunning,
		startedAt: stale, lastOutputAt: stale,
	}
	// A second job that never writes a word, so the same pass of reports carries both sides of the
	// threshold and the comparison is not across two moments.
	quiet := &bgJob{
		id: "bgj_quiet", kind: bgKindJob, command: "sleep 3600",
		status: bgStatusRunning, startedAt: stale, lastOutputAt: stale,
	}
	bg.mu.Lock()
	bg.jobs[live.id] = live
	bg.jobs[quiet.id] = quiet
	bg.mu.Unlock()
	// Read under the lock: the tail writes these stamps from its own goroutine.
	idleNow := func(job *bgJob) int64 {
		bg.mu.Lock()
		defer bg.mu.Unlock()
		return job.idleMillis(time.Now())
	}

	if idle := idleNow(live); idle <= staleAfter.Milliseconds() {
		t.Fatalf("the fixture: a job that has not written for an hour reported %dms, which is not past the threshold", idle)
	}

	bg.startTail(live.id, live.id, outputPath, false)
	if err := os.WriteFile(outputPath, []byte("linking...\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	awaitCondition(t, 15*time.Second, "the tail never reported the job's output, so nothing was stamped", func() bool {
		collectedMu.Lock()
		defer collectedMu.Unlock()
		for _, id := range outputIDs {
			if id == live.id {
				return true
			}
		}
		return false
	})
	if idle := idleNow(live); idle > staleAfter.Milliseconds() {
		t.Errorf("the job wrote and the tail saw it, and it still reports %dms of silence", idle)
	}

	// And that is what the reports the control plane receives say: the job that wrote is inside the
	// threshold, the one that never has is past it, on the same pass. This is the heartbeat's whole
	// job (heartbeatJobs) — a job that is producing has to keep saying so, or its last report ages
	// into a stall while it is still working.
	bg.announceRunningJobs()
	collectedMu.Lock()
	announced := append([]map[string]interface{}(nil), running...)
	collectedMu.Unlock()
	byJob := map[string]int64{}
	for _, report := range announced {
		id := asString(report["toolUseId"])
		idle, ok := report["idleMs"].(int64)
		if !ok {
			t.Fatalf("the report for %s carried no idle duration: %v", id, report)
		}
		byJob[id] = idle
	}
	if len(byJob) != 2 {
		t.Fatalf("announced %d jobs, want the two that are running: %v", len(byJob), announced)
	}
	if idle := byJob[live.id]; idle > staleAfter.Milliseconds() {
		t.Errorf("the job that wrote was announced as silent for %dms", idle)
	}
	if idle := byJob[quiet.id]; idle <= staleAfter.Milliseconds() {
		t.Errorf("the job that never wrote was announced as silent for %dms, which is not past the threshold", idle)
	}
}
