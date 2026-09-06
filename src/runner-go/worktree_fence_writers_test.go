package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

// The worktree fence used to be driven by the turn permit: claim raised it, park
// lowered it. A background shell outlives the turn that launched it, so between
// park and the next claim the checkout read as nobody's while a shell was still
// writing in it. These tests hold the fence to the question it is actually
// asked — "is anyone writing this checkout" — of which "is a turn running" is
// only one answer.

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

// A parked session has handed back its turn permit and holds nothing the pool
// used to count. Its background shell is still running, and still writing.
func TestWorktreeFenceHeldByLiveBackgroundJob(t *testing.T) {
	p := newSessionPool(1)
	live, added := p.register(manualWorktreePoolJob("bgheld", "orbit/bgheld"), func() {}, true)
	if !added {
		t.Fatal("failed to register the active session")
	}
	if _, _, ok := p.reserveEngine(live, context.Background(), context.Background()); !ok {
		t.Fatal("failed to make the engine resident")
	}
	permit := p.permitGeneration(live)

	// The agent runs Bash(run_in_background); the shell is still alive when the
	// turn ends.
	p.holdWorktreeForBackgroundJob("bgheld", "toolu_A", "bei1")
	p.park(live, permit)
	if p.isActive(live) {
		t.Fatal("park did not hand back the turn permit — the test is not modelling an idle session")
	}

	holders := p.worktreeHolders("bgheld")
	if len(holders) == 0 {
		t.Fatal("holder set is empty with no active turn but a live background job: " +
			"the checkout reads as free while a shell is still writing in it")
	}
	if !holdersInclude(holders, worktreeHeldByBackgroundJob, "bei1") {
		t.Fatalf("holder set does not name the live background job: %v", holders)
	}
	// The engine that owns the shell is a holder too, for exactly as long as it
	// has one: this is the contrast with park(), which counted only the permit.
	if !holdersInclude(holders, worktreeHeldByEngine, "bgheld") {
		t.Fatalf("resident engine with a live shell is not a holder: %v", holders)
	}
	if !worktreeFenceRaised(p, "bgheld") {
		t.Fatal("park lowered the worktree fence while a background job was still writing")
	}

	// And it comes down when the last writer leaves — not before, not never.
	p.releaseWorktreeBackgroundJob("bgheld", "toolu_A")
	if holders := p.worktreeHolders("bgheld"); len(holders) != 0 {
		t.Fatalf("checkout still held after its last background job ended: %v", holders)
	}
	if worktreeFenceRaised(p, "bgheld") {
		t.Fatal("fence stayed up after the last writer left: nothing would ever merge this session again")
	}
	p.finish(live)
}

// Merge rewrites the checkout. With a shell still writing in it, the one thing it
// must not do is quietly happen — and the refusal has to say which, because
// "superseded" is a control-plane race and reads as "retry", while a live writer
// reads as "wait".
func TestMergeNotSilentlyAllowedWithLiveBackgroundJob(t *testing.T) {
	p := newSessionPool(1)
	live, added := p.register(manualWorktreePoolJob("bgmerge", "orbit/bgmerge"), func() {}, true)
	if !added {
		t.Fatal("failed to register the active session")
	}
	if _, _, ok := p.reserveEngine(live, context.Background(), context.Background()); !ok {
		t.Fatal("failed to make the engine resident")
	}
	permit := p.permitGeneration(live)
	p.holdWorktreeForBackgroundJob("bgmerge", "toolu_A", "bei1")
	p.park(live, permit)

	// The heartbeat delivers "merge to main" against this exact parked epoch.
	advertised, _ := p.heartbeatSnapshot()
	snapshot := advertised["bgmerge"]
	release, admitted := p.beginHeartbeatWorktreeOperation(
		"bgmerge", snapshot.supervisor, snapshot.permitGeneration, false,
	)
	if admitted {
		release()
		t.Fatal("merge was admitted against a checkout a background shell is still writing")
	}
	receipt := p.worktreeOperationRefusal("bgmerge", "merge")
	if !strings.Contains(receipt, "bei1") {
		t.Fatalf("refusal does not name the holder that stopped it: %q", receipt)
	}
	if strings.Contains(receipt, "superseded") {
		t.Fatalf("a live writer was reported as a control-plane race: %q", receipt)
	}

	// The paired positive: refusing everything forever is not a fence, it is a
	// wedge. Draining the last writer opens the same merge.
	p.releaseWorktreeBackgroundJob("bgmerge", "toolu_A")
	release, admitted = p.beginHeartbeatWorktreeOperation(
		"bgmerge", snapshot.supervisor, snapshot.permitGeneration, false,
	)
	if !admitted {
		t.Fatalf("merge stayed fenced after the last writer left: %q",
			p.worktreeOperationRefusal("bgmerge", "merge"))
	}
	release()
	p.finish(live)
}

// The registry is only worth having if something declares its writers to it. The
// shells bgTailer tails are those writers, and their holds have to end with them
// — a hold nobody releases wedges the session's merges shut.
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
