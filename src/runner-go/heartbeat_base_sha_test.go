package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestHeartbeatReportsHealedBaseWithMatchingDiff(t *testing.T) {
	repo := initRepo(t)
	oldBase := mustGit(t, repo, "rev-parse", "HEAD")
	branch := "orbit/healed-heartbeat"
	mustGit(t, repo, "checkout", "-b", branch)
	commitFile(t, repo, "landed.txt", "landed\n", "landed work")
	landedTip := mustGit(t, repo, "rev-parse", "HEAD")
	mustGit(t, repo, "checkout", "main")
	mustGit(t, repo, "merge", "--ff-only", branch)

	checkout := filepath.Join(t.TempDir(), "session-worktree")
	mustGit(t, repo, "worktree", "add", checkout, branch)
	if err := os.WriteFile(filepath.Join(checkout, "new.txt"), []byte("new work\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	wt := &Worktree{
		Path: checkout, Branch: branch, BaseSha: oldBase, RepoDir: repo, Session: "healed-heartbeat",
	}
	samples := collectHeartbeatSessionStates(context.Background(), []heartbeatTelemetryTarget{{
		sessionID: "session-1", isolationStatus: isoWorktree, worktree: wt,
	}})
	if len(samples) != 1 {
		t.Fatalf("heartbeat samples = %d, want 1", len(samples))
	}
	state := samples[0].state
	if state.BaseSha != landedTip {
		t.Fatalf("baseSha = %q, want healed branch tip %q", state.BaseSha, landedTip)
	}
	if len(state.ChangedFiles) != 1 || state.ChangedFiles[0].Path != "new.txt" {
		t.Fatalf("changedFiles = %#v, want only the uncommitted post-merge change", state.ChangedFiles)
	}
}

func TestHeartbeatCleanSnapshotUsesNonNilChangedFiles(t *testing.T) {
	repo := initRepo(t)
	base := mustGit(t, repo, "rev-parse", "HEAD")
	samples := collectHeartbeatSessionStates(context.Background(), []heartbeatTelemetryTarget{{
		sessionID:       "session-1",
		isolationStatus: isoWorktree,
		worktree: &Worktree{
			Path: repo, Branch: "main", BaseSha: base, RepoDir: repo, Session: "clean-heartbeat",
		},
	}})
	if len(samples) != 1 {
		t.Fatalf("heartbeat samples = %d, want 1", len(samples))
	}
	if samples[0].state.ChangedFiles == nil {
		t.Fatal("clean heartbeat snapshot must encode changedFiles as [] rather than null")
	}
}
