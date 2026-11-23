//go:build linux

package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sys/unix"
)

const memoryWatchdogCooldown = 10 * time.Second
const memoryWatchdogBaselineEnv = "ORBIT_TOOL_OOM_BASELINE"

var orbitMemoryExecutable = sync.OnceValue(func() os.FileInfo {
	info, _ := os.Stat("/proc/self/exe")
	return info
})

type memoryProcessID struct {
	pid   int
	start uint64 // /proc start time, so a recycled PID does not inherit ownership
}

type memoryProcess struct {
	memoryProcessID
	ppid, pgid int
	rss        uint64
	name       string
	protected  bool
}

type memoryRoot struct {
	session string
	tool    bool
}

type memoryGroup struct {
	session string
	leader  memoryProcessID
}

type memoryWatchdog struct {
	readMemory func() (limit, available uint64, ok bool)
	processes  func() map[int]memoryProcess
	raiseScore func(memoryProcessID) bool
	kill       func(memoryProcessID) bool
	notify     func(session, message string)
	baseline   string

	mu    sync.Mutex
	roots map[memoryProcessID]memoryRoot

	// Only the sampling goroutine uses these. Remember observed tools across reparenting.
	tools       map[memoryProcessID]memoryGroup
	raised      map[memoryProcessID]bool
	lastKill    time.Time
	waitForDrop bool
}

var activeMemoryWatchdog atomic.Pointer[memoryWatchdog]

func startMemoryWatchdog(ctx context.Context, managed bool) func() {
	if !managed {
		return func() {}
	}
	read := func() (uint64, uint64, bool) { return cgroupMemory(cgroupRoot, nil) }
	if limit, _, ok := read(); !ok || limit == 0 {
		return func() {}
	}
	w := &memoryWatchdog{
		readMemory: read, processes: readMemoryProcesses,
		raiseScore: raiseToolOOMScore, kill: killMemoryProcess, notify: notifyMemoryWatchdogKill,
		baseline: readOOMScore("/proc/self"),
		roots:    make(map[memoryProcessID]memoryRoot),
		raised:   make(map[memoryProcessID]bool),
	}
	activeMemoryWatchdog.Store(w)
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case now := <-ticker.C:
				w.sample(now)
			case <-ctx.Done():
				return
			}
		}
	}()
	return func() {
		activeMemoryWatchdog.CompareAndSwap(w, nil)
		cancel()
		<-done
	}
}

func readOOMScore(dir string) string {
	score, _ := os.ReadFile(filepath.Join(dir, "oom_score_adj"))
	return strings.TrimSpace(string(score))
}

func memoryWatchdogChildEnv(env []string) []string {
	if w := activeMemoryWatchdog.Load(); w != nil && w.baseline != "" {
		return envWithValue(env, memoryWatchdogBaselineEnv, w.baseline)
	}
	return env
}

// An Orbit helper may be started through a tool shell that was already scored.
// Restore the runner's baseline before serving requests or spawning children.
func restoreOrbitOOMScore() {
	baseline := os.Getenv(memoryWatchdogBaselineEnv)
	if baseline == "" || baseline == "1000" || readOOMScore("/proc/self") != "1000" {
		return
	}
	_ = os.WriteFile("/proc/self/oom_score_adj", []byte(baseline), 0)
}

// trackMemoryRoots registers daemon-started processes before their caller begins waiting on them.
// Engine roots (and a Cursor keeper) retain the daemon's inherited score. Lowering that baseline
// can require CAP_SYS_RESOURCE, which managed runners deliberately lack.
func trackMemoryRoots(session string, tool bool, pids ...int) {
	w := activeMemoryWatchdog.Load()
	if w == nil || session == "" {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, pid := range pids {
		if p, ok := readMemoryProcess("/proc/"+strconv.Itoa(pid), pid); ok {
			w.roots[p.memoryProcessID] = memoryRoot{session: session, tool: tool}
			if tool {
				// A runner-hosted tool can start building before the next scan.
				raiseToolOOMScore(p.memoryProcessID)
			}
		}
	}
}

func (w *memoryWatchdog) sample(now time.Time) {
	limit, available, ok := w.readMemory()
	if !ok || limit == 0 {
		return
	}
	pressured := available <= limit/10
	if !pressured {
		w.waitForDrop = false
	}

	w.mu.Lock()
	processes := w.processes()
	roots := make(map[int]memoryRoot, len(w.roots))
	for id, root := range w.roots {
		if processes[id.pid].memoryProcessID == id {
			roots[id.pid] = root
		} else {
			delete(w.roots, id)
		}
	}
	w.mu.Unlock()

	tools := make(map[memoryProcessID]memoryGroup)
	visited := make(map[int]bool)
	var groupFor func(memoryProcess) memoryGroup
	groupFor = func(p memoryProcess) memoryGroup {
		if visited[p.pid] {
			return tools[p.memoryProcessID]
		}
		visited[p.pid] = true
		parent := processes[p.ppid]
		var group memoryGroup
		if p.protected {
			// A helper may have the same PGID as a tool, or have exec'd
			// under a PID which belonged to a tool in the last sample.
			return group
		} else if root, ok := roots[p.pid]; ok {
			if root.tool {
				group = memoryGroup{root.session, p.memoryProcessID}
			}
		} else if previous, ok := w.tools[p.memoryProcessID]; ok {
			group = previous
		} else if root, ok := roots[p.ppid]; ok && !root.tool && parent.start <= p.start {
			// Descendants can share the engine's PGID. In that case each direct
			// child and its subtree form a separate tool, without the engine.
			leader := p
			if sibling := processes[p.pgid]; sibling.pid > 0 && !sibling.protected && sibling.ppid == p.ppid && sibling.pgid != parent.pgid {
				if _, protected := roots[sibling.pid]; !protected {
					leader = sibling
				}
			}
			group = memoryGroup{root.session, leader.memoryProcessID}
		} else {
			if parent.pid > 0 && parent.start <= p.start {
				group = groupFor(parent)
			}
		}
		if group.session != "" {
			tools[p.memoryProcessID] = group
		}
		return group
	}

	type usage struct {
		members []memoryProcessID
		rss     uint64
	}
	groups := make(map[memoryGroup]*usage)
	for _, p := range processes {
		group := groupFor(p)
		if group.session == "" {
			continue
		}
		if !w.raised[p.memoryProcessID] && w.raiseScore(p.memoryProcessID) {
			w.raised[p.memoryProcessID] = true
		}
		if groups[group] == nil {
			groups[group] = &usage{}
		}
		groups[group].members = append(groups[group].members, p.memoryProcessID)
		groups[group].rss += p.rss
	}
	for id := range w.raised {
		if _, ok := tools[id]; !ok {
			delete(w.raised, id)
		}
	}
	w.tools = tools

	if !pressured || w.waitForDrop || now.Sub(w.lastKill) < memoryWatchdogCooldown {
		return
	}
	var victim memoryGroup
	var largest uint64
	for group, use := range groups {
		if use.rss > largest || (use.rss == largest && group.leader.pid < victim.leader.pid) {
			victim, largest = group, use.rss
		}
	}
	if largest == 0 {
		// Leave engines available for their sessions even when the watchdog
		// finds no tool. The kernel is the fallback if pressure keeps rising.
		return
	}
	leader := processes[victim.leader.pid]
	description := "a tool process group"
	if leader.memoryProcessID == victim.leader && leader.name != "" {
		description = "the " + strconv.QuoteToGraphic(leader.name) + " tool process group"
	}
	killed := false
	for _, id := range groups[victim].members {
		if w.kill(id) {
			killed = true
		}
	}
	if killed {
		w.lastKill = now
		w.waitForDrop = true
		w.notify(victim.session, fmt.Sprintf(
			"The runner stopped %s (PID %d) because the container was using %d MiB of its %d MiB memory limit.",
			description, victim.leader.pid, (limit-available)>>20, limit>>20))
	}
}

func readMemoryProcesses() map[int]memoryProcess {
	entries, _ := os.ReadDir("/proc")
	processes := make(map[int]memoryProcess, len(entries))
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err == nil {
			if p, ok := readMemoryProcess("/proc/"+entry.Name(), pid); ok {
				p.protected = protectedMemoryExecutable("/proc/" + entry.Name())
				processes[pid] = p
			}
		}
	}
	return processes
}

func readMemoryProcess(dir string, pid int) (memoryProcess, bool) {
	data, err := os.ReadFile(filepath.Join(dir, "stat"))
	if err != nil {
		return memoryProcess{}, false
	}
	stat := string(data)
	begin, end := strings.IndexByte(stat, '('), strings.LastIndex(stat, ") ")
	if begin < 0 || end <= begin {
		return memoryProcess{}, false
	}
	fields := strings.Fields(stat[end+2:])
	if len(fields) < 22 || fields[0] == "Z" || fields[0] == "X" {
		return memoryProcess{}, false
	}
	ppid, parentErr := strconv.Atoi(fields[1])
	pgid, groupErr := strconv.Atoi(fields[2])
	start, startErr := strconv.ParseUint(fields[19], 10, 64)
	pages, rssErr := strconv.ParseUint(fields[21], 10, 64)
	if parentErr != nil || groupErr != nil || startErr != nil || rssErr != nil {
		return memoryProcess{}, false
	}
	return memoryProcess{
		memoryProcessID: memoryProcessID{pid, start}, ppid: ppid, pgid: pgid,
		rss: pages * uint64(os.Getpagesize()), name: stat[begin+1 : end],
	}, true
}

func protectedMemoryExecutable(dir string) bool {
	exe, err := os.Stat(filepath.Join(dir, "exe"))
	self := orbitMemoryExecutable()
	// Without an executable identity we cannot safely score or signal it.
	return err != nil || self == nil || os.SameFile(exe, self)
}

func raiseToolOOMScore(id memoryProcessID) bool {
	// Open the proc directory first so a recycled PID cannot receive our write.
	dir, err := os.Open("/proc/" + strconv.Itoa(id.pid))
	if err != nil {
		return false
	}
	defer dir.Close()
	path := "/proc/self/fd/" + strconv.FormatUint(uint64(dir.Fd()), 10)
	if p, ok := readMemoryProcess(path, id.pid); !ok || p.memoryProcessID != id || protectedMemoryExecutable(path) {
		return false
	}
	return os.WriteFile(filepath.Join(path, "oom_score_adj"), []byte("1000"), 0) == nil
}

func killMemoryProcess(id memoryProcessID) bool {
	// Signal through a pidfd. A process that exits after the identity check
	// cannot redirect the signal to a new process that gets its PID.
	fd, err := unix.PidfdOpen(id.pid, 0)
	if err != nil {
		return false
	}
	defer unix.Close(fd)
	path := "/proc/" + strconv.Itoa(id.pid)
	if p, ok := readMemoryProcess(path, id.pid); !ok || p.memoryProcessID != id || protectedMemoryExecutable(path) {
		return false
	}
	return unix.PidfdSendSignal(fd, unix.SIGKILL, nil, 0) == nil
}

func notifyMemoryWatchdogKill(session, message string) {
	logln("memory watchdog for session", publicID(session), message)
	emitSessionNotice(session, map[string]interface{}{"subtype": "memory_watchdog", "notice": message})
}
