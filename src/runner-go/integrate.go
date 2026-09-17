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
	Checks          []IntegrationCheckResult
	Conflicts       []string
	ErrorCode       string
	ErrorDetail     map[string]any
}

// integrationReporter is what runIntegrationJob tells about each step it reaches. The runloop
// passes one that POSTs; a test passes one that records.
type integrationReporter func(phase string)

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
	repoRoot, err := git(cmd.WorkDir, "rev-parse", "--show-toplevel")
	if err != nil || repoRoot == "" {
		return errorResult("FETCH", "FETCH_FAILED", map[string]any{
			"detail": fmt.Sprintf("%s is not a git checkout: %v", cmd.WorkDir, err),
		})
	}
	lock := integrationLock(repoRoot, cmd.TargetRef)
	lock.Lock()
	defer lock.Unlock()

	scratch := filepath.Join(filepath.Dir(cmd.WorkDir), integrateScratchPrefix+cmd.JobID)
	defer removeIntegrationWorktree(repoRoot, scratch)

	var last integrationResult
	for round := 0; round <= integrationRefetchRounds; round++ {
		removeIntegrationWorktree(repoRoot, scratch)
		last = integrateOnce(cmd, repoRoot, scratch, report)
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
	report("FETCH")
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
		report("MAIN_SYNC")
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
		report("MERGE")
		merged, conflicts, err := integrationMerge(scratch, sourceSha,
			fmt.Sprintf("Merge %s into %s", cmd.SourceRef, cmd.TargetRef))
		if err != nil {
			result.State, result.Phase, result.Conflicts = "CONFLICT", "MERGE", conflicts
			return result
		}
		tested = merged
	} else {
		report("REBASE")
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
		report("CHECK")
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
	report("PUSH")
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
	report("VERIFY")
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
	result := runIntegrationJob(job, func(phase string) {
		// Best effort: the lease renewal matters, the phase is for a reader, and the work carries
		// on either way.
		_ = t.integrationJobProgress(job.JobID, IntegrationJobProgressRequest{
			ClaimGeneration: job.ClaimGeneration,
			LeaseOwner:      job.LeaseOwner,
			Phase:           phase,
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
