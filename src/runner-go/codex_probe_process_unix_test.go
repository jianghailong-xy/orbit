//go:build linux || darwin

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func configureCodexProbeProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// stopCodexProbeProcess joins the CLI and its descendants before TempDir removes their home.
// A codex.js wrapper can exit while the native app-server still writes into CODEX_HOME.
func stopCodexProbeProcess(cmd *exec.Cmd, stdin io.Closer) error {
	var closeErr error
	if stdin != nil {
		closeErr = stdin.Close()
	}
	waited := make(chan error, 1)
	go func() { waited <- cmd.Wait() }()
	var waitErr error
	exited := false
	select {
	case waitErr = <-waited:
		exited = true
	case <-time.After(500 * time.Millisecond):
	}
	killErr := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	forced := !exited && killErr == nil
	if errors.Is(killErr, syscall.ESRCH) {
		killErr = nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if !exited {
		select {
		case waitErr = <-waited:
		case <-ctx.Done():
			waitErr = fmt.Errorf("probe pid %d did not exit: %w", cmd.Process.Pid, ctx.Err())
		}
	}
	var exitErr *exec.ExitError
	if forced && errors.As(waitErr, &exitErr) {
		if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() && status.Signal() == syscall.SIGKILL {
			waitErr = nil
		}
	}
	for {
		alive, err := codexProbeGroupAlive(ctx, cmd.Process.Pid)
		if err != nil {
			return errors.Join(closeErr, killErr, waitErr, err)
		}
		if !alive {
			return errors.Join(closeErr, killErr, waitErr)
		}
		select {
		case <-ctx.Done():
			return errors.Join(closeErr, killErr, waitErr, fmt.Errorf("probe group %d still running: %w", cmd.Process.Pid, ctx.Err()))
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func codexProbeGroupAlive(ctx context.Context, pgid int) (bool, error) {
	if err := syscall.Kill(-pgid, 0); errors.Is(err, syscall.ESRCH) {
		return false, nil
	}
	out, err := exec.CommandContext(ctx, "ps", "-A", "-o", "pgid=,stat=").Output()
	if err != nil {
		return false, fmt.Errorf("inspect probe group %d: %w", pgid, err)
	}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		// Zombies have finished executing and cannot write; PID 1 may reap them later.
		if len(fields) == 2 && fields[0] == strconv.Itoa(pgid) && !strings.HasPrefix(fields[1], "Z") {
			return true, nil
		}
	}
	return false, nil
}

func TestCodexProbeCleanupStopsHomeWriters(t *testing.T) {
	for _, mode := range []string{"graceful", "orphan", "forced", "unexpected"} {
		t.Run(mode, func(t *testing.T) {
			home := t.TempDir()
			cmd := exec.Command(os.Args[0], "-test.run=^TestCodexProbeProcessHelper$")
			cmd.Env = append(os.Environ(), "ORBIT_CODEX_PROBE_HELPER="+mode, "CODEX_HOME="+home)
			configureCodexProbeProcess(cmd)
			stdin, err := cmd.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			stopped := false
			t.Cleanup(func() {
				if !stopped {
					if err := stopCodexProbeProcess(cmd, stdin); err != nil {
						t.Errorf("probe cleanup: %v", err)
					}
				}
			})
			writes := filepath.Join(home, "writes")
			deadline := time.Now().Add(5 * time.Second)
			for {
				if data, err := os.ReadFile(writes); err == nil && len(data) > 0 {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("descendant did not write into CODEX_HOME")
				}
				time.Sleep(5 * time.Millisecond)
			}
			err = stopCodexProbeProcess(cmd, stdin)
			stopped = true
			if (err != nil) != (mode == "unexpected") {
				t.Fatalf("cleanup returned %v for %s", err, mode)
			}
			if mode == "unexpected" {
				var exitErr *exec.ExitError
				if !errors.As(err, &exitErr) || exitErr.ExitCode() != 7 {
					t.Fatalf("cleanup lost the unexpected exit status: %v", err)
				}
			}
			if mode != "forced" {
				if _, err := os.Stat(filepath.Join(home, "eof")); err != nil {
					t.Fatalf("wrapper did not exit on stdin EOF: %v", err)
				}
			}
			before, err := os.ReadFile(writes)
			if err != nil {
				t.Fatal(err)
			}
			time.Sleep(30 * time.Millisecond)
			after, err := os.ReadFile(writes)
			if err != nil {
				t.Fatal(err)
			}
			if len(after) != len(before) {
				t.Fatal("descendant still writes after cleanup returned")
			}
		})
	}
}

func TestCodexProbeProcessHelper(t *testing.T) {
	mode := os.Getenv("ORBIT_CODEX_PROBE_HELPER")
	if mode == "" {
		return
	}
	home := os.Getenv("CODEX_HOME")
	if mode == "writer" {
		file, err := os.OpenFile(filepath.Join(home, "writes"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			os.Exit(2)
		}
		for {
			if _, err := os.Stat(filepath.Join(home, "stop")); err == nil {
				os.Exit(0)
			}
			if _, err := file.WriteString("write\n"); err != nil {
				os.Exit(3)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	writer := exec.Command(os.Args[0], "-test.run=^TestCodexProbeProcessHelper$")
	writer.Env = envWithValue(os.Environ(), "ORBIT_CODEX_PROBE_HELPER", "writer")
	if err := writer.Start(); err != nil {
		os.Exit(4)
	}
	if mode == "forced" {
		for {
			time.Sleep(time.Hour)
		}
	}
	_, _ = io.Copy(io.Discard, os.Stdin)
	if mode != "orphan" {
		if err := os.WriteFile(filepath.Join(home, "stop"), nil, 0o600); err != nil {
			os.Exit(5)
		}
		if err := writer.Wait(); err != nil {
			os.Exit(6)
		}
	}
	if err := os.WriteFile(filepath.Join(home, "eof"), nil, 0o600); err != nil {
		os.Exit(8)
	}
	if mode == "unexpected" {
		os.Exit(7)
	}
	os.Exit(0)
}
