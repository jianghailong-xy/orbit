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

// The install layout a runner can update itself in. The real binary lives in ~/.orbit/bin of
// the account the background service runs as, which that account can write, and
// /usr/local/bin/orbit — where everyone's PATH finds it — is only a symlink to it. The
// service names the resolved path, and resolvedExecutable follows the symlink, so a
// self-update replaces the copy in ~/.orbit/bin. Older installs put the real file in
// /usr/local/bin, which is root's while the service runs as an ordinary account: a release
// could be downloaded but never swapped in. `orbit register` (adoptUserBin) and
// `sudo orbit upgrade` (migrateLegacyInstall) move such an install over.

// userBinPath is where the runner binary of the account whose home is home lives.
func userBinPath(home string) string {
	return filepath.Join(home, ".orbit", "bin", "orbit")
}

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

// moveToUserBin copies the binary at exe into userBinPath(home) and leaves a symlink to the
// copy where exe was, so whatever names exe — the PATH, a service definition not rewritten
// yet — runs the copy its owner can update. The copy is complete before the symlink replaces
// exe, so a failure leaves the old install working. Running as root, uid and gid get what
// this creates; otherwise the symlink, the one step that needs root, goes through sudo.
func moveToUserBin(exe, home string, uid, gid int, root bool, sudo string) (string, error) {
	to := userBinPath(home)
	if sameFile(exe, to) {
		return to, nil
	}
	if !root && sudo == "" {
		return "", fmt.Errorf("replacing %s with a symlink needs root", exe)
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
	_, statErr := os.Lstat(to)
	existed := statErr == nil
	if err := copyExecutable(exe, to, uid, gid, root); err != nil {
		return "", err
	}
	if err := linkOver(exe, to, root, sudo); err != nil {
		if !existed {
			_ = os.Remove(to)
		}
		return "", err
	}
	return to, nil
}

// copyExecutable writes a copy of src at dst through a temporary name, so dst is only ever
// the file it was or the complete copy.
func copyExecutable(src, dst string, uid, gid int, root bool) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.new-%d", dst, os.Getpid())
	if err := os.WriteFile(tmp, data, 0o755); err != nil {
		return err
	}
	if root {
		if err := os.Lchown(tmp, uid, gid); err != nil {
			_ = os.Remove(tmp)
			return err
		}
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// linkOver replaces path with a symlink to target: renamed into place in-process when we are
// root, so path never goes missing, and through `sudo ln -sf` otherwise.
func linkOver(path, target string, root bool, sudo string) error {
	if !root {
		if err := run(sudo, "ln", "-sf", target, path); err != nil {
			return fmt.Errorf("could not link %s to %s", path, target)
		}
		return nil
	}
	tmp := fmt.Sprintf("%s.link-%d", path, os.Getpid())
	if err := os.Symlink(target, tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// adoptUserBin is `orbit register`'s half of the move. The service about to be installed for
// u would run exe; when exe sits in a directory only root can write, it moves into u's
// ~/.orbit/bin first and the service runs the moved copy. defs are the installed services
// already running exe. Returns the binary the service should run: exe itself whenever
// nothing moved — exe is already u's to replace, u is root, another account's service runs
// the same file (moving it into u's home would take it away from them), or there is no way
// to get root for the symlink.
func adoptUserBin(exe string, u *user.User, defs []serviceDef, root bool, sudo string) string {
	if u.Uid == "0" || !rootOwnedDir(filepath.Dir(exe)) {
		return exe
	}
	for _, d := range defs {
		if d.user != u.Username {
			fmt.Fprintf(os.Stderr, "note: %s also runs %s (as %s), so the binary stays there and this runner cannot update itself.\n",
				d.path, exe, d.user)
			return exe
		}
	}
	if !root && sudo != "" {
		fmt.Printf("\nMoving orbit into %s so the runner can update itself — linking %s to it needs root; you may be prompted for your password.\n",
			filepath.Dir(userBinPath(u.HomeDir)), exe)
	}
	uid, _ := strconv.Atoi(u.Uid)
	gid, _ := strconv.Atoi(u.Gid)
	to, err := moveToUserBin(exe, u.HomeDir, uid, gid, root, sudo)
	if err != nil {
		fmt.Fprintf(os.Stderr, "note: could not move %s into %s (%v); the runner cannot update itself until `sudo orbit upgrade` does.\n",
			exe, filepath.Dir(userBinPath(u.HomeDir)), err)
		return exe
	}
	fmt.Printf("✓ moved orbit to %s (%s links to it), so the runner can update itself.\n", to, exe)
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
		b, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		def := serviceDef{path: path, user: "root"}
		for _, line := range strings.Split(string(b), "\n") {
			if v, ok := strings.CutPrefix(line, "User="); ok {
				def.user = strings.TrimSpace(v)
			} else if v, ok := strings.CutPrefix(line, "ExecStart="); ok {
				def.program, _, _ = strings.Cut(strings.TrimSpace(v), " ")
			}
		}
		if def.program != "" && sameFile(def.program, exe) {
			defs = append(defs, def)
		}
	}
	return defs
}

// launchAgentPath is the runner's LaunchAgent plist in the account whose home is home.
func launchAgentPath(home string) string {
	return filepath.Join(home, "Library", "LaunchAgents", launchdLabel+".plist")
}

// launchdServicesRunning returns the LaunchAgent of the account that invoked sudo, when it
// runs exe. A LaunchAgent belongs to one login, and that login is whose runner a
// `sudo orbit upgrade` is about.
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

// migrateLegacyInstall is `sudo orbit upgrade`'s half of the move, run as root before the
// release is swapped in. When exe sits in a directory only root can write and the runner
// service that runs it belongs to one ordinary account, the binary moves into that account's
// ~/.orbit/bin, exe becomes a symlink to it, and the service definition is rewritten to name
// the new path. A service running as root, a binary several accounts' services share, or no
// service at all leaves everything as it is. The returned func restarts the rewritten
// services — call it once the release is in place, so they come back on it; nil means
// nothing moved.
func migrateLegacyInstall(exe string) func() {
	if !rootOwnedDir(filepath.Dir(exe)) {
		return nil
	}
	var defs []serviceDef
	switch runtime.GOOS {
	case "linux":
		defs = systemdServicesRunning(systemdUnitDir, exe)
	case "darwin":
		defs = launchdServicesRunning(exe)
	}
	return migrateServices(exe, defs)
}

// migrateServices is migrateLegacyInstall once the services running exe are known.
func migrateServices(exe string, defs []serviceDef) func() {
	if len(defs) == 0 {
		return nil
	}
	owner := defs[0].user
	for _, d := range defs[1:] {
		if d.user != owner {
			fmt.Fprintf(os.Stderr, "note: %s is run by services of more than one account (%s as %s, %s as %s), so it stays where it is.\n",
				exe, defs[0].path, owner, d.path, d.user)
			return nil
		}
	}
	u, err := lookupUser(owner)
	if err != nil || u.Uid == "0" {
		// Root's runner can replace its binary where it is; a template's %i is no account.
		return nil
	}
	uid, _ := strconv.Atoi(u.Uid)
	gid, _ := strconv.Atoi(u.Gid)
	to, err := moveToUserBin(exe, u.HomeDir, uid, gid, true, "")
	if err != nil {
		fmt.Fprintf(os.Stderr, "note: could not move %s into %s (%v); it stays where it is.\n",
			exe, filepath.Dir(userBinPath(u.HomeDir)), err)
		return nil
	}
	fmt.Printf("moved orbit to %s (%s links to it), so %s's runner can update itself\n", to, exe, owner)
	for _, d := range defs {
		b, err := os.ReadFile(d.path)
		if err == nil {
			err = os.WriteFile(d.path, []byte(d.withProgram(string(b), to)), 0o644)
		}
		if err != nil {
			// The symlink still leads the old path to the moved binary.
			fmt.Fprintf(os.Stderr, "note: could not rewrite %s (%v); it reaches %s through %s\n", d.path, err, to, d.program)
		}
	}
	return func() { restartServices(defs, u.Uid) }
}

// restartServices brings the rewritten services back up on the binary they now name.
func restartServices(defs []serviceDef, uid string) {
	reloaded := false
	for _, d := range defs {
		if d.launchd {
			// The account's own GUI domain: as root, a plain `launchctl load` lands in root's.
			domain := "gui/" + uid
			runQuiet("launchctl", "bootout", domain, d.path)
			if err := run("launchctl", "bootstrap", domain, d.path); err != nil {
				fmt.Fprintf(os.Stderr, "note: could not reload %s; it starts from the new path at the next login\n", d.path)
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
