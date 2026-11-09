//go:build !linux

package main

import (
	"net"
	"os"
	"path/filepath"
	"runtime"
)

// Until a platform's process identity has been verified, every command remains
// sandboxed. UID-only authentication must never authorize an escape.
func cursorShellPeer(net.Conn, int, string, string, string, string) (string, string, bool) {
	return "", "", false
}

func cursorShellStartIdentity(int) string { return "" }

func cursorShellSocketPath(path string) (string, func(), error) {
	if runtime.GOOS != "darwin" || len(path) < 104 {
		return path, func() {}, nil
	}
	// Darwin has no /proc/self/fd directory alias. A private, short symlink
	// resolves to the same socket; each bind/dial removes its alias immediately.
	dir, err := os.MkdirTemp("/private/tmp", "orbit-cursor-sock-")
	if err != nil {
		return "", func() {}, err
	}
	link := filepath.Join(dir, "d")
	release := func() {
		_ = os.Remove(link)
		_ = os.Remove(dir)
	}
	if err := os.Symlink(filepath.Dir(path), link); err != nil {
		release()
		return "", func() {}, err
	}
	return filepath.Join(link, filepath.Base(path)), release, nil
}
