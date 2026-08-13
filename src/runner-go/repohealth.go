package main

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

// repoHealthRefreshInterval paces the scan of this machine's shared checkouts. A wedged checkout
// blocks every merge on the runner, so the control plane should learn about it within a minute —
// but the state only changes when a human or an agent runs git in there, so polling faster buys
// nothing.
const repoHealthRefreshInterval = 60 * time.Second

// RepoHealthReport is one shared checkout's state, reported on the heartbeat (mirrors
// @orbit/shared RunnerRepoHealth). "Shared" is the point: worktree isolation gives each session
// its own checkout, but they all fork from — and merge back into — this one, and agents step into
// it for builds because that's where the toolchain lives. Nothing else watches it.
type RepoHealthReport struct {
	Root   string `json:"root"`
	Branch string `json:"branch,omitempty"`
	// State is a repoState* value; see repoRootState. Anything but clean/dirty blocks every merge
	// into this checkout until it's resolved.
	State string `json:"state"`
	// Paths are the tracked files in the way (conflicted first), capped by inspectRepoRoot.
	Paths []string `json:"paths,omitempty"`
	// AgentIDs are the agents whose workDir sits in this checkout, so the UI can attach the
	// warning to the agent the user is looking at without re-deriving repo roots from paths.
	AgentIDs []string `json:"agentIds,omitempty"`
}

// agentWorkDir pairs an agent with the directory its sessions run in; the runner's own configured
// workDir is reported with an empty AgentID.
type agentWorkDir struct {
	AgentID string
	Dir     string
}

// repoHealthProbe caches the last scan for the heartbeat to attach. Like engineHealthProbe it
// refreshes on a background timer and never on the heartbeat goroutine: git in a wedged checkout
// (an index.lock someone left behind) can block indefinitely, and a stale snapshot is a far better
// failure than a heartbeat that stops.
type repoHealthProbe struct {
	mu        sync.Mutex
	snapshot  []RepoHealthReport
	refreshMu sync.Mutex
	// dirs supplies the workDirs to scan, re-read every refresh so agents added since startup are
	// picked up without a restart.
	dirs func() []agentWorkDir
}

func (p *repoHealthProbe) refresh() {
	if !p.refreshMu.TryLock() {
		return // a previous scan is still running (slow or wedged git) — let it finish
	}
	defer p.refreshMu.Unlock()
	next := scanRepoHealth(p.dirs())
	p.mu.Lock()
	p.snapshot = next
	p.mu.Unlock()
}

// snapshotNow returns the last completed scan, or nil before the first one finishes — which the
// heartbeat omits, leaving the server's stored state alone rather than claiming everything's clean.
func (p *repoHealthProbe) snapshotNow() []RepoHealthReport {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.snapshot
}

func (p *repoHealthProbe) run(ctx context.Context) {
	p.refresh()
	ticker := time.NewTicker(repoHealthRefreshInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.refresh()
		}
	}
}

// scanRepoHealth inspects the distinct repo roots behind the given workDirs. Several agents
// usually share one checkout (and a workDir may be a subdir of it), so results are keyed by the
// resolved root and carry every agent that lands there. Non-git dirs are skipped: isolation
// already reports those per session as shared-nogit.
func scanRepoHealth(dirs []agentWorkDir) []RepoHealthReport {
	byRoot := map[string]*RepoHealthReport{}
	for _, d := range dirs {
		if d.Dir == "" {
			continue
		}
		dir := expandTilde(d.Dir)
		root, err := git(dir, "rev-parse", "--show-toplevel")
		if err != nil || root == "" {
			continue
		}
		rep, seen := byRoot[root]
		if !seen {
			st := inspectRepoRoot(root)
			rep = &RepoHealthReport{Root: root, Branch: st.Branch, State: st.State, Paths: st.Paths}
			byRoot[root] = rep
		}
		if d.AgentID != "" && !contains(rep.AgentIDs, d.AgentID) {
			rep.AgentIDs = append(rep.AgentIDs, d.AgentID)
		}
	}
	out := make([]RepoHealthReport, 0, len(byRoot))
	for _, rep := range byRoot {
		sort.Strings(rep.AgentIDs)
		out = append(out, *rep)
	}
	// Stable order so an unchanged machine sends an identical payload every minute.
	sort.Slice(out, func(i, j int) bool { return out[i].Root < out[j].Root })
	return out
}

// sharedCheckoutWatch notices when an isolated session leaves changes in the checkout its worktree
// forked from, instead of in its own.
//
// Nothing prevents that, and the ways in are mundane: the Bash tool's working directory persists
// between calls, so one legitimate `cd <workDir>` (to build an image, to read a file with the
// toolchain that only exists there) silently redirects every later relative-path write. The agent
// then commits on its branch and sees nothing wrong, while the edit sits in the shared checkout —
// where it blocks other sessions' merges, is absent from every branch, and gets baked into the
// next image built from that directory. Telling the author at turn boundaries is the only moment
// anyone can still connect the change to what made it.
//
// Reported once per appearance: the baseline is refreshed after each report, so a path that
// somebody else left dirty, or that this session was already told about, stays quiet.
type sharedCheckoutWatch struct {
	mu   sync.Mutex
	root string
	seen map[string]bool
}

// watchSharedCheckout starts watching the repo root a worktree forked from. Nil for a session that
// isn't isolated: the shared directory IS its workspace, so writing there is the normal case and a
// warning would be noise.
func watchSharedCheckout(wt *Worktree) *sharedCheckoutWatch {
	if wt == nil || wt.RepoDir == "" {
		return nil
	}
	w := &sharedCheckoutWatch{root: wt.RepoDir, seen: map[string]bool{}}
	for _, p := range inspectRepoRoot(w.root).Paths {
		w.seen[p] = true // whatever was already dirty is somebody else's business
	}
	return w
}

// newlyDirty returns the shared checkout's paths that have gone dirty since the last call, and
// folds them into the baseline so the next call stays quiet about them.
func (w *sharedCheckoutWatch) newlyDirty() []string {
	if w == nil {
		return nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	var fresh []string
	current := map[string]bool{}
	for _, p := range inspectRepoRoot(w.root).Paths {
		current[p] = true
		if !w.seen[p] {
			fresh = append(fresh, p)
		}
	}
	w.seen = current // also forgets paths that were cleaned up, so a re-dirtied one reports again
	sort.Strings(fresh)
	return fresh
}

// sharedCheckoutNotice is the transcript line for newly-dirtied paths: what happened, why it isn't
// where the author thinks it is, and where to look.
func sharedCheckoutNotice(root, branch string, paths []string) string {
	where := "this session's branch"
	if branch != "" {
		where = branch
	}
	return fmt.Sprintf(
		"This turn left %s modified in the shared checkout %s, outside this session's worktree: %s. "+
			"Those edits are not on %s, so they won't be merged from here — and a deploy built from that "+
			"directory would ship them. Re-apply them in the worktree if they belong to this session.",
		plural(len(paths), "file"), root, namePaths(paths), where)
}

// repoCleanupOutcome is what a "Clean up checkout" request reports back: whether the checkout is
// usable again, and where the content it was holding went.
type repoCleanupOutcome struct {
	Status string // "done" | "failed"
	// State is the checkout's state afterwards (a repoState* value), so the UI can drop the
	// warning without waiting for the next scan.
	State string
	// RescueBranch names the branch holding everything the checkout had on disk before the
	// repair, or "" when there was nothing to keep. Never deleted by Orbit.
	RescueBranch string
	Message      string
}

// cleanupRepoRoot clears a wedged shared checkout: the repair behind the UI's "Clean up checkout".
//
// It is a rescue, not a reset. Whatever was on disk — conflict markers, half-applied stashes,
// somebody's uncommitted afternoon — is first captured as a real commit on an orbit/rescue-* branch
// that Orbit never touches again, and only then is the checkout returned to HEAD. A repair that
// can silently destroy work is a repair nobody dares click, and this checkout is shared: the person
// clicking usually is not the one who left the mess.
//
// The snapshot is built through a temp index (the same trick stagedLiveDiff uses) because the real
// index is exactly what's broken — conflict stages make `git add` refuse, and writing to it would
// destroy the evidence we're trying to keep.
//
// `allowed` gates which paths may be touched: the control plane names the checkout, and a runner
// must never rewrite a directory that isn't one of its own agents' workDirs.
func cleanupRepoRoot(dir string, allowed func(string) bool) repoCleanupOutcome {
	// Serialized against merges: both mutate this checkout, and a repair landing mid-merge would
	// yank the tree out from under a fast-forward.
	mergeLock.Lock()
	defer mergeLock.Unlock()

	root, err := git(expandTilde(dir), "rev-parse", "--show-toplevel")
	if err != nil || root == "" {
		return repoCleanupOutcome{Status: "failed", Message: "not a git repository on this machine"}
	}
	if allowed != nil && !allowed(root) {
		return repoCleanupOutcome{Status: "failed", Message: "that checkout isn't one this runner works in"}
	}
	before := inspectRepoRoot(root)
	if before.State == repoStateClean {
		return repoCleanupOutcome{Status: "done", State: repoStateClean, Message: "checkout was already clean"}
	}

	rescue, err := rescueWorkingTree(root, before)
	if err != nil {
		// Nothing has been touched yet, so failing here is safe: the checkout stays exactly as
		// wedged as it was, which beats clearing it with no way back.
		return repoCleanupOutcome{Status: "failed", State: before.State,
			Message: clip("could not save the checkout's current state, so nothing was cleared: "+err.Error(), 1000)}
	}

	// Unwind whatever operation is in flight, then take the tree back to HEAD. Each abort is
	// best-effort: the reset below is what actually guarantees the end state, and an abort that
	// refuses (a rebase with no state dir, say) must not stop it.
	switch before.State {
	case repoStateRebase:
		if _, err := git(root, "rebase", "--abort"); err != nil {
			_, _ = git(root, "rebase", "--quit")
		}
	case repoStateMerge:
		_, _ = git(root, "merge", "--abort")
	case repoStateCherryPick:
		_, _ = git(root, "cherry-pick", "--abort")
	case repoStateRevert:
		_, _ = git(root, "revert", "--abort")
	}
	if out, err := git(root, "reset", "--hard", "HEAD"); err != nil {
		return repoCleanupOutcome{Status: "failed", State: inspectRepoRoot(root).State, RescueBranch: rescue,
			Message: clip(fmt.Sprintf("saved to %s, but could not reset the checkout: %s", rescue,
				strings.TrimSpace(out+"\n"+gitStderr(err))), 1000)}
	}
	// Untracked leftovers (the half-applied stash's new files) block a later fast-forward that
	// wants to create the same path. They're in the rescue commit, so removing them loses nothing.
	// No -x: ignored files (node_modules, build output) are not the mess and are expensive to lose.
	_, _ = git(root, "clean", "-fd")

	after := inspectRepoRoot(root)
	msg := fmt.Sprintf("checkout restored to %s", shortSha(headSha(root)))
	if rescue != "" {
		msg += fmt.Sprintf("; what it was holding is saved on %s", rescue)
	}
	if after.State != repoStateClean {
		return repoCleanupOutcome{Status: "failed", State: after.State, RescueBranch: rescue,
			Message: clip(fmt.Sprintf("%s — but the checkout still reads as %s", msg, after.State), 1000)}
	}
	logln(fmt.Sprintf("cleaned up %s (was %s); rescue branch %q", root, before.State, rescue))
	return repoCleanupOutcome{Status: "done", State: after.State, RescueBranch: rescue, Message: msg}
}

// rescueWorkingTree commits the checkout's current on-disk content to a fresh orbit/rescue-* branch
// without touching HEAD, the index, or the working tree, and returns the branch name ("" when the
// tree matches HEAD and there is nothing worth keeping).
//
// Everything runs against a temp index seeded from HEAD: the real one holds the conflict stages
// that make this a rescue in the first place. Ignored files are left out — `add -A` honors
// .gitignore — so node_modules never lands in a rescue commit.
func rescueWorkingTree(root string, state repoRootState) (string, error) {
	head, err := git(root, "rev-parse", "HEAD")
	if err != nil || head == "" {
		return "", fmt.Errorf("checkout has no HEAD to snapshot against")
	}
	tmp, err := os.CreateTemp("", "orbit-rescue-idx-*")
	if err != nil {
		return "", err
	}
	idx := tmp.Name()
	_ = tmp.Close()
	// git rejects a 0-byte index ("index file smaller than expected") and creates a fresh one
	// at this path instead — same dance as stagedLiveDiff.
	_ = os.Remove(idx)
	defer os.Remove(idx)
	env := append(os.Environ(), "GIT_INDEX_FILE="+idx)
	if _, err := gitEnv(root, env, "read-tree", head); err != nil {
		return "", fmt.Errorf("read-tree: %s", gitStderr(err))
	}
	if _, err := gitEnv(root, env, "add", "-A"); err != nil {
		return "", fmt.Errorf("add: %s", gitStderr(err))
	}
	tree, err := gitEnv(root, env, "write-tree")
	if err != nil || tree == "" {
		return "", fmt.Errorf("write-tree: %s", gitStderr(err))
	}
	if headTree, _ := git(root, "rev-parse", head+"^{tree}"); headTree == tree {
		return "", nil // on-disk content already matches HEAD: only the index was broken
	}
	body := fmt.Sprintf(
		"Orbit found this checkout in a %q state and cleaned it up.\n\nSaved here first: this is the working tree exactly as it was,\nconflict markers and all. Files: %s\n",
		state.State, strings.Join(state.Paths, ", "))
	commit, err := gitEnv(root, append(env,
		"GIT_AUTHOR_NAME=Orbit Runner", "GIT_AUTHOR_EMAIL=runner@orbit",
		"GIT_COMMITTER_NAME=Orbit Runner", "GIT_COMMITTER_EMAIL=runner@orbit"),
		"commit-tree", tree, "-p", head, "-m", "rescue: working tree before Orbit cleaned up this checkout", "-m", body)
	if err != nil || commit == "" {
		return "", fmt.Errorf("commit-tree: %s", gitStderr(err))
	}
	branch := "orbit/rescue-" + shortSha(commit)
	if _, err := git(root, "branch", branch, commit); err != nil {
		return "", fmt.Errorf("branch: %s", gitStderr(err))
	}
	return branch, nil
}

// headSha is the checkout's current commit, or "" — for messages only.
func headSha(root string) string {
	sha, _ := git(root, "rev-parse", "HEAD")
	return sha
}
