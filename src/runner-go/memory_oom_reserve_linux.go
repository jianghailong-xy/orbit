//go:build linux

package main

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// memoryReserveCommand is a managed runner's emergency memory reserve: a child of the daemon that holds
// memoryReserveBytes of touched private memory and frees it as soon as the container's memory.events oom_kill rises.
//
// The kernel soon stops waiting for an OOM victim, by the time the victim has unmapped its memory at the latest. But
// shared memory (shmem, memfd, tmpfs) is freed only when its last reference goes, later in the victim's exit: 3.6 GiB
// took about 400 ms on a 2 CPU runner. Until then the container stays at its limit, and the next allocation in it makes
// the kernel kill another process. In 2 of 4 lab trials on 2026-11-24 that was another session's tool, 93 to 115 ms
// after the first kill. The freed reserve is room for the container's other processes until the victim's memory is gone.
//
// It is a process of its own because the daemon can stall at that moment: a daemon thread that faults at the limit
// holds up Go's stop-the-world, and every goroutine with it, until memory is freed.
const memoryReserveCommand = "orbit-headroom"

const memoryReserveBytes = 64 << 20

// memoryReservePoll is the longest the reserve waits on memory.events. A change wakes it at once; the timeout only
// bounds a missed notification and how often it looks for room to arm again.
const memoryReservePoll = 100 * time.Millisecond

var memoryReserveOOMKillPrefix = []byte("oom_kill ")

type memoryReserve struct {
	pages      []byte
	events     int // memory.events, kept open: reading it again allocates nothing
	readMemory func() (limit, available uint64, ok bool)

	buf      [512]byte
	fds      [1]unix.PollFd
	timeout  unix.Timespec
	kills    uint64
	armed    bool
	armAfter int64 // CLOCK_MONOTONIC nanoseconds
}

// runMemoryReserve is `orbit orbit-headroom`, which the daemon's memory watchdog starts (keepMemoryReserve).
func runMemoryReserve() int {
	_ = os.WriteFile("/proc/self/comm", []byte(memoryReserveCommand), 0)
	// If the kernel has to kill again before the reserve is freed, it then takes the reserve before a smaller tool.
	_ = os.WriteFile("/proc/self/oom_score_adj", []byte("1000"), 0)
	if err := serveMemoryReserve(context.Background(), cgroupRoot); err != nil {
		logln("The emergency memory reserve could not start:", err)
		return 1
	}
	return 0
}

func serveMemoryReserve(ctx context.Context, dir string) error {
	events, err := unix.Open(filepath.Join(dir, "memory.events"), unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(events)
	pages, err := unix.Mmap(-1, 0, memoryReserveBytes, unix.PROT_READ|unix.PROT_WRITE, unix.MAP_PRIVATE|unix.MAP_ANONYMOUS)
	if err != nil {
		return err
	}
	defer unix.Munmap(pages)
	r := newMemoryReserve(pages, events, func() (uint64, uint64, bool) { return watchdogCgroupMemory(dir) })
	if _, ok := r.readOOMKills(); !ok {
		return os.ErrInvalid
	}
	for ctx.Err() == nil {
		r.step(monotonicNanos())
		r.wait()
	}
	return nil
}

func newMemoryReserve(pages []byte, events int, readMemory func() (uint64, uint64, bool)) *memoryReserve {
	r := &memoryReserve{pages: pages, events: events, readMemory: readMemory}
	r.fds[0] = unix.PollFd{Fd: int32(events), Events: unix.POLLPRI}
	r.kills, _ = r.readOOMKills()
	return r
}

// wait returns when memory.events changes (kernfs wakes a poll for POLLPRI as it signals inotify's IN_MODIFY), or
// after memoryReservePoll.
func (r *memoryReserve) wait() {
	// ppoll writes the time left back into its timeout.
	r.timeout = unix.NsecToTimespec(int64(memoryReservePoll))
	_, _ = unix.Ppoll(r.fds[:], &r.timeout, nil)
}

// step frees the reserve when oom_kill has risen, and arms it again once no kill has followed for the watchdog's
// settle window and memory has room for it, which it reads at most once a memoryReservePoll. Until it frees the reserve
// it allocates nothing: a new page could not be had while the container is at its limit.
func (r *memoryReserve) step(now int64) {
	if kills, ok := r.readOOMKills(); ok && kills > r.kills {
		before := r.kills
		r.kills = kills
		r.armAfter = now + int64(memoryWatchdogSettleWindow)
		if r.armed && unix.Madvise(r.pages, unix.MADV_DONTNEED) == nil {
			r.armed = false
			freed := monotonicNanos()
			logln("Freed the emergency memory reserve of", len(r.pages)>>20, "MiB: the container's oom_kill rose from",
				before, "to", kills, "(woken at monotonic", now, "ns, freed at", freed, "ns)")
		}
	}
	if r.armed || now < r.armAfter {
		return
	}
	limit, available, ok := r.readMemory()
	// Arming must not bring the memory watchdog's threshold, a tenth of the limit, any closer.
	if !ok || available <= limit/10+uint64(len(r.pages)) {
		r.armAfter = now + int64(memoryReservePoll)
		return
	}
	for i := 0; i < len(r.pages); i += os.Getpagesize() {
		r.pages[i] = 1
	}
	r.armed = true
	logln("Armed the emergency memory reserve of", len(r.pages)>>20, "MiB; the container's oom_kill is", r.kills)
}

func (r *memoryReserve) readOOMKills() (uint64, bool) {
	n, err := unix.Pread(r.events, r.buf[:], 0)
	if err != nil {
		return 0, false
	}
	for data := r.buf[:n]; len(data) > 0; {
		line := data
		if i := bytes.IndexByte(data, '\n'); i >= 0 {
			line, data = data[:i], data[i+1:]
		} else {
			data = nil
		}
		if value, found := bytes.CutPrefix(line, memoryReserveOOMKillPrefix); found && len(value) > 0 {
			var kills uint64
			for _, c := range value {
				if c < '0' || c > '9' {
					return 0, false
				}
				kills = kills*10 + uint64(c-'0')
			}
			return kills, true
		}
	}
	return 0, false
}

func monotonicNanos() int64 {
	var ts unix.Timespec
	_ = unix.ClockGettime(unix.CLOCK_MONOTONIC, &ts)
	return ts.Nano()
}

// keepMemoryReserve runs the reserve process (argv, `orbit orbit-headroom`) while ctx lasts. A signal may end it (the
// kernel can pick it in an OOM, which its score is for), and it starts again after the settle window, arming once
// memory has room. One that exits by itself could not start, and is not started again.
func keepMemoryReserve(ctx context.Context, argv ...string) <-chan struct{} {
	done := make(chan struct{})
	if argv[0] == "" {
		close(done)
		return done
	}
	go func() {
		defer close(done)
		for {
			cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
			cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
			cmd.SysProcAttr = &unix.SysProcAttr{Pdeathsig: unix.SIGKILL}
			err := cmd.Run()
			if ctx.Err() != nil {
				return
			}
			if !memoryReserveSignaled(cmd.ProcessState) {
				logln("The emergency memory reserve is not running:", err)
				return
			}
			logln("The emergency memory reserve was stopped:", err, "- it starts again in", memoryWatchdogSettleWindow)
			select {
			case <-ctx.Done():
				return
			case <-time.After(memoryWatchdogSettleWindow):
			}
		}
	}()
	return done
}

func memoryReserveSignaled(state *os.ProcessState) bool {
	if state == nil {
		return false
	}
	status, ok := state.Sys().(syscall.WaitStatus)
	return ok && status.Signaled()
}
