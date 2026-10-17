//go:build !windows

package main

import "syscall"

// enginePathWriteError asks whether this runner may replace the file at path, returning nil when
// it may. See engineBinaryUpdatable for why this is access(2) and not a writable open: on macOS a
// write-open of a signed executable invalidates its code signature in the kernel.
func enginePathWriteError(path string) error {
	// W_OK. Not named in the syscall package on every platform this builds for, and it is one bit
	// of POSIX that has not moved in fifty years.
	const wOK = 2
	return syscall.Access(path, wOK)
}
