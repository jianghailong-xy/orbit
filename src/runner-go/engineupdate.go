package main

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"time"
)

// The runner execs whatever `claude`/`codex` is on PATH; nothing else keeps those CLIs
// current, and the control plane pins new model slugs a stale engine will reject.
// engineUpdateLoop closes that gap: once ~10 min after startup (staggered off the
// boot-time selfUpdate and any burst of reclaimed sessions), then every 24h.
const (
	engineUpdateInterval     = 24 * time.Hour
	engineUpdateInitialDelay = 10 * time.Minute
	// Ceiling for a single engine's update command. `claude update` / `codex update`
	// download over the network, so allow minutes — but never let a wedged updater (slow
	// mirror, DNS black hole, an unexpected prompt) block the loop forever; without this
	// the goroutine could hang and the 24h ticker would never fire again.
	engineUpdateTimeout = 10 * time.Minute
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
	updateEngines(ctx, activeCount, proxyVars)
	ticker := time.NewTicker(engineUpdateInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			updateEngines(ctx, activeCount, proxyVars)
		}
	}
}

func updateEngines(ctx context.Context, activeCount func(string) int, proxyVars []envVar) {
	servicePath := serviceLoginPath()
	for _, spec := range engineSpecs {
		if activeCount(spec.bin) > 0 {
			logln("engine-update:", spec.name, "skipped — session(s) active")
			continue
		}
		updateEngine(ctx, spec, servicePath, proxyVars)
	}
}

// updateEngine runs one engine's in-place update — each engine's own updater (`claude
// update` / `codex update`); an engine with an empty updateCmd falls back to re-running
// its idempotent installCmd — using the same service PATH + proxy env the runner spawns
// the engine with, then logs the version change. Engines not on the service PATH are
// left alone (installing one is `orbit doctor`'s job).
func updateEngine(ctx context.Context, spec engineSpec, servicePath string, proxyVars []envVar) {
	// Resolve the exact binary the runner would exec (service PATH order) and measure the
	// version against THAT path before and after: an update that exits 0 without moving
	// this binary's version wrote to a copy the runner never runs.
	binPath, ok := lookPathIn(spec.bin, servicePath)
	if !ok {
		return
	}
	before := engineVersion(binPath)
	cmdStr := spec.updateCmd
	if cmdStr == "" {
		cmdStr = spec.installCmd
	}
	cmdCtx, cancel := context.WithTimeout(ctx, engineUpdateTimeout)
	defer cancel()
	cmd := exec.CommandContext(cmdCtx, "sh", "-c", cmdStr)
	env := append(os.Environ(), "PATH="+servicePath)
	for _, v := range proxyVars {
		env = append(env, v.K+"="+v.V)
	}
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	if err != nil {
		switch cmdCtx.Err() {
		case context.DeadlineExceeded:
			logln("engine-update:", spec.name, "timed out after", engineUpdateTimeout)
		case context.Canceled:
			// Runner shutting down mid-update — not a failure, stay quiet.
		default:
			logln("engine-update:", spec.name, "failed:", updateErrDetail(err, out))
		}
		return
	}
	if after := engineVersion(binPath); after != "" && after != before {
		logln("engine-update:", spec.name, "updated", before, "->", after)
	} else {
		// Name the binary we measured: an update that exits 0 without moving the version is
		// usually one that wrote to a different install than the one PATH resolves.
		logln("engine-update:", spec.name, "already up to date ("+before+" at "+binPath+")")
	}
}

// updateErrDetail extracts the most actionable line from a failed update's output: it
// prefers a line naming the actual cause (EACCES / permission denied), then any error
// line, skipping package-manager trailers like npm's "A complete log of this run can be
// found in: …" that point elsewhere. Falls back to the Go error string.
func updateErrDetail(err error, out []byte) string {
	var clean []string
	for _, l := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		l = strings.TrimSpace(l)
		if l == "" || strings.Contains(l, "A complete log of this run") {
			continue
		}
		clean = append(clean, l)
	}
	for i := len(clean) - 1; i >= 0; i-- { // the root cause, if the output names it
		low := strings.ToLower(clean[i])
		if strings.Contains(low, "eacces") || strings.Contains(low, "permission denied") {
			return clean[i]
		}
	}
	for i := len(clean) - 1; i >= 0; i-- { // else the last line that at least says "error"
		if strings.Contains(strings.ToLower(clean[i]), "error") {
			return clean[i]
		}
	}
	if len(clean) > 0 {
		return clean[len(clean)-1]
	}
	return firstLine(err.Error())
}

// cmdEngineUpdate is the `orbit engine-update` entry point: update every installed engine
// once, now. Unlike the daily loop it can't see the runner's live sessions (that state
// lives in the `orbit run` process), so it updates unconditionally — run it when the
// machine is idle if a mid-turn binary swap would matter.
func cmdEngineUpdate() {
	server := ""
	if cfg := loadConfig(); cfg != nil {
		server = cfg.ServerURL
	}
	updateEngines(context.Background(), func(string) int { return 0 }, doctorProxyVars(server))
}
