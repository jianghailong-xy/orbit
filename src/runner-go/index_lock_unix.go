//go:build linux || darwin

package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

// interruptGit stops a git the way git can clean up after: on SIGTERM it removes the lock files it
// holds, then exits.
func interruptGit(p *os.Process) error {
	return p.Signal(syscall.SIGTERM)
}

// indexLockHolder names a process that has lock open, or returns nil when none does.
func indexLockHolder(lock string) (*lockHolder, error) {
	if runtime.GOOS == "darwin" {
		return lsofHolder(lock)
	}
	return procHolder(lock)
}

// procHolder reads /proc/<pid>/fd for every process this runner may look into — all of them, for
// the root runner. The rest belong to other users, who have no business holding the index lock of
// a checkout this runner owns. The walk is in-process readlinks: about a quarter of a second for
// the whole machine at a load of 16 (2026-09-26), paid only for a lock that outlasted a commit's
// wait.
func procHolder(lock string) (*lockHolder, error) {
	want := lock
	if real, err := filepath.EvalSymlinks(lock); err == nil {
		want = real
	}
	procs, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	for _, p := range procs {
		pid := p.Name()
		if pid[0] < '0' || pid[0] > '9' {
			continue
		}
		fds, err := os.ReadDir(filepath.Join("/proc", pid, "fd"))
		if err != nil {
			continue // exited since the listing, or another user's
		}
		for _, fd := range fds {
			if target, err := os.Readlink(filepath.Join("/proc", pid, "fd", fd.Name())); err == nil && target == want {
				comm, _ := os.ReadFile(filepath.Join("/proc", pid, "comm"))
				return &lockHolder{name: strings.TrimSpace(string(comm)), pid: pid}, nil
			}
		}
	}
	return nil, nil
}

// lsofHolder asks lsof, which macOS always has: `-t` prints only the pids that have the file open,
// and lsof exits 1 with nothing printed when none does.
func lsofHolder(lock string) (*lockHolder, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "lsof", "-t", "--", lock).Output()
	if pids := strings.Fields(string(out)); len(pids) > 0 {
		return &lockHolder{pid: pids[0]}, nil
	}
	var exit *exec.ExitError
	if err == nil || (errors.As(err, &exit) && exit.ExitCode() == 1) {
		return nil, nil
	}
	return nil, err
}
