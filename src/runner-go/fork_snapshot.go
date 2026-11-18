package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// A task forked from the calling session (docs/task-fork-from-session-design.md §2.2, SR55): `orbit mcp`
// snapshots the session's checkout without touching it, keeps the snapshot alive with a ref, and posts
// the task with the fork. The method is the one phase P0 proved on a real runner:
//
//   - the temp index is a byte copy of the checkout's OWN index, so a sparse checkout's skip-worktree
//     marks, a staged-then-edited file and a mid-merge index all come out as `git add -A` would commit
//     them (an empty index stages the deletion of every left-out path; seeding with `read-tree -m HEAD`
//     fails on a staged-then-edited file and during a merge);
//   - GIT_OPTIONAL_LOCKS=0, without which `add -A` rewrites a racily clean submodule's index;
//   - commit-tree only when the tree differs from HEAD's: a clean checkout's snapshot is HEAD itself.

const (
	forkRefPrefix = "refs/orbit/fork/"

	// taskForkCapabilityV1 declares that this runner deletes the keep-alive refs the heartbeat's
	// forkSnapshotsOpen no longer names. The control plane sends the list only to a runner declaring it.
	taskForkCapabilityV1 = "task-fork/v1"

	// forkSubmoduleNotShareable is the fork's own refusal (design §2.7 F3): a snapshot records a
	// submodule as its gitlink alone, so neither a submodule's uncommitted edits nor a commit only the
	// session's submodule clone has would reach the task.
	forkSubmoduleNotShareable = "FORK_SUBMODULE_NOT_SHAREABLE"

	// forkRefUnseenGrace is how long a keep-alive ref the control plane has never listed as open is
	// kept anyway: the ref is written before the task is posted (and before its card is answered), so
	// a young ref with no open task may simply be one whose task does not exist yet.
	forkRefUnseenGrace = time.Hour
)

// forkSnapshot is what one task_create call snapshotted, shared by every item of the call that forks.
type forkSnapshot struct {
	SessionID string
	Dir       string // the checkout snapshotted
	Sha       string // S
	BaseHead  string // the checkout's HEAD
	Ref       string // refs/orbit/fork/<snapshotId>
	// ChangedFiles are the paths S changed relative to BaseHead, which the task_await payload of the task names
	// (design §2.7 F4): an edit the forking session reverts after the snapshot comes back through the merge.
	ChangedFiles []string
}

// forkChangedFilesMax is the most paths a fork names, the create doors' TASK_FORK_CHANGED_FILES_MAX.
const forkChangedFilesMax = 1000

// payload is the `fork` the create doors accept (apiserver tasks/task-fork.ts).
func (f *forkSnapshot) payload() map[string]interface{} {
	return map[string]interface{}{
		"sessionId":           f.SessionID,
		"sha":                 f.Sha,
		"baseHead":            f.BaseHead,
		"includesUncommitted": f.Sha != f.BaseHead,
		"changedFiles":        append([]string{}, f.ChangedFiles...),
	}
}

// forkChangedFiles is `git diff --name-only <head> <sha>`, at most forkChangedFilesMax paths; none when S is
// HEAD, or when git cannot say (the fork goes on without them rather than failing over a list).
func forkChangedFiles(dir, head, sha string) []string {
	if sha == head {
		return nil
	}
	out, err := git(dir, "-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", head, sha)
	if err != nil || out == "" {
		return nil
	}
	files := strings.Split(out, "\n")
	if len(files) > forkChangedFilesMax {
		files = files[:forkChangedFilesMax]
	}
	return files
}

// release deletes the keep-alive ref of a snapshot no task was created from (a declined card, a refused
// create). Only if it still names S, so it never deletes a ref something else rewrote.
func (f *forkSnapshot) release() {
	if f == nil || f.Ref == "" {
		return
	}
	_, _ = git(f.Dir, "update-ref", "-d", f.Ref, f.Sha)
}

// forkCheckoutDir is the checkout of the session making the call: its own worktree under worktreesDir(),
// or, for a session with no worktree, the checkout this process runs in (the workDir the runner started
// the session in, which is the cwd its engine and this MCP server inherit).
func forkCheckoutDir(sessionID string) (string, error) {
	if sessionID == "" {
		return "", fmt.Errorf("forkFromSession needs the session making this call, and this process runs in none (ORBIT_SESSION_ID is not set)")
	}
	wt := filepath.Join(worktreesDir(), decodeSessionID(sessionID))
	if isGitRepo(wt) {
		return wt, nil
	}
	cwd, err := os.Getwd()
	if err == nil {
		if top, err := git(cwd, "rev-parse", "--show-toplevel"); err == nil && top != "" {
			return top, nil
		}
	}
	return "", fmt.Errorf("forkFromSession: this session has no git checkout to snapshot")
}

// takeForkSnapshot is the whole of design §2.2 steps 1–3 for the session making the call, after the
// submodule check that refuses a fork the snapshot could not carry (§2.7 F3).
func takeForkSnapshot(sessionID, title string) (*forkSnapshot, error) {
	dir, err := forkCheckoutDir(sessionID)
	if err != nil {
		return nil, err
	}
	if err := checkForkSubmodules(dir); err != nil {
		return nil, err
	}
	sha, head, err := snapshotCheckout(dir, fmt.Sprintf("Snapshot of session %s for task %s", sessionID, title))
	if err != nil {
		return nil, err
	}
	ref := forkRefPrefix + newForkSnapshotID(time.Now())
	if _, err := git(dir, "update-ref", ref, sha, ""); err != nil {
		return nil, fmt.Errorf("forkFromSession: cannot write the keep-alive ref %s: %w", ref, err)
	}
	return &forkSnapshot{SessionID: sessionID, Dir: dir, Sha: sha, BaseHead: head, Ref: ref,
		ChangedFiles: forkChangedFiles(dir, head, sha)}, nil
}

// snapshotCheckout returns S and HEAD for the checkout at dir, leaving its index, its files and every
// submodule's index exactly as they were. S is HEAD when nothing is uncommitted, and no commit is made.
func snapshotCheckout(dir, message string) (sha, head string, err error) {
	head, err = git(dir, "rev-parse", "--verify", "HEAD^{commit}")
	if err != nil || !fullSha.MatchString(head) {
		return "", "", fmt.Errorf("forkFromSession: the checkout at %s has no commit to fork from: %v", dir, err)
	}
	indexPath, err := git(dir, "rev-parse", "--path-format=absolute", "--git-path", "index")
	if err != nil || indexPath == "" {
		return "", "", fmt.Errorf("forkFromSession: cannot find the index of %s: %v", dir, err)
	}
	tmpDir, err := os.MkdirTemp("", "orbit-fork-index-")
	if err != nil {
		return "", "", fmt.Errorf("forkFromSession: %w", err)
	}
	defer os.RemoveAll(tmpDir)
	tmpIndex := filepath.Join(tmpDir, "index")
	if err := copyFilePreserving(indexPath, tmpIndex); err != nil && !os.IsNotExist(err) {
		return "", "", fmt.Errorf("forkFromSession: cannot copy the index of %s: %w", dir, err)
	}
	env := append(os.Environ(), "GIT_INDEX_FILE="+tmpIndex, "GIT_OPTIONAL_LOCKS=0")
	if _, err := gitEnv(dir, env, "add", "-A", "--sparse"); err != nil {
		return "", "", fmt.Errorf("forkFromSession: staging the checkout's work in a copy of its index failed: %w", err)
	}
	tree, err := gitEnv(dir, env, "write-tree")
	if err != nil || tree == "" {
		return "", "", fmt.Errorf("forkFromSession: write-tree failed: %w", err)
	}
	headTree, err := git(dir, "rev-parse", "HEAD^{tree}")
	if err != nil {
		return "", "", fmt.Errorf("forkFromSession: %w", err)
	}
	if tree == headTree {
		return head, head, nil
	}
	commitEnv := env
	if email, _ := git(dir, "config", "user.email"); email == "" {
		commitEnv = append(commitEnv,
			"GIT_AUTHOR_NAME=Orbit", "GIT_AUTHOR_EMAIL=orbit@localhost",
			"GIT_COMMITTER_NAME=Orbit", "GIT_COMMITTER_EMAIL=orbit@localhost")
	}
	sha, err = gitEnv(dir, commitEnv, "commit-tree", tree, "-p", head, "-m", message)
	if err != nil || !fullSha.MatchString(sha) {
		return "", "", fmt.Errorf("forkFromSession: commit-tree failed: %w", err)
	}
	return sha, head, nil
}

// copyFilePreserving is `cp -p`: the bytes, the mode and the modification time. The time matters: git
// judges an entry racily clean against the index file's mtime, and the copy must judge as the original.
func copyFilePreserving(src, dst string) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.WriteFile(dst, data, info.Mode().Perm()); err != nil {
		return err
	}
	return os.Chtimes(dst, info.ModTime(), info.ModTime())
}

// checkForkSubmodules refuses the fork (§2.7 F3), naming the submodule, when a submodule of the checkout
// has uncommitted changes, or has checked out a commit the workDir's copy of that submodule cannot reach.
// It reads without optional locks, so no submodule index is refreshed. An uninitialized submodule has
// nothing checked out and nothing uncommitted.
func checkForkSubmodules(dir string) error {
	out, err := gitEnv(dir, append(os.Environ(), "GIT_OPTIONAL_LOCKS=0"), "ls-files", "--stage", "-z")
	if err != nil {
		return fmt.Errorf("forkFromSession: cannot list the checkout's files: %w", err)
	}
	var paths []string
	for _, entry := range strings.Split(out, "\x00") {
		// "<mode> <sha> <stage>\t<path>"
		if !strings.HasPrefix(entry, "160000 ") {
			continue
		}
		if tab := strings.IndexByte(entry, '\t'); tab >= 0 {
			paths = append(paths, entry[tab+1:])
		}
	}
	if len(paths) == 0 {
		return nil
	}
	workDir := forkWorkDirOf(dir)
	readEnv := append(os.Environ(), "GIT_OPTIONAL_LOCKS=0")
	for _, p := range paths {
		sub := filepath.Join(dir, p)
		if top, err := git(sub, "rev-parse", "--show-toplevel"); err != nil || filepath.Clean(top) != filepath.Clean(sub) {
			continue
		}
		status, err := gitEnv(sub, readEnv, "status", "--porcelain", "--ignore-submodules=none")
		if err != nil {
			return forkSubmoduleRefusal(p, fmt.Sprintf("its status cannot be read: %v", err))
		}
		if status != "" {
			return forkSubmoduleRefusal(p, "it has uncommitted changes, which a snapshot cannot carry")
		}
		head, err := git(sub, "rev-parse", "--verify", "HEAD^{commit}")
		if err != nil {
			return forkSubmoduleRefusal(p, "it has no commit checked out")
		}
		if !forkCommitReachable(filepath.Join(workDir, p), head) {
			return forkSubmoduleRefusal(p, fmt.Sprintf(
				"its checked-out commit %s is not reachable from the workDir's copy of it (%s), so the task's checkout could not get it",
				shortSha(head), filepath.Join(workDir, p)))
		}
	}
	return nil
}

func forkSubmoduleRefusal(path, why string) error {
	return fmt.Errorf("%s: cannot fork this session: submodule %q: %s. Commit the submodule's work and make that commit "+
		"reachable from the workDir's copy of the submodule, or create the task without forkFromSession",
		forkSubmoduleNotShareable, path, why)
}

// forkWorkDirOf is the main checkout of the repository dir belongs to: the workDir itself for the
// workDir, its main worktree for a session's linked worktree.
func forkWorkDirOf(dir string) string {
	common, err := git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil || common == "" {
		return dir
	}
	if filepath.Base(common) == ".git" {
		return filepath.Dir(common)
	}
	return dir
}

// forkCommitReachable reports whether repo has sha and reaches it from HEAD or one of its refs.
func forkCommitReachable(repo, sha string) bool {
	if !isGitRepo(repo) {
		return false
	}
	if _, err := git(repo, "cat-file", "-e", sha+"^{commit}"); err != nil {
		return false
	}
	if _, err := git(repo, "merge-base", "--is-ancestor", sha, "HEAD"); err == nil {
		return true
	}
	out, err := git(repo, "for-each-ref", "--count=1", "--contains", sha, "--format=%(refname)")
	return err == nil && out != ""
}

// newForkSnapshotID names one snapshot: when it was taken, then randomness. The time is what lets the
// gc keep a young ref whose task has not been posted yet (forkRefUnseenGrace).
func newForkSnapshotID(now time.Time) string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return strconv.FormatInt(now.Unix(), 10) + "-" + hex.EncodeToString(b)
}

// forkSnapshotTakenAt reads the time back out of a snapshot id; ok is false for a name this build did
// not make, which the gc then treats as old.
func forkSnapshotTakenAt(id string) (time.Time, bool) {
	sec, _, found := strings.Cut(id, "-")
	if !found {
		return time.Time{}, false
	}
	n, err := strconv.ParseInt(sec, 10, 64)
	if err != nil {
		return time.Time{}, false
	}
	return time.Unix(n, 0), true
}

// forkRefGC deletes keep-alive refs (design §2.6) once no open task names their snapshot. The control
// plane states, on a heartbeat, the snapshots of this runner's open forked tasks; the gc acts only on such
// a statement. A ref is deleted when its snapshot is not open and either it was open on an earlier
// statement (its tasks have all closed since) or it is older than forkRefUnseenGrace (its task was never
// created, or closed before this process saw it open).
type forkRefGC struct {
	seenOpen map[string]bool
}

func newForkRefGC() *forkRefGC { return &forkRefGC{seenOpen: map[string]bool{}} }

// sweep applies one statement of the open snapshots to the repositories at repoDirs, and returns the
// refs it deleted.
func (g *forkRefGC) sweep(repoDirs []string, open []string, now time.Time) []string {
	openSet := map[string]bool{}
	for _, sha := range open {
		sha = strings.ToLower(strings.TrimSpace(sha))
		openSet[sha] = true
		if !g.seenOpen[sha] {
			logln("fork snapshot " + sha + " is open: an open task starts from it")
		}
		g.seenOpen[sha] = true
	}
	var deleted []string
	seenRepo := map[string]bool{}
	for _, dir := range repoDirs {
		dir = expandTilde(dir)
		if dir == "" || !isGitRepo(dir) {
			continue
		}
		common, err := git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
		if err != nil || seenRepo[common] {
			continue
		}
		seenRepo[common] = true
		out, err := git(dir, "for-each-ref", "--format=%(refname) %(objectname)", forkRefPrefix)
		if err != nil || out == "" {
			continue
		}
		for _, line := range strings.Split(out, "\n") {
			ref, sha, ok := strings.Cut(strings.TrimSpace(line), " ")
			if !ok || openSet[sha] {
				continue
			}
			takenAt, named := forkSnapshotTakenAt(strings.TrimPrefix(ref, forkRefPrefix))
			young := named && now.Sub(takenAt) < forkRefUnseenGrace
			if young && !g.seenOpen[sha] {
				continue
			}
			if _, err := git(dir, "update-ref", "-d", ref, sha); err == nil {
				deleted = append(deleted, ref)
				delete(g.seenOpen, sha)
			}
		}
	}
	return deleted
}

// forkRefSweeper runs forkRefGC off the heartbeat goroutine, one sweep at a time; a statement that comes
// while one runs is dropped, and the next full beat states the open snapshots again.
type forkRefSweeper struct {
	gc      *forkRefGC
	running atomic.Bool
}

func newForkRefSweeper() *forkRefSweeper { return &forkRefSweeper{gc: newForkRefGC()} }

func (s *forkRefSweeper) post(open *[]string, dirs []AgentDirTarget) {
	if open == nil || dirs == nil || !s.running.CompareAndSwap(false, true) {
		return
	}
	repoDirs := make([]string, 0, len(dirs))
	for _, d := range dirs {
		if d.WorkDir != "" {
			repoDirs = append(repoDirs, d.WorkDir)
		}
	}
	shas := append([]string(nil), (*open)...)
	go func() {
		defer s.running.Store(false)
		for _, ref := range s.gc.sweep(repoDirs, shas, time.Now()) {
			logln("fork snapshot ref " + ref + " deleted: no open task starts from it")
		}
	}()
}
