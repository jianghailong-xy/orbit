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

// A runner-hosted job can ask to wake the session it belongs to — when it exits, or when it has
// written something new. The wake is a request to the control plane, which files it as a turn, so
// nothing about it depends on an engine being resident: the engine that started the wait may have
// been recycled long before the wait ends, and that is exactly the session these tests supervise.
//
// They drive the real supervisor with no engine and no turn permit, start jobs through the
// session's own socket as bg_run does, and read the verdict off a stub control plane that keeps
// every wake the runner actually sent.

// wakeControlPlane is the runner-stop stub with a door for wakes: it keeps each wake body the
// runner POSTs, in the order they arrived, and answers each as filed.
type wakeControlPlane struct {
	*runnerStopControlPlane
	wakeMu sync.Mutex
	wakes  []map[string]interface{}
}

func newWakeControlPlane() *wakeControlPlane {
	return &wakeControlPlane{runnerStopControlPlane: newRunnerStopControlPlane()}
}

func (c *wakeControlPlane) serve(w http.ResponseWriter, r *http.Request) {
	if strings.HasSuffix(r.URL.Path, "/background-wake") {
		var body map[string]interface{}
		if json.NewDecoder(r.Body).Decode(&body) == nil {
			c.wakeMu.Lock()
			c.wakes = append(c.wakes, body)
			c.wakeMu.Unlock()
		}
		_, _ = w.Write([]byte(`{"outcome":"ENQUEUED"}`))
		return
	}
	c.runnerStopControlPlane.serve(w, r)
}

func (c *wakeControlPlane) wakesFor(jobID string) []map[string]interface{} {
	c.wakeMu.Lock()
	defer c.wakeMu.Unlock()
	var out []map[string]interface{}
	for _, wake := range c.wakes {
		if asString(wake["jobId"]) == jobID {
			out = append(out, wake)
		}
	}
	return out
}

// superviseParkedSession runs the supervisor as runLoop does for a session that holds no permit
// and has no engine resident: the state a long wait leaves a session in.
func superviseParkedSession(t *testing.T, job *ClaimedSession, api *wakeControlPlane) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(api.serve))
	t.Cleanup(server.Close)
	pool := newSessionPool(4)
	sessionCtx, cancelSession := context.WithCancel(context.Background())
	runnerCtx, stopRunner := context.WithCancel(context.Background())
	live, added := pool.register(job, cancelSession, false)
	if !added {
		t.Fatal("the session was not registered")
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		runInteractiveSession(NewTransport(server.URL, "runner-token"), job, sessionCtx, runnerCtx,
			t.TempDir(), nil, pool, live)
		pool.finish(live)
	}()
	t.Cleanup(func() {
		stopRunner()
		api.releaseLeases()
		select {
		case <-done:
		case <-time.After(2 * time.Minute):
			t.Error("the supervisor never returned")
		}
		cancelSession()
	})
}

// bgCall is one bg_* call as the agent's `orbit mcp` child makes it: over the session's socket,
// with the token the supervisor wrote for this run.
func bgCall(t *testing.T, sessionID, op string, args map[string]interface{}) json.RawMessage {
	t.Helper()
	var token string
	awaitCondition(t, 15*time.Second, "the session never served its background job socket", func() bool {
		data, err := os.ReadFile(bgTokenPath(sessionID))
		token = strings.TrimSpace(string(data))
		return err == nil && token != ""
	})
	raw, err := bgSocketCall(bgSocketPath(sessionID), token, op, args)
	if err != nil {
		t.Fatalf("bg %s %v failed: %v", op, args, err)
	}
	return raw
}

func bgRunWith(t *testing.T, sessionID string, args map[string]interface{}) bgJobStatus {
	t.Helper()
	var status bgJobStatus
	if raw := bgCall(t, sessionID, "run", args); json.Unmarshal(raw, &status) != nil {
		t.Fatalf("bg_run result was not a job status: %s", raw)
	}
	return status
}

// The wake is for what the job did. A job that asked is woken for when it exits, with what an
// agent needs to act without reading first: which job, how it ended, the end of its output and
// where the rest is. A job that did not ask, and one somebody killed, wake nobody.
func TestBgRunWakeOnExitAsksTheControlPlaneToWakeTheSession(t *testing.T) {
	job := runnerStopJob(t, "sess-wake-exit")
	api := newWakeControlPlane()
	superviseParkedSession(t, job, api)

	quiet := bgRunWith(t, job.SessionID, map[string]interface{}{
		"command": "echo nothing to see; exit 0", "kind": "job",
	})
	killed := bgRunWith(t, job.SessionID, map[string]interface{}{
		"command": "exec sleep 300", "kind": "job", "wakeOnExit": true,
	})
	command := "echo 'checks: 1 failed'; exit 3"
	waker := bgRunWith(t, job.SessionID, map[string]interface{}{
		"command": command, "kind": "job", "wakeOnExit": true,
	})
	bgCall(t, job.SessionID, "kill", map[string]interface{}{"jobId": killed.JobID})

	awaitCondition(t, 30*time.Second, "the job exited and no wake reached the control plane", func() bool {
		return len(api.wakesFor(waker.JobID)) > 0
	})
	wake := api.wakesFor(waker.JobID)[0]
	if got := asString(wake["trigger"]); got != "exit" {
		t.Errorf("wake trigger = %q, want exit", got)
	}
	if got := asString(wake["status"]); got != bgStatusFailed {
		t.Errorf("wake status = %q, want failed", got)
	}
	if got, ok := wake["exitCode"].(float64); !ok || got != 3 {
		t.Errorf("wake exitCode = %v, want the 3 the runner's own Wait returned", wake["exitCode"])
	}
	if got := asString(wake["outputPath"]); got != waker.OutputPath {
		t.Errorf("wake outputPath = %q, want %q", got, waker.OutputPath)
	}
	if got := asString(wake["outputExcerpt"]); !strings.Contains(got, "checks: 1 failed") {
		t.Errorf("wake outputExcerpt = %q, want the end of the job's output", got)
	}
	if got := asString(wake["command"]); got != command {
		t.Errorf("wake command = %q, want %q", got, command)
	}
	if asString(wake["wakeId"]) == "" {
		t.Error("the wake carries no id a retry could be recognised by")
	}

	// Both of the others ended as well, and their ends reached the control plane: whatever wake
	// either would have sent went out alongside, so none having arrived is an answer.
	awaitCondition(t, 15*time.Second, "the other jobs' ends were never delivered", func() bool {
		return len(api.terminalReports(quiet.JobID)) > 0 && len(api.terminalReports(killed.JobID)) > 0
	})
	time.Sleep(2 * time.Second)
	if got := api.wakesFor(quiet.JobID); len(got) != 0 {
		t.Errorf("a job that did not ask to wake the session woke it: %v", got)
	}
	if got := api.wakesFor(killed.JobID); len(got) != 0 {
		t.Errorf("a job killed on request woke the session that killed it: %v", got)
	}
	if got := api.wakesFor(waker.JobID); len(got) != 1 {
		t.Errorf("wakes for one exit = %d, want exactly one: %v", len(got), got)
	}
}

// New output wakes the session once per merge window, not once per line: a CI log arrives a
// hundred lines at a time, and every burst of it is one wake at most. After a wake the job is
// quiet for a while — output that lands inside that interval waits for the next one.
func TestBgRunWakeOnOutputWakesOncePerMergeWindow(t *testing.T) {
	job := runnerStopJob(t, "sess-wake-output")
	api := newWakeControlPlane()
	superviseParkedSession(t, job, api)

	// Six hundred lines over six seconds, a pause, and three hundred more.
	command := `for i in 1 2 3 4 5 6; do seq 1 100 | sed "s/^/first run $i line /"; sleep 1; done; ` +
		`sleep 15; for i in 1 2 3; do seq 1 100 | sed "s/^/second run $i line /"; sleep 1; done; exec sleep 300`
	started := time.Now()
	ci := bgRunWith(t, job.SessionID, map[string]interface{}{
		"command": command, "kind": "job", "wakeOnOutput": true,
	})
	t.Cleanup(func() {
		if token, err := os.ReadFile(bgTokenPath(job.SessionID)); err == nil {
			_, _ = bgSocketCall(bgSocketPath(job.SessionID), strings.TrimSpace(string(token)), "kill",
				map[string]interface{}{"jobId": ci.JobID})
		}
	})

	awaitCondition(t, 40*time.Second, "the job wrote six hundred lines and no wake reached the control plane", func() bool {
		return len(api.wakesFor(ci.JobID)) > 0
	})
	first := api.wakesFor(ci.JobID)[0]
	if got := asString(first["trigger"]); got != "output" {
		t.Errorf("wake trigger = %q, want output", got)
	}
	if got := asString(first["status"]); got != bgStatusRunning {
		t.Errorf("wake status = %q, want running", got)
	}
	// Merged: the one wake was sent once the burst had landed, so it carries the end of the whole
	// first run rather than its first few lines.
	if got := asString(first["outputExcerpt"]); !strings.Contains(got, "first run 6 line 100") {
		t.Errorf("the output wake did not wait out its merge window; excerpt ends:\n%s", tail(got, 400))
	}

	// The second run lands well inside the interval after that wake, and wakes nobody yet.
	for time.Since(started) < 40*time.Second {
		time.Sleep(200 * time.Millisecond)
	}
	if got := api.wakesFor(ci.JobID); len(got) != 1 {
		t.Fatalf("output wakes in the first 40s = %d, want exactly one: %v", len(got), got)
	}
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

// A watch is a job that waits for something else — CI, a deploy, a review — and costs this
// machine nothing while it does. It holds the checkout like any job the runner hosts (the GC
// passes it by, a merge or commit receipt names it), and it takes no admission slot: a session
// parked on a forty-minute CI wait must not keep new work off the runner.
func TestWatchJobHoldsTheCheckoutWithoutTakingAnAdmissionSlot(t *testing.T) {
	pool := newSessionPool(1)
	events := &bgJobEvents{}
	ctx, cancel := context.WithCancel(context.Background())
	bg := newBgTailer(ctx, events.emit, pool.worktreeHoldsFor("watcher"))
	t.Cleanup(func() {
		for _, job := range bg.listJobs(false) {
			bg.killJob(job.JobID, bgKillTeardownGrace)
		}
		bg.stopAll()
		cancel()
	})

	watch, err := bg.startJob(bgJobSpec{
		Command: "exec sleep 300", Kind: "watch", Dir: t.TempDir(), ScratchDir: t.TempDir(),
		Description: "wait for CI",
	})
	if err != nil {
		t.Fatalf("a watch job was refused: %v", err)
	}
	if !watch.HoldsWorktree {
		t.Error("a watch job does not hold the checkout")
	}
	if !pool.ids()["watcher"] {
		t.Error("the worktree GC would delete a checkout a watch job is running in")
	}
	holders := pool.worktreeHolders("watcher")
	if len(holders) != 1 || holders[0].kind != worktreeHeldByBackgroundJob {
		t.Errorf("holders of the checkout = %v, want the watch job", holders)
	}
	if idle := pool.admissionIdleCapacity(); idle != 1 {
		t.Fatalf("idle capacity beside a watch job = %d, want 1: a watch takes no admission slot", idle)
	}

	// The paired positive: a job of the same session does take the slot.
	build, err := bg.startJob(bgJobSpec{
		Command: "exec sleep 300", Kind: bgKindJob, Dir: t.TempDir(), ScratchDir: t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if idle := pool.admissionIdleCapacity(); idle != 0 {
		t.Fatalf("idle capacity beside a running job = %d, want 0", idle)
	}
	bg.killJob(build.JobID, bgKillTeardownGrace)
	awaitCondition(t, 10*time.Second, "the slot never came back after the job ended", func() bool {
		return pool.admissionIdleCapacity() == 1
	})
	if !processAlive(watch.PID) {
		t.Fatal("the watch job stopped when the job beside it was killed")
	}
	if holders := pool.worktreeHolders("watcher"); len(holders) != 1 {
		t.Errorf("holders after the job ended = %v, want the watch job still holding", holders)
	}
}
