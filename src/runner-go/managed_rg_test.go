package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const fakeRgTarget = "x86_64-unknown-linux-musl"

// fakeRgArchive is a release archive laid out as ripgrep's are: one top directory holding rg, the licence files, a
// README and doc/ and complete/ directories. rgScript is rg's body; "" leaves rg out.
func fakeRgArchive(t *testing.T, rgScript string) []byte {
	t.Helper()
	top := "ripgrep-" + managedRgVersion + "-" + fakeRgTarget
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	add := func(name string, mode int64, body string, kind byte) {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: mode, Size: int64(len(body)), Typeflag: kind}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	add(top+"/", 0o755, "", tar.TypeDir)
	add(top+"/doc/", 0o755, "", tar.TypeDir)
	add(top+"/doc/rg.1", 0o644, "manual", tar.TypeReg)
	add(top+"/complete/", 0o755, "", tar.TypeDir)
	add(top+"/complete/rg.bash", 0o644, "completion", tar.TypeReg)
	add(top+"/README.md", 0o644, "readme", tar.TypeReg)
	for _, licence := range []string{"COPYING", "LICENSE-MIT", "UNLICENSE"} {
		add(top+"/"+licence, 0o644, licence+" text", tar.TypeReg)
	}
	if rgScript != "" {
		add(top+"/rg", 0o755, "#!/bin/sh\n"+rgScript+"\n", tar.TypeReg)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// managedRgRig is a runner of a pinned platform in a home of its own, fetching its ripgrep from a server that
// serves served at the pinned archive's URL and counts the requests.
type managedRgRig struct {
	served   atomic.Pointer[[]byte]
	requests atomic.Int32
}

// newManagedRgRig pins pinned as the platform's archive and serves served for it.
func newManagedRgRig(t *testing.T, pinned, served []byte) *managedRgRig {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	rig := &managedRgRig{}
	rig.serve(served)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rig.requests.Add(1)
		served := rig.served.Load()
		if r.URL.Path != "/"+managedRgVersion+"/ripgrep-"+managedRgVersion+"-"+fakeRgTarget+".tar.gz" || *served == nil {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(*served)
	}))
	t.Cleanup(server.Close)
	sum := sha256.Sum256(pinned)
	builds, base, goos, arch := managedRgBuilds, managedRgDownloadBase, managedRgOS, managedRgArch
	t.Cleanup(func() {
		managedRgBuilds, managedRgDownloadBase, managedRgOS, managedRgArch = builds, base, goos, arch
	})
	managedRgBuilds = map[string]managedRgBuild{
		"linux/amd64": {target: fakeRgTarget, sha256: hex.EncodeToString(sum[:]), size: int64(len(pinned))},
	}
	managedRgDownloadBase, managedRgOS, managedRgArch = server.URL, "linux", "amd64"
	return rig
}

// serve makes the server answer the archive's URL with archive, or 404 for nil.
func (rig *managedRgRig) serve(archive []byte) { rig.served.Store(&archive) }

func dirNames(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

// The pinned archive is downloaded once, checked and published as a version directory holding rg and its licence
// and nothing else of the archive; managedRgPath names that rg from then on, and installing again downloads nothing.
func TestManagedRgInstallsThePinnedBuild(t *testing.T) {
	archive := fakeRgArchive(t, "echo 'ripgrep "+managedRgVersion+" (rev test)'")
	rig := newManagedRgRig(t, archive, archive)
	if _, err := managedRgPath(); !errors.Is(err, errManagedRgMissing) {
		t.Fatalf("before the install managedRgPath = %v, want errManagedRgMissing", err)
	}
	rg, err := installManagedRg(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(os.Getenv("ORBIT_HOME"), "tools", "ripgrep", managedRgVersion, "rg")
	if rg != want {
		t.Fatalf("installed rg = %q, want %q", rg, want)
	}
	if got, err := managedRgPath(); err != nil || got != want {
		t.Fatalf("managedRgPath = %q, %v; want %q", got, err, want)
	}
	if got := strings.Join(dirNames(t, filepath.Dir(rg)), " "); got != "COPYING LICENSE-MIT UNLICENSE rg" {
		t.Fatalf("the version directory holds %q, want rg and its licence alone", got)
	}
	if info, err := os.Stat(rg); err != nil || info.Mode().Perm() != 0o755 {
		t.Fatalf("rg = %v, %v; want an executable file", info, err)
	}
	// The stage it was unpacked in is gone: the tools directory holds the version and nothing else.
	if got := strings.Join(dirNames(t, managedRgRoot()), " "); got != managedRgVersion {
		t.Fatalf("the ripgrep directory holds %q, want %s alone", got, managedRgVersion)
	}
	if again, err := installManagedRg(context.Background(), nil); err != nil || again != rg {
		t.Fatalf("installing again = %q, %v", again, err)
	}
	if n := rig.requests.Load(); n != 1 {
		t.Fatalf("the archive was requested %d times, want once", n)
	}
}

// Bytes that are not the pinned archive — another archive, one byte more, none at all — publish nothing, and the
// stage they were checked in is removed.
func TestManagedRgRefusesAnythingButThePinnedArchive(t *testing.T) {
	pinned := fakeRgArchive(t, "echo 'ripgrep "+managedRgVersion+"'")
	for name, served := range map[string][]byte{
		"another archive": fakeRgArchive(t, "echo 'ripgrep "+managedRgVersion+" (rev other)'"),
		"one byte more":   append(append([]byte{}, pinned...), 0),
		"not found":       nil,
	} {
		t.Run(name, func(t *testing.T) {
			newManagedRgRig(t, pinned, served)
			if _, err := installManagedRg(context.Background(), nil); err == nil {
				t.Fatal("the install succeeded")
			}
			if _, err := managedRgPath(); !errors.Is(err, errManagedRgMissing) {
				t.Fatalf("after a refused archive managedRgPath = %v, want errManagedRgMissing", err)
			}
			if names := dirNames(t, managedRgRoot()); len(names) != 0 {
				t.Fatalf("a refused install left %q behind", names)
			}
		})
	}
}

// The checked archive's rg must start on this machine and say it is the pinned version; an archive without rg is no
// build at all. None of them is published.
func TestManagedRgRefusesABuildThatIsNotThePinnedVersion(t *testing.T) {
	for name, script := range map[string]string{
		"another version": "echo 'ripgrep 14.1.1'",
		"does not start":  "echo 'cannot execute'; exit 126",
		"no rg":           "",
	} {
		t.Run(name, func(t *testing.T) {
			archive := fakeRgArchive(t, script)
			newManagedRgRig(t, archive, archive)
			_, err := installManagedRg(context.Background(), nil)
			if err == nil {
				t.Fatal("the install succeeded")
			}
			if _, statErr := os.Lstat(managedRgDir()); !errors.Is(statErr, os.ErrNotExist) {
				t.Fatalf("%v, yet the version directory was published", err)
			}
		})
	}
}

// managedRgPath names only a regular executable rg in a version directory Orbit published, and says why otherwise.
func TestManagedRgPathAcceptsOnlyWhatOrbitPublished(t *testing.T) {
	archive := fakeRgArchive(t, "echo 'ripgrep "+managedRgVersion+"'")
	newManagedRgRig(t, archive, archive)
	elsewhere := t.TempDir()
	writeFakeBin(t, elsewhere, "rg", "exit 0")
	mkdirAll(t, managedRgRoot())
	if err := os.Symlink(elsewhere, managedRgDir()); err != nil {
		t.Fatal(err)
	}
	if _, err := managedRgPath(); err == nil || errors.Is(err, errManagedRgMissing) {
		t.Fatalf("a linked version directory: %v", err)
	}
	// Present and broken is reported, never replaced.
	if _, err := installManagedRg(context.Background(), nil); err == nil {
		t.Fatal("an install over a linked version directory succeeded")
	}
	if err := os.Remove(managedRgDir()); err != nil {
		t.Fatal(err)
	}
	rg := writeFakeBin(t, mkdirAll(t, managedRgDir()), "rg", "exit 0")
	if err := os.Chmod(rg, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := managedRgPath(); err == nil {
		t.Fatal("an rg that is not executable was accepted")
	}
	if err := os.Chmod(rg, 0o755); err != nil {
		t.Fatal(err)
	}
	if got, err := managedRgPath(); err != nil || got != rg {
		t.Fatalf("managedRgPath = %q, %v; want %q", got, err, rg)
	}
	managedRgOS, managedRgArch = "linux", "riscv64"
	if _, err := managedRgPath(); err == nil || !strings.Contains(err.Error(), "linux/riscv64") {
		t.Fatalf("a platform without a build: %v", err)
	}
}

// Orbit's directory is the PATH's last entry and appears once, however often the PATH is built and whatever version
// an earlier pin left on it; a platform without a build, or an Orbit home that is not absolute, adds nothing.
func TestManagedRgGoesLastOnThePath(t *testing.T) {
	archive := fakeRgArchive(t, "echo 'ripgrep "+managedRgVersion+"'")
	newManagedRgRig(t, archive, archive)
	dir := managedRgDir()
	old := filepath.Join(managedRgRoot(), "14.1.1")
	for path, want := range map[string]string{
		"/usr/bin:/bin":                         "/usr/bin:/bin:" + dir,
		"/usr/bin:" + dir + ":/bin":             "/usr/bin:/bin:" + dir,
		dir + "/:/usr/bin:" + old + ":/bin":     "/usr/bin:/bin:" + dir,
		"/usr/bin:" + managedRgRoot() + ":/bin": "/usr/bin:" + managedRgRoot() + ":/bin:" + dir,
		"":                                      dir,
	} {
		got := pathWithManagedRgLast(path)
		if got != want {
			t.Errorf("pathWithManagedRgLast(%q) = %q, want %q", path, got, want)
		}
		if again := pathWithManagedRgLast(got); again != got {
			t.Errorf("not idempotent: %q -> %q", got, again)
		}
	}
	home := filepath.Join(string(filepath.Separator), "home", "alice")
	if got := runnerEnginePath(home, "/usr/bin"); !strings.HasSuffix(got, ":/usr/bin:"+dir) {
		t.Errorf("runnerEnginePath = %q, want the engine dirs, the PATH, then %s", got, dir)
	}
	t.Setenv("ORBIT_HOME", "relative/orbit")
	if got := pathWithManagedRgLast("/usr/bin"); got != "/usr/bin" {
		t.Errorf("with a relative Orbit home the PATH became %q", got)
	}
	managedRgOS = "windows"
	t.Setenv("ORBIT_HOME", t.TempDir())
	if got := pathWithManagedRgLast("/usr/bin"); got != "/usr/bin" {
		t.Errorf("on a platform without a build the PATH became %q", got)
	}
}

// An rg the host has is found before Orbit's, wherever on the PATH it sits; Orbit's is found only where there is none.
func TestASystemRgWinsOverOrbits(t *testing.T) {
	archive := fakeRgArchive(t, "echo 'ripgrep "+managedRgVersion+"'")
	newManagedRgRig(t, archive, archive)
	managed, err := installManagedRg(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	system := t.TempDir()
	login := t.TempDir()
	path := runnerEnginePath(t.TempDir(), system)
	if got, _ := lookPathIn("rg", path); got != managed {
		t.Fatalf("with no rg on the PATH, rg = %q, want Orbit's %q", got, managed)
	}
	systemRg := writeFakeBin(t, system, "rg", "exit 0")
	if got, _ := lookPathIn("rg", path); got != systemRg {
		t.Fatalf("with an rg on the PATH, rg = %q, want the host's %q", got, systemRg)
	}
	// A directory the login shell contributes after the service PATH was baked still comes before Orbit's
	// (resolveRunnerEnv unions it in behind the baked PATH, which ends in Orbit's directory).
	loginRg := writeFakeBin(t, login, "rg", "exit 0")
	if err := os.Remove(systemRg); err != nil {
		t.Fatal(err)
	}
	if got, _ := lookPathIn("rg", runnerEnginePath(t.TempDir(), unionPath(path, login))); got != loginRg {
		t.Fatalf("with an rg in a later login-PATH directory, rg = %q, want %q", got, loginRg)
	}
}

// Every environment the runner starts an engine in ends its PATH in Orbit's directory, a PATH the agent's
// configuration sets included, and keeps everything before it in its order.
func TestEngineEnvironmentsEndPathWithOrbitsRg(t *testing.T) {
	for _, c := range userTokenEnvCases() {
		switch {
		case strings.Contains(c.name, "MCP server"):
			continue // the environment declared for `orbit mcp`, which has no command shell
		case c.name == "shell turn" || c.name == "runner-hosted background job":
			// Captured inside `bash -lc`, whose login profile decides the PATH (Debian's assigns it outright).
			// What the runner hands that shell is envWithAgent's, the last case.
			continue
		}
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("ORBIT_HOME", filepath.Join(dir, "orbit-home"))
			agentPath := filepath.Join(dir, "agent-bin") + ":/usr/bin:/bin"
			job := &ClaimedSession{
				SessionID: userTokenSessionID, SessionUUID: userTokenSessionID,
				AgentID: "31111111-2222-4333-8444-555555555555", TaskID: "21111111-2222-4333-8444-555555555555",
				Agent: AgentExecConfig{Model: "model", PermissionMode: "dontAsk", Env: map[string]string{"PATH": agentPath}},
			}
			// Where the site hands the process the agent's variables at all, it hands it the agent's PATH.
			takesAgentEnv := containsString(c.holds, "PAT_TEST_AGENT_VALUE=agent")
			path := envValue(c.env(t, job, dir), "PATH")
			entries := strings.Split(path, ":")
			if entries[len(entries)-1] != managedRgDir() {
				t.Fatalf("PATH = %q, want it to end in %s", path, managedRgDir())
			}
			if strings.Count(path, managedRgDir()) != 1 {
				t.Fatalf("PATH = %q names Orbit's directory more than once", path)
			}
			if takesAgentEnv && !strings.HasPrefix(path, agentPath+":") {
				t.Fatalf("PATH = %q, want the agent's %q ahead of Orbit's directory", path, agentPath)
			}
		})
	}
}

// The runner installs its ripgrep by itself only with the consent `orbit register` recorded, and after a failure it
// tries again until it is in place.
func TestKeepManagedRgInstallsOnlyWithConsent(t *testing.T) {
	archive := fakeRgArchive(t, "echo 'ripgrep "+managedRgVersion+"'")
	rig := newManagedRgRig(t, archive, nil)
	keepManagedRg(context.Background(), false, nil)
	if n := rig.requests.Load(); n != 0 {
		t.Fatalf("without consent the archive was requested %d times", n)
	}
	retry := managedRgRetryInterval
	t.Cleanup(func() { managedRgRetryInterval = retry })
	managedRgRetryInterval = 10 * time.Millisecond
	done := make(chan struct{})
	go func() {
		defer close(done)
		keepManagedRg(context.Background(), true, nil)
	}()
	deadline := time.Now().Add(10 * time.Second)
	for rig.requests.Load() < 2 {
		if time.Now().After(deadline) {
			t.Fatal("a failed install was not tried again")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, err := managedRgPath(); !errors.Is(err, errManagedRgMissing) {
		t.Fatalf("while the server has nothing to serve, managedRgPath = %v", err)
	}
	rig.serve(archive)
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("keepManagedRg did not return once the archive was there")
	}
	if _, err := managedRgPath(); err != nil {
		t.Fatalf("after keepManagedRg returned, managedRgPath = %v", err)
	}
}
