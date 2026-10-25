package main

// A scripted stand-in for the pinned Cursor CLI, and the tests of installing and updating it.
//
// The fake is this test binary re-executed through a shim named cursor-agent (TestMain), packaged the
// way the real build is — dist-package/ in a gzip tarball — and served from a local download server
// whose size and SHA-256 the test pins in place of the real build's. It writes what the pinned build
// writes as it starts (measured, and docs/cursor-runtime-contract.md §8.1): a cli-config.json wherever
// CURSOR_CONFIG_DIR, XDG_CONFIG_HOME or HOME puts it, a compile cache, an auth.json when a credential is
// held in a file store, a debug log unless that is switched off, and under HOME/.cursor its state file
// and synced skills. So a test reads off the disk which home every process Orbit started was given.
// Told it runs on macOS (its platform file), it writes where the macOS build does (§18.3, §18.4): a login
// under HOME whatever XDG_CONFIG_HOME says, the compile cache under HOME/Library/Caches, and a credential
// whose store was left to its default into the Keychain — which the fake records in keychain.jsonl.

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// fakeCursorAgentEnv starts this test binary as the scripted Cursor CLI (TestMain), naming the fake's
// directory: calls.jsonl, and the files that choose how it behaves.
const fakeCursorAgentEnv = "ORBIT_FAKE_CURSOR_AGENT_DIR"

// fakeCursorVersionEnv is the version the fake reports, written into the shim of the build it stands in for.
const fakeCursorVersionEnv = "ORBIT_FAKE_CURSOR_VERSION"

// fakeCursorEntryEnv is the path the fake was started by: the cursor-agent in its version directory.
const fakeCursorEntryEnv = "ORBIT_FAKE_CURSOR_ENTRY"

// fakeCursorCall is one start of the fake CLI, as calls.jsonl records it.
type fakeCursorCall struct {
	Args []string `json:"args"`
	Env  []string `json:"env"`
	Dir  string   `json:"dir"`
	PID  int      `json:"pid"`
}

func (c fakeCursorCall) env(key string) (string, bool) {
	for _, entry := range c.Env {
		if k, v, _ := strings.Cut(entry, "="); k == key {
			return v, true
		}
	}
	return "", false
}

func runFakeCursorAgent(dir string) int {
	args := os.Args[1:]
	var env []string
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, fakeCursorAgentEnv+"=") && !strings.HasPrefix(entry, fakeCursorVersionEnv+"=") &&
			!strings.HasPrefix(entry, fakeCursorEntryEnv+"=") {
			env = append(env, entry)
		}
	}
	wd, _ := os.Getwd()
	if line, err := json.Marshal(fakeCursorCall{Args: args, Env: env, Dir: wd, PID: os.Getpid()}); err == nil {
		if f, err := os.OpenFile(filepath.Join(dir, "calls.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
			_, _ = f.Write(append(line, '\n'))
			_ = f.Close()
		}
	}
	fakeCursorWriteState(dir, args)
	switch {
	case len(args) > 0 && (args[0] == "--version" || args[0] == "-v"):
		// A build slow to say its version, as one on a loaded machine is.
		if mode, _ := os.ReadFile(filepath.Join(dir, "version-mode")); strings.TrimSpace(string(mode)) == "slow" {
			time.Sleep(2 * time.Second)
		}
		version := os.Getenv(fakeCursorVersionEnv)
		if version == "" {
			version = cursorSupportedVersion
		}
		fmt.Println(version)
		return 0
	case len(args) > 0 && args[0] == "models":
		return fakeCursorModels(dir)
	case len(args) > 0 && args[0] == "acp":
		return fakeCursorACP(dir, args[1:])
	case len(args) > 0 && args[0] == "login":
		return fakeCursorLogin(dir)
	}
	fmt.Fprintln(os.Stderr, "fake cursor-agent: unexpected command", args)
	return 2
}

// fakeCursorOnMac is whether the fake whose directory is dir runs as the macOS build: its platform file
// says darwin (fakeCursorRelease.onMac).
func fakeCursorOnMac(dir string) bool {
	platform, _ := os.ReadFile(filepath.Join(dir, "platform"))
	return strings.TrimSpace(string(platform)) == "darwin"
}

// fakeCursorSaveCredential keeps a credential the way the pinned build does by AGENT_CLI_CREDENTIAL_STORE
// (§8.2, §18.3, §18.4): nowhere in memory; in a file — on Linux under XDG_CONFIG_HOME, on macOS always under
// HOME/.cursor — or, with the store left to its default, in that same file on Linux and in the Keychain on
// macOS, which the fake records in keychain.jsonl: who saved, never what.
func fakeCursorSaveCredential(dir string, login []byte) {
	store := os.Getenv("AGENT_CLI_CREDENTIAL_STORE")
	if store == "memory" {
		return
	}
	home := os.Getenv("HOME")
	if fakeCursorOnMac(dir) {
		if store != "file" {
			entry, _ := json.Marshal(map[string]interface{}{"pid": os.Getpid(), "args": os.Args[1:], "store": store,
				"account": "cursor-user", "service": "cursor-access-token"})
			if f, err := os.OpenFile(filepath.Join(dir, "keychain.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
				_, _ = f.Write(append(entry, '\n'))
				_ = f.Close()
			}
			return
		}
		_ = os.MkdirAll(filepath.Join(home, ".cursor"), 0o700)
		_ = os.WriteFile(filepath.Join(home, ".cursor", "auth.json"), login, 0o600)
		return
	}
	xdg := os.Getenv("XDG_CONFIG_HOME")
	if xdg == "" {
		xdg = filepath.Join(home, ".config")
	}
	_ = os.MkdirAll(filepath.Join(xdg, "cursor"), 0o700)
	_ = os.WriteFile(filepath.Join(xdg, "cursor", "auth.json"), login, 0o600)
}

// fakeCursorWriteState writes what the pinned build writes as it starts.
func fakeCursorWriteState(dir string, args []string) {
	home := os.Getenv("HOME")
	configDir := os.Getenv("CURSOR_CONFIG_DIR")
	if configDir == "" {
		if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
			configDir = filepath.Join(xdg, "cursor")
		} else {
			configDir = filepath.Join(home, ".cursor")
		}
	}
	_ = os.MkdirAll(configDir, 0o700)
	configPath := filepath.Join(configDir, "cli-config.json")
	config := map[string]interface{}{}
	if data, err := os.ReadFile(configPath); err == nil {
		_ = json.Unmarshal(data, &config)
	}
	if _, ok := config["permissions"]; !ok {
		config["permissions"] = map[string]interface{}{"allow": []string{"Shell(ls)"}, "deny": []string{}}
	}
	config["version"] = 1
	if data, err := json.MarshalIndent(config, "", "  "); err == nil {
		_ = os.WriteFile(configPath, data, 0o600)
	}
	cache := os.Getenv("XDG_CACHE_HOME")
	if cache == "" {
		cache = filepath.Join(home, ".cache")
	}
	if fakeCursorOnMac(dir) {
		cache = filepath.Join(home, "Library", "Caches")
	}
	_ = os.MkdirAll(filepath.Join(cache, "cursor-compile-cache"), 0o700)
	if credential := firstNonEmpty(os.Getenv("CURSOR_AUTH_TOKEN"), os.Getenv("CURSOR_API_KEY")); credential != "" {
		fakeCursorSaveCredential(dir, []byte(`{"accessToken":"`+credential+`"}`))
	}
	if os.Getenv("CURSOR_AGENT_DISABLE_DEBUG_LOG") != "1" {
		logs := filepath.Join(os.TempDir(), fmt.Sprintf("cursor-agent-logs-%d", os.Getuid()))
		_ = os.MkdirAll(logs, 0o700)
		_ = os.WriteFile(filepath.Join(logs, "fake.log"), []byte("started\n"), 0o600)
	}
	if len(args) > 0 && args[0] == "acp" {
		_ = os.MkdirAll(filepath.Join(home, ".cursor", "skills-cursor"), 0o700)
		_ = os.WriteFile(filepath.Join(home, ".cursor", "agent-cli-state.json"), []byte("{}\n"), 0o600)
	}
}

// fakeCursorModels is `agent models` (§9): exit 0 with a credential that works; the measured wording
// for a network it cannot reach; an authentication refusal otherwise.
func fakeCursorModels(dir string) int {
	mode, _ := os.ReadFile(filepath.Join(dir, "models-mode"))
	switch strings.TrimSpace(string(mode)) {
	case "offline":
		fmt.Fprintln(os.Stderr, "✗ Failed to reach the Cursor API. If you are behind a corporate proxy, set the HTTPS_PROXY environment variable.")
		return 1
	case "rejected":
		fmt.Fprintln(os.Stderr, "Authentication required. Please run 'agent login' first.")
		return 1
	case "garbled":
		fmt.Fprintln(os.Stderr, "something went sideways")
		return 1
	case "hang":
		// A Cursor API that never answers: the CLI waits on it until something stops it.
		time.Sleep(60 * time.Second)
		return 1
	case "invalid-key":
		// A key Cursor refuses, as P0a recorded it (failure-shapes-without-prompt), colours and all.
		fmt.Fprintln(os.Stderr, "\x1b[33m⚠ Warning: The provided API key is invalid.\x1b[0m\n"+
			"The API key was loaded from the CURSOR_API_KEY environment variable.\n"+
			"Please check you have the right key, create a new one, or authenticate without it.")
		return 1
	}
	if os.Getenv("CURSOR_AUTH_TOKEN") == "" && os.Getenv("CURSOR_API_KEY") == "" {
		fmt.Fprintln(os.Stderr, "Authentication required. Please run 'agent login' first.")
		return 1
	}
	// A login Cursor no longer accepts, one token per line.
	if refused, _ := os.ReadFile(filepath.Join(dir, "refused-tokens")); contains(strings.Fields(string(refused)), os.Getenv("CURSOR_AUTH_TOKEN")) {
		fmt.Fprintln(os.Stderr, "Authentication required. Please run 'agent login' first.")
		return 1
	}
	fmt.Println("auto - Auto (default)")
	return 0
}

// fakeCursorInUseMarker is the marker the pinned build keeps while it runs from a version directory that
// sits in one named versions (its install-in-use-marker.ts, measured): <version>/.running/<pid>. It is
// deleted as the process exits — on SIGTERM or SIGINT, which it handles — and left behind by SIGKILL.
func fakeCursorInUseMarker() string {
	dir := filepath.Dir(os.Getenv(fakeCursorEntryEnv))
	if filepath.Base(filepath.Dir(dir)) != "versions" {
		return ""
	}
	marker := filepath.Join(dir, ".running", strconv.Itoa(os.Getpid()))
	if os.MkdirAll(filepath.Dir(marker), 0o755) != nil || os.WriteFile(marker, nil, 0o644) != nil {
		return ""
	}
	return marker
}

// fakeCursorACP is `agent acp`: initialize as recorded, the recorded catalogue for a credential, a
// session for one, and — like the real CLI — no exit when stdin ends (§3.4), only on a signal: SIGTERM
// exits 143, SIGINT 130. A build told to update itself writes the update the way Cursor's installer
// does: into HOME.
func fakeCursorACP(dir string, flags []string) int {
	marker := fakeCursorInUseMarker()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		sig := <-signals
		if marker != "" {
			_ = os.Remove(marker)
		}
		if sig == syscall.SIGINT {
			os.Exit(130)
		}
		os.Exit(143)
	}()
	if mode, err := os.ReadFile(filepath.Join(dir, "self-update")); err == nil {
		switch strings.TrimSpace(string(mode)) {
		case "always":
			fakeCursorSelfUpdate()
		case "unless-disabled":
			if !contains(flags, "--disable-auto-update") {
				fakeCursorSelfUpdate()
			}
		}
	}
	credential := os.Getenv("CURSOR_AUTH_TOKEN") != "" || os.Getenv("CURSOR_API_KEY") != ""
	out := bufio.NewWriter(os.Stdout)
	reply := func(id json.RawMessage, result interface{}, rpcErr map[string]interface{}) {
		message := map[string]interface{}{"jsonrpc": "2.0", "id": id}
		if rpcErr != nil {
			message["error"] = rpcErr
		} else {
			message["result"] = result
		}
		if line, err := json.Marshal(message); err == nil {
			_, _ = out.Write(append(line, '\n'))
			_ = out.Flush()
		}
	}
	authRequired := map[string]interface{}{"code": -32000, "message": "Authentication required",
		"data": map[string]interface{}{"message": "Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'."}}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		var msg struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if json.Unmarshal(scanner.Bytes(), &msg) != nil || len(msg.ID) == 0 {
			continue
		}
		switch msg.Method {
		case "initialize":
			data, _ := os.ReadFile(filepath.Join(dir, "initialize.json"))
			reply(msg.ID, json.RawMessage(data), nil)
		case "cursor/list_available_models":
			if _, err := os.Stat(filepath.Join(dir, "catalog-rejected")); err == nil || !credential {
				reply(msg.ID, nil, authRequired)
				continue
			}
			data, _ := os.ReadFile(filepath.Join(dir, "catalog.json"))
			reply(msg.ID, json.RawMessage(data), nil)
		case "session/new":
			if !credential {
				reply(msg.ID, nil, authRequired)
				continue
			}
			store := filepath.Join(os.Getenv("CURSOR_CONFIG_DIR"), "acp-sessions", "fake-session")
			_ = os.MkdirAll(store, 0o700)
			_ = os.WriteFile(filepath.Join(store, "meta.json"), []byte(`{"schemaVersion":1}`), 0o600)
			_ = os.WriteFile(filepath.Join(store, "store.db"), []byte("conversation"), 0o600)
			reply(msg.ID, map[string]interface{}{"sessionId": "fake-session"}, nil)
		default:
			reply(msg.ID, nil, map[string]interface{}{"code": -32601, "message": "Method not found"})
		}
	}
	time.Sleep(60 * time.Second)
	if marker != "" {
		_ = os.Remove(marker)
	}
	return 0
}

// fakeCursorSelfUpdate is what Cursor's own updater does: a new version under
// HOME/.local/share/cursor-agent/versions and HOME/.local/bin/agent pointed at it (§1.1).
func fakeCursorSelfUpdate() {
	home := os.Getenv("HOME")
	versions := filepath.Join(home, ".local", "share", "cursor-agent", "versions", "2099.01.01-0000000")
	_ = os.MkdirAll(versions, 0o755)
	_ = os.WriteFile(filepath.Join(versions, cursorEntryPoint), []byte("#!/bin/sh\necho updated\n"), 0o755)
	bin := filepath.Join(home, ".local", "bin")
	_ = os.MkdirAll(bin, 0o755)
	_ = os.Symlink(filepath.Join(versions, cursorEntryPoint), filepath.Join(bin, "agent"))
}

// fakeCursorShim is a cursor-agent that runs the fake reporting version.
func fakeCursorShim(t *testing.T, dir, version string) []byte {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return []byte("#!/bin/sh\n" +
		"export " + fakeCursorAgentEnv + "=" + shellQuote(dir) + "\n" +
		"export " + fakeCursorVersionEnv + "=" + shellQuote(version) + "\n" +
		"export " + fakeCursorEntryEnv + "=\"$0\"\n" +
		"exec " + shellQuote(exe) + " \"$@\"\n")
}

// fakeTarEntry is one entry of a fake release's tarball.
type fakeTarEntry struct {
	name string
	kind byte
	mode int64
	body []byte
	link string
}

// fakeCursorPackage is the pinned build's layout in miniature: dist-package/ holding the launcher,
// index.js and a directory of native modules.
func fakeCursorPackage(shim []byte) []fakeTarEntry {
	return []fakeTarEntry{
		{name: "dist-package/", kind: tar.TypeDir, mode: 0o755},
		{name: "dist-package/" + cursorEntryPoint, kind: tar.TypeReg, mode: 0o755, body: shim},
		{name: "dist-package/index.js", kind: tar.TypeReg, mode: 0o644, body: []byte("// the fake build's index.js\n")},
		{name: "dist-package/lib/", kind: tar.TypeDir, mode: 0o755},
		{name: "dist-package/lib/native.node", kind: tar.TypeReg, mode: 0o644, body: []byte("native")},
	}
}

func fakeCursorTarball(t *testing.T, entries []fakeTarEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, entry := range entries {
		header := &tar.Header{Name: entry.name, Typeflag: entry.kind, Mode: entry.mode, Size: int64(len(entry.body)), Linkname: entry.link, ModTime: time.Unix(1760400000, 0)}
		if entry.kind != tar.TypeReg {
			header.Size = 0
		}
		if err := tw.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if entry.kind == tar.TypeReg {
			if _, err := tw.Write(entry.body); err != nil {
				t.Fatal(err)
			}
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

// fakeCursorRelease is a pinned build served from a local download server: the size and SHA-256 the
// runner checks are this tarball's, and every request the server got is kept.
type fakeCursorRelease struct {
	dir     string
	tarball []byte

	mu       sync.Mutex
	served   []byte
	paths    map[string]bool // the download paths the pinned tarball is served at
	requests []string
}

// newFakeCursorRelease pins and serves a fake build of the pinned version.
func newFakeCursorRelease(t *testing.T) *fakeCursorRelease {
	t.Helper()
	dir := t.TempDir()
	for name, id := range map[string]int{"initialize.json": 1, "catalog.json": 7} {
		if err := os.WriteFile(filepath.Join(dir, name), recordedCursorResult(t, id), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	r := &fakeCursorRelease{dir: dir}
	r.tarball = fakeCursorTarball(t, fakeCursorPackage(fakeCursorShim(t, dir, cursorSupportedVersion)))
	r.served = r.tarball
	r.pin(t, r.tarball)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.mu.Lock()
		r.requests = append(r.requests, req.URL.Path)
		body, served := r.served, r.paths[req.URL.Path]
		r.mu.Unlock()
		if !served || body == nil {
			http.NotFound(w, req)
			return
		}
		_, _ = w.Write(body)
	}))
	t.Cleanup(server.Close)
	previousBase := cursorDownloadBase
	cursorDownloadBase = server.URL
	t.Cleanup(func() { cursorDownloadBase = previousBase })
	return r
}

// pin makes tarball the build a runner checks downloads against, on every platform Orbit pins a build for
// and on this one, each at its own download path — so a test that stands another platform in
// (useCursorPlatform) installs it from where that platform's runner would.
func (r *fakeCursorRelease) pin(t *testing.T, tarball []byte) {
	t.Helper()
	previous := cursorArtifacts
	digest := sha256.Sum256(tarball)
	pinned := map[string]cursorArtifact{}
	paths := map[string]bool{}
	platforms := []string{runtime.GOOS + "/" + runtime.GOARCH}
	for platform := range previous {
		platforms = append(platforms, platform)
	}
	for _, platform := range platforms {
		path := platform
		if measured, ok := previous[platform]; ok {
			path = measured.path
		}
		pinned[platform] = cursorArtifact{path: path, sha256: hex.EncodeToString(digest[:]), size: int64(len(tarball))}
		paths["/"+cursorSupportedVersion+"/"+path+"/agent-cli-package.tar.gz"] = true
	}
	r.mu.Lock()
	r.paths = paths
	r.mu.Unlock()
	cursorArtifacts = pinned
	t.Cleanup(func() { cursorArtifacts = previous })
}

// onMac has the fake run as the macOS build (fakeCursorOnMac).
func (r *fakeCursorRelease) onMac(t *testing.T) { r.behave(t, "platform", "darwin") }

// keychainSaves are the credentials the fake, as the macOS build, saved into the Keychain: one per process
// whose credential store was left to its default.
func (r *fakeCursorRelease) keychainSaves(t *testing.T) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(r.dir, "keychain.jsonl"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var saves []string
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) != "" {
			saves = append(saves, line)
		}
	}
	return saves
}

func (r *fakeCursorRelease) serve(body []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.served = body
}

func (r *fakeCursorRelease) requestPaths() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.requests...)
}

func (r *fakeCursorRelease) behave(t *testing.T, name, content string) {
	t.Helper()
	path := filepath.Join(r.dir, name)
	if content == "" {
		_ = os.Remove(path)
		return
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// calls are the fake CLI's starts so far, in order.
func (r *fakeCursorRelease) calls(t *testing.T) []fakeCursorCall {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(r.dir, "calls.jsonl"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var calls []fakeCursorCall
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var call fakeCursorCall
		if err := json.Unmarshal([]byte(line), &call); err != nil {
			t.Fatalf("calls.jsonl: %v", err)
		}
		calls = append(calls, call)
	}
	return calls
}

// recordedCursorResult is the result of request id in the P0a recording of the parameterized model
// picker: 1 is initialize, 7 is cursor/list_available_models.
func recordedCursorResult(t *testing.T, id int) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "cursor", "parameterized-model-picker", "acp", "stdout.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		var message struct {
			ID     *int            `json:"id"`
			Method string          `json:"method"`
			Result json.RawMessage `json:"result"`
		}
		if json.Unmarshal([]byte(line), &message) == nil && message.ID != nil && *message.ID == id && message.Method == "" {
			return message.Result
		}
	}
	t.Fatalf("the recording has no result for request %d", id)
	return nil
}

// useCursorRealHome gives the test a runner user of its own: a fresh HOME, Orbit's home at its default
// place inside it (~/.orbit), and a private TMPDIR — so whatever a Cursor CLI writes into the user's
// home, or leaves in TMPDIR, is there to see.
func useCursorRealHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ORBIT_HOME", filepath.Join(home, ".orbit"))
	if err := os.Mkdir(filepath.Join(home, ".orbit"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMPDIR", t.TempDir())
	t.Cleanup(func() {
		noteCursorInstallReady(false)
		clearDeferredEngineUpdate(providerCursor)
	})
	return home
}

// allowCursorInstall sets the consent `orbit register` collects for the test's duration.
func allowCursorInstall(t *testing.T, allowed bool) {
	t.Helper()
	engineInstall.mu.Lock()
	previous, proxies := engineInstall.allowed, engineInstall.proxyVars
	engineInstall.mu.Unlock()
	configureEngineInstall(allowed, nil)
	t.Cleanup(func() { configureEngineInstall(previous, proxies) })
}

// installFakeCursor publishes the fake release in Orbit's version directory and returns its entry point.
func installFakeCursor(t *testing.T) string {
	t.Helper()
	engineInstall.mu.Lock()
	err := installCursor(context.Background(), nil)
	engineInstall.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(cursorVersionDir(), cursorEntryPoint)
}

// publishFakeCursorVersion puts a build reporting version into the version directory dirName by hand —
// a build an earlier pin installed, or a directory that is not what it says.
func publishFakeCursorVersion(t *testing.T, r *fakeCursorRelease, dirName, version string) string {
	t.Helper()
	dir := filepath.Join(cursorVersionsDir(), dirName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	entry := filepath.Join(dir, cursorEntryPoint)
	if err := os.WriteFile(entry, fakeCursorShim(t, r.dir, version), 0o755); err != nil {
		t.Fatal(err)
	}
	return entry
}

func cursorSpecForTest(t *testing.T) engineSpec {
	t.Helper()
	spec, ok := specFor(providerCursor)
	if !ok {
		t.Fatal("no engine spec for cursor")
	}
	return spec
}

// cursorTreeDigest is everything under dir — names, kinds, permissions and contents — but the in-use
// markers a running CLI keeps there itself (.running/), which come and go with its processes.
func cursorTreeDigest(t *testing.T, dir string) string {
	t.Helper()
	digest := sha256.New()
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() && entry.Name() == ".running" {
			return filepath.SkipDir
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, path)
		fmt.Fprintf(digest, "%s %v\n", rel, info.Mode())
		if info.Mode().IsRegular() {
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			digest.Write(data)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(digest.Sum(nil))
}

// cursorInUseMarkers are the processes a version directory's .running/ says run from it.
func cursorInUseMarkers(t *testing.T, versionDir string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(versionDir, ".running"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var pids []string
	for _, entry := range entries {
		pids = append(pids, entry.Name())
	}
	return pids
}

// assertNoCursorStateIn fails when home holds anything a Cursor CLI or its installer writes into the
// runner user's home: ~/.cursor, ~/.config/cursor, the compile cache (macOS keeps it in ~/Library/Caches,
// §18.3), Cursor's own install tree and the links it puts on PATH.
func assertNoCursorStateIn(t *testing.T, home string) {
	t.Helper()
	for _, rel := range []string{".cursor", ".config/cursor", ".cache/cursor-compile-cache", "Library/Caches/cursor-compile-cache",
		".local/share/cursor-agent", ".local/bin/agent", ".local/bin/cursor-agent", ".local/bin/cursor"} {
		if _, err := os.Lstat(filepath.Join(home, rel)); err == nil {
			t.Errorf("the runner user's ~/%s was written", rel)
		} else if !os.IsNotExist(err) {
			t.Fatal(err)
		}
	}
}

// assertProbeHome fails unless call ran with a throwaway home of the runner's: not the user's, gone again
// now, and with the credentials it was handed held in memory.
func assertProbeHome(t *testing.T, call fakeCursorCall, realHome string) {
	t.Helper()
	home, _ := call.env("HOME")
	if home == "" || home == realHome || strings.HasPrefix(home, realHome+string(os.PathSeparator)) {
		t.Fatalf("%v ran with HOME=%q, not a throwaway home of its own", call.Args, home)
	}
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Errorf("%v left its throwaway home %s behind", call.Args, home)
	}
	if store, _ := call.env("AGENT_CLI_CREDENTIAL_STORE"); store != "memory" {
		t.Errorf("%v ran with AGENT_CLI_CREDENTIAL_STORE=%q, want memory", call.Args, store)
	}
	for _, key := range []string{"CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"} {
		if value, _ := call.env(key); value == "" || strings.HasPrefix(value, realHome+string(os.PathSeparator)) {
			t.Errorf("%v ran with %s=%q", call.Args, key, value)
		}
	}
}

// The pinned build is fetched from downloads.cursor.com's path for this platform, checked, unpacked
// into Orbit's own version directory and found there by its absolute path: one download, no installer
// script, nothing in ~/.local/bin, and a published directory is never fetched or written again.
func TestCursorInstallPublishesPinnedTarball(t *testing.T) {
	home := useCursorRealHome(t)
	r := newFakeCursorRelease(t)

	t.Run("on-demand-install-needs-consent", func(t *testing.T) {
		allowCursorInstall(t, false)
		msg := ensureEngine(context.Background(), providerCursor, func(string) { t.Fatal("announced an install it may not run") })
		if !strings.HasPrefix(msg, "CURSOR_NOT_INSTALLED:") || !strings.Contains(msg, "orbit doctor") {
			t.Fatalf("ensureEngine without consent = %q", msg)
		}
		if len(r.requestPaths()) != 0 {
			t.Fatalf("downloaded without consent: %q", r.requestPaths())
		}
	})

	t.Run("install", func(t *testing.T) {
		allowCursorInstall(t, true)
		var notes []string
		if msg := ensureEngine(context.Background(), providerCursor, func(note string) { notes = append(notes, note) }); msg != "" {
			t.Fatalf("ensureEngine = %q", msg)
		}
		if len(notes) != 2 || !strings.Contains(notes[0], cursorSupportedVersion) || !strings.Contains(notes[0], "SHA-256") {
			t.Fatalf("install notes = %q", notes)
		}
		want := "/" + cursorSupportedVersion + "/linux/x64/agent-cli-package.tar.gz"
		if paths := r.requestPaths(); len(paths) != 1 || paths[0] != want {
			t.Fatalf("download requests = %q, want just %s", paths, want)
		}
		target := filepath.Join(home, ".orbit", "cursor", "versions", cursorSupportedVersion)
		exe, err := cursorExecutablePath()
		if err != nil || exe != filepath.Join(target, cursorEntryPoint) {
			t.Fatalf("cursorExecutablePath = %q, %v", exe, err)
		}
		for _, rel := range []string{"index.js", "lib/native.node"} {
			if _, err := os.Stat(filepath.Join(target, rel)); err != nil {
				t.Fatalf("the package's %s was not unpacked: %v", rel, err)
			}
		}
		entries, err := os.ReadDir(cursorVersionsDir())
		if err != nil || len(entries) != 1 || entries[0].Name() != cursorSupportedVersion {
			t.Fatalf("versions directory = %v, %v: a staging directory was left behind", entries, err)
		}
		if path, ok := lookEngine(providerCursor); !ok || path != exe {
			t.Fatalf("lookEngine = %q, %v", path, ok)
		}
		calls := r.calls(t)
		if len(calls) == 0 {
			t.Fatal("the install never asked the unpacked build its version")
		}
		for _, call := range calls {
			if len(call.Args) != 1 || call.Args[0] != "--version" {
				t.Fatalf("the install ran %v: only the version probe should run", call.Args)
			}
			assertProbeHome(t, call, home)
		}
		assertNoCursorStateIn(t, home)
	})

	t.Run("published-directory-is-never-written-again", func(t *testing.T) {
		before := cursorTreeDigest(t, cursorVersionDir())
		requests := len(r.requestPaths())
		engineInstall.mu.Lock()
		err := installCursor(context.Background(), nil)
		engineInstall.mu.Unlock()
		if err != nil {
			t.Fatal(err)
		}
		if result := installEngineNow(cursorSpecForTest(t)); result.Status != installDone {
			t.Fatalf("Install from Orbit = %+v", result)
		}
		if len(r.requestPaths()) != requests || cursorTreeDigest(t, cursorVersionDir()) != before {
			t.Fatal("an installed version was downloaded or written again")
		}
	})
}

// A download that is not byte for byte the pinned tarball — another build, a truncated or padded file,
// a server error — is refused before anything is unpacked, and so is a checked tarball whose contents
// are not the pinned build. Nothing is published, and nothing of the attempt stays behind.
func TestCursorInstallRejectsChecksumMismatch(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T, r *fakeCursorRelease)
		want  string
	}{
		{"tampered", func(t *testing.T, r *fakeCursorRelease) {
			tampered := append([]byte(nil), r.tarball...)
			tampered[len(tampered)/2] ^= 0xff
			r.serve(tampered)
		}, "SHA-256"},
		{"truncated", func(t *testing.T, r *fakeCursorRelease) { r.serve(r.tarball[:len(r.tarball)/2]) }, "SHA-256"},
		{"padded", func(t *testing.T, r *fakeCursorRelease) {
			r.serve(append(append([]byte(nil), r.tarball...), "extra"...))
		}, "SHA-256"},
		{"another-build", func(t *testing.T, r *fakeCursorRelease) {
			r.serve(fakeCursorTarball(t, fakeCursorPackage(fakeCursorShim(t, r.dir, "2026.10.16-e3cb207"))))
		}, "SHA-256"},
		{"not-found", func(t *testing.T, r *fakeCursorRelease) { r.serve(nil) }, "404"},
		{"pinned-hash-of-another-version", func(t *testing.T, r *fakeCursorRelease) {
			other := fakeCursorTarball(t, fakeCursorPackage(fakeCursorShim(t, r.dir, "2026.10.16-e3cb207")))
			r.pin(t, other)
			r.serve(other)
		}, "CURSOR_VERSION_INCOMPATIBLE"},
		{"link-in-package", func(t *testing.T, r *fakeCursorRelease) {
			linked := fakeCursorTarball(t, append(fakeCursorPackage(fakeCursorShim(t, r.dir, cursorSupportedVersion)),
				fakeTarEntry{name: "dist-package/escape", kind: tar.TypeSymlink, link: "/etc"}))
			r.pin(t, linked)
			r.serve(linked)
		}, "neither a file nor a directory"},
		{"path-outside-package", func(t *testing.T, r *fakeCursorRelease) {
			escaping := fakeCursorTarball(t, append(fakeCursorPackage(fakeCursorShim(t, r.dir, cursorSupportedVersion)),
				fakeTarEntry{name: "dist-package/../outside", kind: tar.TypeReg, mode: 0o644, body: []byte("x")}))
			r.pin(t, escaping)
			r.serve(escaping)
		}, "outside dist-package/"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			home := useCursorRealHome(t)
			r := newFakeCursorRelease(t)
			tc.setup(t, r)
			engineInstall.mu.Lock()
			err := installCursor(context.Background(), nil)
			engineInstall.mu.Unlock()
			if err == nil || !strings.HasPrefix(err.Error(), "CURSOR_") || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("installCursor = %v, want a CURSOR_ refusal naming %q", err, tc.want)
			}
			if _, err := os.Lstat(cursorVersionDir()); !os.IsNotExist(err) {
				t.Fatalf("a refused build was published: %v", err)
			}
			if entries, _ := os.ReadDir(cursorVersionsDir()); len(entries) != 0 {
				t.Fatalf("the refused attempt left %v behind", entries)
			}
			if _, err := os.Lstat(filepath.Join(home, ".orbit", "cursor", "outside")); !os.IsNotExist(err) {
				t.Fatal("an entry outside the package was written")
			}
			if _, err := cursorExecutablePath(); err == nil {
				t.Fatal("a refused build is runnable")
			}
			if tc.want == "SHA-256" || tc.want == "404" {
				if calls := r.calls(t); len(calls) != 0 {
					t.Fatalf("a download that failed its check was started: %v", calls)
				}
			}
			assertNoCursorStateIn(t, home)
		})
	}
}

// The CLI never updates itself: every launch says --disable-auto-update and the session's
// cli-config.json pins the channel; a build that updates itself anyway only writes into the session's
// own home, never into the pinned directory or the user's; and the update pass follows the pin —
// no release feed, no `agent update`, no download for a build that is already there.
func TestCursorNeverUpdatesItself(t *testing.T) {
	home := useCursorRealHome(t)
	r := newFakeCursorRelease(t)
	exe := installFakeCursor(t)
	pinned := cursorTreeDigest(t, cursorVersionDir())
	execDir := t.TempDir()
	job := &ClaimedSession{SessionID: "11111111-2222-4333-8444-555555555555", AgentID: "a", TaskID: "t"}
	allowCursorInstall(t, false)

	spec, err := PrepareCursorSessionLaunch(context.Background(), job, execDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if spec.Executable != exe || strings.Join(spec.Args, " ") != "acp --disable-auto-update --disable-indexing --disable-project-configs" {
		t.Fatalf("launch = %s %v, want the pinned build's acp with auto-update disabled", spec.Executable, spec.Args)
	}
	var config map[string]interface{}
	data, err := os.ReadFile(filepath.Join(spec.ConfigDir, "cli-config.json"))
	if err != nil || json.Unmarshal(data, &config) != nil || config["channel"] != "static" {
		t.Fatalf("session cli-config.json = %s, %v: want channel static", data, err)
	}

	run := func(t *testing.T, spec CursorLaunchSpec) {
		t.Helper()
		cmd := exec.CommandContext(context.Background(), spec.Executable, spec.Args...)
		cmd.Dir, cmd.Env = spec.Cwd, spec.Env
		configureSessionProcessTree(cmd)
		stdin, _ := cmd.StdinPipe()
		stdout, _ := cmd.StdoutPipe()
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		defer func() { _ = terminateSessionProcessTree(cmd); _ = cmd.Wait() }()
		_, _ = io.WriteString(stdin, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}`+"\n")
		line, err := bufio.NewReader(stdout).ReadString('\n')
		if err != nil || !strings.Contains(line, `"protocolVersion":1`) {
			t.Fatalf("initialize = %q, %v", line, err)
		}
	}
	t.Run("told-not-to", func(t *testing.T) {
		r.behave(t, "self-update", "unless-disabled")
		run(t, spec)
		if _, err := os.Lstat(filepath.Join(spec.Home, ".local", "share", "cursor-agent")); !os.IsNotExist(err) {
			t.Fatal("a build that honors --disable-auto-update updated itself")
		}
	})
	t.Run("updating-anyway", func(t *testing.T) {
		r.behave(t, "self-update", "always")
		run(t, spec)
		if _, err := os.Lstat(filepath.Join(spec.Home, ".local", "bin", "agent")); err != nil {
			t.Fatalf("the update a stubborn build ran is not in the session's home: %v", err)
		}
		again, err := PrepareCursorSessionLaunch(context.Background(), job, execDir, nil)
		if err != nil || again.Executable != exe {
			t.Fatalf("after a self-update the session launches %q, %v; want the pinned %q", again.Executable, err, exe)
		}
		if cursorTreeDigest(t, cursorVersionDir()) != pinned {
			t.Fatal("the pinned build's directory changed")
		}
		assertNoCursorStateIn(t, home)
	})
	t.Run("update-pass-follows-the-pin", func(t *testing.T) {
		r.behave(t, "self-update", "")
		feed := &dshCountingTransport{}
		previousClient := http.DefaultClient
		http.DefaultClient = &http.Client{Transport: feed}
		t.Cleanup(func() { http.DefaultClient = previousClient })
		previousSpecs := engineSpecs
		engineSpecs = []engineSpec{cursorSpecForTest(t)}
		t.Cleanup(func() { engineSpecs = previousSpecs })
		if got := latestEngineVersion(context.Background(), engineSpecs[0]); got != cursorSupportedVersion {
			t.Fatalf("latest Cursor CLI = %q, want the pin", got)
		}
		calls, requests := len(r.calls(t)), len(r.requestPaths())
		updated := 0
		lines := updateEngines(context.Background(), func(string) int { return 0 }, nil, func() { updated++ })
		if len(lines) != 1 || !strings.Contains(lines[0], "pinned version "+cursorSupportedVersion) || updated != 0 {
			t.Fatalf("update pass = %q (updated %d times)", lines, updated)
		}
		if feed.calls != 0 || len(r.requestPaths()) != requests {
			t.Fatalf("the update pass reached a release feed (%d) or downloaded (%v)", feed.calls, r.requestPaths()[requests:])
		}
		for _, call := range r.calls(t)[calls:] {
			if len(call.Args) != 1 || call.Args[0] != "--version" {
				t.Fatalf("the update pass ran the CLI with %v", call.Args)
			}
		}
		if rec := loadEngineUpdateLog()[providerCursor]; rec.Status != updateChecked || rec.Latest != cursorSupportedVersion || rec.BehindSince != "" {
			t.Fatalf("update record = %+v", rec)
		}
		if cursorTreeDigest(t, cursorVersionDir()) != pinned {
			t.Fatal("the update pass changed the pinned build")
		}
	})
}

// A newly pinned build waits for the sessions on the old one: the pass defers Cursor CLI while one runs,
// installs the new build beside the old once it has finished, and the old build's directory — the one
// the running session was started from — is the same, byte for byte, as the process that runs from it.
func TestCursorUpgradeLeavesRunningSessionsAlone(t *testing.T) {
	home := useCursorRealHome(t)
	r := newFakeCursorRelease(t)
	const previous = "2026.10.01-0000001"
	oldExe := publishFakeCursorVersion(t, r, previous, previous)
	oldDigest := cursorTreeDigest(t, filepath.Dir(oldExe))
	previousSpecs := engineSpecs
	engineSpecs = []engineSpec{cursorSpecForTest(t)}
	t.Cleanup(func() { engineSpecs = previousSpecs })

	root, err := newCursorProbeRoot("orbit-cursor-running-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	session := exec.CommandContext(context.Background(), oldExe, cursorACPArgs()...)
	session.Dir, session.Env = root, append(cursorProbeEnv(root), "CURSOR_API_KEY=session-key")
	configureSessionProcessTree(session)
	stdin, _ := session.StdinPipe()
	stdout, _ := session.StdoutPipe()
	if err := session.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = terminateSessionProcessTree(session); _ = session.Wait() })
	replies := bufio.NewReader(stdout)
	ask := func(id int, method string) string {
		t.Helper()
		if _, err := fmt.Fprintf(stdin, `{"jsonrpc":"2.0","id":%d,"method":%q,"params":{}}`+"\n", id, method); err != nil {
			t.Fatalf("the running session no longer takes input: %v", err)
		}
		line, err := replies.ReadString('\n')
		if err != nil {
			t.Fatalf("the running session stopped answering: %v", err)
		}
		return line
	}
	if line := ask(1, "initialize"); !strings.Contains(line, `"protocolVersion":1`) {
		t.Fatalf("initialize = %q", line)
	}
	running := []string{strconv.Itoa(session.Process.Pid)}
	if markers := cursorInUseMarkers(t, filepath.Dir(oldExe)); strings.Join(markers, ",") != running[0] {
		t.Fatalf("the old build's in-use markers = %v, want the running session's %v", markers, running)
	}

	updated := 0
	lines := updateEngines(context.Background(), func(engine string) int {
		if engine == providerCursor {
			return 1
		}
		return 0
	}, nil, func() { updated++ })
	if len(lines) != 1 || !strings.Contains(lines[0], "1 session running") || !deferredEngineUpdates()[providerCursor] {
		t.Fatalf("busy pass = %q, deferred = %v", lines, deferredEngineUpdates())
	}
	if len(r.requestPaths()) != 0 || updated != 0 {
		t.Fatalf("the pass installed under a running session: %v", r.requestPaths())
	}
	if _, err := os.Lstat(cursorVersionDir()); !os.IsNotExist(err) {
		t.Fatal("the pinned build appeared while a session was running")
	}
	if line := ask(2, "cursor/list_available_models"); !strings.Contains(line, `"models"`) {
		t.Fatalf("the running session's answer after the busy pass = %.200q", line)
	}

	retryDeferredEngineUpdates(context.Background(), func(string) int { return 0 }, nil, func() { updated++ })
	if updated != 1 || deferredEngineUpdates()[providerCursor] || len(r.requestPaths()) != 1 {
		t.Fatalf("idle retry: updated %d, deferred %v, downloads %v", updated, deferredEngineUpdates(), r.requestPaths())
	}
	if exe, err := cursorExecutablePath(); err != nil || filepath.Dir(exe) != cursorVersionDir() {
		t.Fatalf("after the update new sessions start %q, %v", exe, err)
	}
	if cursorTreeDigest(t, filepath.Dir(oldExe)) != oldDigest {
		t.Fatal("the build the running session was started from changed")
	}
	if markers := cursorInUseMarkers(t, filepath.Dir(oldExe)); strings.Join(markers, ",") != running[0] {
		t.Fatalf("after the update the old build's in-use markers = %v, want the running session's %v", markers, running)
	}
	if markers := cursorInUseMarkers(t, cursorVersionDir()); len(markers) != 0 {
		t.Fatalf("the new build is marked in use by %v", markers)
	}
	if line := ask(3, "session/prompt"); !strings.Contains(line, `"code":-32601`) {
		t.Fatalf("the running session's answer after the update = %q", line)
	}
	if session.ProcessState != nil {
		t.Fatal("the running session's process ended during the update")
	}
	if rec := loadEngineUpdateLog()[providerCursor]; rec.Status != updateUpdated {
		t.Fatalf("update record = %+v", rec)
	}
	versions := cursorPublishedVersions()
	sort.Strings(versions)
	if strings.Join(versions, ",") != previous+","+cursorSupportedVersion {
		t.Fatalf("published versions = %v, want the old build kept beside the pinned one", versions)
	}
	assertNoCursorStateIn(t, home)
}
