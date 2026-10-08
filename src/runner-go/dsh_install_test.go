package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type dshInstallFixture struct {
	root, bins, npmRuns, npmArgs, lockCopy, packageCopy, calls string
}

type dshCountingTransport struct{ calls int }

func (tr *dshCountingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	tr.calls++
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"version":"99.0.0"}`)), Header: make(http.Header)}, nil
}

func fakeDshInstall(t *testing.T, mode string) dshInstallFixture {
	t.Helper()
	root := t.TempDir()
	f := dshInstallFixture{root: root, bins: filepath.Join(root, "bin"), npmRuns: filepath.Join(root, "npm-runs"), npmArgs: filepath.Join(root, "npm-args"), lockCopy: filepath.Join(root, "captured-lock"), packageCopy: filepath.Join(root, "captured-package"), calls: filepath.Join(root, "dsh-calls")}
	if err := os.MkdirAll(f.bins, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ORBIT_HOME", filepath.Join(root, "orbit"))
	t.Setenv("PATH", f.bins+":/usr/bin:/bin")
	priorPath := dshServicePath
	dshServicePath = func() string { return f.bins + ":/usr/bin:/bin" }
	t.Cleanup(func() { dshServicePath = priorPath })
	configureEngineInstall(false, nil)
	t.Cleanup(func() { configureEngineInstall(false, nil); clearDeferredEngineUpdate(providerDsh) })
	writeDshInstallExecutable(t, filepath.Join(f.bins, "node"), "#!/bin/sh\nprintf 'v26.10.0\\n'\n")
	version := dshSupportedVersion
	if mode == "bad-version" {
		version = "0.2.0-rc.1"
	}
	engine := filepath.Join(root, "fake-dsh")
	engineBody := "#!/bin/sh\n[ -n \"$DSH_HOME\" ] && [ \"$DSH_HOME\" != \"$HOME/.dsh\" ] || exit 96\n[ -z \"$ORBIT_DSH_API_KEY$DEEPSEEK_API_KEY$ANTHROPIC_API_KEY\" ] || exit 97\nprintf '%s\\n' \"$*\" >> " + shellQuote(f.calls) + "\n[ \"$1\" = --version ] || exit 91\nprintf '%s\\n' " + shellQuote(version) + "\n"
	if mode == "startup-fails" {
		engineBody = "#!/bin/sh\nexit 42\n"
	}
	writeDshInstallExecutable(t, engine, engineBody)
	body := "#!/bin/sh\nprintf 'ran\\n' >> " + shellQuote(f.npmRuns) + "\nprintf '%s\\n' \"$@\" > " + shellQuote(f.npmArgs) + "\n[ \"$1\" = ci ] && [ \"$2\" = --prefix ] || exit 94\n/bin/cp \"$3/package-lock.json\" " + shellQuote(f.lockCopy) + "\n/bin/cp \"$3/package.json\" " + shellQuote(f.packageCopy) + "\n"
	switch mode {
	case "npm-fails":
		body += "printf 'sk-fake-npm-sensitive-output\\n'\nexit 43\n"
	case "no-entry":
		body += "exit 0\n"
	default:
		body += "/bin/mkdir -p \"$3/node_modules/.bin\" \"$3/node_modules/@deepseek-ai/dsh/lib\"\n/bin/cp " + shellQuote(engine) + " \"$3/node_modules/@deepseek-ai/dsh/lib/bin.js\"\n/bin/chmod 700 \"$3/node_modules/@deepseek-ai/dsh/lib/bin.js\"\n/bin/ln -s ../@deepseek-ai/dsh/lib/bin.js \"$3/node_modules/.bin/dsh\"\n"
	}
	writeDshInstallExecutable(t, filepath.Join(f.bins, "npm"), body)
	return f
}

func writeDshInstallExecutable(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
}

func publishedFakeDsh(t *testing.T, version string) string {
	t.Helper()
	dir := filepath.Join(filepath.Dir(dshVersionDir()), version)
	path := filepath.Join(dir, "node_modules", ".bin", providerDsh)
	writeDshInstallExecutable(t, path, "#!/bin/sh\n[ \"$1\" = --version ] || exit 92\nprintf '%s\\n' "+shellQuote(version)+"\n")
	return path
}

func TestDshInstallRequiresConsent(t *testing.T) {
	f := fakeDshInstall(t, "ok")
	msg := ensureEngine(context.Background(), providerDsh, func(string) { t.Error("install was announced without consent") })
	if !strings.Contains(msg, "not authorized") || !strings.Contains(msg, dshSupportedVersion) {
		t.Fatalf("missing consent diagnostic: %q", msg)
	}
	if _, err := os.Stat(f.npmRuns); !os.IsNotExist(err) {
		t.Fatal("automatic install ran without authorization")
	}
	spec, _ := specFor(providerDsh)
	if result := installEngineNow(spec); result.Status != installDone {
		t.Fatalf("explicit browser install is its own consent: %+v", result)
	}
	if msg := ensureEngine(context.Background(), providerDsh, nil); msg != "" {
		t.Fatalf("already installed runtime should need no install permission: %s", msg)
	}
}

func TestDshInstallUsesFrozenLockAndImmutableVersion(t *testing.T) {
	f := fakeDshInstall(t, "ok")
	configureEngineInstall(true, nil)
	var wg sync.WaitGroup
	errs := make(chan string, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); errs <- ensureEngine(context.Background(), providerDsh, nil) }()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != "" {
			t.Fatal(err)
		}
	}
	for path, expected := range map[string][]byte{f.lockCopy: dshPackageLock, f.packageCopy: dshPackageJSON} {
		got, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(got, expected) {
			t.Fatalf("installer did not receive frozen P0 asset %s", path)
		}
	}
	for name, embedded := range map[string][]byte{"package-lock.json": dshPackageLock, "package.json": dshPackageJSON} {
		source, err := os.ReadFile(filepath.Join("..", "..", "scripts", "deepseek-harness-p0", name))
		if err != nil || !bytes.Equal(source, embedded) {
			t.Fatalf("embedded %s differs from predecessor's frozen P0 artifact", name)
		}
	}
	args, _ := os.ReadFile(f.npmArgs)
	if !strings.HasPrefix(string(args), "ci\n--prefix\n") || strings.Contains(string(args), "latest") || !strings.Contains(string(args), "--cache\n") {
		t.Fatalf("installer is not fixed-version local npm ci: %s", args)
	}
	runs, _ := os.ReadFile(f.npmRuns)
	if strings.Count(string(runs), "ran") != 1 {
		t.Fatalf("concurrent sessions ran installer %q", runs)
	}
	path, err := dshExecutablePath()
	if err != nil || !filepath.IsAbs(path) || strings.Contains(path, ".bin") || !strings.HasPrefix(path, dshVersionDir()+string(os.PathSeparator)) {
		t.Fatalf("runtime launch is not pinned into immutable directory: %q, %v", path, err)
	}
	before, _ := os.ReadFile(path)
	if result := installEngineNow(engineSpec{bin: providerDsh}); result.Status != installDone {
		t.Fatalf("repeated install failed: %+v", result)
	}
	after, _ := os.ReadFile(path)
	runs, _ = os.ReadFile(f.npmRuns)
	if !bytes.Equal(before, after) || strings.Count(string(runs), "ran") != 1 {
		t.Fatal("a published version was rewritten")
	}
	// A user's global CLI is ignored, including when it is a newer release.
	writeDshInstallExecutable(t, filepath.Join(f.bins, "dsh"), "#!/bin/sh\nexit 95\n")
	if found, ok := lookEngine(providerDsh); !ok || found != path {
		t.Fatalf("user's global dsh took precedence: %q, %v", found, ok)
	}
}

func TestDshInstallRejectsStartupAndVersionFailures(t *testing.T) {
	for _, mode := range []string{"npm-fails", "no-entry", "startup-fails", "bad-version"} {
		t.Run(mode, func(t *testing.T) {
			fakeDshInstall(t, mode)
			configureEngineInstall(true, nil)
			msg := ensureEngine(context.Background(), providerDsh, nil)
			if msg == "" || strings.Contains(msg, "sk-fake-npm-sensitive-output") {
				t.Fatalf("failed install had no safe diagnostic: %q", msg)
			}
			if _, err := os.Stat(dshVersionDir()); !os.IsNotExist(err) {
				t.Fatal("an unvalidated installation was published")
			}
			entries, err := os.ReadDir(filepath.Dir(dshVersionDir()))
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range entries {
				if strings.HasPrefix(entry.Name(), ".install-") {
					t.Fatal("failed staging installation was retained")
				}
			}
		})
	}
	// Never silently rewrite a published but incompatible version directory.
	f := fakeDshInstall(t, "ok")
	path := publishedFakeDsh(t, dshSupportedVersion)
	writeDshInstallExecutable(t, path, "#!/bin/sh\nprintf '0.2.0-rc.1\\n'\n")
	configureEngineInstall(true, nil)
	if msg := ensureEngine(context.Background(), providerDsh, nil); !strings.Contains(msg, "version incompatible") {
		t.Fatalf("version mismatch was not explained: %q", msg)
	}
	if _, err := os.Stat(f.npmRuns); !os.IsNotExist(err) {
		t.Fatal("version mismatch silently rewrote immutable directory")
	}
}

func TestDshVersionAndPlatformAdmission(t *testing.T) {
	for _, version := range []string{"0.2.0-rc.1", "0.2.0", "0.2.0-rc.20", "0.0.1", "dsh 0.2.0-rc.2", "0.3.0", ""} {
		if dshVersionCompatible(version) {
			t.Fatalf("unsupported or ACP plugin version accepted: %q", version)
		}
	}
	if !dshVersionCompatible(dshSupportedVersion) {
		t.Fatal("frozen P0 version rejected")
	}
	for _, platform := range [][3]string{{"darwin", "arm64", "v26.10.0"}, {"windows", "amd64", "v26.10.0"}, {"linux", "arm64", "v26.10.0"}, {"linux", "amd64", "v22.19.0"}, {"linux", "amd64", "v24.0.0"}, {"linux", "amd64", "v27.0.0"}} {
		if dshPlatformAdmission(platform[0], platform[1], platform[2]) == nil {
			t.Fatalf("unproven platform admitted: %v", platform)
		}
	}
	if err := dshPlatformAdmission("linux", "amd64", "v26.10.0"); err != nil {
		t.Fatal(err)
	}
	f := fakeDshInstall(t, "ok")
	writeDshInstallExecutable(t, filepath.Join(f.bins, "node"), "#!/bin/sh\nprintf 'v24.0.0\\n'\n")
	configureEngineInstall(true, nil)
	if msg := ensureEngine(context.Background(), providerDsh, nil); !strings.Contains(msg, "Node 26") {
		t.Fatalf("incompatible runtime lacks repair diagnostic: %q", msg)
	}
	if _, err := os.Stat(f.npmRuns); !os.IsNotExist(err) {
		t.Fatal("installer ran on unsupported runtime")
	}
	writeDshInstallExecutable(t, filepath.Join(f.bins, "node"), "#!/bin/sh\nprintf 'v26.10.0\\n'\n")
	path := publishedFakeDsh(t, dshSupportedVersion)
	writeDshInstallExecutable(t, path, "#!/bin/sh\nprintf 'opaque-upstream-secret\\n'\n")
	version, err := dshProbeVersion(path)
	if version != "" || err == nil || strings.Contains(err.Error(), "opaque-upstream-secret") {
		t.Fatal("malformed version output entered diagnostics")
	}
}

func TestDshHealthSeparatesInstallFromAuthentication(t *testing.T) {
	f := fakeDshInstall(t, "ok")
	configureEngineInstall(true, nil)
	if msg := ensureEngine(context.Background(), providerDsh, nil); msg != "" {
		t.Fatal(msg)
	}
	t.Setenv("ORBIT_DSH_API_KEY", "sk-host-key-must-not-authenticate")
	noteDshCatalogRead(false)
	t.Cleanup(func() { noteDshCatalogRead(false) })
	spec, _ := specFor(providerDsh)
	reports := probeEngines([]engineSpec{spec}, f.bins)
	if len(reports) != 1 || !reports[0].Installed || reports[0].Auth != "unknown" || reports[0].Dsh == nil {
		t.Fatalf("incorrect dsh install/auth report: %+v", reports)
	}
	h := reports[0].Dsh
	if !h.VersionCompatible || h.CredentialPresent || h.ModelCatalogReadable || h.RequestValidation != "unknown" {
		t.Fatalf("installation falsely proves authentication/catalog: %+v", h)
	}
	calls, _ := os.ReadFile(f.calls)
	for _, call := range strings.Fields(string(calls)) {
		if call != "--version" {
			t.Fatalf("health executed authentication or model request: %q", calls)
		}
	}
	encoded, _ := json.Marshal(reports)
	if strings.Contains(string(encoded), "sk-host-key") {
		t.Fatal("API health output leaked inherited credential")
	}
	path, _ := dshExecutablePath()
	noteDshCatalogRead(true)
	writeDshInstallExecutable(t, path, "#!/bin/sh\nprintf '0.2.0-rc.1\\n'\n")
	reports = probeEngines([]engineSpec{spec}, f.bins)
	if !reports[0].Installed || reports[0].Dsh.VersionCompatible || reports[0].Dsh.ModelCatalogReadable || !strings.Contains(reports[0].InstallationError, "version incompatible") || reports[0].Auth != "unknown" {
		t.Fatalf("incompatible version conflated with absence or login: %+v", reports[0])
	}
	if line := formatEngineLine(checkEngine(spec, f.bins)); !strings.Contains(line, "DSH_VERSION_INCOMPATIBLE") {
		t.Fatalf("doctor hides incompatible installation: %q", line)
	}
}

func TestDshTransientProbeFailureNeverPanics(t *testing.T) {
	f := fakeDshInstall(t, "ok")
	path := publishedFakeDsh(t, dshSupportedVersion)
	marker := filepath.Join(f.root, "probe-once")
	writeDshInstallExecutable(t, path, "#!/bin/sh\nif [ ! -e "+shellQuote(marker)+" ]; then touch "+shellQuote(marker)+"; exit 42; fi\nprintf '"+dshSupportedVersion+"\\n'\n")
	if msg := ensureEngine(context.Background(), providerDsh, nil); !strings.Contains(msg, "DSH_INSTALL_FAILED") {
		t.Fatalf("transient probe failure lacked a diagnostic: %q", msg)
	}
	if msg := ensureEngine(context.Background(), providerDsh, nil); msg != "" {
		t.Fatalf("next clean probe failed: %q", msg)
	}
	if _, err := os.Stat(f.npmRuns); !os.IsNotExist(err) {
		t.Fatal("transient probe caused the immutable runtime to be reinstalled")
	}
}

func TestDshImmutableVersionRejectsExternalDirectory(t *testing.T) {
	f := fakeDshInstall(t, "ok")
	path := publishedFakeDsh(t, dshSupportedVersion)
	versionRoot := dshVersionDir()
	external := filepath.Join(f.root, "user-global-dsh")
	if err := os.Rename(versionRoot, external); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, versionRoot); err != nil {
		t.Fatal(err)
	}
	if _, err := dshExecutablePath(); err == nil || !strings.Contains(err.Error(), "cannot be a symlink") {
		t.Fatal("mutable external directory accepted as a published runtime")
	}
	if _, err := os.Stat(filepath.Join(external, strings.TrimPrefix(path, versionRoot+string(os.PathSeparator)))); err != nil {
		t.Fatal("external runtime changed")
	}
}

func TestDshUpdatePinsVersionAndProtectsActiveSessions(t *testing.T) {
	f := fakeDshInstall(t, "ok")
	old := publishedFakeDsh(t, "0.1.0")
	oldBytes, _ := os.ReadFile(old)
	transport := &dshCountingTransport{}
	priorClient := http.DefaultClient
	http.DefaultClient = &http.Client{Transport: transport}
	t.Cleanup(func() { http.DefaultClient = priorClient })
	spec, _ := specFor(providerDsh)
	spec.latestURL, spec.latestField = "https://dsh-version-feed.invalid/latest", "version"
	priorSpecs := engineSpecs
	engineSpecs = []engineSpec{spec}
	t.Cleanup(func() { engineSpecs = priorSpecs })
	if got := latestEngineVersion(context.Background(), spec); got != dshSupportedVersion || transport.calls != 0 {
		t.Fatalf("dsh followed latest: %q, requests=%d", got, transport.calls)
	}
	lines := updateEngines(context.Background(), func(string) int { return 2 }, nil, nil)
	if len(lines) != 1 || !strings.Contains(lines[0], "2 sessions") || !deferredEngineUpdates()[providerDsh] {
		t.Fatalf("active sessions did not protect update: %q", lines)
	}
	if _, err := os.Stat(f.npmRuns); !os.IsNotExist(err) {
		t.Fatal("update installer ran during active sessions")
	}
	updated := 0
	retryDeferredEngineUpdates(context.Background(), func(string) int { return 0 }, nil, func() { updated++ })
	if updated != 1 || deferredEngineUpdates()[providerDsh] {
		t.Fatalf("idle update did not stage supported version: callbacks=%d", updated)
	}
	if _, err := dshExecutablePath(); err != nil {
		t.Fatal(err)
	}
	retained, _ := os.ReadFile(old)
	if !bytes.Equal(oldBytes, retained) {
		t.Fatal("previous install/recovery path changed during update")
	}
	probeMarker := filepath.Join(f.root, "update-probe-once")
	entry, err := dshExecutableIn(dshVersionDir())
	if err != nil {
		t.Fatal(err)
	}
	writeDshInstallExecutable(t, entry, "#!/bin/sh\nif [ -e "+shellQuote(probeMarker)+" ]; then printf 'unexpected' >> "+shellQuote(probeMarker)+"; exit 42; fi\ntouch "+shellQuote(probeMarker)+"\nprintf '"+dshSupportedVersion+"\\n'\n")
	recordEngineUpdate(providerDsh, updateChecked, "previous version", engineUpdateFacts{installed: "0.1.0", latest: dshSupportedVersion})
	rec, _ := updateEngine(context.Background(), spec, f.bins, nil)
	if rec.Status != updateChecked || rec.BehindSince != "" || rec.Latest != dshSupportedVersion || transport.calls != 0 {
		t.Fatalf("supported version did not remain pinned: %+v", rec)
	}
	probes, err := os.ReadFile(probeMarker)
	if err != nil || len(probes) != 0 {
		t.Fatal("update repeated an already successful version probe")
	}
	runs, _ := os.ReadFile(f.npmRuns)
	if strings.Count(string(runs), "ran") != 1 {
		t.Fatalf("pinned-version check reran package manager: %q", runs)
	}
}
