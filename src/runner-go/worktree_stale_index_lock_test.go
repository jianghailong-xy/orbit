package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ageIndexLock backdates the checkout's index.lock so it reads as one nothing has touched for
// longer than staleIndexLockAge — the state the 2026-09-16 sweep of this machine found 22 of,
// the oldest four days old.
func ageIndexLock(t *testing.T, dir string, age time.Duration) string {
	t.Helper()
	gitDir := mustGit(t, dir, "rev-parse", "--absolute-git-dir")
	lock := filepath.Join(gitDir, "index.lock")
	when := time.Now().Add(-age)
	if err := os.Chtimes(lock, when, when); err != nil {
		t.Fatal(err)
	}
	return lock
}

// TestFinalizeBreaksAnAbandonedIndexLock is the whole point of the change: a session whose work
// exists only in its checkout, and an index.lock left behind by a git that died (a runner restart
// or self-update is the known source), must still finish with its work on its branch.
//
// The combination this prevents is "task DONE, acceptance command passed, not one commit on the
// branch": the acceptance command runs against the working tree, where the work is, so it passes
// there whether or not anything was ever committed — and the commit that would have captured it
// comes afterwards, and used to be refused by this file.
func TestFinalizeBreaksAnAbandonedIndexLock(t *testing.T) {
	wt := lockedIndexWorktree(t, "sAbandoned")
	lock := ageIndexLock(t, wt.Path, 2*staleIndexLockAge)

	files, _, err := finalizeWorktree(wt, false)
	if err != nil {
		t.Fatalf("an abandoned lock must not keep a session's work off its branch: %v", err)
	}
	if _, err := git(wt.RepoDir, "cat-file", "-e", wt.Branch+":work.txt"); err != nil {
		t.Fatalf("the work must be committed on %s: %v", wt.Branch, err)
	}
	if len(files) != 1 || files[0].Path != "work.txt" {
		t.Fatalf("the captured work must be reported as a diff, got %+v", files)
	}
	if _, err := os.Stat(lock); !os.IsNotExist(err) {
		t.Fatalf("the abandoned lock must be gone, not worked around: %v", err)
	}
}

// TestFinalizeLeavesAFreshIndexLockAlone: the evidence has to be able to say no. A lock written a
// moment ago is what a live git holds while it writes the new index, and breaking that one would
// make finalization the thing that corrupts somebody else's commit. Finalize reports the failure
// instead — which, unlike the silence this replaces, is a report somebody can read.
func TestFinalizeLeavesAFreshIndexLockAlone(t *testing.T) {
	wt := lockedIndexWorktree(t, "sFresh")
	gitDir := mustGit(t, wt.Path, "rev-parse", "--absolute-git-dir")
	lock := filepath.Join(gitDir, "index.lock")

	_, _, err := finalizeWorktree(wt, false)
	if err == nil {
		t.Fatal("a lock young enough to belong to a live git must not be broken")
	}
	if !strings.Contains(err.Error(), "index.lock") {
		t.Fatalf("the failure must still carry git's own words: %v", err)
	}
	if _, statErr := os.Stat(lock); statErr != nil {
		t.Fatalf("the fresh lock must still be there: %v", statErr)
	}
}

// TestNonEmptyIndexLockIsNeverBroken: git writes the new index INTO index.lock before renaming it
// over index, so a lock with bytes in it is one being written through right now, however long ago
// it was created.
func TestNonEmptyIndexLockIsNeverBroken(t *testing.T) {
	wt := sessionWorktree(t, "sWriting")
	gitDir := mustGit(t, wt.Path, "rev-parse", "--absolute-git-dir")
	lock := filepath.Join(gitDir, "index.lock")
	if err := os.WriteFile(lock, []byte("half a written index"), 0o644); err != nil {
		t.Fatal(err)
	}
	ageIndexLock(t, wt.Path, 2*staleIndexLockAge)

	broke, why := breakStaleIndexLock(wt.Path)
	if broke {
		t.Fatalf("a lock with content in it is being written and must be left alone: %s", why)
	}
	if !strings.Contains(why, "being written") {
		t.Fatalf("the refusal must say which test it failed, got %q", why)
	}
	if _, err := os.Stat(lock); err != nil {
		t.Fatalf("the lock must still be there: %v", err)
	}
}

// TestTheSharedRepositorysIndexLockIsNeverBroken is the line drawn by hand every time one of these
// was cleared, now drawn in code: `.git/worktrees/<session>/index.lock` belongs to one session and
// `<repo>/.git/index.lock` belongs to everybody — concurrent sessions and whoever is at the
// keyboard — and nothing here is entitled to break the second one, at any age.
func TestTheSharedRepositorysIndexLockIsNeverBroken(t *testing.T) {
	repo := initRepo(t)
	lock := filepath.Join(repo, ".git", "index.lock")
	if err := os.WriteFile(lock, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	when := time.Now().Add(-100 * staleIndexLockAge)
	if err := os.Chtimes(lock, when, when); err != nil {
		t.Fatal(err)
	}

	for name, breakLock := range map[string]func(string) (bool, string){
		"finalize": breakStaleIndexLock,
		"commit":   breakAbandonedIndexLock,
	} {
		broke, why := breakLock(repo)
		if broke {
			t.Fatalf("%s: the shared repository's index.lock must never be broken: %s", name, why)
		}
		if !strings.Contains(why, "shared repository") {
			t.Fatalf("%s: the refusal must name what it declined to touch, got %q", name, why)
		}
	}
	if _, err := os.Stat(lock); err != nil {
		t.Fatalf("the shared lock must still be there: %v", err)
	}
}
