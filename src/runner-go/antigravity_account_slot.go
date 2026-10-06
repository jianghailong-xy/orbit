package main

// Antigravity's half of the account store (account_slot.go): an account IS a Gemini directory agy
// keeps one Google sign-in in — the --gemini_dir its login, status probe and model list run with
// (antigravityGoogleCommand), whose antigravity-cli/antigravity-oauth-token a session copies into
// its own directory as it spawns (antigravity_google_session.go). Default is the one the runner has
// always kept, <orbit home>/antigravity/google; an added account is <orbit home>/antigravity-accounts/<id>.
//
// agy has no environment variable that names that directory, so the one a session on an account is
// dispatched with (antigravityAccountDirVar) is Orbit's own: the runner reads it to pick the sign-in
// the session's copy is made from, and no agy ever sees it. A session's conversation lives in the
// session's own Gemini directory, never in the account's, so which account a session runs on can
// change between turns without anything moving on disk.

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// antigravityAccountLoginCapabilityV1 declares that this runner signs in an Antigravity account the
// control plane names, in that account's own Gemini directory, rather than the runner's one Google
// sign-in. A runner without it would take a named-account request as a plain sign-in and replace
// Default's while the page said it was adding an account.
const antigravityAccountLoginCapabilityV1 = "antigravity-account-login/v1"

// antigravityAccountRemoveCapabilityV1 declares that this runner removes an Antigravity account slot
// the control plane names — its Gemini directory and its record, and no other account's.
const antigravityAccountRemoveCapabilityV1 = "antigravity-account-remove/v1"

// antigravityAccountDirVar names the Gemini directory of the account a session runs on, when that is
// not Default's. The control plane injects it as it injects CODEX_HOME and CLAUDE_CONFIG_DIR; the
// runner strips it from every agy's environment (antigravityEnv, antigravityGoogleCommand).
const antigravityAccountDirVar = "ORBIT_ANTIGRAVITY_GOOGLE_DIR"

var antigravityAccountKind = accountSlotKind{
	engine:         providerAntigravity,
	varName:        antigravityAccountDirVar,
	dirName:        "antigravity-accounts",
	resolveDefault: func([]string, string) (string, error) { return filepath.Abs(antigravityGoogleDir()) },
	loginStatus: func(ctx context.Context, binPath, dir string) authState {
		auth, _ := antigravitySlotUsageStatus(ctx, binPath, dir)
		return auth
	},
	usageStatus: antigravitySlotUsageStatus,
	liveDirs:    antigravitySessionAccountDirs,
}

func init() { accountSlotKinds = append(accountSlotKinds, antigravityAccountKind) }

// antigravityGoogleDirIn is the Gemini directory a Google-mode agy runs with in env: the account's
// that env names, else Default's.
func antigravityGoogleDirIn(env []string) string {
	if dir := strings.TrimSpace(envValue(env, antigravityAccountDirVar)); dir != "" {
		return filepath.Clean(dir)
	}
	return antigravityGoogleDir()
}

// antigravitySlotUsageStatus asks one account's own sign-in whether it is good, the way the engine
// probe asks Default's (probeAntigravityAuth): agy's /usage in that account's directory, which reads
// the account's quota as it answers. An account with no token is signed out — an added account never
// falls back to a Gemini API key the way the runner's own engine does.
func antigravitySlotUsageStatus(ctx context.Context, binPath, dir string) (authState, *PlanUsage) {
	if info, err := os.Stat(antigravityTokenFile(dir)); err != nil || info.IsDir() {
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return authUnknown, nil
		}
		return authNo, nil
	}
	probe := probeAntigravityGoogle(ctx, binPath, envWithValue(os.Environ(), antigravityAccountDirVar, dir))
	return probe.auth, probe.usage
}

// antigravitySessionGoogleDir is the Gemini directory of the account a session runs on: the one its
// environment names, when that is one of this runner's Antigravity accounts, else Default's. A
// directory that is not one of them is refused rather than read: the session's copy of a sign-in is
// only ever made from an account this runner keeps.
func antigravitySessionGoogleDir(agentEnv map[string]string) (string, error) {
	named := strings.TrimSpace(agentEnv[antigravityAccountDirVar])
	def, err := filepath.Abs(antigravityGoogleDir())
	if err != nil {
		return "", err
	}
	if named == "" || filepath.Clean(named) == def {
		return def, nil
	}
	root, err := accountSlotsDir(antigravityAccountKind)
	if err != nil {
		return "", err
	}
	dir := filepath.Clean(named)
	if filepath.Dir(dir) == root {
		if home, err := antigravityAccountKind.home(filepath.Base(dir)); err == nil && home == dir {
			return dir, nil
		}
	}
	return "", fmt.Errorf("this runner has no Antigravity account at %s — sign it in again, or pick another account", named)
}

// antigravitySessionAccountDirs is every added account's directory a session this runner is running
// is on — read from each session's own record (sessionMeta.AntigravityGoogleDir), written as its agy
// starts. A session on Default contributes nothing: Default is not a slot, and no removal touches it.
func antigravitySessionAccountDirs(sessionIDs []string) map[string]bool {
	out := map[string]bool{}
	for _, id := range sessionIDs {
		meta := readSessionMeta(filepath.Join(runDir(id), "meta.json"))
		if meta == nil || meta.AntigravityGoogleDir == "" {
			continue
		}
		out[filepath.Clean(meta.AntigravityGoogleDir)] = true
	}
	return out
}

// antigravitySessionGoogleDirToRecord is the account directory a session's record keeps: the added
// account it runs on, or empty for one on Default, a key or no sign-in at all.
func antigravitySessionGoogleDirToRecord(job *ClaimedSession) string {
	if runtimeProvider(job) != providerAntigravity {
		return ""
	}
	dir, err := antigravitySessionGoogleDir(job.Agent.Env)
	if err != nil || dir == "" {
		return ""
	}
	if def, err := filepath.Abs(antigravityGoogleDir()); err == nil && def == dir {
		return ""
	}
	return dir
}
