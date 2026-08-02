//go:build !linux && !darwin && !windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"time"
)

// Unsupported runner platforms retain Go's direct-process cancellation.
func configureSessionProcessTree(cmd *exec.Cmd) {
	if cmd != nil {
		cmd.WaitDelay = 5 * time.Second
	}
}

func terminateSessionProcessTree(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return os.ErrProcessDone
	}
	err := cmd.Process.Kill()
	if errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	return err
}
