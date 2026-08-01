package main

import (
	"bytes"
	"context"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// The tier aliases Claude Code advertises in `/model` that we surface in Orbit's picker — matching
// Claude Code's own quick-pick (Opus / Fable / Sonnet / Haiku). The CLI advertises more (`best`,
// `opusplan`, the `[1m]` variants), but those are deliberately left out of the quick-pick there too;
// they stay reachable by pinning a full `--model` id. Order is picker order (Opus first = default).
var claudeModelAliases = []string{"opus", "fable", "sonnet", "haiku"}

func claudeCLIAvailable() bool {
	_, err := exec.LookPath("claude")
	return err == nil
}

// fetchClaudeModelCatalog asks the runner's own Claude Code CLI which models it offers, so the
// picker follows the installed CLI (which auto-tracks new Anthropic releases) instead of a hardcoded
// web/mobile list — the same reason `codex debug models` drives the Codex catalog. `claude` has no
// list command, but `claude -p "/model <alias>"` resolves an alias to its friendly name (e.g.
// "Set model to Opus 5 for this session only"); we derive the api id from that name.
func fetchClaudeModelCatalog(ctx context.Context) ([]ModelInfo, error) {
	models := make([]ModelInfo, 0, len(claudeModelAliases))
	for i, alias := range claudeModelAliases {
		name, err := resolveClaudeModelName(ctx, alias)
		if err != nil {
			return nil, err
		}
		if name == "" {
			continue // alias not recognized by this CLI version — skip, keep the rest
		}
		priority := i
		models = append(models, ModelInfo{
			Value:    claudeModelID(name),
			Label:    name,
			Priority: &priority,
		})
	}
	return models, nil
}

func resolveClaudeModelName(ctx context.Context, alias string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	// `/model` is a client-side slash command (no LLM call, no token cost); it just echoes the
	// resolved model for the (ephemeral) `-p` session.
	out, err := exec.CommandContext(cctx, "claude", "-p", "/model "+alias).CombinedOutput()
	if err != nil {
		return "", err
	}
	return parseSetModelName(out), nil
}

var setModelRe = regexp.MustCompile(`(?i)set model to (.+?) for this session`)

// parseSetModelName pulls the friendly model name out of `claude -p "/model <alias>"` output, e.g.
// "Set model to Opus 5 for this session only" -> "Opus 5". Returns "" when the line isn't present.
func parseSetModelName(out []byte) string {
	m := setModelRe.FindSubmatch(bytes.TrimSpace(out))
	if m == nil {
		return ""
	}
	return strings.TrimSpace(string(m[1]))
}

// claudeModelID derives the api model id from a friendly name, matching Anthropic's id scheme:
// "Opus 5" -> "claude-opus-5", "Haiku 4.5" -> "claude-haiku-4-5", "Sonnet 5" -> "claude-sonnet-5".
func claudeModelID(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	s = strings.ReplaceAll(s, ".", "-")
	s = strings.Join(strings.Fields(s), "-") // collapse whitespace to single dashes
	return "claude-" + s
}
