package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func newCursorGrantLedger() *cursorGrantBroker {
	return &cursorGrantBroker{grants: map[string]cursorGrant{}, seen: map[string]bool{}}
}

func TestCursorGrantsExactCountAndLifecycle(t *testing.T) {
	b := newCursorGrantLedger()
	key := cursorGrantKey{"conversation", "/workspace", "printf 'exact\n'"}
	b.add("one", key)
	b.add("one", key)
	for _, wrong := range []cursorGrantKey{{"other", key.Cwd, key.Command}, {key.Conversation, "/other", key.Command}, {key.Conversation, key.Cwd, key.Command + " "}} {
		if b.consume(wrong) {
			t.Fatal("inexact key consumed a grant")
		}
	}
	var count atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if b.consume(key) {
				count.Add(1)
			}
		}()
	}
	wg.Wait()
	if count.Load() != 1 {
		t.Fatalf("one approval allowed %d executions", count.Load())
	}
	b.add("two", key)
	b.add("three", key)
	if !b.consume(key) || !b.consume(key) || b.consume(key) {
		t.Fatal("independent approvals miscounted")
	}
	b.add("expired", key)
	g := b.grants["expired"]
	g.expires = time.Now().Add(-time.Second)
	b.grants["expired"] = g
	if b.consume(key) {
		t.Fatal("expired grant consumed")
	}
	b.add("cancelled", key)
	b.revoke()
	if b.consume(key) {
		t.Fatal("revoked grant consumed")
	}
	b.add("cancelled", key)
	if b.consume(key) {
		t.Fatal("duplicate response reissued revoked grant")
	}
	b.closed = true
	b.add("closed", key)
	if b.consume(key) {
		t.Fatal("closed generation allowed escape")
	}
}

func TestCursorGrantOwnerApprovalBeforeReply(t *testing.T) {
	for _, tc := range []struct {
		name                               string
		person, standing, classifier, want bool
	}{
		{name: "unmarked response"},
		{name: "person", person: true, want: true},
		{name: "standing rule", standing: true, want: true},
		{name: "classifier auto allow", classifier: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newCursorBridgeRig("auto", func(context.Context, string, interface{}, string) (*ApprovalDecisionResponse, error) {
				decision := &ApprovalDecisionResponse{ID: "one-card", Status: "ALLOWED"}
				if tc.person {
					decision.DecidedByID = "owner"
				}
				decision.StandingGrant = tc.standing
				if tc.classifier {
					t.Error("classifier allow reached the approval card")
				}
				return decision, nil
			})
			command := "python3 -c 'print(1)'"
			if tc.classifier {
				command = "pwd"
			}
			if err := rig.mapper.begin("turn"); err != nil {
				t.Fatal(err)
			}
			rig.bridge.begin("turn")
			b := newCursorGrantLedger()
			rig.bridge.grants = b
			original := rig.bridge.reply
			observed := false
			rig.bridge.reply = func(id interface{}, result map[string]interface{}) {
				observed = b.consume(cursorGrantKey{"conversation", rig.bridge.workspace, command})
				original(id, result)
			}
			params := cursorPermissionParams(map[string]interface{}{"toolCallId": "shell", "title": "`" + command + "`", "kind": "execute"})
			params["sessionId"] = "conversation"
			rig.bridge.permission(1, params)
			rig.bridge.wait()
			if observed != tc.want {
				t.Fatalf("grant before reply = %v; want = %v", observed, tc.want)
			}
			if b.consume(cursorGrantKey{"conversation", rig.bridge.workspace, command}) {
				t.Fatal("one approval created more than one grant")
			}
			observed = false
			rig.bridge.permission(2, params)
			rig.bridge.wait()
			if observed {
				t.Fatal("the same answered card created a second grant on a new RPC id")
			}
		})
	}
}

func TestCursorFreshShell(t *testing.T) {
	if os.Getenv("ORBIT_TEST_FRESH_SHELL") == "1" {
		cwd, _ := os.Getwd()
		os.Exit(runCursorFreshCommand(os.Getenv("ORBIT_TEST_FRESH_COMMAND"), cwd))
	}
	work := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside-file")
	marker := filepath.Join(work, "poisoned")
	snapshot := []byte("printf() { touch " + shellQuote(marker) + "; builtin printf \"$@\"; }; alias touch='false'; export SNAPSHOT_ONLY=poison; cd /;\n")
	in, err := os.CreateTemp(t.TempDir(), "snapshot")
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	_, _ = in.Write(snapshot)
	_, _ = in.Seek(0, 0)
	status, err := os.CreateTemp(t.TempDir(), "status")
	if err != nil {
		t.Fatal(err)
	}
	defer status.Close()
	self, _ := os.Executable()
	command := "printf approved; test -z \"${SNAPSHOT_ONLY:-}\"; printf '%s' \"$PWD\"; printf outside > " + shellQuote(outside) + "; exit 7"
	cmd := exec.Command(self, "-test.run=^TestCursorFreshShell$")
	cmd.Dir = work
	cmd.Env = append(os.Environ(), "ORBIT_TEST_FRESH_SHELL=1", "ORBIT_TEST_FRESH_COMMAND="+command, "BASH_ENV="+filepath.Join(work, "startup"))
	_ = os.WriteFile(filepath.Join(work, "startup"), []byte("touch "+shellQuote(marker)), 0600)
	cmd.ExtraFiles = []*os.File{in, status}
	out, err := cmd.CombinedOutput()
	if cursorShellExit(err) != 7 {
		t.Fatalf("exit: %v, output %s", err, out)
	}
	if !strings.Contains(string(out), "approved"+work) {
		t.Fatalf("unexpected stdout %q", out)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("snapshot or startup function executed")
	}
	if data, _ := os.ReadFile(outside); string(data) != "outside" {
		t.Fatal("approved outside write failed")
	}
	_, _ = status.Seek(0, 0)
	data, _ := os.ReadFile(status.Name())
	if !bytes.Contains(data, snapshot) || !bytes.HasPrefix(data, []byte("__CURSOR_BASH_STATE_START__\n"+work+"\n")) {
		t.Fatalf("snapshot/status not relayed: %s", data)
	}
}

func TestCursorShellSandboxAndUnknownCaller(t *testing.T) {
	realHome, _ := os.UserHomeDir()
	useCursorRealHome(t)
	outside, err := os.MkdirTemp(realHome, ".orbit-cursor-shell-test-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(outside)
	t.Setenv("HOME", outside)
	_ = os.MkdirAll(runnerCacheRoot(), 0700)
	work := t.TempDir()
	dir := filepath.Join(t.TempDir(), "cursor")
	job := &ClaimedSession{Agent: AgentExecConfig{PermissionMode: "auto"}}
	exe, _ := os.Executable()
	spec, err := prepareCursorLaunch(job, work, exe, dir)
	if err != nil {
		t.Fatal(err)
	}
	if spec.shellConfig == "" {
		t.Skip("OS sandbox unavailable")
	}
	broker, err := startCursorGrantBroker(spec)
	if err != nil {
		t.Fatal(err)
	}
	defer broker.close()
	broker.cliPID = os.Getpid()
	broker.cliStart = cursorShellStartIdentity(os.Getpid())
	go broker.serve()
	key := cursorGrantKey{"conversation", work, "printf approved"}
	broker.add("one", key)
	var config cursorShellConfig
	data, _ := os.ReadFile(spec.shellConfig)
	_ = json.Unmarshal(data, &config)
	conn, err := net.Dial("unix", config.Socket)
	if err != nil {
		t.Fatal(err)
	}
	_ = json.NewEncoder(conn).Encode(key)
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	allowed := false
	_ = json.NewDecoder(conn).Decode(&allowed)
	_ = conn.Close()
	if allowed || !broker.consume(key) {
		t.Fatal("same-UID arbitrary caller stole grant")
	}
	// No matching grant: the real helper must execute through the OS sandbox.
	shell := filepath.Join(dir, "bin", "orbit-bash")
	cmd := exec.Command(shell, "-c", "printf blocked > \"$HOME/outside-file\"")
	cmd.Dir = work
	cmd.Env = spec.Env
	out, err := cmd.CombinedOutput()
	if err == nil || !bytes.Contains(out, []byte("Orbit's Auto sandbox")) {
		t.Fatalf("outside write = %v, %s", err, out)
	}
	if _, err := os.Stat(filepath.Join(userHome(), "outside-file")); !os.IsNotExist(err) {
		t.Fatalf("outside file exists: %v", err)
	}
	for _, payload := range [][]byte{[]byte("printf '%s\\n' \"$SNAPSHOT_MARK\"\x00"), []byte("printf wrong\x00extra\x00"), {'p', 'r', 'i', 'n', 't', 'f', ' ', 0xff, 0}} {
		snapshot, err := os.CreateTemp(t.TempDir(), "snapshot")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = snapshot.WriteString("SNAPSHOT_MARK='snapshot replay preserved'; dump_bash_state() { :; };\n")
		_, _ = snapshot.Seek(0, 0)
		command, err := os.CreateTemp(t.TempDir(), "command")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = command.Write(payload)
		_, _ = command.Seek(0, 0)
		status, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(shell, "-O", "extglob", "-c", cursorCommandLoader, "--")
		cmd.Dir = work
		cmd.Env = spec.Env
		cmd.ExtraFiles = []*os.File{snapshot, status, command}
		out, err := cmd.CombinedOutput()
		_ = snapshot.Close()
		_ = status.Close()
		_ = command.Close()
		if bytes.Equal(payload, []byte("printf '%s\\n' \"$SNAPSHOT_MARK\"\x00")) {
			if err != nil || string(out) != "snapshot replay preserved\n" {
				t.Fatalf("fd-5 replay lost bytes/state: %v %q", err, out)
			}
		} else if cursorShellExit(err) != 126 {
			t.Fatalf("invalid payload ran: %v %q", err, out)
		}
	}
}
