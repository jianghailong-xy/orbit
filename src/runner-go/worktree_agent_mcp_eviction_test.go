//go:build linux || darwin

package main

import (
	"context"
	"encoding/json"
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

// C2's MCP gap. The worktree fence counts a parked engine as a holder only while a turn
// runs or one of its shells is alive, because the engine and Orbit's own MCP server write
// nothing between turns. An MCP server the agent configured itself is a process of that
// same parked engine, standing in the same checkout, and nothing constrains what it
// writes. Merge and commit therefore evict such an engine — servers and all — before they
// touch the checkout, and say so in their receipt.
//
// The assertions that carry this are about real processes (signal 0), taken at the one
// moment the change is about: when the operation itself begins. A test that read only
// the pool's bookkeeping could not tell an engine that was reaped from one that was
// merely asked to go.

// agentMcpEngine is one parked session whose engine is a real process tree standing in
// its checkout: the engine and, as its children, one stand-in for each MCP server it was
// spawned with — Orbit's own, which every engine gets, and each of the agent's.
type agentMcpEngine struct {
	pool     *sessionPool
	live     *liveSession
	bg       *bgTailer
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
		pool: pool, live: live, bg: bg, id: id, branch: branch, repo: repo,
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

// sightEvicted looks as an evicted engine should look. The engine is this test's own
// child, reaped by its supervisor before the residency was handed back, so signal 0 has
// to fail at once. Its servers were the engine's children, which leaves reaping them to
// init: each gets a bounded moment to go before it is counted alive.
func (f *agentMcpEngine) sightEvicted() atOperation {
	at := atOperation{ran: true, engineAlive: processAlive(f.pid), resident: f.pool.engineResident(f.live)}
	for _, name := range f.serverNames() {
		gone := !processAlive(f.servers[name])
		if !gone && !at.engineAlive {
			gone = processGoneWithin(f.servers[name], 2*time.Second)
		}
		if !gone {
			at.liveServers = append(at.liveServers, name)
		}
	}
	return at
}

// sightWarm looks as a kept engine should look: every process still there, right now.
func (f *agentMcpEngine) sightWarm() atOperation {
	at := atOperation{ran: true, engineAlive: processAlive(f.pid), resident: f.pool.engineResident(f.live)}
	for _, name := range f.serverNames() {
		if processAlive(f.servers[name]) {
			at.liveServers = append(at.liveServers, name)
		}
	}
	return at
}

func (f *agentMcpEngine) assertEvictedBefore(t *testing.T, operation string, at atOperation) {
	t.Helper()
	if !at.ran {
		t.Fatalf("the %s never ran", operation)
	}
	if at.engineAlive {
		t.Fatalf("the %s ran while the engine (pid %d) was still alive", operation, f.pid)
	}
	if at.resident {
		t.Fatalf("the %s ran while the pool still counted the engine resident", operation)
	}
	if len(at.liveServers) != 0 {
		t.Fatalf("the %s ran beside live MCP server processes %v", operation, at.liveServers)
	}
}

func (f *agentMcpEngine) assertStillWarm(t *testing.T, operation string, at atOperation) {
	t.Helper()
	if !at.ran {
		t.Fatalf("the %s never ran", operation)
	}
	if !at.engineAlive || !at.resident {
		t.Fatalf("the %s ran without the engine, which runs only Orbit's MCP server (alive=%v resident=%v)",
			operation, at.engineAlive, at.resident)
	}
	if len(at.liveServers) != len(f.servers) {
		t.Fatalf("MCP servers alive as the %s ran = %v, want all of %v", operation, at.liveServers, f.serverNames())
	}
	if !processAlive(f.pid) || !f.pool.engineResident(f.live) {
		t.Fatalf("the engine did not outlast the %s", operation)
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

// assertEvictionReceipt: what was done to the session, and the servers that were why.
func assertEvictionReceipt(t *testing.T, operation, message string, servers ...string) {
	t.Helper()
	for _, want := range append([]string{"evicted", "MCP"}, servers...) {
		if !strings.Contains(message, want) {
			t.Fatalf("the %s's receipt does not say the engine was evicted for the agent's MCP servers %v"+
				" (missing %q): %q", operation, servers, want, message)
		}
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

// Criteria 1 and 3. A parked-warm engine running MCP servers the agent configured itself
// is gone — process tree and all, reaped — before the merge or commit touches the
// checkout. The operation then completes as it always did, and its receipt says why the
// engine went.
func TestMergeEvictsParkedEngineWithAgentMcpServers(t *testing.T) {
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
				at = f.sightEvicted()
				return mergeToMain(req)
			})
		f.assertEvictedBefore(t, "merge", at)
		if res.Status != "merged" {
			t.Fatalf("merge = %q (%s), want merged", res.Status, res.Message)
		}
		if _, err := git(f.repo, "cat-file", "-e", "main:work.txt"); err != nil {
			t.Fatalf("main does not carry the session's work after a merge that reported merged: %v", err)
		}
		assertEvictionReceipt(t, "merge", res.Message, "agent-browser", "agent-fs")
	})

	t.Run("commit", func(t *testing.T) {
		f := newAgentMcpEngine(t, "mcpcommit", agentServers())
		before := f.withUncommittedWork(t)
		var at atOperation
		res := heartbeatCommit(f.pool, CommitCommand{SessionID: f.id, Branch: f.branch}, f.advertised(),
			func(req CommitCommand) commitOutcome {
				at = f.sightEvicted()
				return commitWorktree(req)
			})
		f.assertEvictedBefore(t, "commit", at)
		if res.Status != "committed" {
			t.Fatalf("commit = %q (%s), want committed", res.Status, res.Message)
		}
		if after := mustGit(t, f.checkout, "rev-parse", "HEAD"); after == before {
			t.Fatal("the branch did not advance after a commit that reported committed")
		}
		assertEvictionReceipt(t, "commit", res.Message, "agent-browser", "agent-fs")
	})
}

// Criterion 2, the paired positive that keeps criterion 1 from being "evict everything".
// An engine whose only MCP server is Orbit's own writes nothing between turns, so the
// merge or commit runs with it still warm and the zero-startup continuation survives.
func TestMergeKeepsWarmEngineWithOnlyOrbitMcp(t *testing.T) {
	onlyOrbit := func() map[string]interface{} {
		// Orbit's name in the agent's own configuration is exactly what every spawn
		// overwrites with the built-in server, so this engine runs nothing of the agent's.
		return map[string]interface{}{
			"orbit": map[string]interface{}{"command": "orbit", "args": []interface{}{"mcp"}},
		}
	}

	t.Run("merge", func(t *testing.T) {
		f := newAgentMcpEngine(t, "orbitmerge", onlyOrbit())
		var at atOperation
		res := heartbeatMerge(f.pool, MergeCommand{SessionID: f.id, WorkDir: f.repo, Branch: f.branch}, f.advertised(),
			func(req MergeCommand) mergeOutcome {
				at = f.sightWarm()
				return mergeToMain(req)
			})
		if res.Status != "merged" {
			t.Fatalf("merge = %q (%s), want merged", res.Status, res.Message)
		}
		if res.Message != "" {
			t.Fatalf("a merge that evicted nothing carries a receipt note: %q", res.Message)
		}
		f.assertStillWarm(t, "merge", at)
	})

	t.Run("commit", func(t *testing.T) {
		f := newAgentMcpEngine(t, "orbitcommit", onlyOrbit())
		before := f.withUncommittedWork(t)
		var at atOperation
		res := heartbeatCommit(f.pool, CommitCommand{SessionID: f.id, Branch: f.branch}, f.advertised(),
			func(req CommitCommand) commitOutcome {
				at = f.sightWarm()
				return commitWorktree(req)
			})
		if res.Status != "committed" {
			t.Fatalf("commit = %q (%s), want committed", res.Status, res.Message)
		}
		if after := mustGit(t, f.checkout, "rev-parse", "HEAD"); after == before {
			t.Fatal("the branch did not advance after a commit that reported committed")
		}
		if res.Message != "" {
			t.Fatalf("a commit that evicted nothing carries a receipt note: %q", res.Message)
		}
		f.assertStillWarm(t, "commit", at)
	})
}

// Criterion 4. A live runner-hosted job still holds the checkout on its own account: the
// merge is refused naming it, exactly as before this change, and nothing is evicted for
// an operation that does not run. The job is not touched.
func TestMergeStaysFencedByARunnerHostedJobOnAnAgentMcpEngine(t *testing.T) {
	f := newAgentMcpEngine(t, "mcpjob", map[string]interface{}{
		"agent-fs": map[string]interface{}{"command": "agent-fs-mcp"},
	})
	job, err := f.bg.startJob(bgJobSpec{
		Command: "sleep 120", Kind: bgKindJob, Dir: f.checkout, ScratchDir: f.scratch, Description: "the agent's build",
	})
	if err != nil {
		t.Fatalf("starting the runner-hosted job failed: %v", err)
	}
	merge := MergeCommand{SessionID: f.id, WorkDir: f.repo, Branch: f.branch}
	ran := false
	res := heartbeatMerge(f.pool, merge, f.advertised(), func(req MergeCommand) mergeOutcome {
		ran = true
		return mergeToMain(req)
	})
	if ran {
		t.Fatal("the merge ran against a checkout a runner-hosted job is still writing")
	}
	if res.Status != "error" || !strings.Contains(res.Message, job.JobID) {
		t.Fatalf("merge = %q (%q), want a refusal naming the job %s that holds the checkout",
			res.Status, res.Message, job.JobID)
	}
	if strings.Contains(res.Message, "superseded") || strings.Contains(res.Message, "evicted") {
		t.Fatalf("the refusal gives the wrong reason: %q", res.Message)
	}
	if !processAlive(f.pid) || !f.pool.engineResident(f.live) {
		t.Fatal("the engine was evicted for a merge that was refused")
	}
	for _, name := range f.serverNames() {
		if !processAlive(f.servers[name]) {
			t.Fatalf("the %s MCP server died for a merge that was refused", name)
		}
	}
	if !processAlive(job.PID) {
		t.Fatalf("the runner-hosted job (pid %d) died", job.PID)
	}

	// The paired positive: the refusal was the job's. Once it is gone, the same merge
	// evicts the engine and runs.
	if _, err := f.bg.killJob(job.JobID, bgKillTeardownGrace); err != nil {
		t.Fatalf("killing the job failed: %v", err)
	}
	var at atOperation
	res = heartbeatMerge(f.pool, merge, f.advertised(), func(req MergeCommand) mergeOutcome {
		at = f.sightEvicted()
		return mergeToMain(req)
	})
	f.assertEvictedBefore(t, "merge", at)
	if res.Status != "merged" {
		t.Fatalf("merge after the job ended = %q (%s), want merged", res.Status, res.Message)
	}
	assertEvictionReceipt(t, "merge", res.Message, "agent-fs")
}

func agentMcpPoolSession(t *testing.T, p *sessionPool, id string, mcpConfig map[string]interface{}) *liveSession {
	t.Helper()
	job := manualWorktreePoolJob(id, "orbit/"+id)
	job.Agent.McpConfig = mcpConfig
	live, added := p.register(job, func() {}, true)
	if !added {
		t.Fatalf("session %s was not registered", id)
	}
	return live
}

func drainedMerge(p *sessionPool, id string, wait time.Duration) (func(), string, bool) {
	supervisors, _ := p.heartbeatSnapshot()
	snapshot := supervisors[id]
	return p.beginDrainedWorktreeOperation(id, snapshot.supervisor, snapshot.permitGeneration, false, "merge", wait)
}

// An engine that was asked to go and has not been reaped may still be running the servers
// it was evicted for. The operation is refused rather than run beside it — and the refusal
// hands the gate back, so the same merge is admitted once the engine has stopped.
func TestDrainedMergeRefusedWhileTheEvictedEngineHasNotStopped(t *testing.T) {
	p := newSessionPool(1)
	live := agentMcpPoolSession(t, p, "stuck", map[string]interface{}{
		"agent-fs": map[string]interface{}{"command": "agent-fs-mcp"},
	})
	generation, _, ok := p.reserveEngine(live, context.Background(), context.Background())
	if !ok {
		t.Fatal("engine was not reserved")
	}
	cancels := 0
	// An engine whose teardown never completes: nothing reports engineStopped.
	if p.engineStarted(live, generation, func() { cancels++ }) {
		t.Fatal("the engine was evicted before the merge asked")
	}
	parkPoolSession(p, live)

	release, receipt, admitted := drainedMerge(p, "stuck", 50*time.Millisecond)
	if admitted {
		release()
		t.Fatal("the merge was admitted beside an engine that was asked to go and is still resident")
	}
	if cancels != 1 {
		t.Fatalf("engine cancels = %d, want the one eviction", cancels)
	}
	if !strings.Contains(receipt, "agent-fs") || !strings.Contains(receipt, "not stopped") {
		t.Fatalf("the refusal does not say which engine it is still waiting on: %q", receipt)
	}

	p.engineStopped(live, generation)
	release, receipt, admitted = drainedMerge(p, "stuck", 50*time.Millisecond)
	if !admitted {
		t.Fatalf("the merge stayed refused after the evicted engine stopped: %q", receipt)
	}
	release()
	if receipt != "" {
		t.Fatalf("nothing was left to evict, yet the receipt says: %q", receipt)
	}
	p.finish(live)
}

// Evicting takes time, and admission has already looked for writers. A runner-hosted job
// that starts while the engine is going outlives it, so the operation looks again before
// it runs, and is refused naming that job.
func TestDrainedMergeRefusedWhenAJobStartsDuringTheEviction(t *testing.T) {
	p := newSessionPool(1)
	live := agentMcpPoolSession(t, p, "late", map[string]interface{}{
		"agent-fs": map[string]interface{}{"command": "agent-fs-mcp"},
	})
	generation, _, ok := p.reserveEngine(live, context.Background(), context.Background())
	if !ok {
		t.Fatal("engine was not reserved")
	}
	p.engineStarted(live, generation, func() {
		go func() {
			p.holdWorktreeForRunnerJob("late", "bgj_late", "bgj_late")
			p.engineStopped(live, generation)
		}()
	})
	parkPoolSession(p, live)

	release, receipt, admitted := drainedMerge(p, "late", 5*time.Second)
	if admitted {
		release()
		t.Fatal("the merge was admitted although a runner-hosted job started while the engine was being evicted")
	}
	if !strings.Contains(receipt, "bgj_late") {
		t.Fatalf("the refusal does not name the job holding the checkout: %q", receipt)
	}
	if !strings.Contains(receipt, "evicted") {
		t.Fatalf("the refusal hides that the engine was evicted for this merge: %q", receipt)
	}

	// The paired positive: the job leaving opens the same merge.
	p.releaseWorktreeBackgroundJob("late", "bgj_late")
	release, receipt, admitted = drainedMerge(p, "late", 5*time.Second)
	if !admitted {
		t.Fatalf("the merge stayed refused after the job ended: %q", receipt)
	}
	release()
	p.finish(live)
}

// A warm engine runs the MCP servers it was spawned with. A claim that reuses it carries
// whatever the agent's configuration says by then, which is not what is running — so the
// decision follows the engine's own spawn, both ways round.
func TestDrainedMergeFollowsTheServersTheEngineWasSpawnedWith(t *testing.T) {
	agentFs := map[string]interface{}{"agent-fs": map[string]interface{}{"command": "agent-fs-mcp"}}
	p := newSessionPool(1)
	live := agentMcpPoolSession(t, p, "respawn", agentFs)
	startEngine := func() {
		t.Helper()
		generation, _, ok := p.reserveEngine(live, context.Background(), context.Background())
		if !ok {
			t.Fatal("engine was not reserved")
		}
		p.engineStarted(live, generation, func() { go p.engineStopped(live, generation) })
		parkPoolSession(p, live)
	}
	claim := func(mcpConfig map[string]interface{}) {
		t.Helper()
		job := manualWorktreePoolJob("respawn", "orbit/respawn")
		job.Agent.McpConfig = mcpConfig
		if _, ok := p.activate(job); !ok {
			t.Fatal("the claim was not activated")
		}
	}
	merge := func() string {
		t.Helper()
		release, receipt, admitted := drainedMerge(p, "respawn", 5*time.Second)
		if !admitted {
			t.Fatalf("the merge was refused: %q", receipt)
		}
		release()
		return receipt
	}

	// Spawned running agent-fs. The agent then drops it, and the next claim reuses the
	// warm engine — which goes on running agent-fs.
	startEngine()
	claim(nil)
	parkPoolSession(p, live)
	if receipt := merge(); !strings.Contains(receipt, "agent-fs") {
		t.Fatalf("the engine still runs agent-fs, which the newest claim no longer names, and was not evicted for it: %q",
			receipt)
	}
	if p.engineResident(live) {
		t.Fatal("the engine is still resident after the merge evicted it")
	}

	// Cold-resumed from a claim that names none. The agent then adds agent-fs back, and
	// the next claim reuses that warm engine — which never started it.
	claim(nil)
	startEngine()
	claim(agentFs)
	parkPoolSession(p, live)
	if receipt := merge(); receipt != "" {
		t.Fatalf("an engine spawned without the agent's MCP servers was evicted because a later claim names one: %q",
			receipt)
	}
	if !p.engineResident(live) {
		t.Fatal("the merge took down an engine it had no reason to")
	}
	p.finish(live)
}

// One decision serves every engine only if it names what each engine is actually handed.
// Claude, Kimi and OpenCode merge the agent's McpConfig into their engine's configuration;
// Codex configures Orbit's server alone. Each case builds that engine's real configuration
// and reads the servers back out of it.
func TestAgentMcpServerNamesAreWhatEachEngineIsConfiguredWith(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	const exe = "/usr/local/bin/orbit"
	mcpConfig := map[string]interface{}{
		// The agent's own entry under Orbit's name: every spawn overwrites it with the
		// built-in server.
		"orbit":     map[string]interface{}{"command": "not-orbit", "args": []interface{}{"serve"}},
		"agent-fs":  map[string]interface{}{"command": "agent-fs-mcp", "args": []interface{}{"--root", "."}},
		"agent-web": map[string]interface{}{"type": "http", "url": "https://mcp.example.invalid/"},
	}
	keys := func(m map[string]json.RawMessage) []string {
		out := make([]string, 0, len(m))
		for k := range m {
			out = append(out, k)
		}
		return out
	}
	configured := map[string]func(t *testing.T, job *ClaimedSession) []string{
		providerClaude: func(t *testing.T, job *ClaimedSession) []string {
			scratch := t.TempDir()
			claudeCommandArgs(job, scratch, true)
			data, err := os.ReadFile(filepath.Join(scratch, "mcp.json"))
			if err != nil {
				t.Fatalf("the Claude spawn wrote no mcp.json: %v", err)
			}
			var file struct {
				McpServers map[string]json.RawMessage `json:"mcpServers"`
			}
			if err := json.Unmarshal(data, &file); err != nil {
				t.Fatalf("mcp.json is not JSON: %v", err)
			}
			return keys(file.McpServers)
		},
		providerKimi: func(t *testing.T, job *ClaimedSession) []string {
			var names []string
			for name := range kimiMCPConfigRecord(job.Agent, exe) {
				names = append(names, name)
			}
			for _, server := range kimiMCPServers(job.Agent) {
				names = append(names, asString(server["name"]))
			}
			return names
		},
		providerOpenCode: func(t *testing.T, job *ClaimedSession) []string {
			content, err := openCodeConfigContent(job, t.TempDir(), "orbit", nil)
			if err != nil {
				t.Fatalf("openCodeConfigContent: %v", err)
			}
			var config struct {
				MCP map[string]json.RawMessage `json:"mcp"`
			}
			if err := json.Unmarshal([]byte(content), &config); err != nil {
				t.Fatalf("the OpenCode config is not JSON: %v", err)
			}
			return keys(config.MCP)
		},
		providerCodex: func(t *testing.T, job *ClaimedSession) []string {
			args := append(codexAppServerCommandArgs(job, t.TempDir(), exe),
				codexExecCommandArgs(job, t.TempDir(), t.TempDir(), nil, exe)...)
			var names []string
			for _, arg := range args {
				if rest, ok := strings.CutPrefix(arg, "mcp_servers."); ok {
					names = append(names, strings.SplitN(rest, ".", 2)[0])
				}
			}
			return names
		},
	}
	for _, provider := range []string{providerClaude, providerKimi, providerOpenCode, providerCodex} {
		t.Run(provider, func(t *testing.T) {
			job := &ClaimedSession{
				SessionID: "s-" + provider, SessionUUID: "11111111-1111-4111-8111-111111111111", Provider: provider,
				Agent: AgentExecConfig{Model: "model", PermissionMode: "dontAsk", McpConfig: mcpConfig},
			}
			seen := map[string]bool{}
			for _, name := range configured[provider](t, job) {
				seen[name] = true
			}
			if !seen["orbit"] {
				t.Fatalf("no orbit server in the %s engine's configuration: this case is not reading it", provider)
			}
			var want []string
			for name := range seen {
				if name != "orbit" {
					want = append(want, name)
				}
			}
			sort.Strings(want)
			if got := agentMcpServerNames(job); strings.Join(got, ",") != strings.Join(want, ",") {
				t.Fatalf("agentMcpServerNames = %v, but the %s engine is configured with the agent's %v",
					got, provider, want)
			}
		})
	}
}
