//go:build !linux

package main

import (
	"fmt"
	"os"
	"os/exec"
)

// Without a child subreaper there is no scope to give a session's process: it is started as every
// engine's is, the leader of its own process group, and terminateSessionProcessTree ends the group and
// the descendants it can still find by their parents. A command that left the group and lost its
// parent — what a Cursor CLI killed mid-turn leaves behind — is not among them
// (docs/cursor-runtime-contract.md §3.4).
type sessionScope struct{}

func startInSessionScope(cmd *exec.Cmd) (*sessionScope, error) {
	if err := startSessionProcess(cmd); err != nil {
		return nil, err
	}
	return &sessionScope{}, nil
}

func (s *sessionScope) close() {}

func runSessionScope([]string) int {
	fmt.Fprintln(os.Stderr, "orbit session-scope: Linux only")
	return 2
}
