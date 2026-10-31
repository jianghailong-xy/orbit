package main

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// A folder Orbit names for a machine's first workspace (docs/first-workspace-contract.md §4) is made before the
// engine starts, and only inside this machine's repos root, symlinks resolved. The repos root is
// <home>/orbit-repos (clone.go), and HOME is what userHome reads first.

func createWorkDirHome(t *testing.T) (home, root string) {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	home = t.TempDir()
	t.Setenv("HOME", home)
	return home, filepath.Join(home, reposDirName)
}

// mkdirPerm is the permission os.Mkdir(…, 0755) leaves under this process's umask, which a made workDir must have.
func mkdirPerm(t *testing.T) os.FileMode {
	t.Helper()
	ref := filepath.Join(t.TempDir(), "ref")
	if err := os.Mkdir(ref, 0o755); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(ref)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode().Perm()
}

// assertMissing: nothing can be reached at path, a link that still leads nowhere included.
func assertMissing(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("%s was made (stat: %v)", path, err)
	}
}

// The folder of a new workspace, <reposRoot>/<name>, is made with every missing parent, the repos root included,
// as mkdir -p with 0755 makes them, and the session runs in it.
func TestCreateWorkDirMakesTheNewFolderInsideTheReposRoot(t *testing.T) {
	_, root := createWorkDirHome(t)
	dir := filepath.Join(root, "app")

	job := &ClaimedSession{SessionID: "s-new-folder", CreateWorkDir: true}
	if got := setupWorktree(job, dir); got != dir {
		t.Fatalf("execDir = %q, want the new folder %q", got, dir)
	}
	want := mkdirPerm(t)
	for _, made := range []string{root, dir} {
		info, err := os.Stat(made)
		if err != nil {
			t.Fatalf("%s was not made: %v", made, err)
		}
		if !info.IsDir() || info.Mode().Perm() != want {
			t.Errorf("%s: dir=%v perm=%v, want a directory with %v", made, info.IsDir(), info.Mode().Perm(), want)
		}
	}
	if job.IsolationStatus != isoShared {
		t.Errorf("IsolationStatus = %q, want %q", job.IsolationStatus, isoShared)
	}
}

// A repos root that is itself a link is judged where it leads: a folder below it is inside.
func TestCreateWorkDirFollowsAReposRootThatIsALink(t *testing.T) {
	_, root := createWorkDirHome(t)
	elsewhere := filepath.Join(t.TempDir(), "big-disk-repos")
	if err := os.Mkdir(elsewhere, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(elsewhere, root); err != nil {
		t.Fatal(err)
	}
	setupWorktree(&ClaimedSession{SessionID: "s-linked-root", CreateWorkDir: true}, filepath.Join(root, "app"))
	if info, err := os.Stat(filepath.Join(elsewhere, "app")); err != nil || !info.IsDir() {
		t.Fatalf("the folder was not made in the root the link leads to: %v", err)
	}
}

// Anything that resolves outside the repos root is not made, and the session fails to start with the error a
// missing working directory has always had.
func TestCreateWorkDirMakesNothingOutsideTheReposRoot(t *testing.T) {
	home, root := createWorkDirHome(t)
	outside := t.TempDir()
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	// A link inside the root to a directory outside it.
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	// A link that leads nowhere yet, outside: mkdir -p would make its target.
	if err := os.Symlink(filepath.Join(outside, "dangling-target"), filepath.Join(root, "dangling")); err != nil {
		t.Fatal(err)
	}
	// A link two levels deep outside, which a `..` after it leaves outside too, where filepath.Clean would not.
	deep := t.TempDir()
	if err := os.MkdirAll(filepath.Join(deep, "a", "b"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(deep, "a", "b"), filepath.Join(root, "deep-link")); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, dir string
		made      []string // what must still not exist afterwards
	}{
		{"through a link in the root", filepath.Join(root, "escape", "app"), []string{filepath.Join(outside, "app")}},
		{"through a link that leads nowhere", filepath.Join(root, "dangling"), []string{filepath.Join(outside, "dangling-target")}},
		{"below a link that leads nowhere", filepath.Join(root, "dangling", "app"), []string{filepath.Join(outside, "dangling-target")}},
		{"beside the root", filepath.Join(home, "elsewhere", "app"), []string{filepath.Join(home, "elsewhere")}},
		{"up and out by ..", root + "/../escaped", []string{filepath.Join(home, "escaped")}},
		{"up through a link by ..", filepath.Join(root, "deep-link") + "/../app", []string{filepath.Join(root, "app"), filepath.Join(deep, "a", "app")}},
		{"anywhere else on disk", filepath.Join(outside, "deep", "app"), []string{filepath.Join(outside, "deep")}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			job := &ClaimedSession{SessionID: "s-escape", CreateWorkDir: true}
			logs := captureLogs(t, func() { setupWorktree(job, tc.dir) })
			for _, path := range append(tc.made, tc.dir) {
				assertMissing(t, path)
			}
			if !strings.Contains(logs, "not creating workDir") {
				t.Errorf("the runner did not say why it made nothing: %s", logs)
			}
		})
	}
	if entries, err := os.ReadDir(outside); err != nil || len(entries) != 0 {
		t.Errorf("something was made outside the root: %v (%v)", entries, err)
	}

	// What follows a refusal is the start that names the missing directory (spawn_workdir.go).
	dir := filepath.Join(root, "escape", "app")
	engine, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(context.Background(), engine, "-test.run=XXX_no_such_test")
	configureSessionProcessTree(cmd)
	cmd.Dir = dir
	if err := startSessionProcess(cmd); err == nil || err.Error() != "working directory "+dir+" does not exist" {
		t.Fatalf("the start after a refused folder failed with %v, want \"working directory %s does not exist\"", err, dir)
	}
}

// Nothing above the repos root is made either: with no home directory, mkdir -p of <home>/orbit-repos/<name> would
// make the home directory first.
func TestCreateWorkDirMakesNothingAboveTheReposRoot(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	home := filepath.Join(t.TempDir(), "never-made-home")
	t.Setenv("HOME", home)
	dir := filepath.Join(home, reposDirName, "app")
	logs := captureLogs(t, func() { setupWorktree(&ClaimedSession{SessionID: "s-no-home", CreateWorkDir: true}, dir) })
	assertMissing(t, home)
	if !strings.Contains(logs, "not creating workDir") {
		t.Errorf("the runner did not say why it made nothing: %s", logs)
	}
}

// A folder that is already there is left exactly as it is: no mode change, nothing added, nothing taken away.
// That includes a link in the root that leads outside it, which is somebody's to have made.
func TestCreateWorkDirLeavesAnExistingFolderAlone(t *testing.T) {
	_, root := createWorkDirHome(t)
	dir := filepath.Join(root, "app")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "README"), []byte("mine"), 0o600); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	linked := filepath.Join(root, "linked")
	if err := os.Symlink(outside, linked); err != nil {
		t.Fatal(err)
	}

	for _, path := range []string{dir, linked} {
		logs := captureLogs(t, func() { setupWorktree(&ClaimedSession{SessionID: "s-existing", CreateWorkDir: true}, path) })
		if strings.Contains(logs, "workDir") {
			t.Errorf("%s: the runner did something about a folder that is there: %s", path, logs)
		}
	}
	info, err := os.Stat(dir)
	if err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("the existing folder's mode changed: %v (%v)", info.Mode().Perm(), err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 || entries[0].Name() != "README" {
		t.Fatalf("the existing folder's contents changed: %v (%v)", entries, err)
	}
	if body, err := os.ReadFile(filepath.Join(dir, "README")); err != nil || string(body) != "mine" {
		t.Fatalf("README = %q (%v)", body, err)
	}
	if entries, err := os.ReadDir(outside); err != nil || len(entries) != 0 {
		t.Fatalf("something was made where the link leads: %v (%v)", entries, err)
	}
}

// The rule is createWorkDir's alone: a session without it keeps the old one, under which a missing workDir is made
// wherever it is (TestSetupWorktreeCreatesMissingWorkDir).
func TestWithoutCreateWorkDirAMissingWorkDirIsMadeAsBefore(t *testing.T) {
	createWorkDirHome(t)
	dir := filepath.Join(t.TempDir(), "typed-by-a-person", "project")
	setupWorktree(&ClaimedSession{SessionID: "s-legacy"}, dir)
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		t.Fatalf("a missing workDir outside the repos root was not made for a session without createWorkDir: %v", err)
	}
}

// The judgment itself, on the cases that make no directory at all.
func TestOrbitWorkDirTargetRefusals(t *testing.T) {
	home, root := createWorkDirHome(t)
	resolvedHome, err := filepath.EvalSymlinks(home)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(resolvedHome, reposDirName, "app")
	if target, err := orbitWorkDirTarget(filepath.Join(root, "app")); err != nil || target != want {
		t.Fatalf("a folder in a root that does not exist yet = %q, %v; want %q, made with the root", target, err, want)
	}
	// A relative path, the root itself, and the directory above it.
	for _, dir := range []string{reposDirName + "/app", root, root + "/..", home} {
		if target, err := orbitWorkDirTarget(dir); err == nil {
			t.Errorf("orbitWorkDirTarget(%q) = %q, want a refusal", dir, target)
		}
	}
}

// createWorkDir comes with a claim, and with a reclaim after a restart, whose spawn makes the folder again if it
// has gone since.
func TestClaimAndReclaimCarryCreateWorkDir(t *testing.T) {
	var claimed ClaimedSession
	if err := json.Unmarshal([]byte(`{"sessionId":"s1","workDir":"/home/u/orbit-repos/app","createWorkDir":true}`), &claimed); err != nil {
		t.Fatal(err)
	}
	if !claimed.CreateWorkDir {
		t.Error("a claim's createWorkDir was not read")
	}
	var resp ReclaimResponse
	if err := json.Unmarshal([]byte(`{"sessions":[{"sessionId":"new","createWorkDir":true},{"sessionId":"old"}]}`), &resp); err != nil {
		t.Fatal(err)
	}
	if !claimedSessionFromReclaim(resp.Sessions[0]).CreateWorkDir {
		t.Error("a reclaim's createWorkDir did not reach the session it starts")
	}
	if claimedSessionFromReclaim(resp.Sessions[1]).CreateWorkDir {
		t.Error("a reclaim without createWorkDir started a session with it")
	}
}
