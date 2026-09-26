//go:build linux || darwin

package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestProbeLeavesTheIndexAlone: the heartbeat's own `git status` is what left an empty index.lock in
// a live session's checkout on 2026-09-25. Status takes that lock whenever it can, to write back the
// stat data it refreshed, and the probe's budget ran out while it held it. A probe runs with optional
// locks off, so it never takes the lock at all: the index a status would have rewritten stays byte
// for byte what it was — and the control at the end shows an ordinary status does rewrite it.
func TestProbeLeavesTheIndexAlone(t *testing.T) {
	wt := sessionWorktree(t, "sProbe")
	index := filepath.Join(mustGit(t, wt.Path, "rev-parse", "--absolute-git-dir"), "index")
	// Same content, new mtime: the index's stat data for base.txt is now out of date, which is
	// what a refreshing status writes back.
	later := time.Now().Add(time.Hour)
	if err := os.Chtimes(filepath.Join(wt.Path, "base.txt"), later, later); err != nil {
		t.Fatal(err)
	}
	before := readIndex(t, index)

	if !contextWorktreeGitOps(context.Background()).worktreeIsDirty(wt) {
		t.Fatal("the probe must still see the checkout's untracked work")
	}
	if !bytes.Equal(readIndex(t, index), before) {
		t.Fatal("the heartbeat's dirty probe rewrote the checkout's index, so it took index.lock to do it")
	}

	mustGit(t, wt.Path, "status", "--porcelain")
	if bytes.Equal(readIndex(t, index), before) {
		t.Fatal("control: an ordinary status left the index alone too, so the probe's doing so proves nothing")
	}
}

// TestProbeCutOffLeavesNoLockBehind: a probe cut off at its deadline is asked to stop with SIGTERM,
// on which git removes the lock files it holds, instead of Go's default SIGKILL, on which it cannot.
// The git here holds the index lock through an editor that never returns — `commit -a` keeps it
// from staging to the end of the commit — so the deadline is sure to land while the lock is held.
func TestProbeCutOffLeavesNoLockBehind(t *testing.T) {
	wt := sessionWorktree(t, "sCutOff")
	if err := os.WriteFile(filepath.Join(wt.Path, "base.txt"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	lock := filepath.Join(mustGit(t, wt.Path, "rev-parse", "--absolute-git-dir"), "index.lock")
	pidFile := filepath.Join(t.TempDir(), "editor.pid")
	t.Setenv("GIT_EDITOR", writeFakeBin(t, t.TempDir(), "editor",
		"echo $$ > "+pidFile+"\nexec sleep 60 >/dev/null 2>&1"))
	t.Cleanup(func() {
		if raw, err := os.ReadFile(pidFile); err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil {
				_ = syscall.Kill(pid, syscall.SIGKILL)
			}
		}
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := gitCtx(ctx, wt.Path, "commit", "-a")
		done <- err
	}()
	for deadline := time.Now().Add(20 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if _, err := os.Stat(pidFile); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("git never reached its editor")
		}
	}
	if _, err := os.Stat(lock); err != nil {
		t.Fatalf("git is not holding the index lock through its editor, so cutting it off proves nothing: %v", err)
	}

	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a commit cut off in its editor reported success")
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the cut-off git never returned")
	}
	if _, err := os.Stat(lock); !os.IsNotExist(err) {
		t.Fatalf("the cut-off git left %s behind (stat err: %v)", lock, err)
	}
}

func readIndex(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
