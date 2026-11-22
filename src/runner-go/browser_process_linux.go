package main

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

// browserDisplayWait is how long Xvfb has to start accepting clients.
const browserDisplayWait = 10 * time.Second

// browserPgidFile lists the process groups of the browser's programs. A self-update re-executes the runner in place
// (selfupdate.go), and the programs a previous image of it started outlive it; the next start ends them first. It is
// on /tmp, which a new container starts empty, so a number from another container is never read.
const browserPgidFile = "/tmp/orbit-browser.pgids"

// execBrowserStarter starts the browser's programs as children of the runner, each in its own process group so
// stopping one ends what it spawned (Chrome's renderers).
type execBrowserStarter struct{}

type execBrowserProcess struct {
	cmd    *exec.Cmd
	done   chan struct{}
	exited atomic.Bool
}

func (execBrowserStarter) Start(name string, args []string) (browserProcess, error) {
	cmd := exec.Command(name, args...)
	cmd.Env = append(os.Environ(), "DISPLAY="+browserDisplay)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	if f, err := os.OpenFile(browserPgidFile, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600); err == nil {
		fmt.Fprintln(f, cmd.Process.Pid)
		f.Close()
	}
	p := &execBrowserProcess{cmd: cmd, done: make(chan struct{})}
	go func() {
		_ = cmd.Wait()
		p.exited.Store(true)
		close(p.done)
	}()
	return p, nil
}

// Reap ends the process groups browserPgidFile lists and empties it, then removes the display's socket and lock a
// killed Xvfb leaves, so the next WaitDisplay waits for the new one.
func (execBrowserStarter) Reap() {
	if data, err := os.ReadFile(browserPgidFile); err == nil {
		for _, line := range strings.Fields(string(data)) {
			if pgid, err := strconv.Atoi(line); err == nil && pgid > 1 {
				_ = syscall.Kill(-pgid, syscall.SIGKILL)
			}
		}
		_ = os.Remove(browserPgidFile)
	}
	n := strings.TrimPrefix(browserDisplay, ":")
	_ = os.Remove("/tmp/.X11-unix/X" + n)
	_ = os.Remove("/tmp/.X" + n + "-lock")
}

// WaitDisplay waits for Xvfb's socket, /tmp/.X11-unix/X<n>.
func (execBrowserStarter) WaitDisplay(display string) error {
	sock := "/tmp/.X11-unix/X" + strings.TrimPrefix(display, ":")
	deadline := time.Now().Add(browserDisplayWait)
	for {
		if _, err := os.Stat(sock); err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("display %s did not come up in %s", display, browserDisplayWait)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (p *execBrowserProcess) Exited() bool { return p.exited.Load() }

// Done is closed when the program has ended.
func (p *execBrowserProcess) Done() <-chan struct{} { return p.done }

// Stop sends the process group SIGTERM, and SIGKILL after 5 seconds.
func (p *execBrowserProcess) Stop() {
	pgid := p.cmd.Process.Pid
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	select {
	case <-p.done:
	case <-time.After(5 * time.Second):
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		<-p.done
	}
}
