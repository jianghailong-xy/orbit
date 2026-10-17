package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// ALREADY_LANDED: a session's commits already on origin/<target> under other names.
//
// These replay the 2026-10-11 incident (session 34dr6F2XoYC36qeRIXd3w on workstation-gpu). Orbit had
// merged the session's two commits as rebase copies (09:36Z e4b9d0e→99cd545, 10:34Z bba5d7b), origin
// then built on them, and the branch was rewritten — the second change recommitted onto the first
// commit (0032a5e, parent e4b9d0e). Asked to merge again, the merge reported TARGET_DIVERGED (local
// main had two unpushed commits) and the recovery check a SOURCE_REPLAY conflict: replaying from the
// fork point re-applied each commit over its own copy and the fix that followed it. Every fixture here
// first shows that the old replay (`git rebase --onto <target> <fork>`) conflicts on it.

const landedSessionID = "34dr6F2XoYC36qeRIXd3w"

// landedFixture is a repository whose session branch, orbit/agents, forked main at base, and whose
// first commit Orbit merged as a rebase copy because origin had moved before that merge.
type landedFixture struct {
	repo, bare, base string
	s1, s1Copy       string
	req              MergeCommand
}

func newLandedFixture(t *testing.T) *landedFixture {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	f := &landedFixture{repo: initRepo(t)}
	f.bare = addOriginBare(t, f.repo)
	f.base = mustGit(t, f.repo, "rev-parse", "main")
	// The live checkout's base ref, which resolveBaseSha keeps at merge-base(main, branch): main only
	// ever gains copies of the session's commits, so it stays at the fork.
	mustGit(t, f.repo, "update-ref", baseRefName(landedSessionID), f.base)
	f.req = MergeCommand{WorkDir: f.repo, Branch: "orbit/agents", SessionID: landedSessionID, BaseSha: f.base}
	f.s1 = f.commit(t, "AgentsModel.swift", "agents: v1\n", "Agents model")
	advanceOriginMain(t, f.repo, "elsewhere.txt", "elsewhere\n")
	f.s1Copy = f.mergeCopy(t)
	return f
}

// commit adds a commit to the session branch, creating it at base the first time.
func (f *landedFixture) commit(t *testing.T, file, content, msg string) string {
	t.Helper()
	if branchExists(f.repo, "orbit/agents") {
		mustGit(t, f.repo, "checkout", "orbit/agents")
	} else {
		mustGit(t, f.repo, "checkout", "-b", "orbit/agents", f.base)
	}
	commitFile(t, f.repo, file, content, msg)
	sha := mustGit(t, f.repo, "rev-parse", "HEAD")
	mustGit(t, f.repo, "checkout", "main")
	return sha
}

// mergeCopy is Orbit's merge of the branch as it stands, which pushes rebase copies to origin. The
// control plane then records the merge tip as the session's base, as runner-api's merge report does.
func (f *landedFixture) mergeCopy(t *testing.T) string {
	t.Helper()
	out := mergeToMain(f.req)
	if out.Status != "merged" || out.AlreadyMerged {
		t.Fatalf("fixture merge: %+v", out)
	}
	f.req.BaseSha = out.MergedSha
	return out.MergedSha
}

// buildOnOrigin lands a commit on origin/main from another clone: origin moves on while this machine's
// origin/main still names the tip it last fetched. Its author is "Upstream".
func (f *landedFixture) buildOnOrigin(t *testing.T, msg string, files map[string]string) string {
	t.Helper()
	other := t.TempDir()
	mustGit(t, other, "clone", "-q", f.bare, ".")
	mustGit(t, other, "config", "user.name", "Upstream")
	mustGit(t, other, "config", "user.email", "upstream@orbit")
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(other, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mustGit(t, other, "add", "-A")
	mustGit(t, other, "commit", "-q", "-m", msg)
	mustGit(t, other, "push", "-q", "origin", "HEAD:main")
	return mustGit(t, other, "rev-parse", "HEAD")
}

// localWork gives local main two commits origin never saw (8a95411 and 749188d in the incident).
func (f *landedFixture) localWork(t *testing.T) []string {
	t.Helper()
	commitFile(t, f.repo, "local-one.txt", "local one\n", "Local main's own work, first")
	first := mustGit(t, f.repo, "rev-parse", "main")
	commitFile(t, f.repo, "local-two.txt", "local two\n", "Local main's own work, second")
	return []string{mustGit(t, f.repo, "rev-parse", "main"), first}
}

// state is everything an answer that moves nothing must leave as it was: both targets, the source,
// main's reflog, the registered worktrees (the rebase scratch included) and the recovery branches.
func (f *landedFixture) state(t *testing.T) string {
	t.Helper()
	return strings.Join([]string{
		mustGit(t, f.repo, "rev-parse", "main"),
		mustGit(t, f.bare, "rev-parse", "main"),
		mustGit(t, f.repo, "rev-parse", "orbit/agents"),
		mergeReflog(t, f.repo, "main"),
		mustGit(t, f.repo, "worktree", "list", "--porcelain"),
		mustGit(t, f.repo, "for-each-ref", "refs/heads/orbit/recovery"),
		mustGit(t, f.repo, "status", "--porcelain"),
	}, "\n--\n")
}

// conflictsOfOldReplay replays source from anchor onto onto the way the merge did before — `git
// rebase --onto` — in a throwaway clone, and returns the paths it stopped on.
func conflictsOfOldReplay(t *testing.T, repo, bare, onto, anchor, source string) []string {
	t.Helper()
	tmp := t.TempDir()
	mustGit(t, tmp, "clone", "-q", "--shared", "--no-checkout", repo, ".")
	mustGit(t, tmp, "fetch", "-q", bare, "main") // origin's newest commits, which repo may not have fetched
	mustGit(t, tmp, "config", "user.name", "Test")
	mustGit(t, tmp, "config", "user.email", "test@orbit")
	mustGit(t, tmp, "checkout", "-q", "--detach", source)
	if _, err := git(tmp, "rebase", "--onto", onto, anchor); err == nil {
		t.Fatal("the old replay went through: this fixture is not the incident")
	}
	return splitLines(mustGit(t, tmp, "diff", "--name-only", "--diff-filter=U"))
}

func landedCommit(t *testing.T, repo, sha, sourceSha string) MergeRecoveryLandedCommit {
	t.Helper()
	fields := strings.Split(mustGit(t, repo, "show", "-s", "--format=%s%x1f%an%x1f%cI", sha), "\x1f")
	return MergeRecoveryLandedCommit{SourceSha: sourceSha,
		MergeRecoveryCommit: MergeRecoveryCommit{Sha: sha, Subject: fields[0], Author: fields[1], Date: fields[2]}}
}

func commitShas(commits []MergeRecoveryCommit) []string {
	shas := make([]string, 0, len(commits))
	for _, c := range commits {
		shas = append(shas, c.Sha)
	}
	return shas
}

func recoveryWorktrees(t *testing.T) []string {
	t.Helper()
	dirs, err := filepath.Glob(filepath.Join(worktreesDir(), mergeRecoveryWorktreePrefix+"*"))
	if err != nil {
		t.Fatal(err)
	}
	return dirs
}

// landedIncident is the incident in full: both session commits merged as rebase copies, origin fixed
// both files after them, and the branch rewritten onto the first commit.
type landedIncident struct {
	*landedFixture
	s2, s2Copy, fix, rewritten string
}

func newLandedIncident(t *testing.T) *landedIncident {
	t.Helper()
	f := newLandedFixture(t)
	inc := &landedIncident{landedFixture: f}
	inc.s2 = f.commit(t, "SessionListSwitchWiringTests.swift", "tests: v1\n", "Session list wiring tests")
	inc.s2Copy = f.mergeCopy(t)
	inc.fix = f.buildOnOrigin(t, "Fix agents model and wiring tests", map[string]string{
		"AgentsModel.swift":                  "agents: v1 fixed\n",
		"SessionListSwitchWiringTests.swift": "tests: v1 fixed\n",
	})
	// The rewrite: back to the first commit, the second change committed again under a new name.
	mustGit(t, f.repo, "checkout", "orbit/agents")
	mustGit(t, f.repo, "reset", "--hard", f.s1)
	commitFile(t, f.repo, "SessionListSwitchWiringTests.swift", "tests: v1\n", "Session list wiring tests, rewritten")
	inc.rewritten = mustGit(t, f.repo, "rev-parse", "HEAD")
	mustGit(t, f.repo, "checkout", "main")
	if got := conflictsOfOldReplay(t, f.repo, f.bare, inc.fix, f.base, inc.rewritten); !slices.Equal(got, []string{"AgentsModel.swift"}) {
		t.Fatalf("the old replay should stop on the landed commit's own file, got %v", got)
	}
	return inc
}

// The incident: the merge answers ALREADY_LANDED, names where each commit landed, and moves nothing —
// not origin, not the local target (which the old reconcile would have fast-forwarded), not the source.
func TestMergeLandedRewrittenBranchReportsAlreadyLanded(t *testing.T) {
	inc := newLandedIncident(t)
	before := inc.state(t)

	out := mergeToMain(inc.req)

	r := out.Recovery
	if out.Status != "error" || r == nil || r.Code != "ALREADY_LANDED" {
		t.Fatalf("want ALREADY_LANDED, got %q (%s) %+v", out.Status, out.Message, r)
	}
	if len(out.Conflicts) != 0 || len(r.Conflicts) != 0 {
		t.Errorf("conflicts %v: each would be a commit against its own copy", out.Conflicts)
	}
	root := mustGit(t, inc.repo, "rev-parse", "--show-toplevel")
	if r.TargetBranch != "main" || r.RepoRoot != root || r.SourceSha != inc.rewritten || r.LocalSha != inc.s2Copy ||
		r.RemoteSha != inc.fix || r.CheckedAt == "" {
		t.Errorf("recovery identity: %+v", r)
	}
	if r.PreviewID != "" || r.CandidateSha != "" || r.RepairBranch != "" || r.RepairWorktree != "" || r.Patch != "" {
		t.Errorf("an answer with nothing to merge built a candidate: %+v", r)
	}
	want := []MergeRecoveryLandedCommit{
		landedCommit(t, inc.repo, inc.s2Copy, inc.rewritten),
		landedCommit(t, inc.repo, inc.s1Copy, inc.s1),
	}
	if !slices.Equal(r.LandedCommits, want) {
		t.Errorf("landed commits:\n got %+v\nwant %+v", r.LandedCommits, want)
	}
	if after := inc.state(t); after != before {
		t.Errorf("something moved:\nbefore:\n%s\nafter:\n%s", before, after)
	}
	payload, _ := json.Marshal(r)
	for _, key := range []string{`"code":"ALREADY_LANDED"`, `"landedCommits":[{"sha":"` + inc.s2Copy + `"`, `"sourceSha":"` + inc.rewritten + `"`} {
		if !strings.Contains(string(payload), key) {
			t.Errorf("wire payload lacks %s: %s", key, payload)
		}
	}
	// Asked again, the same answer: nothing was half-done the first time.
	if again := mergeToMain(inc.req); again.Recovery == nil || again.Recovery.Code != "ALREADY_LANDED" ||
		!slices.Equal(again.Recovery.LandedCommits, want) || inc.state(t) != before {
		t.Fatalf("repeat: %+v", again.Recovery)
	}
}

// The incident as it happened: local main also carried two unpushed commits. Everything of the
// session is on origin, so the answer is still ALREADY_LANDED rather than TARGET_DIVERGED, and the
// local commits — listed for review — are not pushed as part of this session.
func TestMergeLandedDivergedLocalTargetIsNotPushed(t *testing.T) {
	inc := newLandedIncident(t)
	local := inc.localWork(t)
	before := inc.state(t)

	out := mergeToMain(inc.req)

	r := out.Recovery
	if out.Status != "error" || r == nil || r.Code != "ALREADY_LANDED" {
		t.Fatalf("want ALREADY_LANDED over TARGET_DIVERGED, got %q (%s) %+v", out.Status, out.Message, r)
	}
	if r.LocalSha != local[0] || r.RemoteSha != inc.fix || !slices.Equal(commitShas(r.LocalCommits), local) ||
		!slices.Equal(commitShas(r.RemoteCommits), []string{inc.fix}) {
		t.Errorf("target histories: local %s %v, remote %s %v", r.LocalSha, commitShas(r.LocalCommits), r.RemoteSha, commitShas(r.RemoteCommits))
	}
	if len(r.LandedCommits) != 2 || r.LandedCommits[0].SourceSha != inc.rewritten || r.LandedCommits[1].SourceSha != inc.s1 {
		t.Errorf("landed commits: %+v", r.LandedCommits)
	}
	if after := inc.state(t); after != before {
		t.Errorf("something moved:\nbefore:\n%s\nafter:\n%s", before, after)
	}
	for _, sha := range local {
		if _, err := git(inc.bare, "cat-file", "-e", sha+"^{commit}"); err == nil {
			t.Errorf("local commit %s reached origin", sha)
		}
	}
}

// One commit landed as a copy that origin has since fixed, one is new: only the new one is replayed,
// onto origin's fix, and it merges without the conflict the landed commit would have raised.
func TestMergeLandedPartialMergeReplaysOnlyNewCommits(t *testing.T) {
	f := newLandedFixture(t)
	fix := f.buildOnOrigin(t, "Fix agents model", map[string]string{"AgentsModel.swift": "agents: v1 fixed\n"})
	fresh := f.commit(t, "Onboarding.swift", "onboarding: v1\n", "Onboarding screen")
	if got := conflictsOfOldReplay(t, f.repo, f.bare, fix, f.base, fresh); !slices.Equal(got, []string{"AgentsModel.swift"}) {
		t.Fatalf("the old replay should stop on the landed commit, got %v", got)
	}

	out := mergeToMain(f.req)

	if out.Status != "merged" || out.AlreadyMerged || len(out.Conflicts) != 0 || out.Recovery != nil {
		t.Fatalf("want a clean merge of the new commit, got %q (%s) %+v", out.Status, out.Message, out.Recovery)
	}
	added := splitLines(mustGit(t, f.bare, "rev-list", fix+"..main"))
	if len(added) != 1 || out.MergedSha != added[0] {
		t.Fatalf("origin gained %v, want the one replayed commit %s", added, out.MergedSha)
	}
	if subject := mustGit(t, f.bare, "show", "-s", "--format=%s", added[0]); subject != "Onboarding screen" {
		t.Errorf("replayed %q", subject)
	}
	if parent := mustGit(t, f.bare, "rev-parse", added[0]+"^"); parent != fix || out.TargetShaBefore != fix || out.RebaseBase != fix {
		t.Errorf("replayed onto %s (before %s, base %s), want origin's fix %s", parent, out.TargetShaBefore, out.RebaseBase, fix)
	}
	if got := mustGit(t, f.bare, "show", "main:AgentsModel.swift"); got != "agents: v1 fixed" {
		t.Errorf("origin's fix was overwritten: %q", got)
	}
	if mustGit(t, f.repo, "rev-parse", "main") != added[0] || mustGit(t, f.repo, "rev-parse", "orbit/agents") != fresh {
		t.Error("local main should advance to the merge and the source stay put")
	}
}

// The recovery check, after syncing: origin received the session's last commit by another route
// while this machine's origin/main still lagged, so only the sync shows that everything landed. The
// check answers ALREADY_LANDED with no candidate — no repair branch, no repair checkout — and neither
// the targets nor the source move.
func TestMergeLandedRecoveryCheckReportsAlreadyLandedWithoutCandidate(t *testing.T) {
	f := newLandedFixture(t)
	s2 := f.commit(t, "SessionListSwitchWiringTests.swift", "tests: v1\n", "Session list wiring tests")
	f.buildOnOrigin(t, "Unrelated upstream work", map[string]string{"upstream.txt": "upstream\n"})
	local := f.localWork(t)
	out := mergeToMain(f.req)
	if out.Recovery == nil || out.Recovery.Code != "TARGET_DIVERGED" {
		t.Fatalf("with the second commit unmerged the merge still stops at the diverged target, got %+v (%s)", out.Recovery, out.Message)
	}
	// Then the second change reaches origin as somebody else's commit, and origin fixes both files.
	copyOfS2 := f.buildOnOrigin(t, "Session list wiring tests", map[string]string{"SessionListSwitchWiringTests.swift": "tests: v1\n"})
	fix := f.buildOnOrigin(t, "Fix agents model and wiring tests", map[string]string{
		"AgentsModel.swift":                  "agents: v1 fixed\n",
		"SessionListSwitchWiringTests.swift": "tests: v1 fixed\n",
	})
	if got := conflictsOfOldReplay(t, f.repo, f.bare, fix, f.base, s2); !slices.Equal(got, []string{"AgentsModel.swift"}) {
		t.Fatalf("the old replay should stop on the landed commit, got %v", got)
	}
	before := f.state(t)

	req := f.req
	req.RecoveryAction, req.Recovery = "preview", out.Recovery
	check := mergeToMain(req)

	r := check.Recovery
	if check.Status != "error" || r == nil || r.Code != "ALREADY_LANDED" {
		t.Fatalf("want ALREADY_LANDED, got %q (%s) %+v", check.Status, check.Message, r)
	}
	if r.RemoteSha != fix || r.LocalSha != local[0] || !slices.Equal(commitShas(r.LocalCommits), local) {
		t.Errorf("the check did not compare against the synced origin: %+v", r)
	}
	want := []MergeRecoveryLandedCommit{landedCommit(t, f.bare, copyOfS2, s2), landedCommit(t, f.bare, f.s1Copy, f.s1)}
	if !slices.Equal(r.LandedCommits, want) || r.LandedCommits[0].Author != "Upstream" {
		t.Errorf("landed commits:\n got %+v\nwant %+v", r.LandedCommits, want)
	}
	if r.PreviewID != "" || r.CandidateSha != "" || r.CandidateTreeSha != "" || r.RepairBranch != "" || r.RepairWorktree != "" ||
		r.Patch != "" || r.PushCommits != nil || r.Check != nil {
		t.Errorf("an answer with nothing to merge built a candidate: %+v", r)
	}
	if dirs := recoveryWorktrees(t); len(dirs) != 0 {
		t.Errorf("repair checkouts created: %v", dirs)
	}
	// The sync's fetch updates origin/main, which is what it is for; nothing else may change.
	if after := f.state(t); after != before {
		t.Errorf("something moved:\nbefore:\n%s\nafter:\n%s", before, after)
	}
}

// The recovery check with one commit landed and one new: SOURCE_REPLAY replays only the new commit,
// the result is READY, and the reviewed candidate lands.
func TestMergeLandedRecoveryCheckReplaysOnlyTheRest(t *testing.T) {
	f := newLandedFixture(t)
	fix := f.buildOnOrigin(t, "Fix agents model", map[string]string{"AgentsModel.swift": "agents: v1 fixed\n"})
	fresh := f.commit(t, "Onboarding.swift", "onboarding: v1\n", "Onboarding screen")
	local := f.localWork(t)
	if got := conflictsOfOldReplay(t, f.repo, f.bare, fix, f.base, fresh); !slices.Equal(got, []string{"AgentsModel.swift"}) {
		t.Fatalf("the old replay should stop on the landed commit, got %v", got)
	}
	out := mergeToMain(f.req)
	if out.Recovery == nil || out.Recovery.Code != "TARGET_DIVERGED" {
		t.Fatalf("not everything landed, so the diverged target is reported as before, got %+v (%s)", out.Recovery, out.Message)
	}

	req := f.req
	req.RecoveryAction, req.Recovery = "preview", out.Recovery
	r := mergeToMain(req).Recovery

	if r == nil || r.Code != "READY" || r.Phase != "SOURCE_REPLAY" || len(r.Conflicts) != 0 || r.LandedCommits != nil {
		t.Fatalf("want a READY candidate, got %+v", r)
	}
	var replayed []string
	for _, c := range r.PushCommits {
		if !c.Merge && !slices.Contains(local, c.Sha) {
			replayed = append(replayed, c.Subject)
		}
	}
	if !slices.Equal(replayed, []string{"Onboarding screen"}) {
		t.Errorf("the session's part of the push is %v, want the new commit alone", replayed)
	}
	for file, content := range map[string]string{"AgentsModel.swift": "agents: v1 fixed", "Onboarding.swift": "onboarding: v1", "local-two.txt": "local two"} {
		if got := mustGit(t, f.repo, "show", r.CandidateSha+":"+file); got != content {
			t.Errorf("candidate %s = %q, want %q", file, got, content)
		}
	}
	req.RecoveryAction, req.Recovery = "apply", r
	if applied := mergeToMain(req); applied.Status != "merged" || mustGit(t, f.bare, "rev-parse", "main") != r.CandidateSha {
		t.Fatalf("apply: %+v", applied)
	}
}

// Only origin counts. A copy of the session's commit that only the local target has — a cherry-pick
// nobody pushed — is unpublished: the merge reports the local target ahead, the check builds the
// candidate that would publish it, and neither calls the commit landed.
func TestMergeLandedLocalOnlyCopyIsNotLanded(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	bare := addOriginBare(t, repo)
	base := mustGit(t, repo, "rev-parse", "main")
	mustGit(t, repo, "checkout", "-b", "orbit/feat")
	commitFile(t, repo, "feature.txt", "feature\n", "Feature")
	source := mustGit(t, repo, "rev-parse", "HEAD")
	mustGit(t, repo, "checkout", "main")
	mustGit(t, repo, "cherry-pick", "-x", source) // -x: a message of its own, so never the source's own name
	localCopy := mustGit(t, repo, "rev-parse", "main")
	req := MergeCommand{WorkDir: repo, Branch: "orbit/feat", SessionID: "local-copy", BaseSha: base}

	if landing := landedCommits(repo, base, source, base); landing.All || len(landing.Landed) != 0 || len(landing.Skip) != 0 {
		t.Fatalf("a local-only copy counted as landed: %+v", landing)
	}
	out := mergeToMain(req)
	if out.Status != "error" || out.Recovery == nil || out.Recovery.Code != "TARGET_AHEAD" {
		t.Fatalf("want TARGET_AHEAD, got %q (%s) %+v", out.Status, out.Message, out.Recovery)
	}
	req.RecoveryAction, req.Recovery = "preview", out.Recovery
	r := mergeToMain(req).Recovery
	if r == nil || r.Code != "READY" || r.LandedCommits != nil || !slices.Equal(commitShas(r.PushCommits), []string{localCopy}) {
		t.Fatalf("want a READY candidate publishing the local copy, got %+v", r)
	}
	if mustGit(t, bare, "rev-parse", "main") != base {
		t.Fatal("origin moved")
	}
}

// A genuine conflict is still one. The landed commit is left out, and the replay stops on the new
// edit that really does collide with origin's fix — in the merge, and in the recovery check, where
// the repair finishes the rebase and the check passes.
func TestMergeLandedRealConflictStillConflicts(t *testing.T) {
	f := newLandedFixture(t)
	fix := f.buildOnOrigin(t, "Fix agents model", map[string]string{"AgentsModel.swift": "agents: v1 fixed\n"})
	edit := f.commit(t, "AgentsModel.swift", "agents: v2\n", "Rename agents")

	out := mergeToMain(f.req)

	if out.Status != "conflict" || !slices.Equal(out.Conflicts, []string{"AgentsModel.swift"}) {
		t.Fatalf("want a conflict in AgentsModel.swift, got %q %v (%s)", out.Status, out.Conflicts, out.Message)
	}
	if !strings.Contains(out.Message, "Rename agents") || strings.Contains(out.Message, "Agents model") {
		t.Errorf("the conflict should be the new edit's, not the landed commit's: %s", out.Message)
	}
	// Local main caught up with origin before the replay, as it always has; origin did not move.
	if mustGit(t, f.bare, "rev-parse", "main") != fix || mustGit(t, f.repo, "rev-parse", "main") != fix {
		t.Error("a conflicted merge moved a target past origin's tip")
	}
	if scratchMidOperation(rebaseScratchDir(f.repo)) {
		t.Error("the conflicted replay was left in the scratch")
	}

	req := f.req
	req.RecoveryAction = "preview"
	r := mergeToMain(req).Recovery
	if r == nil || r.Code != "CONFLICT" || r.Phase != "SOURCE_REPLAY" || !slices.Equal(r.Conflicts, []string{"AgentsModel.swift"}) {
		t.Fatalf("want a SOURCE_REPLAY conflict, got %+v", r)
	}
	if stopped := mustGit(t, r.RepairWorktree, "rev-parse", "REBASE_HEAD"); stopped != edit {
		t.Fatalf("the replay stopped on %s, want the new edit %s", stopped, edit)
	}
	if err := os.WriteFile(filepath.Join(r.RepairWorktree, "AgentsModel.swift"), []byte("agents: v2 fixed\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	mustGit(t, r.RepairWorktree, "add", "AgentsModel.swift")
	t.Setenv("GIT_EDITOR", "true")
	mustGit(t, r.RepairWorktree, "-c", "user.name=test", "-c", "user.email=test@orbit", "rebase", "--continue")
	req.Recovery = r
	ready := mergeToMain(req).Recovery
	if ready == nil || ready.Code != "READY" {
		t.Fatalf("repaired check: %+v", ready)
	}
	if got := mustGit(t, f.repo, "show", ready.CandidateSha+":AgentsModel.swift"); got != "agents: v2 fixed" {
		t.Errorf("the repair was lost: %q", got)
	}
}

// Past the comparison limit nothing is judged landed by patch-id: the merge replays everything, as it
// did before the check existed (and on this fixture conflicts as it did then).
func TestMergeLandedComparisonPastTheLimitIsNotLanded(t *testing.T) {
	inc := newLandedIncident(t)
	mustGit(t, inc.repo, "fetch", "origin") // what the merge fetches first; asked directly here
	if landing := landedCommits(inc.repo, inc.base, inc.rewritten, inc.fix); !landing.All || len(landing.Landed) != 2 {
		t.Fatalf("within the limit both commits landed: %+v", landing)
	}
	limit := landedCompareLimit
	t.Cleanup(func() { landedCompareLimit = limit })

	// Origin gained four non-merge commits since the merge base: elsewhere, both copies, the fix.
	landedCompareLimit = 3
	if landing := landedCommits(inc.repo, inc.base, inc.rewritten, inc.fix); landing.All || landing.Landed != nil || landing.Skip != nil {
		t.Errorf("origin past the limit: %+v", landing)
	}
	// The session's own commits past it.
	landedCompareLimit = 1
	if landing := landedCommits(inc.repo, inc.base, inc.rewritten, inc.fix); landing.All || landing.Landed != nil || landing.Skip != nil {
		t.Errorf("session past the limit: %+v", landing)
	}
	if out := mergeToMain(inc.req); out.Status != "conflict" || out.Recovery != nil {
		t.Fatalf("past the limit the merge replays everything as before, got %q %+v (%s)", out.Status, out.Recovery, out.Message)
	}
}
