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

// Retained repair checkouts are not disposable session checkouts, including under disk pressure. They
// go when their recovery is done with them (reclaimRecoveryCheckout) or after two weeks untouched
// (gcRecoveryCheckouts), clean and with their branch kept.
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
	// Exactly what the push adds to origin/<target>, newest first. Left out past the commit cap
	// rather than failing the preview: clients then list the local-only commits alone.
	PushCommits []MergeRecoveryCommit `json:"pushCommits,omitempty"`
	// ALREADY_LANDED: every one of the session's own commits is already on origin/<target>, as
	// itself or as a copy with the same patch-id (see landedCommits). Each is listed with the origin
	// commit carrying it, newest first.
	LandedCommits []MergeRecoveryLandedCommit `json:"landedCommits,omitempty"`
}
type MergeRecoveryCommit struct {
	Sha     string `json:"sha"`
	Subject string `json:"subject"`
	Author  string `json:"author"`
	Date    string `json:"date"`
	Merge   bool   `json:"merge,omitempty"`
}

// MergeRecoveryLandedCommit is the commit on origin/<target> that carries the session's commit
// SourceSha. Its Date is the committer date: when it reached origin (see landedCommitDetails).
type MergeRecoveryLandedCommit struct {
	MergeRecoveryCommit
	SourceSha string `json:"sourceSha"`
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
		r.LocalCommits, r.RemoteCommits, r.PushCommits, r.LandedCommits, r.Conflicts, r.Check = nil, nil, nil, nil, nil, nil
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
	prior := req.Recovery
	r.SourceSha, err = git(root, "rev-parse", "--verify", "refs/heads/"+req.Branch)
	if err != nil {
		return stoppedEarly(r, prior, "SOURCE_UNAVAILABLE", "source branch is unavailable")
	}
	if req.RequiredSourceSha != "" && req.RequiredSourceSha != r.SourceSha {
		return stoppedEarly(r, prior, "BRANCH_TIP_MISMATCH", "source has moved beyond its verified checkpoint")
	}
	r.LocalSha, err = git(root, "rev-parse", "--verify", "refs/heads/"+target)
	if err != nil {
		return stoppedEarly(r, prior, "TARGET_UNAVAILABLE", "local target is unavailable")
	}
	r.RemoteSha, err = recoveryRemoteTip(root, target)
	if err != nil {
		return stoppedEarly(r, prior, "FETCH_FAILED", "could not check origin/"+target+": "+gitStderr(err))
	}
	if _, err := git(root, "merge-base", r.LocalSha, r.RemoteSha); err != nil {
		return stoppedEarly(r, prior, "UNRELATED_HISTORY", "the target histories have no verified common ancestor")
	}
	r.CheckedAt = time.Now().UTC().Format(time.RFC3339)
	r.LocalCommits, err = recoveryCommits(root, r.RemoteSha, r.LocalSha)
	if err != nil {
		return stoppedEarly(r, prior, "PREVIEW_TOO_LARGE", err.Error())
	}
	r.RemoteCommits, err = recoveryCommits(root, r.LocalSha, r.RemoteSha)
	if err != nil {
		return stoppedEarly(r, prior, "PREVIEW_TOO_LARGE", err.Error())
	}
	// Asked against origin as just fetched, before any repair checkout exists: a session whose
	// every commit origin already carries has no candidate to build, and the local target's own
	// commits are not its to push. A source origin contains as itself is left to the candidate as
	// before. Partly landed, the replay below leaves the landed commits out.
	anchor := replayAnchor(root, req.SessionID, r.SourceSha, req.BaseSha)
	var landed map[string]bool
	if !targetContainsSource(root, r.SourceSha, r.RemoteSha) {
		landing := landedCommits(root, anchor, r.SourceSha, r.RemoteSha)
		if landing.All {
			// Nothing is left to repair. A repair checkout left unfinished is kept, as anything unclean is.
			reclaimPriorRepair(root, prior, "every commit of this session is already on origin/"+target)
			return alreadyLandedOutcome(root, r, landing.Landed)
		}
		landed = landing.Skip
	}
	r.AddsMergeCommit = !targetContainsSource(root, r.LocalSha, r.RemoteSha) && !targetContainsSource(root, r.RemoteSha, r.LocalSha)

	// Every completed check gets a new approval identity, even when it reuses a repair branch.
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return recoveryError(r, "PREVIEW_FAILED", err.Error())
	}
	r.PreviewID = hex.EncodeToString(nonce)
	ff, _ := git(root, "config", "--get", "merge.ff")
	// Recheck repairs and check failures without discarding their private work, even though the
	// targets move on meanwhile — origin does many times a day. The saved checkout must really
	// belong to our recovery branch. Unfinished there, the repair is reported as it stands; finished,
	// it is carried to the tips just read when carriesRepair allows. Anything else starts over.
	carried := false
	if repairCheckout(root, target, prior) {
		if inspectRepoRoot(prior.RepairWorktree).State != repoStateClean {
			return unfinishedRepair(r, prior)
		}
		carried = carriesRepair(root, r, prior, ff == "only")
	}
	if carried {
		r.RepairBranch, r.RepairWorktree, r.Phase = prior.RepairBranch, prior.RepairWorktree, prior.Phase
		r.RebaseBaseSha = prior.RebaseBaseSha
		if err := mergeMovedTargets(root, r, prior); err != nil {
			return recoveryConflict(r, "TARGET_SYNC", err)
		}
	} else {
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
		// This checkout supersedes the previous check's, which no check comes back to.
		reclaimPriorRepair(root, prior, "superseded by "+r.RepairWorktree)
		if ff == "only" && r.AddsMergeCommit {
			return recoveryError(r, "LINEAR_HISTORY_REQUIRED", "merge.ff=only disallows this target-history merge; prepare a separate PR candidate")
		}
		// Named for what it joins: this commit is pushed into the target's history, and git's
		// default subject names a raw SHA and our private repair branch.
		if _, err := git(r.RepairWorktree, "merge", "--ff", "--no-edit", "-m", "Merge origin/"+target+" into "+target, r.RemoteSha); err != nil {
			return recoveryConflict(r, "TARGET_SYNC", err)
		}
	}
	if state := inspectRepoRoot(r.RepairWorktree); state.State != repoStateClean {
		r.Conflicts = unresolvedPaths(r.RepairWorktree)
		return recoveryError(r, "REPAIR_IN_PROGRESS", "finish and commit the repair before checking again")
	}
	syncSha, _ := git(r.RepairWorktree, "rev-parse", "HEAD")
	// A carried branch keeps the source replay that already ran on it — the replay its repair
	// resolved, with any moved target merged in on top. Otherwise the source is replayed now.
	if r.RebaseBaseSha == "" || !targetContainsSource(root, r.RebaseBaseSha, syncSha) {
		r.RebaseBaseSha = ""
		if !targetContainsSource(root, r.SourceSha, syncSha) {
			r.RebaseBaseSha = syncSha
			// Move only our private branch to the source before replay. The source itself stays put.
			if _, err := git(r.RepairWorktree, "reset", "--hard", r.SourceSha); err != nil {
				return recoveryError(r, "PREVIEW_FAILED", gitStderr(err))
			}
			if _, err := replaySource(r.RepairWorktree, syncSha, anchor, r.SourceSha, landed); err != nil {
				return recoveryConflict(r, "SOURCE_REPLAY", err)
			}
		}
	}
	r.Phase = "SOURCE_REPLAY"
	r.CandidateSha, err = git(r.RepairWorktree, "rev-parse", "HEAD")
	if err != nil {
		return recoveryError(r, "PREVIEW_FAILED", gitStderr(err))
	}
	r.CandidateTreeSha, _ = git(root, "rev-parse", r.CandidateSha+"^{tree}")
	r.PushCommits, _ = recoveryCommits(root, r.RemoteSha, r.CandidateSha)
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

// recoveryRemoteTip reads origin/<target> as origin has it now. The fetch is forced, as the remote's
// default refspec is: a target rewritten on origin is read as rewritten — a check then starts over,
// and an apply refuses on the changed tip — instead of failing the fetch on every check after it.
func recoveryRemoteTip(root, target string) (string, error) {
	if _, err := git(root, "fetch", "origin", "+refs/heads/"+target+":refs/remotes/origin/"+target); err != nil {
		return "", err
	}
	return git(root, "rev-parse", "--verify", "refs/remotes/origin/"+target)
}

func recoveryCommits(root, base, tip string) ([]MergeRecoveryCommit, error) {
	out, err := git(root, "log", "--format=%H%x1f%P%x1f%s%x1f%an%x1f%aI", base+".."+tip, "--")
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
		if len(fields) != 5 {
			return nil, fmt.Errorf("could not read commit details")
		}
		commits = append(commits, MergeRecoveryCommit{Sha: fields[0], Subject: fields[2], Author: fields[3], Date: fields[4],
			Merge: len(strings.Fields(fields[1])) > 1})
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

// repairCheckout reports whether the previous check's repair is still checked out where it said:
// one of this repository's recovery branches for this target, in its saved checkout. Mid-rebase,
// as a SOURCE_REPLAY conflict leaves it, that checkout's HEAD is detached and git names no branch
// for it; the rebase's own head-name then says whose rebase it is.
func repairCheckout(root, target string, prior *MergeRecovery) bool {
	if prior == nil || prior.RepoRoot != root || prior.TargetBranch != target ||
		!strings.HasPrefix(prior.RepairBranch, "orbit/recovery/") || prior.RepairWorktree == "" {
		return false
	}
	if _, err := os.Stat(prior.RepairWorktree); err != nil {
		return false
	}
	if branchWorktree(root, prior.RepairBranch) == prior.RepairWorktree {
		return true
	}
	if !worktreeRegistered(root, prior.RepairWorktree) {
		return false
	}
	for _, rebase := range []string{"rebase-merge", "rebase-apply"} {
		p, err := git(prior.RepairWorktree, "rev-parse", "--git-path", rebase+"/head-name")
		if err != nil {
			continue
		}
		if !filepath.IsAbs(p) {
			p = filepath.Join(prior.RepairWorktree, p)
		}
		if name, err := os.ReadFile(p); err == nil && strings.TrimSpace(string(name)) == "refs/heads/"+prior.RepairBranch {
			return true
		}
	}
	return false
}

// unfinishedRepair answers a check whose repair checkout is still mid-merge, mid-rebase or holding
// uncommitted edits. Whatever moved since, nothing is created or removed, and the answer is the
// repair as the previous check left it — branch, checkout, phase, and the source and target tips
// it is being synchronized with, which the next check carries it from once it is finished — with
// what is left to resolve there.
func unfinishedRepair(r, prior *MergeRecovery) mergeOutcome {
	held := heldRepair(r, prior)
	held.Conflicts = unresolvedPaths(prior.RepairWorktree)
	return recoveryError(held, "REPAIR_IN_PROGRESS", "finish and commit the repair before checking again")
}

// heldRepair is the previous check's repair as that check left it — branch, checkout, phase, and the
// source and target tips it is being synchronized with, with their histories — answered as this check.
func heldRepair(r, prior *MergeRecovery) *MergeRecovery {
	return &MergeRecovery{TargetBranch: r.TargetBranch, RepoRoot: r.RepoRoot, PreviewID: r.PreviewID, CheckedAt: r.CheckedAt,
		SourceSha: prior.SourceSha, LocalSha: prior.LocalSha, RemoteSha: prior.RemoteSha, RebaseBaseSha: prior.RebaseBaseSha,
		LocalCommits: prior.LocalCommits, RemoteCommits: prior.RemoteCommits, AddsMergeCommit: prior.AddsMergeCommit,
		RepairBranch: prior.RepairBranch, RepairWorktree: prior.RepairWorktree, Phase: prior.Phase}
}

// stoppedEarly answers a check that stopped before it reached the previous check's repair: a source or
// local target it could not read, a source past its checkpoint, a failed fetch, target histories it
// could not join or list. That repair is still the one the next check carries or replaces, so the
// answer keeps it as unfinishedRepair does. An answer naming no repair would have the next check start
// over — a passing fetch failure costing a finished repair — and leave its checkout to nobody.
func stoppedEarly(r, prior *MergeRecovery, code, message string) mergeOutcome {
	if prior != nil && prior.RepoRoot == r.RepoRoot && prior.TargetBranch == r.TargetBranch && prior.RepairBranch != "" && prior.RepairWorktree != "" {
		r = heldRepair(r, prior)
	}
	return recoveryError(r, code, message)
}

// reclaimPriorRepair reclaims the previous check's repair checkout once this check has no use for it.
func reclaimPriorRepair(root string, prior *MergeRecovery, why string) {
	if prior == nil || prior.RepoRoot != root {
		return
	}
	if kept := reclaimRecoveryCheckout(root, prior.RepairBranch, prior.RepairWorktree, why); kept != "" {
		logln("merge recovery: kept repair checkout", prior.RepairWorktree+":", kept)
	}
}

// reclaimRecoveryCheckout removes a repair checkout no check will come back to, keeping its branch, so
// the repair can always be checked out again: `git worktree remove` without --force, then a prune. Only
// a checkout that is plainly a recovery's and holds nothing its branch lacks goes — directly in the
// worktrees root under the recovery- prefix, the checkout of branch, with no operation in progress and
// no changed or untracked file. It answers why it kept one that is there, "" once it is gone; whatever
// it answers, a check goes on as before.
func reclaimRecoveryCheckout(root, branch, dir, why string) (kept string) {
	if dir == "" {
		return ""
	}
	path := filepath.Clean(dir)
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "" // already gone
	}
	if home, err := filepath.EvalSymlinks(worktreesDir()); err != nil || resolved != path || filepath.Dir(path) != home ||
		!strings.HasPrefix(filepath.Base(path), mergeRecoveryWorktreePrefix) {
		return "it is not a repair checkout in " + worktreesDir()
	}
	if !strings.HasPrefix(branch, "orbit/recovery/") || branchWorktree(root, branch) != path {
		return "it is not the checkout of " + branch
	}
	if status, err := git(path, "status", "--porcelain"); err != nil || status != "" || inspectRepoRoot(path).State != repoStateClean {
		return "it holds changes that are not committed"
	}
	if _, err := git(root, "worktree", "remove", path); err != nil {
		return "git worktree remove: " + gitStderr(err)
	}
	_, _ = git(root, "worktree", "prune")
	logln("merge recovery: reclaimed repair checkout", path, "—", why+"; branch", branch, "kept")
	return ""
}

// recoveryCheckoutRetention is how long gcWorktrees leaves a clean repair checkout nobody touches: one
// no check came back to reclaim, its recovery dropped or its runner too old to reclaim it.
const recoveryCheckoutRetention = 14 * 24 * time.Hour

// gcRecoveryCheckouts reclaims the repair checkouts among entries, the worktrees root's, whose directory
// has not changed for recoveryCheckoutRetention, by reclaimRecoveryCheckout's rules: recovery-<id> is
// the checkout of orbit/recovery/<id>, and with anything else checked out, or anything uncommitted in
// it, it stays. Left for the next sweep while a merge holds mergeLock, as a check may be at work in one.
func gcRecoveryCheckouts(root string, entries []os.DirEntry) {
	if !mergeLock.TryLock() {
		return
	}
	defer mergeLock.Unlock()
	home, err := filepath.EvalSymlinks(root)
	if err != nil {
		return
	}
	for _, e := range entries {
		id, ok := strings.CutPrefix(e.Name(), mergeRecoveryWorktreePrefix)
		if !ok || !e.IsDir() {
			continue
		}
		if info, err := e.Info(); err != nil || time.Since(info.ModTime()) < recoveryCheckoutRetention {
			continue
		}
		path := filepath.Join(home, e.Name())
		common, err := git(path, "rev-parse", "--git-common-dir")
		if err != nil || common == "" {
			continue
		}
		if !filepath.IsAbs(common) {
			common = filepath.Join(path, common)
		}
		reclaimRecoveryCheckout(filepath.Dir(common), "orbit/recovery/"+id, path, "untouched for two weeks")
	}
}

// unresolvedPaths is what keeps a repair checkout from being checked: its unmerged files, or, with
// none, the files changed there and not committed — at most repoStatePathCap of those.
func unresolvedPaths(dir string) []string {
	unmerged, _ := git(dir, "diff", "--name-only", "--diff-filter=U")
	if paths := splitLines(unmerged); len(paths) > 0 {
		return paths
	}
	changed, _ := git(dir, "diff", "--name-only", "HEAD")
	paths := splitLines(changed)
	return paths[:min(len(paths), repoStatePathCap)]
}

// carriesRepair answers whether a finished repair is carried to this check instead of redone: it
// repaired this same source, each target only moved forward from the tip it was synchronized with
// (a force push or a reset starts over), and its branch still holds both of those tips. Under
// merge.ff=only, which rules out the merge commits that take moved targets in, only a branch that
// already holds the new tips is carried.
func carriesRepair(root string, r, prior *MergeRecovery, linear bool) bool {
	tip, err := git(root, "rev-parse", "--verify", "refs/heads/"+prior.RepairBranch)
	if err != nil || prior.SourceSha != r.SourceSha {
		return false
	}
	for _, moved := range [][2]string{{prior.LocalSha, r.LocalSha}, {prior.RemoteSha, r.RemoteSha}} {
		before, now := moved[0], moved[1]
		if !targetContainsSource(root, before, now) || !targetContainsSource(root, before, tip) || linear && !targetContainsSource(root, now, tip) {
			return false
		}
	}
	return true
}

// mergeMovedTargets brings a carried repair's branch up to the target tips this check read, in the
// repair checkout: the local target's tip, then origin's, each merged in where the branch lacks it
// (origin's alone when it carries the local one). The branch already holds the tips it was
// repaired against and every resolution made there, so only commits that came since can conflict.
func mergeMovedTargets(root string, r, prior *MergeRecovery) error {
	merges := []struct{ name, tip string }{{"local " + r.TargetBranch, r.LocalSha}, {"origin/" + r.TargetBranch, r.RemoteSha}}
	if targetContainsSource(root, r.LocalSha, r.RemoteSha) {
		merges = merges[1:]
	}
	for _, m := range merges {
		head, _ := git(r.RepairWorktree, "rev-parse", "HEAD")
		if targetContainsSource(root, m.tip, head) {
			continue
		}
		if _, err := git(r.RepairWorktree, "merge", "--ff", "--no-edit", "-m", "Merge "+m.name+" into "+r.TargetBranch, m.tip); err != nil {
			holdMergedTips(root, r, prior)
			return err
		}
	}
	return nil
}

// holdMergedTips makes a carried repair stopped by a failed merge record what its branch holds
// once that merge is dealt with: a target tip it has not taken in — the one whose merge was
// refused, or origin's while the local target's merge is in conflict — stays at the tip the repair
// already held, so the next check carries the repair on from there instead of starting over.
func holdMergedTips(root string, r, prior *MergeRecovery) {
	held := func(tip string) bool {
		for _, ref := range []string{"HEAD", "MERGE_HEAD"} {
			if at, err := git(r.RepairWorktree, "rev-parse", "-q", "--verify", ref); err == nil && targetContainsSource(root, tip, at) {
				return true
			}
		}
		return false
	}
	local, remote := held(r.LocalSha), held(r.RemoteSha)
	if local && remote {
		return
	}
	if !local {
		r.LocalSha = prior.LocalSha
	}
	if !remote {
		r.RemoteSha = prior.RemoteSha
	}
	r.LocalCommits, _ = recoveryCommits(root, r.RemoteSha, r.LocalSha)
	r.RemoteCommits, _ = recoveryCommits(root, r.LocalSha, r.RemoteSha)
	r.AddsMergeCommit = !targetContainsSource(root, r.LocalSha, r.RemoteSha) && !targetContainsSource(root, r.RemoteSha, r.LocalSha)
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
		return out
	}
	// Landed, and the local target synced: the recovery is over, and its repair checkout with it.
	if kept := reclaimRecoveryCheckout(root, r.RepairBranch, r.RepairWorktree, "its candidate landed on origin/"+r.TargetBranch); kept != "" {
		logln("merge recovery: kept repair checkout", r.RepairWorktree+":", kept)
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
