package main

import (
	"errors"
	"fmt"
	"net"
	"syscall"
)

// hostdPeerCredential asks the kernel who is on the other end of a unix connection.
// SO_PEERCRED is filled in from the peer's real credentials at connect() time and the
// caller has no say in it, which is the whole of hostd's authorisation model: the
// answer here is the target, and the request body never gets a vote.
//
// golang.org/x/sys/unix.GetsockoptUcred is the usual spelling of this call, but the
// stdlib syscall package has the identical one on Linux and runner-go carries zero
// module dependencies on purpose (go.mod/go.sum are empty, and src/web/Dockerfile
// builds the binaries on that basis) — so this uses the stdlib.
func hostdPeerCredential(conn net.Conn) (hostdPeer, error) {
	uc, ok := conn.(*net.UnixConn)
	if !ok {
		return hostdPeer{}, errors.New("peer credentials are only available on a unix socket")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return hostdPeer{}, err
	}
	var (
		cred    *syscall.Ucred
		credErr error
	)
	if err := raw.Control(func(fd uintptr) {
		cred, credErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return hostdPeer{}, err
	}
	if credErr != nil {
		return hostdPeer{}, fmt.Errorf("SO_PEERCRED: %w", credErr)
	}
	return hostdPeer{UID: cred.Uid, PID: cred.Pid}, nil
}
