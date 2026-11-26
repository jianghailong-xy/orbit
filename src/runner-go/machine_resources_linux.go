//go:build linux

package main

import (
	"bufio"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// readPlatformResources reads /proc: the CPU counters of /proc/stat, /proc/loadavg and /proc/meminfo. In a container
// (cgroupRoot is the container's own cgroup, see containerCgroup) CPU and memory are the container's instead, and
// there is no load average: the kernel keeps one only for the whole machine.
func readPlatformResources(r *MachineResources, cpu *cpuCounter) {
	var memTotal, memAvailable *uint64
	if f, err := os.Open("/proc/meminfo"); err == nil {
		memTotal, memAvailable = parseMeminfo(bufio.NewScanner(f))
		f.Close()
	}
	if containerCgroup(cgroupRoot) {
		readCgroupResources(r, cpu, cgroupRoot, memTotal, time.Since(processStart))
		return
	}
	if busy, total, ok := procStatCPU(); ok {
		r.CPUPercent = cpu.percent(busy, total)
	}
	if b, err := os.ReadFile("/proc/loadavg"); err == nil {
		r.Load1 = parseLoad1(string(b))
	}
	r.MemTotalBytes, r.MemAvailableBytes = memTotal, memAvailable
}

// cgroupRoot is where cgroup v2 is mounted. With a cgroup namespace of its own (Docker's default on cgroup v2, and
// a Kubernetes Pod's), it is the container's cgroup; on a machine it is the root of the whole tree.
const cgroupRoot = "/sys/fs/cgroup"

var processStart = time.Now()

// containerCgroup says whether dir is a cgroup v2 below the root: the root cgroup has no cpu.max or memory.max, so a
// runner on a machine (a systemd service included, which reads the root here, not its own unit) keeps the
// machine's figures, and one in a container with no cgroup namespace of its own, or on cgroup v1, does too.
func containerCgroup(dir string) bool {
	if _, err := os.Stat(filepath.Join(dir, "cpu.stat")); err != nil {
		return false
	}
	for _, name := range []string{"cpu.max", "memory.max"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			return true
		}
	}
	return false
}

// readCgroupResources reads the container's cgroup at dir. CPU is the share of its CPU limit (cpu.max, else every
// core the runner may run on) it used since the previous reading; elapsed is the wall time since a fixed start, so
// the counter's total is the CPU time the limit allowed. Memory is out of memory.max, else the machine's total
// (hostTotal), and what is used leaves out the page cache the kernel can drop (inactive_file), as `docker stats` does.
func readCgroupResources(r *MachineResources, cpu *cpuCounter, dir string, hostTotal *uint64, elapsed time.Duration) {
	cores := float64(r.CPUCores)
	if b, err := os.ReadFile(filepath.Join(dir, "cpu.max")); err == nil {
		if limit, ok := parseCPUMax(string(b)); ok && limit < cores {
			cores = limit
		}
	}
	if cores > 0 {
		r.CPUCores = int(math.Max(1, math.Ceil(cores)))
		if b, err := os.ReadFile(filepath.Join(dir, "cpu.stat")); err == nil {
			if usage, ok := parseCPUStatUsage(string(b)); ok {
				r.CPUPercent = cpu.percent(usage, uint64(float64(elapsed.Microseconds())*cores))
			}
		}
	}

	if total, available, ok := cgroupMemory(dir, hostTotal); ok {
		r.MemTotalBytes, r.MemAvailableBytes = &total, &available
	}
}

// cgroupMemory is the container's memory at dir: its limit (memory.max, else hostTotal) and what is left of it, where
// what is used leaves out the page cache the kernel can drop (inactive_file). False when either cannot be read.
func cgroupMemory(dir string, hostTotal *uint64) (total, available uint64, ok bool) {
	limit := hostTotal
	if b, err := os.ReadFile(filepath.Join(dir, "memory.max")); err == nil {
		if n, ok := parseCgroupBytes(string(b)); ok && (limit == nil || n < *limit) {
			limit = &n
		}
	}
	b, err := os.ReadFile(filepath.Join(dir, "memory.current"))
	if limit == nil || err != nil {
		return 0, 0, false
	}
	current, ok := parseCgroupBytes(string(b))
	if !ok {
		return 0, 0, false
	}
	if b, err := os.ReadFile(filepath.Join(dir, "memory.stat")); err == nil {
		if inactive, ok := statField(string(b), "inactive_file"); ok {
			current -= min(current, inactive)
		}
	}
	if current < *limit {
		available = *limit - current
	}
	return *limit, available, true
}

// availableMemory is the memory left to this runner now, as the turn memory gate reads it (memory_reserve.go): in a
// container, what its cgroup has left, or the machine's MemAvailable when that is less; on a machine, MemAvailable.
func availableMemory() (uint64, bool) {
	var hostTotal, hostAvailable *uint64
	if f, err := os.Open("/proc/meminfo"); err == nil {
		hostTotal, hostAvailable = parseMeminfo(bufio.NewScanner(f))
		f.Close()
	}
	if containerCgroup(cgroupRoot) {
		if _, available, ok := cgroupMemory(cgroupRoot, hostTotal); ok {
			if hostAvailable != nil && *hostAvailable < available {
				available = *hostAvailable
			}
			return available, true
		}
	}
	if hostAvailable == nil {
		return 0, false
	}
	return *hostAvailable, true
}

// parseCPUMax reads cpu.max, "$QUOTA $PERIOD" in microseconds, as a number of cores. "max" is no limit.
func parseCPUMax(text string) (float64, bool) {
	fields := strings.Fields(text)
	if len(fields) != 2 || fields[0] == "max" {
		return 0, false
	}
	quota, err1 := strconv.ParseFloat(fields[0], 64)
	period, err2 := strconv.ParseFloat(fields[1], 64)
	if err1 != nil || err2 != nil || quota <= 0 || period <= 0 {
		return 0, false
	}
	return quota / period, true
}

// parseCPUStatUsage reads usage_usec, the cgroup's cumulative CPU time, from cpu.stat.
func parseCPUStatUsage(text string) (uint64, bool) {
	return statField(text, "usage_usec")
}

// parseCgroupBytes reads a single byte count (memory.max, memory.current). "max" is no limit.
func parseCgroupBytes(text string) (uint64, bool) {
	n, err := strconv.ParseUint(strings.TrimSpace(text), 10, 64)
	return n, err == nil
}

// statField reads one "key value" line of a cgroup stat file.
func statField(text, key string) (uint64, bool) {
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == key {
			n, err := strconv.ParseUint(fields[1], 10, 64)
			return n, err == nil
		}
	}
	return 0, false
}

// procStatCPU sums the machine's "cpu" line: user nice system idle iowait irq softirq steal (guest time is already
// counted in user). Idle and iowait are the time not busy.
func procStatCPU() (busy, total uint64, ok bool) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return 0, 0, false
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	if !s.Scan() {
		return 0, 0, false
	}
	return parseProcStatCPU(s.Text())
}

func parseProcStatCPU(line string) (busy, total uint64, ok bool) {
	fields := strings.Fields(line)
	if len(fields) < 5 || fields[0] != "cpu" {
		return 0, 0, false
	}
	var idle uint64
	for i, f := range fields[1:] {
		if i >= 8 {
			break
		}
		n, err := strconv.ParseUint(f, 10, 64)
		if err != nil {
			return 0, 0, false
		}
		total += n
		if i == 3 || i == 4 {
			idle += n
		}
	}
	return total - idle, total, true
}

func parseLoad1(text string) *float64 {
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return nil
	}
	v, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return nil
	}
	v = roundTo(v, 2)
	return &v
}

// parseMeminfo reads MemTotal and MemAvailable (kB). A kernel too old for MemAvailable (before 3.14) gives total only.
func parseMeminfo(s *bufio.Scanner) (total, available *uint64) {
	for s.Scan() {
		fields := strings.Fields(s.Text())
		if len(fields) < 2 {
			continue
		}
		n, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		n *= 1024
		switch fields[0] {
		case "MemTotal:":
			total = &n
		case "MemAvailable:":
			available = &n
		}
	}
	return total, available
}
