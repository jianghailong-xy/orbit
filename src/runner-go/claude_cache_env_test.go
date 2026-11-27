//go:build linux || darwin

package main

import (
	"context"
	"path/filepath"
	"testing"
)

// TestSpawnClaudeSessionCacheEnv: the environment a Claude session process is actually started with points
// its toolchains at the runner-owned shared cache root, as a Codex or dsh session's does, so a Go build or an
// npm install in any session of the machine reads and writes one cache on the data volume.
func TestSpawnClaudeSessionCacheEnv(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	capture := fakeEngineCapturingEnv(t, "claude")
	job := &ClaimedSession{SessionID: "019fcbf3-0fa8-7f83-9302-46b25389cb16"}
	proc, err := spawnClaude(context.Background(), job, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { proc.stdin.Close(); _ = proc.cmd.Wait() })
	env := readCapturedEnv(t, capture)
	for key, sub := range map[string]string{
		"GOCACHE": runnerCacheGoBuild, "GOMODCACHE": runnerCacheGoMod, "npm_config_cache": runnerCacheNPM,
	} {
		want := filepath.Join(home, "caches", sub)
		if got := envValue(env, key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
}
