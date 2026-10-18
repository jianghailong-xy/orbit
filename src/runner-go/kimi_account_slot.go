package main

// Kimi Code's half of the account store (account_slot.go): an account IS a KIMI_CODE_HOME, the
// directory the CLI keeps a whole login in — config.toml with the managed provider and its models,
// and credentials/<key>.json. Kimi keeps its tokens in files only, so one directory is one account on
// every OS. Default is the one the runner's own environment selects, KIMI_CODE_HOME else ~/.kimi-code
// — the same login a `kimi` typed in a terminal shares; an added account is
// <orbit home>/kimi-accounts/<id>.
//
// A session never runs in an account's directory itself but in a private overlay that borrows its
// state (kimi_home.go), so the account a session is on is the KIMI_CODE_HOME its environment names —
// injected by the control plane as CODEX_HOME and CLAUDE_CONFIG_DIR are — and the one its record
// keeps (sessionMeta.KimiCodeHome).

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// kimiAccountLoginCapabilityV1 declares that this runner signs in a Kimi Code account the control
// plane names, in that account's own KIMI_CODE_HOME, rather than the machine's one login. A runner
// without it would take a named-account request as a plain sign-in and replace Default's while the
// page said it was adding an account.
const kimiAccountLoginCapabilityV1 = "kimi-account-login/v1"

// kimiAccountRemoveCapabilityV1 declares that this runner removes a Kimi Code account slot the
// control plane names — its KIMI_CODE_HOME and its record, and no other account's.
const kimiAccountRemoveCapabilityV1 = "kimi-account-remove/v1"

var kimiAccountKind = accountSlotKind{
	engine:         providerKimi,
	varName:        "KIMI_CODE_HOME",
	dirName:        "kimi-accounts",
	resolveDefault: effectiveKimiHome,
	loginStatus:    kimiSlotLoginStatus,
	liveDirs:       kimiSessionAccountHomes,
}

func init() { accountSlotKinds = append(accountSlotKinds, kimiAccountKind) }

// kimiSlotLoginStatus asks one Kimi account's own login: the ACP handshake doctor's probe makes
// (probeKimiACPAuth), run in that account's KIMI_CODE_HOME. A directory that is not there is signed
// out and is not asked: kimi makes the home it runs in, so asking would bring a removed account back
// as an empty one.
func kimiSlotLoginStatus(ctx context.Context, binPath, dir string) authState {
	if _, err := os.Stat(dir); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return authNo
		}
		return authUnknown
	}
	return probeKimiACPAuth(ctx, binPath, envWithValue(os.Environ(), "KIMI_CODE_HOME", dir))
}

// kimiSessionAccountHomes is every KIMI_CODE_HOME a session this runner is running is on — read from
// each session's own record (sessionMeta.KimiCodeHome), written before its kimi starts. A session on
// Default contributes nothing: Default is not a slot, and no removal touches it.
func kimiSessionAccountHomes(sessionIDs []string) map[string]bool {
	out := map[string]bool{}
	for _, id := range sessionIDs {
		meta := readSessionMeta(filepath.Join(runDir(id), "meta.json"))
		if meta == nil || meta.KimiCodeHome == "" {
			continue
		}
		out[filepath.Clean(meta.KimiCodeHome)] = true
	}
	return out
}

// kimiSessionHomeToRecord is the KIMI_CODE_HOME a Kimi session's own environment names, when that is
// not the one the runner's own environment resolves: a session dispatched onto one of the machine's
// Kimi accounts. Its conversation is kept there, so it is where `orbit resume` looks for it, and what
// a removal refuses to take while the session is running. Empty for every other session, a Kimi one
// on Default included.
func kimiSessionHomeToRecord(job *ClaimedSession, execDir string) string {
	if runtimeProvider(job) != providerKimi {
		return ""
	}
	home, err := effectiveKimiHome(envWithAgent(job.Agent.Env), execDir)
	if err != nil {
		return ""
	}
	if own, err := effectiveKimiHome(os.Environ(), execDir); err == nil && own == home {
		return ""
	}
	return home
}
