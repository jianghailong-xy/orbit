package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The new-style worktree path: gates G1/G4/G6 (docs/project-source-contract.md §5) and the
// fail-closed behaviour that replaces §0's three degradations.
//
// Against real git throughout, for the reason source_pin_test.go gives: the property under test is
// that the checkout stands on the commit the control plane froze *whatever the shared workspace
// happens to be doing*, and a fake git can be made to agree with any story at all.

// pinnedJob builds a new-style session frozen on baseSha, identifying its repository the way a
// real binding does — by the URL the checkout's own remote states.
func pinnedJob(t *testing.T, sessionID, workDir, baseSha string) *ClaimedSession {
	t.Helper()
	repoURL, _ := git(workDir, "remote", "get-url", "origin")
	return &ClaimedSession{
		SessionID: sessionID,
		WorkDir:   workDir,
		Branch:    "orbit/" + sessionID,
		Source: &SessionSource{
			State:          sourceStatePinned,
			Kind:           "PROJECT_UPSTREAM",
			CodebaseID:     "22222222-2222-4222-8222-222222222222",
			RepoURL:        repoURL,
			Ref:            "refs/heads/main",
			ConfigRevision: "0",
			RefAuthority:   refAuthorityRemote,
			RemoteName:     "origin",
			BaseSha:        baseSha,
		},
	}
}

// workspaceState is what the shared checkout looked like before a session started, so a test can
// say "and none of this moved" in one line. Moving it is the failure mode §0 describes: sessions
// that follow the shared checkout make every run depend on what somebody left it on.
type workspaceState struct{ branch, head, status, dirty string }

func captureWorkspace(t *testing.T, repo string) workspaceState {
	t.Helper()
	dirty, _ := os.ReadFile(filepath.Join(repo, "dirty.txt"))
	status, _ := git(repo, "status", "--porcelain")
	return workspaceState{
		branch: mustGit(t, repo, "rev-parse", "--abbrev-ref", "HEAD"),
		head:   mustGit(t, repo, "rev-parse", "HEAD"),
		status: status,
		dirty:  string(dirty),
	}
}

func (before workspaceState) mustBeUntouched(t *testing.T, repo string) {
	t.Helper()
	if after := captureWorkspace(t, repo); after != before {
		t.Errorf("the shared checkout was moved or written to:\n before %+v\n  after %+v", before, after)
	}
}

// The heart of the task: a new-style run forks from the FROZEN commit, and the shared checkout is
// an input to none of it — not its branch, not its HEAD, not its uncommitted work, and not the
// merge target that used to be written back on every "Merge to…" pick.
//
// Each case leaves the workspace somewhere a Legacy session would have inherited, then asserts the
// checkout carries the pinned commit's tree instead: `pinned.txt` present, `later.txt` absent. The
// second half is what makes it an assertion rather than a coincidence — `later.txt` is only in the
// workspace's own HEAD, so a run that inherited HEAD would carry it.
func TestSourceWorktreeForksFromThePinnedShaWhateverTheWorkspaceIsDoing(t *testing.T) {
	for _, tc := range []struct {
		name        string
		mergeTarget string
		arrange     func(t *testing.T, repo string)
	}{
		{name: "workspace parked on another branch", arrange: func(t *testing.T, repo string) {
			mustGit(t, repo, "checkout", "-b", "sidetrack")
			commitFile(t, repo, "side.txt", "side\n", "unrelated work on another branch")
		}},
		{name: "workspace HEAD behind the pin", arrange: func(t *testing.T, repo string) {
			mustGit(t, repo, "reset", "--hard", "HEAD~2")
		}},
		{name: "workspace HEAD ahead of the pin", arrange: func(t *testing.T, repo string) {
			commitFile(t, repo, "ahead.txt", "ahead\n", "workspace ran on past the pin")
		}},
		{name: "workspace has a dirty file", arrange: func(t *testing.T, repo string) {
			if err := os.WriteFile(filepath.Join(repo, "dirty.txt"), []byte("someone's wip\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "defaultMergeTarget was changed", mergeTarget: "release/2.0", arrange: func(t *testing.T, repo string) {
			mustGit(t, repo, "branch", "release/2.0")
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("ORBIT_HOME", t.TempDir())
			repo := initRepo(t)
			addOriginBare(t, repo)
			commitFile(t, repo, "pinned.txt", "pinned\n", "the commit this run is about")
			pinned := mustGit(t, repo, "rev-parse", "HEAD")
			commitFile(t, repo, "later.txt", "later\n", "the workspace moved on afterwards")
			tc.arrange(t, repo)
			before := captureWorkspace(t, repo)

			job := pinnedJob(t, "s-pinned", repo, pinned)
			job.MergeTarget = tc.mergeTarget
			execDir := setupWorktree(job, repo)

			if job.SourceRefusal != nil {
				t.Fatalf("refused with %s: %v", job.SourceRefusal.Code, job.SourceRefusal.Detail)
			}
			if job.IsolationStatus != isoWorktree || job.WT == nil {
				t.Fatalf("IsolationStatus = %q (wt=%v), want a real worktree", job.IsolationStatus, job.WT)
			}
			if job.WT.BaseSha != pinned {
				t.Errorf("BaseSha = %s, want the pinned commit %s", job.WT.BaseSha, pinned)
			}
			if head := mustGit(t, job.WT.Path, "rev-parse", "HEAD"); head != pinned {
				t.Errorf("checkout HEAD = %s, want the pinned commit %s", head, pinned)
			}
			if branch := mustGit(t, job.WT.Path, "rev-parse", "--abbrev-ref", "HEAD"); branch != job.Branch {
				t.Errorf("checkout is on %q, want its own branch %q", branch, job.Branch)
			}
			if _, err := os.Stat(filepath.Join(execDir, "pinned.txt")); err != nil {
				t.Errorf("checkout must carry the pinned commit's tree: %v", err)
			}
			if _, err := os.Stat(filepath.Join(execDir, "later.txt")); err == nil {
				t.Error("checkout carries a commit made after the pin — it forked from the workspace, not the pin")
			}
			before.mustBeUntouched(t, repo)
		})
	}
}

// The four ways a new-style run is refused, each with the code §10.1 froze for it. What every case
// asserts in common is the fail-closed triple: no exec dir (so no engine), no worktree, and an
// IsolationStatus still empty — the Legacy path would have written one of §0's degradations there
// and handed back the user's own checkout to work in.
func TestSourceWorktreeRefusesWithAStableCode(t *testing.T) {
	t.Run("the pinned object is not here and cannot be fetched", func(t *testing.T) {
		t.Setenv("ORBIT_HOME", t.TempDir())
		repo := initRepo(t)
		addOriginBare(t, repo)
		before := captureWorkspace(t, repo)

		// A syntactically valid commit that exists in no repository anywhere: G4's "the baseline is
		// an object" has nothing to find, and there is no ref whose tip could be substituted for it.
		job := pinnedJob(t, "s-gone", repo, strings.Repeat("b", 40))
		if got := setupWorktree(job, repo); got != "" {
			t.Errorf("exec dir %q; a refused run has nowhere to run", got)
		}
		assertRefused(t, job, sourceRefusalShaUnavailable)
		before.mustBeUntouched(t, repo)
	})

	t.Run("the workspace is a different repository", func(t *testing.T) {
		t.Setenv("ORBIT_HOME", t.TempDir())
		theirs := initRepo(t)
		addOriginBare(t, theirs)
		commitFile(t, theirs, "theirs.txt", "not ours\n", "work in the wrong repo")
		before := captureWorkspace(t, theirs)

		// The identity is the project's; the checkout is somebody else's. Neither half of SR37's
		// disjunction holds, and the run may not quietly adopt what this workspace does contain.
		job := pinnedJob(t, "s-foreign", theirs, mustGit(t, theirs, "rev-parse", "HEAD"))
		job.Source.RepoURL = "https://example.invalid/acme/widgets"
		job.Source.RootCommitSha = strings.Repeat("c", 40)
		if got := setupWorktree(job, theirs); got != "" {
			t.Errorf("exec dir %q; a refused run has nowhere to run", got)
		}
		assertRefused(t, job, sourceRefusalRepoMismatch)
		before.mustBeUntouched(t, theirs)
		// SR23's point, and the reason G1 outranks G4: the pinned commit IS present in this
		// checkout, so an implementation that asked "can I find the object?" first would have
		// started the run here.
		if _, err := git(theirs, "cat-file", "-e", job.Source.BaseSha+"^{commit}"); err != nil {
			t.Fatal("fixture is not exercising G1-before-G4: the object is missing too")
		}
	})

	t.Run("the ref is not fresh because the authority cannot be asked", func(t *testing.T) {
		t.Setenv("ORBIT_HOME", t.TempDir())
		origin, clone, _ := originAndClone(t)
		// The clone still has origin/main from the clone itself — a local ref that is a real
		// commit and would resolve fine. SR38/SR39 say freshness is the fetch, not the age of
		// what happens to be lying around, so with the authority gone this must refuse rather
		// than fall back to it.
		stale := mustGit(t, clone, "rev-parse", "refs/remotes/origin/main")
		if err := os.RemoveAll(origin); err != nil {
			t.Fatal(err)
		}
		before := captureWorkspace(t, clone)

		job := selectedJob(clone)
		sha, refusal := resolveSourceSha(job)
		if refusal == nil {
			t.Fatalf("resolved %s from a checkout whose authority is gone; %s was the stale local ref", sha, stale)
		}
		if refusal.Code != sourceRefusalAuthorityUnreachable {
			t.Errorf("refusal code %q, want %q", refusal.Code, sourceRefusalAuthorityUnreachable)
		}
		if sha != "" {
			t.Errorf("a refusal also produced a commit (%s); one of the two is not true", sha)
		}
		// And the run stops before a checkout exists: the pin never happened, so setupWorktree is
		// never reached with a frozen commit, and asking it anyway is refused rather than guessed.
		if got := setupWorktree(job, clone); got != "" {
			t.Errorf("exec dir %q for a session that never froze a commit", got)
		}
		assertRefused(t, job, sourceRefusalShaUnavailable)
		before.mustBeUntouched(t, clone)
	})

	t.Run("the worktree cannot be created", func(t *testing.T) {
		t.Setenv("ORBIT_HOME", t.TempDir())
		repo := initRepo(t)
		addOriginBare(t, repo)
		pinned := mustGit(t, repo, "rev-parse", "HEAD")
		before := captureWorkspace(t, repo)

		// Something else already owns the path the checkout would take, which is what `git
		// worktree add` refuses on. G6 is last for SR24's reason: this is the one level a
		// different machine would fix.
		occupied := filepath.Join(worktreesDir(), "s-blocked")
		if err := os.MkdirAll(occupied, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(occupied, "in-the-way.txt"), []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}

		job := pinnedJob(t, "s-blocked", repo, pinned)
		if got := setupWorktree(job, repo); got != "" {
			t.Errorf("exec dir %q; a refused run has nowhere to run", got)
		}
		assertRefused(t, job, sourceRefusalWorktreeRequired)
		before.mustBeUntouched(t, repo)
		// The base ref the attempt wrote is taken back down: a run that did not start must not
		// leave a fork point behind for the next one to find.
		if _, err := git(repo, "rev-parse", "--verify", baseRefName("s-blocked")); err == nil {
			t.Error("a failed worktree creation left its base ref in the shared repo")
		}
	})
}

func assertRefused(t *testing.T, job *ClaimedSession, wantCode string) {
	t.Helper()
	if job.SourceRefusal == nil {
		t.Fatalf("no refusal recorded; want %s", wantCode)
	}
	if job.SourceRefusal.Code != wantCode {
		t.Errorf("refusal code %q, want %q (detail %v)", job.SourceRefusal.Code, wantCode, job.SourceRefusal.Detail)
	}
	if job.WT != nil {
		t.Errorf("a refused run was given a worktree at %s", job.WT.Path)
	}
	if job.IsolationStatus != "" {
		t.Errorf("IsolationStatus = %q; a refused run degraded to a shared checkout instead of stopping",
			job.IsolationStatus)
	}
}

// G1 runs before the authority is asked, and the observable consequence is that a foreign checkout
// is never fetched INTO. The old order would have run `git fetch` in somebody else's repository and
// frozen whatever ref of that name it carried — and a pin is immutable, so the mistake would
// outlive the discovery of it.
func TestForeignWorkspaceIsRefusedBeforeItIsFetchedInto(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	_, clone, _ := originAndClone(t)
	if _, err := os.Stat(filepath.Join(clone, ".git", "FETCH_HEAD")); err == nil {
		t.Fatal("fixture already has a FETCH_HEAD; the assertion below would be vacuous")
	}

	job := selectedJob(clone)
	job.Source.RepoURL = "https://example.invalid/acme/widgets"
	sha, refusal := resolveSourceSha(job)
	if refusal == nil || refusal.Code != sourceRefusalRepoMismatch {
		t.Fatalf("resolved %s / refusal %v; want %s", sha, refusal, sourceRefusalRepoMismatch)
	}
	if _, err := os.Stat(filepath.Join(clone, ".git", "FETCH_HEAD")); err == nil {
		t.Error("a repository that failed the identity check was fetched into anyway")
	}
}

// SR36: identity is one pure function, and it has to agree with the decomposition clone.go already
// does — two spellings of one repository must not become two repositories on one of the two sides.
func TestCanonicalRepoURLAgreesWithCloneDirName(t *testing.T) {
	for _, spellings := range [][]string{
		{"https://github.com/acme/widgets", "https://github.com/acme/widgets.git",
			"https://github.com/acme/widgets/", "git@github.com:acme/widgets.git",
			"ssh://git@github.com/acme/widgets", "  https://GitHub.com/acme/widgets  "},
		{"https://gitlab.example/team/tools", "git@gitlab.example:team/tools.git"},
	} {
		wantURL := canonicalizeRepoURL(spellings[0])
		wantDir, err := cloneDirName(spellings[0])
		if err != nil {
			t.Fatalf("cloneDirName(%q): %v", spellings[0], err)
		}
		for _, spelling := range spellings[1:] {
			if got := canonicalizeRepoURL(spelling); got != wantURL {
				t.Errorf("canonicalizeRepoURL(%q) = %q, want %q", spelling, got, wantURL)
			}
			gotDir, err := cloneDirName(spelling)
			if err != nil {
				t.Fatalf("cloneDirName(%q): %v", spelling, err)
			}
			if gotDir != wantDir {
				t.Errorf("cloneDirName(%q) = %q, want %q — the two rules have drifted apart",
					spelling, gotDir, wantDir)
			}
		}
	}
	// Different repositories must stay different: a canonicaliser that collapses everything would
	// pass every assertion above and make G1 answer "yes" to any workspace at all.
	for _, pair := range [][2]string{
		{"https://github.com/acme/widgets", "https://github.com/acme/gadgets"},
		{"https://github.com/acme/widgets", "https://gitlab.example/acme/widgets"},
		{"https://github.com/acme/widgets", "https://github.com:8443/acme/widgets"},
	} {
		if canonicalizeRepoURL(pair[0]) == canonicalizeRepoURL(pair[1]) {
			t.Errorf("%q and %q canonicalise to the same identity", pair[0], pair[1])
		}
	}
}
