package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Where a job's throwaway worktree is staged, and what happens to the copies a process that was
// killed leaves behind (integration-line contract §2.4, revision 22).

// TestIntegrationScratchIsStagedUnderTheWorktreesDir is the move itself: a job's scratch worktree
// lives under the runner's worktrees directory, among everything else this runner stages, rather
// than beside the workspace (often the user's home). The check's own working directory is what says
// so — it is where git put the tree — and the old location must be clean afterwards.
func TestIntegrationScratchIsStagedUnderTheWorktreesDir(t *testing.T) {
	// Not parallel: the runner's home is set for the whole process by t.Setenv.
	t.Setenv("ORBIT_HOME", t.TempDir())
	r := newIntegrationRepo(t)
	r.checkoutNew("project/line", "main")
	r.push("project/line")
	r.checkoutNew("task/where", "main")
	r.write("where.txt", "work\n")
	r.commit("task work")
	r.push("task/where")
	r.checkout("main")

	cwdFile := filepath.Join(t.TempDir(), "cwd")
	job := r.command("task/where", "project/line", IntegrationCheckSpec{
		Name: "MERGE_CHECK", Command: fmt.Sprintf("pwd > %q", cwdFile), ExpectedExitCode: 0, TimeoutSeconds: 60,
	})
	// The default root: exactly what a job claimed from the control plane carries.
	job.scratchRoot = ""
	result := runIntegrationJob(job, silent)
	if result.State != "LANDED" {
		t.Fatalf("state = %s (%s %s), want LANDED", result.State, result.ErrorCode, result.Phase)
	}

	raw, err := os.ReadFile(cwdFile)
	if err != nil {
		t.Fatalf("the check wrote no working directory: %v", err)
	}
	got := strings.TrimSpace(string(raw))
	want := filepath.Join(worktreesDir(), integrateScratchPrefix+job.JobID)
	if resolved, err := filepath.EvalSymlinks(want); err == nil {
		want = resolved
	}
	if resolved, err := filepath.EvalSymlinks(got); err == nil {
		got = resolved
	}
	if got != want {
		t.Fatalf("the check ran in %s, want %s: the scratch worktree belongs under the worktrees directory", got, want)
	}
	if legacy := legacyIntegrationScratchPath(r.work, job.JobID); legacy != want {
		if _, err := os.Stat(legacy); !os.IsNotExist(err) {
			t.Fatalf("the scratch worktree is still where it used to go (%s)", legacy)
		}
	}
}

// TestSweepReclaimsLeftoverIntegrationScratchInBothLocations: a scratch tree a killed process left
// is nobody's work and goes, in the current worktrees directory and in the legacy place beside the
// workspace alike; the tree of a job this process is integrating stays, and so does everything in
// the directory that is not scratch.
func TestSweepReclaimsLeftoverIntegrationScratchInBothLocations(t *testing.T) {
	t.Parallel()
	r := newIntegrationRepo(t)
	current := t.TempDir()
	legacy := filepath.Dir(r.work)

	mustMkdir(t, current)
	orphanNew := filepath.Join(current, integrateScratchPrefix+"job-orphan-new")
	mustGit(t, r.work, "worktree", "add", "-q", "--detach", orphanNew, "main")
	orphanOld := filepath.Join(legacy, integrateScratchPrefix+"job-orphan-old")
	mustGit(t, r.work, "worktree", "add", "-q", "--detach", orphanOld, "main")
	active := filepath.Join(current, integrateScratchPrefix+"job-active")
	mustGit(t, r.work, "worktree", "add", "-q", "--detach", active, "main")
	// A directory with the prefix that is not a registered worktree (a tree half removed by a
	// kill): there is no repository to unregister it from, so it is removed as a plain directory.
	plain := filepath.Join(current, integrateScratchPrefix+"job-plain")
	mustMkdir(t, plain)
	if err := os.WriteFile(filepath.Join(plain, "left"), []byte("x\n"), 0o644); err != nil {
		t.Fatalf("write into the plain leftover: %v", err)
	}
	// Something that is not ours must survive the sweep untouched.
	other := filepath.Join(current, "sess-not-a-scratch-tree")
	mustMkdir(t, other)

	sweepIntegrationScratch([]string{current, legacy}, func(jobID string) bool {
		return jobID == "job-active"
	})

	for name, path := range map[string]string{
		"the leftover under the worktrees directory": orphanNew,
		"the leftover beside the workspace":          orphanOld,
		"the leftover that is not a worktree":        plain,
	} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("%s is still on disk (%v)", name, err)
		}
	}
	if _, err := os.Stat(active); err != nil {
		t.Fatalf("the scratch of a job that is integrating was removed: %v", err)
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatalf("the sweep removed a directory that is not integration scratch: %v", err)
	}
	listed, err := git(r.work, "worktree", "list")
	if err != nil {
		t.Fatalf("worktree list: %v", err)
	}
	for _, leftover := range []string{orphanNew, orphanOld, plain} {
		if strings.Contains(listed, leftover) {
			t.Fatalf("the repository still lists the removed leftover %s:\n%s", leftover, listed)
		}
	}
	if !strings.Contains(listed, active) {
		t.Fatalf("the repository no longer lists the integrating job's worktree:\n%s", listed)
	}
}

// TestAJobClearsItsLegacyScratchBeforeStagingTheNewOne: an old-build process killed mid-job leaves
// its scratch beside the workspace, where nothing sweeps any more. When the job is handed over
// again, the new path would never trip over that tree — so the job removes its own legacy copy
// before it stages anything.
func TestAJobClearsItsLegacyScratchBeforeStagingTheNewOne(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	r := newIntegrationRepo(t)
	r.checkoutNew("project/line", "main")
	r.push("project/line")
	r.checkoutNew("task/legacy", "main")
	r.write("legacy.txt", "work\n")
	r.commit("task work")
	r.push("task/legacy")
	r.checkout("main")

	job := r.command("task/legacy", "project/line")
	job.scratchRoot = ""
	leftover := legacyIntegrationScratchPath(r.work, job.JobID)
	mustGit(t, r.work, "worktree", "add", "-q", "--detach", leftover, "main")
	if err := os.WriteFile(filepath.Join(leftover, "left-by-a-killed-attempt.txt"), []byte("x\n"), 0o644); err != nil {
		t.Fatalf("write the legacy leftover: %v", err)
	}

	result := runIntegrationJob(job, silent)
	if result.State != "LANDED" {
		t.Fatalf("state = %s (%s %s), want LANDED", result.State, result.ErrorCode, result.Phase)
	}
	if _, err := os.Stat(leftover); !os.IsNotExist(err) {
		t.Fatalf("the legacy scratch worktree is still on disk after the job (%v)", err)
	}
	listed, err := git(r.work, "worktree", "list")
	if err != nil {
		t.Fatalf("worktree list: %v", err)
	}
	if strings.Contains(listed, leftover) {
		t.Fatalf("the repository still lists the legacy worktree:\n%s", listed)
	}
}

func mustMkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
}
