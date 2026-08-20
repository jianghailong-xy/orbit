package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// guardKimiProjectMCP refuses to start Kimi when it could discover MCP
// configuration supplied by the checkout. Kimi starts project MCP servers
// while creating a session, before Orbit can apply its normal per-tool policy,
// so merely allowing these files to be loaded could execute an arbitrary local
// command.
//
// This intentionally does not inspect Kimi's user-global mcp.json. That file is
// runner-owned configuration rather than content from the opened workspace.
func guardKimiProjectMCP(cwd string) error {
	paths, err := kimiProjectMCPPaths(cwd)
	if err != nil {
		return fmt.Errorf("cannot safely inspect Kimi project MCP configuration: %w", err)
	}

	for _, path := range paths {
		// Lstat also rejects dangling links. Treating every directory entry as
		// project configuration avoids an allow/check race through a link whose
		// target is created just before Kimi reads it.
		_, err := os.Lstat(path)
		switch {
		case err == nil:
			return fmt.Errorf("refusing to start Kimi ACP: project MCP configuration %q may launch commands outside Orbit's policy", path)
		case errors.Is(err, os.ErrNotExist):
			continue
		default:
			return fmt.Errorf("cannot safely inspect Kimi project MCP configuration %q: %w", path, err)
		}
	}

	return nil
}

// kimiProjectMCPPaths mirrors Kimi's project MCP path resolution: a
// project-root .mcp.json plus a .kimi-code/mcp.json under the session cwd.
func kimiProjectMCPPaths(cwd string) ([]string, error) {
	projectRoot, err := kimiFindProjectRoot(cwd)
	if err != nil {
		return nil, err
	}
	cleanCWD := filepath.Clean(cwd)
	return []string{
		filepath.Join(projectRoot, ".mcp.json"),
		filepath.Join(cleanCWD, ".kimi-code", "mcp.json"),
	}, nil
}

// kimiFindProjectRoot mirrors Kimi Code's findProjectRoot: normalize cwd, walk
// upward to the nearest .git marker, and fall back to the original cwd when no
// marker exists.
func kimiFindProjectRoot(cwd string) (string, error) {
	return kimiFindProjectRootWithStat(cwd, os.Stat)
}

func kimiFindProjectRootWithStat(
	cwd string,
	stat func(string) (os.FileInfo, error),
) (string, error) {
	start := filepath.Clean(cwd)
	current := start

	for {
		_, err := stat(filepath.Join(current, ".git"))
		switch {
		case err == nil:
			return current, nil
		case !errors.Is(err, os.ErrNotExist):
			return "", fmt.Errorf("inspect %q: %w", filepath.Join(current, ".git"), err)
		}

		parent := filepath.Dir(current)
		if parent == current {
			return start, nil
		}
		current = parent
	}
}
