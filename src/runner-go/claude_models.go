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
	// One settings file for the whole round: the fast-lane probe needs it and it says the same
	// thing for every model. "" when it could not be written, which leaves both capabilities
	// unknown rather than reporting a fast-less answer the probe could not actually make.
	probeDir, err := os.MkdirTemp("", "orbit-claude-probe")
	settings := ""
	if err == nil {
		defer os.RemoveAll(probeDir)
		settings, _ = writeClaudeCapabilityProbeSettings(probeDir)
	}
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
		caps := fetchClaudeModelCapabilities(ctx, id, settings)
		models = append(models, ModelInfo{
			Value:           id,
			Label:           name,
			Priority:        &priority,
			ContextWindow:   fetchClaudeContextWindow(ctx, id),
			PermissionModes: caps.permissionModes,
			FastMode:        caps.fastMode,
		})
	}
	return models, nil
}

// claudeModelCapabilities is what the CLI says about the two things that are per-model rather than
// per-runtime. Both are pointers/nil-able on purpose: "this runner could not say" has to stay
// distinguishable from "no", because the clients fall back to their static table on the first and
// must not on the second.
type claudeModelCapabilities struct {
	permissionModes []string
	fastMode        *bool
}

// fetchClaudeModelCapabilities asks the runner's own CLI which permission modes and fast lane this
// model has, for the same reason the model list and the context window are probed rather than
// tabulated: the answer belongs to the CLI that runs the model, so a table in the repo goes stale a
// release before anyone notices — which is exactly what happened when Opus 5.5 shipped and every
// client kept offering it Default-only, no fast lane, without an error anywhere.
//
// One spawn answers both, which is why it asks `/fast`:
//
//   - `--permission-mode auto` is never refused. A model without Auto simply starts in `default`,
//     and the init frame reports the mode the CLI SETTLED on — so the frame we get for free at the
//     start of any stream-json run is the answer.
//   - `/fast` is refused out loud ("Fast mode unavailable: …") on a model with no fast lane and
//     accepted ("Fast mode ON/OFF (this session only)") on one that has it. It needs the FLAG
//     settings layer to be asking for the lane at all, or every model answers "not available in
//     the Agent SDK" — hence the settings file.
//
// The fast answer is this CLI's, for this account, which is the right scope precisely because it
// is the CLI and account that will run the session: the refusal it gives a model outside the lane
// names the account's own reason ("Fast mode requires usage credits" on the runner this was
// measured on), and reporting no lane where the CLI would refuse one beats drawing a control whose
// only possible outcome is being turned down. Measured on 2.1.280: Opus 5.5, Opus 5 and Opus 4.8
// are accepted; Fable 5.1, Sonnet 5 and Haiku 4.5 are refused.
//
// Everything is best effort: a failed spawn, an older CLI that has no `/fast`, changed wording —
// all leave the field nil, and nil keeps the clients on their fallback for that model.
func fetchClaudeModelCapabilities(ctx context.Context, model, settings string) claudeModelCapabilities {
	if settings == "" {
		return claudeModelCapabilities{}
	}
	cctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	out, err := exec.CommandContext(
		cctx,
		"claude",
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		"--no-session-persistence",
		"--setting-sources",
		"user",
		"--settings",
		settings,
		"--permission-mode",
		"auto",
		"--model",
		model,
		"/fast",
	).Output()
	if err != nil {
		return claudeModelCapabilities{}
	}
	return parseClaudeModelCapabilities(out)
}

// writeClaudeCapabilityProbeSettings writes the FLAG-layer settings the fast-lane probe needs.
// `/fast` is a settings key and not a flag, and a headless (SDK) session refuses it outright unless
// this layer asks for it — "Fast mode is not available in the Agent SDK", which every model answers
// identically and which therefore says nothing about the model. Same key the real sessions use
// (writeClaudeSettings), and a probe-private file, never the user's own settings.json.
func writeClaudeCapabilityProbeSettings(dir string) (string, error) {
	path := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(path, []byte(`{"fastMode":true}`), 0o644); err != nil {
		return "", err
	}
	return path, nil
}

// parseClaudeModelCapabilities reads the two answers out of one stream-json run: the init frame's
// settled permission mode, and `/fast`'s verdict in the result frame. Lines that are not JSON, and
// a run missing either frame, leave that half nil.
func parseClaudeModelCapabilities(out []byte) claudeModelCapabilities {
	caps := claudeModelCapabilities{}
	for _, line := range bytes.Split(out, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var frame struct {
			Type           string `json:"type"`
			Subtype        string `json:"subtype"`
			PermissionMode string `json:"permissionMode"`
			Result         string `json:"result"`
		}
		if json.Unmarshal(line, &frame) != nil {
			continue
		}
		if frame.Type == "system" && frame.Subtype == "init" && frame.PermissionMode != "" {
			caps.permissionModes = claudeModelPermissionModes(frame.PermissionMode == "auto")
		}
		if frame.Type == "result" {
			if fast, said := parseFastModeVerdict(frame.Result); said {
				caps.fastMode = &fast
			}
		}
	}
	return caps
}

// parseFastModeVerdict reads `/fast`'s answer. "Fast mode unavailable: …" is a no; the toggle
// having been accepted ("Fast mode ON/OFF (this session only)") is a yes. Anything else — a CLI
// with no `/fast`, wording that moved — returns said=false, which travels as "unknown".
func parseFastModeVerdict(result string) (fast, said bool) {
	s := strings.ToLower(strings.TrimSpace(result))
	if strings.HasPrefix(s, "fast mode unavailable") {
		return false, true
	}
	if strings.HasPrefix(s, "fast mode on") || strings.HasPrefix(s, "fast mode off") {
		return true, true
	}
	return false, false
}

// claudeModelPermissionModes is the list one model's catalog row carries. Auto is the only mode
// Claude Code gates per model — every other one starts on any model — so the probe settles that
// one and the rest ride along.
func claudeModelPermissionModes(auto bool) []string {
	modes := make([]string, 0, len(allPermissionModes))
	for _, mode := range allPermissionModes {
		if mode == "auto" && !auto {
			continue
		}
		modes = append(modes, mode)
	}
	return modes
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
// Newer CLIs wrap the name in backticks ("Set model to `Opus 5` …"), so strip those too.
func parseSetModelName(out []byte) string {
	m := setModelRe.FindSubmatch(bytes.TrimSpace(out))
	if m == nil {
		return ""
	}
	return strings.Trim(strings.TrimSpace(string(m[1])), "`")
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
