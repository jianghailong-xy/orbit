package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// One model alias from `kimi provider list --json`. The CLI resolves its own config
// (managed OAuth models plus any locally imported provider) into this shape, which is
// where the per-model thinking vocabulary lives: K2.7 Coding declares no efforts and
// accepts only the model default, while K3 declares low/high/max.
type kimiModelEntry struct {
	MaxContextSize int      `json:"maxContextSize"`
	DisplayName    string   `json:"displayName"`
	SupportEfforts []string `json:"supportEfforts"`
	DefaultEffort  string   `json:"defaultEffort"`
}

// Kimi's ACP handshake also describes the model and thinking pickers, but reading them
// there costs a `session/new` per model — each one lands in the user's own Kimi session
// list. `kimi provider list --json` is config-only: no session, no login, no LLM call.
func fetchKimiModelCatalog(ctx context.Context) ([]ModelInfo, error) {
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	// Output(), not CombinedOutput(): the payload carries every configured provider's
	// api_key, so keep the CLI's stderr out of the error this heartbeat logs.
	out, err := exec.CommandContext(cctx, providerKimi, "provider", "list", "--json").Output()
	if err != nil {
		return nil, fmt.Errorf("kimi provider list --json: %w", err)
	}
	return parseKimiModelCatalog(out)
}

func parseKimiModelCatalog(out []byte) ([]ModelInfo, error) {
	start := bytes.IndexByte(out, '{')
	if start < 0 {
		return nil, fmt.Errorf("kimi provider list --json returned no JSON object")
	}
	var raw struct {
		Models json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(out[start:], &raw); err != nil {
		return nil, err
	}
	models, err := decodeKimiModels(raw.Models)
	if err != nil {
		return nil, err
	}
	if len(models) == 0 {
		return nil, fmt.Errorf("kimi provider list --json reported no models")
	}
	return models, nil
}

// Kimi keys its models by alias, and that object's order is the CLI's own picker order
// (the managed default first). Decode it token by token to preserve it; a Go map would not.
func decodeKimiModels(raw json.RawMessage) ([]ModelInfo, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	if delim, ok := token.(json.Delim); !ok || delim != '{' {
		return nil, fmt.Errorf("kimi model catalog is not a JSON object")
	}
	var models []ModelInfo
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		id, _ := key.(string)
		var entry kimiModelEntry
		if err := decoder.Decode(&entry); err != nil {
			return nil, fmt.Errorf("decode kimi model %q: %w", id, err)
		}
		if strings.TrimSpace(id) == "" {
			continue
		}
		label := strings.TrimSpace(entry.DisplayName)
		if label == "" {
			label = id
		}
		var levels []string
		for _, level := range entry.SupportEfforts {
			if level = strings.TrimSpace(level); level != "" {
				levels = append(levels, level)
			}
		}
		models = append(models, ModelInfo{
			Value:                 id,
			Label:                 label,
			ContextWindow:         entry.MaxContextSize,
			ReasoningLevels:       levels,
			DefaultReasoningLevel: strings.TrimSpace(entry.DefaultEffort),
		})
	}
	return models, nil
}
