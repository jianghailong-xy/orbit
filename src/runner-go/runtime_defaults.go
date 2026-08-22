package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

type runtimeDefaultProbeResult struct {
	runtime string
	model   string
	err     error
}

// probeRuntimeDefaultModels returns one tri-state result per built-in runtime: a model updates the
// snapshot, an empty model explicitly removes that runtime, and an error preserves its old value.
// A missing CLI is a successful empty result because this runner can no longer execute it.
func probeRuntimeDefaultModels() []runtimeDefaultProbeResult {
	probe := func(runtime string, available bool, fetch func() (string, error)) runtimeDefaultProbeResult {
		if !available {
			return runtimeDefaultProbeResult{runtime: runtime}
		}
		model, err := fetch()
		return runtimeDefaultProbeResult{runtime: runtime, model: model, err: err}
	}
	return []runtimeDefaultProbeResult{
		probe(providerClaude, claudeCLIAvailable(), fetchClaudeDefaultModel),
		probe(providerCodex, codexCLIAvailable(), fetchCodexDefaultModel),
		probe(providerKimi, kimiCLIAvailable(), fetchKimiDefaultModel),
		probe(providerDSH, dshCLIAvailable(), fetchDSHDefaultModel),
	}
}

// mergeRuntimeDefaultModels publishes no first snapshot until every runtime probe has a reliable
// answer. That keeps heartbeat JSON at null across a runner restart with a transient read failure,
// preserving the control plane's last-good snapshot. Once initialized, one failed runtime retains
// only its own old value while successful peers continue to update or clear theirs.
func mergeRuntimeDefaultModels(
	previous map[string]string,
	results []runtimeDefaultProbeResult,
) map[string]string {
	if previous == nil {
		for _, result := range results {
			if result.err != nil {
				return nil
			}
		}
	}
	next := make(map[string]string, len(previous))
	for runtime, model := range previous {
		next[runtime] = model
	}
	for _, result := range results {
		if result.err != nil {
			continue
		}
		model := strings.TrimSpace(result.model)
		if model == "" {
			delete(next, result.runtime)
		} else {
			next[result.runtime] = model
		}
	}
	return next
}

// fetchCodexDefaultModel reads the same base config Codex uses when Orbit launches it without a
// profile. `codex debug models` reports the catalog but not the configured default.
func fetchCodexDefaultModel() (string, error) {
	home := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if home == "" {
		if user := userHome(); user != "" {
			home = filepath.Join(user, ".codex")
		}
	}
	if home == "" {
		return "", nil
	}
	return readTopLevelTOMLString(filepath.Join(home, "config.toml"), "model")
}

// fetchKimiDefaultModel reads the current Kimi Code runtime's native default. KIMI_CODE_HOME is
// its supported data-root override; the current TypeScript runtime stores ordinary user data in
// ~/.kimi-code (the retired Python kimi-cli used KIMI_SHARE_DIR and ~/.kimi instead).
func fetchKimiDefaultModel() (string, error) {
	if kimiUsesEnvModel(nil) {
		return envValueWithAgentOverride(nil, "KIMI_MODEL_NAME"), nil
	}
	home := strings.TrimSpace(os.Getenv("KIMI_CODE_HOME"))
	if home == "" {
		if user := userHome(); user != "" {
			home = filepath.Join(user, ".kimi-code")
		}
	}
	if home == "" {
		return "", nil
	}
	return readTopLevelTOMLString(filepath.Join(home, "config.toml"), "default_model")
}

func kimiCLIAvailable() bool {
	_, err := exec.LookPath(providerKimi)
	return err == nil
}

// envValueWithAgentOverride mirrors envWithAgent: an Agent entry, including an explicit empty
// value, shadows the runner process environment; an absent entry inherits the process value.
func envValueWithAgentOverride(agentEnv map[string]string, key string) string {
	if value, ok := agentEnv[key]; ok {
		return strings.TrimSpace(value)
	}
	return strings.TrimSpace(os.Getenv(key))
}

// readTopLevelTOMLString intentionally accepts only a top-level TOML string assignment. Both
// runtime keys are simple scalars; stopping at the first table prevents a nested provider/model
// field from being mistaken for the global default. Missing files/keys mean "runtime did not
// report a default", while malformed matching values are surfaced for diagnostics.
func readTopLevelTOMLString(path, key string) (string, error) {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(strings.TrimPrefix(scanner.Text(), "\ufeff"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") {
			break
		}
		left, right, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(left) != key {
			continue
		}
		value, err := parseTOMLString(strings.TrimSpace(right))
		if err != nil {
			return "", fmt.Errorf("%s %s: %w", path, key, err)
		}
		return strings.TrimSpace(value), nil
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	return "", nil
}

func parseTOMLString(raw string) (string, error) {
	if raw == "" {
		return "", fmt.Errorf("empty value")
	}
	switch raw[0] {
	case '"':
		end := 1
		escaped := false
		for end < len(raw) {
			c := raw[end]
			if c == '"' && !escaped {
				break
			}
			if c == '\\' && !escaped {
				escaped = true
			} else {
				escaped = false
			}
			end++
		}
		if end >= len(raw) {
			return "", fmt.Errorf("unterminated basic string")
		}
		if tail := strings.TrimSpace(raw[end+1:]); tail != "" && !strings.HasPrefix(tail, "#") {
			return "", fmt.Errorf("unexpected content after string")
		}
		return strconv.Unquote(raw[:end+1])
	case '\'':
		end := strings.IndexByte(raw[1:], '\'')
		if end < 0 {
			return "", fmt.Errorf("unterminated literal string")
		}
		end++
		if tail := strings.TrimSpace(raw[end+1:]); tail != "" && !strings.HasPrefix(tail, "#") {
			return "", fmt.Errorf("unexpected content after string")
		}
		return raw[1:end], nil
	default:
		return "", fmt.Errorf("value is not a TOML string")
	}
}
