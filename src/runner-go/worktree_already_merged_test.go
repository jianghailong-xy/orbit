package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// `[K6]` §7: the merge that has nothing to do.
//
// These replay a real incident rather than a hypothetical. A session's branch and `main` had been
// fast-forwarded to the SAME commit and pushed; the branch was then asked to merge again. The only
// guard in the path compared the two branch NAMES, which differed, so it did not fire — and the
// merge replayed twenty-two commits from a base the control plane had recorded days earlier onto a
// target that already contained every one of them. Every conflict it reported was between a commit
// and itself, and no resolution could clear them, because the resolution was already merged.
//
// Three facts of that incident are reproduced deliberately, because each one is load-bearing and
// any of them alone is easy to accidentally pass:
//
//   - a STALE `BaseSha`. This is what `replayAnchor` proves "usable" and then replays from; a test
//     that left it empty would take the unanchored path and never exercise the bug.
//   - a source carrying INTERNAL MERGE commits. The incident's branch had two, and a linear branch
//     rebases cleanly onto a target containing it, which hides the failure entirely.
//   - the target being reached by a DIFFERENT route than a replay of the source, so ancestry is the
//     only thing that can answer the question.

// mergeReflog is every reflog line for a branch — the mechanical record of whether anything moved
// it. Comparing it before and after is a stronger claim than comparing the tip: a merge that moved
// the branch and moved it back would leave the tip equal and the reflog changed.
func mergeReflog(t *testing.T, repo, branch string) string {
	t.Helper()
	out, _ := git(repo, "reflog", "show", "--format=%H %gs", branch)
	return out
}

// forkWithInternalMerge builds the incident's branch shape: a session branch that carries its own
// merge commits, forked from `main` at a base the caller keeps a stale record of.
//
// Returns (staleBase, sourceTip).
func forkWithInternalMerge(t *testing.T, repo, branch string) (string, string) {
	t.Helper()
	staleBase := mustGit(t, repo, "rev-parse", "main")

	mustGit(t, repo, "checkout", "-b", branch)
	commitFile(t, repo, "k1.txt", "k1\n", "K1 contract")
	commitFile(t, repo, "contended.txt", "chain-edit\n", "K2 ledger edits the contended line")

	// A side line that edits the SAME line and is merged back INTO the branch with a resolution —
	// the "K1-K4, H0-H1 two internal merges" shape. `--no-ff` guarantees a real merge commit.
	//
	// The contended line is what makes this fixture bite. `git rebase` drops merge commits, so
	// replaying this branch from a stale base flattens it into `K2` then `H0`, each re-applying its
	// own half of a disagreement the merge commit already settled — onto a target that holds the
	// settled text. That is a CONFLICT between a commit and the resolution of itself, and it is
	// precisely what the incident reported in K1 and K2.
	mustGit(t, repo, "checkout", "-b", branch+"-side")
	mustGit(t, repo, "reset", "--hard", "HEAD~1")
	commitFile(t, repo, "contended.txt", "side-edit\n", "H0 aggregate guard edits the same line")
	mustGit(t, repo, "checkout", branch)
	if _, err := git(repo, "merge", "--no-ff", "-m", "merge: bring H0 onto the K chain", branch+"-side"); err != nil {
		// The merge conflicts by construction; resolve it the way the real branch did and commit.
		if err := os.WriteFile(filepath.Join(repo, "contended.txt"), []byte("resolved\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		mustGit(t, repo, "add", ".")
		mustGit(t, repo, "commit", "--no-edit")
	}
	commitFile(t, repo, "k5.txt", "k5\n", "K5 finding")

	return staleBase, mustGit(t, repo, "rev-parse", branch)
}

// TestMergeToMainAlreadyMergedTargetIsSource is the incident exactly: main has been fast-forwarded
// to the branch tip, and the merge is requested again with the stale base the control plane still
// holds. Nothing may be replayed, nothing may conflict, and nothing may move.
func TestMergeToMainAlreadyMergedTargetIsSource(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	staleBase, sourceTip := forkWithInternalMerge(t, repo, "orbit/k5")

	// The landing that already happened, by the route it actually happened by: `--ff-only`.
	mustGit(t, repo, "checkout", "main")
	mustGit(t, repo, "merge", "--ff-only", "orbit/k5")
	if got := mustGit(t, repo, "rev-parse", "main"); got != sourceTip {
		t.Fatalf("setup: main = %s, want the source tip %s", got, sourceTip)
	}
	reflogBefore := mergeReflog(t, repo, "main")

	out := mergeToMain(MergeCommand{
		WorkDir: repo, Branch: "orbit/k5", SessionID: "k5", BaseSha: staleBase,
	})

	if out.Status != "merged" || !out.AlreadyMerged {
		t.Fatalf("status = %q alreadyMerged = %v (%s), want a landed no-op",
			out.Status, out.AlreadyMerged, out.Message)
	}
	if out.SourceSha != sourceTip {
		t.Errorf("SourceSha = %s, want the frozen source tip %s", out.SourceSha, sourceTip)
	}
	// The receipt's own proof that no target moved.
	if out.TargetShaBefore != sourceTip || out.MergedSha != sourceTip {
		t.Errorf("before = %s after = %s, want both at %s", out.TargetShaBefore, out.MergedSha, sourceTip)
	}
	if out.RebaseBase != "" {
		t.Errorf("RebaseBase = %q, want empty — nothing was rebased", out.RebaseBase)
	}
	if len(out.Conflicts) != 0 {
		t.Errorf("conflicts = %v, want none: every one of them would be a commit against itself", out.Conflicts)
	}
	if got := mustGit(t, repo, "rev-parse", "main"); got != sourceTip {
		t.Errorf("main moved to %s", got)
	}
	if after := mergeReflog(t, repo, "main"); after != reflogBefore {
		t.Errorf("main's reflog changed, so something wrote to it:\nbefore:\n%s\nafter:\n%s", reflogBefore, after)
	}
	if branchExists(repo, "orbit/_rebase-k5") {
		t.Error("a rebase was staged; the whole point is that none is")
	}
	if _, err := os.Stat(filepath.Join(worktreesDir(), "_rebase-k5")); !os.IsNotExist(err) {
		t.Error("a throwaway rebase worktree was created")
	}
}

// TestMergeToMainAlreadyMergedTargetAhead: the target contains the source and has moved on since.
// Ancestry, not equality, is the only thing that can answer this one.
func TestMergeToMainAlreadyMergedTargetAhead(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	staleBase, sourceTip := forkWithInternalMerge(t, repo, "orbit/k5")

	mustGit(t, repo, "checkout", "main")
	mustGit(t, repo, "merge", "--ff-only", "orbit/k5")
	commitFile(t, repo, "later.txt", "later\n", "main moved on after the landing")
	mainTip := mustGit(t, repo, "rev-parse", "main")
	reflogBefore := mergeReflog(t, repo, "main")

	out := mergeToMain(MergeCommand{
		WorkDir: repo, Branch: "orbit/k5", SessionID: "k5", BaseSha: staleBase,
	})

	if out.Status != "merged" || !out.AlreadyMerged {
		t.Fatalf("status = %q alreadyMerged = %v (%s)", out.Status, out.AlreadyMerged, out.Message)
	}
	if out.SourceSha != sourceTip {
		t.Errorf("SourceSha = %s, want %s", out.SourceSha, sourceTip)
	}
	if out.TargetShaBefore != mainTip || out.MergedSha != mainTip {
		t.Errorf("before = %s after = %s, want both at main's tip %s", out.TargetShaBefore, out.MergedSha, mainTip)
	}
	if got := mustGit(t, repo, "rev-parse", "main"); got != mainTip {
		t.Errorf("main moved to %s", got)
	}
	if after := mergeReflog(t, repo, "main"); after != reflogBefore {
		t.Errorf("main's reflog changed:\nbefore:\n%s\nafter:\n%s", reflogBefore, after)
	}
}

// TestMergeToMainAlreadyMergedIsIdempotent: the response to the first request is lost and the
// caller asks again — twice more. Each answer is the same answer, and the repository is untouched
// throughout. This is the request end of CP4: re-asking a settled question re-reads it.
func TestMergeToMainAlreadyMergedIsIdempotent(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	staleBase, sourceTip := forkWithInternalMerge(t, repo, "orbit/k5")
	mustGit(t, repo, "checkout", "main")
	mustGit(t, repo, "merge", "--ff-only", "orbit/k5")
	reflogBefore := mergeReflog(t, repo, "main")

	var first mergeOutcome
	for i := 0; i < 3; i++ {
		out := mergeToMain(MergeCommand{
			WorkDir: repo, Branch: "orbit/k5", SessionID: "k5", BaseSha: staleBase,
		})
		if i == 0 {
			first = out
		}
		if out.Status != first.Status || out.AlreadyMerged != first.AlreadyMerged ||
			out.SourceSha != first.SourceSha || out.MergedSha != first.MergedSha ||
			out.TargetShaBefore != first.TargetShaBefore {
			t.Fatalf("request %d answered differently: %+v vs %+v", i+1, out, first)
		}
		if got := mustGit(t, repo, "rev-parse", "main"); got != sourceTip {
			t.Fatalf("request %d moved main to %s", i+1, got)
		}
	}
	if after := mergeReflog(t, repo, "main"); after != reflogBefore {
		t.Errorf("three re-asks wrote to main:\nbefore:\n%s\nafter:\n%s", reflogBefore, after)
	}
}

// TestMergeToMainStaleBaseStillMergesRealWork is the guard against over-correcting. The same stale
// base, but the work genuinely has NOT landed — so the merge must still happen. A short-circuit
// that swallowed this would trade a false conflict for a silent no-op, which is worse: the first
// one is loud.
//
// Deliberately WITHOUT the conflict-resolving internal merge the fixtures above carry. That shape
// cannot be flattened by any replay — `git rebase` drops merge commits, so each side of a settled
// disagreement is re-applied on its own — and it is why this branch family lands by `--ff-only`
// with a recorded receipt rather than through the rebase path at all. Asserting a clean rebase
// there would be asserting something git does not offer, and would say nothing about this guard.
func TestMergeToMainStaleBaseStillMergesRealWork(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	staleBase := mustGit(t, repo, "rev-parse", "main")
	mustGit(t, repo, "checkout", "-b", "orbit/k5")
	commitFile(t, repo, "k1.txt", "k1\n", "K1 contract")
	commitFile(t, repo, "contended.txt", "chain-edit\n", "K2 ledger")
	commitFile(t, repo, "k5.txt", "k5\n", "K5 finding")
	sourceTip := mustGit(t, repo, "rev-parse", "orbit/k5")

	mustGit(t, repo, "checkout", "main")
	commitFile(t, repo, "unrelated.txt", "unrelated\n", "main advanced elsewhere")

	out := mergeToMain(MergeCommand{
		WorkDir: repo, Branch: "orbit/k5", SessionID: "k5", BaseSha: staleBase,
	})
	if out.Status != "merged" {
		t.Fatalf("status = %q (%s), want a real merge", out.Status, out.Message)
	}
	if out.AlreadyMerged {
		t.Fatal("reported already-merged for work that had not landed")
	}
	if out.SourceSha != sourceTip {
		t.Errorf("SourceSha = %s, want %s", out.SourceSha, sourceTip)
	}
	for _, f := range []string{"k1.txt", "contended.txt", "k5.txt", "unrelated.txt"} {
		if _, err := git(repo, "cat-file", "-e", "main:"+f); err != nil {
			t.Errorf("main should carry %s after the merge: %v", f, err)
		}
	}
}

// TestMergeToMainRefusesUnverifiedTip is §7 CP3's `BRANCH_TIP_MISMATCH`, decided where the tip is a
// fact. The branch has committed past the commit the control plane's checkpoint verified, so those
// commits carry no test evidence and may not reach the target.
func TestMergeToMainRefusesUnverifiedTip(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	mustGit(t, repo, "checkout", "-b", "orbit/k6")
	commitFile(t, repo, "verified.txt", "verified\n", "the commit the suite ran on")
	verified := mustGit(t, repo, "rev-parse", "orbit/k6")
	commitFile(t, repo, "after.txt", "after\n", "one more, untested")
	tip := mustGit(t, repo, "rev-parse", "orbit/k6")

	mustGit(t, repo, "checkout", "main")
	mainBefore := mustGit(t, repo, "rev-parse", "main")
	reflogBefore := mergeReflog(t, repo, "main")

	out := mergeToMain(MergeCommand{
		WorkDir: repo, Branch: "orbit/k6", SessionID: "k6", RequiredSourceSha: verified,
	})
	if out.Status != "error" || !strings.Contains(out.Message, "BRANCH_TIP_MISMATCH") {
		t.Fatalf("status = %q message = %q, want a typed tip refusal", out.Status, out.Message)
	}
	if out.SourceSha != tip {
		t.Errorf("SourceSha = %s, want the tip it actually found, %s", out.SourceSha, tip)
	}
	if got := mustGit(t, repo, "rev-parse", "main"); got != mainBefore {
		t.Errorf("a refused merge moved main to %s", got)
	}
	if after := mergeReflog(t, repo, "main"); after != reflogBefore {
		t.Errorf("a refused merge wrote to main:\nbefore:\n%s\nafter:\n%s", reflogBefore, after)
	}

	// And it merges once the tip IS the verified commit.
	mustGit(t, repo, "branch", "-f", "orbit/k6", verified)
	ok := mergeToMain(MergeCommand{
		WorkDir: repo, Branch: "orbit/k6", SessionID: "k6", RequiredSourceSha: verified,
	})
	if ok.Status != "merged" {
		t.Fatalf("status = %q (%s), want the verified commit to merge", ok.Status, ok.Message)
	}
}

// TestMergeToMainAlreadyMergedOutranksTipMismatch pins the ORDER of the two gates. A target that
// already contains the work has nothing to gate: refusing it for an unverified tip would report a
// problem about a merge that is not going to happen, and would leave the caller retrying a request
// whose answer is "it is already there".
func TestMergeToMainAlreadyMergedOutranksTipMismatch(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	mustGit(t, repo, "checkout", "-b", "orbit/k6")
	commitFile(t, repo, "verified.txt", "verified\n", "the commit the suite ran on")
	verified := mustGit(t, repo, "rev-parse", "orbit/k6")
	commitFile(t, repo, "after.txt", "after\n", "one more, untested")

	mustGit(t, repo, "checkout", "main")
	mustGit(t, repo, "merge", "--ff-only", "orbit/k6") // everything, tip included, already landed

	out := mergeToMain(MergeCommand{
		WorkDir: repo, Branch: "orbit/k6", SessionID: "k6", RequiredSourceSha: verified,
	})
	if out.Status != "merged" || !out.AlreadyMerged {
		t.Fatalf("status = %q alreadyMerged = %v (%s), want the no-op answer",
			out.Status, out.AlreadyMerged, out.Message)
	}
}
