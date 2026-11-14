//go:build linux

package main

import (
	"bufio"
	"os"
	"strconv"
	"strings"
)

// readPlatformResources reads /proc: the CPU counters of /proc/stat, /proc/loadavg and /proc/meminfo.
func readPlatformResources(r *MachineResources, cpu *cpuCounter) {
	if busy, total, ok := procStatCPU(); ok {
		r.CPUPercent = cpu.percent(busy, total)
	}
	if b, err := os.ReadFile("/proc/loadavg"); err == nil {
		r.Load1 = parseLoad1(string(b))
	}
	if f, err := os.Open("/proc/meminfo"); err == nil {
		r.MemTotalBytes, r.MemAvailableBytes = parseMeminfo(bufio.NewScanner(f))
		f.Close()
	}
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
