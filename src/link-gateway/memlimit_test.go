package main

import (
	"errors"
	"io/fs"
	"runtime/debug"
	"testing"
)

func TestTheMemoryLimitIsTheContainersAllowanceLessATenth(t *testing.T) {
	limit, gogc := debug.SetMemoryLimit(-1), debug.SetGCPercent(-1)
	debug.SetGCPercent(gogc)
	t.Cleanup(func() { debug.SetMemoryLimit(limit); debug.SetGCPercent(gogc) })
	files := func(m map[string]string) func(string) ([]byte, error) {
		return func(name string) ([]byte, error) {
			if v, ok := m[name]; ok {
				return []byte(v), nil
			}
			return nil, fs.ErrNotExist
		}
	}
	none := func(string) string { return "" }
	const gib = int64(1) << 30

	// A container: its cgroup is its root.
	s := applyGCSettings(none, files(map[string]string{"/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/memory.max": "118111600640\n"}))
	if s.MemoryLimit != 118111600640-11811160064 || debug.SetMemoryLimit(-1) != s.MemoryLimit || s.LimitFrom != "/sys/fs/cgroup/memory.max" {
		t.Fatalf("cgroup v2, 110 GiB: %+v, runtime %d", s, debug.SetMemoryLimit(-1))
	}
	// A systemd scope, as gateway-limit.sh starts it: the least allowance of its cgroup and those above it.
	s = applyGCSettings(none, files(map[string]string{
		"/proc/self/cgroup": "0::/system.slice/gl-gateway.scope\n",
		"/sys/fs/cgroup/system.slice/gl-gateway.scope/memory.max": "max\n",
		"/sys/fs/cgroup/system.slice/memory.max":                  "4294967296\n",
	}))
	if s.MemoryLimit != 4*gib-4*gib/10 || s.LimitFrom != "/sys/fs/cgroup/system.slice/memory.max" {
		t.Fatalf("a scope under a 4 GiB slice: %+v", s)
	}
	s = applyGCSettings(none, files(map[string]string{
		"/proc/self/cgroup": "0::/system.slice/gl-gateway.scope\n",
		"/sys/fs/cgroup/system.slice/gl-gateway.scope/memory.max": "2147483648\n",
		"/sys/fs/cgroup/system.slice/memory.max":                  "4294967296\n",
	}))
	if s.MemoryLimit != 2*gib-2*gib/10 || s.LimitFrom != "/sys/fs/cgroup/system.slice/gl-gateway.scope/memory.max" {
		t.Fatalf("a 2 GiB scope: %+v", s)
	}
	if s.GOGC != "200" || debug.SetGCPercent(defaultGOGC) != defaultGOGC {
		t.Fatalf("GOGC: %+v", s)
	}
	s = applyGCSettings(none, files(map[string]string{"/sys/fs/cgroup/memory/memory.limit_in_bytes": "8589934592"}))
	if s.MemoryLimit != 8*gib-8*gib/10 || s.LimitFrom != "/sys/fs/cgroup/memory/memory.limit_in_bytes" {
		t.Fatalf("cgroup v1, 8 GiB: %+v", s)
	}
	// No allowance: no limit is set.
	debug.SetMemoryLimit(limit)
	for _, m := range []map[string]string{
		{"/proc/self/cgroup": "0::/", "/sys/fs/cgroup/memory.max": "max"},
		{"/proc/self/cgroup": "0::/user.slice/x.scope"},
		{"/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712"},
		{},
	} {
		if s := applyGCSettings(none, files(m)); s.MemoryLimit != 0 || debug.SetMemoryLimit(-1) != limit {
			t.Fatalf("%v: %+v", m, s)
		}
	}
	// The environment's own settings stand.
	env := func(name string) string {
		return map[string]string{"GOMEMLIMIT": "1GiB", "GOGC": "50"}[name]
	}
	debug.SetGCPercent(50)
	s = applyGCSettings(env, func(string) ([]byte, error) { return nil, errors.New("not read") })
	if s.LimitFrom != "GOMEMLIMIT" || s.GOGC != "50 (GOGC)" || debug.SetGCPercent(50) != 50 {
		t.Fatalf("GOMEMLIMIT and GOGC set: %+v", s)
	}
}
