package main

import (
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// The folder tier (docs/wiki-repo-tiers-design.md §4, contract `repoOps.folder`): a working directory that is not a git
// checkout is scanned as it stands when the server allows it, and a snapshot of it is the same index a git snapshot is,
// named by its tree hash.

// writeFolder lays files out under root: a path to its content.
func writeFolder(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		full := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// folderCommand is an operation on a folder the server allows to be read as one.
func folderCommand(dir, kind string, input map[string]interface{}) WikiRepoOpCommand {
	if input == nil {
		input = map[string]interface{}{}
	}
	input["allowFolder"] = true
	return WikiRepoOpCommand{
		ID: "op-folder", Kind: kind, ClaimGeneration: 1, LeaseOwner: "00000000-0000-0000-0000-0000000000aa",
		// A space with a repository address still reads its non-git folder (owner 2026-11-11, Q1-A): the server, not the
		// runner, holds the folder to the space by its paths.
		WorkDir: dir, RepoURLNorm: "github.com/x/app", RootCommitSha: strings.Repeat("a", 40), Input: input,
	}
}

// folderIndex is the snapshot a folder answers with, read back.
func folderIndex(t *testing.T, outcome wikiRepoOpOutcome) wikiRepoOpIndex {
	t.Helper()
	if outcome.state != "succeeded" {
		t.Fatalf("the folder snapshot failed (%s): %s", outcome.reason, outcome.err)
	}
	raw, _ := outcome.result["index"].(string)
	if raw == "" {
		t.Fatalf("the folder snapshot carried no index: %v", outcome.result)
	}
	var index wikiRepoOpIndex
	if err := json.Unmarshal([]byte(raw), &index); err != nil {
		t.Fatalf("the index did not read back: %v", err)
	}
	return index
}

func indexPaths(index wikiRepoOpIndex) []string {
	var out []string
	for _, file := range index.Files {
		out = append(out, file.Path)
	}
	return out
}

func newFolder(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, "app")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

// The capability is declared, so the server knows this runner may be handed allowFolder.
func TestWikiRepoOpFolderCapabilityIsDeclared(t *testing.T) {
	if !contains(strings.Split(runnerCapabilitiesV1, ","), wikiRepoOpFolderCapabilityV1) || wikiRepoOpFolderCapabilityV1 != "wiki-repo-op-folder/v1" {
		t.Fatalf("the runner does not declare %s: %s", "wiki-repo-op-folder/v1", runnerCapabilitiesV1)
	}
}

// Without allowFolder a folder that is not git is still not_git: an old control plane sees no change.
func TestWikiRepoOpFolderNeedsTheServersLeave(t *testing.T) {
	dir := newFolder(t)
	writeFolder(t, dir, map[string]string{"notes.md": "# notes\n"})
	cmd := folderCommand(dir, "snapshot", nil)
	cmd.Input = map[string]interface{}{}
	outcome := runWikiRepoOp(cmd, nil)
	if outcome.state != "failed" || outcome.reason != wikiRepoReasonNotGit {
		t.Fatalf("outcome = %s %q %q, want failed not_git", outcome.state, outcome.reason, outcome.err)
	}
}

// The built-in exclusions come before .gitignore and cannot be re-included by it; .gitignore at every level is read
// after them, as git reads it, though the folder has no .git.
func TestWikiRepoOpFolderExclusionsComeBeforeGitignore(t *testing.T) {
	dir := newFolder(t)
	writeFolder(t, dir, map[string]string{
		".gitignore":              "!.env\n!*.pem\n!node_modules/\nsecret.txt\n/build-notes.md\nlogs/\n",
		".env":                    "TOKEN=shh\n",
		".env.local":              "TOKEN=shh\n",
		"server.pem":              "-----BEGIN-----\n",
		"deploy.key":              "k\n",
		"cert.p12":                "p\n",
		"id_rsa":                  "k\n",
		"id_ed25519.pub":          "k\n",
		".npmrc":                  "//registry/:_authToken=x\n",
		".netrc":                  "machine x\n",
		".ssh/config":             "Host x\n",
		".aws/credentials":        "[default]\n",
		"node_modules/x/index.js": "module.exports = 1\n",
		"web/node_modules/y.js":   "1\n",
		".venv/lib.py":            "1\n",
		"venv/lib.py":             "1\n",
		"pkg/__pycache__/a.pyc":   "1\n",
		"target/a.class":          "1\n",
		"dist/app.js":             "1\n",
		"build/out.o":             "1\n",
		".next/cache":             "1\n",
		".gradle/x":               "1\n",
		"ios/DerivedData/x":       "1\n",
		".git/config":             "[core]\n",
		"secret.txt":              "no\n",
		"build-notes.md":          "no\n",
		"docs/build-notes.md":     "# kept: the pattern is anchored to the root\n",
		"logs/today.txt":          "no\n",
		"src/main.go":             "package main\n\nfunc Main() {}\n",
		"src/.gitignore":          "*.log\n!keep.log\n",
		"src/run.log":             "no\n",
		"src/keep.log":            "kept\n",
		"src/deep/trace.log":      "no\n",
		"README.md":               "# app\n\nThe application this folder holds, read without git as it stands.\n",
	})
	index := folderIndex(t, runWikiRepoOp(folderCommand(dir, "snapshot", nil), nil))
	got := indexPaths(index)
	want := []string{".gitignore", "README.md", "docs/build-notes.md", "src/.gitignore", "src/keep.log", "src/main.go"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("files = %v, want %v", got, want)
	}
}

// A symbolic link is not followed and not recorded: neither one to a file outside the folder nor one inside it.
func TestWikiRepoOpFolderDoesNotFollowSymlinks(t *testing.T) {
	dir := newFolder(t)
	outside := filepath.Join(filepath.Dir(dir), "outside")
	writeFolder(t, outside, map[string]string{"secret.md": "# outside\n", "more/x.go": "package more\n"})
	writeFolder(t, dir, map[string]string{"a.md": "# a\n"})
	for name, target := range map[string]string{
		"out.md":   filepath.Join(outside, "secret.md"),
		"outdir":   filepath.Join(outside, "more"),
		"inner.md": filepath.Join(dir, "a.md"),
	} {
		if err := os.Symlink(target, filepath.Join(dir, name)); err != nil {
			t.Skipf("no symlinks here: %v", err)
		}
	}
	index := folderIndex(t, runWikiRepoOp(folderCommand(dir, "snapshot", nil), nil))
	if got := strings.Join(indexPaths(index), ","); got != "a.md" {
		t.Fatalf("files = %s, want only a.md", got)
	}
	// Nor is one read through: a read of the link's path is a path the folder does not have.
	read := runWikiRepoOp(folderCommand(dir, "read", map[string]interface{}{
		"sha": index.Sha, "items": []map[string]interface{}{{"path": "out.md"}, {"path": "outdir/x.go"}},
	}), nil)
	answer := decodeResult[wikiRepoOpReadAnswer](t, read, "read")
	for _, piece := range answer.Items {
		if piece.Found || piece.Text != "" {
			t.Fatalf("%s was read through a symlink: %+v", piece.Path, piece)
		}
	}
}

// The snapshot is the git snapshot's index plus source "folder", each file's sha256, and no commits; its sha is the tree
// hash of §4.2. A binary file is recorded by its path, its size and its hash, and nothing is read of it.
func TestWikiRepoOpFolderSnapshotIsTheIndexNamedByItsTreeHash(t *testing.T) {
	dir := newFolder(t)
	writeFolder(t, dir, map[string]string{
		"README.md":                     "# app\n\nThe application this folder holds, read without git as it stands.\n",
		"docs/design.md":                "# The design\n\n## Folders\n\ntext\n",
		"src/a.ts":                      "export function alphaOne() {\n  return 1;\n}\n",
		"contracts/thing.contract.json": "{\"table\": \"thing\", \"states\": []}\n",
		"img/logo.png":                  "\x89PNG\x00\x00binary",
	})
	outcome := runWikiRepoOp(folderCommand(dir, "snapshot", nil), nil)
	index := folderIndex(t, outcome)
	if index.Source != "folder" || index.Commits == nil || len(index.Commits) != 0 || index.Date == "" {
		t.Fatalf("source %q, commits %v, date %q: want folder, [] and the time it was built", index.Source, index.Commits, index.Date)
	}
	if !strings.Contains(outcome.result["index"].(string), `"commits":[]`) {
		t.Fatalf("commits is not written as an empty list: %s", outcome.result["index"])
	}
	var lines []string
	for _, file := range index.Files {
		content, _ := os.ReadFile(filepath.Join(dir, filepath.FromSlash(file.Path)))
		sum := sha256.Sum256(content)
		if file.Hash != hex.EncodeToString(sum[:]) || file.Size != int64(len(content)) {
			t.Fatalf("%s: hash %s size %d, want %x and %d", file.Path, file.Hash, file.Size, sum, len(content))
		}
		lines = append(lines, fmt.Sprintf("%s\x00%d\x00%s\n", file.Path, file.Size, file.Hash))
	}
	sort.Strings(lines)
	tree := sha1.Sum([]byte(strings.Join(lines, "")))
	if index.Sha != hex.EncodeToString(tree[:]) || outcome.result["sha"] != index.Sha {
		t.Fatalf("sha %s (result %v), want the tree hash %x", index.Sha, outcome.result["sha"], tree)
	}
	if len(index.Docs) != 2 || index.Docs[0].Path != "docs/design.md" || index.Docs[0].Title != "The design" {
		t.Fatalf("docs = %+v", index.Docs)
	}
	if strings.Join(index.Symbols["src/a.ts"], ",") != "alphaOne()" {
		t.Fatalf("symbols = %v", index.Symbols)
	}
	if len(index.Contracts) != 1 || strings.Join(index.Contracts[0].Keys, ",") != "states,table" {
		t.Fatalf("contracts = %+v", index.Contracts)
	}
	if !strings.HasPrefix(index.Readme, "The application this folder holds") {
		t.Fatalf("readme = %q", index.Readme)
	}
	// The server already holds this tree: nothing is built or sent.
	skipped := runWikiRepoOp(folderCommand(dir, "snapshot", map[string]interface{}{"skipSha": index.Sha}), nil)
	if skipped.state != "succeeded" || skipped.result["skipped"] != true || skipped.result["sha"] != index.Sha {
		t.Fatalf("skip = %+v", skipped)
	}
}

// The same files give the same tree hash wherever they are; one byte more is another tree.
func TestWikiRepoOpFolderTreeHashIsTheFiles(t *testing.T) {
	files := map[string]string{"a.md": "# a\n", "src/b.go": "package b\n", "z/c.txt": "c\n"}
	one, two := newFolder(t), filepath.Join(t.TempDir(), "elsewhere")
	writeFolder(t, one, files)
	writeFolder(t, two, files)
	first := folderIndex(t, runWikiRepoOp(folderCommand(one, "snapshot", nil), nil)).Sha
	if again := folderIndex(t, runWikiRepoOp(folderCommand(two, "snapshot", nil), nil)).Sha; again != first {
		t.Fatalf("the same files hash %s and %s", first, again)
	}
	writeFolder(t, two, map[string]string{"src/b.go": "package c\n"})
	if changed := folderIndex(t, runWikiRepoOp(folderCommand(two, "snapshot", nil), nil)).Sha; changed == first {
		t.Fatalf("a changed byte left the tree hash at %s", first)
	}
}

// More files than repoOps.folder.maxFiles, counted after the exclusions, is no snapshot: too_many_files.
func TestWikiRepoOpFolderTooManyFiles(t *testing.T) {
	dir := newFolder(t)
	writeFolder(t, dir, map[string]string{"a": "1", "b": "2", "c": "3", "node_modules/d": "4", "node_modules/e": "5"})
	saved := wikiRepoFolderMaxFiles
	t.Cleanup(func() { wikiRepoFolderMaxFiles = saved })
	wikiRepoFolderMaxFiles = 3
	if outcome := runWikiRepoOp(folderCommand(dir, "snapshot", nil), nil); outcome.state != "succeeded" {
		t.Fatalf("three files after the exclusions failed: %s", outcome.err)
	}
	writeFolder(t, dir, map[string]string{"f": "6"})
	outcome := runWikiRepoOp(folderCommand(dir, "snapshot", nil), nil)
	if outcome.state != "failed" || outcome.reason != wikiRepoReasonTooManyFiles {
		t.Fatalf("outcome = %s %q %q, want failed too_many_files", outcome.state, outcome.reason, outcome.err)
	}
	if wikiRepoFolderMaxFiles = saved; saved != 100000 {
		t.Fatalf("maxFiles = %d, want the contract's 100000", saved)
	}
}

// A read at the tree hash reads the files on disk; once the folder has moved on, it is folder_moved.
func TestWikiRepoOpFolderReadChecksTheTreeHash(t *testing.T) {
	dir := newFolder(t)
	writeFolder(t, dir, map[string]string{"docs/a.md": "# A\n\n## One\n\nfirst\n\n## Two\n\nsecond\n", ".env": "TOKEN=1\n"})
	sha := folderIndex(t, runWikiRepoOp(folderCommand(dir, "snapshot", nil), nil)).Sha
	read := runWikiRepoOp(folderCommand(dir, "read", map[string]interface{}{
		"sha": sha, "items": []map[string]interface{}{{"path": "docs/a.md"}, {"path": "docs/a.md", "section": "Two"}, {"path": ".env"}, {"path": "nope.md"}},
	}), nil)
	answer := decodeResult[wikiRepoOpReadAnswer](t, read, "read")
	if answer.Sha != sha || len(answer.Items) != 4 {
		t.Fatalf("answer = %+v", answer)
	}
	if !answer.Items[0].Found || !strings.Contains(answer.Items[0].Text, "## One") {
		t.Fatalf("whole file = %+v", answer.Items[0])
	}
	if !answer.Items[1].Found || answer.Items[1].Text != "## Two\n\nsecond" {
		t.Fatalf("section = %+v", answer.Items[1])
	}
	if answer.Items[2].Found || answer.Items[2].Text != "" || answer.Items[3].Found {
		t.Fatalf("an excluded or absent file was read: %+v %+v", answer.Items[2], answer.Items[3])
	}
	writeFolder(t, dir, map[string]string{"docs/a.md": "# A, edited\n"})
	moved := runWikiRepoOp(folderCommand(dir, "read", map[string]interface{}{
		"sha": sha, "items": []map[string]interface{}{{"path": "docs/a.md"}},
	}), nil)
	if moved.state != "failed" || moved.reason != wikiRepoReasonFolderMoved {
		t.Fatalf("outcome = %s %q %q, want failed folder_moved", moved.state, moved.reason, moved.err)
	}
}

// Anchors on a folder: a path is there or not (a file or a directory), a symbol is found and its region hashed as git
// grep finds it, and an excluded file is not there. A commit anchor is not checked on a folder.
func TestWikiRepoOpFolderChecksPathAndSymbolAnchors(t *testing.T) {
	dir := newFolder(t)
	body := "package app\n\n// alphaOneX is not it\nfunc alphaOne() int {\n\treturn 1\n}\n"
	writeFolder(t, dir, map[string]string{"src/app/a.go": body, "src/app/b.go": "package app\n\nvar beta = alphaOne()\n", ".env": "alphaOne=1\n"})
	region, ok := wikiSymbolRegionSha256([]byte(body), 4)
	if !ok {
		t.Fatal("no region")
	}
	sha := folderIndex(t, runWikiRepoOp(folderCommand(dir, "snapshot", nil), nil)).Sha
	outcome := runWikiRepoOp(folderCommand(dir, "anchors", map[string]interface{}{
		"sha": sha,
		"anchors": []map[string]interface{}{
			{"index": 0, "type": "path", "path": "src/app/a.go"},
			{"index": 1, "type": "path", "path": "./src/app/"},
			{"index": 2, "type": "path", "path": "src/gone.go"},
			{"index": 3, "type": "path", "path": ".env"},
			{"index": 4, "type": "symbol", "path": "src/app/a.go", "symbol": "alphaOne"},
			{"index": 5, "type": "symbol", "path": "src/app", "symbol": "alphaOne", "regionSha256": region},
			{"index": 6, "type": "symbol", "path": "src/app/a.go", "symbol": "alphaOne", "regionSha256": strings.Repeat("0", 64)},
			{"index": 7, "type": "symbol", "path": "src/app/a.go", "symbol": "gammaThree"},
			{"index": 8, "type": "symbol", "path": ".env", "symbol": "alphaOne"},
		},
	}), nil)
	answer := decodeResult[wikiRepoOpAnchorsAnswer](t, outcome, "anchors")
	if answer.Sha != sha {
		t.Fatalf("checked at %s, want the tree %s", answer.Sha, sha)
	}
	want := []struct{ state, region string }{
		{"verified", ""}, {"verified", ""}, {"missing", ""}, {"missing", ""},
		{"verified", region}, {"verified", region}, {"changed", region}, {"missing", ""}, {"missing", ""},
	}
	if len(answer.Anchors) != len(want) {
		t.Fatalf("answered %d checks, want %d", len(answer.Anchors), len(want))
	}
	for i, check := range answer.Anchors {
		if check.Index != i || check.State != want[i].state || check.RegionSha256 != want[i].region {
			t.Fatalf("check %d = %+v, want %s %s", i, check, want[i].state, want[i].region)
		}
	}
	commit := runWikiRepoOp(folderCommand(dir, "anchors", map[string]interface{}{
		"anchors": []map[string]interface{}{{"index": 0, "type": "commit", "sha": strings.Repeat("b", 40)}},
	}), nil)
	if commit.state != "failed" || !strings.Contains(commit.err, "not checked on a folder") {
		t.Fatalf("a commit anchor on a folder = %s %q, want failed", commit.state, commit.err)
	}
}

// git grep -w's word: a hit that is part of a longer word is skipped, and a later one on the same line still counts.
func TestWikiFolderWordHit(t *testing.T) {
	for _, c := range []struct {
		line string
		want bool
	}{
		{"alphaOne()", true}, {"x alphaOne", true}, {"alphaOneX", false}, {"_alphaOne", false},
		{"alphaOneX alphaOne", true}, {"a.alphaOne.b", true},
	} {
		if got := wikiFolderWordHit(c.line, "alphaOne"); got != c.want {
			t.Fatalf("%q: %v, want %v", c.line, got, c.want)
		}
	}
}
