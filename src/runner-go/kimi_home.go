package main

// Per-session KIMI_CODE_HOME overlay.
//
// Kimi resolves its data root as KIMI_CODE_HOME, else ~/.kimi-code. Orbit needs a
// home directory it owns — runner-managed configuration must never be written into
// the user's own ~/.kimi-code, which their TUI is using. The overlay is a private
// per-session directory that symlinks the real home's identity, session store and
// caches back in, so the engine keeps one login and one history while Orbit owns the
// directory itself. Same idea as the per-session CODEX_HOME in codex_state.go.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// kimiHomeOverlayEntries are the real-home entries the overlay borrows: everything
// Kimi treats as durable user state. Entries come and go between Kimi versions, so a
// missing one is skipped rather than an error.
var kimiHomeOverlayEntries = []string{
	"credentials",
	"oauth",
	"sessions",
	"cache",
	"search-index",
	"user-history",
	"telemetry",
	"logs",
	"updates",
	"config.toml",
	"tui.toml",
	"region",
	"device_id",
	"migrations-effort.json",
	"session_index.jsonl",
	"workspaces.json",
}

// effectiveKimiHome resolves the real Kimi data root the overlay borrows from,
// mirroring effectiveCodexHome. The environment is passed in rather than read from the
// process so a test can supply its own home.
func effectiveKimiHome(env []string, cwd string) (string, error) {
	if home := strings.TrimSpace(envValue(env, "KIMI_CODE_HOME")); home != "" {
		return absoluteFrom(cwd, home)
	}
	home := strings.TrimSpace(envValue(env, "HOME"))
	if home == "" {
		home = userHome()
	}
	if home == "" {
		home = "."
	}
	return absoluteFrom(cwd, filepath.Join(home, ".kimi-code"))
}

// prepareKimiHomeOverlay builds this session's private Kimi home under its scratch dir
// and links the real home's state into it.
func prepareKimiHomeOverlay(scratchDir, realHome string) (string, error) {
	dir, err := filepath.Abs(filepath.Join(scratchDir, "kimi-home"))
	if err != nil {
		return "", err
	}
	// A resumed session reuses this scratch dir, so clear the previous run's links:
	// the overlay must describe the real home as it is now, not as it was.
	if err := removeKimiHomeOverlay(dir); err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, machineHomePerm); err != nil {
		return "", err
	}
	// MkdirAll applies the umask; the links inside reach credentials.
	if runtime.GOOS != "windows" {
		if err := os.Chmod(dir, machineHomePerm); err != nil {
			return "", err
		}
	}
	for _, name := range kimiHomeOverlayEntries {
		target := filepath.Join(realHome, name)
		// Lstat: a link in the real home is borrowed as it stands, and a dangling one
		// is skipped like any other absent entry.
		if _, err := os.Lstat(target); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return "", err
		}
		if err := os.Symlink(target, filepath.Join(dir, name)); err != nil {
			return "", err
		}
	}
	return dir, nil
}

// removeKimiHomeOverlay deletes the overlay and the links inside it. Entries are
// unlinked with os.Remove, which never follows the final symlink, so the real home's
// credentials and sessions are left untouched.
func removeKimiHomeOverlay(dir string) error {
	if strings.TrimSpace(dir) == "" {
		return nil
	}
	info, err := os.Lstat(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() {
		// A link where the overlay should be: unlink it, never descend through it.
		return os.Remove(dir)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		// DirEntry.IsDir is false for a symlink, so the recursive branch only ever
		// reaches a directory the engine itself created inside the overlay.
		if entry.IsDir() {
			err = os.RemoveAll(path)
		} else {
			err = os.Remove(path)
		}
		if err != nil {
			return err
		}
	}
	return os.Remove(dir)
}

// writeKimiHomeMCPConfig writes the overlay's mcp.json. Kimi reads this as its
// user-global MCP configuration, which here means this session's only: the home it
// sits in belongs to one session. It is the sole route left for a stdio server, since
// the engine rejects those as ACP session parameters (see kimiMCPServers).
//
// mcp.json is deliberately not among kimiHomeOverlayEntries. The file is Orbit's, not
// borrowed, so the user's own servers stay in the TUI they configured them for and the
// agent's MCP configuration is the whole of what the session sees.
func writeKimiHomeMCPConfig(dir string, servers map[string]interface{}) error {
	body, err := json.MarshalIndent(map[string]interface{}{"mcpServers": servers}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "mcp.json"), append(body, '\n'), 0o600)
}
