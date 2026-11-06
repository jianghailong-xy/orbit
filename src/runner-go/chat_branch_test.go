package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// A wiki chat on the runner (wiki contract chat.source and chat.branch, design §5.2;
// docs/project-source-contract.md SR54), against real git: the chat forks from origin's main as the
// first claim pinned it, whatever the workspace's checkout has checked out, and a chat that ends with
// nothing of its own leaves no branch behind.

// chatJob is a chat's claim as the server hands it to the runner: a CHAT_UPSTREAM selector on
// refs/heads/main, asked of origin, with no codebase behind it (and so no codebaseId).
func chatJob(workDir, id string) *ClaimedSession {
	return &ClaimedSession{
		SessionID: id,
		WorkDir:   workDir,
		Branch:    "orbit/chat-" + id,
		Source: &SessionSource{
			State:          sourceStateSelected,
			Kind:           sourceKindChatUpstream,
			RepoURL:        "https://example.invalid/acme/widgets",
			Ref:            "refs/heads/main",
			ConfigRevision: "0",
			RefAuthority:   refAuthorityRemote,
		},
	}
}

// pinnedChat is a chat whose first claim pinned origin's main and made its checkout, as runLoop does:
// the pin first (ensureSourcePinned), then the checkout on it (setupWorktree).
func pinnedChat(t *testing.T, clone, id string) *ClaimedSession {
	t.Helper()
	job := chatJob(clone, id)
	if err := ensureSourcePinned(context.Background(), NewTransport(newPinServer(t).URL, "tok"), job); err != nil {
		t.Fatalf("ensureSourcePinned: %v", err)
	}
	if execDir := setupWorktree(job, clone); execDir == "" || job.WT == nil || job.SourceRefusal != nil {
		t.Fatalf("setupWorktree = %q, WT %+v, refusal %+v", execDir, job.WT, job.SourceRefusal)
	}
	return job
}

// branchAt is where refs/heads/<branch> points, or "" when there is no such branch.
func branchAt(repo, branch string) string {
	out, err := git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch)
	if err != nil {
		return ""
	}
	return out
}

// The claim a chat arrives on decodes, codebaseId null and all, and takes the pin path a project task
// takes: nothing in the runner needs a codebase to pin or to isolate a run.
func TestAChatClaimWithNoCodebaseDecodesAndPins(t *testing.T) {
	var job ClaimedSession
	payload := `{"sessionId":"34sChatA0000000000000","branch":"orbit/chat","source":{"state":"SELECTED","kind":"CHAT_UPSTREAM",` +
		`"codebaseId":null,"repoUrl":"https://example.invalid/acme/widgets","ref":"refs/heads/main","configRevision":"0",` +
		`"refAuthority":"REMOTE","remoteName":"origin","requiredContains":[]}}`
	if err := json.Unmarshal([]byte(payload), &job); err != nil {
		t.Fatalf("the chat's claim did not decode: %v", err)
	}
	if job.Source == nil || job.Source.CodebaseID != "" || job.Source.Ref != "refs/heads/main" {
		t.Fatalf("source = %+v", job.Source)
	}
	if !needsSourcePin(&job) || !isWikiChat(&job) {
		t.Fatalf("needsSourcePin=%v isWikiChat=%v, want both", needsSourcePin(&job), isWikiChat(&job))
	}
	project := selectedJob(t.TempDir())
	if isWikiChat(project) || isWikiChat(&ClaimedSession{SessionID: "legacy"}) {
		t.Fatal("a project task's run, or a Legacy session, read as a chat")
	}
}

// The chat starts from origin's main as it stood at its first claim: not from the workspace
// checkout's HEAD, which here is a local branch with work of its own on an older main.
func TestAChatForksFromThePinnedOriginMainNotTheWorkDirHead(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	origin, clone, atClone := originAndClone(t)
	commitFile(t, origin, "later.txt", "later\n", "main moved on")
	main := mustGit(t, origin, "rev-parse", "HEAD")
	mustGit(t, clone, "checkout", "-q", "-b", "wip")
	commitFile(t, clone, "wip.txt", "local\n", "local work")
	head := mustGit(t, clone, "rev-parse", "HEAD")
	if main == atClone || head == main {
		t.Fatal("CONTROL: the fixture must leave the workDir's HEAD off origin's main")
	}

	job := chatJob(clone, "sess-chat-fork")
	sha, refusal := resolveSourceSha(job)
	if refusal != nil || sha != main {
		t.Fatalf("resolved %q (refusal %+v), want origin's main %s; the workDir's HEAD is %s", sha, refusal, main, head)
	}

	job = pinnedChat(t, clone, "sess-chat-fork")
	if job.Source.State != sourceStatePinned || job.Source.BaseSha != main {
		t.Fatalf("pinned %s at %s, want PINNED at %s", job.Source.State, job.Source.BaseSha, main)
	}
	path := filepath.Join(worktreesDir(), "sess-chat-fork")
	if job.WT.Path != path || job.IsolationStatus != isoWorktree {
		t.Fatalf("checkout %q (%s), want an isolated one at %q", job.WT.Path, job.IsolationStatus, path)
	}
	if got := mustGit(t, path, "rev-parse", "HEAD"); got != main {
		t.Fatalf("the checkout's HEAD is %s, want the pinned %s (workDir HEAD %s)", got, main, head)
	}
	if got := mustGit(t, path, "symbolic-ref", "--short", "HEAD"); got != job.Branch {
		t.Fatalf("the checkout is on %q, want the chat's branch %q", got, job.Branch)
	}
	if job.WT.BaseSha != main {
		t.Fatalf("its diff base is %s, want the pin %s", job.WT.BaseSha, main)
	}
	if _, err := os.Stat(filepath.Join(path, "wip.txt")); !os.IsNotExist(err) {
		t.Fatal("the checkout carries the workDir branch's local work")
	}
}

// A chat that read and answered, and changed nothing, leaves no branch, checkout or base ref behind:
// whether its end was a finish or a cancel, which takes a park checkpoint when there is anything to keep.
func TestAChatThatEndsWithNoCommitLeavesNoBranch(t *testing.T) {
	for _, status := range []string{stSucceeded, stCancelled, stFailed} {
		t.Run(status, func(t *testing.T) {
			t.Setenv("ORBIT_HOME", t.TempDir())
			_, clone, _ := originAndClone(t)
			job := pinnedChat(t, clone, "sess-chat-"+status)
			path, branch := job.WT.Path, job.WT.Branch

			var req RunFinalizeRequest
			finalizeWorktreeReport(&req, job.SessionID, job.WT, status)
			if req.Branch != branch || req.CaptureError != "" {
				t.Fatalf("CONTROL: finalize reported branch %q, capture error %q", req.Branch, req.CaptureError)
			}
			if !dropEmptyChatBranch(job) {
				t.Fatal("an empty chat kept its branch")
			}
			if got := branchAt(clone, branch); got != "" {
				t.Fatalf("branch %s is still there, at %s", branch, got)
			}
			if !checkoutAbsent(path) {
				t.Fatalf("the checkout %s is still on disk", path)
			}
			if _, err := git(clone, "rev-parse", "--verify", "--quiet", baseRefName(job.SessionID)); err == nil {
				t.Fatal("the chat's base ref was left behind")
			}
			if list := mustGit(t, clone, "worktree", "list", "--porcelain"); containsLine(list, "worktree "+path) {
				t.Fatalf("git still lists the checkout:\n%s", list)
			}
		})
	}
}

// What a chat made is kept as any session's is: a commit of its own, or work it left uncommitted,
// which the end commits onto the branch (a park checkpoint for a cancel) before anything is judged.
func TestAChatWithWorkKeepsItsBranch(t *testing.T) {
	cases := map[string]struct {
		status string
		work   func(t *testing.T, checkout string)
	}{
		"a commit of its own": {stSucceeded, func(t *testing.T, checkout string) {
			commitFile(t, checkout, "fix.txt", "fixed\n", "fix the doc's source")
		}},
		"uncommitted work at a finish": {stSucceeded, func(t *testing.T, checkout string) {
			if err := os.WriteFile(filepath.Join(checkout, "draft.txt"), []byte("draft\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		"uncommitted work at a cancel": {stCancelled, func(t *testing.T, checkout string) {
			if err := os.WriteFile(filepath.Join(checkout, "draft.txt"), []byte("draft\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Setenv("ORBIT_HOME", t.TempDir())
			_, clone, _ := originAndClone(t)
			job := pinnedChat(t, clone, "sess-chat-work")
			pin, path, branch := job.Source.BaseSha, job.WT.Path, job.WT.Branch
			tc.work(t, path)

			var req RunFinalizeRequest
			finalizeWorktreeReport(&req, job.SessionID, job.WT, tc.status)
			if dropEmptyChatBranch(job) {
				t.Fatal("a chat with work of its own lost its branch")
			}
			tip := branchAt(clone, branch)
			if tip == "" || tip == pin {
				t.Fatalf("branch %s is at %q, want past the pin %s", branch, tip, pin)
			}
			if checkoutAbsent(path) {
				t.Fatal("the checkout of a chat with work was removed")
			}
		})
	}
}

// Only a chat drops its branch: any other pinned run that changed nothing keeps it, as it always has.
func TestAPinnedRunThatIsNotAChatKeepsAnEmptyBranch(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	_, clone, _ := originAndClone(t)
	job := selectedJob(clone)
	if err := ensureSourcePinned(context.Background(), NewTransport(newPinServer(t).URL, "tok"), job); err != nil {
		t.Fatalf("ensureSourcePinned: %v", err)
	}
	if setupWorktree(job, clone) == "" || job.WT == nil {
		t.Fatalf("CONTROL: no checkout, refusal %+v", job.SourceRefusal)
	}

	var req RunFinalizeRequest
	finalizeWorktreeReport(&req, job.SessionID, job.WT, stSucceeded)
	if dropEmptyChatBranch(job) {
		t.Fatal("a project task's run dropped its branch")
	}
	if got := branchAt(clone, job.Branch); got != job.Source.BaseSha {
		t.Fatalf("branch %s is at %q, want it kept at the pin %s", job.Branch, got, job.Source.BaseSha)
	}
	if checkoutAbsent(job.WT.Path) {
		t.Fatal("a project task's checkout was removed at its end")
	}
}

// An agent that moved the checkout off the chat's branch, or detached it, may have put work where the
// pin's branch does not show it: the checkout stays, and so does the branch.
func TestAChatCheckoutOffItsBranchIsKept(t *testing.T) {
	moves := map[string]func(t *testing.T, checkout string){
		"onto a branch of its own": func(t *testing.T, checkout string) {
			mustGit(t, checkout, "checkout", "-q", "-b", "feature/elsewhere")
		},
		"detached": func(t *testing.T, checkout string) {
			mustGit(t, checkout, "checkout", "-q", "--detach")
		},
	}
	for name, move := range moves {
		t.Run(name, func(t *testing.T) {
			t.Setenv("ORBIT_HOME", t.TempDir())
			_, clone, _ := originAndClone(t)
			job := pinnedChat(t, clone, "sess-chat-moved")
			move(t, job.WT.Path)

			if dropEmptyChatBranch(job) {
				t.Fatal("a chat whose checkout left its branch dropped it")
			}
			if branchAt(clone, job.WT.Branch) != job.Source.BaseSha || checkoutAbsent(job.WT.Path) {
				t.Fatal("the branch or the checkout went")
			}
		})
	}
}

// A chat that comes back after its branch was dropped is the same chat on the same code: its pin is
// frozen, so its next claim makes the checkout again, on the same branch, at the same commit.
func TestADroppedChatComesBackOnItsPin(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	origin, clone, _ := originAndClone(t)
	job := pinnedChat(t, clone, "sess-chat-back")
	pin, path := job.Source.BaseSha, job.WT.Path
	var req RunFinalizeRequest
	finalizeWorktreeReport(&req, job.SessionID, job.WT, stCancelled)
	if !dropEmptyChatBranch(job) {
		t.Fatal("CONTROL: the empty chat kept its branch")
	}
	// main moves on meanwhile; the chat is still about the commit it was pinned to (SR29).
	commitFile(t, origin, "later.txt", "later\n", "main moved on")

	again := chatJob(clone, "sess-chat-back")
	again.Source.State, again.Source.BaseSha = sourceStatePinned, pin
	if execDir := setupWorktree(again, clone); execDir != path || again.SourceRefusal != nil {
		t.Fatalf("setupWorktree = %q (refusal %+v), want the checkout back at %q", execDir, again.SourceRefusal, path)
	}
	if got := mustGit(t, path, "rev-parse", "HEAD"); got != pin {
		t.Fatalf("the chat came back at %s, want its pin %s", got, pin)
	}
	if got := mustGit(t, path, "symbolic-ref", "--short", "HEAD"); got != again.Branch {
		t.Fatalf("the chat came back on %q, want %q", got, again.Branch)
	}
	if again.WT.BaseSha != pin {
		t.Fatalf("its diff base is %s, want the pin %s", again.WT.BaseSha, pin)
	}
}

func containsLine(text, line string) bool {
	for _, l := range splitLines(text) {
		if l == line {
			return true
		}
	}
	return false
}
