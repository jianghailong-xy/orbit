package main

import (
	"bytes"
	"io/fs"
	"os"
	"os/user"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// `orbit register` on a set-up host puts the account's own copy at ~/.orbit/bin/orbit, as the
// account, before it asks the broker to enable the instance that runs it: a new file in
// ~/.orbit/bin, mode 0755, renamed over the old one, and nothing written outside the home.

// ownCopyHost is register's service step on a set-up host: a broker that records what the
// account's copy held when enable reached it, an account with a temporary home, and this binary
// standing at exe, outside that home.
type ownCopyHost struct {
	home, exe, unitDir string
	release            []byte
	// atEnable is what ~/.orbit/bin/orbit held when the broker was asked to enable; nil when it
	// was missing.
	atEnable [][]byte
	asked    []string
}

func newOwnCopyHost(t *testing.T) *ownCopyHost {
	t.Helper()
	h := &ownCopyHost{home: t.TempDir(), unitDir: t.TempDir(), release: []byte("#!/bin/sh\necho orbit 0.1.300\n")}
	h.exe = filepath.Join(t.TempDir(), "usr", "local", "bin", "orbit")
	if err := os.MkdirAll(filepath.Dir(h.exe), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(h.exe, h.release, 0o755); err != nil {
		t.Fatal(err)
	}
	account := &user.User{Uid: "4242", Gid: "4242", Username: "c2b", Name: "c2b", HomeDir: h.home}
	record := func(verb string) hostdVerb {
		return func(peer hostdPeer, _ hostdRequest) hostdResponse {
			h.asked = append(h.asked, verb)
			if verb == "enable" {
				b, err := os.ReadFile(userBinPath(h.home))
				if err != nil {
					b = nil
				}
				h.atEnable = append(h.atEnable, b)
			}
			return hostdOK(map[string]any{"uid": peer.UID, "unit": unitForAccount(account.Username)})
		}
	}
	path, stop := startHostd(t, map[string]hostdVerb{"enable": record("enable")})
	t.Cleanup(stop)

	prevSocket, prevDir, prevEUID, prevCurrent, prevExe := serviceBrokerSocket, serviceUnitDir, processEUID, currentUser, osExecutable
	t.Cleanup(func() {
		serviceBrokerSocket, serviceUnitDir, processEUID, currentUser, osExecutable = prevSocket, prevDir, prevEUID, prevCurrent, prevExe
	})
	serviceBrokerSocket, serviceUnitDir = path, h.unitDir
	processEUID = func() int { return 4242 }
	currentUser = func() (*user.User, error) { return account, nil }
	osExecutable = func() (string, error) { return h.exe, nil }
	t.Setenv("HOME", h.home)
	return h
}

// register's service step, as finishRegister calls it.
func (h *ownCopyHost) register(t *testing.T) string {
	t.Helper()
	commands := recordCommands(t)
	out := captureServiceOutput(t, func() {
		svc, err := setupService(filepath.Join(h.home, ".orbit"), nil)
		if err != nil || svc == nil || svc.unit != unitForAccount("c2b") {
			t.Errorf("setupService = %+v, %v; want the broker's instance", svc, err)
		}
	})
	if len(*commands) != 0 {
		t.Errorf("register shelled out to %v; the copy and the broker need no command", *commands)
	}
	return out
}

// tree lists every path under root, with its mode.
func tree(t *testing.T, root string) []string {
	t.Helper()
	var paths []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		paths = append(paths, rel+" "+info.Mode().String())
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return paths
}

func TestRegisterPutsTheAccountsOwnCopyInPlaceBeforeEnable(t *testing.T) {
	for _, tc := range []struct {
		name    string
		arrange func(t *testing.T, h *ownCopyHost)
	}{
		{"no ~/.orbit yet", func(*testing.T, *ownCopyHost) {}},
		{"an older copy there", func(t *testing.T, h *ownCopyHost) {
			bin := filepath.Dir(userBinPath(h.home))
			if err := os.MkdirAll(bin, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(filepath.Dir(bin), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(userBinPath(h.home), []byte("#!/bin/sh\necho orbit 0.1.243\n"), 0o755); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newOwnCopyHost(t)
			tc.arrange(t, h)
			before, _ := os.Stat(userBinPath(h.home))
			outside := tree(t, filepath.Dir(h.exe))

			out := h.register(t)

			if !slices.Equal(h.asked, []string{"enable"}) {
				t.Fatalf("the broker was asked %v, want [enable]", h.asked)
			}
			if !bytes.Equal(h.atEnable[0], h.release) {
				t.Errorf("when the broker was asked to enable, ~/.orbit/bin/orbit held %q, want this binary", h.atEnable[0])
			}
			after, err := os.Stat(userBinPath(h.home))
			if err != nil {
				t.Fatal(err)
			}
			if before != nil && os.SameFile(before, after) {
				t.Error("the older copy was written over in place rather than replaced by a new file renamed over it")
			}
			// ~/.orbit private (it holds the runner's credential), the copy 0755, and nothing else:
			// no temporary file left in ~/.orbit/bin.
			if got, want := tree(t, h.home), []string{
				". " + mustMode(t, h.home),
				".orbit drwx------",
				".orbit/bin drwxr-xr-x",
				".orbit/bin/orbit -rwxr-xr-x",
			}; !slices.Equal(got, want) {
				t.Errorf("the home holds\n  %v\nwant\n  %v", got, want)
			}
			// Nothing outside the home: the binary it ran from and the unit directory are as they were.
			if got := tree(t, filepath.Dir(h.exe)); !slices.Equal(got, outside) {
				t.Errorf("the directory register ran from changed: %v → %v", outside, got)
			}
			if got := tree(t, h.unitDir); len(got) != 1 {
				t.Errorf("register wrote into the unit directory: %v", got)
			}
			if want := "✓ Put this account's own copy of orbit at " + userBinPath(h.home); !strings.Contains(out, want) {
				t.Errorf("register output lacks %q:\n%s", want, out)
			}
		})
	}
}

func mustMode(t *testing.T, path string) string {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Mode().String()
}

// Registering from the account's own copy — ~/.orbit/bin/orbit itself, or through the
// ~/.local/bin/orbit launcher that links to it — has nothing to copy, and writes nothing.
func TestRegisterFromTheAccountsOwnCopyWritesNothing(t *testing.T) {
	h := newOwnCopyHost(t)
	own := userBinPath(h.home)
	if err := os.MkdirAll(filepath.Dir(own), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Dir(filepath.Dir(own)), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(own, h.release, 0o755); err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(h.home, ".local", "bin", "orbit")
	if err := os.MkdirAll(filepath.Dir(launcher), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(own, launcher); err != nil {
		t.Fatal(err)
	}
	osExecutable = func() (string, error) { return launcher, nil }
	before, _ := os.Stat(own)
	home := tree(t, h.home)

	out := h.register(t)

	after, _ := os.Stat(own)
	if !os.SameFile(before, after) || !slices.Equal(tree(t, h.home), home) {
		t.Error("register wrote into the home although it ran from the account's own copy")
	}
	if strings.Contains(out, "own copy") {
		t.Errorf("register reported a copy it did not make:\n%s", out)
	}
	if !slices.Equal(h.asked, []string{"enable"}) {
		t.Errorf("the broker was asked %v, want [enable]", h.asked)
	}
}

// Hosts that are not set up are unchanged: with no broker socket, register puts no copy anywhere.
// Nor does root, whose runner is no broker instance.
func TestRegisterPutsNoCopyWithoutABrokerOrAsRoot(t *testing.T) {
	for _, tc := range []struct {
		name string
		euid int
		sock func(h *ownCopyHost) string
	}{
		{"a host not set up", 4242, func(h *ownCopyHost) string { return filepath.Join(h.unitDir, "absent.sock") }},
		{"root", 0, func(h *ownCopyHost) string { return serviceBrokerSocket }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newOwnCopyHost(t)
			processEUID = func() int { return tc.euid }
			placeOwnCopyForBroker(tc.sock(h), h.exe)
			if got := tree(t, h.home); len(got) != 1 {
				t.Errorf("register wrote into the home: %v", got)
			}
		})
	}
}

// A copy that cannot be put in place is said, and the broker still has the last word: its
// refusal says what is missing and what to run.
func TestRegisterSaysWhenItCannotPutTheCopyInPlace(t *testing.T) {
	h := newOwnCopyHost(t)
	// A file where ~/.orbit belongs: no mode bit is in the way, so this holds as root too.
	if err := os.WriteFile(filepath.Join(h.home, ".orbit"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	out := h.register(t)
	if want := "note: could not put this account's own copy of orbit at " + userBinPath(h.home); !strings.Contains(out, want) {
		t.Errorf("register output lacks %q:\n%s", want, out)
	}
	if !slices.Equal(h.asked, []string{"enable"}) {
		t.Errorf("the broker was asked %v, want [enable]", h.asked)
	}
}
