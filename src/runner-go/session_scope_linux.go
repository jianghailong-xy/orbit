package main

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// prSetChildSubreaper is PR_SET_CHILD_SUBREAPER (linux/prctl.h).
const prSetChildSubreaper = 36

// sessionScopeStartTimeout is how long the runner waits for the keeper to say it started the process.
const sessionScopeStartTimeout = 30 * time.Second

// sessionScopeRunnerGoneGrace is how long the keeper of a runner that went away gives the process to end
// on SIGTERM before it is killed with the rest of the scope.
const sessionScopeRunnerGoneGrace = 10 * time.Second

// sessionScopeRescan is how often a keeper reclaiming its scope looks again for what is left in it.
const sessionScopeRescan = 50 * time.Millisecond

// sessionScope is the runner's end of the keeper's control socket. The keeper reports on it whether the
// process started, then reads it for as long as the process runs: when it closes — the runner closes it
// once the keeper has exited, or the runner itself went away — the keeper sends the process SIGTERM, and
// reclaims the scope with it after sessionScopeRunnerGoneGrace.
type sessionScope struct {
	control *os.File
}

// startInSessionScope starts cmd — a session's process, configured by configureSessionProcessTree — under
// a keeper. cmd becomes the keeper's command line; the keeper starts the process with cmd's environment,
// working directory and standard streams, and its exit status is the process's. It returns once the keeper
// has said the process started, and a process that could not be started is the error exec would have
// returned for it.
func startInSessionScope(cmd *exec.Cmd) (*sessionScope, error) {
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("could not set up the session's process scope: %w", err)
	}
	// Non-blocking, so that the keeper's report is awaited with a deadline.
	if err := syscall.SetNonblock(fds[0], true); err != nil {
		_ = syscall.Close(fds[0])
		_ = syscall.Close(fds[1])
		return nil, fmt.Errorf("could not set up the session's process scope: %w", err)
	}
	control := os.NewFile(uintptr(fds[0]), "session-scope")
	keeperEnd := os.NewFile(uintptr(fds[1]), "session-scope-keeper")
	path := cmd.Path
	// /proc/self/exe is this image, even once a self-update has replaced the file it was started from.
	cmd.Args = append([]string{"orbit", sessionScopeCommand, strconv.Itoa(3 + len(cmd.ExtraFiles)), "--", path}, cmd.Args[1:]...)
	cmd.Path = "/proc/self/exe"
	cmd.ExtraFiles = append(cmd.ExtraFiles, keeperEnd)
	err = startSessionProcess(cmd)
	_ = keeperEnd.Close()
	if err != nil {
		_ = control.Close()
		return nil, err
	}
	if err := awaitSessionScopeStart(control, path); err != nil {
		_ = terminateSessionProcessTree(cmd)
		_ = cmd.Wait()
		_ = control.Close()
		return nil, err
	}
	return &sessionScope{control: control}, nil
}

// close tells the keeper the runner is done with the scope.
func (s *sessionScope) close() {
	if s != nil {
		_ = s.control.Close()
	}
}

// awaitSessionScopeStart reads the keeper's one report: "ok", or "error <errno> <message>" for a process
// it could not start, which comes back as the error exec reports for one.
func awaitSessionScopeStart(control *os.File, path string) error {
	_ = control.SetReadDeadline(time.Now().Add(sessionScopeStartTimeout))
	line, err := bufio.NewReader(control).ReadString('\n')
	_ = control.SetReadDeadline(time.Time{})
	if err != nil {
		return fmt.Errorf("the session's process scope did not report starting %s: %w", path, err)
	}
	report := strings.TrimSuffix(line, "\n")
	if report == "ok" {
		return nil
	}
	if rest, ok := strings.CutPrefix(report, "error "); ok {
		code, message, _ := strings.Cut(rest, " ")
		if errno, err := strconv.Atoi(code); err == nil && errno > 0 {
			return &fs.PathError{Op: "fork/exec", Path: path, Err: syscall.Errno(errno)}
		}
		return errors.New(message)
	}
	return fmt.Errorf("the session's process scope reported %q", report)
}

type sessionScopeExit struct {
	pid    int
	status syscall.WaitStatus
}

// runSessionScope is the keeper, `orbit session-scope <control-fd> -- <path> [args...]`. It starts the
// process, passes it the signals the runner sends, and reaps what the session orphans; once the process
// has ended, it reclaims the scope and exits as the process did.
func runSessionScope(args []string) int {
	fd := -1
	if len(args) >= 3 && args[1] == "--" {
		fd, _ = strconv.Atoi(args[0])
	}
	if fd < 3 {
		fmt.Fprintln(os.Stderr, "orbit session-scope: the Orbit runner starts this itself")
		return 2
	}
	syscall.CloseOnExec(fd) // the keeper's, not the process's
	control := os.NewFile(uintptr(fd), "session-scope")
	// Before the process exists, so that no stop the runner sends is lost: Go's default for these ends the
	// keeper, which would leave the process to init.
	signals := make(chan os.Signal, 8)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP, syscall.SIGQUIT)
	if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, prSetChildSubreaper, 1, 0); errno != 0 {
		fmt.Fprintf(control, "error 0 Orbit could not give the session a process scope (PR_SET_CHILD_SUBREAPER: %v)\n", errno)
		return 1
	}
	process, err := os.StartProcess(args[2], args[2:], &os.ProcAttr{Env: os.Environ(), Files: []*os.File{os.Stdin, os.Stdout, os.Stderr}})
	if err != nil {
		var errno syscall.Errno // 0 for an error that carries none
		_ = errors.As(err, &errno)
		fmt.Fprintf(control, "error %d %s\n", int(errno), strings.ReplaceAll(err.Error(), "\n", " "))
		return 1
	}
	fmt.Fprintln(control, "ok")
	// The process holds the session's standard streams from here on, so each of them ends with it.
	if null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0); err == nil {
		for _, std := range []int{0, 1, 2} {
			_ = syscall.Dup3(int(null.Fd()), std, 0)
		}
		_ = null.Close()
	}
	exits := make(chan sessionScopeExit, 16)
	go reapSessionScope(exits)
	runnerGone := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, control)
		close(runnerGone)
	}()
	var status syscall.WaitStatus
	ended := false
	gone := (<-chan struct{})(runnerGone)
	var giveUp <-chan time.Time
wait:
	for {
		select {
		case sig := <-signals:
			_ = process.Signal(sig)
		case <-gone:
			// The runner went away without ending the session, so the process is told to stop, as the
			// runner would have told it.
			gone = nil
			_ = process.Signal(syscall.SIGTERM)
			giveUp = time.After(sessionScopeRunnerGoneGrace)
		case <-giveUp:
			break wait
		case e, ok := <-exits:
			if !ok {
				break wait
			}
			if e.pid == process.Pid {
				status, ended = e.status, true
				break wait
			}
		}
	}
	reclaimSessionScope(exits, process.Pid, &status, &ended)
	if !ended {
		return 1
	}
	return exitLikeSessionProcess(status)
}

// reapSessionScope reaps every child the keeper has — the process, and each orphan of the session as it
// is adopted and exits — and closes exits once there is none left, when nothing of the session is.
func reapSessionScope(exits chan<- sessionScopeExit) {
	defer close(exits)
	for {
		var status syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &status, 0, nil)
		if err == syscall.EINTR {
			continue
		}
		if err != nil {
			return
		}
		exits <- sessionScopeExit{pid: pid, status: status}
	}
}

// reclaimSessionScope kills every descendant the keeper still has and reaps it, until it has no child
// left. A process forked while this runs is found on the next look, and none gets away: its orphans come
// to the keeper. The process's own exit, should it come now, is recorded in status.
func reclaimSessionScope(exits <-chan sessionScopeExit, pid int, status *syscall.WaitStatus, ended *bool) {
	self := os.Getpid()
	for {
		for _, descendant := range sessionScopeDescendants(self) {
			_ = syscall.Kill(descendant, syscall.SIGKILL)
		}
		rescan := time.NewTimer(sessionScopeRescan)
	drain:
		for {
			select {
			case e, ok := <-exits:
				if !ok {
					rescan.Stop()
					return
				}
				if e.pid == pid {
					*status, *ended = e.status, true
				}
			case <-rescan.C:
				break drain
			}
		}
	}
}

// sessionScopeDescendants is every process below root, by the parent each /proc/<pid>/stat names.
func sessionScopeDescendants(root int) []int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	children := map[int][]int{}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		stat, err := os.ReadFile("/proc/" + entry.Name() + "/stat")
		if err != nil {
			continue // gone since the listing
		}
		// "pid (comm) state ppid …": comm can hold anything, so the fields are read after its last ')'.
		fields := strings.Fields(string(stat[bytes.LastIndexByte(stat, ')')+1:]))
		if len(fields) < 2 {
			continue
		}
		if ppid, err := strconv.Atoi(fields[1]); err == nil {
			children[ppid] = append(children[ppid], pid)
		}
	}
	var descendants []int
	seen := map[int]bool{root: true}
	queue := append([]int(nil), children[root]...)
	for len(queue) > 0 {
		pid := queue[0]
		queue = queue[1:]
		if seen[pid] {
			continue
		}
		seen[pid] = true
		descendants = append(descendants, pid)
		queue = append(queue, children[pid]...)
	}
	return descendants
}

// exitLikeSessionProcess ends the keeper the way the process ended — with its exit code, or dead of the
// signal that killed it — so that the runner reads the process's exit status off the keeper.
func exitLikeSessionProcess(status syscall.WaitStatus) int {
	if !status.Signaled() {
		return status.ExitStatus()
	}
	sig := status.Signal()
	signal.Reset(sig)
	// No core of the keeper, which would only land in the session's checkout.
	_ = syscall.Setrlimit(syscall.RLIMIT_CORE, &syscall.Rlimit{})
	// Go catches most signals itself. With the default action back — a zero struct sigaction is SIG_DFL,
	// no flags and an empty mask — the signal ends the keeper as it ended the process.
	var dfl [4]uint64
	_, _, _ = syscall.RawSyscall6(syscall.SYS_RT_SIGACTION, uintptr(sig), uintptr(unsafe.Pointer(&dfl)), 0, 8, 0, 0)
	_ = syscall.Kill(os.Getpid(), sig)
	time.Sleep(time.Second)
	return 128 + int(sig)
}
