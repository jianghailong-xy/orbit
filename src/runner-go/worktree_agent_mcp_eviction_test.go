//go:build linux || darwin

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Merge and commit run beside whatever else is running in the session's checkout, and stop none
// of it (owner, 2026-09-12). What the two operations touch is why that is safe: a merge replays
// the branch's commits in a scratch worktree of its own (rebaseFastForward) and never touches the
// checkout, and a commit writes only the index and refs. So a live background job does not hold
// either of them up, and a parked engine — MCP servers the agent configured itself and all — is
// not evicted for them.
//
// The assertions that carry this are about real processes (signal 0), read as the operation
// itself begins and again once it is over, and each is paired with the same probe seeing the
// process go when it really does. A test that read only the pool's bookkeeping could not tell a
// process that is still running from one the pool merely still counts.

// agentMcpEngine is one parked session whose engine is a real process tree standing in its
// checkout: the engine and, as its children, one stand-in for each MCP server it was spawned
// with — Orbit's own, which every engine gets, and each of the agent's.
type agentMcpEngine struct {
	pool     *sessionPool
	live     *liveSession
	bg       *bgTailer
	events   *bgJobEvents
	id       string
	branch   string
	repo     string         // the repository root, on main
	checkout string         // worktreesDir()/<session>, on branch
	scratch  string         // runner-owned files: pid files, job output
	pid      int            // the engine
	servers  map[string]int // MCP server name → pid
	stopped  chan struct{}  // closed once the supervisor has handed the residency back
}

// newAgentMcpEngine lays the session out the way the runner does — a repository root on
// main, the session's branch checked out under worktreesDir() — runs its engine through
// one turn, and parks it.
func newAgentMcpEngine(t *testing.T, id string, mcpConfig map[string]interface{}) *agentMcpEngine {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	branch := "orbit/" + id
	checkout := filepath.Join(worktreesDir(), id)
	mustGit(t, repo, "worktree", "add", "-b", branch, checkout)
	commitFile(t, checkout, "work.txt", "the session's work\n", "session work")

	pool := newSessionPool(1)
	job := manualWorktreePoolJob(id, branch)
	job.WT.Path = checkout
	job.Agent.McpConfig = mcpConfig
	live, added := pool.register(job, func() {}, true)
	if !added {
		t.Fatal("failed to register the active session")
	}
	generation, _, ok := pool.reserveEngine(live, context.Background(), context.Background())
	if !ok {
		t.Fatal("failed to make the engine resident")
	}
	events := &bgJobEvents{}
	bg := newBgTailer(context.Background(), events.emit, pool.worktreeHoldsFor(id))

	// Which servers the engine runs is the fixture's own record, never anything the code
	// under test computed: Orbit's, which every spawn adds, and each key of the agent's.
	names := []string{"orbit"}
	for name := range mcpConfig {
		if name != "orbit" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	scratch := t.TempDir()
	var script strings.Builder
	for i := range names {
		fmt.Fprintf(&script, "sleep 120 & echo $! > %q; ", filepath.Join(scratch, "server-"+strconv.Itoa(i)+".pid"))
	}
	script.WriteString("exec sleep 120")
	engineCtx, engineCancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(engineCtx, "sh", "-c", script.String())
	configureSessionProcessTree(cmd)
	cmd.Dir = checkout
	if err := cmd.Start(); err != nil {
		engineCancel()
		t.Fatalf("starting the engine failed: %v", err)
	}
	if pool.engineStarted(live, generation, engineCancel) {
		engineCancel()
	}
	stopped := make(chan struct{})
	go func() {
		// What session.go does once runSessionProcess returns: the engine's process tree
		// has been reaped (waitSessionProcessTree), its shells are reported, and only then
		// is the residency handed back.
		_ = waitSessionProcessTree(cmd)
		engineCancel()
		bg.killEngineShells()
		pool.engineStopped(live, generation)
		close(stopped)
	}()
	f := &agentMcpEngine{
		pool: pool, live: live, bg: bg, events: events, id: id, branch: branch, repo: repo,
		checkout: checkout, scratch: scratch, pid: cmd.Process.Pid,
		servers: map[string]int{}, stopped: stopped,
	}
	t.Cleanup(func() {
		engineCancel()
		select {
		case <-stopped:
		case <-time.After(10 * time.Second):
			t.Errorf("the engine's supervisor never handed the residency back")
		}
		for _, job := range bg.listJobs(false) {
			bg.killJob(job.JobID, bgKillTeardownGrace)
		}
		bg.stopAll()
		forgetMergeTarget(id)
		pool.finish(live)
	})
	for i, name := range names {
		f.servers[name] = readPIDFile(t, filepath.Join(scratch, "server-"+strconv.Itoa(i)+".pid"))
		if !processAlive(f.servers[name]) {
			t.Fatalf("the %s MCP server stand-in (pid %d) is not running", name, f.servers[name])
		}
	}
	parkPoolSession(pool, live)
	if pool.isActive(live) || !pool.engineResident(live) {
		t.Fatal("the session is not parked-warm: park kept the permit or dropped the engine")
	}
	return f
}

func readPIDFile(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if data, err := os.ReadFile(path); err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil && pid > 0 {
				return pid
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no pid was written to %s", path)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func processGoneWithin(pid int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for processAlive(pid) {
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(5 * time.Millisecond)
	}
	return true
}

// advertised is the snapshot the heartbeat delivering a merge or commit was built from.
func (f *agentMcpEngine) advertised() heartbeatSupervisorSnapshot {
	supervisors, _ := f.pool.heartbeatSnapshot()
	return supervisors[f.id]
}

func (f *agentMcpEngine) serverNames() []string {
	names := make([]string, 0, len(f.servers))
	for name := range f.servers {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// atOperation is the checkout's process tree as the operation itself began.
type atOperation struct {
	ran         bool
	engineAlive bool
	resident    bool
	liveServers []string
}

// sightWarm reads the engine and its servers as they are right now.
func (f *agentMcpEngine) sightWarm() atOperation {
	at := atOperation{ran: true, engineAlive: processAlive(f.pid), resident: f.pool.engineResident(f.live)}
	for _, name := range f.serverNames() {
		if processAlive(f.servers[name]) {
			at.liveServers = append(at.liveServers, name)
		}
	}
	return at
}

// assertStillWarm: the engine and every server it runs were alive, and the engine resident, as
// the operation ran — and all of them still are now that it is over.
func (f *agentMcpEngine) assertStillWarm(t *testing.T, operation string, at atOperation) {
	t.Helper()
	if !at.ran {
		t.Fatalf("the %s never ran", operation)
	}
	if !at.engineAlive || !at.resident {
		t.Fatalf("the %s ran without the engine (pid %d alive=%v resident=%v)",
			operation, f.pid, at.engineAlive, at.resident)
	}
	if len(at.liveServers) != len(f.servers) {
		t.Fatalf("MCP servers alive as the %s ran = %v, want all of %v", operation, at.liveServers, f.serverNames())
	}
	if !processAlive(f.pid) || !f.pool.engineResident(f.live) {
		t.Fatalf("the engine (pid %d) did not outlast the %s", f.pid, operation)
	}
	if now := f.sightWarm(); len(now.liveServers) != len(f.servers) {
		t.Fatalf("MCP servers alive after the %s = %v, want all of %v", operation, now.liveServers, f.serverNames())
	}
	select {
	case <-f.stopped:
		t.Fatalf("the engine's supervisor handed the residency back after the %s", operation)
	default:
	}
	if got := f.pool.warmCountLockedForTest(); got != 1 {
		t.Fatalf("warm engines after the %s = %d, want 1", operation, got)
	}
}

// assertRecyclingStopsIt is the paired positive of assertStillWarm. Recycled the way the warm
// TTL recycles it, the same engine and servers read as gone once the supervisor has reaped them,
// so a probe that answered "alive" for a zombie or a stale pid fails here instead of passing there.
func (f *agentMcpEngine) assertRecyclingStopsIt(t *testing.T) {
	t.Helper()
	f.pool.mu.Lock()
	cancel := f.pool.requestEvictLocked(f.live)
	f.pool.mu.Unlock()
	if cancel == nil {
		t.Fatal("the pool declined to recycle the parked engine")
	}
	cancel()
	select {
	case <-f.stopped:
	case <-time.After(30 * time.Second):
		t.Fatal("the recycled engine's supervisor never handed the residency back")
	}
	// The engine is this test's own child, reaped before the residency was handed back.
	if processAlive(f.pid) || f.pool.engineResident(f.live) {
		t.Fatalf("the recycled engine (pid %d) still reads as running", f.pid)
	}
	// Its servers were the engine's children, which leaves reaping them to init.
	for _, name := range f.serverNames() {
		if !processGoneWithin(f.servers[name], 5*time.Second) {
			t.Fatalf("the %s MCP server (pid %d) still reads as running after its engine was recycled",
				name, f.servers[name])
		}
	}
}

// startLiveJob starts a runner-hosted job in the checkout the way bg_run does, and checks that it
// is what an operation is meant to run beside: a real process, holding the checkout.
func (f *agentMcpEngine) startLiveJob(t *testing.T) bgJobStatus {
	t.Helper()
	job, err := f.bg.startJob(bgJobSpec{
		Command: "sleep 120", Kind: bgKindJob, Dir: f.checkout, ScratchDir: f.scratch, Description: "the agent's build",
	})
	if err != nil {
		t.Fatalf("starting the runner-hosted job failed: %v", err)
	}
	if !processAlive(job.PID) {
		t.Fatalf("the job %s reported pid %d, which is not running", job.JobID, job.PID)
	}
	// A job that held nothing would have nothing to hold an operation up with, and this would not
	// exercise running beside a writer at all.
	if !holdersInclude(f.pool.worktreeHolders(f.id), worktreeHeldByBackgroundJob, job.JobID) {
		t.Fatalf("the live job %s does not hold the checkout: %v", job.JobID, f.pool.worktreeHolders(f.id))
	}
	return job
}

// jobRunning: the process is there (signal 0), and the runner still has the job running.
func (f *agentMcpEngine) jobRunning(job bgJobStatus) bool {
	if !processAlive(job.PID) {
		return false
	}
	for _, listed := range f.bg.listJobs(false) {
		if listed.JobID == job.JobID {
			return listed.Status == bgStatusRunning
		}
	}
	return false
}

// assertJobOutlived: the job was running as the operation ran, and is still running — as a
// process, to the runner, with no terminal report, still holding the checkout — now that it is
// over. Then the paired positive: killed for real, the same probe reads it as gone. The terminal
// report comes after the runner's own Wait has reaped the process, so signal 0 cannot be answered
// by a zombie.
func (f *agentMcpEngine) assertJobOutlived(t *testing.T, operation string, job bgJobStatus, runningAsItRan bool) {
	t.Helper()
	if !runningAsItRan {
		t.Fatalf("the job %s was not running as the %s ran: nothing here ran beside a live job", job.JobID, operation)
	}
	if !f.jobRunning(job) {
		t.Fatalf("the runner-hosted job %s (pid %d) did not outlast the %s", job.JobID, job.PID, operation)
	}
	if terminal := f.events.terminalsFor(job.JobID); len(terminal) != 0 {
		t.Fatalf("the job %s was reported ended across the %s: %v", job.JobID, operation, terminal)
	}
	if !holdersInclude(f.pool.worktreeHolders(f.id), worktreeHeldByBackgroundJob, job.JobID) {
		t.Fatalf("the job %s stopped holding the checkout across the %s: %v", job.JobID, operation,
			f.pool.worktreeHolders(f.id))
	}

	if _, err := f.bg.killJob(job.JobID, bgKillTeardownGrace); err != nil {
		t.Fatalf("killing the job failed: %v", err)
	}
	f.events.awaitTerminal(t, job.JobID, 30*time.Second)
	if processAlive(job.PID) || f.jobRunning(job) {
		t.Fatalf("the killed job %s (pid %d) still reads as running, so the readings above prove nothing",
			job.JobID, job.PID)
	}
}

// withUncommittedWork leaves a change in the checkout for a commit to land, and a `claude`
// that declines to write its message, so commitWorktree takes its diffstat fallback
// without anything leaving the machine.
func (f *agentMcpEngine) withUncommittedWork(t *testing.T) string {
	t.Helper()
	if err := os.WriteFile(filepath.Join(f.checkout, "more.txt"), []byte("more work\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	writeFakeBin(t, bin, "claude", "exit 1")
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	return mustGit(t, f.checkout, "rev-parse", "HEAD")
}

// A merge takes only what the branch has committed, replayed in a scratch worktree, so a
// runner-hosted job still running in the checkout neither holds it up nor is stopped for it. The
// merge lands on the target, the job is still running once it is over, and the receipt names the
// job it ran beside.
func TestMergeProceedsBesideLiveBackgroundJob(t *testing.T) {
	f := newAgentMcpEngine(t, "jobmerge", nil)
	job := f.startLiveJob(t)
	runningAsItRan := false
	res := heartbeatMerge(f.pool, MergeCommand{SessionID: f.id, WorkDir: f.repo, Branch: f.branch}, f.advertised(),
		func(req MergeCommand) mergeOutcome {
			runningAsItRan = f.jobRunning(job)
			return mergeToMain(req)
		})
	if res.Status != "merged" {
		t.Fatalf("merge = %q (%s), want merged beside the live job %s", res.Status, res.Message, job.JobID)
	}
	if subjects := mustGit(t, f.repo, "log", "--format=%s", "main"); !strings.Contains(subjects, "session work") {
		t.Fatalf("main does not carry the session's commit after a merge that reported merged:\n%s", subjects)
	}
	if _, err := git(f.repo, "cat-file", "-e", "main:work.txt"); err != nil {
		t.Fatalf("main does not carry the session's work after a merge that reported merged: %v", err)
	}
	if !strings.Contains(res.Message, job.JobID) {
		t.Fatalf("the merge's receipt does not name the job %s it ran beside: %q", job.JobID, res.Message)
	}
	f.assertJobOutlived(t, "merge", job, runningAsItRan)
}

// The same for a commit, which writes only the index and refs: the branch advances with the
// checkout's work, the job is still running, and the receipt names it.
func TestCommitProceedsBesideLiveBackgroundJob(t *testing.T) {
	f := newAgentMcpEngine(t, "jobcommit", nil)
	before := f.withUncommittedWork(t)
	job := f.startLiveJob(t)
	runningAsItRan := false
	res := heartbeatCommit(f.pool, CommitCommand{SessionID: f.id, Branch: f.branch}, f.advertised(),
		func(req CommitCommand) commitOutcome {
			runningAsItRan = f.jobRunning(job)
			return commitWorktree(req)
		})
	if res.Status != "committed" {
		t.Fatalf("commit = %q (%s), want committed beside the live job %s", res.Status, res.Message, job.JobID)
	}
	if after := mustGit(t, f.repo, "rev-parse", "refs/heads/"+f.branch); after == before {
		t.Fatal("the branch did not advance after a commit that reported committed")
	}
	if _, err := git(f.repo, "cat-file", "-e", "refs/heads/"+f.branch+":more.txt"); err != nil {
		t.Fatalf("the branch does not carry the checkout's work after a commit that reported committed: %v", err)
	}
	if !strings.Contains(res.Message, job.JobID) {
		t.Fatalf("the commit's receipt does not name the job %s it ran beside: %q", job.JobID, res.Message)
	}
	f.assertJobOutlived(t, "commit", job, runningAsItRan)
}

// A parked engine running MCP servers the agent configured itself is not stopped for a merge or a
// commit either. The engine and every server are alive, and the engine resident, as the operation
// runs and after it — the zero-startup continuation survives the operation.
func TestMergeDoesNotEvictEngineWithAgentMcpServers(t *testing.T) {
	agentServers := func() map[string]interface{} {
		return map[string]interface{}{
			"agent-fs":      map[string]interface{}{"command": "agent-fs-mcp", "args": []interface{}{"--root", "."}},
			"agent-browser": map[string]interface{}{"command": "agent-browser-mcp"},
		}
	}

	t.Run("merge", func(t *testing.T) {
		f := newAgentMcpEngine(t, "mcpmerge", agentServers())
		var at atOperation
		res := heartbeatMerge(f.pool, MergeCommand{SessionID: f.id, WorkDir: f.repo, Branch: f.branch}, f.advertised(),
			func(req MergeCommand) mergeOutcome {
				at = f.sightWarm()
				return mergeToMain(req)
			})
		f.assertStillWarm(t, "merge", at)
		if res.Status != "merged" {
			t.Fatalf("merge = %q (%s), want merged", res.Status, res.Message)
		}
		if _, err := git(f.repo, "cat-file", "-e", "main:work.txt"); err != nil {
			t.Fatalf("main does not carry the session's work after a merge that reported merged: %v", err)
		}
		if res.Message != "" {
			t.Fatalf("a merge with no background job beside it carries a receipt note: %q", res.Message)
		}
		f.assertRecyclingStopsIt(t)
	})

	t.Run("commit", func(t *testing.T) {
		f := newAgentMcpEngine(t, "mcpcommit", agentServers())
		before := f.withUncommittedWork(t)
		var at atOperation
		res := heartbeatCommit(f.pool, CommitCommand{SessionID: f.id, Branch: f.branch}, f.advertised(),
			func(req CommitCommand) commitOutcome {
				at = f.sightWarm()
				return commitWorktree(req)
			})
		f.assertStillWarm(t, "commit", at)
		if res.Status != "committed" {
			t.Fatalf("commit = %q (%s), want committed", res.Status, res.Message)
		}
		if after := mustGit(t, f.checkout, "rev-parse", "HEAD"); after == before {
			t.Fatal("the branch did not advance after a commit that reported committed")
		}
		if res.Message != "" {
			t.Fatalf("a commit with no background job beside it carries a receipt note: %q", res.Message)
		}
		f.assertRecyclingStopsIt(t)
	})
}
