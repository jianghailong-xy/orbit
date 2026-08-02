package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

type openCodeModelMetadata struct {
	ID         string `json:"id"`
	ProviderID string `json:"providerID"`
	Name       string `json:"name"`
	Limit      struct {
		Context int `json:"context"`
	} `json:"limit"`
	Variants map[string]json.RawMessage `json:"variants"`
}

func openCodeCLIAvailable() bool {
	_, err := exec.LookPath(providerOpenCode)
	return err == nil
}

func fetchOpenCodeModelCatalog(ctx context.Context, dir string) ([]ModelInfo, error) {
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	// Model discovery is metadata-only; never execute project/global plugins while
	// probing a runner heartbeat catalog.
	cmd := exec.CommandContext(cctx, providerOpenCode, "--pure", "models", "--verbose")
	cmd.Env = replaceEnv(os.Environ(), map[string]string{
		"OPENCODE_DISABLE_AUTOUPDATE":     "1",
		"OPENCODE_DISABLE_PROJECT_CONFIG": "1",
	})
	if strings.TrimSpace(dir) != "" {
		cmd.Dir = expandTilde(dir)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("opencode models --verbose: %w", err)
	}
	return parseOpenCodeModelCatalog(out)
}

// OpenCode merges project config by walking up from the current directory. A runner heartbeat has
// no agent scope, so discover only globally configured models from a stable directory beneath the
// runner's private machine home. Never use the shared OS temp directory: another local account
// could plant an ancestor opencode.json there.
func fetchGlobalOpenCodeModelCatalog(ctx context.Context) ([]ModelInfo, error) {
	dir, err := openCodeGlobalCatalogDir()
	if err != nil {
		return nil, err
	}
	return fetchOpenCodeModelCatalog(ctx, dir)
}

func openCodeGlobalCatalogDir() (string, error) {
	home := machineHome()
	if runtime.GOOS != "windows" {
		info, err := os.Lstat(home)
		if err != nil {
			return "", fmt.Errorf("inspect runner home for OpenCode catalog: %w", err)
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
			return "", fmt.Errorf("runner home %s is not a private directory", home)
		}
	}
	dir := filepath.Join(home, "opencode-model-catalog")
	if err := os.Mkdir(dir, 0o700); err != nil && !os.IsExist(err) {
		return "", fmt.Errorf("create private OpenCode model directory: %w", err)
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return "", fmt.Errorf("inspect private OpenCode model directory: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", fmt.Errorf("OpenCode model directory %s is not a private directory", dir)
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(dir, 0o700); err != nil {
			return "", fmt.Errorf("secure private OpenCode model directory: %w", err)
		}
	}
	return dir, nil
}

// parseOpenCodeModelCatalog parses the CLI's repeated pair format:
//
//	provider/model
//	{ ...pretty-printed model metadata... }
//
// json.Decoder.InputOffset lets this stay correct when metadata is multiline or
// contains braces inside strings. Unknown diagnostic lines are ignored.
func parseOpenCodeModelCatalog(out []byte) ([]ModelInfo, error) {
	var models []ModelInfo
	var pendingID string
	for offset := 0; offset < len(out); {
		for offset < len(out) && (out[offset] == ' ' || out[offset] == '\t' || out[offset] == '\r' || out[offset] == '\n') {
			offset++
		}
		if offset >= len(out) {
			break
		}
		if out[offset] != '{' {
			end := bytes.IndexByte(out[offset:], '\n')
			if end < 0 {
				end = len(out) - offset
			}
			line := strings.TrimSpace(string(out[offset : offset+end]))
			offset += end
			if offset < len(out) && out[offset] == '\n' {
				offset++
			}
			provider, model, hasSlash := strings.Cut(line, "/")
			if hasSlash && provider != "" && model != "" && !strings.Contains(provider, ":") && !strings.ContainsAny(line, " \t") {
				pendingID = line
			}
			continue
		}

		decoder := json.NewDecoder(bytes.NewReader(out[offset:]))
		var metadata openCodeModelMetadata
		if err := decoder.Decode(&metadata); err != nil {
			return nil, fmt.Errorf("decode metadata for %q: %w", pendingID, err)
		}
		offset += int(decoder.InputOffset())
		if pendingID == "" {
			continue
		}
		provider, _, _ := strings.Cut(pendingID, "/")
		label := strings.TrimSpace(metadata.Name)
		if label == "" {
			_, label, _ = strings.Cut(pendingID, "/")
		}
		if provider != "" {
			label = provider + " · " + label
		}
		priority := len(models)
		models = append(models, ModelInfo{
			Value:           pendingID,
			Label:           label,
			Priority:        &priority,
			ContextWindow:   metadata.Limit.Context,
			ReasoningLevels: sortedOpenCodeVariants(metadata.Variants),
		})
		pendingID = ""
	}
	if len(models) == 0 {
		return nil, fmt.Errorf("opencode models --verbose returned no models")
	}
	return models, nil
}

func sortedOpenCodeVariants(variants map[string]json.RawMessage) []string {
	if len(variants) == 0 {
		return nil
	}
	order := map[string]int{
		"none": 0, "minimal": 1, "low": 2, "medium": 3,
		"high": 4, "xhigh": 5, "max": 6,
	}
	levels := make([]string, 0, len(variants))
	for level, raw := range variants {
		var config struct {
			Disabled bool `json:"disabled"`
		}
		if json.Unmarshal(raw, &config) == nil && config.Disabled {
			continue
		}
		if level = strings.TrimSpace(level); level != "" {
			levels = append(levels, level)
		}
	}
	sort.SliceStable(levels, func(i, j int) bool {
		pi, iok := order[levels[i]]
		pj, jok := order[levels[j]]
		if iok != jok {
			return iok
		}
		if iok && pi != pj {
			return pi < pj
		}
		return levels[i] < levels[j]
	})
	return levels
}
