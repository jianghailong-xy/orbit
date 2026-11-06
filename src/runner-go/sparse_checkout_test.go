package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// Repository-declared sparse session checkouts (docs/session-checkout-storage-design.md §6). What these hold the
// runner to:
//
//   - a session checkout of a repository that declares paths in .orbit/checkout-exclude leaves them out, read
//     from the commit the session forks from, and the workspace's own directory stays whole;
//   - without a declaration, or with a git older than 2.34, the checkout is full, and the log says why;
//   - what an agent writes under a left-out path reaches the session's branch through every staging the runner
//     does: the live diff, the finalize commit, the Commit button and Discard's record;
//   - every engine is told which paths are left out and how to bring one in.
//
// A reclaimed sparse checkout coming back sparse is in sparse_checkout_reclaim_linux_test.go, beside the sweep's
// own fixture.

// writeTree writes files (repository-relative path to content) under dir, making their directories.
func writeTree(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// commitTree writes files under repo and commits all of them, returning the commit.
func commitTree(t *testing.T, repo, msg string, files map[string]string) string {
	t.Helper()
	writeTree(t, repo, files)
	mustGit(t, repo, "add", "-A")
	mustGit(t, repo, "commit", "-q", "-m", msg)
	return mustGit(t, repo, "rev-parse", "HEAD")
}

// declaringTree is a repository's tree with a file under each of the two paths its declaration leaves out, beside
// paths it keeps. Without the declaration it is the same repository, declaring nothing.
func declaringTree(declare bool) map[string]string {
	files := map[string]string{
		"docs/mocks/board.png":        "a board\n",
		"docs/evidence/run-1/log.txt": "a log\n",
		"docs/guide.md":               "a guide\n",
		"src/app.go":                  "package app\n",
	}
	if declare {
		files[checkoutExcludeFile] = "# Session checkouts leave these out.\n\ndocs/mocks/\ndocs/evidence/\n"
	}
	return files
}

// sparseRepo is a repository whose main declares what its session checkouts leave out (declaringTree).
func sparseRepo(t *testing.T) string {
	t.Helper()
	repo := initRepo(t)
	commitTree(t, repo, "declare what session checkouts leave out", declaringTree(true))
	return repo
}

// requireSparseCheckout fails unless the checkout at path leaves out what declaringTree declares, and nothing else.
func requireSparseCheckout(t *testing.T, path, why string) {
	t.Helper()
	for _, gone := range []string{"docs/mocks", "docs/evidence"} {
		if !checkoutAbsent(filepath.Join(path, gone)) {
			t.Errorf("%s: %s should be left out of the checkout", why, gone)
		}
	}
	for _, kept := range []string{"base.txt", "docs/guide.md", "src/app.go", checkoutExcludeFile} {
		if _, err := os.Stat(filepath.Join(path, kept)); err != nil {
			t.Errorf("%s: %s should be in the checkout: %v", why, kept, err)
		}
	}
	if got, _ := git(path, "config", "--bool", "core.sparseCheckout"); got != "true" {
		t.Errorf("%s: core.sparseCheckout = %q in the checkout, want true", why, got)
	}
	// Out of the disk, not out of git: the index holds them, marked skip-worktree.
	if got := mustGit(t, path, "ls-files", "-t", "--", "docs/mocks/board.png", "docs/evidence/run-1/log.txt"); got != "S docs/evidence/run-1/log.txt\nS docs/mocks/board.png" {
		t.Errorf("%s: the left-out paths should be in the index, marked skip-worktree, got %q", why, got)
	}
	if status := mustGit(t, path, "status", "--porcelain"); status != "" {
		t.Errorf("%s: the checkout should read as clean, got %q", why, status)
	}
}

// requireFullCheckout fails unless the checkout at path holds every path of declaringTree.
func requireFullCheckout(t *testing.T, path, why string) {
	t.Helper()
	for _, kept := range []string{"base.txt", "docs/guide.md", "src/app.go", "docs/mocks/board.png", "docs/evidence/run-1/log.txt"} {
		if _, err := os.Stat(filepath.Join(path, kept)); err != nil {
			t.Errorf("%s: %s should be in the checkout: %v", why, kept, err)
		}
	}
	if got, _ := git(path, "config", "--bool", "core.sparseCheckout"); got == "true" {
		t.Errorf("%s: the checkout should not be sparse", why)
	}
	if status := mustGit(t, path, "status", "--porcelain"); status != "" {
		t.Errorf("%s: the checkout should read as clean, got %q", why, status)
	}
}

// asAnOlderGit has gitTooOldForSparse read version for the rest of the test.
func asAnOlderGit(t *testing.T, version string) {
	t.Helper()
	previous := gitVersion
	gitVersion = func() (string, error) { return version, nil }
	t.Cleanup(func() { gitVersion = previous })
}

func TestASessionCheckoutLeavesOutWhatTheRepositoryDeclares(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := sparseRepo(t)
	head := mustGit(t, repo, "rev-parse", "HEAD")

	job := &ClaimedSession{SessionID: "s-sparse", Branch: "orbit/s-sparse"}
	var execDir string
	logs := captureLogs(t, func() { execDir = setupWorktree(job, repo) })

	if job.IsolationStatus != isoWorktree || job.WT == nil || execDir != job.WT.Path || job.WT.BaseSha != head {
		t.Fatalf("setupWorktree = %q, isolation %q, wt %+v", execDir, job.IsolationStatus, job.WT)
	}
	requireSparseCheckout(t, execDir, "a new session's checkout")
	if got := mustGit(t, execDir, "symbolic-ref", "--short", "HEAD"); got != "orbit/s-sparse" {
		t.Errorf("the checkout should stand on the session's branch, got %q", got)
	}
	if want := "session s-sparse — sparse checkout: .orbit/checkout-exclude at " + shortSha(head) + " leaves out docs/mocks/, docs/evidence/"; !strings.Contains(logs, want) {
		t.Errorf("the log should say what the checkout leaves out (%q), got:\n%s", want, logs)
	}
	// The workspace's own directory is never made sparse: it is where merges and the repository's tests run.
	requireFullCheckout(t, repo, "the workspace's own directory")
}

// The declaration is read from the commit the session forks from, not from wherever the workspace stands now: a
// run pinned to a commit that declares paths is sparse though the workspace's HEAD no longer declares them, and a
// new session forked from that HEAD is full.
func TestTheDeclarationIsReadFromTheSessionsForkPoint(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := sparseRepo(t)
	pin := mustGit(t, repo, "rev-parse", "HEAD")
	mustGit(t, repo, "rm", "-q", checkoutExcludeFile)
	mustGit(t, repo, "commit", "-q", "-m", "declare nothing")

	pinned := pinnedJob(repo, "s-pinned", pin)
	execDir := setupWorktree(pinned, repo)
	if pinned.SourceRefusal != nil || pinned.WT == nil || pinned.WT.BaseSha != pin {
		t.Fatalf("pinned run: execDir %q, refusal %+v, wt %+v", execDir, pinned.SourceRefusal, pinned.WT)
	}
	requireSparseCheckout(t, execDir, "a run pinned to a commit that declares paths")

	fresh := &ClaimedSession{SessionID: "s-fresh", Branch: "orbit/s-fresh"}
	requireFullCheckout(t, setupWorktree(fresh, repo), "a session forked from a HEAD that declares nothing")
}

func TestACheckoutIsFullWithoutADeclaration(t *testing.T) {
	for name, declaration := range map[string]string{
		"no declaration":                 "",
		"a declaration of comments only": "# Nothing is left out yet.\n\n   \n",
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("ORBIT_HOME", t.TempDir())
			repo := initRepo(t)
			files := declaringTree(false)
			if declaration != "" {
				files[checkoutExcludeFile] = declaration
			}
			head := commitTree(t, repo, "a repository with nothing to leave out", files)

			job := &ClaimedSession{SessionID: "s-full", Branch: "orbit/s-full"}
			var execDir string
			logs := captureLogs(t, func() { execDir = setupWorktree(job, repo) })

			if job.IsolationStatus != isoWorktree || job.WT == nil {
				t.Fatalf("setupWorktree = %q, isolation %q", execDir, job.IsolationStatus)
			}
			requireFullCheckout(t, execDir, name)
			if want := "session s-full — full checkout: no paths to leave out in .orbit/checkout-exclude at " + shortSha(head); !strings.Contains(logs, want) {
				t.Errorf("the log should say why the checkout is full (%q), got:\n%s", want, logs)
			}
			// Nothing about the repository changed: only a sparse checkout turns on per-checkout configuration.
			if out, err := git(repo, "config", "--get", "extensions.worktreeConfig"); err == nil {
				t.Errorf("a full checkout changed the repository's configuration: extensions.worktreeConfig = %q", out)
			}
		})
	}
}

func TestAGitOlderThan234MakesAFullCheckout(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := sparseRepo(t)
	head := mustGit(t, repo, "rev-parse", "HEAD")
	// A checkout this machine's git made sparse before it was swapped for an older one.
	before := &ClaimedSession{SessionID: "s-before", Branch: "orbit/s-before"}
	sparsePath := setupWorktree(before, repo)
	requireSparseCheckout(t, sparsePath, "made by this machine's git")

	asAnOlderGit(t, "git version 2.33.1")
	job := &ClaimedSession{SessionID: "s-old-git", Branch: "orbit/s-old-git"}
	var execDir string
	logs := captureLogs(t, func() { execDir = setupWorktree(job, repo) })

	if job.IsolationStatus != isoWorktree || job.WT == nil {
		t.Fatalf("setupWorktree = %q, isolation %q", execDir, job.IsolationStatus)
	}
	requireFullCheckout(t, execDir, "a checkout an older git makes")
	if want := "session s-old-git — full checkout: .orbit/checkout-exclude at " + shortSha(head) +
		" names paths to leave out, but git version 2.33.1 is older than 2.34, the first git with `git add --sparse`"; !strings.Contains(logs, want) {
		t.Errorf("the log should say why the checkout is full (%q), got:\n%s", want, logs)
	}
	// And --sparse never goes to a git that does not know it, whatever the checkout.
	if got := addAllArgs(sparsePath); !reflect.DeepEqual(got, []string{"add", "-A"}) {
		t.Errorf("staging with an older git = %v, want a plain add -A", got)
	}
}

func TestGitTooOldForSparseReadsTheVersion(t *testing.T) {
	for version, tooOld := range map[string]bool{
		"git version 2.34.0":                     false,
		"git version 2.34.1":                     false,
		"git version 2.47.3":                     false,
		"git version 2.39.5 (Apple Git-154)":     false,
		"git version 2.43.0.windows.1":           false,
		"git version 3.0.0":                      false,
		"git version 2.33.8":                     true,
		"git version 2.9.5":                      true,
		"git version 1.9.5":                      true,
		"something that names no version at all": true,
	} {
		asAnOlderGit(t, version)
		if why := gitTooOldForSparse(); (why != "") != tooOld {
			t.Errorf("%q: gitTooOldForSparse = %q, want too old: %v", version, why, tooOld)
		}
	}
}

// What an agent writes under a left-out path is the session's work like anything else, and every staging the
// runner does on the checkout takes it. Plain `git add -A` exits 1 on such a file and stages nothing of it
// (git 2.47.3), so each of these fails without --sparse.
func TestEveryStagingOfASparseCheckoutTakesANewFileUnderALeftOutPath(t *testing.T) {
	const newFile = "docs/evidence/run-2/result.txt"
	setup := func(t *testing.T, session string) *ClaimedSession {
		t.Helper()
		t.Setenv("ORBIT_HOME", t.TempDir())
		repo := sparseRepo(t)
		job := &ClaimedSession{SessionID: session, Branch: "orbit/" + session}
		requireSparseCheckout(t, setupWorktree(job, repo), "the session's checkout")
		writeTree(t, job.WT.Path, map[string]string{newFile: "a result\n", "src/app.go": "package app\n\nfunc Run() {}\n"})
		return job
	}
	// committed reads the files a commit changed against its parent.
	committed := func(t *testing.T, dir, commit string) string {
		t.Helper()
		return mustGit(t, dir, "diff", "--name-status", commit+"^", commit)
	}
	const want = "A\t" + newFile + "\nM\tsrc/app.go"

	t.Run("the live diff", func(t *testing.T) {
		job := setup(t, "s-live")
		files, patches := liveDiff(job.WT)
		got := fmt.Sprint(files)
		if wantFiles := fmt.Sprint([]ChangedFile{
			{Path: newFile, Additions: 1, Deletions: 0, Status: "A"},
			{Path: "src/app.go", Additions: 2, Deletions: 0, Status: "M"},
		}); got != wantFiles {
			t.Fatalf("live diff = %s, want %s: the new file, and no left-out path reported deleted", got, wantFiles)
		}
		if len(patches) != 2 {
			t.Errorf("live diff patches = %d, want 2", len(patches))
		}
	})

	t.Run("the finalize commit", func(t *testing.T) {
		job := setup(t, "s-finalize")
		files, _, err := finalizeWorktree(job.WT, false)
		if err != nil {
			t.Fatalf("finalize: %v", err)
		}
		if got := committed(t, job.WT.Path, "HEAD"); got != want {
			t.Fatalf("the finalize commit changed %q, want %q", got, want)
		}
		if got := fmt.Sprint(files); !strings.Contains(got, newFile) || strings.Contains(got, "board.png") {
			t.Errorf("finalize reported %s", got)
		}
		if _, err := git(job.WT.RepoDir, "cat-file", "-e", job.Branch+":docs/mocks/board.png"); err != nil {
			t.Errorf("a path the checkout leaves out must stay on the branch: %v", err)
		}
		if status := mustGit(t, job.WT.Path, "status", "--porcelain"); status != "" {
			t.Errorf("nothing should be left uncommitted, got %q", status)
		}
	})

	t.Run("the Commit button", func(t *testing.T) {
		job := setup(t, "s-commit")
		if res := commitWorktree(CommitCommand{SessionID: job.SessionID, Branch: job.Branch}); res.Status != "committed" {
			t.Fatalf("commit = %q (%s), want committed", res.Status, res.Message)
		}
		if got := committed(t, job.WT.Path, "HEAD"); got != want {
			t.Fatalf("the commit changed %q, want %q", got, want)
		}
	})

	t.Run("Discard's record of the work", func(t *testing.T) {
		job := setup(t, "s-discard")
		if res := discardWorktree(CommitCommand{SessionID: job.SessionID, Branch: job.Branch}); res.Status != "discarded" {
			t.Fatalf("discard = %q (%s), want discarded", res.Status, res.Message)
		}
		if got := committed(t, job.WT.Path, "refs/orbit-discarded/"+job.SessionID); got != want {
			t.Fatalf("the discarded work recorded %q, want %q", got, want)
		}
		if !checkoutAbsent(filepath.Join(job.WT.Path, newFile)) {
			t.Errorf("the discarded file should be gone from the checkout")
		}
		requireSparseCheckout(t, job.WT.Path, "a checkout after a discard")
	})
}

// The scratch checkout a merge replays a session's commits in holds every path, whatever the session's checkout
// leaves out: it is added from the workspace's own directory, and git copies sparse settings into a new checkout
// only from the checkout `git worktree add` runs in.
func TestTheMergeScratchOfASparseSessionHoldsEveryPath(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := sparseRepo(t)
	job := &ClaimedSession{SessionID: "s-merge", Branch: "orbit/s-merge"}
	path := setupWorktree(job, repo)
	requireSparseCheckout(t, path, "the session's checkout")
	commitFile(t, path, "src/feature.go", "package app // the session's work\n", "the session's work")
	commitFile(t, repo, "other.txt", "other\n", "main advances, so the merge replays")

	if out := mergeToMain(MergeCommand{WorkDir: repo, Branch: job.Branch, SessionID: job.SessionID}); out.Status != "merged" {
		t.Fatalf("merge = %q (%s), want merged", out.Status, out.Message)
	}
	requireFullCheckout(t, rebaseScratchDir(repo), "the merge's scratch checkout")
	requireFullCheckout(t, repo, "the workspace's own directory, merged into")
	if _, err := os.Stat(filepath.Join(repo, "src", "feature.go")); err != nil {
		t.Errorf("the session's work should have landed in the workspace: %v", err)
	}
}

// Mid-conflict the checkout's index cannot seed the live diff's, and an index read fresh from HEAD has none of the
// skip-worktree marks: the paths the checkout leaves out must still not be reported deleted.
func TestASparseCheckoutsLiveDiffMidConflictReportsNoLeftOutPathDeleted(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := sparseRepo(t)
	job := &ClaimedSession{SessionID: "s-conflict", Branch: "orbit/s-conflict"}
	path := setupWorktree(job, repo)
	requireSparseCheckout(t, path, "the session's checkout")
	mustGit(t, path, "checkout", "-q", "-b", "other")
	commitFile(t, path, "src/app.go", "package other\n", "the other side")
	mustGit(t, path, "checkout", "-q", job.Branch)
	commitFile(t, path, "src/app.go", "package mine\n", "this side")
	if _, err := git(path, "merge", "other"); err == nil {
		t.Fatal("test setup: the merge should conflict")
	}
	idx := filepath.Join(t.TempDir(), "index")
	if unboundedWorktreeGitOps.seedIndexFromCheckout(path, idx, append(os.Environ(), "GIT_INDEX_FILE="+idx)) {
		t.Fatal("test setup: an index with unmerged entries should not seed the temp index")
	}

	files, _ := liveDiff(job.WT)
	if len(files) != 1 || files[0].Path != "src/app.go" || files[0].Status != "M" {
		t.Fatalf("the live diff should report the conflicted file and nothing the checkout leaves out, got %+v", files)
	}
}

func TestSparseCheckoutPatternsNegateTheDeclaration(t *testing.T) {
	got := sparseCheckoutPatterns([]string{"docs/mocks/", "!docs/mocks/keep/", "*.mp4", "!"})
	if want := []string{"/*", "!docs/mocks/", "docs/mocks/keep/", "!*.mp4"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("sparseCheckoutPatterns = %q, want %q", got, want)
	}
}

func TestSparseCheckoutNoteNamesWhatIsLeftOut(t *testing.T) {
	if note := sparseCheckoutNote([]string{"!docs/keep/"}); note != "" {
		t.Errorf("a declaration that leaves nothing out gets no note, got %q", note)
	}
	note := sparseCheckoutNote([]string{"docs/mocks/", "!docs/mocks/keep/", "*.mp4"})
	for _, want := range []string{"leaves out `docs/mocks/`, `*.mp4`.", "`git sparse-checkout add <path>`", "`git add --sparse`", checkoutExcludeFile} {
		if !strings.Contains(note, want) {
			t.Errorf("the note should say %q, got %q", want, note)
		}
	}
	var many []string
	for i := 1; i <= 15; i++ {
		many = append(many, fmt.Sprintf("docs/evidence/run-%02d/", i))
	}
	note = sparseCheckoutNote(many)
	if !strings.Contains(note, "`docs/evidence/run-12/` and 3 more.") || strings.Contains(note, "run-13") {
		t.Errorf("the note should name the first 12 paths and count the rest, got %q", note)
	}
	for _, r := range note {
		if r > 0x7e {
			t.Fatalf("the note should be ASCII, like the instructions it goes out with: %q", note)
		}
	}
}

// Every engine's instructions carry the note, where the agent's appended prompt goes, and a full checkout's carry
// none of it.
func TestEveryEngineIsToldWhatItsSparseCheckoutLeavesOut(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := sparseRepo(t)
	job := &ClaimedSession{SessionID: "s-told", Branch: "orbit/s-told",
		Agent: AgentExecConfig{AppendSystemPrompt: "Owner instructions.", Model: "test-model", PermissionMode: "default"}}
	requireSparseCheckout(t, setupWorktree(job, repo), "the session's checkout")

	note := checkoutInstructions(job.WT)
	if note == "" || !strings.Contains(note, "`docs/mocks/`, `docs/evidence/`") {
		t.Fatalf("checkoutInstructions = %q", note)
	}
	if got, want := job.appendSystemPrompt(), "Owner instructions.\n\n"+note; got != want {
		t.Fatalf("appendSystemPrompt = %q, want the agent's own, then the note: %q", got, want)
	}
	for engine, instructions := range engineInstructions(t, job) {
		if !strings.Contains(instructions, note) {
			t.Errorf("%s was not told what the checkout leaves out:\n%s", engine, instructions)
		}
		if !strings.Contains(instructions, "Owner instructions.") {
			t.Errorf("%s lost the agent's own appended prompt:\n%s", engine, instructions)
		}
	}

	full := &ClaimedSession{SessionID: "s-whole", Branch: "orbit/s-whole", WT: &Worktree{Path: repo, RepoDir: repo, BaseSha: mustGit(t, repo, "rev-parse", "HEAD")},
		Agent: AgentExecConfig{AppendSystemPrompt: "Owner instructions.", Model: "test-model", PermissionMode: "default"}}
	if got := full.appendSystemPrompt(); got != "Owner instructions." {
		t.Errorf("a full checkout's appended prompt = %q, want the agent's own", got)
	}
	for engine, instructions := range engineInstructions(t, full) {
		if strings.Contains(instructions, "checkout is sparse") {
			t.Errorf("%s was told a full checkout is sparse:\n%s", engine, instructions)
		}
	}
}

// engineInstructions is what each engine is given for job, as it builds it for a spawn or a turn.
func engineInstructions(t *testing.T, job *ClaimedSession) map[string]string {
	t.Helper()
	scratch := t.TempDir()
	opencode, err := openCodeConfigContent(job, scratch, "orbit-test", nil)
	if err != nil {
		t.Fatal(err)
	}
	instructionFiles, _ := filepath.Glob(filepath.Join(scratch, "opencode-instructions.txt"))
	var openCodeText []string
	for _, f := range instructionFiles {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		openCodeText = append(openCodeText, string(b))
	}
	if !strings.Contains(opencode, "opencode-instructions.txt") {
		t.Fatalf("OpenCode's config should name its instructions file: %s", opencode)
	}
	codexContext := codexTurnParams("thread-1", job, job.WT.Path, scratch, "turn-1", "hi", nil,
		codexTurnContextOptions{Mode: codexInstructionsAdditionalContext, Generation: 1})["additionalContext"]
	values := []string{}
	for _, entry := range codexContext.(map[string]interface{}) {
		values = append(values, entry.(map[string]interface{})["value"].(string))
	}
	sort.Strings(values)
	codexInput := codexTurnParams("thread-1", job, job.WT.Path, scratch, "turn-1", "hi", nil,
		codexTurnContextOptions{Mode: codexInstructionsUserInput})["input"]
	return map[string]string{
		"claude":                   strings.Join(claudeCommandArgs(job, t.TempDir(), true), "\n"),
		"codex additional context": strings.Join(values, "\n"),
		"codex user input":         fmt.Sprint(codexInput),
		"kimi":                     fmt.Sprint(prepareKimiPrompt(context.Background(), nil, job, &RunInboxResponse{Content: "hi"}, nil).blocks),
		"deepseek harness":         dshSessionAgentOverlay(job).AppendSystemPrompt,
		"antigravity":              antigravityInstructions(job, "/usr/local/bin/orbit"),
		"cursor":                   cursorAgentInstructions(job),
		"opencode":                 strings.Join(openCodeText, "\n"),
	}
}
