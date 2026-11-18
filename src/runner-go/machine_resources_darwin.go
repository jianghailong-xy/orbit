//go:build darwin

package main

import (
	"context"
	"encoding/binary"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// readPlatformResources reads macOS without cgo: memory size and load from sysctl, free pages from vm_stat, and CPU as
// the sum of every process's %CPU from ps over the cores (host_statistics would need cgo; docs/dependency-security.md).
func readPlatformResources(r *MachineResources, _ *cpuCounter) {
	if total, err := unix.SysctlUint64("hw.memsize"); err == nil {
		r.MemTotalBytes = &total
		if out, ok := runShort("vm_stat"); ok {
			r.MemAvailableBytes = parseVMStatAvailable(out)
		}
	}
	if raw, err := unix.SysctlRaw("vm.loadavg"); err == nil {
		r.Load1 = parseLoadavg(raw)
	}
	if out, ok := runShort("ps", "-A", "-o", "%cpu="); ok {
		r.CPUPercent = parsePsCPU(out, runtime.NumCPU())
	}
}

func runShort(name string, args ...string) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).Output()
	return string(out), err == nil
}

var vmStatPageSize = regexp.MustCompile(`page size of (\d+) bytes`)

// parseVMStatAvailable counts free, inactive, speculative and purgeable pages as available, as Activity Monitor does
// when it leaves them out of Memory Used.
func parseVMStatAvailable(out string) *uint64 {
	m := vmStatPageSize.FindStringSubmatch(out)
	if m == nil {
		return nil
	}
	page, err := strconv.ParseUint(m[1], 10, 64)
	if err != nil {
		return nil
	}
	var pages uint64
	found := false
	for _, line := range strings.Split(out, "\n") {
		name, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		switch strings.TrimSpace(name) {
		case "Pages free", "Pages inactive", "Pages speculative", "Pages purgeable":
			n, err := strconv.ParseUint(strings.TrimSuffix(strings.TrimSpace(value), "."), 10, 64)
			if err == nil {
				pages += n
				found = true
			}
		}
	}
	if !found {
		return nil
	}
	b := pages * page
	return &b
}

// parseLoadavg reads struct loadavg { fixpt_t ldavg[3]; long fscale; }: three uint32, padding, an int64.
func parseLoadavg(raw []byte) *float64 {
	if len(raw) < 24 {
		return nil
	}
	scale := binary.LittleEndian.Uint64(raw[16:24])
	if scale == 0 {
		return nil
	}
	v := roundTo(float64(binary.LittleEndian.Uint32(raw[0:4]))/float64(scale), 2)
	return &v
}

func parsePsCPU(out string, cores int) *float64 {
	if cores <= 0 {
		return nil
	}
	var sum float64
	for _, f := range strings.Fields(out) {
		if v, err := strconv.ParseFloat(strings.ReplaceAll(f, ",", "."), 64); err == nil {
			sum += v
		}
	}
	p := roundTo(sum/float64(cores), 1)
	if p > 100 {
		p = 100
	}
	return &p
}
