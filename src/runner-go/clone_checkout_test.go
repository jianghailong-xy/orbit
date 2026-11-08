package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"syscall"
	"testing"
)

// Session checkouts cloned from the workspace's own checkout (docs/session-checkout-storage-design.md §7). What these
// hold the runner to:
//
//   - where the worktrees root's filesystem can clone files, every door a session checkout is made through clones it,
//     sparse or not, and git cannot tell the result from a plain checkout: clean, no diff against its commit, the
//     commit's modes and symlinks, no mark from the template's index, nothing untracked or ignored;
//   - what the template holds as the commit does stays a clone, everything else git writes, and editing a file in the
//     checkout leaves the template as it was;
//   - where cloning is refused (EOPNOTSUPP, EXDEV) or fails partway, the checkout is made plainly instead, with no
//     error and nothing left of the attempt;
//   - the filesystem is probed once per device, and a template on another filesystem is not cloned from;
//   - on a filesystem that can really clone, the same holds with the real clone.
//
// HPC's ext4 disks cannot clone, so a stand-in (useFakeClones) copies each file the way a clone is made and holds it
// open, which tells whether git wrote the file out again later.

// cloneRecorder stands in for cloneFile: each clone is made by inner and then held open, so that whether a checkout
// path still holds the clone made there can be read from its inode, which no other file can take while the clone is
// open. failure, when set, is why cloning a checkout's file fails, given how many it cloned already; probeFailure is
// why the runner's probe fails. symlinks is every symlink a checkout held when a file was cloned into it, where there
// must be none (populateByCloning).
type cloneRecorder struct {
	inner        func(src, dst string, perm os.FileMode) error
	mu           sync.Mutex
	probes       int
	made         map[string]*os.File
	failure      func(made int) error
	probeFailure error
	symlinks     []string
}

// recordClones has the runner clone through inner, recorded, for the rest of the test, with no filesystem probed yet.
func recordClones(t *testing.T, inner func(src, dst string, perm os.FileMode) error) *cloneRecorder {
	t.Helper()
	r := &cloneRecorder{inner: inner, made: map[string]*os.File{}}
	previous := cloneFile
	cloneFile = r.clone
	forgetCloneProbes()
	t.Cleanup(func() {
		cloneFile = previous
		forgetCloneProbes()
		r.forget()
	})
	return r
}

// useFakeClones is recordClones on a filesystem that cannot clone: a clone is a copy, made as platformCloneFile makes
// one, a new file with the mode it is given.
func useFakeClones(t *testing.T) *cloneRecorder {
	t.Helper()
	return recordClones(t, copyAsAClone)
}

func copyAsAClone(src, dst string, perm os.FileMode) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return err
	}
	_, err = out.Write(data)
	if err == nil {
		err = out.Chmod(perm)
	}
	if closeErr := out.Close(); err == nil {
		err = closeErr
	}
	return err
}

// forgetCloneProbes is what a runner that starts again knows about filesystems: nothing.
func forgetCloneProbes() {
	cloneProbes.Lock()
	defer cloneProbes.Unlock()
	cloneProbes.byDevice = map[uint64]error{}
}

func (r *cloneRecorder) clone(src, dst string, perm os.FileMode) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if strings.HasPrefix(filepath.Base(src), ".orbit-clone-probe-") {
		r.probes++
		if r.probeFailure != nil {
			return r.probeFailure
		}
		return r.inner(src, dst, perm)
	}
	if r.failure != nil {
		if err := r.failure(len(r.made)); err != nil {
			return err
		}
	}
	// A clone made while its checkout holds a symlink could go through it and land outside the checkout.
	if rel, err := filepath.Rel(worktreesDir(), dst); err == nil && !strings.HasPrefix(rel, "..") {
		checkout := filepath.Join(worktreesDir(), strings.Split(filepath.ToSlash(rel), "/")[0])
		_ = filepath.WalkDir(checkout, func(path string, d fs.DirEntry, err error) error {
			if err == nil && d.Type()&fs.ModeSymlink != 0 {
				r.symlinks = append(r.symlinks, path)
			}
			return nil
		})
	}
	if err := r.inner(src, dst, perm); err != nil {
		return err
	}
	held, err := os.Open(dst)
	if err != nil {
		return err
	}
	if earlier := r.made[dst]; earlier != nil {
		earlier.Close()
	}
	r.made[dst] = held
	return nil
}

// forget lets go of every clone made so far, so that kept and cloned read only what is made next.
func (r *cloneRecorder) forget() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, held := range r.made {
		held.Close()
	}
	r.made = map[string]*os.File{}
}

// cloned is how many files were cloned since the last forget.
func (r *cloneRecorder) cloned() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.made)
}

// kept is the paths of the checkout at dir, relative to it, that still hold the clone made there.
func (r *cloneRecorder) kept(t *testing.T, dir string) []string {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	kept := []string{}
	for path, held := range r.made {
		rel, err := filepath.Rel(dir, path)
		if err != nil || strings.HasPrefix(rel, "..") {
			continue
		}
		clone, err := held.Stat()
		if err != nil {
			t.Fatal(err)
		}
		if now, err := os.Lstat(path); err == nil && os.SameFile(clone, now) {
			kept = append(kept, filepath.ToSlash(rel))
		}
	}
	sort.Strings(kept)
	return kept
}

// writeLikeGit writes files (repository-relative path to content) under dir as git checks files out: created with
// mode, 0666 or 0777, less the umask, in directories made 0777 less the umask.
func writeLikeGit(t *testing.T, dir string, files map[string]string, mode os.FileMode) {
	t.Helper()
	for name, content := range files {
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), mode); err != nil {
			t.Fatal(err)
		}
	}
}

// cloneFixture is cloneFixtureIn a directory of the test's own.
func cloneFixture(t *testing.T, sparse bool) (string, string) {
	t.Helper()
	return cloneFixtureIn(t, t.TempDir(), sparse)
}

// cloneFixtureIn makes a workspace at repo whose commit holds every kind of entry a checkout has to get right; sparse
// adds a declaration that leaves docs/ out. Its own checkout, the template, is then left the way people leave theirs,
// since a checkout cloned from it may not depend on it being clean: an edit staged and one not, a file deleted, an
// executable bit set, a symlink pointed elsewhere, a file marked assume-unchanged and edited, one marked skip-worktree
// and gone, and files untracked and ignored. It returns the workspace and its commit.
func cloneFixtureIn(t *testing.T, repo string, sparse bool) (string, string) {
	t.Helper()
	mustGit(t, repo, "init", "-q", "-b", "main")
	mustGit(t, repo, "config", "user.email", "test@orbit")
	mustGit(t, repo, "config", "user.name", "Test")
	files := map[string]string{
		".gitignore":           "*.log\nbuild/\n",
		"base.txt":             "base\n",
		"empty.txt":            "",
		"src/lib/util.go":      "package lib\n",
		"src/app.go":           "package app\n",
		"src/edited.go":        "package app // as committed\n",
		"src/gone.go":          "package app // deleted in the workspace\n",
		"src/flipped.sh":       "echo not executable\n",
		"src/hidden.go":        "package app // skip-worktree in the workspace\n",
		"src/with space.txt":   "a name with a space\n",
		"src/café.txt":         "a name git quotes\n",
		"docs/guide.md":        "a guide\n",
		"docs/mocks/board.png": "a board\n",
	}
	if sparse {
		files[checkoutExcludeFile] = "docs/\n"
	}
	writeLikeGit(t, repo, files, 0o666)
	writeLikeGit(t, repo, map[string]string{"run.sh": "#!/bin/sh\necho run\n", "bin/tool": "#!/bin/sh\necho tool\n"}, 0o777)
	for link, target := range map[string]string{"link": "src/app.go", "srclink": "src"} {
		if err := os.Symlink(target, filepath.Join(repo, link)); err != nil {
			t.Fatal(err)
		}
	}
	mustGit(t, repo, "add", "-A")
	// A submodule's entry, which a checkout gives an empty directory, as git would have here.
	mustGit(t, repo, "update-index", "--add", "--cacheinfo", "160000,"+strings.Repeat("1", 40)+",vendor/sub")
	if err := os.MkdirAll(filepath.Join(repo, "vendor", "sub"), 0o777); err != nil {
		t.Fatal(err)
	}
	mustGit(t, repo, "commit", "-q", "-m", "everything a checkout has to get right")
	head := mustGit(t, repo, "rev-parse", "HEAD")

	writeLikeGit(t, repo, map[string]string{"src/app.go": "package app // staged\n"}, 0o666)
	mustGit(t, repo, "add", "src/app.go")
	writeLikeGit(t, repo, map[string]string{
		"src/edited.go": "package app // edited, not staged\n",
		"notes.txt":     "untracked\n",
		"debug.log":     "ignored\n",
		"build/out.bin": "ignored with its directory\n",
	}, 0o666)
	for _, gone := range []string{"src/gone.go", "srclink"} {
		if err := os.Remove(filepath.Join(repo, gone)); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink("bin", filepath.Join(repo, "srclink")); err != nil {
		t.Fatal(err)
	}
	flipped := filepath.Join(repo, "src", "flipped.sh")
	info, err := os.Stat(flipped)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(flipped, info.Mode().Perm()|0o111); err != nil {
		t.Fatal(err)
	}
	mustGit(t, repo, "update-index", "--assume-unchanged", "run.sh")
	writeLikeGit(t, repo, map[string]string{"run.sh": "#!/bin/sh\necho edited under an assume-unchanged mark\n"}, 0o777)
	mustGit(t, repo, "update-index", "--skip-worktree", "src/hidden.go")
	if err := os.Remove(filepath.Join(repo, "src", "hidden.go")); err != nil {
		t.Fatal(err)
	}
	return repo, head
}

// fixtureClonesKept is what stays a clone in a checkout of cloneFixture's commit: every file the template holds as the
// commit does. The rest the template holds otherwise (src/app.go staged, src/edited.go edited, src/flipped.sh made
// executable, run.sh edited under its mark) or not at all (src/gone.go, src/hidden.go), and git writes those.
func fixtureClonesKept(sparse bool) []string {
	if sparse {
		return []string{".gitignore", checkoutExcludeFile, "base.txt", "bin/tool", "empty.txt", "src/café.txt", "src/lib/util.go", "src/with space.txt"}
	}
	return []string{".gitignore", "base.txt", "bin/tool", "docs/guide.md", "docs/mocks/board.png", "empty.txt", "src/café.txt", "src/lib/util.go", "src/with space.txt"}
}

// fixtureFilesCloned is how many files a checkout of cloneFixture's commit clones: every regular file the template
// holds, of the paths the checkout keeps.
func fixtureFilesCloned(sparse bool) int {
	if sparse {
		return 12
	}
	return 13
}

// requireLikeAPlainCheckout fails unless git cannot tell the checkout at path from a plain checkout of the same
// commit with the same sparse rules, which it makes from repo to compare: the same files with the same modes,
// contents and symlink targets, the same index, and a status with nothing to say.
func requireLikeAPlainCheckout(t *testing.T, repo, path string) {
	t.Helper()
	if status := mustGit(t, path, "status", "--porcelain", "--ignored", "--untracked-files=all"); status != "" {
		t.Errorf("the checkout should read as clean, with nothing untracked or ignored in it, got %q", status)
	}
	if diff := mustGit(t, path, "diff", "--name-status", "HEAD"); diff != "" {
		t.Errorf("the checkout should not differ from its commit, got %q", diff)
	}
	requireCommitOnDisk(t, path)
	plain := plainCheckoutLike(t, repo, path)
	if got, want := mustGit(t, path, "ls-files", "-s", "-v"), mustGit(t, plain, "ls-files", "-s", "-v"); got != want {
		t.Errorf("the checkout's index should be a plain checkout's, marks included:\n got %s\nwant %s", got, want)
	}
	got, want := checkoutFiles(t, path), checkoutFiles(t, plain)
	if !reflect.DeepEqual(got, want) {
		for name := range union(got, want) {
			if got[name] != want[name] {
				t.Errorf("%s: %q in the checkout, %q in a plain checkout", name, got[name], want[name])
			}
		}
	}
}

// requireCommitOnDisk fails unless every entry of the commit the checkout at path stands on is on disk as the commit
// has it, except what the checkout's sparse rules leave out, which is not on disk at all: a file with its content and
// executable bit, a symlink with its target, a submodule as an empty directory.
func requireCommitOnDisk(t *testing.T, path string) {
	t.Helper()
	leftOut := map[string]bool{}
	for _, entry := range strings.Split(mustGit(t, path, "ls-files", "-t", "-z"), "\x00") {
		if tag, name, ok := strings.Cut(entry, " "); ok && tag == "S" {
			leftOut[name] = true
		}
	}
	for _, entry := range strings.Split(mustGit(t, path, "ls-tree", "-r", "-z", "HEAD"), "\x00") {
		if entry == "" {
			continue
		}
		meta, name, _ := strings.Cut(entry, "\t")
		fields := strings.Fields(meta)
		mode, object := fields[0], fields[2]
		info, err := os.Lstat(filepath.Join(path, name))
		if leftOut[name] {
			if err == nil {
				t.Errorf("%s is left out of the checkout, yet it is on disk", name)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s is in the commit but not in the checkout: %v", name, err)
			continue
		}
		switch mode {
		case "100644", "100755":
			if !info.Mode().IsRegular() {
				t.Errorf("%s should be a file, is %v", name, info.Mode())
				continue
			}
			if executable := info.Mode().Perm()&0o111 != 0; executable != (mode == "100755") {
				t.Errorf("%s has mode %v, the commit's is %s", name, info.Mode().Perm(), mode)
			}
			data, err := os.ReadFile(filepath.Join(path, name))
			if err != nil {
				t.Fatal(err)
			}
			if blob := mustGit(t, path, "cat-file", "blob", object); strings.TrimSpace(string(data)) != blob {
				t.Errorf("%s holds %q, the commit %q", name, data, blob)
			}
		case "120000":
			target, err := os.Readlink(filepath.Join(path, name))
			if blob := mustGit(t, path, "cat-file", "blob", object); err != nil || target != blob {
				t.Errorf("%s should be a symlink to %q, got %q (%v)", name, blob, target, err)
			}
		case "160000":
			entries, err := os.ReadDir(filepath.Join(path, name))
			if err != nil || len(entries) != 0 {
				t.Errorf("the submodule %s should be an empty directory, got %d entries (%v)", name, len(entries), err)
			}
		default:
			t.Errorf("%s has mode %s in the commit", name, mode)
		}
	}
}

// plainCheckoutLike is a checkout that git makes plainly from repo, detached at the commit of the checkout at path
// and left as sparse as that one is.
func plainCheckoutLike(t *testing.T, repo, path string) string {
	t.Helper()
	plain := filepath.Join(t.TempDir(), "plain")
	head := mustGit(t, path, "rev-parse", "HEAD")
	if sparse, _ := git(path, "config", "--bool", "core.sparseCheckout"); sparse == "true" {
		patterns := strings.Split(mustGit(t, path, "sparse-checkout", "list"), "\n")
		mustGit(t, repo, "worktree", "add", "-q", "--no-checkout", "--detach", plain, head)
		mustGit(t, plain, append([]string{"sparse-checkout", "set", "--no-cone"}, patterns...)...)
		mustGit(t, plain, "reset", "-q", "--hard")
	} else {
		mustGit(t, repo, "worktree", "add", "-q", "--detach", plain, head)
	}
	t.Cleanup(func() { _, _ = git(repo, "worktree", "remove", "--force", plain) })
	return plain
}

// checkoutFiles is every path under the checkout at root but its .git file, with what it is: a file with its mode and
// content, a directory with its mode, a symlink with its target.
func checkoutFiles(t *testing.T, root string) map[string]string {
	t.Helper()
	files := map[string]string{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil || rel == "." || rel == ".git" {
			return err
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			files[filepath.ToSlash(rel)] = "symlink to " + target
		case info.IsDir():
			files[filepath.ToSlash(rel)] = fmt.Sprintf("directory %o", info.Mode().Perm())
		default:
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			files[filepath.ToSlash(rel)] = fmt.Sprintf("file %o %q", info.Mode().Perm(), data)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func union(a, b map[string]string) map[string]bool {
	all := map[string]bool{}
	for k := range a {
		all[k] = true
	}
	for k := range b {
		all[k] = true
	}
	return all
}

// requireTemplateUnmovedByEdits edits files in the checkout at path, rewriting each where it stands, as a shell `>`
// does, and fails unless the template at repo is as it was and the checkout's status shows each edit. One is a file
// still cloned, which a hardlink in its place would carry into the template; the other is the one the template marks
// assume-unchanged, which no mark may hide in the checkout.
func requireTemplateUnmovedByEdits(t *testing.T, repo, path string) {
	t.Helper()
	statusBefore := mustGit(t, repo, "status", "--porcelain")
	edits := []string{"base.txt", "run.sh"}
	before := map[string]string{}
	for _, name := range edits {
		data, err := os.ReadFile(filepath.Join(repo, name))
		if err != nil {
			t.Fatal(err)
		}
		before[name] = string(data)
		if err := os.WriteFile(filepath.Join(path, name), []byte("an edit in the session's checkout\n"), 0o666); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range edits {
		if data, err := os.ReadFile(filepath.Join(repo, name)); err != nil || string(data) != before[name] {
			t.Errorf("editing %s in the checkout changed the template's: %q, was %q (%v)", name, data, before[name], err)
		}
	}
	if status := mustGit(t, repo, "status", "--porcelain"); status != statusBefore {
		t.Errorf("editing the checkout changed the template's status to %q, was %q", status, statusBefore)
	}
	if status, want := mustGit(t, path, "status", "--porcelain"), "M base.txt\n M run.sh"; status != want {
		t.Errorf("the checkout's status should show both edits, %q, got %q", want, status)
	}
}

// sessionCheckout is a session's checkout as the door that made it left it.
type sessionCheckout struct {
	path, branch, isolation, creation string
	refusal                           *SourcePinRefusal
}

func checkoutOf(job *ClaimedSession) sessionCheckout {
	got := sessionCheckout{branch: job.Branch, isolation: job.IsolationStatus, creation: job.CheckoutCreation, refusal: job.SourceRefusal}
	if job.WT != nil {
		got.path = job.WT.Path
	}
	return got
}

// sessionWithWork is a new session's checkout of repo with a commit of the session's own on its branch.
func sessionWithWork(t *testing.T, repo, session string) *ClaimedSession {
	t.Helper()
	job := &ClaimedSession{SessionID: session, Branch: "orbit/" + session}
	if setupWorktree(job, repo); job.WT == nil {
		t.Fatalf("no checkout for %s", session)
	}
	commitFile(t, job.WT.Path, "work.go", "package app // the session's work\n", "the session's work")
	return job
}

// takeCheckoutAway removes the checkout of job from the disk and from git's list, as the resumable sweep does.
func takeCheckoutAway(t *testing.T, job *ClaimedSession) {
	t.Helper()
	if err := os.RemoveAll(job.WT.Path); err != nil {
		t.Fatal(err)
	}
	mustGit(t, job.WT.RepoDir, "worktree", "prune")
}

// checkoutDoors are the ways a session checkout is made: in setupCheckout, for a new session and for a new supervisor
// whose session's checkout has gone; in setupSourceWorktree, for a run pinned to a commit; and in
// restoreAbsentCheckout, for the claim that wakes a supervisor whose checkout has gone. prepare makes what a door needs
// and returns the call that makes the checkout through it.
var checkoutDoors = []struct {
	name    string
	prepare func(t *testing.T, repo string) func() sessionCheckout
}{
	{"a new session", func(t *testing.T, repo string) func() sessionCheckout {
		return func() sessionCheckout {
			job := &ClaimedSession{SessionID: "s-new", Branch: "orbit/s-new"}
			setupWorktree(job, repo)
			return checkoutOf(job)
		}
	}},
	{"a run pinned to a commit", func(t *testing.T, repo string) func() sessionCheckout {
		pin := mustGit(t, repo, "rev-parse", "HEAD")
		return func() sessionCheckout {
			job := pinnedJob(repo, "s-pinned", pin)
			setupWorktree(job, repo)
			return checkoutOf(job)
		}
	}},
	{"a new supervisor for a session whose checkout has gone", func(t *testing.T, repo string) func() sessionCheckout {
		job := sessionWithWork(t, repo, "s-revived")
		takeCheckoutAway(t, job)
		return func() sessionCheckout {
			again := &ClaimedSession{SessionID: job.SessionID, Branch: job.Branch}
			setupWorktree(again, repo)
			return checkoutOf(again)
		}
	}},
	{"the claim that wakes a supervisor whose checkout has gone", func(t *testing.T, repo string) func() sessionCheckout {
		job := sessionWithWork(t, repo, "s-woken")
		pool := newSessionPool(4)
		if _, added := pool.register(job, func() {}, false); !added {
			t.Fatal("register a cold supervisor")
		}
		takeCheckoutAway(t, job)
		return func() sessionCheckout {
			claim := &ClaimedSession{SessionID: job.SessionID, Branch: job.Branch}
			restoreAbsentCheckout(pool, claim)
			got := checkoutOf(job)
			got.refusal, got.creation = claim.SourceRefusal, claim.CheckoutCreation
			if job.CheckoutCreation != claim.CheckoutCreation {
				t.Errorf("the supervisor should know how its checkout came back, %q, got %q", claim.CheckoutCreation, job.CheckoutCreation)
			}
			return got
		}
	}},
}

// requireCheckoutMade fails unless the door made a checkout of the session's branch at path, with no refusal, and git
// lists that checkout once.
func requireCheckoutMade(t *testing.T, repo string, got sessionCheckout) {
	t.Helper()
	if got.refusal != nil || got.path == "" || got.isolation != isoWorktree {
		t.Fatalf("the door made no checkout: path %q, isolation %q, refusal %+v", got.path, got.isolation, got.refusal)
	}
	if branch := mustGit(t, got.path, "symbolic-ref", "--short", "HEAD"); branch != got.branch {
		t.Errorf("the checkout should stand on %s, stands on %s", got.branch, branch)
	}
	if head, tip := mustGit(t, got.path, "rev-parse", "HEAD"), mustGit(t, repo, "rev-parse", "refs/heads/"+got.branch); head != tip {
		t.Errorf("the checkout should stand on its branch's tip %s, stands on %s", tip, head)
	}
	// git names a checkout, and the workspace in the log, by its real path: on macOS a temporary directory under /var
	// is /private/var to git.
	listed := 0
	for _, line := range strings.Split(mustGit(t, repo, "worktree", "list", "--porcelain"), "\n") {
		if listedPath, ok := strings.CutPrefix(line, "worktree "); ok && realPath(listedPath) == realPath(got.path) {
			listed++
		}
	}
	if listed != 1 {
		t.Errorf("git should list the checkout once, lists it %d times", listed)
	}
}

func sparseName(sparse bool) string {
	if sparse {
		return "sparse"
	}
	return "full"
}

func TestEveryDoorClonesASessionCheckoutFromTheWorkspacesCheckout(t *testing.T) {
	for _, door := range checkoutDoors {
		for _, sparse := range []bool{false, true} {
			t.Run(door.name+", "+sparseName(sparse), func(t *testing.T) {
				t.Setenv("ORBIT_HOME", t.TempDir())
				clones := useFakeClones(t)
				repo, _ := cloneFixture(t, sparse)
				open := door.prepare(t, repo)
				clones.forget()

				var got sessionCheckout
				logs := captureLogs(t, func() { got = open() })

				requireCheckoutMade(t, repo, got)
				if got.creation != checkoutCloned {
					t.Fatalf("the checkout should be cloned, was made %q:\n%s", got.creation, logs)
				}
				if want := fmt.Sprintf("— checkout cloned: %d files from %s", fixtureFilesCloned(sparse), realPath(repo)); !strings.Contains(logs, want) {
					t.Errorf("the log should say the checkout was cloned (%q), got:\n%s", want, logs)
				}
				requireLikeAPlainCheckout(t, repo, got.path)
				if sparse {
					requireLeftOut(t, got.path, "docs/guide.md", "docs/mocks/board.png")
				}
				if kept, want := clones.kept(t, got.path), fixtureClonesKept(sparse); !reflect.DeepEqual(kept, want) {
					t.Errorf("the clones kept should be every file the template holds as the commit does:\n got %q\nwant %q", kept, want)
				}
				if len(clones.symlinks) > 0 {
					t.Errorf("files were cloned into a checkout that held symlinks: %q", clones.symlinks)
				}
				requireTemplateUnmovedByEdits(t, repo, got.path)
			})
		}
	}
}

// requireLeftOut fails unless each path is out of the checkout at path, and in its index marked skip-worktree.
func requireLeftOut(t *testing.T, path string, names ...string) {
	t.Helper()
	for _, name := range names {
		if !checkoutAbsent(filepath.Join(path, name)) {
			t.Errorf("%s should be left out of the checkout", name)
		}
		if tag := mustGit(t, path, "ls-files", "-t", "--", name); tag != "S "+name {
			t.Errorf("%s should be in the index marked skip-worktree, got %q", name, tag)
		}
	}
}

func TestAFailedCloneFallsBackToAPlainCheckout(t *testing.T) {
	failures := []struct {
		name    string
		reason  string // how the log line names it
		cloned  int
		failure func(made int) error
	}{
		// The filesystem turns cloning down after the probe passed: a path under the template on another mount, say.
		{"EOPNOTSUPP", "clone failed (EOPNOTSUPP): the first file, ", 0, func(int) error { return syscall.EOPNOTSUPP }},
		{"EXDEV", "clone failed (EXDEV): the first file, ", 0, func(int) error { return syscall.EXDEV }},
		{"a failure midway", "clone failed midway (EIO): ", 3, func(made int) error {
			if made == 3 {
				return syscall.EIO
			}
			return nil
		}},
	}
	for _, failure := range failures {
		for _, door := range checkoutDoors {
			for _, sparse := range []bool{false, true} {
				t.Run(failure.name+", "+door.name+", "+sparseName(sparse), func(t *testing.T) {
					t.Setenv("ORBIT_HOME", t.TempDir())
					clones := useFakeClones(t)
					repo, _ := cloneFixture(t, sparse)
					open := door.prepare(t, repo)
					clones.forget()
					clones.failure = failure.failure

					var got sessionCheckout
					logs := captureLogs(t, func() { got = open() })

					requireCheckoutMade(t, repo, got)
					if got.creation != checkoutPlain {
						t.Fatalf("the checkout should be plain, was made %q:\n%s", got.creation, logs)
					}
					line := logLine(logs, "— checkout plain: ")
					if want := "— checkout plain: " + failure.reason; !strings.Contains(line, want) || !strings.Contains(line, "could not be cloned from "+realPath(repo)) || !strings.HasSuffix(line, "; git writes it instead") {
						t.Errorf("the log should say why the checkout was not cloned (%q), got:\n%s", want, logs)
					}
					if failure.cloned > 0 && !strings.Contains(line, fmt.Sprintf(" after %d files;", failure.cloned)) {
						t.Errorf("the log should say how many files were cloned before the failure, got %q", line)
					}
					requireLikeAPlainCheckout(t, repo, got.path)
					if sparse {
						requireLeftOut(t, got.path, "docs/guide.md", "docs/mocks/board.png")
					}
					// What the attempt cloned went with it: git wrote every file of the checkout there is.
					if made := clones.cloned(); made != failure.cloned {
						t.Errorf("the attempt should have cloned %d files before it failed, cloned %d", failure.cloned, made)
					}
					if kept := clones.kept(t, got.path); len(kept) != 0 {
						t.Errorf("nothing of the failed attempt should be left in the checkout, found clones at %q", kept)
					}
					requireTemplateUnmovedByEdits(t, repo, got.path)
				})
			}
		}
	}
}

func TestACheckoutIsPlainWhereTheFilesystemCannotClone(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	clones := useFakeClones(t)
	clones.probeFailure = syscall.EOPNOTSUPP
	repo, _ := cloneFixture(t, false)
	root := worktreesDir()

	job := &ClaimedSession{SessionID: "s-plain", Branch: "orbit/s-plain"}
	logs := captureLogs(t, func() { setupWorktree(job, repo) })

	got := checkoutOf(job)
	requireCheckoutMade(t, repo, got)
	if got.creation != checkoutPlain || clones.cloned() != 0 {
		t.Fatalf("the checkout should be plain and nothing cloned, was made %q with %d clones", got.creation, clones.cloned())
	}
	for _, want := range []string{
		"checkouts: plain: probe failed (EOPNOTSUPP): the filesystem of " + root + " cannot clone files, so git writes out every session checkout",
		"session s-plain — checkout plain: probe failed (EOPNOTSUPP): the filesystem of " + root + " cannot clone files",
	} {
		if !strings.Contains(logs, want) {
			t.Errorf("the log should say %q, got:\n%s", want, logs)
		}
	}
	requireLikeAPlainCheckout(t, repo, got.path)

	// The answer stands for the filesystem: the next checkout does not probe it again.
	second := &ClaimedSession{SessionID: "s-plain-2", Branch: "orbit/s-plain-2"}
	if setupWorktree(second, repo); second.CheckoutCreation != checkoutPlain || clones.probes != 1 {
		t.Errorf("a second checkout should be plain without a second probe: made %q, %d probes", second.CheckoutCreation, clones.probes)
	}
}

// logLine is the first line of logs that holds marker, without its line break, or "".
func logLine(logs, marker string) string {
	for _, line := range strings.Split(logs, "\n") {
		if strings.Contains(line, marker) {
			return line
		}
	}
	return ""
}

// The log names a failure by its errno's own name, which is what an operator searches for, wrapped or not. Linux has
// one number for ENOTSUP and EOPNOTSUPP; macOS has two, and clonefile answers ENOTSUP.
func TestCloneFailuresAreLoggedByTheirErrnosName(t *testing.T) {
	for _, c := range []struct {
		err  error
		want string
	}{
		{syscall.EOPNOTSUPP, "EOPNOTSUPP"},
		{syscall.EXDEV, "EXDEV"},
		{&os.PathError{Op: "open", Path: "/x", Err: syscall.EACCES}, "EACCES"},
		{&fileCloneError{path: "a", after: 2, err: syscall.EIO}, "EIO"},
		{fmt.Errorf("probing: %w", syscall.ENOSPC), "ENOSPC"},
		{errors.ErrUnsupported, "unsupported operation"},
	} {
		if got := errnoName(c.err); got != c.want {
			t.Errorf("errnoName(%v) = %q, want %q", c.err, got, c.want)
		}
	}
	want := "ENOTSUP"
	if syscall.ENOTSUP == syscall.EOPNOTSUPP {
		want = "EOPNOTSUPP"
	}
	if got := errnoName(syscall.ENOTSUP); got != want {
		t.Errorf("errnoName(ENOTSUP) = %q, want %q", got, want)
	}
	if got := whyCloneFailed("/w", errors.New("exit status 128: fatal: bad index")); got != "clone failed (git): exit status 128: fatal: bad index" {
		t.Errorf("a git step's failure should read as one, got %q", got)
	}
}

// otherFilesystem is a directory of the test's own on a filesystem other than near's, or "" when there is none to use.
func otherFilesystem(t *testing.T, near string) string {
	t.Helper()
	nearDev, err := fileDevice(near)
	if err != nil {
		t.Fatal(err)
	}
	if dev, err := fileDevice("/dev/shm"); err != nil || dev == nearDev {
		return ""
	}
	dir, err := os.MkdirTemp("/dev/shm", "orbit-clone-test-")
	if err != nil {
		return ""
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func TestTheCloneProbeIsAskedOncePerFilesystem(t *testing.T) {
	clones := useFakeClones(t)
	dir := t.TempDir()
	for i := 0; i < 3; i++ {
		if _, err := clonableFilesystem(dir); err != nil {
			t.Fatalf("the stand-in clones, yet the probe said %v", err)
		}
	}
	if clones.probes != 1 {
		t.Fatalf("one filesystem should be probed once, was probed %d times", clones.probes)
	}
	// A runner that starts again probes again.
	forgetCloneProbes()
	if _, _ = clonableFilesystem(dir); clones.probes != 2 {
		t.Fatalf("a runner that starts again should probe again: %d probes", clones.probes)
	}
	other := otherFilesystem(t, dir)
	if other == "" {
		t.Log("no second filesystem (/dev/shm) to probe beside the first")
		return
	}
	_, _ = clonableFilesystem(other)
	_, _ = clonableFilesystem(dir)
	if clones.probes != 3 {
		t.Errorf("another filesystem should be probed once of its own, and the first not again: %d probes", clones.probes)
	}
}

func TestAWorkspaceOnAnotherFilesystemIsNotClonedFrom(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	other := otherFilesystem(t, worktreesDir())
	if other == "" {
		t.Skip("no second filesystem (/dev/shm) to keep the workspace on")
	}
	clones := useFakeClones(t)
	repo, _ := cloneFixtureIn(t, other, false)

	job := &ClaimedSession{SessionID: "s-elsewhere", Branch: "orbit/s-elsewhere"}
	logs := captureLogs(t, func() { setupWorktree(job, repo) })

	got := checkoutOf(job)
	requireCheckoutMade(t, repo, got)
	// The stand-in copies across filesystems as readily as within one: no clone at all says it was never asked.
	if got.creation != checkoutPlain || clones.cloned() != 0 {
		t.Fatalf("the checkout should be plain and nothing cloned, was made %q with %d clones", got.creation, clones.cloned())
	}
	if want := "session s-elsewhere — checkout plain: another filesystem (EXDEV): the workspace's checkout " + realPath(repo) + " is not on the filesystem of " + worktreesDir(); !strings.Contains(logs, want) {
		t.Errorf("the log should say %q, got:\n%s", want, logs)
	}
	requireLikeAPlainCheckout(t, repo, got.path)
}

// The real clone, where the test's own filesystem has one (APFS, XFS with reflink=1, btrfs): run elsewhere, it says
// why it did not run. HPC's disks are ext4; TMPDIR on another filesystem runs it there.
func TestARealCloneOfASessionCheckout(t *testing.T) {
	for _, sparse := range []bool{false, true} {
		t.Run(sparseName(sparse), func(t *testing.T) {
			t.Setenv("ORBIT_HOME", t.TempDir())
			forgetCloneProbes()
			t.Cleanup(forgetCloneProbes)
			if err := probeCloning(worktreesDir()); err != nil {
				t.Skipf("the filesystem of %s cannot clone files (%s); with TMPDIR on one that can, this runs there", worktreesDir(), errnoName(err))
			}
			clones := recordClones(t, platformCloneFile)
			repo, base := cloneFixture(t, sparse)

			job := &ClaimedSession{SessionID: "s-real", Branch: "orbit/s-real"}
			logs := captureLogs(t, func() { setupWorktree(job, repo) })

			got := checkoutOf(job)
			requireCheckoutMade(t, repo, got)
			if got.creation != checkoutCloned {
				t.Fatalf("the checkout should be cloned, was made %q:\n%s", got.creation, logs)
			}
			if job.WT.BaseSha != base {
				t.Errorf("the checkout should fork from %s, forks from %s", base, job.WT.BaseSha)
			}
			if diff := mustGit(t, got.path, "diff", "--name-status", base); diff != "" {
				t.Errorf("the checkout should not differ from its base, got %q", diff)
			}
			requireLikeAPlainCheckout(t, repo, got.path)
			if kept, want := clones.kept(t, got.path), fixtureClonesKept(sparse); !reflect.DeepEqual(kept, want) {
				t.Errorf("the clones kept should be every file the template holds as the commit does:\n got %q\nwant %q", kept, want)
			}
			if len(clones.symlinks) > 0 {
				t.Errorf("files were cloned into a checkout that held symlinks: %q", clones.symlinks)
			}
			requireTemplateUnmovedByEdits(t, repo, got.path)
		})
	}
}
