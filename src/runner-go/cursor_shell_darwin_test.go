package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestCursorShellMacOSRefusesUnknownHelper(t *testing.T) {
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
	broker, err := startCursorGrantBroker(spec)
	if err != nil {
		t.Fatal(err)
	}
	defer broker.close()
	broker.cliPID = os.Getpid()
	broker.cliStart = cursorShellStartIdentity(os.Getpid())
	go broker.serve()
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
		t.Fatalf("unknown helper escaped: %v, %s", err, out)
	}
	if _, err := os.Stat(filepath.Join(outside, "outside-file")); !os.IsNotExist(err) {
		t.Fatalf("outside file is not absent: %v", err)
	}
}
