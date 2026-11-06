//go:build linux

package main

import (
	"path/filepath"
	"testing"
	"time"
)

// A sweep under a storage budget, with nothing standing in for the reading: measureWorktreePressure judges the
// budget, and its reading taken again (reread) counts the checkouts the sweep has removed since the budget was
// measured. That is what stops a sweep once it has freed enough, while the channel's next measurement is still to
// come. The budgets are far smaller than any disk these tests run on, so statfs never decides.

// smallBudgetUnderItsFloor is a runner's checkoutStorage holding a budget 4 MiB short of its floor: 60 MiB used of
// 64, against an 8 MiB floor, measured a minute ago.
func smallBudgetUnderItsFloor() *checkoutStorage {
	return budgetStorage(&StorageBudget{LimitBytes: 64 * oneMiB, UsageBytes: 60 * oneMiB,
		MeasuredAt: time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano), FloorBytes: 8 * oneMiB})
}

// withIgnoredBytes gives a resumable fixture's checkout an ignored dependency directory of this apparent size, and
// dates the whole checkout `days` back.
func withIgnoredBytes(t *testing.T, path string, size int64, days int) string {
	t.Helper()
	ignoring(t, path, "node_modules/")
	writeSparse(t, filepath.Join(path, "node_modules", "blob"), size)
	ageCheckout(t, path, days)
	return path
}

// 4 MiB short, 3 MiB a checkout: the oldest leaves the budget 1 MiB short, the next puts it 2 MiB over, and the
// sweep stops there, with no new measurement in between.
func TestUnderAStorageBudgetTheResumableSweepStopsOnceWhatItRemovedCoversTheFloor(t *testing.T) {
	f := newResumableFixture(t)
	oldest := withIgnoredBytes(t, f.checkout(t, "sess-oldest"), 3*oneMiB, 60)
	middle := withIgnoredBytes(t, f.checkout(t, "sess-middle"), 3*oneMiB, 40)
	newest := withIgnoredBytes(t, f.checkout(t, "sess-newest"), 3*oneMiB, 20)
	storage := smallBudgetUnderItsFloor()

	gcResumableCheckouts(f.transport, f.pool, measureWorktreePressure(0, storage))

	requireCheckoutReclaimed(t, oldest, "the oldest goes first")
	requireCheckoutReclaimed(t, middle, "after the oldest the budget is still 1 MiB short")
	requireCheckoutOnDisk(t, newest, "the two removed put the budget back over its floor, so the sweep stops")
	if after := measureWorktreePressure(0, storage); after.belowFloor() || after.freeBytes < 10*oneMiB {
		t.Fatalf("read again, both removals count: %d bytes free, below %v", after.freeBytes, after.belowFloor())
	}
}

// In the order the run loop calls them, with one reading: the first half's removal counts when the second half
// reads again. Without it the second half would see the budget as short as before and take a resumable checkout;
// the case with a removal too small to matter shows that it does.
func TestUnderAStorageBudgetTheSecondHalfTakesNothingOnceTheFirstFreedEnough(t *testing.T) {
	for _, c := range []struct {
		name          string
		finishedBytes int64
		resumableGoes bool
	}{
		{"the finished checkout covers the shortfall", 6 * oneMiB, false},
		{"the finished checkout is too small to", 0, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newResumableFixture(t)
			resumable := withIgnoredBytes(t, f.checkout(t, "sess-resumable"), 3*oneMiB, 20)
			finished := withIgnoredBytes(t, f.checkout(t, "sess-finished"), c.finishedBytes, 20)
			f.set(func() { delete(f.answers, "sess-finished") })
			pressure := measureWorktreePressure(0, smallBudgetUnderItsFloor())

			gcWorktrees(f.transport, f.pool.ids(), pressure)
			requireCheckoutReclaimed(t, finished, "under the budget's floor a finished session's checkout goes first, as it always has")
			gcResumableCheckouts(f.transport, f.pool, pressure)

			if c.resumableGoes {
				requireCheckoutReclaimed(t, resumable, "the budget is still short after the first half")
			} else {
				requireCheckoutOnDisk(t, resumable, "the first half freed enough, though no measurement has said so yet")
			}
		})
	}
}
