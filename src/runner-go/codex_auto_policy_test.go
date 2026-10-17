package main

import (
	"path/filepath"
	"reflect"
	"testing"
)

// TestCodexSandboxPolicy: Auto is the one mode with a workspaceWrite sandbox, and its writable
// roots are the two session directories, the linked worktree's shared .git metadata and the
// runner-owned cache root the session's Go and npm caches live in. Every other mode stays
// dangerFullAccess and states no roots at all.
func TestCodexSandboxPolicy(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	cacheRoot := filepath.Join(home, "caches")
	worktree := &ClaimedSession{WT: &Worktree{RepoDir: "/repo-root"}}
	for _, tc := range []struct {
		name, mode string
		job        *ClaimedSession
		wantType   string
		wantRoots  []string
	}{
		{
			name: "auto with a linked worktree", mode: "auto", job: worktree, wantType: "workspaceWrite",
			wantRoots: []string{"/repo", "/tmp/uploads", "/repo-root/.git", cacheRoot},
		},
		{
			name: "auto without a worktree", mode: "auto", wantType: "workspaceWrite",
			wantRoots: []string{"/repo", "/tmp/uploads", cacheRoot},
		},
		{name: "default", mode: "default", wantType: "dangerFullAccess"},
		{name: "plan", mode: "plan", wantType: "dangerFullAccess"},
		{name: "dontAsk", mode: "dontAsk", wantType: "dangerFullAccess"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			policy := codexSandboxPolicy(tc.mode, tc.job, "/repo", "/tmp/uploads")
			if policy["type"] != tc.wantType {
				t.Fatalf("type = %v, want %s", policy["type"], tc.wantType)
			}
			if tc.wantType != "workspaceWrite" {
				if len(policy) != 1 {
					t.Fatalf("policy = %#v, want only its type outside Auto", policy)
				}
				return
			}
			if policy["networkAccess"] != false || len(policy) != 3 {
				t.Fatalf("policy = %#v, want workspaceWrite with network disabled and roots", policy)
			}
			if roots, _ := policy["writableRoots"].([]string); !reflect.DeepEqual(roots, tc.wantRoots) {
				t.Fatalf("writableRoots = %#v, want %#v", policy["writableRoots"], tc.wantRoots)
			}
			// The same roots are what a turn states, so Codex's own path checks agree with the
			// sandbox it enforces.
			if roots := codexRuntimeWorkspaceRoots(tc.mode, tc.job, "/repo", "/tmp/uploads"); !reflect.DeepEqual(roots, tc.wantRoots) {
				t.Fatalf("runtimeWorkspaceRoots = %#v, want %#v", roots, tc.wantRoots)
			}
		})
	}
}
