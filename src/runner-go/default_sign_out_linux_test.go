//go:build linux

package main

import (
	"os"
	"path/filepath"
	"testing"
)

// Antigravity: the sign-out deletes the Google sign-in's token file and nothing else in its Gemini
// directory, and the engine then reports Default signed out. Linux only for the recorded agy probe that
// shows it signed in first (replayGoogleProbe).
func TestDefaultSignOutAntigravityDeletesOnlyTheTokenFile(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv("GEMINI_API_KEY", "")
	bin := replayGoogleProbe(t, loadGoogleProbeRecording(t, "google-auth-print-usage.json"))
	root := antigravityGoogleDir()
	token := antigravityGoogleTokenPath()
	rel, _ := filepath.Rel(root, token)
	siblings := []string{"antigravity-cli/settings.json", "antigravity-cli/conversations/abc.pb", "antigravity-cli/history.jsonl"}
	writeSiblings(t, root, append([]string{rel}, siblings[1:]...)...)
	// agy reads its settings as JSON (antigravityGoogleCommand).
	if err := os.WriteFile(filepath.Join(root, siblings[0]), []byte(`{"theme":"dark"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	spec := engineSpec{name: "Antigravity", bin: providerAntigravity, exe: "agy"}
	assertDefaultSignedIn(t, probeEngines([]engineSpec{spec}, filepath.Dir(bin)))

	before := fileDigests(t, root)
	signOutDone(t, providerAntigravity)
	assertOnlyRemoved(t, before, fileDigests(t, root), []string{rel}, siblings)
	assertDefaultSignedOut(t, probeEngines([]engineSpec{spec}, filepath.Dir(bin)))
}
