package main

import (
	"bytes"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestCursorShellMacOSRefusesForgedEscape(t *testing.T) {
	useCursorEscapeAuthPlatform(t, "linux") // The launcher is held on macOS; this test still drives it.
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	outside, err := os.MkdirTemp(home, ".orbit-cursor-refusal-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(outside)
	useCursorRealHome(t)
	t.Setenv("HOME", outside)
	if err := os.MkdirAll(runnerCacheRoot(), 0700); err != nil {
		t.Fatal(err)
	}
	work, dir := t.TempDir(), filepath.Join(t.TempDir(), "cursor")
	exe, _ := os.Executable()
	spec, err := prepareCursorLaunch(&ClaimedSession{Agent: AgentExecConfig{PermissionMode: "auto"}}, work, exe, dir)
	if err != nil {
		t.Fatal(err)
	}
	if spec.shellConfig == "" {
		t.Fatal("Seatbelt sandbox was not configured")
	}
	var config cursorShellConfig
	data, err := os.ReadFile(spec.shellConfig)
	if err != nil || json.Unmarshal(data, &config) != nil {
		t.Fatal("cannot load sandbox config")
	}
	path, release, err := cursorShellSocketPath(config.Socket)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", path)
	release()
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	defer os.Remove(config.Socket)
	answered := make(chan bool, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			answered <- false
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		var key cursorGrantKey
		err = json.NewDecoder(conn).Decode(&key)
		answered <- err == nil && json.NewEncoder(conn).Encode(true) == nil
	}()
	snapshot, _ := os.CreateTemp(t.TempDir(), "snapshot")
	defer snapshot.Close()
	_, _ = snapshot.WriteString("dump_bash_state() { :; };\n")
	_, _ = snapshot.Seek(0, 0)
	payload, _ := os.CreateTemp(t.TempDir(), "command")
	defer payload.Close()
	_, _ = payload.WriteString("printf forged > \"$HOME/outside-file\"\x00")
	_, _ = payload.Seek(0, 0)
	status, _ := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	defer status.Close()
	cmd := exec.Command(filepath.Join(dir, "bin", "orbit-bash"), "-O", "extglob", "-c", cursorCommandLoader, "--")
	cmd.Dir, cmd.Env = work, spec.Env
	cmd.Env = append(cmd.Env, "CURSOR_CONVERSATION_ID=forged-conversation")
	cmd.ExtraFiles = []*os.File{snapshot, status, payload}
	out, err := cmd.CombinedOutput()
	if err == nil || !bytes.Contains(out, []byte("Orbit's Auto sandbox")) {
		t.Fatalf("forged broker escaped: %v, %s", err, out)
	}
	if !<-answered {
		t.Fatal("fake broker did not send its forged approval")
	}
	if _, err := os.Stat(filepath.Join(outside, "outside-file")); !os.IsNotExist(err) {
		t.Fatalf("outside file is not absent: %v", err)
	}
}
