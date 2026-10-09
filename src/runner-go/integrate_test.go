package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
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
	t.Parallel()
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

// J-S4 and TASK_BRANCH promotion must not replay commits the target already contains just because
// the session recorded an older upstream base. A base beyond the fork still excludes session setup.
func TestIntegrationRebaseSessionBaseAnchor(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{"LAND_TASK", "LAND_PROMOTION"} {
		for _, basePosition := range []string{"before_fork", "at_fork", "after_fork"} {
			t.Run(kind+"/"+basePosition, func(t *testing.T) {
				t.Parallel()
				r := newIntegrationRepo(t)
				upstream := r.rev("main")
				target := "main"
				if kind == "LAND_TASK" {
					target = "project/line"
					r.checkoutNew(target, upstream)
				}
				// Replaying the first target commit onto its tip conflicts with the second edit.
				r.write("shared.txt", "first target edit\n")
				r.commit("target first edit")
				r.write("shared.txt", "second target edit\n")
				targetTip := r.commit("target second edit")
				r.push(target)

				sessionBase := upstream
				sourceBase := targetTip
				if basePosition == "after_fork" {
					sourceBase = upstream
				}
				r.checkoutNew("task/anchor", sourceBase)
				switch basePosition {
				case "at_fork":
					sessionBase = targetTip
				case "after_fork":
					r.write("session-baseline.txt", "session setup, excluded from the task\n")
					sessionBase = r.commit("session setup")
				}
				r.write("task.txt", "task's own change\n")
				r.commit("task change")
				r.push("task/anchor")

				// Build the expected tree independently: target tip plus only the task's change.
				r.checkoutNew("expected", targetTip)
				r.write("task.txt", "task's own change\n")
				r.commit("expected tree")
				expectedTree := r.rev("HEAD^{tree}")
				r.checkout("main")

				command := r.command("task/anchor", target)
				if kind == "LAND_PROMOTION" {
					command = r.promotionCommand(kind, "task/anchor", "TASK_BRANCH")
				}
				command.SessionBaseSha = sessionBase
				result := runIntegrationJob(command, silent)
				if result.State != "LANDED" {
					t.Fatalf("state = %s (%s %s), conflicts = %v, want LANDED", result.State, result.ErrorCode, result.Phase, result.Conflicts)
				}
				if result.LandedTreeSha != expectedTree || result.TestedTreeSha != expectedTree {
					t.Fatalf("landed/tested trees = %s/%s, want target plus task tree %s", result.LandedTreeSha, result.TestedTreeSha, expectedTree)
				}
				if got := r.originRev("refs/heads/" + target); got != result.LandedSha {
					t.Fatalf("target tip = %s, want landed commit %s", got, result.LandedSha)
				}
				if parent := r.rev(result.LandedSha + "^"); parent != targetTip {
					t.Fatalf("landed parent = %s, want target tip %s", parent, targetTip)
				}
				if commits, err := git(r.work, "rev-list", "--count", targetTip+".."+result.LandedSha); err != nil || commits != "1" {
					t.Fatalf("commits added to target = %q (%v), want only the task's one commit", commits, err)
				}
			})
		}
	}
}

// TestIntegrationAbsorbsUpstreamBeforeLanding is J-S2: a project branch takes main's new commits by
// MERGE, never by rewriting itself, and the branch's own old tip stays an ancestor of what lands.
func TestIntegrationAbsorbsUpstreamBeforeLanding(t *testing.T) {
	t.Parallel()
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

// The ledger both sides of the 2026-10-03 conflict wrote to (project 34Y7My8sqhKLWtmCQYv1l): the
// project branch added 0368 and main added 0367 and 0370, each at the end of the same file.
const (
	lineLedger     = "0366 base\n0368 the line\n"
	mainLedger     = "0366 base\n0367 main\n0370 main\n"
	resolvedLedger = "0366 base\n0367 main\n0368 the line\n0370 main\n"
)

// contestedLine is a project branch and a main that have each changed the ledger since the branch
// was cut, so absorbing main into the branch's tip conflicts whatever a task carries (J-S2).
func contestedLine(t *testing.T, r *integrationRepo) (lineTip, mainTip string) {
	t.Helper()
	r.write("ledger.txt", "0366 base\n")
	r.commit("the ledger")
	r.push("main")
	r.checkoutNew("project/line", "main")
	r.write("ledger.txt", lineLedger)
	lineTip = r.commit("project branch: 0368")
	r.push("project/line")
	r.checkout("main")
	r.write("ledger.txt", mainLedger)
	mainTip = r.commit("main: 0367 and 0370")
	r.push("main")
	return lineTip, mainTip
}

// absorbMain merges main into the branch that is checked out and resolves the ledger the way the
// 2026-10-03 resolution did: every entry kept, in number order.
func absorbMain(t *testing.T, r *integrationRepo) string {
	t.Helper()
	if out, err := git(r.work, "merge", "--no-commit", "main"); err == nil {
		t.Fatalf("expected the ledger to conflict, got %q", out)
	}
	r.write("ledger.txt", resolvedLedger)
	mustRun(t, r.work, "git", "add", "-A")
	mustRun(t, r.work, "git", "commit", "--quiet", "--no-edit")
	return r.rev("HEAD")
}

// TestIntegrationLandsASourceThatAlreadyAbsorbedUpstream is §3.1 M3. A source that contains the
// upstream tip and the line's tip has made J-S2's merge itself, conflict resolved, so the job does
// not make it again on the line's tip: the source lands as it is, by J-S4's MERGE, and the tree that
// lands is the source's own. Before this, J-S2 merged main into the line first, met the conflict the
// source had already resolved, and every landing of that line stopped at MAIN_SYNC.
func TestIntegrationLandsASourceThatAlreadyAbsorbedUpstream(t *testing.T) {
	t.Parallel()
	r := newIntegrationRepo(t)
	lineTip, mainTip := contestedLine(t, r)
	r.checkoutNew("task/absorbed", lineTip)
	r.write("work.txt", "the task's own work\n")
	r.commit("task work")
	sourceSha := absorbMain(t, r)
	r.push("task/absorbed")
	r.checkout("main")

	// The checks run on the tree that lands, and that tree carries both sides of the ledger.
	check := IntegrationCheckSpec{
		Name:             "MERGE_CHECK",
		Command:          "grep -qx '0368 the line' ledger.txt && grep -qx '0370 main' ledger.txt",
		ExpectedExitCode: 0,
		TimeoutSeconds:   60,
	}
	command := r.command("task/absorbed", "project/line", check)
	command.SessionBaseSha = lineTip
	var phases []string
	result := runIntegrationJob(command, func(phase string, _ *IntegrationUpstreamMoved) {
		phases = append(phases, phase)
	})
	if result.State != "LANDED" {
		t.Fatalf("state = %s (%s %s, conflicts %v), want LANDED", result.State, result.ErrorCode, result.Phase, result.Conflicts)
	}
	if slices.Contains(phases, "MAIN_SYNC") || result.MainSyncSha != "" {
		t.Fatalf("the job absorbed main again (phases %v, mainSyncSha %q)", phases, result.MainSyncSha)
	}
	if !slices.Contains(phases, "MERGE") {
		t.Fatalf("phases = %v, want the source landed by MERGE", phases)
	}
	sourceTree := r.rev(sourceSha + "^{tree}")
	if result.TestedTreeSha != sourceTree || result.LandedTreeSha != sourceTree {
		t.Fatalf("tested %q, landed %q, want the source's own tree %q", result.TestedTreeSha, result.LandedTreeSha, sourceTree)
	}
	if got := r.originRev("refs/heads/project/line"); got != result.LandedSha {
		t.Fatalf("origin holds %s, the result claims %s", got, result.LandedSha)
	}
	// A merge commit onto the line's tip: the branch moves forward and nothing is rewritten.
	parents, _ := git(r.work, "rev-list", "--parents", "-n", "1", result.LandedSha)
	if want := result.LandedSha + " " + lineTip + " " + sourceSha; parents != want {
		t.Fatalf("landed commit and parents = %q, want %q", parents, want)
	}
	if !isAncestor(r.work, mainTip, result.LandedSha) {
		t.Fatal("main's tip is not an ancestor of what landed")
	}
	if body, _ := git(r.work, "show", result.LandedSha+":ledger.txt"); body+"\n" != resolvedLedger {
		t.Fatalf("the resolution did not survive: %q", body)
	}
	if len(result.Checks) != 1 || result.Checks[0].ExitCode == nil || *result.Checks[0].ExitCode != 0 {
		t.Fatalf("checks = %+v, want the merge check to have passed on the source's tree", result.Checks)
	}
}

// TestIntegrationNewSyncTaskResolvesPromotionMergeConflict is the companion to the MAIN_SYNC
// task-reopen case above.  A promotion conflict has no task branch to send back, so the coordinator
// files a fresh sync task from the project branch tip.  That task absorbs upstream and carries the
// hand resolution; landing it must use J-S4 MERGE, preserve the resolution, and advance the line.
func TestIntegrationNewSyncTaskResolvesPromotionMergeConflict(t *testing.T) {
	t.Parallel()
	r := newIntegrationRepo(t)
	lineTip, mainTip := contestedLine(t, r)

	// This is a new sync task: its source starts at the project line and contains no prior task work.
	r.checkoutNew("task/sync", lineTip)
	sourceSha := absorbMain(t, r)
	r.push("task/sync")
	r.checkout("main")
	before := r.originRev("refs/heads/project/line")

	check := IntegrationCheckSpec{
		Name:             "MERGE_CHECK",
		Command:          "grep -qx '0368 the line' ledger.txt && grep -qx '0370 main' ledger.txt",
		ExpectedExitCode: 0,
		TimeoutSeconds:   60,
	}
	command := r.command("task/sync", "project/line", check)
	command.SessionBaseSha = lineTip
	var phases []string
	result := runIntegrationJob(command, func(phase string, _ *IntegrationUpstreamMoved) {
		phases = append(phases, phase)
	})

	if result.State != "LANDED" {
		t.Fatalf("state = %s (%s %s, conflicts %v), want LANDED", result.State, result.ErrorCode, result.Phase, result.Conflicts)
	}
	if result.MainSyncSha != "" || slices.Contains(phases, "MAIN_SYNC") {
		t.Fatalf("the sync task was absorbed a second time (phases %v, mainSyncSha %q)", phases, result.MainSyncSha)
	}
	if !slices.Contains(phases, "MERGE") {
		t.Fatalf("phases = %v, want MERGE mode", phases)
	}
	if result.TargetShaBefore != before || result.TargetShaBefore != lineTip {
		t.Fatalf("target before = %q, want the project tip %q without a rewritten target", result.TargetShaBefore, lineTip)
	}
	if !isAncestor(r.work, lineTip, result.LandedSha) {
		t.Fatal("the old project tip is not an ancestor of the landed commit: the line was force-rewritten")
	}
	if !isAncestor(r.work, mainTip, result.LandedSha) {
		t.Fatal("upstream's tip is not an ancestor of the landed commit")
	}
	if got := r.originRev("refs/heads/project/line"); got != result.LandedSha {
		t.Fatalf("origin holds %s, the result claims %s", got, result.LandedSha)
	}
	parents, _ := git(r.work, "rev-list", "--parents", "-n", "1", result.LandedSha)
	if want := result.LandedSha + " " + lineTip + " " + sourceSha; parents != want {
		t.Fatalf("landed commit and parents = %q, want %q", parents, want)
	}
	if body, _ := git(r.work, "show", result.LandedSha+":ledger.txt"); body+"\n" != resolvedLedger {
		t.Fatalf("the sync task's resolution did not survive: %q", body)
	}
	if len(result.Checks) != 1 || result.Checks[0].ExitCode == nil || *result.Checks[0].ExitCode != 0 {
		t.Fatalf("checks = %+v, want the merge check to have passed on the resolved tree", result.Checks)
	}
}

// TestIntegrationLandsASourceWhoseAbsorbedUpstreamMovedOn is the clean half of J-S2's source-absorb
// branch. A source that absorbed main at an earlier tip and carries the resolution — the sync-task
// shape, or the absorb of a reworked task — is the branch the CURRENT upstream must be merged into
// when main has moved on: merging it into the line's tip would meet the conflicts the source already
// resolved and stop at MAIN_SYNC. The absorb goes onto the source, J-S4 lands by MERGE, and the
// tree is the source plus what main gained since, with the old line tip still an ancestor.
func TestIntegrationLandsASourceWhoseAbsorbedUpstreamMovedOn(t *testing.T) {
	t.Parallel()
	r := newIntegrationRepo(t)
	lineTip, _ := contestedLine(t, r)
	r.checkoutNew("task/absorbed-moved", lineTip)
	r.write("work.txt", "the task's own work\n")
	r.commit("task work")
	sourceSha := absorbMain(t, r)
	r.push("task/absorbed-moved")
	r.checkout("main")
	r.write("upstream-moved.txt", "main moved on\n")
	mainMoved := r.commit("main moved")
	r.push("main")
	before := r.originRev("refs/heads/project/line")

	// The check runs on the tree that lands: the resolution, plus the commit main gained since.
	check := IntegrationCheckSpec{
		Name: "MERGE_CHECK",
		Command: "grep -qx '0368 the line' ledger.txt && grep -qx '0370 main' ledger.txt && " +
			"test -f upstream-moved.txt",
		ExpectedExitCode: 0,
		TimeoutSeconds:   60,
	}
	command := r.command("task/absorbed-moved", "project/line", check)
	command.SessionBaseSha = lineTip
	var phases []string
	result := runIntegrationJob(command, func(phase string, _ *IntegrationUpstreamMoved) {
		phases = append(phases, phase)
	})
	if result.State != "LANDED" {
		t.Fatalf("state = %s (%s %s, conflicts %v), want LANDED", result.State, result.ErrorCode, result.Phase, result.Conflicts)
	}
	// The current upstream was absorbed, by this job, and the source landed by MERGE.
	if result.MainSyncSha == "" || !slices.Contains(phases, "MAIN_SYNC") {
		t.Fatalf("phases %v, mainSyncSha %q: the current upstream was not absorbed into the source", phases, result.MainSyncSha)
	}
	if !slices.Contains(phases, "MERGE") {
		t.Fatalf("phases = %v, want the source landed by MERGE", phases)
	}
	if result.TargetShaBefore != lineTip || result.TargetShaBefore != before {
		t.Fatalf("target before = %q, want the line tip %q", result.TargetShaBefore, lineTip)
	}
	// The old line tip is an ancestor — no force, no rewrite — and so is everything that mattered:
	// the source with its resolution, and the upstream commit that moved on.
	if !isAncestor(r.work, lineTip, result.LandedSha) {
		t.Fatal("the old line tip is not an ancestor of the landed commit: the line was rewritten")
	}
	if !isAncestor(r.work, sourceSha, result.LandedSha) {
		t.Fatal("the source is not an ancestor of the landed commit: it was not landed by MERGE")
	}
	if !isAncestor(r.work, mainMoved, result.LandedSha) {
		t.Fatal("the upstream commit that moved on is not in the landed history")
	}
	if got := r.originRev("refs/heads/project/line"); got != result.LandedSha {
		t.Fatalf("origin holds %s, the result claims %s", got, result.LandedSha)
	}
	// The resolution survived, and the landed tree carries the commit main gained since.
	if body, _ := git(r.work, "show", result.LandedSha+":ledger.txt"); body+"\n" != resolvedLedger {
		t.Fatalf("the resolution did not survive: %q", body)
	}
	if body, _ := git(r.work, "show", result.LandedSha+":upstream-moved.txt"); body != "main moved on" {
		t.Fatalf("the landed tree does not carry the upstream commit that moved on: %q", body)
	}
	if len(result.Checks) != 1 || result.Checks[0].ExitCode == nil || *result.Checks[0].ExitCode != 0 {
		t.Fatalf("checks = %+v, want the merge check to have passed on the combined tree", result.Checks)
	}
}

// TestIntegrationMainSyncConflictWhenUpstreamTouchesTheResolution is the conflict half of J-S2's
// source-absorb branch: main moved on by editing the very place the source resolved. Merging the new
// upstream into the source meets that conflict — U′..U really did touch the same place — and it is
// reported as the MAIN_SYNC conflict it is, with the paths, and nothing lands.
func TestIntegrationMainSyncConflictWhenUpstreamTouchesTheResolution(t *testing.T) {
	t.Parallel()
	r := newIntegrationRepo(t)
	lineTip, _ := contestedLine(t, r)
	r.checkoutNew("task/absorbed-conflict", lineTip)
	r.write("work.txt", "the task's own work\n")
	r.commit("task work")
	absorbMain(t, r)
	r.push("task/absorbed-conflict")
	r.checkout("main")
	// The new entry lands exactly where the source's resolution inserted 0368 — between 0367 and
	// 0370 — so merging the new upstream into the source really does touch the same place.
	r.write("ledger.txt", "0366 base\n0367 main\n0369 main\n0370 main\n")
	r.commit("main edits the ledger again")
	r.push("main")
	before := r.originRev("refs/heads/project/line")

	command := r.command("task/absorbed-conflict", "project/line")
	command.SessionBaseSha = lineTip
	var phases []string
	result := runIntegrationJob(command, func(phase string, _ *IntegrationUpstreamMoved) {
		phases = append(phases, phase)
	})
	if result.State != "CONFLICT" || result.Phase != "MAIN_SYNC" {
		t.Fatalf("state = %s / %s (%s), want CONFLICT / MAIN_SYNC", result.State, result.Phase, result.ErrorCode)
	}
	if !slices.Contains(phases, "MAIN_SYNC") {
		t.Fatalf("phases = %v, want the absorb attempted", phases)
	}
	if len(result.Conflicts) != 1 || result.Conflicts[0] != "ledger.txt" {
		t.Fatalf("conflicts = %v, want [ledger.txt]", result.Conflicts)
	}
	if got := r.originRev("refs/heads/project/line"); got != before {
		t.Fatalf("the target moved: %s -> %s", before, got)
	}
	if result.LandedSha != "" || result.MainSyncSha != "" {
		t.Fatalf("a conflict reported landed %q, main sync %q", result.LandedSha, result.MainSyncSha)
	}
}

// TestIntegrationMainSyncConflictStandsWhenTheSourceLacksATip is the other side of M3: a source that
// does not contain both tips this job fetched has not made this absorb, so J-S2 makes it on the
// line's tip as before and reports the conflict it meets there. The line does not move. (A source
// that absorbed main and then saw the LINE move is in this list; one that saw MAIN move is the new
// source-absorb branch, pinned by TestIntegrationLandsASourceWhoseAbsorbedUpstreamMovedOn and
// TestIntegrationMainSyncConflictWhenUpstreamTouchesTheResolution.)
func TestIntegrationMainSyncConflictStandsWhenTheSourceLacksATip(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name string
		// Builds the source branch from the line's tip, and may move main or the line afterwards.
		build func(t *testing.T, r *integrationRepo, lineTip string)
	}{
		{
			name: "it never absorbed main",
			build: func(t *testing.T, r *integrationRepo, lineTip string) {
				r.checkoutNew("task/source", lineTip)
				r.write("work.txt", "the task's own work\n")
				r.commit("task work")
				r.push("task/source")
			},
		},
		{
			name: "the line moved after it absorbed main",
			build: func(t *testing.T, r *integrationRepo, lineTip string) {
				r.checkoutNew("task/source", lineTip)
				absorbMain(t, r)
				r.push("task/source")
				r.checkout("project/line")
				r.write("other.txt", "another task landed\n")
				r.commit("the line moved")
				r.push("project/line")
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newIntegrationRepo(t)
			lineTip, _ := contestedLine(t, r)
			tc.build(t, r, lineTip)
			r.checkout("main")
			before := r.originRev("refs/heads/project/line")

			command := r.command("task/source", "project/line")
			command.SessionBaseSha = lineTip
			var phases []string
			result := runIntegrationJob(command, func(phase string, _ *IntegrationUpstreamMoved) {
				phases = append(phases, phase)
			})
			if result.State != "CONFLICT" || result.Phase != "MAIN_SYNC" {
				t.Fatalf("state = %s / %s (%s), want CONFLICT / MAIN_SYNC", result.State, result.Phase, result.ErrorCode)
			}
			if !slices.Contains(phases, "MAIN_SYNC") {
				t.Fatalf("phases = %v, want the absorb attempted", phases)
			}
			if len(result.Conflicts) != 1 || result.Conflicts[0] != "ledger.txt" {
				t.Fatalf("conflicts = %v, want [ledger.txt]", result.Conflicts)
			}
			if got := r.originRev("refs/heads/project/line"); got != before {
				t.Fatalf("the target moved: %s -> %s", before, got)
			}
			if result.LandedSha != "" || result.MainSyncSha != "" {
				t.Fatalf("a conflict reported landed %q, main sync %q", result.LandedSha, result.MainSyncSha)
			}
		})
	}
}

// TestIntegrationTheUpstreamTipIsNotAnAbsorb: a branch that IS the upstream tip contains both tips
// when the line is behind main, and still has nothing of its own. It stays J-S3's NOTHING_TO_LAND,
// measured on the upstream (0300, 0346), and is not landed as a bare main sync.
func TestIntegrationTheUpstreamTipIsNotAnAbsorb(t *testing.T) {
	t.Parallel()
	r := newIntegrationRepo(t)
	r.checkoutNew("project/line", "main")
	r.push("project/line")
	before := r.originRev("refs/heads/project/line")
	r.checkout("main")
	r.write("upstream.txt", "main moved on\n")
	mainTip := r.commit("main moved")
	r.push("main")
	r.checkoutNew("orbit/rollout", mainTip)
	r.push("orbit/rollout")
	r.checkout("main")

	command := r.command("orbit/rollout", "project/line")
	command.SessionBaseSha = mainTip
	result := runIntegrationJob(command, silent)
	if result.State != "NOTHING_TO_LAND" {
		t.Fatalf("state = %s (%s %s), want NOTHING_TO_LAND", result.State, result.ErrorCode, result.Phase)
	}
	if result.SourceOnUpstream == nil || !*result.SourceOnUpstream {
		t.Fatalf("sourceOnUpstream = %v, want a measured true", result.SourceOnUpstream)
	}
	if got := r.originRev("refs/heads/project/line"); got != before {
		t.Fatalf("the target moved: %s -> %s", before, got)
	}
}

// TestIntegrationMergesASourceThatCarriesMerges is J-S4's fork in the road.
//
// A branch that contains a merge commit contains somebody's conflict resolution inside it. Replaying
// it commit by commit asks for that resolution again and conflicts on work that was already
// reconciled, so the runner merges instead. The assertion is the outcome a person cares about —
// the job lands rather than stopping at a conflict — plus the shape that made it possible.
func TestIntegrationMergesASourceThatCarriesMerges(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
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

// TestIntegrationNothingToLandMeasuresWhereTheTipIs: NOTHING_TO_LAND says the branch carries nothing
// of its own, and on a project branch AHEAD of main that is not yet "nothing that main lacks" — a
// branch forked from the line holds the line's own commits. So the runner measures where the empty
// tip is (`git merge-base --is-ancestor <tip> <upstream>`, migration 0346) and the control plane
// lets the answer out of a criterion's landing only on true. Both cases are the 2026-10-01 shape:
// the line is ahead of main, which is exactly where the old inference (target tip = upstream tip)
// could never say anything.
func TestIntegrationNothingToLandMeasuresWhereTheTipIs(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name string
		// The commit the empty branch forks at and never moves off: main, or the line's own tip.
		forkAt         string
		wantOnUpstream bool
	}{
		{name: "forked at main: the tip is on the upstream", forkAt: "main", wantOnUpstream: true},
		{name: "forked at the line: the tip is not on the upstream", forkAt: "project/line", wantOnUpstream: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newIntegrationRepo(t)
			r.checkoutNew("project/line", "main")
			r.write("line.txt", "landed on the line, not yet on main\n")
			r.commit("project branch")
			r.push("project/line")
			before := r.originRev("refs/heads/project/line")

			fork := r.rev(tc.forkAt)
			r.checkoutNew("orbit/rollout", tc.forkAt)
			r.push("orbit/rollout")
			r.checkout("main")

			command := r.command("orbit/rollout", "project/line")
			command.SessionBaseSha = fork
			result := runIntegrationJob(command, silent)
			if result.State != "NOTHING_TO_LAND" {
				t.Fatalf("state = %s (%s), want NOTHING_TO_LAND", result.State, result.ErrorCode)
			}
			if result.TargetShaBefore == result.UpstreamSha {
				t.Fatalf("the line is at main (%s), so this is not the case the measurement is for", result.UpstreamSha)
			}
			if result.SourceOnUpstream == nil {
				t.Fatal("NOTHING_TO_LAND reported no measurement of where the tip is")
			}
			if *result.SourceOnUpstream != tc.wantOnUpstream {
				t.Fatalf("sourceOnUpstream = %v, want %v (tip %s, upstream %s)",
					*result.SourceOnUpstream, tc.wantOnUpstream, result.SourceSha, result.UpstreamSha)
			}
			if got := r.originRev("refs/heads/project/line"); got != before {
				t.Fatalf("the target moved: %s -> %s", before, got)
			}
		})
	}
}

// TestIntegrationNothingToLandWhenEveryCommitIsAlreadyOnTheTarget is the 2026-10-09 incident (project
// 34PBlWiEZytRLTcPufJht). Main had taken the project's work in by another route, the line was rebuilt
// from main's tip, and every task's branch was handed to it again. Each branch carried commits of its
// own, and the rebase dropped every one of them ("patch contents already upstream"). The replay came
// back AT the base, the push moved nothing, and the job reported LANDED with a receipt for a landing
// that put nothing anywhere.
//
// The answer is NOTHING_TO_LAND, and nothing is pushed. It reports what was measured. The branch was
// not empty: every commit it carried was already in the base it was replayed onto
// (`sourceFullyApplied`). Its tip is not on the upstream (`sourceOnUpstream`), because what is there
// are copies of its commits, not the commits. Two lines give that answer: the incident's, AT main, and
// one ahead of main whose own commits already carry the change. The control plane reads them
// differently, so both shapes are pinned here.
//
// The control changes one fact: one more commit, which the target does not have. That commit is
// replayed and lands, and nothing is said about the branch being applied.
func TestIntegrationNothingToLandWhenEveryCommitIsAlreadyOnTheTarget(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name            string
		lineAheadOfMain bool
	}{
		{name: "the line at main", lineAheadOfMain: false},
		{name: "a line ahead of main", lineAheadOfMain: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newIntegrationRepo(t)
			fork := r.rev("main")
			// The task's branch: a commit of its own, made before its change reached the target.
			r.checkoutNew("task/applied", "main")
			r.write("feature.txt", "the task's change\n")
			r.commit("task: the change")
			r.push("task/applied")
			// The same change reaches the target by another route, as a commit of its own: on main, which
			// the line is then rebuilt from, or on a line that is ahead of main.
			if tc.lineAheadOfMain {
				r.checkoutNew("project/line", "main")
			} else {
				r.checkout("main")
			}
			r.write("feature.txt", "the task's change\n")
			r.commit("the same change, by another route")
			if tc.lineAheadOfMain {
				r.push("project/line")
			} else {
				r.push("main")
				r.checkoutNew("project/line", "main")
				r.push("project/line")
			}
			r.checkout("main")
			before := r.originRev("refs/heads/project/line")

			command := r.command("task/applied", "project/line")
			command.SessionBaseSha = fork
			var phases []string
			result := runIntegrationJob(command, func(phase string, _ *IntegrationUpstreamMoved) {
				phases = append(phases, phase)
			})
			if result.State != "NOTHING_TO_LAND" || result.Phase != "REBASE" {
				t.Fatalf("state = %s / %s (%s), want NOTHING_TO_LAND / REBASE", result.State, result.Phase, result.ErrorCode)
			}
			if result.SourceFullyApplied == nil || !*result.SourceFullyApplied {
				t.Fatalf("sourceFullyApplied = %v, want a measured true: the branch carried a commit, and the "+
					"target already had its change", result.SourceFullyApplied)
			}
			if result.SourceOnUpstream == nil || *result.SourceOnUpstream {
				t.Fatalf("sourceOnUpstream = %v, want a measured false: the upstream holds a copy of the "+
					"task's commit, not the commit", result.SourceOnUpstream)
			}
			if slices.Contains(phases, "PUSH") || slices.Contains(phases, "VERIFY") {
				t.Fatalf("phases = %v: nothing was there to push, so nothing was pushed or verified", phases)
			}
			if got := r.originRev("refs/heads/project/line"); got != before {
				t.Fatalf("the target moved: %s -> %s", before, got)
			}
			if result.LandedSha != "" || result.TestedSha != "" {
				t.Fatalf("landed %q, tested %q: an answer that landed nothing names nothing landed",
					result.LandedSha, result.TestedSha)
			}
			if atMain := result.TargetShaBefore == result.UpstreamSha; atMain == tc.lineAheadOfMain {
				t.Fatalf("target %s, upstream %s: the fixture is not the line it names", result.TargetShaBefore, result.UpstreamSha)
			}

			// The control: one more commit, which the target does not have.
			r.checkout("task/applied")
			r.write("more.txt", "work the target does not have\n")
			r.commit("task: more")
			r.push("task/applied")
			r.checkout("main")
			landed := runIntegrationJob(command, silent)
			if landed.State != "LANDED" {
				t.Fatalf("control state = %s (%s %s), want LANDED", landed.State, landed.ErrorCode, landed.Phase)
			}
			if landed.SourceFullyApplied != nil || landed.SourceOnUpstream != nil {
				t.Fatalf("a landing reported measurements nobody asked it for: applied %v, on upstream %v",
					landed.SourceFullyApplied, landed.SourceOnUpstream)
			}
			if commits, err := git(r.work, "rev-list", "--count", before+".."+landed.LandedSha); err != nil || commits != "1" {
				t.Fatalf("commits added to the target = %q (%v), want the one it did not have", commits, err)
			}
			if body, _ := git(r.work, "show", landed.LandedSha+":more.txt"); body != "work the target does not have" {
				t.Fatalf("the landed commit does not carry the new work: %q", body)
			}
		})
	}
}

// TestIntegrationNothingToLandForAnEmptyRangeTheTargetLacks covers the other way a replay comes back AT
// the base: there was nothing to replay. The session started on a commit the line does not have
// (another branch's work) and committed nothing. J-S3's "already contained" does not fire for that
// tip, and J-S4 replays an empty range. Before this, the result was pushed (a push that moved
// nothing), verified, and reported LANDED, with a receipt for work the branch never carried. It is
// NOTHING_TO_LAND, measured as NOT applied, so the control plane reads it exactly as it reads J-S3's
// empty branch (0300, 0346).
func TestIntegrationNothingToLandForAnEmptyRangeTheTargetLacks(t *testing.T) {
	t.Parallel()
	r := newIntegrationRepo(t)
	r.checkoutNew("project/line", "main")
	r.push("project/line")
	before := r.originRev("refs/heads/project/line")
	r.checkoutNew("other/work", "main")
	r.write("other.txt", "another branch's work\n")
	sessionBase := r.commit("another branch's commit")
	r.push("other/work")
	r.checkoutNew("orbit/idle", sessionBase)
	r.push("orbit/idle")
	r.checkout("main")

	command := r.command("orbit/idle", "project/line")
	command.SessionBaseSha = sessionBase
	var phases []string
	result := runIntegrationJob(command, func(phase string, _ *IntegrationUpstreamMoved) {
		phases = append(phases, phase)
	})
	if result.State != "NOTHING_TO_LAND" || result.Phase != "REBASE" {
		t.Fatalf("state = %s / %s (%s), want NOTHING_TO_LAND / REBASE", result.State, result.Phase, result.ErrorCode)
	}
	if result.SourceFullyApplied == nil || *result.SourceFullyApplied {
		t.Fatalf("sourceFullyApplied = %v, want a measured false: the branch carried no commit of its own",
			result.SourceFullyApplied)
	}
	if result.SourceOnUpstream == nil || *result.SourceOnUpstream {
		t.Fatalf("sourceOnUpstream = %v, want a measured false: the tip is a commit main does not have",
			result.SourceOnUpstream)
	}
	if slices.Contains(phases, "PUSH") || slices.Contains(phases, "VERIFY") {
		t.Fatalf("phases = %v: nothing was there to push, so nothing was pushed or verified", phases)
	}
	if got := r.originRev("refs/heads/project/line"); got != before {
		t.Fatalf("the target moved: %s -> %s", before, got)
	}
}

// TestIntegrationJobReportsTheTipOnTheUpstream: the measurement is only a fact once the control
// plane has it, so this follows it onto the wire — the result POSTed for the job carries
// `sourceOnUpstream: true`. And only that answer does: a landing is not asked the question, and its
// result says nothing about it rather than a false the control plane would have to tell apart from
// a measured one. The same goes for `sourceFullyApplied`, which every NOTHING_TO_LAND carries: false
// for the empty branch, true for a branch whose every commit the target already had.
func TestIntegrationJobReportsTheTipOnTheUpstream(t *testing.T) {
	t.Parallel()
	report := func(t *testing.T, job IntegrationJobCommand) map[string]interface{} {
		t.Helper()
		var result map[string]interface{}
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasSuffix(r.URL.Path, "/result") {
				if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
					t.Errorf("decode result: %v", err)
				}
				_, _ = w.Write([]byte(`{"accepted":true,"state":"NOTHING_TO_LAND","receiptIds":[],"openItemId":null}`))
				return
			}
			_, _ = w.Write([]byte(`{}`))
		}))
		defer srv.Close()
		runIntegrationJobAndReport(NewTransport(srv.URL, "tok"), job)
		if result == nil {
			t.Fatal("no result was reported")
		}
		return result
	}

	r := newIntegrationRepo(t)
	r.checkoutNew("project/line", "main")
	r.write("line.txt", "landed on the line, not yet on main\n")
	r.commit("project branch")
	r.push("project/line")
	fork := r.rev("main")
	r.checkoutNew("orbit/rollout", "main")
	r.push("orbit/rollout")
	r.checkoutNew("task/work", "main")
	r.write("work.txt", "a commit of its own\n")
	r.commit("task work")
	r.push("task/work")
	// A branch whose one commit the line already has, by another route.
	r.checkoutNew("task/applied", "main")
	r.write("line.txt", "landed on the line, not yet on main\n")
	r.commit("the line's change, made again on the task's branch")
	r.push("task/applied")
	r.checkout("main")

	empty := r.command("orbit/rollout", "project/line")
	empty.JobID = "job-empty"
	empty.SessionBaseSha = fork
	sent := report(t, empty)
	if sent["state"] != "NOTHING_TO_LAND" || sent["sourceOnUpstream"] != true || sent["sourceFullyApplied"] != false {
		t.Fatalf("result = %#v, want NOTHING_TO_LAND with sourceOnUpstream true and sourceFullyApplied false", sent)
	}

	applied := r.command("task/applied", "project/line")
	applied.JobID = "job-applied"
	applied.SessionBaseSha = fork
	sent = report(t, applied)
	if sent["state"] != "NOTHING_TO_LAND" || sent["sourceFullyApplied"] != true || sent["sourceOnUpstream"] != false {
		t.Fatalf("result = %#v, want NOTHING_TO_LAND with sourceFullyApplied true and sourceOnUpstream false", sent)
	}

	landing := r.command("task/work", "project/line")
	landing.JobID = "job-landing"
	landing.SessionBaseSha = fork
	sent = report(t, landing)
	if sent["state"] != "LANDED" {
		t.Fatalf("result = %#v, want LANDED", sent)
	}
	for _, field := range []string{"sourceOnUpstream", "sourceFullyApplied"} {
		if _, present := sent[field]; present {
			t.Fatalf("a landing reported a measurement nobody asked it for (%s): %#v", field, sent)
		}
	}
}

// TestIntegrationLeavesNoWorktreeBehind: the scratch worktree is removed on every exit path,
// including the failing ones, because a leftover is what the NEXT attempt trips over.
func TestIntegrationLeavesNoWorktreeBehind(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
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

// TestAutomaticPromotionHandsBackAMainThatMovesDuringThePush is M-T12's last window: main was where
// the check left it when the landing fetched, and moved before the push. The push is refused (no
// force), the lost race is taken again from the fetch (runIntegrationJob's refetch round), and there
// an automatic landing finds main moved and hands the candidate back: READY, nothing on main. The
// move is made from the landing's own PUSH report, which the runner sends just before it pushes, so
// the race is exact rather than timed. The owner-confirmed run of the same job through the same race
// is the control: it merges again onto the main that moved and lands (M5).
func TestAutomaticPromotionHandsBackAMainThatMovesDuringThePush(t *testing.T) {
	t.Parallel()
	for _, automatic := range []bool{true, false} {
		r := newIntegrationRepo(t)
		sourceSha, checked := checkedProjectBranch(t, r)
		land := automaticLanding(r, sourceSha, checked)
		land.Automatic = automatic

		var moved string
		result := runIntegrationJob(land, func(phase string, _ *IntegrationUpstreamMoved) {
			if phase != "PUSH" || moved != "" {
				return
			}
			r.write("elsewhere.txt", "somebody else landed in between\n")
			moved = r.commit("main moved between the fetch and the push")
			r.push("main")
		})
		if moved == "" {
			t.Fatalf("automatic=%v: the landing never reached PUSH (%s %s %s)", automatic, result.State, result.ErrorCode, result.Phase)
		}
		if automatic {
			if result.State != "READY" || result.LandedSha != "" {
				t.Fatalf("automatic landing whose push lost the race = %s %q (%s %s), want READY with nothing landed",
					result.State, result.LandedSha, result.ErrorCode, result.Phase)
			}
			if got := r.originRev("refs/heads/main"); got != moved {
				t.Fatalf("main is %s, want it left at the commit that moved it %s", got, moved)
			}
			continue
		}
		if result.State != "LANDED" {
			t.Fatalf("the owner-confirmed control = %s (%s %s), want LANDED onto the moved main", result.State, result.ErrorCode, result.Phase)
		}
		if parent, _ := git(r.work, "rev-parse", result.LandedSha+"^1"); parent != moved {
			t.Fatalf("the control landed onto %s, want the main that moved %s", parent, moved)
		}
	}
}

// TestAutomaticPromotionWithNoCheckedTipLandsNothing: a mark with nothing to hold the landing to is
// not a licence to land anywhere. The control plane never sends one; the runner does not trust that.
func TestAutomaticPromotionWithNoCheckedTipLandsNothing(t *testing.T) {
	t.Parallel()
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

// ownerLanding is the LAND_PROMOTION an owner confirmed (M-T4): the same facts automaticLanding
// carries, without the mark — so it lands onto an upstream that moved since the check rather than
// handing the candidate back (M5, M-T12).
func ownerLanding(r *integrationRepo, sourceSha string, checked integrationResult) IntegrationJobCommand {
	land := r.promotionCommand("LAND_PROMOTION", "project/p", "PROJECT_BRANCH")
	land.SourceSha = sourceSha
	land.UpstreamShaChecked = checked.UpstreamSha
	land.MergeTreeSha = checked.TestedTreeSha
	return land
}

// moveOriginMainAhead moves main at the origin WITHOUT moving this checkout's remote-tracking ref:
// a push by URL updates no `refs/remotes/*`. The next fetch in this repository therefore has a ref
// update to perform — which is what a competing fetch takes the lock for — rather than nothing to
// do.
func moveOriginMainAhead(t *testing.T, r *integrationRepo) string {
	t.Helper()
	r.checkoutNew("moved-main", "main")
	r.write("upstream-moved.txt", "another landing\n")
	moved := r.commit("main moved")
	mustRun(t, r.work, "git", "push", "--quiet", r.origin, "HEAD:refs/heads/main")
	r.checkout("main")
	mustRun(t, r.work, "git", "branch", "-D", "moved-main")
	return moved
}

// holdRefLock takes the lock git itself takes on a remote-tracking ref, the way a fetch competing
// with the job in the same repository holds it while it updates that ref.
func holdRefLock(t *testing.T, r *integrationRepo, ref string) string {
	t.Helper()
	lock := filepath.Join(r.work, ".git", "refs", "remotes", "origin", ref+".lock")
	if err := os.MkdirAll(filepath.Dir(lock), 0o755); err != nil {
		t.Fatalf("could not make the ref's directory: %v", err)
	}
	if err := os.WriteFile(lock, nil, 0o644); err != nil {
		t.Fatalf("could not take the ref lock: %v", err)
	}
	return lock
}

// releaseRefLockOnFirstRetry makes the competing process finish at the moment the job's first
// attempt has failed — the pause before it tries again, which is a moment nothing outside the fetch
// can observe.
func releaseRefLockOnFirstRetry(t *testing.T, lock string) {
	t.Helper()
	restore := integrationFetchLockPause
	released := false
	integrationFetchLockPause = func(d time.Duration) {
		if !released {
			released = true
			_ = os.Remove(lock)
		}
		restore(d)
	}
	t.Cleanup(func() {
		integrationFetchLockPause = restore
		_ = os.Remove(lock)
	})
}

// TestPromoteFetchRefLockRetriesAndLands is the 2026-10-02 incident (project 34Yjjgt2ERe9tU5TUmjAP),
// reproduced against the real thing.
//
// `git fetch <remote> <ref>` does not only write FETCH_HEAD: it updates
// `refs/remotes/<remote>/<branch>`, and that ref is shared by every job and every session worktree
// of this checkout. Two fetches arriving together and the second one's ref update is refused with
// "cannot lock ref …". Before this, that lost race ended the job — reported as BASE_REF_NOT_FOUND,
// "the upstream branch does not exist", which sent a reader to look at a branch that was never the
// problem — and the promotion it was a step of went BLOCKED. Here the lock is held the way a
// competing fetch holds it, and released as soon as the job has lost once, which is what the other
// process does a moment later: the job waits, fetches again, and lands.
func TestPromoteFetchRefLockRetriesAndLands(t *testing.T) {
	r := newIntegrationRepo(t)
	sourceSha, checked := checkedProjectBranch(t, r)
	moved := moveOriginMainAhead(t, r)

	releaseRefLockOnFirstRetry(t, holdRefLock(t, r, "main"))

	landed := runIntegrationJob(ownerLanding(r, sourceSha, checked), silent)
	if landed.ErrorCode == "BASE_REF_NOT_FOUND" {
		t.Fatalf("a ref another process was updating was reported as a missing branch: %v", landed.ErrorDetail)
	}
	if landed.State != "LANDED" {
		t.Fatalf("landing state = %s (%s %s), want LANDED after the retry: %v",
			landed.State, landed.ErrorCode, landed.Phase, landed.ErrorDetail)
	}
	if got := r.originRev("refs/heads/main"); got != landed.LandedSha {
		t.Fatalf("origin main is %s, the result claims %s", got, landed.LandedSha)
	}
	// The fetch that was retried is the one that read the upstream, so the landing is onto the tip
	// the origin had by then — the one the checkpoint did not see.
	if parent, _ := git(r.work, "rev-parse", landed.LandedSha+"^1"); parent != moved {
		t.Fatalf("the merge's first parent is %s, want the upstream tip that moved %s", parent, moved)
	}
}

// TestPromoteFetchRefLockThatOutlivesItsRetriesIsNotABranchThatIsMissing: the lock is held for every
// attempt. What the job then reports is the fetch failing — FETCH_FAILED, a condition a rerun
// answers — and NOT BASE_REF_NOT_FOUND, which is a statement about the upstream branch and sends the
// reader to check whether it exists.
func TestPromoteFetchRefLockThatOutlivesItsRetriesIsNotABranchThatIsMissing(t *testing.T) {
	r := newIntegrationRepo(t)
	sourceSha, checked := checkedProjectBranch(t, r)
	moved := moveOriginMainAhead(t, r)

	lock := holdRefLock(t, r, "main")
	restore := integrationFetchLockPause
	// Three attempts, at once: the lock is the fact under test, not the wait between them.
	integrationFetchLockPause = func(time.Duration) {}
	t.Cleanup(func() {
		integrationFetchLockPause = restore
		_ = os.Remove(lock)
	})

	result := runIntegrationJob(ownerLanding(r, sourceSha, checked), silent)
	if result.State != "ERROR" || result.Phase != "FETCH" {
		t.Fatalf("result = %s %s (%s), want an ERROR in FETCH", result.State, result.Phase, result.ErrorCode)
	}
	if result.ErrorCode != "FETCH_FAILED" {
		t.Fatalf("errorCode = %q, want FETCH_FAILED — a lock another process held is not a missing branch",
			result.ErrorCode)
	}
	if detail, _ := result.ErrorDetail["detail"].(string); !strings.Contains(detail, "cannot lock ref") {
		t.Fatalf("the error does not carry git's own words: %v", result.ErrorDetail)
	}
	if got := r.originRev("refs/heads/main"); got != moved {
		t.Fatalf("main is %s, want it left at %s — a failed FETCH lands nothing", got, moved)
	}
}

// TestIntegrationPreparesTheTreeBeforeTheChecks is the other half of a check: the command is one a
// task author wrote for a tree with an environment in it, and the combination tree comes out of git
// with none. So the tree's own recipe (scripts/worktree-overlay.sh) runs first, and what it lays
// down is what the check then finds. Without this the check is a false red about work that is fine
// — the shape of the command decided the verdict, which is the bug this pins shut.
func TestIntegrationPreparesTheTreeBeforeTheChecks(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
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
