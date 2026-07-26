package main

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"time"
)

// The runner execs whatever `claude`/`codex` is on PATH; nothing else keeps those
// CLIs current (claude has its own updater, codex does not), and the control plane
// pins new model slugs a stale engine will reject. engineUpdateLoop closes that gap:
// once ~10 min after startup (staggered off the boot-time selfUpdate and any burst of
// reclaimed sessions), then every 24h.
const (
	engineUpdateInterval     = 24 * time.Hour
	engineUpdateInitialDelay = 10 * time.Minute
)

// engineUpdateLoop updates each installed engine in place, skipping any with a live
// session so a binary is never swapped mid-turn. Installing a missing engine stays
// `orbit doctor`'s interactive job. Best-effort — every failure is logged, never
// fatal. ORBIT_NO_ENGINE_UPDATE disables it.
func engineUpdateLoop(ctx context.Context, activeCount func(string) int, proxyVars []envVar) {
	if os.Getenv("ORBIT_NO_ENGINE_UPDATE") != "" {
		return
	}
	select {
	case <-ctx.Done():
		return
	case <-time.After(engineUpdateInitialDelay):
	}
	updateEngines(activeCount, proxyVars)
	ticker := time.NewTicker(engineUpdateInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			updateEngines(activeCount, proxyVars)
		}
	}
}

func updateEngines(activeCount func(string) int, proxyVars []envVar) {
	servicePath := serviceLoginPath()
	for _, spec := range engineSpecs {
		if activeCount(spec.bin) > 0 {
			logln("engine-update:", spec.name, "skipped — session(s) active")
			continue
		}
		updateEngine(spec, servicePath, proxyVars)
	}
}

// updateEngine runs one engine's in-place update (claude via its own `claude update`,
// codex via a re-run of the idempotent `npm i -g` installer) using the same service
// PATH + proxy env the runner spawns the engine with, then logs the version change.
// Engines not yet installed are left alone.
func updateEngine(spec engineSpec, servicePath string, proxyVars []envVar) {
	before := checkEngine(spec, servicePath)
	if !before.installed {
		return
	}
	cmdStr := spec.updateCmd
	if cmdStr == "" {
		cmdStr = spec.installCmd
	}
	cmd := exec.Command("sh", "-c", cmdStr)
	env := append(os.Environ(), "PATH="+servicePath)
	for _, v := range proxyVars {
		env = append(env, v.K+"="+v.V)
	}
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	if err != nil {
		logln("engine-update:", spec.name, "failed:", updateErrDetail(err, out))
		return
	}
	if after := checkEngine(spec, serviceLoginPath()).version; after != "" && after != before.version {
		logln("engine-update:", spec.name, "updated", before.version, "->", after)
	} else {
		logln("engine-update:", spec.name, "already up to date ("+before.version+")")
	}
}

// updateErrDetail surfaces the CLI's own final output line (e.g. an npm EACCES from a
// non-root global install, the most common real failure) over Go's generic exit-status
// string, so the log points at the actual fix.
func updateErrDetail(err error, out []byte) string {
	if trimmed := strings.TrimSpace(string(out)); trimmed != "" {
		lines := strings.Split(trimmed, "\n")
		return strings.TrimSpace(lines[len(lines)-1])
	}
	return firstLine(err.Error())
}
