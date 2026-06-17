package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaultRunnerNameIsHostname(t *testing.T) {
	// The runner defaults to the machine hostname — non-empty, no '/' suffix.
	name := defaultRunnerName()
	if got, want := name, hostnameOr(); got != want {
		t.Fatalf("defaultRunnerName = %q, want %q (hostname)", got, want)
	}
	if name == "" || strings.ContainsAny(name, " /") {
		t.Fatalf("runner name must be non-empty with no space or '/': %q", name)
	}
}

func TestMachineHomeHonorsOrbitHome(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("ORBIT_HOME", tmp)
	if got := machineHome(); got != tmp {
		t.Fatalf("machineHome = %q, want %q (ORBIT_HOME)", got, tmp)
	}
	if got, want := configPath(), filepath.Join(tmp, "config.json"); got != want {
		t.Fatalf("configPath = %q, want %q", got, want)
	}
}

func TestMachineHomeDefaultsToHomeOrbit(t *testing.T) {
	t.Setenv("ORBIT_HOME", "")
	home := t.TempDir()
	t.Setenv("HOME", home)
	if got, want := machineHome(), filepath.Join(home, ".orbit"); got != want {
		t.Fatalf("machineHome = %q, want %q", got, want)
	}
}

func TestSaveLoadConfigRoundTrip(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	in := &RunnerConfig{
		ServerURL: "https://example", RunnerID: "r1", RunnerToken: "tok",
		Name: "CPXG6GM7K4", Labels: []string{"sg"}, MaxConcurrent: 4, WorkDir: "/proj",
	}
	if err := saveConfig(in); err != nil {
		t.Fatal(err)
	}
	out := loadConfig()
	if out == nil {
		t.Fatal("loadConfig returned nil")
	}
	if out.Name != in.Name || out.RunnerID != "r1" || out.WorkDir != "/proj" || out.MaxConcurrent != 4 {
		t.Fatalf("round-trip mismatch: %+v", out)
	}
}

func TestLoadConfigMissingReturnsNil(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	if cfg := loadConfig(); cfg != nil {
		t.Fatalf("want nil for a missing config, got %+v", cfg)
	}
}

func TestServiceNames(t *testing.T) {
	// One runner per machine -> a single fixed service name (no per-agent suffix).
	if systemdService != "orbit-runner" {
		t.Errorf("systemdService = %q, want orbit-runner", systemdService)
	}
	if launchdLabel != "com.orbit.runner" {
		t.Errorf("launchdLabel = %q, want com.orbit.runner", launchdLabel)
	}
}
