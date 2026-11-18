package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// A finished task's work is frozen as the tip its session ends on (contract §10.5 O-L4), and the
// finalize commit — what the session left uncommitted, captured at its end (SR13) — is part of that
// work. So an ending session's finalize reports the tip AFTER that commit, in a real repository, for
// a session that succeeded and for one that failed alike.
func TestFinalizeReportCarriesTheTipAfterTheFinalizeCommit(t *testing.T) {
	for _, status := range []string{stSucceeded, stFailed} {
		t.Run(status, func(t *testing.T) {
			wt := sessionWorktree(t, "sTip"+status)
			before := mustGit(t, wt.RepoDir, "rev-parse", "refs/heads/"+wt.Branch)

			var req RunFinalizeRequest
			finalizeWorktreeReport(&req, wt.Session, wt, status)

			after := mustGit(t, wt.RepoDir, "rev-parse", "refs/heads/"+wt.Branch)
			if after == before {
				t.Fatalf("CONTROL: finalize committed nothing onto %s", wt.Branch)
			}
			if req.BranchSha != after {
				t.Fatalf("finalize reported branchSha %q, want the tip after its own commit %s (the last live tip was %s)",
					req.BranchSha, after, before)
			}
			if _, err := git(wt.RepoDir, "cat-file", "-e", req.BranchSha+":work.txt"); err != nil {
				t.Fatalf("the reported tip %s does not carry the session's leftover work: %v", req.BranchSha, err)
			}
		})
	}
}

// The tip follows the branch the checkout ended on, as `worktreeBranch` names it in the same report:
// an agent that ran `git checkout -b` has its work on that branch, not on the one it was started on.
func TestFinalizeReportTipIsTheTipOfTheBranchItNames(t *testing.T) {
	wt := sessionWorktree(t, "sMoved")
	mustGit(t, wt.Path, "checkout", "-q", "-b", "feature/the-work")

	var req RunFinalizeRequest
	finalizeWorktreeReport(&req, wt.Session, wt, stSucceeded)

	if req.WorktreeBranch != "feature/the-work" {
		t.Fatalf("CONTROL: worktreeBranch = %q, want feature/the-work", req.WorktreeBranch)
	}
	if want := mustGit(t, wt.RepoDir, "rev-parse", "refs/heads/feature/the-work"); req.BranchSha != want {
		t.Fatalf("branchSha = %q, want the tip of feature/the-work %s", req.BranchSha, want)
	}
	if started := mustGit(t, wt.RepoDir, "rev-parse", "refs/heads/"+wt.Branch); req.BranchSha == started {
		t.Fatalf("branchSha %s is the tip of the branch the session was started on", started)
	}
}

// A park checkpoint is undone when the session resumes (uncommitParkCheckpoint), so it is not the tip
// the work ends on and is not reported as one: the commit under it is.
func TestParkCheckpointFinalizeReportsTheTipUnderIt(t *testing.T) {
	wt := sessionWorktree(t, "sPark")
	under := mustGit(t, wt.RepoDir, "rev-parse", "refs/heads/"+wt.Branch)

	var req RunFinalizeRequest
	finalizeWorktreeReport(&req, wt.Session, wt, stCancelled)

	message := mustGit(t, wt.RepoDir, "log", "-1", "--format=%B", "refs/heads/"+wt.Branch)
	if !strings.Contains(message, parkCheckpointTrailer+": "+wt.Session) {
		t.Fatalf("CONTROL: the park checkpoint was not committed; head message %q", message)
	}
	if checkpoint := mustGit(t, wt.RepoDir, "rev-parse", "refs/heads/"+wt.Branch); req.BranchSha == checkpoint {
		t.Fatalf("a park checkpoint reported itself %s as the tip", checkpoint)
	}
	if req.BranchSha != under {
		t.Fatalf("branchSha = %q, want the commit under the park checkpoint %s", req.BranchSha, under)
	}
}

// The 0.1.253 bump (task 34vJmfV0DZk5cySoXlB3r, 2026-11-10): the session's checkout started at the
// project branch's tip, the agent fast-forwarded it to main and committed, the acceptance passed,
// and the control plane ended the run (`task_done`), which the runner finalizes as a cancel. That
// finalize sent no tip, so the stored one stayed whatever the last live report had said, a tip
// from before the agent's commit, and the DONE task's delivered commit was frozen from it. A run
// ended this way with nothing left uncommitted reports its branch's real tip.
func TestCancelledFinalizeReportsTheTipTheRunCommitted(t *testing.T) {
	wt := sessionWorktree(t, "sDone")
	started := mustGit(t, wt.RepoDir, "rev-parse", "refs/heads/"+wt.Branch)
	mustGit(t, wt.Path, "add", "-A")
	mustGit(t, wt.Path, "commit", "-q", "-m", "chore(release): the run's own commit")
	committed := mustGit(t, wt.RepoDir, "rev-parse", "refs/heads/"+wt.Branch)
	if committed == started {
		t.Fatal("CONTROL: the run's commit did not move its branch")
	}

	var req RunFinalizeRequest
	finalizeWorktreeReport(&req, wt.Session, wt, stCancelled)

	if after := mustGit(t, wt.RepoDir, "rev-parse", "refs/heads/"+wt.Branch); after != committed {
		t.Fatalf("CONTROL: a clean cancelled finalize moved the branch from %s to %s", committed, after)
	}
	if req.BranchSha != committed {
		t.Fatalf("cancelled finalize reported branchSha %q, want the tip the run committed %s (the run started at %s)",
			req.BranchSha, committed, started)
	}
	encoded, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"branchSha":"`+committed+`"`) {
		t.Fatalf("the finalize body does not carry the tip: %s", encoded)
	}
}
