//go:build linux

package main

import (
	"testing"
)

// The floor this machine was set to on 2026-11-05: 20480 MB, not the 10240 MB it had. The sweep's
// rule does not know the number — it compares the reading against whatever Runner.minFreeDiskMb
// says — so what this pins is the other half of the change: at THAT floor, a clean checkout of a
// resumable session that has not been written to for the 14 days it waits goes, and the dirty
// checkout beside it stays where it is, because the one thing a reclaim may never take is work
// that exists nowhere else.
func TestResumableSweepAtTheTwentyGigabyteFloorReclaimsACleanFortnightIdleCheckoutAndKeepsADirtyOne(t *testing.T) {
	f := newResumableFixture(t)
	clean := f.checkout(t, "sess-clean-past-the-floor")
	dirty := f.checkout(t, "sess-dirty-past-the-floor")
	// Written and then aged: the write is the reason it stays, not its age.
	writeUnder(t, dirty, "base.txt", "uncommitted work\n")
	ageCheckout(t, dirty, 20)

	// 8 GiB free against a 20480 MB floor: exactly the kind of shortfall the old 10 GiB floor
	// called roomy and reclaimed nothing for.
	const gib = uint64(1 << 30)
	pressure := worktreeGCPressure{measured: true, floorMb: 20480, freeBytes: 8 * gib}
	pressure.reread = func() worktreeGCPressure { return pressure }
	if !pressure.belowFloor() {
		t.Fatal("8 GiB free against a 20480 MB floor must read as below it")
	}

	gcResumableCheckouts(f.transport, f.pool, pressure)

	requireCheckoutReclaimed(t, clean, "a clean resumable checkout idle for 14 days, under the floor this machine now has")
	requireCheckoutOnDisk(t, dirty, "a checkout holding work no branch has, whatever the floor says")
	if out := mustGit(t, dirty, "status", "--porcelain"); out == "" {
		t.Fatal("the kept checkout must still hold the work, or nothing was proved")
	}
}
