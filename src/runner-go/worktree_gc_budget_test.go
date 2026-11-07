//go:build linux

package main

import (
	"path/filepath"
	"strings"
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

// smallBudget is a 64 MiB budget against an 8 MiB floor with used of it used, measured ago before now: under its floor
// while more than 56 MiB are used.
func smallBudget(used int64, ago time.Duration) *StorageBudget {
	return &StorageBudget{LimitBytes: 64 * oneMiB, UsageBytes: used, MeasuredAt: time.Now().Add(-ago).UTC().Format(time.RFC3339Nano),
		FloorBytes: 8 * oneMiB}
}

// underTheMachinesFloor is the run loop's reading (measureWorktreePressure) of a disk under the machine's own floor,
// judged against storage.
func underTheMachinesFloor(storage *checkoutStorage) worktreeGCPressure {
	reading := storage.judge(diskUnderTheFloor())
	reading.reread = func() worktreeGCPressure { return underTheMachinesFloor(storage) }
	return reading
}

// Under a storage budget's floor a look at resting checkouts that found nothing waits minutes, not an hour. Here the
// control plane keeps the one checkout there at that look, as it keeps one whose session is on its way to an engine,
// and then the session rests again, which nothing tells the schedule. The schedule's next sweep, five minutes after the
// one that looked, takes the checkout once the volume has been measured since the look. With no newer measurement, the
// same one relayed by every heartbeat included, that sweep does not look, and the one after, ten minutes on, takes it,
// however long the look took within half a sweep interval. A measurement that came in while the look asked the control
// plane is one its last reading saw, and is no newer.
func TestUnderAStorageBudgetsFloorALookThatFoundNothingWaitsMinutesNotAnHour(t *testing.T) {
	judged := smallBudget(60*oneMiB, 3*time.Minute)
	relayed := *judged
	for _, c := range []struct {
		name string
		// next is the budget the heartbeat stores after the look; nil stores none.
		next *StorageBudget
		// lookTakes is how long the look takes, from the start of the sweep the schedule's times count from.
		lookTakes time.Duration
		// duringLook is the budget the heartbeat stores while the look asks the control plane; nil stores none.
		duringLook *StorageBudget
		// takenBy is the sweep after the one that looked, five minutes apart, that is the first to look again, and
		// takes the checkout.
		takenBy int
	}{
		{"a newer measurement comes in, the volume still short", smallBudget(61*oneMiB, time.Minute), 0, nil, 1},
		{"the same measurement, relayed again", &relayed, 0, nil, 2},
		{"nothing comes in", nil, 0, nil, 2},
		{"nothing comes in, and the look took two minutes", nil, 2 * time.Minute, nil, 2},
		{"a newer measurement came in while it looked, which the look's last reading saw", nil, 0, smallBudget(61*oneMiB, time.Minute), 2},
	} {
		t.Run(c.name, func(t *testing.T) {
			s := newResumableSchedule(t)
			resting := withIgnoredBytes(t, s.checkout(t, "sess-resting"), 6*oneMiB, 2)
			storage := budgetStorage(judged)
			s.set(func() {
				s.answers["sess-resting"] = "kept"
				s.atRequest = func([]string) {
					s.clock.Advance(c.lookTakes)
					if c.duringLook != nil {
						storage.budget.Store(c.duringLook)
					}
				}
			})

			logs, looked := s.sweepAfter(0, measureWorktreePressure(0, storage))

			s.set(func() { s.atRequest = nil })
			requireCheckoutOnDisk(t, resting, "the control plane kept it")
			want := "gc: no resumable checkout can go and the storage budget is still under its floor; " + resumableWaitLine +
				s.clock.Now().Add(resumableBudgetSweepWait).UTC().Format(time.RFC3339)
			if !looked || !strings.Contains(logs, want) || strings.Count(logs, "\n") != 1 {
				t.Fatalf("the look found nothing (looked %v) and starts a wait of minutes, in one line (%q), got:\n%s", looked, want, logs)
			}

			s.set(func() { s.answers["sess-resting"] = "resumable" })
			if c.next != nil {
				storage.budget.Store(c.next)
			}
			next := worktreeGCInterval - c.lookTakes
			for sweep := 1; sweep <= c.takenBy; sweep++ {
				if _, looked := s.sweepAfter(next, measureWorktreePressure(0, storage)); looked != (sweep == c.takenBy) {
					t.Fatalf("the sweep %s after the one that looked looked: %v", time.Duration(sweep)*worktreeGCInterval, looked)
				}
				next = worktreeGCInterval
			}
			requireCheckoutReclaimed(t, resting, "under the budget's floor, a resting checkout that can go goes within minutes")
		})
	}
}

// Without a usable budget the hour's wait holds, whatever the heartbeat brings: with no budget at all, and with one
// that cannot be one, the sweep judges the machine's own floor, and nothing it is sent is a measurement. A checkout the
// rule can take from five minutes after the look stays until the hour is up.
func TestWithoutAUsableBudgetALookThatFoundNothingStillWaitsAnHour(t *testing.T) {
	for _, c := range []struct {
		name string
		// budget is the budget the heartbeat sends, measured ago before now; nil is none.
		budget func(ago time.Duration) *StorageBudget
	}{
		{"no budget", func(time.Duration) *StorageBudget { return nil }},
		{"a budget with no limit", func(ago time.Duration) *StorageBudget {
			budget := smallBudget(60*oneMiB, ago)
			budget.LimitBytes = 0
			return budget
		}},
		{"a budget whose time does not parse", func(time.Duration) *StorageBudget {
			budget := smallBudget(60*oneMiB, 0)
			budget.MeasuredAt = "a minute ago"
			return budget
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			s := newResumableSchedule(t)
			s.checkoutTheRuleKeeps("sess-kept")
			storage := budgetStorage(c.budget(2 * time.Hour))

			logs, looked := s.sweepAfter(0, underTheMachinesFloor(storage))

			want := "gc: no resumable checkout can go and the disk is still under its floor; " + resumableWaitLine +
				s.clock.Now().Add(time.Hour).UTC().Format(time.RFC3339)
			if !looked || !strings.Contains(logs, want) {
				t.Fatalf("the look found nothing (looked %v) and starts the hour's wait (%q), got:\n%s", looked, want, logs)
			}
			later := s.checkoutAged("sess-later", 20)
			for elapsed := worktreeGCInterval; elapsed < time.Hour; elapsed += worktreeGCInterval {
				storage.budget.Store(c.budget(2*time.Hour - elapsed))
				if _, looked := s.sweepAfter(worktreeGCInterval, underTheMachinesFloor(storage)); looked {
					t.Fatalf("%s into the hour it looked", elapsed)
				}
			}
			requireCheckoutOnDisk(t, later, "nothing looked for an hour")
			if _, looked := s.sweepAfter(worktreeGCInterval, underTheMachinesFloor(storage)); !looked {
				t.Fatal("the hour is up, and it did not look")
			}
			requireCheckoutReclaimed(t, later, "the first look after the hour finds it")
		})
	}
}

// Over a usable budget's floor nothing looks, as before, however many newer measurements come in: room ends a wait as it
// always has, and a newer measurement ends one only to look at a volume still short.
func TestOverAStorageBudgetsFloorNewerMeasurementsMakeNothingLook(t *testing.T) {
	s := newResumableSchedule(t)
	resting := withIgnoredBytes(t, s.checkout(t, "sess-resting"), 6*oneMiB, 2)
	s.set(func() { s.answers["sess-resting"] = "kept" })
	storage := budgetStorage(smallBudget(60*oneMiB, 2*time.Hour))
	if logs, looked := s.sweepAfter(0, measureWorktreePressure(0, storage)); !looked || !strings.Contains(logs, resumableWaitLine) {
		t.Fatalf("under the floor, the look found nothing (looked %v) and starts a wait, got:\n%s", looked, logs)
	}
	s.set(func() { s.answers["sess-resting"] = "resumable" })

	for elapsed := worktreeGCInterval; elapsed <= time.Hour; elapsed += worktreeGCInterval {
		storage.budget.Store(smallBudget(40*oneMiB, 2*time.Hour-elapsed))
		if _, looked := s.sweepAfter(worktreeGCInterval, measureWorktreePressure(0, storage)); looked {
			t.Fatalf("%s on, with room over the floor, it looked", elapsed)
		}
	}
	requireCheckoutOnDisk(t, resting, "over the floor nothing goes")
}

// A wait that started without a budget went by the machine's rules, which keep checkouts a budget's floor does not. A
// usable budget that comes in under its floor is a newer measurement than none, and the next sweep looks: a first
// budget, and one the runner had before, back with the measurement it had then.
func TestABudgetThatComesInUnderItsFloorEndsAnHoursWait(t *testing.T) {
	measured := smallBudget(60*oneMiB, time.Minute)
	for _, hadItBefore := range []bool{false, true} {
		name := "a first budget"
		if hadItBefore {
			name = "the budget it had before, measured no later"
		}
		t.Run(name, func(t *testing.T) {
			s := newResumableSchedule(t)
			parked := withIgnoredBytes(t, s.checkout(t, "sess-parked"), 6*oneMiB, 2)
			storage := budgetStorage(nil)
			if hadItBefore {
				// Under that budget's floor, a look the control plane keeps the checkout from waits minutes, and the
				// budget goes before they are up.
				s.set(func() { s.answers["sess-parked"] = "kept" })
				storage.budget.Store(measured)
				if logs, _ := s.sweepAfter(0, underTheMachinesFloor(storage)); !strings.Contains(logs, "the storage budget is still under its floor") {
					t.Fatalf("under the budget's floor the look found nothing, got:\n%s", logs)
				}
				s.set(func() { s.answers["sess-parked"] = "resumable" })
				storage.budget.Store(nil)
				s.clock.Advance(worktreeGCInterval)
			}

			logs, looked := s.sweepAfter(worktreeGCInterval, underTheMachinesFloor(storage))

			if !looked || !strings.Contains(logs, resumableWaitLine+s.clock.Now().Add(time.Hour).UTC().Format(time.RFC3339)) {
				t.Fatalf("two days unwritten, the machine's rules keep it, and the look starts the hour's wait (looked %v), got:\n%s", looked, logs)
			}
			requireCheckoutOnDisk(t, parked, "two days unwritten is not two weeks")

			storage.budget.Store(measured)

			if _, looked := s.sweepAfter(worktreeGCInterval, underTheMachinesFloor(storage)); !looked {
				t.Fatal("a budget under its floor came in, and the sweep did not look")
			}
			requireCheckoutReclaimed(t, parked, "under the budget's floor, two days unwritten is enough")
		})
	}
}
