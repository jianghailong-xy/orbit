//go:build linux || darwin

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A coordinator that hands over is ended by an `end` turn that says {"keepBackgroundWork":true}
// (session_keep_work.go). Its running SubAgents and bg_run jobs then run on to their own end, in the checkout
// they started in, and their end owes the wake the server forwards to the successor. Every other end stops them.
// Each case drives the real supervisor against the stub control plane of session_pool_self_driven_turn_test.go.

const keepWorkEnd = `{"keepBackgroundWork":true}`

// awaitSupervisorDone waits for the supervisor to have returned, so the next case of the same session id does not
// meet its socket's removal.
func awaitSupervisorDone(t *testing.T, s *supervisedSession) {
	t.Helper()
	select {
	case <-s.live.done:
	case <-time.After(30 * time.Second):
		t.Fatal("the supervisor never returned after the session ended")
	}
}

// heldFor reports whether the pool holds the session's checkout for the writer named jobID.
func heldFor(p *sessionPool, sessionID, jobID string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	_, held := p.bgJobs[sessionID][jobID]
	return held
}

// runJob starts a runner-hosted job on the session's socket, as bg_run does.
func (r *subagentRig) runJob(command, kind string) bgJobStatus {
	r.t.Helper()
	// A job starts without a card in Bypass, as in Auto.
	r.job.notePermissionMode("bypassPermissions")
	waitUntil(r.t, func() bool { _, err := os.Stat(bgTokenPath(r.job.SessionID)); return err == nil },
		"the session's job socket never came up")
	token, err := os.ReadFile(bgTokenPath(r.job.SessionID))
	if err != nil {
		r.t.Fatal(err)
	}
	raw, err := bgSocketCall(bgSocketPath(r.job.SessionID), string(token), "run", map[string]interface{}{
		"command": command, "kind": kind, "wakeOnExit": true, "description": kind + " left by the coordinator",
	})
	if err != nil {
		r.t.Fatalf("run: %v", err)
	}
	var status bgJobStatus
	if err := json.Unmarshal(raw, &status); err != nil || status.JobID == "" {
		r.t.Fatalf("run answered %s", raw)
	}
	return status
}

func TestSubagentLeftRunningWhenItsCoordinatorHandsOver(t *testing.T) {
	pool := newSessionPoolWithClock(1, newFakePoolClock())
	s := superviseClaudeSessionInWorktree(t, pool, oneTurn()...)
	s.awaitParked("turn-1")
	r := installSubagentChild(t, s)
	run := r.delegate(true)

	s.queue(RunInboxResponse{TurnID: "end-1", Kind: "end", Content: keepWorkEnd})
	waitUntil(t, func() bool { return r.pathIndex("/finalize") >= 0 }, "the session was never finalized")
	awaitSupervisorDone(t, s)
	// The session has ended; its SubAgent has not, and it still holds the checkout it writes.
	if !childAlive(t, r.marks) {
		t.Fatal("the SubAgent's child engine did not outlive its coordinator's handover")
	}
	if len(r.reports()) != 0 {
		t.Fatalf("the SubAgent was reported ended with its session: %v", r.reports())
	}
	if !heldFor(pool, s.job.SessionID, "subagent:"+run.RunID) {
		t.Fatal("the checkout is not held for the SubAgent left running")
	}

	r.finishChild()
	done := r.awaitReport(subagentStatusDone)
	if done["runId"] != run.RunID || done["wake"] != true || !strings.Contains(asString(done["resultSummary"]), "half.txt is written") {
		t.Fatalf("the end was reported as %v, want run %s DONE with its result and the wake owed", done, run.RunID)
	}
	waitUntil(t, func() bool { return !heldFor(pool, s.job.SessionID, "subagent:"+run.RunID) },
		"the SubAgent's hold on the checkout outlived it")
	if raw, err := os.ReadFile(filepath.Join(s.execDir, "half.txt")); err != nil || string(raw) != "first half second half\n" {
		t.Fatalf("half.txt = %q, %v: the SubAgent did not finish in the old checkout", raw, err)
	}
}

// The heartbeat may tell the runner first (keepWorkSessionIds, then cancelSessionIds): the mark it leaves and the
// cancel are the same end.
func TestSubagentKeptByAHeartbeatHandover(t *testing.T) {
	pool := newSessionPoolWithClock(1, newFakePoolClock())
	s := superviseClaudeSession(t, pool, oneTurn()...)
	s.awaitParked("turn-1")
	r := installSubagentChild(t, s)
	run := r.delegate(true)

	var beat HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"cancelSessionIds":["`+s.job.SessionID+`"],"keepWorkSessionIds":["`+
		s.job.SessionID+`"],"maxConcurrent":1}`), &beat); err != nil || len(beat.KeepWorkSessionIDs) != 1 {
		t.Fatalf("keepWorkSessionIds was read as %v (%v)", beat.KeepWorkSessionIDs, err)
	}
	markSessionKeepsWork(beat.KeepWorkSessionIDs[0])
	s.live.cancel()
	waitUntil(t, func() bool { return r.pathIndex("/finalize") >= 0 }, "the session was never finalized")
	awaitSupervisorDone(t, s)
	if !childAlive(t, r.marks) || len(r.reports()) != 0 {
		t.Fatalf("the SubAgent was stopped with its session (alive %v, reports %v)", childAlive(t, r.marks), r.reports())
	}
	r.finishChild()
	if done := r.awaitReport(subagentStatusDone); done["runId"] != run.RunID || done["wake"] != true {
		t.Fatalf("the end was reported as %v, want DONE with the wake owed", done)
	}
}

// An end that says nothing — a Complete, a stop — still stops the SubAgent, owing nobody a wake.
func TestSubagentStoppedByAnOrdinaryEndTurn(t *testing.T) {
	grace := subagentStopGrace
	subagentStopGrace = 300 * time.Millisecond
	t.Cleanup(func() { subagentStopGrace = grace })

	pool := newSessionPoolWithClock(1, newFakePoolClock())
	s := superviseClaudeSession(t, pool, oneTurn()...)
	s.awaitParked("turn-1")
	r := installSubagentChild(t, s)
	r.delegate(true)

	s.queue(RunInboxResponse{TurnID: "end-1", Kind: "end"})
	stopped := r.awaitReport(subagentStatusStopped)
	if stopped["wake"] == true || !strings.Contains(asString(stopped["resultSummary"]), "stopped because the session ended") {
		t.Fatalf("the ordinary end's stop was reported as %v, want STOPPED with no wake", stopped)
	}
	waitUntil(t, func() bool { return !childAlive(t, r.marks) }, "the SubAgent's child engine outlived an ordinary end")
	awaitSupervisorDone(t, s)
}

// A remote run is not asked to stop by a handover: it runs on to its end on the other workspace, whose runner
// reports it (an ordinary end asks the server to stop it: TestRemoteSubagentParentStopAsksTheServer).
func TestRemoteSubagentNotStoppedWhenItsCoordinatorHandsOver(t *testing.T) {
	pool := newSessionPoolWithClock(1, newFakePoolClock())
	s := superviseClaudeSession(t, pool, oneTurn()...)
	s.awaitParked("turn-1")
	r := installSubagentChild(t, s)
	s.mu.Lock()
	s.subagentRemote = "orbit-macos"
	s.mu.Unlock()
	r.call("subagent_start", map[string]interface{}{
		"toolUseId": "toolu_delegate", "description": "build", "prompt": "build", "background": true,
	})

	s.queue(RunInboxResponse{TurnID: "end-1", Kind: "end", Content: keepWorkEnd})
	waitUntil(t, func() bool { return r.pathIndex("/finalize") >= 0 }, "the session was never finalized")
	awaitSupervisorDone(t, s)
	time.Sleep(300 * time.Millisecond)
	s.mu.Lock()
	stops := s.remoteStops
	s.remoteStatus, s.remoteResult = subagentStatusDone, "built"
	s.mu.Unlock()
	if stops != 0 {
		t.Fatalf("a handover asked the server to stop the remote SubAgent %d time(s)", stops)
	}
	if len(r.reports()) != 0 {
		t.Fatalf("the parent's runner reported a remote run's end: %v", r.reports())
	}
}

// A job and a watch run on to their own exit, holding the checkout, and their exit sends the wake; a service, which
// never ends by itself, is killed with the session as before.
func TestJobsLeftRunningWhenTheirCoordinatorHandsOver(t *testing.T) {
	pool := newSessionPoolWithClock(1, newFakePoolClock())
	s := superviseClaudeSession(t, pool, oneTurn()...)
	s.awaitParked("turn-1")
	r := installSubagentChild(t, s)
	release := filepath.Join(r.marks, "release")
	wait := "while [ ! -f " + release + " ]; do sleep 0.05; done; echo finished"
	job := r.runJob(wait, bgKindJob)
	watch := r.runJob(wait, bgKindWatch)
	service := r.runJob("exec sleep 300", bgKindService)

	s.queue(RunInboxResponse{TurnID: "end-1", Kind: "end", Content: keepWorkEnd})
	waitUntil(t, func() bool { return r.pathIndex("/finalize") >= 0 }, "the session was never finalized")
	awaitSupervisorDone(t, s)
	waitUntil(t, func() bool { return !processAlive(service.PID) }, "the service outlived its session")
	for _, j := range []bgJobStatus{job, watch} {
		if !processAlive(j.PID) {
			t.Fatalf("%s %s did not outlive its coordinator's handover", j.Kind, j.JobID)
		}
		if !heldFor(pool, s.job.SessionID, j.JobID) {
			t.Fatalf("the checkout is not held for %s %s", j.Kind, j.JobID)
		}
	}
	if r.requested("/background-wake") {
		t.Fatal("a wake was sent before any job ended")
	}

	if err := os.WriteFile(release, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	for _, j := range []bgJobStatus{job, watch} {
		waitUntil(t, func() bool { return !processAlive(j.PID) && !heldFor(pool, s.job.SessionID, j.JobID) },
			j.Kind+" "+j.JobID+" never ended, or its hold outlived it")
	}
	waitUntil(t, func() bool { return r.countRequests("/background-wake") == 2 },
		"the jobs' exits did not each send the wake their end owes")
}

// An ordinary end still ends the session's jobs, and owes no wake for the ones it ended.
func TestJobsEndedByAnOrdinaryEndTurn(t *testing.T) {
	shortDrainWait(t)
	pool := newSessionPoolWithClock(1, newFakePoolClock())
	s := superviseClaudeSession(t, pool, oneTurn()...)
	s.awaitParked("turn-1")
	r := installSubagentChild(t, s)
	job := r.runJob("exec sleep 300", bgKindJob)

	s.queue(RunInboxResponse{TurnID: "end-1", Kind: "end"})
	waitUntil(t, func() bool { return r.pathIndex("/finalize") >= 0 }, "the session was never finalized")
	awaitSupervisorDone(t, s)
	if processAlive(job.PID) {
		t.Fatalf("job %s outlived an ordinary end", job.JobID)
	}
	if r.requested("/background-wake") {
		t.Fatal("a job the end killed sent a wake")
	}
}

func TestKeepBackgroundWorkRequested(t *testing.T) {
	for content, want := range map[string]bool{
		keepWorkEnd:                    true,
		`{"keepBackgroundWork":false}`: false,
		"":                             false,
		"not json":                     false,
		`{"stopBackgroundWork":true}`:  false,
	} {
		if got := keepBackgroundWorkRequested(content); got != want {
			t.Errorf("keepBackgroundWorkRequested(%q) = %v, want %v", content, got, want)
		}
	}
}

// countRequests is how many of the runner's requests had a path ending in suffix.
func (s *supervisedSession) countRequests(suffix string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, path := range s.paths {
		if strings.HasSuffix(path, suffix) {
			n++
		}
	}
	return n
}

// A SubAgent that ends FAILED says why in what the runner reports: the engine's own error and the end of its stderr,
// so a failure like production's kept Codex run (11-17) is diagnosable after the engine and its records are gone.
// The child here is a kept run whose engine, after its coordinator handed over, writes two stderr lines and ends its
// turn as an error with only the model's last words for a result.
func TestKeptSubagentFailureReportsItsEngineStderrTail(t *testing.T) {
	pool := newSessionPoolWithClock(1, newFakePoolClock())
	s := superviseClaudeSession(t, pool, oneTurn()...)
	s.awaitParked("turn-1")
	bin, marks := t.TempDir(), t.TempDir()
	child := `#!/bin/sh
read -r frame
printf '%s\n' '{"type":"system","subtype":"init","session_id":"child"}'
touch "$SUBAGENT_MARKS/started"
while [ ! -f "$SUBAGENT_MARKS/finish" ]; do sleep 0.05; done
echo 'ERROR: unexpected status 401 Unauthorized: orbit_gateway_token_invalid' >&2
echo 'stream disconnected before completion' >&2
printf '%s\n' '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"The first sleep is still running."}'
`
	if err := os.WriteFile(filepath.Join(bin, "child.sh"), []byte(child), 0o755); err != nil {
		t.Fatal(err)
	}
	wrapper := "#!/bin/sh\nif [ -n \"$" + envSubagentRunID + "\" ]; then exec /bin/sh " + filepath.Join(bin, "child.sh") +
		" \"$@\"; fi\nexec " + filepath.Join(s.fake.Dir, "claude") + " \"$@\"\n"
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(wrapper), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("SUBAGENT_MARKS", marks)
	r := &subagentRig{supervisedSession: s, marks: marks}
	run := r.delegate(true)

	s.queue(RunInboxResponse{TurnID: "end-1", Kind: "end", Content: keepWorkEnd})
	waitUntil(t, func() bool { return r.pathIndex("/finalize") >= 0 }, "the session was never finalized")
	awaitSupervisorDone(t, s)
	r.finishChild()
	failed := r.awaitReport(subagentStatusFailed)
	summary := asString(failed["resultSummary"])
	t.Logf("reported: %s", summary)
	for _, want := range []string{
		"The SubAgent failed: error_during_execution",
		"The first sleep is still running.",
		"The engine's stderr ended with:",
		"unexpected status 401 Unauthorized: orbit_gateway_token_invalid",
		"stream disconnected before completion",
	} {
		if !strings.Contains(summary, want) {
			t.Errorf("the FAILED report of %s does not carry %q:\n%s", run.RunID, want, summary)
		}
	}
	if failed["wake"] != true {
		t.Errorf("the kept run's failure owes the successor no wake: %v", failed)
	}
}

func TestSubagentStderrTailKeepsTheLastLines(t *testing.T) {
	var tail subagentStderrTail
	for i := 0; i < 500; i++ {
		tail.write(fmt.Sprintf("line %03d of the engine's stderr", i))
	}
	got := tail.String()
	if len(got) > subagentStderrTailBytes || !strings.HasPrefix(got, "line ") || !strings.HasSuffix(got, "line 499 of the engine's stderr") {
		t.Fatalf("tail is %d bytes, %q…%q", len(got), got[:min(40, len(got))], got[max(0, len(got)-40):])
	}
	var none *subagentStderrTail
	none.write("ignored")
	if none.String() != "" {
		t.Fatal("a nil tail keeps something")
	}
}
