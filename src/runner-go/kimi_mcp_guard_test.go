package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestKimiFindProjectRootUsesNearestGitAncestor(t *testing.T) {
	top := t.TempDir()
	outer := filepath.Join(top, "outer")
	inner := filepath.Join(outer, "inner")
	cwd := filepath.Join(inner, "src", "pkg")
	for _, dir := range []string{outer, inner, cwd} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(outer, ".git"), []byte("gitdir: elsewhere\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(inner, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := kimiFindProjectRoot(filepath.Join(cwd, "."))
	if err != nil {
		t.Fatal(err)
	}
	if got != inner {
		t.Fatalf("kimiFindProjectRoot() = %q, want nearest root %q", got, inner)
	}
}

func TestKimiFindProjectRootFallsBackToCWD(t *testing.T) {
	cwd := filepath.Join(t.TempDir(), "not-a-repo", "nested")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := kimiFindProjectRootWithStat(
		filepath.Join(cwd, "."),
		func(string) (os.FileInfo, error) { return nil, os.ErrNotExist },
	)
	if err != nil {
		t.Fatal(err)
	}
	if got != cwd {
		t.Fatalf("kimiFindProjectRoot() = %q, want cwd %q", got, cwd)
	}
}

func TestKimiProjectMCPPathsMatchUpstreamDiscovery(t *testing.T) {
	root := t.TempDir()
	cwd := filepath.Join(root, "nested", "work")
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := kimiProjectMCPPaths(cwd)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		filepath.Join(root, ".mcp.json"),
		filepath.Join(cwd, ".kimi-code", "mcp.json"),
	}
	if len(got) != len(want) {
		t.Fatalf("kimiProjectMCPPaths() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("kimiProjectMCPPaths()[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestGuardKimiProjectMCPAllowsWorkspaceWithoutConfig(t *testing.T) {
	root := t.TempDir()
	cwd := filepath.Join(root, "nested")
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := guardKimiProjectMCP(cwd); err != nil {
		t.Fatalf("guardKimiProjectMCP() error = %v", err)
	}
}

func TestGuardKimiProjectMCPRejectsEveryProjectCandidate(t *testing.T) {
	for _, test := range []struct {
		name       string
		configPath func(root, cwd string) string
	}{
		{
			name: "root dot mcp",
			configPath: func(root, _ string) string {
				return filepath.Join(root, ".mcp.json")
			},
		},
		{
			name: "cwd kimi code mcp",
			configPath: func(_, cwd string) string {
				return filepath.Join(cwd, ".kimi-code", "mcp.json")
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			cwd := filepath.Join(root, "nested")
			if err := os.MkdirAll(filepath.Join(root, ".git"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(cwd, 0o755); err != nil {
				t.Fatal(err)
			}
			configPath := test.configPath(root, cwd)
			if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(configPath, []byte(`{"mcpServers":{}}`), 0o644); err != nil {
				t.Fatal(err)
			}

			err := guardKimiProjectMCP(cwd)
			if err == nil {
				t.Fatal("guardKimiProjectMCP() error = nil, want fail-closed rejection")
			}
			if !strings.Contains(err.Error(), configPath) {
				t.Fatalf("guardKimiProjectMCP() error = %q, want offending path %q", err, configPath)
			}
		})
	}
}

func TestGuardKimiProjectMCPRejectsDanglingConfigLink(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(root, ".mcp.json")
	if err := os.Symlink(filepath.Join(root, "missing-config"), configPath); err != nil {
		t.Fatal(err)
	}

	err := guardKimiProjectMCP(root)
	if err == nil {
		t.Fatal("guardKimiProjectMCP() error = nil, want fail-closed link rejection")
	}
	if !strings.Contains(err.Error(), configPath) {
		t.Fatalf("guardKimiProjectMCP() error = %q, want uninspectable path %q", err, configPath)
	}
}

func TestGuardKimiProjectMCPIgnoresOtherProjectLocalLocations(t *testing.T) {
	root := t.TempDir()
	cwd := filepath.Join(root, "nested", "work")
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	// Kimi only checks <cwd>/.kimi-code/mcp.json, not the same path on each
	// ancestor between cwd and the project root.
	other := filepath.Join(root, ".kimi-code", "mcp.json")
	if err := os.MkdirAll(filepath.Dir(other), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(other, []byte(`{"mcpServers":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := guardKimiProjectMCP(cwd); err != nil {
		t.Fatalf("guardKimiProjectMCP() error = %v", err)
	}
}
