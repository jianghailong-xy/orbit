package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Real-Git tests for Move, Save & clean, the per-checkout lock and the relay's runner half
// (docs/main-checkout-git-contract.md §5, §6, §10). Each Move scenario asserts all three places a
// file can be: the main checkout (source), the target session's worktree, and the rescue ref.
// None of these run in parallel: mainCheckoutStep is package state.

const moveTargetBranch = "orbit/target"

type moveFixture struct {
	repo, target string
	busy         bool
}

// newMoveFixture: a main checkout on main with a few committed files, and a session worktree on
// orbit/target forked from it.
func newMoveFixture(t *testing.T) *moveFixture {
	t.Helper()
	repo := realRepo(t)
	commitFiles(t, repo, "fixture", map[string]string{
		"a.txt":      "one\ntwo\nthree\n",
		"staged.txt": "staged v1\n",
		"old.txt":    "to be renamed\n",
		"gone.txt":   "to be deleted\n",
		"other.txt":  "not chosen\n",
	})
	writeBytes(t, filepath.Join(repo, "bin.dat"), []byte{0, 1, 2, 3, 0, 'x'})
	mcWrite(t, repo, ".gitignore", "*.log\n")
	mustGit(t, repo, "add", "-A")
	mustGit(t, repo, "commit", "-q", "-m", "binary and ignore")
	wt := filepath.Join(t.TempDir(), "wt")
	mustGit(t, repo, "worktree", "add", "-q", "-b", moveTargetBranch, wt)
	real, err := filepath.EvalSymlinks(wt)
	if err != nil {
		t.Fatal(err)
	}
	return &moveFixture{repo: repo, target: real}
}

func (f *moveFixture) deps() mainCheckoutDeps {
	return mainCheckoutDeps{turnRunning: func(id string) bool { return f.busy && id == "sess-target" }}
}

// cmd is a Move of files with the fingerprint the checkout has right now (what the person reviewed).
func (f *moveFixture) cmd(t *testing.T, files ...string) MainCheckoutActionCommand {
	t.Helper()
	return MainCheckoutActionCommand{
		MainCheckoutActionRequest: MainCheckoutActionRequest{
			Kind: mainCheckoutMove, Root: f.repo, Fingerprint: mustScan(t, f.repo).Snapshot.Fingerprint,
			Files: files, TargetSessionID: "sess-target", RequestID: "req-" + strings.Join(files, "+"),
		},
		TargetBranch: moveTargetBranch,
	}
}

func (f *moveFixture) move(t *testing.T, cmd MainCheckoutActionCommand) MainCheckoutActionResult {
	t.Helper()
	res, err := runMainCheckoutAction(cmd, f.deps())
	if err != nil {
		t.Fatalf("move: %v", err)
	}
	if res.RequestID != cmd.RequestID || res.Kind != mainCheckoutMove || res.FinishedAt == "" {
		t.Fatalf("result does not answer the request: %+v", res)
	}
	return res
}

func writeBytes(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// fileState is a path's content, or "<absent>".
func fileState(t *testing.T, dir, p string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(p)))
	if os.IsNotExist(err) {
		return "<absent>"
	}
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func requireFiles(t *testing.T, where, dir string, want map[string]string) {
	t.Helper()
	for p, w := range want {
		if got := fileState(t, dir, p); got != w {
			t.Errorf("%s %s = %q, want %q", where, p, got, w)
		}
	}
}

// refState is a path's content in a ref, or "<absent>".
func refState(t *testing.T, repo, ref, p string) string {
	t.Helper()
	out, err := mcGit(context.Background(), repo, nil, "cat-file", "-p", ref+":"+p)
	if err != nil {
		return "<absent>"
	}
	return string(out)
}

func requireRef(t *testing.T, repo, ref string, want map[string]string) {
	t.Helper()
	for p, w := range want {
		if got := refState(t, repo, ref, p); got != w {
			t.Errorf("%s:%s = %q, want %q", ref, p, got, w)
		}
	}
}

func rescueBranches(t *testing.T, repo string) []string {
	t.Helper()
	out := mustGit(t, repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/orbit/rescue-*")
	if out == "" {
		return nil
	}
	return strings.Split(out, "\n")
}

func porcelain(t *testing.T, dir string) string {
	t.Helper()
	return mustGit(t, dir, "status", "--porcelain", "--untracked-files=all")
}

func stopAt(t *testing.T, step string, also func()) {
	t.Helper()
	prev := mainCheckoutStep
	t.Cleanup(func() { mainCheckoutStep = prev })
	mainCheckoutStep = func(s string) bool {
		if s != step {
			return false
		}
		if also != nil {
			also()
			return false
		}
		return true
	}
}

// Staged, unstaged and untracked files move; an unchosen file stays exactly as it was; the moved
// paths are back at HEAD in the checkout, index included.
func TestMoveStagedUnstagedAndUntracked(t *testing.T) {
	f := newMoveFixture(t)
	mcWrite(t, f.repo, "a.txt", "one\nTWO\nthree\n")
	mcWrite(t, f.repo, "staged.txt", "staged v2\n")
	mustGit(t, f.repo, "add", "staged.txt")
	mcWrite(t, f.repo, "dir/new.txt", "brand new\n")
	mcWrite(t, f.repo, "other.txt", "changed, not chosen\n")
	mcWrite(t, f.repo, "debug.log", "ignored\n")

	res := f.move(t, f.cmd(t, "a.txt", "staged.txt", "dir/new.txt"))
	if res.Status != mainCheckoutDone || res.Code != "" || *res.FileCount != 3 || res.Remaining == nil || *res.Remaining != 1 ||
		res.Branch != "main" || res.TargetBranch != moveTargetBranch || res.TargetSessionID != "sess-target" {
		t.Fatalf("result %+v", res)
	}
	requireFiles(t, "target", f.target, map[string]string{
		"a.txt": "one\nTWO\nthree\n", "staged.txt": "staged v2\n", "dir/new.txt": "brand new\n", "other.txt": "not chosen\n",
	})
	requireFiles(t, "source", f.repo, map[string]string{
		"a.txt": "one\ntwo\nthree\n", "staged.txt": "staged v1\n", "dir/new.txt": "<absent>",
		"other.txt": "changed, not chosen\n", "debug.log": "ignored\n",
	})
	if got := porcelain(t, f.repo); got != "M other.txt" {
		t.Fatalf("source status %q, want only other.txt modified", got)
	}
	if _, err := os.Stat(filepath.Join(f.repo, "dir")); !os.IsNotExist(err) {
		t.Fatalf("the moved file's empty directory is left behind: %v", err)
	}
	if b := rescueBranches(t, f.repo); len(b) != 1 || b[0] != res.RescueBranch {
		t.Fatalf("rescue branches %v, result names %q", b, res.RescueBranch)
	}
	requireRef(t, f.repo, res.RescueBranch, map[string]string{
		"a.txt": "one\nTWO\nthree\n", "staged.txt": "staged v2\n", "dir/new.txt": "brand new\n",
		"other.txt": "changed, not chosen\n", "debug.log": "<absent>",
	})
	if parent := mustGit(t, f.repo, "rev-parse", res.RescueBranch+"^"); parent != mustGit(t, f.repo, "rev-parse", "HEAD") {
		t.Fatalf("rescue commit's parent %s is not HEAD", parent)
	}
}

// A rename (D + A), a deletion and a binary change move as they are.
func TestMoveRenameDeleteAndBinary(t *testing.T) {
	f := newMoveFixture(t)
	mustGit(t, f.repo, "mv", "old.txt", "renamed.txt")
	mustGit(t, f.repo, "rm", "-q", "gone.txt")
	bin := []byte{0, 9, 8, 7, 0, 'y', 0xff}
	writeBytes(t, filepath.Join(f.repo, "bin.dat"), bin)

	res := f.move(t, f.cmd(t, "old.txt", "renamed.txt", "gone.txt", "bin.dat"))
	if res.Status != mainCheckoutDone || *res.Remaining != 0 {
		t.Fatalf("result %+v", res)
	}
	requireFiles(t, "target", f.target, map[string]string{
		"old.txt": "<absent>", "renamed.txt": "to be renamed\n", "gone.txt": "<absent>", "bin.dat": string(bin),
	})
	requireFiles(t, "source", f.repo, map[string]string{
		"old.txt": "to be renamed\n", "renamed.txt": "<absent>", "gone.txt": "to be deleted\n", "bin.dat": "\x00\x01\x02\x03\x00x",
	})
	if got := porcelain(t, f.repo); got != "" {
		t.Fatalf("source status %q, want clean", got)
	}
	requireRef(t, f.repo, res.RescueBranch, map[string]string{
		"old.txt": "<absent>", "renamed.txt": "to be renamed\n", "gone.txt": "<absent>", "bin.dat": string(bin),
	})
}

// Content the target already holds is not written again, and does not conflict; the target's own
// uncommitted work elsewhere is untouched, and a change on other lines merges.
func TestMoveContentAlreadyInTheTarget(t *testing.T) {
	f := newMoveFixture(t)
	mcWrite(t, f.repo, "a.txt", "one\nTWO\nthree\n")
	mcWrite(t, f.repo, "staged.txt", "staged v1\nmore\n")
	mcWrite(t, f.target, "a.txt", "one\nTWO\nthree\n")         // already there, uncommitted
	mcWrite(t, f.target, "staged.txt", "top\nstaged v1\n")     // other lines changed in the target
	mcWrite(t, f.target, "agent-wip.txt", "the agent's own\n") // unrelated
	before, _ := os.Stat(filepath.Join(f.target, "a.txt"))

	res := f.move(t, f.cmd(t, "a.txt", "staged.txt"))
	if res.Status != mainCheckoutDone {
		t.Fatalf("result %+v", res)
	}
	requireFiles(t, "target", f.target, map[string]string{
		"a.txt": "one\nTWO\nthree\n", "staged.txt": "top\nstaged v1\nmore\n", "agent-wip.txt": "the agent's own\n",
	})
	if after, _ := os.Stat(filepath.Join(f.target, "a.txt")); !after.ModTime().Equal(before.ModTime()) {
		t.Fatalf("a file already holding the content was rewritten")
	}
	requireFiles(t, "source", f.repo, map[string]string{"a.txt": "one\ntwo\nthree\n", "staged.txt": "staged v1\n"})
	requireRef(t, f.repo, res.RescueBranch, map[string]string{"a.txt": "one\nTWO\nthree\n", "staged.txt": "staged v1\nmore\n"})
}

// The same line changed in the target: MOVE_CONFLICT, and neither side is changed — not even the
// file that would have moved cleanly. The rescue ref holds the source as it was.
func TestMoveSameLineConflictTouchesNeitherSide(t *testing.T) {
	f := newMoveFixture(t)
	mcWrite(t, f.target, "a.txt", "one\nTARGET\nthree\n")
	mustGit(t, f.target, "commit", "-q", "-am", "the session's own change")
	mcWrite(t, f.repo, "a.txt", "one\nSOURCE\nthree\n")
	mcWrite(t, f.repo, "clean.txt", "would move cleanly\n")
	sourceBefore, targetBefore := porcelain(t, f.repo), porcelain(t, f.target)

	res := f.move(t, f.cmd(t, "a.txt", "clean.txt"))
	if res.Status != mainCheckoutRefused || res.Code != mainCheckoutMoveConflict || strings.Join(res.Paths, ",") != "a.txt" || res.Branch != "main" {
		t.Fatalf("result %+v", res)
	}
	requireFiles(t, "source", f.repo, map[string]string{"a.txt": "one\nSOURCE\nthree\n", "clean.txt": "would move cleanly\n"})
	requireFiles(t, "target", f.target, map[string]string{"a.txt": "one\nTARGET\nthree\n", "clean.txt": "<absent>"})
	if porcelain(t, f.repo) != sourceBefore || porcelain(t, f.target) != targetBefore {
		t.Fatalf("status changed: source %q target %q", porcelain(t, f.repo), porcelain(t, f.target))
	}
	requireRef(t, f.repo, res.RescueBranch, map[string]string{"a.txt": "one\nSOURCE\nthree\n", "clean.txt": "would move cleanly\n"})
	// The same conflict as uncommitted work in the target: refused the same way.
	g := newMoveFixture(t)
	mcWrite(t, g.target, "a.txt", "one\nTARGET\nthree\n")
	mcWrite(t, g.repo, "a.txt", "one\nSOURCE\nthree\n")
	if res := g.move(t, g.cmd(t, "a.txt")); res.Code != mainCheckoutMoveConflict {
		t.Fatalf("uncommitted conflict: %+v", res)
	}
	requireFiles(t, "target", g.target, map[string]string{"a.txt": "one\nTARGET\nthree\n"})
	requireFiles(t, "source", g.repo, map[string]string{"a.txt": "one\nSOURCE\nthree\n"})
}

// A file written in the checkout while the Move copies: the copy stands, the source is kept for
// every moved path, and the result is the partial MOVE_SOURCE_CHANGED.
func TestMoveSourceDriftKeepsTheSource(t *testing.T) {
	f := newMoveFixture(t)
	mcWrite(t, f.repo, "a.txt", "one\nTWO\nthree\n")
	mcWrite(t, f.repo, "new.txt", "new\n")
	stopAt(t, "copied", func() { mcWrite(t, f.repo, "a.txt", "somebody else's newer write\n") })

	res := f.move(t, f.cmd(t, "a.txt", "new.txt"))
	if res.Status != mainCheckoutPartial || res.Code != mainCheckoutMoveSourceChanged || strings.Join(res.Paths, ",") != "a.txt" ||
		res.RescueBranch == "" || *res.FileCount != 2 {
		t.Fatalf("result %+v", res)
	}
	requireFiles(t, "target", f.target, map[string]string{"a.txt": "one\nTWO\nthree\n", "new.txt": "new\n"})
	requireFiles(t, "source", f.repo, map[string]string{"a.txt": "somebody else's newer write\n", "new.txt": "new\n"})
	requireRef(t, f.repo, res.RescueBranch, map[string]string{"a.txt": "one\nTWO\nthree\n", "new.txt": "new\n"})
}

// A checkout that changed since the review, or whose HEAD moved, is refused before anything is
// written: no rescue branch, both sides as they were.
func TestMoveStaleFingerprintChangesNothing(t *testing.T) {
	f := newMoveFixture(t)
	mcWrite(t, f.repo, "a.txt", "one\nTWO\nthree\n")
	cmd := f.cmd(t, "a.txt")
	mcWrite(t, f.repo, "a.txt", "written after the review\n")
	res := f.move(t, cmd)
	if res.Status != mainCheckoutRefused || res.Code != mainCheckoutFingerprintStale {
		t.Fatalf("result %+v", res)
	}
	requireFiles(t, "source", f.repo, map[string]string{"a.txt": "written after the review\n"})
	requireFiles(t, "target", f.target, map[string]string{"a.txt": "one\ntwo\nthree\n"})
	if b := rescueBranches(t, f.repo); len(b) != 0 {
		t.Fatalf("rescue branches %v after a refusal", b)
	}

	cmd = f.cmd(t, "a.txt")
	commitFile(t, f.repo, "unrelated.txt", "x\n", "HEAD moves")
	res = f.move(t, cmd)
	if res.Code != mainCheckoutHeadMoved || res.Head != mustGit(t, f.repo, "rev-parse", "HEAD") {
		t.Fatalf("result %+v", res)
	}
	requireFiles(t, "source", f.repo, map[string]string{"a.txt": "written after the review\n"})
	requireFiles(t, "target", f.target, map[string]string{"a.txt": "one\ntwo\nthree\n"})
	if b := rescueBranches(t, f.repo); len(b) != 0 {
		t.Fatalf("rescue branches %v after a refusal", b)
	}
}

// A target session running a turn is refused before anything is written.
func TestMoveTargetBusy(t *testing.T) {
	f := newMoveFixture(t)
	f.busy = true
	mcWrite(t, f.repo, "a.txt", "one\nTWO\nthree\n")
	res := f.move(t, f.cmd(t, "a.txt"))
	if res.Status != mainCheckoutRefused || res.Code != mainCheckoutTargetBusy {
		t.Fatalf("result %+v", res)
	}
	requireFiles(t, "source", f.repo, map[string]string{"a.txt": "one\nTWO\nthree\n"})
	requireFiles(t, "target", f.target, map[string]string{"a.txt": "one\ntwo\nthree\n"})
	if b := rescueBranches(t, f.repo); len(b) != 0 {
		t.Fatalf("rescue branches %v after a refusal", b)
	}
	// The pool's own answer: a session holding a permit is running a turn.
	pool := newSessionPool(2)
	pool.sessions["sess-live"] = &liveSession{id: "sess-live", active: true}
	pool.sessions["sess-idle"] = &liveSession{id: "sess-idle"}
	if !pool.turnRunning("sess-live") || pool.turnRunning("sess-idle") || pool.turnRunning("sess-none") {
		t.Fatal("turnRunning does not follow the pool's permits")
	}
}

// A Move stopped after any step and redone with the same request ends exactly as an uninterrupted
// one: one rescue branch, every file in the target, the checkout restored, nothing lost.
func TestMoveRedoAfterAStopAtEachStep(t *testing.T) {
	for _, step := range []string{"rescued", "journaled", "target-partial", "copied", "restored-tracked"} {
		t.Run(step, func(t *testing.T) {
			f := newMoveFixture(t)
			mcWrite(t, f.repo, "a.txt", "one\nTWO\nthree\n")
			mustGit(t, f.repo, "rm", "-q", "gone.txt")
			mcWrite(t, f.repo, "new.txt", "new\n")
			cmd := f.cmd(t, "a.txt", "gone.txt", "new.txt")

			stopAt(t, step, nil)
			if _, err := runMainCheckoutAction(cmd, f.deps()); err != errMainCheckoutStopped {
				t.Fatalf("stop at %s: %v", step, err)
			}
			// Nothing is lost while stopped: the rescue ref holds every moved file's content.
			if b := rescueBranches(t, f.repo); len(b) != 1 {
				t.Fatalf("after the stop: rescue branches %v", b)
			}
			requireRef(t, f.repo, rescueBranches(t, f.repo)[0], map[string]string{
				"a.txt": "one\nTWO\nthree\n", "gone.txt": "<absent>", "new.txt": "new\n",
			})
			mainCheckoutStep = func(string) bool { return false }

			res := f.move(t, cmd)
			if res.Status != mainCheckoutDone || *res.Remaining != 0 {
				t.Fatalf("redo: %+v", res)
			}
			if b := rescueBranches(t, f.repo); len(b) != 1 || b[0] != res.RescueBranch {
				t.Fatalf("redo: rescue branches %v, result %q", b, res.RescueBranch)
			}
			requireFiles(t, "target", f.target, map[string]string{"a.txt": "one\nTWO\nthree\n", "gone.txt": "<absent>", "new.txt": "new\n"})
			requireFiles(t, "source", f.repo, map[string]string{"a.txt": "one\ntwo\nthree\n", "gone.txt": "to be deleted\n", "new.txt": "<absent>"})
			if got := porcelain(t, f.repo); got != "" {
				t.Fatalf("source status %q", got)
			}
			requireRef(t, f.repo, res.RescueBranch, map[string]string{"a.txt": "one\nTWO\nthree\n", "gone.txt": "<absent>", "new.txt": "new\n"})
			if path, _ := moveJournalPath(f.repo, cmd.RequestID); readMoveJournal(path) != nil {
				t.Fatal("the journal outlived the Move")
			}
		})
	}
}

// Save & clean on a checkout that is only dirty (no operation in flight, untracked files too):
// everything is on the rescue branch, the checkout is back at HEAD, ignored files stay.
func TestSaveAndCleanPlainDirty(t *testing.T) {
	f := newMoveFixture(t)
	mcWrite(t, f.repo, "a.txt", "unstaged\n")
	mcWrite(t, f.repo, "staged.txt", "staged v2\n")
	mustGit(t, f.repo, "add", "staged.txt")
	mcWrite(t, f.repo, "untracked.txt", "untracked\n")
	mcWrite(t, f.repo, "build.log", "ignored\n")
	head := mustGit(t, f.repo, "rev-parse", "HEAD")
	fp := mustScan(t, f.repo).Snapshot.Fingerprint
	cmd := MainCheckoutActionCommand{MainCheckoutActionRequest: MainCheckoutActionRequest{
		Kind: mainCheckoutRescue, Root: f.repo, Fingerprint: fp, RequestID: "req-save"}}

	// A stale review first: nothing happens.
	mcWrite(t, f.repo, "untracked.txt", "untracked, edited after the review\n")
	res, err := runMainCheckoutAction(cmd, f.deps())
	if err != nil || res.Status != mainCheckoutRefused || res.Code != mainCheckoutFingerprintStale {
		t.Fatalf("stale: %+v %v", res, err)
	}
	if b := rescueBranches(t, f.repo); len(b) != 0 || porcelain(t, f.repo) == "" {
		t.Fatalf("a stale Save & clean changed something: branches %v", b)
	}

	cmd.Fingerprint = mustScan(t, f.repo).Snapshot.Fingerprint
	res, err = runMainCheckoutAction(cmd, f.deps())
	if err != nil || res.Status != mainCheckoutDone || res.Code != "" || res.Head != head || *res.FileCount != 3 || res.Branch != "main" {
		t.Fatalf("result %+v %v", res, err)
	}
	if got := porcelain(t, f.repo); got != "" {
		t.Fatalf("checkout status %q, want clean", got)
	}
	requireFiles(t, "checkout", f.repo, map[string]string{
		"a.txt": "one\ntwo\nthree\n", "staged.txt": "staged v1\n", "untracked.txt": "<absent>", "build.log": "ignored\n",
	})
	requireRef(t, f.repo, res.RescueBranch, map[string]string{
		"a.txt": "unstaged\n", "staged.txt": "staged v2\n", "untracked.txt": "untracked, edited after the review\n", "build.log": "<absent>",
	})
	if b := rescueBranches(t, f.repo); len(b) != 1 {
		t.Fatalf("rescue branches %v", b)
	}
}

// Two workspaces reaching one checkout by different paths (one through a symlink) share its lock:
// an action through one waits for an action, or a merge, through the other.
func TestMainCheckoutActionsSerializeOnTheRealPath(t *testing.T) {
	f := newMoveFixture(t)
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(f.repo, alias); err != nil {
		t.Fatal(err)
	}
	if mainCheckoutLockKey(alias) != mainCheckoutLockKey(filepath.Join(f.repo, "sub-does-not-matter", "..")) {
		t.Fatalf("lock keys differ: %q vs %q", mainCheckoutLockKey(alias), mainCheckoutLockKey(f.repo))
	}
	mcWrite(t, f.repo, "a.txt", "one\nTWO\nthree\n")
	moveCmd := f.cmd(t, "a.txt")
	saveCmd := MainCheckoutActionCommand{MainCheckoutActionRequest: MainCheckoutActionRequest{
		Kind: mainCheckoutRescue, Root: alias, Fingerprint: moveCmd.Fingerprint, RequestID: "req-save"}}

	entered, release := make(chan struct{}), make(chan struct{})
	prev := mainCheckoutStep
	t.Cleanup(func() { mainCheckoutStep = prev })
	mainCheckoutStep = func(s string) bool {
		if s == "rescued" {
			close(entered)
			<-release
		}
		return false
	}
	var moveRes, saveRes MainCheckoutActionResult
	var order []string
	var mu sync.Mutex
	note := func(s string) { mu.Lock(); order = append(order, s); mu.Unlock() }
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		moveRes, _ = runMainCheckoutAction(moveCmd, f.deps())
		note("move")
	}()
	<-entered
	saveDone := make(chan struct{})
	go func() {
		saveRes, _ = runMainCheckoutAction(saveCmd, f.deps()) // through the symlink
		note("save")
		close(saveDone)
	}()
	mergeDone := make(chan struct{})
	go func() {
		mergeToMain(MergeCommand{WorkDir: alias, Branch: "no-such-branch"}) // fails, but only once it has the lock
		note("merge")
		close(mergeDone)
	}()
	select {
	case <-saveDone:
		t.Fatal("Save & clean ran while a Move held the same checkout")
	case <-mergeDone:
		t.Fatal("a merge ran while a Move held the same checkout")
	case <-time.After(400 * time.Millisecond):
	}
	close(release)
	wg.Wait()
	<-saveDone
	<-mergeDone
	if order[0] != "move" {
		t.Fatalf("order %v", order)
	}
	if moveRes.Status != mainCheckoutDone {
		t.Fatalf("move %+v", moveRes)
	}
	// Save & clean ran after the Move and found the checkout it reviewed gone: refused, unchanged.
	if saveRes.Status != mainCheckoutRefused || saveRes.Code != mainCheckoutFingerprintStale {
		t.Fatalf("save %+v", saveRes)
	}
}

// An isolated session whose worktree cannot be made never runs in the shared checkout: it gets no
// directory, the refusal it fails with names why, and the run reports it as its error.
func TestWorktreeCreationFailureNeverFallsBackToShared(t *testing.T) {
	f := newResumableFixture(t)
	job := &ClaimedSession{SessionID: "sess-blocked", Branch: "orbit/sess-blocked"}
	writeUnder(t, filepath.Join(worktreesDir(), "sess-blocked"), "in/the/way.txt", "x\n")
	execDir := setupWorktree(job, f.repo)
	if execDir != "" || job.WT != nil || job.IsolationStatus == isoShared || job.IsolationStatus == isoSharedNoGit {
		t.Fatalf("execDir %q, WT %+v, isolation %q: it fell back to the shared checkout", execDir, job.WT, job.IsolationStatus)
	}
	if job.SourceRefusal == nil || job.SourceRefusal.Code != sourceRefusalWorktreeRequired ||
		!strings.Contains(job.SourceRefusal.Detail["reason"].(string), "git worktree add") {
		t.Fatalf("refusal %+v", job.SourceRefusal)
	}
	var events []map[string]interface{}
	emit := func(kind string, payload map[string]interface{}) { events = append(events, payload) }
	status, _, _ := runSessionProcess(context.Background(), context.Background(), nil, job, "", execDir, "", emit, nil, nil, false, nil, nil, nil, nil, nil)
	if status != stFailed || len(events) != 1 || !strings.HasPrefix(events[0]["message"].(string), sourceRefusalWorktreeRequired+": ") {
		t.Fatalf("status %q, events %+v", status, events)
	}
}

// The relay's runner half: a snapshot read and an action, each answered under its id; nothing
// started past its deadline.
func TestMainCheckoutRelayAnswers(t *testing.T) {
	f := newMoveFixture(t)
	mcWrite(t, f.repo, "a.txt", "one\nTWO\nthree\n")
	var mu sync.Mutex
	posted := map[string]json.RawMessage{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		posted[r.URL.Path] = body
		mu.Unlock()
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}))
	t.Cleanup(server.Close)
	tr := NewTransport(server.URL, "token")
	future := time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
	past := time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)

	handleMainCheckoutRequest(tr, MainCheckoutRunnerRequest{ID: "rd1", Op: "snapshot", Root: f.repo, DiffPaths: []string{"a.txt"}, ExpiresAt: future}, f.deps())
	cmd := f.cmd(t, "a.txt")
	cmd.ExpiresAt = past
	handleMainCheckoutRequest(tr, MainCheckoutRunnerRequest{ID: "late", Op: "action", Command: &cmd}, f.deps())
	cmd.ExpiresAt = future
	handleMainCheckoutRequest(tr, MainCheckoutRunnerRequest{ID: "act1", Op: "action", Command: &cmd}, f.deps())

	var snap MainCheckoutSnapshotAnswer
	if err := json.Unmarshal(findPosted(t, posted, "/main-checkout/rd1/snapshot"), &snap); err != nil || snap.Snapshot == nil ||
		snap.Snapshot.Fingerprint != cmd.Fingerprint || len(snap.Diffs) != 1 || !strings.Contains(snap.Diffs[0].Patch, "+TWO") {
		t.Fatalf("snapshot answer %+v (%v)", snap, err)
	}
	var res MainCheckoutActionResult
	if err := json.Unmarshal(findPosted(t, posted, "/main-checkout/act1/result"), &res); err != nil || res.Status != mainCheckoutDone || res.RequestID != cmd.RequestID {
		t.Fatalf("action result %+v (%v)", res, err)
	}
	for p := range posted {
		if strings.Contains(p, "/late/") {
			t.Fatalf("an action past its deadline was answered: %s", p)
		}
	}
	requireFiles(t, "target", f.target, map[string]string{"a.txt": "one\nTWO\nthree\n"})
}

func findPosted(t *testing.T, posted map[string]json.RawMessage, suffix string) json.RawMessage {
	t.Helper()
	for p, body := range posted {
		if strings.HasSuffix(p, suffix) {
			return body
		}
	}
	t.Fatalf("nothing posted to …%s (have %v)", suffix, posted)
	return nil
}
