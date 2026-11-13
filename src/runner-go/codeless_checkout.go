package main

import (
	"fmt"
	"path/filepath"
	"strings"
)

// A codeless task's run (docs/task-fork-from-session-design.md §3, option B2): isolated in a checkout of its
// own like any run on a workspace with worktrees on, but with no branch until it has something to put on one.
// The control plane creates the session with no branch and claims it with CodelessCheckout and the branch to
// use (CodelessBranch). The checkout is `git worktree add --detach` at the run's base, and is never job.WT
// while it is detached, so no live report names a branch, a branch tip or a diff for it. At finalize:
//   - nothing changed: the checkout is removed, and no branch ever existed;
//   - something changed: CodelessBranch is created at the checkout's HEAD, and the run is finalized on it like
//     any other — committed, and reported with its branch and changed files.

// codelessCheckoutCapabilityV1 declares that this runner honours CodelessCheckout. The control plane hands an
// older runner the branch up front instead. @orbit/shared's CODELESS_CHECKOUT_V1 is the same string.
const codelessCheckoutCapabilityV1 = "codeless-checkout/v1"

// setupCodelessCheckout is setupCheckout for a CodelessCheckout run whose workDir is a git repository: the
// detached checkout, re-attached when this session's is already there. A repository with no commit, or a
// checkout git will not add, runs in the workDir, as a run with a branch would in the same case.
func setupCodelessCheckout(job *ClaimedSession, baseDir string) string {
	repoRoot, err := git(baseDir, "rev-parse", "--show-toplevel")
	if err != nil || repoRoot == "" {
		job.IsolationStatus = isoSharedNoGit
		return baseDir
	}
	wtPath := filepath.Join(worktreesDir(), job.SessionID)
	rel, _ := filepath.Rel(repoRoot, baseDir)
	if rel == "" || rel == "." || strings.HasPrefix(rel, "..") {
		rel = "."
	}
	execDir := filepath.Join(wtPath, rel)

	if isGitRepo(wtPath) {
		_, symErr := git(wtPath, "symbolic-ref", "--quiet", "HEAD")
		if gitCommonDir(wtPath) == gitCommonDir(repoRoot) && symErr != nil {
			// This run's own detached checkout, from before a restart: its work is still in it.
			base, _ := git(repoRoot, "rev-parse", "--verify", "--quiet", baseRefName(job.SessionID))
			if base == "" {
				base, _ = git(wtPath, "rev-parse", "HEAD")
			}
			job.Detached = &Worktree{Path: wtPath, BaseSha: base, RepoDir: repoRoot, Session: job.SessionID}
			job.IsolationStatus = isoWorktree
			logln(fmt.Sprintf("session %s — re-attached detached checkout %s (codeless, no branch)", job.SessionID, wtPath))
			return execDir
		}
		if err := retireCheckout(job.SessionID, wtPath); err != nil {
			job.IsolationStatus = isoSharedNoGit
			logln(fmt.Sprintf("session %s — checkout %s is not this session's and could not be retired (%v); running shared", job.SessionID, wtPath, err))
			return baseDir
		}
	}

	base, err := git(baseDir, "rev-parse", "HEAD")
	if err != nil || base == "" {
		job.IsolationStatus = isoSharedNoGit
		logln(fmt.Sprintf("session %s — repo has no HEAD; running shared (no isolation)", job.SessionID))
		return baseDir
	}
	_, _ = git(repoRoot, "update-ref", baseRefName(job.SessionID), base)
	cloned, err := addSessionCheckout(job.SessionID, repoRoot, wtPath, base, "--detach", wtPath, base)
	if err != nil {
		_, _ = git(repoRoot, "update-ref", "-d", baseRefName(job.SessionID))
		job.IsolationStatus = isoSharedNoGit
		logln(fmt.Sprintf("session %s — `git worktree add --detach` failed (%v); running shared", job.SessionID, err))
		return baseDir
	}
	job.Detached = &Worktree{Path: wtPath, BaseSha: base, RepoDir: repoRoot, Session: job.SessionID}
	job.IsolationStatus = isoWorktree
	job.CheckoutCreation = checkoutCreation(cloned)
	logln(fmt.Sprintf("session %s — isolated in detached checkout %s @ %s (codeless: a branch only if it changes something)",
		job.SessionID, wtPath, shortSha(base)))
	return execDir
}

// codelessCheckoutChanged reports whether a detached checkout holds anything of the run's own: a commit made
// on the detached HEAD, or anything `git add -A` stages (untracked files included, ignored ones not). It
// stages to find out, which is what finalizeWorktree does next anyway. A checkout it cannot read counts as
// changed, so its contents are kept on a branch rather than removed.
func codelessCheckoutChanged(wt *Worktree) bool {
	if head, err := git(wt.Path, "rev-parse", "HEAD"); err != nil || head != wt.BaseSha {
		return true
	}
	if err := stageForFinalize(wt.Path); err != nil {
		return true
	}
	unstageHeldSecrets(wt.Path, nil, wt.Session)
	_, err := git(wt.Path, "diff", "--cached", "--quiet")
	return err != nil || !checkoutWorkIsCaptured(wt)
}

// finalizeCodelessCheckout settles a CodelessCheckout run's checkout at the end of its run: removed when the
// run changed nothing, so no branch is ever made; otherwise switched onto CodelessBranch and made job.WT, for
// finalizeWorktreeReport to commit and report like any other run's. A branch that cannot be made keeps the
// checkout where it is, detached and with the work in it, and the run is reported as having no branch.
func finalizeCodelessCheckout(job *ClaimedSession) {
	wt := job.Detached
	job.Detached = nil
	if !codelessCheckoutChanged(wt) {
		// removeWorktree checks once more that nothing would be lost, and drops the base ref with the checkout.
		removeWorktree(wt, nil)
		logln(fmt.Sprintf("session %s — codeless run changed nothing: removed its checkout %s, no branch made", wt.Session, wt.Path))
		return
	}
	branch := job.CodelessBranch
	if branch == "" || branchExists(wt.RepoDir, branch) {
		// Never take over a branch something else made: name this run's own beside it.
		branch = fmt.Sprintf("orbit/codeless-%s", shortSha(job.SessionID))
	}
	if _, err := git(wt.Path, "checkout", "-b", branch); err != nil {
		logln(fmt.Sprintf("session %s — codeless run changed files, but branch %s could not be made (%v); keeping the detached checkout %s",
			wt.Session, branch, err, wt.Path))
		return
	}
	wt.Branch = branch
	job.WT = wt
	job.Branch = branch
	logln(fmt.Sprintf("session %s — codeless run changed files: made branch %s for them", wt.Session, branch))
}
