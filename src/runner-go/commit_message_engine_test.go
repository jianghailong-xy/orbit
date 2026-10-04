package main

import (
	"os"
	"path/filepath"
	"testing"
)

// noCommitMsgEngine is the commit-message engine the whole test binary names: a CLI no PATH
// carries, so generateCommitMessage takes its diffstat fallback at once, as on a machine without
// claude, rather than spending a paid call that can take a minute.
const noCommitMsgEngine = "orbit-test-binary-has-no-commit-message-engine"

func init() { commitMsgEngine = noCommitMsgEngine }

// No commit a test drives asks a real engine for its message. A permanent finalize and a commit each
// run generateCommitMessage's one-shot `claude -p`, and with the real CLI first on PATH every test
// that did either without a fake claude of its own made a paid call on this machine's login —
// seconds when the API answered at once, up to its minute when it did not. Those calls were part of
// what carried this package past go test's ten-minute default, failing whichever test happened to be
// running then (TestMergeToMainReplaysOnlySessionCommits, in a promotion's merge check). A fake
// claude per test covers only the tests that remember one.
//
// The control names the engine production names, resolved off the same PATH, and shows the fake is
// run and its message used — so the first half cannot pass for want of a way to notice the call.
func TestCommitsInTheTestBinaryRunNoCommitMessageEngine(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	bin := t.TempDir()
	ran := filepath.Join(t.TempDir(), "engine-ran")
	writeFakeBin(t, bin, "claude", "touch "+ran+"\necho 'feat: written by an engine'")
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	repo := initRepo(t)
	const id, branch = "sCommitMsg", "orbit/sCommitMsg"
	checkout := filepath.Join(worktreesDir(), id)
	mustGit(t, repo, "worktree", "add", "-b", branch, checkout)
	work := func(name string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(checkout, name), []byte(name+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	subject := func() string { t.Helper(); return mustGit(t, checkout, "log", "-1", "--format=%s") }
	engineRan := func() bool { _, err := os.Stat(ran); return err == nil }

	work("finalized.txt")
	base := mustGit(t, checkout, "rev-parse", "HEAD")
	wt := &Worktree{Path: checkout, Branch: branch, BaseSha: base, RepoDir: repo, Session: id}
	if _, _, err := finalizeWorktree(wt, false); err != nil {
		t.Fatalf("finalize: %v", err)
	}
	if got := subject(); got != "Update finalized.txt" {
		t.Errorf("finalize committed %q, want the diffstat fallback %q", got, "Update finalized.txt")
	}
	work("committed.txt")
	if res := commitWorktree(CommitCommand{SessionID: id, Branch: branch}); res.Status != "committed" {
		t.Fatalf("commit = %q (%s), want committed", res.Status, res.Message)
	}
	if got := subject(); got != "Update committed.txt" {
		t.Errorf("commit committed %q, want the diffstat fallback %q", got, "Update committed.txt")
	}
	if engineRan() {
		t.Fatal("a commit in the test binary ran the claude on PATH to write its message")
	}

	// Control: the engine production names, resolved off the same PATH.
	restore := commitMsgEngine
	commitMsgEngine = "claude"
	t.Cleanup(func() { commitMsgEngine = restore })
	work("summarized.txt")
	if res := commitWorktree(CommitCommand{SessionID: id, Branch: branch}); res.Status != "committed" {
		t.Fatalf("control commit = %q (%s), want committed", res.Status, res.Message)
	}
	if !engineRan() {
		t.Fatal("control: the engine production names was never run, so its absence above proves nothing")
	}
	if got := subject(); got != "feat: written by an engine" {
		t.Errorf("control commit = %q, want the engine's message", got)
	}
}
