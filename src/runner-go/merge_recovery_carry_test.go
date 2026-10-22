package main

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// The repair carried forward. A recovery check made after a repair keeps it while the targets only
// moved on — origin/main does dozens of times a day — merging their new tips into the repair branch,
// so that only what they changed can conflict. A changed source or a rewritten target starts over,
// and a repair checkout left unfinished is reported with what is unresolved in it, whatever moved.

// carryFixture is a repository whose session branch, orbit/feat, the recovery check stopped on: a
// conflict in each of its shared files, in the phase it was built for, as first reports it.
type carryFixture struct {
	repo, bare, base string
	req              MergeCommand
	first            *MergeRecovery
}

// newCarryFixture: base has each of files, and the session adds feature.txt. TARGET_SYNC: local main
// and origin/main each changed every file, so joining them conflicts. SOURCE_REPLAY: the session and
// origin did, local main is still at base, and replaying the session onto origin conflicts. files
// are named in git's order, the order a conflict lists them in.
func newCarryFixture(t *testing.T, phase string, files ...string) *carryFixture {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv("GIT_EDITOR", "true")
	f := &carryFixture{repo: initRepo(t)}
	commitFiles(t, f.repo, "shared files", contents(files, "base\n"))
	f.bare = addOriginBare(t, f.repo)
	f.base = mustGit(t, f.repo, "rev-parse", "main")
	mustGit(t, f.repo, "checkout", "-b", "orbit/feat")
	commitFile(t, f.repo, "feature.txt", "feature\n", "feature work")
	if phase == "SOURCE_REPLAY" {
		commitFiles(t, f.repo, "session edits", contents(files, "session\n"))
	}
	mustGit(t, f.repo, "checkout", "main")
	f.landOnOrigin(t, "upstream edits", contents(files, "remote\n"))
	if phase == "TARGET_SYNC" {
		commitFiles(t, f.repo, "local edits", contents(files, "local\n"))
	}
	f.req = MergeCommand{WorkDir: f.repo, Branch: "orbit/feat", SessionID: "carry", BaseSha: f.base, RecoveryAction: "preview"}
	f.first = mergeToMain(f.req).Recovery
	if f.first == nil || f.first.Code != "CONFLICT" || f.first.Phase != phase || !slices.Equal(f.first.Conflicts, files) {
		t.Fatalf("want a %s conflict on %v, got %+v", phase, files, f.first)
	}
	return f
}

func contents(files []string, content string) map[string]string {
	m := map[string]string{}
	for _, name := range files {
		m[name] = content
	}
	return m
}

// commitFiles writes files in dir and commits them as one commit.
func commitFiles(t *testing.T, dir, msg string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mustGit(t, dir, "add", "-A")
	mustGit(t, dir, "commit", "-q", "-m", msg)
}

// landOnOrigin lands a commit on origin/main from another clone — another session's merge — while
// this repository's origin/main still names the tip it last fetched.
func (f *carryFixture) landOnOrigin(t *testing.T, msg string, files map[string]string) string {
	t.Helper()
	return f.pushToOrigin(t, "", msg, files)
}

// forceOrigin rewrites origin/main: a commit on from, force-pushed over whatever origin had.
func (f *carryFixture) forceOrigin(t *testing.T, from, msg string, files map[string]string) string {
	t.Helper()
	return f.pushToOrigin(t, from, msg, files)
}

func (f *carryFixture) pushToOrigin(t *testing.T, from, msg string, files map[string]string) string {
	t.Helper()
	other := t.TempDir()
	mustGit(t, other, "clone", "-q", f.bare, ".")
	mustGit(t, other, "config", "user.name", "Upstream")
	mustGit(t, other, "config", "user.email", "upstream@orbit")
	if from != "" {
		mustGit(t, other, "reset", "-q", "--hard", from)
	}
	commitFiles(t, other, msg, files)
	mustGit(t, other, "push", "-q", "--force", "origin", "HEAD:main")
	return mustGit(t, other, "rev-parse", "HEAD")
}

// addToSource gives the session branch another commit and returns its new tip.
func (f *carryFixture) addToSource(t *testing.T, file string) string {
	t.Helper()
	mustGit(t, f.repo, "checkout", "orbit/feat")
	commitFile(t, f.repo, file, "more\n", "more session work")
	mustGit(t, f.repo, "checkout", "main")
	return mustGit(t, f.repo, "rev-parse", "orbit/feat")
}

// check runs the recovery check again with the last check's result, as the control plane does.
func (f *carryFixture) check(t *testing.T, prior *MergeRecovery) *MergeRecovery {
	t.Helper()
	req := f.req
	req.Recovery = prior
	r := mergeToMain(req).Recovery
	if r == nil {
		t.Fatal("the check returned no recovery")
	}
	return r
}

// repair resolves files in r's repair checkout as given and finishes the merge or the rebase in
// progress there, as a repair session does. It returns the repair branch's tip.
func (f *carryFixture) repair(t *testing.T, r *MergeRecovery, files map[string]string) string {
	t.Helper()
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(r.RepairWorktree, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		mustGit(t, r.RepairWorktree, "add", name)
	}
	if gitPathExists(r.RepairWorktree, "rebase-merge") || gitPathExists(r.RepairWorktree, "rebase-apply") {
		mustGit(t, r.RepairWorktree, "rebase", "--continue")
	} else {
		mustGit(t, r.RepairWorktree, "commit", "-q", "--no-edit")
	}
	return mustGit(t, f.repo, "rev-parse", "refs/heads/"+r.RepairBranch)
}

// apply lands r: a carried candidate is held to every invariant a reviewed candidate is.
func (f *carryFixture) apply(t *testing.T, r *MergeRecovery) {
	t.Helper()
	req := f.req
	req.RecoveryAction, req.Recovery = "apply", r
	if out := mergeToMain(req); out.Status != "merged" || mustGit(t, f.bare, "rev-parse", "main") != r.CandidateSha {
		t.Fatalf("the carried candidate did not land: %+v (%s)", out.Recovery, out.Message)
	}
}

// carried checks that r reused the first check's repair: its branch and checkout, a new approval
// identity, and no other repair checkout or branch.
func (f *carryFixture) carried(t *testing.T, r *MergeRecovery) {
	t.Helper()
	if r.RepairBranch != f.first.RepairBranch || r.RepairWorktree != f.first.RepairWorktree || r.PreviewID == "" || r.PreviewID == f.first.PreviewID {
		t.Fatalf("the repair was not carried: %+v", r)
	}
	f.repairs(t, 1)
}

// startedOver checks that r began again in a new branch and checkout, superseding the first check's
// repair: its finished, clean checkout is reclaimed (R3), and its branch is still at tip.
func (f *carryFixture) startedOver(t *testing.T, r *MergeRecovery, tip string) {
	t.Helper()
	if r.RepairBranch == "" || r.RepairBranch == f.first.RepairBranch || r.RepairWorktree == "" || r.RepairWorktree == f.first.RepairWorktree {
		t.Fatalf("the check did not start over: %+v", r)
	}
	f.repairsLeft(t, 1, 2)
	reclaimed(t, f.repo, f.first, tip)
}

// unfinished checks a REPAIR_IN_PROGRESS answer: files left to resolve, the first check's repair —
// branch, checkout, phase, and the source and target tips it synchronizes — no other checkout, and,
// when before is given, the checkout exactly as it was.
func (f *carryFixture) unfinished(t *testing.T, r *MergeRecovery, files []string, before string) {
	t.Helper()
	if r.Code != "REPAIR_IN_PROGRESS" || !slices.Equal(r.Conflicts, files) || r.PreviewID == "" || r.CandidateSha != "" {
		t.Fatalf("want REPAIR_IN_PROGRESS on %v, got %+v", files, r)
	}
	if r.RepairBranch != f.first.RepairBranch || r.RepairWorktree != f.first.RepairWorktree || r.Phase != f.first.Phase ||
		r.SourceSha != f.first.SourceSha || r.LocalSha != f.first.LocalSha || r.RemoteSha != f.first.RemoteSha || r.RebaseBaseSha != f.first.RebaseBaseSha {
		t.Fatalf("the unfinished repair is not reported as it stands: %+v", r)
	}
	f.repairs(t, 1)
	if before != "" && checkoutState(t, r.RepairWorktree) != before {
		t.Fatal("the unfinished repair checkout was changed")
	}
}

// repairs checks how many repair checkouts and branches exist.
func (f *carryFixture) repairs(t *testing.T, n int) {
	t.Helper()
	f.repairsLeft(t, n, n)
}

// repairsLeft checks how many repair checkouts and branches exist: a reclaimed checkout leaves its branch.
func (f *carryFixture) repairsLeft(t *testing.T, checkouts, branches int) {
	t.Helper()
	names := splitLines(mustGit(t, f.repo, "for-each-ref", "--format=%(refname)", "refs/heads/orbit/recovery"))
	if dirs := recoveryWorktrees(t); len(dirs) != checkouts || len(names) != branches {
		t.Fatalf("want %d repair checkout(s) and %d branch(es), got %v and %v", checkouts, branches, dirs, names)
	}
}

func checkoutState(t *testing.T, dir string) string {
	t.Helper()
	state := []string{mustGit(t, dir, "rev-parse", "HEAD"), mustGit(t, dir, "status", "--porcelain")}
	for _, ref := range []string{"MERGE_HEAD", "REBASE_HEAD"} {
		at, _ := git(dir, "rev-parse", "-q", "--verify", ref)
		state = append(state, at)
	}
	return strings.Join(state, "\n")
}

// holds checks the content of files in commit.
func holds(t *testing.T, repo, commit string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		if got := mustGit(t, repo, "show", commit+":"+name); got != strings.TrimSpace(content) {
			t.Errorf("%s in the candidate = %q, want %q", name, got, strings.TrimSpace(content))
		}
	}
}

// sessionReplays counts the times the push carries the session commit with this subject.
func sessionReplays(r *MergeRecovery, subject string) int {
	n := 0
	for _, c := range r.PushCommits {
		if !c.Merge && c.Subject == subject {
			n++
		}
	}
	return n
}

// TARGET_SYNC: the repair joined local main and origin/main by hand, and origin moved on before the
// next check. The check merges origin's new tip into the repair branch and replays the session on
// top: the candidate holds the repair's merge, and lands.
func TestMergeRecoveryCarryTargetSyncRepairPastRemoteAdvance(t *testing.T) {
	f := newCarryFixture(t, "TARGET_SYNC", "shared.txt")
	repaired := f.repair(t, f.first, map[string]string{"shared.txt": "local and remote\n"})
	later := f.landOnOrigin(t, "later upstream work", map[string]string{"later.txt": "later\n"})

	r := f.check(t, f.first)

	f.carried(t, r)
	if r.Code != "READY" || r.Phase != "SOURCE_REPLAY" || r.RemoteSha != later || r.LocalSha != f.first.LocalSha {
		t.Fatalf("want a READY candidate on origin's new tip, got %+v", r)
	}
	if !targetContainsSource(f.repo, repaired, r.CandidateSha) {
		t.Fatal("the candidate does not hold the repair's merge")
	}
	holds(t, f.repo, r.CandidateSha, map[string]string{"shared.txt": "local and remote", "later.txt": "later", "feature.txt": "feature"})
	f.apply(t, r)
}

// SOURCE_REPLAY: the repair resolved the session's commit against origin, and origin moved on before
// the next check. The check merges origin's new tip in on top of the replayed commit without running
// the replay again: the candidate holds the repair's resolution, READY, and lands.
func TestMergeRecoveryCarrySourceReplayRepairPastRemoteAdvance(t *testing.T) {
	f := newCarryFixture(t, "SOURCE_REPLAY", "shared.txt")
	repaired := f.repair(t, f.first, map[string]string{"shared.txt": "session and remote\n"})
	later := f.landOnOrigin(t, "later upstream work", map[string]string{"later.txt": "later\n"})

	r := f.check(t, f.first)

	f.carried(t, r)
	if r.Code != "READY" || r.Phase != "SOURCE_REPLAY" || r.RemoteSha != later || r.RebaseBaseSha != f.first.RebaseBaseSha || len(r.Conflicts) != 0 {
		t.Fatalf("want a READY candidate carrying the repaired replay, got %+v", r)
	}
	if !targetContainsSource(f.repo, repaired, r.CandidateSha) {
		t.Fatal("the candidate does not hold the repair")
	}
	holds(t, f.repo, r.CandidateSha, map[string]string{"shared.txt": "session and remote", "later.txt": "later", "feature.txt": "feature"})
	if n := sessionReplays(r, "session edits"); n != 1 {
		t.Fatalf("the push carries the session's commit %d times: %+v", n, r.PushCommits)
	}
	f.apply(t, r)
}

// The local target moved on instead, with a commit nobody pushed. Its tip is merged into the repair
// branch the same way in either phase, and published with the candidate, as local-only work always is.
func TestMergeRecoveryCarryRepairPastLocalAdvance(t *testing.T) {
	for _, phase := range []string{"TARGET_SYNC", "SOURCE_REPLAY"} {
		t.Run(phase, func(t *testing.T) {
			f := newCarryFixture(t, phase, "shared.txt")
			repaired := f.repair(t, f.first, map[string]string{"shared.txt": "resolved\n"})
			commitFile(t, f.repo, "local-later.txt", "local later\n", "later local work")
			local := mustGit(t, f.repo, "rev-parse", "main")

			r := f.check(t, f.first)

			f.carried(t, r)
			if r.Code != "READY" || r.LocalSha != local || r.RemoteSha != f.first.RemoteSha {
				t.Fatalf("want a READY candidate on local main's new tip, got %+v", r)
			}
			if !targetContainsSource(f.repo, repaired, r.CandidateSha) {
				t.Fatal("the candidate does not hold the repair")
			}
			holds(t, f.repo, r.CandidateSha, map[string]string{"shared.txt": "resolved", "local-later.txt": "local later", "feature.txt": "feature"})
			f.apply(t, r)
			if mustGit(t, f.repo, "rev-parse", "main") != r.CandidateSha {
				t.Fatal("local main did not follow the landed candidate")
			}
		})
	}
}

// origin's new commit changes a file the repair resolved. The check stops on that merge, in the
// repair checkout, as a TARGET_SYNC conflict naming that file alone — not the other file the repair
// resolved — with the repair kept underneath. Resolving it finishes the candidate, still without
// replaying the session again.
func TestMergeRecoveryCarryNewConflictListsOnlyNewFiles(t *testing.T) {
	f := newCarryFixture(t, "SOURCE_REPLAY", "other.txt", "shared.txt")
	repaired := f.repair(t, f.first, map[string]string{"other.txt": "other resolved\n", "shared.txt": "shared resolved\n"})
	later := f.landOnOrigin(t, "upstream edits other.txt again", map[string]string{"other.txt": "remote again\n"})

	r := f.check(t, f.first)

	f.carried(t, r)
	if r.Code != "CONFLICT" || r.Phase != "TARGET_SYNC" || !slices.Equal(r.Conflicts, []string{"other.txt"}) || r.RemoteSha != later {
		t.Fatalf("want a TARGET_SYNC conflict on other.txt alone, got %+v", r)
	}
	if head := mustGit(t, r.RepairWorktree, "rev-parse", "HEAD"); head != repaired {
		t.Fatalf("the repair branch moved off the repair: %s", head)
	}
	if merging := mustGit(t, r.RepairWorktree, "rev-parse", "MERGE_HEAD"); merging != later {
		t.Fatalf("the conflict is not origin's new commit: %s", merging)
	}
	if got, _ := os.ReadFile(filepath.Join(r.RepairWorktree, "shared.txt")); string(got) != "shared resolved\n" {
		t.Fatalf("the repair's other resolution is gone: %q", got)
	}
	if r.RebaseBaseSha != f.first.RebaseBaseSha {
		t.Fatalf("the replay the repair resolved is no longer recorded: %+v", r)
	}

	resolved := f.repair(t, r, map[string]string{"other.txt": "other resolved again\n"})
	ready := f.check(t, r)

	f.carried(t, ready)
	if ready.Code != "READY" || ready.RebaseBaseSha != f.first.RebaseBaseSha || ready.RemoteSha != later {
		t.Fatalf("want a READY candidate, got %+v", ready)
	}
	if !targetContainsSource(f.repo, resolved, ready.CandidateSha) {
		t.Fatal("the candidate does not hold the repairs")
	}
	holds(t, f.repo, ready.CandidateSha, map[string]string{"other.txt": "other resolved again", "shared.txt": "shared resolved", "feature.txt": "feature"})
	if n := sessionReplays(ready, "session edits"); n != 1 {
		t.Fatalf("the push carries the session's commit %d times: %+v", n, ready.PushCommits)
	}
	f.apply(t, ready)
}

// A target rewritten under the repair — origin force-pushed, local main reset — did not move on:
// what the repair joined is gone from it. The check starts over in a new checkout, meeting the
// conflict again; the old repair's checkout is reclaimed and its branch kept as it was.
func TestMergeRecoveryCarryRewrittenTargetStartsOver(t *testing.T) {
	t.Run("origin", func(t *testing.T) {
		f := newCarryFixture(t, "SOURCE_REPLAY", "shared.txt")
		repaired := f.repair(t, f.first, map[string]string{"shared.txt": "resolved\n"})
		f.forceOrigin(t, f.base, "upstream edits, rewritten", map[string]string{"shared.txt": "remote rewritten\n"})

		r := f.check(t, f.first)

		f.startedOver(t, r, repaired)
		if r.Code != "CONFLICT" || r.Phase != "SOURCE_REPLAY" || !slices.Equal(r.Conflicts, []string{"shared.txt"}) {
			t.Fatalf("want the replay's conflict again, got %+v", r)
		}
	})
	t.Run("local", func(t *testing.T) {
		f := newCarryFixture(t, "TARGET_SYNC", "shared.txt")
		repaired := f.repair(t, f.first, map[string]string{"shared.txt": "resolved\n"})
		mustGit(t, f.repo, "reset", "-q", "--hard", f.base)
		commitFile(t, f.repo, "shared.txt", "local rewritten\n", "local edits, rewritten")

		r := f.check(t, f.first)

		f.startedOver(t, r, repaired)
		if r.Code != "CONFLICT" || r.Phase != "TARGET_SYNC" || r.LocalSha != mustGit(t, f.repo, "rev-parse", "main") {
			t.Fatalf("want the targets' conflict again, got %+v", r)
		}
	})
}

// A source that changed since the repair is not the one the repair resolved: the check starts over.
// While the repair is unfinished it is still reported as the repair of the source it was made for,
// so finishing it later cannot pass it off as a candidate of the new source.
func TestMergeRecoveryCarryChangedSourceStartsOver(t *testing.T) {
	t.Run("finished", func(t *testing.T) {
		f := newCarryFixture(t, "SOURCE_REPLAY", "shared.txt")
		repaired := f.repair(t, f.first, map[string]string{"shared.txt": "resolved\n"})
		source := f.addToSource(t, "more.txt")

		r := f.check(t, f.first)

		f.startedOver(t, r, repaired)
		if r.SourceSha != source || r.Code != "CONFLICT" || r.Phase != "SOURCE_REPLAY" {
			t.Fatalf("want the new source's replay, got %+v", r)
		}
	})
	t.Run("unfinished", func(t *testing.T) {
		f := newCarryFixture(t, "SOURCE_REPLAY", "shared.txt")
		source := f.addToSource(t, "more.txt")

		pending := f.check(t, f.first)

		f.unfinished(t, pending, []string{"shared.txt"}, "")
		repaired := f.repair(t, pending, map[string]string{"shared.txt": "resolved\n"})
		r := f.check(t, pending)
		f.startedOver(t, r, repaired)
		if r.SourceSha != source || r.Code != "CONFLICT" {
			t.Fatalf("want the new source's replay, got %+v", r)
		}
	})
}

// A repair checkout left mid-merge, mid-rebase or holding uncommitted edits is reported as
// REPAIR_IN_PROGRESS with what is left to resolve there. origin moved meanwhile, yet no other
// checkout is made and this one is left exactly as it was; once it is finished, the next check
// carries the repair to origin's new tip.
func TestMergeRecoveryCarryUnfinishedRepairReportsUnresolvedFiles(t *testing.T) {
	t.Run("TARGET_SYNC_merge", func(t *testing.T) {
		f := newCarryFixture(t, "TARGET_SYNC", "other.txt", "shared.txt")
		later := f.landOnOrigin(t, "later upstream work", map[string]string{"later.txt": "later\n"})
		before := checkoutState(t, f.first.RepairWorktree)

		pending := f.check(t, f.first)

		f.unfinished(t, pending, []string{"other.txt", "shared.txt"}, before)
		// Half resolved: only the file still unmerged is named.
		if err := os.WriteFile(filepath.Join(pending.RepairWorktree, "shared.txt"), []byte("resolved\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		mustGit(t, pending.RepairWorktree, "add", "shared.txt")
		pending = f.check(t, pending)
		f.unfinished(t, pending, []string{"other.txt"}, "")
		repaired := f.repair(t, pending, map[string]string{"other.txt": "resolved\n"})
		ready := f.check(t, pending)
		f.carried(t, ready)
		if ready.Code != "READY" || ready.RemoteSha != later || !targetContainsSource(f.repo, repaired, ready.CandidateSha) {
			t.Fatalf("want the finished repair carried to origin's new tip, got %+v", ready)
		}
		holds(t, f.repo, ready.CandidateSha, map[string]string{"shared.txt": "resolved", "other.txt": "resolved", "later.txt": "later"})
	})
	// Mid-rebase the checkout's HEAD is detached: it is still the repair branch's checkout.
	t.Run("SOURCE_REPLAY_rebase", func(t *testing.T) {
		f := newCarryFixture(t, "SOURCE_REPLAY", "shared.txt")
		later := f.landOnOrigin(t, "later upstream work", map[string]string{"later.txt": "later\n"})
		before := checkoutState(t, f.first.RepairWorktree)

		pending := f.check(t, f.first)

		f.unfinished(t, pending, []string{"shared.txt"}, before)
		repaired := f.repair(t, pending, map[string]string{"shared.txt": "resolved\n"})
		ready := f.check(t, pending)
		f.carried(t, ready)
		if ready.Code != "READY" || ready.RemoteSha != later || !targetContainsSource(f.repo, repaired, ready.CandidateSha) {
			t.Fatalf("want the finished repair carried to origin's new tip, got %+v", ready)
		}
		holds(t, f.repo, ready.CandidateSha, map[string]string{"shared.txt": "resolved", "later.txt": "later"})
	})
	// R1's replay of a partly landed session is an interactive rebase that drops the landed commits.
	t.Run("partly_landed_replay", func(t *testing.T) {
		lf := newLandedFixture(t)
		t.Setenv("GIT_EDITOR", "true")
		lf.buildOnOrigin(t, "Fix agents model", map[string]string{"AgentsModel.swift": "agents: v1 fixed\n"})
		lf.commit(t, "AgentsModel.swift", "agents: v2\n", "Rename agents")
		f := &carryFixture{repo: lf.repo, bare: lf.bare, base: lf.base, req: lf.req}
		f.req.RecoveryAction = "preview"
		f.first = mergeToMain(f.req).Recovery
		if f.first == nil || f.first.Code != "CONFLICT" || f.first.Phase != "SOURCE_REPLAY" || !gitPathExists(f.first.RepairWorktree, "rebase-merge/interactive") {
			t.Fatalf("want the replay that leaves out the landed commit stopped on a conflict, got %+v", f.first)
		}
		later := f.landOnOrigin(t, "later upstream work", map[string]string{"later.txt": "later\n"})
		before := checkoutState(t, f.first.RepairWorktree)

		pending := f.check(t, f.first)

		f.unfinished(t, pending, []string{"AgentsModel.swift"}, before)
		f.repair(t, pending, map[string]string{"AgentsModel.swift": "agents: v2 fixed\n"})
		ready := f.check(t, pending)
		f.carried(t, ready)
		if ready.Code != "READY" || ready.RemoteSha != later {
			t.Fatalf("want the finished repair carried to origin's new tip, got %+v", ready)
		}
		holds(t, f.repo, ready.CandidateSha, map[string]string{"AgentsModel.swift": "agents: v2 fixed", "later.txt": "later"})
	})
	// No unmerged file: the files changed and not committed are named instead, up to the cap.
	t.Run("uncommitted_edits", func(t *testing.T) {
		f := newCarryFixture(t, "SOURCE_REPLAY", "shared.txt")
		f.repair(t, f.first, map[string]string{"shared.txt": "resolved\n"})
		edits := map[string]string{}
		for i := range repoStatePathCap + 5 {
			edits[fmt.Sprintf("edit-%02d.txt", i)] = "repair\n"
		}
		commitFiles(t, f.first.RepairWorktree, "repair adds files", edits)
		ready := f.check(t, f.first)
		if ready.Code != "READY" {
			t.Fatalf("want the finished repair READY, got %+v", ready)
		}
		names := make([]string, 0, len(edits))
		for name := range edits {
			names = append(names, name)
			if err := os.WriteFile(filepath.Join(ready.RepairWorktree, name), []byte("edited\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		slices.Sort(names)
		f.landOnOrigin(t, "later upstream work", map[string]string{"later.txt": "later\n"})
		before := checkoutState(t, ready.RepairWorktree)

		pending := f.check(t, ready)

		f.unfinished(t, pending, names[:repoStatePathCap], before)
	})
}

// Both targets moved, and local main's new commit conflicts with the repair. That merge comes first
// and origin's waits for it, so the check records origin's previous tip — what the repair branch
// holds once the conflict is resolved — and the next check carries the repair on, merging origin's.
func TestMergeRecoveryCarryBothTargetsMovedKeepsTheRepair(t *testing.T) {
	f := newCarryFixture(t, "SOURCE_REPLAY", "shared.txt")
	repaired := f.repair(t, f.first, map[string]string{"shared.txt": "resolved\n"})
	commitFile(t, f.repo, "shared.txt", "local\n", "local edit")
	local := mustGit(t, f.repo, "rev-parse", "main")
	later := f.landOnOrigin(t, "later upstream work", map[string]string{"later.txt": "later\n"})

	r := f.check(t, f.first)

	f.carried(t, r)
	if r.Code != "CONFLICT" || r.Phase != "TARGET_SYNC" || !slices.Equal(r.Conflicts, []string{"shared.txt"}) || r.LocalSha != local || r.RemoteSha != f.first.RemoteSha {
		t.Fatalf("want local main's merge in conflict, origin's previous tip recorded, got %+v", r)
	}
	if !slices.Equal(commitShas(r.LocalCommits), []string{local}) || len(r.RemoteCommits) != 1 {
		t.Fatalf("the target histories are not listed for the recorded tips: %+v / %+v", r.LocalCommits, r.RemoteCommits)
	}
	resolved := f.repair(t, r, map[string]string{"shared.txt": "resolved and local\n"})

	ready := f.check(t, r)

	f.carried(t, ready)
	if ready.Code != "READY" || ready.LocalSha != local || ready.RemoteSha != later {
		t.Fatalf("want a READY candidate on both new tips, got %+v", ready)
	}
	if !targetContainsSource(f.repo, repaired, ready.CandidateSha) || !targetContainsSource(f.repo, resolved, ready.CandidateSha) {
		t.Fatal("the candidate does not hold the repairs")
	}
	holds(t, f.repo, ready.CandidateSha, map[string]string{"shared.txt": "resolved and local", "later.txt": "later", "feature.txt": "feature"})
	f.apply(t, ready)
}

// merge.ff=only rules out merge commits in the target's history, and taking a moved target into a
// repair branch makes one. Under it a repair is carried only while nothing has to be merged into
// it; once origin moved, the check starts over, and its replay onto origin keeps history linear.
func TestMergeRecoveryCarryLinearHistoryStartsOver(t *testing.T) {
	f := newCarryFixture(t, "SOURCE_REPLAY", "shared.txt")
	repaired := f.repair(t, f.first, map[string]string{"shared.txt": "resolved\n"})
	mustGit(t, f.repo, "config", "merge.ff", "only")
	if r := f.check(t, f.first); r.Code != "READY" || r.RepairWorktree != f.first.RepairWorktree {
		t.Fatalf("with nothing to merge in, the repair is carried: %+v", r)
	}
	f.landOnOrigin(t, "later upstream work", map[string]string{"later.txt": "later\n"})

	r := f.check(t, f.first)

	f.startedOver(t, r, repaired)
	if r.Code != "CONFLICT" || r.Phase != "SOURCE_REPLAY" {
		t.Fatalf("want the replay onto origin's new tip, got %+v", r)
	}
}
