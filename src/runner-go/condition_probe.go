package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"math"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Condition probes (docs/condition-triggers-design.md §4.1, §4.2). The control plane lists, in each heartbeat answer
// to a runner that declares condition-probe/v1, the conditions of this runner's workspaces; the runner runs each probe
// command on its interval and reports what it read in the next heartbeat. The runner runs; the server decides: nothing
// here judges whether a condition holds, so a runner that died reads as silence, never as "below the line".
const conditionProbeCapabilityV1 = "condition-probe/v1"

const (
	// conditionProbeOutputMax is the most of a probe's stdout kept: its tail, since the reading is its last line.
	conditionProbeOutputMax = 64 * 1024
	// conditionProbeStderrMax is how much of stderr's end a sample carries.
	conditionProbeStderrMax = 500
	// conditionSampleQueueMax is how many unsent samples are kept per condition; the oldest go first.
	conditionSampleQueueMax = 200
	// The bounds the design puts on a condition (§3), applied again here so a malformed answer cannot make a probe
	// spin or run unbounded.
	conditionProbeTimeoutDefault = 20 * time.Second
	conditionProbeTimeoutMax     = 60 * time.Second
	conditionProbeIntervalMin    = 60 * time.Second
)

// conditionProbeCommandHash is the hash the approved command is checked against: the SHA-256 of its exact text, in
// lowercase hex.
func conditionProbeCommandHash(command string) string {
	sum := sha256.Sum256([]byte(command))
	return hex.EncodeToString(sum[:])
}

// conditionProber holds one loop per listed probe and the samples not yet delivered.
type conditionProber struct {
	ctx context.Context
	// minInterval is conditionProbeIntervalMin in production; tests lower it.
	minInterval time.Duration
	// exec runs one probe; tests replace it.
	exec func(ctx context.Context, p ConditionProbe) (ConditionSample, bool)

	mu     sync.Mutex
	loops  map[string]*conditionProbeLoop
	queued map[string][]ConditionSample
	order  []string // condition ids in the order their first queued sample came
}

type conditionProbeLoop struct {
	probe  ConditionProbe
	cancel context.CancelFunc
	done   chan struct{}
}

func newConditionProber(ctx context.Context) *conditionProber {
	return &conditionProber{
		ctx:         ctx,
		minInterval: conditionProbeIntervalMin,
		exec:        runConditionProbe,
		loops:       map[string]*conditionProbeLoop{},
		queued:      map[string][]ConditionSample{},
	}
}

// reconcile starts a loop for each newly listed probe, restarts one whose definition changed, and stops one no longer
// listed. Absent (nil) states nothing and changes nothing: only a present list, empty included, is the full set.
func (c *conditionProber) reconcile(probes *[]ConditionProbe) {
	if probes == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	listed := map[string]bool{}
	for _, p := range *probes {
		if p.ID == "" {
			continue
		}
		listed[p.ID] = true
		old := c.loops[p.ID]
		if old != nil && conditionProbeSame(old.probe, p) {
			continue
		}
		var prev chan struct{}
		if old != nil {
			old.cancel()
			prev = old.done
		}
		c.loops[p.ID] = c.start(p, prev)
	}
	for id, loop := range c.loops {
		if !listed[id] {
			loop.cancel()
			delete(c.loops, id)
		}
	}
}

func conditionProbeSame(a, b ConditionProbe) bool {
	if a.Command != b.Command || a.CommandHash != b.CommandHash || a.TimeoutSeconds != b.TimeoutSeconds ||
		a.IntervalSeconds != b.IntervalSeconds || a.WorkDir != b.WorkDir || len(a.Env) != len(b.Env) {
		return false
	}
	for k, v := range a.Env {
		if w, ok := b.Env[k]; !ok || w != v {
			return false
		}
	}
	return true
}

// start runs a probe at once and then on its interval. A replaced loop's run is killed first and waited for (prev), so
// one condition never has two commands running.
func (c *conditionProber) start(p ConditionProbe, prev <-chan struct{}) *conditionProbeLoop {
	ctx, cancel := context.WithCancel(c.ctx)
	loop := &conditionProbeLoop{probe: p, cancel: cancel, done: make(chan struct{})}
	interval := time.Duration(p.IntervalSeconds) * time.Second
	if interval < c.minInterval {
		interval = c.minInterval
	}
	go func() {
		defer close(loop.done)
		if prev != nil {
			<-prev
		}
		// The loop is sequential: a run still going when the next tick comes makes the ticker drop that tick.
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			if ctx.Err() != nil {
				return
			}
			if sample, ok := c.exec(ctx, p); ok && ctx.Err() == nil {
				c.enqueue(sample)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return loop
}

func (c *conditionProber) enqueue(s ConditionSample) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.queueLocked([]ConditionSample{s}, false)
}

// queueLocked adds samples to their conditions' queues, behind what is queued or (front) ahead of it, and keeps the
// newest conditionSampleQueueMax of each.
func (c *conditionProber) queueLocked(samples []ConditionSample, front bool) {
	byID := map[string][]ConditionSample{}
	var ids []string
	for _, s := range samples {
		if _, ok := byID[s.ConditionID]; !ok {
			ids = append(ids, s.ConditionID)
		}
		byID[s.ConditionID] = append(byID[s.ConditionID], s)
	}
	for _, id := range ids {
		q, had := c.queued[id]
		if front {
			q = append(append([]ConditionSample(nil), byID[id]...), q...)
		} else {
			q = append(q, byID[id]...)
		}
		if over := len(q) - conditionSampleQueueMax; over > 0 {
			q = append([]ConditionSample(nil), q[over:]...)
		}
		c.queued[id] = q
		if !had {
			c.order = append(c.order, id)
		}
	}
}

// take hands over every queued sample for a heartbeat, oldest first per condition. A heartbeat that fails gives them
// back with requeue.
func (c *conditionProber) take() []ConditionSample {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []ConditionSample
	for _, id := range c.order {
		out = append(out, c.queued[id]...)
	}
	c.queued = map[string][]ConditionSample{}
	c.order = nil
	return out
}

// requeue puts back the samples of a heartbeat that failed, ahead of any read since.
func (c *conditionProber) requeue(samples []ConditionSample) {
	if len(samples) == 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.queueLocked(samples, true)
}

// running reports the ids of the probes with a loop, for tests.
func (c *conditionProber) running() map[string]bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := map[string]bool{}
	for id := range c.loops {
		out[id] = true
	}
	return out
}

// runConditionProbe runs one probe and says what it read. ok is false when the run was stopped (the probe was no
// longer listed, or the runner is shutting down): that is no reading, so nothing is reported.
func runConditionProbe(ctx context.Context, p ConditionProbe) (ConditionSample, bool) {
	sample := ConditionSample{ConditionID: p.ID, At: time.Now().UTC()}
	fail := func(reason string) (ConditionSample, bool) {
		sample.Outcome = conditionOutcomeError
		sample.StderrTail = reason
		return sample, true
	}
	if !strings.EqualFold(strings.TrimSpace(p.CommandHash), conditionProbeCommandHash(p.Command)) {
		return fail("The probe command does not match the one the owner approved, so it was not run.")
	}
	dir := expandTilde(p.WorkDir)
	if info, err := os.Stat(dir); p.WorkDir == "" || err != nil || !info.IsDir() {
		return fail("The workspace directory " + strconv.Quote(p.WorkDir) + " is not a directory on this runner, so the probe was not run.")
	}
	timeout := time.Duration(p.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = conditionProbeTimeoutDefault
	}
	if timeout > conditionProbeTimeoutMax {
		timeout = conditionProbeTimeoutMax
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(runCtx, "bash", "-lc", p.Command)
	configureSessionProcessTree(cmd)
	cmd.Dir = dir
	cmd.Env = envWithAgent(p.Env)
	cmd.Stdin = nil // reads from the null device
	stdout := &cappedTailWriter{limit: conditionProbeOutputMax}
	stderr := &cappedTailWriter{limit: conditionProbeStderrMax}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	err := cmd.Start()
	if err == nil {
		err = waitSessionProcessTree(cmd)
	}
	if ctx.Err() != nil {
		return sample, false
	}
	sample.StderrTail = string(cappedUTF8Tail(stderr.bytes(), conditionProbeStderrMax))
	if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		sample.Outcome = conditionOutcomeTimeout
		return sample, true
	}
	var exitErr *exec.ExitError
	switch {
	case errors.As(err, &exitErr):
		code := exitErr.ExitCode()
		sample.Outcome, sample.ExitCode = conditionOutcomeExit, &code
		return sample, true
	case err != nil:
		return fail("The probe command could not be started: " + err.Error())
	}
	code := 0
	sample.ExitCode = &code
	if v, ok := conditionProbeValue(stdout.bytes()); ok {
		sample.Outcome, sample.Value = conditionOutcomeValue, &v
	} else {
		sample.Outcome = conditionOutcomeExit
	}
	return sample, true
}

// conditionProbeValue is the number on the last non-empty line of stdout.
func conditionProbeValue(stdout []byte) (float64, bool) {
	lines := strings.Split(string(stdout), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		v, err := strconv.ParseFloat(line, 64)
		if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
			return 0, false
		}
		return v, true
	}
	return 0, false
}

// cappedTailWriter keeps the last limit bytes written to it and discards the rest, so a probe that floods its output
// costs no more memory than the limit.
type cappedTailWriter struct {
	mu    sync.Mutex
	limit int
	tail  []byte
}

func (w *cappedTailWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.tail = appendCappedTail(w.tail, p, w.limit)
	return len(p), nil
}

func (w *cappedTailWriter) bytes() []byte {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]byte(nil), w.tail...)
}
