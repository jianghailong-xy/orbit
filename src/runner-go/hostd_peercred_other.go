//go:build !linux

package main

import (
	"errors"
	"net"
)

// hostd is a systemd facility, but the runner also builds for macOS, where there is no
// SO_PEERCRED and no unit to broker. Refusing here keeps the invariant intact on every
// platform: with no kernel-attested peer there is no identity hostd is willing to act
// on, so it acts on none.
func hostdPeerCredential(net.Conn) (hostdPeer, error) {
	return hostdPeer{}, errors.New("hostd peer credentials require Linux (SO_PEERCRED)")
}
