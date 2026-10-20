//go:build linux || darwin

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// managedVolume is a managed runner's volume in miniature: HOME, ORBIT_HOME below it, the workspace's
// repository under reposRoot with two commits, and a session's worktree on its own branch.
type managedVolume struct {
	repo, worktree, gitDir string
}

func newManagedVolume(t *testing.T) managedVolume {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ORBIT_HOME", filepath.Join(home, ".orbit"))
	repo := filepath.Join(reposRoot(), "default")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	mustGit(t, repo, "init", "-b", "main")
	mustGit(t, repo, "config", "user.email", "test@orbit")
	mustGit(t, repo, "config", "user.name", "Test")
	commitFile(t, repo, "base.txt", "base\n", "base")
	commitFile(t, repo, "second.txt", "second\n", "second")
	worktree := filepath.Join(worktreesDir(), "sess-1")
	mustGit(t, repo, "worktree", "add", "-b", "orbit/sess-1", worktree)
	commitFile(t, worktree, "session.txt", "session\n", "session work")
	return managedVolume{repo: repo, worktree: worktree, gitDir: filepath.Join(repo, ".git")}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func onDisk(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// A Git interrupted between fsyncing a lock and renaming it into place leaves the lock, and Git
// refuses that file until somebody removes it. At start nothing runs Git on a managed runner's
// volume yet, so a lock no process holds is removed; one a process holds is not.
func TestVolumeCheckRemovesTheLocksAnInterruptedGitLeft(t *testing.T) {
	withManagedInstance(t, "4", testManagedPodUID)
	v := newManagedVolume(t)
	syncs := recordVolumeSyncs(t)
	tip := mustGit(t, v.repo, "rev-parse", "main")
	stale := []string{
		filepath.Join(v.gitDir, "refs", "heads", "main.lock"),
		filepath.Join(v.gitDir, "refs", "heads", "orbit", "sess-1.lock"),
		filepath.Join(v.gitDir, "index.lock"),
		filepath.Join(v.gitDir, "worktrees", "sess-1", "index.lock"),
	}
	for _, lock := range stale {
		writeFile(t, lock, tip+"\n")
	}
	held, err := os.OpenFile(filepath.Join(v.gitDir, "config.lock"), os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()

	logs := captureLogs(t, recoverManagedRepositories)

	for _, lock := range stale {
		if onDisk(lock) {
			t.Errorf("%s is still there", lock)
		}
	}
	if !onDisk(held.Name()) {
		t.Error("a lock this process holds open was removed")
	}
	if !strings.Contains(logs, "removed "+stale[0]) || !strings.Contains(logs, "it was writing "+tip) {
		t.Errorf("the log does not say which lock went and what it held: %s", logs)
	}
	if !strings.Contains(logs, "4 stale lock files removed, 0 branches restored, 0 checkouts damaged") {
		t.Errorf("the summary line is missing or wrong: %s", logs)
	}
	if syncs.count() != 1 {
		t.Errorf("synced %d times after changing the volume, want once", syncs.count())
	}
	commitFile(t, v.worktree, "after.txt", "after\n", "after the check") // the session's branch and index are usable again
}

// A branch a cut left empty, or missing although its reflog says it had commits, goes back to the
// newest commit its own reflog names that still reads.
func TestVolumeCheckRestoresABrokenBranchFromItsReflog(t *testing.T) {
	withManagedInstance(t, "4", testManagedPodUID)
	v := newManagedVolume(t)
	recordVolumeSyncs(t)
	mainTip := mustGit(t, v.repo, "rev-parse", "main")
	sessionTip := mustGit(t, v.repo, "rev-parse", "orbit/sess-1")
	writeFile(t, filepath.Join(v.gitDir, "refs", "heads", "main"), "")
	if err := os.Remove(filepath.Join(v.gitDir, "refs", "heads", "orbit", "sess-1")); err != nil {
		t.Fatal(err)
	}
	if reason := checkoutDamage(v.repo); !strings.Contains(reason, "its branch main is empty") {
		t.Fatalf("the empty branch was not seen: %q", reason)
	}
	if reason := checkoutDamage(v.worktree); !strings.Contains(reason, "its branch orbit/sess-1 is missing, though its reflog shows it had commits") {
		t.Fatalf("the missing branch was not seen: %q", reason)
	}

	logs := captureLogs(t, recoverManagedRepositories)

	if got := mustGit(t, v.repo, "rev-parse", "main"); got != mainTip {
		t.Errorf("main is at %s, want %s", got, mainTip)
	}
	if got := mustGit(t, v.repo, "rev-parse", "orbit/sess-1"); got != sessionTip {
		t.Errorf("orbit/sess-1 is at %s, want %s", got, sessionTip)
	}
	for _, dir := range []string{v.repo, v.worktree} {
		if reason := checkoutDamage(dir); reason != "" {
			t.Errorf("%s still reads as damaged: %s", dir, reason)
		}
	}
	if !strings.Contains(logs, "restored branch main of "+v.repo+" to "+mainTip) || !strings.Contains(logs, "2 branches restored, 0 checkouts damaged") {
		t.Errorf("the log does not say what was restored: %s", logs)
	}
}

// A branch that points at a commit whose object a cut left empty is not moved: going back would leave
// the broken object in the repository, which is for a person to decide. It is said, at start and to
// every session that would work there.
func TestVolumeCheckLeavesAnUnreadableCommitToAPerson(t *testing.T) {
	withManagedInstance(t, "4", testManagedPodUID)
	v := newManagedVolume(t)
	recordVolumeSyncs(t)
	tip := mustGit(t, v.repo, "rev-parse", "main")
	object := filepath.Join(v.gitDir, "objects", tip[:2], tip[2:])
	if err := os.Chmod(object, 0o644); err != nil {
		t.Fatal(err)
	}
	writeFile(t, object, "")

	logs := captureLogs(t, recoverManagedRepositories)

	if got := strings.TrimSpace(readFileString(t, filepath.Join(v.gitDir, "refs", "heads", "main"))); got != tip {
		t.Fatalf("main was moved to %q", got)
	}
	want := "commit " + tip + ", where its branch main points, cannot be read"
	if !strings.Contains(logs, want) || !strings.Contains(logs, "1 checkouts damaged") {
		t.Fatalf("the damage was not said: %s", logs)
	}
	job := &ClaimedSession{SessionID: "sess-2", Branch: "orbit/sess-2", AutoInitGit: true}
	if dir := setupWorktree(job, v.repo); dir != "" || job.SourceRefusal == nil || !strings.Contains(job.SourceRefusal.Detail["reason"].(string), want) {
		t.Fatalf("a session was not refused on the damaged repository: dir %q, refusal %+v", dir, job.SourceRefusal)
	}
}

func readFileString(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestCheckoutDamageSaysWhyARepositoryCannotBeRead(t *testing.T) {
	healthy := initRepo(t)
	if err := os.MkdirAll(filepath.Join(healthy, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	fresh := t.TempDir()
	mustGit(t, fresh, "init", "-b", "main")
	for _, c := range []struct {
		name, dir, want string
	}{
		{"a repository whose HEAD reads", healthy, ""},
		{"a directory inside it", filepath.Join(healthy, "sub"), ""},
		{"a repository with no commit yet", fresh, ""},
		{"a directory in no repository", t.TempDir(), ""},
	} {
		if got := checkoutDamage(c.dir); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}

	broken := func(edit func(gitDir string)) string {
		repo := initRepo(t)
		edit(filepath.Join(repo, ".git"))
		return checkoutDamage(repo)
	}
	for _, c := range []struct {
		name string
		edit func(string)
		want string
	}{
		{"an empty HEAD", func(g string) { writeFile(t, filepath.Join(g, "HEAD"), "") }, "cannot be read: its HEAD is empty"},
		{"a HEAD of nonsense", func(g string) { writeFile(t, filepath.Join(g, "HEAD"), "\x00\x00\x00") }, "its HEAD names neither a branch nor a commit"},
		{"a branch of nonsense", func(g string) { writeFile(t, filepath.Join(g, "refs", "heads", "main"), "not a commit\n") }, "its branch main holds no commit id"},
	} {
		if got := broken(c.edit); !strings.Contains(got, c.want) {
			t.Errorf("%s: %q, want it to say %q", c.name, got, c.want)
		}
	}
}

// On a managed runner a session is not run in a repository the volume brought back broken, and no
// new repository is started over it: setupWorktree's fallbacks would do both and say nothing.
func TestManagedRunnerRefusesASessionInADamagedRepository(t *testing.T) {
	withManagedInstance(t, "4", testManagedPodUID)
	v := newManagedVolume(t)
	writeFile(t, filepath.Join(v.gitDir, "HEAD"), "")
	job := &ClaimedSession{SessionID: "sess-2", Branch: "orbit/sess-2", AutoInitGit: true}

	dir := setupWorktree(job, v.repo)

	if dir != "" || job.SourceRefusal == nil || job.SourceRefusal.Code != repositoryDamagedRefusal {
		t.Fatalf("the session was not refused: dir %q, refusal %+v, isolation %q", dir, job.SourceRefusal, job.IsolationStatus)
	}
	reason, _ := job.SourceRefusal.Detail["reason"].(string)
	if !strings.Contains(reason, "the Git repository at "+v.repo+" cannot be read: its HEAD is empty") || !strings.Contains(reason, "repair it") {
		t.Fatalf("the refusal does not say what is wrong and what to do: %q", reason)
	}
	if readFileString(t, filepath.Join(v.gitDir, "HEAD")) != "" || onDisk(filepath.Join(v.repo, ".gitignore")) {
		t.Fatal("a new repository was started over the damaged one")
	}
}

// The same for a session whose own worktree came back broken: it is not re-attached, nor replaced by
// running without one.
func TestManagedRunnerRefusesToReattachADamagedWorktree(t *testing.T) {
	withManagedInstance(t, "4", testManagedPodUID)
	v := newManagedVolume(t)
	writeFile(t, filepath.Join(v.gitDir, "worktrees", "sess-1", "HEAD"), "")
	job := &ClaimedSession{SessionID: "sess-1", Branch: "orbit/sess-1"}

	if dir := setupWorktree(job, v.repo); dir != "" || job.SourceRefusal == nil ||
		!strings.Contains(job.SourceRefusal.Detail["reason"].(string), "the Git repository at "+v.worktree+" cannot be read: its HEAD is empty") {
		t.Fatalf("the damaged worktree was not refused: dir %q, refusal %+v", dir, job.SourceRefusal)
	}
}

// A self-managed runner keeps what it did before, on its owner's machine: no volume check, and the
// fallbacks of setupWorktree.
func TestSelfManagedRunnerKeepsItsWaysWithADamagedRepository(t *testing.T) {
	withoutManagedInstance(t)
	v := newManagedVolume(t)
	lock := filepath.Join(v.gitDir, "index.lock")
	writeFile(t, lock, "left behind")
	writeFile(t, filepath.Join(v.gitDir, "HEAD"), "")
	syncs := recordVolumeSyncs(t)

	if logs := captureLogs(t, recoverManagedRepositories); logs != "" || !onDisk(lock) || syncs.count() != 0 {
		t.Fatalf("a self-managed runner checked its repositories: logs %q, lock kept %v, syncs %d", logs, onDisk(lock), syncs.count())
	}
	job := &ClaimedSession{SessionID: "sess-2", Branch: "orbit/sess-2"}
	if dir := setupWorktree(job, v.repo); dir != v.repo || job.SourceRefusal != nil || job.IsolationStatus != isoSharedNoGit {
		t.Fatalf("a self-managed runner changed its fallback: dir %q, refusal %+v, isolation %q", dir, job.SourceRefusal, job.IsolationStatus)
	}
}
