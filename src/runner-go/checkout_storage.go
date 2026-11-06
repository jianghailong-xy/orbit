package main

import (
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// checkoutStorage is what this runner knows of the storage budget its checkouts are held to
// (StorageBudget): the one the control plane last sent, nil when it sent none, and the checkouts
// the sweep removed, and the session checkouts it made, that the budget's measurement may not
// count yet. One per run loop: the heartbeat stores the budget, and the claim loop's sweep judges
// free space by it (measureWorktreePressure) and counts what it removes, as a new checkout does
// what it adds (checkoutRoom).
//
// The count is what lets a sweep stop once it has freed enough. The channel measures the volume
// every couple of minutes, so between two measurements the budget alone would read as short as
// it did before the sweep began, and the sweep would go on taking checkouts it does not need to.
// The other way round, checkouts made faster than that would read as taking nothing.
type checkoutStorage struct {
	budget atomic.Pointer[StorageBudget]

	mu sync.Mutex
	// removed is every removal the sweep counted that began after the last budget read was measured.
	removed []removedCheckout
	// added is every session checkout this runner counted that was finished after the last budget
	// read was measured.
	added []addedCheckout
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
// began removing after it was measured, less those of the session checkouts it finished making
// after then, and never more than statfs reports: the host's disk can still run out first. The
// floor is then the budget's (worktreeGCPressure.belowFloor).
func (s *checkoutStorage) judge(reading worktreeGCPressure) worktreeGCPressure {
	if s == nil {
		return reading
	}
	budget := s.budget.Load()
	measuredAt, ok := budget.measuredAt()
	if !ok {
		return reading
	}
	left := budget.LimitBytes - budget.UsageBytes + int64(s.removedSince(measuredAt)) - int64(s.addedSince(measuredAt))
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

// addedCheckout is one session checkout this runner made: its bytes as the volume's measurement counts them, and
// when it was finished.
type addedCheckout struct {
	finished time.Time
	bytes    uint64
}

// addedSince sums the bytes of the checkouts finished after at, the other way round from removedSince: a
// measurement finished at at counts none of those, or not all of one still being written then. The rest it forgets,
// since that measurement counts them, and so does every later one.
func (s *checkoutStorage) addedSince(at time.Time) uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	var sum uint64
	kept := s.added[:0]
	for _, a := range s.added {
		if a.finished.After(at) {
			sum += a.bytes
			kept = append(kept, a)
		}
	}
	s.added = kept
	return sum
}

// made counts the session checkout just made at path, so that every judgement before the channel's next measurement
// reads its bytes as used (judge). It measures the checkout as that measurement will (checkoutBytes), and only under
// a budget: without one, the walk would serve nothing.
func (s *checkoutStorage) made(path string) {
	if s == nil {
		return
	}
	if _, ok := s.budget.Load().measuredAt(); !ok {
		return
	}
	bytes := checkoutBytes(path)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.added = append(s.added, addedCheckout{finished: time.Now(), bytes: bytes})
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

// sessionCheckoutRoom is the run loop's checkoutRoom: addSessionCheckout makes room with it before a session checkout
// and counts the checkout on it after. Unset, in tests and outside a run loop, a checkout is made as it always was
// and counted nowhere.
var sessionCheckoutRoom atomic.Pointer[checkoutRoom]

// checkoutRoom is what makes room for a new session checkout under a storage budget before the checkout is made
// (docs/session-checkout-storage-design.md §5). Without it, checkouts made faster than the sweep runs (every five
// minutes) and the channel measures (every two) could fill the volume before either saw them.
type checkoutRoom struct {
	// storage is the budget a checkout is judged and counted against.
	storage *checkoutStorage
	// measure reads it as the sweep does (measureWorktreePressure).
	measure func() worktreeGCPressure
	// sweep is the run loop's sweep, both halves as its schedule runs them, run now on the reading it is given
	// (worktreeSweeper.makeRoom).
	sweep func(worktreeGCPressure)
}

// makeRoomFor is what addSessionCheckout does before it makes a checkout of rev, with the paths declared leaves out.
// Under a budget with a floor, when the free space as judged, less what the checkout will take (checkoutEstimate),
// would be under that floor, the sweep runs first on a reading that counts the checkout as made already. It takes
// every eligible checkout of an ended session, then resting sessions' checkouts until the new one fits
// (gcResumableCheckouts). A checkout is never refused for want of room: when nothing more can go, it is made all the
// same, and the log says how far short of the floor that leaves the budget. Without a budget nothing here runs.
func (r *checkoutRoom) makeRoomFor(sessionID, repoRoot, rev string, declared []string) {
	if r == nil {
		return
	}
	if _, ok := r.storage.budget.Load().measuredAt(); !ok {
		return
	}
	pressure := r.measure()
	if pressure.budget == nil || pressure.budget.FloorBytes <= 0 {
		return
	}
	bytes := checkoutEstimate(repoRoot, rev, declared)
	if pressure = pressure.making(bytes); !pressure.belowFloor() {
		return
	}
	logln(fmt.Sprintf("session %s — its checkout, about %s, would leave %s free of the storage budget, under its %s floor: reclaiming checkouts first",
		sessionID, sizeText(bytes), sizeText(pressure.freeBytes), sizeText(uint64(pressure.budget.FloorBytes))))
	r.sweep(pressure)
	if after := pressure.again(); after.budget != nil && after.belowFloor() {
		logln(fmt.Sprintf("session %s — nothing more can be reclaimed, so its checkout is made %s short of the storage budget's floor",
			sessionID, sizeText(uint64(after.budget.FloorBytes)-after.freeBytes)))
	}
}

// made counts the checkout just made at path on the room's storage (checkoutStorage.made).
func (r *checkoutRoom) made(path string) {
	if r != nil {
		r.storage.made(path)
	}
}

// making is this reading with a checkout of these bytes made already, and read again the same way: what the sweep
// judges when it makes room for that checkout (checkoutRoom.makeRoomFor), so that it stops once the checkout fits.
func (p worktreeGCPressure) making(bytes uint64) worktreeGCPressure {
	p.freeBytes -= min(p.freeBytes, bytes)
	if reread := p.reread; reread != nil {
		p.reread = func() worktreeGCPressure { return reread().making(bytes) }
	}
	return p
}

// checkoutEstimate is what a checkout of rev takes on the volume before anything is built in it: the apparent size of
// each file rev tracks (`git ls-tree -r -l`), which is how the volume's measurement counts a file, of the paths the
// checkout's sparse patterns keep when declared leaves any out. git sorts the paths by those patterns itself
// (sparseCheckoutKeeps); a git that cannot (one older than 2.42) leaves every path counted, which makes more room than
// the checkout takes, never less. A rev git cannot list counts nothing.
func checkoutEstimate(repoRoot, rev string, declared []string) uint64 {
	listing, err := git(repoRoot, "ls-tree", "-r", "-l", "-z", rev)
	if err != nil {
		return 0
	}
	sizes := map[string]uint64{}
	var paths []string
	var total uint64
	for _, entry := range strings.Split(listing, "\x00") {
		// "<mode> <type> <object> <size>\t<path>". A submodule, which a checkout holds as an empty directory, has
		// the size "-".
		meta, path, ok := strings.Cut(entry, "\t")
		fields := strings.Fields(meta)
		if !ok || len(fields) != 4 {
			continue
		}
		size, err := strconv.ParseUint(fields[3], 10, 64)
		if err != nil {
			continue
		}
		sizes[path] = size
		paths = append(paths, path)
		total += size
	}
	if len(declared) == 0 {
		return total
	}
	kept, err := sparseCheckoutKeeps(repoRoot, declared, paths)
	if err != nil {
		return total
	}
	var sum uint64
	for _, path := range kept {
		sum += sizes[path]
	}
	return sum
}

// sparseCheckoutKeeps is which of paths a sparse checkout for declared holds, as git decides it with the patterns
// makeSessionCheckout gives that checkout (`git sparse-checkout check-rules`, git 2.42).
func sparseCheckoutKeeps(repoRoot string, declared, paths []string) ([]string, error) {
	rules, err := os.CreateTemp("", "orbit-checkout-rules-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(rules.Name())
	_, err = rules.WriteString(strings.Join(sparseCheckoutPatterns(declared), "\n") + "\n")
	if closeErr := rules.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return nil, err
	}
	var input strings.Builder
	for _, path := range paths {
		input.WriteString(path)
		input.WriteByte(0)
	}
	cmd := exec.Command("git", "-C", repoRoot, "sparse-checkout", "check-rules", "--no-cone", "--rules-file", rules.Name(), "-z")
	cmd.Stdin = strings.NewReader(input.String())
	out, err := cmd.Output()
	if err != nil {
		return nil, gitFailure(err)
	}
	return strings.Split(strings.TrimSuffix(string(out), "\x00"), "\x00"), nil
}

// sizeText is a byte count as a log line says it: "870.9 MiB", "1.8 GiB".
func sizeText(bytes uint64) string {
	if bytes >= 1<<30 {
		return fmt.Sprintf("%.1f GiB", float64(bytes)/(1<<30))
	}
	return fmt.Sprintf("%.1f MiB", float64(bytes)/(1<<20))
}
