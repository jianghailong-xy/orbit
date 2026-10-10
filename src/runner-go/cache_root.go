package main

import (
	"os"
	"path/filepath"
)

// Runner-owned shared toolchain caches.
//
// A Codex or DeepSeek Harness session runs its commands under a workspace-write file sandbox that
// leaves the runner user's $HOME read-only, so a toolchain cannot write the cache it picks on its
// own: Go defaults GOCACHE to $HOME/.cache/go-build and npm to ~/.npm, a sandboxed `go build`
// fails with "read-only file system", and the agent invents a cache directory of its own instead.
// That is where this fleet's sprawl of per-session cache names under /tmp came from (rcs-gocache,
// rcs-go-cache, ...), ~7GB of duplicated build cache regrowing ~5GB/day — the growth behind the
// 2026-10-09 OOM.
//
// Sessions therefore point at one cache root the runner owns, on disk under ORBIT_HOME: never the
// user's own ~/.cache, never /tmp (kimi_home.go's overlay states the same philosophy for the state
// a runner manages). Go's build cache and npm's cacache are both safe for concurrent writers, so
// one root for every session of the machine is also what keeps the caches warm.
//
// The Codex sandbox policy carries the root as a writable root, so a confined command may write it.
const (
	runnerCacheGoBuild = "go-build"
	runnerCacheGoMod   = "go-mod"
	runnerCacheNPM     = "npm"
)

// runnerCacheRoot is the shared cache root: machineHome()/caches, beside the runner's other state
// (runs, uploads, worktrees) and on the same disk.
func runnerCacheRoot() string { return filepath.Join(machineHome(), "caches") }

// runnerCacheEnv is the environment that points a session's toolchains at the shared cache root,
// each directory made on first use. An engine hands it to the process it starts — Codex adds it to
// the session process environment, dsh to its launch environment — so every command the agent
// runs, sandboxed or escalated, reads and writes the same cache.
func runnerCacheEnv() []string {
	env := make([]string, 0, 3)
	for _, cache := range []struct{ key, name string }{
		{"GOCACHE", runnerCacheGoBuild},
		{"GOMODCACHE", runnerCacheGoMod},
		{"npm_config_cache", runnerCacheNPM},
	} {
		path := filepath.Join(runnerCacheRoot(), cache.name)
		if err := os.MkdirAll(path, machineHomePerm); err != nil {
			// A toolchain handed this path fails the way it failed on the default one;
			// the session still starts, and this says why its cache was not made.
			logln("shared cache directory unavailable:", err)
		}
		env = append(env, cache.key+"="+path)
	}
	return env
}
