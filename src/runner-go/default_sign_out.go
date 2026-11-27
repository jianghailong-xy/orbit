package main

// Default sign-out (docs/default-sign-out-design.md): the login of an engine's Default account comes
// off this machine, and nothing else does. Default is the directory the runner's own environment
// selects, so the account itself stays — history, transcripts, settings and the rest of the engine's
// directory are left exactly as they were — and the row reads Signed out until someone signs in again.
//
// The request rides on the account-remove relay (AccountRemoveCommand with Action "sign-out", account
// "default") and is answered with an AccountRemoveResultRequest, as a removal is. Every engine's sign-out
// is idempotent: the request is redelivered until this runner reports, and a Default already signed out
// is what was asked for.

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// What each engine's runner declares when it signs that engine's Default out on request.
const (
	claudeDefaultSignOutCapabilityV1      = "claude-default-sign-out/v1"
	codexDefaultSignOutCapabilityV1       = "codex-default-sign-out/v1"
	kimiDefaultSignOutCapabilityV1        = "kimi-default-sign-out/v1"
	cursorDefaultSignOutCapabilityV1      = "cursor-default-sign-out/v1"
	antigravityDefaultSignOutCapabilityV1 = "antigravity-default-sign-out/v1"
)

// accountRemoveActionSignOut is the AccountRemoveCommand.Action of a sign-out. Anything else ("remove", or
// empty from a control plane older than sign-out) is a removal.
const accountRemoveActionSignOut = "sign-out"

// defaultSignOutTimeout bounds one engine's sign-out: a `codex logout` or `kimi logout` that hangs, or a
// Keychain dialog nobody answers, fails the request rather than holding it.
var defaultSignOutTimeout = 60 * time.Second

// defaultSignOutCapabilities is every engine whose Default this runner signs out. Cursor CLI's is declared
// only where its account operations are (cursorAccountCapabilities).
func defaultSignOutCapabilities() []string {
	out := []string{claudeDefaultSignOutCapabilityV1, codexDefaultSignOutCapabilityV1, kimiDefaultSignOutCapabilityV1, antigravityDefaultSignOutCapabilityV1}
	if cursorAccountsSupported() {
		out = append(out, cursorDefaultSignOutCapabilityV1)
	}
	return out
}

// defaultAccountSessions is every session in sessionIDs running on kind's Default account: the ones the
// kind's own liveDirs files under Default's directory (Codex records its shared CODEX_HOME whichever account
// it is), and the ones of this engine whose record names no added account at all, which is how a session on
// Default is recorded by every other engine. A session on a key of its own uses no login, Default's least.
func defaultAccountSessions(kind accountSlotKind, sessionIDs []string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(id string) {
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	if slot, err := defaultAccountSlot(kind); err == nil {
		for _, id := range kind.liveDirs(sessionIDs)[filepath.Clean(slot.Dir)] {
			add(id)
		}
	}
	for _, id := range sessionIDs {
		meta := readSessionMeta(filepath.Join(runDir(id), "meta.json"))
		if meta != nil && sessionMetaOnDefault(kind.engine, meta) {
			add(id)
		}
	}
	return out
}

// sessionMetaOnDefault is whether a session's record says it runs on engine's Default account and records no
// directory for it. A record older than the provider field is a Claude session's (runtimeProvider).
func sessionMetaOnDefault(engine string, meta *sessionMeta) bool {
	provider := meta.Provider
	if provider == "" {
		provider = providerClaude
	}
	if provider != engine {
		return false
	}
	switch engine {
	case providerClaude:
		return meta.ClaudeConfigDir == ""
	case providerKimi:
		return meta.KimiCodeHome == ""
	case providerCursor:
		return meta.CursorAccountDir == "" && !strings.HasPrefix(meta.CursorIdentity, "key:")
	case providerAntigravity:
		return meta.AntigravityGoogleDir == ""
	}
	// Codex records the CODEX_HOME it runs in, Default's included, so liveDirs has already answered.
	return false
}

// signOutDefault deletes engine's Default login credential from this machine. liveSessions are the sessions
// running on Default (defaultAccountSessions): without force the sign-out is refused naming them, since each
// would fail on its next turn; with force — the person confirmed — it goes ahead.
func signOutDefault(engine string, force bool, liveSessions []string) error {
	if len(liveSessions) > 0 && !force {
		return &accountInUseError{engine: engine, id: accountSlotDefaultID, Sessions: liveSessions, signOut: true}
	}
	ctx, cancel := context.WithTimeout(context.Background(), defaultSignOutTimeout)
	defer cancel()
	switch engine {
	case providerClaude:
		return signOutClaudeDefault(ctx, claudeCredentialStoreForOS())
	case providerCodex:
		return signOutCodexDefault(ctx)
	case providerKimi:
		return signOutKimiDefault(ctx)
	case providerCursor:
		return removeCredentialFile("Cursor CLI", cursorStoredLoginPath(cursorDefaultAccountDir()))
	case providerAntigravity:
		return removeCredentialFile("Antigravity", antigravityTokenFile(antigravityGoogleDir()))
	}
	return fmt.Errorf("this runner cannot sign %s's Default account out", engine)
}

// signOutClaudeDefault deletes Default's Claude Code login from store — <dir>/.credentials.json, and on a Mac
// the login-Keychain item too — and leaves .claude.json and the rest of the directory as they are.
func signOutClaudeDefault(ctx context.Context, store claudeCredentialStore) error {
	f, err := claudeDefaultLoginFolder()
	if err != nil {
		return err
	}
	if err := store.remove(ctx, f); err != nil {
		return fmt.Errorf("could not sign Claude Code's Default out: %w", err)
	}
	return nil
}

// signOutCodexDefault runs `codex logout` in the runner's own environment — the CODEX_HOME `codex login
// status` answers Default's sign-in from — which clears whichever store Codex keeps the login in.
func signOutCodexDefault(ctx context.Context) error {
	bin, ok := lookLoginEngine(providerCodex)
	if !ok {
		return errors.New("Codex CLI is not installed on this runner, so it cannot sign Default out")
	}
	return runEngineLogout(ctx, "Codex", bin, nil, func() authState { return codexLoginStatus(ctx, bin, nil) })
}

// signOutKimiDefault runs `kimi logout` in Default's KIMI_CODE_HOME, which removes the credentials and the
// managed provider the sign-in added.
func signOutKimiDefault(ctx context.Context) error {
	bin, ok := lookLoginEngine(providerKimi)
	if !ok {
		return errors.New("Kimi Code is not installed on this runner, so it cannot sign Default out")
	}
	cwd, _ := os.Getwd()
	home, err := effectiveKimiHome(os.Environ(), cwd)
	if err != nil {
		return err
	}
	return runEngineLogout(ctx, "Kimi Code", bin, envWithValue(os.Environ(), "KIMI_CODE_HOME", home),
		func() authState { return kimiSlotLoginStatus(ctx, bin, home) })
}

// runEngineLogout runs `<bin> logout` with env (nil: this process's own) and then asks the CLI again: signed
// out is done whatever logout's own exit said — a CLI already signed out may refuse to log out — and still
// signed in is a failure, however cleanly logout exited.
func runEngineLogout(ctx context.Context, name, bin string, env []string, status func() authState) error {
	cmd := exec.CommandContext(ctx, bin, "logout")
	cmd.Env = env
	out, runErr := cmd.CombinedOutput()
	switch status() {
	case authNo:
		return nil
	case authYes:
		return fmt.Errorf("%s still reports Default signed in after `logout`", name)
	}
	if runErr != nil {
		detail := firstLine(strings.TrimSpace(string(out)))
		if detail == "" {
			detail = firstLine(runErr.Error())
		}
		return fmt.Errorf("%s could not sign Default out: %s", name, detail)
	}
	return nil
}

// removeCredentialFile deletes one engine's saved login file, and only that file.
func removeCredentialFile(name, path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("could not sign %s's Default out: %w", name, err)
	}
	return nil
}

// defaultSignOutResult carries out one sign-out request against the sessions this runner is running, and is
// what to report for it.
func defaultSignOutResult(rr AccountRemoveCommand, sessionIDs []string) AccountRemoveResultRequest {
	res := AccountRemoveResultRequest{Engine: rr.Engine, Account: rr.Account, Attempt: rr.Attempt, Status: "done"}
	kind, ok := accountSlotKindFor(rr.Engine)
	switch {
	case !ok:
		res.Status, res.Message = "failed", fmt.Sprintf("this runner has no %s accounts to sign out", rr.Engine)
	case rr.Account != accountSlotDefaultID:
		res.Status, res.Message = "failed", "only Default is signed out; an added account is removed instead"
	default:
		if err := signOutDefault(kind.engine, rr.Force, defaultAccountSessions(kind, sessionIDs)); err != nil {
			res.Status, res.Message, res.SessionIDs = "failed", firstLine(err.Error()), accountInUseSessions(err)
		}
	}
	return res
}

// defaultSignOuts keeps one sign-out per engine in flight: the request is redelivered every heartbeat while
// a `logout` may still be running, and a second one beside it would only race the first.
type defaultSignOuts struct {
	mu      sync.Mutex
	running map[string]bool
}

// begin claims engine's sign-out, false while one is already under way.
func (s *defaultSignOuts) begin(engine string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running[engine] {
		return false
	}
	if s.running == nil {
		s.running = map[string]bool{}
	}
	s.running[engine] = true
	return true
}

func (s *defaultSignOuts) end(engine string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.running, engine)
}

// handle carries out rr off the heartbeat's goroutine, reports it, and on a sign-out done re-probes the
// engine (refresh) and beats at once, so the row reads Signed out now rather than at the next probe.
func (s *defaultSignOuts) handle(rr AccountRemoveCommand, ops *countedOps, sessionIDs func() []string, report func(AccountRemoveResultRequest) error, refresh func(engine string), beat func()) {
	if !s.begin(rr.Engine) {
		return
	}
	ops.Add(1)
	go func() {
		defer ops.Done()
		defer s.end(rr.Engine)
		res := defaultSignOutResult(rr, sessionIDs())
		if err := report(res); err != nil {
			logln("default-sign-out result POST failed:", err)
		}
		if res.Status == "done" {
			refresh(rr.Engine)
			beat()
		}
	}()
}
