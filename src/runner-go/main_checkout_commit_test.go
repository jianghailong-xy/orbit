package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Real-Git tests for Commit in the main checkout (docs/main-checkout-git-contract.md §5 "commit").

func commitCmd(scan *mainCheckoutScan, msg string, files ...string) MainCheckoutActionCommand {
	return MainCheckoutActionCommand{MainCheckoutActionRequest: MainCheckoutActionRequest{
		Kind: mainCheckoutCommit, Root: scan.Snapshot.Root, Fingerprint: scan.Snapshot.Fingerprint,
		Files: files, Message: msg, RequestID: "req-" + msg,
	}}
}

func runCommit(t *testing.T, cmd MainCheckoutActionCommand) MainCheckoutActionResult {
	t.Helper()
	res, err := commitMainCheckout(context.Background(), cmd)
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	return res
}

func setCommitStep(t *testing.T, fn func(string) error) {
	old := mainCheckoutCommitStep
	mainCheckoutCommitStep = fn
	t.Cleanup(func() { mainCheckoutCommitStep = old })
}

// gitState is everything a commit must leave alone, read without touching the index.
type gitState struct{ head, index, cached, unstaged, untracked string }

func readGitState(t *testing.T, repo string) gitState {
	t.Helper()
	return gitState{
		head:      mustGit(t, repo, "rev-parse", "HEAD"),
		index:     mustGit(t, repo, "ls-files", "-s"),
		cached:    mustGit(t, repo, "diff", "--cached", "HEAD"),
		unstaged:  mustGit(t, repo, "diff"),
		untracked: mustGit(t, repo, "ls-files", "--others", "--exclude-standard"),
	}
}

func mcReadFile(t *testing.T, repo, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(repo, name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func commitCount(t *testing.T, repo, from string) string {
	return mustGit(t, repo, "rev-list", "--count", from+"..HEAD")
}

// The commit holds exactly the chosen files' reviewed content; the chosen paths read clean after;
// every unchosen staged, unstaged and untracked byte is where it was.
func TestMainCheckoutCommitExactTree(t *testing.T) {
	repo := realRepo(t)
	commitFile(t, repo, "mod.txt", "v1\n", "mod")
	commitFile(t, repo, "gone.txt", "bye\n", "gone")
	commitFile(t, repo, "staged-other.txt", "s1\n", "so")
	commitFile(t, repo, "unstaged-other.txt", "u1\n", "uo")
	commitFile(t, repo, "both.txt", "b1\n", "both")
	old := mustGit(t, repo, "rev-parse", "HEAD")

	// Chosen: a modified file that also has a different staged version, a new untracked file, a
	// deletion and an executable new file.
	mcWrite(t, repo, "mod.txt", "staged version\n")
	mustGit(t, repo, "add", "mod.txt")
	mcWrite(t, repo, "mod.txt", "reviewed version\n")
	mcWrite(t, repo, "dir/new file.txt", "brand new\n")
	os.Remove(filepath.Join(repo, "gone.txt"))
	mcWrite(t, repo, "run.sh", "#!/bin/sh\n")
	os.Chmod(filepath.Join(repo, "run.sh"), 0o755)
	// Not chosen.
	mcWrite(t, repo, "staged-other.txt", "s2 staged\n")
	mustGit(t, repo, "add", "staged-other.txt")
	mcWrite(t, repo, "unstaged-other.txt", "u2 unstaged\n")
	mcWrite(t, repo, "both.txt", "b2 staged\n")
	mustGit(t, repo, "add", "both.txt")
	mcWrite(t, repo, "both.txt", "b3 on disk\n")
	mcWrite(t, repo, "stray.txt", "untracked, not chosen\n")

	unchosen := []string{"staged-other.txt", "unstaged-other.txt", "both.txt"}
	stagedBefore := map[string]string{}
	for _, p := range unchosen {
		stagedBefore[p] = mustGit(t, repo, "ls-files", "-s", "--", p)
	}
	unstagedBefore := mustGit(t, repo, "diff", "--", "unstaged-other.txt", "both.txt")
	cachedBefore := mustGit(t, repo, "diff", "--cached", "--", "staged-other.txt", "both.txt")

	scan := mustScan(t, repo)
	reviewed := map[string]string{}
	for _, f := range scan.All {
		reviewed[f.Path] = f.ContentHash
	}
	chosen := []string{"dir/new file.txt", "gone.txt", "mod.txt", "run.sh"}
	res := runCommit(t, commitCmd(scan, "Add retry backoff\n\nbody", chosen...))
	if res.Status != mainCheckoutDone || res.Branch != "main" || res.Subject != "Add retry backoff" || *res.FileCount != 4 {
		t.Fatalf("result %+v", res)
	}
	head := mustGit(t, repo, "rev-parse", "HEAD")
	if res.Head != head || mustGit(t, repo, "rev-parse", "HEAD^") != old {
		t.Fatalf("HEAD %s, result %s, parent should be %s", head, res.Head, old)
	}
	if got := mustGit(t, repo, "log", "-1", "--format=%B"); got != "Add retry backoff\n\nbody" {
		t.Fatalf("message %q", got)
	}

	// Per path: the commit's blob is the reviewed content.
	for _, p := range []string{"dir/new file.txt", "mod.txt", "run.sh"} {
		if got := mustGit(t, repo, "rev-parse", "HEAD:"+p); got != reviewed[p] {
			t.Errorf("%s: commit has %s, reviewed %s", p, got, reviewed[p])
		}
	}
	if gitOK(repo, "cat-file", "-e", "HEAD:gone.txt") {
		t.Errorf("gone.txt still in the commit")
	}
	if mode := strings.Fields(mustGit(t, repo, "ls-tree", "HEAD", "run.sh"))[0]; mode != "100755" {
		t.Errorf("run.sh mode %s", mode)
	}
	// Nothing unchosen got in: those paths are HEAD^'s.
	for _, p := range unchosen {
		if mustGit(t, repo, "rev-parse", "HEAD:"+p) != mustGit(t, repo, "rev-parse", "HEAD^:"+p) {
			t.Errorf("%s changed in the commit", p)
		}
	}
	if gitOK(repo, "cat-file", "-e", "HEAD:stray.txt") {
		t.Error("stray.txt got into the commit")
	}

	// Chosen paths are clean: index == HEAD == working tree.
	if out := mustGit(t, repo, "status", "--porcelain", "--", "mod.txt", "dir/new file.txt", "gone.txt", "run.sh"); out != "" {
		t.Errorf("chosen paths not clean:\n%s", out)
	}
	// Unchosen content is byte-identical.
	for _, p := range unchosen {
		if got := mustGit(t, repo, "ls-files", "-s", "--", p); got != stagedBefore[p] {
			t.Errorf("%s index entry %q, was %q", p, got, stagedBefore[p])
		}
	}
	if got := mustGit(t, repo, "diff", "--", "unstaged-other.txt", "both.txt"); got != unstagedBefore {
		t.Errorf("unstaged diff changed:\n%s\nwas\n%s", got, unstagedBefore)
	}
	if got := mustGit(t, repo, "diff", "--cached", "--", "staged-other.txt", "both.txt"); got != cachedBefore {
		t.Errorf("staged diff changed:\n%s\nwas\n%s", got, cachedBefore)
	}
	if mcReadFile(t, repo, "both.txt") != "b3 on disk\n" || mcReadFile(t, repo, "unstaged-other.txt") != "u2 unstaged\n" ||
		mcReadFile(t, repo, "stray.txt") != "untracked, not chosen\n" {
		t.Error("working-tree content of unchosen files changed")
	}
	if !strings.Contains(mustGit(t, repo, "ls-files", "--others", "--exclude-standard"), "stray.txt") {
		t.Error("stray.txt is no longer untracked")
	}
}

func gitOK(dir string, args ...string) bool {
	_, err := git(dir, args...)
	return err == nil
}

// A write after the review refuses with FINGERPRINT_STALE and commits nothing.
func TestMainCheckoutCommitExternalWriteIsStale(t *testing.T) {
	repo := realRepo(t)
	mcWrite(t, repo, "a.txt", "reviewed\n")
	mcWrite(t, repo, "b.txt", "other\n")
	scan := mustScan(t, repo)
	mcWrite(t, repo, "b.txt", "written after review\n")
	mcWrite(t, repo, "c.txt", "new after review\n")
	before := readGitState(t, repo)

	// The refusal names what changed since the review (board 03), not the file that didn't.
	res := runCommit(t, commitCmd(scan, "x", "a.txt"))
	if res.Status != mainCheckoutRefused || res.Code != mainCheckoutFingerprintStale || strings.Join(res.Paths, ",") != "b.txt,c.txt" {
		t.Fatalf("result %+v", res)
	}
	if after := readGitState(t, repo); after != before {
		t.Fatalf("state changed:\n%+v\n%+v", before, after)
	}
}

// A write to a chosen file between the fingerprint check and the blob write is caught by its
// content hash, and named.
func TestMainCheckoutCommitChosenFileChangedMidwayIsStale(t *testing.T) {
	repo := realRepo(t)
	mcWrite(t, repo, "a.txt", "reviewed\n")
	scan := mustScan(t, repo)
	reviewed := map[string]MainCheckoutFile{"a.txt": *fileByPath(scan.All, "a.txt")}
	mcWrite(t, repo, "a.txt", "changed\n")
	_, stale, err := mainCheckoutCommitEntries(context.Background(), repo, scan.Snapshot.Head, []string{"a.txt"}, reviewed)
	if err != nil || len(stale) != 1 || stale[0] != "a.txt" {
		t.Fatalf("stale %v err %v", stale, err)
	}
}

// HEAD moving before the action refuses with HEAD_MOVED and the new HEAD.
func TestMainCheckoutCommitHeadMovedBeforeCheck(t *testing.T) {
	repo := realRepo(t)
	mcWrite(t, repo, "a.txt", "x\n")
	scan := mustScan(t, repo)
	commitFile(t, repo, "other.txt", "o\n", "elsewhere")
	mustGit(t, repo, "reset", "-q")
	moved := mustGit(t, repo, "rev-parse", "HEAD")
	res := runCommit(t, commitCmd(scan, "x", "a.txt"))
	if res.Status != mainCheckoutRefused || res.Code != mainCheckoutHeadMoved || res.Head != moved {
		t.Fatalf("result %+v", res)
	}
	if mustGit(t, repo, "rev-parse", "HEAD") != moved {
		t.Fatal("ref changed")
	}
}

// HEAD moving between the check and update-ref: the CAS fails and the ref is left where the
// other writer put it.
func TestMainCheckoutCommitHeadMovedBeforeUpdateRef(t *testing.T) {
	repo := realRepo(t)
	mcWrite(t, repo, "a.txt", "x\n")
	scan := mustScan(t, repo)
	var moved string
	setCommitStep(t, func(step string) error {
		if step == "commit-tree" {
			moved = mustGit(t, repo, "commit-tree", "-p", "HEAD", "-m", "racer", mustGit(t, repo, "rev-parse", "HEAD^{tree}"))
			mustGit(t, repo, "update-ref", "refs/heads/main", moved)
		}
		return nil
	})
	indexBefore := mustGit(t, repo, "ls-files", "-s")
	res := runCommit(t, commitCmd(scan, "x", "a.txt"))
	if res.Status != mainCheckoutRefused || res.Code != mainCheckoutHeadMoved || res.Head != moved {
		t.Fatalf("result %+v", res)
	}
	if got := mustGit(t, repo, "rev-parse", "refs/heads/main"); got != moved {
		t.Fatalf("ref %s, want the racer's %s", got, moved)
	}
	if mustGit(t, repo, "ls-files", "-s") != indexBefore {
		t.Fatal("index changed")
	}
}

func TestMainCheckoutCommitRefusals(t *testing.T) {
	t.Run("merge in progress", func(t *testing.T) {
		repo := realRepo(t)
		commitFile(t, repo, "f.txt", "base\n", "f")
		mustGit(t, repo, "checkout", "-q", "-b", "side")
		commitFile(t, repo, "f.txt", "side\n", "side")
		mustGit(t, repo, "checkout", "-q", "main")
		commitFile(t, repo, "f.txt", "main\n", "main")
		git(repo, "merge", "side") // conflicts
		mcWrite(t, repo, "new.txt", "n\n")
		scan := mustScan(t, repo)
		before := readGitState(t, repo)
		res := runCommit(t, commitCmd(scan, "x", "new.txt"))
		if res.Code != mainCheckoutCheckoutBlocked || res.State != repoStateMerge || res.Status != mainCheckoutRefused {
			t.Fatalf("result %+v", res)
		}
		if readGitState(t, repo) != before {
			t.Fatal("state changed")
		}
	})
	t.Run("cherry-pick in progress", func(t *testing.T) {
		repo := realRepo(t)
		commitFile(t, repo, "f.txt", "base\n", "f")
		mustGit(t, repo, "checkout", "-q", "-b", "side")
		commitFile(t, repo, "f.txt", "side\n", "side")
		pick := mustGit(t, repo, "rev-parse", "HEAD")
		mustGit(t, repo, "checkout", "-q", "main")
		commitFile(t, repo, "f.txt", "main\n", "main")
		git(repo, "cherry-pick", pick)
		mcWrite(t, repo, "new.txt", "n\n")
		scan := mustScan(t, repo)
		res := runCommit(t, commitCmd(scan, "x", "new.txt"))
		if res.Code != mainCheckoutCheckoutBlocked || res.State != repoStateCherryPick {
			t.Fatalf("result %+v", res)
		}
	})
	t.Run("detached", func(t *testing.T) {
		repo := realRepo(t)
		mustGit(t, repo, "checkout", "-q", "--detach")
		mcWrite(t, repo, "new.txt", "n\n")
		scan := mustScan(t, repo)
		before := readGitState(t, repo)
		res := runCommit(t, commitCmd(scan, "x", "new.txt"))
		if res.Code != mainCheckoutDetached || res.Status != mainCheckoutRefused {
			t.Fatalf("result %+v", res)
		}
		if readGitState(t, repo) != before {
			t.Fatal("state changed")
		}
	})
	t.Run("unborn", func(t *testing.T) {
		repo := t.TempDir()
		mustGit(t, repo, "init", "-q", "-b", "main")
		mcWrite(t, repo, "new.txt", "n\n")
		scan := mustScan(t, repo)
		res := runCommit(t, commitCmd(scan, "x", "new.txt"))
		if res.Code != mainCheckoutNoHead || res.Status != mainCheckoutRefused {
			t.Fatalf("result %+v", res)
		}
		if gitOK(repo, "rev-parse", "--verify", "HEAD") {
			t.Fatal("a commit was made")
		}
	})
	t.Run("path not in the review", func(t *testing.T) {
		repo := realRepo(t)
		mcWrite(t, repo, "new.txt", "n\n")
		scan := mustScan(t, repo)
		res := runCommit(t, commitCmd(scan, "x", "base.txt"))
		if res.Code != mainCheckoutFingerprintStale || len(res.Paths) != 1 || res.Paths[0] != "base.txt" {
			t.Fatalf("result %+v", res)
		}
	})
}

// A crash after each writing step, then the same request again: exactly one commit, holding the
// reviewed content, and the chosen paths clean.
func TestMainCheckoutCommitCrashRedo(t *testing.T) {
	for _, crashAt := range []string{"commit-tree", "update-ref", "index-align"} {
		t.Run(crashAt, func(t *testing.T) {
			repo := realRepo(t)
			old := mustGit(t, repo, "rev-parse", "HEAD")
			mcWrite(t, repo, "a.txt", "reviewed\n")
			mcWrite(t, repo, "keep.txt", "not chosen\n")
			scan := mustScan(t, repo)
			reviewed := fileByPath(scan.All, "a.txt").ContentHash
			cmd := commitCmd(scan, "crash", "a.txt")

			setCommitStep(t, func(step string) error {
				if step == crashAt {
					return errors.New("crash")
				}
				return nil
			})
			if _, err := commitMainCheckout(context.Background(), cmd); err == nil {
				t.Fatal("the crash did not stop it")
			}
			mainCheckoutCommitStep = func(string) error { return nil }

			res := runCommit(t, cmd)
			if res.Status != mainCheckoutDone {
				t.Fatalf("redo result %+v", res)
			}
			if n := commitCount(t, repo, old); n != "1" {
				t.Fatalf("%s commits on main after the redo", n)
			}
			if res.Head != mustGit(t, repo, "rev-parse", "HEAD") || mustGit(t, repo, "rev-parse", "HEAD:a.txt") != reviewed {
				t.Fatalf("result %+v", res)
			}
			if out := mustGit(t, repo, "status", "--porcelain", "--", "a.txt"); out != "" {
				t.Fatalf("a.txt not clean: %s", out)
			}
			if out := mustGit(t, repo, "status", "--porcelain", "--", "keep.txt"); out != "?? keep.txt" {
				t.Fatalf("keep.txt: %q", out)
			}

			// And once more: still one commit.
			res = runCommit(t, cmd)
			if res.Status != mainCheckoutDone || commitCount(t, repo, old) != "1" {
				t.Fatalf("third run %+v, %s commits", res, commitCount(t, repo, old))
			}
		})
	}
}

// A symlink and a file with an odd name commit as what was reviewed.
func TestMainCheckoutCommitSymlinkAndOddName(t *testing.T) {
	repo := realRepo(t)
	if err := os.Symlink("base.txt", filepath.Join(repo, "link")); err != nil {
		t.Skip(err)
	}
	mcWrite(t, repo, "we ird [x]*.txt", "odd\n")
	scan := mustScan(t, repo)
	res := runCommit(t, commitCmd(scan, "odd", "link", "we ird [x]*.txt"))
	if res.Status != mainCheckoutDone {
		t.Fatalf("result %+v", res)
	}
	if mode := strings.Fields(mustGit(t, repo, "ls-tree", "HEAD", "link"))[0]; mode != "120000" {
		t.Fatalf("link mode %s", mode)
	}
	if out := mustGit(t, repo, "status", "--porcelain"); out != "" {
		t.Fatalf("not clean: %s", out)
	}
}
