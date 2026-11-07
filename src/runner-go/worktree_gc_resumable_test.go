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
//     wakes through (TestAReclaimedCheckout*);
//   - a restart makes no resting session's missing checkout, whatever took it, and the session's next claim
//     does (TestARestart*, TestAMissingCheckout*);
//   - when it runs: a look that found nothing waits an hour, one that could not run does not, and a sweep stops
//     between two checkouts once its budget is spent (TestResumableSweepWait*, TestResumableLook*,
//     TestResumableSweepBudget*).

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
	// atRequest runs on every question, with the sessions it names, before it is answered.
	atRequest func(ids []string)
	// alsoAnswer is what the reply calls resumable besides, asked or not.
	alsoAnswer []string
	// reports is every abandoned-checkout inventory this runner POSTed, newest last.
	reports []AbandonedCheckoutsRequest
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
	if r.URL.Path == "/api/runner/abandoned-checkouts" {
		var body AbandonedCheckoutsRequest
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.reports = append(f.reports, body)
		f.mu.Unlock()
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
		return
	}
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
	atRequest := f.atRequest
	f.mu.Unlock()
	if atRequest != nil {
		atRequest(req.IDs)
	}
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

// lastReport is the abandoned-checkout inventory the runner sent most recently.
func (f *resumableFixture) lastReport(t *testing.T) AbandonedCheckoutsRequest {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.reports) == 0 {
		t.Fatal("the runner sent no abandoned-checkout inventory")
	}
	return f.reports[len(f.reports)-1]
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
	if _, err := git(f.repo, "rev-parse", "--verify", absentRefName("sess-parked")); err != nil {
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
		// atTheSecondLook marks the one reason only the second look asks about, for what it costs.
		atTheSecondLook bool
		// onlyWithoutABudget marks a reason a storage budget's floor sets aside (underBudgetFloor): the two weeks
		// themselves, and a commit only the session's own branch has.
		onlyWithoutABudget bool
	}{
		{name: "a modified tracked file", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			writeUnder(t, path, "base.txt", "changed and not committed\n")
			ageCheckout(t, path, 20)
		}},
		{name: "a staged file", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			writeUnder(t, path, "staged.txt", "staged\n")
			mustGit(t, path, "add", "staged.txt")
			ageCheckout(t, path, 20)
		}},
		{name: "an untracked file", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			writeUnder(t, path, "scratch/untracked.txt", "only here\n")
			ageCheckout(t, path, 20)
		}},
		{name: "an untracked file its repository's config hides from git status", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			mustGit(t, f.repo, "config", "status.showUntrackedFiles", "no")
			writeUnder(t, path, "scratch/untracked.txt", "only here\n")
			ageCheckout(t, path, 20)
		}},
		{name: "a commit no remote has", onlyWithoutABudget: true, prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			commitFile(t, path, "unpushed.txt", "local\n", "unpushed")
			ageCheckout(t, path, 20)
		}},
		{name: "a file written within two weeks, content unchanged", onlyWithoutABudget: true, prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			ageCheckout(t, path, 20)
			now := time.Now().Add(-13 * 24 * time.Hour)
			if err := os.Chtimes(filepath.Join(path, session+".txt"), now, now); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "build output written within two weeks", onlyWithoutABudget: true, prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			ignoring(t, path, "dist/")
			ageCheckout(t, path, 20)
			writeUnder(t, path, "dist/deep/app.js", "a recent build is a recent use\n")
			// Only the file itself is new: its directories say nothing.
			ago := time.Now().Add(-20 * 24 * time.Hour)
			for _, dir := range []string{path, filepath.Join(path, "dist"), filepath.Join(path, "dist", "deep")} {
				_ = os.Chtimes(dir, ago, ago)
			}
		}},
		{name: "a file deleted within two weeks", onlyWithoutABudget: true, prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			ignoring(t, path, "dist/")
			writeUnder(t, path, "dist/deep/app.js", "a build\n")
			ageCheckout(t, path, 20)
			if err := os.Remove(filepath.Join(path, "dist", "deep", "app.js")); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "an ignored .env, however old", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			ignoring(t, path, ".env")
			writeUnder(t, path, ".env", "SECRET=only here\n")
			ageCheckout(t, path, 20)
		}},
		{name: "an ignored .env further down", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			commitAndPush(t, path, "src/web/index.txt", "tracked\n")
			ignoring(t, path, ".env")
			writeUnder(t, path, "src/web/.env", "SECRET=only here\n")
			ageCheckout(t, path, 20)
		}},
		{name: "an ignored report, however old", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			ignoring(t, path, "reports/")
			writeUnder(t, path, "reports/march/findings.md", "written by the session, kept nowhere else\n")
			ageCheckout(t, path, 20)
		}},
		{name: "an ignored report beside listed entries", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			ignoring(t, path, "node_modules/", "dist/", "*.report")
			writeUnder(t, path, "node_modules/x/i.js", "x\n")
			writeUnder(t, path, "dist/app.js", "x\n")
			writeUnder(t, path, "findings.report", "written by the session, kept nowhere else\n")
			ageCheckout(t, path, 20)
		}},
		{name: "an ignored report in a directory with a listed name that is not itself ignored", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			ignoring(t, path, "*.report")
			writeUnder(t, path, "build/findings.report", "written by the session, kept nowhere else\n")
			ageCheckout(t, path, 20)
		}},
		{name: "an ignored file git has to quote the name of", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			ignoring(t, path, "*.txt.old")
			writeUnder(t, path, "my notes.txt.old", "written by the session, kept nowhere else\n")
			ageCheckout(t, path, 20)
		}},
		{name: "a process working in it", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			dir := filepath.Dir(writeUnder(t, path, "sub/tracked.txt", "x\n"))
			commitAndPush(t, path, "sub/tracked.txt", "x\n")
			cmd := exec.Command("sleep", "600")
			cmd.Dir = dir
			startProcess(t, cmd)
			ageCheckout(t, path, 20)
		}},
		{name: "a process holding one of its files open from elsewhere", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
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
		{name: "a process running an executable from it", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
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
		{name: "a background shell of its session", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			f.pool.holdWorktreeForBackgroundJob(session, "toolu_A", "bei1")
		}},
		{name: "a job the runner hosts for its session", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			f.pool.holdWorktreeForRunnerJob(session, "bgj_A", "bgj_A")
		}},
		{name: "a job adopted for its session across a re-exec, with no supervisor yet", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			f.pool.keepHostlessJob(session, &bgJob{})
		}},
		{name: "a merge or commit under way", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			release, admitted := f.pool.beginHeartbeatWorktreeOperation(session, nil, 0, false)
			if !admitted {
				t.Fatal("admit an operation")
			}
			t.Cleanup(release)
		}},
		{name: "a turn running", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			job := manualWorktreePoolJob(session, "orbit/"+session)
			if _, added := f.pool.register(job, func() {}, true); !added {
				t.Fatal("register an active session")
			}
		}},
		{name: "a warm engine between turns", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
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
		{name: "a supervisor being retired", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			job := manualWorktreePoolJob(session, "orbit/"+session)
			if _, added := f.pool.register(job, func() {}, false); !added {
				t.Fatal("register a cold supervisor")
			}
			if _, detaching := f.pool.detachForTakeover(session); !detaching {
				t.Fatal("start retiring it")
			}
		}},
		{name: "a session the control plane says is on its way to an engine", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			f.set(func() { f.answers[session] = "kept" })
		}},
		{name: "a lock on the worktree", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			mustGit(t, path, "worktree", "lock", path)
		}},
		{name: "a merge half done", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			head := mustGit(t, path, "rev-parse", "HEAD")
			if err := os.WriteFile(filepath.Join(mustGit(t, path, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD"), []byte(head+"\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "a rebase half done", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			if err := os.MkdirAll(filepath.Join(mustGit(t, path, "rev-parse", "--absolute-git-dir"), "rebase-merge"), 0o755); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "a bisect half done", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			if err := os.WriteFile(filepath.Join(mustGit(t, path, "rev-parse", "--absolute-git-dir"), "BISECT_LOG"), []byte("x\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "a HEAD detached from any branch", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			mustGit(t, path, "checkout", "-q", "--detach")
			ageCheckout(t, path, 20)
		}},
		{name: "a HEAD moved to a branch of the agent's own", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			mustGit(t, path, "checkout", "-q", "-b", "feature/"+session)
			mustGit(t, path, "push", "-q", "origin", "feature/"+session)
			ageCheckout(t, path, 20)
		}},
		{name: "a HEAD moved to another orbit/ branch, pushed", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			mustGit(t, path, "checkout", "-q", "-b", "orbit/"+session+"-v2")
			commitFile(t, path, "later.txt", "later\n", "later work, on the other branch")
			mustGit(t, path, "push", "-q", "origin", "orbit/"+session+"-v2")
			ageCheckout(t, path, 20)
		}},
		{name: "no base ref to come back to", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			mustGit(t, f.repo, "update-ref", "-d", baseRefName(session))
		}},
		{name: "an edit under assume-unchanged, which git status does not report", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			mustGit(t, path, "update-index", "--assume-unchanged", "base.txt")
			writeUnder(t, path, "base.txt", "an edit git status will not show\n")
			if status := mustGit(t, path, "status", "--porcelain"); status != "" {
				t.Fatalf("the point of this case is a clean status, got %q", status)
			}
			ageCheckout(t, path, 20)
		}},
		{name: "an edit under skip-worktree, which git status does not report", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			mustGit(t, path, "update-index", "--skip-worktree", "base.txt")
			writeUnder(t, path, "base.txt", "an edit git status will not show\n")
			if status := mustGit(t, path, "status", "--porcelain"); status != "" {
				t.Fatalf("the point of this case is a clean status, got %q", status)
			}
			ageCheckout(t, path, 20)
		}},
		{name: "a clone with commits of its own under a dependency directory", atTheSecondLook: true, prepare: func(t *testing.T, f *resumableFixture, path, session string) {
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
		{name: "a mount left inside it", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
			ignoring(t, path, "node_modules/")
			ageCheckout(t, path, 20)
			standOnFakeProcessTable(t, filepath.Join(path, "node_modules"))
		}},
		{name: "a repository with commits of its own under an ignored directory", prepare: func(t *testing.T, f *resumableFixture, path, session string) {
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
		// Under a storage budget's floor the same reasons keep a checkout however recently it was written.
		for _, underABudget := range []bool{false, true} {
			if underABudget && c.onlyWithoutABudget {
				continue
			}
			name := c.name
			if underABudget {
				name = "under a storage budget's floor, " + name
			}
			t.Run(name, func(t *testing.T) {
				f := newResumableFixture(t)
				const session = "sess-kept"
				path := f.checkout(t, session)
				neighbour := f.checkout(t, "sess-neighbour")
				c.prepare(t, f, path, session)
				pressure := diskUnderTheFloor()
				if underABudget {
					// Both two days old, well inside the two weeks: what keeps this one is what it holds.
					ageCheckout(t, path, 2)
					ageCheckout(t, neighbour, 2)
					pressure = measureWorktreePressure(0, smallBudgetUnderItsFloor())
				}
				// The first look is a judgement of its own, not a draft of the second.
				secondLook := make(chan struct{}, 1)
				f.set(func() {
					f.atSecondLook[session] = func() {
						secondLook <- struct{}{}
						if !c.atTheSecondLook {
							t.Errorf("%s got past the first look", c.name)
						}
					}
				})

				gcResumableCheckouts(f.transport, f.pool, pressure)

				if c.atTheSecondLook && len(secondLook) == 0 {
					t.Errorf("%s is the second look's to find: the first look does not pay for it", c.name)
				}
				requireCheckoutOnDisk(t, path, c.name)
				requireCheckoutReclaimed(t, neighbour, "its neighbour goes, so the sweep did run")
				if _, err := git(path, "rev-parse", "--verify", "HEAD"); err != nil {
					t.Fatalf("the kept checkout must still be a checkout: %v", err)
				}
			})
		}
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

// A status git cannot give is no answer, even with every other git command working: a value git rejects
// in the repository's own status settings does exactly that.
func TestResumableSweepKeepsACheckoutGitCannotGiveAStatusFor(t *testing.T) {
	f := newResumableFixture(t)
	path := f.checkout(t, "sess-parked")
	mustGit(t, f.repo, "config", "status.showUntrackedFiles", "not-a-mode")
	if _, err := git(path, "status", "--porcelain"); err == nil {
		t.Fatal("the point of this case is a status that fails")
	}
	if _, err := git(path, "ls-files", "-v"); err != nil {
		t.Fatalf("and only that, but ls-files failed too: %v", err)
	}

	sweepOnFullDisk(f)

	requireCheckoutOnDisk(t, path, "git could not say what is in it")
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
	mustGit(t, f.repo, "update-ref", absentRefName("sess-parked"), "orbit/sess-parked")
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
	mustGit(t, f.repo, "update-ref", absentRefName("sess-parked"), "orbit/sess-parked")
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
	mustGit(t, f.repo, "update-ref", absentRefName("sess-parked"), "orbit/sess-parked")
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

// forkOffALine gives the repository a project's line one commit past main, and returns that commit.
func forkOffALine(t *testing.T, f *resumableFixture) string {
	t.Helper()
	mustGit(t, f.repo, "branch", "project/line")
	lineCheckout := filepath.Join(t.TempDir(), "line")
	mustGit(t, f.repo, "worktree", "add", "-q", lineCheckout, "project/line")
	commitFile(t, lineCheckout, "line.txt", "the project's own commit\n", "project commit")
	mustGit(t, lineCheckout, "push", "-q", "origin", "project/line")
	return mustGit(t, lineCheckout, "rev-parse", "HEAD")
}

// A session forked from something other than the shared checkout's HEAD: this is every task on a
// project's line, and merge-base with HEAD names main's split point, not its fork. The diff of the
// revived session must show its own work and nothing of the line it forked from.
func TestAReclaimedCheckoutComesBackOnItsBranchWithTheRightBase(t *testing.T) {
	f := newResumableFixture(t)
	fork := forkOffALine(t, f)

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
	fork := forkOffALine(t, f)
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
// weeks. It describes the checkout instead.
func TestARestartDoesNotBringAReclaimedCheckoutBack(t *testing.T) {
	f := newResumableFixture(t)
	path := f.checkout(t, "sess-parked")
	fork := mustGit(t, f.repo, "rev-parse", baseRefName("sess-parked"))
	sweepOnFullDisk(f)
	requireCheckoutReclaimed(t, path, "it qualifies")

	job := &ClaimedSession{SessionID: "sess-parked", Branch: "orbit/sess-parked"}
	execDir := f.pool.setupSupervisorCheckout(job, f.repo, false)

	if execDir != path {
		t.Fatalf("execDir %q, want %q", execDir, path)
	}
	requireCheckoutReclaimed(t, path, "a restart must not make it")
	if job.WT == nil || job.WT.Path != path || job.WT.BaseSha != fork || job.WT.RepoDir == "" || job.IsolationStatus != isoWorktree {
		t.Fatalf("a supervisor must know the checkout it will stand on: %+v, isolation %q", job.WT, job.IsolationStatus)
	}
}

// A restart measured on 2026-11-03 made 58 checkouts nobody had asked for, 67 GB of its disk, and on another
// host undid the removal of 135 by hand. What took the checkout has no say: the session is at rest, and its
// branch holds what the checkout would. A second restart finds it as the first left it.
func TestARestartLeavesAMissingCheckoutAwayHoweverItWent(t *testing.T) {
	ways := map[string]func(t *testing.T, f *resumableFixture, path string){
		"removed by hand, with git still believing in it": func(t *testing.T, f *resumableFixture, path string) {
			if err := os.RemoveAll(path); err != nil {
				t.Fatal(err)
			}
		},
		"removed through git": func(t *testing.T, f *resumableFixture, path string) {
			mustGit(t, f.repo, "worktree", "remove", "--force", path)
		},
		"taken by the sweep": func(t *testing.T, f *resumableFixture, path string) {
			sweepOnFullDisk(f)
		},
	}
	for name, remove := range ways {
		t.Run(name, func(t *testing.T) {
			f := newResumableFixture(t)
			fork := forkOffALine(t, f)
			path := f.checkoutFrom(t, f.repo, "sess-away", "project/line")
			remove(t, f, path)
			requireCheckoutReclaimed(t, path, "the case")

			for restart := 1; restart <= 2; restart++ {
				job := &ClaimedSession{SessionID: "sess-away", Branch: "orbit/sess-away"}
				execDir := f.pool.setupSupervisorCheckout(job, f.repo, false)
				settleSessionCheckout(job, execDir)

				requireCheckoutReclaimed(t, path, "a restart must not make it")
				if execDir != path || job.SourceRefusal != nil {
					t.Fatalf("restart %d: execDir %q, refusal %+v", restart, execDir, job.SourceRefusal)
				}
				if job.WT == nil || job.WT.Path != path || job.WT.Branch != "orbit/sess-away" || job.WT.Session != "sess-away" ||
					job.WT.RepoDir != mustGit(t, f.repo, "rev-parse", "--show-toplevel") || job.IsolationStatus != isoWorktree {
					t.Fatalf("restart %d: a supervisor must know the checkout it will stand on: %+v, isolation %q", restart, job.WT, job.IsolationStatus)
				}
				if job.WT.BaseSha != fork {
					t.Fatalf("restart %d: base = %s, want the fork %s", restart, job.WT.BaseSha, fork)
				}
				if _, err := git(f.repo, "rev-parse", "--verify", "--quiet", absentRefName("sess-away")); err != nil {
					t.Fatalf("restart %d: nothing says this checkout is known to be away: %v", restart, err)
				}
			}
		})
	}
}

// The fork point it will come back on, worked out the way a revival works it out.
func TestARestartReadsTheForkPointOfAMissingCheckoutFromTheBaseRefOrThePin(t *testing.T) {
	removeBaseRef := func(t *testing.T, f *resumableFixture) {
		mustGit(t, f.repo, "update-ref", "-d", baseRefName("sess-away"))
	}
	// moveMain gives main a commit outside the branch's history, and returns it.
	moveMain := func(t *testing.T, f *resumableFixture) string {
		commitFile(t, f.repo, "main-later.txt", "later\n", "main later")
		return mustGit(t, f.repo, "rev-parse", "main")
	}
	mergeBase := func(t *testing.T, f *resumableFixture) string {
		return mustGit(t, f.repo, "merge-base", "HEAD", "orbit/sess-away")
	}
	cases := []struct {
		name string
		// prepare returns the base wanted, and the pin of a pinned run, "" for a plain session.
		prepare func(t *testing.T, f *resumableFixture, fork string) (want, pin string)
	}{
		{name: "its base ref", prepare: func(t *testing.T, f *resumableFixture, fork string) (string, string) {
			return fork, ""
		}},
		{name: "no base ref: the merge-base with the branch", prepare: func(t *testing.T, f *resumableFixture, fork string) (string, string) {
			removeBaseRef(t, f)
			return mergeBase(t, f), ""
		}},
		{name: "a base ref outside the branch's history is healed", prepare: func(t *testing.T, f *resumableFixture, fork string) (string, string) {
			mustGit(t, f.repo, "update-ref", baseRefName("sess-away"), moveMain(t, f))
			return mergeBase(t, f), ""
		}},
		{name: "pinned: its base ref over the pin", prepare: func(t *testing.T, f *resumableFixture, fork string) (string, string) {
			return fork, mustGit(t, f.repo, "rev-parse", "main")
		}},
		{name: "pinned, no base ref: the pin", prepare: func(t *testing.T, f *resumableFixture, fork string) (string, string) {
			removeBaseRef(t, f)
			return fork, fork
		}},
		{name: "pinned: a base ref outside the branch's history gives way to the pin", prepare: func(t *testing.T, f *resumableFixture, fork string) (string, string) {
			mustGit(t, f.repo, "update-ref", baseRefName("sess-away"), moveMain(t, f))
			return fork, fork
		}},
		{name: "pinned, no base ref: a pin outside the branch's history is healed", prepare: func(t *testing.T, f *resumableFixture, fork string) (string, string) {
			removeBaseRef(t, f)
			pin := moveMain(t, f)
			return mergeBase(t, f), pin
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newResumableFixture(t)
			fork := forkOffALine(t, f)
			path := f.checkoutFrom(t, f.repo, "sess-away", "project/line")
			mustGit(t, f.repo, "worktree", "remove", "--force", path)
			want, pin := c.prepare(t, f, fork)
			job := &ClaimedSession{SessionID: "sess-away", Branch: "orbit/sess-away"}
			if pin != "" {
				job.Source = &SessionSource{State: sourceStatePinned, BaseSha: pin}
			}

			if execDir := f.pool.setupSupervisorCheckout(job, f.repo, false); execDir != path {
				t.Fatalf("execDir %q, refusal %+v", execDir, job.SourceRefusal)
			}

			requireCheckoutReclaimed(t, path, "a restart must not make it")
			if job.WT.BaseSha != want {
				t.Fatalf("base = %s, want %s", job.WT.BaseSha, want)
			}
			if got := mustGit(t, f.repo, "rev-parse", baseRefName("sess-away")); got != want {
				t.Fatalf("the base ref is %s, want %s: the next door reads it from there", got, want)
			}
		})
	}
}

// Nothing can record that the checkout is away, on the disk this is all about. The session still registers,
// and the log says what will read wrongly later.
func TestARestartSaysWhenItCouldNotRecordThatACheckoutIsAway(t *testing.T) {
	f := newResumableFixture(t)
	path := f.checkout(t, "sess-away")
	removeThroughGit(t, f, path)
	// A file where the ref's directory has to go.
	writeFile(t, filepath.Join(mustGit(t, f.repo, "rev-parse", "--absolute-git-dir"), "refs", "orbit-absent"), "in the way\n")

	job := &ClaimedSession{SessionID: "sess-away", Branch: "orbit/sess-away"}
	var execDir string
	logs := captureLogs(t, func() { execDir = f.pool.setupSupervisorCheckout(job, f.repo, false) })

	if execDir != path || job.WT == nil {
		t.Fatalf("execDir %q, WT %+v: it registers all the same", execDir, job.WT)
	}
	requireCheckoutReclaimed(t, path, "a restart must not make it")
	if !strings.Contains(logs, "could not record that its checkout is away") {
		t.Fatalf("the log must say so, got:\n%s", logs)
	}
}

// Everything setupCheckout does for any other session it goes on doing for one at rest: this is the one
// place that differs, and it is reached only with the branch there and nothing at the path.
func TestARestartGoesOnAsItDidWhereAnythingElseIsTheCase(t *testing.T) {
	type outcome struct {
		execDirIsCheckout, onDisk bool
		isolation                 string
	}
	cases := []struct {
		name    string
		prepare func(t *testing.T, f *resumableFixture, job *ClaimedSession)
		want    outcome
	}{
		{name: "its checkout is on disk", want: outcome{true, true, isoWorktree}, prepare: func(t *testing.T, f *resumableFixture, job *ClaimedSession) {
			f.checkout(t, job.SessionID)
			// As a sweep leaves it when it stops between marking the checkout and moving it.
			mustGit(t, f.repo, "update-ref", absentRefName(job.SessionID), job.Branch)
		}},
		{name: "its branch is new", want: outcome{true, true, isoWorktree}, prepare: func(t *testing.T, f *resumableFixture, job *ClaimedSession) {}},
		// With a mark saying its checkout is away, the branch comes back from the mark first, and the restart leaves
		// the checkout away as any other (TestABranchDeletedWhileItsCheckoutIsAwayComesBackWithIt).
		{name: "its branch has gone, its base ref has not, and nothing marks its checkout away", want: outcome{true, true, isoWorktree}, prepare: func(t *testing.T, f *resumableFixture, job *ClaimedSession) {
			mustGit(t, f.repo, "update-ref", baseRefName(job.SessionID), "HEAD")
		}},
		{name: "an empty directory stands at its path", want: outcome{true, true, isoWorktree}, prepare: func(t *testing.T, f *resumableFixture, job *ClaimedSession) {
			mustGit(t, f.repo, "branch", job.Branch)
			if err := os.MkdirAll(filepath.Join(worktreesDir(), job.SessionID), 0o755); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "an empty directory stands at a pinned run's path", want: outcome{true, true, isoWorktree}, prepare: func(t *testing.T, f *resumableFixture, job *ClaimedSession) {
			mustGit(t, f.repo, "branch", job.Branch)
			job.Source = &SessionSource{State: sourceStatePinned, BaseSha: mustGit(t, f.repo, "rev-parse", "HEAD")}
			if err := os.MkdirAll(filepath.Join(worktreesDir(), job.SessionID), 0o755); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "it has no branch at all", want: outcome{false, false, isoShared}, prepare: func(t *testing.T, f *resumableFixture, job *ClaimedSession) {
			job.Branch = ""
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newResumableFixture(t)
			job := &ClaimedSession{SessionID: "sess-x", Branch: "orbit/sess-x"}
			path := filepath.Join(worktreesDir(), job.SessionID)
			c.prepare(t, f, job)

			execDir := f.pool.setupSupervisorCheckout(job, f.repo, false)

			if (execDir == path) != c.want.execDirIsCheckout || isGitRepo(path) != c.want.onDisk || job.IsolationStatus != c.want.isolation {
				t.Fatalf("execDir %q, a checkout at %s: %v, isolation %q, refusal %+v", execDir, path, isGitRepo(path), job.IsolationStatus, job.SourceRefusal)
			}
		})
	}
}

// A pinned run's refusals are its own, and come before any of this.
func TestARestartStillRefusesAPinItCannotStandOn(t *testing.T) {
	prepare := func(t *testing.T) (*resumableFixture, string) {
		f := newResumableFixture(t)
		path := f.checkout(t, "sess-away")
		mustGit(t, f.repo, "worktree", "remove", "--force", path)
		return f, path
	}
	t.Run("a pin this repository lacks", func(t *testing.T) {
		f, path := prepare(t)
		job := &ClaimedSession{SessionID: "sess-away", Branch: "orbit/sess-away", Source: &SessionSource{State: sourceStatePinned, BaseSha: strings.Repeat("a", 40)}}
		execDir := f.pool.setupSupervisorCheckout(job, f.repo, false)
		if execDir != "" || job.SourceRefusal == nil || job.SourceRefusal.Code != sourceRefusalShaUnavailable {
			t.Fatalf("execDir %q, refusal %+v", execDir, job.SourceRefusal)
		}
		requireCheckoutReclaimed(t, path, "refused, and nothing was made")
	})
	t.Run("a prerequisite the pin does not hold", func(t *testing.T) {
		f, path := prepare(t)
		pin := mustGit(t, f.repo, "rev-parse", baseRefName("sess-away"))
		job := &ClaimedSession{SessionID: "sess-away", Branch: "orbit/sess-away", Source: &SessionSource{State: sourceStatePinned, BaseSha: pin, RequiredContains: []string{mustGit(t, f.repo, "rev-parse", "orbit/sess-away")}}}
		execDir := f.pool.setupSupervisorCheckout(job, f.repo, false)
		if execDir != "" || job.SourceRefusal == nil || job.SourceRefusal.Code != sourceRefusalDependencyNotLanded {
			t.Fatalf("execDir %q, refusal %+v", execDir, job.SourceRefusal)
		}
		requireCheckoutReclaimed(t, path, "refused, and nothing was made")
	})
}

// A managed runner does not stand a session on a repository its volume brought back broken, at rest or not,
// and that session's next claim carries the refusal. The sweep's mark is there because the door this used to
// be, for the sweep's own checkouts, came before that check.
func TestARestartOnAManagedRunnerStillRefusesADamagedRepository(t *testing.T) {
	withManagedInstance(t, "4", testManagedPodUID)
	v := newManagedVolume(t)
	mustGit(t, v.repo, "worktree", "remove", "--force", v.worktree)
	mustGit(t, v.repo, "update-ref", baseRefName("sess-1"), "main")
	mustGit(t, v.repo, "update-ref", absentRefName("sess-1"), "orbit/sess-1")
	writeFile(t, filepath.Join(v.gitDir, "refs", "heads", "main"), strings.Repeat("a", 40)+"\n")

	job := &ClaimedSession{SessionID: "sess-1", Branch: "orbit/sess-1"}
	execDir := newSessionPool(4).setupSupervisorCheckout(job, v.repo, false)

	if execDir != "" || job.SourceRefusal == nil || job.SourceRefusal.Code != repositoryDamagedRefusal {
		t.Fatalf("execDir %q, refusal %+v", execDir, job.SourceRefusal)
	}
	requireCheckoutReclaimed(t, v.worktree, "refused, and nothing was made")
}

// A checkout that stays away is not there to sync. One that comes back is.
func TestAManagedRunnerSyncsAMissingCheckoutWhenItComesBackAndNotBefore(t *testing.T) {
	withManagedInstance(t, "4", testManagedPodUID)
	v := newManagedVolume(t)
	syncs := recordVolumeSyncs(t)
	mustGit(t, v.repo, "worktree", "remove", "--force", v.worktree)

	pool := newSessionPool(4)
	job := &ClaimedSession{SessionID: "sess-1", Branch: "orbit/sess-1"}
	settleSessionCheckout(job, pool.setupSupervisorCheckout(job, v.repo, false))
	if syncs.count() != 0 {
		t.Fatalf("synced a checkout that is not there: %d", syncs.count())
	}
	if _, added := pool.register(job, func() {}, false); !added {
		t.Fatal("register a cold supervisor")
	}

	restoreAbsentCheckout(pool, &ClaimedSession{SessionID: "sess-1", Branch: "orbit/sess-1"})

	requireCheckoutOnDisk(t, v.worktree, "the claim brings it back")
	if syncs.count() != 1 {
		t.Fatalf("the checkout that came back must reach the volume: %d syncs", syncs.count())
	}
}

// A session that is not at rest needs its checkout now.
func TestAMissingCheckoutIsMadeForASessionThatIsNotAtRest(t *testing.T) {
	cases := map[string]func(f *resumableFixture) string{
		"a claim with no supervisor to wake": func(f *resumableFixture) string {
			return f.pool.setupSupervisorCheckout(&ClaimedSession{SessionID: "sess-away", Branch: "orbit/sess-away"}, f.repo, true)
		},
		"a job adopted across a self-update, whose supervisor starts at once": func(f *resumableFixture) string {
			f.pool.keepHostlessJob("sess-away", &bgJob{})
			return f.pool.setupSupervisorCheckout(&ClaimedSession{SessionID: "sess-away", Branch: "orbit/sess-away"}, f.repo, false)
		},
	}
	for name, start := range cases {
		t.Run(name, func(t *testing.T) {
			f := newResumableFixture(t)
			path := f.checkout(t, "sess-away")
			mustGit(t, f.repo, "worktree", "remove", "--force", path)

			if execDir := start(f); execDir != path {
				t.Fatalf("execDir = %q", execDir)
			}
			requireCheckoutOnDisk(t, path, name)
			if !isGitRepo(path) {
				t.Fatalf("%s is no checkout", path)
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
				if execDir := f.pool.setupSupervisorCheckout(job, f.repo, false); execDir != path {
					t.Fatalf("execDir = %q", execDir)
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

// The door a resting session wakes through, for a checkout nothing marked: the first restart found it gone, or
// it went from under a supervisor already registered. The session comes back on its branch, on its fork point,
// with its own work in the diff and nothing of the line it forked from.
func TestAMissingCheckoutComesBackWithTheSessionsNextClaim(t *testing.T) {
	cases := []struct {
		name string
		// remove takes the checkout; restartAfter has the supervisor registered with it gone, else before.
		remove       func(t *testing.T, f *resumableFixture, path string)
		restartAfter bool
		pinned       bool
	}{
		{name: "a restart found it removed by hand", restartAfter: true, remove: removeByHand},
		{name: "a restart found it removed through git", restartAfter: true, remove: removeThroughGit},
		{name: "a restart found a pinned run's removed by hand", restartAfter: true, pinned: true, remove: removeByHand},
		{name: "it went from under a cold supervisor", remove: removeByHand},
		{name: "a pinned run's went from under a cold supervisor", pinned: true, remove: removeThroughGit},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newResumableFixture(t)
			fork := forkOffALine(t, f)
			path := f.checkoutFrom(t, f.repo, "sess-away", "project/line")
			tip := mustGit(t, path, "rev-parse", "HEAD")
			job := &ClaimedSession{SessionID: "sess-away", Branch: "orbit/sess-away"}
			claim := &ClaimedSession{SessionID: "sess-away", Branch: "orbit/sess-away"}
			if c.pinned {
				job.Source = &SessionSource{State: sourceStatePinned, BaseSha: fork}
				claim.Source = job.Source
			}
			if c.restartAfter {
				c.remove(t, f, path)
			}
			if execDir := f.pool.setupSupervisorCheckout(job, f.repo, false); execDir != path {
				t.Fatalf("execDir %q, refusal %+v", execDir, job.SourceRefusal)
			}
			if _, added := f.pool.register(job, func() {}, false); !added {
				t.Fatal("register a cold supervisor")
			}
			if !c.restartAfter {
				c.remove(t, f, path)
			}
			// main has moved on as well by the time the session is resumed.
			commitFile(t, f.repo, "main-later.txt", "later\n", "main later")

			restoreAbsentCheckout(f.pool, claim)
			if _, ok := f.pool.activatePrepared(claim, nil); !ok {
				t.Fatal("the claim must wake its supervisor")
			}

			if claim.SourceRefusal != nil {
				t.Fatalf("refused: %+v", claim.SourceRefusal)
			}
			requireCheckoutOnDisk(t, path, "the claim brings it back")
			if got := mustGit(t, path, "rev-parse", "HEAD"); got != tip {
				t.Fatalf("HEAD = %s, want the branch's tip %s", got, tip)
			}
			if got := mustGit(t, path, "symbolic-ref", "--short", "HEAD"); got != "orbit/sess-away" {
				t.Fatalf("HEAD is on %q", got)
			}
			if claim.WT == nil || claim.WT.Path != path || claim.WT.BaseSha != fork {
				t.Fatalf("the supervisor must go on knowing its checkout and fork %s: %+v", fork, claim.WT)
			}
			if files := diffFiles(path, claim.WT.BaseSha, "HEAD"); len(files) != 1 || files[0].Path != "sess-away.txt" {
				t.Fatalf("the diff must be the session's work alone, got %+v", files)
			}
			if out, err := git(f.repo, "rev-parse", "--verify", "--quiet", absentRefName("sess-away")); err == nil {
				t.Fatalf("the checkout is back and still marked away: %s", out)
			}
		})
	}
}

func removeByHand(t *testing.T, f *resumableFixture, path string) {
	t.Helper()
	if err := os.RemoveAll(path); err != nil {
		t.Fatal(err)
	}
}

func removeThroughGit(t *testing.T, f *resumableFixture, path string) {
	t.Helper()
	mustGit(t, f.repo, "worktree", "remove", "--force", path)
}

// A claim is where a missing checkout is an alarm worth having: the run ends with the reason, and never runs
// anywhere else. Its supervisor has no other directory to give an engine, and git's refusal says why.
func TestAClaimOnAMissingCheckoutThatCannotComeBackEndsWithTheReason(t *testing.T) {
	f := newResumableFixture(t)
	path := f.checkout(t, "sess-away")
	removeThroughGit(t, f, path)
	job := &ClaimedSession{SessionID: "sess-away", Branch: "orbit/sess-away"}
	if execDir := f.pool.setupSupervisorCheckout(job, f.repo, false); execDir != path {
		t.Fatalf("execDir %q, refusal %+v", execDir, job.SourceRefusal)
	}
	if _, added := f.pool.register(job, func() {}, false); !added {
		t.Fatal("register a cold supervisor")
	}
	mustGit(t, f.repo, "checkout", "-q", "orbit/sess-away")

	claim := &ClaimedSession{SessionID: "sess-away", Branch: "orbit/sess-away"}
	restoreAbsentCheckout(f.pool, claim)
	if _, ok := f.pool.activatePrepared(claim, nil); !ok {
		t.Fatal("the claim must still reach its supervisor, to end the run")
	}

	if claim.SourceRefusal == nil || claim.SourceRefusal.Code != sourceRefusalWorktreeRequired {
		t.Fatalf("the run must be refused, got %+v", claim.SourceRefusal)
	}
	reason, _ := claim.SourceRefusal.Detail["reason"].(string)
	for _, want := range []string{"could not be restored", "orbit/sess-away"} {
		if !strings.Contains(reason, want) {
			t.Fatalf("the refusal must say %q, got %q", want, reason)
		}
	}
	if _, err := git(f.repo, "rev-parse", "--verify", "--quiet", absentRefName("sess-away")); err != nil {
		t.Fatalf("it is still away, and the mark says so: %v", err)
	}
}

// The branch comes from the claim: the control plane may have adopted another since the supervisor registered.
func TestAClaimRestoresTheCheckoutOnTheBranchItNames(t *testing.T) {
	prepare := func(t *testing.T) (*resumableFixture, string) {
		f := newResumableFixture(t)
		path := f.checkout(t, "sess-away")
		mustGit(t, f.repo, "branch", "orbit/adopted", "orbit/sess-away")
		job := &ClaimedSession{SessionID: "sess-away", Branch: "orbit/sess-away",
			WT: &Worktree{Path: path, Branch: "orbit/sess-away", RepoDir: f.repo, Session: "sess-away"}}
		if _, added := f.pool.register(job, func() {}, false); !added {
			t.Fatal("register a cold supervisor")
		}
		removeThroughGit(t, f, path)
		return f, path
	}
	cases := map[string]struct{ claimed, want string }{
		"a branch adopted since":                   {claimed: "orbit/adopted", want: "orbit/adopted"},
		"none named: the one its supervisor knows": {claimed: "", want: "orbit/sess-away"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			f, path := prepare(t)
			claim := &ClaimedSession{SessionID: "sess-away", Branch: c.claimed}
			restoreAbsentCheckout(f.pool, claim)
			if claim.SourceRefusal != nil {
				t.Fatalf("refused: %+v", claim.SourceRefusal)
			}
			if got := mustGit(t, path, "symbolic-ref", "--short", "HEAD"); got != c.want {
				t.Fatalf("HEAD is on %q, want %q", got, c.want)
			}
		})
	}
}

// A hand removal stopped halfway leaves a directory at the path, and an engine woken there works among the
// remains. It is not the session's checkout, so the claim treats it as gone: git makes one in a directory
// that is empty, and refuses one that is not, which ends the run with the reason.
func TestAClaimDoesNotTakeADirectoryForTheCheckout(t *testing.T) {
	prepare := func(t *testing.T) (*resumableFixture, string, *ClaimedSession) {
		f := newResumableFixture(t)
		path := f.checkout(t, "sess-away")
		job := &ClaimedSession{SessionID: "sess-away", Branch: "orbit/sess-away",
			WT: &Worktree{Path: path, Branch: "orbit/sess-away", RepoDir: f.repo, Session: "sess-away"}}
		if _, added := f.pool.register(job, func() {}, false); !added {
			t.Fatal("register a cold supervisor")
		}
		removeThroughGit(t, f, path)
		return f, path, &ClaimedSession{SessionID: "sess-away", Branch: "orbit/sess-away"}
	}
	t.Run("an empty one", func(t *testing.T) {
		f, path, claim := prepare(t)
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
		restoreAbsentCheckout(f.pool, claim)
		if claim.SourceRefusal != nil || !isGitRepo(path) {
			t.Fatalf("refusal %+v, a checkout at %s: %v", claim.SourceRefusal, path, isGitRepo(path))
		}
		if got := mustGit(t, path, "symbolic-ref", "--short", "HEAD"); got != "orbit/sess-away" {
			t.Fatalf("HEAD is on %q", got)
		}
	})
	t.Run("one with something left in it", func(t *testing.T) {
		f, path, claim := prepare(t)
		left := writeUnder(t, path, "left/behind.txt", "x\n")
		restoreAbsentCheckout(f.pool, claim)
		if _, ok := f.pool.activatePrepared(claim, nil); !ok {
			t.Fatal("the claim must still reach its supervisor, to end the run")
		}
		if claim.SourceRefusal == nil || claim.SourceRefusal.Code != sourceRefusalWorktreeRequired {
			t.Fatalf("no engine may start among the remains, refusal %+v", claim.SourceRefusal)
		}
		if _, err := os.Stat(left); err != nil {
			t.Fatalf("what was left there is not this runner's to remove: %v", err)
		}
	})
	t.Run("a real checkout is left alone", func(t *testing.T) {
		f := newResumableFixture(t)
		path := f.checkout(t, "sess-here")
		job := &ClaimedSession{SessionID: "sess-here", Branch: "orbit/sess-here",
			WT: &Worktree{Path: path, Branch: "orbit/sess-here", RepoDir: f.repo, Session: "sess-here"}}
		if _, added := f.pool.register(job, func() {}, false); !added {
			t.Fatal("register a cold supervisor")
		}
		if f.pool.absentCheckout("sess-here") != nil {
			t.Fatal("it is standing")
		}
	})
}

// A session ended while its checkout stayed away after a restart: nothing was lost at that moment, because
// nothing was in the checkout when the restart found it gone, and before this change that restart would have
// made it, and the end found nothing to capture. Its work is on its branch.
func TestEndingASessionAtRestWhoseCheckoutStayedAwayIsNoAlarm(t *testing.T) {
	f := newResumableFixture(t)
	fork := forkOffALine(t, f)
	path := f.checkoutFrom(t, f.repo, "sess-away", "project/line")
	removeByHand(t, f, path)
	job := &ClaimedSession{SessionID: "sess-away", Branch: "orbit/sess-away"}
	if execDir := f.pool.setupSupervisorCheckout(job, f.repo, false); execDir != path {
		t.Fatalf("execDir %q, isolation %q", execDir, job.IsolationStatus)
	}

	var req RunFinalizeRequest
	finalizeWorktreeReport(&req, "sess-away", job.WT, stCancelled)

	if req.CaptureError != "" {
		t.Fatalf("nothing failed to be captured, got %q", req.CaptureError)
	}
	if len(req.ChangedFiles) != 1 || req.ChangedFiles[0].Path != "sess-away.txt" || req.BaseSha != fork {
		t.Fatalf("its work is on its branch, against its fork %s: %+v, base %s", fork, req.ChangedFiles, req.BaseSha)
	}
	requireCheckoutReclaimed(t, path, "ending it does not bring it back")
}

// A session with no supervisor comes back by setupWorktree. The base ref is the fork point there too, whatever
// took the checkout, and the one thing that stays an alarm at the end is a checkout gone from under a
// supervisor that stood on it with nothing to say why: there are such base refs, 56 on this host before any
// sweep had run, and a hand may have taken work with it.
func TestACheckoutMissingForAnyOtherReason(t *testing.T) {
	prepare := func(t *testing.T) (*resumableFixture, string, *ClaimedSession) {
		f := newResumableFixture(t)
		path := f.checkout(t, "sess-other")
		removeThroughGit(t, f, path)
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
	t.Run("a revival forks from the base ref over the shared checkout", func(t *testing.T) {
		f := newResumableFixture(t)
		fork := forkOffALine(t, f)
		path := f.checkoutFrom(t, f.repo, "sess-other", "project/line")
		removeThroughGit(t, f, path)
		job := &ClaimedSession{SessionID: "sess-other", Branch: "orbit/sess-other"}
		if execDir := setupWorktree(job, f.repo); execDir != path {
			t.Fatalf("execDir = %q", execDir)
		}
		if job.WT.BaseSha != fork {
			t.Fatalf("base = %s, want the fork %s", job.WT.BaseSha, fork)
		}
	})
	t.Run("a revival with no base ref works it out from the shared checkout", func(t *testing.T) {
		f, path, job := prepare(t)
		mergeBase := mustGit(t, f.repo, "merge-base", "HEAD", "orbit/sess-other")
		mustGit(t, f.repo, "update-ref", "-d", baseRefName("sess-other"))
		if execDir := setupWorktree(job, f.repo); execDir != path {
			t.Fatalf("execDir = %q", execDir)
		}
		if job.WT.BaseSha != mergeBase {
			t.Fatalf("base = %s, want the merge-base %s", job.WT.BaseSha, mergeBase)
		}
	})
	t.Run("a revival after a removal git did not hear about", func(t *testing.T) {
		for _, pinned := range []bool{false, true} {
			f := newResumableFixture(t)
			path := f.checkout(t, "sess-other")
			base := mustGit(t, f.repo, "rev-parse", baseRefName("sess-other"))
			removeByHand(t, f, path)
			job := &ClaimedSession{SessionID: "sess-other", Branch: "orbit/sess-other"}
			if pinned {
				job.Source = &SessionSource{State: sourceStatePinned, BaseSha: base}
			}
			if execDir := setupWorktree(job, f.repo); execDir != path || job.SourceRefusal != nil {
				t.Fatalf("pinned %v: execDir %q, refusal %+v", pinned, execDir, job.SourceRefusal)
			}
			requireCheckoutOnDisk(t, path, "it comes back")
		}
	})
	t.Run("a revival that cannot add a checkout is refused, and keeps its base ref", func(t *testing.T) {
		for _, pinned := range []bool{false, true} {
			f, _, job := prepare(t)
			base := mustGit(t, f.repo, "rev-parse", baseRefName("sess-other"))
			if pinned {
				job.Source = &SessionSource{State: sourceStatePinned, BaseSha: base}
			}
			mustGit(t, f.repo, "checkout", "-q", "orbit/sess-other")
			if execDir := setupWorktree(job, f.repo); execDir != "" || job.SourceRefusal == nil || job.SourceRefusal.Code != sourceRefusalWorktreeRequired {
				t.Fatalf("pinned %v: execDir %q, refusal %+v: it ran somewhere other than its checkout", pinned, execDir, job.SourceRefusal)
			}
			if job.IsolationStatus == isoSharedNoGit {
				t.Fatalf("pinned %v: reported as running shared", pinned)
			}
			if got := mustGit(t, f.repo, "rev-parse", baseRefName("sess-other")); got != base {
				t.Fatalf("pinned %v: the base ref must survive, got %s want %s", pinned, got, base)
			}
		}
	})
	// A run taking over the branch of the run before it never had a checkout, so nothing of its own is being
	// restored, and it may not stand in that run's. It runs in the workspace as it always did, or a pinned one
	// not at all, and leaves no base ref behind to say it ever had a checkout.
	t.Run("a run taking over a branch another run's checkout still holds", func(t *testing.T) {
		for _, pinned := range []bool{false, true} {
			f := newResumableFixture(t)
			earlier := f.checkout(t, "sess-earlier")
			job := &ClaimedSession{SessionID: "sess-later", Branch: "orbit/sess-earlier"}
			if pinned {
				job.Source = &SessionSource{State: sourceStatePinned, BaseSha: mustGit(t, earlier, "rev-parse", "HEAD")}
			}
			execDir := setupWorktree(job, f.repo)
			if pinned {
				if execDir != "" || job.SourceRefusal == nil {
					t.Fatalf("pinned: execDir %q, refusal %+v", execDir, job.SourceRefusal)
				}
			} else if execDir != f.repo || job.SourceRefusal != nil || job.IsolationStatus != isoSharedNoGit {
				t.Fatalf("execDir %q, refusal %+v, isolation %q: this path did not change", execDir, job.SourceRefusal, job.IsolationStatus)
			}
			if out, err := git(f.repo, "rev-parse", "--verify", "--quiet", baseRefName("sess-later")); err == nil {
				t.Fatalf("pinned %v: a base ref for a session that never had a checkout: %s", pinned, out)
			}
			requireCheckoutOnDisk(t, earlier, "that run's checkout is not touched")
		}
	})
	t.Run("a new branch that cannot get a checkout leaves no base ref behind", func(t *testing.T) {
		for _, pinned := range []bool{false, true} {
			f := newResumableFixture(t)
			job := &ClaimedSession{SessionID: "sess-new", Branch: "orbit/sess-new"}
			if pinned {
				job.Source = &SessionSource{State: sourceStatePinned, BaseSha: mustGit(t, f.repo, "rev-parse", "HEAD")}
			}
			writeUnder(t, filepath.Join(worktreesDir(), "sess-new"), "in/the/way.txt", "x\n")
			setupWorktree(job, f.repo)
			if out, err := git(f.repo, "rev-parse", "--verify", "--quiet", baseRefName("sess-new")); err == nil {
				t.Fatalf("pinned %v: a base ref with no branch and no checkout: %s", pinned, out)
			}
		}
	})
	t.Run("a new branch that cannot get a checkout still runs shared", func(t *testing.T) {
		f := newResumableFixture(t)
		job := &ClaimedSession{SessionID: "sess-new", Branch: "orbit/sess-new"}
		writeUnder(t, filepath.Join(worktreesDir(), "sess-new"), "in/the/way.txt", "x\n")
		if execDir := setupWorktree(job, f.repo); execDir != f.repo || job.SourceRefusal != nil || job.IsolationStatus != isoSharedNoGit {
			t.Fatalf("execDir %q, refusal %+v, isolation %q: this path did not change", execDir, job.SourceRefusal, job.IsolationStatus)
		}
	})
}

// The mark lasts exactly until the checkout is back, by every door.
func TestTheMarkGoesWhenTheCheckoutComesBack(t *testing.T) {
	requireNoMark := func(t *testing.T, f *resumableFixture, session string) {
		t.Helper()
		if out, err := git(f.repo, "rev-parse", "--verify", "--quiet", absentRefName(session)); err == nil {
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

const (
	resumableWaitLine   = "not looking again until "
	resumableBudgetLine = "gc: stopping this sweep of resumable checkouts"
)

// resumableSchedule drives the second half the way the run loop does, on a clock the test moves. The rule's two
// weeks go by the real clock, so ageCheckout still means what it says.
type resumableSchedule struct {
	*resumableFixture
	t       *testing.T
	clock   *fakePoolClock
	sweeper worktreeSweeper
}

func newResumableSchedule(t *testing.T) *resumableSchedule {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	f := newResumableFixture(t)
	clock := newFakePoolClock()
	f.pool = newSessionPoolWithClock(4, clock)
	return &resumableSchedule{resumableFixture: f, t: t, clock: clock}
}

// sweepAfter moves the clock on and runs the second half on this reading. It answers what that logged, and whether
// it looked: the first thing a look does is ask the control plane, so a schedule with no checkout at all is no use.
func (s *resumableSchedule) sweepAfter(d time.Duration, pressure worktreeGCPressure) (string, bool) {
	s.t.Helper()
	s.clock.Advance(d)
	asked := s.queryCount()
	logs := captureLogs(s.t, func() { s.sweeper.sweepResumable(s.transport, s.pool, pressure, false) })
	return logs, s.queryCount() != asked
}

// checkoutTheRuleKeeps is a checkout every look reads and none takes: it holds a commit no remote has.
func (s *resumableSchedule) checkoutTheRuleKeeps(session string) string {
	s.t.Helper()
	path := s.checkout(s.t, session)
	commitFile(s.t, path, "unpushed.txt", "local\n", "unpushed")
	ageCheckout(s.t, path, 20)
	return path
}

// checkoutAged is a checkout that can go, last written this many days ago.
func (s *resumableSchedule) checkoutAged(session string, days int) string {
	s.t.Helper()
	path := s.checkout(s.t, session)
	ageCheckout(s.t, path, days)
	return path
}

// startAWait is a look that finds nothing, and the wait it starts.
func (s *resumableSchedule) startAWait() {
	s.t.Helper()
	logs, looked := s.sweepAfter(0, diskUnderTheFloor())
	if !looked {
		s.t.Fatal("the sweep did not look")
	}
	if !strings.Contains(logs, resumableWaitLine) {
		s.t.Fatalf("a look that found nothing starts a wait and says so, got:\n%s", logs)
	}
}

// requireALookFindingNothingStartsAWait ends a case in which no wait started: the next look, which has nothing
// left to find, does start one, and the sweep after that does not look. So what kept the wait away in that case was
// what the case says, and not that nothing here ever waits.
func (s *resumableSchedule) requireALookFindingNothingStartsAWait() {
	s.t.Helper()
	logs, looked := s.sweepAfter(worktreeGCInterval, diskUnderTheFloor())
	if !looked {
		s.t.Fatal("no wait had started, so a look was due")
	}
	if !strings.Contains(logs, resumableWaitLine) {
		s.t.Fatalf("this look found nothing and should have started a wait, got:\n%s", logs)
	}
	if _, looked := s.sweepAfter(worktreeGCInterval, diskUnderTheFloor()); looked {
		s.t.Fatal("the sweep after a look that found nothing looked again")
	}
}

// removalsTaking is a disk that stays under its floor, read by a sweep right after every removal. So that is when
// the clock moves on by what the checkout that has just gone cost.
func (s *resumableSchedule) removalsTaking(costs map[string]time.Duration) worktreeGCPressure {
	var read func() worktreeGCPressure
	read = func() worktreeGCPressure {
		for path, cost := range costs {
			if _, err := os.Stat(path); os.IsNotExist(err) {
				s.clock.Advance(cost)
				delete(costs, path)
			}
		}
		reading := diskUnderTheFloor()
		reading.reread = read
		return reading
	}
	return read()
}

// A host with nothing to take stays under its floor: one look, then an hour without one, down to the second, so
// that what a look would find stays until the hour is up.
func TestResumableSweepWaitsAnHourAfterALookThatFoundNothing(t *testing.T) {
	s := newResumableSchedule(t)
	kept := s.checkoutTheRuleKeeps("sess-kept")
	// The hour runs from when the look ended, however long it took.
	s.set(func() { s.atRequest = func([]string) { s.clock.Advance(30 * time.Second) } })

	logs, looked := s.sweepAfter(0, diskUnderTheFloor())

	s.set(func() { s.atRequest = nil })
	if !looked {
		t.Fatal("the first sweep looks")
	}
	requireCheckoutOnDisk(t, kept, "the rule keeps it")
	want := resumableWaitLine + s.clock.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	if !strings.Contains(logs, want) || strings.Count(logs, "\n") != 1 {
		t.Fatalf("one line, saying until when (%q), got:\n%s", want, logs)
	}

	later := s.checkoutAged("sess-later", 20)
	for elapsed := worktreeGCInterval; elapsed < time.Hour; elapsed += worktreeGCInterval {
		logs, looked := s.sweepAfter(worktreeGCInterval, diskUnderTheFloor())
		if looked || logs != "" {
			t.Fatalf("%s into the wait it looked (%v), or logged:\n%s", elapsed, looked, logs)
		}
	}
	if _, looked := s.sweepAfter(4*time.Minute+59*time.Second, diskUnderTheFloor()); looked {
		t.Fatal("it looked a second before the hour was up")
	}
	requireCheckoutOnDisk(t, later, "nothing looked for an hour")

	if _, looked := s.sweepAfter(time.Second, diskUnderTheFloor()); !looked {
		t.Fatal("the hour is up, and it did not look")
	}
	requireCheckoutReclaimed(t, later, "the first look after the hour finds it")
	s.requireALookFindingNothingStartsAWait()
}

// A wait is only for a disk that stays short. Room on it ends the wait: nothing happens while there is room, as
// ever, and the next time it runs short the sweep looks at once.
func TestResumableSweepWaitEndsOnceTheDiskIsBackAboveTheFloor(t *testing.T) {
	stale := diskUnderTheFloor()
	stale.reread = roomyDisk
	for name, reading := range map[string]worktreeGCPressure{
		"room on the disk":              roomyDisk(),
		"exactly at the floor":          {freeBytes: 4096 * 1024 * 1024, measured: true, floorMb: 4096},
		"no floor any more":             {freeBytes: 0, measured: true, floorMb: 0},
		"the first half has just freed": stale,
	} {
		t.Run(name, func(t *testing.T) {
			s := newResumableSchedule(t)
			s.checkoutTheRuleKeeps("sess-kept")
			s.startAWait()
			later := s.checkoutAged("sess-later", 20)

			logs, looked := s.sweepAfter(worktreeGCInterval, reading)

			if looked || logs != "" {
				t.Fatalf("with no need of a look it looked (%v), or logged:\n%s", looked, logs)
			}
			requireCheckoutOnDisk(t, later, name)

			if _, looked := s.sweepAfter(worktreeGCInterval, diskUnderTheFloor()); !looked {
				t.Fatal("the disk came back above its floor, which ends the wait, and the sweep did not look")
			}
			requireCheckoutReclaimed(t, later, "short again, with no wait in the way")
		})
	}
}

// Anything short of room on the disk leaves the wait where it is. A reading that failed says nothing about the disk,
// and the run loop's reading is taken before the first half: the wait goes by a fresh one.
func TestResumableSweepWaitStandsWithoutRoomOnTheDisk(t *testing.T) {
	failedAtStart := worktreeGCPressure{measured: false, floorMb: 4096}
	failsWhenReadAgain := roomyDisk()
	failsWhenReadAgain.reread = func() worktreeGCPressure { return failedAtStart }
	shortWhenReadAgain := roomyDisk()
	shortWhenReadAgain.reread = diskUnderTheFloor
	for name, reading := range map[string]worktreeGCPressure{
		"a reading that failed":         failedAtStart,
		"a fresh reading that failed":   failsWhenReadAgain,
		"a fresh reading, still short":  shortWhenReadAgain,
		"a reading that is still short": diskUnderTheFloor(),
	} {
		t.Run(name, func(t *testing.T) {
			s := newResumableSchedule(t)
			s.checkoutTheRuleKeeps("sess-kept")
			s.startAWait()
			later := s.checkoutAged("sess-later", 20)

			if _, looked := s.sweepAfter(worktreeGCInterval, reading); looked {
				t.Fatal("it looked during the wait")
			}
			if _, looked := s.sweepAfter(worktreeGCInterval, diskUnderTheFloor()); looked {
				t.Fatalf("%s ended the wait", name)
			}
			requireCheckoutOnDisk(t, later, name)
		})
	}
}

// The wait is in memory, and what starts a runner starts with none.
func TestResumableSweepWaitIsForgottenByARestart(t *testing.T) {
	s := newResumableSchedule(t)
	s.checkoutTheRuleKeeps("sess-kept")
	s.startAWait()
	later := s.checkoutAged("sess-later", 20)
	if _, looked := s.sweepAfter(worktreeGCInterval, diskUnderTheFloor()); looked {
		t.Fatal("it looked during the wait")
	}

	s.sweeper = worktreeSweeper{interval: worktreeGCInterval, armed: true}

	if _, looked := s.sweepAfter(0, diskUnderTheFloor()); !looked {
		t.Fatal("a restart looks at once")
	}
	requireCheckoutReclaimed(t, later, "a restart forgot the wait")
}

// The wait is the second half's. Over an hour of laps with a wait in force the first half runs every five minutes,
// on its own schedule, and takes what is its to take.
func TestResumableSweepWaitLeavesTheFirstHalfItsFiveMinutes(t *testing.T) {
	if worktreeGCInterval != 5*time.Minute {
		t.Fatalf("the first half's interval is %s, and it keeps five minutes", worktreeGCInterval)
	}
	s := newResumableSchedule(t)
	s.checkoutTheRuleKeeps("sess-kept")
	s.sweeper = worktreeSweeper{interval: worktreeGCInterval, armed: true}
	var finished string
	laps, looks := 0, 0
	start := s.clock.Now()
	for s.clock.Now().Before(start.Add(time.Hour)) {
		if s.sweeper.due(s.clock.Now()) {
			laps++
			gcWorktrees(s.transport, s.pool.ids(), diskUnderTheFloor())
			if _, looked := s.sweepAfter(0, diskUnderTheFloor()); looked {
				looks++
			}
			if laps == 3 {
				finished = s.checkout(t, "sess-finished")
				s.set(func() { delete(s.answers, "sess-finished") })
			}
			if laps == 4 {
				requireCheckoutReclaimed(t, finished, "the first half takes a finished session's checkout during a wait")
			}
		}
		s.clock.Advance(worktreeGCInterval / 2)
	}
	if laps != 12 {
		t.Fatalf("%d sweeps of the first half in an hour, want 12", laps)
	}
	if looks != 1 {
		t.Fatalf("the second half looked %d times in that hour, want the one that started the wait", looks)
	}
}

// A look that could not run says nothing about what can go, so the next sweep looks, and takes what it finds.
func TestResumableLookThatCouldNotRunStartsNoWait(t *testing.T) {
	const session = "sess-parked"
	blind := func(t *testing.T) func() {
		previous := procDir
		procDir = filepath.Join(t.TempDir(), "no-proc")
		t.Cleanup(func() { procDir = previous })
		return func() { procDir = previous }
	}
	cases := []struct {
		name string
		// inTheWay stands in the way of this one look, and answers what clears it.
		inTheWay func(t *testing.T, s *resumableSchedule, path string) func()
		// says is what the log has to show that it was this and nothing else, where there is a line for it.
		says string
	}{
		{
			name: "the first question failed",
			inTheWay: func(t *testing.T, s *resumableSchedule, path string) func() {
				s.set(func() { s.failNext = true })
				return func() {}
			},
			says: "keeping every resumable checkout",
		},
		{
			name: "no process table at the first look",
			inTheWay: func(t *testing.T, s *resumableSchedule, path string) func() {
				return blind(t)
			},
			says: "cannot tell what else is in a checkout here",
		},
		{
			name: "the second question failed",
			inTheWay: func(t *testing.T, s *resumableSchedule, path string) func() {
				s.set(func() {
					s.atSecondLook[session] = func() { s.set(func() { s.failNext = true }) }
				})
				return func() {}
			},
			says: "keeping checkout " + session,
		},
		{
			name: "no process table at the second look",
			inTheWay: func(t *testing.T, s *resumableSchedule, path string) func() {
				var clear func()
				s.set(func() {
					s.atSecondLook[session] = func() { clear = blind(t) }
				})
				return func() {
					if clear == nil {
						t.Fatal("the sweep never reached its second look")
					}
					clear()
				}
			},
		},
		{
			name: "the mark could not be written",
			inTheWay: func(t *testing.T, s *resumableSchedule, path string) func() {
				// A file where the ref's directory has to go.
				blocker := filepath.Join(mustGit(t, s.repo, "rev-parse", "--absolute-git-dir"), "refs", "orbit-absent")
				writeFile(t, blocker, "in the way\n")
				return func() { _ = os.Remove(blocker) }
			},
			says: "marking it reclaimed failed",
		},
		{
			name: "it could not be moved aside",
			inTheWay: func(t *testing.T, s *resumableSchedule, path string) func() {
				// A directory with something in it where it has to go.
				blocker := filepath.Join(worktreesDir(), reclaimingCheckoutPrefix+session)
				writeUnder(t, blocker, "left", "in the way\n")
				return func() { _ = os.RemoveAll(blocker) }
			},
			says: "moving it aside failed",
		},
		{
			name: "the worktrees root could not be read",
			inTheWay: func(t *testing.T, s *resumableSchedule, path string) func() {
				root := worktreesDir()
				if err := os.Rename(root, root+".away"); err != nil {
					t.Fatal(err)
				}
				writeFile(t, root, "in the way\n")
				return func() {
					_ = os.Remove(root)
					if err := os.Rename(root+".away", root); err != nil {
						t.Fatal(err)
					}
				}
			},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := newResumableSchedule(t)
			s.checkoutTheRuleKeeps("sess-kept")
			path := s.checkoutAged(session, 20)
			clear := c.inTheWay(t, s, path)

			logs, _ := s.sweepAfter(0, diskUnderTheFloor())

			clear()
			requireCheckoutOnDisk(t, path, c.name)
			if !strings.Contains(logs, c.says) {
				t.Fatalf("the log should show %q, got:\n%s", c.says, logs)
			}
			if strings.Contains(logs, resumableWaitLine) {
				t.Fatalf("%s, and that started a wait:\n%s", c.name, logs)
			}
			if _, looked := s.sweepAfter(worktreeGCInterval, diskUnderTheFloor()); !looked {
				t.Fatal("no wait, so the next sweep looks")
			}
			requireCheckoutReclaimed(t, path, "the next sweep takes what this one could not")
			s.requireALookFindingNothingStartsAWait()
		})
	}
}

// One checkout the look could not judge is enough, whatever it went on to say about the rest.
func TestResumableLookThatCouldNotJudgeOneCheckoutStartsNoWait(t *testing.T) {
	s := newResumableSchedule(t)
	unjudged := s.checkoutAged("sess-a-unjudged", 60)
	kept := s.checkoutAged("sess-b-kept", 40)
	s.set(func() {
		s.atSecondLook["sess-a-unjudged"] = func() { s.set(func() { s.failNext = true }) }
		s.atSecondLook["sess-b-kept"] = func() { s.set(func() { s.answers["sess-b-kept"] = "kept" }) }
	})

	logs, _ := s.sweepAfter(0, diskUnderTheFloor())

	requireCheckoutOnDisk(t, unjudged, "the control plane could not be asked")
	requireCheckoutOnDisk(t, kept, "the control plane said no")
	if strings.Contains(logs, resumableWaitLine) {
		t.Fatalf("one checkout went unjudged, and that started a wait:\n%s", logs)
	}
	if _, looked := s.sweepAfter(worktreeGCInterval, diskUnderTheFloor()); !looked {
		t.Fatal("no wait, so the next sweep looks")
	}
	requireCheckoutReclaimed(t, unjudged, "the next sweep judges it")
	s.requireALookFindingNothingStartsAWait()
}

// A checkout the second look keeps is the rule keeping it, not a look that could not run, and the host still has
// nothing to give. Each case keeps it at a different point of that look, and on a path of its own.
func TestResumableLookThatTheSecondLookKeptStartsAWait(t *testing.T) {
	const session = "sess-b-kept"
	cases := []struct {
		name    string
		between func(t *testing.T, s *resumableSchedule, path string)
	}{
		{"a job started in it", func(t *testing.T, s *resumableSchedule, path string) {
			s.pool.holdWorktreeForBackgroundJob(session, "toolu_A", "bei1")
		}},
		{"a merge or commit is under way in it", func(t *testing.T, s *resumableSchedule, path string) {
			release, _, admitted := s.pool.beginManualWorktreeOperation(session, nil, 0, false, "commit")
			if !admitted {
				t.Error("the commit was not admitted")
				return
			}
			t.Cleanup(release)
		}},
		{"the session got a message", func(t *testing.T, s *resumableSchedule, path string) {
			s.set(func() { s.answers[session] = "kept" })
		}},
		{"a process moved in", func(t *testing.T, s *resumableSchedule, path string) {
			cmd := exec.Command("sleep", "600")
			cmd.Dir = path
			startProcess(t, cmd)
		}},
		{"a file was written", func(t *testing.T, s *resumableSchedule, path string) {
			now := time.Now()
			if err := os.Chtimes(filepath.Join(path, session+".txt"), now, now); err != nil {
				t.Error(err)
			}
		}},
		{"a repository turned up in a dependency directory, which only this look searches", func(t *testing.T, s *resumableSchedule, path string) {
			ignoring(t, path, "node_modules/")
			nested := filepath.Join(path, "node_modules", "dep")
			if err := os.MkdirAll(nested, 0o755); err != nil {
				t.Error(err)
				return
			}
			mustGit(t, nested, "init", "-q", "-b", "main")
			ageCheckout(t, path, 20)
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := newResumableSchedule(t)
			first := s.checkoutAged("sess-a-first", 60)
			path := s.checkoutAged(session, 40)
			reached := false
			s.set(func() {
				s.atSecondLook["sess-a-first"] = func() {
					reached = true
					s.set(func() { s.answers["sess-a-first"] = "kept" })
					c.between(t, s, path)
				}
			})

			logs, _ := s.sweepAfter(0, diskUnderTheFloor())

			if !reached {
				t.Fatal("the sweep never reached the second look of the checkout ahead of this one")
			}
			requireCheckoutOnDisk(t, first, "the control plane said no")
			requireCheckoutOnDisk(t, path, c.name)
			if !strings.Contains(logs, resumableWaitLine) {
				t.Fatalf("nothing could go, which starts a wait, got:\n%s", logs)
			}
			if _, looked := s.sweepAfter(worktreeGCInterval, diskUnderTheFloor()); looked {
				t.Fatal("it looked during the wait")
			}
		})
	}
}

// The wait is for a disk still under its floor when the look ends: not for one back above it, and not for one a
// failed reading says nothing about.
func TestResumableLookStartsNoWaitUnlessTheDiskIsStillShort(t *testing.T) {
	for name, reading := range map[string]worktreeGCPressure{
		"the disk came back meanwhile": roomyDisk(),
		"the last reading failed":      {measured: false, floorMb: 4096},
	} {
		t.Run(name, func(t *testing.T) {
			s := newResumableSchedule(t)
			s.checkoutTheRuleKeeps("sess-kept")
			pressure := diskUnderTheFloor()
			pressure.reread = func() worktreeGCPressure {
				if s.queryCount() > 0 {
					return reading
				}
				short := diskUnderTheFloor()
				short.reread = pressure.reread
				return short
			}

			logs, looked := s.sweepAfter(0, pressure)

			if !looked {
				t.Fatal("the disk was short when the sweep began, so it looks")
			}
			if strings.Contains(logs, resumableWaitLine) {
				t.Fatalf("%s, and that started a wait:\n%s", name, logs)
			}
			s.requireALookFindingNothingStartsAWait()
		})
	}
}

// Taking something is what a sweep is for, whatever else it did, and a look that took something is not one that
// found nothing.
func TestResumableLookThatTookSomethingStartsNoWait(t *testing.T) {
	s := newResumableSchedule(t)
	s.checkoutTheRuleKeeps("sess-kept")
	path := s.checkoutAged("sess-parked", 20)

	logs, _ := s.sweepAfter(0, diskUnderTheFloor())

	requireCheckoutReclaimed(t, path, "nothing stood in its way")
	if strings.Contains(logs, resumableWaitLine) {
		t.Fatalf("it took a checkout, and that started a wait:\n%s", logs)
	}
	s.requireALookFindingNothingStartsAWait()
}

// Fifty-nine seconds in, a sweep goes on, and at sixty it stops, with one line, and starts no wait. The next one
// goes on with the oldest left, until there is nothing left, which is no stop at all however long the last took.
func TestResumableSweepBudgetStopsItBetweenCheckouts(t *testing.T) {
	s := newResumableSchedule(t)
	s.checkoutTheRuleKeeps("sess-kept")
	first := s.checkoutAged("sess-a-first", 60)
	second := s.checkoutAged("sess-b-second", 50)
	third := s.checkoutAged("sess-c-third", 40)
	fourth := s.checkoutAged("sess-d-fourth", 30)

	logs, _ := s.sweepAfter(0, s.removalsTaking(map[string]time.Duration{first: 59 * time.Second, second: time.Second}))

	requireCheckoutReclaimed(t, first, "the oldest goes first")
	requireCheckoutReclaimed(t, second, "59 seconds in, there is budget left")
	requireCheckoutOnDisk(t, third, "60 seconds in, there is none")
	requireCheckoutOnDisk(t, fourth, "the sweep has stopped")
	if want := "after 1m0s, its budget is 1m0s; the next sweep goes on with the oldest of the 2 left"; !strings.Contains(logs, want) {
		t.Fatalf("the log should say %q, got:\n%s", want, logs)
	}
	if got := strings.Count(logs, resumableBudgetLine); got != 1 {
		t.Fatalf("%d lines about the budget, want one:\n%s", got, logs)
	}
	if strings.Contains(logs, resumableWaitLine) {
		t.Fatalf("a sweep that stopped on its budget took something, and that started a wait:\n%s", logs)
	}

	logs, looked := s.sweepAfter(worktreeGCInterval, s.removalsTaking(map[string]time.Duration{third: time.Minute}))

	if !looked {
		t.Fatal("no wait, so the next sweep looks")
	}
	requireCheckoutReclaimed(t, third, "the next sweep goes on with the oldest left")
	requireCheckoutOnDisk(t, fourth, "and it has a budget of its own, which that one spent")
	if !strings.Contains(logs, "the oldest of the 1 left") {
		t.Fatalf("this one stopped on its budget too, got:\n%s", logs)
	}

	logs, _ = s.sweepAfter(worktreeGCInterval, s.removalsTaking(map[string]time.Duration{fourth: 10 * time.Minute}))

	requireCheckoutReclaimed(t, fourth, "the last one left")
	if strings.Contains(logs, resumableBudgetLine) || strings.Contains(logs, resumableWaitLine) {
		t.Fatalf("nothing was left to stop before, and it took something, got:\n%s", logs)
	}
	s.requireALookFindingNothingStartsAWait()
}

// The budget is read between checkouts. Here it is running already, and it is spent at this checkout's second look,
// before its mark, its move and its removal, and the checkout still goes, whole.
func TestResumableSweepBudgetNeverCutsACheckoutShort(t *testing.T) {
	s := newResumableSchedule(t)
	kept := s.checkoutTheRuleKeeps("sess-kept")
	first := s.checkoutAged("sess-a-first", 60)
	slow := s.checkoutAged("sess-b-slow", 50)
	next := s.checkoutAged("sess-c-next", 40)
	tip := mustGit(t, slow, "rev-parse", "HEAD")
	s.set(func() {
		s.atSecondLook["sess-b-slow"] = func() { s.clock.Advance(10 * time.Minute) }
	})

	logs, _ := s.sweepAfter(0, diskUnderTheFloor())

	requireCheckoutReclaimed(t, first, "the oldest goes first")
	requireCheckoutReclaimed(t, slow, "it was on this one when the budget ran out")
	requireCheckoutOnDisk(t, next, "the sweep stops before the next one")
	requireCheckoutOnDisk(t, kept, "the rule keeps it")
	if got := mustGit(t, s.repo, "rev-parse", "orbit/sess-b-slow"); got != tip {
		t.Fatalf("its branch must stay where it was, at %s, got %s", tip, got)
	}
	if _, err := git(s.repo, "rev-parse", "--verify", absentRefName("sess-b-slow")); err != nil {
		t.Fatalf("it must be marked as away, like any other that goes: %v", err)
	}
	if out := mustGit(t, s.repo, "worktree", "list"); strings.Contains(out, "sess-b-slow") {
		t.Fatalf("git must not go on listing it:\n%s", out)
	}
	if entries, _ := os.ReadDir(worktreesDir()); len(entries) != 2 {
		t.Fatalf("nothing of it may be left behind, the root holds %v", entries)
	}
	if !strings.Contains(logs, "after 10m0s") {
		t.Fatalf("the line says how long it took, got:\n%s", logs)
	}
	if _, looked := s.sweepAfter(worktreeGCInterval, diskUnderTheFloor()); !looked {
		t.Fatal("no wait, so the next sweep looks")
	}
	requireCheckoutReclaimed(t, next, "the next sweep goes on")
	s.requireALookFindingNothingStartsAWait()
}

// The budget starts with the first checkout that goes, that checkout's second look included. Neither the first look
// nor what the rule kept ahead of it counts, however long those took: 59 seconds on, it goes on, and at 60 it stops.
func TestResumableSweepBudgetStartsWithTheFirstCheckoutThatGoes(t *testing.T) {
	s := newResumableSchedule(t)
	refused := s.checkoutAged("sess-a-refused", 70)
	first := s.checkoutAged("sess-b-first", 60)
	second := s.checkoutAged("sess-c-second", 50)
	third := s.checkoutAged("sess-d-third", 40)
	advanceAtSecondLook := func(session string, d time.Duration) {
		s.atSecondLook[session] = func() { s.clock.Advance(d) }
	}
	s.set(func() {
		// The first look asks about all of them in one question, and the second about one at a time.
		s.atRequest = func(ids []string) {
			if len(ids) > 1 {
				s.clock.Advance(10 * time.Minute)
			}
		}
		s.atSecondLook["sess-a-refused"] = func() {
			s.set(func() { s.answers["sess-a-refused"] = "kept" })
			s.clock.Advance(10 * time.Minute)
		}
		advanceAtSecondLook("sess-b-first", 59*time.Second)
		advanceAtSecondLook("sess-c-second", time.Second)
	})

	logs, _ := s.sweepAfter(0, diskUnderTheFloor())

	s.set(func() { s.atRequest = nil })
	requireCheckoutOnDisk(t, refused, "the control plane said no")
	requireCheckoutReclaimed(t, first, "ten minutes of looking and of a refusal are no part of the budget")
	requireCheckoutReclaimed(t, second, "59 seconds of the budget are gone, and one is left")
	requireCheckoutOnDisk(t, third, "60 seconds are gone")
	if !strings.Contains(logs, "after 1m0s") {
		t.Fatalf("the line says what the budget counted, got:\n%s", logs)
	}
	if _, looked := s.sweepAfter(worktreeGCInterval, diskUnderTheFloor()); !looked {
		t.Fatal("no wait, so the next sweep looks")
	}
	requireCheckoutReclaimed(t, third, "the next sweep goes on")
	s.requireALookFindingNothingStartsAWait()
}

// Back above the floor is the end of a sweep, and has nothing to do with its budget.
func TestResumableSweepBudgetSaysNothingOnceTheDiskIsBackAboveTheFloor(t *testing.T) {
	s := newResumableSchedule(t)
	s.checkoutTheRuleKeeps("sess-kept")
	first := s.checkoutAged("sess-a-first", 60)
	second := s.checkoutAged("sess-b-second", 40)
	pressure := diskUnderTheFloor()
	pressure.reread = func() worktreeGCPressure {
		if _, err := os.Stat(first); os.IsNotExist(err) {
			s.clock.Advance(10 * time.Minute)
			return roomyDisk()
		}
		reading := diskUnderTheFloor()
		reading.reread = pressure.reread
		return reading
	}

	logs, _ := s.sweepAfter(0, pressure)

	requireCheckoutReclaimed(t, first, "the disk was short")
	requireCheckoutOnDisk(t, second, "the disk is not any more")
	if strings.Contains(logs, resumableBudgetLine) || strings.Contains(logs, resumableWaitLine) {
		t.Fatalf("the floor ended this sweep, and it should say nothing about that, got:\n%s", logs)
	}
	if _, looked := s.sweepAfter(worktreeGCInterval, diskUnderTheFloor()); !looked {
		t.Fatal("no wait, so the next sweep looks")
	}
	requireCheckoutReclaimed(t, second, "short again")
	s.requireALookFindingNothingStartsAWait()
}

// Checkouts the second look keeps ahead of the first to go do not spend the budget. If they did, they would stop this
// sweep and the next at the same place, and what is behind them would go one a sweep at best.
func TestResumableSweepBudgetIsNotSpentOnWhatTheRuleKeeps(t *testing.T) {
	refuseAt := func(s *resumableSchedule, session string) {
		s.set(func() {
			s.atSecondLook[session] = func() {
				s.set(func() { s.answers[session] = "kept" })
				s.clock.Advance(5 * time.Minute)
			}
		})
	}
	t.Run("what is behind them goes, on a budget of its own", func(t *testing.T) {
		s := newResumableSchedule(t)
		refused := s.checkoutAged("sess-a-refused", 60)
		taken := s.checkoutAged("sess-b-taken", 50)
		behind := s.checkoutAged("sess-c-behind", 40)
		refuseAt(s, "sess-a-refused")

		logs, _ := s.sweepAfter(0, diskUnderTheFloor())

		requireCheckoutOnDisk(t, refused, "the control plane said no")
		requireCheckoutReclaimed(t, taken, "five minutes on a refusal do not stop the sweep")
		requireCheckoutReclaimed(t, behind, "nor do they count once one has gone")
		if strings.Contains(logs, resumableBudgetLine) {
			t.Fatalf("no removal took any time, got:\n%s", logs)
		}
		s.requireALookFindingNothingStartsAWait()
	})
	t.Run("with nothing but those, it is a look that found nothing", func(t *testing.T) {
		s := newResumableSchedule(t)
		first := s.checkoutAged("sess-a-refused", 60)
		second := s.checkoutAged("sess-b-refused", 40)
		refuseAt(s, "sess-a-refused")
		refuseAt(s, "sess-b-refused")

		logs, _ := s.sweepAfter(0, diskUnderTheFloor())

		requireCheckoutOnDisk(t, first, "the control plane said no")
		requireCheckoutOnDisk(t, second, "the control plane said no")
		if strings.Contains(logs, resumableBudgetLine) {
			t.Fatalf("it has taken nothing and the rule kept everything, so it did not stop on its budget:\n%s", logs)
		}
		if !strings.Contains(logs, resumableWaitLine) {
			t.Fatalf("nothing could go, which starts a wait, got:\n%s", logs)
		}
	})
}

// A look that cannot judge or take what it finds has a bound too, or a control plane gone quiet after the first look
// holds the loop for its 15 seconds a checkout, over every checkout there is. It starts no wait, as any such look.
func TestResumableSweepBudgetStopsALookThatCouldNotFinish(t *testing.T) {
	s := newResumableSchedule(t)
	unjudged := s.checkoutAged("sess-a-unjudged", 60)
	behind := s.checkoutAged("sess-b-behind", 40)
	s.set(func() {
		s.atSecondLook["sess-a-unjudged"] = func() {
			s.set(func() { s.failNext = true })
			s.clock.Advance(time.Minute)
		}
	})

	logs, _ := s.sweepAfter(0, diskUnderTheFloor())

	requireCheckoutOnDisk(t, unjudged, "the control plane could not be asked")
	requireCheckoutOnDisk(t, behind, "the budget has gone")
	asked := 0
	s.set(func() { asked = s.timesAsked["sess-b-behind"] })
	if asked != 1 {
		t.Fatalf("it was asked about %d times, want only the first look's: a stopped sweep gives it no second look", asked)
	}
	if !strings.Contains(logs, "the oldest of the 1 left") {
		t.Fatalf("that is a stop on the budget, got:\n%s", logs)
	}
	if strings.Contains(logs, resumableWaitLine) {
		t.Fatalf("it could not finish, and that started a wait:\n%s", logs)
	}
	if _, looked := s.sweepAfter(worktreeGCInterval, diskUnderTheFloor()); !looked {
		t.Fatal("no wait, so the next sweep looks")
	}
	requireCheckoutReclaimed(t, unjudged, "the next sweep takes them")
	requireCheckoutReclaimed(t, behind, "the next sweep takes them")
}

// Once a sweep has taken something the budget is read between any two checkouts, whichever way the last one went.
func TestResumableSweepBudgetIsReadAfterACheckoutTheSecondLookKept(t *testing.T) {
	s := newResumableSchedule(t)
	taken := s.checkoutAged("sess-a-taken", 60)
	refused := s.checkoutAged("sess-b-refused", 50)
	behind := s.checkoutAged("sess-c-behind", 40)
	s.set(func() {
		s.atSecondLook["sess-b-refused"] = func() {
			s.set(func() { s.answers["sess-b-refused"] = "kept" })
			s.clock.Advance(5 * time.Minute)
		}
	})

	logs, _ := s.sweepAfter(0, diskUnderTheFloor())

	requireCheckoutReclaimed(t, taken, "the oldest goes first")
	requireCheckoutOnDisk(t, refused, "the control plane said no")
	requireCheckoutOnDisk(t, behind, "the budget had gone by the time the sweep got here")
	if !strings.Contains(logs, "the oldest of the 1 left") {
		t.Fatalf("that is a stop on the budget, got:\n%s", logs)
	}
}

// Asked of the source, as the file beside this one asks it: a later edit breaks these silently, and all
// anyone sees is a session that fails to start, or a disk that stays full, months on.
func TestTheRunLoopCallsEverySideOfTheResumableSweep(t *testing.T) {
	source, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(source)
	// The first half first and on nothing but the sweeper's schedule, and the second behind it, both times.
	if !strings.Contains(body, "if worktreeGC.due(time.Now()) {\n\t\tliveSet := pool.ids()\n\t\tpressure := measureWorktreePressure(diskFloorMb.Load(), &storage)\n\t\tgcWorktrees(t, liveSet, pressure)\n\t\tworktreeGC.sweepResumable(t, pool, pressure, false)\n") {
		t.Error("the startup sweep must run the first half, then the second, whenever a sweep is due")
	}
	if !strings.Contains(body, "if worktreeGC.due(time.Now()) {\n\t\t\tpressure := measureWorktreePressure(diskFloorMb.Load(), &storage)\n\t\t\tgcWorktrees(t, pool.ids(), pressure)\n\t\t\tworktreeGC.sweepResumable(t, pool, pressure, false)\n") {
		t.Error("the claim loop's sweep must run the first half, then the second, whenever a sweep is due")
	}
	if got := strings.Count(body, "gcResumableCheckouts(t, pool, pressure)"); got != 1 {
		t.Errorf("sweepResumable must be the one door to the second half, or it runs past a wait: found %d calls", got)
	}
	// Only the room made for a new checkout under a storage budget goes past the wait, through that same door.
	room := strings.Index(body, "func (s *worktreeSweeper) makeRoom(")
	pastTheWait := strings.Index(body, "sweepResumable(t, pool, pressure, true)")
	if strings.Count(body, "sweepResumable(t, pool, pressure, true)") != 1 || room < 0 || pastTheWait < room ||
		pastTheWait > room+strings.Index(body[room:], "\n}\n") {
		t.Error("makeRoom, and nothing else, must take the second half past the wait")
	}
	// One sweeper, for as long as the process runs, which starts it with no wait: that is what a restart forgetting
	// the wait comes to, and nothing but sweepResumable may touch it.
	if !strings.Contains(body, "worktreeGC := worktreeSweeper{interval: worktreeGCInterval, armed: reclaimed && !reclaimSkipped}\n") {
		t.Error("a runner must start with one sweeper and no wait")
	}
	if got := strings.Count(body, "worktreeGC := "); got != 1 {
		t.Errorf("a copy of the sweeper loses the wait: found %d", got)
	}
	if door := strings.Index(body, "func (s *worktreeSweeper) sweepResumable("); door < 0 {
		t.Error("sweepResumable is the one door to the second half, and the one thing that has the wait")
	} else {
		end := door + strings.Index(body[door:], "\n}\n")
		rest := strings.Replace(body[:door]+body[end:], "\tresumableWaitUntil time.Time\n", "", 1)
		rest = strings.Replace(rest, "\tresumableWaitMeasured time.Time\n", "", 1)
		if strings.Contains(strings.Replace(rest, "while resumableWaitUntil is ahead", "", 1), "resumableWaitUntil") ||
			strings.Contains(rest, "resumableWaitMeasured") {
			t.Error("nothing but sweepResumable may read or write the wait")
		}
	}
	restore := strings.Index(body, "restoreAbsentCheckout(pool, job)")
	activate := strings.Index(body, "pool.activatePrepared(job, stageCredential)")
	if restore < 0 || activate < 0 || restore > activate {
		t.Error("a checkout must come back before the claim wakes the supervisor that stands on it")
	}
	if !strings.Contains(body, "execDir := pool.setupSupervisorCheckout(job, sessionExecDir(job.WorkDir), initiallyActive)") {
		t.Error("a supervisor about to be registered must say whether its session is at rest")
	}
	if strings.Contains(body, "setupWorktree(job,") {
		t.Error("the run loop must have no way to make a resting session's checkout")
	}
}
