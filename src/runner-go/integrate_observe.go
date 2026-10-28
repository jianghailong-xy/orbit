package main

import (
	"context"
	"errors"
	"os/exec"
	"strings"
)

// observeLanding is one OBSERVE_LANDING job (docs/project-integration-line-contract.md §10.6, steps
// O-S1 to O-S3): fetch the integration line and its upstream, then say, for every task the claim
// names, whether the commit its work was delivered as is on either of them.
//
// Whether a commit is on a line is a fact git already holds — `merge-base --is-ancestor` answers it
// (O2) — so this job only reads. It stages no worktree, runs no check and pushes nothing, which is why
// it has no round to go back for and no PUSH boundary to ask at. What it answers is measured on the
// tips its own fetch brought, so a commit an agent pushed from another machine is seen here as well.
//
// stop is the job's context (runIntegrationJobUntilWithProgress): it is consulted before each step,
// so a cancellation or a lost claim read off a progress answer ends the job at the next one.
func observeLanding(stop context.Context, cmd IntegrationJobCommand, repoRoot string, report integrationReporter) integrationResult {
	remote := cmd.RemoteName
	if remote == "" {
		remote = "origin"
	}
	local := cmd.RefAuthority == "RUNNER_LOCAL"
	// The line is a branch of its own only on a PROJECT_BRANCH line. On a MAIN line it IS the
	// upstream, T = U, and onIntegrationLine has no second answer to give: it stays null (§10.4).
	projectBranch := cmd.TargetRef != cmd.UpstreamRef

	// ── O-S1 FETCH ────────────────────────────────────────────────────────────────────────────
	report("FETCH", nil)
	if stop.Err() != nil {
		return integrationStoppedResult(stop, "FETCH")
	}
	lineOnRemote := true
	if !local {
		if err := integrationFetch(repoRoot, remote, cmd.UpstreamRef); err != nil {
			code := "FETCH_FAILED"
			if remoteLacksRef(repoRoot, remote, cmd.UpstreamRef, err) {
				code = "BASE_REF_NOT_FOUND"
			}
			return errorResult("FETCH", code, map[string]any{"ref": cmd.UpstreamRef, "detail": gitStderr(err)})
		}
		if projectBranch {
			if err := integrationFetch(repoRoot, remote, cmd.TargetRef); err != nil {
				// A project branch nothing has landed on yet is not on the remote, and the line then
				// starts where the upstream is, as a landing's own FETCH reads it (J-S1). Any other
				// failure leaves T unknown, and a stale copy of it is not an answer.
				if !remoteLacksRef(repoRoot, remote, cmd.TargetRef, err) {
					return errorResult("FETCH", "FETCH_FAILED", map[string]any{"ref": cmd.TargetRef, "detail": gitStderr(err)})
				}
				lineOnRemote = false
			}
		}
	}
	upstreamSha, err := integrationTip(repoRoot, remote, cmd.UpstreamRef, local)
	if err != nil || upstreamSha == "" {
		return errorResult("FETCH", "BASE_REF_NOT_FOUND", map[string]any{
			"ref": cmd.UpstreamRef, "detail": errText(err),
		})
	}
	lineSha := upstreamSha
	if projectBranch && lineOnRemote {
		if tip, _ := integrationTip(repoRoot, remote, cmd.TargetRef, local); tip != "" {
			lineSha = tip
		}
	}

	// ── O-S2 OBSERVE ──────────────────────────────────────────────────────────────────────────
	report("OBSERVE", nil)
	observations := make([]IntegrationObservation, 0, len(cmd.ObserveTasks))
	for _, task := range cmd.ObserveTasks {
		if stop.Err() != nil {
			return integrationStoppedResult(stop, "OBSERVE")
		}
		observations = append(observations, observeTask(repoRoot, task, upstreamSha, lineSha, projectBranch))
	}
	if stop.Err() != nil {
		return integrationStoppedResult(stop, "OBSERVE")
	}

	// O-S3 REPORT is runIntegrationJobAndReport's, as it is for every job.
	return integrationResult{
		State: "OBSERVED", Phase: "OBSERVE",
		UpstreamSha: upstreamSha, TargetShaBefore: lineSha,
		Observations: observations,
	}
}

// observeTask is O-S2 for one task, measured on the tips this job fetched.
//
// A commit this machine does not have is no ancestor of either tip: whatever is on the line came down
// with the fetch, so the commit would have come with it. isAncestor's "cannot tell" is therefore the
// right answer here, and it is false — work that is on no line may well exist only on the machine
// that made it.
func observeTask(repoRoot string, task IntegrationObserveTask, upstreamSha, lineSha string, projectBranch bool) IntegrationObservation {
	delivered := task.DeliveredSha
	named := objectIDPattern.MatchString(delivered)
	observation := IntegrationObservation{
		TaskID:       task.TaskID,
		DeliveredSha: task.DeliveredSha,
		Empty:        named && delivered == task.BaseSha,
		OnUpstream:   named && isAncestor(repoRoot, delivered, upstreamSha),
	}
	if task.BaseSha != "" {
		base := task.BaseSha
		observation.BaseSha = &base
	}
	if projectBranch {
		onLine := named && isAncestor(repoRoot, delivered, lineSha)
		observation.OnIntegrationLine = &onLine
	}
	observation.FullyApplied = observedFullyApplied(repoRoot, upstreamSha, delivered, task.BaseSha, observation.Empty)
	return observation
}

// observedFullyApplied is `git cherry U delivered base` read as O-S2 reads it: true when the change
// of every commit in base..delivered is in U — every line starts with "-", or there is no line because
// U holds those commits themselves — and false when one is not. Null when this machine does not have
// base..delivered: that is the one answer of an observation that depends on where it ran.
//
// An empty branch carried no commit of its own, so nothing of it was applied anywhere: false, the way
// J-S3 answers the same branch (0410), rather than the "every line" of a list with no line in it.
func observedFullyApplied(repoRoot, upstreamSha, delivered, base string, empty bool) *bool {
	if empty {
		applied := false
		return &applied
	}
	if !objectIDPattern.MatchString(delivered) || !objectIDPattern.MatchString(base) {
		return nil
	}
	// git refuses a commit this machine does not have, and that refusal is the null.
	out, err := git(repoRoot, "cherry", upstreamSha, delivered, base)
	if err != nil {
		return nil
	}
	applied := true
	for _, line := range strings.Split(out, "\n") {
		if line = strings.TrimSpace(line); line != "" && !strings.HasPrefix(line, "-") {
			applied = false
		}
	}
	return &applied
}

// remoteLacksRef reports a fetch that failed because the remote answered and has no such ref (O-S1:
// the one failure that is a statement about the branch), rather than because the remote could not be
// reached or another process held a ref lock past this fetch's retries (FETCH_FAILED). It asks the
// remote with `ls-remote --exit-code`, whose exit 2 is git's own "no matching ref", instead of reading
// the fetch's message, which git translates.
func remoteLacksRef(repoRoot, remote, ref string, fetchErr error) bool {
	if isRefLockConflict(fetchErr) {
		return false
	}
	err := exec.Command("git", "-C", repoRoot, "ls-remote", "--exit-code", remote, ref).Run()
	var exit *exec.ExitError
	return errors.As(err, &exit) && exit.ExitCode() == 2
}

// integrationLockRef is the ref half of the key a job takes integrationLock under. A job that writes
// a ref is keyed by it, which is what keeps two of this process's jobs from moving it at once. An
// observation writes none, and J1 serialises it apart from every branch's slot (`#observe:`, §10.4),
// so it is keyed apart here too: it never waits behind a landing's hour of checks for a lock that
// guards nothing it does.
func integrationLockRef(cmd IntegrationJobCommand) string {
	if cmd.Kind == "OBSERVE_LANDING" {
		return "#observe:" + cmd.TargetRef
	}
	return cmd.TargetRef
}
