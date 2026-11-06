//go:build linux

package main

import (
	"strings"
	"testing"
)

// The inventory: a checkout no longer wanted that still has uncommitted work is reported, with
// the diff somebody needs in order to decide whether to commit it or throw it away; a clean one
// and one the runner is working in are not.
func TestAbandonedCheckoutReportCarriesTheDirtyCheckoutsAndTheirDiff(t *testing.T) {
	f := newResumableFixture(t)
	dirty := f.checkout(t, "sess-abandoned")
	writeUnder(t, dirty, "base.txt", "work nobody committed\n")
	f.checkout(t, "sess-clean-and-done")
	live := f.checkout(t, "sess-live")
	writeUnder(t, live, "base.txt", "a turn is writing this\n")
	// A turn is in flight in it: the pool holds the supervisor as active, which is what
	// checkoutDriven reads.
	job := manualWorktreePoolJob("sess-live", "orbit/sess-live")
	job.WT = &Worktree{Path: live, Branch: "orbit/sess-live", RepoDir: f.repo, Session: "sess-live"}
	if _, added := f.pool.register(job, func() {}, true); !added {
		t.Fatal("register the live supervisor")
	}
	// The control plane has given up on all three; the runner is working in one of them.
	f.set(func() {
		for _, id := range []string{"sess-abandoned", "sess-clean-and-done", "sess-live"} {
			delete(f.answers, id)
		}
	})

	reportAbandonedCheckouts(f.transport, f.pool)

	report := f.lastReport(t)
	if len(report.Checkouts) != 1 {
		t.Fatalf("one checkout holds uncommitted work, want it reported alone, got %d: %+v", len(report.Checkouts), report.Checkouts)
	}
	entry := report.Checkouts[0]
	if entry.SessionID != "sess-abandoned" {
		t.Fatalf("reported %q, want sess-abandoned", entry.SessionID)
	}
	var paths []string
	for _, file := range entry.Files {
		paths = append(paths, file.Path)
	}
	if !strings.Contains(strings.Join(paths, ","), "base.txt") {
		t.Fatalf("the changed file must be listed, got %v", paths)
	}
	var patches string
	for _, patch := range entry.Patches {
		patches += patch.Patch
	}
	if !strings.Contains(patches, "work nobody committed") {
		t.Fatalf("the diff must carry what was written, got:\n%s", patches)
	}
}

// A resumable session at rest is reported too: the runner is not told which sessions are
// finished, so the control plane is the one that decides which of these entries to keep.
func TestAbandonedCheckoutReportIncludesResumableSessionsForTheControlPlaneToJudge(t *testing.T) {
	f := newResumableFixture(t)
	path := f.checkout(t, "sess-parked")
	writeUnder(t, path, "base.txt", "parked with work\n")

	reportAbandonedCheckouts(f.transport, f.pool)

	report := f.lastReport(t)
	if len(report.Checkouts) != 1 || report.Checkouts[0].SessionID != "sess-parked" {
		t.Fatalf("a resumable session's dirty checkout must be reported for the control plane to judge, got %+v", report.Checkouts)
	}
}

// Discard is the owner's decision, and it may not be the last word: the work is recorded in a ref
// before anything is removed, and the checkout is left as gcWorktrees needs to find it.
func TestDiscardWorktreeThrowsTheWorkAwayAndKeepsItInARef(t *testing.T) {
	f := newResumableFixture(t)
	path := f.checkout(t, "sess-discard")
	writeUnder(t, path, "base.txt", "precious tracked change\n")
	writeUnder(t, path, "notes/new.txt", "precious untracked file\n")
	tip := mustGit(t, path, "rev-parse", "HEAD")

	res := discardWorktree(CommitCommand{SessionID: "sess-discard", Branch: "orbit/sess-discard"})

	if res.Status != "discarded" {
		t.Fatalf("want discarded, got %q: %s", res.Status, res.Message)
	}
	if out := mustGit(t, path, "status", "--porcelain"); out != "" {
		t.Fatalf("the checkout must be clean after a discard, got:\n%s", out)
	}
	if got := mustGit(t, path, "rev-parse", "HEAD"); got != tip {
		t.Fatalf("the branch tip must not move: want %s, got %s", tip, got)
	}
	if got := mustGit(t, f.repo, "show", "refs/orbit-discarded/sess-discard:base.txt"); got != "precious tracked change" {
		t.Fatalf("the discarded tracked change must be kept in the rescue ref, got %q", got)
	}
	if got := mustGit(t, f.repo, "show", "refs/orbit-discarded/sess-discard:notes/new.txt"); got != "precious untracked file" {
		t.Fatalf("the discarded untracked file must be kept in the rescue ref, got %q", got)
	}
	if !strings.Contains(res.Message, "refs/orbit-discarded/sess-discard") {
		t.Fatalf("the outcome must say where the work went, got %q", res.Message)
	}
}

// A checkout already gone is not an error: the thing the owner asked for is true.
func TestDiscardWorktreeOnAMissingCheckoutChangesNothing(t *testing.T) {
	newResumableFixture(t)

	res := discardWorktree(CommitCommand{SessionID: "sess-gone", Branch: "orbit/sess-gone"})

	if res.Status != "nochange" {
		t.Fatalf("want nochange for a checkout that is not there, got %q: %s", res.Status, res.Message)
	}
}
