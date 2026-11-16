package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// noCheckoutWorktree adds a linked worktree at rev with no files, the way addSessionCheckout starts one.
func noCheckoutWorktree(t *testing.T, repo, rev string) string {
	t.Helper()
	wt := filepath.Join(t.TempDir(), "wt")
	mustGit(t, repo, "worktree", "add", "--no-checkout", "--detach", wt, rev)
	return wt
}

// cloneFilesInto copies paths from template into wt, as populateByCloning clones them: the template's mode and
// mtime, the commit's bytes.
func cloneFilesInto(t *testing.T, template, wt string, paths []string) {
	t.Helper()
	for _, path := range paths {
		src, dst := filepath.Join(template, path), filepath.Join(wt, path)
		info, err := os.Lstat(src)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o777); err != nil {
			t.Fatal(err)
		}
		if err := copyAsAClone(src, dst, info.Mode().Perm()); err != nil {
			t.Fatal(err)
		}
		_ = os.Chtimes(dst, info.ModTime(), info.ModTime())
	}
}

func TestGitIndexRoundTrip(t *testing.T) {
	repo := initRepo(t)
	writeLikeGit(t, repo, map[string]string{
		"a.txt":           "a\n",
		"dir/b.txt":       "b\n",
		"empty":           "",
		"a name with.txt": "space\n",
		"café.txt":        "unicode\n",
	}, 0o644)
	mustGit(t, repo, "add", "-A")
	mustGit(t, repo, "commit", "-q", "-m", "files")

	wt := noCheckoutWorktree(t, repo, "HEAD")
	mustGit(t, wt, "read-tree", "HEAD")
	// A no-cone sparse checkout marks left-out entries skip-worktree, so the index is version 3.
	mustGit(t, wt, "sparse-checkout", "set", "--no-cone", "/*", "!dir/")

	indexPath, err := gitIndexPath(wt)
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	index, err := readGitIndex(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "index")
	if err := index.write(out); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatalf("reading and writing the index changed it: %d bytes before, %d after", len(before), len(after))
	}
}

func TestFillClonedIndexStats(t *testing.T) {
	repo := initRepo(t)
	writeLikeGit(t, repo, map[string]string{
		"dir/a.txt": "a\n",
		"b.txt":     "b\n",
		"empty":     "",
	}, 0o644)
	mustGit(t, repo, "add", "-A")
	mustGit(t, repo, "commit", "-q", "-m", "files")

	wt := noCheckoutWorktree(t, repo, "HEAD")
	mustGit(t, wt, "read-tree", "HEAD")
	paths := []string{"base.txt", "dir/a.txt", "b.txt", "empty"}
	cloneFilesInto(t, repo, wt, paths)

	filled, left, err := fillClonedIndexStats(wt, repo, paths)
	if err != nil {
		t.Fatal(err)
	}
	if filled != len(paths) || left != 0 {
		t.Fatalf("filled %d, left %d, want %d and 0", filled, left, len(paths))
	}

	indexPath, err := gitIndexPath(wt)
	if err != nil {
		t.Fatal(err)
	}
	index, err := readGitIndex(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		entry := index.byPath[path]
		info, err := os.Lstat(filepath.Join(wt, path))
		if err != nil {
			t.Fatal(err)
		}
		stat, ok := clonedIndexStat(info)
		if !ok {
			t.Fatalf("%s: no stat data", path)
		}
		if entry.ctimeSec != stat.ctimeSec || entry.mtimeSec != stat.mtimeSec ||
			entry.dev != stat.dev || entry.ino != stat.ino ||
			entry.uid != stat.uid || entry.gid != stat.gid || entry.size != stat.size {
			t.Errorf("%s: index stat %+v, file %+v", path, entry, stat)
		}
	}

	mustGit(t, wt, "update-index", "-q", "--refresh")
	if status := mustGit(t, wt, "status", "--porcelain"); status != "" {
		t.Errorf("the checkout should read as clean, got %q", status)
	}
}

// TestFillClonedIndexStatsLeavesDoubtfulEntriesToGit holds the fast path to the same rule the reset does: it may only
// trust a clone whose content is certainly the commit's.
func TestFillClonedIndexStatsLeavesDoubtfulEntriesToGit(t *testing.T) {
	repo := initRepo(t)
	writeLikeGit(t, repo, map[string]string{
		"clean.txt":  "clean\n",
		"edited.txt": "as committed\n",
		"staged.txt": "as committed\n",
		"run.sh":     "#!/bin/sh\necho committed\n",
		"hidden.txt": "as committed\n",
	}, 0o644)
	mustGit(t, repo, "add", "-A")
	mustGit(t, repo, "commit", "-q", "-m", "files")

	// The template is left the way a workspace is: an unstaged edit, a staged one, an edit under an
	// assume-unchanged mark, and a skip-worktree file that is gone.
	writeLikeGit(t, repo, map[string]string{"edited.txt": "edited\n"}, 0o644)
	writeLikeGit(t, repo, map[string]string{"staged.txt": "staged\n"}, 0o644)
	mustGit(t, repo, "add", "staged.txt")
	mustGit(t, repo, "update-index", "--assume-unchanged", "run.sh")
	writeLikeGit(t, repo, map[string]string{"run.sh": "#!/bin/sh\necho edited under a mark\n"}, 0o644)
	mustGit(t, repo, "update-index", "--skip-worktree", "hidden.txt")
	if err := os.Remove(filepath.Join(repo, "hidden.txt")); err != nil {
		t.Fatal(err)
	}

	wt := noCheckoutWorktree(t, repo, "HEAD")
	mustGit(t, wt, "read-tree", "HEAD")
	paths := []string{"clean.txt", "edited.txt", "staged.txt", "run.sh"}
	cloneFilesInto(t, repo, wt, paths)

	filled, left, err := fillClonedIndexStats(wt, repo, paths)
	if err != nil {
		t.Fatal(err)
	}
	if filled != 1 || left != 3 {
		t.Fatalf("filled %d, left %d, want 1 and 3", filled, left)
	}

	mustGit(t, wt, "update-index", "-q", "--refresh")
	mustGit(t, wt, "reset", "-q", "--hard")
	for _, path := range append(paths, "hidden.txt") {
		want := mustGit(t, wt, "show", "HEAD:"+path)
		got, err := os.ReadFile(filepath.Join(wt, path))
		if err != nil {
			t.Fatal(err)
		}
		if strings.TrimSpace(string(got)) != want {
			t.Errorf("%s holds %q, the commit %q", path, got, want)
		}
	}
}

func TestFillClonedIndexStatsRefusesADifferentBase(t *testing.T) {
	repo := initRepo(t)
	first := mustGit(t, repo, "rev-parse", "HEAD")
	writeLikeGit(t, repo, map[string]string{"base.txt": "second\n"}, 0o644)
	mustGit(t, repo, "add", "-A")
	mustGit(t, repo, "commit", "-q", "-m", "second")

	// The template is at the second commit; the checkout forks from the first, so its index holds a different blob.
	wt := noCheckoutWorktree(t, repo, first)
	mustGit(t, wt, "read-tree", "HEAD")
	cloneFilesInto(t, repo, wt, []string{"base.txt"})

	filled, left, err := fillClonedIndexStats(wt, repo, []string{"base.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if filled != 0 || left != 1 {
		t.Fatalf("filled %d, left %d, want 0 and 1", filled, left)
	}
	mustGit(t, wt, "update-index", "-q", "--refresh")
	mustGit(t, wt, "reset", "-q", "--hard")
	got, err := os.ReadFile(filepath.Join(wt, "base.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(got)) != "base" {
		t.Errorf("the reset should restore the fork point's content, got %q", got)
	}
}

func TestFillClonedIndexStatsRefusesIndexesItCannotRewrite(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T, wt string)
		want  string
	}{
		{"version 4", func(t *testing.T, wt string) {
			mustGit(t, wt, "update-index", "--index-version", "4")
		}, "version 4"},
		{"split index", func(t *testing.T, wt string) {
			mustGit(t, wt, "update-index", "--split-index")
		}, "split"},
		{"fsmonitor", func(t *testing.T, wt string) {
			mustGit(t, wt, "config", "core.fsmonitor", "true")
		}, "fsmonitor"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			repo := initRepo(t)
			wt := noCheckoutWorktree(t, repo, "HEAD")
			mustGit(t, wt, "read-tree", "HEAD")
			cloneFilesInto(t, repo, wt, []string{"base.txt"})
			test.setup(t, wt)

			indexPath, err := gitIndexPath(wt)
			if err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(indexPath)
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err := fillClonedIndexStats(wt, repo, []string{"base.txt"}); err == nil ||
				!strings.Contains(err.Error(), test.want) {
				t.Fatalf("want an error naming %q, got %v", test.want, err)
			}
			after, err := os.ReadFile(indexPath)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(before, after) {
				t.Errorf("a refused fast path wrote the index")
			}
		})
	}
}
