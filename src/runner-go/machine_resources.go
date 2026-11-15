package main

import (
	"math"
	"runtime"
	"sync"
)

// The machine's CPU, memory and disk, reported on every heartbeat (HeartbeatRequest.Resources) for the Resources
// section of the machine's page. The control plane keeps the last hour of them beside the runner's presence row; a
// runner that declares this capability and sends no reading is one with nothing to say yet, not one too old to say it.
const machineResourcesCapabilityV1 = "machine-resources/v1"

// MachineResources mirrors @orbit/shared RunnerResources. A figure the platform has no answer for is left out: the
// page shows a dash for it, never a zero.
type MachineResources struct {
	// CPUPercent is the whole machine's CPU in use since the previous reading, 0–100. Left out on the first reading
	// of a platform that measures it as a difference (Linux), and where there is no answer.
	CPUPercent *float64 `json:"cpuPercent,omitempty"`
	CPUCores   int      `json:"cpuCores"`
	// Load1 is the one-minute load average.
	Load1 *float64 `json:"load1,omitempty"`
	// MemAvailableBytes is what the system can hand out without swapping: page cache it can drop counts as available.
	MemTotalBytes     *uint64 `json:"memTotalBytes,omitempty"`
	MemAvailableBytes *uint64 `json:"memAvailableBytes,omitempty"`
	// The disk the machine page has always shown: the fullest filesystem among the agents' working directories
	// (as the heartbeat's agentDirProbes measure them), else the one holding the repos root.
	DiskTotalBytes *uint64 `json:"diskTotalBytes,omitempty"`
	DiskFreeBytes  *uint64 `json:"diskFreeBytes,omitempty"`
}

// cpuCounter turns two readings of cumulative CPU time into the share of it that was busy in between.
type cpuCounter struct {
	mu          sync.Mutex
	busy, total uint64
	primed      bool
}

func (c *cpuCounter) percent(busy, total uint64) *float64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	prevBusy, prevTotal, primed := c.busy, c.total, c.primed
	c.busy, c.total, c.primed = busy, total, true
	if !primed || total <= prevTotal || busy < prevBusy {
		return nil
	}
	p := roundTo(100*float64(busy-prevBusy)/float64(total-prevTotal), 1)
	p = math.Max(0, math.Min(100, p))
	return &p
}

// machineCPU is the process's one counter: every heartbeat reads it once.
var machineCPU cpuCounter

// machineResources reads the machine now. probes are the agent directories' last scan; root is the repos root.
func machineResources(probes []AgentDirProbe, root string) MachineResources {
	r := MachineResources{CPUCores: runtime.NumCPU()}
	readPlatformResources(&r, &machineCPU)
	var free, total *uint64
	for i := range probes {
		p := probes[i]
		if p.FreeBytes == nil || p.TotalBytes == nil || *p.TotalBytes == 0 {
			continue
		}
		if free == nil || *p.FreeBytes < *free {
			free, total = p.FreeBytes, p.TotalBytes
		}
	}
	if free == nil && root != "" {
		if f, t, ok := diskUsage(root); ok && t > 0 {
			free, total = &f, &t
		}
	}
	r.DiskFreeBytes, r.DiskTotalBytes = free, total
	return r
}

func roundTo(v float64, places int) float64 {
	m := math.Pow(10, float64(places))
	return math.Round(v*m) / m
}
