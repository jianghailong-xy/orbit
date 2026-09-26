package main

// Claude Code's half of the account store (account_slot.go): an account IS a CLAUDE_CONFIG_DIR,
// the directory the CLI keeps that login's credentials, settings and transcripts in. Default is
// the one the runner's own environment selects — ~/.claude for the user this process runs as, the
// same login a `claude` typed in a terminal shares.

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// claudeAccountLoginCapabilityV1 declares that this runner signs in a Claude account the control
// plane names, in that account's own CLAUDE_CONFIG_DIR, rather than the machine's one login. A
// runner that does not declare it has no such operation: it would take a named-account request as a
// plain sign-in and put the machine's Default on the line while the page said otherwise.
const claudeAccountLoginCapabilityV1 = "claude-account-login/v1"

// claudeAccountRemoveCapabilityV1 declares that this runner removes a Claude account slot the
// control plane names — its CLAUDE_CONFIG_DIR and its record, and no other account's.
const claudeAccountRemoveCapabilityV1 = "claude-account-remove/v1"

var claudeAccountKind = accountSlotKind{
	engine:         providerClaude,
	varName:        "CLAUDE_CONFIG_DIR",
	dirName:        "claude-accounts",
	resolveDefault: effectiveClaudeConfigDir,
	loginStatus:    claudeSlotLoginStatus,
	liveDirs:       claudeSessionAccountDirs,
}

func init() { accountSlotKinds = append(accountSlotKinds, claudeAccountKind) }

// effectiveClaudeConfigDir is the directory the CLI keeps this login in, resolved the way the CLI
// resolves it: CLAUDE_CONFIG_DIR, else <HOME>/.claude. The sibling of effectiveCodexHome, and the
// one place the runner decides what Default means for Claude.
func effectiveClaudeConfigDir(env []string, cwd string) (string, error) {
	if dir := strings.TrimSpace(envValue(env, "CLAUDE_CONFIG_DIR")); dir != "" {
		return absoluteFrom(cwd, dir)
	}
	home := strings.TrimSpace(envValue(env, "HOME"))
	if home == "" {
		home = userHome()
	}
	if home == "" {
		home = "."
	}
	return absoluteFrom(cwd, filepath.Join(home, ".claude"))
}

// claudeSlotLoginStatus asks one Claude account's own login: `claude auth status`, run with that
// account's CLAUDE_CONFIG_DIR. The CLI is asked rather than its credentials file read — the file
// says where a token is, not whether the CLI accepts it, and on macOS the token may not be a file
// at all.
func claudeSlotLoginStatus(ctx context.Context, binPath, dir string) authState {
	return probeAuthIn(ctx, providerClaude, binPath, envWithValue(os.Environ(), "CLAUDE_CONFIG_DIR", dir))
}

// claudeSessionAccountDir is the directory a session's Claude login lives in: the one its own
// environment names (the control plane injects CLAUDE_CONFIG_DIR for a session on an account), else
// the runner's own. It is what every reader of a session's transcripts has to resolve through —
// transcripts are written under <config dir>/projects, so a session on an account keeps them in
// that account's directory, not the runner's.
func claudeSessionAccountDir(agentEnv map[string]string, execDir string) (string, error) {
	env := envWithAgent(agentEnv)
	dir, err := effectiveClaudeConfigDir(env, execDir)
	if err != nil {
		return "", fmt.Errorf("claude config dir: %w", err)
	}
	return dir, nil
}

// claudeSessionAccountDirs is every CLAUDE_CONFIG_DIR a session this runner is currently running is
// stuck to — read from each session's own record, written when its process first started. A session
// on the machine's own login contributes nothing: Default is not a slot, and no removal touches it.
func claudeSessionAccountDirs(sessionIDs []string) map[string]bool {
	out := map[string]bool{}
	for _, id := range sessionIDs {
		meta := readSessionMeta(filepath.Join(runDir(id), "meta.json"))
		if meta == nil || meta.ClaudeConfigDir == "" {
			continue
		}
		out[filepath.Clean(meta.ClaudeConfigDir)] = true
	}
	return out
}
