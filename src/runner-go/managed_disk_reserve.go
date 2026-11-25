package main

import (
	"context"
	"fmt"
	"time"
)

// A managed runner's free-space reserve on its data volume.
//
// The data volume (/home/orbit) holds everything the runner writes: its own state under ORBIT_HOME, every
// checkout, the shared caches, and /tmp, which is a directory of the same volume (managed_tmp.go). When it
// fills, the program writing gets ENOSPC and nothing is evicted, but the daemon still has to write its own
// state — session spools, config, the credential it renews. So below a reserve the daemon takes no new work:
// the pool offers no capacity (admissionOccupancy, which the claim loop and the heartbeat both read) and no
// reclaimed RUNNING session starts (sessionPool.waitReclaimPermit, the one-at-a-time line every reclaim's
// starts go through). The memory reserve (memory_reserve.go) gates the same two paths; either one refusing
// holds the work, and each says so in the log in its own words. Sessions already running carry on; what they
// write past the end gets ENOSPC, like any other writer.
//
// Free space is read as the worktree sweep reads it (checkoutStorage.judge): statfs of the volume, held to a
// Docker volume's limit where the channel measures one, since there statfs sees the host's disk.

// dataVolumeReserveBytes is the reserve on a volume of 10 GiB or more; a smaller one keeps a tenth of itself.
const dataVolumeReserveBytes = 1 << 30

// dataVolumeCheckInterval is how often the reserve is checked.
const dataVolumeCheckInterval = 5 * time.Second

// dataVolumeReserve is the reserve kept on a volume of total bytes.
func dataVolumeReserve(total uint64) uint64 {
	if total > 0 && total/10 < dataVolumeReserveBytes {
		return total / 10
	}
	return dataVolumeReserveBytes
}

// dataVolumeHold is why no new work may start on a volume with free bytes left of total, or "" when it may.
// No reading is no hold, as no reading is no floor for the sweep (worktreeGCPressure.belowFloor): a gate that
// fired on absent information would stop a runner that knows nothing about its disk.
func dataVolumeHold(free, total uint64, measured bool) string {
	if !measured {
		return ""
	}
	reserve := dataVolumeReserve(total)
	if free >= reserve {
		return ""
	}
	return fmt.Sprintf("free space on the data volume is %s, below the %s this runner keeps in reserve for its own state: "+
		"it starts no new session and no reclaimed turn until space is freed", sizeText(free), sizeText(reserve))
}

// measureDataVolumeHold reads the volume the worktrees root is on, judged against the storage budget as the
// sweep judges it, and says whether it holds new work.
func measureDataVolumeHold(storage *checkoutStorage) string {
	free, total, ok := diskUsage(worktreesDir())
	reading := storage.judge(worktreeGCPressure{freeBytes: free, measured: ok})
	if reading.budget != nil && reading.budget.LimitBytes > 0 {
		total = uint64(reading.budget.LimitBytes)
	}
	return dataVolumeHold(reading.freeBytes, total, reading.measured)
}

// watchDataVolumeReserve sets the pool's admission hold from measure now and every interval until ctx ends,
// and says in the log when the hold begins and ends.
func watchDataVolumeReserve(ctx context.Context, pool *sessionPool, measure func() string, interval time.Duration) {
	check := func() {
		reason := measure()
		before := pool.setAdmissionHold(reason)
		switch {
		case reason != "" && before == "":
			logln("not taking new work:", reason)
		case reason == "" && before != "":
			logln("taking new work again: free space on the data volume is back above its reserve")
		}
	}
	check()
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				check()
			}
		}
	}()
}
