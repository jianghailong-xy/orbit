package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
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

// The capability that says this runner speaks the periodic progress protocol
// (docs/project-integration-line-contract.md §2.2 J-T4): a report inside every 30 seconds while it
// works, a synchronous phase = PUSH report before it pushes, and a stop request read off every
// answer. A claim made by a runner that declared it records progress_protocol = v2; every other
// claim is legacy and keeps the old shape. Its apiserver twin is INTEGRATION_PROGRESS_V2 in
// src/apiserver/src/projects/project-integration-job.ts.
const integrationProgressV2Capability = "integration-progress/v2"

// The capability that says this runner honours an automatic landing's one extra rule (§3.3 M-T12):
// land only onto the upstream tip the check ran against, and hand the candidate back untouched when
// the upstream has moved, rather than checking the new tip and merging it as an owner-confirmed
// landing does (M5). The control plane confirms nothing by itself for a runner that has not said
// this, and never hands such a runner an automatic landing. Its apiserver twin is
// PROMOTION_AUTOMATIC_LAND in src/apiserver/src/projects/project-integration-job.ts.
const promotionAutomaticLandCapabilityV1 = "promotion-automatic-land/v1"

// Where a throwaway integration worktree lives: directly under the runner's worktrees directory,
// among the session checkouts and the rebase scratch trees, so one place holds everything this
// runner stages and one sweep can find what a killed process left behind. The prefix is what the
// worktree garbage collector keys on to leave these alone: every directory there that is not a
// session id is answered removable by the control plane, so gcWorktrees must exclude this prefix
// (worktree.go) or it would delete the tree of a job that is still running. Leftovers are removed
// by sweepIntegrationScratch instead, which knows which jobs are in flight.
const integrateScratchPrefix = "_integrate-"

// How many times a LAND_TASK goes back to FETCH when the push is refused because somebody else
// advanced the target first (§2.5 J5, appendix A-Q5). Two, and then the job stops: a queue that
// retries a race forever is a queue that never reports anything.
const integrationRefetchRounds = 2

// A LAND_PROMOTION does not go back at all (J-T13, owner decision 2026-10-19). The first refused
// push ends this claim: an automatic landing hands the candidate back to be checked again on the new
// main (M-T12), and an owner-confirmed one is re-queued as the next generation under the same
// confirmation by the control plane. Whether a second attempt exists at all, and whether this is the
// third that turns the candidate BLOCKED, is the control plane's count to keep — it is the party
// holding the confirmation — so the runner reports the move and stops rather than deciding it.
const promotionRefetchRounds = 0

// How many times one fetch is tried again when git refused to take a ref's lock because another
// process was updating the same ref at that moment, and how long the wait before each further try
// is (it doubles). Three attempts inside under a second: long enough for the fetch that beat this
// one to be over, short enough that a repository genuinely wedged on a stale `.lock` is reported
// rather than waited on.
const (
	integrationFetchLockAttempts = 3
	integrationFetchLockWait     = 200 * time.Millisecond
)

// integrationFetchLockPause is the wait between two attempts at a ref another process was holding.
// A variable only so a test can take that other process's lock away at the moment the first attempt
// has failed, which is a moment nothing outside this function can observe.
var integrationFetchLockPause = func(d time.Duration) { time.Sleep(d) }

// The most check output a result carries, per §2.1. The control plane clips it again; this keeps a
// runaway command from putting a gigabyte on the wire in the first place.
const integrationOutputTail = 16 * 1024

// integrationLocks serialises jobs on this machine by repository root and target ref. The database
// serialises them across machines (J1's partial unique index over RUNNING rows); this is the local
// half, and it is what keeps two goroutines of THIS process from staging two worktrees onto one
// checkout's refs at once.
var integrationLocks sync.Map

func integrationLock(repoRoot, targetRef string) *integrationLocalLock {
	actual, _ := integrationLocks.LoadOrStore(repoRoot+"\x00"+targetRef, &integrationLocalLock{token: make(chan struct{}, 1)})
	return actual.(*integrationLocalLock)
}

// integrationLocalLock is a mutex a waiting job can give up on. A v2 claim reports step =
// WAITING_LOCAL_LOCK while it waits and must stop within 30 seconds of a cancellation (§2.2 J-T4),
// which a sync.Mutex cannot do: its Lock has no door for the context.
//
// One token in a one-slot channel: sending takes the lock, receiving frees it.
type integrationLocalLock struct {
	token chan struct{}
}

func (l *integrationLocalLock) Lock() {
	l.token <- struct{}{}
}

// LockContext takes the lock, or answers false when ctx ended first: a cancelled claim stops the
// job here rather than waiting for the job ahead of it.
func (l *integrationLocalLock) LockContext(ctx context.Context) bool {
	select {
	case l.token <- struct{}{}:
		return true
	case <-ctx.Done():
		return false
	}
}

func (l *integrationLocalLock) Unlock() {
	<-l.token
}

// TryLock answers whether the lock is free right now, without waiting.
func (l *integrationLocalLock) TryLock() bool {
	select {
	case l.token <- struct{}{}:
		return true
	default:
		return false
	}
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
	// SourceOnUpstream is set with NOTHING_TO_LAND, and only there: whether the source tip is an
	// ancestor of the upstream tip this job fetched (migration 0346). It is the one fact the control
	// plane lets such an answer out of a criterion's landing on — see J-S3 below.
	SourceOnUpstream *bool
	// SourceFullyApplied is set with NOTHING_TO_LAND too, and only there: true when the branch carried
	// commits of its own and the base already had every one of them, false when it carried none
	// (migration 0410). The two answers both push nothing, and the control plane has to be able to
	// tell them apart — see J-S4 below.
	SourceFullyApplied *bool
	FilesChanged       *int
	Checks             []IntegrationCheckResult
	Conflicts          []string
	ErrorCode          string
	ErrorDetail        map[string]any
	// UpstreamMovedCommits is set when a LAND_PROMOTION ended because the upstream moved under it
	// (J-T13, M-T12): the commits the upstream gained, first-parent and newest first.
	UpstreamMovedCommits *IntegrationUpstreamMovedCommits
	// UnknownPushes is what the fetch found about the earlier unknown pushes the command named (J12):
	// only the entries git could answer for.
	UnknownPushes []IntegrationUnknownPushCheck
	// Interrupted is a job this runner stopped because the runner itself is stopping
	// (runIntegrationJobUntil): it pushed nothing, so it is handed back rather than answered, and
	// Phase says where it was. Never part of a report.
	Interrupted bool
	// Stopped is a job whose claim the control plane no longer has: a progress report was refused
	// 409 STALE_CLAIM, 409 ALREADY_FINAL or 404 (§2.2 J-T4). The job kills what it is running and
	// reports nothing — there is no claim left to answer — and is not handed back either.
	Stopped bool
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
	return runIntegrationJobUntil(context.Background(), cmd, report)
}

// runIntegrationJobUntil is runIntegrationJob for a runner that may have to stop before the job is
// done (runloop.go's shutdown). When stop ends, the job stops at the first step that would otherwise
// keep it: a round not yet begun is not begun, and the tree's recipe or a check still running is ended
// with its whole process tree. The job then answers Interrupted, and its scratch worktree goes as on
// every other exit. Git steps are not cut short, and a job whose checks have passed goes on to its
// push and its verification: those take seconds, and finishing them is cheaper than doing it all again.
func runIntegrationJobUntil(stop context.Context, cmd IntegrationJobCommand, report integrationReporter) integrationResult {
	return runIntegrationJobUntilWithProgress(stop, cmd, report, nil)
}

// integrationProgressSender is one report to the control plane: the transport's POST, or a test's
// stand-in. It takes a context because a report being sent when the job ends is abandoned rather
// than waited on.
type integrationProgressSender func(ctx context.Context, req IntegrationJobProgressRequest) (*IntegrationJobProgressResponse, error)

// runIntegrationJobUntilWithProgress is runIntegrationJobUntil with the v2 progress protocol
// (§2.2 J-T4). sender is nil for a legacy claim and for every caller that is not the runloop; a job
// carrying reportBeforePush then reports every 25 seconds while it waits for the local lock, runs
// the tree's recipe and runs its checks, reads a stop request off every answer, and asks
// synchronously before it pushes.
//
// The job's own context is a CHILD of stop with a cause (context.WithCancelCause), because the two
// ways a job ends early are not the same fact: the runner stopping hands the claim back to be run
// again (J-T11), while a cancellation the control plane asked for is answered CANCELLED (J-T12).
func runIntegrationJobUntilWithProgress(stop context.Context, cmd IntegrationJobCommand, report integrationReporter, sender integrationProgressSender) integrationResult {
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
	jobCtx, cancelJob := context.WithCancelCause(stop)
	defer cancelJob(nil)
	var progress *integrationProgress
	if cmd.ReportBeforePush && sender != nil {
		progress = newIntegrationProgress(jobCtx, cancelJob, cmd, sender)
		defer progress.close()
	}
	// The local lock is what a second job of this process waits on; v2 says so while it waits.
	lock := integrationLock(repoRoot, cmd.TargetRef)
	if progress != nil {
		progress.beginStep("FETCH", "WAITING_LOCAL_LOCK", nil, nil)
	}
	if !lock.LockContext(jobCtx) {
		return integrationStoppedResult(jobCtx, "FETCH")
	}
	defer lock.Unlock()

	scratch := integrationScratchPath(cmd)
	if err := os.MkdirAll(filepath.Dir(scratch), 0o755); err != nil {
		return errorResult("FETCH", "FETCH_FAILED", map[string]any{
			"detail": fmt.Sprintf("cannot create the scratch root %s: %v", filepath.Dir(scratch), err),
		})
	}
	// Before the move, a job's scratch worktree was staged beside its workspace
	// (filepath.Dir(workDir), often the user's home), where the worktree GC never looked. A
	// process of that build killed mid-job leaves one there, and the new path would never trip
	// over it, so this job clears its own legacy copy before staging its new one.
	if legacy := legacyIntegrationScratchPath(workDir, cmd.JobID); legacy != scratch {
		removeIntegrationWorktree(repoRoot, legacy)
	}
	defer removeIntegrationWorktree(repoRoot, scratch)

	one := integrateOnce
	if cmd.Kind == "CHECK_PROMOTION" || cmd.Kind == "LAND_PROMOTION" {
		// A promotion merges the whole project branch into the upstream instead of replaying one
		// task onto the line (§3.4). Same loop around it, and for the same reason: the one failure
		// worth trying again inside a single job is losing a race for the ref it is writing.
		one = promoteOnce
	}
	reached := report
	if progress != nil {
		reached = progress.phaseReached
	}
	rounds := integrationRefetchRounds
	if cmd.Kind == "LAND_PROMOTION" {
		rounds = promotionRefetchRounds
	}
	var last integrationResult
	for round := 0; round <= rounds; round++ {
		if jobCtx.Err() != nil {
			return integrationStoppedResult(jobCtx, "FETCH")
		}
		if progress != nil {
			progress.setRound(round + 1)
		}
		removeIntegrationWorktree(repoRoot, scratch)
		last = one(jobCtx, cmd, repoRoot, scratch, reached, progress)
		// The one thing worth doing again inside a single job: the target moved between the check
		// and the push, so the tree that was tested is no longer the tree that would land. Re-read
		// the refs and re-run the checks on the new combination (§2.5 J5). A LAND_TASK only: a
		// promotion ends its claim on the first refusal (J-T13).
		if last.State == "ERROR" && last.ErrorCode == "TARGET_MOVED" && round < rounds {
			continue
		}
		return last
	}
	return last
}

// integrateOnce is one pass over the steps: fetch, absorb upstream, rebase or merge, check, push,
// verify. Split out so a lost push race can repeat the whole of it against fresh tips rather than
// patching up half-finished state.
func integrateOnce(stop context.Context, cmd IntegrationJobCommand, repoRoot, scratch string, report integrationReporter, progress *integrationProgress) integrationResult {
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
		if err := integrationFetch(repoRoot, remote, cmd.UpstreamRef); err != nil {
			return fetchRefFailure("FETCH", cmd.UpstreamRef, err, "BASE_REF_NOT_FOUND")
		}
		// A failure here is not an error — a first landing creates the branch — unless it is a ref
		// another process was holding: this fetch is what brings the tip the job is about to work
		// from, and reading it out of a ref nobody just updated is a guess about the remote.
		if err := integrationFetch(repoRoot, remote, cmd.TargetRef); err != nil && isRefLockConflict(err) {
			return fetchRefFailure("FETCH", cmd.TargetRef, err, "FETCH_FAILED")
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
	// J12's receipt repair: earlier landings on this serial key whose push outcome the control plane
	// could not know, checked against the target this fetch just read.
	result.UnknownPushes = checkUnknownPushes(repoRoot, targetSha, cmd.UnknownPushes)

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
	// What J-S3 measures "already contained" against. Normally the same as `base` — the target
	// after J-S2's own absorb — but not when the absorb went onto the SOURCE (below): there the
	// target still is what it was, and a base that already contains the source would answer
	// ALREADY_LANDED for work nobody has pushed anywhere.
	containedIn := targetSha
	absorbedBySource := false
	if cmd.TargetRef != cmd.UpstreamRef && !isAncestor(scratch, upstreamSha, targetSha) {
		if sourceCarriesTheAbsorb(scratch, sourceSha, targetSha, upstreamSha) {
			// The source has already made this merge, with whatever resolution it took (§3.1 M3).
			// Making it again on the target's tip asks git for that resolution a second time, and
			// conflicts where the source already answered — so nothing is merged here, and J-S4
			// lands the source as it is.
			absorbedBySource = true
		} else if sourceCarriesAnEarlierAbsorb(scratch, sourceSha, targetSha, upstreamSha) {
			// The source absorbed an upstream that has moved on since, and carries the resolution
			// the target does not have (the sync-task door, and the absorb of a reworked task).
			// Absorbing the current upstream on the TARGET's tip would meet the conflicts the
			// source already resolved and stop at MAIN_SYNC again, so the absorb goes onto the
			// SOURCE instead — the branch that holds the resolution. A clean absorb is landed by
			// J-S4's MERGE below; a conflict here is U′..U touching the very place the resolution
			// did, and is reported as the MAIN_SYNC conflict it is.
			report("MAIN_SYNC", nil)
			if _, err := git(scratch, "checkout", "--detach", sourceSha); err != nil {
				result.State, result.Phase, result.ErrorCode = "ERROR", "MAIN_SYNC", "SOURCE_BRANCH_MISSING"
				result.ErrorDetail = map[string]any{"ref": cmd.SourceRef, "detail": errText(err)}
				return result
			}
			merged, conflicts, err := integrationMerge(scratch, upstreamSha,
				fmt.Sprintf("Merge %s into %s", cmd.UpstreamRef, cmd.SourceRef))
			if err != nil {
				result.State, result.Phase, result.Conflicts = "CONFLICT", "MAIN_SYNC", conflicts
				return result
			}
			result.MainSyncSha = merged
			base = merged
			absorbedBySource = true
		} else {
			report("MAIN_SYNC", nil)
			merged, conflicts, err := integrationMerge(scratch, upstreamSha,
				fmt.Sprintf("Merge %s into %s", cmd.UpstreamRef, cmd.TargetRef))
			if err != nil {
				result.State, result.Phase, result.Conflicts = "CONFLICT", "MAIN_SYNC", conflicts
				return result
			}
			result.MainSyncSha = merged
			base = merged
			containedIn = merged
		}
	}

	// ── J-S3 already contained ────────────────────────────────────────────────────────────────
	if isAncestor(scratch, sourceSha, containedIn) {
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
			// And where that empty tip IS, measured rather than inferred. "Contained in the base"
			// says the tip is inside the TARGET, which on a project branch ahead of main is not
			// main: a branch forked from the line holds nothing of its own and is still not on the
			// upstream. The control plane lets this answer out of a criterion's landing only when
			// the tip is an ancestor of the upstream tip fetched above (2026-10-01: a rollout task
			// with no commit, on a line ahead of main, held its criterion off LANDED for ever).
			onUpstream := isAncestor(scratch, sourceSha, upstreamSha)
			result.SourceOnUpstream = &onUpstream
			// The branch carried no commit of its own, so none of it was applied anywhere (J-S4).
			fullyApplied := false
			result.SourceFullyApplied = &fullyApplied
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
	if absorbedBySource || strings.TrimSpace(merges) != "" {
		// A source that contains merge commits carries somebody's conflict resolutions inside
		// them. A rebase would replay the sides and ask for those resolutions again; a merge keeps
		// them (§2.4 J-S4). A source that absorbed the upstream itself always comes this way: the
		// target's tip is its ancestor, so the merge is exactly the source's tree — and so does a
		// source J-S2 absorbed the CURRENT upstream into: the source is the base's ancestor, so
		// the merge is exactly the base's tree, the source plus what upstream gained since.
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
		// A session base at or before the fork would replay commits base already contains. Keep
		// the fork then; only a session base beyond it that is still on the source overrides it.
		if cmd.SessionBaseSha != "" && isAncestor(scratch, cmd.SessionBaseSha, sourceSha) && !isAncestor(scratch, cmd.SessionBaseSha, fork) {
			onto = cmd.SessionBaseSha
		}
		// Counted before the replay: afterwards the range is all that tells the two empty results
		// below apart.
		replayed := countCommits(scratch, onto, sourceSha)
		rebased, conflicts, err := integrationRebase(scratch, base, onto, sourceSha)
		if err != nil {
			result.State, result.Phase, result.Conflicts = "CONFLICT", "REBASE", conflicts
			return result
		}
		if rebased == base {
			// THE REPLAY CAME BACK AT THE BASE, so there is nothing to push: the push would be a no-op
			// and VERIFY would pass on it. That is what wrote a LANDED receipt for every task of a
			// line rebuilt from main's tip after main had taken the project's work in by another
			// route (2026-10-09, project 34PBlWiEZytRLTcPufJht). Each branch carried commits, git
			// dropped every one as "patch contents already upstream", and the line never moved.
			//
			// Two branches come back here, and the control plane must not read them as one. One
			// carried commits, and the base already had every one of them (`sourceFullyApplied`):
			// the work is on the target, as copies rather than as these commits. The other carried
			// none, because the session started on a commit the target does not have and made
			// nothing, so J-S3 never saw an empty tip. That one is J-S3's empty branch, measured
			// the same way (0300, 0346).
			//
			// Only on this path. A MERGE comes back at the base only when the source is already in
			// it, and J-S4 merges such a source only after J-S2 absorbed the current upstream into the
			// source itself. There the base is that absorb, a commit the target does not have yet,
			// and pushing it is the landing.
			result.State, result.Phase = "NOTHING_TO_LAND", "REBASE"
			onUpstream := isAncestor(scratch, sourceSha, upstreamSha)
			result.SourceOnUpstream = &onUpstream
			fullyApplied := replayed > 0
			result.SourceFullyApplied = &fullyApplied
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
		if err := prepareIntegrationTree(stop, scratch, progress); err != nil {
			if stopped, ok := integrationStopResult(err, "CHECK"); ok {
				return stopped
			}
			markUnprepared(&result, err)
			return result
		}
	}
	for index, spec := range cmd.Checks {
		outcome, stopErr := runIntegrationCheckTracked(stop, scratch, spec, index+1, len(cmd.Checks), progress)
		if stopErr != nil {
			return integrationStepEnded(stopErr, "CHECK")
		}
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
	if progress != nil {
		// §2.2 J-T4's push boundary: a v2 claim asks before it pushes and pushes only on a clear
		// answer. Nothing about the tree changes between here and the push — the check that would
		// refuse it (J-S6a) already ran above.
		switch progress.reportPush(stop, integrationPushFacts{
			TestedSha: tested, TestedTreeSha: treeSha,
			SourceSha: result.SourceSha, TargetShaBefore: targetSha,
		}) {
		case integrationPushReportCancelled:
			return integrationResult{State: "CANCELLED", Phase: "PUSH"}
		case integrationPushReportStopped:
			return integrationResult{Stopped: true, Phase: "PUSH"}
		case integrationPushReportInterrupted:
			return integrationResult{Interrupted: true, Phase: "PUSH"}
		case integrationPushReportUnreachable:
			return errorResult("PUSH", "PUSH_REPORT_UNREACHABLE", map[string]any{
				"detail": "the synchronous PUSH report could not be delivered within the lease window; nothing was pushed",
			})
		}
	}
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
		if err := integrationFetch(repoRoot, remote, cmd.TargetRef); err != nil {
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

// sourceCarriesTheAbsorb reports a source that has already done J-S2's merge itself: it contains
// the upstream tip and the target tip this job fetched (§3.1 M3).
//
// THE CONFLICT THIS EXISTS FOR (2026-10-03, project 34Y7My8sqhKLWtmCQYv1l). The project branch and
// main had each added a migration to the same ledger, so absorbing main into the branch conflicted.
// J-S2 tried that absorb on the target's own tip before it looked at the source, so a branch that
// had merged both tips and resolved the ledger met the conflict it had already resolved, and so did
// the task reopened to rework it: every landing on that line stopped at MAIN_SYNC.
//
// Both tips, measured on this job's fetch. A source that absorbed an upstream that has moved since,
// or that was cut from a target tip that has moved since, does not carry this absorb, and J-S2
// makes it as before: a conflict there is still the MAIN_SYNC conflict it always was.
//
// Not the upstream tip itself, which has nothing of its own to land. Taking this path for it would
// push a bare main sync and turn J-S3's NOTHING_TO_LAND (0300) into a landing.
func sourceCarriesTheAbsorb(dir, sourceSha, targetSha, upstreamSha string) bool {
	return sourceSha != upstreamSha &&
		isAncestor(dir, upstreamSha, sourceSha) && isAncestor(dir, targetSha, sourceSha)
}

// sourceCarriesAnEarlierAbsorb reports a source that absorbed the upstream at an EARLIER tip and
// carries the resolution on top: it contains the target tip, its newest commit shared with the
// upstream tip this job fetched — the upstream commit it absorbed, U′ — is one the target does not
// have, and its own tip is past U′. J-S2 then merges the CURRENT upstream into such a source rather
// than into the target's tip: the branch that holds the resolution between the project work and U′,
// which a merge into the target would throw away and meet again as the same conflict.
//
// A source whose shared tip is in the target absorbed nothing the target does not know, and one
// whose tip IS the shared tip is an upstream commit itself — nothing of its own to land, whose
// NOTHING_TO_LAND must not be turned into a bare main sync (the same reason sourceCarriesTheAbsorb
// excludes the upstream tip itself). Both stay on J-S2's old path.
func sourceCarriesAnEarlierAbsorb(dir, sourceSha, targetSha, upstreamSha string) bool {
	if !isAncestor(dir, targetSha, sourceSha) || isAncestor(dir, upstreamSha, sourceSha) {
		return false
	}
	shared, err := git(dir, "merge-base", sourceSha, upstreamSha)
	if err != nil {
		return false
	}
	shared = strings.TrimSpace(shared)
	if shared == "" || shared == sourceSha || isAncestor(dir, shared, targetSha) {
		return false
	}
	return true
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
func promoteOnce(stop context.Context, cmd IntegrationJobCommand, repoRoot, scratch string, report integrationReporter, progress *integrationProgress) integrationResult {
	remote := cmd.RemoteName
	if remote == "" {
		remote = "origin"
	}
	local := cmd.RefAuthority == "RUNNER_LOCAL"
	landing := cmd.Kind == "LAND_PROMOTION"

	// ── M-S1 FETCH ────────────────────────────────────────────────────────────────────────────
	report("FETCH", nil)
	if !local {
		if err := integrationFetch(repoRoot, remote, cmd.UpstreamRef); err != nil {
			return fetchRefFailure("FETCH", cmd.UpstreamRef, err, "BASE_REF_NOT_FOUND")
		}
		if err := integrationFetch(repoRoot, remote, cmd.SourceRef); err != nil {
			return fetchRefFailure("FETCH", cmd.SourceRef, err, "SOURCE_BRANCH_MISSING")
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
	// J12's receipt repair, against the upstream this fetch just read (a promotion's target IS its
	// upstream).
	result.UnknownPushes = checkUnknownPushes(repoRoot, upstreamSha, cmd.UnknownPushes)

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
	// a landing the owner confirmed does (M5), re-check the new tip and merge it: it merges nothing
	// and reports READY. The control plane then checks the candidate again on the new tip and reads
	// the Automatic rule again over that check — or asks the owner, once main has kept moving. A
	// landing that names no checked tip has nothing to be held to, and lands nothing either.
	if landing && cmd.Automatic && (cmd.UpstreamShaChecked == "" || cmd.UpstreamShaChecked != upstreamSha) {
		// What the upstream gained, for the job row and the item a third move opens (J-T13). No
		// checked tip means nothing to measure from, and the list stays absent rather than empty.
		if cmd.UpstreamShaChecked != "" {
			result.UpstreamMovedCommits = movedCommits(repoRoot, cmd.UpstreamShaChecked, upstreamSha)
		}
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
		// in this file is (J-S4): use the fork when the session base is at or before it, avoiding
		// replay of commits already in upstream; only a session base beyond the fork that is still
		// an ancestor of the source overrides it.
		fork, _ := git(scratch, "merge-base", sourceSha, upstreamSha)
		onto := fork
		if cmd.SessionBaseSha != "" && isAncestor(scratch, cmd.SessionBaseSha, sourceSha) && !isAncestor(scratch, cmd.SessionBaseSha, fork) {
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
			if err := prepareIntegrationTree(stop, scratch, progress); err != nil {
				if stopped, ok := integrationStopResult(err, "CHECK"); ok {
					return stopped
				}
				markUnprepared(&result, err)
				return result
			}
		}
		for index, spec := range cmd.Checks {
			outcome, stopErr := runIntegrationCheckTracked(stop, scratch, spec, index+1, len(cmd.Checks), progress)
			if stopErr != nil {
				return integrationStepEnded(stopErr, "CHECK")
			}
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
	if progress != nil {
		// M-S4's synchronous report, the same rule as J-S6's (§2.2 J-T4): a v2 claim asks before it
		// pushes and pushes only on a clear answer.
		switch progress.reportPush(stop, integrationPushFacts{
			TestedSha: tested, TestedTreeSha: treeSha,
			SourceSha: result.SourceSha, TargetShaBefore: upstreamSha,
		}) {
		case integrationPushReportCancelled:
			return integrationResult{State: "CANCELLED", Phase: "PUSH"}
		case integrationPushReportStopped:
			return integrationResult{Stopped: true, Phase: "PUSH"}
		case integrationPushReportInterrupted:
			return integrationResult{Interrupted: true, Phase: "PUSH"}
		case integrationPushReportUnreachable:
			return errorResult("PUSH", "PUSH_REPORT_UNREACHABLE", map[string]any{
				"detail": "the synchronous PUSH report could not be delivered within the lease window; nothing was pushed",
			})
		}
	}
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
			// J-T13: the first refused push ends this claim. Read the upstream as it is now, so the
			// result can say what moved it — the commits are here and nowhere the control plane can
			// read them. A fetch that fails changes nothing about the answer, only how much the
			// list can say.
			if movedTo := refreshedUpstreamTip(repoRoot, remote, cmd.UpstreamRef, local); movedTo != "" && movedTo != upstreamSha {
				result.UpstreamMovedCommits = movedCommits(repoRoot, upstreamSha, movedTo)
			}
			if cmd.Automatic {
				// M-T12: an automatic landing is authorized onto the checked tip only, so a moved
				// main takes nothing from the owner's press. It answers READY with nothing landed,
				// and the control plane checks the candidate again on the new main.
				result.State = "READY"
				result.ErrorCode = ""
				return result
			}
		} else {
			result.ErrorCode = "PUSH_REJECTED"
		}
		result.ErrorDetail = map[string]any{"detail": clip(gitStderr(pushErr), 2000)}
		return result
	}

	// ── VERIFY ────────────────────────────────────────────────────────────────────────────────
	report("VERIFY", nil)
	if !local {
		if err := integrationFetch(repoRoot, remote, cmd.UpstreamRef); err != nil {
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
//
// A variable so a test can watch whether a push was attempted at all: the one thing the synchronous
// PUSH report has to prevent when its answer is a stop (§2.2 J-T4).
var integrationPush = func(repoRoot, scratch, remote, targetRef, tested, expectedBefore string, local bool) error {
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
//
// stop is the runner's own stop (runIntegrationJobUntil): when it ends, the recipe is ended with its
// whole process tree and errIntegrationInterrupted is answered, which is not a fact about the tree.
//
// progress is the v2 claim's reporter (§2.2 J-T4) and nil for a legacy one: the recipe is the long
// step such a claim says it is on (step = PREPARE) and whose output silence it reports.
func prepareIntegrationTree(stop context.Context, scratch string, progress *integrationProgress) error {
	script := filepath.Join(scratch, filepath.FromSlash(integrationPrepareScript))
	if info, err := os.Stat(script); err != nil || info.IsDir() {
		return nil
	}
	ctx, cancel := context.WithTimeout(stop, integrationPrepareTimeout)
	defer cancel()
	started := time.Now()
	// The same shell the checks get (`bash -lc`, runner environment): what the recipe lays down has
	// to be what those commands resolve against, PATH and all.
	output, runErr, stopErr := runIntegrationCommand(ctx, scratch, "bash "+integrationPrepareScript,
		func(out *integrationOutput) {
			if progress != nil {
				progress.beginStep("CHECK", "PREPARE", nil, out)
				progress.uploadPrepare(out)
			}
		})
	if progress != nil {
		progress.endStep()
	}
	if stopErr != nil {
		return stopErr
	}
	if errors.Is(context.Cause(ctx), context.DeadlineExceeded) {
		return fmt.Errorf("%s did not finish within %s: %s",
			integrationPrepareScript, integrationPrepareTimeout, tailOf(output.text(), 2000))
	}
	if runErr != nil {
		return fmt.Errorf("%s failed (%v): %s", integrationPrepareScript, runErr, tailOf(output.text(), 2000))
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

// errIntegrationInterrupted is what a step answers when the runner's stop ended it
// (runIntegrationJobUntil): not a fact about the work, so never reported as one. The claim is handed
// back (J-T11) and the next process runs the job again.
var errIntegrationInterrupted = errors.New("the runner is stopping")

// errIntegrationCancelled is what a step answers when the control plane asked the job to stop
// (§2.2 J-T4, J-T12): the process group is killed, nothing is pushed, and the job answers CANCELLED
// rather than being handed back.
var errIntegrationCancelled = errors.New("the control plane asked this job to stop")

// errIntegrationClaimLost is what a step answers when a progress report was refused 409
// STALE_CLAIM, 409 ALREADY_FINAL or 404 (§2.2 J-T4): the claim was taken over, released, abandoned
// or written down, so there is nobody left to report to — not even a CANCELLED.
var errIntegrationClaimLost = errors.New("this claim is no longer ours")

// integrationCauseOutcome names the way a job's context ended, when it ended for a reason other
// than a step's own budget: the three sentinels above, or nil while there is no such cause. A plain
// cancellation (context.Canceled, or the runner's stop) is the runner stopping.
func integrationCauseOutcome(ctx context.Context) error {
	cause := context.Cause(ctx)
	switch {
	case cause == nil, errors.Is(cause, context.DeadlineExceeded):
		return nil
	case errors.Is(cause, errIntegrationCancelled):
		return errIntegrationCancelled
	case errors.Is(cause, errIntegrationClaimLost):
		return errIntegrationClaimLost
	default:
		return errIntegrationInterrupted
	}
}

// integrationStoppedResult is the job's answer once its context ended: the cause says which of the
// three facts it is.
func integrationStoppedResult(ctx context.Context, phase string) integrationResult {
	switch integrationCauseOutcome(ctx) {
	case errIntegrationCancelled:
		return integrationResult{State: "CANCELLED", Phase: phase}
	case errIntegrationClaimLost:
		return integrationResult{Stopped: true, Phase: phase}
	default:
		return integrationResult{Interrupted: true, Phase: phase}
	}
}

// integrationStopResult turns a step's sentinel error into the job's answer: true when err is one
// of the three endings, with the result that ending reports.
func integrationStopResult(err error, phase string) (integrationResult, bool) {
	switch {
	case errors.Is(err, errIntegrationCancelled):
		return integrationResult{State: "CANCELLED", Phase: phase}, true
	case errors.Is(err, errIntegrationClaimLost):
		return integrationResult{Stopped: true, Phase: phase}, true
	case errors.Is(err, errIntegrationInterrupted):
		return integrationResult{Interrupted: true, Phase: phase}, true
	}
	return integrationResult{}, false
}

// integrationStepEnded is integrationStopResult for a step that only ever answers one of the three
// endings: the result that ending reports.
func integrationStepEnded(err error, phase string) integrationResult {
	if result, ok := integrationStopResult(err, phase); ok {
		return result
	}
	return integrationResult{Interrupted: true, Phase: phase}
}

// stoppedByTheRunner reports a command that the runner's own stop ended: its context was cancelled
// by the runner rather than run out of budget or cancelled by the control plane, and the process did
// not exit by itself first — one that did has an answer, and it is reported as any other.
func stoppedByTheRunner(ctx context.Context, runErr error) bool {
	if integrationCauseOutcome(ctx) != errIntegrationInterrupted || runErr == nil {
		return false
	}
	var exitErr *exec.ExitError
	return !errors.As(runErr, &exitErr) || exitErr.ExitCode() < 0
}

// runIntegrationCheck runs one command in the scratch worktree under its own budget.
//
// `bash -lc` and the runner's own environment, deliberately: this is the platform's check, not the
// agent's turn, and it must not inherit a session's credentials or its provider configuration.
func runIntegrationCheck(scratch string, spec IntegrationCheckSpec) IntegrationCheckResult {
	result, _ := runIntegrationCheckUntil(context.Background(), scratch, spec)
	return result
}

// runIntegrationCheckUntil is runIntegrationCheck under the runner's stop: when stop ends first, the
// check is ended and answers interrupted rather than a result, since it measured nothing.
//
// The command leads a process group of its own and is ended with its whole tree, on its budget as on
// the stop: `bash -lc` forks, and a check ended by its parent's PID alone left its children running in
// the very worktree that is about to be removed.
func runIntegrationCheckUntil(stop context.Context, scratch string, spec IntegrationCheckSpec) (IntegrationCheckResult, bool) {
	result, stopErr := runIntegrationCheckTracked(stop, scratch, spec, 1, 1, nil)
	return result, stopErr != nil
}

// runIntegrationCheckTracked is runIntegrationCheckUntil with the v2 progress protocol: index and
// count place this check in the run, and progress carries it, its budget and its output silence to
// the control plane while the check runs (§2.2 J-T4).
func runIntegrationCheckTracked(stop context.Context, scratch string, spec IntegrationCheckSpec, index, count int, progress *integrationProgress) (IntegrationCheckResult, error) {
	budget := time.Duration(spec.TimeoutSeconds) * time.Second
	if spec.TimeoutSeconds <= 0 {
		budget = time.Hour
	}
	ctx, cancel := context.WithTimeout(stop, budget)
	defer cancel()
	started := time.Now()
	check := &IntegrationJobCurrentCheck{
		Name:          spec.Name,
		Index:         index,
		Count:         count,
		BudgetSeconds: int(budget / time.Second),
		StartedAt:     started.UTC().Format(time.RFC3339Nano),
	}
	output, runErr, stopErr := runIntegrationCommand(ctx, scratch, spec.Command, func(out *integrationOutput) {
		if progress != nil {
			progress.beginStep("CHECK", "", check, out)
			progress.uploadOutput(out, IntegrationJobOutputCheck{Name: spec.Name, Index: index})
		}
	})
	if progress != nil {
		progress.endStep()
	}
	result := IntegrationCheckResult{
		Name:             spec.Name,
		Command:          spec.Command,
		ExpectedExitCode: spec.ExpectedExitCode,
		DurationMs:       time.Since(started).Milliseconds(),
		OutputTail:       tailOf(output.text(), integrationOutputTail),
	}
	if stopErr != nil {
		return result, stopErr
	}
	if errors.Is(context.Cause(ctx), context.DeadlineExceeded) {
		result.TimedOut = true
		return result, nil
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
	return result, nil
}

// integrationOutput is one command's combined stdout and stderr, kept as it is written: the last
// integrationOutputTail bytes for the result, and — what the v2 progress report needs — when that
// output last moved and how much of it there has been (§2.2 J-T4).
//
// The same model bg_run's tailer reports (`idleMs` in background_job.go), and for the same reason:
// a silence is only measurable if the writes are seen as they happen, which CombinedOutput does not
// show — it returns once, at the end. That is also why a command that exits 0 while a child it
// started still holds the pipe used to come back as a failure (ErrWaitDelay, below).
type integrationOutput struct {
	mu        sync.Mutex
	tail      []byte
	bytes     int64
	started   time.Time
	lastWrite time.Time
	// sink is where the same writes are streamed for upload (§2.2 J-T4's output route); nil on a
	// legacy claim and whenever no uploader was attached. Writing to it is what the tail buffer
	// does not do — it keeps every byte, the tail keeps the last 16 KB.
	sinkMu sync.Mutex
	sink   integrationOutputSink
}

// integrationOutputSink is the uploader's side of the writer: one Write per chunk the command
// printed, and a Close that sends what is left.
type integrationOutputSink interface {
	Write(p []byte)
	Close()
}

// attachSink starts streaming this command's writes. Called before the command starts.
func (o *integrationOutput) attachSink(sink integrationOutputSink) {
	o.sinkMu.Lock()
	o.sink = sink
	o.sinkMu.Unlock()
}

// closeSink stops streaming and sends what is left. Called after the command's process tree is
// gone; a late write from a child that outlived an ErrWaitDelay end finds no sink and is dropped.
func (o *integrationOutput) closeSink() {
	o.sinkMu.Lock()
	sink := o.sink
	o.sink = nil
	o.sinkMu.Unlock()
	if sink != nil {
		sink.Close()
	}
}

func newIntegrationOutput() *integrationOutput {
	return &integrationOutput{started: time.Now()}
}

func (o *integrationOutput) Write(p []byte) (int, error) {
	o.mu.Lock()
	o.lastWrite = time.Now()
	o.bytes += int64(len(p))
	o.tail = append(o.tail, p...)
	// Trim in chunks rather than on every write, so a chatty check does not copy its tail once
	// per line; text() answers exactly the last integrationOutputTail bytes either way.
	if len(o.tail) > 2*integrationOutputTail {
		o.tail = append([]byte(nil), o.tail[len(o.tail)-integrationOutputTail:]...)
	}
	o.mu.Unlock()
	// The uploader copies what it takes; the slice is the caller's and is reused.
	o.sinkMu.Lock()
	sink := o.sink
	o.sinkMu.Unlock()
	if sink != nil {
		sink.Write(p)
	}
	return len(p), nil
}

// idleMillis is how long this command has produced nothing as of at, never negative: a clock that
// stepped backwards while output was being written must not report a silence it has not had.
func (o *integrationOutput) idleMillis(at time.Time) int64 {
	o.mu.Lock()
	defer o.mu.Unlock()
	since := o.lastWrite
	if since.IsZero() {
		since = o.started
	}
	if idle := at.Sub(since); idle > 0 {
		return idle.Milliseconds()
	}
	return 0
}

func (o *integrationOutput) size() int64 {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.bytes
}

func (o *integrationOutput) text() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(o.tail) <= integrationOutputTail {
		return string(o.tail)
	}
	return string(o.tail[len(o.tail)-integrationOutputTail:])
}

// runIntegrationCommand runs one command with its output tracked as it is written, and answers what
// the command came to and, when the job itself is ending, why.
//
// ErrWaitDelay IS A NORMAL END. A command that exits 0 while a child it started still holds the
// output pipe makes Wait run out its WaitDelay and answer exec.ErrWaitDelay; the command succeeded,
// and the child is not the job's to leave running. The process group is killed after EVERY end — a
// recipe or a check that started a server or a watcher must not outlive the tree it ran in — and
// ErrWaitDelay is then reported as the zero exit it is (contract §1.6 V6: a healthy tree or check
// that leaves a child holding the output is not a failure).
func runIntegrationCommand(ctx context.Context, dir, command string, onStart func(*integrationOutput)) (*integrationOutput, error, error) {
	output := newIntegrationOutput()
	cmd := exec.CommandContext(ctx, "bash", "-lc", command)
	cmd.Dir = dir
	configureSessionProcessTree(cmd)
	cmd.Stdout = output
	cmd.Stderr = output
	if onStart != nil {
		onStart(output)
	}
	runErr := cmd.Run()
	// Normal end or not, what the command left behind in its process group goes now, and the
	// uploader sends what the command printed before the next step starts.
	_ = terminateSessionProcessTree(cmd)
	output.closeSink()
	if errors.Is(runErr, exec.ErrWaitDelay) {
		runErr = nil
	}
	switch cause := integrationCauseOutcome(ctx); cause {
	case errIntegrationCancelled, errIntegrationClaimLost:
		// A stop request is honoured even when the command happened to exit as it arrived: nothing
		// is pushed after one (§2.2 J-T4).
		return output, runErr, cause
	}
	if stoppedByTheRunner(ctx, runErr) {
		return output, runErr, errIntegrationInterrupted
	}
	return output, runErr, nil
}

// integrationProgressEvery is how often a v2 claim says it is still working: the contract asks for
// a report inside every 30 seconds (§2.2 J-T4), and 25 leaves room for one slow answer before the
// next is due.
const integrationProgressEvery = 25 * time.Second

// integrationPushReportBudget is how long the synchronous PUSH report is retried before the job
// gives up and ends ERROR / PUSH_REPORT_UNREACHABLE without pushing (§2.2 J-T4). The claim's lease
// is ten minutes (INTEGRATION_CLAIM_STALE_MS on the control plane), and a report that cannot be
// delivered inside one is a claim this process no longer holds.
const integrationPushReportBudget = 10 * time.Minute

// integrationPushReport is what the synchronous report before a push came to.
type integrationPushReport int

const (
	// integrationPushReportClear: 200 and nobody asked this job to stop. The push may go.
	integrationPushReportClear integrationPushReport = iota
	// integrationPushReportCancelled: the answer carried cancelRequested. Nothing is pushed and the
	// job answers CANCELLED (J-T12).
	integrationPushReportCancelled
	// integrationPushReportStopped: 409 STALE_CLAIM / ALREADY_FINAL or 404. Nothing is pushed and
	// nothing is reported: the claim is no longer this process's.
	integrationPushReportStopped
	// integrationPushReportInterrupted: the runner itself is stopping. Nothing is pushed and the
	// claim is handed back (J-T11).
	integrationPushReportInterrupted
	// integrationPushReportUnreachable: no answer inside the lease window. Nothing is pushed, and the
	// job ends ERROR / PUSH_REPORT_UNREACHABLE with its result spooled for the next start.
	integrationPushReportUnreachable
)

// integrationProgress is a v2 claim's periodic report (§2.2 J-T4): one ticker goroutine says what
// step the job is on and how idle its output is, reads the control plane's answer, and ends the job
// when that answer says to stop. It is what makes a job stoppable within 30 seconds and a long
// check visibly alive.
//
// The job keeps working exactly as it did; the only places it consults this are the ones the
// contract names — the local lock wait, the tree's recipe, each check, and the synchronous PUSH
// report.
type integrationProgress struct {
	cmd    IntegrationJobCommand
	send   integrationProgressSender
	cancel context.CancelCauseFunc
	// sendCtx is the job's context: a send is abandoned when the job ends, and a cancellation
	// arriving from the control plane ends the send that carried it.
	sendCtx   context.Context
	stopSends context.CancelFunc

	mu        sync.Mutex
	phase     string
	step      string
	round     int
	check     *IntegrationJobCurrentCheck
	output    *integrationOutput
	uploads   *integrationLogUploader
	stepAt    time.Time
	afterPush bool
	noted     bool

	done chan struct{}
	wg   sync.WaitGroup
}

func newIntegrationProgress(jobCtx context.Context, cancel context.CancelCauseFunc, cmd IntegrationJobCommand, send integrationProgressSender) *integrationProgress {
	sendCtx, stopSends := context.WithCancel(jobCtx)
	p := &integrationProgress{
		cmd: cmd, send: send, cancel: cancel,
		sendCtx: sendCtx, stopSends: stopSends, done: make(chan struct{}),
		// A job always starts in FETCH, and a tick that beat the first beginStep must still name
		// a phase the control plane accepts.
		phase: "FETCH",
	}
	// The output stream exists only for a v2 claim: a legacy claim has no outputSender and keeps
	// exactly the 16 KB tail its result carries (§2.2 J-T4, §2.9 LS2).
	p.uploads = newIntegrationLogUploader(sendCtx, cmd)
	p.wg.Add(1)
	go p.tick()
	return p
}

func (p *integrationProgress) every() time.Duration {
	if p.cmd.progressEvery > 0 {
		return p.cmd.progressEvery
	}
	return integrationProgressEvery
}

func (p *integrationProgress) pushBudget() time.Duration {
	if p.cmd.pushReportBudget > 0 {
		return p.cmd.pushReportBudget
	}
	return integrationPushReportBudget
}

// tick is the periodic half: it reports whatever the state says, without changing it.
func (p *integrationProgress) tick() {
	defer p.wg.Done()
	ticker := time.NewTicker(p.every())
	defer ticker.Stop()
	for {
		select {
		case <-p.done:
			return
		case <-ticker.C:
			resp, err := p.send(p.sendCtx, p.request())
			p.handleAnswer(resp, err)
		}
	}
}

// close ends the ticker and whatever send is in flight, and waits for the goroutine. Called on
// every exit, so no report outlives its job. The output uploader finishes first, while sendCtx is
// still alive, so the last chunks a check printed are not lost to the shutdown.
func (p *integrationProgress) close() {
	close(p.done)
	if p.uploads != nil {
		p.uploads.close()
	}
	p.stopSends()
	p.wg.Wait()
}

// request is what the state says right now, in the shape the progress route takes.
func (p *integrationProgress) request() IntegrationJobProgressRequest {
	p.mu.Lock()
	req := IntegrationJobProgressRequest{
		ClaimGeneration: p.cmd.ClaimGeneration,
		LeaseOwner:      p.cmd.LeaseOwner,
		Phase:           p.phase,
		Step:            p.step,
		Round:           p.round,
	}
	check := p.check
	output := p.output
	stepAt := p.stepAt
	p.mu.Unlock()
	if check != nil {
		current := *check
		req.Check = &current
	}
	if output != nil {
		idle := output.idleMillis(time.Now())
		size := output.size()
		req.OutputIdleMs = &idle
		req.OutputBytes = &size
	} else if !stepAt.IsZero() {
		idle := time.Since(stepAt).Milliseconds()
		if idle < 0 {
			idle = 0
		}
		req.OutputIdleMs = &idle
	}
	return req
}

// beginStep moves the job onto a named sub-step and says so at once: a step that lasts less than
// one tick must still be visible, and WAITING_LOCAL_LOCK has to be on the wire before the lock can
// block.
func (p *integrationProgress) beginStep(phase, step string, check *IntegrationJobCurrentCheck, output *integrationOutput) {
	p.mu.Lock()
	p.phase, p.step, p.check, p.output = phase, step, check, output
	p.stepAt = time.Now()
	p.mu.Unlock()
	resp, err := p.send(p.sendCtx, p.request())
	p.handleAnswer(resp, err)
}

// uploadOutput streams this command's writes as the check they belong to (§2.2 J-T4's output
// route). A legacy claim has no uploader, and nothing is attached.
func (p *integrationProgress) uploadOutput(out *integrationOutput, check IntegrationJobOutputCheck) {
	if p.uploads != nil {
		p.uploads.attach(out, check)
	}
}

// uploadPrepare streams the tree's recipe under the check it is preparing: the recipe runs once
// before the checks, so its output belongs to the first check's log (and shares that check's seq
// numbering, which is why the recipe's chunks are not overwritten by check 1's first chunk).
func (p *integrationProgress) uploadPrepare(out *integrationOutput) {
	if p.uploads == nil || len(p.cmd.Checks) == 0 {
		return
	}
	p.uploads.attach(out, IntegrationJobOutputCheck{Name: p.cmd.Checks[0].Name, Index: 1})
}

// endStep leaves the named sub-step. The next report either names a new one or says none.
func (p *integrationProgress) endStep() {
	p.mu.Lock()
	p.step, p.check, p.output = "", nil, nil
	p.mu.Unlock()
}

func (p *integrationProgress) setRound(round int) {
	p.mu.Lock()
	p.round = round
	p.mu.Unlock()
}

// phaseReached is the step-boundary report, with the moved upstream when a confirmed promotion is
// redoing its merge on a new tip (M-T7). The PUSH boundary is not sent here: it is synchronous, and
// reportPush is what asks and waits (§2.2 J-T4).
func (p *integrationProgress) phaseReached(phase string, moved *IntegrationUpstreamMoved) {
	p.mu.Lock()
	// A phase boundary ends whatever named sub-step was in flight: WAITING_LOCAL_LOCK ends when the
	// lock is taken, and PREPARE and a check end before the next phase is reported.
	p.phase, p.step, p.check, p.output = phase, "", nil, nil
	p.stepAt = time.Now()
	p.mu.Unlock()
	if phase == "PUSH" {
		return
	}
	req := p.request()
	req.UpstreamMoved = moved
	resp, err := p.send(p.sendCtx, req)
	p.handleAnswer(resp, err)
}

// handleAnswer reads the stop signal in the other direction. A transient failure is nothing: the
// next tick says the same thing again. A stop request ends the job's checks with their process
// groups; a refused claim ends it with nothing left to report.
func (p *integrationProgress) handleAnswer(resp *IntegrationJobProgressResponse, err error) {
	if err != nil {
		if integrationProgressStopSignal(err) {
			p.cancelWith(errIntegrationClaimLost)
		}
		return
	}
	if resp == nil || !resp.CancelRequested {
		return
	}
	p.mu.Lock()
	afterPush := p.afterPush
	p.mu.Unlock()
	if !afterPush {
		// Once this claim is past its push boundary a cancellation is refused upstream (M-T10),
		// and the result is what happened rather than what was asked (M-T8).
		p.cancelWith(errIntegrationCancelled)
	}
}

// cancelWith ends the job with a cause. The first ending is the one logged: the ticker and a
// boundary report can both see the same answer.
func (p *integrationProgress) cancelWith(cause error) {
	p.mu.Lock()
	noted := p.noted
	p.noted = true
	p.mu.Unlock()
	if !noted {
		switch {
		case errors.Is(cause, errIntegrationCancelled):
			logln("integration job", p.cmd.JobID,
				"was asked to stop by the control plane; killing what it is running and answering CANCELLED")
		case errors.Is(cause, errIntegrationClaimLost):
			logln("integration job", p.cmd.JobID,
				"is no longer this process's claim; killing what it is running and reporting nothing")
		}
	}
	p.cancel(cause)
}

// integrationPushFacts is what the synchronous PUSH report says about the commit about to be pushed,
// so the control plane can write them down while the claim still holds the row (J12): a job whose
// push outcome becomes unknown leaves the next landing on its serial key what it needs to check.
type integrationPushFacts struct {
	TestedSha       string
	TestedTreeSha   string
	SourceSha       string
	TargetShaBefore string
}

// reportPush is J-S6 / M-S4's synchronous report: phase = PUSH, then wait for the control plane's
// answer before anything is pushed. It retries only what can clear on its own (a network failure,
// a 5xx, a timeout); the lease window is its budget, and past it the job ends without pushing.
func (p *integrationProgress) reportPush(ctx context.Context, facts integrationPushFacts) integrationPushReport {
	p.mu.Lock()
	p.phase, p.step, p.check, p.output = "PUSH", "", nil, nil
	p.stepAt = time.Now()
	p.mu.Unlock()
	started := time.Now()
	for attempt := 1; ; attempt++ {
		request := p.request()
		request.TestedSha = facts.TestedSha
		request.TestedTreeSha = facts.TestedTreeSha
		request.SourceSha = facts.SourceSha
		request.TargetShaBefore = facts.TargetShaBefore
		resp, err := p.send(ctx, request)
		switch {
		case err == nil && resp != nil && !resp.CancelRequested:
			p.mu.Lock()
			p.afterPush = true
			p.mu.Unlock()
			return integrationPushReportClear
		case err == nil:
			p.cancelWith(errIntegrationCancelled)
			return integrationPushReportCancelled
		case integrationProgressStopSignal(err):
			p.cancelWith(errIntegrationClaimLost)
			return integrationPushReportStopped
		case ctx.Err() != nil:
			switch integrationCauseOutcome(ctx) {
			case errIntegrationCancelled:
				return integrationPushReportCancelled
			case errIntegrationClaimLost:
				return integrationPushReportStopped
			}
			return integrationPushReportInterrupted
		case time.Since(started) >= p.pushBudget():
			logln("integration job", p.cmd.JobID,
				"could not deliver its synchronous PUSH report within the lease window; nothing is pushed:", err)
			return integrationPushReportUnreachable
		}
		wait := integrationResultRetry.wait(attempt)
		logln("integration job", p.cmd.JobID, fmt.Sprintf("PUSH report not delivered on attempt %d:", attempt),
			err, "trying again in", wait.Round(100*time.Millisecond))
		integrationResultRetry.sleep(ctx, wait)
	}
}

// integrationProgressStopSignal reports the answers that mean this claim is gone: 409 STALE_CLAIM,
// 409 ALREADY_FINAL and 404 (§2.2 J-T4). None is retried as a transient error.
func integrationProgressStopSignal(err error) bool {
	var httpErr *transportHTTPError
	return errors.As(err, &httpErr) &&
		(httpErr.statusCode == http.StatusNotFound || httpErr.statusCode == http.StatusConflict)
}

// integrationScratchPath is where one job's throwaway worktree is staged: under
// <worktreesDir>/_integrate-<jobId>, or under the root the caller injected (tests that run in
// parallel cannot set ORBIT_HOME for the whole process, and each case needs a root of its own).
func integrationScratchPath(cmd IntegrationJobCommand) string {
	root := cmd.scratchRoot
	if root == "" {
		root = worktreesDir()
	}
	return filepath.Join(root, integrateScratchPrefix+cmd.JobID)
}

// legacyIntegrationScratchPath is where builds before the move staged the same job: beside the
// workspace's work dir (filepath.Dir(workDir)), often the user's home. Nothing sweeps that place
// any more, so it is named only to clear the one copy a killed old-build process could have left.
func legacyIntegrationScratchPath(workDir, jobID string) string {
	return filepath.Join(filepath.Dir(expandTilde(workDir)), integrateScratchPrefix+jobID)
}

// sweepIntegrationScratch removes scratch worktrees that no job is using: what a process killed
// mid-landing — a self-update, a restart, a crash — leaves behind. It is called before this
// process claims any work, with the roots that may hold one: the current worktrees directory and,
// once the control plane has named the workspaces, the parent of every workspace's work dir (where
// builds before the move staged them). active reports whether this process is integrating a job
// right now; that job's tree is never touched.
//
// The worktree garbage collector deliberately never reclaims these (it excludes the prefix), so
// this sweep is the only thing that does, and it must run with the in-flight set rather than
// trusting the server's removable answer — the server says every non-session directory is
// removable, which includes a landing that is running.
func sweepIntegrationScratch(roots []string, active func(jobID string) bool) {
	seen := make(map[string]bool, len(roots))
	for _, root := range roots {
		if root == "" || seen[root] {
			continue
		}
		seen[root] = true
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() || !strings.HasPrefix(e.Name(), integrateScratchPrefix) {
				continue
			}
			jobID := strings.TrimPrefix(e.Name(), integrateScratchPrefix)
			if jobID == "" || (active != nil && active(jobID)) {
				continue
			}
			path := filepath.Join(root, e.Name())
			logln("integration scratch", path, "was left by a process that is gone; removing it")
			removeIntegrationScratch(path)
		}
	}
}

// removeIntegrationScratch removes one leftover scratch directory. A scratch tree is a registered
// worktree of the repository it was staged from, so it is unregistered through the repository the
// directory itself names; one whose repository is gone, or that is not a worktree at all, is
// removed as a plain directory.
func removeIntegrationScratch(path string) {
	if common, err := git(path, "rev-parse", "--git-common-dir"); err == nil && common != "" {
		if !filepath.IsAbs(common) {
			common = filepath.Join(path, common)
		}
		removeIntegrationWorktree(filepath.Dir(common), path)
		return
	}
	_ = os.RemoveAll(path)
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

// integrationFetch fetches one remote ref into this checkout's remote-tracking copy, trying again
// when the only thing in the way was another process updating that same ref.
//
// THE FAILURE THIS EXISTS FOR (2026-10-02, project 34Yjjgt2ERe9tU5TUmjAP). `git fetch <remote> <ref>`
// does not only write FETCH_HEAD: it updates `refs/remotes/<remote>/<branch>` as well, and that ref
// is SHARED — every integration job, every session worktree and every `git fetch` in this repository
// writes it. Two of them arriving together and the second one's ref update is refused with
//
//	error: cannot lock ref 'refs/remotes/origin/main': is at 0ca3c834… but expected 869e718b…
//
// which is not an answer about anything the job asked for: the ref moved between this fetch reading
// it and writing it, so the same fetch, run again, simply works. It was reported as
// BASE_REF_NOT_FOUND — a code that means the upstream branch does not exist, and that a reader acts
// on by going to look at the branch — and the promotion it was a step of went BLOCKED over a race
// it would have won a moment later.
func integrationFetch(repoRoot, remote, ref string) error {
	return fetchRetryingRefLock(repoRoot, remote, ref)
}

// fetchRetryingRefLock runs `git fetch <args>` in dir, trying again while the only thing in the way
// was another process holding a ref this fetch writes. Shared with the SOURCE resolution
// (source.go), whose fetch moves the same remote-tracking refs.
func fetchRetryingRefLock(dir string, args ...string) error {
	var err error
	for attempt := 0; attempt < integrationFetchLockAttempts; attempt++ {
		if attempt > 0 {
			integrationFetchLockPause(integrationFetchLockWait << (attempt - 1))
		}
		if _, err = git(dir, append([]string{"fetch"}, args...)...); err == nil || !isRefLockConflict(err) {
			return err
		}
	}
	return err
}

// isRefLockConflict reports git refusing to take a ref's lock: another process holds the `.lock`
// file, or moved the ref between this fetch's read of it and its write. Both spellings say "cannot
// lock ref", and neither is a statement about the branch the job asked for.
func isRefLockConflict(err error) bool {
	return err != nil && strings.Contains(gitStderr(err), "cannot lock ref")
}

// fetchRefFailure is what a fetch that got nowhere is reported as: `branchCode` for a failure that
// is about the ref itself — it is not there — and FETCH_FAILED for the one that is about the
// machinery, a ref lock that outlived its retries. The second is deliberately not a code a reader
// could act on by going to look at a branch.
func fetchRefFailure(phase, ref string, err error, branchCode string) integrationResult {
	code := branchCode
	if isRefLockConflict(err) {
		code = "FETCH_FAILED"
	}
	return errorResult(phase, code, map[string]any{"ref": ref, "detail": gitStderr(err)})
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

// checkUnknownPushes answers J12's repair question for each earlier landing the command named: is
// the commit it tested already an ancestor of the target this job just fetched? Only the entries git
// answered for are reported — exit 1 is "no", everything else (a sha this repository does not have,
// a broken object) is "cannot tell", and an answer that cannot be told apart is not one to give.
func checkUnknownPushes(dir, targetSha string, entries []IntegrationUnknownPush) []IntegrationUnknownPushCheck {
	if len(entries) == 0 || targetSha == "" {
		return nil
	}
	var checks []IntegrationUnknownPushCheck
	for _, entry := range entries {
		if entry.JobID == "" || entry.TestedSha == "" {
			continue
		}
		err := exec.Command("git", "-C", dir, "merge-base", "--is-ancestor", entry.TestedSha, targetSha).Run()
		var exit *exec.ExitError
		switch {
		case err == nil:
			checks = append(checks, IntegrationUnknownPushCheck{JobID: entry.JobID, Landed: true})
		case errors.As(err, &exit) && exit.ExitCode() == 1:
			checks = append(checks, IntegrationUnknownPushCheck{JobID: entry.JobID, Landed: false})
		}
	}
	return checks
}

// movedCommits is what the upstream gained between two tips, as J-T4's UpstreamMovedCommits carries
// it: first-parent, newest first, at most twenty commits, with the true total beside them. Nil when
// git cannot answer, so a reader sees "no list" rather than an empty one that reads as "nothing
// moved".
func movedCommits(dir, from, to string) *IntegrationUpstreamMovedCommits {
	if from == "" || to == "" || from == to {
		return nil
	}
	out, err := git(dir, "log", "--first-parent", "--format=%H%x09%s", from+".."+to)
	if err != nil {
		return nil
	}
	var commits []IntegrationMovedCommit
	total := 0
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		total++
		if len(commits) >= 20 {
			continue
		}
		sha, subject, _ := strings.Cut(line, "\t")
		commits = append(commits, IntegrationMovedCommit{Sha: sha, Subject: clipSubject(subject)})
	}
	if total == 0 {
		return nil
	}
	return &IntegrationUpstreamMovedCommits{Total: total, Commits: commits}
}

// clipSubject cuts a commit subject to the 200 characters the contract carries (J-T4).
func clipSubject(subject string) string {
	runes := []rune(strings.TrimSpace(subject))
	if len(runes) > 200 {
		return string(runes[:200])
	}
	return string(runes)
}

// refreshedUpstreamTip reads the target ref again after a refused push, so the result can name what
// moved it. Best effort: an empty answer means git could not tell, and the result carries no list.
func refreshedUpstreamTip(repoRoot, remote, ref string, local bool) string {
	if !local {
		_ = integrationFetch(repoRoot, remote, ref)
	}
	tip, _ := integrationTip(repoRoot, remote, ref, local)
	return tip
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
// The report is the only thing that matters here, so it is retried — with capped backoff, for as long
// as this process lives, and over a copy on disk that survives it — until the control plane takes it
// or refuses it for good (integration_result_spool.go). A job that did the work and could not say so
// would be re-claimed after its lease expired and would do the whole thing again, including an hour of
// checks; and one the control plane cannot be told about at all is held RUNNING by it for a lease
// owner that never comes back.
//
// stop is when the runner's shutdown stops waiting for the job (runloop.go): the work stops
// (runIntegrationJobUntil), and so do the sends of a report, which then stays spooled for the next
// start rather than pretending the send was the last word. A job stopped before its push is handed
// back instead of answered, with sends bounded by handBack, which outlives stop.
func runIntegrationJobAndReport(stop, handBack context.Context, t *Transport, job IntegrationJobCommand) {
	logln("integration job", job.JobID, job.Kind, job.SourceRef, "->", job.TargetRef)
	// A v2 claim's reports go through one sender that carries the claim fence and reads the answer
	// (§2.2 J-T4); a legacy claim's phase reports stay exactly as they were — best effort, and the
	// answer discarded.
	var sender integrationProgressSender
	if job.ReportBeforePush {
		sender = func(ctx context.Context, req IntegrationJobProgressRequest) (*IntegrationJobProgressResponse, error) {
			req.ClaimGeneration = job.ClaimGeneration
			req.LeaseOwner = job.LeaseOwner
			return t.integrationJobProgress(ctx, job.JobID, req)
		}
		// The output stream is v2's too (§2.2 J-T4, §2.9 LS2): chunks carry the same claim fence and
		// are redacted of this machine's own secrets before they leave it. A legacy claim gets
		// neither, and keeps the 16 KB result tail it always had.
		job.outputRedactor = newIntegrationOutputRedactor(t.token)
		job.outputSender = func(ctx context.Context, req IntegrationJobOutputRequest) error {
			req.ClaimGeneration = job.ClaimGeneration
			req.LeaseOwner = job.LeaseOwner
			return t.integrationJobOutput(ctx, job.JobID, req)
		}
	}
	result := runIntegrationJobUntilWithProgress(stop, job, func(phase string, moved *IntegrationUpstreamMoved) {
		// Best effort: the lease renewal matters, the phase is for a reader, and the work carries
		// on either way. The one report that is more than a phase is `upstreamMoved` — the control
		// plane moves the promotion to RECHECKING on it (§3.3 M-T7) — and it is best effort too:
		// the result that follows carries the upstream this job actually merged onto regardless.
		_, _ = t.integrationJobProgress(stop, job.JobID, IntegrationJobProgressRequest{
			ClaimGeneration: job.ClaimGeneration,
			LeaseOwner:      job.LeaseOwner,
			Phase:           phase,
			UpstreamMoved:   moved,
		})
	}, sender)
	if result.Interrupted {
		logln("integration job", job.JobID, "stopped in", result.Phase,
			"because this runner is stopping; nothing was pushed and its worktree is gone, so it is handed back to be run again")
		handBackIntegrationJob(handBack, t, job)
		return
	}
	if result.Stopped {
		// §2.2 J-T4: a 409 STALE_CLAIM / ALREADY_FINAL or a 404 means the claim is not this
		// process's any more. Nothing was pushed, and there is nobody left to report to.
		logln("integration job", job.JobID, "stopped in", result.Phase,
			"because its claim is no longer this process's; nothing was pushed and nothing is reported")
		return
	}
	body := IntegrationJobResultRequest{
		ClaimGeneration:      job.ClaimGeneration,
		LeaseOwner:           job.LeaseOwner,
		State:                result.State,
		Phase:                result.Phase,
		SourceSha:            result.SourceSha,
		TargetShaBefore:      result.TargetShaBefore,
		UpstreamSha:          result.UpstreamSha,
		MainSyncSha:          result.MainSyncSha,
		TestedSha:            result.TestedSha,
		TestedTreeSha:        result.TestedTreeSha,
		LandedSha:            result.LandedSha,
		LandedTreeSha:        result.LandedTreeSha,
		AheadOfUpstream:      result.AheadOfUpstream,
		SourceOnUpstream:     result.SourceOnUpstream,
		SourceFullyApplied:   result.SourceFullyApplied,
		FilesChanged:         result.FilesChanged,
		Checks:               result.Checks,
		Conflicts:            result.Conflicts,
		ErrorCode:            result.ErrorCode,
		ErrorDetail:          result.ErrorDetail,
		UpstreamMovedCommits: result.UpstreamMovedCommits,
		UnknownPushes:        result.UnknownPushes,
	}
	deliverIntegrationResult(stop, t, job.JobID, body)
}

// handBackIntegrationJob gives a claimed job back to the control plane (contract §2.2 J-T11), for a
// job this process will not finish and has pushed nothing for: one handed to it after its stop began,
// or one it stopped before the push (runIntegrationJobUntil). The control plane puts it back in the
// queue for the next heartbeat that asks for work — this runner's next process, since a job runs
// where its workspace is — instead of holding it RUNNING until the lease runs out ten minutes after
// its last report, which is what a runner that stopped without a word costs.
//
// Tried until the control plane answers or ctx ends. A refusal ends it too: 409 says the claim had
// already moved on or the job was already written down, and 404 is a job this runner cannot see or a
// control plane too old to take one back; either way the lease hands the job on as it always did.
func handBackIntegrationJob(ctx context.Context, t *Transport, job IntegrationJobCommand) {
	body := IntegrationJobReleaseRequest{ClaimGeneration: job.ClaimGeneration, LeaseOwner: job.LeaseOwner}
	for attempt := 1; ; attempt++ {
		answer, err := t.integrationJobRelease(ctx, job.JobID, body)
		switch {
		case err == nil && answer.Released:
			logln("integration job", job.JobID, "handed back; the next heartbeat that asks for work is handed it again")
			return
		case err == nil:
			logln("integration job", job.JobID, "was not handed back: it ended", answer.State)
			return
		case !integrationResultWorthSendingAgain(err):
			logln("integration job", job.JobID, "could not be handed back, so its lease hands it on when it runs out:", err)
			return
		case ctx.Err() != nil:
			logln("integration job", job.JobID, "was not handed back before this runner stopped, so its lease hands it on when it runs out:", err)
			return
		}
		wait := integrationResultRetry.wait(attempt)
		logln("integration job", job.JobID, fmt.Sprintf("hand-back not delivered on attempt %d:", attempt), err,
			"trying again in", wait.Round(100*time.Millisecond))
		integrationResultRetry.sleep(ctx, wait)
	}
}
