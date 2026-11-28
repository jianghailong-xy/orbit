package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Real-Git tests for the commits a main checkout has not pushed: the snapshot's list and the commit read
// (docs/main-checkout-git-contract.md §2, §10.1).

// trackingRepo is a checkout on main whose upstream, origin/main, holds everything committed so far.
func trackingRepo(t *testing.T) string {
	t.Helper()
	repo := realRepo(t)
	bare := t.TempDir()
	mustGit(t, bare, "init", "--bare", "-b", "main")
	mustGit(t, repo, "remote", "add", "origin", bare)
	mustGit(t, repo, "push", "-q", "-u", "origin", "main")
	return repo
}

func readCommit(repo, sha string, paths ...string) MainCheckoutSnapshotAnswer {
	return readMainCheckoutForRelay(MainCheckoutRunnerRequest{Op: "snapshot", Root: repo, Commit: sha, DiffPaths: paths},
		mainCheckoutDeps{owns: ownsOnly(repo)})
}

// readSnapshot is the snapshot an on-demand read answers, the only one that lists commits.
func readSnapshot(t *testing.T, repo string) MainCheckoutSnapshot {
	t.Helper()
	a := readCommit(repo, "")
	if a.Error != "" || a.Snapshot == nil {
		t.Fatalf("read %s: %+v", repo, a)
	}
	return *a.Snapshot
}

func checkedOut(t *testing.T, repo string) string {
	t.Helper()
	return mustGit(t, repo, "rev-parse", "HEAD")
}

func TestMainCheckoutCommitsListedNewestFirst(t *testing.T) {
	repo := trackingRepo(t)
	if snap := readSnapshot(t, repo); snap.Commits != nil || snap.CommitsTruncated {
		t.Fatalf("nothing ahead, commits = %+v", snap.Commits)
	}
	commitFile(t, repo, "a.txt", "1\n2\n", "first")
	commitFile(t, repo, "a.txt", "1\nTWO\n3\n", "second")
	mcWrite(t, repo, "dir/é b.txt", "x\n")
	mustGit(t, repo, "mv", "base.txt", "moved.txt")
	mustGit(t, repo, "add", "-A")
	mustGit(t, repo, "commit", "-q", "-m", "third", "-m", "Why it was done.")

	snap := readSnapshot(t, repo)
	if len(snap.Commits) != 3 || snap.CommitsTruncated {
		t.Fatalf("commits = %+v, truncated %v", snap.Commits, snap.CommitsTruncated)
	}
	want := []struct {
		subject string
		files   []BranchCommitFile
	}{
		// A rename is a delete and an add, and a path is listed as it is, so each can be asked for.
		{"third", []BranchCommitFile{{"base.txt", 0, 1}, {"dir/é b.txt", 1, 0}, {"moved.txt", 1, 0}}},
		{"second", []BranchCommitFile{{"a.txt", 2, 1}}},
		{"first", []BranchCommitFile{{"a.txt", 2, 0}}},
	}
	for i, w := range want {
		c := snap.Commits[i]
		if c.Subject != w.subject || !reflect.DeepEqual(c.Files, w.files) || len(c.Sha) != 40 || c.CommittedAt == "" {
			t.Errorf("commit %d = %+v, want %s %+v", i, c, w.subject, w.files)
		}
	}
	if snap.Commits[0].Sha != checkedOut(t, repo) || snap.Commits[0].Body != "Why it was done." {
		t.Errorf("newest commit = %+v", snap.Commits[0])
	}
}

// The heartbeat and the turn-end watch scan every checkout again and again and send no commit list, so they must not
// read one. A git on PATH records what each of them runs.
func TestMainCheckoutCommitsListedOnlyByTheRead(t *testing.T) {
	repo := trackingRepo(t)
	for i := 1; i <= 3; i++ {
		commitFile(t, repo, "a.txt", fmt.Sprintf("%d\n", i), fmt.Sprintf("c%d", i))
	}
	real, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	ran := filepath.Join(bin, "ran")
	script := fmt.Sprintf("#!/bin/sh\necho \"$@\" >> '%s'\nexec '%s' \"$@\"\n", ran, real)
	if err := os.WriteFile(filepath.Join(bin, "git"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	logs := func() int {
		t.Helper()
		raw, err := os.ReadFile(ran)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(ran); err != nil {
			t.Fatal(err)
		}
		return strings.Count(string(raw), " log --first-parent ")
	}

	if scan := mustScan(t, repo); scan.Snapshot.Ahead == nil || *scan.Snapshot.Ahead != 3 ||
		scan.Snapshot.Commits != nil || scan.Snapshot.CommitsTruncated {
		t.Errorf("scan = %+v", scan.Snapshot)
	}
	if n := logs(); n != 0 {
		t.Errorf("a scan ran %d commit logs", n)
	}
	if hb := mainCheckoutHeartbeat(repo); hb == nil || hb.Ahead == nil || *hb.Ahead != 3 {
		t.Errorf("heartbeat = %+v", hb)
	}
	if n := logs(); n != 0 {
		t.Errorf("the heartbeat ran %d commit logs", n)
	}
	watch := watchMainCheckout(&Worktree{RepoDir: repo})
	mcWrite(t, repo, "new.txt", "x\n")
	if watch.changed() == nil {
		t.Error("the turn-end watch saw no change")
	}
	if n := logs(); n != 0 {
		t.Errorf("the turn-end watch ran %d commit logs", n)
	}
	if snap := readSnapshot(t, repo); len(snap.Commits) != 3 {
		t.Errorf("read listed %+v", snap.Commits)
	}
	if n := logs(); n != 1 {
		t.Errorf("the read ran %d commit logs, want 1", n)
	}
}

func TestMainCheckoutCommitsCappedAt20(t *testing.T) {
	repo := trackingRepo(t)
	for i := 1; i <= mainCheckoutCommitsMax; i++ {
		mustGit(t, repo, "commit", "-q", "--allow-empty", "-m", fmt.Sprintf("c%d", i))
	}
	if snap := readSnapshot(t, repo); len(snap.Commits) != 20 || snap.CommitsTruncated {
		t.Fatalf("20 ahead: %d listed, truncated %v", len(snap.Commits), snap.CommitsTruncated)
	}
	for i := 21; i <= 25; i++ {
		mustGit(t, repo, "commit", "-q", "--allow-empty", "-m", fmt.Sprintf("c%d", i))
	}
	snap := readSnapshot(t, repo)
	if snap.Ahead == nil || *snap.Ahead != 25 || len(snap.Commits) != 20 || !snap.CommitsTruncated {
		t.Fatalf("25 ahead: ahead %v, %d listed, truncated %v", snap.Ahead, len(snap.Commits), snap.CommitsTruncated)
	}
	if snap.Commits[0].Subject != "c25" || snap.Commits[19].Subject != "c6" {
		t.Errorf("listed %s … %s, want c25 … c6", snap.Commits[0].Subject, snap.Commits[19].Subject)
	}
	// The cap is on the list, not on what a read serves: an older unpushed commit is still one not pushed.
	if a := readCommit(repo, mustGit(t, repo, "rev-parse", "HEAD~24")); a.Error != "" {
		t.Errorf("oldest unpushed commit refused: %s", a.Error)
	}
}

func TestMainCheckoutCommitsAbsentWithoutUpstream(t *testing.T) {
	absent := func(what, repo string) {
		t.Helper()
		snap := readSnapshot(t, repo)
		raw, err := json.Marshal(snap)
		if err != nil {
			t.Fatal(err)
		}
		if snap.Commits != nil || strings.Contains(string(raw), `"commits`) {
			t.Errorf("%s: snapshot = %s", what, raw)
		}
		if a := readCommit(repo, snap.Head); a.Error != "that commit isn't one this checkout hasn't pushed" || a.Snapshot != nil {
			t.Errorf("%s: commit read answered %+v", what, a)
		}
	}
	repo := realRepo(t)
	commitFile(t, repo, "a.txt", "x\n", "local")
	absent("no upstream", repo)

	repo = trackingRepo(t)
	commitFile(t, repo, "a.txt", "x\n", "local")
	mustGit(t, repo, "checkout", "-q", "--detach")
	absent("detached HEAD", repo)
}

func TestMainCheckoutCommitPatchIsThatCommitsOwn(t *testing.T) {
	repo := trackingRepo(t)
	commitFile(t, repo, "a.txt", "one\n", "adds one")
	first := checkedOut(t, repo)
	commitFile(t, repo, "a.txt", "one\ntwo\n", "adds two")
	second := checkedOut(t, repo)
	commitFiles(t, repo, "binary and big", map[string]string{
		"bin.dat": "a\x00b", "big.txt": strings.Repeat("a line of text that makes the patch long\n", mainCheckoutPatchMaxBytes/32),
	})
	third := checkedOut(t, repo)
	mcWrite(t, repo, "a.txt", "one\ntwo\nuncommitted\n")

	a := readCommit(repo, first, "a.txt")
	if a.Error != "" || a.Snapshot == nil || len(a.Snapshot.Commits) != 3 || len(a.Diffs) != 1 {
		t.Fatalf("answer = %+v", a)
	}
	if p := a.Diffs[0].Patch; !strings.Contains(p, "new file mode") || !strings.Contains(p, "\n+one\n") ||
		strings.Contains(p, "two") || strings.Contains(p, "uncommitted") {
		t.Errorf("first commit's patch:\n%s", p)
	}
	a = readCommit(repo, second, "a.txt")
	if len(a.Diffs) != 1 {
		t.Fatalf("answer = %+v", a)
	}
	if p := a.Diffs[0].Patch; !strings.Contains(p, "\n one\n+two\n") || strings.Contains(p, "+one") || strings.Contains(p, "uncommitted") {
		t.Errorf("second commit's patch:\n%s", p)
	}
	a = readCommit(repo, third, "bin.dat", "big.txt", "../outside")
	if len(a.Diffs) != 2 {
		t.Fatalf("answer = %+v", a)
	}
	if d := a.Diffs[0]; d.Path != "bin.dat" || !d.Binary || d.Patch != "" {
		t.Errorf("binary = %+v", d)
	}
	if d := a.Diffs[1]; !d.PatchTruncated || len(d.Patch) > mainCheckoutPatchMaxBytes || !strings.HasSuffix(d.Patch, "\n") {
		t.Errorf("big: %d bytes, truncated %v", len(d.Patch), d.PatchTruncated)
	}
}

// A merge is answered against its first parent, and a root commit against the empty tree.
func TestMainCheckoutCommitPatchOfAMergeAndARootCommit(t *testing.T) {
	repo := trackingRepo(t)
	mustGit(t, repo, "checkout", "-q", "-b", "side")
	commitFile(t, repo, "side.txt", "from side\n", "side")
	mustGit(t, repo, "checkout", "-q", "main")
	commitFile(t, repo, "main.txt", "from main\n", "main")
	mustGit(t, repo, "merge", "-q", "--no-ff", "-m", "merge side", "side")
	a := readCommit(repo, checkedOut(t, repo), "side.txt", "main.txt")
	if len(a.Diffs) != 2 || !strings.Contains(a.Diffs[0].Patch, "+from side") || a.Diffs[1].Patch != "" {
		t.Errorf("merge answer = %+v", a)
	}

	// A history unrelated to the upstream's, so its root commit is one not pushed.
	mustGit(t, repo, "checkout", "-q", "--orphan", "unrelated")
	mustGit(t, repo, "rm", "-q", "-r", "-f", ".")
	commitFile(t, repo, "root.txt", "from root\n", "root")
	mustGit(t, repo, "branch", "-q", "--set-upstream-to=origin/main")
	a = readCommit(repo, checkedOut(t, repo), "root.txt")
	if a.Error != "" || len(a.Diffs) != 1 || !strings.Contains(a.Diffs[0].Patch, "new file mode") ||
		!strings.Contains(a.Diffs[0].Patch, "+from root") {
		t.Errorf("root answer = %+v", a)
	}
}

func TestMainCheckoutCommitUnlistedShaRefused(t *testing.T) {
	repo := trackingRepo(t)
	pushed := checkedOut(t, repo)
	mustGit(t, repo, "checkout", "-q", "-b", "other")
	commitFile(t, repo, "other.txt", "x\n", "on another branch")
	other := checkedOut(t, repo)
	mustGit(t, repo, "checkout", "-q", "main")
	commitFile(t, repo, "a.txt", "x\n", "unpushed")
	unpushed := checkedOut(t, repo)

	for what, sha := range map[string]string{
		"an upstream commit": pushed, "another branch's commit": other, "an unknown sha": strings.Repeat("0", 40),
		"garbage": "not-a-sha", "an option": "--all", "a ref name": "HEAD", "a short sha": unpushed[:12],
		"the commit's tree": mustGit(t, repo, "rev-parse", "HEAD^{tree}"),
	} {
		a := readCommit(repo, sha, "base.txt")
		if a.Error != "that commit isn't one this checkout hasn't pushed" || a.Snapshot != nil || a.Diffs != nil {
			t.Errorf("%s: answered %+v", what, a)
		}
	}
	if a := readCommit(repo, unpushed, "a.txt"); a.Error != "" || len(a.Diffs) != 1 {
		t.Errorf("unpushed commit: %+v", a)
	}
	// Once pushed it is history like any other.
	mustGit(t, repo, "push", "-q")
	if a := readCommit(repo, unpushed, "a.txt"); a.Error == "" {
		t.Errorf("pushed commit still served: %+v", a)
	}
}
