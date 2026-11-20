package main

import (
	"bytes"
	"context"
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
	// No ceiling: the ask stands.
	if got, note := effectiveBgLimits(bgJobLimits{CPUs: 64}, bgJobLimits{}); got.CPUs != 64 || note != "" {
		t.Errorf("without a ceiling = %+v, %q", got, note)
	}
}

func TestParseMemoryMB(t *testing.T) {
	for in, want := range map[string]int64{"512": 512, "512M": 512, "8G": 8192, "1.5g": 1536, "2GiB": 2048, "0": 0} {
		if got, err := parseMemoryMB(in); err != nil || got != want {
			t.Errorf("parseMemoryMB(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "lots", "-1G", "100B", "1e12G"} {
		if _, err := parseMemoryMB(bad); err == nil {
			t.Errorf("parseMemoryMB(%q) took it", bad)
		}
	}
}

func TestBgLimitsCommandKeepsTheCeilingInConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	t.Setenv("ORBIT_SESSION_ID", "")
	if err := saveConfig(&RunnerConfig{RunnerID: "r1", Name: "box"}); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) (string, error) {
		var out bytes.Buffer
		err := cmdBgLimits(args, &out)
		return out.String(), err
	}
	if out, err := run("--cpus", "2", "--memory", "8G"); err != nil || !strings.Contains(out, "cpus 2, memory 8192 MB") {
		t.Fatalf("set = %q, %v", out, err)
	}
	if got := runnerBgJobCeiling(); got != (bgJobLimits{CPUs: 2, MemoryMB: 8192}) {
		t.Fatalf("ceiling after set = %+v", got)
	}
	if loadConfig().RunnerID != "r1" {
		t.Fatal("setting the limits lost the rest of the config")
	}
	if _, err := run("--memory", "0"); err != nil || runnerBgJobCeiling() != (bgJobLimits{CPUs: 2}) {
		t.Fatalf("clearing memory alone = %+v, %v", runnerBgJobCeiling(), err)
	}
	if out, err := run(); err != nil || !strings.Contains(out, "cpus 2") {
		t.Fatalf("show = %q, %v", out, err)
	}
	if _, err := run("--clear"); err != nil || !runnerBgJobCeiling().none() || loadConfig().BackgroundJobLimits != nil {
		t.Fatalf("clear left %+v, %v", runnerBgJobCeiling(), err)
	}
	for _, bad := range [][]string{{"--cpus", "abc"}, {"--memory", "8"}, {"--cpus"}, {"extra"}} {
		if _, err := run(bad...); err == nil {
			t.Errorf("bg-limits %v took it", bad)
		}
	}
	// An agent runs as the same user; it does not get to raise the ceiling that bounds it.
	t.Setenv("ORBIT_SESSION_ID", "s1")
	if _, err := run("--clear"); err == nil {
		t.Fatal("bg-limits ran inside a session")
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
