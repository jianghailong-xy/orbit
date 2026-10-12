package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const (
	sha256TestCurrent = "0.1.200"
	sha256TestRelease = "0.1.300"

	upgradeHelperServerEnv = "ORBIT_UPGRADE_HELPER_SERVER"
	upgradeHelperTargetEnv = "ORBIT_UPGRADE_HELPER_TARGET"
)

// fakeRelease is a release as /dl serves it: a gzip'd executable past downloadAndSwap's 1 MB floor
// that answers `version` and `capabilities --json` the way a real build of ver does. Two builds
// with different labels pass every check but the sha256 alike.
func fakeRelease(t *testing.T, ver, build string) (binary, gz []byte) {
	t.Helper()
	capabilities := fmt.Sprintf(`{"serverCapabilityRevision":%d,"serverSchemaRevision":%d,"contractDigest":"%s"}`,
		runnerWriteCapabilityRevision, runnerWriteSchemaRevision, runnerWriteContractDigest)
	binary = []byte("#!/bin/sh\n# build: " + build + "\n" +
		"case \"$1\" in\n" +
		"version) echo " + ver + " ;;\n" +
		"capabilities) echo '" + capabilities + "' ;;\n" +
		"esac\n" +
		"exit 0\n" +
		strings.Repeat("# padding past downloadAndSwap's 1 MB floor\n", 30_000))
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(binary); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return binary, buf.Bytes()
}

func sha256TestManifest(assets map[string]ManifestAsset) Manifest {
	return Manifest{
		Version:                   sha256TestRelease,
		CapabilityRevision:        runnerWriteCapabilityRevision,
		SchemaRevision:            runnerWriteSchemaRevision,
		MinimumCapabilityRevision: runnerWriteMinimumCapabilityRevision,
		MinimumSchemaRevision:     runnerWriteMinimumSchemaRevision,
		ContractDigest:            runnerWriteContractDigest,
		Assets:                    assets,
	}
}

// publishedAssets is what scripts/build-binaries.sh publishes for gz on this platform.
func publishedAssets(gz []byte) map[string]ManifestAsset {
	sum := sha256.Sum256(gz)
	key := platformKey()
	return map[string]ManifestAsset{key: {File: "orbit-" + key + ".gz", SHA256: hex.EncodeToString(sum[:])}}
}

// serveRelease answers the way a control plane's /dl does: the manifest, and gz as this platform's
// download.
func serveRelease(t *testing.T, manifest Manifest, gz []byte) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/dl/version.json":
			_ = json.NewEncoder(w).Encode(manifest)
		case "/dl/orbit-" + platformKey() + ".gz":
			_, _ = w.Write(gz)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// installedBinary stands in for the running executable an update replaces, alone in its directory.
func installedBinary(t *testing.T) string {
	t.Helper()
	exe := filepath.Join(t.TempDir(), "orbit")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\necho "+sha256TestCurrent+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return exe
}

// assertInstalled checks that exe holds want and that no download was left beside it.
func assertInstalled(t *testing.T, exe string, want []byte) {
	t.Helper()
	got, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("%s holds %d bytes beginning %q; want %d bytes beginning %q",
			exe, len(got), got[:min(len(got), 40)], len(want), want[:min(len(want), 40)])
	}
	entries, err := os.ReadDir(filepath.Dir(exe))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("install directory holds %v; want only %s", names, filepath.Base(exe))
	}
}

func TestDownloadAndSwapChecksPublishedSHA256(t *testing.T) {
	key := platformKey()
	if key == "" {
		t.Skip("self-update is unsupported on this test platform")
	}
	genuine, genuineGz := fakeRelease(t, sha256TestRelease, "genuine")
	tampered, tamperedGz := fakeRelease(t, sha256TestRelease, "tampered")
	tamperedSum := sha256.Sum256(tamperedGz)

	for _, tc := range []struct {
		name    string
		assets  map[string]ManifestAsset
		served  []byte
		install []byte // nil: the current binary stays
		log     []string
	}{{
		name:    "matching sha256 installs",
		assets:  publishedAssets(genuineGz),
		served:  genuineGz,
		install: genuine,
	}, {
		name:   "mismatched sha256 keeps the current version",
		assets: publishedAssets(genuineGz),
		served: tamperedGz,
		log: []string{"downloaded orbit-" + key + ".gz has sha256 " + hex.EncodeToString(tamperedSum[:]),
			"but version.json publishes " + publishedAssets(genuineGz)[key].SHA256, "keeping current version"},
	}, {
		// The same build the mismatch refuses passes every other check: without a digest to
		// compare, it is what the update installs — the behavior before asset digests existed.
		name:    "no sha256 from an older control plane installs with a warning",
		assets:  nil,
		served:  tamperedGz,
		install: tampered,
		log:     []string{"warning: version.json publishes no sha256 for orbit-" + key + ".gz", "installing it unverified"},
	}} {
		t.Run(tc.name, func(t *testing.T) {
			exe := installedBinary(t)
			current, err := os.ReadFile(exe)
			if err != nil {
				t.Fatal(err)
			}
			old := selfUpdateTarget
			selfUpdateTarget = func() (string, error) { return exe, nil }
			t.Cleanup(func() { selfUpdateTarget = old })
			manifest := sha256TestManifest(tc.assets)
			srv := serveRelease(t, manifest, tc.served)

			var log strings.Builder
			ok := downloadAndSwap(srv.URL, key, manifest, func(s string) { log.WriteString(s) })
			t.Logf("downloadAndSwap = %v, log: %q", ok, log.String())

			if want := tc.install != nil; ok != want {
				t.Fatalf("downloadAndSwap = %v; want %v", ok, want)
			}
			if tc.install != nil {
				assertInstalled(t, exe, tc.install)
			} else {
				assertInstalled(t, exe, current)
			}
			for _, want := range tc.log {
				if !strings.Contains(log.String(), want) {
					t.Errorf("log %q does not say %q", log.String(), want)
				}
			}
			if len(tc.log) == 0 && log.Len() > 0 {
				t.Errorf("log %q; want nothing", log.String())
			}
		})
	}
}

// `orbit upgrade` installs through the same downloadAndSwap: it refuses the same mismatch and
// still installs a release that matches. upgrade ends its process, so it runs in a child copy of
// this test binary (TestUpgradeSHA256Helper).
func TestUpgradeChecksPublishedSHA256(t *testing.T) {
	key := platformKey()
	if key == "" {
		t.Skip("self-update is unsupported on this test platform")
	}
	genuine, genuineGz := fakeRelease(t, sha256TestRelease, "genuine")
	_, tamperedGz := fakeRelease(t, sha256TestRelease, "tampered")
	manifest := sha256TestManifest(publishedAssets(genuineGz))

	for _, tc := range []struct {
		name    string
		served  []byte
		install []byte // nil: the current binary stays
		exit    int
		output  []string
	}{{
		name:    "matching sha256 installs",
		served:  genuineGz,
		install: genuine,
		exit:    0,
		output:  []string{"✓ orbit is now " + sha256TestRelease},
	}, {
		name:   "mismatched sha256 keeps the current version",
		served: tamperedGz,
		exit:   1,
		output: []string{"but version.json publishes " + manifest.Assets[key].SHA256 + "; keeping current version",
			"upgrade failed."},
	}} {
		t.Run(tc.name, func(t *testing.T) {
			exe := installedBinary(t)
			current, err := os.ReadFile(exe)
			if err != nil {
				t.Fatal(err)
			}
			srv := serveRelease(t, manifest, tc.served)

			cmd := exec.Command(os.Args[0], "-test.run=^TestUpgradeSHA256Helper$")
			cmd.Env = append(os.Environ(), upgradeHelperServerEnv+"="+srv.URL, upgradeHelperTargetEnv+"="+exe)
			out, err := cmd.CombinedOutput()
			t.Logf("orbit upgrade output:\n%s", out)
			exit := 0
			var exitErr *exec.ExitError
			if errors.As(err, &exitErr) {
				exit = exitErr.ExitCode()
			} else if err != nil {
				t.Fatal(err)
			}

			if exit != tc.exit {
				t.Errorf("orbit upgrade exited %d; want %d", exit, tc.exit)
			}
			if tc.install != nil {
				assertInstalled(t, exe, tc.install)
			} else {
				assertInstalled(t, exe, current)
			}
			for _, want := range tc.output {
				if !strings.Contains(string(out), want) {
					t.Errorf("orbit upgrade output does not say %q", want)
				}
			}
		})
	}
}

// TestUpgradeSHA256Helper is the child half of TestUpgradeChecksPublishedSHA256: `orbit upgrade`
// at version sha256TestCurrent against the server it is handed, replacing the binary it is handed.
func TestUpgradeSHA256Helper(t *testing.T) {
	server := os.Getenv(upgradeHelperServerEnv)
	if server == "" {
		t.Skip("child process of TestUpgradeChecksPublishedSHA256")
	}
	version = sha256TestCurrent
	target := os.Getenv(upgradeHelperTargetEnv)
	selfUpdateTarget = func() (string, error) { return target, nil }
	upgrade(server)
	os.Exit(0)
}
