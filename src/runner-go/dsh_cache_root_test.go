package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// dshRealCacheRootScenario roots the scenario's tree — and with it newDshRealHarness's ORBIT_HOME,
// and so the shared cache root — in the runner user's home, where a production ORBIT_HOME stands.
// The workspace-write sandbox grants the platform temp areas themselves (dsh's writableRoots), so
// a cache root that already sat in one could not tell a sandbox grant from the temp grant.
func dshRealCacheRootScenario(t *testing.T) {
	t.Helper()
	previous := dshRealHarnessParentDir
	dshRealHarnessParentDir = userHome()
	t.Cleanup(func() { dshRealHarnessParentDir = previous })
}

// dshCacheRoot is the session's own shared cache root, asserted to be its own and to stand
// outside every platform temp area: both are what the scenario's point rests on.
func dshCacheRoot(t *testing.T, ambient string) string {
	t.Helper()
	cache := runnerCacheRoot()
	outside := cache != ambient
	for _, temp := range []string{"/tmp", os.TempDir()} {
		outside = outside && !strings.HasPrefix(cache, filepath.Clean(temp)+string(os.PathSeparator))
	}
	if !outside {
		t.Fatalf("the session's shared cache root %q must stand outside the ambient runner's home and the temp areas", cache)
	}
	return cache
}

// The workspace-write scenario's command: a real `go build` whose GOCACHE is the runner's shared
// cache root, exactly as the session's launch environment points it — the first toolchain write a
// session does, and the one the sandbox denied before the root was one of its grants. The marker
// is the command's own write into the root, so the scenario reads its end state off disk.
const dshCacheRootBuildProbe = `printf 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("built") }\n' > orbit-probe.go && go build -o /dev/null orbit-probe.go && mkdir -p "$GOCACHE/orbit-probe" && printf built > "$GOCACHE/orbit-probe/marker" && cat "$GOCACHE/orbit-probe/marker"`

// The read-only scenario's command touches nothing but the cache root: were the root granted in
// read-only too, this is the command that would still succeed — a command that also wrote its
// workspace would fail on that write whatever the cache-root grant said, and would hide the
// regression this scenario exists to catch.
const dshCacheRootWriteProbe = `mkdir -p "$GOCACHE/orbit-probe" && printf built > "$GOCACHE/orbit-probe/marker" && cat "$GOCACHE/orbit-probe/marker"`

// TestDshRealAutoCacheRoot: inside a dsh session's own sandbox, a confined command that writes
// the runner's shared toolchain cache root (machineHome()/caches, where GOCACHE, GOMODCACHE and
// npm's cache point — cache_root.go) succeeds through the workspace-write grants themselves: no
// sandbox denial, no escalation round.
//
// An isolated session works in a worktree, so the cache a `go build` populates is outside its
// workspace, and dsh builds its sandbox grants from the workspace root and the temp areas alone.
// The runner's session overlay adds the root to the profile dsh itself built
// (dshSandboxCacheRootPlugin) instead of leaving the write to an escalation, which would run the
// whole command outside the sandbox.
func TestDshRealAutoCacheRoot(t *testing.T) {
	ambient := runnerCacheRoot()
	dshRealCacheRootScenario(t)
	h := newDshRealHarness(t, "auto", true)
	cache := dshCacheRoot(t, ambient)
	marker := filepath.Join(cache, runnerCacheGoBuild, "orbit-probe", "marker")
	h.model.plans = []dshPlan{
		{tool: "bash", args: map[string]interface{}{"command": dshCacheRootBuildProbe, "description": "populate the shared Go build cache"}},
		{text: "P4 cache root answer"},
	}
	h.start()
	h.send("t1", "message", "Populate the shared build cache.")
	done := h.settled("t1")
	_, result := h.toolResult("t1", "bash")
	content := firstString(result, "content")
	wrote, readErr := os.ReadFile(marker)
	if done.Status != stSucceeded || readErr != nil || string(wrote) != "built" {
		t.Fatalf("the confined command must write the shared cache root: turn=%s marker=%q err=%v content=%q",
			done.Status, wrote, readErr, content)
	}
	if len(h.cp.cards()) != 0 || len(h.notes("permission_auto_allowed")) != 0 || len(h.notes("permission_denied")) != 0 ||
		strings.Contains(content, "sandbox:") {
		t.Fatalf("the write needs no approval and no denial: cards=%d autoAllowed=%d denied=%d content=%q",
			len(h.cp.cards()), len(h.notes("permission_auto_allowed")), len(h.notes("permission_denied")), content)
	}
	h.end()
	h.evidence(t.Name(), map[string]interface{}{"cacheRoot": cache, "marker": string(wrote), "cards": 0, "denials": 0})
}

// TestDshRealDefaultCacheRootDenied: the cache root is a grant of workspace-write alone. In
// Default the session runs read-only, and a command that writes the cache root is denied there
// without a card, just as it was before the root was granted: the cache-root grant must never
// reach a read-only session.
func TestDshRealDefaultCacheRootDenied(t *testing.T) {
	ambient := runnerCacheRoot()
	dshRealCacheRootScenario(t)
	h := newDshRealHarness(t, "default", true)
	cache := dshCacheRoot(t, ambient)
	marker := filepath.Join(cache, runnerCacheGoBuild, "orbit-probe", "marker")
	h.model.plans = []dshPlan{
		{tool: "bash", args: map[string]interface{}{"command": dshCacheRootWriteProbe, "description": "write the shared Go build cache"}},
		{text: "P4 read-only cache root answer"},
	}
	h.start()
	h.send("t1", "message", "Populate the shared build cache.")
	done := h.settled("t1")
	_, result := h.toolResult("t1", "bash")
	content := firstString(result, "content")
	if done.Status != stSucceeded || dshFileState(marker) != "absent" || len(h.cp.cards()) != 0 ||
		!strings.Contains(content, "denied under read-only mode") {
		t.Fatalf("a read-only session must not write the cache root: turn=%s marker=%q cards=%d content=%q",
			done.Status, dshFileState(marker), len(h.cp.cards()), content)
	}
	h.end()
	h.evidence(t.Name(), map[string]interface{}{"cacheRoot": cache, "marker": "absent", "cards": 0, "denied": true})
}
