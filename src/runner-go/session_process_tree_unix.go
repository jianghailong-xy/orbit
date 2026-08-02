//go:build linux || darwin

package main

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// configureSessionProcessTree makes one interactive runtime/shell the leader of
// its own process group. Context cancellation then kills the whole group, not
// just the direct CLI process, so MCP servers and background shell descendants
// cannot outlive the supervisor handoff and keep touching its worktree.
func configureSessionProcessTree(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		return terminateSessionProcessTree(cmd)
	}
	cmd.WaitDelay = 5 * time.Second
}

func terminateSessionProcessTree(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return os.ErrProcessDone
	}
	err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}
