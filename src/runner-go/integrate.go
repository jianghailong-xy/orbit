package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The capability a runner declares before the control plane hands it any integration job
// (docs/project-integration-line-contract.md §2.3 J-T2). Its apiserver twin is
// INTEGRATION_JOB_CLAIM in src/apiserver/src/projects/project-integration-job.ts.
const integrationJobCapabilityV1 = "integration-job/v1"

// The capability that says this runner honours an automatic landing's one extra rule (§3.3 M-T12):
// land only onto the upstream tip the check ran against, and hand the candidate back untouched when
// the upstream has moved, rather than checking the new tip and merging it as an owner-confirmed
// landing does (M5). The control plane confirms nothing by itself for a runner that has not said
// this, and never hands such a runner an automatic landing. Its apiserver twin is
// PROMOTION_AUTOMATIC_LAND in src/apiserver/src/projects/project-integration-job.ts.
const promotionAutomaticLandCapabilityV1 = "promotion-automatic-land/v1"

// Where a throwaway integration worktree lives, under the same worktrees directory as everything
// else this runner stages. Prefixed so the garbage collector can recognise one that outlived its
// job (a process killed mid-run) and remove it.
const integrateScratchPrefix = "_integrate-"

// How many times a job goes back to FETCH when the push is refused because somebody else advanced
// the target first (§2.5 J5, appendix A-Q5). Two, and then the job stops: a queue that retries a
// race forever is a queue that never reports anything.
const integrationRefetchRounds = 2

// The most check output a result carries, per §2.1. The control plane clips it again; this keeps a
// runaway command from putting a gigabyte on the wire in the first place.
const integrationOutputTail = 16 * 1024

// integrationLocks serialises jobs on this machine by repository root and target ref. The database
// serialises them across machines (J1's partial unique index over RUNNING rows); this is the local
// half, and it is what keeps two goroutines of THIS process from staging two worktrees onto one
// checkout's refs at once.
var integrationLocks sync.Map

func integrationLock(repoRoot, targetRef string) *sync.Mutex {
	actual, _ := integrationLocks.LoadOrStore(repoRoot+"\x00"+targetRef, &sync.Mutex{})
	return actual.(*sync.Mutex)
}

// integrationResult is what one job came to, in the shape the report sends.
type integrationResult struct {
	State           string
	Phase           string
	SourceSha       string
	TargetShaBefore string
	UpstreamSha     string
	MainSyncSha     string
	TestedSha       string
	TestedTreeSha   string
	LandedSha       string
	LandedTreeSha   string
	AheadOfUpstream *int
	FilesChanged    *int
	Checks          []IntegrationCheckResult
	Conflicts       []string
	ErrorCode       string
	ErrorDetail     map[string]any
}

// integrationReporter is what runIntegrationJob tells about each step it reaches. The runloop
// passes one that POSTs; a test passes one that records. The second argument is non-nil exactly
// once: the step where a confirmed promotion found the upstream had moved and is redoing its merge
// and its checks on the new tip (§3.3 M-T7).
type integrationReporter func(phase string, moved *IntegrationUpstreamMoved)

// runIntegrationJob performs one claimed job and answers what it came to
// (docs/project-integration-line-contract.md §2.4).
//
// The whole of it is mechanical, and the order is the point: nothing is pushed until the checks
// have run on the exact commit that will be pushed, and nothing is reported as landed until the
// remote has been read back and found holding that commit with that tree. A failure anywhere
// before the push leaves the target ref exactly as it was — which is the claim the CONFLICT and
// CHECK_FAILED items make to a person, so it must be true rather than merely intended.
func runIntegrationJob(cmd IntegrationJobCommand, report integrationReporter) integrationResult {
	if cmd.CancelRequested {
		return integrationResult{State: "CANCELLED", Phase: "FETCH"}
	}
	// The workspace a job is claimed from is stored with a leading ~ (the product's own spelling of
	// "this runner's home"), and `git -C` does not expand one — unresolved, a `~/…` work dir dies
	// right here as "cannot change to '~/orbit': No such file or directory", which is what a
	// project's FIRST landing hits. Same expansion the session path does in sessionExecDir, done
	// once so the checkout check and the scratch worktree both work from the resolved path.
	workDir := expandTilde(cmd.WorkDir)
	repoRoot, err := git(workDir, "rev-parse", "--show-toplevel")
	if err != nil || repoRoot == "" {
		return errorResult("FETCH", "FETCH_FAILED", map[string]any{
			"detail": fmt.Sprintf("%s is not a git checkout: %v", workDir, err),
		})
	}
	lock := integrationLock(repoRoot, cmd.TargetRef)
	lock.Lock()
	defer lock.Unlock()

	scratch := filepath.Join(filepath.Dir(workDir), integrateScratchPrefix+cmd.JobID)
	defer removeIntegrationWorktree(repoRoot, scratch)

	one := integrateOnce
	if cmd.Kind == "CHECK_PROMOTION" || cmd.Kind == "LAND_PROMOTION" {
		// A promotion merges the whole project branch into the upstream instead of replaying one
		// task onto the line (§3.4). Same loop around it, and for the same reason: the one failure
		// worth trying again inside a single job is losing a race for the ref it is writing.
		one = promoteOnce
	}
	var last integrationResult
	for round := 0; round <= integrationRefetchRounds; round++ {
		removeIntegrationWorktree(repoRoot, scratch)
		last = one(cmd, repoRoot, scratch, report)
		// The one thing worth doing again inside a single job: the target moved between the check
		// and the push, so the tree that was tested is no longer the tree that would land. Re-read
		// the refs and re-run the checks on the new combination (§2.5 J5).
		if last.State == "ERROR" && last.ErrorCode == "TARGET_MOVED" && round < integrationRefetchRounds {
			continue
		}
		return last
	}
	return last
}

// integrateOnce is one pass over the steps: fetch, absorb upstream, rebase or merge, check, push,
// verify. Split out so a lost push race can repeat the whole of it against fresh tips rather than
// patching up half-finished state.
func integrateOnce(cmd IntegrationJobCommand, repoRoot, scratch string, report integrationReporter) integrationResult {
	remote := cmd.RemoteName
	if remote == "" {
		remote = "origin"
	}
	local := cmd.RefAuthority == "RUNNER_LOCAL"

	// ── J-S1 FETCH ────────────────────────────────────────────────────────────────────────────
	report("FETCH", nil)
	if !local {
		// The target may legitimately not exist yet (a project branch nobody has pushed), so the
		// two refs are fetched separately and only upstream's absence is fatal.
		if _, err := git(repoRoot, "fetch", remote, cmd.UpstreamRef); err != nil {
			return errorResult("FETCH", "BASE_REF_NOT_FOUND", map[string]any{
				"ref": cmd.UpstreamRef, "detail": gitStderr(err),
			})
		}
		if _, err := git(repoRoot, "fetch", remote, cmd.TargetRef); err != nil {
			// Not an error: a first landing creates the branch.
			_ = err
		}
	}
	upstreamSha, err := integrationTip(repoRoot, remote, cmd.UpstreamRef, local)
	if err != nil || upstreamSha == "" {
		return errorResult("FETCH", "BASE_REF_NOT_FOUND", map[string]any{
			"ref": cmd.UpstreamRef, "detail": errText(err),
		})
	}
	targetSha, _ := integrationTip(repoRoot, remote, cmd.TargetRef, local)
	if targetSha == "" {
		// A project branch that does not exist yet starts where upstream is.
		targetSha = upstreamSha
	}
	sourceSha, err := git(repoRoot, "rev-parse", cmd.SourceRef+"^{commit}")
	if err != nil || sourceSha == "" {
		return errorResult("FETCH", "SOURCE_BRANCH_MISSING", map[string]any{
			"ref": cmd.SourceRef, "detail": errText(err),
		})
	}

	result := integrationResult{
		SourceSha: sourceSha, TargetShaBefore: targetSha, UpstreamSha: upstreamSha,
	}

	// A worktree detached at the target tip: everything below happens there, and nothing below
	// touches the checkout the agents work in.
	if _, err := git(repoRoot, "worktree", "add", "--detach", scratch, targetSha); err != nil {
		return errorResult("FETCH", "FETCH_FAILED", map[string]any{
			"detail": "could not stage an integration worktree: " + gitStderr(err),
		})
	}

	// ── J-S2 MAIN_SYNC ────────────────────────────────────────────────────────────────────────
	// Only a project branch absorbs upstream: on a MAIN line the target IS upstream.
	base := targetSha
	if cmd.TargetRef != cmd.UpstreamRef && !isAncestor(scratch, upstreamSha, targetSha) {
		report("MAIN_SYNC", nil)
		merged, conflicts, err := integrationMerge(scratch, upstreamSha,
			fmt.Sprintf("Merge %s into %s", cmd.UpstreamRef, cmd.TargetRef))
		if err != nil {
			result.State, result.Phase, result.Conflicts = "CONFLICT", "MAIN_SYNC", conflicts
			return result
		}
		result.MainSyncSha = merged
		base = merged
	}

	// ── J-S3 already contained ────────────────────────────────────────────────────────────────
	if isAncestor(scratch, sourceSha, base) {
		// THE EMPTY BRANCH FIRST, because "already contained" is trivially true of one: its tip is
		// the commit it forked at, and every fork point is in the target it forked from. A branch
		// whose tip IS the commit its session started at carries nothing of the task's own, and
		// answering ALREADY_LANDED for it is what wrote a receipt for a delivery that did not exist
		// (2026-09-23, project 34Tq39ByZ0rV4c6pJkfw7): the landing had been queued for a retry
		// session that died on a 429 without a commit, the branch tip was the upstream, and the
		// promotion card counted the task as work the merge did not contain. The same test the
		// control plane applies to an older runner's spelling of this answer.
		//
		// Only when the claim names a base: without one, emptiness and a genuine landing are not
		// distinguishable here — `merge-base S T` answers S in both — and an answer that cannot be
		// told apart is not one to give.
		if cmd.SessionBaseSha != "" && sourceSha == cmd.SessionBaseSha {
			// Nothing to land, and nothing was pushed: the absorb commit is discarded with the
			// worktree, exactly as in the answer below.
			result.State, result.Phase = "NOTHING_TO_LAND", "REBASE"
			return result
		}
		// Nothing to land, and the absorb commit is discarded with the worktree: a merge of
		// upstream that carries no task work is not this job's to push.
		result.State, result.Phase = "ALREADY_LANDED", "REBASE"
		return result
	}

	// ── J-S4 REBASE or MERGE ──────────────────────────────────────────────────────────────────
	fork, _ := git(scratch, "merge-base", sourceSha, base)
	merges, _ := git(scratch, "rev-list", "--merges", fork+".."+sourceSha)
	var tested string
	if strings.TrimSpace(merges) != "" {
		// A source that contains merge commits carries somebody's conflict resolutions inside
		// them. A rebase would replay the sides and ask for those resolutions again; a merge keeps
		// them (§2.4 J-S4).
		report("MERGE", nil)
		merged, conflicts, err := integrationMerge(scratch, sourceSha,
			fmt.Sprintf("Merge %s into %s", cmd.SourceRef, cmd.TargetRef))
		if err != nil {
			result.State, result.Phase, result.Conflicts = "CONFLICT", "MERGE", conflicts
			return result
		}
		tested = merged
	} else {
		report("REBASE", nil)
		onto := fork
		if cmd.SessionBaseSha != "" && isAncestor(scratch, cmd.SessionBaseSha, sourceSha) {
			onto = cmd.SessionBaseSha
		}
		rebased, conflicts, err := integrationRebase(scratch, base, onto, sourceSha)
		if err != nil {
			result.State, result.Phase, result.Conflicts = "CONFLICT", "REBASE", conflicts
			return result
		}
		tested = rebased
	}
	result.TestedSha = tested

	// ── J-S5 CHECK ────────────────────────────────────────────────────────────────────────────
	if len(cmd.Checks) > 0 {
		report("CHECK", nil)
		// The tree the checks are about to run in gets its own environment recipe first. A tree
		// that could not be prepared has measured nothing, so it stops the job instead of letting
		// the checks fail for a reason that is not the work's.
		if err := prepareIntegrationTree(scratch); err != nil {
			markUnprepared(&result, err)
			return result
		}
	}
	for _, spec := range cmd.Checks {
		outcome := runIntegrationCheck(scratch, spec)
		result.Checks = append(result.Checks, outcome)
		if outcome.ExitCode == nil || *outcome.ExitCode != spec.ExpectedExitCode {
			// Nothing is pushed. The branch a person is looking at is untouched, which is what the
			// item says (§4.2's `branchUnchanged`).
			result.State, result.Phase = "CHECK_FAILED", "CHECK"
			return result
		}
	}

	// ── J-S6a the tree that is about to land ──────────────────────────────────────────────────
	head, _ := git(scratch, "rev-parse", "HEAD")
	dirty, _ := git(scratch, "status", "--porcelain", "--untracked-files=no")
	if head != tested || strings.TrimSpace(dirty) != "" {
		// A check that committed or edited tracked files moved the thing being verified out from
		// under the verification. Refused rather than pushed: whatever would land here is not what
		// passed (§2.4 J-S6a).
		result.State, result.Phase = "ERROR", "PUSH"
		result.ErrorCode = "CHECK_MUTATED_TREE"
		result.ErrorDetail = map[string]any{"head": head, "expected": tested, "dirty": clip(dirty, 2000)}
		return result
	}
	treeSha, err := git(scratch, "rev-parse", tested+"^{tree}")
	if err != nil || treeSha == "" {
		result.State, result.Phase, result.ErrorCode = "ERROR", "PUSH", "CHECK_MUTATED_TREE"
		result.ErrorDetail = map[string]any{"detail": "could not read the tested tree: " + errText(err)}
		return result
	}
	result.TestedTreeSha = treeSha

	// ── J-S6 PUSH ─────────────────────────────────────────────────────────────────────────────
	report("PUSH", nil)
	// mergeLock, not only the per-target lock above: this is the same repository root's refs that
	// a session's own "merge to main" moves, and the two must not interleave.
	mergeLock.Lock()
	pushErr := integrationPush(repoRoot, scratch, remote, cmd.TargetRef, tested, targetSha, local)
	if pushErr == nil {
		advanceLocalRef(repoRoot, cmd.TargetRef, tested)
	}
	mergeLock.Unlock()
	if pushErr != nil {
		result.State, result.Phase = "ERROR", "PUSH"
		if isNonFastForward(gitStderr(pushErr)) {
			result.ErrorCode = "TARGET_MOVED"
		} else {
			result.ErrorCode = "PUSH_REJECTED"
		}
		result.ErrorDetail = map[string]any{"detail": clip(gitStderr(pushErr), 2000)}
		return result
	}

	// ── J-S7 VERIFY ───────────────────────────────────────────────────────────────────────────
	report("VERIFY", nil)
	if !local {
		if _, err := git(repoRoot, "fetch", remote, cmd.TargetRef); err != nil {
			result.State, result.Phase, result.ErrorCode = "ERROR", "VERIFY", "LANDED_TREE_MISMATCH"
			result.ErrorDetail = map[string]any{"detail": "could not read the target back: " + gitStderr(err)}
			return result
		}
	}
	landed, _ := integrationTip(repoRoot, remote, cmd.TargetRef, local)
	landedTree, _ := git(repoRoot, "rev-parse", landed+"^{tree}")
	if landed != tested || landedTree != treeSha {
		// The push reported success and the branch is not holding what was pushed. No receipt: a
		// receipt for this would be the control plane recording a landing that did not happen.
		result.State, result.Phase, result.ErrorCode = "ERROR", "VERIFY", "LANDED_TREE_MISMATCH"
		result.ErrorDetail = map[string]any{
			"expectedSha": tested, "actualSha": landed,
			"expectedTree": treeSha, "actualTree": landedTree,
		}
		return result
	}
	result.LandedSha = landed
	result.LandedTreeSha = landedTree
	if ahead, err := git(repoRoot, "rev-list", "--count", upstreamSha+".."+landed); err == nil {
		if n, convErr := strconv.Atoi(strings.TrimSpace(ahead)); convErr == nil {
			result.AheadOfUpstream = &n
		}
	}
	result.State, result.Phase = "LANDED", "VERIFY"
	return result
}

// promoteOnce is one pass at merging a project's finished work into its upstream
// (docs/project-integration-line-contract.md §3.4, steps M-S1 to M-S4).
//
// The shape is the same as integrateOnce's and the difference is the whole of §3: what lands is a
// MERGE COMMIT of the source into the upstream rather than the source replayed on top of it, so
// every commit the project branch accumulated stays an ancestor of main and the history a person
// reads afterwards is the history that was there (hard constraint 3, M6).
//
// Two jobs come through here. A CHECK_PROMOTION builds that merge, runs the project's merge check
// on it, and stops — it pushes nothing, and what it reports is the upstream tip and the tree the
// owner is being asked to approve. A LAND_PROMOTION does it again and pushes: with the upstream
// where the check left it, the merge must reproduce the same TREE (the commit's own SHA cannot be
// reproduced, and is not what was approved); with the upstream moved, the merge and the checks are
// redone on the new tip and the move is reported so a reader can see it happened (M5, M-T7).
//
// HOW THE SOURCE REACHES THE UPSTREAM IS THE ONE THING A MAIN LINE DOES DIFFERENTLY (M6, A-Q7). A
// project branch is merged, so the commits it accumulated stay ancestors of main as themselves. A
// MAIN line has no such branch: what is offered is one task's branch, and it arrives by being
// rebased onto the upstream tip and then fast-forwarded to — main gains a copy of the task's commit
// rather than a merge that carries it, which is what "the same commits on main, no merge" means to a
// person reading the log. Both are held to the same rule afterwards: what lands is the tree that
// passed the checks, or nothing lands.
func promoteOnce(cmd IntegrationJobCommand, repoRoot, scratch string, report integrationReporter) integrationResult {
	remote := cmd.RemoteName
	if remote == "" {
		remote = "origin"
	}
	local := cmd.RefAuthority == "RUNNER_LOCAL"
	landing := cmd.Kind == "LAND_PROMOTION"

	// ── M-S1 FETCH ────────────────────────────────────────────────────────────────────────────
	report("FETCH", nil)
	if !local {
		if _, err := git(repoRoot, "fetch", remote, cmd.UpstreamRef); err != nil {
			return errorResult("FETCH", "BASE_REF_NOT_FOUND", map[string]any{
				"ref": cmd.UpstreamRef, "detail": gitStderr(err),
			})
		}
		if _, err := git(repoRoot, "fetch", remote, cmd.SourceRef); err != nil {
			return errorResult("FETCH", "SOURCE_BRANCH_MISSING", map[string]any{
				"ref": cmd.SourceRef, "detail": gitStderr(err),
			})
		}
	}
	upstreamSha, err := integrationTip(repoRoot, remote, cmd.UpstreamRef, local)
	if err != nil || upstreamSha == "" {
		return errorResult("FETCH", "BASE_REF_NOT_FOUND", map[string]any{
			"ref": cmd.UpstreamRef, "detail": errText(err),
		})
	}
	// The commit the owner is being asked about, frozen when the candidate was made. Falling back
	// to the ref would merge whatever has landed on the branch since, which is not what was shown.
	sourceSha := strings.TrimSpace(cmd.SourceSha)
	if sourceSha == "" {
		sourceSha, err = integrationTip(repoRoot, remote, cmd.SourceRef, local)
	} else if _, probe := git(repoRoot, "rev-parse", "--verify", "--quiet", sourceSha+"^{commit}"); probe != nil {
		err = probe
		sourceSha = ""
	}
	if err != nil || sourceSha == "" {
		return errorResult("FETCH", "SOURCE_BRANCH_MISSING", map[string]any{
			"ref": cmd.SourceRef, "sha": cmd.SourceSha, "detail": errText(err),
		})
	}

	result := integrationResult{
		SourceSha: sourceSha, TargetShaBefore: upstreamSha, UpstreamSha: upstreamSha,
	}

	if _, err := git(repoRoot, "worktree", "add", "--detach", scratch, upstreamSha); err != nil {
		return errorResult("FETCH", "FETCH_FAILED", map[string]any{
			"detail": "could not stage a promotion worktree: " + gitStderr(err),
		})
	}

	// Already on the upstream: nothing to merge, and a merge commit for it would be a commit that
	// carries no change at all.
	if isAncestor(scratch, sourceSha, upstreamSha) {
		result.State, result.Phase = "ALREADY_LANDED", "MERGE"
		return result
	}

	// M-T12: an automatic landing — the project's Automatic setting confirmed it, nobody pressed
	// Merge — is authorized for one combination: this source onto the upstream tip its check ran
	// against. With the upstream anywhere else there is nothing it may land, and it does not do what
	// a landing the owner confirmed does (M5), re-check the new tip and merge it: it merges nothing,
	// reports READY, and the owner is asked. A landing that names no checked tip has nothing to be
	// held to, and lands nothing either.
	if landing && cmd.Automatic && (cmd.UpstreamShaChecked == "" || cmd.UpstreamShaChecked != upstreamSha) {
		result.State, result.Phase = "READY", "MERGE"
		return result
	}

	// ── M-S2 MERGE, or REBASE for a task branch ───────────────────────────────────────────────
	moved := landing && cmd.UpstreamShaChecked != "" && cmd.UpstreamShaChecked != upstreamSha
	taskBranch := cmd.PromotionSourceKind == "TASK_BRANCH"
	if moved {
		report("MERGE", &IntegrationUpstreamMoved{
			From:    cmd.UpstreamShaChecked,
			To:      upstreamSha,
			Commits: countCommits(repoRoot, cmd.UpstreamShaChecked, upstreamSha),
		})
	} else if taskBranch {
		report("REBASE", nil)
	} else {
		report("MERGE", nil)
	}
	var tested string
	if taskBranch {
		// The task's own branch replayed onto the upstream tip, anchored the way every other rebase
		// in this file is: at the session's recorded base when that is still an ancestor of the
		// source, and at the fork point otherwise (J-S4).
		onto, _ := git(scratch, "merge-base", sourceSha, upstreamSha)
		if cmd.SessionBaseSha != "" && isAncestor(scratch, cmd.SessionBaseSha, sourceSha) {
			onto = cmd.SessionBaseSha
		}
		rebased, conflicts, rebaseErr := integrationRebase(scratch, upstreamSha, onto, sourceSha)
		if rebaseErr != nil {
			result.State, result.Phase, result.Conflicts = "CONFLICT", "REBASE", conflicts
			return result
		}
		tested = rebased
	} else {
		merged, conflicts, mergeErr := integrationMerge(scratch, sourceSha,
			fmt.Sprintf("Merge %s into %s", cmd.SourceRef, cmd.UpstreamRef))
		if mergeErr != nil {
			result.State, result.Phase, result.Conflicts = "CONFLICT", "MERGE", conflicts
			return result
		}
		tested = merged
	}
	result.TestedSha = tested
	treeSha, err := git(scratch, "rev-parse", tested+"^{tree}")
	if err != nil || treeSha == "" {
		result.State, result.Phase, result.ErrorCode = "ERROR", "MERGE", "CHECK_MUTATED_TREE"
		result.ErrorDetail = map[string]any{"detail": "could not read the combined tree: " + errText(err)}
		return result
	}
	result.TestedTreeSha = treeSha
	if ahead, err := git(scratch, "rev-list", "--count", upstreamSha+".."+sourceSha); err == nil {
		if n, convErr := strconv.Atoi(strings.TrimSpace(ahead)); convErr == nil {
			result.AheadOfUpstream = &n
		}
	}
	if files, err := git(scratch, "diff", "--name-only", upstreamSha, tested); err == nil {
		n := len(strings.Fields(files))
		result.FilesChanged = &n
	}

	// ── M-S3 CHECK ────────────────────────────────────────────────────────────────────────────
	// The upstream is where the approved check left it, so the merge has to come out the same. It
	// will not be the same COMMIT — a merge commit carries the moment it was made — and the tree is
	// what was approved, so the tree is what is compared.
	if landing && !moved && cmd.MergeTreeSha != "" && cmd.MergeTreeSha != treeSha {
		result.State, result.Phase, result.ErrorCode = "ERROR", "MERGE", "PROMOTION_TREE_NONDETERMINISTIC"
		result.ErrorDetail = map[string]any{"expectedTree": cmd.MergeTreeSha, "actualTree": treeSha}
		return result
	}
	// Checked here on every check job, and on a landing only when the upstream moved: an unmoved
	// upstream reproduced the tree that already passed, and running the same commands on the same
	// tree again is an hour spent to learn nothing (M5).
	if !landing || moved {
		if len(cmd.Checks) > 0 {
			report("CHECK", nil)
			// M-S3's checks run on the same kind of tree J-S5's do, and need the same recipe: a
			// promotion of a TASK_BRANCH runs the task's own acceptance command (M-F2).
			if err := prepareIntegrationTree(scratch); err != nil {
				markUnprepared(&result, err)
				return result
			}
		}
		for _, spec := range cmd.Checks {
			outcome := runIntegrationCheck(scratch, spec)
			result.Checks = append(result.Checks, outcome)
			if outcome.ExitCode == nil || *outcome.ExitCode != spec.ExpectedExitCode {
				result.State, result.Phase = "CHECK_FAILED", "CHECK"
				return result
			}
		}
	}

	if !landing {
		// M-S4 for a check: nothing is pushed, and what comes back is what the owner is asked about.
		result.State, result.Phase = "READY", "CHECK"
		return result
	}

	// ── M-S4 the tree that is about to land, then the push ────────────────────────────────────
	head, _ := git(scratch, "rev-parse", "HEAD")
	dirty, _ := git(scratch, "status", "--porcelain", "--untracked-files=no")
	if head != tested || strings.TrimSpace(dirty) != "" {
		result.State, result.Phase = "ERROR", "PUSH"
		result.ErrorCode = "CHECK_MUTATED_TREE"
		result.ErrorDetail = map[string]any{"head": head, "expected": tested, "dirty": clip(dirty, 2000)}
		return result
	}
	report("PUSH", nil)
	mergeLock.Lock()
	// The same push for both kinds, and it is a fast-forward either way: a merge commit and a rebased
	// commit both carry the upstream tip as an ancestor. What differs is the commit being pushed, not
	// the way it travels — and no force, so an upstream that moved underneath is refused (J-S6).
	pushErr := integrationPush(repoRoot, scratch, remote, cmd.UpstreamRef, tested, upstreamSha, local)
	if pushErr == nil {
		advanceLocalRef(repoRoot, cmd.UpstreamRef, tested)
	}
	mergeLock.Unlock()
	if pushErr != nil {
		result.State, result.Phase = "ERROR", "PUSH"
		if isNonFastForward(gitStderr(pushErr)) {
			result.ErrorCode = "TARGET_MOVED"
		} else {
			result.ErrorCode = "PUSH_REJECTED"
		}
		result.ErrorDetail = map[string]any{"detail": clip(gitStderr(pushErr), 2000)}
		return result
	}

	// ── VERIFY ────────────────────────────────────────────────────────────────────────────────
	report("VERIFY", nil)
	if !local {
		if _, err := git(repoRoot, "fetch", remote, cmd.UpstreamRef); err != nil {
			result.State, result.Phase, result.ErrorCode = "ERROR", "VERIFY", "LANDED_TREE_MISMATCH"
			result.ErrorDetail = map[string]any{"detail": "could not read the upstream back: " + gitStderr(err)}
			return result
		}
	}
	landed, _ := integrationTip(repoRoot, remote, cmd.UpstreamRef, local)
	landedTree, _ := git(repoRoot, "rev-parse", landed+"^{tree}")
	if landed != tested || landedTree != treeSha {
		result.State, result.Phase, result.ErrorCode = "ERROR", "VERIFY", "LANDED_TREE_MISMATCH"
		result.ErrorDetail = map[string]any{
			"expectedSha": tested, "actualSha": landed,
			"expectedTree": treeSha, "actualTree": landedTree,
		}
		return result
	}
	result.LandedSha = landed
	result.LandedTreeSha = landedTree
	result.State, result.Phase = "LANDED", "VERIFY"
	return result
}

// integrationMerge merges `what` into the scratch worktree's HEAD with a merge commit, and answers
// the conflicting paths when git refuses. A refusal is always cleaned up: the worktree is removed
// after the job either way, but an aborted merge is what makes the paths readable.
func integrationMerge(scratch, what, message string) (string, []string, error) {
	if _, err := git(scratch, "merge", "--no-ff", "-m", message, what); err != nil {
		conflicts := conflictPaths(scratch)
		_, _ = git(scratch, "merge", "--abort")
		return "", conflicts, err
	}
	head, err := git(scratch, "rev-parse", "HEAD")
	return head, nil, err
}

// integrationRebase replays `source` from `onto` on top of `base`, leaving the worktree at the
// result. The rebase runs in the scratch worktree and touches no branch: what it produces is a
// detached HEAD, which is exactly what the push then names.
func integrationRebase(scratch, base, onto, source string) (string, []string, error) {
	if _, err := git(scratch, "checkout", "--detach", source); err != nil {
		return "", nil, err
	}
	if _, err := git(scratch, "rebase", "--onto", base, onto); err != nil {
		conflicts := conflictPaths(scratch)
		_, _ = git(scratch, "rebase", "--abort")
		return "", conflicts, err
	}
	head, err := git(scratch, "rev-parse", "HEAD")
	return head, nil, err
}

// conflictPaths is what git refused on, in the spelling a person reads in an exception item.
func conflictPaths(dir string) []string {
	out, err := git(dir, "diff", "--name-only", "--diff-filter=U")
	if err != nil {
		return nil
	}
	var paths []string
	for _, line := range strings.Split(out, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			paths = append(paths, trimmed)
		}
	}
	if len(paths) > 200 {
		paths = paths[:200]
	}
	return paths
}

// integrationPush moves the target ref to `tested`, and only forwards: no --force, and the local
// authority spelling passes the expected old value so the update is refused if it moved.
func integrationPush(repoRoot, scratch, remote, targetRef, tested, expectedBefore string, local bool) error {
	if local {
		_, err := git(repoRoot, "update-ref", targetRef, tested, expectedBefore)
		return err
	}
	_, err := git(scratch, "push", remote, tested+":"+targetRef)
	return err
}

// advanceLocalRef moves this checkout's own copy of the target forward, the way rebaseFastForward
// does: fast-forward in place when the checkout is sitting on that branch, and a plain ref move
// otherwise. Best effort — the landing is what the remote holds, and a stale local branch is a
// nuisance, not a failure of the job.
func advanceLocalRef(repoRoot, targetRef, tested string) {
	branch := strings.TrimPrefix(targetRef, "refs/heads/")
	current, _ := git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD")
	if current == branch {
		_, _ = git(repoRoot, "merge", "--ff-only", tested)
		return
	}
	_, _ = git(repoRoot, "branch", "-f", branch, tested)
}

// The repository's own environment recipe, run in the combination tree before any check (J-S5,
// M-S3). The path is the recipe's, not this file's invention: it is the script a session worktree
// runs to make a bare checkout buildable and testable, and the checks belong in the tree it makes.
const integrationPrepareScript = "scripts/worktree-overlay.sh"

// How long the recipe may take. It is a build step — linking node_modules, compiling the shared
// package — so it is budgeted like one, and a tree that cannot be prepared in ten minutes is a
// machine problem the job reports rather than waits on.
const integrationPrepareTimeout = 10 * time.Minute

// prepareIntegrationTree runs the combination tree's own environment recipe, when it has one.
//
// THE RED THIS EXISTS TO PREVENT
// ==============================
// The scratch worktree comes out of git, and git does not carry `node_modules`. So the result of a
// check used to come down to the SHAPE of the command: `bash scripts/run-pg-spec.sh …` lays its own
// environment down and landed, while `cd src/web && npx vitest run …` — a command that is perfectly
// good in the session worktree it was written and run in — died in the combination tree with
// `Cannot find package '@vitejs/plugin-react'`. Work that is right, refused by the line, as a
// failed check. The command is the task author's to write for the tree they work in; making the
// combination tree one of those trees is the platform's job, and it is one place, not one rule per
// author to remember.
//
// WHAT IT DOES NOT MOVE
// =====================
// "the tree that lands is the tree that was tested" is a claim about the COMMIT: J-S6a reads
// `C^{tree}` and refuses a check that touched a tracked file. The recipe writes gitignored paths
// only (`node_modules/`, `dist/`), which no tree hash covers and which J-S6a's other half —
// `git status --porcelain --untracked-files=no` — does not report. So the tree that is pushed is
// still the tree git produced, and the checks ran in it rather than in a copy of it.
//
// A repository without the recipe is not prepared and not refused: the checks run in exactly the
// tree git produced, which is what every case before this one measured.
func prepareIntegrationTree(scratch string) error {
	script := filepath.Join(scratch, filepath.FromSlash(integrationPrepareScript))
	if info, err := os.Stat(script); err != nil || info.IsDir() {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), integrationPrepareTimeout)
	defer cancel()
	started := time.Now()
	// The same shell the checks get (`bash -lc`, runner environment): what the recipe lays down has
	// to be what those commands resolve against, PATH and all.
	cmd := exec.CommandContext(ctx, "bash", "-lc", "bash "+integrationPrepareScript)
	cmd.Dir = scratch
	cmd.WaitDelay = 5 * time.Second
	output, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return fmt.Errorf("%s did not finish within %s: %s",
			integrationPrepareScript, integrationPrepareTimeout, tailOf(string(output), 2000))
	}
	if err != nil {
		return fmt.Errorf("%s failed (%v): %s", integrationPrepareScript, err, tailOf(string(output), 2000))
	}
	logln("integration: prepared", scratch, "with", integrationPrepareScript,
		fmt.Sprintf("in %dms", time.Since(started).Milliseconds()))
	return nil
}

// markUnprepared is the job's answer when the tree's recipe could not be run. It is an ERROR and
// not a CHECK_FAILED on purpose: the checks never got a tree they could be judged in, so nothing
// here is a verdict about the work — and a verdict that says "your command failed" about an
// environment that was never laid down is the same false red one layer down.
func markUnprepared(result *integrationResult, err error) {
	result.State, result.Phase = "ERROR", "CHECK"
	result.ErrorCode = "CHECK_TREE_UNPREPARED"
	result.ErrorDetail = map[string]any{
		"command": integrationPrepareScript,
		"detail":  clip(err.Error(), 2000),
	}
}

// runIntegrationCheck runs one command in the scratch worktree under its own budget.
//
// `bash -lc` and the runner's own environment, deliberately: this is the platform's check, not the
// agent's turn, and it must not inherit a session's credentials or its provider configuration.
func runIntegrationCheck(scratch string, spec IntegrationCheckSpec) IntegrationCheckResult {
	budget := time.Duration(spec.TimeoutSeconds) * time.Second
	if spec.TimeoutSeconds <= 0 {
		budget = time.Hour
	}
	ctx, cancel := context.WithTimeout(context.Background(), budget)
	defer cancel()
	started := time.Now()
	cmd := exec.CommandContext(ctx, "bash", "-lc", spec.Command)
	cmd.Dir = scratch
	cmd.WaitDelay = 5 * time.Second
	output, runErr := cmd.CombinedOutput()
	result := IntegrationCheckResult{
		Name:             spec.Name,
		Command:          spec.Command,
		ExpectedExitCode: spec.ExpectedExitCode,
		DurationMs:       time.Since(started).Milliseconds(),
		OutputTail:       tailOf(string(output), integrationOutputTail),
	}
	if ctx.Err() != nil {
		result.TimedOut = true
		return result
	}
	var exitErr *exec.ExitError
	switch {
	case runErr == nil:
		zero := 0
		result.ExitCode = &zero
	case errors.As(runErr, &exitErr):
		code := exitErr.ExitCode()
		// -1 is "killed by a signal, no exit code" — reported as no code rather than as a number
		// the comparison could accidentally match.
		if code >= 0 {
			result.ExitCode = &code
		}
	default:
		// Could not start at all (no bash, no such directory). No exit code, and the output tail
		// carries the reason.
		result.OutputTail = tailOf(result.OutputTail+"\n"+runErr.Error(), integrationOutputTail)
	}
	return result
}

// removeIntegrationWorktree takes the scratch worktree out of the repository's administrative list
// and off disk. Called on entry as well as exit: a process killed mid-job leaves one behind, and
// the next attempt must not trip over it.
func removeIntegrationWorktree(repoRoot, scratch string) {
	if scratch == "" {
		return
	}
	_, _ = git(repoRoot, "worktree", "remove", "--force", scratch)
	_ = os.RemoveAll(scratch)
	_, _ = git(repoRoot, "worktree", "prune")
}

// integrationTip resolves a ref to a commit: the remote-tracking copy when the remote is the
// authority, the local ref when this machine is.
func integrationTip(repoRoot, remote, ref string, local bool) (string, error) {
	if local {
		return git(repoRoot, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
	}
	branch := strings.TrimPrefix(ref, "refs/heads/")
	return git(repoRoot, "rev-parse", "--verify", "--quiet",
		"refs/remotes/"+remote+"/"+branch+"^{commit}")
}

func isAncestor(dir, ancestor, descendant string) bool {
	if ancestor == "" || descendant == "" {
		return false
	}
	err := exec.Command("git", "-C", dir, "merge-base", "--is-ancestor", ancestor, descendant).Run()
	return err == nil
}

// countCommits is how many commits the upstream gained between two tips: the number the owner reads
// as "main moved 1 commit since the check" (M-T7). Zero when git cannot answer — an object this
// machine does not have is not a claim that nothing moved, and the report leaves the count out.
func countCommits(dir, from, to string) int {
	if from == "" || to == "" {
		return 0
	}
	out, err := git(dir, "rev-list", "--count", from+".."+to)
	if err != nil {
		return 0
	}
	n, convErr := strconv.Atoi(strings.TrimSpace(out))
	if convErr != nil {
		return 0
	}
	return n
}

func errorResult(phase, code string, detail map[string]any) integrationResult {
	return integrationResult{State: "ERROR", Phase: phase, ErrorCode: code, ErrorDetail: detail}
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	if detail := gitStderr(err); detail != "" {
		return clip(detail, 1000)
	}
	return err.Error()
}

// tailOf keeps the LAST n bytes: the end of a failing command's output is where the reason is.
func tailOf(s string, n int) string {
	s = strings.ReplaceAll(s, "\x00", "")
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

// runIntegrationJobAndReport does one job and tells the control plane what it came to.
//
// The report is the only thing that matters here, so it is retried: a job that did the work and
// could not say so would be re-claimed after its lease expired and would do the whole thing again,
// including an hour of checks. A 4xx is NOT retried — that is the control plane saying this
// process's claim moved on, and the right answer to that is to stop.
func runIntegrationJobAndReport(t *Transport, job IntegrationJobCommand) {
	logln("integration job", job.JobID, job.Kind, job.SourceRef, "->", job.TargetRef)
	result := runIntegrationJob(job, func(phase string, moved *IntegrationUpstreamMoved) {
		// Best effort: the lease renewal matters, the phase is for a reader, and the work carries
		// on either way. The one report that is more than a phase is `upstreamMoved` — the control
		// plane moves the promotion to RECHECKING on it (§3.3 M-T7) — and it is best effort too:
		// the result that follows carries the upstream this job actually merged onto regardless.
		_ = t.integrationJobProgress(job.JobID, IntegrationJobProgressRequest{
			ClaimGeneration: job.ClaimGeneration,
			LeaseOwner:      job.LeaseOwner,
			Phase:           phase,
			UpstreamMoved:   moved,
		})
	})
	body := IntegrationJobResultRequest{
		ClaimGeneration: job.ClaimGeneration,
		LeaseOwner:      job.LeaseOwner,
		State:           result.State,
		Phase:           result.Phase,
		SourceSha:       result.SourceSha,
		TargetShaBefore: result.TargetShaBefore,
		UpstreamSha:     result.UpstreamSha,
		MainSyncSha:     result.MainSyncSha,
		TestedSha:       result.TestedSha,
		TestedTreeSha:   result.TestedTreeSha,
		LandedSha:       result.LandedSha,
		LandedTreeSha:   result.LandedTreeSha,
		AheadOfUpstream: result.AheadOfUpstream,
		FilesChanged:    result.FilesChanged,
		Checks:          result.Checks,
		Conflicts:       result.Conflicts,
		ErrorCode:       result.ErrorCode,
		ErrorDetail:     result.ErrorDetail,
	}
	for attempt := 0; attempt < 5; attempt++ {
		answer, err := t.integrationJobResult(job.JobID, body)
		if err == nil {
			logln("integration job", job.JobID, "reported", result.State,
				fmt.Sprintf("accepted=%v receipts=%d", answer.Accepted, len(answer.ReceiptIDs)))
			return
		}
		var httpErr *transportHTTPError
		if errors.As(err, &httpErr) && httpErr.statusCode >= 400 && httpErr.statusCode < 500 {
			logln("integration job", job.JobID, "result refused:", err)
			return
		}
		logln("integration job", job.JobID, "result not delivered, retrying:", err)
		time.Sleep(time.Duration(attempt+1) * 2 * time.Second)
	}
}
