//go:build linux

package main

import (
	"bufio"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

// Background job cgroups (bg_limits.go). systemd hands the runner its unit's cgroup when the unit says
// Delegate=yes, and marks it so (the user.delegate xattr). cgroup v2 lets a cgroup that has processes of
// its own hand no controller to its children, so the runner first moves itself — and anything already
// beside it — into a leaf, bgCgroupRunnerLeaf, where its sessions start too; each limited job then gets a
// cgroup of its own beside that leaf, which the process is started straight into (CLONE_INTO_CGROUP), so
// nothing it forks escapes the limit. A stop of the unit still ends everything in it, jobs included.

const (
	bgCgroupRunnerLeaf = "orbit-runner"
	bgCgroupJobPrefix  = "orbit-bg-"
	// bgCPUPeriodUs is cpu.max's period: the quota is CPUs times this.
	bgCPUPeriodUs = 100000
	// bgCgroupRunnerCPUWeight is the runner leaf's cpu.weight, ten times a job cgroup's default 100.
	bgCgroupRunnerCPUWeight = 1000
)

// bgCgroups is where job cgroups go, or why there is nowhere, once setupBgCgroups has run.
// live holds the jobs whose cgroups exist on purpose, from before their mkdir until remove: an empty one
// may be a job about to start in it, which the sweep must leave.
var bgCgroups struct {
	sync.Mutex
	base        string
	unavailable string
	live        map[string]bool
}

// setupBgCgroups prepares the runner's delegated cgroup for job cgroups. Only `orbit run` calls it: it
// moves the calling process.
func setupBgCgroups() {
	base, err := prepareBgCgroupBase(cgroupRoot, "/proc/self/cgroup")
	bgCgroups.Lock()
	defer bgCgroups.Unlock()
	bgCgroups.base, bgCgroups.unavailable = base, ""
	if err != nil {
		bgCgroups.unavailable = err.Error()
		fmt.Fprintln(os.Stderr, "background job CPU/memory limits are unavailable:", err)
	}
}

// prepareBgCgroupBase finds the runner's delegated cgroup, moves what runs in it into the runner's leaf,
// hands cpu and memory to its children, and removes the empty job cgroups an earlier runner left.
func prepareBgCgroupBase(root, selfCgroupFile string) (string, error) {
	own, err := ownCgroupPath(selfCgroupFile)
	if err != nil {
		return "", err
	}
	if own == "/" {
		return "", errors.New("the runner has no cgroup of its own (it runs in a container, or outside a systemd service)")
	}
	dir := filepath.Join(root, own)
	if filepath.Base(dir) == bgCgroupRunnerLeaf {
		// Set up already, by this process before it re-executed into a new image.
		dir = filepath.Dir(dir)
	}
	if _, err := os.Stat(dir); err != nil {
		return "", fmt.Errorf("the runner's cgroup %s is not under %s (is this a cgroup v1 or hybrid machine?)", own, root)
	}
	if !strings.HasSuffix(dir, ".service") {
		return "", errors.New("the runner is not running as a systemd service ('orbit register' installs one)")
	}
	if !cgroupDelegated(dir) {
		return "", errors.New("the runner's systemd unit does not delegate its cgroup: it needs Delegate=yes " +
			"(reinstall the service with 'orbit register' or 'orbit host setup', then restart it)")
	}
	controllers, err := os.ReadFile(filepath.Join(dir, "cgroup.controllers"))
	if err != nil {
		return "", err
	}
	for _, c := range []string{"cpu", "memory"} {
		if !containsField(string(controllers), c) {
			return "", fmt.Errorf("the %s controller is not available in the runner's cgroup", c)
		}
	}
	leaf := filepath.Join(dir, bgCgroupRunnerLeaf)
	if err := os.Mkdir(leaf, 0o755); err != nil && !os.IsExist(err) {
		if os.IsPermission(err) {
			return "", errors.New("the runner may not write its cgroup yet: restart its service so Delegate=yes takes effect")
		}
		return "", err
	}
	if err := moveCgroupProcs(dir, leaf); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, "cgroup.subtree_control"), []byte("+cpu +memory"), 0); err != nil {
		return "", fmt.Errorf("enable cpu and memory for job cgroups: %w", err)
	}
	// Each job cgroup is a sibling of the runner's leaf, which holds every session; at equal weight a few
	// busy jobs would take most of the machine from all of them. Sessions come first.
	if err := os.WriteFile(filepath.Join(leaf, "cpu.weight"), []byte(strconv.Itoa(bgCgroupRunnerCPUWeight)), 0); err != nil {
		return "", fmt.Errorf("set the runner's cpu.weight: %w", err)
	}
	if err := probeCloneIntoCgroup(leaf); err != nil {
		return "", fmt.Errorf("this kernel cannot start a process inside a cgroup (CLONE_INTO_CGROUP, Linux 5.7+): %w", err)
	}
	sweepBgJobCgroups(dir, nil)
	return dir, nil
}

// probeCloneIntoCgroup starts one process the way a limited job starts, so that a kernel or seccomp profile
// without clone3 makes limits unavailable rather than failing every limited job.
func probeCloneIntoCgroup(dir string) error {
	fd, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer fd.Close()
	cmd := exec.Command("/bin/true")
	cmd.SysProcAttr = &syscall.SysProcAttr{UseCgroupFD: true, CgroupFD: int(fd.Fd())}
	return cmd.Run()
}

// ownCgroupPath reads this process's cgroup v2 path.
func ownCgroupPath(file string) (string, error) {
	b, err := os.ReadFile(file)
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(b), "\n") {
		if path, ok := strings.CutPrefix(line, "0::"); ok {
			return path, nil
		}
	}
	return "", errors.New("this machine does not use cgroup v2")
}

// cgroupDelegated reports whether systemd delegated dir to the unit's processes. systemd 251 and later mark
// it with an xattr; an older one only hands it to the unit's User=, so a runner that is not root and owns
// its cgroup has been delegated it too. Root owns every cgroup, so for root only the mark counts.
func cgroupDelegated(dir string) bool {
	buf := make([]byte, 8)
	for _, name := range []string{"user.delegate", "trusted.delegate"} {
		if n, err := syscall.Getxattr(dir, name, buf); err == nil && string(buf[:n]) == "1" {
			return true
		}
	}
	uid := os.Geteuid()
	if uid == 0 {
		return false
	}
	for _, f := range []string{dir, filepath.Join(dir, "cgroup.procs"), filepath.Join(dir, "cgroup.subtree_control")} {
		info, err := os.Stat(f)
		if err != nil {
			return false
		}
		if st, ok := info.Sys().(*syscall.Stat_t); !ok || int(st.Uid) != uid {
			return false
		}
	}
	return true
}

// moveCgroupProcs moves every process in from to into, until none is left: one may fork while the list
// is being read.
func moveCgroupProcs(from, into string) error {
	for range 100 {
		b, err := os.ReadFile(filepath.Join(from, "cgroup.procs"))
		if err != nil {
			return err
		}
		pids := strings.Fields(string(b))
		if len(pids) == 0 {
			return nil
		}
		for _, pid := range pids {
			err := os.WriteFile(filepath.Join(into, "cgroup.procs"), []byte(pid), 0)
			if err != nil && !errors.Is(err, syscall.ESRCH) {
				return fmt.Errorf("move process %s into the runner's cgroup: %w", pid, err)
			}
		}
	}
	return errors.New("processes kept appearing in the runner's cgroup")
}

// sweepBgJobCgroups removes job cgroups whose jobs have all ended — a job handed on to this image across a
// self-update leaves its own behind. One still holding a process is busy, and stays; one in live is a job
// of this image's, and is its to remove.
func sweepBgJobCgroups(base string, live map[string]bool) {
	entries, _ := os.ReadDir(base)
	for _, e := range entries {
		id, ok := strings.CutPrefix(e.Name(), bgCgroupJobPrefix)
		if e.IsDir() && ok && !live[id] {
			_ = os.Remove(filepath.Join(base, e.Name()))
		}
	}
}

func containsField(s, field string) bool {
	for _, f := range strings.Fields(s) {
		if f == field {
			return true
		}
	}
	return false
}

// bgJobCgroup is one job's cgroup.
type bgJobCgroup struct {
	jobID string
	dir   string
	fd    *os.File
}

// newBgJobCgroup makes a cgroup for one job, with its limits written.
func newBgJobCgroup(jobID string, limits bgJobLimits) (*bgJobCgroup, error) {
	bgCgroups.Lock()
	base, unavailable := bgCgroups.base, bgCgroups.unavailable
	if base != "" {
		if bgCgroups.live == nil {
			bgCgroups.live = map[string]bool{}
		}
		bgCgroups.live[jobID] = true
	}
	bgCgroups.Unlock()
	if base == "" {
		if unavailable == "" {
			unavailable = "the runner did not set up job cgroups"
		}
		return nil, errors.New(unavailable)
	}
	dir := filepath.Join(base, bgCgroupJobPrefix+jobID)
	cg := &bgJobCgroup{jobID: jobID, dir: dir}
	if err := os.Mkdir(dir, 0o755); err != nil {
		cg.remove()
		return nil, err
	}
	if err := cg.write(limits); err != nil {
		cg.remove()
		return nil, err
	}
	fd, err := os.Open(dir)
	if err != nil {
		cg.remove()
		return nil, err
	}
	cg.fd = fd
	return cg, nil
}

func (cg *bgJobCgroup) write(limits bgJobLimits) error {
	set := func(file, value string) error {
		if err := os.WriteFile(filepath.Join(cg.dir, file), []byte(value), 0); err != nil {
			return fmt.Errorf("set %s: %w", file, err)
		}
		return nil
	}
	if limits.CPUs > 0 {
		quota := int64(math.Max(1000, math.Round(limits.CPUs*bgCPUPeriodUs)))
		if err := set("cpu.max", fmt.Sprintf("%d %d", quota, bgCPUPeriodUs)); err != nil {
			return err
		}
	}
	if limits.MemoryMB > 0 {
		if err := set("memory.max", strconv.FormatInt(limits.MemoryMB<<20, 10)); err != nil {
			return err
		}
		// Past its memory the job ends, all of it, rather than swapping the machine to a crawl or
		// losing one process the rest then waits on forever.
		if err := set("memory.oom.group", "1"); err != nil {
			return err
		}
		if _, err := os.Stat(filepath.Join(cg.dir, "memory.swap.max")); err == nil {
			if err := set("memory.swap.max", "0"); err != nil {
				return err
			}
		}
	}
	return nil
}

// attach makes cmd start inside the cgroup.
func (cg *bgJobCgroup) attach(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.UseCgroupFD = true
	cmd.SysProcAttr.CgroupFD = int(cg.fd.Fd())
}

// started lets go of what starting the process needed.
func (cg *bgJobCgroup) started() { _ = cg.fd.Close() }

// oomKilled reports whether the kernel killed anything in the cgroup for its memory limit.
func (cg *bgJobCgroup) oomKilled() bool {
	f, err := os.Open(filepath.Join(cg.dir, "memory.events"))
	if err != nil {
		return false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if v, ok := strings.CutPrefix(sc.Text(), "oom_kill "); ok {
			n, _ := strconv.Atoi(v)
			return n > 0
		}
	}
	return false
}

// adoptBgJobCgroup is the cgroup of a job this image adopted from the one before it, nil when it has none
// any more or this image has no job cgroups.
func adoptBgJobCgroup(jobID string) *bgJobCgroup {
	bgCgroups.Lock()
	defer bgCgroups.Unlock()
	if bgCgroups.base == "" {
		return nil
	}
	dir := filepath.Join(bgCgroups.base, bgCgroupJobPrefix+jobID)
	if _, err := os.Stat(dir); err != nil {
		return nil
	}
	if bgCgroups.live == nil {
		bgCgroups.live = map[string]bool{}
	}
	bgCgroups.live[jobID] = true
	return &bgJobCgroup{jobID: jobID, dir: dir}
}

// killAll kills every process left in the cgroup (cgroup.kill, Linux 5.14+). A nil cgroup has none.
func (cg *bgJobCgroup) killAll() {
	if cg == nil {
		return
	}
	_ = os.WriteFile(filepath.Join(cg.dir, "cgroup.kill"), []byte("1"), 0)
}

// remove deletes the cgroup once it is empty; one that still holds a process is left for the next sweep.
func (cg *bgJobCgroup) remove() {
	if cg.fd != nil {
		_ = cg.fd.Close()
	}
	_ = os.Remove(cg.dir)
	bgCgroups.Lock()
	defer bgCgroups.Unlock()
	delete(bgCgroups.live, cg.jobID)
	if bgCgroups.base != "" {
		sweepBgJobCgroups(bgCgroups.base, bgCgroups.live)
	}
}
