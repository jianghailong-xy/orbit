package main

import (
	"runtime/debug"
	"strconv"
	"strings"
)

// The garbage collector's settings (task 34paLvEDFObkoBxYLAJSN). At hundreds of thousands of connections the GC's
// marks, not CPU or memory, set how many a gateway carries, and with neither GOGC nor GOMEMLIMIT set the heap was let
// grow to twice what was live: an idle ramp to 800,000 connections reached the container's 110 GiB and the kernel
// killed the gateway.
//
//   - The memory limit is the container's allowance less a tenth, for what the Go runtime does not count: the kernel's
//     socket buffers and the like. The GC then collects as often as it must to stay inside it, rather than the
//     kernel killing the process at the allowance.
//   - With that limit in place, GOGC is limitedGOGC: collections are rarer than at 100, so fewer requests meet a mark,
//     and the limit, not GOGC, bounds the heap. Without one, Go's 100 stays, as nothing else would bound it.
//
// GOMEMLIMIT and GOGC in the environment are left as the runtime read them.

// limitedGOGC is GOGC when a memory limit is set and the environment sets no GOGC. Measured on 28 vCPU and 110 GiB at
// 300,000 connections at cell traffic (task 34ppd5iIunTRnCBM4cMix, runs A-300k-gogc*): at 100, HeartbeatAck p99 703 ms
// and EventAck p99 1,016 ms, past the 1 s rule, with 2.9 cores of GC; at 200, 411 and 731 ms; at 400, 323 and 624 ms,
// with 0.6 cores of GC and a 52 GiB cgroup peak on a 9.7 GB live heap, well inside the limit.
const limitedGOGC = 400

// cgroupV1MemoryFile is a cgroup v1 container's memory allowance.
const cgroupV1MemoryFile = "/sys/fs/cgroup/memory/memory.limit_in_bytes"

// gcSettings is what applyGCSettings set, for the log.
type gcSettings struct {
	MemoryLimit int64  // bytes; 0 when none was set
	LimitFrom   string // GOMEMLIMIT, the cgroup file, or "" for none
	GOGC        string
}

// applyGCSettings sets the memory limit and GOGC unless the environment sets them.
func applyGCSettings(getenv func(string) string, readFile func(string) ([]byte, error)) gcSettings {
	var s gcSettings
	if v := strings.TrimSpace(getenv("GOMEMLIMIT")); v != "" {
		s.LimitFrom, s.MemoryLimit = "GOMEMLIMIT", debug.SetMemoryLimit(-1)
	} else if allowance, file := containerMemory(readFile); allowance > 0 {
		s.LimitFrom, s.MemoryLimit = file, allowance-allowance/10
		debug.SetMemoryLimit(s.MemoryLimit)
	}
	switch v := strings.TrimSpace(getenv("GOGC")); {
	case v != "":
		s.GOGC = v + " (GOGC)"
	case s.MemoryLimit > 0:
		debug.SetGCPercent(limitedGOGC)
		s.GOGC = strconv.Itoa(limitedGOGC)
	default:
		s.GOGC = "100 (no memory limit)"
	}
	return s
}

// containerMemory is the memory allowance of the cgroup the gateway runs in, in bytes, and the file it was read from;
// 0 when it has none. Under cgroup v2 that is the least memory.max of its cgroup (/proc/self/cgroup) and the cgroups
// above it: a container sees its own as the root, and a process in a systemd scope, as gateway-limit.sh runs it, sees
// the scope's path. Then cgroup v1's, for a container.
func containerMemory(readFile func(string) ([]byte, error)) (int64, string) {
	var least int64
	var from string
	if b, err := readFile("/proc/self/cgroup"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			path, ok := strings.CutPrefix(strings.TrimSpace(line), "0::")
			if !ok {
				continue
			}
			for dir := strings.TrimRight("/sys/fs/cgroup"+path, "/"); strings.HasPrefix(dir, "/sys/fs/cgroup"); dir = dir[:strings.LastIndex(dir, "/")] {
				file := dir + "/memory.max"
				if n := limitIn(readFile, file); n > 0 && (least == 0 || n < least) {
					least, from = n, file
				}
			}
		}
	}
	if least > 0 {
		return least, from
	}
	if n := limitIn(readFile, cgroupV1MemoryFile); n > 0 {
		return n, cgroupV1MemoryFile
	}
	return 0, ""
}

// limitIn reads a cgroup memory limit: 0 for none, as "max" (v2) and a page-rounded near-2^63 (v1) say.
func limitIn(readFile func(string) ([]byte, error), file string) int64 {
	b, err := readFile(file)
	if err != nil {
		return 0
	}
	n, err := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	if err != nil || n <= 0 || n >= 1<<60 {
		return 0
	}
	return n
}
