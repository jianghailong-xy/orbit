package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// cursorSandbox wraps commands only; orbit-bash and Auto policy opt in separately.
// Construct it in the runner, before handing any command to untrusted code.
type cursorSandbox struct {
	binary   string
	platform string
	roots    []string
	sealed   []string
	hidden   []string
	locked   []string
	reopened []string
}

func detectCursorSandbox(ctx context.Context, job *ClaimedSession, workspace string) (*cursorSandbox, string) {
	name := ""
	switch runtime.GOOS {
	case "linux":
		name = "bwrap"
	case "darwin":
		name = "sandbox-exec"
	default:
		return nil, "Cursor sandbox is unsupported on " + runtime.GOOS
	}
	binary, err := exec.LookPath(name)
	if err != nil {
		return nil, "Cursor sandbox binary is unavailable: " + err.Error()
	}
	roots := []string{workspace, "/tmp", os.TempDir(), runnerCacheRoot()}
	if job != nil && job.WT != nil && job.WT.RepoDir != "" {
		roots = append(roots, filepath.Join(job.WT.RepoDir, ".git"))
	}
	sandbox := &cursorSandbox{binary: binary, platform: runtime.GOOS}
	seen := map[string]bool{}
	for _, root := range roots {
		if root == "" {
			return nil, "Cursor sandbox writable root is empty"
		}
		root, err = filepath.Abs(root)
		if err == nil {
			root, err = filepath.EvalSymlinks(root)
		}
		if err != nil {
			return nil, "Cursor sandbox writable root is unavailable: " + err.Error()
		}
		if root == string(filepath.Separator) {
			return nil, "Cursor sandbox cannot grant writes to the filesystem root"
		}
		if !seen[root] {
			sandbox.roots = append(sandbox.roots, root)
			seen[root] = true
		}
	}
	trialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	trial := exec.CommandContext(trialCtx, "/bin/sh", "-c", "exit 0")
	trial.Dir = workspace
	sandbox.wrap(trial)
	if output, err := trial.CombinedOutput(); err != nil {
		return nil, fmt.Sprintf("Cursor sandbox trial failed: %v: %s", err, strings.TrimSpace(string(output)))
	}
	return sandbox, ""
}

// wrap preserves the command's environment, working directory, streams, context,
// and ExtraFiles (Cursor's snapshot, status, and command plumbing). Never fall
// back to an unsandboxed command when the sandbox process fails.
func (s *cursorSandbox) wrap(cmd *exec.Cmd) {
	var args []string
	if s.platform == "linux" {
		// Like dshSandboxCacheRootPlugin, add writable binds beside the read-only root.
		// Keep the host network namespace: network access is an owner decision.
		args = []string{"--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"}
		for _, root := range s.roots {
			args = append(args, "--bind", root, root)
		}
		for _, path := range s.locked {
			args = append(args, "--ro-bind", path, path)
		}
		for _, path := range s.reopened {
			args = append(args, "--bind", path, path)
		}
		for _, path := range s.sealed {
			args = append(args, "--ro-bind", path, path)
		}
		for _, path := range s.hidden {
			args = append(args, "--tmpfs", path, "--remount-ro", path)
		}
		// bwrap inherits the descriptors supplied through cmd.ExtraFiles.
	} else {
		profile := "(version 1)\n(allow default)\n(deny file-write*)\n"
		for _, root := range s.roots {
			profile += "(allow file-write* (subpath " + strconv.Quote(root) + "))\n"
		}
		for _, path := range append(append([]string{}, s.sealed...), s.hidden...) {
			profile += "(deny file-write* (subpath " + strconv.Quote(path) + "))\n"
		}
		profile += "(allow file-write* (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/tty\"))\n"
		args = []string{"-p", profile}
	}
	args = append(args, "--", cmd.Path)
	args = append(args, cmd.Args[1:]...)
	cmd.Path = s.binary
	cmd.Args = append([]string{s.binary}, args...)
}
