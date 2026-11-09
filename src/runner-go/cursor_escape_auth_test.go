package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const cursorGateHeredoc = "python3 - <<'PY'\nprint(1)\nPY"

// useCursorEscapeAuthPlatform makes this runner's capability check read goos for the test. Helper processes
// the test starts read their real platform.
func useCursorEscapeAuthPlatform(t *testing.T, goos string) {
	t.Helper()
	previous := cursorEscapeAuthPlatform
	cursorEscapeAuthPlatform = goos
	t.Cleanup(func() { cursorEscapeAuthPlatform = previous })
}

func TestCursorEscapeAuthSupportedOnlyOnLinux(t *testing.T) {
	for goos, want := range map[string]bool{"linux": true, "darwin": false, "windows": false, "freebsd": false} {
		useCursorEscapeAuthPlatform(t, goos)
		if got := cursorEscapeAuthSupported(); got != want {
			t.Errorf("%s: supported = %v, want %v", goos, got, want)
		}
	}
}

// prepareGateBridge runs prepareSandbox with a backend that would sandbox, so only the gate can hold it.
func prepareGateBridge(t *testing.T, rig *cursorBridgeRig) (detected, installed *int) {
	t.Helper()
	detected, installed = new(int), new(int)
	var installer cursorSandboxInstaller
	rig.bridge.prepareSandbox(context.Background(), nil, &installer,
		func(context.Context, *ClaimedSession, string) (*cursorSandbox, string) {
			*detected++
			return &cursorSandbox{platform: "test"}, ""
		},
		func(context.Context) error {
			*installed++
			return nil
		})
	return detected, installed
}

// askGateCommand sends command through a turn's permission path, and answers with whatever the rig's card does.
func askGateCommand(t *testing.T, rig *cursorBridgeRig, command string) {
	t.Helper()
	if err := rig.mapper.begin("turn"); err != nil {
		t.Fatal(err)
	}
	rig.bridge.begin("turn")
	rawInput := map[string]interface{}{"command": command}
	title := "`" + command + "`"
	rig.mapper.update(map[string]interface{}{"sessionId": "s", "update": map[string]interface{}{
		"sessionUpdate": "tool_call", "toolCallId": "call", "kind": "execute", "title": title, "status": "pending", "rawInput": rawInput}})
	rig.bridge.permission(1, cursorPermissionParams(map[string]interface{}{
		"toolCallId": "call", "kind": "execute", "title": title, "status": "pending", "rawInput": rawInput}))
	rig.bridge.wait()
}

// The Mac runner's bridge: no sandbox in force whatever the backend says, the heredoc goes on a card, the
// approved command is answered, and the notice says why, once per process.
func TestCursorAutoOnMacOSHoldsTheSandbox(t *testing.T) {
	useCursorEscapeAuthPlatform(t, "darwin")
	rig := newCursorBridgeRig("auto", nil)
	detected, installed := prepareGateBridge(t, rig)
	if rig.bridge.sandboxInForce || rig.bridge.sandbox != nil {
		t.Fatalf("sandbox in force = %v, sandbox = %v", rig.bridge.sandboxInForce, rig.bridge.sandbox)
	}
	if *detected != 0 || *installed != 0 {
		t.Fatalf("held sandbox probed the backend: detected %d, installed %d", *detected, *installed)
	}
	askGateCommand(t, rig, cursorGateHeredoc)
	rig.bridge.begin("turn-2")
	if len(rig.cards) != 1 {
		t.Fatalf("heredoc cards = %v, want one", rig.cards)
	}
	if answers := fmt.Sprint(rig.answers[rpcIDKey(1)]); !strings.Contains(answers, cursorAllowOnce) {
		t.Fatalf("approved heredoc answered %s, want %s", answers, cursorAllowOnce)
	}
	if len(rig.notes) != 1 {
		t.Fatalf("notices = %v, want one per process", rig.notes)
	}
	want := "Cursor Auto asks about inline scripts on macOS because commands you approve cannot leave the command sandbox here yet."
	if rig.notes[0]["notice"] != want || rig.notes[0]["noticeKind"] != "cursor-sandbox-unavailable" {
		t.Fatalf("notice = %v", rig.notes[0])
	}
}

// The Mac runner's launch: the wrapper any other mode gets, no launcher config for a grant broker to start
// from, and a command that writes outside the workspace as it always did.
func TestCursorAutoOnMacOSLaunchesTheOldShell(t *testing.T) {
	useCursorEscapeAuthPlatform(t, "darwin")
	realHome, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	useCursorRealHome(t)
	outside, err := os.MkdirTemp(realHome, ".orbit-cursor-gate-test-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(outside)
	t.Setenv("HOME", outside)
	// Everything the launcher needs is here, so only the gate keeps it away.
	if err := os.MkdirAll(runnerCacheRoot(), 0700); err != nil {
		t.Fatal(err)
	}
	work := t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	launch := func(mode string) (CursorLaunchSpec, string) {
		dir := filepath.Join(t.TempDir(), "cursor")
		spec, err := prepareCursorLaunch(&ClaimedSession{Agent: AgentExecConfig{PermissionMode: mode}}, work, exe, dir)
		if err != nil {
			t.Fatal(err)
		}
		return spec, dir
	}
	auto, dir := launch("auto")
	_, otherDir := launch("acceptEdits")
	if auto.shellConfig != "" {
		t.Fatalf("sandbox launcher configured: %s", auto.shellConfig)
	}
	if _, err := os.Stat(filepath.Join(dir, "bin", "sandbox.json")); !os.IsNotExist(err) {
		t.Fatalf("sandbox.json is not absent: %v", err)
	}
	shell, err := os.ReadFile(filepath.Join(dir, "bin", "orbit-bash"))
	if err != nil {
		t.Fatal(err)
	}
	other, err := os.ReadFile(filepath.Join(otherDir, "bin", "orbit-bash"))
	if err != nil {
		t.Fatal(err)
	}
	if string(shell) != string(other) {
		t.Fatalf("Auto's orbit-bash differs from the unsandboxed wrapper:\n%s\n---\n%s", shell, other)
	}
	cmd := exec.Command(filepath.Join(dir, "bin", "orbit-bash"), "-c", `printf approved > "$HOME/outside-file"`)
	cmd.Dir, cmd.Env = work, auto.Env
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("command failed: %v: %s", err, out)
	}
	if data, err := os.ReadFile(filepath.Join(outside, "outside-file")); err != nil || string(data) != "approved" {
		t.Fatalf("outside write = %q, %v", data, err)
	}
}

// Linux is what it was: the backend's sandbox is in force, Auto may run a sandboxed heredoc unasked, and
// nothing needs explaining.
func TestCursorAutoOnLinuxKeepsTheSandbox(t *testing.T) {
	useCursorEscapeAuthPlatform(t, "linux")
	rig := newCursorBridgeRig("auto", nil)
	detected, _ := prepareGateBridge(t, rig)
	if *detected != 1 || !rig.bridge.sandboxInForce || rig.bridge.sandbox == nil {
		t.Fatalf("detected %d, in force = %v, sandbox = %v", *detected, rig.bridge.sandboxInForce, rig.bridge.sandbox)
	}
	askGateCommand(t, rig, cursorGateHeredoc)
	if len(rig.cards) != 0 {
		t.Fatalf("sandboxed heredoc carded: %v", rig.cards)
	}
	for _, note := range rig.notes {
		if note["noticeKind"] == "cursor-sandbox-unavailable" {
			t.Fatalf("sandbox notice in force: %v", note)
		}
	}
}

// A Linux runner whose backend is missing still says the old sentence, reason included.
func TestCursorAutoOnLinuxExplainsAnUnavailableSandbox(t *testing.T) {
	useCursorEscapeAuthPlatform(t, "linux")
	rig := newCursorBridgeRig("auto", nil)
	var installer cursorSandboxInstaller
	rig.bridge.prepareSandbox(context.Background(), nil, &installer,
		func(context.Context, *ClaimedSession, string) (*cursorSandbox, string) { return nil, "no backend" },
		func(context.Context) error { return nil })
	rig.bridge.begin("turn")
	if len(rig.notes) != 1 || !strings.HasPrefix(rig.notes[0]["notice"].(string),
		"Cursor Auto asks for approval for inline scripts because the command sandbox is unavailable: no backend") {
		t.Fatalf("notices = %v", rig.notes)
	}
}

// With the capability, a Linux Auto launch goes through the sandbox launcher.
func TestCursorAutoOnLinuxLaunchesTheSandboxShell(t *testing.T) {
	useCursorEscapeAuthPlatform(t, "linux")
	useCursorRealHome(t)
	if err := os.MkdirAll(runnerCacheRoot(), 0700); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "cursor")
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if sandbox, reason := detectCursorSandbox(context.Background(), nil, t.TempDir()); sandbox == nil {
		t.Skip("OS sandbox unavailable: " + reason)
	}
	spec, err := prepareCursorLaunch(&ClaimedSession{Agent: AgentExecConfig{PermissionMode: "auto"}}, t.TempDir(), exe, dir)
	if err != nil {
		t.Fatal(err)
	}
	if spec.shellConfig == "" {
		t.Fatal("sandbox launcher was not configured")
	}
	shell, err := os.ReadFile(filepath.Join(dir, "bin", "orbit-bash"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(shell), cursorShellCommand) {
		t.Fatalf("orbit-bash does not go through the launcher:\n%s", shell)
	}
}
