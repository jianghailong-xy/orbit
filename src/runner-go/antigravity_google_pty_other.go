//go:build !linux && !darwin

package main

import (
	"errors"
	"io"
	"os/exec"
)

func startAntigravityGooglePTY(cmd *exec.Cmd, out io.Writer) (io.WriteCloser, <-chan struct{}, error) {
	return nil, nil, errors.New("Signing Antigravity in with Google works only on a Linux or macOS runner for now.")
}
