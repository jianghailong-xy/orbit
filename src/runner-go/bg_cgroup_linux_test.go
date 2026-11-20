//go:build linux

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Tests never make job cgroups in the cgroup they happen to run in — a session's on a delegated runner
// would be a real one — unless the kernel test below is asked for.
func init() {
	if os.Getenv("ORBIT_BG_CGROUP_TEST") != "1" {
		bgCgroups.unavailable = permanentlyUnavailable("cgroup", errors.New("job cgroups are off in tests"))
	}
}

// What the runner declares, and the page says, for a machine whose cgroup it cannot use.
func TestBgCgroupCheckNamesWhyLimitsAreUnavailable(t *testing.T) {
	root := t.TempDir()
	self := filepath.Join(t.TempDir(), "cgroup")
	check := func(content string) string {
		if err := os.WriteFile(self, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		_, u := checkBgCgroupBase(root, self)
		if u == nil {
			return ""
		}
		if !u.permanent {
			t.Errorf("%q: a check answer that is not permanent", content)
		}
		return u.code
	}
	if err := os.MkdirAll(filepath.Join(root, "user.slice", "session-1.scope"), 0o755); err != nil {
		t.Fatal(err)
	}
	for content, want := range map[string]string{
		"1:name=systemd:/x\n":            "cgroup", // cgroup v1 only
		"0::/\n":                         "cgroup", // a container's own namespace
		"0::/system.slice/gone.service":  "cgroup", // not under the root
		"0::/user.slice/session-1.scope": "cgroup", // a terminal, not a service
	} {
		if got := check(content); got != want {
			t.Errorf("%q: code %q, want %q", content, got, want)
		}
	}
	// A real service cgroup on this machine that is not delegated.
	own, err := ownCgroupPath("/proc/self/cgroup")
	if err != nil || !strings.HasSuffix(own, ".service") || cgroupDelegated(filepath.Join(cgroupRoot, own)) {
		return
	}
	if _, u := checkBgCgroupBase(cgroupRoot, "/proc/self/cgroup"); u == nil || u.code != "delegate" || !strings.Contains(u.Error(), "Delegate=yes") {
		t.Fatalf("an undelegated service = %v, want the delegate answer", u)
	}
	if got := bgJobLimitsCapability(); got != bgJobLimitsUnavailableCapabilityPrefix+"delegate" {
		t.Fatalf("capability = %q", got)
	}
}

// The real kernel: a job runs in a cgroup of its own with its CPU and memory written, and one that
// outgrows its memory is killed and says why. It moves the test process, so it runs only where asked,
// inside a delegated unit:
//
//	systemd-run -p Delegate=yes --wait --pipe -E ORBIT_BG_CGROUP_TEST=1 ... ./orbit.test -test.run BgCgroup
func TestBgCgroupLimitsAJobInTheKernel(t *testing.T) {
	if os.Getenv("ORBIT_BG_CGROUP_TEST") != "1" {
		t.Skip("set ORBIT_BG_CGROUP_TEST=1 and run inside a unit with Delegate=yes")
	}
	if got := bgJobLimitsCapability(); got != bgJobLimitsCapabilityV1 {
		t.Fatalf("capability before setup = %q", got)
	}
	jobs, err := setupBgCgroups()
	if err != nil {
		t.Fatalf("setupBgCgroups: %v", err)
	}
	if got := bgJobLimitsCapability(); got != bgJobLimitsCapabilityV1 {
		t.Fatalf("capability after setup = %q", got)
	}
	base := filepath.Dir(jobs)
	if w, _ := os.ReadFile(filepath.Join(jobs, "cpu.weight")); strings.TrimSpace(string(w)) != "100" {
		t.Errorf("jobs' parent cpu.weight = %q, want 100", w)
	}
	if m, _ := os.ReadFile(filepath.Join(jobs, "memory.max")); strings.TrimSpace(string(m)) == "max" || len(m) == 0 {
		t.Errorf("jobs' parent memory.max = %q, want half the machine", m)
	}
	own, _ := ownCgroupPath("/proc/self/cgroup")
	if filepath.Base(own) != bgCgroupRunnerLeaf {
		t.Fatalf("the runner is in %s, not its leaf", own)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	holds := &recordingHolds{active: map[string]string{}}
	bg := newBgTailer(ctx, func(string, map[string]interface{}) {}, holds)
	t.Cleanup(bg.stopAll)
	dir := t.TempDir()
	run := func(command string, limits bgJobLimits) (bgJobStatus, string) {
		status, err := bg.startJob(bgJobSpec{Command: command, Kind: bgKindJob, Dir: dir, ScratchDir: dir, Limits: limits})
		if err != nil {
			t.Fatalf("startJob: %v", err)
		}
		if status.Limits == nil || *status.Limits != limits || status.LimitsNote != "" {
			t.Fatalf("status limits = %+v, note %q", status.Limits, status.LimitsNote)
		}
		<-bg.jobs[status.JobID].done
		out, _ := os.ReadFile(filepath.Join(dir, status.JobID+".output"))
		final, _ := bg.jobStatus(status.JobID)
		if _, err := os.Stat(filepath.Join(jobs, bgCgroupJobPrefix+status.JobID)); !os.IsNotExist(err) {
			t.Errorf("job cgroup still there after the job ended: %v", err)
		}
		return final, string(out)
	}

	_, out := run(`d=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup); bash -c 'cut -d: -f3 /proc/self/cgroup'; cat $d/cpu.max $d/memory.max`,
		bgJobLimits{CPUs: 0.5, MemoryMB: 64})
	lines := strings.Fields(out)
	if len(lines) != 4 || !strings.Contains(lines[0], "/"+bgCgroupJobsParent+"/"+bgCgroupJobPrefix) ||
		lines[1] != "50000" || lines[2] != "100000" || lines[3] != "67108864" {
		t.Fatalf("job saw its cgroup as %q; want its own cgroup, its child in it, cpu.max 50000 100000, memory.max 64 MiB", out)
	}

	if w, _ := os.ReadFile(filepath.Join(base, bgCgroupRunnerLeaf, "cpu.weight")); strings.TrimSpace(string(w)) != "1000" {
		t.Errorf("runner leaf cpu.weight = %q, want 1000", w)
	}

	// A kill reaches what left the job's process group and its process tree, too: an orphan in a
	// session of its own, which only the job's cgroup still holds.
	escaped := filepath.Join(dir, "escaped.pid")
	status, err := bg.startJob(bgJobSpec{Command: "setsid sh -c 'sleep 301 & echo $! >" + escaped + "'; sleep 300",
		Kind: bgKindService, Dir: dir, ScratchDir: dir, Limits: bgJobLimits{CPUs: 1, MemoryMB: 256}})
	if err != nil {
		t.Fatalf("startJob: %v", err)
	}
	// Bounded by both limits, it takes no session slot.
	if door := holds.door(status.JobID); door != "watch" {
		t.Errorf("a job under both limits held the checkout through %q, want the no-capacity door", door)
	}
	var pid string
	for range 100 {
		if b, _ := os.ReadFile(escaped); len(strings.TrimSpace(string(b))) > 0 {
			pid = strings.TrimSpace(string(b))
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if pid == "" {
		t.Fatal("the job never started its setsid child")
	}
	if _, err := bg.killJob(status.JobID, bgKillTeardownGrace); err != nil {
		t.Fatalf("killJob: %v", err)
	}
	gone := false
	for range 100 {
		if b, err := os.ReadFile("/proc/" + pid + "/stat"); err != nil || strings.Contains(string(b), ") Z ") {
			gone = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !gone {
		t.Errorf("the setsid child %s outlived its job's kill", pid)
	}

	final, out := run(`head -c 400M /dev/zero | tail -c 300M >/dev/null; echo survived`, bgJobLimits{MemoryMB: 64})
	if strings.Contains(out, "survived") || final.Status != bgStatusFailed ||
		!strings.Contains(out, "it reached its memory limit (64 MB)") {
		t.Fatalf("over-limit job ended %s, output %q", final.Status, out)
	}
}

// A job's cgroup is empty from its mkdir until its process starts in it; another job's end sweeping the
// empty ones must not take it away.
func TestBgCgroupSweepLeavesALiveJobsCgroup(t *testing.T) {
	base := t.TempDir()
	for _, name := range []string{bgCgroupJobPrefix + "starting", bgCgroupJobPrefix + "ended", bgCgroupRunnerLeaf} {
		if err := os.Mkdir(filepath.Join(base, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	sweepBgJobCgroups(base, map[string]bool{"starting": true})
	for name, want := range map[string]bool{bgCgroupJobPrefix + "starting": true, bgCgroupJobPrefix + "ended": false, bgCgroupRunnerLeaf: true} {
		if _, err := os.Stat(filepath.Join(base, name)); (err == nil) != want {
			t.Errorf("%s present = %v, want %v", name, err == nil, want)
		}
	}
}
