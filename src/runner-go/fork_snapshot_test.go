package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The fork snapshot (docs/task-fork-from-session-design.md §2.2, §2.7) against real git: S is the
// checkout as `git add -A` would commit it, the checkout itself — its files, its index, a submodule's
// index — is byte-identical afterwards, and a submodule whose work S could not carry refuses the fork.

// checkoutFingerprint is every file under dir (a nested .git directory's content excluded, its index
// included) by path and sha256, plus the index's bytes, inode and modification time.
func checkoutFingerprint(t *testing.T, dir string) string {
	t.Helper()
	var lines []string
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, path)
		if d.IsDir() && d.Name() == ".git" {
			return filepath.SkipDir
		}
		if d.Type().IsRegular() {
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			sum := sha256.Sum256(data)
			lines = append(lines, rel+" "+hex.EncodeToString(sum[:]))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(lines)
	return strings.Join(lines, "\n") + "\n" + indexFingerprint(t, dir)
}

// indexFingerprint is the index of the checkout at dir: sha256, inode and mtime in nanoseconds.
func indexFingerprint(t *testing.T, dir string) string {
	t.Helper()
	idx := mustGit(t, dir, "rev-parse", "--path-format=absolute", "--git-path", "index")
	info, err := os.Stat(idx)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(idx)
	sum := sha256.Sum256(data)
	var ino uint64
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		ino = st.Ino
	}
	return fmt.Sprintf("index sha256=%s inode=%d mtime=%d", hex.EncodeToString(sum[:]), ino, info.ModTime().UnixNano())
}

func writeForkFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// blobAt is the content of path in commit, or "<absent>".
func blobAt(dir, commit, path string) string {
	out, err := git(dir, "show", commit+":"+path)
	if err != nil {
		return "<absent>"
	}
	return out
}

func snapshotOrFail(t *testing.T, dir string) (string, string) {
	t.Helper()
	before := checkoutFingerprint(t, dir)
	sha, head, err := snapshotCheckout(dir, "test snapshot")
	if err != nil {
		t.Fatalf("snapshotCheckout: %v", err)
	}
	if after := checkoutFingerprint(t, dir); after != before {
		t.Fatalf("the snapshot changed the checkout:\nbefore:\n%s\nafter:\n%s", before, after)
	}
	return sha, head
}

func TestForkSnapshotOfADirtyCheckout(t *testing.T) {
	repo := initRepo(t)
	writeForkFile(t, filepath.Join(repo, ".gitignore"), "*.log\n")
	commitFile(t, repo, "keep.txt", "keep\n", "more")
	commitFile(t, repo, "gone.txt", "gone\n", "more")
	writeForkFile(t, filepath.Join(repo, "base.txt"), "base edited\n")    // modified, unstaged
	_ = os.Remove(filepath.Join(repo, "gone.txt"))                     // deleted
	writeForkFile(t, filepath.Join(repo, "new/untracked.txt"), "fresh\n") // untracked
	writeForkFile(t, filepath.Join(repo, "scratch.log"), "ignored\n")     // ignored
	status := mustGitEnv(t, repo, append(os.Environ(), "GIT_OPTIONAL_LOCKS=0"), "status", "--porcelain")

	sha, head := snapshotOrFail(t, repo)
	if sha == head {
		t.Fatal("a dirty checkout's snapshot is HEAD")
	}
	if parent := mustGit(t, repo, "rev-parse", sha+"^"); parent != head {
		t.Fatalf("S's parent = %s, want HEAD %s", parent, head)
	}
	for path, want := range map[string]string{
		"base.txt":          "base edited",
		"keep.txt":          "keep",
		"gone.txt":          "<absent>",
		"new/untracked.txt": "fresh",
		"scratch.log":       "<absent>",
	} {
		if got := blobAt(repo, sha, path); got != want {
			t.Errorf("S:%s = %q, want %q", path, got, want)
		}
	}
	if after := mustGitEnv(t, repo, append(os.Environ(), "GIT_OPTIONAL_LOCKS=0"), "status", "--porcelain"); after != status {
		t.Fatalf("status changed:\n%s\n->\n%s", status, after)
	}
}

func TestForkSnapshotOfACleanCheckoutIsHead(t *testing.T) {
	repo := initRepo(t)
	writeForkFile(t, filepath.Join(repo, ".gitignore"), "*.log\n")
	commitFile(t, repo, "x.txt", "x\n", "more")
	writeForkFile(t, filepath.Join(repo, "scratch.log"), "ignored only\n")
	objects := mustGit(t, repo, "count-objects")
	sha, head := snapshotOrFail(t, repo)
	if sha != head {
		t.Fatalf("a clean checkout's snapshot = %s, want HEAD %s", sha, head)
	}
	if after := mustGit(t, repo, "count-objects"); after != objects {
		t.Fatalf("a clean snapshot wrote objects: %s -> %s", objects, after)
	}
}

func TestForkSnapshotTakesTheWorktreeSideOfAStagedThenEditedFile(t *testing.T) {
	repo := initRepo(t)
	writeForkFile(t, filepath.Join(repo, "base.txt"), "staged\n")
	mustGit(t, repo, "add", "base.txt")
	writeForkFile(t, filepath.Join(repo, "base.txt"), "staged then edited\n")
	stagedBlob := mustGit(t, repo, "rev-parse", ":base.txt")

	sha, _ := snapshotOrFail(t, repo)
	if got := blobAt(repo, sha, "base.txt"); got != "staged then edited" {
		t.Fatalf("S:base.txt = %q, want the worktree's content", got)
	}
	if got := mustGit(t, repo, "rev-parse", ":base.txt"); got != stagedBlob {
		t.Fatalf("the session's staged blob moved: %s -> %s", stagedBlob, got)
	}
}

// A session checkout is a sparse linked worktree: the paths it leaves out are in S as HEAD has them, a
// tracked file matching .gitignore stays, and a clean sparse checkout's snapshot is HEAD (P0 F1).
func TestForkSnapshotOfASparseLinkedWorktreeKeepsLeftOutPaths(t *testing.T) {
	repo := initRepo(t)
	writeForkFile(t, filepath.Join(repo, ".gitignore"), "*.log\n")
	writeForkFile(t, filepath.Join(repo, "docs/mocks/m1.txt"), "mock one\n")
	writeForkFile(t, filepath.Join(repo, "docs/mocks/m2.txt"), "mock two\n")
	writeForkFile(t, filepath.Join(repo, "tracked.log"), "tracked though ignored\n")
	mustGit(t, repo, "add", "-f", ".")
	mustGit(t, repo, "commit", "-m", "mocks")
	wt := filepath.Join(t.TempDir(), "wt")
	mustGit(t, repo, "worktree", "add", "-q", "-b", "orbit/s", wt)
	mustGit(t, wt, "sparse-checkout", "set", "--no-cone", "/*", "!/docs/mocks/")
	if _, err := os.Stat(filepath.Join(wt, "docs/mocks/m1.txt")); !os.IsNotExist(err) {
		t.Fatal("CONTROL: the sparse checkout must leave docs/mocks out")
	}

	if sha, head := snapshotOrFail(t, wt); sha != head {
		t.Fatalf("a clean sparse checkout's snapshot = %s, want HEAD %s (diff: %s)", sha, head,
			mustGit(t, wt, "diff", "--name-status", head, sha))
	}

	writeForkFile(t, filepath.Join(wt, "base.txt"), "edited in a sparse checkout\n")
	writeForkFile(t, filepath.Join(wt, "added.txt"), "untracked\n")
	sha, head := snapshotOrFail(t, wt)
	diff := mustGit(t, wt, "diff", "--name-status", head, sha)
	if diff != "M\tbase.txt\nA\tadded.txt" && diff != "A\tadded.txt\nM\tbase.txt" {
		t.Fatalf("S differs from HEAD by:\n%s\nwant exactly base.txt modified and added.txt added", diff)
	}
	for path, want := range map[string]string{"docs/mocks/m1.txt": "mock one", "tracked.log": "tracked though ignored"} {
		if got := blobAt(wt, sha, path); got != want {
			t.Errorf("S:%s = %q, want %q", path, got, want)
		}
	}
}

// The session holds its index.lock (a `git add` in flight): the snapshot reads the index as it stands and
// leaves the lock where it was.
func TestForkSnapshotWhileTheSessionHoldsIndexLock(t *testing.T) {
	repo := initRepo(t)
	writeForkFile(t, filepath.Join(repo, "base.txt"), "edited\n")
	lock := mustGit(t, repo, "rev-parse", "--path-format=absolute", "--git-path", "index.lock")
	writeForkFile(t, lock, "held by the session")

	sha, head := snapshotOrFail(t, repo)
	if sha == head || blobAt(repo, sha, "base.txt") != "edited" {
		t.Fatalf("S = %s (HEAD %s), base.txt %q", sha, head, blobAt(repo, sha, "base.txt"))
	}
	if data, err := os.ReadFile(lock); err != nil || string(data) != "held by the session" {
		t.Fatalf("the session's index.lock was touched: %q %v", data, err)
	}
}

// withFileSubmodules lets `git submodule` clone from a local path, which git refuses by default.
func withFileSubmodules(t *testing.T) {
	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("GIT_CONFIG_KEY_0", "protocol.file.allow")
	t.Setenv("GIT_CONFIG_VALUE_0", "always")
}

// repoWithSubmodule is a workDir with a submodule `sub`, and a linked session worktree with it initialized.
func repoWithSubmodule(t *testing.T) (workDir, wt string) {
	t.Helper()
	return repoWithSubmoduleAt(t, filepath.Join(t.TempDir(), "wt"))
}

func repoWithSubmoduleAt(t *testing.T, wt string) (string, string) {
	t.Helper()
	withFileSubmodules(t)
	subOrigin := initRepo(t)
	commitFile(t, subOrigin, "sub.txt", "sub\n", "sub")
	workDir := initRepo(t)
	mustGit(t, workDir, "submodule", "add", "-q", subOrigin, "sub")
	mustGit(t, workDir, "commit", "-q", "-m", "add sub")
	mustGit(t, workDir, "worktree", "add", "-q", "-b", "orbit/s", wt)
	mustGit(t, wt, "submodule", "update", "-q", "--init")
	mustGit(t, filepath.Join(wt, "sub"), "config", "user.email", "test@orbit")
	mustGit(t, filepath.Join(wt, "sub"), "config", "user.name", "Test")
	return workDir, wt
}

// P0 F2: a submodule's index that is racily clean is refreshed and rewritten by a superproject `add -A`
// that takes optional locks. The snapshot takes none, so it is left as it was: same bytes, inode and mtime.
func TestForkSnapshotLeavesARacilyCleanSubmoduleIndexUntouched(t *testing.T) {
	_, wt := repoWithSubmodule(t)
	sub := filepath.Join(wt, "sub")
	writeForkFile(t, filepath.Join(wt, "base.txt"), "edited\n")
	for round := 0; round < 3; round++ {
		// Rewrite the file with the same bytes and refresh at once: the index is written in the same
		// instant as the file, which is racily clean.
		writeForkFile(t, filepath.Join(sub, "sub.txt"), "sub\n")
		mustGit(t, sub, "update-index", "-q", "--refresh")
		before := indexFingerprint(t, sub)
		if _, _, err := snapshotCheckout(wt, "test snapshot"); err != nil {
			t.Fatalf("snapshotCheckout: %v", err)
		}
		if after := indexFingerprint(t, sub); after != before {
			t.Fatalf("round %d: the submodule's index was rewritten:\n%s\n->\n%s", round, before, after)
		}
	}
}

func TestForkRefusesASubmoduleWithUncommittedChanges(t *testing.T) {
	_, wt := repoWithSubmodule(t)
	if err := checkForkSubmodules(wt); err != nil {
		t.Fatalf("a clean submodule at the workDir's commit was refused: %v", err)
	}
	writeForkFile(t, filepath.Join(wt, "sub", "sub.txt"), "edited inside the submodule\n")
	before := checkoutFingerprint(t, wt)
	err := checkForkSubmodules(wt)
	if err == nil || !strings.Contains(err.Error(), forkSubmoduleNotShareable) || !strings.Contains(err.Error(), `"sub"`) {
		t.Fatalf("err = %v, want %s naming \"sub\"", err, forkSubmoduleNotShareable)
	}
	if !strings.Contains(err.Error(), "uncommitted") {
		t.Errorf("the refusal does not say why: %v", err)
	}
	if after := checkoutFingerprint(t, wt); after != before {
		t.Fatal("the submodule check changed the checkout")
	}
}

func TestForkRefusesASubmoduleCommitTheWorkDirCannotReach(t *testing.T) {
	_, wt := repoWithSubmodule(t)
	commitFile(t, filepath.Join(wt, "sub"), "only-here.txt", "x\n", "a commit only the session's clone has")
	err := checkForkSubmodules(wt)
	if err == nil || !strings.Contains(err.Error(), forkSubmoduleNotShareable) || !strings.Contains(err.Error(), "not reachable") {
		t.Fatalf("err = %v, want %s for an unreachable commit", err, forkSubmoduleNotShareable)
	}
}

// takeForkSnapshot writes nothing, not even the keep-alive ref, when it refuses.
func TestTakeForkSnapshotRefusesBeforeWritingAnything(t *testing.T) {
	sessionID := "0190aaaa-0000-7000-8000-000000000001"
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	workDir, dst := repoWithSubmoduleAt(t, filepath.Join(home, "worktrees", sessionID))
	writeForkFile(t, filepath.Join(dst, "sub", "sub.txt"), "dirty\n")

	if _, err := takeForkSnapshot(sessionID, "t"); err == nil || !strings.Contains(err.Error(), forkSubmoduleNotShareable) {
		t.Fatalf("err = %v, want %s", err, forkSubmoduleNotShareable)
	}
	if refs := mustGit(t, workDir, "for-each-ref", forkRefPrefix); refs != "" {
		t.Fatalf("a refused fork wrote refs: %s", refs)
	}
}

// The gc rule (design §2.6): a ref goes once no open task names its snapshot — at once when it was seen
// open before, after forkRefUnseenGrace when it never was (a task not yet posted, or never created).
func TestForkRefGCDeletesRefsNoOpenTaskNames(t *testing.T) {
	repo := initRepo(t)
	shas := make([]string, 5)
	for i := range shas {
		commitFile(t, repo, fmt.Sprintf("f%d.txt", i), "x\n", fmt.Sprintf("c%d", i))
		shas[i] = mustGit(t, repo, "rev-parse", "HEAD")
	}
	now := time.Now()
	young := func() string { return forkRefPrefix + newForkSnapshotID(now.Add(-time.Minute)) }
	old := func() string { return forkRefPrefix + newForkSnapshotID(now.Add(-2*forkRefUnseenGrace)) }
	refs := map[string]string{
		"open":        young(),
		"closedSeen":  young(),
		"youngUnseen": young(),
		"oldUnseen":   old(),
		"unnamed":     forkRefPrefix + "not-a-snapshot-id",
	}
	order := []string{"open", "closedSeen", "youngUnseen", "oldUnseen", "unnamed"}
	for i, k := range order {
		mustGit(t, repo, "update-ref", refs[k], shas[i])
	}
	present := func() map[string]bool {
		out := mustGit(t, repo, "for-each-ref", "--format=%(refname)", forkRefPrefix)
		got := map[string]bool{}
		for k, ref := range refs {
			got[k] = strings.Contains(out, ref)
		}
		return got
	}
	gc := newForkRefGC()

	gc.sweep([]string{repo, repo}, []string{shas[0], shas[1]}, now)
	if got := present(); !got["open"] || !got["closedSeen"] || !got["youngUnseen"] || got["oldUnseen"] || got["unnamed"] {
		t.Fatalf("after the first statement: %v", got)
	}
	gc.sweep([]string{repo}, []string{strings.ToUpper(shas[0])}, now)
	if got := present(); !got["open"] || got["closedSeen"] || !got["youngUnseen"] {
		t.Fatalf("after closedSeen's task closed: %v", got)
	}
	gc.sweep([]string{repo}, []string{shas[0]}, now.Add(2*forkRefUnseenGrace))
	if got := present(); !got["open"] || got["youngUnseen"] {
		t.Fatalf("after the grace: %v", got)
	}
	gc.sweep([]string{repo}, []string{}, now)
	if got := present(); got["open"] {
		t.Fatalf("an empty statement left the last ref: %v", got)
	}
}

// No statement, no deletion: an absent list (older control plane, quiet beat) and an absent directory
// listing leave every ref.
func TestForkRefSweeperActsOnlyOnAStatement(t *testing.T) {
	repo := initRepo(t)
	ref := forkRefPrefix + newForkSnapshotID(time.Now().Add(-2*forkRefUnseenGrace))
	mustGit(t, repo, "update-ref", ref, "HEAD")
	s := newForkRefSweeper()
	s.post(nil, []AgentDirTarget{{WorkDir: repo}})
	empty := []string{}
	s.post(&empty, nil)
	time.Sleep(50 * time.Millisecond)
	if out := mustGit(t, repo, "for-each-ref", forkRefPrefix); out == "" {
		t.Fatal("a ref was deleted without a statement of the open snapshots and the workspaces")
	}
	s.post(&empty, []AgentDirTarget{{WorkDir: repo}})
	deadline := time.Now().Add(5 * time.Second)
	for mustGit(t, repo, "for-each-ref", forkRefPrefix) != "" {
		if time.Now().After(deadline) {
			t.Fatal("the sweep did not delete an old ref no open task names")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// setupSourceWorktree on a SESSION_FORK pin: the checkout starts at the snapshot, on its own branch.
func TestSessionForkPinChecksOutTheSnapshot(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	writeForkFile(t, filepath.Join(repo, "base.txt"), "uncommitted in the forking session\n")
	sha, head := snapshotOrFail(t, repo)
	if sha == head {
		t.Fatal("CONTROL: the snapshot must carry the edit")
	}
	job := forkJob(repo, "0190aaaa-0000-7000-8000-0000000000f1", sha)
	execDir := setupWorktree(job, repo)
	if execDir == "" || job.WT == nil || job.SourceRefusal != nil {
		t.Fatalf("setupWorktree = %q, WT %+v, refusal %+v", execDir, job.WT, job.SourceRefusal)
	}
	if got := mustGit(t, execDir, "rev-parse", "HEAD"); got != sha {
		t.Fatalf("the forked run's HEAD = %s, want the snapshot %s", got, sha)
	}
	data, _ := os.ReadFile(filepath.Join(execDir, "base.txt"))
	if string(data) != "uncommitted in the forking session\n" {
		t.Fatalf("base.txt in the forked run = %q", data)
	}
}

// A snapshot this repository does not have is a refusal: no fetch, no checkout, no fallback to the workDir.
func TestSessionForkPinMissingCommitIsRefused(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	job := forkJob(repo, "0190aaaa-0000-7000-8000-0000000000f2", strings.Repeat("ab", 20))
	if execDir := setupWorktree(job, repo); execDir != "" || job.WT != nil {
		t.Fatalf("a missing snapshot still produced a checkout: %q %+v", execDir, job.WT)
	}
	if job.SourceRefusal == nil || job.SourceRefusal.Code != sourceRefusalShaUnavailable ||
		!strings.Contains(fmt.Sprint(job.SourceRefusal.Detail["reason"]), "forked from") {
		t.Fatalf("refusal = %+v", job.SourceRefusal)
	}
	if _, err := os.Stat(filepath.Join(worktreesDir(), job.SessionID)); !os.IsNotExist(err) {
		t.Fatal("a refused fork left a checkout directory")
	}

	other := forkJob(repo, "0190aaaa-0000-7000-8000-0000000000f3", mustGit(t, repo, "rev-parse", "HEAD"))
	other.Source.RefAuthority = refAuthorityRemote
	if execDir := setupWorktree(other, repo); execDir != "" || other.SourceRefusal == nil ||
		other.SourceRefusal.Code != sourceRefusalAuthorityUnreachable {
		t.Fatalf("a non-local fork authority was not refused: %q %+v", execDir, other.SourceRefusal)
	}
}

func forkJob(workDir, id, sha string) *ClaimedSession {
	return &ClaimedSession{
		SessionID: id,
		WorkDir:   workDir,
		Branch:    "orbit/fork-" + id[len(id)-2:],
		Source: &SessionSource{
			State:        sourceStatePinned,
			Kind:         sourceKindSessionFork,
			RevisionSha:  sha,
			RefAuthority: refAuthorityRunnerLocal,
			BaseSha:      sha,
		},
	}
}
