package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A combined `git diff` over three files: a modify, an add (+++ b/…), and a delete (+++ is
// /dev/null, so the path must fall back to the `diff --git` header).
const sampleDiff = `diff --git a/foo.txt b/foo.txt
index e69de29..d95f3ad 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1,2 +1,3 @@
 line one
-line two
+line two changed
+line three
diff --git a/sub/new.txt b/sub/new.txt
new file mode 100644
index 0000000..b6fc4c6
--- /dev/null
+++ b/sub/new.txt
@@ -0,0 +1 @@
+hello
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index b6fc4c6..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-was here`

func TestSplitPatchKeysByNewPath(t *testing.T) {
	got := splitPatch(sampleDiff)
	for _, p := range []string{"foo.txt", "sub/new.txt", "gone.txt"} {
		if got[p] == "" {
			t.Fatalf("splitPatch missing segment for %q (keys: %v)", p, keys(got))
		}
		if !strings.HasPrefix(got[p], "diff --git ") {
			t.Errorf("segment %q should start with the diff header, got:\n%s", p, got[p])
		}
	}
	if len(got) != 3 {
		t.Errorf("expected 3 file segments, got %d (%v)", len(got), keys(got))
	}
	// The modify segment must carry its hunk + both the removed and added lines.
	foo := got["foo.txt"]
	for _, want := range []string{"@@ -1,2 +1,3 @@", "-line two", "+line two changed"} {
		if !strings.Contains(foo, want) {
			t.Errorf("foo.txt segment missing %q:\n%s", want, foo)
		}
	}
	if strings.Contains(got["sub/new.txt"], "gone.txt") {
		t.Error("new.txt segment leaked into the next file")
	}
}

func TestSplitPatchEmpty(t *testing.T) {
	if got := splitPatch(""); len(got) != 0 {
		t.Errorf("empty diff should yield no segments, got %v", got)
	}
}

// A filename with spaces must keep its real status (here "A") rather than falling back to the
// default "M": both --numstat and --name-status are tab-delimited, so parseNumstat must split
// on tab, not whitespace, to key them together.
func TestParseNumstatSpacedFilename(t *testing.T) {
	num := "6012\t0\tSample of Orbit.txt\n5\t2\tsrc/a b.swift"
	status := "A\tSample of Orbit.txt\nM\tsrc/a b.swift"
	got := parseNumstat(num, status)
	if len(got) != 2 {
		t.Fatalf("expected 2 files, got %d: %+v", len(got), got)
	}
	if got[0].Path != "Sample of Orbit.txt" || got[0].Status != "A" || got[0].Additions != 6012 {
		t.Errorf("spaced add row wrong: %+v", got[0])
	}
	if got[1].Path != "src/a b.swift" || got[1].Status != "M" {
		t.Errorf("spaced modify row wrong: %+v", got[1])
	}
}

func TestBuildFilePatches(t *testing.T) {
	byPath := splitPatch(sampleDiff)
	files := []ChangedFile{
		{Path: "foo.txt", Additions: 2, Deletions: 1, Status: "M"},
		{Path: "logo.png", Additions: -1, Deletions: -1, Status: "M"}, // binary → skipped
		{Path: "sub/new.txt", Additions: 1, Deletions: 0, Status: "A"},
		{Path: "untracked-no-patch.txt", Additions: 3, Deletions: 0, Status: "A"}, // no segment → skipped
	}
	out := buildFilePatches(files, byPath)
	if len(out) != 2 {
		t.Fatalf("expected 2 patches (binary + missing-segment dropped), got %d: %+v", len(out), out)
	}
	if out[0].Path != "foo.txt" || out[0].Patch == "" || out[0].Truncated {
		t.Errorf("foo.txt should carry a non-truncated patch, got %+v", out[0])
	}
	if out[1].Path != "sub/new.txt" || out[1].Patch == "" {
		t.Errorf("sub/new.txt should carry a patch, got %+v", out[1])
	}
}

func TestBuildFilePatchesTruncatesOversize(t *testing.T) {
	big := "diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -0,0 +1 @@\n" +
		strings.Repeat("+padding line to exceed the per-file cap\n", 2000) // > maxFilePatchBytes
	if len(big) <= maxFilePatchBytes {
		t.Fatalf("test setup: big patch (%d bytes) must exceed cap %d", len(big), maxFilePatchBytes)
	}
	files := []ChangedFile{{Path: "big.txt", Additions: 2000, Deletions: 0, Status: "M"}}
	out := buildFilePatches(files, map[string]string{"big.txt": big})
	if len(out) != 1 || !out[0].Truncated || out[0].Patch != "" {
		t.Fatalf("oversize file should be marked truncated with no patch text, got %+v", out)
	}
}

// mustGit runs a git command in dir and fails the test on error.
func mustGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := git(dir, args...)
	if err != nil {
		t.Fatalf("git %s: %v (%s)", strings.Join(args, " "), err, gitStderr(err))
	}
	return out
}

// initRepo makes a temp git repo on `main` with a single base commit and returns its path.
func initRepo(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	mustGit(t, repo, "init", "-b", "main")
	mustGit(t, repo, "config", "user.email", "test@orbit")
	mustGit(t, repo, "config", "user.name", "Test")
	commitFile(t, repo, "base.txt", "base\n", "base")
	return repo
}

// commitFile writes content to repo/name, stages it, and commits with msg.
func commitFile(t *testing.T, repo, name, content, msg string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(repo, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGit(t, repo, "add", ".")
	mustGit(t, repo, "commit", "-m", msg)
}

// TestMergeToMainRebaseLinear: a branch forked before main advanced rebases onto main's tip,
// leaving a linear history (no merge commit) without rewriting the session branch.
func TestMergeToMainRebaseLinear(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir()) // throwaway worktree lands under a temp ORBIT_HOME
	repo := initRepo(t)

	mustGit(t, repo, "checkout", "-b", "orbit/feat")
	commitFile(t, repo, "feat.txt", "feature\n", "feat work")
	featBefore := mustGit(t, repo, "rev-parse", "orbit/feat")

	mustGit(t, repo, "checkout", "main")
	commitFile(t, repo, "other.txt", "other\n", "main advance") // main diverges from the fork point

	out := mergeToMain(MergeCommand{WorkDir: repo, Branch: "orbit/feat", SessionID: "s1"})
	if out.Status != "merged" {
		t.Fatalf("expected merged, got %q (%s)", out.Status, out.Message)
	}
	if merges, _ := git(repo, "log", "--merges", "--format=%H", "main"); merges != "" {
		t.Errorf("main should be linear, found merge commits:\n%s", merges)
	}
	if _, err := git(repo, "cat-file", "-e", "main:feat.txt"); err != nil {
		t.Errorf("main should carry feat.txt after rebase: %v", err)
	}
	if _, err := git(repo, "cat-file", "-e", "main:other.txt"); err != nil {
		t.Errorf("main should still carry its own advance (other.txt): %v", err)
	}
	if featAfter, _ := git(repo, "rev-parse", "orbit/feat"); featAfter != featBefore {
		t.Errorf("session branch must not be rewritten: %s → %s", featBefore, featAfter)
	}
	if out.MergedSha == featBefore {
		t.Errorf("rebased commit should have a new sha, got the original %s", featBefore)
	}
	if out.SourceSha != featBefore {
		t.Errorf("SourceSha = %s, want pre-rebase source tip %s", out.SourceSha, featBefore)
	}
	if branchExists(repo, "orbit/_rebase-s1") {
		t.Error("temp rebase branch should be cleaned up")
	}
}

// TestMergeToMainRebaseAdaptsOverlappingPatch reproduces the false-negative that motivated the
// merge source receipt. Main has already made half of one feature commit's changes, so rebase
// cleanly drops that half and records only the remainder. The original and replayed commits then
// have different patch IDs even though all feature content landed.
func TestMergeToMainRebaseAdaptsOverlappingPatch(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	commitFile(t, repo, "base.txt", "one\nold-a\nthree\nfour\nfive\nsix\nseven\neight\nold-b\nten\n", "expand base")
	baseSha := mustGit(t, repo, "rev-parse", "main")

	mustGit(t, repo, "checkout", "-b", "orbit/overlap")
	commitFile(t, repo, "base.txt", "one\nnew-a\nthree\nfour\nfive\nsix\nseven\neight\nnew-b\nten\n", "feature edits two lines")
	sourceSha := mustGit(t, repo, "rev-parse", "orbit/overlap")

	mustGit(t, repo, "checkout", "main")
	commitFile(t, repo, "base.txt", "one\nnew-a\nthree\nfour\nfive\nsix\nseven\neight\nold-b\nten\n", "main makes half the feature change")

	out := mergeToMain(MergeCommand{WorkDir: repo, Branch: "orbit/overlap", SessionID: "overlap"})
	if out.Status != "merged" {
		t.Fatalf("expected clean adapted merge, got %q (%s)", out.Status, out.Message)
	}
	if out.SourceSha != sourceSha {
		t.Fatalf("SourceSha = %s, want original source tip %s", out.SourceSha, sourceSha)
	}
	if got := mustGit(t, repo, "show", "main:base.txt"); got != "one\nnew-a\nthree\nfour\nfive\nsix\nseven\neight\nnew-b\nten" {
		t.Fatalf("main content = %q, want all feature changes", got)
	}

	wt := &Worktree{RepoDir: repo, Branch: "orbit/overlap", BaseSha: baseSha}
	if branchMergedInto(wt) {
		t.Fatal("adapted replay should reproduce the conservative ancestry/patch-id false-negative")
	}
	if cherry := mustGit(t, repo, "cherry", "main", "orbit/overlap"); !strings.HasPrefix(cherry, "+") {
		t.Fatalf("test setup: original feature patch should be non-equivalent after adaptation, got %q", cherry)
	}
}

// TestMergeToMainRebaseConflict: a branch that edits the same lines as main's advance conflicts
// on rebase; the attempt aborts cleanly, leaving main and the working tree untouched.
func TestMergeToMainRebaseConflict(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)

	mustGit(t, repo, "checkout", "-b", "orbit/feat")
	commitFile(t, repo, "base.txt", "feature change\n", "feat edits base")

	mustGit(t, repo, "checkout", "main")
	commitFile(t, repo, "base.txt", "main change\n", "main edits base")
	mainBefore := mustGit(t, repo, "rev-parse", "main")

	out := mergeToMain(MergeCommand{WorkDir: repo, Branch: "orbit/feat", SessionID: "s2"})
	if out.Status != "conflict" {
		t.Fatalf("expected conflict, got %q (%s)", out.Status, out.Message)
	}
	if mainAfter, _ := git(repo, "rev-parse", "main"); mainAfter != mainBefore {
		t.Errorf("main must be untouched on conflict: %s → %s", mainBefore, mainAfter)
	}
	if st, _ := git(repo, "status", "--porcelain"); st != "" {
		t.Errorf("working tree should be clean after an aborted rebase, got:\n%s", st)
	}
	if branchExists(repo, "orbit/_rebase-s2") {
		t.Error("temp rebase branch should be cleaned up after conflict")
	}
}

// TestMergeToMainRebaseNonRootTarget: merging into a target that ISN'T the root checkout (here
// `develop`, with root left on main) advances the target's ref directly, still linearly, and
// never disturbs the root checkout.
func TestMergeToMainRebaseNonRootTarget(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)

	mustGit(t, repo, "checkout", "-b", "develop")
	mustGit(t, repo, "checkout", "-b", "orbit/feat") // forks from develop
	commitFile(t, repo, "feat.txt", "feature\n", "feat work")

	mustGit(t, repo, "checkout", "develop")
	commitFile(t, repo, "dev.txt", "dev\n", "develop advance") // diverges from feat's fork point

	mustGit(t, repo, "checkout", "main") // root sits on main, NOT the target
	rootHead := mustGit(t, repo, "rev-parse", "HEAD")

	out := mergeToMain(MergeCommand{WorkDir: repo, Branch: "orbit/feat", TargetBranch: "develop", SessionID: "s3"})
	if out.Status != "merged" {
		t.Fatalf("expected merged, got %q (%s)", out.Status, out.Message)
	}
	if merges, _ := git(repo, "log", "--merges", "--format=%H", "develop"); merges != "" {
		t.Errorf("develop should be linear, found merge commits:\n%s", merges)
	}
	for _, f := range []string{"feat.txt", "dev.txt"} {
		if _, err := git(repo, "cat-file", "-e", "develop:"+f); err != nil {
			t.Errorf("develop should carry %s after rebase: %v", f, err)
		}
	}
	if cur, _ := git(repo, "rev-parse", "--abbrev-ref", "HEAD"); cur != "main" {
		t.Errorf("root checkout must stay on main, got %q", cur)
	}
	if head, _ := git(repo, "rev-parse", "HEAD"); head != rootHead {
		t.Errorf("root checkout (main) must be untouched: %s → %s", rootHead, head)
	}
	if st, _ := git(repo, "status", "--porcelain"); st != "" {
		t.Errorf("root working tree should be clean, got:\n%s", st)
	}
}

// TestBranchMergedInto: the status bar's "✓ In main" signal. True only when the branch tip is
// already contained in the repo's default target (main, else master) — e.g. merged out-of-band
// on the command line — so the bar drops the redundant Merge button. Conservative false when the
// branch is ahead, there's no default target, the branch is the target, or there's no worktree.
func TestBranchMergedInto(t *testing.T) {
	repo := initRepo(t) // main + base commit

	// A branch forked from main with its own commit is AHEAD of main → not yet merged.
	mustGit(t, repo, "checkout", "-b", "orbit/feat")
	commitFile(t, repo, "feat.txt", "feature\n", "feat work")
	feat := &Worktree{Branch: "orbit/feat", RepoDir: repo}
	if branchMergedInto(feat) {
		t.Error("a branch ahead of main must report not-merged")
	}

	// Land it in main (fast-forward) — the branch tip is now an ancestor of main → merged.
	mustGit(t, repo, "checkout", "main")
	mustGit(t, repo, "merge", "--ff-only", "orbit/feat")
	if !branchMergedInto(feat) {
		t.Error("a branch already contained in main must report merged")
	}

	// The branch IS the default target (main into main): can't merge into itself → not-merged.
	if branchMergedInto(&Worktree{Branch: "main", RepoDir: repo}) {
		t.Error("branch == target must report not-merged")
	}

	// No main/master at all (default branch renamed away) → no target to compare → not-merged.
	noMain := initRepo(t)
	mustGit(t, noMain, "branch", "-m", "trunk") // rename current 'main' → 'trunk'
	mustGit(t, noMain, "checkout", "-b", "orbit/x")
	if branchMergedInto(&Worktree{Branch: "orbit/x", RepoDir: noMain}) {
		t.Error("with no main/master, must report not-merged (no default target)")
	}

	// Degenerate inputs fall back to not-merged.
	if branchMergedInto(nil) {
		t.Error("nil worktree must report not-merged")
	}
	if branchMergedInto(&Worktree{Branch: "", RepoDir: repo}) {
		t.Error("empty branch must report not-merged")
	}
}

// TestBranchMergedInto_ZeroCommitsPastFork: a session whose branch never committed anything
// still has its tip sitting at the fork point, which is already in main's history — so a naive
// is-ancestor check would falsely report "✓ In main" for a session that did no work. With a
// known BaseSha we require ≥1 commit past the fork before claiming the work landed.
func TestBranchMergedInto_ZeroCommitsPastFork(t *testing.T) {
	repo := initRepo(t) // main + base commit
	base := mustGit(t, repo, "rev-parse", "HEAD")

	// Fork a branch at main's HEAD but never commit on it — tip == base == in main.
	mustGit(t, repo, "checkout", "-b", "orbit/empty")
	empty := &Worktree{Branch: "orbit/empty", BaseSha: base, RepoDir: repo}
	if branchMergedInto(empty) {
		t.Error("a branch with zero commits past its fork must report not-merged, not '✓ In main'")
	}

	// Once it has a commit and is ff-merged into main, it must report merged even with BaseSha set.
	commitFile(t, repo, "feat.txt", "feature\n", "feat work")
	mustGit(t, repo, "checkout", "main")
	mustGit(t, repo, "merge", "--ff-only", "orbit/empty")
	if !branchMergedInto(empty) {
		t.Error("a branch with real commits already in main must report merged")
	}
}

// TestBranchMergedInto_PatchEquivalent: a branch whose commit landed in the target under a
// DIFFERENT sha — a squash/rebase merge, or Orbit's own rebase-based "Merge to main" — is still
// merged even though is-ancestor can't see it. This is the false-positive Merge button the
// patch-id fallback fixes.
func TestBranchMergedInto_PatchEquivalent(t *testing.T) {
	repo := initRepo(t) // main + base commit
	base := mustGit(t, repo, "rev-parse", "HEAD")

	// Fork a branch and commit real work on it.
	mustGit(t, repo, "checkout", "-b", "orbit/feat")
	commitFile(t, repo, "feat.txt", "feature\n", "feat work")
	tip := mustGit(t, repo, "rev-parse", "HEAD")
	feat := &Worktree{Branch: "orbit/feat", BaseSha: base, RepoDir: repo}

	// Advance main on its own first, then replay the branch's patch on top: a different parent (and
	// tree) forces a NEW sha — the real "branch forked, main moved on, the work landed ahead under a
	// fresh hash" shape a squash/rebase merge (and Orbit's "Merge to main") produces. A bare
	// cherry-pick onto the same base could reuse the identical sha and defeat the point.
	mustGit(t, repo, "checkout", "main")
	commitFile(t, repo, "unrelated.txt", "unrelated\n", "unrelated main work")
	mustGit(t, repo, "cherry-pick", tip)

	// Precondition: is-ancestor no longer sees it (main's copy carries a different sha).
	if _, err := git(repo, "merge-base", "--is-ancestor", "orbit/feat", "main"); err == nil {
		t.Fatal("precondition: a re-hashed merge must leave the branch tip NOT an ancestor of main")
	}
	if !branchMergedInto(feat) {
		t.Error("a branch whose patch already landed in main (different sha) must report merged")
	}

	// A branch with work genuinely absent from main still reports not-merged via the same fallback
	// (cherry marks its commit '+'), so the actionable Merge button stays.
	mustGit(t, repo, "checkout", "-b", "orbit/other")
	commitFile(t, repo, "other.txt", "other\n", "other work")
	other := &Worktree{Branch: "orbit/other", BaseSha: base, RepoDir: repo}
	if branchMergedInto(other) {
		t.Error("a branch with work not in main must report not-merged")
	}
}

// TestBranchMergedInto_RememberedTarget: the reported case — an agent whose merge target is
// `develop` merges there successfully, then the session is resumed (which clears mergeStatus, so
// the bar falls back to this check). Judged against main the work looks unmerged and the bar
// wrongly re-offers "Merge to develop"; judged against the session's remembered target it is
// correctly "✓ In develop".
func TestBranchMergedInto_RememberedTarget(t *testing.T) {
	repo := initRepo(t) // main + base commit
	base := mustGit(t, repo, "rev-parse", "HEAD")
	mustGit(t, repo, "branch", "develop")

	mustGit(t, repo, "checkout", "-b", "orbit/feat")
	commitFile(t, repo, "feat.txt", "feature\n", "feat work")
	feat := &Worktree{Branch: "orbit/feat", BaseSha: base, RepoDir: repo, Session: "s-remembered"}

	// Land the work in develop only; main never sees it.
	mustGit(t, repo, "checkout", "develop")
	mustGit(t, repo, "merge", "--ff-only", "orbit/feat")

	// With no remembered target the check falls back to main, where the work isn't — the
	// conservative not-merged that keeps an actionable Merge button.
	if branchMergedInto(feat) {
		t.Error("without a remembered target, main is the yardstick and the work isn't there")
	}

	// Once the session's target is known (from the merge it ran, or the claim payload), the same
	// branch must report merged.
	rememberMergeTarget(feat.Session, "develop")
	defer forgetMergeTarget(feat.Session)
	if !branchMergedInto(feat) {
		t.Error("work landed in the session's merge target (develop) must report merged")
	}

	// An empty target means "auto-detect": it must drop the remembered entry, not keep it.
	rememberMergeTarget(feat.Session, "")
	if branchMergedInto(feat) {
		t.Error("an empty target must clear the remembered branch and fall back to main")
	}
}

// addOriginBare wires a throwaway bare repo as 'origin' and pushes repo's main to it, so
// origin/<branch> remote-tracking refs exist for the merge-sync tests.
func addOriginBare(t *testing.T, repo string) string {
	t.Helper()
	bare := t.TempDir()
	mustGit(t, bare, "init", "--bare", "-b", "main")
	mustGit(t, repo, "remote", "add", "origin", bare)
	mustGit(t, repo, "push", "origin", "main")
	return bare
}

// advanceOriginMain lands a new commit on origin/main WITHOUT moving the repo's local main —
// simulating other work pushed upstream (an agent's `git push origin HEAD:main`, another merge)
// while this runner's local main stays behind.
func advanceOriginMain(t *testing.T, repo, file, content string) {
	t.Helper()
	mustGit(t, repo, "checkout", "-b", "_up")
	commitFile(t, repo, file, content, "upstream "+file)
	mustGit(t, repo, "push", "origin", "_up:main")
	mustGit(t, repo, "checkout", "main")
	mustGit(t, repo, "branch", "-D", "_up")
}

// TestMergeToMainSyncsStaleLocalTargetFromOrigin: when origin/main has advanced past the runner's
// local main, the merge fast-forwards local main to origin FIRST, then rebases the branch on top —
// so main ends up with both the upstream commit and the branch's work, never replaying onto a
// stale base. This is the fix for the phantom conflict the "Resolve in session" loop couldn't clear.
func TestMergeToMainSyncsStaleLocalTargetFromOrigin(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	addOriginBare(t, repo)

	mustGit(t, repo, "checkout", "-b", "orbit/feat")
	commitFile(t, repo, "feat.txt", "feature\n", "feat work")
	featBefore := mustGit(t, repo, "rev-parse", "orbit/feat")

	mustGit(t, repo, "checkout", "main")
	advanceOriginMain(t, repo, "upstream.txt", "upstream\n") // origin/main ahead; local main stale

	out := mergeToMain(MergeCommand{WorkDir: repo, Branch: "orbit/feat", SessionID: "s4"})
	if out.Status != "merged" {
		t.Fatalf("expected merged, got %q (%s)", out.Status, out.Message)
	}
	if merges, _ := git(repo, "log", "--merges", "--format=%H", "main"); merges != "" {
		t.Errorf("main should be linear, found merge commits:\n%s", merges)
	}
	for _, f := range []string{"upstream.txt", "feat.txt"} {
		if _, err := git(repo, "cat-file", "-e", "main:"+f); err != nil {
			t.Errorf("main should carry %s after sync+rebase: %v", f, err)
		}
	}
	if featAfter, _ := git(repo, "rev-parse", "orbit/feat"); featAfter != featBefore {
		t.Errorf("session branch must not be rewritten: %s → %s", featBefore, featAfter)
	}
}

// TestMergeToMainAlreadyMergedUpstreamNoConflict: the exact reported case — the branch's commits
// are ALREADY in origin/main (an agent pushed them) but local main lagged. Syncing local main to
// origin first makes the rebase a no-op, so it merges cleanly instead of re-conflicting on commits
// already reconciled upstream.
func TestMergeToMainAlreadyMergedUpstreamNoConflict(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	addOriginBare(t, repo)

	mustGit(t, repo, "checkout", "-b", "orbit/feat")
	commitFile(t, repo, "shared.txt", "branch version\n", "feat edits shared")
	mustGit(t, repo, "push", "origin", "orbit/feat:main") // origin/main now contains the branch
	mustGit(t, repo, "checkout", "main")                  // local main still at base (stale)

	out := mergeToMain(MergeCommand{WorkDir: repo, Branch: "orbit/feat", SessionID: "s5"})
	if out.Status != "merged" {
		t.Fatalf("expected clean merge (branch already upstream), got %q (%s)", out.Status, out.Message)
	}
	if _, err := git(repo, "cat-file", "-e", "main:shared.txt"); err != nil {
		t.Errorf("main should carry the branch's file: %v", err)
	}
}

// TestMergeToMainDivergedLocalTargetErrors: a local main carrying commits that aren't on origin
// (e.g. a prior local-only "merge to main") has genuinely diverged from origin/main; rather than
// rebase onto the wrong base, the merge reports an actionable error and leaves main untouched.
func TestMergeToMainDivergedLocalTargetErrors(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	addOriginBare(t, repo)

	mustGit(t, repo, "checkout", "-b", "orbit/feat")
	commitFile(t, repo, "feat.txt", "feature\n", "feat work")

	mustGit(t, repo, "checkout", "main")
	advanceOriginMain(t, repo, "upstream.txt", "upstream\n")                      // origin/main = base+upstream
	commitFile(t, repo, "local.txt", "local only\n", "local-only commit on main") // local main = base+local
	mainBefore := mustGit(t, repo, "rev-parse", "main")

	out := mergeToMain(MergeCommand{WorkDir: repo, Branch: "orbit/feat", SessionID: "s6"})
	if out.Status != "error" {
		t.Fatalf("expected error on diverged local target, got %q (%s)", out.Status, out.Message)
	}
	if !strings.Contains(out.Message, "diverged") {
		t.Errorf("error message should name the divergence, got: %s", out.Message)
	}
	if mainAfter, _ := git(repo, "rev-parse", "main"); mainAfter != mainBefore {
		t.Errorf("main must be untouched on a diverged-target error: %s → %s", mainBefore, mainAfter)
	}
	if st, _ := git(repo, "status", "--porcelain"); st != "" {
		t.Errorf("working tree should stay clean, got:\n%s", st)
	}
}

// TestMergeToMainPushesResultToOrigin: a clean merge pushes the rebased result back to
// origin/<target>, so origin and local main stay in lockstep — local merges never pile up unpushed
// (the state that eventually diverges from origin and blocks the next merge).
func TestMergeToMainPushesResultToOrigin(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	bare := addOriginBare(t, repo)

	mustGit(t, repo, "checkout", "-b", "orbit/feat")
	commitFile(t, repo, "feat.txt", "feature\n", "feat work")
	mustGit(t, repo, "checkout", "main")

	out := mergeToMain(MergeCommand{WorkDir: repo, Branch: "orbit/feat", SessionID: "s7"})
	if out.Status != "merged" {
		t.Fatalf("expected merged, got %q (%s)", out.Status, out.Message)
	}
	localMain := mustGit(t, repo, "rev-parse", "main")
	originMain := mustGit(t, bare, "rev-parse", "main")
	if localMain != originMain {
		t.Errorf("origin/main should match local main after merge: local %s, origin %s", localMain, originMain)
	}
	if out.MergedSha != localMain {
		t.Errorf("MergedSha %s should equal local main %s", out.MergedSha, localMain)
	}
	if _, err := git(bare, "cat-file", "-e", "main:feat.txt"); err != nil {
		t.Errorf("origin/main should carry the merged file: %v", err)
	}
}

// TestMergeToMainNoOriginStaysLocal: with no 'origin' remote the merge still advances local main
// and reports merged — the push is skipped, not an error.
func TestMergeToMainNoOriginStaysLocal(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)

	mustGit(t, repo, "checkout", "-b", "orbit/feat")
	commitFile(t, repo, "feat.txt", "feature\n", "feat work")
	mustGit(t, repo, "checkout", "main")

	out := mergeToMain(MergeCommand{WorkDir: repo, Branch: "orbit/feat", SessionID: "s8"})
	if out.Status != "merged" {
		t.Fatalf("expected merged with no origin, got %q (%s)", out.Status, out.Message)
	}
	if _, err := git(repo, "cat-file", "-e", "main:feat.txt"); err != nil {
		t.Errorf("local main should carry the merged file: %v", err)
	}
}

// TestIsNonFastForward: only origin-moved rejections are retryable; auth/network/empty output is not.
func TestIsNonFastForward(t *testing.T) {
	rejected := "To github.com:o/r.git\n ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs\nhint: Updates were rejected because the remote contains work; fetch first"
	if !isNonFastForward(rejected) {
		t.Errorf("rejected push should classify as non-fast-forward: %q", rejected)
	}
	for _, other := range []string{
		"fatal: Authentication failed for 'https://github.com/o/r.git'",
		"ssh: connect to host github.com port 22: Connection timed out",
		"",
	} {
		if isNonFastForward(other) {
			t.Errorf("non-rejection output should not classify as non-fast-forward: %q", other)
		}
	}
}

// TestParkCheckpointRoundTrip: a park finalize (checkpoint=true) commits the in-progress work
// tagged with the park trailer, and a later resume (uncommitParkCheckpoint) soft-resets it back
// to an uncommitted working tree with content intact — leaving no checkpoint commit in history.
func TestParkCheckpointRoundTrip(t *testing.T) {
	repo := initRepo(t)
	base := mustGit(t, repo, "rev-parse", "HEAD")
	wt := &Worktree{Path: repo, Branch: "main", BaseSha: base, RepoDir: repo, Session: "sP"}

	// The agent left an uncommitted change behind when the session was parked.
	if err := os.WriteFile(filepath.Join(repo, "work.txt"), []byte("in progress\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	finalizeWorktree(wt, true) // park → checkpoint commit
	if st, _ := git(repo, "status", "--porcelain"); st != "" {
		t.Fatalf("checkpoint should commit all work, tree not clean:\n%s", st)
	}
	if msg := mustGit(t, repo, "log", "-1", "--format=%B"); !strings.Contains(msg, parkCheckpointTrailer+": sP") {
		t.Fatalf("checkpoint commit should carry the park trailer, got:\n%s", msg)
	}
	if _, err := git(repo, "cat-file", "-e", "HEAD:work.txt"); err != nil {
		t.Fatalf("checkpoint must capture work.txt: %v", err)
	}

	uncommitParkCheckpoint(wt) // resume → undo the checkpoint
	if after := mustGit(t, repo, "rev-parse", "HEAD"); after != base {
		t.Fatalf("resume should soft-reset the checkpoint back to base %s, HEAD=%s", base, after)
	}
	if st, _ := git(repo, "status", "--porcelain"); !strings.Contains(st, "work.txt") {
		t.Fatalf("work should return as a pending change after undo, status:\n%s", st)
	}
	if content, err := os.ReadFile(filepath.Join(repo, "work.txt")); err != nil || string(content) != "in progress\n" {
		t.Fatalf("work.txt content must survive the undo: %q (%v)", content, err)
	}
}

// TestPermanentEndNotUndone: a real end (SUCCEEDED/FAILED → checkpoint=false) commits WITHOUT the
// park trailer, so uncommitParkCheckpoint is a no-op and the commit stays permanent on resume.
func TestPermanentEndNotUndone(t *testing.T) {
	repo := initRepo(t)
	base := mustGit(t, repo, "rev-parse", "HEAD")
	wt := &Worktree{Path: repo, Branch: "main", BaseSha: base, RepoDir: repo, Session: "sE"}

	if err := os.WriteFile(filepath.Join(repo, "done.txt"), []byte("done\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	finalizeWorktree(wt, false) // permanent end
	endSha := mustGit(t, repo, "rev-parse", "HEAD")
	if endSha == base {
		t.Fatal("end commit should advance HEAD past base")
	}

	uncommitParkCheckpoint(wt) // no park trailer → must not touch the commit
	if after := mustGit(t, repo, "rev-parse", "HEAD"); after != endSha {
		t.Fatalf("permanent end commit must not be undone: %s → %s", endSha, after)
	}
}

func keys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// TestCleanCommitMessage: the model's reply is stripped of fences/quotes the prompt told it to
// omit, trimmed, and reduced to "" when nothing usable remains (so the caller can fall back).
func TestCleanCommitMessage(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"plain", "fix: handle nil session\n", "fix: handle nil session"},
		{"fenced", "```\nfeat: add commit summaries\n```", "feat: add commit summaries"},
		{"fenced-lang", "```text\nchore: bump deps\n```\n", "chore: bump deps"},
		{"double-quoted", "\"fix: trim output\"", "fix: trim output"},
		{"backtick-wrapped", "`fix: trim output`", "fix: trim output"},
		{"with-body", "feat: x\n\nWhy this matters.", "feat: x\n\nWhy this matters."},
		{"blank", "   \n  ", ""},
	}
	for _, c := range cases {
		if got := cleanCommitMessage(c.in); got != c.want {
			t.Errorf("%s: cleanCommitMessage(%q) = %q, want %q", c.name, c.in, got, c.want)
		}
	}
}

// TestDiffstatFallbackMessage: the deterministic fallback names the staged files (capped at a
// summary past three) and degrades to the bare branch slug when nothing is staged.
func TestDiffstatFallbackMessage(t *testing.T) {
	repo := initRepo(t)

	if got := diffstatFallbackMessage(repo, "orbit/x"); got != "orbit: commit orbit/x" {
		t.Errorf("no staged changes: got %q", got)
	}

	mustWrite(t, repo, "alpha.txt")
	mustGit(t, repo, "add", "alpha.txt")
	if got := diffstatFallbackMessage(repo, "orbit/x"); got != "Update alpha.txt" {
		t.Errorf("one file: got %q", got)
	}

	mustWrite(t, repo, "bravo.txt")
	mustWrite(t, repo, "charlie.txt")
	mustGit(t, repo, "add", ".")
	if got := diffstatFallbackMessage(repo, "orbit/x"); got != "Update alpha.txt, bravo.txt, charlie.txt" {
		t.Errorf("three files: got %q", got)
	}

	mustWrite(t, repo, "delta.txt")
	mustGit(t, repo, "add", ".")
	if got := diffstatFallbackMessage(repo, "orbit/x"); got != "Update alpha.txt and 3 more files" {
		t.Errorf("four files: got %q", got)
	}
}

// mustWrite creates repo/name with throwaway content (the fallback only counts/names files).
func mustWrite(t *testing.T, repo, name string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(repo, name), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestResolveBaseSha: the base-ref healer behind every session diff. A recorded base is kept
// only while it is a real ancestor of the branch; a drifted one (a re-created checkout stamped
// with a repo HEAD that had moved on) or a missing one heals to the true fork point
// (merge-base) and is re-persisted, so diffs stop counting other people's commits.
func TestResolveBaseSha(t *testing.T) {
	repo := initRepo(t)
	fork := mustGit(t, repo, "rev-parse", "HEAD")
	mustGit(t, repo, "checkout", "-b", "orbit/feat")
	commitFile(t, repo, "feat.txt", "feature\n", "feat work")
	mustGit(t, repo, "checkout", "main")
	commitFile(t, repo, "main.txt", "main\n", "main advance") // HEAD moves past the fork

	// A persisted base that IS an ancestor of the branch is kept verbatim.
	if got := resolveBaseSha(repo, "s1", "orbit/feat", fork); got != fork {
		t.Errorf("valid ancestor base must be kept, got %s want %s", got, fork)
	}
	// A drifted base (the moved repo HEAD — not in the branch's history) heals to the fork.
	head := mustGit(t, repo, "rev-parse", "HEAD")
	if got := resolveBaseSha(repo, "s1", "orbit/feat", head); got != fork {
		t.Errorf("drifted base must heal to the fork point, got %s want %s", got, fork)
	}
	if ref := mustGit(t, repo, "rev-parse", baseRefName("s1")); ref != fork {
		t.Errorf("healed base must be re-persisted to the ref, got %s want %s", ref, fork)
	}
	// A missing base resolves straight to the fork.
	if got := resolveBaseSha(repo, "s2", "orbit/feat", ""); got != fork {
		t.Errorf("missing base must resolve to the fork point, got %s want %s", got, fork)
	}
}

// A branch forked off a NON-HEAD branch (develop, while the root checkout sits on main) records
// a fork the merge-base-with-HEAD candidate can't see; its tighter recorded base must be kept,
// not loosened to the main/develop split point (which would count develop's commits as session
// work). And a fully-merged branch (tip == candidate) keeps its old fork, so the bar still shows
// the session's cumulative work and the ≥1-commit "✓ In main" guard keeps holding.
func TestResolveBaseShaKeepsTighterAndMergedForks(t *testing.T) {
	repo := initRepo(t)
	mustGit(t, repo, "checkout", "-b", "develop")
	commitFile(t, repo, "dev.txt", "dev\n", "develop advance")
	devFork := mustGit(t, repo, "rev-parse", "HEAD")
	mustGit(t, repo, "checkout", "-b", "orbit/feat") // forks from develop
	commitFile(t, repo, "feat.txt", "feature\n", "feat work")
	mustGit(t, repo, "checkout", "main") // root sits on main; split point is behind devFork
	if got := resolveBaseSha(repo, "s4", "orbit/feat", devFork); got != devFork {
		t.Errorf("a tighter non-HEAD fork must be kept, got %s want %s", got, devFork)
	}

	// Fully merged: tip == merge-base(HEAD, branch) → the old fork is kept verbatim.
	repo2 := initRepo(t)
	fork2 := mustGit(t, repo2, "rev-parse", "HEAD")
	mustGit(t, repo2, "checkout", "-b", "orbit/done")
	commitFile(t, repo2, "done.txt", "done\n", "done work")
	mustGit(t, repo2, "checkout", "main")
	mustGit(t, repo2, "merge", "--ff-only", "orbit/done")
	if got := resolveBaseSha(repo2, "s5", "orbit/done", fork2); got != fork2 {
		t.Errorf("a fully-merged branch must keep its old fork, got %s want %s", got, fork2)
	}
}

// TestFreshenBaseShaAfterRebase: a branch rebased mid-session leaves the recorded fork outside
// its history — the live/final diffs must re-base onto the NEW fork instead of counting the
// target's commits as session work (the "+3170 −532 phantom diff" symptom).
func TestFreshenBaseShaAfterRebase(t *testing.T) {
	repo := initRepo(t)
	oldFork := mustGit(t, repo, "rev-parse", "HEAD")
	mustGit(t, repo, "checkout", "-b", "orbit/feat")
	commitFile(t, repo, "feat.txt", "feature\n", "feat work")
	mustGit(t, repo, "checkout", "main")
	commitFile(t, repo, "main.txt", "main\n", "main advance")
	mustGit(t, repo, "checkout", "orbit/feat")
	mustGit(t, repo, "rebase", "main")
	newFork := mustGit(t, repo, "rev-parse", "main")
	// The root checkout sits on main in real deployments (the branch lives in a separate
	// worktree); the candidate fork is computed against the ROOT's HEAD, not the branch.
	mustGit(t, repo, "checkout", "main")
	wtPath := filepath.Join(t.TempDir(), "wt")
	mustGit(t, repo, "worktree", "add", wtPath, "orbit/feat")

	wt := &Worktree{Path: wtPath, Branch: "orbit/feat", BaseSha: oldFork, RepoDir: repo, Session: "s3"}
	freshenBaseSha(wt)
	if wt.BaseSha != newFork {
		t.Errorf("rebased branch must re-base onto the new fork, got %s want %s", wt.BaseSha, newFork)
	}
	// And a still-valid base is left untouched (single is-ancestor check, no ref churn).
	freshenBaseSha(wt)
	if wt.BaseSha != newFork {
		t.Errorf("healthy base must be stable, got %s", wt.BaseSha)
	}
}

// TestBranchMergedInto_AfterMergeRecommit is the after-merge re-commit acceptance case: once a
// session's branch is merged, committing MORE work on the same branch must re-enable Merge (the
// branch is no longer fully in main) and re-base the diff on the merge point so it shows only the
// new delta — not the already-merged commits. Models production, where the repo root sits on the
// merge target (main) while isolated sessions run in their own worktrees, so resolveBaseSha's
// merge-base(HEAD, branch) candidate advances the base the moment new work lands.
func TestBranchMergedInto_AfterMergeRecommit(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir()) // throwaway rebase worktree lands under a temp ORBIT_HOME
	repo := initRepo(t)                 // main + base commit
	fork := mustGit(t, repo, "rev-parse", "HEAD")

	// A session forks orbit/foo at the fork point and commits one unit of work.
	mustGit(t, repo, "checkout", "-b", "orbit/foo")
	commitFile(t, repo, "a.txt", "a\n", "A")
	mustGit(t, repo, "checkout", "main")

	// Merge it to main (root is on main → fast-forward in place, as in production).
	if out := mergeToMain(MergeCommand{WorkDir: repo, Branch: "orbit/foo", SessionID: "s1"}); out.Status != "merged" {
		t.Fatalf("merge failed: %q %s", out.Status, out.Message)
	}
	mergeTip := mustGit(t, repo, "rev-parse", "main")

	// Right after the merge: base stays at the fork, and the branch reads as "in main".
	base1 := resolveBaseSha(repo, "s1", "orbit/foo", fork)
	if base1 != fork {
		t.Errorf("base should stay at fork right after merge: want %s, got %s", fork, base1)
	}
	if !branchMergedInto(&Worktree{Branch: "orbit/foo", BaseSha: base1, RepoDir: repo, Session: "s1"}) {
		t.Error("branch should read as merged (✓ In main) right after the merge")
	}

	// The session commits MORE work on the same branch after the merge.
	mustGit(t, repo, "checkout", "orbit/foo")
	commitFile(t, repo, "g.txt", "g\n", "C (post-merge work)")
	mustGit(t, repo, "checkout", "main")

	// Base must advance to the merge tip (so the diff drops the already-merged commit)…
	base2 := resolveBaseSha(repo, "s1", "orbit/foo", base1)
	if base2 != mergeTip {
		t.Errorf("base must advance to the merge tip after new work: want %s, got %s", mergeTip, base2)
	}
	// …the branch must no longer read as merged (Merge button returns)…
	if branchMergedInto(&Worktree{Branch: "orbit/foo", BaseSha: base2, RepoDir: repo, Session: "s1"}) {
		t.Error("branch must NOT read as merged after new post-merge work — Merge should re-enable")
	}
	// …and the diff on the advanced base shows ONLY the new file, not the already-merged one.
	files := diffFiles(repo, base2, "orbit/foo")
	if len(files) != 1 || files[0].Path != "g.txt" {
		t.Errorf("diff should show only the new post-merge delta (g.txt), got %+v", files)
	}
}

// TestBranchMergedInto_CheckoutBFollowsNewBranch: when the agent runs `git checkout -b` inside the
// worktree, the merged-verdict must follow the worktree's ACTUAL HEAD, not the frozen fork branch.
// A session whose original branch is already in main but whose worktree has moved to a fresh,
// unmerged branch must read as NOT merged — so the bar surfaces the new branch instead of a stale
// "✓ In main".
func TestBranchMergedInto_CheckoutBFollowsNewBranch(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)

	// orbit/foo forks, does work, and is merged to main.
	mustGit(t, repo, "checkout", "-b", "orbit/foo")
	commitFile(t, repo, "a.txt", "a\n", "A")
	mustGit(t, repo, "checkout", "main")
	if out := mergeToMain(MergeCommand{WorkDir: repo, Branch: "orbit/foo", SessionID: "s2"}); out.Status != "merged" {
		t.Fatalf("merge failed: %q %s", out.Status, out.Message)
	}

	// The session runs in a real worktree checked out on the (now-merged) orbit/foo.
	wtPath := filepath.Join(t.TempDir(), "wt")
	mustGit(t, repo, "worktree", "add", wtPath, "orbit/foo")
	wt := &Worktree{Path: wtPath, Branch: "orbit/foo", RepoDir: repo, Session: "s2"}

	// Baseline: still on the tracked branch → reads as merged (✓ In main).
	if got := currentBranch(wt); got != "orbit/foo" {
		t.Fatalf("worktree should be on orbit/foo, got %q", got)
	}
	originalTip := mustGit(t, repo, "rev-parse", "orbit/foo")
	if got := effectiveBranchSha(wt); got != originalTip {
		t.Fatalf("effective branch sha = %q, want tracked branch tip %q", got, originalTip)
	}
	if !branchMergedInto(wt) {
		t.Error("baseline: merged branch on its own worktree should read as In main")
	}

	// The agent starts fresh work on a new branch inside the worktree.
	mustGit(t, wtPath, "checkout", "-b", "feature-2")
	if err := os.WriteFile(filepath.Join(wtPath, "n.txt"), []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGit(t, wtPath, "add", ".")
	mustGit(t, wtPath, "commit", "-m", "new branch work")

	// The verdict must follow the real HEAD (feature-2, unmerged) — NOT the frozen orbit/foo.
	if got := currentBranch(wt); got != "feature-2" {
		t.Fatalf("worktree should be on feature-2, got %q", got)
	}
	newTip := mustGit(t, repo, "rev-parse", "feature-2")
	if got := effectiveBranchSha(wt); got != newTip {
		t.Fatalf("effective branch sha = %q, want newly checked-out branch tip %q", got, newTip)
	}
	if newTip == originalTip {
		t.Fatal("test setup: new branch must advance past the original tip")
	}
	if branchMergedInto(wt) {
		t.Error("after checkout -b to an unmerged branch, must NOT read as In main (surface the new branch)")
	}
}

func TestEffectiveBranchShaMissingWorktree(t *testing.T) {
	if got := effectiveBranchSha(nil); got != "" {
		t.Fatalf("nil worktree sha = %q, want empty", got)
	}
	if got := effectiveBranchSha(&Worktree{}); got != "" {
		t.Fatalf("empty worktree sha = %q, want empty", got)
	}
}

// TestMergeToMainDirtyRootUnrelatedFileStillMerges pins the narrowed precondition: one stray
// uncommitted file in the machine's shared checkout used to fail EVERY session's merge with
// "main has uncommitted changes". Git only refuses a fast-forward over the files it would
// overwrite, so an unrelated edit must merge — and survive.
func TestMergeToMainDirtyRootUnrelatedFileStillMerges(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	commitFile(t, repo, "unrelated.txt", "committed\n", "add unrelated")

	mustGit(t, repo, "checkout", "-b", "orbit/feat")
	commitFile(t, repo, "feat.txt", "feature\n", "feat work")
	mustGit(t, repo, "checkout", "main")

	// Somebody left an edit in the shared checkout, on a file this merge doesn't touch.
	if err := os.WriteFile(filepath.Join(repo, "unrelated.txt"), []byte("local edit\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	out := mergeToMain(MergeCommand{WorkDir: repo, Branch: "orbit/feat", SessionID: "s-dirty-ok"})
	if out.Status != "merged" {
		t.Fatalf("expected merged despite an unrelated dirty file, got %q (%s)", out.Status, out.Message)
	}
	if _, err := git(repo, "cat-file", "-e", "main:feat.txt"); err != nil {
		t.Errorf("main should carry the merged work: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(repo, "unrelated.txt"))
	if err != nil || string(got) != "local edit\n" {
		t.Errorf("the bystander's edit must survive the merge, got %q (%v)", string(got), err)
	}
}

// TestMergeToMainDirtyRootOverlappingFileErrors: when the dirty file IS one the fast-forward would
// overwrite, git refuses and we surface it — naming the checkout, not the branch. Nothing moves.
func TestMergeToMainDirtyRootOverlappingFileErrors(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)

	mustGit(t, repo, "checkout", "-b", "orbit/feat")
	commitFile(t, repo, "base.txt", "feature edit\n", "feat edits base")
	mustGit(t, repo, "checkout", "main")
	mainBefore := mustGit(t, repo, "rev-parse", "main")

	if err := os.WriteFile(filepath.Join(repo, "base.txt"), []byte("uncommitted local\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	out := mergeToMain(MergeCommand{WorkDir: repo, Branch: "orbit/feat", SessionID: "s-dirty-clash"})
	if out.Status != "error" {
		t.Fatalf("expected error when the ff would clobber a local edit, got %q (%s)", out.Status, out.Message)
	}
	// The message has to name the file both sides touched: "main has uncommitted changes" sent
	// people looking at their own branch for a problem that was somebody else's edit.
	for _, want := range []string{"checkout", "base.txt"} {
		if !strings.Contains(out.Message, want) {
			t.Errorf("error should mention %q, got: %s", want, out.Message)
		}
	}
	if mainAfter, _ := git(repo, "rev-parse", "main"); mainAfter != mainBefore {
		t.Errorf("main must not move when the ff is refused: %s → %s", mainBefore, mainAfter)
	}
	got, _ := os.ReadFile(filepath.Join(repo, "base.txt"))
	if string(got) != "uncommitted local\n" {
		t.Errorf("the local edit must be left alone, got %q", string(got))
	}
}

// TestMergeToMainWedgedRootNamesTheCheckout reproduces the outage this came from: a `git stash pop`
// that conflicted in the shared checkout leaves conflict stages with NO MERGE_HEAD, so every later
// merge fails. The message must blame the machine's checkout (and say it blocks every merge), and
// we must fail before staging a rebase worktree.
func TestMergeToMainWedgedRootNamesTheCheckout(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	commitFile(t, repo, "shared.txt", "v1\n", "add shared")

	mustGit(t, repo, "checkout", "-b", "orbit/feat")
	commitFile(t, repo, "feat.txt", "feature\n", "feat work")
	mustGit(t, repo, "checkout", "main")

	// A stash taken against the old content, then applied after main deleted the file: DU conflict.
	if err := os.WriteFile(filepath.Join(repo, "shared.txt"), []byte("stashed wip\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGit(t, repo, "stash", "push", "-m", "someone else's wip")
	mustGit(t, repo, "rm", "-q", "shared.txt")
	mustGit(t, repo, "commit", "-m", "refactor: drop shared.txt")
	_, _ = git(repo, "stash", "pop") // conflicts on purpose
	if st := inspectRepoRoot(repo); st.State != repoStateUnmerged {
		t.Fatalf("setup: expected an unmerged checkout, got %q (%v)", st.State, st.Paths)
	}
	mainBefore := mustGit(t, repo, "rev-parse", "main")

	out := mergeToMain(MergeCommand{WorkDir: repo, Branch: "orbit/feat", SessionID: "s-wedged"})
	if out.Status != "error" {
		t.Fatalf("expected error on a wedged checkout, got %q (%s)", out.Status, out.Message)
	}
	for _, want := range []string{"unresolved merge", "every merge on this runner", "shared.txt"} {
		if !strings.Contains(out.Message, want) {
			t.Errorf("message should contain %q, got: %s", want, out.Message)
		}
	}
	if mainAfter, _ := git(repo, "rev-parse", "main"); mainAfter != mainBefore {
		t.Errorf("main must not move: %s → %s", mainBefore, mainAfter)
	}
	if branchExists(repo, "orbit/_rebase-s-wedged") {
		t.Error("must fail before staging the rebase worktree")
	}
}

// TestInspectRepoRootClassifies covers the ordinary states plus the precedence rule: an operation
// in flight outranks the conflict stages it produced.
func TestInspectRepoRootClassifies(t *testing.T) {
	repo := initRepo(t)
	if st := inspectRepoRoot(repo); st.State != repoStateClean || st.Branch != "main" {
		t.Errorf("fresh repo = %+v, want clean on main", st)
	}
	if err := os.WriteFile(filepath.Join(repo, "base.txt"), []byte("edited\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	st := inspectRepoRoot(repo)
	if st.State != repoStateDirty || len(st.Paths) != 1 || st.Paths[0] != "base.txt" {
		t.Errorf("edited tree = %+v, want dirty on base.txt", st)
	}
	if st.Blocked() {
		t.Error("a merely dirty checkout must not read as blocked — merges still fast-forward into it")
	}

	// A conflicted real merge: MERGE_HEAD exists, so it classifies as an unfinished merge rather
	// than bare unmerged stages.
	mustGit(t, repo, "checkout", "--", "base.txt")
	mustGit(t, repo, "checkout", "-b", "side")
	commitFile(t, repo, "base.txt", "side\n", "side edit")
	mustGit(t, repo, "checkout", "main")
	commitFile(t, repo, "base.txt", "mainline\n", "main edit")
	_, _ = git(repo, "merge", "side") // conflicts on purpose
	st = inspectRepoRoot(repo)
	if st.State != repoStateMerge {
		t.Fatalf("mid-merge = %+v, want %q", st, repoStateMerge)
	}
	if !st.Blocked() || !strings.Contains(st.BlockedMessage("main"), "unfinished merge") {
		t.Errorf("mid-merge should be blocked and say so: %+v / %s", st, st.BlockedMessage("main"))
	}
}

// The overlap has to be caught BEFORE the push. Otherwise the branch lands on origin while the
// local fast-forward is refused, and the user is told the merge failed by a machine that has
// already published it. Reproduces the real case: someone left an edit in the shared checkout on
// a file this branch also changes.
func TestMergeToMainOverlappingDirtyRootFailsBeforePushing(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	bare := addOriginBare(t, repo)
	originBefore := mustGit(t, bare, "rev-parse", "main")

	mustGit(t, repo, "checkout", "-b", "orbit/feat")
	commitFile(t, repo, "base.txt", "branch edit\n", "branch edits base")
	mustGit(t, repo, "checkout", "main")
	// Somebody else's uncommitted edit, on the same file — believed committed on their own branch.
	if err := os.WriteFile(filepath.Join(repo, "base.txt"), []byte("someone else's wip\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	out := mergeToMain(MergeCommand{WorkDir: repo, Branch: "orbit/feat", SessionID: "s-clash-push"})
	if out.Status != "error" {
		t.Fatalf("expected error, got %q (%s)", out.Status, out.Message)
	}
	if originAfter, _ := git(bare, "rev-parse", "main"); originAfter != originBefore {
		t.Errorf("origin must not advance when the local ff can't follow: %s → %s", originBefore, originAfter)
	}
	if !strings.Contains(out.Message, "base.txt") {
		t.Errorf("message should name the contended file, got: %s", out.Message)
	}
	got, _ := os.ReadFile(filepath.Join(repo, "base.txt"))
	if string(got) != "someone else's wip\n" {
		t.Errorf("the bystander's edit must be untouched, got %q", string(got))
	}
}
