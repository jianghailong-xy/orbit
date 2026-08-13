package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func probeByAgent(probes []AgentDirProbe, agentID string) (AgentDirProbe, bool) {
	for _, p := range probes {
		if p.AgentID == agentID {
			return p, true
		}
	}
	return AgentDirProbe{}, false
}

func TestScanAgentDirsReportsExistenceAndGitSeparately(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	plain := filepath.Join(root, "plain")
	file := filepath.Join(root, "a-file")
	for _, d := range []string{repo, plain} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("git", "-C", repo, "init").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v (%s)", err, out)
	}

	got := scanAgentDirs(context.Background(), []AgentDirTarget{
		{AgentID: "git", WorkDir: repo},
		{AgentID: "plain", WorkDir: plain},
		{AgentID: "missing", WorkDir: filepath.Join(root, "nope")},
		// A plain file is not somewhere a session can run, so it counts as missing rather
		// than as an existing path the form would then call usable.
		{AgentID: "file", WorkDir: file},
		// Nothing identifiable to report against — dropped instead of guessed at.
		{AgentID: "", WorkDir: repo},
		{AgentID: "blank-dir", WorkDir: ""},
	})

	if len(got) != 4 {
		t.Fatalf("probes = %d, want 4 (the identifiable targets): %#v", len(got), got)
	}
	for _, tc := range []struct {
		agent  string
		exists bool
		isGit  bool
	}{
		{"git", true, true},
		{"plain", true, false},
		{"missing", false, false},
		{"file", false, false},
	} {
		p, ok := probeByAgent(got, tc.agent)
		if !ok {
			t.Fatalf("no probe for %q", tc.agent)
		}
		if p.Exists != tc.exists || p.IsGitRepo != tc.isGit {
			t.Errorf("%s: exists=%v isGit=%v, want exists=%v isGit=%v",
				tc.agent, p.Exists, p.IsGitRepo, tc.exists, tc.isGit)
		}
	}
}

// A subdirectory of a repo is inside its work tree, which is what setupWorktree checks — so the
// form must not tell the user a perfectly isolable path isn't a git repo.
func TestScanAgentDirsTreatsRepoSubdirAsGit(t *testing.T) {
	repo := t.TempDir()
	if out, err := exec.Command("git", "-C", repo, "init").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v (%s)", err, out)
	}
	sub := filepath.Join(repo, "packages", "web")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	got := scanAgentDirs(context.Background(), []AgentDirTarget{{AgentID: "sub", WorkDir: sub}})
	p, ok := probeByAgent(got, "sub")
	if !ok || !p.Exists || !p.IsGitRepo {
		t.Fatalf("repo subdir probe = %#v, want exists+isGitRepo", got)
	}
}

// Before the first scan the snapshot must stay nil: the control plane keeps its last known state
// rather than being told every directory disappeared.
func TestAgentDirProbeSnapshotNilUntilFirstScan(t *testing.T) {
	p := newAgentDirProbe(agentDirProbeTimeout)
	if got := p.snapshot(); got != nil {
		t.Fatalf("snapshot before any scan = %#v, want nil", got)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.run(ctx)

	repo := t.TempDir()
	p.trigger([]AgentDirTarget{{AgentID: "a", WorkDir: repo}})
	var got []AgentDirProbe
	for i := 0; i < 200 && got == nil; i++ {
		got = p.snapshot()
		if got == nil {
			time.Sleep(time.Millisecond)
		}
	}
	if len(got) != 1 || got[0].AgentID != "a" || !got[0].Exists {
		t.Fatalf("snapshot after scan = %#v, want one existing probe for a", got)
	}

	// An empty target set is a real answer ("this runner has no agent dirs"), not a missing one.
	p.trigger(nil)
	for i := 0; i < 200; i++ {
		if len(p.snapshot()) == 0 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if got := p.snapshot(); got == nil || len(got) != 0 {
		t.Fatalf("snapshot after empty scan = %#v, want a non-nil empty slice", got)
	}
}
