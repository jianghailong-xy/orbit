package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
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
// on a set-up host. install.sh hands register over the same way under `curl … | sudo bash`.
// unregister goes along, so that it finds the config register wrote and removes that account's unit.

// sudoHandOffEnv is what of root's environment the account's command still reads, and sudo would
// reset: the runner home when one was named, that install.sh already showed its plan, and the proxy
// register offers to carry into the service.
var sudoHandOffEnv = []string{
	"ORBIT_HOME", "ORBIT_INSTALL_PLAN",
	"https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "no_proxy", "NO_PROXY",
}

// sudoAccount is the account a command run through sudo acts for: SUDO_USER, when this process is root
// and that names an account of this machine other than root. Anything else, root's own login included,
// is no hand-off: there the runner is root's.
func sudoAccount() (*user.User, bool) {
	if processEUID() != 0 {
		return nil, false
	}
	name := os.Getenv("SUDO_USER")
	if name == "" || name == "root" {
		return nil, false
	}
	u, err := lookupUser(name)
	if err != nil || u.Uid == "0" {
		return nil, false
	}
	return u, true
}

// sudoHandOffArgv is the command line that runs exe with args as account: sudo -H gives it the
// account's own HOME, and env carries what this process has of sudoHandOffEnv.
func sudoHandOffArgv(sudo, account, exe string, args []string) []string {
	argv := []string{sudo, "-H", "-u", account, "--", "env"}
	for _, k := range sudoHandOffEnv {
		if v := os.Getenv(k); v != "" {
			argv = append(argv, k+"="+v)
		}
	}
	argv = append(argv, exe)
	return append(argv, args...)
}

// execSudoHandOff replaces this process with argv. A var so a test can play the account's side itself.
var execSudoHandOff = func(argv []string) error {
	return syscall.Exec(argv[0], argv, os.Environ())
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
	fail := func(format string, a ...any) bool {
		fmt.Fprintf(os.Stderr, "orbit %s: under sudo it runs as %s, the account that ran sudo, and ", args[0], account.Username)
		fmt.Fprintf(os.Stderr, format+"\n", a...)
		os.Exit(1)
		return false
	}
	sudo, err := exec.LookPath("sudo")
	if err != nil {
		return fail("cannot find sudo to switch to it: %v", err)
	}
	exe, err := os.Executable()
	if err != nil {
		return fail("cannot locate its own executable: %v", err)
	}
	home := os.Getenv("ORBIT_HOME")
	if home == "" {
		home = filepath.Join(account.HomeDir, ".orbit")
	}
	fmt.Fprintf(os.Stderr, "note: under sudo, `orbit %s` runs as %s, the account that ran sudo and the one its runner runs as, with the runner's config in %s.\n",
		args[0], account.Username, home)
	if err := execSudoHandOff(sudoHandOffArgv(sudo, account.Username, exe, args)); err != nil {
		return fail("could not switch to it: %v", err)
	}
	return true
}
