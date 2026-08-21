package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func assertPrivateMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("Windows does not expose Unix permission bits")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("%s permissions = %04o, want %04o", path, got, want)
	}
}

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

func TestRegisterHelpDescribesCurrentRunnerNaming(t *testing.T) {
	help := cmdHelp["register"]
	for _, want := range []string{
		"Its name defaults to the machine hostname",
		"can be changed with --name",
		"Workspaces are configured separately",
		"--name <name>            Runner name (default: machine hostname)",
	} {
		if !strings.Contains(help, want) {
			t.Fatalf("register help does not contain %q:\n%s", want, help)
		}
	}
	for _, stale := range []string{"Base name for the agents", "<name>/<agentkey>"} {
		if strings.Contains(help, stale) {
			t.Fatalf("register help still contains stale naming copy %q:\n%s", stale, help)
		}
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

func TestSaveConfigCreatesPrivateStorage(t *testing.T) {
	home := filepath.Join(t.TempDir(), "orbit")
	t.Setenv("ORBIT_HOME", home)
	if err := saveConfig(&RunnerConfig{RunnerToken: "secret"}); err != nil {
		t.Fatal(err)
	}
	assertPrivateMode(t, home, machineHomePerm)
	assertPrivateMode(t, filepath.Join(home, "config.json"), configFilePerm)
}

func TestSaveConfigMigratesLegacyPermissions(t *testing.T) {
	home := filepath.Join(t.TempDir(), "orbit")
	t.Setenv("ORBIT_HOME", home)
	if err := os.Mkdir(home, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, "config.json")
	if err := os.WriteFile(path, []byte(`{"runnerToken":"old"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	// Do not rely on the process umask to make the legacy permissions broad.
	if err := os.Chmod(home, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}

	if err := saveConfig(&RunnerConfig{RunnerToken: "new"}); err != nil {
		t.Fatal(err)
	}
	assertPrivateMode(t, home, machineHomePerm)
	assertPrivateMode(t, path, configFilePerm)
}

func TestLoadConfigDoesNotChangeAgentSelectedStorage(t *testing.T) {
	home := filepath.Join(t.TempDir(), "orbit")
	t.Setenv("ORBIT_HOME", home)
	if err := os.Mkdir(home, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, "config.json")
	if err := os.WriteFile(path, []byte(`{"runnerToken":"secret"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(home, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg := loadConfig()
	if cfg == nil || cfg.RunnerToken != "secret" {
		t.Fatalf("loadConfig = %+v, want migrated config", cfg)
	}
	// loadConfig is also used by agent-safe CLI commands. It must not chmod an
	// arbitrary ORBIT_HOME directory or file selected in the agent environment.
	assertPrivateMode(t, home, 0o755)
	assertPrivateMode(t, path, 0o644)
}

func TestLoadConfigMissingDoesNotChmodOrbitHome(t *testing.T) {
	home := filepath.Join(t.TempDir(), "agent-selected")
	if err := os.Mkdir(home, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(home, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ORBIT_HOME", home)
	if cfg := loadConfig(); cfg != nil {
		t.Fatalf("want nil for a missing config, got %+v", cfg)
	}
	assertPrivateMode(t, home, 0o755)
}

func TestHardenConfigStorageMigratesTrustedRunnerHome(t *testing.T) {
	home := filepath.Join(t.TempDir(), "orbit")
	if err := os.Mkdir(home, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(home, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, "config.json")
	if err := os.WriteFile(path, []byte(`{"runnerToken":"secret"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ORBIT_HOME", home)
	if err := hardenConfigStorage(); err != nil {
		t.Fatal(err)
	}
	assertPrivateMode(t, home, machineHomePerm)
	assertPrivateMode(t, path, configFilePerm)
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
