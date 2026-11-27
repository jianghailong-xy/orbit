package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// lockedIndexWorktree reproduces the 2026-09-05 failure in a real repository: a linked checkout
// holding the only copy of a session's work, with a stale index.lock in its git dir so that
// `git add -A` exits 128 ("Unable to create '…/index.lock': File exists") exactly as it did in
// production. Nothing about git is mocked — the lock is the same one a crashed git leaves behind.
func lockedIndexWorktree(t *testing.T, session string) *Worktree {
	t.Helper()
	wt := sessionWorktree(t, session)
	gitDir := mustGit(t, wt.Path, "rev-parse", "--absolute-git-dir")
	if err := os.WriteFile(filepath.Join(gitDir, "index.lock"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	return wt
}

// sessionWorktree builds a real repo plus a linked checkout on the session's own branch, with
// one uncommitted file standing in for everything the session produced — and a `claude` that
// declines to write its message, so a permanent end's commit takes its diffstat fallback
// without anything leaving the machine.
func sessionWorktree(t *testing.T, session string) *Worktree {
	t.Helper()
	bin := t.TempDir()
	writeFakeBin(t, bin, "claude", "exit 1")
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	repo := initRepo(t)
	base := mustGit(t, repo, "rev-parse", "HEAD")
	path := filepath.Join(t.TempDir(), "checkout")
	branch := "orbit/" + session
	mustGit(t, repo, "worktree", "add", "-b", branch, path, base)
	if err := os.WriteFile(filepath.Join(path, "work.txt"), []byte("the session's whole output\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return &Worktree{Path: path, Branch: branch, BaseSha: base, RepoDir: repo, Session: session}
}

// TestFinalizeStagingFailureDoesNotDestroyTheWork is the regression for 2026-09-05: `git add -A`
// failed, the empty index made `diff --cached --quiet` answer "nothing to commit", the session
// was reported as having changed nothing, and the checkout — the only copy of two hours of work —
// was removed. However finalize ends, the work must still exist afterwards: committed on the
// branch, or left in the checkout.
func TestFinalizeStagingFailureDoesNotDestroyTheWork(t *testing.T) {
	wt := lockedIndexWorktree(t, "sLost")

	finalizeWorktree(wt, false)
	removeWorktree(wt, nil)

	_, onBranch := git(wt.RepoDir, "cat-file", "-e", wt.Branch+":work.txt")
	_, inCheckout := os.Stat(filepath.Join(wt.Path, "work.txt"))
	if onBranch != nil && inCheckout != nil {
		t.Fatalf("the session's work is gone: not on branch %s (%v) and not in the checkout %s (%v)",
			wt.Branch, onBranch, wt.Path, inCheckout)
	}
}

// TestFinalizeReportsStagingFailureWithGitsOwnWords: the failure has to travel, and it has to say
// something. "exit status 128" — all the incident's log line carried — cannot tell an index.lock
// from a pruned admin dir from a full disk, so the next occurrence is just as untraceable.
func TestFinalizeReportsStagingFailureWithGitsOwnWords(t *testing.T) {
	wt := lockedIndexWorktree(t, "sStaging")

	files, patches, err := finalizeWorktree(wt, false)
	if err == nil {
		t.Fatal("a session whose work could not be staged must not finalize successfully")
	}
	if len(files) != 0 || len(patches) != 0 {
		t.Fatalf("a failed finalize reports no diff at all, got %d files / %d patches", len(files), len(patches))
	}
	if !strings.Contains(err.Error(), "index.lock") || !strings.Contains(err.Error(), "Unable to create") {
		t.Fatalf("the error must carry git's own explanation, not just its exit code: %v", err)
	}
	// The wrapped ExitError stays reachable, so callers that want git's raw stderr still get it.
	if !strings.Contains(gitStderr(err), "index.lock") {
		t.Fatalf("gitStderr must still reach git's stderr through the wrapper: %q", gitStderr(err))
	}
}

// TestFinalizeReportsCommitFailure: staging can succeed and the commit still fail (here: a locked
// branch ref). The work is staged but not on the branch, so this is a finalize failure too.
func TestFinalizeReportsCommitFailure(t *testing.T) {
	wt := sessionWorktree(t, "sCommit")
	lock := filepath.Join(wt.RepoDir, ".git", "refs", "heads", wt.Branch+".lock")
	if err := os.WriteFile(lock, nil, 0o644); err != nil {
		t.Fatal(err)
	}

	_, _, err := finalizeWorktree(wt, true)
	if err == nil {
		t.Fatal("a commit that git refused must not finalize successfully")
	}
	if !strings.Contains(err.Error(), "cannot lock ref") {
		t.Fatalf("the error must carry git's own explanation: %v", err)
	}

	removeWorktree(wt, nil)
	if _, statErr := os.Stat(filepath.Join(wt.Path, "work.txt")); statErr != nil {
		t.Fatalf("work staged but not committed must survive in the checkout: %v", statErr)
	}
}

// TestFinalizeCommitsWorkAsBefore is the positive control for the ordinary path: staging works,
// there are changes, so they are committed to the branch and reported as a non-empty diff.
func TestFinalizeCommitsWorkAsBefore(t *testing.T) {
	wt := sessionWorktree(t, "sOK")

	files, patches, err := finalizeWorktree(wt, true)
	if err != nil {
		t.Fatalf("an ordinary finalize must succeed: %v", err)
	}
	if len(files) != 1 || files[0].Path != "work.txt" {
		t.Fatalf("the changed file must be reported, got %+v", files)
	}
	if len(patches) != 1 || !strings.Contains(patches[0].Patch, "the session's whole output") {
		t.Fatalf("the patch must carry the change, got %+v", patches)
	}
	if _, err := git(wt.RepoDir, "cat-file", "-e", wt.Branch+":work.txt"); err != nil {
		t.Fatalf("the work must be committed on %s: %v", wt.Branch, err)
	}
	if st, _ := git(wt.Path, "status", "--porcelain"); st != "" {
		t.Fatalf("a committed checkout must be clean, got:\n%s", st)
	}

	// …and the checkout is then removable, which is the whole point of committing first.
	// Finalization no longer performs that removal; removeWorktree, which the sweep calls, is
	// the only thing that does.
	removeWorktree(wt, nil)
	if _, statErr := os.Stat(wt.Path); !os.IsNotExist(statErr) {
		t.Fatalf("a captured checkout must still be removed: %v", statErr)
	}
}

// TestFinalizeCleanSessionLeavesNoCommit is the positive control for a session that really did
// change nothing: it finalizes successfully, reports an empty diff, and adds no empty commit.
func TestFinalizeCleanSessionLeavesNoCommit(t *testing.T) {
	wt := sessionWorktree(t, "sIdle")
	if err := os.Remove(filepath.Join(wt.Path, "work.txt")); err != nil {
		t.Fatal(err)
	}

	files, patches, err := finalizeWorktree(wt, false)
	if err != nil {
		t.Fatalf("an unchanged session must finalize successfully: %v", err)
	}
	if len(files) != 0 || len(patches) != 0 {
		t.Fatalf("an unchanged session reports no diff, got %d files / %d patches", len(files), len(patches))
	}
	if head := mustGit(t, wt.Path, "rev-parse", "HEAD"); head != wt.BaseSha {
		t.Fatalf("an unchanged session must leave no commit: HEAD %s moved off base %s", head, wt.BaseSha)
	}

	removeWorktree(wt, nil)
	if _, statErr := os.Stat(wt.Path); !os.IsNotExist(statErr) {
		t.Fatalf("an unchanged session's checkout is still removable: %v", statErr)
	}
}

// TestTheSingleDeleterHonoursTheFinalizeVerdict: the server's "this checkout may go" is decided
// for a task that completed successfully, from a finalize report that said the session changed
// nothing — and a finalize that FAILED reports exactly that too, while holding the only copy of
// the work. Reclamation is now deferred to the sweep rather than done at finalize, which moves
// this refusal into removeWorktree; it still has to hold, because the sweep asks the server the
// same question and gets the same "removable" answer.
func TestTheSingleDeleterHonoursTheFinalizeVerdict(t *testing.T) {
	wt := lockedIndexWorktree(t, "sVerdict")
	_, _, captureErr := finalizeWorktree(wt, false)
	if captureErr == nil {
		t.Fatal("precondition: staging was supposed to fail")
	}

	removeWorktree(wt, nil)

	if _, err := os.Stat(filepath.Join(wt.Path, "work.txt")); err != nil {
		t.Fatalf("the checkout holding the only copy must survive a removable verdict: %v", err)
	}
	if _, err := git(wt.RepoDir, "worktree", "list", "--porcelain"); err != nil {
		t.Fatalf("the worktree registration must be intact: %v", err)
	}
}

// TestOrphanSweepKeepsUncapturedWork: keeping the checkout at finalize is worth nothing if the
// next runner start sweeps it. The control plane calls a completed session's checkout removable
// because the SESSION is over — which is exactly the state the lost session was left in — so the
// sweep has to make the same check before it deletes.
func TestOrphanSweepKeepsUncapturedWork(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	stranded := lockedIndexWorktree(t, "sSwept")
	// Sweep candidates are the directories under worktreesDir(), named by session id.
	inRoot := filepath.Join(worktreesDir(), stranded.Session)
	mustGit(t, stranded.RepoDir, "worktree", "move", stranded.Path, inRoot)
	stranded.Path = inRoot

	finalizeWorktree(stranded, false)
	removeWorktree(stranded, nil)
	if _, err := git(stranded.RepoDir, "cat-file", "-e", stranded.Branch+":work.txt"); err == nil {
		t.Fatal("precondition: the locked index was supposed to keep the work off the branch")
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(WorktreesRemovableResponse{Removable: []string{stranded.Session}})
	}))
	defer srv.Close()

	gcWorktrees(NewTransport(srv.URL, "capture-token"), map[string]bool{}, diskUnderTheFloor())

	if _, err := os.Stat(filepath.Join(stranded.Path, "work.txt")); err != nil {
		t.Fatalf("the sweep deleted work that no branch has a copy of: %v", err)
	}
}

// TestOrphanSweepStillCollectsCapturedCheckouts: the guard must not turn the sweep off. A
// checkout whose work is committed is still collected, which is what keeps the disk bounded.
func TestOrphanSweepStillCollectsCapturedCheckouts(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	done := sessionWorktree(t, "sDone")
	inRoot := filepath.Join(worktreesDir(), done.Session)
	mustGit(t, done.RepoDir, "worktree", "move", done.Path, inRoot)
	done.Path = inRoot

	if _, _, err := finalizeWorktree(done, true); err != nil {
		t.Fatalf("finalize must succeed: %v", err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(WorktreesRemovableResponse{Removable: []string{done.Session}})
	}))
	defer srv.Close()

	gcWorktrees(NewTransport(srv.URL, "capture-token"), map[string]bool{}, diskUnderTheFloor())

	if _, err := os.Stat(done.Path); !os.IsNotExist(err) {
		t.Fatalf("a committed checkout must still be swept: %v", err)
	}
}

// A read-only checkout of the project tip must not report the project's newer files as this session's.
func TestDetachedWorktreeReportsSessionBranch(t *testing.T) {
	wt := sessionWorktree(t, "sDetachedRead")
	if err := os.Remove(filepath.Join(wt.Path, "work.txt")); err != nil {
		t.Fatal(err)
	}
	commitFile(t, wt.RepoDir, "project.txt", "project work\n", "another session's work")
	projectTip := mustGit(t, wt.RepoDir, "rev-parse", "HEAD")
	mustGit(t, wt.RepoDir, "update-ref", "refs/remotes/origin/project/test", projectTip)
	mustGit(t, wt.RepoDir, "reset", "--hard", wt.BaseSha)
	mustGit(t, wt.Path, "checkout", "--detach", "origin/project/test")

	if files, patches := liveDiff(wt); len(files) != 0 || len(patches) != 0 {
		t.Errorf("turn-complete diff included detached HEAD's project work: %v, %v", files, patches)
	}
	samples := collectHeartbeatSessionStates(context.Background(), []heartbeatTelemetryTarget{
		{sessionID: wt.Session, isolationStatus: isoWorktree, worktree: wt},
	})
	if len(samples) != 1 || len(samples[0].state.ChangedFiles) != 0 || samples[0].state.BranchSha != wt.BaseSha {
		t.Errorf("heartbeat did not report the unchanged session branch: %+v", samples)
	}

	req := RunFinalizeRequest{Status: stSucceeded}
	finalizeWorktreeReport(&req, wt.Session, wt, req.Status)
	if req.BranchSha != wt.BaseSha || req.CaptureError != "" || req.WorktreeDirty {
		t.Errorf("read-only detached checkout should finalize cleanly at its branch tip: %+v", req)
	}
	for _, body := range []any{req, releaseRequestOf(req, holdNone)} {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			t.Fatal(err)
		}
		for field, want := range map[string]string{
			"changedFiles": "[]", "changedDiff": "[]", "branchCommits": "[]", "worktreeDetached": "true",
		} {
			if got := string(fields[field]); got != want {
				t.Errorf("%T: %s = %q, want %s", body, field, got, want)
			}
		}
		if _, ok := fields["worktreeBranch"]; ok {
			t.Errorf("%T: detached HEAD reported a checked-out branch", body)
		}
	}
	if head := mustGit(t, wt.Path, "rev-parse", "HEAD"); head != projectTip {
		t.Fatalf("read-only finalize moved detached HEAD to %s, want %s", head, projectTip)
	}
	t.Run("session checkout", func(t *testing.T) {
		removeWorktree(wt, nil)
		if _, err := os.Stat(wt.Path); !os.IsNotExist(err) {
			t.Fatalf("cleanup did not remove a read-only detached checkout: %v", err)
		}
	})
	t.Run("orphan sweep checkout", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "orphan")
		mustGit(t, wt.RepoDir, "worktree", "add", "--detach", path, projectTip)
		removeWorktree(&Worktree{Path: path, RepoDir: wt.RepoDir, Session: wt.Session}, nil)
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("orphan sweep did not remove a read-only detached checkout: %v", err)
		}
	})
}

// Detach one commit behind the session tip and edit a tracked file.
func detachedEditWorktree(t *testing.T, id string) *Worktree {
	t.Helper()
	wt := sessionWorktree(t, id)
	commitFile(t, wt.Path, "work.txt", "session branch work\n", "on the session branch")
	mustGit(t, wt.Path, "checkout", "--detach", "HEAD~1")
	if err := os.WriteFile(filepath.Join(wt.Path, "base.txt"), []byte("detached edit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return wt
}

func TestDetachedFinalizeKeepsEditAndRefusesRemoval(t *testing.T) {
	wt := detachedEditWorktree(t, "sDetachedEdit")
	tip := mustGit(t, wt.RepoDir, "rev-parse", "refs/heads/"+wt.Branch)
	var req RunFinalizeRequest
	finalizeWorktreeReport(&req, wt.Session, wt, stSucceeded)
	if req.CaptureError == "" || !req.WorktreeDirty {
		t.Errorf("off-branch edit must be reported as uncaptured and dirty: %+v", req)
	}
	if req.BranchSha != tip || len(req.BranchCommits) != 1 || req.BranchCommits[0].Sha != tip ||
		len(req.ChangedFiles) != 1 || req.ChangedFiles[0].Path != "work.txt" {
		t.Errorf("finalize did not report the session branch's own work: %+v", req)
	}
	head := mustGit(t, wt.Path, "rev-parse", "HEAD")
	if edit := mustGit(t, wt.RepoDir, "show", head+":base.txt"); edit != "detached edit" {
		t.Fatalf("detached commit lost the edit: %q", edit)
	}
	if refs := mustGit(t, wt.RepoDir, "for-each-ref", "--contains", head, "refs/orbit/detached/"); refs == "" {
		t.Error("detached edit is unreachable from a recovery ref")
	}
	if status := mustGit(t, wt.Path, "status", "--porcelain"); status != "" {
		t.Fatalf("test must exercise cleanup of a Git-clean detached checkout, got %q", status)
	}
	orphan := &Worktree{Path: wt.Path, RepoDir: wt.RepoDir, Session: wt.Session}
	t.Run("reachable only from recovery ref and checkout", func(t *testing.T) {
		for _, candidate := range []*Worktree{wt, orphan} {
			removeWorktree(candidate, nil)
			if _, err := os.Stat(wt.Path); err != nil {
				t.Fatalf("cleanup with branch %q removed the recovery checkout: %v", candidate.Branch, err)
			}
		}
	})
	t.Run("reachable only from checkout", func(t *testing.T) {
		mustGit(t, wt.RepoDir, "update-ref", "-d", detachedRecoveryRef(wt.Session, head))
		for _, candidate := range []*Worktree{wt, orphan} {
			removeWorktree(candidate, nil)
			if _, err := os.Stat(wt.Path); err != nil {
				t.Fatalf("cleanup with branch %q removed the checkout with an unpinned commit: %v", candidate.Branch, err)
			}
		}
	})
}

func TestDetachedParkResumesWithRecoveredEdit(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	wt := detachedEditWorktree(t, "sDetachedPark")
	path := filepath.Join(worktreesDir(), wt.Session)
	mustGit(t, wt.RepoDir, "worktree", "move", wt.Path, path)
	wt.Path = path

	var req RunFinalizeRequest
	finalizeWorktreeReport(&req, wt.Session, wt, stCancelled)
	head := mustGit(t, path, "rev-parse", "HEAD")
	ref := detachedRecoveryRef(wt.Session, head)
	if req.CaptureError == "" || !req.WorktreeDirty || !req.WorktreeDetached {
		t.Fatalf("park did not report the detached work as uncaptured: %+v", req)
	}
	if tip := mustGit(t, wt.RepoDir, "rev-parse", ref); tip != head {
		t.Fatalf("park recovery ref points to %s, want %s", tip, head)
	}

	job := &ClaimedSession{SessionID: wt.Session, Branch: wt.Branch}
	execDir := setupWorktree(job, wt.RepoDir)
	if execDir != path || job.WT == nil {
		t.Fatalf("resume did not reattach the existing checkout: %q", execDir)
	}
	settleSessionCheckout(job, execDir)
	if tip, branch := mustGit(t, path, "rev-parse", "HEAD"), currentBranch(job.WT); tip != head || branch != "" {
		t.Fatalf("resume should keep the permanent detached commit %s, got %s on branch %q", head, tip, branch)
	}
	if content, err := os.ReadFile(filepath.Join(path, "base.txt")); err != nil || string(content) != "detached edit\n" {
		t.Fatalf("resumed checkout lost its edit: %q, %v", content, err)
	}
	if content := mustGit(t, wt.RepoDir, "show", "refs/heads/"+wt.Branch+":base.txt"); content != "base" {
		t.Fatalf("the session branch should not contain the detached edit, found %q", content)
	}
}
