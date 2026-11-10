//go:build !linux && !darwin

package main

import "net"

// Until a platform's process identity has been verified, every command remains
// sandboxed. UID-only authentication must never authorize an escape.
func cursorShellPeer(net.Conn, int, string, string, string, string) (string, string, bool) {
	return "", "", false
}

func cursorShellStartIdentity(int) string { return "" }

func cursorShellSocketPath(path string) (string, func(), error) {
	return path, func() {}, nil
}
