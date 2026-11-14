package main

import "testing"

func TestCPUCounterIsADifferenceBetweenReadings(t *testing.T) {
	var c cpuCounter
	if p := c.percent(100, 1000); p != nil {
		t.Fatalf("first reading = %v, want none: there is nothing to take it from", *p)
	}
	p := c.percent(400, 2000)
	if p == nil || *p != 30 {
		t.Fatalf("second reading = %v, want 30 (300 busy of 1000)", p)
	}
	if p := c.percent(400, 2000); p != nil {
		t.Fatalf("no time passed = %v, want none", *p)
	}
}

func TestMachineResourcesDiskIsTheFullestAgentDirectory(t *testing.T) {
	u := func(n uint64) *uint64 { return &n }
	r := machineResources([]AgentDirProbe{
		{AgentID: "a", FreeBytes: u(500), TotalBytes: u(1000)},
		{AgentID: "b", FreeBytes: u(40), TotalBytes: u(900)},
		{AgentID: "c"}, // missing: no figure
	}, "")
	if r.DiskFreeBytes == nil || *r.DiskFreeBytes != 40 || *r.DiskTotalBytes != 900 {
		t.Fatalf("disk = %v/%v, want 40/900", r.DiskFreeBytes, r.DiskTotalBytes)
	}
	if r.CPUCores <= 0 {
		t.Fatalf("cores = %d", r.CPUCores)
	}
}

func TestMachineResourcesDiskFallsBackToTheReposRoot(t *testing.T) {
	r := machineResources(nil, t.TempDir())
	if _, _, ok := diskUsage(t.TempDir()); ok && (r.DiskFreeBytes == nil || r.DiskTotalBytes == nil) {
		t.Fatal("no agent directories: the repos root's filesystem should answer")
	}
}
