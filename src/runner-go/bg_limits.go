package main

import (
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"sync/atomic"
)

// CPU and memory limits on runner-hosted background jobs (bg_run). They are off until the machine's owner
// sets a ceiling for this runner on its Settings → Machine page (Runner.bgJobCpus and bgJobMemoryMb), which
// every heartbeat answer carries (HeartbeatResponse.BackgroundJobLimits); from then it is every job's limit,
// and an agent may ask bg_run for less, never for more. On Linux each limited job runs in a cgroup v2 of its
// own (bg_cgroup_linux.go): cpu.max throttles it to its CPUs, and past memory.max the kernel kills the whole
// job, not the runner or the session beside it. Where that cannot be done — macOS, a runner unit without
// Delegate=yes, a container — the job still runs, and bg_run says the limit was not applied rather than
// leaving the agent to believe it was. The runner declares which (bgJobLimitsCapability), for the page.
//
// A limit is resource management, not a security boundary: a job runs as the runner's own user, who owns
// the delegated cgroup.

// The capabilities bgJobLimitsCapability declares: one where limits can be enforced, else the prefix and why
// not — os, cgroup, delegate or controllers (@orbit/shared BG_JOB_LIMITS_CAPABILITY).
const (
	bgJobLimitsCapabilityV1                = "bg-job-limits/v1"
	bgJobLimitsUnavailableCapabilityPrefix = "bg-job-limits-unavailable/v1:"
)

// bgCPUsMax and bgMemoryMBMin bound what a limit may say: more CPUs than any machine has is a typo, and
// a job given less memory than a shell needs dies before it prints why.
const (
	bgCPUsMax     = 1024
	bgMemoryMBMin = 16
)

// bgJobLimits is a job's limits; zero in a field is no limit on it.
type bgJobLimits struct {
	CPUs     float64 `json:"cpus,omitempty"`
	MemoryMB int64   `json:"memoryMb,omitempty"`
}

func (l bgJobLimits) none() bool { return l.CPUs == 0 && l.MemoryMB == 0 }

func (l bgJobLimits) validate() error {
	if l.CPUs < 0 || l.CPUs > bgCPUsMax || math.IsNaN(l.CPUs) {
		return fmt.Errorf("cpus must be a number above 0 and at most %d, got %v", bgCPUsMax, l.CPUs)
	}
	if l.MemoryMB != 0 && l.MemoryMB < bgMemoryMBMin {
		return fmt.Errorf("memoryMb must be a whole number of megabytes, at least %d, got %d", bgMemoryMBMin, l.MemoryMB)
	}
	return nil
}

func (l bgJobLimits) String() string {
	var parts []string
	if l.CPUs > 0 {
		parts = append(parts, "cpus "+strconv.FormatFloat(l.CPUs, 'f', -1, 64))
	}
	if l.MemoryMB > 0 {
		parts = append(parts, fmt.Sprintf("memory %d MB", l.MemoryMB))
	}
	if len(parts) == 0 {
		return "none"
	}
	return strings.Join(parts, ", ")
}

// bgLimitArgs reads bg_run's cpus and memoryMb. Anything that is not a limit is refused rather than run
// without one.
func bgLimitArgs(args map[string]interface{}) (bgJobLimits, error) {
	var l bgJobLimits
	if raw, ok := args["cpus"]; ok && raw != nil {
		v, ok := raw.(float64)
		if !ok || v <= 0 {
			return l, fmt.Errorf("cpus must be a number above 0 and at most %d, got %v", bgCPUsMax, raw)
		}
		l.CPUs = v
	}
	if raw, ok := args["memoryMb"]; ok && raw != nil {
		v, ok := raw.(float64)
		if !ok || v != math.Trunc(v) || v > math.MaxInt32 {
			return l, fmt.Errorf("memoryMb must be a whole number of megabytes, at least %d, got %v", bgMemoryMBMin, raw)
		}
		l.MemoryMB = int64(v)
	}
	return l, l.validate()
}

// bgLimitsOffNote is what bg_run says to an ask on a runner whose owner has not turned limits on.
const bgLimitsOffNote = "Limits not applied: background job limits are off on this runner. Its owner turns them on in Settings → Machine."

// effectiveBgLimits is what a job runs under. Limits are off until the owner sets a ceiling: then no job
// has any, and an ask is answered with bgLimitsOffNote. Once on, each field is the agent's ask, unless
// the ceiling is lower or the agent asked for nothing. note says where an ask was lowered or dropped.
func effectiveBgLimits(asked, ceiling bgJobLimits) (limits bgJobLimits, note string) {
	if ceiling.none() {
		if !asked.none() {
			note = bgLimitsOffNote
		}
		return bgJobLimits{}, note
	}
	limits = asked
	var lowered []string
	if ceiling.CPUs > 0 && (asked.CPUs == 0 || asked.CPUs > ceiling.CPUs) {
		if asked.CPUs > 0 {
			lowered = append(lowered, "cpus")
		}
		limits.CPUs = ceiling.CPUs
	}
	if ceiling.MemoryMB > 0 && (asked.MemoryMB == 0 || asked.MemoryMB > ceiling.MemoryMB) {
		if asked.MemoryMB > 0 {
			lowered = append(lowered, "memoryMb")
		}
		limits.MemoryMB = ceiling.MemoryMB
	}
	if len(lowered) > 0 {
		note = fmt.Sprintf("%s lowered to this runner's ceiling (%s)", strings.Join(lowered, " and "), ceiling)
	}
	return limits, note
}

// runnerBgJobLimits is the owner's ceiling as the last heartbeat answer carried it; nil is off. A change
// applies to the next job; running jobs keep theirs.
var runnerBgJobLimits atomic.Pointer[bgJobLimits]

func runnerBgJobCeiling() bgJobLimits {
	if l := runnerBgJobLimits.Load(); l != nil {
		return *l
	}
	return bgJobLimits{}
}

// boundedLocked reports whether the job runs under limits, in its cgroup inside the jobs' parent. Such a
// job takes no session slot of this runner (backgroundJobCountsLocked): the parent bounds what all of them
// take together — a tenth of the sessions' CPU weight, half of the memory — however many there are and
// whatever each asked for. Caller holds bgTailer.mu, or is the only one to know the job.
func (j *bgJob) boundedLocked() bool {
	return j.limits != nil
}

// bgJobOOMNote is the line a job killed by its memory limit gets at the end of its output: the exit status
// alone (137) reads as any other SIGKILL.
func bgJobOOMNote(limits bgJobLimits) string {
	return fmt.Sprintf("\n[orbit] this job was killed: it reached its memory limit (%d MB)\n", limits.MemoryMB)
}

// endBgJobCgroup is what a job's end owes its cgroup: the OOM note in its output (to out, when there is
// one) if the kernel killed it for its memory, then the cgroup's removal.
func endBgJobCgroup(cg *bgJobCgroup, limits *bgJobLimits, out io.Writer) {
	if out != nil && limits != nil && limits.MemoryMB > 0 && cg.oomKilled() {
		_, _ = io.WriteString(out, bgJobOOMNote(*limits))
	}
	cg.remove()
}
