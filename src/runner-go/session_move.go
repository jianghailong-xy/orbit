package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// sessionMoveCapabilityV1 declares that this runner takes over a session moved to another of its
// workspaces (docs/session-folders-move-design.md §5.5): a checkout the session's old workspace left
// at worktreesDir()/<sessionId> is retired instead of re-attached when it belongs to another
// repository (checkoutBelongsTo), and a Claude conversation is carried over from the directory the
// session last ran in (carryMovedClaudeConversation). The control plane offers a workspace as a place
// to move a session to only when its runner declares this.
const sessionMoveCapabilityV1 = "session-move/v1"

// retiredCheckoutPrefix names the directory a retired checkout still holding work is moved into,
// beside the session checkouts. It is not a session checkout, and gcWorktrees skips it by this
// prefix: the control plane answers any name that is not a session id as removable, and the work in
// it exists nowhere else.
const retiredCheckoutPrefix = "_retired-"

// gitCommonDir is the repository behind a checkout — the main worktree's git dir, which every linked
// worktree of it shares — as an absolute, symlink-resolved path, or "" when git cannot say.
func gitCommonDir(dir string) string {
	out, err := git(dir, "rev-parse", "--git-common-dir")
	if err != nil || out == "" {
		return ""
	}
	if !filepath.IsAbs(out) {
		out = filepath.Join(dir, out)
	}
	if resolved, err := filepath.EvalSymlinks(out); err == nil {
		return resolved
	}
	return filepath.Clean(out)
}

// checkoutBelongsTo reports whether the checkout at wtPath is this job's to re-attach: a worktree of
// the repository at repoRoot, standing on branch. A session moved to a workspace on another
// repository finds the checkout its old workspace left at the same path, and re-attaching that one
// has the agent go on editing the old repository, on a branch the new one's merge cannot find.
//
// HEAD on another branch does not make the checkout someone else's while branch exists in that
// repository: the checkout was made on it there, and the agent moved it (a `git checkout -b`, a
// rebase in progress). That divergence is the heartbeat's to report and Adopt's to settle, and
// retiring the checkout would silently take both away. Only a branch the repository has never had —
// the control plane named a new one — makes the checkout another line of work.
//
// A probe git cannot answer is not evidence: the checkout is kept, as it was before this check.
func checkoutBelongsTo(wtPath, repoRoot, branch string) bool {
	have, want := gitCommonDir(wtPath), gitCommonDir(repoRoot)
	if have == "" || want == "" {
		return true
	}
	if have != want {
		return false
	}
	if head, err := git(wtPath, "symbolic-ref", "--quiet", "--short", "HEAD"); err == nil && head == branch {
		return true
	}
	return branchExists(repoRoot, branch)
}

// retireCheckout takes the checkout at wtPath out of the way of a new one, in the repository it
// belongs to. A checkout whose work is all on its branch is unregistered with `git worktree remove`,
// and the branch stays with the session's work on it. One still holding work nothing else has —
// uncommitted changes, or commits only a detached HEAD reaches — is moved aside whole, to a
// retiredCheckoutPrefix directory beside it, where it is still a worktree of its repository, and
// its HEAD is detached there: git lets a branch be checked out in one worktree only, and a session
// moved back to this repository checks its branch out again.
// An error means the directory is still at wtPath.
func retireCheckout(sessionID, wtPath string) error {
	common := gitCommonDir(wtPath)
	if common == "" {
		return fmt.Errorf("git cannot name the repository %s belongs to", wtPath)
	}
	if _, err := git(wtPath, "symbolic-ref", "--quiet", "HEAD"); err == nil && checkoutWorkIsCaptured(&Worktree{Path: wtPath}) {
		teardownWorktreeProcesses(wtPath)
		_, err := git(common, "worktree", "remove", wtPath)
		if err == nil {
			_, _ = git(common, "update-ref", "-d", baseRefName(sessionID))
			logln(fmt.Sprintf("session %s — retired checkout %s of %s (its branch is kept)", sessionID, wtPath, common))
			return nil
		}
		logln(fmt.Sprintf("session %s — `git worktree remove` of %s failed (%v); moving it aside", sessionID, wtPath, err))
	}
	aside := filepath.Join(worktreesDir(), retiredCheckoutPrefix+filepath.Base(wtPath)+"-"+time.Now().UTC().Format("20060102-150405.000000000"))
	if _, err := git(common, "worktree", "move", wtPath, aside); err != nil {
		// git refuses to move some checkouts it still tracks (one with submodules, a locked one): move
		// the directory itself and point the repository at where it went.
		if err := os.Rename(wtPath, aside); err != nil {
			return err
		}
		_, _ = git(common, "worktree", "repair", aside)
	}
	logln(fmt.Sprintf("session %s — checkout %s of %s holds work no branch has; moved it aside to %s", sessionID, wtPath, common, aside))
	if _, err := git(aside, "checkout", "--quiet", "--detach"); err != nil {
		logln(fmt.Sprintf("session %s — could not detach HEAD in %s, so its branch stays checked out there: %v", sessionID, aside, err))
	}
	return nil
}

// carryMovedClaudeConversation puts a Claude session's conversation where its `--resume` reads it —
// dst, the transcript path for execDir under the config directory base — when the session last ran
// in another directory on this machine: it was moved to another of the machine's workspaces, and
// Claude Code keeps a conversation under the project directory of the cwd it ran in. Only the
// directory runs/<id>/meta.json records the session last running in is read, never every project
// directory holding the same id (see ensureClaudeTranscript). The transcript is copied whole with
// each record's cwd rewritten to execDir, the directory beside it with it; the old place keeps its copy.
//
// A conversation already at dst stays unless the last run's is newer. Newer there means a move back:
// the copy at dst is the one the session left behind, without the turns it had since. A conversation
// continued here — a respawn, any later resume — is newer than the copy it started from.
// Reports whether dst now holds the carried conversation.
func carryMovedClaudeConversation(base string, job *ClaimedSession, execDir, dst string) bool {
	meta := readSessionMeta(filepath.Join(runDir(job.SessionID), "meta.json"))
	if meta == nil {
		return false
	}
	// A run records its own directory before its engine starts, keeping the one before it beside it.
	last := meta.WorkDir
	if last == execDir {
		last = meta.PreviousWorkDir
	}
	if last == "" {
		return false
	}
	src, err := claudeTranscriptPathIn(base, last, job.SessionUUID)
	if err != nil || src == dst || !claudeTranscriptHasConversation(src) {
		return false
	}
	if here, err := os.Stat(dst); err == nil {
		if there, err := os.Stat(src); err != nil || !there.ModTime().After(here.ModTime()) {
			return false
		}
	}
	if err := copyTranscriptRewritingCwd(src, dst, execDir); err != nil {
		logln("claude conversation for", job.SessionUUID, "not carried from", last+":", err)
		return false
	}
	// The directory beside it is best-effort, as for an account move (carryClaudeConversation).
	if err := copyClaudeConversationDir(strings.TrimSuffix(src, ".jsonl"), strings.TrimSuffix(dst, ".jsonl")); err != nil {
		logln("claude conversation for", job.SessionUUID, "carried without its side files:", err)
	}
	logln("claude conversation for", job.SessionUUID, "carried from", last, "to", execDir)
	return true
}
