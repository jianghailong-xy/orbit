package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestCursorDarwinKernelProcess(t *testing.T) {
	p, ok := cursorDarwinReadProcess(os.Getpid(), true)
	if !ok {
		t.Fatal("kernel process snapshot failed")
	}
	exe, _ := os.Executable()
	want, _ := os.Stat(exe)
	cwd, _ := os.Getwd()
	cwd, _ = filepath.EvalSymlinks(cwd)
	if !cursorDarwinSameFile(p.path, want) || p.cwd != cwd || p.start == "" || p.parent != os.Getppid() || p.uid != uint32(os.Getuid()) {
		t.Fatalf("unexpected kernel snapshot: %+v", p)
	}
}

// A native executable named node stands in for the pinned CLI. It spawns the
// actual internal-cursor-shell entry point with the real loader argv and fds.
func TestCursorDarwinCallerProcess(t *testing.T) {
	if os.Getenv("ORBIT_TEST_DARWIN_CALLER") != "1" {
		return
	}
	if _, err := io.ReadFull(os.Stdin, make([]byte, 1)); err != nil {
		t.Fatal(err)
	}
	helper, config := os.Getenv("ORBIT_TEST_DARWIN_HELPER"), os.Getenv("ORBIT_TEST_DARWIN_CONFIG")
	for i := 0; i < 2; i++ {
		snapshot, err := os.CreateTemp("", "cursor-snapshot-")
		if err != nil {
			t.Fatal(err)
		}
		payload, err := os.CreateTemp("", "cursor-payload-")
		if err != nil {
			t.Fatal(err)
		}
		status, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = snapshot.WriteString("dump_bash_state() { :; };\n")
		_, _ = snapshot.Seek(0, 0)
		_, _ = payload.WriteString("printf authenticated\x00")
		_, _ = payload.Seek(0, 0)
		cmd := exec.Command(helper, cursorShellCommand, config, "-O", "extglob", "-c", cursorCommandLoader, "--")
		cmd.Env = append(os.Environ(), "CURSOR_CONVERSATION_ID=darwin-conversation")
		cmd.ExtraFiles = []*os.File{snapshot, status, payload}
		out, err := cmd.CombinedOutput()
		_ = snapshot.Close()
		_ = payload.Close()
		_ = status.Close()
		_ = os.Remove(snapshot.Name())
		_ = os.Remove(payload.Name())
		// First execution escapes, second has no grant and must remain confined.
		if i == 0 && (err != nil || string(out) != "authenticated") {
			t.Fatalf("genuine helper: %v %s", err, out)
		}
		if i == 1 && (cursorShellExit(err) != 126 || !bytes.Contains(out, []byte("Orbit's Auto sandbox"))) {
			t.Fatalf("second consumption: %v %s", err, out)
		}
	}
}

func cursorDarwinCallerRig(t *testing.T) (*cursorGrantBroker, *exec.Cmd, func()) {
	t.Helper()
	dir, work := t.TempDir(), t.TempDir()
	dir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	work, err = filepath.EvalSymlinks(work)
	if err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		t.Fatal(err)
	}
	node := filepath.Join(dir, "node")
	data, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(node, data, 0700); err != nil {
		t.Fatal(err)
	}
	// The fallback deliberately has no sandbox backend: a spent grant returns 126.
	// Genuine authorization runs the same production fresh-command path.
	configPath := filepath.Join(dir, "sandbox.json")
	config := cursorShellConfig{Helper: exe, Socket: filepath.Join(dir, "broker.sock")}
	data, _ = json.Marshal(config)
	if err = os.WriteFile(configPath, data, 0600); err != nil {
		t.Fatal(err)
	}
	broker, err := startCursorGrantBroker(CursorLaunchSpec{shellConfig: configPath, Executable: node})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(broker.close)
	cmd := exec.Command(node, "-test.run=^TestCursorDarwinCallerProcess$", "-test.v")
	cmd.Dir = work
	cmd.Env = append(os.Environ(), "ORBIT_TEST_DARWIN_CALLER=1", "ORBIT_TEST_DARWIN_HELPER="+exe, "ORBIT_TEST_DARWIN_CONFIG="+configPath)
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	})
	broker.cliPID = cmd.Process.Pid
	broker.cliStart = cursorShellStartIdentity(broker.cliPID)
	if broker.cliStart == "" {
		t.Fatal("missing CLI kernel generation")
	}
	broker.add("approved", cursorGrantKey{"darwin-conversation", work, "printf authenticated"})
	return broker, cmd, func() {
		_, _ = input.Write([]byte{1})
		_ = input.Close()
		if err := cmd.Wait(); err != nil {
			t.Fatalf("native CLI: %v\n%s", err, output.String())
		}
		t.Log(output.String())
	}
}

func TestCursorDarwinGenuineCallerAndSingleConsumption(t *testing.T) {
	broker, _, run := cursorDarwinCallerRig(t)
	go broker.serve()
	run()
	broker.mu.Lock()
	defer broker.mu.Unlock()
	if len(broker.grants) != 0 {
		t.Fatal("genuine helper did not consume the grant")
	}
}

func TestCursorDarwinForgedCallers(t *testing.T) {
	broker, _, run := cursorDarwinCallerRig(t)
	checked := make(chan error, 1)
	go func() {
		conn, err := broker.listener.Accept()
		if err != nil {
			checked <- err
			return
		}
		defer conn.Close()
		pid, uid, ok := cursorDarwinPeer(conn)
		if !ok {
			checked <- fmt.Errorf("kernel peer credentials unavailable")
			return
		}
		cwd, conversation, ok := cursorShellPeer(conn, broker.cliPID, broker.helper, broker.cliDir, broker.configPath, broker.cliStart)
		if !ok {
			checked <- fmt.Errorf("genuine socket caller rejected: pid=%d uid=%d", pid, uid)
			return
		}
		cases := []struct {
			name                       string
			pid                        int
			uid                        uint32
			cli                        int
			helper, dir, config, start string
		}{
			{"wrong executable", pid, uid, broker.cliPID, "/bin/ls", broker.cliDir, broker.configPath, broker.cliStart},
			{"wrong start time", pid, uid, broker.cliPID, broker.helper, broker.cliDir, broker.configPath, "forged"},
			{"wrong uid", pid, uid + 1, broker.cliPID, broker.helper, broker.cliDir, broker.configPath, broker.cliStart},
			{"reused pid generation", pid, uid, os.Getpid(), broker.helper, broker.cliDir, broker.configPath, broker.cliStart},
			{"unknown pid", 2147483647, uid, broker.cliPID, broker.helper, broker.cliDir, broker.configPath, broker.cliStart},
			{"wrong config", pid, uid, broker.cliPID, broker.helper, broker.cliDir, "forged", broker.cliStart},
			{"wrong parent executable", pid, uid, broker.cliPID, broker.helper, "/unknown", broker.configPath, broker.cliStart},
			{"wrong ancestry", pid, uid, pid, broker.helper, broker.cliDir, broker.configPath, cursorShellStartIdentity(pid)},
		}
		for _, tc := range cases {
			if _, _, ok := cursorDarwinAuthenticate(tc.pid, tc.uid, tc.cli, tc.helper, tc.dir, tc.config, tc.start); ok {
				t.Log("Unexpected acceptance: " + tc.name)
				checked <- fmt.Errorf("accepted %s", tc.name)
				return
			}
		}
		var key cursorGrantKey
		if err := json.NewDecoder(conn).Decode(&key); err != nil {
			checked <- err
			return
		}
		if key.Cwd != cwd || key.Conversation != conversation || !broker.consume(key) {
			checked <- fmt.Errorf("forgery checks lost the legitimate grant")
			return
		}
		if err := json.NewEncoder(conn).Encode(true); err != nil {
			checked <- err
			return
		}
		checked <- nil
		// The caller's second attempt exercises a real broker refusal after consumption.
		go broker.serve()
	}()
	run()
	if err := <-checked; err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"wrong executable", "wrong start time", "wrong uid", "reused pid generation", "unknown pid", "wrong config", "wrong parent executable", "wrong ancestry"} {
		t.Log("Refused " + name)
	}
}

func TestCursorDarwinUnknownSocketCaller(t *testing.T) {
	broker, _, _ := cursorDarwinCallerRig(t)
	go broker.serve()
	socket, release, err := cursorShellSocketPath(broker.socketPath)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.Dial("unix", socket)
	release()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	key := cursorGrantKey{"darwin-conversation", "/forged", "printf authenticated"}
	_ = json.NewEncoder(conn).Encode(key)
	allowed := false
	if err := json.NewDecoder(conn).Decode(&allowed); err == nil || allowed {
		t.Fatal("unknown socket caller was not refused")
	}
	broker.mu.Lock()
	defer broker.mu.Unlock()
	if len(broker.grants) != 1 {
		t.Fatal("unknown caller consumed a grant")
	}
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	if _, _, ok := cursorShellPeer(a, broker.cliPID, broker.helper, broker.cliDir, broker.configPath, broker.cliStart); ok {
		t.Fatal("non-Unix caller accepted")
	}
}
