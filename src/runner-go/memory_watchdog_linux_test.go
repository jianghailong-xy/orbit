//go:build linux

package main

import (
	"context"
	"os"
	"os/exec"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestMemoryWatchdogKillsLargestToolGroup(t *testing.T) {
	const mib = 1 << 20
	processes := map[int]memoryProcess{}
	add := func(pid, parent, group int, rss uint64, name string) memoryProcessID {
		id := memoryProcessID{pid, 1}
		processes[pid] = memoryProcess{id, parent, group, rss * mib, name}
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
		readMemory: func() (uint64, uint64, bool) { return 1024 * mib, available, limited },
		processes: func() map[int]memoryProcess {
			snapshots++
			return processes
		},
		raiseScore: func(memoryProcessID) bool { return true },
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
	w.sample(now)
	if snapshots != 0 || len(kills) != 0 || len(notices) != 0 {
		t.Fatal("an unlimited cgroup triggered the watchdog")
	}

	limited, available = true, 160*mib
	w.sample(now)
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
	w.sample(now)
	if len(kills) != 2 || !containsMemoryIDs(kills, build, worker) {
		t.Fatalf("killed %v, want only the largest build and its compiler", kills)
	}
	if len(notices) != 1 || !strings.Contains(notices[0], `build-session: The runner stopped the "build" tool process group (PID 20) because the container was using 934 MiB of its 1024 MiB memory limit.`) {
		t.Fatalf("notices: %v", notices)
	}
	t.Log(notices[0])

	available = 160 * mib
	w.sample(now.Add(time.Second))
	available = 90 * mib
	w.sample(now.Add(2 * time.Second))
	if len(kills) != 2 {
		t.Fatal("the watchdog killed again during the cooldown")
	}
	w.sample(now.Add(memoryWatchdogCooldown))
	if len(kills) != 3 || kills[2] != other || len(notices) != 2 || !strings.HasPrefix(notices[1], "other-session: ") {
		t.Fatalf("after recovery: kills=%v notices=%v", kills, notices)
	}
	late := add(23, 12, 12, 75, "late-tool")
	w.sample(now.Add(3 * memoryWatchdogCooldown))
	if len(kills) != 3 {
		t.Fatal("the watchdog killed again before usage fell")
	}
	delete(processes, late.pid)
	available = 160 * mib
	w.sample(now.Add(4 * memoryWatchdogCooldown))
	available = 90 * mib
	w.sample(now.Add(4 * memoryWatchdogCooldown))
	if len(kills) != 3 {
		t.Fatal("the watchdog fell back to a daemon, engine or unrelated process")
	}
	t.Log("The daemon, both engines, and unrelated processes were protected. The watchdog waited for both recovery and cooldown.")
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
