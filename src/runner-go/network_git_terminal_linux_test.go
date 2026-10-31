//go:build linux

package main

import (
	"fmt"
	"os"
	"syscall"
	"testing"
	"unsafe"
)

// openTestTerminal opens a pseudo-terminal: its non-blocking master end, which reads what was written to
// the terminal, and the terminal itself, to hand to a process as its controlling terminal.
func openTestTerminal(t *testing.T) (int, *os.File) {
	t.Helper()
	master, err := syscall.Open("/dev/ptmx", syscall.O_RDWR|syscall.O_NOCTTY|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		t.Fatalf("open a pseudo-terminal: %v", err)
	}
	t.Cleanup(func() { _ = syscall.Close(master) })
	var unlock int32
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(master), syscall.TIOCSPTLCK, uintptr(unsafe.Pointer(&unlock))); errno != 0 {
		t.Fatalf("unlock the pseudo-terminal: %v", errno)
	}
	var number uint32
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(master), syscall.TIOCGPTN, uintptr(unsafe.Pointer(&number))); errno != 0 {
		t.Fatalf("name the pseudo-terminal: %v", errno)
	}
	terminal, err := os.OpenFile(fmt.Sprintf("/dev/pts/%d", number), os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		t.Fatalf("open the pseudo-terminal: %v", err)
	}
	t.Cleanup(func() { _ = terminal.Close() })
	return master, terminal
}
