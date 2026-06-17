package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// RunnerConfig is the persisted credential + identity for this machine's runner.
// There is one runner per machine; its agents (project dirs + tools) live server-side.
type RunnerConfig struct {
	ServerURL     string   `json:"serverUrl"`
	RunnerID      string   `json:"runnerId"`
	RunnerToken   string   `json:"runnerToken"`
	Name          string   `json:"name"` // the machine runner name (its hostname)
	Labels        []string `json:"labels"`
	MaxConcurrent int      `json:"maxConcurrent"`
	// Fallback project directory for sessions whose agent carries no workDir. The
	// server normally drives claude's cwd per session from the session's agent.
	WorkDir string `json:"workDir,omitempty"`
}

// machineHome is where the runner stores its config + run scratch. One runner per
// machine, so it's a fixed per-user location: $ORBIT_HOME, else ~/.orbit.
func machineHome() string {
	if h := os.Getenv("ORBIT_HOME"); h != "" {
		return h
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".orbit")
	}
	return ".orbit"
}

func configPath() string { return filepath.Join(machineHome(), "config.json") }
func runsDir() string    { return filepath.Join(machineHome(), "runs") }

func loadConfig() *RunnerConfig {
	b, err := os.ReadFile(configPath())
	if err != nil {
		return nil
	}
	var c RunnerConfig
	if json.Unmarshal(b, &c) != nil {
		return nil
	}
	return &c
}

func saveConfig(c *RunnerConfig) error {
	if err := os.MkdirAll(machineHome(), 0o755); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(configPath(), b, 0o644)
}
