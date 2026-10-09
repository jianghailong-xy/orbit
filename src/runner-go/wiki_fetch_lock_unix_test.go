//go:build linux || darwin

package main

import (
	"path/filepath"
	"testing"
	"time"
)

// The wiki fetch lock is one file per repository, and two holders of it exclude each other even inside
// one process — the runner's operations are goroutines of one process.
func TestWikiFetchLockExcludesAnotherHolderInTheSameProcess(t *testing.T) {
	path := filepath.Join(t.TempDir(), wikiFetchLockName)
	release, held := acquireWikiFetchLock(path, time.Second)
	if !held {
		t.Fatal("the first holder could not take the lock")
	}
	start := time.Now()
	if _, again := acquireWikiFetchLock(path, 200*time.Millisecond); again {
		t.Fatal("a second holder took the lock the first still holds")
	}
	if waited := time.Since(start); waited < 200*time.Millisecond {
		t.Fatalf("the second holder gave up after %s, before its wait of 200ms", waited)
	}
	release()
	next, held := acquireWikiFetchLock(path, time.Second)
	if !held {
		t.Fatal("the lock could not be taken once its holder let go")
	}
	next()
}

// A fetch stuck holding the checkout's wiki fetch lock holds the next operation for wikiFetchLockWait and
// no longer: past it the operation fetches without the lock, and answers.
func TestWikiRepoOpWaitsForAStuckFetchLockAtMostItsBound(t *testing.T) {
	f := newWikiRepoOpFixture(t)
	moved := f.push(t, "main moves", func() { f.write(t, "docs/moved.md", "# Moved\n") })
	release, held := acquireWikiFetchLock(filepath.Join(gitCommonDir(f.checkout), wikiFetchLockName), time.Second)
	if !held {
		t.Fatal("could not take the lock a stuck fetch would hold")
	}
	defer release()
	restore := wikiFetchLockWait
	wikiFetchLockWait = 500 * time.Millisecond
	t.Cleanup(func() { wikiFetchLockWait = restore })

	start := time.Now()
	outcome := runWikiRepoOp(f.command(t, "snapshot", map[string]interface{}{}), nil)
	took := time.Since(start)
	if outcome.state != "succeeded" || outcome.result["sha"] != moved {
		t.Fatalf("the snapshot behind a stuck fetch = %s %v (%s), want one at %s", outcome.state, outcome.result["sha"], outcome.err, moved)
	}
	if took < wikiFetchLockWait {
		t.Fatalf("the snapshot answered in %s, inside the lock's bound of %s: it never waited for the lock", took, wikiFetchLockWait)
	}
}
