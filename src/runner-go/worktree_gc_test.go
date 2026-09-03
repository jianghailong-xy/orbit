package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The two sides of the disk gate, stated as readings rather than by pointing the sweep at a real
// filesystem: a test cannot fill the host's disk, and the reading is the half of the comparison
// the machine owns.
func roomyDisk() worktreeGCPressure {
	return worktreeGCPressure{freeBytes: 512 * 1024 * 1024 * 1024, measured: true, floorMb: 4096}
}

func diskUnderTheFloor() worktreeGCPressure {
	return worktreeGCPressure{freeBytes: 64 * 1024 * 1024, measured: true, floorMb: 4096}
}

// gcFixture is a runner's worktrees root with a fake control plane in front of it. The fake
// answers `worktrees-removable` with the rule the real endpoint applies (runner-api.controller):
// a session that still exists and is neither completed, archived, nor deleted is KEPT; everything
// else is removable leftover. Eligibility therefore stays a server judgement in these tests too —
// the runner is never asked to derive it from local state.
type gcFixture struct {
	repo string
	// resumable names the sessions the control plane still reports as Open: idle-parked, ended by
	// the user, or cancelled. The sweep must keep their checkouts.
	resumable map[string]bool
	// unavailable makes the query fail, which is the only answer that must freeze the whole sweep.
	unavailable bool
	queries     atomic.Int64
	transport   *Transport
}

func newGCFixture(t *testing.T) *gcFixture {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	f := &gcFixture{repo: initRepo(t), resumable: map[string]bool{}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/runner/sessions/worktrees-removable" {
			t.Errorf("unexpected sweep request to %s", r.URL.Path)
			http.Error(w, "unexpected", http.StatusNotFound)
			return
		}
		f.queries.Add(1)
		if f.unavailable {
			http.Error(w, "control plane unavailable", http.StatusInternalServerError)
			return
		}
		var req struct {
			IDs []string `json:"ids"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		resp := WorktreesRemovableResponse{Removable: []string{}}
		for _, id := range req.IDs {
			if !f.resumable[id] {
				resp.Removable = append(resp.Removable, id)
			}
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(server.Close)
	f.transport = NewTransport(server.URL, "gc-token")
	return f
}

// checkout adds a session worktree holding one committed file, the way a finalized session leaves
// it: the work is on the branch, the directory is still there. Returns its path.
func (f *gcFixture) checkout(t *testing.T, session string) string {
	t.Helper()
	path := filepath.Join(worktreesDir(), session)
	branch := "orbit/" + session
	mustGit(t, f.repo, "worktree", "add", "-q", "-b", branch, path)
	commitFile(t, path, session+".txt", "work by "+session+"\n", "work by "+session)
	// The base ref removeWorktree drops alongside the checkout; setting it here is what lets a
	// test tell "the checkout went" from "the checkout went and took its branch with it".
	mustGit(t, f.repo, "update-ref", baseRefName(session), "HEAD")
	return path
}

// ignoredArtifact writes the untracked, .gitignored kind of content this whole change exists to
// preserve: expensive to rebuild, and never captured by the finalize commit.
//
// The .gitignore is committed first, and that matters: an artifact that is merely untracked would
// leave `git status` dirty, and removeWorktree refuses a dirty checkout outright — so every test
// below would then survive the sweep for the wrong reason, and pass whatever the disk gate did.
func (f *gcFixture) ignoredArtifact(t *testing.T, path string) string {
	t.Helper()
	commitFile(t, path, ".gitignore", "node_modules/\n", "ignore build output")
	artifact := filepath.Join(path, "node_modules", "left-pad")
	if err := os.MkdirAll(artifact, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", artifact, err)
	}
	if status, err := git(path, "status", "--porcelain"); err != nil || status != "" {
		t.Fatalf("the artifact must leave the checkout clean, got %q (err %v)", status, err)
	}
	return artifact
}

func requireCheckoutOnDisk(t *testing.T, path, why string) {
	t.Helper()
	if info, err := os.Stat(path); err != nil || !info.IsDir() {
		t.Fatalf("%s: %s should still be on disk, stat err = %v", why, path, err)
	}
}

func requireCheckoutReclaimed(t *testing.T, path, why string) {
	t.Helper()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("%s: %s should have been reclaimed, stat err = %v", why, path, err)
	}
}

// THE point of the change. A session that ended terminally is eligible for reclamation, but on a
// disk with room to spare, deleting its checkout buys space nobody needs and charges the next
// session on this repository a rebuild of everything git does not track.
func TestSweepKeepsAnEligibleCheckoutWhileTheDiskIsRoomy(t *testing.T) {
	f := newGCFixture(t)
	path := f.checkout(t, "sess-completed")
	artifact := f.ignoredArtifact(t, path)

	gcWorktrees(f.transport, map[string]bool{}, roomyDisk())

	if f.queries.Load() != 1 {
		t.Fatalf("the sweep asked the control plane %d times, want 1 — eligibility must stay a server judgement", f.queries.Load())
	}
	requireCheckoutOnDisk(t, path, "above the free-space floor")
	requireCheckoutOnDisk(t, artifact, "above the free-space floor the ignored build output survives too")
}

// Below the floor the tradeoff inverts: disk is the scarce resource, so an eligible checkout goes.
// What must NOT go is its branch — the finalize commit is on it, and it has to stay rebuildable.
func TestSweepReclaimsAnEligibleCheckoutUnderPressureAndLeavesItsBranchRebuildable(t *testing.T) {
	f := newGCFixture(t)
	path := f.checkout(t, "sess-completed")

	gcWorktrees(f.transport, map[string]bool{}, diskUnderTheFloor())

	requireCheckoutReclaimed(t, path, "under the free-space floor")
	// The branch survives, still carrying the work the finalize commit put there...
	if _, err := git(f.repo, "rev-parse", "--verify", "orbit/sess-completed"); err != nil {
		t.Fatalf("the branch must outlive its checkout: %v", err)
	}
	// ...and the checkout can be made again from it, which is what "safe to delete" means here.
	rebuilt := filepath.Join(t.TempDir(), "rebuilt")
	mustGit(t, f.repo, "worktree", "add", "-q", rebuilt, "orbit/sess-completed")
	if content, err := os.ReadFile(filepath.Join(rebuilt, "sess-completed.txt")); err != nil || string(content) != "work by sess-completed\n" {
		t.Fatalf("the work must come back with the branch: %q (%v)", content, err)
	}
	// The base ref goes with the checkout — it names a fork point for a diff nothing computes now.
	if _, err := git(f.repo, "rev-parse", "--verify", baseRefName("sess-completed")); err == nil {
		t.Error("the base ref should have been dropped with the checkout")
	}
}

// Safety property, unchanged and not for sale: an Open session's checkout is kept however tight
// the disk gets, because it is where a resume picks the work back up.
func TestSweepNeverReclaimsAResumableCheckoutHoweverTightTheDisk(t *testing.T) {
	for _, ending := range []string{"idle-park", "user-end", "cancel"} {
		t.Run(ending, func(t *testing.T) {
			f := newGCFixture(t)
			session := "sess-" + ending
			f.resumable[session] = true
			path := f.checkout(t, session)
			// A terminal neighbour, so the sweep is proved to have run rather than found nothing.
			doomed := f.checkout(t, "sess-completed")

			gcWorktrees(f.transport, map[string]bool{}, diskUnderTheFloor())

			requireCheckoutReclaimed(t, doomed, "under the floor a terminal checkout goes")
			requireCheckoutOnDisk(t, path, "a "+ending+" session stays resumable under any disk pressure")
		})
	}
}

// The existing fail-CLOSED half of the same policy: the sweep never destroys a checkout it could
// not confirm removable, so a control plane it cannot reach freezes it entirely.
func TestSweepRemovesNothingWhenItCannotConfirmRemovable(t *testing.T) {
	f := newGCFixture(t)
	f.unavailable = true
	path := f.checkout(t, "sess-completed")

	gcWorktrees(f.transport, map[string]bool{}, diskUnderTheFloor())

	if f.queries.Load() == 0 {
		t.Fatal("the sweep never asked, so its silence proves nothing")
	}
	requireCheckoutOnDisk(t, path, "the control plane could not confirm this checkout removable")
}

// Fail OPEN on the disk reading, matching diskBelowFloor() on the control plane and the behaviour
// documented in workspaces.service.ts: a gate that fired on absent telemetry would reclaim
// checkouts precisely on the machines it knows nothing about. Windows has no reading at all.
func TestSweepRemovesNothingWhenFreeSpaceCannotBeMeasured(t *testing.T) {
	f := newGCFixture(t)
	path := f.checkout(t, "sess-completed")

	unmeasurable := worktreeGCPressure{freeBytes: 0, measured: false, floorMb: 4096}
	if unmeasurable.belowFloor() {
		t.Fatal("an unknown reading must not read as a full disk")
	}
	gcWorktrees(f.transport, map[string]bool{}, unmeasurable)

	requireCheckoutOnDisk(t, path, "free space could not be measured")
}

// The predicate itself, against the control plane's diskBelowFloor(): both halves of the
// comparison fail open when they are missing, and only a real reading under a real floor fires.
func TestPressureMirrorsTheControlPlanesDiskFloor(t *testing.T) {
	mib := uint64(1024 * 1024)
	cases := []struct {
		name string
		p    worktreeGCPressure
		want bool
	}{
		{"below the floor", worktreeGCPressure{freeBytes: 100 * mib, measured: true, floorMb: 1024}, true},
		{"exactly at the floor", worktreeGCPressure{freeBytes: 1024 * mib, measured: true, floorMb: 1024}, false},
		{"above the floor", worktreeGCPressure{freeBytes: 2048 * mib, measured: true, floorMb: 1024}, false},
		{"no floor configured", worktreeGCPressure{freeBytes: 0, measured: true, floorMb: 0}, false},
		{"a nonsense floor", worktreeGCPressure{freeBytes: 0, measured: true, floorMb: -1}, false},
		{"no reading", worktreeGCPressure{freeBytes: 0, measured: false, floorMb: 1024}, false},
	}
	for _, c := range cases {
		if got := c.p.belowFloor(); got != c.want {
			t.Errorf("%s: belowFloor() = %v, want %v", c.name, got, c.want)
		}
	}
}

// "No pressure, no reclamation" would otherwise mean unbounded growth: one checkout directory per
// finished session, forever, on any machine whose disk never gets tight. The cap is what makes
// that structurally impossible, so it has to fire on a roomy disk — and take the oldest first.
func TestSweepReclaimsTheSurplusPastTheRetentionCapEvenOnARoomyDisk(t *testing.T) {
	f := newGCFixture(t)
	surplus := 3
	paths := make([]string, 0, maxRetainedEligibleCheckouts+surplus)
	touched := time.Now().Add(-24 * time.Hour)
	for i := 0; i < maxRetainedEligibleCheckouts+surplus; i++ {
		path := f.checkout(t, gcSessionName(i))
		// Oldest first, so the eviction order is a fact about the fixture rather than about the
		// order the filesystem happens to list directories in.
		if err := os.Chtimes(path, touched, touched); err != nil {
			t.Fatalf("chtimes %s: %v", path, err)
		}
		touched = touched.Add(time.Minute)
		paths = append(paths, path)
	}

	gcWorktrees(f.transport, map[string]bool{}, roomyDisk())

	for i, path := range paths {
		if i < surplus {
			requireCheckoutReclaimed(t, path, "the oldest checkouts past the retention cap go even on a roomy disk")
			continue
		}
		requireCheckoutOnDisk(t, path, "the cap reclaims only the surplus, newest kept")
	}
}

func gcSessionName(i int) string {
	return "sess-" + string(rune('a'+i/26)) + string(rune('a'+i%26))
}

// The sweep now runs while merges do. mergeToMain stages its rebase in a throwaway worktree that
// sits beside the session checkouts, and reclaiming one mid-rebase would delete the working tree
// the merge is replaying into — and, through the process teardown, kill the git doing it.
func TestSweepNeverTouchesTheRebaseScratchWorktree(t *testing.T) {
	f := newGCFixture(t)
	scratch := filepath.Join(worktreesDir(), rebaseScratchPrefix+"sess-merging")
	mustGit(t, f.repo, "worktree", "add", "-q", "-b", "orbit/"+rebaseScratchPrefix+"sess-merging", scratch)
	doomed := f.checkout(t, "sess-completed")

	gcWorktrees(f.transport, map[string]bool{}, diskUnderTheFloor())

	requireCheckoutOnDisk(t, scratch, "a rebase in flight is not a leftover session checkout")
	requireCheckoutReclaimed(t, doomed, "its terminal neighbour still goes, so the sweep did run")
}

// A session this runner is driving is never a candidate, whatever the server would say about it
// and however tight the disk is: its engine is writing in that directory right now.
func TestSweepNeverTouchesALiveSessionsCheckout(t *testing.T) {
	f := newGCFixture(t)
	live := f.checkout(t, "sess-live")
	doomed := f.checkout(t, "sess-completed")

	gcWorktrees(f.transport, map[string]bool{"sess-live": true}, diskUnderTheFloor())

	requireCheckoutOnDisk(t, live, "a live session's checkout is not a GC candidate")
	requireCheckoutReclaimed(t, doomed, "its terminal neighbour still goes, so the sweep did run")
}

// Losing the lease returns out of finalization before it reports anything, so the checkout it was
// about to hand over is left standing. That used to leak until the process restarted, because the
// startup sweep was the only sweep. The fix is not a second deleter on that branch — it is that
// the sweep comes back around, so the leak heals itself.
func TestACheckoutStrandedByLeaseLossIsReclaimedByALaterSweep(t *testing.T) {
	f := newGCFixture(t)
	// The state a lease-loss return leaves behind: a finalized session whose checkout nobody
	// removed, and which no longer has a local supervisor.
	stranded := f.checkout(t, "sess-lease-lost")

	sweeper := worktreeSweeper{interval: worktreeGCInterval, armed: true}
	now := time.Now()
	if !sweeper.due(now) {
		t.Fatal("the first sweep of a running runner should be due immediately")
	}
	gcWorktrees(f.transport, map[string]bool{}, roomyDisk())
	requireCheckoutOnDisk(t, stranded, "a roomy disk keeps it, exactly like any other eligible checkout")

	// One interval later the runner is still running — and now short of disk.
	later := now.Add(worktreeGCInterval)
	if !sweeper.due(later) {
		t.Fatal("the sweep must come round again while the runner runs; that recurrence IS the fix")
	}
	gcWorktrees(f.transport, map[string]bool{}, diskUnderTheFloor())

	requireCheckoutReclaimed(t, stranded, "the later sweep reclaims what finalization could not")
	if f.queries.Load() != 2 {
		t.Fatalf("the control plane was asked %d times, want 2 — every sweep re-asks rather than remembering", f.queries.Load())
	}
}

// The schedule itself: a running runner sweeps repeatedly, and the gate that protects the first
// sweep protects the rest. An unarmed sweeper must also not bank the interval it sat out, or
// arming it would immediately fire a burst.
func TestTheSweepRecursWhileTheRunnerRunsAndOnlyOnceArmed(t *testing.T) {
	start := time.Now()

	unarmed := worktreeSweeper{interval: worktreeGCInterval}
	for _, at := range []time.Time{start, start.Add(worktreeGCInterval), start.Add(10 * worktreeGCInterval)} {
		if unarmed.due(at) {
			t.Fatal("a sweep ran with no reclaim list: every session about to be resumed would look like an orphan")
		}
	}
	unarmed.armed = true
	if !unarmed.due(start.Add(10 * worktreeGCInterval)) {
		t.Fatal("arming should let the next sweep run")
	}
	if unarmed.due(start.Add(10 * worktreeGCInterval)) {
		t.Fatal("the sweeps it sat out must not be banked and fired back to back")
	}

	armed := worktreeSweeper{interval: worktreeGCInterval, armed: true}
	sweeps := 0
	// Half-interval laps, the way the claim loop actually comes round (its long-poll caps a lap
	// at 35 seconds). Over an hour of running that has to be more than the one sweep at startup:
	// one per interval, the first of them immediately.
	for at := start; at.Before(start.Add(time.Hour)); at = at.Add(worktreeGCInterval / 2) {
		if armed.due(at) {
			sweeps++
		}
	}
	if want := int(time.Hour / worktreeGCInterval); sweeps != want {
		t.Fatalf("%d sweeps in an hour of running, want %d — startup must not be the only one", sweeps, want)
	}
}

// A terminal end still commits its work permanently onto the branch (TestPermanentEndNotUndone
// covers the commit's own shape), and now leaves the checkout standing. Both halves matter
// together: the commit is what makes a later reclamation safe, and the survival is what saves the
// next session the rebuild.
func TestTerminalFinalizeCommitsToTheBranchAndLeavesTheCheckoutStanding(t *testing.T) {
	f := newGCFixture(t)
	path := f.checkout(t, "sess-completed")
	before := mustGit(t, path, "rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(path, "late.txt"), []byte("late work\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	artifact := f.ignoredArtifact(t, path)
	wt := &Worktree{Path: path, Branch: "orbit/sess-completed", BaseSha: before, RepoDir: f.repo, Session: "sess-completed"}

	finalizeWorktree(wt, false)

	if after := mustGit(t, path, "rev-parse", "HEAD"); after == before {
		t.Fatal("a terminal end must still commit the work onto its branch")
	}
	if msg := mustGit(t, path, "log", "-1", "--format=%B"); strings.Contains(msg, parkCheckpointTrailer) {
		t.Fatalf("a terminal end's commit is permanent, not a park checkpoint:\n%s", msg)
	}
	requireCheckoutOnDisk(t, path, "finalization no longer removes the checkout")
	requireCheckoutOnDisk(t, artifact, "and so the untracked build output it could not commit is still there")
}

// Asked of the source, the way the codebase asks other "this call must still be there" questions
// (see TestEverySessionLoopThatCannotSteerRefusesOne): the properties below are ones a later edit
// breaks silently. Nothing fails, nothing logs — a checkout is simply deleted at the wrong moment,
// or never deleted at all, and only a disk filling up months later says so.
func TestGcWorktreesIsTheOnlyDeleterAndTheRunLoopKeepsCallingIt(t *testing.T) {
	session, err := os.ReadFile("session.go")
	if err != nil {
		t.Fatalf("read session.go: %v", err)
	}
	// Every `return` in the finalization path — the lease-loss ones above all — leaves the
	// checkout standing. That is fine because the sweep comes back for it; it stops being fine
	// the moment any of those branches grows a deleter of its own, because then the two disagree
	// about who owns a directory and about when it is safe to take.
	if strings.Contains(string(session), "removeWorktree(") {
		t.Error("session.go calls removeWorktree: finalization must not delete a checkout, and a " +
			"lease-loss branch in particular must not carry a second copy of the reclamation")
	}

	loop, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatalf("read runloop.go: %v", err)
	}
	body := string(loop)
	start := strings.Index(body, "\tfor loopCtx.Err() == nil {")
	if start < 0 {
		t.Fatal("the claim loop is gone; re-point this test at whatever replaced it")
	}
	if !strings.Contains(body[start:], "if worktreeGC.due(time.Now()) {") {
		t.Error("the claim loop no longer sweeps: a checkout left behind mid-run would leak until " +
			"the process restarts, which is the leak this change exists to close")
	}
	// The gate that protects the first sweep. Without a reclaim list every session this runner is
	// about to resume looks like an orphan.
	if !strings.Contains(body[:start], "armed: reclaimed && !reclaimSkipped") {
		t.Error("the startup sweep is no longer gated on a reclaim that actually answered")
	}
}
