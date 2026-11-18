package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func conditionProbeFor(id, command, dir string) ConditionProbe {
	return ConditionProbe{ID: id, Command: command, CommandHash: conditionProbeCommandHash(command),
		TimeoutSeconds: 10, IntervalSeconds: 60, WorkDir: dir}
}

func skipConditionProbeShell(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("probes run with bash")
	}
}

// The runner declares condition-probe/v1 on every call, so the control plane knows it may list probes for it.
func TestConditionProbeCapabilityDeclared(t *testing.T) {
	if !strings.Contains(","+runnerCapabilitiesV1+",", ","+conditionProbeCapabilityV1+",") {
		t.Fatalf("the runner's capabilities %q omit %s", runnerCapabilitiesV1, conditionProbeCapabilityV1)
	}
	hello := strings.Join(linkHello("process-a").GetCapabilities(), ",")
	if !strings.Contains(","+hello+",", ","+conditionProbeCapabilityV1+",") {
		t.Fatalf("the link Hello's capabilities %q omit %s", hello, conditionProbeCapabilityV1)
	}
}

// A probe runs at once, then once per interval, never two at a time for one condition, and stops once it is no longer
// listed; an absent list changes nothing.
func TestConditionProbeInterval(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := newConditionProber(ctx)
	c.minInterval = 0
	var mu sync.Mutex
	var starts []time.Time
	var inFlight, maxInFlight int32
	c.exec = func(ctx context.Context, p ConditionProbe) (ConditionSample, bool) {
		n := atomic.AddInt32(&inFlight, 1)
		defer atomic.AddInt32(&inFlight, -1)
		for {
			m := atomic.LoadInt32(&maxInFlight)
			if n <= m || atomic.CompareAndSwapInt32(&maxInFlight, m, n) {
				break
			}
		}
		mu.Lock()
		starts = append(starts, time.Now())
		mu.Unlock()
		time.Sleep(300 * time.Millisecond)
		return ConditionSample{ConditionID: p.ID, At: time.Now(), Outcome: conditionOutcomeValue}, true
	}
	probes := []ConditionProbe{{ID: "c1", Command: "x", IntervalSeconds: 1}}
	c.reconcile(&probes)
	// Redelivered unchanged: the same loop goes on, not a second one.
	c.reconcile(&probes)
	time.Sleep(2500 * time.Millisecond)
	c.reconcile(nil)
	if !c.running()["c1"] {
		t.Fatal("an absent list stopped a probe")
	}
	c.reconcile(&[]ConditionProbe{})
	if c.running()["c1"] {
		t.Fatal("a probe no longer listed is still running")
	}
	time.Sleep(1200 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if len(starts) != 3 {
		t.Fatalf("got %d runs in 2.5s at a 1s interval (and none after it stopped), want 3", len(starts))
	}
	for i := 1; i < len(starts); i++ {
		if gap := starts[i].Sub(starts[i-1]); gap < 900*time.Millisecond || gap > 1500*time.Millisecond {
			t.Errorf("run %d came %s after the one before, want about 1s", i, gap)
		}
	}
	if maxInFlight != 1 {
		t.Errorf("%d runs of one condition overlapped", maxInFlight)
	}
	if got := len(c.take()); got != 3 {
		t.Errorf("%d samples queued, want 3", got)
	}
}

// A changed probe replaces its loop only after the old run has ended, so one condition never runs twice at once.
func TestConditionProbeIntervalChangedProbeWaitsForOldRun(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := newConditionProber(ctx)
	var inFlight, overlapped int32
	c.exec = func(ctx context.Context, p ConditionProbe) (ConditionSample, bool) {
		if atomic.AddInt32(&inFlight, 1) > 1 {
			atomic.StoreInt32(&overlapped, 1)
		}
		defer atomic.AddInt32(&inFlight, -1)
		select {
		case <-ctx.Done():
			time.Sleep(200 * time.Millisecond) // a command that takes a moment to die
			return ConditionSample{}, false
		case <-time.After(300 * time.Millisecond):
		}
		return ConditionSample{ConditionID: p.ID, Outcome: conditionOutcomeValue}, true
	}
	c.reconcile(&[]ConditionProbe{{ID: "c1", Command: "a", IntervalSeconds: 60}})
	time.Sleep(50 * time.Millisecond)
	c.reconcile(&[]ConditionProbe{{ID: "c1", Command: "b", IntervalSeconds: 60}})
	time.Sleep(700 * time.Millisecond)
	if overlapped != 0 {
		t.Fatal("the changed probe started while the old one still ran")
	}
	if got := c.take(); len(got) != 1 {
		t.Fatalf("got %d samples, want only the new probe's one (a stopped run reports nothing)", len(got))
	}
}

// The command runs with the shell in the workspace's directory, with the workspace's environment and no stdin; the
// number on the last non-empty line is the reading.
func TestConditionProbeIntervalRunsInWorkspace(t *testing.T) {
	skipConditionProbeShell(t)
	dir := t.TempDir()
	real, _ := filepath.EvalSymlinks(dir)
	command := `test "$(pwd -P)" = "` + real + `" || exit 3
read -r line && exit 4
echo "reading"
echo "$PROBE_NUMBER"
echo
`
	p := conditionProbeFor("c1", command, dir)
	p.Env = map[string]string{"PROBE_NUMBER": "87.5"}
	s, ok := runConditionProbe(context.Background(), p)
	if !ok || s.Outcome != conditionOutcomeValue || s.Value == nil || *s.Value != 87.5 {
		t.Fatalf("got %+v (ok %v), want VALUE 87.5", s, ok)
	}
	if s.ExitCode == nil || *s.ExitCode != 0 || s.ConditionID != "c1" || s.At.IsZero() {
		t.Fatalf("got %+v", s)
	}

	// A non-zero exit is EXIT with its code; a zero exit with no number is EXIT 0; stderr's end rides along.
	s, _ = runConditionProbe(context.Background(), conditionProbeFor("c1", "echo 5; echo oops >&2; exit 2", dir))
	if s.Outcome != conditionOutcomeExit || s.ExitCode == nil || *s.ExitCode != 2 || s.Value != nil || s.StderrTail != "oops\n" {
		t.Fatalf("got %+v, want EXIT 2 with stderr", s)
	}
	s, _ = runConditionProbe(context.Background(), conditionProbeFor("c1", "echo not a number", dir))
	if s.Outcome != conditionOutcomeExit || s.ExitCode == nil || *s.ExitCode != 0 || s.Value != nil {
		t.Fatalf("got %+v, want EXIT 0", s)
	}
	s, _ = runConditionProbe(context.Background(), conditionProbeFor("c1", "echo 1", filepath.Join(dir, "gone")))
	if s.Outcome != conditionOutcomeError || !strings.Contains(s.StderrTail, "is not a directory") {
		t.Fatalf("got %+v, want ERROR for a missing workspace directory", s)
	}
}

// A command whose hash differs from the approved one is refused: an ERROR sample saying so, and nothing run.
func TestConditionProbeHashMismatchRefused(t *testing.T) {
	skipConditionProbeShell(t)
	dir := t.TempDir()
	approved := "echo 1"
	p := conditionProbeFor("c1", "touch ran; echo 1", dir)
	p.CommandHash = conditionProbeCommandHash(approved)
	s, ok := runConditionProbe(context.Background(), p)
	if !ok || s.Outcome != conditionOutcomeError || s.Value != nil || s.ExitCode != nil {
		t.Fatalf("got %+v (ok %v), want ERROR", s, ok)
	}
	if !strings.Contains(s.StderrTail, "does not match the one the owner approved") {
		t.Fatalf("the sample does not say why: %q", s.StderrTail)
	}
	if _, err := os.Stat(filepath.Join(dir, "ran")); !os.IsNotExist(err) {
		t.Fatal("the refused command ran")
	}
	p.CommandHash = ""
	if s, _ := runConditionProbe(context.Background(), p); s.Outcome != conditionOutcomeError {
		t.Fatalf("a probe with no hash ran: %+v", s)
	}
	// The hash is compared without regard to case.
	p.CommandHash = strings.ToUpper(conditionProbeCommandHash(p.Command))
	if s, _ := runConditionProbe(context.Background(), p); s.Outcome != conditionOutcomeValue {
		t.Fatalf("the approved command was refused: %+v", s)
	}
}

// A command still running at its timeout is killed and read as TIMEOUT, even when a child holds its output open.
func TestConditionProbeTimeout(t *testing.T) {
	skipConditionProbeShell(t)
	dir := t.TempDir()
	p := conditionProbeFor("c1", "echo started >&2; (sleep 30; touch child-lived) & sleep 30; echo 1", dir)
	p.TimeoutSeconds = 1
	began := time.Now()
	s, ok := runConditionProbe(context.Background(), p)
	if took := time.Since(began); took > 8*time.Second {
		t.Fatalf("the probe took %s with a 1s timeout", took)
	}
	if !ok || s.Outcome != conditionOutcomeTimeout || s.Value != nil || s.ExitCode != nil {
		t.Fatalf("got %+v (ok %v), want TIMEOUT", s, ok)
	}
	if s.StderrTail != "started\n" {
		t.Errorf("stderr tail %q", s.StderrTail)
	}
	// A run stopped from outside (the probe is no longer listed) is no reading at all.
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(300 * time.Millisecond); cancel() }()
	p.TimeoutSeconds = 10
	if s, ok := runConditionProbe(ctx, p); ok {
		t.Fatalf("a stopped run reported %+v", s)
	}
}

// At most 64 KiB of stdout is kept (its tail, which holds the reading), and at most 500 bytes of stderr's end.
func TestConditionProbeOutputBound(t *testing.T) {
	w := &cappedTailWriter{limit: conditionProbeOutputMax}
	chunk := []byte(strings.Repeat("x", 10000))
	for i := 0; i < 100; i++ {
		_, _ = w.Write(chunk)
	}
	_, _ = w.Write([]byte("\n42\n"))
	if got := w.bytes(); len(got) != 64*1024 || !strings.HasSuffix(string(got), "\n42\n") {
		t.Fatalf("kept %d bytes, want 65536 ending in the last line", len(got))
	}

	skipConditionProbeShell(t)
	dir := t.TempDir()
	command := `head -c 5000000 /dev/zero | tr '\0' 'a'; echo; head -c 100000 /dev/zero | tr '\0' 'e' >&2; echo -n END >&2; echo 7`
	s, ok := runConditionProbe(context.Background(), conditionProbeFor("c1", command, dir))
	if !ok || s.Outcome != conditionOutcomeValue || s.Value == nil || *s.Value != 7 {
		t.Fatalf("got outcome %s value %v, want VALUE 7", s.Outcome, s.Value)
	}
	if len(s.StderrTail) > conditionProbeStderrMax || len(s.StderrTail) < 490 || !strings.HasSuffix(s.StderrTail, "END") {
		t.Fatalf("stderr tail is %d bytes ending %q, want at most 500 ending in END", len(s.StderrTail),
			s.StderrTail[max(0, len(s.StderrTail)-10):])
	}
	// The tail is cut on a rune boundary.
	s, _ = runConditionProbe(context.Background(), conditionProbeFor("c1", `for i in $(seq 300); do printf 'é' >&2; done; echo 1`, dir))
	if !strings.HasPrefix(s.StderrTail, "é") || len(s.StderrTail) > conditionProbeStderrMax {
		t.Fatalf("stderr tail %q is not whole runes within 500 bytes", s.StderrTail)
	}
}

// Every sample is reported in the next heartbeat as conditionSamples; a failed heartbeat keeps them, ahead of newer
// ones, for the one after, bounded at 200 per condition.
func TestConditionProbeSampleReport(t *testing.T) {
	c := newConditionProber(context.Background())
	v := 3.0
	at := time.Date(2026, 11, 17, 4, 0, 0, 0, time.UTC)
	c.enqueue(ConditionSample{ConditionID: "a", At: at, Outcome: conditionOutcomeValue, Value: &v})
	c.enqueue(ConditionSample{ConditionID: "b", At: at, Outcome: conditionOutcomeTimeout, StderrTail: "slow"})

	sent := c.take()
	body, err := json.Marshal(HeartbeatRequest{Status: "ONLINE", ConditionSamples: sent})
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		ConditionSamples []map[string]any `json:"conditionSamples"`
	}
	if err := json.Unmarshal(body, &wire); err != nil {
		t.Fatal(err)
	}
	if len(wire.ConditionSamples) != 2 {
		t.Fatalf("the heartbeat carries %s", body)
	}
	first := wire.ConditionSamples[0]
	if first["conditionId"] != "a" || first["outcome"] != "VALUE" || first["value"] != 3.0 || first["at"] != "2026-11-17T04:00:00Z" {
		t.Fatalf("first sample on the wire: %v", first)
	}
	if second := wire.ConditionSamples[1]; second["outcome"] != "TIMEOUT" || second["stderrTail"] != "slow" || second["value"] != nil {
		t.Fatalf("second sample on the wire: %v", second)
	}
	if len(c.take()) != 0 {
		t.Fatal("samples handed to a heartbeat are still queued")
	}
	// A heartbeat with none says nothing.
	if body, _ := json.Marshal(HeartbeatRequest{}); strings.Contains(string(body), "conditionSamples") {
		t.Fatalf("an empty heartbeat names conditionSamples: %s", body)
	}

	// The beat failed: its samples come back, ahead of what was read since.
	c.enqueue(ConditionSample{ConditionID: "a", At: at.Add(time.Minute), Outcome: conditionOutcomeExit})
	c.requeue(sent)
	again := c.take()
	if len(again) != 3 || again[0].ConditionID != "a" || again[0].Outcome != conditionOutcomeValue ||
		again[1].Outcome != conditionOutcomeExit || again[2].ConditionID != "b" {
		t.Fatalf("after a failed beat the next carries %+v", again)
	}

	// Bounded at 200 per condition, the oldest dropped; another condition keeps its own.
	for i := 0; i < 250; i++ {
		c.enqueue(ConditionSample{ConditionID: "a", At: at.Add(time.Duration(i) * time.Second), Outcome: conditionOutcomeValue})
	}
	c.requeue([]ConditionSample{{ConditionID: "a", At: at.Add(-time.Hour)}, {ConditionID: "b", At: at}})
	all := c.take()
	var forA []ConditionSample
	for _, s := range all {
		if s.ConditionID == "a" {
			forA = append(forA, s)
		}
	}
	if len(forA) != 200 || len(all) != 201 {
		t.Fatalf("kept %d samples of a and %d in all, want 200 and 201", len(forA), len(all))
	}
	if !forA[0].At.Equal(at.Add(50*time.Second)) || !forA[199].At.Equal(at.Add(249*time.Second)) {
		t.Fatalf("kept a's samples from %s to %s, want the newest 200", forA[0].At, forA[199].At)
	}
}

// The heartbeat answer's conditionProbes decode into the probes the loop runs; an answer without the field is absent,
// not empty.
func TestConditionProbeSampleReportResponseDecodes(t *testing.T) {
	var resp HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"conditionProbes":[{"id":"c1","command":"echo 1","commandHash":"h","timeoutSeconds":20,"intervalSeconds":300,"workDir":"/w","env":{"K":"V"}}]}`), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.ConditionProbes == nil || len(*resp.ConditionProbes) != 1 {
		t.Fatalf("decoded %+v", resp.ConditionProbes)
	}
	got := (*resp.ConditionProbes)[0]
	want := ConditionProbe{ID: "c1", Command: "echo 1", CommandHash: "h", TimeoutSeconds: 20, IntervalSeconds: 300, WorkDir: "/w", Env: map[string]string{"K": "V"}}
	if !conditionProbeSame(got, want) || got.ID != want.ID {
		t.Fatalf("decoded %+v", got)
	}
	var none HeartbeatResponse
	_ = json.Unmarshal([]byte(`{}`), &none)
	if none.ConditionProbes != nil {
		t.Fatal("an answer without conditionProbes decoded as a list")
	}
}
