package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

// A background shell outlives the turn that launched it, and holds the session's checkout for as
// long as it runs: the worktree GC must not delete a directory it is still writing in, and a merge
// or commit names it in its receipt. What it does not do is fence the checkout. Merge replays
// committed work in a scratch worktree and commit writes only the index and refs, so neither waits
// for a writer (owner, 2026-09-12); the fence stays what the turn permit and takeover raise.

func holdersInclude(holders []worktreeHolder, kind, name string) bool {
	for _, h := range holders {
		if h.kind == kind && h.name == name {
			return true
		}
	}
	return false
}

func worktreeFenceRaised(p *sessionPool, id string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	state := p.worktreeOps[id]
	return state != nil && state.fenced
}

// A parked session has handed back its turn permit, and its background shells are still running
// in the checkout. They hold it; the fence comes down with the turn all the same, and a merge
// delivered now is admitted.
func TestLiveBackgroundJobHoldsTheCheckoutWithoutFencingIt(t *testing.T) {
	p := newSessionPool(1)
	live, added := p.register(manualWorktreePoolJob("bgheld", "orbit/bgheld"), func() {}, true)
	if !added {
		t.Fatal("failed to register the active session")
	}
	if _, _, ok := p.reserveEngine(live, context.Background(), context.Background()); !ok {
		t.Fatal("failed to make the engine resident")
	}

	// The agent's own background shell and a job the runner hosts, both still alive when the
	// turn ends.
	p.holdWorktreeForBackgroundJob("bgheld", "toolu_A", "bei1")
	p.holdWorktreeForRunnerJob("bgheld", "bgj_B", "bgj_B")
	parkPoolSession(p, live)
	if p.isActive(live) {
		t.Fatal("park did not hand back the turn permit — the test is not modelling an idle session")
	}

	holders := p.worktreeHolders("bgheld")
	for _, name := range []string{"bei1", "bgj_B"} {
		if !holdersInclude(holders, worktreeHeldByBackgroundJob, name) {
			t.Fatalf("holder set does not name the live background job %s: %v", name, holders)
		}
	}
	// With its turn over, the engine holds nothing — not on its shells' account either: nothing
	// it left running is waited for.
	if holdersInclude(holders, worktreeHeldByEngine, "bgheld") {
		t.Fatalf("a parked engine counts as a holder because background jobs are alive: %v", holders)
	}
	if worktreeFenceRaised(p, "bgheld") {
		t.Fatal("park left the worktree fence up because background jobs are still running")
	}
	advertised, _ := p.heartbeatSnapshot()
	parked := advertised["bgheld"]
	release, admitted := p.beginHeartbeatWorktreeOperation("bgheld", parked.supervisor, parked.permitGeneration, false)
	if !admitted {
		t.Fatalf("a merge was refused beside live background jobs: %q", p.worktreeOperationRefusal("bgheld", "merge"))
	}
	release()

	// The paired positive: the fence still does what it is for. A claim raises it with the same
	// jobs alive, and the merge is refused — by the turn, which is what the refusal names.
	if _, ok := p.activate(manualWorktreePoolJob("bgheld", "orbit/bgheld")); !ok {
		t.Fatal("the claim was not activated")
	}
	if !worktreeFenceRaised(p, "bgheld") {
		t.Fatal("a claim did not raise the worktree fence")
	}
	advertised, _ = p.heartbeatSnapshot()
	claimed := advertised["bgheld"]
	release, admitted = p.beginHeartbeatWorktreeOperation("bgheld", claimed.supervisor, claimed.permitGeneration, false)
	if admitted {
		release()
		t.Fatal("a merge was admitted while a turn runs")
	}
	refusal := p.worktreeOperationRefusal("bgheld", "merge")
	if !strings.Contains(refusal, worktreeHeldByEngine) {
		t.Fatalf("the refusal does not name the engine whose turn made it: %q", refusal)
	}
	if strings.Contains(refusal, "bei1") || strings.Contains(refusal, "bgj_B") {
		t.Fatalf("a refusal the turn made blames the background jobs running beside it: %q", refusal)
	}

	// And the holds end with their jobs.
	p.releaseWorktreeBackgroundJob("bgheld", "toolu_A")
	p.releaseWorktreeBackgroundJob("bgheld", "bgj_B")
	holders = p.worktreeHolders("bgheld")
	if holdersInclude(holders, worktreeHeldByBackgroundJob, "bei1") ||
		holdersInclude(holders, worktreeHeldByBackgroundJob, "bgj_B") {
		t.Fatalf("checkout still held after its last background job ended: %v", holders)
	}
	p.finish(live)
}

// The registry is only worth having if something declares its writers to it. The
// shells bgTailer tails are those writers, and their holds have to end with them
// — a hold nobody releases keeps the checkout from the worktree GC for good.
func TestBackgroundShellHoldsTheWorktreeUntilItEnds(t *testing.T) {
	p := newSessionPool(1)
	live, added := p.register(manualWorktreePoolJob("bgdoor", "orbit/bgdoor"), func() {}, true)
	if !added {
		t.Fatal("failed to register the active session")
	}
	emit, _ := bgCollector()
	bg := newBgTailer(context.Background(), emit, p.worktreeHoldsFor("bgdoor"))
	defer bg.stopAll()
	dir := t.TempDir()

	bg.onToolResult("toolu_A", "Command running in background with ID: bei1. Output is being"+
		" written to: "+filepath.Join(dir, "bei1.output")+". Use BashOutput to read it.")
	bg.startTail("toolu_B", "bei2", filepath.Join(dir, "bei2.output"), false) // a user `!`-shell
	holders := p.worktreeHolders("bgdoor")
	if !holdersInclude(holders, worktreeHeldByBackgroundJob, "bei1") ||
		!holdersInclude(holders, worktreeHeldByBackgroundJob, "bei2") {
		t.Fatalf("a shell the runner is tailing is not a worktree holder: %v", holders)
	}

	// Stage 1 keeps the existing kill: the agent's shells die with their engine.
	// The hold has to go with them, and the runner-owned shell's has to stay.
	bg.killEngineShells()
	holders = p.worktreeHolders("bgdoor")
	if holdersInclude(holders, worktreeHeldByBackgroundJob, "bei1") {
		t.Fatalf("a shell killed with its engine still holds the checkout: %v", holders)
	}
	if !holdersInclude(holders, worktreeHeldByBackgroundJob, "bei2") {
		t.Fatalf("a runner-owned shell outlives the engine and must keep its hold: %v", holders)
	}

	bg.stop("toolu_B")
	if holders := p.worktreeHolders("bgdoor"); holdersInclude(holders, worktreeHeldByBackgroundJob, "bei2") {
		t.Fatalf("a finished shell still holds the checkout: %v", holders)
	}
	p.finish(live)
}

// GC is the third destructive operation and the bluntest — it deletes the
// directory. A checkout with a live writer is not an orphan, whether or not a
// supervisor is left to speak for it.
func TestWorktreeGCSkipsACheckoutWithALiveBackgroundJob(t *testing.T) {
	p := newSessionPool(1)
	p.holdWorktreeForBackgroundJob("bggc", "toolu_A", "bei1")
	if !p.ids()["bggc"] {
		t.Fatal("a checkout with a live background job is offered to gcWorktrees as an orphan")
	}
	p.releaseWorktreeBackgroundJob("bggc", "toolu_A")
	if p.ids()["bggc"] {
		t.Fatal("the checkout is still withheld from GC after its last writer left")
	}
}
