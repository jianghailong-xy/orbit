//go:build linux

package main

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

// antigravityPTYSlaveName unlocks a Linux PTY master and names its terminal (TIOCSPTLCK, TIOCGPTN).
func antigravityPTYSlaveName(master *os.File) (string, error) {
	var unlock int32
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, master.Fd(), 0x40045431, uintptr(unsafe.Pointer(&unlock))); errno != 0 {
		return "", errno
	}
	var number uint32
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, master.Fd(), 0x80045430, uintptr(unsafe.Pointer(&number))); errno != 0 {
		return "", errno
	}
	return fmt.Sprintf("/dev/pts/%d", number), nil
}
