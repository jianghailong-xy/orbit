package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Isolation outcomes reported back on /complete (Session.isolationStatus): the session
// ran in its own git worktree, or fell back to the shared workDir because it wasn't a
// git repo (the case the UI nudges the user to fix with `git init`). isoShared (no branch
// at all) is internal and not reported.
const (
	isoWorktree    = "worktree"
	isoSharedNoGit = "shared-nogit"
	isoShared      = "shared"
)

// Worktree is a per-session git worktree the runner created for isolation. It lets
// concurrent sessions on the same agent edit files without clobbering each other: each
// runs claude in its own checkout on its own branch, forked from the workDir HEAD at
// claim. On terminal completion the runner commits the work to Branch and removes the
// checkout — the branch stays behind for a manual merge in the UI.
type Worktree struct {
	Path    string // the worktree checkout dir
	Branch  string // orbit/<slug>-<hash>
	BaseSha string // commit Branch forked from (workDir HEAD at claim)
	RepoDir string // the git repo root, for `git -C RepoDir worktree ...`
	Session string // session id (names the checkout dir + base ref)

	// BaseSha can be healed while a turn is being finalized. Heartbeat telemetry
	// snapshots it concurrently, so keep that one mutable field synchronized.
	baseMu sync.RWMutex
}

func (wt *Worktree) baseSha() string {
	if wt == nil {
		return ""
	}
	wt.baseMu.RLock()
	defer wt.baseMu.RUnlock()
	return wt.BaseSha
}

func (wt *Worktree) setBaseSha(baseSha string) {
	if wt == nil {
		return
	}
	wt.baseMu.Lock()
	wt.BaseSha = baseSha
	wt.baseMu.Unlock()
}

// heartbeatCopy returns an immutable worktree DTO for one best-effort telemetry
// scan. Copy fields explicitly: copying a Worktree after its mutex has been used
// would copy lock state, and reading BaseSha without the lock would race finalization.
func (wt *Worktree) heartbeatCopy() *Worktree {
	if wt == nil {
		return nil
	}
	return &Worktree{
		Path:    wt.Path,
		Branch:  wt.Branch,
		BaseSha: wt.baseSha(),
		RepoDir: wt.RepoDir,
		Session: wt.Session,
	}
}

// git runs `git -C dir <args...>` and returns trimmed stdout. On a non-zero exit the
// returned error is an *exec.ExitError whose .Stderr carries git's message.
func git(dir string, args ...string) (string, error) {
	out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).Output()
	return strings.TrimSpace(string(out)), err
}

// gitCtx is reserved for bounded, best-effort probes such as heartbeat telemetry.
// Mutating worktree operations deliberately keep using git(): a repository commit,
// rebase, or push may legitimately take longer than a telemetry budget.
func gitCtx(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	// A clean/LFS filter may inherit Git's output pipe. Bound Wait even if that
	// descendant survives the direct Git process cancellation.
	cmd.WaitDelay = 2 * time.Second
	out, err := cmd.Output()
	return strings.TrimSpace(string(out)), err
}

type worktreeGitOps struct {
	run            func(string, ...string) (string, error)
	runEnv         func(string, []string, ...string) (string, error)
	ctx            context.Context
	persistBaseRef bool
}

var unboundedWorktreeGitOps = worktreeGitOps{run: git, runEnv: gitEnv, persistBaseRef: true}

func contextWorktreeGitOps(ctx context.Context) worktreeGitOps {
	return worktreeGitOps{
		ctx: ctx,
		run: func(dir string, args ...string) (string, error) {
			return gitCtx(ctx, dir, args...)
		},
		runEnv: func(dir string, env []string, args ...string) (string, error) {
			return gitEnvCtx(ctx, dir, env, args...)
		},
	}
}

func (ops worktreeGitOps) cancelled() bool { return ops.ctx != nil && ops.ctx.Err() != nil }

// isGitRepo reports whether dir is inside a git work tree.
func isGitRepo(dir string) bool {
	out, err := git(dir, "rev-parse", "--is-inside-work-tree")
	return err == nil && out == "true"
}

func branchExists(repoRoot, branch string) bool {
	return unboundedWorktreeGitOps.branchExists(repoRoot, branch)
}

func (ops worktreeGitOps) branchExists(repoRoot, branch string) bool {
	_, err := ops.run(repoRoot, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch)
	return err == nil
}

// listMergeTargets returns the repo's local branches that make sense as merge targets for the
// status bar's "Merge to…" dropdown: every refs/heads/* except Orbit's own per-session branches
// (orbit/*), which you merge FROM, never INTO. Best-effort — nil on any git error / empty repo.
func listMergeTargets(repoRoot string) []string {
	return unboundedWorktreeGitOps.listMergeTargets(repoRoot)
}

func (ops worktreeGitOps) listMergeTargets(repoRoot string) []string {
	out, err := ops.run(repoRoot, "for-each-ref", "--format=%(refname:short)", "refs/heads/")
	if err != nil || out == "" {
		return nil
	}
	var targets []string
	for _, b := range strings.Split(out, "\n") {
		b = strings.TrimSpace(b)
		if b == "" || strings.HasPrefix(b, "orbit/") {
			continue
		}
		targets = append(targets, b)
	}
	return targets
}

// mergeTargetsForWT lists a worktree's repo branches usable as merge targets; nil for a nil
// worktree (a shared-dir session — nothing to merge into).
func mergeTargetsForWT(wt *Worktree) []string {
	return unboundedWorktreeGitOps.mergeTargetsForWT(wt)
}

func (ops worktreeGitOps) mergeTargetsForWT(wt *Worktree) []string {
	if wt == nil {
		return nil
	}
	return ops.listMergeTargets(wt.RepoDir)
}

// mergeTargetBySession records the branch each session's work is merged INTO, so
// branchMergedInto judges the same branch the UI's Merge button names: an agent whose default
// target is `develop` merges there, and checking main would report "not merged" for work that
// did land. Seeded from the claim/reclaim payload (the session's recorded merge target, so a
// runner restart doesn't forget) and refreshed by every merge this runner runs.
var (
	mergeTargetMu        sync.Mutex
	mergeTargetBySession = map[string]string{}
)

// rememberMergeTarget records the branch a session merges into. An empty target means the
// auto-detected default (main/master), so any stale entry is dropped rather than kept.
func rememberMergeTarget(sessionID, target string) {
	mergeTargetMu.Lock()
	defer mergeTargetMu.Unlock()
	if target == "" {
		delete(mergeTargetBySession, sessionID)
		return
	}
	mergeTargetBySession[sessionID] = target
}

// forgetMergeTarget drops a finished session's remembered target (called as it leaves `active`).
func forgetMergeTarget(sessionID string) {
	mergeTargetMu.Lock()
	defer mergeTargetMu.Unlock()
	delete(mergeTargetBySession, sessionID)
}

func mergeTargetFor(sessionID string) string {
	mergeTargetMu.Lock()
	defer mergeTargetMu.Unlock()
	return mergeTargetBySession[sessionID]
}

// currentBranch returns the worktree's actual checked-out branch (git symbolic-ref --short HEAD),
// or "" when HEAD is detached or git errors. This is the branch the agent is really on right now —
// it diverges from wt.Branch (the branch Orbit forked at claim) when the agent runs `git checkout
// -b` inside the worktree, moving the work onto a branch Orbit isn't tracking. Reported each
// heartbeat as WorktreeBranch so the server can flag the divergence and offer "Adopt".
func currentBranch(wt *Worktree) string {
	return unboundedWorktreeGitOps.currentBranch(wt)
}

func (ops worktreeGitOps) currentBranch(wt *Worktree) string {
	if wt == nil || wt.Path == "" {
		return ""
	}
	b, err := ops.run(wt.Path, "symbolic-ref", "--short", "HEAD")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(b)
}

// effectiveBranch is the branch every live worktree computation (diff base, "already merged")
// judges: the worktree's real HEAD if it's on a branch, else the recorded fork branch. Following
// the real HEAD keeps the status bar honest after an in-worktree `git checkout -b` — the bar then
// reports the NEW branch's merge state, not the stale (often already-merged) branch Orbit forked at
// claim, which is exactly the "still shows ✓ In main / unmergeable" bug. Equal to wt.Branch in the
// common case (no checkout), so it's a no-op there.
func effectiveBranch(wt *Worktree) string {
	return unboundedWorktreeGitOps.effectiveBranch(wt)
}

func (ops worktreeGitOps) effectiveBranch(wt *Worktree) string {
	if cur := ops.currentBranch(wt); cur != "" {
		return cur
	}
	if wt != nil {
		return wt.Branch
	}
	return ""
}

// effectiveBranchSha returns the current tip of effectiveBranch. Resolving the ref instead of
// the worktree's HEAD preserves effectiveBranch's detached-HEAD fallback while still following
// an in-worktree checkout to a different branch. Empty means there is no isolated branch or git
// could not resolve its tip; callers omit the optional wire field in that case.
func effectiveBranchSha(wt *Worktree) string {
	return unboundedWorktreeGitOps.effectiveBranchSha(wt)
}

func (ops worktreeGitOps) effectiveBranchSha(wt *Worktree) string {
	if wt == nil || wt.RepoDir == "" {
		return ""
	}
	branch := ops.effectiveBranch(wt)
	if branch == "" {
		return ""
	}
	sha, err := ops.run(wt.RepoDir, "rev-parse", "--verify", "refs/heads/"+branch)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(sha)
}

// branchMergedInto reports whether the worktree's branch has already landed in its merge target
// (the session's remembered target, else main, else master), so the status bar shows a "✓ In
// main" chip instead of a redundant Merge button. Two ways it can already be there: the branch
// tip is an ancestor of the
// target (a fast-forward or a command-line push), OR every commit since the fork has an equivalent
// patch in the target (a squash/rebase merge — including Orbit's own "Merge to main", which rebases
// the branch onto the target and so replays its commits under fresh SHAs that is-ancestor can't
// match). Judges the same target the Merge button names (see mergeTargetBySession), falling back
// to mergeToMain's auto-detected default. False when nothing's isolated, no target exists, the
// branch is the target, or git can't decide — a conservative default that keeps the actionable
// Merge button.
func branchMergedInto(wt *Worktree) bool {
	return unboundedWorktreeGitOps.branchMergedInto(wt)
}

func (ops worktreeGitOps) branchMergedInto(wt *Worktree) bool {
	if wt == nil {
		return false
	}
	// Judge the branch the worktree is ACTUALLY on (effectiveBranch), not the frozen fork branch —
	// so after an in-worktree `git checkout -b` the verdict tracks the new branch's work instead of
	// the (often already-merged) branch Orbit forked at claim.
	branch := ops.effectiveBranch(wt)
	if branch == "" {
		return false
	}
	var target string
	for _, b := range []string{mergeTargetFor(wt.Session), "main", "master"} {
		if b != "" && ops.branchExists(wt.RepoDir, b) {
			target = b
			break
		}
	}
	if target == "" || target == branch {
		return false
	}
	// A branch that never committed past its fork point still has its tip sitting at BaseSha,
	// which is by construction already in main's history — so is-ancestor would trivially say
	// "merged" for a session that did no work. Require ≥1 commit past the fork before claiming
	// the work landed; otherwise there was nothing to merge. (Genuinely merged branches keep
	// their commits ahead of the old fork point, so they still count as ahead here.)
	if baseSha := wt.baseSha(); baseSha != "" {
		ahead, err := ops.run(wt.RepoDir, "rev-list", "--count", baseSha+".."+branch)
		if err == nil && strings.TrimSpace(ahead) == "0" {
			return false
		}
	}
	// Fast path — the branch tip is literally contained in the target (a fast-forward, or a
	// command-line `push origin HEAD:main`). `merge-base --is-ancestor A B` exits 0 when A is an
	// ancestor of B, non-zero otherwise; git() returns a non-nil error for any non-zero exit, so
	// err == nil ⇔ already merged.
	if _, err := ops.run(wt.RepoDir, "merge-base", "--is-ancestor", branch, target); err == nil {
		return true
	}
	// Slow path — the branch's work landed in the target under NEW commit hashes, so is-ancestor
	// can't see it: a squash-merge, a rebase, or Orbit's own "Merge to main" (which rebases the
	// branch onto the target, replaying its commits with fresh SHAs). Fall back to patch-id
	// equivalence: `git cherry <target> <branch>` lists each of the branch's post-fork commits,
	// prefixed '-' when an equivalent patch already exists in the target, '+' when it doesn't. Every
	// commit accounted for ('-', none '+') ⇒ the work is in the target under a different identity —
	// still merged. Any '+' (or a git error / empty output) stays conservatively false, keeping the
	// actionable Merge button.
	//
	// The fork point goes in as `cherry`'s third argument (the limit) so the question asked is
	// "did THIS SESSION's commits land", over the same range the merge itself replays (see
	// replayAnchor). Without it the range is `<target>..<branch>`, which for a branch forked
	// outside the target also contains the fork branch's own commits — commits this session never
	// wrote and the merge deliberately leaves behind, each of them a '+' that reads as unmerged
	// work forever. A base that isn't on the branch's history only widens the range, so the
	// verdict stays conservative.
	cherry := []string{"cherry", target, branch}
	if baseSha := wt.baseSha(); baseSha != "" {
		cherry = append(cherry, baseSha)
	}
	out, err := ops.run(wt.RepoDir, cherry...)
	if err != nil {
		return false
	}
	merged := false
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "+") {
			return false // a post-fork commit has no equivalent in the target yet
		}
		merged = true // a '-' line: this commit's patch already exists in the target
	}
	return merged
}

// defaultGitignore is written into a non-git workDir before its baseline commit (only when
// the dir has no .gitignore of its own), so auto-init doesn't sweep dependencies, build
// output, or secrets into version control.
const defaultGitignore = `# Auto-generated by Orbit when enabling worktree isolation.
node_modules/
dist/
build/
out/
.next/
.turbo/
target/
__pycache__/
*.pyc
.venv/
venv/
.env
.env.*
*.log
.DS_Store
.idea/
.vscode/
`

// initGitRepo turns a non-git workDir into a git repo so its sessions can be isolated:
// writes a conservative .gitignore (only if absent), `git init`, stages everything, and
// makes a baseline commit. Triggered only when the agent opted in (autoInitGit). Returns an
// error if the repo isn't usable afterward — no baseline commit means no HEAD to fork from.
func initGitRepo(dir string) error {
	if _, err := os.Stat(filepath.Join(dir, ".gitignore")); os.IsNotExist(err) {
		_ = os.WriteFile(filepath.Join(dir, ".gitignore"), []byte(defaultGitignore), 0o644)
	}
	if _, err := git(dir, "init"); err != nil {
		return err
	}
	if _, err := git(dir, "add", "-A"); err != nil {
		return err
	}
	// Inline identity + --no-verify so the baseline never fails on a runner with no git
	// user.* set or a stray hook; --allow-empty so even an empty dir gets a HEAD to fork.
	_, err := git(dir,
		"-c", "user.email=runner@orbit", "-c", "user.name=Orbit Runner",
		"commit", "--no-verify", "--allow-empty", "-m", "orbit: baseline")
	return err
}

// worktreesDir holds per-session checkouts, outside any repo so they're easy to GC and
// never nest inside an agent's tree. Sibling of the runner's scratch `runs` dir.
func worktreesDir() string {
	d := filepath.Join(machineHome(), "worktrees")
	_ = os.MkdirAll(d, 0o755)
	return d
}

// uploadsRootDir holds per-session attachment scratch (writeUpload), a sibling of worktreesDir
// kept outside any repo so uploads are never swept into a session's git history. Reaped by
// gcUploads when the session is no longer live.
func uploadsRootDir() string { return filepath.Join(machineHome(), "uploads") }

// uploadsDir is one session's attachment scratch dir.
//
// Normalized, like every on-disk key here: the server is moving to base62 public ids on the wire
// (docs/public-id-migration-design.md), so the id in a claim payload is a moving target. Keying
// the filesystem by whatever spelling happened to arrive would strand a live session's uploads
// the moment the server switched — the dir would still be on disk under the other name, which is
// the kind of bug that looks like data loss and reads like nothing at all in the logs.
func uploadsDir(sessionID string) string {
	return filepath.Join(uploadsRootDir(), decodeSessionID(sessionID))
}

// baseRefName is the git ref a session's diff is computed against. Same normalization, and it
// matters more here than for a scratch dir: an orphaned base ref does not fail, it silently
// re-bases every diff on the wrong commit.
func baseRefName(sessionID string) string {
	return "refs/orbit-base/" + decodeSessionID(sessionID)
}

// resolveBaseSha returns the base commit every session diff is computed against, healing a
// recorded base that has gone wrong two ways:
//
//   - DRIFT (not an ancestor of the branch any more): a checkout re-created after GC stamped the
//     repo's CURRENT HEAD, which had moved past the branch's fork — every diff then counts other
//     people's commits as this session's deletions.
//   - SLACK (a real ancestor, but looser than the true fork): the branch was rebased forward
//     mid-session, so the old fork is still in its history yet the diff now counts the target's
//     replayed commits as this session's additions.
//
// The candidate fork is merge-base(HEAD, branch). A valid recorded base is only tightened TOWARD
// it (persisted must be an ancestor of the candidate), never loosened — a branch forked off a
// non-HEAD branch (e.g. develop while the root sits on main) keeps its tighter recorded fork.
// And it is never tightened all the way TO the branch tip: a fully-merged branch keeps its old
// fork, so the bar still shows the session's cumulative work and branchMergedInto's ≥1-commit
// guard keeps reading "✓ In main" (tip==base would read as a session that never worked). The
// moment new work lands past the merge, the candidate falls behind the tip again and the base
// snaps to it — diffs then show only the new work. Healed values are re-persisted to the base
// ref. Best-effort: on any git failure the persisted value is returned unchanged.
func resolveBaseSha(repoRoot, sessionID, branch, persisted string) string {
	return unboundedWorktreeGitOps.resolveBaseSha(repoRoot, sessionID, branch, persisted)
}

func (ops worktreeGitOps) resolveBaseSha(repoRoot, sessionID, branch, persisted string) string {
	tip, err := ops.run(repoRoot, "rev-parse", "refs/heads/"+branch)
	if ops.cancelled() {
		return persisted
	}
	if err != nil || tip == "" {
		return persisted
	}
	mb, err := ops.run(repoRoot, "merge-base", "HEAD", branch)
	if ops.cancelled() {
		return persisted
	}
	if err != nil || mb == "" {
		return persisted
	}
	valid := false
	if persisted != "" {
		if _, err := ops.run(repoRoot, "merge-base", "--is-ancestor", persisted, branch); err == nil {
			valid = true
		}
		if ops.cancelled() {
			return persisted
		}
	}
	if valid {
		if persisted == mb || mb == tip {
			return persisted
		}
		// Tighten a slack fork (rebase moved it forward); keep a fork the candidate can't see
		// (forked off a non-HEAD branch — persisted is NOT an ancestor of the candidate).
		_, err := ops.run(repoRoot, "merge-base", "--is-ancestor", persisted, mb)
		if ops.cancelled() {
			return persisted
		}
		if err != nil {
			return persisted
		}
	}
	if ops.persistBaseRef {
		_, _ = ops.run(repoRoot, "update-ref", baseRefName(sessionID), mb)
	}
	return mb
}

// freshenBaseSha re-validates wt.BaseSha before a diff is computed: a branch rebased mid-session
// leaves the recorded fork outside its history, mis-basing every diff until the next re-attach.
// One is-ancestor check when healthy; self-healing (and ref-re-persisting) when not.
func freshenBaseSha(wt *Worktree) {
	_ = unboundedWorktreeGitOps.freshenBaseSha(wt)
}

func (ops worktreeGitOps) freshenBaseSha(wt *Worktree) string {
	if wt == nil {
		return ""
	}
	persisted := wt.baseSha()
	if persisted == "" || wt.Branch == "" {
		return persisted
	}
	// Resolve against the worktree's real HEAD (effectiveBranch): after an in-worktree checkout -b
	// the diff should be based on the new branch's fork point, so it shows the new branch's delta
	// rather than mis-basing on the branch Orbit forked at claim.
	baseSha := ops.resolveBaseSha(wt.RepoDir, wt.Session, ops.effectiveBranch(wt), persisted)
	if !ops.cancelled() {
		// Bounded telemetry passes a private worktree copy: update it even though
		// persistBaseRef is false so every later calculation in this scan uses the
		// healed fork. Unbounded callers update the live Worktree as before.
		wt.setBaseSha(baseSha)
	}
	return baseSha
}

func shortSha(sha string) string {
	if len(sha) > 8 {
		return sha[:8]
	}
	return sha
}

// setupWorktree ensures a per-session git worktree exists for job and returns the dir
// claude should run in. When job has no branch, baseDir isn't a git repo, or the repo has
// no commits, it returns baseDir unchanged (shared-dir fallback) and records why on
// job.IsolationStatus. Otherwise it sets job.WT and returns the checkout's exec dir.
func setupWorktree(job *ClaimedSession, baseDir string) string {
	if job.Branch == "" {
		job.IsolationStatus = isoShared
		return baseDir
	}
	if !isGitRepo(baseDir) {
		// Not a git repo. If the agent opted in (autoInitGit, set by the web "Enable
		// isolation" action), initialize one so the session can still be isolated;
		// otherwise run shared and nudge the user via isolationStatus=shared-nogit.
		if !job.AutoInitGit {
			job.IsolationStatus = isoSharedNoGit
			logln(fmt.Sprintf("session %s — workDir %q is not a git repo; running shared (no isolation)", job.SessionID, baseDir))
			return baseDir
		}
		if err := initGitRepo(baseDir); err != nil {
			job.IsolationStatus = isoSharedNoGit
			logln(fmt.Sprintf("session %s — auto git init of %q failed (%v); running shared", job.SessionID, baseDir, err))
			return baseDir
		}
		logln(fmt.Sprintf("session %s — auto-initialized git repo at %q (autoInitGit)", job.SessionID, baseDir))
		// Fall through: baseDir is now a git repo with a baseline commit.
	}
	repoRoot, err := git(baseDir, "rev-parse", "--show-toplevel")
	if err != nil || repoRoot == "" {
		job.IsolationStatus = isoSharedNoGit
		return baseDir
	}
	wtPath := filepath.Join(worktreesDir(), job.SessionID)
	// Land claude at the same spot inside the checkout that baseDir is inside the repo,
	// so a workDir that is a subdir of the repo still resolves correctly.
	rel, _ := filepath.Rel(repoRoot, baseDir)
	if rel == "" || rel == "." || strings.HasPrefix(rel, "..") {
		rel = "."
	}
	execDir := filepath.Join(wtPath, rel)

	// Reuse an existing checkout (reclaim/resume after a restart): the dir survives with
	// any uncommitted in-flight work intact. Recover BaseSha from the persisted base ref.
	if isGitRepo(wtPath) {
		base, _ := git(repoRoot, "rev-parse", baseRefName(job.SessionID))
		// Heal a drifted/missing base ref (see resolveBaseSha) so a reclaim never resumes
		// with a fork point that isn't actually in the branch's history.
		base = resolveBaseSha(repoRoot, job.SessionID, job.Branch, base)
		job.WT = &Worktree{Path: wtPath, Branch: job.Branch, BaseSha: base, RepoDir: repoRoot, Session: job.SessionID}
		job.IsolationStatus = isoWorktree
		logln(fmt.Sprintf("session %s — re-attached worktree %s (branch %s)", job.SessionID, wtPath, job.Branch))
		return execDir
	}

	// Fork from the workDir's HEAD — deliberately NOT the session's merge target. mergeToMain
	// writes defaultMergeTarget back on every explicit "Merge to…" pick, so basing the checkout
	// on it would let one one-off merge silently re-base every later session of that agent.
	// Sessions follow the shared checkout; move it with `git checkout` to move them.
	base, err := git(baseDir, "rev-parse", "HEAD")
	if err != nil || base == "" {
		// An empty repo (no commits) has no HEAD to fork from — run shared instead.
		job.IsolationStatus = isoSharedNoGit
		logln(fmt.Sprintf("session %s — repo has no HEAD; running shared (no isolation)", job.SessionID))
		return baseDir
	}
	// Record the fork point as a ref so it survives a runner restart (the in-memory
	// BaseSha would be lost on reclaim), then create the worktree on the session's branch.
	if branchExists(repoRoot, job.Branch) {
		// Re-creating a checkout for a branch that already exists (GC'd after a park, revived
		// later): the repo HEAD has moved past the branch's fork by now, so stamping it as the
		// base mis-bases every diff (other people's commits read as this session's deletions).
		// The true fork point is the merge-base with the branch; resolveBaseSha persists it.
		base = resolveBaseSha(repoRoot, job.SessionID, job.Branch, "")
		_, err = git(repoRoot, "worktree", "add", wtPath, job.Branch)
	} else {
		_, _ = git(repoRoot, "update-ref", baseRefName(job.SessionID), base)
		_, err = git(repoRoot, "worktree", "add", "-b", job.Branch, wtPath, base)
	}
	if err != nil {
		_, _ = git(repoRoot, "update-ref", "-d", baseRefName(job.SessionID))
		job.IsolationStatus = isoSharedNoGit
		logln(fmt.Sprintf("session %s — `git worktree add` failed (%v); running shared", job.SessionID, err))
		return baseDir
	}
	job.WT = &Worktree{Path: wtPath, Branch: job.Branch, BaseSha: base, RepoDir: repoRoot, Session: job.SessionID}
	job.IsolationStatus = isoWorktree
	logln(fmt.Sprintf("session %s — isolated in worktree %s (branch %s @ %s)", job.SessionID, wtPath, job.Branch, shortSha(base)))
	return execDir
}

// parkCheckpointTrailer marks a finalize commit as a *park checkpoint*: the snapshot taken when
// a still-resumable session (idle-recycled or user-ended, which the server settles CANCELLED under
// an `idle`/`ended` endReason) is torn down, so its in-progress work is durable on the branch even
// after the checkout is GC'd.
// It is NOT a real end. On the next resume, uncommitParkCheckpoint soft-resets it so the work
// returns to an uncommitted working tree and the agent continues without a stray checkpoint
// polluting the branch history. A genuine end (SUCCEEDED/FAILED) commits WITHOUT this trailer,
// so its commit is permanent.
const parkCheckpointTrailer = "Orbit-Park-Checkpoint"

// finalizeWorktree commits whatever the session changed onto its branch and returns the
// per-file diff stats plus the per-file unified-diff patches vs the base. Called once at
// terminal completion, before /complete, so the work is captured on the branch even though
// the checkout dir may then be removed. `checkpoint` tags the commit as an undo-on-resume park
// checkpoint (see parkCheckpointTrailer) rather than a permanent end commit.
//
// The commit subject is derived from the diff, never the session title/prompt: a permanent end
// gets an LLM-summarized Conventional-Commits message (diffstat fallback, same as the manual
// Commit button), while a transient park checkpoint gets only the cheap deterministic diffstat
// (no LLM call on the frequent park path). This keeps a raw first prompt out of git history when
// session-naming produced no clean title.
func finalizeWorktree(wt *Worktree, checkpoint bool) ([]ChangedFile, []FilePatch) {
	if _, err := git(wt.Path, "add", "-A"); err != nil {
		logln("worktree add failed for", wt.Session+":", err)
	}
	// `diff --cached --quiet` exits non-zero when something is staged → there's work to commit.
	if _, err := git(wt.Path, "diff", "--cached", "--quiet"); err != nil {
		var msg string
		if checkpoint {
			// Transient snapshot, undone on resume — keep it cheap and deterministic.
			msg = diffstatFallbackMessage(wt.Path, wt.Branch) + "\n\n" + parkCheckpointTrailer + ": " + wt.Session
		} else {
			// Permanent commit that stays on the branch and may merge to main — summarize the
			// diff into a real message, never the raw session title/prompt.
			msg = generateCommitMessage(wt.Path, diffstatFallbackMessage(wt.Path, wt.Branch))
		}
		// Inline identity so the commit never fails on a runner with no git user.* set;
		// --no-verify so a repo's pre-commit hook can't block finalization.
		if _, err := git(wt.Path,
			"-c", "user.email=runner@orbit", "-c", "user.name=Orbit Runner",
			"commit", "--no-verify", "-m", msg); err != nil {
			logln("worktree commit failed for", wt.Session+":", err)
		}
	}
	// A mid-session rebase moved the fork point — re-base the final diff on the new one.
	freshenBaseSha(wt)
	baseSha := wt.baseSha()
	if baseSha == "" {
		return nil, nil
	}
	files := diffFiles(wt.Path, baseSha, "HEAD")
	patchOut, _ := git(wt.Path, "diff", baseSha+"..HEAD")
	return files, buildFilePatches(files, splitPatch(patchOut))
}

// uncommitParkCheckpoint undoes a park checkpoint (see parkCheckpointTrailer) at the start of a
// resumed session: if the worktree's HEAD is THIS session's checkpoint, soft-reset it so the
// snapshot returns to an uncommitted working tree and the agent continues where it left off, with
// no checkpoint commit left in the branch's history. A no-op when HEAD isn't our checkpoint —
// a fresh session, a permanent SUCCEEDED/FAILED end commit, or a branch merged/rebased since —
// so it's safe to call unconditionally before every isolated session start. --soft never touches
// the working tree or index, so the snapshot's content is preserved as a pending change.
func uncommitParkCheckpoint(wt *Worktree) {
	msg, err := git(wt.Path, "log", "-1", "--format=%B")
	if err != nil || !strings.Contains(msg, parkCheckpointTrailer+": "+wt.Session) {
		return
	}
	if _, err := git(wt.Path, "reset", "--soft", "HEAD~1"); err != nil {
		logln("park-checkpoint un-commit failed for", wt.Session+":", err)
		return
	}
	logln(fmt.Sprintf("session %s — undid park checkpoint (work restored to working tree)", wt.Session))
}

// gitEnv runs `git -C dir <args...>` with extra environment (e.g. GIT_INDEX_FILE).
func gitEnv(dir string, env []string, args ...string) (string, error) {
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = env
	out, err := cmd.Output()
	return strings.TrimSpace(string(out)), err
}

func gitEnvCtx(ctx context.Context, dir string, env []string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	cmd.Env = env
	cmd.WaitDelay = 2 * time.Second
	out, err := cmd.Output()
	return strings.TrimSpace(string(out)), err
}

// diffFiles returns the per-file change summary for the committed `git diff base..head`.
func diffFiles(dir, base, head string) []ChangedFile {
	rng := base + ".." + head
	numOut, err := git(dir, "diff", "--numstat", rng)
	if err != nil {
		logln("worktree diff failed in", dir+":", err)
		return nil
	}
	statusOut, _ := git(dir, "diff", "--name-status", rng)
	return parseNumstat(numOut, statusOut)
}

// liveDiff returns the per-file stat summary AND the per-file unified-diff patches of the
// worktree's CURRENT state (uncommitted + untracked) vs its base — for the turn-boundary
// reports (turn-complete/complete) that drive the on-demand file diffs.
func liveDiff(wt *Worktree) ([]ChangedFile, []FilePatch) {
	return stagedLiveDiff(wt, true)
}

// liveDiffStat is the stats-only counterpart, for the heartbeat's SessionLiveState: it carries
// the changed-file summary for the mid-turn status bar every ~30s, so it deliberately skips the
// (heavier) per-file patch text that would bloat the heartbeat payload — the diff *patches*
// refresh at turn boundaries via liveDiff instead.
func liveDiffStat(wt *Worktree) []ChangedFile {
	return unboundedWorktreeGitOps.liveDiffStat(wt)
}

func (ops worktreeGitOps) liveDiffStat(wt *Worktree) []ChangedFile {
	files, _ := ops.stagedLiveDiff(wt, false)
	return files
}

// stagedLiveDiff stages the worktree's current state into a throwaway temp index and computes
// the per-file stat summary vs base; with withPatch it also captures the per-file unified-diff
// patches (capped). The temp index (GIT_INDEX_FILE) never touches the real index claude may be
// using, and .gitignore is respected so node_modules/build output don't show. The index is
// pre-seeded from base (read-tree) so a tracked-but-ignored file isn't misreported as deleted.
func stagedLiveDiff(wt *Worktree, withPatch bool) ([]ChangedFile, []FilePatch) {
	return unboundedWorktreeGitOps.stagedLiveDiff(wt, withPatch)
}

func (ops worktreeGitOps) stagedLiveDiff(wt *Worktree, withPatch bool) ([]ChangedFile, []FilePatch) {
	// A mid-session rebase moved the fork point — heal before basing the live diff on it.
	baseSha := ops.freshenBaseSha(wt)
	if wt == nil || baseSha == "" {
		return nil, nil
	}
	tmp, err := os.CreateTemp("", "orbit-idx-*")
	if err != nil {
		return nil, nil
	}
	idx := tmp.Name()
	_ = tmp.Close()
	// Remove the empty file first: git rejects a 0-byte index ("index file smaller than
	// expected") — it creates a fresh index at this path instead.
	_ = os.Remove(idx)
	defer os.Remove(idx)
	env := append(os.Environ(), "GIT_INDEX_FILE="+idx)
	// Seed the temp index from base first: a file that's tracked in base but also matches a
	// .gitignore rule (force-committed with `git add -f`) would otherwise be dropped by
	// `add -A` — which honors .gitignore for paths it sees as untracked — and reported as a
	// phantom deletion vs base. Pre-loaded as tracked, it survives and `add -A` only layers
	// the worktree's real changes on top.
	if _, err := ops.runEnv(wt.Path, env, "read-tree", baseSha); err != nil {
		return nil, nil
	}
	if _, err := ops.runEnv(wt.Path, env, "add", "-A"); err != nil {
		return nil, nil
	}
	numOut, err := ops.runEnv(wt.Path, env, "diff", "--cached", "--numstat", baseSha)
	if err != nil {
		return nil, nil
	}
	statusOut, _ := ops.runEnv(wt.Path, env, "diff", "--cached", "--name-status", baseSha)
	files := parseNumstat(numOut, statusOut)
	if !withPatch {
		return files, nil
	}
	// Same staged index → the full patch matches the numstat exactly. Best-effort: a patch
	// failure just leaves the file list without diffs, the status bar still works.
	patchOut, _ := ops.runEnv(wt.Path, env, "diff", "--cached", baseSha)
	return files, buildFilePatches(files, splitPatch(patchOut))
}

// worktreeIsDirty reports whether the worktree has uncommitted changes right now — tracked
// or untracked, respecting .gitignore (`git status --porcelain` non-empty). Drives the
// status bar's Commit-vs-Merge action. False for a nil/missing worktree.
func worktreeIsDirty(wt *Worktree) bool {
	return unboundedWorktreeGitOps.worktreeIsDirty(wt)
}

func (ops worktreeGitOps) worktreeIsDirty(wt *Worktree) bool {
	if wt == nil {
		return false
	}
	out, err := ops.run(wt.Path, "status", "--porcelain")
	return err == nil && out != ""
}

// parseNumstat zips `git diff --numstat` (+/-/path) with `git diff --name-status` (the
// status letter, keyed by the new path for renames) into ChangedFile rows.
func parseNumstat(numOut, statusOut string) []ChangedFile {
	statusBy := map[string]string{}
	for _, line := range strings.Split(statusOut, "\n") {
		// `--name-status` is tab-delimited: "<status>\t<path>" (rename/copy add a trailing
		// "\t<newpath>"). Split on tab, not whitespace, so filenames containing spaces aren't
		// truncated and mis-keyed — which silently dropped them to the default "M".
		f := strings.Split(line, "\t")
		if len(f) >= 2 && f[0] != "" {
			statusBy[f[len(f)-1]] = string(f[0][0])
		}
	}
	var out []ChangedFile
	for _, line := range strings.Split(numOut, "\n") {
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) != 3 || parts[2] == "" {
			continue
		}
		st := statusBy[parts[2]]
		if st == "" {
			st = "M"
		}
		out = append(out, ChangedFile{
			Path:      parts[2],
			Additions: parseStatInt(parts[0]),
			Deletions: parseStatInt(parts[1]),
			Status:    st,
		})
	}
	return out
}

// parseStatInt parses a numstat count; "-" marks a binary file → -1.
func parseStatInt(s string) int {
	if s == "-" {
		return -1
	}
	n, _ := strconv.Atoi(s)
	return n
}

// Patch-size caps keep the per-turn upload (and the stored diff) bounded: a single file's
// unified diff over maxFilePatchBytes, or any file once the running total passes
// maxTotalPatchBytes, is reported as Truncated (no text) instead of shipped in full.
const (
	maxFilePatchBytes  = 64 * 1024
	maxTotalPatchBytes = 512 * 1024
)

// splitPatch breaks a combined `git diff` into per-file unified-diff segments, keyed by each
// file's new path (the `+++ b/…` header, falling back to the `diff --git …` line). Binary and
// pure-rename sections carry no hunks and simply map to their header text.
func splitPatch(full string) map[string]string {
	out := map[string]string{}
	if full == "" {
		return out
	}
	var path string
	var buf []string
	flush := func() {
		if path != "" {
			out[path] = strings.Join(buf, "\n")
		}
		path, buf = "", nil
	}
	for _, ln := range strings.Split(full, "\n") {
		if strings.HasPrefix(ln, "diff --git ") {
			flush()
			path = gitDiffNewPath(ln)
			buf = []string{ln}
			continue
		}
		if path == "" {
			continue
		}
		// The `+++ b/<path>` header is the authoritative new name (handles renames); skip it
		// for a deletion, whose +++ is /dev/null.
		if strings.HasPrefix(ln, "+++ b/") {
			path = ln[len("+++ b/"):]
		}
		buf = append(buf, ln)
	}
	flush()
	return out
}

// gitDiffNewPath pulls the new path out of a `diff --git a/<old> b/<new>` header.
func gitDiffNewPath(ln string) string {
	if i := strings.Index(ln, " b/"); i >= 0 {
		return ln[i+3:]
	}
	return ""
}

// buildFilePatches pairs each (non-binary) changed file with its unified-diff segment under
// the per-file and running-total size caps. A file whose diff is too large — or that pushes
// the total over the cap — is marked Truncated with no text; binary files are omitted (the
// web shows "binary" from the ChangedFile stat).
func buildFilePatches(files []ChangedFile, byPath map[string]string) []FilePatch {
	var out []FilePatch
	total := 0
	for _, f := range files {
		if f.Additions < 0 || f.Deletions < 0 {
			continue // binary — no text preview
		}
		p := byPath[f.Path]
		if p == "" {
			continue
		}
		if len(p) > maxFilePatchBytes || total+len(p) > maxTotalPatchBytes {
			out = append(out, FilePatch{Path: f.Path, Truncated: true})
			continue
		}
		out = append(out, FilePatch{Path: f.Path, Patch: p})
		total += len(p)
	}
	return out
}

// removeWorktree tears down the session's checkout (the branch is kept) and drops the base
// ref. Called only when the server reports the session as non-resumable (Completed/in Trash);
// a resumable end keeps its checkout, and any stale one is later reaped by gcWorktrees.
func removeWorktree(wt *Worktree) {
	if _, err := git(wt.RepoDir, "worktree", "remove", "--force", wt.Path); err != nil {
		logln("worktree remove failed for", wt.Session+":", err)
		_ = os.RemoveAll(wt.Path)
		_, _ = git(wt.RepoDir, "worktree", "prune")
	}
	_, _ = git(wt.RepoDir, "update-ref", "-d", baseRefName(wt.Session))
}

// mergeLock serializes merges so two "merge to main" requests can't race on the same repo's
// working tree / main ref.
var mergeLock sync.Mutex

// mergeOutcome is what mergeToMain reports: "merged" advanced main (MergedSha = new HEAD and
// SourceSha = the immutable source tip that was replayed), "conflict" means the merge was aborted
// cleanly, "error" means a precondition failed. Message carries git's output / the failed
// precondition for the UI.
type mergeOutcome struct {
	Status    string
	MergedSha string
	SourceSha string
	Message   string
	// What the control plane's merge RECEIPT (§13.7) needs in order to be re-checkable later: the
	// branch this advanced, the tip it had before, the base the source was replayed onto, and the
	// paths git refused on. Empty on the precondition failures that return before a target is even
	// resolved — the receipt then names what it knows rather than guessing.
	TargetBranch    string
	TargetShaBefore string
	RebaseBase      string
	Conflicts       []string
	// `[K6]` §7: the target already contained the frozen source, so this merge did nothing and
	// moved nothing. Reported alongside Status "merged" rather than as a status of its own, so an
	// older control plane — which validates that field against a closed set — still records the
	// landing instead of rejecting the report and leaving the runner retrying forever. A control
	// plane that knows the flag records §13.7 MR2's `ALREADY_MERGED`, which exists to keep "the
	// target moved" and "it was already there" different facts.
	AlreadyMerged bool
}

// mergeToMain brings a session's branch into a target branch on the runner's local repo by
// REBASING the branch onto the target and fast-forwarding — so the result is a linear history
// with no merge commit. The target is req.TargetBranch (the branch the user picked from the
// status bar's dropdown), or auto-detected (main, else master) when empty.
//
// Before rebasing, the local target is brought up to date with origin/<target> (fetch +
// fast-forward) when an 'origin' remote tracks it. Agents and "Resolve in session" reconcile
// against origin/<target>, so a local target that lagged upstream would otherwise replay the
// branch onto a stale base and conflict on lines already resolved upstream — a phantom conflict
// no in-session resolve can clear. A target that has DIVERGED from origin (local-only commits) is
// reported as an "error" to reconcile manually, rather than silently merged onto the wrong base.
// Repos with no 'origin' (e.g. an auto-init'd workDir) skip this and behave exactly as before.
//
// The branch's commits are replayed on a temp copy in a throwaway worktree, so the session's own
// branch is never rewritten (a resumable session keeps its original commits). The target is then
// advanced to the rebased result, two paths, both conservative:
//   - target is the repo root's current checkout (the usual case for main — isolated sessions
//     run in their own worktrees, so the root sits on main between runs): fast-forward in place,
//     guarding a clean tree so we never clobber unrelated work.
//   - otherwise (a release/develop branch, or main when the root is on something else): the
//     target isn't checked out anywhere, so move its ref directly. Fails cleanly if the target
//     is checked out in another worktree.
//
// A rebase conflict returns a "conflict" outcome (aborted cleanly); any precondition failure
// returns "error" with an actionable message; the UI keeps a copyable `git merge` fallback. The
// session branch is never rewritten or deleted. Serialized by mergeLock so concurrent merges
// don't race on the repo.
func mergeToMain(req MergeCommand) mergeOutcome {
	mergeLock.Lock()
	defer mergeLock.Unlock()

	repoRoot, err := git(expandTilde(req.WorkDir), "rev-parse", "--show-toplevel")
	if err != nil || repoRoot == "" {
		return mergeOutcome{Status: "error", Message: "workDir is not a git repository"}
	}
	// Resolve the merge target: the branch the user picked, else auto-detect main → master.
	target := strings.TrimSpace(req.TargetBranch)
	if target == "" {
		for _, b := range []string{"main", "master"} {
			if branchExists(repoRoot, b) {
				target = b
				break
			}
		}
		if target == "" {
			return mergeOutcome{Status: "error", Message: "no main or master branch in this repo"}
		}
	} else if !branchExists(repoRoot, target) {
		return mergeOutcome{Status: "error", Message: fmt.Sprintf("target branch %q not found", target)}
	}
	if !branchExists(repoRoot, req.Branch) {
		return mergeOutcome{Status: "error", Message: fmt.Sprintf("branch %q not found", req.Branch)}
	}
	if req.Branch == target {
		return mergeOutcome{Status: "error", Message: fmt.Sprintf("can't merge %q into itself", target)}
	}
	// Freeze the exact source version this request will merge. The session worktree may keep
	// committing while the merge runs; staging the temp branch from this SHA makes SourceSha an
	// honest receipt for the content that landed, rather than a moving branch name sampled later.
	sourceSha, err := git(repoRoot, "rev-parse", "--verify", "refs/heads/"+req.Branch)
	if err != nil || sourceSha == "" {
		return mergeOutcome{Status: "error", Message: fmt.Sprintf("could not resolve branch %q", req.Branch)}
	}

	// `[K6]` §7, asked before anything is decided about how to advance the target: is the source
	// ALREADY in it?
	//
	// The incident this guard was written after had the source branch and `main` pointing at the
	// SAME commit. The only guard in this path compared the two branch NAMES, which differed, so it
	// did not fire — and the merge went on to replay twenty-two commits from a base the control
	// plane had recorded days earlier onto a target that already contained every one of them. Every
	// conflict it reported was between a commit and itself, and no amount of resolving them could
	// help, because the resolution was already merged.
	//
	// Object names, never branch names: a name is a value that moves, and the question is about two
	// specific commits. Asked twice, and both are load-bearing — here, so a target that already has
	// the work costs no network call and no repository write at all; and again after the origin
	// reconcile below, which is the case where the work landed upstream and this machine has only
	// just learned it.
	if tip, _ := git(repoRoot, "rev-parse", "--verify", "refs/heads/"+target); targetContainsSource(repoRoot, sourceSha, tip) {
		return alreadyMergedOutcome(req.SessionID, target, sourceSha, tip)
	}

	// The merge gate's tip half (§7 CP3 `BRANCH_TIP_MISMATCH`), decided here because this is the
	// only party that can see the tip. The control plane names the commit its checkpoint verified;
	// a branch that has moved past it is carrying commits no test evidence covers, and merging
	// those is the whole shape §7 exists to refuse. Asked AFTER the question above, because a
	// target that already contains the work has nothing to gate.
	if req.RequiredSourceSha != "" && !strings.EqualFold(strings.TrimSpace(req.RequiredSourceSha), sourceSha) {
		return mergeOutcome{Status: "error", SourceSha: sourceSha, TargetBranch: target, Message: fmt.Sprintf(
			"BRANCH_TIP_MISMATCH: %s is at %s but the verified checkpoint is %s — the commits after it carry no test evidence",
			req.Branch, shortSha(sourceSha), shortSha(req.RequiredSourceSha))}
	}

	// Decide how we'll advance the target after the rebase. If the repo root has the target checked
	// out (usual for main), we fast-forward it in place. Otherwise the target must not be checked
	// out in any worktree, so we can move its ref directly.
	//
	// A merely *dirty* root is deliberately NOT a precondition failure: `git merge --ff-only`
	// refuses precisely when the fast-forward would overwrite a locally-modified file and lets
	// unrelated edits through untouched, so a blanket "anything uncommitted" gate only converted one
	// stray file in the machine's shared checkout into a total merge outage for every session on it.
	// A half-finished merge/rebase is different — nothing can fast-forward into that checkout until
	// it's resolved — and git only says so after we've rebased and pushed, in wording that reads as
	// this branch's fault. Name it up front instead, before touching the network.
	ffAtRoot := false
	if cur, _ := git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD"); cur == target {
		ffAtRoot = true
		if st := inspectRepoRoot(repoRoot); st.Blocked() {
			return mergeOutcome{Status: "error", Message: st.BlockedMessage(target)}
		}
	} else if branchWorktree(repoRoot, target) != "" {
		return mergeOutcome{Status: "error", Message: fmt.Sprintf("%q is checked out in another worktree — merge it there or pick another branch", target)}
	}

	// Bring the local target up to date with origin before rebasing onto it (see the function
	// comment): a target that lagged origin/<target> would replay the branch onto a stale base and
	// conflict on lines already reconciled upstream.
	if out := reconcileTargetWithOrigin(repoRoot, target); out != nil {
		return *out
	}

	// The target tip the replay is computed against, read AFTER the origin reconcile above so it
	// is the base the rebase actually used rather than the one this process started with.
	targetBefore, _ := git(repoRoot, "rev-parse", "--verify", "refs/heads/"+target)

	// The same question again, now that the local target has caught up with origin. This is the
	// shape the incident actually took: the work had been pushed to origin/main by another route,
	// and this machine's checkout only learned it during the reconcile a moment ago.
	if targetContainsSource(repoRoot, sourceSha, targetBefore) {
		return alreadyMergedOutcome(req.SessionID, target, sourceSha, targetBefore)
	}

	out := rebaseFastForward(repoRoot, req.Branch, sourceSha, target, req.SessionID, ffAtRoot,
		replayAnchor(repoRoot, req.SessionID, sourceSha, req.BaseSha))
	out.TargetBranch = target
	out.TargetShaBefore = targetBefore
	// The base the source was replayed ONTO. For this merge that is the target tip: the rebase puts
	// the target underneath, which is what makes the fast-forward afterwards a fast-forward.
	if out.RebaseBase == "" {
		out.RebaseBase = targetBefore
	}
	return out
}

// targetContainsSource answers "is this source already in that target" for two specific object
// names. Equality first, then ancestry — `git merge-base --is-ancestor X Y` already answers true
// when X == Y, but spelling equality out keeps the cheapest and commonest case free of a subprocess
// and makes the two answers the receipt distinguishes visible in the code that produces them.
//
// Conservative on every error: an unknown answer is "not contained", which routes to the ordinary
// merge rather than to a claim that the work is already safe.
func targetContainsSource(repoRoot, sourceSha, targetSha string) bool {
	sourceSha = strings.TrimSpace(sourceSha)
	targetSha = strings.TrimSpace(targetSha)
	if sourceSha == "" || targetSha == "" {
		return false
	}
	if strings.EqualFold(sourceSha, targetSha) {
		return true
	}
	_, err := git(repoRoot, "merge-base", "--is-ancestor", sourceSha, targetSha)
	return err == nil
}

// alreadyMergedOutcome is the receipt for a merge that had nothing to do.
//
// `TargetShaBefore == MergedSha` is the mechanical proof that no target moved, and `RebaseBase`
// stays empty, which the control plane reads as `NOT_REBASED`. Nothing here touches the repository:
// no temp worktree, no `reset --hard`, no rebase, no push. That is the entire point — the previous
// behaviour did all four before discovering it had nothing to merge.
func alreadyMergedOutcome(sessionID, target, sourceSha, targetSha string) mergeOutcome {
	logln(fmt.Sprintf("%s already contains %s for session %s — nothing to merge",
		target, shortSha(sourceSha), sessionID))
	return mergeOutcome{
		Status:          "merged",
		AlreadyMerged:   true,
		MergedSha:       targetSha,
		SourceSha:       sourceSha,
		TargetBranch:    target,
		TargetShaBefore: targetSha,
	}
}

// replayAnchor picks the commit the merge replays FROM: the session's fork point, so only the
// session's own commits land on the target. Without one, `git rebase <target>` replays everything
// in `<target>..<branch>` — for a branch forked from main and merged into a different target (a
// develop/release branch), that silently carries main's commits into it too.
//
// The fork point comes from the local base ref while the session's checkout is alive, else from
// the control plane's record (MergeCommand.BaseSha, reported at /complete). Returns "" — replay
// everything, exactly as before — unless the anchor can be *proven* usable here: a commit this
// repo has, on the source branch's own history, with work after it. An anchor wrong in the other
// direction (too new, sitting on top of session commits) would silently drop work from the merge,
// so anything unproven takes the conservative path instead.
func replayAnchor(repoRoot, sessionID, sourceSha, serverBase string) string {
	candidates := make([]string, 0, 2)
	if local, err := git(repoRoot, "rev-parse", "--verify", "--quiet", baseRefName(sessionID)); err == nil && local != "" {
		candidates = append(candidates, local)
	}
	if serverBase = strings.TrimSpace(serverBase); serverBase != "" {
		candidates = append(candidates, serverBase)
	}
	for _, candidate := range candidates {
		sha, err := git(repoRoot, "rev-parse", "--verify", "--quiet", candidate+"^{commit}")
		if err != nil || sha == "" {
			continue // not a commit this repo has (a foreign sha, a pruned object)
		}
		if _, err := git(repoRoot, "merge-base", "--is-ancestor", sha, sourceSha); err != nil {
			continue // not on this branch's history — it can't be where it forked
		}
		// Nothing after the fork means the anchor is the tip: replaying from it would merge an
		// empty range. Let the unanchored path handle it (and report "already merged" as before).
		if n, err := git(repoRoot, "rev-list", "--count", sha+".."+sourceSha); err != nil || n == "0" {
			continue
		}
		return sha
	}
	return ""
}

// rebaseFastForward replays source's commits onto target and advances target to the result by
// fast-forward, yielding a linear history with no merge commit. The replay runs on a temp branch
// (a copy of source) in a throwaway worktree, so the session's own branch is left intact even if
// it's checked out. ffAtRoot picks how target is advanced: in place at the repo root
// (merge --ff-only) when it's the root checkout, else by moving its ref (branch -f) when it's
// checked out nowhere — both strict fast-forwards, since the rebase put target underneath. On a
// rebase conflict it aborts and reports "conflict". Inline identity so the rewritten commits
// never fail on a runner with no git user.*.
//
// `onto` (see replayAnchor) bounds what gets replayed: given the session's fork point, only its
// own commits move, rather than everything the branch carries ahead of the target. Empty replays
// `<target>..<source>`, the original behavior. The two are equivalent whenever the fork point is
// already in the target — the usual fork-from-main, merge-to-main case — and differ only where the
// branch sits on commits the target doesn't have.
//
// When origin tracks target, it pushes the rebased result to origin/<target> BEFORE advancing the
// local branch, so the local target only ever moves to what origin already accepted — local merges
// can't pile up unpushed and silently diverge from origin. A concurrent push that beats ours is
// rejected (non-fast-forward); we re-sync to the new origin tip and replay, up to mergePushAttempts.
func rebaseFastForward(repoRoot, source, sourceSha, target, sessionID string, ffAtRoot bool, onto string) mergeOutcome {
	tmpBranch := "orbit/_rebase-" + sessionID
	tmp := filepath.Join(worktreesDir(), "_rebase-"+sessionID)
	// Clear any leftover from a crashed prior attempt before staging fresh.
	_, _ = git(repoRoot, "worktree", "remove", "--force", tmp)
	_ = os.RemoveAll(tmp)
	_, _ = git(repoRoot, "branch", "-D", tmpBranch)

	// Temp branch = source's tip, checked out in the throwaway worktree. A fresh branch (not
	// source) means the rebase here never moves the session's branch.
	if _, err := git(repoRoot, "worktree", "add", "-b", tmpBranch, tmp, sourceSha); err != nil {
		return mergeOutcome{Status: "error", Message: clip(fmt.Sprintf("could not stage rebase of %s: %s", source, gitStderr(err)), 1000)}
	}
	defer func() {
		_, _ = git(repoRoot, "worktree", "remove", "--force", tmp)
		_ = os.RemoveAll(tmp)
		_, _ = git(repoRoot, "branch", "-D", tmpBranch)
	}()

	pushToOrigin := originTracks(repoRoot, target)
	// Whether origin already accepted the rebased commits. It decides what a failure to advance the
	// LOCAL target means: the work is upstream either way, and only this machine's checkout lags.
	pushed := false

	// Replay the temp branch onto target and, when origin tracks target, push the result so
	// origin/<target> advances in lockstep. A push that origin rejects (it moved under us) is
	// retried: re-sync the local target to the new tip and replay onto it. The loop ends on a clean
	// push, a local-only target (nothing to push), a rebase conflict, or a divergence we can't fix.
	for attempt := 0; ; attempt++ {
		// Retry after origin moved: put the temp branch back on the source tip so this attempt
		// replays exactly what the first one did. Without the reset the second `rebase` would
		// start from the already-replayed result, whose relationship to `onto` no longer holds.
		if attempt > 0 {
			if _, err := git(tmp, "reset", "--hard", sourceSha); err != nil {
				return mergeOutcome{Status: "error", Message: clip(fmt.Sprintf("could not restage %s for retry: %s", source, gitStderr(err)), 1000)}
			}
		}
		rebase := []string{"-c", "user.email=runner@orbit", "-c", "user.name=Orbit Runner", "rebase"}
		if onto != "" {
			rebase = append(rebase, "--onto", target, onto)
		} else {
			rebase = append(rebase, target)
		}
		// A conflict stops the rebase; abort so the worktree is left clean before we tear it down
		// (git writes "CONFLICT ..." to stdout, returned as `out`).
		if out, err := git(tmp, rebase...); err != nil {
			msg := strings.TrimSpace(out + "\n" + gitStderr(err))
			// The paths git stopped on, read BEFORE the abort clears the index. They go on the
			// receipt: "it conflicted" and "it conflicted in these three files" are answers to
			// different questions, and only the second one tells anybody where to start.
			unmerged, _ := git(tmp, "diff", "--name-only", "--diff-filter=U")
			_, _ = git(tmp, "rebase", "--abort")
			return mergeOutcome{
				Status:    "conflict",
				Message:   clip(msg, 1000),
				SourceSha: sourceSha,
				Conflicts: splitLines(unmerged),
			}
		}
		// The local fast-forward at the end writes exactly the paths this replay changed, and git
		// refuses it if any of them is modified in that checkout. Finding that out AFTER the push
		// would strand the merge half-done — the work on origin, the local target behind — so check
		// it here, while nothing has moved yet. Only an overlap counts: unrelated edits in the
		// shared checkout are none of this merge's business.
		if ffAtRoot {
			if clash := ffClash(repoRoot, tmp, target); len(clash) > 0 {
				return mergeOutcome{Status: "error", Message: clip(fmt.Sprintf(
					"this branch and this machine's %s checkout both change %s — that edit is uncommitted in %s, so the merge would overwrite it. Commit or set it aside, then retry.",
					target, namePaths(clash), target), 1000)}
			}
		}
		if !pushToOrigin {
			break // local-only target (or no origin): nothing to push.
		}
		// Push the rebased commits, fast-forwarding origin/<target> (target == origin/<target> after
		// the reconcile, so origin is an ancestor of the rebased tip unless it just moved).
		out, err := git(tmp, "push", "origin", "HEAD:refs/heads/"+target)
		if err == nil {
			pushed = true
			break
		}
		combined := strings.TrimSpace(out + "\n" + gitStderr(err))
		if !isNonFastForward(combined) {
			// Auth/network/other — origin untouched, local target not yet advanced. Surface it.
			return mergeOutcome{Status: "error", Message: clip(fmt.Sprintf("could not push %s to origin: %s", target, combined), 1000)}
		}
		if attempt+1 >= mergePushAttempts {
			return mergeOutcome{Status: "error", Message: fmt.Sprintf("origin/%s kept advancing during the merge — retry", target)}
		}
		// Origin advanced under us. Fast-forward the local target to the new origin tip (or surface
		// a genuine divergence) so the next iteration replays onto the up-to-date base.
		if oc := reconcileTargetWithOrigin(repoRoot, target); oc != nil {
			return *oc
		}
	}

	// Advance target to the rebased commits — a strict fast-forward (target is now an ancestor).
	// Git declines this one when the fast-forward would overwrite a file someone left modified in
	// that checkout; say which checkout is in the way (and, when origin already took the commits,
	// that only this machine lags) rather than surfacing git's bare "your local changes…".
	if ffAtRoot {
		if out, err := git(repoRoot, "merge", "--ff-only", tmpBranch); err != nil {
			detail := strings.TrimSpace(out + "\n" + gitStderr(err))
			if pushed {
				return mergeOutcome{Status: "error", Message: clip(fmt.Sprintf(
					"pushed to origin/%s — but this machine's %s checkout could not fast-forward: %s",
					target, target, detail), 1000)}
			}
			return mergeOutcome{Status: "error", Message: clip(fmt.Sprintf(
				"this machine's %s checkout could not fast-forward: %s", target, detail), 1000)}
		}
	} else if _, err := git(repoRoot, "branch", "-f", target, tmpBranch); err != nil {
		return mergeOutcome{Status: "error", Message: clip(fmt.Sprintf("could not advance %s: %s", target, gitStderr(err)), 1000)}
	}

	sha, _ := git(repoRoot, "rev-parse", target)
	logln(fmt.Sprintf("rebased %s onto %s (%s) for session %s", source, target, shortSha(sha), sessionID))
	return mergeOutcome{Status: "merged", MergedSha: sha, SourceSha: sourceSha}
}

// ffClash returns the paths that both the rebased result (in worktree `tmp`) and the target's
// checkout have changed — i.e. the files the final fast-forward would overwrite, which is the only
// reason git declines it. Empty means the checkout can be dirty all it likes and the merge lands.
func ffClash(repoRoot, tmp, target string) []string {
	changed, err := git(tmp, "diff", "--name-only", target+"..HEAD")
	if err != nil {
		return nil // can't tell → let the fast-forward itself be the judge
	}
	dirty := map[string]bool{}
	for _, p := range inspectRepoRoot(repoRoot).Paths {
		dirty[p] = true
	}
	var clash []string
	for _, p := range splitLines(changed) {
		if dirty[p] {
			clash = append(clash, p)
		}
	}
	return clash
}

// namePaths renders a short, readable file list for an error message.
func namePaths(paths []string) string {
	shown := paths[:min(len(paths), 3)]
	out := strings.Join(shown, ", ")
	if len(paths) > len(shown) {
		out += fmt.Sprintf(" (+%d more)", len(paths)-len(shown))
	}
	return out
}

// mergePushAttempts bounds how many times a merge re-syncs and re-pushes when a concurrent push to
// origin keeps beating ours — enough to absorb a racing writer, not an infinite loop.
const mergePushAttempts = 3

// originTracks reports whether the repo has an 'origin' remote that already carries <target>, i.e.
// a successful merge should push the advance back to origin/<target>. False for local-init repos
// (no origin) and for branches that live only locally — both keep the merge local-only.
func originTracks(repoRoot, target string) bool {
	if _, err := git(repoRoot, "remote", "get-url", "origin"); err != nil {
		return false
	}
	_, err := git(repoRoot, "rev-parse", "--verify", "--quiet", "origin/"+target)
	return err == nil
}

// isNonFastForward reports whether a failed `git push` was rejected because origin moved ahead (the
// retryable case), versus an auth/network/other failure that retrying won't fix.
func isNonFastForward(pushOutput string) bool {
	s := strings.ToLower(pushOutput)
	return strings.Contains(s, "non-fast-forward") ||
		strings.Contains(s, "fetch first") ||
		strings.Contains(s, "[rejected]")
}

// reconcileTargetWithOrigin fast-forwards the local target branch to origin/<target> before a
// merge so the rebase replays onto the same tip agents and "Resolve in session" reconcile against
// (origin/<target>), not a stale local ref. Returns nil when there's nothing to do (no 'origin'
// remote, the target isn't tracked on origin, or it's already in sync / already ahead of origin),
// and an *mergeOutcome{error} when the local target has diverged from origin or the fast-forward
// fails — both surfaced rather than merged onto the wrong base. Best-effort on the network: a
// failed fetch just proceeds against whatever origin ref the repo already has.
func reconcileTargetWithOrigin(repoRoot, target string) *mergeOutcome {
	// No 'origin' remote (e.g. an auto-init'd local repo) → nothing to reconcile; behave as before.
	if _, err := git(repoRoot, "remote", "get-url", "origin"); err != nil {
		return nil
	}
	_, _ = git(repoRoot, "fetch", "origin", target) // read-only; transient failures fall through
	remoteRef := "origin/" + target
	if _, err := git(repoRoot, "rev-parse", "--verify", "--quiet", remoteRef); err != nil {
		return nil // target isn't tracked on origin (a local-only branch) → nothing to reconcile
	}
	localSha, _ := git(repoRoot, "rev-parse", target)
	remoteSha, _ := git(repoRoot, "rev-parse", remoteRef)
	if localSha == remoteSha {
		return nil // already in sync
	}
	// Local already contains origin (local is ahead) → the rebase base is fine as-is.
	if _, err := git(repoRoot, "merge-base", "--is-ancestor", remoteRef, target); err == nil {
		return nil
	}
	// Local is behind origin (origin is a strict descendant) → fast-forward the local target up to
	// origin so the branch replays onto the up-to-date tip.
	if _, err := git(repoRoot, "merge-base", "--is-ancestor", target, remoteRef); err == nil {
		if cur, _ := git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD"); cur == target {
			// Target is checked out at the repo root: fast-forward in place. Git refuses on its own
			// when the sync would overwrite a locally-modified file, so unrelated edits in that
			// shared checkout no longer block the sync (see mergeToMain's precondition comment).
			if out, err := git(repoRoot, "merge", "--ff-only", remoteRef); err != nil {
				return &mergeOutcome{Status: "error", Message: clip(fmt.Sprintf(
					"could not sync the local %s checkout with origin/%s: %s",
					target, target, strings.TrimSpace(out+"\n"+gitStderr(err))), 1000)}
			}
		} else if branchWorktree(repoRoot, target) != "" {
			return &mergeOutcome{Status: "error", Message: fmt.Sprintf("%q is checked out in another worktree — can't sync it with origin", target)}
		} else if _, err := git(repoRoot, "branch", "-f", target, remoteRef); err != nil {
			return &mergeOutcome{Status: "error", Message: clip(fmt.Sprintf("could not fast-forward %s to origin: %s", target, gitStderr(err)), 1000)}
		}
		return nil
	}
	// Neither is an ancestor of the other → genuinely diverged. Rebasing onto the stale local
	// target is exactly the phantom-conflict bug, so surface it instead of merging blindly.
	return &mergeOutcome{Status: "error", Message: fmt.Sprintf(
		"local %s has diverged from origin/%s — reconcile it with origin first (git checkout %s && git merge origin/%s), then retry the merge",
		target, target, target, target)}
}

// branchWorktree returns the path of the worktree that has `branch` checked out, or "" if none
// does — used to refuse advancing a target that's checked out somewhere (we'd corrupt that
// checkout). Best-effort: "" on any git error.
func branchWorktree(repoRoot, branch string) string {
	out, err := git(repoRoot, "worktree", "list", "--porcelain")
	if err != nil {
		return ""
	}
	want := "refs/heads/" + branch
	path := ""
	for _, line := range strings.Split(out, "\n") {
		if p, ok := strings.CutPrefix(line, "worktree "); ok {
			path = p
		} else if ref, ok := strings.CutPrefix(line, "branch "); ok && ref == want {
			return path
		}
	}
	return ""
}

// Working-tree states inspectRepoRoot classifies a checkout into. The first two are ordinary
// (merges still fast-forward into a dirty checkout — git only refuses on the files it would
// overwrite); the rest are half-finished operations that block every merge into that checkout
// until someone resolves them.
const (
	repoStateClean      = "clean"
	repoStateDirty      = "dirty"
	repoStateUnmerged   = "unmerged"
	repoStateMerge      = "merge"
	repoStateRebase     = "rebase"
	repoStateCherryPick = "cherry-pick"
	repoStateRevert     = "revert"
)

// repoStatePathCap bounds the reported file list: enough to recognize what's in the way, small
// enough to ride along on every heartbeat.
const repoStatePathCap = 20

// repoRootState is the health of the shared checkout each agent's workDir sits in — the one every
// isolated session forks from and the one Orbit fast-forwards into. Worktree isolation covers the
// session's files, not this checkout: agents step into it for builds (the toolchain lives there),
// release/upgrade flows commit in it, and `git stash` is repo-global, so it drifts out from under
// Orbit with nothing watching. Used as the merge precondition's classifier and reported on the
// heartbeat so the control plane can say so before a merge fails.
type repoRootState struct {
	// State is one of the repoState* constants. "unmerged" without an operation in flight is the
	// classic wedge: a `git stash pop` that conflicted records no MERGE_HEAD, so even
	// `git merge --abort` refuses and every later fast-forward fails.
	State string
	// Paths are the tracked files in the way — conflicted ones first — capped at repoStatePathCap.
	Paths []string
	// Branch is the checkout's current branch; "" when HEAD is detached (normal mid-rebase).
	Branch string
}

// Blocked reports whether the checkout is mid-operation, i.e. nothing can fast-forward into it
// until it's resolved. A merely dirty checkout is NOT blocked.
func (s repoRootState) Blocked() bool {
	switch s.State {
	case repoStateUnmerged, repoStateMerge, repoStateRebase, repoStateCherryPick, repoStateRevert:
		return true
	}
	return false
}

// BlockedMessage explains a Blocked() checkout in the merge bar's voice: name the machine's shared
// checkout as the culprit, since the user is looking at one session's branch and every other
// session on this runner is failing the same way for the same reason.
func (s repoRootState) BlockedMessage(target string) string {
	what := "a half-finished git operation"
	switch s.State {
	case repoStateUnmerged:
		what = "an unresolved merge"
	case repoStateMerge:
		what = "an unfinished merge"
	case repoStateRebase:
		what = "an unfinished rebase"
	case repoStateCherryPick:
		what = "an unfinished cherry-pick"
	case repoStateRevert:
		what = "an unfinished revert"
	}
	files := ""
	if n := len(s.Paths); n > 0 {
		shown := s.Paths[:min(n, 3)]
		files = " on " + strings.Join(shown, ", ")
		if n > len(shown) {
			files += fmt.Sprintf(" (+%d more)", n-len(shown))
		}
	}
	return fmt.Sprintf(
		"this machine's %s checkout is stuck in %s%s — that blocks every merge on this runner, not just this branch",
		target, what, files)
}

// inspectRepoRoot classifies dir's working tree (see repoRootState). Best-effort and read-only:
// anything git won't answer reports clean, so a probe failure never invents a blocked merge.
//
// Paths come from `git diff --name-only` rather than `git status --porcelain` on purpose: git()
// trims its output, which eats the porcelain status column's leading space and shifts every
// fixed-offset parse by one on the first line.
func inspectRepoRoot(dir string) repoRootState {
	// Tracked changes vs HEAD, staged or not. Untracked files are excluded by construction — they
	// never block a fast-forward unless it would create that exact path, which git catches itself.
	changed, err := git(dir, "diff", "--name-only", "HEAD")
	if err != nil {
		return repoRootState{State: repoStateClean}
	}
	branch, _ := git(dir, "symbolic-ref", "--quiet", "--short", "HEAD")
	// Conflict stages live in the index, so this one compares index↔worktree: passing HEAD here
	// reports them as ordinary modifications and the filter matches nothing.
	unmerged, _ := git(dir, "diff", "--name-only", "--diff-filter=U")
	conflicted := splitLines(unmerged)
	isConflicted := make(map[string]bool, len(conflicted))
	for _, p := range conflicted {
		isConflicted[p] = true
	}
	var modified []string
	for _, p := range splitLines(changed) {
		if !isConflicted[p] {
			modified = append(modified, p)
		}
	}
	paths := append(conflicted, modified...)
	if len(paths) > repoStatePathCap {
		paths = paths[:repoStatePathCap]
	}
	state := repoStateClean
	switch {
	case gitPathExists(dir, "rebase-merge"), gitPathExists(dir, "rebase-apply"):
		state = repoStateRebase
	case gitPathExists(dir, "MERGE_HEAD"):
		state = repoStateMerge
	case gitPathExists(dir, "CHERRY_PICK_HEAD"):
		state = repoStateCherryPick
	case gitPathExists(dir, "REVERT_HEAD"):
		state = repoStateRevert
	case len(conflicted) > 0:
		state = repoStateUnmerged
	case len(modified) > 0:
		state = repoStateDirty
	}
	return repoRootState{State: state, Paths: paths, Branch: branch}
}

// splitLines turns git's newline-separated path output into a slice, dropping the empty string
// an absent/whitespace-only result would otherwise contribute.
func splitLines(out string) []string {
	if strings.TrimSpace(out) == "" {
		return nil
	}
	var lines []string
	for _, ln := range strings.Split(out, "\n") {
		if ln = strings.TrimSpace(ln); ln != "" {
			lines = append(lines, ln)
		}
	}
	return lines
}

// gitPathExists reports whether a per-worktree git control file (MERGE_HEAD, rebase-merge, …)
// exists. Resolved through `rev-parse --git-path` rather than dir/.git/<name> so it stays correct
// inside a linked worktree, where those files live under .git/worktrees/<id>/.
func gitPathExists(dir, name string) bool {
	p, err := git(dir, "rev-parse", "--git-path", name)
	if err != nil || p == "" {
		return false
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(dir, p)
	}
	_, statErr := os.Stat(p)
	return statErr == nil
}

// commitOutcome is what commitWorktree reports: "committed" advanced the branch, "nochange"
// means the tree was already clean, "error" means a precondition failed / git errored.
type commitOutcome struct {
	Status  string
	Message string
}

// commitWorktree commits a live session's uncommitted worktree changes onto its branch, so
// the user can checkpoint (and then merge) without ending the session. It operates on the
// session's own checkout (worktreesDir()/SessionID), which is separate from the primary repo
// on main, so it never disturbs main or another session. Returns "nochange" when the tree is
// already clean, "committed" on a new commit, "error" if the checkout is missing or git
// fails. Serialized per session by the runloop's in-flight guard.
func commitWorktree(req CommitCommand) commitOutcome {
	wtPath := filepath.Join(worktreesDir(), req.SessionID)
	if !isGitRepo(wtPath) {
		return commitOutcome{Status: "error", Message: "no live worktree for this session"}
	}
	if _, err := git(wtPath, "add", "-A"); err != nil {
		return commitOutcome{Status: "error", Message: clip(gitStderr(err), 1000)}
	}
	// `diff --cached --quiet` exits 0 when nothing is staged → the tree is already clean.
	if _, err := git(wtPath, "diff", "--cached", "--quiet"); err == nil {
		return commitOutcome{Status: "nochange"}
	}
	// Summarize the staged diff into a real Conventional-Commits message (one-shot headless
	// Claude); fall back to a diffstat subject, then the bare branch slug, so the history
	// reads like hand-written commits instead of "orbit: commit <branch>".
	msg := generateCommitMessage(wtPath, diffstatFallbackMessage(wtPath, req.Branch))
	// Inline identity + --no-verify so the commit never fails on a runner with no git user.*
	// set or a repo pre-commit hook (mirrors finalizeWorktree).
	if _, err := git(wtPath,
		"-c", "user.email=runner@orbit", "-c", "user.name=Orbit Runner",
		"commit", "--no-verify", "-m", msg); err != nil {
		return commitOutcome{Status: "error", Message: clip(gitStderr(err), 1000)}
	}
	logln(fmt.Sprintf("committed worktree changes for session %s onto %s", req.SessionID, req.Branch))
	return commitOutcome{Status: "committed"}
}

// commitMsgModel is the Claude alias used to summarize a commit's diff — a fast, cheap tier is
// plenty for a one-line message, and the call runs on the user's own subscription.
const commitMsgModel = "sonnet"

// commitMsgPrompt instructs the one-shot Claude; the staged diff is appended verbatim.
const commitMsgPrompt = `Generate a git commit message for the staged changes below.

Rules:
- Use Conventional Commits format (feat:, fix:, chore:, refactor:, docs:, test:, etc.).
- Subject line: imperative mood, max 72 chars, no trailing period.
- Output ONLY the raw commit message. No markdown, no code fences, no surrounding quotes, no preamble like "Here is".
- Add a short body after a blank line only if the change is non-trivial.

Diff:
`

// generateCommitMessage asks a one-shot headless Claude to summarize the session's staged
// worktree diff into a Conventional-Commits message, so a user-initiated checkpoint commit
// reads like a hand-written one instead of "orbit: commit <branch>". Best-effort: on any
// failure (claude missing / not signed in / timeout / empty reply) it returns `fallback`.
// Runs in a throwaway temp dir so the target repo's CLAUDE.md / .mcp.json can't slow it down
// or pull in tools, and bounds the diff so the call stays fast and cheap.
func generateCommitMessage(wtPath, fallback string) string {
	diff, err := git(wtPath, "diff", "--cached")
	if err != nil || strings.TrimSpace(diff) == "" {
		return fallback
	}
	const maxDiffRunes = 12000 // a few thousand tokens characterizes any change; keeps it quick
	if r := []rune(diff); len(r) > maxDiffRunes {
		diff = string(r[:maxDiffRunes]) + "\n…(diff truncated)"
	}
	tmp, err := os.MkdirTemp("", "orbit-cmsg-")
	if err != nil {
		return fallback
	}
	defer os.RemoveAll(tmp)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "claude", "-p", commitMsgPrompt+diff,
		"--model", commitMsgModel, "--output-format", "text")
	cmd.Dir = tmp
	out, err := cmd.Output()
	if err != nil {
		return fallback
	}
	if msg := cleanCommitMessage(string(out)); msg != "" {
		return msg
	}
	return fallback
}

// cleanCommitMessage normalizes the model's reply into a commit message: it strips a ```-fenced
// wrapper and a single layer of surrounding quotes/backticks the model may add despite the
// instructions, trims whitespace, and caps the length so a runaway body can't bloat history.
// Returns "" when nothing usable remains (caller then falls back).
func cleanCommitMessage(raw string) string {
	s := strings.TrimSpace(raw)
	if strings.HasPrefix(s, "```") {
		if i := strings.IndexByte(s, '\n'); i >= 0 {
			s = s[i+1:]
		}
		if j := strings.LastIndex(s, "```"); j >= 0 {
			s = s[:j]
		}
		s = strings.TrimSpace(s)
	}
	for _, q := range []string{`"`, "'", "`"} {
		if len(s) >= 2 && strings.HasPrefix(s, q) && strings.HasSuffix(s, q) {
			s = strings.TrimSpace(s[1 : len(s)-1])
			break
		}
	}
	const maxRunes = 2000
	if r := []rune(s); len(r) > maxRunes {
		s = strings.TrimSpace(string(r[:maxRunes]))
	}
	return s
}

// diffstatFallbackMessage builds a deterministic subject from the staged file list, so even
// without the LLM the message beats the bare branch slug. Falls back to "orbit: commit
// <branch>" when git can't enumerate the staged diff.
func diffstatFallbackMessage(wtPath, branch string) string {
	names, err := git(wtPath, "diff", "--cached", "--name-only")
	if err != nil || strings.TrimSpace(names) == "" {
		return "orbit: commit " + branch
	}
	files := strings.Split(strings.TrimSpace(names), "\n")
	switch {
	case len(files) == 1:
		return "Update " + filepath.Base(files[0])
	case len(files) <= 3:
		bases := make([]string, len(files))
		for i, f := range files {
			bases[i] = filepath.Base(f)
		}
		return "Update " + strings.Join(bases, ", ")
	default:
		return fmt.Sprintf("Update %s and %d more files", filepath.Base(files[0]), len(files)-1)
	}
}

// gitStderr extracts git's stderr from a failed git() call (Output() puts it on ExitError).
func gitStderr(err error) string {
	if ee, ok := err.(*exec.ExitError); ok {
		return strings.TrimSpace(string(ee.Stderr))
	}
	if err != nil {
		return err.Error()
	}
	return ""
}

// clip truncates s to at most n runes, appending an ellipsis when it cut anything.
func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// gcWorktrees removes leftover session checkouts that the control plane confirms are gone —
// a session the user completed or moved to Trash, or one that no longer exists. `live` is the set of
// session ids the runner is currently driving (never candidates). A checkout for a session
// that is merely parked/failed but still resumable is KEPT, so an idle-parked session's
// worktree survives a runner restart. Branches are always preserved. On any query failure the
// candidates are left untouched — GC never destroys a checkout it couldn't confirm removable.
func gcWorktrees(t *Transport, live map[string]bool) {
	root := worktreesDir()
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	var candidates []string
	for _, e := range entries {
		if e.IsDir() && !live[e.Name()] {
			candidates = append(candidates, e.Name())
		}
	}
	removable, err := t.worktreesRemovable(candidates)
	if err != nil {
		logln("gc: worktrees-removable query failed, keeping all orphan checkouts:", err)
		return
	}
	for _, name := range removable {
		path := filepath.Join(root, name)
		// Resolve the main repo via the checkout's common git dir (<repo>/.git), so we can
		// `worktree remove` it cleanly; fall back to a plain dir removal otherwise.
		if common, err := git(path, "rev-parse", "--git-common-dir"); err == nil && common != "" {
			if !filepath.IsAbs(common) {
				common = filepath.Join(path, common)
			}
			repoRoot := filepath.Dir(common)
			if _, err := git(repoRoot, "worktree", "remove", "--force", path); err == nil {
				_, _ = git(repoRoot, "update-ref", "-d", baseRefName(name))
				logln("gc: removed orphan worktree", name)
				continue
			}
		}
		_ = os.RemoveAll(path)
		logln("gc: removed orphan worktree dir", name)
	}
}

// gcUploads removes per-session attachment scratch dirs (writeUpload) whose session is no
// longer live, mirroring gcWorktrees. Uploads live outside the worktree, so they get their own
// sweep — otherwise a crashed or never-resumed session would leak its uploads forever.
func gcUploads(live map[string]bool) {
	entries, err := os.ReadDir(uploadsRootDir())
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() || live[e.Name()] {
			continue
		}
		_ = os.RemoveAll(filepath.Join(uploadsRootDir(), e.Name()))
		logln("gc: removed orphan uploads dir", e.Name())
	}
}
