//go:build !linux && !darwin

package main

import (
	"os/exec"
	"syscall"
)

func secretExecPrepare(*exec.Cmd) {}

func secretExecSignal(cmd *exec.Cmd, sig syscall.Signal) {
	if cmd.Process != nil {
		if sig == syscall.SIGKILL {
			_ = cmd.Process.Kill()
			return
		}
		_ = cmd.Process.Signal(sig)
	}
}
