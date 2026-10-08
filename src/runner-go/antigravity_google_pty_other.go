//go:build !linux

package main

import (
	"errors"
	"io"
	"os/exec"
)

func startAntigravityGooglePTY(cmd *exec.Cmd, out io.Writer) (io.WriteCloser, <-chan struct{}, error) {
	return nil, nil, errors.New("Antigravity 的 Google 登录暂时只支持 Linux runner")
}
