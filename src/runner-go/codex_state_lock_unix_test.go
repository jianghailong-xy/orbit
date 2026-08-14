//go:build linux || darwin

package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestCodexStateInitFileLockSerializesAndIsPrivate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.init.lock")
	unlock, err := acquireCodexStateInitFileLock(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	if _, err := acquireCodexStateInitFileLock(ctx, path); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("contending lock = %v, want context deadline", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != configFilePerm {
		t.Fatalf("lock mode = %04o, want %04o", got, configFilePerm)
	}

	unlock()
	unlockAgain, err := acquireCodexStateInitFileLock(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	unlockAgain()
}

func TestCodexStateHandshakeLockSerializesSharedStartsAndDegrades(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	shared := codexStateSelection{Dir: "/state", Partition: codexStatePartition("/root/.codex"), Shared: true}

	unlock := lockCodexStateHandshakeWithTimeout(context.Background(), shared, time.Second)
	lockPath, err := codexStateInitLockPath(shared.Partition)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(lockPath); err != nil {
		t.Fatalf("handshake lock was not taken: %v", err)
	}
	// A second start on the same partition waits rather than opening the SQLite home
	// alongside the first one.
	held := make(chan struct{})
	go func() {
		defer close(held)
		lockCodexStateHandshakeWithTimeout(context.Background(), shared, time.Minute)()
	}()
	select {
	case <-held:
		t.Fatal("concurrent handshake was not serialized")
	case <-time.After(150 * time.Millisecond):
	}
	unlock()
	select {
	case <-held:
	case <-time.After(5 * time.Second):
		t.Fatal("handshake lock was not released")
	}

	// Waiting out a stuck holder degrades to the unserialized start, never to a failure.
	unlock = lockCodexStateHandshakeWithTimeout(context.Background(), shared, time.Second)
	defer unlock()
	start := time.Now()
	lockCodexStateHandshakeWithTimeout(context.Background(), shared, 100*time.Millisecond)()
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("degraded handshake waited %s, want the bounded timeout", elapsed)
	}
}

func TestCodexStateHandshakeLockSkipsSessionLocalState(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ORBIT_HOME", root)
	// Legacy state has one writer, so it takes no lock — and leaves no lock file behind.
	lockCodexStateHandshakeWithTimeout(context.Background(), codexStateSelection{Dir: "/state", Layout: codexStateLayoutLegacy}, time.Second)()
	entries, err := filepath.Glob(filepath.Join(root, ".codex-state-*.init.lock"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("session-local start took a partition lock: %v", entries)
	}
}

func TestCodexStateInitFileLockSerializesAcrossProcesses(t *testing.T) {
	if os.Getenv("ORBIT_CODEX_LOCK_CHILD") == "1" {
		path := os.Getenv("ORBIT_CODEX_LOCK_PATH")
		wantBlocked := os.Getenv("ORBIT_CODEX_LOCK_BLOCKED") == "1"
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		defer cancel()
		unlock, err := acquireCodexStateInitFileLock(ctx, path)
		if wantBlocked {
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("child lock = %v, want deadline", err)
			}
			return
		}
		if err != nil {
			t.Fatal(err)
		}
		if os.Getenv("ORBIT_CODEX_LOCK_HOLD") == "1" {
			fmt.Println("locked")
			for {
				time.Sleep(100 * time.Millisecond)
			}
		}
		unlock()
		return
	}

	path := filepath.Join(t.TempDir(), "cross-process.init.lock")
	unlock, err := acquireCodexStateInitFileLock(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	runChild := func(wantBlocked bool) {
		t.Helper()
		cmd := exec.Command(os.Args[0], "-test.run=^TestCodexStateInitFileLockSerializesAcrossProcesses$")
		blocked := "0"
		if wantBlocked {
			blocked = "1"
		}
		cmd.Env = append(os.Environ(),
			"ORBIT_CODEX_LOCK_CHILD=1",
			"ORBIT_CODEX_LOCK_PATH="+path,
			"ORBIT_CODEX_LOCK_BLOCKED="+blocked,
		)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("lock child failed: %v\n%s", err, output)
		}
	}
	runChild(true)
	unlock()
	runChild(false)
}

func TestCodexStateInitFileLockReleasesWhenOwnerIsKilled(t *testing.T) {
	path := filepath.Join(t.TempDir(), "killed-owner.init.lock")
	cmd := exec.Command(os.Args[0], "-test.run=^TestCodexStateInitFileLockSerializesAcrossProcesses$")
	cmd.Env = append(os.Environ(),
		"ORBIT_CODEX_LOCK_CHILD=1",
		"ORBIT_CODEX_LOCK_PATH="+path,
		"ORBIT_CODEX_LOCK_HOLD=1",
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || line != "locked\n" {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		t.Fatalf("lock child readiness = %q, %v", line, err)
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	unlock, err := acquireCodexStateInitFileLock(ctx, path)
	if err != nil {
		t.Fatalf("lock was not released after owner kill: %v", err)
	}
	unlock()
}
