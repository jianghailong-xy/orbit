package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// `orbit host setup` — the one command in this design that needs root, and it is run
// once per machine. It installs the machine broker (orbit-hostd, socket-activated), which
// runs /usr/local/bin/orbit, and the orbit-runner@ template: each user's runner is the
// instance orbit-runner@<escaped user name>, running that user's own ~/.orbit/bin/orbit.
// Everything a user does afterwards — register, unregister, restart, update — goes
// through the broker's socket or the runner itself and needs no sudo at all.

// The files this command owns. Every one of them is written whole on every run: setup
// is meant to be re-runnable (a new binary path, a moved control plane), and a run that
// merged into what it found could leave a half-old unit nobody remembers editing.
const (
	hostRunnerTemplatePath = "/etc/systemd/system/orbit-runner@.service"
	hostdSocketUnitPath    = "/etc/systemd/system/orbit-hostd.socket"
	hostdServiceUnitPath   = "/etc/systemd/system/orbit-hostd.service"
	// tmpfiles.d, not RuntimeDirectory=: /run/orbit has to exist before the socket unit
	// can bind inside it, and the socket unit is what starts hostd in the first place.
	hostdTmpfilesPath = "/usr/lib/tmpfiles.d/orbit-hostd.conf"
	// The machine-level config: which control plane this host belongs to. hostd runs as
	// root with no user's ~/.orbit to read, so the server has to be written down
	// somewhere it — and every uid — can find it.
	hostConfigPath = "/etc/orbit/config.json"

	hostdSocketUnit  = "orbit-hostd.socket"
	hostdServiceUnit = "orbit-hostd.service"
)

// hostFile is one file setup installs.
type hostFile struct {
	path    string
	mode    os.FileMode
	content string
}

// hostSetupEnv is everything setup reaches outside its own process, injected so the
// tests can drive the very same code against a temporary root. The zero value means
// "production defaults".
type hostSetupEnv struct {
	// prefix stands in for "/": every path below is written under it. Empty in
	// production, a temp dir under test.
	prefix     string
	geteuid    func() int
	executable func() (string, error)
	run        func(name string, args ...string) error
	// invokedAs is how the caller spelled this binary, echoed back in the sudo hint when it
	// is a path (sudoName), so the line they are told to re-run is the line they just typed.
	invokedAs string
	out       io.Writer
	// rootUID is who the binary the units will run, and every directory above it, must
	// belong to: root, the zero value. A field because a test cannot create files root
	// owns, so it names the uid that stands for root's instead.
	rootUID uint32
	// sys is how setup asks systemd, the passwd database and an account about the uid
	// instances it moves (moveUidInstances): hostd's own, with its unit directory under
	// prefix. Zero means production's.
	sys hostdSystem
}

func (env hostSetupEnv) withDefaults() hostSetupEnv {
	if env.geteuid == nil {
		env.geteuid = os.Geteuid
	}
	if env.executable == nil {
		// The same symlink-resolved path the self-updater replaces: systemd's ExecStart=
		// must name a real file, and /usr/local/bin/orbit is commonly a symlink.
		env.executable = resolvedExecutable
	}
	if env.run == nil {
		env.run = run
	}
	if env.invokedAs == "" {
		env.invokedAs = "orbit"
		if len(os.Args) > 0 && os.Args[0] != "" {
			env.invokedAs = os.Args[0]
		}
	}
	if env.out == nil {
		env.out = os.Stdout
	}
	if env.sys.run == nil {
		env.sys = hostdSystemDefaults()
		env.sys.unitDir = env.path(systemdUnitDir)
	}
	return env
}

// path resolves one of the absolute paths above against the environment's root.
func (env hostSetupEnv) path(p string) string { return filepath.Join(env.prefix, p) }

// sudoName is how the sudo hint names this binary: as the caller spelled it when that is a path,
// which sudo runs as it is, and otherwise by its own path, since sudo looks a bare `orbit` up only
// on its secure_path, which an account's own ~/.orbit/bin is never on.
func (env hostSetupEnv) sudoName() string {
	if strings.Contains(env.invokedAs, "/") {
		return env.invokedAs
	}
	if exe, err := env.executable(); err == nil {
		return exe
	}
	return env.invokedAs
}

// hostSetup installs the machine broker and the per-user runner template, then reloads
// systemd and starts the broker's socket. Idempotent: re-running it overwrites the same
// five files and re-issues the same three commands. Then it stops a broker still running
// from before (stopBroker) and moves each orbit-runner@<uid> left from before instances were
// named after accounts (moveUidInstances).
func hostSetup(env hostSetupEnv, server string) error {
	env = env.withDefaults()

	// Argument first, so a mistyped invocation fails before it has written anything.
	server = strings.TrimRight(server, "/")
	if server == "" {
		return errors.New("setup needs --server <url>: the control plane this host's runners register against")
	}
	if env.geteuid() != 0 {
		// The only root step in the whole design. Print the exact line to re-run rather
		// than leaving the operator to reconstruct it from the error.
		return fmt.Errorf("setup writes machine-wide systemd units and must run as root — re-run: sudo %s host setup --server %s",
			env.sudoName(), server)
	}

	exe, err := env.executable()
	if err != nil {
		return fmt.Errorf("cannot locate the orbit binary the units must run: %w", err)
	}
	if err := env.checkBinary(exe, server); err != nil {
		return err
	}
	files, err := hostSetupFiles(exe, server)
	if err != nil {
		return err
	}
	for _, f := range files {
		if err := env.writeFile(f); err != nil {
			return err
		}
	}

	// Create /run/orbit now rather than waiting for the next boot to replay tmpfiles.d,
	// so the socket below has somewhere to bind on this very run.
	if err := env.run("systemd-tmpfiles", "--create", env.path(hostdTmpfilesPath)); err != nil {
		return fmt.Errorf("systemd-tmpfiles --create %s failed: %w", env.path(hostdTmpfilesPath), err)
	}
	if err := env.run("systemctl", "daemon-reload"); err != nil {
		return errors.New("systemctl daemon-reload failed — is this a systemd host?")
	}
	if err := env.run("systemctl", "enable", "--now", hostdSocketUnit); err != nil {
		return fmt.Errorf("systemctl enable --now %s failed: %w", hostdSocketUnit, err)
	}
	// Before any move: a broker that is still running may be the earlier release's, which
	// would enable a uid instance or restart every runner on the layout setup is changing.
	if err := env.stopBroker(exe, server); err != nil {
		return err
	}

	fmt.Fprintf(env.out, "\n✓ this host is set up for Orbit runners.\n"+
		"  Broker:  %s (socket-activated; %s), running %s\n"+
		"  Runners: orbit-runner@<user>.service, one instance per Linux user,\n"+
		"           each running that user's own ~/.orbit/bin/orbit\n"+
		"  Server:  %s\n\n"+
		"  Every user on this host can now run `orbit register` without root.\n",
		hostdSocketUnit, hostdSocketPath, exe, server)

	// After the template is written and systemd has read it: a host set up before instances
	// were named after accounts still runs orbit-runner@<uid>, and each is moved now.
	// Root may have both a uid instance and a legacy unit. Drain all its older units first.
	if err := env.moveRootLegacy(exe); err != nil {
		return err
	}
	moves, err := env.moveUidInstances()
	printMoves(env.out, moves, err)
	return nil
}

// stopBroker stops a running orbit-hostd.service and confirms it down, so no broker started
// before this run — of the earlier release, say — is left serving the socket while setup moves
// runners: its enable would start an account's orbit-runner@<uid> again, and its update would
// restart every orbit-runner@* systemd lists. The socket stays enabled, so the next connection
// starts the binary the unit setup just wrote names. A broker systemd already reports down is
// left alone. One that cannot be stopped, or confirmed down, stops setup before it moves
// anything; the units are written, so running setup again finishes the job.
func (env hostSetupEnv) stopBroker(exe, server string) error {
	if st, err := env.sys.unitState(hostdServiceUnit); err == nil && st.down() {
		return nil
	}
	err := env.sys.systemctl("stop", hostdServiceUnit)
	if err == nil {
		var st hostdUnitState
		if st, err = env.sys.unitState(hostdServiceUnit); err != nil {
			err = fmt.Errorf("%s was stopped, but systemd could not be asked whether it is down: %v", hostdServiceUnit, err)
		} else if !st.down() {
			err = fmt.Errorf("%s is still up after systemctl stop: systemd reports ActiveState=%s", hostdServiceUnit, st["ActiveState"])
		}
	}
	if err == nil {
		return nil
	}
	return fmt.Errorf("setup wrote the units but moved no runner: the host broker that was running could not be confirmed down: %v.\n"+
		"It may be an earlier release's, which would act on the old layout while setup moves runners. "+
		"Stop it, and once `systemctl is-active %s` says inactive, set the host up again; that run finishes the job:\n  sudo systemctl stop %s\n  sudo %s host setup --server %s",
		err, hostdServiceUnit, hostdServiceUnit, exe, server)
}

// machineBinaryPath is the one binary the host broker runs, as root, and where setup tells
// an operator to put a root-owned copy of one that cannot be it.
const machineBinaryPath = "/usr/local/bin/orbit"

// checkBinary refuses exe — before anything is written or run — unless it is fit to be
// named in orbit-hostd.service's ExecStart=: the machine's own (checkMachineBinary, the
// rule hostd's update holds it to as well), at machineBinaryPath, which is the only binary
// the broker runs. Either way it says which part of the rule it breaks and what to run
// instead. Root's own copy in its home is one setup refuses for that reason: it is root's
// file, but it is not the machine's.
func (env hostSetupEnv) checkBinary(exe, server string) error {
	path := env.path(exe)
	err := checkMachineBinary(path, env.path("/"), env.rootUID)
	if err == nil && exe == machineBinaryPath {
		return nil
	}
	if err == nil {
		how, fix, rerun := machineCopy(path, server)
		return fmt.Errorf("refusing to set this host up with %s: the host broker runs only %s.\n"+
			"It runs as root, so it runs one binary, the root-owned copy at %s that hostd's updates replace; every account's runner runs that account's own ~/.orbit/bin/orbit instead.\n"+
			"%s\n  %s\n  %s", path, machineBinaryPath, machineBinaryPath, how, fix, rerun)
	}
	var fault *machineBinaryError
	if !errors.As(err, &fault) {
		return fmt.Errorf("cannot inspect %s, the binary the host broker would run: %w", path, err)
	}
	rerun := fmt.Sprintf("sudo %s host setup --server %s", env.sudoName(), server)
	var how, fix string
	switch {
	case exe != machineBinaryPath:
		// Another account's copy, or one in its directories — or anything else, which setup
		// would refuse next for not being the broker's one binary.
		how, fix, rerun = machineCopy(path, server)
	case fault.foreign == "":
		bits := "g-w"
		if fault.othersWrite {
			bits = "go-w"
		}
		how = "Take that write access back, then set the host up again:"
		fix = fmt.Sprintf("sudo chmod %s %s", bits, strings.Join(fault.writable, " "))
	default:
		// Already where the machine's binary belongs, only not root's.
		how = "Make it root's, then set the host up again:"
		fix = "sudo chown root:root " + fault.foreign
	}
	return fmt.Errorf("refusing to set this host up with %s: %v.\n"+
		"The host broker would run this binary as root, so no account may be able to change it: "+
		"it has to be a regular file root owns and only root can write, in directories only root can write, from its own up to /.\n"+
		"%s\n  %s\n  %s", path, fault, how, fix, rerun)
}

// machineCopy is the way out for a binary that cannot be the machine's where it is: a copy
// root owns where the machine's binary belongs, and setup run from that copy so that it is
// the one the units name.
func machineCopy(path, server string) (how, fix, rerun string) {
	return "Put a root-owned copy in place, then set the host up from it:",
		fmt.Sprintf("sudo install -o 0 -g 0 -m 0755 %s %s", path, machineBinaryPath),
		fmt.Sprintf("sudo %s host setup --server %s", machineBinaryPath, server)
}

// hostSetupFiles is the whole installation as data: the unit files, the tmpfiles.d
// entry and the machine config, with the modes they must end up with.
func hostSetupFiles(exe, server string) ([]hostFile, error) {
	config, err := json.Marshal(struct {
		Server string `json:"server"`
	}{server})
	if err != nil {
		return nil, err
	}
	return []hostFile{
		{path: hostRunnerTemplatePath, mode: 0o644, content: hostRunnerTemplate()},
		{path: hostdSocketUnitPath, mode: 0o644, content: hostdSocketUnitFile()},
		{path: hostdServiceUnitPath, mode: 0o644, content: hostdServiceUnitFile(exe)},
		{path: hostdTmpfilesPath, mode: 0o644, content: hostdTmpfilesEntry()},
		// Read only by hostd's update, as root, for the server it installs releases from.
		// 0644 all the same: it holds nothing secret, only which control plane the machine
		// belongs to.
		{path: hostConfigPath, mode: 0o644, content: string(config) + "\n"},
	}, nil
}

// writeFile installs one file, creating its directory and converging its mode. Plain
// truncate-and-write: systemd reads these on daemon-reload, not continuously.
func (env hostSetupEnv) writeFile(f hostFile) error {
	path := env.path(f.path)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("failed to create %s: %w", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(f.content), f.mode); err != nil {
		return fmt.Errorf("failed to write %s: %w", path, err)
	}
	// WriteFile leaves an existing file's mode alone, and a re-run has to converge on
	// the mode above rather than on whatever the previous version of setup — or an
	// operator halfway through debugging — left behind.
	if err := os.Chmod(path, f.mode); err != nil {
		return fmt.Errorf("failed to set the mode of %s: %w", path, err)
	}
	return nil
}

// hostRunnerTemplate is the per-user runner unit, instantiated as orbit-runner@<escaped
// user name> (unitForAccount): User=%I is the instance name unescaped, the account itself.
// Every instance runs its account's own ~/.orbit/bin/orbit, which that account's runner
// updates itself.
func hostRunnerTemplate() string {
	return `[Unit]
Description=Orbit runner (%I)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=%I
# The account's own binary, reached through $HOME: systemd sets it from the passwd entry
# of User=, and the shell, not systemd, expands it. exec leaves that binary as the main
# process, so the drain below and /proc/<pid>/exe are the runner's own.
ExecStart=/bin/sh -c 'exec "$HOME/.orbit/bin/orbit" run'
Restart=always
RestartSec=5
# Send SIGTERM to the runner only (not the claude children), so on stop/restart the
# runner can drain — finish in-flight turns and detach — before claude is torn down.
# The runner's complete shutdown envelope stays below this legacy-compatible value:
# provider drain + lease release + event flush + a racing finalization + margin.
KillMode=mixed
TimeoutStopSec=180
# An OOM kill of one process in this unit — a session's tsc, chrome or Gradle, which run in the
# runner's cgroup — must not stop the runner. systemd's default, stop, would drain and tear down
# every running turn, and the restart would install a deferred release past the turn gate.
OOMPolicy=continue
# No Environment= lines here, deliberately. One template serves every instance, and the
# home, the runner state dir and the login PATH each belong to the instance's own
# account — while the specifiers that would fill them in (%h, %s) expand in a *system*
# unit against the service manager, root, rather than against User=. Baking them in
# would therefore point every user's runner at /root. The runner works out its own
# environment at startup instead, where it knows which account it is.

[Install]
WantedBy=multi-user.target
`
}

// hostdSocketUnitFile is the broker's rendezvous point, and the only part of hostd that
// systemd keeps alive between calls.
func hostdSocketUnitFile() string {
	return fmt.Sprintf(`[Unit]
Description=Orbit host broker socket

[Socket]
ListenStream=%s
# Any local user may ask, and asking is all this is: every verb hostd offers acts on the
# caller's own runner, derived from SO_PEERCRED and never from the request body. A mode
# that let anyone connect therefore grants nobody anything they did not already have.
SocketMode=%04o

[Install]
WantedBy=sockets.target
`, hostdSocketPath, hostdSocketPerm)
}

// hostdServiceUnitFile is what the socket activates. It has no [Install] section on
// purpose: the socket owns the lifetime, and hostd exits once the machine goes quiet,
// so a replaced binary takes effect on the next connection instead of at the next
// reboot.
func hostdServiceUnitFile(exe string) string {
	return fmt.Sprintf(`[Unit]
Description=Orbit host broker
Requires=%s
After=%s

[Service]
Type=simple
ExecStart=%s hostd
`, hostdSocketUnit, hostdSocketUnit, exe)
}

// hostdTmpfilesEntry creates the socket's directory. /run is a tmpfs, so this is what
// puts it back after every boot.
func hostdTmpfilesEntry() string {
	return fmt.Sprintf("d %s 0755 root root -\n", filepath.Dir(hostdSocketPath))
}

const hostHelp = `orbit host — set this machine up for Orbit runners (once, as root)

Usage:
  orbit host setup --server <url>

Installs orbit-hostd, the root-owned broker each user's orbit talks to over
/run/orbit/host.sock, and the orbit-runner@ template: each user's runner is the
instance orbit-runner@<user name> (escaped as systemd-escape does), which runs as
that user from the user's own ~/.orbit/bin/orbit. The broker runs as root from
/usr/local/bin/orbit and from nothing else, so setup is run from a root-owned copy
there. This is the only Orbit command that needs root, and it is run once per
machine: after it, every Linux user on this host registers, restarts and updates
their own runner with no sudo anywhere.

Re-running it is safe — the same files are rewritten and systemd reloaded. On a
host set up before runners were named after accounts, it also moves each
runner instance named by a uid, whose account has its own ~/.orbit/bin/orbit, to
orbit-runner@<user name>, one at a time, and lists every account it left with the
one command that account runs.

Options:
  --server <url>           Control plane base URL this host's runners register against (required)
`

func cmdHostCLI(args []string, out io.Writer) error {
	if len(args) == 0 || wantsHelp(args) {
		_, err := fmt.Fprint(out, hostHelp)
		return err
	}
	switch args[0] {
	case "setup":
		if runtime.GOOS != "linux" {
			return errors.New("setup installs systemd units, so it applies to Linux hosts only")
		}
		fs := newCLIFlagSet("orbit host setup")
		server := fs.String("server", "", "control plane base URL this host's runners register against")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		if err := rejectTrailing(fs); err != nil {
			return err
		}
		return hostSetup(hostSetupEnv{out: out}, *server)
	default:
		return fmt.Errorf("unknown action %q (try: orbit host setup --server <url>)", args[0])
	}
}
