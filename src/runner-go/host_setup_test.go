package main

import (
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// A recording stand-in for the three external commands setup issues.
type fakeHostRunner struct {
	calls []string
}

func (f *fakeHostRunner) run(name string, args ...string) error {
	f.calls = append(f.calls, strings.Join(append([]string{name}, args...), " "))
	return nil
}

// testHostEnv is setup pointed at a temporary root, running as a fake euid, with every
// command recorded instead of executed.
func testHostEnv(t *testing.T, euid int) (hostSetupEnv, *fakeHostRunner, string) {
	t.Helper()
	root := t.TempDir()
	// It stands for /, which every account can enter; t.TempDir() makes it 0700.
	chmod(t, root, 0o755)
	cmds := &fakeHostRunner{}
	return hostSetupEnv{
		prefix:     root,
		geteuid:    func() int { return euid },
		executable: func() (string, error) { return "/usr/local/bin/orbit", nil },
		run:        cmds.run,
		invokedAs:  "orbit",
		out:        io.Discard,
		// The files this test creates are its own; they stand for root's.
		rootUID: uint32(os.Geteuid()),
	}, cmds, root
}

// placeBinary puts a binary at path — a machine path, written under root — as the
// machine's own: a regular file the uid standing for root owns, mode 0755, in directories
// only that uid can write. The modes are set explicitly, so the umask the suite runs under
// cannot make any of it group-writable.
func placeBinary(t *testing.T, root, path string) string {
	t.Helper()
	full := filepath.Join(root, path)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	for p := full; p != root; p = filepath.Dir(p) {
		if err := os.Chmod(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return full
}

// unitDirectives is what systemd actually reads: the file with comments and blank lines
// dropped. The units carry long comments explaining why each value is what it is, and a
// golden that pinned those too would break on a reworded sentence while saying nothing
// about the installation itself.
func unitDirectives(content string) []string {
	var out []string
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		out = append(out, line)
	}
	return out
}

func readInstalled(t *testing.T, root, path string) (string, fs.FileMode) {
	t.Helper()
	full := filepath.Join(root, path)
	b, err := os.ReadFile(full)
	if err != nil {
		t.Fatalf("setup did not install %s: %v", path, err)
	}
	info, err := os.Stat(full)
	if err != nil {
		t.Fatal(err)
	}
	return string(b), info.Mode().Perm()
}

func assertDirectives(t *testing.T, path, content string, want []string) {
	t.Helper()
	got := unitDirectives(content)
	if len(got) != len(want) {
		t.Fatalf("%s has %d directives, want %d:\ngot:  %q\nwant: %q", path, len(got), len(want), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("%s directive %d = %q, want %q", path, i, got[i], want[i])
		}
	}
}

// The installed files are the whole deliverable of `orbit host setup`: pin every
// directive systemd will read, since a wrong one is not a crash but a machine that
// quietly runs every user's runner as the wrong account, or not at all.
func TestHostSetupInstallsTheUnitsSystemdWillRead(t *testing.T) {
	env, cmds, root := testHostEnv(t, 0)
	placeBinary(t, root, machineBinaryPath)

	if err := hostSetup(env, "https://orbit.example.com"); err != nil {
		t.Fatalf("setup as root failed: %v", err)
	}

	template, mode := readInstalled(t, root, hostRunnerTemplatePath)
	if mode != 0o644 {
		t.Errorf("%s installed %04o, want 0644", hostRunnerTemplatePath, mode)
	}
	assertDirectives(t, hostRunnerTemplatePath, template, []string{
		"[Unit]",
		"Description=Orbit runner (uid %i)",
		"After=network-online.target",
		"Wants=network-online.target",
		"[Service]",
		"Type=simple",
		// The instance key is the uid, so %i names the account itself.
		"User=%i",
		"ExecStart=/usr/local/bin/orbit run",
		"Restart=always",
		"RestartSec=5",
		// The drain envelope, identical to the unit installSystemd writes.
		"KillMode=mixed",
		"TimeoutStopSec=180",
		"[Install]",
		"WantedBy=multi-user.target",
	})

	socket, mode := readInstalled(t, root, hostdSocketUnitPath)
	if mode != 0o644 {
		t.Errorf("%s installed %04o, want 0644", hostdSocketUnitPath, mode)
	}
	assertDirectives(t, hostdSocketUnitPath, socket, []string{
		"[Unit]",
		"Description=Orbit host broker socket",
		"[Socket]",
		"ListenStream=/run/orbit/host.sock",
		// Safe only because every verb is reflexive — hostd reads the target from
		// SO_PEERCRED, never from the request body.
		"SocketMode=0666",
		"[Install]",
		"WantedBy=sockets.target",
	})

	service, mode := readInstalled(t, root, hostdServiceUnitPath)
	if mode != 0o644 {
		t.Errorf("%s installed %04o, want 0644", hostdServiceUnitPath, mode)
	}
	assertDirectives(t, hostdServiceUnitPath, service, []string{
		"[Unit]",
		"Description=Orbit host broker",
		"Requires=orbit-hostd.socket",
		"After=orbit-hostd.socket",
		"[Service]",
		"Type=simple",
		"ExecStart=/usr/local/bin/orbit hostd",
	})
	// No [Install]: the socket owns hostd's lifetime, so enabling the service itself
	// would defeat the socket activation the whole design rests on.
	if strings.Contains(service, "[Install]") {
		t.Errorf("%s must not be enablable on its own:\n%s", hostdServiceUnitPath, service)
	}

	tmpfiles, mode := readInstalled(t, root, hostdTmpfilesPath)
	if mode != 0o644 {
		t.Errorf("%s installed %04o, want 0644", hostdTmpfilesPath, mode)
	}
	if tmpfiles != "d /run/orbit 0755 root root -\n" {
		t.Errorf("%s = %q, want the socket directory entry", hostdTmpfilesPath, tmpfiles)
	}

	config, mode := readInstalled(t, root, hostConfigPath)
	if mode != 0o644 {
		t.Errorf("%s installed %04o, want 0644 (every uid reads it)", hostConfigPath, mode)
	}
	if config != "{\"server\":\"https://orbit.example.com\"}\n" {
		t.Errorf("%s = %q, want the machine's control plane", hostConfigPath, config)
	}
	var parsed struct {
		Server string `json:"server"`
	}
	if err := json.Unmarshal([]byte(config), &parsed); err != nil || parsed.Server != "https://orbit.example.com" {
		t.Errorf("%s does not decode to the server that was passed: %q (%v)", hostConfigPath, config, err)
	}

	want := []string{
		"systemd-tmpfiles --create " + filepath.Join(root, hostdTmpfilesPath),
		"systemctl daemon-reload",
		"systemctl enable --now orbit-hostd.socket",
	}
	if strings.Join(cmds.calls, "\n") != strings.Join(want, "\n") {
		t.Errorf("command sequence:\ngot:  %q\nwant: %q", cmds.calls, want)
	}
}

// The template is one file shared by every instance, and a system unit's %h/%s expand to
// the service *manager's* home and shell — root's — not to the User= account's. Baking
// an environment in here would therefore point every user's runner at /root; the runner
// resolves its own at startup, where it knows which account it is.
func TestHostRunnerTemplateBakesInNoEnvironment(t *testing.T) {
	for _, directive := range unitDirectives(hostRunnerTemplate("/usr/local/bin/orbit")) {
		if strings.HasPrefix(directive, "Environment") {
			t.Errorf("the template must carry no baked environment, found %q", directive)
		}
		for _, specifier := range []string{"%h", "%s", "%S", "%E"} {
			if strings.Contains(directive, specifier) {
				t.Errorf("%q uses %s, which a system unit expands against the manager, not User=", directive, specifier)
			}
		}
	}
	// The three the runner needs, named explicitly: this is the invariant T4 depends on.
	for _, name := range []string{"HOME", "ORBIT_HOME", "PATH"} {
		if strings.Contains(hostRunnerTemplate("/usr/local/bin/orbit"), "Environment="+name) {
			t.Errorf("the template must not bake %s; the runner resolves it at startup", name)
		}
	}
}

// Setup is the one command in this design that needs root, so a non-root run has to end
// with the exact line to re-run — not a diagnosis the operator has to translate.
func TestHostSetupWithoutRootNamesTheSudoCommand(t *testing.T) {
	env, cmds, root := testHostEnv(t, 1000)

	err := hostSetup(env, "https://orbit.example.com")
	if err == nil {
		t.Fatal("setup as a non-root user must fail")
	}
	if !strings.Contains(err.Error(), "sudo orbit host setup") {
		t.Errorf("the error must name the command to re-run, got: %v", err)
	}
	if !strings.Contains(err.Error(), "--server https://orbit.example.com") {
		t.Errorf("the re-run line must carry the arguments back, got: %v", err)
	}
	if installed := installedFiles(t, root); len(installed) != 0 {
		t.Errorf("a refused setup must write nothing, found %v", installed)
	}
	if len(cmds.calls) != 0 {
		t.Errorf("a refused setup must run nothing, ran %v", cmds.calls)
	}
}

// One machine, one setup — but "run it again with the right --server" has to work, so
// every file converges on its intended content and mode no matter what it replaces.
func TestHostSetupIsIdempotent(t *testing.T) {
	env, cmds, root := testHostEnv(t, 0)
	placeBinary(t, root, machineBinaryPath)

	// A previous release's unit, and a config left readable only by root.
	stale := filepath.Join(root, hostRunnerTemplatePath)
	if err := os.MkdirAll(filepath.Dir(stale), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stale, []byte("[Service]\nExecStart=/opt/old/orbit run\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(root, hostConfigPath)
	if err := os.MkdirAll(filepath.Dir(config), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config, []byte(`{"server":"https://old.example.com"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 2; i++ {
		if err := hostSetup(env, "https://orbit.example.com"); err != nil {
			t.Fatalf("run %d failed: %v", i+1, err)
		}
	}

	template, mode := readInstalled(t, root, hostRunnerTemplatePath)
	if strings.Contains(template, "/opt/old/orbit") {
		t.Errorf("a re-run must replace the stale unit, got:\n%s", template)
	}
	if !strings.Contains(template, "ExecStart=/usr/local/bin/orbit run") {
		t.Errorf("a re-run must name this binary, got:\n%s", template)
	}
	if mode != 0o644 {
		t.Errorf("a re-run must fix the mode of %s, got %04o", hostRunnerTemplatePath, mode)
	}
	newConfig, mode := readInstalled(t, root, hostConfigPath)
	if newConfig != "{\"server\":\"https://orbit.example.com\"}\n" {
		t.Errorf("a re-run must move the host to the new control plane, got %q", newConfig)
	}
	if mode != 0o644 {
		t.Errorf("a re-run must fix the mode of %s, got %04o", hostConfigPath, mode)
	}

	// Both runs reload systemd and (re-)enable the socket: the second run is what an
	// operator does after replacing the binary, and it has to leave the machine live.
	want := []string{
		"systemd-tmpfiles --create " + filepath.Join(root, hostdTmpfilesPath),
		"systemctl daemon-reload",
		"systemctl enable --now orbit-hostd.socket",
	}
	want = append(want, want...)
	if strings.Join(cmds.calls, "\n") != strings.Join(want, "\n") {
		t.Errorf("command sequence over two runs:\ngot:  %q\nwant: %q", cmds.calls, want)
	}
	if last := cmds.calls[len(cmds.calls)-1]; last != "systemctl enable --now orbit-hostd.socket" {
		t.Errorf("setup must finish by starting the broker, ended with %q", last)
	}
}

// The server is written into /etc/orbit/config.json, which every later update reads, so
// a run that forgot it must not leave a half-installed machine behind.
func TestHostSetupWithoutServerWritesNothing(t *testing.T) {
	env, cmds, root := testHostEnv(t, 0)

	err := hostSetup(env, "")
	if err == nil {
		t.Fatal("setup without --server must fail")
	}
	if !strings.Contains(err.Error(), "--server") {
		t.Errorf("the error must name the missing flag, got: %v", err)
	}
	if installed := installedFiles(t, root); len(installed) != 0 {
		t.Errorf("setup must write nothing before it has a server, found %v", installed)
	}
	if len(cmds.calls) != 0 {
		t.Errorf("setup must run nothing before it has a server, ran %v", cmds.calls)
	}
}

// Every account's runner runs the binary setup names in ExecStart=, and the broker runs it
// as root, so setup refuses one that any account could change — before it writes or runs
// anything — saying which part of the rule it breaks and what to run instead.
func TestHostSetupRefusesABinaryAnAccountCouldChange(t *testing.T) {
	notRoot := uint32(os.Geteuid()) + 1
	for _, tc := range []struct {
		name    string
		arrange func(t *testing.T, env *hostSetupEnv, root string)
		// What the error must say. {root} is the directory standing in for /, {uid} the
		// uid that owns every file the test creates.
		want []string
	}{{
		name: "owned by an account",
		arrange: func(t *testing.T, env *hostSetupEnv, root string) {
			placeBinary(t, root, machineBinaryPath)
			// The test cannot chown its files to someone else, so it says root is someone else.
			env.rootUID = notRoot
		},
		want: []string{
			"refusing to set this host up with {root}/usr/local/bin/orbit: it belongs to uid {uid} rather than root.\n",
			"\nMake it root's, then set the host up again:\n" +
				"  sudo chown root:root {root}/usr/local/bin/orbit\n" +
				"  sudo orbit host setup --server https://orbit.example.com",
		},
	}, {
		name: "a link into an account's ~/.orbit/bin, as the installer leaves it",
		arrange: func(t *testing.T, env *hostSetupEnv, root string) {
			own := placeBinary(t, root, "/home/alice/.orbit/bin/orbit")
			link := filepath.Join(root, machineBinaryPath)
			if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(own, link); err != nil {
				t.Fatal(err)
			}
			realRoot, err := filepath.EvalSymlinks(root)
			if err != nil {
				t.Fatal(err)
			}
			// What resolvedExecutable reports when `sudo orbit` runs through the link: the
			// file it leads to, which is what the units would run.
			env.executable = func() (string, error) {
				resolved, err := filepath.EvalSymlinks(link)
				return strings.TrimPrefix(resolved, realRoot), err
			}
			env.rootUID = notRoot
		},
		want: []string{
			"refusing to set this host up with {root}/home/alice/.orbit/bin/orbit: it belongs to uid {uid} rather than root.\n",
			"\nPut a root-owned copy in place, then set the host up from it:\n" +
				"  sudo install -o 0 -g 0 -m 0755 {root}/home/alice/.orbit/bin/orbit /usr/local/bin/orbit\n" +
				"  sudo /usr/local/bin/orbit host setup --server https://orbit.example.com",
		},
	}, {
		// The binary that is running is always a regular file, so this is the rule holding
		// where setup cannot meet anything else; hostd's update can.
		name: "not a regular file",
		arrange: func(t *testing.T, env *hostSetupEnv, root string) {
			if err := os.MkdirAll(filepath.Join(root, "/opt/orbit"), 0o755); err != nil {
				t.Fatal(err)
			}
			chmod(t, filepath.Join(root, "/opt"), 0o755)
			env.executable = func() (string, error) { return "/opt/orbit", nil }
		},
		want: []string{
			"refusing to set this host up with {root}/opt/orbit: it is not a regular file.\n",
			"\nPut a root-owned copy in place, then set the host up from it:\n",
			"\n  sudo /usr/local/bin/orbit host setup --server https://orbit.example.com",
		},
	}, {
		name: "a directory its group can write",
		arrange: func(t *testing.T, env *hostSetupEnv, root string) {
			placeBinary(t, root, machineBinaryPath)
			chmod(t, filepath.Join(root, "/usr/local/bin"), 0o775)
		},
		want: []string{
			"refusing to set this host up with {root}/usr/local/bin/orbit: its directory {root}/usr/local/bin is not root's alone (owned by uid {uid}, mode 0775).\n",
			"\nTake that write access back, then set the host up again:\n" +
				"  sudo chmod g-w {root}/usr/local/bin\n" +
				"  sudo orbit host setup --server https://orbit.example.com",
		},
	}, {
		name: "a directory others can write",
		arrange: func(t *testing.T, env *hostSetupEnv, root string) {
			placeBinary(t, root, machineBinaryPath)
			chmod(t, filepath.Join(root, "/usr/local/bin"), 0o757)
		},
		want: []string{
			": its directory {root}/usr/local/bin is not root's alone (owned by uid {uid}, mode 0757).\n",
			"\n  sudo chmod go-w {root}/usr/local/bin\n",
		},
	}, {
		name: "a directory further up its group can write",
		arrange: func(t *testing.T, env *hostSetupEnv, root string) {
			placeBinary(t, root, machineBinaryPath)
			chmod(t, filepath.Join(root, "/usr/local"), 0o775)
		},
		want: []string{
			": {root}/usr/local, a directory above it, is not root's alone (owned by uid {uid}, mode 0775).\n",
			"\n  sudo chmod g-w {root}/usr/local\n",
		},
	}, {
		// Root's own file, but whoever owns a directory above it can swap out everything below.
		name: "under a directory further up an account owns",
		arrange: func(t *testing.T, env *hostSetupEnv, root string) {
			placeBinary(t, root, "/opt/orbit/bin/orbit")
			chownToAnAccount(t, filepath.Join(root, "/opt/orbit"))
			env.executable = func() (string, error) { return "/opt/orbit/bin/orbit", nil }
		},
		want: []string{
			"refusing to set this host up with {root}/opt/orbit/bin/orbit: {root}/opt/orbit, a directory above it, is not root's alone (owned by uid {account}, mode 0755).\n",
			"\nPut a root-owned copy in place, then set the host up from it:\n" +
				"  sudo install -o 0 -g 0 -m 0755 {root}/opt/orbit/bin/orbit /usr/local/bin/orbit\n" +
				"  sudo /usr/local/bin/orbit host setup --server https://orbit.example.com",
		},
	}, {
		name: "every such directory at once, as older Debian has /usr/local and /usr/local/bin",
		arrange: func(t *testing.T, env *hostSetupEnv, root string) {
			placeBinary(t, root, machineBinaryPath)
			// root:staff 2775: the setgid bit is no write access, and the mode reported leaves it out.
			chmod(t, filepath.Join(root, "/usr/local"), os.ModeSetgid|0o775)
			chmod(t, filepath.Join(root, "/usr/local/bin"), os.ModeSetgid|0o775)
		},
		want: []string{
			": its directory {root}/usr/local/bin is not root's alone (owned by uid {uid}, mode 0775); {root}/usr/local, a directory above it, is not root's alone (owned by uid {uid}, mode 0775).\n",
			"\n  sudo chmod g-w {root}/usr/local/bin {root}/usr/local\n",
		},
	}, {
		name: "a binary its group can write",
		arrange: func(t *testing.T, env *hostSetupEnv, root string) {
			chmod(t, placeBinary(t, root, machineBinaryPath), 0o775)
		},
		want: []string{
			"refusing to set this host up with {root}/usr/local/bin/orbit: its group or others can write it (mode 0775).\n",
			"\n  sudo chmod g-w {root}/usr/local/bin/orbit\n",
		},
	}, {
		name: "a binary anyone can write",
		arrange: func(t *testing.T, env *hostSetupEnv, root string) {
			chmod(t, placeBinary(t, root, machineBinaryPath), 0o777)
		},
		want: []string{
			": its group or others can write it (mode 0777).\n",
			"\n  sudo chmod go-w {root}/usr/local/bin/orbit\n",
		},
	}, {
		// Never `chmod go-w /tmp`: a directory every account may write is no place for it.
		name: "in a sticky directory anyone may write, like /tmp",
		arrange: func(t *testing.T, env *hostSetupEnv, root string) {
			placeBinary(t, root, "/tmp/orbit")
			chmod(t, filepath.Join(root, "/tmp"), os.ModeSticky|0o777)
			env.executable = func() (string, error) { return "/tmp/orbit", nil }
		},
		want: []string{
			"refusing to set this host up with {root}/tmp/orbit: its directory {root}/tmp is a shared directory anyone can write (mode 1777).\n",
			"\n  sudo install -o 0 -g 0 -m 0755 {root}/tmp/orbit /usr/local/bin/orbit\n" +
				"  sudo /usr/local/bin/orbit host setup --server https://orbit.example.com",
		},
	}} {
		t.Run(tc.name, func(t *testing.T) {
			env, cmds, root := testHostEnv(t, 0)
			tc.arrange(t, &env, root)
			before := installedFiles(t, root)

			err := hostSetup(env, "https://orbit.example.com")
			if err == nil {
				t.Fatal("setup accepted a binary an account could change")
			}
			fill := strings.NewReplacer("{root}", root, "{uid}", strconv.Itoa(os.Geteuid()), "{account}", strconv.Itoa(hostSetupChildUID))
			for _, want := range tc.want {
				if want = fill.Replace(want); !strings.Contains(err.Error(), want) {
					t.Errorf("the error must say %q, got:\n%v", want, err)
				}
			}
			// Refused before it began: not one file written, not one command run.
			if after := installedFiles(t, root); strings.Join(after, "\n") != strings.Join(before, "\n") {
				t.Errorf("a refused setup wrote files:\nbefore: %v\nafter:  %v", before, after)
			}
			if len(cmds.calls) != 0 {
				t.Errorf("a refused setup must run nothing, ran %v", cmds.calls)
			}
		})
	}
}

// What `chmod g-w` leaves behind — older Debian's directories keep their setgid bit — is
// root's alone, so the fix setup names for them is one it then accepts.
func TestHostSetupAcceptsDirectoriesOnceTheirGroupCannotWrite(t *testing.T) {
	env, cmds, root := testHostEnv(t, 0)
	placeBinary(t, root, machineBinaryPath)
	dirs := []string{filepath.Join(root, "/usr/local"), filepath.Join(root, "/usr/local/bin")}
	for _, dir := range dirs {
		chmod(t, dir, os.ModeSetgid|0o775)
	}
	if err := hostSetup(env, "https://orbit.example.com"); err == nil {
		t.Fatal("setup accepted directories the staff group can write")
	}

	for _, dir := range dirs {
		chmod(t, dir, os.ModeSetgid|0o755)
	}
	if err := hostSetup(env, "https://orbit.example.com"); err != nil {
		t.Fatalf("setup refused directories only root can write: %v", err)
	}
	if template, _ := readInstalled(t, root, hostRunnerTemplatePath); !strings.Contains(template, "ExecStart=/usr/local/bin/orbit run\n") {
		t.Errorf("the template does not run the machine's binary:\n%s", template)
	}
	if last := cmds.calls[len(cmds.calls)-1]; last != "systemctl enable --now orbit-hostd.socket" {
		t.Errorf("setup must finish by starting the broker, ended with %q", last)
	}
}

// Every account's runner runs the binary setup names in ExecStart= as that account, so setup
// also refuses one other accounts cannot execute — root's own copy above all, which install.sh
// puts in root's 0700 home — before it writes or runs anything, naming every level closed to
// others and what to run instead.
func TestHostSetupRefusesABinaryOtherAccountsCannotExecute(t *testing.T) {
	for _, tc := range []struct {
		name    string
		arrange func(t *testing.T, env *hostSetupEnv, root string)
		// What the error must say. {root} is the directory standing in for /.
		want []string
	}{{
		name: "in /root, which others cannot enter",
		arrange: func(t *testing.T, env *hostSetupEnv, root string) {
			placeBinary(t, root, "/root/.orbit/bin/orbit")
			chmod(t, filepath.Join(root, "/root"), 0o700)
			env.executable = func() (string, error) { return "/root/.orbit/bin/orbit", nil }
		},
		want: []string{
			"refusing to set this host up with {root}/root/.orbit/bin/orbit: {root}/root, a directory above it, cannot be entered by others (mode 0700).\n",
			"\nPut a root-owned copy in place, then set the host up from it:\n" +
				"  sudo install -o 0 -g 0 -m 0755 {root}/root/.orbit/bin/orbit /usr/local/bin/orbit\n" +
				"  sudo /usr/local/bin/orbit host setup --server https://orbit.example.com",
		},
	}, {
		name: "root's own copy, as install.sh leaves it",
		arrange: func(t *testing.T, env *hostSetupEnv, root string) {
			// mktemp's 0600 made executable, in a ~/.orbit made 0700, in /root.
			chmod(t, placeBinary(t, root, "/root/.orbit/bin/orbit"), 0o711)
			chmod(t, filepath.Join(root, "/root/.orbit"), 0o700)
			chmod(t, filepath.Join(root, "/root"), 0o700)
			env.executable = func() (string, error) { return "/root/.orbit/bin/orbit", nil }
		},
		want: []string{
			"refusing to set this host up with {root}/root/.orbit/bin/orbit: {root}/root/.orbit, a directory above it, cannot be entered by others (mode 0700); " +
				"{root}/root, a directory above it, cannot be entered by others (mode 0700).\n",
			"\n  sudo install -o 0 -g 0 -m 0755 {root}/root/.orbit/bin/orbit /usr/local/bin/orbit\n" +
				"  sudo /usr/local/bin/orbit host setup --server https://orbit.example.com",
		},
	}, {
		name: "a binary others cannot execute",
		arrange: func(t *testing.T, env *hostSetupEnv, root string) {
			chmod(t, placeBinary(t, root, "/opt/orbit/orbit"), 0o750)
			env.executable = func() (string, error) { return "/opt/orbit/orbit", nil }
		},
		want: []string{
			"refusing to set this host up with {root}/opt/orbit/orbit: others cannot execute it (mode 0750).\n",
			"\nPut a root-owned copy in place, then set the host up from it:\n" +
				"  sudo install -o 0 -g 0 -m 0755 {root}/opt/orbit/orbit /usr/local/bin/orbit\n" +
				"  sudo /usr/local/bin/orbit host setup --server https://orbit.example.com",
		},
	}, {
		// Already where the machine's binary belongs, where a copy would land on itself.
		name: "the machine's binary, which others cannot execute",
		arrange: func(t *testing.T, env *hostSetupEnv, root string) {
			chmod(t, placeBinary(t, root, machineBinaryPath), 0o700)
		},
		want: []string{
			"refusing to set this host up with {root}/usr/local/bin/orbit: others cannot execute it (mode 0700).\n",
			"\nLet every account run it, then set the host up again:\n" +
				"  sudo chmod o+x {root}/usr/local/bin/orbit\n" +
				"  sudo orbit host setup --server https://orbit.example.com",
		},
	}, {
		name: "the machine's binary in a directory others cannot enter",
		arrange: func(t *testing.T, env *hostSetupEnv, root string) {
			placeBinary(t, root, machineBinaryPath)
			chmod(t, filepath.Join(root, "/usr/local/bin"), 0o750)
		},
		want: []string{
			"refusing to set this host up with {root}/usr/local/bin/orbit: its directory {root}/usr/local/bin cannot be entered by others (mode 0750).\n",
			"\n  sudo chmod o+x {root}/usr/local/bin\n" +
				"  sudo orbit host setup --server https://orbit.example.com",
		},
	}} {
		t.Run(tc.name, func(t *testing.T) {
			env, cmds, root := testHostEnv(t, 0)
			tc.arrange(t, &env, root)
			before := installedFiles(t, root)

			err := hostSetup(env, "https://orbit.example.com")
			if err == nil {
				t.Fatal("setup accepted a binary other accounts cannot execute")
			}
			fill := strings.NewReplacer("{root}", root)
			for _, want := range tc.want {
				if want = fill.Replace(want); !strings.Contains(err.Error(), want) {
					t.Errorf("the error must say %q, got:\n%v", want, err)
				}
			}
			// Refused before it began: not one file written, not one command run.
			if after := installedFiles(t, root); strings.Join(after, "\n") != strings.Join(before, "\n") {
				t.Errorf("a refused setup wrote files:\nbefore: %v\nafter:  %v", before, after)
			}
			if len(cmds.calls) != 0 {
				t.Errorf("a refused setup must run nothing, ran %v", cmds.calls)
			}
		})
	}
}

func chmod(t *testing.T, path string, mode os.FileMode) {
	t.Helper()
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

// chownToAnAccount gives the directory at path to an unprivileged account, while the
// file below it stays the suite's own. Only root can, so a suite running unprivileged
// skips the case rather than fake an owner: the point is that the walk reads the real one.
func chownToAnAccount(t *testing.T, path string) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("giving a directory to another account takes root")
	}
	if err := os.Chown(path, hostSetupChildUID, hostSetupChildGID); err != nil {
		t.Fatal(err)
	}
}

// `orbit host` with no action, and with --help, answers with its help rather than
// installing anything.
func TestHostCLIWithoutAnActionPrintsHelp(t *testing.T) {
	for _, args := range [][]string{nil, {"--help"}, {"setup", "--help"}} {
		var out strings.Builder
		if err := cmdHostCLI(args, &out); err != nil {
			t.Fatalf("orbit host %v: %v", args, err)
		}
		if !strings.Contains(out.String(), "orbit host setup --server") {
			t.Errorf("orbit host %v printed %q, want the usage line", args, out.String())
		}
	}
	var out strings.Builder
	if err := cmdHostCLI([]string{"teardown"}, &out); err == nil {
		t.Error("an unknown action must be refused, not silently treated as setup")
	}
}

// Every test here drives setup through a temporary root, so pin the seam itself: with no
// prefix — how the CLI calls it — the paths are the machine's own.
func TestHostSetupWithoutAPrefixWritesTheMachinesOwnPaths(t *testing.T) {
	env := hostSetupEnv{}.withDefaults()
	for _, path := range []string{
		hostRunnerTemplatePath, hostdSocketUnitPath, hostdServiceUnitPath,
		hostdTmpfilesPath, hostConfigPath,
	} {
		if got := env.path(path); got != path {
			t.Errorf("path(%q) = %q, want the machine's own path", path, got)
		}
	}
}

// installedFiles lists every file setup left under a temporary root.
func installedFiles(t *testing.T, root string) []string {
	t.Helper()
	var found []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			rel, _ := filepath.Rel(root, path)
			found = append(found, string(filepath.Separator)+rel)
		}
		return nil
	})
	if err != nil {
		t.Fatal(fmt.Errorf("walking %s: %w", root, err))
	}
	return found
}
