//go:build linux

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"syscall"
	"unsafe"
)

// antigravityGooglePTYOutput is where the PTY's output is copied to. A variable only so a test can
// hold that copy back and have agy's exit seen before its last output, an order nothing else forces.
var antigravityGooglePTYOutput = func(out io.Writer) io.Writer { return out }

// agy itself owns the PTY session/process group, so cancellation can target precisely the PID
// this relay started. No script shell or detached wrapper can outlive it. The channel returned is
// closed once the copy to out stops: when the last process has closed the terminal and everything
// printed to it has been read, or when the master is closed.
func startAntigravityGooglePTY(cmd *exec.Cmd, out io.Writer) (io.WriteCloser, <-chan struct{}, error) {
	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return nil, nil, err
	}
	fail := func(err error) (io.WriteCloser, <-chan struct{}, error) { _ = master.Close(); return nil, nil, err }
	var unlock int32
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, master.Fd(), 0x40045431, uintptr(unsafe.Pointer(&unlock))); errno != 0 {
		return fail(errno)
	}
	var number uint32
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, master.Fd(), 0x80045430, uintptr(unsafe.Pointer(&number))); errno != 0 {
		return fail(errno)
	}
	slave, err := os.OpenFile(fmt.Sprintf("/dev/pts/%d", number), os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return fail(err)
	}
	defer slave.Close()
	size := [4]uint16{48, 4096, 0, 0}
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, slave.Fd(), syscall.TIOCSWINSZ, uintptr(unsafe.Pointer(&size))); errno != 0 {
		return fail(errno)
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return os.ErrProcessDone
		}
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	if err := cmd.Start(); err != nil {
		return fail(err)
	}
	copied := make(chan struct{})
	go func() {
		_, _ = io.Copy(antigravityGooglePTYOutput(out), master)
		close(copied)
	}()
	return master, copied, nil
}
