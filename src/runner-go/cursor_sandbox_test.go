package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestCursorSandboxDetection(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("No sandbox backend for this platform")
	}
	workspace := t.TempDir()
	t.Setenv("ORBIT_HOME", t.TempDir())
	if err := os.MkdirAll(runnerCacheRoot(), 0700); err != nil {
		t.Fatal(err)
	}
	t.Run("missing binary", func(t *testing.T) {
		t.Setenv("PATH", t.TempDir())
		sandbox, reason := detectCursorSandbox(context.Background(), nil, workspace)
		if sandbox != nil || !strings.Contains(reason, "binary is unavailable") {
			t.Fatalf("got %v, %q", sandbox, reason)
		}
	})
	t.Run("unusable binary", func(t *testing.T) {
		bin := t.TempDir()
		name := "bwrap"
		if runtime.GOOS == "darwin" {
			name = "sandbox-exec"
		}
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\necho 'sandbox disabled' >&2\nexit 1\n"), 0700); err != nil {
			t.Fatal(err)
		}
		t.Setenv("PATH", bin)
		sandbox, reason := detectCursorSandbox(context.Background(), nil, workspace)
		if sandbox != nil || !strings.Contains(reason, "trial failed") || !strings.Contains(reason, "sandbox disabled") {
			t.Fatalf("got %v, %q", sandbox, reason)
		}
	})
}

func TestCursorSandboxConfinement(t *testing.T) {
	workspace := t.TempDir()
	t.Setenv("ORBIT_HOME", t.TempDir())
	if err := os.MkdirAll(runnerCacheRoot(), 0700); err != nil {
		t.Fatal(err)
	}
	sandbox, reason := detectCursorSandbox(context.Background(), nil, workspace)
	if sandbox == nil {
		if os.Getenv("ORBIT_REQUIRE_CURSOR_SANDBOX") == "1" {
			t.Fatal("Required OS sandbox is unusable: " + reason)
		}
		t.Skip("No usable OS sandbox: " + reason)
	}
	t.Logf("Sandbox detection returned usable: %s", sandbox.binary)
	// HOME must be outside /tmp and every other writable root, or a denial
	// assertion would be meaningless. Use an empty directory in the real home.
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	outside, err := os.MkdirTemp(home, ".orbit-sandbox-test-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(outside)
	for _, root := range sandbox.roots {
		resolved, err := filepath.EvalSymlinks(outside)
		if err != nil {
			t.Fatal(err)
		}
		rel, _ := filepath.Rel(root, resolved)
		if rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))) {
			t.Skip("Host HOME is inside a sandbox writable root")
		}
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			defer conn.Close()
			fmt.Fprint(conn, "network-ok")
		}
	}()
	var files []*os.File
	for fd := 3; fd <= 5; fd++ {
		read, write, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		defer read.Close()
		if _, err := fmt.Fprintf(write, "fd-%d-ok", fd); err != nil {
			t.Fatal(err)
		}
		write.Close()
		files = append(files, read)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestCursorSandboxChild$", "-test.v")
	cmd.Dir = workspace
	cmd.Env = append(os.Environ(), "ORBIT_SANDBOX_CHILD=1", "HOME="+outside, "SANDBOX_WORKSPACE="+workspace, "SANDBOX_NETWORK="+listener.Addr().String())
	cmd.ExtraFiles = files
	sandbox.wrap(cmd)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("sandbox: %v\n%s", err, output)
	} else {
		t.Log(string(output))
	}
	// Exercise the project's exact Python heredoc shape under the same sandbox.
	name := fmt.Sprintf("outside-file-%d", time.Now().UnixNano())
	python := exec.CommandContext(ctx, "/bin/bash", "-c", "python3 - <<'PY'\nimport os\nfrom pathlib import Path\n(Path.home() / os.environ['SANDBOX_OUTSIDE_NAME']).write_text('forbidden')\nPY")
	python.Dir = workspace
	python.Env = append(cmd.Env, "SANDBOX_OUTSIDE_NAME="+name)
	sandbox.wrap(python)
	output, err := python.CombinedOutput()
	if err == nil || (!strings.Contains(string(output), "Read-only file system") && !strings.Contains(string(output), "Permission denied")) {
		t.Fatalf("Python HOME write did not fail with a filesystem denial: %v\n%s", err, output)
	}
	if _, err := os.Stat(filepath.Join(outside, name)); !os.IsNotExist(err) {
		t.Fatalf("Python outside file exists or stat failed: %v", err)
	}
	t.Logf("Python heredoc write to $HOME/%s denied; file absent: %s", name, strings.TrimSpace(string(output)))
	if _, err := os.Stat(filepath.Join(outside, "outside-file")); !os.IsNotExist(err) {
		t.Fatalf("outside file exists or stat failed: %v", err)
	}
}

func TestCursorSandboxChild(t *testing.T) {
	if os.Getenv("ORBIT_SANDBOX_CHILD") != "1" {
		return // Only runs as the sandboxed child.
	}
	for _, root := range []string{os.Getenv("SANDBOX_WORKSPACE"), "/tmp", os.TempDir(), runnerCacheRoot()} {
		file, err := os.CreateTemp(root, "cursor-sandbox-")
		if err != nil {
			t.Fatalf("write to %s: %v", root, err)
		}
		file.Close()
		os.Remove(file.Name())
		t.Logf("write succeeded: %s", root)
	}
	outside := filepath.Join(os.Getenv("HOME"), "outside-file")
	if err := os.WriteFile(outside, []byte("forbidden"), 0600); err == nil {
		t.Fatal("write to HOME succeeded")
	}
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Fatalf("outside file is not absent: %v", err)
	}
	t.Log("HOME write denied and file absent")
	conn, err := net.DialTimeout("tcp", os.Getenv("SANDBOX_NETWORK"), 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	data := make([]byte, 10)
	if _, err := io.ReadFull(conn, data); err != nil || string(data) != "network-ok" {
		t.Fatalf("outbound connection: %q, %v", data, err)
	}
	t.Log("outbound connection to host listener succeeded")
	for number := 3; number <= 5; number++ {
		fd := os.NewFile(uintptr(number), "cursor-plumbing")
		want := fmt.Sprintf("fd-%d-ok", number)
		data := make([]byte, len(want))
		_, err := io.ReadFull(fd, data)
		fd.Close()
		if err != nil || string(data) != want {
			t.Fatalf("inherited fd %d: %q, %v", number, data, err)
		}
		t.Logf("inherited fd %d preserved", number)
	}
}
