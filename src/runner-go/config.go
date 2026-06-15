package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// RunnerConfig is the persisted credential + identity for one runner.
type RunnerConfig struct {
	ServerURL     string   `json:"serverUrl"`
	RunnerID      string   `json:"runnerId"`
	RunnerToken   string   `json:"runnerToken"`
	Name          string   `json:"name"`
	Labels        []string `json:"labels"`
	MaxConcurrent int      `json:"maxConcurrent"`
	// Agents installed on this machine that the user chose to register
	// (stable keys, e.g. "claude", "codex"). Selected at `orbit register`.
	Agents []string `json:"agents,omitempty"`
}

// Config is per working directory (so one machine can host several runners);
// ORBIT_HOME overrides it (used by the systemd unit / launchd plist).
func baseDir() string {
	if h := os.Getenv("ORBIT_HOME"); h != "" {
		return h
	}
	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}
	return filepath.Join(cwd, ".orbit")
}

func configPath() string { return filepath.Join(baseDir(), "config.json") }
func runsDir() string     { return filepath.Join(baseDir(), "runs") }

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
	if err := os.MkdirAll(baseDir(), 0o755); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(configPath(), b, 0o644)
}
