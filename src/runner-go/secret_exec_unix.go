//go:build linux || darwin

package main

import (
	"os/exec"
	"syscall"
)

// secretExecPrepare puts the command in a process group of its own, so a revocation reaches everything it started.
func secretExecPrepare(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }

// secretExecSignal signals the command's whole process group.
func secretExecSignal(cmd *exec.Cmd, sig syscall.Signal) {
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, sig)
	}
}
