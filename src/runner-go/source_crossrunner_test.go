package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Recovery, cross-runner takeover, and a ref that moves after the claim
// (docs/project-source-contract.md §6.4, SR41/SR42, §12.5 S5.01/S5.04/S5.05).
//
// The property under test is a negative one — "nothing here re-derives the baseline" — and a
// negative is only worth as much as the positive beside it. So every fixture below MOVES the
// authority's ref between the pin and the recovery, and each test that asserts "the baseline did
// not change" is paired with an assertion that a FRESH resolution against the same authority does
// reach the new commit. Without that pair, "the baseline did not move" is equally true of a fixture
// where nothing moved at all, and the test would pass against an implementation that re-resolves on
// every claim.
//
// Real git and a real transport throughout, over `file://` rather than a plain path: `git clone`
// hardlinks a local path's whole object store, so a clone made that way already holds every commit
// the server has ever seen — and "this machine does not have the frozen object" would be a
// statement about nothing. remoteRepo therefore serves every clone over `file://`, and
// TestTakeoverFetchesTheFrozenObjectNotTodaysRefTip asserts the absence up front rather than
// trusting the transport to keep behaving that way.

// remoteRepo is an authority: a bare repository plus a scratch checkout to push commits through.
// The runner-side clones below fetch from it exactly the way a runner fetches from `origin`.
type remoteRepo struct {
	bare    string
	scratch string
}

func newRemoteRepo(t *testing.T) *remoteRepo {
	t.Helper()
	r := &remoteRepo{bare: filepath.Join(t.TempDir(), "authority.git"), scratch: t.TempDir()}
	mustGit(t, t.TempDir(), "init", "--bare", "-b", "main", r.bare)
	mustGit(t, r.scratch, "init", "-b", "main")
	mustGit(t, r.scratch, "config", "user.email", "test@orbit")
	mustGit(t, r.scratch, "config", "user.name", "Test")
	mustGit(t, r.scratch, "remote", "add", "origin", r.url())
	commitFile(t, r.scratch, "base.txt", "base\n", "base")
	mustGit(t, r.scratch, "push", "origin", "main")
	return r
}

// url is a `file://` URL on purpose — see the file header.
func (r *remoteRepo) url() string { return "file://" + r.bare }

// advanceMain lands one commit on the authority's main and returns its SHA.
func (r *remoteRepo) advanceMain(t *testing.T, name, content string) string {
	t.Helper()
	commitFile(t, r.scratch, name, content, "authority: "+name)
	mustGit(t, r.scratch, "push", "origin", "main")
	return mustGit(t, r.scratch, "rev-parse", "HEAD")
}

// keepReachable parks a commit under a ref that is NOT the selector's, so the object stays
// fetchable after main has been force-pushed off it. This is what a real server looks like after a
// force-push that a tag, another branch or a PR ref still holds the old tip.
func (r *remoteRepo) keepReachable(t *testing.T, sha, refName string) {
	t.Helper()
	mustGit(t, r.scratch, "push", "origin", sha+":"+refName)
}

// forcePushUnrelated replaces main with an orphan commit that shares no history with what was
// there, and returns its SHA. A run that resolved the ref instead of the object would land here.
func (r *remoteRepo) forcePushUnrelated(t *testing.T, name string) string {
	t.Helper()
	work := t.TempDir()
	mustGit(t, work, "init", "-b", "rewritten")
	mustGit(t, work, "config", "user.email", "test@orbit")
	mustGit(t, work, "config", "user.name", "Test")
	commitFile(t, work, name, "rewritten\n", "history rewritten")
	mustGit(t, work, "remote", "add", "origin", r.url())
	mustGit(t, work, "push", "--force", "origin", "rewritten:main")
	return mustGit(t, work, "rev-parse", "HEAD")
}

// forget makes an unreferenced object genuinely unobtainable from this authority, which is what
// "the frozen SHA is temporarily unreachable" has to mean for the fetch to have anything to fail
// at. The caller is responsible for having dropped every ref that reaches it first.
func (r *remoteRepo) forget(t *testing.T) {
	t.Helper()
	mustGit(t, r.bare, "reflog", "expire", "--expire=now", "--all")
	mustGit(t, r.bare, "gc", "--prune=now")
}

// clone gives one runner its own checkout of the authority, holding only what the authority's refs
// reach at this moment.
func (r *remoteRepo) clone(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "checkout")
	mustGit(t, t.TempDir(), "clone", r.url(), dir)
	mustGit(t, dir, "config", "user.email", "test@orbit")
	mustGit(t, dir, "config", "user.name", "Test")
	return dir
}

// drift moves the runner's OWN checkout past the frozen commit, so every row below is answering
// "did the recovery read the pin" rather than "did the pin happen to equal what HEAD was on". The
// shared checkout following the authority is the normal state of a machine somebody also works on,
// and it is precisely the value a re-deriving implementation would reach for.
func drift(t *testing.T, checkout string) {
	t.Helper()
	commitFile(t, checkout, "workspace.txt", "somebody else's commit\n", "the workspace moved on")
}

// freshlyResolves is the positive control every "it did not move" assertion below is paired with:
// what a session STARTING NOW against this same authority would freeze. When it differs from the
// pin, a recovery path that re-derived would have been caught.
func freshlyResolves(t *testing.T, workDir string) string {
	t.Helper()
	sha, refusal := resolveSourceSha(selectedJob(workDir))
	if refusal != nil {
		t.Fatalf("the control resolution refused (%s: %v); the fixture cannot show what re-deriving would do",
			refusal.Code, refusal.Detail)
	}
	return sha
}

// hasCommit reports whether dir's object store holds sha as a commit — G4's own test (SR42).
func hasCommit(dir, sha string) bool {
	_, err := git(dir, "cat-file", "-e", sha+"^{commit}")
	return err == nil
}

// mustStartOn asserts the run got a checkout standing exactly on sha, and that it is a real
// worktree rather than any of §0's degradations.
func mustStartOn(t *testing.T, job *ClaimedSession, execDir, sha string) {
	t.Helper()
	if job.SourceRefusal != nil {
		t.Fatalf("refused with %s: %v", job.SourceRefusal.Code, job.SourceRefusal.Detail)
	}
	if execDir == "" || job.WT == nil {
		t.Fatalf("no checkout: execDir=%q wt=%v", execDir, job.WT)
	}
	if job.IsolationStatus != isoWorktree {
		t.Fatalf("IsolationStatus = %q, want %q", job.IsolationStatus, isoWorktree)
	}
	if _, err := git(job.WT.Path, "merge-base", "--is-ancestor", sha, "HEAD"); err != nil {
		t.Fatalf("the checkout at %s does not contain %s", job.WT.Path, shortSha(sha))
	}
	if job.Source.BaseSha != sha {
		t.Fatalf("the pin read back as %s, want %s", job.Source.BaseSha, sha)
	}
}

// §6.4's recovery table, one fault-injection case per row, with the authority's ref moving under
// every one of them.
//
// Rows 7–10 are properties of the control plane's row rather than of this process and are asserted
// in source-cas.pg.spec.ts against real PostgreSQL; the six rows here are the ones a runner can
// actually be caught in the middle of.
func TestRecoveryReusesTheFrozenSnapshotThroughEveryCrashPoint(t *testing.T) {
	// Row 1 is also the control for rows 2–6: it establishes that re-deriving against this
	// authority reaches a DIFFERENT commit, which is what makes "the pin did not move" in the rows
	// below an assertion about the implementation rather than about the fixture.
	t.Run("row 1 — a crash before the pin re-resolves, and may legally reach a new commit", func(t *testing.T) {
		t.Setenv("ORBIT_HOME", t.TempDir())
		remote := newRemoteRepo(t)
		atFirstAttempt := remote.advanceMain(t, "first.txt", "first\n")
		checkout := remote.clone(t)

		job := selectedJob(checkout)
		first, refusal := resolveSourceSha(job)
		if refusal != nil {
			t.Fatalf("first resolution refused: %s %v", refusal.Code, refusal.Detail)
		}
		if first != atFirstAttempt {
			t.Fatalf("resolved %s, want the authority's tip %s", first, atFirstAttempt)
		}
		// The runner dies here, before it could send the pin. Nothing is frozen.
		if job.Source.State != sourceStateSelected || job.Source.BaseSha != "" {
			t.Fatalf("a resolution that never reached the control plane froze something: state=%s base=%q",
				job.Source.State, job.Source.BaseSha)
		}

		atSecondAttempt := remote.advanceMain(t, "second.txt", "second\n")
		second := freshlyResolves(t, checkout)
		if second != atSecondAttempt {
			t.Fatalf("the retry resolved %s, want the tip as it is now %s", second, atSecondAttempt)
		}
		if second == first {
			t.Fatal("the authority's ref did not actually move; every 'the pin did not move' case " +
				"below would then be vacuous")
		}
	})

	t.Run("row 2 — the CAS committed and the process died before the worktree", func(t *testing.T) {
		t.Setenv("ORBIT_HOME", t.TempDir())
		remote := newRemoteRepo(t)
		pinned := remote.advanceMain(t, "pinned.txt", "pinned\n")
		checkout := remote.clone(t)
		drift(t, checkout)

		// The pin is frozen; nothing else happened. That is exactly what a re-claim finds.
		job := pinnedJob(t, "s-row2", checkout, pinned)
		if _, err := os.Stat(filepath.Join(worktreesDir(), "s-row2")); !os.IsNotExist(err) {
			t.Fatalf("the fixture already has a checkout; this row is about not having one (%v)", err)
		}
		remote.advanceMain(t, "later.txt", "later\n")

		execDir := setupWorktree(job, checkout)
		mustStartOn(t, job, execDir, pinned)
		assertForkedFromThePin(t, execDir, checkout, pinned)
	})

	t.Run("row 3 — the worktree exists and the engine never started", func(t *testing.T) {
		t.Setenv("ORBIT_HOME", t.TempDir())
		remote := newRemoteRepo(t)
		pinned := remote.advanceMain(t, "pinned.txt", "pinned\n")
		checkout := remote.clone(t)
		drift(t, checkout)

		first := pinnedJob(t, "s-row3", checkout, pinned)
		if execDir := setupWorktree(first, checkout); execDir == "" {
			t.Fatalf("the first attempt refused: %v", first.SourceRefusal)
		}
		wtPath := first.WT.Path
		remote.advanceMain(t, "later.txt", "later\n")

		// A crash loses every bit of in-process state; the checkout on disk is all that survives.
		second := pinnedJob(t, "s-row3", checkout, pinned)
		execDir := setupWorktree(second, checkout)
		mustStartOn(t, second, execDir, pinned)
		if second.WT.Path != wtPath {
			t.Errorf("re-attached to %s, want the surviving checkout %s", second.WT.Path, wtPath)
		}
		assertForkedFromThePin(t, execDir, checkout, pinned)
	})

	t.Run("row 4 — the runner process restarted and the agent's work is still there", func(t *testing.T) {
		t.Setenv("ORBIT_HOME", t.TempDir())
		remote := newRemoteRepo(t)
		pinned := remote.advanceMain(t, "pinned.txt", "pinned\n")
		checkout := remote.clone(t)
		drift(t, checkout)

		first := pinnedJob(t, "s-row4", checkout, pinned)
		if execDir := setupWorktree(first, checkout); execDir == "" {
			t.Fatalf("the first attempt refused: %v", first.SourceRefusal)
		}
		commitFile(t, first.WT.Path, "agent.txt", "the agent's work\n", "work done before the restart")
		remote.advanceMain(t, "later.txt", "later\n")

		second := pinnedJob(t, "s-row4", checkout, pinned)
		execDir := setupWorktree(second, checkout)
		mustStartOn(t, second, execDir, pinned)
		if _, err := os.Stat(filepath.Join(execDir, "agent.txt")); err != nil {
			t.Errorf("the reclaim lost the work done before the restart: %v", err)
		}
		assertForkedFromThePin(t, execDir, checkout, pinned)
	})

	t.Run("row 5 — a takeover by a second machine, which must obtain the same commit", func(t *testing.T) {
		// Two machines means two ORBIT_HOMEs. Sharing one would let the second machine re-attach to
		// the first's checkout and never go looking for the commit at all, which is the entire
		// question this row asks.
		machineA := t.TempDir()
		machineB := t.TempDir()
		t.Setenv("ORBIT_HOME", machineA)
		remote := newRemoteRepo(t)
		pinned := remote.advanceMain(t, "pinned.txt", "pinned\n")
		first := remote.clone(t)

		firstJob := pinnedJob(t, "s-row5", first, pinned)
		if execDir := setupWorktree(firstJob, first); execDir == "" {
			t.Fatalf("the first machine refused: %v", firstJob.SourceRefusal)
		}

		// The authority is rewritten off the frozen commit while the session is in flight, so the
		// second machine's clone cannot hold it and has to fetch the OBJECT (SR41).
		remote.keepReachable(t, pinned, "refs/archive/before-the-rewrite")
		rewritten := remote.forcePushUnrelated(t, "rewritten.txt")
		second := remote.clone(t)
		if hasCommit(second, pinned) {
			t.Fatal("the taking-over machine already holds the frozen commit; it would not have to fetch it")
		}
		drift(t, second)

		t.Setenv("ORBIT_HOME", machineB)
		takeover := pinnedJob(t, "s-row5", second, pinned)
		execDir := setupWorktree(takeover, second)
		mustStartOn(t, takeover, execDir, pinned)
		if !strings.HasPrefix(execDir, machineB) {
			t.Errorf("the takeover ran in %q, which is not the second machine's own checkout", execDir)
		}
		if _, err := os.Stat(filepath.Join(execDir, "pinned.txt")); err != nil {
			t.Errorf("the second machine's checkout does not carry the frozen commit's tree: %v", err)
		}
		if _, err := os.Stat(filepath.Join(execDir, "rewritten.txt")); err == nil {
			t.Error("the second machine took the ref's tip instead of the frozen object")
		}
		if now := freshlyResolves(t, second); now != rewritten {
			t.Fatalf("a fresh resolution reached %s, want the rewritten tip %s; the fixture never moved the ref",
				now, rewritten)
		}
	})

	t.Run("row 6 — a resume after the session ended, with the checkout already reaped", func(t *testing.T) {
		t.Setenv("ORBIT_HOME", t.TempDir())
		remote := newRemoteRepo(t)
		pinned := remote.advanceMain(t, "pinned.txt", "pinned\n")
		checkout := remote.clone(t)
		drift(t, checkout)

		first := pinnedJob(t, "s-row6", checkout, pinned)
		if execDir := setupWorktree(first, checkout); execDir == "" {
			t.Fatalf("the first run refused: %v", first.SourceRefusal)
		}
		commitFile(t, first.WT.Path, "agent.txt", "the agent's work\n", "work done before the session ended")
		// Finalisation removes the checkout and keeps the branch, which is the state a resume finds.
		mustGit(t, checkout, "worktree", "remove", "--force", first.WT.Path)
		if !branchExists(checkout, first.Branch) {
			t.Fatal("the fixture removed the branch too; a resume would have nothing to resume")
		}
		remote.advanceMain(t, "later.txt", "later\n")

		second := pinnedJob(t, "s-row6", checkout, pinned)
		execDir := setupWorktree(second, checkout)
		mustStartOn(t, second, execDir, pinned)
		if _, err := os.Stat(filepath.Join(execDir, "agent.txt")); err != nil {
			t.Errorf("the resume did not come back to the session's own branch: %v", err)
		}
		assertForkedFromThePin(t, execDir, checkout, pinned)
	})
}

// assertForkedFromThePin is the paired positive control, made concrete: the authority's ref has
// moved past the pin in every row above, so `later.txt` exists in what a fresh resolution would
// reach and in nothing this run may contain.
func assertForkedFromThePin(t *testing.T, execDir, checkout, pinned string) {
	t.Helper()
	if _, err := os.Stat(filepath.Join(execDir, "later.txt")); err == nil {
		t.Error("the checkout carries a commit made after the pin — this run re-derived its baseline")
	}
	if _, err := os.Stat(filepath.Join(execDir, "workspace.txt")); err == nil {
		t.Error("the checkout carries the workspace's own commit — this run forked from HEAD, not the pin")
	}
	if head := mustGit(t, checkout, "rev-parse", "HEAD"); head == pinned {
		t.Fatal("the shared checkout is still sitting on the pin, so forking from HEAD would have " +
			"produced the same answer and this case distinguishes nothing")
	}
	if now := freshlyResolves(t, checkout); now == pinned {
		t.Fatal("the authority's ref still resolves to the pin, so this case never had the chance " +
			"to re-derive and proves nothing")
	}
}

// SR41/SR42 and §12.5 S5.04/S5.05: what a machine goes and gets is the frozen OBJECT. The ref is
// one way to reach it and never a stand-in for it, so a ref that has been force-pushed somewhere
// else changes neither the answer nor, when the object cannot be had, the fact that this run stops.
func TestTakeoverFetchesTheFrozenObjectNotTodaysRefTip(t *testing.T) {
	t.Run("S5.04 the object is fetched from the authority when this machine lacks it", func(t *testing.T) {
		t.Setenv("ORBIT_HOME", t.TempDir())
		remote := newRemoteRepo(t)
		pinned := remote.advanceMain(t, "pinned.txt", "pinned\n")
		// The tip is force-pushed off the frozen commit, and only a non-selector ref still holds
		// it — the object is reachable, the ref is not.
		remote.keepReachable(t, pinned, "refs/archive/before-the-rewrite")
		rewritten := remote.forcePushUnrelated(t, "rewritten.txt")

		checkout := remote.clone(t)
		if hasCommit(checkout, pinned) {
			t.Fatal("this machine already holds the frozen commit; the fetch under test would not happen")
		}
		if !hasCommit(checkout, rewritten) {
			t.Fatal("this machine does not hold the ref's new tip; there is no wrong answer to prefer")
		}

		job := pinnedJob(t, "s-fetch-object", checkout, pinned)
		execDir := setupWorktree(job, checkout)
		mustStartOn(t, job, execDir, pinned)
		// The whole point, stated on the file system: the tree is the frozen commit's, not the one
		// `refs/heads/main` names today.
		if _, err := os.Stat(filepath.Join(execDir, "pinned.txt")); err != nil {
			t.Errorf("the checkout does not carry the frozen commit's tree: %v", err)
		}
		if _, err := os.Stat(filepath.Join(execDir, "rewritten.txt")); err == nil {
			t.Error("the checkout carries the ref's current tip — the ref was resolved, not the object")
		}
	})

	t.Run("S5.04 the object cannot be had: the run is refused, not moved to another commit", func(t *testing.T) {
		t.Setenv("ORBIT_HOME", t.TempDir())
		remote := newRemoteRepo(t)
		pinned := remote.advanceMain(t, "pinned.txt", "pinned\n")
		rewritten := remote.forcePushUnrelated(t, "rewritten.txt")
		remote.forget(t) // no ref reaches the frozen commit any more, and neither does a fetch

		checkout := remote.clone(t)
		if hasCommit(checkout, pinned) {
			t.Fatal("this machine holds the frozen commit; there is nothing unavailable to refuse over")
		}
		// The tempting alternative is live and one fetch away: a fall-back to "whatever that ref
		// points at now" would succeed here, which is what makes the refusal below a choice.
		if !hasCommit(checkout, rewritten) {
			t.Fatal("the ref's new tip is not here either; the refusal would not be a preference")
		}

		job := pinnedJob(t, "s-object-gone", checkout, pinned)
		execDir := setupWorktree(job, checkout)
		if execDir != "" {
			t.Errorf("exec dir %q; a run with no baseline has nowhere to run", execDir)
		}
		assertRefused(t, job, sourceRefusalShaUnavailable)
		if job.Source.BaseSha != pinned {
			t.Errorf("the pin was rewritten to %s; an unreachable commit is a reason to fail, not to substitute",
				job.Source.BaseSha)
		}
		if _, err := git(checkout, "rev-parse", "--verify", baseRefName("s-object-gone")); err == nil {
			t.Error("a refused run left a fork point behind in the shared checkout")
		}
		if branchExists(checkout, job.Branch) {
			t.Error("a refused run created its branch anyway — on the only commit it could have used")
		}
	})

	t.Run("S5.05 a force-pushed-away ref does not invalidate a pin this machine still holds", func(t *testing.T) {
		t.Setenv("ORBIT_HOME", t.TempDir())
		remote := newRemoteRepo(t)
		pinned := remote.advanceMain(t, "pinned.txt", "pinned\n")
		checkout := remote.clone(t)
		if !hasCommit(checkout, pinned) {
			t.Fatal("this machine does not hold the frozen commit; this case is about the one that does")
		}
		rewritten := remote.forcePushUnrelated(t, "rewritten.txt")

		// SR42 judges object presence, not ref existence: nothing on the authority reaches this
		// commit any more, and it is still a commit that really existed and this run really began
		// at. So the authority is not asked at all.
		fetchHead := filepath.Join(checkout, ".git", "FETCH_HEAD")
		if err := os.Remove(fetchHead); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
		job := pinnedJob(t, "s-forcepushed", checkout, pinned)
		execDir := setupWorktree(job, checkout)
		mustStartOn(t, job, execDir, pinned)
		if _, err := os.Stat(fetchHead); err == nil {
			t.Error("the authority was asked for a commit this machine already had")
		}
		if _, err := os.Stat(filepath.Join(execDir, "rewritten.txt")); err == nil {
			t.Error("the checkout carries the rewritten tip instead of the frozen commit")
		}
		// And the control: the ref really is somewhere else now, so an implementation that read the
		// ref would have been caught.
		if now := freshlyResolves(t, checkout); now != rewritten {
			t.Fatalf("a fresh resolution reached %s, want the rewritten tip %s; the force-push did not take",
				now, rewritten)
		}
	})
}

// The headline of §6.4's last three rows, driven end to end through the handshake: a ref that moves
// AFTER the claim changes nothing about a session that has already started.
//
// Every recovery event is replayed against a control plane that counts what it is asked, so "the
// snapshot was reused" is observable as silence on the wire rather than inferred from the outcome.
func TestRefMovingAfterTheClaimDoesNotMoveAStartedSession(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	remote := newRemoteRepo(t)
	atStart := remote.advanceMain(t, "pinned.txt", "pinned\n")
	checkout := remote.clone(t)

	srv := newPinServer(t)
	tr := NewTransport(srv.URL, "tok")

	job := selectedJob(checkout)
	job.WorkDir = checkout
	if err := ensureSourcePinned(context.Background(), tr, job); err != nil {
		t.Fatalf("ensureSourcePinned: %v", err)
	}
	if job.Source.BaseSha != atStart {
		t.Fatalf("froze %s, want the tip at start %s", job.Source.BaseSha, atStart)
	}
	if len(srv.requests) != 1 {
		t.Fatalf("the first claim sent %d pin requests, want exactly 1", len(srv.requests))
	}
	execDir := setupWorktree(job, checkout)
	mustStartOn(t, job, execDir, atStart)

	// The ref moves. Twice, and in both directions a real repository moves: forward, then onto a
	// history that does not contain the pin at all.
	afterStart := remote.advanceMain(t, "later.txt", "later\n")
	if afterStart == atStart {
		t.Fatal("the authority's ref did not move; the rest of this test would prove nothing")
	}

	for _, event := range []string{"resume", "reclaim", "heartbeat re-claim"} {
		replay := pinnedJob(t, job.SessionID, checkout, job.Source.BaseSha)
		replay.Branch = job.Branch
		if err := ensureSourcePinned(context.Background(), tr, replay); err != nil {
			t.Fatalf("%s: %v", event, err)
		}
		if len(srv.requests) != 1 {
			t.Fatalf("%s asked the control plane to freeze again: %d requests total", event, len(srv.requests))
		}
		if replay.Source.BaseSha != atStart {
			t.Errorf("%s: baseline moved to %s, want %s", event, replay.Source.BaseSha, atStart)
		}
		replayExec := setupWorktree(replay, checkout)
		mustStartOn(t, replay, replayExec, atStart)
		if _, err := os.Stat(filepath.Join(replayExec, "later.txt")); err == nil {
			t.Errorf("%s: the checkout picked up a commit pushed after the claim", event)
		}
	}

	// The paired positive: a session claimed NOW freezes the commit the ref points at now. The ref
	// moved, the resolver sees that it moved, and only the already-started session is unaffected.
	fresh := selectedJob(checkout)
	fresh.SessionID = "s-second-run"
	if err := ensureSourcePinned(context.Background(), tr, fresh); err != nil {
		t.Fatalf("the second run could not pin: %v", err)
	}
	if fresh.Source.BaseSha != afterStart {
		t.Errorf("a run starting now froze %s, want the ref's current tip %s", fresh.Source.BaseSha, afterStart)
	}
	if len(srv.requests) != 2 {
		t.Errorf("%d pin requests in total; want 1 for the first run and 1 for the second", len(srv.requests))
	}
}

// SR33 stated as the conjunction it is: an engine may start only when the SOURCE is PINNED AND this
// machine's checkout stands on that commit. Each half is knocked out on its own, and the third case
// is the positive control without which "nothing started" would also be true of a fixture that can
// never start anything.
func TestEngineStartNeedsBothTheFrozenPinAndTheWorktree(t *testing.T) {
	t.Run("no pin: nothing is built, on disk or in the shared checkout", func(t *testing.T) {
		t.Setenv("ORBIT_HOME", t.TempDir())
		remote := newRemoteRepo(t)
		remote.advanceMain(t, "pinned.txt", "pinned\n")
		checkout := remote.clone(t)
		before := captureWorkspace(t, checkout)

		srv := newPinServer(t)
		srv.Close() // the control plane cannot be reached, so nothing can be frozen
		job := selectedJob(checkout)
		job.SessionID = "s-nopin"
		if err := ensureSourcePinned(context.Background(), NewTransport(srv.URL, "tok"), job); err == nil {
			t.Fatal("a session whose pin never committed was allowed to proceed")
		}
		if job.Source.State == sourceStatePinned || job.Source.BaseSha != "" {
			t.Errorf("state=%s base=%q; a pin that was never acknowledged must freeze nothing",
				job.Source.State, job.Source.BaseSha)
		}
		// The direct evidence: the second half was never even attempted.
		if _, err := os.Stat(filepath.Join(worktreesDir(), "s-nopin")); !os.IsNotExist(err) {
			t.Errorf("a checkout exists for a session that never pinned (%v)", err)
		}
		if branchExists(checkout, job.Branch) {
			t.Error("a session that never pinned created its branch")
		}
		before.mustBeUntouched(t, checkout)
	})

	t.Run("pinned but no worktree: refused, with the shared checkout untouched", func(t *testing.T) {
		t.Setenv("ORBIT_HOME", t.TempDir())
		remote := newRemoteRepo(t)
		pinned := remote.advanceMain(t, "pinned.txt", "pinned\n")
		checkout := remote.clone(t)
		before := captureWorkspace(t, checkout)

		// Something else owns the path the checkout would take — G6's `worktree add` failure.
		occupied := filepath.Join(worktreesDir(), "s-blocked-conjunction")
		if err := os.MkdirAll(occupied, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(occupied, "in-the-way.txt"), []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}

		job := pinnedJob(t, "s-blocked-conjunction", checkout, pinned)
		execDir := setupWorktree(job, checkout)
		if execDir != "" {
			t.Errorf("exec dir %q; the engine would have started without a checkout", execDir)
		}
		assertRefused(t, job, sourceRefusalWorktreeRequired)
		if job.Source.State != sourceStatePinned {
			t.Errorf("state=%s; the pin half held and must stay held", job.Source.State)
		}
		before.mustBeUntouched(t, checkout)
	})

	t.Run("a surviving checkout that is off the pin is not a checkout this run may use", func(t *testing.T) {
		t.Setenv("ORBIT_HOME", t.TempDir())
		remote := newRemoteRepo(t)
		pinned := remote.advanceMain(t, "pinned.txt", "pinned\n")
		checkout := remote.clone(t)

		job := pinnedJob(t, "s-offbase", checkout, pinned)
		if execDir := setupWorktree(job, checkout); execDir == "" {
			t.Fatalf("the first run refused: %v", job.SourceRefusal)
		}
		wtPath := job.WT.Path
		// The checkout survives the crash but no longer stands on the frozen commit — something
		// reset it onto a history the pin is not in. "A checkout exists" is not the second half of
		// SR33's conjunction; "a checkout on THIS commit" is.
		mustGit(t, wtPath, "checkout", "--orphan", "elsewhere")
		mustGit(t, wtPath, "rm", "-rf", ".")
		commitFile(t, wtPath, "elsewhere.txt", "another history\n", "moved off the baseline")
		if _, err := git(wtPath, "merge-base", "--is-ancestor", pinned, "HEAD"); err == nil {
			t.Fatal("the fixture did not actually move the checkout off the pin")
		}

		reclaim := pinnedJob(t, "s-offbase", checkout, pinned)
		execDir := setupWorktree(reclaim, checkout)
		if execDir != "" {
			t.Errorf("exec dir %q; the engine would have run against a checkout off its baseline", execDir)
		}
		assertRefused(t, reclaim, sourceRefusalWorktreeRequired)
		if cause := reclaim.SourceRefusal.Detail["cause"]; cause != "checkout-off-base" {
			t.Errorf("refusal cause %v, want checkout-off-base", cause)
		}
	})

	t.Run("both halves: the engine gets an exec dir standing on the pin", func(t *testing.T) {
		t.Setenv("ORBIT_HOME", t.TempDir())
		remote := newRemoteRepo(t)
		pinned := remote.advanceMain(t, "pinned.txt", "pinned\n")
		checkout := remote.clone(t)

		srv := newPinServer(t)
		job := selectedJob(checkout)
		job.SessionID = "s-conjunction-ok"
		if err := ensureSourcePinned(context.Background(), NewTransport(srv.URL, "tok"), job); err != nil {
			t.Fatalf("ensureSourcePinned: %v", err)
		}
		if job.Source.State != sourceStatePinned {
			t.Fatalf("state=%s, want %s", job.Source.State, sourceStatePinned)
		}
		execDir := setupWorktree(job, checkout)
		mustStartOn(t, job, execDir, pinned)
		if !strings.HasPrefix(execDir, worktreesDir()) {
			t.Errorf("exec dir %q is not this session's own checkout", execDir)
		}
	})
}
