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
// the work ends on and is not reported as one: the last live report's tip stands.
func TestParkCheckpointFinalizeReportsNoTip(t *testing.T) {
	wt := sessionWorktree(t, "sPark")

	var req RunFinalizeRequest
	finalizeWorktreeReport(&req, wt.Session, wt, stCancelled)

	message := mustGit(t, wt.RepoDir, "log", "-1", "--format=%B", "refs/heads/"+wt.Branch)
	if !strings.Contains(message, parkCheckpointTrailer+": "+wt.Session) {
		t.Fatalf("CONTROL: the park checkpoint was not committed; head message %q", message)
	}
	if req.BranchSha != "" {
		t.Fatalf("a park checkpoint reported branchSha %q", req.BranchSha)
	}
	encoded, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), `"branchSha"`) {
		t.Fatalf("a park checkpoint's finalize sent a branchSha: %s", encoded)
	}
}
