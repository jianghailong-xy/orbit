package main

import (
	"context"
	"sync"
	"testing"
	"time"
)

// What this machine's integration lock covers (contract §2.2 J1, §3.4 M-S3).
//
// 2026-11-19, runner workstation-gpu: one project's CHECK_PROMOTION ran a merge check that hung, and
// held main's lock for the two hours of its time limit. Every other project's check and landing into
// main sat claimed and idle behind it. A promotion's check writes no ref, so it no longer takes the
// target's lock; the jobs that do write the target still wait for each other.

// phaseLog is a reporter that records the phases a job reaches and signals the first time one is
// reached.
type phaseLog struct {
	mu      sync.Mutex
	phases  []string
	reached map[string]chan struct{}
}

func newPhaseLog(watch ...string) *phaseLog {
	l := &phaseLog{reached: map[string]chan struct{}{}}
	for _, phase := range watch {
		l.reached[phase] = make(chan struct{})
	}
	return l
}

func (l *phaseLog) report(phase string, _ *IntegrationUpstreamMoved) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.phases = append(l.phases, phase)
	if ch, ok := l.reached[phase]; ok {
		select {
		case <-ch:
		default:
			close(ch)
		}
	}
}

func (l *phaseLog) seen() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.phases...)
}

func (l *phaseLog) waitFor(t *testing.T, phase string) {
	t.Helper()
	select {
	case <-l.reached[phase]:
	case <-time.After(30 * time.Second):
		t.Fatalf("the job never reached %s (phases %v)", phase, l.seen())
	}
}

// hungCheck is a merge check that never finishes on its own, as the Robolectric test that waited
// on a paused clock did. Only the runner's stop ends it.
var hungCheck = IntegrationCheckSpec{Name: "MERGE_CHECK", Command: "sleep 100000", ExpectedExitCode: 0, TimeoutSeconds: 7200}

// twoProjectBranches puts one commit of each project on a branch of its own, touching different files.
func twoProjectBranches(t *testing.T, r *integrationRepo) (shaA, shaB string) {
	t.Helper()
	r.checkoutNew("project/a", "main")
	r.write("a.txt", "project a\n")
	shaA = r.commit("project a's work")
	r.push("project/a")
	r.checkout("main")
	r.checkoutNew("project/b", "main")
	r.write("b.txt", "project b\n")
	shaB = r.commit("project b's work")
	r.push("project/b")
	r.checkout("main")
	return shaA, shaB
}

// startJob runs one job in the background until stop ends.
func startJob(stop context.Context, cmd IntegrationJobCommand, log *phaseLog) <-chan integrationResult {
	done := make(chan integrationResult, 1)
	go func() { done <- runIntegrationJobUntil(stop, cmd, log.report) }()
	return done
}

func stillRunning(t *testing.T, done <-chan integrationResult, what string) {
	t.Helper()
	select {
	case result := <-done:
		t.Fatalf("%s ended (%s %s %s); the test needs it still running", what, result.State, result.Phase, result.ErrorCode)
	default:
	}
}

// TestAHungCheckDoesNotHoldUpAnotherProjectIntoTheSameTarget is the acceptance case: project A's
// check into main never finishes, and project B's check and then B's landing into main both reach
// their result while it is still running.
func TestAHungCheckDoesNotHoldUpAnotherProjectIntoTheSameTarget(t *testing.T) {
	r := newIntegrationRepo(t)
	shaA, shaB := twoProjectBranches(t, r)

	stopA, stopTheHungCheck := context.WithCancel(context.Background())
	defer stopTheHungCheck()
	checkA := r.promotionCommand("CHECK_PROMOTION", "project/a", "PROJECT_BRANCH")
	checkA.JobID, checkA.SourceSha = "check-a", shaA
	checkA.Checks = []IntegrationCheckSpec{hungCheck}
	logA := newPhaseLog("CHECK")
	doneA := startJob(stopA, checkA, logA)
	logA.waitFor(t, "CHECK")

	// B's check: its own job, into the same target, on the same machine and checkout.
	checkB := r.promotionCommand("CHECK_PROMOTION", "project/b", "PROJECT_BRANCH")
	checkB.JobID, checkB.SourceSha = "check-b", shaB
	checkB.Checks = []IntegrationCheckSpec{{Name: "MERGE_CHECK", Command: "test -f b.txt", ExpectedExitCode: 0, TimeoutSeconds: 60}}
	var checkedB integrationResult
	select {
	case checkedB = <-startJob(context.Background(), checkB, newPhaseLog()):
	case <-time.After(30 * time.Second):
		t.Fatal("project B's check waited behind project A's hung check")
	}
	if checkedB.State != "READY" {
		t.Fatalf("B's check = %s (%s %s), want READY", checkedB.State, checkedB.ErrorCode, checkedB.Phase)
	}
	stillRunning(t, doneA, "project A's check")

	// B's landing, confirmed onto the tip its check ran against: it writes main, and nothing that
	// writes main is running.
	landB := r.promotionCommand("LAND_PROMOTION", "project/b", "PROJECT_BRANCH")
	landB.JobID, landB.SourceSha = "land-b", shaB
	landB.UpstreamShaChecked, landB.MergeTreeSha = checkedB.UpstreamSha, checkedB.TestedTreeSha
	var landedB integrationResult
	select {
	case landedB = <-startJob(context.Background(), landB, newPhaseLog()):
	case <-time.After(30 * time.Second):
		t.Fatal("project B's landing waited behind project A's hung check")
	}
	if landedB.State != "LANDED" || r.originRev("refs/heads/main") != landedB.LandedSha {
		t.Fatalf("B's landing = %s (%s %s), origin main %s, want LANDED at %s",
			landedB.State, landedB.ErrorCode, landedB.Phase, r.originRev("refs/heads/main"), landedB.LandedSha)
	}
	stillRunning(t, doneA, "project A's check")

	// A's check is still where it hung; only the runner's stop ends it, and it lands nothing.
	stopTheHungCheck()
	select {
	case result := <-doneA:
		if !result.Interrupted || result.LandedSha != "" {
			t.Fatalf("A's check = %+v, want it interrupted with nothing landed", result)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("A's check did not stop")
	}
}

// TestJobsThatWriteATargetStillWaitForEachOther rules out the other side: two jobs never write the
// same target ref at once. A's confirmed landing found main moved since its check, so it checks
// again while holding main's lock (M5) — and that check hangs. B's landing into main does not even
// fetch until A has ended.
func TestJobsThatWriteATargetStillWaitForEachOther(t *testing.T) {
	r := newIntegrationRepo(t)
	checkedTip := r.rev("main")
	shaA, shaB := twoProjectBranches(t, r)
	// main moves after A's check ran against checkedTip.
	r.write("main.txt", "another landing\n")
	r.commit("another landing on main")
	r.push("main")
	movedTip := r.rev("main")

	stopA, endA := context.WithCancel(context.Background())
	defer endA()
	landA := r.promotionCommand("LAND_PROMOTION", "project/a", "PROJECT_BRANCH")
	landA.JobID, landA.SourceSha, landA.UpstreamShaChecked = "land-a", shaA, checkedTip
	landA.Checks = []IntegrationCheckSpec{hungCheck}
	logA := newPhaseLog("CHECK")
	doneA := startJob(stopA, landA, logA)
	logA.waitFor(t, "CHECK")

	landB := r.promotionCommand("LAND_PROMOTION", "project/b", "PROJECT_BRANCH")
	landB.JobID, landB.SourceSha, landB.UpstreamShaChecked = "land-b", shaB, movedTip
	logB := newPhaseLog("FETCH")
	doneB := startJob(context.Background(), landB, logB)

	time.Sleep(2 * time.Second)
	if phases := logB.seen(); len(phases) != 0 {
		t.Fatalf("B's landing reached %v while A's landing held main", phases)
	}
	stillRunning(t, doneB, "project B's landing")
	if got := r.originRev("refs/heads/main"); got != movedTip {
		t.Fatalf("origin main = %s while A held it, want it untouched at %s", got, movedTip)
	}

	endA()
	select {
	case result := <-doneA:
		if !result.Interrupted || result.LandedSha != "" {
			t.Fatalf("A's landing = %+v, want it interrupted with nothing landed", result)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("A's landing did not stop")
	}
	select {
	case result := <-doneB:
		if result.State != "LANDED" || r.originRev("refs/heads/main") != result.LandedSha {
			t.Fatalf("B's landing = %s (%s %s), want LANDED once A let main go", result.State, result.ErrorCode, result.Phase)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("B's landing never ran after A ended")
	}
}

// TestIntegrationLockKeys pins which jobs share a slot on this machine. Every job that writes a
// target shares that target's key, whatever project it is for; a promotion's check shares only with
// another check of the same branch.
func TestIntegrationLockKeys(t *testing.T) {
	r := newIntegrationRepo(t)
	landA := r.promotionCommand("LAND_PROMOTION", "project/a", "PROJECT_BRANCH")
	landB := r.promotionCommand("LAND_PROMOTION", "project/b", "PROJECT_BRANCH")
	landTaskIntoMain := r.command("task/t", "main")
	checkA := r.promotionCommand("CHECK_PROMOTION", "project/a", "PROJECT_BRANCH")
	checkAAgain := r.promotionCommand("CHECK_PROMOTION", "project/a", "PROJECT_BRANCH")
	checkB := r.promotionCommand("CHECK_PROMOTION", "project/b", "PROJECT_BRANCH")

	writers := []IntegrationJobCommand{landA, landB, landTaskIntoMain}
	for _, w := range writers {
		if got := integrationLockRef(w); got != "refs/heads/main" {
			t.Fatalf("%s from %s takes %q, want main's own key", w.Kind, w.SourceRef, got)
		}
		for _, c := range []IntegrationJobCommand{checkA, checkB} {
			if integrationLockRef(c) == integrationLockRef(w) {
				t.Fatalf("a check of %s shares the key of a %s into main", c.SourceRef, w.Kind)
			}
		}
	}
	if integrationLockRef(checkA) == integrationLockRef(checkB) {
		t.Fatal("two projects' checks share one key")
	}
	if integrationLockRef(checkA) != integrationLockRef(checkAAgain) {
		t.Fatal("two checks of the same branch do not share a key")
	}
}
