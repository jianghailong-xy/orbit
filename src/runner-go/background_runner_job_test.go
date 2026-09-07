//go:build linux || darwin

package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// Stage 2: an agent's background job is spawned and owned by the runner, so the
// things that end it are its own exit, the end of the session, and an explicit
// kill. Recycling the engine — the warm TTL, or LRU pressure on the resident
// count — is not one of them, and every assertion here is about a real child
// process (signal 0), not about a bool the runner keeps concerning one. The bug
// this replaces is exactly a process that died while the runner still believed
// it was running, so a test that only reads the runner's belief cannot see it.

// bgJobEvents collects background_task payloads. The tailer emits them from the
// goroutine that waits on the process, so the collector takes a lock.
type bgJobEvents struct {
	mu   sync.Mutex
	seen []map[string]interface{}
}

func (e *bgJobEvents) emit(eventType string, payload map[string]interface{}) {
	if eventType != evBackgroundTask {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	copied := map[string]interface{}{}
	for k, v := range payload {
		copied[k] = v
	}
	e.seen = append(e.seen, copied)
}

func (e *bgJobEvents) withStatus(status string) []map[string]interface{} {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []map[string]interface{}
	for _, p := range e.seen {
		if asString(p["status"]) == status {
			out = append(out, p)
		}
	}
	return out
}

func (e *bgJobEvents) forJob(jobID string) []map[string]interface{} {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []map[string]interface{}
	for _, p := range e.seen {
		if asString(p["toolUseId"]) == jobID {
			out = append(out, p)
		}
	}
	return out
}

// awaitTerminal waits for the job's own terminal report — the event the runner
// writes after its Wait returns.
func (e *bgJobEvents) awaitTerminal(t *testing.T, jobID string, timeout time.Duration) map[string]interface{} {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		for _, p := range e.forJob(jobID) {
			if isTerminalBgStatus(asString(p["status"])) {
				return p
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no terminal background_task for %s within %s", jobID, timeout)
	return nil
}

// processAlive asks the kernel, with signal 0, whether that pid is still there.
func processAlive(pid int) bool {
	return pid > 0 && syscall.Kill(pid, 0) == nil
}

func waitProcessGone(t *testing.T, pid int, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !processAlive(pid) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("pid %d is still alive after %s", pid, timeout)
}

// evictionHarness is one session wired the way runInteractiveSession wires it:
// a tailer on the session context (not the engine's), the pool holding the
// engine's cancel, and the pool's only view of background work being the
// engine-shell probe. Eviction here is the real pool path, not a stand-in.
type evictionHarness struct {
	t         *testing.T
	pool      *sessionPool
	clock     *fakePoolClock
	live      *liveSession
	bg        *bgTailer
	events    *bgJobEvents
	id        string
	dir       string
	engineCtx context.Context
	engineGen uint64
}

func newEvictionHarness(t *testing.T, id string, max int) *evictionHarness {
	t.Helper()
	clock := newFakePoolClock()
	pool := newSessionPoolWithClock(max, clock)
	live := registerPoolSession(t, pool, id, true)
	sessionCtx, cancelSession := context.WithCancel(context.Background())
	events := &bgJobEvents{}
	bg := newBgTailer(sessionCtx, events.emit, pool.worktreeHoldsFor(id))
	// Exactly what session.go lends the pool: a look at the engine's own shells.
	// A runner-hosted job is deliberately not in it — it must not buy the engine
	// more residency, because making eviction lossless is the whole point.
	pool.setBackgroundJobProbe(live, bg.hasLiveEngineShells)
	h := &evictionHarness{
		t: t, pool: pool, clock: clock, live: live, bg: bg,
		events: events, id: id, dir: t.TempDir(),
	}
	t.Cleanup(func() {
		// Explicit kill — one of the three ends a job has — rather than leaving the
		// teardown drain to spend its whole budget waiting for a `sleep` that was
		// only ever there to still be running at the end of the test.
		for _, job := range bg.listJobs(false) {
			bg.killJob(job.JobID, bgKillTeardownGrace)
		}
		bg.stopAll()
		cancelSession()
	})
	return h
}

// startEngine makes the engine resident and hands the pool the cancel that
// eviction pulls — the engine's own context, and nothing wider.
func (h *evictionHarness) startEngine() {
	h.t.Helper()
	gen, _, ok := h.pool.reserveEngine(h.live, context.Background(), context.Background())
	if !ok {
		h.t.Fatal("engine was not reserved")
	}
	ctx, cancel := context.WithCancel(context.Background())
	h.engineCtx, h.engineGen = ctx, gen
	if immediate := h.pool.engineStarted(h.live, gen, cancel); immediate {
		cancel()
	}
}

func (h *evictionHarness) park() {
	h.t.Helper()
	parkPoolSession(h.pool, h.live)
	if h.pool.isActive(h.live) {
		h.t.Fatal("park did not hand back the turn permit")
	}
}

// afterEngineStopped replays what the supervisor does once its engine process is
// gone: report the shells that died with it, and hand the residency back.
func (h *evictionHarness) afterEngineStopped() {
	h.t.Helper()
	select {
	case <-h.engineCtx.Done():
	case <-time.After(5 * time.Second):
		h.t.Fatal("the engine was never evicted — this run does not exercise eviction at all")
	}
	h.bg.killEngineShells()
	h.pool.engineStopped(h.live, h.engineGen)
}

func (h *evictionHarness) startJob(command, kind string) bgJobStatus {
	h.t.Helper()
	status, err := h.bg.startJob(bgJobSpec{
		Command:     command,
		Kind:        kind,
		Dir:         h.dir,
		ScratchDir:  h.dir,
		Description: "test " + kind,
	})
	if err != nil {
		h.t.Fatalf("starting a %s failed: %v", kind, err)
	}
	if !processAlive(status.PID) {
		h.t.Fatalf("%s reported pid %d, which is not running", status.JobID, status.PID)
	}
	return status
}

func (h *evictionHarness) holdsWorktree(jobID string) bool {
	return holdersInclude(h.pool.worktreeHolders(h.id), worktreeHeldByBackgroundJob, jobID)
}

func (h *evictionHarness) jobCount() int {
	return h.pool.backgroundJobCounts()[h.id]
}

// The warm TTL is a memory decision. It was also, silently, a correctness one:
// the agent's build was a child of the engine it recycled.
func TestRunnerOwnedJobSurvivesWarmTTLExpiry(t *testing.T) {
	h := newEvictionHarness(t, "warmttl", 1)
	h.startEngine()
	job := h.startJob("sleep 30", bgKindJob)

	// Registered as a writer of the checkout before anything else happens: a job
	// that outlives the engine but leaves merge unfenced is worse than the bug.
	if !h.holdsWorktree(job.JobID) {
		t.Fatalf("a live runner-hosted job is not in the worktree holder set: %v",
			h.pool.worktreeHolders(h.id))
	}
	if got := h.jobCount(); got != 1 {
		t.Fatalf("pool-visible live job count = %d, want 1", got)
	}

	h.park()
	h.clock.Advance(warmEngineTTL + time.Second)
	h.afterEngineStopped()

	if !processAlive(job.PID) {
		t.Fatalf("job %s (pid %d) died with the engine recycled at the warm TTL", job.JobID, job.PID)
	}
	if killed := h.events.withStatus("killed"); len(killed) != 0 {
		t.Fatalf("engine eviction reported the job killed: %v", killed)
	}
	if !h.holdsWorktree(job.JobID) {
		t.Fatalf("the surviving job stopped holding the checkout when its engine went away: %v",
			h.pool.worktreeHolders(h.id))
	}
}

// Same property under the other eviction path: an incoming active session cutting
// idle warm capacity, which is where 17 of the 97 recorded kills came from.
func TestRunnerOwnedJobSurvivesLRUEviction(t *testing.T) {
	h := newEvictionHarness(t, "lru", 1)
	h.startEngine()
	job := h.startJob("sleep 30", bgKindJob)
	h.park()

	// One cold active claim: allowed warm capacity drops to zero, and this parked
	// engine is the only victim available. evictWarmExcessLocked runs inside it.
	registerPoolSession(t, h.pool, "claimant", true)
	h.afterEngineStopped()

	if !processAlive(job.PID) {
		t.Fatalf("job %s (pid %d) died with the engine LRU-evicted under capacity pressure",
			job.JobID, job.PID)
	}
	if killed := h.events.withStatus("killed"); len(killed) != 0 {
		t.Fatalf("LRU eviction reported the job killed: %v", killed)
	}
	if !h.holdsWorktree(job.JobID) {
		t.Fatalf("the surviving job stopped holding the checkout: %v", h.pool.worktreeHolders(h.id))
	}
}

// The exit code has to be the process's own. Today an agent shell's completion is
// read out of the <task-notification> text Claude writes, which does not exist for
// a job the engine never launched — and would be a second, disagreeing authority
// if it did. The runner waits on its own child, so it simply knows.
func TestRunnerOwnedJobExitCodeFromWait(t *testing.T) {
	h := newEvictionHarness(t, "exitcode", 1)
	h.startEngine()
	job := h.startJob("exit 7", bgKindJob)

	event := h.events.awaitTerminal(t, job.JobID, 15*time.Second)
	if got := asString(event["status"]); got != "failed" {
		t.Fatalf("status = %q, want failed for a non-zero exit", got)
	}
	exit, ok := event["exitCode"].(int)
	if !ok {
		t.Fatalf("exitCode = %#v, want the integer the runner's Wait returned", event["exitCode"])
	}
	if exit != 7 {
		t.Fatalf("exitCode = %d, want 7", exit)
	}
	// Nothing parsed this: no <task-notification> was ever fed to the tailer. And
	// one arriving late cannot relitigate it — the first terminal report wins, so
	// the number stays the one the kernel gave us.
	bgTaskFromNotification(taskNotif(job.JobID, job.JobID, "completed"), h.events.emit, h.bg)
	terminals := 0
	for _, p := range h.events.forJob(job.JobID) {
		if isTerminalBgStatus(asString(p["status"])) {
			terminals++
		}
	}
	if terminals != 1 {
		t.Fatalf("terminal reports for %s = %d, want exactly the one from Wait: %v",
			job.JobID, terminals, h.events.forJob(job.JobID))
	}
	waitProcessGone(t, job.PID, 5*time.Second)
	if h.holdsWorktree(job.JobID) {
		t.Fatalf("a finished job still holds the checkout: %v", h.pool.worktreeHolders(h.id))
	}
	if got := h.jobCount(); got != 0 {
		t.Fatalf("pool-visible live job count after the job exited = %d, want 0", got)
	}
}

// The control that keeps the two negatives above from being tautologies. Same
// harness, same eviction, but the shell is the engine's child the way an agent's
// Bash(run_in_background) is today: it does die, and it does report killed. A
// harness that could not observe either would pass those tests while proving
// nothing.
func TestEngineOwnedBackgroundShellStillDiesWithItsEngine(t *testing.T) {
	h := newEvictionHarness(t, "engineowned", 1)
	h.startEngine()

	cmd := exec.CommandContext(h.engineCtx, "bash", "-lc", "sleep 30")
	configureSessionProcessTree(cmd)
	cmd.Dir = h.dir
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting the engine-owned shell failed: %v", err)
	}
	pid := cmd.Process.Pid
	// Reap it, so signal 0 stops answering for a zombie.
	go func() { _ = waitSessionProcessTree(cmd) }()
	output := filepath.Join(h.dir, "bei1.output")
	if err := os.WriteFile(output, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	h.bg.onToolResult("toolu_A", "Command running in background with ID: bei1. Output is being"+
		" written to: "+output+". You will be notified when it completes.")

	h.park()
	// A live engine shell renews the warm TTL (the stage-0 deferral), so the clock
	// has to walk past the residency hard cap for eviction to happen at all.
	h.clock.Advance(warmResidencyHardCap + time.Second)
	h.afterEngineStopped()

	waitProcessGone(t, pid, 5*time.Second)
	if killed := h.events.withStatus("killed"); len(killed) != 1 {
		t.Fatalf("engine-owned shell killed events = %v, want exactly one", killed)
	}
	if h.holdsWorktree("toolu_A") {
		t.Fatalf("a shell that died with its engine still holds the checkout: %v",
			h.pool.worktreeHolders(h.id))
	}
}

// Services and jobs are not the same thing to a drain. A watcher is worth
// restarting and costs nothing to lose; a build is worth waiting for and costs
// hours. The runner is told which by the caller — inferring it from the command
// line is how a six-hour build gets classified as a dev server.
func TestDrainKillsServicesAndWaitsForJobs(t *testing.T) {
	h := newEvictionHarness(t, "drain", 1)
	h.startEngine()
	service := h.startJob("sleep 30", bgKindService)
	job := h.startJob("sleep 0.4; exit 3", bgKindJob)

	h.bg.drainJobs(10 * time.Second)

	waitProcessGone(t, service.PID, 5*time.Second)
	serviceEvents := h.events.forJob(service.JobID)
	if len(serviceEvents) != 1 || asString(serviceEvents[0]["status"]) != "killed" {
		t.Fatalf("service drain reports = %v, want one killed", serviceEvents)
	}
	// The job was allowed to finish, so its exit code is real rather than invented.
	jobEvent := h.events.awaitTerminal(t, job.JobID, 5*time.Second)
	if got := asString(jobEvent["status"]); got != "failed" {
		t.Fatalf("drained job status = %q, want the failed it exited with", got)
	}
	if exit, _ := jobEvent["exitCode"].(int); exit != 3 {
		t.Fatalf("drained job exitCode = %#v, want 3", jobEvent["exitCode"])
	}
	if got := h.jobCount(); got != 0 {
		t.Fatalf("live job count after the drain = %d, want 0", got)
	}
}

// A drain cannot wait forever: session teardown removes the checkout the job is
// writing. Past the budget the job is killed like anything else — but it is
// reported as killed, never as a completion nobody witnessed.
func TestDrainKillsAJobThatOutlastsItsBudget(t *testing.T) {
	h := newEvictionHarness(t, "drainbudget", 1)
	h.startEngine()
	job := h.startJob("sleep 30", bgKindJob)

	h.bg.drainJobs(200 * time.Millisecond)

	waitProcessGone(t, job.PID, 5*time.Second)
	events := h.events.forJob(job.JobID)
	if len(events) != 1 || asString(events[0]["status"]) != "killed" {
		t.Fatalf("over-budget drain reports = %v, want one killed", events)
	}
	if got := asString(events[0]["reason"]); got != bgDrainCapReason {
		t.Fatalf("killed reason = %q, want %q so the user can tell this from a crash", got, bgDrainCapReason)
	}
}

// An explicit kill is one of the three things allowed to end a job, and it has to
// answer honestly about a job that had already finished on its own.
func TestKillJobEndsItAndReleasesTheCheckout(t *testing.T) {
	h := newEvictionHarness(t, "killjob", 1)
	h.startEngine()
	job := h.startJob("sleep 30", bgKindJob)

	status, err := h.bg.killJob(job.JobID, 5*time.Second)
	if err != nil {
		t.Fatalf("killJob failed: %v", err)
	}
	if status.Status != "killed" {
		t.Fatalf("killJob status = %q, want killed", status.Status)
	}
	waitProcessGone(t, job.PID, 5*time.Second)
	if h.holdsWorktree(job.JobID) {
		t.Fatalf("a killed job still holds the checkout: %v", h.pool.worktreeHolders(h.id))
	}
	if got := h.jobCount(); got != 0 {
		t.Fatalf("live job count after an explicit kill = %d, want 0", got)
	}
	if _, err := h.bg.killJob("bgj_nosuchjob", time.Second); err == nil {
		t.Fatal("killing a job that does not exist reported success")
	}
}

// The output file belongs to the runner, so reading it does not depend on the
// engine being up — which is the state a job that outlived its engine is in.
func TestJobOutputIsReadableAfterTheEngineIsGone(t *testing.T) {
	h := newEvictionHarness(t, "output", 1)
	h.startEngine()
	job := h.startJob("echo hello-from-the-job; exit 0", bgKindJob)
	h.events.awaitTerminal(t, job.JobID, 15*time.Second)

	out, err := h.bg.jobOutput(job.JobID, 0, 0)
	if err != nil {
		t.Fatalf("jobOutput failed: %v", err)
	}
	if !strings.Contains(out.Output, "hello-from-the-job") {
		t.Fatalf("job output = %q, want the command's stdout", out.Output)
	}
	if out.Status != "completed" || out.ExitCode == nil || *out.ExitCode != 0 {
		t.Fatalf("job output status/exit = %q/%v, want completed/0", out.Status, out.ExitCode)
	}
	// listJobs is what the agent reads to find the jobs it left running.
	if live := h.bg.listJobs(false); len(live) != 0 {
		t.Fatalf("live jobs after the only one finished = %v, want none", live)
	}
	all := h.bg.listJobs(true)
	if len(all) != 1 || all[0].JobID != job.JobID {
		t.Fatalf("listJobs(includeFinished) = %v, want the finished job", all)
	}
}
