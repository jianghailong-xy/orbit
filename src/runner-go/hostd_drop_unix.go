//go:build unix

package main

import (
	"os/exec"
	"syscall"
)

// hostdDropTo makes cmd run as uid/gid instead of as this process. It exists for exactly
// one command — the version probe of a freshly downloaded binary — and that is the whole
// point: hostd is root, the file came off the network, and the two must not meet. Groups
// are left empty (not NoSetGroups), so the probe also loses root's supplementary groups
// rather than keeping them under a borrowed uid.
func hostdDropTo(cmd *exec.Cmd, uid, gid uint32) error {
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uid, Gid: gid}}
	return nil
}
