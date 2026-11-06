//go:build darwin

package main

import (
	"os"

	"golang.org/x/sys/unix"
)

// platformCloneFile is cloneFile on macOS: clonefile(2), which APFS answers and every other filesystem refuses with
// ENOTSUP (EXDEV across two). The clone takes src's mode, which is perm, less the setuid and setgid bits, and
// CLONE_NOOWNERCOPY makes it the runner's own even when the runner is root, as a file git writes would be.
// libSystem is reached through golang.org/x/sys/unix, as it has to be without cgo (docs/dependency-security.md).
func platformCloneFile(src, dst string, perm os.FileMode) error {
	return unix.Clonefile(src, dst, unix.CLONE_NOFOLLOW|unix.CLONE_NOOWNERCOPY)
}
