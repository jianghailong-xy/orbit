//go:build linux

package main

import (
	"net"
	"syscall"

	"golang.org/x/sys/unix"
)

// linkSocketQueue is how many bytes c's send queue holds (sent and not acknowledged, or not sent yet: SIOCOUTQ) and the
// size of its send buffer (SO_SNDBUF), for a TCP connection; nil for anything else.
func linkSocketQueue(c net.Conn) func() (queued, size int, ok bool) {
	sc, isSyscall := c.(syscall.Conn)
	if !isSyscall {
		return nil
	}
	raw, err := sc.SyscallConn()
	if err != nil {
		return nil
	}
	return func() (queued, size int, ok bool) {
		var qerr, serr error
		if err := raw.Control(func(fd uintptr) {
			queued, qerr = unix.IoctlGetInt(int(fd), unix.SIOCOUTQ)
			size, serr = unix.GetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_SNDBUF)
		}); err != nil || qerr != nil || serr != nil {
			return 0, 0, false
		}
		return queued, size, true
	}
}
