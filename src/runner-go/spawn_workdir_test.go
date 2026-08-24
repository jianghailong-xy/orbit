package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The failure this pair of behaviours exists to prevent, as seen in production: a session on
// an agent whose workDir had never been created died 0.4s after claim with
//
//	failed to spawn claude: fork/exec /root/.local/bin/claude: no such file or directory
//
// The engine was installed, current and working — a session on the same runner started fine
// 19 seconds later. Only the cwd was missing, and nothing in that message says so.

// A workDir that isn't there yet is a dir to create, not a reason to fail the session: the
// user asked for work in it, and on a shared (non-git) workDir there is nothing else the
// runner needs from it.
func TestSetupWorktreeCreatesMissingWorkDir(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	missing := filepath.Join(t.TempDir(), "never-created", "project")

	job := &ClaimedSession{SessionID: "s-missing", Branch: "orbit/feat"}
	execDir := setupWorktree(job, missing)

	if execDir != missing {
		t.Errorf("execDir = %q, want the workDir %q", execDir, missing)
	}
	info, err := os.Stat(missing)
	if err != nil {
		t.Fatalf("workDir must exist after setup: %v", err)
	}
	if !info.IsDir() {
		t.Fatalf("workDir %q is not a directory", missing)
	}
	// Created but empty, so it is still not a git repo: shared, and the UI says why.
	if job.IsolationStatus != isoSharedNoGit {
		t.Errorf("IsolationStatus = %q, want %q", job.IsolationStatus, isoSharedNoGit)
	}
}

// With isolation opted in, creating the dir also unblocks the git init that used to fail:
// the helper shells out as `git -C <dir> init`, which exits 128 on a dir that isn't there.
// The session ends up genuinely isolated instead of silently sharing a dir that never existed.
func TestSetupWorktreeCreatesMissingWorkDirThenAutoInitsGit(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	missing := filepath.Join(t.TempDir(), "never-created", "project")

	job := &ClaimedSession{SessionID: "s-autoinit", Branch: "orbit/feat", AutoInitGit: true}
	execDir := setupWorktree(job, missing)

	if job.IsolationStatus != isoWorktree || job.WT == nil {
		t.Fatalf("IsolationStatus = %q (wt=%v), want a real worktree", job.IsolationStatus, job.WT)
	}
	if execDir == missing {
		t.Errorf("execDir must be the checkout, not the shared workDir %q", missing)
	}
	if _, err := os.Stat(filepath.Join(missing, ".git")); err != nil {
		t.Errorf("workDir must have been git-initialized: %v", err)
	}
}

// The mislabeling itself, reproduced against the real spawn path: a session process is put in
// its own process group, which is exactly what makes os/exec skip the friendly `chdir` error
// and blame argv0 instead. Whatever exec reports, what reaches the user must name the workDir.
func TestStartSessionProcessBlamesTheWorkDirNotTheEngine(t *testing.T) {
	engine, err := os.Executable() // guaranteed to exist and be executable
	if err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(t.TempDir(), "never-created")

	cmd := exec.CommandContext(context.Background(), engine, "-test.run=XXX_no_such_test")
	configureSessionProcessTree(cmd)
	cmd.Dir = missing

	err = startSessionProcess(cmd)
	if err == nil {
		t.Fatal("spawn into a missing workDir must fail")
	}
	if !strings.Contains(err.Error(), missing) {
		t.Errorf("error must name the workDir %q, got %q", missing, err)
	}
	if strings.Contains(err.Error(), engine) {
		t.Errorf("error must not blame the engine binary %q, got %q", engine, err)
	}
}

// The other half of the contract: when the binary really is the thing that's missing, the
// path in exec's message IS the answer and must survive untouched.
func TestStartSessionProcessKeepsAMissingBinaryHonest(t *testing.T) {
	engine := filepath.Join(t.TempDir(), "no-such-engine")

	cmd := exec.CommandContext(context.Background(), engine)
	configureSessionProcessTree(cmd)
	cmd.Dir = t.TempDir() // a workDir that is perfectly fine

	err := startSessionProcess(cmd)
	if err == nil {
		t.Fatal("spawning a nonexistent binary must fail")
	}
	if !strings.Contains(err.Error(), engine) {
		t.Errorf("error must still name the missing binary %q, got %q", engine, err)
	}
	if strings.Contains(err.Error(), "working directory") {
		t.Errorf("a healthy workDir must not be blamed, got %q", err)
	}
}
