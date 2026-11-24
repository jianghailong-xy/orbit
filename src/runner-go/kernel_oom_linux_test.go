//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestManagedToolKernelOOMNotice(t *testing.T) {
	for _, tc := range []struct {
		name        string
		cgroupDelta bool
		exit        bool
		watchdog    bool
		want        []string
	}{
		{name: "kernel kill", cgroupDelta: true, want: []string{"kernel_oom"}},
		{name: "unrelated SIGKILL"},
		{name: "ordinary exit 137 during another OOM", cgroupDelta: true, exit: true},
		{name: "watchdog stop during another OOM", cgroupDelta: true, watchdog: true, want: []string{"memory_watchdog"}},
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
			check := watchMemoryTool(session)
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
