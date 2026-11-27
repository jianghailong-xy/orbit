//go:build darwin

package main

import (
	"bytes"
	"os"
	"syscall"
	"unsafe"
)

// antigravityPTYSlaveName grants and unlocks a macOS PTY master and names its terminal, as
// posix_openpt's grantpt/unlockpt/ptsname do (TIOCPTYGRANT, TIOCPTYUNLK, TIOCPTYGNAME).
func antigravityPTYSlaveName(master *os.File) (string, error) {
	for _, req := range []uintptr{syscall.TIOCPTYGRANT, syscall.TIOCPTYUNLK} {
		if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, master.Fd(), req, 0); errno != 0 {
			return "", errno
		}
	}
	var name [128]byte
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, master.Fd(), syscall.TIOCPTYGNAME, uintptr(unsafe.Pointer(&name[0]))); errno != 0 {
		return "", errno
	}
	if i := bytes.IndexByte(name[:], 0); i >= 0 {
		return string(name[:i]), nil
	}
	return "", syscall.ENAMETOOLONG
}
