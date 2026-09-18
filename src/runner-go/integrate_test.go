package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The steps of an integration job, against real repositories
// (docs/project-integration-line-contract.md §2.4).
//
// Real `git` and real commits throughout, because every one of these behaviours IS git's: which
// commits a rebase replays, whether a merge keeps a conflict resolution somebody already made, and
// what a tree hash is. A double would be a second implementation of git, and agreeing with it would
// prove nothing about the one the runner actually shells out to.

// integrationRepo is a bare origin and a checkout of it with one commit on main.
type integrationRepo struct {
	t      *testing.T
	origin string
	work   string
}

func newIntegrationRepo(t *testing.T) *integrationRepo {
	t.Helper()
	root := t.TempDir()
	origin := filepath.Join(root, "origin")
	work := filepath.Join(root, "work")
	mustRun(t, root, "git", "init", "--quiet", "--bare", "--initial-branch=main", origin)
	mustRun(t, root, "git", "init", "--quiet", "--initial-branch=main", work)
	mustRun(t, work, "git", "config", "user.email", "orbit@example.invalid")
	mustRun(t, work, "git", "config", "user.name", "orbit")
	r := &integrationRepo{t: t, origin: origin, work: work}
	r.write("README.md", "base\n")
	r.commit("base")
	mustRun(t, work, "git", "remote", "add", "origin", origin)
	mustRun(t, work, "git", "push", "--quiet", "-u", "origin", "main")
	return r
}

func (r *integrationRepo) write(name, content string) {
	r.t.Helper()
	if err := os.WriteFile(filepath.Join(r.work, name), []byte(content), 0o644); err != nil {
		r.t.Fatalf("write %s: %v", name, err)
	}
}

func (r *integrationRepo) commit(message string) string {
	r.t.Helper()
	mustRun(r.t, r.work, "git", "add", "-A")
	mustRun(r.t, r.work, "git", "commit", "--quiet", "-m", message)
	return r.rev("HEAD")
}

func (r *integrationRepo) checkoutNew(branch, from string) {
	r.t.Helper()
	mustRun(r.t, r.work, "git", "checkout", "--quiet", "-b", branch, from)
}

func (r *integrationRepo) checkout(branch string) {
	r.t.Helper()
	mustRun(r.t, r.work, "git", "checkout", "--quiet", branch)
}

func (r *integrationRepo) push(branch string) {
	r.t.Helper()
	mustRun(r.t, r.work, "git", "push", "--quiet", "origin", branch)
}

func (r *integrationRepo) rev(ref string) string {
	r.t.Helper()
	out, err := git(r.work, "rev-parse", ref)
	if err != nil {
		r.t.Fatalf("rev-parse %s: %v", ref, err)
	}
	return out
}

func (r *integrationRepo) originRev(ref string) string {
	r.t.Helper()
	out, _ := git(r.origin, "rev-parse", "--verify", "--quiet", ref)
	return out
}

// command is the job as the control plane would send it, with the parts every case shares.
func (r *integrationRepo) command(sourceBranch, targetBranch string, checks ...IntegrationCheckSpec) IntegrationJobCommand {
	return IntegrationJobCommand{
		JobID:        strings.ReplaceAll(r.t.Name(), "/", "-"),
		Kind:         "LAND_TASK",
		WorkDir:      r.work,
		RemoteName:   "origin",
		RefAuthority: "REMOTE",
		TargetRef:    "refs/heads/" + targetBranch,
		UpstreamRef:  "refs/heads/main",
		SourceRef:    "refs/heads/" + sourceBranch,
		Checks:       checks,
	}
}

func mustRun(t *testing.T, dir, name string, args ...string) {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=orbit", "GIT_AUTHOR_EMAIL=orbit@example.invalid",
		"GIT_COMMITTER_NAME=orbit", "GIT_COMMITTER_EMAIL=orbit@example.invalid")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%s %s: %v\n%s", name, strings.Join(args, " "), err, out)
	}
}

func silent(string, *IntegrationUpstreamMoved) {}

// TestIntegrationRebaseLandsAndVerifies is the ordinary case: a clean branch, no checks, and a
// target that did not exist yet. What it pins is J-S7 — the runner does not report LANDED from the
// fact that its own push returned zero, it reads the target back and compares the tree.
func TestIntegrationRebaseLandsAndVerifies(t *testing.T) {
	r := newIntegrationRepo(t)
	r.checkoutNew("task/a", "main")
	r.write("a.txt", "from a\n")
	r.commit("task a")
	r.push("task/a")
	r.checkout("main")

	result := runIntegrationJob(r.command("task/a", "project/line"), silent)
	if result.State != "LANDED" {
		t.Fatalf("state = %s (%s %s), want LANDED", result.State, result.ErrorCode, result.Phase)
	}
	if got := r.originRev("refs/heads/project/line"); got != result.LandedSha {
		t.Fatalf("origin holds %s, the result claims %s", got, result.LandedSha)
	}
	if result.LandedTreeSha == "" || result.LandedTreeSha != result.TestedTreeSha {
		t.Fatalf("landed tree %q != tested tree %q", result.LandedTreeSha, result.TestedTreeSha)
	}
	if body, _ := git(r.work, "show", result.LandedSha+":a.txt"); body != "from a" {
		t.Fatalf("the landed commit does not carry the task's file: %q", body)
	}
}

// TestIntegrationAbsorbsUpstreamBeforeLanding is J-S2: a project branch takes main's new commits by
// MERGE, never by rewriting itself, and the branch's own old tip stays an ancestor of what lands.
func TestIntegrationAbsorbsUpstreamBeforeLanding(t *testing.T) {
	r := newIntegrationRepo(t)
	r.checkoutNew("project/line", "main")
	r.write("line.txt", "on the line\n")
	lineTip := r.commit("project branch")
	r.push("project/line")

	r.checkout("main")
	r.write("upstream.txt", "moved on\n")
	mainTip := r.commit("main moved")
	r.push("main")

	r.checkoutNew("task/b", lineTip)
	r.write("b.txt", "from b\n")
	r.commit("task b")
	r.push("task/b")
	r.checkout("main")

	result := runIntegrationJob(r.command("task/b", "project/line"), silent)
	if result.State != "LANDED" {
		t.Fatalf("state = %s (%s %s), want LANDED", result.State, result.ErrorCode, result.Phase)
	}
	if result.MainSyncSha == "" {
		t.Fatal("upstream had moved and nothing absorbed it")
	}
	// No rewriting: both the old branch tip and main are still ancestors of what landed.
	for _, ancestor := range []string{lineTip, mainTip} {
		if !isAncestor(r.work, ancestor, result.LandedSha) {
			t.Fatalf("%s is no longer an ancestor of the landed commit — history was rewritten", ancestor)
		}
	}
	if result.LandedTreeSha != result.TestedTreeSha {
		t.Fatalf("landed tree %q != tested tree %q", result.LandedTreeSha, result.TestedTreeSha)
	}
}

// TestIntegrationMergesASourceThatCarriesMerges is J-S4's fork in the road.
//
// A branch that contains a merge commit contains somebody's conflict resolution inside it. Replaying
// it commit by commit asks for that resolution again and conflicts on work that was already
// reconciled, so the runner merges instead. The assertion is the outcome a person cares about —
// the job lands rather than stopping at a conflict — plus the shape that made it possible.
func TestIntegrationMergesASourceThatCarriesMerges(t *testing.T) {
	r := newIntegrationRepo(t)
	r.write("shared.txt", "base\n")
	base := r.commit("shared base")
	r.push("main")

	// A side branch and the task branch both rewrite the same file, and the task branch resolves
	// the conflict in a merge commit of its own.
	r.checkoutNew("side", base)
	r.write("shared.txt", "side\n")
	r.commit("side edit")

	r.checkoutNew("task/c", base)
	r.write("shared.txt", "task\n")
	r.commit("task edit")
	if out, err := git(r.work, "merge", "--no-commit", "side"); err == nil {
		t.Fatalf("expected a conflict to resolve, got %q", out)
	}
	r.write("shared.txt", "resolved by hand\n")
	mustRun(t, r.work, "git", "add", "-A")
	mustRun(t, r.work, "git", "commit", "--quiet", "--no-edit")
	r.push("task/c")
	r.checkout("main")

	result := runIntegrationJob(r.command("task/c", "project/line"), silent)
	if result.State != "LANDED" {
		t.Fatalf("state = %s (%s %s), want LANDED", result.State, result.ErrorCode, result.Phase)
	}
	if result.Phase != "VERIFY" {
		t.Fatalf("phase = %s, want VERIFY", result.Phase)
	}
	// The resolution survived: a rebase would have asked for it again.
	if body, _ := git(r.work, "show", result.LandedSha+":shared.txt"); body != "resolved by hand" {
		t.Fatalf("the hand resolution did not survive: %q", body)
	}
}

// TestIntegrationConflictLandsNothing is the claim an INTEGRATION_CONFLICT item makes to a person:
// the target is exactly where it was, and the item can name the files.
func TestIntegrationConflictLandsNothing(t *testing.T) {
	r := newIntegrationRepo(t)
	r.checkoutNew("project/line", "main")
	r.write("contested.txt", "theirs\n")
	r.commit("project branch")
	r.push("project/line")
	before := r.originRev("refs/heads/project/line")

	r.checkoutNew("task/d", "main")
	r.write("contested.txt", "ours\n")
	r.commit("task d")
	r.push("task/d")
	r.checkout("main")

	result := runIntegrationJob(r.command("task/d", "project/line"), silent)
	if result.State != "CONFLICT" {
		t.Fatalf("state = %s (%s), want CONFLICT", result.State, result.ErrorCode)
	}
	if got := r.originRev("refs/heads/project/line"); got != before {
		t.Fatalf("the target moved: %s -> %s", before, got)
	}
	if len(result.Conflicts) != 1 || result.Conflicts[0] != "contested.txt" {
		t.Fatalf("conflicts = %v, want [contested.txt]", result.Conflicts)
	}
	if result.LandedSha != "" {
		t.Fatalf("a conflict reported a landed sha: %s", result.LandedSha)
	}
}

// TestIntegrationCheckFailureLandsNothing is J-S5: the checks run on the COMBINED tree, and a red
// one stops the job with the branch untouched. The command here fails only when both files are
// present, which is a state neither branch is in on its own — the case the checks exist for.
func TestIntegrationCheckFailureLandsNothing(t *testing.T) {
	r := newIntegrationRepo(t)
	r.checkoutNew("project/line", "main")
	r.write("keep.txt", "quiet\n")
	r.commit("project branch")
	r.push("project/line")
	before := r.originRev("refs/heads/project/line")

	r.checkoutNew("task/e", "main")
	r.write("fuse.txt", "blows up when combined\n")
	r.commit("task e")
	r.push("task/e")
	r.checkout("main")

	check := IntegrationCheckSpec{
		Name:             "MERGE_CHECK",
		Command:          "test ! -f keep.txt -o ! -f fuse.txt",
		ExpectedExitCode: 0,
		TimeoutSeconds:   60,
	}
	result := runIntegrationJob(r.command("task/e", "project/line", check), silent)
	if result.State != "CHECK_FAILED" {
		t.Fatalf("state = %s (%s %s), want CHECK_FAILED", result.State, result.ErrorCode, result.Phase)
	}
	if got := r.originRev("refs/heads/project/line"); got != before {
		t.Fatalf("the target moved despite a red check: %s -> %s", before, got)
	}
	if len(result.Checks) != 1 || result.Checks[0].ExitCode == nil || *result.Checks[0].ExitCode == 0 {
		t.Fatalf("checks = %+v, want one with a non-zero exit code", result.Checks)
	}
	// The checks really did run on the combination, not on either side alone.
	if result.TestedSha == "" {
		t.Fatal("no tested commit was recorded")
	}
}

// TestIntegrationRefusesACheckThatMutatedTheTree is J-S6a. A check that commits or edits tracked
// files has moved the thing being verified out from under the verification, so what would land is
// not what passed. The job refuses rather than pushing either one.
func TestIntegrationRefusesACheckThatMutatedTheTree(t *testing.T) {
	r := newIntegrationRepo(t)
	r.checkoutNew("task/f", "main")
	r.write("f.txt", "from f\n")
	r.commit("task f")
	r.push("task/f")
	r.checkout("main")

	check := IntegrationCheckSpec{
		Name:             "MERGE_CHECK",
		Command:          "echo mutated >> README.md",
		ExpectedExitCode: 0,
		TimeoutSeconds:   60,
	}
	result := runIntegrationJob(r.command("task/f", "project/line", check), silent)
	if result.State != "ERROR" || result.ErrorCode != "CHECK_MUTATED_TREE" {
		t.Fatalf("state = %s / %s, want ERROR / CHECK_MUTATED_TREE", result.State, result.ErrorCode)
	}
	if got := r.originRev("refs/heads/project/line"); got != "" {
		t.Fatalf("something landed: %s", got)
	}
}

// TestIntegrationAlreadyLandedPushesNothing: a task whose work the target already contains is a
// fact to record, not an error and not a push.
func TestIntegrationAlreadyLandedPushesNothing(t *testing.T) {
	r := newIntegrationRepo(t)
	r.checkoutNew("task/g", "main")
	r.write("g.txt", "from g\n")
	r.commit("task g")
	r.push("task/g")
	r.checkoutNew("project/line", "task/g")
	r.push("project/line")
	before := r.originRev("refs/heads/project/line")
	r.checkout("main")

	result := runIntegrationJob(r.command("task/g", "project/line"), silent)
	if result.State != "ALREADY_LANDED" {
		t.Fatalf("state = %s (%s), want ALREADY_LANDED", result.State, result.ErrorCode)
	}
	if got := r.originRev("refs/heads/project/line"); got != before {
		t.Fatalf("the target moved: %s -> %s", before, got)
	}
}

// TestIntegrationLeavesNoWorktreeBehind: the scratch worktree is removed on every exit path,
// including the failing ones, because a leftover is what the NEXT attempt trips over.
func TestIntegrationLeavesNoWorktreeBehind(t *testing.T) {
	r := newIntegrationRepo(t)
	r.checkoutNew("project/line", "main")
	r.write("contested.txt", "theirs\n")
	r.commit("project branch")
	r.push("project/line")
	r.checkoutNew("task/h", "main")
	r.write("contested.txt", "ours\n")
	r.commit("task h")
	r.push("task/h")
	r.checkout("main")

	result := runIntegrationJob(r.command("task/h", "project/line"), silent)
	if result.State != "CONFLICT" {
		t.Fatalf("state = %s, want CONFLICT", result.State)
	}
	listed, err := git(r.work, "worktree", "list")
	if err != nil {
		t.Fatalf("worktree list: %v", err)
	}
	if strings.Contains(listed, integrateScratchPrefix) {
		t.Fatalf("a scratch worktree survived the job:\n%s", listed)
	}
}
