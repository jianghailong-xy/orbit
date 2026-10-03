package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMergeRecoveryEscapedEnvelopeCannotAdvertiseReady(t *testing.T) {
	r := &MergeRecovery{TargetBranch: "main", RepairWorktree: "/saved/repair", Patch: strings.Repeat("\x01", 200000),
		PushCommits: []MergeRecoveryCommit{{Sha: "pushed"}}}
	out := recoveryError(r, "READY", "review")
	payload, _ := json.Marshal(out.Recovery)
	if r.Code != "PREVIEW_TOO_LARGE" || r.Patch != "" || r.PushCommits != nil || r.RepairWorktree != "/saved/repair" || len(payload) > 1_200_000 {
		t.Fatal("oversized escaped preview would be rejected forever by the result endpoint")
	}
}

func recoveryFixture(t *testing.T) (string, string, MergeCommand) {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	bare := addOriginBare(t, repo)
	base := mustGit(t, repo, "rev-parse", "main")
	mustGit(t, repo, "checkout", "-b", "orbit/feat")
	commitFile(t, repo, "feature.txt", "feature\n", "feature work")
	mustGit(t, repo, "checkout", "main")
	advanceOriginMain(t, repo, "remote.txt", "remote\n")
	commitFile(t, repo, "local.txt", "local\n", "local work")
	return repo, bare, MergeCommand{WorkDir: repo, Branch: "orbit/feat", SessionID: "recovery", BaseSha: base, RecoveryAction: "preview"}
}

func TestMergeRecoveryPreviewAndApply(t *testing.T) {
	repo, bare, req := recoveryFixture(t)
	local := mustGit(t, repo, "rev-parse", "main")
	remote := mustGit(t, bare, "rev-parse", "main")
	source := mustGit(t, repo, "rev-parse", req.Branch)
	out := mergeToMain(req)
	if out.Recovery == nil || out.Recovery.Code != "READY" {
		t.Fatalf("preview: %+v", out)
	}
	r := out.Recovery
	if len(r.LocalCommits) != 1 || len(r.RemoteCommits) != 1 || r.Patch == "" || !r.AddsMergeCommit {
		t.Fatalf("incomplete preview: %+v", r)
	}
	for ref, expected := range map[string]string{"main": local, req.Branch: source} {
		if got := mustGit(t, repo, "rev-parse", ref); got != expected {
			t.Fatalf("preview changed %s", ref)
		}
	}
	if mustGit(t, bare, "rev-parse", "main") != remote {
		t.Fatal("preview pushed")
	}
	req.RecoveryAction, req.Recovery = "apply", r
	out = mergeToMain(req)
	if out.Status != "merged" {
		t.Fatalf("apply: %+v", out)
	}
	if out.RebaseBase != mustGit(t, repo, "rev-parse", r.CandidateSha+"^") || out.RebaseBase == remote {
		t.Fatal("receipt must name the synchronized target as its actual source replay base")
	}
	if mustGit(t, repo, "rev-parse", "main") != r.CandidateSha || mustGit(t, bare, "rev-parse", "main") != r.CandidateSha {
		t.Fatal("candidate did not land")
	}
	if mustGit(t, repo, "rev-parse", req.Branch) != source {
		t.Fatal("source rewritten")
	}
	for _, sha := range []string{local, remote} {
		if _, err := git(repo, "merge-base", "--is-ancestor", sha, r.CandidateSha); err != nil {
			t.Fatal("target history lost")
		}
	}
	for _, file := range []string{"local.txt", "remote.txt", "feature.txt"} {
		mustGit(t, bare, "cat-file", "-e", "main:"+file)
	}
	if again := mergeToMain(req); again.Status != "merged" || again.AlreadyMerged || again.Recovery == nil || again.Recovery.Code != "DONE" {
		t.Fatalf("repeat apply: %+v", again)
	}
}

// The review lists what the push adds to origin/main, no more and no less, newest first: this
// session's replayed commit, the merge joining both target histories, the local-only commit.
func TestMergeRecoveryPreviewListsExactlyWhatThePushAdds(t *testing.T) {
	repo, bare, req := recoveryFixture(t)
	local := mustGit(t, repo, "rev-parse", "main")
	remote := mustGit(t, bare, "rev-parse", "main")
	r := mergeToMain(req).Recovery
	if r == nil || r.Code != "READY" {
		t.Fatalf("preview: %+v", r)
	}
	var shas []string
	for _, c := range r.PushCommits {
		shas = append(shas, c.Sha)
	}
	if got, want := strings.Join(shas, "\n"), mustGit(t, repo, "rev-list", remote+".."+r.CandidateSha); got != want {
		t.Fatalf("push commits %q, want exactly %q", got, want)
	}
	if len(r.PushCommits) != 3 {
		t.Fatalf("push commits: %+v", r.PushCommits)
	}
	session, merge, extra := r.PushCommits[0], r.PushCommits[1], r.PushCommits[2]
	if session.Sha != r.CandidateSha || session.Subject != "feature work" || session.Merge {
		t.Fatalf("session commit: %+v", session)
	}
	// git's default subject would publish a raw SHA and the private repair branch's name.
	if !merge.Merge || merge.Subject != "Merge origin/main into main" {
		t.Fatalf("merge commit: %+v", merge)
	}
	if extra.Sha != local || extra.Merge || len(r.LocalCommits) != 1 || r.LocalCommits[0].Sha != local || r.LocalCommits[0].Merge {
		t.Fatalf("local-only commit: %+v / %+v", extra, r.LocalCommits)
	}
}

// The owner's case, 2026-10-01: local main matches origin/main, so the push is this session's
// commits alone — no merge commit, no local-only commits, and none of them on the wire.
func TestMergeRecoveryPreviewOfAMatchingTargetPushesOnlyTheSession(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	addOriginBare(t, repo)
	base := mustGit(t, repo, "rev-parse", "main")
	mustGit(t, repo, "checkout", "-b", "orbit/feat")
	commitFile(t, repo, "one.txt", "one\n", "first session commit")
	commitFile(t, repo, "two.txt", "two\n", "second session commit")
	mustGit(t, repo, "checkout", "main")
	r := mergeToMain(MergeCommand{WorkDir: repo, Branch: "orbit/feat", SessionID: "recovery", BaseSha: base, RecoveryAction: "preview"}).Recovery
	if r == nil || r.Code != "READY" || r.AddsMergeCommit || len(r.LocalCommits) != 0 || len(r.RemoteCommits) != 0 {
		t.Fatalf("preview: %+v", r)
	}
	if len(r.PushCommits) != 2 || r.PushCommits[0].Subject != "second session commit" || r.PushCommits[1].Subject != "first session commit" {
		t.Fatalf("push commits: %+v", r.PushCommits)
	}
	payload, _ := json.Marshal(r)
	for _, absent := range []string{`"localCommits"`, `"remoteCommits"`, `"merge"`} {
		if strings.Contains(string(payload), absent) {
			t.Fatalf("%s should stay off the wire: %s", absent, payload)
		}
	}
}

func TestMergeRecoveryRejectsChangedPreview(t *testing.T) {
	for _, which := range []string{"local", "remote", "source", "candidate", "checkpoint", "check configuration"} {
		t.Run(which, func(t *testing.T) {
			repo, bare, req := recoveryFixture(t)
			preview := mergeToMain(req).Recovery
			if preview == nil || preview.Code != "READY" {
				t.Fatal("missing preview")
			}
			switch which {
			case "local":
				commitFile(t, repo, "later.txt", "later", "later local")
			case "remote":
				other := t.TempDir()
				mustGit(t, other, "clone", bare, ".")
				mustGit(t, other, "config", "user.name", "test")
				mustGit(t, other, "config", "user.email", "test@orbit")
				commitFile(t, other, "later.txt", "later", "later remote")
				mustGit(t, other, "push", "origin", "main")
			case "source":
				mustGit(t, repo, "checkout", req.Branch)
				commitFile(t, repo, "later.txt", "later", "later source")
				mustGit(t, repo, "checkout", "main")
			case "candidate":
				preview.CandidateTreeSha = preview.SourceSha
			case "checkpoint":
				req.RequiredSourceSha = preview.LocalSha
			case "check configuration":
				req.Check = &MergeRecoveryCheckSpec{Command: "exit 0", TimeoutSeconds: 5}
			}
			before := mustGit(t, bare, "rev-parse", "main")
			req.RecoveryAction, req.Recovery = "apply", preview
			out := mergeToMain(req)
			if out.Status == "merged" {
				t.Fatalf("changed %s accepted", which)
			}
			if mustGit(t, bare, "rev-parse", "main") != before {
				t.Fatal("changed preview pushed")
			}
		})
	}
}

func TestMergeRecoveryConflictStaysInRepairWorktree(t *testing.T) {
	repo, _, req := recoveryFixture(t)
	commitFile(t, repo, "remote.txt", "local edit\n", "overlapping target")
	out := mergeToMain(req)
	if out.Recovery == nil || out.Recovery.Code != "CONFLICT" || out.Recovery.Phase != "TARGET_SYNC" || len(out.Recovery.Conflicts) == 0 {
		t.Fatalf("conflict: %+v", out)
	}
	if mustGit(t, repo, "status", "--porcelain") != "" {
		t.Fatal("shared checkout wedged")
	}
	if out.Recovery.RepairWorktree == "" {
		t.Fatal("no repair location")
	}
	req.Recovery = out.Recovery
	if pending := mergeToMain(req); pending.Recovery == nil || pending.Recovery.Code != "REPAIR_IN_PROGRESS" || pending.Recovery.RepairWorktree != out.Recovery.RepairWorktree {
		t.Fatalf("lost pending repair: %+v", pending)
	}
	// Resolve the private merge, then check again: the repaired target is used before source replay.
	commitFile(t, out.Recovery.RepairWorktree, "remote.txt", "resolved\n", "resolve target sync")
	req.Recovery = out.Recovery
	ready := mergeToMain(req)
	if ready.Recovery == nil || ready.Recovery.Code != "READY" {
		t.Fatalf("repaired preview: %+v", ready)
	}
}

func TestMergeRecoverySourceConflictCanBeRechecked(t *testing.T) {
	repo, _, req := recoveryFixture(t)
	mustGit(t, repo, "checkout", req.Branch)
	commitFile(t, repo, "remote.txt", "source edit\n", "overlapping source")
	mustGit(t, repo, "checkout", "main")
	out := mergeToMain(req)
	if out.Recovery == nil || out.Recovery.Code != "CONFLICT" || out.Recovery.Phase != "SOURCE_REPLAY" {
		t.Fatalf("source conflict: %+v", out)
	}
	r := out.Recovery
	if err := os.WriteFile(filepath.Join(r.RepairWorktree, "remote.txt"), []byte("resolved source\n"), 0600); err != nil {
		t.Fatal(err)
	}
	mustGit(t, r.RepairWorktree, "add", "remote.txt")
	t.Setenv("GIT_EDITOR", "true")
	mustGit(t, r.RepairWorktree, "-c", "user.name=test", "-c", "user.email=test@orbit", "rebase", "--continue")
	req.Recovery = r
	ready := mergeToMain(req)
	if ready.Recovery == nil || ready.Recovery.Code != "READY" || ready.Recovery.RepairWorktree != r.RepairWorktree || ready.Recovery.PreviewID == r.PreviewID {
		t.Fatalf("repaired source: %+v", ready)
	}
	if got := mustGit(t, repo, "show", ready.Recovery.CandidateSha+":remote.txt"); got != "resolved source" {
		t.Fatal("source repair discarded")
	}
}

func TestMergeRecoveryRechecksFixedCheckWithoutDiscardingWork(t *testing.T) {
	_, _, req := recoveryFixture(t)
	req.Check = &MergeRecoveryCheckSpec{Command: "test -f fixed.txt", TimeoutSeconds: 5}
	r := mergeToMain(req).Recovery
	if r == nil || r.Code != "CHECK_FAILED" {
		t.Fatal("missing failed check")
	}
	commitFile(t, r.RepairWorktree, "fixed.txt", "repair\n", "fix candidate")
	req.Recovery = r
	ready := mergeToMain(req).Recovery
	if ready == nil || ready.Code != "READY" || ready.Check.Status != "passed" || ready.RepairWorktree != r.RepairWorktree || ready.PreviewID == r.PreviewID {
		t.Fatalf("recheck: %+v", ready)
	}
	mustGit(t, r.RepairWorktree, "cat-file", "-e", ready.CandidateSha+":fixed.txt")
	if !strings.Contains(ready.Patch, "fixed.txt") {
		t.Fatal("repair absent from reviewed diff")
	}
}

func TestMergeRecoveryRespectsLinearHistoryPolicy(t *testing.T) {
	repo, bare, req := recoveryFixture(t)
	before := mustGit(t, bare, "rev-parse", "main")
	mustGit(t, repo, "config", "merge.ff", "only")
	out := mergeToMain(req)
	if out.Recovery == nil || out.Recovery.Code != "LINEAR_HISTORY_REQUIRED" || out.Recovery.RepairWorktree == "" {
		t.Fatalf("linear policy: %+v", out)
	}
	if mustGit(t, bare, "rev-parse", "main") != before || mustGit(t, repo, "status", "--porcelain") != "" {
		t.Fatal("linear policy changed target")
	}
}

func TestMergeRecoveryRejectedPushPreservesReviewedCandidate(t *testing.T) {
	repo, bare, req := recoveryFixture(t)
	r := mergeToMain(req).Recovery
	if r == nil || r.Code != "READY" {
		t.Fatal("missing preview")
	}
	hook := filepath.Join(bare, "hooks", "pre-receive")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\necho 'PR required' >&2\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	req.RecoveryAction, req.Recovery = "apply", r
	out := mergeToMain(req)
	if out.Recovery == nil || out.Recovery.Code != "PUSH_FAILED" || out.Recovery.CandidateSha != r.CandidateSha {
		t.Fatalf("rejected push: %+v", out)
	}
	if mustGit(t, repo, "rev-parse", "main") != r.LocalSha || mustGit(t, bare, "rev-parse", "main") != r.RemoteSha {
		t.Fatal("rejected push changed target")
	}
	if err := os.WriteFile(hook, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if out = mergeToMain(req); out.Status != "merged" || out.Recovery.CandidateSha != r.CandidateSha {
		t.Fatalf("retry: %+v", out)
	}
}

func TestMergeRecoveryLocalAheadRequiresReview(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	bare := addOriginBare(t, repo)
	base := mustGit(t, repo, "rev-parse", "main")
	mustGit(t, repo, "checkout", "-b", "orbit/feat")
	commitFile(t, repo, "feature.txt", "feature\n", "feature")
	mustGit(t, repo, "checkout", "main")
	commitFile(t, repo, "local.txt", "local\n", "extra local commit")
	req := MergeCommand{WorkDir: repo, Branch: "orbit/feat", BaseSha: base}
	out := mergeToMain(req)
	if out.Recovery == nil || out.Recovery.Code != "TARGET_AHEAD" || mustGit(t, bare, "rev-parse", "main") != base {
		t.Fatalf("local ahead bypassed review: %+v", out)
	}
	req.RecoveryAction, req.Recovery = "preview", out.Recovery
	out = mergeToMain(req)
	if out.Recovery == nil || out.Recovery.Code != "READY" || out.Recovery.AddsMergeCommit || len(out.Recovery.LocalCommits) != 1 {
		t.Fatalf("local ahead preview: %+v", out)
	}
}

func TestMergeRecoveryLocalOnlyLandingIsNotReportedAsRemoteMerged(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	bare := addOriginBare(t, repo)
	base := mustGit(t, repo, "rev-parse", "main")
	mustGit(t, repo, "checkout", "-b", "orbit/feat")
	commitFile(t, repo, "feature.txt", "feature\n", "feature")
	mustGit(t, repo, "checkout", "main")
	mustGit(t, repo, "merge", "--ff-only", "orbit/feat")
	out := mergeToMain(MergeCommand{WorkDir: repo, Branch: "orbit/feat", BaseSha: base})
	if out.Status == "merged" || out.Recovery == nil || out.Recovery.Code != "TARGET_AHEAD" || mustGit(t, bare, "rev-parse", "main") != base {
		t.Fatalf("local landing fabricated a remote receipt: %+v", out)
	}
}

func TestMergeRecoveryDoesNotMoveTargetInAnotherWorktree(t *testing.T) {
	repo, bare, req := recoveryFixture(t)
	r := mergeToMain(req).Recovery
	mustGit(t, repo, "checkout", req.Branch)
	other := filepath.Join(t.TempDir(), "target")
	mustGit(t, repo, "worktree", "add", other, "main")
	req.RecoveryAction, req.Recovery = "apply", r
	out := mergeToMain(req)
	if out.Recovery == nil || out.Recovery.Code != "LOCAL_CHECKOUT_BLOCKED" || mustGit(t, bare, "rev-parse", "main") != r.RemoteSha {
		t.Fatalf("occupied target moved: %+v", out)
	}
}

func TestMergeRecoveryFailedCheckAndFetchDoNotPush(t *testing.T) {
	repo, bare, req := recoveryFixture(t)
	before := mustGit(t, bare, "rev-parse", "main")
	req.Check = &MergeRecoveryCheckSpec{Command: "exit 7", TimeoutSeconds: 5}
	out := mergeToMain(req)
	if out.Recovery == nil || out.Recovery.Code != "CHECK_FAILED" {
		t.Fatalf("check: %+v", out)
	}
	if mustGit(t, bare, "rev-parse", "main") != before {
		t.Fatal("failed check pushed")
	}
	mustGit(t, repo, "remote", "set-url", "origin", filepath.Join(t.TempDir(), "missing.git"))
	out = mergeToMain(req)
	if out.Recovery == nil || out.Recovery.Code != "FETCH_FAILED" {
		t.Fatalf("fetch: %+v", out)
	}
}

func TestMergeRecoveryRemoteLandedLocalBlocked(t *testing.T) {
	repo, bare, req := recoveryFixture(t)
	r := mergeToMain(req).Recovery
	if r == nil || r.Code != "READY" {
		t.Fatal("missing preview")
	}
	mustGit(t, repo, "push", "origin", r.CandidateSha+":refs/heads/main")
	if err := os.WriteFile(filepath.Join(repo, "remote.txt"), []byte("untracked work"), 0600); err != nil {
		t.Fatal(err)
	}
	req.RecoveryAction, req.Recovery = "apply", r
	out := mergeToMain(req)
	if out.Status != "merged" || out.Recovery == nil || out.Recovery.Code != "LOCAL_SYNC_PENDING" {
		t.Fatalf("partial: %+v", out)
	}
	if mustGit(t, bare, "rev-parse", "main") != r.CandidateSha {
		t.Fatal("remote changed")
	}
	if got, _ := os.ReadFile(filepath.Join(repo, "remote.txt")); string(got) != "untracked work" {
		t.Fatal("local edit lost")
	}
	// The user saves that untracked file; local-only recovery must not replay the source.
	if err := os.Rename(filepath.Join(repo, "remote.txt"), filepath.Join(repo, "saved.txt")); err != nil {
		t.Fatal(err)
	}
	req.RecoveryAction, req.Recovery = "sync-local", out.Recovery
	mustGit(t, repo, "remote", "set-url", "origin", filepath.Join(t.TempDir(), "missing.git"))
	if failed := mergeToMain(req); failed.Status == "merged" || failed.Recovery == nil || failed.Recovery.Code != "LOCAL_SYNC_PENDING" {
		t.Fatalf("lost local-only retry: %+v", failed)
	}
	mustGit(t, repo, "remote", "set-url", "origin", bare)
	if out = mergeToMain(req); out.Status != "merged" || out.Recovery == nil || out.Recovery.Code != "DONE" {
		t.Fatalf("local sync: %+v", out)
	}
}
