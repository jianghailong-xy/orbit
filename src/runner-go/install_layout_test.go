package main

import (
	"bytes"
	"errors"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

// legacyInstall is the pre-layout install under a temporary root: the real binary in a
// stand-in for root's /usr/local/bin, an account's home with nothing in it yet, and a
// directory for systemd units.
type legacyInstall struct {
	exe     string // <root>/usr/local/bin/orbit, a regular file
	home    string // <root>/home/alice
	unitDir string // <root>/etc/systemd/system
	alice   *user.User
}

const legacyBinary = "#!/bin/sh\necho legacy\n"

// aliceIDs are the uid and gid alice gets: the test's own, so the chowns a root migration
// performs succeed without root — unless the test runs as root, where she must not be root
// herself and any uid can be handed out.
func aliceIDs() (int, int) {
	if os.Getuid() == 0 {
		return 65534, 65534
	}
	return os.Getuid(), os.Getgid()
}

// newLegacyInstall lays the install out and makes its /usr/local/bin read as root's. alice
// is the account its runner service runs as.
func newLegacyInstall(t *testing.T) legacyInstall {
	t.Helper()
	root := t.TempDir()
	l := legacyInstall{
		exe:     filepath.Join(root, "usr", "local", "bin", "orbit"),
		home:    filepath.Join(root, "home", "alice"),
		unitDir: filepath.Join(root, "etc", "systemd", "system"),
	}
	for _, dir := range []string{filepath.Dir(l.exe), l.home, l.unitDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(l.exe, []byte(legacyBinary), 0o755); err != nil {
		t.Fatal(err)
	}
	uid, gid := aliceIDs()
	l.alice = &user.User{Username: "alice", Uid: strconv.Itoa(uid), Gid: strconv.Itoa(gid), HomeDir: l.home}

	rootDir := filepath.Dir(l.exe)
	prevOwned, prevLookup := rootOwnedDir, lookupUser
	rootOwnedDir = func(dir string) bool { return dir == rootDir }
	lookupUser = func(name string) (*user.User, error) {
		switch name {
		case "alice":
			return l.alice, nil
		case "root":
			return &user.User{Username: "root", Uid: "0", Gid: "0", HomeDir: "/root"}, nil
		}
		return nil, user.UnknownUserError(name)
	}
	t.Cleanup(func() { rootOwnedDir, lookupUser = prevOwned, prevLookup })
	return l
}

// writeUnit installs a runner unit, rendered the way `orbit register` renders it.
func (l legacyInstall) writeUnit(t *testing.T, name, username, program string) string {
	t.Helper()
	path := filepath.Join(l.unitDir, name)
	unit := renderSystemdUnit(username, username, program, l.home, filepath.Join(l.home, ".orbit"),
		"/usr/local/bin:/usr/bin:/bin", []envVar{{"https_proxy", "http://proxy:3128"}})
	if err := os.WriteFile(path, []byte(unit), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// assertLegacyUntouched checks the binary is still the regular file it was and that no
// ~/.orbit/bin copy was made.
func (l legacyInstall) assertLegacyUntouched(t *testing.T) {
	t.Helper()
	fi, err := os.Lstat(l.exe)
	if err != nil || !fi.Mode().IsRegular() {
		t.Fatalf("%s is no longer the regular file it was (%v, %v)", l.exe, fi, err)
	}
	if _, err := os.Lstat(userBinPath(l.home)); !os.IsNotExist(err) {
		t.Fatalf("a copy was left at %s (%v)", userBinPath(l.home), err)
	}
}

// assertMoved checks the install now has the user layout: the binary in ~/.orbit/bin with the
// old contents, and the old path a symlink to it.
func (l legacyInstall) assertMoved(t *testing.T, want string) {
	t.Helper()
	to := userBinPath(l.home)
	if got, err := os.Readlink(l.exe); err != nil || got != to {
		t.Fatalf("%s links to %q (%v), want %q", l.exe, got, err, to)
	}
	fi, err := os.Lstat(to)
	if err != nil || !fi.Mode().IsRegular() || fi.Mode().Perm()&0o100 == 0 {
		t.Fatalf("%s is not an executable regular file (%v, %v)", to, fi, err)
	}
	if b, _ := os.ReadFile(to); string(b) != want {
		t.Fatalf("%s holds %q, want %q", to, b, want)
	}
	for _, dir := range []string{filepath.Dir(l.exe), filepath.Dir(to)} {
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			if strings.Contains(e.Name(), ".new-") || strings.Contains(e.Name(), ".link-") {
				t.Fatalf("temporary file %s left behind in %s", e.Name(), dir)
			}
		}
	}
}

// assertAlicesBin checks, when a root move could hand them over, that ~/.orbit, ~/.orbit/bin
// and the binary belong to alice.
func (l legacyInstall) assertAlicesBin(t *testing.T) {
	t.Helper()
	if os.Geteuid() != 0 {
		return
	}
	uid, gid := aliceIDs()
	to := userBinPath(l.home)
	for _, path := range []string{filepath.Dir(filepath.Dir(to)), filepath.Dir(to), to} {
		fi, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		if st := fi.Sys().(*syscall.Stat_t); int(st.Uid) != uid || int(st.Gid) != gid {
			t.Fatalf("%s belongs to %d:%d, want alice's %d:%d", path, st.Uid, st.Gid, uid, gid)
		}
	}
}

// recordInstallCommands swaps in command runners that execute nothing and remember every
// command, failing with err when it is set.
func recordInstallCommands(t *testing.T, err error) *[]string {
	t.Helper()
	var seen []string
	prevRun, prevQuiet := run, runQuiet
	run = func(name string, args ...string) error {
		seen = append(seen, strings.TrimSpace(name+" "+strings.Join(args, " ")))
		return err
	}
	runQuiet = func(name string, args ...string) {
		seen = append(seen, strings.TrimSpace(name+" "+strings.Join(args, " ")))
	}
	t.Cleanup(func() { run, runQuiet = prevRun, prevQuiet })
	return &seen
}

func assertCommands(t *testing.T, got []string, want ...string) {
	t.Helper()
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("commands run:\n  %s\nwant:\n  %s", strings.Join(got, "\n  "), strings.Join(want, "\n  "))
	}
}

// userInstall is install.sh's layout under a temporary root: the real binary in the account's
// ~/.orbit/bin and /usr/local/bin/orbit a symlink to it, with this process "running" from the
// symlink as a runner started through it does.
func userInstall(t *testing.T, binary string) (link, real string) {
	t.Helper()
	root := t.TempDir()
	real = userBinPath(filepath.Join(root, "home", "alice"))
	link = filepath.Join(root, "usr", "local", "bin", "orbit")
	for _, dir := range []string{filepath.Dir(real), filepath.Dir(link)} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(real, []byte(binary), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	prev := osExecutable
	osExecutable = func() (string, error) { return link, nil }
	t.Cleanup(func() { osExecutable = prev })
	// A temporary directory may itself sit behind a symlink (macOS's /var).
	resolved, err := filepath.EvalSymlinks(real)
	if err != nil {
		t.Fatal(err)
	}
	return link, resolved
}

func TestUserBinPathIsUnderTheAccountsOrbitHome(t *testing.T) {
	for home, want := range map[string]string{
		"/home/alice":  "/home/alice/.orbit/bin/orbit",
		"/Users/alice": "/Users/alice/.orbit/bin/orbit",
		"/home/bob/":   "/home/bob/.orbit/bin/orbit",
	} {
		if got := userBinPath(home); got != want {
			t.Errorf("userBinPath(%q) = %q, want %q", home, got, want)
		}
	}
}

// A runner started through /usr/local/bin/orbit must resolve to the copy in ~/.orbit/bin:
// that is the file a self-update replaces, and the directory whose writability decides
// whether it can.
func TestUserBinResolvedThroughTheSymlink(t *testing.T) {
	_, real := userInstall(t, legacyBinary)

	exe, err := resolvedExecutable()
	if err != nil || exe != real {
		t.Fatalf("resolvedExecutable() = %q, %v; want %q", exe, err, real)
	}
	dir, ok := selfUpdateInstallable()
	if dir != filepath.Dir(real) || !ok {
		t.Fatalf("selfUpdateInstallable() = %q, %v; want %q, true", dir, ok, filepath.Dir(real))
	}
}

func TestUserBinSystemdUnitRunsTheResolvedPath(t *testing.T) {
	link, real := userInstall(t, legacyBinary)
	exe, err := resolvedExecutable()
	if err != nil {
		t.Fatal(err)
	}

	unit := renderSystemdUnit("alice", "alice", exe, "/home/alice", "/home/alice/.orbit", "/usr/bin:/bin", nil)
	if !strings.Contains(unit, "\nExecStart="+real+" run\n") {
		t.Fatalf("unit does not run %s:\n%s", real, unit)
	}
	if strings.Contains(unit, link) {
		t.Fatalf("unit names the symlink %s rather than the file behind it:\n%s", link, unit)
	}
	if strings.Contains(unit, "ORBIT_NO_SELFUPDATE") {
		t.Fatalf("unit pins the runner against self-updates:\n%s", unit)
	}
	if !strings.Contains(unit, "\nUser=alice\n") {
		t.Fatalf("unit does not run as alice:\n%s", unit)
	}
}

func TestUserBinLaunchdPlistRunsTheResolvedPath(t *testing.T) {
	link, real := userInstall(t, legacyBinary)
	exe, err := resolvedExecutable()
	if err != nil {
		t.Fatal(err)
	}

	plist := renderLaunchdPlist(exe, "/Users/alice/.orbit", launchdLabel, "/Users/alice", "/usr/bin:/bin",
		"/Users/alice/.orbit/runner.log", []envVar{{"https_proxy", "http://proxy:3128"}})
	if got := plistProgram(plist); got != real {
		t.Fatalf("ProgramArguments runs %q, want %q:\n%s", got, real, plist)
	}
	if strings.Contains(plist, link) {
		t.Fatalf("plist names the symlink %s rather than the file behind it:\n%s", link, plist)
	}
	if strings.Contains(plist, "ORBIT_NO_SELFUPDATE") {
		t.Fatalf("LaunchAgent pins the runner against self-updates:\n%s", plist)
	}
}

func TestUserBinMoveLeavesASymlinkWhereTheBinaryWas(t *testing.T) {
	l := newLegacyInstall(t)
	calls := recordInstallCommands(t, nil)
	uid, gid := aliceIDs()

	to, err := moveToUserBin(l.exe, l.home, uid, gid, true, "")
	if err != nil || to != userBinPath(l.home) {
		t.Fatalf("moveToUserBin = %q, %v; want %q", to, err, userBinPath(l.home))
	}
	l.assertMoved(t, legacyBinary)
	l.assertAlicesBin(t)
	// ~/.orbit holds the runner's credential: created private, as saveConfig keeps it.
	if fi, err := os.Stat(filepath.Join(l.home, ".orbit")); err != nil || fi.Mode().Perm() != machineHomePerm {
		t.Fatalf("~/.orbit = %v, %v; want mode %v", fi, err, machineHomePerm)
	}
	// As root everything happens in-process: nothing to shell out to.
	assertCommands(t, *calls)

	// Moving again is a no-op: the binary already is the account's.
	if again, err := moveToUserBin(l.exe, l.home, uid, gid, true, ""); err != nil || again != to {
		t.Fatalf("second moveToUserBin = %q, %v; want %q", again, err, to)
	}
	l.assertMoved(t, legacyBinary)
}

// Without root the copy is the user's own business; only the symlink in root's directory goes
// through sudo — the one prompt the move costs.
func TestUserBinMoveLinksThroughSudoWhenNotRoot(t *testing.T) {
	l := newLegacyInstall(t)
	calls := recordInstallCommands(t, nil)
	uid, gid := aliceIDs()

	to, err := moveToUserBin(l.exe, l.home, uid, gid, false, "/usr/bin/sudo")
	if err != nil {
		t.Fatal(err)
	}
	assertCommands(t, *calls, "/usr/bin/sudo ln -sf "+to+" "+l.exe)
	if b, _ := os.ReadFile(to); string(b) != legacyBinary {
		t.Fatalf("%s holds %q, want the binary's copy", to, b)
	}
}

// A symlink that cannot be made must not leave the install half-moved: the old binary keeps
// working and no stray copy waits in ~/.orbit/bin.
func TestUserBinMoveKeepsTheOldInstallWhenItCannotLink(t *testing.T) {
	t.Run("sudo fails", func(t *testing.T) {
		l := newLegacyInstall(t)
		recordInstallCommands(t, errors.New("sudo: a password is required"))
		uid, gid := aliceIDs()
		if _, err := moveToUserBin(l.exe, l.home, uid, gid, false, "/usr/bin/sudo"); err == nil {
			t.Fatal("moveToUserBin succeeded although the symlink failed")
		}
		l.assertLegacyUntouched(t)
	})
	t.Run("no sudo", func(t *testing.T) {
		l := newLegacyInstall(t)
		calls := recordInstallCommands(t, nil)
		uid, gid := aliceIDs()
		if _, err := moveToUserBin(l.exe, l.home, uid, gid, false, ""); err == nil {
			t.Fatal("moveToUserBin succeeded with no way to get root")
		}
		l.assertLegacyUntouched(t)
		assertCommands(t, *calls)
	})
}

func TestUserBinFindsTheSystemdServicesRunningABinary(t *testing.T) {
	l := newLegacyInstall(t)
	other := filepath.Join(filepath.Dir(l.home), "bob", ".orbit", "bin", "orbit")
	if err := os.MkdirAll(filepath.Dir(other), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(other, []byte(legacyBinary), 0o755); err != nil {
		t.Fatal(err)
	}
	via := filepath.Join(t.TempDir(), "orbit")
	if err := os.Symlink(l.exe, via); err != nil {
		t.Fatal(err)
	}
	alice := l.writeUnit(t, "orbit-runner-alice.service", "alice", l.exe)
	l.writeUnit(t, "orbit-runner-bob.service", "bob", other)
	legacy := l.writeUnit(t, "orbit-runner.service", "carol", via)
	hostd := filepath.Join(l.unitDir, "orbit-hostd.service")
	if err := os.WriteFile(hostd, []byte(hostdServiceUnitFile(l.exe)), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(l.unitDir, "unrelated.service"), []byte("[Service]\nExecStart="+l.exe+" run\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := map[string]serviceDef{}
	for _, d := range systemdServicesRunning(l.unitDir, l.exe) {
		got[d.path] = d
	}
	want := map[string]serviceDef{
		alice:  {path: alice, user: "alice", program: l.exe},
		legacy: {path: legacy, user: "carol", program: via},
		hostd:  {path: hostd, user: "root", program: l.exe},
	}
	if len(got) != len(want) {
		t.Fatalf("systemdServicesRunning = %+v, want %+v", got, want)
	}
	for path, w := range want {
		if got[path] != w {
			t.Errorf("%s: got %+v, want %+v", path, got[path], w)
		}
	}
}

// `sudo orbit upgrade` on a legacy Linux install: the binary moves into the service account's
// ~/.orbit/bin, the unit is rewritten to run it — byte for byte the unit register would now
// write — and the service restarts only once the caller says the release is in place.
func TestUserBinUpgradeMigratesALegacySystemdService(t *testing.T) {
	l := newLegacyInstall(t)
	calls := recordInstallCommands(t, nil)
	unitPath := l.writeUnit(t, "orbit-runner-alice.service", "alice", l.exe)

	restart := migrateServices(l.exe, systemdServicesRunning(l.unitDir, l.exe))
	if restart == nil {
		t.Fatal("migrateServices moved nothing")
	}
	l.assertMoved(t, legacyBinary)
	l.assertAlicesBin(t)
	to := userBinPath(l.home)
	got, _ := os.ReadFile(unitPath)
	want := renderSystemdUnit("alice", "alice", to, l.home, filepath.Join(l.home, ".orbit"),
		"/usr/local/bin:/usr/bin:/bin", []envVar{{"https_proxy", "http://proxy:3128"}})
	if string(got) != want {
		t.Fatalf("rewritten unit:\n%s\nwant:\n%s", got, want)
	}
	assertCommands(t, *calls)

	restart()
	assertCommands(t, *calls, "systemctl daemon-reload", "systemctl restart orbit-runner-alice.service")
}

// The same on macOS, where the service is the account's LaunchAgent: rewritten in place and
// reloaded into that account's own GUI domain, not root's.
func TestUserBinUpgradeMigratesALegacyLaunchAgent(t *testing.T) {
	l := newLegacyInstall(t)
	calls := recordInstallCommands(t, nil)
	t.Setenv("SUDO_USER", "alice")
	plistPath := launchAgentPath(l.home)
	render := func(exe string) string {
		return renderLaunchdPlist(exe, filepath.Join(l.home, ".orbit"), launchdLabel, l.home,
			"/usr/local/bin:/usr/bin:/bin", filepath.Join(l.home, ".orbit", "runner.log"), nil)
	}
	if err := os.MkdirAll(filepath.Dir(plistPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(plistPath, []byte(render(l.exe)), 0o644); err != nil {
		t.Fatal(err)
	}

	defs := launchdServicesRunning(l.exe)
	if len(defs) != 1 || defs[0].path != plistPath || defs[0].user != "alice" || !defs[0].launchd {
		t.Fatalf("launchdServicesRunning = %+v, want alice's LaunchAgent", defs)
	}
	restart := migrateServices(l.exe, defs)
	if restart == nil {
		t.Fatal("migrateServices moved nothing")
	}
	l.assertMoved(t, legacyBinary)
	l.assertAlicesBin(t)
	if got, _ := os.ReadFile(plistPath); string(got) != render(userBinPath(l.home)) {
		t.Fatalf("rewritten plist:\n%s\nwant:\n%s", got, render(userBinPath(l.home)))
	}
	assertCommands(t, *calls)

	restart()
	domain := "gui/" + l.alice.Uid
	assertCommands(t, *calls, "launchctl bootout "+domain+" "+plistPath, "launchctl bootstrap "+domain+" "+plistPath)
}

// A runner that runs as root can replace its binary where it is, so its install stays as it is.
func TestUserBinUpgradeLeavesARootServiceAlone(t *testing.T) {
	l := newLegacyInstall(t)
	calls := recordInstallCommands(t, nil)
	unitPath := l.writeUnit(t, "orbit-runner-root.service", "root", l.exe)
	before, _ := os.ReadFile(unitPath)

	if restart := migrateServices(l.exe, systemdServicesRunning(l.unitDir, l.exe)); restart != nil {
		t.Fatal("migrateServices moved a root service's binary")
	}
	l.assertLegacyUntouched(t)
	if after, _ := os.ReadFile(unitPath); string(after) != string(before) {
		t.Fatalf("root's unit was rewritten:\n%s", after)
	}
	assertCommands(t, *calls)
}

// A binary that more than one account's service runs — several users' runners, or a host set
// up with `orbit host setup` — stays put: moving it into one home would take it from the rest.
func TestUserBinUpgradeLeavesASharedBinaryAlone(t *testing.T) {
	t.Run("two users", func(t *testing.T) {
		l := newLegacyInstall(t)
		calls := recordInstallCommands(t, nil)
		l.writeUnit(t, "orbit-runner-alice.service", "alice", l.exe)
		l.writeUnit(t, "orbit-runner-bob.service", "bob", l.exe)
		if restart := migrateServices(l.exe, systemdServicesRunning(l.unitDir, l.exe)); restart != nil {
			t.Fatal("migrateServices moved a binary two accounts share")
		}
		l.assertLegacyUntouched(t)
		assertCommands(t, *calls)
	})
	t.Run("host broker", func(t *testing.T) {
		l := newLegacyInstall(t)
		for path, content := range map[string]string{
			"orbit-runner@.service": hostRunnerTemplate(l.exe),
			"orbit-hostd.service":   hostdServiceUnitFile(l.exe),
		} {
			if err := os.WriteFile(filepath.Join(l.unitDir, path), []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		if restart := migrateServices(l.exe, systemdServicesRunning(l.unitDir, l.exe)); restart != nil {
			t.Fatal("migrateServices moved the binary the host broker runs as root")
		}
		l.assertLegacyUntouched(t)
	})
}

// Only a binary in a directory only root can write is moved: one the runner can already
// replace is left where it is, services and all.
func TestUserBinUpgradeLeavesAWritableInstallAlone(t *testing.T) {
	l := newLegacyInstall(t)
	rootOwnedDir = func(string) bool { return false }
	l.writeUnit(t, "orbit-runner-alice.service", "alice", l.exe)
	if restart := migrateLegacyInstall(l.exe); restart != nil {
		t.Fatal("migrateLegacyInstall moved a binary its runner can already replace")
	}
	l.assertLegacyUntouched(t)
}

// `orbit register` on a legacy install installs the service on the moved copy.
func TestUserBinRegisterMovesARootOwnedInstall(t *testing.T) {
	t.Run("as root", func(t *testing.T) {
		l := newLegacyInstall(t)
		recordInstallCommands(t, nil)
		l.writeUnit(t, "orbit-runner-alice.service", "alice", l.exe)
		got := adoptUserBin(l.exe, l.alice, systemdServicesRunning(l.unitDir, l.exe), true, "")
		if got != userBinPath(l.home) {
			t.Fatalf("adoptUserBin = %q, want %q", got, userBinPath(l.home))
		}
		l.assertMoved(t, legacyBinary)
		l.assertAlicesBin(t)
	})
	t.Run("through sudo", func(t *testing.T) {
		l := newLegacyInstall(t)
		calls := recordInstallCommands(t, nil)
		got := adoptUserBin(l.exe, l.alice, nil, false, "sudo")
		if got != userBinPath(l.home) {
			t.Fatalf("adoptUserBin = %q, want %q", got, userBinPath(l.home))
		}
		assertCommands(t, *calls, "sudo ln -sf "+got+" "+l.exe)
	})
}

func TestUserBinRegisterKeepsAnInstallItMustNotMove(t *testing.T) {
	t.Run("already writable", func(t *testing.T) {
		l := newLegacyInstall(t)
		rootOwnedDir = func(string) bool { return false }
		if got := adoptUserBin(l.exe, l.alice, nil, true, ""); got != l.exe {
			t.Fatalf("adoptUserBin = %q, want %q", got, l.exe)
		}
		l.assertLegacyUntouched(t)
	})
	t.Run("root service", func(t *testing.T) {
		l := newLegacyInstall(t)
		rootUser, _ := lookupUser("root")
		if got := adoptUserBin(l.exe, rootUser, nil, true, ""); got != l.exe {
			t.Fatalf("adoptUserBin = %q, want %q", got, l.exe)
		}
		l.assertLegacyUntouched(t)
	})
	t.Run("shared with another account", func(t *testing.T) {
		l := newLegacyInstall(t)
		l.writeUnit(t, "orbit-runner-bob.service", "bob", l.exe)
		if got := adoptUserBin(l.exe, l.alice, systemdServicesRunning(l.unitDir, l.exe), true, ""); got != l.exe {
			t.Fatalf("adoptUserBin = %q, want %q", got, l.exe)
		}
		l.assertLegacyUntouched(t)
	})
	t.Run("no way to root", func(t *testing.T) {
		l := newLegacyInstall(t)
		if got := adoptUserBin(l.exe, l.alice, nil, false, ""); got != l.exe {
			t.Fatalf("adoptUserBin = %q, want %q", got, l.exe)
		}
		l.assertLegacyUntouched(t)
	})
}

// A self-update of an install.sh install replaces the file in ~/.orbit/bin, leaving the
// /usr/local/bin/orbit symlink pointing at it. As root (`sudo orbit upgrade`) the new file
// stays the account's.
func TestUserBinSelfUpdateReplacesTheCopyInOrbitBin(t *testing.T) {
	if platformKey() == "" {
		t.Skip("self-update is unsupported on this test platform")
	}
	link, real := userInstall(t, legacyBinary)
	if os.Geteuid() == 0 {
		// Stand in for the account: hand ~/.orbit/bin to a uid that is not root's.
		if err := os.Chown(filepath.Dir(real), 65534, 65534); err != nil {
			t.Fatal(err)
		}
	}
	binary, gz := fakeRelease(t, sha256TestRelease, "user-bin")
	manifest := sha256TestManifest(publishedAssets(gz))
	srv := serveRelease(t, manifest, gz)

	var log strings.Builder
	if !downloadAndSwap(srv.URL, platformKey(), manifest, func(s string) { log.WriteString(s) }) {
		t.Fatalf("downloadAndSwap failed: %s", log.String())
	}
	if got, _ := os.ReadFile(real); !bytes.Equal(got, binary) {
		t.Fatalf("%s was not replaced by the release", real)
	}
	if fi, err := os.Lstat(link); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("%s is no longer a symlink (%v, %v)", link, fi, err)
	}
	if got, err := filepath.EvalSymlinks(link); err != nil || got != real {
		t.Fatalf("%s resolves to %q (%v), want %q", link, got, err, real)
	}
	if os.Geteuid() == 0 {
		fi, err := os.Stat(real)
		if err != nil {
			t.Fatal(err)
		}
		if st := fi.Sys().(*syscall.Stat_t); st.Uid != 65534 {
			t.Fatalf("%s belongs to uid %d after a root swap, want the directory's owner 65534", real, st.Uid)
		}
	}
}
