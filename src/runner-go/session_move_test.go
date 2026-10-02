package main

// session-move/v1 (docs/session-folders-move-design.md §5.5): a session moved to another of this
// machine's workspaces takes its conversation along and leaves its code where it was. Two things on
// the runner make that true. The checkout at worktreesDir()/<sessionId> is re-attached only when it
// belongs to the repository the session now runs in, and a Claude conversation is copied over from
// the directory the session last ran in rather than rebuilt from the event log.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const sessionMoveID = "5e55c0de-0000-4000-8000-00000000a001"

// moveCheckout is a session's checkout as its old workspace leaves it: made by setupWorktree on
// branch in repo, holding one committed file of work.
func moveCheckout(t *testing.T, repo, branch string) string {
	t.Helper()
	job := &ClaimedSession{SessionID: sessionMoveID, Branch: branch}
	setupWorktree(job, repo)
	if job.WT == nil {
		t.Fatalf("fixture: no checkout in %s (isolation %q)", repo, job.IsolationStatus)
	}
	commitFile(t, job.WT.Path, "old-work.txt", "done in the old workspace\n", "old workspace work")
	return job.WT.Path
}

// retiredCheckouts lists the directories retireCheckout moved aside.
func retiredCheckouts(t *testing.T) []string {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(worktreesDir(), retiredCheckoutPrefix+"*"))
	if err != nil {
		t.Fatal(err)
	}
	return matches
}

// registeredWorktrees is every checkout repo still counts as one of its worktrees.
func registeredWorktrees(t *testing.T, repo string) []string {
	t.Helper()
	var paths []string
	for _, line := range strings.Split(mustGit(t, repo, "worktree", "list", "--porcelain"), "\n") {
		if p, ok := strings.CutPrefix(line, "worktree "); ok {
			paths = append(paths, p)
		}
	}
	return paths
}

func sameRepository(t *testing.T, dir, repo string) bool {
	t.Helper()
	have, want := gitCommonDir(dir), gitCommonDir(repo)
	return have != "" && have == want
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// The case the check exists for: the session moved to a workspace on another repository, and the
// checkout at its path is still the old repository's. It is unregistered there with its branch kept
// — the work stays on it, in the repository it was done in — and a fresh checkout of the new
// repository, on the same branch name, takes its place.
func TestSessionMoveRetiresACheckoutOfAnotherRepositoryAndKeepsItsBranch(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	oldRepo, newRepo := initRepo(t), initRepo(t)
	wtPath := moveCheckout(t, oldRepo, "orbit/moved")
	workTip := mustGit(t, oldRepo, "rev-parse", "refs/heads/orbit/moved")

	job := &ClaimedSession{SessionID: sessionMoveID, Branch: "orbit/moved"}
	execDir := setupWorktree(job, newRepo)

	if job.WT == nil || job.IsolationStatus != isoWorktree || execDir != wtPath {
		t.Fatalf("no checkout of the new repository at %s: execDir=%q isolation=%q", wtPath, execDir, job.IsolationStatus)
	}
	if !sameRepository(t, execDir, newRepo) {
		t.Fatalf("the checkout belongs to %s, want the new repository %s", gitCommonDir(execDir), gitCommonDir(newRepo))
	}
	if head := mustGit(t, execDir, "symbolic-ref", "--short", "HEAD"); head != "orbit/moved" {
		t.Errorf("the new checkout is on %q, want the session's branch orbit/moved", head)
	}
	if _, err := os.Stat(filepath.Join(execDir, "old-work.txt")); !os.IsNotExist(err) {
		t.Errorf("the old repository's work came along into the new checkout (stat err %v)", err)
	}
	if got := mustGit(t, oldRepo, "rev-parse", "refs/heads/orbit/moved"); got != workTip {
		t.Errorf("the old repository's branch moved: %s, want %s", got, workTip)
	}
	for _, p := range registeredWorktrees(t, oldRepo) {
		if p == wtPath {
			t.Errorf("the old repository still counts %s as its checkout", wtPath)
		}
	}
	if aside := retiredCheckouts(t); len(aside) != 0 {
		t.Errorf("a checkout with all of its work on its branch was moved aside instead of removed: %v", aside)
	}
}

// A retired checkout still holding work no branch has keeps it: the whole directory is moved aside,
// still a worktree of its repository, and the sweep — whose control plane calls every name that is
// not a session id removable — leaves it alone even once git can no longer find that repository.
func TestSessionMoveMovesADirtyCheckoutAsideWithItsWork(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	oldRepo, newRepo := initRepo(t), initRepo(t)
	wtPath := moveCheckout(t, oldRepo, "orbit/moved")
	workTip := mustGit(t, oldRepo, "rev-parse", "refs/heads/orbit/moved")
	if err := os.WriteFile(filepath.Join(wtPath, "base.txt"), []byte("an edit never committed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wtPath, "draft.txt"), []byte("a file never added\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	job := &ClaimedSession{SessionID: sessionMoveID, Branch: "orbit/moved"}
	execDir := setupWorktree(job, newRepo)

	if job.WT == nil || !sameRepository(t, execDir, newRepo) {
		t.Fatalf("no checkout of the new repository: isolation=%q", job.IsolationStatus)
	}
	if got := readFile(t, filepath.Join(execDir, "base.txt")); got != "base\n" {
		t.Errorf("the new checkout carries the old one's uncommitted edit: %q", got)
	}
	aside := retiredCheckouts(t)
	if len(aside) != 1 {
		t.Fatalf("want the dirty checkout moved aside once, found %v", aside)
	}
	for name, want := range map[string]string{
		"base.txt":     "an edit never committed\n",
		"draft.txt":    "a file never added\n",
		"old-work.txt": "done in the old workspace\n",
	} {
		if got := readFile(t, filepath.Join(aside[0], name)); got != want {
			t.Errorf("%s moved aside as %q, want %q", name, got, want)
		}
	}
	if !sameRepository(t, aside[0], oldRepo) {
		t.Errorf("the moved-aside checkout is no longer a worktree of %s", oldRepo)
	}
	if head := mustGit(t, aside[0], "rev-parse", "HEAD"); head != workTip {
		t.Errorf("the moved-aside checkout stands on %s, want its branch's tip %s", head, workTip)
	}
	if got := mustGit(t, oldRepo, "rev-parse", "refs/heads/orbit/moved"); got != workTip {
		t.Errorf("the old repository's branch moved: %s, want %s", got, workTip)
	}

	// The sweep, at its most aggressive: every name removable, the disk under its floor, and the
	// old repository gone, so git cannot say what the moved-aside directory is a checkout of.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			IDs []string `json:"ids"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(WorktreesRemovableResponse{Removable: req.IDs})
	}))
	t.Cleanup(server.Close)
	doneRepo := initRepo(t)
	done := filepath.Join(worktreesDir(), "5e55c0de-0000-4000-8000-00000000d0e5")
	mustGit(t, doneRepo, "worktree", "add", "-q", "-b", "orbit/done", done)
	if err := os.RemoveAll(oldRepo); err != nil {
		t.Fatal(err)
	}

	gcWorktrees(NewTransport(server.URL, "runner-token"), map[string]bool{sessionMoveID: true}, diskUnderTheFloor())

	requireCheckoutReclaimed(t, done, "a finished session's checkout still goes, so the sweep did run")
	if got := readFile(t, filepath.Join(aside[0], "draft.txt")); got != "a file never added\n" {
		t.Errorf("the sweep touched the moved-aside work: draft.txt = %q", got)
	}
}

// Commits only a detached HEAD reaches are work no branch has either: a `git worktree remove` would
// leave them to garbage collection, so the checkout is moved aside even with a clean status.
func TestSessionMoveMovesADetachedCheckoutAsideWithItsCommits(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	oldRepo, newRepo := initRepo(t), initRepo(t)
	wtPath := moveCheckout(t, oldRepo, "orbit/moved")
	mustGit(t, wtPath, "checkout", "-q", "--detach")
	commitFile(t, wtPath, "detached.txt", "on no branch\n", "work on a detached HEAD")
	detached := mustGit(t, wtPath, "rev-parse", "HEAD")

	job := &ClaimedSession{SessionID: sessionMoveID, Branch: "orbit/moved"}
	setupWorktree(job, newRepo)

	if job.WT == nil || !sameRepository(t, job.WT.Path, newRepo) {
		t.Fatalf("no checkout of the new repository: isolation=%q", job.IsolationStatus)
	}
	aside := retiredCheckouts(t)
	if len(aside) != 1 {
		t.Fatalf("want the detached checkout moved aside, found %v", aside)
	}
	if got := mustGit(t, aside[0], "rev-parse", "HEAD"); got != detached {
		t.Errorf("the moved-aside checkout's HEAD is %s, want the detached commit %s", got, detached)
	}
}

// Moved back to the repository whose checkout went aside, the session checks its branch out there
// again: the copy kept aside holds on to its work, not to the branch, so the session is isolated as
// before instead of falling back to running in the workspace's own directory.
func TestSessionMoveBackChecksTheBranchOutAgainBesideTheCheckoutMovedAside(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	oldRepo, newRepo := initRepo(t), initRepo(t)
	wtPath := moveCheckout(t, oldRepo, "orbit/moved")
	workTip := mustGit(t, oldRepo, "rev-parse", "refs/heads/orbit/moved")
	if err := os.WriteFile(filepath.Join(wtPath, "draft.txt"), []byte("a file never added\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	away := &ClaimedSession{SessionID: sessionMoveID, Branch: "orbit/moved"}
	if setupWorktree(away, newRepo); away.WT == nil {
		t.Fatalf("fixture: no checkout of the new repository (isolation %q)", away.IsolationStatus)
	}

	back := &ClaimedSession{SessionID: sessionMoveID, Branch: "orbit/moved"}
	execDir := setupWorktree(back, oldRepo)

	if back.WT == nil || back.IsolationStatus != isoWorktree || execDir != wtPath {
		t.Fatalf("moved back, the session is not isolated at %s: execDir=%q isolation=%q", wtPath, execDir, back.IsolationStatus)
	}
	if !sameRepository(t, execDir, oldRepo) {
		t.Fatalf("the checkout belongs to %s, want the old repository %s", gitCommonDir(execDir), gitCommonDir(oldRepo))
	}
	if head := mustGit(t, execDir, "symbolic-ref", "--short", "HEAD"); head != "orbit/moved" {
		t.Errorf("the checkout is on %q, want orbit/moved", head)
	}
	if got := mustGit(t, execDir, "rev-parse", "HEAD"); got != workTip {
		t.Errorf("the checkout stands on %s, want the branch's work %s", got, workTip)
	}
	aside := retiredCheckouts(t)
	if len(aside) != 1 {
		t.Fatalf("want the dirty checkout kept aside, found %v", aside)
	}
	if got := readFile(t, filepath.Join(aside[0], "draft.txt")); got != "a file never added\n" {
		t.Errorf("the work kept aside changed: draft.txt = %q", got)
	}
}

// The other half of "the checkout belongs to this job": the same repository and the same branch is
// re-attached as it always was — uncommitted work and all — including from another workspace on that
// repository, which lands in its own subdirectory of the same checkout. Code moves with the session
// exactly when both workspaces share the repository.
func TestSessionMoveReattachesTheSameRepositorysCheckoutOnItsBranch(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	if err := os.MkdirAll(filepath.Join(repo, "web"), 0o755); err != nil {
		t.Fatal(err)
	}
	commitFile(t, repo, filepath.Join("web", "index.html"), "<p>hi</p>\n", "a second workspace's directory")
	first := &ClaimedSession{SessionID: sessionMoveID, Branch: "orbit/moved"}
	setupWorktree(first, repo)
	if first.WT == nil {
		t.Fatalf("fixture: no checkout (isolation %q)", first.IsolationStatus)
	}
	wtPath := first.WT.Path
	if err := os.WriteFile(filepath.Join(wtPath, "wip.txt"), []byte("in flight\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	for _, workDir := range []string{repo, filepath.Join(repo, "web")} {
		job := &ClaimedSession{SessionID: sessionMoveID, Branch: "orbit/moved"}
		execDir := setupWorktree(job, workDir)
		rel, _ := filepath.Rel(repo, workDir)
		if want := filepath.Join(wtPath, rel); execDir != want || job.WT == nil || job.WT.Path != wtPath {
			t.Fatalf("workDir %s: execDir=%q (want %q), isolation=%q", workDir, execDir, want, job.IsolationStatus)
		}
		if got := readFile(t, filepath.Join(wtPath, "wip.txt")); got != "in flight\n" {
			t.Errorf("workDir %s: the re-attached checkout lost its uncommitted work: %q", workDir, got)
		}
	}
	if aside := retiredCheckouts(t); len(aside) != 0 {
		t.Errorf("the session's own checkout was retired: %v", aside)
	}
}

// A checkout the agent moved to a branch of its own (`git checkout -b`) is still this session's while
// the session's branch exists in that repository: the heartbeat reports the divergence and Adopt
// settles it, which retiring the checkout would silently take away.
func TestSessionMoveKeepsACheckoutTheAgentMovedToAnotherBranch(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	wtPath := moveCheckout(t, repo, "orbit/moved")
	mustGit(t, wtPath, "checkout", "-q", "-b", "agent/feature")
	commitFile(t, wtPath, "feature.txt", "the agent's own branch\n", "work on the agent's branch")

	job := &ClaimedSession{SessionID: sessionMoveID, Branch: "orbit/moved"}
	setupWorktree(job, repo)

	if job.WT == nil || job.WT.Path != wtPath {
		t.Fatalf("the checkout was not re-attached: isolation=%q", job.IsolationStatus)
	}
	if head := mustGit(t, wtPath, "symbolic-ref", "--short", "HEAD"); head != "agent/feature" {
		t.Errorf("the checkout was switched off the agent's branch to %q", head)
	}
	if aside := retiredCheckouts(t); len(aside) != 0 {
		t.Errorf("the session's own checkout was retired: %v", aside)
	}
}

// The same repository with a branch it has never had — the control plane named a new one — is
// another line of work: the old checkout is retired with its branch kept, and the new branch gets a
// fresh checkout.
func TestSessionMoveRetiresTheSameRepositorysCheckoutForANewBranch(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	wtPath := moveCheckout(t, repo, "orbit/before")
	workTip := mustGit(t, repo, "rev-parse", "refs/heads/orbit/before")

	job := &ClaimedSession{SessionID: sessionMoveID, Branch: "orbit/after"}
	execDir := setupWorktree(job, repo)

	if job.WT == nil || execDir != wtPath {
		t.Fatalf("no new checkout at %s: execDir=%q isolation=%q", wtPath, execDir, job.IsolationStatus)
	}
	if head := mustGit(t, execDir, "symbolic-ref", "--short", "HEAD"); head != "orbit/after" {
		t.Errorf("the checkout is on %q, want the new branch orbit/after", head)
	}
	if got := mustGit(t, repo, "rev-parse", "refs/heads/orbit/before"); got != workTip {
		t.Errorf("the old branch moved: %s, want %s", got, workTip)
	}
}

// setupSourceWorktree, the pinned run's checkout, makes the same check before it re-attaches.
func TestSessionMoveRetiresAPinnedRunsCheckoutOfAnotherRepository(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	oldRepo, newRepo := initRepo(t), initRepo(t)
	pin := mustGit(t, newRepo, "rev-parse", "HEAD")
	job := pinnedJob(newRepo, sessionMoveID, pin)
	moveCheckout(t, oldRepo, job.Branch)
	workTip := mustGit(t, oldRepo, "rev-parse", "refs/heads/"+job.Branch)

	execDir := setupWorktree(job, newRepo)

	if job.SourceRefusal != nil || job.WT == nil {
		t.Fatalf("the pinned run was refused: %+v", job.SourceRefusal)
	}
	if !sameRepository(t, execDir, newRepo) {
		t.Fatalf("the pinned checkout belongs to %s, want %s", gitCommonDir(execDir), gitCommonDir(newRepo))
	}
	if got := mustGit(t, execDir, "rev-parse", "HEAD"); got != pin {
		t.Errorf("the pinned checkout is at %s, want the pin %s", got, pin)
	}
	if got := mustGit(t, oldRepo, "rev-parse", "refs/heads/"+job.Branch); got != workTip {
		t.Errorf("the old repository's branch moved: %s, want %s", got, workTip)
	}
}

// moveTranscript is a conversation as Claude Code files one for a session running in cwd: one record
// per turn, each carrying that cwd, and a bookkeeping record that carries none.
func moveTranscript(t *testing.T, sessionUUID, cwd string, turns ...string) []byte {
	t.Helper()
	var b strings.Builder
	var parent interface{}
	for i, text := range turns {
		role := "user"
		if i%2 == 1 {
			role = "assistant"
		}
		id := "rec-" + string(rune('a'+i))
		line, err := json.Marshal(map[string]interface{}{
			"parentUuid": parent, "uuid": id, "type": role, "cwd": cwd, "sessionId": sessionUUID,
			"gitBranch": "orbit/moved", "message": map[string]interface{}{"role": role, "content": text},
		})
		if err != nil {
			t.Fatal(err)
		}
		b.Write(line)
		b.WriteByte('\n')
		parent = id
	}
	b.WriteString(`{"type":"last-prompt","lastPrompt":"` + turns[0] + `","sessionId":"` + sessionUUID + `"}` + "\n")
	return []byte(b.String())
}

func putFile(t *testing.T, path string, data []byte, at time.Time) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, at, at); err != nil {
		t.Fatal(err)
	}
}

func readJSONL(t *testing.T, path string) []map[string]interface{} {
	t.Helper()
	var records []map[string]interface{}
	for _, line := range strings.Split(strings.TrimSpace(readFile(t, path)), "\n") {
		var rec map[string]interface{}
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatalf("%s: unreadable record %q: %v", path, line, err)
		}
		records = append(records, rec)
	}
	return records
}

// requireCarried checks that dst holds src's records one for one, each that carries a cwd now
// carrying cwd, and nothing else about any of them changed.
func requireCarried(t *testing.T, src, dst, cwd string) {
	t.Helper()
	from, to := readJSONL(t, src), readJSONL(t, dst)
	if len(to) != len(from) {
		t.Fatalf("%d records carried, want %d", len(to), len(from))
	}
	for i := range from {
		want := from[i]
		if _, has := want["cwd"]; has {
			want["cwd"] = cwd
		}
		if !reflect.DeepEqual(to[i], want) {
			t.Errorf("record %d carried as %v, want %v", i, to[i], want)
		}
	}
}

func moveJob() *ClaimedSession {
	return &ClaimedSession{SessionID: sessionMoveID, SessionUUID: sessionMoveID, Provider: providerClaude,
		Branch: "orbit/moved", Agent: AgentExecConfig{Provider: providerClaude, Model: "claude-opus-5"}}
}

func noEmit(string, map[string]interface{}) {}

// eventLogNobodyReads is a control plane whose event log a carried conversation never needs: only a
// rebuild reads it, so any request fails the test.
func eventLogNobodyReads(t *testing.T) *Transport {
	t.Helper()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("the conversation was rebuilt instead of carried: %s %s", r.Method, r.URL.Path)
		http.Error(w, "unexpected", http.StatusInternalServerError)
	}))
	t.Cleanup(api.Close)
	return NewTransport(api.URL, "runner-token")
}

// Moved to another workspace on this machine, the session resumes the conversation it had, whole:
// its run before this one recorded the directory it ran in, and the transcript there is copied to
// where `--resume` reads it for the new directory — every record's cwd rewritten, the directory
// beside it copied too, and no event log consulted. A respawn afterwards keeps what it continued.
func TestSessionMoveCarriesTheClaudeConversationToTheNewDirectory(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	configDir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", configDir)
	oldDir, newDir := t.TempDir(), t.TempDir()
	job := moveJob()

	src, _ := claudeTranscriptPathIn(configDir, oldDir, job.SessionUUID)
	putFile(t, src, moveTranscript(t, job.SessionUUID, oldDir, "rename the widget", "renamed it", "now the gadget"),
		time.Now().Add(-time.Hour))
	side := strings.TrimSuffix(src, ".jsonl")
	putFile(t, filepath.Join(side, "subagents", "agent-1.jsonl"), []byte(`{"type":"user"}`+"\n"), time.Now())
	putFile(t, filepath.Join(side, "tool-results", "toolu_1.txt"), []byte("large output"), time.Now())
	before := readFile(t, src)

	// The order a real move runs in: the run in the old workspace recorded its directory, and this
	// run records its own before its engine starts.
	scratch := runDir(job.SessionID)
	if err := os.MkdirAll(scratch, 0o755); err != nil {
		t.Fatal(err)
	}
	writeSessionMeta(scratch, job, oldDir)
	writeSessionMeta(scratch, job, newDir)
	if meta := readSessionMeta(filepath.Join(scratch, "meta.json")); meta == nil || meta.WorkDir != newDir || meta.PreviousWorkDir != oldDir {
		t.Fatalf("meta.json does not record the move: %+v", meta)
	}

	api := eventLogNobodyReads(t)
	if !ensureClaudeTranscript(context.Background(), api, job, newDir, noEmit) {
		t.Fatal("the moved session was told there is nothing to resume")
	}
	dst, _ := claudeTranscriptPath(newDir, job.SessionUUID)
	requireCarried(t, src, dst, newDir)
	for _, rel := range []string{filepath.Join("subagents", "agent-1.jsonl"), filepath.Join("tool-results", "toolu_1.txt")} {
		if _, err := os.Stat(filepath.Join(strings.TrimSuffix(dst, ".jsonl"), rel)); err != nil {
			t.Errorf("%s did not come along: %v", rel, err)
		}
	}
	if got := readFile(t, src); got != before {
		t.Errorf("the conversation in the old directory changed:\n%s", got)
	}

	// The engine continues the conversation here; a respawn must not put the older copy back.
	continued := string(moveTranscript(t, job.SessionUUID, newDir, "rename the widget", "renamed it", "now the gadget", "gadget done"))
	putFile(t, dst, []byte(continued), time.Now())
	if !ensureClaudeTranscript(context.Background(), api, job, newDir, noEmit) {
		t.Fatal("the respawn was told there is nothing to resume")
	}
	if got := readFile(t, dst); got != continued {
		t.Errorf("a respawn overwrote the conversation continued since the move:\n%s", got)
	}
}

// Moved back, the session finds the copy it left behind in the directory it returns to. The newer
// conversation is the one it had in the directory it last ran in, and that is the one resumed.
func TestSessionMoveBackCarriesTheNewerConversationOverTheOneLeftBehind(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	configDir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", configDir)
	homeDir, awayDir := t.TempDir(), t.TempDir()
	job := moveJob()

	leftBehind, _ := claudeTranscriptPathIn(configDir, homeDir, job.SessionUUID)
	putFile(t, leftBehind, moveTranscript(t, job.SessionUUID, homeDir, "rename the widget", "renamed it"),
		time.Now().Add(-2*time.Hour))
	away, _ := claudeTranscriptPathIn(configDir, awayDir, job.SessionUUID)
	putFile(t, away, moveTranscript(t, job.SessionUUID, awayDir, "rename the widget", "renamed it", "and the gadget", "done too"),
		time.Now().Add(-time.Minute))
	scratch := runDir(job.SessionID)
	if err := os.MkdirAll(scratch, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{homeDir, awayDir, homeDir} {
		writeSessionMeta(scratch, job, dir)
	}

	if !ensureClaudeTranscript(context.Background(), eventLogNobodyReads(t), job, homeDir, noEmit) {
		t.Fatal("the session moved back was told there is nothing to resume")
	}
	requireCarried(t, away, leftBehind, homeDir)
}

// With no other directory on record — no meta.json at all, or one naming only this directory — the
// existing rebuild from Orbit's event log runs as before. A conversation filed under some other
// directory for the same id is not taken instead: only the recorded directory is ever read.
func TestSessionMoveFallsBackToTheRebuildWithoutARecordedDirectory(t *testing.T) {
	for _, tc := range []struct {
		name   string
		record bool
	}{
		{"no meta.json", false},
		{"meta.json names only this directory", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("ORBIT_HOME", t.TempDir())
			configDir := t.TempDir()
			t.Setenv("CLAUDE_CONFIG_DIR", configDir)
			// The rebuild stamps records with `claude --version`: answered here, not by this machine.
			bin := t.TempDir()
			if err := os.WriteFile(filepath.Join(bin, "claude"), []byte("#!/bin/sh\necho '2.1.0 (Claude Code)'\n"), 0o755); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
			execDir, elsewhere := t.TempDir(), t.TempDir()
			job := moveJob()

			stray, _ := claudeTranscriptPathIn(configDir, elsewhere, job.SessionUUID)
			putFile(t, stray, moveTranscript(t, job.SessionUUID, elsewhere, "a copy nobody recorded", "ignored"), time.Now())
			if tc.record {
				scratch := runDir(job.SessionID)
				if err := os.MkdirAll(scratch, 0o755); err != nil {
					t.Fatal(err)
				}
				writeSessionMeta(scratch, job, execDir)
			}
			var fetches atomic.Int64
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/events") {
					fetches.Add(1)
					_ = json.NewEncoder(w).Encode(StoredEventsResponse{Events: []StoredEvent{
						ev(1, evUser, map[string]interface{}{"text": "rename the widget"}),
						ev(2, evAssistant, map[string]interface{}{"text": "done"}),
					}})
					return
				}
				http.Error(w, "unexpected", http.StatusNotFound)
			}))
			t.Cleanup(api.Close)
			var emitted []map[string]interface{}
			emit := func(eventType string, payload map[string]interface{}) {
				emitted = append(emitted, map[string]interface{}{"type": eventType, "payload": payload})
			}

			if !ensureClaudeTranscript(context.Background(), NewTransport(api.URL, "runner-token"), job, execDir, emit) {
				t.Fatal("a session with replayable history was told there is nothing to resume")
			}
			if fetches.Load() == 0 || !transcriptWasRebuilt(emitted) {
				t.Fatalf("the transcript was not rebuilt from the event log (fetches=%d, emitted=%v)", fetches.Load(), emitted)
			}
			dst, _ := claudeTranscriptPath(execDir, job.SessionUUID)
			got := readFile(t, dst)
			if !strings.Contains(got, "rename the widget") || strings.Contains(got, "a copy nobody recorded") {
				t.Errorf("the transcript at %s is not the rebuilt one:\n%s", dst, got)
			}
		})
	}
}

// The control plane offers a workspace as a place to move a session to only on a runner that says it
// can take one: the token rides on every call the runner makes, the claim included.
func TestSessionMoveIsDeclaredInTheRunnerHandshake(t *testing.T) {
	header := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case header <- r.Header.Get(runnerCapabilitiesHeader):
		default:
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`null`))
	}))
	defer server.Close()

	if _, err := NewTransport(server.URL, "runner-token").claimSession(context.Background()); err != nil {
		t.Fatal(err)
	}
	declared := <-header
	for _, token := range strings.Split(declared, ",") {
		if token == "session-move/v1" {
			return
		}
	}
	t.Errorf("runner capabilities %q do not declare session-move/v1", declared)
}
