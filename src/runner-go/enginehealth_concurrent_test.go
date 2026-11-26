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
	reports := probeEngines(specs, dir)
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
	}
}
