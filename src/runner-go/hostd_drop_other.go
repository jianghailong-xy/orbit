//go:build !unix

package main

import (
	"errors"
	"os/exec"
)

// Dropping to another account before an exec is a POSIX notion, and hostd is a systemd
// facility in the first place. On a platform with neither, the answer is to not run the
// download at all: refusing an update is recoverable, running an unverified binary with
// this process's privileges is not.
func hostdDropTo(*exec.Cmd, uint32, uint32) error {
	return errors.New("this platform cannot drop privileges before running a downloaded binary")
}
