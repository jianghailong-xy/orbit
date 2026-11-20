package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The branch's commits come back newest first, each with its own files, and a commit the runner made itself is told
// from the agent's by its Orbit-Saved trailer, which is taken out of the body shown.
func TestBranchCommitsListsTheBranchNewestFirst(t *testing.T) {
	repo := initRepo(t)
	base := mustGit(t, repo, "rev-parse", "HEAD")
	mustGit(t, repo, "checkout", "-b", "orbit/s1")

	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(repo, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("a.txt", "one\ntwo\n")
	mustGit(t, repo, "add", "-A")
	mustGit(t, repo, "commit", "-m", "feat(a): add a\n\nWhy a exists.")
	write("b.txt", "b\n")
	write("a.txt", "one\n")
	mustGit(t, repo, "add", "-A")
	mustGit(t, repo, "commit", "-m", withOrbitSaved("chore: update 2 files", orbitSavedSessionEnd))
	tip := mustGit(t, repo, "rev-parse", "HEAD")

	got := branchCommitsBetween(repo, base, tip)
	if len(got) != 2 {
		t.Fatalf("want 2 commits, got %d: %+v", len(got), got)
	}
	if got[0].Sha != tip || got[0].Subject != "chore: update 2 files" || got[0].SavedBy != orbitSavedSessionEnd || got[0].Body != "" {
		t.Errorf("newest commit read wrong: %+v", got[0])
	}
	if len(got[0].Files) != 2 {
		t.Errorf("newest commit should list its own 2 files, got %+v", got[0].Files)
	}
	if got[1].Subject != "feat(a): add a" || got[1].Body != "Why a exists." || got[1].SavedBy != "" {
		t.Errorf("agent commit read wrong: %+v", got[1])
	}
	if len(got[1].Files) != 1 || got[1].Files[0] != (BranchCommitFile{Path: "a.txt", Additions: 2, Deletions: 0}) {
		t.Errorf("agent commit files wrong: %+v", got[1].Files)
	}
	if got[1].CommittedAt == "" {
		t.Error("a commit carries its time")
	}

	if empty := branchCommitsBetween(repo, tip, tip); empty == nil || len(empty) != 0 {
		t.Errorf("a branch with no commits of its own is an empty list, not unknown: %#v", empty)
	}
	if unknown := branchCommitsBetween(repo, base, "0000000000000000000000000000000000000000"); unknown != nil {
		t.Errorf("a tip git cannot read is unknown (nil): %#v", unknown)
	}
}

func TestSplitOrbitTrailersReadsAParkCheckpoint(t *testing.T) {
	body, by := splitOrbitTrailers("\n" + parkCheckpointTrailer + ": s1")
	if body != "" || by != "checkpoint" {
		t.Errorf("got %q, %q", body, by)
	}
}

// A session on its own branch is asked to commit each step itself, through every engine's instructions; a session
// without a branch of its own is not.
func TestEveryEngineIsAskedToCommitEachStep(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	job := &ClaimedSession{SessionID: "s-commits", Branch: "orbit/s-commits",
		Agent: AgentExecConfig{Model: "test-model", PermissionMode: "default"}}
	if setupWorktree(job, repo); job.WT == nil {
		t.Fatal("no worktree")
	}
	note := branchCommitInstructions(job.WT)
	if !strings.Contains(note, "`orbit/s-commits`") || !strings.Contains(note, "Commit each logical step") {
		t.Fatalf("branchCommitInstructions = %q", note)
	}
	for engine, instructions := range engineInstructions(t, job) {
		if !strings.Contains(instructions, note) {
			t.Errorf("%s was not asked to commit each step:\n%s", engine, instructions)
		}
	}
	if got := branchCommitInstructions(nil); got != "" {
		t.Errorf("no branch, no note: %q", got)
	}
}

// Not read is null, which the control plane takes as "keep the stored list"; read and empty is [], which clears it.
func TestBranchCommitsWireField(t *testing.T) {
	for _, tc := range []struct {
		body interface{}
		want string
	}{
		{TurnCompleteRequest{}, `"branchCommits":null`},
		{DiffResultRequest{BranchCommits: []BranchCommit{}}, `"branchCommits":[]`},
		{RunFinalizeRequest{BranchCommits: []BranchCommit{{Sha: "a41c9e2", Files: []BranchCommitFile{}}}}, `"branchCommits":[{"sha":"a41c9e2"`},
	} {
		encoded, err := json.Marshal(tc.body)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(encoded), tc.want) {
			t.Errorf("payload %s does not carry %s", encoded, tc.want)
		}
	}
}

// Bringing the target into the branch is no step of the session's work: neither the merge nor what it brought in is listed.
func TestBranchCommitsLeaveOutMergesOfTheTarget(t *testing.T) {
	repo := initRepo(t)
	base := mustGit(t, repo, "rev-parse", "HEAD")
	mustGit(t, repo, "checkout", "-b", "orbit/s2")
	if err := os.WriteFile(filepath.Join(repo, "mine.txt"), []byte("mine\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGit(t, repo, "add", "-A")
	mustGit(t, repo, "commit", "-m", "feat: my step")
	mustGit(t, repo, "checkout", "main")
	if err := os.WriteFile(filepath.Join(repo, "theirs.txt"), []byte("theirs\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGit(t, repo, "add", "-A")
	mustGit(t, repo, "commit", "-m", "feat: on main meanwhile")
	mustGit(t, repo, "checkout", "orbit/s2")
	mustGit(t, repo, "merge", "--no-edit", "--no-ff", "main")
	tip := mustGit(t, repo, "rev-parse", "HEAD")

	got := branchCommitsBetween(repo, base, tip)
	if len(got) != 1 || got[0].Subject != "feat: my step" {
		t.Fatalf("want only the session's own commit, got %+v", got)
	}
}
