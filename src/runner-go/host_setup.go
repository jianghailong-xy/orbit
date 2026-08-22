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
// once per machine. It installs the machine broker (orbit-hostd, socket-activated) and
// the orbit-runner@<uid> template each user's runner is an instance of. Everything a
// user does afterwards — register, unregister, restart, update — goes through the
// broker's socket and needs no sudo at all.

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

	hostdSocketUnit = "orbit-hostd.socket"
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
	// invokedAs is how the caller spelled this binary, echoed back in the sudo hint so
	// the line they are told to re-run is the line they just typed.
	invokedAs string
	out       io.Writer
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
	return env
}

// path resolves one of the absolute paths above against the environment's root.
func (env hostSetupEnv) path(p string) string { return filepath.Join(env.prefix, p) }

// hostSetup installs the machine broker and the per-user runner template, then reloads
// systemd and starts the broker's socket. Idempotent: re-running it overwrites the same
// five files and re-issues the same three commands.
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
			env.invokedAs, server)
	}

	exe, err := env.executable()
	if err != nil {
		return fmt.Errorf("cannot locate the orbit binary the units must run: %w", err)
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

	fmt.Fprintf(env.out, "\n✓ this host is set up for Orbit runners.\n"+
		"  Broker:  %s (socket-activated; %s)\n"+
		"  Runners: orbit-runner@<uid>.service, one instance per Linux user\n"+
		"  Server:  %s\n\n"+
		"  Every user on this host can now run `orbit register` without root.\n",
		hostdSocketUnit, hostdSocketPath, server)
	return nil
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
		{path: hostRunnerTemplatePath, mode: 0o644, content: hostRunnerTemplate(exe)},
		{path: hostdSocketUnitPath, mode: 0o644, content: hostdSocketUnitFile()},
		{path: hostdServiceUnitPath, mode: 0o644, content: hostdServiceUnitFile(exe)},
		{path: hostdTmpfilesPath, mode: 0o644, content: hostdTmpfilesEntry()},
		// 0644: hostd is root, but a user's `orbit register` reads this to learn which
		// control plane the machine belongs to.
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

// hostRunnerTemplate is the per-user runner unit, instantiated as orbit-runner@<uid>.
// The instance key is the uid, so User=%i is the account itself — see unitForUid for
// why a username cannot be used.
func hostRunnerTemplate(exe string) string {
	return fmt.Sprintf(`[Unit]
Description=Orbit runner (uid %%i)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=%%i
ExecStart=%s run
Restart=always
RestartSec=5
# Send SIGTERM to the runner only (not the claude children), so on stop/restart the
# runner can drain — finish in-flight turns and detach — before claude is torn down.
# The runner's complete shutdown envelope stays below this legacy-compatible value:
# provider drain + lease release + event flush + a racing finalization + margin.
KillMode=mixed
TimeoutStopSec=180
# No Environment= lines here, deliberately. One template serves every instance, and the
# home, the runner state dir and the login PATH each belong to the instance's own
# account — while the specifiers that would fill them in (%%h, %%s) expand in a *system*
# unit against the service manager, root, rather than against User=. Baking them in
# would therefore point every user's runner at /root. The runner works out its own
# environment at startup instead, where it knows which account it is.

[Install]
WantedBy=multi-user.target
`, exe)
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
/run/orbit/host.sock, and the orbit-runner@<uid> template their runners are instances
of. This is the only Orbit command that needs root, and it is run once per machine:
after it, every Linux user on this host registers, restarts and updates their own
runner with no sudo anywhere.

Re-running it is safe — the same files are rewritten and systemd reloaded.

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
