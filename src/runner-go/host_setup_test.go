package main

import (
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
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
	cmds := &fakeHostRunner{}
	return hostSetupEnv{
		prefix:     root,
		geteuid:    func() int { return euid },
		executable: func() (string, error) { return "/usr/local/bin/orbit", nil },
		run:        cmds.run,
		invokedAs:  "orbit",
		out:        io.Discard,
	}, cmds, root
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
