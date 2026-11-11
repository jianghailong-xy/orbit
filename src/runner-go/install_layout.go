package main

import (
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

// The install layout a runner can update itself in. The binary the background service runs is
// the copy in ~/.orbit/bin of the account it runs as, which that account can write, so a
// self-update replaces it there. /usr/local/bin/orbit, where everyone's PATH and sudo's
// secure_path find `orbit`, is root's own regular file: root runs it under every `sudo orbit …`,
// so it is never a symlink into an account's home, which the account — and any agent it runs —
// could replace. It does not follow the runner's self-updates; `sudo /usr/local/bin/orbit upgrade`
// brings it up to date. A machine set up with `orbit host setup` has the same layout, with hostd
// keeping /usr/local/bin/orbit current, and install.sh installs into ~/.orbit/bin without
// touching /usr/local/bin/orbit.
//
// Two older layouts are moved over. The oldest put the only binary in /usr/local/bin, root's while
// the service runs as an ordinary account, so a release could be downloaded but never swapped in:
// `orbit register` (adoptUserBin) and `sudo /usr/local/bin/orbit upgrade` (migrateLegacyInstall)
// give the account its own copy and point the service at it, leaving /usr/local/bin/orbit where it
// is. Later releases of both instead replaced /usr/local/bin/orbit with a symlink to that copy;
// both now put a root-owned copy back in its place (repairMachineLink). The command that does so
// has itself already run the account's file as root, as every `sudo orbit …` did before it; it is
// the last that does.

// userBinPath is where the runner binary of the account whose home is home lives.
func userBinPath(home string) string {
	return filepath.Join(home, ".orbit", "bin", "orbit")
}

// sharedBinaryPath is the orbit everyone's PATH and sudo find, and that root runs: the machine's
// binary. A var so tests can stand a temporary directory in for /usr/local/bin.
var sharedBinaryPath = machineBinaryPath

// rootOwnedDir reports whether dir belongs to root — the legacy /usr/local/bin, where a
// runner running as an ordinary account can never replace its binary. A var so tests can say
// which of their temporary directories stand for root's.
var rootOwnedDir = func(dir string) bool {
	fi, err := os.Stat(dir)
	if err != nil {
		return false
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	return ok && st.Uid == 0
}

// rootsAlone reports whether path is a file no account but root can change: the rule hostd holds
// its binary to. A var so tests can say which of their files stand for root's.
var rootsAlone = func(path string) bool {
	return checkMachineBinary(path, "/", 0) == nil
}

// machineOwner is the uid and gid the machine's binary is given. A var so a test, which cannot
// hand a file to root, can check everything else a repair does.
var machineOwner = func() (int, int) { return 0, 0 }

// lookupUser resolves the account a service definition names. A var so tests can stand a
// temporary home in for an account the machine running them does not have.
var lookupUser = user.Lookup

// sameFile reports whether a and b name one file, through symlinks or not.
func sameFile(a, b string) bool {
	fa, err := os.Stat(a)
	if err != nil {
		return false
	}
	fb, err := os.Stat(b)
	return err == nil && os.SameFile(fa, fb)
}

// copyToUserBin puts a copy of the binary at exe at userBinPath(home) and leaves exe as it is.
// Running as root, uid and gid get what this creates; otherwise this process is the account and
// writes into its own home. Nothing is written when exe already is that file.
func copyToUserBin(exe, home string, uid, gid int, root bool) (string, error) {
	to := userBinPath(home)
	if sameFile(exe, to) {
		return to, nil
	}
	binDir := filepath.Dir(to)
	orbitDir := filepath.Dir(binDir)
	// ~/.orbit also holds the runner's credential: the mode saveConfig gives it.
	if err := os.Mkdir(orbitDir, machineHomePerm); err != nil && !os.IsExist(err) {
		return "", err
	}
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return "", err
	}
	if root {
		for _, dir := range []string{orbitDir, binDir} {
			if err := os.Lchown(dir, uid, gid); err != nil {
				return "", err
			}
		}
	}
	if err := copyExecutable(exe, to, uid, gid, root); err != nil {
		return "", err
	}
	return to, nil
}

// copyExecutable writes a copy of src at dst through a temporary name in dst's directory, so dst
// is only ever the file it was or the complete copy, with owner and mode set before it gets there.
// chown says whether to give it uid and gid.
func copyExecutable(src, dst string, uid, gid int, chown bool) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.new-%d", dst, os.Getpid())
	if err := os.WriteFile(tmp, data, 0o755); err != nil {
		return err
	}
	if chown {
		if err := os.Lchown(tmp, uid, gid); err != nil {
			_ = os.Remove(tmp)
			return err
		}
	}
	// WriteFile's mode passes through the umask, and a chown can drop set-id bits: say it outright.
	if err := os.Chmod(tmp, 0o755); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// repairMachineLink puts a root-owned regular file back at sharedBinaryPath where an earlier
// register or upgrade left a symlink to a file an account can change, so no later `sudo orbit …`
// runs that file. The copy holds what the link led to and is complete, root's and mode 0755 in
// /usr/local/bin before it is renamed over the link, so the path never goes missing. As root it
// happens in-process; otherwise through sudo, `install` into a temporary name beside the link and
// `mv` over it. Anything else at the path — root's own file, a link to one, nothing, a directory
// root does not own — is left as it is, so running it again does nothing. Returns whether it
// replaced the link, and the error that kept it from doing so.
func repairMachineLink(root bool, sudo string) (bool, error) {
	path := sharedBinaryPath
	fi, err := os.Lstat(path)
	if err != nil || fi.Mode()&os.ModeSymlink == 0 || !rootOwnedDir(filepath.Dir(path)) {
		return false, nil
	}
	target, err := filepath.EvalSymlinks(path)
	if err != nil || rootsAlone(target) {
		// A dangling link runs nothing; one to root's own file is root's to keep.
		return false, nil
	}
	if root {
		uid, gid := machineOwner()
		return true, copyExecutable(target, path, uid, gid, true)
	}
	if sudo == "" {
		return false, fmt.Errorf("replacing %s needs root", path)
	}
	uid, gid := machineOwner()
	tmp := fmt.Sprintf("%s.new-%d", path, os.Getpid())
	if err := run(sudo, "install", "-o", strconv.Itoa(uid), "-g", strconv.Itoa(gid), "-m", "0755", target, tmp); err != nil {
		return false, fmt.Errorf("could not put a root-owned copy of %s at %s", target, tmp)
	}
	if err := run(sudo, "mv", "-f", tmp, path); err != nil {
		_ = run(sudo, "rm", "-f", tmp)
		return false, fmt.Errorf("could not move %s over %s", tmp, path)
	}
	return true, nil
}

// noteMachineLinkRepair says what repairMachineLink did, or why it could not, on the path it was
// asked to: register's or upgrade's own output.
func noteMachineLinkRepair(replaced bool, err error) {
	path := sharedBinaryPath
	switch {
	case err != nil:
		fmt.Fprintf(os.Stderr, "note: %s links to a file this account can change, so every `sudo orbit …` runs that file as root, and it could not be replaced (%v). Put root's own copy there: sudo install -o 0 -g 0 -m 0755 %s %s.new && sudo mv -f %s.new %s\n",
			path, err, path, path, path, path)
	case replaced:
		fmt.Printf("✓ %s is root's own copy again, not a link to a file this account can change; `sudo %s upgrade` keeps it current.\n", path, path)
	}
}

// adoptUserBin is `orbit register`'s half of the layout. The service about to be installed for u
// would run exe; when exe sits in a directory only root can write, u gets its own copy in
// ~/.orbit/bin and the service runs that, while exe stays as it is for everyone else who runs it.
// Before that, a /usr/local/bin/orbit an earlier register left linked to u's copy becomes root's
// own file again (repairMachineLink). Returns the binary the service should run: exe itself when
// nothing was copied — exe is already u's to replace, u is root, or the copy failed.
func adoptUserBin(exe string, u *user.User, root bool, sudo string) string {
	if u.Uid != "0" {
		if !root && sudo != "" {
			if fi, err := os.Lstat(sharedBinaryPath); err == nil && fi.Mode()&os.ModeSymlink != 0 {
				fmt.Printf("\nChecking %s, which root runs; replacing a link there needs root — you may be prompted for your password.\n", sharedBinaryPath)
			}
		}
		noteMachineLinkRepair(repairMachineLink(root, sudo))
	}
	if u.Uid == "0" || !rootOwnedDir(filepath.Dir(exe)) {
		return exe
	}
	uid, _ := strconv.Atoi(u.Uid)
	gid, _ := strconv.Atoi(u.Gid)
	to, err := copyToUserBin(exe, u.HomeDir, uid, gid, root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "note: could not copy %s into %s (%v); the runner cannot update itself until `sudo %s upgrade` does.\n",
			exe, filepath.Dir(userBinPath(u.HomeDir)), err, exe)
		return exe
	}
	fmt.Printf("✓ copied orbit to %s, which the runner runs and updates; %s stays root's.\n", to, exe)
	return to
}

// serviceDef is one installed runner service definition — a systemd unit or a LaunchAgent
// plist — together with the binary it runs and the account it runs as.
type serviceDef struct {
	path    string // the unit file or plist
	user    string // the account the service runs as
	program string // the binary, spelled as the definition spells it
	launchd bool
}

// systemdServicesRunning lists the orbit units in unitDir whose ExecStart= runs exe, by that
// path or through a symlink. A unit that names no User= runs as root, as orbit-hostd does;
// the orbit-runner@ template's User= is the literal %i.
func systemdServicesRunning(unitDir, exe string) []serviceDef {
	paths, _ := filepath.Glob(filepath.Join(unitDir, "orbit-*.service"))
	var defs []serviceDef
	for _, path := range paths {
		def, err := readSystemdServiceDef(path)
		if err != nil {
			continue
		}
		if def.program != "" && sameFile(def.program, exe) {
			defs = append(defs, def)
		}
	}
	return defs
}

// readSystemdServiceDef reads the account the unit at path runs as — root when it names no User= —
// and the binary its ExecStart= runs, as the unit spells it. hostd's update reads the runner
// template's binary through it too.
func readSystemdServiceDef(path string) (serviceDef, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return serviceDef{}, err
	}
	def := serviceDef{path: path, user: "root"}
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(line, "User="); ok {
			def.user = strings.TrimSpace(v)
		} else if v, ok := strings.CutPrefix(line, "ExecStart="); ok {
			def.program, _, _ = strings.Cut(strings.TrimSpace(v), " ")
		}
	}
	return def, nil
}

// launchAgentPath is the runner's LaunchAgent plist in the account whose home is home.
func launchAgentPath(home string) string {
	return filepath.Join(home, "Library", "LaunchAgents", launchdLabel+".plist")
}

// launchdServicesRunning returns the LaunchAgent of the account that invoked sudo, when it
// runs exe. A LaunchAgent belongs to one login, and that login is whose runner a
// `sudo /usr/local/bin/orbit upgrade` is about.
func launchdServicesRunning(exe string) []serviceDef {
	name := os.Getenv("SUDO_USER")
	if name == "" || name == "root" {
		return nil
	}
	u, err := lookupUser(name)
	if err != nil {
		return nil
	}
	path := launchAgentPath(u.HomeDir)
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	program := plistProgram(string(b))
	if program == "" || !sameFile(program, exe) {
		return nil
	}
	return []serviceDef{{path: path, user: name, program: program, launchd: true}}
}

const programArgumentsKey = "<key>ProgramArguments</key>"

// plistProgram is the first ProgramArguments entry of a LaunchAgent plist: the binary it runs.
func plistProgram(plist string) string {
	_, rest, ok := strings.Cut(plist, programArgumentsKey)
	if !ok {
		return ""
	}
	_, rest, ok = strings.Cut(rest, "<string>")
	if !ok {
		return ""
	}
	program, _, ok := strings.Cut(rest, "</string>")
	if !ok {
		return ""
	}
	return program
}

// withProgram returns the definition's content with the binary it runs replaced by to,
// everything else — environment, proxy, PATH — exactly as it was.
func (d serviceDef) withProgram(content, to string) string {
	if d.launchd {
		head, rest, ok := strings.Cut(content, programArgumentsKey)
		if !ok {
			return content
		}
		return head + programArgumentsKey +
			strings.Replace(rest, "<string>"+d.program+"</string>", "<string>"+to+"</string>", 1)
	}
	lines := strings.Split(content, "\n")
	for i, line := range lines {
		v, ok := strings.CutPrefix(line, "ExecStart=")
		if !ok {
			continue
		}
		program, args, hasArgs := strings.Cut(strings.TrimSpace(v), " ")
		if program != d.program {
			continue
		}
		lines[i] = "ExecStart=" + to
		if hasArgs {
			lines[i] += " " + args
		}
	}
	return strings.Join(lines, "\n")
}

// migrateLegacyInstall is `sudo /usr/local/bin/orbit upgrade`'s half of the layout, run as root
// before the release is swapped in. exe is the binary this process runs, symlinks resolved. It
// returns where the release goes, and a func to call once it is there (nil when there is nothing
// to do).
//
// A /usr/local/bin/orbit linked to an account's copy becomes root's own file again
// (repairMachineLink), and the release goes there: the account's runner updates its own copy. When
// exe sits in a directory only root can write, the release replaces it where it is, and afterwards
// each ordinary account whose runner service runs it gets its own copy of the new release in
// ~/.orbit/bin, its service definition rewritten to name that copy and restarted on it. A service
// running as root, a template instance and the host broker go on running exe.
func migrateLegacyInstall(exe string) (string, func()) {
	replaced, err := repairMachineLink(true, "")
	noteMachineLinkRepair(replaced, err)
	if replaced {
		return sharedBinaryPath, nil
	}
	if !rootOwnedDir(filepath.Dir(exe)) {
		return exe, nil
	}
	var defs []serviceDef
	switch runtime.GOOS {
	case "linux":
		defs = systemdServicesRunning(systemdUnitDir, exe)
	case "darwin":
		defs = launchdServicesRunning(exe)
	}
	return exe, migrateServices(exe, defs)
}

// migrateServices is migrateLegacyInstall once the services running exe are known: the func that,
// called once the release is at exe, gives each ordinary account among them its own copy and
// moves its services onto it. nil when none of them is an ordinary account's.
func migrateServices(exe string, defs []serviceDef) func() {
	var accounts []*user.User
	byAccount := map[string][]serviceDef{}
	for _, d := range defs {
		u, err := lookupUser(d.user)
		if err != nil || u.Uid == "0" {
			// Root's runner can replace its binary where it is; a template's %i is no account.
			continue
		}
		if _, ok := byAccount[u.Username]; !ok {
			accounts = append(accounts, u)
		}
		byAccount[u.Username] = append(byAccount[u.Username], d)
	}
	if len(accounts) == 0 {
		return nil
	}
	return func() {
		for _, u := range accounts {
			uid, _ := strconv.Atoi(u.Uid)
			gid, _ := strconv.Atoi(u.Gid)
			to, err := copyToUserBin(exe, u.HomeDir, uid, gid, true)
			if err != nil {
				fmt.Fprintf(os.Stderr, "note: could not copy %s into %s (%v); %s's runner goes on running %s\n",
					exe, filepath.Dir(userBinPath(u.HomeDir)), err, u.Username, exe)
				continue
			}
			fmt.Printf("copied orbit to %s, so %s's runner can update itself; %s stays root's\n", to, u.Username, exe)
			var moved []serviceDef
			for _, d := range byAccount[u.Username] {
				b, err := os.ReadFile(d.path)
				if err == nil {
					err = os.WriteFile(d.path, []byte(d.withProgram(string(b), to)), 0o644)
				}
				if err != nil {
					fmt.Fprintf(os.Stderr, "note: could not rewrite %s (%v); it goes on running %s\n", d.path, err, d.program)
					continue
				}
				moved = append(moved, d)
			}
			restartServices(moved, u.Uid)
		}
	}
}

// restartServices brings the rewritten services back up on the binary they now name.
func restartServices(defs []serviceDef, uid string) {
	reloaded := false
	for _, d := range defs {
		if d.launchd {
			// The account's own domain, which its plist records: as root, a plain `launchctl load` lands in root's.
			plist, _ := os.ReadFile(d.path)
			domain := launchdDomain(string(plist), uid)
			if err := startLaunchd(domain, domain, d.path, launchdLabel, func() {}); err != nil {
				fmt.Fprintf(os.Stderr, "note: could not reload %s (%v); it starts from the new path the next time it starts\n", d.path, err)
			}
			continue
		}
		if !reloaded {
			if err := run("systemctl", "daemon-reload"); err != nil {
				fmt.Fprintln(os.Stderr, "note: systemctl daemon-reload failed; the runner moves to the new path at its next restart")
				return
			}
			reloaded = true
		}
		unit := filepath.Base(d.path)
		if err := run("systemctl", "restart", unit); err != nil {
			fmt.Fprintf(os.Stderr, "note: could not restart %s; it moves to the new path at its next restart\n", unit)
		}
	}
}
