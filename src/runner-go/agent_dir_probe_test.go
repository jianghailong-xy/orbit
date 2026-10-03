package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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
		if p.RepoURL != "" {
			t.Errorf("%s: repoUrl=%q, want absent without origin", tc.agent, p.RepoURL)
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
	const origin = "git@github.com:orbit/example.git"
	mustGit(t, repo, "remote", "add", "origin", origin)
	sub := filepath.Join(repo, "packages", "web")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	got := scanAgentDirs(context.Background(), []AgentDirTarget{{AgentID: "sub", WorkDir: sub}})
	p, ok := probeByAgent(got, "sub")
	if !ok || !p.Exists || !p.IsGitRepo || p.RepoURL != origin || p.WorkDir != sub {
		t.Fatalf("repo subdir probe = %#v, want exists+isGitRepo with origin and original workDir", got)
	}
}

func TestScanAgentDirsReportsOriginWithoutCredentials(t *testing.T) {
	for _, tc := range []struct {
		name   string
		origin string
		want   string
	}{
		{"https", "https://github.com/owner/repo.git", "https://github.com/owner/repo.git"},
		{"scp", "git@github.com:owner/repo.git", "git@github.com:owner/repo.git"},
		{"ssh", "ssh://git@github.com:2222/owner/repo.git", "ssh://git@github.com:2222/owner/repo.git"},
		{"http credentials", "https://alice:secret@github.com/owner/repo.git?token=secret#secret", "https://github.com/owner/repo.git"},
		{"http token username", "https://secret@github.com/owner/repo.git", "https://github.com/owner/repo.git"},
		{"ssh password", "ssh://git:secret@github.com/owner/repo.git", "ssh://git@github.com/owner/repo.git"},
		{"empty", "", ""},
		{"multiline", "https://github.com/owner/repo.git\nhttps://github.com/other/repo.git", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := t.TempDir()
			mustGit(t, repo, "init")
			mustGit(t, repo, "remote", "add", "origin", tc.origin)
			workDir := repo + string(filepath.Separator) + "."
			got := scanAgentDirs(context.Background(), []AgentDirTarget{{AgentID: "repo", WorkDir: workDir}})
			if len(got) != 1 || got[0].RepoURL != tc.want || got[0].WorkDir != workDir {
				t.Fatalf("probe = %#v, want repoUrl=%q and workDir=%q", got, tc.want, workDir)
			}
		})
	}
}

func TestScanAgentDirsReportsLinkedWorktreeOrigin(t *testing.T) {
	repo := initRepo(t)
	const origin = "git@github.com:owner/repo.git"
	mustGit(t, repo, "remote", "add", "origin", origin)
	worktree := filepath.Join(t.TempDir(), "linked")
	mustGit(t, repo, "worktree", "add", "--detach", worktree)
	got := scanAgentDirs(context.Background(), []AgentDirTarget{{AgentID: "linked", WorkDir: worktree}})
	if len(got) != 1 || !got[0].IsGitRepo || got[0].RepoURL != origin {
		t.Fatalf("linked worktree probe = %#v, want isGitRepo and origin=%q", got, origin)
	}
}

func TestScanAgentDirsDoesNotGuessAnotherRemote(t *testing.T) {
	repo := t.TempDir()
	mustGit(t, repo, "init")
	mustGit(t, repo, "remote", "add", "upstream", "git@github.com:owner/repo.git")
	got := scanAgentDirs(context.Background(), []AgentDirTarget{{AgentID: "repo", WorkDir: repo}})
	if len(got) != 1 || !got[0].IsGitRepo || got[0].RepoURL != "" {
		t.Fatalf("probe = %#v, want isGitRepo with absent repoUrl when origin is missing", got)
	}
}

func TestScanAgentDirsBoundsOriginProbe(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-backed fake git is Unix-only")
	}
	binDir := t.TempDir()
	// Repository detection succeeds, then reading origin stalls. The shared scan deadline
	// must bound this second command too, without reporting a remote from a failed query.
	script := "#!/bin/sh\nif [ \"$3\" = rev-parse ]; then echo true; else exec /bin/sleep 30; fi\n"
	if err := os.WriteFile(filepath.Join(binDir, "git"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	start := time.Now()
	got := scanAgentDirs(ctx, []AgentDirTarget{{AgentID: "repo", WorkDir: binDir}})
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("origin probe took %s, want <1s", elapsed)
	}
	if len(got) != 1 || !got[0].IsGitRepo || got[0].RepoURL != "" {
		t.Fatalf("probe = %#v, want absent repoUrl when origin query times out", got)
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

func TestScanAgentDirsReportsFilesystemHeadroom(t *testing.T) {
	root := t.TempDir()
	got := scanAgentDirs(context.Background(), []AgentDirTarget{
		{AgentID: "here", WorkDir: root},
		{AgentID: "missing", WorkDir: filepath.Join(root, "nope")},
	})
	if len(got) != 2 {
		t.Fatalf("want 2 probes, got %d", len(got))
	}

	// An existing directory answers with its filesystem's figures. Exact values belong to the
	// machine running the test, so the assertions are the invariants: something is free, the
	// volume is at least that big, and free never exceeds total.
	here := got[0]
	if here.FreeBytes == nil || here.TotalBytes == nil {
		t.Fatalf("existing dir reported no disk figures: %+v", here)
	}
	if *here.TotalBytes == 0 {
		t.Error("total bytes is zero for a mounted filesystem")
	}
	if *here.FreeBytes > *here.TotalBytes {
		t.Errorf("free %d exceeds total %d", *here.FreeBytes, *here.TotalBytes)
	}

	// A missing path leaves both nil. Zero would read as "this disk is full" and could gate
	// every run on the machine — absence has to stay distinguishable from exhaustion.
	if missing := got[1]; missing.FreeBytes != nil || missing.TotalBytes != nil {
		t.Errorf("missing dir reported disk figures: %+v", missing)
	}
}
