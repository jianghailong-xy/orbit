package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A storage budget in the sweep's reading (checkoutStorage, docs/session-checkout-storage-design.md §5): free
// space is what the budget has left plus what the sweep removed since it was measured, never more than statfs
// reports, judged against the budget's own floor. Without one, the reading and its floor are the machine's, as
// they always were.

const (
	oneMiB = 1 << 20
	oneGiB = 1 << 30
)

// budgetMeasured is a budget measured at `at`: a 20 GiB volume, the managed runner's default, with `usage` of it
// used, and a 5 GiB floor, the design's default of a quarter (D5).
func budgetMeasured(usage int64, at time.Time) *StorageBudget {
	return &StorageBudget{LimitBytes: 20 * oneGiB, UsageBytes: usage, MeasuredAt: at.UTC().Format(time.RFC3339Nano), FloorBytes: 5 * oneGiB}
}

// budgetStorage is a runner's checkoutStorage holding this budget.
func budgetStorage(budget *StorageBudget) *checkoutStorage {
	storage := &checkoutStorage{}
	storage.budget.Store(budget)
	return storage
}

// writeSparse writes a file of this apparent size that takes no space: Docker's measurement and checkoutBytes
// count apparent sizes, so a test can stand a gigabyte in for nothing.
func writeSparse(t *testing.T, file string, size int64) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(file)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := f.Truncate(size); err != nil {
		t.Fatal(err)
	}
}

// removeCounted removes a checkout of this apparent size the way the sweep does, counted against storage.
func removeCounted(t *testing.T, storage *checkoutStorage, size int64) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "sess")
	writeSparse(t, filepath.Join(path, "node_modules", "blob"), size)
	removal := storage.removing(path)
	if err := os.RemoveAll(path); err != nil {
		t.Fatal(err)
	}
	removal.done()
}

// roomyStatfs is the worktrees root's own reading with far more room than any budget below: on a Docker volume,
// the host's disk.
func roomyStatfs() worktreeGCPressure {
	return worktreeGCPressure{freeBytes: 500 * oneGiB, measured: true, floorMb: 4096}
}

// No budget, and every budget that cannot be one, leave the reading exactly as it was: the machine's free space,
// judged against the machine's floor, with both halves failing open as before.
func TestWithoutAStorageBudgetTheReadingIsTheMachinesOwn(t *testing.T) {
	readings := map[string]worktreeGCPressure{
		"below the floor":      {freeBytes: 100 * oneMiB, measured: true, floorMb: 1024},
		"exactly at the floor": {freeBytes: 1024 * oneMiB, measured: true, floorMb: 1024},
		"above the floor":      {freeBytes: 2048 * oneMiB, measured: true, floorMb: 1024},
		"no floor configured":  {freeBytes: 0, measured: true, floorMb: 0},
		"no reading":           {freeBytes: 0, measured: false, floorMb: 1024},
	}
	// Each of these, read as a budget, would be under its floor or over its limit, so any use of it shows.
	at := time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
	storages := map[string]*checkoutStorage{
		"no storage":                 nil,
		"no budget sent":             {},
		"a budget with no limit":     budgetStorage(&StorageBudget{UsageBytes: oneGiB, MeasuredAt: at, FloorBytes: 5 * oneGiB}),
		"a usage below zero":         budgetStorage(&StorageBudget{LimitBytes: oneGiB, UsageBytes: -1, MeasuredAt: at, FloorBytes: 5 * oneGiB}),
		"no time of measurement":     budgetStorage(&StorageBudget{LimitBytes: 20 * oneGiB, UsageBytes: 19 * oneGiB, FloorBytes: 5 * oneGiB}),
		"a time that does not parse": budgetStorage(&StorageBudget{LimitBytes: 20 * oneGiB, UsageBytes: 19 * oneGiB, MeasuredAt: "a minute ago", FloorBytes: 5 * oneGiB}),
	}
	for storageName, storage := range storages {
		for name, reading := range readings {
			got := storage.judge(reading)
			if got.freeBytes != reading.freeBytes || got.measured != reading.measured || got.floorMb != reading.floorMb {
				t.Errorf("%s, %s: the reading became %d bytes (measured %v, floor %d MB), want %d bytes (measured %v, floor %d MB)",
					storageName, name, got.freeBytes, got.measured, got.floorMb, reading.freeBytes, reading.measured, reading.floorMb)
			}
			if got.budget != nil || got.storage != nil {
				t.Errorf("%s, %s: judged against a budget, which there is none of", storageName, name)
			}
			if got.belowFloor() != reading.belowFloor() {
				t.Errorf("%s, %s: belowFloor() = %v, want %v as before", storageName, name, got.belowFloor(), reading.belowFloor())
			}
		}
	}
}

// With a budget, free space is the smaller of statfs and what the budget leaves, and the floor is the budget's:
// the machine's floor is not read.
func TestAStorageBudgetIsJudgedAgainstItsOwnFloor(t *testing.T) {
	measured := time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
	noStatfs := worktreeGCPressure{measured: false, floorMb: 4096}
	for _, c := range []struct {
		name    string
		reading worktreeGCPressure
		usage   int64
		floor   int64
		free    uint64
		below   bool
	}{
		{"8 GiB left over a 5 GiB floor", roomyStatfs(), 12 * oneGiB, 5 * oneGiB, 8 * oneGiB, false},
		{"exactly at the floor", roomyStatfs(), 15 * oneGiB, 5 * oneGiB, 5 * oneGiB, false},
		// The machine's 4096 MB floor would call this at the floor, and keep everything.
		{"4 GiB left under a 5 GiB floor", roomyStatfs(), 16 * oneGiB, 5 * oneGiB, 4 * oneGiB, true},
		{"over the limit", roomyStatfs(), 21 * oneGiB, 5 * oneGiB, 0, true},
		{"the host's disk runs out first", worktreeGCPressure{freeBytes: 3 * oneGiB, measured: true, floorMb: 4096}, 12 * oneGiB, 5 * oneGiB, 3 * oneGiB, true},
		{"no statfs reading, the budget above its floor", noStatfs, 12 * oneGiB, 5 * oneGiB, 8 * oneGiB, false},
		{"no statfs reading, the budget under its floor", noStatfs, 17 * oneGiB, 5 * oneGiB, 3 * oneGiB, true},
		{"no floor is no gate", roomyStatfs(), 21 * oneGiB, 0, 0, false},
		// A floor no disk is above: without a budget this reads as under it.
		{"the machine's floor is not read", worktreeGCPressure{freeBytes: 500 * oneGiB, measured: true, floorMb: 1 << 30}, 12 * oneGiB, 5 * oneGiB, 8 * oneGiB, false},
	} {
		storage := budgetStorage(&StorageBudget{LimitBytes: 20 * oneGiB, UsageBytes: c.usage, MeasuredAt: measured, FloorBytes: c.floor})
		got := storage.judge(c.reading)
		if got.freeBytes != c.free || !got.measured {
			t.Errorf("%s: %d bytes free (measured %v), want %d", c.name, got.freeBytes, got.measured, c.free)
		}
		if got.belowFloor() != c.below {
			t.Errorf("%s: belowFloor() = %v, want %v", c.name, got.belowFloor(), c.below)
		}
		if got.budget != storage.budget.Load() || got.storage != storage {
			t.Errorf("%s: the reading must carry the budget it was judged against, and where the sweep counts removals", c.name)
		}
	}
}

// Between two measurements, a checkout the sweep removed is still in the budget's usage: its bytes count as free
// from the moment it is gone, and a removal that did not take the checkout counts nothing.
func TestCheckoutsRemovedSinceTheMeasurementCountAsFree(t *testing.T) {
	storage := budgetStorage(budgetMeasured(16*oneGiB, time.Now().Add(-time.Minute)))
	if got := storage.judge(roomyStatfs()); got.freeBytes != 4*oneGiB || !got.belowFloor() {
		t.Fatalf("4 GiB left of 20 must read as 4 GiB, under the 5 GiB floor: %d bytes, below %v", got.freeBytes, got.belowFloor())
	}

	removeCounted(t, storage, oneGiB/2)
	if got := storage.judge(roomyStatfs()); got.freeBytes != 4*oneGiB+oneGiB/2 || !got.belowFloor() {
		t.Fatalf("half a GiB removed: %d bytes free, below %v; want 4.5 GiB, still under the floor", got.freeBytes, got.belowFloor())
	}

	refused := filepath.Join(t.TempDir(), "sess-refused")
	writeSparse(t, filepath.Join(refused, "node_modules", "blob"), 4*oneGiB)
	_ = storage.removing(refused) // measured, and then the checkout stayed: never done
	if got := storage.judge(roomyStatfs()); got.freeBytes != 4*oneGiB+oneGiB/2 {
		t.Fatalf("a checkout that stayed counted as removed: %d bytes free, want 4.5 GiB", got.freeBytes)
	}

	removeCounted(t, storage, oneGiB)
	if got := storage.judge(roomyStatfs()); got.freeBytes != 5*oneGiB+oneGiB/2 || got.belowFloor() {
		t.Fatalf("another GiB removed: %d bytes free, below %v; want 5.5 GiB, above the floor", got.freeBytes, got.belowFloor())
	}

	// Over the limit, what is removed pays the overrun back first.
	over := budgetStorage(budgetMeasured(21*oneGiB, time.Now().Add(-time.Minute)))
	removeCounted(t, over, 3*oneGiB)
	if got := over.judge(roomyStatfs()); got.freeBytes != 2*oneGiB {
		t.Fatalf("1 GiB over the limit, then 3 GiB removed: %d bytes free, want 2 GiB", got.freeBytes)
	}

	// And statfs still caps it.
	if got := storage.judge(worktreeGCPressure{freeBytes: oneGiB, measured: true}); got.freeBytes != oneGiB {
		t.Fatalf("the host's disk has 1 GiB: %d bytes free, want 1 GiB", got.freeBytes)
	}
}

// A measurement taken after a removal already has it out of the usage: from then on it is not added again, and
// what is removed after that measurement counts as before.
func TestANewerMeasurementResetsTheCount(t *testing.T) {
	storage := budgetStorage(budgetMeasured(16*oneGiB, time.Now().Add(-time.Minute)))
	removeCounted(t, storage, 2*oneGiB)
	if got := storage.judge(roomyStatfs()); got.freeBytes != 6*oneGiB {
		t.Fatalf("2 GiB removed since the measurement: %d bytes free, want 6 GiB", got.freeBytes)
	}

	storage.budget.Store(budgetMeasured(14*oneGiB, time.Now()))
	if got := storage.judge(roomyStatfs()); got.freeBytes != 6*oneGiB {
		t.Fatalf("the newer measurement counts the removal already: %d bytes free, want 6 GiB, not 8", got.freeBytes)
	}
	if len(storage.removed) != 0 {
		t.Fatalf("a removal the latest measurement counts is still kept: %+v", storage.removed)
	}

	removeCounted(t, storage, oneGiB)
	if got := storage.judge(roomyStatfs()); got.freeBytes != 7*oneGiB {
		t.Fatalf("1 GiB removed after the newer measurement: %d bytes free, want 7 GiB", got.freeBytes)
	}
}

// The bytes a removal takes off a volume as Docker sizes one: apparent sizes, each inode once, nothing for a
// directory, and nothing for a file a hard link outside the checkout keeps.
func TestCheckoutBytesSizesACheckoutAsDockerSizesAVolume(t *testing.T) {
	dir := t.TempDir()
	checkout := filepath.Join(dir, "sess")
	writeUnderCheckout := func(rel string, size int) string {
		file := filepath.Join(checkout, rel)
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(strings.Repeat("x", size)), 0o644); err != nil {
			t.Fatal(err)
		}
		return file
	}
	one := writeUnderCheckout("one", 100)
	writeUnderCheckout(filepath.Join("sub", "deeper", "file"), 50)
	if err := os.Link(one, filepath.Join(checkout, "sub", "one-again")); err != nil {
		t.Fatal(err)
	}
	shared := writeUnderCheckout("shared", 300)
	if err := os.Link(shared, filepath.Join(dir, "kept-outside")); err != nil {
		t.Fatal(err)
	}
	writeSparse(t, filepath.Join(checkout, "node_modules", "blob"), 5*oneMiB)
	if err := os.Symlink("one", filepath.Join(checkout, "link")); err != nil {
		t.Fatal(err)
	}
	writeUnderCheckout("empty", 0)

	want := uint64(100 + 5*oneMiB + len("one") + 50)
	if got := checkoutBytes(checkout); got != want {
		t.Fatalf("checkoutBytes = %d, want %d: 100 for the file linked twice inside, 5 MiB apparent for the sparse one, "+
			"3 for the symlink, 50 for the nested file, and nothing for the file linked from outside", got, want)
	}
	if got := checkoutBytes(filepath.Join(dir, "gone")); got != 0 {
		t.Fatalf("a checkout that is not there takes %d bytes off, want 0", got)
	}
}

// The sweep's reading, as the run loop takes it: with no budget the machine's statfs and floor as before, and
// nothing measured when a checkout goes; with one, the budget's reading, and the reading taken again counts the
// checkout the sweep just removed.
func TestTheSweepsReadingCountsWhatItRemovesOnlyUnderABudget(t *testing.T) {
	t.Run("no budget", func(t *testing.T) {
		f := newGCFixture(t)
		path := f.checkout(t, "sess-completed")
		var storage checkoutStorage
		// A floor no disk is above: 1 PiB.
		pressure := measureWorktreePressure(1<<30, &storage)
		if !pressure.measured || !pressure.belowFloor() || pressure.budget != nil || pressure.storage != nil {
			t.Fatalf("without a budget the reading is statfs against the machine's floor: %+v", pressure)
		}
		gcWorktrees(f.transport, map[string]bool{}, pressure)
		requireCheckoutReclaimed(t, path, "under the machine's own floor, as before")
		if len(storage.removed) != 0 {
			t.Fatalf("without a budget nothing is measured or counted: %+v", storage.removed)
		}
	})
	t.Run("a budget", func(t *testing.T) {
		f := newGCFixture(t)
		path := f.checkout(t, "sess-completed")
		writeSparse(t, filepath.Join(f.ignoredArtifact(t, path), "blob"), 4*oneMiB)
		// A directory that is no repository's worktree goes by the sweep's other door, and counts the same.
		orphan := filepath.Join(worktreesDir(), "sess-orphan")
		writeSparse(t, filepath.Join(orphan, "blob"), 2*oneMiB)
		removed := checkoutBytes(path) + checkoutBytes(orphan)
		var storage checkoutStorage
		// Far smaller than any disk this runs on, so statfs never decides: 4 MiB left of 64, under an 8 MiB floor.
		storage.budget.Store(&StorageBudget{LimitBytes: 64 * oneMiB, UsageBytes: 60 * oneMiB,
			MeasuredAt: time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano), FloorBytes: 8 * oneMiB})
		pressure := measureWorktreePressure(0, &storage)
		if pressure.freeBytes != 4*oneMiB || !pressure.belowFloor() || pressure.storage != &storage {
			t.Fatalf("the budget's reading is 4 MiB under an 8 MiB floor, got %d bytes, below %v", pressure.freeBytes, pressure.belowFloor())
		}

		gcWorktrees(f.transport, map[string]bool{}, pressure)

		requireCheckoutReclaimed(t, path, "an eligible checkout under the budget's floor")
		requireCheckoutReclaimed(t, orphan, "an orphan directory under the budget's floor")
		if again := pressure.again(); again.freeBytes != 4*oneMiB+removed || again.belowFloor() {
			t.Fatalf("read again, the %d bytes the sweep removed must count: %d bytes free, want %d, below %v",
				removed, again.freeBytes, 4*oneMiB+removed, again.belowFloor())
		}
	})
}

// The wire shape the control plane sends (design §5), and what an answer without it means.
func TestTheHeartbeatAnswerCarriesTheStorageBudget(t *testing.T) {
	var resp HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"cancelSessionIds":[],"minFreeDiskMb":2048,"storageBudget":`+
		`{"limitBytes":21474836480,"usageBytes":17179869184,"measuredAt":"2026-11-06T09:00:00.123Z","floorBytes":5368709120}}`), &resp); err != nil {
		t.Fatal(err)
	}
	want := StorageBudget{LimitBytes: 20 * oneGiB, UsageBytes: 16 * oneGiB, MeasuredAt: "2026-11-06T09:00:00.123Z", FloorBytes: 5 * oneGiB}
	if resp.StorageBudget == nil || *resp.StorageBudget != want {
		t.Fatalf("storageBudget decoded as %+v, want %+v", resp.StorageBudget, want)
	}
	if at, ok := resp.StorageBudget.measuredAt(); !ok || !at.Equal(time.Date(2026, 11, 6, 9, 0, 0, 123e6, time.UTC)) {
		t.Fatalf("measuredAt read as %v (%v)", at, ok)
	}

	var older HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"cancelSessionIds":[],"minFreeDiskMb":2048}`), &older); err != nil {
		t.Fatal(err)
	}
	if older.StorageBudget != nil {
		t.Fatalf("an answer without a budget must read as none: %+v", older.StorageBudget)
	}
}

// Asked of the source, as the run loop's other wiring is: the budget is stored from every answer, beside the
// floor, into the one checkoutStorage both sweeps read.
func TestTheRunLoopKeepsTheStorageBudgetBesideTheFloor(t *testing.T) {
	src, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	floor := strings.Index(body, "diskFloorMb.Store(floorMb)\n")
	store := strings.Index(body, "storage.budget.Store(resp.StorageBudget)\n")
	leases := strings.Index(body, "for _, id := range resp.LeaseLostSessionIDs {")
	if floor < 0 || store < floor || leases < store {
		t.Error("each answer's budget must be stored where its floor is, before anything else is done with the answer")
	}
	if got := strings.Count(body, "storage.budget.Store("); got != 1 {
		t.Errorf("the heartbeat must be the one writer of the budget: found %d", got)
	}
	if got := strings.Count(body, "var storage checkoutStorage\n"); got != 1 {
		t.Errorf("one checkoutStorage per run loop, or a sweep forgets what the last one removed: found %d", got)
	}
	if got := strings.Count(body, "measureWorktreePressure(diskFloorMb.Load(), &storage)"); got != 2 {
		t.Errorf("both sweeps must read the budget: found %d", got)
	}
}
