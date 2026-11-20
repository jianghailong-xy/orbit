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
// beside it — into a leaf, bgCgroupRunnerLeaf, where its sessions start too. Every limited job then gets a
// cgroup of its own inside one parent beside that leaf, bgCgroupJobsParent, and is started straight into it
// (CLONE_INTO_CGROUP), so nothing it forks escapes its limit. The parent bounds what the limited jobs take
// together: a tenth of the CPU weight the sessions have, and half of the machine's memory. That bound is
// what lets a limited job take no session slot (bgJob.boundedLocked). A stop of the unit still ends
// everything in it, jobs included.

const (
	bgCgroupRunnerLeaf = "orbit-runner"
	bgCgroupJobsParent = "orbit-bg"
	bgCgroupJobPrefix  = "orbit-bg-"
	// bgCPUPeriodUs is cpu.max's period: the quota is CPUs times this.
	bgCPUPeriodUs = 100000
	// The CPU weights of the runner's leaf, which holds every session, and of the jobs' parent: under
	// contention the sessions come first, ten to one, however many jobs there are.
	bgCgroupRunnerCPUWeight = 1000
	bgCgroupJobsCPUWeight   = 100
	// bgCgroupJobsMemoryShare is the share of the machine's memory the limited jobs may hold together.
	bgCgroupJobsMemoryShare = 0.5
)

// bgCgroupUnavailable is why this runner cannot limit jobs, with the reason code its capability names
// (bgJobLimitsCapability). A permanent one — nothing this process does will change it — is kept; any
// other is tried again on the next limited job.
type bgCgroupUnavailable struct {
	code      string
	permanent bool
	err       error
}

func (u *bgCgroupUnavailable) Error() string { return u.err.Error() }

func permanentlyUnavailable(code string, err error) *bgCgroupUnavailable {
	return &bgCgroupUnavailable{code: code, permanent: true, err: err}
}

// bgCgroups is where job cgroups go — the jobs' parent — once set up, or why there is nowhere for good.
// live holds the jobs whose cgroups exist on purpose, from before their mkdir until remove: an empty one
// may be a job about to start in it, which the sweep must leave.
var bgCgroups struct {
	sync.Mutex
	jobs        string
	unavailable *bgCgroupUnavailable
	live        map[string]bool
}

// setupBgCgroups prepares the runner's delegated cgroup for job cgroups: on the first limited job, so that a
// runner whose owner never turned limits on leaves its cgroup, and every CPU weight in it, as systemd made
// them. It moves the calling process, which is the runner. It returns where job cgroups go, or why not.
func setupBgCgroups() (string, error) {
	bgCgroups.Lock()
	defer bgCgroups.Unlock()
	if bgCgroups.jobs != "" {
		return bgCgroups.jobs, nil
	}
	if u := bgCgroups.unavailable; u != nil && u.permanent {
		return "", u
	}
	jobs, err := prepareBgCgroups(cgroupRoot, "/proc/self/cgroup")
	if err != nil {
		var u *bgCgroupUnavailable
		if !errors.As(err, &u) {
			u = &bgCgroupUnavailable{code: "unknown", err: err}
		}
		bgCgroups.unavailable = u
		fmt.Fprintln(os.Stderr, "background job CPU/memory limits are unavailable:", err)
		return "", u
	}
	bgCgroups.jobs, bgCgroups.unavailable = jobs, nil
	return jobs, nil
}

// checkBgCgroupBase finds the runner's delegated cgroup without changing anything, or says why it has none.
// Every answer but a found one is permanent for this process.
func checkBgCgroupBase(root, selfCgroupFile string) (string, *bgCgroupUnavailable) {
	own, err := ownCgroupPath(selfCgroupFile)
	if err != nil {
		return "", permanentlyUnavailable("cgroup", err)
	}
	if own == "/" {
		return "", permanentlyUnavailable("cgroup", errors.New("the runner has no cgroup of its own (it runs in a container, or outside a systemd service)"))
	}
	dir := filepath.Join(root, own)
	if filepath.Base(dir) == bgCgroupRunnerLeaf {
		// Set up already, by this process before it re-executed into a new image.
		dir = filepath.Dir(dir)
	}
	if _, err := os.Stat(dir); err != nil {
		return "", permanentlyUnavailable("cgroup", fmt.Errorf("the runner's cgroup %s is not under %s (is this a cgroup v1 or hybrid machine?)", own, root))
	}
	if !strings.HasSuffix(dir, ".service") {
		return "", permanentlyUnavailable("cgroup", errors.New("the runner is not running as a systemd service ('orbit register' installs one)"))
	}
	if !cgroupDelegated(dir) || syscall.Access(dir, 2 /* W_OK */) != nil {
		return "", permanentlyUnavailable("delegate", errors.New("the runner's systemd unit does not delegate its cgroup: it needs Delegate=yes "+
			"(reinstall the service with 'orbit register' or 'orbit host setup', then restart it)"))
	}
	controllers, err := os.ReadFile(filepath.Join(dir, "cgroup.controllers"))
	if err != nil {
		return "", permanentlyUnavailable("controllers", err)
	}
	for _, c := range []string{"cpu", "memory"} {
		if !containsField(string(controllers), c) {
			return "", permanentlyUnavailable("controllers", fmt.Errorf("the %s controller is not available in the runner's cgroup", c))
		}
	}
	return dir, nil
}

// bgJobLimitsCapability is what the runner declares about job limits on this machine, from the checks
// that change nothing: bg-job-limits/v1 where they can be enforced, else why not.
func bgJobLimitsCapability() string {
	if _, u := checkBgCgroupBase(cgroupRoot, "/proc/self/cgroup"); u != nil {
		return bgJobLimitsUnavailableCapabilityPrefix + u.code
	}
	return bgJobLimitsCapabilityV1
}

// prepareBgCgroups moves what runs in the runner's cgroup into its leaf, makes the jobs' parent with the
// bound the jobs share, and removes the empty job cgroups an earlier runner left. It returns the parent.
func prepareBgCgroups(root, selfCgroupFile string) (string, error) {
	dir, u := checkBgCgroupBase(root, selfCgroupFile)
	if u != nil {
		return "", u
	}
	leaf := filepath.Join(dir, bgCgroupRunnerLeaf)
	if err := os.Mkdir(leaf, 0o755); err != nil && !os.IsExist(err) {
		if os.IsPermission(err) {
			return "", permanentlyUnavailable("delegate", errors.New("the runner may not write its cgroup yet: restart its service so Delegate=yes takes effect"))
		}
		return "", err
	}
	if err := moveCgroupProcs(dir, leaf); err != nil {
		return "", err
	}
	write := func(path, value string) error {
		if err := os.WriteFile(path, []byte(value), 0); err != nil {
			return fmt.Errorf("set %s: %w", path, err)
		}
		return nil
	}
	if err := write(filepath.Join(dir, "cgroup.subtree_control"), "+cpu +memory"); err != nil {
		return "", err
	}
	if err := write(filepath.Join(leaf, "cpu.weight"), strconv.Itoa(bgCgroupRunnerCPUWeight)); err != nil {
		return "", err
	}
	if err := probeCloneIntoCgroup(leaf); err != nil {
		return "", permanentlyUnavailable("unknown", fmt.Errorf("this kernel cannot start a process inside a cgroup (CLONE_INTO_CGROUP, Linux 5.7+): %w", err))
	}
	jobs := filepath.Join(dir, bgCgroupJobsParent)
	if err := os.Mkdir(jobs, 0o755); err != nil && !os.IsExist(err) {
		return "", err
	}
	if err := write(filepath.Join(jobs, "cgroup.subtree_control"), "+cpu +memory"); err != nil {
		return "", err
	}
	if err := write(filepath.Join(jobs, "cpu.weight"), strconv.Itoa(bgCgroupJobsCPUWeight)); err != nil {
		return "", err
	}
	if budget := bgJobsMemoryBudget(dir); budget > 0 {
		if err := write(filepath.Join(jobs, "memory.max"), strconv.FormatUint(budget, 10)); err != nil {
			return "", err
		}
	}
	sweepBgJobCgroups(jobs, nil)
	return jobs, nil
}

// bgJobsMemoryBudget is what the limited jobs may hold together: a share of the machine's memory, or of the
// runner unit's own limit where that is lower. Zero when neither can be read, which leaves it unbounded.
func bgJobsMemoryBudget(unit string) uint64 {
	var total uint64
	if f, err := os.Open("/proc/meminfo"); err == nil {
		if t, _ := parseMeminfo(bufio.NewScanner(f)); t != nil {
			total = *t
		}
		f.Close()
	}
	if b, err := os.ReadFile(filepath.Join(unit, "memory.max")); err == nil {
		if v, err := strconv.ParseUint(strings.TrimSpace(string(b)), 10, 64); err == nil && (total == 0 || v < total) {
			total = v
		}
	}
	return uint64(float64(total) * bgCgroupJobsMemoryShare)
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
	jobs, err := setupBgCgroups()
	if err != nil {
		return nil, err
	}
	bgCgroups.Lock()
	if bgCgroups.live == nil {
		bgCgroups.live = map[string]bool{}
	}
	bgCgroups.live[jobID] = true
	bgCgroups.Unlock()
	dir := filepath.Join(jobs, bgCgroupJobPrefix+jobID)
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
	jobs, err := setupBgCgroups()
	if err != nil {
		return nil
	}
	bgCgroups.Lock()
	defer bgCgroups.Unlock()
	dir := filepath.Join(jobs, bgCgroupJobPrefix+jobID)
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
	if bgCgroups.jobs != "" {
		sweepBgJobCgroups(bgCgroups.jobs, bgCgroups.live)
	}
}
