//go:build linux || darwin

package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// A commit runs beside the session's background jobs, and a job may be running git in the same
// checkout — which holds index.lock for as long as one of its commands takes. commitWorktree waits
// that out for a short, bounded time instead of failing on the first "File exists", and a lock
// still held once the wait is over is reported as the reason the commit failed.
//
// The lock is taken the way git takes it, by creating index.lock exclusively, and the fixture
// checks that git is really stopped by it before the commit is asked for.
func TestCommitRetriesOnIndexLock(t *testing.T) {
	t.Run("released while the commit waits", func(t *testing.T) {
		c := newIndexLockCheckout(t, "lockbrief")
		release := c.holdIndexLock(t)
		const heldFor = time.Second
		released := make(chan error, 1)
		go func() {
			time.Sleep(heldFor)
			released <- release()
		}()
		started := time.Now()
		res := commitWorktree(CommitCommand{SessionID: c.id, Branch: c.branch})
		elapsed := time.Since(started)
		if err := <-released; err != nil {
			t.Fatalf("the index lock was gone before its holder let go of it — removed by someone who does not own it: %v", err)
		}
		if res.Status != "committed" {
			t.Fatalf("commit = %q (%s) after %s, want committed once the lock was let go at %s",
				res.Status, res.Message, elapsed, heldFor)
		}
		if elapsed < heldFor {
			t.Fatalf("the commit landed after %s, before the lock was let go at %s: it never met the lock", elapsed, heldFor)
		}
		if head := mustGit(t, c.checkout, "rev-parse", "HEAD"); head == c.before {
			t.Fatal("the branch did not advance after a commit that reported committed")
		}
		if _, err := git(c.checkout, "cat-file", "-e", "HEAD:work.txt"); err != nil {
			t.Fatalf("the commit does not carry the checkout's work: %v", err)
		}
	})

	t.Run("still held when the wait is over", func(t *testing.T) {
		c := newIndexLockCheckout(t, "lockheld")
		release := c.holdIndexLock(t)
		// Let go long after any sensible wait, so a commit that waits without a bound ends — having
		// committed, which fails below — instead of hanging the suite.
		finished := make(chan struct{})
		defer close(finished)
		go func() {
			select {
			case <-time.After(20 * time.Second):
				_ = release()
			case <-finished:
			}
		}()
		started := time.Now()
		res := commitWorktree(CommitCommand{SessionID: c.id, Branch: c.branch})
		elapsed := time.Since(started)
		if res.Status != "error" {
			t.Fatalf("commit = %q (%s) after %s, want an error while another process holds the index lock",
				res.Status, res.Message, elapsed)
		}
		// The bound is about 2s: enough to outlast one git command, not enough to keep a commit on
		// the session's operation gate for long.
		if elapsed < 1500*time.Millisecond {
			t.Fatalf("the commit gave up after %s without waiting for the lock: %q", elapsed, res.Message)
		}
		if elapsed > 6*time.Second {
			t.Fatalf("the commit waited %s for the lock, want a bound of about 2s: %q", elapsed, res.Message)
		}
		for _, want := range []string{"index.lock", "still held", "2s"} {
			if !strings.Contains(res.Message, want) {
				t.Fatalf("the error does not say why the commit failed (missing %q): %q", want, res.Message)
			}
		}
		if head := mustGit(t, c.checkout, "rev-parse", "HEAD"); head != c.before {
			t.Fatal("the branch moved under a commit that reported an error")
		}
	})
}

type indexLockCheckout struct {
	id       string
	branch   string
	checkout string // worktreesDir()/<session>, on branch
	before   string // the branch tip before the commit
}

// newIndexLockCheckout lays a session checkout out the way the runner does, leaves work in it to
// commit, and puts a `claude` on PATH that declines to write the message, so the commit takes its
// diffstat fallback without anything leaving the machine.
func newIndexLockCheckout(t *testing.T, id string) *indexLockCheckout {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	c := &indexLockCheckout{id: id, branch: "orbit/" + id, checkout: filepath.Join(worktreesDir(), id)}
	mustGit(t, repo, "worktree", "add", "-b", c.branch, c.checkout)
	if err := os.WriteFile(filepath.Join(c.checkout, "work.txt"), []byte("the session's work\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	writeFakeBin(t, bin, "claude", "exit 1")
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	c.before = mustGit(t, c.checkout, "rev-parse", "HEAD")
	return c
}

// holdIndexLock takes the checkout's index lock the way git does and returns what lets go of it.
// Letting go fails if the file is already gone: nobody but its holder may remove a lock.
func (c *indexLockCheckout) holdIndexLock(t *testing.T) func() error {
	t.Helper()
	path := mustGit(t, c.checkout, "rev-parse", "--git-path", "index.lock")
	if !filepath.IsAbs(path) {
		path = filepath.Join(c.checkout, path)
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		t.Fatalf("taking the index lock: %v", err)
	}
	f.Close()
	var once sync.Once
	var releaseErr error
	release := func() error {
		once.Do(func() { releaseErr = os.Remove(path) })
		return releaseErr
	}
	t.Cleanup(func() { _ = release() })
	// A lock git does not respect would make every assertion about waiting for it vacuous.
	if _, err := git(c.checkout, "add", "-A"); err == nil || !strings.Contains(gitStderr(err), "index.lock") {
		t.Fatalf("git was not stopped by the index lock this test holds (err=%v)", err)
	}
	return release
}
