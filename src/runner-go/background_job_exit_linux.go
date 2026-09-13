//go:build linux

package main

import (
	"syscall"
	"unsafe"
)

// awaitChildExit blocks until the child pid has exited, without reaping it. The exit status stays
// with the process until whoever hosts the job reaps it: this image, or — once the job has been
// handed on — the image a self-update re-executes into. A pid that is not this process's child
// returns at once.
func awaitChildExit(pid int) {
	const pPID = 1     // P_PID
	var info [128]byte // siginfo_t
	for {
		_, _, errno := syscall.Syscall6(syscall.SYS_WAITID, pPID, uintptr(pid),
			uintptr(unsafe.Pointer(&info[0])), syscall.WEXITED|syscall.WNOWAIT, 0, 0)
		if errno != syscall.EINTR {
			return
		}
	}
}
