package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
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
	engineUpdateTimeout = 5 * time.Minute
	// Ceiling for a whole pass over every engine, which is the number that actually has to
	// hold. Two things are measured against it, and neither knows how many engines a machine
	// has:
	//
	//   - The control plane retires a relay slot still in flight after 12 minutes
	//     (INSTALL_RELAY_TIMEOUT_MS). A pass that can outlast that gets declared "timed out"
	//     while it is still working, and the row then flips back when the real result lands.
	//   - Every update holds the package-manager lock, so a wedged updater is also time a
	//     session's on-demand install spends waiting to install anything at all.
	//
	// Per-engine ceilings alone can't bound either one: four engines at 5 minutes each is 20.
	// This caps the pass, and the per-engine ceiling then just decides how much of it one
	// wedged updater may eat before the rest get their turn.
	engineUpdateBudget = 10 * time.Minute
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

// updateEngines updates every engine on this machine, returning one human line per engine that
// had anything to say — the summary a browser-requested update reports back (the per-engine
// record it leaves behind is engineUpdateLog's job).
func updateEngines(ctx context.Context, activeCount func(string) int, proxyVars []envVar) []string {
	// One budget for the pass, not one per engine — see engineUpdateBudget. Each engine's own
	// ceiling is derived from this context, so it is really min(engineUpdateTimeout, what's left).
	ctx, cancel := context.WithTimeout(ctx, engineUpdateBudget)
	defer cancel()
	servicePath := serviceLoginPath()
	var lines []string
	for _, spec := range engineSpecs {
		if err := ctx.Err(); err != nil {
			// Out of budget. Said out loud, and deliberately not recorded: these commands never
			// ran, and filing them as failures would put a warning on an engine that is fine.
			if errors.Is(err, context.DeadlineExceeded) {
				lines = append(lines, spec.name+" — not reached, the update pass ran out of time")
				continue
			}
			break // runner shutting down; not this machine's news
		}
		if n := activeCount(spec.bin); n > 0 {
			logln("engine-update:", spec.name, "skipped — session(s) active")
			// Deliberately not recorded: a busy machine says nothing about whether updating
			// works here, and writing it would leave every well-used engine reading "skipped"
			// until the next daily pass. It is worth saying out loud to whoever just pressed
			// the button, though — silence there reads as "nothing happened".
			lines = append(lines, spec.name+" — "+plural(n, "session")+" running, it'll update once they finish")
			continue
		}
		if _, phrase := updateEngine(ctx, spec, servicePath, proxyVars); phrase != "" {
			lines = append(lines, phrase)
		}
	}
	return lines
}

func plural(n int, word string) string {
	if n == 1 {
		return "1 " + word
	}
	return strconv.Itoa(n) + " " + word + "s"
}

// updateEngine runs one engine's in-place update. Claude/Codex use their own updater;
// the official standalone Kimi install repeats its idempotent installer because
// `kimi update` is only a manual hint without a TTY. Package-managed Kimi installs
// are left to their package manager instead of installing a second shadow copy.
// It uses the same service PATH + proxy env the runner spawns
// the engine with, then logs the version change. Engines not on the service PATH are
// left alone (installing one is `orbit doctor`'s job).
//
// Returns the record it filed (zero value when there was nothing to update) and a line for
// whoever asked. Every outcome is recorded, including the ones that are nobody's fault: an
// engine nothing has updated in weeks is invisible otherwise, which is how a machine ends up
// silently pinned to a CLI that rejects the model slugs the control plane hands it.
func updateEngine(ctx context.Context, spec engineSpec, servicePath string, proxyVars []envVar) (EngineUpdateReport, string) {
	// Every package-manager run on this machine takes the same lock, whichever path asked for
	// it: the daily loop, a browser-requested update, and a session's on-demand install can all
	// want the one global prefix at once. The relay's own single-flight doesn't cover this —
	// it only stops a second *relay* job, and the daily timer isn't a relay job. Held across
	// the version probes too, so `before` can't be measured against another updater's write.
	engineInstall.mu.Lock()
	defer engineInstall.mu.Unlock()
	// Resolve the exact binary the runner would exec (service PATH order) and measure the
	// version against THAT path before and after: an update that exits 0 without moving
	// this binary's version wrote to a copy the runner never runs.
	binPath, ok := lookPathIn(spec.bin, servicePath)
	if !ok {
		return EngineUpdateReport{}, ""
	}
	before := engineVersion(binPath)
	home, _ := os.UserHomeDir()
	cmdStr, mayUpdate := engineUpdateCommand(spec, binPath, home)
	if !mayUpdate {
		logln("engine-update:", spec.name, "skipped — package-managed install at", binPath)
		// Not a failure and not fixable by retrying — so it is recorded as its own state, with
		// the fact that explains it. Reading "update failed" every day about a deliberate
		// choice is how a real warning gets tuned out.
		rec := recordEngineUpdate(spec.bin, updateSkipped,
			"Installed by a package manager ("+binPath+") — Orbit updates it through that, rather than installing a second copy alongside it.")
		return rec, spec.name + " — package-managed install, left alone"
	}
	cmdCtx, cancel := context.WithTimeout(ctx, engineUpdateTimeout)
	defer cancel()
	cmd := exec.CommandContext(cmdCtx, "sh", "-c", cmdStr)
	env := append(os.Environ(), "PATH="+servicePath)
	for _, v := range proxyVars {
		env = append(env, v.K+"="+v.V)
	}
	cmd.Env = env
	// Without this the timeout above is decorative. CommandContext kills the `sh` it started
	// and nothing else, so an updater that forked (every one of them does) is reparented to
	// init and keeps the output pipe open — and CombinedOutput blocks on that pipe forever,
	// holding the lock taken above with it. Observed: an `opencode upgrade` still running 14
	// minutes into a 5-minute ceiling, with the machine unable to install any engine behind it.
	configureEngineCommandTree(cmd)
	started := time.Now()
	out, err := cmd.CombinedOutput()
	if err != nil {
		switch cmdCtx.Err() {
		case context.DeadlineExceeded:
			// How long it actually ran, not the ceiling: the pass budget can cut a command off
			// long before its own, and "still running after 5m" would be a lie about a command
			// that got 40 seconds because a wedged engine ahead of it ate the rest.
			ran := time.Since(started).Round(time.Second)
			logln("engine-update:", spec.name, "timed out after", ran)
			rec := recordEngineUpdate(spec.bin, updateFailed, "`"+cmdStr+"` was still running after "+ran.String()+" and was stopped.")
			return rec, spec.name + " — update timed out after " + ran.String()
		case context.Canceled:
			// Runner shutting down mid-update — not a failure, and not this machine's news.
			return EngineUpdateReport{}, ""
		}
		detail := updateErrDetail(err, out)
		logln("engine-update:", spec.name, "failed:", detail)
		rec := recordEngineUpdate(spec.bin, updateFailed, detail)
		return rec, spec.name + " — update failed: " + detail
	}
	after := engineVersion(binPath)
	if after != "" && after != before {
		logln("engine-update:", spec.name, "updated", before, "->", after)
		rec := recordEngineUpdate(spec.bin, updateOK, "")
		return rec, spec.name + " updated " + before + " → " + after
	}
	// Name the binary we measured: an update that exits 0 without moving the version is
	// usually one that wrote to a different install than the one PATH resolves.
	logln("engine-update:", spec.name, "already up to date ("+before+" at "+binPath+")")
	// Still `ok`: nothing moved because nothing had to. That is exactly the answer the page
	// needs — the update path on this machine works.
	rec := recordEngineUpdate(spec.bin, updateOK, "")
	return rec, spec.name + " — already up to date (" + before + ")"
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
	for _, line := range updateEngines(context.Background(), func(string) int { return 0 }, doctorProxyVars(server)) {
		fmt.Println("  " + line)
	}
}

// The states an engine's updater can leave behind. `skipped` is deliberately not a failure:
// it means Orbit chose not to touch this install, and retrying would do nothing.
const (
	updateOK      = "ok"
	updateFailed  = "failed"
	updateSkipped = "skipped"
)

// engineUpdateLog is the per-engine update record, kept next to the runner's config.
//
// On disk rather than in memory for two reasons: a runner restarts (daily self-update, service
// reload) and would otherwise report "never updated" for the next 24h, and `orbit engine-update`
// runs in a different process than `orbit run` — a shared file is the only way both of their
// results reach the same heartbeat.
//
// Keyed by engine binary. Best-effort throughout: this is telemetry about updates, and losing a
// line of it must never break one.
var engineUpdateLog struct {
	mu sync.Mutex
}

func engineUpdateLogPath() string { return filepath.Join(machineHome(), "engine-updates.json") }

func loadEngineUpdateLog() map[string]EngineUpdateReport {
	b, err := os.ReadFile(engineUpdateLogPath())
	if err != nil {
		return map[string]EngineUpdateReport{}
	}
	var out map[string]EngineUpdateReport
	if err := json.Unmarshal(b, &out); err != nil || out == nil {
		return map[string]EngineUpdateReport{}
	}
	return out
}

// recordEngineUpdate files one outcome and returns the record as reported. `okAt` is carried
// forward across later failures — without it a machine that updated fine yesterday and errors
// today is indistinguishable from one that has never managed it, and those need different words.
func recordEngineUpdate(bin, status, message string) EngineUpdateReport {
	now := time.Now().UTC().Format(time.RFC3339)
	engineUpdateLog.mu.Lock()
	defer engineUpdateLog.mu.Unlock()
	log := loadEngineUpdateLog()
	rec := EngineUpdateReport{Status: status, At: now, OkAt: log[bin].OkAt, Message: message}
	if status == updateOK {
		rec.OkAt = now
	}
	log[bin] = rec
	if b, err := json.MarshalIndent(log, "", "  "); err == nil {
		if err := os.MkdirAll(machineHome(), machineHomePerm); err == nil {
			if err := os.WriteFile(engineUpdateLogPath(), b, configFilePerm); err != nil {
				logln("engine-update: cannot record outcome:", err)
			}
		}
	}
	return rec
}
