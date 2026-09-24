package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The runner execs whatever `claude`/`codex`/`kimi` is on PATH; nothing else keeps those CLIs
// current, and the control plane pins new model slugs a stale engine will reject.
// engineUpdateLoop closes that gap: once ~10 min after startup (staggered off the
// boot-time selfUpdate and any burst of reclaimed sessions), then every 30 min — and, for any
// engine a pass stepped over because sessions were running on it, the moment it falls idle.
//
// 30 min, not an hour, because a model a new CLI brings has to reach the picker within two hours
// of the release — and that budget has to hold one interval to notice plus one more to retry a
// release feed that was momentarily unreachable. The feed does go missing (runner logs, 09-20 and
// 09-21: `could not reach …/claude-code-releases/latest`), and a single failed pass must not
// spend the whole budget. Asking this often is close to free: a pass with nothing to fetch is one
// GET per engine and no updater at all (TestUpdateEngineSkipsTheCommandWhenAlreadyCurrent).
const (
	engineUpdateInterval     = 30 * time.Minute
	engineUpdateInitialDelay = 10 * time.Minute
	// How often the loop looks back at an engine it stepped over for being busy. Short on
	// purpose: what it is waiting for is the gap between one session ending and the next one
	// starting, and on the machine this exists for — the one that is never idle when the ticker
	// fires — that gap is the only chance there is. Cheap to ask this often because while no
	// engine is deferred, which is most runners most of the time, it asks nothing at all.
	engineIdleRetryInterval = 15 * time.Second
	// Ceiling for a single engine's update command. `claude update` / `codex update`
	// download over the network, so allow minutes — but never let a wedged updater (slow
	// mirror, DNS black hole, an unexpected prompt) block the loop forever; without this
	// the goroutine could hang and the loop's ticker would never fire again.
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
	// Ceiling for asking a release feed which version is newest. Kilobytes over HTTPS, so this
	// is generous — but it must exist and it must be small: the whole value of asking first is
	// that it can't itself become the thing that eats the pass.
	engineLatestTimeout = 20 * time.Second
	// How much of an updater's output is kept for the failure message. Everything used to be,
	// which is unbounded by nothing but the updater's manners. The interesting lines — what it
	// choked on, which path — are always the last ones.
	engineOutputTail = 64 << 10
)

// engineUpdateLoop updates each installed engine in place, skipping any with a live
// session so a binary is never swapped mid-turn — and then retrying that engine as soon as
// its sessions finish, rather than at the next tick. A native Claude Code install is the
// exception: its update swaps nothing a session runs, so it goes ahead busy or not (see
// nativeClaudeInstall). Installing a missing engine stays
// `orbit doctor`'s interactive job. Best-effort — every failure is logged, never
// fatal. ORBIT_NO_ENGINE_UPDATE disables it, retry included: it turns the whole loop off
// before anything is scheduled.
//
// onEngineUpdated is handed to both schedulers it drives, so a pass that really moved an engine's
// version reports it wherever it came from — see updateEngines for what it promises.
func engineUpdateLoop(ctx context.Context, activeCount func(string) int, proxyVars []envVar, onEngineUpdated func()) {
	if os.Getenv("ORBIT_NO_ENGINE_UPDATE") != "" {
		return
	}
	select {
	case <-ctx.Done():
		return
	case <-time.After(engineUpdateInitialDelay):
	}
	updateEngines(ctx, activeCount, proxyVars, onEngineUpdated)
	ticker := time.NewTicker(engineUpdateInterval)
	defer ticker.Stop()
	// The other half of "skipped — session(s) active". That skip files the engine; this picks
	// it back up the moment the machine stops using it. Without it the only retry is the tick
	// above, which samples a machine at one fixed instant — the question a runner that always
	// has work answers "still busy" to every single day.
	idle := time.NewTicker(engineIdleRetryInterval)
	defer idle.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			updateEngines(ctx, activeCount, proxyVars, onEngineUpdated)
		case <-idle.C:
			retryDeferredEngineUpdates(ctx, activeCount, proxyVars, onEngineUpdated)
		}
	}
}

// updateEngines updates every engine on this machine, returning one human line per engine that
// had anything to say — the summary a browser-requested update reports back (the per-engine
// record it leaves behind is engineUpdateLog's job).
//
// onEngineUpdated, when not nil, is called the moment an engine's version really moves — inside the
// pass, before the engine after it is even looked at. A CLI that moved may have brought a model
// lineup with it, and the caller re-reads the model catalog on that (see runLoop) rather than
// waiting for its own ticker — the version is the one thing that changes the list between ticks,
// and installing it is this function's job. Only `updated` counts: `checked` is a version that did
// not move, and `failed` is one that never arrived. A pass that moves several engines calls it once
// per engine; calls landing during one catalog refresh are coalesced by the caller.
//
// Called from this pass's own goroutine, between engines — so it must return promptly. The engines
// behind this one are each allowed engineUpdateTimeout (a wedged updater is stopped only by its own
// ceiling), and a callback that took minutes would re-create the delay this exists to remove: live
// on 2026-09-24, Claude Code moved at 09:38:50 and the catalog was not re-read until Kimi had
// printed nothing at all for 5m0s. The runner's own callback hands the work to another goroutine.
func updateEngines(ctx context.Context, activeCount func(string) int, proxyVars []envVar, onEngineUpdated func()) []string {
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
		n := activeCount(spec.bin)
		if n > 0 {
			current, native := nativeClaudeInstall(spec, servicePath)
			if !native {
				logln("engine-update:", spec.name, "skipped — session(s) active")
				// Filed rather than dropped, which is what makes the line below a promise instead of
				// a figure of speech: retryDeferredEngineUpdates comes back for it within seconds of
				// the last session ending, so this engine's next chance is not half an hour away.
				deferEngineUpdate(spec.bin)
				// The outcome is deliberately not recorded: a busy machine says nothing about whether
				// updating works here, and writing it would leave every well-used engine reading
				// "skipped" until the next pass. How far behind it is, though, is true whoever
				// is busy — and this is the machine that most needs it said. It is worth saying out
				// loud to whoever just pressed the button, too: silence reads as "nothing happened".
				noteEngineDrift(ctx, spec, servicePath)
				lines = append(lines, spec.name+" — "+plural(n, "session")+" running, it'll update once they finish")
				continue
			}
			logln("engine-update:", spec.name, "updating with", plural(n, "session"), "running — native install at",
				current+": the new release goes in beside it, and running sessions keep the version they started with")
		}
		// Whoever gets to it first settles it: an engine updated by this pass has nothing left
		// owing, and leaving the to-do filed would send the idle retry after it again seconds later.
		clearDeferredEngineUpdate(spec.bin)
		rec, phrase := updateEngine(ctx, spec, servicePath, proxyVars)
		if rec.Status == updateUpdated {
			if n > 0 {
				// The one thing about this update the version numbers don't say: the sessions that were
				// busy are still on whatever they started with, and only their next spawn moves.
				phrase += " — native install, so what's already running (" + plural(n, "session") + ") keeps the version it started with"
			}
			// Now, not after the loop. This is the engine whose model list just changed, and the
			// engines still to come in this pass are each allowed minutes of their own.
			if onEngineUpdated != nil {
				onEngineUpdated()
			}
		}
		if phrase != "" {
			lines = append(lines, phrase)
		}
	}
	return lines
}

// nativeClaudeInstall reports whether the `claude` on the service PATH is Claude Code's native
// install, returning the version file it resolves to — the one engine install whose update is
// safe to run under live sessions, so the busy skip does not apply to it.
//
// That installer keeps every release as a separate file, …/claude/versions/<ver>, and the command
// on PATH is a symlink to the current one. `claude update` writes the new release beside the
// others and swaps the link atomically: no file a session is running gets rewritten, and its
// cleanup keeps any version a live process still holds a lock on. A running session therefore
// finishes on the binary it started with, and only the next spawn gets the new one — which is all
// waiting would have bought too, since an engine reclaimed between turns resumes from PATH
// whenever the update happened. Seen on vmi3129740 on 2026-09-23: an interactive 2.1.278, two
// days into its run, carried on straight through the update to 2.1.280, and not one of the four
// runner engines running at that moment broke.
//
// The one way a turn could still straddle two versions is Claude re-running itself through the
// link, and it does not — checked against 2.1.280's own code. A turn does start copies of the
// binary (the ripgrep built into Grep and Glob, a teammate), but each is spawned from
// process.execPath, which is the resolved versions/<ver> file: the per-version locks under
// ~/.local/state/claude/locks record exactly that path for a process launched through the link.
// The link is used only where getting the newest release is the point — the background-session
// daemon, which reconciles its version with its clients itself, and a session relaunching itself
// with --resume from the interactive UI — and neither happens inside a `-p` turn. Subagents run
// in-process; a `claude` that a Bash command runs is its own CLI, for which the new version is
// simply the current one.
//
// Anything else stays behind the skip. npm in particular rewrites node_modules in place, and
// nobody has shown that to be safe under a process running out of it.
func nativeClaudeInstall(spec engineSpec, servicePath string) (string, bool) {
	if spec.bin != providerClaude {
		return "", false
	}
	binPath, ok := lookPathIn(spec.bin, servicePath)
	if !ok {
		return "", false
	}
	real, err := filepath.EvalSymlinks(binPath)
	if err != nil {
		return "", false
	}
	// lookPathIn has already found an executable file there; what is left to ask is where it lives.
	versions := filepath.Dir(real)
	name := filepath.Base(real)
	return real, versionNumber(name) == name && filepath.Base(versions) == "versions" && filepath.Base(filepath.Dir(versions)) == "claude"
}

// engineUpdateDeferred is the set of engines a pass declined to update because sessions were
// running on them. A to-do, not a record — the outcome of a skip is still deliberately nothing.
//
// Skipping a busy engine is right: a binary must never be swapped mid-turn. On its own, though,
// it was only half an answer, because the retry was the next tick — one sample, at one fixed
// instant, of a machine that may be permanently busy. The result was exactly backwards: the
// runner doing the most work was the one that never updated, and its row just counted days
// behind. That costs more than it used to, now that the model picker probes the CLI itself, so a
// stale engine reads to a user as missing models rather than as an old engine.
//
// In memory on purpose. A restart loses the set, and the startup pass ten minutes later looks at
// the same machine again and re-decides — the same answer, taken fresh, with nothing stale to
// carry across a version of the runner that may not even skip for the same reasons.
var engineUpdateDeferred struct {
	mu   sync.Mutex
	bins map[string]bool
}

func deferEngineUpdate(bin string) {
	engineUpdateDeferred.mu.Lock()
	defer engineUpdateDeferred.mu.Unlock()
	if engineUpdateDeferred.bins == nil {
		engineUpdateDeferred.bins = map[string]bool{}
	}
	engineUpdateDeferred.bins[bin] = true
}

func clearDeferredEngineUpdate(bin string) {
	engineUpdateDeferred.mu.Lock()
	defer engineUpdateDeferred.mu.Unlock()
	delete(engineUpdateDeferred.bins, bin)
}

// deferredEngineUpdates copies the set out, so the retry can iterate engineSpecs in its own order
// without holding a lock across a package manager.
func deferredEngineUpdates() map[string]bool {
	engineUpdateDeferred.mu.Lock()
	defer engineUpdateDeferred.mu.Unlock()
	if len(engineUpdateDeferred.bins) == 0 {
		return nil
	}
	out := make(map[string]bool, len(engineUpdateDeferred.bins))
	for bin := range engineUpdateDeferred.bins {
		out[bin] = true
	}
	return out
}

// retryDeferredEngineUpdates installs the engines an earlier pass stepped over, as soon as the
// sessions it was stepping around are gone.
//
// Per engine, like the skip that filed them: one engine still mid-turn holds up nothing but
// itself, and the others install the moment each one's own count reaches zero. An engine that is
// still busy is simply left filed — no log line, no drift probe, nothing recorded — because this
// runs every few seconds, and the pass that deferred it already said all of that once.
//
// onEngineUpdated is updateEngines' contract, unchanged, down to where in the loop it is called: an
// engine this retry installs really did move a version, and the caller hears about it there and then
// rather than once the retry is done — the point of this path is that the update did not wait for
// the loop's next tick, and neither should the model list that came with it.
func retryDeferredEngineUpdates(ctx context.Context, activeCount func(string) int, proxyVars []envVar, onEngineUpdated func()) {
	deferred := deferredEngineUpdates()
	if len(deferred) == 0 {
		return
	}
	// Bounded like a pass, for the same reason: every update holds the machine's one
	// package-manager lock, whether the loop's ticker or an idle engine asked for it.
	ctx, cancel := context.WithTimeout(ctx, engineUpdateBudget)
	defer cancel()
	servicePath := serviceLoginPath()
	for _, spec := range engineSpecs {
		if !deferred[spec.bin] {
			continue
		}
		if ctx.Err() != nil {
			break
		}
		if activeCount(spec.bin) > 0 {
			continue
		}
		// Cleared before the attempt, not after it. The to-do asked for an attempt; a failing
		// updater that stayed filed would be retried every engineIdleRetryInterval for as long
		// as the machine stayed idle. Its failure is recorded like any other, and the loop's
		// next pass is what tries again.
		clearDeferredEngineUpdate(spec.bin)
		logln("engine-update:", spec.name, "retrying — its sessions have finished")
		if rec, _ := updateEngine(ctx, spec, servicePath, proxyVars); rec.Status == updateUpdated && onEngineUpdated != nil {
			onEngineUpdated()
		}
	}
}

func plural(n int, word string) string {
	if n == 1 {
		return "1 " + word
	}
	return strconv.Itoa(n) + " " + word + "s"
}

// latestEngineVersion asks the engine's release feed which version is newest.
//
// Cheap enough to ask before every update, and that changes what the updater is: a blind command
// becomes a decision with the two numbers in hand. Nothing to fetch is then a fact we can record
// without running a package manager or taking the machine's one install slot; something to fetch
// is a specific version, which every message from here on can name — including, crucially, the
// ones about failing to fetch it. "Update timed out" is unactionable; "2.1.226 → 2.1.228 timed
// out" says what was being attempted and how far behind staying there leaves you.
//
// Best-effort by construction: an unreachable feed means we do not know, never that we are
// current. The updater then runs exactly as it did before this existed.
func latestEngineVersion(ctx context.Context, spec engineSpec) string {
	if spec.latestURL == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, engineLatestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, spec.latestURL, nil)
	if err != nil {
		return ""
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		logln("engine-update:", spec.name, "could not reach", spec.latestURL+":", firstLine(err.Error()))
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		logln("engine-update:", spec.name, "release feed answered", resp.Status)
		return ""
	}
	// Bounded read: this is a version string, and an endpoint that answers with a login page or a
	// CDN error must not be able to hand us a megabyte to parse.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return ""
	}
	if spec.latestField != "" {
		var fields map[string]json.RawMessage
		if json.Unmarshal(body, &fields) != nil {
			return ""
		}
		var value string
		if json.Unmarshal(fields[spec.latestField], &value) != nil {
			return ""
		}
		return versionNumber(value)
	}
	return versionNumber(string(body))
}

// A CLI's --version line is prose around a number ("2.1.227 (Claude Code)", "codex-cli 0.147.0"),
// and a release feed's answer is the number alone. Comparing them means comparing the numbers.
var versionNumberRe = regexp.MustCompile(`\d+(?:\.\d+)+`)

func versionNumber(s string) string { return versionNumberRe.FindString(s) }

// sameVersion answers only when both sides really do carry a comparable number. Anything else is
// "don't know" rather than "different" — a machine must never be called behind on the strength of
// a version string nobody could parse.
func sameVersion(installed, latest string) bool {
	a, b := versionNumber(installed), versionNumber(latest)
	return a != "" && a == b
}

// engineOutput is where an updater's output goes while it runs, replacing a plain buffer so that
// a command which gets stopped still leaves behind evidence of what it was doing.
//
// A stopwatch cannot tell a slow download from a wedge — both are "still running after 5m" — and
// the two need opposite responses: a bigger allowance versus somebody looking at the machine. The
// cheap portable discriminator is whether the thing was still saying anything. So: how much it
// wrote, and when it last wrote.
type engineOutput struct {
	mu       sync.Mutex
	tail     []byte
	written  int64
	lastByte time.Time
}

func (o *engineOutput) Write(b []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.written += int64(len(b))
	o.lastByte = time.Now()
	o.tail = append(o.tail, b...)
	if len(o.tail) > engineOutputTail {
		o.tail = o.tail[len(o.tail)-engineOutputTail:]
	}
	return len(b), nil
}

func (o *engineOutput) bytes() []byte {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]byte(nil), o.tail...)
}

// progress is what the command had to show for itself, for the message that reports it stopped.
func (o *engineOutput) progress() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.written == 0 {
		return "it printed nothing at all"
	}
	return "it printed " + humanSize(o.written) + ", last " + time.Since(o.lastByte).Round(time.Second).String() + " ago"
}

func humanSize(n int64) string {
	switch {
	case n >= 1<<20:
		return strconv.FormatFloat(float64(n)/(1<<20), 'f', 1, 64) + " MB"
	case n >= 1<<10:
		return strconv.FormatFloat(float64(n)/(1<<10), 'f', 1, 64) + " KB"
	default:
		return strconv.FormatInt(n, 10) + " B"
	}
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
	// it: the update loop, a browser-requested update, and a session's on-demand install can all
	// want the one global prefix at once. The relay's own single-flight doesn't cover this —
	// it only stops a second *relay* job, and the loop's timer isn't a relay job. Held across
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
		// the fact that explains it. Reading "update failed" every pass about a deliberate
		// choice is how a real warning gets tuned out.
		rec := recordEngineUpdate(spec.bin, updateSkipped,
			"Installed by a package manager ("+binPath+") — Orbit updates it through that, rather than installing a second copy alongside it.",
			engineUpdateFacts{installed: before})
		return rec, spec.name + " — package-managed install, left alone"
	}
	// Same class of answer, found a different way: an install this runner has no permission to
	// replace. Running the updater anyway is not a slow no-op — `opencode upgrade` on a
	// root-owned npm prefix wedged for the full ceiling, every pass, and reported as a failure
	// nobody could act on. Whose install it is IS the fix, so say that instead.
	if real, ok := engineBinaryUpdatable(binPath); !ok {
		logln("engine-update:", spec.name, "skipped — no permission to replace", real)
		rec := recordEngineUpdate(spec.bin, updateSkipped,
			"Installed at "+real+", which this runner can't replace — it runs as "+runnerUserLabel()+
				" and that install belongs to another user. Update it as its owner, or install a copy this user owns.",
			engineUpdateFacts{installed: before})
		return rec, spec.name + " — owned by another user, left alone"
	}
	// Ask what is published before running anything. When the answer is "what you already have",
	// that is the whole job: recorded as `checked`, without a package manager, without the install
	// lock, and without spending any of the pass budget the engines behind this one need.
	latest := latestEngineVersion(ctx, spec)
	facts := engineUpdateFacts{installed: before, latest: latest}
	if latest != "" && sameVersion(before, latest) {
		logln("engine-update:", spec.name, "already current ("+before+" at "+binPath+")")
		return recordEngineUpdate(spec.bin, updateChecked, "", facts), spec.name + " — already up to date (" + before + ")"
	}
	// Named in every message from here down. A failure that says which version it was reaching for
	// is a failure someone can act on; the same failure without it is a shrug.
	//
	// The arrow needs both ends. `before` is empty whenever `<engine> --version` didn't answer —
	// which is not rare on the machine that needs this message most: a loaded box where a 300MB
	// CLI can't start inside the version probe's own ceiling is exactly the box whose updates
	// time out. Reported as "→ 2.1.229" it reads like a version that came from nowhere.
	step := ""
	switch {
	case latest != "" && firstNonEmpty(versionNumber(before), before) != "":
		step = firstNonEmpty(versionNumber(before), before) + " → " + latest + ": "
	case latest != "":
		step = "fetching " + latest + ": "
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
	// init and keeps the output pipe open — and the wait for that pipe never returns, holding
	// the lock taken above with it. Observed: an `opencode upgrade` still running 14 minutes
	// into a 5-minute ceiling, with the machine unable to install any engine behind it.
	configureEngineCommandTree(cmd)
	// Streamed rather than buffered whole, so that a command we stop still tells us whether it
	// was getting anywhere. Both streams take the same writer value, which os/exec then serves
	// from one pipe — no interleaving to reassemble, and the mutex is there because relying on
	// that is relying on an implementation detail for memory safety.
	out := &engineOutput{}
	cmd.Stdout, cmd.Stderr = out, out
	started := time.Now()
	err := cmd.Run()
	if err != nil {
		switch cmdCtx.Err() {
		case context.DeadlineExceeded:
			// How long it actually ran, not the ceiling: the pass budget can cut a command off
			// long before its own, and "still running after 5m" would be a lie about a command
			// that got 40 seconds because a wedged engine ahead of it ate the rest.
			ran := time.Since(started).Round(time.Second)
			progress := out.progress()
			logln("engine-update:", spec.name, "timed out after", ran, "—", progress)
			rec := recordEngineUpdate(spec.bin, updateFailed,
				step+"`"+cmdStr+"` was still running after "+ran.String()+" and was stopped — "+progress+".", facts)
			return rec, spec.name + " — update timed out after " + ran.String()
		case context.Canceled:
			// Runner shutting down mid-update — not a failure, and not this machine's news.
			return EngineUpdateReport{}, ""
		}
		detail := updateErrDetail(err, out.bytes())
		logln("engine-update:", spec.name, "failed:", detail)
		rec := recordEngineUpdate(spec.bin, updateFailed, step+detail, facts)
		return rec, spec.name + " — update failed: " + detail
	}
	after := engineVersion(binPath)
	facts.installed = after
	if after != "" && after != before {
		logln("engine-update:", spec.name, "updated", before, "->", after)
		rec := recordEngineUpdate(spec.bin, updateUpdated, "", facts)
		return rec, spec.name + " updated " + before + " → " + after
	}
	// Exited 0 and moved nothing. Recorded as `checked` either way — but when the feed said there
	// was something to fetch, BehindSince keeps running, and a week of that is the alarm. That is
	// the case this used to be blindest to: an updater writing to a copy PATH doesn't resolve
	// reports success forever while the binary the runner execs never moves.
	logln("engine-update:", spec.name, "already up to date ("+before+" at "+binPath+")")
	rec := recordEngineUpdate(spec.bin, updateChecked, "", facts)
	return rec, spec.name + " — already up to date (" + before + ")"
}

// engineBinaryUpdatable reports whether this runner could actually replace the binary it is
// about to update, returning the path it really checked.
//
// Every updater ends in writing over an install, so a runner without permission to do that has
// already lost — but it finds out by running a package manager first, which is neither fast nor
// quiet: it can wedge for the whole ceiling holding the machine's one package-manager lock, and
// what it finally reports is a failure that retrying will reproduce forever.
//
// The symlink is resolved first because that is what gets replaced: /usr/bin/opencode is a link
// into a root-owned npm prefix, and the link's own mode says nothing about it. Only a permission
// error counts as "can't" — anything else (a racing uninstall, an unreadable mount) stays a
// normal update attempt rather than being explained away as somebody else's install.
func engineBinaryUpdatable(binPath string) (string, bool) {
	real := binPath
	if resolved, err := filepath.EvalSymlinks(binPath); err == nil && resolved != "" {
		real = resolved
	}
	// O_WRONLY without O_TRUNC/O_APPEND: asks the kernel the exact question (may I write this
	// file, as this user, under this ACL?) without altering a byte. Root passes regardless of
	// mode, which is correct — a root runner really can replace it.
	f, err := os.OpenFile(real, os.O_WRONLY, 0)
	if err == nil {
		_ = f.Close()
		return real, true
	}
	return real, !errors.Is(err, fs.ErrPermission)
}

// runnerUserLabel names the account this runner runs as, for a message whose whole job is to say
// "this install isn't yours". Falls back to the numeric uid, which is still enough to compare
// against `ls -l`, when the user database can't be read.
func runnerUserLabel() string {
	if u, err := user.Current(); err == nil && u.Username != "" {
		return u.Username
	}
	return "uid " + strconv.Itoa(os.Getuid())
}

func engineUpdateCommand(spec engineSpec, binPath, home string) (string, bool) {
	if spec.updateCmd != "" {
		return spec.updateCmd, true
	}
	// No unattended update command of its own, so updating means re-running the official
	// installer — safe only where that installer put the binary itself. Asking
	// engineInstallerDirs rather than naming a directory here is the point: the installer's
	// destination has already moved once (~/.local/bin → ~/.kimi-code/bin), and a copy of that
	// knowledge left behind here is what turned a healthy Kimi into "package-managed" and
	// stopped updating it.
	if spec.bin == providerKimi && !installedByOfficialInstaller(binPath, home) {
		return "", false
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
		// Nothing in the output names a cause, so the last line is not the error — it is whatever
		// the installer had just announced it was about to do. Kimi's is the case that matters:
		// it runs under `set -euo pipefail` and downloads with `curl --silent`, so a network
		// failure kills the script with curl's status and prints nothing, leaving "==> Resolving
		// latest version from <url>" as the final word. Reported alone that reads as "this URL is
		// broken"; the exit status is the part that says what actually happened.
		return firstLine(err.Error()) + " — last output: " + clean[len(clean)-1]
	}
	return firstLine(err.Error())
}

// cmdEngineUpdate is the `orbit engine-update` entry point: update every installed engine
// once, now. Unlike the update loop it can't see the runner's live sessions (that state
// lives in the `orbit run` process), so it updates unconditionally — run it when the
// machine is idle if a mid-turn binary swap would matter.
func cmdEngineUpdate() {
	server := ""
	if cfg := loadConfig(); cfg != nil {
		server = cfg.ServerURL
	}
	// No catalog-refresh callback: this is a one-shot CLI with no sessions to publish a refreshed
	// catalog to, and the `orbit run` process that has them re-reads it on its own schedule.
	for _, line := range updateEngines(context.Background(), func(string) int { return 0 }, doctorProxyVars(server), nil) {
		fmt.Println("  " + line)
	}
}

// The states an engine's updater can leave behind. `skipped` is deliberately not a failure:
// it means Orbit chose not to touch this install, and retrying would do nothing. `updated` and
// `checked` are deliberately not the same word — see EngineUpdateReport.Status.
const (
	updateUpdated = "updated"
	updateChecked = "checked"
	updateFailed  = "failed"
	updateSkipped = "skipped"
)

// engineUpdateFacts is what the pass learned about the two versions that matter — the one on this
// machine and the newest one published. Either may be unknown, and unknown has to stay distinct
// from equal: it is the difference between "nothing to do" and "we couldn't find out".
type engineUpdateFacts struct {
	installed string
	latest    string
}

// engineUpdateLog is the per-engine update record, kept next to the runner's config.
//
// On disk rather than in memory for two reasons: a runner restarts (periodic self-update, service
// reload) and would otherwise report "never updated" until its next pass, and `orbit engine-update`
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
func recordEngineUpdate(bin, status, message string, facts engineUpdateFacts) EngineUpdateReport {
	now := time.Now().UTC().Format(time.RFC3339)
	engineUpdateLog.mu.Lock()
	defer engineUpdateLog.mu.Unlock()
	log := loadEngineUpdateLog()
	prev := log[bin]
	rec := EngineUpdateReport{
		Status:      status,
		At:          now,
		OkAt:        prev.OkAt,
		UpdatedAt:   prev.UpdatedAt,
		BehindSince: prev.BehindSince,
		// Carried when this pass couldn't ask: the newest version we ever saw is still the best
		// answer to "what should be on this machine", and dropping it on one unreachable feed
		// would quietly retire the drift this record exists to show.
		Latest:  firstNonEmpty(facts.latest, prev.Latest),
		Message: message,
	}
	if status == updateUpdated || status == updateChecked {
		rec.OkAt = now
	}
	if status == updateUpdated {
		rec.UpdatedAt = now
	}
	rec.BehindSince = driftSince(rec.BehindSince, facts.installed, rec.Latest, now)
	log[bin] = rec
	writeEngineUpdateLog(log)
	return rec
}

// noteEngineDrift records how far behind an engine is without claiming the updater did anything.
//
// The pass skips a busy machine so a binary is never swapped mid-turn, and that skip is
// deliberately not recorded as an outcome. But drift is not an outcome — it is a property of the
// binary — and a machine busy enough to skip every pass is precisely the one that drifts. On this
// runner Claude Code was skipped on all three passes today and last actually moved a day earlier;
// with drift measured only when a command runs, a permanently busy machine can fall arbitrarily
// far behind while its row says nothing at all.
func noteEngineDrift(ctx context.Context, spec engineSpec, servicePath string) {
	binPath, ok := lookPathIn(spec.bin, servicePath)
	if !ok {
		return
	}
	installed := engineVersion(binPath)
	latest := latestEngineVersion(ctx, spec)
	if installed == "" || latest == "" {
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	engineUpdateLog.mu.Lock()
	defer engineUpdateLog.mu.Unlock()
	log := loadEngineUpdateLog()
	rec := log[spec.bin]
	// Status, At and Message are left exactly as they were: nothing was attempted, and saying
	// otherwise would date-stamp an attempt that never happened.
	rec.Latest = latest
	rec.BehindSince = driftSince(rec.BehindSince, installed, latest, now)
	log[spec.bin] = rec
	writeEngineUpdateLog(log)
}

// driftSince keeps the clock on "this machine is behind": started the first time it is seen
// behind, kept running while it stays behind, cleared the moment it catches up, and left alone
// whenever either version is unknown — because "we couldn't ask" must never read as "caught up".
func driftSince(since, installed, latest, now string) string {
	if installed == "" || latest == "" {
		return since
	}
	if sameVersion(installed, latest) {
		return ""
	}
	if since == "" {
		return now
	}
	return since
}

func writeEngineUpdateLog(log map[string]EngineUpdateReport) {
	b, err := json.MarshalIndent(log, "", "  ")
	if err != nil {
		return
	}
	if err := os.MkdirAll(machineHome(), machineHomePerm); err != nil {
		return
	}
	if err := os.WriteFile(engineUpdateLogPath(), b, configFilePerm); err != nil {
		logln("engine-update: cannot record outcome:", err)
	}
}
