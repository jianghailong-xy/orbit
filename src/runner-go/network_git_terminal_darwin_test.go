//go:build darwin

package main

import (
	"bytes"
	"os"
	"syscall"
	"testing"
	"unsafe"
)

// openTestTerminal opens a pseudo-terminal: its non-blocking master end, which reads what was written to
// the terminal, and the terminal itself, to hand to a process as its controlling terminal. The ioctls are
// what grantpt, unlockpt and ptsname do on macOS.
func openTestTerminal(t *testing.T) (int, *os.File) {
	t.Helper()
	master, err := syscall.Open("/dev/ptmx", syscall.O_RDWR|syscall.O_NOCTTY|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		t.Fatalf("open a pseudo-terminal: %v", err)
	}
	t.Cleanup(func() { _ = syscall.Close(master) })
	for _, request := range []uintptr{syscall.TIOCPTYGRANT, syscall.TIOCPTYUNLK} {
		if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(master), request, 0); errno != 0 {
			t.Fatalf("set up the pseudo-terminal: %v", errno)
		}
	}
	var name [128]byte
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(master), syscall.TIOCPTYGNAME, uintptr(unsafe.Pointer(&name[0]))); errno != 0 {
		t.Fatalf("name the pseudo-terminal: %v", errno)
	}
	path := name[:]
	if end := bytes.IndexByte(path, 0); end >= 0 {
		path = path[:end]
	}
	terminal, err := os.OpenFile(string(path), os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		t.Fatalf("open the pseudo-terminal: %v", err)
	}
	t.Cleanup(func() { _ = terminal.Close() })
	return master, terminal
}
