package main

// What this runner reports of Cursor CLI, and when it tells the control plane it runs Cursor CLI
// sessions (docs/cursor-runtime-contract.md §16.1, §16.3).
//
// The engine report tells four things apart: nothing installed, an installed build that is not the
// pinned one, a platform the pinned build was never measured on (each an installationError with its
// CURSOR_* code), and the Default account signed out (auth "no"). Signed in is the CLI's own answer
// to `agent models`, which lists the models the account may use and so needs a working credential
// and the network (§9). The ACP handshake is no such answer: `initialize` succeeds signed out, and so
// does `session/list` with an invalid key (§2.3).

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
)

// cursorDefaultAccountDir is the Default account: the Cursor CLI login the runner keeps in its own
// directory rather than the user's ~/.config/cursor (§16.2). `agent login`, run with
// XDG_CONFIG_HOME=<dir>/xdg-config, saves it there as cursor/auth.json (§8.2).
func cursorDefaultAccountDir() string { return filepath.Join(cursorRoot(), "default") }

// cursorLoginHint is how to sign the Default account in by hand: the pinned build's own `login`, saving
// into Orbit's directory for that account, with a HOME of its own so ~/.cursor stays untouched.
func cursorLoginHint() string { return cursorLoginHintFor(cursorDefaultAccountDir()) }

func cursorStoredLoginPath(accountDir string) string {
	return filepath.Join(accountDir, "xdg-config", "cursor", "auth.json")
}

// cursorStoredLogin is the access token of the login saved for the account at accountDir, "" when it
// holds none. A file that cannot be read as a login is an error, which is not the same as no login.
func cursorStoredLogin(accountDir string) (string, error) {
	data, err := os.ReadFile(cursorStoredLoginPath(accountDir))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var login struct {
		AccessToken string `json:"accessToken"`
	}
	if err := json.Unmarshal(data, &login); err != nil {
		return "", fmt.Errorf("the Cursor CLI login saved at %s cannot be read", cursorStoredLoginPath(accountDir))
	}
	return strings.TrimSpace(login.AccessToken), nil
}

// cursorTokenExpired is whether a login's token is past what the CLI itself still uses: it counts a
// token with less than five minutes left as expired, and it never refreshes a login's token (§8.4,
// §9), so that login is over. A token that is not a JWT with an expiry says nothing either way.
func cursorTokenExpired(token string, now time.Time) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	var claims struct {
		Exp *float64 `json:"exp"`
	}
	if json.Unmarshal(payload, &claims) != nil || claims.Exp == nil {
		return false
	}
	return now.Add(5 * time.Minute).After(time.Unix(int64(*claims.Exp), 0))
}

// cursorLoginState is the Default account's sign-in, by the login saved for it and the CLI's own
// `agent models` asked with that login's token (cursorSlotLoginStatus, every account's question). A
// network the CLI could not reach, and an answer it did not explain, are unknown: neither is evidence of
// a sign-out.
func cursorLoginState(exe string) authState {
	return cursorSlotLoginStatus(context.Background(), exe, cursorDefaultAccountDir())
}

// cursorModels runs `agent models` with credential (KEY=value) in a throwaway home, the injected
// credential kept in memory (§9): what it printed, and nil for an answer of exit 0. An error that is no
// *exec.ExitError is a CLI that gave no answer at all.
func cursorModels(ctx context.Context, exe, credential string) (string, error) {
	root, err := newCursorProbeRoot("orbit-cursor-models-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(root)
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, "models")
	cmd.Dir = root
	cmd.Env = append(cursorProbeEnv(root), credential)
	configureEngineCommandTree(cmd)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// cursorModelsAnswer reads `agent models`' answer to credential (§9): exit 0 is a credential that works.
func cursorModelsAnswer(ctx context.Context, exe, credential string) authState {
	out, err := cursorModels(ctx, exe, credential)
	if err == nil {
		return authYes
	}
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		return authUnknown
	}
	text := strings.ToLower(out)
	if strings.Contains(text, "failed to reach the cursor api") {
		return authUnknown
	}
	for _, evidence := range []string{"not logged in", "authentication required", "agent login", "unauthenticated", "is invalid", "sign in"} {
		if strings.Contains(text, evidence) {
			return authNo
		}
	}
	return authUnknown
}

// newCursorProbeRoot is a private throwaway directory for one Cursor CLI process the runner starts
// for itself, with the home cursorProbeEnv names already there.
func newCursorProbeRoot(prefix string) (string, error) {
	root, err := os.MkdirTemp("", prefix)
	if err != nil {
		return "", err
	}
	if err := os.Mkdir(filepath.Join(root, "home"), machineHomePerm); err != nil {
		_ = os.RemoveAll(root)
		return "", err
	}
	return root, nil
}

// checkCursor is checkEngine for Cursor CLI: the pinned build in Orbit's version directory and never a
// CLI on PATH, and the Default account's sign-in rather than the runner user's own login.
func checkCursor(h *engineHealth) {
	if err := cursorPlatformError(); err != nil {
		h.installError = err.Error()
		return
	}
	exe, err := cursorExecutableIn(cursorVersionDir())
	if err != nil {
		// A build an earlier pin installed is still here for the sessions running on it, and it is a
		// version Orbit no longer starts new sessions on.
		if published := cursorPublishedVersions(); len(published) > 0 {
			h.installed, h.version = true, published[len(published)-1]
			h.installError = cursorVersionMismatch(h.version).Error()
			return
		}
		h.installError = fmt.Sprintf("CURSOR_NOT_INSTALLED: Cursor CLI %s is not installed in Orbit's version directory", cursorSupportedVersion)
		return
	}
	h.installed, h.path, h.onServicePath = true, exe, true
	h.version, err = cursorProbeVersion(exe)
	if err == nil && h.version != cursorSupportedVersion {
		err = cursorVersionMismatch(h.version)
	}
	if err != nil {
		h.installError = err.Error()
		return
	}
	h.auth = cursorLoginState(exe)
}

// cursorInstallReady is what the last engine probe found of the pinned build here: installed, the
// pinned version, on a platform it was measured on (probeEngines sets it).
var cursorInstallReady atomic.Bool

func noteCursorInstallReady(ready bool) { cursorInstallReady.Store(ready) }

// cursorDriverRegistered reports whether this binary has a session driver for Cursor CLI: an entry in
// providerRuntimes. Bound in init() rather than read directly, for the reason runnerCapabilitiesV1 is
// built there: the table holds the session drivers, which reach every request's headers through the
// transport, so a header that reads the table back is a package initialization cycle.
var cursorDriverRegistered func() bool

func init() {
	cursorDriverRegistered = func() bool { return providerRuntimeFor(providerCursor).run != nil }
}

// cursorDeclared is whether this runner tells the control plane it runs Cursor CLI sessions: the
// provider:cursor its claim gate reads (§16.1, migration 0426). Only while the pinned build is ready
// here, and only from a binary with a session driver for it — without one the declaration would hand
// this runner sessions it cannot run, so the driver's entry in providerRuntimes is what turns it on.
// Signed in or not: a session can bring its own credential.
func cursorDeclared() bool {
	return cursorInstallReady.Load() && cursorDriverRegistered()
}

// supportedProvidersHeader is the X-Orbit-Supported-Providers this runner sends on every request.
func supportedProvidersHeader() string {
	if cursorDeclared() {
		return runnerSupportedProviders + "," + providerCursor
	}
	return runnerSupportedProviders
}
