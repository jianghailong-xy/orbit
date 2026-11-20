package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestBgLimitArgsTakesOnlyLimits(t *testing.T) {
	got, err := bgLimitArgs(map[string]interface{}{"cpus": 1.5, "memoryMb": float64(2048)})
	if err != nil || got != (bgJobLimits{CPUs: 1.5, MemoryMB: 2048}) {
		t.Fatalf("bgLimitArgs = %+v, %v", got, err)
	}
	if got, err := bgLimitArgs(map[string]interface{}{}); err != nil || !got.none() {
		t.Fatalf("no limits asked = %+v, %v", got, err)
	}
	for _, bad := range []map[string]interface{}{
		{"cpus": 0.0}, {"cpus": -1.0}, {"cpus": "2"}, {"cpus": 5000.0},
		{"memoryMb": 1.5}, {"memoryMb": 8.0}, {"memoryMb": "1G"},
	} {
		if _, err := bgLimitArgs(bad); err == nil {
			t.Errorf("bgLimitArgs(%v) took it", bad)
		}
	}
}

func TestBgJobLimitsStayUnderTheRunnersCeiling(t *testing.T) {
	ceiling := bgJobLimits{CPUs: 4, MemoryMB: 8192}
	cases := []struct {
		asked, want bgJobLimits
		lowered     bool
	}{
		{bgJobLimits{}, ceiling, false},
		{bgJobLimits{CPUs: 1}, bgJobLimits{CPUs: 1, MemoryMB: 8192}, false},
		{bgJobLimits{CPUs: 8, MemoryMB: 1024}, bgJobLimits{CPUs: 4, MemoryMB: 1024}, true},
		{bgJobLimits{MemoryMB: 65536}, ceiling, true},
	}
	for _, c := range cases {
		got, note := effectiveBgLimits(c.asked, ceiling)
		if got != c.want || (note != "") != c.lowered {
			t.Errorf("effectiveBgLimits(%+v) = %+v, %q; want %+v, lowered %v", c.asked, got, note, c.want, c.lowered)
		}
	}
	// No ceiling: limits are off, so an ask is not applied, and is told so.
	if got, note := effectiveBgLimits(bgJobLimits{CPUs: 64}, bgJobLimits{}); !got.none() || note != bgLimitsOffNote {
		t.Errorf("without a ceiling = %+v, %q", got, note)
	}
	if got, note := effectiveBgLimits(bgJobLimits{}, bgJobLimits{}); !got.none() || note != "" {
		t.Errorf("no ask, no ceiling = %+v, %q", got, note)
	}
	// A ceiling on one field turns limits on; the other field takes the agent's ask as it stands.
	if got, _ := effectiveBgLimits(bgJobLimits{MemoryMB: 512}, bgJobLimits{CPUs: 2}); got != (bgJobLimits{CPUs: 2, MemoryMB: 512}) {
		t.Errorf("ceiling on cpus only = %+v", got)
	}
}

// The ceiling is what the last heartbeat answer carried, and an answer without one turns limits off.
func TestBgJobCeilingComesFromTheHeartbeat(t *testing.T) {
	t.Cleanup(func() { runnerBgJobLimits.Store(nil) })
	var on, off HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"backgroundJobLimits":{"cpus":1.5,"memoryMb":4096}}`), &on); err != nil {
		t.Fatal(err)
	}
	runnerBgJobLimits.Store(on.BackgroundJobLimits)
	if got := runnerBgJobCeiling(); got != (bgJobLimits{CPUs: 1.5, MemoryMB: 4096}) {
		t.Fatalf("ceiling = %+v", got)
	}
	if err := json.Unmarshal([]byte(`{}`), &off); err != nil {
		t.Fatal(err)
	}
	runnerBgJobLimits.Store(off.BackgroundJobLimits)
	if got := runnerBgJobCeiling(); !got.none() {
		t.Fatalf("ceiling after an answer without limits = %+v, want off", got)
	}
}

// Where no job cgroup can be made, the job still runs, and says its limits were not applied.
func TestBgJobWithoutCgroupsSaysItsLimitsWereNotApplied(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	bg := newBgTailer(ctx, func(string, map[string]interface{}) {}, nil)
	t.Cleanup(bg.stopAll)
	dir := t.TempDir()
	status, err := bg.startJob(bgJobSpec{Command: "echo ran", Kind: bgKindJob, Dir: dir, ScratchDir: dir,
		Limits: bgJobLimits{CPUs: 1, MemoryMB: 256}})
	if err != nil {
		t.Fatalf("startJob: %v", err)
	}
	if status.Limits != nil || !strings.Contains(status.LimitsNote, "Limits not applied (cpus 1, memory 256 MB)") {
		t.Fatalf("status limits = %+v, note %q", status.Limits, status.LimitsNote)
	}
	<-bg.jobs[status.JobID].done
	if out, _ := os.ReadFile(filepath.Join(dir, status.JobID+".output")); strings.TrimSpace(string(out)) != "ran" {
		t.Fatalf("job output = %q", out)
	}
}

// Both units this binary writes delegate the runner its cgroup, which job limits are made in.
func TestRunnerUnitsDelegateTheirCgroup(t *testing.T) {
	for name, unit := range map[string]string{
		"renderSystemdUnit":  renderSystemdUnit("alice", "alice", "/home/alice/.orbit/bin/orbit", "/home/alice", "/home/alice/.orbit", "/usr/bin:/bin", nil),
		"hostRunnerTemplate": hostRunnerTemplate(),
	} {
		if !slices.Contains(unitDirectives(unit), "Delegate=yes") {
			t.Errorf("%s has no Delegate=yes:\n%s", name, unit)
		}
	}
}

// A job handed on across a self-update keeps its limits in what the next image reports.
func TestBgJobRecordCarriesLimitsToTheAdoptingImage(t *testing.T) {
	job := &bgJob{id: "bgj_1", kind: bgKindJob, pid: 4242, limits: &bgJobLimits{CPUs: 2, MemoryMB: 512},
		limitsNote: "cpus lowered to this runner's ceiling (cpus 2)"}
	adopted := adoptedJob(job.recordLocked("s1"))
	if adopted.limits == nil || *adopted.limits != *job.limits || adopted.limitsNote != job.limitsNote {
		t.Fatalf("adopted limits = %+v, note %q", adopted.limits, adopted.limitsNote)
	}
	if st := adopted.statusLocked(); st.Limits == nil || st.LimitsNote == "" {
		t.Fatalf("adopted status lost its limits: %+v", st)
	}
}

// A job running under limits takes no session slot: it holds the checkout through the door a watch uses,
// because the jobs' parent cgroup bounds them all together. One whose limits were not applied counts.
func TestABoundedJobTakesNoSessionSlot(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	holds := &recordingHolds{active: map[string]string{}}
	bg := newBgTailer(ctx, func(string, map[string]interface{}) {}, holds)
	t.Cleanup(bg.stopAll)
	cases := map[string]struct {
		limits *bgJobLimits
		door   string
	}{
		"bgj_bounded":  {&bgJobLimits{CPUs: 2, MemoryMB: 1024}, "watch"},
		"bgj_cpu_only": {&bgJobLimits{CPUs: 2}, "watch"},
		"bgj_mem_only": {&bgJobLimits{MemoryMB: 1024}, "watch"},
		"bgj_none":     {nil, "job"},
	}
	bg.mu.Lock()
	for id, c := range cases {
		bg.jobs[id] = &bgJob{id: id, kind: bgKindJob, limits: c.limits}
		bg.holdFor(id, id, false)
	}
	bg.mu.Unlock()
	for id, c := range cases {
		if got := holds.door(id); got != c.door {
			t.Errorf("%s held through %q, want %q", id, got, c.door)
		}
	}

	// And the pool's capacity account agrees.
	pool := newSessionPoolWithClock(1, newFakePoolClock())
	pool.holdWorktreeForRunnerWatch("s1", "bgj_bounded", "bounded build")
	pool.holdWorktreeForRunnerJob("s2", "bgj_none", "unbounded build")
	if counts := pool.backgroundJobCounts(); counts["s1"] != 0 || counts["s2"] != 1 {
		t.Fatalf("backgroundJobCounts = %v, want only s2's job counted", counts)
	}
}
