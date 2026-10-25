package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

type dshTarEntry struct {
	name, body, link string
	typeflag         byte
}

func dshTarball(t *testing.T, entries ...dshTarEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		header := &tar.Header{Name: e.name, Typeflag: e.typeflag, Linkname: e.link, Mode: 0o755}
		if e.typeflag == tar.TypeReg {
			header.Size = int64(len(e.body))
		}
		if err := tw.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(e.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// fakeDshNodeBuild serves a stand-in for the official Node build, laid out as it is, and pins
// dshNodeBuild to it. Its bin/node logs every call to nodeCalls, says v26.10.0 when asked, and
// otherwise runs its arguments, so dsh's fake entry point runs on it as the real one runs on Node.
// bin/npm is the link the official build ships, to npmBody.
func fakeDshNodeBuild(t *testing.T, nodeCalls, nodeBody, npmBody string) *atomic.Int32 {
	t.Helper()
	if nodeBody == "" {
		nodeBody = "#!/bin/sh\nprintf '%s\\n' \"$*\" >> " + shellQuote(nodeCalls) + "\n[ \"$1\" = --version ] && { printf 'v26.10.0\\n'; exit 0; }\nexec \"$@\"\n"
	}
	root := dshNodeBuild.name + "/"
	tarball := dshTarball(t,
		dshTarEntry{name: root, typeflag: tar.TypeDir},
		dshTarEntry{name: root + "bin/", typeflag: tar.TypeDir},
		dshTarEntry{name: root + "bin/node", body: nodeBody, typeflag: tar.TypeReg},
		dshTarEntry{name: root + "lib/node_modules/npm/bin/npm-cli.js", body: npmBody, typeflag: tar.TypeReg},
		dshTarEntry{name: root + "bin/npm", link: "../lib/node_modules/npm/bin/npm-cli.js", typeflag: tar.TypeSymlink},
	)
	requests := &atomic.Int32{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/"+dshNodeVersion+"/"+dshNodeBuild.name+".tar.gz" {
			http.NotFound(w, req)
			return
		}
		requests.Add(1)
		_, _ = w.Write(tarball)
	}))
	t.Cleanup(server.Close)
	priorBuild, priorBase := dshNodeBuild, dshNodeDownloadBase
	digest := sha256.Sum256(tarball)
	dshNodeBuild.sha256, dshNodeBuild.size = hex.EncodeToString(digest[:]), int64(len(tarball))
	dshNodeDownloadBase = server.URL
	t.Cleanup(func() { dshNodeBuild, dshNodeDownloadBase = priorBuild, priorBase })
	return requests
}

// withoutServiceNode26 leaves the fixture's service PATH with Node 24 and no npm, and returns the npm
// script that was there, which records the PATH it ran with.
func withoutServiceNode26(t *testing.T, f dshInstallFixture, npmPath string) string {
	t.Helper()
	npm, err := os.ReadFile(filepath.Join(f.bins, "npm"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(f.bins, "npm")); err != nil {
		t.Fatal(err)
	}
	writeDshInstallExecutable(t, filepath.Join(f.bins, "node"), "#!/bin/sh\nprintf 'v24.0.0\\n'\n")
	return "#!/bin/sh\nprintf '%s\\n' \"$PATH\" > " + shellQuote(npmPath) + "\n" + strings.TrimPrefix(string(npm), "#!/bin/sh\n")
}

func envValueOf(env []string, key string) string {
	for _, kv := range env {
		if value, ok := strings.CutPrefix(kv, key+"="); ok {
			return value
		}
	}
	return ""
}

// A runner without Node 26 used to say DSH_NODE_UNSUPPORTED, which every client reads as "not supported
// here" and offers no Install for. It is now a runner Harness is not installed on yet, and the Install
// brings Node 26 with it: npm and dsh run on Orbit's copy, and the session's PATH stays the machine's.
func TestDshInstallFetchesNode26WhenTheRunnerHasNone(t *testing.T) {
	f := fakeDshInstall(t, "ok")
	nodeCalls, npmPath := filepath.Join(f.root, "node-calls"), filepath.Join(f.root, "npm-path")
	requests := fakeDshNodeBuild(t, nodeCalls, "", withoutServiceNode26(t, f, npmPath))
	spec, _ := specFor(providerDsh)

	reports := probeEngines([]engineSpec{spec}, f.bins)
	if reports[0].Installed || !strings.HasPrefix(reports[0].InstallationError, "DSH_NOT_INSTALLED") {
		t.Fatalf("a runner without Node 26 is not reported as installable: %+v", reports[0])
	}
	if msg := ensureEngine(context.Background(), providerDsh, nil); !strings.Contains(msg, "not authorized") || requests.Load() != 0 {
		t.Fatalf("Node was fetched without consent: %q, downloads=%d", msg, requests.Load())
	}

	if result := installEngineNow(spec); result.Status != installDone {
		t.Fatalf("install on a runner without Node 26 failed: %+v", result)
	}
	node := filepath.Join(dshNodeDir(), "bin", "node")
	if link, err := os.Readlink(filepath.Join(dshNodeDir(), "bin", "npm")); err != nil || link != "../lib/node_modules/npm/bin/npm-cli.js" {
		t.Fatalf("the build's npm link was not kept: %q, %v", link, err)
	}
	if npmRunPath, _ := os.ReadFile(npmPath); !strings.HasPrefix(string(npmRunPath), filepath.Dir(node)+":") {
		t.Fatalf("npm did not run with Orbit's Node first on its PATH: %q", npmRunPath)
	}
	gotNode, entry, err := dshRuntime()
	if err != nil || gotNode != node || !strings.HasPrefix(entry, dshVersionDir()+string(os.PathSeparator)) {
		t.Fatalf("runtime = %q, %q, %v", gotNode, entry, err)
	}
	if calls, _ := os.ReadFile(nodeCalls); !strings.Contains(string(calls), entry+" --version") {
		t.Fatalf("dsh's version probe did not run on Orbit's Node: %q", calls)
	}
	reports = probeEngines([]engineSpec{spec}, f.bins)
	if !reports[0].Installed || reports[0].InstallationError != "" || !reports[0].Dsh.VersionCompatible {
		t.Fatalf("installed runtime not reported ready: %+v", reports[0])
	}

	launch, err := PrepareDshLaunch(context.Background(), DshLaunchInput{"node-session", t.TempDir(), "fake-key", "https://synthetic.example", "read-only"})
	if err != nil {
		t.Fatal(err)
	}
	if launch.Executable != node || len(launch.Args) < 3 || launch.Args[0] != entry || launch.Args[1] != "--profile" {
		t.Fatalf("session does not start dsh on Orbit's Node: %q %q", launch.Executable, launch.Args)
	}
	if path := envValueOf(launch.Env, "PATH"); path != dshServicePath() {
		t.Fatalf("session PATH changed: %q", path)
	}

	if result := installEngineNow(spec); result.Status != installDone || requests.Load() != 1 {
		t.Fatalf("a repeated install downloaded Node again: %+v, downloads=%d", result, requests.Load())
	}
}

// A CLI installed on the service PATH's Node 26 keeps working once that Node is gone, after an Install
// fetches Orbit's copy; the published version directory is verified, never installed again.
func TestDshInstallFetchesNode26ForAnInstalledCLI(t *testing.T) {
	f := fakeDshInstall(t, "ok")
	configureEngineInstall(true, nil)
	if msg := ensureEngine(context.Background(), providerDsh, nil); msg != "" {
		t.Fatal(msg)
	}
	nodeCalls, npmPath := filepath.Join(f.root, "node-calls"), filepath.Join(f.root, "npm-path")
	requests := fakeDshNodeBuild(t, nodeCalls, "", withoutServiceNode26(t, f, npmPath))
	spec, _ := specFor(providerDsh)
	reports := probeEngines([]engineSpec{spec}, f.bins)
	if reports[0].Installed || reports[0].InstallationError != errDshNodeMissing.Error() {
		t.Fatalf("a CLI without a Node to run on is not reported as installable: %+v", reports[0])
	}
	if result := installEngineNow(spec); result.Status != installDone || requests.Load() != 1 {
		t.Fatalf("install did not fetch Node: %+v, downloads=%d", result, requests.Load())
	}
	if runs, _ := os.ReadFile(f.npmRuns); strings.Count(string(runs), "ran") != 1 {
		t.Fatalf("the published version was installed again: %q", runs)
	}
	if node, _, err := dshRuntime(); err != nil || node != filepath.Join(dshNodeDir(), "bin", "node") {
		t.Fatalf("runtime = %q, %v", node, err)
	}
}

func TestDshNodeInstallRefusesAnythingButAWorkingPinnedBuild(t *testing.T) {
	for name, tc := range map[string]struct {
		nodeBody, want string
		corrupt        bool
	}{
		"digest mismatch": {corrupt: true, want: "does not match its pinned size and SHA-256"},
		"does not start":  {nodeBody: "#!/bin/sh\necho 'node: error while loading shared libraries: libatomic.so.1' >&2\nexit 127\n", want: "DSH_NODE_UNSUPPORTED: Node " + dshNodeVersion + ", which DeepSeek Harness runs on, does not start on this runner (node: error while loading shared libraries: libatomic.so.1)"},
	} {
		t.Run(name, func(t *testing.T) {
			f := fakeDshInstall(t, "ok")
			fakeDshNodeBuild(t, filepath.Join(f.root, "node-calls"), tc.nodeBody, withoutServiceNode26(t, f, filepath.Join(f.root, "npm-path")))
			if tc.corrupt {
				dshNodeBuild.sha256 = strings.Repeat("0", 64)
			}
			spec, _ := specFor(providerDsh)
			result := installEngineNow(spec)
			if result.Status != installFailed || !strings.Contains(result.Message, tc.want) {
				t.Fatalf("install = %+v, want a failure saying %q", result, tc.want)
			}
			if _, err := os.Lstat(dshNodeDir()); !os.IsNotExist(err) {
				t.Fatal("an unchecked Node was published")
			}
			entries, _ := os.ReadDir(filepath.Dir(dshNodeDir()))
			if len(entries) != 0 {
				t.Fatalf("staging left behind: %v", entries)
			}
			if _, err := os.Stat(f.npmRuns); !os.IsNotExist(err) {
				t.Fatal("npm ran without a checked Node")
			}
		})
	}
}

func TestDshNodeUnpackRefusesEntriesOutsideTheBuild(t *testing.T) {
	root := dshNodeBuild.name + "/"
	for name, entry := range map[string]dshTarEntry{
		"path outside":      {name: "elsewhere/bin/node", body: "x", typeflag: tar.TypeReg},
		"path climbing out": {name: root + "../bin/node", body: "x", typeflag: tar.TypeReg},
		"link climbing out": {name: root + "bin/npm", link: "../../outside", typeflag: tar.TypeSymlink},
		"absolute link":     {name: root + "bin/npm", link: "/usr/bin/npm", typeflag: tar.TypeSymlink},
		"hard link":         {name: root + "bin/npm", link: root + "bin/node", typeflag: tar.TypeLink},
	} {
		t.Run(name, func(t *testing.T) {
			tarball := filepath.Join(t.TempDir(), "node.tar.gz")
			if err := os.WriteFile(tarball, dshTarball(t, dshTarEntry{name: root, typeflag: tar.TypeDir}, entry), 0o600); err != nil {
				t.Fatal(err)
			}
			dir := filepath.Join(t.TempDir(), "node")
			if err := unpackDshNode(tarball, dir); err == nil || !strings.HasPrefix(err.Error(), "DSH_INSTALL_FAILED") {
				t.Fatalf("unpack = %v", err)
			}
		})
	}
}
