package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Several agents usually share one checkout (and a workDir is often a subdir of it), so the scan
// must key by the resolved repo root and carry every agent that lands there — that mapping is what
// lets the UI attach the warning to the agent the user is looking at.
func TestScanRepoHealthGroupsAgentsByRepoRoot(t *testing.T) {
	repo := initRepo(t)
	sub := filepath.Join(repo, "src")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	notRepo := t.TempDir()

	got := scanRepoHealth([]agentWorkDir{
		{AgentID: "a1", Dir: repo},
		{AgentID: "a2", Dir: sub},
		{AgentID: "a3", Dir: notRepo}, // no git → skipped, isolation reports that per session
		{Dir: repo},                   // the runner's own workDir contributes no agent id
	})
	if len(got) != 1 {
		t.Fatalf("expected one checkout, got %d: %+v", len(got), got)
	}
	rep := got[0]
	if rep.Root != repo || rep.State != repoStateClean || rep.Branch != "main" {
		t.Errorf("report = %+v, want clean main at %s", rep, repo)
	}
	if len(rep.AgentIDs) != 2 || rep.AgentIDs[0] != "a1" || rep.AgentIDs[1] != "a2" {
		t.Errorf("agent ids = %v, want [a1 a2]", rep.AgentIDs)
	}

	// A wedged checkout is what the report exists for: it must name the state and the file.
	if err := os.WriteFile(filepath.Join(repo, "base.txt"), []byte("edit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got = scanRepoHealth([]agentWorkDir{{AgentID: "a1", Dir: sub}}); got[0].State != repoStateDirty {
		t.Errorf("dirty checkout = %+v, want %q", got[0], repoStateDirty)
	} else if len(got[0].Paths) != 1 || got[0].Paths[0] != "base.txt" {
		t.Errorf("paths = %v, want [base.txt]", got[0].Paths)
	}
}

// The repair must be a rescue, not a reset: this replays the outage (a conflicted `git stash pop`
// leaves conflict stages with no MERGE_HEAD, so even `git merge --abort` refuses) and pins that
// every byte the checkout held is recoverable from the rescue branch afterwards.
func TestCleanupRepoRootRescuesBeforeClearing(t *testing.T) {
	repo := initRepo(t)
	commitFile(t, repo, "shared.txt", "v1\n", "add shared")
	if err := os.WriteFile(filepath.Join(repo, "shared.txt"), []byte("someone's wip\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGit(t, repo, "stash", "push", "-m", "another worktree's wip")
	mustGit(t, repo, "rm", "-q", "shared.txt")
	mustGit(t, repo, "commit", "-m", "refactor: drop shared.txt")
	_, _ = git(repo, "stash", "pop") // conflicts on purpose
	// An unrelated uncommitted edit and an untracked file, both bystanders of the repair.
	if err := os.WriteFile(filepath.Join(repo, "base.txt"), []byte("bystander edit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "scratch.txt"), []byte("untracked\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if st := inspectRepoRoot(repo); st.State != repoStateUnmerged {
		t.Fatalf("setup: want an unmerged checkout, got %q", st.State)
	}
	headBefore := mustGit(t, repo, "rev-parse", "HEAD")

	out := cleanupRepoRoot(repo, nil)
	if out.Status != "done" || out.State != repoStateClean {
		t.Fatalf("cleanup = %+v, want done/clean", out)
	}
	if st := inspectRepoRoot(repo); st.State != repoStateClean {
		t.Errorf("checkout still %q after cleanup", st.State)
	}
	if head, _ := git(repo, "rev-parse", "HEAD"); head != headBefore {
		t.Errorf("HEAD must not move: %s → %s", headBefore, head)
	}
	if _, err := os.Stat(filepath.Join(repo, "scratch.txt")); !os.IsNotExist(err) {
		t.Error("untracked leftovers should be cleared (they block later fast-forwards)")
	}

	// Everything the checkout held must be readable from the rescue branch.
	if out.RescueBranch == "" {
		t.Fatal("expected a rescue branch")
	}
	for path, want := range map[string]string{
		"shared.txt":  "someone's wip\n",  // the conflicted stash content
		"base.txt":    "bystander edit\n", // the unrelated uncommitted edit
		"scratch.txt": "untracked\n",      // the untracked file `clean -fd` removed
	} {
		got, err := git(repo, "show", out.RescueBranch+":"+path)
		if err != nil {
			t.Errorf("rescue branch is missing %s: %v", path, err)
			continue
		}
		if got != strings.TrimSpace(want) {
			t.Errorf("rescue %s = %q, want %q", path, got, want)
		}
	}
}

// The control plane names the checkout to repair, so the runner must refuse a path that isn't one
// of its own agents' — a rewrite of an arbitrary directory is not something it should accept.
func TestCleanupRepoRootRefusesForeignCheckout(t *testing.T) {
	repo := initRepo(t)
	if err := os.WriteFile(filepath.Join(repo, "base.txt"), []byte("edited\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out := cleanupRepoRoot(repo, func(string) bool { return false })
	if out.Status != "failed" {
		t.Fatalf("expected refusal, got %+v", out)
	}
	if st := inspectRepoRoot(repo); st.State != repoStateDirty {
		t.Errorf("a refused repair must touch nothing, got %q", st.State)
	}
}

// A clean checkout is a no-op, not a rescue commit: the button is reachable from a stale warning.
func TestCleanupRepoRootCleanIsNoop(t *testing.T) {
	repo := initRepo(t)
	out := cleanupRepoRoot(repo, nil)
	if out.Status != "done" || out.RescueBranch != "" {
		t.Fatalf("clean checkout = %+v, want done with no rescue branch", out)
	}
}
