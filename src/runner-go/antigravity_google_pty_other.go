//go:build !linux

package main

import (
	"errors"
	"io"
	"os/exec"
)

func startAntigravityGooglePTY(cmd *exec.Cmd, out io.Writer) (io.WriteCloser, <-chan struct{}, error) {
	return nil, nil, errors.New("Signing Antigravity in with Google works only on a Linux runner for now.")
}
