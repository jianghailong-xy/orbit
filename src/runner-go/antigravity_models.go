package main

// The Antigravity CLI's (`agy`) model catalog, and the flags a session's model and effort become.
//
// agy keeps its model list inside the binary. `agy models` prints it as TSV (`slug\tlabel`), offline,
// and never asks the Gemini API for its list, so new models arrive with new agy releases
// (docs/antigravity-runtime-contract.md §9). The thinking level is part of the slug —
// `gemini-3.8-flash-high` — so the catalog reports each base model once, with its levels as
// reasoningLevels, which is how the pickers already show an effort beside a model. A session then
// runs `--model <base> --effort <level>`.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// agyExecutable is the binary the antigravity engine runs. Unlike every other engine it is not
// named after its provider slug (engineSpec.exe).
const agyExecutable = "agy"

// antigravityDefaultModel is the model agy runs when it is given no --model: "Gemini 3.1 Pro (Low)"
// in 1.2.15 and 1.2.16 (contract §9.2). Used only to read a context window for a session that
// picked no model; the model itself is left to agy.
const antigravityDefaultModel = "gemini-3.1-pro"

// antigravityEffortRank orders the thinking levels agy names, lowest first. The first three are the
// ones `agy models` encodes in its slugs; 1.2.16's `--effort` also accepts the last two.
var antigravityEffortRank = map[string]int{"low": 1, "medium": 2, "high": 3, "xhigh": 4, "max": 5}

// antigravityContextWindows is the denominator of the context gauge for agy's models, which agy
// itself never reports (contract §9.3). Every model agy 1.2.15/1.2.16 lists is a Gemini long-context
// model, whose input limit is 1,048,576 tokens. To be checked against the API's `inputTokenLimit`
// once a real key is available (contract §11, item 5). A model missing here reads as "no reading"
// (0), never as a guess.
var antigravityContextWindows = map[string]int{
	"gemini-3.8-flash": 1_048_576,
	"gemini-3.7-flash": 1_048_576,
	"gemini-3.6-flash": 1_048_576,
	"gemini-3.1-pro":   1_048_576,
}

func antigravityCLIAvailable() bool {
	_, err := exec.LookPath(agyExecutable)
	return err == nil
}

// splitAntigravityModelSlug splits a slug at its trailing thinking level:
// "gemini-3.8-flash-high" -> ("gemini-3.8-flash", "high"). A name with no level comes back whole.
func splitAntigravityModelSlug(slug string) (base, level string) {
	slug = strings.TrimSpace(slug)
	i := strings.LastIndexByte(slug, '-')
	if i <= 0 {
		return slug, ""
	}
	if _, ok := antigravityEffortRank[strings.ToLower(slug[i+1:])]; !ok {
		return slug, ""
	}
	return slug[:i], strings.ToLower(slug[i+1:])
}

// antigravityContextWindow is the window for a model, by its base name or full slug; "" is agy's
// own default model.
func antigravityContextWindow(model string) int {
	base, _ := splitAntigravityModelSlug(model)
	if base == "" {
		base = antigravityDefaultModel
	}
	return antigravityContextWindows[base]
}

// parseAntigravityModels reads `agy models`: one `slug\tlabel` per line, in agy's own order, which
// the catalog keeps. Lines that are not a slug and a label ("Fetching available models..." goes to
// stderr, but a wrapper may fold it in) are skipped.
func parseAntigravityModels(out []byte) []ModelInfo {
	var models []ModelInfo
	index := map[string]int{}
	for _, line := range strings.Split(string(out), "\n") {
		slug, label, ok := strings.Cut(strings.TrimRight(line, "\r"), "\t")
		slug, label = strings.TrimSpace(slug), strings.TrimSpace(label)
		if !ok || slug == "" || strings.ContainsAny(slug, " \t") {
			continue
		}
		base, level := splitAntigravityModelSlug(slug)
		i, seen := index[base]
		if !seen {
			i = len(models)
			index[base] = i
			models = append(models, ModelInfo{
				Value:         base,
				Label:         antigravityBaseLabel(label, base),
				ContextWindow: antigravityContextWindow(base),
			})
		}
		if level != "" && !contains(models[i].ReasoningLevels, level) {
			models[i].ReasoningLevels = append(models[i].ReasoningLevels, level)
		}
	}
	for i := range models {
		sortAntigravityLevels(models[i].ReasoningLevels)
		models[i].DefaultReasoningLevel = antigravityDefaultLevel(models[i].ReasoningLevels)
	}
	return models
}

// antigravityBaseLabel drops the level agy appends to each label: "Gemini 3.8 Flash (High)" ->
// "Gemini 3.8 Flash".
func antigravityBaseLabel(label, base string) string {
	if open := strings.LastIndex(label, " ("); open > 0 && strings.HasSuffix(label, ")") {
		if _, ok := antigravityEffortRank[strings.ToLower(label[open+2:len(label)-1])]; ok {
			return strings.TrimSpace(label[:open])
		}
	}
	if label == "" {
		return base
	}
	return label
}

func sortAntigravityLevels(levels []string) {
	for i := 1; i < len(levels); i++ {
		for j := i; j > 0 && antigravityEffortRank[levels[j]] < antigravityEffortRank[levels[j-1]]; j-- {
			levels[j], levels[j-1] = levels[j-1], levels[j]
		}
	}
}

// antigravityDefaultLevel is the level a session that names a model but no effort runs at. agy
// refuses a base model without --effort, so there has to be one. "high" is a dynamic thinking
// budget (thinkingBudget -1), which is what the Gemini API itself does when it is told nothing;
// a model without it gets its highest.
func antigravityDefaultLevel(levels []string) string {
	if contains(levels, "high") {
		return "high"
	}
	if len(levels) == 0 {
		return ""
	}
	return levels[len(levels)-1]
}

// antigravityModelArgs is the --model/--effort a session's model and effort become (contract §9.2).
// No model leaves the choice to agy, effort included: that is how the pickers show it. A model this
// runner's catalog lists gets a level it supports — the session's own when the model has it, else
// the model's default — because agy refuses to start on one it does not. A model the catalog does
// not know (no refresh yet, or one a newer agy added) is passed as given, for agy to answer.
func antigravityModelArgs(model, effort string, catalog []ModelInfo) []string {
	model = strings.TrimSpace(model)
	effort = strings.ToLower(strings.TrimSpace(effort))
	if model == "" {
		return nil
	}
	base, level := splitAntigravityModelSlug(model)
	if effort == "" {
		effort = level
	}
	for _, m := range catalog {
		if m.Value != base {
			continue
		}
		if len(m.ReasoningLevels) == 0 {
			return []string{"--model", base}
		}
		if !contains(m.ReasoningLevels, effort) {
			effort = firstNonEmpty(m.DefaultReasoningLevel, antigravityDefaultLevel(m.ReasoningLevels))
		}
		return []string{"--model", base, "--effort", effort}
	}
	if effort == "" || (level != "" && effort == level) {
		return []string{"--model", model}
	}
	return []string{"--model", base, "--effort", effort}
}

// antigravityCatalogModels is the antigravity half of the catalog this runner last published.
func antigravityCatalogModels() []ModelInfo {
	modelWindowMu.RLock()
	defer modelWindowMu.RUnlock()
	if modelWindows == nil {
		return nil
	}
	return modelWindows.Antigravity
}

// antigravityModelCatalogPlaceholderKey satisfies agy's check that a key is set at all. `agy models`
// lists the models built into the binary and sends nothing to the Gemini API, so the catalog needs
// no real key — and a runner has none of its own anyway: keys arrive per session, with a provider.
const antigravityModelCatalogPlaceholderKey = "orbit-model-catalog"

// fetchAntigravityModelCatalog runs `agy models`. On a runner that keeps a Google sign-in it is the
// account's list (contract §16.7), which adds the Claude and GPT-OSS models a sign-in brings to
// Gemini's; when the sign-in cannot give one — refused, or no network — the API-key list stands in,
// which every Gemini provider's sessions still run on.
func fetchAntigravityModelCatalog(ctx context.Context) ([]ModelInfo, error) {
	if antigravityGoogleSignInSaved() {
		models, err := fetchAntigravityGoogleModelCatalog(ctx)
		if err == nil {
			return models, nil
		}
		logln("antigravity: the Google account's model list is unavailable, so the API-key list is reported:", err)
	}
	return fetchAntigravityAPIModelCatalog(ctx)
}

// fetchAntigravityGoogleModelCatalog is `agy models` on the runner's Google sign-in, through the entry
// its login and status probe use (antigravityGoogleCommand).
func fetchAntigravityGoogleModelCatalog(ctx context.Context) ([]ModelInfo, error) {
	cctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	cmd, cleanup, err := antigravityGoogleCommand(cctx, agyExecutable, nil, false, "models")
	if err != nil {
		return nil, err
	}
	defer cleanup()
	// A real pipe: on /dev/null agy waits for a person to sign in instead of answering (§16.5).
	cmd.Stdin = strings.NewReader("")
	out, err := cmd.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && len(exitErr.Stderr) > 0 {
			return nil, fmt.Errorf("agy models: %w: %s", err, lastLine(string(exitErr.Stderr)))
		}
		return nil, fmt.Errorf("agy models: %w", err)
	}
	models := parseAntigravityModels(out)
	if len(models) == 0 {
		return nil, fmt.Errorf("agy models listed no models")
	}
	return models, nil
}

// fetchAntigravityAPIModelCatalog runs `agy models` in a runner-owned Gemini directory, never the
// user's ~/.gemini: the directory needs `modelProvider: gemini`, or agy asks for a Google sign-in
// instead of listing anything.
func fetchAntigravityAPIModelCatalog(ctx context.Context) ([]ModelInfo, error) {
	geminiDir, err := prepareAntigravityCatalogDir()
	if err != nil {
		return nil, fmt.Errorf("prepare the agy catalog directory: %w", err)
	}
	cctx, cancel := context.WithTimeout(ctx, time.Minute) // a cold first run of the 200MB binary takes ~12s
	defer cancel()
	cmd := exec.CommandContext(cctx, agyExecutable, "--gemini_dir="+geminiDir, "models")
	cmd.Env = os.Environ()
	if strings.TrimSpace(envValue(cmd.Env, "GEMINI_API_KEY")) == "" {
		cmd.Env = envWithValue(cmd.Env, "GEMINI_API_KEY", antigravityModelCatalogPlaceholderKey)
	}
	cmd.Env = envWithValue(cmd.Env, "AGY_CLI_DISABLE_AUTO_UPDATE", "true")
	cmd.Stdin = nil
	cmd.WaitDelay = 5 * time.Second
	// Output(), not CombinedOutput(): stderr carries "Fetching available models...".
	out, err := cmd.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && len(exitErr.Stderr) > 0 {
			return nil, fmt.Errorf("agy models: %w: %s", err, lastLine(string(exitErr.Stderr)))
		}
		return nil, fmt.Errorf("agy models: %w", err)
	}
	models := parseAntigravityModels(out)
	if len(models) == 0 {
		return nil, fmt.Errorf("agy models listed no models")
	}
	return models, nil
}

// prepareAntigravityCatalogDir is the Gemini directory `agy models` runs in: runner-wide, under the
// runner's own home, holding nothing but the settings that select API-key mode.
func prepareAntigravityCatalogDir() (string, error) {
	dir, err := filepath.Abs(filepath.Join(machineHome(), "antigravity", "catalog"))
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Join(dir, "antigravity-cli"), machineHomePerm); err != nil {
		return "", err
	}
	body, err := json.MarshalIndent(map[string]interface{}{
		"modelProvider":   "gemini",
		"enableTelemetry": false,
	}, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, "antigravity-cli", "settings.json"), append(body, '\n'), 0o600); err != nil {
		return "", err
	}
	linkAntigravitySharedBin(dir)
	return dir, nil
}
