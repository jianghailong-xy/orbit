//go:build linux

package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The not-delegated answer: a runner whose unit predates Delegate=yes is told what to do about it.
func TestBgCgroupsNeedADelegatedCgroup(t *testing.T) {
	own, err := ownCgroupPath("/proc/self/cgroup")
	if err != nil {
		t.Skip("no cgroup v2 here:", err)
	}
	if cgroupDelegated(filepath.Join(cgroupRoot, own)) {
		t.Skip("this test runs in a delegated cgroup")
	}
	if _, err := prepareBgCgroupBase(cgroupRoot, "/proc/self/cgroup"); err == nil || !strings.Contains(err.Error(), "Delegate=yes") {
		t.Fatalf("prepareBgCgroupBase outside a delegated cgroup = %v, want the Delegate=yes answer", err)
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
	setupBgCgroups()
	if bgCgroups.base == "" {
		t.Fatalf("setupBgCgroups: %s", bgCgroups.unavailable)
	}
	own, _ := ownCgroupPath("/proc/self/cgroup")
	if filepath.Base(own) != bgCgroupRunnerLeaf {
		t.Fatalf("the runner is in %s, not its leaf", own)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	bg := newBgTailer(ctx, func(string, map[string]interface{}) {}, nil)
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
		if _, err := os.Stat(filepath.Join(bgCgroups.base, bgCgroupJobPrefix+status.JobID)); !os.IsNotExist(err) {
			t.Errorf("job cgroup still there after the job ended: %v", err)
		}
		return final, string(out)
	}

	_, out := run(`d=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup); bash -c 'cut -d: -f3 /proc/self/cgroup'; cat $d/cpu.max $d/memory.max`,
		bgJobLimits{CPUs: 0.5, MemoryMB: 64})
	lines := strings.Fields(out)
	if len(lines) != 4 || !strings.Contains(lines[0], "/"+bgCgroupJobPrefix) ||
		lines[1] != "50000" || lines[2] != "100000" || lines[3] != "67108864" {
		t.Fatalf("job saw its cgroup as %q; want its own cgroup, its child in it, cpu.max 50000 100000, memory.max 64 MiB", out)
	}

	if w, _ := os.ReadFile(filepath.Join(bgCgroups.base, bgCgroupRunnerLeaf, "cpu.weight")); strings.TrimSpace(string(w)) != "1000" {
		t.Errorf("runner leaf cpu.weight = %q, want 1000", w)
	}

	// A kill reaches what left the job's process group and its process tree, too: an orphan in a
	// session of its own, which only the job's cgroup still holds.
	escaped := filepath.Join(dir, "escaped.pid")
	status, err := bg.startJob(bgJobSpec{Command: "setsid sh -c 'sleep 301 & echo $! >" + escaped + "'; sleep 300",
		Kind: bgKindService, Dir: dir, ScratchDir: dir, Limits: bgJobLimits{CPUs: 1}})
	if err != nil {
		t.Fatalf("startJob: %v", err)
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
