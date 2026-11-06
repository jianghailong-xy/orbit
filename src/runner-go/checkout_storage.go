package main

import (
	"io/fs"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// checkoutStorage is what this runner knows of the storage budget its checkouts are held to
// (StorageBudget): the one the control plane last sent, nil when it sent none, and the checkouts
// the sweep removed that the budget's measurement may not count yet. One per run loop: the
// heartbeat stores the budget, and the claim loop's sweep judges free space by it
// (measureWorktreePressure) and counts what it removes.
//
// The count is what lets a sweep stop once it has freed enough. The channel measures the volume
// every couple of minutes, so between two measurements the budget alone would read as short as
// it did before the sweep began, and the sweep would go on taking checkouts it does not need to.
type checkoutStorage struct {
	budget atomic.Pointer[StorageBudget]

	mu sync.Mutex
	// removed is every removal the sweep counted that began after the last budget read was measured.
	removed []removedCheckout
}

// removedCheckout is one checkout the sweep removed: its bytes as the volume's measurement counts
// them, and when its removal began.
type removedCheckout struct {
	began time.Time
	bytes uint64
}

// judge applies the budget the control plane last sent to a statfs reading of the worktrees root.
// Without a budget the reading stands, judged against the machine's own floor as it always was.
// With one, free space is what the budget has left plus the bytes of the checkouts this runner
// began removing after it was measured, and never more than statfs reports: the host's disk can
// still run out first. The floor is then the budget's (worktreeGCPressure.belowFloor).
func (s *checkoutStorage) judge(reading worktreeGCPressure) worktreeGCPressure {
	if s == nil {
		return reading
	}
	budget := s.budget.Load()
	measuredAt, ok := budget.measuredAt()
	if !ok {
		return reading
	}
	left := budget.LimitBytes - budget.UsageBytes + int64(s.removedSince(measuredAt))
	var free uint64
	if left > 0 {
		free = uint64(left)
	}
	if reading.measured && reading.freeBytes < free {
		free = reading.freeBytes
	}
	reading.freeBytes, reading.measured, reading.budget, reading.storage = free, true, budget, s
	return reading
}

// measuredAt is when the budget was measured, and whether it is a budget at all: none, one with no
// limit, one with a usage below zero and one whose time does not parse are all no budget, and the
// sweep keeps the machine's own floor. Without a time, nothing could say which removals the
// measurement already counts.
func (b *StorageBudget) measuredAt() (time.Time, bool) {
	if b == nil || b.LimitBytes <= 0 || b.UsageBytes < 0 {
		return time.Time{}, false
	}
	at, err := time.Parse(time.RFC3339, b.MeasuredAt)
	return at, err == nil
}

// removedSince sums the bytes of the removals that began after at: a measurement finished at at
// still counts those checkouts, which are gone since. The rest it forgets. They were gone, or going,
// when that measurement was taken, so it does not count them, or not all of them, and no later
// measurement will.
func (s *checkoutStorage) removedSince(at time.Time) uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	var sum uint64
	kept := s.removed[:0]
	for _, r := range s.removed {
		if r.began.After(at) {
			sum += r.bytes
			kept = append(kept, r)
		}
	}
	s.removed = kept
	return sum
}

// checkoutRemoval is a checkout about to be removed, measured (checkoutStorage.removing).
type checkoutRemoval struct {
	storage *checkoutStorage
	removedCheckout
}

// removing measures the checkout at path just before the sweep removes it; done counts it once it
// is gone. Without a budget (a nil storage) it measures nothing: the walk reads every file in the
// checkout, which only a budget has a use for.
func (s *checkoutStorage) removing(path string) checkoutRemoval {
	if s == nil {
		return checkoutRemoval{}
	}
	bytes := checkoutBytes(path)
	return checkoutRemoval{storage: s, removedCheckout: removedCheckout{began: time.Now(), bytes: bytes}}
}

// done counts a removal that has taken the whole checkout. One that was refused or stopped partway
// is not counted: whatever it did take, the next measurement reads.
func (r checkoutRemoval) done() {
	if r.storage == nil {
		return
	}
	r.storage.mu.Lock()
	defer r.storage.mu.Unlock()
	r.storage.removed = append(r.storage.removed, r.removedCheckout)
}

// checkoutBytes is what removing the checkout at path takes off its volume's size as Docker
// measures one (GET /system/df, which sizes a local volume with moby's directory.Size): the
// apparent size of every file under it, each inode once, and nothing for a directory. A file with a
// hard link outside the checkout counts nothing, since that link keeps it on the volume. Anything
// that cannot be read counts nothing too: a count too low only makes the sweep take as much as it
// would have without one, while a count too high would stop it short of its floor.
func checkoutBytes(path string) uint64 {
	type inode struct{ dev, ino uint64 }
	var total uint64
	linksSeen := map[inode]uint64{}
	_ = filepath.WalkDir(path, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil || info.Size() <= 0 {
			return nil
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			return nil
		}
		if st.Nlink > 1 {
			key := inode{uint64(st.Dev), uint64(st.Ino)}
			linksSeen[key]++
			if linksSeen[key] != uint64(st.Nlink) {
				return nil
			}
		}
		total += uint64(info.Size())
		return nil
	})
	return total
}
