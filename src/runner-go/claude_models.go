package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
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
		id := claudeModelID(name)
		models = append(models, ModelInfo{
			Value:         id,
			Label:         name,
			Priority:      &priority,
			ContextWindow: fetchClaudeContextWindow(ctx, id),
		})
	}
	return models, nil
}

// fetchClaudeContextWindow asks the CLI how big this model's context window is, rather than
// keeping the number in a table. The window is a property of (model, CLI version, account,
// gateway) and not of the model id alone — `opus` and `opus[1m]` are the same model with two
// different windows — so a hand-maintained list is a guess that silently rots into a wrong
// denominator under the clients' context gauge. `/context` reports what the CLI will actually
// use for the model it was pointed at.
//
// Returns 0 for anything it can't read (an older CLI, a changed layout, a model this install
// won't accept). 0 travels as "no reading" all the way to the gauge, which then shows the token
// count without a percentage — a missing number beats a fabricated one.
func fetchClaudeContextWindow(ctx context.Context, model string) int {
	cctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	out, err := exec.CommandContext(
		cctx,
		"claude",
		"-p",
		"--no-session-persistence",
		"--setting-sources",
		"user",
		"--model",
		model,
		"/context",
	).CombinedOutput()
	if err != nil {
		return 0
	}
	return parseContextWindow(out)
}

// The denominator of `/context`'s headline reading: "**Tokens:** 18.2k / 1m (2%)" -> 1000000.
// Anchored on the label so the percentage table below it can't match.
var contextWindowRe = regexp.MustCompile(`(?i)tokens:\**\s*[\d.]+\s*[km]?\s*/\s*([\d.]+)\s*([km])?`)

// parseContextWindow pulls the window out of `claude -p "/context"` output. Returns 0 when the
// line isn't present or doesn't parse — see fetchClaudeContextWindow on why that is a valid answer.
func parseContextWindow(out []byte) int {
	m := contextWindowRe.FindSubmatch(bytes.TrimSpace(out))
	if m == nil {
		return 0
	}
	n, err := strconv.ParseFloat(string(m[1]), 64)
	if err != nil || n <= 0 {
		return 0
	}
	switch strings.ToLower(string(m[2])) {
	case "k":
		n *= 1_000
	case "m":
		n *= 1_000_000
	}
	// A bare number under 1k is the CLI having printed something other than a window.
	if n < 1_000 {
		return 0
	}
	return int(math.Round(n))
}

func resolveClaudeModelName(ctx context.Context, alias string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	// Recent Claude Code versions resolve `/model` client-side. Any unsupported/failed invocation
	// is treated as a catalog refresh failure, leaving the runner's previous catalog untouched.
	out, err := exec.CommandContext(
		cctx,
		"claude",
		"-p",
		"--no-session-persistence",
		"--setting-sources",
		"user",
		"/model "+alias,
	).CombinedOutput()
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

// fetchClaudeDefaultModel reads Claude Code's user-owned setting instead of launching a probe
// session. Besides avoiding hooks/plugins/MCP side effects, this preserves exact CLI-accepted
// aliases such as `opus[1m]`, `opusplan`, `best`, and gateway-specific model ids.
func fetchClaudeDefaultModel() (string, error) {
	if model := strings.TrimSpace(os.Getenv("ANTHROPIC_MODEL")); model != "" {
		return model, nil
	}
	dir := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR"))
	if dir == "" {
		if home := userHome(); home != "" {
			dir = filepath.Join(home, ".claude")
		}
	}
	if dir == "" {
		return "", nil
	}
	b, err := os.ReadFile(filepath.Join(dir, "settings.json"))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var settings struct {
		Model string            `json:"model"`
		Env   map[string]string `json:"env"`
	}
	if err := json.Unmarshal(b, &settings); err != nil {
		return "", err
	}
	if model := strings.TrimSpace(settings.Env["ANTHROPIC_MODEL"]); model != "" {
		return model, nil
	}
	return strings.TrimSpace(settings.Model), nil
}

// claudeModelID derives the api model id from a friendly name, matching Anthropic's id scheme:
// "Opus 5" -> "claude-opus-5", "Haiku 4.5" -> "claude-haiku-4-5", "Sonnet 5" -> "claude-sonnet-5".
func claudeModelID(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	s = strings.ReplaceAll(s, ".", "-")
	s = strings.Join(strings.Fields(s), "-") // collapse whitespace to single dashes
	return "claude-" + s
}
