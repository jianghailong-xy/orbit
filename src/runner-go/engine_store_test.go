package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// The managed runner image ships Cursor CLI's and DeepSeek Harness's pinned builds in a read-only directory
// of its own (ORBIT_ENGINE_STORE): the runner finds them there, while a Cursor account, its usage and the
// rest of the runner's state stay in Orbit's home on the user's volume.
func TestEngineStoreMovesOnlyPinnedBuilds(t *testing.T) {
	home, store := t.TempDir(), t.TempDir()
	t.Setenv("ORBIT_HOME", home)

	t.Setenv("ORBIT_ENGINE_STORE", "")
	if got, want := cursorVersionDir(), filepath.Join(home, "cursor", "versions", cursorSupportedVersion); got != want {
		t.Fatalf("cursor version dir without a store = %s, want %s", got, want)
	}
	if got, want := dshVersionDir(), filepath.Join(home, "engines", providerDsh, dshSupportedVersion); got != want {
		t.Fatalf("dsh version dir without a store = %s, want %s", got, want)
	}

	t.Setenv("ORBIT_ENGINE_STORE", store)
	if got, want := cursorVersionDir(), filepath.Join(store, "cursor", "versions", cursorSupportedVersion); got != want {
		t.Fatalf("cursor version dir = %s, want %s", got, want)
	}
	if got, want := dshVersionDir(), filepath.Join(store, "engines", providerDsh, dshSupportedVersion); got != want {
		t.Fatalf("dsh version dir = %s, want %s", got, want)
	}
	for name, got := range map[string]string{
		"cursor account": cursorDefaultAccountDir(),
		"cursor usage":   cursorUsageLimitsPath(),
		"dsh node":       dshNodeDir(),
		"config":         configPath(),
	} {
		if !strings.HasPrefix(got, home+string(filepath.Separator)) {
			t.Fatalf("%s = %s, want it under Orbit's home %s", name, got, home)
		}
	}
}

// The managed runner image installs Cursor CLI and DeepSeek Harness itself, into the version directories
// this runner looks in: the build, digest and size it fetches must be the ones the runner pins, or the
// runner refuses what the image ships.
func TestManagedImageShipsThePinnedCursorAndHarness(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "deploy", "managed-runner", "image", "Dockerfile"))
	if err != nil {
		t.Fatal(err)
	}
	dockerfile := string(data)
	cursor := cursorArtifacts["linux/amd64"]
	for _, want := range []string{
		"ORBIT_ENGINE_STORE=/opt/orbit-engines",
		"/opt/orbit-engines/cursor/versions/" + cursorSupportedVersion,
		cursorDownloadBase + "/" + cursorSupportedVersion + "/" + cursor.path + "/agent-cli-package.tar.gz",
		cursor.sha256,
		strconv.FormatInt(cursor.size, 10),
		"/opt/orbit-engines/engines/" + providerDsh + "/" + dshSupportedVersion,
		"src/runner-go/dsh-install/package-lock.json",
	} {
		if !strings.Contains(dockerfile, want) {
			t.Errorf("the managed image's Dockerfile does not name %q", want)
		}
	}
}
