//go:build linux

package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// testMemoryReserve is a reserve of two pages over a memory.events file whose oom_kill the test sets.
func testMemoryReserve(t *testing.T, available *uint64) (*memoryReserve, func(kills int)) {
	t.Helper()
	pages, err := unix.Mmap(-1, 0, 2*os.Getpagesize(), unix.PROT_READ|unix.PROT_WRITE, unix.MAP_PRIVATE|unix.MAP_ANONYMOUS)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = unix.Munmap(pages) })
	path := filepath.Join(t.TempDir(), "memory.events")
	setKills := func(kills int) {
		t.Helper()
		events := fmt.Sprintf("low 0\nhigh 0\nmax 12\noom 3\noom_kill %d\noom_group_kill 0\nsock_throttled 0\n", kills)
		if err := os.WriteFile(path, []byte(events), 0600); err != nil {
			t.Fatal(err)
		}
	}
	setKills(2)
	events, err := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = unix.Close(events) })
	return newMemoryReserve(pages, events, func() (uint64, uint64, bool) { return 4 << 30, *available, true }), setKills
}

// requireReserve checks the reserve's state and its pages: an armed page holds 1, and a freed private page reads 0.
func requireReserve(t *testing.T, r *memoryReserve, armed bool) {
	t.Helper()
	want := byte(0)
	if armed {
		want = 1
	}
	for i := 0; i < len(r.pages); i += os.Getpagesize() {
		if r.pages[i] != want || r.armed != armed {
			t.Fatalf("armed = %t, page %d holds %d; want armed = %t, holding %d", r.armed, i/os.Getpagesize(), r.pages[i], armed, want)
		}
	}
}

func TestMemoryReserveFreesOnAnOOMKillAndArmsAgainAfterRecovery(t *testing.T) {
	const limit = 4 << 30
	available := uint64(2 << 30)
	r, setKills := testMemoryReserve(t, &available)
	second := int64(time.Second)
	settle := int64(memoryWatchdogSettleWindow)

	r.step(0)
	requireReserve(t, r, true)
	r.step(second)
	requireReserve(t, r, true)

	// The kernel killed a process: the reserve is freed at once, whatever memory reads.
	setKills(3)
	available = 0
	r.step(2 * second)
	requireReserve(t, r, false)

	// It stays free for the settle window after the kill, and then until arming leaves the watchdog's tenth free,
	// which it reads again a poll later.
	available = 2 << 30
	r.step(2*second + settle - 1)
	requireReserve(t, r, false)
	available = limit/10 + uint64(len(r.pages))
	r.step(2*second + settle)
	requireReserve(t, r, false)
	available = 2 << 30
	r.step(2*second + settle + int64(memoryReservePoll) - 1)
	requireReserve(t, r, false)
	r.step(2*second + settle + int64(memoryReservePoll))
	requireReserve(t, r, true)

	// A further kill while it is free starts the settle window again.
	setKills(4)
	r.step(10 * second)
	requireReserve(t, r, false)
	setKills(5)
	r.step(11 * second)
	r.step(10*second + settle)
	requireReserve(t, r, false)
	r.step(11*second + settle)
	requireReserve(t, r, true)

	// Reading the same count again frees nothing.
	r.step(12*second + settle)
	requireReserve(t, r, true)
}

func TestMemoryReserveReadsOnlyOOMKill(t *testing.T) {
	path := filepath.Join(t.TempDir(), "memory.events")
	for _, tc := range []struct {
		events string
		kills  uint64
		ok     bool
	}{
		{"low 0\noom 4\noom_kill 3\noom_group_kill 9\n", 3, true},
		{"oom_group_kill 9\noom_kill 12", 12, true},
		{"low 0\noom 4\noom_group_kill 9\n", 0, false},
		{"oom_kill \n", 0, false},
		{"oom_kill 1x\n", 0, false},
	} {
		if err := os.WriteFile(path, []byte(tc.events), 0600); err != nil {
			t.Fatal(err)
		}
		fd, err := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC, 0)
		if err != nil {
			t.Fatal(err)
		}
		r := &memoryReserve{events: fd}
		kills, ok := r.readOOMKills()
		_ = unix.Close(fd)
		if kills != tc.kills || ok != tc.ok {
			t.Errorf("%q: oom_kill = %d, %t; want %d, %t", tc.events, kills, ok, tc.kills, tc.ok)
		}
	}
}

// While the container is at its limit, a new page cannot be had. Until it frees the reserve, the reserve allocates
// nothing, so it cannot fault on a heap page that it has never touched.
func TestMemoryReserveWaitsAndReadsWithoutAllocating(t *testing.T) {
	available := uint64(2 << 30)
	r, _ := testMemoryReserve(t, &available)
	r.step(0)
	requireReserve(t, r, true)
	// AllocsPerRun counts the whole process, where goroutines that other tests leave behind allocate now and then.
	// Keep the fewest of a few short measurements.
	fewest := -1.0
	for i := 0; i < 5 && fewest != 0; i++ {
		if allocs := testing.AllocsPerRun(50, func() { r.step(monotonicNanos()) }); fewest < 0 || allocs < fewest {
			fewest = allocs
		}
	}
	if fewest != 0 {
		t.Errorf("an armed reserve allocates %v times a step", fewest)
	}
	// A regular file never signals POLLPRI, so each wait lasts the whole timeout.
	start := time.Now()
	for i := 0; i < 4; i++ {
		r.wait()
	}
	if elapsed := time.Since(start); elapsed < 4*memoryReservePoll {
		t.Errorf("4 waits took %v; each should last its timeout, %v", elapsed, memoryReservePoll)
	}
	requireReserve(t, r, true)
}

func TestKeepMemoryReserveStartsAgainOnlyAfterASignal(t *testing.T) {
	starts := filepath.Join(t.TempDir(), "starts")
	countStarts := func() int {
		data, _ := os.ReadFile(starts)
		return strings.Count(string(data), "\n")
	}

	// A reserve the kernel kills is started again.
	ctx, cancel := context.WithCancel(context.Background())
	done := keepMemoryReserve(ctx, "/bin/sh", "-c", `echo started >> "$0"; kill -KILL $$`, starts)
	deadline := time.Now().Add(memoryWatchdogSettleWindow + 10*time.Second)
	for countStarts() < 2 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	cancel()
	<-done
	if n := countStarts(); n < 2 {
		t.Fatalf("a reserve ended by SIGKILL was started %d times, want it started again", n)
	}

	// One that exits by itself could not run, and is left alone.
	if err := os.Remove(starts); err != nil {
		t.Fatal(err)
	}
	done = keepMemoryReserve(context.Background(), "/bin/sh", "-c", `echo started >> "$0"; exit 1`, starts)
	select {
	case <-done:
	case <-time.After(memoryWatchdogSettleWindow + 10*time.Second):
		t.Fatal("the keeper is still waiting on a reserve that exited by itself")
	}
	if n := countStarts(); n != 1 {
		t.Fatalf("a reserve that exited by itself was started %d times, want once", n)
	}

	// Stopping the watchdog stops a running reserve.
	ctx, cancel = context.WithCancel(context.Background())
	done = keepMemoryReserve(ctx, "/bin/sh", "-c", `exec sleep 600`)
	time.Sleep(100 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the keeper did not stop its reserve when its context ended")
	}
}
