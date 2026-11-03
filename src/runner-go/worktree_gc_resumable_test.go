//go:build linux

package main

import (
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// The second half of a sweep (gcResumableCheckouts): under the disk's floor the checkouts of sessions
// that can resume go too, oldest first, when they have nothing to lose. What these tests hold it to:
//
//   - the rule: an idle, clean, pushed checkout with no process goes, oldest first, and the sweep stops
//     at the floor (TestResumableSweep*Reclaims*, *OldestFirst*);
//   - nothing else goes: every reason to keep a checkout has a case with a neighbour that does go, so
//     the sweep is proved to have run, and each case ages the checkout again after setting itself up,
//     so that this reason and no other is what keeps it (TestResumableSweepKeeps);
//   - a roomy disk, and a control plane too old to answer, change nothing;
//   - it comes back: on its branch, on the right fork point, and from every door a resting session
//     wakes through (TestAReclaimedCheckout*).

// resumableFixture is a runner's worktrees root, a repository with an origin, a real pool, and a fake
// control plane in front of them. The fake answers the real endpoint's two lists: an id it was told
// about is resumable or merely kept, and anything else is removable leftover.
type resumableFixture struct {
	repo      string
	pool      *sessionPool
	transport *Transport

	mu sync.Mutex
	// answers is "resumable" or "kept" per session; absent is removable.
	answers map[string]string
	// branches is the branch the reply names for a resumable session, when not its orbit/ one.
	branches map[string]string
	// oldControlPlane leaves the new field out of the reply altogether.
	oldControlPlane bool
	unavailable     bool
	// failNext fails the next request only.
	failNext bool
	queries  int
	// atSecondLook runs the second time the control plane is asked about this session, which is the
	// sweep's second look, and before it answers.
	atSecondLook map[string]func()
	timesAsked   map[string]int
	// alsoAnswer is what the reply calls resumable besides, asked or not.
	alsoAnswer []string
}

func newResumableFixture(t *testing.T) *resumableFixture {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	f := &resumableFixture{
		repo:         initRepo(t),
		pool:         newSessionPool(4),
		answers:      map[string]string{},
		branches:     map[string]string{},
		atSecondLook: map[string]func(){},
		timesAsked:   map[string]int{},
	}
	origin := t.TempDir()
	mustGit(t, origin, "init", "-q", "--bare")
	mustGit(t, f.repo, "remote", "add", "origin", origin)
	mustGit(t, f.repo, "push", "-q", "origin", "main")
	server := httptest.NewServer(http.HandlerFunc(f.answer))
	t.Cleanup(server.Close)
	f.transport = NewTransport(server.URL, "gc-token")
	return f
}

func (f *resumableFixture) answer(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/api/runner/sessions/worktrees-removable" {
		http.Error(w, "unexpected", http.StatusNotFound)
		return
	}
	var req struct {
		IDs []string `json:"ids"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	f.mu.Lock()
	f.queries++
	var hooks []func()
	for _, id := range req.IDs {
		f.timesAsked[id]++
		if hook := f.atSecondLook[id]; hook != nil && f.timesAsked[id] == 2 {
			hooks = append(hooks, hook)
		}
	}
	f.mu.Unlock()
	for _, hook := range hooks {
		hook()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.unavailable || f.failNext {
		f.failNext = false
		http.Error(w, "control plane unavailable", http.StatusInternalServerError)
		return
	}
	type session struct {
		ID     string `json:"id"`
		Branch string `json:"branch"`
	}
	removable := []string{}
	resumable := []session{}
	for _, id := range f.alsoAnswer {
		resumable = append(resumable, session{ID: id, Branch: "orbit/" + id})
	}
	for _, id := range req.IDs {
		switch f.answers[id] {
		case "resumable":
			branch := f.branches[id]
			if branch == "" {
				branch = "orbit/" + id
			}
			resumable = append(resumable, session{ID: id, Branch: branch})
		case "kept":
		default:
			removable = append(removable, id)
		}
	}
	body := map[string]any{"removable": removable}
	if !f.oldControlPlane {
		body["resumable"] = resumable
	}
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(body)
}

func (f *resumableFixture) set(mutate func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	mutate()
}

func (f *resumableFixture) queryCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.queries
}

// checkout adds a session's checkout the way a session that committed and pushed its work leaves it,
// twenty days old, and has the control plane call it resumable.
func (f *resumableFixture) checkout(t *testing.T, session string) string {
	t.Helper()
	return f.checkoutFrom(t, f.repo, session, "main")
}

func (f *resumableFixture) checkoutFrom(t *testing.T, repo, session, from string) string {
	t.Helper()
	path := filepath.Join(worktreesDir(), session)
	branch := "orbit/" + session
	fork := mustGit(t, repo, "rev-parse", from)
	mustGit(t, repo, "worktree", "add", "-q", "-b", branch, path, from)
	mustGit(t, repo, "update-ref", baseRefName(session), fork)
	commitFile(t, path, session+".txt", "work by "+session+"\n", "work by "+session)
	if _, err := git(path, "remote"); err == nil {
		_, _ = git(path, "push", "-q", "origin", branch)
	}
	ageCheckout(t, path, 20)
	f.set(func() { f.answers[session] = "resumable" })
	return path
}

// ageCheckout dates everything in a checkout days back, the directories too.
func ageCheckout(t *testing.T, path string, days int) {
	t.Helper()
	when := time.Now().Add(-time.Duration(days) * 24 * time.Hour)
	if err := filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Chtimes(p, when, when)
	}); err != nil {
		t.Fatalf("age %s: %v", path, err)
	}
}

// commitAndPush commits and pushes in a checkout.
func commitAndPush(t *testing.T, path, name, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filepath.Join(path, name)), 0o755); err != nil {
		t.Fatal(err)
	}
	commitFile(t, path, name, content, "add "+name)
	branch := mustGit(t, path, "rev-parse", "--abbrev-ref", "HEAD")
	mustGit(t, path, "push", "-q", "origin", branch)
}

// ignoring commits a .gitignore naming these and pushes it.
func ignoring(t *testing.T, path string, patterns ...string) {
	t.Helper()
	commitAndPush(t, path, ".gitignore", strings.Join(patterns, "\n")+"\n")
}

func writeUnder(t *testing.T, path, rel, content string) string {
	t.Helper()
	file := filepath.Join(path, rel)
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return file
}

// startProcess runs sleep with the given directory, and stops it when the test ends.
func startProcess(t *testing.T, cmd *exec.Cmd) {
	t.Helper()
	if err := cmd.Start(); err != nil {
		t.Fatalf("start %v: %v", cmd.Args, err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
}

// standOnFakeProcessTable has the sweep read a process table with no processes, and these mount points.
func standOnFakeProcessTable(t *testing.T, mounts ...string) {
	t.Helper()
	fake := t.TempDir()
	if err := os.MkdirAll(filepath.Join(fake, "self"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/", filepath.Join(fake, "self", "cwd")); err != nil {
		t.Fatal(err)
	}
	var table strings.Builder
	table.WriteString("22 1 8:3 / / rw,relatime shared:1 - ext4 /dev/sda3 rw\n")
	for i, mount := range mounts {
		table.WriteString(strconv.Itoa(100+i) + " 22 8:3 /scratch " + strings.ReplaceAll(mount, " ", `\040`) + " rw,relatime shared:1 - ext4 /dev/sda3 rw\n")
	}
	if err := os.WriteFile(filepath.Join(fake, "self", "mountinfo"), []byte(table.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	previous := procDir
	procDir = fake
	t.Cleanup(func() { procDir = previous })
}

func sweepOnFullDisk(f *resumableFixture) {
	gcResumableCheckouts(f.transport, f.pool, diskUnderTheFloor())
}

func TestResumableSweepReclaimsAnIdleCleanPushedCheckoutKeepingItsBranchAndBaseRef(t *testing.T) {
	f := newResumableFixture(t)
	path := f.checkout(t, "sess-parked")
	tip := mustGit(t, path, "rev-parse", "HEAD")

	logs := captureLogs(t, func() { sweepOnFullDisk(f) })

	requireCheckoutReclaimed(t, path, "an idle, clean, pushed checkout of a resumable session, under the floor")
	if got := mustGit(t, f.repo, "rev-parse", "orbit/sess-parked"); got != tip {
		t.Fatalf("the branch must stay where it was, at %s, got %s", tip, got)
	}
	if _, err := git(f.repo, "rev-parse", "--verify", baseRefName("sess-parked")); err != nil {
		t.Fatalf("the base ref must stay, for the diff of the session's next turn: %v", err)
	}
	if _, err := git(f.repo, "rev-parse", "--verify", reclaimedRefName("sess-parked")); err != nil {
		t.Fatalf("the session must be marked, so that its next turn can tell this from any other missing checkout: %v", err)
	}
	if out := mustGit(t, f.repo, "worktree", "list"); strings.Contains(out, "sess-parked") {
		t.Fatalf("git must not go on listing the checkout:\n%s", out)
	}
	if !strings.Contains(logs, "gc: reclaimed checkout sess-parked — resumable session, clean and pushed, nothing written for 20 days") {
		t.Fatalf("each reclaimed checkout says why in one line, got:\n%s", logs)
	}
	if entries, _ := os.ReadDir(worktreesDir()); len(entries) != 0 {
		t.Fatalf("nothing may be left in the worktrees root, got %v", entries)
	}
}

// A cold supervisor is no reason to keep a checkout: after a restart nearly every resting session has
// one, and it holds nothing. This is the case that reading `live` as pool.ids() would miss.
func TestResumableSweepReclaimsTheCheckoutOfAColdSupervisor(t *testing.T) {
	f := newResumableFixture(t)
	path := f.checkout(t, "sess-cold")
	job := manualWorktreePoolJob("sess-cold", "orbit/sess-cold")
	job.WT = &Worktree{Path: path, Branch: "orbit/sess-cold", RepoDir: f.repo, Session: "sess-cold"}
	if _, added := f.pool.register(job, func() {}, false); !added {
		t.Fatal("register a cold supervisor")
	}
	if !f.pool.ids()["sess-cold"] {
		t.Fatal("the old sweep's `live` is meant to count a cold supervisor, or this test proves nothing")
	}

	sweepOnFullDisk(f)

	requireCheckoutReclaimed(t, path, "a cold supervisor holds no engine, no turn and no job")
	if f.pool.absentCheckout("sess-cold") == nil {
		t.Fatal("its supervisor must read the checkout as absent, for its next claim to bring it back")
	}
}

// The branch that counts is the one the control plane says the session comes back on, whatever it is
// called: one adopted from elsewhere is as good as Orbit's own.
func TestResumableSweepReclaimsACheckoutOnTheBranchItsSessionAdopted(t *testing.T) {
	f := newResumableFixture(t)
	path := f.checkout(t, "sess-adopted")
	mustGit(t, path, "checkout", "-q", "-b", "feature/adopted")
	mustGit(t, path, "push", "-q", "origin", "feature/adopted")
	ageCheckout(t, path, 20)
	f.set(func() { f.branches["sess-adopted"] = "feature/adopted" })

	sweepOnFullDisk(f)

	requireCheckoutReclaimed(t, path, "it stands on the branch it comes back on")
}

// Oldest by what was last written in it, not by the checkout directory's own time, which any file
// created at its top moves and a write further down does not.
func TestResumableSweepTakesTheOldestFirstAndStopsAboveTheFloor(t *testing.T) {
	f := newResumableFixture(t)
	oldest := f.checkout(t, "sess-c-oldest")
	ageCheckout(t, oldest, 60)
	middle := f.checkout(t, "sess-a-middle")
	ageCheckout(t, middle, 40)
	// The newest write of all, under a checkout directory older than any other.
	newest := f.checkout(t, "sess-b-newest")
	ageCheckout(t, newest, 90)
	old := time.Now().Add(-20 * 24 * time.Hour)
	if err := os.Chtimes(filepath.Join(newest, "sess-b-newest.txt"), old, old); err != nil {
		t.Fatal(err)
	}

	// Each checkout that goes is 2 GiB. The disk starts 3 GiB short of a 4 GiB floor.
	const gib = uint64(1 << 30)
	pressure := worktreeGCPressure{measured: true, floorMb: 4096, freeBytes: 1 * gib}
	pressure.reread = func() worktreeGCPressure {
		free := 1 * gib
		for _, path := range []string{oldest, middle, newest} {
			if _, err := os.Stat(path); os.IsNotExist(err) {
				free += 2 * gib
			}
		}
		return worktreeGCPressure{measured: true, floorMb: 4096, freeBytes: free, reread: pressure.reread}
	}

	gcResumableCheckouts(f.transport, f.pool, pressure)

	requireCheckoutReclaimed(t, oldest, "the oldest goes first")
	requireCheckoutReclaimed(t, middle, "the next oldest goes while the disk is still short")
	requireCheckoutOnDisk(t, newest, "back above the floor, the sweep stops: the newest write stays, its directory's old time notwithstanding")
}

// In the order the run loop calls them: when the first half of the sweep gets the disk back above the
// floor, the second takes nothing, and does not even ask.
func TestResumableSweepTakesNothingOnceTheFirstHalfRecoveredTheDisk(t *testing.T) {
	f := newResumableFixture(t)
	resumable := f.checkout(t, "sess-resumable")
	finished := f.checkout(t, "sess-finished")
	f.set(func() { delete(f.answers, "sess-finished") })

	pressure := diskUnderTheFloor()
	pressure.reread = func() worktreeGCPressure {
		if _, err := os.Stat(finished); os.IsNotExist(err) {
			return roomyDisk()
		}
		return diskUnderTheFloor()
	}
	gcWorktrees(f.transport, f.pool.ids(), pressure)
	requireCheckoutReclaimed(t, finished, "a finished session's checkout goes first, as it always has")
	asked := f.queryCount()

	gcResumableCheckouts(f.transport, f.pool, pressure)

	requireCheckoutOnDisk(t, resumable, "the first half freed enough")
	if got := f.queryCount(); got != asked {
		t.Fatalf("the second half asked the control plane %d more times with the disk back above its floor", got-asked)
	}
}

// Every reason a checkout stays, each beside a neighbour that goes. A case that sets up its own reason
// ages the checkout after doing so, unless a recent write IS the reason, so only that one can keep it.
func TestResumableSweepKeeps(t *testing.T) {
	cases := []struct {
		name    string
		prepare func(t *testing.T, f *resumableFixture, path, session string)
	}{
		{"a modified tracked file", func(t *testing.T, f *resumableFixture, path, session string) {
			writeUnder(t, path, "base.txt", "changed and not committed\n")
			ageCheckout(t, path, 20)
		}},
		{"a staged file", func(t *testing.T, f *resumableFixture, path, session string) {
			writeUnder(t, path, "staged.txt", "staged\n")
			mustGit(t, path, "add", "staged.txt")
			ageCheckout(t, path, 20)
		}},
		{"an untracked file", func(t *testing.T, f *resumableFixture, path, session string) {
			writeUnder(t, path, "scratch/untracked.txt", "only here\n")
			ageCheckout(t, path, 20)
		}},
		{"an untracked file its repository's config hides from git status", func(t *testing.T, f *resumableFixture, path, session string) {
			mustGit(t, f.repo, "config", "status.showUntrackedFiles", "no")
			writeUnder(t, path, "scratch/untracked.txt", "only here\n")
			ageCheckout(t, path, 20)
		}},
		{"a commit no remote has", func(t *testing.T, f *resumableFixture, path, session string) {
			commitFile(t, path, "unpushed.txt", "local\n", "unpushed")
			ageCheckout(t, path, 20)
		}},
		{"a file written within two weeks, content unchanged", func(t *testing.T, f *resumableFixture, path, session string) {
			ageCheckout(t, path, 20)
			now := time.Now().Add(-13 * 24 * time.Hour)
			if err := os.Chtimes(filepath.Join(path, session+".txt"), now, now); err != nil {
				t.Fatal(err)
			}
		}},
		{"build output written within two weeks", func(t *testing.T, f *resumableFixture, path, session string) {
			ignoring(t, path, "dist/")
			ageCheckout(t, path, 20)
			writeUnder(t, path, "dist/deep/app.js", "a recent build is a recent use\n")
			// Only the file itself is new: its directories say nothing.
			ago := time.Now().Add(-20 * 24 * time.Hour)
			for _, dir := range []string{path, filepath.Join(path, "dist"), filepath.Join(path, "dist", "deep")} {
				_ = os.Chtimes(dir, ago, ago)
			}
		}},
		{"a file deleted within two weeks", func(t *testing.T, f *resumableFixture, path, session string) {
			ignoring(t, path, "dist/")
			writeUnder(t, path, "dist/deep/app.js", "a build\n")
			ageCheckout(t, path, 20)
			if err := os.Remove(filepath.Join(path, "dist", "deep", "app.js")); err != nil {
				t.Fatal(err)
			}
		}},
		{"an ignored .env, however old", func(t *testing.T, f *resumableFixture, path, session string) {
			ignoring(t, path, ".env")
			writeUnder(t, path, ".env", "SECRET=only here\n")
			ageCheckout(t, path, 20)
		}},
		{"an ignored .env further down", func(t *testing.T, f *resumableFixture, path, session string) {
			commitAndPush(t, path, "src/web/index.txt", "tracked\n")
			ignoring(t, path, ".env")
			writeUnder(t, path, "src/web/.env", "SECRET=only here\n")
			ageCheckout(t, path, 20)
		}},
		{"an ignored report, however old", func(t *testing.T, f *resumableFixture, path, session string) {
			ignoring(t, path, "reports/")
			writeUnder(t, path, "reports/march/findings.md", "written by the session, kept nowhere else\n")
			ageCheckout(t, path, 20)
		}},
		{"an ignored report beside listed entries", func(t *testing.T, f *resumableFixture, path, session string) {
			ignoring(t, path, "node_modules/", "dist/", "*.report")
			writeUnder(t, path, "node_modules/x/i.js", "x\n")
			writeUnder(t, path, "dist/app.js", "x\n")
			writeUnder(t, path, "findings.report", "written by the session, kept nowhere else\n")
			ageCheckout(t, path, 20)
		}},
		{"an ignored report in a directory with a listed name that is not itself ignored", func(t *testing.T, f *resumableFixture, path, session string) {
			ignoring(t, path, "*.report")
			writeUnder(t, path, "build/findings.report", "written by the session, kept nowhere else\n")
			ageCheckout(t, path, 20)
		}},
		{"an ignored file git has to quote the name of", func(t *testing.T, f *resumableFixture, path, session string) {
			ignoring(t, path, "*.txt.old")
			writeUnder(t, path, "my notes.txt.old", "written by the session, kept nowhere else\n")
			ageCheckout(t, path, 20)
		}},
		{"a process working in it", func(t *testing.T, f *resumableFixture, path, session string) {
			dir := filepath.Dir(writeUnder(t, path, "sub/tracked.txt", "x\n"))
			commitAndPush(t, path, "sub/tracked.txt", "x\n")
			cmd := exec.Command("sleep", "600")
			cmd.Dir = dir
			startProcess(t, cmd)
			ageCheckout(t, path, 20)
		}},
		{"a process holding one of its files open from elsewhere", func(t *testing.T, f *resumableFixture, path, session string) {
			ignoring(t, path, "dist/")
			held, err := os.Create(writeUnder(t, path, "dist/server.log", ""))
			if err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command("sleep", "600")
			cmd.Dir = t.TempDir()
			cmd.Stdout = held
			startProcess(t, cmd)
			_ = held.Close()
			ageCheckout(t, path, 20)
		}},
		{"a process running an executable from it", func(t *testing.T, f *resumableFixture, path, session string) {
			ignoring(t, path, "dist/")
			sleep, err := exec.LookPath("sleep")
			if err != nil {
				t.Fatal(err)
			}
			content, err := os.ReadFile(sleep)
			if err != nil {
				t.Fatal(err)
			}
			copied := writeUnder(t, path, "dist/sleep", string(content))
			if err := os.Chmod(copied, 0o755); err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command(copied, "600")
			cmd.Dir = t.TempDir()
			startProcess(t, cmd)
			ageCheckout(t, path, 20)
		}},
		{"a background shell of its session", func(t *testing.T, f *resumableFixture, path, session string) {
			f.pool.holdWorktreeForBackgroundJob(session, "toolu_A", "bei1")
		}},
		{"a job the runner hosts for its session", func(t *testing.T, f *resumableFixture, path, session string) {
			f.pool.holdWorktreeForRunnerJob(session, "bgj_A", "bgj_A")
		}},
		{"a job adopted for its session across a re-exec, with no supervisor yet", func(t *testing.T, f *resumableFixture, path, session string) {
			f.pool.keepHostlessJob(session, &bgJob{})
		}},
		{"a merge or commit under way", func(t *testing.T, f *resumableFixture, path, session string) {
			release, admitted := f.pool.beginHeartbeatWorktreeOperation(session, nil, 0, false)
			if !admitted {
				t.Fatal("admit an operation")
			}
			t.Cleanup(release)
		}},
		{"a turn running", func(t *testing.T, f *resumableFixture, path, session string) {
			job := manualWorktreePoolJob(session, "orbit/"+session)
			if _, added := f.pool.register(job, func() {}, true); !added {
				t.Fatal("register an active session")
			}
		}},
		{"a warm engine between turns", func(t *testing.T, f *resumableFixture, path, session string) {
			job := manualWorktreePoolJob(session, "orbit/"+session)
			live, added := f.pool.register(job, func() {}, true)
			if !added {
				t.Fatal("register an active session")
			}
			if _, _, ok := f.pool.reserveEngine(live, context.Background(), context.Background()); !ok {
				t.Fatal("make the engine resident")
			}
			parkPoolSession(f.pool, live)
		}},
		{"a supervisor being retired", func(t *testing.T, f *resumableFixture, path, session string) {
			job := manualWorktreePoolJob(session, "orbit/"+session)
			if _, added := f.pool.register(job, func() {}, false); !added {
				t.Fatal("register a cold supervisor")
			}
			if _, detaching := f.pool.detachForTakeover(session); !detaching {
				t.Fatal("start retiring it")
			}
		}},
		{"a session the control plane says is on its way to an engine", func(t *testing.T, f *resumableFixture, path, session string) {
			f.set(func() { f.answers[session] = "kept" })
		}},
		{"a lock on the worktree", func(t *testing.T, f *resumableFixture, path, session string) {
			mustGit(t, path, "worktree", "lock", path)
		}},
		{"a merge half done", func(t *testing.T, f *resumableFixture, path, session string) {
			head := mustGit(t, path, "rev-parse", "HEAD")
			if err := os.WriteFile(filepath.Join(mustGit(t, path, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD"), []byte(head+"\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		{"a rebase half done", func(t *testing.T, f *resumableFixture, path, session string) {
			if err := os.MkdirAll(filepath.Join(mustGit(t, path, "rev-parse", "--absolute-git-dir"), "rebase-merge"), 0o755); err != nil {
				t.Fatal(err)
			}
		}},
		{"a bisect half done", func(t *testing.T, f *resumableFixture, path, session string) {
			if err := os.WriteFile(filepath.Join(mustGit(t, path, "rev-parse", "--absolute-git-dir"), "BISECT_LOG"), []byte("x\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		{"a HEAD detached from any branch", func(t *testing.T, f *resumableFixture, path, session string) {
			mustGit(t, path, "checkout", "-q", "--detach")
			ageCheckout(t, path, 20)
		}},
		{"a HEAD moved to a branch of the agent's own", func(t *testing.T, f *resumableFixture, path, session string) {
			mustGit(t, path, "checkout", "-q", "-b", "feature/"+session)
			mustGit(t, path, "push", "-q", "origin", "feature/"+session)
			ageCheckout(t, path, 20)
		}},
		{"a HEAD moved to another orbit/ branch, pushed", func(t *testing.T, f *resumableFixture, path, session string) {
			mustGit(t, path, "checkout", "-q", "-b", "orbit/"+session+"-v2")
			commitFile(t, path, "later.txt", "later\n", "later work, on the other branch")
			mustGit(t, path, "push", "-q", "origin", "orbit/"+session+"-v2")
			ageCheckout(t, path, 20)
		}},
		{"no base ref to come back to", func(t *testing.T, f *resumableFixture, path, session string) {
			mustGit(t, f.repo, "update-ref", "-d", baseRefName(session))
		}},
		{"an edit under assume-unchanged, which git status does not report", func(t *testing.T, f *resumableFixture, path, session string) {
			mustGit(t, path, "update-index", "--assume-unchanged", "base.txt")
			writeUnder(t, path, "base.txt", "an edit git status will not show\n")
			if status := mustGit(t, path, "status", "--porcelain"); status != "" {
				t.Fatalf("the point of this case is a clean status, got %q", status)
			}
			ageCheckout(t, path, 20)
		}},
		{"an edit under skip-worktree, which git status does not report", func(t *testing.T, f *resumableFixture, path, session string) {
			mustGit(t, path, "update-index", "--skip-worktree", "base.txt")
			writeUnder(t, path, "base.txt", "an edit git status will not show\n")
			if status := mustGit(t, path, "status", "--porcelain"); status != "" {
				t.Fatalf("the point of this case is a clean status, got %q", status)
			}
			ageCheckout(t, path, 20)
		}},
		{"a clone with commits of its own under a dependency directory", func(t *testing.T, f *resumableFixture, path, session string) {
			ignoring(t, path, "vendor/")
			nested := filepath.Join(path, "vendor", "a-library")
			if err := os.MkdirAll(nested, 0o755); err != nil {
				t.Fatal(err)
			}
			mustGit(t, nested, "init", "-q", "-b", "main")
			mustGit(t, nested, "config", "user.email", "test@orbit")
			mustGit(t, nested, "config", "user.name", "Test")
			commitFile(t, nested, "patched.txt", "only here\n", "a patch nobody pushed")
			ageCheckout(t, path, 20)
		}},
		{"a mount left inside it", func(t *testing.T, f *resumableFixture, path, session string) {
			ignoring(t, path, "node_modules/")
			ageCheckout(t, path, 20)
			standOnFakeProcessTable(t, filepath.Join(path, "node_modules"))
		}},
		{"a repository with commits of its own under an ignored directory", func(t *testing.T, f *resumableFixture, path, session string) {
			ignoring(t, path, "dist/")
			nested := filepath.Join(path, "dist", "clone")
			if err := os.MkdirAll(nested, 0o755); err != nil {
				t.Fatal(err)
			}
			mustGit(t, nested, "init", "-q", "-b", "main")
			mustGit(t, nested, "config", "user.email", "test@orbit")
			mustGit(t, nested, "config", "user.name", "Test")
			commitFile(t, nested, "only-here.txt", "only here\n", "only here")
			ageCheckout(t, path, 20)
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newResumableFixture(t)
			const session = "sess-kept"
			path := f.checkout(t, session)
			neighbour := f.checkout(t, "sess-neighbour")
			c.prepare(t, f, path, session)
			// The first look is a judgement of its own, not a draft of the second.
			f.set(func() {
				f.atSecondLook[session] = func() { t.Errorf("%s got past the first look", c.name) }
			})

			sweepOnFullDisk(f)

			requireCheckoutOnDisk(t, path, c.name)
			requireCheckoutReclaimed(t, neighbour, "its neighbour goes, so the sweep did run")
			if _, err := git(path, "rev-parse", "--verify", "HEAD"); err != nil {
				t.Fatalf("the kept checkout must still be a checkout: %v", err)
			}
		})
	}
}

// The kernel writes a space in a mount point as \\040, and read raw that names some other directory.
func TestResumableSweepReadsAMountPointWithASpaceInItsPath(t *testing.T) {
	f := newResumableFixture(t)
	path := f.checkout(t, "sess-kept")
	neighbour := f.checkout(t, "sess-neighbour")
	// The kernel names the real path, so the root is reached through a link, as it may be on a real host.
	root := worktreesDir()
	spaced := filepath.Join(t.TempDir(), "with space")
	if err := os.Rename(root, spaced); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(spaced, root); err != nil {
		t.Fatal(err)
	}
	resolved, err := filepath.EvalSymlinks(spaced)
	if err != nil {
		t.Fatal(err)
	}
	standOnFakeProcessTable(t, filepath.Join(resolved, "sess-kept", "node_modules"))

	sweepOnFullDisk(f)

	requireCheckoutOnDisk(t, path, "a mount inside it, spelled by the kernel")
	requireCheckoutReclaimed(t, neighbour, "its neighbour goes, so the sweep did run")
}

// With no remote there is nowhere its commits could have been pushed to, so rev-list counts them all.
func TestResumableSweepKeepsACheckoutOfARepositoryWithNoRemote(t *testing.T) {
	f := newResumableFixture(t)
	path := f.checkout(t, "sess-no-remote")
	mustGit(t, f.repo, "remote", "remove", "origin")

	sweepOnFullDisk(f)

	requireCheckoutOnDisk(t, path, "with no remote, nothing has been pushed")
}

// A directory named like a session that is a repository in its own right. git cannot remove it as a
// worktree and a plain delete would take its whole history.
func TestResumableSweepKeepsADirectoryThatIsARepositoryOfItsOwn(t *testing.T) {
	f := newResumableFixture(t)
	path := filepath.Join(worktreesDir(), "sess-repo")
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	mustGit(t, path, "init", "-q", "-b", "orbit/sess-repo")
	mustGit(t, path, "config", "user.email", "test@orbit")
	mustGit(t, path, "config", "user.name", "Test")
	commitFile(t, path, "history.txt", "its own history\n", "its own")
	origin := t.TempDir()
	mustGit(t, origin, "init", "-q", "--bare")
	mustGit(t, path, "remote", "add", "origin", origin)
	mustGit(t, path, "push", "-q", "origin", "orbit/sess-repo")
	mustGit(t, path, "update-ref", baseRefName("sess-repo"), "HEAD")
	ageCheckout(t, path, 20)
	f.set(func() { f.answers["sess-repo"] = "resumable" })

	sweepOnFullDisk(f)

	requireCheckoutOnDisk(t, path, "not a linked worktree")
}

// Writes in a dependency directory are the exception, wherever in the tree it is: they say nothing a
// reinstall would not put back.
func TestResumableSweepDoesNotCountWritesInDependencyDirectories(t *testing.T) {
	names := make([]string, 0, len(checkoutDependencyDirs))
	for name := range checkoutDependencyDirs {
		names = append(names, name)
	}
	f := newResumableFixture(t)
	path := f.checkout(t, "sess-deps")
	commitAndPush(t, path, "src/web/index.txt", "tracked\n")
	ignoring(t, path, names...)
	for _, name := range names {
		writeUnder(t, path, name+"/at-the-top", "x\n")
		writeUnder(t, path, "src/web/"+name+"/further-down", "x\n")
	}
	ageCheckout(t, path, 20)
	now := time.Now()
	for _, name := range names {
		for _, file := range []string{name + "/at-the-top", "src/web/" + name + "/further-down"} {
			if err := os.Chtimes(filepath.Join(path, file), now, now); err != nil {
				t.Fatal(err)
			}
		}
	}

	sweepOnFullDisk(f)

	requireCheckoutReclaimed(t, path, "a write in a dependency directory is not a write in the checkout")
}

// What may be ignored in a checkout that goes, spelled out here and not read off the code: whatever is
// on these lists is deleted unread, so adding a name should take a second look at this test. Each is
// tried alone, at the top of the tree and further down.
func TestResumableSweepTakesACheckoutHoldingOnlyEntriesARebuildPutsBack(t *testing.T) {
	directories := []string{"node_modules", ".venv", "venv", "__pycache__", "vendor", "Pods", ".gradle",
		"dist", "build", ".build", "target", ".next", ".turbo", "coverage"}
	files := []string{"tsconfig.tsbuildinfo"}
	if got, want := len(checkoutDependencyDirs)+len(checkoutBuildOutput), len(directories)+len(files); got != want {
		t.Fatalf("the code lists %d names and this test %d: a name that decides what is deleted unread needs a reason here too", got, want)
	}
	for _, name := range append(append([]string{}, directories...), files...) {
		t.Run(name, func(t *testing.T) {
			f := newResumableFixture(t)
			path := f.checkout(t, "sess-parked")
			commitAndPush(t, path, "src/web/index.txt", "tracked\n")
			ignoring(t, path, name)
			for _, at := range []string{name, "src/web/" + name} {
				if name == "tsconfig.tsbuildinfo" {
					writeUnder(t, path, at, "{}\n")
				} else {
					writeUnder(t, path, at+"/something", "x\n")
				}
			}
			ageCheckout(t, path, 20)
			if entries := mustGit(t, path, "status", "--porcelain", "--ignored=matching", "--untracked-files=normal"); strings.Count(entries, "!! ") != 2 {
				t.Fatalf("this case means two ignored entries, got:\n%s", entries)
			}

			sweepOnFullDisk(f)

			requireCheckoutReclaimed(t, path, "everything ignored in it comes back with a rebuild")
		})
	}
	t.Run("all of them together", func(t *testing.T) {
		f := newResumableFixture(t)
		path := f.checkout(t, "sess-parked")
		ignoring(t, path, append(append([]string{}, directories...), files...)...)
		for _, name := range directories {
			writeUnder(t, path, name+"/something", "x\n")
		}
		writeUnder(t, path, "tsconfig.tsbuildinfo", "{}\n")
		ageCheckout(t, path, 20)

		sweepOnFullDisk(f)

		requireCheckoutReclaimed(t, path, "everything ignored in it comes back with a rebuild")
	})
}

// The disk gate: a roomy disk, no reading and no floor are all "not short", and none of them even asks.
func TestResumableSweepDoesNothingUnlessTheDiskIsUnderItsFloor(t *testing.T) {
	for name, pressure := range map[string]worktreeGCPressure{
		"a roomy disk":     roomyDisk(),
		"exactly at floor": {freeBytes: 4096 * 1024 * 1024, measured: true, floorMb: 4096},
		"no reading":       {freeBytes: 0, measured: false, floorMb: 4096},
		"no floor":         {freeBytes: 0, measured: true, floorMb: 0},
	} {
		t.Run(name, func(t *testing.T) {
			f := newResumableFixture(t)
			path := f.checkout(t, "sess-resumable")

			gcResumableCheckouts(f.transport, f.pool, pressure)

			requireCheckoutOnDisk(t, path, name)
			if f.queryCount() != 0 {
				t.Fatalf("asked the control plane %d times", f.queryCount())
			}
		})
	}
}

// New runner, old control plane: the reply has no `resumable`, which is not "everything not removable
// is resumable". Nothing beyond today's rule goes.
func TestResumableSweepTakesNothingFromAControlPlaneTooOldToAnswer(t *testing.T) {
	f := newResumableFixture(t)
	f.set(func() { f.oldControlPlane = true })
	path := f.checkout(t, "sess-resumable")

	sweepOnFullDisk(f)

	requireCheckoutOnDisk(t, path, "an old control plane never says resumable")
}

// Old runner, new control plane: what an older binary does with the reply is gcWorktrees alone, and the
// new field neither breaks its decoding nor changes what it removes.
func TestAnOlderRunnerReadsOnlyRemovableFromTheNewAnswer(t *testing.T) {
	f := newResumableFixture(t)
	resumable := f.checkout(t, "sess-resumable")
	finished := f.checkout(t, "sess-finished")
	f.set(func() { delete(f.answers, "sess-finished") })

	removable, err := f.transport.worktreesRemovable([]string{"sess-resumable", "sess-finished"})
	if err != nil {
		t.Fatalf("the reply must still decode as the old type: %v", err)
	}
	if len(removable) != 1 || removable[0] != "sess-finished" {
		t.Fatalf("removable = %v, want only the finished session", removable)
	}
	gcWorktrees(f.transport, map[string]bool{}, diskUnderTheFloor())

	requireCheckoutReclaimed(t, finished, "the old rule still takes a finished session's checkout")
	requireCheckoutOnDisk(t, resumable, "the old rule never takes a resumable one, whatever the reply adds")
}

func TestResumableSweepTakesNothingWhenTheControlPlaneCannotBeAsked(t *testing.T) {
	f := newResumableFixture(t)
	f.set(func() { f.unavailable = true })
	path := f.checkout(t, "sess-resumable")

	sweepOnFullDisk(f)

	if f.queryCount() == 0 {
		t.Fatal("the sweep never asked, so its silence proves nothing")
	}
	requireCheckoutOnDisk(t, path, "the control plane could not be asked")
}

// The first look does not lean on the second: a sweep whose first question fails stops there, even with
// a control plane that has come back by the time it would ask again.
func TestResumableSweepStopsAtAFirstQuestionThatFails(t *testing.T) {
	f := newResumableFixture(t)
	path := f.checkout(t, "sess-resumable")
	f.set(func() { f.failNext = true })

	sweepOnFullDisk(f)

	if got := f.queryCount(); got != 1 {
		t.Fatalf("asked %d times, want the one that failed", got)
	}
	requireCheckoutOnDisk(t, path, "the control plane could not be asked")
}

// A machine that cannot say which processes are in a checkout, as on any without Linux's /proc, keeps
// them all, on the first look and on the second.
func TestResumableSweepTakesNothingWhereItCannotSeeProcesses(t *testing.T) {
	blind := func(t *testing.T) {
		previous := procDir
		procDir = filepath.Join(t.TempDir(), "no-proc")
		t.Cleanup(func() { procDir = previous })
	}
	t.Run("with no mount table", func(t *testing.T) {
		f := newResumableFixture(t)
		path := f.checkout(t, "sess-resumable")
		standOnFakeProcessTable(t)
		if err := os.Remove(filepath.Join(procDir, "self", "mountinfo")); err != nil {
			t.Fatal(err)
		}

		sweepOnFullDisk(f)

		requireCheckoutOnDisk(t, path, "nothing could say nothing was mounted in it")
	})
	t.Run("at the first look", func(t *testing.T) {
		f := newResumableFixture(t)
		path := f.checkout(t, "sess-resumable")
		f.set(func() {
			f.atSecondLook["sess-resumable"] = func() { t.Error("the first look went on without knowing") }
		})
		blind(t)

		sweepOnFullDisk(f)

		requireCheckoutOnDisk(t, path, "nothing could say no process was in it")
	})
	t.Run("at the second look", func(t *testing.T) {
		f := newResumableFixture(t)
		path := f.checkout(t, "sess-resumable")
		reached := false
		f.set(func() {
			f.atSecondLook["sess-resumable"] = func() {
				reached = true
				blind(t)
			}
		})

		sweepOnFullDisk(f)

		if !reached {
			t.Fatal("the sweep never reached its second look")
		}
		requireCheckoutOnDisk(t, path, "nothing could say no process was in it")
	})
}

// The reply is only ever read against what was asked. A name nobody asked about, a driven session's
// and a path that climbs out of the root among them, is ignored.
func TestResumableSweepActsOnlyOnWhatItAskedAbout(t *testing.T) {
	f := newResumableFixture(t)
	driven := f.checkout(t, "sess-driven")
	f.pool.holdWorktreeForBackgroundJob("sess-driven", "toolu_A", "bei1")
	outside := filepath.Join(filepath.Dir(worktreesDir()), "outside")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	// A real checkout in every way that matters to the rest of the rule, under a name that is no session's.
	scratch := f.checkout(t, retiredCheckoutPrefix+"sess-x")
	// The session the sweep does ask about, without which it has nothing to ask and reads no reply.
	neighbour := f.checkout(t, "sess-neighbour")
	f.set(func() {
		delete(f.answers, retiredCheckoutPrefix+"sess-x")
		f.alsoAnswer = []string{"sess-driven", "../outside", retiredCheckoutPrefix + "sess-x"}
	})

	sweepOnFullDisk(f)

	requireCheckoutOnDisk(t, driven, "a session being driven is not asked about")
	requireCheckoutOnDisk(t, outside, "a name that climbs out of the root")
	requireCheckoutOnDisk(t, scratch, "a directory that is no session's")
	requireCheckoutReclaimed(t, neighbour, "the one it asked about goes, so it did read the reply")
}

// Each of these changes between the first look and the second, and the second one has to see it.
func TestResumableSweepLooksAgainImmediatelyBeforeItRemoves(t *testing.T) {
	cases := []struct {
		name    string
		between func(t *testing.T, f *resumableFixture, path string)
	}{
		{"the session got a message", func(t *testing.T, f *resumableFixture, path string) {
			f.set(func() { f.answers["sess-parked"] = "kept" })
		}},
		{"the control plane went away", func(t *testing.T, f *resumableFixture, path string) {
			f.set(func() { f.unavailable = true })
		}},
		{"a file was written", func(t *testing.T, f *resumableFixture, path string) {
			now := time.Now()
			if err := os.Chtimes(filepath.Join(path, "sess-parked.txt"), now, now); err != nil {
				t.Error(err)
			}
		}},
		{"a file appeared, and was dated back", func(t *testing.T, f *resumableFixture, path string) {
			writeUnder(t, path, "untracked.txt", "new\n")
			ageCheckout(t, path, 20)
		}},
		{"a commit was made, and dated back", func(t *testing.T, f *resumableFixture, path string) {
			commitFile(t, path, "late.txt", "late\n", "late")
			ageCheckout(t, path, 20)
		}},
		{"an ignored file appeared, and was dated back", func(t *testing.T, f *resumableFixture, path string) {
			// Out of the tree, so that nothing but the ignored file itself is new: git reads this one
			// from the repository, not from the worktree.
			writeUnder(t, gitCommonDir(path), "info/exclude", ".env\n")
			writeUnder(t, path, ".env", "SECRET=only here\n")
			ageCheckout(t, path, 20)
			if status, err := git(path, "status", "--porcelain"); err != nil || status != "" {
				t.Errorf("the point of this case is a clean status, got %q (%v)", status, err)
			}
		}},
		{"a process moved in", func(t *testing.T, f *resumableFixture, path string) {
			cmd := exec.Command("sleep", "600")
			cmd.Dir = path
			startProcess(t, cmd)
			ageCheckout(t, path, 20)
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newResumableFixture(t)
			path := f.checkout(t, "sess-parked")
			reached := false
			f.set(func() {
				f.atSecondLook["sess-parked"] = func() {
					reached = true
					c.between(t, f, path)
				}
			})

			sweepOnFullDisk(f)

			if !reached {
				t.Fatal("the first look refused it, so this says nothing about the second")
			}
			requireCheckoutOnDisk(t, path, c.name)
		})
	}
}

// A commit in a half-deleted checkout would stage the deletions onto the branch, so none gets in while
// the checkout is being judged and removed. The fence comes down afterwards, whichever way that went.
func TestResumableSweepFencesOutACommitWhileItTakesTheCheckout(t *testing.T) {
	f := newResumableFixture(t)
	path := f.checkout(t, "sess-parked")
	reached, admittedDuring := false, false
	f.set(func() {
		f.atSecondLook["sess-parked"] = func() {
			reached = true
			release, _, admitted := f.pool.beginManualWorktreeOperation("sess-parked", nil, 0, false, "commit")
			admittedDuring = admitted
			if admitted {
				release()
			}
		}
	})

	sweepOnFullDisk(f)

	requireCheckoutReclaimed(t, path, "nothing else stood in its way")
	if !reached {
		t.Fatal("the sweep never reached its second look")
	}
	if admittedDuring {
		t.Fatal("a commit was admitted while the sweep held the checkout")
	}
	release, _, admitted := f.pool.beginManualWorktreeOperation("sess-parked", nil, 0, false, "commit")
	if !admitted {
		t.Fatal("the fence must come down with the sweep")
	}
	release()
}

// While a checkout is being removed its path reads as the whole checkout or as nothing, never as most
// of one: a session resumed over the remains would see its files missing, and a commit there would
// stage the deletions onto its branch.
func TestAReclaimedCheckoutIsNeverSeenHalfGoneAtItsPath(t *testing.T) {
	f := newResumableFixture(t)
	path := f.checkout(t, "sess-parked")
	ignoring(t, path, "dist/")
	var sample []string
	for i := 0; i < 3000; i++ {
		file := writeUnder(t, path, "dist/f"+strconv.Itoa(i)+".pad", "x")
		if i%50 == 0 {
			sample = append(sample, file)
		}
	}
	ageCheckout(t, path, 20)

	// Lstat only: anything holding the directory open is a process in it, and keeps the checkout.
	stop := make(chan struct{})
	torn := make(chan string, 1)
	go func() {
		for {
			select {
			case <-stop:
				torn <- ""
				return
			default:
			}
			for _, file := range sample {
				if _, err := os.Lstat(file); err != nil {
					// Gone along with the whole checkout is fine. Asked after the file, because the
					// path never comes back.
					if _, err := os.Lstat(path); err == nil {
						torn <- file
						return
					}
				}
			}
		}
	}()
	sweepOnFullDisk(f)
	close(stop)

	requireCheckoutReclaimed(t, path, "it qualifies")
	if file := <-torn; file != "" {
		t.Fatalf("%s was gone while the checkout still stood at its path", file)
	}
}

// What a stopped runner left under the other name goes at the next sweep, with no one asked and
// whatever the disk says, and nobody mistakes it for a session's.
func TestASweepRemovesWhatAStoppedSweepLeftBehind(t *testing.T) {
	f := newResumableFixture(t)
	leftover := filepath.Join(worktreesDir(), reclaimingCheckoutPrefix+"sess-stopped")
	writeUnder(t, leftover, "half/deleted.txt", "x\n")

	gcWorktrees(f.transport, map[string]bool{}, roomyDisk())

	requireCheckoutReclaimed(t, leftover, "a checkout renamed for removal is removed")
}

// A stop between the rename and the prune leaves git believing the checkout is still at its path, and
// `git worktree add` refuses that by name. The session must still come back.
func TestAReclaimedCheckoutComesBackAfterASweepStoppedHalfway(t *testing.T) {
	f := newResumableFixture(t)
	path := f.checkout(t, "sess-parked")
	mustGit(t, f.repo, "update-ref", reclaimedRefName("sess-parked"), "orbit/sess-parked")
	if err := os.Rename(path, filepath.Join(worktreesDir(), reclaimingCheckoutPrefix+"sess-parked")); err != nil {
		t.Fatal(err)
	}

	job := &ClaimedSession{SessionID: "sess-parked", Branch: "orbit/sess-parked"}
	if got := setupWorktree(job, f.repo); got != path || job.SourceRefusal != nil {
		t.Fatalf("setupWorktree = %q, refusal %+v", got, job.SourceRefusal)
	}
	requireCheckoutOnDisk(t, path, "it comes back")
}

// The same stop, seen by a run pinned to its project's line.
func TestAPinnedReclaimedCheckoutComesBackAfterASweepStoppedHalfway(t *testing.T) {
	f := newResumableFixture(t)
	path := f.checkout(t, "sess-parked")
	base := mustGit(t, f.repo, "rev-parse", baseRefName("sess-parked"))
	mustGit(t, f.repo, "update-ref", reclaimedRefName("sess-parked"), "orbit/sess-parked")
	if err := os.Rename(path, filepath.Join(worktreesDir(), reclaimingCheckoutPrefix+"sess-parked")); err != nil {
		t.Fatal(err)
	}

	job := &ClaimedSession{SessionID: "sess-parked", Branch: "orbit/sess-parked", Source: &SessionSource{State: sourceStatePinned, BaseSha: base}}
	if got := setupWorktree(job, f.repo); got != path || job.SourceRefusal != nil {
		t.Fatalf("setupWorktree = %q, refusal %+v", got, job.SourceRefusal)
	}
	requireCheckoutOnDisk(t, path, "it comes back")
}

// The same stop, seen by the door a cold supervisor wakes through.
func TestAClaimBringsACheckoutBackAfterASweepStoppedHalfway(t *testing.T) {
	f := newResumableFixture(t)
	path := f.checkout(t, "sess-parked")
	job := &ClaimedSession{SessionID: "sess-parked", Branch: "orbit/sess-parked",
		WT: &Worktree{Path: path, Branch: "orbit/sess-parked", RepoDir: f.repo, Session: "sess-parked"}}
	if _, added := f.pool.register(job, func() {}, false); !added {
		t.Fatal("register a cold supervisor")
	}
	mustGit(t, f.repo, "update-ref", reclaimedRefName("sess-parked"), "orbit/sess-parked")
	if err := os.Rename(path, filepath.Join(worktreesDir(), reclaimingCheckoutPrefix+"sess-parked")); err != nil {
		t.Fatal(err)
	}

	claim := &ClaimedSession{SessionID: "sess-parked", Branch: "orbit/sess-parked"}
	restoreAbsentCheckout(f.pool, claim)

	if claim.SourceRefusal != nil {
		t.Fatalf("refused: %+v", claim.SourceRefusal)
	}
	requireCheckoutOnDisk(t, path, "it comes back")
}

// A session forked from something other than the shared checkout's HEAD: this is every task on a
// project's line, and merge-base with HEAD names main's split point, not its fork. The diff of the
// revived session must show its own work and nothing of the line it forked from.
func TestAReclaimedCheckoutComesBackOnItsBranchWithTheRightBase(t *testing.T) {
	f := newResumableFixture(t)
	mustGit(t, f.repo, "branch", "project/line")
	lineCheckout := filepath.Join(t.TempDir(), "line")
	mustGit(t, f.repo, "worktree", "add", "-q", lineCheckout, "project/line")
	commitFile(t, lineCheckout, "line.txt", "the project's own commit\n", "project commit")
	mustGit(t, lineCheckout, "push", "-q", "origin", "project/line")
	fork := mustGit(t, lineCheckout, "rev-parse", "HEAD")

	path := f.checkoutFrom(t, f.repo, "sess-task", "project/line")
	tip := mustGit(t, path, "rev-parse", "HEAD")
	sweepOnFullDisk(f)
	requireCheckoutReclaimed(t, path, "it qualifies")

	// main has moved on as well by the time the session is resumed.
	commitFile(t, f.repo, "main-later.txt", "later\n", "main later")
	mustGit(t, f.repo, "push", "-q", "origin", "main")

	job := &ClaimedSession{SessionID: "sess-task", Branch: "orbit/sess-task"}
	execDir := setupWorktree(job, f.repo)

	if execDir != path || job.WT == nil || job.IsolationStatus != isoWorktree {
		t.Fatalf("execDir %q, WT %+v, isolation %q", execDir, job.WT, job.IsolationStatus)
	}
	if got := mustGit(t, path, "rev-parse", "HEAD"); got != tip {
		t.Fatalf("HEAD = %s, want the branch's tip %s", got, tip)
	}
	if got := mustGit(t, path, "symbolic-ref", "--short", "HEAD"); got != "orbit/sess-task" {
		t.Fatalf("HEAD is on %q", got)
	}
	if job.WT.BaseSha != fork {
		t.Fatalf("base = %s, want the fork on the project's line %s", job.WT.BaseSha, fork)
	}
	files := diffFiles(path, job.WT.BaseSha, "HEAD")
	if len(files) != 1 || files[0].Path != "sess-task.txt" {
		t.Fatalf("the diff must be the session's work alone, got %+v", files)
	}
}

// The same for a run pinned to its project's line.
func TestAReclaimedPinnedCheckoutKeepsTheBaseItHadOverThePin(t *testing.T) {
	f := newResumableFixture(t)
	mustGit(t, f.repo, "branch", "project/line")
	lineCheckout := filepath.Join(t.TempDir(), "line")
	mustGit(t, f.repo, "worktree", "add", "-q", lineCheckout, "project/line")
	commitFile(t, lineCheckout, "line.txt", "the project's own commit\n", "project commit")
	mustGit(t, lineCheckout, "push", "-q", "origin", "project/line")
	fork := mustGit(t, lineCheckout, "rev-parse", "HEAD")
	// The pin read here is older than the base the checkout came to have: a rebase forward heals the
	// base ref and does not move the pin.
	pin := mustGit(t, f.repo, "rev-parse", "main")

	path := f.checkoutFrom(t, f.repo, "sess-pinned", "project/line")
	sweepOnFullDisk(f)
	requireCheckoutReclaimed(t, path, "it qualifies")

	job := &ClaimedSession{SessionID: "sess-pinned", Branch: "orbit/sess-pinned", Source: &SessionSource{State: sourceStatePinned, BaseSha: pin}}
	execDir := setupWorktree(job, f.repo)

	if execDir != path || job.SourceRefusal != nil {
		t.Fatalf("execDir %q, refusal %+v", execDir, job.SourceRefusal)
	}
	if job.WT.BaseSha != fork {
		t.Fatalf("base = %s, want the one it had, %s, not the pin %s", job.WT.BaseSha, fork, pin)
	}
}

// A checkout that cannot come back ends the run with the reason. It must not run in the shared
// directory instead, where the agent's edits land in somebody else's checkout, and the fork point has
// to survive for the next try.
func TestAReclaimedCheckoutThatCannotComeBackRefusesTheRun(t *testing.T) {
	t.Run("a plain session", func(t *testing.T) {
		f := newResumableFixture(t)
		path := f.checkout(t, "sess-parked")
		base := mustGit(t, f.repo, "rev-parse", baseRefName("sess-parked"))
		sweepOnFullDisk(f)
		requireCheckoutReclaimed(t, path, "it qualifies")
		// git lets a branch be checked out in one place at a time, and the sweep left it free.
		mustGit(t, f.repo, "checkout", "-q", "orbit/sess-parked")

		job := &ClaimedSession{SessionID: "sess-parked", Branch: "orbit/sess-parked"}
		execDir := setupWorktree(job, f.repo)

		if execDir != "" || job.SourceRefusal == nil {
			t.Fatalf("execDir %q, refusal %+v: it ran somewhere other than its checkout", execDir, job.SourceRefusal)
		}
		if reason, _ := job.SourceRefusal.Detail["reason"].(string); !strings.Contains(reason, "could not be restored") {
			t.Fatalf("the refusal must say what happened, got %q", reason)
		}
		if got := mustGit(t, f.repo, "rev-parse", baseRefName("sess-parked")); got != base {
			t.Fatalf("the base ref must survive a failed revival, got %s want %s", got, base)
		}
	})
	t.Run("a pinned session", func(t *testing.T) {
		f := newResumableFixture(t)
		path := f.checkout(t, "sess-parked")
		base := mustGit(t, f.repo, "rev-parse", baseRefName("sess-parked"))
		sweepOnFullDisk(f)
		requireCheckoutReclaimed(t, path, "it qualifies")
		mustGit(t, f.repo, "checkout", "-q", "orbit/sess-parked")

		job := &ClaimedSession{SessionID: "sess-parked", Branch: "orbit/sess-parked", Source: &SessionSource{State: sourceStatePinned, BaseSha: base}}
		if execDir := setupWorktree(job, f.repo); execDir != "" || job.SourceRefusal == nil {
			t.Fatalf("execDir %q, refusal %+v", execDir, job.SourceRefusal)
		}
		if got := mustGit(t, f.repo, "rev-parse", baseRefName("sess-parked")); got != base {
			t.Fatalf("the base ref must survive a failed revival, got %s want %s", got, base)
		}
	})
}

// A restart registers a cold supervisor for every resting session. Making their checkouts there would
// undo the sweep on every restart, and date each one today, so the sweep could not come back for two
// weeks. It describes the checkout instead, and only for a checkout the sweep took.
func TestARestartDoesNotBringAReclaimedCheckoutBack(t *testing.T) {
	f := newResumableFixture(t)
	path := f.checkout(t, "sess-parked")
	fork := mustGit(t, f.repo, "rev-parse", baseRefName("sess-parked"))
	sweepOnFullDisk(f)
	requireCheckoutReclaimed(t, path, "it qualifies")

	job := &ClaimedSession{SessionID: "sess-parked", Branch: "orbit/sess-parked"}
	execDir, outlined := outlineReclaimedCheckout(job, f.repo)

	if !outlined || execDir != path {
		t.Fatalf("outlined %v at %q, want it at %q", outlined, execDir, path)
	}
	requireCheckoutReclaimed(t, path, "a restart must not make it")
	if job.WT == nil || job.WT.Path != path || job.WT.BaseSha != fork || job.WT.RepoDir == "" || job.IsolationStatus != isoWorktree {
		t.Fatalf("a supervisor must know the checkout it will stand on: %+v, isolation %q", job.WT, job.IsolationStatus)
	}
}

func TestARestartMakesEveryOtherMissingCheckoutAsItAlwaysHas(t *testing.T) {
	cases := map[string]func(t *testing.T, f *resumableFixture, job *ClaimedSession){
		"its checkout is on disk": func(t *testing.T, f *resumableFixture, job *ClaimedSession) {
			f.checkout(t, job.SessionID)
			// As a sweep leaves it when it stops between marking the checkout and moving it.
			mustGit(t, f.repo, "update-ref", reclaimedRefName(job.SessionID), job.Branch)
		},
		"nothing kept a base ref for it": func(t *testing.T, f *resumableFixture, job *ClaimedSession) {
			mustGit(t, f.repo, "branch", job.Branch)
			mustGit(t, f.repo, "update-ref", reclaimedRefName(job.SessionID), "HEAD")
		},
		"its branch is new": func(t *testing.T, f *resumableFixture, job *ClaimedSession) {},
		"its branch has gone, its base ref and mark have not": func(t *testing.T, f *resumableFixture, job *ClaimedSession) {
			mustGit(t, f.repo, "update-ref", baseRefName(job.SessionID), "HEAD")
			mustGit(t, f.repo, "update-ref", reclaimedRefName(job.SessionID), "HEAD")
		},
		"the sweep's mark is missing": func(t *testing.T, f *resumableFixture, job *ClaimedSession) {
			mustGit(t, f.repo, "branch", job.Branch)
			mustGit(t, f.repo, "update-ref", baseRefName(job.SessionID), "HEAD")
		},
		"it has no branch at all": func(t *testing.T, f *resumableFixture, job *ClaimedSession) {
			job.Branch = ""
		},
	}
	for name, prepare := range cases {
		t.Run(name, func(t *testing.T) {
			f := newResumableFixture(t)
			job := &ClaimedSession{SessionID: "sess-x", Branch: "orbit/sess-x"}
			prepare(t, f, job)
			if _, outlined := outlineReclaimedCheckout(job, f.repo); outlined {
				t.Fatalf("outlined a checkout the sweep did not take (%s)", name)
			}
		})
	}
}

// The door a resting session wakes through: its supervisor is registered, cold, and a claim arrives. The
// checkout has to be standing before the claim wakes the supervisor in it, whether that supervisor
// went cold here or came up cold after a restart.
func TestAReclaimedCheckoutComesBackBeforeAClaimWakesItsSupervisor(t *testing.T) {
	for _, restarted := range []bool{false, true} {
		name := "a supervisor gone cold here"
		if restarted {
			name = "a supervisor that came up cold after a restart"
		}
		t.Run(name, func(t *testing.T) {
			f := newResumableFixture(t)
			path := f.checkout(t, "sess-parked")
			tip := mustGit(t, path, "rev-parse", "HEAD")
			job := &ClaimedSession{SessionID: "sess-parked", Branch: "orbit/sess-parked"}
			if restarted {
				sweepOnFullDisk(f)
				requireCheckoutReclaimed(t, path, "it qualifies")
				if _, outlined := outlineReclaimedCheckout(job, f.repo); !outlined {
					t.Fatal("it must be outlined")
				}
			} else {
				job.WT = &Worktree{Path: path, Branch: job.Branch, RepoDir: f.repo, Session: job.SessionID,
					BaseSha: mustGit(t, f.repo, "rev-parse", baseRefName(job.SessionID))}
			}
			if _, added := f.pool.register(job, func() {}, false); !added {
				t.Fatal("register a cold supervisor")
			}
			if !restarted {
				sweepOnFullDisk(f)
				requireCheckoutReclaimed(t, path, "it qualifies")
			}

			claim := &ClaimedSession{SessionID: "sess-parked", Branch: "orbit/sess-parked"}
			restoreAbsentCheckout(f.pool, claim)

			if got := mustGit(t, path, "rev-parse", "HEAD"); got != tip {
				t.Fatalf("HEAD = %s, want %s", got, tip)
			}
			if got := mustGit(t, path, "symbolic-ref", "--short", "HEAD"); got != "orbit/sess-parked" {
				t.Fatalf("HEAD is on %q", got)
			}
			if _, ok := f.pool.activatePrepared(claim, nil); !ok {
				t.Fatal("the claim must wake its supervisor")
			}
			if claim.SourceRefusal != nil || claim.WT == nil || claim.WT.Path != path {
				t.Fatalf("refusal %+v, WT %+v", claim.SourceRefusal, claim.WT)
			}
			if f.pool.absentCheckout("sess-parked") != nil {
				t.Fatal("the checkout is back")
			}
		})
	}
}

// A supervisor's engine would fail to start in a directory that is not there, saying nothing of why.
// The claim carries the reason instead, and the run ends with it.
func TestAClaimOnACheckoutThatCannotComeBackCarriesTheReason(t *testing.T) {
	f := newResumableFixture(t)
	path := f.checkout(t, "sess-parked")
	job := &ClaimedSession{SessionID: "sess-parked", Branch: "orbit/sess-parked",
		WT: &Worktree{Path: path, Branch: "orbit/sess-parked", RepoDir: f.repo, Session: "sess-parked"}}
	if _, added := f.pool.register(job, func() {}, false); !added {
		t.Fatal("register a cold supervisor")
	}
	sweepOnFullDisk(f)
	requireCheckoutReclaimed(t, path, "it qualifies")
	mustGit(t, f.repo, "checkout", "-q", "orbit/sess-parked")

	claim := &ClaimedSession{SessionID: "sess-parked", Branch: "orbit/sess-parked"}
	restoreAbsentCheckout(f.pool, claim)
	if _, ok := f.pool.activatePrepared(claim, nil); !ok {
		t.Fatal("the claim must still reach its supervisor, to end the run")
	}

	if claim.SourceRefusal == nil {
		t.Fatal("the run must be refused")
	}
	if reason, _ := claim.SourceRefusal.Detail["reason"].(string); !strings.Contains(reason, "could not be restored") {
		t.Fatalf("the refusal must say what happened, got %q", reason)
	}
}

// A park checkpoint a resume is meant to undo, undone on a checkout that had to come back first.
func TestARestoredCheckoutUndoesAParkCheckpointAsAnyResumeDoes(t *testing.T) {
	f := newResumableFixture(t)
	path := f.checkout(t, "sess-parked")
	writeUnder(t, path, "in-progress.txt", "work in progress\n")
	mustGit(t, path, "add", ".")
	mustGit(t, path, "commit", "-m", "snapshot\n\n"+parkCheckpointTrailer+": sess-parked")
	mustGit(t, path, "push", "-q", "origin", "orbit/sess-parked")
	ageCheckout(t, path, 20)
	job := &ClaimedSession{SessionID: "sess-parked", Branch: "orbit/sess-parked",
		WT: &Worktree{Path: path, Branch: "orbit/sess-parked", RepoDir: f.repo, Session: "sess-parked"}}
	if _, added := f.pool.register(job, func() {}, false); !added {
		t.Fatal("register a cold supervisor")
	}
	sweepOnFullDisk(f)
	requireCheckoutReclaimed(t, path, "it qualifies")

	restoreAbsentCheckout(f.pool, &ClaimedSession{SessionID: "sess-parked", Branch: "orbit/sess-parked"})

	if got := mustGit(t, path, "status", "--porcelain"); !strings.Contains(got, "in-progress.txt") {
		t.Fatalf("the checkpoint's work must be back as a pending change, status:\n%s", got)
	}
}

// A session ended while its checkout was reclaimed: nothing was left in it to capture, so nothing may
// report that its capture failed, and its diff still has to reach the control plane, from the branch.
func TestEndingASessionWhoseCheckoutWasReclaimedReportsItsWorkFromTheBranch(t *testing.T) {
	f := newResumableFixture(t)
	path := f.checkout(t, "sess-parked")
	tip := mustGit(t, path, "rev-parse", "HEAD")
	base := mustGit(t, f.repo, "rev-parse", baseRefName("sess-parked"))
	sweepOnFullDisk(f)
	requireCheckoutReclaimed(t, path, "it qualifies")
	wt := &Worktree{Path: path, Branch: "orbit/sess-parked", BaseSha: base, RepoDir: f.repo, Session: "sess-parked"}

	var req RunFinalizeRequest
	finalizeWorktreeReport(&req, "sess-parked", wt, stCancelled)

	if req.CaptureError != "" {
		t.Fatalf("nothing failed to be captured, got %q", req.CaptureError)
	}
	if req.WorktreeDirty {
		t.Fatal("a checkout that is not there is not dirty")
	}
	if len(req.ChangedFiles) != 1 || req.ChangedFiles[0].Path != "sess-parked.txt" {
		t.Fatalf("its work is on its branch, got %+v", req.ChangedFiles)
	}
	if len(req.ChangedDiff) != 1 || !strings.Contains(req.ChangedDiff[0].Patch, "work by sess-parked") {
		t.Fatalf("the patch has to come with it, got %+v", req.ChangedDiff)
	}
	if req.BaseSha != base {
		t.Fatalf("base = %s, want %s", req.BaseSha, base)
	}
	req = RunFinalizeRequest{}
	finalizeWorktreeReport(&req, "sess-parked", wt, stSucceeded)
	if req.BranchSha != tip {
		t.Fatalf("a real end reports the branch's tip %s, got %s", tip, req.BranchSha)
	}
	requireCheckoutReclaimed(t, path, "ending it does not bring it back")
}

// Everything above acts on the sweep's mark. A checkout missing for any other reason, base ref or no base
// ref, goes on being what it was before the sweep could take one: an alarm at the end, a fresh checkout on
// the old base at a restart, the shared directory if that fails. There are such refs: this host held 56
// base refs with no checkout before any sweep had run.
func TestACheckoutMissingForAnyOtherReasonIsTreatedAsItAlwaysWas(t *testing.T) {
	prepare := func(t *testing.T) (*resumableFixture, string, *ClaimedSession) {
		f := newResumableFixture(t)
		path := f.checkout(t, "sess-other")
		mustGit(t, f.repo, "worktree", "remove", "--force", path)
		return f, path, &ClaimedSession{SessionID: "sess-other", Branch: "orbit/sess-other"}
	}
	t.Run("ending the session reports that its work was not captured", func(t *testing.T) {
		f, path, _ := prepare(t)
		wt := &Worktree{Path: path, Branch: "orbit/sess-other", BaseSha: mustGit(t, f.repo, "rev-parse", baseRefName("sess-other")), RepoDir: f.repo, Session: "sess-other"}
		var req RunFinalizeRequest
		finalizeWorktreeReport(&req, "sess-other", wt, stSucceeded)
		if req.CaptureError == "" {
			t.Fatal("whatever was in that checkout is gone with no record of it: this must not read as a clean end")
		}
	})
	t.Run("a restart makes it", func(t *testing.T) {
		f, _, job := prepare(t)
		if _, outlined := outlineReclaimedCheckout(job, f.repo); outlined {
			t.Fatal("outlined a checkout the sweep did not take")
		}
	})
	t.Run("a claim does not put it back behind the supervisor", func(t *testing.T) {
		f, path, job := prepare(t)
		job.WT = &Worktree{Path: path, Branch: job.Branch, RepoDir: f.repo, Session: job.SessionID}
		if _, added := f.pool.register(job, func() {}, false); !added {
			t.Fatal("register a cold supervisor")
		}
		restoreAbsentCheckout(f.pool, &ClaimedSession{SessionID: job.SessionID, Branch: job.Branch})
		requireCheckoutReclaimed(t, path, "only the sweep's own mark brings one back here")
	})
	t.Run("a revival works its base out from the shared checkout", func(t *testing.T) {
		f, path, job := prepare(t)
		mergeBase := mustGit(t, f.repo, "merge-base", "HEAD", "orbit/sess-other")
		mustGit(t, f.repo, "update-ref", baseRefName("sess-other"), mustGit(t, f.repo, "rev-parse", "orbit/sess-other"))
		if execDir := setupWorktree(job, f.repo); execDir != path {
			t.Fatalf("execDir = %q", execDir)
		}
		if job.WT.BaseSha != mergeBase {
			t.Fatalf("base = %s, want the merge-base %s it has always been", job.WT.BaseSha, mergeBase)
		}
	})
	t.Run("a revival that cannot add a checkout runs shared", func(t *testing.T) {
		f, _, job := prepare(t)
		mustGit(t, f.repo, "checkout", "-q", "orbit/sess-other")
		if execDir := setupWorktree(job, f.repo); execDir != f.repo || job.SourceRefusal != nil {
			t.Fatalf("execDir = %q, refusal %+v: this path must not have changed", execDir, job.SourceRefusal)
		}
	})
}

// The mark lasts exactly until the checkout is back, by every door.
func TestTheMarkGoesWhenTheCheckoutComesBack(t *testing.T) {
	requireNoMark := func(t *testing.T, f *resumableFixture, session string) {
		t.Helper()
		if out, err := git(f.repo, "rev-parse", "--verify", "--quiet", reclaimedRefName(session)); err == nil {
			t.Fatalf("the checkout is back and still marked reclaimed: %s", out)
		}
	}
	t.Run("a revival", func(t *testing.T) {
		f := newResumableFixture(t)
		f.checkout(t, "sess-parked")
		sweepOnFullDisk(f)
		setupWorktree(&ClaimedSession{SessionID: "sess-parked", Branch: "orbit/sess-parked"}, f.repo)
		requireNoMark(t, f, "sess-parked")
	})
	t.Run("a pinned revival", func(t *testing.T) {
		f := newResumableFixture(t)
		f.checkout(t, "sess-parked")
		base := mustGit(t, f.repo, "rev-parse", baseRefName("sess-parked"))
		sweepOnFullDisk(f)
		setupWorktree(&ClaimedSession{SessionID: "sess-parked", Branch: "orbit/sess-parked", Source: &SessionSource{State: sourceStatePinned, BaseSha: base}}, f.repo)
		requireNoMark(t, f, "sess-parked")
	})
	t.Run("a claim on a cold supervisor", func(t *testing.T) {
		f := newResumableFixture(t)
		path := f.checkout(t, "sess-parked")
		job := &ClaimedSession{SessionID: "sess-parked", Branch: "orbit/sess-parked",
			WT: &Worktree{Path: path, Branch: "orbit/sess-parked", RepoDir: f.repo, Session: "sess-parked"}}
		if _, added := f.pool.register(job, func() {}, false); !added {
			t.Fatal("register a cold supervisor")
		}
		sweepOnFullDisk(f)
		restoreAbsentCheckout(f.pool, &ClaimedSession{SessionID: "sess-parked", Branch: "orbit/sess-parked"})
		requireNoMark(t, f, "sess-parked")
	})
	t.Run("a sweep that could not move the checkout aside", func(t *testing.T) {
		f := newResumableFixture(t)
		path := f.checkout(t, "sess-parked")
		writeUnder(t, filepath.Join(worktreesDir(), reclaimingCheckoutPrefix+"sess-parked"), "in/the/way.txt", "x\n")
		sweepOnFullDisk(f)
		requireCheckoutOnDisk(t, path, "there was nowhere to move it")
		requireNoMark(t, f, "sess-parked")
	})
}

// `orbit resume` starts its CLI in the checkout, and a missing one used to end it with exit 1 and no word.
// It says what happened and what brings the checkout back, for every engine that opens in a terminal.
func TestResumeOnAReclaimedCheckoutSaysWhatHappenedAndWhatBringsItBack(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	const sessionID = "01a113f1-eec1-77dc-b73f-d222d66a53e5"
	checkout := filepath.Join(worktreesDir(), sessionID)
	meta := func(provider, workDir string) *sessionMeta {
		return &sessionMeta{Provider: provider, SessionUUID: "a068effa-91bd-4ef4-9949-cd7e5d095546",
			RuntimeSessionID: "a068effa-91bd-4ef4-9949-cd7e5d095546", WorkDir: workDir}
	}
	for _, workDir := range []string{checkout, filepath.Join(checkout, "src", "app")} {
		_, err := resumeCommand(sessionID, t.TempDir(), meta(providerClaude, workDir))
		if err == nil {
			t.Fatalf("resumed in %s, which is not there", workDir)
		}
		for _, want := range []string{"is not on this machine", workDir, "keeps its branch",
			"orbit session send " + publicID(sessionID) + " --message TEXT --resume-if-ended", "orbit resume " + publicID(sessionID)} {
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("the refusal must say %q, got: %v", want, err)
			}
		}
	}
	t.Run("a checkout that is there", func(t *testing.T) {
		if err := os.MkdirAll(checkout, 0o755); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.RemoveAll(checkout) })
		cmd, err := resumeCommand(sessionID, t.TempDir(), meta(providerClaude, checkout))
		if err != nil || cmd == nil || cmd.Dir != checkout {
			t.Fatalf("resume must go on as it did: cmd %v, err %v", cmd, err)
		}
	})
	t.Run("a directory that is no checkout of this session", func(t *testing.T) {
		for _, workDir := range []string{filepath.Join(t.TempDir(), "gone"), filepath.Join(worktreesDir(), sessionID+"-other")} {
			if cmd, err := resumeCommand(sessionID, t.TempDir(), meta(providerClaude, workDir)); err != nil || cmd == nil || cmd.Dir != workDir {
				t.Fatalf("%s is not this session's checkout, so this says nothing about it: cmd %v, err %v", workDir, cmd, err)
			}
		}
	})
}

// Asked of the source, as the file beside this one asks it: a later edit breaks these silently, and all
// anyone sees is a session that fails to start, or a disk that stays full, months on.
func TestTheRunLoopCallsEverySideOfTheResumableSweep(t *testing.T) {
	source, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(source)
	if got := strings.Count(body, "gcResumableCheckouts(t, pool, pressure)"); got != 2 {
		t.Errorf("the startup sweep and the claim loop's sweep must both run the second half, found %d calls", got)
	}
	restore := strings.Index(body, "restoreAbsentCheckout(pool, job)")
	activate := strings.Index(body, "pool.activatePrepared(job, stageCredential)")
	if restore < 0 || activate < 0 || restore > activate {
		t.Error("a checkout must come back before the claim wakes the supervisor that stands on it")
	}
	if !strings.Contains(body, "if !initiallyActive {\n\t\t\texecDir, outlined = outlineReclaimedCheckout(job, sessionExecDir(job.WorkDir))") {
		t.Error("a session registered cold must not make the checkout the sweep took")
	}
}
