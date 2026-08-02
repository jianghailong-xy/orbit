package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestSessionProcessTreeCancellationKillsShellDescendant(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("process-group assertion is Unix-specific")
	}
	dir := t.TempDir()
	ready := filepath.Join(dir, "ready")
	late := filepath.Join(dir, "late")
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(
		ctx,
		"bash",
		"-c",
		`(sleep 0.3; printf late > "$2") & printf ready > "$1"; wait`,
		"bash",
		ready,
		late,
	)
	configureSessionProcessTree(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			cancel()
			_ = waitSessionProcessTree(cmd)
			t.Fatal("shell descendant did not start")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	_ = waitSessionProcessTree(cmd)
	time.Sleep(400 * time.Millisecond)
	if _, err := os.Stat(late); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("shell descendant survived supervisor cancellation: %v", err)
	}
}

func TestSessionProcessTreeWaitKillsDescendantAfterLeaderExit(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("process-group assertion is Unix-specific")
	}
	dir := t.TempDir()
	late := filepath.Join(dir, "late")
	cmd := exec.CommandContext(
		context.Background(),
		"bash",
		"-c",
		`(sleep 0.3; printf late > "$1") & exit 0`,
		"bash",
		late,
	)
	configureSessionProcessTree(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	if err := waitSessionProcessTree(cmd); err != nil {
		t.Fatal(err)
	}
	time.Sleep(400 * time.Millisecond)
	if _, err := os.Stat(late); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("shell descendant survived normal group-leader exit: %v", err)
	}
}
