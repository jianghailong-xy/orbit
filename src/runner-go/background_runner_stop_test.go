//go:build linux || darwin

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// A runner that stops — to re-exec into a self-update, or because its service was stopped —
// takes the jobs it hosts with it: they are its own children, and nothing carries them across
// the restart. A runner stop is not one of the three things allowed to end a job (its own exit,
// the end of its session, an explicit kill), so these cases are about the report: a job the
// runner's stop ended says so, exactly once, with a reason no count of session ends can absorb,
// and says so early enough to be delivered.
//
// Both drive the real supervisor, runInteractiveSession, and hand it the runner's stop as its
// shutdown context — exactly what runLoop passes (loopCtx, cancelled on SIGTERM and when an
// update is found). Jobs go in through the session's real socket, and the verdict is read off a
// stub control plane that keeps what the runner actually delivered: a report that was emitted
// and never sent is precisely the failure, and listening to emit() could not see it.

// runnerStopControlPlane hands out queued turns, keeps every event the runner delivers, and can
// hold lease releases the way an overloaded control plane answers them late. Like the real control
// plane it takes no events for a session it has closed — by a turn completion that ends the
// session, or by /finalize — and keeps what arrives after apart: a report sent too late was not
// delivered.
type runnerStopControlPlane struct {
	mu           sync.Mutex
	inbox        []RunInboxResponse
	events       []RunEvent
	late         []RunEvent
	closed       bool
	completions  []TurnCompleteRequest
	finalizes    []RunFinalizeRequest
	imports      []ImportResultRequest
	holdReleases bool
	releases     chan struct{}
	releaseOnce  sync.Once
}

func newRunnerStopControlPlane() *runnerStopControlPlane {
	return &runnerStopControlPlane{releases: make(chan struct{})}
}

func (c *runnerStopControlPlane) serve(w http.ResponseWriter, r *http.Request) {
	switch {
	case strings.HasSuffix(r.URL.Path, "/inbox"):
		deadline := time.Now().Add(20 * time.Millisecond)
		for time.Now().Before(deadline) && r.Context().Err() == nil {
			c.mu.Lock()
			if len(c.inbox) > 0 {
				turn := c.inbox[0]
				c.inbox = c.inbox[1:]
				c.mu.Unlock()
				_ = json.NewEncoder(w).Encode(turn)
				return
			}
			c.mu.Unlock()
			time.Sleep(2 * time.Millisecond)
		}
	case strings.HasSuffix(r.URL.Path, "/events"):
		var batch RunEventBatch
		if json.NewDecoder(r.Body).Decode(&batch) == nil {
			c.mu.Lock()
			if c.closed {
				// The real control plane refuses these with 409 ("session is no longer open"). Taken
				// quietly here, so a verdict is read off what was accepted rather than off how the
				// runner takes a refusal.
				c.late = append(c.late, batch.Events...)
			} else {
				c.events = append(c.events, batch.Events...)
			}
			c.mu.Unlock()
		}
	case strings.HasSuffix(r.URL.Path, "/turn-complete"):
		var req TurnCompleteRequest
		if json.NewDecoder(r.Body).Decode(&req) == nil {
			// A failed turn of the session's own ends the session, and the answer says so.
			ends := req.Status == stFailed && req.Subtype != subtypeSteer && req.Subtype != subtypeUnknownKind
			c.mu.Lock()
			c.completions = append(c.completions, req)
			c.closed = c.closed || ends
			c.mu.Unlock()
			if ends {
				_ = json.NewEncoder(w).Encode(TurnCompleteResponse{OK: true, Status: stFailed})
				return
			}
		}
	case strings.HasSuffix(r.URL.Path, "/finalize"):
		var req RunFinalizeRequest
		if json.NewDecoder(r.Body).Decode(&req) == nil {
			c.mu.Lock()
			c.finalizes = append(c.finalizes, req)
			c.closed = true
			c.mu.Unlock()
		}
	case strings.HasSuffix(r.URL.Path, "/import-result"):
		// Settles as applied, like the real door's CAS on a first ok. Cases that never import
		// never post here, so what this answers is only ever read by the import ones.
		var req ImportResultRequest
		if json.NewDecoder(r.Body).Decode(&req) == nil {
			c.mu.Lock()
			c.imports = append(c.imports, req)
			c.mu.Unlock()
		}
		_ = json.NewEncoder(w).Encode(ImportResultResponse{Ok: true, Applied: true})
		return
	case strings.HasSuffix(r.URL.Path, "/release-leases"):
		c.mu.Lock()
		hold := c.holdReleases
		c.mu.Unlock()
		if hold {
			select {
			case <-c.releases:
			case <-r.Context().Done():
				return
			}
		}
	}
	_, _ = w.Write([]byte(`{}`))
}

// imports is every /import-result the runner posted, in arrival order.
func (c *runnerStopControlPlane) importResults() []ImportResultRequest {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]ImportResultRequest(nil), c.imports...)
}

func (c *runnerStopControlPlane) queue(turn RunInboxResponse) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.inbox = append(c.inbox, turn)
}

// holdLeaseReleases makes every later /release-leases wait for releaseLeases, or for the runner
// to give up on the request.
func (c *runnerStopControlPlane) holdLeaseReleases() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.holdReleases = true
}

func (c *runnerStopControlPlane) releaseLeases() {
	c.releaseOnce.Do(func() { close(c.releases) })
}

func (c *runnerStopControlPlane) delivered(match func(RunEvent) bool) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, e := range c.events {
		if match(e) {
			return true
		}
	}
	return false
}

// terminalReports is every terminal background_task the control plane accepted for one job.
func (c *runnerStopControlPlane) terminalReports(jobID string) []map[string]interface{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	return terminalReportsOf(c.events, jobID)
}

// lateTerminalReports is every terminal background_task for one job that arrived after the session
// was closed, and so was never accepted.
func (c *runnerStopControlPlane) lateTerminalReports(jobID string) []map[string]interface{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	return terminalReportsOf(c.late, jobID)
}

func terminalReportsOf(events []RunEvent, jobID string) []map[string]interface{} {
	var out []map[string]interface{}
	for _, e := range events {
		if e.Type == evBackgroundTask && asString(e.Payload["toolUseId"]) == jobID &&
			isTerminalBgStatus(asString(e.Payload["status"])) {
			out = append(out, e.Payload)
		}
	}
	return out
}

// lateEvents is every event that arrived after the session was closed.
func (c *runnerStopControlPlane) lateEvents() []RunEvent {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]RunEvent(nil), c.late...)
}

func (c *runnerStopControlPlane) turnCompletions() []TurnCompleteRequest {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]TurnCompleteRequest(nil), c.completions...)
}

// finalizeStatuses is the status of every /finalize the runner sent, in order.
func (c *runnerStopControlPlane) finalizeStatuses() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []string
	for _, f := range c.finalizes {
		out = append(out, f.Status)
	}
	return out
}

func isJobLaunch(jobID string) func(RunEvent) bool {
	return func(e RunEvent) bool {
		return e.Type == evBackgroundTask && asString(e.Payload["toolUseId"]) == jobID &&
			asString(e.Payload["status"]) == bgStatusRunning
	}
}

// runnerStopSupervisor is one session under runInteractiveSession whose runner stop the test holds.
type runnerStopSupervisor struct {
	job  *ClaimedSession
	pool *sessionPool
	live *liveSession
	stop context.CancelFunc // the runner stopping
	end  context.CancelFunc // the session ending
	done chan struct{}
}

// superviseUntilRunnerStop starts the supervisor as runLoop does. active is whether the session
// holds a turn permit (a claim) or sits with no engine, as it does once its engine was recycled
// under a live job.
func superviseUntilRunnerStop(t *testing.T, job *ClaimedSession, active bool, api *runnerStopControlPlane) *runnerStopSupervisor {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(api.serve))
	t.Cleanup(server.Close)

	pool := newSessionPool(4)
	sessionCtx, cancelSession := context.WithCancel(context.Background())
	runnerCtx, stopRunner := context.WithCancel(context.Background())
	live, added := pool.register(job, cancelSession, active)
	if !added {
		t.Fatal("the session was not registered")
	}
	s := &runnerStopSupervisor{job: job, pool: pool, live: live, stop: stopRunner, end: cancelSession, done: make(chan struct{})}
	execDir := t.TempDir()
	go func() {
		defer close(s.done)
		runInteractiveSession(NewTransport(server.URL, "runner-token"), job, sessionCtx, runnerCtx,
			execDir, nil, pool, live)
		pool.finish(live)
	}()
	t.Cleanup(func() {
		stopRunner()
		api.releaseLeases()
		select {
		case <-s.done:
		case <-time.After(4 * time.Minute):
			t.Error("the supervisor never returned after the runner stopped")
		}
		cancelSession()
	})
	return s
}

func (s *runnerStopSupervisor) returned() bool {
	select {
	case <-s.done:
		return true
	default:
		return false
	}
}

func (s *runnerStopSupervisor) awaitReturn(t *testing.T, within time.Duration) {
	t.Helper()
	select {
	case <-s.done:
	case <-time.After(within):
		t.Fatalf("the supervisor was still attached %s after the runner began stopping", within)
	}
}

// run is bg_run as the agent's `orbit mcp` child makes it: over the session's own socket, with the
// token the supervisor wrote for this run.
func (s *runnerStopSupervisor) run(t *testing.T, command, kind string) (bgJobStatus, error) {
	t.Helper()
	var token string
	awaitCondition(t, 15*time.Second, "the session never served its background job socket", func() bool {
		data, err := os.ReadFile(bgTokenPath(s.job.SessionID))
		token = strings.TrimSpace(string(data))
		return err == nil && token != ""
	})
	raw, err := bgSocketCall(bgSocketPath(s.job.SessionID), token, "run", map[string]interface{}{
		"command":     command,
		"kind":        kind,
		"description": "runner stop " + kind,
	})
	if err != nil {
		return bgJobStatus{}, err
	}
	var status bgJobStatus
	if err := json.Unmarshal(raw, &status); err != nil {
		t.Fatalf("bg_run result was not a job status: %v (%s)", err, raw)
	}
	return status, nil
}

func (s *runnerStopSupervisor) mustRun(t *testing.T, command, kind string) bgJobStatus {
	t.Helper()
	status, err := s.run(t, command, kind)
	if err != nil {
		t.Fatalf("bg_run of a %s failed: %v", kind, err)
	}
	if !processAlive(status.PID) {
		t.Fatalf("bg_run reported pid %d, which is not running", status.PID)
	}
	return status
}

func awaitCondition(t *testing.T, within time.Duration, whenNot string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal(whenNot)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// runnerStopJob is a Claude session whose socket path fits: the socket lives under ORBIT_HOME, a
// unix socket path is capped at bgSocketPathCap, and t.TempDir() names itself after the test.
func runnerStopJob(t *testing.T, id string) *ClaimedSession {
	t.Helper()
	job := claudeSpawnJob(t)
	home, err := os.MkdirTemp("", "ors")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	t.Setenv("ORBIT_HOME", home)
	job.SessionID = id
	// Credentials of the session's own, so the spawn's auth preflight never asks this machine's
	// login about a CLI that is not the real one.
	job.Agent.Env = map[string]string{"ANTHROPIC_API_KEY": "test"}
	return job
}

// assertEndedByRunnerStop is the verdict both cases share: exactly one terminal report on the
// control plane, `killed` with the runner's own reason, and a process that is really gone.
func assertEndedByRunnerStop(t *testing.T, api *runnerStopControlPlane, job bgJobStatus) {
	t.Helper()
	terminal := api.terminalReports(job.JobID)
	if len(terminal) != 1 {
		t.Errorf("%s %s: terminal reports the control plane received = %v, want exactly one",
			job.Kind, job.JobID, terminal)
	} else {
		if got := asString(terminal[0]["status"]); got != bgStatusKilled {
			t.Errorf("%s %s was reported %q, want killed", job.Kind, job.JobID, got)
		}
		if got := asString(terminal[0]["reason"]); got != "runner_shutdown" {
			t.Errorf("%s %s was reported killed for reason %q, want runner_shutdown: the runner stopping is not the session ending",
				job.Kind, job.JobID, got)
		}
	}
	// The runner's own Wait reaped the process before anything was reported, and the supervisor
	// has joined that waiter, so a zombie cannot be what answers signal 0 here.
	if processAlive(job.PID) {
		t.Errorf("%s %s (pid %d) is still alive after the runner stopped", job.Kind, job.JobID, job.PID)
	}
}

// No turn in flight: the session whose engine was recycled under a live job — the state runner
// hosting exists for, and the state in which the old drain's kills did arrive, filed as the
// session's own `drain` and `drain_cap`.
func TestRunnerStopReportsEachJobItEndsAsRunnerShutdown(t *testing.T) {
	job := runnerStopJob(t, "sess-runner-stop-idle")
	api := newRunnerStopControlPlane()
	sup := superviseUntilRunnerStop(t, job, false, api)

	build := sup.mustRun(t, "exec sleep 300", bgKindJob)
	devServer := sup.mustRun(t, "exec sleep 300", bgKindService)
	awaitCondition(t, 15*time.Second, "the launches were never delivered", func() bool {
		return api.delivered(isJobLaunch(build.JobID)) && api.delivered(isJobLaunch(devServer.JobID))
	})

	sup.stop()
	// Nothing is left to host a job started now: admitting one buys a kill and nothing else.
	late, lateErr := sup.run(t, "exec sleep 300", bgKindJob)

	sup.awaitReturn(t, 2*time.Minute)

	assertEndedByRunnerStop(t, api, build)
	assertEndedByRunnerStop(t, api, devServer)
	if lateErr == nil {
		t.Errorf("bg_run was admitted after the runner began stopping: %+v", late)
	}
}

// The session from the 0.1.155 restart (70d5bfef): a turn still in flight when the runner stops,
// and a job running beside it. The turn drain holds the supervisor for up to
// shutdownDrainTimeout, while the flush that has to carry the job's end is given a grace counted
// from the moment the runner began to stop. A job drain that only began after the turn drain
// spent its bgDrainWaitCap past that grace: the kill was emitted, the flush was already
// cancelled, and the job's last delivered event stayed `running` for good.
//
// The CLI takes the message and opens a tool call it never finishes, as one deep inside a long
// tool call does: the turn is acknowledged and stays in flight for as long as the process lives
// (the fake outlives its last step until its stdin closes). The stub holds lease releases the way
// a loaded control plane answers them late — in production the ten seconds between the drain
// timeout and the job drain went to teardown and round-trips at load 62 — which carries the old
// ordering past the grace every time. Once the job's end is on the control plane the session is
// ended, so a runner that reports in time finishes in about bgDrainWaitCap, and one that does not
// plays the production sequence out and is judged on what arrived.
func TestRunnerStopMidTurnStillDeliversTheJobKill(t *testing.T) {
	fake := newFakeClaude(t,
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "system_init"},
		fakeStep{Emit: "tool_use", ToolUseID: "toolu_suite", ToolName: "Bash",
			Input: map[string]interface{}{"command": "go test ./..."}},
	)
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	job := runnerStopJob(t, "sess-runner-stop-midturn")
	api := newRunnerStopControlPlane()
	api.queue(RunInboxResponse{TurnID: "turn-1", Kind: "message", Content: "run the full suite"})
	sup := superviseUntilRunnerStop(t, job, true, api)
	awaitCondition(t, 30*time.Second, "the turn never reached its tool call", func() bool {
		return api.delivered(isToolUse("toolu_suite"))
	})

	suite := sup.mustRun(t, "exec sleep 300", bgKindJob)
	awaitCondition(t, 15*time.Second, "the job's launch was never delivered", func() bool {
		return api.delivered(isJobLaunch(suite.JobID))
	})

	api.holdLeaseReleases()
	sup.stop()
	awaitCondition(t, 4*time.Minute, "the supervisor neither reported the job's end nor returned", func() bool {
		return len(api.terminalReports(suite.JobID)) > 0 || sup.returned()
	})
	// Nothing more is owed to the verdict. A runner that did not report in time has already
	// returned, and ending the session changes nothing for it.
	api.releaseLeases()
	sup.end()
	sup.awaitReturn(t, time.Minute)

	assertEndedByRunnerStop(t, api, suite)
}
