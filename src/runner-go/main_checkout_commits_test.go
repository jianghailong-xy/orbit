package main

import (
	"fmt"
	"reflect"
	"testing"
)

// Real-Git tests for the commits a main checkout has not pushed: the snapshot's list
// (docs/main-checkout-git-contract.md §2).

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

func checkedOut(t *testing.T, repo string) string {
	t.Helper()
	return mustGit(t, repo, "rev-parse", "HEAD")
}

func TestMainCheckoutCommitsListedNewestFirst(t *testing.T) {
	repo := trackingRepo(t)
	if snap := mustScan(t, repo).Snapshot; snap.Commits != nil || snap.CommitsTruncated {
		t.Fatalf("nothing ahead, commits = %+v", snap.Commits)
	}
	commitFile(t, repo, "a.txt", "1\n2\n", "first")
	commitFile(t, repo, "a.txt", "1\nTWO\n3\n", "second")
	mcWrite(t, repo, "dir/é b.txt", "x\n")
	mustGit(t, repo, "mv", "base.txt", "moved.txt")
	mustGit(t, repo, "add", "-A")
	mustGit(t, repo, "commit", "-q", "-m", "third", "-m", "Why it was done.")

	snap := mustScan(t, repo).Snapshot
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

func TestMainCheckoutCommitsCappedAt20(t *testing.T) {
	repo := trackingRepo(t)
	for i := 1; i <= mainCheckoutCommitsMax; i++ {
		mustGit(t, repo, "commit", "-q", "--allow-empty", "-m", fmt.Sprintf("c%d", i))
	}
	if snap := mustScan(t, repo).Snapshot; len(snap.Commits) != 20 || snap.CommitsTruncated {
		t.Fatalf("20 ahead: %d listed, truncated %v", len(snap.Commits), snap.CommitsTruncated)
	}
	for i := 21; i <= 25; i++ {
		mustGit(t, repo, "commit", "-q", "--allow-empty", "-m", fmt.Sprintf("c%d", i))
	}
	snap := mustScan(t, repo).Snapshot
	if snap.Ahead == nil || *snap.Ahead != 25 || len(snap.Commits) != 20 || !snap.CommitsTruncated {
		t.Fatalf("25 ahead: ahead %v, %d listed, truncated %v", snap.Ahead, len(snap.Commits), snap.CommitsTruncated)
	}
	if snap.Commits[0].Subject != "c25" || snap.Commits[19].Subject != "c6" {
		t.Errorf("listed %s … %s, want c25 … c6", snap.Commits[0].Subject, snap.Commits[19].Subject)
	}
}
