//go:build linux || darwin

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
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
		if !strings.HasPrefix(res.Summary, "Something took this worktree's index lock ") || !strings.HasSuffix(res.Summary, " ago and still holds it. Retry in a moment, or hand it to the session.") {
			t.Fatalf("the summary must say, in plain words, that the lock is young and still held: %q", res.Summary)
		}
		if head := mustGit(t, c.checkout, "rev-parse", "HEAD"); head != c.before {
			t.Fatal("the branch moved under a commit that reported an error")
		}
	})
}

// TestCommitRemovesAnAbandonedIndexLock is the 2026-09-25 incident: an empty index.lock that a
// cut-off git left in a live session's checkout at 06:14 refused the Commit button at 13:58, and
// would have refused every retry after, since nothing was ever going to let go of it. A lock that
// outlasts the wait, has sat empty and untouched for longer than staleIndexLockAge, and that no
// process has open is removed, and the commit goes through — saying what it removed.
func TestCommitRemovesAnAbandonedIndexLock(t *testing.T) {
	c := newIndexLockCheckout(t, "lockabandoned")
	c.holdIndexLock(t)
	lock := ageIndexLock(t, c.checkout, 2*staleIndexLockAge)

	res := commitWorktree(CommitCommand{SessionID: c.id, Branch: c.branch})
	if res.Status != "committed" {
		t.Fatalf("commit = %q (%s), want committed past a lock nothing was using", res.Status, res.Message)
	}
	if head := mustGit(t, c.checkout, "rev-parse", "HEAD"); head == c.before {
		t.Fatal("the branch did not advance after a commit that reported committed")
	}
	if _, err := git(c.checkout, "cat-file", "-e", "HEAD:work.txt"); err != nil {
		t.Fatalf("the commit does not carry the checkout's work: %v", err)
	}
	if want := "Cleared a git lock left in this worktree 2 minutes ago by a git process that is no longer running."; res.Message != want {
		t.Fatalf("the commit must say, in plain words, what it removed and how old it was:\n got %q\nwant %q", res.Message, want)
	}
	if _, err := os.Stat(lock); !os.IsNotExist(err) {
		t.Fatalf("the abandoned lock must be gone: %v", err)
	}
}

// TestCommitLeavesAnIndexLockSomebodyHasOpen: age is not proof on its own in a live session. A git
// that has held an empty index.lock for a minute without writing it — hashing a very large tree on
// a loaded machine — is still using it, and removing it would let this commit and that git each
// write an index over the other's. The commit leaves such a lock alone and names who has it open.
func TestCommitLeavesAnIndexLockSomebodyHasOpen(t *testing.T) {
	c := newIndexLockCheckout(t, "lockopen")
	c.holdIndexLock(t)
	lock := ageIndexLock(t, c.checkout, 2*staleIndexLockAge)
	holder, err := os.Open(lock)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()

	res := commitWorktree(CommitCommand{SessionID: c.id, Branch: c.branch})
	if res.Status != "error" {
		t.Fatalf("commit = %q (%s), want an error while a process has the lock open", res.Status, res.Message)
	}
	for _, want := range []string{"still held", "not safe to remove", "pid " + strconv.Itoa(os.Getpid())} {
		if !strings.Contains(res.Message, want) {
			t.Fatalf("the error must say why the lock was left alone (missing %q): %q", want, res.Message)
		}
	}
	if want := "(pid " + strconv.Itoa(os.Getpid()) + ") has held this worktree's index lock for 2 minutes. Retry once it finishes, or hand it to the session."; !strings.HasPrefix(res.Summary, "A ") || !strings.HasSuffix(res.Summary, want) {
		t.Fatalf("the summary must name who holds the lock and for how long, in plain words: %q", res.Summary)
	}
	if _, err := os.Stat(lock); err != nil {
		t.Fatalf("a lock somebody has open must still be there: %v", err)
	}
	if head := mustGit(t, c.checkout, "rev-parse", "HEAD"); head != c.before {
		t.Fatal("the branch moved under a commit that reported an error")
	}
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

// TestAFailedCommitExpiresWhenItsReasonDoes: the worktree bar used to keep a failed commit's error
// until the next click, long after it stopped being true — on 2026-09-25 it still said the lock was
// held two hours after the agent had removed it and committed. The runner remembers what each
// failure was stuck on and reports, for exactly that operation, once the lock is gone or the branch
// has moved, so the control plane can drop the error.
func TestAFailedCommitExpiresWhenItsReasonDoes(t *testing.T) {
	failOnLock := func(t *testing.T, id string) (*indexLockCheckout, func() error, CommitCommand) {
		t.Helper()
		c := newIndexLockCheckout(t, id)
		release := c.holdIndexLock(t)
		req := CommitCommand{SessionID: c.id, Branch: c.branch, OperationID: "op-" + id}
		t.Cleanup(func() { failedCommits.clear(c.id) })
		if res := commitWorktree(req); res.Status != "error" {
			t.Fatalf("commit = %q (%s), want an error while the lock is held", res.Status, res.Message)
		}
		return c, release, req
	}
	reported := func(id string) []CommitErrorExpiry {
		var mine []CommitErrorExpiry
		for _, e := range failedCommits.expired(context.Background()) {
			if e.SessionID == id {
				mine = append(mine, e)
			}
		}
		return mine
	}

	t.Run("the lock it met is let go", func(t *testing.T) {
		c, release, req := failOnLock(t, "expirelock")
		if got := reported(c.id); len(got) != 0 {
			t.Fatalf("reported %+v while the lock that failed the commit is still held", got)
		}
		if err := release(); err != nil {
			t.Fatal(err)
		}
		got := reported(c.id)
		if len(got) != 1 || got[0].OperationID != req.OperationID {
			t.Fatalf("reported %+v, want exactly the failed operation %q once its lock is gone", got, req.OperationID)
		}
		failedCommits.forget(got)
		if again := reported(c.id); len(again) != 0 {
			t.Fatalf("reported %+v again after the control plane was told", again)
		}
	})

	t.Run("the branch moves while the lock stays", func(t *testing.T) {
		c, _, req := failOnLock(t, "expirehead")
		// Somebody commits past the failure without the index: plumbing takes no index lock.
		tree := mustGit(t, c.checkout, "rev-parse", "HEAD^{tree}")
		next := mustGit(t, c.checkout, "-c", "user.email=t@orbit", "-c", "user.name=T", "commit-tree", tree, "-p", "HEAD", "-m", "moved")
		mustGit(t, c.checkout, "update-ref", "refs/heads/"+c.branch, next)
		got := reported(c.id)
		if len(got) != 1 || got[0].OperationID != req.OperationID {
			t.Fatalf("reported %+v, want the failed operation %q once the branch has moved past it", got, req.OperationID)
		}
	})

	t.Run("a commit that goes through ends the watch", func(t *testing.T) {
		c, release, req := failOnLock(t, "expireok")
		if err := release(); err != nil {
			t.Fatal(err)
		}
		if res := commitWorktree(req); res.Status != "committed" {
			t.Fatalf("commit = %q (%s), want committed once the lock is let go", res.Status, res.Message)
		}
		if got := reported(c.id); len(got) != 0 {
			t.Fatalf("reported %+v for a session whose commit has since gone through", got)
		}
	})

	t.Run("a newer failure is not forgotten for an older report", func(t *testing.T) {
		c, release, req := failOnLock(t, "expirenewer")
		if err := release(); err != nil {
			t.Fatal(err)
		}
		stale := reported(c.id)
		c.holdIndexLock(t)
		newer := CommitCommand{SessionID: c.id, Branch: c.branch, OperationID: req.OperationID + "-2"}
		if res := commitWorktree(newer); res.Status != "error" {
			t.Fatalf("second commit = %q, want an error", res.Status)
		}
		failedCommits.forget(stale)
		failedCommits.mu.Lock()
		f, ok := failedCommits.bySession[c.id]
		failedCommits.mu.Unlock()
		if !ok || f.operationID != newer.OperationID {
			t.Fatalf("the newer failure %q was forgotten for a report about %q (%+v)", newer.OperationID, req.OperationID, f)
		}
	})
}

// TestHeartbeatCarriesExpiredCommitErrors: the report rides the heartbeat, and is forgotten only
// once a heartbeat carrying it was accepted — one that fails to send carries it again next time.
func TestHeartbeatCarriesExpiredCommitErrors(t *testing.T) {
	c := newIndexLockCheckout(t, "expirebeat")
	release := c.holdIndexLock(t)
	req := CommitCommand{SessionID: c.id, Branch: c.branch, OperationID: "op-expirebeat"}
	t.Cleanup(func() { failedCommits.clear(c.id) })
	if res := commitWorktree(req); res.Status != "error" {
		t.Fatalf("commit = %q, want an error while the lock is held", res.Status)
	}
	if err := release(); err != nil {
		t.Fatal(err)
	}
	carried := func(r HeartbeatRequest) bool {
		for _, e := range r.ExpiredCommitErrors {
			if e.SessionID == c.id && e.OperationID == req.OperationID {
				return true
			}
		}
		return false
	}
	pool := newSessionPool(1)
	telemetry := newHeartbeatTelemetryProbe(time.Second, func(context.Context, []heartbeatTelemetryTarget) []heartbeatTelemetrySample { return nil })
	var sent []HeartbeatRequest
	failing := func(r HeartbeatRequest) (*HeartbeatResponse, error) {
		sent = append(sent, r)
		return nil, errors.New("offline")
	}
	accepting := func(r HeartbeatRequest) (*HeartbeatResponse, error) {
		sent = append(sent, r)
		return &HeartbeatResponse{}, nil
	}
	_, _, _ = sendHeartbeatCycle(pool, telemetry, HeartbeatRequest{}, failing)
	_, _, _ = sendHeartbeatCycle(pool, telemetry, HeartbeatRequest{}, accepting)
	_, _, _ = sendHeartbeatCycle(pool, telemetry, HeartbeatRequest{}, accepting)
	if len(sent) != 3 || !carried(sent[0]) || !carried(sent[1]) || carried(sent[2]) {
		t.Fatalf("carried per heartbeat = %v %v %v, want true (failed to send), true (accepted), then false",
			carried(sent[0]), carried(sent[1]), carried(sent[2]))
	}
}
