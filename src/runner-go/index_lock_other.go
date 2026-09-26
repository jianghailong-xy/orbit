//go:build !linux && !darwin

package main

import (
	"fmt"
	"os"
	"runtime"
)

// interruptGit has no signal here that git would clean up after, so the git is killed as before.
func interruptGit(p *os.Process) error {
	return p.Kill()
}

// indexLockHolder cannot list another process's open files on this platform, so a live commit
// never removes an index lock here.
func indexLockHolder(string) (string, error) {
	return "", fmt.Errorf("listing open files is not supported on %s", runtime.GOOS)
}
