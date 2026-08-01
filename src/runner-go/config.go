package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	machineHomePerm os.FileMode = 0o700
	configFilePerm  os.FileMode = 0o600
)

// expandTilde resolves a leading ~ or ~/ to the running user's home directory.
// An agent's workDir (from the server) or the config's workDir may be written
// with a tilde; Go's exec/chdir does not expand it, so we do it here.
func expandTilde(p string) string {
	if p != "~" && !strings.HasPrefix(p, "~/") {
		return p
	}
	home := userHome()
	if home == "" {
		return p
	}
	if p == "~" {
		return home
	}
	return filepath.Join(home, p[2:])
}

// userHome resolves the home dir even when $HOME is unset — e.g. a systemd service
// with no User= and no Environment=HOME. os.UserHomeDir reads $HOME only, so fall
// back to the account database (getpwuid) via os/user, matching how Node's
// os.homedir() (which claude uses) behaves. Without this, a tilde workDir would
// silently chdir to the literal "~/...", which fails ("no such file or directory").
func userHome() string {
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		return h
	}
	if u, err := user.Current(); err == nil && u.HomeDir != "" {
		return u.HomeDir
	}
	return ""
}

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
	// AutoInstallEngines is the consent `orbit register` asks for once: may this runner
	// install a missing coding CLI itself, the first time a session needs one? Absent in
	// an older config reads as "no" — a background service must not start installing
	// software on someone's machine unasked.
	AutoInstallEngines bool `json:"autoInstallEngines,omitempty"`
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
	// This is intentionally read-only. ORBIT_HOME is inherited by agent shells,
	// so an agent-safe command must not chmod an arbitrary environment-selected
	// path merely by trying to load config. Trusted runner startup/save paths call
	// hardenConfigStorage to create or migrate the private modes.
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

// configStoragePrivate verifies that using the owner-wide runner token from an
// agent-invoked CLI cannot expose it to another local account. It never mutates
// the environment-selected path; trusted runner startup/save paths perform the
// one-time migration via hardenConfigStorage.
func configStoragePrivate() error {
	if runtime.GOOS == "windows" {
		return nil
	}
	dirInfo, err := os.Lstat(machineHome())
	if err != nil {
		return err
	}
	if dirInfo.Mode()&os.ModeSymlink != 0 || !dirInfo.IsDir() {
		return fmt.Errorf("%s is not a private directory", machineHome())
	}
	if dirInfo.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("%s has permissions %04o, want 0700", machineHome(), dirInfo.Mode().Perm())
	}
	fileInfo, err := os.Lstat(configPath())
	if err != nil {
		return err
	}
	if fileInfo.Mode()&os.ModeSymlink != 0 || !fileInfo.Mode().IsRegular() {
		return fmt.Errorf("%s is not a private regular file", configPath())
	}
	if fileInfo.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("%s has permissions %04o, want 0600", configPath(), fileInfo.Mode().Perm())
	}
	return nil
}

func hardenMachineHomeDir() error {
	return os.Chmod(machineHome(), machineHomePerm)
}

func hardenConfigStorage() error {
	if err := hardenMachineHomeDir(); err != nil {
		return err
	}
	f, err := os.Open(configPath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if err := f.Chmod(configFilePerm); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

func saveConfig(c *RunnerConfig) error {
	if err := os.MkdirAll(machineHome(), machineHomePerm); err != nil {
		return err
	}
	// MkdirAll and OpenFile do not update permissions when their targets already
	// exist, so explicitly migrate legacy installations on every save.
	if err := hardenMachineHomeDir(); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.OpenFile(configPath(), os.O_WRONLY|os.O_CREATE, configFilePerm)
	if err != nil {
		return err
	}
	// Change the mode on the opened file before truncating it. Besides avoiding
	// a path race, this leaves an existing config intact if its mode cannot be
	// secured.
	if err := f.Chmod(configFilePerm); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Truncate(0); err != nil {
		_ = f.Close()
		return err
	}
	n, err := f.Write(b)
	if err != nil {
		_ = f.Close()
		return err
	}
	if n != len(b) {
		_ = f.Close()
		return io.ErrShortWrite
	}
	return f.Close()
}
