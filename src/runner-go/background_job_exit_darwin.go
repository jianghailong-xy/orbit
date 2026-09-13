//go:build darwin

package main

import "syscall"

// awaitChildExit blocks until the child pid has exited, without reaping it (see the Linux twin).
// macOS has no waitid(WNOWAIT) this code can reach, so the exit is observed through kqueue, which
// never reaps.
func awaitChildExit(pid int) {
	kq, err := syscall.Kqueue()
	if err != nil {
		return
	}
	defer syscall.Close(kq)
	var change syscall.Kevent_t
	syscall.SetKevent(&change, pid, syscall.EVFILT_PROC, syscall.EV_ADD|syscall.EV_ONESHOT)
	change.Fflags = syscall.NOTE_EXIT
	events := make([]syscall.Kevent_t, 1)
	for {
		n, err := syscall.Kevent(kq, []syscall.Kevent_t{change}, events, nil)
		if err == syscall.EINTR {
			continue
		}
		// A child that has already exited cannot be registered (ESRCH): it is waiting to be reaped.
		if err != nil || n > 0 {
			return
		}
	}
}
