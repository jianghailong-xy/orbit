//go:build linux || darwin

package main

import (
	"bufio"
	"errors"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// configureSessionProcessTree makes one interactive runtime/shell the leader of
// its own process group. Context cancellation then kills the whole group, not
// just the direct CLI process, so MCP servers and background shell descendants
// cannot outlive the supervisor handoff and keep touching its worktree.
func configureSessionProcessTree(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		return terminateSessionProcessTree(cmd)
	}
	cmd.WaitDelay = 5 * time.Second
}

// terminateSessionProcessTree also handles children that create a new process
// group/session of their own (OpenCode deliberately starts its shell tool with
// detached:true), which a plain group kill would miss. Freeze the runtime's own
// group first, discover and freeze escaped descendants before their parent dies,
// then kill the frozen children followed by the group. Re-scanning closes the
// spawn race between the first snapshot and SIGSTOP.
func terminateSessionProcessTree(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return os.ErrProcessDone
	}
	rootPID := cmd.Process.Pid
	// Fast path for the overwhelmingly common case — a runtime that already exited
	// cleanly. Only a group that is still alive is worth a descendant scan.
	if err := syscall.Kill(-rootPID, 0); errors.Is(err, syscall.ESRCH) {
		return nil
	}
	_ = syscall.Kill(-rootPID, syscall.SIGSTOP)
	known := map[int]bool{}
	for attempt := 0; attempt < 4; attempt++ {
		descendants, err := sessionDescendantPIDs(rootPID)
		if err != nil {
			break
		}
		added := false
		for _, pid := range descendants {
			if known[pid] {
				continue
			}
			known[pid] = true
			added = true
			_ = syscall.Kill(pid, syscall.SIGSTOP)
		}
		if !added {
			break
		}
	}

	descendants := make([]int, 0, len(known))
	for pid := range known {
		descendants = append(descendants, pid)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(descendants)))
	for _, pid := range descendants {
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
	groupKillErr := syscall.Kill(-rootPID, syscall.SIGKILL)
	if groupKillErr == nil || errors.Is(groupKillErr, syscall.ESRCH) {
		return nil
	}
	return groupKillErr
}

// sessionDescendantPIDs walks the ppid table so descendants that reparented into
// their own group are still discoverable while their ancestor chain is alive.
func sessionDescendantPIDs(rootPID int) ([]int, error) {
	out, err := exec.Command("ps", "-A", "-o", "pid=,ppid=").Output()
	if err != nil {
		return nil, err
	}
	children := map[int][]int{}
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) != 2 {
			continue
		}
		pid, pidErr := strconv.Atoi(fields[0])
		ppid, ppidErr := strconv.Atoi(fields[1])
		if pidErr == nil && ppidErr == nil && pid > 0 {
			children[ppid] = append(children[ppid], pid)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	result := []int{}
	queue := append([]int(nil), children[rootPID]...)
	seen := map[int]bool{rootPID: true}
	for len(queue) > 0 {
		pid := queue[0]
		queue = queue[1:]
		if seen[pid] {
			continue
		}
		seen[pid] = true
		result = append(result, pid)
		queue = append(queue, children[pid]...)
	}
	return result, nil
}
