package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// The runner execs whatever `claude`/`codex`/`kimi` is on PATH; nothing else keeps those CLIs
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

// updateEngine runs one engine's in-place update. Claude/Codex use their own updater;
// the official standalone Kimi install repeats its idempotent installer because
// `kimi update` is only a manual hint without a TTY. Package-managed Kimi installs
// are left to their package manager instead of installing a second shadow copy.
// It uses the same service PATH + proxy env the runner spawns
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
	home, _ := os.UserHomeDir()
	cmdStr, mayUpdate := engineUpdateCommand(spec, binPath, home)
	if !mayUpdate {
		logln("engine-update:", spec.name, "skipped — package-managed install at", binPath)
		return
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

func engineUpdateCommand(spec engineSpec, binPath, home string) (string, bool) {
	if spec.updateCmd != "" {
		return spec.updateCmd, true
	}
	if spec.bin == providerKimi {
		if home == "" || filepath.Clean(binPath) != filepath.Join(filepath.Clean(home), ".local", "bin", providerKimi) {
			return "", false
		}
	}
	return spec.installCmd, spec.installCmd != ""
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
