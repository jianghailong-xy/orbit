//go:build unix

package main

import (
	"os/exec"
	"syscall"
)

// hostdDropTo makes cmd run as uid/gid instead of as this process. It exists for two
// commands, and that is the whole point: hostd is root, and neither is root's to run —
// the version probe of a freshly downloaded binary, which came off the network, and the
// check that an account can execute its own ~/.orbit/bin/orbit, which only that account
// may answer. groups are the supplementary groups to run with, and the probe passes none:
// Groups is then empty (not NoSetGroups), so it also loses root's supplementary groups
// rather than keeping them under a borrowed uid.
func hostdDropTo(cmd *exec.Cmd, uid, gid uint32, groups ...uint32) error {
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uid, Gid: gid, Groups: groups}}
	return nil
}
