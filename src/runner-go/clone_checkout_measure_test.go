//go:build linux || darwin

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestMeasureAClonedCheckout measures what a session checkout of a real repository costs, plain and cloned, on the
// filesystem under test (docs/session-checkout-storage-design.md §7, Appendix A). It runs only when asked:
//
//	ORBIT_CLONE_MEASURE_REPO=<repository> ORBIT_CLONE_MEASURE_DIR=<directory on the filesystem to measure> \
//	  go test -count=1 -v -run '^TestMeasureAClonedCheckout$' .
//
// Under ORBIT_CLONE_MEASURE_DIR it makes the workspace, a checkout of the repository's HEAD that reads the
// repository's objects where they are, and ORBIT_HOME. Then the runner's own creation path, setupWorktree, makes a
// session checkout of the workspace twice: plainly, as on a filesystem that cannot clone files, and cloned, with this
// filesystem's clones. For each it prints the bytes the filesystem lost (df, with a sync before and after) and the
// seconds it took. A filesystem that cannot clone fails the test. Everything it made is removed afterwards. Other
// writers on the same filesystem show up in the numbers, so a filesystem of its own measures cleanly.
func TestMeasureAClonedCheckout(t *testing.T) {
	repo := os.Getenv("ORBIT_CLONE_MEASURE_REPO")
	if repo == "" {
		t.Skip("ORBIT_CLONE_MEASURE_REPO names no repository to measure")
	}
	dir := os.Getenv("ORBIT_CLONE_MEASURE_DIR")
	if dir == "" {
		t.Fatal("ORBIT_CLONE_MEASURE_DIR must name a directory on the filesystem to measure")
	}
	scratch, err := os.MkdirTemp(dir, "orbit-clone-measure-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(scratch) })
	workspace := filepath.Join(scratch, "workspace")
	if out, err := exec.Command("git", "clone", "-q", "--shared", repo, workspace).CombinedOutput(); err != nil {
		t.Fatalf("git clone --shared %s: %v\n%s", repo, err, out)
	}
	mustGit(t, workspace, "config", "user.email", "measure@orbit")
	mustGit(t, workspace, "config", "user.name", "Orbit measurement")
	t.Setenv("ORBIT_HOME", filepath.Join(scratch, "home"))
	previous := cloneFile
	t.Cleanup(func() {
		cloneFile = previous
		forgetCloneProbes()
	})
	head := mustGit(t, workspace, "rev-parse", "HEAD")
	tracked := strings.Count(mustGit(t, workspace, "ls-files", "-z"), "\x00")
	t.Logf("repository %s at %s, %d tracked files, measured under %s", repo, shortSha(head), tracked, scratch)

	measure := func(name string) (int64, time.Duration) {
		t.Helper()
		forgetCloneProbes()
		job := &ClaimedSession{SessionID: "measure-" + name, Branch: "orbit/measure-" + name}
		syscall.Sync()
		before, _, ok := diskUsage(scratch)
		if !ok {
			t.Fatalf("no free space reported for %s", scratch)
		}
		start := time.Now()
		logs := captureLogs(t, func() { setupWorktree(job, workspace) })
		took := time.Since(start)
		syscall.Sync()
		after, _, _ := diskUsage(scratch)
		if job.WT == nil {
			t.Fatalf("no %s checkout was made:\n%s", name, logs)
		}
		if status := mustGit(t, job.WT.Path, "status", "--porcelain"); status != "" {
			t.Fatalf("the %s checkout should read as clean, got %q", name, status)
		}
		for _, line := range strings.Split(logs, "\n") {
			if strings.Contains(line, "session "+job.SessionID+" —") {
				t.Log(line)
			}
		}
		if want := map[string]string{"plain": checkoutPlain, "cloned": checkoutCloned}[name]; job.CheckoutCreation != want {
			t.Fatalf("the %s checkout was made %q:\n%s", name, job.CheckoutCreation, logs)
		}
		return int64(before) - int64(after), took
	}

	// Plain, as on a filesystem that refuses the probe's clone, as ext4 refuses FICLONE.
	cloneFile = func(string, string, os.FileMode) error { return syscall.EOPNOTSUPP }
	plainBytes, plainTook := measure("plain")
	cloneFile = previous
	clonedBytes, clonedTook := measure("cloned")

	const mib = 1 << 20
	t.Logf("plain checkout:  %d bytes (%.1f MiB) in %.1f s", plainBytes, float64(plainBytes)/mib, plainTook.Seconds())
	t.Logf("cloned checkout: %d bytes (%.1f MiB) in %.1f s", clonedBytes, float64(clonedBytes)/mib, clonedTook.Seconds())
	if plainBytes > 0 {
		t.Logf("the cloned checkout took %.1f%% of the plain checkout's bytes", 100*float64(clonedBytes)/float64(plainBytes))
	}
}
