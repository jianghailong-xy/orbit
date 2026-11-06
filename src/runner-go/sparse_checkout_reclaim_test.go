//go:build linux

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// unquotedName is a path under a left-out directory that `git ls-files` quotes unless told -z.
const unquotedName = "docs/mocks/café.png"

// sparseResumableCheckout is a sparse checkout of a session the control plane calls resumable, made by the runner
// from a repository that declares what its checkouts leave out, with the session's work committed and pushed and
// nothing written in it for twenty days, and a cold supervisor standing on it.
func sparseResumableCheckout(t *testing.T, f *resumableFixture, session string) *ClaimedSession {
	t.Helper()
	files := declaringTree(true)
	files[unquotedName] = "a board whose name git quotes\n"
	commitTree(t, f.repo, "declare what session checkouts leave out", files)
	mustGit(t, f.repo, "push", "-q", "origin", "main")
	job := &ClaimedSession{SessionID: session, Branch: "orbit/" + session}
	requireSparseCheckout(t, setupWorktree(job, f.repo), "the checkout as it was first made")
	commitAndPush(t, job.WT.Path, "src/work.go", "package app // the session's work\n")
	ageCheckout(t, job.WT.Path, 20)
	f.set(func() { f.answers[session] = "resumable" })
	if _, added := f.pool.register(job, func() {}, false); !added {
		t.Fatal("register a cold supervisor")
	}
	return job
}

// A sparse checkout the sweep reclaims comes back sparse, through each door a resting session wakes through: the
// claim that wakes its supervisor (restoreAbsentCheckout), a new supervisor for it (setupWorktree), and a run pinned
// to its project's line (setupSourceWorktree). It has to be reclaimable in the first place: every path it leaves
// out is marked skip-worktree, which the sweep would otherwise read as an edit git status cannot see
// (checkoutHasNothingToLose), and one of them has a name git quotes.
func TestAReclaimedSparseCheckoutComesBackSparse(t *testing.T) {
	doors := map[string]func(t *testing.T, f *resumableFixture, wt *Worktree) string{
		"the claim that wakes its supervisor": func(t *testing.T, f *resumableFixture, wt *Worktree) string {
			claim := &ClaimedSession{SessionID: wt.Session, Branch: wt.Branch}
			restoreAbsentCheckout(f.pool, claim)
			if claim.SourceRefusal != nil {
				t.Fatalf("refused: %+v", claim.SourceRefusal)
			}
			return wt.Path
		},
		"a new supervisor": func(t *testing.T, f *resumableFixture, wt *Worktree) string {
			job := &ClaimedSession{SessionID: wt.Session, Branch: wt.Branch}
			execDir := setupWorktree(job, f.repo)
			if job.SourceRefusal != nil || execDir != wt.Path {
				t.Fatalf("setupWorktree = %q, refusal %+v", execDir, job.SourceRefusal)
			}
			return execDir
		},
		"a run pinned to its line": func(t *testing.T, f *resumableFixture, wt *Worktree) string {
			job := &ClaimedSession{SessionID: wt.Session, Branch: wt.Branch, Source: &SessionSource{State: sourceStatePinned, BaseSha: wt.BaseSha}}
			execDir := setupWorktree(job, f.repo)
			if job.SourceRefusal != nil || execDir != wt.Path {
				t.Fatalf("setupWorktree = %q, refusal %+v", execDir, job.SourceRefusal)
			}
			return execDir
		},
	}
	for name, door := range doors {
		t.Run(name, func(t *testing.T) {
			f := newResumableFixture(t)
			job := sparseResumableCheckout(t, f, "sess-sparse")
			path := job.WT.Path

			sweepOnFullDisk(f)
			requireCheckoutReclaimed(t, path, "an idle, clean, pushed sparse checkout of a resumable session, under the floor")

			var execDir string
			logs := captureLogs(t, func() { execDir = door(t, f, job.WT) })

			requireCheckoutOnDisk(t, execDir, "it comes back")
			requireSparseCheckout(t, execDir, "the checkout as it comes back")
			if !checkoutAbsent(filepath.Join(execDir, unquotedName)) {
				t.Errorf("%s should be left out of the checkout as it comes back", unquotedName)
			}
			if _, err := os.Stat(filepath.Join(execDir, "src", "work.go")); err != nil {
				t.Errorf("the session's own work should come back with it: %v", err)
			}
			if want := "session sess-sparse — sparse checkout: .orbit/checkout-exclude at " + shortSha(job.WT.BaseSha) + " leaves out docs/mocks/, docs/evidence/"; !strings.Contains(logs, want) {
				t.Errorf("the log should say what the checkout leaves out (%q), got:\n%s", want, logs)
			}
		})
	}
}

// A sparse checkout is kept like any other when something is hidden under a mark git status does not look past: a
// file written at a left-out path whose skip-worktree mark still stands (sparse.expectFilesOutsideOfPatterns keeps
// a git from 2.36 on from clearing it, as 2.34 and 2.35 never do), here one with a name git quotes.
func TestResumableSweepKeepsASparseCheckoutWithAFileUnderASkipWorktreeMark(t *testing.T) {
	f := newResumableFixture(t)
	job := sparseResumableCheckout(t, f, "sess-hidden")
	path := job.WT.Path
	mustGit(t, path, "config", "--worktree", "sparse.expectFilesOutsideOfPatterns", "true")
	writeUnder(t, path, unquotedName, "an edit git status will not show\n")
	if status := mustGit(t, path, "status", "--porcelain"); status != "" {
		t.Fatalf("the point of this case is a clean status, got %q", status)
	}
	ageCheckout(t, path, 20)
	neighbour := f.checkout(t, "sess-neighbour")

	sweepOnFullDisk(f)

	requireCheckoutOnDisk(t, path, "a file under a skip-worktree mark")
	requireCheckoutReclaimed(t, neighbour, "its neighbour goes, so the sweep did run")
}
