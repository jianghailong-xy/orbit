//go:build linux

package main

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// worktreeTeardownGrace is how long a process group still living in a worktree gets to exit on
// SIGTERM before it is SIGKILLed. Short: the directory is already being torn down, so nothing
// left in it has any work worth finishing.
var worktreeTeardownGrace = 2 * time.Second

// teardownWorktreeProcesses terminates whatever still has its working directory inside a
// worktree that is about to be deleted. Both removal paths call it first, because both then run
// `git worktree remove --force`, and --force is precisely git's instruction to ignore the
// occupancy it would otherwise refuse on: the directory goes and any process sitting in it stays,
// now with a "(deleted)" cwd and nothing that will ever clean it up.
//
// The ONLY thing that makes a process a target is its cwd being the worktree or something under
// it. Matching on the command line instead would be unsafe here: this host runs sessions for
// unrelated owners side by side and their engines are near-identical strings, so a pattern broad
// enough to catch this session's leftovers would also kill somebody else's running turn.
//
// Failures never block the removal that follows — a process we could not signal is logged and
// left behind rather than allowed to strand the checkout on disk.
func teardownWorktreeProcesses(path string) {
	roots := worktreeCwdRoots(path)
	if len(roots) == 0 {
		return
	}
	selfPID := os.Getpid()
	selfPGID, err := syscall.Getpgid(selfPID)
	if err != nil {
		// Without our own group id there is no way to promise the runner is not a target.
		logln("worktree teardown: own process group unknown, leaving", path, "processes alone:", err)
		return
	}

	groups := worktreeProcessGroups(roots, selfPID, selfPGID)
	if len(groups) == 0 {
		return
	}
	logln("worktree teardown: terminating", len(groups), "leftover process group(s) rooted in", path)
	signalWorktreeGroups(groups, syscall.SIGTERM, path)

	// Rescanning rather than polling the original pids is what keeps escalation honest: a pid that
	// exited and was reused belongs to somebody else now, and only a process that STILL matches a
	// root gets the second signal.
	deadline := time.Now().Add(worktreeTeardownGrace)
	for len(groups) > 0 && time.Now().Before(deadline) {
		time.Sleep(25 * time.Millisecond)
		groups = worktreeProcessGroups(roots, selfPID, selfPGID)
	}
	if len(groups) > 0 {
		signalWorktreeGroups(groups, syscall.SIGKILL, path)
	}
}

// worktreeCwdRoots is the set of absolute directories a cwd is matched against. /proc reports
// fully resolved paths, so a worktrees root reached through a symlink needs its resolved spelling
// too or none of its own processes would ever match. "/" is refused outright.
func worktreeCwdRoots(path string) []string {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil
	}
	var roots []string
	add := func(p string) {
		p = filepath.Clean(p)
		if p == "/" || p == "." {
			return
		}
		for _, have := range roots {
			if have == p {
				return
			}
		}
		roots = append(roots, p)
	}
	add(abs)
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		add(resolved)
	}
	return roots
}

// worktreeProcessGroups returns the process groups worth signalling, deduplicated and ordered so
// the log and the kills are stable.
func worktreeProcessGroups(roots []string, selfPID, selfPGID int) []int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		logln("worktree teardown: cannot read /proc:", err)
		return nil
	}
	seen := map[int]bool{}
	var groups []int
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 1 || pid == selfPID {
			continue
		}
		cwd, ok := procCwd(pid)
		if !ok || !cwdIsUnder(cwd, roots) {
			continue
		}
		pgid, err := syscall.Getpgid(pid)
		if err != nil {
			continue // exited between the scan and the lookup
		}
		// kill(-0) signals our OWN group and kill(-1) signals everything this uid may touch, so
		// neither is ever a target; and the runner's group must survive reclaiming a worktree it
		// happens to be standing in.
		if pgid <= 1 || pgid == selfPGID || seen[pgid] {
			continue
		}
		seen[pgid] = true
		groups = append(groups, pgid)
	}
	sort.Ints(groups)
	return groups
}

// procDeletedSuffix is what Linux appends to /proc/<pid>/cwd once the directory is gone — the
// exact state a half-finished removal leaves for the next sweep to find, so it is stripped rather
// than left to break the comparison.
const procDeletedSuffix = " (deleted)"

// procCwd reads a pid's working directory. A dead-but-unreaped process has no cwd link left,
// which is how corpses drop out of the rescan instead of holding up the grace period.
func procCwd(pid int) (string, bool) {
	cwd, err := os.Readlink(filepath.Join("/proc", strconv.Itoa(pid), "cwd"))
	if err != nil {
		return "", false
	}
	return strings.TrimSuffix(cwd, procDeletedSuffix), true
}

// cwdIsUnder compares whole path components: "<root>-2" is a different directory from "<root>",
// and a session parked in it is a bystander.
func cwdIsUnder(cwd string, roots []string) bool {
	if cwd == "" {
		return false
	}
	for _, root := range roots {
		if cwd == root || strings.HasPrefix(cwd, root+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func signalWorktreeGroups(groups []int, sig syscall.Signal, path string) {
	for _, pgid := range groups {
		if err := syscall.Kill(-pgid, sig); err != nil && !errors.Is(err, syscall.ESRCH) {
			logln("worktree teardown:", sig, "of process group", pgid, "rooted in", path, "failed:", err)
		}
	}
}
