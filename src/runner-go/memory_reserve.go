package main

import (
	"fmt"
	"sync"
	"time"
)

// turnMemoryReserveBytes is the memory a managed runner keeps free for one more turn before it starts one: an engine
// and the tools of one turn, about 1 GiB. Below it the runner claims nothing and starts no reclaimed RUNNING session;
// the work waits queued on the control plane, or in the reclaim, until memory comes back. On 2026-11-20 a 4 GiB
// managed runner raised to 4 sessions was OOM-killed three minutes later, and again on every restart, as its reclaim
// started all four at once.
const turnMemoryReserveBytes = 1 << 30

// turnMemoryRecheck is how often a wait on the reserve reads memory again: nothing signals that memory came back.
const turnMemoryRecheck = time.Second

// turnMemoryGate says whether memory has room for one more turn. A nil gate, or one with no reading, admits: a
// runner that cannot measure its memory keeps the rule it had.
type turnMemoryGate struct {
	reserve uint64
	// available reads the memory left to this runner now (availableMemory); false for no reading.
	available func() (uint64, bool)
	// recheck, if set, replaces turnMemoryRecheck (recheckEvery).
	recheck time.Duration

	mu sync.Mutex
	// short is whether the last reading was below the reserve, so the log says each change once.
	short bool
}

// newTurnMemoryGate is the gate the run loop holds: on a managed instance, its container's memory against
// turnMemoryReserveBytes; anywhere else, nil. A machine somebody runs a runner on themselves keeps its own rule.
func newTurnMemoryGate(managed bool) *turnMemoryGate {
	if !managed {
		return nil
	}
	return &turnMemoryGate{reserve: turnMemoryReserveBytes, available: availableMemory}
}

// admits reads memory and says whether one more turn may start.
func (g *turnMemoryGate) admits() bool {
	if g == nil || g.available == nil {
		return true
	}
	available, ok := g.available()
	short := ok && available < g.reserve
	g.mu.Lock()
	changed := short != g.short
	g.short = short
	g.mu.Unlock()
	if changed {
		logln(turnMemoryLine(short, available, g.reserve))
	}
	return !short
}

// recheckEvery is how long a wait on this gate goes before it reads memory again.
func (g *turnMemoryGate) recheckEvery() time.Duration {
	if g == nil || g.recheck <= 0 {
		return turnMemoryRecheck
	}
	return g.recheck
}

// turnMemoryLine is what the log says when memory falls below the reserve, or comes back above it.
func turnMemoryLine(short bool, available, reserve uint64) string {
	if short {
		return fmt.Sprintf("memory: %d MiB available, below the %d MiB one more turn needs; no new or reclaimed turn starts until it frees up",
			available>>20, reserve>>20)
	}
	return fmt.Sprintf("memory: %d MiB available again; turns start again", available>>20)
}
