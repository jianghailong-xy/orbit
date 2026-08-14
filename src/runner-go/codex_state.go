package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	codexStateLayoutLegacy = "legacy-session-v1"
	codexStateLayoutShared = "shared-v1"

	// Codex 0.146 keeps an interrupted backfill lease for up to 15 minutes. The
	// runner-owned bootstrap outlives an individual session and gets enough time to
	// cross that lease and finish the real backfill before the server's watchdog.
	codexStateInitTimeout      = 20 * time.Minute
	codexConnectionInitTimeout = 2 * time.Minute
	codexStateRetryDelay       = 2 * time.Second

	// How long a starting app-server waits for its partition's handshake lock. Long enough for
	// the handshakes queued ahead of it on a busy runner, and bounded so a stuck holder degrades
	// to the unserialized start this replaced instead of stalling every Codex start.
	codexStateHandshakeLockTimeout = 45 * time.Second
)

type codexStateSelection struct {
	Dir       string
	Layout    string
	Partition string
	CodexHome string
	Shared    bool
}

func ensurePrivateCodexDir(dir string) error {
	if err := os.MkdirAll(dir, machineHomePerm); err != nil {
		return err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("%s is not a private directory", dir)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != machineHomePerm {
		if err := os.Chmod(dir, machineHomePerm); err != nil {
			return err
		}
	}
	return nil
}

func absoluteFrom(base, value string) (string, error) {
	if filepath.IsAbs(value) {
		return filepath.Clean(value), nil
	}
	if base == "" {
		var err error
		base, err = os.Getwd()
		if err != nil {
			return "", err
		}
	}
	return filepath.Abs(filepath.Join(base, value))
}

func envValue(env []string, key string) string {
	for i := len(env) - 1; i >= 0; i-- {
		k, v, ok := strings.Cut(env[i], "=")
		if ok && k == key {
			return v
		}
	}
	return ""
}

func envWithValue(env []string, key, value string) []string {
	out := make([]string, 0, len(env)+1)
	for _, entry := range env {
		entryKey, _, ok := strings.Cut(entry, "=")
		if ok && entryKey == key {
			continue
		}
		out = append(out, entry)
	}
	return append(out, key+"="+value)
}

func effectiveCodexHome(env []string, cwd string) (string, error) {
	if home := strings.TrimSpace(envValue(env, "CODEX_HOME")); home != "" {
		return absoluteFrom(cwd, home)
	}
	home := strings.TrimSpace(envValue(env, "HOME"))
	if home == "" {
		home = userHome()
	}
	if home == "" {
		home = "."
	}
	return absoluteFrom(cwd, filepath.Join(home, ".codex"))
}

func codexStatePartition(codexHome string) string {
	sum := sha256.Sum256([]byte(filepath.Clean(codexHome)))
	return hex.EncodeToString(sum[:12])
}

func validCodexStatePartition(partition string) bool {
	if len(partition) != 24 {
		return false
	}
	_, err := hex.DecodeString(partition)
	return err == nil
}

func ensureSharedCodexStateDir(partition string) (string, error) {
	if !validCodexStatePartition(partition) {
		return "", fmt.Errorf("invalid codex state partition")
	}
	root, err := filepath.Abs(filepath.Clean(codexStateRoot()))
	if err != nil {
		return "", err
	}
	if err := ensurePrivateCodexDir(root); err != nil {
		return "", err
	}
	dir := filepath.Join(root, partition)
	if err := ensurePrivateCodexDir(dir); err != nil {
		return "", err
	}
	return dir, nil
}

func ensureLegacyCodexStateDir(scratch string) (string, error) {
	dir, err := filepath.Abs(filepath.Join(scratch, "codex-state"))
	if err != nil {
		return "", err
	}
	if err := ensurePrivateCodexDir(dir); err != nil {
		return "", err
	}
	return dir, nil
}

func existingLegacyCodexStateDir(scratch string) (string, error) {
	dir, err := filepath.Abs(filepath.Join(scratch, "codex-state"))
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", fmt.Errorf("%s is not a private directory", dir)
	}
	if !legacyCodexStateExists(scratch) {
		return "", fmt.Errorf("legacy codex state is missing its state database")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != machineHomePerm {
		if err := os.Chmod(dir, machineHomePerm); err != nil {
			return "", err
		}
	}
	return dir, nil
}

func legacyCodexStateExists(scratch string) bool {
	matches, err := filepath.Glob(filepath.Join(scratch, "codex-state", "state_*.sqlite"))
	return err == nil && len(matches) > 0
}

func codexSharedStateAllowed(env []string) bool {
	// Custom providers and injected API credentials are separate trust domains.
	// Keep their state session-local until the control plane can provide a stable,
	// non-secret account scope instead of deriving one from credentials.
	return strings.TrimSpace(envValue(env, "OPENAI_BASE_URL")) == "" &&
		strings.TrimSpace(envValue(env, "OPENAI_API_KEY")) == ""
}

func codexPlanUsageStateForEnv(env []string, cwd string) (codexStateSelection, error) {
	if !codexSharedStateAllowed(env) {
		return codexStateSelection{}, fmt.Errorf("codex plan usage is unavailable with custom API credentials")
	}
	return sharedCodexStateForEnv(env, cwd)
}

func sharedCodexStateForEnv(env []string, cwd string) (codexStateSelection, error) {
	codexHome, err := effectiveCodexHome(env, cwd)
	if err != nil {
		return codexStateSelection{}, err
	}
	partition := codexStatePartition(codexHome)
	dir, err := ensureSharedCodexStateDir(partition)
	return codexStateSelection{Dir: dir, Layout: codexStateLayoutShared, Partition: partition, CodexHome: codexHome, Shared: true}, err
}

// resolveCodexStateDir preserves successful pre-shared-state sessions while
// routing new built-in sessions to one runner-wide partition per CODEX_HOME.
// A persisted layout marker always wins. For unmarked legacy sessions, a runtime
// id plus an actual state DB is the safe evidence that their thread lives there;
// a half-created pre-thread directory is deliberately ignored.
func resolveCodexStateDir(scratch, runtimeSessionID string, meta *sessionMeta, env []string, execDir string) (codexStateSelection, error) {
	if meta != nil {
		if runtimeSessionID == "" {
			runtimeSessionID = meta.RuntimeSessionID
		}
		switch meta.CodexStateLayout {
		case codexStateLayoutLegacy:
			var dir string
			var err error
			if runtimeSessionID == "" {
				// The layout marker is written before process spawn. If that spawn
				// failed before Codex created SQLite, keep the explicit local choice
				// retryable; once a thread id exists, require its real database.
				dir, err = ensureLegacyCodexStateDir(scratch)
			} else {
				dir, err = existingLegacyCodexStateDir(scratch)
			}
			return codexStateSelection{Dir: dir, Layout: codexStateLayoutLegacy}, err
		case codexStateLayoutShared:
			codexHome := meta.CodexStateHome
			if codexHome == "" {
				var homeErr error
				codexHome, homeErr = effectiveCodexHome(env, execDir)
				if homeErr != nil {
					return codexStateSelection{}, homeErr
				}
			} else if !filepath.IsAbs(codexHome) {
				return codexStateSelection{}, fmt.Errorf("persisted codex state home is not absolute")
			}
			codexHome = filepath.Clean(codexHome)
			if codexStatePartition(codexHome) != meta.CodexStatePartition {
				return codexStateSelection{}, fmt.Errorf("persisted codex state home does not match its partition")
			}
			dir, err := ensureSharedCodexStateDir(meta.CodexStatePartition)
			return codexStateSelection{Dir: dir, Layout: codexStateLayoutShared, Partition: meta.CodexStatePartition, CodexHome: codexHome, Shared: true}, err
		case "":
		default:
			return codexStateSelection{}, fmt.Errorf("unknown codex state layout %q", meta.CodexStateLayout)
		}
	}
	if runtimeSessionID != "" && legacyCodexStateExists(scratch) {
		dir, err := existingLegacyCodexStateDir(scratch)
		return codexStateSelection{Dir: dir, Layout: codexStateLayoutLegacy}, err
	}
	if runtimeSessionID == "" && !codexSharedStateAllowed(env) {
		dir, err := ensureLegacyCodexStateDir(scratch)
		return codexStateSelection{Dir: dir, Layout: codexStateLayoutLegacy}, err
	}
	return sharedCodexStateForEnv(env, execDir)
}

func codexStateForResume(sessionDir string, meta *sessionMeta) (codexStateSelection, error) {
	cwd := meta.WorkDir
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	return resolveCodexStateDir(sessionDir, meta.RuntimeSessionID, meta, os.Environ(), cwd)
}

type codexStateInitEntry struct {
	ready   bool
	running bool
	done    chan struct{}
	err     error
}

// codexStateInitGate is a per-process singleflight keyed by the absolute shared
// state path. The callback runs in its own goroutine: a session may stop waiting
// without cancelling the runner-owned backfill.
type codexStateInitGate struct {
	mu      sync.Mutex
	entries map[string]*codexStateInitEntry
}

func newCodexStateInitGate() *codexStateInitGate {
	return &codexStateInitGate{entries: map[string]*codexStateInitEntry{}}
}

func (g *codexStateInitGate) wait(ctx context.Context, key string, fn func() error) error {
	g.mu.Lock()
	entry := g.entries[key]
	if entry == nil {
		entry = &codexStateInitEntry{}
		g.entries[key] = entry
	}
	if entry.ready {
		g.mu.Unlock()
		return nil
	}
	if !entry.running {
		entry.running = true
		entry.done = make(chan struct{})
		go func() {
			err := fn()
			g.mu.Lock()
			entry.running = false
			entry.ready = err == nil
			entry.err = err
			close(entry.done)
			g.mu.Unlock()
		}()
	}
	done := entry.done
	g.mu.Unlock()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-done:
		g.mu.Lock()
		err := entry.err
		g.mu.Unlock()
		return err
	}
}

var sharedCodexStateInit = newCodexStateInitGate()

func codexStateInitLockPath(partition string) (string, error) {
	home, err := filepath.Abs(filepath.Clean(machineHome()))
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".codex-state-"+partition+".init.lock"), nil
}

// ensureSharedCodexStateReady performs the expensive cold bootstrap under both
// in-process singleflight and a cross-process advisory lock. bootstrapCtx is owned
// by the runner, not the waiting session, so an interrupt cannot strand Codex's
// 15-minute internal backfill lease. Only Codex's explicit lease-wait timeout is
// retried within the bounded runner-owned window; other failures stay actionable.
func retryableCodexStateInitError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	// Codex returns this after its short internal wait when another process (or
	// an interrupted predecessor) still owns the backfill lease.
	// Everything else is configuration, protocol, permission, or data damage and
	// should fail promptly instead of looking like a 20-minute hang.
	return strings.Contains(msg, "timed out waiting for state db backfill")
}

func retryCodexStateInitialization(ctx context.Context, retryDelay time.Duration, attempt func(context.Context) error) error {
	var lastErr string
	for {
		err := attempt(ctx)
		if err == nil {
			return nil
		}
		if !retryableCodexStateInitError(err) {
			return err
		}
		if msg := err.Error(); msg != lastErr {
			logln("codex shared state initialization retrying:", msg)
			lastErr = msg
		}
		timer := time.NewTimer(retryDelay)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return ctx.Err()
		case <-timer.C:
		}
	}
}

// lockCodexStateHandshake serializes the spawn-and-initialize window of every app-server that
// opens one shared partition. Codex opens and migrates that SQLite home per process with no lock
// of its own, so two starts landing together — a second session, or the runner's own plan-usage
// probe — can leave one of them dead on an otherwise healthy directory.
//
// Only the window is held. The process keeps the database open for the rest of the session, so
// holding past the handshake would serialize the runner down to one Codex session at a time.
// Waiting is bounded and best-effort for the same reason: correctness here is Codex's, and a
// holder that never returns must not take every other start down with it.
func lockCodexStateHandshake(ctx context.Context, state codexStateSelection) func() {
	return lockCodexStateHandshakeWithTimeout(ctx, state, codexStateHandshakeLockTimeout)
}

func lockCodexStateHandshakeWithTimeout(ctx context.Context, state codexStateSelection, timeout time.Duration) func() {
	noop := func() {}
	// A session-local partition has one writer by construction.
	if !state.Shared {
		return noop
	}
	lockPath, err := codexStateInitLockPath(state.Partition)
	if err != nil {
		return noop
	}
	lockCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	unlock, err := acquireCodexStateInitFileLock(lockCtx, lockPath)
	if err != nil {
		logln("codex shared state handshake starting without the partition lock:", err)
		return noop
	}
	return unlock
}

func ensureSharedCodexStateReady(waitCtx, bootstrapCtx context.Context, state codexStateSelection, env []string) error {
	if !state.Shared {
		return nil
	}
	if state.CodexHome == "" {
		return fmt.Errorf("shared codex state is missing its effective CODEX_HOME")
	}
	return sharedCodexStateInit.wait(waitCtx, state.Dir, func() error {
		ctx, cancel := context.WithTimeout(bootstrapCtx, codexStateInitTimeout)
		defer cancel()
		lockPath, err := codexStateInitLockPath(state.Partition)
		if err != nil {
			return err
		}
		unlock, err := acquireCodexStateInitFileLock(ctx, lockPath)
		if err != nil {
			return err
		}
		defer unlock()

		return retryCodexStateInitialization(ctx, codexStateRetryDelay, func(ctx context.Context) error {
			// The bootstrap may outlive the session whose worktree selected this
			// partition. Run from the durable state directory so later retries do not
			// depend on that worktree still existing.
			bootstrapEnv := envWithValue(env, "CODEX_HOME", state.CodexHome)
			app, spawnErr := startBareCodexAppServer(ctx, state.Dir, bootstrapEnv, state.Dir)
			if spawnErr != nil {
				return spawnErr
			}
			defer app.close()
			return app.initialize(ctx)
		})
	})
}
