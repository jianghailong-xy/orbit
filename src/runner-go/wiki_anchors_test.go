package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// An entry's anchors checked with git (wiki_anchors.go, contract `anchorRules.verify`), against real
// repositories: a bare origin, a checkout of it whose origin/main is behind until something fetches, and the
// checks the anchors repository operation runs (wiki_repo_ops_test.go runs them through the operation) — a sha
// that is not an ancestor of origin/main among them — and the fetch every repository operation makes first.

// ── the repositories ────────────────────────────────────────────────────────────────────────────

// symbolFile is src/a.ts as the first commit writes it: `foo` first occurs inside `fooBar` (not a
// whole word), and as a whole word on line 4, with more than a region's worth of lines after it.
func symbolFile(changedLine string) string {
	lines := []string{"// helpers", "export function fooBar() { return 0; }", "", "export function foo(x: number) {"}
	for i := 1; i <= 26; i++ {
		lines = append(lines, fmt.Sprintf("  const v%d = x + %d;", i, i))
	}
	if changedLine != "" {
		lines[5] = changedLine
	}
	return strings.Join(append(lines, "}"), "\n") + "\n"
}

// regionOf is the region hash, worked out here rather than by the code under test: the lines from the
// 1-based line `from`, twenty of them or to the end, each ended by a newline.
func regionOf(content string, from int) string {
	lines := strings.Split(strings.TrimSuffix(content, "\n"), "\n")
	end := from - 1 + 20
	if end > len(lines) {
		end = len(lines)
	}
	sum := sha256.Sum256([]byte(strings.Join(lines[from-1:end], "\n") + "\n"))
	return hex.EncodeToString(sum[:])
}

// wikiAnchorsFixture is a bare origin, the seed repository that pushes to it, and a checkout of it under
// $HOME whose origin/main stays where the clone left it until something fetches.
type wikiAnchorsFixture struct {
	home, bare, seed, checkout string
	first                      string
}

func newWikiAnchorsFixture(t *testing.T) *wikiAnchorsFixture {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	f := &wikiAnchorsFixture{home: home, bare: filepath.Join(home, "origin.git"), seed: filepath.Join(home, "seed"), checkout: filepath.Join(home, "orbit")}
	mustGit(t, home, "init", "-q", "--bare", "-b", "main", f.bare)
	if err := os.MkdirAll(f.seed, 0o755); err != nil {
		t.Fatal(err)
	}
	mustGit(t, f.seed, "init", "-q", "-b", "main")
	mustGit(t, f.seed, "config", "user.email", "test@orbit")
	mustGit(t, f.seed, "config", "user.name", "Test")
	f.write(t, "docs/a.md", "the design\n")
	f.write(t, "docs/b.md", "the other half\n")
	f.write(t, "src/a.ts", symbolFile(""))
	mustGit(t, f.seed, "add", ".")
	mustGit(t, f.seed, "commit", "-q", "-m", "first")
	f.first = mustGit(t, f.seed, "rev-parse", "HEAD")
	mustGit(t, f.seed, "remote", "add", "origin", f.bare)
	mustGit(t, f.seed, "push", "-q", "origin", "main")
	mustGit(t, home, "clone", "-q", f.bare, f.checkout)
	mustGit(t, f.checkout, "config", "user.email", "test@orbit")
	mustGit(t, f.checkout, "config", "user.name", "Test")
	return f
}

func (f *wikiAnchorsFixture) write(t *testing.T, name, content string) {
	t.Helper()
	path := filepath.Join(f.seed, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// push lands a commit on origin's main from the seed: the checkout does not see it until it fetches.
func (f *wikiAnchorsFixture) push(t *testing.T, message string, change func()) string {
	t.Helper()
	change()
	mustGit(t, f.seed, "add", "-A")
	mustGit(t, f.seed, "commit", "-q", "-m", message)
	mustGit(t, f.seed, "push", "-q", "origin", "main")
	return mustGit(t, f.seed, "rev-parse", "HEAD")
}

// sideCommit is a commit the checkout has on a branch of its own and main never got.
func (f *wikiAnchorsFixture) sideCommit(t *testing.T) string {
	t.Helper()
	mustGit(t, f.checkout, "checkout", "-q", "-b", "side")
	if err := os.WriteFile(filepath.Join(f.checkout, "side.txt"), []byte("never merged\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGit(t, f.checkout, "add", "side.txt")
	mustGit(t, f.checkout, "commit", "-q", "-m", "side")
	sha := mustGit(t, f.checkout, "rev-parse", "HEAD")
	mustGit(t, f.checkout, "checkout", "-q", "main")
	return sha
}

// ── the checks ──────────────────────────────────────────────────────────────────────────────────

// The criterion's own words: a sha that is not an ancestor of origin/main is missing — even one the
// checkout has, on a branch of its own, and even one origin has on another branch.
func TestWikiAnchorsNonAncestorShaIsMissing(t *testing.T) {
	f := newWikiAnchorsFixture(t)
	side := f.sideCommit(t)
	// A branch origin has and main does not: fetched by nobody here, and pushed from the seed.
	mustGit(t, f.seed, "checkout", "-q", "-b", "feature")
	f.write(t, "feature.txt", "on a branch\n")
	mustGit(t, f.seed, "add", "feature.txt")
	mustGit(t, f.seed, "commit", "-q", "-m", "feature")
	feature := mustGit(t, f.seed, "rev-parse", "HEAD")
	mustGit(t, f.seed, "push", "-q", "origin", "feature")
	mustGit(t, f.checkout, "fetch", "-q", "origin", "feature")
	for _, sha := range []string{side, feature} {
		state, err := checkWikiCommitAnchor(f.checkout, f.first, sha)
		if err != nil || state != "missing" {
			t.Errorf("commit %s, not an ancestor of %s: %q, %v — want missing", sha, f.first, state, err)
		}
	}
	if state, err := checkWikiCommitAnchor(f.checkout, f.first, f.first); err != nil || state != "verified" {
		t.Errorf("origin/main's own commit: %q, %v — want verified", state, err)
	}
	if state, err := checkWikiCommitAnchor(f.checkout, f.first, strings.ToUpper(f.first)); err != nil || state != "verified" {
		t.Errorf("the same sha in capitals: %q, %v — want verified", state, err)
	}
	if state, err := checkWikiCommitAnchor(f.checkout, f.first, "41e75ba35"); err != nil || state != "missing" {
		t.Errorf("a short sha: %q, %v — want missing, never a guess at which commit it meant", state, err)
	}
}

// A symbol's region is the line git grep finds it on as a whole word and the nineteen after it, each
// ended by a newline; at the end of a file it is what is left, and a final newline is not a line.
func TestWikiAnchorsSymbolRegionIsTheLinesFromTheFirstWholeWordHit(t *testing.T) {
	f := newWikiAnchorsFixture(t)
	state, region, err := checkWikiSymbolAnchor(f.checkout, f.first, "src/a.ts", "foo", "")
	if err != nil || state != "verified" || region != regionOf(symbolFile(""), 4) {
		t.Fatalf("foo = %q, %q, %v: want verified with the region from line 4, not from fooBar on line 2", state, region, err)
	}
	if state, _, err := checkWikiSymbolAnchor(f.checkout, f.first, "src/a.ts", "foo", region); err != nil || state != "verified" {
		t.Errorf("foo against its own baseline = %q, %v", state, err)
	}
	if state, _, err := checkWikiSymbolAnchor(f.checkout, f.first, "src/a.ts", "foo", strings.Repeat("0", 64)); err != nil || state != "changed" {
		t.Errorf("foo against another baseline = %q, %v, want changed", state, err)
	}
	// A directory: the first file under it, in path order, that has the symbol.
	if state, dirRegion, err := checkWikiSymbolAnchor(f.checkout, f.first, "src/", "foo", ""); err != nil || state != "verified" || dirRegion != region {
		t.Errorf("foo under src/ = %q, %q, %v", state, dirRegion, err)
	}
	for _, missing := range []struct{ path, symbol string }{{"src/a.ts", "bar"}, {"src/none.ts", "foo"}, {"../outside", "foo"}, {"src/a.ts", ""}} {
		if state, region, err := checkWikiSymbolAnchor(f.checkout, f.first, missing.path, missing.symbol, ""); err != nil || state != "missing" || region != "" {
			t.Errorf("symbol %q in %q = %q, %q, %v, want missing", missing.symbol, missing.path, state, region, err)
		}
	}

	// The hashing on its own: the end of a file, and a final newline.
	content := "a\nb\nc\n"
	want := sha256.Sum256([]byte("b\nc\n"))
	if got, ok := wikiSymbolRegionSha256([]byte(content), 2); !ok || got != hex.EncodeToString(want[:]) {
		t.Errorf("region from line 2 of %q = %s", content, got)
	}
	if got, _ := wikiSymbolRegionSha256([]byte("a\nb\nc"), 2); got != hex.EncodeToString(want[:]) {
		t.Errorf("a file with no final newline hashes its last line the same way: %s", got)
	}
	if _, ok := wikiSymbolRegionSha256([]byte(content), 4); ok {
		t.Error("a line past the end of the file has no region")
	}
	for in, want := range map[string]string{"./docs/a.md": "docs/a.md", "/docs//a.md": "docs/a.md", "src/": "src", " docs/a.md ": "docs/a.md"} {
		if got := wikiAnchorPath(in); got != want {
			t.Errorf("wikiAnchorPath(%q) = %q, want %q", in, got, want)
		}
	}
	for path, want := range map[string]string{"docs/a.md": "verified", "docs": "verified", "docs/none.md": "missing", "../x": "missing", "docs//a.md": "verified"} {
		if state, err := checkWikiPathAnchor(f.checkout, f.first, path); err != nil || state != want {
			t.Errorf("path %q = %q, %v, want %s", path, state, err, want)
		}
	}
}

// ── the fetch ───────────────────────────────────────────────────────────────────────────────────

// What git leaves running does not hold the fetch. On 10-04 a merge check's `go test` spent its last
// minute in wikiAnchorGit's Wait on a fetch that had already exited: a process the fetch started still
// held its output. Two things a fetch can leave: git's own detached auto-maintenance, which the fetch does
// not ask for, and whatever the checkout's configuration runs — here an upload-pack that leaves a
// process holding the fetch's stderr long after the fetch is done.
func TestWikiFetchIsNotHeldByWhatGitLeavesRunning(t *testing.T) {
	f := newWikiAnchorsFixture(t)
	moved := f.push(t, "main moves", func() { f.write(t, "docs/c.md", "a third\n") })
	holder := filepath.Join(f.home, "holder.pid")
	mustGit(t, f.checkout, "config", "remote.origin.uploadpack", "(sleep 300 </dev/null >&2 & echo $! >'"+holder+"'); git-upload-pack")
	t.Cleanup(func() {
		raw, err := os.ReadFile(holder)
		if err != nil {
			return
		}
		if pid, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil {
			if p, err := os.FindProcess(pid); err == nil {
				_ = p.Kill()
			}
		}
	})
	trace := filepath.Join(f.home, "git.trace")
	t.Setenv("GIT_TRACE", trace)

	done := make(chan error, 1)
	go func() { done <- fetchWikiOriginMain(f.checkout) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("the fetch: %v", err)
		}
	case <-time.After(time.Minute):
		t.Fatal("the fetch was still running after a minute: git had exited, and it waited on the process git left holding its stderr")
	}
	if _, err := os.Stat(holder); err != nil {
		t.Fatalf("the upload-pack left nothing running, so this checked nothing: %v", err)
	}
	if got := mustGit(t, f.checkout, "rev-parse", "refs/remotes/origin/main"); got != moved {
		t.Errorf("origin/main is %s after the fetch, want the commit main moved to (%s)", got, moved)
	}
	traced, err := os.ReadFile(trace)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(traced), "git maintenance run") {
		t.Errorf("the fetch started git maintenance in the checkout:\n%s", traced)
	}
}

// A symbol's region is the contract's, which the server holds the hash it is checked against to.
func TestWikiAnchorSymbolRegionIsTheContracts(t *testing.T) {
	rules := wikiContract(t)["anchorRules"].(map[string]interface{})["verify"].(map[string]interface{})["rules"].(map[string]interface{})
	if rules["symbolRegionLines"] != float64(wikiAnchorSymbolRegionLines) {
		t.Errorf("anchorRules.verify.rules.symbolRegionLines is %v, and this build hashes a region of %d lines", rules["symbolRegionLines"], wikiAnchorSymbolRegionLines)
	}
}
