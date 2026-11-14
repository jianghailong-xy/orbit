package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A no-worktree session with a workSubdir runs in workDir/workSubdir, the path with its links followed.
func TestSetupWorktreeRunsInTheWorkSubdir(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "services", "api")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	// A link inside the workspace to another folder inside it is followed and allowed.
	if err := os.Symlink(sub, filepath.Join(root, "api")); err != nil {
		t.Fatal(err)
	}
	realSub, _ := filepath.EvalSymlinks(sub)
	for _, ws := range []string{"services/api", "api"} {
		job := &ClaimedSession{SessionID: "s-sub", WorkSubdir: ws}
		if got := setupWorktree(job, root); got != realSub {
			t.Fatalf("%s: exec dir %q, want %q", ws, got, realSub)
		}
		if job.SourceRefusal != nil || job.IsolationStatus != isoShared {
			t.Fatalf("%s: refusal %+v isolation %q", ws, job.SourceRefusal, job.IsolationStatus)
		}
	}
	// None: the workspace directory, as before.
	job := &ClaimedSession{SessionID: "s-root"}
	if got := setupWorktree(job, root); got != root || job.SourceRefusal != nil {
		t.Fatalf("no workSubdir: %q %+v", got, job.SourceRefusal)
	}
}

// A folder that is not there, or that leads out of the workspace through a symlink, starts no engine: the run
// fails with a refusal that says which and where.
func TestSetupWorktreeRefusesAWorkSubdirItCannotRunIn(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "real"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside), filepath.Join(root, "real", "up")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ sub, want string }{
		{"escape", "outside the workspace directory"},
		{"real/up", "outside the workspace directory"},
		{"missing/folder", "does not exist on this machine"},
		{"file.txt", "is not a directory"},
		{"../" + filepath.Base(outside), "is not a path inside the workspace directory"},
		{outside, "is not a path inside the workspace directory"},
	} {
		job := &ClaimedSession{SessionID: "s-bad", WorkSubdir: c.sub}
		if got := setupWorktree(job, root); got != "" {
			t.Fatalf("%s: exec dir %q, want none", c.sub, got)
		}
		r := job.SourceRefusal
		if r == nil || r.Code != workSubdirRefusal {
			t.Fatalf("%s: refusal %+v", c.sub, r)
		}
		if reason, _ := r.Detail["reason"].(string); !strings.Contains(reason, c.want) {
			t.Fatalf("%s: reason %q, want %q", c.sub, reason, c.want)
		}
	}
}

// The refusal is the run's error, and no engine is spawned for it.
func TestRunSessionProcessReportsAWorkSubdirRefusal(t *testing.T) {
	job := &ClaimedSession{SessionID: "s-bad", WorkSubdir: "missing"}
	if setupWorktree(job, t.TempDir()) != "" {
		t.Fatal("a missing folder was given an exec dir")
	}
	var msgs []string
	emit := func(kind string, payload map[string]interface{}) {
		if kind == evError {
			msgs = append(msgs, payload["message"].(string))
		}
	}
	status, ended, _ := runSessionProcess(context.Background(), context.Background(), nil, job, "", "", "", emit, nil, nil, true, nil, nil, nil, nil, nil)
	if status != stFailed || !ended {
		t.Fatalf("status %q ended %v", status, ended)
	}
	if len(msgs) != 1 || !strings.HasPrefix(msgs[0], workSubdirRefusal+": the session's folder ") || !strings.Contains(msgs[0], "does not exist") {
		t.Fatalf("errors %q", msgs)
	}
}

// Reclaim carries it as claim does.
func TestReclaimKeepsTheWorkSubdir(t *testing.T) {
	if got := claimedSessionFromReclaim(ReclaimSession{SessionID: "s", WorkSubdir: "services/api"}).WorkSubdir; got != "services/api" {
		t.Fatalf("workSubdir %q", got)
	}
}
