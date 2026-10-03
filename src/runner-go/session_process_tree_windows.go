//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"time"
)

func configureSessionProcessTree(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	const createNewProcessGroup = 0x00000200
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNewProcessGroup}
	cmd.Cancel = func() error {
		return terminateSessionProcessTree(cmd)
	}
	cmd.WaitDelay = 5 * time.Second
}

func terminateSessionProcessTree(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return os.ErrProcessDone
	}
	if err := exec.Command("taskkill", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F").Run(); err == nil {
		return nil
	}
	err := cmd.Process.Kill()
	if errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	return err
}

// interruptSessionProcessGroup has no group signal to send on Windows, so it ends the tree: the
// engine's conversation is on disk, and the next turn resumes it.
func interruptSessionProcessGroup(cmd *exec.Cmd) error {
	return terminateSessionProcessTree(cmd)
}
