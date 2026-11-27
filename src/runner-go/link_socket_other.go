//go:build !linux && !darwin

package main

import "net"

// linkSocketQueue is nil where this binary cannot read a socket's send queue: writes go without waiting for room.
func linkSocketQueue(net.Conn) func() (queued, size int, ok bool) { return nil }
