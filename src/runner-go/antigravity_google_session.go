package main

// Antigravity sessions on the runner's Google account (docs/antigravity-runtime-contract.md §16.9).
//
// A built-in Antigravity session runs on the runner's Google sign-in when the runner keeps one — a
// token in its credential directory (antigravity_google.go) — and on a Gemini API key otherwise, as it
// always has. A session that brings its own key, a Gemini provider's, always runs on that key. Every
// spawn decides afresh, so a sign-in made, replaced or removed while a session lives reaches its next
// agy.
//
// A Google-mode agy runs in the session's own Gemini directory like any other (antigravity_home.go),
// on a copy of the runner's token at the same place in it, made as the spawn starts and removed once
// that agy has exited. The rest of that directory — MCP servers, hooks, rules, the conversation — is
// the session's alone, so the credential directory is never shared and never linked.
//
// agy checks the sign-in as it starts. When it refuses it, the session is reported signed out the way
// a signed-out claude or codex is (engineAuthPreflight): a "Failed to authenticate" error, which the
// transcript answers with its sign-in card, and the engine re-probed at once (noteEngineSignedOut).

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Where a session's agy gets its sign-in, decided per spawn and written to the runner log — never with
// anything the credential says.
const (
	antigravityAuthGoogle     = "google"      // the runner's Google sign-in, through a copy in the session's directory
	antigravityAuthSessionKey = "session_key" // the Gemini API key the session brings: a Gemini provider's, or its workspace's
	antigravityAuthEnvKey     = "env_key"     // GEMINI_API_KEY in the runner's own environment
	antigravityAuthNone       = "none"        // no credential at all: agy refuses to start, in its own words
)

// antigravitySessionAuth is where the session's next agy gets its sign-in. A key the session brings is
// API-key mode whatever the runner holds: the provider was set up with that key, and the runner's
// Google account is not the provider's to use. Otherwise the Google sign-in of the account the session
// runs on comes first (antigravitySessionGoogleDir) — Default's, as in the engine health (authSource),
// unless dispatch named another — and the runner's own GEMINI_API_KEY is what is left, for Default
// only: a session on an added account runs on that account or not at all.
func antigravitySessionAuth(job *ClaimedSession) string {
	if hasInjectedCredentials(providerAntigravity, job.Agent.Env) {
		return antigravityAuthSessionKey
	}
	dir, err := antigravitySessionGoogleDir(job.Agent.Env)
	if err != nil {
		return antigravityAuthNone
	}
	if antigravityGoogleSignInSavedIn(dir) {
		return antigravityAuthGoogle
	}
	if def, err := filepath.Abs(antigravityGoogleDir()); err == nil && dir == def &&
		strings.TrimSpace(envValue(envWithAgent(job.Agent.Env), "GEMINI_API_KEY")) != "" {
		return antigravityAuthEnvKey
	}
	return antigravityAuthNone
}

// placeAntigravityToken gives a Google-mode spawn its own copy of the sign-in of the account it runs on
// (accountDir), private to the session (0600), where agy looks for it in the session's Gemini directory
// — always a new file, the last copy having just been removed (prepareAntigravityGeminiDir). The copy
// lives as long as the agy started on it — that process's reaper removes it (startAgyProcess) — and one
// a crash or a runner restart left behind goes before the next spawn, and as the runner starts
// (pruneAntigravityTokenCopies).
func placeAntigravityToken(geminiDir, accountDir string) error {
	body, err := os.ReadFile(antigravityTokenFile(accountDir))
	if err != nil {
		return err
	}
	return os.WriteFile(antigravityTokenFile(geminiDir), body, 0o600)
}

// removeAntigravityToken removes the sign-in copy from a session's Gemini directory, if it holds one.
func removeAntigravityToken(geminiDir string) error {
	if err := os.Remove(antigravityTokenFile(geminiDir)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// pruneAntigravityTokenCopies removes the sign-in copies a runner that stopped without reaping its agy
// left in session directories. Run as the runner starts, before any session can spawn one of its own.
func pruneAntigravityTokenCopies() {
	entries, err := os.ReadDir(runsDir())
	if err != nil {
		return
	}
	removed := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		path := antigravityTokenFile(filepath.Join(runsDir(), entry.Name(), "antigravity"))
		if err := os.Remove(path); err == nil {
			removed++
		} else if !errors.Is(err, os.ErrNotExist) {
			logln("antigravity: removing a leftover Google sign-in copy failed:", err)
		}
	}
	if removed > 0 {
		logln("antigravity: removed", removed, "Google sign-in copies left in session directories")
	}
}

// antigravityGoogleEnv is a Google-mode agy's environment, made from the one an API-key agy gets
// (antigravityEnv): no variable that names another sign-in or endpoint (antigravityCredentialEnvKey),
// and a D-Bus address that reaches nothing, so agy keeps to the token file in the session's directory
// instead of a desktop keyring, whose sign-in is filed under one key for every agy on the machine
// (contract §16.2). The agent's commands inherit both (§3.2).
func antigravityGoogleEnv(env []string, geminiDir string) []string {
	kept := make([]string, 0, len(env))
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		if !antigravityCredentialEnvKey(key) {
			kept = append(kept, entry)
		}
	}
	return replaceEnv(kept, map[string]string{
		"DBUS_SESSION_BUS_ADDRESS": "unix:path=" + filepath.Join(geminiDir, "absent-dbus"),
	})
}

// antigravityGoogleLogFile is the log of a Google-mode agy of the session: agy's own log is the only
// place a refused sign-in and a network failure differ (classifyAgyAuthEnd). One name for each of them —
// the approval gate's check, then the session's process — since agy empties it as each starts, and
// each is read only once it has ended.
func antigravityGoogleLogFile(geminiDir string) string {
	return filepath.Join(geminiDir, "antigravity-cli", "orbit-google.log")
}

// agyAuthEnd is what an agy run on the Google sign-in says about it by how it ended.
type agyAuthEnd int

const (
	agyAuthEndOther   agyAuthEnd = iota // nothing about the sign-in: the end is reported as it is
	agyAuthEndRefused                   // agy refused the sign-in: the session is signed out
	agyAuthEndNetwork                   // agy could not check it for a network error: not a sign-out
)

// classifyAgyAuthEnd reads how an agy run on the Google sign-in ended (contract §16.4). Refused is what
// agy 1.2.16 was recorded ending with on a missing or invalid sign-in: exit 1 before any init, with both
// "authentication required" and "authentication failed or timed out" on stderr. A refresh agy could not
// send — a proxy refusing it, a host that does not resolve — ends exactly the same way, and only agy's
// own log tells the two apart ("token refresh failed due to network error"), so that is read as well:
// a network failure is never a sign-out.
func classifyAgyAuthEnd(exitCode int, initialized bool, stderr string, agyLog []byte) agyAuthEnd {
	lower := strings.ToLower(stderr)
	if exitCode != 1 || initialized || !strings.Contains(lower, "authentication required") ||
		!strings.Contains(lower, "authentication failed or timed out") {
		return agyAuthEndOther
	}
	if bytes.Contains(agyLog, []byte("due to network error")) {
		return agyAuthEndNetwork
	}
	return agyAuthEndRefused
}

// readAgyLog is a Google-mode agy's log, for classifyAgyAuthEnd. Only an agy that ended before it
// started is asked about, so the log is short; a missing one reads as empty.
func readAgyLog(path string) []byte {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	body, _ := io.ReadAll(io.LimitReader(f, 4<<20))
	return body
}

// errAgySignInRefused is a spawn stopped because agy refused the runner's Google sign-in before the
// session's process started (verifyAntigravityApprovalGate); errAgySignInUnchecked one stopped because
// agy could not check it for a network error, which is not a sign-out.
var (
	errAgySignInRefused   = errors.New("agy refused the runner's Google sign-in")
	errAgySignInUnchecked = errors.New(antigravityGoogleUnreachableMessage)
)

// antigravityGoogleSignedOutMessage is what a session whose agy refused the runner's Google sign-in
// fails with. Phrased as an authentication failure, which is what the transcript offers its sign-in
// card on (isAuthErrorText in @orbit/shared), like a signed-out claude or codex (engineSignedOutMessage).
const antigravityGoogleSignedOutMessage = "Failed to authenticate: Antigravity is not signed in to Google on this runner (agy refused its saved sign-in) — sign in again from here."

// antigravityAccountSignedOutMessage is what a session dispatched onto an added Antigravity account
// fails with when that account holds no sign-in: an authentication failure, so the transcript offers
// its sign-in card, and never a quiet fall back to a key the account was not picked for.
const antigravityAccountSignedOutMessage = "Failed to authenticate: the Antigravity account this session runs on is not signed in to Google on this runner — sign it in again from here, or pick another account."

// antigravityGoogleUnreachableMessage is what a turn fails with when agy could not check the sign-in for
// a network error. Not a sign-out: no sign-in card, and the session goes on.
const antigravityGoogleUnreachableMessage = "Antigravity could not check its Google sign-in: agy could not reach Google (a network error). The sign-in may still be valid — check this runner's network, then try again."
