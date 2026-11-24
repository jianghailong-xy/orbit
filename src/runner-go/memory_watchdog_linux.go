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

const memoryWatchdogSettleWindow = 4 * time.Second
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
	readMemory   func() (limit, available uint64, ok bool)
	readOOMKills func() (uint64, bool)
	processes    func() map[int]memoryProcess
	processSize  func(memoryProcess) uint64
	raiseScore   func(memoryProcessID) bool
	kill         func(memoryProcessID) bool
	notify       func(session, message string)
	baseline     string
	smallRunner  bool

	mu              sync.Mutex
	roots           map[memoryProcessID]memoryRoot
	watchdogVictims map[memoryProcessID]bool

	// Only the sampling goroutine uses these. Remember observed tools across reparenting.
	tools         map[memoryProcessID]memoryGroup
	raised        map[memoryProcessID]bool
	oomKills      uint64
	lastAvailable uint64
	settleUntil   time.Time
}

var activeMemoryWatchdog atomic.Pointer[memoryWatchdog]

func startMemoryWatchdog(ctx context.Context, managed bool) func() {
	if !managed {
		return func() {}
	}
	read := func() (uint64, uint64, bool) { return watchdogCgroupMemory(cgroupRoot) }
	limit, _, ok := read()
	if !ok || limit == 0 {
		return func() {}
	}
	oomKills, _ := cgroupOOMKills(cgroupRoot)
	w := &memoryWatchdog{
		readMemory: read, readOOMKills: func() (uint64, bool) { return cgroupOOMKills(cgroupRoot) }, oomKills: oomKills,
		processes: readMemoryProcesses, processSize: memoryProcessSize,
		raiseScore: raiseToolOOMScore, kill: killMemoryProcess, notify: notifyMemoryWatchdogKill,
		baseline:    readOOMScore("/proc/self"),
		smallRunner: limit <= 4<<30,
		roots:       make(map[memoryProcessID]memoryRoot),
		raised:      make(map[memoryProcessID]bool),
	}
	activeMemoryWatchdog.Store(w)
	ctx, cancel := context.WithCancel(ctx)
	reserveDone := keepMemoryReserve(ctx, orbitCLIExecutable(), memoryReserveCommand)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				w.sample(time.Now)
			case <-ctx.Done():
				return
			}
		}
	}()
	return func() {
		activeMemoryWatchdog.CompareAndSwap(w, nil)
		cancel()
		<-done
		<-reserveDone
	}
}

func watchdogCgroupMemory(dir string) (limit, available uint64, ok bool) {
	maxBytes, err := os.ReadFile(filepath.Join(dir, "memory.max"))
	if err != nil {
		return 0, 0, false
	}
	limit, ok = parseCgroupBytes(string(maxBytes))
	if !ok || limit == 0 {
		return 0, 0, false
	}
	data, err := os.ReadFile(filepath.Join(dir, "memory.stat"))
	if err != nil {
		return 0, 0, false
	}
	stat := string(data)
	anon, hasAnon := statField(stat, "anon")
	shmem, hasShmem := statField(stat, "shmem")
	if !hasAnon || !hasShmem {
		return 0, 0, false
	}
	// shmem is reported separately from anon and includes tmpfs and memfd.
	// Disk-backed file pages on either LRU can be reclaimed under pressure.
	available = limit - min(limit, anon)
	available -= min(available, shmem)
	// Older kernels may lack the kernel total. Count it only when we can
	// subtract reclaimable slab, which is included in that total.
	kernel, hasKernel := statField(stat, "kernel")
	reclaimable, hasReclaimable := statField(stat, "slab_reclaimable")
	if hasKernel && hasReclaimable {
		available -= min(available, kernel-min(kernel, reclaimable))
	}
	return limit, available, true
}

func readOOMScore(dir string) string {
	score, _ := os.ReadFile(filepath.Join(dir, "oom_score_adj"))
	return strings.TrimSpace(string(score))
}

func memoryWatchdogChildEnv(env []string) []string {
	if w := activeMemoryWatchdog.Load(); w != nil {
		if w.baseline != "" {
			env = envWithValue(env, memoryWatchdogBaselineEnv, w.baseline)
		}
		// A single cold Go test compile can cross the watchdog threshold
		// on a 4 GiB runner even with one compiler worker. Collect earlier
		// by default and preserve an explicit session or runner setting.
		if w.smallRunner && envValue(env, "GOGC") == "" {
			env = envWithValue(env, "GOGC", "50")
		}
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

func (w *memoryWatchdog) memoryPressure(now time.Time) (limit, available uint64, canKill bool) {
	limit, available, ok := w.readMemory()
	if !ok || limit == 0 {
		return 0, 0, false
	}
	kills, ok := w.readOOMKills()
	if ok {
		if kills > w.oomKills {
			w.settleUntil = now.Add(memoryWatchdogSettleWindow)
		}
		w.oomKills = kills
	}
	// Require a quiet window after either kind of kill. A brief recovery below
	// the threshold is common while the victim's pages are still being freed.
	if !w.settleUntil.IsZero() && available > w.lastAvailable {
		w.settleUntil = now.Add(memoryWatchdogSettleWindow)
	}
	w.lastAvailable = available
	settled := !now.Before(w.settleUntil)
	if ok && settled && available > limit/10 {
		w.settleUntil = time.Time{}
	}
	return limit, available, ok && available <= limit/10 && settled
}

func (w *memoryWatchdog) sample(now func() time.Time) {
	limit, _, canKill := w.memoryPressure(now())
	if limit == 0 {
		return
	}

	w.mu.Lock()
	processes := w.processes()
	for id := range w.watchdogVictims {
		// Keep a killed process marked until its parent reaps it.
		p, _, _ := readMemoryProcessStat("/proc/"+strconv.Itoa(id.pid), id.pid)
		if p.memoryProcessID != id {
			delete(w.watchdogVictims, id)
		}
	}
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
		if parent.protected && parent.name == memoryToolShellComm {
			// Attribute the shell through its protected wait-status helper.
			parent = processes[parent.ppid]
		}
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
		} else if root, ok := roots[parent.pid]; ok && !root.tool && parent.start <= p.start {
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

	for _, p := range processes {
		group := groupFor(p)
		if group.session == "" {
			continue
		}
		if !w.raised[p.memoryProcessID] && w.raiseScore(p.memoryProcessID) {
			w.raised[p.memoryProcessID] = true
		}
	}
	for id := range w.raised {
		if _, ok := tools[id]; !ok {
			delete(w.raised, id)
		}
	}
	w.tools = tools

	if !canKill {
		return
	}
	type usage struct {
		members []memoryProcessID
		bytes   uint64
	}
	groups := make(map[memoryGroup]*usage)
	for id, group := range tools {
		if groups[group] == nil {
			groups[group] = &usage{}
		}
		groups[group].members = append(groups[group].members, id)
		groups[group].bytes += w.processSize(processes[id.pid])
	}
	var victim memoryGroup
	var largest uint64
	for group, use := range groups {
		if use.bytes > largest || (use.bytes == largest && group.leader.pid < victim.leader.pid) {
			victim, largest = group, use.bytes
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
	// A kernel OOM or reclaim can happen while we walk the tools' mappings.
	limit, available, canKill := w.memoryPressure(now())
	if !canKill {
		return
	}
	w.settleUntil = time.Time{}
	killed := false
	w.mu.Lock()
	for _, id := range groups[victim].members {
		if w.kill(id) {
			if w.watchdogVictims == nil {
				w.watchdogVictims = make(map[memoryProcessID]bool)
			}
			w.watchdogVictims[id] = true
			killed = true
		}
	}
	w.mu.Unlock()
	if killed {
		w.settleUntil = now().Add(memoryWatchdogSettleWindow)
		w.notify(victim.session, fmt.Sprintf(
			"The runner stopped %s (PID %d) because memory excluding reclaimable cache reached %d MiB of the container's %d MiB limit.",
			description, victim.leader.pid, (limit-available)>>20, limit>>20))
	}
}

func memoryProcessSize(p memoryProcess) uint64 {
	// Pss includes mapped shmem (including memfd) and divides shared pages
	// among their users, so a group of compilers doesn't count them repeatedly.
	// Some kernels or ptrace policies deny smaps_rollup. Keep RSS as a fallback.
	dir := filepath.Join("/proc", strconv.Itoa(p.pid))
	data, err := os.ReadFile(filepath.Join(dir, "smaps_rollup"))
	if current, ok := readMemoryProcess(dir, p.pid); !ok || current.memoryProcessID != p.memoryProcessID {
		return 0
	}
	if err == nil {
		if size, ok := memoryPSS(string(data)); ok {
			return size
		}
	}
	return p.rss
}

func memoryPSS(rollup string) (uint64, bool) {
	for _, line := range strings.Split(rollup, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 3 && fields[0] == "Pss:" && fields[2] == "kB" {
			kib, err := strconv.ParseUint(fields[1], 10, 54)
			return kib << 10, err == nil
		}
	}
	return 0, false
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
	p, _, alive := readMemoryProcessStat(dir, pid)
	return p, alive
}

// readMemoryProcessStat also returns the identity and wait status of a zombie
// while its parent still owns the PID.
func readMemoryProcessStat(dir string, pid int) (memoryProcess, unix.WaitStatus, bool) {
	data, err := os.ReadFile(filepath.Join(dir, "stat"))
	if err != nil {
		return memoryProcess{}, 0, false
	}
	stat := string(data)
	begin, end := strings.IndexByte(stat, '('), strings.LastIndex(stat, ") ")
	if begin < 0 || end <= begin {
		return memoryProcess{}, 0, false
	}
	fields := strings.Fields(stat[end+2:])
	if len(fields) < 22 || fields[0] == "X" {
		return memoryProcess{}, 0, false
	}
	ppid, parentErr := strconv.Atoi(fields[1])
	pgid, groupErr := strconv.Atoi(fields[2])
	start, startErr := strconv.ParseUint(fields[19], 10, 64)
	pages, rssErr := strconv.ParseUint(fields[21], 10, 64)
	if parentErr != nil || groupErr != nil || startErr != nil || rssErr != nil {
		return memoryProcess{}, 0, false
	}
	var status unix.WaitStatus
	if fields[0] == "Z" && len(fields) >= 50 {
		// exit_code is field 52, after the two fields that precede fields.
		code, _ := strconv.ParseUint(fields[49], 10, 32)
		status = unix.WaitStatus(code)
	}
	return memoryProcess{
		memoryProcessID: memoryProcessID{pid, start}, ppid: ppid, pgid: pgid,
		rss: pages * uint64(os.Getpagesize()), name: stat[begin+1 : end],
	}, status, fields[0] != "Z"
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
