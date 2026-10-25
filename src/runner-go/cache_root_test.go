package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestRunnerCacheEnv: the shared cache root is one directory under ORBIT_HOME — on disk, never a
// temp area, whose tmpfs growth was the OOM trigger — with the three toolchain caches made beneath
// it the moment an engine asks for the environment.
func TestRunnerCacheEnv(t *testing.T) {
	t.Run("under ORBIT_HOME", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("ORBIT_HOME", home)
		want := []struct{ key, dir string }{
			{"GOCACHE", runnerCacheGoBuild},
			{"GOMODCACHE", runnerCacheGoMod},
			{"npm_config_cache", runnerCacheNPM},
		}
		env := runnerCacheEnv()
		if len(env) != len(want) {
			t.Fatalf("runnerCacheEnv() = %q, want %d variables", env, len(want))
		}
		for i, cache := range want {
			path := filepath.Join(home, "caches", cache.dir)
			if env[i] != cache.key+"="+path {
				t.Errorf("runnerCacheEnv()[%d] = %q, want %s=%s", i, env[i], cache.key, path)
			}
			if info, err := os.Stat(path); err != nil || !info.IsDir() {
				t.Errorf("the %s directory was not made on use: %v", path, err)
			}
		}
		if got, wantRoot := runnerCacheRoot(), filepath.Join(home, "caches"); got != wantRoot {
			t.Errorf("runnerCacheRoot() = %q, want %q", got, wantRoot)
		}
	})

	// With ORBIT_HOME unset the root follows the runner's own default home (~/.orbit), and neither
	// TMPDIR nor any other temp area can move it: that is what keeps the caches off tmpfs.
	t.Run("follows the runner home, never a temp area", func(t *testing.T) {
		userHome := t.TempDir()
		t.Setenv("HOME", userHome)
		t.Setenv("ORBIT_HOME", "")
		t.Setenv("TMPDIR", t.TempDir())
		if got, want := runnerCacheRoot(), filepath.Join(userHome, ".orbit", "caches"); got != want {
			t.Errorf("runnerCacheRoot() = %q, want %q", got, want)
		}
	})
}
