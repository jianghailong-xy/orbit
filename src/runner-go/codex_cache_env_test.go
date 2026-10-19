//go:build linux || darwin

package main

import (
	"context"
	"path/filepath"
	"testing"
)

// TestCodexAppServerSessionCacheEnv: the environment a Codex session process is actually started
// with points its toolchains at the runner-owned shared cache root, so a sandboxed command reads
// and writes one cache for the whole machine instead of the read-only $HOME/.cache — or a
// directory the agent invents when that fails.
func TestCodexAppServerSessionCacheEnv(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	dir := t.TempDir()
	capture := fakeEngineCapturingEnv(t, providerCodex)
	job := &ClaimedSession{
		SessionID: "019fcbf3-0fa8-7f83-9302-46b25389cb16",
		Agent:     AgentExecConfig{PermissionMode: "auto"},
	}
	ignore := func(string, map[string]interface{}) {}
	app, err := startCodexAppServer(context.Background(), job, dir, dir, envWithAgent(job.Agent.Env), ignore, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		app.cancel()
		_ = app.cmd.Wait()
	})
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
