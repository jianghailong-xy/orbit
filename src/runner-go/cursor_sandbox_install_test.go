package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCursorSandboxInstallFallback(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("bubblewrap installation is Linux-only")
	}
	for _, success := range []bool{false, true} {
		name := "failure"
		if success {
			name = "success"
		}
		t.Run(name, func(t *testing.T) {
			bin := t.TempDir()
			t.Setenv("PATH", bin)
			var installer cursorSandboxInstaller
			var installed atomic.Bool
			var calls atomic.Int32
			release := make(chan struct{})
			detect := func(context.Context, *ClaimedSession, string) (*cursorSandbox, string) {
				if installed.Load() {
					return &cursorSandbox{platform: "linux"}, ""
				}
				return nil, "bwrap is missing"
			}
			install := func(ctx context.Context) error {
				calls.Add(1)
				if _, ok := ctx.Deadline(); !ok {
					return errors.New("installation has no timeout")
				}
				<-release
				if success {
					installed.Store(true)
					return nil
				}
				return errors.New("package manager permission denied")
			}
			// Even concurrent launches must return while the installer remains blocked.
			for launch := 0; launch < 2; launch++ {
				rig := newCursorBridgeRig("auto", nil)
				returned := make(chan struct{})
				go func() {
					rig.bridge.prepareSandbox(context.Background(), nil, &installer, detect, install)
					close(returned)
				}()
				select {
				case <-returned:
				case <-time.After(time.Second):
					close(release)
					t.Fatal("launch blocked on installer")
				}
				rig.bridge.begin("turn-1")
				rig.bridge.begin("turn-2")
				if rig.bridge.sandboxInForce || len(rig.notes) != 1 || !strings.Contains(rig.notes[0]["notice"].(string), "in progress") {
					t.Fatalf("state=%v notices=%v", rig.bridge.sandboxInForce, rig.notes)
				}
				if cursorAutoAllows("python3 - <<'PY'\nprint(1)\nPY", t.TempDir(), false) {
					t.Fatal("unsandboxed heredoc was allowed")
				}
			}
			close(release)
			select {
			case <-installer.done:
			case <-time.After(time.Second):
				t.Fatal("installer did not finish")
			}
			for launch := 0; launch < 2; launch++ {
				rig := newCursorBridgeRig("auto", nil)
				rig.bridge.prepareSandbox(context.Background(), nil, &installer, detect, install)
				rig.bridge.begin("turn-1")
				rig.bridge.begin("turn-2")
				if rig.bridge.sandboxInForce != success {
					t.Fatalf("sandbox in force = %v", rig.bridge.sandboxInForce)
				}
				if success {
					if len(rig.notes) != 0 {
						t.Fatalf("unexpected notices: %v", rig.notes)
					}
				} else {
					if len(rig.notes) != 1 {
						t.Fatalf("notices = %v", rig.notes)
					}
					notice, _ := rig.notes[0]["notice"].(string)
					for _, text := range []string{"Cursor Auto", "inline scripts", "bwrap is missing", "install failed", "permission denied"} {
						if !strings.Contains(notice, text) {
							t.Fatalf("notice %q missing %q", notice, text)
						}
					}
				}
			}
			if calls.Load() != 1 {
				t.Fatalf("install calls = %d", calls.Load())
			}

		})
	}
}

func TestCursorSandboxPresentButUnavailableDoesNotInstall(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux-only")
	}
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "bwrap"), []byte("#!/bin/sh\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	var installer cursorSandboxInstaller
	rig := newCursorBridgeRig("auto", nil)
	rig.bridge.prepareSandbox(context.Background(), nil, &installer,
		func(context.Context, *ClaimedSession, string) (*cursorSandbox, string) {
			return nil, "user namespaces disabled"
		},
		func(context.Context) error { t.Fatal("attempted install with bwrap present"); return nil })
	rig.bridge.begin("turn")
	if rig.bridge.sandboxInForce || len(rig.notes) != 1 || !strings.Contains(rig.notes[0]["notice"].(string), "user namespaces disabled") {
		t.Fatalf("state=%v notices=%v", rig.bridge.sandboxInForce, rig.notes)
	}
}

func TestCursorSandboxInstallFailureStillLaunchesSession(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux-only")
	}
	bin := t.TempDir()
	// Stub the package manager itself: no host package installation is performed.
	if err := os.WriteFile(filepath.Join(bin, "apt-get"), []byte("#!/bin/sh\necho 'test package installation denied' >&2\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	previous := runnerCursorSandboxInstaller
	runnerCursorSandboxInstaller = &cursorSandboxInstaller{}
	current := runnerCursorSandboxInstaller
	t.Cleanup(func() {
		if current.done != nil {
			<-current.done
		}
		runnerCursorSandboxInstaller = previous
	})
	first, then := cursorTurns(cursorMessage("turn-1", "first message"))
	run := runCursorSession(t, cursorRunOptions{recording: "background-shell-and-commit/background", agent: cursorInMode("auto"), first: first, then: then})
	if run.status != stSucceeded || !run.ended {
		t.Fatalf("session failed to launch: %s", run.status)
	}
	count := 0
	for _, event := range run.events {
		if event.payload["noticeKind"] == "cursor-sandbox-unavailable" {
			count++
			notice, _ := event.payload["notice"].(string)
			if !strings.Contains(notice, "bwrap") || (!strings.Contains(notice, "install failed") && !strings.Contains(notice, "in progress")) {
				t.Fatalf("notice = %q", notice)
			}
		}
	}
	if count != 1 {
		t.Fatalf("notices = %d", count)
	}
}

func TestCursorBubblewrapPackageManagers(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux-only")
	}
	for manager, want := range map[string]string{
		"apt-get": "install -y bubblewrap", "dnf": "install -y bubblewrap", "yum": "install -y bubblewrap",
		"apk": "add --no-cache bubblewrap", "pacman": "-S --noconfirm --needed bubblewrap",
	} {
		t.Run(manager, func(t *testing.T) {
			bin := t.TempDir()
			result := filepath.Join(bin, "arguments")
			t.Setenv("PATH", bin)
			t.Setenv("CURSOR_TEST_INSTALL_RESULT", result)
			script := "#!/bin/sh\nprintf '%s\\n%s' \"$DEBIAN_FRONTEND\" \"$*\" > \"$CURSOR_TEST_INSTALL_RESULT\"\n"
			if err := os.WriteFile(filepath.Join(bin, manager), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			if os.Geteuid() != 0 {
				// sudo must be non-interactive and must receive the resolved manager path.
				sudo := "#!/bin/sh\n[ \"$1\" = '-n' ] || exit 12\nshift\nexec \"$@\"\n"
				if err := os.WriteFile(filepath.Join(bin, "sudo"), []byte(sudo), 0700); err != nil {
					t.Fatal(err)
				}
			}
			if err := installCursorBubblewrap(context.Background()); err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(result)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != "noninteractive\n"+want {
				t.Fatalf("arguments/environment = %q", got)
			}
		})
	}
}
