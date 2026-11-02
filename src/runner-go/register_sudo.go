package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"syscall"
)

// Under sudo, `orbit register` and `orbit unregister` are handed to the account sudo was run from
// and run as it, exactly as when that account runs them itself. That account is the one the runner
// service runs as (registeringUser), but run as root, register kept the runner's config wherever
// root's HOME pointed. `sudo -i`, and plain sudo where the distribution resets HOME, point it at
// /root: register wrote /root/.orbit/config.json and put ORBIT_HOME=/root/.orbit into a unit running
// as the account, which cannot enter /root, so the runner exited at every start ("cannot secure runner
// config storage: chmod /root/.orbit: permission denied") while register said it was online. A host
// set up with `orbit host setup` got the same unit, by the sudo path, after hostd refused uid 0. On
// macOS, root's launchctl loads the agent into the system domain, where it runs as root.
//
// As the account, register writes the credential into the account's own ~/.orbit itself, so root
// follows no link there, and asks for root only for the system service: through sudo, or from hostd
// on a set-up host. install.sh hands register to the account as well under `curl … | sudo bash`.
// unregister goes along, so that it finds the config register wrote and removes that account's unit.

// sudoHandOffEnv is what of root's environment the account's command still reads, and sudo would
// reset: the runner home when one was named, that install.sh already showed its plan, the proxy
// register offers to carry into the service, and the private CA it reaches the control plane through.
var sudoHandOffEnv = []string{
	"ORBIT_HOME", "ORBIT_INSTALL_PLAN",
	"https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "no_proxy", "NO_PROXY",
	"SSL_CERT_FILE", "SSL_CERT_DIR",
}

// sudoAccount is the account a command run through sudo acts for: SUDO_USER, when this process is root
// and that names an account of this machine other than root. Anything else is no hand-off: on root's
// own login the runner is root's, and `sudo -u svc` already runs the command as the account it asked for.
func sudoAccount() (*user.User, bool) {
	if processEUID() != 0 {
		return nil, false
	}
	name := os.Getenv("SUDO_USER")
	if name == "" || name == "root" {
		return nil, false
	}
	u, err := lookupUser(name)
	if err != nil {
		// A release build reads /etc/passwd alone, where an LDAP or SSSD account is not. Going on as
		// root would give it a root runner; sudo can still switch to it by name. One the system does
		// not know either, a SUDO_USER a shell or an image inherited, is no hand-off.
		if !accountKnownToSystem(name) {
			return nil, false
		}
		return &user.User{Username: name}, true
	}
	if u.Uid == "0" {
		return nil, false
	}
	return u, true
}

// accountKnownToSystem asks the system's own id, which goes through NSS, whether name is an account
// other than root. A var so a test can answer for an account the machine does not have.
var accountKnownToSystem = func(name string) bool {
	for _, id := range []string{"/usr/bin/id", "/bin/id"} {
		if _, err := os.Stat(id); err == nil {
			out, err := exec.Command(id, "-u", "--", name).Output()
			return err == nil && strings.TrimSpace(string(out)) != "0"
		}
	}
	return false
}

// sudoHandOffMark is set for a command handed to the account, by this hand-off (sudoHandOffEnviron).
const sudoHandOffMark = "ORBIT_SUDO_HANDOFF"

// handedOffBySudo reports whether this process is such a command's account side, install.sh's included:
// someone asked for this with root in hand. Root's own `sudo -u svc orbit register` is not one: that is a
// plain registration of svc's, as far as anyone asked.
func handedOffBySudo() bool {
	return processEUID() != 0 && os.Getenv("SUDO_USER") == "root" &&
		(os.Getenv(sudoHandOffMark) == "1" || os.Getenv("ORBIT_INSTALL_PLAN") == "1")
}

// sudoHandOffArgv is the command line that runs exe with args as account: sudo -H gives it the account's
// own HOME, and -E passes on the environment sudo is started with, sudoHandOffEnviron. Not by name with
// --preserve-env, whose values sudo logs (ENV=https_proxy=…), nor on the command line, which it logs too and
// `ps` shows: a proxy's URL can hold a password.
func sudoHandOffArgv(sudo, account, exe string, args []string) []string {
	argv := []string{sudo, "-E", "-H", "-u", account, "--", exe}
	return append(argv, args...)
}

// sudoHandOffEnviron is the environment sudo is started with: what the account's command reads
// (sudoHandOffEnv) and what its terminal and browser need, and nothing else of root's, whose shell may
// hold anything, for a binary that may be the account's to replace. sudo drops what it always drops
// (LD_*) and sets USER, LOGNAME and HOME for the account.
func sudoHandOffEnviron() []string {
	env := []string{sudoHandOffMark + "=1"}
	for _, k := range append([]string{"PATH", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "DISPLAY", "WAYLAND_DISPLAY"}, sudoHandOffEnv...) {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, k+"="+v)
		}
	}
	return env
}

// accountCanRun is whether the account can execute a file, asked as that account. A var so a test can
// answer for an account the machine does not have.
var accountCanRun = accountCanExecute

// sudoSearchDirs is where the hand-off looks for sudo: the system's own directories, the last of them
// NixOS's, and not PATH. It runs what it finds as root, and where sudo keeps PATH (macOS, a sudoers with
// no secure_path) PATH is the account's, with directories the account and its agents can write. A var so
// a test can stand one in.
var sudoSearchDirs = []string{"/usr/bin", "/bin", "/usr/sbin", "/sbin", "/run/wrappers/bin"}

// systemSudo is the sudo in sudoSearchDirs, which root may run.
func systemSudo() (string, error) {
	for _, dir := range sudoSearchDirs {
		path := filepath.Join(dir, "sudo")
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 {
			return path, nil
		}
	}
	return "", fmt.Errorf("no sudo in %s", strings.Join(sudoSearchDirs, ", "))
}

// execSudoHandOff replaces this process with argv. A var so a test can play the account's side itself.
var execSudoHandOff = func(argv []string) error {
	return syscall.Exec(argv[0], argv, sudoHandOffEnviron())
}

// handOffUnderSudo hands a command — args is its name and arguments as typed — to the account sudo was
// run from, and reports whether it did. With no such account it does nothing and returns false. What
// the account runs is the whole command, so after a hand-off the caller does nothing more. One that
// cannot happen ends this process: going on as root is what left the runner dead.
func handOffUnderSudo(args []string) bool {
	account, ok := sudoAccount()
	if !ok {
		return false
	}
	fail := func(why, next string) bool {
		fmt.Fprintf(os.Stderr, "orbit %s: under sudo it runs as %s, the account that ran sudo, and %s.\n%s\n", args[0], account.Username, why, next)
		os.Exit(1)
		return false
	}
	asAccount := fmt.Sprintf("Run it as %s instead: orbit %s", account.Username, args[0])
	sudo, err := systemSudo()
	if err != nil {
		return fail("this could not switch to it: "+err.Error(), asAccount)
	}
	exe, err := os.Executable()
	if err != nil {
		return fail("this could not locate its own executable: "+err.Error(), asAccount)
	}
	// Asked first: past the exec nothing here can say what to do about it. An account whose groups could
	// not be read may still be able to.
	if can, err := accountCanRun(account, exe); err == nil && !can {
		return fail(fmt.Sprintf("%s cannot run %s", account.Username, exe),
			fmt.Sprintf("Install orbit as %s, with the command under Add a runner, then run it there: orbit %s", account.Username, args[0]))
	}
	where := ""
	if home := os.Getenv("ORBIT_HOME"); home != "" {
		where = ", with the runner's config in " + home
	} else if account.HomeDir != "" {
		where = ", with the runner's config in " + filepath.Join(account.HomeDir, ".orbit")
	}
	fmt.Fprintf(os.Stderr, "note: under sudo, `orbit %s` runs as %s, the account that ran sudo and the one its runner runs as%s.\n",
		args[0], account.Username, where)
	if root, err := lookupUser("root"); err == nil {
		if config := filepath.Join(root.HomeDir, ".orbit", "config.json"); fileExists(config) {
			fmt.Fprintf(os.Stderr, "note: root's home holds a runner's config too, %s, which this leaves as it is. For that runner: sudo -i env -u SUDO_USER orbit %s\n", config, args[0])
		}
	}
	// main put this process's own engine directories first on PATH, for root's commands. They are
	// nothing to the account, and where sudo keeps PATH (macOS, a sudoers with no secure_path) the
	// account's register would bake them into its service's PATH.
	_ = os.Setenv("PATH", withoutPathDirs(os.Getenv("PATH"), engineInstallerDirs(userHome())))
	if err := execSudoHandOff(sudoHandOffArgv(sudo, account.Username, exe, args)); err != nil {
		return fail("this could not switch to it: "+err.Error(), asAccount)
	}
	return true
}

// stayRootForRunnerLeftInRootsHome points this process at a runner an older `sudo orbit register` left
// in root's home, and reports whether there is one (runnerLeftInRootsHome). Unregister has to read that
// runner's credential to delete it, and only root can. Handed to the account, it would find no runner and
// leave that service running, so this one stays root's, on the system's own PATH, past the broker, which
// answers uid 0 about root's own instance.
func stayRootForRunnerLeftInRootsHome() bool {
	account, ok := sudoAccount()
	if !ok {
		return false
	}
	root, err := lookupUser("root")
	if err != nil || !runnerLeftInRootsHome(runtime.GOOS, account, root) {
		return false
	}
	home := filepath.Join(root.HomeDir, ".orbit")
	fmt.Fprintf(os.Stderr, "note: this runner's config is in %s, where an older `sudo orbit register` left it and only root can reach it, so `orbit unregister` stays root for this one.\n", home)
	_ = os.Setenv("HOME", root.HomeDir)
	_ = os.Setenv("ORBIT_HOME", home)
	_ = os.Setenv("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
	serviceBrokerSocket = ""
	return true
}

// runnerLeftInRootsHome reports whether account's runner is one an older `sudo orbit register` left in
// root's home. A config there, and on Linux the account's unit naming it as ORBIT_HOME, which is what that
// register installed. A Mac cannot tell: that register's agent is in root's own LaunchAgents, as a runner
// root registered for itself is, so there it takes an account with no runner of its own to be the one
// asking about this one.
func runnerLeftInRootsHome(goos string, account, root *user.User) bool {
	home := filepath.Join(root.HomeDir, ".orbit")
	if !fileExists(filepath.Join(home, "config.json")) {
		return false
	}
	switch goos {
	case "linux":
		unit, err := os.ReadFile(filepath.Join(serviceUnitDir, systemdServiceFor(account.Username)+".service"))
		return err == nil && strings.Contains(string(unit), "\nEnvironment=ORBIT_HOME="+home+"\n")
	case "darwin":
		return fileExists(launchAgentPath(root.HomeDir)) && !fileExists(filepath.Join(account.HomeDir, ".orbit", "config.json"))
	}
	return false
}

// serviceNamesMachineHome reports whether the service definition of this account's runner, whatever is or
// is not left of its config, names this process's machineHome as its runner home.
func serviceNamesMachineHome(goos string, u *user.User) bool {
	home := machineHome()
	switch goos {
	case "linux":
		unit, err := os.ReadFile(filepath.Join(serviceUnitDir, systemdServiceFor(u.Username)+".service"))
		return err == nil && strings.Contains(string(unit), "\nEnvironment=ORBIT_HOME="+home+"\n")
	case "darwin":
		plist, err := os.ReadFile(launchAgentPath(userHome()))
		return err == nil && strings.Contains(string(plist), "<key>ORBIT_HOME</key><string>"+home+"</string>")
	}
	return false
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// registerCwd is the directory this registration says it ran in, or nothing when this account cannot
// enter it: a register handed over from `sudo -i` (handOffUnderSudo) is still in /root. That directory
// exists to the runner's directory probe, which only stats it, so the machine's setup card would offer a
// folder no session of this runner can start in. access(2) rather than a look inside: on a Mac, a read
// of ~/Desktop or ~/Downloads makes macOS ask the user for access.
func registerCwd() string {
	const readAndSearch = 0o4 | 0o1 // R_OK | X_OK
	cwd, err := os.Getwd()
	if err != nil || syscall.Access(cwd, readAndSearch) != nil {
		return ""
	}
	return cwd
}

// withoutPathDirs is path with dirs left out.
func withoutPathDirs(path string, dirs []string) string {
	var kept []string
	for _, p := range strings.Split(path, string(os.PathListSeparator)) {
		if !slices.Contains(dirs, p) {
			kept = append(kept, p)
		}
	}
	return strings.Join(kept, string(os.PathListSeparator))
}
