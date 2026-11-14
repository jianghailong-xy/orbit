package main

import (
	"strings"
	"testing"
)

// Real-Git tests for Discard. They share Move's fixture (main_checkout_actions_test.go) and, like
// it, do not run in parallel: mainCheckoutStep is package state.

func discardCmd(t *testing.T, repo string, files ...string) MainCheckoutActionCommand {
	t.Helper()
	return MainCheckoutActionCommand{MainCheckoutActionRequest: MainCheckoutActionRequest{
		Kind: mainCheckoutDiscard, Root: repo, Fingerprint: mustScan(t, repo).Snapshot.Fingerprint,
		Files: files, RequestID: "discard-" + strings.Join(files, "+"),
	}}
}

// Staged, unstaged, untracked and deleted files go back to HEAD; an unchosen file stays as it was;
// the rescue branch holds every one of them as it was.
func TestDiscardChosenFiles(t *testing.T) {
	f := newMoveFixture(t)
	mcWrite(t, f.repo, "a.txt", "one\nTWO\nthree\n")
	mcWrite(t, f.repo, "staged.txt", "staged v2\n")
	mustGit(t, f.repo, "add", "staged.txt")
	mustGit(t, f.repo, "rm", "-q", "gone.txt")
	mcWrite(t, f.repo, "dir/new.txt", "brand new\n")
	mcWrite(t, f.repo, "other.txt", "changed, not chosen\n")
	mcWrite(t, f.repo, "debug.log", "ignored\n")

	res, err := runMainCheckoutAction(discardCmd(t, f.repo, "a.txt", "staged.txt", "gone.txt", "dir/new.txt"), f.deps())
	if err != nil || res.Status != mainCheckoutDone || res.Code != "" || res.Kind != mainCheckoutDiscard ||
		*res.FileCount != 4 || res.Remaining == nil || *res.Remaining != 1 || res.Branch != "main" || res.RescueBranch == "" {
		t.Fatalf("result %+v %v", res, err)
	}
	requireFiles(t, "checkout", f.repo, map[string]string{
		"a.txt": "one\ntwo\nthree\n", "staged.txt": "staged v1\n", "gone.txt": "to be deleted\n", "dir/new.txt": "<absent>",
		"other.txt": "changed, not chosen\n", "debug.log": "ignored\n",
	})
	if got := porcelain(t, f.repo); got != "M other.txt" {
		t.Fatalf("checkout status %q, want only other.txt modified", got)
	}
	requireRef(t, f.repo, res.RescueBranch, map[string]string{
		"a.txt": "one\nTWO\nthree\n", "staged.txt": "staged v2\n", "gone.txt": "<absent>", "dir/new.txt": "brand new\n",
		"other.txt": "changed, not chosen\n",
	})
	if path, _ := discardJournalPath(f.repo, "discard-a.txt+staged.txt+gone.txt+dir/new.txt"); readMoveJournal(path) != nil {
		t.Fatal("the journal outlived the Discard")
	}
}

// A review that is out of date, or a file that is not changed, discards nothing and saves nothing.
func TestDiscardStaleChangesNothing(t *testing.T) {
	f := newMoveFixture(t)
	mcWrite(t, f.repo, "a.txt", "reviewed\n")
	cmd := discardCmd(t, f.repo, "a.txt")
	mcWrite(t, f.repo, "a.txt", "written after the review\n")
	res, err := runMainCheckoutAction(cmd, f.deps())
	if err != nil || res.Status != mainCheckoutRefused || res.Code != mainCheckoutFingerprintStale {
		t.Fatalf("stale: %+v %v", res, err)
	}
	res, err = runMainCheckoutAction(discardCmd(t, f.repo, "a.txt", "other.txt"), f.deps())
	if err != nil || res.Code != mainCheckoutFingerprintStale || len(res.Paths) != 1 || res.Paths[0] != "other.txt" {
		t.Fatalf("unchanged file: %+v %v", res, err)
	}
	if b := rescueBranches(t, f.repo); len(b) != 0 {
		t.Fatalf("a refused Discard saved %v", b)
	}
	requireFiles(t, "checkout", f.repo, map[string]string{"a.txt": "written after the review\n"})
}

// A Discard stopped part way and delivered again finishes, with the one rescue branch.
func TestDiscardRedoAfterAStop(t *testing.T) {
	for _, step := range []string{"discard-journaled", "discard-restored-tracked"} {
		t.Run(step, func(t *testing.T) {
			f := newMoveFixture(t)
			mcWrite(t, f.repo, "a.txt", "one\nTWO\nthree\n")
			mcWrite(t, f.repo, "new.txt", "new\n")
			cmd := discardCmd(t, f.repo, "a.txt", "new.txt")

			stopAt(t, step, nil)
			if _, err := runMainCheckoutAction(cmd, f.deps()); err != errMainCheckoutStopped {
				t.Fatalf("stop at %s: %v", step, err)
			}
			mainCheckoutStep = func(string) bool { return false }

			res, err := runMainCheckoutAction(cmd, f.deps())
			if err != nil || res.Status != mainCheckoutDone || *res.Remaining != 0 {
				t.Fatalf("redo: %+v %v", res, err)
			}
			if b := rescueBranches(t, f.repo); len(b) != 1 || b[0] != res.RescueBranch {
				t.Fatalf("redo: rescue branches %v, result %q", b, res.RescueBranch)
			}
			if got := porcelain(t, f.repo); got != "" {
				t.Fatalf("checkout status %q", got)
			}
			requireRef(t, f.repo, res.RescueBranch, map[string]string{"a.txt": "one\nTWO\nthree\n", "new.txt": "new\n"})
		})
	}
}
