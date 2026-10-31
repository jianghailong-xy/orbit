//go:build linux || darwin

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
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
	superviseParkedSessionOn(t, job, api, http.HandlerFunc(api.serve))
}

// superviseParkedSessionOn is superviseParkedSession with the control plane's answers under the
// caller's hand. api is still the one whose lease releases the teardown relies on.
func superviseParkedSessionOn(t *testing.T, job *ClaimedSession, api *wakeControlPlane, handler http.Handler) {
	t.Helper()
	server := httptest.NewServer(handler)
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

// shortStallFloor lets a case ask wakeOnStall for a silence of a few seconds, where bg_run refuses
// anything under a minute: what is asserted is which silences wake the session and how often, and a
// minute of waiting per silence would decide only how long the case takes. Restored once the case's
// supervisor has returned (cleanups run last-in first-out).
func shortStallFloor(t *testing.T) {
	t.Helper()
	restore := bgWakeOnStallMinSeconds
	bgWakeOnStallMinSeconds = 1
	t.Cleanup(func() { bgWakeOnStallMinSeconds = restore })
}

// stallAfter is bg_run's wakeOnStall argument for a silence of n seconds.
func stallAfter(n int) map[string]interface{} {
	return map[string]interface{}{"afterSeconds": n}
}

// killJobOnCleanup ends a job of a case whose job would otherwise outlive it, through the session's
// own socket as bg_kill does, while the supervisor still serves it.
func killJobOnCleanup(t *testing.T, sessionID, jobID string) {
	t.Helper()
	t.Cleanup(func() {
		if token, err := os.ReadFile(bgTokenPath(sessionID)); err == nil {
			_, _ = bgSocketCall(bgSocketPath(sessionID), strings.TrimSpace(string(token)), "kill",
				map[string]interface{}{"jobId": jobID})
		}
	})
}

// wakeMillis reads one of a stall wake's durations, failing the case when it is missing: a stall
// wake that does not say how long the job has run or been silent is the wake this feature replaces.
func wakeMillis(t *testing.T, wake map[string]interface{}, field string) int64 {
	t.Helper()
	ms, ok := wake[field].(float64)
	if !ok {
		t.Fatalf("the stall wake carries no %s: %v", field, wake)
	}
	return int64(ms)
}

// A job that hangs wakes its session once: when it has written nothing for afterSeconds, with what an
// agent needs to decide what to do about it — which job, how long it has run, how long it has been
// silent, the end of its output and where the rest is. The same silence going on wakes nobody again.
// Once the job writes again, its next silence of that length is a new one, and wakes the session again,
// counted from the new output rather than from the first.
func TestBgRunWakeOnStallWakesOncePerSilenceAndAgainOnceOutputResumes(t *testing.T) {
	shortStallFloor(t)
	job := runnerStopJob(t, "sess-wake-stall")
	api := newWakeControlPlane()
	superviseParkedSession(t, job, api)

	const afterSeconds = 3
	resume := filepath.Join(os.Getenv("ORBIT_HOME"), "resume")
	command := fmt.Sprintf(`echo 'step 1/2: waiting for the lock'; while [ ! -e %s ]; do sleep 0.1; done; `+
		`echo 'step 2/2: lock taken, waiting for the socket'; exec sleep 300`, resume)
	started := time.Now()
	hung := bgRunWith(t, job.SessionID, map[string]interface{}{
		"command": command, "kind": "job", "wakeOnStall": stallAfter(afterSeconds),
	})
	killJobOnCleanup(t, job.SessionID, hung.JobID)
	if hung.WakeOnStall == nil || hung.WakeOnStall.AfterSeconds != afterSeconds {
		t.Errorf("bg_run answered wakeOnStall = %+v, want afterSeconds %d", hung.WakeOnStall, afterSeconds)
	}

	awaitCondition(t, 30*time.Second, "the job went quiet and no stall wake reached the control plane", func() bool {
		return len(api.wakesFor(hung.JobID)) > 0
	})
	first := api.wakesFor(hung.JobID)[0]
	sinceStart := time.Since(started)
	if got := asString(first["trigger"]); got != bgWakeOnStall {
		t.Errorf("wake trigger = %q, want stall", got)
	}
	if got, want := asString(first["wakeId"]), hung.JobID+":stall:1"; got != want {
		t.Errorf("wake id = %q, want %q", got, want)
	}
	if got := asString(first["status"]); got != bgStatusRunning {
		t.Errorf("wake status = %q, want running: a stall is a job that is still up", got)
	}
	if _, ok := first["exitCode"]; ok {
		t.Errorf("a stall wake carries an exit code: %v", first)
	}
	if got := asString(first["outputPath"]); got != hung.OutputPath {
		t.Errorf("wake outputPath = %q, want %q", got, hung.OutputPath)
	}
	if got := asString(first["outputExcerpt"]); !strings.Contains(got, "step 1/2: waiting for the lock") {
		t.Errorf("wake outputExcerpt = %q, want the end of the job's output", got)
	}
	idle, elapsed := wakeMillis(t, first, "idleMs"), wakeMillis(t, first, "elapsedMs")
	if idle < afterSeconds*1000 {
		t.Errorf("the job was reported stalled after %dms of silence, before the %ds it asked for", idle, afterSeconds)
	}
	if elapsed < idle || elapsed > sinceStart.Milliseconds() {
		t.Errorf("elapsedMs = %d, want between the %dms of silence and the %dms since bg_run", elapsed, idle, sinceStart.Milliseconds())
	}

	// The same silence goes on for three times as long, and wakes nobody again.
	time.Sleep(3 * afterSeconds * time.Second)
	if got := api.wakesFor(hung.JobID); len(got) != 1 {
		t.Fatalf("stall wakes for one silence = %d, want exactly one: %v", len(got), got)
	}

	// The job writes again, and then goes quiet again: a new silence, reported again.
	resumedAt := time.Now()
	if err := os.WriteFile(resume, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	awaitCondition(t, 30*time.Second, "the job wrote again, went quiet again, and no second stall wake came", func() bool {
		return len(api.wakesFor(hung.JobID)) > 1
	})
	second := api.wakesFor(hung.JobID)[1]
	sinceResume := time.Since(resumedAt)
	if got, want := asString(second["wakeId"]), hung.JobID+":stall:2"; got != want {
		t.Errorf("second wake id = %q, want %q", got, want)
	}
	if got := asString(second["outputExcerpt"]); !strings.Contains(got, "step 2/2: lock taken, waiting for the socket") {
		t.Errorf("second wake outputExcerpt = %q, want the output the job wrote before its second silence", got)
	}
	idle = wakeMillis(t, second, "idleMs")
	if idle < afterSeconds*1000 || idle > sinceResume.Milliseconds() {
		t.Errorf("the second silence was reported as %dms, want at least %ds and no more than the %dms since the job wrote again",
			idle, afterSeconds, sinceResume.Milliseconds())
	}
	time.Sleep(2 * afterSeconds * time.Second)
	if got := api.wakesFor(hung.JobID); len(got) != 2 {
		t.Errorf("stall wakes for two silences = %d, want exactly two: %v", len(got), got)
	}
}

// wakeOnStall is a promise the agent waits on, so bg_run keeps it or refuses it: a malformed one is an
// error and no job is started, rather than a job that will never wake anybody when it hangs. The
// paired positive is the floor itself, which bg_list then shows.
func TestBgRunRefusesAWakeOnStallItCannotKeep(t *testing.T) {
	job := runnerStopJob(t, "sess-wake-stall-refused")
	api := newWakeControlPlane()
	superviseParkedSession(t, job, api)
	bgCall(t, job.SessionID, "list", nil) // waits for the socket
	token, err := os.ReadFile(bgTokenPath(job.SessionID))
	if err != nil {
		t.Fatal(err)
	}
	for what, value := range map[string]interface{}{
		"a bare number":            1800,
		"true":                     true,
		"an empty object":          map[string]interface{}{},
		"a misspelt field":         map[string]interface{}{"afterSecond": 1800},
		"a field it does not have": map[string]interface{}{"afterSeconds": 1800, "repeat": true},
		"less than a minute":       stallAfter(59),
		"a fraction of a second":   map[string]interface{}{"afterSeconds": 90.5},
		"a string":                 map[string]interface{}{"afterSeconds": "1800"},
		"more than thirty days":    stallAfter(bgWakeOnStallMaxSeconds + 1),
	} {
		_, err := bgSocketCall(bgSocketPath(job.SessionID), strings.TrimSpace(string(token)), "run", map[string]interface{}{
			"command": "exec sleep 300", "kind": "job", "wakeOnStall": value,
		})
		if err == nil || !strings.Contains(err.Error(), "wakeOnStall") {
			t.Errorf("bg_run with wakeOnStall as %s answered %v, want an error naming wakeOnStall", what, err)
		}
	}
	var listed struct {
		Jobs []bgJobStatus `json:"jobs"`
	}
	if raw := bgCall(t, job.SessionID, "list", nil); json.Unmarshal(raw, &listed) != nil || len(listed.Jobs) != 0 {
		t.Fatalf("after nine refused bg_runs, bg_list = %s, want no job started", raw)
	}

	floor := bgRunWith(t, job.SessionID, map[string]interface{}{
		"command": "exec sleep 300", "kind": "job", "wakeOnStall": stallAfter(60),
	})
	killJobOnCleanup(t, job.SessionID, floor.JobID)
	plain := bgRunWith(t, job.SessionID, map[string]interface{}{"command": "exec sleep 300", "kind": "job"})
	killJobOnCleanup(t, job.SessionID, plain.JobID)
	if raw := bgCall(t, job.SessionID, "list", nil); json.Unmarshal(raw, &listed) != nil || len(listed.Jobs) != 2 {
		t.Fatalf("bg_list = %s, want the two jobs started", raw)
	}
	for _, listedJob := range listed.Jobs {
		switch listedJob.JobID {
		case floor.JobID:
			if listedJob.WakeOnStall == nil || listedJob.WakeOnStall.AfterSeconds != 60 {
				t.Errorf("bg_list shows wakeOnStall %+v for the job that asked for 60 seconds", listedJob.WakeOnStall)
			}
		case plain.JobID:
			if listedJob.WakeOnStall != nil {
				t.Errorf("bg_list shows wakeOnStall %+v for a job that did not ask", listedJob.WakeOnStall)
			}
		}
	}
}

// A deploy takes the control plane away for about twenty seconds. A wake sent meanwhile is tried
// again until the control plane is back — past the three attempts six seconds apart that used to be
// all a wake got — and is delivered once it is, exactly once: a stall wake, and an exit wake, which
// goes the same way.
func TestAWakeOutlastsAControlPlaneThatIsAwayForADeploy(t *testing.T) {
	shortStallFloor(t)
	job := runnerStopJob(t, "sess-wake-outage")
	api := newWakeControlPlane()
	var away atomic.Bool
	away.Store(true)
	var refusedMu sync.Mutex
	refused := map[string]int{}
	superviseParkedSessionOn(t, job, api, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/background-wake") && away.Load() {
			var body map[string]interface{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			refusedMu.Lock()
			refused[asString(body["wakeId"])]++
			refusedMu.Unlock()
			http.Error(w, "the control plane is being deployed", http.StatusServiceUnavailable)
			return
		}
		api.serve(w, r)
	}))
	refusedTimes := func(wakeID string) int {
		refusedMu.Lock()
		defer refusedMu.Unlock()
		return refused[wakeID]
	}

	hung := bgRunWith(t, job.SessionID, map[string]interface{}{
		"command": "echo 'connecting to the database'; exec sleep 300", "kind": "job", "wakeOnStall": stallAfter(2),
	})
	killJobOnCleanup(t, job.SessionID, hung.JobID)
	tests := bgRunWith(t, job.SessionID, map[string]interface{}{
		"command": "echo 'all 412 tests passed'; exit 0", "kind": "job", "wakeOnExit": true,
	})

	// Both wakes are refused as often as a wake used to be tried at all, and the control plane is still
	// away: before this, both were lost here.
	stallID, exitID := hung.JobID+":stall:1", tests.JobID+":exit"
	awaitCondition(t, 60*time.Second, "the wakes were not tried three times against the control plane that was away", func() bool {
		return refusedTimes(stallID) >= bgWakeAttempts && refusedTimes(exitID) >= bgWakeAttempts
	})
	time.Sleep(time.Second)
	if got := len(api.wakesFor(hung.JobID)) + len(api.wakesFor(tests.JobID)); got != 0 {
		t.Fatalf("%d wakes were delivered to a control plane that was away", got)
	}
	away.Store(false)

	awaitCondition(t, 60*time.Second, "the control plane came back and the wakes it missed never reached it", func() bool {
		return len(api.wakesFor(hung.JobID)) > 0 && len(api.wakesFor(tests.JobID)) > 0
	})
	time.Sleep(2 * time.Second)
	if got := api.wakesFor(hung.JobID); len(got) != 1 || asString(got[0]["wakeId"]) != stallID {
		t.Errorf("stall wakes delivered = %v, want exactly %s", got, stallID)
	}
	if got := api.wakesFor(tests.JobID); len(got) != 1 || asString(got[0]["wakeId"]) != exitID {
		t.Errorf("exit wakes delivered = %v, want exactly %s", got, exitID)
	}
	if n := refusedTimes(stallID); n <= bgWakeAttempts-1 {
		t.Errorf("the stall wake was refused %d times before it was delivered, want it tried past the old %d", n, bgWakeAttempts)
	}
}

// superviseWakeImage is superviseImage (background_job_selfupdate_test.go) for a case that keeps the
// wakes each image sends: one image of the runner supervising the session, its pool its own, its stop
// the runner's context cancelled with cause.
func superviseWakeImage(t *testing.T, job *ClaimedSession, pool *sessionPool, api *wakeControlPlane, handler http.Handler, cause error) *runnerStopSupervisor {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	sessionCtx, cancelSession := context.WithCancel(context.Background())
	runnerCtx, stopRunner := context.WithCancelCause(context.Background())
	live, added := pool.register(job, cancelSession, false)
	if !added {
		t.Fatal("the session was not registered")
	}
	s := &runnerStopSupervisor{job: job, stop: func() { stopRunner(cause) }, end: cancelSession, done: make(chan struct{})}
	execDir := t.TempDir()
	go func() {
		defer close(s.done)
		runInteractiveSession(NewTransport(server.URL, "runner-token"), job, sessionCtx, runnerCtx,
			execDir, nil, pool, live)
		pool.finish(live)
	}()
	t.Cleanup(func() {
		s.stop()
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

// A self-update lands in the middle of three stalls, and each is reported once. The image that
// re-executes hands on what it knew — each job's wakeOnStall, when its output last moved, and the
// silence its last answered stall wake was about — so the next image:
//
//   - does not report again a silence the old image's wake was answered for;
//   - reports a silence that began before the re-exec and runs out after it, counted from when the
//     job really went quiet rather than from the re-exec; and
//   - sends again, under the same id, a stall wake the old image sent and never had answered, because
//     its control plane was away when the runner re-executed.
func TestAStallWakeIsNeitherRepeatedNorMissedAcrossASelfUpdate(t *testing.T) {
	shortStallFloor(t)
	job := runnerStopJob(t, "sess-stall-selfupdate")
	quiet := filepath.Join(os.Getenv("ORBIT_HOME"), "quiet")
	oldAPI := newWakeControlPlane()
	var owedID atomic.Value
	owedID.Store("")
	var owedRefusals atomic.Int32
	oldHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/background-wake") {
			data, _ := io.ReadAll(r.Body)
			var body map[string]interface{}
			_ = json.Unmarshal(data, &body)
			if jobID := asString(body["jobId"]); jobID != "" && jobID == owedID.Load().(string) {
				owedRefusals.Add(1)
				http.Error(w, "the control plane is being deployed", http.StatusServiceUnavailable)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(data))
		}
		oldAPI.serve(w, r)
	})
	old := superviseWakeImage(t, job, newSessionPool(4), oldAPI, oldHandler, errRunnerSelfUpdate)

	run := func(command string, afterSeconds int) bgJobStatus {
		return bgRunWith(t, job.SessionID, map[string]interface{}{
			"command": command, "kind": "job", "wakeOnStall": stallAfter(afterSeconds),
		})
	}
	// Hangs at once, and the old image's wake for it is answered.
	woken := run("echo 'waiting for the lock'; exec sleep 300", 2)
	// Hangs at once too, and its wake goes to a control plane that never answers it before the re-exec.
	owedJob := run("echo 'waiting for the socket'; exec sleep 300", 2)
	owedID.Store(owedJob.JobID)
	// Writes until just before the re-exec, then hangs: its silence runs out only in the next image.
	const pendingAfter = 8
	pending := run(fmt.Sprintf(`while [ ! -e %s ]; do echo 'still copying'; sleep 0.2; done; `+
		`echo 'copy stalled'; exec sleep 300`, quiet), pendingAfter)

	awaitCondition(t, 30*time.Second, "the old image never woke the session for the job that hung", func() bool {
		return len(oldAPI.wakesFor(woken.JobID)) > 0 && owedRefusals.Load() > 0
	})
	// The answer is read by the runner a moment after the stub has kept the request.
	time.Sleep(500 * time.Millisecond)
	quietAt := time.Now()
	if err := os.WriteFile(quiet, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Second) // the job reads the file every tenth of a second, and prints its last line

	old.stop()
	old.awaitReturn(t, 2*time.Minute)
	if got := oldAPI.wakesFor(pending.JobID); len(got) != 0 {
		t.Fatalf("the old image reported a silence that had not run out before it handed the job on: %v", got)
	}
	// The exec, and the new image starting up, take a while: long enough that a silence counted from
	// the new image's start instead of the job's last output would be seconds short.
	time.Sleep(4 * time.Second)

	newAPI := newWakeControlPlane()
	newPool := newSessionPool(4)
	newPool.adoptRecordedJobs()
	// Stopped as a signal stops a runner, so the case's end ends its jobs rather than handing them on.
	superviseWakeImage(t, job, newPool, newAPI, http.HandlerFunc(newAPI.serve), context.Canceled)

	awaitCondition(t, 60*time.Second, "the silence that ran out after the re-exec was never reported", func() bool {
		return len(newAPI.wakesFor(pending.JobID)) > 0
	})
	realSilence := time.Since(quietAt)
	pendingWake := newAPI.wakesFor(pending.JobID)[0]
	if got, want := asString(pendingWake["wakeId"]), pending.JobID+":stall:1"; got != want {
		t.Errorf("the next image's stall wake id = %q, want %q", got, want)
	}
	// The job went quiet at quietAt; the old image saw its last line within its last read of the file.
	if idle := wakeMillis(t, pendingWake, "idleMs"); idle < (realSilence - 3500*time.Millisecond).Milliseconds() {
		t.Errorf("the next image reported %dms of silence for a job silent for %dms: it counted from the re-exec",
			idle, realSilence.Milliseconds())
	}

	awaitCondition(t, 30*time.Second, "the stall wake the old image never had answered was never sent again", func() bool {
		return len(newAPI.wakesFor(owedJob.JobID)) > 0
	})
	// Three times the answered job's silence, for a repeat to show up in.
	time.Sleep(6 * time.Second)

	if got := append(oldAPI.wakesFor(woken.JobID), newAPI.wakesFor(woken.JobID)...); len(got) != 1 {
		t.Errorf("stall wakes for the silence the old image's wake was answered for = %d across both images, want one: %v", len(got), got)
	}
	if got := newAPI.wakesFor(owedJob.JobID); len(got) != 1 || asString(got[0]["wakeId"]) != owedJob.JobID+":stall:1" {
		t.Errorf("the owed stall wake as the next image sent it = %v, want exactly one, %s:stall:1", got, owedJob.JobID)
	}
	if got := oldAPI.wakesFor(owedJob.JobID); len(got) != 0 {
		t.Errorf("the old control plane kept a wake it refused: %v", got)
	}
	if got := append(oldAPI.wakesFor(pending.JobID), newAPI.wakesFor(pending.JobID)...); len(got) != 1 {
		t.Errorf("stall wakes for the silence that straddled the re-exec = %d, want one: %v", len(got), got)
	}
}

// The tail an adopting image starts reads the file from the top, and finds there everything the job
// wrote before the re-exec. That is not output written now: a job silent for ten minutes before the
// self-update is silent for ten minutes after it, and only the file growing past what was seen moves
// its last output on.
func TestATailThatStartsOverDoesNotTakeWhatIsThereForNewOutput(t *testing.T) {
	outputPath := filepath.Join(t.TempDir(), "bgj_restarted.output")
	if err := os.WriteFile(outputPath, []byte("compiling 1/9\ncompiling 2/9\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var snapshots atomic.Int32
	bg := newBgTailer(context.Background(), func(eventType string, payload map[string]interface{}) {
		if eventType == evBackgroundOutput {
			snapshots.Add(1)
		}
	}, nil)
	// Not stopAll, which would drain the job here — a record of one, with no process to drain.
	defer bg.cancel()

	silentSince := time.Now().Add(-10 * time.Minute)
	job := &bgJob{
		id: "bgj_restarted", kind: bgKindJob, command: "make", outputPath: outputPath,
		status: bgStatusRunning, startedAt: silentSince.Add(-time.Hour),
		lastOutputAt: silentSince, outputSeen: outputSizeOf(outputPath),
	}
	bg.mu.Lock()
	bg.jobs[job.id] = job
	bg.mu.Unlock()
	lastOutput := func() time.Time {
		bg.mu.Lock()
		defer bg.mu.Unlock()
		return job.lastOutputAt
	}

	bg.startTail(job.id, job.id, outputPath, false)
	awaitCondition(t, 15*time.Second, "the tail never read the file", func() bool { return snapshots.Load() > 0 })
	if got := lastOutput(); !got.Equal(silentSince) {
		t.Errorf("the tail's first read moved the job's last output from %s to %s", silentSince, got)
	}

	// The paired positive: the job writes, and that is output.
	f, err := os.OpenFile(outputPath, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString("compiling 3/9\n")
	f.Close()
	awaitCondition(t, 15*time.Second, "the job wrote and its last output never moved", func() bool {
		return lastOutput().After(silentSince)
	})
}
