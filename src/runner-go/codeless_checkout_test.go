package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The codeless half of design §3 (B2): a codeless run is isolated in a detached checkout, and a branch exists
// afterwards only when the run changed something.

func codelessJob(id string) *ClaimedSession {
	return &ClaimedSession{SessionID: id, CodelessCheckout: true, CodelessBranch: "orbit/write-the-notes-abc123"}
}

// finishCodeless is session.go's finalize order: the detached checkout first, then the ordinary report.
func finishCodeless(job *ClaimedSession, status string) RunFinalizeRequest {
	req := RunFinalizeRequest{Status: status, IsolationStatus: job.IsolationStatus}
	if job.Detached != nil {
		finalizeCodelessCheckout(job)
	}
	if job.WT != nil {
		finalizeWorktreeReport(&req, job.SessionID, job.WT, status)
	}
	return req
}

func orbitBranches(t *testing.T, repo string) string {
	t.Helper()
	return mustGit(t, repo, "branch", "--list", "orbit/*")
}

func TestCodelessRunIsIsolatedInADetachedCheckoutWithNoBranch(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	head := mustGit(t, repo, "rev-parse", "HEAD")
	job := codelessJob("s-codeless-setup")

	execDir := setupWorktree(job, repo)

	if job.WT != nil {
		t.Fatalf("a detached codeless checkout must not be job.WT (nothing may report a branch for it): %+v", job.WT)
	}
	if job.Detached == nil || job.IsolationStatus != isoWorktree {
		t.Fatalf("expected an isolated detached checkout, got status %q detached %v", job.IsolationStatus, job.Detached)
	}
	if execDir == repo || !strings.HasPrefix(execDir, worktreesDir()) {
		t.Fatalf("the run must not use the shared workDir: execDir %s", execDir)
	}
	if _, err := git(execDir, "symbolic-ref", "--quiet", "HEAD"); err == nil {
		t.Fatal("the checkout is on a branch; it must be detached")
	}
	if got := mustGit(t, execDir, "rev-parse", "HEAD"); got != head {
		t.Fatalf("checkout HEAD %s, want the workDir's HEAD %s", got, head)
	}
	if got := orbitBranches(t, repo); got != "" {
		t.Fatalf("no branch may exist while the run has none, got %q", got)
	}
}

func TestCodelessRunThatChangedNothingLeavesNoBranchAndNoCheckout(t *testing.T) {
	for _, status := range []string{stSucceeded, stFailed, stCancelled} {
		t.Run(status, func(t *testing.T) {
			t.Setenv("ORBIT_HOME", t.TempDir())
			repo := initRepo(t)
			job := codelessJob("s-codeless-nothing")
			execDir := setupWorktree(job, repo)
			path := job.Detached.Path
			// Ignored output is not work; it goes with the checkout.
			if err := os.WriteFile(filepath.Join(execDir, ".gitignore"), []byte("out/\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			mustGit(t, execDir, "add", ".gitignore")
			mustGit(t, execDir, "reset", "--hard", "-q")
			_ = os.Remove(filepath.Join(execDir, ".gitignore"))

			req := finishCodeless(job, status)

			if req.Branch != "" || len(req.ChangedFiles) != 0 {
				t.Fatalf("a run that changed nothing reported branch %q, files %v", req.Branch, req.ChangedFiles)
			}
			if got := orbitBranches(t, repo); got != "" {
				t.Fatalf("git branch --list orbit/* = %q, want nothing", got)
			}
			if !checkoutAbsent(path) {
				t.Fatalf("the checkout %s was not removed", path)
			}
			if _, err := git(repo, "rev-parse", "--verify", "--quiet", baseRefName(job.SessionID)); err == nil {
				t.Fatal("the base ref outlived the checkout")
			}
			if wts := mustGit(t, repo, "worktree", "list"); strings.Contains(wts, path) {
				t.Fatalf("git still lists the checkout: %s", wts)
			}
		})
	}
}

func TestCodelessRunThatWroteAFileGetsABranchWithThatFile(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	base := mustGit(t, repo, "rev-parse", "HEAD")
	job := codelessJob("s-codeless-wrote")
	execDir := setupWorktree(job, repo)
	if err := os.WriteFile(filepath.Join(execDir, "notes.md"), []byte("findings\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	req := finishCodeless(job, stSucceeded)

	if req.Branch != "orbit/write-the-notes-abc123" {
		t.Fatalf("reported branch %q, want the claim's codelessBranch", req.Branch)
	}
	if got := orbitBranches(t, repo); !strings.Contains(got, "orbit/write-the-notes-abc123") {
		t.Fatalf("git branch --list orbit/* = %q, want the run's branch", got)
	}
	if len(req.ChangedFiles) != 1 || req.ChangedFiles[0].Path != "notes.md" {
		t.Fatalf("changedFiles = %+v, want notes.md", req.ChangedFiles)
	}
	if req.BaseSha != base {
		t.Fatalf("baseSha %s, want the run's base %s", req.BaseSha, base)
	}
	if got := mustGit(t, repo, "show", "orbit/write-the-notes-abc123:notes.md"); got != "findings" {
		t.Fatalf("the branch does not carry the file: %q", got)
	}
	if req.BranchSha != branchAt(repo, "orbit/write-the-notes-abc123") {
		t.Fatalf("branchSha %s is not the branch tip", req.BranchSha)
	}
}

// A commit the agent made on the detached HEAD is work too, and must not be removed with the checkout.
func TestCodelessRunThatCommittedOnTheDetachedHeadKeepsTheCommitOnABranch(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	job := codelessJob("s-codeless-commit")
	execDir := setupWorktree(job, repo)
	mustGit(t, execDir, "config", "user.email", "test@orbit")
	mustGit(t, execDir, "config", "user.name", "Test")
	commitFile(t, execDir, "report.txt", "r\n", "agent commit")
	tip := mustGit(t, execDir, "rev-parse", "HEAD")

	req := finishCodeless(job, stSucceeded)

	if req.Branch == "" || branchAt(repo, req.Branch) != tip {
		t.Fatalf("branch %q at %q, want it at the agent's commit %s", req.Branch, branchAt(repo, req.Branch), tip)
	}
	if len(req.ChangedFiles) != 1 || req.ChangedFiles[0].Path != "report.txt" {
		t.Fatalf("changedFiles = %+v", req.ChangedFiles)
	}
}

// A branch of that name made by something else is never taken over.
func TestCodelessRunDoesNotTakeOverAnExistingBranch(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	mustGit(t, repo, "branch", "orbit/write-the-notes-abc123")
	before := branchAt(repo, "orbit/write-the-notes-abc123")
	job := codelessJob("s-codeless-taken")
	execDir := setupWorktree(job, repo)
	if err := os.WriteFile(filepath.Join(execDir, "x.txt"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	req := finishCodeless(job, stSucceeded)

	if req.Branch == "" || req.Branch == "orbit/write-the-notes-abc123" {
		t.Fatalf("reported branch %q; want a branch of the run's own", req.Branch)
	}
	if branchAt(repo, "orbit/write-the-notes-abc123") != before {
		t.Fatal("the existing branch was moved")
	}
}

// A restart re-attaches the same detached checkout, with the run's uncommitted work in it.
func TestCodelessCheckoutIsReattachedAfterARestart(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	first := codelessJob("s-codeless-restart")
	execDir := setupWorktree(first, repo)
	if err := os.WriteFile(filepath.Join(execDir, "wip.txt"), []byte("wip\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	commitFile(t, repo, "later.txt", "later\n", "the workDir moves on")

	again := codelessJob("s-codeless-restart")
	if got := setupWorktree(again, repo); got != execDir || again.Detached == nil {
		t.Fatalf("re-attach gave %q (detached %v), want %q", got, again.Detached, execDir)
	}
	if again.Detached.BaseSha != first.Detached.BaseSha {
		t.Fatalf("base moved on re-attach: %s, want %s", again.Detached.BaseSha, first.Detached.BaseSha)
	}
	if _, err := os.Stat(filepath.Join(execDir, "wip.txt")); err != nil {
		t.Fatalf("the run's work was lost on re-attach: %v", err)
	}
	if req := finishCodeless(again, stSucceeded); len(req.ChangedFiles) != 1 || req.ChangedFiles[0].Path != "wip.txt" {
		t.Fatalf("changedFiles = %+v, want wip.txt only (not the workDir's later commit)", req.ChangedFiles)
	}
}

// A run handed a branch (an older control plane, or one that already made it) is an ordinary run.
func TestCodelessFlagWithABranchIsAnOrdinaryRun(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	job := codelessJob("s-codeless-branch")
	job.Branch = "orbit/already"
	setupWorktree(job, repo)
	if job.Detached != nil || job.WT == nil || job.WT.Branch != "orbit/already" {
		t.Fatalf("want the ordinary checkout on its branch, got WT %+v detached %+v", job.WT, job.Detached)
	}
}

func TestRunnerDeclaresCodelessCheckout(t *testing.T) {
	if !strings.Contains(runnerCapabilitiesV1, codelessCheckoutCapabilityV1) {
		t.Fatalf("capabilities %q do not declare %s", runnerCapabilitiesV1, codelessCheckoutCapabilityV1)
	}
}
