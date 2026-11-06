package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// A finished session's checkout that still holds work no branch has is the one kind of
// directory gcWorktrees may never remove (removeWorktree refuses it), so before this it was
// carried past every cap forever: nothing could commit it, and nothing could say it was there.
// Two halves close that:
//
//   - reportAbandonedCheckouts tells the control plane which checkouts hold uncommitted work,
//     with the diff, so the runner page can list them and the owner can act;
//   - discardWorktree is what the owner's Discard button runs, through the commit relay that
//     already exists for a finished session (CommitCommand.Discard).
//
// Neither decides anything about a session: the control plane keeps the ones that are finished,
// because the runner is told which checkouts are still wanted, not what a session's status is.

// abandonedCheckoutScanInterval is how often the checkout inventory is recomputed. The set
// changes slowly (a session must finish, a turn must leave work uncommitted), the scan reads
// every checkout's status, and it runs in a goroutine of its own rather than on the claim loop.
const abandonedCheckoutScanInterval = time.Hour

// abandonedCheckoutScanStart delays the first scan past startup, where a reclaim is already
// reading the same directories and the machine has engines to start.
const abandonedCheckoutScanStart = 3 * time.Minute

// abandonedCheckoutPatchBudget bounds the patch text one report carries, across every checkout
// in it. The control plane's request body has a hard limit (10MB, the same one turn-complete
// met), and a report refused for its size would leave the whole inventory stale. A checkout
// past the budget is reported with its file list and no patches; opening it then shows the
// file list without the text, which is a worse answer but a true one.
const abandonedCheckoutPatchBudget = 4 << 20

// runAbandonedCheckoutScans reports the checkouts of finished sessions that hold uncommitted
// work, once at startup and then hourly, until the runner stops.
func runAbandonedCheckoutScans(ctx context.Context, t *Transport, pool *sessionPool) {
	timer := time.NewTimer(abandonedCheckoutScanStart)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			reportAbandonedCheckouts(t, pool)
			timer.Reset(abandonedCheckoutScanInterval)
		}
	}
}

// reportAbandonedCheckouts sends the control plane the runner's whole inventory: every checkout
// it is not working in that `git status --porcelain` calls non-empty, with the diff. A checkout
// absent from the report is one the control plane drops.
//
// What is asked of the control plane is the same question gcWorktrees asks — which checkouts no
// longer have a use — and the same answer's other half: which sessions are at rest and could
// come back. A dirty checkout of either is reported; the control plane decides which of those
// sessions is finished, since the runner is not told that.
func reportAbandonedCheckouts(t *Transport, pool *sessionPool) {
	root := worktreesDir()
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	var names []string
	for _, e := range entries {
		// checkoutDriven, not the pool's ids: a cold supervisor holds no turn, no engine and no
		// job, and nearly every resting session has one after a restart. What this must never
		// report is a checkout somebody is WORKING in, which is exactly what it says.
		if !e.IsDir() || isScratchCheckoutName(e.Name()) ||
			strings.HasPrefix(e.Name(), reclaimingCheckoutPrefix) || pool.checkoutDriven(e.Name()) {
			continue
		}
		names = append(names, e.Name())
	}
	request := AbandonedCheckoutsRequest{Checkouts: []AbandonedCheckout{}}
	if len(names) == 0 {
		_ = t.abandonedCheckouts(request)
		return
	}
	answer, err := t.worktreesJudgement(names)
	if err != nil {
		logln("abandoned checkouts: the control plane could not be asked, keeping the last inventory:", err)
		return
	}
	wanted := make(map[string]bool, len(answer.Removable)+len(answer.Resumable))
	for _, name := range answer.Removable {
		wanted[name] = true
	}
	for _, session := range answer.Resumable {
		wanted[session.ID] = true
	}
	budget := abandonedCheckoutPatchBudget
	for _, name := range names {
		if !wanted[name] {
			// Something of the runner's is at work here, or the session is not one the control
			// plane has given up on. Neither is abandoned work.
			continue
		}
		path := filepath.Join(root, name)
		wt := &Worktree{Path: path, Session: name}
		if !worktreeIsDirty(wt) {
			continue
		}
		// The base ref lives in the main repository, not in the checkout. Without one there is no
		// fork point to diff against — the file list from `git status` is all there is.
		if wt.RepoDir = gitCommonDir(path); wt.RepoDir != "" {
			if base, err := git(wt.RepoDir, "rev-parse", "--verify", "--quiet", baseRefName(name)); err == nil {
				wt.setBaseSha(base)
			}
		}
		files, patches := liveDiff(wt)
		if len(files) == 0 {
			// A checkout whose fork point is gone still holds work: `git status` said so. Say
			// that much, with no diff to show, rather than leaving it out of the inventory.
			files = statusFiles(path)
		}
		if size := patchesBytes(patches); size > budget {
			patches = nil
			logln(fmt.Sprintf("abandoned checkouts: the patch text for %s is %d bytes and the report had %d left — listing its files without it", name, size, budget))
		} else {
			budget -= size
		}
		request.Checkouts = append(request.Checkouts, AbandonedCheckout{
			SessionID: name,
			Files:     nonNilChangedFiles(files),
			Patches:   patches,
		})
	}
	if err := t.abandonedCheckouts(request); err != nil {
		logln("abandoned checkouts: report failed, keeping the last inventory:", err)
	}
}

// statusFiles lists what `git status --porcelain` names, for a checkout whose diff cannot be
// computed (no fork point left). Stats are unknown (-1), which the clients already draw as
// "binary or not countable" rather than as a number.
func statusFiles(path string) []ChangedFile {
	out, err := git(path, "status", "--porcelain")
	if err != nil {
		return nil
	}
	var files []ChangedFile
	for _, line := range strings.Split(out, "\n") {
		if len(line) < 4 {
			continue
		}
		status := strings.TrimSpace(line[:2])
		if status == "" {
			continue
		}
		name := line[3:]
		if i := strings.Index(name, " -> "); i >= 0 {
			name = name[i+4:]
		}
		files = append(files, ChangedFile{
			Path: name, Additions: -1, Deletions: -1, Status: status[:1],
		})
	}
	return files
}

func patchesBytes(patches []FilePatch) int {
	total := 0
	for _, p := range patches {
		total += len(p.Patch)
	}
	return total
}

// discardWorktree throws away a session checkout's uncommitted work, at the owner's explicit
// request, and leaves the checkout clean enough for gcWorktrees to reclaim.
//
// The work is FIRST captured into a ref of its own (refs/orbit-discarded/<session>) and only
// then removed from the working tree. A button that destroys the only copy of somebody's work
// is a button that has to survive being pressed by mistake, and an unreachable commit costs
// nothing to keep. A staging or commit failure keeps the checkout exactly as it was: nothing
// may be removed that was not first recorded somewhere.
func discardWorktree(req CommitCommand) commitOutcome {
	wtPath := filepath.Join(worktreesDir(), req.SessionID)
	if _, err := os.Stat(wtPath); os.IsNotExist(err) {
		return commitOutcome{Status: "nochange", Message: "this session's checkout is already gone; nothing was discarded"}
	}
	if !isGitRepo(wtPath) {
		return commitOutcome{Status: "error", Message: "no live worktree for this session"}
	}
	head, err := git(wtPath, "rev-parse", "HEAD")
	if err != nil {
		return commitOutcome{Status: "error", Message: "could not read this checkout's HEAD: " + err.Error()}
	}
	// Record it before removing it. `add -A` honours .gitignore, so what this keeps is exactly
	// what `git status --porcelain` counts as work; in a sparse checkout that includes what was
	// written under a path it leaves out (addAllArgs).
	if _, err := git(wtPath, addAllArgs(wtPath)...); err != nil {
		return commitOutcome{Status: "error", Message: "could not stage the work before discarding it: " + err.Error()}
	}
	discardedRef := "refs/orbit-discarded/" + decodeSessionID(req.SessionID)
	tree, err := git(wtPath, "write-tree")
	if err == nil {
		var commit string
		commit, err = git(wtPath, "commit-tree", tree, "-p", head, "-m", fmt.Sprintf("orbit: discarded work of %s", req.Branch))
		if err == nil {
			_, err = git(wtPath, "update-ref", discardedRef, commit)
		}
	}
	if err != nil {
		return commitOutcome{Status: "error", Message: "could not record the work before discarding it: " + err.Error()}
	}
	if _, err := git(wtPath, "reset", "--hard", head); err != nil {
		return commitOutcome{Status: "error", Message: "could not reset the checkout: " + err.Error()}
	}
	// -d and not -x: what .gitignore names (installed dependencies, build output) is what makes
	// this checkout worth keeping at all, and it is not work.
	if _, err := git(wtPath, "clean", "-fd"); err != nil {
		return commitOutcome{Status: "error", Message: "could not remove the untracked files: " + err.Error()}
	}
	if !checkoutWorkIsCaptured(&Worktree{Path: wtPath}) {
		return commitOutcome{Status: "error", Message: "the checkout still reports changes after the discard"}
	}
	logln(fmt.Sprintf("discarded the uncommitted work in %s; it is kept at %s", req.SessionID, discardedRef))
	return commitOutcome{Status: "discarded", Message: fmt.Sprintf("Discarded. The work is kept at %s in this repository if it is needed again.", discardedRef)}
}
