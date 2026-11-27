package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// The engines are asked at once, not one after another: three CLIs that each take a second to say their version are
// probed in about a second, and the reports keep the order of the specs. A managed runner's first heartbeat waits for
// this probe (managedStartupBeat), and asked one after another it went 8–10 s after the runner's start in production.
func TestProbeEnginesAsksEveryEngineAtOnce(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script CLIs")
	}
	dir := t.TempDir()
	names := []string{"slow-a", "slow-b", "slow-c"}
	var specs []engineSpec
	for _, name := range names {
		script := "#!/bin/sh\nsleep 1\necho " + name + " 1.0.0\n"
		if err := os.WriteFile(filepath.Join(dir, name), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
		specs = append(specs, engineSpec{name: name, bin: name})
	}
	started := time.Now()
	reports, timings := probeEnginesTimed(specs, dir)
	elapsed := time.Since(started)
	if elapsed > 2500*time.Millisecond {
		t.Fatalf("three one-second CLIs were probed in %s: one after another, not at once", elapsed)
	}
	if len(reports) != len(names) {
		t.Fatalf("%d reports, want %d", len(reports), len(names))
	}
	for i, name := range names {
		if reports[i].Engine != name || !reports[i].Installed || reports[i].Version != name+" 1.0.0" {
			t.Fatalf("report %d = %+v, want %s installed at its version, in the specs' order", i, reports[i], name)
		}
		// Each engine's own time is its CLI's second, not the whole probe's, and none of them has accounts to ask.
		if timings[i].total < time.Second || timings[i].total > elapsed || timings[i].accounts != 0 {
			t.Fatalf("timing %d = %+v, want about a second of the %s probe and no accounts", i, timings[i], elapsed)
		}
	}
}

// The first probe's line names the whole probe's time and each engine's, with the part spent on added accounts where
// there was one, in the specs' order.
func TestEngineProbeTimingLine(t *testing.T) {
	specs := []engineSpec{{bin: "claude"}, {bin: "kimi"}, {bin: "codex"}}
	timings := []engineProbeTiming{
		{total: 412345 * time.Microsecond},
		{total: 6*time.Second + 2*time.Millisecond, accounts: 5*time.Second + 400*time.Microsecond},
		{total: 30 * time.Millisecond, accounts: 300 * time.Microsecond},
	}
	got := engineProbeTimingLine(6100*time.Millisecond, specs, timings)
	want := "engine probe: first answer in 6.1s: claude 412ms, kimi 6.002s (accounts 5s), codex 30ms"
	if got != want {
		t.Fatalf("line = %q\nwant   %q", got, want)
	}
}
