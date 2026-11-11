package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
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
	prevOwned, prevLookup, prevShared := rootOwnedDir, lookupUser, sharedBinaryPath
	t.Cleanup(func() { sharedBinaryPath = prevShared })
	sharedBinaryPath = l.exe
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

// assertCopied checks the install now has the user layout: the account's own copy in
// ~/.orbit/bin holding want, and the binary in root's directory still the regular file it was —
// no symlink into the account's home.
func (l legacyInstall) assertCopied(t *testing.T, want string) {
	t.Helper()
	to := userBinPath(l.home)
	fi, err := os.Lstat(l.exe)
	if err != nil || !fi.Mode().IsRegular() {
		t.Fatalf("%s is no longer a regular file (%v, %v)", l.exe, fi, err)
	}
	if sameFile(l.exe, to) {
		t.Fatalf("%s and %s are one file", l.exe, to)
	}
	fi, err = os.Lstat(to)
	if err != nil || !fi.Mode().IsRegular() || fi.Mode().Perm()&0o100 == 0 {
		t.Fatalf("%s is not an executable regular file (%v, %v)", to, fi, err)
	}
	if b, _ := os.ReadFile(to); string(b) != want {
		t.Fatalf("%s holds %q, want %q", to, b, want)
	}
	assertNoTemporaries(t, filepath.Dir(l.exe), filepath.Dir(to))
}

func assertNoTemporaries(t *testing.T, dirs ...string) {
	t.Helper()
	for _, dir := range dirs {
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
	prevRun, prevQuiet, prevCapture := run, runQuiet, runCapture
	run = func(name string, args ...string) error {
		seen = append(seen, strings.TrimSpace(name+" "+strings.Join(args, " ")))
		return err
	}
	runQuiet = func(name string, args ...string) {
		seen = append(seen, strings.TrimSpace(name+" "+strings.Join(args, " ")))
	}
	runCapture = func(name string, args ...string) (string, error) {
		seen = append(seen, strings.TrimSpace(name+" "+strings.Join(args, " ")))
		return "", err
	}
	t.Cleanup(func() { run, runQuiet, runCapture = prevRun, prevQuiet, prevCapture })
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
		"/Users/alice/.orbit/runner.log", false, []envVar{{"https_proxy", "http://proxy:3128"}})
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

func TestUserBinCopyLeavesTheBinaryWhereItWas(t *testing.T) {
	l := newLegacyInstall(t)
	calls := recordInstallCommands(t, nil)
	uid, gid := aliceIDs()

	to, err := copyToUserBin(l.exe, l.home, uid, gid, true)
	if err != nil || to != userBinPath(l.home) {
		t.Fatalf("copyToUserBin = %q, %v; want %q", to, err, userBinPath(l.home))
	}
	l.assertCopied(t, legacyBinary)
	l.assertAlicesBin(t)
	// ~/.orbit holds the runner's credential: created private, as saveConfig keeps it.
	if fi, err := os.Stat(filepath.Join(l.home, ".orbit")); err != nil || fi.Mode().Perm() != machineHomePerm {
		t.Fatalf("~/.orbit = %v, %v; want mode %v", fi, err, machineHomePerm)
	}
	assertCommands(t, *calls)

	// Copying again replaces the copy with the same bytes, and still leaves the binary alone.
	if again, err := copyToUserBin(l.exe, l.home, uid, gid, true); err != nil || again != to {
		t.Fatalf("second copyToUserBin = %q, %v; want %q", again, err, to)
	}
	l.assertCopied(t, legacyBinary)
}

// The account copies into its own home: nothing goes through sudo.
func TestUserBinCopyNeedsNoRoot(t *testing.T) {
	l := newLegacyInstall(t)
	calls := recordInstallCommands(t, nil)
	uid, gid := aliceIDs()

	if _, err := copyToUserBin(l.exe, l.home, uid, gid, false); err != nil {
		t.Fatal(err)
	}
	assertCommands(t, *calls)
	l.assertCopied(t, legacyBinary)
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

// `sudo /usr/local/bin/orbit upgrade` on a legacy Linux install: once the release is in place, the
// account gets its own copy of it, the unit is rewritten to run that copy — byte for byte the unit
// register would now write — and the service restarts. /usr/local/bin/orbit stays root's file.
func TestUserBinUpgradeMigratesALegacySystemdService(t *testing.T) {
	l := newLegacyInstall(t)
	calls := recordInstallCommands(t, nil)
	unitPath := l.writeUnit(t, "orbit-runner-alice.service", "alice", l.exe)

	restart := migrateServices(l.exe, systemdServicesRunning(l.unitDir, l.exe))
	if restart == nil {
		t.Fatal("migrateServices has nothing to do")
	}
	// Nothing happens before the release is in place.
	l.assertLegacyUntouched(t)
	assertCommands(t, *calls)
	const release = "#!/bin/sh\necho release\n"
	if err := os.WriteFile(l.exe, []byte(release), 0o755); err != nil {
		t.Fatal(err)
	}

	restart()
	l.assertCopied(t, release)
	l.assertAlicesBin(t)
	to := userBinPath(l.home)
	got, _ := os.ReadFile(unitPath)
	want := renderSystemdUnit("alice", "alice", to, l.home, filepath.Join(l.home, ".orbit"),
		"/usr/local/bin:/usr/bin:/bin", []envVar{{"https_proxy", "http://proxy:3128"}})
	if string(got) != want {
		t.Fatalf("rewritten unit:\n%s\nwant:\n%s", got, want)
	}
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
			"/usr/local/bin:/usr/bin:/bin", filepath.Join(l.home, ".orbit", "runner.log"), false, nil)
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
		t.Fatal("migrateServices has nothing to do")
	}
	restart()
	l.assertCopied(t, legacyBinary)
	l.assertAlicesBin(t)
	if got, _ := os.ReadFile(plistPath); string(got) != render(userBinPath(l.home)) {
		t.Fatalf("rewritten plist:\n%s\nwant:\n%s", got, render(userBinPath(l.home)))
	}
	domain := "gui/" + l.alice.Uid
	assertCommands(t, *calls,
		"launchctl bootout "+domain+"/"+launchdLabel,
		"launchctl enable "+domain+"/"+launchdLabel,
		"launchctl bootstrap "+domain+" "+plistPath,
	)
}

// Root restarts the agent with no shell of the account's to ask where it belongs: its plist says, so
// a Background agent comes back in its own domain.
func TestUserBinUpgradeRestartsABackgroundAgentInItsOwnDomain(t *testing.T) {
	home := t.TempDir()
	plistPath := launchAgentPath(home)
	if err := os.MkdirAll(filepath.Dir(plistPath), 0o755); err != nil {
		t.Fatal(err)
	}
	plist := renderLaunchdPlist("/o/bin/orbit", "/o", launchdLabel, home, "/usr/bin", "/o/runner.log", true, nil)
	if err := os.WriteFile(plistPath, []byte(plist), 0o644); err != nil {
		t.Fatal(err)
	}
	calls := recordInstallCommands(t, nil)

	restartServices([]serviceDef{{path: plistPath, user: "austin", launchd: true}}, "502")

	assertCommands(t, *calls,
		"launchctl bootout user/502/"+launchdLabel,
		"launchctl enable user/502/"+launchdLabel,
		"launchctl bootstrap user/502 "+plistPath,
	)
}

// A runner that runs as root can replace its binary where it is, so its install stays as it is.
func TestUserBinUpgradeLeavesARootServiceAlone(t *testing.T) {
	l := newLegacyInstall(t)
	calls := recordInstallCommands(t, nil)
	unitPath := l.writeUnit(t, "orbit-runner-root.service", "root", l.exe)
	before, _ := os.ReadFile(unitPath)

	if restart := migrateServices(l.exe, systemdServicesRunning(l.unitDir, l.exe)); restart != nil {
		t.Fatal("migrateServices would copy a root service's binary")
	}
	l.assertLegacyUntouched(t)
	if after, _ := os.ReadFile(unitPath); string(after) != string(before) {
		t.Fatalf("root's unit was rewritten:\n%s", after)
	}
	assertCommands(t, *calls)
}

// A binary that several accounts' services run stays where it is, and each of them gets a copy of
// its own: a copy takes the binary from nobody.
func TestUserBinUpgradeGivesEachAccountItsOwnCopy(t *testing.T) {
	l := newLegacyInstall(t)
	calls := recordInstallCommands(t, nil)
	bobHome := filepath.Join(filepath.Dir(l.home), "bob")
	if err := os.MkdirAll(bobHome, 0o755); err != nil {
		t.Fatal(err)
	}
	uid, gid := aliceIDs()
	bob := &user.User{Username: "bob", Uid: strconv.Itoa(uid), Gid: strconv.Itoa(gid), HomeDir: bobHome}
	prev := lookupUser
	lookupUser = func(name string) (*user.User, error) {
		if name == "bob" {
			return bob, nil
		}
		return prev(name)
	}
	aliceUnit := l.writeUnit(t, "orbit-runner-alice.service", "alice", l.exe)
	bobUnit := l.writeUnit(t, "orbit-runner-bob.service", "bob", l.exe)

	restart := migrateServices(l.exe, systemdServicesRunning(l.unitDir, l.exe))
	if restart == nil {
		t.Fatal("migrateServices has nothing to do")
	}
	restart()
	l.assertCopied(t, legacyBinary)
	if b, _ := os.ReadFile(userBinPath(bobHome)); string(b) != legacyBinary {
		t.Fatalf("bob's copy holds %q", b)
	}
	for unit, home := range map[string]string{aliceUnit: l.home, bobUnit: bobHome} {
		if b, _ := os.ReadFile(unit); !strings.Contains(string(b), "\nExecStart="+userBinPath(home)+" run\n") {
			t.Fatalf("%s does not run %s:\n%s", unit, userBinPath(home), b)
		}
	}
	assertCommands(t, *calls,
		"systemctl daemon-reload", "systemctl restart orbit-runner-alice.service",
		"systemctl daemon-reload", "systemctl restart orbit-runner-bob.service")
}

// The host broker runs the binary as root, alone on a host set up now, beside every account's
// instance on one set up before instances ran each account's own copy: none of them is an
// ordinary account's service, so nothing is copied.
func TestUserBinUpgradeLeavesTheHostBrokersBinaryAlone(t *testing.T) {
	for name, template := range map[string]func(string) string{
		"host broker":                  func(string) string { return hostRunnerTemplate() },
		"host broker and uid template": uidHostRunnerTemplate,
	} {
		t.Run(name, func(t *testing.T) {
			l := newLegacyInstall(t)
			for path, content := range map[string]string{
				"orbit-runner@.service": template(l.exe),
				"orbit-hostd.service":   hostdServiceUnitFile(l.exe),
			} {
				if err := os.WriteFile(filepath.Join(l.unitDir, path), []byte(content), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if restart := migrateServices(l.exe, systemdServicesRunning(l.unitDir, l.exe)); restart != nil {
				t.Fatal("migrateServices would copy the binary the host broker runs as root")
			}
			l.assertLegacyUntouched(t)
		})
	}
}

// Only a binary in a directory only root can write is copied: one the runner can already
// replace is left where it is, services and all, and the release goes there.
func TestUserBinUpgradeLeavesAWritableInstallAlone(t *testing.T) {
	l := newLegacyInstall(t)
	rootOwnedDir = func(string) bool { return false }
	l.writeUnit(t, "orbit-runner-alice.service", "alice", l.exe)
	target, restart := migrateLegacyInstall(l.exe)
	if target != l.exe || restart != nil {
		t.Fatalf("migrateLegacyInstall = %q, %v; want %q and nothing to do afterwards", target, restart != nil, l.exe)
	}
	l.assertLegacyUntouched(t)
}

// `orbit register` on a legacy install installs the service on the account's own copy.
func TestUserBinRegisterCopiesARootOwnedInstall(t *testing.T) {
	for name, root := range map[string]bool{"as root": true, "as the account": false} {
		t.Run(name, func(t *testing.T) {
			l := newLegacyInstall(t)
			calls := recordInstallCommands(t, nil)
			got := adoptUserBin(l.exe, l.alice, root, "sudo")
			if got != userBinPath(l.home) {
				t.Fatalf("adoptUserBin = %q, want %q", got, userBinPath(l.home))
			}
			l.assertCopied(t, legacyBinary)
			if root {
				l.assertAlicesBin(t)
			}
			assertCommands(t, *calls)
		})
	}
}

func TestUserBinRegisterKeepsAnInstallItNeedNotCopy(t *testing.T) {
	t.Run("already writable", func(t *testing.T) {
		l := newLegacyInstall(t)
		rootOwnedDir = func(string) bool { return false }
		if got := adoptUserBin(l.exe, l.alice, true, ""); got != l.exe {
			t.Fatalf("adoptUserBin = %q, want %q", got, l.exe)
		}
		l.assertLegacyUntouched(t)
	})
	t.Run("root service", func(t *testing.T) {
		l := newLegacyInstall(t)
		rootUser, _ := lookupUser("root")
		if got := adoptUserBin(l.exe, rootUser, true, ""); got != l.exe {
			t.Fatalf("adoptUserBin = %q, want %q", got, l.exe)
		}
		l.assertLegacyUntouched(t)
	})
}

// A copy that fails leaves the service on the binary where it is, and says what moves it later:
// that binary by its path, since sudo looks a bare `orbit` up only on its secure_path.
func TestUserBinRegisterThatCannotCopyNamesTheBinarysPath(t *testing.T) {
	l := newLegacyInstall(t)
	recordInstallCommands(t, nil)
	// A home that is a file: nothing can be created below it.
	blocked := filepath.Join(t.TempDir(), "home-file")
	if err := os.WriteFile(blocked, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	l.alice.HomeDir = blocked
	stderr := captureStderr(t)
	if got := adoptUserBin(l.exe, l.alice, false, "sudo"); got != l.exe {
		t.Fatalf("adoptUserBin = %q, want %q", got, l.exe)
	}
	if want := "the runner cannot update itself until `sudo " + l.exe + " upgrade` does.\n"; !strings.Contains(stderr(), want) {
		t.Errorf("stderr %q does not say %q", stderr(), want)
	}
}

// A self-update of an install.sh install replaces the file in ~/.orbit/bin, leaving the
// /usr/local/bin/orbit symlink pointing at it. As root (`sudo ~/.orbit/bin/orbit upgrade`) the new file
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

// linkedInstall is the layout earlier releases of register and `sudo orbit upgrade` left: alice's
// own copy in ~/.orbit/bin, which she and any agent she runs can replace, and a stand-in for root's
// /usr/local/bin/orbit that is a symlink to it. This process "runs" from the link, as `sudo orbit …`
// did. Files under alice's home stand for files an account can change, everything else for root's.
type linkedInstall struct {
	link  string // <root>/usr/local/bin/orbit, the symlink
	copy  string // <root>/home/alice/.orbit/bin/orbit, alice's file, symlinks resolved
	alice *user.User
}

const alicesCopy = "#!/bin/sh\necho alices-copy\n"

func newLinkedInstall(t *testing.T) linkedInstall {
	t.Helper()
	root := t.TempDir()
	home := filepath.Join(root, "home", "alice")
	l := linkedInstall{link: filepath.Join(root, "usr", "local", "bin", "orbit"), copy: userBinPath(home)}
	for _, dir := range []string{filepath.Dir(l.link), filepath.Dir(l.copy)} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(l.copy, []byte(alicesCopy), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(l.copy, l.link); err != nil {
		t.Fatal(err)
	}
	resolved, err := filepath.EvalSymlinks(l.copy)
	if err != nil {
		t.Fatal(err)
	}
	l.copy = resolved
	resolvedHome := filepath.Dir(filepath.Dir(filepath.Dir(resolved)))
	uid, gid := aliceIDs()
	l.alice = &user.User{Username: "alice", Uid: strconv.Itoa(uid), Gid: strconv.Itoa(gid), HomeDir: home}

	binDir := filepath.Dir(l.link)
	prevShared, prevOwned, prevAlone, prevOwner, prevExe := sharedBinaryPath, rootOwnedDir, rootsAlone, machineOwner, osExecutable
	t.Cleanup(func() {
		sharedBinaryPath, rootOwnedDir, rootsAlone, machineOwner, osExecutable = prevShared, prevOwned, prevAlone, prevOwner, prevExe
	})
	sharedBinaryPath = l.link
	rootOwnedDir = func(dir string) bool { return dir == binDir }
	rootsAlone = func(path string) bool { return !strings.HasPrefix(path, resolvedHome+string(filepath.Separator)) }
	// Only root can hand a file to root; a test that is not root checks everything else.
	machineOwner = func() (int, int) {
		if os.Geteuid() == 0 {
			return 0, 0
		}
		return os.Getuid(), os.Getgid()
	}
	osExecutable = func() (string, error) { return l.link, nil }
	return l
}

// assertRootsOwn checks the path root runs is its own regular file now: no symlink, resolving to
// itself, mode 0755, owned by machineOwner (root, when the test is root), not alice's file — and
// that alice replacing her copy afterwards changes nothing a later `sudo orbit …` executes.
func (l linkedInstall) assertRootsOwn(t *testing.T, want string) {
	t.Helper()
	fi, err := os.Lstat(l.link)
	if err != nil || !fi.Mode().IsRegular() {
		t.Fatalf("%s is not a regular file (%v, %v)", l.link, fi, err)
	}
	if fi.Mode().Perm() != 0o755 {
		t.Fatalf("%s has mode %04o, want 0755", l.link, fi.Mode().Perm())
	}
	uid, gid := machineOwner()
	if st := fi.Sys().(*syscall.Stat_t); int(st.Uid) != uid || int(st.Gid) != gid {
		t.Fatalf("%s belongs to %d:%d, want %d:%d", l.link, st.Uid, st.Gid, uid, gid)
	}
	if got, err := filepath.EvalSymlinks(l.link); err != nil || got != mustEval(t, l.link) || !rootsAlone(got) {
		t.Fatalf("%s resolves to %q (%v), a file alice can change", l.link, got, err)
	}
	if sameFile(l.link, l.copy) {
		t.Fatalf("%s is still alice's %s", l.link, l.copy)
	}
	if b, _ := os.ReadFile(l.link); string(b) != want {
		t.Fatalf("%s holds %q, want %q", l.link, b, want)
	}
	assertNoTemporaries(t, filepath.Dir(l.link))

	// What `sudo orbit` would execute, after alice swaps her own copy for something else.
	if err := os.WriteFile(l.copy+".evil", []byte("#!/bin/sh\necho alice-replaced-it\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(l.copy+".evil", l.copy); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(l.link); string(b) != want {
		t.Fatalf("alice replacing her copy changed %s to %q", l.link, b)
	}
	if out, err := exec.Command(l.link).Output(); err == nil && strings.Contains(string(out), "alice-replaced-it") {
		t.Fatalf("executing %s ran alice's replacement: %q", l.link, out)
	}
}

func mustEval(t *testing.T, path string) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, filepath.Base(path))
}

// realSudo runs each command it is given the way sudo would, minus sudo, with the real install,
// mv and rm: a test that is not root gives the file its own uid in place of root's. failOn names
// commands that fail instead.
func realSudo(t *testing.T, failOn ...string) *[]string {
	t.Helper()
	var seen []string
	prevRun := run
	run = func(name string, args ...string) error {
		seen = append(seen, strings.TrimSpace(name+" "+strings.Join(args, " ")))
		if name == "sudo" && len(args) > 0 {
			name, args = args[0], args[1:]
		}
		for _, f := range failOn {
			if name == f {
				return errors.New("exit status 1")
			}
		}
		return exec.Command(name, args...).Run()
	}
	t.Cleanup(func() { run = prevRun })
	return &seen
}

// `sudo orbit register` after an earlier register linked /usr/local/bin/orbit to alice's copy: the
// hand-off runs register as alice, which puts root's own copy back through sudo — install into a
// temporary name beside the link, then mv over it, so the path is never missing or half-written —
// and installs the service on alice's copy as before. Registering again changes nothing.
func TestMachineLinkRegisterThroughSudoPutsRootsCopyBack(t *testing.T) {
	l := newLinkedInstall(t)
	calls := realSudo(t)
	exe, err := resolvedExecutable()
	if err != nil || exe != l.copy {
		t.Fatalf("resolvedExecutable = %q, %v; want %q", exe, err, l.copy)
	}

	if got := adoptUserBin(exe, l.alice, false, "sudo"); got != l.copy {
		t.Fatalf("adoptUserBin = %q, want alice's copy %q", got, l.copy)
	}
	uid, gid := machineOwner()
	tmp := fmt.Sprintf("%s.new-%d", l.link, os.Getpid())
	assertCommands(t, *calls,
		fmt.Sprintf("sudo install -o %d -g %d -m 0755 %s %s", uid, gid, l.copy, tmp),
		"sudo mv -f "+tmp+" "+l.link)
	l.assertRootsOwn(t, alicesCopy)

	*calls = nil
	before, _ := os.Lstat(l.link)
	if got := adoptUserBin(l.copy, l.alice, false, "sudo"); got != l.copy {
		t.Fatalf("second adoptUserBin = %q, want %q", got, l.copy)
	}
	assertCommands(t, *calls)
	if after, _ := os.Lstat(l.link); !os.SameFile(before, after) {
		t.Fatalf("a second register replaced %s again", l.link)
	}
}

// As root (macOS's register when sudo hands nothing off, or root registering for an account) the
// same copy is made in-process: a temporary file beside the link, given root and 0755, renamed over it.
func TestMachineLinkRegisterAsRootPutsRootsCopyBack(t *testing.T) {
	l := newLinkedInstall(t)
	calls := recordInstallCommands(t, nil)

	if got := adoptUserBin(l.copy, l.alice, true, ""); got != l.copy {
		t.Fatalf("adoptUserBin = %q, want %q", got, l.copy)
	}
	assertCommands(t, *calls)
	l.assertRootsOwn(t, alicesCopy)
	if replaced, err := repairMachineLink(true, ""); replaced || err != nil {
		t.Fatalf("second repairMachineLink = %v, %v; want nothing to do", replaced, err)
	}
}

// A repair that fails part way leaves the link as it was and no temporary file in root's
// directory; register goes on with the service and says how to finish by hand.
func TestMachineLinkRepairThatFailsLeavesTheLink(t *testing.T) {
	for _, failing := range []string{"install", "mv"} {
		t.Run(failing, func(t *testing.T) {
			l := newLinkedInstall(t)
			realSudo(t, failing)
			stderr := captureStderr(t)
			if got := adoptUserBin(l.copy, l.alice, false, "sudo"); got != l.copy {
				t.Fatalf("adoptUserBin = %q, want %q", got, l.copy)
			}
			if dest, err := os.Readlink(l.link); err != nil || dest != userBinPath(l.alice.HomeDir) {
				t.Fatalf("%s now links to %q (%v), want the link as it was", l.link, dest, err)
			}
			assertNoTemporaries(t, filepath.Dir(l.link))
			if !strings.Contains(stderr(), "sudo install -o 0 -g 0 -m 0755 "+l.link+" "+l.link+".new && sudo mv -f "+l.link+".new "+l.link) {
				t.Errorf("stderr does not say how to put root's copy back: %q", stderr())
			}
		})
	}
	t.Run("no sudo", func(t *testing.T) {
		l := newLinkedInstall(t)
		calls := realSudo(t)
		if replaced, err := repairMachineLink(false, ""); replaced || err == nil {
			t.Fatalf("repairMachineLink = %v, %v; want an error naming root", replaced, err)
		}
		assertCommands(t, *calls)
		if _, err := os.Readlink(l.link); err != nil {
			t.Fatalf("%s is no longer the link: %v", l.link, err)
		}
	})
}

// Only a link to a file an account can change, in root's directory, is replaced.
func TestMachineLinkRepairLeavesEverythingElse(t *testing.T) {
	t.Run("link to root's own file", func(t *testing.T) {
		l := newLinkedInstall(t)
		rootsAlone = func(string) bool { return true }
		if replaced, err := repairMachineLink(true, ""); replaced || err != nil {
			t.Fatalf("repairMachineLink = %v, %v", replaced, err)
		}
		if _, err := os.Readlink(l.link); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("directory not root's", func(t *testing.T) {
		l := newLinkedInstall(t)
		rootOwnedDir = func(string) bool { return false }
		if replaced, err := repairMachineLink(true, ""); replaced || err != nil {
			t.Fatalf("repairMachineLink = %v, %v", replaced, err)
		}
		if _, err := os.Readlink(l.link); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("dangling link", func(t *testing.T) {
		l := newLinkedInstall(t)
		if err := os.Remove(l.copy); err != nil {
			t.Fatal(err)
		}
		if replaced, err := repairMachineLink(true, ""); replaced || err != nil {
			t.Fatalf("repairMachineLink = %v, %v", replaced, err)
		}
	})
	t.Run("root's regular file", func(t *testing.T) {
		l := newLegacyInstall(t)
		if replaced, err := repairMachineLink(true, ""); replaced || err != nil {
			t.Fatalf("repairMachineLink = %v, %v", replaced, err)
		}
		l.assertLegacyUntouched(t)
	})
}

// `sudo /usr/local/bin/orbit upgrade` on the linked layout: root's own file goes back in place of
// the link, the verified release is installed there rather than into alice's copy, which her runner
// updates itself, and running it again replaces root's file where it is.
func TestMachineLinkUpgradeInstallsTheReleaseAtRootsOwnFile(t *testing.T) {
	if platformKey() == "" {
		t.Skip("self-update is unsupported on this test platform")
	}
	l := newLinkedInstall(t)
	recordInstallCommands(t, nil)
	binary, gz := fakeRelease(t, sha256TestRelease, "machine")
	manifest := sha256TestManifest(publishedAssets(gz))
	srv := serveRelease(t, manifest, gz)

	for round := 1; round <= 2; round++ {
		exe, err := selfUpdateTarget()
		if err != nil {
			t.Fatal(err)
		}
		target, restart := migrateLegacyInstall(exe)
		if !sameFile(target, l.link) || restart != nil {
			t.Fatalf("round %d: migrateLegacyInstall(%q) = %q, %v; want %q and nothing to restart", round, exe, target, restart != nil, l.link)
		}
		var log strings.Builder
		if !installRelease(srv.URL, platformKey(), manifest, target, probeAsThisProcess, func(s string) { log.WriteString(s) }) {
			t.Fatalf("round %d: installRelease failed: %s", round, log.String())
		}
		l.assertRootsOwn(t, string(binary))
	}
	if b, _ := os.ReadFile(l.copy); bytes.Equal(b, binary) {
		t.Fatalf("the release went into alice's copy %s", l.copy)
	}
}
