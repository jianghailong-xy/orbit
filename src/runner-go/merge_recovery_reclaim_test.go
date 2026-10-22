package main

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// Repair checkouts no check comes back to are reclaimed — `git worktree remove` without --force, then
// a prune — and their branches kept: the previous check's when a check starts over or finds the
// session already on origin, the applied recovery's once its candidate landed and the local target has
// it, and any left clean and untouched for two weeks by the worktree sweep. A checkout that is not
// clean, not its repair branch's, or not a repair checkout in the worktrees root is kept. A check that
// stops before it reaches the repair answers with the repair as it stands, so the next check carries it.

// reclaimed checks that r's repair checkout is gone, directory and registration, and its branch kept at tip.
func reclaimed(t *testing.T, repo string, r *MergeRecovery, tip string) {
	t.Helper()
	requireCheckoutReclaimed(t, r.RepairWorktree, "a repair checkout no check comes back to")
	if strings.Contains(mustGit(t, repo, "worktree", "list", "--porcelain"), r.RepairWorktree) {
		t.Fatalf("%s is still registered", r.RepairWorktree)
	}
	if got := mustGit(t, repo, "rev-parse", "refs/heads/"+r.RepairBranch); got != tip {
		t.Fatalf("the repair branch %s is at %s, want it kept at %s", r.RepairBranch, got, tip)
	}
}

// keptAsItWas checks that the checkout at dir is still there, registered, and exactly as it was: state is
// checkoutState's reading of it beforehand.
func keptAsItWas(t *testing.T, repo, dir, state string) {
	t.Helper()
	requireCheckoutOnDisk(t, dir, "a checkout the recovery may not remove")
	if !worktreeRegistered(repo, dir) {
		t.Fatalf("%s is no longer registered", dir)
	}
	if got := checkoutState(t, dir); got != state {
		t.Fatalf("the kept checkout changed:\n%s\nwant\n%s", got, state)
	}
}

// held checks an answer that stopped short of the first check's repair and kept it as it stands: its
// branch, checkout and phase, the source and target tips it is synchronized with and their histories,
// no candidate, and no other checkout.
func (f *carryFixture) held(t *testing.T, r *MergeRecovery, code string) {
	t.Helper()
	if r.Code != code || r.CandidateSha != "" || r.RepairBranch != f.first.RepairBranch || r.RepairWorktree != f.first.RepairWorktree ||
		r.Phase != f.first.Phase || r.RebaseBaseSha != f.first.RebaseBaseSha ||
		r.SourceSha != f.first.SourceSha || r.LocalSha != f.first.LocalSha || r.RemoteSha != f.first.RemoteSha ||
		!slices.Equal(commitShas(r.LocalCommits), commitShas(f.first.LocalCommits)) ||
		!slices.Equal(commitShas(r.RemoteCommits), commitShas(f.first.RemoteCommits)) {
		t.Fatalf("want %s keeping the repair as it stands, got %+v", code, r)
	}
	f.repairs(t, 1)
}

// A check that starts over makes a new checkout for its new attempt. The previous check's, finished and
// clean, is nobody's any more: it goes, and its branch keeps the repair.
func TestMergeRecoveryReclaimStartingOverRemovesThePreviousCheckout(t *testing.T) {
	f := newCarryFixture(t, "SOURCE_REPLAY", "shared.txt")
	repaired := f.repair(t, f.first, map[string]string{"shared.txt": "resolved\n"})
	f.addToSource(t, "more.txt")

	r := f.check(t, f.first)

	if r.Code != "CONFLICT" || r.RepairBranch == f.first.RepairBranch || r.RepairWorktree == f.first.RepairWorktree {
		t.Fatalf("want the new source's replay in a new checkout, got %+v", r)
	}
	requireCheckoutOnDisk(t, r.RepairWorktree, "the new attempt's checkout")
	reclaimed(t, f.repo, f.first, repaired)
	f.repairsLeft(t, 1, 2)
}

// An applied recovery is over once its candidate is on origin and the local target has it. Its
// checkout goes and its branch stays at the candidate: right away when the apply syncs the local
// target, or after LOCAL_SYNC_PENDING, which keeps the checkout, once sync-local does.
func TestMergeRecoveryReclaimAppliedCheckout(t *testing.T) {
	t.Run("applied", func(t *testing.T) {
		repo, _, req := recoveryFixture(t)
		r := mergeToMain(req).Recovery
		if r == nil || r.Code != "READY" {
			t.Fatalf("preview: %+v", r)
		}
		req.RecoveryAction, req.Recovery = "apply", r

		if out := mergeToMain(req); out.Status != "merged" || out.Recovery == nil || out.Recovery.Code != "DONE" {
			t.Fatalf("apply: %+v", out)
		}

		reclaimed(t, repo, r, r.CandidateSha)
		if dirs := recoveryWorktrees(t); len(dirs) != 0 {
			t.Fatalf("repair checkouts left: %v", dirs)
		}
	})
	t.Run("synced_after_LOCAL_SYNC_PENDING", func(t *testing.T) {
		repo, _, req := recoveryFixture(t)
		r := mergeToMain(req).Recovery
		if r == nil || r.Code != "READY" {
			t.Fatalf("preview: %+v", r)
		}
		// The candidate is on origin, and an untracked file in its way holds the local target back.
		mustGit(t, repo, "push", "origin", r.CandidateSha+":refs/heads/main")
		blocker := filepath.Join(repo, "remote.txt")
		if err := os.WriteFile(blocker, []byte("untracked work"), 0o600); err != nil {
			t.Fatal(err)
		}
		req.RecoveryAction, req.Recovery = "apply", r
		out := mergeToMain(req)
		if out.Status != "merged" || out.Recovery == nil || out.Recovery.Code != "LOCAL_SYNC_PENDING" {
			t.Fatalf("apply: %+v", out)
		}
		requireCheckoutOnDisk(t, r.RepairWorktree, "the local target still waits for the candidate")
		if err := os.Remove(blocker); err != nil {
			t.Fatal(err)
		}
		req.RecoveryAction, req.Recovery = "sync-local", out.Recovery

		if out = mergeToMain(req); out.Status != "merged" || out.Recovery == nil || out.Recovery.Code != "DONE" {
			t.Fatalf("sync-local: %+v", out)
		}

		reclaimed(t, repo, r, r.CandidateSha)
	})
}

// After a repair the session's commit reached origin by another route: ALREADY_LANDED, nothing is
// left to repair, and the previous check's checkout goes with its branch kept.
func TestMergeRecoveryReclaimAlreadyLandedRemovesThePreviousCheckout(t *testing.T) {
	f := newCarryFixture(t, "TARGET_SYNC", "shared.txt")
	repaired := f.repair(t, f.first, map[string]string{"shared.txt": "resolved\n"})
	f.landOnOrigin(t, "Feature work, merged elsewhere", map[string]string{"feature.txt": "feature\n"})

	r := f.check(t, f.first)

	if r.Code != "ALREADY_LANDED" || r.RepairBranch != "" || r.RepairWorktree != "" {
		t.Fatalf("want ALREADY_LANDED, got %+v", r)
	}
	reclaimed(t, f.repo, f.first, repaired)
	f.repairsLeft(t, 0, 1)
}

// A checkout that is not clean holds something its branch lacks, so it stays wherever its recovery is
// done with it, exactly as it is; the check answers as it would have.
func TestMergeRecoveryReclaimKeepsAnUncleanCheckout(t *testing.T) {
	// An untracked file leaves a finished repair finished, so the changed source starts the check over,
	// but no branch holds it.
	t.Run("untracked_file_when_starting_over", func(t *testing.T) {
		f := newCarryFixture(t, "SOURCE_REPLAY", "shared.txt")
		repaired := f.repair(t, f.first, map[string]string{"shared.txt": "resolved\n"})
		if err := os.WriteFile(filepath.Join(f.first.RepairWorktree, "notes.txt"), []byte("repair notes\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		state := checkoutState(t, f.first.RepairWorktree)
		f.addToSource(t, "more.txt")

		r := f.check(t, f.first)

		if r.Code != "CONFLICT" || r.RepairWorktree == "" || r.RepairWorktree == f.first.RepairWorktree {
			t.Fatalf("want the new source's replay in a new checkout, got %+v", r)
		}
		keptAsItWas(t, f.repo, f.first.RepairWorktree, state)
		if mustGit(t, f.repo, "rev-parse", "refs/heads/"+f.first.RepairBranch) != repaired {
			t.Fatal("the kept repair's branch moved")
		}
		f.repairs(t, 2)
	})
	// ALREADY_LANDED comes first even while the repair is unfinished (R2), and the unfinished repair stays.
	t.Run("unfinished_repair_when_already_landed", func(t *testing.T) {
		f := newCarryFixture(t, "TARGET_SYNC", "shared.txt")
		state := checkoutState(t, f.first.RepairWorktree)
		f.landOnOrigin(t, "Feature work, merged elsewhere", map[string]string{"feature.txt": "feature\n"})

		r := f.check(t, f.first)

		if r.Code != "ALREADY_LANDED" {
			t.Fatalf("want ALREADY_LANDED, got %+v", r)
		}
		keptAsItWas(t, f.repo, f.first.RepairWorktree, state)
		f.repairs(t, 1)
	})
	// An edit made in the checkout after the review is in no candidate and on no branch.
	t.Run("edited_after_review_when_applied", func(t *testing.T) {
		repo, _, req := recoveryFixture(t)
		r := mergeToMain(req).Recovery
		if r == nil || r.Code != "READY" {
			t.Fatalf("preview: %+v", r)
		}
		if err := os.WriteFile(filepath.Join(r.RepairWorktree, "feature.txt"), []byte("edited after review\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		state := checkoutState(t, r.RepairWorktree)
		req.RecoveryAction, req.Recovery = "apply", r

		if out := mergeToMain(req); out.Status != "merged" || out.Recovery == nil || out.Recovery.Code != "DONE" {
			t.Fatalf("apply: %+v", out)
		}

		keptAsItWas(t, repo, r.RepairWorktree, state)
	})
}

// A recovery's checkout is the checkout of its repair branch, directly in the worktrees root under the
// recovery- prefix, and nothing else is the recovery's to remove: a repair carried on in its checkout
// on another branch, or a checkout somewhere else, stays as it is — finished and clean though it is.
func TestMergeRecoveryReclaimKeepsACheckoutThatIsNotTheRepairs(t *testing.T) {
	t.Run("another_branch", func(t *testing.T) {
		f := newCarryFixture(t, "SOURCE_REPLAY", "shared.txt")
		f.repair(t, f.first, map[string]string{"shared.txt": "resolved\n"})
		mustGit(t, f.first.RepairWorktree, "switch", "-q", "-c", "repair-elsewhere")
		state := checkoutState(t, f.first.RepairWorktree)

		r := f.check(t, f.first)

		if r.Code != "CONFLICT" || r.RepairWorktree == "" || r.RepairWorktree == f.first.RepairWorktree {
			t.Fatalf("want the check to start over in a new checkout, got %+v", r)
		}
		keptAsItWas(t, f.repo, f.first.RepairWorktree, state)
	})
	for _, where := range []string{"outside_the_worktrees_root", "without_the_recovery_prefix"} {
		t.Run(where, func(t *testing.T) {
			f := newCarryFixture(t, "SOURCE_REPLAY", "shared.txt")
			f.repair(t, f.first, map[string]string{"shared.txt": "resolved\n"})
			moved := filepath.Join(t.TempDir(), "repair")
			if where == "without_the_recovery_prefix" {
				moved = filepath.Join(worktreesDir(), "34hJZLguv2D6kBqsFyjA7") // named as a session's checkout is
			}
			mustGit(t, f.repo, "worktree", "move", f.first.RepairWorktree, moved)
			prior := *f.first
			var err error
			if prior.RepairWorktree, err = filepath.EvalSymlinks(moved); err != nil {
				t.Fatal(err)
			}
			state := checkoutState(t, prior.RepairWorktree)
			f.addToSource(t, "more.txt")

			r := f.check(t, &prior)

			if r.Code != "CONFLICT" || r.RepairWorktree == "" || r.RepairWorktree == prior.RepairWorktree {
				t.Fatalf("want the new source's replay in a new checkout, got %+v", r)
			}
			keptAsItWas(t, f.repo, prior.RepairWorktree, state)
		})
	}
}

// newRepairCheckout makes the checkout a recovery check makes, recovery-<id> on orbit/recovery/<id>,
// with a commit of its own on that branch. Returns its path.
func newRepairCheckout(t *testing.T, repo, id string) string {
	t.Helper()
	path := filepath.Join(worktreesDir(), mergeRecoveryWorktreePrefix+id)
	mustGit(t, repo, "worktree", "add", "-q", "-b", "orbit/recovery/"+id, path, "main")
	commitFile(t, path, "repair.txt", "repair "+id+"\n", "repair "+id)
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}

// untouchedFor sets dir's modification time to age ago, as if nothing had changed in it since.
func untouchedFor(t *testing.T, dir string, age time.Duration) {
	t.Helper()
	then := time.Now().Add(-age)
	if err := os.Chtimes(dir, then, then); err != nil {
		t.Fatal(err)
	}
}

// The worktree sweep reclaims a repair checkout that is clean and has not changed for two weeks — one
// no check came back to — keeping its branch, .gitignored build output or not. A dirty one stays however
// old, as does one with another branch checked out, and a recent one however clean. Session checkouts
// keep the sweep's own rules: on a roomy disk, this one as old stays.
func TestMergeRecoveryReclaimSweepRemovesOldCleanRepairCheckouts(t *testing.T) {
	f := newGCFixture(t)
	session := f.checkout(t, "sess-finished")
	old := newRepairCheckout(t, f.repo, "old")
	f.ignoredArtifact(t, old)
	oldTip := mustGit(t, f.repo, "rev-parse", "orbit/recovery/old")
	edited := newRepairCheckout(t, f.repo, "edited")
	if err := os.WriteFile(filepath.Join(edited, "repair.txt"), []byte("edited\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	untracked := newRepairCheckout(t, f.repo, "untracked")
	if err := os.WriteFile(filepath.Join(untracked, "notes.txt"), []byte("notes\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	switched := newRepairCheckout(t, f.repo, "switched")
	mustGit(t, switched, "switch", "-q", "-c", "repair-elsewhere")
	fresh := newRepairCheckout(t, f.repo, "fresh")
	keep := map[string]string{}
	for _, dir := range []string{edited, untracked, switched, fresh} {
		keep[dir] = checkoutState(t, dir)
	}
	for _, dir := range []string{session, old, edited, untracked, switched} {
		untouchedFor(t, dir, 15*24*time.Hour)
	}
	untouchedFor(t, fresh, 24*time.Hour)

	gcWorktrees(f.transport, map[string]bool{}, roomyDisk())

	reclaimed(t, f.repo, &MergeRecovery{RepairBranch: "orbit/recovery/old", RepairWorktree: old}, oldTip)
	for dir, state := range keep {
		keptAsItWas(t, f.repo, dir, state)
	}
	requireCheckoutOnDisk(t, session, "a session checkout on a roomy disk")
	if f.queries.Load() != 1 {
		t.Fatalf("the sweep asked the control plane %d times, want 1", f.queries.Load())
	}
}

// A check that stops before it reaches the repair — a branch it cannot read, a source past its
// checkpoint, origin out of reach, target histories it cannot join or list — answers with the repair as
// it stands: branch, checkout and phase, and the tips and histories it is synchronized with. Once the
// cause is gone, the next check carries that repair on, in the same checkout, to a target that moved
// meanwhile.
func TestMergeRecoveryEarlyErrorKeepsTheRepair(t *testing.T) {
	for _, c := range []struct {
		code       string
		stop, undo func(t *testing.T, f *carryFixture)
	}{
		{"FETCH_FAILED", func(t *testing.T, f *carryFixture) {
			mustGit(t, f.repo, "remote", "set-url", "origin", filepath.Join(t.TempDir(), "unreachable.git"))
		}, func(t *testing.T, f *carryFixture) {
			mustGit(t, f.repo, "remote", "set-url", "origin", f.bare)
		}},
		{"SOURCE_UNAVAILABLE", func(t *testing.T, f *carryFixture) {
			mustGit(t, f.repo, "branch", "-m", "orbit/feat", "parked/feat")
		}, func(t *testing.T, f *carryFixture) {
			mustGit(t, f.repo, "branch", "-m", "parked/feat", "orbit/feat")
		}},
		{"TARGET_UNAVAILABLE", func(t *testing.T, f *carryFixture) {
			mustGit(t, f.repo, "checkout", "-q", "--detach")
			mustGit(t, f.repo, "branch", "-m", "main", "parked/main")
		}, func(t *testing.T, f *carryFixture) {
			mustGit(t, f.repo, "branch", "-m", "parked/main", "main")
			mustGit(t, f.repo, "checkout", "-q", "main")
		}},
		{"BRANCH_TIP_MISMATCH", func(t *testing.T, f *carryFixture) {
			f.req.RequiredSourceSha = f.base
		}, func(t *testing.T, f *carryFixture) {
			f.req.RequiredSourceSha = f.first.SourceSha
		}},
		// origin force-pushed to a history of its own, then back.
		{"UNRELATED_HISTORY", func(t *testing.T, f *carryFixture) {
			other := t.TempDir()
			mustGit(t, other, "init", "-q", "-b", "main")
			mustGit(t, other, "config", "user.name", "Upstream")
			mustGit(t, other, "config", "user.email", "upstream@orbit")
			commitFile(t, other, "unrelated.txt", "unrelated\n", "a history of its own")
			mustGit(t, other, "push", "-q", "--force", f.bare, "HEAD:main")
		}, func(t *testing.T, f *carryFixture) {
			mustGit(t, f.repo, "push", "-q", "--force", "origin", f.first.RemoteSha+":refs/heads/main")
		}},
		// More than 200 commits on origin the local target lacks, until it takes them in.
		{"PREVIEW_TOO_LARGE", func(t *testing.T, f *carryFixture) {
			other := t.TempDir()
			mustGit(t, other, "clone", "-q", f.bare, ".")
			mustGit(t, other, "config", "user.name", "Upstream")
			mustGit(t, other, "config", "user.email", "upstream@orbit")
			for i := range 201 {
				mustGit(t, other, "commit", "-q", "--allow-empty", "-m", fmt.Sprintf("upstream %d", i))
			}
			mustGit(t, other, "push", "-q", "origin", "HEAD:main")
		}, func(t *testing.T, f *carryFixture) {
			mustGit(t, f.repo, "merge", "-q", "--ff-only", "refs/remotes/origin/main")
		}},
	} {
		t.Run(c.code, func(t *testing.T) {
			f := newCarryFixture(t, "SOURCE_REPLAY", "shared.txt")
			repaired := f.repair(t, f.first, map[string]string{"shared.txt": "resolved\n"})
			c.stop(t, f)

			stopped := f.check(t, f.first)

			f.held(t, stopped, c.code)
			c.undo(t, f)
			later := f.landOnOrigin(t, "later upstream work", map[string]string{"later.txt": "later\n"})
			ready := f.check(t, stopped)
			f.carried(t, ready)
			if ready.Code != "READY" || ready.RemoteSha != later || !targetContainsSource(f.repo, repaired, ready.CandidateSha) {
				t.Fatalf("want the repair carried to origin's new tip, got %+v", ready)
			}
			holds(t, f.repo, ready.CandidateSha, map[string]string{"shared.txt": "resolved", "later.txt": "later", "feature.txt": "feature"})
		})
	}
}
