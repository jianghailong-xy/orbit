//go:build linux

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Room for a new session checkout under a storage budget (checkoutRoom, docs/session-checkout-storage-design.md §5),
// and the resting sessions' checkouts a budget's floor may take without the two weeks:
//
//   - a checkout that would take the budget under its floor has the sweep make room before it is made, and one that
//     would not sweeps nothing (TestUnderAStorageBudgetACheckoutThatWouldCrossTheFloor*);
//   - a burst of checkouts within one sweep interval stays at or over the floor while anything can go, and is never
//     refused (TestUnderAStorageBudgetABurst*);
//   - without a budget, nothing of this runs (TestWithoutAStorageBudget*);
//   - what a checkout is estimated to take is what it holds on disk (TestACheckoutEstimate*);
//   - under a budget's floor a resting checkout younger than two weeks goes, oldest first, and comes back on its next
//     claim; without one it stays (TestUnderAStorageBudgetsFloorARestingCheckout*, TestWithoutABudgetsFloor*).
//     What it has to lose keeps it either way (TestResumableSweepKeeps), but commits on its own branch are not that
//     under a budget's floor (TestUnderAStorageBudgetsFloorACheckoutWhoseWorkIsOnlyOnItsBranch*);
//   - the room made for a checkout does not wait out a look that found nothing (*DuringTheWait);
//   - a branch deleted while its checkout is away comes back with the checkout (TestABranchDeleted*).

// withPayload commits a tracked file of a MiB to main and pushes it, so that a checkout made from then on is a size a
// budget counted in MiB notices.
func withPayload(t *testing.T, f *resumableFixture) {
	t.Helper()
	commitFile(t, f.repo, "payload.bin", strings.Repeat("p", oneMiB), "payload")
	mustGit(t, f.repo, "push", "-q", "origin", "main")
}

// budgetLeaving is a runner's checkoutStorage holding a 64 MiB budget, measured a minute ago, with free bytes left
// over an 8 MiB floor. Far smaller than any disk these tests run on, so statfs never decides.
func budgetLeaving(free int64) *checkoutStorage {
	return budgetStorage(&StorageBudget{LimitBytes: 64 * oneMiB, UsageBytes: 64*oneMiB - free,
		MeasuredAt: time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano), FloorBytes: 8 * oneMiB})
}

// roomFor sets the room the run loop sets, on storage, with an armed sweeper over the fixture's control plane and
// pool, for as long as the test runs. beforeSweep, when there is one, runs as each sweep starts.
func roomFor(t *testing.T, f *resumableFixture, storage *checkoutStorage, beforeSweep func()) *worktreeSweeper {
	t.Helper()
	sweeper := &worktreeSweeper{interval: worktreeGCInterval, armed: true}
	sessionCheckoutRoom.Store(&checkoutRoom{storage: storage,
		measure: func() worktreeGCPressure { return measureWorktreePressure(0, storage) },
		sweep: func(pressure worktreeGCPressure) {
			if beforeSweep != nil {
				beforeSweep()
			}
			sweeper.makeRoom(f.transport, f.pool, pressure)
		}})
	t.Cleanup(func() { sessionCheckoutRoom.Store(nil) })
	return sweeper
}

// startNewSession makes a new session's checkout through the door its claim takes (setupWorktree), with the control
// plane keeping the session, as it keeps one at work, and returns the checkout's path.
func startNewSession(t *testing.T, f *resumableFixture, session string) string {
	t.Helper()
	f.set(func() { f.answers[session] = "kept" })
	job := &ClaimedSession{SessionID: session, Branch: "orbit/" + session}
	execDir := setupWorktree(job, f.repo)
	if job.IsolationStatus != isoWorktree || job.WT == nil || job.SourceRefusal != nil {
		t.Fatalf("%s got no checkout of its own: execDir %q, isolation %q, refusal %+v", session, execDir, job.IsolationStatus, job.SourceRefusal)
	}
	return job.WT.Path
}

// A checkout that would take the free space under the budget's floor has the sweep make room before any of it is on
// disk, and is made then. One that would not, even one that leaves exactly the floor, sweeps nothing and asks the
// control plane nothing. Either way the checkout counts as used once made.
func TestUnderAStorageBudgetACheckoutThatWouldCrossTheFloorReclaimsFirst(t *testing.T) {
	for _, c := range []struct {
		name string
		// spare is the free space over the floor before the checkout, given what the checkout is estimated to take.
		spare    func(estimate int64) int64
		reclaims bool
	}{
		{"it would take the budget under its floor", func(estimate int64) int64 { return estimate - 1 }, true},
		{"it would leave the budget exactly at its floor", func(estimate int64) int64 { return estimate }, false},
		{"it fits with room to spare", func(estimate int64) int64 { return 4 * estimate }, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newResumableFixture(t)
			withPayload(t, f)
			ended := withIgnoredBytes(t, f.checkout(t, "sess-ended"), 3*oneMiB, 20)
			f.set(func() { delete(f.answers, "sess-ended") })
			endedBytes := checkoutBytes(ended)
			estimate := int64(checkoutEstimate(f.repo, mustGit(t, f.repo, "rev-parse", "HEAD"), nil))
			if estimate != oneMiB+int64(len("base\n")) {
				t.Fatalf("a checkout of main holds the payload and base.txt, %d bytes, estimated %d", oneMiB+len("base\n"), estimate)
			}
			free := 8*oneMiB + c.spare(estimate)
			storage := budgetLeaving(free)
			newPath := filepath.Join(worktreesDir(), "sess-new")
			sweeps := 0
			roomFor(t, f, storage, func() {
				sweeps++
				if !checkoutAbsent(newPath) {
					t.Error("room is made before the checkout, but the checkout is on disk already")
				}
			})
			asked := f.queryCount()

			logs := captureLogs(t, func() { startNewSession(t, f, "sess-new") })

			requireCheckoutOnDisk(t, newPath, "the checkout is made either way")
			freed := uint64(0)
			if c.reclaims {
				requireCheckoutReclaimed(t, ended, "room is made first, and an ended session's checkout is the first to go")
				if sweeps != 1 {
					t.Fatalf("one sweep makes the room, got %d", sweeps)
				}
				if want := "session sess-new — its checkout, about 1.0 MiB, would leave"; !strings.Contains(logs, want) {
					t.Fatalf("the log must say why the sweep runs (%q), got:\n%s", want, logs)
				}
				if strings.Contains(logs, "nothing more can be reclaimed") {
					t.Fatalf("enough could go, so there is no shortfall to report, got:\n%s", logs)
				}
				freed = endedBytes
			} else {
				requireCheckoutOnDisk(t, ended, "the checkout fits, so nothing goes")
				if sweeps != 0 || f.queryCount() != asked {
					t.Fatalf("a checkout that fits sweeps nothing and asks nothing: %d sweeps, %d questions", sweeps, f.queryCount()-asked)
				}
				if strings.Contains(logs, "reclaiming checkouts first") {
					t.Fatalf("no room is made for a checkout that fits, got:\n%s", logs)
				}
			}
			made := checkoutBytes(newPath)
			if len(storage.added) != 1 || storage.added[0].bytes != made {
				t.Fatalf("the checkout must count as used, %d bytes, got %+v", made, storage.added)
			}
			if got, want := storage.judge(roomyStatfs()).freeBytes, uint64(free)+freed-made; got != want {
				t.Fatalf("judged free space %d, want %d: what the budget had, plus what went, less the new checkout", got, want)
			}
		})
	}
}

// A burst of new checkouts faster than one sweep interval, with no measurement from the channel in between, which is
// the pace the managed-runner lab found could overflow a volume. Each checkout counts as soon as it is made, and each
// that would take the budget under its floor makes room first: every ended session's checkout, then resting ones,
// oldest first, until it fits. The free space as judged stays at or over the floor for as long as anything can go.
// After that a checkout is still made, and the log says how far short of the floor it leaves the budget.
func TestUnderAStorageBudgetABurstOfCheckoutsStaysOverTheFloorWhileAnythingCanGo(t *testing.T) {
	f := newResumableFixture(t)
	withPayload(t, f)
	endedA := f.checkout(t, "sess-ended-a")
	endedB := f.checkout(t, "sess-ended-b")
	f.set(func() {
		delete(f.answers, "sess-ended-a")
		delete(f.answers, "sess-ended-b")
	})
	restingOlder := f.checkout(t, "sess-resting-older")
	ageCheckout(t, restingOlder, 5)
	restingNewer := f.checkout(t, "sess-resting-newer")
	ageCheckout(t, restingNewer, 2)
	estimate := int64(checkoutEstimate(f.repo, mustGit(t, f.repo, "rev-parse", "HEAD"), nil))
	// Two checkouts fit as the budget stands, with half of one to spare.
	storage := budgetLeaving(8*oneMiB + 2*estimate + estimate/2)
	measuredAt := storage.budget.Load().MeasuredAt
	roomFor(t, f, storage, nil)

	reclaimable := map[string]string{"ended a": endedA, "ended b": endedB, "resting, older": restingOlder, "resting, newer": restingNewer}
	wentAt := map[string]int{}
	began := time.Now()
	short := false
	for i := 1; i <= 12 && !short; i++ {
		session := fmt.Sprintf("sess-burst-%02d", i)
		logs := captureLogs(t, func() { startNewSession(t, f, session) })
		left := 0
		for name, path := range reclaimable {
			if !checkoutAbsent(path) {
				left++
			} else if _, seen := wentAt[name]; !seen {
				wentAt[name] = i
			}
		}
		judged := storage.judge(roomyStatfs())
		if !judged.belowFloor() {
			continue
		}
		if left > 0 {
			t.Fatalf("checkout %d left the budget under its floor, %d bytes free, while %d checkouts could still go:\n%s", i, judged.freeBytes, left, logs)
		}
		if !strings.Contains(logs, "session "+session+" — nothing more can be reclaimed, so its checkout is made") {
			t.Fatalf("checkout %d is made short of the floor, and the log must say so, got:\n%s", i, logs)
		}
		short = true
	}
	if !short {
		t.Fatal("the burst never ran out of checkouts to reclaim, so it shows nothing of what happens then")
	}
	if storage.budget.Load().MeasuredAt != measuredAt || time.Since(began) >= worktreeGCInterval {
		t.Fatal("the burst must run within one sweep interval, on one measurement")
	}
	if wentAt["ended a"] != wentAt["ended b"] || wentAt["ended a"] >= wentAt["resting, older"] || wentAt["resting, older"] >= wentAt["resting, newer"] {
		t.Fatalf("every ended session's checkout goes first, then the resting ones, oldest first; they went at checkouts %v", wentAt)
	}
}

// Without a usable budget a checkout is made as it always was: no sweep, no question to the control plane, nothing
// counted. A budget with no floor gates nothing either, and before the sweeper is armed (a reclaim has not answered)
// nothing is reclaimed, so the checkout is made short of the floor and the log says so; in both, the checkout still
// counts as used.
func TestWithoutAStorageBudgetACheckoutIsMadeAsItAlwaysWas(t *testing.T) {
	short := &StorageBudget{LimitBytes: 64 * oneMiB, UsageBytes: 64 * oneMiB,
		MeasuredAt: time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano), FloorBytes: 8 * oneMiB}
	noFloor := *short
	noFloor.FloorBytes = 0
	for _, c := range []struct {
		name    string
		budget  *StorageBudget
		armed   bool
		counted bool
	}{
		{"no budget", nil, true, false},
		{"a budget that cannot be one", &StorageBudget{UsageBytes: oneMiB, MeasuredAt: short.MeasuredAt, FloorBytes: 8 * oneMiB}, true, false},
		{"a budget with no floor", &noFloor, true, true},
		{"a budget short of its floor, before the sweeper is armed", short, false, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newResumableFixture(t)
			withPayload(t, f)
			ended := f.checkout(t, "sess-ended")
			f.set(func() { delete(f.answers, "sess-ended") })
			storage := budgetStorage(c.budget)
			sweeper := roomFor(t, f, storage, nil)
			sweeper.armed = c.armed
			asked := f.queryCount()

			logs := captureLogs(t, func() { startNewSession(t, f, "sess-new") })

			requireCheckoutOnDisk(t, ended, "nothing is reclaimed")
			if f.queryCount() != asked {
				t.Fatalf("nothing may ask the control plane: %d questions", f.queryCount()-asked)
			}
			if shortfall := strings.Contains(logs, "session sess-new — nothing more can be reclaimed, so its checkout is made"); shortfall != !c.armed {
				t.Fatalf("a shortfall reported: %v, want %v; log:\n%s", shortfall, !c.armed, logs)
			}
			if counted := len(storage.added) == 1; counted != c.counted {
				t.Fatalf("counted %v, want %v: %+v", counted, c.counted, storage.added)
			}
		})
	}
}

// What a checkout is estimated to take before it is made is what it holds on disk once it is, as the volume's
// measurement counts it (checkoutBytes), but for the checkout's .git file: in a sparse checkout, only the paths its
// patterns keep, a path brought back under a left-out directory included.
func TestACheckoutEstimateIsWhatTheCheckoutHolds(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	repo := initRepo(t)
	for name, content := range map[string]string{
		"docs/big.bin":            strings.Repeat("d", 256*1024),
		"docs/keep.md":            "kept in\n",
		"src/a.go":                "package a\n",
		".orbit/checkout-exclude": "docs/\n!docs/keep.md\n",
	} {
		writeUnder(t, repo, name, content)
	}
	if err := os.WriteFile(filepath.Join(repo, "run.sh"), []byte("#!/bin/sh\necho run\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("src/a.go", filepath.Join(repo, "link")); err != nil {
		t.Fatal(err)
	}
	mustGit(t, repo, "add", "-A")
	mustGit(t, repo, "commit", "-q", "-m", "a tree with a left-out directory")
	base := mustGit(t, repo, "rev-parse", "HEAD")

	for _, c := range []struct {
		name     string
		declared []string
	}{
		{"sparse", checkoutExclusions(repo, base)},
		{"full", nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			estimate := checkoutEstimate(repo, base, c.declared)
			path := filepath.Join(worktreesDir(), "sess-"+c.name)
			if len(c.declared) == 0 {
				mustGit(t, repo, "worktree", "add", "-q", "-b", "orbit/sess-"+c.name, path, base)
			} else if _, err := addSessionCheckout("sess-"+c.name, repo, path, base, "-b", "orbit/sess-"+c.name, path, base); err != nil {
				t.Fatal(err)
			}
			gitFile, err := os.Lstat(filepath.Join(path, ".git"))
			if err != nil {
				t.Fatal(err)
			}
			if got := checkoutBytes(path) - uint64(gitFile.Size()); got != estimate {
				t.Fatalf("estimated %d bytes, the checkout holds %d", estimate, got)
			}
			_, bigOnDisk := os.Lstat(filepath.Join(path, "docs", "big.bin"))
			if left := os.IsNotExist(bigOnDisk); left != (len(c.declared) > 0) {
				t.Fatalf("docs/big.bin left out: %v, for a %s checkout", left, c.name)
			}
		})
	}
	if sparse, full := checkoutEstimate(repo, base, checkoutExclusions(repo, base)), checkoutEstimate(repo, base, nil); full-sparse != 256*1024 {
		t.Fatalf("the sparse estimate leaves out docs/big.bin and nothing else: %d against %d", sparse, full)
	}
	if got := checkoutEstimate(repo, "no-such-rev", nil); got != 0 {
		t.Fatalf("a rev git cannot list counts nothing, got %d", got)
	}
}

// Under a storage budget's floor a resting session's checkout goes however recently it was written, oldest last
// write first, and only while the budget is short: the two weeks a checkout waits without a budget are not waited
// out. It comes back on the session's next claim, on its branch as it was, and counts as used again.
func TestUnderAStorageBudgetsFloorARestingCheckoutGoesWithoutTheTwoWeeks(t *testing.T) {
	f := newResumableFixture(t)
	oldest := withIgnoredBytes(t, f.checkout(t, "sess-oldest"), 3*oneMiB, 6)
	middle := withIgnoredBytes(t, f.checkout(t, "sess-middle"), 3*oneMiB, 3)
	newest := withIgnoredBytes(t, f.checkout(t, "sess-newest"), 3*oneMiB, 0)
	tip := mustGit(t, oldest, "rev-parse", "HEAD")
	base := mustGit(t, f.repo, "rev-parse", baseRefName("sess-oldest"))
	// A cold supervisor stands on it, as one does on every resting session after a restart.
	job := &ClaimedSession{SessionID: "sess-oldest", Branch: "orbit/sess-oldest",
		WT: &Worktree{Path: oldest, Branch: "orbit/sess-oldest", RepoDir: f.repo, Session: "sess-oldest", BaseSha: base}}
	if _, added := f.pool.register(job, func() {}, false); !added {
		t.Fatal("register a cold supervisor")
	}
	// 4 MiB short, 3 MiB a checkout: two go.
	storage := smallBudgetUnderItsFloor()

	logs := captureLogs(t, func() { gcResumableCheckouts(f.transport, f.pool, measureWorktreePressure(0, storage)) })

	requireCheckoutReclaimed(t, oldest, "six days unwritten, the oldest, goes first under the budget's floor")
	requireCheckoutReclaimed(t, middle, "three days unwritten, it goes while the budget is still short")
	requireCheckoutOnDisk(t, newest, "the budget is back over its floor, so the newest stays")
	first := strings.Index(logs, "gc: reclaimed checkout sess-oldest — resumable session, clean, its work on its branch, last written 6 days ago, no process or job in it; under the storage budget's floor")
	second := strings.Index(logs, "gc: reclaimed checkout sess-middle — resumable session, clean, its work on its branch, last written 3 days ago")
	if first < 0 || second < first {
		t.Fatalf("each goes in one line saying why, the oldest first, got:\n%s", logs)
	}
	if got := mustGit(t, f.repo, "rev-parse", "orbit/sess-oldest"); got != tip {
		t.Fatalf("the branch stays where it was, at %s, got %s", tip, got)
	}

	roomFor(t, f, storage, nil)
	claim := &ClaimedSession{SessionID: "sess-oldest", Branch: "orbit/sess-oldest"}
	restoreAbsentCheckout(f.pool, claim)

	if claim.SourceRefusal != nil {
		t.Fatalf("the claim was refused: %+v", claim.SourceRefusal)
	}
	requireCheckoutOnDisk(t, oldest, "its next claim brings it back")
	if got := mustGit(t, oldest, "symbolic-ref", "--short", "HEAD"); got != "orbit/sess-oldest" {
		t.Fatalf("it comes back on its branch, got %q", got)
	}
	if got := mustGit(t, oldest, "rev-parse", "HEAD"); got != tip {
		t.Fatalf("HEAD = %s, want the branch's tip %s", got, tip)
	}
	if content, err := os.ReadFile(filepath.Join(oldest, "sess-oldest.txt")); err != nil || string(content) != "work by sess-oldest\n" {
		t.Fatalf("its work is there: %q, %v", content, err)
	}
	if status := mustGit(t, oldest, "status", "--porcelain"); status != "" {
		t.Fatalf("it comes back clean, got %q", status)
	}
	if _, err := git(f.repo, "rev-parse", "--verify", absentRefName("sess-oldest")); err == nil {
		t.Fatal("once back, it is no longer marked away")
	}
	if got := mustGit(t, f.repo, "rev-parse", baseRefName("sess-oldest")); got != base {
		t.Fatalf("its base ref stays %s, got %s", base, got)
	}
	if len(storage.added) != 1 || storage.added[0].bytes != checkoutBytes(oldest) {
		t.Fatalf("the checkout that came back counts as used: %+v", storage.added)
	}
}

// Without a budget, a resting checkout younger than two weeks stays however short the disk is, as it always has, while
// a fortnight-idle one beside it goes; and a budget over its floor takes nothing at all.
func TestWithoutABudgetsFloorARestingCheckoutWaitsOutTheTwoWeeks(t *testing.T) {
	for _, c := range []struct {
		name     string
		pressure func() worktreeGCPressure
		oldGoes  bool
	}{
		{"no budget, under the machine's floor", diskUnderTheFloor, true},
		{"a budget over its floor", func() worktreeGCPressure { return measureWorktreePressure(0, budgetLeaving(32*oneMiB)) }, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newResumableFixture(t)
			thirteen := withIgnoredBytes(t, f.checkout(t, "sess-thirteen-days"), 3*oneMiB, 13)
			fresh := withIgnoredBytes(t, f.checkout(t, "sess-fresh"), 3*oneMiB, 0)
			old := withIgnoredBytes(t, f.checkout(t, "sess-old"), 3*oneMiB, 20)

			gcResumableCheckouts(f.transport, f.pool, c.pressure())

			requireCheckoutOnDisk(t, thirteen, "thirteen days unwritten is not two weeks")
			requireCheckoutOnDisk(t, fresh, "written just now")
			if c.oldGoes {
				requireCheckoutReclaimed(t, old, "two weeks unwritten, it goes, so the sweep did run")
			} else {
				requireCheckoutOnDisk(t, old, "a budget over its floor takes nothing")
			}
		})
	}
}

// A resting session whose work is on its own branch and nowhere else, as every session that did work has it: a commit
// of its own, and the park checkpoint its last turn ended on. Under a storage budget's floor its checkout goes, both
// commits staying on the branch, and on its next claim the checkout comes back on that branch with the checkpoint
// undone, its work uncommitted again as on any resume. Without a budget the checkout stays: a commit no remote has
// keeps it, however long it has been idle.
func TestUnderAStorageBudgetsFloorACheckoutWhoseWorkIsOnlyOnItsBranchGoesAndComesBack(t *testing.T) {
	for _, underABudget := range []bool{true, false} {
		name := "under a storage budget's floor"
		if !underABudget {
			name = "no budget, under the machine's floor"
		}
		t.Run(name, func(t *testing.T) {
			f := newResumableFixture(t)
			const session = "sess-parked"
			branch := "orbit/" + session
			path := f.checkout(t, session)
			base := mustGit(t, f.repo, "rev-parse", baseRefName(session))
			commitFile(t, path, "own.txt", "a commit of its own\n", "a commit of its own")
			own := mustGit(t, path, "rev-parse", "HEAD")
			writeUnder(t, path, "wip.txt", "the last turn's work in progress\n")
			if _, _, err := finalizeWorktree(&Worktree{Path: path, Branch: branch, RepoDir: f.repo, Session: session, BaseSha: base}, true); err != nil {
				t.Fatal(err)
			}
			checkpoint := mustGit(t, path, "rev-parse", "HEAD")
			if checkpoint == own || !strings.Contains(mustGit(t, path, "log", "-1", "--format=%B"), parkCheckpointTrailer+": "+session) {
				t.Fatal("the last turn must end on a park checkpoint")
			}
			if only := mustGit(t, path, "rev-list", "--count", "HEAD", "--not", "--remotes"); only != "2" {
				t.Fatalf("two commits only its branch has, got %s", only)
			}
			// Under a budget, younger than two weeks; without one, older, so that only the commits can keep it.
			days := 3
			pressure := measureWorktreePressure(0, smallBudgetUnderItsFloor())
			if !underABudget {
				days, pressure = 20, diskUnderTheFloor()
			}
			ageCheckout(t, path, days)
			neighbour := f.checkout(t, "sess-neighbour")
			job := &ClaimedSession{SessionID: session, Branch: branch,
				WT: &Worktree{Path: path, Branch: branch, RepoDir: f.repo, Session: session, BaseSha: base}}
			if _, added := f.pool.register(job, func() {}, false); !added {
				t.Fatal("register a cold supervisor")
			}

			gcResumableCheckouts(f.transport, f.pool, pressure)

			requireCheckoutReclaimed(t, neighbour, "a pushed fortnight-idle neighbour goes, so the sweep did run")
			if !underABudget {
				requireCheckoutOnDisk(t, path, "without a budget, a commit no remote has keeps the checkout")
				return
			}
			requireCheckoutReclaimed(t, path, "its work is on its branch, which stays")
			if got := mustGit(t, f.repo, "rev-parse", branch); got != checkpoint {
				t.Fatalf("the branch keeps both commits, its tip at the checkpoint %s, got %s", checkpoint, got)
			}
			if got := mustGit(t, f.repo, "rev-parse", branch+"~1"); got != own {
				t.Fatalf("the commit of its own is under the checkpoint, want %s, got %s", own, got)
			}

			claim := &ClaimedSession{SessionID: session, Branch: branch}
			restoreAbsentCheckout(f.pool, claim)

			if claim.SourceRefusal != nil {
				t.Fatalf("the claim was refused: %+v", claim.SourceRefusal)
			}
			requireCheckoutOnDisk(t, path, "its next claim brings it back")
			if got := mustGit(t, path, "symbolic-ref", "--short", "HEAD"); got != branch {
				t.Fatalf("it comes back on its branch, got %q", got)
			}
			if got := mustGit(t, path, "rev-parse", "HEAD"); got != own {
				t.Fatalf("the checkpoint is undone and the commit of its own stays: HEAD = %s, want %s", got, own)
			}
			if status := mustGit(t, path, "status", "--porcelain"); status != "A  wip.txt" {
				t.Fatalf("the checkpoint's work is back, uncommitted, got %q", status)
			}
			for file, want := range map[string]string{"own.txt": "a commit of its own\n", "wip.txt": "the last turn's work in progress\n"} {
				if content, err := os.ReadFile(filepath.Join(path, file)); err != nil || string(content) != want {
					t.Fatalf("%s: %q, %v", file, content, err)
				}
			}
		})
	}
}

// Within the wait after a look at resting checkouts that found nothing, the schedule's sweeps do not look again, but a
// checkout that would take the budget under its floor still makes room from them: it is the change that wait assumes
// has not happened.
func TestUnderAStorageBudgetACheckoutMakesRoomFromRestingCheckoutsDuringTheWait(t *testing.T) {
	s := newResumableSchedule(t)
	s.sweeper.armed = true
	resting := withIgnoredBytes(t, s.checkout(t, "sess-resting"), 6*oneMiB, 2)
	// On its way to an engine when the first look asks, so that look finds nothing.
	s.set(func() { s.answers["sess-resting"] = "kept" })
	storage := smallBudgetUnderItsFloor()

	logs, looked := s.sweepAfter(0, measureWorktreePressure(0, storage))
	if !looked || !strings.Contains(logs, resumableWaitLine) {
		t.Fatalf("the first look finds nothing and starts the wait (looked %v):\n%s", looked, logs)
	}
	requireCheckoutOnDisk(t, resting, "the control plane kept it")

	// Its turn is over, and it rests again.
	s.set(func() { s.answers["sess-resting"] = "resumable" })
	if _, looked := s.sweepAfter(worktreeGCInterval, measureWorktreePressure(0, storage)); looked {
		t.Fatal("five minutes into the wait, with no newer measurement, the schedule's sweep must not look")
	}
	requireCheckoutOnDisk(t, resting, "nothing looked")

	sessionCheckoutRoom.Store(&checkoutRoom{storage: storage,
		measure: func() worktreeGCPressure { return measureWorktreePressure(0, storage) },
		sweep:   func(pressure worktreeGCPressure) { s.sweeper.makeRoom(s.transport, s.pool, pressure) }})
	t.Cleanup(func() { sessionCheckoutRoom.Store(nil) })
	logs = captureLogs(t, func() { startNewSession(t, s.resumableFixture, "sess-new") })

	requireCheckoutReclaimed(t, resting, "a checkout that would take the budget under its floor makes room from it, wait or no wait")
	requireCheckoutOnDisk(t, filepath.Join(worktreesDir(), "sess-new"), "and is made")
	if strings.Contains(logs, "nothing more can be reclaimed") {
		t.Fatalf("the room was made, so there is no shortfall to report:\n%s", logs)
	}
}

// Nothing in the runner deletes a session's branch, but with its checkout away git no longer stops anyone working in
// the repository from doing so. Every door that brings the checkout back puts the branch back first, where it stood
// when the checkout went, so that the session comes back on its own work instead of being refused, or starting over
// on a new branch. A restart puts it back too, and then leaves the checkout away as for any resting session.
func TestABranchDeletedWhileItsCheckoutIsAwayComesBackWithIt(t *testing.T) {
	for _, door := range []string{"a claim waking its supervisor", "a claim", "a pinned claim", "a restart, then a claim"} {
		t.Run(door, func(t *testing.T) {
			f := newResumableFixture(t)
			const session = "sess-parked"
			branch := "orbit/" + session
			path := f.checkout(t, session)
			commitFile(t, path, "own.txt", "only on its branch\n", "only on its branch")
			ageCheckout(t, path, 3)
			tip := mustGit(t, path, "rev-parse", "HEAD")
			base := mustGit(t, f.repo, "rev-parse", baseRefName(session))
			if _, err := git(f.repo, "branch", "-D", branch); err == nil {
				t.Fatal("git deleted a branch checked out in a worktree; this test means to show what changes once it is not")
			}
			if door == "a claim waking its supervisor" {
				job := &ClaimedSession{SessionID: session, Branch: branch,
					WT: &Worktree{Path: path, Branch: branch, RepoDir: f.repo, Session: session, BaseSha: base}}
				if _, added := f.pool.register(job, func() {}, false); !added {
					t.Fatal("register a cold supervisor")
				}
			}
			gcResumableCheckouts(f.transport, f.pool, measureWorktreePressure(0, smallBudgetUnderItsFloor()))
			requireCheckoutReclaimed(t, path, "its work is on its branch, under a budget's floor")
			mustGit(t, f.repo, "branch", "-D", branch)

			claim := &ClaimedSession{SessionID: session, Branch: branch}
			logs := captureLogs(t, func() {
				switch door {
				case "a claim waking its supervisor":
					restoreAbsentCheckout(f.pool, claim)
				case "a pinned claim":
					claim.Source = &SessionSource{State: sourceStatePinned, BaseSha: base}
					setupWorktree(claim, f.repo)
				case "a restart, then a claim":
					restarted := &ClaimedSession{SessionID: session, Branch: branch}
					if execDir := f.pool.setupSupervisorCheckout(restarted, f.repo, false); execDir != path || !checkoutAbsent(path) || restarted.SourceRefusal != nil {
						t.Fatalf("a restart leaves a resting session's checkout away: execDir %q, absent %v, refusal %+v", execDir, checkoutAbsent(path), restarted.SourceRefusal)
					}
					if got, err := git(f.repo, "rev-parse", "--verify", branch); err != nil || got != tip {
						t.Fatalf("the restart put the branch back at %s, got %q (%v)", tip, got, err)
					}
					if _, added := f.pool.register(restarted, func() {}, false); !added {
						t.Fatal("register the restart's cold supervisor")
					}
					restoreAbsentCheckout(f.pool, claim)
				default:
					setupWorktree(claim, f.repo)
				}
			})

			if claim.SourceRefusal != nil {
				t.Fatalf("the claim was refused: %+v", claim.SourceRefusal)
			}
			requireCheckoutOnDisk(t, path, "it comes back")
			if got := mustGit(t, path, "symbolic-ref", "--short", "HEAD"); got != branch {
				t.Fatalf("it comes back on its branch, got %q", got)
			}
			if got := mustGit(t, path, "rev-parse", "HEAD"); got != tip {
				t.Fatalf("on the branch's tip as it stood, %s, got %s", tip, got)
			}
			if _, err := os.Stat(filepath.Join(path, "own.txt")); err != nil {
				t.Fatalf("its work is there: %v", err)
			}
			if want := "session " + session + " — its branch " + branch + " was gone while its checkout was away; put it back at " + shortSha(tip); !strings.Contains(logs, want) {
				t.Fatalf("the log must say so (%q), got:\n%s", want, logs)
			}
		})
	}
}
