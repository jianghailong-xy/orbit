package main

// Codex's half of the account store (account_slot.go): an account IS a CODEX_HOME, so all this
// engine adds is which variable names it, where its slots live, how the CLI is asked whether a
// directory is signed in, and which directories its running sessions are stuck to.

import (
	"context"
	"os"
)

// codexAccountRemoveCapabilityV1 declares that this runner removes an account slot the control
// plane names — its CODEX_HOME and its record, and no other account's. A runner that does not
// declare it has no such operation at all, so the control plane hands a removal only to a process
// that declares this; one that ignored the request would leave a slot the page says it removed.
const codexAccountRemoveCapabilityV1 = "codex-account-remove/v1"

var codexAccountKind = accountSlotKind{
	engine:         providerCodex,
	varName:        "CODEX_HOME",
	dirName:        "codex-accounts",
	resolveDefault: effectiveCodexHome,
	loginStatus:    codexSlotLoginStatus,
	liveDirs:       codexSessionAccountHomes,
}

func init() { accountSlotKinds = append(accountSlotKinds, codexAccountKind) }

// codexSlotLoginStatus asks one Codex account's own login: `codex login status`, run in that
// account's CODEX_HOME. Default's answer is never asked this way — the engine probe already ran in
// the runner's own environment, which is what selects Default (enginehealth.go).
func codexSlotLoginStatus(ctx context.Context, binPath, dir string) authState {
	return codexLoginStatus(ctx, binPath, envWithValue(os.Environ(), "CODEX_HOME", dir))
}
