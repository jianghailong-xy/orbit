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

// writeIn is write for a file whose parent directories do not exist yet (`scripts/…`): the recipe
// this suite's subject lives at one of those paths.
func (r *integrationRepo) writeIn(name, content string) {
	r.t.Helper()
	if err := os.MkdirAll(filepath.Dir(filepath.Join(r.work, name)), 0o755); err != nil {
		r.t.Fatalf("mkdir for %s: %v", name, err)
	}
	r.write(name, content)
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

// TestIntegrationNothingToLandForAnEmptyBranch: a branch whose tip is the commit its session
// started at carries nothing of the task's own — and J-S3's "already contained" is trivially true
// of it, because a fork point is in the target it forked from. That answer is NOTHING_TO_LAND
// (0300), and it is not ALREADY_LANDED: on 2026-09-23 the landing for a retry session that had died
// on a 429 was answered the positive way here, and the receipt written from it said a delivery was
// on the line that no branch held (project 34Tq39ByZ0rV4c6pJkfw7).
func TestIntegrationNothingToLandForAnEmptyBranch(t *testing.T) {
	r := newIntegrationRepo(t)
	// The line, at the commit the retry session will fork at and never move off.
	r.checkoutNew("project/line", "main")
	r.write("line.txt", "on the line\n")
	r.commit("project branch")
	r.push("project/line")
	before := r.originRev("refs/heads/project/line")

	fork := r.rev("main")
	r.checkoutNew("orbit/empty", "main")
	r.push("orbit/empty")
	r.checkout("main")

	command := r.command("orbit/empty", "project/line")
	command.SessionBaseSha = fork
	result := runIntegrationJob(command, silent)
	if result.State != "NOTHING_TO_LAND" {
		t.Fatalf("state = %s (%s), want NOTHING_TO_LAND", result.State, result.ErrorCode)
	}
	if got := r.originRev("refs/heads/project/line"); got != before {
		t.Fatalf("the target moved: %s -> %s", before, got)
	}
}

// TestIntegrationAlreadyLandedKeepsItsAnswerForABranchWithCommits is the control for the case
// above: the same J-S3 path, the same claim naming a base, and a branch whose tip is a DESCENDANT
// of that base. There is a commit of the task's on it and the target already contains it, so the
// answer stays the positive one.
func TestIntegrationAlreadyLandedKeepsItsAnswerForABranchWithCommits(t *testing.T) {
	r := newIntegrationRepo(t)
	fork := r.rev("main")
	r.checkoutNew("task/i", "main")
	r.write("i.txt", "from i\n")
	r.commit("task i")
	r.push("task/i")
	r.checkoutNew("project/line", "task/i")
	r.push("project/line")
	before := r.originRev("refs/heads/project/line")
	r.checkout("main")

	command := r.command("task/i", "project/line")
	command.SessionBaseSha = fork
	result := runIntegrationJob(command, silent)
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

// promotionCommand is a promotion job as the control plane sends it (§3.4): the upstream is both the
// ref being written and the ref being merged into, and the branch under offer is the source.
func (r *integrationRepo) promotionCommand(kind, sourceBranch, sourceKind string) IntegrationJobCommand {
	return IntegrationJobCommand{
		JobID:               strings.ReplaceAll(r.t.Name(), "/", "-"),
		Kind:                kind,
		WorkDir:             r.work,
		RemoteName:          "origin",
		RefAuthority:        "REMOTE",
		TargetRef:           "refs/heads/main",
		UpstreamRef:         "refs/heads/main",
		SourceRef:           "refs/heads/" + sourceBranch,
		PromotionSourceKind: sourceKind,
	}
}

// TestPromotionOfATaskBranchRebasesAndFastForwards is M6's other half (appendix A-Q7): a MAIN-line
// project has no branch of its own, so what reaches the upstream is the TASK's work replayed onto
// the upstream tip and fast-forwarded to — not a merge commit carrying the task's original.
//
// The upstream moves after the branch forked, which is what makes the rebase a replay rather than
// the no-op git makes of a branch already sitting on the tip. The check and the landing are two
// separate jobs, as they are in the queue, and the landing is held to the tree the check passed.
func TestPromotionOfATaskBranchRebasesAndFastForwards(t *testing.T) {
	r := newIntegrationRepo(t)
	r.checkoutNew("task/only", "main")
	r.write("a.txt", "from a\n")
	taskSha := r.commit("task a")
	r.push("task/only")
	r.checkout("main")
	fork := r.rev("main")

	r.write("upstream.txt", "moved on\n")
	mainTip := r.commit("main moved")
	r.push("main")

	check := r.promotionCommand("CHECK_PROMOTION", "task/only", "TASK_BRANCH")
	check.SessionBaseSha = fork
	check.Checks = []IntegrationCheckSpec{
		{Name: "TASK_ACCEPTANCE", Command: "test -f a.txt", ExpectedExitCode: 0, TimeoutSeconds: 60},
		{Name: "MERGE_CHECK", Command: "test -f README.md", ExpectedExitCode: 0, TimeoutSeconds: 60},
	}
	checked := runIntegrationJob(check, silent)
	if checked.State != "READY" {
		t.Fatalf("check state = %s (%s %s), want READY", checked.State, checked.ErrorCode, checked.Phase)
	}
	if len(checked.Checks) != 2 {
		t.Fatalf("the promotion ran %d checks, want the task's own and the project's", len(checked.Checks))
	}
	if checked.TestedSha == "" || checked.TestedSha == taskSha {
		t.Fatalf("tested commit %q: the task branch was not replayed", checked.TestedSha)
	}
	if got := r.originRev("refs/heads/main"); got != mainTip {
		t.Fatalf("a check pushed: main is %s, want %s", got, mainTip)
	}

	land := r.promotionCommand("LAND_PROMOTION", "task/only", "TASK_BRANCH")
	land.SessionBaseSha = fork
	land.SourceSha = taskSha
	land.UpstreamShaChecked = mainTip
	land.MergeTreeSha = checked.TestedTreeSha
	landed := runIntegrationJob(land, silent)
	if landed.State != "LANDED" {
		t.Fatalf("landing state = %s (%s %s), want LANDED", landed.State, landed.ErrorCode, landed.Phase)
	}
	if landed.LandedTreeSha != landed.TestedTreeSha {
		t.Fatalf("landed tree %q != tested tree %q", landed.LandedTreeSha, landed.TestedTreeSha)
	}
	if got := r.originRev("refs/heads/main"); got != landed.LandedSha {
		t.Fatalf("origin main is %s, the result claims %s", got, landed.LandedSha)
	}
	// A fast-forward onto the upstream tip, and nothing else: one parent, which is where main was.
	if parent, _ := git(r.work, "rev-parse", landed.LandedSha+"^"); parent != mainTip {
		t.Fatalf("the landed commit's parent is %s, want the upstream tip %s", parent, mainTip)
	}
	if out, _ := git(r.work, "rev-list", "--parents", "-n", "1", landed.LandedSha); len(strings.Fields(out)) != 2 {
		t.Fatalf("the landed commit is not a plain commit: %q", out)
	}
	// The task's own commit is NOT an ancestor: main gained the work, not the commit. This is the
	// measure that separates a rebase from a merge --no-ff, which would have kept it.
	if isAncestor(r.work, taskSha, landed.LandedSha) {
		t.Fatal("the task's original commit is an ancestor — that is a merge, not a rebase")
	}
	if body, _ := git(r.work, "show", landed.LandedSha+":a.txt"); body != "from a" {
		t.Fatalf("the landed commit does not carry the task's file: %q", body)
	}
}

// checkedProjectBranch is a project branch with one task's work on it, checked for promotion the
// way the queue checks it: the CHECK_PROMOTION's READY, whose upstream tip and tree are what a
// landing of it is held to.
func checkedProjectBranch(t *testing.T, r *integrationRepo) (sourceSha string, checked integrationResult) {
	t.Helper()
	r.checkoutNew("project/p", "main")
	r.write("feature.txt", "from the project\n")
	sourceSha = r.commit("task on the project branch")
	r.push("project/p")
	r.checkout("main")
	check := r.promotionCommand("CHECK_PROMOTION", "project/p", "PROJECT_BRANCH")
	check.SourceSha = sourceSha
	checked = runIntegrationJob(check, silent)
	if checked.State != "READY" {
		t.Fatalf("check state = %s (%s %s), want READY", checked.State, checked.ErrorCode, checked.Phase)
	}
	return sourceSha, checked
}

// automaticLanding is the LAND_PROMOTION the project's Automatic setting queues for that check
// (§3.3 M-T11): the same frozen facts an owner-confirmed landing carries, plus the mark.
func automaticLanding(r *integrationRepo, sourceSha string, checked integrationResult) IntegrationJobCommand {
	land := r.promotionCommand("LAND_PROMOTION", "project/p", "PROJECT_BRANCH")
	land.SourceSha = sourceSha
	land.UpstreamShaChecked = checked.UpstreamSha
	land.MergeTreeSha = checked.TestedTreeSha
	land.Automatic = true
	return land
}

// TestAutomaticPromotionLandsOntoTheUpstreamItWasCheckedAgainst is M-T11's landing when nothing
// moved: the merge the check built is rebuilt on the same tip, comes out as the same tree, and is
// pushed — a merge commit whose first parent is exactly the upstream the check ran against, which is
// what makes `git revert -m 1 <merge>` the receipt's undo.
func TestAutomaticPromotionLandsOntoTheUpstreamItWasCheckedAgainst(t *testing.T) {
	r := newIntegrationRepo(t)
	sourceSha, checked := checkedProjectBranch(t, r)

	landed := runIntegrationJob(automaticLanding(r, sourceSha, checked), silent)
	if landed.State != "LANDED" {
		t.Fatalf("landing state = %s (%s %s), want LANDED", landed.State, landed.ErrorCode, landed.Phase)
	}
	if landed.LandedTreeSha != checked.TestedTreeSha {
		t.Fatalf("landed tree %q is not the tree the check passed %q", landed.LandedTreeSha, checked.TestedTreeSha)
	}
	if got := r.originRev("refs/heads/main"); got != landed.LandedSha {
		t.Fatalf("origin main is %s, the result claims %s", got, landed.LandedSha)
	}
	if parent, _ := git(r.work, "rev-parse", landed.LandedSha+"^1"); parent != checked.UpstreamSha {
		t.Fatalf("the merge's first parent is %s, want the checked upstream %s", parent, checked.UpstreamSha)
	}
}

// TestAutomaticPromotionHandsBackAMovedUpstream is M-T12, the half of "clean" the control plane
// cannot see: main moved after the check. An owner-confirmed landing re-checks the new tip and
// merges it (M5) — that is what the owner confirmed. An automatic one lands NOTHING: no merge, no
// check, no push, no upstreamMoved report (which would move the promotion to RECHECKING, a state
// whose card promises it lands on its own), and READY, so the owner is asked. The owner-confirmed
// run of the very same job is the control: it is what the Automatic mark is the difference from.
func TestAutomaticPromotionHandsBackAMovedUpstream(t *testing.T) {
	r := newIntegrationRepo(t)
	sourceSha, checked := checkedProjectBranch(t, r)
	r.write("elsewhere.txt", "somebody else landed first\n")
	moved := r.commit("main moved after the check")
	r.push("main")

	var reports []string
	handedBack := runIntegrationJob(automaticLanding(r, sourceSha, checked), func(phase string, m *IntegrationUpstreamMoved) {
		if m != nil {
			reports = append(reports, "upstreamMoved")
		}
		reports = append(reports, phase)
	})
	if handedBack.State != "READY" {
		t.Fatalf("automatic landing onto a moved main = %s (%s %s), want READY", handedBack.State, handedBack.ErrorCode, handedBack.Phase)
	}
	if got := r.originRev("refs/heads/main"); got != moved {
		t.Fatalf("an automatic landing pushed onto a moved main: main is %s, want it left at %s", got, moved)
	}
	if handedBack.TestedSha != "" || len(handedBack.Checks) != 0 {
		t.Fatalf("it merged or checked something (tested %q, %d checks): it was to land nothing", handedBack.TestedSha, len(handedBack.Checks))
	}
	if handedBack.UpstreamSha != moved {
		t.Fatalf("the result names upstream %q, want the tip it found %q", handedBack.UpstreamSha, moved)
	}
	for _, report := range reports {
		if report == "upstreamMoved" {
			t.Fatalf("the automatic landing reported upstreamMoved (%v): the promotion would read RECHECKING", reports)
		}
	}

	// The control: the same landing without the mark is the owner's, and it re-checks and lands.
	confirmed := automaticLanding(r, sourceSha, checked)
	confirmed.Automatic = false
	landed := runIntegrationJob(confirmed, silent)
	if landed.State != "LANDED" {
		t.Fatalf("the owner-confirmed control = %s (%s %s), want LANDED after a re-check", landed.State, landed.ErrorCode, landed.Phase)
	}
	if parent, _ := git(r.work, "rev-parse", landed.LandedSha+"^1"); parent != moved {
		t.Fatalf("the control landed onto %s, want the moved tip %s", parent, moved)
	}
}

// TestAutomaticPromotionWithNoCheckedTipLandsNothing: a mark with nothing to hold the landing to is
// not a licence to land anywhere. The control plane never sends one; the runner does not trust that.
func TestAutomaticPromotionWithNoCheckedTipLandsNothing(t *testing.T) {
	r := newIntegrationRepo(t)
	sourceSha, checked := checkedProjectBranch(t, r)
	land := automaticLanding(r, sourceSha, checked)
	land.UpstreamShaChecked = ""

	result := runIntegrationJob(land, silent)
	if result.State != "READY" {
		t.Fatalf("an automatic landing with no checked tip = %s (%s %s), want READY", result.State, result.ErrorCode, result.Phase)
	}
	if got := r.originRev("refs/heads/main"); got != checked.UpstreamSha {
		t.Fatalf("main moved to %s, want it left at %s", got, checked.UpstreamSha)
	}
}

// TestIntegrationPreparesTheTreeBeforeTheChecks is the other half of a check: the command is one a
// task author wrote for a tree with an environment in it, and the combination tree comes out of git
// with none. So the tree's own recipe (scripts/worktree-overlay.sh) runs first, and what it lays
// down is what the check then finds. Without this the check is a false red about work that is fine
// — the shape of the command decided the verdict, which is the bug this pins shut.
func TestIntegrationPreparesTheTreeBeforeTheChecks(t *testing.T) {
	r := newIntegrationRepo(t)
	r.checkoutNew("project/line", "main")
	// The recipe is the PROJECT's: what the line integrates is what the tree carries. It writes an
	// untracked path, which is what the real one does (`node_modules/`, `dist/`) — and J-S6a, which
	// refuses a check that touched the TREE, must not read that as a mutated tree.
	r.writeIn("scripts/worktree-overlay.sh",
		"#!/usr/bin/env bash\nset -eu\nmkdir -p node_modules\necho ready > node_modules/.ready\n")
	r.commit("project branch: the environment recipe")
	r.push("project/line")
	r.checkoutNew("task/i", "main")
	r.write("i.txt", "from i\n")
	r.commit("task i")
	r.push("task/i")
	r.checkout("main")

	check := IntegrationCheckSpec{
		Name: "TASK_ACCEPTANCE", Command: "test -f node_modules/.ready",
		ExpectedExitCode: 0, TimeoutSeconds: 60,
	}
	result := runIntegrationJob(r.command("task/i", "project/line", check), silent)
	if result.State != "LANDED" {
		t.Fatalf("state = %s (%s %s), want LANDED: the recipe did not run, or running it refused the tree",
			result.State, result.ErrorCode, result.Phase)
	}
	if len(result.Checks) != 1 || result.Checks[0].ExitCode == nil || *result.Checks[0].ExitCode != 0 {
		t.Fatalf("checks = %+v, want the task acceptance to have passed in the prepared tree", result.Checks)
	}
	if result.LandedTreeSha == "" || result.LandedTreeSha != result.TestedTreeSha {
		t.Fatalf("landed tree %q != tested tree %q", result.LandedTreeSha, result.TestedTreeSha)
	}
}

// TestIntegrationRefusesWhenTheRecipeFails: a recipe that could not run means the checks never got a
// tree they could be judged in. That is an ERROR, not a red check — reporting it as the task's
// command failing would be the same false red one layer down, and it is the machine that is broken.
func TestIntegrationRefusesWhenTheRecipeFails(t *testing.T) {
	r := newIntegrationRepo(t)
	r.checkoutNew("project/line", "main")
	r.writeIn("scripts/worktree-overlay.sh",
		"#!/usr/bin/env bash\necho 'no node_modules in the main checkout' >&2\nexit 2\n")
	r.commit("project branch: a recipe that cannot run")
	r.push("project/line")
	before := r.originRev("refs/heads/project/line")
	r.checkoutNew("task/j", "main")
	r.write("j.txt", "from j\n")
	r.commit("task j")
	r.push("task/j")
	r.checkout("main")

	check := IntegrationCheckSpec{
		Name: "TASK_ACCEPTANCE", Command: "exit 0", ExpectedExitCode: 0, TimeoutSeconds: 60,
	}
	result := runIntegrationJob(r.command("task/j", "project/line", check), silent)
	if result.State != "ERROR" || result.ErrorCode != "CHECK_TREE_UNPREPARED" {
		t.Fatalf("state = %s / %s, want ERROR / CHECK_TREE_UNPREPARED", result.State, result.ErrorCode)
	}
	if result.Phase != "CHECK" {
		t.Fatalf("phase = %q, want CHECK", result.Phase)
	}
	// The check itself would have passed. It did not run: what is reported is the tree, not a verdict.
	if len(result.Checks) != 0 {
		t.Fatalf("checks = %+v, want none — no check ran in an unprepared tree", result.Checks)
	}
	if detail, _ := result.ErrorDetail["detail"].(string); !strings.Contains(detail, "no node_modules in the main checkout") {
		t.Fatalf("errorDetail = %+v, want the recipe's own output in it", result.ErrorDetail)
	}
	if got := r.originRev("refs/heads/project/line"); got != before {
		t.Fatalf("the target moved: %s -> %s", before, got)
	}
}

// TestPromotionPreparesTheTreeBeforeTheChecks is M-S3's half of the same step. A promotion of a
// TASK_BRANCH runs the TASK'S OWN acceptance command (M-F2) on the same kind of tree J-S5 does, so
// the tree's recipe has to run there too — and this is the path a MAIN line's tasks take, which is
// where a command that needs JS dependencies is most likely to be declared.
func TestPromotionPreparesTheTreeBeforeTheChecks(t *testing.T) {
	r := newIntegrationRepo(t)
	r.writeIn("scripts/worktree-overlay.sh",
		"#!/usr/bin/env bash\nset -eu\nmkdir -p node_modules\ntouch node_modules/.ready\n")
	r.commit("the environment recipe, on the upstream")
	r.push("main")

	r.checkoutNew("task/k", "main")
	r.write("k.txt", "from k\n")
	r.commit("task k")
	r.push("task/k")
	r.checkout("main")
	mainTip := r.originRev("refs/heads/main")

	check := r.promotionCommand("CHECK_PROMOTION", "task/k", "TASK_BRANCH")
	check.SessionBaseSha = r.rev("main")
	check.Checks = []IntegrationCheckSpec{
		{Name: "TASK_ACCEPTANCE", Command: "test -f node_modules/.ready", ExpectedExitCode: 0, TimeoutSeconds: 60},
	}
	result := runIntegrationJob(check, silent)
	if result.State != "READY" {
		t.Fatalf("state = %s (%s %s), want READY: the recipe did not run in the promotion's tree",
			result.State, result.ErrorCode, result.Phase)
	}
	if len(result.Checks) != 1 || result.Checks[0].ExitCode == nil || *result.Checks[0].ExitCode != 0 {
		t.Fatalf("checks = %+v, want the task acceptance to have passed", result.Checks)
	}
	if got := r.originRev("refs/heads/main"); got != mainTip {
		t.Fatalf("a check pushed: main is %s, want %s", got, mainTip)
	}
}
