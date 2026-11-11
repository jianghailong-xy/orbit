package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A git checkout with no origin remote (docs/wiki-repo-tiers-design.md §2.1, the local-git row): nothing can be fetched
// there, so nothing is. A space with no repository address reads it as a folder, when the server allows folders; a space
// with an address cannot hold it to that address, which is wrong_repository at once rather than a fetch tried again.

// newNoOriginCheckout is a git checkout with one commit, a file .gitignore leaves out, and no remote at all.
func newNoOriginCheckout(t *testing.T) string {
	t.Helper()
	dir := newFolder(t)
	mustGit(t, dir, "init", "-q", "-b", "main")
	writeFolder(t, dir, map[string]string{
		"README.md":    "# Local\n\nA repository that was never pushed.\n",
		"docs/plan.md": "# Plan\n\n## Steps\n",
		"main.go":      "package main\n\nfunc main() {}\n",
		".gitignore":   "scratch/\n",
		"scratch/a.md": "# not read\n",
	})
	mustGit(t, dir, "add", "-A")
	mustGit(t, dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "first")
	return dir
}

// noFetchRan says the checkout never fetched: a fetch leaves FETCH_HEAD behind, even one that fails half way.
func noFetchRan(t *testing.T, dir string) {
	t.Helper()
	if _, err := os.Stat(filepath.Join(dir, ".git", "FETCH_HEAD")); err == nil {
		t.Fatalf("%s has a FETCH_HEAD: the operation fetched", dir)
	}
}

func TestWikiRepoOpNoOriginWithoutAddressIsReadAsAFolder(t *testing.T) {
	dir := newNoOriginCheckout(t)
	cmd := folderCommand(dir, "snapshot", nil)
	cmd.RepoURLNorm, cmd.RootCommitSha = "", ""
	index := folderIndex(t, runWikiRepoOp(cmd, nil))
	noFetchRan(t, dir)
	if index.Source != "folder" || !index.NoOrigin {
		t.Fatalf("index source %q noOrigin %v, want a folder read from a checkout with no origin", index.Source, index.NoOrigin)
	}
	if len(index.Commits) != 0 {
		t.Fatalf("a folder's snapshot names no commits, got %v", index.Commits)
	}
	got := strings.Join(indexPaths(index), " ")
	if got != ".gitignore README.md docs/plan.md main.go" {
		t.Fatalf("paths %q: .git and what .gitignore leaves out are not read", got)
	}
	// The same rules as any folder: the tree hash is the folder's, which a read at it is held to.
	read := folderCommand(dir, "read", map[string]interface{}{"sha": index.Sha, "items": []map[string]interface{}{{"path": "main.go"}}})
	read.RepoURLNorm, read.RootCommitSha = "", ""
	if outcome := runWikiRepoOp(read, nil); outcome.state != "succeeded" {
		t.Fatalf("a read at the folder's tree hash failed (%s): %s", outcome.reason, outcome.err)
	}
	noFetchRan(t, dir)
}

func TestWikiRepoOpNoOriginWithAnAddressIsWrongRepository(t *testing.T) {
	dir := newNoOriginCheckout(t)
	for _, kind := range []string{"snapshot", "probe"} {
		cmd := folderCommand(dir, kind, nil)
		outcome := runWikiRepoOp(cmd, nil)
		want := dir + " has no origin remote, so it cannot be checked against github.com/x/app"
		if outcome.state != "failed" || outcome.reason != wikiRepoReasonWrongRepository || outcome.err != want {
			t.Fatalf("%s: outcome = %s reason %q %q, want wrong_repository %q", kind, outcome.state, outcome.reason, outcome.err, want)
		}
	}
	noFetchRan(t, dir)
}

func TestWikiRepoProbeNoOriginWithoutAddressIsFolder(t *testing.T) {
	dir := newNoOriginCheckout(t)
	cmd := folderCommand(dir, "probe", nil)
	cmd.RepoURLNorm, cmd.RootCommitSha = "", ""
	if outcome := runWikiRepoOp(cmd, nil); outcome.state != "succeeded" || outcome.result["tier"] != "folder" {
		t.Fatalf("outcome = %s %v %q, want folder", outcome.state, outcome.result, outcome.err)
	}
}

// A server that does not allow folders (a runner it does not know reads them) gets what it always got: the fetch, and
// its failure.
func TestWikiRepoOpNoOriginWithoutFolderIsAsBefore(t *testing.T) {
	dir := newNoOriginCheckout(t)
	cmd := folderCommand(dir, "snapshot", nil)
	cmd.RepoURLNorm, cmd.RootCommitSha = "", ""
	delete(cmd.Input, "allowFolder")
	if outcome := runWikiRepoOp(cmd, nil); outcome.state != "failed" || outcome.reason != wikiRepoReasonFetchFailed {
		t.Fatalf("outcome = %s reason %q %q, want fetch_failed as before", outcome.state, outcome.reason, outcome.err)
	}
}
