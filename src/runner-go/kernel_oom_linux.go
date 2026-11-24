//go:build linux

package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"

	"golang.org/x/sys/unix"
)

const memoryToolShellComm = "orbit-oom-shell"
const memoryToolExitOp = "memory_tool_exit"

func cgroupOOMKills(dir string) (uint64, bool) {
	data, err := os.ReadFile(filepath.Join(dir, "memory.events"))
	if err != nil {
		return 0, false
	}
	return statField(string(data), "oom_kill")
}

// Arm the check before starting a runner-owned tool. Check the real wait
// status while the PID still belongs to that tool, before cmd.Wait reaps it.
// A tool ended through ctx was killed by the runner (a budget, bg_kill, a
// stop), not by the kernel, even if another tool's OOM moved the counter.
func watchMemoryTool(ctx context.Context, session string) func(int) {
	w := activeMemoryWatchdog.Load()
	if w != nil && session != "" {
		if before, ok := w.readOOMKills(); ok {
			return func(pid int) {
				awaitChildExit(pid)
				if ctx.Err() == nil {
					w.reportKernelOOM(session, pid, os.Getpid(), before)
				}
			}
		}
	}
	return func(int) {}
}

func (w *memoryWatchdog) reportKernelOOM(session string, pid, parent int, before uint64) {
	p, status, _ := readMemoryProcessStat("/proc/"+strconv.Itoa(pid), pid)
	if p.ppid != parent || !status.Signaled() || status.Signal() != unix.SIGKILL {
		return
	}
	// Serialize with the watchdog's signal and record. A cgroup counter alone
	// cannot distinguish its SIGKILL from a kernel kill in another tool.
	w.mu.Lock()
	watchdogStopped := w.watchdogVictims[p.memoryProcessID]
	w.mu.Unlock()
	if watchdogStopped {
		return
	}
	after, ok := w.readOOMKills()
	if !ok || after <= before {
		return
	}
	limit, _, ok := w.readMemory()
	if !ok || limit == 0 {
		return
	}
	message := fmt.Sprintf("The kernel stopped the tool process (PID %d) because the container ran out of memory. The container limit is %d MiB.", pid, limit>>20)
	logln("kernel OOM for session", publicID(session), message)
	emitSessionNotice(session, map[string]interface{}{"subtype": "kernel_oom", "notice": message})
}

// Claude owns and reaps its Bash children, and flattens a signal into a tool
// error. A shell launcher preserves its argv and holds the real wait status
// long enough for the session's runner to inspect it.
func memoryToolClaudeEnv(env []string) []string {
	socket := envValue(env, envBgSocket)
	if activeMemoryWatchdog.Load() == nil || socket == "" {
		return env
	}
	shell := envValue(env, "CLAUDE_CODE_SHELL")
	if shell == "" {
		shell = envValue(env, "SHELL")
	}
	if shell == "" {
		shell = "/bin/bash"
	}
	base := filepath.Base(shell)
	exe := orbitCLIExecutable()
	if exe == "" || !filepath.IsAbs(shell) || (base != "bash" && base != "zsh") || unix.Access(shell, unix.X_OK) != nil {
		return env
	}
	dir := filepath.Join(filepath.Dir(socket), "oom-shell")
	path := filepath.Join(dir, base)
	script := "#!/bin/sh\nexec " + shellQuote(exe) + " " + memoryToolShellComm + " " + shellQuote(shell) + " \"$@\"\n"
	if os.MkdirAll(dir, 0700) != nil || writeFileAtomically(path, []byte(script), 0700) != nil {
		return env
	}
	return envWithValue(env, "CLAUDE_CODE_SHELL", path)
}

func runMemoryToolShell(args []string) int { return runMemoryToolShellIn(cgroupRoot, args) }

func runMemoryToolShellIn(cgroup string, args []string) int {
	if len(args) == 0 || !filepath.IsAbs(args[0]) {
		return 126
	}
	socket, token := os.Getenv(envBgSocket), os.Getenv(envBgToken)
	before, ok := cgroupOOMKills(cgroup)
	if !ok || socket == "" || token == "" {
		if err := unix.Exec(args[0], args, os.Environ()); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
		return 126
	}
	_ = os.WriteFile("/proc/self/comm", []byte(memoryToolShellComm), 0)
	// Claude signals the shell's whole process group, so the shell gets each
	// signal itself. Outlive it instead of killing it through the death signal.
	// Unlike signal.Ignore, Notify does not pass to the shell across exec.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, unix.SIGHUP, unix.SIGINT, unix.SIGQUIT, unix.SIGTERM)
	defer signal.Stop(signals)
	// Linux binds the death signal to the thread that starts the child.
	// Keep that thread alive until Wait, and reap if Claude stops the launcher.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.SysProcAttr = &unix.SysProcAttr{Pdeathsig: unix.SIGKILL}
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 126
	}
	pid := cmd.Process.Pid
	awaitChildExit(pid)
	_, status, _ := readMemoryProcessStat("/proc/"+strconv.Itoa(pid), pid)
	if status.Signaled() && status.Signal() == unix.SIGKILL {
		_, _ = bgSocketCall(socket, token, memoryToolExitOp, map[string]interface{}{
			"pid": strconv.Itoa(pid), "oomKillsBefore": strconv.FormatUint(before, 10),
		})
	}
	_ = cmd.Wait()
	if status, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		// The shell's own convention. Raising the signal here instead would
		// make Go print a goroutine dump for SIGABRT or SIGSEGV.
		return 128 + int(status.Signal())
	}
	return cmd.ProcessState.ExitCode()
}

func (s *bgJobService) reportMemoryToolExit(conn net.Conn, args map[string]interface{}) {
	w := activeMemoryWatchdog.Load()
	c, ok := conn.(*net.UnixConn)
	pid, pidErr := strconv.Atoi(getString(args, "pid"))
	before, countErr := strconv.ParseUint(getString(args, "oomKillsBefore"), 10, 64)
	if w == nil || !ok || pidErr != nil || pid <= 0 || countErr != nil {
		return
	}
	raw, err := c.SyscallConn()
	if err != nil {
		return
	}
	var peer *unix.Ucred
	if raw.Control(func(fd uintptr) {
		peer, _ = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}) == nil && peer != nil && peer.Pid > 0 {
		w.reportKernelOOM(s.sessionID, pid, int(peer.Pid), before)
	}
}
