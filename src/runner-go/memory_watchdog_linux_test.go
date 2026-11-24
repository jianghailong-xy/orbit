//go:build linux

package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestMemoryWatchdogIgnoresFileCacheAndStopsOneToolUnderPressure(t *testing.T) {
	const mib uint64 = 1 << 20
	dir := t.TempDir()
	write := func(name, data string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("memory.max", fmt.Sprintln(4096*mib))
	write("memory.current", fmt.Sprintln(4050*mib))
	setStat := func(anon, shmem, file, active, inactive, kernel, reclaimable uint64) {
		write("memory.stat", fmt.Sprintf(
			"anon %d\nshmem %d\nfile %d\nactive_file %d\ninactive_file %d\nkernel %d\nslab_reclaimable %d\n",
			anon*mib, shmem*mib, file*mib, active*mib, inactive*mib, kernel*mib, reclaimable*mib))
	}
	build, sibling := memoryProcessID{20, 1}, memoryProcessID{21, 1}
	processes := map[int]memoryProcess{
		20: {memoryProcessID: build, rss: 1800 * mib},
		21: {memoryProcessID: sibling, rss: 700 * mib},
	}
	var victims []memoryProcessID
	w := &memoryWatchdog{
		readMemory:   func() (uint64, uint64, bool) { return watchdogCgroupMemory(dir) },
		readOOMKills: func() (uint64, bool) { return 0, true },
		processes:    func() map[int]memoryProcess { return processes },
		processSize:  func(p memoryProcess) uint64 { return p.rss },
		raiseScore:   func(memoryProcessID) bool { return true },
		kill: func(id memoryProcessID) bool {
			victims = append(victims, id)
			delete(processes, id.pid)
			return true
		},
		notify: func(string, string) {},
		roots:  map[memoryProcessID]memoryRoot{build: {"build", true}, sibling: {"sibling", true}},
		raised: make(map[memoryProcessID]bool),
	}
	now := time.Now()
	setStat(256, 0, 3500, 3400, 100, 294, 250)
	sampleMemoryWatchdogAt(w, now)
	if len(victims) != 0 {
		t.Fatalf("active file cache triggered a kill: %v", victims)
	}

	setStat(2400, 1000, 1350, 250, 100, 300, 100)
	sampleMemoryWatchdogAt(w, now.Add(time.Second))
	if len(victims) != 0 {
		t.Fatalf("memory below threshold triggered a kill: %v", victims)
	}

	setStat(2400, 1300, 1550, 150, 100, 300, 100)
	sampleMemoryWatchdogAt(w, now.Add(2*time.Second))
	if !reflect.DeepEqual(victims, []memoryProcessID{build}) {
		t.Fatalf("victims = %v, want only the larger build after shmem grew", victims)
	}
	sampleMemoryWatchdogAt(w, now.Add(3*time.Second))
	// The victim's memory has been released and file cache has grown again.
	setStat(700, 100, 3100, 2900, 100, 250, 100)
	sampleMemoryWatchdogAt(w, now.Add(4*time.Second))
	sampleMemoryWatchdogAt(w, now.Add(4*time.Second+memoryWatchdogSettleWindow))
	if !reflect.DeepEqual(victims, []memoryProcessID{build}) {
		t.Fatalf("the sibling was killed after pressure subsided: %v", victims)
	}
}

func TestMemoryWatchdogDefaultsGoGCOnlyForSmallManagedRunners(t *testing.T) {
	previous := activeMemoryWatchdog.Swap(nil)
	t.Cleanup(func() { activeMemoryWatchdog.Store(previous) })
	for _, tc := range []struct {
		name     string
		watchdog *memoryWatchdog
		env      []string
		want     string
	}{
		{name: "unmanaged"},
		{name: "larger runner", watchdog: &memoryWatchdog{}},
		{name: "small runner", watchdog: &memoryWatchdog{smallRunner: true}, want: "50"},
		{name: "explicit setting", watchdog: &memoryWatchdog{smallRunner: true}, env: []string{"GOGC=80"}, want: "80"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			activeMemoryWatchdog.Store(tc.watchdog)
			if got := envValue(runnerChildEnv(tc.env), "GOGC"); got != tc.want {
				t.Fatalf("GOGC = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestMemoryWatchdogProtectsOrbitHelpers(t *testing.T) {
	// The test binary stands in for Orbit. Launch both helpers through an
	// alternate path to exercise executable identity, regardless of argv.
	helper := filepath.Join(t.TempDir(), "orbit-alias")
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(self, helper); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	engine := exec.CommandContext(ctx, "/bin/sh", "-c", `
		"$1" -test.run='^TestMemoryWatchdogHelperProcess$' -- mcp &
		"$1" -test.run='^TestMemoryWatchdogHelperProcess$' -- guide &
		/bin/sleep 30 &
		wait
	`, "engine", helper)
	engine.Env = append(os.Environ(), "ORBIT_TEST_MEMORY_HELPER=1")
	engine.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdout, err := engine.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = syscall.Kill(-engine.Process.Pid, syscall.SIGKILL)
		_ = engine.Wait()
	}()
	ready := bufio.NewReader(stdout)
	for range 2 {
		if _, err := ready.ReadString('\n'); err != nil {
			t.Fatalf("helper did not start: %v", err)
		}
	}
	processes := readMemoryProcesses()
	root := processes[engine.Process.Pid]
	baseline := readOOMScore("/proc/" + strconv.Itoa(root.pid))
	var helpers []memoryProcessID
	var tool memoryProcessID
	for _, p := range processes {
		if p.ppid != root.pid {
			continue
		}
		if p.name == "sleep" {
			tool = p.memoryProcessID
			// The kernel's batched RSS counter can still be zero for a new child.
			p.rss = 1 << 20
		} else {
			helpers = append(helpers, p.memoryProcessID)
			// A previous tool can exec Orbit without changing its PID.
			p.rss = 500 << 20
		}
		processes[p.pid] = p
	}
	if len(helpers) != 2 || tool.pid == 0 || baseline == "" || baseline == "1000" {
		t.Fatalf("helpers=%v tool=%v inherited score=%q", helpers, tool, baseline)
	}
	var victims []memoryProcessID
	w := &memoryWatchdog{
		readMemory:   func() (uint64, uint64, bool) { return 1 << 30, 0, true },
		readOOMKills: func() (uint64, bool) { return 0, true },
		processes:    func() map[int]memoryProcess { return processes },
		processSize:  func(p memoryProcess) uint64 { return p.rss },
		raiseScore:   raiseToolOOMScore,
		kill: func(id memoryProcessID) bool {
			victims = append(victims, id)
			return true
		},
		notify: func(string, string) {},
		roots:  map[memoryProcessID]memoryRoot{root.memoryProcessID: {session: "session"}},
		raised: make(map[memoryProcessID]bool),
		tools:  map[memoryProcessID]memoryGroup{helpers[0]: {"session", helpers[0]}},
	}
	w.sample(time.Now)
	if !reflect.DeepEqual(w.raised, map[memoryProcessID]bool{tool: true}) || !reflect.DeepEqual(victims, []memoryProcessID{tool}) {
		t.Fatalf("raised=%v victims=%v, want only tool %v", w.raised, victims, tool)
	}
	if got := readOOMScore("/proc/" + strconv.Itoa(tool.pid)); got != "1000" {
		t.Errorf("tool score=%q, want 1000", got)
	}
	for _, id := range helpers {
		if raiseToolOOMScore(id) || killMemoryProcess(id) {
			t.Errorf("direct OOM action succeeded on helper %d", id.pid)
		}
		if got := readOOMScore("/proc/" + strconv.Itoa(id.pid)); got != baseline {
			t.Errorf("helper %d score=%q, want inherited %q", id.pid, got, baseline)
		}
	}
}

func TestMemoryWatchdogHelperProcess(t *testing.T) {
	if os.Getenv("ORBIT_TEST_MEMORY_HELPER") != "1" {
		return
	}
	_, _ = io.WriteString(os.Stdout, "ready\n")
	time.Sleep(30 * time.Second)
}

func TestMemoryWatchdogKillsLargestToolGroup(t *testing.T) {
	const mib = 1 << 20
	processes := map[int]memoryProcess{}
	add := func(pid, parent, group int, rss uint64, name string) memoryProcessID {
		id := memoryProcessID{pid, 1}
		processes[pid] = memoryProcess{memoryProcessID: id, ppid: parent, pgid: group, rss: rss * mib, name: name}
		return id
	}
	add(1, 0, 1, 350, "orbit")
	keeper := add(10, 1, 10, 20, "scope-keeper")
	engine := add(11, 10, 10, 200, "engine")
	otherEngine := add(12, 1, 12, 100, "other-engine")
	build := add(20, 11, 10, 40, "build")
	worker := add(21, 20, 21, 60, "compiler")
	other := add(22, 12, 22, 90, "other-tool")
	add(25, 1, 1, 300, "unrelated")
	reused := add(30, 1, 30, 500, "reused-pid")

	limited, available := false, uint64(0)
	var kills []memoryProcessID
	var notices []string
	snapshots := 0
	w := &memoryWatchdog{
		readMemory:   func() (uint64, uint64, bool) { return 1024 * mib, available, limited },
		readOOMKills: func() (uint64, bool) { return 0, true },
		processes: func() map[int]memoryProcess {
			snapshots++
			return processes
		},
		processSize: func(p memoryProcess) uint64 { return p.rss },
		raiseScore:  func(memoryProcessID) bool { return true },
		kill: func(id memoryProcessID) bool {
			kills = append(kills, id)
			delete(processes, id.pid)
			return true
		},
		notify: func(session, message string) { notices = append(notices, session+": "+message) },
		roots: map[memoryProcessID]memoryRoot{
			keeper: {"build-session", false}, engine: {"build-session", false},
			otherEngine: {"other-session", false}, {reused.pid, 0}: {"old-session", true},
		},
		raised: map[memoryProcessID]bool{},
	}
	now := time.Now()
	sampleMemoryWatchdogAt(w, now)
	if snapshots != 0 || len(kills) != 0 || len(notices) != 0 {
		t.Fatal("an unlimited cgroup triggered the watchdog")
	}

	limited, available = true, 160*mib
	sampleMemoryWatchdogAt(w, now)
	if !reflect.DeepEqual(w.raised, map[memoryProcessID]bool{build: true, worker: true, other: true}) {
		t.Fatalf("OOM score raised for %v, want only the three tools", w.raised)
	}
	if len(kills) != 0 {
		t.Fatal("the watchdog killed a process below the threshold")
	}

	// The compiler has been reparented to the keeper. It still belongs to the build.
	p := processes[worker.pid]
	p.ppid = keeper.pid
	processes[worker.pid] = p
	available = 90 * mib
	sampleMemoryWatchdogAt(w, now)
	if len(kills) != 2 || !containsMemoryIDs(kills, build, worker) {
		t.Fatalf("killed %v, want only the largest build and its compiler", kills)
	}
	if len(notices) != 1 || !strings.Contains(notices[0], `build-session: The runner stopped the "build" tool process group (PID 20) because memory excluding reclaimable cache reached 934 MiB of the container's 1024 MiB limit.`) {
		t.Fatalf("notices: %v", notices)
	}
	t.Log(notices[0])

	available = 160 * mib
	sampleMemoryWatchdogAt(w, now.Add(time.Second))
	available = 90 * mib
	sampleMemoryWatchdogAt(w, now.Add(2*time.Second))
	if len(kills) != 2 {
		t.Fatal("the watchdog killed again during the cooldown")
	}
	sampleMemoryWatchdogAt(w, now.Add(time.Second+memoryWatchdogSettleWindow))
	if len(kills) != 3 || kills[2] != other || len(notices) != 2 || !strings.HasPrefix(notices[1], "other-session: ") {
		t.Fatalf("after recovery: kills=%v notices=%v", kills, notices)
	}
	sampleMemoryWatchdogAt(w, now.Add(3*memoryWatchdogSettleWindow))
	if len(kills) != 3 {
		t.Fatal("the watchdog fell back to a daemon, engine or unrelated process")
	}
	t.Log("The daemon, both engines, and unrelated processes were protected.")
}

func TestMemoryWatchdogPrefersShmemGroupAndWaitsForRelease(t *testing.T) {
	shmem, sibling := memoryProcessID{20, 1}, memoryProcessID{21, 1}
	processes := map[int]memoryProcess{
		20: {memoryProcessID: shmem, rss: 600 << 20},
		21: {memoryProcessID: sibling, rss: 700 << 20},
	}
	rollups := map[int]string{
		20: "Rss: 614400 kB\nPss: 604160 kB\nPss_Anon: 10240 kB\nPss_Shmem: 593920 kB\n",
		21: "Rss: 716800 kB\nPss: 409600 kB\nPss_File: 409600 kB\nPss_Shmem: 0 kB\n",
	}
	available := uint64(20 << 20)
	now := time.Now()
	sampledAt := now
	var victims []memoryProcessID
	w := &memoryWatchdog{
		readMemory:   func() (uint64, uint64, bool) { return 1 << 30, available, true },
		readOOMKills: func() (uint64, bool) { return 0, true },
		processes:    func() map[int]memoryProcess { return processes },
		processSize: func(p memoryProcess) uint64 {
			size, ok := memoryPSS(rollups[p.pid])
			if !ok {
				t.Fatalf("missing PSS for process %d", p.pid)
			}
			return size
		},
		raiseScore: func(memoryProcessID) bool { return true },
		kill: func(id memoryProcessID) bool {
			if id == shmem {
				sampledAt = now.Add(memoryWatchdogSettleWindow)
			}
			victims = append(victims, id)
			delete(processes, id.pid)
			return true
		},
		notify: func(string, string) {},
		roots:  map[memoryProcessID]memoryRoot{shmem: {"shmem", true}, sibling: {"sibling", true}},
		raised: make(map[memoryProcessID]bool),
	}
	w.sample(func() time.Time { return sampledAt })
	if !reflect.DeepEqual(victims, []memoryProcessID{shmem}) {
		t.Fatalf("victims = %v, want the shmem-heavy group %v", victims, shmem)
	}
	sampleMemoryWatchdogAt(w, sampledAt.Add(time.Second))
	if len(victims) != 1 {
		t.Fatal("the settle window elapsed before the first kill finished")
	}

	// Usage is still above the threshold and falling after the initial window.
	for elapsed := 2 * time.Second; elapsed <= 2*memoryWatchdogSettleWindow; elapsed += time.Second {
		available += 1 << 20
		sampleMemoryWatchdogAt(w, sampledAt.Add(elapsed))
		if len(victims) != 1 {
			t.Fatalf("a second group was killed during memory release at %v", elapsed)
		}
	}
	sampleMemoryWatchdogAt(w, sampledAt.Add(3*memoryWatchdogSettleWindow))
	if !reflect.DeepEqual(victims, []memoryProcessID{shmem, sibling}) {
		t.Fatalf("victims = %v, want a second kill only after pressure settled", victims)
	}
}

func TestMemoryWatchdogWaitsAfterKernelOOMKill(t *testing.T) {
	sibling := memoryProcessID{20, 1}
	oomKills := uint64(5)
	now := time.Now()
	sampledAt := now
	var victims []memoryProcessID
	w := &memoryWatchdog{
		readMemory:   func() (uint64, uint64, bool) { return 1 << 30, 10 << 20, true },
		readOOMKills: func() (uint64, bool) { return oomKills, true },
		oomKills:     oomKills,
		processes: func() map[int]memoryProcess {
			return map[int]memoryProcess{20: {memoryProcessID: sibling, rss: 400 << 20}}
		},
		processSize: func(p memoryProcess) uint64 {
			// The kernel can kill the other group's allocator during the scan.
			if oomKills == 5 {
				oomKills = 6
				sampledAt = now.Add(memoryWatchdogSettleWindow)
			}
			return p.rss
		},
		raiseScore: func(memoryProcessID) bool { return true },
		kill: func(id memoryProcessID) bool {
			victims = append(victims, id)
			return true
		},
		notify: func(string, string) {},
		roots:  map[memoryProcessID]memoryRoot{sibling: {"sibling", true}},
		raised: make(map[memoryProcessID]bool),
	}
	w.sample(func() time.Time { return sampledAt })
	sampleMemoryWatchdogAt(w, sampledAt.Add(time.Second))
	if len(victims) != 0 {
		t.Fatalf("watchdog killed the sibling immediately after a kernel OOM: %v", victims)
	}
	sampleMemoryWatchdogAt(w, sampledAt.Add(memoryWatchdogSettleWindow))
	if !reflect.DeepEqual(victims, []memoryProcessID{sibling}) {
		t.Fatalf("victims = %v, want killing to resume after the settle window", victims)
	}
}

func sampleMemoryWatchdogAt(w *memoryWatchdog, now time.Time) {
	w.sample(func() time.Time { return now })
}

func containsMemoryIDs(have []memoryProcessID, want ...memoryProcessID) bool {
	ids := map[memoryProcessID]bool{}
	for _, id := range have {
		ids[id] = true
	}
	for _, id := range want {
		if !ids[id] {
			return false
		}
	}
	return true
}

func TestMemoryWatchdogRaisesToolOOMScore(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := exec.CommandContext(ctx, "/bin/sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); _ = cmd.Wait() }()

	path := "/proc/" + strconv.Itoa(cmd.Process.Pid)
	proc, ok := readMemoryProcess(path, cmd.Process.Pid)
	if !ok || !raiseToolOOMScore(proc.memoryProcessID) {
		t.Fatal("could not raise the tool process's OOM score")
	}
	score, err := os.ReadFile(path + "/oom_score_adj")
	if err != nil || strings.TrimSpace(string(score)) != "1000" {
		t.Fatalf("tool oom_score_adj = %q, error = %v", score, err)
	}
	t.Logf("Tool process %d has oom_score_adj=1000", cmd.Process.Pid)
}
