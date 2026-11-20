package main

import (
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"strconv"
	"strings"
)

// CPU and memory limits on runner-hosted background jobs (bg_run). The machine's owner sets a ceiling for
// this runner (`orbit bg-limits`, kept in config.json); it is every job's limit, and an agent may ask bg_run
// for less, never for more. On Linux each limited job runs in a cgroup v2 of its own (bg_cgroup_linux.go):
// cpu.max throttles it to its CPUs, and past memory.max the kernel kills the whole job, not the runner or the
// session beside it. Where that cannot be done — macOS, a runner unit without Delegate=yes, a container — the
// job still runs, and bg_run says the limit was not applied rather than leaving the agent to believe it was.
//
// A limit is resource management, not a security boundary: a job runs as the runner's own user, who owns
// the delegated cgroup and the config alike.

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

// effectiveBgLimits is what a job runs under: in each field the agent's ask, unless the runner's ceiling
// is lower or the agent asked for nothing. note says where an ask was lowered.
func effectiveBgLimits(asked, ceiling bgJobLimits) (limits bgJobLimits, note string) {
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

// runnerBgJobCeiling is the owner's ceiling, read from config.json on every job so a change applies to the
// next job without a restart.
var runnerBgJobCeiling = func() bgJobLimits {
	if cfg := loadConfig(); cfg != nil && cfg.BackgroundJobLimits != nil {
		return *cfg.BackgroundJobLimits
	}
	return bgJobLimits{}
}

const bgLimitsHelp = `orbit bg-limits — limit the CPU and memory of this runner's background jobs

Usage:
  orbit bg-limits                              Show the limits
  orbit bg-limits [--cpus N] [--memory SIZE]   Set them
  orbit bg-limits --clear                      Remove them

The limits apply to every background job an agent starts on this machine with bg_run, each job on
its own: --cpus 2 lets a job use two CPUs' worth of time, --memory 8G lets it hold 8 GiB, and past
that the kernel ends the whole job. An agent may ask bg_run for less, never for more. A change
applies to the next job; running jobs keep theirs.

They are enforced with Linux cgroup v2, which needs the runner's systemd unit to carry Delegate=yes
('orbit register' and 'orbit host setup' write it; reinstall the service of a runner set up
before). Where they cannot be enforced, jobs still run, and bg_run says the limits were not applied.

Options:
  --cpus N         CPUs per job, fractions allowed (0.5, 2, 6)
  --memory SIZE    Memory per job: a number of megabytes, or with a unit, M or G (512M, 8G)
  --clear          Remove both limits
`

// cmdBgLimits is `orbit bg-limits`. It is the owner's: a session's agent, which runs as the same user, is
// refused, so that the ceiling is not raised by what it bounds.
func cmdBgLimits(args []string, out io.Writer) error {
	if os.Getenv("ORBIT_SESSION_ID") != "" {
		return errors.New("the background job limits are the machine owner's to set; run this outside an Orbit session")
	}
	fs := newCLIFlagSet("orbit bg-limits")
	cpus := fs.Float64("cpus", 0, "CPUs per job")
	memory := fs.String("memory", "", "memory per job")
	clear := fs.Bool("clear", false, "remove both limits")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	cfg := loadConfig()
	if cfg == nil {
		return errors.New("no runner config found — run `orbit register` first")
	}
	limits := bgJobLimits{}
	if cfg.BackgroundJobLimits != nil && !*clear {
		limits = *cfg.BackgroundJobLimits
	}
	changed := *clear
	if flagWasSet(fs, "cpus") {
		limits.CPUs, changed = *cpus, true
	}
	if flagWasSet(fs, "memory") {
		mb, err := parseMemoryMB(*memory)
		if err != nil {
			return err
		}
		limits.MemoryMB, changed = mb, true
	}
	if err := limits.validate(); err != nil {
		return err
	}
	if changed {
		cfg.BackgroundJobLimits = &limits
		if limits.none() {
			cfg.BackgroundJobLimits = nil
		}
		if err := saveConfig(cfg); err != nil {
			return err
		}
	}
	_, err := fmt.Fprintf(out, "background job limits: %s\n", limits)
	return err
}

// parseMemoryMB reads --memory: megabytes, or a number with an M or G suffix. 0 is no limit.
func parseMemoryMB(s string) (int64, error) {
	t := strings.ToUpper(strings.TrimSpace(s))
	mult := 1.0
	for _, unit := range []struct {
		suffix string
		mult   float64
	}{{"GIB", 1024}, {"GB", 1024}, {"G", 1024}, {"MIB", 1}, {"MB", 1}, {"M", 1}} {
		if rest, ok := strings.CutSuffix(t, unit.suffix); ok {
			t, mult = rest, unit.mult
			break
		}
	}
	v, err := strconv.ParseFloat(t, 64)
	if err != nil || v < 0 || v*mult > math.MaxInt32 {
		return 0, fmt.Errorf("--memory must be megabytes or a size like 512M or 8G, got %q", s)
	}
	return int64(math.Round(v * mult)), nil
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
