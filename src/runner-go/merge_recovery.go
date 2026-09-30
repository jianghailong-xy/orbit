package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Retained repair checkouts are not disposable session checkouts, including under disk pressure.
const mergeRecoveryWorktreePrefix = "recovery-"

// Preview artifacts are real branches/worktrees. They survive a failed push or a conflict so
// a coding session can repair them without ever touching the shared target or source branch.
type MergeRecovery struct {
	Code             string                `json:"code"`
	TargetBranch     string                `json:"targetBranch"`
	RepoRoot         string                `json:"repoRoot,omitempty"`
	PreviewID        string                `json:"previewId,omitempty"`
	SourceSha        string                `json:"sourceSha,omitempty"`
	LocalSha         string                `json:"localSha,omitempty"`
	RemoteSha        string                `json:"remoteSha,omitempty"`
	CandidateSha     string                `json:"candidateSha,omitempty"`
	CandidateTreeSha string                `json:"candidateTreeSha,omitempty"`
	RebaseBaseSha    string                `json:"rebaseBaseSha,omitempty"`
	RepairBranch     string                `json:"repairBranch,omitempty"`
	RepairWorktree   string                `json:"repairWorktree,omitempty"`
	Phase            string                `json:"phase,omitempty"`
	Conflicts        []string              `json:"conflicts,omitempty"`
	LocalCommits     []MergeRecoveryCommit `json:"localCommits,omitempty"`
	RemoteCommits    []MergeRecoveryCommit `json:"remoteCommits,omitempty"`
	Patch            string                `json:"patch"`
	AddsMergeCommit  bool                  `json:"addsMergeCommit,omitempty"`
	CheckedAt        string                `json:"checkedAt,omitempty"`
	Check            *MergeRecoveryCheck   `json:"check,omitempty"`
}
type MergeRecoveryCommit struct {
	Sha     string `json:"sha"`
	Subject string `json:"subject"`
	Author  string `json:"author"`
	Date    string `json:"date"`
}
type MergeRecoveryCheck struct {
	Status         string `json:"status"`
	Output         string `json:"output,omitempty"`
	Command        string `json:"command,omitempty"`
	TimeoutSeconds int    `json:"timeoutSeconds,omitempty"`
}
type MergeRecoveryCheckSpec struct {
	Command        string `json:"command"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
}

func recoveryError(r *MergeRecovery, code, message string) mergeOutcome {
	r.Code = code
	// Escaped diff/commit text can exceed the API envelope limit even below the raw diff cap.
	// Leave room for later outcome codes, and retain the candidate/location without a partial diff.
	if payload, _ := json.Marshal(r); len(payload) > 1_180_000 {
		r.Code, r.Patch = "PREVIEW_TOO_LARGE", ""
		r.LocalCommits, r.RemoteCommits, r.Conflicts, r.Check = nil, nil, nil, nil
		message = "preview details are too large to review inline; inspect the saved histories or repair worktree"
	}
	return mergeOutcome{Status: "error", SourceSha: r.SourceSha, TargetBranch: r.TargetBranch,
		TargetShaBefore: r.LocalSha, Message: message, Recovery: r, Conflicts: r.Conflicts}
}

// Called under mergeLock, the same lock shared with cleanup and integration ref writes.
func recoverMerge(req MergeCommand) mergeOutcome {
	root, err := git(expandTilde(req.WorkDir), "rev-parse", "--show-toplevel")
	target := req.TargetBranch
	if target == "" && req.Recovery != nil {
		target = req.Recovery.TargetBranch
	}
	if target == "" {
		for _, name := range []string{"main", "master"} {
			if branchExists(root, name) {
				target = name
				break
			}
		}
	}
	r := &MergeRecovery{TargetBranch: target, RepoRoot: root}
	if err != nil || root == "" || target == "" {
		return recoveryError(r, "REPOSITORY_UNAVAILABLE", "could not locate the target repository")
	}
	if _, err := git(root, "check-ref-format", "refs/heads/"+target); err != nil || target == req.Branch {
		return recoveryError(r, "INVALID_TARGET", "invalid merge target")
	}
	if req.RecoveryAction == "apply" || req.RecoveryAction == "sync-local" {
		return applyMergeRecovery(root, req)
	}
	if req.RecoveryAction != "preview" {
		return recoveryError(r, "INVALID_ACTION", "unsupported recovery action")
	}
	r.SourceSha, err = git(root, "rev-parse", "--verify", "refs/heads/"+req.Branch)
	if err != nil {
		return recoveryError(r, "SOURCE_UNAVAILABLE", "source branch is unavailable")
	}
	if req.RequiredSourceSha != "" && req.RequiredSourceSha != r.SourceSha {
		return recoveryError(r, "BRANCH_TIP_MISMATCH", "source has moved beyond its verified checkpoint")
	}
	r.LocalSha, err = git(root, "rev-parse", "--verify", "refs/heads/"+target)
	if err != nil {
		return recoveryError(r, "TARGET_UNAVAILABLE", "local target is unavailable")
	}
	r.RemoteSha, err = recoveryRemoteTip(root, target)
	if err != nil {
		return recoveryError(r, "FETCH_FAILED", "could not check origin/"+target+": "+gitStderr(err))
	}
	if _, err := git(root, "merge-base", r.LocalSha, r.RemoteSha); err != nil {
		return recoveryError(r, "UNRELATED_HISTORY", "the target histories have no verified common ancestor")
	}
	r.CheckedAt = time.Now().UTC().Format(time.RFC3339)
	r.LocalCommits, err = recoveryCommits(root, r.RemoteSha, r.LocalSha)
	if err != nil {
		return recoveryError(r, "PREVIEW_TOO_LARGE", err.Error())
	}
	r.RemoteCommits, err = recoveryCommits(root, r.LocalSha, r.RemoteSha)
	if err != nil {
		return recoveryError(r, "PREVIEW_TOO_LARGE", err.Error())
	}
	r.AddsMergeCommit = !targetContainsSource(root, r.LocalSha, r.RemoteSha) && !targetContainsSource(root, r.RemoteSha, r.LocalSha)

	// Every completed check gets a new approval identity, even when it reuses a repair branch.
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return recoveryError(r, "PREVIEW_FAILED", err.Error())
	}
	r.PreviewID = hex.EncodeToString(nonce)
	// Recheck repairs and check failures without discarding their private work. Shared refs
	// must still match, and the saved checkout must really belong to our recovery branch.
	prior := req.Recovery
	repaired := prior != nil && prior.RepoRoot == root && prior.SourceSha == r.SourceSha && prior.LocalSha == r.LocalSha && prior.RemoteSha == r.RemoteSha &&
		strings.HasPrefix(prior.RepairBranch, "orbit/recovery/") && prior.RepairWorktree != "" && branchWorktree(root, prior.RepairBranch) == prior.RepairWorktree
	if repaired {
		r.RepairBranch, r.RepairWorktree, r.Phase = prior.RepairBranch, prior.RepairWorktree, prior.Phase
		r.RebaseBaseSha = prior.RebaseBaseSha
		if state := inspectRepoRoot(r.RepairWorktree); state.State != repoStateClean {
			return recoveryError(r, "REPAIR_IN_PROGRESS", "finish and commit the repair before checking again")
		}
		tip, e := git(root, "rev-parse", "--verify", "refs/heads/"+prior.RepairBranch)
		repaired = e == nil && targetContainsSource(root, r.LocalSha, tip) && targetContainsSource(root, r.RemoteSha, tip)
	}
	if !repaired {
		r.Phase = "TARGET_SYNC"
		r.RepairBranch = "orbit/recovery/" + r.PreviewID
		r.RepairWorktree = filepath.Join(worktreesDir(), mergeRecoveryWorktreePrefix+r.PreviewID)
		if err := os.MkdirAll(worktreesDir(), 0700); err != nil {
			return recoveryError(r, "PREVIEW_FAILED", err.Error())
		}
		if _, err := git(root, "worktree", "add", "-b", r.RepairBranch, r.RepairWorktree, r.LocalSha); err != nil {
			return recoveryError(r, "PREVIEW_FAILED", gitStderr(err))
		}
		if canonical, err := filepath.EvalSymlinks(r.RepairWorktree); err == nil {
			r.RepairWorktree = canonical
		}
		ff, _ := git(root, "config", "--get", "merge.ff")
		if ff == "only" && r.AddsMergeCommit {
			return recoveryError(r, "LINEAR_HISTORY_REQUIRED", "merge.ff=only disallows this target-history merge; prepare a separate PR candidate")
		}
		if _, err := git(r.RepairWorktree, "-c", "user.name=Orbit Runner", "-c", "user.email=runner@orbit", "merge", "--ff", "--no-edit", r.RemoteSha); err != nil {
			return recoveryConflict(r, "TARGET_SYNC", err)
		}
	}
	if state := inspectRepoRoot(r.RepairWorktree); state.State != repoStateClean {
		return recoveryError(r, "REPAIR_IN_PROGRESS", "finish and commit the repair before checking again")
	}
	syncSha, _ := git(r.RepairWorktree, "rev-parse", "HEAD")
	if !(repaired && prior.Phase == "SOURCE_REPLAY") && !targetContainsSource(root, r.SourceSha, syncSha) {
		r.RebaseBaseSha = syncSha
		// Move only our private branch to the source before replay. The source itself stays put.
		if _, err := git(r.RepairWorktree, "reset", "--hard", r.SourceSha); err != nil {
			return recoveryError(r, "PREVIEW_FAILED", gitStderr(err))
		}
		args := []string{"-c", "user.name=Orbit Runner", "-c", "user.email=runner@orbit", "rebase"}
		if anchor := replayAnchor(root, req.SessionID, r.SourceSha, req.BaseSha); anchor != "" {
			args = append(args, "--onto", syncSha, anchor)
		} else {
			args = append(args, syncSha)
		}
		if _, err := git(r.RepairWorktree, args...); err != nil {
			return recoveryConflict(r, "SOURCE_REPLAY", err)
		}
	}
	r.Phase = "SOURCE_REPLAY"
	r.CandidateSha, err = git(r.RepairWorktree, "rev-parse", "HEAD")
	if err != nil {
		return recoveryError(r, "PREVIEW_FAILED", gitStderr(err))
	}
	r.CandidateTreeSha, _ = git(root, "rev-parse", r.CandidateSha+"^{tree}")
	r.Patch, err = git(root, "diff", "--no-ext-diff", "--binary", r.RemoteSha, r.CandidateSha, "--")
	if err != nil {
		return recoveryError(r, "PREVIEW_FAILED", gitStderr(err))
	}
	if len(r.Patch) > 1024*1024 {
		r.Patch = ""
		return recoveryError(r, "PREVIEW_TOO_LARGE", "candidate diff is too large to review inline; inspect the saved repair branch")
	}
	r.Check = &MergeRecoveryCheck{Status: "unconfigured"}
	if req.Check != nil && req.Check.Command != "" {
		check := runIntegrationCheck(r.RepairWorktree, IntegrationCheckSpec{Name: "merge", Command: req.Check.Command, TimeoutSeconds: req.Check.TimeoutSeconds, ExpectedExitCode: 0})
		r.Check = &MergeRecoveryCheck{Status: "passed", Output: check.OutputTail, Command: req.Check.Command, TimeoutSeconds: req.Check.TimeoutSeconds}
		if check.ExitCode == nil || *check.ExitCode != 0 || check.TimedOut {
			r.Check.Status = "failed"
			return recoveryError(r, "CHECK_FAILED", "the configured merge check failed")
		}
		if tree, _ := git(r.RepairWorktree, "rev-parse", "HEAD^{tree}"); tree != r.CandidateTreeSha || inspectRepoRoot(r.RepairWorktree).State != repoStateClean {
			return recoveryError(r, "CHECK_CHANGED_CONTENT", "the check changed candidate content; inspect it before continuing")
		}
	}
	return recoveryError(r, "READY", "review the extra local commits and complete candidate diff before syncing and merging")
}

func recoveryRemoteTip(root, target string) (string, error) {
	if _, err := git(root, "fetch", "origin", "refs/heads/"+target+":refs/remotes/origin/"+target); err != nil {
		return "", err
	}
	return git(root, "rev-parse", "--verify", "refs/remotes/origin/"+target)
}

func recoveryCommits(root, base, tip string) ([]MergeRecoveryCommit, error) {
	out, err := git(root, "log", "--format=%H%x1f%s%x1f%an%x1f%aI", base+".."+tip, "--")
	if err != nil {
		return nil, err
	}
	lines := splitLines(out)
	if len(lines) > 200 {
		return nil, fmt.Errorf("more than 200 unique commits; inspect the saved histories before merging")
	}
	commits := make([]MergeRecoveryCommit, 0, len(lines))
	for _, line := range lines {
		fields := strings.Split(line, "\x1f")
		if len(fields) != 4 {
			return nil, fmt.Errorf("could not read commit details")
		}
		commits = append(commits, MergeRecoveryCommit{fields[0], fields[1], fields[2], fields[3]})
	}
	return commits, nil
}

func recoveryConflict(r *MergeRecovery, phase string, err error) mergeOutcome {
	r.Phase = phase
	paths, _ := git(r.RepairWorktree, "diff", "--name-only", "--diff-filter=U")
	r.Conflicts = splitLines(paths)
	if len(r.Conflicts) == 0 {
		return recoveryError(r, "PREVIEW_FAILED", gitStderr(err))
	}
	return recoveryError(r, "CONFLICT", "resolve the "+phase+" conflict in the saved repair worktree")
}

func applyMergeRecovery(root string, req MergeCommand) mergeOutcome {
	if req.Recovery == nil {
		return recoveryError(&MergeRecovery{TargetBranch: req.TargetBranch}, "PREVIEW_REQUIRED", "check and review a candidate first")
	}
	copy := *req.Recovery
	r := &copy
	if r.TargetBranch != req.TargetBranch && req.TargetBranch != "" {
		return recoveryError(r, "PREVIEW_CHANGED", "the target differs from the reviewed candidate")
	}
	if r.RepoRoot != root || !recoverySHA(r.CandidateSha) || !recoverySHA(r.SourceSha) || !recoverySHA(r.LocalSha) || !recoverySHA(r.RemoteSha) || !recoverySHA(r.CandidateTreeSha) || r.PreviewID == "" {
		return recoveryError(r, "PREVIEW_REQUIRED", "the candidate is incomplete; check again")
	}
	if req.RecoveryAction == "apply" && r.Code != "READY" && r.Code != "LOCAL_SYNC_PENDING" {
		return recoveryError(r, "PREVIEW_REQUIRED", "only a reviewed ready candidate can be applied")
	}
	if req.RecoveryAction == "sync-local" && r.Code != "LOCAL_SYNC_PENDING" {
		return recoveryError(r, "PREVIEW_REQUIRED", "there is no landed candidate waiting for local sync")
	}
	tree, err := git(root, "rev-parse", "--verify", r.CandidateSha+"^{tree}")
	if err != nil || tree != r.CandidateTreeSha {
		return recoveryError(r, "PREVIEW_CHANGED", "the candidate content no longer matches its preview")
	}
	if !targetContainsSource(root, r.LocalSha, r.CandidateSha) || !targetContainsSource(root, r.RemoteSha, r.CandidateSha) {
		return recoveryError(r, "PREVIEW_CHANGED", "candidate must preserve both target histories")
	}
	if r.RebaseBaseSha != "" && (!recoverySHA(r.RebaseBaseSha) || !targetContainsSource(root, r.RebaseBaseSha, r.CandidateSha)) {
		return recoveryError(r, "PREVIEW_CHANGED", "candidate no longer contains its verified replay base")
	}
	remote, err := recoveryRemoteTip(root, r.TargetBranch)
	if err != nil {
		if req.RecoveryAction == "sync-local" {
			return recoveryError(r, "LOCAL_SYNC_PENDING", "could not verify the remote for local sync; retry after restoring the connection: "+gitStderr(err))
		}
		return recoveryError(r, "REMOTE_NOT_VERIFIED", "could not verify the remote; retry the reviewed candidate to check its actual state")
	}
	// Readback comes before replay or source checks: a lost push response/restart must recover
	// a landing that already happened, even if the session has since gained another commit.
	landed := targetContainsSource(root, r.CandidateSha, remote)
	local, _ := git(root, "rev-parse", "refs/heads/"+r.TargetBranch)
	if !landed {
		if req.RecoveryAction == "sync-local" {
			return recoveryError(r, "LOCAL_SYNC_PENDING", "the remote no longer contains the previously landed candidate; inspect the remote before syncing")
		}
		source, _ := git(root, "rev-parse", "refs/heads/"+req.Branch)
		if source != r.SourceSha || local != r.LocalSha || remote != r.RemoteSha {
			return recoveryError(r, "PREVIEW_CHANGED", "a branch changed since preview; check again")
		}
		if req.RequiredSourceSha != "" && req.RequiredSourceSha != r.SourceSha {
			return recoveryError(r, "BRANCH_TIP_MISMATCH", "the candidate source differs from the verified checkpoint")
		}
		command, timeout := "", 0
		if req.Check != nil {
			command, timeout = req.Check.Command, req.Check.TimeoutSeconds
		}
		if r.Check == nil || r.Check.Status == "failed" || command != r.Check.Command || timeout != r.Check.TimeoutSeconds {
			return recoveryError(r, "PREVIEW_CHANGED", "merge check configuration changed since preview; check again")
		}
		if err := recoveryLocalReady(root, r.TargetBranch, r.CandidateSha); err != nil {
			return recoveryError(r, "LOCAL_CHECKOUT_BLOCKED", err.Error())
		}
		if _, err := git(root, "push", "origin", r.CandidateSha+":refs/heads/"+r.TargetBranch); err != nil {
			// A transport error may mean the push succeeded. Decide by reading the remote.
			remote, readErr := recoveryRemoteTip(root, r.TargetBranch)
			if readErr != nil || !targetContainsSource(root, r.CandidateSha, remote) {
				return recoveryError(r, "PUSH_FAILED", "could not confirm target push; the candidate is saved for retry or PR: "+gitStderr(err))
			}
		}
		remote, err = recoveryRemoteTip(root, r.TargetBranch)
		if err != nil || !targetContainsSource(root, r.CandidateSha, remote) {
			return recoveryError(r, "REMOTE_NOT_VERIFIED", "push sent; could not verify remote landing — check again before retrying")
		}
	}
	// ALREADY_MERGED specifically proves ancestry of the original source. A recovered push
	// of its rebased candidate is still MERGED when that original SHA is not an ancestor.
	r.Code = "DONE"
	out := mergeOutcome{Status: "merged", SourceSha: r.SourceSha, TargetBranch: r.TargetBranch, TargetShaBefore: r.RemoteSha, MergedSha: r.CandidateSha, RebaseBase: r.RebaseBaseSha,
		AlreadyMerged: landed && targetContainsSource(root, r.SourceSha, remote), Recovery: r}
	if landed {
		out.TargetShaBefore, out.MergedSha = remote, remote
		if out.AlreadyMerged {
			out.RebaseBase = ""
		}
	}
	if err := recoveryAdvanceLocal(root, r, local); err != nil {
		r.Code = "LOCAL_SYNC_PENDING"
		out.Recovery = r
		out.Message = "landed on origin/" + r.TargetBranch + "; local checkout still needs sync: " + err.Error()
	}
	return out
}

func recoverySHA(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == 20
}

func recoveryLocalReady(root, target, candidate string) error {
	if path := branchWorktree(root, target); path != "" && path != root {
		return fmt.Errorf("%s is checked out at %s; sync it there", target, path)
	}
	current, _ := git(root, "symbolic-ref", "--short", "HEAD")
	if current != target {
		return nil
	}
	if st := inspectRepoRoot(root); st.Blocked() {
		return fmt.Errorf("%s", st.BlockedMessage(target))
	}
	// Git's dry-run read-tree checks tracked edits and untracked path collisions without
	// changing the real index. Unrelated edits continue to be allowed.
	if _, err := git(root, "read-tree", "--dry-run", "-m", "-u", "HEAD", candidate); err != nil {
		return fmt.Errorf("local %s checkout would overwrite existing edits: %s", target, gitStderr(err))
	}
	return nil
}

func recoveryAdvanceLocal(root string, r *MergeRecovery, local string) error {
	if targetContainsSource(root, r.CandidateSha, local) {
		return nil
	}
	if local != r.LocalSha && local != r.RemoteSha {
		return fmt.Errorf("local target changed; preserve its new commits before syncing")
	}
	if err := recoveryLocalReady(root, r.TargetBranch, r.CandidateSha); err != nil {
		return err
	}
	current, _ := git(root, "symbolic-ref", "--short", "HEAD")
	if current == r.TargetBranch {
		_, err := git(root, "merge", "--ff-only", r.CandidateSha)
		return err
	}
	_, err := git(root, "update-ref", "refs/heads/"+r.TargetBranch, r.CandidateSha, local)
	return err
}
