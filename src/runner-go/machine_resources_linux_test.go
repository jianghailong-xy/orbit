//go:build linux

package main

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestParseProcStatCPU(t *testing.T) {
	busy, total, ok := parseProcStatCPU("cpu  100 5 50 800 40 3 2 0 7 0")
	if !ok || total != 1000 || busy != 160 {
		t.Fatalf("busy/total = %d/%d %v, want 160/1000 (guest left out, idle+iowait not busy)", busy, total, ok)
	}
	if _, _, ok := parseProcStatCPU("cpu0 1 2 3 4"); ok {
		t.Fatal("a per-core line is not the machine's")
	}
}

func TestParseMeminfoAndLoad(t *testing.T) {
	total, avail := parseMeminfo(bufio.NewScanner(strings.NewReader("MemTotal:       32000 kB\nMemFree:  100 kB\nMemAvailable:   8000 kB\n")))
	if total == nil || *total != 32000*1024 || avail == nil || *avail != 8000*1024 {
		t.Fatalf("meminfo = %v/%v", total, avail)
	}
	if l := parseLoad1("3.04 2.50 1.00 2/300 1234\n"); l == nil || *l != 3.04 {
		t.Fatalf("load1 = %v", l)
	}
}

func TestReadPlatformResourcesOnThisMachine(t *testing.T) {
	var c cpuCounter
	var r MachineResources
	readPlatformResources(&r, &c)
	if r.MemTotalBytes == nil || r.MemAvailableBytes == nil || *r.MemAvailableBytes > *r.MemTotalBytes {
		t.Fatalf("memory = %v/%v", r.MemAvailableBytes, r.MemTotalBytes)
	}
	if r.Load1 == nil {
		t.Fatal("no load average")
	}
}

func writeCgroup(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, text := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestContainerCgroup(t *testing.T) {
	root := writeCgroup(t, map[string]string{"cpu.stat": "usage_usec 1\n", "memory.stat": ""})
	if containerCgroup(root) {
		t.Fatal("the root cgroup (no cpu.max, no memory.max) is the machine's")
	}
	if !containerCgroup(writeCgroup(t, map[string]string{"cpu.stat": "usage_usec 1\n", "memory.max": "max\n"})) {
		t.Fatal("a cgroup with memory.max is a container's")
	}
	if containerCgroup(t.TempDir()) {
		t.Fatal("no cgroup v2 is the machine's")
	}
}

func TestReadCgroupResourcesWithLimits(t *testing.T) {
	const GiB = 1 << 30
	host := uint64(63 * GiB)
	dir := writeCgroup(t, map[string]string{
		"cpu.max":        "150000 100000\n", // 1.5 cores
		"cpu.stat":       "usage_usec 1000000\nuser_usec 800000\n",
		"memory.max":     strconv.FormatUint(2*GiB, 10) + "\n",
		"memory.current": strconv.FormatUint(GiB, 10) + "\n",
		"memory.stat":    "anon 1\ninactive_file " + strconv.FormatUint(GiB/4, 10) + "\nactive_file 5\n",
	})
	var c cpuCounter
	r := MachineResources{CPUCores: 8}
	readCgroupResources(&r, &c, dir, &host, 10*time.Second)
	if r.CPUCores != 2 || r.CPUPercent != nil || r.Load1 != nil {
		t.Fatalf("first reading: cores %d, cpu %v, load %v; want 2, none, none", r.CPUCores, r.CPUPercent, r.Load1)
	}
	if *r.MemTotalBytes != 2*GiB || *r.MemAvailableBytes != 2*GiB-(GiB-GiB/4) {
		t.Fatalf("memory = %d of %d", *r.MemAvailableBytes, *r.MemTotalBytes)
	}

	// 0.75 s of CPU in 1 s of wall time under a 1.5-core limit is half the limit.
	if err := os.WriteFile(filepath.Join(dir, "cpu.stat"), []byte("usage_usec 1750000\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r = MachineResources{CPUCores: 8}
	readCgroupResources(&r, &c, dir, &host, 11*time.Second)
	if r.CPUPercent == nil || *r.CPUPercent != 50 {
		t.Fatalf("cpu = %v, want 50", r.CPUPercent)
	}
}

func TestReadCgroupResourcesWithoutLimits(t *testing.T) {
	host := uint64(8000)
	dir := writeCgroup(t, map[string]string{
		"cpu.max":        "max 100000\n",
		"cpu.stat":       "usage_usec 0\n",
		"memory.max":     "max\n",
		"memory.current": "3000\n",
		"memory.stat":    "inactive_file 1000\n",
	})
	var c cpuCounter
	r := MachineResources{CPUCores: 4}
	readCgroupResources(&r, &c, dir, &host, time.Second)
	if err := os.WriteFile(filepath.Join(dir, "cpu.stat"), []byte("usage_usec 1000000\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	readCgroupResources(&r, &c, dir, &host, 2*time.Second)
	// One core busy for the second, out of all four the container may use.
	if r.CPUCores != 4 || r.CPUPercent == nil || *r.CPUPercent != 25 {
		t.Fatalf("cores %d, cpu %v; want 4, 25", r.CPUCores, r.CPUPercent)
	}
	if *r.MemTotalBytes != 8000 || *r.MemAvailableBytes != 6000 {
		t.Fatalf("memory = %d of %d, want the container's 2000 used out of the machine's 8000", *r.MemAvailableBytes, *r.MemTotalBytes)
	}
}

// The turn memory gate's reading (memory_reserve.go): on Linux there is always one, the container's or the machine's.
func TestAvailableMemoryOnThisMachine(t *testing.T) {
	available, ok := availableMemory()
	if !ok || available == 0 {
		t.Fatalf("availableMemory() = %d, %v; want a reading", available, ok)
	}
}
