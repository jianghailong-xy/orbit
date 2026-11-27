//go:build linux

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestManagedToolKernelOOMNotice(t *testing.T) {
	for _, tc := range []struct {
		name        string
		cgroupDelta bool
		exit        bool
		watchdog    bool
		runnerStop  bool
		want        []string
	}{
		{name: "kernel kill", cgroupDelta: true, want: []string{"kernel_oom"}},
		{name: "unrelated SIGKILL"},
		{name: "ordinary exit 137 during another OOM", cgroupDelta: true, exit: true},
		{name: "watchdog stop during another OOM", cgroupDelta: true, watchdog: true, want: []string{"memory_watchdog"}},
		{name: "runner stop during another OOM", cgroupDelta: true, runnerStop: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const session = "allocator-session"
			var notices []string
			var kernelNotice string
			defer registerMainCheckoutNotices(session, func(_ string, event string, payload map[string]interface{}) {
				if event != evSystem {
					t.Fatalf("event = %q, want %s", event, evSystem)
				}
				subtype := payload["subtype"].(string)
				notices = append(notices, subtype)
				if subtype == "kernel_oom" {
					kernelNotice = payload["notice"].(string)
				}
			})()
			defer registerMainCheckoutNotices("sibling-session", func(_ string, _ string, _ map[string]interface{}) {
				t.Error("the sibling received the allocator's notice")
			})()

			dir := t.TempDir()
			setKills := func(kills int) {
				t.Helper()
				if err := os.WriteFile(filepath.Join(dir, "memory.events"), []byte(fmt.Sprintf("oom_kill %d\n", kills)), 0600); err != nil {
					t.Fatal(err)
				}
			}
			setKills(4)
			cmd := exec.Command("sh", "-c", "read line; exit 137")
			input, err := cmd.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			w := &memoryWatchdog{
				readMemory:   func() (uint64, uint64, bool) { return 4 << 30, 1, true },
				readOOMKills: func() (uint64, bool) { return cgroupOOMKills(dir) },
				processes:    readMemoryProcesses,
				processSize:  func(memoryProcess) uint64 { return 1 },
				raiseScore:   func(memoryProcessID) bool { return true },
				kill:         func(id memoryProcessID) bool { return id.pid == cmd.Process.Pid && cmd.Process.Kill() == nil },
				notify:       notifyMemoryWatchdogKill,
				oomKills:     4,
				roots:        make(map[memoryProcessID]memoryRoot),
				raised:       make(map[memoryProcessID]bool),
			}
			previous := activeMemoryWatchdog.Swap(w)
			defer activeMemoryWatchdog.Store(previous)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			check := watchMemoryTool(ctx, session)
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() {
				_ = cmd.Process.Kill()
				_ = input.Close()
				_ = cmd.Wait()
			}()
			pid := cmd.Process.Pid
			trackMemoryRoots(session, true, pid)
			if tc.watchdog {
				w.sample(time.Now)
				if !reflect.DeepEqual(notices, []string{"memory_watchdog"}) {
					t.Fatalf("watchdog did not stop the tool: %v", notices)
				}
			}
			if tc.cgroupDelta {
				setKills(5)
			}
			if tc.runnerStop {
				// As a shell turn's budget or bg_kill does: the context ends, then the process.
				cancel()
			}
			if tc.exit {
				_ = input.Close()
			} else if !tc.watchdog {
				if err := cmd.Process.Kill(); err != nil {
					t.Fatal(err)
				}
			}
			check(pid)
			if !reflect.DeepEqual(notices, tc.want) {
				t.Fatalf("notice subtypes = %v, want %v", notices, tc.want)
			}
			if len(tc.want) > 0 && tc.want[0] == "kernel_oom" {
				want := fmt.Sprintf("The kernel stopped the tool process (PID %d) because the container ran out of memory. The container limit is 4096 MiB.", pid)
				if kernelNotice != want {
					t.Fatalf("kernel notice = %q, want %q", kernelNotice, want)
				}
			}
		})
	}
}

// Claude reaps its own Bash shells, so on a managed runner the shell runs under the launcher,
// which sees the real wait status and asks the runner over the session's socket. The shell's
// exit code is 137 in all three cases; only a SIGKILL with an oom_kill increase gets the notice.
func TestClaudeShellLauncherReportsOnlyAKernelKill(t *testing.T) {
	const session = "allocator-session"
	dir := t.TempDir()
	events := filepath.Join(dir, "memory.events")
	w := &memoryWatchdog{
		readMemory:   func() (uint64, uint64, bool) { return 4 << 30, 3 << 30, true },
		readOOMKills: func() (uint64, bool) { return cgroupOOMKills(dir) },
	}
	previous := activeMemoryWatchdog.Swap(w)
	defer activeMemoryWatchdog.Store(previous)

	// A short path: a unix socket path has a small length limit.
	socketDir, err := os.MkdirTemp("", "oom")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(socketDir)
	socket := filepath.Join(socketDir, "bg.sock")
	svc := &bgJobService{token: "launcher-token", sessionID: session}
	stopService, err := startBgJobService(context.Background(), svc, socket, filepath.Join(socketDir, "bg.token"))
	if err != nil {
		t.Fatal(err)
	}
	defer stopService()
	t.Setenv(envBgSocket, socket)
	t.Setenv(envBgToken, "launcher-token")
	t.Setenv("CLAUDE_CODE_SHELL", "")
	t.Setenv("SHELL", "/bin/bash")
	env := memoryToolClaudeEnv(os.Environ())
	launcher := envValue(env, "CLAUDE_CODE_SHELL")
	script, err := os.ReadFile(launcher)
	if filepath.Base(launcher) != "bash" || err != nil || !strings.Contains(string(script), " "+memoryToolShellComm+" '/bin/bash' \"$@\"") {
		t.Fatalf("CLAUDE_CODE_SHELL=%q script=%q err=%v", launcher, script, err)
	}

	// The launcher renames this process for the watchdog. Put the test binary's name back.
	comm, err := os.ReadFile("/proc/self/comm")
	if err != nil {
		t.Fatal(err)
	}
	defer os.WriteFile("/proc/self/comm", comm, 0)

	var mu sync.Mutex
	var notices []string
	defer registerMainCheckoutNotices(session, func(_ string, _ string, payload map[string]interface{}) {
		mu.Lock()
		defer mu.Unlock()
		notices = append(notices, payload["subtype"].(string)+": "+payload["notice"].(string))
	})()

	pidFile := filepath.Join(dir, "shell.pid")
	for _, tc := range []struct {
		name, command string
		want          bool
	}{
		{"kernel kill", `printf 'oom_kill 5\n' > "$EVENTS"; kill -KILL $$`, true},
		{"exit 137 during another OOM", `printf 'oom_kill 5\n' > "$EVENTS"; exit 137`, false},
		{"unrelated SIGKILL", `kill -KILL $$`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := os.WriteFile(events, []byte("oom_kill 4\n"), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("EVENTS", events)
			mu.Lock()
			notices = nil
			mu.Unlock()
			code := runMemoryToolShellIn(dir, []string{"/bin/sh", "-c", `echo $$ > "` + pidFile + `"; ` + tc.command})
			if code != 137 {
				t.Fatalf("exit code = %d, want 137", code)
			}
			pid, err := os.ReadFile(pidFile)
			if err != nil {
				t.Fatal(err)
			}
			var want []string
			if tc.want {
				want = []string{"kernel_oom: The kernel stopped the tool process (PID " + strings.TrimSpace(string(pid)) +
					") because the container ran out of memory. The container limit is 4096 MiB."}
			}
			mu.Lock()
			defer mu.Unlock()
			if !reflect.DeepEqual(notices, want) {
				t.Fatalf("notices = %q, want %q", notices, want)
			}
		})
	}
}

// The launcher is an Orbit process, so the watchdog never scores or stops it, but it must not hide
// the shell under it: the shell still belongs to its engine's session, as it did before the launcher.
func TestMemoryWatchdogSeesToolsThroughTheShellLauncher(t *testing.T) {
	const mib = 1 << 20
	processes := map[int]memoryProcess{}
	add := func(pid, parent, group int, rss uint64, name string, protected bool) memoryProcessID {
		id := memoryProcessID{pid, 1}
		processes[pid] = memoryProcess{memoryProcessID: id, ppid: parent, pgid: group, rss: rss * mib, name: name, protected: protected}
		return id
	}
	add(1, 0, 1, 50, "orbit", true)
	engine := add(10, 1, 10, 200, "claude", false)
	add(11, 10, 11, 8, memoryToolShellComm, true)
	shell := add(12, 11, 11, 4, "bash", false)
	allocator := add(13, 12, 11, 700, "python3", false)
	siblingEngine := add(20, 1, 20, 200, "claude", false)
	add(21, 20, 21, 8, memoryToolShellComm, true)
	siblingShell := add(22, 21, 21, 4, "bash", false)
	add(23, 20, 20, 30, "orbit", true)
	add(24, 23, 24, 5, "helper-child", false)

	var kills []memoryProcessID
	var notices []string
	w := &memoryWatchdog{
		readMemory:   func() (uint64, uint64, bool) { return 1024 * mib, 90 * mib, true },
		readOOMKills: func() (uint64, bool) { return 0, true },
		processes:    func() map[int]memoryProcess { return processes },
		processSize:  func(p memoryProcess) uint64 { return p.rss },
		raiseScore:   func(memoryProcessID) bool { return true },
		kill: func(id memoryProcessID) bool {
			kills = append(kills, id)
			return true
		},
		notify: func(session, message string) { notices = append(notices, session+": "+message) },
		roots: map[memoryProcessID]memoryRoot{
			engine: {"allocator", false}, siblingEngine: {"sibling", false},
		},
		raised: map[memoryProcessID]bool{},
	}
	w.sample(time.Now)
	if !reflect.DeepEqual(w.raised, map[memoryProcessID]bool{shell: true, allocator: true, siblingShell: true}) {
		t.Fatalf("raised %v, want both shells and the allocator, never a launcher or an Orbit helper's child", w.raised)
	}
	if len(kills) != 2 || !containsMemoryIDs(kills, shell, allocator) {
		t.Fatalf("killed %v, want the allocator's shell group", kills)
	}
	want := `allocator: The runner stopped the "bash" tool process group (PID ` + strconv.Itoa(shell.pid) + `) because`
	if len(notices) != 1 || !strings.HasPrefix(notices[0], want) {
		t.Fatalf("notices = %q, want one starting %q", notices, want)
	}
}
